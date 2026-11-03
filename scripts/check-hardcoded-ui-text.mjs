#!/usr/bin/env node
/**
 * 「用户可见面新增硬编码中文」守卫。
 *
 * ## 为什么要有它
 * 本仓已经能切中文 / 英文（`src/i18n`），但**存量**里仍散着一批写死的中文：
 * 消息摘要占位符（`[文件]` / `[图片]` / `[任务]` …）、启动失败窗的整页文案、
 * 模板里的 `：` 分隔符等。这些不影响运行，却让「切到英文」只完成了一半 ——
 * 用户切英文后，会话列表预览仍是中文，等于没切。
 *
 * 只清存量没用：**新写的代码会继续加新的**。仓库里此前没有任何东西在拦这件事
 * （`src/i18n/index.test.ts` 查的是「词典 ↔ 调用点」两个方向，只认 `t()` 的 key，
 * 对「根本没走 t() 的中文」完全无感）。本脚本就是那道闸。
 *
 * ## 判据
 * 扫「会渲染到屏幕上」的两类文件：
 *   1. `src/**\/*.vue` 的 `<template>` 区段（HTML 注释与 `//` 行注释先抹掉）；
 *   2. `src/**\/*.{ts,vue}` 里的**字符串字面量 / 模板字面量**（TS AST 取，不靠正则）。
 * 命中 CJK（汉字 + 全角标点）即算一条。
 *
 * **不算违规**（这些不进基线、也不判红）：
 *   - 注释（AST 天然不含；
 *   - `console.*(...)` / `reportFrontendError(...)` 的参数 —— 开发者日志，不上屏；
 *   - 正则字面量 —— 那是**匹配**别人的中文（如 Rust 侧错误码），不是显示；
 *   - 词典 `src/i18n/locales/**`（它本来就是中文的家）；
 *   - `src/data/**`、`src/utils/designGuards.ts`、`src/utils/tokenContrast.ts`、
 *     `src/utils/templateBranches.ts` —— 数据/开发夹具，不是界面；
 *   - `*.test.ts` / `*.spec.ts`；
 *   - 语言自指名 `简体中文` / `English`（国际惯例不自翻译，见
 *     `GeneralSection.vue` 的注释）。
 *
 * ## 存量走基线（关键，别改回去）
 * 一次把 130 多条存量全判红，结果只会是「先关掉这条守卫」。所以：
 *   - `scripts/hardcoded-ui-text.baseline.json` 记**每文件每文案的出现次数**；
 *   - 只有「当前次数 > 基线次数」才是**新增** ⇒ 红；
 *   - 基线里多出来的条目（文案被改了/删了）只**提示**，不判红 —— 否则改一句文案
 *     就得同步改基线，人会烦到直接加白名单。
 * 用**次数**而不是「在不在」是有意的：同一文件里再抄一条 `"[文件]"` 也算新增
 * （`messages.ts` 里那 16 条正是这么来的）。
 *
 * ## 自证（防止闸自己空转）
 * 内置 4 条反例 + 5 条正例，每次运行先跑；任何一条不对 ⇒ exit 1。
 * 另外要求「扫到的文件数 ≥ 150 且 CJK 条数 ≥ 40」，否则说明路径/解析前提变了 ⇒ 红。
 *
 * ## 用法
 *   `node scripts/check-hardcoded-ui-text.mjs`           判红/绿（门禁用这个）
 *   `node scripts/check-hardcoded-ui-text.mjs --update`  把当前存量写进基线（**只在有意改基线时用**）
 *
 * 退出码：0 = 通过；1 = 有新增硬编码中文或自证失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const BASELINE = path.join(ROOT, "scripts", "hardcoded-ui-text.baseline.json");

/** 汉字 + 全角标点。半角标点不算（`"a, b"` 不是中文文案）。 */
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 语言自指名：任何语言下都显示原样，不算硬编码。 */
const SELF_NAMES = new Set(["简体中文", "English"]);

