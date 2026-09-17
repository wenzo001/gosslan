//! Tauri 命令层：前端调用的所有后端入口。

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

/// 业务输入长度限制（按字符数，非字节数）
const MAX_NICKNAME_LEN: usize = 40;
pub const MAX_GROUP_NAME_LEN: usize = 40;
const MAX_SEARCH_LEN: usize = 100;
/// 单条消息内容上限（按**字符数**，非字节数）。UTF-8 下一个中文字符 3 字节，
/// 5 万字符对应最大约 150 KB 落库——足够覆盖任何真实聊天输入，又不可能被
/// "一次粘贴"撑爆数据库。
///
/// ⚠️ 超限必须**报错拒发**，绝不能 `chars().take()` 静默截断：静默截断会让用户
/// 以为整段发出去了，实际对方只收到前半段，且本机不留任何痕迹（违反
/// AI_RULES INV-005「不允许静默丢失」）。与 `MAX_OUTGOING_IMAGE_BYTES`
/// 「超限一律报错拒发，绝不静默截断」的既有约定一致。
const MAX_MESSAGE_LEN: usize = 50_000;

/// 校验单条消息内容长度，超限返回面向用户的明确错误（不修改内容）。
fn check_message_content(content: String) -> Result<String, String> {
    let len = content.chars().count();
    if len > MAX_MESSAGE_LEN {
        return Err(format!(
            "消息过长（{len} 字符，上限 {MAX_MESSAGE_LEN} 字符）。请分段发送，或改用文件发送。"
        ));
    }
    Ok(content)
}
/// 粘贴/拖拽图片的解码后字节上限。Base64 解码后 ≈ 3/4 字符数，
/// 8 MiB 对应约 11 MB data URL，封框后仍远低于传输层 MAX_FRAME(64 MiB)。
/// 超限一律报错拒发，绝不静默截断。
const MAX_OUTGOING_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// 头像（base64 data URI）解码后字节上限。头像经前端中心裁剪 + 缩放到 512×512 后再上传，
/// 正常远小于 2 MiB；此处作为兜底，防止超大/恶意 data URL 撑爆 SQLite 与 UDP 发现广播。
const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

use crate::crypto;
use crate::db;
use crate::discovery::routed::{
    encode_endpoints, parse_endpoint_addr, parse_endpoints, RoutedEndpoint, ROUTED_ENDPOINTS_KEY,
};
use crate::export;
use crate::logging::LogEntry;
use crate::network::transport::{
    broadcast_gossip, get_group_key, mark_pending_group_key, maybe_update_friend,
    resolve_member_x25519, resolve_nickname, try_send,
};
use crate::network::{self, file};
use crate::protocol::{GossipKind, Message, MsgKind, ShareEntry};
use crate::state::{
    AppState, BleRuntimeFacts, Conversation, DeviceInfo, Friend, Group, GroupFile, InterfaceInfo,
    MessageRecord, Peer, PendingRequest, RuntimeSnapshot, TopologyInfo, TransferInfo,
};
use crate::storage::cache_cleaner::{self, CachePolicy, CleanupReport};
use crate::transport::TransportManager;

/// 存储占用与清理策略（设置页「存储与缓存」展示）。
///
/// ⚠️ 统计的是**真实落盘的媒体**（「文件存储目录」里接收的图片 / 文件）+ 聊天数据库，
/// 而不是历史遗留的 `cache/` 目录：P1 重构后媒体改落 downloads，`cache/` 已无写入方，
/// 只统计它会让「聊了半天还是 0 个文件」，用户完全看不懂。
#[derive(Serialize)]
pub struct CacheInfo {
    /// 已接收的图片 / 文件：文件数与合计占用
    media_count: usize,
    media_bytes: u64,
    /// 聊天记录数据库占用（含 -wal/-shm）
    db_bytes: u64,
    retention_days: Option<u32>,
    max_bytes: Option<u64>,
}

#[derive(Serialize)]
pub struct GroupReadInfo {
    pub reader_id: String,
    pub last_read_ts: i64,
}

// ---------------- 本机信息与配置 ----------------

#[tauri::command(async)]
pub fn get_device_info(state: State<'_, Arc<AppState>>) -> DeviceInfo {
    let s = state.inner();
    DeviceInfo {
        device_id: s.device_id.clone(),
        nickname: s.nickname.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        avatar: s.avatar.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        device_type: crate::protocol::current_device_type().to_string(),
        tcp_port: s.tcp_port,
        online: s
            .network
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some(),
        x25519_pubkey: s.identity.x25519_public_b64(),
        ed25519_pubkey: s.identity.ed25519_public_b64(),
    }
}

/// 头像 data URL 解码后字节数；非法 base64 返回 usize::MAX（视为超限拒绝）。
fn avatar_decoded_len(data_url: &str) -> usize {
    let payload = data_url.split_once(',').map(|(_, p)| p).unwrap_or(data_url);
    STANDARD
        .decode(payload)
        .map(|b| b.len())
        .unwrap_or(usize::MAX)
}

#[tauri::command]
pub async fn update_profile(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    nickname: String,
    avatar: Option<String>,
) -> Result<DeviceInfo, String> {
    let s = state.inner();
    // 昵称长度保护：按字符截断（UTF-8 安全）
    let nickname: String = nickname.chars().take(MAX_NICKNAME_LEN).collect();
    // 头像大小兜底：超限直接拒绝，防止超大 base64 落库 / 撑爆 UDP 广播
    if let Some(a) = &avatar {
        if avatar_decoded_len(a) > MAX_AVATAR_BYTES {
            return Err("头像过大，请压缩到 2MB 以内".to_string());
        }
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_setting(&dbc, "nickname", &nickname).map_err(|e| e.to_string())?;
        if let Some(a) = &avatar {
            db::set_setting(&dbc, "avatar", a).map_err(|e| e.to_string())?;
        }
    }
    *s.nickname.lock().unwrap_or_else(|e| e.into_inner()) = nickname.clone();
    *s.avatar.lock().unwrap_or_else(|e| e.into_inner()) = avatar.clone();

    // 资料帧要不要降级到 bulk 通道：判据与 is_bulk_message 同一份常量，避免两处漂移。
    let bulk_profile_frame = avatar
        .as_deref()
        .is_some_and(|a| a.len() > crate::network::transport::CONTROL_AVATAR_MAX_BYTES);
    let msg = Message::UserInfo {
        device_id: s.device_id.clone(),
        nickname,
        avatar,
        device_type: crate::protocol::current_device_type().to_string(),
    };
    // ⚠️ **锁内只做「取 + 克隆」，绝不 await**（与 `transport.rs` 心跳发送同一纪律）。
    //
    // 原先`let links = ...lock().await` 后就地 `tx.send().await`：这些都是**有界**队列
    // （1024），对端僵死（半开 TCP / 休眠 / 写缓冲满）时 `send().await` 会一直挂起，
    // 而它**握着全局 links 锁** ⇒ 所有 try_send、心跳、get_peers、mark_peer_offline、
    // teardown_link 以及看门狗全部阻塞。看门狗恰恰是唯一能发 cancel 拆掉那条卡死连接、
    // 让队列排空的机制 —— 它被同一把锁挡住，形成自锁死循环，只能靠用户手动重开局域网。
    let targets = {
        let links = s.links.lock().await;
        links
            .values()
            .flatten()
            // 大头像资料帧走 bulk 通道：2MB 头像在 BLE 上要分上千片，绝不能堵住聊天/好友
            // 请求的优先道；小头像仍走 priority（资料变更要立刻可见）。
            .map(|link| {
                if bulk_profile_frame {
                    link.bulk.clone()
                } else {
                    link.priority.clone()
                }
            })
            .collect::<Vec<_>>()
    };
    for tx in &targets {
        let _ = tx.send(msg.clone()).await;
    }

    // 昵称/头像变更：另一个窗口的资料区要跟着刷新。
    // 这两个键不在 `Settings` 形状里（它们是"资料"），所以 patch 里不放值 ——
    // 接收方看到键名会自己定向重拉一次 device_info（见前端 applySettingsPatch）。
    state.notify_settings_changed(&["nickname", "avatar"], Some(window.label()), json!({}));
    Ok(DeviceInfo {
        device_id: s.device_id.clone(),
        nickname: s.nickname.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        avatar: s.avatar.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        device_type: crate::protocol::current_device_type().to_string(),
        tcp_port: s.tcp_port,
        online: s
            .network
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some(),
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub async fn start_network(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    bind_ip: String,
) -> Result<RuntimeSnapshot, String> {
    let arc = state.inner().clone();
    network::start(arc.clone(), bind_ip).await?;
    {
        // 作用域块：MutexGuard 在 await 之前就结束（否则 async 命令的 future 不是 Send）
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_lan_enabled(&dbc, true).map_err(|e| e.to_string())?;
    }
    // 起网络也是一次"运行状态变了"：返回快照给发起窗口，同时广播给其它窗口
    let snap = build_runtime_snapshot(&arc).await;
    arc.notify_runtime_changed(snap.clone(), Some(window.label()));
    Ok(snap)
}

#[tauri::command(async)]
pub async fn stop_network(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<RuntimeSnapshot, String> {
    let arc = state.inner().clone();
    network::stop(&arc).await;
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_lan_enabled(&dbc, false).map_err(|e| e.to_string())?;
    }
    let snap = build_runtime_snapshot(&arc).await;
    arc.notify_runtime_changed(snap.clone(), Some(window.label()));
    Ok(snap)
}

#[tauri::command(async)]
pub async fn get_peers(state: State<'_, Arc<AppState>>) -> Result<Vec<Peer>, String> {
    let mut peers: Vec<Peer> = state
        .inner()
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    peers.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    fill_peer_links(state.inner(), &mut peers).await;
    Ok(peers)
}

/// 给 peer 列表补上**实际链路类型**（`Peer::link`）。
///
/// 为什么在命令里补、而不是让事件也带：`links` 是**异步锁**（tokio::Mutex），
/// 而节点表推送（`peers-updated`）是同步上下文 —— 那里的 `Peer::link` 恒为 None。
/// 界面只把"字段存在且是 bluetooth"当作**真的蓝牙直连**；
/// 以前用 `ip || 蓝牙直连` 反推，会把同一 Tailscale 网段（Routed）的设备也标成蓝牙直连
/// （用户 2026-09-12 实测）。
async fn fill_peer_links(s: &Arc<AppState>, peers: &mut [Peer]) {
    let kinds: std::collections::HashMap<String, Vec<crate::mesh::PathKind>> = {
        let links = s.links.lock().await;
        links
            .iter()
            .map(|(id, ls)| (id.clone(), ls.iter().map(|l| l.path_kind).collect()))
            .collect()
    };
    for p in peers.iter_mut() {
        p.link = kinds
            .get(&p.device_id)
            .and_then(|k| crate::state::best_link_kind(k))
            .map(|k| k.as_str().to_string());
    }
}

/// 按需探测周围在线节点：群发一次 `who_has`，等待约 1.5s 收集单播回复后返回当前节点表。
/// 仅在用户打开「添加好友」时调用，避免启动时持续全网扫描。
///
/// ⚠️ 2026-09-13：**同时触发一次 BLE 立刻扫描**。用户实测的体感是"蓝牙搜不到"，
/// 而真因是 BLE 的周期扫描（当时 10s 一轮）与用户动作**完全错开** ——
/// 点开「添加好友」后最多要等一整个周期才可能看到对端。
/// 蓝牙那条路没有 `who_has` 这种"喊一声"的机制，能做的最接近的事就是**立刻扫一轮**。
#[tauri::command]
pub async fn search_nearby_peers(state: State<'_, Arc<AppState>>) -> Result<Vec<Peer>, String> {
    let s = state.inner();
    // 触发一次探测（若网络已启动）
    let triggered = if let Some(tx) = s.probe.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let next = tx.borrow().saturating_add(1);
        let _ = tx.send(next);
        true
    } else {
        false
    };
    // 让 BLE 也立刻扫一轮（通道没开时返回 false，不影响 LAN 那条路）
    #[cfg(feature = "bluetooth")]
    let ble_triggered = crate::network::ble::trigger_scan_now(s);
    #[cfg(not(feature = "bluetooth"))]
    let ble_triggered = false;
    // 等待节点单播回复（BLE 的扫描窗口是 2s，所以这里取 2s：两边都覆盖得到）
    if triggered || ble_triggered {
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }
    let mut peers: Vec<Peer> = s
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    peers.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    fill_peer_links(s, &mut peers).await;
    Ok(peers)
}

/// 更新「应用是否在前台且窗口聚焦」（用户 2026-09-13 的功耗策略）。
///
/// 前端在 `visibilitychange`（页面是否可见）与 `focus` / `blur`（PC 窗口是否聚焦）时调用。
/// 蓝牙扫描循环据此在快/慢节奏间切换：
///   · 前台 / 聚焦 ⇒ 5s 一轮（发现更快，加好友不用干等）；
///   · 后台 / 失焦 ⇒ 30s 一轮（省电；好友申请仍能最终到达）；
///   · 进程退出 / 被系统杀死 ⇒ 扫描任务随进程消失，无需额外代码。
///
/// 从后台变回前台时额外 **wake** 一次扫描，立刻补一轮，而不是等完当前慢周期。
#[tauri::command(async)]
pub fn set_app_active(state: State<'_, Arc<AppState>>, active: bool) {
    use std::sync::atomic::Ordering;
    let s = state.inner();
    if s.app_active.swap(active, Ordering::Relaxed) == active {
        return;
    }
    #[cfg(feature = "bluetooth")]
    {
        crate::network::ble::wake_scan(s);
        s.logger.info(
            "ble",
            format!(
                "[SCAN] 应用{} ⇒ 扫描节奏切换为 {}",
                if active {
                    "回到前台/聚焦"
                } else {
                    "进入后台/失焦"
                },
                if active { "5s" } else { "30s" }
            ),
        );
    }
}

/// 从后台唤起并聚焦主窗口（冷启动首显 / 点击系统通知 / 消息点击唤起）。
#[cfg(desktop)]
#[tauri::command(async)]
pub fn focus_window(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口不存在".to_string());
    };
    // 冷启动白闪修复：窗口 show 的第一帧会露出 WebView2 的默认背景色（tauri.conf.json
    // 写死浅色 #edf1f6）。暗色主题用户在骨架合成前会看到"闪一下白"。show 之前把窗口
    // 底色改成跟随主题（浅 #edf1f6 / 深 #0b1220，与 body 的 --gosslan-app-bg 一致），
    // 第一帧即正确底色而非浅色。dark_mode 是"解析后的结果"（跟随系统时已按系统偏好算好），
    // 冷启动直接可用。
    let dark = {
        let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_setting(&dbc, "dark_mode")
            .map(|v| v == "1")
            .unwrap_or(false)
    };
    let color = if dark {
        tauri::window::Color(11, 18, 32, 255) // #0b1220
    } else {
        tauri::window::Color(237, 241, 246, 255) // #edf1f6
    };
    let _ = win.set_background_color(Some(color));
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

/// 桌面消息通知：前端在"应用在后台 / 正在看别的会话"时调用。
///
/// 走 crate::notifications（能返回真实错误），并**再判一次总开关**（前端已判，这里是
/// 第二道闸门：后端也能独立触发通知，不能只依赖前端状态）。返回 false 表示用户关了通知。
///
/// `conv_id` = 这条通知属于哪个会话：用户**点通知**时（Windows 上由 notify-rust 的
/// handle 捕获）后端唤起主窗口并把这个 id 发给前端，前端据此直接定位过去。
/// 没有它就只能"唤起窗口但停在原来的会话上"——用户报的正是这个。
#[tauri::command(async)]
pub fn notify_desktop(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    title: String,
    body: String,
    conv_id: String,
) -> Result<bool, String> {
    let s = state.inner().clone();
    let click_app = app.clone();
    crate::notifications::show_click_if_enabled(
        &s,
        &title,
        &body,
        std::collections::HashMap::new(),
        move || crate::notifications::on_notification_clicked(&click_app, "chat", Some(conv_id)),
    )
}

/// 设置页「发送测试通知」：忽略总开关（用户显式要试），但**如实返回失败原因**。
///
/// 为什么需要：Windows 上通知失败可能完全静默（未安装的 exe 没注册 AUMID、专注助手/勿扰、
/// 系统里把 Gosslan 的通知关了）。没有这个入口，用户只能描述"收不到"，我们无法判断是
/// 应用链路问题还是系统设置问题。
#[tauri::command(async)]
pub fn send_test_notification(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let s = state.inner();
    match crate::notifications::show(
        &s.app,
        "Gosslan 测试通知",
        "如果你看到这条系统通知，说明通知链路正常。",
    ) {
        Ok(()) => {
            s.logger.info("notify", "测试通知已发送");
            Ok(crate::notifications::platform_hint().to_string())
        }
        Err(e) => {
            s.logger.warn("notify", format!("测试通知发送失败：{e}"));
            Err(format!("{e}。{}", crate::notifications::platform_hint()))
        }
    }
}

/// 网络拓扑摘要：节点数、中继数、平均时延。
#[tauri::command(async)]
pub fn get_topology(state: State<'_, Arc<AppState>>) -> TopologyInfo {
    let s = state.inner();
    let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
    let node_count = peers.len();
    let rtts: Vec<u64> = peers.values().filter_map(|p| p.rtt_ms).collect();
    let avg_rtt_ms = if rtts.is_empty() {
        None
    } else {
        Some(rtts.iter().sum::<u64>() / rtts.len() as u64)
    };
    let relay_count = s
        .relay
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .active_sends();
    let online = s
        .network
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    TopologyInfo {
        node_count,
        relay_count,
        avg_rtt_ms,
        online,
    }
}

// ---------------- 开发者诊断（隐藏面板用，只读不改网络行为） ----------------

/// 同步收集蓝牙通道事实（诊断面板用）。
///
/// 为什么不用 `network::ble::runtime_state`（那个是 async）：本函数在**同步命令**里跑，
/// 而 `state.links` 是 `tokio::sync::Mutex`。这里用 `try_lock` 尽力而为 —— 拿不到锁就把
/// 对端数留成通道给的值（下一轮刷新会补上），诊断面板绝不能因为统计而阻塞网络。
fn collect_ble_diag(s: &Arc<AppState>) -> crate::state::BleDiag {
    let mut d = crate::state::BleDiag {
        feature_compiled: cfg!(feature = "bluetooth"),
        activity: "idle".into(),
        ..Default::default()
    };
    // 通道 available / enabled：与 `RuntimeSnapshot` 完全同一口径（唯一真相源）。
    if let Some(bt) = TransportManager::new(s.clone())
        .status()
        .into_iter()
        .find(|c| c.channel == "bluetooth")
    {
        d.available = bt.available;
        d.enabled = bt.enabled;
        d.running = bt.running;
        d.peers = bt.peers;
    }
    #[cfg(feature = "bluetooth")]
    {
        // 链路表口径的"已建链对端数"：比通道计数更准，也不依赖那个占位 Transport 实现。
        d.peers = s
            .links
            .try_lock()
            .map(|links| {
                links
                    .values()
                    .filter(|ls| {
                        ls.iter()
                            .any(|l| l.path_kind == crate::mesh::PathKind::Bluetooth)
                    })
                    .count()
            })
            .unwrap_or(d.peers);
        d.running = s.ble.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        // 与通道同口径：起不来就是关（用户在设置里点的开，其实就是"真的在跑"）。
        d.enabled = d.running;
        d.available = d.available || d.running;
        d.no_dial = s
            .ble_no_dial
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        let now = crate::db::now_ms();
        let mut backoff: Vec<crate::state::BleBackoff> = s
            .ble_dial_failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, (failures, next))| crate::state::BleBackoff {
                id: id.clone(),
                failures: *failures,
                remaining_ms: (*next - now).max(0),
            })
            .collect();
        backoff.sort_by(|a, b| b.remaining_ms.cmp(&a.remaining_ms));
        d.backoff = backoff;
        let active = s.app_active.load(std::sync::atomic::Ordering::Relaxed);
        d.activity = if active {
            "active".into()
        } else {
            "idle".into()
        };
        d.scan_window_ms = crate::network::ble::scan_window_ms();
        d.scan_interval_ms = crate::network::ble::scan_interval_ms(active);
        let stats = *s.ble_scan.lock().unwrap_or_else(|e| e.into_inner());
        d.last_scan_ts = stats.last_ts;
        d.last_scan_total = stats.total;
        d.last_scan_matched = stats.matched;
    }
    d
}

/// 蓝牙候选行的一句话状态（诊断面板「候选链路」表里显示）。
fn ble_candidate_detail(d: &crate::state::BleDiag) -> String {
    if !d.feature_compiled {
        return "本次构建未编译蓝牙特性".into();
    }
    if !d.running {
        return if d.available {
            "未开启".into()
        } else {
            "不可用（无适配器或未授权）".into()
        };
    }
    let cadence = if d.activity == "active" {
        "前台"
    } else {
        "后台"
    };
    format!(
        "运行中 · {}节奏（{}s 扫描 / {}s 间隔）· {} 个对端",
        cadence,
        d.scan_window_ms / 1000,
        d.scan_interval_ms / 1000,
        d.peers
    )
}

/// 收集候选链路（网卡 + 蓝牙），供诊断面板展示自动选择逻辑的实际数据。
///
/// 用户 2026-09-13：「网卡-候选 也可以加上蓝牙」—— 于是蓝牙作为**一条候选**进同一张表，
/// 但它的字段语义与网卡不同（没有 IP / 广播 / RFC1918 / 虚拟网卡），
/// 所以用 `kind` 区分、用 `detail` 说人话，前端按 kind 渲染不同列。
///
/// `bt` 由调用方传入（一次采集、两处共用）：既省一次锁，也保证「候选表里的蓝牙行」
/// 与「蓝牙卡片」说的是**同一时刻**的状态。
fn collect_candidates(bt: &crate::state::BleDiag) -> Vec<crate::state::InterfaceCandidate> {
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
                    kind: "lan".into(),
                    name: i.name.clone(),
                    ip: ip.to_string(),
                    has_broadcast: has_bc,
                    broadcast: v4.broadcast.map(|b| b.to_string()),
                    is_rfc1918: rfc,
                    is_virtual: virt_ip || virt_name,
                    score,
                    selected: false, // 由调用方根据实际 bind_ip 设置
                    detail: String::new(),
                });
            }
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.ip.cmp(&b.ip)));

    // 蓝牙作为一条候选排在网卡后面（它不是"第 N 张网卡"，是另一条链路）。
    out.push(crate::state::InterfaceCandidate {
        kind: "bluetooth".into(),
        name: "蓝牙（BLE）".into(),
        ip: String::new(),
        has_broadcast: false,
        broadcast: None,
        is_rfc1918: false,
        is_virtual: false,
        score: 0,
        selected: bt.running,
        detail: ble_candidate_detail(bt),
    });
    out
}

/// 获取网络诊断状态（供隐藏开发者面板展示）。
///
/// 数据分两块，**互不冒充**：`mode`/`bound_ip`/… 只描述局域网；蓝牙在 `bluetooth` 里
/// 独立描述。纯蓝牙用户不会再看到"整机 offline"（用户 2026-09-13 的反馈）。
/// 「最近事件」已合并进运行日志，这里不再返回（见 `AppState::push_diag_event`）。
#[tauri::command(async)]
pub fn get_discovery_diag(state: State<'_, Arc<AppState>>) -> crate::state::DiscoveryDiag {
    let s = state.inner();
    let mut result = s.diag.lock().unwrap_or_else(|e| e.into_inner()).clone();
    {
        let net = s.network.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref h) = *net {
            result.mode = if h.bound_ip == "0.0.0.0" {
                "auto".into()
            } else {
                "manual".into()
            };
            // auto 模式下 Discovery 实际绑定的是真实 LAN IP，而不是 0.0.0.0。
            // tcp_listen 仍使用用户配置的地址（TCP 监听地址）。
            result.bound_ip = if h.actual_bound_ip.is_empty() {
                h.bound_ip.clone()
            } else {
                h.actual_bound_ip.clone()
            };
            result.tcp_listen = format!("{}:{}", h.bound_ip, h.tcp_port);
            result.udp_port = crate::protocol::UDP_PORT;
        } else {
            result.mode = "offline".into();
        }
    }
    // 候选链路（网卡 + 蓝牙）一次给全：面板只调一个命令，不会出现"两个命令数据不一致"。
    // 蓝牙事实只采集一次，候选表与蓝牙卡片共用同一份（保证同一时刻的状态）。
    let bt = collect_ble_diag(s);
    result.candidates = collect_candidates(&bt);
    result.bluetooth = bt;
    result
}

/// 获取候选链路列表（网卡 + 蓝牙，含评分）。
#[tauri::command(async)]
pub fn get_interface_candidates(
    state: State<'_, Arc<AppState>>,
) -> Vec<crate::state::InterfaceCandidate> {
    let bt = collect_ble_diag(state.inner());
    collect_candidates(&bt)
}

// ---------------- 双通道与缓存 ----------------

/// 局域网 / 蓝牙通道状态（设置页开关 + 「添加好友」页的就地开关共用这一份）。
///
/// ⚠️ 蓝牙的 `running` / `peers` 必须取**真实运行时**（`network::ble`），不能采信
/// `TransportManager` 里那个占位 `BluetoothTransport`（它的 running 恒 false）——
/// 否则界面永远显示"未运行"，用户点了开关也看不出变化。
/// 「enabled」也一律以真实运行为准：起不来就是关（这样界面与用户预期一致，
/// 也能让他再点一次重试，而不是假装已经打开）。
///
/// 返回 `Result` 是 Tauri 的硬性要求（async 命令带 `State<'_>` 引用参数时必须返回 Result），
/// 前端侧不受影响（`invoke` 拿到的是 `Ok` 里的数组，永远不返回 `Err`）。
/// 默认昵称（按 `nickname.rs` 的规则由 device_id 派生）。
///
/// 给"恢复默认"用：前端不该再写死一份默认名文案（那是旧规则 `hostname` 的遗留），
/// 否则"恢复默认"得到的名字与首次安装得到的名字会不一致。
#[tauri::command(async)]
pub fn default_nickname(state: State<'_, Arc<AppState>>) -> String {
    crate::nickname::default_nickname(&state.inner().device_id)
}

/// **运行状态的唯一采集点**（用户要求的第 ② 项）。
///
/// 把所有"运行状态"一次读全：通道（lan/bluetooth 的 enabled/available/running/peers）、
/// 局域网是否在跑 + 绑定地址、蓝牙事实、在线节点数。任何"运行状态变了"的地方
/// （通道开关 / 起停网络）都调它一次，然后：
///   · 命令把它**作为返回值**给发起窗口（发起窗口零额外 IPC）；
///   · `notify_runtime_changed` 把它**作为事件载荷**发给其它窗口。
/// 于是一件事只有一份前端状态（`RuntimeSnapshot`），不可能再各说各话。
pub async fn build_runtime_snapshot(s: &Arc<AppState>) -> RuntimeSnapshot {
    let mut list = TransportManager::new(s.clone()).status();
    #[cfg(feature = "bluetooth")]
    let (bt_running, bt_peers) = crate::network::ble::runtime_state(s).await;
    #[cfg(not(feature = "bluetooth"))]
    let (bt_running, bt_peers) = (false, 0usize);
    if let Some(bt) = list.iter_mut().find(|c| c.channel == "bluetooth") {
        bt.running = bt_running;
        bt.peers = bt_peers;
        bt.enabled = bt_running;
    }
    // 持久化偏好必须与“此刻是否在跑”分开表达：应用刚启动时 BLE 还没拉起，enabled/running
    // 都是 false，前端无法据此区分“用户明确关掉”与“尚未启动”⇒ 自动拉起会覆盖用户的关闭选择
    // （真机 2026-09-14：关掉蓝牙、退出重进又被打开）。get_*_enabled 在键缺失时会顺手落默认值
    // （首次安装 ⇒ 默认开）。
    {
        let (lan_pref, bt_pref) = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            (
                crate::db::get_lan_enabled(&dbc),
                crate::db::get_bt_enabled(&dbc),
            )
        };
        for c in list.iter_mut() {
            match c.channel {
                "lan" => c.preferred = lan_pref,
                "bluetooth" => c.preferred = bt_pref,
                _ => {}
            }
        }
    }
    let (online, bound_ip) = {
        let net = s.network.lock().unwrap_or_else(|e| e.into_inner());
        (net.is_some(), net.as_ref().map(|n| n.bound_ip.clone()))
    };
    let peer_count = s.peers.lock().unwrap_or_else(|e| e.into_inner()).len();
    // 我的在线状态 = **任一通道在跑**（用户规则：两个都关才是离线）。
    // 注意用 `running` 而不是 `enabled`：开关打开但起不来（如权限被拒）不该算在线。
    let present = list.iter().any(|c| c.running);
    RuntimeSnapshot {
        present,
        channels: list,
        online,
        bound_ip,
        ble: BleRuntimeFacts {
            feature_compiled: cfg!(feature = "bluetooth"),
        },
        peer_count,
    }
}

/// 取当前运行状态快照（窗口初始化 / 手动刷新用）。
#[tauri::command(async)]
pub async fn get_runtime_snapshot(
    state: State<'_, Arc<AppState>>,
) -> Result<RuntimeSnapshot, String> {
    Ok(build_runtime_snapshot(state.inner()).await)
}

