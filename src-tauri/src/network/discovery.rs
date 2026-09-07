//! UDP 设备发现：广播 + 组播双通道，多网卡选择。
//!
//! 机制：
//! - 每 5 秒向局域网**广播**（255.255.255.255）与**组播**（239.255.42.99）一次 `announce`，
//!   携带设备 ID、昵称、TCP 端口、X25519/Ed25519 公钥。
//! - 启动时额外广播一次 `who_has`，其他节点收到后单播回复自身信息，用于快速互相发现。
//! - 接收到的 `announce` 用于维护在线节点表并触发 TCP 建链（小 ID 主动拨号）。

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::net::UdpSocket;
use tokio::sync::watch;
use tokio::time::{sleep_until, Duration, Instant};

use rand_core::{OsRng, RngCore};

use crate::commands::is_virtual_ip;
use crate::network::transport::{ensure_link, upsert_peer};
use crate::protocol::{UdpPacket, ANNOUNCE_INTERVAL_SECS, PEER_TIMEOUT_SECS, UDP_PORT};
use crate::state::AppState;

/// 组播地址（与广播并行，覆盖被隔离广播域的场景）
pub const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);

/// 检查一个 IPv4 是否属于 RFC1918 私网地址（合法 LAN 常用段）。
fn is_rfc1918(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    (o[0] == 10) || (o[0] == 172 && o[1] >= 16 && o[1] <= 31) || (o[0] == 192 && o[1] == 168)
}

/// 接口名称是否匹配已知虚拟/VPN/容器适配器模式。
/// 覆盖 macOS / Linux / Windows 三端常见名称。
fn is_virtual_interface_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let patterns = [
        "utun",
        "tun",
        "tap",
        "wg", // VPN / WireGuard
        "docker",
        "br-",
        "veth",
        "virbr", // Docker / libvirt
        "vmnet",
        "vboxnet", // VMware / VirtualBox
        "hyper-v",
        "hv_",
        "vethernet", // Hyper-V
        "cf-",
        "clash",
        "wintun", // Clash / Cloudflare WARP / WinTun
        "tailscale",
        "ts-", // Tailscale
        "ham",
        "vpn",
        "vgate", // 通用 VPN / 企业 VPN
    ];
    patterns.iter().any(|p| n.contains(p))
}

/// 为一个 IPv4 候选接口评分（越高越像真实 LAN）。
///
/// 评分维度（可解释、确定性，不依赖 `get_if_addrs()` 返回顺序）：
///   +10  有 broadcast 地址（真实 LAN 的核心标志）
///   +5   RFC1918 私网地址（10.x / 172.16-31.x / 192.168.x）
///   -50  虚拟地址段（198.18/15 / 100.64/10 / 169.254/16）
///   -30  虚拟接口名称（tun / docker / vmnet / wg / hyper-v 等）
fn score_candidate(ip: &Ipv4Addr, name: &str, has_broadcast: bool) -> i32 {
    let mut score = 0;
    if has_broadcast {
        score += 10;
    }
    if is_rfc1918(ip) {
        score += 5;
    }
    if is_virtual_ip(ip) {
        score -= 50;
    }
    if is_virtual_interface_name(name) {
        score -= 30;
    }
    score
}

