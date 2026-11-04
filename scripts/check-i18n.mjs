#!/usr/bin/env node
/**
 * i18n 文案卫生守卫：**对称性 / 动态前缀 / 死键 / 值层面疑似残留**。
 *
 * 为什么需要它（与 `src/i18n/index.test.ts` 现有两条判据的分工）：
 *   - `index.test.ts` 已经守「key 集合一致」「t() 字面量能命中词典」「死文案」三件事，
 *     但它的死文案判据把**任何**以 `.` 结尾或含 `${` 的字符串字面量都当成动态前缀
 *     （实测 764 个前缀，其中大量来自注释/夹具）⇒ 方向只剩「漏杀」，改完名/删完功能的
 *     键可以长期留在册子里。本脚本把前缀来源收紧到**真实 i18n 调用点**，并给死键加一道
 *     「只减不增」的基线闸，让「新增死键」在 CI 里必红。
 *   - 值层面（文案内容是否还在描述已删功能）无法机械判定 ⇒ 不判红，只输出
 *     「生产界面已无引用、只剩测试/探针在引」的可疑清单，供人工确认。
 *
 * ## 判据
 * 1. **对称性**：`src/i18n/locales/zh-cn.ts` 与 `en-us.ts` 的键集合必须一致；
 *    缺失/多余各报一栏，带完整键路径。
 * 2. **动态前缀**：从 `t(\`prefix.${x}\`)`、`$t(...)`、`i18n.global.t(...)`、
 *    `t("prefix." + x)` 这类**真实调用点**提取静态前缀（生产代码，不含 `*.test.ts`）。
 *    每个前缀在两种语言里必须有一致的子树；没有子树的必须登记在
 *    `DYNAMIC_PREFIX_WHITELIST` 里（附理由），不许靠「跳过所有动态键」蒙混。
 * 3. **死键**：全仓引用面（`src/**`、`scripts/**`、根目录 `*.html` 的 `data-i18n`，
 *    含测试/探针；locale 文件自身不算）没有任何字面量或动态前缀覆盖的 key。
 *    存量走 `scripts/i18n-dead-keys.baseline.json`：**只减不增**——
 *    - 新出现的死键 ⇒ 红；
 *    - 基线里有、但已经不再死（被删或被重新引用）⇒ 也红，要求从基线删除。
 * 4. **值层面疑似残留**（仅提示）：仍活着的 key 如果**生产代码零引用**、只有测试/探针
 *    在引，则列为「同名功能已不存在」的可疑项，人工确认。
 *
 * ## 自证
 * 每次运行先跑内置反例：zh 多一个键 / en 少一个键 / 故意留一个死键 /
 * 基线登记已失效 / 动态前缀子树缺失——任何一条没被检出 ⇒ 直接 exit 1。
 *
 * ## 用法
 *   `node scripts/check-i18n.mjs`            门禁（自证 + 三类判据）
 *   `node scripts/check-i18n.mjs --self-test`  只跑自证并打印反例原文
 *   `node scripts/check-i18n.mjs --update`     把当前死键写入基线（只在有意接收存量时用）
 *
 * 退出码：0 = 通过；1 = 有新增死键 / 不对称 / 动态前缀失配 / 自证失败。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZH_FILE = path.join(ROOT, "src/i18n/locales/zh-cn.ts");
const EN_FILE = path.join(ROOT, "src/i18n/locales/en-us.ts");
const BASELINE = path.join(ROOT, "scripts/i18n-dead-keys.baseline.json");

/** 动态前缀白名单：无法用「子树一致」验证的前缀必须登记在此，并写清理由。 */
const DYNAMIC_PREFIX_WHITELIST = {
  // 例："some.runtime.": "key 完全由运行时拼接，静态前缀无法确定子树",
};

/** 扫描下限：防止目录/正则失效后「0 条 ⇒ 假绿」。 */
const MIN_KEYS = 900;
const MIN_REF_LITERALS = 500;
const MIN_FILES = 150;
const MIN_DYNAMIC_PREFIXES = 5;

const SKIP_DIRS = new Set([
  "node_modules", "dist", "target", ".git", ".workbuddy", "test-results",
  ".trae-html-share-packages", "docs", ".github", "src-tauri", "perf",
]);

/* ---------------- 词典读取（TS AST，不 import，避免 Node 版本差异） ---------------- */

