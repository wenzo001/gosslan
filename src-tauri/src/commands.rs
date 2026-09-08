//! Tauri 命令层：前端调用的所有后端入口。

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

/// 业务输入长度限制（按字符数，非字节数）
const MAX_NICKNAME_LEN: usize = 30;
pub const MAX_GROUP_NAME_LEN: usize = 30;
const MAX_SEARCH_LEN: usize = 100;
const MAX_MESSAGE_LEN: usize = 50_000;
/// 内联图片（`kind:"image"`）的 data URL 是 Base64：从中间截断会直接损坏图片，
/// 故不参与 MAX_MESSAGE_LEN 的文本截断。这里给一个"合理上限"而非无限放行——
/// Base64 解码后 ≈ 3/4 字符数，8M 字符 ≈ 6 MiB 原图，封框（ChaCha20+Base64）后仍
/// 远低于传输层 MAX_FRAME(64 MiB)。超限一律报错拒发，绝不静默截断。
const MAX_IMAGE_CONTENT_LEN: usize = 8_000_000;

use crate::crypto;
use crate::db;
use crate::network::transport::{
    broadcast_gossip, get_group_key, mark_pending_group_key, maybe_update_friend,
    resolve_member_x25519, resolve_nickname, try_send,
};
use crate::network::{self, file};
use crate::protocol::{GossipKind, Message, MsgKind, ShareEntry};
use crate::relay_manager::ChunkData;
use crate::state::{
    AppState, Conversation, DeviceInfo, Friend, Group, InterfaceInfo, MessageRecord, Peer,
    PendingRequest, TopologyInfo, TransferInfo,
};
use crate::storage::cache_cleaner::{self, CachePolicy, CleanupReport};
use crate::transport::{ChannelStatus, TransportManager};

#[derive(Serialize)]
pub struct NetworkStatus {
    online: bool,
    bound_ip: Option<String>,
}

/// 缓存目录占用与策略（存储管理页展示）。
#[derive(Serialize)]
pub struct CacheInfo {
    file_count: usize,
    total_bytes: u64,
    retention_days: Option<u32>,
    max_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct GroupReadInfo {
    pub reader_id: String,
    pub last_read_ts: i64,
}

// ---------------- 本机信息与配置 ----------------

#[tauri::command]
pub fn get_device_info(state: State<'_, Arc<AppState>>) -> DeviceInfo {
    let s = state.inner();
    DeviceInfo {
        device_id: s.device_id.clone(),
        nickname: s.nickname.lock().unwrap().clone(),
        avatar: s.avatar.lock().unwrap().clone(),
        tcp_port: s.tcp_port,
        online: s.network.lock().unwrap().is_some(),
        x25519_pubkey: s.identity.x25519_public_b64(),
        ed25519_pubkey: s.identity.ed25519_public_b64(),
    }
}

#[tauri::command]
pub async fn update_profile(
    state: State<'_, Arc<AppState>>,
    nickname: String,
    avatar: Option<String>,
) -> Result<DeviceInfo, String> {
    let s = state.inner();
    // 昵称长度保护：按字符截断（UTF-8 安全）
    let nickname: String = nickname.chars().take(MAX_NICKNAME_LEN).collect();
    {
        let dbc = s.db.lock().unwrap();
        db::set_setting(&dbc, "nickname", &nickname).map_err(|e| e.to_string())?;
        if let Some(a) = &avatar {
            db::set_setting(&dbc, "avatar", a).map_err(|e| e.to_string())?;
        }
    }
    *s.nickname.lock().unwrap() = nickname.clone();
    *s.avatar.lock().unwrap() = avatar.clone();

    let msg = Message::UserInfo {
        device_id: s.device_id.clone(),
        nickname,
        avatar,
    };
    let links = s.links.lock().await;
    for tx in links.values() {
        let _ = tx.send(msg.clone()).await;
    }
    drop(links);

    Ok(DeviceInfo {
        device_id: s.device_id.clone(),
        nickname: s.nickname.lock().unwrap().clone(),
        avatar: s.avatar.lock().unwrap().clone(),
        tcp_port: s.tcp_port,
        online: s.network.lock().unwrap().is_some(),
        x25519_pubkey: s.identity.x25519_public_b64(),
        ed25519_pubkey: s.identity.ed25519_public_b64(),
    })
}

/// 判断 IPv4 是否为常见 VPN / Clash / 虚拟网卡地址段。
///
/// 保守策略：只过滤**几乎不可能出现在真实局域网**的地址段；
/// 10.x.x.x 等模糊段不纳入过滤（真实 LAN 广泛使用 10/8）。
pub fn is_virtual_ip(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    // 198.18.0.0/15 — Clash / sing-box / v2ray fake-ip 段
    (o[0] == 198 && (o[1] == 18 || o[1] == 19))
    // 100.64.0.0/10 — WireGuard / CGNAT / Tailscale 常用段
    || (o[0] == 100 && o[1] >= 64 && o[1] <= 127)
    // 169.254.0.0/16 — link-local
    || (o[0] == 169 && o[1] == 254)
}

#[tauri::command]
pub fn list_interfaces() -> Vec<InterfaceInfo> {
    let mut out = Vec::new();
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for i in &ifs {
            if let if_addrs::IfAddr::V4(v4) = &i.addr {
                let ip = match i.ip() {
                    std::net::IpAddr::V4(v) => v,
                    _ => continue,
                };
                if ip.is_loopback() {
                    continue;
                }
                // is_lan：有广播地址（真实 LAN 的标志）+ 非 link-local + 非 VPN 地址段
                let has_broadcast = v4.broadcast.is_some();
                let is_link_local = ip.octets()[0] == 169 && ip.octets()[1] == 254;
                let not_vpn = !is_virtual_ip(&ip);
                let is_lan = has_broadcast && !is_link_local && not_vpn;
                out.push(InterfaceInfo {
                    name: i.name.clone(),
                    ip: ip.to_string(),
                    is_lan,
                });
            }
        }
    }
    out.sort_by(|a, b| a.ip.cmp(&b.ip));
    out
}

// ---------------- 网络控制 ----------------

