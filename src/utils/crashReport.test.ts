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
  assert.equal(shouldShowCrashNotice("clean"), false);
  assert.equal(shouldShowCrashNotice("no_history"), false);
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