/// 蓝牙通道「开关意图」的最后一次值：`1` = 开，`0` = 关，`-1` = 还没有请求。
///
/// 为什么需要：冷却期内到达的新意图**不能丢**（见 [`apply_bluetooth_switch`]）。
#[cfg(feature = "bluetooth")]
static BT_DESIRED: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// 上一次**真的**启停过蓝牙的时刻（毫秒；0 = 从未启停过）。
#[cfg(feature = "bluetooth")]
static BT_LAST_TRANSITION_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 蓝牙启停的串行锁：同一时刻只有一次真实启停，后到的请求**排队**（而不是被丢掉）。
#[cfg(feature = "bluetooth")]
static BT_SWITCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 两次**真实**启停之间的最小间隔（防抖；见 [`bt_switch_plan`]）。
#[cfg(feature = "bluetooth")]
const BT_SWITCH_COOLDOWN_MS: u64 = 3_000;

/// 一次蓝牙启停请求的决策结果（纯数据，便于单测）。
#[cfg(feature = "bluetooth")]
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BtSwitchPlan {
    /// 动手之前要等的毫秒数（0 = 立刻动手）
    pub wait_ms: u64,
    /// 是否需要**真的**启停蓝牙栈（false = 幂等命中，或已被更新的意图取代）
    pub apply: bool,
    /// 不做 / 等待的原因（写日志用）
    pub reason: &'static str,
}

/// 决定"这次蓝牙开关请求该不该动蓝牙栈"。
///
/// 顺序即优先级（三条都是真机事故换来的）：
/// 1. **已被更新的意图取代** ⇒ 什么都不做 —— 那次更新的请求会执行。
///    这是"意图合并"的关键：用户"关了立刻又开"时，最后一次意图一定会被执行到。
/// 2. **运行状态已经是目标状态** ⇒ 幂等，不碰蓝牙栈（用户 2026-09-12 的抖动事故：
///    每秒十几次 `启动→停止→启动` 会把 CoreBluetooth 的 GATT server + 广播反复拆建，
///    CPU 与蓝牙栈被打满 ⇒ 整个应用顿卡、连局域网消息都变慢）。
/// 3. **距上次真实启停不足冷却** ⇒ **等够了再做**（`wait_ms`），不是丢弃。
///    旧实现是"丢弃"（`忽略高频蓝牙通道切换请求`）：用户"关一下马上又开"会静默少执行一次，
///    表现就是"点了没反应"（用户 2026-09-13）。
#[cfg(feature = "bluetooth")]
pub(crate) fn bt_switch_plan(
    running: bool,
    enabled: bool,
    desired: Option<bool>,
    last_ms: u64,
    now_ms: u64,
    cooldown_ms: u64,
) -> BtSwitchPlan {
    if desired != Some(enabled) {
        return BtSwitchPlan {
            wait_ms: 0,
            apply: false,
            reason: "已被更新的开关意图取代",
        };
    }
    if running == enabled {
        return BtSwitchPlan {
            wait_ms: 0,
            apply: false,
            reason: "运行状态已经是目标状态（幂等）",
        };
    }
    let wait_ms = if last_ms == 0 {
        0
    } else {
        cooldown_ms.saturating_sub(now_ms.saturating_sub(last_ms))
    };
    BtSwitchPlan {
        wait_ms,
        apply: true,
        reason: if wait_ms > 0 {
            "冷却期内，排队等待"
        } else {
            "立刻启停"
        },
    }
}

/// 执行一次蓝牙开关（**意图合并 + 冷却排队 + 幂等**）。
///
/// ⚠️ 调用方 `await` 它，但**前端不该等它**（用户 2026-09-13 的规则：乐观更新优先）：
/// 这里可能为了合并抖动等满一个冷却周期（最多 3s）。
#[cfg(feature = "bluetooth")]
async fn apply_bluetooth_switch(s: &Arc<AppState>, enabled: bool) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    // 先记意图（不需要锁）：排队醒来后要靠它判断"自己还是不是最新意图"
    BT_DESIRED.store(if enabled { 1 } else { 0 }, Ordering::Relaxed);
    // 串行化：同一时刻只有一次真实启停，后来者在这里排队
    let _guard = BT_SWITCH_LOCK.lock().await;
    for _ in 0..3 {
        let running = s.ble.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        let now = db::now_ms().max(0) as u64;
        let desired = match BT_DESIRED.load(Ordering::Relaxed) {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        };
        let plan = bt_switch_plan(
            running,
            enabled,
            desired,
            BT_LAST_TRANSITION_MS.load(Ordering::Relaxed),
            now,
            BT_SWITCH_COOLDOWN_MS,
        );
        if !plan.apply {
            s.logger.info(
                "ble",
                format!(
                    "蓝牙通道开关：{}（运行中={running}，请求={enabled}）",
                    plan.reason
                ),
            );
            break;
        }
        if plan.wait_ms > 0 {
            // **排队而不是丢弃**：用户"关了又马上开"时，最后那次意图一定会被执行到
            s.logger.info(
                "ble",
                format!(
                    "蓝牙通道开关进入冷却：等待 {}ms 后执行（合并抖动）",
                    plan.wait_ms
                ),
            );
            tokio::time::sleep(Duration::from_millis(plan.wait_ms)).await;
            continue; // 醒来重判：意图可能又被改过、运行状态也可能变过
        }
        BT_LAST_TRANSITION_MS.store(now, Ordering::Relaxed);
        s.logger.info(
            "ble",
            format!(
                "蓝牙通道切换：{} → {}",
                if running { "运行中" } else { "已停止" },
                if enabled { "开启" } else { "关闭" }
            ),
        );
        let result = if enabled {
            crate::network::ble::start(s.clone()).await
        } else {
            crate::network::ble::stop(s).await;
            Ok(())
        };
        if result.is_err() {
            // ⚠️ **失败要放行重试**：冷却的用途是挡住"成功之后又被反复切换"的抖动，
            // 不是挡住用户/前端的重试。真实缺陷（用户 4.1.9 实测）：
            // 第一次 `已停止 → 开启` 失败（当时安卓还缺 btleplug 的 Java 类），
            // 前端的自动重试落进 3s 冷却被丢掉 ⇒ 表现为"蓝牙没有默认开启"。
            BT_LAST_TRANSITION_MS.store(0, Ordering::Relaxed);
        }
        result?;
        break;
    }
    Ok(())
}

/// 切换通道开关。局域网复用 `network`；蓝牙后端未编译，开启时返回明确错误。
#[tauri::command(async)]
pub async fn set_channel_enabled(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    channel: String,
    enabled: bool,
) -> Result<RuntimeSnapshot, String> {
    let s = state.inner();
    match channel.as_str() {
        "lan" => {
            if enabled {
                // 绑定地址沿用用户已选网卡（settings.bind_ip），不再硬编码 0.0.0.0
                network::start_from_prefs(s.clone()).await?;
            } else {
                network::stop(s).await;
            }
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::set_lan_enabled(&dbc, enabled).ok();
        }
        "bluetooth" => {
            // 开了 feature 才真正启动 BLE 运行时；没开 feature 时与今天一致：
            // 只写偏好（并返回"后端未编译"的明确错误）。
            #[cfg(feature = "bluetooth")]
            {
                apply_bluetooth_switch(s, enabled).await?;
            }
            #[cfg(not(feature = "bluetooth"))]
            {
                if enabled {
                    let mut mgr = TransportManager::new(s.clone());
                    mgr.set_bluetooth_enabled(true).await?;
                }
            }
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::set_bt_enabled(&dbc, enabled).ok();
        }
        _ => return Err(format!("未知通道: {channel}")),
    }
    // 运行状态只在这里"变"：采一次快照 —— 发起窗口拿返回值（零额外 IPC），
    // 其余窗口拿事件载荷（`runtime-changed` 带快照）。两边拿到的是**同一份结构**。
    let snap = build_runtime_snapshot(s).await;
    s.notify_runtime_changed(snap.clone(), Some(window.label()));
    Ok(snap)
}

const RETENTION_KEY: &str = "cache_retention_days";
const MAX_BYTES_KEY: &str = "cache_max_bytes";

fn load_policy(s: &AppState) -> CachePolicy {
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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

/// 纳入统计与清理的目录：接收的图片/文件目录 + 历史遗留的 cache 目录。
/// 旧的 `cache/` 可能残留早期版本抽取的图片，一并纳入，避免"看不见也清不掉"。
fn media_dirs(s: &AppState) -> Vec<PathBuf> {
    let downloads = s
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    vec![downloads, s.cache_dir.clone()]
}

/// SQLite 数据库文件占用（含 -wal / -shm 两个伴随文件）。
fn db_file_bytes(s: &AppState) -> u64 {
    let base = s.db_path.to_string_lossy().to_string();
    let mut total = 0u64;
    for suffix in ["", "-wal", "-shm"] {
        if let Ok(m) = std::fs::metadata(format!("{base}{suffix}")) {
            total += m.len();
        }
    }
    total
}

/// 存储占用与当前清理策略。
#[tauri::command(async)]
pub fn get_cache_info(state: State<'_, Arc<AppState>>) -> CacheInfo {
    let s = state.inner();
    let policy = load_policy(s);
    let (media_count, media_bytes) = cache_cleaner::usage(&media_dirs(s));
    CacheInfo {
        media_count,
        media_bytes,
        db_bytes: db_file_bytes(s),
        retention_days: policy.retention_days,
        max_bytes: policy.max_bytes,
    }
}

/// 设置缓存清理策略（保留时长 / 磁盘配额；`None` 或 `0` 表示不限制）。
#[tauri::command(async)]
pub fn set_cache_policy(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    retention_days: Option<u32>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    let s = state.inner();
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    let d = retention_days.unwrap_or(0);
    db::set_setting(&dbc, RETENTION_KEY, &d.to_string()).map_err(|e| e.to_string())?;
    let m = max_bytes.unwrap_or(0);
    db::set_setting(&dbc, MAX_BYTES_KEY, &m.to_string()).map_err(|e| e.to_string())?;
    // patch 在**持锁时**读好（见 settings_patch_values 的调用约定），再放锁、再广播
    let changed = ["retentionDays", "maxBytes"];
    let patch = settings_patch_values(&dbc, &changed);
    drop(dbc);
    state.notify_settings_changed(&changed, Some(window.label()), patch);
    Ok(())
}

/// 立即执行一次清理：按保留时长 / 配额删除过期的图片与文件（含历史遗留 cache 目录），
/// 并对数据库执行 VACUUM。**不删除聊天文字**；被清理的图片/文件在历史消息里将无法再打开。
#[tauri::command(async)]
pub fn clean_cache_now(state: State<'_, Arc<AppState>>) -> CleanupReport {
    let s = state.inner();
    let policy = load_policy(s);
    let dirs = media_dirs(s);
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    cache_cleaner::clean(&dirs, policy, &dbc)
}

// ---------------- 应用偏好设置（本地持久化） ----------------

/// 应用偏好：外观、网卡选择等。持久化到本地 SQLite，重启后恢复。
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme_color: Option<String>,
    pub font_family: Option<String>,
    pub dark_mode: Option<bool>,
    /// 外观模式："system" | "light" | "dark"。缺省视为 "system"（跟随系统）。
    /// 与 `dark_mode` 的关系：`appearance_mode` 是**用户意图**，`dark_mode` 是**解析后的结果**
    /// （跟随系统时由前端按系统偏好解析后回写），二者同时持久化，互不冲突。
    pub appearance_mode: Option<String>,
    /// 桌面通知开关（缺省视为开启——否则用户会漏消息且不知道有开关）。
    pub notify_enabled: Option<bool>,
    /// 通知是否显示消息正文（隐私：关掉后只显示"收到新消息"，锁屏/通知中心不泄内容）。
    pub notify_show_content: Option<bool>,
    /// 界面语言："zh-CN" | "en-US"。缺省视为 "zh-CN"。
    pub language: Option<String>,
    pub bind_ip: Option<String>,
    /// 聊天显示样式 JSON：{"preset":"classic","fontSize":"md","compact":true}
    pub chat_style: Option<String>,
    /// 对端样式表 JSON（device_id -> style JSON）。仅由后端在收到 ChatStyle 消息时写入，
    /// 前端只读；save_settings 忽略该字段。
    pub peer_styles: Option<String>,
    /// 中继授权策略："off" | "friends" | "allowlist" | "all"。
    ///
    /// 缺省/脏值 = `all` —— **与今天的行为完全一致**（多跳转发一直是无条件的）。
    /// 为什么默认不是更"安全"的 off：跨跳投递（A—B—C 且 A/C 无直连）依赖中间节点转发，
    /// 默认关掉会让已有拓扑静默丢消息（红线 §8.1 #3：不得在重构里顺手改变传播语义）。
    /// 想限制中继的用户在设置里显式选择。见 `mesh/relay_policy.rs` 与 ADR-0016。
    pub relay_policy: Option<String>,
    /// 中继白名单（JSON 字符串数组，`allowlist` 策略用）。
    pub relay_allowlist: Option<String>,
}

/// e2ee_enabled 键保留在 reset 链中仅为清理 v0.10.0 及更早版本的残留值；
/// v0.11.0 起 E2EE 恒开、不可关闭，该键不再被读写。
const SETTINGS_KEYS: [&str; 13] = [
    "theme_color",
    "font_family",
    "dark_mode",
    "appearance_mode",
    "notify_enabled",
    "notify_show_content",
    "language",
    "bind_ip",
    "chat_style",
    "e2ee_enabled",
    "lan_enabled",
    "relay_policy",
    "relay_allowlist",
];

/// 把「变了的键」读成前端可以直接应用的一小块快照（键名与 `Settings` 的 camelCase 一致）。
///
/// 为什么要有它：`settings-changed` 以前是无载荷事件，接收方只能整份重拉
/// （`get_settings` + `get_device_info` + `get_share_dir`）。带上这一小块之后，
/// 另一个窗口**零 IPC** 就能把界面改对 —— 用户要求"界面响应速度高于一切"，
/// 跨窗口这条路径同样适用。
///
/// **调用约定**：请在**持有 db 锁时**调用，把结果交给
/// `AppState::notify_settings_changed(changed, origin, values)` —— 那里刻意不再自己加锁
/// （std Mutex 不可重入，否则与持锁调用点死锁）。
///
/// 只处理"值能放进 `Settings` 形状里"的键；`nickname`/`avatar`/`shareDir`/`downloadsDir`
/// 不在 `Settings` 里（它们是资料/目录），前端看到这些键会各自做一次**定向**重拉。
pub fn settings_patch_values(db: &rusqlite::Connection, changed: &[&str]) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for key in changed {
        match *key {
            "themeColor" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "theme_color")));
            }
            "fontFamily" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "font_family")));
            }
            "darkMode" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "dark_mode").map(|v| v == "1")),
                );
            }
            "appearanceMode" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "appearance_mode")),
                );
            }
            // 通知两项的缺省是**开**（与 `get_settings` 同口径），否则"没设置过"会被应用成关闭
            "notifyEnabled" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "notify_enabled")
                        .map(|v| v != "0")
                        .unwrap_or(true)),
                );
            }
            "notifyShowContent" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "notify_show_content")
                        .map(|v| v != "0")
                        .unwrap_or(true)),
                );
            }
            "language" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "language")));
            }
            "bindIp" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "bind_ip")));
            }
            "chatStyle" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "chat_style")));
            }
            "peerStyles" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "chat_peer_styles")),
                );
            }
            "relayPolicy" => {
                map.insert(key.to_string(), json!(db::get_setting(db, "relay_policy")));
            }
            "relayAllowlist" => {
                map.insert(
                    key.to_string(),
                    json!(db::get_setting(db, "relay_allowlist")),
                );
            }
            "retentionDays" => {
                map.insert(key.to_string(), json!(db::get_setting(db, RETENTION_KEY)));
            }
            "maxBytes" => {
                map.insert(key.to_string(), json!(db::get_setting(db, MAX_BYTES_KEY)));
            }
            // nickname/avatar/shareDir/downloadsDir：不在 `Settings` 形状里，前端定向重拉。
            _ => {}
        }
    }
    serde_json::Value::Object(map)
}

/// appearance_mode 的合法取值：脏值一律忽略（宁可回落"跟随系统"，也不要写进库）。
const APPEARANCE_MODES: [&str; 3] = ["system", "light", "dark"];

/// language 的合法取值：脏值一律忽略（回落"跟随系统"）。
/// "system" = 前端按系统语言决定（zh* → 中文，其余 → 英文）。
const LANGUAGES: [&str; 3] = ["system", "zh-CN", "en-US"];

/// relay_policy 的合法取值（与 `mesh::relay_policy::RelayPolicy::as_str` 一一对应）。
const RELAY_POLICIES: [&str; 4] = ["off", "friends", "allowlist", "all"];

/// 把前端**解析后**的界面语言推给后端。
///
/// 两个用途：
/// 1. 重建 macOS 菜单栏 —— 原生控件的文案不归 WebView 管；
/// 2. **后端自己生成的文案**（群成员变更 / 文件下载 / 托盘提示 / 窗口标题）按它选语言
///    （见 `AppState::is_zh`）。「跟随系统」的解析规则只在前端有一份，后端的兜底判断在
///    Windows 上恒为「否」—— 用户 2026-09-16 实测的「加群提示是英文」就是这个缺口。
///
/// 前端在**启动完成**与每次切换语言时各推一次（启动那次在 `app.init()` 里，不能被
/// `if (has("language"))` 挡住：从没改过语言的用户库里根本没这个键）。
///
/// 非 macOS 平台下菜单模块整体不编译，所以这里必须 cfg 掉那部分（保留命令本身，
/// 让前端调用在其它平台也能拿到 Ok —— 前端不需要按平台分支）。
#[tauri::command(async)]
pub fn set_ui_language(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    lang: String,
) -> Result<(), String> {
    // 先记下解析结果：它同时是 macOS 菜单与后端文案的语言依据。
    state.set_ui_language_hint(&lang);
    #[cfg(target_os = "macos")]
    {
        crate::menu::apply(&app, crate::menu::UiLang::parse(&lang)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &lang;
    }
    // ⚠️ 这里**刻意不发** `settings-changed`。
    //
    // 以前它发（无载荷、广播），于是形成过一个**事件乒乓**：另一个窗口收到 → 重拉设置 →
    // `applySettingsSnapshot` 结尾无条件 `pushUiLanguage()` → 又调回这条命令 → 再发一次
    // ⇒ 两个窗口互相触发，高频 IPC 环（"界面响应速度高于一切"最怕这个）。
    // 语言变更的**事实来源**是 `save_settings`（前端每次切语言都会调它，patch 里带
    // language 的值），所以这条命令不负责广播，只做上面两件事。
    let _ = &app;
    Ok(())
}

/// 申请 Android 的运行时权限（「附近的设备」：蓝牙扫描/连接/广播 + 附近的 WiFi 设备）。
///
/// 为什么要有这条命令：Android 12+ 把这些权限都拆成**运行时**权限，不申请的话
/// 局域网发现收不到组播、蓝牙通道也打不开 —— 用户第一次装完必须手动去系统设置里开，
/// 体验很差。现在 App 启动时前端调一次（系统弹框），被拒时提示"去系统设置打开"。
///
/// 非 Android 平台是**空操作**（这些权限在 macOS/iOS/Windows 上不存在或安装即授予）。
#[tauri::command(async)]
pub fn request_ble_permissions() -> Result<(), String> {
    #[cfg(all(target_os = "android", feature = "bluetooth"))]
    {
        return crate::transport::ble_android::request_permissions();
    }
    #[cfg(not(all(target_os = "android", feature = "bluetooth")))]
    {
        Ok(())
    }
}

/// 前端把 JS 异常 / 未处理的 Promise 拒绝送到后端日志。
///
/// 为什么需要它：界面上"点了没反应"最常见的原因就是**一次 JS 异常**
/// （在渲染或事件处理里抛出后，整个交互看起来就死了），而前端异常此前**不留任何痕迹** ——
/// 用户只能描述成"卡住了"，我们无从下手。现在它会出现在「运行日志」里，可以复制给我们。
#[tauri::command(async)]
pub fn log_frontend_error(state: State<'_, Arc<AppState>>, kind: String, text: String) {
    let text: String = text.chars().take(2000).collect();
    state
        .inner()
        .logger
        .warn("ui", format!("[前端 {kind}] {text}"));
}

#[tauri::command(async)]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    Settings {
        theme_color: db::get_setting(&dbc, "theme_color"),
        font_family: db::get_setting(&dbc, "font_family"),
        dark_mode: db::get_setting(&dbc, "dark_mode").map(|v| v == "1"),
        appearance_mode: db::get_setting(&dbc, "appearance_mode"),
        // 通知默认开启、默认显示正文：缺省时按 `Some(true)`，旧记录与未设置都能有合理行为。
        notify_enabled: db::get_setting(&dbc, "notify_enabled")
            .map(|v| v != "0")
            .or(Some(true)),
        notify_show_content: db::get_setting(&dbc, "notify_show_content")
            .map(|v| v != "0")
            .or(Some(true)),
        language: db::get_setting(&dbc, "language"),
        relay_policy: db::get_setting(&dbc, "relay_policy"),
        relay_allowlist: db::get_setting(&dbc, "relay_allowlist"),
        bind_ip: db::get_setting(&dbc, "bind_ip"),
        chat_style: db::get_setting(&dbc, "chat_style"),
        peer_styles: db::get_setting(&dbc, "chat_peer_styles"),
    }
}

#[tauri::command(async)]
pub fn save_settings(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    settings: Settings,
) -> Result<(), String> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    // 一边写一边记"哪些键真的被这次调用写了" —— 事件只带这一小块（见 `SettingsPatch`）。
    let mut changed: Vec<&str> = Vec::new();
    if let Some(v) = settings.theme_color {
        db::set_setting(&dbc, "theme_color", &v).map_err(|e| e.to_string())?;
        changed.push("themeColor");
    }
    if let Some(v) = settings.font_family {
        db::set_setting(&dbc, "font_family", &v).map_err(|e| e.to_string())?;
        changed.push("fontFamily");
    }
    if let Some(v) = settings.dark_mode {
        db::set_setting(&dbc, "dark_mode", if v { "1" } else { "0" }).map_err(|e| e.to_string())?;
        changed.push("darkMode");
    }
    if let Some(v) = settings.appearance_mode {
        if APPEARANCE_MODES.contains(&v.as_str()) {
            db::set_setting(&dbc, "appearance_mode", &v).map_err(|e| e.to_string())?;
            changed.push("appearanceMode");
        }
    }
    if let Some(v) = settings.notify_enabled {
        db::set_setting(&dbc, "notify_enabled", if v { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        changed.push("notifyEnabled");
    }
    if let Some(v) = settings.notify_show_content {
        db::set_setting(&dbc, "notify_show_content", if v { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        changed.push("notifyShowContent");
    }
    if let Some(v) = settings.language {
        if LANGUAGES.contains(&v.as_str()) {
            db::set_setting(&dbc, "language", &v).map_err(|e| e.to_string())?;
            changed.push("language");
        }
    }
    if let Some(v) = settings.bind_ip {
        db::set_setting(&dbc, "bind_ip", &v).map_err(|e| e.to_string())?;
        changed.push("bindIp");
    }
    if let Some(v) = settings.chat_style {
        db::set_setting(&dbc, "chat_style", &v).map_err(|e| e.to_string())?;
        changed.push("chatStyle");
    }
    // 中继授权：脏值一律忽略（宁可维持现状，也不要写进库让传播语义变得不可预期）
    if let Some(v) = settings.relay_policy.as_deref() {
        if RELAY_POLICIES.contains(&v) {
            db::set_setting(&dbc, "relay_policy", v).map_err(|e| e.to_string())?;
            changed.push("relayPolicy");
        }
    }
    if let Some(v) = settings.relay_allowlist.as_deref() {
        // 只接受合法 JSON 数组：写进脏值会让 RelayConfig::parse 静默退化成空表，
        // 用户会看到"白名单明明填了却不生效"。
        if serde_json::from_str::<Vec<String>>(v).is_ok() {
            db::set_setting(&dbc, "relay_allowlist", v).map_err(|e| e.to_string())?;
            changed.push("relayAllowlist");
        }
    }
    // patch 在**持锁时**读好（见 settings_patch_values 的调用约定：那边不再自己加锁，
    // 否则与这里仍持有的锁死锁）。
    let patch = settings_patch_values(&dbc, &changed);
    // 回读一遍写进内存缓存（转发路径热读，不能每次去锁 SQLite）。
    // ⚠️ 先放掉 DB 锁再更新缓存：避免与转发路径形成锁顺序纠缠。
    let relay = crate::mesh::relay_policy::RelayConfig::parse(
        db::get_setting(&dbc, "relay_policy").as_deref(),
        db::get_setting(&dbc, "relay_allowlist").as_deref(),
    );
    drop(dbc);
    state.set_relay_policy_config(relay);
    // 只把**变了的键**发给**另一个窗口**（发起窗口自己已经应用过了，不回发）。
    state.notify_settings_changed(&changed, Some(window.label()), patch);
    Ok(())
}

/// 恢复默认设置：清除所有用户可配置设置（外观、昵称、头像、网卡、缓存策略等）。
/// 保留 device_id、x25519_secret、ed25519_secret、好友列表、聊天记录。
#[tauri::command(async)]
pub fn reset_settings(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
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
    // 「恢复默认」也清掉了 relay_policy / relay_allowlist ⇒ 内存缓存必须回到默认（All），
    // 否则用户点了恢复默认、行为却还是旧的限制策略（要重启才生效）。
    drop(dbc);
    state.set_relay_policy_config(crate::mesh::relay_policy::RelayConfig::default());
    // 「恢复默认」把大部分键**删掉**了（不是写成某个值），逐一送 patch 反而容易漏；
    // 用 `"*"` 明确表示"全量都变了" —— 接收方做一次完整重拉（一次性动作，不心疼）。
    state.notify_settings_changed(&["*"], Some(window.label()), json!({}));
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
    // 同 update_profile：锁内只克隆发送端，发送在锁外做 —— 否则一条拥塞链路
    // 就能握着全局 links 锁把整个网络层（含自愈用的看门狗）拖死。
    let targets = {
        let links = s.links.lock().await;
        links
            .values()
            .flatten()
            .map(|link| link.priority.clone())
            .collect::<Vec<_>>()
    };
    for tx in &targets {
        let _ = tx.send(msg.clone()).await;
    }
    Ok(())
}

// ---------------- 好友 ----------------

/// 好友「在线」判据：**最近 [`FRIEND_ONLINE_GRACE_MS`] 内见过**（announce / Presence /
/// 握手都算 `last_seen`）**或**手里有活链路。
///
/// 为什么不沿用「在不在 `peers` 表里」：`mark_peer_offline` 现在**故意保留**刚掉线的
/// 节点条目（BLE 上"连上→被对端退让→断开"是常态；删掉的话 Mac 的「添加好友」列表里
/// 安卓只闪一下、用户根本点不到），所以"在表里"不再等价于"在线"，必须看
/// `last_seen` 的新鲜度 —— 否则就是 2026-09-12 复核抓到的那个 High 缺陷
/// （一次「连过又掉线」的节点永久显示在线）。
///
/// 15s ≈ 3 个 announce 周期（5s 基础 + 0~3s 抖动）：够容忍局域网丢一两轮广播，
/// 又不会把早已离开的节点长时间标成在线。
fn friend_is_online(last_seen: i64, now: i64, has_active_link: bool) -> bool {
    has_active_link || last_seen >= now - FRIEND_ONLINE_GRACE_MS
}

const FRIEND_ONLINE_GRACE_MS: i64 = 15_000;

/// 安全码：本机与指定对端之间那串**双方一致**的核对码（见 `crypto::safety_number`）。
///
/// 返回 `None` 表示**还算不出来** —— 缺对方的公钥（尚未通过 Hello/announce 学到）。
/// 这时**必须如实返回 None 而不是拿 device_id 凑一个**：凑出来的码在真正的中间人
/// 攻击下与真实对端的码不同，用户核对后会以为"对得上"，比没有更糟。
///
/// 对端公钥取 peers 优先、friends 回落（与 `resolve_member_x25519` 同一口径）。
#[tauri::command(async)]
pub fn get_safety_number(state: State<'_, Arc<AppState>>, peer_id: String) -> Option<String> {
    let s = state.inner();
    let (their_x, their_e) = {
        let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
        let p = peers.get(&peer_id);
        (
            p.and_then(|p| p.x25519_pubkey.clone()),
            p.and_then(|p| p.ed25519_pubkey.clone()),
        )
    };
    let (their_x, their_e) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        (
            their_x.or_else(|| db::get_friend_x25519(&dbc, &peer_id)),
            their_e.or_else(|| db::get_friend_ed25519(&dbc, &peer_id)),
        )
    };
    let (their_x, their_e) = (their_x?, their_e?);
    Some(crypto::safety_number(
        &crypto::SafetyParty {
            device_id: &s.device_id,
            x25519_pubkey: &s.identity.x25519_public_b64(),
            ed25519_pubkey: &s.identity.ed25519_public_b64(),
        },
        &crypto::SafetyParty {
            device_id: &peer_id,
            x25519_pubkey: &their_x,
            ed25519_pubkey: &their_e,
        },
    ))
}

#[tauri::command(async)]
pub fn get_friends(state: State<'_, Arc<AppState>>) -> Vec<Friend> {
    let s = state.inner();
    let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
    // 同时检查活跃 TCP 链接：链路存活但 peer 已被 discovery sweep 清掉时，
    // 仍应显示在线，避免「实际可通信但 UI 显示离线」。
    // ⚠️ 只算**非空** Vec（与 `sweep_peers` / `has_link` 同一口径）：
    // 残留的空 key 会让好友**永久显示在线**。根因已在 reader_loop 修掉，这里是防线。
    let active_links: std::collections::HashSet<String> = s
        .links
        .try_lock()
        .map(|l| {
            l.iter()
                .filter(|(_, v)| !v.is_empty())
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    let now = crate::db::now_ms();
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut friends = db::list_friends(&dbc).unwrap_or_default();
    for f in friends.iter_mut() {
        let last_seen = peers.get(&f.device_id).map(|p| p.last_seen).unwrap_or(0);
        f.online = friend_is_online(last_seen, now, active_links.contains(&f.device_id));
        // 设备类型从 peers 表现场读取（Hello/UserInfo/Presence 都会更新它）。
        f.device_type = peers
            .get(&f.device_id)
            .map(|p| p.device_type.clone())
            .unwrap_or_default();
    }
    friends
}

/// 删除好友（保留聊天记录；对方仍会出现在扫描列表，可重新添加）。
#[tauri::command(async)]
pub async fn remove_friend(state: State<'_, Arc<AppState>>, peer_id: String) -> Result<(), String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::remove_friend(&dbc, &peer_id).map_err(|e| e.to_string())?;
        db::delete_file_outbox_for_peer(&dbc, &peer_id).ok();
    }
    // ⚠️ **同时解除内存里的身份绑定**（用户 2026-09-13 真机：不这么做就"必须重启"）。
    // `friends` 表那一行删掉只解除了一条腿；`verify_hello` 还会回落到内存 `peers` 表里
    // 广播学来的旧公钥 ⇒ 对方重装换过公钥时，删了好友重新加也照样被硬拒。
    crate::network::transport::forget_peer_identity(s, &peer_id);
    // 通知对方解除好友关系（对方收到后也会删除本机好友行）
    let msg = Message::FriendRemove {
        from: s.device_id.clone(),
        to: peer_id.clone(),
    };
    let _ = try_send(s, &peer_id, &msg).await;
    let _ = s.app.emit("friend-removed", &peer_id);
    Ok(())
}

/// 待处理的好友申请。
///
/// **规则（用户 2026-09-12 真机实测要求）**：已经在好友列表里的人，其申请不该再出现
/// ——「如果该好友已在好友列表的话，列表里的那个好友申请就应该自动清除掉」。
/// 主修在各条"同意"路径上清 `pending_requests`（见 `transport::forget_pending_request`），
/// 这里按 friends 表再过滤一遍并**顺手把内存态收敛掉**：万一哪条路径漏了（或对方是走
/// 别的消息把我加上的），「新朋友」里也不会留着一条永远处理不掉的过期申请。
// ---------------- 移动端文件选择：content:// 必须"落地"成真实文件 ----------------

/// 从 `content://` URI 里尽力取出**真实文件名**（含扩展名）。
///
/// - external-storage / documents 提供者会把相对路径编码进 URI
///   （`…/document/primary%3ADownload%2Freport.pdf`）⇒ 解出来就是 `report.pdf`；
/// - MediaStore（相册）只给数字 id（`…/images/media/1000000033`）⇒ 拿不到名字，
///   返回 `None`，由调用方按**内容嗅探**补一个（见 [`sniff_media_ext`]）。
///
/// 纯函数：主机上可直接单测（真机行为无法在无设备环境验证，规则必须先钉住）。
pub fn name_from_content_uri(uri: &str) -> Option<String> {
    let after_scheme = uri.split_once("://").map(|(_, rest)| rest).unwrap_or(uri);
    let last = after_scheme.rsplit('/').next()?;
    // 百分号解码（`%2F` → `/`、`%3A` → `:`），只处理这两种 + 空格，够用且不做过度解码
    let decoded = last
        .replace("%2F", "/")
        .replace("%2f", "/")
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%20", " ");
    // `primary:Download/report.pdf` ⇒ 取最后一段
    let candidate = decoded
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(&decoded)
        .to_string();
    // 必须是"像文件名"的东西：有点、有扩展名、长度合理、不含危险字符
    let ok = candidate.len() > 3
        && candidate.len() <= 180
        && candidate.contains('.')
        && !candidate.starts_with('.')
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_. ()[]（）【】".contains(c));
    if ok {
        Some(candidate)
    } else {
        None
    }
}

/// 按**文件头**判断媒体类型（拿不到扩展名时用）。
///
/// 为什么按内容而不是扩展名：Android 相册给的 URI 没有文件名，
/// 而"从相册选图片"必须发成**图片**消息（否则用户看到的是一个附件）。
pub fn sniff_media_ext(head: &[u8]) -> &'static str {
    match head {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [0x89, b'P', b'N', b'G', ..] => "png",
        [b'G', b'I', b'F', b'8', ..] => "gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        [b'B', b'M', ..] => "bmp",
        [0x25, b'P', b'D', b'F', ..] => "pdf",
        [b'P', b'K', 0x03, 0x04, ..] => "zip",
        _ => "bin",
    }
}

/// 文件名消毒：去掉目录分隔符与控制字符，避免写到缓存目录之外（路径穿越）。
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "file.bin".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

/// 把「文件选择器」交给我们的东西**落地**成一个真实可读的文件路径。
///
/// 为什么必须有这一步（用户 2026-09-12 安卓真机实测：「文字能发、代码能发，
/// 但发附件/图片总是失败」）：Android 的系统文件选择器返回的是 **`content://` URI**，
/// 不是文件路径 —— `tauri-plugin-dialog` 的 Kotlin 侧直接把 `uri.toString()` 交给前端
/// （插件里那个 `FilePickerUtils.getPathFromUri` 是**没人调用**的死代码）。
/// 于是这个 URI 被原样传给 Rust 的文件发送逻辑，`std::fs::metadata("content://…")`
/// 必然失败 ⇒「文件不存在或不可读」/「发送失败」。桌面端返回的本来就是真实路径，
/// 所以**只有安卓会这样**。
///
/// 修法：URI 走 `tauri-plugin-fs` 的跨平台 API（Android 侧会经 ContentResolver 解析）
/// 复制到应用缓存目录，再把真实路径交给原本的发送链路 —— 后面的图片预览、缩略图、
/// 断点重传全都不用改。
#[tauri::command(async)]
pub async fn import_picked_file(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    suggested_name: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_fs::FsExt;
    if !path.starts_with("content://") {
        // 桌面 / 已经是真实路径（`file://` 或普通路径）：原样返回
        return Ok(path);
    }
    let dir = state.cache_dir.join("imports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导入目录失败：{e}"))?;
    let tmp = dir.join(format!(".incoming-{}", uuid::Uuid::new_v4()));
    // `content://` 必须走 `FilePath::Url`（fs 插件在安卓侧据此走 ContentResolver 解析）
    let uri = url::Url::parse(&path).map_err(|e| format!("无法解析所选文件的 URI：{e}"))?;
    let mut src = app
        .fs()
        .open(uri, tauri_plugin_fs::OpenOptions::new().read(true).clone())
        .map_err(|e| format!("打不开所选文件（{e}）"))?;
    let mut out = std::fs::File::create(&tmp).map_err(|e| format!("写入临时文件失败：{e}"))?;
    std::io::copy(&mut src, &mut out).map_err(|e| format!("复制所选文件失败：{e}"))?;
    drop(out);
    // 名字优先级：URI 里能解出来的 > 前端给的显示名 > 按内容嗅探补一个
    let head = {
        use std::io::Read as _;
        let mut head = [0u8; 16];
        let mut f = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
        let n = f.read(&mut head).unwrap_or(0);
        head[..n].to_vec()
    };
    let ext = sniff_media_ext(&head);
    let name = name_from_content_uri(&path)
        .or_else(|| suggested_name.map(|n| sanitize_file_name(&n)))
        .unwrap_or_else(|| format!("gosslan-{}.{ext}", db::now_ms()));
    let dest = dir.join(sanitize_file_name(&name));
    std::fs::rename(&tmp, &dest).map_err(|e| format!("落地所选文件失败：{e}"))?;
    state.logger.info(
        "file",
        format!(
            "已把所选文件落地到缓存：{}（{} 字节）",
            dest.display(),
            std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0)
        ),
    );
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn get_pending_requests(state: State<'_, Arc<AppState>>) -> Vec<PendingRequest> {
    let s = state.inner();
    let friend_ids: std::collections::HashSet<String> = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_friends(&dbc)
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.device_id)
            .collect()
    };
    let mut map = s.pending_requests.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, req| is_actionable_request(req, &friend_ids));
    map.values().cloned().collect()
}