/** 开发者日志函数：参数不上屏。 */
const DEV_LOG_CALLEES = new Set(["reportFrontendError"]);

/** 整文件跳过：数据/开发夹具（不是界面）。 */
const SKIP_FILES = new Set([
  "src/utils/designGuards.ts",
  "src/utils/tokenContrast.ts",
  "src/utils/templateBranches.ts",
]);

/** 整目录跳过。 */
const SKIP_DIRS = new Set(["src/i18n/locales", "src/data"]);

const rel = (p) => p.slice(ROOT.length + 1).split(path.sep).join("/");
const normalize = (s) => s.replace(/\s+/g, " ").trim();

// ---------------- 收集：TS 侧（字符串字面量 / 模板字面量） ----------------

function lineOf(src, pos) {
  return src.slice(0, pos).split("\n").length;
}

/** 该字面量是否处在「开发者日志」的实参位置。 */
function isDevLogArg(node) {
  let p = node.parent;
  for (let i = 0; i < 4 && p; i++) {
    if (ts.isCallExpression(p)) {
      const callee = p.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") {
        return true;
      }
      if (ts.isIdentifier(callee) && DEV_LOG_CALLEES.has(callee.text)) return true;
    }
    p = p.parent;
  }
  return false;
}

/** 返回 [{line, text}]：该源码里所有 CJK 字符串（已排除日志实参与正则）。 */
function stringsInTs(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = normalize(node.text);
      if (CJK.test(text) && !SELF_NAMES.has(text) && !isDevLogArg(node)) {
        out.push({ line: lineOf(src, node.getStart(sf)), text });
      }
    } else if (ts.isTemplateExpression(node)) {
      // 模板拼接：整段取（`\`[任务] ${title}\`` 的 CJK 在 head/中间字面量里）
      const text = normalize(node.getText(sf));
      if (CJK.test(text) && !isDevLogArg(node)) {
        out.push({ line: lineOf(src, node.getStart(sf)), text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------- 收集：Vue 模板侧 ----------------

/**
 * 把 `<template>` 区段拆成「文本块」与「属性值」，逐块判 CJK。
 *
 * 不用正则糊整段（会像第一版那样把多行 `<!-- -->` 里的中文注释算成界面文案），
 * 而是：① 先把 HTML 注释抹成等长空白（保留换行 ⇒ 行号不漂）；
 * ② 抠出 `="…"` 属性值（`:aria-label="…：…"` 这类模板绑定里确实有写死的中文）；
 * ③ 再把属性值、`{{ … }}`、`<标签>` 一起抹掉，**剩下的才是真正会显示成字面的文本**。
 */
function templateStrings(file, src) {
  const m = /^<template(\s[^>]*)?>/m.exec(src);
  if (!m) return [];
  const start = m.index + m[0].length;
  const tail = src.slice(start);
  const em = /^<\/template>/m.exec(tail);
  const end = start + (em ? em.index : tail.length);
  const body = src.slice(start, end);
  const baseLine = lineOf(src, start);

  // ① 注释抹平
  let t = body.replace(/<!--[\s\S]*?-->/g, (x) => x.replace(/[^\n]/g, " "));
  // ② 属性值
  const hits = [];
  const attrRe = /([:@\w.-]+)\s*=\s*"([^"]*)"/g;
  for (const am of t.matchAll(attrRe)) {
    // 属性值里可能是 JS 表达式，里面可以有 `// 中文注释` —— 注释不是文案，先抹掉
    const val = am[2].replace(/\/\/[^\n]*/g, (x) => x.replace(/[^\n]/g, " "));
    if (!CJK.test(val)) continue;
    if (SELF_NAMES.has(normalize(val))) continue;
    hits.push({ line: baseLine + lineOf(t, am.index), text: normalize(val) });
  }
  t = t.replace(attrRe, (x) => x.replace(/[^\n]/g, " "));
  // ③ {{ … }} 与标签
  t = t.replace(/\{\{[\s\S]*?\}\}/g, (x) => x.replace(/[^\n]/g, " "));
  t = t.replace(/<\/?[A-Za-z][^>]*>/g, (x) => x.replace(/[^\n]/g, " "));
  // 剩下的逐行判（行内可能还带 `//` 行注释：`:class="[…, // 中文注释 …]"` 已被属性值抹掉了）
  t.split("\n").forEach((line, i) => {
    const text = normalize(line);
    if (!text || !CJK.test(text)) return;
    if (text.startsWith("//")) return;
    if (SELF_NAMES.has(text)) return;
    hits.push({ line: baseLine + i, text });
  });
  return hits;
}

/** 把 `.vue` 的 `<script>` 段抽出来（用换行补齐前缀，行号与原文一致）。 */
function vueScripts(src) {
  const out = [];
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    const bodyStart = m.index + m[0].indexOf(">") + 1;
    out.push(src.slice(0, bodyStart).replace(/[^\n]/g, "\n") + m[1]);
  }
  return out;
}

// ---------------- 遍历 ----------------

function scan() {
  /** file -> Map<text, count> */
  const byFile = new Map();
  const add = (file, items) => {
    if (!items.length) return;
    const m = byFile.get(file) ?? new Map();
    for (const it of items) m.set(it.text, (m.get(it.text) ?? 0) + 1);
    byFile.set(file, m);
  };

  let files = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      const r = rel(p);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(r) || SKIP_DIRS.has(r + "/")) continue;
        walk(p);
        continue;
      }
      if (!/\.(?:vue|ts)$/.test(e.name)) continue;
      if (/\.(?:test|spec)\.ts$/.test(e.name)) continue;
      if (SKIP_FILES.has(r)) continue;
      files++;
      const src = fs.readFileSync(p, "utf8");
      if (e.name.endsWith(".vue")) {
        // SFC 整份不是合法 TS（模板里大段 HTML），只能分段：模板走 HTML 解析、脚本走 AST
        add(r, templateStrings(r, src));
        for (const s of vueScripts(src)) add(r, stringsInTs(r, s));
      } else {
        add(r, stringsInTs(r, src));
      }
    }
  };
  walk(SRC);
  return { byFile, files };
}

