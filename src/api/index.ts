// Tauri 后端调用封装（invoke 参数使用 camelCase，后端自动转换为 snake_case）。

import { Channel, invoke as rawInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, CacheInfo, CleanupReport, ContentAudience, ContentCancelResult, ContentTransfer, Conversation, DeviceInfo, DiscoveryDiag, ExportSummary, ExternalLink, ExternalLinkImportResult, FavoriteEntry, FileDoneInfo, FileFailedInfo, FileProgress, FileStalledInfo, Friend, FriendKeyRotation, Group, GroupDeliverySummary, GroupHistoryProgress, GroupReadInfo, GroupResendResult, InterfaceInfo, LinkState, LogEntry, MessageCancelResult, MessageRecord, Peer, PeerReadInfo, PendingMessageOp, PendingRequest, PreviousRunReport, RelayConfig, RelayProbe, RoutedEndpoint, RuntimeDiag, RuntimeSnapshot, TransferInfo } from "@/types";
import type { TodoImage } from "@/utils/todos";
import {
  chatSearchGroupSchema,
  groupFileEntrySchema,
  parseIpcList,
  parseIpcValue,
  shareTreeSchema,
} from "@/utils/validation";
import type { PreviewGallery, PreviewImage } from "@/types";
import type { UpdaterDownloadEvent, UpdaterInfo, UpdaterStatus } from "@/types";
import { beginOp, endOp } from "@/utils/ipcTracker";

/**
 * 统一 IPC 出口：记录每个命令的开始/结束，慢调用（>2 s）上报一行日志。
 *
 * 为什么在这一层：156 个调用点全在这一个文件里，而卡死归因需要"卡在哪个命令"。
 * 包装器**不改变语义**：异常照旧抛、返回值原样透传；追踪本身绝不抛。
 * 慢调用上报也走本包装器（调用面对账判据要看得见），但它在 `ipcTracker` 的
 * EXCLUDED 里 ⇒ 不会形成递归追踪，也不会拖慢调用方（不 await）。
 */
const SLOW_OP_MS = 2_000;

async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  const opId = beginOp(cmd, args);
  try {
    return await rawInvoke<T>(cmd, args as InvokeArgs | undefined);
  } finally {
    const done = endOp(opId);
    if (done && done.ms > SLOW_OP_MS) {
      // 走到本包装器而不是 rawInvoke：调用面对账判据要能看见这条命令；
      // 它在 EXCLUDED 里，所以不会形成递归追踪。
      void invoke("report_frontend_slow_op", {
        cmd: done.label,
        ms: Math.round(done.ms),
      }).catch(() => {});
    }
  }
}

