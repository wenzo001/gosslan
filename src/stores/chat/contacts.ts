/**
 * 联系人：附近节点探测、好友名单、好友申请、密钥轮换、收藏。
 *
 * 职责边界：只读写"人的名录"与申请状态；会话行刷新通过 `conversations.refreshConversations`。
 */
import { ref } from "vue";
import { api } from "@/api";
import { mergePeerList } from "@/utils/peerMerge";
import { markFriendsOnlineFrom } from "@/utils/friendOnline";
import { detailText } from "@/composables/useErrorText";
import { t } from "@/i18n";
import type { FavoriteEntry, FriendKeyRotation } from "@/types";
import type { ChatContext } from "./runtime";

export function createContactsModule(ctx: ChatContext) {
  const {
    app,
    refreshGuard,
    peers,
    friends,
    friendsLoaded,
    friendsError,
    rawPendingRequests,
    rawOutgoingRequests,
    keyRotations,
    rememberSeenNames,
  } = ctx.state;
  const { refreshConversations } = ctx.api;

  // ---------------- 刷新 ----------------
  /**
   * 后发先至守卫（审计阶段 4 · 4.2）。下面这些 `refresh*` 全是 `x.value = await api.foo()`，
   * 而调用点大量是 `void refreshX()`（群操作成对调两个、好友申请通过、gossip 更新…），
   * IPC 又没有顺序保证 ⇒ 旧快照完全可能后回来，把未读、排序、在线状态整体回退。
   * 同文件的 `refreshTransfers` 已经为这个坑单独修过一次（那次是"进度条永久钉在 0%"），
   * 这里把同一个不变量收成一份实现，并按**被写的状态**分 key —— 不按函数分：
   * `refreshPeers` 与 `searchNearbyPeers` 写的是同一个 `peers`，必须互相作废。
   */

  async function refreshPeers() {
    const tok = refreshGuard.begin("peers");
    const list = await api.getPeers();
    if (!refreshGuard.isCurrent("peers", tok)) return;
    // 整表直写会换掉数组与里面每个对象 ⇒ 凡读过 peers 的渲染全部失效（见 utils/peerMerge）。
    const merged = mergePeerList(peers.value, list);
    if (merged) peers.value = merged;
    rememberSeenNames(list);
  }
  /** 按需探测：群发一次 who_has 后返回周围在线节点（添加好友时调用）。 */
  async function searchNearbyPeers() {
    const tok = refreshGuard.begin("peers");
    const list = await api.searchNearbyPeers();
    // 被更新的一次探测抢走时：不写 peers、也不标注 online（online 是本结果的派生值，
    // 用旧探测结果标会把更新的状态盖回去），但**照常返回**给调用方它要的那份列表。
    if (!refreshGuard.isCurrent("peers", tok)) return peers.value;
    const merged = mergePeerList(peers.value, list);
    if (merged) peers.value = merged;
    rememberSeenNames(list);
    markFriendsOnlineFrom(friends.value, list);
    return peers.value;
  }
  async function refreshFriends() {
    const tok = refreshGuard.begin("friends");
    try {
      const list = await api.getFriends();
      if (!refreshGuard.isCurrent("friends", tok)) return;
      friends.value = list;
      friendsLoaded.value = true;
      friendsError.value = null;
    } catch (e) {
      if (!refreshGuard.isCurrent("friends", tok)) return;
      // 失败**不清空**上一次读到的名单：把"读不到"画成"没有了"就是假陈述。
      friendsError.value = detailText(e, { log: true });
      void app.toastError(e, t("conv.contactsLoadFailed"));
    }
  }
  async function refreshPending() {
    const tok = refreshGuard.begin("pending");
    const list = await api.getPendingRequests();
    if (!refreshGuard.isCurrent("pending", tok)) return;
    rawPendingRequests.value = list;
  }
  /** 我发出的申请：等待中 / 已撤回（终态由后端落库，不靠事件猜）。 */
  async function refreshOutgoingRequests() {
    const tok = refreshGuard.begin("outgoing");
    const list = await api.getOutgoingFriendRequests();
    if (!refreshGuard.isCurrent("outgoing", tok)) return;
    rawOutgoingRequests.value = list;
  }
  /** 重新拉取待确认的好友密钥轮换（后端只保留好友条目，内存态）。 */
  async function refreshKeyRotations() {
    try {
      const list = await api.getFriendKeyRotations();
      const next: Record<string, FriendKeyRotation> = {};
      for (const r of list) next[r.device_id] = r;
      keyRotations.value = next;
    } catch {
      // 老后端没有这个命令时静默（兼容），不影响聊天主流程。
    }
  }
  /** 用户确认是本人后同步好友的新身份密钥；成功后候选由后端事件移除。 */
  async function syncFriendKeys(peerId: string) {
    await api.syncFriendKeys(peerId);
    delete keyRotations.value[peerId];
    keyRotations.value = { ...keyRotations.value };
    await refreshFriends();
    await refreshConversations();
    app.toast(t("friend.keysSynced"), "success");
  }
  async function sendFriendRequest(peerId: string) {
    await api.sendFriendRequest(peerId);
    await refreshOutgoingRequests();
  }
  /**
   * 取消还没被处理的好友申请。
   *
   * 乐观把这一行翻成「已撤回（未确认）」再调后端：用户点完立刻有反馈；
   * 后端回执到达 / 对方已经同意，都会通过 `refreshOutgoingRequests` 把真实终态拉回来。
   * 失败（例如对方刚好先同意了）就回滚并让调用方 toast。
   */
  async function cancelFriendRequest(peerId: string) {
    const prev = rawOutgoingRequests.value;
    rawOutgoingRequests.value = prev.map((r) =>
      r.peer_id === peerId ? { ...r, status: "withdrawn", withdraw_confirmed: false } : r,
    );
    try {
      await api.cancelFriendRequest(peerId);
    } catch (e) {
      rawOutgoingRequests.value = prev;
      throw e;
    }
    await refreshOutgoingRequests();
  }
  /** 乐观交互：立即移出申请列表，失败回滚（调用方负责 toast）。 */
  async function respondRequest(peerId: string, accept: boolean) {
    const prev = rawPendingRequests.value;
    rawPendingRequests.value = prev.filter((r) => r.from !== peerId);
    try {
      await api.respondFriendRequest(peerId, accept);
    } catch (e) {
      rawPendingRequests.value = prev; // 回滚
      throw e;
    }
    if (accept) {
      await refreshFriends();
      await refreshConversations();
    }
  }

  /** 乐观交互：立即从联系人移除，失败回滚。保留聊天记录（后端行为）。 */
  async function removeFriend(peerId: string) {
    const prev = friends.value;
    friends.value = prev.filter((f) => f.device_id !== peerId);
    // 后端 remove_friend 会同步删掉密钥轮换候选；乐观一并清，否则聊天顶部的
    // 换钥横幅要等 friend-removed 事件往返后才消失。
    const prevRotation = keyRotations.value[peerId];
    if (prevRotation) {
      const nextRotations = { ...keyRotations.value };
      delete nextRotations[peerId];
      keyRotations.value = nextRotations;
    }
    try {
      await api.removeFriend(peerId);
    } catch (e) {
      friends.value = prev; // 回滚
      if (prevRotation) {
        keyRotations.value = { ...keyRotations.value, [peerId]: prevRotation };
      }
      throw e;
    }
  }

  // ---------------- 收藏 ----------------
  // 为什么放 store 而不是收藏面板的本地 ref：收藏**跨会话、全局可见**（面板只是一个视图），
  // 且"收藏 / 取消收藏"从消息菜单与面板两处发起 —— 状态藏在面板里，另一处就看不到变化。
  const favorites = ref<FavoriteEntry[]>([]);
  /** 收藏是本机唯一没有天然上界的可变长集合；给一个宽松上限防止无限增长。 */
  const MAX_FAVORITES = 1000;

  async function refreshFavorites() {
    // 「收藏 / 取消收藏」从消息菜单与面板两处发起 ⇒ 不加闸的话，先发起的后回来会把
    // 刚收藏的那条从面板里抹掉（用户看到"点了星号又没了"）。
    const tok = refreshGuard.begin("favorites");
    const list = await api.listFavorites();
    if (!refreshGuard.isCurrent("favorites", tok)) return;
    favorites.value = list;
  }

  /**
   * 收藏一条消息。返回 `true` = 这次是**新增**，`false` = 早就在收藏里了。
   *
   * 内容与媒体副本一律由后端决定（前端只给 msg_id/conv_id，详见 `add_favorite` 的命令说明）。
   * 判断"是否新增"用**条目 id 是否已在列表里**而不是条数变化：列表可能压根还没加载过
   * （length 为 0），拿长度比会把重复收藏误报成新增。
   */
  async function addFavorite(msgId: string, convId: string): Promise<boolean> {
    if (favorites.value.length >= MAX_FAVORITES) {
      app.toast(t("favorite.limitReached", { max: MAX_FAVORITES }), "error");
      return false;
    }
    const rec = await api.addFavorite(msgId, convId);
    if (favorites.value.some((f) => f.id === rec.id)) return false;
    favorites.value = [rec, ...favorites.value];
    return true;
  }

  /** 取消收藏。幂等：已经不在了也不报错（可能另一个窗口刚删过）。 */
  async function removeFavorite(id: string) {
    await api.removeFavorite(id);
    favorites.value = favorites.value.filter((f) => f.id !== id);
  }

  /**
   * 批量收藏（多选 → 收藏）。逐条调后端，最后刷一次列表。
   *
   * 为什么串行而不是 `Promise.all`：图片/文件类收藏每条都要把媒体**复制一份**到收藏目录，
   * 并发 100 个文件拷贝只会把磁盘和 db 锁打满；串行慢一点但稳，且每条的结果可数。
   * 单条失败**不中断整批**（已成功的不该被回滚），但失败条数如实返回给调用方报出来。
   */
  async function addFavorites(
    msgIds: string[],
    convId: string,
  ): Promise<{ added: number; already: number; failed: number }> {
    let added = 0;
    let already = 0;
    let failed = 0;
    const room = MAX_FAVORITES - favorites.value.length;
    if (room <= 0) {
      app.toast(t("favorite.limitReached", { max: MAX_FAVORITES }), "error");
      return { added, already, failed };
    }
    const ids = msgIds.slice(0, room);
    if (ids.length < msgIds.length) {
      app.toast(t("favorite.limitReached", { max: MAX_FAVORITES }), "error");
    }
    for (const id of ids) {
      try {
        if (await addFavorite(id, convId)) added += 1;
        else already += 1;
      } catch {
        failed += 1;
      }
    }
    await refreshFavorites();
    return { added, already, failed };
  }

  return {
    refreshPeers,
    searchNearbyPeers,
    refreshFriends,
    refreshPending,
    refreshOutgoingRequests,
    refreshKeyRotations,
    syncFriendKeys,
    sendFriendRequest,
    cancelFriendRequest,
    respondRequest,
    removeFriend,
    favorites,
    refreshFavorites,
    addFavorite,
    removeFavorite,
    addFavorites,
  };
}
