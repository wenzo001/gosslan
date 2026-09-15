//! 网络协议层：定义 UDP 发现包与 TCP 帧的线格式，以及与前端交互的公开类型。
//!
//! 设计要点：
//! - 所有消息均为 `{ "type": "...", ... }` 形态的 JSON，便于未来在 QUIC / WebSocket 中继上复用。
//! - TCP 帧 = 4 字节大端长度前缀 + JSON 负载，最大 64MB（足以承载 256KB 文件的 base64 分片）。

use serde::{Deserialize, Serialize};

/// UDP 发现端口（局域网广播）
pub const UDP_PORT: u16 = 59991;
/// TCP 消息/文件传输端口
pub const TCP_PORT: u16 = 59992;
/// 单帧最大字节数（64MB）
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// **预认证阶段**的单帧上限（Hello 帧远小于此：device_id + 公钥 + 签名 ≈ 数百字节）。
///
/// 为什么需要单独一个更小的上限：首帧由**任何**能连上 TCP 端口的主机发送，
/// 而 `read_bytes` 会先 `vec![0u8; len]` 再读——声明 64MiB 只发 4 字节头即可让本机
/// 先分配缓冲，且（在加超时之前）可以无限期挂在那里。预认证阶段收紧到 64KiB，
/// 把这种"未验签就吃内存"的路子堵住；验签之后才按 `MAX_FRAME` 收。
///
/// 这是"我们拒收更大帧"，不改我们发出的字节 ⇒ 无 wire 兼容问题。
pub const MAX_PREAUTH_FRAME: usize = 64 * 1024;

/// 首帧（Hello）等待上限。超时即断开：对端 accept 后一个字节都不发、
/// 或对端断电导致的半开连接，都不会再永久占着任务与 socket。
pub const FIRST_FRAME_TIMEOUT_SECS: u64 = 10;
/// 文件分片原始大小（256KB，base64 后约 342KB）
pub const FILE_CHUNK: usize = 256 * 1024;
/// 广播/发现周期（秒）
pub const ANNOUNCE_INTERVAL_SECS: u64 = 5;
/// 跨跳（无直连）节点离线判定阈值（秒）。
///
/// 跨跳节点没有直连 TCP，`last_seen` 只能靠 Presence（10s 周期）经中继转发刷新。
/// 若沿用 15s，10s 周期只留 5s 余量，Tailscale 等高延迟中继一旦抖动，某次 Presence
/// 迟到超过 15s 就被 `sweep_peers` 误删 → 在线状态「一会儿绿一会儿灰」。
/// 45s ≈ 4.5 个 Presence 周期，给中继延迟留足余量；代价是跨跳节点真正离线后
/// 最多约 45s 才判离线（可接受）。
///
/// 有直连 TCP 的节点不依赖本阈值：`sweep_peers` 用 `active_links` 直接豁免，
/// 且连接断开时由 `mark_peer_offline` 立即移除（无需超时兜底）。
pub const RELAY_PEER_TIMEOUT_SECS: i64 = 45;

/// 当前平台的设备类型标识（"desktop" / "mobile"）。
///
/// 供 Hello / UserInfo / Presence 携带，让对端知道「我是电脑还是手机」。
/// 它是**展示信息**（不参与签名、不绑定身份），旧端缺省时按空串处理。
#[cfg(desktop)]
pub fn current_device_type() -> &'static str {
    "desktop"
}
#[cfg(mobile)]
pub fn current_device_type() -> &'static str {
    "mobile"
}

/// 内容能力位：支持按 cid 拉取（ContentRequest / 拥有即授权服务）。
pub const CONTENT_FEATURE_PULL: u32 = 1 << 0;

/// 本机支持的内容能力位图。**不参与 Hello 签名**（见 hello_signing_bytes）：
/// 老端忽略该字段、新端据此决定能不能对它发拉取帧。
pub fn content_features() -> u32 {
    CONTENT_FEATURE_PULL
}

/// 消息内容类型
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MsgKind {
    Text,
    Code,
    Image,
    File,
    System,
}

impl MsgKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MsgKind::Text => "text",
            MsgKind::Code => "code",
            MsgKind::Image => "image",
            MsgKind::File => "file",
            MsgKind::System => "system",
        }
    }

    pub fn from_str(s: &str) -> MsgKind {
        match s {
            "code" => MsgKind::Code,
            "image" => MsgKind::Image,
            "file" => MsgKind::File,
            "system" => MsgKind::System,
            _ => MsgKind::Text,
        }
    }
}

/// 一种 wire kind 在**接收侧**的语义分类。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KindClass {
    /// 时间线内容：计未读、进会话预览、弹通知、可搜索。渲染成气泡或卡片。
    Bubble,
    /// 静默状态事件（表情回应、撤回 …）：**不进时间线** ——
    /// 不计未读、不改会话预览、不弹通知。前端按它驱动聚合视图
    /// （回应显示为气泡下方的 chip，而不是时间线上的一条）。
    Silent,
}

/// kind 语义的**唯一判定点**。
///
/// 为什么必须收敛到一处：接收路径、会话预览、未读、通知、搜索、已读水位、
/// 清空边界、导出 —— 全都要问「这个 kind 算不算内容」。此前这个知识散在多处、
/// 各写一串 match；每加一个新 kind 就要同时改所有地方，漏一处就是静默的行为不一致
/// （最典型的症状：回个表情把会话顶到列表最前、还弹一条系统通知）。
pub const WIRE_KINDS: &[(&str, KindClass)] = &[
    ("text", KindClass::Bubble),
    ("code", KindClass::Bubble),
    ("image", KindClass::Bubble),
    ("file", KindClass::Bubble),
    ("system", KindClass::Bubble),
    // 阶段 1：表情回应
    ("reaction", KindClass::Silent),
];

/// 未知 kind 一律按 `Bubble` 处理 —— 与 `MsgKind::from_str` 回退到 `Text` 同语义：
/// 宁可多显示一条，也不要把不认识的内容**静默吞掉**（对端版本更新时不丢消息）。
pub fn kind_class(kind: &str) -> KindClass {
    WIRE_KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, c)| *c)
        .unwrap_or(KindClass::Bubble)
}

pub fn is_silent_kind(kind: &str) -> bool {
    kind_class(kind) == KindClass::Silent
}

/// 生成 `kind NOT IN (...)` 用的 SQL 字面量列表（**从 `WIRE_KINDS` 派生**）。
///
/// 不允许在 SQL 里手写这份清单：加了新 kind 而忘了同步 SQL，就是一条静默漏判 ——
/// 而它偏偏只在下一次有人用那个功能时才暴露。
pub fn sql_kind_list(extra: &[&str], pick: impl Fn(KindClass) -> bool) -> String {
    let mut names: Vec<String> = WIRE_KINDS
        .iter()
        .filter(|(_, c)| pick(*c))
        .map(|(k, _)| format!("'{k}'"))
        .collect();
    names.extend(extra.iter().map(|k| format!("'{k}'")));
    names.join(",")
}

/// 表情回应的事件载荷（`kind = "reaction"`）。
///
/// 建模成**一串独立消息**而不是「给消息加一个可变字段」：`message_id` 是
/// `SHA-256(sender_id + nonce + payload)`，同一条业务消息不可能带不同 content 重发
/// （`gossip_engine` 的回归测试钉死了这一点）。所以「状态变化」只能是一串新事件，
/// 「当前值」由接收端按 `(seq, msg_id)` 折叠出来。
///
/// 收敛性：每个 `(target, actor, emoji)` 三元组是一个 LWW 寄存器、值为 bool。
/// 每个用户只写自己那一格 ⇒ 不存在丢更新；`(seq, msg_id)` 是全序 ⇒ 任意到达顺序收敛。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReactionPayload {
    /// 被回应的消息 msg_id
    pub target: String,
    /// 表情 token（如 `[赞]`），与正文里的表情语法同源
    pub emoji: String,
    /// true = 添加，false = 取消
    pub add: bool,
}

