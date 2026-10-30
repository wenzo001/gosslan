#!/usr/bin/env node
/**
 * 静默丢弃棘轮：生产代码里 `xxx.ok();` 这种**把 Result 当语句丢掉**的形态只许减少、不许增加。
 *
 * 为什么需要它（审计 B4-F1）：`.ok()` 把"失败"变成"没有错误"，而语句形式连"收到了什么"
 * 都不留 —— 写库失败时界面照常前进、日志一行没有（`失联的好友/丢了的分片/没落库的群密钥`
 * 都是这么走丢的）。这一批**只收分母与基线**：81 处先原样登记，之后逐批往下清，
 * 基线只能由本脚本的 `--update` 生成（只降不升）。
 *
 * 判据分两层：
 * 1. **硬零**：`set_message_status` / `set_message_failed` / `apply_recall` 这三个
 *    「托着承诺」的写**不许**再以 `.ok();` 出现。它们曾经就是两条独立写、错误全吞
 *    （`db/messages.rs` 里那段注释记着那次事故），清完就必须保持零。
 * 2. 其余按文件计数对 `scripts/silent-drops-baseline.json` 做棘轮（涨则红，降允许）。
 *
 * 两条尺子沿用 panic 棘轮（直接 import，避免两份实现漂）：
 * - **注释与字符串**抹成空格（`stripRust`）：文档里写 `xxx.ok();` 不算站点；
 * - **`#[cfg(test)]` 条目**（`stripCfgTest`）：只认测试块会把测试噪声算进基线。
 *
 * 用法：
 *   node scripts/check-silent-drops.mjs            # 门禁用（默认）
 *   node scripts/check-silent-drops.mjs --update   # 重新生成基线（只在真实收敛时）
 *   node scripts/check-silent-drops.mjs --self-test
 *   node scripts/check-silent-drops.mjs --report   # 按「该不该静默」分三级打印（不改基线、不判红绿）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { stripRust, stripCfgTest } from "./check-panic-sites.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src-tauri", "src");
const BASELINE = join(ROOT, "scripts", "silent-drops-baseline.json");

const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");
const SELF_TEST = args.has("--self-test");
const REPORT = args.has("--report");

/**
 * 语句形式的 `.ok();`：**丢了就没人看的那些**。
 * 含 `let _ = x.ok();`（同样是把失败扔掉），不含 `x.ok()?`（会传播）与
 * `x.ok().flatten()` / `if x.ok().is_some()`（值还被用到）。
 */
const STATEMENT_OK = /\.ok\(\)\s*;/g;

/** 不许再以 `.ok();` 出现的「托着承诺」的写（见文件头第 1 条）。 */
const HARD_ZERO = /(set_message_status|set_message_failed|apply_recall)\s*\(/;

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 站点所在的那条语句（往回切到上一个 `;` / `{` / `}`），压成一行便于报错。 */
function statementAt(clean, index) {
  let start = index;
  while (start > 0 && !";{}".includes(clean[start - 1])) start--;
  return clean.slice(start, index + ".ok();".length).replace(/\s+/g, " ").trim();
}

/** 分析一段 Rust 源码，返回生产块的 `.ok();` 站点。 */
export function analyzeSilentDrops(src) {
  const clean = stripCfgTest(stripRust(src));
  const sites = [];
  for (const m of clean.matchAll(STATEMENT_OK)) {
    sites.push({
      line: lineAt(clean, m.index),
      stmt: statementAt(clean, m.index),
      hardZero: HARD_ZERO.test(statementAt(clean, m.index)),
    });
  }
  return { count: sites.length, sites };
}

function walkRust(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name.endsWith(".rs") && !name.endsWith("_tests.rs") && name !== "tests.rs") out.push(p);
    }
  }
  return out.sort();
}

