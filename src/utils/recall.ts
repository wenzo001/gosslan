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
 * 为什么不写"除了 file 都能撤"：撤回只改消息行，它不会停掉正在跑的文件传输 ——
 * 对着一条还在传的文件按撤回，会得到"气泡变已撤回、字节照样在发"。文件/图片那一族的
 * 正确动作是取消（`cancel_file_transfer` / `FileCancel` 帧），所以这里用白名单。
 * 合并转发（merge）是一段可重放的正文，按文本对待。
 *
 * 两侧都要拦：老端可能没拦、直接发来一条对文件消息的撤回 ⇒ Rust 那侧还要再判一次。
 */
export const RECALLABLE_KINDS: readonly string[] = ["text", "code", "merge"];

/** 这种消息能不能撤回（唯一定义处，见上面的理由）。 */
export function isRecallableKind(kind: string | undefined | null): boolean {
  return !!kind && RECALLABLE_KINDS.includes(kind);
}