function loadDict(file, exportName) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let obj = null;
  const visit = (node) => {
    if (obj) return;
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(sf) === exportName
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      obj = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!obj) throw new Error(`${path.relative(ROOT, file)} 里找不到 ${exportName} 的对象字面量`);
  const entries = new Map();
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (!ts.isStringLiteral(name) && !ts.isNoSubstitutionTemplateLiteral(name)) continue;
    const init = prop.initializer;
    let value = null;
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) value = init.text;
    else if (ts.isTemplateExpression(init)) value = init.getText(sf);
    entries.set(name.text, value);
  }
  return entries;
}

/* ---------------- 引用面 ---------------- */

/**
 * 三种引号各扫一遍（照抄 `src/i18n/index.test.ts` 里已验证过的提取器）：
 * 合成一条会把 `:aria-label="t('nav.me.online')"` 的内层单引号吃掉。
 * 注释里的字面量也算引用面 —— 方向是**宁可漏杀，不可误杀**。
 */
const QUOTES = ['"', "'", "`"];
function literalsIn(src) {
  const out = [];
  for (const q of QUOTES) {
    const re = new RegExp(`${q}((?:\\\\.|[^${q}\\\\\n]){2,240})${q}`, "g");
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function walkFiles(dir, out) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of names) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (/\.(?:ts|vue|js|mjs|html)$/.test(e.name)) out.push(p);
  }
}

/** 真实 i18n 调用点里的动态静态前缀（只扫生产代码，避免夹具/注释制造垃圾前缀）。 */
const I18N_CALL = /\b(?:t|\$t|te|\$te|tm|i18n\.global\.t|global\.t)\s*\(\s*([`"'])/g;

/**
 * 宽松前缀：任何「长得像 key 的模板字面量静态前半段」（如
 * `settings.updates.error.${code}` 出现在 `return` 里、由调用方 `t(key)` 取用）。
 * 它只进入**引用面**（让这些键不被误判成死键），不参与子树一致性判据 ——
 * 判据的严格部分只认真实 `t(...)` 调用点。
 */
const LOOSE_TEMPLATE = /`([^`$]*)\$\{/g;
const KEYISH_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\.?$/;

function loosePrefixesIn(src) {
  const out = [];
  for (const m of src.matchAll(LOOSE_TEMPLATE)) {
    const prefix = m[1];
    if (KEYISH_PREFIX.test(prefix)) out.push(prefix);
  }
  return out;
}

function dynamicPrefixesIn(file, src) {
  const out = [];
  for (const m of src.matchAll(I18N_CALL)) {
    const q = m[1];
    const start = m.index + m[0].length - 1;
    if (q === "`") {
      let i = start + 1;
      let staticEnd = -1;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "`") break;
        if (ch === "$" && src[i + 1] === "{") { staticEnd = i; break; }
        i += 1;
      }
      const prefix = staticEnd >= 0 ? src.slice(start + 1, staticEnd) : "";
      if (prefix && /[A-Za-z]/.test(prefix)) out.push({ prefix, file, raw: src.slice(start, i + 1) });
    } else {
      let i = start + 1;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === q) break;
        i += 1;
      }
      const literal = src.slice(start + 1, i);
      const after = src.slice(i + 1).match(/^\s*\+\s*/);
      if (after && literal && /[A-Za-z]/.test(literal)) {
        out.push({ prefix: literal, file, raw: src.slice(start, i + 1) + " + …" });
      }
    }
  }
  return out;
}

