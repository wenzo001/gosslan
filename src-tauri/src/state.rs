//! 应用全局状态与前端交互类型。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use crate::db_hold::DbLock;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch, Notify};

use crate::crypto::Identity;
use crate::db;
use crate::device::{collect_device_attrs, generate_device_id};
use crate::file_relay::RelayManager;
use crate::gossip_engine::GossipEngine;
use crate::logging::Logger;
use crate::mesh::manager::PeerManager;
use crate::mesh::path::PathKind;
use crate::mesh::router::MeshRouter;
use crate::protocol::{Message, TCP_PORT};

/// 系统语言是否为中文 —— **仅**「前端还没把解析结果推过来」时的兜底。
///
/// 后端不引入系统 locale 库，用 POSIX 环境变量 `LANG` / `LC_ALL` / `LC_MESSAGES`
/// 兜底：macOS/Linux 的 `LANG` 通常是 `zh_CN.UTF-8` / `en_US.UTF-8`，能正确判断。
///
/// **⚠️ Windows 上这里恒为「否」**（Windows 没有 `LANG` 这类变量；macOS 从 Finder 启动的
/// GUI 进程通常也没有）。所以它只能兜住"进程刚起来、前端还没推语言"的那一小段 ——
/// 正常路径以 [`AppState::is_zh`] 的优先级为准（前端推来的解析结果优先）。
fn system_lang_is_zh() -> bool {
    ["LANG", "LC_ALL", "LC_MESSAGES"].iter().any(|k| {
        std::env::var(k)
            .map(|v| v.to_lowercase().contains("zh"))
            .unwrap_or(false)
    })
}

/// 「跟随系统」时到底是不是中文 —— 纯函数，便于单测。
///
/// 优先级：**显式偏好 > 前端推来的解析结果 > 环境变量兜底**。
///
/// 为什么中间那一层必不可少（用户 2026-09-16 实测「加群的提示怎么是英文？」）：
/// 「跟随系统」的解析规则（`navigator.language`）**只在前端有一份**，而后端的兜底在
/// Windows 上恒为「否」—— 于是中文用户在**默认设置**下，后端生成的所有文案
/// （群成员变更 / 文件下载 / 托盘提示 / 窗口标题）全变英文，而界面本身是中文。
/// 前端启动时与每次切换语言都会把结果推过来（`set_ui_language` 命令），这里只负责取舍。
fn resolve_is_zh(preference: Option<&str>, ui_hint: Option<bool>, system: bool) -> bool {
    match preference {
        Some("zh-CN") => true,
        Some("en-US") => false,
        // 其它值（含 "system" 与历史脏值）一律按「跟随系统」处理
        _ => ui_hint.unwrap_or(system),
    }
}

/// 前端推来的「界面实际语言」三态（0 = 还没推过）。
const UI_LANG_UNKNOWN: u8 = 0;
const UI_LANG_ZH: u8 = 1;
const UI_LANG_EN: u8 = 2;

/// 热路径设置 `settings.language` 的内存缓存（审计 2.1i）。
/// is_zh() 在每段后端文案（托盘/日志/中继/群成员变更）上调用，逐次抢全局 db 锁
/// 会在消息洪峰 + 托盘重建时加剧争用。与 ui_lang 同型：未加载时读库一次回填，
/// 写入点（save_settings / reset_settings）同步更新。
const LANG_PREF_UNSET: u8 = 0;
const LANG_PREF_SYSTEM: u8 = 1;
const LANG_PREF_ZH: u8 = 2;
const LANG_PREF_EN: u8 = 3;
/// 键不存在 / 历史脏值：resolve_is_zh 对它们本就与 None 同路（跟随系统）。
const LANG_PREF_MISSING: u8 = 4;

/// 热路径设置 `notify_enabled` 的内存缓存（同上；每条通知判一次总开关）。
const NOTIFY_PREF_UNSET: u8 = 0;
const NOTIFY_PREF_ON: u8 = 1;
const NOTIFY_PREF_OFF: u8 = 2;

fn lang_pref_str(code: u8) -> Option<&'static str> {
    match code {
        LANG_PREF_SYSTEM => Some("system"),
        LANG_PREF_ZH => Some("zh-CN"),
        LANG_PREF_EN => Some("en-US"),
        _ => None,
    }
}

/// **运行状态的唯一快照**（用户要求的第 ② 项）。
///
/// 为什么必须合并：以前"局域网到底开着没有"在前端有**两份**表示 ——
/// `channels[lan].enabled`（来自 `get_channel_status`）与 `online`（来自 `get_network_status`），
/// 由两个命令 + 两个事件各自维护 ⇒ 必然出现"外面开了、里面还是关的"（用户实测过）。
/// 现在只有**一条路径**：`get_runtime_snapshot` 命令与 `runtime-changed` 事件（**带载荷**），
/// 前端只认这一份。
///
/// 注意 `peers`：完整节点列表仍走 `peers-updated`（它最多 3/s、只在脏时推，见 `emit_peers`），
/// 放进快照会让每次通道开关都搬一遍全表；这里只带**节点数**（空态文案要用）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    /// 各通道状态（lan / bluetooth）：enabled / available / running / peers
    pub channels: Vec<crate::transport::ChannelStatus>,
    /// 局域网运行时是否在跑
    pub online: bool,
    /// 局域网绑定的本机地址（未运行时为 None）
    pub bound_ip: Option<String>,
    /// 蓝牙里"通道状态装不下"的那部分事实
    pub ble: BleRuntimeFacts,
    /// 本次启动是否因"上次在蓝牙模块崩溃"暂停了自动开启。
    /// `Some(原因)` = 已暂停（自动路径不得拉起）；`None` = 正常。
    pub ble_autostart_held: Option<String>,
    /// 当前在线节点数（不是完整列表）
    pub peer_count: usize,
    /// **我自己的在线状态**（用户 2026-09-12 定的规则）：
    /// 只要**任一通道在跑**（局域网 或 蓝牙）就算在线；**两个都关了才是离线**。
    ///
    /// 为什么单独给一个字段、而不是继续用 `online`（= 局域网在跑）：
    /// 手机端蓝牙是自动开启的（用户规则「有蓝牙就默认开」），此时即使没连 Wi-Fi，
    /// 用户也应该显示"在线"——用 `online` 会在这种场景下把用户标成离线。
    /// `online` 仍然保留（它是"局域网在跑"，界面里"局域网：N 个节点"那类 LAN 专属文案要用）。
    pub present: bool,
    /// 已配置的「跨网段 / VPN」端点数（**不是发现通道**，配置在设置页；这里只给"有没有"，
    /// 不给地址）。供「添加好友」页如实告知"还有哪些通道在线"。
    pub routed_endpoints: usize,
    /// 公网中转状态（同上：只给可公开的事实，**不含口令、不含服务器地址**）。
    pub relay: RelayRuntimeStatus,
}

/// 公网中转的运行状态（`ChannelStatus` 那套发现通道装不下它，且**绝不能带口令/地址**）。
///
/// 为什么单独一个结构、且只放两个 bool：快照既作为命令返回值、又作为 `runtime-changed`
/// 事件载荷发给所有窗口，还会被诊断读到 —— 口令与服务器地址属于"设置页才该出现"的敏感值
/// （见守卫 `relay_token_never_reaches_logs_or_diagnostics`），这里只放"开没开 / 通没通"。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayRuntimeStatus {
    /// 用户是否启用了公网中转（持久化偏好，不看是否真的连通）
    pub enabled: bool,
    /// 当前是否至少有一条中继电路（`path_kind == Relay` 的活跃链路）
    pub connected: bool,
}

/// 蓝牙运行时事实（`ChannelStatus` 表达不了的部分）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleRuntimeFacts {
    /// 本次构建是否编译了 `bluetooth` feature（没编译时界面该说"此版本不含蓝牙"，
    /// 而不是含糊的"已关闭"）
    pub feature_compiled: bool,
}

/// 「设置已变更」事件名：设置窗口与主窗口靠它同步（见 `notify_settings_changed`）。
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";
/// 「数据被清空」事件名（清除聊天数据 / 清缓存后的破坏性操作）。
///
/// 用户实测（Mac 4.1.10）：在设置里清了缓存、目录和聊天记录，**主界面毫无反应** ——
/// 因为"清除"只发生在设置窗口自己的 store 里（`ResetSection` 调的是那个窗口的
/// `chat.clearAllData()` + `refreshFriends()`），主窗口是**另一个 WebView**，
/// 它手里的会话列表/消息一条都没变。破坏性操作必须广播，否则用户会以为没清掉。
pub const EVENT_DATA_CLEARED: &str = "data-cleared";
/// 运行状态（通道/在线/绑定 IP）发生变化 —— 让**所有**窗口与页面立刻刷新同一份状态。
/// 用户实测「外面把局域网打开、里面还是关的」就是缺这条推送：两处 UI 各自持一份快照，
/// 谁都不知道对方改了。现在任何一次通道开关都会广播，前端统一重拉（唯一真相源在后端）。
pub const EVENT_RUNTIME_CHANGED: &str = "runtime-changed";

/// 「设置已变更」的载荷：**带补丁、且不回发给发起窗口**。
///
/// 旧实现是 `emit(EVENT_SETTINGS_CHANGED, ())` —— 无载荷、广播给所有人，于是每个窗口
/// （包括刚写完的那个）都要 `get_settings + get_device_info + get_share_dir` 全量重拉一遍。
/// 三个后果，用户都实测到了：
/// 1. **白拉**：改一次主题，两个窗口都重拉三份数据；
/// 2. **回灌**：发起窗口读到的是**写入前**的旧快照（去抖写入期间尤其明显）——
///    这正是"点了主题又跳回去"的根因，为此额外养了 `settingsDirty`/grace 一整套守卫；
/// 3. **事件乒乓**：重拉会走到 `pushUiLanguage()`，它又调 `set_ui_language()`，
///    后者再发一次 `settings-changed` ⇒ 两个窗口互相触发，形成高频 IPC 环。
///
/// 现在：`changed` 说明"哪些键变了"、`settings` 只带**变了的那些键的值**（接收方零 IPC 应用）、
/// `origin` 说明"谁改的"，而**发起窗口根本收不到**这个事件 ⇒ 上面三条一起消失。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    /// 变了的键（与 `Settings` 的 camelCase 序列化名一致）。
    /// 特殊值 `"*"` 表示"全量都变了"（恢复默认）⇒ 接收方做一次完整重拉。
    pub changed: Vec<String>,
    /// 发起窗口的标签（诊断用；发起窗口本身不会收到本事件）。
    pub origin: Option<String>,
    /// 只含 `changed` 里那些键的一小块快照，直接可被前端 `applySettingsSnapshot` 应用。
    pub settings: serde_json::Value,
}

/// 取出事件目标（监听方）的窗口标签。
///
/// 前端每个窗口的 `listen()` 在 Tauri 里注册为 `EventTarget::AnyLabel { label }`
/// （见 tauri 的 `filter_target`），其余变体是 Rust 侧监听时用的 —— 四种都取标签，
/// 才能保证"发起窗口收不到自己的事件"这件事对两种监听方式都成立。
fn event_target_label(target: &tauri::EventTarget) -> Option<&str> {
    match target {
        tauri::EventTarget::AnyLabel { label }
        | tauri::EventTarget::Window { label }
        | tauri::EventTarget::Webview { label }
        | tauri::EventTarget::WebviewWindow { label } => Some(label.as_str()),
        _ => None,
    }
}

/// 对端当前"**实际会走**"的链路类型（与 `pick_link` 的优先级一致：LAN > Routed > Relay > Bluetooth）。
///
/// 为什么要它：界面上的「蓝牙直连」以前是**反推**出来的（`p.ip || 蓝牙直连`），
/// 于是同一 Tailscale 网段（`Routed`）的设备也会被标成"蓝牙直连"（用户 2026-09-12 实测）。
/// 链路类型只有后端知道（`Link::path_kind` 由**来路**决定，不能从 IP 段反推），所以在这里判。
///
/// ⚠️ 这是一份**手写优先级数组**，不是穷尽 `match` —— 往 `PathKind` 加新变体时编译器
/// **不会**提醒这里，必须手动补（否则新变体永远选不上、静默退化成更低优先级）。
pub fn best_link_kind(kinds: &[crate::mesh::PathKind]) -> Option<crate::mesh::PathKind> {
    use crate::mesh::PathKind::*;
    [Lan, Routed, Relay, Bluetooth]
        .into_iter()
        .find(|&want| kinds.contains(&want))
}

/// 一条链路是否算「公网中继电路」。**唯一判据**：`path_kind == Relay`
/// （用枚举判，**不按服务器地址** —— 地址属于设置页，且换服务器不该让统计口径变）。
///
/// 为什么单独一个函数：这个判据有两处消费者 —— `get_runtime_snapshot` 的
/// `relay.connected`（"有没有中继电路"）与 `get_topology` 的 `relay_count`（"几条"）。
/// 各写一遍 `== Relay` 的话，将来加一种中转形态就会只改到一处。
pub fn link_is_relay_circuit(link: &Link) -> bool {
    link.path_kind == crate::mesh::PathKind::Relay
}

/// 当前有几条公网中继电路（**同步**版，给 `get_topology` 这类同步命令用）。
///
/// `links` 是 `tokio::Mutex`，同步上下文里不能 `await` ⇒ 调用方用 `try_lock`，
/// 抢不到就报 0。这个数字只用于顶栏展示，为它阻塞一条工作线程、或让它失败，
/// 都不值得（同「窗口路径上的装饰性读必须 try_lock + 安全降级」那条规矩）。
pub fn relay_circuit_count(links: &HashMap<String, Vec<Link>>) -> usize {
    links
        .values()
        .flatten()
        .filter(|l| link_is_relay_circuit(l))
        .count()
}

/// 局域网在线节点（Peer Table 条目）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Peer {
    pub device_id: String,
    pub nickname: String,
    pub avatar: Option<String>,
    /// 设备类型（"desktop" / "mobile"，空串 = 未知/旧端）。来自 Hello/UserInfo/Presence。
    #[serde(default)]
    pub device_type: String,
    pub ip: String,
    pub tcp_port: u16,
    pub last_seen: i64,
    /// 最近一次心跳往返时延（毫秒）
    pub rtt_ms: Option<u64>,
    /// X25519 公钥（base64，ECDH 用）
    pub x25519_pubkey: Option<String>,
    /// Ed25519 公钥（base64，验签用）
    pub ed25519_pubkey: Option<String>,
    /// 这对公钥是否**经过签名验证**（Hello 验签通过，或已验签的 Gossip 信封携带）。
    ///
    /// `false` 表示它只来自**未签名**的 UDP announce 广播 —— 那是一条任何人都能伪造的
    /// 信道（`UdpPacket` 里 device_id 与公钥都是明文，没有签名字段）。
    /// 因此未验证的公钥**只能用于发现与拨号**，绝不允许：
    ///   · 作为 `verify_hello` 的身份绑定（否则攻击者抢先广播即可让真实好友的 Hello 被拒）；
    ///   · 写入持久化的 `friends` 表（否则一次广播就能永久改掉好友的真实公钥，
    ///     我发给该好友的消息会改用攻击者公钥加密，E2EE 被击穿且重启不恢复）。
    #[serde(default)]
    pub keys_verified: bool,
    /// 首次发现该节点的时间戳（announce / Presence 首次学到）。用于「小 ID 兜底拨号」
    /// 判断「对端在线却迟迟连不上」（单向可达）——语义是**发现时间**，不是建链时间。
    #[serde(default)]
    pub first_seen: Option<i64>,
    /// 当前与它的**实际链路类型**：`"lan"` / `"routed"` / `"bluetooth"`（无链路则 None）。
    ///
    /// 由命令层（`get_peers` / `search_nearby_peers`）在读取时从 `links` 填上 —— 事件推送的
    /// peer 表不带它（那里是同步上下文，拿不到异步的 links 锁），界面以"字段缺失"为准不猜。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// 对端在 Hello 里声明的版本（`device_id -> 声明`）。
///
/// 只记录**声明值**，不做任何推断：老端不发这两个字段 ⇒ 两项都是 `None`，
/// 面板上如实显示"未声明"（而不是替它猜一个版本）。
///
/// 为什么单独一张表而不是挂到 `Peer` 上：`Peer` 会被 UDP announce 反复重建，
/// 而 announce 不带版本 —— 挂上去就会在每次广播后丢掉真值。
/// 这张表只在**验签通过的 Hello** 里写入，回收点与 `peer_content_features` 同一个。
#[derive(Clone, Debug, Default, Serialize)]
pub struct PeerVersion {
    /// 对端线格式版本（`None` = 老端未声明 ⇒ 按最低版本处理）
    pub protocol_version: Option<u32>,
    /// 对端应用版本串，**只给人看**（不参与兼容判断）
    pub app_version: Option<String>,
}

/// 一条已建立的 TCP 连接。
///
/// `endpoint` 让连接可以按**端点**去重（同一 peer 的 LAN 与 Tailscale 是两条不同连接），
/// 也是 6b「同一 Peer 多条 Connection」的判据。
#[derive(Clone)]
pub struct Link {
    /// 该连接对端的端点（transport 无关：TCP 地址或 BLE 标识）。
    ///
    /// 为什么不是 `SocketAddr`：BLE 端点没有 IP。见 `mesh::Endpoint` 与 ADR-0015。
    pub endpoint: crate::mesh::Endpoint,
    /// 这条连接**走的是哪条路径**（LAN / Routed / Bluetooth）。
    ///
    /// 为什么必须显式携带、而不是从 `endpoint` 的 IP 段反推（`path_kind_for`）：
    /// 用户把**私有网段地址**（10.x / 192.168.x / 172.16.x）填进「路由端点」时，
    /// 按 IP 反推会判成 LAN ⇒ ① `has_lan_path` 误判为真 ⇒ `ensure_link` 不再拨真正的
    /// LAN 路径（把 D5 的修复绕过去了）；② 选路时按最高优先级当成 LAN。
    /// 而 BLE 端点根本没有 IP，更无解。⇒ 路径类型必须由**来路**决定。
    pub path_kind: PathKind,
    /// 三级发送通道：High（控制帧，必须立即）、Normal（聊天/FileOffer）、Low（bulk 文件分片/大头像）。
    ///
    /// 替代旧的 bulk + priority 两级。BLE writer_loop 在 Low bulk 写入过程中会周期性
    /// yield 检查 High/Normal，避免 4KB FileChunk（273 片 MTU × 15ms = 4s）期间
    /// 控制帧 / 聊天消息排队等待。
    pub high: mpsc::Sender<Message>,
    pub normal: mpsc::Sender<Message>,
    pub low: mpsc::Sender<Message>,
    /// **本连接**的取消信号（M3#6 死链路拆除用）。
    ///
    /// 为什么需要它：全局 `shutdown` 只能整体停网，无法单独断开一条僵尸连接。
    /// 半开 TCP 上读循环会**永久**阻塞在 `read_frame`（既无数据也无错误），
    /// 于是链路一直留在 `links` 里 ⇒ `ensure_link` 认为 LAN 已连通、不再重拨，
    /// `try_send` 又只把消息投进 mpsc 就返回 Ok ⇒ **消息静默投进死路**。
    /// 有了它，健康 watchdog 可以在读活性长期过期时精确拆掉这一条连接，
    /// 让发现层重新建链。读写循环都会 select 这个信号。
    pub cancel: watch::Sender<bool>,
}

/// 待处理的好友申请
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PendingRequest {
    pub from: String,
    pub from_nickname: String,
    pub from_avatar: Option<String>,
    pub ts: i64,
}

/// 会话的「当前链路」快照：最近一条消息走的链路 + 中间节点数。
///
/// - `path`：`"lan"` / `"routed"` / `"bluetooth"`。直连时是入站连接的真实路径；
///   桥接时是「最后一段」的路径（发送方第一段链路需信封携带，Phase 后续补齐）。
/// - `hop`：中间节点数（0 = 直连）。由 Gossip 的 ttl 反推（初始 ttl - 收到 ttl）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct LinkState {
    pub path: String,
    pub hop: u8,
}

