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

/**
 * **可撤回**的消息类型（与 Rust `protocol::RECALLABLE_KINDS` 同一份口径）。
 *
 * 2026-10-28 负责人改口径：「5 分钟内的消息必须能撤回，所有文件格式类型都要支持」。
 * 附件（`image` / `file`，覆盖视频/音频/文档等全部格式）也在内 —— 当初排除它们的理由
 * （撤回停不掉传输）已由后端 `cancel_transfer_for_recalled_message` 消掉：撤回前先取消传输。
 * 机器事件（pin / reaction / todo / announcement…）不是用户写的内容，仍然不在内。
 *
 * 两侧都要拦：老端可能没拦、直接发来一条对附件消息的撤回 ⇒ Rust 那侧还要再判一次。
 */
export const RECALLABLE_KINDS: readonly string[] = ["text", "code", "merge", "image", "file"];

/** 这种消息能不能撤回（唯一定义处，见上面的理由）。 */
export function isRecallableKind(kind: string | undefined | null): boolean {
  return !!kind && RECALLABLE_KINDS.includes(kind);
}
