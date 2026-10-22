/**
 * 撤回窗口的唯一前端口径。
 *
 * Rust 侧 `protocol.rs::RECALL_WINDOW_MS` 是权威；`recall.test.ts` 直接读源码对账，
 * 不允许两边各写一个 5 分钟然后慢慢漂。
 */
export const RECALL_WINDOW_MS = 5 * 60 * 1000;

/** 消息是否还在可撤回窗口内（`ts=0` 的历史行不显示入口）。 */
export function isWithinRecallWindow(ts: number, now = Date.now()): boolean {
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return now - ts <= RECALL_WINDOW_MS;
}