export const api = {
  /**
   * 监听"**另一个窗口**改了设置"（外观 / 语言 / 资料 / 目录 / 缓存策略）。
   *
   * 载荷是 `{changed, origin, settings}`（见 `SettingsPatch`）：
   * · `settings` 只含**变了的键**的值 ⇒ 接收方零 IPC 直接应用，不必再整份重拉；
   * · **发起窗口收不到这个事件**（后端 emit_filter 按标签过滤）⇒ 它不需要
   *   "别被自己的旧快照回灌"那套守卫（原先的 `settingsDirty` 已删）。
   */
  onSettingsChanged: (cb: (patch: SettingsChanged) => void) =>
    listen<SettingsChanged>("settings-changed", (e) => cb(e.payload)),
  /** 运行状态（通道/在线/绑定 IP）变化：任何一处开关后，所有窗口/页面重拉同一份状态。 */
  /**
   * 运行状态（通道/在线/绑定 IP/节点数）变化：**事件自带完整快照**。
   *
   * 与 ① 同一个模式：载荷就是 `RuntimeSnapshot`，接收方**零 IPC** 应用；
   * 发起窗口收不到（它从命令返回值里拿），所以不需要"防回灌"。
   */
  onRuntimeChanged: (cb: (snapshot: RuntimeSnapshot) => void) =>
    listen<RuntimeSnapshot>("runtime-changed", (e) => cb(e.payload)),
  /**
   * 「数据被清空了」（另一个窗口执行了"清除聊天数据"）。
   *
   * 真实缺陷（用户 Mac 4.1.10 实测）：在设置里清了聊天记录，**主界面毫无反应** ——
   * 清除只发生在设置窗口的 store 里，主窗口是另一个 WebView，它的会话列表一条都没变。
   */
  onDataCleared: (cb: () => void) => listen("data-cleared", () => cb()),
  /**
   * 只订阅 `message-received`（**窄**封装）。
   *
   * 给独立窗口用：群任务窗口只关心"我这个会话来了新消息"，不能跑 `bindEvents`（那是主窗口
   * 的全套监听，重复注册会导致重复通知/未读/回执，见 `src/App.vue` 的说明）。返回取消函数。
   */
  onMessageReceived: (cb: (rec: MessageRecord) => void) =>
    listen<MessageRecord>("message-received", (e) => cb(e.payload)),
  /**
   * 只订阅「会影响群文件清单」的事件（**窄**封装，与 `onMessageReceived` 同一条口径）。
   *
   * 三类变化：本机文件落盘/失败/取消（`local_state`）、新的 `gfile-` 消息（多一行）、
   * `gfile-` 的送达回执（「已送达 N/M」）。事件载荷没有群 id ⇒ 调用方按前缀失效，
   * 只重拉当前打开的那一个群。
   */
  onGroupFileActivity: (cb: () => void) =>
    Promise.all([
      listen("file-done", () => cb()),
      listen("file-failed", () => cb()),
      listen("file-cancelled", () => cb()),
      listen<MessageRecord>("message-received", (e) => {
        if (e.payload.msg_id.startsWith("gfile-")) cb();
      }),
      listen<{ msg_id: string }>("group-message-acked", (e) => {
        if (e.payload.msg_id.startsWith("gfile-")) cb();
      }),
      listen<string>("message-status-changed", (e) => {
        if (e.payload.startsWith("gfile-")) cb();
      }),
    ]).then((fns) => () => fns.forEach((fn) => fn())),
  getDeviceInfo: () => invoke<DeviceInfo>("get_device_info"),
  updateProfile: (nickname: string, avatar: string | null) =>
    invoke<DeviceInfo>("update_profile", { nickname, avatar }),
  listInterfaces: () => invoke<InterfaceInfo[]>("list_interfaces"),
  /** 起/停局域网：返回**新的运行状态快照**（发起窗口零额外 IPC）。 */
  startNetwork: (bindIp: string) => invoke<RuntimeSnapshot>("start_network", { bindIp }),
  stopNetwork: () => invoke<RuntimeSnapshot>("stop_network"),
  /** 取运行状态快照（唯一真相源；旧 `get_channel_status`/`get_network_status` 已删除）。 */
  getRuntimeSnapshot: () => invoke<RuntimeSnapshot>("get_runtime_snapshot"),

  getPeers: () => invoke<Peer[]>("get_peers"),
  searchNearbyPeers: () => invoke<Peer[]>("search_nearby_peers"),
  focusWindow: () => invoke<void>("focus_window"),
  shakeWindow: () => invoke<void>("shake_window"),
  /**
   * 提请用户注意：Windows 闪任务栏按钮、macOS 弹跳 Dock 图标，直到窗口回到前台。
   *
   * 只在**确实发出了通知**时调用（见 `useChatStore.flushNotifications`）——它和系统通知
   * 是"同一件事的两种表达"，通知被合并/被跳过时也不该闪。撤销由系统负责，无需配对停止调用。
   * 移动端是空实现（无任务栏可闪），前端不必再判平台，但仍不必对移动端调用。
   */
  /**
   * 请求系统级注意（Windows 闪任务栏 / macOS 弹 Dock）。
   *
   * `urgent` 由调用方按**这批通知的内容**算（见 `utils/notifyUrgency.ts`）：macOS 只在
   * 紧急时才弹跳（用户 2026-09-29：「Mac 端收到普通消息不要跳动 Dock 图标」），Windows
   * 两档都继续闪。分端的规则在后端，前端只说"紧不紧急"。
   */
  requestAttention: (urgent: boolean) => invoke<void>("request_attention", { urgent }),
  /**
   * 未读提醒外显：托盘图标红点 + tooltip 条数、Windows 任务栏按钮角标、macOS Dock 数字。
   *
   * 传**未读总数**（不是增量）；`0` 表示清除。平台差异全在后端（前端一句 if 都不该有）。
   */
  setUnreadBadge: (count: number) => invoke<void>("set_unread_badge", { count }),
  /**
   * 桌面系统通知（原生；返回 false 表示用户关了通知）。移动端仍走 plugin 通知。
   *
   * `convId` 必须传：**点通知要定位到会话**就得让后端知道这条通知属于谁 ——
   * 点击是后端（notify-rust 的 handle）捕获的，前端拿不到那个时机。
   * `opts.msgId`（仅强提醒）：被提醒的原消息，点击后继续定位到它。
   * `opts.sound`（仅强提醒）：让系统通知通道发声。
   * `opts.actionLabel`（仅 macOS 用）：通知上「打开」按钮的本地化文案 —— macOS 的
   * 点击捕获必须挂一个 action 按钮（见 src-tauri/src/notifications.rs）。
   */
  notifyDesktop: (
    title: string,
    body: string,
    convId: string,
    opts?: { msgId?: string; sound?: boolean; actionLabel?: string },
  ) => invoke<boolean>("notify_desktop", { title, body, convId, opts }),
  /** 设置页「发送测试通知」：成功返回平台说明，失败返回真实原因（供排障）。 */
  sendTestNotification: () => invoke<string>("send_test_notification"),
  getFriends: () => invoke<Friend[]>("get_friends"),
  /** 与指定对端的**安全码**（双方一致，供带外核对）。null = 还缺对方公钥，算不出来。 */
  getSafetyNumber: (peerId: string) =>
    invoke<string | null>("get_safety_number", { peerId }),
  removeFriend: (peerId: string) => invoke<void>("remove_friend", { peerId }),
  /** 待确认的好友密钥轮换列表（对方重装应用换身份时出现，仅内存态）。 */
  getFriendKeyRotations: () => invoke<FriendKeyRotation[]>("get_friend_key_rotations"),
  /** 用户确认是本人后，把好友身份密钥同步成观察到的新值。 */
  syncFriendKeys: (peerId: string) => invoke<void>("sync_friend_keys", { peerId }),
  getPendingRequests: () => invoke<PendingRequest[]>("get_pending_requests"),
  sendFriendRequest: (peerId: string) => invoke<void>("send_friend_request", { peerId }),
  respondFriendRequest: (peerId: string, accept: boolean) =>
    invoke<void>("respond_friend_request", { peerId, accept }),

  sendMessage: (friendId: string, content: string, kind: string, localId?: string) =>
    invoke<MessageRecord>("send_message", { friendId, content, kind, localId }),
  getMessages: (convId: string, limit?: number, offset?: number) =>
    invoke<MessageRecord[]>("get_messages", { convId, limit, offset }),
  /**
   * 一次拿回**多个群会话**的任务原始行（`todo` / `todo_update`），给"与我相关的未完成任务"
   * 蓝色徽标用。⚠️ 这里只取原始行 —— 折叠与判定只有一份，在 `utils/todos.ts`
   * （`foldTodos` + `openTodosForMe`）；在门面或后端再算一次就是第三个真源。
   */
  getGroupTodoMessages: (convIds: string[]) =>
    invoke<MessageRecord[]>("get_group_todo_messages", { convIds }),
  getConvLink: (convId: string) => invoke<LinkState | null>("get_conv_link", { convId }),
  /** 请对端按 cid 再发一份内容（图片/文件「点击重取」）。false = 对方版本不支持。 */
  requestContent: (peerId: string, msgId: string) =>
    invoke<boolean>("request_content", { peerId, msgId }),
  /**
   * 合并转发卡片里引用的图片按 cid 重取：服务端授权规则与 `request_content` 一致
   * （好友/群成员 + 拥有即授权）；`name`/`size` 仅用于授权与续传判定。
   */
  requestContentByCid: (peerId: string, cid: string, name: string, size: number) =>
    invoke<boolean>("request_content_by_cid", { peerId, cid, name, size }),
  getMessageCount: (convId: string) => invoke<number>("get_message_count", { convId }),
  /**
   * 打开会话的冷加载：一次拿最新一页（正序）。
   *
   * 为什么单独一条：按 offset 取尾部要先 `COUNT(*)`，那是**两轮** IPC，而每轮都得排队过
   * 全局那把 db 锁 —— 多出来的一轮正是"切到冷会话先看到骨架、后半拍才出内容"。
   * 翻页不用它：那一页要的是 total（判"还有没有更早历史"）。
   */
  getLatestMessages: (convId: string, limit?: number) =>
    invoke<MessageRecord[]>("get_latest_messages", { convId, limit }),
  getConversations: () => invoke<Conversation[]>("get_conversations"),
  ensureConversation: (friendId: string) =>
    invoke<Conversation>("ensure_conversation", { friendId }),
  markRead: (convId: string) => invoke<void>("mark_read", { convId }),
  setConversationPinned: (convId: string, pinned: boolean) =>
    invoke<void>("set_conversation_pinned", { convId, pinned }),
  deleteConversation: (convId: string) =>
    invoke<void>("delete_conversation", { convId }),

  createGroup: (name: string, members: string[]) => invoke<Group>("create_group", { name, members }),
  distributeGroupKey: (groupId: string) => invoke<void>("distribute_group_key", { groupId }),
  renameGroup: (groupId: string, name: string) =>
    invoke<void>("rename_group", { groupId, name }),
  groupAddMember: (groupId: string, deviceId: string) =>
    invoke<void>("group_add_member", { groupId, deviceId }),
  groupRemoveMember: (groupId: string, deviceId: string) =>
    invoke<void>("group_remove_member", { groupId, deviceId }),
  transferGroupCreator: (groupId: string, newCreator: string) =>
    invoke<void>("transfer_group_creator", { groupId, newCreator }),
  /**
   * 头部那颗低调的按钮：让后端为这一群再跑一趟常规群历史同步。
   * 返回裁决短码（started / already_running / no_source / no_group），搬运在后台 ⇒ 不等结果。
   */
  syncGroupHistoryNow: (groupId: string) =>
    invoke<string>("sync_group_history_now", { groupId }),
  /** 停止一趟正在跑的群历史同步（协作式：当前页处理完就停）。返回短码。 */
  cancelGroupHistory: (groupId: string) =>
    invoke<string>("cancel_group_history", { groupId }),
  leaveGroup: (groupId: string) => invoke<void>("leave_group", { groupId }),
  getGroups: () => invoke<Group[]>("get_groups"),
  getGroupReads: (groupId: string) => invoke<GroupReadInfo[]>("get_group_reads", { groupId }),
  /**
   * 发群消息（文本 / 代码 / 合并）。
   *
   * `mentions` = 这条文本 @ 了哪些人（设备 id）。**三态里"没带这个键"是有意义的**：
   * 缺省 ⇒ 载荷里不写 mentions 字段 ⇒ 接收端退回按昵称判定（旧版本对端就是这个形态）。
   * 所以这里不能写成 `mentions ?? []` —— 空数组是"明确回答谁都没 @"，语义完全不同。
   * 展开而不是直接传 `mentions`：不依赖序列化器会不会丢掉 undefined。
   */
  sendGroupMessage: (
    groupId: string,
    content: string,
    kind: string,
    mentions?: string[],
    localId?: string,
  ) =>
    invoke<MessageRecord>("send_group_message", {
      groupId,
      content,
      kind,
      ...(mentions ? { mentions } : {}),
      localId,
    }),
  listGroupFiles: (groupId: string) =>
    invoke<unknown>("list_group_files", { groupId }).then((v) =>
      parseIpcList(groupFileEntrySchema, v, "list_group_files"),
    ),
  /** 发布群公告（仅群主；上限 500 字）。 */
  sendGroupAnnouncement: (groupId: string, text: string) =>
    invoke<MessageRecord>("send_group_announcement", { groupId, text }),
  /**
   * 新建群任务（任意成员）。`assignees` 至少一人且都得是群成员（后端校验）。
   * 任务状态初始为「待办」，四态取值见 `utils/todos.ts` 的 `TODO_STATUSES`。
   */
  sendGroupTodo: (
    groupId: string,
    title: string,
    assignees: string[],
    description?: string,
    images?: TodoImage[],
    category?: string,
    customCategory?: string,
    customIcon?: string,
  ) =>
    invoke<MessageRecord>("send_group_todo", {
      groupId,
      title,
      assignees,
      description: description ?? null,
      images: images ?? null,
      category: category ?? null,
      customCategory: customCategory ?? null,
      customIcon: customIcon ?? null,
    }),
  /**
   * 更新群任务：改状态 / 改标题与指派人 / 改描述与图片 / 删除（`deleted: true`）。
   *
   * 后端会按"只改状态""改指派人""改结构"分别判权限，并把 `creator` 用库里的原值回填
   * （不接受客户端自报）；`done_at` / `archived` 由后端在「完成」时按权威时间填。
   */
  updateGroupTodo: (
    groupId: string,
    todoId: string,
    patch: {
      title: string;
      assignees: string[];
      status: string;
      deleted: boolean;
      description?: string;
      images?: TodoImage[];
      /** 显式归档意图：`true` = 手动归档；`undefined` = 不改（保留库中原值）。 */
      archived?: boolean;
      /** 三档之一；不传 = 这次不动优先级。 */
      priority?: string;
      /** 类型（任务/需求/缺陷/自定义）；不传 = 这次不动类型。 */
      category?: string;
      /**
       * 自定义类型名：仅 category="custom" 时有意义。**显式传 `""` = 随调用一起提交**
       *（非 custom 档时后端会清空它）；`undefined` = 这次不带这格，后端沿用库里的名字。
       */
      customCategory?: string;
      /**
       * 自定义类型图标（白名单内的键名，见 `utils/todos.ts` 的 `TODO_CUSTOM_ICONS`）。
       * 仅 custom 档有意义；`undefined` = 这次不带这格，后端沿用库里挑过的图标。
       */
      customIcon?: string;
    },
  ) =>
    invoke<MessageRecord>("update_group_todo", {
      groupId,
      todoId,
      title: patch.title,
      assignees: patch.assignees,
      status: patch.status,
      deleted: patch.deleted,
      description: patch.description ?? null,
      images: patch.images ?? null,
      archived: patch.archived ?? null,
      priority: patch.priority ?? null,
      category: patch.category ?? null,
      customCategory: patch.customCategory ?? null,
      customIcon: patch.customIcon ?? null,
    }),
  /** 置顶/取消置顶一条群消息（任意群成员；静默事件，不进时间线）。 */
  pinGroupMessage: (groupId: string, target: string, pinned: boolean) =>
    invoke<MessageRecord>("pin_group_message", { groupId, target, pinned }),
  /** 撤回自己发的一条群消息（仅原作者；窗口 5 分钟，只在发送端强制）。 */
  recallGroupMessage: (groupId: string, target: string) =>
    invoke<void>("recall_group_message", { groupId, target }),
  /** 撤回自己发的一条单聊消息（仅原作者；服务端 5 分钟窗口）。 */
  recallDirectMessage: (friendId: string, target: string) =>
    invoke<void>("recall_message", { friendId, target }),
  /**
   * 取消一条**还在投递队列里**的消息（自己发的、非文件）。
   *
   * 返回结构化结果：群消息可能只取消了**剩余成员**（有人已经收到），
   * `delivered` / `remaining` 就是界面要说的两个数；`not_found` 不是错误
   * （消息可能刚被清理/不存在），由界面自己决定怎么说。
   */
  cancelMessage: (convId: string, msgId: string) =>
    invoke<MessageCancelResult>("cancel_message", { convId, msgId }),
  /** 群消息的成员级投递台账摘要（只含还有非 delivered 行的消息）。 */
  getGroupDeliverySummaries: (convId: string) =>
    invoke<GroupDeliverySummary[]>("get_group_delivery_summaries", { convId }),
  /**
   * 重发一条**本端判失败/已取消**的 1:1 消息，复用原 `msg_id` / `ts` / `seq`。
   *
   * 接收端按 `msg_id` 去重 —— 上一次其实送到了、只是 Ack 丢了的话，对方只再回一次 Ack，
   * 不会多出一条重复消息（这正是"重试必须复用稳定消息身份"的全部意义）。
   */
  resendMessage: (convId: string, msgId: string) =>
    invoke<MessageRecord>("resend_message", { convId, msgId }),
  /**
   * 把一条群消息里被取消的成员行重置为 pending 并补发。
   *
   * 不重签/不重加密：复用原 Gossip 信封，接收端按 msg_id 幂等 ⇒ 已 Ack 的成员不会收到第二条。
   * 在线成员立即发，离线成员保持 pending、上线后自动补。
   */
  resendGroupDelivery: (convId: string, msgId: string) =>
    invoke<GroupResendResult>("resend_group_delivery", { convId, msgId }),
  /** 切换自己发的代码/文本消息渲染（LWW，所有支持该能力位的成员生效）。 */
  setMessageRender: (convId: string, target: string, mode: "code" | "text") =>
    invoke<void>("set_message_render", { convId, target, mode }),
  /** 表情回应：一条**静默事件**（不计未读、不改预览、不弹通知）。 */
  sendGroupReaction: (groupId: string, target: string, emoji: string, add: boolean) =>
    invoke<MessageRecord>("send_group_reaction", { groupId, target, emoji, add }),

  // 自绘标题栏：窗口控制
  windowMinimize: () => invoke<void>("window_minimize"),
  windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
  windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
  windowClose: () => invoke<void>("window_close"),
  /** macOS：窄窗口（前端移动布局）时把系统红绿灯收起 / 拉宽后放回（其它平台空操作）。 */
  setNativeTitlebarButtonsHidden: (hidden: boolean) =>
    invoke<void>("set_native_titlebar_buttons_hidden", { hidden }),

  /** 取消一条文件传输：返回的是**台账**口径（这一单现在算不算被取消），不是"有没有命中在途任务"。 */
  cancelFileTransfer: (transferId: string) =>
    invoke<{
      cancelled: boolean;
      alreadyDone: boolean;
      notifiedPeer: boolean;
      /** 台账那一笔写是否真的落地；false = 事务回滚，界面要说「本机已停止、状态待重试」。 */
      ledgerCommitted: boolean;
    }>("cancel_file_transfer", { transferId }),
  /**
   * 取消一单**按 cid 拉取的内容**（任务中心内容行的「取消」）。
   *
   * 与文件取消同口径：先停本机接收器，再把内容台账落成 Rejected(Cancelled) ——
   * 后者是终态，所以下一次建链的自动重取**不会**把用户刚取消的东西又拉一遍。
   */
  cancelContentFetch: (cid: string) =>
    invoke<ContentCancelResult>("cancel_content_fetch", { cid }),
  sendFileAuto: (friendId: string, path: string) =>
    invoke<string>("send_file_auto", { friendId, path }),
  sendGroupFile: (groupId: string, path: string) =>
    invoke<string>("send_group_file", { groupId, path }),
  saveOutgoingImage: (dataUrl: string) =>
    invoke<{ path: string; name: string; size: number }>("save_outgoing_image", { dataUrl }),
  deleteFile: (path: string) => invoke<void>("delete_file", { path }),
  /** 用系统默认应用打开本地文件：macOS 走 NSWorkspace（沙盒下 /usr/bin/open 被拦），
   *  Windows/Linux 走 opener。
   *  `owner` = 消息 id（`file-{tid}` / `gfile-{tid}`）：后端据此回绑 `file_transfers.path`，
   *  拒绝打开"不属于这条消息"的路径（SEC-01）。收藏入口传 `null`。 */
  openFileNative: (path: string, owner: string | null) =>
    invoke<void>("open_file_native", { path, owner }),
  /** macOS 窗口圆角：WebView 加载完成后调用（setup 阶段设会被 wry 替换 contentView 丢失）。 */
  applyMacosWindowShape: (dark: boolean) =>
    invoke<void>("apply_macos_window_shape", { dark }),
  getTransfers: () => invoke<TransferInfo[]>("get_transfers"),
  /**
   * 统一任务中心：还没送到对端的消息行。与 `getTransfers` 同一族（都是"还没办完的事"），
   * 起点是补发队列；`peer_offline` 由后端用 `has_link` 填，前端不许按 peers 列表再猜。
   */
  getPendingMessageOperations: () =>
    invoke<PendingMessageOp[]>("get_pending_message_operations"),
  /** 统一内容传输状态（ADR-0019）：未完成/失败的内容气泡据此显示重试。 */
  getContentTransfers: () => invoke<ContentTransfer[]>("get_content_transfers"),

  /** 读取附件预览原始字节（图片→Blob/objectURL，代码→TextDecoder）。超限后端 reject "TOO_LARGE"。
   *  注意：后端 raw bytes 在 macOS(WKWebView) 上经 JSON 序列化回传为 number[]，
   *  其余平台为 ArrayBuffer——调用方需按平台形状归一化成字节再使用。 */
  readFilePreview: (msgId: string, maxBytes: number) =>
    invoke<ArrayBuffer | number[]>("read_file_preview", { msgId, maxBytes }),

  /** 按 content store 的 cid 读取已落盘内容字节（合并转发卡片图片预览 + 待办描述图片缩略图共用）。
   *  cid 即 sha256；两条取回路径见后端 `read_content_preview`（store 直取 → find_source + 安全校验）。 */
  readContentPreview: (cid: string, maxBytes: number) =>
    invoke<ArrayBuffer | number[]>("read_content_preview", { cid, maxBytes }),
  /** 媒体是否仍在本机（未被「存储清理」删除）。仅"确定已删除"时返回 false，
   *  查不到消息（在途的乐观消息）返回 true——不能把在途消息误标成已清理。 */
  mediaPresent: (msgId: string) => invoke<boolean>("media_present", { msgId }),

  /**
   * 以下 6 条以前**没有门面包装**：组件里直接 `invoke("copy_file", …)`，
   * 于是"读 `src/api/index.ts` 就知道全部接口面"这个前提是假的（架构复审 0-A3 收口，
   * 由 `events.test.ts` 的「IPC 只能从 src/api 门面走」钉住）。
   */
  /** 复制文件（另存为 / 拖拽保存）。Android 的"用户取消"是 reject，不是返回 null。 */
  copyFile: (source: string, destination: string) =>
    invoke<void>("copy_file", { source, destination }),
  /** 文件本体写系统剪贴板（CF_HDROP）：可在资源管理器粘贴，也可粘回聊天框发送。 */
  copyFileToClipboard: (path: string) => invoke<void>("copy_file_to_clipboard", { path }),
  /** base64 写到目标路径（另存为的落地一步）。 */
  saveDataFile: (base64Data: string, destination: string) =>
    invoke<void>("save_data_file", { base64Data, destination }),
  /** 按 msg_id / cid 从后端直接另存（源文件已在后端，不走 base64 IPC）。 */
  saveMediaAs: (source: { msgId?: string; cid?: string }, destination: string) =>
    invoke<void>("save_media_as", {
      msgId: source.msgId,
      cid: source.cid,
      destination,
    }),
  /** 剪贴板里的文件路径（粘贴发图那条路）。 */
  readClipboardFilePaths: () => invoke<string[]>("read_clipboard_file_paths"),
  /** 群文件每收件人进度汇总（气泡上「3/5 已收到」）。null = 这条 transfer 没有群投递记录。 */
  getGroupFileDeliverySummary: (transferId: string) =>
    invoke<{ completed: number; failed: number; waiting: number; cancelled: number } | null>(
      "get_group_file_delivery_summary",
      { transferId },
    ),
  /**
   * 前端异常落到后端日志（否则 WebView 里抛的错只有那个窗口自己知道）。
   * **刻意不 catch**：上报失败不该改变界面行为，也不该在错误处理器里再抛一个错。
   */
  logFrontendError: (kind: string, text: string) =>
    invoke<void>("log_frontend_error", { kind, text }),

  /**
   * 收藏（微信式）：**独立本地存储** —— 原消息/会话被删、缓存被清理都不影响。
   *
   * `addFavorite` 只传 `msgId` / `convId`：内容一律以后端库里的消息为准。
   * 让前端把 content 传上去的话，收藏夹里就可能存进一份与消息记录不一致的副本。
   */
  listFavorites: () => invoke<FavoriteEntry[]>("list_favorites"),
  addFavorite: (msgId: string, convId: string) =>
    invoke<FavoriteEntry>("add_favorite", { msgId, convId }),
  removeFavorite: (id: string) => invoke<void>("remove_favorite", { id }),
  /** 收藏**副本**的预览字节（图片）。契约同 `readFilePreview`，但按收藏 id 而不是 msg_id 定位。 */
  readFavoritePreview: (id: string, maxBytes: number) =>
    invoke<ArrayBuffer | number[]>("read_favorite_preview", { id, maxBytes }),
  /** 发送一张待办描述图片（复用群文件管线，scope="todo"：不进时间线、不弹气泡）。 */
  sendTodoImage: (groupId: string, todoId: string, path: string) =>
    invoke<string>("send_todo_image", { groupId, todoId, path }),

  /**
   * 本地删除若干条消息（微信语义：**只删本机**，对方那边照常保留），返回实际删除条数。
   *
   * 一次 IPC 一整批：后端在一个事务里删消息 + 清待发队列 + 重算会话摘要，
   * 前端循环调单条会让同一会话的摘要被重算 N 次。
   */
  deleteMessages: (msgIds: string[]) => invoke<number>("delete_messages", { msgIds }),

  /** 读一张待办图片的元数据（name/size/sha256/subtype），不投递字节。 */
  todoImageMeta: (path: string) => invoke<TodoImage>("todo_image_meta", { path }),  setShareDir: (path: string) => invoke<void>("set_share_dir", { path }),
  getShareDir: () => invoke<string | null>("get_share_dir"),
  getDownloadsDir: () => invoke<string>("get_downloads_dir"),
  setDownloadsDir: (path: string) => invoke<void>("set_downloads_dir", { path }),
  openDownloadsDir: () => invoke<void>("open_downloads_dir"),
  requestShareTree: (friendId: string) =>
    invoke<unknown>("request_share_tree", { friendId }).then((v) =>
      parseIpcValue(shareTreeSchema, v, "request_share_tree"),
    ),
  downloadSharedFile: (friendId: string, remotePath: string) =>
    invoke<string>("download_shared_file", { friendId, remotePath }),

  /**
   * 申请 Android 的运行时权限（「附近的设备」）。
   *
   * Android 12+ 把蓝牙拆成 SCAN/CONNECT/ADVERTISE、13+ 还要 NEARBY_WIFI_DEVICES，
   * 不申请就"局域网收不到组播 + 蓝牙通道打不开"。首次启动调一次（系统弹框），
   * 通道打开失败时也会再调一次并重试。非 Android 平台是空操作。
   */
  requestBlePermissions: () => invoke<void>("request_ble_permissions"),
  setChannelEnabled: (channel: string, enabled: boolean) =>
    invoke<RuntimeSnapshot>("set_channel_enabled", { channel, enabled }),
  /** 跨子网（Routed）端点：列表 / 添加 / 移除。添加只填地址即可（device_id 由握手学）。 */
  listRoutedEndpoints: () => invoke<RoutedEndpoint[]>("list_routed_endpoints"),
  addRoutedEndpoint: (address: string) =>
    invoke<RoutedEndpoint[]>("add_routed_endpoint", { deviceId: null, address }),
  removeRoutedEndpoint: (address: string) =>
    invoke<RoutedEndpoint[]>("remove_routed_endpoint", { address }),
  /**
   * 公网中转（盲管道，ADR-0020）：读配置 / 存配置。
   * 后端会规范化地址并在非法值时抛错 —— 调用方必须把错误原样显示给用户，
   * 这里刻意不 catch：静默吞掉就会变成"点了保存、什么也没发生"。
   */
  getRelayConfig: () => invoke<RelayConfig>("get_relay_config"),
  saveRelayConfig: (enabled: boolean, server: string, token: string) =>
    invoke<RelayConfig>("save_relay_config", { enabled, server, token }),
  /**
   * 保存前真拨一次，拿回三档结论（`unreachable` / `rejected` / `held`）。
   * 它**不改配置**，也不经过拨号器（不会登记链路）：只在裸 socket 上发一行首字，
   * 看服务器是"立刻关"还是"挂着"。口令只在参数里过一次，后端不写进日志与报告。
   */
  checkRelayServer: (server: string, token: string) =>
    invoke<RelayProbe>("check_relay_server", { server, token }),
  getCacheInfo: () => invoke<CacheInfo>("get_cache_info"),
  setCachePolicy: (retentionDays: number | null, maxBytes: number | null) =>
    invoke<void>("set_cache_policy", { retentionDays, maxBytes }),
  cleanCacheNow: () => invoke<CleanupReport>("clean_cache_now"),

  /** 导出全部聊天文字到指定文件。`utcOffsetMinutes` = -new Date().getTimezoneOffset()：
   *  Rust 侧不引入时区库，本地时间换算需要前端给出偏移。 */
  exportChatText: (destination: string, utcOffsetMinutes: number) =>
    invoke<ExportSummary>("export_chat_text", { destination, utcOffsetMinutes }),

  getSettings: () => invoke<AppSettings>("get_settings"),
  /**
   * 把**解析后**的界面语言推给后端重建 macOS 原生菜单栏（`src-tauri/src/menu.rs`）。
   * 非 macOS 平台是空实现（后端命令存在，直接 Ok），前端不必按平台分支。
   */
  setUiLanguage: (lang: string) => invoke<void>("set_ui_language", { lang }),
  saveSettings: (s: AppSettings) => invoke<void>("save_settings", { settings: s }),
  resetSettings: () => invoke<void>("reset_settings"),
  broadcastChatStyle: (style: string) => invoke<void>("broadcast_chat_style", { style }),
  clearAllData: () => invoke<void>("clear_all_data"),

  // 开发者诊断（隐藏面板用）
  getDiscoveryDiag: () => invoke<DiscoveryDiag>("get_discovery_diag"),
  /**
   * 运行时读数一次性出口（队列积压 / 链路 / 窗口 / 最近一次慢持锁）。
   *
   * 只有诊断面板打开或点刷新时才读：这几项要持 db 锁数四张表，
   * 挂到任何会轮询的出口上都是在给那条唯一连接加排队（10-22 审计 R-30 与诊断规范同一条理由）。
   */
  getRuntimeDiag: () => invoke<RuntimeDiag>("get_runtime_diag"),
  /**
   * 上报「应用是否在前台且窗口聚焦」。
   *
   * 后端蓝牙扫描据此在快/慢节奏间切换（前台 5s、后台/失焦 30s，见 `network/ble.rs`），
   * 并在切回前台时立刻补扫一轮。调用方只有一处（`App.vue` 的可见性/聚焦监听）。
   */
  setAppActive: (active: boolean) => invoke<void>("set_app_active", { active }),

  // 运行日志（「运行日志」页 / 独立窗口用）
  /**
   * 搜索聊天记录（跨会话、按会话分组，支持「发送人 / 日期」筛选）。
   * 结果页用；会话列表里那点是 `searchMessages`（每会话只回一条摘要）。
   */
  searchChatHistory: (p: {
    keyword: string;
    senderId?: string | null;
    sinceMs?: number | null;
    untilMs?: number | null;
  }) =>
    invoke<unknown>("search_chat_history", {
      keyword: p.keyword,
      senderId: p.senderId ?? null,
      sinceMs: p.sinceMs ?? null,
      untilMs: p.untilMs ?? null,
    }).then((v) => parseIpcList(chatSearchGroupSchema, v, "search_chat_history")),
  getLogs: (sinceSecs?: number | null) => invoke<LogEntry[]>("get_logs", { sinceSecs: sinceSecs ?? null }),
  clearLogs: () => invoke<void>("clear_logs"),
  /**
   * 日志文件的**真实位置**（目录 / 本轮那份 / 崩溃现场那份）。
   *
   * 三条路径都由后端按本轮解析出的 stem 给 ⇒ 前端**不许自己拼**：多实例时
   * `gosslan-1.log` 与 `gosslan.log` 只差一个数字，拼错就是让用户去复制别人的那一份。
   */
  getLogLocations: () => invoke<LogLocations>("get_log_locations"),
  /** 上一轮运行报告（崩溃横幅/启动失败提示）。只读后端算好的快照。 */
  getPreviousExit: () => invoke<PreviousRunReport>("get_previous_exit"),
  /** 一键重启（与托盘「重启」同一入口）：有界收尾 → 销毁单实例锁 → 重启。 */
  restartApp: () => invoke<void>("restart_app"),
  /**
   * 主窗口心跳：当前在途操作 + 窗口是否可见。
   *
   * 它是看门狗判断"渲染层是否卡死"的输入；不进前端追踪表（见 ipcTracker 的 EXCLUDED），
   * 否则每秒一条的自我记录会把真正的卡死原因淹掉。
   */
  uiHeartbeat: (currentOp: string | null, active: boolean) =>
    invoke<void>("ui_heartbeat", { currentOp, active }),
  /**
   * 导出**脱敏**诊断包到用户选好的落点（纯文本）。
   *
   * ⚠️ `destination` 必须是**用户**在系统保存对话框里选的那条路径：后端对空串判错，
   * 也不替用户决定写到哪（本仓不做遥测，"发不发"由人决定）。落点形状先过
   * `saveDestinationOf` 归一化（Android 的 SAF 返回的是 `{ file: "content://…" }` 对象）。
   */
  exportDiagnosticsBundle: (destination: string) =>
    invoke<DiagnosticsBundleSummary>("export_diagnostics_bundle", { destination }),
  /** 桌面端：打开独立日志窗口；移动端不要调用（用页面跳转）。 */
  openLogWindow: () => invoke<void>("open_log_window"),
  /**
   * 把「文件选择器」给的东西落地成**真实可读的文件路径**。
   *
   * Android 的系统选择器返回 `content://` URI（不是路径），Rust 侧的文件发送用 `std::fs`
   * 打不开它 —— 用户 2026-09-12 实测的「文字能发、附件/图片发不出去」就是这个。
   * 这个命令在 Android 上把它复制进应用缓存并返回真实路径；桌面端原样返回。
   */
  defaultNickname: () => invoke<string>("default_nickname"),
  importPickedFile: (path: string, suggestedName?: string) =>
    invoke<string>("import_picked_file", { path, suggestedName: suggestedName ?? null }),
  openSettingsWindow: () => invoke<void>("open_settings_window"),
  closeSettingsWindow: () => invoke<void>("close_settings_window"),

    /**
   * 让那扇**全局唯一**的群任务窗口去显示这个群（桌面端；固定 label `tasks`，切群 = 换内容）。
   * `focusTodoId` = 打开后要直接展开的那条任务（#39）；不传 = 清掉上次的待展开。
   */
  openGroupTodosWindow: (groupId: string, focusTodoId?: string) =>
    invoke<void>("open_group_todos_window", { groupId, focusTodoId: focusTodoId ?? null }),

  /**
   * 取走本窗口"该展开哪条任务"（一次性，取完即清）。
   * 新建的窗口拿不到那条定向事件（发的时候监听者还不存在），只能靠自己挂载时取一次。
   */
  takeGroupTodoFocus: (groupId: string) =>
    invoke<string | null>("take_group_todo_focus", { groupId }),

  /**
   * 群任务窗口已经存在时（不管是开着还是预热后藏着），后端定向推来的"换到这个群"提醒。
   * 载荷带 groupId ⇒ 前端拿它换上下文并**重读数据**：常驻之后没有"重建即新数据"这回事了。
   */
  onGroupTodosTarget: (cb: (payload: { groupId: string }) => void) =>
    listen<{ groupId: string }>("group-todos-target", (e) => cb(e.payload)),

  /** 这扇群任务窗口**现在该显示哪个群**（预热过、还没被真正打开时是 null）。 */
  getGroupTodosContext: () => invoke<string | null>("get_group_todos_context"),

  /**
   * **只投递**"该展开哪条"，不要求开窗口（桌面端）。
   * 必须独立于 `launchAuxWindow`：那条启动器有单飞 + 防抖，被它合并掉的那一次
   * 根本不会调 `open_group_todos_window` ⇒ 目标就地消失。
   */
  requestGroupTodoFocus: (groupId: string, todoId: string) =>
    invoke<void>("request_group_todo_focus", { groupId, todoId }),

  // ---------------- 全局图片预览（用户 2026-09-24 #40） ----------------
  /**
   * 把这份相册设为**那个全局唯一预览窗口**的内容（桌面端）。
   * 已开着就替换内容并聚焦，没开就建一个 —— 调用方不需要知道窗口在不在。
   */
  openImagePreview: (items: PreviewImage[], index: number) =>
    invoke<void>("open_image_preview", { gallery: { items, index } }),
  /** 预览窗口自己取"现在该显示哪一份"（不清：每次投递都整体覆盖，见 Rust 侧说明）。 */
  getImagePreviewGallery: () => invoke<PreviewGallery | null>("get_image_preview_gallery"),
  /** 窗口已经开着时的"内容换了，再取一次"提醒。 */
  onImagePreviewChanged: (cb: () => void) => listen("preview-gallery", () => cb()),
  /**
   * 把高频的两扇窗（图片预览 + 群任务）**先建好、文档先加载**，但不显示也不抢焦点。
   * 桌面端启动后延后一拍调用；失败无所谓（最坏就是第一次仍然慢一点），
   * 所以调用方一律 `.catch(() => {})`，不要给它弹提示。
   */
  prewarmAuxWindows: () => invoke<void>("prewarm_aux_windows"),


  /** 在独立窗口里加载一个外部网址（桌面端；窗口隔离，不授予远端页面任何命令权限）。 */
  openLinkWindow: (url: string, name: string) => invoke<void>("open_link_window", { url, name }),

  // ---------------- 外部链接（左栏「链接」视图） ----------------
  listExternalLinks: () => invoke<ExternalLink[]>("list_external_links"),
  addExternalLink: (name: string, url: string) =>
    invoke<ExternalLink[]>("add_external_link", { name, url }),
  updateExternalLink: (id: string, name: string, url: string) =>
    invoke<ExternalLink[]>("update_external_link", { id, name, url }),
  removeExternalLink: (id: string) => invoke<ExternalLink[]>("remove_external_link", { id }),
  updaterCheck: () => invoke<UpdaterInfo | null>("updater_check"),
  updaterDownload: (onEvent: (event: UpdaterDownloadEvent) => void) => {
    const channel = new Channel<UpdaterDownloadEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("updater_download", { onEvent: channel });
  },
  updaterCancel: () => invoke<void>("updater_cancel"),
  /** 当前更新状态（B5）：跨窗口共用一份，设置窗重开/任务中心首帧都用它补拉。 */
  updaterStatus: () => invoke<UpdaterStatus>("updater_status"),
  updaterInstall: () => invoke<void>("updater_install"),
  updaterClose: () => invoke<void>("updater_close"),
  exportExternalLinks: () => invoke<string>("export_external_links"),
  cleanupExternalLinksExport: (path: string) =>
    invoke<void>("cleanup_external_links_export", { path }),
  importExternalLinksFile: (path: string) =>
    invoke<ExternalLinkImportResult>("import_external_links_file", { path }),
  importExternalLinksFromUrl: (url: string) =>
    invoke<ExternalLinkImportResult>("import_external_links_from_url", { url }),

  /** 保存一张**粘贴**进任务表单的图片（raw IPC 直传字节），返回落盘路径。
   *  之后与选图同一条路：`todoImageMeta(path)` → 元数据进定义，`sendTodoImage(path)` → 字节投递。 */
  saveTodoImageBytes: (bytes: Uint8Array) =>
    invoke<string>("save_todo_image_bytes", bytes),

  /** 删除一条群公告（仅群主；发 `announcement_delete` 墓碑，全端折掉横幅）。 */
  deleteGroupAnnouncement: (groupId: string, annId: string) =>
    invoke<MessageRecord>("delete_group_announcement", { groupId, annId }),

  /** 当前生效的群公告（每群一条）：会话列表 📢 标记的数据源。 */
  listActiveGroupAnnouncements: () =>
    invoke<{ groupId: string; msgId: string; text: string }[]>("list_active_group_announcements"),
};

