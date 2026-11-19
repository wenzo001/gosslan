/**
 * `scripts/cargo-clean.mjs` 的**纯逻辑**判据。
 *
 * 这条判据存在的理由：Windows 上 `cargo clean` 会被 IDE 的 proc-macro 宿主卡住
 * （已加载的 DLL 不能删 ⇒ os error 5 ⇒ 删一半 ⇒ 下一次构建报 LNK1104）。
 * 那条诊断信息必须**说清「谁占着、怎么办」**，否则每次都要重新查一遍进程表。
 *
 * 只测纯函数（不碰真进程）：解析、判定、文案三样都可离线验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  diagnose,
  isAccessDeniedFailure,
  parseProcMacroServerPids,
  PROC_MACRO_SERVER,
} from "./cargo-clean.mjs";

test("解析 tasklist 输出：只认目标进程名 + 纯数字 PID", () => {
  const text = [
    `Image Name                     PID Session Name        Session#       Mem Usage`,
    `${PROC_MACRO_SERVER}.exe                   6016 Console                    1      10,000 K`,
    `${PROC_MACRO_SERVER}.exe                  43696 Console                    1      12,000 K`,
    `rustc.exe                                  44504 Console                    1      80,000 K`,
    `notepad.exe                                9999 Console                    1       2,000 K`,
  ].join("\r\n");
  assert.deepEqual(parseProcMacroServerPids(text), [6016, 43696]);
});

test("解析 tasklist 输出：空输入 / 认不出的形状 ⇒ 空数组（宁可少报也不误报）", () => {
  assert.deepEqual(parseProcMacroServerPids(""), []);
  assert.deepEqual(parseProcMacroServerPids(undefined), []);
  // 进程名对但 PID 不是数字 ⇒ 不认
  assert.deepEqual(
    parseProcMacroServerPids(`${PROC_MACRO_SERVER}.exe                   N/A Console  1  10,000 K`),
    [],
  );
});

test("「被占用」只认 Windows 那几种形状（os error 5 / 拒绝访问 / access is denied）", () => {
  assert.equal(isAccessDeniedFailure("Caused by:\n  拒绝访问。 (os error 5)"), true);
  assert.equal(isAccessDeniedFailure("error: linking with `link.exe` failed: Access is denied"), true);
  // 别的失败不许被当成「被占用」（否则诊断会指错方向）
  assert.equal(isAccessDeniedFailure("error: could not compile `futures-util` (lib)"), false);
  assert.equal(isAccessDeniedFailure("页面文件太小，无法完成操作。 (os error 1455)"), false);
});

test("诊断文案必须说到点子上：占用者是谁、为什么会卡、怎么解", () => {
  const text = diagnose([6016, 43696]);
  assert.ok(text.includes("6016") && text.includes("43696"), "要报出 PID");
  assert.ok(text.includes(PROC_MACRO_SERVER), "要报出占用的进程名");
  assert.ok(text.includes("os error 5"), "要说到 cargo clean 的真实报错");
  assert.ok(text.includes("LNK1104"), "要说到下一次构建会看到的假故障");
  assert.ok(text.includes("--force"), "要给出可执行的解法");
});

test("没有占用者时：文案不许编造进程（也不许甩锅给 IDE）", () => {
  const text = diagnose([]);
  assert.ok(!text.includes(PROC_MACRO_SERVER), "没有占用者就不许提进程名");
  assert.ok(text.includes("cargo clean"), "仍要说清下一步是重跑清理");
});
