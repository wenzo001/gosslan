// Tauri 后端调用封装（invoke 参数使用 camelCase，后端自动转换为 snake_case）。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, CacheInfo, ChatSearchGroup, CleanupReport, ContentTransfer, Conversation, DeviceInfo, DiscoveryDiag, ExportSummary, FileDoneInfo, FileFailedInfo, FileProgress, FavoriteEntry, Friend, Group, GroupFileEntry, GroupReadInfo, InterfaceCandidate, InterfaceInfo, LinkState, LogEntry, MessageRecord, Peer, PeerReadInfo, PendingRequest, RoutedEndpoint, RuntimeSnapshot, SearchResult, ShareEntry, TopologyInfo, TransferInfo } from "@/types";

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
  getDeviceInfo: () => invoke<DeviceInfo>("get_device_info"),
  updateProfile: (nickname: string, avatar: string | null) =>
    invoke<DeviceInfo>("update_profile", { nickname, avatar }),
  listInterfaces: () => invoke<InterfaceInfo[]>("list_interfaces"),
  /** 起/停局域网：返回**新的运行状态快照**（发起窗口零额外 IPC）。 */
  startNetwork: (bindIp: string) => invoke<RuntimeSnapshot>("start_network", { bindIp }),
  stopNetwork: () => invoke<RuntimeSnapshot>("stop_network"),
  /** 取运行状态快照（唯一真相源；旧 `get_channel_status`/`get_network_status` 已删除）。 */
  getRuntimeSnapshot: () => invoke<RuntimeSnapshot>("get_runtime_snapshot"),
  getTopology: () => invoke<TopologyInfo>("get_topology"),

  getPeers: () => invoke<Peer[]>("get_peers"),
  searchNearbyPeers: () => invoke<Peer[]>("search_nearby_peers"),
  focusWindow: () => invoke<void>("focus_window"),
  /**
   * 桌面系统通知（原生；返回 false 表示用户关了通知）。移动端仍走 plugin 通知。
   *
   * `convId` 必须传：**点通知要定位到会话**就得让后端知道这条通知属于谁 ——
   * 点击是后端（notify-rust 的 handle）捕获的，前端拿不到那个时机。
   */
  notifyDesktop: (title: string, body: string, convId: string) =>
    invoke<boolean>("notify_desktop", { title, body, convId }),
  /** 设置页「发送测试通知」：成功返回平台说明，失败返回真实原因（供排障）。 */
  sendTestNotification: () => invoke<string>("send_test_notification"),
  getFriends: () => invoke<Friend[]>("get_friends"),
  /** 与指定对端的**安全码**（双方一致，供带外核对）。null = 还缺对方公钥，算不出来。 */
  getSafetyNumber: (peerId: string) =>
    invoke<string | null>("get_safety_number", { peerId }),
  removeFriend: (peerId: string) => invoke<void>("remove_friend", { peerId }),
  getPendingRequests: () => invoke<PendingRequest[]>("get_pending_requests"),
  sendFriendRequest: (peerId: string) => invoke<void>("send_friend_request", { peerId }),
  respondFriendRequest: (peerId: string, accept: boolean) =>
    invoke<void>("respond_friend_request", { peerId, accept }),

  sendMessage: (friendId: string, content: string, kind: string) =>
    invoke<MessageRecord>("send_message", { friendId, content, kind }),
  getMessages: (convId: string, limit?: number, offset?: number) =>
    invoke<MessageRecord[]>("get_messages", { convId, limit, offset }),
  getConvLink: (convId: string) => invoke<LinkState | null>("get_conv_link", { convId }),
  /** 请对端按 cid 再发一份内容（图片/文件「点击重取」）。false = 对方版本不支持。 */
  requestContent: (peerId: string, msgId: string) =>
    invoke<boolean>("request_content", { peerId, msgId }),
  getMessageCount: (convId: string) => invoke<number>("get_message_count", { convId }),
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
  leaveGroup: (groupId: string) => invoke<void>("leave_group", { groupId }),
  getGroups: () => invoke<Group[]>("get_groups"),
  getGroupReads: (groupId: string) => invoke<GroupReadInfo[]>("get_group_reads", { groupId }),
  sendGroupMessage: (groupId: string, content: string, kind: string) =>
    invoke<MessageRecord>("send_group_message", { groupId, content, kind }),
  listGroupFiles: (groupId: string) =>
    invoke<GroupFileEntry[]>("list_group_files", { groupId }),
  /** 发布群公告（仅群主；上限 500 字）。 */
  sendGroupAnnouncement: (groupId: string, text: string) =>
    invoke<MessageRecord>("send_group_announcement", { groupId, text }),
  /**
   * 新建群任务（任意成员）。`assignees` 至少一人且都得是群成员（后端校验）。
   * 任务状态初始为「待办」，四态取值见 `utils/todos.ts` 的 `TODO_STATUSES`。
   */
  sendGroupTodo: (groupId: string, title: string, assignees: string[]) =>
    invoke<MessageRecord>("send_group_todo", { groupId, title, assignees }),
  /**
   * 更新群任务：改状态 / 改标题与指派人 / 删除（`deleted: true`）。
   *
   * 后端会按"只改状态"与"改结构"分别判权限（被指派人 or 创建者 → 创建者 or 群主），
   * 并把 `creator` 用库里的原值回填（不接受客户端自报）。
   */
  updateGroupTodo: (
    groupId: string,
    todoId: string,
    patch: { title: string; assignees: string[]; status: string; deleted: boolean },
  ) =>
    invoke<MessageRecord>("update_group_todo", {
      groupId,
      todoId,
      title: patch.title,
      assignees: patch.assignees,
      status: patch.status,
      deleted: patch.deleted,
    }),
  /** 置顶/取消置顶一条群消息（任意群成员；静默事件，不进时间线）。 */
  pinGroupMessage: (groupId: string, target: string, pinned: boolean) =>
    invoke<MessageRecord>("pin_group_message", { groupId, target, pinned }),
  /** 撤回自己发的一条群消息（仅原作者；窗口 2 分钟，只在发送端强制）。 */
  recallGroupMessage: (groupId: string, target: string) =>
    invoke<void>("recall_group_message", { groupId, target }),
  /** 表情回应：一条**静默事件**（不计未读、不改预览、不弹通知）。 */
  sendGroupReaction: (groupId: string, target: string, emoji: string, add: boolean) =>
    invoke<MessageRecord>("send_group_reaction", { groupId, target, emoji, add }),

  // 自绘标题栏：窗口控制
  windowMinimize: () => invoke<void>("window_minimize"),
  windowToggleMaximize: () => invoke<boolean>("window_toggle_maximize"),
  windowIsMaximized: () => invoke<boolean>("window_is_maximized"),
  windowToggleFullscreen: () => invoke<boolean>("window_toggle_fullscreen"),
  windowClose: () => invoke<void>("window_close"),

  sendFile: (friendId: string, path: string) => invoke<string>("send_file", { friendId, path }),
  sendFileAuto: (friendId: string, path: string) =>
    invoke<string>("send_file_auto", { friendId, path }),
  sendFileRelay: (friendId: string, path: string) =>
    invoke<string>("send_file_relay", { friendId, path }),
  sendGroupFile: (groupId: string, path: string) =>
    invoke<string>("send_group_file", { groupId, path }),
  saveOutgoingImage: (dataUrl: string) =>
    invoke<{ path: string; name: string; size: number }>("save_outgoing_image", { dataUrl }),
  deleteFile: (path: string) => invoke<void>("delete_file", { path }),
  /** 用系统默认应用打开本地文件：macOS 走 NSWorkspace（沙盒下 /usr/bin/open 被拦），
   *  Windows/Linux 走 opener。 */
  openFileNative: (path: string) => invoke<void>("open_file_native", { path }),
  /** macOS 窗口圆角：WebView 加载完成后调用（setup 阶段设会被 wry 替换 contentView 丢失）。 */
  applyMacosWindowShape: (dark: boolean) =>
    invoke<void>("apply_macos_window_shape", { dark }),
  getTransfers: () => invoke<TransferInfo[]>("get_transfers"),
  /** 统一内容传输状态（ADR-0019）：未完成/失败的内容气泡据此显示重试。 */
  getContentTransfers: () => invoke<ContentTransfer[]>("get_content_transfers"),

  /** 读取附件预览原始字节（图片→Blob/objectURL，代码→TextDecoder）。超限后端 reject "TOO_LARGE"。
   *  注意：后端 raw bytes 在 macOS(WKWebView) 上经 JSON 序列化回传为 number[]，
   *  其余平台为 ArrayBuffer——调用方需按平台形状归一化成字节再使用。 */
  readFilePreview: (msgId: string, maxBytes: number) =>
    invoke<ArrayBuffer | number[]>("read_file_preview", { msgId, maxBytes }),

  /** 媒体是否仍在本机（未被「存储清理」删除）。仅"确定已删除"时返回 false，
   *  查不到消息（在途的乐观消息）返回 true——不能把在途消息误标成已清理。 */
  mediaPresent: (msgId: string) => invoke<boolean>("media_present", { msgId }),

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

  setShareDir: (path: string) => invoke<void>("set_share_dir", { path }),
  getShareDir: () => invoke<string | null>("get_share_dir"),
  getDownloadsDir: () => invoke<string>("get_downloads_dir"),
  setDownloadsDir: (path: string) => invoke<void>("set_downloads_dir", { path }),
  openDownloadsDir: () => invoke<void>("open_downloads_dir"),
  requestShareTree: (friendId: string) => invoke<ShareEntry[]>("request_share_tree", { friendId }),
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
  searchMessages: (keyword: string) => invoke<SearchResult[]>("search_messages", { keyword }),
  clearAllData: () => invoke<void>("clear_all_data"),

  // 开发者诊断（隐藏面板用）
  getDiscoveryDiag: () => invoke<DiscoveryDiag>("get_discovery_diag"),
  getInterfaceCandidates: () => invoke<InterfaceCandidate[]>("get_interface_candidates"),
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
    invoke<ChatSearchGroup[]>("search_chat_history", {
      keyword: p.keyword,
      senderId: p.senderId ?? null,
      sinceMs: p.sinceMs ?? null,
      untilMs: p.untilMs ?? null,
    }),
  getLogs: () => invoke<LogEntry[]>("get_logs"),
  clearLogs: () => invoke<void>("clear_logs"),
  /** 桌面端：打开独立日志窗口；移动端不要调用（用页面跳转）。 */
  openLogWindow: () => invoke<void>("open_log_window"),
  closeLogWindow: () => invoke<void>("close_log_window"),
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
};

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
}

