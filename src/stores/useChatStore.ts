import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api, bindEvents, emitAction, NAVIGATE_TO_CONTACTS } from "@/api";
import {
  applyConversationSnapshot,
  applyIncomingToConversations,
  applyReplacements,
  appendLocalOnly,
  existingIdsFor,
  furthestStatus,
  mergeMessages,
  markStatusInCache,
  freshMentionedConvs,
  findFirstMessageById,
  patchMessageInConv,
  pickMediaContent,
  preserveDeliveryStatus,
  replaceMessageAt,
  transferFailureMsgIds,
  replaceOptimistic,
  promoteOnPeerRead,
  previewText,
  pruneUnreadClears,
  selectCachedConversations,
  sortConversations,
  statusSnapshotFor,
  syncProfileFromPeers,
  unreadAnchorIndex,
} from "@/utils/messages";
import { safeStorageBackend, storageGet, storageSet } from "../utils/safeStorage.ts";
import { useAppStore } from "@/stores/useAppStore";
import { clearWhenFull, trimOldest } from "@/utils/bounded";
import { isStaleNudge } from "@/utils/nudge";
import { prefersReducedMotion } from "@/utils/platform";
import { shouldRunThrottled } from "@/utils/defer";
import { createInitScope, type InitScope } from "@/utils/initScope";
import { StaleGuard } from "@/utils/staleGuard";
import { progressAdvanced, stallFlagAlive } from "@/utils/transferProgressWatch";
import { createSingleFlight } from "@/utils/singleFlight";
import { EMPTY_STRING_LIST } from "@/utils/emptyList";
import { actionableRequests } from "@/utils/friendRequests";
import { fileFailReasonText } from "@/utils/fileFailReason";
import { resolveMemberName } from "@/utils/memberName";
import {
  observeMemberNames,
  readMemberNames,
  writeMemberNames,
  type MemberNameCache,
} from "@/utils/memberNameCache";
import { mergeNoticesInto, notificationBody, type QueuedNotice } from "@/utils/notifications";
import { batchIsUrgent } from "@/utils/notifyUrgency";
import {
  buildRemindAckPayload,
  buildRemindPayload,
  foldReminders,
  parseRemind,
} from "@/utils/reminders";
import { buildReactionPayload } from "@/utils/reactions";
import { isRenderedInTimeline, countsTowardUnread } from "@/utils/messageKinds";
import {
  foldTodos,
  isTodoRowsLoaded,
  mergeIncomingTodoRows,
  openTodosForMe,
  putTodoRows,
  type TodoRowsByConv,
  todoTerminalForCreator,
  todoMentionsMe,
  type TodoImage,
} from "@/utils/todos";
import { invalidateFilePreview, dropFilePreview, clearFilePreviews } from "@/utils/filePreview";
import { clearFavoritePreviews } from "@/utils/favoritePreview";
import { t } from "@/i18n";
import { mergePeerList } from "@/utils/peerMerge";
import { markFriendsOnlineFrom } from "@/utils/friendOnline";
import {
  createChannel,
  Importance,
  onAction,
  registerActionTypes,
  removeChannel,
  sendNotification,
  Visibility,
} from "@tauri-apps/plugin-notification";
import type {
  Conversation,
  FileDoneInfo,
  FileFailedInfo,
  FileProgress,
  FileStalledInfo,
  FavoriteEntry,
  Friend,
  FriendKeyRotation,
  Group,
  GroupDeliverySummary,
  GroupHistoryProgress,
  GroupReadInfo,
  MessageRecord,
  Peer,
  PendingMessageOp,
  PendingRequest,
  UpdaterStatus,
  ContentTransfer,
  TransferInfo,
} from "@/types";
import {
  countOperations,
  deriveOperations,
  sortOperations,
  type OperationRow,
} from "@/utils/taskCenter";