// ---------------- 诊断出口（命令返回值） ----------------

/**
 * `get_log_locations` 的返回（Rust `diagnostics::LogLocations`）。
 *
 * ⚠️ 那个结构体**没有 serde rename**，字段本来就是全小写单词 ⇒ JS 侧同名；
 * 后端加新字段时这里要跟着加，否则界面上读不到。
 */
export interface LogLocations {
  /** 日志目录。 */
  dir: string;
  /** **本轮**正在写的那份（多实例时带序号）。 */
  current: string;
  /** 崩溃现场那份。 */
  crash: string;
}

/** `export_diagnostics_bundle` 的成功摘要（Rust `diagnostics::BundleSummary`，同样未 rename）。 */
export interface DiagnosticsBundleSummary {
  /** 实际落盘字节数。 */
  bytes: number;
  /** 真正读到的文件份数（本轮 / 上一代 / 崩溃现场；没有就是 0）。 */
  files: number;
  /** 脱敏命中处数（用户据此知道自己发出去的是什么）。 */
  redactions: number;
  /** 实际落盘路径。 */
  path: string;
}

// ---------------- 事件监听 ----------------

/**
 * `settings-changed` 的载荷（与 Rust 侧 `SettingsPatch` 逐字对应）。
 *
 * · `changed`：哪些键变了（camelCase；`"*"` = 全量都变了 ⇒ 做一次完整重拉）
 * · `origin`：发起窗口的标签（诊断用；发起窗口自己收不到这个事件）
 * · `settings`：只含变了的键的那一小块快照，可直接交给 `applySettingsSnapshot`
 */
