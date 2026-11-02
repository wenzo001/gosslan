#!/usr/bin/env node
/**
 * 领域图守门（domain map guard）—— 不让地图变成虚构。
 *
 * ## 为什么需要它
 *
 * `docs/domains.data.mjs` 是给 AI（与人）看"我改的是哪个领域、边界在哪"的地图。
 * 地图**错了比没有更危险**，因为它会被当成事实执行：
 *
 *   · 路径写错 ⇒ 按图索骥找不到代码，或改到隔壁领域；
 *   · 一个文件被两个领域认领 ⇒ 改它时不知道该守谁的规则；
 *   · 有文件没人认领 ⇒ 那块地盘是"无主之地"，最容易出跨界 bug；
 *   · `enforce: true` 但边界其实还在迁移中 ⇒ 闸门第一天就全红，然后被绕过。
 *
 * ## 判据
 *
 *   A. **结构**：每个领域必须有 `id` / `name` / `tier`（L1|L2|L3）/ `paths` / `invariants`
 *      且 `id` 唯一。
 *   B. **路径存在**：`paths` 里每一项在磁盘上必须存在（文件或目录）。
 *   C. **不重叠**：一个文件**最多**被一个领域认领。
 *   D. **无遗漏**：`coverageRoots` 下每个源文件，要么被某领域认领，要么显式列进 `unmapped`。
 *      （不需要"先加白名单才不报错"—— 但**必须显式**，不能靠"没提到"蒙混。）
 *   E. **活路径可信**：`activeHome` 必须是该领域 `paths` 里的一项（或显式写 `activeHomeNote`
 *      说明为什么没有独立文件）。
 *   F. **`enforce` 只能开在单家领域**：`enforce: true` 但存在 `secondHome` ⇒ FAIL。
 *      这条把「边界收口完成一个，打开一个」从口号变成机器判定。
 *   G. **每条不变量必须有领域认领**（2026-11-02 加）：`docs/protocol-invariants.md` 的每个
 *      `### INV-P…` 标题、与 `AI_RULES.md` 的每个 `INV-0NN`，都必须出现在**至少一个**领域的
 *      `invariants` 里；反过来，领域认领的 id 必须在那两个真源之一里**真实存在**（防幽灵引用）。
 *      认领的口径沿用图里已有的那句：「本节或其判据点名的实现/钩子落在本域 `paths` 上」。
 *   H. **契约图的 `inv` 快照必须与 `.mjs` 逐项一致**（2026-11-02 加）：
 *      `docs/ARCHITECTURE-MAP.html` 内联了同一份领域清单（`{"id":…, "inv":[…]}` 那些行），
 *      而本脚本原先**只读 `.mjs`、不看 HTML** ⇒ 改那边不改这里不会有任何东西变红
 *      （图里那句 ⚠️ 注释是唯一的提醒，而注释不是判据）。现在两边按集合对账，
 *      并且**领域 id 也要双向对齐** —— 否则新增一个域只写进 `.mjs`，快照那条判据会静默少判一格。
 *
 * ## 本脚本**守不住**的（诚实边界）
 *
 * 它守不住 `activeHome` **是否属实** —— 那一栏只能靠人诚实（与真机/调用点核对）。
 * 所以 `docs/migration-ledger.md` 要求每个关注点给出 file:line 证据：机器守形式，人守事实。
 *
 * ## 用法
 *
 *     node scripts/check-domain-map.mjs
 *
 * 退出码：0 = 通过；1 = 地图有问题。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import domainMap from "../docs/domains.data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 参与覆盖检查的源文件后缀（其余如 .html/.json 不在 coverageRoots 的语义范围内）。 */
const SOURCE_EXT = [".rs", ".ts", ".vue", ".tsx", ".css", ".sql"];

const TIERS = new Set(["L1", "L2", "L3"]);

let ok = true;
const fail = (msg) => {
  ok = false;
  console.error(msg);
};

