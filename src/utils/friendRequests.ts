/**
 * 「新朋友」（好友申请列表）的过滤规则 —— 纯函数，便于单测。
 *
 * ## 规则（用户 2026-09-12 真机实测要求）
 * 「如果两个人已经互相加上好友了（可能双方都给对方发送了加好友申请），其中一个人点了确定，
 * 另一个人点进『新朋友』列表，**如果该好友已在好友列表的话，那条好友申请就应该自动清除掉**」。
 *
 * 为什么做成"渲染时过滤"而不是只靠各条路径手动删：申请被"解决"的方式有好几种
 * （我同意、对方同意、重启后重新拉取、对方走别的消息把我加上的），
 * 只要**事实**是"他已经是我的好友"，那一行就不该出现 —— 用事实判定，不依赖某条回执送达。
 */
export function actionableRequests<T extends { from: string }>(
  requests: readonly T[],
  friendIds: Iterable<string>,
): T[] {
  const ids = new Set(friendIds);
  return requests.filter((r) => !ids.has(r.from));
}

/**
 * 出站好友申请的「已失效」判定（J1-3，旅程走查 2026-11-20，用户拍板）：
 * `waiting` 且从**首次申请**（`first_at`，同时是协议身份 request_id）起 7 天
 * 没有成为好友 ⇒ 这条申请已失效。
 *
 * 为什么用 `first_at` 而不是 `last_sent_at`：补发引擎对方在线时每 30s 就可能
 * 补发一次 ⇒ `last_sent_at` 恒新鲜 ⇒ 按"最后一次发送"判会**永不失效**。
 * 「重新申请」按钮走 remove+restart（后端换全新 first_at）⇒ 时钟自然重置。
 */
export const FRIEND_REQUEST_EXPIRE_MS = 7 * 24 * 3600_000;

export function outgoingRequestExpired(
  req: { status: string; first_at: number },
  now: number,
): boolean {
  return (
    req.status === "waiting" &&
    req.first_at > 0 &&
    now - req.first_at >= FRIEND_REQUEST_EXPIRE_MS
  );
}