/// 这条好友申请该不该出现在「新朋友」里？
///
/// 判据只有一条：**人已经是好友了 ⇒ 申请不该再出现**（用户 2026-09-12 明确要求）。
/// 抽成纯函数是为了能在主机上直接单测这条规则 —— 它原先散落在"同意"的各条路径里，
/// 直连路径漏了清、跨跳路径清了，表现成"有时候会清、有时候不清，全看对方怎么被加上"。
pub(crate) fn is_actionable_request(
    req: &PendingRequest,
    friend_ids: &std::collections::HashSet<String>,
) -> bool {
    !friend_ids.contains(&req.from)
}

/// **把好友申请真正发出去**（构造定向 Gossip 信封 → 直连就精确发、否则洪泛）。
///
/// 抽出来的原因：它有两个调用方 —— 用户点「加好友」（命令），以及**建链后补发**
/// （`flush_pending_friend_request`，用户真机遇到"已发送但对方没收到"之后加的）。
pub(crate) async fn send_friend_request_via_link(
    s: &Arc<AppState>,
    peer_id: &str,
) -> Result<(), String> {
    // 目标必须在 peers 表（announce / Presence 学到），且需有 X25519 公钥才能 E2EE 加密。
    let target_pubkey = {
        let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.get(peer_id).and_then(|p| p.x25519_pubkey.clone())
    };
    let Some(target_pubkey) = target_pubkey else {
        return Err("未找到该节点或缺少其公钥，请先重新扫描".to_string());
    };
    let nickname = s.nickname.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let raw_avatar = s.avatar.lock().unwrap_or_else(|e| e.into_inner()).clone();
    // 好友申请是**最需要秒到**的控制帧，且走优先通道：绝不能内联大头像
    // （几百 KB 会分上千片、还可能超过 BLE 单帧上限被整帧丢弃 ⇒ 对方永远收不到，
    // 而界面仍显示"已发送"）。超限就不带头像；建链后由 UserInfo 定向同步大头像。
    let avatar = crate::network::transport::hello_avatar_for_wire(raw_avatar.as_deref());
    // E2EE 加密好友申请内容（昵称/可选头像）；from/to 已在信封 sender_id / target 里。
    let payload =
        serde_json::json!({ "from_nickname": nickname, "from_avatar": avatar }).to_string();
    let shared =
        crypto::shared_secret(&s.identity.x25519_secret, &target_pubkey).ok_or("密钥交换失败")?;
    let sealed = crypto::seal(&shared, payload.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let mut env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::FriendRequest,
            None,
            None,
            &payload_b64,
            db::now_ms(),
            0,
        )
    };
    // 定向目标 + 重签（target 参与 signing_bytes）。
    env.target = Some(peer_id.to_string());
    env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
    // 目标直连 → 只发它（精确）；否则广播，靠中间节点按 target 定向转发（跨跳）。
    if s.has_link(peer_id).await {
        try_send(s, peer_id, &Message::Gossip { envelope: env }).await?;
    } else {
        broadcast_gossip(s, env).await;
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn send_friend_request(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
) -> Result<(), String> {
    let s = state.inner();
    if peer_id.is_empty() || peer_id == s.device_id {
        return Err("不能向自己发送好友申请".to_string());
    }
    // **先登记再发**：好友申请没有回执，链路抖动时它会静默丢失，而界面照样显示"已发送"
    //（用户 2026-09-12 真机：对方什么都没收到）。登记后由建链/Hello 补全时重发，
    // 收到同意/拒绝再清除（见 `forget_pending_request`）。
    s.pending_out_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer_id.clone());
    send_friend_request_via_link(s, &peer_id).await
}

/// **同意好友申请**这条路径的**唯一**实现：落库（好友 + 会话 + 公钥）→ 回执（Gossip 定向加密）
/// → 清 pending → 通知 UI。
///
/// 为什么必须抽出来：现在有**两个**入口会"同意"——
///   ① 用户在「新朋友」里点同意（`respond_friend_request`）；
///   ② 收到一个**已经是我的好友**的人发来的申请时自动同意（`transport::auto_accept_if_already_friend`）。
/// 两者只要有一处漏了落库或漏了回执，就会造出"我这儿有他、他那儿没我"的**单边好友关系**，
/// 而那种状态在界面上表现为"对方加不上我"（用户 2026-09-12 实测的那个 bug）。
/// **好友同意回执（`FriendAccept`）**这条路径的**唯一**发送实现。
///
/// 为什么抽出来：`accept_friend_request` 发一次之后**没有任何回执**能证明对端收到了，
/// 所以链路抖动时必须能**用同一条路径重发**（`transport::flush_pending_friend_accept`
/// 在建链/心跳时调用）。两处各写一份的话，"重发的那份"迟早会漏掉定向/重签/加密。
pub(crate) async fn send_friend_accept_via_link(
    s: &Arc<AppState>,
    peer_id: &str,
) -> Result<(), String> {
    // 对方公钥优先从 peers 表读（接收 FriendRequest 时已 upsert_peer 记录），
    // friends 表兜底（maybe_update_friend 可能已持久化）。
    let target_pubkey = {
        let from_peers = {
            let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
            peers.get(peer_id).and_then(|p| p.x25519_pubkey.clone())
        };
        let from_friends = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_friend_x25519(&dbc, peer_id)
        };
        from_peers.or(from_friends)
    };
    let Some(target_pubkey) = target_pubkey else {
        // 缺对端公钥时**绝不静默**：本地已加好友，但回执发不出去会导致好友关系
        // 单边成立。打日志留痕（对方 Presence 尚未到达 / 已被 sweep 清理）。
        s.logger.warn(
            "friend",
            format!("同意好友但缺对端公钥，FriendAccept 未发送 peer={peer_id}"),
        );
        return Err("缺对端公钥".to_string());
    };
    let shared =
        crypto::shared_secret(&s.identity.x25519_secret, &target_pubkey).ok_or("密钥交换失败")?;
    let sealed = crypto::seal(&shared, b"{}").ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let mut env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::FriendAccept,
            None,
            None,
            &payload_b64,
            db::now_ms(),
            0,
        )
    };
    env.target = Some(peer_id.to_string());
    env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
    if s.has_link(peer_id).await {
        try_send(s, peer_id, &Message::Gossip { envelope: env }).await?;
    } else {
        broadcast_gossip(s, env).await;
    }
    Ok(())
}

pub(crate) async fn accept_friend_request(s: &Arc<AppState>, peer_id: &str) -> Result<(), String> {
    let name = resolve_nickname(s, peer_id);
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::add_friend(&dbc, peer_id, &name, None).ok();
        db::ensure_conversation(&dbc, peer_id, "single", &name, None).ok();
    }
    // 补写 peers 表已有的公钥到 friends 表：accept 路径此前不写公钥，
    // 而建链（Hello）早于加好友、公钥不变时 key_changed 不触发补写，
    // 导致 friends 公钥永久缺失 → 群密钥分发被静默跳过。
    // 与 transport.rs 中 FriendAccept 接收路径的补写行为一致。
    maybe_update_friend(s, peer_id, &name, None);
    // **先登记再发**（与好友申请同一条纪律）：同意回执没有回执，链路抖动时它会静默丢失，
    // 而发送方界面已显示"已同意" ⇒ 另一端永远停在"等待对方确认"（真机 2026-09-13）。
    {
        let now = db::now_ms();
        s.pending_out_accepts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_id.to_string(), (now, 0, 0));
    }
    if let Err(e) = send_friend_accept_via_link(s, peer_id).await {
        s.logger.warn(
            "friend",
            format!("好友同意回执发送失败（已登记待补发）peer={peer_id}: {e}"),
        );
    }
    crate::network::transport::forget_pending_request(s, peer_id);
    let _ = s.app.emit("friend-accepted", &peer_id);
    Ok(())
}

#[tauri::command(async)]
pub async fn respond_friend_request(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
    accept: bool,
) -> Result<(), String> {
    let s = state.inner();
    if !s
        .pending_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&peer_id)
    {
        return Err("好友申请不存在或已处理".to_string());
    }
    if accept {
        return accept_friend_request(s, &peer_id).await;
    } else {
        // 拒绝回执：跨跳（无直连）时 try_send 会失败，但**绝不因此阻塞本地清理**——
        // 否则「拒绝」发不出去会导致 pending 不被删除、申请「清掉又冒出来」。
        let msg = Message::FriendReject {
            from: s.device_id.clone(),
            to: peer_id.clone(),
        };
        let _ = try_send(s, &peer_id, &msg).await;
        s.pending_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&peer_id);
        let _ = s.app.emit("friend-rejected", &peer_id);
    }
    Ok(())
}

// ---------------- 单聊（Gossip + E2EE） ----------------

#[tauri::command(async)]
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    content: String,
    kind: String,
) -> Result<MessageRecord, String> {
    let s = state.inner();

    // 「和自己聊天」分流：target 是自己时走**纯本地路径**（见 `insert_self_message`）。
    // 放在最前面是有意的 —— 下面每一步（好友校验 / 公钥查找 / 加密 / outbox / gossip）
    // 对自己都不成立。
    if friend_id == s.device_id {
        return insert_self_message(s, &kind, content);
    }

    let msg_kind = match kind.as_str() {
        "text" => MsgKind::Text,
        "code" => MsgKind::Code,
        "file" => MsgKind::File,
        _ => return Err("不支持的消息类型".to_string()),
    };

    // 好友关系检查：必须优先于公钥查找
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }

    // 长度保护：text/code 等普通内容超限直接报错（UTF-8 安全，按字符数计）。
    let content = check_message_content(content)?;

    // E2EE 恒开（v0.11.0 起默认且不可关闭）：发送必须拿到对端 X25519 公钥。
    // 好友表优先，回退在线节点表；都缺失时主动探测一次（who_has）等对方/中继
    // announce 落库（约 1.2s）后再查，仍缺失则报错指引。
    let pubkey = {
        let from_db = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_friend_x25519(&dbc, &friend_id)
        };
        let from_peers = s
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&friend_id)
            .and_then(|p| p.x25519_pubkey.clone());
        match from_db.or(from_peers) {
            Some(k) => Some(k),
            None => {
                let triggered =
                    if let Some(tx) = s.probe.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
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
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::get_friend_x25519(&dbc, &friend_id)
                };
                let again_peers = s
                    .peers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
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
    let seq = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &friend_id).map_err(|e| format!("逻辑时钟推进失败：{e}"))?
    };
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
    let mut env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Chat,
            None,
            None,
            &payload_b64,
            ts,
            seq,
        )
    };
    // 信封 encrypted 默认 true（build_envelope 内置），无需改写
    // 统一 msg_id：本地记录 / Gossip 投递 / outbox 补发共用同一确定性 ID，
    // 接收方 message_exists 跨路径去重（防建链竞态窗口内的重复投递）。
    let msg_id = env.message_id.clone();
    // 单聊定向：target = 接收方。中间节点按 target 定向转发（一跳精确，无路由表时洪泛
    // 兜底），直连场景不再全网广播（消除广播放大）。target 参与 signing_bytes，必须重签。
    env.target = Some(friend_id.clone());
    env.sender_sig = s.identity.sign_b64(&env.signing_bytes());

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
        seq,
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
        seq,
    };
    let payload = serde_json::to_string(&queued).map_err(|e| e.to_string())?;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::insert_message_and_outbox(&dbc, &rec, &friend_id, &payload)
            .map_err(|e| format!("消息写入失败：{e}"))?;
        db::touch_conversation(&dbc, &friend_id, "single", &name, None, &preview, 0)
            .map_err(|e| format!("会话写入失败：{e}"))?;
    }

    // 先入队再投递（INV-003）：此前 broadcast 在插队之前，若心跳的 flush_outbox 正好
    // 落在这个窗口，它看不到 outbox 行 ⇒ 这一轮直发缺席 ⇒ Ack 要等下一个心跳（+5s）。
    // 定向投递：目标直连 → 只发它（精确，不再全网广播）；否则广播，靠中间节点按 target
    // 定向转发（跨跳）。投递失败**不返回 Err**：消息已落 outbox 兜底，链路刚断的竞态
    // 下由 flush_outbox 在下次建链/心跳时补发，返回 Err 会让前端误判「发送失败」而重发。
    if s.has_link(&friend_id).await {
        let _ = try_send(s, &friend_id, &Message::Gossip { envelope: env }).await;
    } else {
        broadcast_gossip(s, env).await;
    }
    // 更新会话「当前链路」（发送方视角）：有直连则 hop=0 + 出站路径；无直连
    // （经中继广播）则乐观记 hop=1（实际跳数发送方不可知，等对端回执侧视角校正）。
    {
        let hop = if s.has_link(&friend_id).await { 0 } else { 1 };
        let path = crate::network::transport::inbound_path_kind(s, &friend_id).await;
        crate::network::transport::update_conv_link(s, &friend_id, &path, hop);
    }

    Ok(rec)
}

// INV-EXCEPTION: INV-P03, INV-P04 — 自聊收发双方都是本机，没有对端可等 Ack：
// 落库即终态 `read`（跳过 queued→sending→waiting_ack→delivered），且**不写 outbox**
// （那一行永远排不掉，反把「outbox 必然排空」破掉）。
// 登记在 docs/protocol-invariants.md §22，由 scripts/check-invariant-exceptions.mjs 双向校验。
/// 给自己发一条消息（「和自己聊天」）—— **纯本地，消息不出本机**。
///
/// 为什么必须是独立路径，而不是"把自己当好友"复用下面的发送流程：
///
/// 1. **没有传输**：收发双方都是本机 ⇒ 没有链路可发、没有对端公钥可用。
///    E2EE 保护的是**传输**（"E2EE 恒开"说的是网络路径）；本地落盘与其它会话一样是
///    SQLite 明文，所以这里不加密**不是**"加密失败就退明文"那种兜底。
/// 2. **绝不能进 outbox**：outbox 的唯一出队条件是收到对端 Ack，给自己发包永远不会有 Ack
///    ⇒ 那一行会永远留在库里、被每次心跳/建链的 `flush_outbox` 重发，
///    把"outbox 必然排空"这条不变量破掉。
/// 3. **绝不能广播**：`target = 自己` 的 gossip 信封对别人是解不开的噪声，
///    本机自己也会在 `handle_gossip` 的 `sender == 自己` 早退里丢掉 —— 纯浪费带宽与 TTL。
///
/// 状态直接给 `"read"`：本机既是发送方也是接收方，不存在"在途"阶段；
/// 前端也不会给自聊消息挂回执（见 `src/utils/selfChat.ts`）。
fn insert_self_message(s: &AppState, kind: &str, content: String) -> Result<MessageRecord, String> {
    // 只支持文本 / 代码：用户 2026-09-16 明确「先只支持文本」。图片与文件要落盘、要文件卡片，
    // 走的是另一条链路（`send_file`），自聊里前端也不会给附件入口 —— 真调到了就明确报错，
    // 不要静默吞掉。
    if kind != "text" && kind != "code" {
        return Err("和自己聊天暂不支持图片或文件".to_string());
    }
    let content = check_message_content(content)?;
    let ts = db::now_ms();
    let me = s.device_id.clone();
    // ⚠️ 名字/头像都在**拿 db 锁之前**取好：`self_display_name`/`self_avatar` 各自还要锁
    // 昵称与头像（`is_zh` 里还会再锁一次 db），持锁期间再回头锁它们就是在赌锁顺序
    // （本文件里"不能在持有 db 锁时调用 resolve_nickname"那条注释说的是同一件事）。
    let name = s.self_display_name();
    let avatar = s.self_avatar();
    let preview = preview(kind, &content);
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    let seq = db::next_clock(&dbc, &me).map_err(|e| format!("逻辑时钟推进失败：{e}"))?;
    let rec = MessageRecord {
        id: 0,
        // 前缀 `self-` 让它一眼可辨（日志/排障时不会与网络消息的哈希 id 混淆）
        msg_id: format!("self-{}", Uuid::new_v4()),
        conv_id: me.clone(),
        sender_id: me.clone(),
        receiver_id: me.clone(),
        kind: kind.to_string(),
        content,
        ts,
        seq,
        status: "read".to_string(),
    };
    // ⚠️ `insert_message`（只落库）—— **不是** `insert_message_and_outbox`：
    // 自聊消息没有收件人，进 outbox 就永远排不掉（见上面的第 2 条）。
    db::insert_message(&dbc, &rec).map_err(|e| format!("消息写入失败：{e}"))?;
    // unread_inc = 0：自己发的消息不该让自己"有未读"（与 `send_message` 同口径）
    db::touch_conversation(&dbc, &me, "single", &name, avatar.as_deref(), &preview, 0)
        .map_err(|e| format!("会话写入失败：{e}"))?;
    Ok(rec)
}

/// 读取会话的「当前链路」。前端聊天窗口据此显示连接图标（LAN / 桥接 / 蓝牙 + 节点数）。
///
/// **有直连时以此刻实际选路为准（hop=0）**，而不是返回"上一条消息"的快照 ——
/// 否则链路从蓝牙/中继切回局域网后，聊天头会一直显示「桥接」直到再发一条消息
/// （用户 2026-09-14 真机：两边全在局域网，却显示「已桥接」）。
/// 无直连时才回落到最后一次的快照（桥接跳数由消息路径反推，只在收发时更新）。
/// 注意返回 Result<Option<_>, _>：Tauri 要求"带引用输入的 async 命令"必须返回 Result
/// （State<'_, _> 就是引用输入）。Ok 会被自动解包，前端拿到的仍是 LinkState | null，
/// 契约不变。
#[tauri::command(async)]
pub async fn get_conv_link(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
) -> Result<Option<crate::state::LinkState>, String> {
    let s = state.inner();
    if s.has_link(&conv_id).await {
        let path = crate::network::transport::inbound_path_kind(s, &conv_id).await;
        return Ok(Some(crate::state::LinkState { path, hop: 0 }));
    }
    Ok(s.conv_link
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&conv_id)
        .cloned())
}

#[tauri::command(async)]
pub fn get_messages(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Vec<MessageRecord> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    let safe_limit = limit.unwrap_or(100).clamp(1, 500);
    let safe_offset = offset.unwrap_or(0).max(0);
    db::get_messages(&dbc, &conv_id, safe_limit, safe_offset).unwrap_or_default()
}

#[tauri::command(async)]
pub fn get_message_count(state: State<'_, Arc<AppState>>, conv_id: String) -> i64 {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::count_messages(&dbc, &conv_id)
}

#[tauri::command(async)]
pub fn get_conversations(state: State<'_, Arc<AppState>>) -> Vec<Conversation> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::list_conversations(&dbc).unwrap_or_default()
}

/// 打开与好友的会话时确保会话行存在（新加好友尚未发过消息时，
/// 会话列表无对应项 → 左侧无法高亮选中态）。
#[tauri::command(async)]
pub fn ensure_conversation(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
) -> Result<Conversation, String> {
    let s = state.inner();
    // 「和自己聊天」：名字/头像取**本机**的，否则 `resolve_nickname` 会回落到 device_id 原文，
    // 会话列表里就成了一串 gosslan-xxxx。
    let (name, avatar) = if friend_id == s.device_id {
        (s.self_display_name(), s.self_avatar())
    } else {
        let name = resolve_nickname(s, &friend_id);
        let avatar = {
            let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
            peers.get(&friend_id).and_then(|p| p.avatar.clone())
        };
        (name, avatar)
    };
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::ensure_conversation(&dbc, &friend_id, "single", &name, avatar.as_deref())
            .map_err(|e| e.to_string())?;
        // 回读已存在的行：会话可能早已建立且被置顶，凭空造一个 pinned=false
        // 会让前端把它当成「未置顶」从而覆盖掉用户的置顶状态。
        if let Some(conv) = db::get_conversation(&dbc, &friend_id) {
            return Ok(conv);
        }
    }
    Ok(Conversation {
        id: friend_id.clone(),
        kind: "single".to_string(),
        name,
        avatar,
        last_msg: None,
        last_ts: None,
        unread: 0,
        pinned: false,
    })
}

/// 设置会话置顶（纯本地偏好，不广播、不同步）。
#[tauri::command(async)]
pub fn set_conversation_pinned(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    pinned: bool,
) -> Result<(), String> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::set_conversation_pinned(&dbc, &conv_id, pinned).map_err(|e| e.to_string())
}