/** 递归收集文件（相对 ROOT 的路径）。 */
function collectFiles(absDir, acc = []) {
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "target", "vendor", "dist"].includes(e.name)) continue;
      collectFiles(abs, acc);
    } else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) {
      acc.push(path.relative(ROOT, abs));
    }
  }
  return acc;
}

/** 把一条 `paths` 项展开成它包含的文件（文件 → 自身）。 */
function expand(entry) {
  const abs = path.join(ROOT, entry);
  if (!existsSync(abs)) return null;
  if (statSync(abs).isDirectory()) return collectFiles(abs);
  return [path.normalize(entry)];
}

// ---------------- A. 结构 ----------------
console.log("判据 A：结构");
if (!Number.isInteger(domainMap.version)) fail("  ✗ 缺少 version（整数）");
const ids = new Set();
for (const d of domainMap.domains ?? []) {
  const missing = ["id", "name", "tier", "paths", "invariants"].filter((k) => d[k] === undefined);
  if (missing.length) {
    fail(`  ✗ 领域 ${d.id ?? "(无 id)"} 缺字段：${missing.join(", ")}`);
    continue;
  }
  if (ids.has(d.id)) fail(`  ✗ 领域 id 重复：${d.id}`);
  ids.add(d.id);
  if (!TIERS.has(d.tier)) fail(`  ✗ 领域 ${d.id} 的 tier 非法：${d.tier}（应为 L1/L2/L3）`);
  if (!Array.isArray(d.paths)) fail(`  ✗ 领域 ${d.id} 的 paths 必须是数组`);
  if (typeof d.enforce !== "boolean") fail(`  ✗ 领域 ${d.id} 缺 enforce（布尔）`);
}
if (ok) console.log(`  ✓ ${domainMap.domains.length} 个领域，字段齐、id 唯一、tier 合法`);

// ---------------- B/C. 路径存在 + 不重叠 ----------------
console.log("\n判据 B/C：路径存在 + 一个文件最多属一个领域");
/** @type {Map<string, string>} 文件 → 领域 id */
const owner = new Map();
const overlaps = [];
for (const d of domainMap.domains) {
  for (const entry of d.paths) {
    const files = expand(entry);
    if (files === null) {
      fail(`  ✗ 领域 ${d.id} 的路径不存在：${entry}`);
      continue;
    }
    for (const f of files) {
      const prev = owner.get(f);
      if (prev === undefined) owner.set(f, d.id);
      else overlaps.push(`      ${f}  ← ${prev} 与 ${d.id}`);
    }
  }
}
for (const entry of domainMap.unmapped ?? []) {
  const [p] = entry;
  if (!existsSync(path.join(ROOT, p))) fail(`  ✗ unmapped 里的路径不存在：${p}`);
}
if (overlaps.length) {
  fail(`  ✗ ${overlaps.length} 个文件被多个领域认领：`);
  for (const o of overlaps.slice(0, 15)) console.error(o);
} else {
  console.log(`  ✓ 所有路径存在；已认领 ${owner.size} 个文件，无重叠`);
}

// ---------------- D. 无遗漏 ----------------
console.log("\n判据 D：coverageRoots 下不许有无主文件");
const unmappedPrefixes = (domainMap.unmapped ?? []).map(([p]) => path.normalize(p));
const unowned = [];
for (const root of domainMap.coverageRoots ?? []) {
  const abs = path.join(ROOT, root);
  if (!existsSync(abs)) {
    fail(`  ✗ coverageRoots 里的根不存在：${root}`);
    continue;
  }
  for (const f of collectFiles(abs)) {
    if (owner.has(f)) continue;
    if (unmappedPrefixes.some((p) => f === p || f.startsWith(p + path.sep))) continue;
    unowned.push(f);
  }
}
if (unowned.length) {
  fail(`  ✗ ${unowned.length} 个文件既没被领域认领、也没列进 unmapped：`);
  for (const f of unowned.slice(0, 20)) console.error(`      ${f}`);
  console.error("    修法：把它加进某个领域的 paths，或（想清楚后）列进 unmapped。");
} else {
  console.log("  ✓ 每个源文件都有归属");
}