/// 校验一个表情 token 的**形态**（`[名字]`），拒掉空串、超长与控制字符。
///
/// 注意这里**不校验表情是否真的存在** —— 表情目录的唯一来源是前端的
/// `data/emojis.ts`（`EmojiPicker` 与正文渲染都从那里取）。在后端再维护一份名单
/// 就是第二个真相源，加一个表情要改两处、漏一处就出现「能选但发不出去」。
/// 后端只负责挡住畸形与超长输入，语义有效性交给前端。
pub fn is_valid_emoji_token(s: &str) -> bool {
    if !s.starts_with('[') || !s.ends_with(']') {
        return false;
    }
    if s.len() < 3 || s.len() > 32 {
        return false;
    }
    let inner = &s[1..s.len() - 1];
    // 内层不得再出现方括号（否则 `[[x]` 这类畸形会被当成合法 token）
    !inner.is_empty() && !inner.contains(['[', ']']) && !s.contains(char::is_control)
}

/// 共享目录条目
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ShareEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Gossip 消息类型
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GossipKind {
    /// 单聊（点对点 E2EE，仅接收方可解密）
    Chat,
    /// 群聊（群密钥对称加密）
    Group,
    /// 好友关系拦截通知（明文 JSON payload，携带 original_sender）
    FriendMessageBlocked,
    /// 节点通告：周期广播自身身份，跨跳传播让全网节点互相可见（TOFU 语义）。
    /// 明文（encrypted=false），payload 为 JSON（昵称 / 头像）。
    Presence,
    /// 好友申请（定向跨跳）：payload 为 E2EE 密文（用目标 X25519 公钥加密），
    /// `target` 指定接收方 device_id；中间节点按 target 定向转发（一跳精确，
    /// 无路由表时洪泛兜底）。
    FriendRequest,
    /// 好友申请同意（定向跨跳）：方向与 FriendRequest 相反，其余同理。
    FriendAccept,
    /// 单聊送达确认（定向跨跳）：接收方成功持久化某条单聊 Gossip 后回给原始发送方。
    /// 明文（encrypted=false），payload 为 JSON `{"msg_id":"..."}`，`target` = 原始发送方。
    /// 与直连 `Message::Ack` 语义一致，但可跨跳（跨 Tailscale 无直连时 Ack 到不了发送方）。
    ChatAck,
    /// 单聊已读回执（定向跨跳）：接收方读到某发送方消息后回执。明文，
    /// payload 为 JSON `{"last_read_ts":n,"last_read_msg_id":"..."}`，`target` = 原始发送方。
    /// 与直连 `Message::ReadReceipt` 语义一致，但可跨跳。
    ChatReadReceipt,
}

/// Gossip 广播信封（Epidemic 协议消息体）。
/// - `message_id`：SHA-256 十六进制（去重键）
/// - `sender_pubkey` / `sender_ed25519`：发送方 X25519 / Ed25519 公钥
/// - `sender_sig`：对信封不可变字段的 Ed25519 签名（身份校验；TTL 不签名，因为转发会递减）
/// - `ttl`：生存时间，每转发一次减一，归零丢弃
/// - `payload`：base64（用户聊天 `encrypted=true` 时为 `nonce || ChaCha20-Poly1305 密文`）
/// - `encrypted`：载荷是否加密；用户聊天必须为 true，内部拒绝通知可使用明文控制载荷
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GossipEnvelope {
    pub message_id: String,
    pub sender_id: String,
    /// 每条消息的随机 nonce：message_id = SHA-256(sender_id + nonce + payload)。
    /// 不再用本地时间戳参与消息身份，避免同毫秒碰撞，也避免业务身份依赖系统时间。
    #[serde(default)]
    pub nonce: String,
    pub sender_pubkey: String,
    pub sender_ed25519: String,
    pub sender_sig: String,
    pub ttl: u8,
    pub kind: GossipKind,
    pub group_id: Option<String>,
    /// 群名快照：随消息广播，接收方本地无群记录时可直接展示正确群名
    /// （不参与 `compute_message_id` 哈希，不影响跨路径去重）。
    #[serde(default)]
    pub group_name: Option<String>,
    /// 群创建者 ID + 当前成员列表：随群消息广播，使只收到群消息、
    /// 从未收到 GroupKey 的成员也能据此在本地建立/刷新群记录（含成员）。
    /// 与 `group_name` 同理，不参与 message_id 哈希。
    #[serde(default)]
    pub group_creator: Option<String>,
    #[serde(default)]
    pub group_members: Vec<String>,
    pub payload: String,
    pub ts: i64,
    /// 会话逻辑序号（Lamport），签名覆盖；接收方按此排序。
    #[serde(default)]
    pub seq: i64,
    pub encrypted: bool,
    /// 定向目标 device_id（仅 `FriendRequest` 使用；`None` = 广播）。
    /// 参与签名，中间节点不可篡改目标；不参与 message_id（nonce 已保证唯一）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl GossipEnvelope {
    /// 计算并填充 message_id（SHA-256 of sender_id + nonce + payload）。
    /// 用随机 nonce 而非时间戳：消息身份不依赖本地时钟，也不存在同毫秒碰撞。
    pub fn compute_message_id(&mut self) {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.sender_id.as_bytes());
        h.update(self.nonce.as_bytes());
        h.update(self.payload.as_bytes());
        self.message_id = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    }

    /// 生成签名材料。TTL 是唯一允许中继节点修改的字段；其余路由、身份、
    /// 群成员和载荷字段都必须被签名，避免“签名仍有效但把 Chat 改成 Group”之类的
    /// 元数据篡改。
    pub fn signing_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&(
            &self.message_id,
            &self.sender_id,
            &self.nonce,
            &self.sender_pubkey,
            &self.sender_ed25519,
            &self.kind,
            &self.group_id,
            &self.group_name,
            &self.group_creator,
            &self.group_members,
            &self.payload,
            &self.ts,
            &self.seq,
            &self.encrypted,
            &self.target,
        ))
        .unwrap_or_default()
    }
}

