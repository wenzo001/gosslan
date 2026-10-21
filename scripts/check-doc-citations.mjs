#!/usr/bin/env node
/**
 * 文档 `file:line` 引用守卫。
 *
 * ## 为什么要有这个脚本
 * 今天一次只读审计（2026-10-03）在**纯文档**里查出 9 处断裂，全部通过了现有全部门禁：
 *
 * ① `docs/migration-ledger.md` §5「维护规则」是写给接手者的**操作指令**，其中 5 处让读者去
 *    更新 `docs/domains.yml` —— 那个文件**从不存在**（`.yml`→`.mjs` 是有意改名，工具链没有
 *    YAML 解析器），而门禁 `check-domain-map.mjs` 读的是 `.data.mjs` ⇒ **门禁照亮绿灯**。
 * ② 同一份台账里 `transport/mod.rs:122` —— 那个文件**只有 118 行**，引用指着不存在的行。
 * ③ `src-tauri/src/transport/tcp.rs` 模块头两行「接线状态」表的 `file:line` 全部腐烂
 *    （`network/transport.rs:1231,1232,…` 逐个核对**全指向无关代码**）—— 注释说"已接线"是对的、
 *    **行号是烂的**，这比"注释撒谎"更隐蔽：顺行号核对的人会看到无关代码，从而误判"注释在骗人"
 *    而把好的接线拆掉。这是本仓「待接线声明腐烂」族的第三次。
 *
 * 共同点：**这些引用都有唯一事实源（那个文件），只是行号被人手抄了一遍。**
 * 与 `check-doc-numbers.mjs` 同一立场（能被现算的东西不许留第二份手抄），但管的是另一面：
 * 它管"数字"，本脚本管"**指向**"。
 *
 * ## 三条判据（刻意保守：宁可漏报，也绝不误报）
 * **A. 文件必须存在。** 引用的路径按 `SOURCE_ROOTS` 里的每个根 + 文档写出的相对路径解析；
 *    解析不到就报。裸文件名（`state.rs:873`，省略了目录）按"全仓唯一同名文件"解析。
 * **B. 行号必须落在文件范围内。** 这是本脚本的核心，也是唯一能低误报地判"引用腐烂"的那条。
 *    ⚠️ **刻意不判"行内容是否匹配文档说的那个符号"** —— 那会大量误报：文档常写
 *    "见 `foo.rs:12` 的 `bar` 函数"，而那一行可能是 `impl` 块、可能是多行签名的一部分、
 *    可能中间插了行。要判符号得先解析 Rust/TS 语法，那是另一个量级的工具（且解析错了
 *    门禁会静默失效 —— 比没有门禁更危险）。**先把"范围"这条低误报的守住，符号级校验留作
 *    后续可选项。**
 * **C. 扫到 0 处引用时判 INCONCLUSIVE 而非绿。** 防止正则失配 / 目录搬迁让门禁悄悄空转。
 * **D.（2026-10-21 加）裸路径引用的文件必须存在。** 判据 A/B 只管**带行号**的 `file:line`；
 *   文档里大量引用是**裸路径**（`docs/notes/x.md`、`src/components/x.vue`）—— 文件搬家或归档后
 *   它们不会破门禁。实测：把一批历史文档归档后，14 份文档里留下 **44 处**指向不存在文件的引用，
 *   而门禁当时全绿。这条只判"文件在不在"，**不判"文档说的是不是那个东西"**（那是符号级校验，
 *   本脚本刻意不做，见文件头 B 条）。
 *
 * ## 故意不管的（不是漏了，是判据本身做不到）
 * · **带日期的历史快照**：`docs/ARCHITECTURE-REVIEW-*.md` / `docs/final-architecture-review.md` /
 *   `CHANGELOG.md` —— 它们的职责就是把"当时读到的是什么"原样记下来（含当时的行号），
 *   拿今天的事实源去判它们**必然**误报。`docs/stability-roadmap.md` 同理（漂移事故台账）。
 * · **外部 crate / 本仓之外的文件**（如 `tauri-2.11.5/src/app.rs:386`）：`EXTERNAL` 前缀表显式列出。
 * · **裸文件名有多个候选**（如 `mod.rs`、`tests.rs`）：判不准就跳过并计数，见 `ambiguous`。
 *   **静默漏报比误报危险**，但"猜一个"比漏报更危险 —— 所以只跳过、并在结尾报出数量。
 *
 * 退出码：0 = 通过；1 = 有断裂引用。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 被管的活文档：句子里的 `file:line` 是在**声明当前事实**的那几份。
 *
 * 沿用 `check-doc-numbers.mjs` 的 `LIVE_DOCS` 取舍（那份的注释解释了为什么不管
 * stability-roadmap 与 CHANGELOG），只多管两份：
 * · `docs/migration-ledger.md` —— §5 是给接手者的**操作指令**，引用腐烂会直接让人做错事；
 * · `AI_RULES.md` / `AI_PROJECT_HANDOFF.md` —— 每次开工都会被读，且它们是"约束"不是"记录"。
 */
