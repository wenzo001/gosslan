// 与 Rust 后端 serde 结构一一对应的前端类型

export interface DeviceInfo {
  device_id: string;
  nickname: string;
  avatar: string | null;
  device_type: string;
  tcp_port: number;
  online: boolean;
  x25519_pubkey: string;
  ed25519_pubkey: string;
}

export interface Peer {
  device_id: string;
  nickname: string;
  avatar: string | null;
  device_type: string;
  ip: string;
  tcp_port: number;
  last_seen: number;
  rtt_ms: number | null;
  x25519_pubkey: string | null;
  ed25519_pubkey: string | null;
  /** 首次发现该节点的时间戳 */
  first_seen: number | null;
  /** 当前实际链路类型：`lan` / `routed` / `relay`（公网中转）/ `bluetooth`（无链路时缺省） */
  link?: string | null;
}

export interface Friend {
  device_id: string;
  nickname: string;
  avatar: string | null;
  device_type: string;
  /**
   * 对端 Gosslan 的应用版本（如 `"4.22.34"`）。缺省/`null` = 还没连过，**或对方是不报版本的
   * 老版本** —— 两者都不猜（INV-P24）。只用于给人看，不参与兼容判断。
   */
  peer_app_version?: string | null;
  /**
   * 对端**线格式**版本比本机高 ⇒ 界面给一句可解释提示。
   * 判定只在后端一处（`protocol::peer_protocol_is_newer`）；前端不许自己比数字，
   * 否则 `PROTOCOL_VERSION` 就有了第二份真相源。未声明版本的老老实例一定是 false。
   */
  peer_version_newer?: boolean;
  online: boolean;
}

export interface PendingRequest {
  from: string;
  from_nickname: string;
  from_avatar: string | null;
  ts: number;
}

/**
 * 一条「好友身份密钥已更换、等待用户确认」的候选（对方卸载重装等场景）。
 * 候选里的新公钥已经在后端通过新私钥的 Hello 自验签（证明持有新私钥），
 * 但是否是本人仍需用户带外确认，确认后调用 syncFriendKeys 覆盖绑定。
 */
export interface FriendKeyRotation {
  device_id: string;
  nickname: string;
  x25519_pubkey: string;
  ed25519_pubkey: string;
  ts: number;
}

export type MsgKind =
  | "text"
  | "code"
  | "image"
  | "file"
  | "system"
  | "reaction"
  | "recall"
  | "recalled"
  | "pin"
  | "announcement"
  | "announcement_delete"
  | "todo"
  | "todo_update"
  | "poll"
  | "poll_vote"
  /** 合并转发的聊天记录（微信式卡片）。Bubble 类：进时间线、计未读、可搜索。 */
  | "merge"
  /** 强提醒发起 / 回执（Silent 类：不进时间线、不计未读、不弹普通通知）。 */
  | "remind"
  | "remind_ack"
  /** 代码/文本渲染切换（Silent 类）。 */
  | "render";

/** 表情回应的事件载荷（kind = "reaction" 时 content 的 JSON 形态）。 */
export interface ReactionPayload {
  /** 被回应的消息 msg_id */
  target: string;
  /** 表情 token，如 "[赞]" */
  emoji: string;
  /** true = 添加，false = 取消 */
  add: boolean;
}

/** 强提醒发起载荷（kind = "remind" 时 content 的 JSON 形态，对应 Rust RemindPayload）。 */
export interface RemindPayload {
  /** 被提醒的原消息 msg_id */
  target: string;
  /** 群聊：显式提醒对象（device_id）；私聊为空、目标恒为对方。第一版不默认全群。 */
  actors: string[];
  /**
   * 「抖动」标记（工具栏抖动按钮发起）：复用同一条 remind 传输与回执，但接收端**只抖不弹**——
   * 不弹强提醒的系统通知（用户 2026-10-15：「抖动就可以了，不要接强提醒的弹窗通知」）。
   * 缺省（普通强提醒）不写本字段，载荷保持逐字节不变。
   */
  shake?: boolean;
  /**
   * 独立窗口抖动：不锚定消息、不回执、不折叠强提醒；`target` 允许为空。
   * 只有声明了 `CONTENT_FEATURE_NUDGE` 的对端才会收到。
   */
  nudge?: boolean;
}

