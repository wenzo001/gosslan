//! 网络层：UDP 广播发现 + TCP 消息/文件传输。
//!
//! 传输抽象说明：
//! - 当前实现基于 TCP（简单可靠），帧格式见 `protocol.rs`。
//! - 未来可无缝切换/新增 QUIC（如 `quinn`）或 WebSocket 中继：只要实现
//!   “分帧写入/读取 + 建立连接”两个原语，`try_send` 与消息分发逻辑无需改动，
//!   即可支撑“服务端中转连接电脑与移动端”的场景。

/// BLE 传输的运行时接线（feature = "bluetooth"；默认关闭，见 ADR-0015）。
#[cfg(feature = "bluetooth")]
pub mod ble;
pub mod discovery;
pub mod dispatch;
pub mod file;
/// 群历史同步引擎（2026-10-16 需求：新成员自动拿到群里的聊天与群任务）。
/// 普通 `mod`（不是 `include!` 分册）⇒ 不进 `transport_src_for_guards()` 那三份
/// "生产码全集"视图；以全集为判据的形状守卫本来也不管这一册。
pub mod group_history;
pub mod transport;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::state::{AppState, NetworkHandle};

/// 启动网络（UDP 发现 + TCP 服务）。
/// `bind_ip` 为选定的网卡 IPv4 地址，或 "0.0.0.0" 表示自动（监听所有网卡）。
pub async fn start(state: Arc<AppState>, bind_ip: String) -> Result<(), String> {
    // 先停掉旧实例
    stop(&state).await;

    let ip: std::net::Ipv4Addr = bind_ip
        .parse()
        .map_err(|_| format!("无效的网卡地址: {bind_ip}"))?;
    let tcp_port = state.tcp_port;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (probe_tx, probe_rx) = watch::channel(0u64);

    // 启动顺序：**先 TCP 监听，再 UDP 发现**。
    //
    // 旧顺序（先 discovery 后 transport）在 TCP bind 失败时会留下一个半启动状态：
    // discovery 已经跑起来并广播过一轮，随后 `transport::spawn` 返回 Err，
    // `start()` 提前返回把局部 `shutdown_tx` drop 掉，discovery 任务的
    // `shutdown.changed()` 立刻返回 Err 而退出 —— UDP 被 TCP 的失败「陪葬」。
    // 结果是本机既没有监听也没有 announce，对端连发现都做不到，且日志里看不出
    // 曾经发生过什么。先 transport 可以保证：bind 失败时 discovery 从未启动，
    // 失败状态是干净的。
    let tasks = start_in_order(
        &shutdown_tx,
        Box::pin(transport::spawn(
            state.clone(),
            ip,
            tcp_port,
            shutdown_rx.clone(),
        )),
        Box::pin(discovery::spawn(
            state.clone(),
            ip,
            tcp_port,
            shutdown_rx.clone(), // clone 一份留给 sweeper（下一个 discovery::spawn 会 move 原始值）
            probe_rx,
        )),
    )
    .await?;

    // Discovery 实际绑定的是真实 LAN IP（auto 模式下），需要让诊断面板展示它。
    let actual_bound_ip = state
        .diag
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .bound_ip
        .clone();
    *state.probe.lock().unwrap_or_else(|e| e.into_inner()) = Some(probe_tx);
    // 进入新世代：此后旧世代（上一次 start 的 accept 任务）不得再登记链路。
    state.bump_network_generation();
    *state.network.lock().unwrap_or_else(|e| e.into_inner()) = Some(NetworkHandle {
        shutdown: shutdown_tx.clone(),
        bound_ip: bind_ip,
        actual_bound_ip,
        tcp_port,
        tasks,
    });

    // Outbox 超时清扫：独立于 transport/discovery 的后台任务，
    // 每 30s 扫一次 outbox，把 created_at > 120s 无 Ack 的消息置 failed。
    // 必须在 NetworkHandle 创建之后 spawn — JoinHandle 要 push 进 tasks。
    // README 承诺的「自动缓存清理」接线（2026-09-19 审计：此前只有设置页手动按钮）。
    // 不进 tasks：它是 to_infinity 的周期任务，随进程退出自然结束。
    crate::commands::spawn_cache_auto_clean(&state);
    let sweeper = transport::spawn_outbox_sweeper(state.clone(), shutdown_rx);
    if let Some(handle) = state
        .network
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
    {
        handle.tasks.push(sweeper);
    }

    Ok(())
}

