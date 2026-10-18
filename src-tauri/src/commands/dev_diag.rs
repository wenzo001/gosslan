// 职责边界：
// - 开发诊断面板只读查询（状态快照、传输进度、peer 列表）
// - 只提供 get_* 查询，不做任何状态变更
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
        backoff.sort_by_key(|a| std::cmp::Reverse(a.remaining_ms));
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

/// 收集「版本互通」事实：本机版本 + 各对端在 Hello 里声明的版本。
///
/// 为什么值得单独一格：跨版本互通的故障以前只能靠"猜谁老"——`忽略未知帧类型` 那条日志
/// 说明对端比本机新，但没人知道是哪台、什么版本（INV-P24 要求"对端更高必须可解释"）。
/// 昵称现查 `peers`（面板要说"现在这是谁"，而版本表记的是 Hello 那一刻）。
fn collect_peer_versions(s: &Arc<AppState>) -> Vec<crate::state::PeerVersionDiag> {
    let declared: Vec<(String, crate::state::PeerVersion)> = s
        .peer_versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, v)| (id.clone(), v.clone()))
        .collect();
    let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<crate::state::PeerVersionDiag> = declared
        .into_iter()
        .map(|(id, v)| crate::state::PeerVersionDiag {
            nickname: peers.get(&id).map(|p| p.nickname.clone()).unwrap_or_default(),
            device_id: id,
            protocol_version: v.protocol_version,
            app_version: v.app_version,
        })
        .collect();
    out.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    out
}

/// 把若干条连接的健康度折成诊断行（纯函数，`collect_conn_health` 只负责取锁与喂数据）。
///
/// 抽出来的原因不是复用，是**可判**：真实链路的"只有写出、从没读到"这一格在生产里要靠
/// 半开 TCP 才能造出来，而这一格恰恰是那两个数字的全部区别所在 ⇒ 纯函数可以当场钉死。
pub(crate) fn conn_health_rows(
    conns: &[&crate::mesh::Connection],
    now: i64,
    health_timeout_ms: i64,
    max_failures: u32,
) -> Vec<crate::state::ConnHealthDiag> {
    let mut rows: Vec<crate::state::ConnHealthDiag> = conns
        .iter()
        .map(|c| crate::state::ConnHealthDiag {
            device_id: c.peer_id.clone(),
            conn_id: c.id.clone(),
            endpoint: c.endpoint.to_string(),
            path_kind: c.path_kind.as_str().to_string(),
            last_write_seen_ms: c.health.last_write_seen_ms,
            last_read_seen_ms: c.health.last_read_seen_ms,
            write_age_ms: c.health.last_write_seen_ms.map(|t| now - t),
            read_age_ms: c.health.last_read_seen_ms.map(|t| now - t),
            // 健康结论与选路/看门狗**同一个判据、同一份阈值**，否则面板会说谎。
            healthy: c
                .health
                .is_healthy(now, health_timeout_ms, max_failures),
            consecutive_failures: c.health.consecutive_failures,
        })
        .collect();
    // 行序必须稳定：同一 peer 的多条连接之间按端点排，两轮读数才能逐行对齐
    //（不然"哪条坏了"又得靠眼睛在两屏里找同一条）。
    rows.sort_by(|a, b| (&a.device_id, &a.endpoint).cmp(&(&b.device_id, &b.endpoint)));
    rows
}

/// 收集「每条连接最后一次读到一个完整帧 / 最后一次写出成功」的活性读数（纯只读，不改任何状态）。
///
/// 为什么非开这一格不可：这两个时间戳今天就**有人写**（`reader_loop` 解出一整帧记一次、
/// `writer_loop` 写成功记一次），而 `last_write_seen_ms` 在应用内**一个读者都没有**。
/// 于是"回执到底没离开对端 socket"与"回执上路了但我这边没读到"两种现场，在日志里长得一模一样
/// （2026-10-17 那轮 J2 就是被这一格挡住读不下去）。
///
/// ⚠️ 三个不许混淆的口径，面板上按字面写：
/// · **写出成功**（`last_write_seen_ms`）：半开 TCP 上它会一直前进，所以它不是"对端活着"的证据；
/// · **读到并解析出一个完整帧**（`last_read_seen_ms`）：读循环是 `read_frame` 一次拿一整帧 ⇒
///   现有状态量的是"成帧"，**字节级读到**没有第三个读数，别把这两个数当一个用；
/// · **派发完成**：没有读数（只有 ≥3 s 的队头阻塞留痕），所以这一格只能答"帧到没到"，
///   答不了"到了之后有没有进对的处理分支"。
/// `None` 表示这条连接建立以来那件事**从没发生过**（不是 0 —— 0 会被读成"很久以前"）。
///
/// 按**连接**出行而不是按 peer：同一对节点之间可以同时挂着多条 socket，而"整段没帧"这一类
/// 故障实测是逐连接发生的（一个 peer 的两条连接里只有一条被判死）⇒ 聚合成 peer 会把坏的那条盖掉。
///
/// 锁只在取快照那几行的作用域内持有（本命令是同步的，不存在跨 await 持锁）。
fn collect_conn_health(s: &Arc<AppState>) -> Vec<crate::state::ConnHealthDiag> {
    let now = db::now_ms();
    {
        let pm = s.peer_manager.lock().unwrap_or_else(|e| e.into_inner());
        let (health_timeout_ms, max_failures) = (pm.health_timeout_ms(), pm.max_failures());
        let conns: Vec<&crate::mesh::Connection> =
            pm.peers().flat_map(|p| p.connections()).collect();
        conn_health_rows(&conns, now, health_timeout_ms, max_failures)
    }
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
    // 版本互通：每次现取（本机版本是编译期常量，对端版本随 Hello 变），不留默认值 ——
    // `DiscoveryDiag::default()` 里 protocol_version 是 0，那是"还没采过"而不是"版本 0"。
    result.protocol_version = crate::protocol::PROTOCOL_VERSION;
    result.app_version = crate::protocol::current_app_version().to_string();
    result.peer_versions = collect_peer_versions(s);
    // 按连接的收发活性：现取，不缓存 —— 这一格存在的意义就是"此刻还在不在动"，
    // 留一份旧快照就等于把它变成第二条日志。
    result.conn_health = collect_conn_health(s);
    result
}