/// 标记会话已读；单聊时向对方发送已读回执（触发对方界面的「已读绿勾」）。
#[tauri::command(async)]
pub async fn mark_read(state: State<'_, Arc<AppState>>, conv_id: String) -> Result<(), String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::mark_read(&dbc, &conv_id).map_err(|e| e.to_string())?;
    }
    if !conv_id.starts_with("group:") {
        // 自聊（会话 id == 自己）：本机既是发送方也是接收方，没有"对方"可收回执。
        // 真发出去只会在 `pending_reads` 里留一条永远排不掉的记录（`flush_pending_reads`
        // 每次建链/心跳都会重试一次）。未读清空已经在上面做完了，这里直接返回。
        if conv_id == s.device_id {
            return Ok(());
        }
        // 通知对方：我已读到「对方最近一条消息」为止。
        // 这里不能取全会话最大 ts：一是可能取到自己发的消息，二是对方消息在本机
        // 落库时被时钟钳制过，直接回传 ts 会让对方用自己的原始时间戳匹配不上。
        // 回传 msg_id，由发送方换算成自己的本地时间戳。
        let last = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::last_message_from_sender(&dbc, &conv_id, &conv_id)
        };
        if let Some((msg_id, ts)) = last {
            // 同网段走直连 ReadReceipt，跨跳走定向 Gossip ChatReadReceipt。
            // try_send 返回 Ok 只代表消息进入 mpsc channel，不代表 TCP writer
            // 真正 write_frame 成功——writer_loop 可能随后发现链路已断而丢弃。
            // 因此无论结果都保留 pending：下一次心跳/建链时 flush 重发。
            let _ =
                crate::network::transport::send_read_receipt_route(s, &conv_id, Some(msg_id), ts)
                    .await;
            {
                let mut pending = s.pending_reads.lock().unwrap_or_else(|e| e.into_inner());
                let cur = pending.entry(conv_id.clone()).or_insert(ts);
                *cur = (*cur).max(ts);
            }
            // 持久化到 DB：进程重启后 pending_reads 内存丢失时可从 DB 恢复。
            // 使用 max 语义（upsert_pending_read）保证较旧 timestamp 不覆盖较新。
            {
                let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                db::upsert_pending_read(&dbc, &conv_id, ts).ok();
            }
        }
    } else if let Some(group_id) = conv_id.strip_prefix("group:") {
        let group = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_group(&dbc, group_id)
        };
        if let Some(group) = group {
            for member in group.members {
                if member == s.device_id {
                    continue;
                }
                // 群回执同样按「该成员最近一条消息」发送，避免跨设备时钟偏差。
                let last = {
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::last_message_from_sender(&dbc, &conv_id, &member)
                };
                let Some((msg_id, last_read_ts)) = last else {
                    continue;
                };
                let msg = Message::GroupReadReceipt {
                    from: s.device_id.clone(),
                    group_id: group_id.to_string(),
                    last_read_ts,
                    last_read_msg_id: Some(msg_id),
                };
                let _ = crate::network::transport::try_send(s, &member, &msg).await;
                // 无论即时发送是否成功都持久化待发记录，由建链/Hello/心跳补发；
                // 接收端按 (group_id, reader_id) 单调去重，重复送达无副作用。
                let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                db::upsert_pending_group_read(&dbc, group_id, &member, last_read_ts).ok();
            }
        }
    }
    Ok(())
}

/// 删除本地会话与全部消息（聊天记录清理）。
/// 仅删本地：不影响对方、不广播；前端负责二次确认弹窗。
/// 群聊同样支持（删除 group:xxx 会话及全部消息）。
#[tauri::command(async)]
pub fn delete_conversation(state: State<'_, Arc<AppState>>, conv_id: String) -> Result<(), String> {
    let s = state.inner();
    // 群会话删除时写删除边界：其他成员保留的历史重放不得回灌本机。
    // 边界记录当前逻辑序号，而非墙上时钟。
    if let Some(gid) = conv_id.strip_prefix("group:") {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let boundary = db::get_clock(&dbc, &conv_id);
        db::set_clear_boundary(&dbc, gid, boundary).map_err(|e| e.to_string())?;
    }
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    db::delete_conversation(&dbc, &conv_id).map_err(|e| e.to_string())
}

// ---------------- 群聊（群密钥 + Gossip） ----------------

#[tauri::command(async)]
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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
    s.group_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), key);

    Ok(Group {
        id,
        name,
        creator: s.device_id.clone(),
        members: all,
    })
}

/// 向群成员分发群密钥（用各成员公钥 ECDH 加密）。
/// 同时携带群名与成员列表：成员端据此建本地群记录，否则群名会兜底成「群聊 g-xxxx」。
#[tauri::command(async)]
pub async fn distribute_group_key(
    state: State<'_, Arc<AppState>>,
    group_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let key = get_group_key(s, &group_id).await.ok_or("群密钥缺失")?;
    // 同时取群名与成员：成员端靠它建立/刷新本地群记录（含成员表）
    let (group_name, members) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id)
            .map(|g| (g.name, g.members))
            .unwrap_or_default()
    };
    let clock = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_clock(&dbc, &format!("group:{group_id}"))
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
            clock,
        };
        if let Err(_) = try_send(s, m, &msg).await {
            // 目标成员尚无 TCP link（建群时 ensure_link 可能尚未执行）：
            // 不再静默丢弃，登记待发，由建链 / Hello / 心跳的
            // flush_pending_group_keys 补发（与 redistribute_group_keys 同一机制）。
            let mut pending = s
                .pending_group_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            mark_pending_group_key(&mut pending, m, &group_id);
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_groups(state: State<'_, Arc<AppState>>) -> Vec<Group> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::list_groups(&dbc).unwrap_or_default()
}

#[tauri::command(async)]
pub fn get_group_reads(state: State<'_, Arc<AppState>>, group_id: String) -> Vec<GroupReadInfo> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
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
#[tauri::command(async)]
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以修改群名称".to_string());
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, group_id)
            .map(|g| g.name)
            .unwrap_or_default()
    };
    let clock = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_clock(&dbc, &format!("group:{group_id}"))
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
            clock,
        };
        if let Err(_) = try_send(s, m, &msg).await {
            // 目标成员尚无 TCP link：登记待发，由建链 / Hello / 心跳的
            // flush_pending_group_keys 补发（与 redistribute_group_keys 同一机制）。
            let mut pending = s
                .pending_group_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            mark_pending_group_key(&mut pending, m, group_id);
        }
    }
}

/// 加人入群：仅创建者。本地落成员后，用**当前**群密钥重发给全体成员（含新成员）。
///
/// ⚠️ 这里刻意**不轮换**群密钥：
/// - 加人没有前向保密收益——新成员本来就没有旧密钥，转不转旧消息他都解不开；
/// - `handle_group_key` 只接受**群主**分发的密钥（防止成员伪造密钥劫持群聊），
///   所以一旦轮换，新密钥就只存在于群主本机。群主一旦离线，其他成员永远拿不到，
///   整群消息都无法解密。不轮换则密钥始终是全体成员都持有的那一个，与群主是否在线无关。
/// - 轮换只在「移除成员」时做（撤销被移除者的解密能力），那个时机群主必然在线。
#[tauri::command(async)]
pub async fn group_add_member(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    device_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以添加成员".to_string());
    }
    if group.members.contains(&device_id) {
        return Err("该成员已在群中".to_string());
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &device_id).is_none() {
            return Err("只能添加好友入群".to_string());
        }
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::add_group_member(&dbc, &group_id, &device_id).map_err(|e| e.to_string())?;
    }
    let key = get_group_key(s, &group_id)
        .await
        .ok_or_else(|| "群密钥缺失".to_string())?;
    let current = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id)
            .map(|g| g.members)
            .unwrap_or_default()
    };
    // 现有成员收到的是同一把密钥（幂等刷新），新成员借此首次拿到密钥
    resend_group_key_to(s, &group_id, &current, key).await;
    // 加人通知：此前完全缺失（见 group_member_added_text 的说明）。
    //
    // ⚠️ 必须走 `send_group_payload`（群密钥加密 + gossip + 每个成员的 outbox），
    // **不能**用 `insert_group_system_message` —— 那个只写本机，其他成员看不到，
    // 就失去了"通知全体"的意义。踢人/退群之所以用本地插入，是因为它们本来就有
    // 专用控制帧广播（GroupMemberRemoved / GroupMemberLeft）；而加人没有控制帧
    // （靠 GroupKey 重发携带新成员表），所以直接借用消息管道。
    let name = resolve_nickname(s, &device_id);
    let text = crate::network::transport::group_member_added_text(s, &name);
    send_group_payload(s, &group_id, "system", text).await?;
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

/// 移人出群：仅创建者。轮换群密钥发给剩余成员，并向被移除者发 GroupMemberRemoved。
#[tauri::command(async)]
pub async fn group_remove_member(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    device_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::remove_group_member(&dbc, &group_id, &device_id).map_err(|e| e.to_string())?;
        // 被移除者不再属于该群：清掉仍指向它的待补发群消息，避免重连时向群外成员投递。
        db::delete_group_outbox_for_peer_in_group(&dbc, &group_id, &device_id).ok();
    }
    // 轮换群密钥：被移除者失去解密能力
    let key = crypto::random_key();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_setting(&dbc, &format!("gk:{group_id}"), &STANDARD.encode(key)).ok();
    }
    s.group_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(group_id.clone(), key);
    let remaining = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id)
            .map(|g| g.members)
            .unwrap_or_default()
    };
    resend_group_key_to(s, &group_id, &remaining, key).await;
    let removed_msg = Message::GroupMemberRemoved {
        group_id: group_id.clone(),
        from: s.device_id.clone(),
        to: device_id.clone(),
    };
    // ① 通知**被移除者本人**清理本地群
    let _ = try_send(s, &device_id, &removed_msg).await;
    // ② **同时通知其余成员**：此前只发给被移除者，而接收端对 `to != 自己` 直接 return，
    //    两头都断 —— 表现为「群里其他人打开群，成员没变少、也没有任何提示」。
    //    现在其余成员收到后同步成员表 + 落一条群内系统消息。
    for m in &remaining {
        if m == &s.device_id || m == &device_id {
            continue;
        }
        let _ = try_send(s, m, &removed_msg).await;
    }
    // ③ 群主自己也要看到这条系统消息（别人靠 ② 各自插入）
    let name = resolve_nickname(s, &device_id);
    crate::network::transport::insert_group_system_message(
        s,
        &group_id,
        &crate::network::transport::group_member_removed_text(s, &name),
    );
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

/// 转让群主：仅**当前**群主可发起，目标必须是群成员。
/// 本地更新创建者后广播 `GroupCreatorChanged` 给全体成员（含新群主本人）。
/// 用于群主更换设备/卸载前移交管理权，避免群永久失去改名/加人/踢人能力。
#[tauri::command(async)]
pub async fn transfer_group_creator(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    new_creator: String,
) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator != s.device_id {
        return Err("只有群创建者可以转让群主".to_string());
    }
    if new_creator == s.device_id {
        return Err("不能把群主转让给自己".to_string());
    }
    if !group.members.contains(&new_creator) {
        return Err("只能转让给群成员".to_string());
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_group_creator(&dbc, &group_id, &new_creator).map_err(|e| e.to_string())?;
    }
    for m in &group.members {
        if m == &s.device_id {
            continue;
        }
        let msg = Message::GroupCreatorChanged {
            group_id: group_id.clone(),
            from: s.device_id.clone(),
            to: new_creator.clone(),
        };
        let _ = try_send(s, m, &msg).await;
    }
    // 群内提示：其余成员各自在 `handle_group_creator_changed` 里插一条，发起方（原群主）
    // 走的是 `from == 自己 ⇒ 直接 return` 那条早退，所以必须在这里补上，否则只有发起方
    // 看不到这次转让 —— 与「踢人」的 ③ 是同一个坑。
    let name = resolve_nickname(s, &new_creator);
    crate::network::transport::insert_group_system_message(
        s,
        &group_id,
        &crate::network::transport::group_creator_changed_text(s, &name),
    );
    let _ = s.app.emit("groups-updated", &group_id);
    Ok(())
}

/// 退出群聊：群主须先转让（否则该群会永久失去管理权）。
/// 退群后清理本地群记录 / 会话 / 群密钥，并广播 `GroupMemberLeft` 让其余成员更新成员表。
/// 复用与「被移出群」同一套本地清理路径（`db::delete_group`）。
#[tauri::command(async)]
pub async fn leave_group(state: State<'_, Arc<AppState>>, group_id: String) -> Result<(), String> {
    let s = state.inner();
    let group = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, &group_id).ok_or_else(|| "群不存在".to_string())?
    };
    if group.creator == s.device_id {
        return Err("群主退群前请先转让群主".to_string());
    }
    // 先通知其余成员（本地记录删除前取成员表）；对方离线时消息会丢失，
    // 但成员表也会随后续群消息（Gossip group_members / GroupKey）自愈。
    for m in &group.members {
        if m == &s.device_id {
            continue;
        }
        let msg = Message::GroupMemberLeft {
            group_id: group_id.clone(),
            from: s.device_id.clone(),
        };
        let _ = try_send(s, m, &msg).await;
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::delete_group(&dbc, &group_id).map_err(|e| e.to_string())?;
        let _ = dbc.execute(
            "DELETE FROM settings WHERE key = ?1",
            rusqlite::params![format!("gk:{group_id}")],
        );
    }
    s.group_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&group_id);
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

/// 切换窗口全屏，返回切换后的状态。
/// 用于 macOS 绿灯的 option-click（HIG：缩放按钮按住 Option 即进入/退出全屏）。
#[cfg(desktop)]
#[tauri::command]
pub fn window_toggle_fullscreen(app: tauri::AppHandle) -> bool {
    let Some(w) = app.get_webview_window("main") else {
        return false;
    };
    match w.is_fullscreen() {
        Ok(true) => {
            let _ = w.set_fullscreen(false);
            false
        }
        _ => {
            let _ = w.set_fullscreen(true);
            true
        }
    }
}

/// 移动端无"全屏"概念（窗口本就铺满屏幕），返回 false。
#[cfg(mobile)]
#[tauri::command]
pub fn window_toggle_fullscreen(_app: tauri::AppHandle) -> bool {
    false
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command(async)]
/// 群消息发送的**唯一内核**：群密钥加密 → Gossip 信封 → 落库（消息 + 每个成员的 outbox）
/// → 广播。文本、代码、表情回应等全部走这一条路。
///
/// 为什么必须只有一条：它们都要 E2EE、都要 outbox 兜底、都要 GroupAck、都要被四层幂等
/// 去重覆盖。若各写一份，任何一处修 bug（历史上最典型的是「填完 group_creator/members
/// 后忘了重算重签 → 群消息被静默丢弃」）都只会修到其中一条路径。
async fn send_group_payload(
    s: &Arc<AppState>,
    group_id: &str,
    kind: &str,
    content: String,
) -> Result<MessageRecord, String> {
    let ts = db::now_ms();
    let conv_id = format!("group:{group_id}");
    let seq = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &conv_id).map_err(|e| format!("逻辑时钟推进失败：{e}"))?
    };
    // 把群名 + 创建者 + 当前成员一并带上：跨端成员即便从未收到 GroupKey、
    // 只凭这条群消息也能在本地正确建群（含成员表），成员面板因此不为空。
    let group_meta = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, group_id).map(|g| (g.name, g.creator, g.members))
    };
    let (group_name, group_creator, group_members) = match group_meta {
        Some((n, c, m)) => (n, Some(c), m),
        None => return Err("群不存在".to_string()),
    };
    if !group_members.contains(&s.device_id) {
        return Err("你已不在该群中".to_string());
    }
    let key = get_group_key(s, group_id).await.ok_or("群密钥缺失")?;
    let preview = preview(kind, &content);

    // 群密钥加密 + Gossip 信封（E2EE 恒开：载荷用群密钥 ChaCha20-Poly1305 加密）
    let plaintext = serde_json::json!({ "kind": kind, "content": content }).to_string();
    let sealed = crypto::seal_symmetric(&key, plaintext.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        let mut env = gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Group,
            Some(group_id.to_string()),
            Some(group_name.clone()),
            &payload_b64,
            ts,
            seq,
        );
        env.group_creator = group_creator;
        env.group_members = group_members.clone();
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
        receiver_id: group_id.to_string(),
        kind: kind.to_string(),
        content: content.clone(),
        ts,
        seq,
        status: "sent".to_string(),
    };
    // 群消息与单聊一样需要可靠投递：本地落库 + 每个成员的 outbox 在同一事务里完成，
    // 再由建链 / Hello / 心跳触发 flush_group_outbox 补发，收到 GroupAck 才删行。
    let gossip_msg = Message::Gossip {
        envelope: env.clone(),
    };
    let payload = serde_json::to_string(&gossip_msg).map_err(|e| e.to_string())?;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        db::insert_message(&tx, &rec).map_err(|e| format!("消息写入失败：{e}"))?;
        if crate::protocol::is_non_notifying_kind(kind) {
            // 静默事件与系统提示不改会话预览 —— 否则「自己回了个表情」会把会话列表摘要
            // 变成一段 JSON。会话行仍要确保存在。
            db::ensure_conversation(&tx, &conv_id, "group", &group_name, None)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        } else {
            db::touch_conversation(&tx, &conv_id, "group", &group_name, None, &preview, 0)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        }
        for member in &group_members {
            if member == &s.device_id {
                continue;
            }
            db::insert_group_outbox(&tx, &rec.msg_id, group_id, member, &payload)
                .map_err(|e| format!("群消息入队失败：{e}"))?;
        }
        tx.commit().map_err(|e| format!("群消息写入失败：{e}"))?;
    }

    broadcast_gossip(s, env).await;

    Ok(rec)
}

// ---------------- 群文件（Offer / session-key 阶段） ----------------

/// 发起群文件（本阶段只建立 Offer 与 file session key，不含分片传输）。
///
/// 流程：校验发起者是群成员 → 实时读取当前成员快照 → 事务内创建
/// group_files + 全部 recipient 行（避免半完成状态）→ 生成随机 file_key
/// 存内存 → 对可达成员发送 GroupFileOffer（群密钥封装 file_key）→
/// 流式读取文件、逐 256KB 分片 AEAD 加密后向全部可达 recipient 发送
/// GroupFileChunk（seq 从 0 严格递增）。不可达成员保持 pending。

/// 发群消息（文本 / 代码）。校验与长度限制留在这一层，内核只管发送。
#[tauri::command(async)]
pub async fn send_group_message(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    content: String,
    kind: String,
) -> Result<MessageRecord, String> {
    let wire_kind = match kind.as_str() {
        "text" => "text",
        "code" => "code",
        _ => return Err("群聊不支持该消息类型".to_string()),
    };
    let content = check_message_content(content)?;
    send_group_payload(state.inner(), &group_id, wire_kind, content).await
}

/// 群任务标题上限：它是卡片上的一行标题，不是长文。
const MAX_TODO_TITLE_LEN: usize = 200;
/// 投票选项数上限（下标要能塞进 u32 且 UI 排得下）。
const MAX_POLL_OPTIONS: usize = 10;

/// 创建一条群任务（任意成员）。
///
/// `todo_id` 用随机 id（`todo-<uuid>`）而不是"创建事件的 msg_id"：后续每一次改状态/改标题
/// 都是**重新发一份定义**，它们必须引用同一个键，而 msg_id 每次都会变。
#[tauri::command(async)]
pub async fn send_group_todo(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    title: String,
    assignees: Vec<String>,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    if title.chars().count() > MAX_TODO_TITLE_LEN {
        return Err(format!("任务标题不能超过 {MAX_TODO_TITLE_LEN} 字"));
    }
    check_todo_assignees(s, &group_id, &assignees)?;
    let payload = crate::protocol::TodoPayload {
        todo_id: format!("todo-{}", Uuid::new_v4()),
        title,
        assignees,
        status: crate::protocol::default_todo_status(),
        creator: s.device_id.clone(),
        deleted: false,
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    send_group_payload(s, &group_id, "todo", content).await
}

/// 被指派人必须**至少一个且都是群成员**（用户 2026-09-16：「每个任务可以给一个或多个人」）。
///
/// 为什么在命令层拦：指派人同时是**改状态的鉴权依据**（见 `may_update_todo`）——
/// 放进一个非成员会让这条任务对谁都"改不了状态"（谁都不是被指派人），而群里也没人认识它。
fn check_todo_assignees(s: &AppState, group_id: &str, assignees: &[String]) -> Result<(), String> {
    if assignees.is_empty() {
        return Err("请至少指派一名成员".to_string());
    }
    let members = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, group_id)
            .map(|g| g.members)
            .ok_or_else(|| "群不存在".to_string())?
    };
    // ⚠️ `resolve_nickname` 内部会再锁一次 db，必须在放锁之后调用（见文件里那条同名注释）
    if let Some(bad) = assignees.iter().find(|a| !members.contains(a)) {
        return Err(format!("{} 不是群成员", resolve_nickname(s, bad)));
    }
    Ok(())
}

/// 取某个任务在**本机消息库**里的最新定义（LWW：`(seq desc, msg_id desc)`）。
///
/// 为什么后端也要做这一步：命令层要判权就得知道这条任务的 `creator` 与 `assignees`，
/// 而它们只存在于事件日志里（这些特性没有专表，见 ADR-0018）。这里只取"最新一条定义"
/// 这一件事、不做完整折叠；**LWW 规则必须与前端 `src/utils/todos.ts` 的 `newer()` 一致**
/// （`(seq, msg_id)` 元组比较，同 seq 时按 msg_id 字符串比）。
///
/// 已删除（墓碑）的定义照样返回：改/删的鉴权同样需要它的 creator。
fn latest_todo_def(
    conn: &rusqlite::Connection,
    conv_id: &str,
    todo_id: &str,
) -> Option<crate::protocol::TodoPayload> {
    let mut stmt = conn
        .prepare(
            // 两种 kind 都要看：创建是 `todo`、后续每次改动是 `todo_update`，
            // 它们同属一条 LWW 序列（载荷同构）。
            "SELECT content FROM messages WHERE conv_id = ?1 AND kind IN ('todo', 'todo_update') \
             ORDER BY seq DESC, msg_id DESC",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![conv_id], |r| r.get::<_, String>(0))
        .ok()?;
    for row in rows.flatten() {
        if let Ok(p) = serde_json::from_str::<crate::protocol::TodoPayload>(&row) {
            if p.todo_id == todo_id {
                return Some(p);
            }
        }
    }
    None
}

/// 谁能改一条任务 —— **纯函数**，便于单测。
///
/// | 改动 | 允许谁 |
/// |---|---|
/// | 只改状态 | 创建者 **或** 被指派人 |
/// | 改标题 / 指派人 / 删除（`structural`） | 创建者 **或** 群主 |
///
/// 为什么分两档：状态是执行者每天在动的东西（谁被指派谁就能推进），
/// 而标题/指派人/删除是**任务的归属**，只有创建者或群主能动。
fn may_update_todo(
    def: &crate::protocol::TodoPayload,
    actor: &str,
    group_creator: &str,
    structural: bool,
) -> bool {
    if def.creator == actor {
        return true;
    }
    if structural {
        group_creator == actor
    } else {
        def.assignees.iter().any(|a| a == actor)
    }
}

/// 更新一条群任务：改状态 / 改标题与指派人 / 删除。
///
/// 为什么三件事合成一个命令：它们都是"重新发一份定义"（LWW per `todo_id`），
/// 构造与校验几乎相同，只有鉴权口径不同（见 [`may_update_todo`]）——
/// 拆成三个命令就是三份重复的构造/校验代码。
///
/// ⚠️ `creator` **不从参数来**：由服务端从库里最新定义回填。否则任何人传一个别人的
/// creator 就能改别人的任务（而 creator 正是鉴权依据）。
#[tauri::command(async)]
pub async fn update_group_todo(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    todo_id: String,
    title: String,
    assignees: Vec<String>,
    status: String,
    deleted: bool,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    let title = title.trim().to_string();
    if !deleted {
        if title.is_empty() {
            return Err("任务标题不能为空".to_string());
        }
        if title.chars().count() > MAX_TODO_TITLE_LEN {
            return Err(format!("任务标题不能超过 {MAX_TODO_TITLE_LEN} 字"));
        }
        if !crate::protocol::todo_status_is_valid(&status) {
            return Err("任务状态不合法".to_string());
        }
        check_todo_assignees(s, &group_id, &assignees)?;
    }
    let (def, group_creator) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let def = latest_todo_def(&dbc, &format!("group:{group_id}"), &todo_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let creator = db::get_group(&dbc, &group_id)
            .map(|g| g.creator)
            .ok_or_else(|| "群不存在".to_string())?;
        (def, creator)
    };
    // "结构改动"：删、换标题、换指派人。只改状态时不算（那是被指派人的日常动作）。
    let structural = deleted || title != def.title || assignees != def.assignees;
    if !may_update_todo(&def, &s.device_id, &group_creator, structural) {
        return Err(if structural {
            "只有任务创建者或群主可以修改任务".to_string()
        } else {
            "只有创建者或被指派人可以修改任务状态".to_string()
        });
    }
    let payload = crate::protocol::TodoPayload {
        todo_id,
        title,
        assignees,
        status,
        creator: def.creator,
        deleted,
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    // ⚠️ 发 `todo_update`（Silent）而不是 `todo`（Card）：改状态/改标题/删除是**状态微调**，
    // 不该给全群记未读、弹通知（创建才该）。两者载荷同构、折叠也是同一条 LWW 规则，
    // 区别只在通知口径 —— 详见 `protocol.rs` 的 `WIRE_KINDS` 注释。
    send_group_payload(s, &group_id, "todo_update", content).await
}

/// 发起投票（任意成员）。
#[tauri::command(async)]
pub async fn send_group_poll(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    question: String,
    options: Vec<String>,
    multi: bool,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    let question = question.trim().to_string();
    let options: Vec<String> = options
        .into_iter()
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .collect();
    if question.is_empty() {
        return Err("投票主题不能为空".to_string());
    }
    if options.len() < 2 {
        return Err("至少需要两个选项".to_string());
    }
    if options.len() > MAX_POLL_OPTIONS {
        return Err(format!("最多 {MAX_POLL_OPTIONS} 个选项"));
    }
    let payload = crate::protocol::PollPayload {
        poll_id: format!("poll-{}", Uuid::new_v4()),
        question,
        options,
        multi,
        closed: false,
        creator: s.device_id.clone(),
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    send_group_payload(s, &group_id, "poll", content).await
}

/// 投票 / 改票 / 撤票（任意成员；每人只写自己那一格）。
/// 撤票就是传空的 `choices`。
#[tauri::command(async)]
pub async fn cast_group_poll_vote(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    poll_id: String,
    choices: Vec<u32>,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    if poll_id.is_empty() {
        return Err("缺少投票标识".to_string());
    }
    let content = serde_json::to_string(&crate::protocol::PollVotePayload { poll_id, choices })
        .map_err(|e| e.to_string())?;
    send_group_payload(s, &group_id, "poll_vote", content).await
}

/// 发布群公告（**仅群主**）。
///
/// 权限口径与 `handle_group_rename` 逐字同构（`group.creator == 我`）：
/// 公告是发给全群的**权威信息**，人人可发就失去了"公告"的意义。
/// 群主离线时发不了 —— 无中心即无中心授权，不做"降级为任何人可发"。
#[tauri::command(async)]
pub async fn send_group_announcement(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    text: String,
) -> Result<MessageRecord, String> {
    let s = state.inner();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("公告内容不能为空".to_string());
    }
    if text.chars().count() > MAX_ANNOUNCEMENT_LEN {
        return Err(format!("公告不能超过 {MAX_ANNOUNCEMENT_LEN} 字"));
    }
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let g = db::get_group(&dbc, &group_id).ok_or("群不存在")?;
        if g.creator != s.device_id {
            return Err("只有群主可以发布公告".to_string());
        }
    }
    let content = serde_json::to_string(&crate::protocol::AnnouncementPayload { text })
        .map_err(|e| e.to_string())?;
    send_group_payload(s, &group_id, "announcement", content).await
}

/// 公告长度上限：与群名（40）同档量级 —— 公告是置顶横幅里的一段短文本，
/// 不是长文（长文该发消息）。同时也是对广播体积的限制。
const MAX_ANNOUNCEMENT_LEN: usize = 500;