/** 强提醒回执阶段：alerted=接收端自动（S3），confirmed=用户主动确认（S4）。 */
export type RemindAckStage = "alerted" | "confirmed";

/** 强提醒回执载荷（kind = "remind_ack"，对应 Rust RemindAckPayload）。 */
export interface RemindAckPayload {
  /** 对应 remind 事件的 msg_id */
  target: string;
  stage: RemindAckStage;
}

export interface MessageRecord {
  id: number;
  msg_id: string;
  /**
   * **持久本地身份**（DB v13→v14）：列表 key 用它。乐观气泡在服务端 `msg_id`
   * 到达之前就有一个稳定值；替换真实记录时 key 不变（不会整行重挂）。
   */
  local_id?: string | null;
  conv_id: string;
  sender_id: string;
  receiver_id: string;
  kind: MsgKind;
  content: string;
  ts: number;
  /** 每会话逻辑序号（Lamport），前端与后端都以它排序，而非墙上时钟。 */
  seq: number;
  status: string;
  /**
   * 这条文本消息 @ 了哪些**人**（设备 id 列表），由发送方在发出的那一刻算好随载荷带来。
   *
   * 三态（`messageMentionsMe` 按它判红点）：数组 = 发送方的权威回答（空数组即"没 @ 任何人"）；
   * `undefined` / `null` = 不知道（发送方是不认识该字段的旧版本，或这条来自库里 ——
   * **它不落库**，只随本次投递过来，因为「有人@我」本来就是摄入时的一次性判定，重启即清空）。
   */
  mention_ids?: string[] | null;
  /**
   * 每条 @ 在正文里的**落点**（#122：群里两个人同名时，只有被点名的那一段该算"@到我"）。
   * 与 `mention_ids` 同样三态；结构与后端 `protocol::MentionTarget` 一字不差
   * （`n` = 该昵称在正文里第几次以 `@昵称` 出现，1 起 —— 不用字符偏移是因为 Rust 按字节、
   * JS 按 UTF-16，偏移跨语言传必错）。
   * ★ 与 `mention_ids` **不同**的一点（4.31.2 起）：**这一份落库**（`messages.mention_targets`，
   * 迁移 v10→v11）。因为"哪一段算谁"是那句话的历史事实，不落库就等于重启后同一句话换了意思；
   * 而"`有人@我`"是一次性判定，重启不该再亮。老行 / 老对端 / 那一列写坏 ⇒ `null` = 不知道
   * ⇒ 呈现层退回按昵称判（与旧版本同一兜底路径）。
   */
  mention_targets?: { id: string; name: string; n: number }[] | null;
}

/**
 * 一条收藏（微信式）。
 *
 * **独立于消息存储**：`content` 是收藏当时的快照，图片/文件的 `content.path` 已指向
 * 收藏副本（不是原消息所在的下载目录）—— 所以删会话、清缓存之后这条收藏仍然打得开。
 */
export interface FavoriteEntry {
  id: string;
  msg_id: string;
  conv_id: string;
  sender_id: string;
  kind: MsgKind;
  content: string;
  /** 原消息时间（列表里显示"这条内容是什么时候的"） */
  ts: number;
  /** 收藏时间（列表排序键，新的在前） */
  favorited_at: number;
  /** 收藏副本的绝对路径（仅 image/file，纯文本为 null） */
  media_path: string | null;
  media_size: number;
  /** 副本是否还在磁盘上（后端在列表查询时填）；false ⇒ 渲染「已清理」占位 */
  available: boolean;
}

export interface Conversation {
  id: string;
  kind: "single" | "group";
  name: string;
  avatar: string | null;
  last_msg: string | null;
  last_ts: number | null;
  unread: number;
  /** 本机置顶（纯本地偏好，不广播不同步）。列表排序时优先于 last_ts。 */
  pinned: boolean;
}