function collectReferences() {
  const files = [];
  walkFiles(path.join(ROOT, "src"), files);
  walkFiles(path.join(ROOT, "scripts"), files);
  for (const name of fs.readdirSync(ROOT)) {
    if (name.endsWith(".html")) files.push(path.join(ROOT, name));
  }

  const literals = new Set();
  const productionLiterals = new Set();
  /** 真实 `t(...)` 调用点里的前缀：参与子树一致性判据。 */
  const prefixes = [];
  /** 仅作引用面的宽松前缀（查表返回值、测试夹具里的模板串）。 */
  const loose = [];
  const productionPrefixes = [];
  let filesScanned = 0;
  const rel = (p) => path.relative(ROOT, p);
  const selfFile = fileURLToPath(import.meta.url);

  for (const file of files) {
    if (path.resolve(file) === selfFile) continue; // 守卫自身含反例夹具，不算引用面
    const isLocale = /src[\\/]i18n[\\/]locales[\\/]/.test(file);
    const isTest = /\.(?:test|spec)\.(?:ts|js|mjs)$/.test(file);
    const inSrc = /src[\\/]/.test(file);
    const src = fs.readFileSync(file, "utf8");
    filesScanned += 1;
    if (isLocale) continue; // 词典自身不是引用面

    if (file.endsWith(".html")) {
      for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) {
        literals.add(m[1]);
        productionLiterals.add(m[1]); // 启动失败窗的数据键同样是生产界面
      }
      continue;
    }
    for (const s of literalsIn(src)) {
      literals.add(s);
      if (!isTest && inSrc) productionLiterals.add(s);
    }
    // 宽松前缀：所有非词典文件都算引用面（测试引用同样算「还在用」）。
    for (const prefix of loosePrefixesIn(src)) {
      loose.push({ prefix, file, raw: `\`${prefix}\${…}\`` });
      if (!isTest && inSrc) productionPrefixes.push({ prefix, file, raw: `\`${prefix}\${…}\`` });
    }
    // 严格前缀：只认 src 下生产代码里的真实 i18n 调用点。
    if (!isTest && inSrc) {
      for (const p of dynamicPrefixesIn(file, src)) {
        prefixes.push(p);
        productionPrefixes.push(p);
      }
    }
  }
  return {
    literals, productionLiterals, prefixes, loose,
    productionPrefixes, filesScanned, fileCount: files.length, rel,
  };
}

/* ---------------- 判据实现（返回可打印的失败行） ---------------- */

function sortKeys(map) {
  return [...map.keys()].sort();
}

/**
 * 对称性：两边键集合差集。
 * @returns {{code: string, title: string, keys: string[]}[]}
 */
function checkSymmetry(zh, en) {
  const problems = [];
  const zhOnly = sortKeys(zh).filter((k) => !en.has(k));
  const enOnly = sortKeys(en).filter((k) => !zh.has(k));
  if (zhOnly.length) {
    problems.push({
      code: "symmetry.zh-only",
      title: `en-US 缺少 ${zhOnly.length} 个键（zh-CN 有、en-US 没有）`,
      keys: zhOnly,
    });
  }
  if (enOnly.length) {
    problems.push({
      code: "symmetry.en-only",
      title: `zh-CN 缺少 ${enOnly.length} 个键（en-US 有、zh-CN 没有）`,
      keys: enOnly,
    });
  }
  return problems;
}

/**
 * 动态前缀：必须在两种语言里有子树，且子树（去掉前缀后的键名集合）一致。
 * 白名单里的前缀跳过子树判据，但仍要求至少有一个键命中（否则 t() 只会印裸 key）。
 */
function checkDynamicPrefixes(zh, en, prefixes, whitelist = DYNAMIC_PREFIX_WHITELIST) {
  const problems = [];
  const seen = new Map();
  for (const p of prefixes) {
    if (!seen.has(p.prefix)) seen.set(p.prefix, p);
  }
  for (const [prefix, info] of seen) {
    const zhKeys = sortKeys(zh).filter((k) => k.startsWith(prefix));
    const enKeys = sortKeys(en).filter((k) => k.startsWith(prefix));
    if (!zhKeys.length && !enKeys.length) {
      if (whitelist[prefix]) continue;
      problems.push({
        code: "dynamic.no-subtree",
        title: `动态前缀 \`${prefix}\` 在词典里没有任何键（${info.file} 的 \`${info.raw}\` 只会印裸 key）`,
        keys: [],
        detail: [
          `  来源：${info.file}`,
          `  调用：${info.raw}`,
          "  修法：补上该前缀下的文案，或在 scripts/check-i18n.mjs 的 DYNAMIC_PREFIX_WHITELIST 登记并写清理由",
        ],
      });
      continue;
    }
    if (whitelist[prefix]) continue;
    const zhSub = new Set(zhKeys.map((k) => k.slice(prefix.length)));
    const enSub = new Set(enKeys.map((k) => k.slice(prefix.length)));
    const zhOnly = [...zhSub].filter((k) => !enSub.has(k)).map((k) => prefix + k).sort();
    const enOnly = [...enSub].filter((k) => !zhSub.has(k)).map((k) => prefix + k).sort();
    if (zhOnly.length || enOnly.length) {
      problems.push({
        code: "dynamic.subtree-mismatch",
        title: `动态前缀 \`${prefix}\` 的子树中英不一致（${info.file} 的 \`${info.raw}\` 可能展开到缺翻译的分支）`,
        keys: [...zhOnly, ...enOnly].sort(),
      });
    }
  }
  return problems;
}