/// 置顶 / 取消置顶一条群消息。
///
/// 权限：任意群成员（可逆、低风险）。与「仅群主可改名」那类不可逆操作不同 ——
/// 置顶错了再取消即可，不必引入管理员角色。
#[tauri::command(async)]
pub async fn pin_group_message(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    target: String,
    pinned: bool,
) -> Result<MessageRecord, String> {
    if target.is_empty() {
        return Err("缺少目标消息".to_string());
    }
    let payload = crate::protocol::PinPayload {
        target: target.clone(),
        pinned,
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    // ⚠️ **必须把事件记录返回给前端**（与 `send_group_reaction` 同口径）。
    // 置顶在界面上的呈现是 `foldPinned(该会话全部消息)` 折叠出来的 ——
    // 事件不进前端 store，折叠就看不到它，界面要等重进会话重新拉全量才刷新。
    // 此前这里返回 `()`，前端拿到了也无从 enqueue。
    send_group_payload(state.inner(), &group_id, "pin", content).await
}

/// 撤回窗口：超过它就不再允许撤回。
///
/// **只在发送端强制**。接收端无法验证发送方的墙上时钟（`env.ts` 不参与排序也不可信），
/// 所以接收端接受任何来自作者本人的撤回 —— 这是产品规则，不是安全边界。
/// 真正不可伪造的是**作者身份**：信封被 Ed25519 签名，只有原作者能撤回自己的消息。
const RECALL_WINDOW_MS: i64 = 120_000;

/// 撤回一条自己发的群消息。
///
/// 权限：**仅原作者**。不做"群主撤他人" —— 那需要引入管理员角色，
/// 而没有中心权威就没有中心授权（本项目无服务器）。
#[tauri::command(async)]
pub async fn recall_group_message(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    target: String,
) -> Result<(), String> {
    let s = state.inner();
    let conv_id = format!("group:{group_id}");
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let Some((sender_id, _)) = db::get_message_preview_source(&dbc, &target) else {
            return Err("消息不存在".to_string());
        };
        if sender_id != s.device_id {
            return Err("只能撤回自己发送的消息".to_string());
        }
        // 时间窗**只在发送端强制**（见 RECALL_WINDOW_MS 的说明：接收端无法验证对方的时钟）。
        // 用本地记录的 ts 判断：这条消息是本机发出的，本地时钟对它有意义。
        let ts: i64 = dbc
            .query_row(
                "SELECT ts FROM messages WHERE msg_id = ?1",
                rusqlite::params![target],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if ts > 0 && db::now_ms() - ts > RECALL_WINDOW_MS {
            return Err("超过可撤回时间（2 分钟）".to_string());
        }
        if db::is_recalled(&dbc, &target) {
            return Ok(()); // 幂等：已撤回过就直接成功
        }
    }
    let payload = crate::protocol::RecallPayload {
        target: target.clone(),
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    // 先发事件（走与普通消息同一条可靠管道），成功后再物化本地 ——
    // 顺序反了会出现「本地显示已撤回、但对端根本没收到」。
    send_group_payload(s, &group_id, crate::protocol::KIND_RECALL, content).await?;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let seq = db::get_clock(&dbc, &conv_id);
        db::insert_recall(&dbc, &conv_id, &target, &s.device_id, seq).ok();
        db::materialize_recall(&dbc, &target).ok();
    }
    let _ = s.app.emit("message-recalled", &target);
    Ok(())
}

/// 表情回应：对某条群消息添加/取消一个表情。
///
/// 它是一条**静默事件**（`kind = "reaction"`）：走与普通群消息完全相同的可靠管道
/// （E2EE + outbox + GroupAck + 幂等去重 + 离线补发），但接收端不计未读、不改预览、
/// 不弹通知 —— 否则「回个表情」会和发一条消息一样吵闹，正是这个功能要消除的噪音。
#[tauri::command(async)]
pub async fn send_group_reaction(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    target: String,
    emoji: String,
    add: bool,
) -> Result<MessageRecord, String> {
    if target.is_empty() {
        return Err("回应缺少目标消息".to_string());
    }
    // 只接受本应用已知的表情 token 形态（`[名字]`），避免把任意字符串当表情写进库里、
    // 也避免超长内容进入广播。
    if !crate::protocol::is_valid_emoji_token(&emoji) {
        return Err("不认识的表情".to_string());
    }
    let payload = crate::protocol::ReactionPayload { target, emoji, add };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    send_group_payload(state.inner(), &group_id, "reaction", content).await
}

#[tauri::command(async)]
pub async fn send_group_file(
    state: State<'_, Arc<AppState>>,
    group_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();

    // 文件校验：存在 + 普通文件；size/name 取自本地 metadata，不进入协议
    let p = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("文件不存在或不可读：{e}"))?;
    if !meta.is_file() {
        return Err("只能发送普通文件".to_string());
    }
    let size = meta.len();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    // 文件级 SHA-256：256KB 分块流式计算放阻塞线程池（不整读内存、不卡 async runtime）
    let p_sha = p.clone();
    let sha256 = tokio::task::spawn_blocking(move || file::sha256_file_hex(&p_sha))
        .await
        .map_err(|e| e.to_string())??;

    // 发起者必须是群成员（本地群存在）
    let members: Vec<String> = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let group = db::get_group(&dbc, &group_id).ok_or("群不存在")?;
        if !group.members.contains(&s.device_id) {
            return Err("你不是该群成员".to_string());
        }
        // 成员快照：创建时当前群成员（不含自己），作为 recipient 集合
        group
            .members
            .into_iter()
            .filter(|m| m != &s.device_id)
            .collect()
    };
    if members.is_empty() {
        return Err("群内没有其他成员".to_string());
    }

    let transfer_id = Uuid::new_v4().to_string();

    // 事务：group_files + 全部 recipient 行一次写入，避免半完成状态
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let gf = GroupFile {
            transfer_id: transfer_id.clone(),
            group_id: group_id.clone(),
            sender_id: s.device_id.clone(),
            name: name.clone(),
            size,
            sha256: sha256.clone(),
            status: "pending".to_string(),
            created_at: db::now_ms(),
        };
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        db::insert_group_file(&tx, &gf).map_err(|e| e.to_string())?;
        for m in &members {
            db::insert_group_file_recipient(&tx, &transfer_id, m).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // 群密钥获取与 file_key 封装先于运行态写入：任何失败都不残留内存状态
    let group_key = get_group_key(s, &group_id).await.ok_or("群密钥缺失")?;

    // 随机 file session key：一个 transfer 只生成一次（CSPRNG，仅内存）
    let file_key = crypto::random_key();
    let sealed_file_key =
        STANDARD.encode(crypto::seal_symmetric(&group_key, &file_key).ok_or("封装文件密钥失败")?);
    s.group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(transfer_id.clone(), file_key);
    // 密封 file_key 持久化（群密钥封装，非明文）：重启后离线 pending
    // 群文件的投递仍能恢复 file_key（群密钥 gk:% 本身保留）
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_setting(&dbc, &format!("gfk:{transfer_id}"), &sealed_file_key).ok();
    }

    // 发送者本地气泡先落库：无论成员当前是否在线，用户看到的都是「发送中/待投递」，
    // 而不是一个报错后又偷偷排队的隐藏任务。
    // 图片文件保持 kind="image"，预览摘要为 [图片]，其余走 kind="file"。
    let subtype = file::classify_file_subtype(&name);
    let kind = if subtype == "image" { "image" } else { "file" };
    let content =
        serde_json::json!({ "name": name, "path": path, "size": size, "sha256": sha256, "subtype": subtype })
            .to_string();
    let conv_id = format!("group:{group_id}");
    let seq = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &conv_id).unwrap_or(1)
    };
    let rec = MessageRecord {
        id: 0,
        msg_id: format!("gfile-{transfer_id}"),
        conv_id,
        sender_id: s.device_id.clone(),
        receiver_id: group_id.clone(),
        kind: kind.to_string(),
        content,
        ts: db::now_ms(),
        seq,
        status: "sending".to_string(),
    };
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::insert_message(&dbc, &rec).ok();
        db::upsert_transfer(
            &dbc,
            &transfer_id,
            &group_id,
            &name,
            size,
            "send",
            "active",
            Some(p.to_string_lossy().as_ref()),
            0.0,
        )
        .ok();
        let group_name = db::get_group(&dbc, &group_id)
            .map(|g| g.name)
            .unwrap_or_default();
        let preview = if kind == "image" {
            "[图片]".to_string()
        } else {
            format!("[群文件] {name}")
        };
        db::touch_conversation(
            &dbc,
            &format!("group:{group_id}"),
            "group",
            &group_name,
            None,
            &preview,
            0,
        )
        .ok();
    }
    let _ = s.app.emit("message-received", &rec);

    // 可达成员：有 TCP link 且 peers 信息完整；其余保持 pending，由上线事件自动投递。
    let mut reachable: Vec<String> = Vec::new();
    for m in &members {
        if s.has_link(m).await && resolve_member_x25519(s, m).is_some() {
            reachable.push(m.clone());
        }
    }

    // 进度条分母快照：发送那一刻在线的成员（用户口径见 `AppState::group_file_online_targets`）。
    // 冻结在这里的理由：离线成员之后上线补发时**不得**回退进度条（用户明确要求），
    // 动态算分母会让他一上线就把进度条往回拉。
    {
        let mut snap = s
            .group_file_online_targets
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        snap.insert(transfer_id.clone(), reachable.iter().cloned().collect());
    }

    // 逐可达成员发送 Offer
    for m in &reachable {
        let msg = Message::GroupFileOffer {
            transfer_id: transfer_id.clone(),
            group_id: group_id.clone(),
            sender_id: s.device_id.clone(),
            name: name.clone(),
            size,
            sha256: sha256.clone(),
            sealed_file_key: sealed_file_key.clone(),
        };
        if try_send(s, m, &msg).await.is_ok() {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::update_group_file_recipient(&dbc, &transfer_id, m, "sending", 0.0);
        }
    }

    // 逐可达成员并行投递（每个 recipient 独立任务：Offer → Chunk → Done）。
    // 单个 recipient 失败只标它 failed，不阻塞其他；离线成员保持 pending，
    // 由上线事件（flush_pending_group_files）自动投递。
    let s2 = s.clone();
    let tid = transfer_id.clone();
    let gid = group_id.clone();
    let src = p.clone();
    for m in &reachable {
        let s3 = s2.clone();
        let tid3 = tid.clone();
        let gid3 = gid.clone();
        let src3 = src.clone();
        let m3 = m.clone();
        tokio::spawn(async move {
            if let Err(e) =
                dispatch_group_file_to_peer(&s3, &tid3, &gid3, &m3, src3.to_string_lossy().as_ref())
                    .await
            {
                app_handle_log(
                    &s3,
                    &format!("group-file dispatch {tid3} -> {m3} failed: {e}"),
                );
            }
        });
    }

    Ok(transfer_id)
}

/// 群文件「已投递到几个成员」的进度聚合 —— **只按发送时在线的成员平均**。
///
/// 用户口径（2026-09-12 反馈）：进度条表示「**在线成员**都收到了」，不是「全员都收到了」。
/// 离线成员不计入分母，他上线后的补发也**不回退**进度条。
///
/// 分母取自 `state.group_file_online_targets`（发送那一刻冻结的快照）；快照缺失
/// （进程重启后内存态丢失）时退回「全体 recipient 平均」—— 仍是单调不减的口径，
/// 不会出现进度条倒退。
///
/// `fallback` 是调用方刚算出的**本条连接**字节进度，用于覆盖 DB 尚未刷新的那一拍。
///
/// ⚠️ 本函数**自己取 `state.db` 锁**：调用方必须在**未持有 db 锁**时调用（std Mutex 不可重入）。
pub(crate) fn group_file_online_progress(
    state: &AppState,
    transfer_id: &str,
    fallback: f64,
) -> f64 {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let recipients = db::list_group_file_recipients(&dbc, transfer_id).unwrap_or_default();
    drop(dbc);
    if recipients.is_empty() {
        return fallback.clamp(0.0, 1.0);
    }
    let snapshot = state
        .group_file_online_targets
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(transfer_id)
        .cloned();
    group_file_progress_from(&recipients, snapshot.as_ref(), fallback)
}

/// `group_file_online_progress` 的**纯函数内核**（便于单测，不碰锁/DB）。
///
/// 口径（用户 2026-09-12）：`online` = 发送那一刻在线的 recipient 集合。
/// - `online` 为 `None`（快照丢失，如进程重启）→ 分母 = **全体** recipient；
/// - `online` 为空集（发送时无人在线）→ **0**（没有在线成员可等，进度条不该满格）；
/// - 否则分母 = 快照内成员，进度 = 其各自进度的**平均**（离线成员不参与）。
///
/// `fallback` 是调用方刚算出的本条连接字节进度（DB 可能还没刷新到这一拍），
/// 最终取 `max(聚合, fallback)` ⇒ **单调不减**，符合「补发不回退进度条」。
pub(crate) fn group_file_progress_from(
    recipients: &[crate::state::GroupFileRecipient],
    online: Option<&std::collections::HashSet<String>>,
    fallback: f64,
) -> f64 {
    let fallback = fallback.clamp(0.0, 1.0);
    let denom: Vec<&crate::state::GroupFileRecipient> = match online {
        Some(set) if !set.is_empty() => recipients
            .iter()
            .filter(|r| set.contains(&r.recipient_id))
            .collect(),
        Some(_) => return 0.0,
        None => recipients.iter().collect(),
    };
    if denom.is_empty() {
        return fallback;
    }
    let sum: f64 = denom.iter().map(|r| r.progress.clamp(0.0, 1.0)).sum();
    (sum / denom.len() as f64).max(fallback).clamp(0.0, 1.0)
}

/// 群文件投递失败诊断（emit 给 DevDiag 面板；不打印任何密钥/明文内容）。
fn app_handle_log(state: &Arc<AppState>, msg: &str) {
    let _ = state.app.emit("group-file-log", msg);
}

/// 向单个 recipient 执行完整群文件投递：Offer → 流式 Chunk → Done。
/// 元数据/源路径/密钥均从 DB 与运行态恢复，支持离线 pending 的延迟投递。
async fn dispatch_group_file_to_peer(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    recipient: &str,
    source_path: &str,
) -> Result<(), String> {
    let gf = db::get_group_file(
        &state.db.lock().unwrap_or_else(|e| e.into_inner()),
        transfer_id,
    )
    .ok_or("群文件记录不存在")?;
    let group_key = get_group_key(state, group_id).await.ok_or("群密钥缺失")?;
    let file_key = ensure_group_file_key(state, transfer_id, group_id, &group_key)
        .ok_or("文件会话密钥缺失")?;
    let sealed_file_key =
        STANDARD.encode(crypto::seal_symmetric(&group_key, &file_key).ok_or("封装文件密钥失败")?);

    // 源文件必须仍存在：不存在则该 recipient 置 failed（明确状态变化，
    // 不允许数据库停留在 pending 却永远无法投递）
    let src = std::path::PathBuf::from(source_path);
    let size = match std::fs::metadata(&src) {
        Ok(m) if m.is_file() => m.len(),
        _ => {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::update_group_file_recipient(&dbc, transfer_id, recipient, "failed", 0.0);
            return Err("源文件已不存在".to_string());
        }
    };

    // recipient → sending + Offer
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::update_group_file_recipient(&dbc, transfer_id, recipient, "sending", 0.0);
    }
    let offer = Message::GroupFileOffer {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: state.device_id.clone(),
        name: gf.name.clone(),
        size,
        sha256: gf.sha256.clone(),
        sealed_file_key,
    };
    try_send(state, recipient, &offer)
        .await
        .map_err(|e| format!("Offer 发送失败：{e}"))?;

    // 流式分片：按**该接收者的实际链路**选块大小 → AEAD（独立随机 nonce）→ Base64 → GroupFileChunk。
    //
    // ⚠️ 不能再用固定的 256KiB（原 `FILE_CHUNK`）：BLE 上 256KiB base64 后约 350KB，
    // MTU=23 时需 ≈25000 片 > `MAX_BLE_CHUNKS_PER_MESSAGE`(8192) ⇒ `fragment()` 返回 `None`
    // ⇒ 整帧被丢（只留一条 warn），而发送方界面照旧显示"已发送"
    // —— 即**群文件在 BLE 上等于 0 字节可达**。
    // 单聊路径早已用 `chunk_size_for_path` 修掉同一个坑（推导见 `network/file.rs`），这里补齐。
    let path_kind = crate::network::transport::inbound_path_kind(state, recipient).await;
    let chunk_size = file::chunk_size_for_path(&path_kind);
    let mut f = tokio::fs::File::open(&src)
        .await
        .map_err(|e| e.to_string())?;
    use tokio::io::AsyncReadExt;
    let mut buf = vec![0u8; chunk_size];
    let mut seq: u32 = 0;
    let mut sent: u64 = 0;
    let mut last_report = std::time::Instant::now() - std::time::Duration::from_secs(1);
    loop {
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let Some(key) = state
            .group_file_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(transfer_id)
            .copied()
        else {
            return Err("文件会话密钥丢失".to_string());
        };
        let sealed = crypto::seal_symmetric(&key, &buf[..n]).ok_or("分片加密失败")?;
        let data = STANDARD.encode(&sealed);
        let chunk = Message::GroupFileChunk {
            transfer_id: transfer_id.to_string(),
            group_id: group_id.to_string(),
            sender_id: state.device_id.clone(),
            seq,
            data,
        };
        try_send(state, recipient, &chunk)
            .await
            .map_err(|e| format!("分片发送失败：{e}"))?;
        sent += n as u64;
        // 真实本地进度节流落库（250ms），并向前端推送进度事件。
        if last_report.elapsed() >= std::time::Duration::from_millis(250) {
            last_report = std::time::Instant::now();
            let progress = if size == 0 {
                1.0
            } else {
                sent as f64 / size as f64
            };
            // 发送方气泡的进度口径：**只按发送时在线的成员平均**（用户 2026-09-12 反馈）。
            // 离线成员不计入分母、之后补发也不回退进度条；在线成员全部完成即 100%。
            //
            // ⚠️ 先算聚合再取 db 锁：`group_file_online_progress` 内部要读 DB，
            // 若在持有 db 锁时调用就是同锁重入（std Mutex 不可重入，必死锁）。
            // 聚合口径取「在线成员各自进度的平均」，因此这里传入的是**本条连接**的
            // 字节进度，函数内部再与落库值取 max（同一 recipient 的进度单调不减）。
            let max_progress = group_file_online_progress(state, transfer_id, progress);
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ =
                db::update_group_file_recipient(&dbc, transfer_id, recipient, "sending", progress);
            let _ = db::upsert_transfer(
                &dbc,
                transfer_id,
                group_id,
                &gf.name,
                size,
                "send",
                "active",
                Some(source_path),
                max_progress,
            );
            drop(dbc);
            let _ = state.app.emit(
                "file-progress",
                &crate::state::FileProgress {
                    transfer_id: transfer_id.to_string(),
                    received: (size as f64 * max_progress) as u64,
                    total: size,
                },
            );
        }
        seq += 1;
    }
    // Done：分片全部发出，接收端据此做最终校验
    let done = Message::GroupFileDone {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: state.device_id.clone(),
    };
    try_send(state, recipient, &done)
        .await
        .map_err(|e| format!("Done 发送失败：{e}"))?;
    Ok(())
}

/// 恢复/获取群文件会话密钥：优先内存运行态；
/// 缺失时从持久化的密封密钥（gfk:{tid}，群密钥封装）解封并回填内存。
/// 明文 file_key 仍不落库（gfk 存的是群密钥封装后的密文，与 wire 一致）。
pub fn ensure_group_file_key(
    state: &AppState,
    transfer_id: &str,
    group_id: &str,
    group_key: &[u8; 32],
) -> Option<[u8; 32]> {
    let _ = group_id; // 预留：未来按群隔离密钥命名空间
    if let Some(k) = state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(transfer_id)
    {
        return Some(*k);
    }
    let sealed_b64 = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_setting(&dbc, &format!("gfk:{transfer_id}"))
    }?;
    let sealed = STANDARD.decode(sealed_b64).ok()?;
    let key: [u8; 32] = crypto::open_symmetric(group_key, &sealed)?
        .try_into()
        .ok()?;
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(transfer_id.to_string(), key);
    Some(key)
}

/// peer 上线（Hello / 心跳 / 建链）后触发：把该 peer 的 pending 群文件
/// 顺序投递（同一 peer 串行，不同 peer 并行）。
/// 防重入：group_file_sending 标记保证同一 peer 同时只有一个投递任务；
/// 源文件已不存在 → recipient 置 failed（不留永远无法投递的 pending）；
/// 无 link 时保持 pending，本次直接返回（下次连接事件再触发）。
pub async fn flush_pending_group_files(state: &Arc<AppState>, peer_id: &str) {
    if !state
        .group_file_sending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer_id.to_string())
    {
        return; // 该 peer 已有投递任务在执行
    }
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_pending_group_files_for_recipient(&dbc, peer_id).unwrap_or_default()
    };
    if pending.is_empty() {
        state
            .group_file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        return;
    }
    let mut tasks: Vec<(String, String, String)> = Vec::new();
    for (tid, gid) in pending {
        // 源文件仍在本机（file_transfers send 行的 path）才可投递
        let src = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_transfer_path(&dbc, &tid)
        };
        let ok = src
            .as_deref()
            .map(|p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
            .unwrap_or(false);
        if ok {
            tasks.push((tid, gid, src.unwrap()));
        } else {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::update_group_file_recipient(&dbc, &tid, peer_id, "failed", 0.0);
        }
    }
    if tasks.is_empty() {
        state
            .group_file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        return;
    }
    let s2 = state.clone();
    let peer = peer_id.to_string();
    tauri::async_runtime::spawn(async move {
        for (tid, gid, src) in tasks {
            if let Err(e) = dispatch_group_file_to_peer(&s2, &tid, &gid, &peer, &src).await {
                app_handle_log(
                    &s2,
                    &format!("group-file dispatch {tid} -> {peer} failed: {e}"),
                );
            }
        }
        s2.group_file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&peer);
    });
}

// ---------------- 文件传输 ----------------

/// 图片 MIME → 扩展名（仅接受常见格式）。
fn image_extension(mime: &str) -> Option<&'static str> {
    match mime.to_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// 纯函数：验证并解码 data URL 图片，返回 (扩展名, 解码后字节)。
/// 用于单元测试覆盖 MIME/大小/base64 等校验逻辑，不涉及文件系统。
fn decode_outgoing_image(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    const PREFIX: &str = "data:";
    if !data_url.starts_with(PREFIX) {
        return Err("非法的 data URL".to_string());
    }
    let rest = &data_url[PREFIX.len()..];
    let Some((meta, encoded)) = rest.split_once(',') else {
        return Err("非法的 data URL".to_string());
    };
    let meta = meta.to_lowercase();
    if !meta.ends_with(";base64") {
        return Err("只接受 base64 编码的 data URL".to_string());
    }
    let mime = meta.trim_end_matches(";base64").trim();
    if !mime.starts_with("image/") {
        return Err("只接受图片文件".to_string());
    }
    let Some(ext) = image_extension(mime) else {
        return Err("不支持的图片格式".to_string());
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("图片解码失败：{e}"))?;
    if bytes.len() as u64 > MAX_OUTGOING_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} > {}），请压缩后重试",
            bytes.len(),
            MAX_OUTGOING_IMAGE_BYTES
        ));
    }
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    Ok((ext, bytes))
}

/// 把前端 paste 产生的 data URL 解码保存为本地文件。
/// 仅接受 image/* 常见格式，按解码后字节数限制，返回本地路径/文件名/大小。
#[tauri::command(async)]
pub fn save_outgoing_image(
    state: State<'_, Arc<AppState>>,
    data_url: String,
) -> Result<serde_json::Value, String> {
    let (ext, bytes) = decode_outgoing_image(&data_url)?;
    let name = format!("image-{}.{ext}", Uuid::new_v4());
    let dl = state
        .inner()
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let path = dl.join(&name);
    std::fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("图片保存失败：{e}"))?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy().to_string(),
        "name": name,
        "size": bytes.len() as u64,
    }))
}

/// 删除本地文件（用于图片发送初始化失败后清理孤儿文件）。
///
/// ⚠️ **只允许删除下载目录内的文件**。读取侧早有这条边界（见 `resolve_media_path`：
/// canonicalize 后必须落在 downloads 内，或该消息确由本机发出），删除侧原先却接受任意路径。
/// 当前唯一调用方只清理 `save_outgoing_image` 刚写进 downloads 的孤儿图片，
/// 所以这条限制不影响任何既有功能；但若哪天有 UI 把它接到消息里的 `path`
/// （该字段由对端控制），没有它就会变成「对端点一下按钮删掉本机任意文件」。
///
/// 用 canonicalize 比对，避免 `../` 或符号链接绕过前缀匹配。
#[tauri::command(async)]
pub fn delete_file(state: State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    let s = state.inner();
    let file = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let dl = s
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let under_downloads = std::fs::canonicalize(&dl)
        .map(|dir| file.starts_with(dir))
        .unwrap_or(false);
    if !under_downloads {
        return Err("只能删除下载目录内的文件".to_string());
    }
    std::fs::remove_file(&file).map_err(|e| e.to_string())
}

/// 用系统默认应用打开本地文件。
/// macOS 走 NSWorkspace（沙盒下 /usr/bin/open 被拦）；Android 走 FileProvider + ACTION_VIEW
/// （私有目录的文件不能以 file:// 交给别的应用，见 android_open.rs）；Windows/Linux 走 opener。
#[tauri::command(async)]
pub fn open_file_native(path: String) -> Result<(), String> {
    crate::open_path::open_path_native(std::path::Path::new(&path))
}

/// macOS 窗口圆角：WebView 加载完成后（前端 onMounted 触发）设背景色跟随主题 +
/// contentView 圆角（setup 阶段设会被 wry 替换 contentView 丢失）。非 macOS 无操作。
#[tauri::command]
pub fn apply_macos_window_shape(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return crate::macos_window::apply_rounded_corners(&window, dark);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, dark);
        Ok(())
    }
}

/// 群文件投递摘要（气泡成员状态文案用）：总数/completed/failed/待投递。
#[tauri::command(async)]
pub fn get_group_file_delivery_summary(
    state: State<'_, Arc<AppState>>,
    transfer_id: String,
) -> Option<db::GroupFileDeliverySummary> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::get_group_file_delivery_summary(&dbc, &transfer_id)
}

/// 群文件列表里的一项（前端「群文件」面板）。
#[derive(serde::Serialize)]
pub struct GroupFileEntry {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub sender_id: String,
    pub created_at: i64,
    /// 本机视角的持有状态：`local`（在本机可打开）/ `receiving`（传输中）/
    /// `remote`（未取到）/ `failed`（取失败，可重试）。
    /// **不由群投递状态推导**：我发出去的文件对别人是否送达，与我本机能不能打开无关。
    pub local_state: String,
    /// 本机完整文件的真实路径（仅 `local_state == "local"` 时给出）。
    pub local_path: Option<String>,
    /// 该文件对全群的投递进度（已完成成员数 / 成员总数）。
    pub delivered: i64,
    pub total: i64,
}

/// 列出某群的全部群文件，附带「本机是否持有」与「对全群投递进度」。
///
/// 本机持有状态的判定必须**看磁盘**：路径在 DB 里存在不代表文件还在
/// （缓存清理会删掉媒体文件，见 `clean_cache_now`）。只信 DB 会让面板列出
/// 一堆点了打不开的条目。
#[tauri::command(async)]
pub fn list_group_files(
    state: State<'_, Arc<AppState>>,
    group_id: String,
) -> Result<Vec<GroupFileEntry>, String> {
    let s = state.inner();
    let me = s.device_id.clone();
    // 先把 DB 该给的都取出来，**随即释放 db 锁** —— 下面的磁盘 stat 是阻塞 I/O，
    // 持着全局 db 锁做 N 次 stat 会把整条消息链路的落库一起堵住。
    type Row = (crate::state::GroupFile, i64, i64, String, Option<String>);
    let rows: Vec<Row> = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let files = db::list_group_files(&dbc, &group_id).map_err(|e| e.to_string())?;
        files
            .into_iter()
            .map(|f| {
                let summary = db::get_group_file_delivery_summary(&dbc, &f.transfer_id);
                let (delivered, total) = match summary {
                    Some(x) => (x.completed, x.total),
                    None => (0, 0),
                };
                let my_status = db::get_group_file_recipient_status(&dbc, &f.transfer_id, &me)
                    .unwrap_or_default();
                let path = db::get_transfer_path(&dbc, &f.transfer_id);
                (f, delivered, total, my_status, path)
            })
            .collect()
    };
    Ok(rows
        .into_iter()
        .map(|(f, delivered, total, my_status, path)| {
            let (local_state, local_path) = if f.sender_id == me {
                // 发送者不参与 recipients（见 send_group_file 的成员过滤），其 recipient 行
                // 恒为空 —— 按 my_status 判定会让自己发的文件永远显示"未取到"。
                // 本机是否还留着原件，只能看磁盘。
                local_path_state(path)
            } else {
                match my_status.as_str() {
                    "completed" => local_path_state(path),
                    "sending" | "pending" => ("receiving".to_string(), None),
                    "failed" => ("failed".to_string(), None),
                    // 没有 recipient 行：该文件早于本机入群，尚未登记接收
                    _ => ("remote".to_string(), None),
                }
            };
            GroupFileEntry {
                transfer_id: f.transfer_id,
                name: f.name,
                size: f.size,
                sender_id: f.sender_id,
                created_at: f.created_at,
                local_state,
                local_path,
                delivered,
                total,
            }
        })
        .collect())
}

/// 路径 → 持有状态：路径存在且**文件仍在磁盘上**才算 `local`，否则回落到 `remote`。
fn local_path_state(path: Option<String>) -> (String, Option<String>) {
    match path {
        Some(p) if std::path::Path::new(&p).is_file() => ("local".to_string(), Some(p)),
        _ => ("remote".to_string(), None),
    }
}

/// 构造一条本地文件/图片消息记录（发送方）。
/// kind 由调用方根据 subtype 决定：image 子类型保持 kind="image"，其余为 "file"。
fn build_file_message(
    state: &AppState,
    transfer_id: &str,
    friend_id: &str,
    path: &str,
    name: &str,
    size: u64,
    kind: &str,
    subtype: &str,
) -> MessageRecord {
    // cid = 明文 sha256：接收方据此在需要时按 cid 拉取（ADR-0019 Phase 3）。
    let cid = file::sha256_file_hex(std::path::Path::new(path)).unwrap_or_default();
    let content = serde_json::json!({
        "name": name,
        "path": path,
        "size": size,
        "sha256": cid,
        "subtype": subtype,
    })
    .to_string();
    let seq = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, friend_id).unwrap_or(1)
    };
    MessageRecord {
        id: 0,
        msg_id: format!("file-{transfer_id}"),
        conv_id: friend_id.to_string(),
        sender_id: state.device_id.clone(),
        receiver_id: friend_id.to_string(),
        kind: kind.to_string(),
        content,
        ts: db::now_ms(),
        seq,
        status: "sent".to_string(),
    }
}

/// 永久失败收尾：队列置 failed，消息气泡置 failed，并通知前端。
fn fail_file_job(state: &AppState, transfer_id: &str, reason: &str) {
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::mark_file_outbox_failed(&dbc, transfer_id).ok();
        db::set_message_status(&dbc, &format!("file-{transfer_id}"), "failed").ok();
        // 保持 file_transfers 行已有的 name/size/path，仅把状态推进到 failed。
        let _ = dbc.execute(
            "UPDATE file_transfers SET status = 'failed', progress = 0.0 WHERE id = ?1",
            rusqlite::params![transfer_id],
        );
    }
    let _ = state.app.emit(
        "file-failed",
        &crate::state::FileFailedInfo {
            transfer_id: transfer_id.to_string(),
            reason: reason.to_string(),
        },
    );
}