#[tauri::command]
pub async fn start_network(state: State<'_, Arc<AppState>>, bind_ip: String) -> Result<(), String> {
    let arc = state.inner().clone();
    network::start(arc, bind_ip).await?;
    let dbc = state.db.lock().unwrap();
    db::set_lan_enabled(&dbc, true).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn stop_network(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    network::stop(state.inner()).await;
    let dbc = state.db.lock().unwrap();
    db::set_lan_enabled(&dbc, false).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_network_status(state: State<'_, Arc<AppState>>) -> NetworkStatus {
    let s = state.inner();
    let net = s.network.lock().unwrap();
    NetworkStatus {
        online: net.is_some(),
        bound_ip: net.as_ref().map(|n| n.bound_ip.clone()),
    }
}

#[tauri::command]
pub fn get_peers(state: State<'_, Arc<AppState>>) -> Vec<Peer> {
    let mut peers: Vec<Peer> = state
        .inner()
        .peers
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    peers.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    peers
}

/// 按需探测周围在线节点：群发一次 `who_has`，等待约 1.5s 收集单播回复后返回当前节点表。
/// 仅在用户打开「添加好友」时调用，避免启动时持续全网扫描。
#[tauri::command]
pub async fn search_nearby_peers(state: State<'_, Arc<AppState>>) -> Result<Vec<Peer>, String> {
    let s = state.inner();
    // 触发一次探测（若网络已启动）
    let triggered = if let Some(tx) = s.probe.lock().unwrap().as_ref() {
        let next = tx.borrow().saturating_add(1);
        let _ = tx.send(next);
        true
    } else {
        false
    };
    // 等待节点单播回复
    if triggered {
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    let mut peers: Vec<Peer> = s.peers.lock().unwrap().values().cloned().collect();
    peers.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    Ok(peers)
}

/// 从后台唤起并聚焦主窗口（点击系统通知后调用）。
#[cfg(desktop)]
#[tauri::command]
pub fn focus_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口不存在".to_string());
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 移动端无独立窗口概念，系统通知自带唤起行为，无需额外处理。
#[cfg(mobile)]
#[tauri::command]
pub fn focus_window(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// 网络拓扑摘要：节点数、中继数、平均时延。
#[tauri::command]
pub fn get_topology(state: State<'_, Arc<AppState>>) -> TopologyInfo {
    let s = state.inner();
    let peers = s.peers.lock().unwrap();
    let node_count = peers.len();
    let rtts: Vec<u64> = peers.values().filter_map(|p| p.rtt_ms).collect();
    let avg_rtt_ms = if rtts.is_empty() {
        None
    } else {
        Some(rtts.iter().sum::<u64>() / rtts.len() as u64)
    };
    let relay_count = s.relay.lock().unwrap().active_sends();
    let online = s.network.lock().unwrap().is_some();
    TopologyInfo {
        node_count,
        relay_count,
        avg_rtt_ms,
        online,
    }
}

// ---------------- 开发者诊断（隐藏面板用，只读不改网络行为） ----------------

/// 获取 Discovery 运行时诊断状态（供隐藏开发者面板展示）。
#[tauri::command]
pub fn get_discovery_diag(state: State<'_, Arc<AppState>>) -> crate::state::DiscoveryDiag {
    let s = state.inner();
    let net = s.network.lock().unwrap();
    let diag = s.diag.lock().unwrap().clone();
    let mut result = diag;
    if let Some(ref h) = *net {
        result.mode = if h.bound_ip == "0.0.0.0" {
            "auto".into()
        } else {
            "manual".into()
        };
        result.bound_ip = h.bound_ip.clone();
        result.tcp_listen = format!("{}:{}", h.bound_ip, h.tcp_port);
        result.udp_port = crate::protocol::UDP_PORT;
    } else {
        result.mode = "offline".into();
    }
    // 附加最近事件
    result.recent_events = s.diag_events.lock().unwrap().iter().cloned().collect();
    result
}

/// 获取候选网卡列表（含评分），供诊断面板展示 Discovery 自动选择逻辑的实际数据。
#[tauri::command]
pub fn get_interface_candidates() -> Vec<crate::state::InterfaceCandidate> {
    use std::net::Ipv4Addr;

    fn is_virtual_ip(ip: &Ipv4Addr) -> bool {
        let o = ip.octets();
        (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            || (o[0] == 100 && o[1] >= 64 && o[1] <= 127)
            || (o[0] == 169 && o[1] == 254)
    }
    fn is_rfc1918(ip: &Ipv4Addr) -> bool {
        let o = ip.octets();
        (o[0] == 10) || (o[0] == 172 && o[1] >= 16 && o[1] <= 31) || (o[0] == 192 && o[1] == 168)
    }
    fn is_virtual_name(name: &str) -> bool {
        let n = name.to_lowercase();
        [
            "utun",
            "tun",
            "tap",
            "wg",
            "docker",
            "br-",
            "veth",
            "virbr",
            "vmnet",
            "vboxnet",
            "hyper-v",
            "hv_",
            "vethernet",
            "cf-",
            "clash",
            "wintun",
            "tailscale",
            "ts-",
            "ham",
            "vpn",
        ]
        .iter()
        .any(|p| n.contains(p))
    }

    let mut out = Vec::new();
    if let Ok(ifs) = if_addrs::get_if_addrs() {
        for i in &ifs {
            if let if_addrs::IfAddr::V4(v4) = &i.addr {
                let ip = match i.ip() {
                    std::net::IpAddr::V4(v) => v,
                    _ => continue,
                };
                if ip.is_loopback() {
                    continue;
                }
                let has_bc = v4.broadcast.is_some();
                let rfc = is_rfc1918(&ip);
                let virt_ip = is_virtual_ip(&ip);
                let virt_name = is_virtual_name(&i.name);
                let mut score = 0i32;
                if has_bc {
                    score += 10;
                }
                if rfc {
                    score += 5;
                }
                if virt_ip {
                    score -= 50;
                }
                if virt_name {
                    score -= 30;
                }
                out.push(crate::state::InterfaceCandidate {
                    name: i.name.clone(),
                    ip: ip.to_string(),
                    has_broadcast: has_bc,
                    broadcast: v4.broadcast.map(|b| b.to_string()),
                    is_rfc1918: rfc,
                    is_virtual: virt_ip || virt_name,
                    score,
                    selected: false, // 由调用方根据实际 bind_ip 设置
                });
            }
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.ip.cmp(&b.ip)));
    out
}

// ---------------- 双通道与缓存 ----------------

/// 局域网 / 蓝牙通道状态（设置页开关 + 状态监控）。
#[tauri::command]
pub fn get_channel_status(state: State<'_, Arc<AppState>>) -> Vec<ChannelStatus> {
    TransportManager::new(state.inner().clone()).status()
}

/// 切换通道开关。局域网复用 `network`；蓝牙后端未编译，开启时返回明确错误。
#[tauri::command]
pub async fn set_channel_enabled(
    state: State<'_, Arc<AppState>>,
    channel: String,
    enabled: bool,
) -> Result<(), String> {
    let s = state.inner();
    match channel.as_str() {
        "lan" => {
            if enabled {
                // 绑定地址沿用用户已选网卡（settings.bind_ip），不再硬编码 0.0.0.0
                network::start_from_prefs(s.clone()).await?;
            } else {
                network::stop(s).await;
            }
            let dbc = s.db.lock().unwrap();
            db::set_lan_enabled(&dbc, enabled).ok();
            Ok(())
        }
        "bluetooth" => {
            let mut mgr = TransportManager::new(s.clone());
            if enabled {
                mgr.set_bluetooth_enabled(true).await
            } else {
                let dbc = s.db.lock().unwrap();
                db::set_setting(&dbc, "bt_enabled", "0").ok();
                Ok(())
            }
        }
        _ => Err(format!("未知通道: {channel}")),
    }
}

const RETENTION_KEY: &str = "cache_retention_days";
const MAX_BYTES_KEY: &str = "cache_max_bytes";

fn load_policy(s: &AppState) -> CachePolicy {
    let dbc = s.db.lock().unwrap();
    let retention = db::get_setting(&dbc, RETENTION_KEY)
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|&d| d > 0);
    let max = db::get_setting(&dbc, MAX_BYTES_KEY)
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&m| m > 0);
    CachePolicy {
        retention_days: retention,
        max_bytes: max,
    }
}

/// 缓存目录占用与当前清理策略。
#[tauri::command]
pub fn get_cache_info(state: State<'_, Arc<AppState>>) -> CacheInfo {
    let s = state.inner();
    let (file_count, total_bytes) = cache_cleaner::usage(&s.cache_dir);
    let policy = load_policy(s);
    CacheInfo {
        file_count,
        total_bytes,
        retention_days: policy.retention_days,
        max_bytes: policy.max_bytes,
    }
}

/// 设置缓存清理策略（保留时长 / 磁盘配额；`None` 或 `0` 表示不限制）。
#[tauri::command]
pub fn set_cache_policy(
    state: State<'_, Arc<AppState>>,
    retention_days: Option<u32>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    let s = state.inner();
    let dbc = s.db.lock().unwrap();
    let d = retention_days.unwrap_or(0);
    db::set_setting(&dbc, RETENTION_KEY, &d.to_string()).map_err(|e| e.to_string())?;
    let m = max_bytes.unwrap_or(0);
    db::set_setting(&dbc, MAX_BYTES_KEY, &m.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 立即执行一次缓存清理（过期 / 超配额删除 + SQLite VACUUM）。
#[tauri::command]
pub fn clean_cache_now(state: State<'_, Arc<AppState>>) -> CleanupReport {
    let s = state.inner();
    let policy = load_policy(s);
    let dbc = s.db.lock().unwrap();
    cache_cleaner::clean(&s.cache_dir, policy, &*dbc)
}

// ---------------- 应用偏好设置（本地持久化） ----------------

/// 应用偏好：外观、网卡选择等。持久化到本地 SQLite，重启后恢复。
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme_color: Option<String>,
    pub font_family: Option<String>,
    pub dark_mode: Option<bool>,
    pub bind_ip: Option<String>,
    /// 聊天显示样式 JSON：{"preset":"classic","fontSize":"md","compact":true}
    pub chat_style: Option<String>,
    /// 对端样式表 JSON（device_id -> style JSON）。仅由后端在收到 ChatStyle 消息时写入，
    /// 前端只读；save_settings 忽略该字段。
    pub peer_styles: Option<String>,
}

/// e2ee_enabled 键保留在 reset 链中仅为清理 v0.10.0 及更早版本的残留值；
/// v0.11.0 起 E2EE 恒开、不可关闭，该键不再被读写。
const SETTINGS_KEYS: [&str; 7] = [
    "theme_color",
    "font_family",
    "dark_mode",
    "bind_ip",
    "chat_style",
    "e2ee_enabled",
    "lan_enabled",
];

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    let dbc = state.inner().db.lock().unwrap();
    Settings {
        theme_color: db::get_setting(&dbc, "theme_color"),
        font_family: db::get_setting(&dbc, "font_family"),
        dark_mode: db::get_setting(&dbc, "dark_mode").map(|v| v == "1"),
        bind_ip: db::get_setting(&dbc, "bind_ip"),
        chat_style: db::get_setting(&dbc, "chat_style"),
        peer_styles: db::get_setting(&dbc, "chat_peer_styles"),
    }
}

#[tauri::command]
pub fn save_settings(state: State<'_, Arc<AppState>>, settings: Settings) -> Result<(), String> {
    let dbc = state.inner().db.lock().unwrap();
    if let Some(v) = settings.theme_color {
        db::set_setting(&dbc, "theme_color", &v).map_err(|e| e.to_string())?;
    }
    if let Some(v) = settings.font_family {
        db::set_setting(&dbc, "font_family", &v).map_err(|e| e.to_string())?;
    }
    if let Some(v) = settings.dark_mode {
        db::set_setting(&dbc, "dark_mode", if v { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    if let Some(v) = settings.bind_ip {
        db::set_setting(&dbc, "bind_ip", &v).map_err(|e| e.to_string())?;
    }
    if let Some(v) = settings.chat_style {
        db::set_setting(&dbc, "chat_style", &v).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 恢复默认设置：清除所有用户可配置设置（外观、昵称、头像、网卡、缓存策略等）。
/// 保留 device_id、x25519_secret、ed25519_secret、好友列表、聊天记录。
#[tauri::command]
pub fn reset_settings(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let dbc = state.inner().db.lock().unwrap();
    for key in SETTINGS_KEYS.iter().chain([
        &RETENTION_KEY,
        &MAX_BYTES_KEY,
        &"bt_enabled",
        &"chat_peer_styles",
        &"nickname",
        &"avatar",
    ]) {
        db::delete_setting(&dbc, key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 广播本机聊天样式到所有已连接节点（样式变更即调用，对方设备与好友同步收到）。
#[tauri::command]
pub async fn broadcast_chat_style(
    state: State<'_, Arc<AppState>>,
    style: String,
) -> Result<(), String> {
    let s = state.inner();
    let msg = Message::ChatStyle {
        from: s.device_id.clone(),
        to: None,
        style,
    };
    let links = s.links.lock().await;
    for tx in links.values() {
        let _ = tx.send(msg.clone()).await;
    }
    Ok(())
}

// ---------------- 好友 ----------------

#[tauri::command]
pub fn get_friends(state: State<'_, Arc<AppState>>) -> Vec<Friend> {
    let s = state.inner();
    let peers = s.peers.lock().unwrap();
    // 同时检查活跃 TCP 链接：链路存活但 peer 已被 discovery sweep 清掉时，
    // 仍应显示在线，避免「实际可通信但 UI 显示离线」。
    let active_links: std::collections::HashSet<String> = s
        .links
        .try_lock()
        .map(|l| l.keys().cloned().collect())
        .unwrap_or_default();
    let dbc = s.db.lock().unwrap();
    let mut friends = db::list_friends(&dbc).unwrap_or_default();
    for f in friends.iter_mut() {
        f.online = peers.contains_key(&f.device_id) || active_links.contains(&f.device_id);
    }
    friends
}

/// 删除好友（保留聊天记录；对方仍会出现在扫描列表，可重新添加）。
#[tauri::command]
pub async fn remove_friend(state: State<'_, Arc<AppState>>, peer_id: String) -> Result<(), String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap();
        db::remove_friend(&dbc, &peer_id).map_err(|e| e.to_string())?;
    }
    // 通知对方解除好友关系（对方收到后也会删除本机好友行）
    let msg = Message::FriendRemove {
        from: s.device_id.clone(),
        to: peer_id.clone(),
    };
    let _ = try_send(s, &peer_id, &msg).await;
    let _ = s.app.emit("friend-removed", &peer_id);
    Ok(())
}

#[tauri::command]
pub fn get_pending_requests(state: State<'_, Arc<AppState>>) -> Vec<PendingRequest> {
    state
        .inner()
        .pending_requests
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
pub async fn send_friend_request(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
) -> Result<(), String> {
    let s = state.inner();
    if peer_id.is_empty() || peer_id == s.device_id {
        return Err("不能向自己发送好友申请".to_string());
    }
    if !s.peers.lock().unwrap().contains_key(&peer_id) {
        return Err("未找到该在线节点，请先重新扫描".to_string());
    }
    let msg = Message::FriendRequest {
        from: s.device_id.clone(),
        from_nickname: s.nickname.lock().unwrap().clone(),
        from_avatar: s.avatar.lock().unwrap().clone(),
        to: peer_id.clone(),
        ts: db::now_ms(),
    };
    try_send(s, &peer_id, &msg).await
}

#[tauri::command]
pub async fn respond_friend_request(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
    accept: bool,
) -> Result<(), String> {
    let s = state.inner();
    if !s.pending_requests.lock().unwrap().contains_key(&peer_id) {
        return Err("好友申请不存在或已处理".to_string());
    }
    if accept {
        let name = resolve_nickname(s, &peer_id);
        {
            let dbc = s.db.lock().unwrap();
            db::add_friend(&dbc, &peer_id, &name, None).ok();
            db::ensure_conversation(&dbc, &peer_id, "single", &name, None).ok();
        }
        // 补写 peers 表已有的公钥到 friends 表：accept 路径此前不写公钥，
        // 而建链（Hello）早于加好友、公钥不变时 key_changed 不触发补写，
        // 导致 friends 公钥永久缺失 → 群密钥分发被静默跳过。
        // 与 transport.rs 中 FriendAccept 接收路径的补写行为一致。
        maybe_update_friend(s, &peer_id, &name, None);
        let msg = Message::FriendAccept {
            from: s.device_id.clone(),
            to: peer_id.clone(),
        };
        try_send(s, &peer_id, &msg).await?;
        s.pending_requests.lock().unwrap().remove(&peer_id);
        let _ = s.app.emit("friend-accepted", &peer_id);
    } else {
        let msg = Message::FriendReject {
            from: s.device_id.clone(),
            to: peer_id.clone(),
        };
        try_send(s, &peer_id, &msg).await?;
        s.pending_requests.lock().unwrap().remove(&peer_id);
    }
    Ok(())
}

// ---------------- 单聊（Gossip + E2EE） ----------------

#[tauri::command]
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    content: String,
    kind: String,
) -> Result<MessageRecord, String> {
    let s = state.inner();

    let msg_kind = match kind.as_str() {
        "text" => MsgKind::Text,
        "code" => MsgKind::Code,
        "image" => MsgKind::Image,
        "file" => MsgKind::File,
        _ => return Err("不支持的消息类型".to_string()),
    };

    // 好友关系检查：必须优先于公钥查找
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }

    // 长度保护：
    // - text/code 等普通内容按字符截断（UTF-8 安全），沿用既有 50000 上限；
    // - image 的 data URL 是 Base64，中途截断 = 图片损坏，因此绝不截断：
    //   上限内原样透传，超限直接报错拒发（提示改用「发送文件」）。
    let content: String = if kind == "image" {
        if content.chars().count() > MAX_IMAGE_CONTENT_LEN {
            return Err(format!(
                "图片过大（超过 {MAX_IMAGE_CONTENT_LEN} 字符），请压缩后重试或改用发送文件"
            ));
        }
        content
    } else {
        content.chars().take(MAX_MESSAGE_LEN).collect()
    };

    // E2EE 恒开（v0.11.0 起默认且不可关闭）：发送必须拿到对端 X25519 公钥。
    // 好友表优先，回退在线节点表；都缺失时主动探测一次（who_has）等对方/中继
    // announce 落库（约 1.2s）后再查，仍缺失则报错指引。
    let pubkey = {
        let from_db = {
            let dbc = s.db.lock().unwrap();
            db::get_friend_x25519(&dbc, &friend_id)
        };
        let from_peers = s
            .peers
            .lock()
            .unwrap()
            .get(&friend_id)
            .and_then(|p| p.x25519_pubkey.clone());
        match from_db.or(from_peers) {
            Some(k) => Some(k),
            None => {
                let triggered = if let Some(tx) = s.probe.lock().unwrap().as_ref() {
                    let next = tx.borrow().saturating_add(1);
                    let _ = tx.send(next);
                    true
                } else {
                    false
                };
                if triggered {
                    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                }
                let again_db = {
                    let dbc = s.db.lock().unwrap();
                    db::get_friend_x25519(&dbc, &friend_id)
                };
                let again_peers = s
                    .peers
                    .lock()
                    .unwrap()
                    .get(&friend_id)
                    .and_then(|p| p.x25519_pubkey.clone());
                again_db.or(again_peers)
            }
        }
    };
    let Some(pubkey) = pubkey else {
        return Err(format!(
            "尚未获取 {friend_id} 的公钥：对方可能离线或处于不同子网，请让对方上线后重试"
        ));
    };

    let ts = db::now_ms();
    let name = resolve_nickname(s, &friend_id);
    let preview = preview(&kind, &content);

    // E2EE 加密 + Gossip 信封（先于本地落库：msg_id 三处统一用 Gossip 信封 ID）
    let plaintext = serde_json::json!({ "kind": kind, "content": content }).to_string();
    let shared = crypto::shared_secret(&s.identity.x25519_secret, &pubkey).ok_or("密钥交换失败")?;
    // Gossip 载荷与直发内容都走 ChaCha20-Poly1305（直发内容加 "enc1:" 前缀标识）
    let sealed = crypto::seal(&shared, plaintext.as_bytes()).ok_or("加密失败")?;
    let sealed_content = crypto::seal(&shared, content.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let wire_content = format!("enc1:{}", STANDARD.encode(&sealed_content));
    let env = {
        let gossip = s.gossip.lock().unwrap();
        gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Chat,
            None,
            None,
            &payload_b64,
            ts,
        )
    };
    // 信封 encrypted 默认 true（build_envelope 内置），无需改写
    // 统一 msg_id：本地记录 / Gossip 投递 / outbox 补发共用同一确定性 ID，
    // 接收方 message_exists 跨路径去重（防建链竞态窗口内的重复投递）。
    let msg_id = env.message_id.clone();

    // 本地落库（明文）
    let rec = MessageRecord {
        id: 0,
        msg_id: msg_id.clone(),
        conv_id: friend_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: friend_id.clone(),
        kind: kind.clone(),
        content: content.clone(),
        ts,
        status: "sent".to_string(),
    };
    // 一律写离线队列兜底（INSERT OR IGNORE 按 msg_id 幂等）：直连链路存在但已失效
    // （半开 TCP）时 broadcast 会静默丢包，此前只在「无链路」时入队导致消息永久丢失。
    // Ack 到达后由 transport.rs 删除该行；若链路中断，对方上线建链（Hello）或心跳
    // 会触发 flush_outbox 自动补发，接收方按 msg_id 去重不会重复入库。
    let queued = Message::ChatMessage {
        msg_id: msg_id.clone(),
        from: s.device_id.clone(),
        to: friend_id.clone(),
        kind: msg_kind,
        content: wire_content,
        ts,
    };
    let payload = serde_json::to_string(&queued).map_err(|e| e.to_string())?;
    {
        let dbc = s.db.lock().unwrap();
        db::insert_message_and_outbox(&dbc, &rec, &friend_id, &payload)
            .map_err(|e| format!("消息写入失败：{e}"))?;
        db::touch_conversation(&dbc, &friend_id, "single", &name, None, &preview, 0)
            .map_err(|e| format!("会话写入失败：{e}"))?;
    }

    // 先入队再投递（INV-003）：此前 broadcast 在插队之前，若心跳的 flush_outbox 正好
    // 落在这个窗口，它看不到 outbox 行 ⇒ 这一轮直发缺席 ⇒ Ack 要等下一个心跳（+5s）。
    broadcast_gossip(s, env).await;

    Ok(rec)
}

#[tauri::command]
pub fn get_messages(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Vec<MessageRecord> {
    let dbc = state.inner().db.lock().unwrap();
    let safe_limit = limit.unwrap_or(100).clamp(1, 500);
    let safe_offset = offset.unwrap_or(0).max(0);
    db::get_messages(&dbc, &conv_id, safe_limit, safe_offset).unwrap_or_default()
}

#[tauri::command]
pub fn get_conversations(state: State<'_, Arc<AppState>>) -> Vec<Conversation> {
    let dbc = state.inner().db.lock().unwrap();
    db::list_conversations(&dbc).unwrap_or_default()
}

/// 打开与好友的会话时确保会话行存在（新加好友尚未发过消息时，
/// 会话列表无对应项 → 左侧无法高亮选中态）。
#[tauri::command]
pub fn ensure_conversation(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
) -> Result<Conversation, String> {
    let s = state.inner();
    let name = resolve_nickname(s, &friend_id);
    let avatar = {
        let peers = s.peers.lock().unwrap();
        peers.get(&friend_id).and_then(|p| p.avatar.clone())
    };
    {
        let dbc = s.db.lock().unwrap();
        db::ensure_conversation(&dbc, &friend_id, "single", &name, avatar.as_deref())
            .map_err(|e| e.to_string())?;
    }
    Ok(Conversation {
        id: friend_id.clone(),
        kind: "single".to_string(),
        name,
        avatar,
        last_msg: None,
        last_ts: None,
        unread: 0,
    })
}

/// 标记会话已读；单聊时向对方发送已读回执（触发对方界面的「已读绿勾」）。
#[tauri::command]
pub async fn mark_read(state: State<'_, Arc<AppState>>, conv_id: String) -> Result<(), String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap();
        db::mark_read(&dbc, &conv_id).map_err(|e| e.to_string())?;
    }
    if !conv_id.starts_with("group:") {
        // 通知对方：我已读到该会话最新一条消息为止
        let last_ts: Option<i64> = {
            let dbc = s.db.lock().unwrap();
            Some(db::last_message_ts(&dbc, &conv_id)).filter(|t| *t > 0)
        };
        if let Some(ts) = last_ts.filter(|t| *t > 0) {
            let msg = Message::ReadReceipt {
                from: s.device_id.clone(),
                to: conv_id.clone(),
                last_read_ts: ts,
            };
            // try_send 返回 Ok 只代表消息进入 mpsc channel，不代表 TCP writer
            // 真正 write_frame 成功——writer_loop 可能随后发现链路已断而丢弃。
            // 因此无论 Ok/Err 都保留 pending：下一次心跳/建链时 flush 重发。
            // 接收方按 last_read_ts 单调性去重，重复送达无副作用。
            let _ = crate::network::transport::try_send(s, &conv_id, &msg).await;
            {
                let mut pending = s.pending_reads.lock().unwrap();
                let cur = pending.entry(conv_id.clone()).or_insert(ts);
                *cur = (*cur).max(ts);
            }
            // 持久化到 DB：进程重启后 pending_reads 内存丢失时可从 DB 恢复。
            // 使用 max 语义（upsert_pending_read）保证较旧 timestamp 不覆盖较新。
            {
                let dbc = s.db.lock().unwrap();
                db::upsert_pending_read(&dbc, &conv_id, ts).ok();
            }
        }
    } else if let Some(group_id) = conv_id.strip_prefix("group:") {
        let group = {
            let dbc = s.db.lock().unwrap();
            db::get_group(&dbc, group_id)
        };
        if let Some(group) = group {
            let last_read_ts = db::last_message_ts(&s.db.lock().unwrap(), &conv_id);
            for member in group.members {
                if member == s.device_id {
                    continue;
                }
                let msg = Message::GroupReadReceipt {
                    from: s.device_id.clone(),
                    group_id: group_id.to_string(),
                    last_read_ts,
                };
                let _ = crate::network::transport::try_send(s, &member, &msg).await;
            }
        }
    }
    Ok(())
}

/// 删除本地会话与全部消息（聊天记录清理）。
/// 仅删本地：不影响对方、不广播；前端负责二次确认弹窗。
/// 群聊同样支持（删除 group:xxx 会话及全部消息）。
#[tauri::command]
pub fn delete_conversation(state: State<'_, Arc<AppState>>, conv_id: String) -> Result<(), String> {
    let s = state.inner();
    let dbc = s.db.lock().unwrap();
    db::delete_conversation(&dbc, &conv_id).map_err(|e| e.to_string())
}

// ---------------- 群聊（群密钥 + Gossip） ----------------

#[tauri::command]
pub fn create_group(
    state: State<'_, Arc<AppState>>,
    name: String,
    members: Vec<String>,
) -> Result<Group, String> {
    let s = state.inner();
    // 群名称长度保护：按字符截断（UTF-8 安全）
    let name: String = name
        .chars()
        .take(MAX_GROUP_NAME_LEN)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("群名称不能为空".to_string());
    }
    let id = format!("g-{}", Uuid::new_v4());
    let mut all = members;
    all.retain(|m| !m.is_empty() && m != &s.device_id);
    all.sort();
    all.dedup();
    {
        let dbc = s.db.lock().unwrap();
        for member in &all {
            if db::get_friend(&dbc, member).is_none() {
                return Err("只能把好友加入群聊".to_string());
            }
        }
    }
    if !all.contains(&s.device_id) {
        all.push(s.device_id.clone());
    }

    // 生成群密钥并持久化
    let key = crypto::random_key();
    {
        let dbc = s.db.lock().unwrap();
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO groups(id, name, creator, created_at) VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, s.device_id, db::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        for member in &all {
            tx.execute(
                "INSERT OR IGNORE INTO group_members(group_id, device_id) VALUES(?1, ?2)",
                rusqlite::params![id, member],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)",
            rusqlite::params![format!("gk:{id}"), STANDARD.encode(key)],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO conversations(id, kind, name, avatar, unread, updated_at)
             VALUES(?1, 'group', ?2, NULL, 0, ?3)",
            rusqlite::params![format!("group:{id}"), name, db::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    s.group_keys.lock().unwrap().insert(id.clone(), key);

    Ok(Group {
        id,
        name,
        creator: s.device_id.clone(),
        members: all,
    })
}

/// 向群成员分发群密钥（用各成员公钥 ECDH 加密）。
/// 同时携带群名与成员列表：成员端据此建本地群记录，否则群名会兜底成「群聊 g-xxxx」。
#[tauri::command]
pub async fn distribute_group_key(
    state: State<'_, Arc<AppState>>,
    group_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let key = get_group_key(s, &group_id).await.ok_or("群密钥缺失")?;
    // 同时取群名与成员：成员端靠它建立/刷新本地群记录（含成员表）
    let (group_name, members) = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id)
            .map(|g| (g.name, g.members))
            .unwrap_or_default()
    };
    for m in &members {
        if m == &s.device_id {
            continue;
        }
        // peers 优先、friends 回落：peers 由 announce/Hello 实时维护，
        // friends 表公钥可能因 accept 路径未补写而缺失（曾致 GroupKey 静默跳过）
        let Some(pubkey) = resolve_member_x25519(s, m) else {
            continue;
        };
        let Some(shared) = crypto::shared_secret(&s.identity.x25519_secret, &pubkey) else {
            continue;
        };
        let Some(sealed) = crypto::seal(&shared, &key) else {
            continue;
        };
        let msg = Message::GroupKey {
            group_id: group_id.clone(),
            from: s.device_id.clone(),
            to: m.clone(),
            key: STANDARD.encode(&sealed),
            group_name: group_name.clone(),
            members: members.clone(),
        };
        if let Err(_) = try_send(s, m, &msg).await {
            // 目标成员尚无 TCP link（建群时 ensure_link 可能尚未执行）：
            // 不再静默丢弃，登记待发，由建链 / Hello / 心跳的
            // flush_pending_group_keys 补发（与 redistribute_group_keys 同一机制）。
            let mut pending = s.pending_group_keys.lock().unwrap();
            mark_pending_group_key(&mut pending, m, &group_id);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_groups(state: State<'_, Arc<AppState>>) -> Vec<Group> {
    let dbc = state.inner().db.lock().unwrap();
    db::list_groups(&dbc).unwrap_or_default()
}

#[tauri::command]
pub fn get_group_reads(state: State<'_, Arc<AppState>>, group_id: String) -> Vec<GroupReadInfo> {
    let dbc = state.inner().db.lock().unwrap();
    db::list_group_reads(&dbc, &group_id)
        .unwrap_or_default()
        .into_iter()
        .map(|(reader_id, last_read_ts)| GroupReadInfo {
            reader_id,
            last_read_ts,
        })
        .collect()
}

/// 重命名群：仅创建者可操作。本地改名 + 同步会话标题后，广播给全部成员。
#[tauri::command]
pub async fn rename_group(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    name: String,
) -> Result<(), String> {
    let s = state.inner();
    let name: String = name.chars().take(MAX_GROUP_NAME_LEN).collect();
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("群名称不能为空".to_string());
    }
    let group = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以修改群名称".to_string());
    }
    {
        let dbc = s.db.lock().unwrap();
        db::rename_group(&dbc, &group_id, &name).map_err(|e| e.to_string())?;
    }
    for m in &group.members {
        if m == &s.device_id {
            continue;
        }
        let msg = Message::GroupRename {
            group_id: group_id.clone(),
            from: s.device_id.clone(),
            name: name.clone(),
        };
        let _ = try_send(s, m, &msg).await;
    }
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

/// 向成员列表里的每一位重发当前群密钥（携带群名 + 最新成员表）。
async fn resend_group_key_to(s: &AppState, group_id: &str, members: &[String], key: [u8; 32]) {
    let group_name = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, group_id)
            .map(|g| g.name)
            .unwrap_or_default()
    };
    for m in members {
        if m == &s.device_id {
            continue;
        }
        // peers 优先、friends 回落（与 distribute_group_key 同一来源策略）
        let Some(pubkey) = resolve_member_x25519(s, m) else {
            continue;
        };
        let Some(shared) = crypto::shared_secret(&s.identity.x25519_secret, &pubkey) else {
            continue;
        };
        let Some(sealed) = crypto::seal(&shared, &key) else {
            continue;
        };
        let msg = Message::GroupKey {
            group_id: group_id.to_string(),
            from: s.device_id.clone(),
            to: m.clone(),
            key: STANDARD.encode(&sealed),
            group_name: group_name.clone(),
            members: members.to_vec(),
        };
        if let Err(_) = try_send(s, m, &msg).await {
            // 目标成员尚无 TCP link：登记待发，由建链 / Hello / 心跳的
            // flush_pending_group_keys 补发（与 redistribute_group_keys 同一机制）。
            let mut pending = s.pending_group_keys.lock().unwrap();
            mark_pending_group_key(&mut pending, m, group_id);
        }
    }
}

/// 加人入群：仅创建者。本地落成员 + 轮换群密钥后重发给全体当前成员（含新成员）。
#[tauri::command]
pub async fn group_add_member(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    device_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以添加成员".to_string());
    }
    if group.members.contains(&device_id) {
        return Err("该成员已在群中".to_string());
    }
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &device_id).is_none() {
            return Err("只能添加好友入群".to_string());
        }
    }
    {
        let dbc = s.db.lock().unwrap();
        db::add_group_member(&dbc, &group_id, &device_id).map_err(|e| e.to_string())?;
    }
    // 轮换群密钥：加人后新老成员统一换新
    let key = crypto::random_key();
    {
        let dbc = s.db.lock().unwrap();
        db::set_setting(&dbc, &format!("gk:{group_id}"), &STANDARD.encode(key)).ok();
    }
    s.group_keys.lock().unwrap().insert(group_id.clone(), key);
    let current = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id)
            .map(|g| g.members)
            .unwrap_or_default()
    };
    resend_group_key_to(s, &group_id, &current, key).await;
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

/// 移人出群：仅创建者。轮换群密钥发给剩余成员，并向被移除者发 GroupMemberRemoved。
#[tauri::command]
pub async fn group_remove_member(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    device_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以移除成员".to_string());
    }
    if device_id == s.device_id {
        return Err("不能移除自己".to_string());
    }
    if !group.members.contains(&device_id) {
        return Err("该成员不在群中".to_string());
    }
    {
        let dbc = s.db.lock().unwrap();
        db::remove_group_member(&dbc, &group_id, &device_id).map_err(|e| e.to_string())?;
    }
    // 轮换群密钥：被移除者失去解密能力
    let key = crypto::random_key();
    {
        let dbc = s.db.lock().unwrap();
        db::set_setting(&dbc, &format!("gk:{group_id}"), &STANDARD.encode(key)).ok();
    }
    s.group_keys.lock().unwrap().insert(group_id.clone(), key);
    let remaining = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id)
            .map(|g| g.members)
            .unwrap_or_default()
    };
    resend_group_key_to(s, &group_id, &remaining, key).await;
    // 通知被移除者本人清理本地群
    let msg = Message::GroupMemberRemoved {
        group_id: group_id.clone(),
        from: s.device_id.clone(),
        to: device_id.clone(),
    };
    let _ = try_send(s, &device_id, &msg).await;
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

// ---------------- 自绘标题栏：窗口控制 ----------------

/// 最小化主窗口。
#[cfg(desktop)]
#[tauri::command]
pub fn window_minimize(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

/// 移动端没有独立窗口概念，最小化由系统接管。
#[cfg(mobile)]
#[tauri::command]
pub fn window_minimize(_app: tauri::AppHandle) {}

/// 切换窗口最大化，返回切换后的状态。
#[cfg(desktop)]
#[tauri::command]
pub fn window_toggle_maximize(app: tauri::AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else {
        return false;
    };
    match w.is_maximized() {
        Ok(true) => {
            let _ = w.unmaximize();
            false
        }
        _ => {
            let _ = w.maximize();
            true
        }
    }
}

/// 移动端窗口始终铺满屏幕，等价于「不可再最大化」。
#[cfg(mobile)]
#[tauri::command]
pub fn window_toggle_maximize(_app: tauri::AppHandle) -> bool {
    false
}

/// 返回窗口当前是否最大化。
#[tauri::command]
pub fn window_is_maximized(app: tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub async fn send_group_message(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    content: String,
    kind: String,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    let kind_enum = match kind.as_str() {
        "text" => MsgKind::Text,
        "code" => MsgKind::Code,
        "image" => MsgKind::Image,
        _ => return Err("群聊不支持该消息类型".to_string()),
    };
    let content: String = if kind == "image" {
        if content.chars().count() > MAX_IMAGE_CONTENT_LEN {
            return Err("图片过大，请改用发送文件".to_string());
        }
        content
    } else {
        content.chars().take(MAX_MESSAGE_LEN).collect()
    };
    let ts = db::now_ms();
    // 把群名 + 创建者 + 当前成员一并带上：跨端成员即便从未收到 GroupKey、
    // 只凭这条群消息也能在本地正确建群（含成员表），成员面板因此不为空。
    let group_meta = {
        let dbc = s.db.lock().unwrap();
        db::get_group(&dbc, &group_id).map(|g| (g.name, g.creator, g.members))
    };
    let (group_name, group_creator, group_members) = match group_meta {
        Some((n, c, m)) => (n, Some(c), m),
        None => return Err("群不存在".to_string()),
    };
    if !group_members.contains(&s.device_id) {
        return Err("你已不在该群中".to_string());
    }
    let key = get_group_key(s, &group_id).await.ok_or("群密钥缺失")?;
    let conv_id = format!("group:{group_id}");
    let preview = preview(&kind, &content);

    // 群密钥加密 + Gossip 信封（E2EE 恒开：载荷用群密钥 ChaCha20-Poly1305 加密）
    let plaintext =
        serde_json::json!({ "kind": kind_enum.as_str(), "content": content }).to_string();
    let sealed = crypto::seal_symmetric(&key, plaintext.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let env = {
        let gossip = s.gossip.lock().unwrap();
        let mut env = gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Group,
            Some(group_id.clone()),
            Some(group_name.clone()),
            &payload_b64,
            ts,
        );
        env.group_creator = group_creator;
        env.group_members = group_members;
        // group_creator / group_members 属于签名材料（GossipEnvelope::signing_bytes），
        // 而 build_envelope 内部已按「尚未填值」的状态算过 message_id 与 sender_sig。
        // 若此处不重算重签，接收端 verify_envelope 会用最终字段重新计算签名材料，
        // 与旧签名不一致 → 验签失败 → handle_gossip 静默丢弃群消息（群聊收不到的根因）。
        // compute_message_id 只依赖 sender_id + ts + payload，重算后 message_id 不变，
        // 与既有协议语义保持一致。
        env.compute_message_id();
        env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
        env
    };
    // 信封 encrypted 默认 true（build_envelope 内置），无需改写

    // 本地落库：msg_id 统一用 envelope.message_id（与单聊发送路径一致），
    // 保证同一条群消息在本地记录 / Gossip 投递 / 接收端落库三处身份一致。
    let rec = MessageRecord {
        id: 0,
        msg_id: env.message_id.clone(),
        conv_id: conv_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: group_id.clone(),
        kind: kind_enum.as_str().to_string(),
        content: content.clone(),
        ts,
        status: "sent".to_string(),
    };
    {
        let dbc = s.db.lock().unwrap();
        db::insert_message(&dbc, &rec).map_err(|e| format!("消息写入失败：{e}"))?;
        db::touch_conversation(&dbc, &conv_id, "group", &group_name, None, &preview, 0)
            .map_err(|e| format!("会话写入失败：{e}"))?;
    }

    broadcast_gossip(s, env).await;

    Ok(rec)
}

// ---------------- 文件传输 ----------------

#[tauri::command]
pub async fn send_file(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();
    // 好友关系检查
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }
    let transfer_id = Uuid::new_v4().to_string();
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("只能发送普通文件".to_string());
    }
    let size = meta.len();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let content = serde_json::json!({ "name": name.clone(), "path": path, "size": size, "subtype": file::classify_file_subtype(&name) }).to_string();
    let rec = MessageRecord {
        id: 0,
        msg_id: format!("file-{transfer_id}"),
        conv_id: friend_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: friend_id.clone(),
        kind: "file".to_string(),
        content,
        ts: db::now_ms(),
        status: "sent".to_string(),
    };
    {
        let dbc = s.db.lock().unwrap();
        db::insert_message(&dbc, &rec).ok();
        let nm = resolve_nickname(s, &friend_id);
        db::touch_conversation(
            &dbc,
            &friend_id,
            "single",
            &nm,
            None,
            &format!("[文件] {name}"),
            0,
        )
        .ok();
    }
    let _ = s.app.emit("message-received", &rec);

    let arc = state.inner().clone();
    let fid = friend_id;
    let tid = transfer_id.clone();
    let p = PathBuf::from(path);
    tokio::spawn(async move {
        let _ = file::send_file_from_path(&arc, &fid, &tid, p).await;
    });
    Ok(transfer_id)
}

/// 统一文件发送入口：自动路由。
/// - 与对方有直连 TCP 链路 → 直连分片流（可靠有序）。
/// - 无直连但周围有在线节点 → 切片中继（经其他节点转发）。
/// - 都不可达 → 返回明确错误。
#[tauri::command]
pub async fn send_file_auto(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();
    let direct = s.links.lock().await.contains_key(&friend_id);
    if direct {
        return send_file(state.clone(), friend_id, path).await;
    }

    // 无直连：若周围完全没有任何已建链节点，中继也走不通
    let relay_available = { !s.links.lock().await.is_empty() };
    if !relay_available {
        return Err("对方与周围节点均不在线，无法发送文件".to_string());
    }
    send_file_relay(state, friend_id, path).await
}

/// 中继切片发送：把文件切片并行分发给接收方 + 空闲中继节点。
#[tauri::command]
pub async fn send_file_relay(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();
    // 好友关系检查
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }
    let transfer_id = Uuid::new_v4().to_string();

    // 文件读取 + base64 切片是同步重活：放阻塞线程池，避免卡住 async runtime（界面卡死根因）
    let chunk_size = { s.relay.lock().unwrap().chunk_size };
    let p = std::path::PathBuf::from(&path);
    let (name, size, chunks) = tokio::task::spawn_blocking(move || {
        crate::relay_manager::RelayManager::slice_file_with(&p, chunk_size)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if size > i64::MAX as u64 {
        return Err("文件过大，无法安全发送".to_string());
    }

    let total_chunks = chunks.len() as u32;
    if total_chunks == 0 {
        return Err("空文件不支持中继发送，请使用直连传输".to_string());
    }

    // E2EE：本 transfer 独立的随机文件会话密钥（CSPRNG，仅存内存），
    // 用接收方公钥封装进 RelayFileOffer；每个切片以此密钥 AEAD 加密——
    // 中继节点只透传密文，无法解密。
    let file_key = crypto::random_key();
    let receiver_pubkey = resolve_member_x25519(&s, &friend_id);
    let sealed_key_b64 = (|| {
        let pubkey = receiver_pubkey.as_deref()?;
        let shared = crypto::shared_secret(&s.identity.x25519_secret, pubkey)?;
        Some(STANDARD.encode(crypto::seal(&shared, &file_key)?))
    })();
    let Some(sealed_key_b64) = sealed_key_b64 else {
        return Err("无法获取对方公钥，无法加密文件".to_string());
    };
    // 切片逐片加密：ChunkData.data 为 base64（明文）→ decode → AEAD 加密 → 重新 encode
    // （随机 nonce，同密钥不同片 nonce 必不相同）
    let sealed_chunks: Vec<ChunkData> = chunks
        .into_iter()
        .enumerate()
        .map(|(seq, c)| {
            let plain = STANDARD.decode(&c.data).map_err(|e| e.to_string())?;
            let sealed = crypto::seal_symmetric(&file_key, &plain)
                .ok_or_else(|| "文件分片加密失败".to_string())?;
            Ok::<_, String>(ChunkData {
                seq: seq as u32,
                data: STANDARD.encode(sealed),
            })
        })
        .collect::<Result<_, _>>()?;
    s.relay.lock().unwrap().register_send(&transfer_id, sealed_chunks);

    // 元数据直接发给接收方
    let offer = Message::RelayFileOffer {
        transfer_id: transfer_id.clone(),
        from: s.device_id.clone(),
        to: friend_id.clone(),
        name: name.clone(),
        size,
        total_chunks,
        sealed_file_key: sealed_key_b64,
    };
    try_send(s, &friend_id, &offer).await?;

    // 选择中继节点：在线且非接收方（最多 3 个）
    let relays: Vec<String> = {
        let peers = s.peers.lock().unwrap();
        peers
            .keys()
            .filter(|k| k.as_str() != friend_id)
            .cloned()
            .take(3)
            .collect()
    };
    let mut targets = vec![friend_id.clone()];
    targets.extend(relays);

    // 轮询分发切片
    let plan = {
        s.relay
            .lock()
            .unwrap()
            .plan_distribution(&transfer_id, &targets)
    };
    for p in plan {
        let chunk = Message::RelayChunk {
            transfer_id: transfer_id.clone(),
            seq: p.chunk.seq,
            data: p.chunk.data,
            from: s.device_id.clone(),
            to: friend_id.clone(),
            ttl: 3,
        };
        let _ = try_send(s, &p.peer_id, &chunk).await;
    }
    s.relay.lock().unwrap().finish_send(&transfer_id);

    // 本机消息记录
    let content = serde_json::json!({ "name": name.clone(), "path": path, "size": size, "subtype": file::classify_file_subtype(&name) }).to_string();
    let rec = MessageRecord {
        id: 0,
        msg_id: format!("file-{transfer_id}"),
        conv_id: friend_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: friend_id.clone(),
        kind: "file".to_string(),
        content,
        ts: db::now_ms(),
        status: "sent".to_string(),
    };
    {
        let dbc = s.db.lock().unwrap();
        db::insert_message(&dbc, &rec).ok();
        // 与 Direct stream_file 一致：发送方消息状态推进到 delivered，
        // 否则 Relay sender 气泡永远停在「发送中」spinner。
        db::set_message_status(&dbc, &rec.msg_id, "delivered").ok();
        let nm = resolve_nickname(s, &friend_id);
        db::touch_conversation(
            &dbc,
            &friend_id,
            "single",
            &nm,
            None,
            &format!("[文件] {name}"),
            0,
        )
        .ok();
    }
    let _ = s.app.emit("message-received", &rec);
    let _ = s.app.emit("message-acked", &rec.msg_id);

    Ok(transfer_id)
}

#[tauri::command]
pub fn get_transfers(state: State<'_, Arc<AppState>>) -> Vec<TransferInfo> {
    let dbc = state.inner().db.lock().unwrap();
    db::list_transfers(&dbc).unwrap_or_default()
}

// ---------------- 共享目录 ----------------

#[tauri::command]
pub fn set_share_dir(state: State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    if !PathBuf::from(&path).is_dir() {
        return Err("目录不存在".to_string());
    }
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap();
        db::set_setting(&dbc, "share_dir", &path).map_err(|e| e.to_string())?;
    }
    *s.share_dir.lock().unwrap() = Some(path);
    Ok(())
}

#[tauri::command]
pub fn get_share_dir(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.inner().share_dir.lock().unwrap().clone()
}

#[tauri::command]
pub async fn request_share_tree(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
) -> Result<Vec<ShareEntry>, String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友".to_string());
        }
    }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    s.pending_share_tree
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    let msg = Message::ShareTreeRequest {
        request_id: request_id.clone(),
        from: s.device_id.clone(),
        to: friend_id.clone(),
    };
    if let Err(e) = try_send(s, &friend_id, &msg).await {
        s.pending_share_tree.lock().unwrap().remove(&request_id);
        return Err(e);
    }

    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(entries)) => Ok(entries),
        _ => {
            s.pending_share_tree.lock().unwrap().remove(&request_id);
            Err("获取共享目录超时".to_string())
        }
    }
}