impl Default for LinkState {
    fn default() -> Self {
        LinkState {
            path: "lan".to_string(),
            hop: 0,
        }
    }
}

/// 单条消息记录（与前端一致）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MessageRecord {
    pub id: i64,
    pub msg_id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub receiver_id: String,
    pub kind: String,
    pub content: String,
    pub ts: i64,
    /// 每会话逻辑序号（Lamport 风格），排序与清空边界都以此为准。
    pub seq: i64,
    pub status: String,
    /// @ 的落点（#122 第二段）。与 `mention_ids` **不同待遇**：那一份是"摄入那一刻有人 @ 我"
    /// 的一次性判定，故意不落库；这一份是"正文里哪一段算谁"，是**这条消息自己的历史事实**，
    /// 不落库就等于"重启之后同一句话换了意思"（同名两个人重新互相点亮）。
    /// 三态照旧：`None` = 不知道（老行 / 老对端 / 库里那一列写坏了）⇒ 呈现层按昵称兜底。
    #[serde(default)]
    pub mention_targets: Option<Vec<crate::protocol::MentionTarget>>,
    /// **持久本地身份**（DB v13→v14）。列表（VirtualList）用它做 Vue key：
    /// 乐观气泡在服务端 `msg_id` 到达之前就有一个稳定值，替换真实记录时 key 不变。
    /// 老行由迁移回填 `msg_id`；新行由插入 SQL 的 `COALESCE(?local_id, msg_id)` 保证非空。
    #[serde(default)]
    pub local_id: Option<String>,
}

/// `message-received` 实际投递出去的形状 = 消息记录 + **只随本次投递、不落库**的 @ 名单。
///
/// 为什么不把 `mention_ids` 直接做进 `MessageRecord`：那个结构是"库里的一行"，
/// 全仓 30 多处字面量构造它，而这一份信息**故意不落库**（「有人@我」是摄入时的一次性
/// 判定，重启即清空 —— 重启后不该再亮一次红点）。做成字段就等于造出一个
/// "有时有意义、从库里读回来永远没意义"的假字段 —— 那才是下一次误判的来源。
/// ⚠️ 同一条理由**不再适用于** `mention_targets`（就在上面 `MessageRecord` 那段）：
/// 落点是那句话的历史事实，所以它进了库。两份信息的边界因此是"一次性判定 vs 历史事实"，
/// 不是"这两个字段长得像不像"。
#[derive(Serialize, Debug)]
pub struct IncomingMessage<'a> {
    #[serde(flatten)]
    pub record: &'a MessageRecord,
    /// 三态：`None` = 发送方没带这个键（旧版本）；`Some(含空)` = 发送方的权威回答。
    pub mention_ids: Option<&'a [String]>,
    /// @ 的落点（#122：群里同名两个人要分得开）。与 `mention_ids` 同样三态：
    /// `None` = 对端版本不认识这个字段 ⇒ 呈现层退回按昵称判（只能更准，不许变暗）。
    pub mention_targets: Option<&'a [crate::protocol::MentionTarget]>,
}

/// 一条收藏（与前端一致）。
///
/// `content` 是**收藏当时的快照**：图片/文件类收藏的 `content.path` 已被改写成收藏副本路径
/// （而不是原消息里的下载目录路径），所以原消息被清理、会话被删之后这条记录仍然能打开。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Favorite {
    pub id: String,
    pub msg_id: String,
    pub conv_id: String,
    pub sender_id: String,
    pub kind: String, // text | code | image | file
    pub content: String,
    /// 原消息时间（列表里显示"这条内容是什么时候的"）
    pub ts: i64,
    /// 收藏时间（列表排序键）
    pub favorited_at: i64,
    /// 收藏副本的绝对路径（仅 image/file，其余为 None）
    pub media_path: Option<String>,
    pub media_size: i64,
    /// 副本是否还在磁盘上。**由命令层填充**（db 层不碰文件系统）：列表里给前端渲染
    /// 「已清理」占位用，避免用户点开才发现打不开。
    #[serde(default)]
    pub available: bool,
}

/// 会话摘要（会话列表）
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    pub id: String,
    pub kind: String, // single | group
    pub name: String,
    pub avatar: Option<String>,
    pub last_msg: Option<String>,
    pub last_ts: Option<i64>,
    pub unread: i64,
    /// 本机置顶（纯本地偏好，不广播不同步）。列表排序时优先于 last_ts。
    #[serde(default)]
    pub pinned: bool,
}

/// 好友
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Friend {
    pub device_id: String,
    pub nickname: String,
    pub avatar: Option<String>,
    /// 设备类型（"desktop" / "mobile"，空串 = 未知）。从 peers 表现场读取。
    #[serde(default)]
    pub device_type: String,
    /// 对端 Gosslan 的**应用版本**（如 `"4.22.34"`）。`None` = 还没连过，或对方是
    /// 不报版本的老版本 —— 两者都不猜（见 `PeerVersion`）。只用于给人看。
    #[serde(default)]
    pub peer_app_version: Option<String>,
    /// 对端**线格式版本比本机高** ⇒ 界面给一句可解释提示（INV-P24）。
    ///
    /// 判定只有一处：`protocol::peer_protocol_is_newer`。前端**不再自己比数字** ——
    /// 那会把 `PROTOCOL_VERSION` 变成第二份真相源（本项目反复出事的形状）。
    #[serde(default)]
    pub peer_version_newer: bool,
    pub online: bool,
}

/// 群组
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub creator: String,
    pub members: Vec<String>,
}

/// 本机信息
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceInfo {
    pub device_id: String,
    pub nickname: String,
    pub avatar: Option<String>,
    /// 本机设备类型（"desktop" / "mobile"）。
    pub device_type: String,
    pub tcp_port: u16,
    pub online: bool,
    /// 本机 X25519 公钥（base64）
    pub x25519_pubkey: String,
    /// 本机 Ed25519 公钥（base64）
    pub ed25519_pubkey: String,
}

/// 网卡信息
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InterfaceInfo {
    pub name: String,
    pub ip: String,
    /// 是否为真实局域网卡（有广播地址、非 link-local、非 VPN 虚拟地址）。
    /// false 表示疑似 VPN / Clash / tun / tap 等虚拟网卡。
    #[serde(default = "default_true")]
    pub is_lan: bool,
}

fn default_true() -> bool {
    true
}

/// 链路候选（含评分），供开发者诊断面板展示 Discovery 实际看到的候选列表。
///
/// 用户 2026-09-13 要求「网卡-候选 也可以加上蓝牙」：于是 `kind` 把两类候选
/// 统一进一张表 —— `lan`（真实网卡）与 `bluetooth`（BLE 适配器这一条链路）。
/// 蓝牙行没有 IP/广播（蓝牙链路上没有这些概念），所以 `ip` / `broadcast` 为空，
/// 人类可读的状态放进 `detail`。
#[derive(Serialize, Clone, Debug)]
pub struct InterfaceCandidate {
    /// `lan` | `bluetooth`
    pub kind: String,
    pub name: String,
    pub ip: String,
    pub has_broadcast: bool,
    pub broadcast: Option<String>,
    pub is_rfc1918: bool,
    pub is_virtual: bool,
    pub score: i32,
    pub selected: bool,
    /// 一句话状态（蓝牙行用：「运行中 · 前台节奏 · 1 个对端」；网卡行为空）
    pub detail: String,
}

/// 蓝牙候选的失败退避条目（诊断面板展示"为什么这一轮没拨它"）。
#[derive(Serialize, Clone, Debug)]
pub struct BleBackoff {
    /// BLE 外设标识（**不是身份** —— 身份由 Hello 验签建立）
    pub id: String,
    /// 连续失败次数
    pub failures: u32,
    /// 距下次允许尝试还有多少毫秒（≤0 表示已到期）
    pub remaining_ms: i64,
}

/// 蓝牙运行时的可观测事实（诊断面板用）。
///
/// 为什么要单独一组：原来的诊断数据**全是局域网的**，纯蓝牙用户看到的是
/// `mode = offline`（用户 2026-09-13 反馈）。蓝牙是独立通道，必须有自己的状态。
#[derive(Serialize, Clone, Debug, Default)]
pub struct BleDiag {
    /// 本次构建是否编译了蓝牙特性（没编译时其余字段无意义）
    pub feature_compiled: bool,
    /// 用户开关状态（= 后端真实运行状态，见 `channels[bluetooth].enabled`）
    pub enabled: bool,
    /// 适配器是否可用（没有适配器 / 没有权限 = false）
    pub available: bool,
    pub running: bool,
    /// 已建立 BLE 链路的对端数
    pub peers: usize,
    /// 当前扫描节奏来源：`active`（前台/聚焦）| `idle`（后台/失焦）
    pub activity: String,
    pub scan_window_ms: u64,
    pub scan_interval_ms: u64,
    /// 最近一次扫描完成时间（ms since epoch，0=从未）
    pub last_scan_ts: i64,
    /// 最近一次扫描收到的广播总数
    pub last_scan_total: u32,
    /// 其中属于本应用服务的个数
    pub last_scan_matched: u32,
    /// 正在退避中的候选（按剩余时间倒序）
    pub backoff: Vec<BleBackoff>,
    /// 「不要再拨」名单大小（对端是指定拨号方时登记）
    pub no_dial: usize,
}

/// BLE 最近一轮扫描的统计（不直接序列化，由 `BleDiag` 组装给前端）。
#[cfg(feature = "bluetooth")]
#[derive(Clone, Copy, Debug, Default)]
pub struct BleScanStats {
    /// 该轮扫描完成时间（ms since epoch）
    pub last_ts: i64,
    /// 收到多少个广播
    pub total: u32,
    /// 其中多少个带本应用的服务 UUID
    pub matched: u32,
}

/// Discovery 运行时诊断状态（只读，供开发者面板展示）。
///
/// ⚠️ 用户 2026-09-13：「最近事件」已**合并进运行日志**（见 `AppState::push_diag_event`），
/// 不再在这里保留 ring buffer —— 事件该和别的日志在一起被搜索/复制，而不是孤零零一个面板。
#[derive(Serialize, Clone, Debug, Default)]
pub struct DiscoveryDiag {
    /// 当前网络模式：auto / manual / offline（**仅指局域网**；蓝牙状态看 `bluetooth`）
    pub mode: String,
    /// 实际绑定的 IP
    pub bound_ip: String,
    /// 选中的接口名称（如有）
    pub selected_interface: String,
    /// 选中的接口 IP（如有）
    pub selected_ip: String,
    /// TCP 监听地址
    pub tcp_listen: String,
    /// UDP 发现端口
    pub udp_port: u16,
    /// 广播目标地址
    pub broadcast_target: String,
    /// 组播地址
    pub multicast_group: String,
    /// 组播 join 结果
    pub multicast_join_result: String,
    /// set_multicast_if_v4 结果
    pub multicast_if_result: String,
    /// 最近一次广播发送时间（ms since epoch，0=从未）
    pub last_broadcast_send: i64,
    /// 最近一次组播发送时间
    pub last_multicast_send: i64,
    /// 最近一次 announce 接收时间
    pub last_announce_recv: i64,
    /// 候选链路列表（网卡 + 蓝牙，含评分）
    pub candidates: Vec<InterfaceCandidate>,
    /// 蓝牙通道事实（独立于局域网，纯蓝牙用户也看得见自己的状态）
    pub bluetooth: BleDiag,
    /// 本机线格式版本（与 `peer_versions` 同一屏对齐，跨版本排查先看这一行）
    pub protocol_version: u32,
    /// 本机应用版本（只给人看，不参与任何兼容判断）
    pub app_version: String,
    /// 各对端在 Hello 里声明的版本（按 device_id 排序）
    pub peer_versions: Vec<PeerVersionDiag>,
    /// 按**连接**（不是按 peer）列出的收发活性读数（按 device_id + endpoint 排序）。
    ///
    /// 为什么必须按连接：同一对 peer 之间可以同时挂着多条 socket（LAN / Routed / BLE），
    /// 而"对端整段没帧"这一类故障是**逐连接**发生的（2026-10-17 实测：一个 peer 的两条连接里
    /// 只有一条被判死）。把 peer 聚合起来看，坏的那条会被好的那条盖掉。
    pub conn_health: Vec<ConnHealthDiag>,
}

/// 诊断面板的一行「这条连接最后一次把字节读进来 / 写出去是什么时候」。
///
/// ⚠️ 两个时间戳的语义**不可互换**，也不许拿一个冒充另一个（`mesh::ConnectionHealth`）：
/// · `last_write_seen_ms` = 本端 writer **写出成功**的时刻。半开 TCP 上它会一直前进
///   （内核收下字节 ≠ 对端活着），所以它**不参与** `is_healthy`。
/// · `last_read_seen_ms` = 本端**读到并解析出一个完整帧**的时刻 —— 唯一"对端活着"的证据。
///   注意它量的是"成帧"，**不是**"socket 读到字节"：读循环是 `read_frame` 一次拿一整帧，
///   字节级与成帧级之间现有状态没有第三个读数。
/// · `None` = 这条连接建立以来从未发生过那件事（不是 0，0 会被读成"很久以前"）。
#[derive(Serialize, Clone, Debug)]
pub struct ConnHealthDiag {
    pub device_id: String,
    /// 进程内唯一连接 id（路由表/日志用的那份，原样带出以便与日志对齐）。
    pub conn_id: String,
    /// 端点的一行文本（TCP 是 `ip:port`，BLE 是 `ble:<地址>`）。
    pub endpoint: String,
    /// `lan` / `routed` / `relay` / `bluetooth`。
    pub path_kind: String,
    pub last_write_seen_ms: Option<i64>,
    pub last_read_seen_ms: Option<i64>,
    /// 距今多少毫秒（现算，`None` 时也是 `None`）。面板上一眼能看出"还在不在动"。
    pub write_age_ms: Option<i64>,
    pub read_age_ms: Option<i64>,
    /// 与选路/看门狗同判据的健康结论（只认读活性）。
    pub healthy: bool,
    pub consecutive_failures: u32,
}

/// 诊断面板的一行「对端声明了什么版本」。
///
/// 昵称在这里补而不是存进 `peer_versions`：那张表只记 Hello 那一次的声明，
/// 而昵称会随 UserInfo 变 —— 面板要说的是"现在这是谁"。
#[derive(Serialize, Clone, Debug)]
pub struct PeerVersionDiag {
    pub device_id: String,
    pub nickname: String,
    /// `None` = 对端是没报版本的老版本（面板显示"未声明"，不当成版本 0 也不当成版本 1）
    pub protocol_version: Option<u32>,
    pub app_version: Option<String>,
}

/// 网络拓扑摘要（供拓扑状态栏展示）
#[derive(Serialize, Clone, Debug)]
pub struct TopologyInfo {
    pub node_count: usize,
    pub relay_count: usize,
    pub avg_rtt_ms: Option<u64>,
    pub online: bool,
}

/// 文件传输进度事件
#[derive(Serialize, Clone, Debug)]
pub struct FileProgress {
    pub transfer_id: String,
    pub received: u64,
    pub total: u64,
}

/// 文件接收完成事件
#[derive(Serialize, Clone, Debug)]
pub struct FileDoneInfo {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub path: String,
}

/// 链路停滞状态变化（只在**状态翻转**时发一次，不是每 tick 都发）。
///
/// 为什么需要它：`send_on_link` 在对端不收时会一直挂在背压上 —— 既不再发进度也不报错，
/// 界面就冻在同一个百分比最长到 deadline（1h）。用户需要知道"卡在网络上"而不是"软件死了"。
/// `idle_ms` = 距最近一次真正写出分片的毫秒数（以 writer 实发为准，不是投进队列）。
///
/// `reason`：**为什么停**（可空 = 就是普通的链路静默）。加它是为了不把"策略上暂时不发"
/// 说成"网络卡住"——只有蓝牙链路时超过 `BLE_FILE_SIZE_LIMIT` 的文件会保持 pending 等 LAN
/// 回来（2026-09-23 真机 600MB 复核），界面上必须能看出这是"在等更好的链路"而不是故障。
/// 老前端忽略这个字段（serde 跳过 None），新前端有它就显示它、没有就回退既有的「网络停滞」。
#[derive(Serialize, Clone, Debug)]
pub struct FileStalledInfo {
    pub transfer_id: String,
    pub stalled: bool,
    pub idle_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileFailedInfo {
    pub transfer_id: String,
    pub reason: String,
}

/// 代码/文本消息渲染切换后的广播载荷。
#[derive(Serialize, Clone, Debug)]
pub struct RenderChangedInfo {
    pub msg_id: String,
    pub kind: String,
}

/// 文件传输状态
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TransferInfo {
    pub id: String,
    pub peer_id: String,
    pub name: String,
    pub size: u64,
    pub direction: String,
    pub status: String,
    pub path: Option<String>,
    pub progress: f64,
    /// 排队中为什么不动；只对发送侧的 pending 行有意义。`None` = 没有额外阻塞信息。
    /// 取值由 `db::file_transfer::list_transfers` 与 `get_transfers` 的链路判据共同给出。
    pub blocked_reason: Option<String>,
    /// 建行的时刻（毫秒）。面板的排序键本来就是 `created_at DESC`，把它交给读侧，
    /// 统一任务中心才能跨四种任务排"最近的在前"——按数组下标猜时间会被过滤改乱。
    pub created_at: i64,
}

/// 本机这一群的**历史同步进度**（`settings` 里 `ghsync:group:<gid>` 那份 JSON）。
///
/// 负责人 2026-10-16 的需求形状：新进群的人要自动拿到群里的聊天与群任务。这件事可能
/// 跑一半就断网、重启、或那台最全的成员下线 ⇒ 必须有一个**落在盘上**的判断依据
/// （INV-P26：能从盘上证实的状态不许从界面上的读数倒推）。
/// `status` 只有两个值：`pending`（还要继续，含"一趟没跑完"）与 `done`（这一趟收口了）。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct GroupHistorySyncState {
    pub status: String,
    /// 这一趟从谁那儿取的（只为日志与诊断；换源不算状态变化）
    pub source: String,
    /// 已同步进来的条数（本机侧读数，含被水位挡住的那些之外的部分）
    pub synced: i64,
    /// 源机报的总条数（进度分母；`0` = 还不知道）
    pub total: i64,
    pub updated_at: i64,
}

/// 群文件元数据（DB 表 group_files）。一个 transfer_id 对应一个群文件；
/// 成员投递状态在 group_file_recipients 中按 (transfer_id, recipient_id) 独立维护。
pub struct GroupFile {
    pub transfer_id: String,
    pub group_id: String,
    pub sender_id: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// 'pending' | 'sending' | 'completed' | 'failed' | 'cancelled'
    /// （`cancelled` = 用户主动取消这一单，B2；它是**硬终态**：已取消的成员行与群文件行
    /// 都不许被晚到的进度、迟到的 ACK 或"重建接收会话"点亮回 `sending`。）
    pub status: String,
    pub created_at: i64,
    /// 归属场景：`chat` = 普通群文件；`todo` = 待办描述图片（不进时间线）
    pub scope: String,
    /// `scope == "todo"` 时关联的 todo_id
    pub todo_id: String,
}

/// 群文件单个成员的投递状态（DB 表 group_file_recipients）。
// 写入/推进在 network/transport/group_file.rs 与 commands/group_file_dispatch.rs；
// 这里只是 DB 行 → 前端的映射（list_group_file_recipients 的返回元素）。
#[allow(dead_code)]
pub struct GroupFileRecipient {
    pub recipient_id: String,
    /// 'pending' | 'sending' | 'completed' | 'failed' | 'cancelled'（同 `GroupFile::status`：
    /// `cancelled` 是硬终态，判据 `db::group_file_delivery_tests::a_cancelled_recipient_row_is_a_hard_terminal`）
    pub status: String,
    /// 0.0 ~ 1.0，与 file_transfers.progress 同一表示
    pub progress: f64,
    pub updated_at: i64,
}