export interface SettingsChanged {
  changed: string[];
  origin?: string | null;
  settings?: Partial<AppSettings> | null;
}

export interface PeerStyleUpdate {
  device_id: string;
  style: string;
}

/** 「用户点了系统通知」的载荷（后端 `notification-clicked` 事件）。 */
export interface NotificationClick {
  /** `"chat"` = 聊天消息（带 `conv_id`）；`"friend_request"` = 好友申请。 */
  type: "chat" | "friend_request";
  /** 聊天消息才有：点开要定位到哪个会话。 */
  conv_id?: string;
  /** 强提醒才有：被提醒的原消息（点开后继续定位到它，不只是打开会话）。 */
  msg_id?: string;
}

export type EventHandlers = {
  onPeers: (peers: Peer[]) => void;
  onFriendRequest: (req: PendingRequest) => void;
  onFriendAccepted: (id: string) => void;
  onFriendRejected: (id: string) => void;
  onFriendRemoved: (id: string) => void;
  /** 观察到某位好友的新身份密钥（候选），聊天界面应提示同步。 */
  onFriendKeyChanged: (id: string) => void;
  /** 某好友的密钥轮换已被用户确认同步。 */
  onFriendKeysSynced: (id: string) => void;
  onFriendMessageBlocked: (id: string) => void;
  onMessage: (rec: MessageRecord) => void;
  onMessageAcked: (msgId: string) => void;
  onPeerRead: (p: PeerReadInfo) => void;
  onGroupRead: (p: GroupReadInfo) => void;
  /** 某条消息被撤回（msg_id）。本地据此把该行改成「已撤回」形态。 */
  onMessageRecalled: (msgId: string) => void;
  /** 某条消息的渲染方式被作者切换（LWW 已由后端裁决）。 */
  onMessageRenderChanged: (msgId: string, kind: "code" | "text") => void;
  onFileProgress: (p: FileProgress) => void;
  onFileStalled: (p: FileStalledInfo) => void;
  onFileDone: (d: FileDoneInfo) => void;
  onFileFailed: (d: FileFailedInfo) => void;
  /** 用户手动取消了一条正在发送的文件（transfer_id）。前端据此 mark failed + toast。 */
  onFileCancelled: (transferId: string) => void;
  /** 更新状态跃迁（B5）：两个窗口都会收到同一份快照。 */
  onUpdaterStatus: (s: UpdaterStatus) => void;
  /** 某条消息状态变更（msg_id: file-{tid} / gfile-{tid} 等）。前端据此刷新气泡状态。 */
  onMessageStatusChanged: (msgId: string) => void;
  /**
   * 某个群消息的**成员级投递台账**变了（Ack 落地 / 取消剩余成员 / 补发 / 清扫判死）。
   *
   * 载荷是 `{group_id, msg_id}`；`group_id` 是**裸 id**（没有 `group:` 前缀）。
   * 前端只做一件事：重拉那个群的 `get_group_delivery_summaries`。计数不许自己推。
   */
  onGroupDeliveryChanged: (p: { group_id: string; msg_id: string }) => void;
  /**
   * 某条消息**判死**（msg_id）。与上面那条的区别是有没有带事实：outbox 清扫已经把库里
   * 这行写成 failed 才发这个事件，所以事件名就是结论，前端不必回库查（也查不到新东西）。
   */
  onMessageFailed: (msgId: string) => void;
  onPeerStyle: (p: PeerStyleUpdate) => void;
  /** 群信息变更（群密钥建群 / 群改名 / 成员变更） */
  onGroupsUpdated: (groupId: string) => void;
  /**
   * 群历史同步进度（新成员入群后后台自动补聊天与群任务，见 Rust
   * `network/group_history.rs`）。`running` 期间提示条常驻，`done` / `failed` 收起。
   */
  onGroupHistoryProgress: (p: GroupHistoryProgress) => void;
  /** 自己被移出群（group_id） */
  onGroupMemberRemoved: (groupId: string) => void;
  /** 群发受众预告：这条 kind 群里有成员版本较旧会看成原始文本（消息已发出，仅解释）。 */
  onContentAudience: (p: ContentAudience) => void;
  /**
   * 用户点了系统通知（桌面端；移动端走插件的 `actionPerformed`）。
   * 后端已经顺手把主窗口唤起，这里只需把界面切到目标会话 / 「新的朋友」。
   */
  onNotificationClicked: (p: NotificationClick) => void;
  /** 另一个窗口清空了聊天数据（本窗口必须重建本地视图） */
  onDataCleared: () => void;
  /**
   * 群文件投递诊断行（后端事件 `group-file-log`，载荷是一行诊断文本）。
   *
   * 后端在群文件投递失败时把原因（哪个收件人、卡在哪一步）emit 出来，此前**没有任何订阅者**，
   * 只挂在一条例外清单上写"暂无消费者（保留待接）"⇒ 用户看得到"K 人失败"，
   * 却永远看不到为什么（10-22 审计 R-28 / D-3）。接进诊断面板，不弹 toast ——
   * 这是给排障看的细节，不是每个用户都该被打断的东西。
   */
  onGroupFileLog: (line: string) => void;
};

