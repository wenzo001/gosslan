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
  input: {
    status: string;
    ts: number;
    msgId?: string | null;
    /**
     * 会话对端的在线状态（J2-5，旅程走查 2026-11-20）：`null` = 无在线概念
     * （群 / 机器人 / 自己 / 查不到）；`false` = **明确**离线。
     * 原判据只看时间（2 分钟）⇒ 前 2 分钟"对方离线"与"正在发"视觉不可分；
     * 发送那一刻就知道对端离线的话，排队态不必等满 2 分钟 —— 立即可分。
     */
    peerOnline?: boolean | null;
  },
  now: number,
): boolean {
  if (input.status !== "sending") return false;
  if (isTransferBacked(input.msgId)) return false;
  if (!(input.ts > 0)) return false;
  // 明确离线 ⇒ 立即按"等对端"渲染（时钟 + 等待文案）；true/null 不参与判定，
  // 保持原时间口径（在线时 2 分钟内的转圈仍然说得通：可能真的正在发）。
  if (input.peerOnline === false) return true;
  return now - input.ts >= WAITING_FOR_PEER_AFTER_MS;
}