/** 群文件列表项（「群文件」面板）。本机持有状态与群投递进度是两回事。 */
export interface GroupFileEntry {
  transfer_id: string;
  name: string;
  size: number;
  sender_id: string;
  created_at: number;
  /** local = 本机可打开；receiving = 传输中；remote = 未取到；failed = 取失败可重试 */
  local_state: "local" | "receiving" | "remote" | "failed";
  /** 仅 local_state === "local" 时给出的本机真实路径 */
  local_path: string | null;
  /** 该文件对全群的投递进度（已完成成员数 / 成员总数） */
  delivered: number;
  total: number;
}

/** 会话的「当前链路」快照：最近一条消息走的链路 + 中间节点数。 */
export interface LinkState {
  /** `lan` / `routed`（跨网段·VPN 直达）/ `relay`（公网中转电路）/ `bluetooth`。 */
  path: "lan" | "routed" | "relay" | "bluetooth";
  hop: number;
}

export interface Group {
  id: string;
  name: string;
  creator: string;
  members: string[];
}

/**
 * 全局图片预览里的一张图（用户 2026-09-24 #40）。字段名即**线格式**
 * （Rust `PreviewItem` 用 `rename_all = "camelCase"` 与它对上）。
 *
 * 三种取字节的来源，按优先级：`dataSrc`（已在手边的 data URL）→ `cid`（待办描述图）
 * → `msgId`（聊天消息）。⚠️ `blob:` objectURL **不属于任何一种**：它只在发起它的那个文档里
 * 有效，跨到预览窗口就是破图 ⇒ 带 blob 的那份相册不走窗口，留在应用内覆盖层
 * （判据在前端 `deliverableToWindow`，后端 `validate_preview` 再钉一次）。
 */
export interface PreviewImage {
  name: string;
  dataSrc?: string | null;
  msgId?: string;
  cid?: string;
}

/** 一次预览投递 = 相册 + 起始下标（窗口里的左右循环就在这个数组上转）。 */
export interface PreviewGallery {
  items: PreviewImage[];
  index: number;
}

export interface InterfaceInfo {
  name: string;
  ip: string;
}

export interface ShareEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** 文件消息 content 的 JSON 载荷（附件名 / 本地路径 / 大小 / 子类型）。 */
export interface FileMeta {
  name: string;
  path: string;
  size: number;
  /** 后端按扩展名分类的附件子类型；历史消息缺省按 file 处理。 */
  subtype: string;
  /** 内容指纹（= cid，明文 sha256，ADR-0019）。合并转发卡片按它按需拉取；旧版本消息可能没有。 */
  sha256?: string;
}

