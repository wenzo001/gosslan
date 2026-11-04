import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api, bindEvents } from "@/api";
import { furthestStatus, markFailureInCache, markStatusInCache, patchMessageInConv, transferFailureMsgIds, promoteOnPeerRead, syncProfileFromPeers } from "@/utils/messages";
import { safeStorageBackend, storageGet } from "../utils/safeStorage.ts";
import { useAppStore } from "@/stores/useAppStore";
import { trimOldest } from "@/utils/bounded";
import { createInitScope, type InitScope } from "@/utils/initScope";
import { StaleGuard } from "@/utils/staleGuard";
import { actionableRequests } from "@/utils/friendRequests";
import { resolveMemberName } from "@/utils/memberName";
import { observeMemberNames, readMemberNames, writeMemberNames, type MemberNameCache } from "@/utils/memberNameCache";
import { parseRemind } from "@/utils/reminders";
import { type TodoRowsByConv } from "@/utils/todos";
import { t } from "@/i18n";
import { detailText } from "@/composables/useErrorText";
import { mergePeerList } from "@/utils/peerMerge";
import { markFriendsOnlineFrom } from "@/utils/friendOnline";
import { onAction, registerActionTypes } from "@tauri-apps/plugin-notification";
import type { Conversation, Friend, FriendKeyRotation, Group, GroupDeliverySummary, GroupHistoryProgress, MessageRecord, Peer, PendingMessageOp, PendingRequest, OutgoingFriendRequest, UpdaterStatus, ContentTransfer, TransferInfo } from "@/types";
import { countOperations, deriveOperations, sortOperations, type OperationRow } from "@/utils/taskCenter";
import { LAST_CONV_KEY, createChatApi, type ChatContext, type ChatState } from "./chat/runtime";
import { createNotificationsModule } from "./chat/notifications";
import { createTaskCenterModule } from "./chat/taskCenter";
import { createMessagingModule } from "./chat/messaging";
import { createConversationsModule } from "./chat/conversations";
import { createTodosModule } from "./chat/todos";
import { createContactsModule } from "./chat/contacts";
import { createGroupsModule } from "./chat/groups";
import { createMediaModule } from "./chat/media";


// ════════════════════════════════════════════════════════════════════════════
// 乐观更新判据（5.16.91，唯一真源）
//
// 这里回答三个问题；新增异步动作**先按这张表归类**，再写代码。判据的纯函数在
// `@/utils/optimistic`（可被 `node --test` 直接 import），本段只负责"什么算哪一类"。
//
// ## 三分法
//
// ① **可乐观**：本地一次写库/入队成功即成立，且失败能干净回滚。
//    投影先上屏（气泡 / 未读 / 摘要），真实结果到达后落定；失败时把投影、
//    未读数、会话摘要、任务中心条目**一起收回**。
// ② **不可乐观（须远端为真）**：这个动作的意义就是"对方/服务端已经知道"。
//    本地先画成功等于替对方撒谎（撤回、表情回应、强提醒、群成员变更、通话）。
// ③ **先入队待重试**：本地先登记"我要做"，但没有本地真值可画；必须等后端 outbox
//    确认后才能显示"已发出"，失败要能从队列里拿回来（合并转发、离线可发起类动作）。
//
// ## 三个判定问题（按顺序问，任一为"否"就降级）
//
// 1. **本地一次写库/入队成功即成立？**
//    否 ⇒ 不可乐观（②）。例如"撤回"：本地删行不等于对方撤回。
// 2. **失败能否干净回滚？**
//    否 ⇒ 先入队待重试（③）。例如"合并转发到 N 个会话"：部分成功后无法把已完成的
//    那几个"撤销"，只能登记成一条待重试任务。
// 3. **状态是否必须以对方/远端为真？**
//    是 ⇒ 不可乐观（②）。例如"已读回执"：本地清零可以乐观，但**对方看到的已读**
//    必须以回执送达为真 —— 本批只做"本地侧"投影，回执失败只回滚红点，不假装对方已读。
//
// ## 当前所有异步动作 → 归类（新增动作必须补一行）
//
// | 动作 | 归类 | 说明 |
// |------|------|------|
// | 1:1 发消息 `send_message` | 可乐观 | **本批**：投影 + 摘要 + 失败回滚（气泡保留为 failed 供重试） |
// | 1:1 重发（界面复用 `send` 按原内容新发一条） | 可乐观 | 与上行同一条判据，迟到失败同样丢弃 |
// | 1:1 发文件/图片 `send_file_auto` | 可乐观 | **本批**：新增文件投影（带 local_id），拒绝时整条收回 |
// | 群发消息 `send_group_message` | 可乐观 | 已有投影；群摘要/未读归群成员台账，本批不改 |
// | 群发文件 `send_group_file` | 可乐观 | 真实行由后端 `message-received` 驱动，本批不改 |
// | 逐条转发 / 合并转发（复用上面两条） | 先入队待重试 | 多目标无法整体回滚；合并转发需先解决离线门控（下一批） |
// | 标记已读（本地侧）`mark_read` | 可乐观 | **本批**：先清零 + 失败把未读加回；"对方已读"仍以回执为真 |
// | 删除会话 / 置顶会话 | 可乐观 | 本地库一次写；失败回滚列表状态 |
// | 删除好友 / 同意·拒绝好友申请 | 可乐观 | 本地写 + 失败回滚；对方侧结果不在本地判据内 |
// | 添加收藏 / 取消收藏 | 可乐观 | 纯本机数据 |
// | 取消传输 / 任务中心取消 | 可乐观 | 本地先停，后端确认失败会重新出现在任务中心 |
// | 撤回消息 | 不可乐观 | 本地删行 ≠ 对方撤回；必须等服务端帧 |
// | 表情回应 | 不可乐观 | 回应是给对方看的，本地先画等于伪造 |
// | 强提醒 | 不可乐观 | 对方是否收到以服务端/推送为真 |
// | 窗口抖动 | 不可乐观 | 同上 |
// | 表情回应（离线） | 先入队待重试 | **5.16.92**：能力未知/离线先落 outbox（`sending`）；对端声明不支持才判死（`SEND_KIND_UNSUPPORTED`），任务中心可见可重发 |
// | 撤回（离线） | 不可乐观 + 先入队 | **5.16.92**：同上；本地删行不等于对方撤回，只在真正送达后由接收侧回执驱动 |
// | 群公告 / 群设置 / 成员增删 / 转让 / 退群 | 不可乐观 | 群成员可见的状态，必须远端为真 |
// | 群历史同步 | 先入队待重试 | 后端后台任务；本地只画"同步中"，进度来自事件 |
// | 群待办（创建/认领/完成/删除） | 不可乐观 | 群可见任务，落定以服务端行为准 |
// | 发送好友申请 | 不可乐观 | "已发送"以对方收到为准 |
// | 更新下载 / 安装 | 不可乐观 | 进度与成功必须来自真实下载器 |
// | 导出 / 导入 / 清空数据 | 不可乐观 | 长事务，只有结束后才知道成败 |
// | 网络/链路设置保存 | 不可乐观 | 可能触发重连，成功与否由后端运行态决定 |
// | 外观/通知偏好保存 | 可乐观 | 本机偏好一次写；失败回滚开关 |
//
// 本批只落地上表前三行 + 标记已读；其余行只做归类，不改行为。
// ════════════════════════════════════════════════════════════════════════════