/// 停止网络：发送关闭信号，**等待后台任务真正退出**，再清理连接与在线表。
pub async fn stop(state: &AppState) {
    // 先进入新世代：让"握手还没完成的上一个世代的任务"在登记前就自我否决
    // （见 `AppState::network_generation` 的注释）。
    state.bump_network_generation();
    // 先取出句柄再 await：`std::sync::MutexGuard` 不能跨 await，否则 stop() 的
    // future 不是 Send，无法放进 `tauri::async_runtime::spawn`。
    let handle = state
        .network
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(handle) = handle {
        let _ = handle.shutdown.send(true);
        // 必须等：旧的 TCP listener 只有 accept 任务退出后才真正释放。
        // 不等就继续走（同进程切换网卡 / 重新开启通道，或 `app.restart()`
        // 起来的新进程）都可能撞上 AddrInUse，Windows 上表现为重启后永久掉线。
        await_tasks(handle.tasks, Some(&state.logger)).await;
    }
    *state.probe.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.links.lock().await.clear();
    state
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    state.emit_peers();
}

/// 子系统的启动 future（`transport::spawn` / `discovery::spawn`）。
type SpawnFut = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<tokio::task::JoinHandle<()>>, String>> + Send>,
>;

/// 启动编排：**只有 TCP 监听成功，才启动 UDP 发现**。
///
/// 单独抽成函数的唯一目的，是让「TCP bind 失败 ⇒ discovery 从未被 poll」这条 P0
/// 不变量可以在单测里验证：`start()` 需要 `AppState`，而它必须由真实 Tauri
/// `AppHandle` 构造，单测中造不出来。
///
/// `discovery` 是一个**尚未被 poll 的** future：`async fn` 在被调用时并不执行
/// 函数体，所以 transport 失败时它会被整个丢弃，UDP 一次都不会启动。
pub(crate) async fn start_in_order(
    shutdown: &watch::Sender<bool>,
    transport: SpawnFut,
    discovery: SpawnFut,
) -> Result<Vec<tokio::task::JoinHandle<()>>, String> {
    let mut tasks = transport.await?;
    match discovery.await {
        Ok(t) => {
            tasks.extend(t);
            Ok(tasks)
        }
        Err(e) => {
            // 收回已经启动的 transport，再向上报错，绝不留下半启动状态
            let _ = shutdown.send(true);
            await_tasks(tasks, None).await;
            Err(e)
        }
    }
}

/// 后台任务退出等待上限。
///
/// 正常路径上任务收到 shutdown 后是毫秒级退出的；这个上限只是防止个别卡住的
/// 任务把 stop()（进而把 `app.restart()` / 退出流程）永久阻塞。
const STOP_TASK_TIMEOUT: Duration = Duration::from_secs(2);