/// `file_wire_progress` 的值：**分块真的离开链路**的时刻与累计数。
///
/// 两个字段同一个写入点（`transport::mark_file_wire_progress`，TCP 与 BLE 的 writer
/// 都在 `write_frame` 成功之后调它），所以"安静多久"与"路上走了几片"不会各说各话：
/// `at_ms` 供停滞判定与 `FileCompleteAck` 等待使用，`chunks` 供发送进度换算。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FileWireProgress {
    /// 最近一次有分块写出的时刻（ms）。0 = 从未写出过。
    pub at_ms: i64,
    /// 累计已写出的分块数（本次 transfer 计数，收尾时随记录一起清掉）。
    pub chunks: u64,
}

/// 正在接收的文件状态
pub struct FileReceiver {
    pub file: std::fs::File,
    pub name: String,
    pub size: u64,
    pub received: u64,
    /// 直连 TCP 虽然有序，但仍校验序号，避免错误/恶意帧把文件静默拼坏。
    pub next_seq: u32,
    /// 当前这接收器属于**哪一轮**发送尝试（attempt epoch；0 = 未知/老端不带）。
    /// 由 FileOffer 设定（Offer 是权威，见 `file::frame_is_current` 第 3 条），
    /// 分片与完成帧用它过滤"上一轮还堵在链路队列里的残留"。
    pub attempt: u32,
    /// 已丢掉多少片"上一轮 attempt 的残留"。只用于诊断：没有这个计数，
    /// 界面上"进度不动了"就完全没有可解释的痕迹（而它恰恰是 epoch 在起作用）。
    pub stale_dropped: u32,
    pub tmp_path: PathBuf,
    pub final_path: PathBuf,
    pub peer_id: String,
    /// 上次进度上报时间（毫秒），用于节流 IPC 事件
    pub last_report_ms: i64,
    /// 最近一次**被喂进一个合法分片**的时刻（ms）。创建时也算。
    ///
    /// 为什么必须有（P1）：`last_report_ms` 是 IPC 节流用的、且有一处初始化成 0，
    /// 它不是"还在不在收"的证据；而协议里没有 cancel 帧，发送侧 abort 之后
    /// **不会通知接收端** ⇒ 没有这个时钟，被放弃的接收器会永久钉住
    /// 文件句柄与 `.part`（`sweep_stale_parts` 只删不在表里的）。
    pub fed_at_ms: i64,
    /// 本 transfer 的文件会话密钥：FileOffer 中以我方公钥 E2EE 封装，
    /// 解封后仅存于内存；每个分片以此 AEAD 解密，密文绝不落盘。
    pub file_key: [u8; 32],
    /// 发送方声明的原文件 SHA-256（hex），FileDone 时与实际哈希比对
    pub expected_sha256: String,
    /// 明文增量哈希：write_chunk 解密后 update，finish 时 finalize 比对
    pub hasher: sha2::Sha256,
}

/// 中继接收的文件会话状态（仅最终接收方持有；中继节点不解密不校验）。
pub struct RelayFileReceive {
    /// 本 transfer 的文件会话密钥（RelayFileOffer 中以我方公钥封装）
    pub file_key: [u8; 32],
    /// 发送方声明的原文件 SHA-256（hex）
    pub expected_sha256: String,
    /// 收到 RelayFileOffer 的时刻。**必须有**：本表按 transfer_id 索引，
    /// 而对端可以一直发新 offer 却永不发分片 —— 没有时间戳就无法回收，
    /// 内存会随对端行为单调增长（见 `sweep_stale_relay`）。
    ///
    /// 注意：这里**没有**增量哈希。中继分片按到达顺序解密，可能重复（多邻居
    /// 泛洪）、可能乱序（多中继路径时延不同）—— 任何"到达顺序增量喂哈希"的
    /// 方案在去重/排序之前都是错的。完整性校验在重组完成后对按 seq 组装的
    /// 明文一次性计算（2026-09-23 审计 1.8）。
    pub created_at: i64,
    /// 上一次给前端推 `file-progress` 的时刻（**每秒最多一条**）。
    ///
    /// 为什么必须有：中继分片在 BLE 上只有 4 KiB，几百 KB 的文件就是上万片，
    /// 而每条进度都要跨进程 + 过主线程消息循环 —— 逐片推会把"正在收文件"变成
    /// "界面卡顿"。进度存在这张表里而不是另开一份：它与本行同生同灭，
    /// 分两处存迟早有一边忘清（与 stalledTransfers 同一条教训）。
    pub last_progress_at: i64,
    /// 发送方声明的文件总字节（审计 SEC-05：中继也是"入站资源"）。
    ///
    /// 没有它，中继接收完全落在入站配额之外 —— 一条好友链路可以持续发
    /// `RelayFileOffer{ 每次新 id、size 任意 }` 把 `relay_file_keys` 与磁盘一起撑大。
    pub size: u64,
}

/// 共享目录树的应答内容：条目 + 共享方是否因上限截断（审计 PERF-02）。
pub type ShareTreeReply = (Vec<crate::protocol::ShareEntry>, bool);

/// 共享目录树的待应答表（键 = request_id）。
pub type PendingShareTree = Mutex<HashMap<String, tokio::sync::oneshot::Sender<ShareTreeReply>>>;

/// 网络运行时句柄
pub struct NetworkHandle {
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// 用户配置的绑定地址（"0.0.0.0" 表示 auto，否则为手动指定的 IP）。
    pub bound_ip: String,
    /// Discovery 实际绑定的 UDP IP（auto 模式下为 find_lan_interface 选出的 LAN IP）。
    /// 用于诊断面板显示真实 bind 地址。
    pub actual_bound_ip: String,
    pub tcp_port: u16,
    /// 后台任务句柄（discovery 收包 / 广播、transport accept / 心跳）。
    ///
    /// `stop()` 必须等它们真正退出再返回：否则旧进程（或同一进程内旧实例）的
    /// TCP listener 仍挂在端口上，紧接着的 `start()`/新进程 bind 就会撞上
    /// AddrInUse（Windows 上表现为重启后永久掉线）。
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// 全局应用状态。
///
/// 加锁约定：所有 `std::sync::Mutex` 一律用
/// `lock().unwrap_or_else(|e| e.into_inner())` 取锁，**不要写 `.lock().unwrap()`**。
/// 原因：Rust 的互斥量在「持锁线程 panic」后会进入中毒状态，若后续都用 `.unwrap()`，
/// 一次 panic 就会让之后**所有**加锁点级联 panic（整个应用不可用）；
/// `into_inner()` 取回内部数据继续用，把影响限制在最初那次 panic。
/// （`tokio::sync::Mutex` 无中毒概念，正常 `.lock().await` 即可。）
/// 同时进行的拨号上限（见 `AppState::dial_permits`）。
/// 取 16：3 台设备的日常场景远远用不到，而伪造 announce 的洪泛会被它挡住。
pub const MAX_CONCURRENT_DIALS: usize = 16;

/// 同时保持的入站连接上限（见 `AppState::inbound_permits`）。
pub const MAX_INBOUND_CONNECTIONS: usize = 128;

/// 同时进行的群文件投递上限（见 `AppState::group_file_permits`）。
/// 取 8：每个在途成员约 1.2 MB 读缓冲 + AEAD/base64 副本，而每条链路的 Low 队列预算
/// 是 8 MiB（`network/transport/queue_policy.rs`）；200 成员无闸时 = 200 条链路、约
/// 1.6 GB 队列。8 并发既不让内存随群人数线性涨，也不把吞吐压成单线程。
pub const MAX_CONCURRENT_GROUP_FILE_SENDS: usize = 8;

/// 拨号在途标记的 RAII 守卫：Drop 即释放（任何提前 return / panic 都不会漏放）。
pub struct DialGuard {
    state: Arc<AppState>,
    key: String,
}

impl DialGuard {
    /// 尝试登记一个在途拨号；已被其他拨号占用时返回 `None`（调用方应直接返回）。
    pub fn try_acquire(state: &Arc<AppState>, key: String) -> Option<Self> {
        let inserted = state
            .dialing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        if !inserted {
            return None;
        }
        Some(Self {
            state: state.clone(),
            key,
        })
    }
}

impl Drop for DialGuard {
    fn drop(&mut self) {
        self.state
            .dialing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// 群文件轮次号的启动种子：**纳秒级**的 epoch 时间。
///
/// 为什么必须是纳秒而不是 0/毫秒：接收端把"当前轮次"存在内存里，用
/// `attempt < 当前轮次 ⇒ 丢弃` 隔离上一轮的残留帧。发送端重启后如果从 0 重新数，
/// 新轮次会**小于**接收端记住的旧值 ⇒ 新 Offer 被当成残留直接丢掉，重启后永远续不上。
/// 取纳秒是因为它远大于"一个进程里 dispatch 的次数"：后启动的进程必然拿到更大的种子。
pub(crate) fn group_file_round_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
}

/// 群文件投递在途守卫（键 = `(transfer, recipient)`，RAII）。
///
/// 为什么需要它：fan-out 与离线补发（Hello / 心跳 / 拨号 / BLE 建链都会触发）是**两条**
/// 入口。旧形状靠"一进 dispatch 就把行写成 `sending`"去重；但并发闸（`group_file_permits`）
/// 让任务可能在闸后**排队**，排队期间行必须保持 `pending`（否则 10 分钟的 stale-sending
/// 清扫器会把排队当卡死重投）⇒ 去重不能再靠状态行。这道内存闸补回那个不变量：
/// 同一 (transfer, recipient) 同时只许一个任务，排队中的也算一个。
pub struct GroupFileDispatchGuard {
    set: Arc<Mutex<std::collections::HashSet<String>>>,
    key: String,
}

impl GroupFileDispatchGuard {
    /// 已有同键任务 ⇒ `None`（调用方直接返回：不写状态、不重复投递）。
    pub fn try_acquire(
        set: &Arc<Mutex<std::collections::HashSet<String>>>,
        key: String,
    ) -> Option<Self> {
        let inserted = set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.clone());
        inserted.then(|| Self {
            set: set.clone(),
            key,
        })
    }
}

impl Drop for GroupFileDispatchGuard {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// 预览窗口里的一张图 —— 字段名与前端 `PreviewImage` 一一对应（camelCase 上线）。
///
/// ⚠️ 刻意**只带引用**（`msg_id` / `cid`）或自包含的 `data_src`：
/// 主窗口里那些 `blob:` objectURL 跨文档一律取不到字节，传过去就是一片破图。
/// 所以能不能走独立预览窗口，判据就是"每一条都可寻址"（见前端 `deliverableToWindow`）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_src: Option<String>,
}

/// 一次"看图"投递的完整内容（相册 + 起始下标）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGallery {
    pub items: Vec<PreviewItem>,
    pub index: usize,
}

/// 群文件会话密钥条目（内存态）。**不派生 Debug**：密钥不许被 `{:?}` 带进日志。
pub struct GroupFileKey {
    pub key: [u8; 32],
    pub at_ms: i64,
}

impl GroupFileKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key,
            at_ms: crate::db::now_ms(),
        }
    }
}

pub struct AppState {
    pub app: AppHandle,
    pub db: DbLock<Connection>,
    pub device_id: String,
    pub tcp_port: u16,
    /// 前端推来的「界面实际用的是哪种语言」（三态，见 [`Self::is_zh`] 与 `set_ui_language`）。
    ///
    /// 只存内存、**不落库**：它是前端解析结果的缓存，每次启动前端都会重新推一次；
    /// 落库反而会多出一份可能与 `settings.language`（那是**偏好**，不是结果）不一致的状态。
    ui_lang: AtomicU8,
    /// `settings.language` 的内存缓存（热路径，见模块顶部常量注释；审计 2.1i）。
    lang_pref: AtomicU8,
    /// `notify_enabled` 的内存缓存（同上）。
    notify_pref: AtomicU8,
    /// **在途拨号**集合（D6）：正在 connect/握手的拨号键（peer_id 或端点字符串）。
    ///
    /// 为什么需要：`connect_to_peer` 的"已连接？"检查与"登记链路"之间隔着 connect +
    /// 握手（最长 10s），是典型的 check-then-act。两条并发路径（Routed 每端点一个任务、
    /// LAN announce 触发的 ensure_link）会同时看到"还没连上" ⇒ 同一目标被拨两次，
    /// `links[peer]` 出现两条完全相同的端点。有了在途标记，第二个拨号直接返回。
    pub dialing: Mutex<std::collections::HashSet<String>>,
    /// 并发拨号上限信号量（**不是**在途去重，是资源上限）。
    ///
    /// 为什么还要它：在途集合只挡"同一目标"，挡不住"一万个不同目标"——伪造 announce
    /// 可以让发现层对着大量黑洞地址同时发起 connect，每个最长 10s。给一个上限后，
    /// 超出部分本轮直接放弃（下一个 announce 周期还会再来），不会堆积任务与 socket。
    pub dial_permits: Arc<tokio::sync::Semaphore>,
    /// 入站连接上限（`handle_incoming` 任务持一个许可直到连接结束）。
    ///
    /// 与 `dial_permits` 对称：一个管"我拨出去"，一个管"别人拨进来"。
    /// 128 对 3 台设备绰绰有余，而伪造 announce/洪水连接会被它挡在 accept 之后立刻丢弃。
    pub inbound_permits: Arc<tokio::sync::Semaphore>,
    /// 群文件投递的**全局并发闸**（传输调度层，不是命令层）。
    ///
    /// 群发对每个可达成员各 `spawn` 一个任务；闸放在这里才能同时约束"任务数"和
    /// "每条链路队列里的字节"。`acquire().await` 是**无损等待**：排队成员保持
    /// `pending`，不放宽、不丢文件（拍板：可靠性/完整性不得为省资源静默降级）。
    pub group_file_permits: Arc<tokio::sync::Semaphore>,
    /// 蓝牙运行时句柄（`feature = "bluetooth"` 才有；见 `network/ble.rs`）。
    ///
    /// 与 LAN 的 `network` 字段同思路：句柄在 AppState 里，`start/stop` 由命令层驱动。
    /// 默认 `None`，且只有用户在设置里打开「蓝牙」才会启动 —— 局域网不受影响。
    #[cfg(feature = "bluetooth")]
    pub ble: Mutex<Option<crate::network::ble::BleHandle>>,
    /// **不要再主动拨的 BLE 外设标识**（central 侧）。
    ///
    /// 为什么需要（用户 2026-09-12 实测的"点加好友：发送失败，连接已关闭"）：
    /// 两端都同时跑 central + peripheral，于是**互相拨号**，形成两条镜像 BLE 链路：
    ///   · 手机（大 id）拨 Mac（小 id）→ 成功建链 A；
    ///   · Mac（小 id）也在扫手机 → 每轮扫描都去拨一次 → 被手机按"镜像链路"规则拒掉
    ///     （不回 Hello）——**拒是拒了，但每次连接本身都会打断手机那条 GATT server 连接**，
    ///     于是链路 A 45s 收不到一帧、被看门狗拆掉、再重来。
    /// 规则与 TCP 的 `should_dial` 一致：**大 id 是这台链路上的指定拨号方，小 id 只接受**。
    /// 小 id 在握手验签后就知道"对端比我大 ⇒ 该它拨我"，把该外设标识记进这里，
    /// 之后扫描直接跳过它 —— 不再去打扰那条好的链路。
    ///
    /// 清空时机：蓝牙通道停止时（下次开启重新学一遍）。
    #[cfg(feature = "bluetooth")]
    pub ble_no_dial: Mutex<std::collections::HashSet<String>>,
    /// **确认在广播的 BLE 外设标识**（central 侧，每次开启蓝牙时清空后重新学）。
    ///
    /// 为什么需要（ADR-0015 §7-f，Windows Phase 1）：BLE 上"谁拨号"原本是
    /// `should_dial_ble(my_id, peer_id) = my_id > peer_id`，而这条规则**只在两端都能广播
    /// 时才成立**（它的前提是"我不拨，对方也会拨我"）。Windows 这一轮只做 central
    /// （不能广播、不能被连），照搬该规则就会在"Windows 的 id 更小"时**两侧都不拨**，
    /// 链路永远建不起来。
    ///
    /// 于是判据补一条：**对端不广播 ⇒ 必须由我们拨**。这个集合就是"对端确实在广播"的
    /// 事实来源 —— 只有真的在扫描结果里见过它的外围广播才登记，不是靠平台常量猜。
    ///
    /// 只记内存、不落库：广播是每次开机重新发生的事，持久化只会带来陈旧数据。
    #[cfg(feature = "bluetooth")]
    pub ble_peer_advertises: Mutex<std::collections::HashSet<String>>,
    /// **立刻扫一轮 BLE** 的触发通道（与 LAN 的 `probe` 同一个范式）。
    ///
    /// 为什么需要（用户 2026-09-13 要求「扫描快一点」）：BLE 的扫描循环是
    /// 「扫 3s → 等 10s」的周期任务，用户点开「添加好友」时**最多要等一整个周期**
    /// 才可能看到对端。LAN 那条路早就有按需探测（`search_nearby_peers` + `who_has`），
    /// BLE 一直缺 —— 用户侧的体感就是"蓝牙搜不到/很慢"。
    ///
    /// 语义：发一个新值 ⇒ 扫描循环立刻结束当前的等待、马上开扫一轮（不重置退避，见
    /// `scan_loop` 里对 `user_triggered` 的处理）。
    #[cfg(feature = "bluetooth")]
    pub ble_scan_now: Mutex<Option<tokio::sync::watch::Sender<u64>>>,
    /// BLE 候选的**失败退避**：外设标识 → (连续失败次数, 下次允许尝试的时间)。
    ///
    /// 为什么需要：BLE 上"连过去被拒"是常态，而**每次连接尝试都会打扰对端**
    /// （Android 的 GATT server 对同一 central 的新连接会替换旧连接）。
    /// 不冷却就会变成"每轮扫描都去打扰一次"的抖动 —— 用户真机日志里正是 13s 一轮、
    /// 把手机拨过来的那条好链路反复打断。
    #[cfg(feature = "bluetooth")]
    pub ble_dial_failures: Mutex<std::collections::HashMap<String, (u32, i64)>>,
    /// 应用是否处于「前台且窗口聚焦」（用户 2026-09-13 提的功耗策略）。
    ///
    /// 由前端在 `visibilitychange` / `focus` / `blur` 时调 `set_app_active` 更新，
    /// 蓝牙扫描循环据此选快/慢节奏（见 `network::ble::SCAN_INTERVAL_*`）：
    /// 前台（用户在用/PC 窗口聚焦）= 提高刷新率；后台/失焦 = 降频；进程退出/被杀 = 天然停止。
    pub app_active: AtomicBool,
    /// 唤醒 BLE 扫描循环**立刻扫一轮**：从后台切回前台、或用户打开「添加好友」时，
    /// 不必再等一个（后台节奏下最长 30s 的）慢周期。
    #[cfg(feature = "bluetooth")]
    pub ble_wake: Arc<Notify>,
    /// BLE 最近一轮扫描统计（诊断面板用）。
    #[cfg(feature = "bluetooth")]
    pub ble_scan: Mutex<BleScanStats>,
    /// 中继授权配置（P2 / M4）：策略 + 白名单。
    ///
    /// 为什么缓存在内存：转发热路径上 gossip 可能每秒几十条，为了一个策略字段去锁
    /// SQLite 是纯浪费。启动时从 settings 读入，`save_settings` 时更新。
    pub relay_policy: Mutex<crate::mesh::relay_policy::RelayConfig>,
    /// 替别人转发过的群信封（有界、进程内）—— 晚到成员下一次建链时从这里补递（#77）。
    /// 为什么放内存不建表：转发热路径每秒可能几十条，为一份**注定会过期**的缓存去锁
    /// SQLite 是纯浪费；代价是中间人重启后这段历史的补递窗口就没了（边界写进
    /// `mesh/gossip_replay.rs` 与本文件的判据，不许读成"群消息最终一定一致"）。
    pub gossip_relay: Mutex<crate::mesh::gossip_replay::GossipRelayCache>,
    /// 文件接收落盘目录（可变：设置页可改，改后新接收的文件落到新目录）。
    pub downloads_dir: Mutex<PathBuf>,
    /// 缓存目录：图片 / 音频 / 文件等二进制落盘于此（SQLite 不存 BLOB）
    pub cache_dir: PathBuf,
    /// 收藏媒体的**独立副本**目录（`app_data/favorites/media`）。
    ///
    /// 刻意与 `cache_dir` / `downloads_dir` 分开：那两个目录会被「存储清理」按配额与保留期
    /// 删除（见 `storage/cache_cleaner.rs`），而收藏是"用户明确要留住的东西"
    /// —— 微信的收藏也是独立存储，删聊天记录、清缓存都不该把它弄丢。
    /// 所以它**不在** `media_dirs` 里，清理逻辑不会碰它；只有「清除数据」会显式清空。
    pub favorites_dir: PathBuf,
    /// SQLite 数据库文件路径（存储页展示占用用；含 -wal/-shm 伴生文件）。
    pub db_path: PathBuf,
    /// 应用级运行日志（内存 ring buffer + 落盘文件），供「运行日志」页读取与排查。
    pub logger: Logger,
    /// 上一轮运行的结构化报告（启动时算一次；`get_previous_exit` 只 clone）。
    pub previous_exit: crate::logging::PreviousRunReport,
    /// 上一轮在蓝牙模块崩溃 ⇒ **本次不自动拉起蓝牙**（fail-closed 熔断）。
    ///
    /// 值 = 给界面看的原因文本。唯一的清除点是 `set_channel_enabled("bluetooth", true)`
    /// 成功之后（用户显式开启）；自动路径永远不写它。
    pub ble_autostart_hold: Mutex<Option<String>>,
    /// 「群任务窗口该展开哪一条任务」的一次性暂存（`groupId → todoId`，桌面端用）。
    ///
    /// 为什么要**暂存 + 定向事件两条路**（用户 2026-09-24 #39：点聊天里的任务卡片，
    /// 窗口打开后要把那条任务展开）：建窗是异步的 —— 窗口**正在创建**时前端还没
    /// `listen`，只发事件的表现就是"第一次点没反应、第二次才有"。
    /// 所以每次 `open_group_todos_window` 都写这里（不带 todoId 时**清掉**，
    /// 否则下次从标题栏按钮打开会莫名展开上次那条），窗口挂载时取走一次；
    /// 只有"窗口本来就开着"（不会经历挂载）才走定向事件那条路。
    pub todo_focus_request: Mutex<std::collections::HashMap<String, String>>,
    /// 独立「图片预览」窗口当前该显示哪一份相册（用户 2026-09-24 #40）。
    ///
    /// 这是**当前值**而不是一次性请求：每次投递都整体覆盖，所以窗口不管是挂载后自己来取、
    /// 还是被事件叫醒后来取，拿到的都是"用户最后一次点的那组图"。也正因如此 `get` 不清它 ——
    /// 清了反而会在"事件先于监听器到达"那个窗口期把内容丢掉（批次 w 记过的同一个竞态）。
    pub preview_gallery: Mutex<Option<PreviewGallery>>,
    /// 「那扇群任务窗口现在显示的是哪个群」—— **当前值**，不是一次性请求。
    ///
    /// 群任务窗口的 label 是固定的 `tasks`（不再是每群一扇），所以"看哪个群"必须由这里给：
    /// 预热时它是 `None`（窗口已经建好、还没有内容），第一次真正打开写入某个群 ⇒ 窗口
    /// 要么在挂载时自己取到（新建/预热后首用），要么被定向事件叫醒后再取（已开着）。
    /// 与 `preview_gallery` 同一套"当前值"语义 ⇒ 不存在"丢一次点击"。
    pub task_window_group: Mutex<Option<String>>,
    /// 节点身份（X25519 + Ed25519）
    pub identity: Identity,
    /// Gossip 去重 + 扇出引擎
    pub gossip: Mutex<GossipEngine>,
    /// Mesh 层的 Peer 生命周期管理（Phase 2 建、6b-3 接线）。
    ///
    /// 与 `links` 的关系：`links` 是**传输层**的连接表（每条 TCP 连接一个 `Link`），
    /// 这里是 **mesh 层**的 Peer/Connection 模型。两者由 `register_connection` /
    /// `unregister_connection` 保持同步 —— 6b-3 之后，「任一 Connection 健康 ⇒ Online」
    /// 的语义才有真实的连接数据支撑。
    pub peer_manager: Mutex<PeerManager>,
    /// Mesh 转发路由：全局去重 + TTL + 转发决策（Phase 5）。
    ///
    /// 与 `gossip` 的关系：本字段是 **Mesh 层**去重（§16 要求必须在 Mesh 层统一做），
    /// `gossip` 是业务信封层去重。两者参数一致、键同为 message_id，构成两道防线；
    /// 待 Mesh 路径稳定后收敛为一道。
    pub mesh_router: Mutex<MeshRouter>,
    /// 大文件切片中继管理器
    pub relay: Mutex<RelayManager>,
    /// 群密钥缓存：group_id -> 对称密钥
    pub group_keys: Mutex<HashMap<String, [u8; 32]>>,

