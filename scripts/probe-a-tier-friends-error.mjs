#!/usr/bin/env node
/**
 * A 档错误态的**真窗口**验收（手动探针，不进门禁）。
 *
 * 为什么需要它：A 档 6 格的判据都是源码/变异级的（后端不许折回空、前端要有 `role="alert"`），
 * 但「读失败时界面到底画的是哪一句话」只有真窗口能证明。这里用**隔离 HOME + 高位实例号**
 * （绝不碰用户自己的库），造一个"好友表读不出来"的真结局，读无障碍树对排：
 *
 *   ① 控制组：正常库 ⇒ 空态文案「还没有好友…」在，错误提示**不在**；
 *   ② 实验组：把 `friends` 的 `nickname` 列删掉（`CREATE TABLE IF NOT EXISTS` 不会修列）
 *      ⇒ 错误提示「这次没能从本机读到好友列表（不代表没有好友）…」在，空态文案**不在**。
 *
 * 两种结局必须**互斥**：只在一边出现才算过。
 *
 * 用法：`node scripts/probe-a-tier-friends-error.mjs`
 * 前置：`src-tauri/target/release/gosslan` 已按当前源码构建；本进程有「辅助访问」权限。
 * 退出码：0 = 两种结局分开了；1 = 没分开 / 读不到窗口；2 = 环境不具备。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { probeTree, ensureHelper, axEnvironmentReady } from "./ax-tree.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "src-tauri", "target", "release", "gosslan");
const INSTANCE = "9";
const EMPTY_HINT = "还没有好友";
const ERROR_HINT = "这次没能从本机读到好友列表";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(BIN)) {
  console.error(`✗ 找不到 release 二进制：${BIN}（先 cargo build --release --features bluetooth）`);
  process.exit(2);
}
const env = axEnvironmentReady();
if (!env.ready) {
  console.error(`✗ 环境不具备：${env.problems.join("；")}`);
  process.exit(2);
}
ensureHelper();

const home = path.join(os.tmpdir(), `gosslan-a-tier-${Date.now()}`);
mkdirSync(home, { recursive: true });

async function bootAndRead(tag) {
  const p = spawn(BIN, [], {
    env: { ...process.env, HOME: home, GOSSLAN_INSTANCE: INSTANCE, GOSSLAN_AUTOSTART: "1" },
    stdio: "ignore",
  });
  let tree = null;
  try {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const t = probeTree(p.pid);
        if (t?.parsed?.webArea > 0) {
          tree = t;
          break;
        }
      } catch {
        /* 窗口还没挂上 */
      }
    }
    const labels = (tree?.parsed?.names ?? []).map((n) => n.label ?? "").join("\n");
    console.log(
      `[${tag}] webArea=${tree?.parsed?.webArea ?? 0} total=${tree?.parsed?.total ?? 0} ` +
        `空态=${labels.includes(EMPTY_HINT)} 错误提示=${labels.includes(ERROR_HINT)}`,
    );
    return labels;
  } finally {
    p.kill("SIGTERM");
    for (let i = 0; i < 20 && p.exitCode === null; i++) await sleep(250);
    if (p.exitCode === null) p.kill("SIGKILL");
    await sleep(500);
  }
}

function findDb(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findDb(full);
      if (hit) return hit;
    } else if (e.name.endsWith(".db")) {
      return full;
    }
  }
  return null;
}

let code = 1;
try {
  const control = await bootAndRead("控制组·正常库");
  const db = findDb(path.join(home, "Library", "Application Support", "com.gosslan.app"));
  if (!db) throw new Error("隔离 HOME 下没有生成数据库");

  // ⚠️ 不能 DROP TABLE：启动时 `CREATE TABLE IF NOT EXISTS` 会把它重建回来（实测）。
  // 删一列则不会被修 —— 这是"表在、读不出来"的最小真实形状。
  execFileSync("sqlite3", [db, "ALTER TABLE friends DROP COLUMN nickname;"]);
  console.log("[注入] 已删 friends.nickname（表还在 ⇒ 读 SELECT 会失败）");

  const experiment = await bootAndRead("实验组·缺列");

  const ok =
    control.includes(EMPTY_HINT) &&
    !control.includes(ERROR_HINT) &&
    experiment.includes(ERROR_HINT) &&
    !experiment.includes(EMPTY_HINT);
  if (ok) {
    console.log("\n✓ 空态与错误态在真窗口里**互斥地**分开了");
    code = 0;
  } else {
    console.error("\n✗ 两种结局没有分开（见上面两行读数）");
    code = 1;
  }
} catch (e) {
  console.error(`✗ 探针失败：${e.message}`);
  code = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(code);