// ---------------- 自证夹具 ----------------

const VUE_FIXTURE = `<template>
  <!-- 这是一整段注释，里面的中文不算界面文案
       第二行也还是注释 -->
  <div title="确定要删除吗">
    <span>共 {{ n }} 条</span>
    <span v-for="c in list" :class="[a, // 模板表达式里的行注释
      b]">：</span>
  </div>
</template>
<script setup lang="ts">
const s = "新消息";
console.error("调试：加载失败");
const re = /超时|timeout/;
</script>`;

function selfcheck() {
  const bad = [];
  const flag = (label, items) => {
    if (!items.length) bad.push(`该红的没红：${label}`);
  };
  const pass = (label, items) => {
    if (items.length) bad.push(`该绿的判红了：${label} ⇒ ${JSON.stringify(items)}`);
  };

  const tpl = templateStrings("fixture.vue", VUE_FIXTURE);
  flag("模板属性值 title=确定要删除吗", tpl.filter((x) => x.text.includes("确定要删除吗")));
  flag("模板文本 共 … 条", tpl.filter((x) => x.text.includes("共")));
  flag("模板文本 全角冒号", tpl.filter((x) => x.text === "："));
  pass("注释里的中文", tpl.filter((x) => x.text.includes("注释")));

  const js = stringsInTs("fixture.ts", `const s = "新消息";\nconsole.error("调试：加载失败");\nconst re = /超时|timeout/;`);
  flag("普通字符串 新消息", js.filter((x) => x.text === "新消息"));
  pass("console 参数", js.filter((x) => x.text.includes("调试")));

  const reOnly = stringsInTs("fixture2.ts", `const re = /超时|timeout/; const ok = "ok";`);
  pass("正则字面量", reOnly);

  return bad;
}