/** 统一内容传输状态（ADR-0019）：前端气泡据此显示发送中/等待/重试/完成。 */export interface ContentTransfer {
  cid: string;
  peerId: string;
  groupId: string | null;
  name: string;
  size: number;
  direction: "send" | "receive";
  status: "queued" | "active" | "verifying" | "complete" | "incomplete" | "rejected";
  received: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  path: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TransferInfo {
  id: string;
  peer_id: string;
  name: string;
  size: number;
  direction: "send" | "receive";
  status: string;
  path: string | null;
  progress: number;
  /** 排队中为什么不动；稳定短码，前端映射文案。null = 没有额外阻塞信息。 */
  blocked_reason: string | null;
  /** 建行时刻（毫秒）。传输面板与统一任务中心共用这一个排序键。 */
  created_at: number;
}

/**
 * 统一任务中心里"消息还没送到对端"那一行（`db::PendingMessageOp`）。
 * 起点是补发队列（`outbox` / `group_outbox`）而不是 `messages.status`；
 * `peer_offline` 由命令层用 `has_link` 填 —— 数据库不知道链路在不在。
 */
export interface PendingMessageOp {
  msg_id: string;
  kind: string;
  peer_id: string | null;
  group_id: string | null;
  /** 还有几个人没收到：1:1 恒为 1，群消息是仍在队列里的成员数。 */
  waiting_for: number;
  created_at: number;
  /** 只有 text/code 给正文截断；其它 kind 是 JSON 载荷 ⇒ null，界面按 kind 说类型。 */
  preview: string | null;
  peer_offline: boolean;
  /** 这一行现在点取消会不会成功（与后端 `cancel_message` 同一判据：台账里还有 pending 行）。 */
  can_cancel: boolean;
  /** 群消息：已有成员确认收到（台账里的 delivered 行），但队列里还有人 ⇒ 说「部分成员已收到」。 */
  some_delivered: boolean;
}

export interface FileProgress {
  transfer_id: string;
  received: number;
  total: number;
}

/** 链路停滞状态翻转（与 Rust `state::FileStalledInfo` 同形）。
 *  `idle_ms` 是距最近一次**真正写出**分片的毫秒数，不是投进队列的时间。
 *  `reason` = 为什么停（缺省 = 普通链路静默，界面用既有的「网络停滞」文案）。 */
export interface FileStalledInfo {
  transfer_id: string;
  stalled: boolean;
  idle_ms: number;
  reason?: string;
}

export interface FileDoneInfo {
  transfer_id: string;
  name: string;
  size: number;
  path: string;
}

export interface FileFailedInfo {
  transfer_id: string;
  reason: string;
}

/** 对方已读回执（peer-read 事件载荷） */
export interface PeerReadInfo {
  peer_id: string;
  last_read_ts: number;
}

/** 群成员级已读回执。reader_id 读到 last_read_ts 为止。 */
export interface GroupReadInfo {
  group_id: string;
  reader_id: string;
  last_read_ts: number;
}

/**
 * 取消一条消息的结构化结果（2026-10-25，与 Rust `MessageCancelResult` 同形）。
 *
 * 为什么不再用短码：群消息取消可能是**部分成功**（有人已收、其余还在排队），
 * 界面要同时说出"几个人收到了"和"几个人没收到"，一个字符串装不下。
 * `remaining` 是取消之后仍未送达的成员数（含之前就已取消/放弃的）。
 */
export interface MessageCancelResult {
  outcome:
    | "cancelled"
    | "partial_cancelled"
    | "already_cancelled"
    | "already_delivered"
    | "already_failed"
    | "rejected"
    | "not_found";
  /** 已经确认收到这条消息的成员数（1:1 是 0/1）。 */
  delivered: number;
  /** 取消后仍未送达的成员数。 */
  remaining: number;
  /** 取消前是否可能已经写出（1:1 非 sending 即 true；群一入队就可能被 flush，恒为 true）。 */
  wasWritten: boolean;
}

/**
 * 一条群消息的成员级投递台账摘要（`get_group_delivery_summaries`）。
 *
 * 只有**还有非 delivered 行**的消息才有这条：全部送达的墓碑已被即时清理。
 * 这四个计数就是气泡上「X 人已收到 / Y 人未收到」与「补发」按钮的唯一依据 ——
 * 不允许前端自己从别处推算（那会是第二套真源）。
 */
export interface GroupDeliverySummary {
  msg_id: string;
  delivered: number;
  pending: number;
  cancelled: number;
  failed: number;
}

/** 群消息按成员补发的结果（`resend_group_delivery`）。 */
export interface GroupResendResult {
  outcome:
    | "resent"
    | "already_pending"
    | "already_delivered"
    | "already_failed"
    | "no_ledger"
    | "not_found"
    | "unsupported";
  /** 在线成员数：它们的行被立即 flush（只发原先被取消的那些）。 */
  online: number;
  /** 离线成员数：行保持 pending，上线后由 flush 自动补。 */
  offline: number;
  /** 补发后仍未送达的成员数（在线 + 离线）。 */
  remaining: number;
}

/**
 * 取消一单按 cid 拉取的内容（`cancel_content_fetch`，2026-10-25）。
 *
 * `alreadyDone` / `ledgerCommitted` 与文件取消同一套口径：本机停手 ≠ 台账已收口。
 */
export interface ContentCancelResult {
  cancelled: boolean;
  alreadyDone: boolean;
  /** 被停下的接收器个数。 */
  stopped: number;
  /** 台账那一笔是否全部落地；false = 界面说「本机已停止、状态待刷新」。 */
  ledgerCommitted: boolean;
}

/**
 * 群历史同步进度（事件 `group-history-progress`，见 Rust 侧
 * `network/group_history::emit_progress`）。
 *
 * `phase` 四档：`running`（还在取页）/ `done`（这一趟收口）/ `cancelled`（用户停止，
 * 已拉到的部分保留、标记仍待同步）/ `failed`（本机或所有源出问题，标记保持待同步、
 * 后台还会再试）。文案整句由前端按 `synced/total` 组 ——
 * 这里没有像「受众预告」那样由后端拼句，因为分母本身会随源机读数变化，
 * 拼好的整句一旦落后于计数就会在界面上自相矛盾。
 */
export interface GroupHistoryProgress {
  group_id: string;
  source: string;
  synced: number;
  total: number;
  phase: "running" | "done" | "cancelled" | "failed";
  reason?: string | null;
}

/**
 * 群发「受众预告」（事件 `content-audience`，见 Rust 侧 `protocol::kind_audience_hint`）。
 *
 * 消息**已经发出去了** —— 这条只解释"群里有谁会把这条看成一段原始文本"，不是失败通知。
 * 文案整句由后端拼（判据与文案必须在同一处），前端不再自己组句子。
 */
export interface ContentAudience {
  conv_id: string;
  msg_id: string;
  hint: string;
}

/** 传输通道状态（局域网 / 蓝牙） */
/**
 * 运行状态的**唯一快照**（与 Rust 的 `RuntimeSnapshot` 逐字对应，用户要求的第 ② 项）。
 *
 * 以前"局域网开着没有"有**两份**前端状态（`channels[lan].enabled` 与 `online`），
 * 各自被不同命令+事件维护 ⇒ 必然出现"外面开了、里面还是关的"。
 * 现在前端只认这一份：`api.getRuntimeSnapshot()` / `runtime-changed` 事件载荷。
 */
export interface RuntimeSnapshot {
  channels: ChannelStatus[];
  online: boolean;
  boundIp: string | null;
  /** 蓝牙里"通道状态装不下"的事实（例如本次构建是否编译了蓝牙特性） */
  ble: { featureCompiled: boolean };
  /** 在线节点数（完整列表仍走 `peers-updated`，避免每次开关都搬全表） */
  peerCount: number;
  /** **我自己的在线状态**：任一通道在跑 = 在线；两个都关才是离线（用户 2026-09-12 定的规则） */
  present: boolean;
  /** 已配置的「跨网段 / VPN」端点数（不是发现通道，配置在设置页；只给"有没有"，不给地址） */
  routedEndpoints: number;
  /** 公网中转状态（只有可公开的事实，**不含口令、不含服务器地址**） */
  relay: { enabled: boolean; connected: boolean };
  /**
   * 本次启动是否因"上次在蓝牙模块崩溃"暂停了自动开启。
   * `Some(原因)` 的中文文本由后端给；界面只展示，不自己拼第二份口径。
   */
  bleAutostartHeld: string | null;
}

/** 上一轮崩溃位置（Rust `logging::PanicDetail`，serde camelCase）。 */
export interface PanicDetail {
  location: string;
  message: string;
}

/** 上一轮的卡死记录（Rust `logging::HangDetail`）。 */
export interface HangDetail {
  seconds: number;
  lastOp: string | null;
  ended: boolean;
}

/**
 * 上一轮运行报告（Rust `logging::PreviousRunReport`）。
 *
 * 启动时由后端从现场文件算一次；前端只读字段，不解析日志文本。
 */
export interface PreviousRunReport {
  /** panic | silent_kill | startup_failed | clean | no_history */
  kind: string;
  /** BOOT_PREV_* */
  code: string;
  at: string | null;
  version: string | null;
  panic: PanicDetail | null;
  hang: HangDetail | null;
  recentPanicCount: number;
  bleSuspect: boolean;
  crashLog: string;
  logDir: string;
}

/**
 * 一次性运行时读数（与 Rust `commands::RuntimeDiag` 逐字对应；serde camelCase）。
 *
 * 这是 10-22 审计 R-30 / D-16 那条「后端早就算好了，界面零入口」的出口：
 * 队列积压、窗口/链路数量、最近一次慢持锁原文。按需读，不轮询。
 * 计数读不出来时后端交回 -1（"不知道"），界面必须把负数如实显示成未知而不是"0 条积压"。
 */
export interface RuntimeDiag {
  sendingMsgs: number;
  outbox: number;
  groupOutbox: number;
  fileOutbox: number;
  links: number;
  peers: number;
  windows: number;
  hiddenWindows: number;
  dbHoldNote: string | null;
  /** 在飞的「等点击」通知线程数与上限（审计 R-08）。上限由后端给，前端不许抄常数。 */
  notifyWaiters: number;
  notifyWaitersMax: number;
}

export interface ChannelStatus {
  channel: "lan" | "bluetooth";
  enabled: boolean;
  available: boolean;
  running: boolean;
  peers: number;
  /**
   * **持久化的用户偏好**：与 running（此刻是否在跑）分开。
   *
   * 应用刚启动时通道必然没在跑，不能据此判断"用户关掉了"——自动拉起蓝牙必须看这个字段，
   * 否则退出重进会把用户明确关闭的蓝牙又打开（真机 2026-09-14）。
   */
  preferred: boolean;
}

/** 手动配置的跨子网端点（Tailscale / VPN / 跨网段）。
 *  只填地址即可，`device_id` 由握手时自动学到（后端 `RoutedEndpoint` 序列化而来）。 */
export interface RoutedEndpoint {
  device_id?: string;
  address: string;
}

/** 用户配置的外部链接（左栏「链接」视图 → 点开在独立窗口加载；后端 `ExternalLink` 序列化而来）。 */
export interface ExternalLink {
  /** 稳定主键（改名字/改网址都按它匹配）。 */
  id: string;
  name: string;
  url: string;
}

/** 应用内更新：检查结果（时间戳为 Unix 秒，文案/格式化留给界面）。 */
export interface UpdaterInfo {
  currentVersion: string;
  version: string;
  notes?: string | null;
  publishedAt?: number | null;
}

/** `updater_download` 的进度通道载荷（与 Rust `commands/updater.rs` 同形）。 */
/**
 * 更新这件事的可查询状态（B5）。两个窗口共用一份（后端 `UpdaterSession` 是 managed state），
 * 事件 `updater-status` 是它唯一的推送口径；刚打开的窗口用 `api.updaterStatus()` 补拉。
 */
export interface UpdaterStatus {
  /** `idle | checking | downloading | ready | installing | failed | cancelled`；移动端恒为 `unsupported`。 */
  phase: string;
  /** 已收到字节；`total` 缺失时它是唯一读数。 */
  downloaded: number;
  total: number | null;
  version: string | null;
  error: string | null;
}

export type UpdaterDownloadEvent =
  | { event: "Started"; data?: { contentLength?: number | null } }
  | { event: "Progress"; data?: { chunkLength?: number } }
  | { event: "Finished"; data?: undefined };

/** 外链 JSON 导入的合并结果（`links` 是导入后的完整列表）。 */
export interface ExternalLinkImportResult {
  links: ExternalLink[];
  added: number;
  skipped: number;
  invalid: number;
}

/** 应用偏好设置（外观 / 网卡选择 / 聊天样式，持久化到本地 SQLite）。
 *  E2EE 自 v0.11.0 起恒开且不可关闭，不再作为设置项。 */
export interface AppSettings {
  themeColor: string | null;
  fontFamily: string | null;
  darkMode: boolean | null;
  /** 外观模式："system"（跟随系统，默认）| "light" | "dark"。
   *  `darkMode` 是**解析后的结果**（跟随系统时由前端按系统偏好解析后回写），
   *  本字段才是**用户意图**。旧记录没有该字段 → 视为 "system"。 */
  appearanceMode: string | null;
  /** 桌面通知开关（null 视为开启）。 */
  notifyEnabled: boolean | null;
  /** 通知是否显示消息正文（null 视为显示；关掉后只提示"收到新消息"，保护锁屏隐私）。 */
  notifyShowContent: boolean | null;
  /** 强提醒是否播放系统通知声音（null 视为开；系统静音/勿扰时由系统决定不响）。 */
  remindSound: boolean | null;
  /** 强提醒是否振动（null 视为开；仅支持振动的平台生效）。 */
  remindVibrate: boolean | null;
  /** 语言偏好："system"（跟随系统，默认）| "zh-CN" | "en-US"（null 视为跟随系统）。 */
  language: string | null;
  bindIp: string | null;
  /** 聊天显示样式 JSON：{"preset":"theme","fontSize":"md"} */
  chatStyle: string | null;
  /** 对端样式表 JSON（device_id -> style JSON，后端收 ChatStyle 消息时写入） */
  peerStyles: string | null;
  /** 中继授权策略："off" | "friends" | "allowlist" | "all"（null 视为 "all"）。 */
  relayPolicy: string | null;
  /** 中继白名单 JSON 字符串数组（`allowlist` 策略用）。 */
  relayAllowlist: string | null;
}

/** 中继授权策略（与后端 `mesh::relay_policy::RelayPolicy` 一一对应）。 */
export type RelayPolicy = "off" | "friends" | "allowlist" | "all";

/**
 * 公网中转（盲管道）配置，与后端 `commands::RelayConfigView` 一一对应（ADR-0020）。
 *
 * `server` 是**后端规范化后**的 `ip:port`（省略端口时补 59993）—— 界面回显这个值，
 * 用户因此能立刻看到"实际会连哪儿"，而不是他手打的原始串。
 */
export interface RelayConfig {
  enabled: boolean;
  server: string;
  token: string;
}

/**
 * 一次"保存前真拨"的结论（后端 `check_relay_server`）。
 *
 * `kind` 是三档 **机器可读**串，与 Rust 侧 `RelayProbeKind::as_str` 同一套
 * （`INTEGRATION.md` §1.1：服务器的两种命运差两个数量级，加上纯本端可判的 TCP 失败）：
 * · `unreachable` 连不上（地址 / 端口 / 安全组）
 * · `rejected`    首行被立刻拒绝（口令 / 版本 / 格式，精确原因只在服务器日志里）
 * · `held`        首行已被接受、口令正确，只是对方这一轮没接入
 * 刻意**没有**第四种："对方没开中转"与"对方不在线"对哑管道是同一个观测，分不出来。
 */
export interface RelayProbe {
  kind: "unreachable" | "rejected" | "held";
  /** 探到的那个 `ip:port`（全不可达时是第一个候选）。与已存值不同时界面应回填。 */
  server: string;
  /** 试过哪些端口，逗号分隔 —— 供用户抄给部署服务器的人看。 */
  tried: string;
  /** 技术细节。**不含口令**。 */
  detail: string;
}

/** 缓存目录占用与策略 */
export interface CacheInfo {
  /** 已接收的图片 / 文件（落在「文件存储目录」）：文件数与合计占用 */
  media_count: number;
  media_bytes: number;
  /** 聊天记录数据库占用（含 -wal/-shm） */
  db_bytes: number;
  retention_days: number | null;
  max_bytes: number | null;
}

/** 缓存清理结果 */
export interface CleanupReport {
  removed: number;
  freed_bytes: number;
  /**
   * 数据库整理的结局（机器码，缺省 = 这一轮没做整理）：
   * - `done` —— 整理完成；
   * - `aborted` —— **超时被主动取消**：数据库**内容完好**，只是这次没压缩（下次自动再试）；
   * - `failed` —— 真的出错了。
   *
   * 为什么要单独一个字段：用户点「立即清理」后如果库没变小却什么都不说，会以为功能坏了。
   * 这三个结局对用户是三件不同的事，必须说得清。
   */
  db_compact_state?: "done" | "aborted" | "failed";
}

/** 聊天记录导出结果 */
export interface ExportSummary {
  /** 实际写入的会话数（只统计有消息的会话） */
  conversations: number;
  /** 实际写入的消息条数 */
  messages: number;
  /** 落盘路径 */
  path: string;
}

/** 搜索结果 */

/** 「搜索聊天记录」结果页的一条命中消息。 */
export interface ChatSearchMessage {
  msg_id: string;
  sender_id: string;
  sender_name: string;
  kind: string;
  content: string;
  ts: number;
}

/** 按会话分组的检索结果（左栏一个会话一行，右栏是它的命中消息）。 */
export interface ChatSearchGroup {
  conv_id: string;
  name: string;
  kind: string;
  avatar: string | null;
  /** 当前筛选条件下该会话的命中总数（微信式「共 N 条相关聊天记录」）。 */
  total: number;
  latest_ts: number;
  messages: ChatSearchMessage[];
}

// ---------------- 网络诊断（隐藏开发者面板用） ----------------

/** 一条候选链路（网卡或蓝牙）。与 Rust `state::InterfaceCandidate` 逐字对应。 */
export interface InterfaceCandidate {
  /** `lan`（真实网卡）| `bluetooth`（BLE 链路） */
  kind: "lan" | "bluetooth" | string;
  name: string;
  ip: string;
  has_broadcast: boolean;
  broadcast: string | null;
  is_rfc1918: boolean;
  is_virtual: boolean;
  score: number;
  selected: boolean;
  /** 一句话状态（蓝牙行用；网卡行为空） */
  detail: string;
}

/** 蓝牙候选的失败退避条目 */
export interface BleBackoff {
  id: string;
  failures: number;
  remaining_ms: number;
}

/**
 * 蓝牙通道事实。
 *
 * 为什么单独一块：诊断数据原来全是局域网的，纯蓝牙用户看到的是 `mode = offline`
 * （用户 2026-09-13 反馈）。蓝牙是独立通道，必须有自己的状态。
 */
export interface BleDiag {
  feature_compiled: boolean;
  enabled: boolean;
  available: boolean;
  running: boolean;
  peers: number;
  /** 当前扫描节奏来源：`active`（前台/聚焦）| `idle`（后台/失焦） */
  activity: string;
  scan_window_ms: number;
  scan_interval_ms: number;
  last_scan_ts: number;
  last_scan_total: number;
  last_scan_matched: number;
  backoff: BleBackoff[];
  no_dial: number;
}

/**
 * 网络诊断快照。
 *
 * 局域网字段（mode / bound_ip / …）**只描述局域网**；蓝牙在 `bluetooth` 里独立描述。
 * 「最近事件」已合并进运行日志（见 `AppState::push_diag_event`），不再出现在这里。
 */
export interface DiscoveryDiag {
  mode: string;
  bound_ip: string;
  selected_interface: string;
  selected_ip: string;
  tcp_listen: string;
  udp_port: number;
  broadcast_target: string;
  multicast_group: string;
  multicast_join_result: string;
  multicast_if_result: string;
  last_broadcast_send: number;
  last_multicast_send: number;
  last_announce_recv: number;
  candidates: InterfaceCandidate[];
  bluetooth: BleDiag;
  /** 本机线格式版本（跨版本排查的基准行） */
  protocol_version: number;
  /** 本机应用版本，只给人看 */
  app_version: string;
  /** 各对端在 Hello 里声明的版本 */
  peer_versions: PeerVersionDiag[];
  /** 按**连接**（不是按 peer）列出的收发活性读数 */
  conn_health: ConnHealthDiag[];
}

/**
 * 诊断面板的一行「这条连接最后一次读到 / 写出是什么时候」。
 *
 * ⚠️ 两列语义**不可互换**（Rust 侧 `mesh::ConnectionHealth` 同一口径）：
 * · `last_write_seen_ms` = 本端写出成功。半开 TCP 上它会一直前进，所以它不是"对端活着"的证据；
 * · `last_read_seen_ms` = 本端读到并解析出**一个完整帧**（读循环一帧一次，字节级没有单独读数）。
 * `null` = 这条连接建立以来那件事从没发生过（不是"很久以前"）。
 */
export interface ConnHealthDiag {
  device_id: string;
  conn_id: string;
  endpoint: string;
  path_kind: string;
  last_write_seen_ms: number | null;
  last_read_seen_ms: number | null;
  write_age_ms: number | null;
  read_age_ms: number | null;
  healthy: boolean;
  consecutive_failures: number;
}

/** 诊断面板的一行「对端声明了什么版本」（ADR-0007 决策 1）。 */
export interface PeerVersionDiag {
  device_id: string;
  nickname: string;
  /** null = 对端是没报版本的老版本，不当成 0 也不当成 1 */
  protocol_version: number | null;
  app_version: string | null;
}

// ---------------- 运行日志（「运行日志」页用） ----------------

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** Unix 毫秒时间戳 */
  ts: number;
  level: LogLevel;
  /** 子系统名（transport / lan / routed / mesh / friend …） */
  target: string;
  message: string;
}