export type EventHandlers = {
  onPeers: (peers: Peer[]) => void;
  onFriendRequest: (req: PendingRequest) => void;
  onFriendAccepted: (id: string) => void;
  onFriendRejected: (id: string) => void;
  onFriendRemoved: (id: string) => void;
  onFriendMessageBlocked: (id: string) => void;
  onMessage: (rec: MessageRecord) => void;
  onMessageAcked: (msgId: string) => void;
  onPeerRead: (p: PeerReadInfo) => void;
  onGroupRead: (p: GroupReadInfo) => void;
  /** 某条消息被撤回（msg_id）。本地据此把该行改成「已撤回」形态。 */
  onMessageRecalled: (msgId: string) => void;
  onFileProgress: (p: FileProgress) => void;
  onFileDone: (d: FileDoneInfo) => void;
  onFileFailed: (d: FileFailedInfo) => void;
  onPeerStyle: (p: PeerStyleUpdate) => void;
  /** 群信息变更（群密钥建群 / 群改名 / 成员变更） */
  onGroupsUpdated: (groupId: string) => void;
  /** 自己被移出群（group_id） */
  onGroupMemberRemoved: (groupId: string) => void;
  /**
   * 用户点了系统通知（桌面端；移动端走插件的 `actionPerformed`）。
   * 后端已经顺手把主窗口唤起，这里只需把界面切到目标会话 / 「新的朋友」。
   */
  onNotificationClicked: (p: NotificationClick) => void;
  /** 另一个窗口清空了聊天数据（本窗口必须重建本地视图） */
  onDataCleared: () => void;
};