const LIVE_DOCS = [
  "README.md",
  "AI_RULES.md",
  "AI_PROJECT_HANDOFF.md",
  "docs/migration-ledger.md",
  "docs/protocol-invariants.md",
  "docs/large-file-split-plan.md",
  // 2026-10-21：CHANGELOG 是用户与接手者最先读的版本记录，里面的归档路径腐烂过一次
  // （C5.3 的 6 处 `docs/archive/...` 指向不存在的文件），此前不在任何判据视野里。
  "CHANGELOG.md",
];

/**
 * 路径解析根：文档里的 `network/transport.rs` 按 `src-tauri/src/` 下的相对路径理解。
 *
 * 依据（本项目的事实，不是约定）：活文档里 23 处引用**没有一处**带 `src-tauri/src/` 前缀，
 * 而它们全部指向 Rust 源文件 ⇒ 约定就是"相对 `src-tauri/src/`"。
 * `src/` 放前端（`.ts`/`.vue`），`scripts/` 放门禁脚本 —— 三根都试，谁先命中算谁。
 */
const SOURCE_ROOTS = ["src-tauri/src", "src", "scripts", "docs", "."];

/** 外部 / 本仓之外：显式列出，不靠"解析不到就当外部"（那会让判据 A 形同虚设）。 */
const EXTERNAL = [
  /^tauri-[\w-]*\d[\w.-]*\//, // 外部 crate 的源码引用：tauri-2.x / tauri-macros-2.x
  /^rusqlite-[\d.]+\//, // 锁定版 rusqlite 的源码（事务 drop 行为那段引用）
  /^mio-[\d.]+\//, // 锁定版 mio 的 kqueue 实现
  /^\.\.\//, // 明确的父目录引用
];

// 形如 `path/to/file.rs:12`、`:12-34`、`:15,19,24`（反引号或裸文本都吃）
const CITE = /`?([A-Za-z0-9_][\w./-]*\.(?:rs|ts|vue|mjs|js|py|toml|json|yml|yaml|html|css|md))((?::\d+)+(?:[-,]\d+)*)`?/g;

const fails = [];
const skippedExternal = [];
let ambiguous = 0;
let total = 0;

/** 全仓文件名索引：裸名（`state.rs:873`）靠它解析。 */
function buildIndex() {
  const byBase = new Map();
  const skip = new Set(["node_modules", "target", "dist", ".git", ".workbuddy", "test-results"]);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        if (!byBase.has(e.name)) byBase.set(e.name, []);
        byBase.get(e.name).push(path.relative(ROOT, abs));
      }
    }
  };
  walk(ROOT);
  return byBase;
}

const INDEX = buildIndex();