// ---------------- E. activeHome 可信 ----------------
console.log("\n判据 E：activeHome 必须是自己的路径之一");
for (const d of domainMap.domains) {
  if (d.activeHome === null || d.activeHome === undefined) {
    if (!d.activeHomeNote) {
      fail(`  ✗ 领域 ${d.id} 的 activeHome 为空，但没有 activeHomeNote 解释原因`);
    } else {
      console.log(`  ✓ ${d.id}：无独立文件（已说明：${d.activeHomeNote.slice(0, 40)}…）`);
    }
    continue;
  }
  const okHome = d.paths.some(
    (p) => path.normalize(p) === path.normalize(d.activeHome) || d.activeHome.startsWith(p + "/") || d.activeHome === p,
  );
  if (!okHome) fail(`  ✗ 领域 ${d.id} 的 activeHome（${d.activeHome}）不在自己的 paths 里`);
}
if (ok) console.log("  ✓ 全部一致");

// ---------------- F. enforce 只能开在单家领域 ----------------
console.log("\n判据 F：enforce 只能开在已收口（单家）的领域");
let enforceOn = 0;
for (const d of domainMap.domains) {
  if (!d.enforce) continue;
  enforceOn++;
  if (d.secondHome) {
    fail(
      `  ✗ 领域 ${d.id} 开了 enforce，但它还有第二个家（${d.secondHome}，状态 ${d.secondHomeStatus}）\n` +
        `      边界还不是事实时打开闸门 ⇒ 第一天就全红 ⇒ 会被绕过。`,
    );
  }
}
console.log(
  `  ✓ ${enforceOn} 个领域开了 enforce，${domainMap.domains.length - enforceOn} 个仍为 false（迁移中）`,
);
if (enforceOn === 0) {
  console.log("    ⚠️ 当前一个都没开 —— 这是刻意的：边界收口完成一个，打开一个（Phase 6）。");
}