/** 逐个 settle 一批 `listen` 注册，成功的一律交回、失败的按错误文本交回。
 *
 *  为什么不能直接 `await Promise.all([listen(), listen(), …])`（这里此前就是那样写的）：
 *  `Promise.all` 只要有一个 reject 就**永远不产出数组**，而其余二十几个监听此时**已经真的注册进
 *  内核**了 —— 它们的 unlisten 句柄只随返回值交出。返回值一丢，这批句柄就永久失踪；
 *  下一次 `init` 重连只做 `chatInitScope?.dispose()`，回收不到它们 ⇒ 新旧两套监听并存，
 *  同一个事件被处理两遍，而旧闭包引用的是上一轮的 store 状态。界面**完全无症状**，
 *  表现是「某个功能哪天起就再没反应了」。
 *
 *  事件名不许从这里的字面量形状搬走：`src/api/events.test.ts` 用「`listen` 后可选泛型 + 左括号 +
 *  字符串字面量」现解析前端订阅集合，改成包装函数会让那条契约判据数到更少的订阅而**不报错**。
 *  （顺带一条实测教训：那条提取器**会读注释** —— 本文件注释里出现上述形状的示例文本，
 *  就会被数成一条真监听，并让「前端听、后端不发」那条判据报出一个名叫 `name` 的死监听。） */
