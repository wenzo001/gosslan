/**
 * 「这条 `sending` 到底是在发，还是在等对端上线」的判据（纯函数，可单测）。
 *
 * 为什么需要它：对端离线时消息会留在离线队列里等（`OUTBOX_OFFLINE_HOLD_MS` = 7 天，
 * 日志里的 `reason=peer_offline(hold_7d)`）。这期间 `messages.status` 一直是 `sending`，
 * 界面就一直是「转圈」—— 2026-10-29 真机现场实测有消息这样挂了 27 小时，
 * 用户看到的是"卡住了"。这里只做**可见文案**的判据，数据层状态一律不动。
 */

/** 超过这么久还停在 sending，就不再假装"正在发"。 */
export const WAITING_FOR_PEER_AFTER_MS = 2 * 60_000;

/**
 * 文件类消息在整个传输期间本来就是 `sending`（`file-{transfer_id}` / `gfile-{transfer_id}`），
 * 大文件传十分钟是正常的 —— 按时间判"在等对端"会把它误标。
 * 前缀与后端 `recover_orphan_sending_messages` 的排除谓词同一口径。
 */
export function isTransferBacked(msgId: string | null | undefined): boolean {
  const id = msgId ?? "";
  return id.startsWith("file-") || id.startsWith("gfile-");
}

export function isWaitingForPeer(
  input: { status: string; ts: number; msgId?: string | null },
  now: number,
): boolean {
  if (input.status !== "sending") return false;
  if (isTransferBacked(input.msgId)) return false;
  if (!(input.ts > 0)) return false;
  return now - input.ts >= WAITING_FOR_PEER_AFTER_MS;
}