#[tauri::command]
pub async fn download_shared_file(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    remote_path: String,
) -> Result<String, String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap();
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友".to_string());
        }
    }
    let transfer_id = Uuid::new_v4().to_string();
    let msg = Message::ShareFileRequest {
        transfer_id: transfer_id.clone(),
        from: s.device_id.clone(),
        path: remote_path,
    };
    try_send(s, &friend_id, &msg).await?;
    Ok(transfer_id)
}

// ---------------- 辅助 ----------------

/// 将文件从 source 复制到 destination（用于"另存为"下载功能）。
#[tauri::command]
pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取附件预览内容（原始字节，不走 base64 IPC）。
///
/// 按 `msg_id` 反查记录里的本地 `path` 再读，前端据此渲染图片（→Blob/objectURL）
/// 或代码（→TextDecoder）。安全边界：路径必须落在 downloads 目录内（接收方文件），
/// 或该消息由本机发出（发送方自选的文件）——两者都不允许对端通过消息内容
/// 诱导读取任意本地路径。超过 `max_bytes` 返回 "TOO_LARGE"，由前端回退文件卡片。
#[tauri::command]
pub fn read_file_preview(
    state: State<'_, Arc<AppState>>,
    msg_id: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let s = state.inner();
    let max_bytes = max_bytes.min(15 * 1024 * 1024);
    let (sender_id, content) =
        db::get_message_preview_source(&s.db.lock().unwrap(), &msg_id).ok_or("消息不存在")?;
    let path = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| {
            v.get("path")
                .and_then(|p| p.as_str())
                .map(|p| p.to_string())
        })
        .ok_or("元数据缺少路径")?;

    let file = std::fs::canonicalize(&path).map_err(|_| "文件不存在".to_string())?;
    let under_downloads = std::fs::canonicalize(&s.downloads_dir)
        .map(|dir| file.starts_with(dir))
        .unwrap_or(false);
    if !under_downloads && sender_id != s.device_id {
        return Err("路径越权".to_string());
    }
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("非普通文件".to_string());
    }
    if meta.len() > max_bytes {
        return Err("TOO_LARGE".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 清除所有聊天数据（保留好友、身份、设置）。
/// SQLite 删除使用 transaction，任一失败则 rollback。
/// 文件系统清理在 DB commit 成功后执行；文件删除失败不影响 DB 结果。
#[tauri::command]
pub fn clear_all_data(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let s = state.inner();

    // 1. SQLite 删除（transaction 保护）
    {
        let dbc = s.db.lock().unwrap();
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM group_members", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM groups", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM messages", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM conversations", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM outbox", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM file_transfers", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM pending_reads", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM group_reads", [])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM settings WHERE key LIKE 'gk:%'", [])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    // 2. Runtime state 清理
    s.pending_requests.lock().unwrap().clear();
    s.group_keys.lock().unwrap().clear();
    s.pending_reads.lock().unwrap().clear();
    s.pending_file_accept.lock().unwrap().clear();
    s.pending_share_tree.lock().unwrap().clear();
    *s.relay.lock().unwrap() = crate::relay_manager::RelayManager::new();
    // 先关闭未完成接收的文件句柄，再清理 downloads 目录中的 .part 临时文件。
    s.file_receivers.lock().unwrap().clear();

    // 3. 文件系统清理（DB commit 成功后执行）
    //    收集错误而非立即返回，避免文件清理失败伪装成"整个操作失败"
    let mut fs_errors: Vec<String> = Vec::new();

    // 清空 cache_dir 内容（保留目录本身）
    if s.cache_dir.exists() {
        for entry in std::fs::read_dir(&s.cache_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            let result = if p.is_file() {
                std::fs::remove_file(&p)
            } else if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                Ok(())
            };
            if let Err(e) = result {
                fs_errors.push(format!("cache_dir: {} ({})", p.display(), e));
            }
        }
    }
    // 清空 downloads_dir 内容（保留目录本身）
    if s.downloads_dir.exists() {
        for entry in std::fs::read_dir(&s.downloads_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            let result = if p.is_file() {
                std::fs::remove_file(&p)
            } else if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                Ok(())
            };
            if let Err(e) = result {
                fs_errors.push(format!("downloads_dir: {} ({})", p.display(), e));
            }
        }
    }

    if fs_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "数据记录已清除，但部分缓存文件未能删除：{}",
            fs_errors.join("；")
        ))
    }
}