/**
 * 上一轮 `init()` 的注册容器。
 *
 * 必须是**模块作用域**而不是 store 状态：`acceptHMRUpdate` 会换一个全新的 store
 * 实例（新实例的 `setup` 里没有任何旧实例注册的痕迹），而旧实例的 `listen()`
 * 仍挂在 Tauri 事件总线上 —— 只有模块级变量能让"新一轮 init"找到并拆掉"上一轮"。
 * 不拆的后果不是内存泄漏那么温和：每个事件回调会跑**两遍**（消息重复入账、
 * 通知翻倍、markRead 双发），且第一遍的闭包绑的是已被丢弃的 state。
 */
let chatInitScope: InitScope | null = null;

export const useChatStore = defineStore("chat", () => {
  const peers = ref<Peer[]>([]);
  const friends = ref<Friend[]>([]);
  /**
   * 首轮刷新是否已经落地（成功与否）。路由层要区分「好友/会话还没读回来」与
   * 「读完了但深链里的对象不存在」——没有这个标记，无效参数守卫会在启动瞬间误杀合法深链。
   */
  const initialized = ref(false);
  /** 各数据源**成功**读过一次：深链校验只能基于已读到的表，不能把 IPC 失败当成“对象不存在”。 */
  const friendsLoaded = ref(false);
  /**
   * 好友列表**这一次没读出来**的原因（null = 没有失败记录）。
   * 为什么单独一格：读库失败折成空列表后，界面会画成「还没有好友」——那是用一次 IO 失败
   * 生成一句关于用户数据的断言（INV-P36）。有了这个键，列表能区分"真的没有"与"没读到"，
   * 并且保留上一次读到的名单（成功过就以数据为准，错误不盖内容，同 `todoRowsLoadState` 的口径）。
   */
  const friendsError = ref<string | null>(null);
  const conversationsLoaded = ref(false);
  const groupsLoaded = ref(false);
  /**
   * 「最后一次见到的名字」本机缓存（只用于显示，不参与任何信任判断）。
   * 它管的是用户 2026-10-14 报的那半句「名字…会变」：非好友的群成员一离线，
   * `peers`（纯内存）里就没他了，界面上的名字会跟着换一档来源。判据与写盘策略见
   * `utils/memberNameCache.ts` 的文件头。
   */
  const memberNames = ref<MemberNameCache>(
    readMemberNames(safeStorageBackend),
  );
  /** 后端给的**原始**好友申请列表（可能含已经过期的：对方已同意 / 我已把他加上了）。 */
  const rawPendingRequests = ref<PendingRequest[]>([]);
  /**
   * 「好友密钥已更换、等待用户确认」的候选（device_id -> 候选）。
   * 后端只在新私钥 Hello 自验签通过时登记，仅内存态；前端据此在单聊顶部
   * 显示「同步新密钥 / 删除好友」横幅。用户确认或删好友后由后端事件清掉。
   */
  const keyRotations = ref<Record<string, FriendKeyRotation>>({});
  /**
   * 展示用的好友申请列表：**已经在好友列表里的申请自动消失**。
   *
   * 用户 2026-09-12 真机实测的规则：「如果双方已经互相是好友了，另一个人点进『新朋友』列表，
   * 那条好友申请就应该自动清除掉」。
   *
   * 做成 computed 而不是在各处手动删，有两个原因：
   *   ① 四个地方都读 `chat.pendingRequests`（会话列表红点、通讯录「新的朋友」、
   *      窄导航徽标、添加好友页的「同意/拒绝」行）—— 一处过滤，四处同时生效；
   *   ② 无论这条申请是**怎么**被解决的（我同意、对方同意、重启后重新拉取），
   *      只要 `friends` 里有这个人，那一行就立刻消失，不依赖某条回执消息有没有送达。
   */
  const pendingRequests = computed(() =>
    actionableRequests(
      rawPendingRequests.value,
      friends.value.map((f) => f.device_id),
    ),
  );
  /**
   * 我发出的申请（等待对方同意 / 已撤回）。
   *
   * 与 `pendingRequests` 同一纪律：已经出现在好友列表里的一律滤掉 ——
   * 三态里的「已同意」不是一条独立记录，而是 `friends` 里真的多了这个人。
   */
  const rawOutgoingRequests = ref<OutgoingFriendRequest[]>([]);
  const outgoingRequests = computed(() => {
    const friendIds = new Set(friends.value.map((f) => f.device_id));
    return rawOutgoingRequests.value.filter((r) => !friendIds.has(r.peer_id));
  });
  const conversations = ref<Conversation[]>([]);
  const groups = ref<Group[]>([]);
  const transfers = ref<TransferInfo[]>([]);
  /** 统一内容状态（ADR-0019）：未完成/失败的气泡据此显示「点击重试」。 */
  const contentTransfers = ref<ContentTransfer[]>([]);
  /**
   * 还没送到对端的消息行（后端读的是补发队列，不是 `messages.status`）。
   * 与 `transfers` / `contentTransfers` 同一次 `refreshTransfers` 拉回 ⇒ 任务中心
   * 那四行种类**永远来自同一份快照**，不会一条是新的、一条是旧的。
   */
  const messageOps = ref<PendingMessageOp[]>([]);
  /**
   * A 档几格各自的**读取失败原因**（null / 无键 = 没有失败记录）。
   * 为什么一人一格：这几路失败互相独立 —— 传输台账读挂了不该让内容台账与待发队列一起
   * 变成"没有任务"（INV-P36：读失败 ≠ 没有数据）。界面据此区分空态与错误态。
   */
  const transfersError = ref<string | null>(null);
  const contentTransfersError = ref<string | null>(null);
  const messageOpsError = ref<string | null>(null);
  /** 群任务徽标 / 群已读名单（按群）同一类"读不到"的登记。 */
  const groupReadsErrors = ref<Record<string, string>>({});
  // 这些错误串最终都上屏（会话/任务/好友/已读的「加载失败」块或顶部重试条）⇒ 一律只给
  // 分类后的说明，原始异常（IO / HRESULT / 英文库错误）进 console。
  const asReadError = (e: unknown) => detailText(e, { log: true });
  /**
   * 更新下载的可查询状态（B5）。后端是全局 managed state，跨窗口共用；
   * 事件 `updater-status` 是唯一推送口径，首帧由 `refreshUpdaterStatus()` 补拉。
   */
  const updaterStatus = ref<UpdaterStatus | null>(null);
  const messages = ref<Record<string, MessageRecord[]>>({});
  /**
   * 群消息的**成员级投递台账摘要**：convId → msgId → `{delivered,pending,cancelled,failed}`。
   *
   * 唯一来源是后端 `get_group_delivery_summaries`（台账就是真源）：前端不从
   * `messages.status`、已读列表或群成员数去推 —— 那会是第二套状态机，而用户报的
   * "排队中却说已送达"正是两套口径打架的结果。只装**还有非 delivered 行**的消息，
   * 正常完成的消息不会进这张表（后端已即时清理墓碑）。
   */
  const groupDeliveries = ref<Record<string, Record<string, GroupDeliverySummary>>>({});
  /** 首屏消息读失败：convId → 原始错误。成功后清空；UI 只在列表为空时展示。 */
  const messageLoadErrors = ref<Record<string, string>>({});
  // group_id -> reader_id -> reader 已读到的最大时间戳
  const groupReads = ref<Record<string, Record<string, number>>>({});
  /**
   * group_id -> 群历史同步进度（新成员入群后后端自动补聊天与群任务，
   * 见 Rust `network/group_history.rs`；事件 `group-history-progress`）。
   *
   * 只装**还没收口**的那几个群：`done` 与 `failed` 都会把条目撤掉，
   * 于是界面不会留下一条永远挂着、但其实已经不会再变的"同步中"（那种残留比没有提示更坏）。
   */
  const groupHistorySync = ref<Record<string, GroupHistoryProgress>>({});
  const activeConv = ref<string | null>(null);
  // 群聊里有人 @ 我且未读的会话 id 集合 → 列表摘要前显示 [有人@我]。
  // 纯前端运行时标志（不落库）：打开会话即清除，重启后随未读一起消失。
  const mentionedConvs = ref(new Set<string>());

  const activeConversation = computed(
    () => conversations.value.find((c) => c.id === activeConv.value) ?? null,
  );
  const totalUnread = computed(() => conversations.value.reduce((s, c) => s + c.unread, 0));

  /**
   * 统一后台任务中心的那张表（只含未完成）。
   *
   * 归一逻辑全在 `@/utils/taskCenter`，这里只做四份真值的拼装 —— 组件不许自己再推一遍
   * "什么算卡住"，否则会长出第二套状态口径（那张的成因见 taskCenter.ts 文件头）。
   * `groupHistorySync` 是 Record，`Object.values` 取值顺序不参与显示（下面自己排序）。
   */
  const operations = computed<OperationRow[]>(() =>
    sortOperations(
      deriveOperations({
        transfers: transfers.value,
        contentTransfers: contentTransfers.value,
        messageOps: messageOps.value,
        resending: [...resendingIds.value],
        groupHistory: Object.values(groupHistorySync.value),
        updater: updaterStatus.value,
      }),
    ),
  );
  /** 药丸上的数：还有几件事没办完。 */
  const liveOperationCount = computed(() => countOperations(operations.value));

  // ---------------- 系统通知（后台 / 非当前会话才触发） ----------------
  const app = useAppStore();

  /**
   * 把这一批在线节点自报的名字记进本机缓存。**三个 `peers.value` 写入点都必须走这里** ——
   * 少一个就会又出现「某条路径刷新见过的人，离线后名字不见了」（同"同一判据两个家"那一族）。
   * 没有真变化时 `observeMemberNames` 返回 null ⇒ 一次存储都不写。
   */
  function rememberSeenNames(list: readonly { device_id: string; nickname?: string | null }[]) {
    const next = observeMemberNames(memberNames.value, list);
    if (!next) return;
    memberNames.value = next;
    writeMemberNames(safeStorageBackend, next);
  }

  // 按 device_id 的合并索引（审计 P1 #17）：`nicknameOf` 在虚拟列表的**每一行**被调用，
  // 原先每行跑两次 `Array.prototype.find`（好友 + 在线节点）⇒ 30 行就是 120 次线性扫。
  // 与 `ConversationList.vue` 的 `friendById` 同形，只是这里是全仓唯一的数据源。
  const friendById = computed(() => new Map(friends.value.map((f) => [f.device_id, f])));
  const peerById = computed(() => new Map(peers.value.map((p) => [p.device_id, p])));

  function nicknameOf(id: string): string {
    // 顺序与兜底的**判据**在 `utils/memberName.ts`（纯函数、可在 Node 单测）——
    // 这里只负责"从哪张表取"。以前这两处各写一遍（聊天走本函数、任务面板走 `useMemberProfile`），
    // 连兜底都不一致：这里返回裸 `device_id`（= 用户 2026-10-14 说的"有时候显示设备名"），
    // 那里对自己返回「我」。同一个人同一屏可以两个写法，所以把判据收成一个家。
    const f = friendById.value.get(id);
    const p = peerById.value.get(id);
    return resolveMemberName(
      id,
      {
        selfId: app.device?.device_id ?? "",
        selfNickname: app.device?.nickname ?? "",
        friendNickname: f?.nickname,
        peerNickname: p?.nickname,
        snapshotNickname: memberNames.value[id],
      },
      { me: t("common.me"), unknownMember: t("common.unknownMember") },
    );
  }

  const myDeviceId = computed(() => app.device?.device_id ?? "");



  const refreshGuard = new StaleGuard();

  const groupTodoRows = ref<TodoRowsByConv>({});


  const resendingIds = ref(new Set<string>());










  /**
   * 本地删除若干条消息（多选 → 删除）。
   *
   * 乐观移除 + 失败回滚：删除必须"立刻见效"，等 IPC 回来才更新列表会有明显停顿；
   * 而失败时（例如后端按 kind 拒掉了非聊天内容）要把列表恢复原状 —— 不能让界面停在
   * "看起来删掉了、一刷新又回来"的状态。
   *
   * 会话摘要与未读由**后端重算**（`delete_messages`），这里删完拉一次会话列表即可：
   * 前端再实现一套"重算摘要"就是把同一口径复制到第二个地方。
   */






  /**
   * 实时事件链路是否健康（10-22 审计 R-33 / D-29）。
   *
   * 此前 `bindEvents` 失败**只有一次性 toast**，之后界面与完全正常的界面没有任何区别 ——
   * 用户不知道"收不到新消息"是链路断了而不是对方没发。设置页读这一份做常驻显示，
   * 并提供真的重绑入口（`init()` 开头自带"先拆上一轮再注册这一轮"的守卫 ⇒ 重绑幂等）。
   */
  const eventBridgeOk = ref(true);

  // ── chat store 拆分接线（状态唯一一份；动作经 `chatApi` 晚绑定） ─────────────
  const state: ChatState = {
    app, refreshGuard, myDeviceId, nicknameOf, rememberSeenNames, asReadError,
    peers, friends, initialized, friendsLoaded, friendsError, conversationsLoaded, groupsLoaded,
    memberNames, rawPendingRequests, keyRotations, pendingRequests, rawOutgoingRequests,
    outgoingRequests, conversations, groups, transfers, contentTransfers, messageOps,
    transfersError, contentTransfersError, messageOpsError, groupReadsErrors, updaterStatus,
    messages, groupDeliveries, messageLoadErrors, groupReads, groupHistorySync, activeConv,
    mentionedConvs, activeConversation, totalUnread, operations, liveOperationCount,
    resendingIds, groupTodoRows, eventBridgeOk,
  };
  const apiRegistry: Record<string, unknown> = {};
  const ctx: ChatContext = { state, api: createChatApi(apiRegistry) };
  const notificationsModule = createNotificationsModule(ctx);
  Object.assign(apiRegistry, notificationsModule);
  const taskCenterModule = createTaskCenterModule(ctx);
  Object.assign(apiRegistry, taskCenterModule);
  const messagingModule = createMessagingModule(ctx);
  Object.assign(apiRegistry, messagingModule);
  const conversationsModule = createConversationsModule(ctx);
  Object.assign(apiRegistry, conversationsModule);
  const todosModule = createTodosModule(ctx);
  Object.assign(apiRegistry, todosModule);
  const contactsModule = createContactsModule(ctx);
  Object.assign(apiRegistry, contactsModule);
  const groupsModule = createGroupsModule(ctx);
  Object.assign(apiRegistry, groupsModule);
  const mediaModule = createMediaModule(ctx);
  Object.assign(apiRegistry, mediaModule);
  const { maybeNotify, ensureRemindChannel, handleIncomingNudge, handleIncomingRemind, routeNotificationClick, shakeSignal, nudgeNotice, notifMap, cancelNotificationTimers } = notificationsModule;
  const { refreshUpdaterStatus, markResending, refreshTransfers, scheduleTransfersRepair, cancelTransfersRepairTimer } = taskCenterModule;
  const { convIdOfMessage, flushNow, enqueueMessage, send, resend, sendReminder, shakeConversation, confirmReminder, recallMessage, setMessageRender, sendReaction, sendDmReaction, deleteMessages, onMessageRecalled, onMessageRenderChanged, PENDING_ACKS_MAX, getPending, pendingAcks } = messagingModule;
  const { refreshConversations, refreshGroups, resetAfterDataCleared, clearAllData, sendReadReceipt, chatViewerLooking, groupReaderIds, unreadJump, locateRequest, clearLocateRequest, locateInLoaded, locateMessageInConv, openConversation, loadMessages, refreshGroupDeliveries, clearHistoryError, loadMoreMessages, onGroupRead, onGroupHistoryProgress, syncGroupHistoryNow, cancelGroupHistory, deleteConversation, setConversationPinned, historyLoadErrors } = conversationsModule;
  const { openTodoByConv, groupTodoRowsErrors, ensureGroupTodoRows, todosLoadedOnce, loadGroupTodos, watchGroupTodos, createTodo, updateTodo, pinMessage } = todosModule;
  const { refreshPeers, searchNearbyPeers, refreshFriends, refreshPending, refreshOutgoingRequests, refreshKeyRotations, syncFriendKeys, sendFriendRequest, cancelFriendRequest, respondRequest, removeFriend, favorites, refreshFavorites, addFavorite, removeFavorite, addFavorites } = contactsModule;
  const { activeAnnouncements, publishAnnouncement, refreshAnnouncements, deleteAnnouncement, createGroup, renameGroup, addGroupMember, removeGroupMember, transferGroupCreator, leaveGroup, handleSelfRemovedFromGroup } = groupsModule;
  const { sendFileTo, sendGroupFileTo, sendImage, stalledTransfers, isTransferStalled, transferStallReason, setTransferStalled, onFileStalled, updateTransferProgress, onFileDone, onGroupFileLog, onFileFailed, groupFileDiag } = mediaModule;

  async function init() {
    // 重复初始化守卫：先拆掉上一轮注册的资源，再注册这一轮的。
    // 触发场景是 HMR（App.vue 热替换 → onMounted 再跑一次 init）与任何将来的
    // 二次调用；生产冷启动只有一轮，拆的是 `null`。
    chatInitScope?.dispose();
    const scope = createInitScope();
    chatInitScope = scope;
    // ⚠️ 事件绑定必须先于一切初始刷新（2026-09-23 审计 1.5）：Tauri `listen`
    // 不回放历史事件 —— 排在刷新之后绑定，启动窗口期（"打开就收消息"是局域网
    // 高频场景）emit 的系统通知/新消息/在线状态会**永久丢失**，且无任何纠正路径。
    // bindEvents 内部是并行 listen，调用瞬间 IPC 即发出，不等往返即可开始拉数据。
    //
    // 事件绑定自身也要兜底（审计 1.6）：不 catch 的话它 reject 会拖着 init 一起
    // reject —— 界面看起来正常，却永远收不到任何事件（"活着但功能全死"）。
    // 会话打开期间收到新消息：去抖标记已读（同时把已读回执发给对方 → 对方绿勾）
    let markReadTimer: ReturnType<typeof setTimeout> | null = null;
    const debounceMarkRead = (convId: string) => {
      if (markReadTimer) clearTimeout(markReadTimer);
      markReadTimer = setTimeout(() => {
        markReadTimer = null;
        // ⚠️ 三个条件缺一不可：得是这个会话、应用在前台、**而且聊天视图真的可见**
        // （移动端可能正盖着设置/新的朋友等整页浮层 —— 那时用户根本没看到这条消息，
        //  判已读等于替用户撒谎、还会把回执发回去。用户 2026-09-12 实测报告）。
        // 这份口径的家是 `chatViewerLooking()` —— 「有人@我」那条也读它，不许在这里再手写一遍。
        if (activeConv.value !== convId || !chatViewerLooking()) return;
        void sendReadReceipt(convId);
      }, 300);
    };
    // 去抖里还排着一次 markRead：拆掉它，否则一个绑在废弃实例上的已读回执会在
    // 300ms 后发出去（用户已经切走，等于替他判了已读）。
    scope.onDispose(() => {
      if (markReadTimer) clearTimeout(markReadTimer);
      // 同一条纪律补两个"一次性"定时器（10-23 审计 P3-E）：它们各自只排一次、开火即清、
      // 重复排程有 `!== null` 守卫，但**重新 init 时不会取消已排队的那一发**。
      // Store 是单例 ⇒ 那一下作用在同一份活状态上（不会碰死实例），代价只是多做一次
      // 通知合批 / 一次传输补拉；登记之后连这个也省了，且与 markReadTimer 一个口径。
      cancelNotificationTimers();
      cancelTransfersRepairTimer();
    });
    bindEvents({
      onPeers: (p) => {
        // 这个事件最多每秒 3 次：不比对就直接换表，等于每 333ms 把整屏消息行重画一遍
        // （消息行模板里的 nicknameOf 读的就是 peers）。没变就不写。
        const merged = mergePeerList(peers.value, p);
        if (merged) {
          peers.value = merged;
          // 链路表变了（心跳把半开链路摘掉 / 对端重新上线）⇒ 任务中心那几行「发送中」
          // 与「等待对方上线」的结论要跟着翻面（2026-10-25：用户看到的"一直排队"）。
          // 与消息事件共用同一个 400ms 防抖，不会把 3/s 的拓扑事件放大成 IPC 风暴。
          scheduleTransfersRepair();
        }
        rememberSeenNames(p);
        markFriendsOnlineFrom(friends.value, p);
        // 同步好友/单聊会话的昵称/头像（对方改名后立即生效）
        syncProfileFromPeers(friends.value, conversations.value, p);
      },
      onFriendRequest: (req) => {
        // 去重：同一设备多次申请只保留最新一条（过滤历史重复申请）
        rawPendingRequests.value = [
          req,
          ...rawPendingRequests.value.filter((r) => r.from !== req.from),
        ];
      },
      onFriendAccepted: async () => {
        await refreshFriends();
        await refreshConversations();
        await refreshOutgoingRequests();
      },
      onFriendRejected: () => {
        void refreshOutgoingRequests();
      },
      onFriendRequestWithdrawn: async (e) => {
        if (e.direction === "inbound") {
          rawPendingRequests.value = rawPendingRequests.value.filter(
            (r) => r.from !== e.peer_id,
          );
          app.toast(t("friend.request.withdrawnByPeer"), "info");
        }
        // 两个方向都重拉：出站那一行的"已撤回（未确认）"要靠后端回执翻成确认态。
        await refreshOutgoingRequests();
      },
      onFriendRemoved: async () => {
        await refreshFriends();
        // 后端在删好友时会一并删掉该好友的密钥轮换候选：本地表跟着清，
        // 否则聊天顶部的换钥横幅会残留（候选只在内存，事件不带全量列表）。
        await refreshKeyRotations();
      },
      // 好友重装应用、新私钥 Hello 自验签通过：后端登记候选，这里拉全量列表。
      onFriendKeyChanged: () => {
        void refreshKeyRotations();
      },
      onFriendKeysSynced: () => {
        void refreshKeyRotations();
      },
      onFriendMessageBlocked: () => {
        app.toast(t("send.notFriend"), "error");
      },
      // Block 1 Case B：历史 NULL 好友的身份密钥从验签信封补齐 ⇒ 好友详情里的安全码
      // 从"未验证"转为可查看。重拉好友表（安全码读的是 friends 表那一列）与轮换候选。
      // 对话里那条「已确认对方身份密钥（此前未验证）」由后端的系统消息负责，不在这里造第二份。
      onFriendAnchorBound: () => {
        void refreshFriends();
        void refreshKeyRotations();
      },
      onMessage: (rec) => {
        enqueueMessage(rec);
        if (rec.kind === "remind") {
          const p = parseRemind(rec);
          if (p?.nudge) handleIncomingNudge(rec);
          else handleIncomingRemind(rec);
        } else maybeNotify(rec);
        // 公告发布/删除：刷新「会话列表 📢 标记」的数据源（一条 SQL 全量折叠，代价低）。
        if (rec.kind === "announcement" || rec.kind === "announcement_delete") {
          void refreshAnnouncements();
        }
        if (rec.kind === "file" || rec.kind === "image") void refreshTransfers();
        // 正在看这个会话且窗口可见 → 自动已读并回执
        if (rec.sender_id !== myDeviceId.value && rec.conv_id === activeConv.value) {
          debounceMarkRead(rec.conv_id);
        }
      },
      onMessageAcked: (msgId) => {
        // 对方收到（Ack）：sending → delivered（空圆框）。经 outbox 补发的重试 Ack
        // 可能晚于 peer-read 到达，只允许前进不允许把绿勾退回空圆框。
        const hit = patchMessageInConv(messages.value, convIdOfMessage(msgId), msgId, (m) => ({
          ...m,
          status: furthestStatus(m.status, "delivered"),
        }));
        const found = hit !== null;
        if (hit) messages.value = hit.lists;
        // Ack 先于乐观→真实替换到达（store 里找不到 real msg_id）：
        // 暂存 Ack，send() 拿到真实记录后立即消费。
        if (!found) {
          pendingAcks.add(msgId);
          trimOldest(pendingAcks, PENDING_ACKS_MAX);
        }
        // Ack 到达 = 补发队列那一行被删（送达是终态）：任务中心行必须跟着消失。
        scheduleTransfersRepair();
      },
      onPeerRead: (p) => {
        // 对方已读到 last_read_ts：我发出的、ts ≤ 该值的消息 → read（绿勾）。
        // 谓词在 utils/messages.ts::promoteOnPeerRead —— 那一句的家在后端
        // `db/read_receipts.rs::mark_own_messages_read_upto`，两份不许分叉（failed/recalled 点不动）。
        for (const [convId, list] of Object.entries(messages.value)) {
          if (convId !== p.peer_id) continue;
          const next = promoteOnPeerRead(list, myDeviceId.value, p.last_read_ts);
          if (next !== list) messages.value[convId] = next;
        }
      },
      onGroupRead,
      onMessageRecalled,
      onMessageRenderChanged,
      onFileProgress: (p) => {
        // 进度由事件载荷直接更新，不再全量刷新传输列表（避免大文件 IPC 风暴卡死界面）
        updateTransferProgress(p);
      },
      // 链路停滞（对端长时间没再收任何一片）：气泡文案要从「发送中 63%」变成
      // 「网络停滞」，否则用户只会觉得软件卡死 —— 后端在背压里等，前端什么都不知道。
      onFileStalled,
      onFileDone: (d) => {
        onFileDone(d);
        void refreshTransfers();
      },
      onFileFailed: (d) => {
        onFileFailed(d);
        void refreshTransfers();
      },
      onUpdaterStatus: (st) => {
        updaterStatus.value = st;
      },
      onFileCancelled: (transferId) => {
        // 终态一律收回「网络停滞」（与 `onFileDone` / `onFileFailed` 同一口径）。
        // 漏这一行的后果不是"多一条提示"，而是 `stalledTransfers` 里那一格**永远不会被删**：
        // 用户一晚上取消十次就积十格，`isTransferStalled` 每次渲染都要查它（10-23 审计 P1-A）。
        setTransferStalled(transferId, false);
        // 后端 cancel_file_transfer emit 的：用户手动取消了一条文件发送
        // 前端把这条消息在**所有**缓存会话里标成 cancelled + 刷新传输列表。
        // ⚠️ 写 `cancelled` 不是 `failed`：库里那一笔写的就是 cancelled（INV-P26 把
        // 「用户主动取消」与「自动判死」分成两个口径），而 `loadMessages` 只对当前在看的
        // 会话重查 ⇒ 以前写 failed 时，没在看的会话会把"已取消"一直显示成"发送失败"，
        // 直到用户下次打开那个会话才被库里的真值纠正过来。
        // 5.15.47：这段原先又是手写一遍（跨会话 `Object.entries` + `.find` + 就地改 +
        // 两个前缀自己拼）。收进 `utils/messages` 的两个家：前缀归 `transferFailureMsgIds`、
        // 改状态归 `markStatusInCache`（后者本来就存在，只是当时只收单个 id）。
        const changed = markStatusInCache(
          messages.value,
          transferFailureMsgIds(transferId),
          "cancelled",
        );
        if (changed > 0) app.toast(t("msg.canceled"), "info");
        void refreshTransfers();
      },
      onMessageFailed: (p) => {
        // 事件本身带终态事实：`outbox_sweep` 先把 `messages.status = failed` 与
        // `messages.fail_code` 写好才 emit。所以这里**不回库查**，直接把这一事实盖到
        // 所有缓存了它的会话（含没在看的会话），与 `onFileCancelled` 同一形状。
        // 旧写法把它接到 `onMessageStatusChanged` 上，两头都不对：没在看的会话什么都不做
        //（只能等下次打开重查），正在看的会话为了一行状态重拉一整页 + 整列表重建。
        //
        // 5.16.91：载荷多了 `fail_code` ⇒ 连原因一起盖。只盖 status 也能"看起来对"，
        // 但气泡会退回"发送失败"这句没有信息量的话，直到重启后回库读 —— 而码明明就在事件里。
        markFailureInCache(messages.value, p.msg_id, p.fail_code);
      },
      onMessageStatusChanged: (msgId, status) => {
        // 后端 emit 的状态变更事件（取消 / 补发 / 删好友 / 群文件终态）。
        //
        // ⚠️ 文件 / 群文件的状态变更同时是**一条传输行的终态**（群文件接收失败就只走这条）。
        // 只重拉会话不动 `transfers` 的话，全局面板与气泡会继续显示「接收中 X%」——
        // 正是 R-14 那一族"只能靠重启恢复"的残留。补拉是防抖的，多次事件不会放大 IPC。
        //
        // 2026-10-25：消息通道的状态变更也会改**任务中心**（取消/失败/送达会让补发行出现或消失），
        // 所以补拉不再只认文件前缀 —— 所有状态变更都走同一条防抖刷新。
        scheduleTransfersRepair();
        if (status) {
          // 事件带结论（审计第 4 项）：`status` 就是后端刚写进 `messages.status` 的值
          //（取消落 cancelled / partial_cancelled、补发落 sending / sent、删好友落 failed、
          // 群文件收尾落 failed）。直接盖到**所有**缓存了这条消息的会话（含没在看的），
          // 与 `onMessageFailed` / `onFileCancelled` 同形 —— 不回库查、不整页重建。
          // 修复前只重查活跃会话：没在看的会话缓存停到下次打开，取消/补发/删好友在
          // 后台会话里一直不更新（重发入口判据 `status === "failed"` 也跟着失真）。
          // 直接盖是安全的：载荷就是库里那一份的值，事件按写库顺序到达，后到的事件
          // 带更新的值；`markStatusInCache` 幂等（相同状态跳过）。
          markStatusInCache(messages.value, msgId, status);
          return;
        }
        // 不带结论（群文件聚合台账 / done 闸门 / 写库失败那一族）：真相不是单一状态，
        // 只重查**活跃**会话（loadMessages 的结果对非活跃会话必被 activeConv 守卫丢弃，
        // 两次 IPC 纯浪费；切换回来时 openConversation 会重查）。
        // （修复前它还会顺带把全局 loadSeq +1，取消活跃会话飞行中的加载 →
        //   骨架永久转圈，见 2026-09-23 审计 1.4。）
        const convId = activeConv.value;
        if (convId && messages.value[convId]?.some((m) => m.msg_id === msgId)) {
          void loadMessages(convId);
        }
      },
      onGroupDeliveryChanged: (p) => {
        // 台账变了（Ack 落地 / 取消剩余成员 / 补发 / 清扫判死）：只重拉那个群的摘要。
        // 不回库重查消息、也不自己改计数 —— 计数来自台账，猜测会造出第二套状态机。
        void refreshGroupDeliveries(`group:${p.group_id}`);
        // 同一份台账也是任务中心「还有几人没收到 / 还能不能取消」的来源。
        scheduleTransfersRepair();
      },
      onPeerStyle: (p) => {
        app.applyPeerStyle(p.device_id, p.style);
      },
      onGroupsUpdated: () => {
        // 群密钥建群 / 群改名 / 成员变更：本地群表与会话标题可能都变了
        void refreshGroups();
        void refreshConversations();
      },
      onGroupHistoryProgress,
      onGroupMemberRemoved: (groupId) => {
        // 被移出群：后端已删本地群，前端关闭会话 + 刷新
        void handleSelfRemovedFromGroup(groupId);
      },
      onContentAudience: (p) => {
        // 消息已经发出去了，这里只是解释「群里有成员版本较旧，会把这条看成一段原始文本」。
        // 整句由后端拼（判据与文案在同一处），所以这里不再走 i18n、也不再自己组句子。
        app.toast(p.hint, "info");
      },
      onDataCleared: () => {
        void resetAfterDataCleared();
      },
      onGroupFileLog,
      // 桌面端「点了系统通知」：后端已经唤起主窗口，这里只切界面（见 routeNotificationClick）。
      onNotificationClicked: (p) => {
        routeNotificationClick(p.type, p.conv_id, p.msg_id);
      },
    }).then((fns) => {
      for (const f of fns) scope.onDispose(f);
      eventBridgeOk.value = true;
    }).catch((e) => {
      // 见 init 开头的说明：不兜底的话 init 会 reject，而骨架照常撤除 ——
      // 用户看到一个"正常"的界面，却永远收不到任何事件。必须留痕 + 可感知。
      console.error("[chat] bindEvents 失败：实时事件不可用", e);
      // 留痕之外还要**常驻**可见（R-33）：toast 会自己消失，之后无从判断是不是已经断了。
      eventBridgeOk.value = false;
      app.toast(t("chat.eventBindFail"), "error");
    });

    // 初始刷新：每个独立兜底（2026-09-23 审计 1.6）—— 任一失败只影响该数据源
    // （对应事件/下次刷新会补上），不得阻断其他刷新，更不得阻断已注册的监听。
    const names = [
      "refreshFriends",
      "refreshConversations",
      "refreshPending",
      "refreshOutgoingRequests",
      "refreshGroups",
      "refreshTransfers",
      "refreshPeers",
      "refreshAnnouncements",
      "refreshKeyRotations",
    ] as const;
    const results = await Promise.allSettled([
      refreshFriends(),
      refreshConversations(),
      refreshPending(),
      refreshOutgoingRequests(),
      refreshGroups(),
      refreshTransfers(),
      refreshPeers(),
      refreshAnnouncements(),
      refreshKeyRotations(),
    ]);
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[chat] 初始刷新 ${names[i]} 失败`, r.reason);
      }
    });
    initialized.value = true;

    // 恢复上次打开的会话（若仍存在）。HIG State Restoration：重启后回到上次离开的地方。
    // 用 void 触发：不阻塞 init，也避免其异步失败拖垮启动。
    const last = storageGet(LAST_CONV_KEY);
    if (last && conversations.value.some((c) => c.id === last)) {
      void openConversation(last);
    }

    // 移动端注册通知动作类别（「标记已读」按钮）。桌面端无此能力（Web Notification 不支持按钮），
    // 命令也不存在，故只对移动端调用。语言切换后按钮文案不随动（原生注册一次），可接受。
    if (app.isMobile) {
      void registerActionTypes([
        {
          id: "chat",
          actions: [{ id: "mark-read", title: t("notification.markRead") }],
        },
      ]).catch(() => {
        /* 注册失败不影响通知主体（只是没有动作按钮） */
      });
      // 强提醒专属通道（High 重要级）：必须在首条强提醒之前建好。
      void ensureRemindChannel(false);
      // 振动设置变化 ⇒ remove+create 重建通道（Android 不允许原地改通道振动）。
      // 声音不在此列：插件只能设自定义 raw 声、不能静音，通道声由用户在系统设置管，
      // 为声音开关重建反而会清掉用户对通道的手动定制。
      // ⚠️ watch 建在 init 里，停止句柄必须挂 scope：init 重入（HMR/重连）时
      // 不挂就会每轮叠一个活监听器，切一次设置重建 N 次通道。
      const stopRemindChannelWatch = watch(
        () => app.remindVibrate,
        () => {
          void ensureRemindChannel(true);
        },
      );
      scope.onDispose(stopRemindChannelWatch);
    }
    // 注册系统通知点击回调：点击通知 → 唤起窗口 + 定位到发送者会话
    onAction((n) => {
      // 兼容不同平台回调形状：对象 { id, actionId, extra } 或裸 id（number/string）
      const raw = (typeof n === "object" && n !== null
        ? n
        : { id: n }) as {
        id?: unknown;
        actionId?: string;
        extra?: Record<string, unknown>;
      };
      const id = typeof raw.id === "number" ? raw.id : undefined;
      const extraType = raw.extra?.type as string | undefined;

      // 「标记已读」动作按钮：不唤起窗口，只把该会话标为已读（发已读回执 + 清未读角标）
      if (raw.actionId === "mark-read") {
        let convId = id != null ? notifMap.get(id) : undefined;
        if (!convId && raw.extra?.conv_id) convId = String(raw.extra.conv_id);
        if (id != null) notifMap.delete(id);
        if (convId) {
          void sendReadReceipt(convId);
        }
        return;
      }

      // 点击通知本体：无论能否解析出会话/类型，先把窗口弹到前台
      // （最小化/隐藏/被遮挡时都恢复，unminimize+show+set_focus 幂等）
      void api.focusWindow();

      let convId = id != null ? notifMap.get(id) : undefined;
      if (!convId && raw.extra?.conv_id) convId = String(raw.extra.conv_id);
      // 强提醒通知：点击后还要定位到原消息（extra 由后端组通知时带上）
      const msgId = raw.extra?.msg_id != null ? String(raw.extra.msg_id) : undefined;
      if (id != null) notifMap.delete(id);
      routeNotificationClick(extraType, convId, msgId);
    }).then((listener) => {
      // `onAction` 返回的是 PluginListener 对象（要显式 `unregister()`），
      // 之前那句 `void onAction(...)` 把返回值直接丢了 —— 回调永久挂在插件上。
      scope.onDispose(() => {
        listener.unregister().catch(() => {
          /* 插件 IPC 抖动，不牵连其它卸载器 */
        });
      });
    }).catch((e) => {
      // 注册失败只影响"点通知跳转"，不影响其余事件；留痕而不是静默吞掉。
      console.error("[chat] 通知点击回调注册失败：点系统通知不会定位到会话", e);
    });
    // 窗口重新可见：补发当前会话已读回执 + 冲刷后台期间滞留的消息批次
    // （具名函数 + 成对 removeEventListener：匿名 handler 摘不掉，重复 init 会叠加）
    const onVisibility = () => {
      if (document.hidden) return;
      // 强制冲刷而不是 scheduleFlush()（2026-09-23 审计 1.7）：后者会被
      // `if (flushScheduled) return` 挡回 —— rAF 在后台被暂停/丢失时 flag 卡在
      // true，兜底就永远是死代码。flushNow 幂等且立即生效。
      if (getPending().length) flushNow();
      // **自愈**：会话表与传输表是"事件只带 id、前端就地改内存"那一类事件的真相源
      //（`message-acked` / `message-failed` / `peer-read` / `file-*` / `file-cancelled`）。
      // 事件在后台丢了、或者窗口隐藏期间根本没投递到 ⇒ 不重拉就永久错下去：
      // 未读数、"已送达"勾、传输进度都可能停在一个从来没发生过的状态上。
      // 两件各自独立兜底（审计 1.6 同一条理由）：一边失败不影响另一边。
      void refreshConversations().catch((e) => {
        console.error("[chat] 回到前台重拉会话失败（未读数可能停留）", e);
      });
      void refreshTransfers().catch((e) => {
        console.error("[chat] 回到前台重拉传输表失败（进度可能停留）", e);
      });
      // 同 `debounceMarkRead`：回到前台也要确认"聊天视图真的可见"才补发已读回执
      if (activeConv.value && app.chatVisible) {
        // 刻意先把 id 取进局部变量：await 期间用户可能已经切走，回调里再读
        // `activeConv.value` 会把**新**会话的红点清掉而根本没给它发已读。
        const convId = activeConv.value;
        void sendReadReceipt(convId);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    scope.onDispose(() => document.removeEventListener("visibilitychange", onVisibility));
  }

  return {
    peers,
    friends,
    initialized,
    eventBridgeOk,
    groupFileDiag,
    friendsLoaded,
    friendsError,
    transfersError,
    contentTransfersError,
    messageOpsError,
    groupReadsErrors,
    conversationsLoaded,
    groupsLoaded,
    pendingRequests,
    outgoingRequests,
    conversations,
    groups,
    transfers,
    contentTransfers,
    messageOps,
    updaterStatus,
    refreshUpdaterStatus,
    operations,
    liveOperationCount,
    messages,
    groupDeliveries,
    refreshGroupDeliveries,
    groupReads,
    groupHistorySync,
    groupReaderIds,
    activeConv,
    mentionedConvs,
    activeConversation,
    totalUnread,
    unreadJump,
    locateRequest,
    clearLocateRequest,
    locateMessageInConv,
    locateInLoaded,
    nicknameOf,
    init,
    refreshPeers,
    searchNearbyPeers,
    refreshFriends,
    refreshPending,
    refreshConversations,
    /** 待确认的好友密钥轮换候选（device_id -> 候选），聊天顶部横幅的数据源。 */
    keyRotations,
    refreshKeyRotations,
    syncFriendKeys,
    syncGroupHistoryNow,
    cancelGroupHistory,
    /** 群 → 「与我相关的未完成任务」数（蓝色徽标的数据源，判定见 `utils/todos::openTodosForMe`） */
    openTodoByConv,
    groupTodoRows,
    groupTodoRowsErrors,
    ensureGroupTodoRows,
    refreshGroups,
    resetAfterDataCleared,
    refreshTransfers,
    stalledTransfers,
    isTransferStalled,
    transferStallReason,
    favorites,
    refreshFavorites,
    addFavorite,
    addFavorites,
    removeFavorite,
    deleteMessages,
    openConversation,
    loadMessages,
    messageLoadErrors,
    loadMoreMessages,
    historyLoadErrors,
    clearHistoryError,
    loadGroupTodos,
    todosLoadedOnce,
    watchGroupTodos,
    send,
    resend,
    markResending,
    sendReminder,
    shakeConversation,
    shakeSignal,
    nudgeNotice,
    confirmReminder,
    sendFriendRequest,
    cancelFriendRequest,
    refreshOutgoingRequests,
    respondRequest,
    removeFriend,
    deleteConversation,
    setConversationPinned,
    sendReaction,
    sendDmReaction,
    recallMessage,
    setMessageRender,
    pinMessage,
    publishAnnouncement,
    deleteAnnouncement,
    refreshAnnouncements,
    activeAnnouncements,
    createTodo,
    updateTodo,
    createGroup,
    renameGroup,
    addGroupMember,
    removeGroupMember,
    transferGroupCreator,
    leaveGroup,
    handleSelfRemovedFromGroup,
    sendFileTo,
    sendGroupFileTo,
    sendImage,
    clearAllData,
    enqueueMessage,
  };
});

// Vite HMR：**改了 store 必须让新 store 生效**。
//
// 踩坑（用户实测"点设置卡、过一会儿弹出好几个设置、主题延迟切换"）：Pinia 的 store 是
// 缓存过的单例，**不接 HMR 就一直是旧实例** —— 我这一轮给 store 新增了 `channels` /
// `channels`/`setChannelEnabled`，而用户长时间运行的 dev 会话里还是旧 store ⇒ 设置页里
// `app.setChannelEnabled is not a function`、`channels.value.find` 抛错 ⇒ **整页渲染卡死**
// （一个分区渲染抛错，Vue 之后再也 patch 不动这个页面）。加上这一行之后，
// 以后改 store 都不必重启 dev。
if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot));