/// 依次等待后台任务结束，最长 [`STOP_TASK_TIMEOUT`]；超时即打日志放行。
///
/// `logger` 是 `Option`：`stop()` 有 `AppState` 拿得到日志器，而 `start_in_order()`
/// 的失败分支只有 future —— 那一条的失败原因本来就要作为 `Err(String)` 报给上层，
/// 再塞一个日志器进来只会多一条没人看的通道。
///
/// 为什么 `JoinError` 不许再被 `let _ =` 丢掉：release 开着 `panic = "abort"`，
/// 任务里 panic 会连进程一起带走 ⇒ 这里能收到的 `Err` 只剩**被取消/被 abort/执行器关停**
/// 这三类。它们恰好是"界面照常、网络却不再推进"那类故障的唯一物证，丢掉就等于丢掉线索。
async fn await_tasks(
    tasks: Vec<tokio::task::JoinHandle<()>>,
    logger: Option<&crate::logging::Logger>,
) {
    if tasks.is_empty() {
        return;
    }
    // 计数器要被 async 块**移走**，所以放 Arc 里，超时那一支才读得到。
    let failed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let failed_in = failed.clone();
    let joined = async move {
        for t in tasks {
            if let Err(e) = t.await {
                failed_in.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if let Some(lg) = logger {
                    lg.warn("net_task", format!("后台网络任务未正常收尾: {e}"));
                }
            }
        }
    };
    if tokio::time::timeout(STOP_TASK_TIMEOUT, joined)
        .await
        .is_err()
    {
        let n = failed.load(std::sync::atomic::Ordering::Relaxed);
        if let Some(lg) = logger {
            lg.warn(
                "net_task",
                format!(
                    "等待网络后台任务退出超时（{}s），强制继续；已报失败的有 {n} 个",
                    STOP_TASK_TIMEOUT.as_secs()
                ),
            );
        } else {
            eprintln!(
                "[lan] 等待网络后台任务退出超时（{}s），强制继续",
                STOP_TASK_TIMEOUT.as_secs()
            );
        }
    }
}

/// 默认绑定地址：自动（监听所有网卡）。
const AUTO_BIND_IP: &str = "0.0.0.0";

/// 按本地偏好开启局域网通道（开机自动开启与设置页开关共用同一条路径）。
///
/// 绑定地址沿用用户已选网卡（`settings.bind_ip`）——自动开启不得改写用户的选择；
/// 只有该网卡已不存在（换了网络）时才回落到自动选择，
/// 否则「默认开启」会比手动开启更脆弱：绑定失败后通道静默不在线。
pub async fn start_from_prefs(state: Arc<AppState>) -> Result<(), String> {
    let bind_ip = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::db::get_setting(&dbc, "bind_ip").unwrap_or_else(|| AUTO_BIND_IP.to_string())
    };
    match start(state.clone(), bind_ip.clone()).await {
        Ok(()) => Ok(()),
        Err(e) if bind_ip != AUTO_BIND_IP => {
            state.logger.warn(
                "lan",
                format!("绑定 {bind_ip} 失败（{e}），回落到自动选择网卡"),
            );
            start(state, AUTO_BIND_IP.to_string()).await
        }
        Err(e) => Err(e),
    }
}

/// 自动开启失败后**下一轮**的间隔（纯函数，便于单测）：5s → 10s → 20s → 30s 封顶。
///
/// 为什么必须有重试这条出口（2026-10-15 全链路审计，`lib.rs` 那份旧写法只试一次）：
/// `start()` 会在两类"这一刻本机还没准备好"的情形下失败 ——
/// ① auto 模式 `find_lan_interface()` 找不到可用网卡（开机自启跑在 DHCP 拿到地址之前，
///    精简过的 Windows 镜像上驱动/服务起得更晚，这条尤其容易命中）；
/// ② 发现用的 UDP 套接字 bind 或 `join_multicast_v4` 失败（接口刚起来还没就绪）。
/// 两类都会在几十秒内自己变好，但旧写法失败后**本进程再也不会尝试联网**：日志里只有
/// 一句"自动开启局域网通道失败"，之后既没有监听也没有 announce，对端也找不到本机 ⇒
/// 唯一出路是重启应用。两台机器同时冷启动时就成了"要双方都重启才恢复"。
///
/// 这不是"加超时/加重试次数掩盖问题"：这一格缺的是**恢复路径本身**（代码里此前没有任何
/// 第二次尝试），而失败原因与错误文本都还在日志里。
pub(crate) fn lan_autostart_delay(attempt: u32) -> Duration {
    let secs = match attempt.saturating_sub(1) {
        0 => 5,
        1 => 10,
        2 => 20,
        _ => 30,
    };
    Duration::from_secs(secs)
}