/// 搜索消息：返回匹配关键词的会话列表及其最新匹配消息。
#[tauri::command]
pub fn search_messages(
    state: State<'_, Arc<AppState>>,
    keyword: String,
) -> Result<Vec<SearchResult>, String> {
    let s = state.inner();
    // 搜索关键词长度保护：按字符截断（UTF-8 安全）
    let keyword: String = keyword.chars().take(MAX_SEARCH_LEN).collect();
    let dbc = s.db.lock().unwrap();
    let conv_ids = db::search_messages(&dbc, &keyword, 20).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for conv_id in conv_ids {
        // 获取会话名称
        let name = db::get_friend(&dbc, &conv_id)
            .map(|(n, _)| n)
            .unwrap_or_else(|| conv_id.clone());
        // 获取最新匹配消息
        let msgs = db::search_messages_in_conv(&dbc, &conv_id, &keyword, 1).unwrap_or_default();
        if let Some(m) = msgs.into_iter().next() {
            results.push(SearchResult {
                conv_id,
                name,
                match_content: m.content,
                match_ts: m.ts,
            });
        }
    }
    Ok(results)
}

#[derive(Serialize)]
pub struct SearchResult {
    conv_id: String,
    name: String,
    match_content: String,
    match_ts: i64,
}

fn preview(kind: &str, content: &str) -> String {
    match kind {
        "file" => "[文件]".to_string(),
        "image" => "[图片]".to_string(),
        "code" => "[代码]".to_string(),
        _ => {
            let count = content.chars().count();
            let c: String = content.chars().take(30).collect();
            if count > 30 {
                format!("{c}…")
            } else {
                c
            }
        }
    }
}