async function settleRegistrations(
  registrations: Array<Promise<UnlistenFn>>,
): Promise<{ unlisteners: UnlistenFn[]; errors: string[] }> {
  const unlisteners: UnlistenFn[] = [];
  const errors: string[] = [];
  await Promise.all(
    registrations.map((p) =>
      p.then(
        (u) => {
          unlisteners.push(u);
        },
        (e: unknown) => {
          errors.push(e instanceof Error ? e.message : String(e));
        },
      ),
    ),
  );
  return { unlisteners, errors };
}

/** 注册所有后端事件监听，返回取消函数集合。 */
export async function bindEvents(h: EventHandlers): Promise<UnlistenFn[]> {
  const registrations: Array<Promise<UnlistenFn>> = [
    listen<Peer[]>("peers-updated", (e) => h.onPeers(e.payload)),
    listen<PendingRequest>("friend-request", (e) => h.onFriendRequest(e.payload)),
    listen<string>("friend-accepted", (e) => h.onFriendAccepted(e.payload)),
    listen<string>("friend-rejected", (e) => h.onFriendRejected(e.payload)),
    listen<string>("friend-removed", (e) => h.onFriendRemoved(e.payload)),
    listen<string>("friend-key-changed", (e) => h.onFriendKeyChanged(e.payload)),
    listen<string>("friend-keys-synced", (e) => h.onFriendKeysSynced(e.payload)),
    listen<string>("friend-message-blocked", (e) => h.onFriendMessageBlocked(e.payload)),
    listen<MessageRecord>("message-received", (e) => h.onMessage(e.payload)),
    listen<string>("message-acked", (e) => h.onMessageAcked(e.payload)),
    // 群消息的送达确认走**独立事件**（载荷 `{group_id, msg_id}`）；此前前端没接，
    // 群消息气泡的"已送达"只能等其它刷新才更新。
    listen<{ msg_id: string }>("group-message-acked", (e) => h.onMessageAcked(e.payload.msg_id)),
    listen<PeerReadInfo>("peer-read", (e) => h.onPeerRead(e.payload)),
    listen<GroupReadInfo>("group-read", (e) => h.onGroupRead(e.payload)),
    listen<string>("message-recalled", (e) => h.onMessageRecalled(e.payload)),
    listen<{ msg_id: string; kind: string }>("message-render-changed", (e) =>
      h.onMessageRenderChanged(e.payload.msg_id, e.payload.kind === "code" ? "code" : "text"),
    ),
    listen<FileProgress>("file-progress", (e) => h.onFileProgress(e.payload)),
    listen<FileStalledInfo>("file-stalled", (e) => h.onFileStalled(e.payload)),
    listen<FileDoneInfo>("file-done", (e) => h.onFileDone(e.payload)),
    listen<FileFailedInfo>("file-failed", (e) => h.onFileFailed(e.payload)),
    listen<string>("file-cancelled", (e) => h.onFileCancelled(e.payload)),
    listen<UpdaterStatus>("updater-status", (e) => h.onUpdaterStatus(e.payload)),
    listen<string>("message-status-changed", (e) => h.onMessageStatusChanged(e.payload)),
    listen<{ group_id: string; msg_id: string }>("group-delivery-changed", (e) =>
      h.onGroupDeliveryChanged(e.payload),
    ),
    // 后端改了这些消息的状态就发对应事件（sweeper 判失败 / Ack 到达 / 文件被取消）。
    // 分两类，按**事件带不带结论**判：
    // - 只给 id（`message-status-changed`）：结论得回库查 ⇒ 正在看的会话重查，
    //   没在看的等下次打开重查（`openConversation` 每次都拉 DB，已实测）。
    // - 事件名就是结论（`message-failed`，outbox 先写库再发）：直接把这个事实盖到缓存上，
    //   包含没在看的会话。这不是"第二套状态机"——写的就是库里那一份的值（INV-006/P15），
    //   `file-cancelled` 从来就是这么做的。以前它挂在重查那一类上，代价是一次 IPC + 整列表
    //   重建，而**后台会话依然什么都不更新**。
    listen<string>("message-failed", (e) => h.onMessageFailed(e.payload)),
    listen<PeerStyleUpdate>("peer-style-updated", (e) => h.onPeerStyle(e.payload)),
    listen<string>("groups-updated", (e) => h.onGroupsUpdated(e.payload)),
    // 群历史同步进度（新成员入群后后台自动补，见 Rust `network/group_history.rs`）。
    listen<GroupHistoryProgress>("group-history-progress", (e) =>
      h.onGroupHistoryProgress(e.payload),
    ),
    listen<string>("group-member-removed", (e) => h.onGroupMemberRemoved(e.payload)),
    listen<ContentAudience>("content-audience", (e) => h.onContentAudience(e.payload)),
    // 「用户点了系统通知」：后端在 notify-rust 的点击回调里唤起主窗口后发出（见
    // notifications::on_notification_clicked）。桌面端**只有这一条**点击来源 ——
    // 插件的 actionPerformed 只有移动端会发。
    listen<NotificationClick>("notification-clicked", (e) => h.onNotificationClicked(e.payload)),
    // 「另一个窗口清了数据」：后端在 clear_all_data 末尾广播（见 state::EVENT_DATA_CLEARED）
    listen("data-cleared", () => h.onDataCleared()),
    // 群文件投递诊断（后端 `commands/group_todo_media.rs::app_handle_log`）。
    listen<string>("group-file-log", (e) => h.onGroupFileLog(e.payload)),
  ];
  const { unlisteners, errors } = await settleRegistrations(registrations);
  if (errors.length > 0) {
    // 「要么全接上、要么一套都不留」：留着半套交回去也没用 —— 调用方 reject 后会重连，
    // 而重连只 dispose 它拿得到手的那份，剩下这些句柄就成了孤儿监听。
    for (const u of unlisteners) {
      try {
        u();
      } catch {
        // 回收失败不去掩盖注册失败本身
      }
    }
    throw new Error(
      `${errors.length}/${registrations.length} 个事件监听注册失败：${errors.join("；")}`,
    );
  }
  return unlisteners;
}