/// 下一轮还要不要再试（纯函数）：
/// - 通道已经起来 ⇒ 收手（也包括用户自己在设置页打开的那次 ⇒ 不去打断它）；
/// - 库里写着"关" ⇒ 收手，**不得替用户联网**（`lib.rs` 那段 2026-09-27 的历史同一条规矩）。
pub(crate) fn should_keep_retrying_lan_autostart(running: bool, enabled: bool) -> bool {
    !running && enabled
}

/// **只给源码守卫用**：`network/transport.rs` 已按 `commands.rs` 的先例分册
/// （`include!` 进同一模块，运行时零差异），而守卫是用 `include_str!` 读**文件文本**的。
/// 只读主文件会让搬进分册的代码 0 命中 ⇒ 守卫假红，而下一个人会以为红的是代码不是锚点。
/// 所以守卫一律看全集；新增分册时必须在这里同步登记一行。
#[cfg(test)]
pub(crate) fn transport_src_for_guards() -> String {
    let mut src = String::new();
    src.push_str(include_str!("transport.rs"));
    src.push('\n');
    src.push_str(include_str!("transport/outbound.rs"));
    src.push('\n');
    src.push_str(include_str!("transport/gossip.rs"));
    // `transport/relay.rs` 也是同一模块的分册（`transport.rs:50` 的 `include!`）。
    // 2026-09-22 补登记：4.25.0 接线时只把它记进了 `docs/domains.data.mjs`，漏了这里 ⇒
    // 所有以"transport 全集"为判据的守卫**看不见拨号器本身**（假绿，不是假红 —— 更危险的那种）。
    src.push('\n');
    src.push_str(include_str!("transport/relay.rs"));
    // `transport/tests.rs` **刻意不并进视图**：视图是生产码全集，掺进测试字面量会让
    // 以它为判据的守卫多看见一堆字符串常量（本文件上面 commands/db 那段注释写的同一条规矩）。
    // 2026-10-06 实测：分册把 writer_loop / reader_loop 搬出主文件后，视图里先撞上
    // tests.rs 中的 `"async fn reader_loop("` 字面量，窗口飘到测试文本上 ⇒ 4 条守卫假红。
    // 2026-10-06 大文件拆分的头四册（`transport.rs` 里对应的四行 `include!`）。
    // 必须登记在这里：所有以"transport 全集"为判据的守卫读的是这份视图，漏一册就是
    // 守卫看不见那段生产码 —— 假绿，比假红危险（relay.rs 在 4.25.0 接线时漏登记过两次）。
    src.push_str(include_str!("transport/pending_keys.rs"));
    src.push_str(include_str!("transport/peer_state.rs"));
    src.push_str(include_str!("transport/member_notices.rs"));
    src.push_str(include_str!("transport/outbox_flush.rs"));
    src.push_str(include_str!("transport/queue_policy.rs"));
    src.push_str(include_str!("transport/link_state.rs"));
    src.push_str(include_str!("transport/relay_file.rs"));
    src.push_str(include_str!("transport/outbox_sweep.rs"));
    src.push_str(include_str!("transport/read_receipt.rs"));
    src.push_str(include_str!("transport/e2ee_payload.rs"));
    src.push_str(include_str!("transport/group_file.rs"));
    src.push_str(include_str!("transport/group_membership.rs"));
    src.push_str(include_str!("transport/peer_registry.rs"));
    src.push_str(include_str!("transport/handshake.rs"));
    src.push_str(include_str!("transport/dial.rs"));
    // `handle_file.rs`：handle_message 拆出的一族分支（2026-10-07）。**必须登记** ——
    // 漏一册就是以「transport 全集」为判据的那些守卫看不见这段生产码（假绿，比假红危险）。
    src.push_str(include_str!("transport/handle_file.rs"));
    // `handle_share.rs`：handle_message 拆出的一族分支（2026-10-07）。**必须登记** ——
    // 漏一册就是以「transport 全集」为判据的那些守卫看不见这段生产码（假绿，比假红危险）。
    src.push_str(include_str!("transport/handle_share.rs"));
    // `handle_group.rs`：handle_message 拆出的一族分支（2026-10-07）。**必须登记** ——
    // 漏一册就是以「transport 全集」为判据的那些守卫看不见这段生产码（假绿，比假红危险）。
    src.push_str(include_str!("transport/handle_group.rs"));
    // `handle_identity.rs`：handle_message 拆出的一族分支（2026-10-07）。**必须登记** ——
    // 漏一册就是以「transport 全集」为判据的那些守卫看不见这段生产码（假绿，比假红危险）。
    src.push_str(include_str!("transport/handle_identity.rs"));
    // `handle_messaging.rs`：handle_message 拆出的一族分支（2026-10-07）。**必须登记** ——
    // 漏一册就是以「transport 全集」为判据的那些守卫看不见这段生产码（假绿，比假红危险）。
    src.push_str(include_str!("transport/handle_messaging.rs"));
    src
}

