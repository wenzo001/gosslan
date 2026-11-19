#!/usr/bin/env node
/**
 * `cargo clean` 的**Windows 版**（2026-11-19 新增）。
 *
 * ## 为什么需要它
 *
 * Windows 上「已加载的 DLL 不能被删除」：IDE 的 `rust-analyzer-proc-macro-srv`
 * 会把 `target/debug/build/<crate>/out/*.dll`（proc-macro 动态库）**加载进自己的进程**，
 * 于是：
 *
 *   1. `cargo clean` 报 `Caused by: 拒绝访问。 (os error 5)`，只删掉一部分；
 *   2. 残留的 `out/` 目录是**半残**的 ⇒ 下一次 `cargo test` 在链接阶段报
 *      `LINK : fatal error LNK1104: 无法打开文件 …\async_trait-….dll`
 *      （看着像"环境坏了"，其实是上一轮没删干净）。
 *
 * 真机连踩三次（每次都要重新全量编译十几分钟），所以这里把它变成一条**可重复的命令**。
 *
 * ## 用法
 *
 *     node scripts/cargo-clean.mjs            # 只检测并给出诊断（不动 IDE 进程）
 *     node scripts/cargo-clean.mjs --force    # 先结束占用者，再清
 *
 * `--force` 结束的是 `rust-analyzer-proc-macro-srv`（IDE 的辅助进程，IDE 会自己重启它），
 * **不会**结束 IDE 本体，也不会动任何源码或用户数据。
 *
 * ## 纯逻辑可测
 *
 * `parseProcMacroServerPids` / `diagnose` 是纯函数（不碰进程），单测直接吃
 * （见 `scripts/cargoClean.test.ts`）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");

/** 占用 proc-macro DLL 的那个进程名（IDE 的 rust-analyzer 辅助进程）。 */
export const PROC_MACRO_SERVER = "rust-analyzer-proc-macro-srv";

/**
 * 从 `tasklist` 的输出里挑出目标进程的行。
 *
 * 纯函数：只认「进程名 + PID」这一种形状（`tasklist /NH` 的输出长这样：
 * `rust-analyzer-proc-macro-srv.exe   1234 Console  1  10,000 K`）。
 * 认不出就返回空数组 —— 判据是「宁可少报也不误报」。
 */
export function parseProcMacroServerPids(text) {
  const pids = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    // 第一列是进程名（可能带 .exe），第二列必须是纯数字 PID。
    if (!cols[0] || !cols[0].toLowerCase().startsWith(PROC_MACRO_SERVER)) continue;
    if (!cols[1] || !/^\d+$/.test(cols[1])) continue;
    pids.push(Number(cols[1]));
  }
  return pids;
}

/** 这一行到底是不是「被占用」那类失败（Windows 专有的形态）。 */
export function isAccessDeniedFailure(stderrText) {
  const t = String(stderrText ?? "").toLowerCase();
  return t.includes("os error 5") || t.includes("拒绝访问") || t.includes("access is denied");
}

/** 给人的诊断文案（纯函数，便于单测钉住「必须说到点子上」）。 */
export function diagnose(pids, { force = false } = {}) {
  if (pids.length === 0) {
    return [
      "没有发现占用编译产物的 IDE 进程。",
      "若 `cargo clean` 仍报 os error 5：先关掉正在运行的 IDE（它会重新加载 proc-macro DLL），再重试。",
    ].join("\n");
  }
  const head = `发现 ${pids.length} 个 ${PROC_MACRO_SERVER} 进程（PID ${pids.join(", ")}）正在加载 target/ 里的 proc-macro DLL。`;
  if (!force) {
    return [
      head,
      "Windows 上「已加载的 DLL 不能被删除」⇒ `cargo clean` 会删一半就报 os error 5，",
      "残留的半残目录会让下一次构建在链接阶段报 LNK1104（看着像环境坏了，其实是上一轮没删干净）。",
      "",
      "解决：先结束这些进程（IDE 会自己重启它们），再重跑清理：",
      `    node scripts/cargo-clean.mjs --force`,
    ].join("\n");
  }
  return [
    head,
    "已结束这些进程（IDE 会自己重启它们）。",
  ].join("\n");
}

function listPids() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("tasklist", ["/NH", "/FI", `IMAGENAME eq ${PROC_MACRO_SERVER}.exe`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return parseProcMacroServerPids(out);
  } catch {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    } catch {
      // 结束失败不算致命：后面的 cargo clean 会把真实错误说出来。
    }
  }
}

function main() {
  const force = process.argv.slice(2).includes("--force");
  const pids = listPids();
  if (pids.length > 0) {
    if (force) {
      killPids(pids);
    }
    console.log(diagnose(pids, { force }));
  }

  if (!existsSync(TAURI_DIR)) {
    console.error(`找不到 ${TAURI_DIR}（在仓库根运行？）`);
    return 1;
  }
  const res = spawnSync("cargo", ["clean"], {
    cwd: TAURI_DIR,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (out.trim()) console.log(out.trim());
  if (res.status !== 0) {
    if (isAccessDeniedFailure(out)) {
      console.error("");
      console.error(diagnose(pids, { force: false }));
    }
    return res.status ?? 1;
  }
  console.log("✓ target 已清空。");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