// ---------------- G. 每条不变量都必须有领域认领 ----------------
// 分母**不从图里抄**：它来自两个真源的标题/原文，逐条现读。
// 为什么两侧都要判：只有"孤儿"这一半时，把 `invariants` 里已有的一个 id 改名（如 INV-P24 → INV-P24x）
// 会同时少一条孤儿、多一条幽灵，而幽灵那一半才咬得住这种形状。
console.log("\n判据 G：每条不变量都要有领域认领（无孤儿 + 无幽灵引用）");
const INV_SOURCES = [
  // 协议级不变量：只认**标题行**（正文里的引用是交叉引用，不是"这条存在"的定义）
  { file: "docs/protocol-invariants.md", re: /^###\s+(INV-P\d+[a-z]?)\s*—/gm, label: "protocol-invariants.md" },
  // 通用不变量族（INV-0NN）：AI_RULES.md 是它唯一的家
  { file: "AI_RULES.md", re: /\b(INV-0\d{2})\b/g, label: "AI_RULES.md" },
];
const definedIn = new Map();
for (const s of INV_SOURCES) {
  const abs = path.join(ROOT, s.file);
  if (!existsSync(abs)) {
    fail(`  ✗ 不变量真源文件不存在：${s.file}（分母取不到 ⇒ 这条判据会空转）`);
    continue;
  }
  for (const m of readFileSync(abs, "utf8").matchAll(s.re)) {
    if (!definedIn.has(m[1])) definedIn.set(m[1], s.label);
  }
}
const claimedBy = new Map();
for (const d of domainMap.domains ?? []) {
  for (const i of d.invariants ?? []) {
    if (!claimedBy.has(i)) claimedBy.set(i, []);
    claimedBy.get(i).push(d.id);
  }
}
const orphans = [...definedIn.keys()].filter((i) => !claimedBy.has(i)).sort();
const ghosts = [...claimedBy.keys()].filter((i) => !definedIn.has(i)).sort();
if (orphans.length) {
  fail(`  ✗ ${orphans.length} 条不变量没有任何领域认领（无主 ⇒ 谁改都不守它）：`);
  for (const i of orphans) console.error(`      ${i}  ← 定义在 ${definedIn.get(i)}`);
  console.error('    修法：把 id 加进它点名的实现所在领域的 `invariants`，并同改 docs/ARCHITECTURE-MAP.html 的快照。');
}
if (ghosts.length) {
  fail(`  ✗ ${ghosts.length} 条 invariants 引用在两个真源里都不存在（幽灵/笔误）：${ghosts.join(", ")}`);
  console.error("    修法：改回真名，或先在 docs/protocol-invariants.md 写成 `### INV-Pxx — 标题`。");
}
if (!orphans.length && !ghosts.length) {
  console.log(`  ✓ 分母现读 ${definedIn.size} 条（图里认领 ${claimedBy.size} 个 id），无孤儿、无幽灵`);
}

// ---------------- H. 契约图的 inv 快照必须与 .mjs 一致 ----------------
// HTML 里那 11 行 `{"id":…, "inv":[…]}` 是 `docs/domains.data.mjs` 的**手抄快照**，
// 原先没有任何东西对账（图里只有一句 ⚠️ 注释，而注释不是判据）。
console.log("\n判据 H：契约图（docs/ARCHITECTURE-MAP.html）的 inv 快照 ↔ .mjs 逐项一致");
const MAP_HTML = path.join(ROOT, "docs", "ARCHITECTURE-MAP.html");
if (!existsSync(MAP_HTML)) {
  fail("  ✗ 契约图文件不存在：docs/ARCHITECTURE-MAP.html（这条判据会空转）");
} else {
  const snapshot = new Map();
  for (const line of readFileSync(MAP_HTML, "utf8").split("\n")) {
    const idM = /\{"id":\s*"([^"]+)"/.exec(line);
    const invM = /"inv":\s*\[([^\]]*)\]/.exec(line);
    if (!idM || !invM) continue;
    const items = [...invM[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (snapshot.has(idM[1])) fail(`  ✗ 契约图里领域 ${idM[1]} 出现多次（快照该只有一份）`);
    snapshot.set(idM[1], items);
  }
  const mjsIds = (domainMap.domains ?? []).map((d) => d.id);
  for (const d of domainMap.domains ?? []) {
    if (!snapshot.has(d.id)) {
      fail(`  ✗ 契约图里没有领域 ${d.id} 的快照行 ⇒ 这条判据对它是空判`);
      continue;
    }
    const a = new Set(snapshot.get(d.id));
    const b = new Set(d.invariants ?? []);
    const onlyHtml = [...a].filter((x) => !b.has(x)).sort();
    const onlyMjs = [...b].filter((x) => !a.has(x)).sort();
    if (onlyHtml.length || onlyMjs.length) {
      fail(
        `  ✗ 领域 ${d.id} 的 inv 快照与 .mjs 不一致：` +
          (onlyHtml.length ? `\n      只在 HTML：${onlyHtml.join(", ")}` : "") +
          (onlyMjs.length ? `\n      只在 .mjs：${onlyMjs.join(", ")}` : ""),
      );
    }
  }
  for (const id of snapshot.keys()) {
    if (!mjsIds.includes(id)) fail(`  ✗ 契约图里有领域 ${id} 的快照，但 .mjs 没有这个领域（两边各有真假）`);
  }
  if (ok) console.log(`  ✓ ${snapshot.size} 个领域的 inv 快照与 .mjs 逐项一致（共 ${claimedBy.size} 个 id）`);
}

// ---------------- 汇总 ----------------
if (ok) {
  console.log("\n✓ 领域图与仓库现状一致。");
  console.log("  （已知边界：守不住 activeHome 是否属实 —— 那一栏靠人诚实 + 台账里的 file:line 证据。）");
  console.log("  （判据 G/H 守的是「认领关系与快照的形式一致」，不担保认领**得对** —— 每条的理由写在图里的行注释上。）");
  process.exit(0);
}
console.error("\n✗ 领域图与实际仓库不一致 —— 先修图，再动代码。");
process.exit(1);