/** 解析引用里的路径 → 仓库内绝对路径；解析不到返回 null。 */
function resolveRef(ref) {
  if (path.isAbsolute(ref)) return fs.existsSync(ref) ? ref : null;
  for (const root of SOURCE_ROOTS) {
    const p = path.join(ROOT, root, ref);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  // 裸名：全仓唯一同名才认
  const hits = INDEX.get(path.basename(ref)) ?? [];
  if (hits.length === 1) return path.join(ROOT, hits[0]);
  if (hits.length > 1) ambiguous++;
  return null;
}

/** `:15,19,24` / `:12-34` → [12, 15, 19, 24]（区间展开，端点都取） */
function parseLineSpec(spec) {
  const out = [];
  for (const part of spec.split(":").filter(Boolean)) {
    for (const seg of part.split(",")) {
      const m = seg.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      // 区间取端点即可（判"是否在范围内"不需要枚举中间每一行）
      out.push(a);
      if (b !== a) out.push(b);
    }
  }
  return out;
}

for (const doc of LIVE_DOCS) {
  const abs = path.join(ROOT, doc);
  if (!fs.existsSync(abs)) {
    fails.push(`${doc}：被管的活文档不存在（清单与仓库不一致，先确认是不是被移走了）`);
    continue;
  }
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split("\n");
  for (const m of text.matchAll(CITE)) {
    const [, ref, spec] = m;
    total++;
    // 行号必须落在文件范围内
    const nums = parseLineSpec(spec);
    if (nums.length === 0) continue;
    if (EXTERNAL.some((re) => re.test(ref))) {
      skippedExternal.push(`${doc}: ${ref}${spec}`);
      continue;
    }
    const target = resolveRef(ref);
    if (!target) {
      // 解析不到：只在"它看起来确实像个仓库内路径"时报，避免把散文里的
      // `README.md`（相对文档自身）之类算成断裂。
      if (ref.includes("/")) fails.push(`${doc}:${line(text, m.index)} 引用 \`${ref}\` —— 本仓找不到这个文件`);
      continue;
    }
    const totalLines = fs.readFileSync(target, "utf8").split("\n").length;
    for (const n of nums) {
      if (n < 1 || n > totalLines) {
        fails.push(
          `${doc}:${line(text, m.index)} 引用 \`${ref}${spec}\` —— ` +
            `超出文件范围（${path.relative(ROOT, target)} 共 ${totalLines} 行）`,
        );
      }
    }
  }
}

function line(text, idx) {
  return text.slice(0, idx).split("\n").length;
}

// ---------------- 判据 D：裸路径引用（不带行号）的文件必须存在 ----------------
/**
 * 扫描范围：**全部已入库的 `*.md`**，减去两类"按历史记录它们的职责就是不指向今天"的文件：
 *   · `CHANGELOG.md` —— 带日期的发布记录（记的是当时读到什么）；
 *   · `docs/archive/**` —— 2026-10-21 归档的历史件（本身就是"当时的快照"）。
 * 其余（ADR、notes、architecture、台账、活文档）都要求路径真实存在。
 *
 * 豁免表每条都带理由；新增豁免要在同一条里写清"为什么它该是例外"，
 * 否则豁免表自己会变成第二个"没人核对的假事实源"。
 */
const PATH_SCOPE_SKIP = new Set([
  "CHANGELOG.md",
  // 2026-10-18 的重构取证快照：它的职责就是记"当时读到/计划建的文件"（含还没建的
  // `src/utils/cn.ts` 之类），拿今天的事实源去判它必然误报 —— 与 CHANGELOG 同理。
  "docs/architecture/refactor-5.0-report.md",
]);
const PATH_ALLOW = new Map([
  // 故意"不新建"的文件：design-guidelines §1 写明为什么不另开一份
  ["docs/native-experience-standard.md", "design-guidelines §1 明确说明为什么不另开这份标准"],
  // 已在"已删除"清单里点名的过时件（提及它们本身就是"它们没了"的记录）
  ["docs/ARCHITECTURE-EXPLAINED.md", "2026-10-21 已删除；HANDOFF/索引的『已删除』清单里点名"],
  ["docs/P1-image-out-of-sqlite-overview.md", "2026-10-21 已删除；同上"],
  ["docs/strong-reminder-plan.md", "2026-10-21 已删除；同上"],
  ["docs/acceptance/strong-reminder-final.md", "2026-10-21 已归档到 docs/archive/acceptance/；同上"],
  ["docs/acceptance/native-experience-round-1.md", "2026-10-21 已归档到 docs/archive/acceptance/"],
  // 已删除、但报告里作为"当时的暂存状态"被点名（该删除已随 5.0.38 提交）
  ["src/composables/useDeferredRef.ts", "该文件已随 5.0.38 删除；rc-5.0-report 记的是当时的暂存状态"],
  // 签名钥匙按最新要求**绝不入库**（`.gitignore` 明确排除）：发行版钥匙只存在于
  // GitHub Actions Secrets 与本机；CI 的 `release.keystore` 是构建时注入/复制出来的。
  // 文档里的人眼路径是操作说明，不是"仓库里应该有这个文件"的断言 ⇒ 属于门禁不适用。
  ["scripts/android/keystore/gosslan-release.keystore", "发行版钥匙按设计不入库；本机/Secrets 才有一份"],
  ["src-tauri/gen/android/app/release.keystore", "CI 构建时注入/复制；仓库按设计不含签名钥匙"],
  // 示例占位（不是真引用）
  ["docs/xxx.md", "文档里的示例占位"],
  ["scripts/x.mjs", "文档里的示例占位"],
  ["src-tauri/src/schema.sql", "文档里的示例占位"],
]);

/** 只认"看起来像仓库内路径"且带扩展名的反引号 token。 */
const PATHREF = /`((?:src|src-tauri|docs|scripts|perf|examples)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`/g;

const pathDocs = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !PATH_SCOPE_SKIP.has(f) && !f.startsWith("docs/archive/"));