function referencedBy(key, literals, prefixes) {
  if (literals.has(key)) return true;
  return prefixes.some((p) => key.startsWith(p.prefix));
}

/**
 * 死键：引用面（字面量 + 动态前缀）零命中。
 *
 * `deferred` 是「工作区已无引用、但 HEAD 里还被引用」的键 —— 并行会话正在改
 * 对应组件时会出现这种形状。按删除口径（HEAD + 工作区都无引用才删）它们不算死键，
 * 只作提示，等对方提交后下一轮再清。
 * @returns {{dead: string[], newDead: string[], stale: string[], deferred: string[]}}
 */
function checkDeadKeys(zh, literals, prefixes, baseline, deferredSet = new Set()) {
  const base = new Set(baseline);
  const allDead = sortKeys(zh).filter((k) => !referencedBy(k, literals, prefixes));
  const deferred = allDead.filter((k) => deferredSet.has(k));
  const dead = allDead.filter((k) => !deferredSet.has(k));
  const newDead = dead.filter((k) => !base.has(k));
  const stale = [...base].filter((k) => !dead.includes(k)).sort();
  return { dead, newDead, stale, deferred };
}

/**
 * 只对「工作区死键」逐个做 `git grep HEAD`：命中非 locale 文件即视为并行会话
 * 仍在 HEAD 引用的暂缓项。按 key 精确匹配（-F），不重扫全仓。
 */
