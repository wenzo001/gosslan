/**
 * 会话列表 / 未读与已读 / 会话内分页 / 群历史同步。
 *
 * 职责边界：会话行与未读水位的读写、首载与翻页、群投递台账摘要、会话删除与置顶。
 * 消息入账与乐观投影不在这里（见 `messaging.ts`）。
 */
import { ref } from "vue";
import { api } from "@/api";
import {
  applyConversationSnapshot,
  appendLocalOnly,
  mergeMessages,
  preserveDeliveryStatus,
  pruneUnreadClears,
  selectCachedConversations,
  sortConversations,
  unreadAnchorIndex,
} from "@/utils/messages";
import { isLatestReadSeq, nextReadSeq, rollbackUnread } from "@/utils/optimistic";
import { withReadError, withoutReadError } from "@/utils/readErrorFlags";
import { beginHistoryStart, settleHistoryStart, releaseHistoryStart } from "@/utils/groupHistoryStart";
import { clearWhenFull } from "@/utils/bounded";
import { shouldRunThrottled } from "@/utils/defer";
import { dropFilePreview, clearFilePreviews } from "@/utils/filePreview";
import { isRenderedInTimeline } from "@/utils/messageKinds";
import { EMPTY_STRING_LIST } from "@/utils/emptyList";
import { detailText } from "@/composables/useErrorText";
import { storageSet } from "@/utils/safeStorage";
import { t } from "@/i18n";
import type {
  GroupDeliverySummary,
  GroupHistoryProgress,
  GroupReadInfo,
  MessageRecord,
} from "@/types";
import type { ChatContext } from "./runtime";
import { LAST_CONV_KEY } from "./runtime";