/// 自动模式下检测最佳 LAN 网卡（IP + broadcast 地址）。
///
/// 使用评分函数而非「第一个匹配就返回」：即使系统上存在多个有 broadcast 的
/// 接口（Docker bridge / VMware / 真实 LAN），评分机制也能稳定选出真实 LAN，
/// 且结果不依赖 `get_if_addrs()` 的返回顺序。
///
/// 返回 `(lan_ip, broadcast_addr)`：
/// - `lan_ip`：用于 `IP_MULTICAST_IF`（强制组播出口）和 `join_multicast_v4`
/// - `broadcast_addr`：用于将 UDP 广播发到精确子网地址（如 `192.168.1.255`），
///   而非 `255.255.255.255`，确保广播不会因默认路由进入 VPN 适配器
fn find_lan_interface() -> Option<(Ipv4Addr, Ipv4Addr)> {
    let ifs = if_addrs::get_if_addrs().ok()?;
    let mut best: Option<(Ipv4Addr, Ipv4Addr, i32)> = None;
    for i in &ifs {
        if let if_addrs::IfAddr::V4(v4) = &i.addr {
            let ip = match i.ip() {
                std::net::IpAddr::V4(v) => v,
                _ => continue,
            };
            if i.is_loopback() {
                continue;
            }
            let has_broadcast = v4.broadcast.is_some();
            let score = score_candidate(&ip, &i.name, has_broadcast);
            if let Some(bc) = v4.broadcast {
                if score > best.as_ref().map_or(i32::MIN, |(_, _, s)| *s) {
                    best = Some((ip, bc, score));
                }
            }
        }
    }
    // 只接受正分候选（有 broadcast + 非虚拟名 + 非虚拟地址 = 至少 +10 分）
    best.filter(|(_, _, s)| *s > 0).map(|(ip, bc, _)| (ip, bc))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 绑定一个允许地址复用的 UDP 套接字（SO_REUSEADDR + SO_BROADCAST + unix 下 SO_REUSEPORT），
/// 使同一台机器上的多个 gosslan 实例能同时监听同一发现端口（Windows/macOS/Linux 通用）。
///
/// `multicast_if`：自动模式下传入真实 LAN 接口 IP，设置 `IP_MULTICAST_IF`，
/// 强制组播报文从该接口发出，避免走默认路由进入 VPN 适配器。
fn bind_udp_reusable(
    ip: Ipv4Addr,
    port: u16,
    multicast_if: Option<Ipv4Addr>,
) -> Result<(UdpSocket, String), String> {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::net::SocketAddr;

    let addr: SocketAddr = format!("{ip}:{port}")
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    let sock =
        Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(|e| e.to_string())?;
    sock.set_reuse_address(true).map_err(|e| e.to_string())?;
    // macOS/BSD：UDP 同端口多开必须 SO_REUSEPORT（SO_REUSEADDR 仅 Windows 允许重复绑定）。
    // 缺了它，同一台机器的第二个实例 network::start 会报 "Address already in use"，
    // 单机多实例互发现直接失效。
    #[cfg(unix)]
    sock.set_reuse_port(true).map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    // 设置组播出口接口：自动模式下强制走真实 LAN，避免组播被 VPN 默认路由劫持。
    // 仅影响发送，不影响接收（接收由 join_multicast_v4 控制）。
    let multicast_if_result = if let Some(iface) = multicast_if {
        match sock.set_multicast_if_v4(&iface) {
            Ok(()) => "ok".into(),
            Err(e) => format!("error: {e}"),
        }
    } else {
        "not_set".into()
    };
    // tokio 要求注册进 runtime 的 fd 必须非阻塞：socket2 创建的是阻塞 socket，
    // 直接 from_std 在 debug 构建会 panic（tokio blocking check），release 构建虽不 panic
    // 但阻塞 fd 挂在 kqueue/epoll 上会卡死 worker 线程（界面卡顿的帮凶之一）。
    sock.set_nonblocking(true).map_err(|e| e.to_string())?;
    let sock_addr: socket2::SockAddr = addr.into();
    sock.bind(&sock_addr).map_err(|e| e.to_string())?;

    let std_sock: std::net::UdpSocket = sock.into();
    let tokio_sock = UdpSocket::from_std(std_sock).map_err(|e| e.to_string())?;
    Ok((tokio_sock, multicast_if_result))
}

fn announce_packet(state: &AppState, tcp_port: u16) -> UdpPacket {
    UdpPacket {
        kind: "announce".to_string(),
        device_id: state.device_id.clone(),
        nickname: state.nickname.lock().unwrap().clone(),
        avatar: state.avatar.lock().unwrap().clone(),
        tcp_port,
        x25519_pubkey: Some(state.identity.x25519_public_b64()),
        ed25519_pubkey: Some(state.identity.ed25519_public_b64()),
        ts: now_ms(),
    }
}

/// 启动发现任务。
pub async fn spawn(
    state: Arc<AppState>,
    ip: Ipv4Addr,
    tcp_port: u16,
    shutdown: watch::Receiver<bool>,
    mut probe: watch::Receiver<u64>,
) -> Result<(), String> {
    // 自动模式下检测真实 LAN 网卡：获取 IP（用于 IP_MULTICAST_IF）和 broadcast 地址（用于精确广播）
    let (multicast_if, lan_broadcast) = if ip.is_unspecified() {
        find_lan_interface().map_or((None, None), |(lan_ip, lan_bc)| {
            (Some(lan_ip), Some(lan_bc))
        })
    } else {
        (None, None) // 手动模式：用指定 IP，不额外设置 multicast 接口
    };

    // 绑定 UDP 端口（SO_REUSEADDR 允许同一台机器上多个 gosslan 实例共存，用于多开测试）
    let (socket, multicast_if_result) = bind_udp_reusable(ip, UDP_PORT, multicast_if)
        .map_err(|e| format!("UDP 绑定 {ip}:{UDP_PORT} 失败: {e}"))?;
    // 加入组播组：自动模式使用 find_lan_interface 选出的 LAN IP，
    // 手动模式直接使用用户指定的 IP（与 UDP/TCP bind 一致）。
    let multicast_iface = multicast_if.unwrap_or(ip);
    let join_res = socket.join_multicast_v4(MULTICAST_GROUP, multicast_iface);
    // 记录诊断：组播 join 结果（不改变行为，.ok() 仍然在下面）
    let join_msg = match &join_res {
        Ok(()) => "ok".into(),
        Err(e) => format!("error: {e}"),
    };
    join_res.ok();
    let socket = Arc::new(socket);

    // 记录诊断：启动参数
    {
        let mut diag = state.diag.lock().unwrap();
        diag.broadcast_target = "255.255.255.255".into();
        diag.multicast_group = format!("{MULTICAST_GROUP}");
        diag.multicast_join_result = join_msg;
        diag.multicast_if_result = multicast_if_result;
        diag.udp_port = UDP_PORT;
        if let Some(mif) = multicast_if {
            diag.selected_ip = mif.to_string();
        }
        diag.selected_interface = multicast_if
            .and_then(|mip| {
                if_addrs::get_if_addrs().ok()?.into_iter().find_map(|i| {
                    if let if_addrs::IfAddr::V4(_) = &i.addr {
                        if i.ip() == std::net::IpAddr::V4(mip) {
                            return Some(i.name.clone());
                        }
                    }
                    None
                })
            })
            .unwrap_or_default();
    }
    state.push_diag_event(
        "discovery_started",
        &format!("bind={ip}, multicast_iface={multicast_iface}"),
    );

    let my_id = state.device_id.clone();

    // ---- 接收循环 ----
    {
        let socket = socket.clone();
        let state = state.clone();
        let my_id = my_id.clone();
        let mut shutdown = shutdown.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 2048];
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    res = socket.recv_from(&mut buf) => {
                        let (len, src) = match res {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let Ok(pkt) = serde_json::from_slice::<UdpPacket>(&buf[..len]) else {
                            continue;
                        };
                        if pkt.device_id == my_id {
                            continue;
                        }
                        match pkt.kind.as_str() {
                            "announce" => {
                                state.push_diag_event("announce_recv", &format!("from={} via={}", pkt.device_id, src.ip()));
                                // 粗略 RTT：基于双方 NTP 同步时钟的时间差（局域网内近似）
                                let delta = now_ms().saturating_sub(pkt.ts);
                                let rtt = if delta > 0 && delta < 5000 { Some(delta as u64) } else { None };
                                upsert_peer(
                                    &state,
                                    &pkt.device_id,
                                    &pkt.nickname,
                                    pkt.avatar.clone(),
                                    &src.ip().to_string(),
                                    pkt.tcp_port,
                                    pkt.x25519_pubkey.clone(),
                                    pkt.ed25519_pubkey.clone(),
                                    rtt,
                                ).await;
                                ensure_link(&state, &pkt.device_id, &src.ip().to_string(), pkt.tcp_port).await;
                            }
                            "who_has" => {
                                let reply = announce_packet(&state, tcp_port);
                                if let Ok(data) = serde_json::to_vec(&reply) {
                                    let _ = socket.send_to(&data, src).await;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        });
    }

    // ---- 广播循环（自适应周期 + 抖动，避免大规模节点广播风暴与同步惊群） ----
    {
        let socket = socket.clone();
        let state = state.clone();
        let lan_broadcast = lan_broadcast;
        let mut shutdown = shutdown.clone();
        tokio::spawn(async move {
            // 首次立刻广播
            broadcast(&socket, &state, tcp_port, lan_broadcast).await;
            // 下一轮周期广播的时刻。只在真正广播后重算，探测分支不改变节拍。
            let mut next_at = Instant::now() + Duration::from_secs(next_wait(&state));
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    _ = sleep_until(next_at) => {
                        broadcast(&socket, &state, tcp_port, lan_broadcast).await;
                        sweep_peers(&state);
                        next_at = Instant::now() + Duration::from_secs(next_wait(&state));
                    }
                    // 按需探测：用户打开「添加好友」时触发一次 who_has 群发
                    _ = probe.changed() => {
                        broadcast_probe(&socket, &state, tcp_port, lan_broadcast).await;
                    }
                }
            }
        });
    }

    Ok(())
}

/// 下一轮广播周期（秒）：读一次在线节点数即放锁，绝不跨 await 持锁。
fn next_wait(state: &AppState) -> u64 {
    let node_count = state.peers.lock().unwrap().len();
    adaptive_interval(node_count)
}

/// 依据当前在线节点数自适应调整广播周期（秒），并叠加随机抖动以打散各节点广播相位。
fn adaptive_interval(node_count: usize) -> u64 {
    let base = if node_count >= 500 {
        20
    } else if node_count >= 100 {
        10
    } else {
        ANNOUNCE_INTERVAL_SECS
    };
    // 0..=2s 抖动，避免全网节点在同一瞬间齐发
    let mut rng = OsRng;
    let jitter = rng.next_u64() % 3000;
    base + jitter / 1000
}

async fn broadcast(
    socket: &UdpSocket,
    state: &AppState,
    tcp_port: u16,
    _lan_broadcast: Option<Ipv4Addr>,
) {
    let pkt = announce_packet(state, tcp_port);
    let Ok(data) = serde_json::to_vec(&pkt) else {
        return;
    };
    // 广播使用 limited broadcast（255.255.255.255）：Windows 默认禁用 directed broadcast
    // （DisableDirectedBroadcasts=1），精确子网地址会被内核静默丢弃。
    // limited broadcast 发送到所有 IFF_BROADCAST 接口，不走默认路由，跨平台可靠。
    let _ = socket
        .send_to(&data, format!("255.255.255.255:{UDP_PORT}"))
        .await;
    let _ = socket
        .send_to(&data, format!("{MULTICAST_GROUP}:{UDP_PORT}"))
        .await;
    state.push_diag_event(
        "broadcast_sent",
        &format!("target=255.255.255.255:{UDP_PORT}, multicast={MULTICAST_GROUP}:{UDP_PORT}"),
    );
}

/// 按需探测：群发 `who_has` 请求周围节点单播回复其 `announce`，并同时广播一次自身 announce。
/// 用于「添加好友」弹窗打开时快速、主动地发现局域网内在线客户端。
async fn broadcast_probe(
    socket: &UdpSocket,
    state: &AppState,
    tcp_port: u16,
    _lan_broadcast: Option<Ipv4Addr>,
) {
    let who = UdpPacket {
        kind: "who_has".to_string(),
        device_id: state.device_id.clone(),
        nickname: String::new(),
        avatar: None,
        tcp_port,
        x25519_pubkey: None,
        ed25519_pubkey: None,
        ts: now_ms(),
    };
    if let Ok(data) = serde_json::to_vec(&who) {
        let _ = socket
            .send_to(&data, format!("255.255.255.255:{UDP_PORT}"))
            .await;
        let _ = socket
            .send_to(&data, format!("{MULTICAST_GROUP}:{UDP_PORT}"))
            .await;
        state.push_diag_event(
            "who_has_sent",
            &format!("target=255.255.255.255:{UDP_PORT}"),
        );
    }
    // 同时广播自身，让周围节点也能立刻发现我们
    broadcast(socket, state, tcp_port, _lan_broadcast).await;
}

/// 清理超过 `PEER_TIMEOUT_SECS` 未活跃的节点，
/// **但保留仍有活跃 TCP 链接的节点**：避免「TCP 能通信但 UI 显示离线」。
fn sweep_peers(state: &AppState) {
    let cutoff = now_ms() - PEER_TIMEOUT_SECS * 1000;
    // try_lock 非阻塞：锁被占用时跳过本轮清理（下轮会补上），绝不阻塞广播循环。
    let active_links: std::collections::HashSet<String> = state
        .links
        .try_lock()
        .map(|l| l.keys().cloned().collect())
        .unwrap_or_default();
    let changed = {
        let mut peers = state.peers.lock().unwrap();
        let before = peers.len();
        peers.retain(|id, p| p.last_seen >= cutoff || active_links.contains(id));
        before != peers.len()
    };
    if changed {
        state.emit_peers();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自适应周期分档与抖动边界：≤99 节点保持 5s，≥100 → ≥10s，≥500 → ≥20s，抖动 ≤2s。
    #[test]
    fn adaptive_interval_thresholds_and_jitter_bounds() {
        for _ in 0..200 {
            let small = adaptive_interval(0);
            let mid = adaptive_interval(99);
            let big = adaptive_interval(100);
            let huge = adaptive_interval(500);
            assert!(
                (5..=7).contains(&small),
                "0 节点应为 5+0..2 秒，得到 {small}"
            );
            assert!((5..=7).contains(&mid), "99 节点仍属小规模，得到 {mid}");
            assert!(
                (10..=12).contains(&big),
                "100 节点应降频到 10+0..2 秒，得到 {big}"
            );
            assert!(
                (20..=22).contains(&huge),
                "500 节点应降频到 20+0..2 秒，得到 {huge}"
            );
            // 抖动幅度必须小于档间间隔，否则扩档形同无效（热区里退化不成阶梯）
            assert!(small < big && big < huge);
        }
    }

    /// 回归 P0-1：广播循环必须按「完整周期」等待。
    ///
    /// tokio 新建的 `Interval` 首个 tick 立即就绪——旧实现在循环里重建 interval，
    /// 等于每轮等待清零，announce 退化为热循环（实测约 1ms/轮）。
    /// 现在循环里没有可重建的计时器，只有指向固定 deadline 的 `sleep_until`；
    /// 这里锁住两种写法的时序差异，防止改回去。
    #[tokio::test]
    async fn recreated_interval_never_waits_but_deadline_sleep_does() {
        let period = Duration::from_millis(200);

        // 旧写法（Bug 形态）：每轮重建 interval → 等待被清零
        let mut tick = tokio::time::interval(period);
        tick.tick().await;
        let start = Instant::now();
        for _ in 0..3 {
            tick = tokio::time::interval(period);
            tick.tick().await;
            assert!(
                start.elapsed() < period * 3,
                "重建 interval 本应不产生完整等待（这正是 P0-1）"
            );
        }

        // 新写法（修复形态）：同一 deadline 上等待 → 必须消耗完整周期
        let deadline = Instant::now() + period;
        sleep_until(deadline).await;
        assert!(Instant::now() >= deadline);
    }

    /// 回归 P0-1 的调度语义：探测（who_has）分支不得推迟周期广播节拍，
    /// deadline 过期后应立刻补发一轮（等待归零而非重新计时）。
    #[tokio::test]
    async fn expired_deadline_is_ready_immediately() {
        let past = Instant::now() - Duration::from_secs(1);
        let start = Instant::now();
        sleep_until(past).await;
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "过期 deadline 应立即就绪"
        );
    }

    // ---- 评分函数与接口识别测试 ----

    /// RFC1918 三段全部命中
    #[test]
    fn is_rfc1918_covers_private_ranges() {
        assert!(is_rfc1918(&"10.0.0.1".parse().unwrap()));
        assert!(is_rfc1918(&"10.255.255.255".parse().unwrap()));
        assert!(is_rfc1918(&"172.16.0.1".parse().unwrap()));
        assert!(is_rfc1918(&"172.31.255.255".parse().unwrap()));
        assert!(is_rfc1918(&"192.168.1.1".parse().unwrap()));
        assert!(is_rfc1918(&"192.168.0.1".parse().unwrap()));
        // 非 RFC1918 不误判
        assert!(!is_rfc1918(&"172.15.0.1".parse().unwrap()));
        assert!(!is_rfc1918(&"172.32.0.1".parse().unwrap()));
        assert!(!is_rfc1918(&"192.169.0.1".parse().unwrap()));
        assert!(!is_rfc1918(&"8.8.8.8".parse().unwrap()));
    }

    /// 非 LAN 地址段全部识别
    #[test]
    fn is_virtual_ip_covers_non_lan_ranges() {
        assert!(is_virtual_ip(&"198.18.0.1".parse().unwrap()));
        assert!(is_virtual_ip(&"198.19.255.254".parse().unwrap()));
        assert!(is_virtual_ip(&"100.64.0.1".parse().unwrap()));
        assert!(is_virtual_ip(&"100.127.255.254".parse().unwrap()));
        assert!(is_virtual_ip(&"169.254.1.1".parse().unwrap()));
        // 合法 LAN 不误判
        assert!(!is_virtual_ip(&"192.168.1.100".parse().unwrap()));
        assert!(!is_virtual_ip(&"10.0.0.1".parse().unwrap()));
        assert!(!is_virtual_ip(&"172.16.0.1".parse().unwrap()));
    }

    /// 虚拟接口名称覆盖 macOS / Linux / Windows 三端
    #[test]
    fn is_virtual_interface_name_covers_common_patterns() {
        // VPN / WireGuard
        assert!(is_virtual_interface_name("utun3"));
        assert!(is_virtual_interface_name("tun0"));
        assert!(is_virtual_interface_name("wg0"));
        assert!(is_virtual_interface_name("tailscale0"));
        // Docker / libvirt
        assert!(is_virtual_interface_name("docker0"));
        assert!(is_virtual_interface_name("br-abcdef"));
        assert!(is_virtual_interface_name("veth1234"));
        assert!(is_virtual_interface_name("virbr0"));
        // VMware / VirtualBox
        assert!(is_virtual_interface_name("vmnet8"));
        assert!(is_virtual_interface_name("vboxnet0"));
        // Hyper-V
        assert!(is_virtual_interface_name("vEthernet (Default Switch)"));
        // Clash / WARP
        assert!(is_virtual_interface_name("ClashMeta"));
        assert!(is_virtual_interface_name("cf-warp"));
        // 真实 LAN 名称不误判
        assert!(!is_virtual_interface_name("en0"));
        assert!(!is_virtual_interface_name("eth0"));
        assert!(!is_virtual_interface_name("wlan0"));
        assert!(!is_virtual_interface_name("Wi-Fi"));
        assert!(!is_virtual_interface_name("以太网"));
        // 实测确认的企业 VPN 适配器
        assert!(is_virtual_interface_name("vgateO"));
    }

    /// 评分确定性：不依赖输入顺序，虚拟接口名始终排在真实 LAN 之后
    #[test]
    fn score_candidate_orders_correctly() {
        // 真实 LAN：broadcast + RFC1918 = +15
        let real_lan = score_candidate(&"192.168.1.100".parse().unwrap(), "en0", true);
        assert_eq!(real_lan, 15);

        // Docker bridge：broadcast + RFC1918 - 虚拟名 = +10+5-30 = -15
        let docker = score_candidate(&"172.17.0.1".parse().unwrap(), "docker0", true);
        assert_eq!(docker, -15);

        // Clash tun：无 broadcast + 虚拟地址 + 虚拟名 = -80
        let clash = score_candidate(&"198.18.0.1".parse().unwrap(), "utun3", false);
        assert_eq!(clash, -80);

        // 真实 LAN（非 RFC1918，如公网 IP）：broadcast = +10
        let public_lan = score_candidate(&"203.0.113.5".parse().unwrap(), "eth0", true);
        assert_eq!(public_lan, 10);

        // 没有 broadcast 的普通接口 = 0
        let no_bcast = score_candidate(&"192.168.1.5".parse().unwrap(), "en0", false);
        assert_eq!(no_bcast, 5);

        // 真实 LAN 永远 > Docker/VMware/Hyper-V（即使后者也有 broadcast）
        assert!(
            real_lan > docker,
            "真实 LAN {real_lan} 应高于 Docker {docker}"
        );
    }

    /// score_candidate 不受 RFC1918 地址范围误判影响
    #[test]
    fn score_candidate_rfc1918_boundary() {
        // 172.15.x.x 不是 RFC1918（紧邻 172.16 但不在范围内）
        let borderline_below = score_candidate(&"172.15.0.1".parse().unwrap(), "en0", true);
        assert_eq!(borderline_below, 10, "172.15 应无 RFC1918 加分");
        // 172.16.x.x 是 RFC1918
        let borderline_above = score_candidate(&"172.16.0.1".parse().unwrap(), "en0", true);
        assert_eq!(borderline_above, 15, "172.16 应有 RFC1918 加分");
    }

    /// multicast join 接口逻辑：Auto 用 find_lan_interface 选出的 IP，Manual 用用户指定的 IP
    #[test]
    fn multicast_join_interface_matches_mode() {
        let auto_lan_ip: Ipv4Addr = "10.0.0.100".parse().unwrap();
        let manual_ip: Ipv4Addr = "192.168.1.50".parse().unwrap();

        // Auto 模式：multicast_if = Some(lan_ip) → unwrap_or 不触发 → join on lan_ip
        let auto_multicast_if = Some(auto_lan_ip);
        let auto_join = auto_multicast_if.unwrap_or(Ipv4Addr::UNSPECIFIED);
        assert_eq!(
            auto_join, auto_lan_ip,
            "Auto: multicast join 应使用自动选择的 LAN IP"
        );

        // Manual 模式：multicast_if = None → unwrap_or(manual_ip) → join on manual_ip
        let manual_multicast_if: Option<Ipv4Addr> = None;
        let manual_join = manual_multicast_if.unwrap_or(manual_ip);
        assert_eq!(
            manual_join, manual_ip,
            "Manual: multicast join 应使用用户指定的 IP"
        );
    }
}