/// 尝试投递某 peer 的全部 pending 文件（同一 peer 串行，不同 peer 并行）。
/// 触发点与 `flush_outbox` / `flush_group_outbox` 一致：建链 / Hello / 心跳。
pub async fn flush_pending_files(state: &Arc<AppState>, peer_id: &str) {
    if !state
        .file_sending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer_id.to_string())
    {
        return;
    }
    // 没有链路时不做无谓尝试，保持 pending，等下一次连接事件再触发。
    if !state.has_link(peer_id).await {
        state
            .file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        return;
    }
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_pending_file_outbox(&dbc, peer_id).unwrap_or_default()
    };
    if pending.is_empty() {
        state
            .file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        return;
    }
    let st = state.clone();
    let peer = peer_id.to_string();
    tauri::async_runtime::spawn(async move {
        for (transfer_id, local_path) in pending {
            if !st.has_link(&peer).await {
                break;
            }
            {
                let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                db::mark_file_outbox_sending(&dbc, &transfer_id, 0).ok();
            }
            match file::send_file_from_path(
                &st,
                &peer,
                &transfer_id,
                std::path::PathBuf::from(local_path),
            )
            .await
            {
                Ok(()) => {
                    let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::delete_file_outbox(&dbc, &transfer_id).ok();
                }
                Err(e) if !e.retryable => {
                    fail_file_job(&st, &transfer_id, &e.message);
                }
                Err(_) => {
                    // 可恢复失败：保留 pending，稍后由连接/心跳再次触发。
                    let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::mark_file_outbox_pending(&dbc, &transfer_id, 5_000).ok();
                }
            }
        }
        st.file_sending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&peer);
    });
}

/// 请对端**按 cid 再发一份**内容（ADR-0019 Phase 3「点击重取」）。
///
/// 用户点一下未完成/校验失败的图片或文件时调用。对方**无需确认**：它按 cid 找到本地
/// 完整字节就直接回发一份 FileOffer（拥有即授权）。只发给 Hello 里声明了
/// CONTENT_FEATURE_PULL 的对端；旧端返回 Ok(false)（不打扰、不报错）。
#[tauri::command(async)]
pub async fn request_content(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
    msg_id: String,
) -> Result<bool, String> {
    let s = state.inner();
    let (cid, name, size) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let content = db::get_message_preview_source(&dbc, &msg_id)
            .map(|(_sender, c)| c)
            .ok_or_else(|| "消息不存在".to_string())?;
        let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        (
            v.get("sha256")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            v.get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("file")
                .to_string(),
            v.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
        )
    };
    if cid.is_empty() {
        return Err("这条内容没有内容指纹（对方版本较旧），无法重新获取".to_string());
    }
    // 能力协商：对方没声明拉取能力就不发新帧（向后兼容）。
    let supports = s
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&peer_id)
        .copied()
        .unwrap_or(0)
        & crate::protocol::CONTENT_FEATURE_PULL
        != 0;
    if !supports {
        return Ok(false);
    }
    // 手动重取也尽量续传：读该内容在统一状态里的 transfer_id / 已收字节。
    let (transfer_id, from_bytes) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::content::store::get(
            &dbc,
            &cid,
            &peer_id,
            crate::content::model::Direction::Receive,
        )
        .ok()
        .flatten()
        .map(|r| (r.transfer_id.unwrap_or_default(), r.received))
        .unwrap_or_default()
    };
    let msg = Message::ContentRequest {
        from: s.device_id.clone(),
        cid,
        transfer_id,
        from_seq: 0,
        from_bytes,
        name,
        size,
    };
    match try_send(s, &peer_id, &msg).await {
        Ok(()) => Ok(true),
        Err(e) => Err(format!("无法联系对方：{e}")),
    }
}

/// 统一的内容传输状态（ADR-0019 Phase 1）：前端据此在气泡上显示
/// 发送中 / 等待对方在线 / 网络不佳 / 未完成·点击重试 / 完成。
#[tauri::command(async)]
pub fn get_content_transfers(
    state: State<'_, Arc<AppState>>,
) -> Vec<crate::content::TransferRecord> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    crate::content::store::list(&dbc, 200).unwrap_or_default()
}

#[tauri::command(async)]
pub async fn send_file(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    let s = state.inner();
    // 「和自己聊天」暂不支持附件（用户 2026-09-16：先只支持文本）。这里给明确原因，
    // 而不是让用户看到下面那句"对方不是好友"——那与自聊场景完全对不上。
    if friend_id == s.device_id {
        return Err("和自己聊天暂不支持图片或文件".to_string());
    }
    // 好友关系检查
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("只能发送普通文件".to_string());
    }
    let size = meta.len();
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    let transfer_id = Uuid::new_v4().to_string();
    let subtype = file::classify_file_subtype(&name);
    let kind = if subtype == "image" { "image" } else { "file" };
    let rec = build_file_message(
        s,
        &transfer_id,
        &friend_id,
        &path,
        &name,
        size,
        kind,
        subtype,
    );
    // 注意：不能在持有 db 锁时调用 resolve_nickname（其内部会再次锁 db）。
    let nm = resolve_nickname(s, &friend_id);
    let preview = if kind == "image" {
        "[图片]".to_string()
    } else {
        format!("[文件] {name}")
    };
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        db::insert_message(&tx, &rec).map_err(|e| e.to_string())?;
        db::touch_conversation(&tx, &friend_id, "single", &nm, None, &preview, 0)
            .map_err(|e| e.to_string())?;
        // 先建立 file_transfers 记录，前端刷新传输列表后能立刻拿到进度条载体。
        db::upsert_transfer(
            &tx,
            &transfer_id,
            &friend_id,
            &name,
            size,
            "send",
            "pending",
            Some(path.as_str()),
            0.0,
        )
        .map_err(|e| e.to_string())?;
        db::insert_file_outbox(&tx, &transfer_id, &friend_id, None, &path, &name, size)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    let _ = s.app.emit("message-received", &rec);

    let arc = state.inner().clone();
    let fid = friend_id.clone();
    tokio::spawn(async move {
        flush_pending_files(&arc, &fid).await;
    });
    Ok(transfer_id)
}

/// 统一文件发送入口：当前稳定版统一走「直连 + 离线队列」。
/// 只要好友最终上线，文件就会在连接事件触发时自动补发，不再依赖不可达的中继路径。
#[tauri::command]
pub async fn send_file_auto(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    send_file(state, friend_id, path).await
}

/// 中继切片发送入口：保留命令名以兼容前端，当前实现回退到与直连相同的可靠队列，
/// 避免「看似已发送、实际无法投递」的假成功。
#[tauri::command]
pub async fn send_file_relay(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    path: String,
) -> Result<String, String> {
    send_file(state, friend_id, path).await
}

#[tauri::command(async)]
pub fn get_transfers(state: State<'_, Arc<AppState>>) -> Vec<TransferInfo> {
    let dbc = state.inner().db.lock().unwrap_or_else(|e| e.into_inner());
    db::list_transfers(&dbc).unwrap_or_default()
}

// ---------------- 共享目录 ----------------

#[tauri::command(async)]
pub fn set_share_dir(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    if !PathBuf::from(&path).is_dir() {
        return Err("目录不存在".to_string());
    }
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 路径 +（macOS）安全作用域书签一起落库：沙盒里书签是重启后唯一还带权限的来源。
        // 书签建不出来不能让这个动作失败（未沙盒构建会失败，而那时路径本来就能用）。
        crate::user_dirs::store(&dbc, crate::user_dirs::SHARE, &path)?;
    }
    *s.share_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
    // 目录是"解析后的路径"，不是 `Settings` 里的值 ⇒ patch 不带值，接收方定向重拉一次。
    state.notify_settings_changed(&["shareDir"], Some(window.label()), json!({}));
    Ok(())
}

#[tauri::command(async)]
pub fn get_share_dir(state: State<'_, Arc<AppState>>) -> Option<String> {
    state
        .inner()
        .share_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 文件接收目录（接收的文件/图片落盘于此，可改、可在资源管理器打开）。
#[tauri::command(async)]
pub fn get_downloads_dir(state: State<'_, Arc<AppState>>) -> String {
    state
        .inner()
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .to_string_lossy()
        .to_string()
}

/// 修改文件接收目录：校验目录存在后持久化，后续新接收的文件落到新目录。
#[tauri::command(async)]
pub fn set_downloads_dir(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("目录不存在".to_string());
    }
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 与共享目录同一套处理：接收目录也是"用户自选的目录"，沙盒里同样需要书签
        crate::user_dirs::store(&dbc, crate::user_dirs::RECEIVE, &path)?;
    }
    *s.downloads_dir.lock().unwrap_or_else(|e| e.into_inner()) = p;
    state.notify_settings_changed(&["downloadsDir"], Some(window.label()), json!({}));
    Ok(())
}

/// 在系统资源管理器中打开文件接收目录。
#[tauri::command(async)]
pub fn open_downloads_dir(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let p = state
        .inner()
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    open_in_file_manager(&p)
}

/// 跨平台在系统文件管理器里打开指定目录。
///
/// ⚠️ 移动端（Android/iOS）**没有**"文件管理器"这种东西：那里三个平台分支全被裁掉，
/// `path` 于是成了未使用变量。显式声明"移动端不使用该参数"而不是加 `_`——后者会让
/// 桌面端也丢掉名字（编译器就再也帮不上忙）。
#[cfg_attr(mobile, allow(unused_variables))]
fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn request_share_tree(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
) -> Result<Vec<ShareEntry>, String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友".to_string());
        }
    }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    s.pending_share_tree
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(request_id.clone(), tx);

    let msg = Message::ShareTreeRequest {
        request_id: request_id.clone(),
        from: s.device_id.clone(),
        to: friend_id.clone(),
    };
    // 有直连就精确发；没有直连则借**一跳中继**（邻居需与目标有直连）。
    // 这是「即使在桥接状态下，共享目录也要能用」的入口（真机 2026-09-14 全 Windows 局域网）。
    if s.has_link(&friend_id).await {
        if let Err(e) = try_send(s, &friend_id, &msg).await {
            s.pending_share_tree
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            return Err(e);
        }
    } else {
        crate::network::transport::relay_send_to_neighbors(s, &friend_id, &msg).await;
    }

    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(entries)) => Ok(entries),
        _ => {
            s.pending_share_tree
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            Err("获取共享目录超时".to_string())
        }
    }
}

#[tauri::command(async)]
pub async fn download_shared_file(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    remote_path: String,
) -> Result<String, String> {
    let s = state.inner();
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友".to_string());
        }
    }
    let transfer_id = Uuid::new_v4().to_string();
    let msg = Message::ShareFileRequest {
        transfer_id: transfer_id.clone(),
        from: s.device_id.clone(),
        path: remote_path.clone(),
        to: Some(friend_id.clone()),
    };
    if s.has_link(&friend_id).await {
        try_send(s, &friend_id, &msg).await?;
    } else {
        crate::network::transport::relay_send_to_neighbors(s, &friend_id, &msg).await;
    }
    // 本地提示：你正在下载好友的文件（聊天信息内简约系统消息）
    let file_name = std::path::Path::new(&remote_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| remote_path.clone());
    let friend_name = resolve_nickname(s, &friend_id);
    insert_system_message(
        s,
        &friend_id,
        &format!("你正在下载「{friend_name}」的文件「{file_name}」"),
    );
    Ok(transfer_id)
}

/// 插入一条本地系统消息到指定会话并推送给前端（共享下载提示、身份密钥变更告警等本地事件用）。
/// 取 `&AppState`（而非 `&Arc<AppState>`）以便网络层 `upsert_peer` 等只持有 `&AppState`
/// 的调用点复用；调用方传 `&Arc<AppState>` 时由 deref 自动转换。
pub fn insert_system_message(state: &AppState, conv_id: &str, text: &str) {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let rec = crate::state::MessageRecord {
        id: 0,
        msg_id: format!("sys-{}", Uuid::new_v4()),
        conv_id: conv_id.to_string(),
        sender_id: state.device_id.clone(),
        receiver_id: state.device_id.clone(),
        kind: "system".to_string(),
        content: text.to_string(),
        ts: db::now_ms(),
        seq: db::next_clock(&dbc, conv_id).unwrap_or(1),
        status: "sent".to_string(),
    };
    db::insert_message(&dbc, &rec).ok();
    drop(dbc);
    let _ = state.app.emit("message-received", &rec);
}

// ---------------- 辅助 ----------------

/// 将文件从 source 复制到 destination（用于"另存为"下载功能）。
#[tauri::command(async)]
pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    // Android 的「另存为」对话框返回的是 content:// URI，std::fs::copy 写不了，
    // 必须经 ContentResolver（见 android_open::save_path / OpenWith.saveWith）。
    #[cfg(target_os = "android")]
    {
        if destination.starts_with("content://") {
            return crate::android_open::save_path(&source, &destination);
        }
    }
    std::fs::copy(&source, &destination).map_err(|e| e.to_string())?;
    Ok(())
}

/// 把文件本体写入系统剪贴板（Windows CF_HDROP）。
/// 之后既可在资源管理器 / 桌面 Ctrl+V 粘贴出文件，也可粘贴回聊天框直接发送（微信式）。
#[tauri::command(async)]
pub fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::Setter;
        if !std::path::Path::new(&path).is_file() {
            return Err(format!("文件不存在或不可访问：{path}"));
        }
        let _clip = clipboard_win::Clipboard::new_attempts(10)
            .map_err(|e| format!("无法访问系统剪贴板：{e}"))?;
        clipboard_win::formats::FileList
            .write_clipboard(&[path.as_str()])
            .map_err(|e| format!("复制文件到剪贴板失败：{e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台暂不支持复制文件到剪贴板".into())
    }
}

/// 读取剪贴板里的文件路径列表（CF_HDROP）。空列表表示剪贴板里没有真实文件
/// （截图 / 网页图片是位图数据，不是文件）。供输入框粘贴时区分「粘贴文件」与「粘贴图片」。
#[tauri::command(async)]
pub fn read_clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        // 读不到（格式不符 / 被占用）一律按"无文件"处理，前端回退到图片粘贴分支。
        let paths: Vec<String> =
            clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
        paths
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// 将 base64 数据写入目标路径（用于图片消息"另存为"：前端把 dataURL 解出 base64 传回）。
#[tauri::command(async)]
pub fn save_data_file(base64_data: String, destination: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| e.to_string())?;
    // Android：目标可能是 content:// URI，std::fs::write 写不了，走 ContentResolver。
    #[cfg(target_os = "android")]
    {
        if destination.starts_with("content://") {
            return crate::android_open::save_bytes(&bytes, &destination);
        }
    }
    std::fs::write(&destination, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 解析 `msg_id` 指向的本地媒体文件的结果。
///
/// 由 `read_file_preview` 与 `media_present` 共用，避免出现第二份路径解析实现
/// （安全边界必须只有一处）。
enum MediaPath {
    /// 文件存在且通过安全校验。
    Present(Box<PathBuf>),
    /// 查不到这条消息 / 元数据缺路径 / 路径未通过安全校验 —— **无法判断**媒体是否还在。
    /// 尚未落库的乐观消息会落到这里，因此调用方不能据此断言"已被清理"。
    /// 附带面向用户的错误文案。
    Unknown(String),
    /// 消息记录里的路径已解析不到文件 —— 已被「存储清理」删除。
    Gone,
}

/// 校验并解析 `msg_id` 的媒体路径。
///
/// 安全边界：路径必须落在 downloads 目录内（接收方文件），或该消息由本机发出
/// （发送方自选的文件）——两者都不允许对端通过消息内容诱导读取本机任意路径。
fn resolve_media_path(s: &AppState, msg_id: &str) -> MediaPath {
    let Some((sender_id, content)) =
        db::get_message_preview_source(&s.db.lock().unwrap_or_else(|e| e.into_inner()), msg_id)
    else {
        return MediaPath::Unknown("消息不存在".to_string());
    };
    let Some(path) = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| {
            v.get("path")
                .and_then(|p| p.as_str())
                .map(|p| p.to_string())
        })
    else {
        return MediaPath::Unknown("元数据缺少路径".to_string());
    };

    // msg_id → transfer_id：接收侧单聊是 file-{id}，群文件是 gfile-{id}。
    let transfer_id = msg_id
        .strip_prefix("file-")
        .or_else(|| msg_id.strip_prefix("gfile-"));
    let in_flight = transfer_id
        .map(|tid| {
            s.file_receivers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(tid)
                || s.group_file_receivers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains_key(tid)
        })
        .unwrap_or(false);
    let Ok(file) = std::fs::canonicalize(&path) else {
        // **文件还没落盘 ≠ 已被清理**：接收方在 FileDone 之前写的是 <transfer_id>.part，
        // final 路径尚不存在。若这里报 Gone，前端会把"正在接收的图片"标成「已被清理」并
        // 缓存下来，从此再也不会重读（真机：图片时好时坏、要重发才出来）。
        // 在途 ⇒ 报 Unknown，让前端保持"加载中"，等 FileDone 落盘后再读。
        return if in_flight {
            MediaPath::Unknown("仍在接收".to_string())
        } else {
            MediaPath::Gone
        };
    };
    let under_downloads = std::fs::canonicalize(
        s.downloads_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_path(),
    )
    .map(|dir| file.starts_with(dir))
    .unwrap_or(false);
    if !under_downloads && sender_id != s.device_id {
        return MediaPath::Unknown("路径越权".to_string());
    }
    match std::fs::metadata(&file) {
        Ok(meta) if meta.is_file() => MediaPath::Present(Box::new(file)),
        Ok(_) => MediaPath::Unknown("非普通文件".to_string()),
        Err(_) => MediaPath::Gone,
    }
}

/// 媒体是否**仍在本机**（未被存储清理删除）。
///
/// 前端据此把"已被清理"的消息渲染成明确提示，而不是一个空白/裂开的图片框——后者
/// 会让人误以为是对端发来的文件本身有问题。只有能确定「文件已被删除」时才返回 `false`；
/// 查不到消息（例如尚未落库的乐观消息）一律按"存在"处理，绝不能把在途消息误标成已清理。
#[tauri::command(async)]
pub fn media_present(state: State<'_, Arc<AppState>>, msg_id: String) -> Result<bool, String> {
    let s = state.inner();
    Ok(!matches!(resolve_media_path(s, &msg_id), MediaPath::Gone))
}

