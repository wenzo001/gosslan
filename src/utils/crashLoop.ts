/**
 * 蓝牙自动开启的熔断判定（纯逻辑）。
 *
 * 规则（用户 2026-10-25 拍板）：
 * - 手动入口永远放行（用户明确要用）；
 * - 上一轮报告说"崩在蓝牙"⇒ 本次自动路径不拉起；
 * - **报告读不到 / 超时 ⇒ fail-closed**：也不拉起。熔断器失效的代价是继续崩溃循环，
 *   而"蓝牙没自动开"只是一个开关状态，用户点一下就能开。
 */
export interface BleAutostartReportLike {
  bleSuspect: boolean;
}

export interface BleAutostartInput {
  manual: boolean;
  /** `RuntimeSnapshot.bleAutostartHeld`：后端已经判定要暂停时给的原因文本。 */
  heldReason: string | null;
  /** 上一轮报告；`null` = 超时/读取失败。 */
  report: BleAutostartReportLike | null;
  /** 调用方是否已经明确知道"读不到"（用于区分 pending 与 unreadable，仅影响日志文案）。 */
  reportUnreadable: boolean;
}

export interface BleAutostartDecision {
  start: boolean;
  /** 不启动时的原因码（写日志用）。 */
  reason: string | null;
}

export function decideBleAutostart(input: BleAutostartInput): BleAutostartDecision {
  if (input.manual) return { start: true, reason: null };
  if (input.heldReason) return { start: false, reason: input.heldReason };
  if (!input.report) {
    return {
      start: false,
      reason: input.reportUnreadable ? "report_unreadable" : "report_pending",
    };
  }
  if (input.report.bleSuspect) return { start: false, reason: "ble_suspect" };
  return { start: true, reason: null };
}