    /// 在线节点表：device_id -> Peer
    pub peers: Mutex<HashMap<String, Peer>>,
    /// 已建立的 TCP 连接：device_id -> 该节点的**各条**连接。
    ///
    /// Phase 6 起一个 device_id 可以有多条连接（LAN + Tailscale + BLE），每条连接的
    /// 端点与两个发送通道放在一起，避免「端点 / bulk / priority」三处平行结构
    /// 需要手工同步下标 —— 那是 Phase 6 最容易出错的地方。
    pub links: tokio::sync::Mutex<HashMap<String, Vec<Link>>>,
    /// 待处理好友申请：from_id -> request
    pub pending_requests: Mutex<HashMap<String, PendingRequest>>,
    /// 网络运行时（None 表示未启动）
    pub network: Mutex<Option<NetworkHandle>>,
    /// 待发已读回执：peer_id -> last_read_ts。链路不可用时暂存，
    /// 由建链 / Hello / 心跳（与 outbox 补发同一批触发点）冲刷，只保留最大值。
    pub pending_reads: Mutex<HashMap<String, i64>>,
    /// 待发群密钥：peer_id -> 待补发的 group_id 集合。
    /// `redistribute_group_keys` 在 TCP link 尚未建立（announce 先于 ensure_link）
    /// 时发送会失败，此前被静默丢弃导致成员永久拿不到群密钥。
    /// 此处登记失败项，由建链 / Hello / 心跳的 flush_pending_group_keys 重试。
    pub pending_group_keys: Mutex<HashMap<String, std::collections::HashSet<String>>>,

    /// **已发出、还没被同意/拒绝的好友申请**：peer_id -> (首次登记时刻 ms, 上次补发时刻 ms)。
    ///
    /// 为什么必须登记（用户 2026-09-12 真机）：「好友已发送，等待对方确认」，但对方
    /// **什么都没收到** —— 好友申请是一条**没有回执**的定向帧，链路正好在那一刻抖动
    /// （BLE 镜像互拨把链路打断）时它就**静默丢了**，而发送方界面依然显示"已发送"。
    /// 现在：发出即登记；对端建链/Hello 补全时重发（`flush_pending_friend_request`）；
    /// 收到同意（`FriendAccept`）或拒绝（`FriendReject`）后清除。
    ///
    /// ⚠️ 为什么要带这两个时刻（用户 2026-10-14 真机：「群内加好友会弹出很多个」）：
    /// 补发每份都是**新 `message_id`** 的信封（那是"上一份可能丢了"的前提，不能复用旧 id），
    /// 而调用点挂在建链**和每轮心跳**上（5s 一轮）⇒ 一条没人应答的申请会每 5 秒向整个网洪泛一份，
    /// 对端界面也会反复收到事件。间隔判据在纯函数 `friend_request_flush_decision` 里，
    /// 与 `pending_out_accepts` 的区别是**不设次数上限也不设放弃窗口** —— 申请等的是"对方做人"，
    /// 上限等于偷偷废掉「离线时自动暂存、上线后补发」那条承诺。
    pub pending_out_requests: Mutex<std::collections::HashMap<String, (i64, i64)>>,

    /// **待补发的好友同意回执**：peer_id -> (首次登记时刻 ms, 已补发次数, 上次补发时刻 ms)。
    ///
    /// 与 `pending_out_requests` 对称、但**必须分开**：申请是"等对方动作"（收到同意/拒绝才清），
    /// 而同意回执**没有回执**（发送方无从得知对方是否收到），只能"窗口内补发若干次"。
    ///
    /// 为什么必须有（用户 2026-09-13 真机）：Android 点了「接受」，Android 侧好友列表已出现，
    /// 但 **Mac 端状态一直没同步** —— 因为 `accept_friend_request` 只发一次
    /// （直连 `try_send` 或广播兜底），而 BLE 链路正好在那一刻抖动/还没建好时，
    /// 这一帧**静默丢失**且永不重发 ⇒ 单边好友关系（我这儿有他、他那儿没我）。
    pub pending_out_accepts: Mutex<std::collections::HashMap<String, (i64, u32, i64)>>,

    /// 会话的「当前链路」快照：conv_id -> LinkState（最近一条消息的链路 + 跳数）。
    /// 收发单聊消息时更新，前端聊天窗口据此显示连接图标（LAN / 桥接 / 蓝牙）。
    pub conv_link: Mutex<HashMap<String, LinkState>>,

    /// 共享目录（本机）
    pub share_dir: Mutex<Option<String>>,
    /// 当前昵称缓存
    pub nickname: Mutex<String>,
    /// 当前头像缓存（base64 data URI）
    pub avatar: Mutex<Option<String>>,

    /// 等待对方接受的文件传输：transfer_id -> 接受信号
    pub pending_file_accept: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<(), u64>>>>,
    /// 内容服务（`ContentRequest` 触发的回发）的**每对端有界串行队列**。
    ///
    /// 为什么必须在接收循环之外：那份服务的应答（`FileAccept`/`FileReject`）要由**同一条连接的
    /// reader_loop** 读回来，而在循环里 await 整条握手 = 每次必走满 15 秒（2026-10-13 真机第 7 条：
    /// 手机端被 14 条内容重试串行服务 ≈ 210 秒，期间同链路群聊/单聊/心跳全部读不到）。
    /// 为什么是"每对端串行"而不是 `tokio::spawn`：`pending_file_accept` 只按 `transfer_id`
    /// **单键**登记，同链路多路并发传文件会互相挤掉登记（这张表历史上就因同形问题修过一次）。
    pub file_service: std::sync::Arc<crate::network::transport::FileService>,
    /// 等待接收方完成确认的直连文件传输：transfer_id -> 完成信号。
    /// 发送方在 FileDone 之后等待 FileCompleteAck，只有 success=true 才推进 delivered。
    pub pending_file_complete: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
    /// 中继接收的文件会话状态：transfer_id -> 密钥 + 预期 SHA-256 + 增量哈希。
    /// RelayFileOffer 中以我方公钥 E2EE 封装，解封后仅存内存；
    /// 中继节点不持有密钥、不参与解密与校验，只透传密文切片。
    pub relay_file_keys: Mutex<HashMap<String, RelayFileReceive>>,
    /// 群文件会话密钥：transfer_id -> {file_key, 登记时刻}（仅内存，不落库、不进日志）。
    /// 发送侧：send_group_file 生成后暂存，供后续 GroupFileChunk 加密使用；
    /// 接收侧：GroupFileOffer 解封后保存，供后续解密使用。
    /// 同一 transfer 全体成员使用同一个 file_key（经群密钥封装分发）。
    /// `at_ms` 供 TTL 清扫：只发 Offer 不发分片、或死单的密钥不落库，留着会无界增长（P3-06）。
    pub group_file_keys: Mutex<HashMap<String, GroupFileKey>>,
    /// 群文件接收侧当前轮次：transfer_id -> attempt（P1-03 真续传的轮次隔离）。
    /// 旧端不带 attempt ⇒ 查不到也按"当前轮次"处理（与旧行为一致）。
    pub group_file_rounds: Mutex<HashMap<String, u64>>,
    /// 发送侧等待的续传回执：`file_peer_key(transfer, recipient)` -> oneshot<received>。
    /// 群文件是扇出的，各成员的断点各不相同 ⇒ 必须按 (transfer, recipient) 分键。
    pub group_file_resume_waiters: Mutex<HashMap<String, tokio::sync::oneshot::Sender<u64>>>,
    /// 群文件发送轮次号（按 (transfer, recipient) 写进 Offer/Chunk/Done）。
    ///
    /// **种子取启动时刻的纳秒**，之后原子递增：① 同一进程内两个成员/两次重试不撞号；
    /// ② **跨进程重启也单调** —— 接收端把轮次存在内存里，若发送端重启后从 0 重数，
    /// 接收端会把它判成"落后轮次"直接丢掉（发送端重启后永远续不上）。
    /// 比较只在接收端做（`prev < cur ⇒ 忽略`），所以这里只需要"后启动的种子更大"。
    pub group_file_round_seq: std::sync::atomic::AtomicU64,
    /// 群文件离线投递进行中标记：同一 peer 同时最多一个投递任务
    /// （顺序发送其 pending 群文件）；不同 peer 之间并行。
    pub group_file_sending: Mutex<std::collections::HashSet<String>>,
    /// 是否还没做过"开机第一拍"的群文件 `sending` 回收（见 `sweep_stale_group_sending`）。
    ///
    /// 进程刚起时任何 `sending` 行都是**上一次进程的孤儿**（投递任务不可能活过进程）。
    /// 第一拍用不设下界的回收把它们立刻改回 `pending`，对端一上线就能续传，
    /// 不必等 10 分钟的 stale 阈值（否则"发送方重启后续传"要用户盯着转圈十分钟）。
    pub group_file_boot_sweep_pending: std::sync::atomic::AtomicBool,
    /// 群文件"在途投递"集合（键 = `file_peer_key(transfer_id, recipient)`，RAII 守卫）。
    /// 与 `group_file_sending`（按 peer 串行补发）不同：这一份按**单个成员**去重，
    /// 覆盖 fan-out 与离线补发两条入口，且包含还在并发闸后**排队**的任务。
    pub group_file_dispatching: Arc<Mutex<std::collections::HashSet<String>>>,
    /// 群文件「进度条分母」快照：transfer_id -> **发送时在线的** recipient 集合。
    ///
    /// 用户口径（2026-09-12 反馈）：进度条只按**当前在线成员**算 —— 所有在线成员都收到
    /// 即 100%；**离线成员不计入分母**，他上线后的补发也**不回退**进度条。
    /// 因此分母必须在**发送那一刻冻结**：若用「此刻在线」动态算，后上线的成员会把分母
    /// 变大、进度条倒退（正是用户明确不要的「补发算进进度条」）。
    /// 不落库：它只是展示口径，进程重启后丢失不影响投递正确性（此后进度条按
    /// 「已完成 / 全体」的兜底口径显示）。
    pub group_file_online_targets: Mutex<HashMap<String, std::collections::HashSet<String>>>,
    /// 一对一文件离线投递进行中标记：同一 peer 同时最多一个投递任务。
    pub file_sending: Mutex<std::collections::HashSet<String>>,
    /// 文件发送取消信号注册表：transfer_id -> oneshot Sender。
    /// 用户点"取消发送"时我们 send(())，三条投递路径（单聊直发 / 中继直发 / 群投递）
    /// 在哈希、排队、Offer 等待、分片循环、ACK 等待每一段都盯这一格。
    /// 取消**不是**"让这次尝试立刻返回然后交给 outbox 判死"：投递任务带着
    /// `SendFileError::cancelled` 退出，调用方按 `RetryVerdict::Cancelled` 落 `cancelled`
    /// 终态（INV-P26：取消不许记成 failed），同时 `cancel_file_transfer` 已经先把
    /// `cancel_terminal` 墓碑写好 ⇒ 任何晚到的 attempt 都改不回 active。
    /// 登记与回收只此一个家：`network::file::install_cancel_slot`。
    pub file_send_cancels: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// 群文件接收端 `.part` 状态：transfer_id -> 接收状态。
    /// 与一对一 `file_receivers` 生命周期独立；复用 FileReceiver 结构
    /// （file_key/next_seq/hasher 语义相同），不写 file_transfers 表。
    /// 缓存自动清理器**是否已经起过**（10-22 审计 R-07）。
    ///
    /// 那条 loop 挂在 `network::start()` 末尾、且不进 `tasks`（所以 `stop()` 也收不掉它），
    /// 而 `start()` 有多个生产入口：前端 `start_network`、`set_channel_enabled("lan", true)`、
    /// 启动时的自动重试。没有这根闩，用户每拨一次 LAN 开关就**多一个永久清理器**，
    /// 它们都排在同一条唯一 SQLite 连接上做 VACUUM ⇒「反复开关通道之后 App 周期性冻一下」。
    /// 最近一次「慢持锁」摘要原文（由唯一读者 `spawn_db_hold_reporter` 写入，供诊断面板读）。
    /// 面板读的是这份**留档**，不是 `take_summary()` —— 第二个读者会把计数吞掉。
    pub db_hold_note: Mutex<Option<String>>,
    pub cache_clean_started: AtomicBool,
    /// 主窗口前端心跳（Unix 毫秒；0 = 还没发过）。
    pub ui_heartbeat_ms: std::sync::atomic::AtomicI64,
    /// 前端当前在途的 IPC 操作名（看门狗写卡死现场用）。
    pub ui_current_op: Mutex<Option<String>>,
    /// 主窗口当前是否前台可见（心跳里带上来；隐藏时前端暂停心跳）。
    pub ui_heartbeat_active: AtomicBool,
    pub group_file_receivers: Mutex<HashMap<String, FileReceiver>>,
    /// 正在接收的文件：transfer_id -> FileReceiver
    pub file_receivers: Mutex<HashMap<String, FileReceiver>>,
    /// 入站登记的**唯一闸门**（审计 SEC-05 的 check-then-act 修正）。
    ///
    /// 配额判定（数活跃接收器 / 累加字节）与"把新接收器插进表里"必须落在同一个临界区：
    /// 否则两条链路同时 Offer 时会读到同一份旧占用，双双通过（配额形同虚设）。
    /// 只圈"判 + 插"这一小段 —— 建 `.part` 与续传前缀哈希是慢活，且不改变占用，
    /// 它们跑在闸门之外（续传在插入前再判一次，见 `admit_inbound`）。
    pub inbound_gate: Mutex<()>,
    /// **文件发送的"真的写出去了"进展**：transfer_id -> `FileWireProgress`。
    ///
    /// 两个用途，判据都必须落在**写出**而不是"入队"上 —— 队列能装 1024 帧，1MB 文件会在
    /// 1 秒内全部入队，而链路上要跑几分钟：
    ///   ① 把 `FileCompleteAck` 的等待从"固定 30s 墙钟"改成"**安静** 30s 才算失败"
    ///      （见 `network/file/send.rs::wait_complete_ack`）；
    ///   ② 发送进度本身（v4.22.37）：进度条按已写出的分块数换算。旧口径直接拿"入队字节"
    ///      当进度，于是 LAN 上最多 262MB 还在队列里时，界面已经显示 100%。
    pub file_wire_progress: Mutex<HashMap<String, FileWireProgress>>,
    /// 等待共享目录树响应：request_id ->（条目, 是否被上限截断）的应答通道。
    pub pending_share_tree: PendingShareTree,
    /// 等待群历史应答：request_id -> (问的是哪个群, 应答通道)。
    /// `network/group_history.rs` 的请求方登记，`transport/handle_group.rs` 的应答臂投递。
    ///
    /// 为什么键是随机 `request_id` 而不是 `(peer, group)`：同一个群可以同时问好几个人
    /// （选源那一趟要扇出去），而键里带 peer 就会让**别的**对端拿一个自报的 group 字段
    /// 把别人正在等的应答顶掉。随机 id 只有真发过这个请求的任务知道 ⇒ 未注册的应答直接丢弃。
    /// 为什么把 group 一起存：应答里的 `group_id` 是对端自报的，要有一个本机-side 的期望值
    /// 才能判"答的是不是我问的那个群"（拿 A 群的历史冒充 B 群，落库就会写进错的会话）。
    pub pending_group_history: Mutex<
        HashMap<
            String,
            (
                String,
                tokio::sync::oneshot::Sender<crate::protocol::GroupHistoryReplyBody>,
            ),
        >,
    >,
    /// **正在跑群历史同步的那几个群**（在飞闸，见 `network::group_history::spawn_sync`）。
    /// 入群钩子、群消息顺手建群那一路、以及每 60 秒的清扫任务都会喊同一声；
    /// 没有这一格，同一个群会同时排两三趟、各要一遍同样的历史（结果一样，开销翻倍）。
    pub group_history_active: Mutex<std::collections::HashSet<String>>,
    /// 群历史同步的**协作式取消标志**（2026-10-25 用户：任务中心的同步也要能停）。
    ///
    /// 只由 `request_cancel` 在"该群确实在飞"时写入；同步体在**每页之间**检查并消费，
    /// 跑完/失败/被取消时由在飞守卫一并清掉（否则下一次同步会继承一个陈旧标志、刚起跑就停）。
    /// 不做成强行 abort：当前那一页的应答最多等 20s，而落库本来就在阻塞池里 ——
    /// 从中间砍掉会留下"请求还在路上、应答没人等"的半截现场。
    pub group_history_cancels: Mutex<std::collections::HashSet<String>>,