/// TCP 帧消息（P2P 节点间传输）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Message {
    /// 连接建立后首先发送的握手包。
    ///
    /// `nonce` + `sig` 是**连接身份认证**：只有持有 `device_id` 绑定私钥的一方
    /// 能对 `hello_signing_bytes()` 产出合法签名。接收方在建立链路前用它确认
    /// 「这个 TCP 对端确实是 device_id 本人」，杜绝任意节点冒用他人（好友/群主）
    /// device_id 建链后伪造明文控制消息（GroupMemberRemoved / GroupRename 等）。
    Hello {
        device_id: String,
        nickname: String,
        avatar: Option<String>,
        /// 设备类型（"desktop" / "mobile"，空串 = 旧端/未知）。展示信息，不参与签名。
        #[serde(default)]
        device_type: String,
        /// 内容能力位图（见 CONTENT_FEATURE_PULL）。**不参与签名**：老端忽略、新端可读。
        #[serde(default)]
        content_features: u32,
        tcp_port: u16,
        x25519_pubkey: String,
        ed25519_pubkey: String,
        /// 与对方单聊会话的本地逻辑时钟：用于建链时快速对齐，
        /// 避免双方时钟长期不同步导致新消息序号偏小。
        #[serde(default)]
        conv_clock: i64,
        /// 每次握手新生成的随机串（base64），参与签名并供接收方防重放去重。
        #[serde(default)]
        nonce: String,
        /// Ed25519 签名（base64），覆盖 `hello_signing_bytes()` 的全部字段。
        #[serde(default)]
        sig: String,
    },
    /// 心跳
    Heartbeat {
        device_id: String,
    },
    /// 用户资料变更同步（昵称/头像）
    UserInfo {
        device_id: String,
        nickname: String,
        avatar: Option<String>,
        /// 设备类型（"desktop" / "mobile"，空串 = 旧端/未知）。
        #[serde(default)]
        device_type: String,
    },
    /// 聊天样式同步：发送方广播自己的气泡/字体偏好，接收方持久化并按其偏好渲染该发送者的消息
    ChatStyle {
        from: String,
        /// 目标节点（None = 广播给所有已连接节点）
        to: Option<String>,
        /// 样式 JSON，如 {"preset":"classic","fontSize":"md","compact":true}
        style: String,
    },
    /// **按 cid 拉取内容**（ADR-0019 Phase 3）。
    ///
    /// 收到方若持有该 cid 的完整字节（content_transfers: status=complete + path），
    /// 直接回一份 FileOffer（复用既有 Chunk/Done/CompleteAck 流程）——
    /// **拥有即授权，无需人工确认**。只应发给 Hello 里声明了 CONTENT_FEATURE_PULL 的对端。
    ContentRequest {
        from: String,
        /// 明文 SHA-256（hex），与 FileOffer.file_sha256 同一口径。
        cid: String,
        name: String,
        size: u64,
        /// 断点续传：原 transfer_id（服务端要用它回发，接收端才找得到 <tid>.part）。
        #[serde(default)]
        transfer_id: String,
        /// 断点续传：接收端期望的下一片序号。
        #[serde(default)]
        from_seq: u32,
        /// 断点续传：接收端已持有的前缀字节数。
        #[serde(default)]
        from_bytes: u64,
    },
    /// 加好友申请
    FriendRequest {
        from: String,
        from_nickname: String,
        from_avatar: Option<String>,
        to: String,
        ts: i64,
    },
    FriendAccept {
        from: String,
        to: String,
    },
    FriendReject {
        from: String,
        to: String,
    },
    FriendRemove {
        from: String,
        to: String,
    },
    FriendMessageBlocked {
        from: String,
        to: String,
        original_sender: String,
    },
    /// 单聊消息
    ChatMessage {
        msg_id: String,
        from: String,
        to: String,
        kind: MsgKind,
        content: String,
        ts: i64,
        /// 会话逻辑序号（Lamport），接收方按此排序，而非发送方墙上时钟。
        #[serde(default)]
        seq: i64,
    },
    /// 送达确认（用于离线补发去重）
    Ack {
        msg_id: String,
    },
    /// 已读回执：接收方打开会话时告知发送方「读到 last_read_ts 为止的消息都看了」。
    /// `last_read_msg_id` 指向接收方最近读到的一条**发送方消息**，发送方用它
    /// 换算回自己的本地时间戳，避免设备间时钟偏差导致回执失效。
    ReadReceipt {
        from: String,
        to: String,
        last_read_ts: i64,
        #[serde(default)]
        last_read_msg_id: Option<String>,
    },
    /// 群聊成员级已读回执：接收方读到群消息的时间点。
    /// `last_read_msg_id` 与单聊回执同理，指向该成员最近读到的一条群消息。
    GroupReadReceipt {
        from: String,
        group_id: String,
        last_read_ts: i64,
        #[serde(default)]
        last_read_msg_id: Option<String>,
    },
    /// 群消息送达确认：接收方成功持久化某条群消息后回给原始发送者，
    /// 发送方据此删除对应 `group_outbox(msg_id, peer_id)` 行。
    GroupAck {
        group_id: String,
        msg_id: String,
        from: String,
    },
    // ---- 文件传输 ----
    /// 发起文件传输。`sealed_file_key`：发送方为本 transfer 生成的随机
    /// 32B 文件会话密钥，用接收方 X25519 公钥 ECDH + AEAD 封装——
    /// 只有接收方能解封；后续 FileChunk.data 均用该密钥加密。
    /// `file_sha256`：整个原文件的 SHA-256（64 位小写 hex），仅用于
    /// 文件级完整性验证；分片级防篡改由 AEAD 承担。
    FileOffer {
        transfer_id: String,
        from: String,
        name: String,
        size: u64,
        sealed_file_key: String,
        file_sha256: String,
        /// 断点续传：从第几片开始发（缺省 0 = 整份）。
        #[serde(default)]
        from_seq: u32,
        /// 断点续传：从第几字节开始发（接收端已持有的前缀字节数）。
        #[serde(default)]
        from_bytes: u64,
    },
    FileAccept {
        transfer_id: String,
    },
    FileReject {
        transfer_id: String,
        /// 断点续传：接收端**已持有的字节数**（0 = 没有前缀）。发送端据此偏移续发。
        #[serde(default)]
        received: u64,
    },
    /// `data`：文件会话密钥 AEAD 加密后的 base64（nonce || ciphertext），
    /// 密文在 TCP / 中继上均不透明。
    FileChunk {
        transfer_id: String,
        seq: u32,
        data: String,
    },
    FileDone {
        transfer_id: String,
    },
    /// 接收方对文件传输的最终确认（成功持久化并校验完成后才允许回 success=true）。
    /// 发送方只有收到 success=true 才能把本地文件消息推进到 delivered。
    FileCompleteAck {
        transfer_id: String,
        success: bool,
    },
    // ---- 共享目录 ----
    ShareTreeRequest {
        request_id: String,
        from: String,
        to: String,
    },
    ShareTreeResponse {
        request_id: String,
        from: String,
        /// 目标节点（None = 旧端直连回复）。有它才能在无直连时借中继一站送回。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        entries: Vec<ShareEntry>,
    },
    /// 请求对方共享目录中的文件（触发对方向我方发起文件传输）
    ShareFileRequest {
        transfer_id: String,
        from: String,
        path: String,
        /// 目标节点（None = 旧端直连发送）。见 ShareTreeResponse.to。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    /// Gossip 广播信封（去中心化消息分发）
    Gossip {
        envelope: GossipEnvelope,
    },
    /// 大文件切片中继转发（BitTorrent 式 Mesh 分发）
    RelayChunk {
        transfer_id: String,
        seq: u32,
        data: String,
        from: String,
        to: String,
        ttl: u8,
    },
    /// 群密钥分发（用成员公钥 ECDH 加密的群密钥）。
    /// 同时携带群名与成员列表：成员端据此在本地建群记录，
    /// 否则收到首条群消息时只能兜底成「群聊 g-xxxx」。
    GroupKey {
        group_id: String,
        from: String,
        to: String,
        key: String,
        #[serde(default)]
        group_name: String,
        #[serde(default)]
        members: Vec<String>,
        /// 该群的当前逻辑时钟：成员上线拿到密钥时同步本地时钟，
        /// 保证其后续新消息序号大于清空边界等本地水位。
        #[serde(default)]
        clock: i64,
    },
    /// 群文件发起（不含文件内容）。`sealed_file_key`：发送方为本 transfer
    /// 生成的随机 32B 文件会话密钥，用**群密钥** AEAD 封装（seal_symmetric）——
    /// 群内成员用本地 GroupKey 解封，群外与中继无法解开。
    /// 后续群文件分片均以该 file_key 加密（下一阶段实现）。
    GroupFileOffer {
        transfer_id: String,
        group_id: String,
        sender_id: String,
        name: String,
        size: u64,
        sha256: String,
        sealed_file_key: String,
    },
    /// 群文件分片。`data` = Base64(nonce || AEAD(file_key, plaintext))，
    /// file_key 仅存在于收发双方内存（AppState.group_file_keys），
    /// 群密钥只负责封装 file_key，绝不直接加密文件内容。
    GroupFileChunk {
        transfer_id: String,
        group_id: String,
        sender_id: String,
        seq: u32,
        data: String,
    },
    /// 群文件发送完毕（发送方全部分片已发出）。
    /// 接收端据此做最终校验（size + SHA-256）并落盘正式文件；
    /// 接收完成与否以接收端本地校验结果为准，本消息不是完成确认。
    GroupFileDone {
        transfer_id: String,
        group_id: String,
        sender_id: String,
    },
    /// 群文件接收完成确认（receiver → 原始 sender）。
    /// `sender_id` = ACK 发送者（即原 recipient），发送方必须校验
    /// sender_id == TCP peer_id，且 transfer 的 group_file.sender_id 是本机。
    /// success = 本地 size/SHA-256 校验通过并已 rename 落盘。
    GroupFileCompleteAck {
        transfer_id: String,
        group_id: String,
        sender_id: String,
        success: bool,
    },
    /// 群名变更广播（创建者改名后通知各成员同步本地群名）
    GroupRename {
        group_id: String,
        from: String,
        name: String,
    },
    /// 成员被移出群：仅群创建者发起，发给被移除的成员本人。
    /// 接收方删除本地群记录与会话，并撤销群密钥。
    GroupMemberRemoved {
        group_id: String,
        from: String,
        to: String,
    },
    /// 群主转让：仅**当前**创建者可发起。接收方校验 `from` 是本地记录的创建者、
    /// `to` 是群成员后，把本地群创建者改为 `to`。用于群主更换设备/卸载前移交
    /// 管理权，避免群永久失去改名/加人/踢人能力。
    GroupCreatorChanged {
        group_id: String,
        from: String,
        to: String,
    },
    /// 成员主动退群（非群主）。接收方把 `from` 从本地群成员中移除。
    /// 群主退出前必须先转让（由 `leave_group` 命令强制）。
    GroupMemberLeft {
        group_id: String,
        from: String,
    },
    /// 中继文件传输元数据（切片总数等，先于 RelayChunk）。
    /// `sealed_file_key`：与 FileOffer 同义——用接收方公钥封装的文件会话密钥，
    /// 中继节点不持有也不解封，仅接收方能解开。
    /// `file_sha256`：原文件 SHA-256（hex），中继不解密不校验，仅透传给接收方。
    RelayFileOffer {
        transfer_id: String,
        from: String,
        to: String,
        name: String,
        size: u64,
        total_chunks: u32,
        sealed_file_key: String,
        file_sha256: String,
    },
    // ---- Phase 8（ADR-0017）：外部 mesh（BitChat）的不透明帧 ----
    /// 外部 mesh 的包：Gosslan **只当中继** —— 收得到 / 去得掉重 / TTL 递减后转发，
    /// 不解密、不落库、不建用户/channel。`payload` 是原样字节的 base64。
    ///
    /// ⚠️ 决策更新（ADR-0017，用户裁定）：本版**不考虑旧版兼容**，
    /// 所以不需要能力门控/双读窗口；但保留健壮性底线 —— 畸形/超限帧**只丢这一帧、不断链**
    /// （见 [`validate_opaque_external`]）。
    OpaqueExternal {
        /// 外部帧的自有 id（仅用于去重；不进 Gosslan 的 message_id 体系）
        id: String,
        /// 剩余跳数（路由器会按自己的上限再裁剪一次）
        ttl: u8,
        /// 原样载荷（base64）
        payload: String,
    },
}