export function createConversationsModule(ctx: ChatContext) {
  const {
    app,
    refreshGuard,
    conversations,
    conversationsLoaded,
    groups,
    groupsLoaded,
    rawPendingRequests,
    transfers,
    groupReads,
    groupReadsErrors,
    messages,
    messageLoadErrors,
    groupDeliveries,
    groupDeliveryErrors,
    groupHistorySync,
    groupHistoryStarting,
    activeConv,
    mentionedConvs,
    asReadError,
  } = ctx.state;
  const {
    refreshOpenTodos,
    refreshTransfers,
    refreshUpdaterStatus,
    refreshPending,
    refreshOutgoingRequests,
    refreshFriends,
    clearPendingBatch,
    clearPendingReplaceAndAcks,
    clearNotifMap,
    hydrateRenderLangs,
  } = ctx.api;

  /**
   * 界面上那颗低调的「从群里最全的那个人补齐」按钮（负责人 2026-10-16 追加：
   * 已经在群里、但手里只有几条老版本同步来的记录的人，也要能自己点一下）。
   *
   * 后端返回的是一句**裁决短码**（`started` / `already_running` / `no_source` / `no_group`），
   * 搬运本身在后台 ⇒ 这里只负责"点下去之后有没有回声"：**四种都要有一句**。
   * 这里翻过一次车（原话是"`started` 不弹提示，因为按钮自己会变成转圈、横幅会跟着动"）：
   * 那个理由是假的。转圈与横幅都只在**第一条进度事件**到达之后才存在，而后端的顺序是
   * "先向最多 8 台各问一次摘要（每台最长 4s）→ 才取第一页" ⇒ 点下去到横幅出现之间有一段
   * 界面上什么都没有的窗口，用户读数就是"我按了一枚没反应的图标"⇒ 连点。
   * 四个键逐条写字面量，不走 `` `chat.groupHistory.${verdict}` `` ——
   * `i18n/index.test.ts` 那条"字面量 `t()` 必须命中真实 key"的判据读的是字面量，
   * 拼出来的键名它看不见，于是漏一个语言的后果是运行时静默回退成键名。
   */
  async function syncGroupHistoryNow(groupId: string) {
    // 审计 P3 #35：点下去这一刻就登记「启动中」（按钮 busy 立即为真），同群第二次点击
    // 在这里去重、不打 IPC —— 后端 already_running 是最后一道防线，不该是唯一一道。
    const begun = beginHistoryStart(groupHistoryStarting.value, groupId);
    if (!begun) return;
    groupHistoryStarting.value = begun;
    let verdict: string;
    try {
      verdict = await api.syncGroupHistoryNow(groupId);
    } catch (e) {
      // 启动失败必须撤销：留着「启动中」= 按钮永久转圈、这个群再也点不动。
      groupHistoryStarting.value = releaseHistoryStart(groupHistoryStarting.value, groupId);
      throw e;
    }
    // 非 started 裁决（already_running / no_source / no_group / 未知短码）一律撤销；
    // started 保留，等首条进度事件接管。事件可能先于裁决到达：settle 只减不增，
    // 不会把已被进度事件接管/收口的群重新挂回「启动中」。
    groupHistoryStarting.value = settleHistoryStart(groupHistoryStarting.value, groupId, verdict);
    if (verdict === "started") {
      // 见上面那条：这一段窗口里既没有横幅也没有转圈，不弹这一句就等于按下没回声。
      app.toast(t("chat.groupHistory.started"), "info");
    } else if (verdict === "already_running") {
      app.toast(t("chat.groupHistory.alreadyRunning"), "info");
    } else if (verdict === "no_source") {
      app.toast(t("chat.groupHistory.noSource"), "info");
    } else if (verdict === "no_group") {
      app.toast(t("chat.groupHistory.noGroup"), "info");
    }
    // 未知短码（老后端/以后加档）刻意不弹：宁可不解释，也不编一句没有对应文案的话。
  }

  /**
   * 任务中心「停止同步」（2026-10-25）：后端是协作式取消 —— 当前这一页跑完才停，
   * 终态由 `group-history-progress` 的 `cancelled` 相位发出，所以这里只回一句"正在停"。
   *
   * `not_running` / `no_group` 表示**界面这一行已经过期**（后台早没这一趟了）：
   * 直接把本地横幅撤掉 —— 留一条不会自己收口的"正在同步"就是在界面里挂一句假话。
   */
  async function cancelGroupHistory(groupId: string) {
    const verdict = await api.cancelGroupHistory(groupId);
    if (verdict === "requested") {
      app.toast(t("chat.groupHistory.cancelRequested"), "info");
      return;
    }
    if (verdict === "not_running" || verdict === "no_group") {
      const next = { ...groupHistorySync.value };
      delete next[groupId];
      groupHistorySync.value = next;
      // 同一句「界面这一行已经过期」也适用于启动登记：横幅撤了，「启动中」不能独留。
      groupHistoryStarting.value = releaseHistoryStart(groupHistoryStarting.value, groupId);
      app.toast(t(verdict === "not_running" ? "chat.groupHistory.cancelNotRunning" : "chat.groupHistory.noGroup"), "info");
    }
  }
  /**
   * 「这条会话我在本地已经判过已读」的水位（convId → 时刻）。
   *
   * 存在的理由见 `utils/messages.ts::applyConversationSnapshot`：`StaleGuard` 只挡
   * "后发先至"，挡不住"同一份请求、数据本身是旧的" —— 乐观清零之后再落一份清零前的
   * 快照，红点就会自己亮回来。
   */
  const unreadClearedAt = new Map<string, number>();
  /** 水位窗：超过这个年纪的水位一定不会再被任何在飞快照引用，丢掉以免 Map 无界增长。 */
  const UNREAD_CLEAR_TTL_MS = 30_000;

  /**
   * **全 store 唯一的"本地把未读清零"入口**：改内存 + 打水位两件事必须同时发生，
   * 所以不许在别处再写一遍 `conv.unread = 0`（判据：`windowEntries` 之外的
   * `storeContract` 结构守卫 —— 见该文件里那条 "只有一个家"）。
   */
  function clearUnreadLocally(convId: string): number {
    const conv = conversations.value.find((c) => c.id === convId);
    const previous = conv?.unread ?? 0;
    if (conv && conv.unread !== 0) conv.unread = 0;
    // 水位打在**发起前**的这一刻：晚于快照发起 ⇒ 那份快照里的数字是旧的，不许点亮红点
    unreadClearedAt.set(convId, Date.now());
    return previous;
  }

  /**
   * 已读回执的**唯一发起口**（乐观清未读 + 失败回滚）。
   *
   * 为什么不再在各调用点写 `api.markRead(id).then(() => clearUnreadLocally(id))`：
   * 那样"清未读"要等回执成功才发生（乐观更新名不副实），而且失败时没有任何人能把
   * 红点放回去。这里先清零，失败再把清零前的量**加回**（不是赋回：await 期间新到的
   * 消息也占着未读，不能一起吞掉）。
   *
   * 乱序：同一会话可能有多发（打开会话 / 去抖 / 通知动作 / 回前台）。只有**最新一次**
   * 的回滚有效 —— 更早那次失败已经被后来的尝试取代，回滚它会把后来清掉的红点又点亮。
   *
   * @param alreadyClearedFrom 调用方**已经**清过未读时的原始值（`openConversation` 要在
   *                           清未读之前先取 `unreadBefore` 做跳转锚点）。传了就不再清第二遍。
   */
  const markReadSeq = new Map<string, number>();
  function sendReadReceipt(convId: string, alreadyClearedFrom?: number): Promise<void> {
    const previous = alreadyClearedFrom ?? clearUnreadLocally(convId);
    const seq = nextReadSeq(markReadSeq.get(convId));
    markReadSeq.set(convId, seq);
    return api.markRead(convId).then(
      () => {
        // 成功：乐观清掉的就是真值。只有最新一次收尾才释放槽位（旧的让位给新的）。
        if (isLatestReadSeq(markReadSeq.get(convId), seq)) markReadSeq.delete(convId);
      },
      (e) => {
        // 真实结果（失败）到达：只有最新一次允许回滚；迟到的失败直接丢弃。
        if (!isLatestReadSeq(markReadSeq.get(convId), seq)) return;
        markReadSeq.delete(convId);
        const conv = conversations.value.find((c) => c.id === convId);
        if (conv && previous > 0) conv.unread = rollbackUnread(conv.unread, previous);
        // 水位撤掉：库里的未读仍是原值，后续快照应以库为准（否则红点永远点不亮）。
        unreadClearedAt.delete(convId);
        app.toastError(e, t("chat.markReadFail"));
      },
    );
  }

  /**
   * 「用户此刻真的在看聊天」—— 判据只在这一个家里，两条规则共用：
   *  - 已读（`debounceMarkRead`）：不在看就不许判已读（用户 2026-09-12 实测报告：
   *    移动端整页浮层盖着时判已读＝替用户撒谎、还会把回执发回去）；
   *  - 「有人@我」红点（`freshMentionedConvs` 的 `activeVisible`）：**"会话开着"不等于"在看"** ——
   *    桌面端启动会自动打开最近那个会话（`ResponsiveLayout.vue` 那条 watch），窗口也常在后台。
   *
   * ⚠️ 两条不许各取一半：只按"开着"就抑制红点，同一个瞬间会出现"已读说没在看、红点说在看"，
   * 后果是用户回来只看到「N 条未读」、看不出自己被 @ 过，要点开才知道。
   */
  function chatViewerLooking(): boolean {
    return !document.hidden && app.chatVisible;
  }
  async function refreshConversations() {
    const tok = refreshGuard.begin("conversations");
    // 发起时刻：这是"快照里的数据至少有多新"的下界（单连接单锁 ⇒ 读一定发生在发起之后）
    const issuedAt = Date.now();
    const list = await api.getConversations();
    // ⚠️ 这条最不是理论问题：`openConversation` 会**乐观清零**未读，而旧快照带着清零前的
    // `unread` ⇒ 红点自己亮回来、列表顺序也跟着回退（用户看到的"我没点它怎么又红了"）。
    if (!refreshGuard.isCurrent("conversations", tok)) return;
    conversations.value = applyConversationSnapshot(
      conversations.value,
      list,
      unreadClearedAt,
      issuedAt,
    );
    conversationsLoaded.value = true;
    pruneUnreadClears(unreadClearedAt, Date.now(), UNREAD_CLEAR_TTL_MS);
    // 徽标跟着会话一起刷：冷启动与"切回会话列表"都走这里。
    // ⚠️ 用内存里已有的消息算不行 —— 消息缓存有上限，冷会话根本不在内存里，
    // 那样算出来的是"没缓存的群没有数字"这种假状态。
    void refreshOpenTodos();
  }
  async function refreshGroups() {
    const tok = refreshGuard.begin("groups");
    const list = await api.getGroups();
    if (!refreshGuard.isCurrent("groups", tok)) return;
    groups.value = list;
    groupsLoaded.value = true;
    const entries = await Promise.all(
      list.map(async (group) => {
        try {
          const reads = await api.getGroupReads(group.id);
          if (groupReadsErrors.value[group.id]) {
            const next = { ...groupReadsErrors.value };
            delete next[group.id];
            groupReadsErrors.value = next;
          }
          return [group.id, reads] as const;
        } catch (e) {
          // `.catch(() => [])` 会把"读不到名单"画成"没人读过"（绿勾一起消失）。
          // 现在仍给空表（不牵连别的群），但按群记下原因 ⇒ 这一格从此能分清两种"空"。
          groupReadsErrors.value = { ...groupReadsErrors.value, [group.id]: asReadError(e) };
          return [group.id, [] as Awaited<ReturnType<typeof api.getGroupReads>>] as const;
        }
      }),
    );
    const next: Record<string, Record<string, number>> = {};
    for (const [groupId, reads] of entries) {
      next[groupId] = Object.fromEntries(reads.map((read) => [read.reader_id, read.last_read_ts]));
    }
    // 读名单是**第二次 await** 之后才写的，必须再过一次闸：把已退群成员的绿勾写回来，
    // 比群列表旧一帧难看得多。
    if (!refreshGuard.isCurrent("groups", tok)) return;
    groupReads.value = next;
  }

  /**
   * 「另一个窗口清空了聊天数据」→ 本窗口先**清空本地视图**，再把"还在的东西"重拉一遍。
   *
   * 为什么不能只重拉：会话/群/转移单来自后端（重拉就会变空），但 `messages`、
   * `rawPendingRequests`、`activeConv` 是**本地态** —— 不清的话主界面仍然挂着
   * 已被删除的会话内容与已经处理完的申请。用户实测（Mac 4.1.10）：在设置里清了
   * 「缓存 / 目录 / 聊天记录」，主界面一点反应都没有，看起来像没清掉。
   *
   * 好友**不清**：`clear_all_data` 不动好友表（重置数据不等于断交），所以这里同样保留。
   */
  async function resetAfterDataCleared() {
    messages.value = {};
    // 投递台账摘要与消息缓存同生共死（两条清除路径必须同口径）。
    groupDeliveries.value = {};
    groupDeliveryErrors.value = {};
    conversations.value = [];
    groups.value = [];
    groupReads.value = {};
    // 与 groupReads 同批清：后端把库清了，那几条"正在补历史"的提示也就没有对应的作业了。
    // 留着它们的表现是设置里清完数据回主界面，横幅还挂着一句"正在同步 320/800"。
    groupHistorySync.value = {};
    groupHistoryStarting.value = {};
    rawPendingRequests.value = [];
    transfers.value = [];
    // 收藏**不清**（用户 2026-10-31 决策，审计 A3）：后端已经不删 `favorites` 行、
    // 也不删副本目录，这里清掉内存态就会造出"面板空了、重启又全回来"的假象。
    activeConv.value = null;
    clearPendingBatch();  // 后台滞留待冲刷的消息批次（`let pending`，见上）
    // 这三张表存的都是"内存里的过渡态"：库已经清了，留着它们会让后续 flush 给已经不存在的
    // 记录重建条目（审计阶段 4 · 4.3）。`clearAllData` 走的是另一条路径，两边必须同口径。
    clearPendingReplaceAndAcks();
    clearNotifMap();
    // 预览缓存与 `clearAllData` 同口径：只放掉文件那份。收藏那份随收藏一起保留 ——
    // 后端既不删 `favorites` 行也不删副本目录，objectURL 指向的文件仍然真实存在。
    clearFilePreviews();
    await Promise.all([
      refreshConversations(),
      refreshGroups(),
      refreshTransfers(),
      refreshUpdaterStatus(),
      refreshPending(),
      refreshOutgoingRequests(),
      refreshFriends(),
    ]);
  }
  // 已读名单的**稳定引用缓存**（审计 P1 #17）：原先非空分支每次都新建数组 ⇒ Vue 判 prop 变了
  // ⇒ 每行 `MessageItem` 子树重新 patch。键 = 会话 + 消息时间 + 读者集合（内容相同即同一个数组）。
  const readerIdsCache = new Map<string, string[]>();

  function groupReaderIds(groupId: string, messageTs: number): string[] {
    const myId = app.device?.device_id;
    const members = new Set(groups.value.find((group) => group.id === groupId)?.members ?? []);
    const ids = Object.entries(groupReads.value[groupId] ?? {})
      .filter(([readerId, lastReadTs]) => members.has(readerId) && readerId !== myId && lastReadTs >= messageTs)
      .map(([readerId]) => readerId);
    // 没有已读者时返回**同一个空数组**：调用点在虚拟列表的每行模板里，`[] !== []` 会让
    // Vue 每次都判「这条 prop 变了」⇒ 整棵子树重新 patch（读数见 utils/emptyList.ts）。
    if (ids.length === 0) return EMPTY_STRING_LIST;
    const key = `${groupId}\u0000${messageTs}\u0000${ids.join(",")}`;
    const hit = readerIdsCache.get(key);
    if (hit) return hit;
    // 上限 200：虚拟列表来回滚动的可见窗口远小于它，满了直接清（这是缓存不是事实源）。
    clearWhenFull(readerIdsCache, 200);
    readerIdsCache.set(key, ids);
    return ids;
  }
  /**
   * 打开会话时的未读定位：第一条未读在**已渲染时间线**里的下标
   * （-1 = 有未读但还没算出来，交给贴底兜底）。
   *
   * ⚠️ 坐标系是 `ChatWindow.messages`（过滤后的列表），不是 `messages[convId]` 原始列表 ——
   * 分割线和 `scrollToIndex` 都在那个列表里消费这个数。换算收在
   * `utils/messages.ts:unreadAnchorIndex()`，过滤判据与 ChatWindow 共用
   * `isRenderedInTimeline`，不留第二份真相源（审计阶段 4 · 4.1-1）。
   */
  const unreadJump = ref<{ convId: string; index: number } | null>(null);

  /** 退群/被移出时清掉"未读跳跃锚点"（跨模块只能经这个口子改）。 */
  function clearUnreadJump() {
    unreadJump.value = null;
  }

  /**
   * 「跳到某条消息」请求（搜索结果点击时发起，由 ChatWindow 消费）。
   * 与 unreadJump **分开**是刻意的：unreadJump 会画「以下是未读消息」分割线，
   * 而"搜索定位"只是滚过去 + 高亮，语义不同，复用会画错东西。
   */
  const locateRequest = ref<{ convId: string; msgId: string } | null>(null);

  function clearLocateRequest() {
    locateRequest.value = null;
  }

  /**
   * 打开会话并定位到指定消息（搜索结果点击）。
   *
   * 命中可能**早于已加载窗口**（默认只加载最近 100 条）→ 逐页往前找，
   * 上限沿用 MAX_PAGES（与用户手动上翻一致，不会为一句话翻遍整库）。
   *
   * 返回三态而非布尔：翻页中途出错与"翻到顶也没找到"是**两回事**，
   * 调用方要给不同的话（HIG：异步路径必须有终态，且不能说错原因）。
   */
  /**
   * 会话**已经打开**时的定位：逐页向前找 msg_id，找到就发 `locateRequest` 给 ChatWindow。
   *
   * 与 `locateMessageInConv` 拆开是 2026-10-25 任务中心「去会话」的需求：
   * 那边已经 await 过 `openConversation`，再调一次会把整页重拉一遍、还会重复 markRead。
   */
  async function locateInLoaded(
    convId: string,
    msgId: string,
  ): Promise<"found" | "not-found" | "error"> {
    // 用户明确说"我要看这条"，就不要再去跳未读分割线（两者会互相抢滚动位置）
    unreadJump.value = null;
    try {
      for (let guard = 0; guard <= MAX_PAGES; guard++) {
        const list = messages.value[convId] ?? [];
        if (list.some((m) => m.msg_id === msgId)) {
          locateRequest.value = { convId, msgId };
          return "found";
        }
        const before = list.length;
        await loadMoreMessages(convId);
        // 长度没变 = 已翻到顶或已达页数上限 → 再循环无意义
        if ((messages.value[convId]?.length ?? 0) === before) break;
      }
    } catch (e) {
      // 不静默吞掉：留排查线索，并把"出错"这一态如实返回给调用方
      console.warn("[gosslan] 定位搜索命中消息失败", e);
      return "error";
    }
    return "not-found";
  }

  async function locateMessageInConv(
    convId: string,
    msgId: string,
  ): Promise<"found" | "not-found" | "error"> {
    await openConversation(convId);
    return locateInLoaded(convId, msgId);
  }

  async function openConversation(id: string) {
    activeConv.value = id;
    // 记住上次会话：重启后恢复（HIG State Restoration；localStorage 只作 UI 状态，
    // 失败不影响打开聊天）。
    storageSet(LAST_CONV_KEY, id);
    // 标记为最近使用，并在加载完成后收缩缓存（活跃会话始终保留）
    touchCacheOrder(id);
    // 打开即视为看到 → [有人@我] 标志随之清除
    mentionedConvs.value.delete(id);
    // 打开前先记录未读数（markRead 会清零），用于「跳到第一条未读」定位。
    // 有未读时提前占位（index=-1 = 加载中、索引未知）：让 ChatWindow 与
    // autoScrollOnSwap 在 loadMessages 完成前就知道「要跳未读」，避免先贴底再
    // 跳未读造成闪烁。
    const unreadBefore = conversations.value.find((c) => c.id === id)?.unread ?? 0;
    unreadJump.value = unreadBefore > 0 ? { convId: id, index: -1 } : null;
    // 未读清零走**乐观更新**（用户 2026-09-12 要求「所有异步操作尽量乐观更新」）：
    // 打开会话即视为已读，本地立刻清零，别让红点在 await 期间继续显示。
    clearUnreadLocally(id);
    // 会话行不存在（新加好友还没发过消息 / 群会话行还没建）→ 后端补建，保证左侧列表
    // 有对应可高亮的项。群也走这一条（2026-10-25：任务中心「去会话」对没有会话行的群
    // 只换了 activeConv，列表无行、标题无名字，看起来就是"没到达"）。
    // ⚠️ **不阻塞消息加载**：补建会话行与 loadMessages 互不依赖，串行 await 会让
    // 「切到一个全新会话」白等一次 IPC（骨架已经渲染，但内容迟迟不来）。
    // 因此并行发起，回来后若仍未出现再补进列表。
    const ensureConv = conversations.value.some((c) => c.id === id)
      ? Promise.resolve()
      : api
          .ensureConversation(id)
          .then((conv) => {
            if (!conversations.value.some((c) => c.id === id)) {
              conversations.value = sortConversations([conv, ...conversations.value]);
            }
          })
          .catch(() => {
            /* 忽略：不影响打开聊天 */
          });
    // ReadReceipt 与消息加载并行：让对方尽早看到绿勾，且不拖慢本端渲染。
    // 原先这里发了两次 markRead（一次 void、末尾再一次 await），属重复 IPC，一并去掉。
    // 失败会把上面乐观清掉的未读按原量加回（见 `sendReadReceipt`）。
    const readReceipt = sendReadReceipt(id, unreadBefore);
    await Promise.all([loadMessages(id), ensureConv]);
    await readReceipt;
    if (unreadBefore > 0) {
      // ⚠️ 换算必须发生在**过滤后的列表**里：`unread` 是后端计数，而分割线落在
      // ChatWindow 渲染出来的那些行上（判据两边共用 `isRenderedInTimeline`，
      // 见 utils/messageKinds）。旧写法在原始列表里取下标、到过滤后列表里用，
      // 而"占下标不占未读"（静默/`system`）与"占未读不占下标"（`announcement`/`poll`）
      // 两个方向的偏差同时存在 ⇒ 分割线画错消息、`scrollToIndex` 跳错位置。
      const rendered = (messages.value[id] ?? []).filter((m) => isRenderedInTimeline(m.kind));
      const idx = unreadAnchorIndex(rendered, unreadBefore);
      unreadJump.value = idx >= 0 ? { convId: id, index: idx } : null;
    }
    // 未读已在上面乐观清零；这里只做一次兜底（若期间又来了新消息把 unread 加回去，
    // 说明是"打开之后"到达的，此时不该再清）。
    // 切会话后收缩一次：刚被切走的会话若已冷，就可释放其内存副本
    enforceMessageCacheBound();
  }
  // ---------------- 会话内消息分页：每会话最多缓存页数（防内存无限增长） ----------------
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const pagesLoaded = new Map<string, number>();
  /**
   * 正在翻历史页的会话 → 那一次的 Promise。同一会话同时只允许一个在飞，
   * 但**后来者必须并入这一次**（见 `loadMoreMessages` 的 ⚠️）而不是被直接弹回。
   *
   * ⚠️ 这一处**刻意没有**改用 `utils/singleFlight`（那边已收四处预览 + 上面那个补读），
   *    因为它有两处被注释保护着的偏离：① 容量闸门（`pages >= MAX_PAGES`）夹在
   *    "并入在飞" 与 "登记" 之间 —— 走 helper 就得把它挪进 `make` 体内，早退时会多留一个
   *    瞬间存在的条目；② 摘除是 `page.finally(...)` **挂在链上**而不是在体内，
   *    目的是让 `page` 始终带着处理器、reject 不会变成 unhandled rejection，
   *    同时所有 await 方各自拿到同一次结果（2026-09-23 评审那条"别把正在翻误判成翻到头"）。
   *    这两条都没有判据兜着 ⇒ 强并是拿实测过的行为去换"少 6 行"。
   */
  const loadingMore = new Map<string, Promise<void>>();
  /**
   * 「向上翻历史失败」= 会话 → 可展示的原因。与 `messageLoadErrors`（整页首载失败）分开：
   * 首载失败要占满整块列表；翻页失败只影响顶部一行，下方已有消息仍可正常看/滚动。
   * 失败由 `onLoadMore` 捕获并显示可重试提示，不再变成 unhandled rejection。
   */
  const historyLoadErrors = ref<Record<string, string>>({});
  /**
   * 已知"这个会话已翻到最早一页"的会话：不再为它付任何翻页 IPC。
   * ⚠️ 必须在每次 `loadMessages` 重新加载该会话时作废 —— 重新打开只取最新一页，
   * 若沿用旧标记，500 条的会话就再也翻不到第 101 条以前（"翻不动历史"就是这么来的）。
   */
  const historyTops = new Set<string>();
  // 加载竞态守卫：快速切换会话时丢弃过期响应。**按会话分桶**：
  // 全局单计数会让「非活跃会话的重查」把此刻飞行中的活跃会话加载/翻页
  // 一并判为过期（onMessageStatusChanged 会对任意含该 msg_id 的会话触发
  // loadMessages）→ 活跃会话 messages[convId] 永远 undefined，骨架永久转圈
  // （2026-09-23 审计 1.4）。会话淘汰时一并清理（见 enforceMessageCacheBound）。
  const loadSeqs = new Map<string, number>();

  // ---------------- 消息缓存上界：限制「同时缓存多少个会话」 ----------------
  //
  // 为什么需要：MAX_PAGES 只限制「一个会话能往上翻几页」，而 messages 是按会话累积的
  // 内存副本——聊天对象一多，几十个会话各留最多 1000 条，长期挂机内存会持续增长。
  //
  // 为什么可以安全淘汰非活跃会话：UI 只渲染活跃会话（ChatWindow 只读 activeConv 的
  // 消息列表），其它会话的缓存纯粹是内存副本，切回时由 loadMessages 从 SQLite 重新
  // 加载最新一页，因此丢弃不影响任何展示。
  //
  // 为什么从 4 提到 8（用户 2026-09-24 #29「切换会话要瞬间响应」）：这条上界直接决定
  // 「切过去是**当场有内容**还是**先看到骨架**」—— 骨架的判据就是
  // `messages[convId] === undefined`。命中缓存 = 立刻有上一轮的内容可画（后台照样重查一页
  // 把发送状态/撤回对齐，只是那期间不空白）；被淘汰 = 冷加载**只能等那一轮 IPC**
  // （`get_latest_messages`，一次拿完，仍要排队过后端那把全局 `Mutex<Connection>`）。
  // 4 个槽位意味着常聊 5 个人时按 A→B→C→D→E→A 转一圈，
  // **回到 A 的那一下必然**是冷的 —— 淘汰是纯 LRU 计数、与"多久没打开"无关，
  // 所以这个退化是确定会发生，不是偶发。
  // 代价核过账：每会话上界 = MAX_PAGES × PAGE_SIZE = 1000 条，一条记录（msg_id/conv_id/
  // kind/content/sender/ts/link/status 等十余字段，正文通常几十字）量级 0.5–1 KB
  // ⇒ 8 个会话最坏 4–8 MB 的二级内存副本；渲染侧仍只有活跃会话那一列（VirtualList
  // 只画视口内的行），所以放大的是内存不是帧开销。
  //
  // 去重不受影响：后端 insert_message_if_new 只在「真的新建一行」时 emit
  // message-received（见 db.rs 注释），跨批次去重以它为权威；前端这份缓存只是二级保险。
  //
  // 仍未覆盖（已知遗留）：单个会话的实时新消息仍会不断追加，条数没有硬上界。
  // 未做是因为裁剪头部会改变 VirtualList 的滚动锚定（用户正向上翻阅时内容会跳动），
  // 需要与滚动状态联动，收益（每会话几 MB）不值这个回退风险。
  const MAX_CACHED_CONVS = 8;
  /** 会话缓存的 LRU 顺序（最近使用的在末尾） */
  const cacheOrder: string[] = [];

  function touchCacheOrder(convId: string) {
    const i = cacheOrder.indexOf(convId);
    if (i >= 0) cacheOrder.splice(i, 1);
    cacheOrder.push(convId);
  }

  /**
   * 放掉一批消息各自占的图片预览缓存（会话整块逐出时调用）。
   *
   * 为什么按 msg_id 逐个 drop 而不是"整份 clear"：`messages.value` 里同一时刻还有
   * 另外 7 个会话的图在缓存里，`clear()` 会把它们一起打掉、切回去全都重读一遍。
   *
   * 键就是 msg_id：接收侧的 msg_id 本身长成 `file-{transfer_id}` / `gfile-{transfer_id}`
   * （见 `commands::resolve_media_path` 的注释与 `handle_file.rs` / `group_file.rs` 的构造），
   * 而 `loadFilePreview(msg.value.msg_id, ...)` 正是拿它当缓存键 ⇒ 直接对上。
   * 待办描述图那条走的是 `cid`，不在这里（它挂在任务定义上、不随会话逐出）。
   */
  function releasePreviewsOf(msgs: readonly MessageRecord[] | undefined) {
    if (!msgs) return;
    for (const m of msgs) {
      if (m.kind !== "file" && m.kind !== "image") continue;
      dropFilePreview(m.msg_id);
    }
  }

  /** 把消息缓存收缩到 MAX_CACHED_CONVS 个会话（保留活跃会话 + 最近使用的若干个）。 */
  function enforceMessageCacheBound() {
    const keys = Object.keys(messages.value);
    if (keys.length <= MAX_CACHED_CONVS) return;
    const keep = selectCachedConversations(cacheOrder, activeConv.value, MAX_CACHED_CONVS);
    for (const cid of keys) {
      if (keep.has(cid)) continue;
      // 会话被整块逐出 ⇒ 它那些消息的图片预览也一并放掉。
      // 为什么必须联动：预览缓存的键是 `file-<transferId>` / `gfile-<transferId>` /
      // 待办图的 `cid`，**不是** msg_id —— 单靠 LRU 那 60 MiB 封顶虽然不会无限涨，
      // 但"这个会话已经不看了"是最强的释放信号，白占着就是让后看的图去挤前看的图。
      // 顺序必须在 `delete messages.value[cid]` **之前**取列表（删完就取不到了）。
      releasePreviewsOf(messages.value[cid]);
      delete messages.value[cid];
      // 投递台账摘要跟着会话走：会话都被逐出了，留着它只会让下次打开先看到过期计数。
      delete groupDeliveries.value[cid];
      // 分页簿记一并清掉：切回该会话时 loadMessages 会重新从 DB 取最新一页
      pagesLoaded.delete(cid);
      loadSeqs.delete(cid);
      // 同一本账：不清"到顶"结论的话，该会话重开后翻不动历史。
      // **不**跟着删 loadingMore —— 那条 Promise 自己会落地并摘除；在这里删会
      // 让"淘汰后新发起的一次"与仍在飞的旧的一次并行拉页，制造新的重复请求。
      historyTops.delete(cid);
    }
    // 同步收缩 LRU，避免它自身无限增长
    for (let i = cacheOrder.length - 1; i >= 0; i--) {
      if (!Object.prototype.hasOwnProperty.call(messages.value, cacheOrder[i])) {
        cacheOrder.splice(i, 1);
      }
    }
    // 未读定位指向已被淘汰的会话 → 清除（正常指向活跃会话，几乎不会走到）
    if (
      unreadJump.value &&
      !Object.prototype.hasOwnProperty.call(messages.value, unreadJump.value.convId)
    ) {
      unreadJump.value = null;
    }
  }

  async function loadMessages(convId: string) {
    const seq = (loadSeqs.get(convId) ?? 0) + 1;
    loadSeqs.set(convId, seq);
    touchCacheOrder(convId);
    // 重试时若上次失败留下的是合成空列表，先移除它让 ChatWindow 回到骨架态；
    // 已有真实内容则保留，刷新失败不清屏。
    if (messageLoadErrors.value[convId]) {
      delete messageLoadErrors.value[convId];
      if ((messages.value[convId]?.length ?? 0) === 0) delete messages.value[convId];
    }
    // 重新加载该会话 = 一次全新的分页生命周期：上一轮的翻页失败提示一并清掉。
    if (historyLoadErrors.value[convId]) {
      const next = { ...historyLoadErrors.value };
      delete next[convId];
      historyLoadErrors.value = next;
    }
    // ⚠️ 必须在**函数开头**作废"已翻到顶"这个结论，不能只在成功路径末尾清：
    // IPC 失败会走 catch 提前 return、seq 被后来者抢走也会提前 return —— 那些路径下
    // 内存列表同样是"只有最新一页"，若 historyTops 还留着 true，`loadMoreMessages`
    // 就被永久挡死，而它正是这种空列表下唯一的自愈通道（2026-09-23 评审抓出）。
    historyTops.delete(convId);
    // 打开会话应先加载「最新一页」，而不是最旧一页；否则底部会停在第 100 条历史，
    // 最新消息与文件都要靠后续滚动才出现。
    let list: MessageRecord[];
    try {
      // 一次 IPC 拿最新一页（后端返回正序，前端整表覆盖不必再倒一遍）。
      // 原先是「先 `COUNT(*)` 算 offset、再按 offset 取页」两轮**串行** —— 每轮都要排队过
      // 全局那把 db 锁，而 count 这一轮在冷加载里除了算 offset 没有别的用处。
      // 判据：`storeContract` 钉住"冷加载只发一次消息页 IPC"，Rust 侧钉住
      // 「一次取尾 == 两轮按 offset 取，逐行同序」。
      list = await api.getLatestMessages(convId, PAGE_SIZE);
    } catch (e) {
      // 读库失败也要把该会话标记为「已加载」：留 undefined 会让 ChatWindow 的加载骨架
      // 永远停在那里（UI 先行就得保证"必有终态"）。给空列表 = 回到"暂无消息"的正常态。
      if (messages.value[convId] === undefined) messages.value[convId] = [];
      messageLoadErrors.value[convId] = detailText(e, { log: true });
      return;
    }
    if (seq !== (loadSeqs.get(convId) ?? 0) || activeConv.value !== convId) return;
    // 快照可能取自 Ack / peer-read 落库之前：与查询期间已推进的内存状态合并，
    // 否则刚亮的绿勾会被这份旧快照退回「发送中」。
    const prev = messages.value[convId];
    // 乐观气泡（tmp-*）/ 文件失败占位（file-failed-*）只存在于内存：快照整表
    // 覆盖会把它们吞掉 → 已发出的消息"凭空消失"，用户以为失败而重发（审计 1.3）。
    messages.value[convId] = prev
      ? appendLocalOnly(preserveDeliveryStatus(list, prev), prev)
      : list;
    pagesLoaded.set(convId, 1);
    // 冷加载补齐代码语言（只读 message_render 里的显式值；失败就当全部自动识别）。
    void hydrateRenderLangs(convId);
    // 群会话：顺手取成员级投递台账（气泡角标与「补发」按钮的唯一依据）。
    // 失败不阻塞消息加载 —— 角标拿不到事实时宁可不显示，也不许猜一个数字出来。
    if (convId.startsWith("group:")) void refreshGroupDeliveries(convId);
  }

  /**
   * 拉一个群会话的成员级投递摘要（`get_group_delivery_summaries`）。
   *
   * 只保留该会话的结果；`activeConv` 守卫放在**回填之后**是刻意的：这个函数也会在
   * 会话没打开时被事件调用（补发/取消发生在任务中心），提前丢弃会让下次打开又白拉一次。
   * 失败时保留旧值：暂时读不到 ≠ 一切都送达了。但旧值必须**被标记为可能过期**
   * （审计 P2 #33，与 groupReadsErrors 同范式）：按会话记下原因，ChatWindow 据此
   * 画错误档 + 重试；成功只清自己的登记，不碰别的会话。
   */
  async function refreshGroupDeliveries(convId: string): Promise<void> {
    if (!convId.startsWith("group:")) return;
    let list: GroupDeliverySummary[];
    try {
      list = await api.getGroupDeliverySummaries(convId);
    } catch (e) {
      groupDeliveryErrors.value = withReadError(groupDeliveryErrors.value, convId, asReadError(e));
      return;
    }
    groupDeliveryErrors.value = withoutReadError(groupDeliveryErrors.value, convId);
    const map: Record<string, GroupDeliverySummary> = {};
    for (const s of list) map[s.msg_id] = s;
    groupDeliveries.value = { ...groupDeliveries.value, [convId]: map };
  }

  /** 清掉某个会话的翻页失败提示（重试/重开会话时）。 */
  function clearHistoryError(convId: string) {
    if (!historyLoadErrors.value[convId]) return;
    const next = { ...historyLoadErrors.value };
    delete next[convId];
    historyLoadErrors.value = next;
  }

  /** 向上翻页加载更早的历史消息（VirtualList 触顶时调用）。 */
  async function loadMoreMessages(convId: string): Promise<void> {
    // 两道闸门都必须有（审计阶段 4 · 4.1-2）：`VirtualList` 在"停在距顶 60px 内"期间
    // 每一次重测都会 emit `loadMore`（滚动 / resize / applyJump 轮询 / scrollToIndex /
    // items 变化 / 总高变化共 6 个入口），所以本函数会被**每帧**调用。
    //   · loadingMore：没有它，并发的两次调用都过得了下面的页数判据、各自 `getMessages`
    //     拉一页，却把 `pagesLoaded` 写成同一个值 ⇒ "前进一页、拉了两页数据"。
    //   · historyTops：没有它，已经翻到最早一页的会话（绝大多数会话都不满 MAX_PAGES）
    //     每帧都要白付一次 `getMessageCount` IPC。
    // 刻意**不做**边沿触发式的一次性开关：那样用户停在顶部时只会翻出一页，必须"往下滚
    // 一点再滚回来"才能继续翻 —— 那是拿一个真实可用的行为去换一个噪声，不划算。
    if (historyTops.has(convId)) return;
    // ⚠️ 单飞必须是**并入在飞的那一次**，不是"看见有人在飞就直接返回"。
    // `locateMessage` / `locateMessageInConv` 的循环写的是 `await loadMoreMessages()`
    // 然后"长度没变 ⇒ 没有更早历史了"；直接返回会让它们把"别人正在翻"误判成"翻到头了"，
    // 表现就是点引用/搜索命中时误报「原消息在更早的历史里」并拒绝定位（2026-09-23 评审
    // 抓出的回归 —— 加闸门时只想了防重复拉页，没想await方的语义）。
    const running = loadingMore.get(convId);
    if (running) return running;
    const pages = pagesLoaded.get(convId) ?? 1;
    if (pages >= MAX_PAGES) return;
    const page = loadMorePage(convId, pages);
    loadingMore.set(convId, page);
    // 挂在链上而不是原 promise 上：这样 `page` 始终有处理器，reject 时不会变成
    // unhandled rejection，而**所有** await 方仍各自拿到同一次结果。
    return page.finally(() => {
      loadingMore.delete(convId);
    });
  }

  /** 真正拉一页。单飞与容量闸都在 `loadMoreMessages` 那一层，这里只管一次 IPC。 */
  async function loadMorePage(convId: string, pages: number): Promise<void> {
    const seq = loadSeqs.get(convId) ?? 0;
    let total: number;
    let older: MessageRecord[];
    try {
      total = await api.getMessageCount(convId);
      if (seq !== (loadSeqs.get(convId) ?? 0)) return;
      // 计数成功也说明后端可达：先把上一轮失败提示清掉，避免"已到顶"这条成功路径留着红条。
      clearHistoryError(convId);
      if (pages * PAGE_SIZE >= total) {
        historyTops.add(convId);
        return;
      }
      // 当前已加载最新 pages 页，继续向更早方向取一页。
      const offset = Math.max(0, total - (pages + 1) * PAGE_SIZE);
      older = await api.getMessages(convId, PAGE_SIZE, offset);
      // 成功拿到响应即清掉上一轮的失败提示（包括"后面没有更早历史"这条成功路径）。
      clearHistoryError(convId);
    } catch (e) {
      // 失败必须**响亮**：记录到该会话、抛出给调用方（ChatWindow 显示顶部重试条 + 退避）。
      // 旧写法没有 catch，`void loadMoreMessages(...)` 直接变成 unhandled rejection，
      // 用户只看到"翻不动"，没有任何原因或重试入口。
      if (seq === (loadSeqs.get(convId) ?? 0)) {
        historyLoadErrors.value = {
          ...historyLoadErrors.value,
          [convId]: detailText(e, { log: true }),
        };
      }
      throw e;
    }
    if (seq !== (loadSeqs.get(convId) ?? 0) || older.length === 0) return;
    const existing = messages.value[convId] ?? [];
    messages.value[convId] = mergeMessages(existing, older);
    pagesLoaded.set(convId, pages + 1);
    // 拿不满一页就是到头了，不必再问一次 `getMessageCount`
    if (older.length < PAGE_SIZE) historyTops.add(convId);
    // prepend 历史后，「第一条未读」的下标整体后移。位移量既不是 `older.length`（原实现，
    // 把不渲染的静默行也算进去 ⇒ 每翻一页再累积一次误差，审计 4.1-1 的第二处实例），
    // 也不是"这一页里会渲染的条数"（2026-09-23 评审抓出）—— `mergeMessages` 会按 msg_id
    // 去重，而重叠是常态：会话总数落在 101~199 之间时第二页请求的 offset 仍是 0，
    // 返回的整页与内存里的最新一页大面积重叠；翻页期间来了新消息同样重叠。
    // 只有"真正新插进列表的那些**会渲染**的行"才是该平移的量。
    // index=-1 是"还在加载"的占位态，不参与位移。
    if (unreadJump.value?.convId === convId && unreadJump.value.index >= 0) {
      const known = new Set(existing.map((m) => m.msg_id));
      let shift = 0;
      for (const m of older) {
        if (!known.has(m.msg_id) && isRenderedInTimeline(m.kind)) shift += 1;
      }
      if (shift > 0) {
        unreadJump.value = { ...unreadJump.value, index: unreadJump.value.index + shift };
      }
    }
  }
  /**
   * 删除一个会话及其全部本地消息。
   * - 乐观移除：先从会话列表与内存缓存中抹除，后端失败回滚；
   * - 若被删的会话正是当前打开的会话，需让父组件（ConversationList/ChatWindow）
   *   检测 activeConv 是否仍存在并切到 null，避免打开空窗口。
   * - 仅本地清理，不影响对方聊天记录（前端弹窗二次确认）。
   */
  async function deleteConversation(convId: string) {
    const removedConv = conversations.value.find((c) => c.id === convId);
    const prevMessages = messages.value[convId];
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    mentionedConvs.value.delete(convId);
    // 清空该会话的内存消息缓存，避免下次打开时短暂闪烁旧数据
    const nextMessages = { ...messages.value };
    delete nextMessages[convId];
    messages.value = nextMessages;
    pagesLoaded.delete(convId);
    try {
      await api.deleteConversation(convId);
    } catch (e) {
      // 按项逆操作（审计 P2）：把移除的**那一条**会话行加回当前态（不整份覆盖，保留并发
      // 新增/变更的其他会话）；消息缓存本就按会话还原。
      if (removedConv && !conversations.value.some((c) => c.id === convId)) {
        conversations.value = [...conversations.value, removedConv];
      }
      if (prevMessages !== undefined) {
        messages.value = { ...messages.value, [convId]: prevMessages };
      }
      throw e;
    }
    // 若被删会话就是当前打开的会话，置空（调用方负责切换 UI）
    if (activeConv.value === convId) {
      activeConv.value = null;
      unreadJump.value = null;
    }
    // 会话都删了，投递台账摘要跟着走（放在 API 成功之后：失败回滚不必再补一次缓存）。
    delete groupDeliveries.value[convId];
  }

  /**
   * 置顶/取消置顶会话（纯本地偏好，不广播不同步）。
   * 乐观更新 + 失败回滚：置顶是高频轻操作，等一次 IPC 往返才动列表会明显发顿。
   */
  async function setConversationPinned(convId: string, pinned: boolean) {
    const oldPinned = conversations.value.find((c) => c.id === convId)?.pinned;
    conversations.value = sortConversations(
      conversations.value.map((c) => (c.id === convId ? { ...c, pinned } : c)),
    );
    try {
      await api.setConversationPinned(convId, pinned);
    } catch (e) {
      // 按项逆操作（审计 P2）：只还原**该会话**的 pinned（不整份覆盖，保留并发变更），再排序。
      if (oldPinned !== undefined) {
        conversations.value = sortConversations(
          conversations.value.map((c) => (c.id === convId ? { ...c, pinned: oldPinned } : c)),
        );
      }
      throw e;
    }
  }
  /** 清除聊天数据：后端清库（含群聊删除边界）后重置本 store 全部会话状态。
   *  activeConv 必须置 null——否则左侧无选中而右侧仍显示失效 ChatWindow。 */
  async function clearAllData() {
    await api.clearAllData();
    messages.value = {};
    // 投递台账摘要与消息缓存同生共死：库都清了，留着它们会让"清空后重建的会话"
    // 先看到上一轮的「已收到 2/3」角标。
    groupDeliveries.value = {};
    groupDeliveryErrors.value = {};
    conversations.value = [];
    groups.value = [];
    groupReads.value = {};
    // 与 groupReads 同批清：后端把库清了，那几条"正在补历史"的提示也就没有对应的作业了。
    // 留着它们的表现是设置里清完数据回主界面，横幅还挂着一句"正在同步 320/800"。
    groupHistorySync.value = {};
    groupHistoryStarting.value = {};
    activeConv.value = null;
    mentionedConvs.value = new Set();
    // 与 `resetAfterDataCleared` **同一组**（那边清的是同三张表）：后端把库清了，
    // 这些"等落地/等点击"的过渡态再留着就是给已不存在的记录重建条目。
    // 少清任何一张，两条清除路径就会走出两种不同的残留表现。
    clearPendingReplaceAndAcks();
    clearNotifMap();
    // 图片预览缓存整份放掉：库都清了，那些 objectURL 指向的文件已经不存在，
    // 留着就是几 MB～几十 MB 的死字节 + 一堆点了必然裂图的缓存条目。
    // 收藏那份**不动**：`clear_all_data` 已经不删收藏行、也不删副本目录（审计 A3），
    // 这里清掉只会让收藏面板白刷一遍缩略图。
    clearFilePreviews();
    void refreshTransfers();
  }
  function onGroupRead(p: GroupReadInfo) {
    const readers = groupReads.value[p.group_id] ?? {};
    const current = readers[p.reader_id] ?? 0;
    if (p.last_read_ts <= current) return;
    groupReads.value = {
      ...groupReads.value,
      [p.group_id]: { ...readers, [p.reader_id]: p.last_read_ts },
    };
  }

  /** 群历史同步期间重查当前会话的节流时刻（见 `onGroupHistoryProgress` 里第 ② 条）。 */
  let historyReloadAt = 0;
  /** 同一场同步里两次重查之间的最小间隔（每页都重查是纯浪费：预览由聊天活动驱动）。 */
  const HISTORY_RELOAD_MIN_INTERVAL_MS = 1500;

  /**
   * 后端每搬完一页群历史喊一声（事件 `group-history-progress`；需求原话
   * "同步中，可以有提示。别让用户感觉到卡顿"）。
   *
   * 这里只做两件事：
   *   ① 更新那条提示（`ChatWindow.vue` 读 `groupHistorySync` 画一条细横幅，不弹窗、不挡输入）；
   *   ② 只在**正打开着这一群**时重查消息，且最多每 1.5 秒一次。
   *
   * ②里的节流不是"省 IPC"的偏好问题：一页 200 条、页间让出 120ms，不节流就是每秒约 8 次
   * 整会话重查，而每次重查都要跨进程去抢那把全局 db 锁 —— 后台补账就会变成用户手上的卡顿，
   * 正是这条需求要避开的东西。`done` 那一发不受节流（它是终态，必须刷准）。
   *
   * `failed` 撤掉提示并 toast 一句：那时没有任何作业还在跑，留一条常驻"同步中"
   * 就是在界面里挂一句假话；而不留任何痕迹的话，用户只会看到"这个群怎么没几条消息"。
   */
  function onGroupHistoryProgress(p: GroupHistoryProgress) {
    const convId = `group:${p.group_id}`;
    // 任何相位都接管/收口「启动中」（审计 P3 #35）：running 是接管，done/failed/cancelled
    // 是收口 —— 同步在首条 running 之前就结束时，不撤登记按钮就会永久转圈。
    groupHistoryStarting.value = releaseHistoryStart(groupHistoryStarting.value, p.group_id);
    const wasTracking = !!groupHistorySync.value[p.group_id];
    const next = { ...groupHistorySync.value };
    if (p.phase === "running") {
      next[p.group_id] = p;
    } else {
      delete next[p.group_id];
    }
    groupHistorySync.value = next;
    // 会话列表：第一页落到本机时才会凭空多出一个群会话（新成员原本没有会话行），
    // 所以第一次看到这一群在同步时刷一次；`done` 再刷一次把预览对齐到最后一条。
    // 中间每页都刷是纯浪费（标题只由聊天活动驱动，页内不会变）。
    if (!wasTracking || p.phase !== "running") void refreshConversations();
    const now = Date.now();
    if (
      activeConv.value === convId &&
      (p.phase !== "running" ||
        shouldRunThrottled(now, historyReloadAt, HISTORY_RELOAD_MIN_INTERVAL_MS))
    ) {
      historyReloadAt = now;
      void loadMessages(convId);
    }
    if (p.phase === "failed") {
      app.toast(t("chat.groupHistory.failed"), "info");
    } else if (p.phase === "cancelled") {
      // 已拉到的部分保留；后端把标记写成 stopped，清扫任务不会自动重跑，
      // 需要用户在群聊顶部手动点同步才会继续（文案与后端语义同一条）。
      app.toast(t("chat.groupHistory.cancelled"), "info");
    }
  }

  return {
    refreshConversations,
    refreshGroups,
    resetAfterDataCleared,
    clearAllData,
    clearUnreadLocally,
    sendReadReceipt,
    chatViewerLooking,
    groupReaderIds,
    unreadJump,
    clearUnreadJump,
    locateRequest,
    clearLocateRequest,
    locateInLoaded,
    locateMessageInConv,
    openConversation,
    touchCacheOrder,
    releasePreviewsOf,
    enforceMessageCacheBound,
    loadMessages,
    refreshGroupDeliveries,
    clearHistoryError,
    loadMoreMessages,
    loadMorePage,
    onGroupRead,
    onGroupHistoryProgress,
    syncGroupHistoryNow,
    cancelGroupHistory,
    deleteConversation,
    setConversationPinned,
    historyLoadErrors,
    loadingMore,
    pagesLoaded,
  };
}
