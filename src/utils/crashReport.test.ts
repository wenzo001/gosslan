import assert from "node:assert/strict";
import test from "node:test";
import { formatCrashReport, shouldShowCrashNotice } from "./crashReport.ts";
import type { PreviousRunReport } from "@/types";

const report: PreviousRunReport = {
  kind: "panic",
  code: "BOOT_PREV_PANIC",
  at: "2026-10-25 10:37:38",
  version: "5.10.1",
  panic: {
    location: "vendor/btleplug/src/corebluetooth/internal.rs:351:17",
    message: "We should still have a future at this point!",
  },
  hang: null,
  recentPanicCount: 3,
  bleSuspect: true,
  crashLog: "/tmp/logs/gosslan-crash.log",
  logDir: "/tmp/logs",
};

test("复制文本带 code/位置/版本/现场路径", () => {
  const s = formatCrashReport(report);
  assert.match(s, /code: BOOT_PREV_PANIC/);
  assert.match(s, /internal\.rs:351:17/);
  assert.match(s, /version: 5\.10\.1/);
  assert.match(s, /ble_suspect: true/);
  assert.match(s, /crash_log: \/tmp\/logs\/gosslan-crash\.log/);
});

test("只有异常/启动中止才提示；正常退出不打扰", () => {
  assert.equal(shouldShowCrashNotice("panic"), true);
  assert.equal(shouldShowCrashNotice("silent_kill"), true);
  assert.equal(shouldShowCrashNotice("startup_failed"), true);
  // 分配器 abort：有现场（请求字节数）但没有崩溃块，是"真死"的一类 ⇒ 必须提示
  assert.equal(shouldShowCrashNotice("abort"), true);
  // 进了事件循环却没到 logger：真实异常（环境没就绪或被结束）⇒ 提示
  assert.equal(shouldShowCrashNotice("early_exit"), true);
  assert.equal(shouldShowCrashNotice("clean"), false);
  assert.equal(shouldShowCrashNotice("no_history"), false);
  // 被外部 kill -TERM：信号被捕获、走了正常退出流程 ⇒ 不是事故，不弹横幅
  //（弹了就是把一次外部终止说成崩溃 —— 假指控）。码仍在报告里，可查可溯。
  assert.equal(shouldShowCrashNotice("sigterm"), false);
  // 2026-11-08（用户口径「我们主动结束不许与被外部杀死混用」）：
  // 更新安装器接管、单实例交接都是**正常路径**，弹横幅等于把正常流程说成事故。
  // 2026-11-09 扩充：`updater` 这一格现在也覆盖**安装器强杀**（覆盖安装 / 卸载时安装器写的
  // `INSTALLER_TAKEOVER`）以及安装器路标兜底 —— 升级后首次启动不该弹这个框。
  assert.equal(shouldShowCrashNotice("updater"), false);
  assert.equal(shouldShowCrashNotice("single_instance"), false);
});

test("报告把起点与结束时刻分开写", () => {
  // 2026-11-08 用户把报告里的 `time: 10:21:50` 读成了「10:21 那次结束」，
  // 而它其实是那一轮的**启动**时刻（结束在 10:53 之后）⇒ 两个字段必须分开。
  const s = formatCrashReport({ ...report, lastSeenAt: "2026-10-25 11:02:13" });
  assert.match(s, /started_at: 2026-10-25 10:37:38/);
  assert.match(s, /last_seen: 2026-10-25 11:02:13/);
  // 反例：含混的 `time:` 那一行不许再出现（它正是被误读的那一行）。
  assert.doesNotMatch(s, /^time: /m);
});

test("环境类崩溃带原因码；没有证据时不写", () => {
  const env = formatCrashReport({
    ...report,
    bleSuspect: false,
    reason: "ENV_WEBVIEW_CREATE_TIMEOUT",
  });
  assert.match(env, /reason: ENV_WEBVIEW_CREATE_TIMEOUT/);
  // 反例：后端没给归因码 ⇒ 不许凭空补一行（那会把"不知道"说成"知道"）。
  assert.doesNotMatch(formatCrashReport({ ...report, reason: null }), /reason:/);
});

test("卡死记录也进复制文本（未配对时附在报告里）", () => {
  const s = formatCrashReport({
    ...report,
    kind: "silent_kill",
    panic: null,
    hang: { seconds: 42, lastOp: "send_message", ended: false },
  });
  assert.match(s, /hang: 42s last_op=send_message ended=false/);
});
