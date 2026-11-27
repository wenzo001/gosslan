/**
 * 「这条 `sending` 到底是在发，还是在等对端上线」的判据（纯函数，可单测）。
 *
 * 为什么需要它：对端离线时消息会留在离线队列里等。2026-11-27 起离线行**不再按 7 天判死**，
 * 会一直保留到真正送达（`protocol-invariants` INV-P04 例外）。这期间 `messages.status`
 * 一直是 `sending`，界面若一直转圈，用户会以为卡住了。
 * 这里只做**可见文案**的判据，数据层状态一律不动。
 */

/** 超过这么久还停在 sending，就不再假装"正在发"。 */
export const WAITING_FOR_PEER_AFTER_MS = 2 * 60_000;

/**
 * 超过 7 天仍在等 ⇒ 从「等待对方」升级为「长期待补发」。
 * 只是**展示分档**：7 天不再是失败期限，行仍留在队列里等对端上线。
 */
export const LONG_HOLD_AFTER_MS = 7 * 24 * 3600 * 1000;

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

/**
 * 是否已经进入「长期待补发」：仍满足等待判据，且已超过 7 天。
 * 只影响文案/图标颜色；不改变消息状态，也不触发任何重发。
 */
export function isLongHoldWaiting(
  input: Parameters<typeof isWaitingForPeer>[0],
  now: number,
): boolean {
  if (!isWaitingForPeer(input, now)) return false;
  if (!(input.ts > 0)) return false;
  return now - input.ts >= LONG_HOLD_AFTER_MS;
}

/**
 * 某个会话里**正在等对端**的文本消息条数（J2-3，旅程走查 2026-11-20）：
 * 对端从离线翻成在线时，如果这个数 > 0，就告诉用户「排队的 N 条将陆续送达」。
 * 与 `isWaitingForPeer` 的排除口径一致：非 sending 不算、文件/群文件不算
 * （传输有独立的进度语义，不该被说成"排队"）。
 */
export function countWaitingTexts(
  msgs: readonly { status: string; msg_id: string | null }[],
): number {
  let n = 0;
  for (const m of msgs) {
    if (m.status === "sending" && !isTransferBacked(m.msg_id)) n += 1;
  }
  return n;
}
