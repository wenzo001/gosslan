#!/usr/bin/env node
/**
 * 前端 import 环守卫（A0 批次的自动判据）。
 *
 * ## 为什么要它
 *
 * 2026-10-23 的异步链路审计要回答"项目里有没有循环依赖"。当时的答案是"没有"，
 * 但那个答案来自一份**跑在 /tmp 里的一次性脚本**：它不进门禁，所以
 * "今天没有环"这句话的保质期只有几小时 —— 下一个人加一条 `store ⇄ component`
 * 的互相 import，全仓没有任何东西会红，而环的代价（模块初始化顺序、
 * `undefined is not a function`、Pinia store 在模块求值期被取用）要到运行时才显形，
 * 且现场表现与"环"毫无关系，没人会往这儿查。
 *
 * 本脚本把那个读数固化成一条判据：**有环就红，无环才绿**，并且
 * 允许一份**显式白名单**（每条都要写理由），因为"存在环"有时是既成事实而不是缺陷 ——
 * 但那是有人签字的例外，不是量具读空了。
 *
 * ## 判的是什么形状
 *
 * 只判**模块级** import：静态 `import … from "…"` / `export … from "…"` /
 * `import type`（都算，因为求值期副作用与初始化顺序对类型之外的写法同样成立）。
 * **不判**函数体内的动态 `import("…")` —— 那是刻意的延迟求值，正是打破环的常用手段，
 * 把它算进图里会把修复手法报成缺陷。
 *
 * 覆盖 `.ts` 与 `.vue`；`.vue` 只取它的 `<script>` 段。`.d.ts` 不进图（纯类型声明，
 * 无运行时节点）。解析按 `tsconfig` 的 `@/* → src/*` 别名 + 相对路径，
 * 并补 `.ts/.vue/index.*` 这几种落点。
 *
 * ## 非空转证明（本仓的规矩：判据要能红）
 *
 * `node scripts/check-import-cycles.mjs --self-test`
 * 它不读仓库，而是喂给判据两张**人造**的图：一条有环（必须判出 1 个环）、
 * 一条无环（必须判出 0 个）。两个方向都命中才算这条量具活着 ——
 * 只跑真仓库的"0 个环"无法区分"确实没有环"和"提取器根本没解析到边"。
 *
 * ## 用法
 *
 *     node scripts/check-import-cycles.mjs              # 门禁调它
 *     node scripts/check-import-cycles.mjs --self-test  # 量具自证
 *
 * 退出码：0 = 无环（或环全在白名单里）；1 = 有新环 / 白名单里的环已经不存在；2 = 用量错。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/**
 * 已知的、被签字认可的环：键是"这一组文件构成一个环"的稳定标识（成员绝对路径排序后 join）。
 * 今天**空**（2026-10-23 现算：0 个环）。往里加一条时必须写清为什么可以留着，
 * 并且允许"白名单里的环已经不在了"反向报红 —— 过期白名单和第二份事实源是同一类债。
 */
const ALLOWED_CYCLES = [];

/** 递归收 src/ 下的 .ts / .vue（跳过 .d.ts；不碰 dist 与 node_modules —— 它们不在 src 里）。 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** .vue 只取第一个 `<script …>…</script>` 段（取不到就当空文件，靠下面的自检兜住）。 */
function scriptPart(src, isVue) {
  if (!isVue) return src;
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : "";
}

/** 一个文件的 import 源（specifier 列表）。`preProcessFile` 不区分 import type，这里刻意一起算。 */
function importedSpecifiers(src) {
  const pre = ts.preProcessFile(src, true, true);
  return pre.importedFiles.map((f) => f.fileName);
}

/** specifier → 仓库里的真实文件；解析不到（外部包、虚拟模块）返回 null。 */
function makeResolver(fileSet) {
  const candidates = (abs) => [
    abs,
    `${abs}.ts`,
    `${abs}.vue`,
    `${abs}.d.ts`,
    path.join(abs, "index.ts"),
    path.join(abs, "index.vue"),
  ];
  return (from, spec) => {
    if (spec.startsWith("@/")) {
      const abs = path.join(SRC, spec.slice(2));
      return candidates(abs).find((c) => fileSet.has(c)) ?? null;
    }
    if (spec.startsWith(".")) {
      const abs = path.resolve(path.dirname(from), spec);
      return candidates(abs).find((c) => fileSet.has(c)) ?? null;
    }
    return null; // 裸包名（vue / pinia / reka-ui / @tauri-apps/*…）：不是本仓的节点
  };
}

/** Tarjan 式的找环 DFS：返回去重后的环（按成员集合去重，同一条环不因起点不同数两次）。 */
function findCycles(graph, nodes) {
  const cycles = [];
  const seen = new Set();
  const onStack = new Set();
  const stack = [];
  const walk = (n) => {
    if (onStack.has(n)) {
      const i = stack.indexOf(n);
      const found = stack.slice(i);
      const key = [...found].sort().join("|");
      if (!cycles.some((c) => c.key === key)) cycles.push({ key, members: found });
      return;
    }
    if (seen.has(n)) return;
    seen.add(n);
    onStack.add(n);
    stack.push(n);
    for (const d of graph.get(n) ?? []) walk(d);
    stack.pop();
    onStack.delete(n);
  };
  for (const n of nodes) walk(n);
  return cycles;
}