/// 读取附件预览内容（原始字节，不走 base64 IPC）。
///
/// 按 `msg_id` 反查记录里的本地 `path` 再读，前端据此渲染图片（→Blob/objectURL）
/// 或代码（→TextDecoder）。安全边界见 [`resolve_media_path`]。
/// 超过 `max_bytes` 返回 "TOO_LARGE"，由前端回退文件卡片；文件已被清理返回
/// "文件不存在"，由前端渲染成「已清理」占位。
#[tauri::command(async)]
pub fn read_file_preview(
    state: State<'_, Arc<AppState>>,
    msg_id: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    let s = state.inner();
    let max_bytes = max_bytes.min(15 * 1024 * 1024);
    let file = match resolve_media_path(s, &msg_id) {
        MediaPath::Present(p) => *p,
        MediaPath::Unknown(e) => return Err(e),
        MediaPath::Gone => return Err("文件不存在".to_string()),
    };
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > max_bytes {
        return Err("TOO_LARGE".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 导出全部聊天文字到用户指定文件（Markdown 单文件）。
///
/// 定位：磁盘满 / 换机时的**自救手段**——存储清理只删媒体、不动文字，但一旦库损坏
/// 或要迁机，没有导出入口就只能看着数据丢。只导出文字，媒体仅保留文件名
/// （见 `export` 模块说明：刻意不产出 HTML，避免对端消息在本机浏览器里执行）。
///
/// `utc_offset_minutes` 由前端给出（`-new Date().getTimezoneOffset()`）：Rust 侧不引入
/// 时区库（`AI_RULES §25`），跨夏令时切换的历史消息可能有 1 小时偏差，已在模块注释说明。
#[tauri::command(async)]
pub fn export_chat_text(
    state: State<'_, Arc<AppState>>,
    destination: String,
    utc_offset_minutes: i64,
) -> Result<export::ExportSummary, String> {
    let s = state.inner();
    if destination.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    let device_name = s.nickname.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let my_id = s.device_id.clone();

    // 只把「读库」放进锁里：渲染几十万条消息 + 写盘可能耗时较长，
    // 不能让一次导出把消息落库卡住。
    let sections = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        export::collect_sections(&dbc, &my_id)?
    };

    let messages: usize = sections.iter().map(|(_, m)| m.len()).sum();
    let conversations = sections.len();
    let generated_at = export::format_local_time(db::now_ms(), utc_offset_minutes);
    let text = export::render_markdown(&device_name, &generated_at, &sections, utc_offset_minutes);

    std::fs::write(&destination, text.as_bytes()).map_err(|e| format!("写入导出文件失败：{e}"))?;
    Ok(export::ExportSummary {
        conversations,
        messages,
        path: destination,
    })
}

/// 清除所有聊天数据（保留好友、身份、设置）。
/// SQLite 删除使用 transaction，任一失败则 rollback。
/// 文件系统清理在 DB commit 成功后执行；文件删除失败不影响 DB 结果。
/// 每批删除的行数。
///
/// 为什么是 2000：要把 `db` 互斥锁的**单次持有时长**压到毫秒级。用户实测的
/// "点「清除数据」设置窗口卡死"就是长事务握锁数秒导致的 —— 期间每个读命令都要等锁，
/// 等锁的 async 任务会占住工作线程，新的 IPC 排不上队，界面看起来就是死的。
const CLEAR_BATCH_ROWS: usize = 2000;

/// 删**一批**（同步核心，便于单测）：一批一个短事务，返回删除行数。
///
/// 表名只来自本文件里的字面量列表，不存在注入面。
fn clear_one_batch(
    db: &std::sync::Mutex<rusqlite::Connection>,
    table: &str,
) -> Result<u64, String> {
    let dbc = db.lock().unwrap_or_else(|e| e.into_inner());
    let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
    let n = tx
        .execute(
            &format!(
                "DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} LIMIT {CLEAR_BATCH_ROWS})"
            ),
            [],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// 分批清空一张表：**每批一个短事务**，批与批之间释放 `db` 锁并让出调度，
/// 让同一进程里的读命令（会话列表、设置回读…）能插进来。
///
/// ⚠️ 「批间放锁」这件事有单测盯着（`clear_is_batched_so_the_db_lock_is_held_only_briefly`）：
/// 它是"点清除数据不再卡死"的**唯一**机制，改回一个大事务会静默退化。
async fn clear_table_batched(s: &Arc<AppState>, table: &str) -> Result<u64, String> {
    let mut total: u64 = 0;
    loop {
        let deleted = clear_one_batch(&s.db, table)?; // 锁在函数返回时释放
        total += deleted;
        if deleted == 0 {
            return Ok(total);
        }
        // 让出调度：给等锁的命令一个真正拿到锁的机会
        tokio::task::yield_now().await;
    }
}

#[tauri::command]
pub async fn clear_all_data(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let s = state.inner();

    // 1. SQLite 删除（**分批**，见 `clear_table_batched`）。
    //    ⚠️ 这里不再用一个横跨所有表的大事务：那会把 `db` 互斥锁握住数秒，
    //    期间所有读命令都在等锁 —— 用户实测"点「清除数据」→ 设置窗口卡死、点不动"。
    //    代价：中途失败会留下**部分删除**（"清除数据"本身是破坏性操作，可接受），
    //    换来的是界面全程可用。
    let mut cleared: u64 = 0;
    for table in [
        "messages",
        "conversations",
        "outbox",
        "group_outbox",
        "file_outbox",
        "file_transfers",
        "pending_reads",
        "pending_group_reads",
        "group_reads",
        "group_files",
        "group_file_recipients",
        "group_members",
        "groups",
    ] {
        cleared += clear_table_batched(s, table).await?;
    }
    {
        // 这两条量级很小（键值 + 群时钟），一次删完即可
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        dbc.execute("DELETE FROM settings WHERE key LIKE 'gk:%'", [])
            .map_err(|e| e.to_string())?;
        dbc.execute(
            "DELETE FROM conversation_clocks WHERE conv_id LIKE 'group:%'",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    s.logger.info(
        "db",
        format!("清除聊天数据：共删除 {cleared} 行（分批执行，界面全程可响应）"),
    );

    // 2. Runtime state 清理：群密钥内存缓存一并清空（彻底退出群聊）。
    s.pending_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.pending_reads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.pending_file_accept
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.pending_file_complete
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.pending_share_tree
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    // 群文件/文件投递运行态与待发群密钥同属聊天数据运行态（不清会残留
    // 已删群的 file_key，且 pending 群密钥可能在重连时复活已删群记录）
    s.group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.group_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.pending_group_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.group_file_sending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    s.file_sending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    *s.relay.lock().unwrap_or_else(|e| e.into_inner()) = crate::file_relay::RelayManager::new();
    // 先关闭未完成接收的文件句柄，再清理 downloads 目录中的 .part 临时文件。
    s.file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();

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
    let dl = s
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if dl.exists() {
        for entry in std::fs::read_dir(&dl)
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

    // 破坏性操作必须**广播**：用户实测（Mac 4.1.10）"在设置里清了缓存、目录和聊天记录，
    // 但主界面没反应" —— 因为清除只发生在设置窗口自己的 store 里，主窗口是另一个 WebView，
    // 它手里的会话列表/消息一条都没变（看起来像"没清掉"）。
    // 注意：即使有文件没删掉，**数据库记录已经清了** ⇒ 也要广播（否则界面同样显示旧数据）。
    s.notify_data_cleared(Some(window.label()));

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
#[tauri::command(async)]
pub fn search_messages(
    state: State<'_, Arc<AppState>>,
    keyword: String,
) -> Result<Vec<SearchResult>, String> {
    let s = state.inner();
    // 搜索关键词长度保护：按字符截断（UTF-8 安全）
    let keyword: String = keyword.chars().take(MAX_SEARCH_LEN).collect();
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
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
                match_msg_id: m.msg_id,
            });
        }
    }
    Ok(results)
}

/// 「搜索聊天记录」结果页的一条命中。
#[derive(Serialize)]
pub struct ChatSearchMessage {
    pub msg_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub kind: String,
    pub content: String,
    pub ts: i64,
}

/// 按会话分组的命中（结果页左栏一个会话一行，右栏是它的命中消息）。
#[derive(Serialize)]
pub struct ChatSearchGroup {
    pub conv_id: String,
    pub name: String,
    /// single | group（前端据此决定是否显示发送者昵称）
    pub kind: String,
    pub avatar: Option<String>,
    /// 该会话在**当前筛选条件**下的命中总数（微信式「共 N 条相关聊天记录」）。
    pub total: i64,
    pub latest_ts: i64,
    /// 命中消息（时间倒序；受 `SEARCH_HISTORY_PER_CONV` 限制）。
    pub messages: Vec<ChatSearchMessage>,
}

/// 每个会话在结果页里最多展开多少条命中。用户真正要的是"扫一眼找到那条"，
/// 单个会话几百条既没人看也吃内存；点「进入聊天」才是继续翻的地方。
const SEARCH_HISTORY_PER_CONV: usize = 60;
/// 结果页最多返回多少个会话（左栏列表长度）。
const SEARCH_HISTORY_MAX_CONVS: i64 = 50;
/// 一次检索从库里取回的最大命中数（分组前的硬上限，防全表大结果）。
const SEARCH_HISTORY_MAX_HITS: i64 = 2000;

/// 搜索聊天记录（跨会话，按会话分组）。
///
/// 与 `search_messages`（会话列表里"内容命中的会话"摘要，只取每会话最新一条）的区别：
/// 这里要的是**结果页**的数据形态 —— 每个会话的命中总数 + 命中消息列表（含发送者），
/// 并支持微信搜索页那两个筛选：发送人、日期区间。
///
/// 为什么标 `(async)`：这是一次带 LIKE 的全表扫描（可能几千行），
/// 同步命令会在 macOS 主线程上跑（见 `heavy_commands_run_off_the_main_thread` 守卫）。
#[tauri::command(async)]
pub fn search_chat_history(
    state: State<'_, Arc<AppState>>,
    keyword: String,
    sender_id: Option<String>,
    since_ms: Option<i64>,
    until_ms: Option<i64>,
) -> Result<Vec<ChatSearchGroup>, String> {
    let s = state.inner();
    // 关键词长度保护（UTF-8 安全截断）
    let keyword: String = keyword.chars().take(MAX_SEARCH_LEN).collect();
    if keyword.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sender = sender_id.filter(|v| !v.is_empty());

    let hits = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::search_history(
            &dbc,
            &keyword,
            sender.as_deref(),
            since_ms,
            until_ms,
            SEARCH_HISTORY_MAX_HITS,
        )
        .map_err(|e| e.to_string())?
    };

    // 分组（保持查询的 ts DESC 顺序 ⇒ 组内消息与左栏顺序都是"最新在前"）
    let mut order: Vec<String> = Vec::new();
    let mut grouped: std::collections::HashMap<String, Vec<db::ChatSearchHit>> =
        std::collections::HashMap::new();
    for h in hits {
        if !grouped.contains_key(&h.conv_id) {
            order.push(h.conv_id.clone());
        }
        grouped.entry(h.conv_id.clone()).or_default().push(h);
    }

    let mut out = Vec::new();
    for conv_id in order.into_iter().take(SEARCH_HISTORY_MAX_CONVS as usize) {
        let Some(list) = grouped.remove(&conv_id) else {
            continue;
        };
        let total = list.first().map(|h| h.total).unwrap_or(0);
        let latest_ts = list.first().map(|h| h.ts).unwrap_or(0);
        // 会话名/头像/类型：群聊读 groups，单聊读好友（与其它列表同源）
        let (name, kind, avatar) = conversation_meta(s, &conv_id);
        let messages = list
            .into_iter()
            .take(SEARCH_HISTORY_PER_CONV)
            .map(|h| ChatSearchMessage {
                sender_name: sender_display_name(s, &h.sender_id),
                msg_id: h.msg_id,
                sender_id: h.sender_id,
                kind: h.kind,
                content: h.content,
                ts: h.ts,
            })
            .collect();
        out.push(ChatSearchGroup {
            conv_id,
            name,
            kind,
            avatar,
            total,
            latest_ts,
            messages,
        });
    }
    Ok(out)
}

/// 会话的显示名 / 类型 / 头像（群聊与单聊各取一处，与其它列表口径一致）。
fn conversation_meta(s: &AppState, conv_id: &str) -> (String, String, Option<String>) {
    // 「和自己聊天」的会话 id 就是本机 device_id（见 `insert_self_message`）
    if conv_id == s.device_id {
        return (s.self_display_name(), "single".to_string(), s.self_avatar());
    }
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(group_id) = conv_id.strip_prefix("group:") {
        if let Some(g) = db::get_group(&dbc, group_id) {
            return (g.name, "group".to_string(), None);
        }
        return (conv_id.to_string(), "group".to_string(), None);
    }
    match db::get_friend(&dbc, conv_id) {
        Some((name, avatar)) => (name, "single".to_string(), avatar),
        None => (conv_id.to_string(), "single".to_string(), None),
    }
}

/// 发送者的显示名：自己 → 昵称；好友 → 好友昵称；其它（群里的非好友、已删好友）→ 未知设备。
///
/// 说明：群聊里没加好友的成员没有昵称落库，只能退化显示设备 id 前几位，
/// **不能瞎猜**（昵称是身份的一部分）。真正的昵称会在收到对方资料/消息时补进 peers。
fn sender_display_name(s: &AppState, sender_id: &str) -> String {
    if sender_id == s.device_id {
        return s.nickname.lock().unwrap_or_else(|e| e.into_inner()).clone();
    }
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((name, _)) = db::get_friend(&dbc, sender_id) {
        return name;
    }
    drop(dbc);
    let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = peers.get(sender_id) {
        if !p.nickname.is_empty() {
            return p.nickname.clone();
        }
    }
    sender_id.chars().take(8).collect()
}

#[derive(Serialize)]
pub struct SearchResult {
    conv_id: String,
    name: String,
    match_content: String,
    match_ts: i64,
    /// 命中消息的 msg_id：前端据此"跳到那一条"（只给 conv_id 的话，
    /// 用户点进去还要自己在会话里翻，搜索就只完成了一半）。
    match_msg_id: String,
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

// ---------------- 跨子网（Routed）端点配置 ----------------

/// 校验并**规范化**手动配置的 Routed 端点地址，返回 `ip:port`。
///
/// 两种输入都接受：
/// - `100.64.0.1:60002`（显式端口，对端用了 `--instance` 时需要）
/// - `100.64.0.1`（省略端口 → 用标准 [`TCP_PORT`]）
///
/// 允许省略端口是「少配置」的一部分：端口是内部实现细节，默认单实例场景下用户
/// 没有理由需要知道它，更不该因为漏写端口而被拒绝。
///
/// 只接受 **IPv4**：TCP 监听侧绑的是 `Ipv4Addr`（`network::transport::spawn`），
/// IPv6 端点即使拨出去也连不上。在这里当场拒绝，好过「存下来了但永远连不上」
/// —— 后者对用户完全不可见（配置成功、日志无错、就是没反应）。
fn normalize_routed_address(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    // 解析（含「裸 IP 补标准端口」）由 `parse_endpoint_addr` 单点负责 ——
    // 拨号侧走的是同一个实现，避免两条路径行为不一致。
    let Some(addr) = parse_endpoint_addr(trimmed) else {
        return Err(format!("地址格式应为 ip 或 ip:port，收到：{trimmed}"));
    };
    if addr.is_ipv6() {
        return Err(
            "暂不支持 IPv6 地址（当前 TCP 监听仅 IPv4）。请填写 IPv4，例如 100.64.0.1".to_string(),
        );
    }
    // 规范化后再存储：add / remove 比较的是同一个字符串，避免「加进去了却删不掉」
    Ok(addr.to_string())
}

/// 列出手动配置的跨子网端点（Tailscale / VPN / 跨网段）。
#[tauri::command(async)]
pub fn list_routed_endpoints(state: tauri::State<'_, Arc<AppState>>) -> Vec<RoutedEndpoint> {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    parse_endpoints(&db::get_setting(&dbc, ROUTED_ENDPOINTS_KEY).unwrap_or_default())
}

/// 添加一个跨子网端点。
///
/// `device_id` **可省略**（传 `null` 或空串都当作未指定）：
/// - 提供时：语义是「连接这个**已知**节点」，链路 key 直接用它，行为与历史一致；
/// - 省略时：身份由 TCP 握手学来（§8：`IP:PORT → TCP → Hello → Node ID → Identity`），
///   用户只需要知道对方地址 —— 这才是「少配置」。
///
/// 地址接受 `ip` 或 `ip:port`（省略端口按标准 [`TCP_PORT`] 补全），目前仅 IPv4：
/// TCP 监听侧绑的是 `Ipv4Addr`，IPv6 端点拨出去也连不上。
#[tauri::command(async)]
pub fn add_routed_endpoint(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: Option<String>,
    address: String,
) -> Result<Vec<RoutedEndpoint>, String> {
    // 空串等同「未指定」：UI 上的输入框没填时通常会传空串，不该存下一个没意义的值。
    let device_id = device_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let address = normalize_routed_address(&address)?;
    let candidate = RoutedEndpoint::new(device_id, address);

    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut list =
        parse_endpoints(&db::get_setting(&dbc, ROUTED_ENDPOINTS_KEY).unwrap_or_default());
    // 同一个**地址**不重复添加，无论是否带 device_id —— 一个地址只对应一个端点。
    if !list.iter().any(|e| e.address == candidate.address) {
        list.push(candidate);
    }
    db::set_setting(&dbc, ROUTED_ENDPOINTS_KEY, &encode_endpoints(&list))
        .map_err(|e| format!("保存失败: {e}"))?;
    Ok(list)
}

/// 移除一个跨子网端点（只按**地址**匹配）。
///
/// 地址是端点的唯一标识：`device_id` 可以省略，用它当判据会让「只填地址添加、
/// 带指纹删除」匹配不上。地址先规范化（与 `add` 存进去的形式一致）。
///
/// **比对时也把库里已存的那条再规范化一次**，兜住「历史脏数据」（比如老版本直接
/// 写 SQLite 没经过 `add` 的裸 IP 无端口），否则会出现「列表里看得见但删不掉」——
/// 用户的真实反馈：UI 看着有 `100.101.221.60`，删的时候 normalize 成
/// `100.101.221.60:59992`，而库里存的就是裸 `100.101.221.60`，字符串不相等。
#[tauri::command(async)]
pub fn remove_routed_endpoint(
    state: tauri::State<'_, Arc<AppState>>,
    address: String,
) -> Result<Vec<RoutedEndpoint>, String> {
    let address = normalize_routed_address(&address)?;
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut list =
        parse_endpoints(&db::get_setting(&dbc, ROUTED_ENDPOINTS_KEY).unwrap_or_default());
    let before = list.len();
    list.retain(|e| {
        // 库里的历史脏数据可能未归一化（裸 IP / 裸 IP 带非标准端口），按当前规则再过一遍
        // 归一化后比较。归一化失败的条目（语法错乱）保守地按字符串相等判，免得误删。
        let stored_norm =
            normalize_routed_address(&e.address).unwrap_or_else(|_| e.address.clone());
        stored_norm != address
    });
    if list.len() != before {
        db::set_setting(&dbc, ROUTED_ENDPOINTS_KEY, &encode_endpoints(&list))
            .map_err(|e| format!("保存失败: {e}"))?;
    }
    Ok(list)
}

// ---------------- 运行日志 ----------------

/// 读取内存中的全部运行日志（时间正序：旧 → 新）。
#[tauri::command(async)]
pub fn get_logs(state: tauri::State<'_, Arc<AppState>>) -> Vec<LogEntry> {
    state.logger.snapshot()
}

/// 清空运行日志（内存 + 落盘文件）。
#[tauri::command(async)]
pub fn clear_logs(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.logger.clear();
    Ok(())
}

/// 独立窗口（设置 / 日志）关闭时**隐藏而不是销毁**。
///
/// 为什么：`WebviewWindow` 的创建 + 前端加载 + `app.init()` 是"点一下要等很久"的全部成本；
/// 销毁后每次打开都要重付一遍。改成常驻之后，第二次起是 `show()` —— 用户要的"点一下立马就开"。
/// 代价是两个窗口的后台内存常驻。要换回"关闭即销毁"，把这里改成 `false` 即可
/// （`install_hide_on_close` 会跳过 prevent_close，关闭仍走系统默认销毁）。
#[cfg(desktop)]
const AUX_WINDOWS_RESIDENT: bool = true;

/// 串行化"创建独立窗口"这一步 —— 并发打开同一个窗口是有真实竞态的。
///
/// `WebviewWindowBuilder::build()` 的重复 label 检查在 `prepare_window` 里做
/// （`tauri/src/manager/window.rs`），而窗口被真正登记进 manager 是在主线程创建**完成之后**；
/// 两个并发调用会**双双通过检查**，后者还会覆盖 manager 里的记录（留下一个前台看不见、
/// 也没人管得住的窗口）。用户"连点两下设置"正好会撞上：表现为第二个设置窗口闪一下、
/// 甚至先显示成主聊天界面（前端还没切到设置页的窗口期）。
#[cfg(desktop)]
static AUX_WINDOW_CREATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 已存在就显示并聚焦（`true` = 处理完了，不需要新建）。
///
/// 这就是"它已经打开了，我再点一下，还是它，不会开出第二个"：
/// 命令层与按钮层都不再需要自己去记"开没开过"。
///
/// `geo` 非空时会**重新把它摆到主窗口正中**（只动位置，不动尺寸）：窗口是常驻的，而主窗口
/// 可以被拖到另一块屏幕上 —— 摆着不动的话，第二次打开它就留在**上一块屏**上
/// （用户 2026-09-16 多屏反馈的"弹到另一个屏幕上"有一半来自这里）。尺寸不重设，
/// 是为了留住用户自己拉过的大小。
#[cfg(desktop)]
fn show_existing_aux_window(
    app: &tauri::AppHandle,
    label: &str,
    geo: Option<AuxWindowGeometry>,
) -> bool {
    if let Some(win) = app.get_webview_window(label) {
        if let Some(g) = geo {
            recenter_aux_window(&win, &g);
        }
        // `unminimize`：窗口被最小化过的话，只 show 不会把它拉回前台。
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return true;
    }
    false
}

/// 关闭 → 隐藏（配合 [`AUX_WINDOWS_RESIDENT`]），让下一次打开是瞬时的。
#[cfg(desktop)]
fn install_hide_on_close(win: &tauri::WebviewWindow) {
    let w = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
        }
    });
}

/// 打开（或聚焦）一个独立窗口：**单例 + 串行创建**。
///
/// 所有独立窗口都走这里，别在各自的命令里各写一遍 —— 单例与并发安全是"每个窗口都要有"的
/// 性质，散着写就一定会漏（这正是用户 2026-09-12 报的"连点会出怪事"的来源）。
///
/// `geo` 是**按主窗口**算好的几何（见 [`aux_window_geometry`]）：创建时用它摆尺寸与位置，
/// 已存在时用它把窗口重新摆回主窗口那块屏（见 [`show_existing_aux_window`]）。
#[cfg(desktop)]
fn ensure_aux_window<F>(
    app: &tauri::AppHandle,
    label: &str,
    geo: Option<AuxWindowGeometry>,
    build: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<tauri::WebviewWindow, tauri::Error>,
{
    // 快路径：已经建过（包括"上次关掉只是隐藏了"）⇒ 显示 + 聚焦。
    if show_existing_aux_window(app, label, geo) {
        return Ok(());
    }
    // 慢路径：同一时刻只允许一个创建者。等锁期间别人可能已经建好了 ⇒ 拿到锁后**再查一次**。
    let _guard = AUX_WINDOW_CREATE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if show_existing_aux_window(app, label, geo) {
        return Ok(());
    }
    let win = build().map_err(|e| format!("创建 {label} 窗口失败: {e}"))?;
    if AUX_WINDOWS_RESIDENT {
        install_hide_on_close(&win);
    }
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 独立窗口衬在主窗口里的留边（**逻辑**像素）：子窗口与主窗口边缘至少隔开这么多。
#[cfg(desktop)]
const AUX_WINDOW_MARGIN: f64 = 24.0;

/// 独立窗口的几何 —— **全部是物理像素**（理由见 [`fit_aux_window`]）。
#[cfg(desktop)]
#[derive(Clone, Copy)]
struct AuxWindowGeometry {
    /// 主窗口外框尺寸 / 左上角（物理像素，虚拟桌面坐标）：子窗口要在它里面居中。
    main_size: (u32, u32),
    main_pos: (i32, i32),
    /// 子窗口内尺寸（物理像素）。
    size: (u32, u32),
    /// 子窗口最小内尺寸（物理像素）。必须 ≤ `size`，否则系统会把窗口顶回最小值。
    min: (u32, u32),
}

#[cfg(desktop)]
impl AuxWindowGeometry {
    /// 居中位置：子窗口**外框**在主窗口外框内居中（物理像素）。
    ///
    /// 用外框而不是内尺寸：子窗口带系统标题栏（`tao` 的 WM_DPICHANGED 与创建路径都会按
    /// 缩放重新算边框厚度），按内尺寸居中会带上半个标题栏的偏差 —— 换到不同缩放的屏上更明显。
    fn centered_pos(&self, aux_outer: (u32, u32)) -> (i32, i32) {
        (
            self.main_pos.0 + ((self.main_size.0 as i64 - aux_outer.0 as i64) / 2) as i32,
            self.main_pos.1 + ((self.main_size.1 as i64 - aux_outer.1 as i64) / 2) as i32,
        )
    }
}

/// 按**主窗口**算独立窗口的尺寸：装得下就用设计尺寸，装不下按主窗口缩到装得下；
/// 位置在主窗口内居中（见 [`AuxWindowGeometry::centered_pos`]）。
///
/// ## 为什么参照物是主窗口
///
/// 用户 2026-09-16 反馈「新窗口打开时没有居中，而且比主窗口还大很多」：主窗口是**可缩放**的，
/// 用户把它拉小之后，一块按屏幕算出来的子窗口就会比它大、而且落在屏幕正中 —— 离它该贴着的
/// 那个窗口很远。子窗口的参照物只能是它**从哪来**。
///
/// ## 为什么全程物理像素
///
/// 用户 2026-09-16 多屏反馈「子窗口弹到另一个屏幕上、位置也没居中」：
/// `WebviewWindowBuilder::position/inner_size` 只收**逻辑**坐标，而 `tao` 在创建窗口时会把
/// 逻辑坐标**逐个显示器**地按该显示器的缩放换回物理，取第一个"换算结果落在自己范围内"的显示器
/// （`tao/src/platform_impl/windows/window.rs` 的 `available_monitors().find_map(..)`）；
/// 一个都没命中就退回 `CW_USEDEFAULT`（主屏层叠位置）：
///
/// - 主窗口在 150% 的副屏、另一块屏 100% 时：按副屏缩放算出的逻辑坐标，再按 100% 换算回来，
///   正好落进那块屏 ⇒ **子窗口跑到另一块屏幕上**；
/// - 尺寸也走同一条换算（按"选中显示器"的缩放）⇒ 大小同样不对。
///
/// 物理坐标没有这一步换算。所以尺寸/位置都不走 builder，而是 `build()` **之后**用物理值落地
/// （`apply_aux_geometry`）—— 窗口以 `visible(false)` 创建，摆好再 `show()`，用户看不到跳变。
///
/// `None` = 拿不到主窗口（还没建出来 / 平台查询失败），此时保持 builder 的设计尺寸 + 系统默认摆位。
#[cfg(desktop)]
fn aux_window_geometry(
    app: &tauri::AppHandle,
    ideal: (f64, f64),
    min: (f64, f64),
) -> Option<AuxWindowGeometry> {
    let main = app.get_webview_window(crate::WINDOW_MAIN)?;
    // 主窗口所在显示器的缩放：子窗口要跟主窗口"看起来"一样大，就用它的缩放把设计尺寸换成物理。
    let scale = main.scale_factor().ok()?;
    let outer = main.outer_size().ok()?; // 物理像素：外框（主窗口无边框，外框≈内尺寸）
    let origin = main.outer_position().ok()?; // 物理像素：虚拟桌面坐标（副屏可能是负的/上千）
    if outer.width == 0 || outer.height == 0 {
        return None;
    }
    Some(fit_aux_window(
        (outer.width, outer.height),
        (origin.x, origin.y),
        scale,
        ideal,
        min,
    ))
}

/// [`aux_window_geometry`] 的**纯计算**部分（拿不到主窗口尺寸的那些查询不在里面）。
///
/// 抽出来的理由只有一个：能在 `cargo test` 里直接验"永远不比主窗口大 + 居中"这两条 ——
/// 它们都是**几何不变式**，靠真机肉眼是量不准的（用户报的就是"没居中、还比主窗口大"）。
#[cfg(desktop)]
fn fit_aux_window(
    main_size: (u32, u32),
    main_pos: (i32, i32),
    scale: f64,
    ideal: (f64, f64),
    min: (f64, f64),
) -> AuxWindowGeometry {
    // 逻辑 → 物理（用主窗口所在显示器的缩放）
    let px = |v: f64| (v * scale).round().max(1.0) as u32;
    let margin = px(AUX_WINDOW_MARGIN);
    // 目标是主窗口内"两侧各留 margin"的那块区域；设计尺寸装不下就缩到刚好装下。
    let fit = |want: u32, avail: u32| want.min(avail.saturating_sub(2 * margin).max(1));
    let (w, h) = (fit(px(ideal.0), main_size.0), fit(px(ideal.1), main_size.1));
    AuxWindowGeometry {
        main_size,
        main_pos,
        size: (w, h),
        // 最小尺寸不能大于实际尺寸：否则系统会把窗口顶回最小值，"缩小"等于白做。
        // 顺带一提，这里的最小尺寸也必须用**物理**值下发：builder 上的 `min_inner_size`
        // 是逻辑值，会在另一块缩放的屏上被换算成别的物理下限。
        min: (px(min.0).min(w), px(min.1).min(h)),
    }
}

/// 把几何**落地到新窗口**上（物理像素）。必须在 `show()` 之前调用，且窗口要隐藏着建。
#[cfg(desktop)]
fn apply_aux_geometry(win: &tauri::WebviewWindow, geo: AuxWindowGeometry) {
    use tauri::{PhysicalSize, Size};
    let _ = win.set_min_size(Some(Size::Physical(PhysicalSize::new(
        geo.min.0, geo.min.1,
    ))));
    let _ = win.set_size(Size::Physical(PhysicalSize::new(geo.size.0, geo.size.1)));
    recenter_aux_window(win, &geo);
}

/// 把窗口摆到主窗口正中（**只动位置，不动尺寸**）。
///
/// 位置按**真实外框**算：外框含标题栏与边框，而这两样在不同缩放的屏上厚度不同，
/// 事先估算不出来（所以要在尺寸确定之后再问窗口自己）。尺寸不动，是为了留住用户自己拉过的大小。
#[cfg(desktop)]
fn recenter_aux_window(win: &tauri::WebviewWindow, geo: &AuxWindowGeometry) {
    use tauri::{PhysicalPosition, Position};
    let outer = match win.outer_size() {
        Ok(s) => (s.width, s.height),
        Err(_) => geo.size, // 拿不到就按内尺寸居中（差半个标题栏，无伤）
    };
    let (x, y) = geo.centered_pos(outer);
    let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

/// 桌面端：打开独立的「运行日志」窗口（已存在则聚焦）。
///
/// 窗口加载 `logs.html`（它自己的文档与入口，见 `src/entries/logs.ts`）—— 只加载日志页
/// 需要的代码，不会把聊天界面挂起来再换掉。窗口用系统标题栏（含关闭按钮）；关闭默认
/// **隐藏**而非销毁（见 [`AUX_WINDOWS_RESIDENT`]），所以再次打开是瞬时的。
/// 窗口标题由 `logs.html` 的 `data-title-*` + 前端按语言设置 `document.title`
/// （Tauri 会把 document title 同步到窗口标题），Rust 侧不再维护第二份标题文案。
#[cfg(desktop)]
#[tauri::command(async)]
pub fn open_log_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let bg = aux_window_background(&state);
    // 初始标题：文档标题（`logs.html` 的 data-title-* + 前端按语言）加载完成后会被 Tauri
    // 自动同步过去，所以这里只需要一个"还没加载完时不至于空着"的占位。
    let title = state.display_name();
    // 克隆一份给闭包：`ensure_aux_window` 同时借用 `app` 做存在性检查，
    // 闭包再 move 走同一个 handle 会借不过（且闭包必须 `'static` 才能交给 Tauri 创建）。
    let build_app = app.clone();
    // 尺寸与位置按主窗口算（见 aux_window_geometry 的说明）；只在**创建**时算一次 ——
    // 常驻窗口之后都是 show/focus，反复挪动用户已经摆好的窗口反而更烦。
    let geo = aux_window_geometry(&app, (760.0, 560.0), (420.0, 320.0));
    ensure_aux_window(&app, crate::WINDOW_LOGS, geo, move || {
        let win = WebviewWindowBuilder::new(
            &build_app,
            crate::WINDOW_LOGS,
            WebviewUrl::App("logs.html".into()),
        )
        .title(title)
        // 设计尺寸只作**初值**（拿不到主窗口时它就是最终值）：真正的几何在 build 之后用
        // 物理像素落地 —— builder 的 `position` / `inner_size` 只有逻辑坐标，多屏不同缩放时
        // 会被 tao 按"逐个显示器试算"选错屏（详见 aux_window_geometry）。
        .inner_size(760.0, 560.0)
        .min_inner_size(420.0, 320.0)
        // 背景色跟随主题：窗口的静态背景色只能是浅/深之一，暗色主题下不先设对就会"闪一下白"
        // （与主窗口冷启动白闪同源）。放在 builder 上（而不是 build 之后再 set），
        // 少一帧错色。
        .background_color(bg)
        // 隐藏创建：`ensure_aux_window` 随后就会 `show()`，中间这段正好用来摆位置与尺寸，
        // 用户不会看到窗口先在默认位置上闪一下、再跳到正确的位置。
        .visible(false)
        .build()?;
        if let Some(g) = geo {
            apply_aux_geometry(&win, g);
        }
        Ok(win)
    })
}

/// 移动端桩：移动端的日志是**整页**（`LogViewer` 的全屏分支），没有独立窗口。
/// 必须有这个桩，否则 `generate_handler!` 在移动端编译不过（见 `open_settings_window`）。
#[cfg(mobile)]
#[tauri::command]
pub fn open_log_window(_app: tauri::AppHandle) -> Result<(), String> {
    Err("移动端没有独立日志窗口（日志是整页）".to_string())
}

/// 桌面端：打开独立的「设置」窗口（已存在则聚焦）。
///
/// 与日志窗口同一范式（同一个 [`ensure_aux_window`]）：加载 `settings.html`（自己的入口），
/// 由前端按窗口自己的文档渲染设置页。用户 2026-09-12 反馈：「PC 端的设置页面可以按照这种
/// 布局，弹一个单独的窗口」——参考图是「左侧窄导航 + 右侧内容」的设置窗口，不是盖在聊天上的弹窗。
#[cfg(desktop)]
#[tauri::command(async)]
pub fn open_settings_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let bg = aux_window_background(&state);
    let title = state.display_name(); // 同 open_log_window：占位标题，文档加载后被接管
    let build_app = app.clone(); // 同 open_log_window：闭包要 `'static`，不能再借 `app`
                                 // 尺寸与位置按主窗口算，理由见 aux_window_geometry。
    let geo = aux_window_geometry(&app, (780.0, 600.0), (560.0, 420.0));
    ensure_aux_window(&app, crate::WINDOW_SETTINGS, geo, move || {
        let win = WebviewWindowBuilder::new(
            &build_app,
            crate::WINDOW_SETTINGS,
            WebviewUrl::App("settings.html".into()),
        )
        .title(title)
        // 同 open_log_window：设计尺寸只作初值，几何在 build 之后按物理像素落地。
        .inner_size(780.0, 600.0)
        .min_inner_size(560.0, 420.0)
        .background_color(bg)
        .visible(false)
        .build()?;
        if let Some(g) = geo {
            apply_aux_geometry(&win, g);
        }
        Ok(win)
    })
}

/// 独立窗口的初始背景色：跟随当前亮暗主题（暗色下打开时不"闪一下白"）。
#[cfg(desktop)]
fn aux_window_background(state: &tauri::State<'_, Arc<AppState>>) -> tauri::window::Color {
    let dark = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_setting(&dbc, "dark_mode")
            .map(|v| v == "1")
            .unwrap_or(false)
    };
    if dark {
        tauri::window::Color(11, 18, 32, 255) // #0b1220
    } else {
        tauri::window::Color(237, 241, 246, 255) // #edf1f6
    }
}

/// 移动端桩：独立的设置窗口是**桌面**概念（`decorations:false` 自绘标题栏 + 多窗口），
/// 移动端用的是整页设置页（`SettingsPanel` 的全屏分支）。
///
/// 为什么必须有这个桩：`lib.rs` 的 `generate_handler!` 是**无条件**列出命令的，
/// 而 `#[tauri::command]` 生成的包装宏跟着函数一起被 `#[cfg(desktop)]` 裁掉
/// ⇒ Android/iOS 目标上 `generate_handler!` 找不到它、**整个移动端编译不过**。
/// （这是真实缺陷：本轮为了验证蓝牙在 Android 上能否编译时才发现。）
#[cfg(mobile)]
#[tauri::command]
pub fn open_settings_window(_app: tauri::AppHandle) -> Result<(), String> {
    Err("移动端没有独立设置窗口（设置是整页，见 SettingsPanel）".to_string())
}

/// 桌面端：关闭独立的「设置」窗口。
///
/// 常驻模式下 `close()` 会被 `install_hide_on_close` 拦成"隐藏"（与系统标题栏的 × 同一条路），
/// 这样设置窗口的状态在下一次打开时还在、打开也是瞬时的；真要销毁，把
/// [`AUX_WINDOWS_RESIDENT`] 改成 `false` 即可，这里不用动。
#[cfg(desktop)]
#[tauri::command]
pub fn close_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(crate::WINDOW_SETTINGS) {
        let _ = win.close();
    }
    Ok(())
}

/// 移动端桩：见 `open_settings_window` 的说明（`generate_handler!` 无条件列出，
/// 桌面专属命令必须有移动端对应物，否则移动端编译不过）。
#[cfg(mobile)]
#[tauri::command]
pub fn close_settings_window(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// 桌面端：关闭独立的「运行日志」窗口（常驻模式下同样是"隐藏"，见 `close_settings_window`）。
#[cfg(desktop)]
#[tauri::command]
pub fn close_log_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(crate::WINDOW_LOGS) {
        let _ = win.close();
    }
    Ok(())
}