/// `file` 模块的**生产码全集视图**（与 `transport_src_for_guards()` 同一条规矩）。
///
/// 2026-10-07：`network/file.rs` 从 2,495 行按角色切成五册（发送 / 中继推文件 / 接收 /
/// 群接收 / 共享目录与命名），`include!` 是文本粘贴 ⇒ 模块路径与测试全名一字不变，
/// 但守卫用的 `include_str!` **看不见展开结果** ⇒ 必须在这里再登记一份清单。
///
/// ⚠️ 漏一册的后果不是报错而是**假绿**：以「file 全集」为判据的形状守卫看不见那段生产码。
/// 这条不由人记着 —— `lib_source_view_tests.rs` 的登记对账守卫（第四个用例）每个视图都钉两侧，
/// 少登记多登记都会红。
/// `file_tests.rs` 刻意不进视图：它是测试文本，并进来会让生产模式扫描多看见一堆字符串常量。
#[cfg(test)]
pub(crate) fn file_src_for_guards() -> String {
    let mut src = String::new();
    src.push_str(include_str!("file.rs"));
    src.push('\n');
    src.push_str(include_str!("file/send.rs"));
    src.push('\n');
    src.push_str(include_str!("file/relay_push.rs"));
    src.push('\n');
    src.push_str(include_str!("file/receive.rs"));
    src.push('\n');
    src.push_str(include_str!("file/group_receive.rs"));
    src.push('\n');
    src.push_str(include_str!("file/ledger_backfill.rs"));
    src.push('\n');
    src.push_str(include_str!("file/share_walk.rs"));
    src
}

