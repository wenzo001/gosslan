/**
 * 对端「离线 → 在线」翻转判定的**纯状态机**（TST-02 收尾，2026-11-22 从
 * `useChatStore::notePeerOnlineFlips` 抽出——抽的是判定，store 只留副作用）。
 *
 * 在线口径与 `markFriendsOnlineFrom` 同源：**出现在本轮 peers 快照里 = 在线**
 * （`Peer` 没有 online 字段，好友表.online 就是这么派生的）。所以：
 * · 本轮快照有、上一轮没有、且历史见过 ⇒ 这一次算「回来了」（要提示排队消息）；
 * · 历史没见过（启动首个快照）不算 —— 否则刚打开应用就满屏「已上线」；
 * · 本轮消失 ⇒ 从 lastSnapshot 摘掉（下次再出现就是"回来"）。
 *
 * 依赖仅 Web 标准类型（零 `@/` 导入）⇒ `node --test` 可直接跑。
 */
export interface PeerFlipState {
  /** 历史快照里见过的全部 device_id（首个快照只喂这张表，不产生翻转）。 */
  everSeen: Set<string>;
  /** 上一轮快照里出现的 device_id（本轮还在 ⇒ 不翻；本轮没了 ⇒ 摘除）。 */
  lastSnapshot: Set<string>;
}

export function createPeerFlipState(): PeerFlipState {
  return { everSeen: new Set(), lastSnapshot: new Set() };
}

/**
 * 吃进本轮 peers 快照，返回「本轮新翻成在线」的 id 列表，并把状态推进到本轮。
 *
 * 顺序刻意是「先判翻、后推进」：判定读的是上一轮的 lastSnapshot；推进写在判定之后，
 * 同一次调用里两件事不打架。
 */
export function advancePeerFlips(
  state: PeerFlipState,
  list: readonly { device_id: string }[],
): string[] {
  const ids = new Set(list.map((p) => p.device_id));
  const flipped: string[] = [];
  for (const id of ids) {
    if (!state.lastSnapshot.has(id) && state.everSeen.has(id)) {
      flipped.push(id);
    }
  }
  state.lastSnapshot.clear();
  for (const id of ids) {
    state.everSeen.add(id);
    state.lastSnapshot.add(id);
  }
  return flipped;
}