/// 移动端桩：见 `open_log_window` 的说明。
#[cfg(mobile)]
#[tauri::command]
pub fn close_log_window(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{friend_is_online, FRIEND_ONLINE_GRACE_MS};

    /// 独立窗口的几何不变式：**永远不比主窗口大**、在主窗口内**居中**、
    /// 且最小尺寸不会把窗口顶回比目标更大。
    ///
    /// 为什么必须钉住：用户 2026-09-16 报的正是这个（「新窗口没居中，而且比主窗口还大很多」），
    /// 而这几条都是**几何量**—— 肉眼量不准，也只能靠算。
    #[cfg(desktop)]
    #[test]
    fn aux_window_fits_inside_the_main_window_and_is_centered() {
        use super::{fit_aux_window, AUX_WINDOW_MARGIN};
        // 两组真实参数：设置 780×600（最小 560×420）、日志 760×560（最小 420×320）。
        let cases = [
            ((780.0, 600.0), (560.0, 420.0)),
            ((760.0, 560.0), (420.0, 320.0)),
        ];
        // 主窗口尺寸（物理像素）：默认 1000×680@100%、拉小、很小、放大、以及 125%/150% 缩放。
        let mains = [
            ((1000u32, 680u32), 1.0),
            ((900, 700), 1.0),
            ((700, 500), 1.0),
            ((400, 300), 1.0),
            ((1600, 1000), 1.0),
            ((1500, 1020), 1.25),
            ((1700, 1200), 1.5),
        ];
        // 主窗口左上角：主屏 (0,0)、右侧副屏 (1920,0)、**左侧**副屏（负坐标）——多屏必须都对。
        let origins = [(0i32, 0i32), (1920, 0), (-1920, 100), (100, 50)];
        for (ideal, min) in cases {
            for (size, scale) in mains {
                for main_pos in origins {
                    let g = fit_aux_window(size, main_pos, scale, ideal, min);
                    assert!(
                        g.size.0 <= size.0 && g.size.1 <= size.1,
                        "子窗口 {:?} 不能比主窗口 {:?} 大（ideal={ideal:?} scale={scale}）",
                        g.size,
                        size
                    );
                    assert!(
                        g.min.0 <= g.size.0 && g.min.1 <= g.size.1,
                        "最小尺寸 {:?} 不能大于实际尺寸 {:?} —— 否则系统会把窗口顶回去，缩小等于白做",
                        g.min,
                        g.size
                    );
                    // 居中：按真实外框算，左右/上下留边相等，且整体在主窗口内
                    let outer = (g.size.0 + 16, g.size.1 + 39); // 假装有 16/39 的边框与标题栏
                    let (x, y) = g.centered_pos(outer);
                    let left = x - main_pos.0;
                    let right = main_pos.0 + size.0 as i32 - (x + outer.0 as i32);
                    assert!(
                        (left - right).abs() <= 1,
                        "水平未居中：左 {left} 右 {right}"
                    );
                    let top = y - main_pos.1;
                    let bottom = main_pos.1 + size.1 as i32 - (y + outer.1 as i32);
                    assert!(
                        (top - bottom).abs() <= 1,
                        "垂直未居中：上 {top} 下 {bottom}"
                    );
                    let (ex, ey) = g.centered_pos(g.size);
                    assert!(
                        ex >= main_pos.0 && ey >= main_pos.1,
                        "不能跑到主窗口左上角之外"
                    );
                }
            }
        }
        // 装得下时必须**保持设计尺寸 × 主窗口缩放**（不能因为主窗口大就无限放大）
        let g = fit_aux_window((1600, 1000), (0, 0), 1.0, (780.0, 600.0), (560.0, 420.0));
        assert_eq!(g.size, (780, 600), "主窗口够大时应保持设计尺寸");
        let g = fit_aux_window((3000, 2000), (0, 0), 1.5, (780.0, 600.0), (560.0, 420.0));
        assert_eq!(
            g.size,
            (1170, 900),
            "150% 屏上 780×600 逻辑 = 1170×900 物理"
        );
        assert_eq!(g.min, (840, 630), "最小尺寸也要按同一缩放换成物理值");
        // 装不下时把边距留够（24 逻辑像素 × 缩放）
        let g = fit_aux_window((700, 500), (0, 0), 1.0, (780.0, 600.0), (560.0, 420.0));
        assert_eq!(
            g.size,
            (
                700 - 2 * AUX_WINDOW_MARGIN as u32,
                500 - 2 * AUX_WINDOW_MARGIN as u32
            )
        );
        let g = fit_aux_window((800, 600), (0, 0), 2.0, (780.0, 600.0), (560.0, 420.0));
        assert_eq!(
            g.size,
            (
                800 - 2 * (AUX_WINDOW_MARGIN * 2.0) as u32,
                600 - 2 * (AUX_WINDOW_MARGIN * 2.0) as u32
            )
        );
    }

    /// `generate_handler!` 里列出的命令在**移动端也必须存在**。
    ///
    /// 为什么必须守：`lib.rs` 的 `generate_handler!` 是**无条件**列出命令名的，而
    /// `#[tauri::command]` 生成的包装宏跟着函数一起被 `#[cfg(desktop)]` 裁掉 ——
    /// 于是"桌面专属命令 + 无条件列出"就等于 **Android/iOS 目标编译失败（E0433）**。
    /// 2026-09-12 本轮就是这样踩到的：四个设置/日志窗口命令让移动端整包编不出来，
    /// 而当时**没有任何守门**（`cargo test --lib` 只按桌面口径检查）。
    ///
    /// 判据：凡是被列出的、且定义处带 `#[cfg(desktop)]` 的命令，必须同时有
    /// `#[cfg(mobile)]` 的桩（沿用 `focus_window` 的范式）。
    #[test]
    fn every_handler_command_exists_for_mobile() {
        // 本文件自身的源码（用于查 `#[cfg(desktop)]` / `#[cfg(mobile)]` 成对性）
        let src = include_str!("commands.rs");
        let lib_src = include_str!("lib.rs");
        let start = lib_src
            .find("generate_handler![")
            .expect("lib.rs 应有 generate_handler!");
        let rest = &lib_src[start..];
        let end = rest.find(']').expect("generate_handler! 应有收尾方括号");
        let listed: Vec<&str> = rest[..end]
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::"))
            .map(|s| s.trim().trim_end_matches(','))
            .filter(|s| !s.is_empty())
            .collect();
        assert!(
            listed.len() > 50,
            "命令列表解析异常（只解析出 {} 条）—— 守卫会变成空转",
            listed.len()
        );
        for name in listed {
            let desktop_only = src.contains(&format!(
                "#[cfg(desktop)]\n#[tauri::command]\npub fn {name}("
            ));
            if !desktop_only {
                continue; // 非桌面专属 ⇒ 移动端本来就有
            }
            let has_mobile = src.contains(&format!(
                "#[cfg(mobile)]\n#[tauri::command]\npub fn {name}("
            ));
            assert!(
                has_mobile,
                "命令 `{name}` 是桌面专属（#[cfg(desktop)]）却被 generate_handler! 无条件列出，\n\
                 且没有 #[cfg(mobile)] 桩 ⇒ Android/iOS 目标会编译失败（E0433）。\n\
                 修法：照着 `focus_window` 加一个移动端桩（打开类返回明确 Err、关闭类 Ok(())）。"
            );
        }
    }

    use super::{
        check_message_content, decode_outgoing_image, group_file_progress_from, image_extension,
        normalize_routed_address, MAX_MESSAGE_LEN, MAX_OUTGOING_IMAGE_BYTES,
    };
    use crate::state::GroupFileRecipient;
    use std::collections::HashSet;

    fn recipient(id: &str, progress: f64) -> GroupFileRecipient {
        GroupFileRecipient {
            recipient_id: id.to_string(),
            status: if progress >= 1.0 {
                "completed"
            } else {
                "sending"
            }
            .to_string(),
            progress,
            updated_at: 0,
        }
    }

    fn online(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// 好友在线判据：**最近见过 或 有活链路**；只"在节点表里"不算在线。
    ///
    /// 两条真机结论一起钉住：① 节点条目在掉线后会**保留**（`mark_peer_offline` 不再删，
    /// 否则 Mac 的「添加好友」列表里对端只闪一下）；② 因此"在表里"绝不能等价于"在线"，
    /// 否则就是复核抓到过的"连过又掉线 ⇒ 永久在线"。
    #[test]
    fn friend_online_needs_freshness_or_an_active_link() {
        let now = 1_000_000_000_000_i64;
        // 刚见过（节点条目保留着）⇒ 在线
        assert!(friend_is_online(now - 1_000, now, false));
        // 15s 边界内 ⇒ 在线（announce 5s 一轮 + 抖动，容忍丢一两轮）
        assert!(friend_is_online(now - FRIEND_ONLINE_GRACE_MS, now, false));
        // 超过窗口且没有链路 ⇒ 离线（就是"连过又掉线"的那个场景）
        assert!(!friend_is_online(
            now - FRIEND_ONLINE_GRACE_MS - 1,
            now,
            false
        ));
        assert!(!friend_is_online(0, now, false));
        // 有活链路 ⇒ 恒在线（哪怕很久没有 announce：跨子网中继场景）
        assert!(friend_is_online(0, now, true));
    }

    /// 用户口径：进度条只按**发送时在线的成员**算。
    /// 复现场景：群 3 人，1 人离线；两个在线成员都收完 ⇒ 进度必须是 **100%**，
    /// 而不是被离线成员的 0 拖成 50%（这正是 `6e9b96e` 那轮用户反馈的「卡在 50%」）。
    #[test]
    fn group_file_progress_ignores_offline_members() {
        let rs = vec![
            recipient("a", 1.0),
            recipient("b", 1.0),
            recipient("offline", 0.0),
        ];
        let snap = online(&["a", "b"]);
        assert_eq!(group_file_progress_from(&rs, Some(&snap), 0.0), 1.0);
        // 对照组：不传快照（全体口径）时，同一组数据只有 2/3 —— 证明差异来自分母而非巧合。
        let all = group_file_progress_from(&rs, None, 0.0);
        assert!(
            (all - 2.0 / 3.0).abs() < 1e-9,
            "全体口径应为 2/3，实际 {all}"
        );
    }

    /// 离线成员之后上线补发**不得回退**进度条：分母是冻结快照，与他的进度无关。
    #[test]
    fn late_online_member_does_not_regress_progress() {
        let snap = online(&["a", "b"]);
        let done = vec![
            recipient("a", 1.0),
            recipient("b", 1.0),
            recipient("offline", 0.0),
        ];
        assert_eq!(group_file_progress_from(&done, Some(&snap), 0.0), 1.0);
        // 离线者开始补发（进度 0.5）——仍在快照外，不影响结果
        let catching_up = vec![
            recipient("a", 1.0),
            recipient("b", 1.0),
            recipient("offline", 0.5),
        ];
        assert_eq!(
            group_file_progress_from(&catching_up, Some(&snap), 0.0),
            1.0
        );
    }

    /// 在线成员未全部完成时，进度是在线成员的平均值（不是 max，也不是全体）。
    #[test]
    fn group_file_progress_averages_online_members() {
        let rs = vec![
            recipient("a", 1.0),
            recipient("b", 0.0),
            recipient("offline", 1.0),
        ];
        let snap = online(&["a", "b"]);
        assert_eq!(group_file_progress_from(&rs, Some(&snap), 0.0), 0.5);
    }

    /// 发送时无人在线 ⇒ 进度恒 0（没有「在线成员都收到了」这件事）。
    #[test]
    fn group_file_progress_is_zero_when_nobody_online_at_send() {
        let rs = vec![recipient("a", 0.0), recipient("b", 0.0)];
        let empty = HashSet::new();
        assert_eq!(group_file_progress_from(&rs, Some(&empty), 0.0), 0.0);
        // 即便调用方传了 fallback（本连接字节进度），空快照也必须压到 0 ——
        // 否则「发给一个刚好在线的成员」会看起来像全群都完成了。
        assert_eq!(group_file_progress_from(&rs, Some(&empty), 0.7), 0.0);
    }

    /// 快照丢失（重启后内存态清空）时退回全体口径；空集合/越界 fallback 都要夹紧。
    #[test]
    fn group_file_progress_fallback_and_clamp() {
        let rs = vec![recipient("a", 0.5), recipient("b", 0.5)];
        assert_eq!(group_file_progress_from(&rs, None, 0.0), 0.5);
        assert_eq!(
            group_file_progress_from(&[], None, 0.3),
            0.3,
            "无 recipient 时用 fallback"
        );
        assert_eq!(
            group_file_progress_from(&rs, None, 2.0),
            1.0,
            "fallback 超界要夹到 1"
        );
        assert_eq!(
            group_file_progress_from(&rs, None, -1.0),
            0.5,
            "负 fallback 不得把进度拉成负"
        );
    }

    /// Routed 端点地址：`ip` 与 `ip:port` 两种写法都收（省略端口补标准 `TCP_PORT`），
    /// 并在**存储前规范化**——这样 add 与 remove 比较的是同一个字符串，
    /// 不会出现「加进去了却删不掉」。IPv6 当场明确拒绝。
    #[test]
    fn routed_endpoint_address_is_normalized_to_ipv4_socket() {
        // 省略端口 → 补标准端口（端口是内部细节，用户不必知道）
        assert_eq!(
            normalize_routed_address("100.64.0.1").unwrap(),
            format!("100.64.0.1:{}", crate::protocol::TCP_PORT)
        );
        // 显式端口 → 原样保留（对端用了 --instance 的场景）
        assert_eq!(
            normalize_routed_address("100.64.0.1:60002").unwrap(),
            "100.64.0.1:60002"
        );
        // 前后空白容错（从聊天窗口复制地址常带空格）
        assert_eq!(
            normalize_routed_address("  192.168.1.5  ").unwrap(),
            format!("192.168.1.5:{}", crate::protocol::TCP_PORT)
        );

        // 格式错误
        assert!(normalize_routed_address("100.64.0.1:").is_err());
        assert!(normalize_routed_address("garbage").is_err());
        assert!(normalize_routed_address("").is_err());

        // IPv6：拒绝，且错误信息要能给出可操作的指引
        let err = normalize_routed_address("[fd7a:115c:a1e0::1]:59992").unwrap_err();
        assert!(err.contains("IPv6"), "错误信息应点明 IPv6：{err}");
        assert!(normalize_routed_address("fd7a:115c:a1e0::1").is_err());
    }
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // ---------- 单条消息长度上限：超限报错，绝不静默截断 ----------

    #[test]
    fn message_content_within_limit_is_returned_unchanged() {
        let ok = "a".repeat(MAX_MESSAGE_LEN);
        let got = check_message_content(ok.clone()).unwrap();
        assert_eq!(got, ok, "恰好到上限必须原样通过，不能被改动");
    }

    #[test]
    fn message_content_over_limit_is_rejected_not_truncated() {
        let over = "b".repeat(MAX_MESSAGE_LEN + 1);
        let err = check_message_content(over).unwrap_err();
        assert!(err.contains("过长"), "错误文案应说明「过长」：{err}");
        assert!(
            err.contains(&(MAX_MESSAGE_LEN + 1).to_string()),
            "应告知实际长度，便于用户判断如何分段：{err}"
        );
    }

    #[test]
    fn message_length_is_counted_in_chars_not_bytes() {
        // 按字符计数：5 万汉字（15 万字节）合法，5 万零 1 个汉字才拒绝。
        // 若误按字节计数，5 万汉字会被判超限，正常长文就发不出去了。
        let cjk = "中".repeat(MAX_MESSAGE_LEN);
        assert!(check_message_content(cjk).is_ok());

        let cjk_over = "中".repeat(MAX_MESSAGE_LEN + 1);
        assert!(check_message_content(cjk_over).is_err());
    }

    #[test]
    fn empty_message_content_is_allowed_at_this_layer() {
        // 空内容的拦截属于上层（发送键置灰），这里不做业务判断，避免产生第二处规则。
        assert!(check_message_content(String::new()).is_ok());
    }

    #[test]
    fn image_extension_maps_common_mimes() {
        assert_eq!(image_extension("image/png"), Some("png"));
        assert_eq!(image_extension("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension("image/gif"), Some("gif"));
        assert_eq!(image_extension("image/webp"), Some("webp"));
        assert_eq!(image_extension("IMAGE/PNG"), Some("png"));
        assert_eq!(image_extension("image/bmp"), None);
        assert_eq!(image_extension("text/plain"), None);
    }

    fn data_url(mime: &str, bytes: &[u8]) -> String {
        format!("data:{};base64,{}", mime, STANDARD.encode(bytes))
    }

    #[test]
    fn decode_accepts_png_jpeg_gif_webp() {
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            let expected_ext = image_extension(mime).unwrap();
            let url = data_url(mime, b"fake-image-body");
            let (ext, bytes) = decode_outgoing_image(&url).unwrap();
            assert_eq!(ext, expected_ext);
            assert_eq!(bytes, b"fake-image-body");
        }
    }

    #[test]
    fn decode_rejects_non_image_mime() {
        let url = data_url("text/plain", b"hello");
        assert!(decode_outgoing_image(&url).unwrap_err().contains("图片"));
    }

    #[test]
    fn decode_rejects_unsupported_image_mime() {
        let url = data_url("image/bmp", b"hello");
        assert!(decode_outgoing_image(&url).unwrap_err().contains("不支持"));
    }

    #[test]
    fn decode_rejects_invalid_base64() {
        let url = "data:image/png;base64,!!!";
        assert!(decode_outgoing_image(url).unwrap_err().contains("解码失败"));
    }

    #[test]
    fn decode_rejects_malformed_data_url() {
        assert!(decode_outgoing_image("not-a-data-url").is_err());
        assert!(decode_outgoing_image("data:image/png").is_err());
        assert!(decode_outgoing_image("data:image/png,raw").is_err());
    }

    #[test]
    fn decode_rejects_empty_image() {
        let url = data_url("image/png", b"");
        assert!(decode_outgoing_image(&url).unwrap_err().contains("为空"));
    }

    #[test]
    fn decode_rejects_over_byte_limit() {
        let big = vec![0u8; (MAX_OUTGOING_IMAGE_BYTES + 1) as usize];
        let url = data_url("image/png", &big);
        let err = decode_outgoing_image(&url).unwrap_err();
        assert!(err.contains("过大"));
        assert!(err.contains(&MAX_OUTGOING_IMAGE_BYTES.to_string()));
    }

    /// **设置变更的补丁必须"只带变了的键、且键名与前端 camelCase 一致"**。
    ///
    /// 这是 `settings-changed` 从"无载荷 + 全量重拉"改成"带补丁 + 零 IPC"的地基：
    /// 键名写错（例如 `theme_color` 而不是 `themeColor`）不会报错，只会让另一个窗口
    /// **静默地不更新**（用户看到的就是"设置里改了、主界面没变"那类幽灵问题）。
    #[test]
    fn settings_patch_carries_only_changed_keys_with_camel_case_names() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        crate::db::set_setting(&conn, "theme_color", "#123456").unwrap();
        crate::db::set_setting(&conn, "language", "en-US").unwrap();
        crate::db::set_setting(&conn, "dark_mode", "1").unwrap();

        let patch = super::settings_patch_values(&conn, &["themeColor", "language", "darkMode"]);
        let obj = patch.as_object().expect("补丁必须是 JSON 对象");
        assert_eq!(obj.len(), 3, "只应包含被点名的键");
        assert_eq!(obj["themeColor"], serde_json::json!("#123456"));
        assert_eq!(obj["language"], serde_json::json!("en-US"));
        assert_eq!(
            obj["darkMode"],
            serde_json::json!(true),
            "dark_mode 要转成布尔"
        );
        assert!(obj.get("theme_color").is_none(), "键名必须是 camelCase");
        assert!(obj.get("fontFamily").is_none(), "没变的键不得出现");

        // 通知两项的缺省是"开"（与 get_settings 同口径）：没设置过也必须给 true，
        // 否则另一个窗口会把"通知已开启"应用成关闭。
        let patch = super::settings_patch_values(&conn, &["notifyEnabled", "notifyShowContent"]);
        assert_eq!(patch["notifyEnabled"], serde_json::json!(true));
        assert_eq!(patch["notifyShowContent"], serde_json::json!(true));

        // 资料/目录不在 Settings 形状里 ⇒ 不放进补丁（接收方看到键名会定向重拉）
        let patch = super::settings_patch_values(&conn, &["nickname", "avatar", "shareDir"]);
        assert_eq!(patch.as_object().unwrap().len(), 0);
    }

    /// **清空必须是"分批 + 批间放锁"** —— 这是"点清除数据不再卡死"的机制本身。
    ///
    /// 用户实测：点「清除数据」时设置窗口整个卡死、点不动。根因是原实现用一个横跨所有表的
    /// 大事务，把 `db` 互斥锁握住数秒；期间每个读命令都在等锁，等锁的 async 任务占住工作线程，
    /// 新 IPC 排不上队。修法是分批 —— 本用例**确定性地**证明"单次只删一批"：
    /// 若有人把它改回"一个大事务"，第一次调用就会把表删光，下面的断言立刻失败。
    #[test]
    fn clear_is_batched_so_the_db_lock_is_held_only_briefly() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        let rows = super::CLEAR_BATCH_ROWS * 2 + 10;
        {
            let tx = conn.unchecked_transaction().unwrap();
            for i in 0..rows {
                tx.execute(
                    "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, status)
                     VALUES(?1, 'c1', 'me', 'peer', 'text', 'x', ?2, 'sent')",
                    rusqlite::params![format!("m{i}"), i as i64],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        let db = std::sync::Mutex::new(conn);

        // ① 单次调用只允许删一批
        let first = super::clear_one_batch(&db, "messages").unwrap();
        assert_eq!(
            first,
            super::CLEAR_BATCH_ROWS as u64,
            "单次调用必须只删一批（一次 2000 行）；删更多说明事务又变大了"
        );
        let left_after_first: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            left_after_first,
            rows as i64 - super::CLEAR_BATCH_ROWS as i64,
            "第一次调用只该删掉一批（剩 {} 行）—— 若这里是 0，说明又回到\"一个大事务握住锁\"了",
            rows - super::CLEAR_BATCH_ROWS
        );

        // ② 循环删干净
        let mut total = first;
        loop {
            let n = super::clear_one_batch(&db, "messages").unwrap();
            total += n;
            if n == 0 {
                break;
            }
        }
        assert_eq!(total, rows as u64, "必须把行删干净");
        let left: i64 = db
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "表必须清空");
    }

    #[test]
    fn decode_respects_exact_byte_limit() {
        let exact = vec![0u8; MAX_OUTGOING_IMAGE_BYTES as usize];
        let url = data_url("image/png", &exact);
        let (_, bytes) = decode_outgoing_image(&url).unwrap();
        assert_eq!(bytes.len() as u64, MAX_OUTGOING_IMAGE_BYTES);
    }

    /// **`content://` URI → 真实文件名**（安卓选择器的返回值解析规则）。
    #[test]
    fn content_uri_yields_a_real_file_name_when_it_encodes_one() {
        // external-storage / documents 提供者会把相对路径编码进 URI
        assert_eq!(
            super::name_from_content_uri(
                "content://com.android.externalstorage.documents/document/primary%3ADownload%2Freport.pdf"
            )
            .as_deref(),
            Some("report.pdf")
        );
        assert_eq!(
            super::name_from_content_uri(
                "content://x/document/primary%3APictures%2FIMG%202024.jpg"
            )
            .as_deref(),
            Some("IMG 2024.jpg")
        );
        // MediaStore（相册）只有数字 id ⇒ 取不到名字，交给内容嗅探
        assert_eq!(
            super::name_from_content_uri("content://media/external/images/media/1000000033"),
            None
        );
        // 危险/异常形状一律拒绝（不能让它决定落盘路径）
        assert_eq!(
            super::name_from_content_uri("content://x/document/..%2F..%2Fetc%2Fpasswd"),
            None
        );
        assert_eq!(
            super::name_from_content_uri("content://x/document/noext"),
            None
        );
    }

    /// **按文件头嗅探媒体类型**：相册 URI 没有扩展名，靠内容才能把图片发成"图片"。
    #[test]
    fn sniff_media_ext_recognises_the_common_types() {
        assert_eq!(super::sniff_media_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), "jpg");
        assert_eq!(super::sniff_media_ext(b"\x89PNG\r\n\x1a\n"), "png");
        assert_eq!(super::sniff_media_ext(b"GIF89a"), "gif");
        assert_eq!(
            super::sniff_media_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            "webp"
        );
        assert_eq!(super::sniff_media_ext(b"%PDF-1.7"), "pdf");
        assert_eq!(super::sniff_media_ext(b"PK\x03\x04"), "zip");
        // 未知内容 → bin（当成普通文件，绝不猜成图片）
        assert_eq!(super::sniff_media_ext(b"\x00\x01\x02\x03"), "bin");
        assert_eq!(super::sniff_media_ext(&[]), "bin");
    }

    /// 文件名消毒：不允许写出缓存目录之外，也不允许空名字。
    #[test]
    fn sanitize_file_name_blocks_path_traversal() {
        let escaped = super::sanitize_file_name("../../etc/passwd");
        assert!(
            !escaped.contains('/') && !escaped.contains('\\'),
            "消毒后不能含路径分隔符：{escaped}"
        );
        assert_eq!(super::sanitize_file_name("a/b\\c.txt"), "a_b_c.txt");
        assert_eq!(super::sanitize_file_name("   "), "file.bin");
        assert_eq!(super::sanitize_file_name("...hidden"), "hidden");
        assert_eq!(super::sanitize_file_name("正常名字.pdf"), "正常名字.pdf");
    }

    /// **已经是好友的人，其好友申请不该再出现在「新朋友」里**（用户 2026-09-12 真机实测要求）。
    fn pending(from: &str) -> super::PendingRequest {
        super::PendingRequest {
            from: from.to_string(),
            from_nickname: from.to_string(),
            from_avatar: None,
            ts: 1,
        }
    }

    fn ids(list: &[&str]) -> std::collections::HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pending_request_from_an_existing_friend_is_not_actionable() {
        // 不是好友 → 该显示
        assert!(super::is_actionable_request(&pending("A"), &ids(&[])));
        assert!(super::is_actionable_request(&pending("A"), &ids(&["B"])));
        // 已是好友 → 不显示（这正是用户报的"点了同意，对方那边申请还挂着"）
        assert!(!super::is_actionable_request(&pending("A"), &ids(&["A"])));
        assert!(!super::is_actionable_request(
            &pending("A"),
            &ids(&["A", "B"])
        ));
    }

    /// 蓝牙开关的决策规则：**最后一次意图胜出**，冷却只排队、不丢弃。
    ///
    /// 为什么必须守（用户 2026-09-13）：
    /// - 旧实现"冷却期内直接忽略请求"会把用户"关一下马上又开"的第二次点击**静默吞掉**
    ///   ⇒ 开关看起来点了没反应；
    /// - 反过来，抖动的调用方（每秒十几次开/关）必须仍然被挡住 —— 每次真实启停都要等满冷却，
    ///   这是 2026-09-12"整个应用顿卡"那个事故的护栏。
    /// 两条都在下面钉住。
    #[cfg(feature = "bluetooth")]
    #[test]
    fn bt_switch_plan_coalesces_intent_and_keeps_the_cooldown() {
        use super::bt_switch_plan;
        const CD: u64 = 3_000;

        // ① 常规：从未启停过 + 运行状态与目标不同 ⇒ 立刻动手
        let p = bt_switch_plan(false, true, Some(true), 0, 10_000, CD);
        assert!(p.apply && p.wait_ms == 0, "第一次开启必须立刻执行：{p:?}");

        // ② 幂等：运行状态已经是目标状态 ⇒ 不碰蓝牙栈（抖动护栏）
        let p = bt_switch_plan(true, true, Some(true), 10_000, 10_100, CD);
        assert!(!p.apply, "已经是目标状态时不许再启停：{p:?}");

        // ③ 冷却期内**改主意** ⇒ 不是丢弃，而是排队等够冷却再执行
        let p = bt_switch_plan(false, true, Some(true), 10_000, 11_000, CD);
        assert!(p.apply, "冷却期内的新意图必须被执行（不能丢）：{p:?}");
        assert_eq!(p.wait_ms, 2_000, "应等到 3s 冷却结束：{p:?}");

        // ④ 冷却已过 ⇒ 立刻执行
        let p = bt_switch_plan(false, true, Some(true), 10_000, 14_000, CD);
        assert!(p.apply && p.wait_ms == 0, "冷却结束后应立刻执行：{p:?}");

        // ⑤ 意图已被更晚的请求改写 ⇒ 本请求什么都不做（让那次去做）
        let p = bt_switch_plan(false, true, Some(false), 10_000, 20_000, CD);
        assert!(!p.apply, "被更晚的意图取代的请求不该动蓝牙栈：{p:?}");
        assert!(p.reason.contains("取代"), "原因要说清楚：{p:?}");

        // ⑥ 时钟回拨 / 毫秒溢出：不允许 panic，也不允许负等待
        let p = bt_switch_plan(false, true, Some(true), 10_000, 5_000, CD);
        assert!(p.apply && p.wait_ms == CD, "时钟回拨时按满冷却等待：{p:?}");
    }

    /// `latest_todo_def`：从消息日志里取"最新一条定义"，规则必须与前端 `newer()` 一致。
    ///
    /// 为什么这条必须有：它是**服务端鉴权的唯一依据**（谁创建、指派了谁）——
    /// 取错一条（例如按随机 id 排序而没按 `seq`）就会让"谁能改"判错，
    /// 而这类错误在界面上完全看不出来（只是某些人少了几个按钮、或多了不该有的权限）。
    #[test]
    fn latest_todo_def_follows_the_same_lww_rule_as_the_frontend() {
        use crate::protocol::TodoPayload;
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        let conv = "group:g1";
        let payload = |title: &str| TodoPayload {
            todo_id: "todo-1".into(),
            title: title.into(),
            assignees: vec!["alice".into()],
            status: "todo".into(),
            creator: "alice".into(),
            deleted: false,
        };
        let insert = |msg_id: &str, seq: i64, p: &TodoPayload| {
            conn.execute(
                "INSERT INTO messages (msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status) \
                 VALUES (?1, ?2, 'alice', 'bob', 'todo', ?3, 0, ?4, 'sent')",
                rusqlite::params![msg_id, conv, serde_json::to_string(p).unwrap(), seq],
            )
            .unwrap();
        };
        insert("m1", 5, &payload("旧标题"));
        insert("m2", 6, &payload("新标题"));
        insert("m3", 6, &payload("同 seq 但 msg_id 更大"));
        assert_eq!(
            super::latest_todo_def(&conn, conv, "todo-1").unwrap().title,
            "同 seq 但 msg_id 更大",
            "同 seq 时必须按 msg_id 取更大者（与前端 newer() 同规则）"
        );
        assert!(
            super::latest_todo_def(&conn, conv, "todo-2").is_none(),
            "别的 todo_id 不许串台"
        );
        assert!(
            super::latest_todo_def(&conn, "group:g2", "todo-1").is_none(),
            "别的群不许串台"
        );
    }

    /// 任务改动的鉴权判据（用户口径：**被指派人勾选 + 创建者可改**）。
    #[test]
    fn todo_update_permission_matrix() {
        use crate::protocol::TodoPayload;
        let def = TodoPayload {
            todo_id: "t".into(),
            title: "x".into(),
            assignees: vec!["alice".into(), "bob".into()],
            status: "todo".into(),
            creator: "alice".into(),
            deleted: false,
        };
        // 创建者：改状态、改结构都可以
        assert!(super::may_update_todo(&def, "alice", "owner", false));
        assert!(super::may_update_todo(&def, "alice", "owner", true));
        // 被指派人：只能改状态，不能改标题/指派人/删除
        assert!(super::may_update_todo(&def, "bob", "owner", false));
        assert!(
            !super::may_update_todo(&def, "bob", "owner", true),
            "被指派人不得改标题 / 换指派人 / 删除任务"
        );
        // 群主：能改结构；但"改状态"不是他的特权（除非他同时是创建者或被指派人）
        assert!(super::may_update_todo(&def, "owner", "owner", true));
        assert!(!super::may_update_todo(&def, "owner", "owner", false));
        // 无关成员：什么都不行
        assert!(!super::may_update_todo(&def, "carol", "owner", false));
        assert!(!super::may_update_todo(&def, "carol", "owner", true));
    }
}