/** 上次打开的会话（重启后恢复，纯前端 UI 状态，各端统一）。 */
const LAST_CONV_KEY = "gosslan.lastConv";

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
  let notifSeq = 1;
  // ⚠️ 只加不删（审计阶段 4 · 4.2 顺带发现）：删除点只有"通知被点击"和"动作按钮命中"两处，
  // 用户直接把通知划掉时条目永久留着，而 `notifSeq` 单调递增 ⇒ 每条通知必进一份。
  // 比 pendingAcks 更确定性地增长，所以同样上闸；上限 128 远大于一屏可见的通知数。
  const notifMap = new Map<number, string>();
  const NOTIF_MAP_MAX = 128;

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

  // ---------------- 通知：抑制 + 短窗口合并 ----------------
  // 抑制矩阵：前台且正查看该会话 → 不通知；其他会话 / 后台 → 进入合并队列。
  // 合并：首条消息开 1.5s 窗口，窗口内同会话只累积；窗口结束按会话各发一条
  // （count > 1 显示「…等 N 条新消息」）。窗口结束前用户已切到该会话 → 跳过。
  const NOTIFY_DEBOUNCE_MS = 1500;
  const notifyQueue = new Map<string, QueuedNotice>();
  let notifyTimer: number | null = null;

  function queueNotification(rec: MessageRecord) {
    const q = notifyQueue.get(rec.conv_id);
    if (q) {
      q.count += 1;
      q.last = rec;
    } else {
      notifyQueue.set(rec.conv_id, { count: 1, last: rec });
    }
    if (notifyTimer !== null) return;
    notifyTimer = window.setTimeout(() => {
      notifyTimer = null;
      flushNotifications();
    }, NOTIFY_DEBOUNCE_MS);
  }

  function flushNotifications() {
    const entries = [...notifyQueue.values()];
    notifyQueue.clear();
    // 用户关了通知 → 一条都不发；权限在这条之后才去查（关着就不该弹权限）
    if (!app.notifyEnabled || entries.length === 0) return;
    void app.ensureNotifyPermission().then((granted) => {
      if (!granted) return;
      // 只要这一批里真的弹出了通知，就顺手提请注意（Windows 闪任务栏 / macOS 弹跳 Dock）。
      // 放在这里而不是 maybeNotify：闪烁必须与**实际发出的通知**同进同出 —— 通知被去抖
      // 合并、被"正在看该会话"跳过时，用户不该被闪。循环后统一触发一次，
      // 同一批多个会话也只闪一次（逐条调用是同一次视觉事件的重复请求）。
      let anyReminded = false;
      for (const { count, last } of entries) {
        // 窗口期间用户已切到该会话且**可见**前台 → 该会话跳过通知
        if (!document.hidden && document.hasFocus() && activeConv.value === last.conv_id) continue;
        const title = nicknameOf(last.sender_id);
        const body = notifyBody(count, last);
        const convId = last.conv_id;
        anyReminded = true;
        if (app.isMobile) {
          // 移动端：plugin 通知（Android 有 actionPerformed 点击事件桥）。
          // 注意 `sendNotification` 是 fire-and-forget（返回 void，不是 Promise）⇒ 这里
          // 没有可 catch 的失败信号，清单 4.2 说的"无 catch 丢批"其实不成立；真正会 reject
          // 的是上面那次权限查询，它的 catch 在本函数末尾。
          const id = notifSeq++;
          notifMap.set(id, convId);
          trimOldest(notifMap, NOTIF_MAP_MAX);
          void sendNotification({
            id,
            title,
            body,
            autoCancel: true,
            // 「标记已读」动作按钮：见 init 里 registerActionTypes；桌面端 Web Notification 不支持按钮
            actionTypeId: "chat",
            extra: { type: "chat", conv_id: convId },
          });
        } else {
          // 桌面端：统一走 notify_desktop 命令（Rust → notify-rust）。
          //
          // 为什么不再用 WebView 原生 Notification：Tauri 的 notification 插件会把
          // window.Notification 换成“转发到 plugin:notification|notify”的实现，所以
          // 这里的 onclick 永远不会触发（点击无法定位会话）；而且那条链路把真正的
          // toast 错误 spawn 掉丢了 —— Windows 上“收不到通知”完全没有线索。
          // 现在由后端发送：失败会返回并记日志，设置页还能“发送测试通知”自检。
          // `convId` 是**点击定位**的依据：点击发生在后端，前端补不了这个信息。
          void api.notifyDesktop(title, body, convId).catch(() => {
            /* 通知失败不影响聊天本身；后端已记日志 */
          });
        }
      }
      if (anyReminded && !app.isMobile) {
        // 紧急程度按**这批真正发出去的通知**判（`entries` 就是去抖合并后的那批，
        // 每个会话取其最后一条），不是按整个未读列表 —— 否则一条三天前的紧急任务
        // 会让每次新消息都弹跳 Dock。
        const urgent = batchIsUrgent(entries.map((e) => e.last));
        requestAttentionOnce(urgent);
      }
    }).catch((e) => {
      // ⚠️ 本批修的正是这里：`flushNotifications` **先 `clear()` 再 await 权限**，
      // 而这条链原先没有 catch ⇒ `isPermissionGranted()` / `requestPermission()` 任一 IPC
      // reject，这批通知就彻底消失（用户少收一条，毫无线索，还附赠一条 unhandled rejection）。
      // 放回队列是安全的：失败点在**任何一条通知发出之前**，不会重复提醒。
      console.warn("[notify] 权限查询失败，这批通知退回队列", e);
      mergeNoticesInto(notifyQueue, entries);
    });
  }

  /**
   * 提请注意（Windows 闪任务栏 / macOS 弹跳 Dock）的**唯一字面调用点** ——
   * 守卫钉"只此一处"：打断必须与"通知确实已发出"同进同出。普通消息批在
   * `flushNotifications`（去抖合并后）调；强提醒在 `handleIncomingRemind`
   * （通知命令返回 sent=true 后）调。两处都不许直接写 api.requestAttention。
   */
  function requestAttentionOnce(urgent: boolean) {
    if (app.isMobile) return; // 移动端没有任务栏/Dock 可闪（命令本身也是空实现）
    void api.requestAttention(urgent).catch(() => {
      /* 个别 Linux 桌面环境不支持闪烁，忽略即可（通知本身已经发出） */
    });
  }

  // ---------------- 未读外显（托盘红点 / 任务栏角标 / Dock 数字） ----------------
  // 为什么不跟通知一起做：通知回答"刚来了一条新消息"，角标回答"还有多少条没读"。
  // 标记已读、切会话、删会话都会改未读数，却不该弹任何通知 —— 所以这条链路跟着
  // `totalUnread` 走，而不跟着消息走。
  //
  // 去抖 300ms：消息洪水、或"一键已读"会让 totalUnread 连续跳好几次，而 Windows 上换
  // 托盘图标是**肉眼可见的一下**（图标被重建）；只推最后一次就够了。
  const BADGE_DEBOUNCE_MS = 300;
  let badgeTimer: number | null = null;
  let lastBadgeCount = -1;

  function pushUnreadBadge() {
    if (app.isMobile) return; // 移动端没有托盘可改（命令本身也是空实现，省一次 IPC）
    const n = totalUnread.value;
    if (n === lastBadgeCount) return; // 值没变就不去动系统图标
    lastBadgeCount = n;
    void api.setUnreadBadge(n).catch(() => {
      /* 角标失败不影响聊天（个别 Linux 桌面环境不支持） */
    });
  }

  watch(totalUnread, () => {
    if (badgeTimer !== null) window.clearTimeout(badgeTimer);
    badgeTimer = window.setTimeout(() => {
      badgeTimer = null;
      pushUnreadBadge();
    }, BADGE_DEBOUNCE_MS);
  });

  /**
   * 通知正文：按「显示消息内容」隐私开关决定是否带正文。
   * 关掉时只提示"收到新消息"（锁屏 / 通知中心不泄内容），标题仍保留发送者昵称。
   * 拼装逻辑在 utils/notifications.ts（纯函数、有单测），这里只喂入实时数据。
   */
  function notifyBody(count: number, last: MessageRecord): string {
    let preview = previewText(last);
    const terminal = todoTerminalForCreator(last, myDeviceId.value);
    if (terminal !== null) {
      // 我创建的任务进入终态：通知里明确说「已完成 / 标记为做不了」，而不是笼统的「[任务] 标题」。
      preview = terminal.status === "impossible"
        ? (terminal.title
          ? t("todo.impossibleNotice", { title: terminal.title })
          : t("todo.impossibleNoticeNoTitle"))
        : (terminal.title
          ? t("todo.completedNotice", { title: terminal.title })
          : t("todo.completedNoticeNoTitle"));
    } else if ((last.kind === "todo" || last.kind === "todo_update") && todoMentionsMe(last, myDeviceId.value)) {
      // 任务 @ 我：预览前缀「@你」，让锁屏/通知中心一眼看出是点名我
      // （与「有人@我」徽标同口径：被指派人 = 被 @）。
      preview = `${t("todo.mentionYou")} ${preview}`;
    }
    return notificationBody(
      {
        showContent: app.notifyShowContent,
        count,
        sender: nicknameOf(last.sender_id),
        preview,
      },
      t,
    );
  }

  /** 已提示过的「任务完成」msg_id：同一事件经多条投递路径反复 emit 时不重复提示创建人。 */
  const notifiedTodoDone = new Set<string>();
  const NOTIFIED_TODO_DONE_MAX = 500;

  function maybeNotify(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;

    // 任务进入终态（完成 / 做不了）→ 给**创建人**提示。`todo_update` 本是静默事件
    //（不打扰全群），但"我派的活有了结论"对创建人是个该知道的变化，单独放行；
    // 其余静默事件照旧不弹。按 msg_id 去重：同一事件经多条投递路径反复 emit 时不重复提示。
    const terminal = todoTerminalForCreator(rec, myId);
    if (terminal !== null && !notifiedTodoDone.has(rec.msg_id)) {
      notifiedTodoDone.add(rec.msg_id);
      trimOldest(notifiedTodoDone, NOTIFIED_TODO_DONE_MAX);
      const terminalText = terminal.status === "impossible"
        ? (terminal.title
          ? t("todo.impossibleNotice", { title: terminal.title })
          : t("todo.impossibleNoticeNoTitle"))
        : (terminal.title
          ? t("todo.completedNotice", { title: terminal.title })
          : t("todo.completedNoticeNoTitle"));
      // 正看着该会话：系统通知会被抑制，改用应用内 toast —— 否则创建人"什么都看不到"。
      if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) {
        app.toast(terminalText, "info");
        return;
      }
      if (!app.notifyEnabled) return;
      queueNotification(rec);
      return;
    }

    // 「不打扰」一族（表情回应/撤回 = 静默事件，`system` = 经广播来的成员变更与下载请求）
    // 一律不弹通知：它们不是"内容"。判据与后端 `is_non_notifying_kind` 同一份
    // （`utils/messageKinds::countsTowardUnread`），与未读记账那处（`utils/messages.ts`）也同一份。
    // 系统消息漏这一条的真实后果："X 加入了群聊"给群里每个人推一条系统通知，
    // 而后端明写它不打扰（`protocol.rs::is_non_notifying_kind` 就是这个理由）。
    if (!app.notifyEnabled) return;
    if (!countsTowardUnread(rec.kind)) return;
    // 应用在前台且正查看该会话 → 不通知（不进队列）。
    // 必须同时判 !document.hidden：窗口被隐藏/最小化到托盘时，WebView 的
    // document.hasFocus() 仍可能是 true，只看它会漏掉真正该提醒的消息。
    if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) return;
    queueNotification(rec);
  }

  // ---------------- 强提醒：接收处理（与普通消息通知分开） ----------------
  // 已在本机处理过的 remind msg_id：多投递路径 / 重复帧只生效一次（不再回执、不再响）。
  const remindedIds = new Set<string>();
  const REMINDED_IDS_MAX = 512;
  /** 独立抖动的去重集合（与强提醒分开：抖动不产生任何回执/折叠状态）。 */
  const nudgedIds = new Set<string>();
  /**
   * 会话内临时抖动提示（不落库、不导出、不进虚拟列表）：
   * `from` = 发起方 device_id；发送方自己也会收到一条「已向对方发送」。
   */
  const nudgeNotice = ref<{ convId: string; from: string; at: number } | null>(null);
  let nudgeNoticeTimer: number | null = null;
  function showNudgeNotice(convId: string, from: string) {
    nudgeNotice.value = { convId, from, at: Date.now() };
    if (nudgeNoticeTimer !== null) window.clearTimeout(nudgeNoticeTimer);
    nudgeNoticeTimer = window.setTimeout(() => {
      nudgeNotice.value = null;
      nudgeNoticeTimer = null;
    }, 5000);
  }

  /**
   * Android 强提醒通知通道：High 重要级 = 横幅弹出 + 锁屏可见，声音/振动跟随通道设置。
   * 插件约定「通道不存在时带 channelId 的通知不会发出」⇒ init 必须先建；
   * 声音/振动开关变化时 remove+create 重建（Android 不允许直接改已建通道的声/振）。
   * 用户在系统设置里对通道的手动修改不被覆盖（只有我们自己的开关变化才重建）。
   */
  const REMIND_CHANNEL_ID = "gosslan_remind";
  let remindChannelReady = false;
  async function ensureRemindChannel(recreate: boolean) {
    if (!app.isMobile) return;
    try {
      if (recreate) await removeChannel(REMIND_CHANNEL_ID).catch(() => {});
      await createChannel({
        id: REMIND_CHANNEL_ID,
        name: t("msg.remind"),
        description: t("remind.channelDesc"),
        importance: Importance.High,
        visibility: Visibility.Public,
        lights: true,
        vibration: app.remindVibrate,
        // 声音不传：tauri-plugin-notification 2.x 只支持「自定义 raw 资源」，
        // 不支持 setSound(null) 静音 —— 空串等于跳过 setSound，通道仍是系统默认声。
        // Android 的通道声音只能由用户在系统通道设置里关（文案已如实说明）。
      });
      remindChannelReady = true;
    } catch {
      // 建不上就不带 channelId 发（走系统默认通道），不能让通知整条丢掉。
      remindChannelReady = false;
    }
  }

  // ---------------- 强提醒的窗口抖动（收到时的视觉表达） ----------------
  /**
   * 抖动信号（自增计数）：触发聊天窗口抖动动画的**唯一入口**。
   * 用计数而非布尔 —— 连续收到强提醒时只有值变化才能让 `watch` 每次都重放动画。
   */
  const shakeSignal = ref(0);
  /** 抖动节流（ms）：防连发强提醒把窗口抖个不停。 */
  const SHAKE_ANIM_MIN_INTERVAL_MS = 1200;
  let lastShakeAt = 0;
  /**
   * 抢占这一次抖动额度。**移动端的 CSS 抖与桌面搬 OS 窗口的抖共用同一份预算** ——
   * 所以判据只有一处（`shouldRunThrottled`，间隔规则与边界都在那个家里），
   * 两条分支各写一遍时间差比较是这一族的旧写法：常量虽然同源，比较方向与
   * 「什么时候把 last 推到 now」却各自定义，改一处就悄悄分成两种预算。
   */
  function claimShakeSlot(): boolean {
    const now = Date.now();
    if (!shouldRunThrottled(now, lastShakeAt, SHAKE_ANIM_MIN_INTERVAL_MS)) return false;
    lastShakeAt = now;
    return true;
  }
  function triggerRemindShake() {
    if (!claimShakeSlot()) return;
    shakeSignal.value += 1;
  }

  /**
   * 收到点名的强提醒（含工具栏「抖动」按钮）时：**把窗口直接拉到前台 + 切到该会话，再抖动**。
   *
   * 用户 2026-10-12：抖动可以不提醒，但窗口要直接给他打开 —— 所以先把窗口/会话带出来再抖，
   * 而不是只在"此刻正看着"时才抖（那样在两个窗口间点一下发送就必然不抖）。
   * 抽成独立函数还有一个原因：`handleIncomingRemind` 的体被 `remindFlow` 守卫按固定长度切片，
   * 调用点只留一行才不会把后面那段通知逻辑挤出切片（切片是守卫判"回执先于通知"的锚）。
   */
  function raiseAndShakeOnRemind(convId: string) {
    void api.focusWindow();
    if (activeConv.value !== convId) void openConversation(convId);
    // 抖动 = **整个 OS 窗口**抖动（Rust 移动窗口，仿 QQ）；移动端没有可移动的独立窗口
    // ⇒ 退回聊天区 CSS 动画（`shakeSignal` → ChatWindow 的 `gosslan-shake`）。
    if (app.isMobile) {
      triggerRemindShake();
      return;
    }
    // 桌面抖的是**整扇 OS 窗口**（Rust 连发 7 次 `set_position`，实测约 315ms），CSS 那条
    // 全局降级管不着它 —— 动效族里只有这一个出口是"JS 不调，系统开关就没人接"。
    // 系统开了「减弱动态效果」时不再搬窗口；提醒本身没丢：上面两行已经把窗口拉到前台、
    // 会话切过去，声音/通知/Dock·任务栏仍在原来的分支上。
    if (prefersReducedMotion()) return;
    if (!claimShakeSlot()) return;
    void api.shakeWindow().catch(() => {});
  }

  /**
   * 接收一条 kind=remind：
   * 1. 判「是不是发给我」：群聊看 actors 名单（受众是名单层语义），私聊恒为对端→我；
   * 2. 按 remind msg_id 去重（R8：同帧重复到达不能反复响 / 反复回执）；
   * 3. 立刻回 stage=alerted 自动回执 —— 只在「帧已确认归属本机」时发，
   *    不挂在本地通知 API 成功上（R1：通知调用成功 ≠ 对方收到 ≠ 用户确认）；
   * 4. 振动（支持的平台）+ 高优先级通知：绕过 1.5s 去抖合并（R2），
   *    但仍尊重总开关 / 权限 / 「前台正查看该会话」的抑制；
   * 5. 声音由后端的系统通知通道处理（系统静音 / 勿扰时由系统决定）。
   */
  /**
   * 接收独立窗口抖动：**不 ack、不建强提醒、不弹普通通知**。
   * 只做「按总开关聚焦/抖窗 + 一条会话内灰字」，60 秒以上的迟到帧直接丢。
   */
  function handleIncomingNudge(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;
    if (isStaleNudge(rec.ts)) return;
    if (nudgedIds.has(rec.msg_id)) return;
    nudgedIds.add(rec.msg_id);
    trimOldest(nudgedIds, REMINDED_IDS_MAX); // Set 迭代保序 ⇒ FIFO
    if (app.notifyEnabled) raiseAndShakeOnRemind(rec.conv_id);
    showNudgeNotice(rec.conv_id, rec.sender_id);
  }

  function handleIncomingRemind(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;
    const payload = parseRemind(rec);
    if (!payload) return;
    if (rec.conv_id.startsWith("group:")) {
      if (!payload.actors.includes(myId)) return;
      // actors 是发起时刻拍的名单；帧到达时本机可能已被移出群（密钥轮换后本解不开
      // 新帧，但轮换前加密的帧仍可能送达）⇒ 以**当前**成员表再校验一次（风险 R6）。
      const gid = rec.conv_id.slice(6);
      const stillMember = groups.value.some(
        (g) => g.id === gid && g.members.includes(myId),
      );
      if (!stillMember) return;
    }
    if (remindedIds.has(rec.msg_id)) return;
    remindedIds.add(rec.msg_id);
    trimOldest(remindedIds, REMINDED_IDS_MAX); // Set 迭代保序 ⇒ FIFO

    // S3 自动回执：此刻帧已通过签名/解密/归属校验（后端落库前已做），与本地通知是否弹出无关。
    void send(rec.conv_id, buildRemindAckPayload(rec.msg_id, "alerted"), "remind_ack").catch(
      () => {
        /* 回执发送失败不影响提醒本身；重连后 outbox 会补发同类帧 */
      },
    );

    // 收到点名的强提醒（含「抖动」按钮）：把窗口拉到前台 + 切到该会话，再抖动窗口。
    const viewing =
      !document.hidden && document.hasFocus() && activeConv.value === rec.conv_id;
    if (app.notifyEnabled) raiseAndShakeOnRemind(rec.conv_id);
    // 总开关关着：不响不振不弹（声音/振动是通知的子集，用户预期一致）。
    // `payload.shake`：工具栏「抖动」发起的帧**只抖不弹**系统通知
    //（用户 2026-10-15「抖动就可以了，不要接强提醒的弹窗通知」）—— 抖动本身已在上一行完成。
    if (!app.notifyEnabled || viewing || payload.shake) return;

    const title = `${t("remind.notifyTitle")} · ${nicknameOf(rec.sender_id)}`;
    const body = app.notifyShowContent
      ? t("remind.notifyBody")
      : t("remind.notifyBodyHidden");

    if (app.isMobile) {
      // Android 13+ 的 POST_NOTIFICATIONS 是运行时权限：被拒就不弹
      //（S3 回执不依赖权限，已在上面发出）。首次收到强提醒时这也是一次合理的申请时机。
      // 振动由通知**通道**承载（按 remindVibrate 建的 High 通道），不再额外调
      // navigator.vibrate —— 两者叠加会震两遍；通道没建成时退回系统默认通道。
      void app.ensureNotifyPermission().then((granted) => {
        if (!granted) return;
        const id = notifSeq++;
        notifMap.set(id, rec.conv_id);
        trimOldest(notifMap, NOTIF_MAP_MAX);
        void sendNotification({
          id,
          title,
          body,
          autoCancel: true,
          actionTypeId: "chat",
          // 通道就绪才挂 channelId（插件约定通道不存在时通知不发出）：
          // 高重要级通道给强提醒横幅 + 系统声/振动；没建上就退回系统默认通道。
          ...(remindChannelReady ? { channelId: REMIND_CHANNEL_ID } : {}),
          extra: { type: "chat", conv_id: rec.conv_id, msg_id: payload.target },
        });
      });
    } else {
      // 桌面：系统通知声音由后端按 remindSound 加；振动无可用 API
      //（WKWebView / WebView2 的 navigator.vibrate 恒为 undefined）；
      // 打断感由 requestAttention（Dock 弹跳 / 任务栏闪烁）承担。
      void api
        .notifyDesktop(title, body, rec.conv_id, {
          msgId: payload.target,
          sound: app.remindSound,
          actionLabel: t("notification.view"),
        })
        .then((sent) => {
          // 强提醒恒按紧急处理（Windows 闪任务栏 / macOS 弹跳 Dock）。
          // ⚠️ 这一路径不经过通知中心、不受勿扰开关影响 —— 设置页需如实说明。
          if (sent) requestAttentionOnce(true);
        })
        .catch(() => {
          /* 后端已记日志 */
        });
    }
  }

  async function handleNotificationClick(convId: string, msgId?: string) {
    await api.focusWindow();
    // 翻页排在加载之前（用户 2026-09-24 #29）：`focusWindow` 必须先行（窗口还在托盘里时
    // 切，用户会在浮出瞬间看到一次跳变），但 `openConversation` 不能等 —— 它内部是
    // 同步写下 `activeConv` + 骨架 + 两轮 IPC 拉消息，await 它等于让移动端
    // 「点通知」白等一次读库才翻页。
    if (app.isMobile) app.mobileView = "chat";
    await openConversation(convId);
    // 强提醒：打开会话后继续翻页定位到**被提醒的原消息**；失败提示而不是静默。
    if (msgId) {
      const r = await locateMessageInConv(convId, msgId);
      if (r === "not-found" || r === "error") {
        app.toast(t("remind.locateFail"), "info");
      }
    }
  }

  /**
   * 通知点击的**统一路由**：桌面端（后端 `notification-clicked` 事件）与移动端
   * （插件的 `actionPerformed`）共用一份 —— 两条路径的载荷同形（`type` / `conv_id` /
   * `msg_id`），各写一份就一定会漂移（"桌面点得动、手机点不动"这类只在某一个平台现形的缺陷）。
   */
  function routeNotificationClick(
    type: string | undefined,
    convId: string | undefined,
    msgId?: string,
  ) {
    if (type === "friend_request") {
      // 唤起窗口后再切视图：窗口还在托盘里时切，用户会在浮出瞬间看到一次跳变。
      void api.focusWindow().then(() => {
        emitAction(NAVIGATE_TO_CONTACTS);
      });
      return;
    }
    if (convId) void handleNotificationClick(convId, msgId);
  }

  // ---------------- 消息合并（同步） ----------------
  // 说明：曾用 Web Worker 后台合并，但 Tauri 生产构建（WKWebView 自定义协议）下
  // Worker 可能加载失败——mergeInWorker 的 Promise 永不 resolve，导致发送/接收的
  // 消息全部卡在合并步骤不刷新（需重开会话走查库路径才能恢复）。
  // 合并本身是 O(n) Set 去重 + 排序（单会话缓存 ≤300 条，微秒级），不值得为它
  // 冒 Worker 失效风险，改为主线程同步合并；rAF 批量节流保留。

  // ---------------- 密集广播批量队列 ----------------
  let pending: MessageRecord[] = [];
  let flushScheduled = false;
  // 乐观记录还在队列里未落地时到达的「真实记录」：tmp msg_id → 后端记录
  const pendingReplace = new Map<string, MessageRecord>();
  // Ack 先于乐观→真实替换到达：msg_id 已知但 store 里还没有该条目。
  // ⚠️ 必须有容量上限（审计阶段 4 · 4.2）：`found` 只扫 `messages.value`（LRU 保留 4 个会话），
  // 所以「会话被淘汰 / 文件回执 / outbox 补投」这三类 Ack 永远命中不了消费点，条目
  // 只会加不会删 ⇒ 跟着运行时长单调增长。这里用 FIFO 兜住最坏情况；真正的删除
  // 仍由 `send()` 消费时做（下面 `pendingAcks.delete`），淘汰只清那些本来就没人要的。
  const pendingAcks = new Set<string>();
  const PENDING_ACKS_MAX = 512;

  /**
   * `msg_id → conv_id` 反查表（审计 P2 #30）：`msg_id` 全局唯一且消息不会换会话，
   * 所以这张表**不需要失效**。Ack 到达时先查它，命中就只在那一个会话里找，
   * 不再遍历所有缓存会话（批量文件回执时原来是 O(会话×消息)）。
   *
   * 表里查不到时退回全量扫描，并在扫描过程中顺手把见到的 id 都记进来 ——
   * 第一条 Ack 之后的平均成本就降到 O(该会话消息数)。条目随消息量增长，与 `messages` 同阶。
   */
  const convIdByMsgId = new Map<string, string>();

  function convIdOfMessage(msgId: string): string | null {
    const known = convIdByMsgId.get(msgId);
    if (known) {
      const list = messages.value[known];
      if (list && list.some((m) => m.msg_id === msgId)) return known;
    }
    for (const [convId, list] of Object.entries(messages.value)) {
      for (const m of list) convIdByMsgId.set(m.msg_id, convId);
      if (list.some((m) => m.msg_id === msgId)) return convId;
    }
    return null;
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    // 后台/遮挡窗口的 requestAnimationFrame 会被浏览器暂停，导致消息滞留不渲染；
    // 窗口不可见时退回 setTimeout，保证任何状态下都能入列渲染。
    if (!document.hidden && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushNow);
      // 安全网（2026-09-23 审计 1.7）：rAF 回调可能在个别平台行为下丢失（既不投递
      // 也不报错），flushScheduled 一旦卡在 true，后续所有 enqueueMessage 都被
      // 开头的守卫挡回 —— 消息永久不渲染且无恢复手段、pending 无上限堆积。
      // 1s 后仍未落地就强制冲刷；rAF 正常时这里是幂等 no-op（flag 已被置回）。
      setTimeout(() => {
        if (flushScheduled) flushNow();
      }, 1000);
    } else {
      setTimeout(flushNow, 0);
    }
  }

  /** 立即冲刷批量队列（幂等：无挂起项时只复位 flag）。 */
  function flushNow() {
    flushScheduled = false;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    void applyIncoming(batch);
  }

  async function applyIncoming(raw: MessageRecord[]) {
    if (raw.length === 0) return;
    // 这两份快照只统计**这一批涉及的会话**。以前它们每批遍历一次全部缓存会话的全部消息
    //（缓存上限内约合每帧上万次 Map/Set 写入，而事件风暴、传文件回填时这个函数每帧跑一次），
    // 换来的信息全部落在批外。判据见 utils/messages.test.ts 那几条真值表。
    const touched = new Set(raw.map((m) => m.conv_id));
    // 快照当前各条目的送达状态，供 applyReplacements 做 furthestStatus 比较
    const curStatus = statusSnapshotFor(messages.value, touched);
    const batch = applyReplacements(raw, pendingReplace, curStatus);
    const byConv = new Map<string, MessageRecord[]>();
    for (const m of batch) {
      const list = byConv.get(m.conv_id) ?? [];
      list.push(m);
      byConv.set(m.conv_id, list);
    }
    // 未读增量只统计「本地真正新增」的消息：后端对同一条业务消息可能经多条投递路径
    // （直连 / outbox 补发 / Gossip 转发）反复 emit `message-received`，若按整批长度累加，
    // 重复投递会一次次 +1，导致「发几条、数字却几十」——未读数虚高的根因。
    // 按 msg_id 与内存已有消息比对后，再据此累加 unread。
    const existingIdsByConv = existingIdsFor(messages.value, touched);
    const newByConv = new Map<string, MessageRecord[]>();
    for (const [cid, list] of byConv) {
      const known = existingIdsByConv.get(cid) ?? new Set<string>();
      const fresh: MessageRecord[] = [];
      for (const item of list) {
        if (known.has(item.msg_id)) continue; // 重复投递：不计入未读
        known.add(item.msg_id);
        fresh.push(item);
      }
      if (fresh.length) newByConv.set(cid, fresh);
    }
    // 任务行同时落进看板那一份源（同一个家）：只写已加载的会话，同 msg_id 是刷新 ——
    // 见 utils/todos::mergeIncomingTodoRows。
    const mergedRows = mergeIncomingTodoRows(groupTodoRows.value, batch);
    if (mergedRows !== groupTodoRows.value) groupTodoRows.value = mergedRows;
    // 被 @ 检测（微信式 [有人@我]）的规则整体搬进 `messages.ts::freshMentionedConvs` ——
    // 三条规则（只群聊 / 非自己发的 / 当前没开着这个会话）与"与未读同源、重复投递不反复触发"都在那里，
    // 并且**有单测**（`messages.test.ts` 那 7 条）。搬走而不是再判一遍：这段原先长在 store 里，
    // 判不到也测不到，2026-09-28 拿真无障碍树读数时因此分不清"该亮没亮"与"正开着所以不算"。
    const myName = app.device?.nickname ?? "";
    const myId = myDeviceId.value;
    for (const cid of freshMentionedConvs(newByConv, activeConv.value, { id: myId, name: myName },
      { alsoMentionsMe: (rec) => todoMentionsMe(rec, myId), activeVisible: chatViewerLooking() })) {
      mentionedConvs.value.add(cid);
    }
    // 会话列表中不存在的会话（新好友 / 后端新创建）：本地合并不了，直接从后端拉取
    const knownIds = new Set(conversations.value.map((c) => c.id));
    const missing = [...byConv.keys()].filter((id) => !knownIds.has(id));
    for (const [convId, incoming] of byConv) {
      // ⚠️ 这里曾是「已有 msg_id 一律丢弃」——但后端对同一条消息存在**回填式重发**：
      // 群文件 Done 之后会再 emit 一条带本地 path 的 gfile 记录（transport 完成回填段），
      // 丢弃它等于气泡永远停在无 path 形态 → 群图片预览打不开（真机 2026-09-19）。
      // 改成 upsert：同 msg_id 以本轮记录刷新内容（DB 是真相），送达状态仍只前进不回退。
      const existing = messages.value[convId] ?? [];
      const indexOf = new Map(existing.map((m, i) => [m.msg_id, i] as const));
      const next = [...existing];
      for (const m of incoming) {
        const i = indexOf.get(m.msg_id);
        if (i === undefined) {
          indexOf.set(m.msg_id, next.length);
          next.push(m);
        } else {
          const prev = next[i];
          // content 不能一律取新的：群文件的 path 是收完才回填的，回填前的后到记录
          // 会把已回填的 path 擦掉 ⇒ 预览请求根本不发出去（空白气泡）。见 pickMediaContent。
          next[i] = {
            ...m,
            content: pickMediaContent(prev, m),
            status: furthestStatus(prev.status, m.status),
          };
        }
      }
      messages.value[convId] = mergeMessages([], next);
      touchCacheOrder(convId);
    }
    // 收完一批就收缩一次缓存（本轮可能让若干非活跃会话的缓存变冷）
    enforceMessageCacheBound();
    if (missing.length > 0) {
      // 新会话：以 DB 为准拉全量（DB 已按新消息 +1），前端不再自行叠加
      await refreshConversations();
    } else {
      conversations.value = applyIncomingToConversations(
        conversations.value,
        activeConv.value,
        newByConv,
        myDeviceId.value,
      );
    }
    // 这批里出现了任务行 ⇒ 徽标要跟着动。这一条同时覆盖了三种来源：
    // 收到别人的任务、自己创建/改任务（`createTodo` 走 `enqueueMessage` → 这里）、
    // 以及 #82 之后本端收到的自己那份 emit。
    if (batch.some((m) => m.kind === "todo" || m.kind === "todo_update")) void refreshOpenTodos();
  }

  /** 批量队列堆积到这个量级就值得说一句（审计 1.7 的软上限）。 */
  const BACKLOG_WARN_AT = 5000;
  /** 同一件事 60s 内只说一次（日志同 key 每 60s 最多 1 行那条规矩，toast 更得守）。 */
  const BACKLOG_NOTICE_MS = 60_000;
  let lastBacklogNoticeAt = 0;

  function enqueueMessage(rec: MessageRecord) {
    pending.push(rec);
    // 批量队列软上限（审计 1.7）：正常情况下 rAF 一帧内就会清空；堆积到这个量级
    // 说明 flush 调度已经失灵（或事件风暴），必须留痕 —— 无告警时它只是安静地吃内存。
    //
    // 判据从 `=== 5000` 改成 `>= 5000`：等值只在那一刻恰好被第 5000 次入队命中才响，
    // 而这条链上没有任何东西保证不会一次推进多行（重连补投那一类）。
    // 配上 60s 限流之后，风暴期也不会变成每帧一行的日志。
    if (pending.length >= BACKLOG_WARN_AT) {
      const now = Date.now();
      if (shouldRunThrottled(now, lastBacklogNoticeAt, BACKLOG_NOTICE_MS)) {
        lastBacklogNoticeAt = now;
        console.error(`[chat] 消息批量队列堆积 ${pending.length} 条：flush 调度疑似失灵`, {
          flushScheduled,
          hidden: document.hidden,
        });
        // 原来只有 `console.error` ⇒ 桌面端用户看不见（devtools 一般是关着的），
        // 症状是"新消息要切一下会话才出来"而没有任何解释（10-22 审计 D-24）。
        // 说一句就够：这一格限流与上面那条日志共用同一个时间戳，不会各说各的。
        app.toast(t("chat.batchBacklog"), "error");
      }
    }
    scheduleFlush();
  }

  // ---------------- 刷新 ----------------
  /**
   * 后发先至守卫（审计阶段 4 · 4.2）。下面这些 `refresh*` 全是 `x.value = await api.foo()`，
   * 而调用点大量是 `void refreshX()`（群操作成对调两个、好友申请通过、gossip 更新…），
   * IPC 又没有顺序保证 ⇒ 旧快照完全可能后回来，把未读、排序、在线状态整体回退。
   * 同文件的 `refreshTransfers` 已经为这个坑单独修过一次（那次是"进度条永久钉在 0%"），
   * 这里把同一个不变量收成一份实现，并按**被写的状态**分 key —— 不按函数分：
   * `refreshPeers` 与 `searchNearbyPeers` 写的是同一个 `peers`，必须互相作废。
   */
  const refreshGuard = new StaleGuard();

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
    const list = await api.getFriends();
    if (!refreshGuard.isCurrent("friends", tok)) return;
    friends.value = list;
    friendsLoaded.value = true;
  }
  async function refreshPending() {
    const tok = refreshGuard.begin("pending");
    const list = await api.getPendingRequests();
    if (!refreshGuard.isCurrent("pending", tok)) return;
    rawPendingRequests.value = list;
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
    const verdict = await api.syncGroupHistoryNow(groupId);
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
  function clearUnreadLocally(convId: string) {
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv && conv.unread !== 0) conv.unread = 0;
    // 水位打在**发起前**的这一刻：晚于快照发起 ⇒ 那份快照里的数字是旧的，不许点亮红点
    unreadClearedAt.set(convId, Date.now());
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

  /** 每个群「与我相关且未完成未归档」的任务数 —— 蓝色徽标的唯一数据源（用户 2026-09-26）。
   *  两处 UI（会话列表条目、聊天头的任务图标）都从这里取，**不在界面里各数一遍**。 */
  const openTodoByConv = ref<Record<string, number>>({});
  /** 每个群「任务相关的消息行」（后端全表读）—— 看板 / 任务面板 / 成员面板的**唯一取数口**。
   *
   *  为什么必须有它，而不能再折 `chat.messages`：徽标早就走全表读，而三处界面折的是那份
   *  **有上界的消息缓存**（`PAGE_SIZE × MAX_PAGES = 1000 条/会话`、`MAX_CACHED_CONVS = 8` 个会话整块逐出）
   *  ⇒ 「徽标还亮着、看板里却再也列不出这条任务」是可达状态，用户没法归档一个看不见的任务。
   *  `refreshConversations` 的注释里那句「用内存里已有的消息算不行」当时只应用在徽标那一半，
   *  于是同一句判据两个家（#154-9）。两者现在来自**同一次读**。
   *  键存在 = 读到过（空数组 = 确实没有任务）；语义见 `utils/todos::putTodoRows`。 */
  const groupTodoRows = ref<TodoRowsByConv>({});
  /** 任务行读失败的原因（键存在 = 这一次首屏读失败且还没有成功过）。 */
  const groupTodoRowsErrors = ref<Record<string, string>>({});
  /** 同一会话的单飞表：三个界面同时要求补读时只打一次 IPC（通用形状走 utils/singleFlight）。 */
  const groupTodoRowsInflight = createSingleFlight<void>();
  /** 读成功（无论走哪条取数口）就清掉这几个会话的失败记录。 */
  function clearGroupTodoRowsErrors(convIds: string[]) {
    let changed = false;
    const next = { ...groupTodoRowsErrors.value };
    for (const cid of convIds) {
      if (!next[cid]) continue;
      delete next[cid];
      changed = true;
    }
    if (changed) groupTodoRowsErrors.value = next;
  }
  /** 单调序号：只有最后一次发起的结果能落地（任务连着变时会话刷新会挨个追上来）。 */
  let openTodoSeq = 0;
  async function refreshOpenTodos() {
    const myId = myDeviceId.value;
    // 身份还没就绪 ⇒ 什么都不做（既不清空也不点亮）：清成 0 会让徽标闪一下消失；
    // 拿空串去比对又会把 `creator: ""` 那类畸形载荷算成"与我相关"。
    if (!myId) return;
    const ids = conversations.value.filter((c) => c.kind === "group").map((c) => c.id);
    if (ids.length === 0) {
      openTodoByConv.value = {};
      return;
    }
    const mine = ++openTodoSeq;
    const rows = await api.getGroupTodoMessages(ids);
    if (mine !== openTodoSeq) return;
    // 同一次读同时喂徽标与那三处界面（见 groupTodoRows 的注释）
    groupTodoRows.value = putTodoRows(groupTodoRows.value, ids, rows);
    clearGroupTodoRowsErrors(ids);
    const byConv = new Map<string, MessageRecord[]>();
    for (const r of rows) {
      const list = byConv.get(r.conv_id) ?? [];
      list.push(r);
      byConv.set(r.conv_id, list);
    }
    const next: Record<string, number> = {};
    // 折叠只有一份：`foldTodos` 出当前定义，`openTodosForMe` 出"还活着且与我相关"。
    for (const [cid, list] of byConv) {
      const n = openTodosForMe(foldTodos(list), myId).length;
      if (n > 0) next[cid] = n;
    }
    openTodoByConv.value = next;
  }

  /** 按需补读某个群的任务行：冷启动只开任务窗、或身份未就绪时 bulk 读没跑成的情况。
   *  已读到过就直接返回 ⇒ 不会每次打开面板都打一次 IPC（"读过没有"就看键在不在）。
   *
   *  三条入口（看板 / 任务弹窗 / 成员面板）会同时要求补读 ⇒ 同一会话**单飞**：
   *  否则每次打开都会打两三份 IPC，而 StaleGuard 只留最后一份，另外几份纯属白读。
   *  失败写进 `groupTodoRowsErrors` 而不向调用方抛：调用点全是 `void`，上一次
   *  未捕获的 rejection 在 Tauri 里只会安静地进控制台，界面继续理直气壮地显示
   *  「暂无任务」—— 与"假空态"是同一个缺陷。 */
  async function ensureGroupTodoRows(convId: string): Promise<void> {
    if (!convId || isTodoRowsLoaded(groupTodoRows.value, convId)) return;
    return groupTodoRowsInflight.run(convId, async () => {
      const tok = refreshGuard.begin(`todoRows:${convId}`);
      try {
        const rows = await api.getGroupTodoMessages([convId]);
        if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
        groupTodoRows.value = putTodoRows(groupTodoRows.value, [convId], rows);
        clearGroupTodoRowsErrors([convId]);
      } catch (e) {
        if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
        groupTodoRowsErrors.value = {
          ...groupTodoRowsErrors.value,
          [convId]: e instanceof Error ? e.message : String(e),
        };
      }
    });
  }

  /**
   * 实时事件后的**单群**重读（独立任务窗专用）。
   *
   * 看板折的是 `groupTodoRows`（全表读，见上），不是有上界的 `messages` —— 早期
   * 独立窗口的实时订阅只重载 `loadMessages`，而看板早就不折那份缓存（提交 51dac87
   * 改了取数口、漏改订阅），表现就是「别人增/改/完成/归档任务，窗口里一动不动，
   * 切走再切回才更新」。这里以 DB 为真相**整表替换这一个群**：去重、防幽灵、
   * 防旧快照回滚全部由 DB 快照与 StaleGuard 承担，不做"按事件增量拼"（事件可能
   * 重复 / 乱序 / 重连后补发，拼错就是第二个真相源）。
   * 与 `ensureGroupTodoRows` 共用同一个 StaleGuard 键 ⇒ 首屏读与事件读互相作废，
   * 只有最后一次发起的结果能落地。读失败保留旧列表（与窗口焦点兜底同口径）。
   */
  async function reloadGroupTodoRows(groupId: string) {
    const convId = `group:${groupId}`;
    const tok = refreshGuard.begin(`todoRows:${convId}`);
    let rows: MessageRecord[];
    try {
      rows = await api.getGroupTodoMessages([convId]);
    } catch (e) {
      // 读失败保留旧列表（下次事件或窗口重新聚焦时再试）；悬空序号由下一次 begin 自行作废。
      // 但"从来没读到过"时不能只留一个空列表：那会被看板当成「暂无任务」，
      // 所以沿用首屏那条错误记录，界面至少给得出错误 + 重试。
      if (!isTodoRowsLoaded(groupTodoRows.value, convId)) {
        groupTodoRowsErrors.value = {
          ...groupTodoRowsErrors.value,
          [convId]: e instanceof Error ? e.message : String(e),
        };
      }
      return;
    }
    if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
    groupTodoRows.value = putTodoRows(groupTodoRows.value, [convId], rows);
    clearGroupTodoRowsErrors([convId]);
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
      list.map(async (group) => [group.id, await api.getGroupReads(group.id).catch(() => [])] as const),
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
    conversations.value = [];
    groups.value = [];
    groupReads.value = {};
    // 与 groupReads 同批清：后端把库清了，那几条"正在补历史"的提示也就没有对应的作业了。
    // 留着它们的表现是设置里清完数据回主界面，横幅还挂着一句"正在同步 320/800"。
    groupHistorySync.value = {};
    rawPendingRequests.value = [];
    transfers.value = [];
    // 收藏也随「清除数据」一并清空（后端删了行与副本）：不清的话，面板开着时仍显示
    // 已删条目，点开只会报"副本已不在本机"。
    favorites.value = [];
    activeConv.value = null;
    pending = [];  // 后台滞留待冲刷的消息批次（`let pending`，见上）
    // 这三张表存的都是"内存里的过渡态"：库已经清了，留着它们会让后续 flush 给已经不存在的
    // 记录重建条目（审计阶段 4 · 4.3）。`clearAllData` 走的是另一条路径，两边必须同口径。
    pendingReplace.clear();
    pendingAcks.clear();
    notifMap.clear();
    // 预览缓存与 `clearAllData` 同口径整份放掉（含**收藏**那份独立缓存 ——
    // 上面刚把 `favorites` 清了，它的 objectURL 留着就是纯粹的死字节）。
    clearFilePreviews();
    clearFavoritePreviews();
    await Promise.all([
      refreshConversations(),
      refreshGroups(),
      refreshTransfers(),
      refreshUpdaterStatus(),
      refreshPending(),
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
  /** 并发触发时只让**最新那次**写回结果（迁入 `refreshGuard`，与上面几个共用同一份实现）。 */
  /**
   * 补拉一次更新状态（设置窗重开、任务中心首帧都靠它 —— 事件只在跃迁时发）。
   *
   * 走 `refreshGuard`：并发补拉时后发先至的旧快照必须丢掉（与 `refreshPeers` 同一条纪律；
   * 直写 `x.value = await api.…()` 是那个族里被点过名的形状）。
   */
  async function refreshUpdaterStatus() {
    const tok = refreshGuard.begin("updater");
    try {
      const st = await api.updaterStatus();
      if (!refreshGuard.isCurrent("updater", tok)) return;
      updaterStatus.value = st;
    } catch {
      // 移动端/权限问题：保持原值（任务中心不列它，设置页也不会假装在下载）
    }
  }

  /**
   * 用户点了「重新发送」并确认过的那几条 msg_id（2026-10-26）。
   *
   * 只用来把任务中心那一行说成「重发中」—— 库里区分不出首次发送与重发（同为 `sending` +
   * 同形的 outbox 行），为一句文案去加一列不值得。⚠️ 它**必须**被剪：每次拉到 `messageOps`
   * 就把已经不在这份台账里的 id 摘掉，否则那条重发成功后，标记会永远留在内存里，
   * 下一次同一 msg_id 再进队列时会凭空显示成「重发中」。
   */
  const resendingIds = ref(new Set<string>());
  function markResending(msgId: string) {
    resendingIds.value.add(msgId);
  }

  async function refreshTransfers() {
    const req = refreshGuard.begin("transfers");
    const [list, contents, msgOps] = await Promise.all([
      api.getTransfers(),
      api.getContentTransfers().catch(() => []),
      // 任务中心的第四类行（还没送到对端的消息）。失败不拖累另两路：
      // 拿不到就当这一类没有任务，而不是让整个传输面板报错——它读的是同一批事实。
      api.getPendingMessageOperations().catch(() => []),
    ]);
    // 后发先至的旧快照必须丢掉：多选发送时每个文件都会 `void refreshTransfers()`，
    // 旧快照里**没有**刚建的那条 transfer ⇒ 覆盖回来后，后续 file-progress 全部落空
    // （见 updateTransferProgress），进度条永久钉在「发送中 0%」——而对端早就收完已读。
    if (!refreshGuard.isCurrent("transfers", req)) return;
    transfers.value = list;
    // 顺带刷新统一内容状态：未完成 / 校验失败的气泡据此显示「点击重试」。
    contentTransfers.value = contents;
    messageOps.value = msgOps;
    // 剪掉已经不在台账里的标记（见上面 `resendingIds` 的注释）。
    if (resendingIds.value.size) {
      const live = new Set(msgOps.map((o) => o.msg_id));
      for (const id of [...resendingIds.value]) if (!live.has(id)) resendingIds.value.delete(id);
    }
  }
  /** 进度/done 事件早于 transfer 行进内存时的一次性补拉（防抖，不放大 IPC）。 */
  let transfersRepairTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleTransfersRepair() {
    if (transfersRepairTimer) return;
    transfersRepairTimer = setTimeout(() => {
      transfersRepairTimer = null;
      void refreshTransfers();
    }, 400);
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
    const readReceipt = api.markRead(id).catch(() => {
      /* 回执失败不回滚已读：本地确实已经看到了 */
    });
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
      messageLoadErrors.value[convId] = e instanceof Error ? e.message : String(e);
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
    // 群会话：顺手取成员级投递台账（气泡角标与「补发」按钮的唯一依据）。
    // 失败不阻塞消息加载 —— 角标拿不到事实时宁可不显示，也不许猜一个数字出来。
    if (convId.startsWith("group:")) void refreshGroupDeliveries(convId);
  }

  /**
   * 拉一个群会话的成员级投递摘要（`get_group_delivery_summaries`）。
   *
   * 只保留该会话的结果；`activeConv` 守卫放在**回填之后**是刻意的：这个函数也会在
   * 会话没打开时被事件调用（补发/取消发生在任务中心），提前丢弃会让下次打开又白拉一次。
   * 失败时保留旧值：暂时读不到 ≠ 一切都送达了。
   */
  async function refreshGroupDeliveries(convId: string): Promise<void> {
    if (!convId.startsWith("group:")) return;
    let list: GroupDeliverySummary[];
    try {
      list = await api.getGroupDeliverySummaries(convId);
    } catch {
      return;
    }
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
          [convId]: e instanceof Error ? e.message : String(e),
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

  // ---------------- 独立「群任务」窗口用的读路径 ----------------
  // ⚠️ 这两个函数是给**独立窗口**（`todos.html`）用的：那个窗口有自己的 store 实例，
  // 只服务一个群。绝不能在那里调 `init()`（会注册第二套事件监听 → 重复通知/未读/回执）
  // 或 `openConversation()`（会发群已读回执、写与主窗口共享的 localStorage）。

  /**
   * 「这个群的任务首屏取完了没有」—— 看板该转圈还是该显示内容的唯一依据。
   *
   * 为什么必须有（用户 2026-09-24：「点查看任务，弹窗弹出很慢，还以为没点上」）：群任务窗口
   * 原先把 `loadGroupTodos` 排在**挂载之前**，那段时间整扇窗是一块骨架灰屏（看不出在加载什么），
   * 而连点又被启动器的单飞/防抖吃掉 ⇒ 表现就是"点了没反应，过一会才蹦出来"。
   * 改成先挂载、数据后台取之后，没有这个标记的话首帧会理直气壮地显示「暂无任务」——
   * 那不是快了一点，那是**假空态**，比慢更糟。
   *
   * ⚠️ 语义是"这一次取数**结束了**"（成功或失败），不是"成功过"：失败也置位，否则
   * 一次 DB 出错就把窗口永久留在转圈上，而那是一个连点都救不回来的状态。
   * 失败由调用方 toast 出来（`src/entries/todos.ts`），本标记只负责"别一直转"。
   */
  const groupTodosSettled = ref<Record<string, true>>({});

  /** 该群的任务首屏是否已取完（未开始与进行中都返回 false ⇒ 看板显示加载态）。 */
  function todosLoadedOnce(groupId: string): boolean {
    return groupTodosSettled.value[groupId] === true;
  }

  /**
   * 群任务窗口的读路径：加载**一个群**的消息 + 解析成员名要用的数据。
   *
   * ⚠️ 不变量：调用方（群任务窗口）的 store 实例**只服务这一个会话**，所以这里
   * 把 `activeConv` 设成它（`loadMessages` 有 `activeConv === convId` 守卫）。
   */
  async function loadGroupTodos(groupId: string): Promise<void> {
    const convId = `group:${groupId}`;
    try {
      // 成员名/群名/头像来自 groups + friends + peers；conversations 让窗口内的
      // `enqueueMessage`（创建/更新任务后本地合并）不必再补一次拉取。
      await Promise.all([refreshGroups(), refreshFriends(), refreshPeers(), refreshConversations()]);
      activeConv.value = convId;
      await loadMessages(convId);
    } finally {
      groupTodosSettled.value[groupId] = true;
    }
  }

  let groupTodosUnlisten: (() => void) | null = null;
  let groupTodosTimer: number | null = null;
  /**
   * 切群竞态的唯一裁决者：`api.onMessageReceived` 是异步的，两次快速切群时
   * **先返回的那次会覆盖后返回的那次**，把新群的监听顶掉（每条消息多一次 reload，
   * 且旧群的监听永远留在总线上）。`StaleGuard` 同时挡住"切到别的群"与"同一个群连订两次"。
   */
  const groupTodosWatchGuard = new StaleGuard();

  /**
   * 只订阅**本会话**的 `message-received`，让窗口里的任务随远端改动实时刷新
   * （突发消息合并到 150ms 一次重拉）。返回取消函数。
   *
   * ⚠️ 去抖后重读的必须是 **`groupTodoRows`（全表读）**：看板折的是那一份，
   * 不是有上界的消息缓存。这里曾重载 `loadMessages`（写 `messages`），看板却
   * 在 51dac87 改成折 `groupTodoRows` ⇒ 别人改任务时订阅收到了事件、也发了 IPC，
   * 看板却一动不动（只有焦点兜底的全量重读碰巧把它刷新）。现在每条事件都以 DB
   * 为真相重拉这一个群的任务行，重复/乱序/补发事件都不会产生重复或回滚。
   */
  async function watchGroupTodos(groupId: string): Promise<() => void> {
    const convId = `group:${groupId}`;
    const token = groupTodosWatchGuard.begin("groupTodos");
    groupTodosUnlisten?.();
    groupTodosUnlisten = null;
    if (groupTodosTimer !== null) {
      window.clearTimeout(groupTodosTimer);
      groupTodosTimer = null;
    }
    const unlisten = await api.onMessageReceived((rec) => {
      if (rec.conv_id !== convId) return;
      // 订阅已过期（切群了）就不再为旧群排重读；监听本身会在下面立刻摘掉。
      if (!groupTodosWatchGuard.isCurrent("groupTodos", token)) return;
      if (groupTodosTimer !== null) window.clearTimeout(groupTodosTimer);
      groupTodosTimer = window.setTimeout(() => {
        groupTodosTimer = null;
        void reloadGroupTodoRows(groupId);
      }, 150);
    });
    if (!groupTodosWatchGuard.isCurrent("groupTodos", token)) {
      // 更晚的一次切换已经开始 ⇒ 本次结果整个丢弃，并立刻摘掉监听。
      // 不摘的话它会一直留在事件总线上，而且清理函数也再没人持有。
      unlisten();
      return () => {};
    }
    groupTodosUnlisten = unlisten;
    return () => {
      // 已被更晚的一次订阅取代时，共享的 timer 属于新群 —— 旧清理不许碰它。
      if (groupTodosWatchGuard.isCurrent("groupTodos", token)) {
        if (groupTodosTimer !== null) {
          window.clearTimeout(groupTodosTimer);
          groupTodosTimer = null;
        }
        groupTodosUnlisten = null;
      }
      unlisten();
    };
  }

  /**
   * 统一发送（单聊/群聊）。乐观上屏：先显示 sending，invoke 成功后替换为真实记录。
   *
   * `mentionIds` 只有群文本消息有用：**这条消息 @ 的是哪些人（设备 id）**。
   * 传 `undefined`（非选择器输入的发送路径都这样）= 随老格式发出去，
   * 接收端按昵称兜底判 —— 新字段只让"带上了 id 的那些"更准，不会让别的入口变暗。
   *
   * `retryOfMsgId` = **重发**时那条 failed 气泡的 `msg_id`（见 `retrySend`）。
   * 传它就**不再新建乐观气泡**，而是把那条 failed 原地转回 sending ——
   * 否则列表里会同时留着"发送失败的原文"和"重发中的原文"两条，而 failed 那条
   * **永远不会被删**（全库无删除路径，且 `appendLocalOnly` 每次重开会话都会把
   * `tmp-*` 重新追加到快照尾部）。
   *
   * ⚠️ 为什么不能字面复用同一 msg_id（INV-001 在本项目做不到"客户端指定"那一半）：
   * 后端 msg_id = `SHA-256(sender_id + nonce + payload)`（`protocol.rs::compute_message_id`），
   * nonce 每条新消息都不同 ⇒ 重发**必然**是新 msg_id；且 `send_message` 只有
   * `(friend_id, content, kind)` 三个参数，压根没有 msg_id 可传。所以 INV-001 的
   * "重试复用同一 msg_id"在本项目落在**接收侧幂等**（`message_exists` 按 msg_id 去重），
   * 前端这一侧改成"**旧气泡原地复用**"—— 逻辑消息在界面上仍是同一条。
   */
  async function send(
    convId: string,
    content: string,
    kind: string,
    mentionIds?: string[],
    retryOfMsgId?: string,
  ): Promise<MessageRecord> {
    const myId = app.device?.device_id ?? "";

    // ---- 重发：把那条 failed 气泡原地转回 sending，不再新建乐观记录 ----
    // 找不到（切了会话 / 已被快照吞掉）就退回新建 —— 宁可多一条也不静默丢消息。
    if (retryOfMsgId) {
      const revertedHit = patchMessageInConv(messages.value, convId, retryOfMsgId, (m) => ({
        ...m,
        status: "sending" as const,
      }));
      if (revertedHit) {
        messages.value = revertedHit.lists;
        const reverted = revertedHit.rec;
        try {
          const rec = await sendToBackend(convId, content, kind, mentionIds);
          // Ack 可能已在 await 期间到达 ⇒ 直接提升到 delivered（与下面新建路径同一处理）
          const acked = pendingAcks.delete(rec.msg_id);
          replaceMessage(
            convId,
            retryOfMsgId,
            acked ? { ...rec, status: furthestStatus(rec.status, "delivered") } : rec,
          );
          // 任务中心那一行来自补发队列快照：发送动作本身不会产生事件（离线时后端只入队），
          // 不在这里补拉，用户就只能在"关窗重开/等下一次别的刷新"时才看到它（2026-10-25 实报）。
          void refreshTransfers();
          return rec;
        } catch (e) {
          replaceMessage(convId, retryOfMsgId, { ...reverted, status: "failed" });
          throw e;
        }
      }
    }

    // 乐观消息先占一个很大的逻辑序号，保证它出现在会话底部；后端返回真实记录后会替换为权威 seq。
    // `local_id` 是**持久本地身份**：传给后端落库，真实记录返回同一个值 ⇒ 列表 key 不换。
    const localId = crypto.randomUUID();
    const optimistic: MessageRecord = {
      id: -1,
      msg_id: `tmp-${localId}`,
      local_id: localId,
      conv_id: convId,
      sender_id: myId,
      receiver_id: convId,
      kind: kind as MessageRecord["kind"],
      content,
      ts: Date.now(),
      seq: Number.MAX_SAFE_INTEGER,
      status: "sending",
    };
    enqueueMessage(optimistic);
    try {
      const rec = await sendToBackend(convId, content, kind, mentionIds, localId);
      // 如果 Ack 已在 await 期间到达：直接把 real record 提升到 delivered，
      // 然后一次性替换 optimistic → real（不再二次 replaceMessage）。
      const acked = pendingAcks.delete(rec.msg_id);
      const next = acked
        ? { ...rec, status: furthestStatus(rec.status, "delivered") }
        : rec;
      replaceMessage(convId, optimistic.msg_id, next);
      void refreshTransfers();
      return rec;
    } catch (e) {
      // 发送失败：乐观消息标记为失败态（保留内容，用户可重发）
      replaceMessage(convId, optimistic.msg_id, { ...optimistic, status: "failed" });
      throw e;
    }
  }

  /**
   * 重发一条**本端判失败 / 已取消**的 1:1 消息（复用原 `msg_id`，计划 D1）。
   *
   * 为什么不复用 `send()` 的重发分支：那条走 `send_message` ⇒ 新 msg_id、新 seq，
   * 用户按一次"重发"就等于又发了一条新消息（对端半开链路上最需要幂等时恰恰没有）。
   * 这里后端原地复活同一条消息，前端也只把**同一个 msg_id** 的气泡换回 sending/sent。
   */
  async function resend(convId: string, msgId: string): Promise<MessageRecord> {
    const rec = await api.resendMessage(convId, msgId);
    // Ack 可能已在 await 期间到达 ⇒ 与首次发送同一条处理：提升到 delivered 再落盘到缓存。
    const acked = pendingAcks.delete(msgId);
    const next = acked ? { ...rec, status: furthestStatus(rec.status, "delivered") } : rec;
    replaceMessage(convId, msgId, next);
    void refreshTransfers();
    return rec;
  }

  /** 单聊/群聊的 invoke 分流（重发与首次发送共用，避免两份实现漂移）。 */
  async function sendToBackend(
    convId: string,
    content: string,
    kind: string,
    mentionIds?: string[],
    localId?: string,
  ): Promise<MessageRecord> {
    if (convId.startsWith("group:")) {
      return api.sendGroupMessage(convId.slice(6), content, kind, mentionIds, localId);
    }
    return api.sendMessage(convId, content, kind, localId);
  }

  /**
   * 发起强提醒：对 `targetMsgId` 发一条 kind=remind。
   * 群聊必须带显式 actors 名单（第一版不默认全群）；私聊名单为空（默认对方）。
   * 复用普通 send 链路（乐观气泡/outbox/Ack），不另造传输。
   */
  async function sendReminder(
    convId: string,
    targetMsgId: string,
    actors: string[] = [],
    shake = false,
  ) {
    await send(convId, buildRemindPayload(targetMsgId, actors, shake), "remind");
  }

  /**
   * 工具栏「抖动」按钮（仿 QQ 窗口抖动）：**独立事件**，不锚定任何消息、不发强提醒。
   * 复用 `remind` 帧的可靠管道（`nudge=true`），接收端只抖 + 灰字；旧端由能力位挡住。
   */
  async function shakeConversation(convId: string): Promise<void> {
    if (!convId || convId.startsWith("group:")) return;
    await send(convId, buildRemindPayload("", [], true, true), "remind");
    showNudgeNotice(convId, app.device?.device_id ?? "");
  }

  /**
   * 「我知道了」：找到以 targetMsgId 为目标的那条 remind，回 stage=confirmed。
   * 没折叠出对应 remind（消息已被清/还没加载）时如实抛错，不静默。
   */
  async function confirmReminder(convId: string, targetMsgId: string) {
    const list = messages.value[convId] ?? [];
    const state2 = foldReminders(list).get(targetMsgId);
    if (!state2) throw new Error("reminder-not-found");
    await send(convId, buildRemindAckPayload(state2.remindId, "confirmed"), "remind_ack");
  }

  /**
   * 替换会话内指定 msg_id 的消息（乐观记录 → 真实记录 / 状态变更）。
   *
   * ⚠️ 必须走 `replaceOptimistic`（按 `msg_id` 认，不按位置换）：群发送的真实记录有**两条**
   * 到达路径 —— 后端为跨窗口同步加的自 emit（`commands/window.rs::send_group_payload`）
   * 与 `invoke` 的返回值。自 emit 先到时列表里已经有那一条，再 splice 一次就是
   * "同一条消息显示两条"（而切一次会话从库里重读又变回一条 —— 用户 2026-09-28 报的正是这个）。
   */
  function replaceMessage(convId: string, msgId: string, next: MessageRecord) {
    const list = messages.value[convId];
    if (list) {
      const replaced = replaceOptimistic(list, msgId, next);
      if (replaced) {
        messages.value[convId] = replaced;
        return;
      }
    }
    // 乐观记录还压在批量队列里（invoke 先于 rAF 落地返回）：挂起等批次落地时替换。
    // 直接丢弃真实记录 = 气泡永远停在「发送中」，而后端库里早已是 delivered/read。
    if (pending.some((m) => m.msg_id === msgId)) pendingReplace.set(msgId, next);
  }

  async function sendFriendRequest(peerId: string) {
    await api.sendFriendRequest(peerId);
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

  /**
   * 删除一个会话及其全部本地消息。
   * - 乐观移除：先从会话列表与内存缓存中抹除，后端失败回滚；
   * - 若被删的会话正是当前打开的会话，需让父组件（ConversationList/ChatWindow）
   *   检测 activeConv 是否仍存在并切到 null，避免打开空窗口。
   * - 仅本地清理，不影响对方聊天记录（前端弹窗二次确认）。
   */
  async function deleteConversation(convId: string) {
    const prevConvs = conversations.value;
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
      // 回滚：恢复会话行与消息缓存
      conversations.value = prevConvs;
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
    const prevConvs = conversations.value;
    conversations.value = sortConversations(
      conversations.value.map((c) => (c.id === convId ? { ...c, pinned } : c)),
    );
    try {
      await api.setConversationPinned(convId, pinned);
    } catch (e) {
      conversations.value = prevConvs;
      throw e;
    }
  }

  /**
   * 撤回自己发的一条消息（群/单聊统一，仅原作者，窗口 5 分钟）。
   *
   * 不做乐观更新：先在服务端成功（事件已发出）才改本地 —— 顺序反了会出现
   * 「本地显示已撤回、对端根本没收到」。事件回来会走 `onMessageRecalled` 统一改本地形态。
   */
  /** 撤回自己发的一条消息：群聊传 `group:<gid>`，单聊传 peer id；由这里统一分流。 */
  async function recallMessage(convId: string, msgId: string) {
    if (convId.startsWith("group:")) {
      await api.recallGroupMessage(convId.slice(6), msgId);
      return;
    }
    await api.recallDirectMessage(convId, msgId);
  }

  /** 切换自己发的代码/文本消息渲染；本地更新统一等后端 LWW 后的 `message-render-changed`。 */
  async function setMessageRender(convId: string, msgId: string, mode: "code" | "text") {
    await api.setMessageRender(convId, msgId, mode);
  }

  /** 发布群公告（仅群主）。正常入时间线（计未读、可通知），只是不随清空历史消失。 */
  async function publishAnnouncement(groupId: string, text: string) {
    const rec = await api.sendGroupAnnouncement(groupId, text);
    enqueueMessage(rec);
    await refreshAnnouncements();
  }

  // ---------------- 群公告（会话列表 📢 标记的数据源） ----------------
  // 为什么走一条专门的查询：会话列表要覆盖**全部**群，而 `chat.messages` 是 ~4 个会话的
  // LRU 缓存 —— 从它折叠公告覆盖不了大多数群。后端 `list_active_group_announcements`
  // 一条 SQL 全量折叠（公告 + 墓碑），前端缓存成 map。

  /** 当前生效的群公告：key = group_id。 */
  const activeAnnouncements = ref(new Map<string, { text: string; msgId: string }>());

  /** 全量刷新（一条 SQL，代价低）。 */
  async function refreshAnnouncements() {
    try {
      const list = await api.listActiveGroupAnnouncements();
      const next = new Map<string, { text: string; msgId: string }>();
      for (const a of list) next.set(a.groupId, { text: a.text, msgId: a.msgId });
      activeAnnouncements.value = next;
    } catch {
      /* 拉取失败保持旧值（下一条公告事件会再触发刷新） */
    }
  }

  /** 删除群公告（仅群主）：发墓碑 → 入 store（本端横幅即刻消失）→ 刷新标记。 */
  async function deleteAnnouncement(groupId: string, annId: string) {
    const rec = await api.deleteGroupAnnouncement(groupId, annId);
    enqueueMessage(rec);
    await refreshAnnouncements();
  }

  // ---------------- 群任务（Card kind：**时间线上也渲染**，同时折进任务面板） ----------------
  // ⚠️ 这行注释此前写的是"不在时间线上渲染"，与 `utils/messageKinds.ts` 的
  // `CARD_KINDS` / `isRenderedInTimeline("todo") === true` 相反 —— 就是这句假话让
  // "自己发的任务在主聊天窗看不见"被当成设计如此（2026-09-26 用户实测报出）。
  // 为什么都要 `enqueueMessage(rec)`：面板里的列表是 `foldTodos(该会话的消息)` 折出来的，
  // 事件不进 store 就折不出来 —— 界面要等下次重新拉全量（= 重进会话）才刷新
  // （与置顶/公告同一条理由）。⚠️ 但那只覆盖"发起方与接收方在同一个窗口"的情况：
  // 任务看板跑在独立窗口、另有一份 store，所以本端回送必须由后端 emit（见
  // `commands/window.rs::send_group_payload` 的自 emit 与 lib.rs 的同名形状守卫）。

  /** 新建一条群任务（任意成员）。description / images / 类型可选。返回新建的消息记录（含 todo_id）。 */
  async function createTodo(
    groupId: string,
    title: string,
    assignees: string[],
    description?: string,
    images?: TodoImage[],
    category?: string,
    customCategory?: string,
    customIcon?: string,
  ): Promise<MessageRecord> {
    const rec = await api.sendGroupTodo(
      groupId,
      title,
      assignees,
      description,
      images,
      category,
      customCategory,
      customIcon,
    );
    enqueueMessage(rec);
    return rec;
  }

  /**
   * 更新一条群任务：改状态 / 改标题与指派人 / 删除。
   *
   * 前端把**整份定义**发过去（标题、指派人、状态一起）：定义层是"同 `todo_id` 取最新一份"
   * 的 LWW 寄存器，只发改动字段会让没带的字段被清空。`patch` 缺省沿用传进来的 `item`
   * （调用方从折出来的 `TodoItem` 里取值，本身就是最新的）。
   */
  async function updateTodo(
    groupId: string,
    item: { todoId: string; title: string; assignees: string[]; status: string; description?: string; images?: TodoImage[] },
    patch: Partial<{
      title: string;
      assignees: string[];
      status: string;
      deleted: boolean;
      description: string;
      images: TodoImage[];
      /** 显式归档：`true` = 手动归档（进入终态之后）。不传 = 保留库中原值。 */
      archived: boolean;
      /** 优先级（三档）。不传 = 保留库中原值 ⇒ 改状态/改描述都不会顺手把档位重置。 */
      priority: string;
      /** 类型（任务/需求/缺陷/自定义）。同 priority 那一格：不传就保留库里的。 */
      category: string;
      /** 自定义类型名（仅 category="custom" 有效）。不传 = 保留库里的名字。 */
      customCategory: string;
      /** 自定义类型的图标键（仅 custom 有效）。不传 = 保留库里挑过的那枚。 */
      customIcon: string;
    }> = {},
  ) {
    const rec = await api.updateGroupTodo(groupId, item.todoId, {
      title: patch.title ?? item.title,
      assignees: patch.assignees ?? item.assignees,
      status: patch.status ?? item.status,
      deleted: patch.deleted ?? false,
      description: patch.description ?? item.description,
      images: patch.images ?? item.images,
      archived: patch.archived,
      priority: patch.priority,
      // category 曾被**漏在这一行之外**：patch 类型里声明了它、api 也收它、后端也存它，
      // 但这里没转发 ⇒ 选完类型弹「已更新」而库里一字未动，类型检查与全量层都拦不住。
      // 键集合的对账由 src/utils/storeContract.test.ts 那条判据负责，别再靠人眼数。
      category: patch.category,
      customCategory: patch.customCategory,
      // 与上面那条注释同一个坑的另一格：`custom_icon` 声明了却没转发 ⇒
      // 选完图标弹「已更新」而库里一字未动。键集合由 storeContract 那条判据对账。
      customIcon: patch.customIcon,
    });
    enqueueMessage(rec);
  }

  /** 置顶/取消置顶一条群消息（任意成员；静默事件，由置顶条体现）。 */
  async function pinMessage(groupId: string, msgId: string, pinned: boolean) {
    // ⚠️ **必须 enqueue 进 store**：置顶在界面上的呈现（顶部的置顶条）
    // 是 `foldPinned(该会话的全部消息)` 折叠出来的 —— 事件不进 store，
    // 折叠就看不到它，界面要等下次重新拉全量（= 重进会话）才刷新。
    const rec = await api.pinGroupMessage(groupId, msgId, pinned);
    enqueueMessage(rec);
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
  async function deleteMessages(convId: string, msgIds: string[]): Promise<number> {
    if (msgIds.length === 0) return 0;
    const prevMsgs = messages.value[convId] ?? [];
    const prevConvs = conversations.value;
    const set = new Set(msgIds);
    messages.value = { ...messages.value, [convId]: prevMsgs.filter((m) => !set.has(m.msg_id)) };
    try {
      const n = await api.deleteMessages(msgIds);
      await refreshConversations();
      return n;
    } catch (e) {
      messages.value = { ...messages.value, [convId]: prevMsgs };
      conversations.value = prevConvs;
      throw e;
    }
  }

  /**
   * 发一条表情回应（群聊）。
   *
   * 走与普通消息**完全相同**的可靠管道（E2EE + outbox + GroupAck + 去重 + 离线补发），
   * 只是接收端会按 kind 归类为静默事件。本地**不做乐观上屏**：回应是幂等的状态事件，
   * 折叠逻辑已经能正确处理重复，等服务端回执再合并反而更简单、也不会出现
   * "点了没反应但本地已高亮"的错觉。
   */
  async function sendReaction(groupId: string, target: string, emoji: string, add: boolean) {
    const rec = await api.sendGroupReaction(groupId, target, emoji, add);
    enqueueMessage(rec);
  }

  /**
   * 1:1 里的表情回应：走普通 `send_message`，kind = "reaction"。
   *
   * 为什么不新开一条后端命令：回应是**状态事件**，而 `send_message` 已经是"把一条带 kind 的
   * 消息可靠投递给一个好友"的唯一通路（outbox / E2EE / ack 全在那条上）。再加一条命令就是第二个家，
   * 而它管的那一半（可靠投递）会先腐烂。
   * 后端挡三件事：载荷畸形、对端版本吃不下这个 kind（INV-P24：老端会整帧丢 + 断链），
   * 以及"静默 kind 不许刷会话预览"。前两者是 Err ⇒ 这里必须让调用点报错，不能吞。
   */
  async function sendDmReaction(friendId: string, target: string, emoji: string, add: boolean) {
    const rec = await api.sendMessage(
      friendId,
      buildReactionPayload(target, emoji, add),
      "reaction",
    );
    enqueueMessage(rec);
  }

  async function createGroup(name: string, members: string[]) {
    const g = await api.createGroup(name, members);
    await api.distributeGroupKey(g.id);
    await refreshGroups();
    await refreshConversations();
    return g;
  }

  /** 重命名群（仅群主）。乐观更新会话标题，失败回滚。 */
  async function renameGroup(groupId: string, name: string) {
    const convId = `group:${groupId}`;
    const prevConvs = conversations.value;
    conversations.value = conversations.value.map((c) => (c.id === convId ? { ...c, name } : c));
    try {
      await api.renameGroup(groupId, name);
      await refreshGroups();
      await refreshConversations();
    } catch (e) {
      conversations.value = prevConvs;
      throw e;
    }
  }

  /**
   * 群操作的**乐观更新**骨架（用户 2026-09-12 要求「所有异步操作尽量乐观更新」）。
   *
   * 原先四个群操作都是「await 后端 → await refreshGroups → await refreshConversations」：
   * 点一下要等 **3 个 IPC 往返**才看到变化（成员列表、群主标识都不动），
   * 与「不阻断渲染」的要求相反。这里统一成与 `renameGroup` 相同的范式：
   * **先本地改（可感知即时）→ 调后端 → 失败回滚 + 抛错**（调用方负责 toast）。
   * 后端仍是权威：成功后会 refresh 一次收敛（成员/会话行以后端为准）。
   */
  function withGroupRollback<T>(
    mutate: () => () => void,
    call: () => Promise<T>,
  ): Promise<T> {
    const rollback = mutate();
    return call().catch((e) => {
      rollback();
      throw e;
    });
  }

  /** 加人入群（群主）。 */
  async function addGroupMember(groupId: string, deviceId: string) {
    await withGroupRollback(
      () => {
        const prev = groups.value;
        groups.value = groups.value.map((g) =>
          g.id === groupId && !g.members.includes(deviceId)
            ? { ...g, members: [...g.members, deviceId] }
            : g,
        );
        return () => {
          groups.value = prev;
        };
      },
      () => api.groupAddMember(groupId, deviceId),
    );
    await refreshGroups();
    await refreshConversations();
  }

  /** 移除成员（群主）。 */
  async function removeGroupMember(groupId: string, deviceId: string) {
    await withGroupRollback(
      () => {
        const prev = groups.value;
        groups.value = groups.value.map((g) =>
          g.id === groupId ? { ...g, members: g.members.filter((m) => m !== deviceId) } : g,
        );
        return () => {
          groups.value = prev;
        };
      },
      () => api.groupRemoveMember(groupId, deviceId),
    );
    await refreshGroups();
    await refreshConversations();
  }

  /** 转让群主（仅当前群主）。后端会向全体成员广播新群主。 */
  async function transferGroupCreator(groupId: string, newCreator: string) {
    await withGroupRollback(
      () => {
        const prev = groups.value;
        groups.value = groups.value.map((g) =>
          g.id === groupId ? { ...g, creator: newCreator } : g,
        );
        return () => {
          groups.value = prev;
        };
      },
      () => api.transferGroupCreator(groupId, newCreator),
    );
    await refreshGroups();
  }

  /** 退出群聊（群主须先转让）。退出后复用「被移出群」的本地清理路径。 */
  async function leaveGroup(groupId: string) {
    const convId = `group:${groupId}`;
    const prevGroups = groups.value;
    const prevConvs = conversations.value;
    const prevActive = activeConv.value;
    const prevMessages = messages.value[convId];
    // 乐观：立刻把群从本地移除并关掉会话（用户点了"退出"就该马上看到结果）
    groups.value = groups.value.filter((g) => g.id !== groupId);
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    if (activeConv.value === convId) {
      activeConv.value = null;
      unreadJump.value = null;
    }
    try {
      await api.leaveGroup(groupId);
    } catch (e) {
      // 回滚：退群失败（例如群主未转让）时把群与会话原样放回
      groups.value = prevGroups;
      conversations.value = prevConvs;
      activeConv.value = prevActive;
      if (prevMessages !== undefined) messages.value = { ...messages.value, [convId]: prevMessages };
      throw e;
    }
    await handleSelfRemovedFromGroup(groupId);
  }

  /** 自己被移出群：关闭该会话并刷新。 */
  async function handleSelfRemovedFromGroup(groupId: string) {
    const convId = `group:${groupId}`;
    if (activeConv.value === convId) {
      activeConv.value = null;
      unreadJump.value = null;
    }
    delete messages.value[convId];
    // 同一次收尾里把台账摘要也放掉：群已经不在了，留着只会在重建同名会话时先显示旧计数。
    delete groupDeliveries.value[convId];
    await refreshGroups();
    await refreshConversations();
  }

  /** 统一文件发送：后端自动路由（有直连走直连，无直连自动中继）。 */
  async function sendFileTo(convId: string, path: string, msgId?: string) {
    if (convId.startsWith("group:")) return null;
    const name = path.split(/[\\/]/).pop() ?? t("common.file");
    try {
      const id = await api.sendFileAuto(convId, path, msgId);
      void refreshTransfers();
      // 后端 send_file 会在返回前同步 emit `message-received`（携带完整的
      // name/size/subtype/path 记录），前端不再手工拼一个只有 name 的乐观气泡，
      // 避免与真实记录因同 msg_id 去重竞态而丢失元数据。
      return id;
    } catch (e) {
      // API 失败：插入明确 failed 状态的文件消息，不让消息永久停在 sending。
      // 同一个值同时当 msg_id / local_id：它是本地独有行，列表 key 必须稳定。
      const failedId = `file-failed-${Date.now()}`;
      enqueueMessage({
        id: -1,
        msg_id: failedId,
        local_id: failedId,
        conv_id: convId,
        sender_id: app.device?.device_id ?? "",
        receiver_id: convId,
        kind: "file",
        content: JSON.stringify({ name }),
        ts: Date.now(),
        seq: Number.MAX_SAFE_INTEGER,
        status: "failed",
      });
      app.toastError(e, t("send.fileFail"));
      return null;
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
    conversations.value = [];
    groups.value = [];
    groupReads.value = {};
    // 与 groupReads 同批清：后端把库清了，那几条"正在补历史"的提示也就没有对应的作业了。
    // 留着它们的表现是设置里清完数据回主界面，横幅还挂着一句"正在同步 320/800"。
    groupHistorySync.value = {};
    activeConv.value = null;
    mentionedConvs.value = new Set();
    // 与 `resetAfterDataCleared` **同一组**（那边清的是同三张表）：后端把库清了，
    // 这些"等落地/等点击"的过渡态再留着就是给已不存在的记录重建条目。
    // 少清任何一张，两条清除路径就会走出两种不同的残留表现。
    pendingAcks.clear();
    pendingReplace.clear();
    notifMap.clear();
    // 图片预览缓存整份放掉：库都清了，那些 objectURL 指向的文件已经不存在，
    // 留着就是几 MB～几十 MB 的死字节 + 一堆点了必然裂图的缓存条目。
    // 收藏那份同理 —— `clear_all_data` 也删收藏行与副本。
    clearFilePreviews();
    clearFavoritePreviews();
    void refreshTransfers();
  }


  /** 群文件发送：走群文件链路（Offer → Chunk → Done → CompleteAck）。
   *  群文件气泡/进度展示留待后续阶段，本封装只负责触发后端传输。 */
  async function sendGroupFileTo(groupId: string, path: string, msgId?: string) {
    try {
      const id = await api.sendGroupFile(groupId, path, msgId);
      void refreshTransfers();
      return id;
    } catch (e) {
      app.toastError(e, t("send.groupFileFail"));
      return null;
    }
  }

  /** 粘贴图片发送：data URL → 本地文件 → 文件传输（单聊/群聊复用同一条可靠链路）。
   *  发送初始化失败时删除已保存的孤儿图片。 */
  async function sendImage(convId: string, dataUrl: string) {
    const { path } = await api.saveOutgoingImage(dataUrl);
    try {
      if (convId.startsWith("group:")) {
        // 本机刚生成、刚落盘的图片：没有"被转发的那条消息"，不带 msgId。
        const id = await api.sendGroupFile(convId.slice(6), path);
        void refreshTransfers();
        return id;
      }
      const id = await api.sendFileAuto(convId, path);
      void refreshTransfers();
      return id;
    } catch (e) {
      // 初始化失败：清理孤儿图片，避免 downloads 目录堆积垃圾
      await api.deleteFile(path).catch(() => {});
      app.toastError(e, t("send.imageFail"));
      return null;
    }
  }

  /**
   * 处于「停滞/等待」的 transfer → 原因文案（按 writer 实发判定，后端只在状态翻转时发一次事件）。
   *
   * 为什么单独存而不下到 `transfers[]` 行上：`refreshTransfers()` 会用后端快照**整体替换**
   * 那个数组，行上的临时标记会被无声冲掉；停滞是"这次尝试"的状态，必须活得比快照久。
   *
   * 值就是原因（`undefined` = 普通的链路静默，界面回退到既有的「网络停滞」文案）。
   * 用 Map 而不是 Set：只有蓝牙链路时大文件会"保持 pending 等 LAN"（后端
   * `refuse_reason_for_best_link`），那句原因必须落在同一个集合里 —— 分两处存就一定会有
   * 一边忘了清（表现为"停滞"标签一直挂着）。
   */
  const stalledTransfers = ref<Map<string, { reason?: string; flaggedAt: number }>>(new Map());
  function isTransferStalled(id: string, nowMs: number = Date.now()) {
    const rec = stalledTransfers.value.get(id);
    if (!rec) return false;
    return stallFlagAlive(nowMs, rec.flaggedAt);
  }
  function transferStallReason(id: string, nowMs: number = Date.now()): string | undefined {
    const rec = stalledTransfers.value.get(id);
    if (!rec || !stallFlagAlive(nowMs, rec.flaggedAt)) return undefined;
    return rec.reason;
  }
  function setTransferStalled(
    id: string,
    stalled: boolean,
    reason?: string,
    nowMs: number = Date.now(),
  ) {
    const next = reason ?? undefined;
    const cur = stalledTransfers.value.get(id);
    if (stalled) {
      // **重发也要重新盖章**：持续性停滞（比如"只有蓝牙、等 LAN 回来"）后端每个心跳 flush
      // 会重发一次，那是一次"这条链还在报告同一件事"的活证据。原实现把重发当幂等直接 return，
      // 于是 TTL 一过标记就被判过期 —— 修 D-5 不能顺手把"持续停滞一直显示"这条真实行为弄丢。
      // 值没变时只就地改时间戳、不换整个 Map：显示内容没变，换 Map 只是白白让所有订阅者重算。
      if (cur && cur.reason === next && stallFlagAlive(nowMs, cur.flaggedAt)) {
        cur.flaggedAt = nowMs;
        return;
      }
      const m = new Map(stalledTransfers.value);
      m.set(id, { reason: next, flaggedAt: nowMs });
      // 顺手把过期的邻居带走：这套标记没有别的清扫点，攒着就是"漏一条永远挂着"那一族。
      for (const [k, v] of m) {
        if (!stallFlagAlive(nowMs, v.flaggedAt)) m.delete(k);
      }
      stalledTransfers.value = m;
      return;
    }
    if (!cur) return;
    const m = new Map(stalledTransfers.value);
    m.delete(id);
    stalledTransfers.value = m;
  }
  function onFileStalled(p: FileStalledInfo) {
    setTransferStalled(p.transfer_id, p.stalled, p.reason ?? undefined);
  }

  function updateTransferProgress(p: FileProgress) {
    const t = transfers.value.find((x) => x.id === p.transfer_id);
    if (t) {
      const next = p.total > 0 ? p.received / p.total : 0;
      const advanced = progressAdvanced(typeof t.progress === "number" ? t.progress : null, next);
      t.progress = next;
      // 字节又动了，就是「停滞已经恢复」的正面证据 —— 不必等后端那条 `file-stalled:false`
      // 的翻转事件（审计 D-5：那条一漏，标签就永远挂在一行还在走的进度上）。
      if (advanced && stalledTransfers.value.has(p.transfer_id)) {
        setTransferStalled(p.transfer_id, false);
      }
      return;
    }
    // 找不到行**不能静默丢**：进度是节流发的（250ms 一次），丢掉一次就可能再也没有下一次。
    scheduleTransfersRepair();
  }
  function onFileDone(d: FileDoneInfo) {
    // 终态一律收回「网络停滞」提示：后端只在翻转时发事件，漏一条就会让下次重试显示旧状态。
    setTransferStalled(d.transfer_id, false);
    const t = transfers.value.find((x) => x.id === d.transfer_id);
    if (t) {
      t.status = "done";
      t.path = d.path;
      t.progress = 1;
    } else {
      scheduleTransfersRepair();
    }
    // 字节刚落盘：让这条消息的预览缓存失效 —— 收到图片时可能"消息先到、字节后到"，
    // 在途读预览会得到"仍在接收"；不失效就不会重读，图片只能靠重发才出来。
    invalidateFilePreview(`file-${d.transfer_id}`);
    invalidateFilePreview(`gfile-${d.transfer_id}`);
  }
  /**
   * 群文件投递诊断行的最近留档（10-22 审计 R-28 / D-3）。
   *
   * 后端 `group-file-log` 说的正是「哪个收件人、卡在哪一步」，此前前端无人订阅 ⇒
   * 界面上只有"K 人失败"这个数，原因永远看不到。这里只留**上界 50 行**的环形尾部，
   * 给诊断面板看；不进消息列表、不打 toast（它是排障细节，不该打断每个用户）。
   */
  const groupFileDiag = ref<{ ts: number; line: string }[]>([]);
  const GROUP_FILE_DIAG_MAX = 50;
  function onGroupFileLog(line: string) {
    groupFileDiag.value = [...groupFileDiag.value, { ts: Date.now(), line }].slice(
      -GROUP_FILE_DIAG_MAX,
    );
  }

  function onFileFailed(d: FileFailedInfo) {
    setTransferStalled(d.transfer_id, false);
    // **必须认双前缀**：群文件气泡的 msg_id 是 `gfile-${transfer_id}`（后端 group_file.rs 就这么拼），
    // 而这里此前只拼 `file-` ⇒ 群文件失败时内存里那条永远不落状态，界面继续转圈。
    // 同文件的 onFileCancelled 两个前缀都认、onFileDone 也两个都失效缓存 —— 三条里只有这条漏，
    // 是「群文件永远发送中」的前端那一半（另一半在后端：失败分支不发终态事件）。
    const hit = findFirstMessageById(messages.value, transferFailureMsgIds(d.transfer_id));
    if (hit) {
      messages.value = replaceMessageAt(messages.value, hit.convId, hit.index, {
        ...hit.rec,
        status: "failed",
      });
    }
    app.toast(`${t("send.fileFail")}：${fileFailReasonText(d.reason, t)}`, "error");
  }

  /**
   * 收到撤回事件：把本地那一行改成「已撤回」形态。
   *
   * 与后端的物化视图保持一致：`kind` 改 `recalled`、`content` 清空 ——
   * 这样搜索、预览、复制等所有读 content 的地方**一处都不用改**就自动正确。
   */
  /** 渲染切换：只改目标消息的 kind；虚拟列表由 ResizeObserver 重测高度。 */
  function onMessageRenderChanged(msgId: string, kind: "code" | "text") {
    const hit = findFirstMessageById(messages.value, [msgId]);
    if (!hit || hit.rec.kind === kind) return;
    messages.value = replaceMessageAt(messages.value, hit.convId, hit.index, { ...hit.rec, kind });
  }

  function onMessageRecalled(msgId: string) {
    const hit = findFirstMessageById(messages.value, [msgId]);
    if (!hit) return;
    const { convId, rec } = hit;
    if (rec.kind === "recalled") return; // 幂等：重复事件不再改动
    messages.value = replaceMessageAt(messages.value, convId, hit.index, {
      ...rec,
      kind: "recalled",
      content: "",
    });
    // 会话列表的预览若正是这条，也要跟着清掉（否则左侧仍显示已被撤回的正文）
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv && conv.last_msg && rec.content) {
      const preview = previewText(rec);
      if (conv.last_msg === preview || conv.last_msg === preview.slice(0, 30)) {
        conversations.value = conversations.value.map((c) =>
          c.id === convId ? { ...c, last_msg: t("msg.recalled") } : c,
        );
      }
    }
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

  /**
   * 实时事件链路是否健康（10-22 审计 R-33 / D-29）。
   *
   * 此前 `bindEvents` 失败**只有一次性 toast**，之后界面与完全正常的界面没有任何区别 ——
   * 用户不知道"收不到新消息"是链路断了而不是对方没发。设置页读这一份做常驻显示，
   * 并提供真的重绑入口（`init()` 开头自带"先拆上一轮再注册这一轮"的守卫 ⇒ 重绑幂等）。
   */
  const eventBridgeOk = ref(true);

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
        void api.markRead(convId).then(() => clearUnreadLocally(convId));
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
      if (notifyTimer !== null) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      if (transfersRepairTimer !== null) {
        clearTimeout(transfersRepairTimer);
        transfersRepairTimer = null;
      }
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
      },
      onFriendRejected: () => {},
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
        for (const [, msgs] of Object.entries(messages.value)) {
          const msg = msgs.find(m =>
            m.msg_id === `file-${transferId}` || m.msg_id === `gfile-${transferId}`
          );
          if (msg) {
            msg.status = "cancelled";
            app.toast(t("msg.canceled"), "info");
          }
        }
        void refreshTransfers();
      },
      onMessageFailed: (msgId) => {
        // 事件本身带终态事实：`outbox_sweep` 先把 `messages.status` 写成 failed 再 emit。
        // 所以这里**不回库查**，直接把这一事实盖到所有缓存了它的会话（含没在看的会话），
        // 与 `onFileCancelled` 同一形状。
        // 旧写法把它接到 `onMessageStatusChanged` 上，两头都不对：没在看的会话什么都不做
        //（只能等下次打开重查），正在看的会话为了一行状态重拉一整页 + 整列表重建。
        markStatusInCache(messages.value, msgId, "failed");
      },
      onMessageStatusChanged: (msgId) => {
        // 后端 emit 的状态变更事件 —— 我们直接从数据库拉最新状态覆盖本地
        // 目前只在 cancel_file_transfer 里发（取消后库里落 cancelled，前端同步一下）
        // 只处理**活跃**会话：loadMessages 的结果对非活跃会话必被 activeConv
        // 守卫丢弃（两次 IPC 纯浪费），而且切换回来时 openConversation 会重查。
        // （修复前它还会顺带把全局 loadSeq +1，取消活跃会话飞行中的加载 →
        //   骨架永久转圈，见 2026-09-23 审计 1.4。）
        //
        // ⚠️ 文件 / 群文件的状态变更同时是**一条传输行的终态**（群文件接收失败就只走这条）。
        // 只重拉会话不动 `transfers` 的话，全局面板与气泡会继续显示「接收中 X%」——
        // 正是 R-14 那一族"只能靠重启恢复"的残留。补拉是防抖的，多次事件不会放大 IPC。
        //
        // 2026-10-25：消息通道的状态变更也会改**任务中心**（取消/失败/送达会让补发行出现或消失），
        // 所以补拉不再只认文件前缀 —— 所有状态变更都走同一条防抖刷新。
        scheduleTransfersRepair();
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
          void api.markRead(convId).then(() => clearUnreadLocally(convId));
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
      if (pending.length) flushNow();
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
        void api.markRead(convId).then(() => clearUnreadLocally(convId));
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
    conversationsLoaded,
    groupsLoaded,
    pendingRequests,
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