impl Message {
    /// 诊断用：这条消息的**线格式类型名**（= `#[serde(tag = "type")]` 里的那个值）。
    ///
    /// 为什么从序列化结果反读、而不是手写一遍 `match`：`Message` 有 36 个变体，
    /// 手写映射就是给协议加了**第二份事实来源** —— 将来新增变体时忘了同步，
    /// 日志里会出现**错误的类型名**，比没有日志更坏（真机排查会被带偏）。
    /// 这里永远与 serde 一致，代价是序列化一次；**只在错误/诊断路径**调用。
    pub fn wire_kind(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
            .unwrap_or_else(|| "未知类型".to_string())
    }
}

/// 单个不透明外部帧的载荷上限（解码后字节）。取 256 KiB：足够装下 BitChat 的典型包
/// （其 MTU 是几十~几百字节），又远小于 `MAX_FRAME`，不会成为内存放大入口。
pub const MAX_OPAQUE_PAYLOAD: usize = 256 * 1024;
/// 外部帧允许声明的最大 TTL（路由器另有自己的 `max_ttl` 再裁剪一层）。
pub const MAX_OPAQUE_TTL: u8 = 16;
/// 外部帧 id 的长度上限。
pub const MAX_OPAQUE_ID: usize = 128;

/// 校验不透明外部帧（**纯函数，主机可单测**）。
///
/// 返回解码后的原样字节；任何不合规都返回 `Err(原因)`，调用方**只丢这一帧**并记日志
/// （这是 ADR-0017 决策更新里保留的那条底线：健壮性，不是兼容性）。
pub fn validate_opaque_external(id: &str, ttl: u8, payload_b64: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if id.is_empty() || id.len() > MAX_OPAQUE_ID {
        return Err(format!("id 长度非法（{}）", id.len()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err("id 含非法字符".to_string());
    }
    if ttl == 0 || ttl > MAX_OPAQUE_TTL {
        return Err(format!("ttl 非法（{ttl}）"));
    }
    let bytes = STANDARD
        .decode(payload_b64)
        .map_err(|e| format!("payload 不是合法 base64：{e}"))?;
    if bytes.is_empty() {
        return Err("payload 为空".to_string());
    }
    if bytes.len() > MAX_OPAQUE_PAYLOAD {
        return Err(format!("payload 过大（{} 字节）", bytes.len()));
    }
    Ok(bytes)
}

/// Hello 帧的签名材料（版本前缀 + 全部连接身份字段）。
///
/// 用 `serde_json` 序列化元组而非手写字符串拼接：避免字段里出现分隔符时产生
/// 「不同字段组合出同一段字节」的歧义（长度前缀/分隔符逃逸问题）。
/// 接收方以 `device_id` 绑定的 Ed25519 公钥验签，从而确认 peer_id 不可冒充。
pub fn hello_signing_bytes(
    device_id: &str,
    tcp_port: u16,
    nonce: &str,
    x25519_pubkey: &str,
    ed25519_pubkey: &str,
) -> Vec<u8> {
    serde_json::to_vec(&(
        "gosslan-hello-v1",
        device_id,
        tcp_port,
        nonce,
        x25519_pubkey,
        ed25519_pubkey,
    ))
    .unwrap_or_default()
}

/// announce 的签名材料。
///
/// **只覆盖安全相关字段**：device_id / tcp_port / 两把公钥 / nonce。
/// 刻意**不含 nickname**：它随用户改名变化、且纯属展示信息，纳入签名会让
/// 「改个昵称 → 旧签名全部失效」；也不含 `kind`，由调用方保证是 announce。
pub fn announce_signing_bytes(
    device_id: &str,
    tcp_port: u16,
    nonce: &str,
    x25519_pubkey: &str,
    ed25519_pubkey: &str,
) -> Vec<u8> {
    serde_json::to_vec(&(
        "gosslan-announce-v1",
        device_id,
        tcp_port,
        nonce,
        x25519_pubkey,
        ed25519_pubkey,
    ))
    .unwrap_or_default()
}

/// UDP 广播/回复包
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UdpPacket {
    /// "announce"（主动广播自身） | "who_has"（询问局域网内谁在线）
    pub kind: String,
    pub device_id: String,
    pub nickname: String,
    pub tcp_port: u16,
    /// X25519 公钥（base64，用于 ECDH）
    pub x25519_pubkey: Option<String>,
    /// Ed25519 公钥（base64，用于验签）
    pub ed25519_pubkey: Option<String>,
    /// 每次广播新生成的随机串（base64），参与签名 —— 防重放。
    /// 旧端不发送（`serde(default)`），判定见 `verify_announce`。
    #[serde(default)]
    pub nonce: String,
    /// Ed25519 签名（base64），覆盖 `announce_signing_bytes()` 的全部字段。
    ///
    /// 历史背景：本字段缺失时，`announce` 是一条**完全无认证**的信道 ——
    /// 包里的 device_id 与公钥都是明文，任何人都能伪造。曾经的后果是
    /// 「未签名的广播绑定了身份，且写进持久化的 friends 表」（见 CHANGELOG 4.9.1）。
    /// 现在补上签名后，**能**做到的：防篡改、防重放、让每条广播可归因到某个密钥持有者。
    /// **仍做不到**的：阻止攻击者用自己的密钥签一个「自称是某人」的包 ——
    /// 那是首次接触（TOFU）的固有限制，要靠带外指纹核对（见 `Peer.keys_verified` 的说明）。
    #[serde(default)]
    pub sig: String,
}

/// `announce` 的认证判定结果。
#[derive(Debug, PartialEq, Eq)]
pub enum AnnounceAuth {
    /// 签名有效：广播者持有其所声明 Ed25519 公钥的私钥。
    /// **注意这仍不等于「他就是那个 device_id」** —— 见 `UdpPacket::sig` 的说明。
    Verified,
    /// 无签名（旧端）。**仍然接受用于发现**：它只驱动「拨号」，
    /// 而真正的身份绑定由 Hello 验签决定（announce 来的公钥一律 `keys_verified = false`）。
    /// 硬拒会让旧端在局域网内彻底不可见 —— 代价大于收益。
    Legacy,
    /// 带签名但验不过：包被篡改或伪造，必须丢弃。
    Invalid(String),
}

/// 校验一条 `announce`/`who_has` 包的自签名。**纯函数**，便于单测。
pub fn verify_announce(pkt: &UdpPacket) -> AnnounceAuth {
    let (Some(x), Some(e)) = (
        pkt.x25519_pubkey.as_deref().filter(|s| !s.is_empty()),
        pkt.ed25519_pubkey.as_deref().filter(|s| !s.is_empty()),
    ) else {
        // who_has 不带公钥也不带签名，属正常形态
        return if pkt.sig.is_empty() {
            AnnounceAuth::Legacy
        } else {
            AnnounceAuth::Invalid("带签名但缺少公钥".to_string())
        };
    };
    if pkt.sig.is_empty() {
        return AnnounceAuth::Legacy;
    }
    if pkt.nonce.is_empty() {
        return AnnounceAuth::Invalid("带签名但缺少 nonce（无法防重放）".to_string());
    }
    let data = announce_signing_bytes(&pkt.device_id, pkt.tcp_port, &pkt.nonce, x, e);
    if crate::crypto::verify_signature(e, &data, &pkt.sig) {
        AnnounceAuth::Verified
    } else {
        AnnounceAuth::Invalid("签名校验失败".to_string())
    }
}

#[cfg(test)]
mod tests {
    use crate::crypto::Identity;

    // ---------------- announce 自签名 ----------------

    /// 按线上形态构造一条自签名 announce。
    fn signed_announce(
        id: &Identity,
        device_id: &str,
        port: u16,
        nonce: &str,
    ) -> super::UdpPacket {
        let x = id.x25519_public_b64();
        let e = id.ed25519_public_b64();
        let sig = id.sign_b64(&super::announce_signing_bytes(device_id, port, nonce, &x, &e));
        super::UdpPacket {
            kind: "announce".to_string(),
            device_id: device_id.to_string(),
            nickname: "nick".to_string(),
            tcp_port: port,
            x25519_pubkey: Some(x),
            ed25519_pubkey: Some(e),
            nonce: nonce.to_string(),
            sig,
        }
    }

    #[test]
    fn announce_verified_when_self_signed() {
        let id = Identity::generate();
        let pkt = signed_announce(&id, "dev-a", 59992, "n1");
        assert_eq!(super::verify_announce(&pkt), super::AnnounceAuth::Verified);
    }

    /// 篡改任何**被签名覆盖**的字段都必须失败 —— 这是「防篡改」的全部内容。
    #[test]
    fn announce_rejects_tampering_on_every_signed_field() {
        let id = Identity::generate();
        let base = signed_announce(&id, "dev-a", 59992, "n1");

        let mut p = base.clone();
        p.device_id = "victim".to_string();
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)), "改 device_id");

        let mut p = base.clone();
        p.tcp_port = 1;
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)), "改 tcp_port");

        let mut p = base.clone();
        p.nonce = "n2".to_string();
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)), "改 nonce");

        // 换成攻击者自己的公钥（想把绑定指向自己的密钥）
        let attacker = Identity::generate();
        let mut p = base.clone();
        p.ed25519_pubkey = Some(attacker.ed25519_public_b64());
        p.x25519_pubkey = Some(attacker.x25519_public_b64());
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)), "换公钥");

        // nickname **不在**签名范围内（改名不该让签名失效），故意不测它
        let mut p = base.clone();
        p.nickname = "换个昵称".to_string();
        assert_eq!(super::verify_announce(&p), super::AnnounceAuth::Verified, "nickname 不参与签名");
    }

    /// 用别人的公钥声称自己是对方：签名一定对不上（攻击者没有对方私钥）。
    #[test]
    fn announce_rejects_forged_signature_with_victim_pubkey() {
        let attacker = Identity::generate();
        let victim = Identity::generate();
        let vk = victim.ed25519_public_b64();
        let vx = victim.x25519_public_b64();
        // 攻击者用**自己的**私钥签，却声明受害者的公钥
        let sig = attacker.sign_b64(&super::announce_signing_bytes("victim", 59992, "n1", &vx, &vk));
        let pkt = super::UdpPacket {
            kind: "announce".to_string(),
            device_id: "victim".to_string(),
            nickname: String::new(),
            tcp_port: 59992,
            x25519_pubkey: Some(vx),
            ed25519_pubkey: Some(vk),
            nonce: "n1".to_string(),
            sig,
        };
        assert!(matches!(super::verify_announce(&pkt), super::AnnounceAuth::Invalid(_)));
    }

    /// 旧端不签名 → 放行（Legacy）。硬拒会让旧端在局域网内彻底不可见，
    /// 而 announce 本就不能用于身份绑定（公钥恒为 keys_verified=false），放行的风险可控。
    #[test]
    fn announce_without_signature_is_legacy_not_rejected() {
        let id = Identity::generate();
        let mut pkt = signed_announce(&id, "dev-a", 59992, "n1");
        pkt.sig = String::new();
        assert_eq!(super::verify_announce(&pkt), super::AnnounceAuth::Legacy);

        // who_has：不带公钥也不带签名，是正常形态
        let probe = super::UdpPacket {
            kind: "who_has".to_string(),
            device_id: "dev-a".to_string(),
            nickname: String::new(),
            tcp_port: 59992,
            x25519_pubkey: None,
            ed25519_pubkey: None,
            nonce: String::new(),
            sig: String::new(),
        };
        assert_eq!(super::verify_announce(&probe), super::AnnounceAuth::Legacy);
    }

    /// 带签名却缺 nonce / 缺公钥 → 无法防重放或无法验签，必须拒。
    #[test]
    fn announce_rejects_signed_but_incomplete_packets() {
        let id = Identity::generate();

        let mut p = signed_announce(&id, "dev-a", 59992, "n1");
        p.nonce = String::new();
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)));

        let mut p = signed_announce(&id, "dev-a", 59992, "n1");
        p.x25519_pubkey = None;
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)));

        let mut p = signed_announce(&id, "dev-a", 59992, "n1");
        p.ed25519_pubkey = Some(String::new());
        assert!(matches!(super::verify_announce(&p), super::AnnounceAuth::Invalid(_)));
    }

    /// 签名材料对每个字段敏感（防止将来有人漏字段导致"改了也能过"）。
    #[test]
    fn announce_signing_bytes_sensitive_to_every_field() {
        let base = super::announce_signing_bytes("a", 1, "n", "x", "e");
        assert_ne!(base, super::announce_signing_bytes("b", 1, "n", "x", "e"));
        assert_ne!(base, super::announce_signing_bytes("a", 2, "n", "x", "e"));
        assert_ne!(base, super::announce_signing_bytes("a", 1, "m", "x", "e"));
        assert_ne!(base, super::announce_signing_bytes("a", 1, "n", "y", "e"));
        assert_ne!(base, super::announce_signing_bytes("a", 1, "n", "x", "f"));
        // 与 Hello 的材料必须不同域（前缀不同），否则一个协议的签名能拿到另一个用
        assert_ne!(
            base,
            super::hello_signing_bytes("a", 1, "n", "x", "e"),
            "announce 与 Hello 的签名材料必须域分离"
        );
    }

    /// 表情 token 的**形态**校验：挡畸形与超长，但**不判断表情是否存在**
    /// （目录的唯一来源是前端，后端再存一份就是第二个真相源）。
    #[test]
    fn emoji_token_shape_is_validated_but_not_the_catalogue() {
        assert!(super::is_valid_emoji_token("[赞]"));
        assert!(super::is_valid_emoji_token("[微笑]"));
        // 后端不认识的名字也必须放行 —— 前端加了新表情不该需要同时改后端
        assert!(super::is_valid_emoji_token("[后端不认识的表情]"));
        for bad in ["", "[", "]", "[]", "赞", "[赞", "赞]", "[[赞]]", "[赞][踩]", "[a\nb]"] {
            assert!(!super::is_valid_emoji_token(bad), "{bad:?} 应被拒");
        }
        assert!(!super::is_valid_emoji_token(&format!("[{}]", "很".repeat(20))), "超长应被拒");
    }

    /// 回应载荷的线上往返（发送端序列化 → 接收端反序列化）。
    #[test]
    fn reaction_payload_roundtrips() {
        let p = super::ReactionPayload {
            target: "msg-1".to_string(),
            emoji: "[赞]".to_string(),
            add: true,
        };
        let wire = serde_json::to_string(&p).unwrap();
        let back: super::ReactionPayload = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.target, "msg-1");
        assert_eq!(back.emoji, "[赞]");
        assert!(back.add);
        // 与群消息 payload 同形（{"kind","content"} 里的 content 就是它）
        assert!(wire.contains("\"add\":true"));
    }

    /// Phase 8（ADR-0017）：不透明外部帧的边界校验 —— **畸形/超限只丢该帧，不断链**。
    #[test]
    fn opaque_external_validation_bounds() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let ok = STANDARD.encode(b"bitchat-packet");
        assert_eq!(
            super::validate_opaque_external("pkt-1", 3, &ok).unwrap(),
            b"bitchat-packet"
        );
        assert!(super::validate_opaque_external("pkt-1", 0, &ok).is_err());
        assert!(super::validate_opaque_external("pkt-1", super::MAX_OPAQUE_TTL + 1, &ok).is_err());
        assert!(super::validate_opaque_external("", 3, &ok).is_err());
        assert!(super::validate_opaque_external(&"x".repeat(super::MAX_OPAQUE_ID + 1), 3, &ok).is_err());
        assert!(super::validate_opaque_external("bad id!", 3, &ok).is_err());
        assert!(super::validate_opaque_external("pkt-1", 3, "not base64!!").is_err());
        assert!(super::validate_opaque_external("pkt-1", 3, "").is_err());
        let huge = STANDARD.encode(vec![0u8; super::MAX_OPAQUE_PAYLOAD + 1]);
        assert!(super::validate_opaque_external("pkt-1", 3, &huge).is_err());
    }

    /// 线格式必须能原样往返（Gosslan 不解码载荷，只透传）。
    #[test]
    fn opaque_external_round_trips_through_wire_format() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let payload = STANDARD.encode(vec![0u8, 1, 2, 250, 255]);
        let msg = super::Message::OpaqueExternal {
            id: "pkt-9".to_string(),
            ttl: 5,
            payload: payload.clone(),
        };
        let json = serde_json::to_vec(&msg).unwrap();
        let back: super::Message = serde_json::from_slice(&json).unwrap();
        match back {
            super::Message::OpaqueExternal { id, ttl, payload: p } => {
                assert_eq!(id, "pkt-9");
                assert_eq!(ttl, 5);
                assert_eq!(p, payload);
            }
            other => panic!("往返后类型变了：{other:?}"),
        }
    }

    use super::*;

    fn env() -> GossipEnvelope {
        GossipEnvelope {
            message_id: String::new(),
            sender_id: "dev-a".into(),
            nonce: "nonce-1".into(),
            sender_pubkey: "xk".into(),
            sender_ed25519: "ek".into(),
            sender_sig: "sig".into(),
            ttl: 6,
            kind: GossipKind::Chat,
            group_id: None,
            group_name: None,
            group_creator: None,
            group_members: Vec::new(),
            payload: "ciphertext".into(),
            ts: 123456,
            seq: 1,
            encrypted: true,
            target: None,
        }
    }

    /// 好友申请（定向）信封：加密、签名、验签、解密、target 完整性。
    #[test]
    fn friend_request_envelope_encrypt_sign_decrypt_and_target_integrity() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        use crate::crypto::Identity;
        use crate::gossip_engine::GossipEngine;

        let a = Identity::generate();
        let c = Identity::generate();
        let engine = GossipEngine::new(100, 10, 4, 6);

        // A 构造 FriendRequest（target=C，用 C 的 X25519 公钥加密内容）
        let payload = r#"{"from_nickname":"Alice","from_avatar":null}"#;
        let shared = crate::crypto::shared_secret(&a.x25519_secret, &c.x25519_public_b64())
            .unwrap();
        let sealed = crate::crypto::seal(&shared, payload.as_bytes()).unwrap();
        let payload_b64 = B64.encode(&sealed);
        let mut env = engine.build_envelope(
            &a,
            "dev-a",
            GossipKind::FriendRequest,
            None,
            None,
            &payload_b64,
            123456,
            0,
        );
        env.target = Some("dev-c".into());
        env.sender_sig = a.sign_b64(&env.signing_bytes());

        // 验签通过（target 参与签名）
        assert!(engine.verify_envelope(&env));

        // C 用自己的私钥解开内容
        let shared2 = crate::crypto::shared_secret(&c.x25519_secret, &env.sender_pubkey).unwrap();
        let pt = crate::crypto::open(&shared2, &B64.decode(&env.payload).unwrap()).unwrap();
        assert_eq!(String::from_utf8(pt).unwrap(), payload);

        // 中间节点篡改 target → 验签失败（target 不可篡改）
        let mut tampered = env.clone();
        tampered.target = Some("dev-eve".into());
        assert!(!engine.verify_envelope(&tampered));

        // target 序列化：None 不写键，Some 写入
        let json_none = serde_json::to_string(&GossipEnvelope {
            target: None,
            ..env.clone()
        })
        .unwrap();
        assert!(!json_none.contains("target"), "None 不应写 target 键: {json_none}");
        let json_some = serde_json::to_string(&env).unwrap();
        assert!(json_some.contains("dev-c"), "Some 应写 target: {json_some}");
    }

    /// ChatAck / ChatReadReceipt（定向、明文）信封：签名、验签、target 完整性、明文往返。
    #[test]
    fn chat_ack_and_read_receipt_plaintext_directed_envelope_integrity() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        use crate::crypto::Identity;
        use crate::gossip_engine::GossipEngine;

        let c = Identity::generate();
        let engine = GossipEngine::new(100, 10, 4, 6);

        // ChatAck：接收方 C 回给原始发送方 A，明文 { msg_id }
        let ack_payload = r#"{"msg_id":"deadbeef"}"#;
        let mut ack = engine.build_envelope(
            &c,
            "dev-c",
            GossipKind::ChatAck,
            None,
            None,
            &B64.encode(ack_payload.as_bytes()),
            123456,
            0,
        );
        ack.encrypted = false;
        ack.target = Some("dev-a".into());
        ack.sender_sig = c.sign_b64(&ack.signing_bytes());

        // 验签通过（target 参与签名）
        assert!(engine.verify_envelope(&ack));
        // 明文：直接 base64 解码即可得到原始 JSON，无需解密
        assert_eq!(B64.decode(&ack.payload).unwrap(), ack_payload.as_bytes());
        // 篡改 target → 验签失败
        let mut tampered = ack.clone();
        tampered.target = Some("dev-eve".into());
        assert!(!engine.verify_envelope(&tampered));

        // ChatReadReceipt：定向明文，payload 含 last_read_ts / last_read_msg_id
        let rr_payload = r#"{"last_read_ts":99,"last_read_msg_id":"m-1"}"#;
        let mut rr = engine.build_envelope(
            &c,
            "dev-c",
            GossipKind::ChatReadReceipt,
            None,
            None,
            &B64.encode(rr_payload.as_bytes()),
            123456,
            0,
        );
        rr.encrypted = false;
        rr.target = Some("dev-a".into());
        rr.sender_sig = c.sign_b64(&rr.signing_bytes());
        assert!(engine.verify_envelope(&rr));
        assert_eq!(B64.decode(&rr.payload).unwrap(), rr_payload.as_bytes());
    }

    #[test]
    fn envelope_encrypted_flag_roundtrip() {
        // 显式 false 往返保持 false
        let mut e = env();
        e.encrypted = false;
        e.compute_message_id();
        let json = serde_json::to_string(&Message::Gossip {
            envelope: e.clone(),
        })
        .unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        match back {
            Message::Gossip { envelope } => assert!(!envelope.encrypted),
            _ => panic!("expect gossip"),
        }

        // 未声明加密标志的旧信封直接拒绝，不再兼容旧协议。
        let legacy = r#"{"type":"gossip","envelope":{"message_id":"m","sender_id":"a","sender_pubkey":"x","sender_ed25519":"e","sender_sig":"s","ttl":6,"kind":"chat","group_id":null,"payload":"p","ts":1}}"#;
        assert!(serde_json::from_str::<Message>(legacy).is_err());
    }

    #[test]
    fn gossip_message_id_deterministic_and_sensitive_to_payload() {
        let mut e1 = env();
        e1.compute_message_id();
        let id1 = e1.message_id.clone();
        assert_eq!(id1.len(), 64); // SHA-256 hex

        let mut e2 = e1.clone();
        e2.compute_message_id();
        assert_eq!(id1, e2.message_id); // 同内容同 id

        e2.payload = "tampered".into();
        e2.compute_message_id();
        assert_ne!(id1, e2.message_id); // 篡改 payload → id 变化

        // 时间戳不参与消息身份：改变 ts 不应改变 message_id。
        let mut e3 = e1.clone();
        e3.ts = 999_999;
        e3.compute_message_id();
        assert_eq!(id1, e3.message_id);

        // nonce 参与消息身份：改变 nonce 必须改变 message_id。
        let mut e4 = e1.clone();
        e4.nonce = "nonce-2".into();
        e4.compute_message_id();
        assert_ne!(id1, e4.message_id);
    }

    #[test]
    fn message_json_roundtrip() {
        let mut e = env();
        e.compute_message_id();
        let msg = Message::Gossip {
            envelope: e.clone(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        match back {
            Message::Gossip { envelope } => {
                assert_eq!(envelope.message_id, e.message_id);
                assert_eq!(envelope.sender_id, "dev-a");
            }
            _ => panic!("应还原为 Gossip 消息"),
        }
    }

    #[test]
    fn msg_kind_mapping() {
        assert_eq!(MsgKind::from_str("code"), MsgKind::Code);
        assert_eq!(MsgKind::from_str("unknown"), MsgKind::Text);
        assert_eq!(MsgKind::Code.as_str(), "code");
    }

    /// 诊断用的类型名必须与**线格式**一致（真机排查只认日志里这个词）。
    ///
    /// 为什么这条测试值得存在：BLE 握手失败时日志现在会写「对端首帧不是 Hello（收到 xxx）」，
    /// `xxx` 就是 `wire_kind()` 的输出。若哪天有人把它改成手写 match 又漏了变体，
    /// 这里会立刻红 —— 而不是等到真机上看着一个错误的类型名猜半天。
    #[test]
    fn wire_kind_matches_the_serde_tag() {
        let hello = Message::Hello {
            device_id: "dev-a".into(),
            nickname: "A".into(),
            avatar: None,
            device_type: "desktop".into(),
            content_features: super::content_features(),
            tcp_port: 59992,
            x25519_pubkey: "xk".into(),
            ed25519_pubkey: "ek".into(),
            conv_clock: 0,
            nonce: "n1".into(),
            sig: "sig".into(),
        };
        assert_eq!(hello.wire_kind(), "hello");
        // 与真实序列化结果的 `type` 字段逐字一致（不是"看起来差不多"）
        let v: serde_json::Value = serde_json::to_value(&hello).unwrap();
        assert_eq!(v["type"], serde_json::json!("hello"));

        assert_eq!(
            Message::Heartbeat {
                device_id: "dev-a".into()
            }
            .wire_kind(),
            "heartbeat"
        );
    }

    /// **协议事实**（ADR-0017 §2）：`Message` 是 `#[serde(tag = "type")]` 枚举，
    /// 旧端收到未知 `type` 时反序列化**失败** ⇒ `read_frame` 返回 `InvalidData`
    /// ⇒ `reader_loop` 视为坏帧并**断开整条连接**（不是"忽略一个包"）。
    ///
    /// 这条测试把该事实钉住：将来做 BitChat 中继（Phase 8）新增线格式变体时，
    /// **必须**能力门控（只在对方声明支持后才发），否则混版本拓扑会直接断链。
    /// 改这条测试（比如让未知变体被容忍）就等于改变兼容性契约 —— 需要 ADR。
    #[test]
    fn unknown_message_type_is_a_hard_parse_error() {
        // ⚠️ 这里原先用 `opaque_external` 当"未知类型"的例子（当时它还没实现）。
        // Phase 8 落地后它**已经是已知变体**，例子必须换成一个真正不存在的类型，
        // 否则这条断言会因为"帧能解析成功"而失败 —— 顺手也说明：
        // ADR-0017 的决策更新（本版不做旧版兼容）改变的是"要不要容忍未知类型"的**立场**，
        // 没有改变**行为**：未知 type 依旧是硬解析错误，于是混版本拓扑会断链
        // ⇒ 升级说明里必须写"所有设备一起升级"。
        let unknown = br#"{"type":"some_future_kind","id":"x"}"#;
        assert!(
            serde_json::from_slice::<Message>(unknown).is_err(),
            "未知 type 必须是硬错误（混版本会断链，所以升级必须整批进行）"
        );
        // 对照：已知变体必须能解析（否则上面那条断言会因为"全都解析失败"而变成空转）。
        // `Heartbeat` 需要 `device_id`，这里给全字段。
        let known = br#"{"type":"heartbeat","device_id":"dev-a"}"#;
        assert!(
            serde_json::from_slice::<Message>(known).is_ok(),
            "对照用例必须能解析，否则上面的断言是空转（全都失败也算通过）"
        );
    }

    #[test]
    fn hello_signing_bytes_sensitive_to_every_field() {
        let base = hello_signing_bytes("dev-a", 59992, "n1", "xk", "ek");
        // 相同输入必须产出相同字节（签名可复现）
        assert_eq!(base, hello_signing_bytes("dev-a", 59992, "n1", "xk", "ek"));
        // 任一字段变化都必须改变签名材料：否则攻击者可平移字段伪造身份
        assert_ne!(base, hello_signing_bytes("dev-b", 59992, "n1", "xk", "ek"));
        assert_ne!(base, hello_signing_bytes("dev-a", 1, "n1", "xk", "ek"));
        assert_ne!(base, hello_signing_bytes("dev-a", 59992, "n2", "xk", "ek"));
        assert_ne!(base, hello_signing_bytes("dev-a", 59992, "n1", "xk2", "ek"));
        assert_ne!(base, hello_signing_bytes("dev-a", 59992, "n1", "xk", "ek2"));
        // 拼接歧义防护：把不同字段切成另一种组合不应撞车
        assert_ne!(
            hello_signing_bytes("ab", 1, "c", "d", "e"),
            hello_signing_bytes("a", 1, "bc", "d", "e")
        );
    }

    #[test]
    fn hello_carries_nonce_and_sig_roundtrip() {
        let hello = Message::Hello {
            device_id: "dev-a".into(),
            nickname: "A".into(),
            avatar: None,
            device_type: "desktop".into(),
            content_features: super::content_features(),
            tcp_port: 59992,
            x25519_pubkey: "xk".into(),
            ed25519_pubkey: "ek".into(),
            conv_clock: 7,
            nonce: "n1".into(),
            sig: "sig".into(),
        };
        let json = serde_json::to_string(&hello).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::Hello { nonce, sig, .. } => {
                assert_eq!(nonce, "n1");
                assert_eq!(sig, "sig");
            }
            _ => panic!("expect hello"),
        }
        // 不带 nonce/sig 的旧 Hello 仍可解析（serde default），但会在验证层被拒
        let legacy = r#"{"type":"hello","device_id":"a","nickname":"A","avatar":null,"tcp_port":1,"x25519_pubkey":"x","ed25519_pubkey":"e","conv_clock":0}"#;
        match serde_json::from_str::<Message>(legacy).unwrap() {
            Message::Hello { nonce, sig, .. } => {
                assert!(nonce.is_empty() && sig.is_empty());
            }
            _ => panic!("expect hello"),
        }
    }

    /// device_type：序列化往返保持，旧 Hello 缺省为空串（旧端兼容，不参与签名）。
    #[test]
    fn hello_device_type_roundtrip_and_legacy_default() {
        let hello = Message::Hello {
            device_id: "a".into(),
            nickname: "A".into(),
            avatar: None,
            device_type: "mobile".into(),
            content_features: super::content_features(),
            tcp_port: 1,
            x25519_pubkey: "x".into(),
            ed25519_pubkey: "e".into(),
            conv_clock: 0,
            nonce: "n".into(),
            sig: "s".into(),
        };
        let json = serde_json::to_string(&hello).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::Hello { device_type, .. } => assert_eq!(device_type, "mobile"),
            _ => panic!("expect hello"),
        }
        // 旧 Hello（无 device_type 字段）→ 缺省空串
        let legacy = r#"{"type":"hello","device_id":"a","nickname":"A","avatar":null,"tcp_port":1,"x25519_pubkey":"x","ed25519_pubkey":"e","conv_clock":0}"#;
        match serde_json::from_str::<Message>(legacy).unwrap() {
            Message::Hello { device_type, .. } => assert!(device_type.is_empty()),
            _ => panic!("expect hello"),
        }
    }

    #[test]
    fn group_lifecycle_messages_roundtrip() {
        let changed = Message::GroupCreatorChanged {
            group_id: "g1".into(),
            from: "old".into(),
            to: "new".into(),
        };
        let json = serde_json::to_string(&changed).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::GroupCreatorChanged { group_id, from, to } => {
                assert_eq!((group_id.as_str(), from.as_str(), to.as_str()), ("g1", "old", "new"));
            }
            _ => panic!("expect group_creator_changed"),
        }

        let left = Message::GroupMemberLeft {
            group_id: "g1".into(),
            from: "dev-a".into(),
        };
        let json = serde_json::to_string(&left).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::GroupMemberLeft { group_id, from } => {
                assert_eq!((group_id.as_str(), from.as_str()), ("g1", "dev-a"));
            }
            _ => panic!("expect group_member_left"),
        }
    }

    #[test]
    fn group_ack_and_file_complete_ack_roundtrip() {
        let group_ack = Message::GroupAck {
            group_id: "g1".into(),
            msg_id: "m1".into(),
            from: "dev-a".into(),
        };
        let json = serde_json::to_string(&group_ack).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::GroupAck {
                group_id,
                msg_id,
                from,
            } => {
                assert_eq!(group_id, "g1");
                assert_eq!(msg_id, "m1");
                assert_eq!(from, "dev-a");
            }
            _ => panic!("expect group_ack"),
        }

        let file_ack = Message::FileCompleteAck {
            transfer_id: "t1".into(),
            success: true,
        };
        let json = serde_json::to_string(&file_ack).unwrap();
        match serde_json::from_str::<Message>(&json).unwrap() {
            Message::FileCompleteAck {
                transfer_id,
                success,
            } => {
                assert_eq!(transfer_id, "t1");
                assert!(success);
            }
            _ => panic!("expect file_complete_ack"),
        }
    }
}