    /// 节点表是否需要向前端推送（节流合并用，见 `spawn_peer_emitter`）
    pub peers_dirty: AtomicBool,
    /// **网络世代号**（D8-4）：每次 `start()`/`stop()` 自增。
    ///
    /// 为什么需要：`handle_incoming` 是 accept 时就 spawn 的长任务，它要**握手完成后**
    /// 才登记链路。若期间用户切换了网卡/重开通道（stop→start），这个"上个世代"的任务
    /// 仍会把链路登记进**新世代**的 `links`/`peer_manager` —— 一条没人认识、也不会被
    /// 新世代 shutdown 覆盖的连接（旧 socket 早已断，但状态是真的）。
    /// 世代号让"登记前先确认自己还属于当前世代"成为一行判断。
    pub network_generation: AtomicU64,
    /// 节点表变更通知（节流合并的唤醒信号）
    pub peers_notify: Arc<Notify>,
    /// 各对端在 Hello 里声明的内容能力位图（device_id -> bits）。**不参与签名**，
    /// 仅用于"能不能对它发 ContentRequest"；旧端不声明 ⇒ 默认 0 ⇒ 不发新帧（向后兼容）。
    pub peer_content_features: Mutex<HashMap<String, u32>>,
    /// 各对端在 Hello 里声明的版本（device_id -> 声明）。**不参与签名**，当前只被诊断面板
    /// 与"忽略未知帧"的降级日志读（INV-P24：对端版本更高必须可解释）。
    pub peer_versions: Mutex<HashMap<String, PeerVersion>>,
    /// 按需探测触发：值递增 → 发现任务立即群发一次 `who_has`（好友搜索用）
    pub probe: Mutex<Option<watch::Sender<u64>>>,

    /// Discovery 诊断状态（隐藏开发者面板用，只读展示不改变网络行为）
    pub diag: Mutex<DiscoveryDiag>,
    /// Hello 握手防重放：近期已接受的 nonce（有界 FIFO，超出丢弃最旧）。
    /// 与本地时钟无关，因此不受设备间时间偏差影响。
    pub seen_hello_nonces: Mutex<VecDeque<String>>,
    /// 已就「身份密钥冲突」告警过的 device_id（本进程内去重）。
    /// announce 每 5s 一次、冲突会持续存在，不去重会把聊天记录刷爆。
    pub key_conflict_warned: Mutex<std::collections::HashSet<String>>,
    /// 「好友重装后身份密钥变更」的**待确认轮换**：device_id -> 对端新身份（候选）。
    ///
    /// 只在新 ed25519 对 Hello **自验签通过**、但与 friends 表绑定值不一致时登记 ——
    /// 即「持新私钥的同一 device_id」，且对方是好友。未签名的 UDP announce 不进这里
    /// （任何人可伪造，不能作为一键换钥依据）。用户在聊天界面确认是本人后，
    /// 经 `sync_friend_keys` 命令覆盖 friends 表；删除好友时一并清掉。仅内存，重启清空。
    pub pending_key_rotations: Mutex<HashMap<String, PendingKeyRotation>>,
}

/// 一次待确认的好友密钥轮换候选（见 `AppState::pending_key_rotations`）。
#[derive(Clone)]
pub struct PendingKeyRotation {
    /// 对端自报的新加密公钥（base64）。
    pub x25519_pubkey: String,
    /// 对端自报、且已通过本次 Hello 自签名验证的新身份公钥（base64）。
    pub ed25519_pubkey: String,
    /// 首次观察到的时刻（ms）。
    pub ts: i64,
}

/// 启动期**数据完整性**错误：这一族绝不允许降级成"新建一份"。
///
/// 2026-10-20 P0（Windows 崩溃后变成默认新用户、好友丢失）的代码根因就在旧路径：
/// `get_setting` 把读库错误折成 `None`，身份加载把 `None` 当"首次安装"，于是
/// **一次 SQLITE_BUSY / I/O 错误就生成新密钥并写回旧库**。现在所有身份与设备标识
/// 的读取都走 `get_setting_checked`，任何失败都返回这里的错误并中止启动；
/// 原数据库一个字节都不改，由用户在提示里选择恢复/导出诊断。
#[derive(Debug, thiserror::Error)]
pub enum StartupError {
    #[error("身份密钥读取失败（读库错误）：{source}")]
    IdentityRead { source: rusqlite::Error },
    #[error("身份密钥不完整：{detail}")]
    IdentityIncomplete { detail: String },
    #[error("身份密钥损坏/截断，无法解析")]
    IdentityCorrupt,
    #[error("身份密钥写入失败：{source}")]
    IdentityPersist { source: rusqlite::Error },
    #[error("设备标识读取失败（读库错误）：{source}")]
    DeviceIdRead { source: rusqlite::Error },
    #[error("已有安装的数据库里缺少设备标识")]
    DeviceIdMissing,
    #[error("设备标识写入失败：{source}")]
    DeviceIdPersist { source: rusqlite::Error },
    #[error("设置 {key} 读取失败（读库错误）：{source}")]
    SettingRead {
        key: &'static str,
        source: rusqlite::Error,
    },
    #[error("启动数据探测失败（读库错误）：{source}")]
    BusinessDataProbe { source: rusqlite::Error },
    #[error("主库为空但发现可恢复的迁移备份：{}", .backup.display())]
    RecoverableBackup { backup: PathBuf },
}

impl StartupError {
    /// 日志与原生弹窗共用的错误码（支持人员按码检索）。
    pub fn code(&self) -> &'static str {
        match self {
            StartupError::IdentityRead { .. } => "IDENTITY_READ_FAILED",
            StartupError::IdentityIncomplete { .. } => "IDENTITY_INCOMPLETE",
            StartupError::IdentityCorrupt => "IDENTITY_CORRUPT",
            StartupError::IdentityPersist { .. } => "IDENTITY_PERSIST_FAILED",
            StartupError::DeviceIdRead { .. } => "DEVICE_ID_READ_FAILED",
            StartupError::DeviceIdMissing => "DEVICE_ID_MISSING",
            StartupError::DeviceIdPersist { .. } => "DEVICE_ID_PERSIST_FAILED",
            StartupError::SettingRead { .. } => "SETTING_READ_FAILED",
            StartupError::BusinessDataProbe { .. } => "DB_DATA_PROBE_FAILED",
            StartupError::RecoverableBackup { .. } => "DB_RECOVERABLE_BACKUP_FOUND",
        }
    }

    /// 给人看的完整说明。核心承诺写在每一句里：**没有生成新身份、没有覆盖旧数据**。
    pub fn user_message(&self, app_data: &Path) -> String {
        let code = self.code();
        let body = match self {
            StartupError::IdentityRead { .. }
            | StartupError::DeviceIdRead { .. }
            | StartupError::SettingRead { .. }
            | StartupError::BusinessDataProbe { .. } => format!(
                "读取本地数据库时发生错误，Gosslan 已停止启动。\n\
                 为了避免把一次临时读库失败误判成『首次安装』，本次**没有生成新身份、也没有覆盖旧数据**。\n\
                 常见原因是另一个 Gosslan 进程仍持有数据库、磁盘/权限异常。\n\
                 请关闭其它 Gosslan 实例后重试；若仍失败，请保留数据目录并导出诊断信息。\n\n技术信息：{self}"
            ),
            StartupError::IdentityIncomplete { .. } => format!(
                "数据库里已有安装数据，但身份密钥不完整（{self}）。\n\
                 Gosslan 已停止启动：**没有生成新身份，也没有覆盖任何旧密钥**。\n\
                 这通常意味着数据库被部分损坏或被外部工具改写过。\n\
                 请保留数据目录，优先从同目录的迁移备份恢复，再导出诊断信息。"
            ),
            StartupError::IdentityCorrupt => {
                "数据库里的身份密钥无法解析（损坏/截断）。\n\
                 Gosslan 已停止启动：**没有覆盖旧密钥**。\n\
                 覆盖它会让好友绑定与历史加密消息永久失配。\n\
                 请保留数据目录，优先从迁移备份恢复，再导出诊断信息。"
                    .to_string()
            }
            StartupError::IdentityPersist { .. } => format!(
                "新身份密钥写不进数据库（{self}）。\n\
                 Gosslan 已停止启动：**不会在内存里临时使用一套无法持久化的新身份**。\n\
                 请检查磁盘空间/权限，保留数据目录后重试。"
            ),
            StartupError::DeviceIdMissing => {
                "数据库里已有安装数据，但缺少设备标识。\n\
                 Gosslan 已停止启动：**没有生成新设备标识**（换了它，好友会看到一个陌生人）。\n\
                 请保留数据目录，优先从迁移备份恢复，再导出诊断信息。"
                    .to_string()
            }
            StartupError::DeviceIdPersist { .. } => format!(
                "设备标识写不进数据库（{self}）。Gosslan 已停止启动，避免每次启动都换一个身份。\n\
                 请检查磁盘空间/权限，保留数据目录后重试。"
            ),
            StartupError::RecoverableBackup { backup } => format!(
                "主数据库看起来是空的，但同目录下有一份可恢复的迁移备份：\n{}\n\n\
                 为防止崩溃后误生成新身份，Gosslan 已停止启动。\n\
                 请先把整个数据目录复制保留，再由你决定是否用这份备份恢复；\n\
                 在恢复前不要删除备份，也不要用当前版本新建身份。",
                backup.display()
            ),
        };
        format!(
            "{body}\n\n错误码：{code}\n数据目录：{}\n日志目录：{}\n\
             本次启动没有删除或覆盖数据库、备份与日志。",
            app_data.display(),
            app_data.join("logs").display()
        )
    }
}

/// 加载持久化身份；**只在空库首次安装时**生成一次。
///
/// 返回 `(identity, generated)`：`generated=false` 表示来自已存密钥。
/// 任何"看起来像损坏/读失败"的形状都返回错误，绝不落新密钥。
fn load_or_create_identity(
    conn: &Connection,
    existing_install: bool,
) -> Result<(Identity, bool), StartupError> {
    let xs = db::get_setting_checked(conn, "x25519_secret")
        .map_err(|source| StartupError::IdentityRead { source })?;
    let es = db::get_setting_checked(conn, "ed25519_secret")
        .map_err(|source| StartupError::IdentityRead { source })?;
    match (xs, es) {
        (Some(xs), Some(es)) => Identity::from_secrets(&xs, &es)
            .map(|id| (id, false))
            .ok_or(StartupError::IdentityCorrupt),
        (None, None) if !existing_install => {
            let id = Identity::generate();
            persist_identity(conn, &id)?;
            Ok((id, true))
        }
        (None, None) => Err(StartupError::IdentityIncomplete {
            detail: "两条私钥都不存在（库中已有业务数据，拒绝按首次安装处理）".to_string(),
        }),
        (x, e) => Err(StartupError::IdentityIncomplete {
            detail: format!(
                "只有一条私钥存在（x25519={}, ed25519={}）——部分写入或损坏",
                x.is_some(),
                e.is_some()
            ),
        }),
    }
}

/// 两条私钥的写入必须在**同一事务**里：否则中途失败会留下"只有一条"的形状，
/// 下次启动会被判成损坏（比现在更糟的是用它去覆盖另一条）。
fn persist_identity(conn: &Connection, id: &Identity) -> Result<(), StartupError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|source| StartupError::IdentityPersist { source })?;
    db::set_setting(&tx, "x25519_secret", &id.x25519_secret_b64())
        .map_err(|source| StartupError::IdentityPersist { source })?;
    db::set_setting(&tx, "ed25519_secret", &id.ed25519_secret_b64())
        .map_err(|source| StartupError::IdentityPersist { source })?;
    tx.commit()
        .map_err(|source| StartupError::IdentityPersist { source })?;
    Ok(())
}

impl AppState {
    /// 取群文件会话密钥并**刷新 TTL**：有分片/Offer 活动就说明这一单还活着，
    /// 不该被 2h 的清扫器中途收走（大文件经 BLE 或多轮重试可能超过 2h）。
    pub fn touch_group_file_key(&self, transfer_id: &str) -> Option<[u8; 32]> {
        let mut keys = self
            .group_file_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        keys.get_mut(transfer_id).map(|k| {
            k.at_ms = crate::db::now_ms();
            k.key
        })
    }

    /// 初始化应用状态：解析目录、打开数据库、加载/生成设备指纹与身份密钥。
    pub fn init(app: AppHandle) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
        let app_data = app.path().app_data_dir()?;
        std::fs::create_dir_all(&app_data).ok();
        // 专用数据目录也只允许属主进入/列出：文件 0600 挡得住读，挡不住 ls 出文件名。
        crate::private_fs::restrict_dir_to_owner(&app_data);
        let default_downloads = app_data.join("downloads");
        std::fs::create_dir_all(&default_downloads).ok();
        let cache_dir = app_data.join("cache");
        std::fs::create_dir_all(&cache_dir).ok();
        // 收藏副本目录：独立于 cache/downloads，存储清理不碰（见字段注释）。
        let favorites_dir = app_data.join("favorites").join("media");
        std::fs::create_dir_all(&favorites_dir).ok();