// ---------------- 应用级动作（原生菜单 ↔ 键盘快捷键） ----------------
// 动作名与 emitAction 抽到 utils/appActions.ts：useShortcuts / shortcuts 这类纯逻辑也要用，
// 而纯逻辑会被 node:test 直接 import（Node 无法解析 @/ 别名）。这里继续 re-export，
// 保证既有的 `import { APP_ACTION } from "@/api"` 调用处无需改动。
import { APP_ACTION, emitAction, onAction, NAVIGATE_TO_CONTACTS } from "../utils/appActions";
import type { AppAction } from "../utils/appActions";
export { APP_ACTION, emitAction, onAction, NAVIGATE_TO_CONTACTS };

/**
 * 监听 macOS 原生菜单栏的自定义项 → 转成应用级动作。
 * 菜单只在 macOS 建立（见 src-tauri/src/menu.rs），非 macOS 平台 listen 静默无事件。
 */
export async function bindMenuEvents(): Promise<UnlistenFn[]> {
  const to = (action: AppAction) => () => emitAction(action);
  const registrations: Array<Promise<UnlistenFn>> = [
    listen("menu://settings", to(APP_ACTION.openSettings)),
    listen("menu://add-friend", to(APP_ACTION.addFriend)),
    listen("menu://search", to(APP_ACTION.focusSearch)),
    listen("menu://logs", to(APP_ACTION.openLogs)),
  ];
  const { unlisteners, errors } = await settleRegistrations(registrations);
  if (errors.length > 0) {
    // 这条**不抛**：调用方是 `void bindMenuEvents().then(…)`（ResponsiveLayout），抛出会变成
    // unhandled rejection。菜单快捷键是锦上添花，注册失败留成功的部分继续用即可。
    console.error(
      `${errors.length}/${registrations.length} 个原生菜单事件注册失败：${errors.join("；")}`,
    );
  }
  return unlisteners;
}