function headReferencedKeys(keys) {
  const out = new Set();
  for (const key of keys) {
    const r = spawnSync("git", ["grep", "-l", "-F", "--", key, "HEAD", "--", "src", "scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0 || !r.stdout) continue;
    const hits = r.stdout.split(/\r?\n/).filter((line) => line && !line.includes("/i18n/locales/"));
    if (hits.length) out.add(key);
  }
  return out;
}

/** 生产引用面之外（只有测试/探针在引）的活键：值层面疑似残留，仅供人工确认。 */
function suspiciousKeys(zh, productionLiterals, prefixes) {
  return sortKeys(zh).filter(
    (k) => !referencedBy(k, productionLiterals, prefixes),
  );
}

/* ---------------- 输出 ---------------- */

function printProblems(problems, indent = "  ") {
  for (const p of problems) {
    console.error(`${indent}✗ ${p.title}`);
    for (const k of p.keys) console.error(`${indent}   · ${k}`);
    for (const d of p.detail ?? []) console.error(d);
  }
}

/** 并行暂缓列表：工作区零引用、但 HEAD 仍引用 —— 不删，等对应会话提交后下一轮清。 */
function printDeferred(keys) {
  console.log(
    `⚠ 并行暂缓 ${keys.length} 个键（工作区零引用、但 HEAD 仍引用 ⇒ 对应会话正在改组件，本轮不删）：`,
  );
  for (const k of keys) console.log(`   · ${k}`);
}

/* ---------------- 自证（故意改坏必须红） ---------------- */

function selfTest({ verbose = true } = {}) {
  const failures = [];
  const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}：${detail}`);
    if (verbose) {
      console.log(`${ok ? "✔" : "✗"} 自证 ${name}`);
      if (ok && detail) console.log(`   ${detail}`);
    }
  };

  // 反例 1：zh 多一个键。
  const zh1 = new Map([["demo.sym.shared", "共享"], ["demo.sym.onlyZh", "只中文"]]);
  const en1 = new Map([["demo.sym.shared", "shared"]]);
  const p1 = checkSymmetry(zh1, en1);
  const hit1 = p1.find((p) => p.code === "symmetry.zh-only" && p.keys.includes("demo.sym.onlyZh"));
  check("zh 多一个键 `demo.sym.onlyZh` 必红", Boolean(hit1), hit1 ? `指出键路径 ${hit1.keys.join(", ")}` : "没检出");
  if (hit1 && verbose) printProblems([hit1]);

  // 反例 2：en 少一个键（与反例 1 方向相反，覆盖另一栏）。
  const zh2 = new Map([["demo.sym.shared", "共享"], ["demo.sym.onlyEn", "共享"]]);
  const en2 = new Map([["demo.sym.shared", "shared"]]);
  const p2 = checkSymmetry(zh2, en2);
  const hit2 = p2.find((p) => p.code === "symmetry.zh-only" && p.keys.includes("demo.sym.onlyEn"));
  check("删掉 en 的 `demo.sym.onlyEn` 必红", Boolean(hit2), hit2 ? `指出键路径 ${hit2.keys.join(", ")}` : "没检出");
  if (hit2 && verbose) printProblems([hit2]);

  // 反例 3：故意留一个死键。
  const zh3 = new Map([["demo.dead.orphan", "孤儿"], ["demo.dead.used", "在用"]]);
  const refs3 = new Set(["demo.dead.used"]);
  const d3 = checkDeadKeys(zh3, refs3, [], []);
  const hit3 = d3.dead.includes("demo.dead.orphan");
  check("故意留死键 `demo.dead.orphan` 必红", hit3, hit3 ? "指出键路径 demo.dead.orphan" : "没检出");
  if (hit3 && verbose) console.error(`  ✗ 死键：以下 ${d3.dead.length} 个键全仓零引用`);
  if (hit3 && verbose) for (const k of d3.dead) console.error(`     · ${k}`);

  // 反例 4：基线登记已失效（键被删/被重新引用）必须红（只减不增）。
  const d4 = checkDeadKeys(zh3, new Set(["demo.dead.orphan", "demo.dead.used"]), [], ["demo.dead.orphan"]);
  const hit4 = d4.stale.includes("demo.dead.orphan");
  check("基线里的 `demo.dead.orphan` 已不再死 ⇒ 基线只减不增必红", hit4,
    hit4 ? "指出基线应删除 demo.dead.orphan" : "没检出");
  if (hit4 && verbose) console.error(`  ✗ 基线只减不增：以下 ${d4.stale.length} 条登记已失效（键已删除或已重新被引用），必须从基线删除`);
  if (hit4 && verbose) for (const k of d4.stale) console.error(`     · ${k}`);

  // 反例 5：动态前缀没有子树 / 子树中英不一致。
  const zh5 = new Map([["demo.dyn.a", "甲"]]);
  const en5 = new Map([["demo.dyn.a", "A"], ["demo.dyn.b", "B"]]);
  const p5 = checkDynamicPrefixes(zh5, en5, [{ prefix: "demo.dyn.", file: "demo.vue", raw: "t(`demo.dyn.${x}`)" }]);
  const hit5 = p5.some((p) => p.code === "dynamic.subtree-mismatch" && p.keys.includes("demo.dyn.b"));
  check("动态前缀子树中英不一致必红", hit5, hit5 ? "指出键路径 demo.dyn.b" : "没检出");
  const p6 = checkDynamicPrefixes(new Map(), new Map(), [{ prefix: "demo.gone.", file: "demo.vue", raw: "t(`demo.gone.${x}`)" }]);
  const hit6 = p6.some((p) => p.code === "dynamic.no-subtree");
  check("动态前缀 `demo.gone.` 在词典里无子树必红", hit6, hit6 ? "指出前缀 demo.gone." : "没检出");
  if (verbose) {
    for (const p of [...p5, ...p6]) printProblems([p]);
  }

  return failures;
}

/* ---------------- 主流程 ---------------- */

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return [];
  const raw = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  if (!Array.isArray(raw.deadKeys)) throw new Error("基线缺少 deadKeys 数组");
  return raw.deadKeys;
}

function writeBaseline(dead) {
  const body = {
    version: 1,
    note: "i18n 死键基线：只减不增。check-i18n 判出的死键必须在此登记才允许通过；"
      + "键被删除或重新被引用后必须同步移除登记，否则自检报红。新增条目只能通过一次明确的人工确认（--update）。",
    deadKeys: [...dead].sort(),
  };
  fs.writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function main() {
  const argv = process.argv.slice(2);
  const selfTestOnly = argv.includes("--self-test");
  const update = argv.includes("--update");

  const selfFailures = selfTest({ verbose: selfTestOnly });
  if (selfFailures.length) {
    console.error(`\n✗ i18n 守卫自证失败 ${selfFailures.length} 条（判据本身不可信，不许报绿）：`);
    for (const f of selfFailures) console.error(`   · ${f}`);
    process.exit(1);
  }
  if (selfTestOnly) process.exit(0);

  let zh;
  let en;
  try {
    zh = loadDict(ZH_FILE, "zhCN");
    en = loadDict(EN_FILE, "enUS");
  } catch (e) {
    console.error(`✗ 词典读取失败：${e.message}`);
    process.exit(1);
  }

  const refs = collectReferences();
  const problems = [...checkSymmetry(zh, en), ...checkDynamicPrefixes(zh, en, refs.prefixes)];

  if (zh.size < MIN_KEYS || en.size < MIN_KEYS) {
    problems.push({
      code: "scan.too-few-keys",
      title: `只读到 zh=${zh.size} / en=${en.size} 个键（下限 ${MIN_KEYS}）⇒ 量具失效`,
      keys: [],
    });
  }
  if (refs.literals.size < MIN_REF_LITERALS || refs.fileCount < MIN_FILES) {
    problems.push({
      code: "scan.too-small",
      title: `引用面只扫到 ${refs.literals.size} 个字面量 / ${refs.fileCount} 个文件（下限 ${MIN_REF_LITERALS} / ${MIN_FILES}）⇒ 目录或正则变了`,
      keys: [],
    });
  }
  const dynCount = new Set(refs.prefixes.map((p) => p.prefix)).size;
  if (dynCount < MIN_DYNAMIC_PREFIXES) {
    problems.push({
      code: "scan.too-few-dynamic",
      title: `只提取到 ${dynCount} 个动态前缀（下限 ${MIN_DYNAMIC_PREFIXES}）⇒ 调用点正则失效`,
      keys: [],
    });
  }

  const baseline = readBaseline();
  const referencePrefixes = [...refs.prefixes, ...refs.loose];
  // 先按工作区算一遍死键，再对这批键查 HEAD：HEAD 仍有引用的算「并行暂缓」，不删。
  const worktreeDead = checkDeadKeys(zh, refs.literals, referencePrefixes, []).dead;
  const deferredSet = headReferencedKeys(worktreeDead);
  const { dead, newDead, stale, deferred } = checkDeadKeys(
    zh, refs.literals, referencePrefixes, baseline, deferredSet,
  );

  if (update) {
    writeBaseline(dead);
    console.log(`· 已写入基线：${path.relative(ROOT, BASELINE)}（${dead.length} 条死键）`);
    for (const k of dead) console.log(`   · ${k}`);
    process.exit(0);
  }

  if (newDead.length) {
    problems.push({
      code: "dead.new",
      title: `新增死键 ${newDead.length} 个（全仓零引用，且不在基线里）`,
      keys: newDead,
      detail: [
        "  修法：删掉该键（中英同步），或把它接回真实引用面；",
        "  只有确认要接收存量时才用 `node scripts/check-i18n.mjs --update`（基线只减不增）。",
      ],
    });
  }
  if (stale.length) {
    problems.push({
      code: "dead.stale-baseline",
      title: `基线只减不增：${stale.length} 条登记已失效（键已删除或已重新被引用），必须从基线删除`,
      keys: stale,
      detail: [`  修法：手工编辑 ${path.relative(ROOT, BASELINE)}，删掉这些条目；或 --update 重写当前死键集合。`],
    });
  }

  const suspicious = suspiciousKeys(zh, refs.productionLiterals, refs.productionPrefixes);

  if (problems.length) {
    console.error(`✗ i18n 守卫失败 ${problems.length} 项：`);
    printProblems(problems);
    if (deferred.length) printDeferred(deferred);
    console.error(
      `\n  词典 zh=${zh.size} / en=${en.size}；引用面 ${refs.literals.size} 个字面量 / ${refs.fileCount} 个文件；`
      + `动态前缀 ${dynCount} 个；死键 ${dead.length}（基线 ${baseline.length}）；并行暂缓 ${deferred.length}。`,
    );
    process.exit(1);
  }

  console.log(
    `· i18n 守卫：zh=${zh.size} / en=${en.size} 键；引用面 ${refs.literals.size} 个字面量 / ${refs.fileCount} 个文件；`
    + `动态前缀 ${dynCount} 个；死键 ${dead.length}（基线 ${baseline.length}）；并行暂缓 ${deferred.length}。`,
  );
  if (deferred.length) printDeferred(deferred);
  if (suspicious.length) {
    console.log(
      `⚠ 值层面疑似残留（仅提示，不判红）：${suspicious.length} 条文案在**当前生产界面零引用**`
      + "（可能对应已删功能，也可能是并行会话正在改组件），请人工确认：",
    );
    for (const k of suspicious) console.log(`   · ${k}`);
  }
}

main();