        // 多开支持：`--instance N`（或环境变量 GOSSLAN_INSTANCE）→ 独立数据库 / 端口 / 设备指纹
        let instance = instance_id();
        let db_name = if instance > 0 {
            format!("gosslan-{instance}.db")
        } else {
            "gosslan.db".to_string()
        };
        let db_path = app_data.join(db_name);
        // 必须在 `db::init` **之前**取：init 会把不存在的文件创建出来，之后再 stat
        // 就无法区分「已有安装的库」与「刚建的空库」—— 而身份加载的安全性依赖这个判断。
        let db_preexisting = std::fs::metadata(&db_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        let (conn, startup_notices) = db::init_with_notices(&db_path)?;

        // 运行日志：多开实例用独立文件（gosslan-1.log），避免测试实例互相覆盖。
        let log_stem = if instance > 0 {
            format!("gosslan-{instance}")
        } else {
            "gosslan".to_string()
        };
        // 设备短指纹：平台 tag + hostname 前 6 字符。
        // 让多台设备的日志能一眼区分 — 用户贴多段日志时 AI 自动归类。
        let dev_fingerprint = {
            let plat = match std::env::consts::OS {
                "windows" => "Win",
                "android" => "And",
                "macos" => "Mac",
                "ios" => "iOS",
                "linux" => "Lin",
                _ => "Oth",
            };
            let host = hostname::get()
                .map(|h| h.to_string_lossy().chars().take(6).collect::<String>())
                .unwrap_or_else(|_| "unknown".to_string());
            format!("[dev:{plat}-{host}]")
        };
        // 日志目录必须走唯一计算点（与 bootstrap 的现场文件同源，见 logging::crash_file_in）。
        let logger = Logger::new(
            crate::logging::log_dir_in(&app_data),
            &log_stem,
            dev_fingerprint,
        );
        // 把上一轮留在盘上的记录读进内存环：get_logs 只读内存，不补这一步，
        // 崩溃重启后界面里看不见刚发生的那次故障。
        // 必须紧跟 Logger::new、排在本轮第一条日志之前；接线点只许一处。
        let seeded = logger.seed_previous_run();
        if seeded > 0 {
            logger.info(
                "boot",
                format!(
                    "上一轮记录已载入内存：{seeded} 条（只读，盘上原件不动；内存环有上界会淘汰）"
                ),
            );
        }
        // `db::init_with_notices` 排队的那几条：备份清扫发生在 logger 之前，
        // 现在补写进日志（审计 DB-02 复审 —— 打包版 Windows 没有控制台，eprintln 等于没写）。
        for note in startup_notices {
            logger.warn("db", note);
        }

        // ---- 启动数据完整性快照（2026-10-20 P0 的现场证据）----
        // 这一行必须早于身份加载：下一次"崩溃后变成默认新用户"的现场，要能一眼分开
        // 「还是原来那份库（计数在）」与「换了一份空库（计数全 0、路径不同）」。
        let (messages, friends, conversations, groups) = match db::boot_data_counts(&conn) {
            Ok(v) => v,
            Err(source) => {
                logger.error(
                    "boot",
                    format!("code=DB_DATA_PROBE_FAILED db={} err={source} —— 无法确认库内数据，停止启动", db_path.display()),
                );
                crate::logging::crash_note(&format!(
                    "code=DB_DATA_PROBE_FAILED 数据库探测失败，停止启动：{source}（未写入任何业务数据）"
                ));
                return Err(Box::new(StartupError::BusinessDataProbe { source }));
            }
        };
        let existing_install = db_preexisting || messages + friends + conversations + groups > 0;
        let db_bytes = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
        logger.info(
            "boot",
            format!(
                "code=BOOT_DB_STATE data_dir={} db={} existed={db_preexisting} bytes={db_bytes} \
                 install={existing_install} messages={messages} friends={friends} \
                 conversations={conversations} groups={groups}",
                app_data.display(),
                db_path.display()
            ),
        );
        // 主库看起来是空库、旁边却有迁移备份 ⇒ 绝不按首次安装生成新身份。
        if !existing_install {
            if let Some(backup) = db::find_recovery_backup(&db_path) {
                logger.error(
                    "boot",
                    format!(
                        "code=DB_RECOVERABLE_BACKUP_FOUND backup={} —— 主库为空，拒绝生成新身份",
                        backup.display()
                    ),
                );
                crate::logging::crash_note(&format!(
                    "code=DB_RECOVERABLE_BACKUP_FOUND 主库为空但存在迁移备份：{}（未生成新身份）",
                    backup.display()
                ));
                return Err(Box::new(StartupError::RecoverableBackup { backup }));
            }
        }

        // 🟦 崩溃恢复：把所有 sending 状态的 file_outbox 重置回 pending。
        // 进程可能在 mark sending 后、delete 前崩溃 —— 这些条目会永远卡在 sending，
        // list_pending_file_outbox 只捞 pending 的，它们就被彻底遗忘了。
        // 重置后下次 Hello 触发 flush_pending_files 会重新捞出来重试；
        // 重复传输由对端的幂等 FileOffer 处理。
        match db::reset_sending_to_pending(&conn) {
            Ok(n) if n > 0 => logger.info(
                "outbox",
                format!("code=FILE_OUTBOX_RECOVERED count={n} action=sending→pending"),
            ),
            Ok(_) => {}
            Err(e) => logger.error(
                "outbox",
                format!("code=FILE_OUTBOX_RECOVER_FAILED err={e} —— 文件队列可能停在 sending，需人工关注"),
            ),
        }
        // 消息队列的崩溃窗口：`sending` 但两张 outbox 表都没有行 ⇒ 清扫器与补发都看不见它。
        // 落 failed 是诚实的终态（没有 Ack 就没有送达证据）；接收端按 msg_id 幂等，重发安全。
        match db::recover_orphan_sending_messages(&conn) {
            Ok(n) if n > 0 => logger.warn(
                "outbox",
                format!(
                    "code=OUTBOX_ORPHAN_RECOVERED count={n} action=sending→failed —— \
                     这些消息没有 outbox 行（崩溃窗口/历史收尾顺序），否则会永久显示发送中"
                ),
            ),
            Ok(_) => {}
            Err(e) => logger.error(
                "outbox",
                format!("code=OUTBOX_ORPHAN_RECOVER_FAILED err={e} —— 孤儿 sending 行可能仍会永久显示发送中"),
            ),
        }
        // 🟦 崩溃恢复第三件（10-22 审计 R-14）：上面两条都管不到 `file_transfers` 的 `active` 行
        // （第二条那段 SQL 还显式排除 `file-%`/`gfile-%`），于是被强杀的那次接收会留下
        // 一张永远「接收中 X%」的卡片。这里把它落 failed —— 续传不受影响（判据在磁盘 `.part`，
        // 对端重来时 upsert 会把状态写回去）。
        match db::fail_interrupted_transfers_on_startup(&conn) {
            Ok(n) if n > 0 => logger.info(
                "file",
                format!("code=TRANSFER_INTERRUPTED_RECOVERED count={n} action=active→failed"),
            ),
            Ok(_) => {}
            Err(e) => logger.warn(
                "file",
                format!("code=TRANSFER_INTERRUPTED_RECOVER_FAILED err={e} —— 上次中断的接收卡片可能仍显示接收中"),
            ),
        }
        // 发送侧 pending 的两种“不会再有人碰”的台账：没有活着的 outbox（删会话/删好友留下的孤儿）
        // 或 outbox 已用完重试次数。启动时先收口，避免用户一开机就看到一条永远排队。
        // 只碰 direction='send'；接收行没有 outbox，绝不能进这个对账。
        match db::reconcile_pending_send_transfers(&conn) {
            Ok(report) => {
                if !report.changed.is_empty() {
                    logger.warn(
                        "file",
                        format!(
                            "code=FILE_TRANSFER_ORPHAN_RECONCILED count={} ids={:?} action=pending→failed",
                            report.changed.len(),
                            report.changed
                        ),
                    );
                }
                for (transfer_id, why) in report.failed {
                    logger.error(
                        "file",
                        format!(
                            "code=FILE_FINALIZE_FAILED transfer_id={transfer_id} ctx=startup_reconcile err={why} —— 下一轮清扫器再试"
                        ),
                    );
                }
            }
            Err(e) => logger.warn(
                "file",
                format!(
                    "code=FILE_TRANSFER_ORPHAN_RECONCILE_FAILED err={e} —— 孤儿发送行下一轮清扫器再试"
                ),
            ),
        }

        // 文件接收目录：默认 app_data/downloads，允许用户在设置里改（持久化到 settings）。
        // 与共享目录同理：用户自选的目录在沙盒里重启后会失访，必须靠书签把权限带回来，
        // 否则"收到的文件写不进去"（而且同样没有报错弹窗）。
        let downloads_dir = crate::user_dirs::load(&conn, crate::user_dirs::RECEIVE)
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(default_downloads);
        std::fs::create_dir_all(&downloads_dir).ok();

        // 设备 ID：**只认已持久化的值，没有才生成一次**（派生式身份为什么会撞，见 `device.rs` 头）。
        //
        // 这条改动对**已装设备是惰性的**，这是刻意的：旧代码每次启动都把派生值写回 settings，
        // 所以已存的值就等于派生值 ⇒ 换优先级不会改变任何现存设备的 ID，也就不会打断任何已有
        // 好友绑定。代价是**今天已经撞上号的两台，这段代码救不了它们** —— 救它们需要
        // "检测到同 ID 不同密钥 ⇒ 提示换新 ID"那一条路，而它**还没实现**（ADR-0021 的切片 2；
        // 换 ID 的口径用户 2026-09-22 已拍板：好友重加、旧会话只读、聊天记录不迁移）。
        // 在那之前，已经撞上的两台只能靠下面那个 `dev-` 前缀迁移之外的手工路径（清应用数据）。
        // 设备标识与身份密钥同一道安全边界：**读失败/已有库缺失都不许重建**。
        // 换了设备 id，好友会看到一个陌生人（旧 id 的会话与密钥绑定全部对不上）。
        let base_device = match db::get_setting_checked(&conn, "device_id") {
            Ok(Some(stored)) => {
                // ⚠️ **历史值迁移**（2026-09-13 合并评审补）：那时的兜底路径多套了一层前缀，
                // 已装的安卓库里存的是 `dev-gosslan-…`。光改生成代码治不了已装设备 —— 它们的
                // id 还是"三端里恒最小、永远不主动拨号"的那个值，除非清一次应用数据（丢聊天与
                // 好友）。所以这里把废弃前缀**就地剥掉**再写回。
                match crate::device::strip_legacy_dev_prefix(&stored) {
                    Some(migrated) => {
                        if let Err(e) = db::set_setting(&conn, "device_id", migrated) {
                            // 写失败不会导致身份变化：下次启动仍会重试同一段迁移。
                            logger.warn(
                                "identity",
                                format!("code=DEVICE_ID_MIGRATION_WRITE_FAILED err={e} —— 本次仍使用迁移后的 id"),
                            );
                        }
                        migrated.to_string()
                    }
                    None => stored,
                }
            }
            Ok(None) if !existing_install => {
                // ⚠️ 生成函数自己带 `gosslan-` 前缀，这里**不能再套一层**：真机 2026-09-13 那轮
                // 多套了个 `dev-`，于是 `'d' < 'g'` ⇒ 安卓在三端里恒为最小 id，而镜像规则是
                // 「大 id 拨、小 id 只接受」⇒ 那台设备永远不主动拨任何人，只能等别人来连它。
                let fresh = generate_device_id(&collect_device_attrs());
                if let Err(source) = db::set_setting(&conn, "device_id", &fresh) {
                    logger.error(
                        "identity",
                        format!("code=DEVICE_ID_PERSIST_FAILED err={source} —— 停止启动，避免每次启动换身份"),
                    );
                    crate::logging::crash_note(&format!(
                        "code=DEVICE_ID_PERSIST_FAILED 设备标识写入失败，停止启动：{source}（未生成新身份/标识）"
                    ));
                    return Err(Box::new(StartupError::DeviceIdPersist { source }));
                }
                fresh
            }
            Ok(None) => {
                logger.error(
                    "boot",
                    "code=DEVICE_ID_MISSING 已有安装的数据库里没有 device_id —— 拒绝生成新标识",
                );
                crate::logging::crash_note(
                    "code=DEVICE_ID_MISSING 已有安装缺少 device_id，停止启动（未生成新身份）",
                );
                return Err(Box::new(StartupError::DeviceIdMissing));
            }
            Err(source) => {
                logger.error(
                    "boot",
                    format!("code=DEVICE_ID_READ_FAILED err={source} —— 停止启动，避免生成新标识"),
                );
                crate::logging::crash_note(&format!(
                    "code=DEVICE_ID_READ_FAILED 设备标识读取失败，停止启动：{source}（未生成新标识）"
                ));
                return Err(Box::new(StartupError::DeviceIdRead { source }));
            }
        };
        // 多开时给不同实例不同 device_id，使其成为互相可发现的独立节点
        let device_id = if instance > 0 {
            format!("{base_device}-i{instance}")
        } else {
            base_device.clone()
        };

        // 多开时偏移 TCP 端口（UDP 端口保持共享的发现通道，配合 SO_REUSEADDR 多实例共存）
        let tcp_port: u16 = if instance > 0 {
            TCP_PORT.saturating_add((instance * 10) as u16)
        } else {
            db::get_setting(&conn, "tcp_port")
                .and_then(|s| s.parse().ok())
                .unwrap_or(TCP_PORT)
        };

        // 默认昵称：**不用设备用户名/hostname**，改用「形容词 + 动物 + 设备短码」的英文名
        // （用户 2026-09-12 要求：长度合适、不改也好看、又有想改的欲望；规则见 `nickname.rs`）。
        // 同一台设备名字稳定（由 device_id 派生），而且**不含设备信息**。
        let hostname_now = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default();
        let nickname = match db::get_setting_checked(&conn, "nickname") {
            Ok(Some(n)) => {
                // 一次性迁移：旧的默认名（空 / 旧字面值 / 恰好是 hostname）换成新规则。
                // 用户自己取过的名字一律不动 —— 判据是"精确等于旧默认的产物"。
                if crate::nickname::is_legacy_default(&n, &hostname_now) {
                    let fresh = crate::nickname::default_nickname(&device_id);
                    if let Err(e) = db::set_setting(&conn, "nickname", &fresh) {
                        logger.warn(
                            "identity",
                            format!("code=NICKNAME_MIGRATION_WRITE_FAILED err={e}"),
                        );
                    }
                    fresh
                } else {
                    n
                }
            }
            Ok(None) => {
                let fresh = crate::nickname::default_nickname(&device_id);
                if let Err(e) = db::set_setting(&conn, "nickname", &fresh) {
                    logger.warn("identity", format!("code=NICKNAME_PERSIST_FAILED err={e}"));
                }
                fresh
            }
            Err(source) => {
                // 昵称读失败同样说明库不可信；继续启动会拿默认名覆盖或让界面状态漂移。
                logger.error(
                    "identity",
                    format!("code=SETTING_READ_FAILED key=nickname err={source} —— 停止启动"),
                );
                return Err(Box::new(StartupError::SettingRead {
                    key: "nickname",
                    source,
                }));
            }
        };
        let avatar = db::get_setting(&conn, "avatar");
        // 共享目录：macOS 沙盒里**必须**先解析安全作用域书签（解析即开始访问），
        // 否则重启后目录还在、权限没了 —— 现象是"共享目录列表变空"，且没有任何报错。
        let share_dir = crate::user_dirs::load(&conn, crate::user_dirs::SHARE);

        // 启动时从 DB 恢复待发已读回执（进程重启后 pending_reads 内存丢失的恢复路径）
        let mut pending_reads_map = HashMap::new();
        if let Ok(rows) = db::load_pending_reads(&conn) {
            for (peer_id, ts) in rows {
                let cur = pending_reads_map.entry(peer_id).or_insert(ts);
                *cur = (*cur).max(ts);
            }
        }

        // 加载或生成身份密钥（X25519 + Ed25519）。
        //
        // ⚠️ 2026-10-20 P0：旧实现在这里 `unwrap_or_else` 生成新密钥并覆盖旧值，
        // 且把"读库失败"与"键不存在"混为一谈。现在任何读失败/缺一条/解析失败都
        // **中止启动**；只有空库首次安装才允许生成一次，且写入失败也中止。
        let (identity, identity_generated) = match load_or_create_identity(&conn, existing_install)
        {
            Ok(v) => v,
            Err(e) => {
                logger.error(
                    "identity",
                    format!("code={} {e} —— 停止启动，未生成/覆盖任何密钥", e.code()),
                );
                crate::logging::crash_note(&format!(
                    "code={} 身份加载失败，停止启动：{e}（未生成/覆盖任何密钥）",
                    e.code()
                ));
                return Err(Box::new(e));
            }
        };
        logger.info(
            "identity",
            format!(
                "code=IDENTITY_LOADED source={} existing_install={existing_install}",
                if identity_generated {
                    "generated_first_install"
                } else {
                    "persisted"
                }
            ),
        );

        // 中继授权（P2 / M4）：启动时读一次，之后由 save_settings 更新内存缓存。
        // 缺失/脏值 → 默认 `All`（= 今天的行为，见 mesh/relay_policy.rs 顶部说明）。
        let relay_policy = crate::mesh::relay_policy::RelayConfig::parse(
            db::get_setting(&conn, "relay_policy").as_deref(),
            db::get_setting(&conn, "relay_allowlist").as_deref(),
        );

        // 上一轮报告在 `seed_previous_run` 里已经算好；这里取一次，决定本次是否熔断蓝牙。
        let previous_exit = logger.previous_run_report();
        let ble_autostart_hold = if previous_exit.ble_suspect {
            let where_ = previous_exit
                .panic
                .as_ref()
                .map(|p| p.location.clone())
                .or_else(|| previous_exit.hang.as_ref().and_then(|h| h.last_op.clone()))
                .unwrap_or_else(|| "蓝牙模块".to_string());
            Some(format!("上次运行在蓝牙模块崩溃（{where_}）"))
        } else {
            None
        };

        Ok(Arc::new(AppState {
            app,
            db: DbLock::new(conn),
            file_service: crate::network::transport::FileService::new(
                crate::network::transport::FILE_SERVICE_QUEUE_CAP,
            ),
            device_id,
            tcp_port,
            // 「前端还没推语言」的初值；前端 `app.init()` 随后就会推一次真实值。
            ui_lang: AtomicU8::new(UI_LANG_UNKNOWN),
            lang_pref: AtomicU8::new(LANG_PREF_UNSET),
            notify_pref: AtomicU8::new(NOTIFY_PREF_UNSET),
            downloads_dir: Mutex::new(downloads_dir),
            cache_dir,
            favorites_dir,
            db_path,
            logger,
            previous_exit,
            ble_autostart_hold: Mutex::new(ble_autostart_hold),
            identity,
            gossip: Mutex::new(GossipEngine::new(100_000, 10_000, 4, 6)),
            // max_ttl / fanout 与 GossipEngine 对齐（6 / 4），保证行为一致。
            // health_timeout 10s（约两个心跳周期）、max_failures 3
            // 健康超时 = 3 × 心跳周期（心跳在 `network::transport` 每 5s 一次）。
            // ⚠️ 不要退回 10_000：那**恰好等于 2 个心跳周期**，丢一拍就到边界、
            // 丢两拍即判不健康（判据是闭区间 `<=`），网络抖动会被误报成链路故障。
            // 上限受 `RELAY_PEER_TIMEOUT_SECS = 45s` 约束（跨跳节点无直连，
            // 只靠 10s 一轮的 Presence 保活），15s 留足余量且远小于 45s。
            // 不变量由 `mesh::manager::tests::health_timeout_outlives_three_heartbeats` 守住。
            peer_manager: Mutex::new(PeerManager::new(15_000, 3)),
            mesh_router: Mutex::new(MeshRouter::new(100_000, 10_000, 6, 4, 256)),
            relay: Mutex::new(RelayManager::new()),
            relay_policy: Mutex::new(relay_policy),
            gossip_relay: Mutex::new(crate::mesh::gossip_replay::GossipRelayCache::default()),
            #[cfg(feature = "bluetooth")]
            ble: Mutex::new(None),
            #[cfg(feature = "bluetooth")]
            ble_no_dial: Mutex::new(std::collections::HashSet::new()),
            #[cfg(feature = "bluetooth")]
            ble_peer_advertises: Mutex::new(std::collections::HashSet::new()),
            #[cfg(feature = "bluetooth")]
            ble_scan_now: Mutex::new(None),
            #[cfg(feature = "bluetooth")]
            ble_dial_failures: Mutex::new(std::collections::HashMap::new()),
            dialing: Mutex::new(std::collections::HashSet::new()),
            todo_focus_request: Mutex::new(std::collections::HashMap::new()),
            preview_gallery: Mutex::new(None),
            task_window_group: Mutex::new(None),
            dial_permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_DIALS)),
            inbound_permits: Arc::new(tokio::sync::Semaphore::new(MAX_INBOUND_CONNECTIONS)),
            group_file_permits: Arc::new(tokio::sync::Semaphore::new(
                MAX_CONCURRENT_GROUP_FILE_SENDS,
            )),
            pending_out_requests: Mutex::new(std::collections::HashMap::new()),
            pending_out_accepts: Mutex::new(std::collections::HashMap::new()),
            group_keys: Mutex::new(HashMap::new()),
            peers: Mutex::new(HashMap::new()),
            links: tokio::sync::Mutex::new(HashMap::new()),
            pending_requests: Mutex::new(HashMap::new()),
            network: Mutex::new(None),
            pending_reads: Mutex::new(pending_reads_map),
            pending_group_keys: Mutex::new(HashMap::new()),
            conv_link: Mutex::new(HashMap::new()),
            share_dir: Mutex::new(share_dir),
            nickname: Mutex::new(nickname),
            avatar: Mutex::new(avatar),
            pending_file_accept: Mutex::new(HashMap::new()),
            pending_file_complete: Mutex::new(HashMap::new()),
            relay_file_keys: Mutex::new(HashMap::new()),
            group_file_keys: Mutex::new(HashMap::new()),
            group_file_rounds: Mutex::new(HashMap::new()),
            group_file_resume_waiters: Mutex::new(HashMap::new()),
            // 种子 = 启动时刻纳秒（理由见 `group_file_round_seed`：发送端重启后轮次
            // 必须仍大于接收端记住的旧值）
            group_file_round_seq: std::sync::atomic::AtomicU64::new(group_file_round_seed()),
            db_hold_note: Mutex::new(None),
            cache_clean_started: AtomicBool::new(false),
            ui_heartbeat_ms: std::sync::atomic::AtomicI64::new(0),
            ui_current_op: Mutex::new(None),
            ui_heartbeat_active: AtomicBool::new(false),
            group_file_receivers: Mutex::new(HashMap::new()),
            inbound_gate: Mutex::new(()),
            group_file_sending: Mutex::new(std::collections::HashSet::new()),
            group_file_dispatching: Arc::new(Mutex::new(std::collections::HashSet::new())),
            group_file_boot_sweep_pending: std::sync::atomic::AtomicBool::new(true),
            group_file_online_targets: Mutex::new(HashMap::new()),
            file_sending: Mutex::new(std::collections::HashSet::new()),
            file_send_cancels: Mutex::new(HashMap::new()),
            file_receivers: Mutex::new(HashMap::new()),
            file_wire_progress: Mutex::new(HashMap::new()),
            pending_share_tree: Mutex::new(HashMap::new()),
            pending_group_history: Mutex::new(HashMap::new()),
            group_history_active: Mutex::new(std::collections::HashSet::new()),
            group_history_cancels: Mutex::new(std::collections::HashSet::new()),
            peers_dirty: AtomicBool::new(false),
            network_generation: AtomicU64::new(0),
            peers_notify: Arc::new(Notify::new()),
            peer_content_features: Mutex::new(HashMap::new()),
            peer_versions: Mutex::new(HashMap::new()),
            probe: Mutex::new(None),
            diag: Mutex::new(DiscoveryDiag::default()),
            app_active: AtomicBool::new(true),
            #[cfg(feature = "bluetooth")]
            ble_wake: Arc::new(Notify::new()),
            #[cfg(feature = "bluetooth")]
            ble_scan: Mutex::new(BleScanStats::default()),
            seen_hello_nonces: Mutex::new(VecDeque::new()),
            key_conflict_warned: Mutex::new(std::collections::HashSet::new()),
            pending_key_rotations: Mutex::new(HashMap::new()),
        }))
    }

    /// 当前网络世代号。
    pub fn network_generation(&self) -> u64 {
        self.network_generation.load(Ordering::Acquire)
    }

    /// 进入新世代（`start()` 成功后 / `stop()` 开始时调用）并返回新值。
    pub fn bump_network_generation(&self) -> u64 {
        self.network_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 读取中继授权配置（克隆一份：一次短锁 + 小结构体拷贝，热路径可接受）。
    ///
    /// ⚠️ 返回的是**快照**：调用方不要在持有它的时候再去读库（避免锁顺序纠缠）。
    pub fn relay_policy_config(&self) -> crate::mesh::relay_policy::RelayConfig {
        self.relay_policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 更新中继授权内存缓存（`save_settings` 写入设置后调用）。
    pub fn set_relay_policy_config(&self, cfg: crate::mesh::relay_policy::RelayConfig) {
        *self.relay_policy.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
    }

    /// 当前界面语言是否为中文。偏好存 settings.language（三态 system / zh-CN /
    /// en-US，由前端维护）；「跟随系统」时**先看前端推来的解析结果**，最后才用
    /// 环境变量兜底（判定规则与理由见 [`resolve_is_zh`]）。
    ///
    /// 偏好走内存缓存（审计 2.1i）：未加载时读库一次回填，此后零锁 ——
    /// 每段后端文案都调它，逐次抢全局 db 锁会在消息洪峰时加剧争用。
    pub fn is_zh(&self) -> bool {
        let pref = self.cached_lang_pref();
        resolve_is_zh(pref, self.ui_lang_hint(), system_lang_is_zh())
    }

    /// settings.language 的缓存值；未加载时读库一次回填（此后零锁）。
    fn cached_lang_pref(&self) -> Option<&'static str> {
        let code = self.lang_pref.load(Ordering::Acquire);
        if code == LANG_PREF_UNSET {
            let stored = {
                let dbc = self.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_setting(&dbc, "language")
            };
            let code = match stored.as_deref() {
                Some("system") => LANG_PREF_SYSTEM,
                Some("zh-CN") => LANG_PREF_ZH,
                Some("en-US") => LANG_PREF_EN,
                // 键不存在 / 历史脏值：resolve_is_zh 对它们本就按「跟随系统」处理
                _ => LANG_PREF_MISSING,
            };
            self.lang_pref.store(code, Ordering::Release);
            return lang_pref_str(code);
        }
        lang_pref_str(code)
    }

    /// save_settings 写入 language 后同步缓存（保持与库一致，见 [`Self::is_zh`]）。
    pub fn cache_lang_pref(&self, v: &str) {
        let code = match v {
            "system" => LANG_PREF_SYSTEM,
            "zh-CN" => LANG_PREF_ZH,
            "en-US" => LANG_PREF_EN,
            _ => LANG_PREF_MISSING,
        };
        self.lang_pref.store(code, Ordering::Release);
    }

    /// notify_enabled 的缓存读取；未加载时读库一次回填（每条通知判一次总开关，
    /// 逐次抢锁同属审计 2.1i 的热路径）。
    pub fn notify_enabled_cached(&self) -> bool {
        match self.notify_pref.load(Ordering::Acquire) {
            NOTIFY_PREF_ON => true,
            NOTIFY_PREF_OFF => false,
            _ => {
                let on = {
                    let dbc = self.db.lock().unwrap_or_else(|e| e.into_inner());
                    crate::notifications::notifications_enabled(&dbc)
                };
                self.cache_notify_enabled(on);
                on
            }
        }
    }

    /// save_settings 写入 notify_enabled 后同步缓存。
    pub fn cache_notify_enabled(&self, on: bool) {
        self.notify_pref.store(
            if on { NOTIFY_PREF_ON } else { NOTIFY_PREF_OFF },
            Ordering::Release,
        );
    }

    /// reset_settings 删除全部偏好键后：两个热路径缓存回到未加载态
    ///（下次读取从库回填默认值，而不是继续用被删掉的旧值）。
    pub fn invalidate_hot_setting_cache(&self) {
        self.lang_pref.store(LANG_PREF_UNSET, Ordering::Release);
        self.notify_pref.store(NOTIFY_PREF_UNSET, Ordering::Release);
    }

    /// 记录前端**解析后**的界面语言（`set_ui_language` 命令调用；见 [`Self::is_zh`]）。
    pub fn set_ui_language_hint(&self, lang: &str) {
        let v = if lang.starts_with("zh") {
            UI_LANG_ZH
        } else {
            UI_LANG_EN
        };
        self.ui_lang.store(v, Ordering::Relaxed);
    }

    /// 前端推来的解析结果；`None` = 还没推过（用环境变量兜底）。
    fn ui_lang_hint(&self) -> Option<bool> {
        match self.ui_lang.load(Ordering::Relaxed) {
            UI_LANG_ZH => Some(true),
            UI_LANG_EN => Some(false),
            _ => None,
        }
    }

    /// 应用显示名：中文系统「相闻」、英文系统 "Gosslan"。
    ///
    /// 用于独立窗口创建时的**初始标题**（文档标题就绪后由前端按语言接管，见
    /// `open_settings_window`）等后端自行生成的用户可见文案。
    // 移动端用不到后端生成的显示名（托盘/独立窗口标题都是桌面概念）⇒ 显式允许未使用
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn display_name(&self) -> String {
        if self.is_zh() {
            "小院儿".to_string()
        } else {
            "Gosslan".to_string()
        }
    }

    /// **本机自己的显示名**（「和自己聊天」里那个会话的名字，也用于把自己当发送者时的文案）。
    ///
    /// 为什么不能走 `resolve_nickname`：它只查好友表/在线节点表，自己两边都不在，
    /// 会回落到 `device_id` 原文 —— 会话列表里就会显示一串 `gosslan-xxxxxxxx`。
    pub fn self_display_name(&self) -> String {
        let n = self
            .nickname
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if !n.trim().is_empty() {
            return n;
        }
        // 昵称还没写进内存（极早期）时才用的兜底：与其它后端文案同口径（`is_zh`）。
        if self.is_zh() {
            "我".to_string()
        } else {
            "Me".to_string()
        }
    }

    /// 本机自己的头像（data URI，可能为空）。
    pub fn self_avatar(&self) -> Option<String> {
        self.avatar
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 记录一个 Hello nonce，返回 false 表示该 nonce 近期已出现过（重放）。
    ///
    /// 有界 FIFO（容量 `HELLO_NONCE_CACHE`）：握手是低频事件，线性查重成本可忽略；
    /// 不依赖墙上时钟，避免设备间时间偏差影响判定。
    pub fn accept_hello_nonce(&self, nonce: &str) -> bool {
        const HELLO_NONCE_CACHE: usize = 512;
        let mut q = self
            .seen_hello_nonces
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if q.iter().any(|n| n == nonce) {
            return false;
        }
        q.push_back(nonce.to_string());
        while q.len() > HELLO_NONCE_CACHE {
            q.pop_front();
        }
        true
    }

    /// 该 peer 是否至少有一条可用连接。
    ///
    /// **不要用 `links.contains_key` 代替**：Phase 6 起 `links` 的值是 `Vec`
    /// （一个 peer 可有多条连接），条目可能存在但 Vec 已空——此时 `contains_key`
    /// 仍返回 true，会误判为「已连接」。
    pub async fn has_link(&self, peer_id: &str) -> bool {
        self.links
            .lock()
            .await
            .get(peer_id)
            .is_some_and(|v| !v.is_empty())
    }

    /// 该 peer 是否已连到**指定端点**。
    ///
    /// 与 `has_link` 的区别：6b 起一个 peer 可有多条连接（LAN + Tailscale），
    /// 判断「要不要再拨号」必须**按端点**，而不是按 peer —— 否则永远只能建一条。
    pub async fn has_endpoint(&self, peer_id: &str, endpoint: &crate::mesh::Endpoint) -> bool {
        self.links
            .lock()
            .await
            .get(peer_id)
            .is_some_and(|v| v.iter().any(|l| l.endpoint == *endpoint))
    }

    /// 是否有**任意** peer 已连到指定端点（不看身份）。
    ///
    /// 用于「还不知道对端 device_id」的拨号去重：Routed 端点可以只填地址
    /// （身份由握手学来），此时拨号任务的 10s 重试无法按 peer 判断「是否已连上」，
    /// 只能按端点 —— 否则每轮都会重复建链。
    ///
    /// 方向性说明：主动方记录的 endpoint 是**对端的监听地址**（与配置一致）；
    /// 被动方记录的是对端拨入时的**临时源端口**，不会与配置地址相同，故不会误判。
    pub async fn has_endpoint_addr(&self, endpoint: &crate::mesh::Endpoint) -> bool {
        self.links
            .lock()
            .await
            .values()
            .flatten()
            .any(|l| l.endpoint == *endpoint)
    }

    /// 广播"设置已变更"给**除发起窗口外**的所有窗口（见 [`SettingsPatch`]）。
    ///
    /// `changed` 是"哪些键变了"（camelCase），`values` 是这些小键的**当前值**（由调用方在
    /// **持有 db 锁时**用 [`crate::commands::settings_patch_values`] 读好）—— 刻意不在这里
    /// 自己加锁：本函数被多个命令在"刚写完库"的位置调用，若内部再锁一次 `db`，
    /// 与那些仍持有锁的调用点会**直接死锁**（std Mutex 不可重入）。所以锁的边界留在调用方。
    pub fn notify_settings_changed(
        &self,
        changed: &[&str],
        origin: Option<&str>,
        values: serde_json::Value,
    ) {
        if changed.is_empty() {
            return;
        }
        let patch = SettingsPatch {
            changed: changed.iter().map(|k| (*k).to_string()).collect(),
            origin: origin.map(str::to_string),
            settings: values,
        };
        let origin = origin.map(str::to_string);
        let _ = self
            .app
            .emit_filter(EVENT_SETTINGS_CHANGED, patch, move |target| {
                // 发起窗口已经自己应用过了（而且它手里的值比库里更新）—— 绝不回发。
                event_target_label(target) != origin.as_deref()
            });
    }

    /// 广播"数据被清空了"：**除发起窗口外**的窗口要重建自己的列表（会话/消息/好友申请）。
    pub fn notify_data_cleared(&self, origin: Option<&str>) {
        let payload = serde_json::json!({ "origin": origin });
        let origin = origin.map(str::to_string);
        let _ = self
            .app
            .emit_filter(EVENT_DATA_CLEARED, payload, move |target| {
                event_target_label(target) != origin.as_deref()
            });
    }

    /// 广播"运行状态变了"——**带上完整快照**，且**不回发给发起窗口**（它在命令返回值里已经拿到了）。
    ///
    /// 与 ①（`settings-changed` 带补丁）同一个模式：快照由调用方用
    /// `commands::build_runtime_snapshot` 采好（那里同时要读 peers/network/transport 三种状态，
    /// 不适合塞进 `AppState` 自己），这里只负责"发给谁"。
    pub fn notify_runtime_changed(&self, snapshot: RuntimeSnapshot, origin: Option<&str>) {
        let origin = origin.map(str::to_string);
        let _ = self
            .app
            .emit_filter(EVENT_RUNTIME_CHANGED, snapshot, move |target| {
                event_target_label(target) != origin.as_deref()
            });
    }

    /// 标记节点表已变更，并唤醒节流推送任务。
    ///
    /// 500-1000 节点场景下，每秒会收到数百条 `announce`/`heartbeat`，若每次
    /// 都全量序列化节点表并推给前端会拖垮 IPC。这里改为「置脏 + 通知」，
    /// 由 `spawn_peer_emitter` 在约 300ms 合并窗口内最多推送一次。
    pub fn emit_peers(&self) {
        self.peers_dirty.store(true, Ordering::SeqCst);
        self.peers_notify.notify_one();
    }

    /// 实际序列化并推送节点表（仅由节流任务调用）。
    fn emit_peers_now(&self) {
        let mut peers: Vec<Peer> = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        // 顺带补上"这个节点此刻有没有活跃链路 + 走哪条路"（link 字段）。
        //
        // 为什么必须带上：前端原来只按"在不在节点表"判在线，于是「链路活着、但广播没收到
        // （被防火墙/组播限制吞掉）或刚被 sweep」的好友会显示离线，而后端 get_friends 的
        // friend_is_online 却认为在线 ⇒ 用户看到"局域网都连上了，在线状态却不实时"。
        // try_lock：拿不到锁（网络任务正忙）就照旧发推送，不能让统计阻塞网络。
        if let Ok(links) = self.links.try_lock() {
            for p in peers.iter_mut() {
                if let Some(list) = links.get(&p.device_id) {
                    if list.is_empty() {
                        continue;
                    }
                    let kinds: Vec<crate::mesh::PathKind> =
                        list.iter().map(|l| l.path_kind).collect();
                    p.link = best_link_kind(&kinds).map(|k| k.as_str().to_string());
                }
            }
        }
        let _ = self.app.emit("peers-updated", peers);
    }

    /// 记录一条网络诊断事件 —— **直接进运行日志**（用户 2026-09-13 要求）。
    ///
    /// ## 为什么不再用独立 ring buffer
    ///
    /// 原来这里只把事件塞进一个"最近 50 条"的内存环形缓冲，只有隐藏的开发者面板能看，
    /// 用户能贴出来的「运行日志」里一个字都没有 —— 让这两处数据各活各的，等于白记。
    /// 现在统一进 `Logger`：可搜索、可复制、可落盘。
    ///
    /// ## 哪些留、哪些丢（不是无脑全打）
    ///
    /// 日志规范（见 `logging.rs` 顶部）明确要求**不记高频循环**。这里的调用点里，
    /// `announce_recv` 每收一个节点广播一条（秒级）、`broadcast_sent` / `multicast_sent`
    /// 每 10s 一条 —— 全打进去会在几分钟内把 500 条内存 buffer 冲干净，真问题反而被淹没。
    /// 所以只把**有排查价值的异常/状态跃迁**落日志，纯心跳成功事件直接丢弃：
    ///
    /// | kind | 去留 |
    /// |---|---|
    /// | `discovery_started` | 留（info，一次性状态跃迁） |
    /// | `broadcast_error` 等 `*_error` | 留（warn） |
    /// | `hello_rejected` / `hello_mismatch` / `identity_key_conflict` | **丢** —— 见下 |
    /// | `announce_recv` / `*_sent` | **丢**（高频心跳，没有排查价值） |
    ///
    /// 后一类「丢」不是漏了：它们的**每一个调用点旁边都已经有一条更完整的 `logger.warn`**
    /// （`transport.rs` 的「拒绝未通过身份认证的 Hello: …」「握手身份不符：…」「握手验签失败：…」，
    /// 以及 `warn_key_conflict_once`）。在这里再打一遍只会让日志出现成对的近似重复行 ——
    /// 用户的诉求是「别单开一块，进日志里」，而这些本来就在日志里。
    pub fn push_diag_event(&self, kind: &str, detail: &str) {
        const DROPPED: &[&str] = &[
            // 纯心跳（高频，且没有排查价值）
            "announce_recv",
            "broadcast_sent",
            "multicast_sent",
            "who_has_sent",
            // 已在各自的调用点旁边用更完整的上下文记过（重复打只会刷屏）
            "hello_rejected",
            "hello_mismatch",
            "identity_key_conflict",
        ];
        // 子网广播的**成功**必须留痕：真机排查「局域网只通一半」时，
        // 「这条到底发出去没有」是区分"发不出去"与"发出去了但对方没收到"的唯一证据。
        // 其余 `*_sent` 仍按高频丢弃（见 DROPPED）。
        if kind != "bc_directed_sent" && DROPPED.contains(&kind) {
            return;
        }
        let message = format!("diag/{kind}: {detail}");
        if kind.ends_with("_error") {
            self.logger.warn("discovery", message);
        } else {
            self.logger.info("discovery", message);
        }
    }

    /// 启动节点表节流推送任务（合并高频更新，避免 IPC 风暴）。
    /// 返回句柄：交给 `worker_supervisor` 判活（R-05），别在这里丢弃。
    pub fn spawn_peer_emitter(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
        let st = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                st.peers_notify.notified().await;
                // 合并窗口：窗口内的所有变更只触发一次推送
                tokio::time::sleep(Duration::from_millis(300)).await;
                if st.peers_dirty.swap(false, Ordering::SeqCst) {
                    st.emit_peers_now();
                }
            }
        })
    }

    /// 周期性重放单聊/群聊离线队列。
    ///
    /// A-17（2026-10-19）：`flush_outbox` 只在建链/Hello 触发，且 `try_send` 的错误被忽略；
    /// 多链路并发建链时那一窗口里没真正发出去的消息，会一直停在 `sending`/outbox 里，
    /// 直到下一次链路事件——实测 30s 内没有。这里每 5s 对**当前有链路**的 peer 重放一次；
    /// 收端按 `msg_id` 幂等去重，只有 Ack/GroupAck 才删行，所以重复发送不会重复入库/通知。
    /// 文件队列不在这里重放：它有自己的 attempts/退避与 5 次上限（`flush_pending_files`）。
    pub fn spawn_outbox_retrier(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
        let st = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(OUTBOX_RETRY_SECS)).await;
                let peers: Vec<String> = {
                    let links = st.links.lock().await;
                    links.keys().cloned().collect()
                };
                for peer in peers {
                    crate::network::transport::flush_outbox(&st, &peer).await;
                    crate::network::transport::flush_group_outbox(&st, &peer).await;
                    // 文件队列也必须**周期**补发（2026-10-22 e2e：14/27，红的全在异常/恢复路径）。
                    //
                    // 此前 `flush_pending_files` 只挂在"建链事件"上（Hello / 拨号成功 / BLE 连上），
                    // 于是对端重启、冻结、或目录只读恢复之后，`file_outbox` 里已入队的行**没有任何
                    // 东西**会再把它们送出去 —— 只能等下一次建链，或者等 30min 的
                    // `FILE_OUTBOX_FAIL_DEADLINE_MS` 判死。用户看到的就是"传了一半，重启后永远不动"。
                    //
                    // 与上面两条同频（5s）：队列空时只是一次 `list_outbox` 级的读，开销与
                    // `flush_outbox` 同一个量级；不能因为"怕 IO"再留一条只靠事件驱动的路。
                    crate::commands::flush_pending_files(&st, &peer).await;
                }
            }
        })
    }

    /// 周期性运行态快照：**这是"拖垮其它 WebView 应用"那类故障的现场取样器**。
    ///
    /// 没有它，用户说"开久了把别的程序也带崩了"时，我们手上只有崩溃那一刻的空文件：
    /// 无法回答窗口是不是在泄漏、链路/队列是不是在增长。这里每 5 分钟留一行**有界、脱敏**
    /// 的读数：WebView 窗口数/隐藏数、在线节点、连接数、sending 消息数、三张 outbox 行数。
    /// 只记数字与 label，不记消息正文、文件名、密钥或地址。
    ///
    /// 内存那一格（`mem_diag.rs`）从 2026-10-26 起**在同一行里**：工作集/私有提交量/
    /// 系统还能提交多少/GDI·USER 句柄/正在读的帧字节聚合。以前这里写的是"刻意不读 RSS"，
    /// 理由是要新增依赖或 fork 命令 —— 那条理由站不住（两个 crate 都在 Cargo.lock 里），
    /// 而它的后果是两次崩溃都指认不出吃内存的是谁。结构无界增长与内存无界增长是同一个问题的
    /// 两面，现在一行里同时能看。
    pub fn spawn_runtime_diag_reporter(
        state: &Arc<AppState>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let st = state.clone();
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(RUNTIME_DIAG_SECS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let windows: Vec<(String, bool)> = st
                    .app
                    .webview_windows()
                    .into_iter()
                    .map(|(label, win)| {
                        let visible = win.is_visible().unwrap_or(false);
                        (label, visible)
                    })
                    .collect();
                let hidden = windows.iter().filter(|(_, visible)| !*visible).count();
                let labels = windows
                    .iter()
                    .map(|(label, visible)| {
                        format!("{label}:{}", if *visible { "shown" } else { "hidden" })
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                let peer_count = st.peers.lock().unwrap_or_else(|e| e.into_inner()).len();
                let link_count: usize = st
                    .links
                    .lock()
                    .await
                    .values()
                    .filter(|v| !v.is_empty())
                    .count();
                let counts = st.runtime_counts();
                let (sending, outbox, group_outbox, file_outbox) = (
                    counts.sending_msgs,
                    counts.outbox,
                    counts.group_outbox,
                    counts.file_outbox,
                );
                // ★ 这一格里**有**内存读数了（2026-10-26）：原来这里明写"刻意不读 RSS"，
                //   理由是"要新增平台依赖/外部命令" —— 现算不成立（`windows-sys`、`libc`
                //   早在 Cargo.lock 里），而代价是两次死法都指认不出谁吃的内存
                //   （10-21 分配钩子只差 318 KB；10-26 主线程与渲染层同一秒双双停滞）。
                //   采样只在这 5 分钟一格，热路径一律不采；读数拿不到就写 `-`，不折 0。
                let mem = crate::mem_diag::sample();
                crate::mem_diag::remember(&mem);
                // 快线：系统还能提交的量真的低于阈值时，**当场**在现场文件里留一行。
                // 为什么不等 5 分钟那一格：10-21 那次的签名是"下一个 318 KB 都拿不到"，
                // 而临界的几分钟里没有任何留痕 ⇒ 回头看只有"崩了"。这条上界 = 每格一条
                // （跟着快照的 5 分钟周期走，不会自己刷屏），读不到数值的平台永不点亮。
                // 每格都把同一行**也**写进不轮转的现场文件：`gosslan.log` 超 512 KiB 就转、
                // 而且只留一代 —— 10-16 那次就是几分钟把现场刷没了。而"崩之前那 20 分钟的走势"
                // 恰恰只有被外部拿走（没有 panic 钩子、没有分配失败钩子）那种死法还查得到的唯一证据。
                // 量是有界的：一格一行 ≈ 200 字节，每 5 分钟一条 ⇒ 现场文件 2 MiB 上限约 35 天一整轮重开。
                crate::logging::crash_note(&format!(">>> code=RUNTIME_MEM {}", mem.line()));
                if crate::mem_diag::under_commit_pressure(&mem) {
                    st.logger
                        .warn("runtime", format!("code=COMMIT_PRESSURE {}", mem.line()));
                    crate::logging::crash_note(&format!(">>> code=COMMIT_PRESSURE {}", mem.line()));
                }
                st.logger.info(
                    "runtime",
                    format!(
                        "code=RUNTIME_SNAPSHOT windows={} hidden={hidden} labels=[{labels}] \
                         peers={peer_count} links={link_count} sending_msgs={sending} \
                         outbox={outbox} group_outbox={group_outbox} file_outbox={file_outbox} \
                         {}",
                        windows.len(),
                        mem.line()
                    ),
                );
            }
        })
    }

    /// 队列与在途读数：全仓**唯一一份**取这几个计数的地方（10-22 审计 R-30）。
    ///
    /// 之前这组 SQL 只活在 `RUNTIME_SNAPSHOT` 那行日志里 ⇒ 界面零入口：
    /// 用户说"卡住了"的时候，没有任何自助办法区分「队列积压」「链路没了」「db 在排队」。
    /// 新命令 `get_runtime_diag` 与那行日志都读这一个方法 —— 抄第二份 SQL 就是
    /// 第二条会各自漂移的平行实现（本仓在 BLE 常量上为这个付过连续四版的学费）。
    ///
    /// 一次持 db 锁读完四条，不逐条抢锁；读失败返回 -1（"不知道"而不是"0 条积压"）。
    pub fn runtime_counts(&self) -> RuntimeCounts {
        let dbc = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let one = |sql: &str| -> i64 { dbc.query_row(sql, [], |r| r.get(0)).unwrap_or(-1) };
        RuntimeCounts {
            sending_msgs: one("SELECT COUNT(*) FROM messages WHERE status = 'sending'"),
            outbox: one("SELECT COUNT(*) FROM outbox"),
            group_outbox: one("SELECT COUNT(*) FROM group_outbox WHERE status = 'pending'"),
            file_outbox: one("SELECT COUNT(*) FROM file_outbox"),
        }
    }

    /// 好友 device_id 集合 —— "是不是好友"这件事的唯一读出口。
    ///
    /// 为什么要有这个方法（审计 R-04）：超时清扫需要按好友豁免，而 `db::list_friends`
    /// 那份口径在 `get_pending_requests` 里已经有一份了。判据是同一个判断就必须收在同一个家，
    /// 否则两张"好友名单"会各自漂移；同时把 network 域对 persistence 的一次内联跨域引用
    /// 收回成 `state` 上的一次方法调用（领域依赖方向棘轮会盯着内联 `crate::` 的那条路）。
    ///
    /// 返回 `Option`：读不出来是 `None` 而**不是空集合** —— 空集合在调用方那儿读起来是
    /// "这台机器一个好友都没有"，会让清扫把好友的身份信任根一起打掉。
    pub fn friend_ids(&self) -> Option<std::collections::HashSet<String>> {
        let dbc = self.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::list_friends(&dbc) {
            Ok(list) => Some(list.into_iter().map(|f| f.device_id).collect()),
            Err(_) => None,
        }
    }

    /// 周期性把 SQLite 锁观测摘要写进运行日志。
    ///
    /// `DbLock` 已经逐次量了 wait/hold，但 `take_summary()` 此前只有测试在读 ⇒ 现场
    /// 看不到"谁握了多久、排队多久"。这里做**唯一生产读者**（两个读者会互相吞计数）；
    /// 空窗口不产行，只有慢持锁（默认 ≥500ms）才 warn 一行，数字里不含 SQL/正文。
    pub fn spawn_db_hold_reporter(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
        let st = state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(DB_HOLD_REPORT_SECS)).await;
                let summary = st.db.take_summary();
                if let Some(line) =
                    crate::db_hold::summary_line(&summary, st.db.slow_threshold_ms())
                {
                    st.logger.warn("db", line.clone());
                    // 同一行留一份给界面读数（R-30 / D-16 的「DB 锁」那一节）。
                    // ⚠️ 这里必须是**唯一读者的下游**：诊断面板不许自己再 `take_summary()` ——
                    // 两个读者互相吞计数就是今天刚摘掉的那条（判据见 `db_hold.rs`）。
                    *st.db_hold_note.lock().unwrap_or_else(|e| e.into_inner()) = Some(line);
                }
            }
        })
    }
}