let pathTotal = 0;
for (const doc of pathDocs) {
  const abs = path.join(ROOT, doc);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, "utf8");
  for (const m of text.matchAll(PATHREF)) {
    const ref = m[1];
    if (ref.includes("...")) continue; // 示例占位
    if (PATH_ALLOW.has(ref)) continue; // 豁免表里带理由
    pathTotal++;
    if (!fs.existsSync(path.join(ROOT, ref))) {
      fails.push(
        `${doc}:${line(text, m.index)} 引用 \`${ref}\` —— 本仓找不到这个文件` +
          `（文件搬家/删除后没同步文档？改路径，或加进 PATH_ALLOW 并写明理由）`,
      );
    }
  }
}

// ---------- 判据 C：覆盖面自证 ----------
if (pathTotal < 40) {
  console.error(
    `✗ 只从活文档里认出 ${pathTotal} 处裸路径引用（今天至少 40 处）\n` +
      `  ⇒ 解析前提变了（正则失配 / 文档改名 / 全部清空），先修这条守卫再谈别的。`,
  );
  process.exit(1);
}

if (total < 20) {
  console.error(
    `✗ 只从活文档里认出 ${total} 处 \`file:line\` 引用（今天至少 20 处）\n` +
      `  ⇒ 解析前提变了（正则失配 / 文档改名 / 全部清空），先修这条守卫再谈别的。`,
  );
  process.exit(1);
}

if (fails.length) {
  console.error("✗ 文档引用守卫：以下 `file:line` 已断裂（指向不存在的文件或超出文件范围）\n");
  for (const f of fails) console.error(`  - ${f}`);
  console.error(
    `\n修法：把行号重钉到真符号上（\`grep -n '<符号名>' <文件>\` 现算，别抄）；` +
      `若那是外部文件或本仓确实没有该文件，加进 EXTERNAL 前缀表并写明理由。`,
  );
  process.exit(1);
}

console.log(
  `✓ 文档引用守卫：${LIVE_DOCS.length} 份活文档、${total} 处 \`file:line\` 引用全部落在真文件真行范围内` +
    `；${pathDocs.length} 份文档、${pathTotal} 处裸路径引用全部指向真实文件` +
    (ambiguous ? `（${ambiguous} 处裸名有多个同名文件、判不准已跳过）` : "") +
    (skippedExternal.length ? `（${skippedExternal.length} 处外部引用已豁免）` : ""),
);
