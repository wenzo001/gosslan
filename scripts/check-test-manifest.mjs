#!/usr/bin/env node
/**
 * 测试清单守卫（test manifest guard）—— 挡住「测试静默不跑」。
 *
 * ## 为什么要有这个脚本
 *
 * 本项目有 455 条前端断言 + 503 条 Rust 用例 + 87 条非空转护栏。但**没有任何东西
 * 保证它们真的被执行**。已经真实发生过一次（见 `scripts/verify-guards.py` 里
 * 「`cargo test --features bluetooth <名>` 一个测试都不会跑、退出码 0」那条记录）：
 *
 *   · `bluetooth` 是**非默认 feature**（`src-tauri/Cargo.toml` 的 `[features]`）。
 *     漏掉 `--features bluetooth` ⇒ BLE 相关模块根本不编译 ⇒ 那 20 条用例
 *     连同被测代码一起消失，而 `cargo test` **全绿**。
 *   · 前端 `npm test` 的脚本里是**手工枚举**的 48 条路径。新增测试文件若忘了
 *     加进那串字符串，新文件不会跑，而 `npm test` 依然**全绿**。
 *
 * 两种都是「退出码 0 的空转」——最危险的那类故障：没有任何信号。
 *
 * ## 为什么是「比对名字」而不是「比对数量」
 *
 * 数量阈值（比如 `>= 503`）会产生反向激励：为了凑数而保留已经没有价值的测试，
 * 而删除一个过时测试反而要改阈值。名字比对没有这个问题：
 *
 *   · 缺名（基线里有、实际没跑） → **FAIL** —— 这正是「静默跳过」，必须拦。
 *   · 多名（基线里没有、实际跑了）→ **WARN** —— 新测试跑得好好的，不是故障；
 *     打印出来提示跑 `--update` 把基线补齐即可（补齐后它才进入保护范围）。
 *
 * 判据方向刻意不对称：只对「少了」红脸，不对「多了」红脸。
 *
 * ## 基线必须按平台分开（否则会误报，把真失败淹掉）
 *
 * 有一部分用例是**平台门控**的 —— 本仓库实测：
 *
 *   · `transport/bluetooth_peripheral.rs`（macOS 外设）     5 条用例
 *   · `transport/bluetooth_peripheral_windows.rs`（Windows）2 条用例
 *
 * 这两个文件是 `#[cfg(all(feature = "bluetooth", target_os = "…"))]`。于是
 * **macOS 上的基线拿到 Windows 用，那 5 条会被判成「静默跳过」** —— 纯误报。
 * `scripts/verify-guards.py` 的 `platforms` 字段就是为同一个坑加的，它的注释写着：
 *
 *   > 正确做法是**显式跳过并说清楚**，而不是留一堆假失败把真失败淹掉。
 *
 * 所以基线按平台分文件：`test-baseline.<macos|windows|linux>.txt`。
 * 拿到本平台没有基线时**不猜、不退化**，直接报错让你用 `--update` 生成。
 *
 * ## 用法
 *
 *     node scripts/check-test-manifest.mjs                  # 全部检查
 *     node scripts/check-test-manifest.mjs --only frontend  # 只查前端（秒级，无需编译）
 *     node scripts/check-test-manifest.mjs --only rust      # 只查 Rust（需编译）
 *     node scripts/check-test-manifest.mjs --update         # 用当前实际名单重写**本平台**基线
 *
 * 退出码：0 = 通过；1 = 有测试静默消失了。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI = path.join(ROOT, "src-tauri");

/** Node 的平台名 → Rust 的 `target_os`（基线文件名用它）。 */
const RUST_OS = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform];
if (!RUST_OS) {
  console.error(`✗ 未知平台 ${process.platform}：本脚本只认 darwin / win32 / linux。`);
  console.error("  新平台请先确认基线该怎么分（见文件头「基线必须按平台分开」）。");
  process.exit(1);
}
const BASELINE = path.join(TAURI, `test-baseline.${RUST_OS}.txt`);

/** Rust 侧固定用这一组参数 —— 与 CI / verify 入口必须一致。 */
const RUST_ARGS = ["test", "--features", "bluetooth", "--lib", "--", "--list"];

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 ? argv[i + 1] : null;
})();
const update = argv.includes("--update");

if (only && only !== "frontend" && only !== "rust") {
  console.error(`✗ --only 只接受 frontend / rust，收到「${only}」`);
  process.exit(1);
}

const runFrontend = !only || only === "frontend";
const runRust = !only || only === "rust";

/** 递归收集 `src` 下所有 `.test.ts`。 */
function collectFrontendTests(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFrontendTests(p, acc);
    else if (e.name.endsWith(".test.ts")) acc.push(path.relative(ROOT, p));
  }
  return acc;
}