/// `ble` 模块的**生产码全集视图**（与上面两份同一条规矩；`#[cfg(test)]` 是因为只有守卫读它）。
///
/// 2026-10-07：`network/ble.rs` 从 2,392 行按角色切成四册（central 扫描拨号 / 外设 accept /
/// 帧读写抽象 / 读写循环）。`include_str!` 看不见 `include!` 的展开 ⇒ 形状守卫一律读这份视图，
/// 登记对账由 `lib_source_view_tests.rs` 的第五个用例钉两侧。
/// ⚠️ 本模块整体在 `#[cfg(feature = "bluetooth")]` 之后，但**视图不需要那个 feature**：
/// `include_str!` 读的是文本，所以 `lib_ble_tests.rs` 在未开蓝牙的测试构建里也读得到分册内容。
#[cfg(test)]
pub(crate) fn ble_src_for_guards() -> String {
    let mut src = String::new();
    src.push_str(include_str!("ble.rs"));
    src.push('\n');
    src.push_str(include_str!("ble/central.rs"));
    src.push('\n');
    src.push_str(include_str!("ble/peripheral.rs"));
    src.push('\n');
    src.push_str(include_str!("ble/frame_io.rs"));
    src.push('\n');
    src.push_str(include_str!("ble/io_loops.rs"));
    src
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc as StdArc;

    /// Test 3：transport（TCP 监听）失败 ⇒ discovery 这个 future 必须从未被 poll，
    /// 也就是 UDP 一次都不会启动。
    ///
    /// 旧实现反过来（先 discovery 后 transport），TCP bind 失败时 UDP 已经广播过
    /// 一轮，随后被 start() 提前返回带崩，结果是「UDP + TCP 同时静默」，
    /// 对端连发现都做不到 —— 生产 1.0「C 重启后彻底掉线」的放大器。
    #[tokio::test]
    async fn transport_bind_failure_never_starts_discovery() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let discovery_polled = StdArc::new(AtomicBool::new(false));
        let flag = discovery_polled.clone();

        let transport: SpawnFut = Box::pin(async {
            Err("TCP 绑定 0.0.0.0:59992 失败：端口被占用".to_string())
        });
        let discovery: SpawnFut = Box::pin(async move {
            flag.store(true, Ordering::SeqCst);
            Ok(vec![])
        });

        let err = start_in_order(&shutdown_tx, transport, discovery)
            .await
            .expect_err("transport 失败必须向上传播");
        assert!(err.contains("端口被占用"), "错误信息应保留: {err}");
        assert!(
            !discovery_polled.load(Ordering::SeqCst),
            "TCP 绑定失败时 discovery 绝不能被启动（否则 UDP 会被连带陪葬）"
        );
        // 失败路径不应误发 shutdown（没有任务需要停）
        assert!(!*shutdown_rx.borrow_and_update());
    }

    /// 对照：transport 成功时 discovery 必须被启动，且任务句柄合并返回。
    #[tokio::test]
    async fn transport_success_starts_discovery_and_merges_handles() {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let discovery_polled = StdArc::new(AtomicBool::new(false));
        let flag = discovery_polled.clone();

        let transport: SpawnFut = Box::pin(async {
            Ok(vec![tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(5)).await;
            })])
        });
        let discovery: SpawnFut = Box::pin(async move {
            flag.store(true, Ordering::SeqCst);
            Ok(vec![tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(5)).await;
            })])
        });

        let tasks = start_in_order(&shutdown_tx, transport, discovery)
            .await
            .expect("两步都成功时应返回合并后的句柄");
        assert!(discovery_polled.load(Ordering::SeqCst));
        assert_eq!(tasks.len(), 2, "transport + discovery 的任务都要登记");
    }

    /// discovery 失败时必须收回已启动的 transport：发 shutdown 并等它退出。
    #[tokio::test]
    async fn discovery_failure_rolls_back_started_transport() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let stopped = StdArc::new(AtomicBool::new(false));
        let stop_flag = stopped.clone();

        let transport: SpawnFut = Box::pin(async move {
            Ok(vec![tokio::spawn(async move {
                // 模拟 accept 任务：等 shutdown 信号
                let _ = shutdown_rx.changed().await;
                stop_flag.store(true, Ordering::SeqCst);
            })])
        });
        let discovery: SpawnFut = Box::pin(async { Err("UDP 绑定失败".to_string()) });

        let err = start_in_order(&shutdown_tx, transport, discovery)
            .await
            .expect_err("discovery 失败必须向上传播");
        assert!(err.contains("UDP 绑定失败"));
        assert!(
            stopped.load(Ordering::SeqCst),
            "discovery 失败时必须等已启动的 transport 任务退出，不留半启动状态"
        );
    }
}

// 自动开启局域网通道那条重试链的两个纯函数（2026-10-15 全链路审计）。
//
// 为什么钉这两个纯函数而不是端到端：`start()` 要 `AppState`（必须有真实 tauri `AppHandle`，
// 单测造不出来），而这一格真正会错的是**判断**这两件事 ——
// ① 什么时候该停（通道已经起来了 / 用户把开关关了），② 间隔是不是"越试越慢且有上限"。
// 每条都配一反证，避免判据空转。
#[cfg(test)]
mod lan_autostart_tests {
    use super::*;