/** 注册所有后端事件监听，返回取消函数集合。 */
export async function bindEvents(h: EventHandlers): Promise<UnlistenFn[]> {
  const unlisteners = await Promise.all([
    listen<Peer[]>("peers-updated", (e) => h.onPeers(e.payload)),
    listen<PendingRequest>("friend-request", (e) => h.onFriendRequest(e.payload)),
    listen<string>("friend-accepted", (e) => h.onFriendAccepted(e.payload)),
    listen<string>("friend-rejected", (e) => h.onFriendRejected(e.payload)),
    listen<string>("friend-removed", (e) => h.onFriendRemoved(e.payload)),
    listen<string>("friend-message-blocked", (e) => h.onFriendMessageBlocked(e.payload)),
    listen<MessageRecord>("message-received", (e) => h.onMessage(e.payload)),
    listen<string>("message-acked", (e) => h.onMessageAcked(e.payload)),
    // 群消息的送达确认走**独立事件**（载荷 `{group_id, msg_id}`）；此前前端没接，
    // 群消息气泡的"已送达"只能等其它刷新才更新。
    listen<{ msg_id: string }>("group-message-acked", (e) => h.onMessageAcked(e.payload.msg_id)),
    listen<PeerReadInfo>("peer-read", (e) => h.onPeerRead(e.payload)),
    listen<GroupReadInfo>("group-read", (e) => h.onGroupRead(e.payload)),
    listen<string>("message-recalled", (e) => h.onMessageRecalled(e.payload)),
    listen<FileProgress>("file-progress", (e) => h.onFileProgress(e.payload)),
    listen<FileDoneInfo>("file-done", (e) => h.onFileDone(e.payload)),
    listen<FileFailedInfo>("file-failed", (e) => h.onFileFailed(e.payload)),
    listen<PeerStyleUpdate>("peer-style-updated", (e) => h.onPeerStyle(e.payload)),
    listen<string>("groups-updated", (e) => h.onGroupsUpdated(e.payload)),
    listen<string>("group-member-removed", (e) => h.onGroupMemberRemoved(e.payload)),
    // 「用户点了系统通知」：后端在 notify-rust 的点击回调里唤起主窗口后发出（见
    // notifications::on_notification_clicked）。桌面端**只有这一条**点击来源 ——
    // 插件的 actionPerformed 只有移动端会发。
    listen<NotificationClick>("notification-clicked", (e) => h.onNotificationClicked(e.payload)),
    // 「另一个窗口清了数据」：后端在 clear_all_data 末尾广播（见 state::EVENT_DATA_CLEARED）
    listen("data-cleared", () => h.onDataCleared()),
  ]);
  return unlisteners;
}

// ---------------- 应用级动作（原生菜单 ↔ 键盘快捷键） ----------------
// 动作名与 emitAction 抽到 utils/appActions.ts：useShortcuts / shortcuts 这类纯逻辑也要用，
// 而纯逻辑会被 node:test 直接 import（Node 无法解析 @/ 别名）。这里继续 re-export，
// 保证既有的 `import { APP_ACTION } from "@/api"` 调用处无需改动。
import { APP_ACTION, emitAction } from "../utils/appActions";
export { APP_ACTION, emitAction };

/**
 * 监听 macOS 原生菜单栏的自定义项 → 转成应用级动作。
 * 菜单只在 macOS 建立（见 src-tauri/src/menu.rs），非 macOS 平台 listen 静默无事件。
 */
export async function bindMenuEvents(): Promise<UnlistenFn[]> {
  const to = (action: string) => () => emitAction(action);
  return Promise.all([
    listen("menu://settings", to(APP_ACTION.openSettings)),
    listen("menu://add-friend", to(APP_ACTION.addFriend)),
    listen("menu://search", to(APP_ACTION.focusSearch)),
    listen("menu://logs", to(APP_ACTION.openLogs)),
  ]);
}