/**
 * 前端：`npm test` 脚本里手工枚举的路径 ⋈ 磁盘上真实存在的测试文件。
 *
 * 只报「磁盘有、脚本没列」（会被静默跳过）。反向（脚本列了但文件不存在）
 * `node --test` 自己会报错，不必在这里重复拦。
 */
function checkFrontend() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const listed = new Set(
    pkg.scripts.test.split(/\s+/).filter((t) => t.endsWith(".test.ts")),
  );
  const onDisk = collectFrontendTests(path.join(ROOT, "src"));
  const skipped = onDisk.filter((f) => !listed.has(f));

  if (skipped.length === 0) {
    console.log(`✓ 前端测试清单：磁盘 ${onDisk.length} 个文件全部已登记（不会静默跳过）`);
    return true;
  }
  console.error(`✗ 前端有 ${skipped.length} 个测试文件存在但未登记进 package.json 的 test 脚本；`);
  console.error("  它们不会被执行，而 `npm test` 依然全绿：");
  for (const f of skipped) console.error(`    · ${f}`);
  console.error("  修法：把上面每个路径追加进 package.json 的 scripts.test。");
  return false;
}

/** 解析 `cargo test -- --list` 的输出：`<用例名>: test`。 */
function rustTestNames() {
  const out = execFileSync("cargo", RUST_ARGS, {
    cwd: TAURI,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((l) => l.match(/^(.+): test$/)?.[1])
    .filter(Boolean)
    .sort();
}

/**
 * Rust：基线名单 ⋈ 实际 `--list`。
 *
 * 缺名必须红 —— 那意味着某个 feature 没开、某个 `mod` 没挂进 `mod.rs`、
 * 或某个 `#[cfg]` 没满足，被测代码连同测试一起消失了。
 */
function checkRust() {
  let actual;
  try {
    actual = rustTestNames();
  } catch (e) {
    console.error("✗ 无法取得 Rust 测试名单（cargo 失败）：");
    console.error(`  ${e.stderr || e.message}`);
    return false;
  }

  if (update) {
    writeFileSync(BASELINE, actual.join("\n") + "\n");
    console.log(
      `✓ 已更新 ${path.relative(ROOT, BASELINE)}（${actual.length} 条用例，平台 ${RUST_OS}）`,
    );
    return true;
  }

  if (!existsSync(BASELINE)) {
    // ⚠️ 这里**故意不自动创建**：若在缺失时静默生成基线，等于"没有基线也算通过"，
    // 正是本脚本要消灭的那类空转（新平台第一次跑会假绿）。
    console.error(`✗ 本平台（${RUST_OS}）没有基线文件：${path.relative(ROOT, BASELINE)}`);
    console.error("  基线必须按平台分开（macOS 外设 / Windows 外设是互斥的 #[cfg]）——");
    console.error("  拿别的平台的基线来比会把平台门控的用例误判成「静默跳过」。");
    console.error("  首次建立本平台基线：node scripts/check-test-manifest.mjs --update");
    return false;
  }

  const baseline = readFileSync(BASELINE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).sort();
  const actualSet = new Set(actual);
  const baselineSet = new Set(baseline);

  const missing = baseline.filter((n) => !actualSet.has(n));
  const added = actual.filter((n) => !baselineSet.has(n));

  let ok = true;

  if (missing.length > 0) {
    ok = false;
    console.error(`✗ 基线里的 ${missing.length} 条用例**没有跑**（静默跳过）：`);
    for (const n of missing) console.error(`    · ${n}`);
    console.error("  常见原因：漏了 `--features bluetooth`、模块没挂进 mod.rs、");
    console.error("           #[cfg] 条件不满足（例如平台门控）。");
  }

  if (added.length > 0) {
    console.warn(`⚠ 有 ${added.length} 条新用例不在基线里（它们**会跑**，只是尚未纳入保护）：`);
    for (const n of added) console.warn(`    · ${n}`);
    console.warn("  跑 `node scripts/check-test-manifest.mjs --update` 把它们纳入。");
  }

  if (ok) {
    console.log(
      `✓ Rust 测试清单：基线 ${baseline.length} 条全部在跑` +
        (added.length ? `（另有 ${added.length} 条新用例待纳入）` : ""),
    );
  }
  return ok;
}

const results = [];
if (runFrontend) results.push(checkFrontend());
if (runRust) results.push(checkRust());

if (results.every(Boolean)) {
  console.log("\n测试清单守卫通过。");
  process.exit(0);
}
console.error("\n测试清单守卫失败：有测试静默消失了。");
process.exit(1);