    #[test]
    fn lan_autostart_backoff_grows_then_caps_at_thirty_seconds() {
        let secs: Vec<u64> = (1..=8)
            .map(|attempt| lan_autostart_delay(attempt).as_secs())
            .collect();
        assert_eq!(
            secs,
            vec![5, 10, 20, 30, 30, 30, 30, 30],
            "退避节奏一变就得同步这里"
        );
        // 反证一：不许越试越快（重试风暴会去抢同一把 bind）
        for w in secs.windows(2) {
            assert!(w[1] >= w[0], "间隔必须单调不减");
        }
        // 反证二：不许没有上限
        assert_eq!(lan_autostart_delay(u32::MAX).as_secs(), 30);
    }

    #[test]
    fn lan_autostart_stops_when_running_or_switched_off() {
        // 通道没起来 + 库里说开 ⇒ 继续试（这一格缺的就是它，旧代码等于永远 false）
        assert!(should_keep_retrying_lan_autostart(false, true));
        // 已经起来 ⇒ 收手（包括别人在重试窗口里手动打开的那次，不许打断）
        assert!(!should_keep_retrying_lan_autostart(true, true));
        // 库里说关 ⇒ 收手，不得替用户联网
        assert!(!should_keep_retrying_lan_autostart(false, false));
        assert!(!should_keep_retrying_lan_autostart(true, false));
    }
}

// `await_tasks` 的失败留痕判据（2026-10-20）。
//
// ⚠️ 单独开一个模块而不是塞进上面的 `mod tests`：`whole_file_slow_work_never_runs_on_an_async_worker`
// 那条分母守卫按**形状**扫整个 `src/`，而它给 `async fn` 定边界用的是"下一个第 0 列 `}`" ——
// `mod tests` 里那几条 `#[tokio::test]` 的体因此一路延伸到 `}` 收册那一行，
// 测试里清理临时目录的 `std::fs::remove_dir_all(` 会被**每个** async 段各数一遍
// （实测一条用例把分母从 18 顶到 26）。这条守卫的判据和阈值都不该为一条测试动，
// 所以这里不用 `async fn`：`#[test]` + 自建 current-thread runtime + `block_on(async { … })`，
// 块不是 `async fn`，量具看不见，用例照跑。
#[cfg(test)]
mod shutdown_tests {
    use super::*;

    /// 后台网络任务失败必须留下痕迹；干净退出的那条**不许**留。
    ///
    /// 为什么单独立一条：`await_tasks` 原先写的是 `let _ = t.await` —— `JoinError` 被原地丢掉，
    /// 而这条 warn 常常是进程收尾前唯一能看出"某个后台任务没好死"的证据。
    /// 只测"有 warn"不够：没有正控（干净任务不产生记录），这条判据在任何实现下都绿。
    #[test]
    fn failed_background_task_leaves_one_named_warning_while_a_clean_one_leaves_none() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime");
        let dir = std::env::temp_dir().join(format!("gosslan-nettask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        rt.block_on(async {
            let logger =
                crate::logging::Logger::new(dir.clone(), "nettask", "[dev:test]".to_string());

            // 正控：正常结束的任务 ⇒ 一条 `net_task` 记录都不许有
            await_tasks(vec![tokio::spawn(async {})], Some(&logger)).await;
            assert_eq!(
                logger
                    .snapshot(None)
                    .iter()
                    .filter(|e| e.target == "net_task")
                    .count(),
                0,
                "干净退出的任务不该产生 net_task 记录"
            );

            // 反例：任务内部 panic ⇒ 必须留下恰好一条具名 warn
            await_tasks(
                vec![tokio::spawn(async {
                    panic!("后台任务模拟失败");
                })],
                Some(&logger),
            )
            .await;
            let hits: Vec<_> = logger
                .snapshot(None)
                .into_iter()
                .filter(|e| e.target == "net_task")
                .collect();
            assert_eq!(
                hits.len(),
                1,
                "失败的后台任务必须留下恰好一条 net_task 记录（实测 {} 条）",
                hits.len()
            );
            assert!(
                hits[0].message.contains("后台网络任务未正常收尾"),
                "记录要报出它是谁、为什么：{}",
                hits[0].message
            );
            assert_eq!(hits[0].level, "warn", "级别必须是 warn");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