/**
 * 量具自证：人造一张有环的图 + 一张无环的图，两个方向都必须判对。
 * 只跑真仓库的"0 个环"分不出"没有环"和"一条边都没解析出来"。
 */
function selfTest() {
  const a = "/x/a.ts";
  const b = "/x/b.ts";
  const c = "/x/c.ts";
  const ring = new Map([
    [a, [b]],
    [b, [c]],
    [c, [a]],
  ]);
  const tree = new Map([
    [a, [b, c]],
    [b, [c]],
    [c, []],
  ]);
  const cycRing = findCycles(ring, [a, b, c]);
  const cycTree = findCycles(tree, [a, b, c]);
  if (cycRing.length !== 1) {
    console.error(`✗ 量具自检失败：三元环应判出 1 个环，实际 ${cycRing.length} ⇒ 找环逻辑读空`);
    return 1;
  }
  if (cycTree.length !== 0) {
    console.error(`✗ 量具自检失败：无环图应判出 0 个，实际 ${cycTree.length} ⇒ 会误报，判据不可信`);
    return 1;
  }
  console.log(`✓ 量具自检：人造三元环判出 1 个、菱形依赖判出 0 个（两个方向都能红）`);
  return 0;
}

function main() {
  const flag = process.argv[2];
  if (flag === "--self-test") process.exit(selfTest());
  if (flag !== undefined && flag !== "--quiet") {
    console.error(`用法：node scripts/check-import-cycles.mjs [--self-test|--quiet]`);
    process.exit(2);
  }
  const quiet = flag === "--quiet";
  const say = (...a) => {
    if (!quiet) console.log(...a);
  };

  const files = collect(SRC);
  const fileSet = new Set(files);
  const resolve = makeResolver(fileSet);
  const graph = new Map();
  let edges = 0;
  let unparsedVue = 0;
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const src = scriptPart(raw, f.endsWith(".vue"));
    if (f.endsWith(".vue") && src.trim() === "" && raw.includes("<script")) unparsedVue += 1;
    const deps = [];
    for (const spec of importedSpecifiers(src)) {
      const r = resolve(f, spec);
      if (r && r !== f) deps.push(r);
    }
    const uniq = [...new Set(deps)];
    graph.set(f, uniq);
    edges += uniq.length;
  }

  // 提取器的活性下限：文件数与边数都要够，否则"0 个环"可能只是读空了。
  // 分母不钉死具体值（那是第二条手抄的数），只设**下限**：今天真实读数是几百个文件、
  // 上千条边，掉到这个下限以下说明扫描面或解析方式坏了，而不是项目变简单了。
  const MIN_FILES = 250;
  const MIN_EDGES = 500;
  if (files.length < MIN_FILES || edges < MIN_EDGES) {
    console.error(
      `✗ 扫描面异常：${files.length} 文件 / ${edges} 条边（下限 ${MIN_FILES}/${MIN_EDGES}）` +
        ` ⇒ 这不是"没有环"，是量具读空了。先查 collect() 的目录与 scriptPart() 的取段。`,
    );
    process.exit(1);
  }
  if (unparsedVue > 0) {
    console.error(`✗ ${unparsedVue} 个 .vue 里有 <script> 却没取出内容 ⇒ 提取器形状漂了，读数不可信`);
    process.exit(1);
  }

  const cycles = findCycles(graph, files);
  const allowed = new Set(ALLOWED_CYCLES.map((c) => [...c.members].sort().join("|")));
  const fresh = cycles.filter((c) => !allowed.has(c.key));
  const staleAllowed = [...allowed].filter((k) => !cycles.some((c) => c.key === k));

  say(
    `· import 图现算：${files.length} 个文件 / ${edges} 条边 / ${cycles.length} 个环` +
      `（白名单 ${allowed.size} 条）`,
  );

  let rc = 0;
  if (fresh.length > 0) {
    console.error(`✗ 新增 ${fresh.length} 个 import 环（前端模块级互相依赖）：`);
    for (const c of fresh.slice(0, 20)) {
      console.error(`  ${c.members.map((m) => path.relative(ROOT, m)).join(" → ")} → ${path.relative(ROOT, c.members[0])}`);
    }
    console.error(
      `  要么把公共那部分往下沉一层（类型 / 纯函数 / store 的 getter），` +
        `要么在 ALLOWED_CYCLES 里签字并写清为什么可以留着。`,
    );
    rc = 1;
  }
  if (staleAllowed.length > 0) {
    console.error(
      `✗ 白名单里有 ${staleAllowed.length} 条环已经不存在了 ⇒ 过期例外必须删掉，` +
        `留着它会让下一次真环被静默放行`,
    );
    rc = 1;
  }
  if (rc === 0) say("✓ 前端 import 图无环");
  process.exit(rc);
}

if (existsSync(SRC)) main();
else {
  console.error(`✗ 找不到 ${SRC} —— 本脚本必须从仓库根跑`);
  process.exit(2);
}