// ---------------- 基线 ----------------

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, "utf8"));
}

function writeBaseline(byFile) {
  const entries = {};
  for (const [f, m] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    entries[f] = {};
    for (const [t, n] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > 0) entries[f][t] = n;
    }
  }
  fs.writeFileSync(
    BASELINE,
    `{\n  "version": 1,\n  "note": "存量基线：只允许减少。新增一条用户可见硬编码中文必须判红；确属有意（如语言自指名）请改文案或在此登记并说明理由。",\n  "entries": ${JSON.stringify(entries, null, 2).replace(/\n/g, "\n  ")}\n}\n`,
    "utf8",
  );
  console.log(`✓ 已写入基线：${rel(BASELINE)}（${Object.keys(entries).length} 个文件）`);
}

// ---------------- 主流程 ----------------

const bad = selfcheck();
if (bad.length) {
  console.error("✗ 自证失败（守卫本身坏了，先修它）：");
  for (const b of bad) console.error(`   - ${b}`);
  process.exit(1);
}

const { byFile, files } = scan();
let total = 0;
for (const m of byFile.values()) for (const n of m.values()) total += n;

if (process.argv.includes("--update")) {
  writeBaseline(byFile);
  process.exit(0);
}

if (files < 150) {
  console.error(`✗ 只扫到 ${files} 个文件 ⇒ 路径/扩展名前提变了（不许把"什么都没扫"当成通过）`);
  process.exit(1);
}
if (total < 40) {
  console.error(`✗ 只扫到 ${total} 条含中文的界面文案 ⇒ 解析器失效（AST/模板分段坏了？）`);
  process.exit(1);
}

const base = readBaseline();
if (!base) {
  console.error(`✗ 缺基线 ${rel(BASELINE)} ⇒ 先跑 \`node scripts/check-hardcoded-ui-text.mjs --update\` 并提交它`);
  process.exit(1);
}

const regressions = [];
for (const [file, m] of byFile) {
  const allowed = base.entries[file] ?? {};
  for (const [text, n] of m) {
    const was = allowed[text] ?? 0;
    if (n > was) regressions.push({ file, text, was, now: n });
  }
}

const stale = [];
for (const [file, m] of Object.entries(base.entries)) {
  for (const [text, n] of Object.entries(m)) {
    const now = byFile.get(file)?.get(text) ?? 0;
    if (now < n) stale.push({ file, text, was: n, now });
  }
}

console.log(`· 扫描 ${files} 个文件 / ${total} 条含中文界面文案 / 基线覆盖 ${Object.keys(base.entries).length} 个文件`);
if (stale.length) {
  console.log(`· 提示：基线里 ${stale.length} 条已不再出现（文案改了或删了，可择机从基线移除，不判红）`);
  for (const s of stale.slice(0, 10)) console.log(`   ~ ${s.file}：${JSON.stringify(s.text)}（基线 ${s.was} → 现在 ${s.now}）`);
  if (stale.length > 10) console.log(`   … 其余 ${stale.length - 10} 条略`);
}

if (regressions.length) {
  console.error(`\n❌ 新增了 ${regressions.length} 条用户可见硬编码中文（走 i18n：加 key + t(...)，别写死）：`);
  for (const r of regressions) {
    console.error(`   ${r.file}：${JSON.stringify(r.text)}（基线 ${r.was} 次 → 现在 ${r.now} 次）`);
  }
  console.error(
    "\n  修法：把文案改成 `t(\"…\")` 并往 `src/i18n/locales/zh-cn.ts` / `en-us.ts` 各加一条；\n" +
      "  确认属于「不自翻译」的语言自指名等例外，才允许 `--update` 扩基线，且必须在提交说明里写理由。",
  );
  process.exit(1);
}

console.log("✅ 没有新增的用户可见硬编码中文（存量走基线，只允许减少）");