/// 锁观测摘要的周期（秒）。只在有慢持锁时产出一行，正常窗口零噪声。
const DB_HOLD_REPORT_SECS: u64 = 60;

/// 离线队列重放周期（秒），与心跳同量级；A-17。
const OUTBOX_RETRY_SECS: u64 = 5;

/// 运行态快照周期（秒）。5 分钟一行，日志轮转上界（512 KiB）下可保留数天趋势。
const RUNTIME_DIAG_SECS: u64 = 300;

/// 队列与在途计数（见 `AppState::runtime_counts`）。
///
/// 字段名与前端 `RuntimeDiag` 一一对应（serde 转 camelCase）—— 快照类结构体的口径
/// 一直靠"逐字对应"这条约定，改字段必须同批改 `src/types.ts`，否则界面读到 `undefined`。
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCounts {
    pub sending_msgs: i64,
    pub outbox: i64,
    pub group_outbox: i64,
    pub file_outbox: i64,
}

/// 解析多开实例号：优先 `--instance N` / `-i N` 启动参数，其次 `GOSSLAN_INSTANCE` 环境变量。
/// 返回 0 表示默认单实例。
pub(crate) fn instance_id() -> u32 {
    let args: Vec<String> = std::env::args().collect();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--instance" || a == "-i" {
            if let Some(v) = it.next().and_then(|s| s.parse::<u32>().ok()) {
                return v;
            }
        }
    }
    std::env::var("GOSSLAN_INSTANCE")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        load_or_create_identity, resolve_is_zh, StartupError, UI_LANG_EN, UI_LANG_UNKNOWN,
        UI_LANG_ZH,
    };
    use rusqlite::Connection;

    /// 界面语言判定的优先级：**显式偏好 > 前端推来的解析结果 > 环境变量兜底**。
    ///
    /// 为什么必须钉住（用户 2026-09-16 实测「加群的提示怎么是英文？」）：
    /// 「跟随系统」的解析规则（`navigator.language`）只在前端有一份，而后端的兜底在
    /// Windows 上恒为「否」—— 少了中间那一层，中文用户在默认设置下会看到英文的系统消息
    /// （群成员变更 / 文件下载 / 托盘提示 / 窗口标题），而界面本身是中文。
    #[test]
    fn ui_language_prefers_preference_then_frontend_hint_then_env() {
        // ① 显式偏好最高：不受前端与系统影响
        assert!(resolve_is_zh(Some("zh-CN"), Some(false), false));
        assert!(!resolve_is_zh(Some("en-US"), Some(true), true));
        // ② 「跟随系统」：前端推来的结果说了算（环境兜底在 Windows 上是错的，不能盖过它）
        assert!(resolve_is_zh(Some("system"), Some(true), false));
        assert!(!resolve_is_zh(Some("system"), Some(false), true));
        // ③ 前端还没推过：才用环境变量兜底
        assert!(resolve_is_zh(None, None, true));
        assert!(!resolve_is_zh(None, None, false));
        // ④ 历史脏值一律按「跟随系统」处理（与前端 isLanguagePreference 同口径）
        assert!(resolve_is_zh(Some("fr-FR"), Some(true), false));
        assert!(!resolve_is_zh(Some(""), None, false));
    }

    /// 三态编码不许撞车（0 是"还没推过"的哨兵，不能被当成某种语言）。
    #[test]
    fn ui_language_hint_states_are_distinct() {
        assert_ne!(UI_LANG_UNKNOWN, UI_LANG_ZH);
        assert_ne!(UI_LANG_UNKNOWN, UI_LANG_EN);
        assert_ne!(UI_LANG_ZH, UI_LANG_EN);
    }

    /// `message-received` 实际投递出去的那份 JSON：**记录逐项都还在**（前端整条时间线靠它渲染，
    /// flatten 写错会静默丢字段），并且多出一个 `mention_ids`。
    ///
    /// 为什么值得单独钉：这条形状只被 `network/transport/gossip.rs` 一处用到，前端又是按
    /// 属性名读的 —— 名字漂了（`mention_ids` vs `mentions`）两侧都不会报错，表现是
    /// 「@ 了我不亮」，正是本格修的那类"判不到根"的缺陷。
    #[test]
    fn incoming_message_flattens_the_record_and_carries_three_state_mentions() {
        use super::{IncomingMessage, MessageRecord};
        let rec = MessageRecord {
            id: 7,
            msg_id: "m1".to_string(),
            conv_id: "group:g1".to_string(),
            sender_id: "dev-a".to_string(),
            receiver_id: "g1".to_string(),
            kind: "text".to_string(),
            content: "@周工 看下".to_string(),
            ts: 10,
            seq: 11,
            status: "delivered".to_string(),
            mention_targets: None,
            local_id: None,
        };
        let ids = vec!["dev-b".to_string()];
        let with: serde_json::Value = serde_json::to_value(IncomingMessage {
            record: &rec,
            mention_ids: Some(&ids),
            mention_targets: None,
        })
        .unwrap();
        assert_eq!(with.get("msg_id").and_then(|v| v.as_str()), Some("m1"));
        assert_eq!(with.get("seq").and_then(|v| v.as_i64()), Some(11));
        assert_eq!(
            with.get("status").and_then(|v| v.as_str()),
            Some("delivered")
        );
        assert_eq!(with.get("mention_ids"), Some(&serde_json::json!(["dev-b"])));
        // None ⇒ `null` 而不是把键省掉：前端两种都当"不知道"，但这条要写在类型上，
        // 键在不在不该靠序列化器的默认行为猜。
        let none: serde_json::Value = serde_json::to_value(IncomingMessage {
            record: &rec,
            mention_ids: None,
            mention_targets: None,
        })
        .unwrap();
        assert_eq!(none.get("mention_ids"), Some(&serde_json::Value::Null));
        assert_eq!(
            none.get("content").and_then(|v| v.as_str()),
            Some("@周工 看下")
        );
    }

    // ---------------- 身份加载安全边界（2026-10-20 P0 回归） ----------------

    fn settings_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')",
        )
        .unwrap();
        conn
    }

    fn secret(conn: &Connection, key: &str) -> Option<String> {
        crate::db::get_setting_checked(conn, key).unwrap()
    }

    /// 正控：空库首次安装只生成一次；第二次加载必须拿回**同一套**密钥。
    #[test]
    fn first_install_generates_identity_once_and_later_loads_the_same_keys() {
        let conn = settings_db();
        let (id, generated) = load_or_create_identity(&conn, false).unwrap();
        assert!(generated, "空库首次安装应当生成身份");
        assert!(secret(&conn, "x25519_secret").is_some());
        assert!(secret(&conn, "ed25519_secret").is_some());

        let (again, generated_again) = load_or_create_identity(&conn, true).unwrap();
        assert!(!generated_again, "已有密钥时必须走持久化加载");
        assert_eq!(id.x25519_secret_b64(), again.x25519_secret_b64());
        assert_eq!(
            id.ed25519_signing.to_bytes(),
            again.ed25519_signing.to_bytes()
        );
    }

    /// **核心回归**：已有安装 + 密钥缺失/只有一条 ⇒ 中止，且一个字节都不写。
    #[test]
    fn existing_install_never_regenerates_missing_or_partial_keys() {
        let none = settings_db();
        match load_or_create_identity(&none, true) {
            Err(StartupError::IdentityIncomplete { .. }) => {}
            Ok(_) => panic!("两条密钥都缺失时必须中止，实得 Ok"),
            Err(e) => panic!("两条密钥都缺失时必须中止，实得 {e:?}"),
        }
        assert_eq!(secret(&none, "x25519_secret"), None, "不许偷偷写入新密钥");
        assert_eq!(secret(&none, "ed25519_secret"), None);

        let partial = settings_db();
        crate::db::set_setting(&partial, "x25519_secret", "kept-x").unwrap();
        match load_or_create_identity(&partial, true) {
            Err(StartupError::IdentityIncomplete { .. }) => {}
            Ok(_) => panic!("只有一条密钥时必须中止，实得 Ok"),
            Err(e) => panic!("只有一条密钥时必须中止，实得 {e:?}"),
        }
        assert_eq!(
            secret(&partial, "x25519_secret"),
            Some("kept-x".to_string()),
            "残缺时必须保留原件，不许覆盖"
        );
        assert_eq!(secret(&partial, "ed25519_secret"), None);
    }

    /// 密钥损坏 ⇒ 中止且保留原值；绝不用新身份覆盖（否则好友绑定与历史密文永久失配）。
    #[test]
    fn corrupt_keys_abort_without_overwriting_them() {
        let conn = settings_db();
        crate::db::set_setting(&conn, "x25519_secret", "not-base64!!").unwrap();
        crate::db::set_setting(&conn, "ed25519_secret", "also-bad!!").unwrap();
        match load_or_create_identity(&conn, true) {
            Err(StartupError::IdentityCorrupt) => {}
            Ok(_) => panic!("损坏密钥必须报 IdentityCorrupt，实得 Ok"),
            Err(e) => panic!("损坏密钥必须报 IdentityCorrupt，实得 {e:?}"),
        }
        assert_eq!(
            secret(&conn, "x25519_secret"),
            Some("not-base64!!".to_string())
        );
        assert_eq!(
            secret(&conn, "ed25519_secret"),
            Some("also-bad!!".to_string())
        );
    }

    /// 读库失败（没有 settings 表）必须报 `IdentityRead`，**不是**"键不存在 ⇒ 生成新身份"。
    /// 这条就是旧实现最致命的那个折返点，用真实 SQL 错误钉住。
    #[test]
    fn read_failure_is_not_mistaken_for_a_first_install() {
        let broken = Connection::open_in_memory().unwrap();
        match load_or_create_identity(&broken, true) {
            Err(StartupError::IdentityRead { .. }) => {}
            Ok(_) => panic!("读库失败必须报 IdentityRead，实得 Ok"),
            Err(e) => panic!("读库失败必须报 IdentityRead，实得 {e:?}"),
        }
        // 即便 existing_install=false（例如文件刚被创建但读不了），也不许把读失败当首次安装
        match load_or_create_identity(&broken, false) {
            Err(StartupError::IdentityRead { .. }) => {}
            Ok(_) => panic!("读库失败在首次安装分支同样必须中止，实得 Ok"),
            Err(e) => panic!("读库失败在首次安装分支同样必须中止，实得 {e:?}"),
        }
    }

    /// 新密钥写不进库 ⇒ 中止，不许"内存里先用一套、下次启动再换一套"。
    #[test]
    fn persist_failure_aborts_instead_of_running_with_an_ephemeral_identity() {
        let conn = settings_db();
        conn.execute_batch(
            "CREATE TRIGGER block_secret_write BEFORE INSERT ON settings
             BEGIN SELECT RAISE(ABORT, 'simulated io failure'); END;",
        )
        .unwrap();
        match load_or_create_identity(&conn, false) {
            Err(StartupError::IdentityPersist { .. }) => {}
            Ok(_) => panic!("写入失败必须中止，实得 Ok"),
            Err(e) => panic!("写入失败必须中止，实得 {e:?}"),
        }
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "失败后不许留下半套密钥");
    }

    /// 文件级判据：**已有安装 + 身份损坏 ⇒ 数据库文件逐字节不变**。
    ///
    /// 上面几条证明的是"设置表里还是原值"；这一条直接对**磁盘上的真实库**取 SHA-256。
    /// 为什么值得单独一条：失败路径里除密钥之外还有别的写（孤儿 sending 落终态、文件队列
    /// 重置、昵称/设备标识迁移），值级断言看不见那些；而哈希能证明这次失败**一个字节都没动**。
    /// 用的是真实 `db::init`（真 schema + WAL），不是内存库。
    #[test]
    fn identity_failure_leaves_the_database_file_byte_for_byte_unchanged() {
        use sha2::{Digest, Sha256};
        let dir = std::env::temp_dir().join(format!(
            "gosslan-identity-hash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gosslan.db");
        {
            let conn = crate::db::init(&path).unwrap();
            crate::db::set_setting(&conn, "device_id", "gosslan-keepme01").unwrap();
            crate::db::set_setting(&conn, "x25519_secret", "not-base64!!").unwrap();
            crate::db::set_setting(&conn, "ed25519_secret", "also-bad!!").unwrap();
        } // 关闭连接 ⇒ 收尾 checkpoint 在这一行结束前完成（哈希在它之后取）
        let digest = |p: &std::path::Path| -> String {
            let bytes = std::fs::read(p).unwrap();
            let mut h = Sha256::new();
            h.update(&bytes);
            format!("{:x}", h.finalize())
        };
        let before = digest(&path);
        {
            let conn = Connection::open(&path).unwrap();
            match load_or_create_identity(&conn, true) {
                Err(StartupError::IdentityCorrupt) => {}
                Ok(_) => panic!("损坏密钥必须中止，实得 Ok"),
                Err(e) => panic!("损坏密钥必须报 IdentityCorrupt，实得 {e:?}"),
            }
        }
        assert_eq!(
            digest(&path),
            before,
            "身份加载失败后数据库文件被改写了 —— 这类改动正是「崩溃后变成新用户」的起点"
        );
        // 自证：哈希必须能看见一次**真实写入**，否则上面那条在"根本没读到文件"时也会绿
        // （这就是判据自等：一个永远相等的比较等于没断言）。
        {
            let conn = Connection::open(&path).unwrap();
            crate::db::set_setting(&conn, "device_id", "gosslan-changed").unwrap();
        }
        assert_ne!(
            digest(&path),
            before,
            "哈希看不见一次真实写入 ⇒ 上面那条『逐字节不变』是空转"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 用户提示必须写清"没有生成/覆盖"与错误码，且路径可操作。
    #[test]
    fn startup_error_message_is_actionable_and_names_the_code() {
        let msg = StartupError::IdentityCorrupt.user_message(std::path::Path::new("/data/gosslan"));
        assert!(msg.contains("IDENTITY_CORRUPT"), "{msg}");
        assert!(msg.contains("没有覆盖旧密钥"), "{msg}");
        // ⚠️ 路径分隔符必须**按平台算**（2026-10-21 CI 抓到的真实跨平台红）：
        // 消息里那段是用 `Path::join("logs")` 拼的（Windows 上是 `\logs`），
        // 而断言写死了 POSIX 形状 ⇒ 只有 Windows 那一腿红，本机永远绿。
        // 断言必须用**同一个拼法**，否则这条判据在 Windows 上是假红。
        let logs_dir = std::path::Path::new("/data/gosslan").join("logs");
        assert!(
            msg.contains(&logs_dir.to_string_lossy().to_string()),
            "{msg}"
        );
    }
}