function runSelfTest() {
  const cases = [
    ["语句形式", `fn f() { db::x(); a().ok(); }`, 1],
    ["注释里的不算", `// a().ok();\nfn f() {}`, 0],
    ["字符串里的不算", `fn f() { let s = "a().ok();"; }`, 0],
    ["块注释里的不算", `/* a().ok(); */ fn f() {}`, 0],
    ["`?` 传播是另一族", `fn f() -> Result<(),E> { a().ok()?; Ok(()) }`, 0],
    ["链式使用不算丢弃", `fn f() { if a().ok().is_some() {} }`, 0],
    ["`let _ = …ok();` 同样是丢掉失败", `fn f() { let _ = a().ok(); }`, 1],
    ["测试块不算", `#[cfg(test)]\nmod t { fn a() { x().ok(); } }\nfn b() {}`, 0],
    ["cfg(all(test, desktop)) 也算测试块", `#[cfg(all(test, desktop))]\nmod t { fn a() { x().ok(); } }\nfn b() {}`, 0],
    ["多行链也一样计数", `fn f() { db::y(\n  1,\n).ok(); }`, 1],
  ];
  for (const [name, src, want] of cases) {
    const got = analyzeSilentDrops(src).count;
    assert.equal(got, want, `自检失败：${name} 期望 ${want} 实得 ${got}`);
  }
  // 硬零那三个写必须被认出来（否则第 1 层形同虚设）
  for (const fn of ["set_message_status", "set_message_failed", "apply_recall"]) {
    const hit = analyzeSilentDrops(`fn f() { db::${fn}(c, 1).ok(); }`).sites;
    assert.equal(hit.length, 1, `自检失败：${fn} 的 .ok(); 没被识别`);
    assert.ok(hit[0].hardZero, `自检失败：${fn} 没被标成硬零族`);
  }
  // 反控：普通 db 写不算硬零（否则硬零等于全表，改一处就红，没人会去清）
  assert.equal(analyzeSilentDrops(`fn f() { db::add_friend(c).ok(); }`).sites[0].hardZero, false);
  console.log(`✓ 自检通过：${cases.length + 4} 条正反控`);
}

function main() {
  if (SELF_TEST) {
    runSelfTest();
    return 0;
  }
  const files = walkRust(SRC);
  assert.ok(files.length > 50, `只扫到 ${files.length} 个生产文件 ⇒ 目录变了`);
  const counts = {};
  const hardZero = [];
  for (const p of files) {
    const rel = p.slice(SRC.length + 1);
    const { count, sites } = analyzeSilentDrops(readFileSync(p, "utf8"));
    if (count > 0) counts[rel] = count;
    for (const s of sites) {
      if (s.hardZero) hardZero.push(`${rel}:${s.line}  ${s.stmt}`);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (hardZero.length > 0) {
    console.error("✗ 这些「托着承诺」的写被 `.ok()` 丢掉了（硬零族，清过就不许回来）：");
    for (const h of hardZero) console.error(`    ${h}`);
    return 1;
  }

  if (REPORT) {
    // 三级口径（**判断**，不是闸）：写库承诺 / 尽力而为的文件与 pragma / 其余。
    // 读函数的 `.ok();` 极罕见（放在这里就是"其余"），真要清的时候逐条读实现。
    const READ = /\bdb::(get_|list_|find_|count_|is_|has_|latest_)/;
    const PROMISE = /\bdb::[a-z_]+\s*\(/;
    const BEST_EFFORT = /(std::fs::|\bfs::|pragma_update|canonicalize)/;
    const level = (stmt) =>
      READ.test(stmt) ? "L3-其它" : PROMISE.test(stmt) ? "L1-写库承诺" : BEST_EFFORT.test(stmt) ? "L2-尽力而为" : "L3-其它";
    const byLevel = { "L1-写库承诺": [], "L2-尽力而为": [], "L3-其它": [] };
    for (const p of files) {
      const rel = p.slice(SRC.length + 1);
      for (const site of analyzeSilentDrops(readFileSync(p, "utf8")).sites) {
        byLevel[level(site.stmt)].push(`${rel}:${site.line}  ${site.stmt}`);
      }
    }
    for (const [name, rows] of Object.entries(byLevel)) {
      console.log(`${name}：${rows.length} 处`);
      for (const r of rows) console.log(`    ${r}`);
    }
    return 0;
  }

  if (UPDATE) {
    writeFileSync(
      BASELINE,
      JSON.stringify(
        {
          generatedBy: "scripts/check-silent-drops.mjs --update",
          note: "语句形式 `.ok();` 的每文件计数；棘轮只许降。硬零族见脚本头。",
          total,
          files: counts,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✓ 已更新 ${BASELINE}（${Object.keys(counts).length} 个文件，共 ${total} 处）`);
    return 0;
  }

  assert.ok(existsSync(BASELINE), `缺少基线 ${BASELINE}；先跑 --update`);
  const base = JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
  let failures = 0;
  for (const [rel, n] of Object.entries(counts)) {
    const b = base[rel] ?? 0;
    if (n > b) {
      failures += 1;
      console.error(`✗ ${rel} 的 \`.ok();\` 从 ${b} 涨到 ${n}（棘轮只许降）：`);
      for (const s of analyzeSilentDrops(readFileSync(join(SRC, rel), "utf8")).sites) {
        console.error(`    ${rel}:${s.line}  ${s.stmt}`);
      }
    }
  }
  if (failures > 0) {
    console.error(`\n静默丢弃检查失败：${failures} 个文件涨了。`);
    return 1;
  }
  const baseTotal = Object.values(base).reduce((a, b) => a + b, 0);
  console.log(
    `✓ 静默丢弃棘轮：语句形式 \`.ok();\` 共 ${total} 处（${Object.keys(counts).length} 个生产文件，` +
      `基线 ${baseTotal}，硬零族 0）—— 只降不升`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
