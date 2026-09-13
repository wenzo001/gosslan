//! BLE 传输的**运行时接线**（`feature = "bluetooth"`，ADR-0015 的 7-e）。
//!
//! ## 与 TCP 路径的关系
//! BLE 是第三种传输，但**复用**已有的一切：握手（`build_signed_hello` + `verify_hello`）、
//! 身份来源（只能由双向 Hello 验签建立 —— BLE 地址不是身份，架构原则 P-A01）、
//! 链路表与选路（`Endpoint::Ble` + `PathKind::Bluetooth`）、入站/出站去重判据
//! （`link_snapshot` + `should_accept_inbound_public`）、消息处理（`handle_message`）。
//! 这一层只补两件 BLE 专属的事：**扫描/连接**与**分片收发**（后者在
//! `transport::bluetooth::driver` + `transport::ble_framing`）。
//!
//! ## 帧格式：与 TCP 完全相同
//! BLE 上跑的还是 `serde_json` 序列化的 `Message` —— `ble_framing` 负责把整帧切成
//! BLE 分片再拼回来。也就是说**线格式零改动**（没碰 `protocol.rs`），
//! 这也是为什么 BLE 不需要 ADR-0017 那套"能力门控"。
//!
//! ## 默认关闭
//! 本模块整体 `#[cfg(feature = "bluetooth")]`，且即使用 feature 构建，
//! 也要用户在设置里打开「蓝牙」（`bt_enabled`，默认关闭）才会启动 ——
//! 局域网路径在任何情况下都不受影响。
#[cfg(any(target_os = "macos", target_os = "android"))]
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use btleplug::api::Peripheral as _; // `Peripheral::id()` 来自 trait，必须引入
use btleplug::platform::Adapter;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::mesh::{BleEndpoint, Endpoint as MeshEndpoint, PathKind};
use crate::network::transport::{
    build_signed_hello, flush_group_outbox, flush_outbox, flush_pending_group_keys,
    flush_pending_group_reads, flush_pending_reads, handle_message, link_snapshot,
    mark_peer_offline, register_connection, should_accept_inbound_public, unregister_connection,
};
use crate::protocol::Message;
use crate::state::{AppState, Link};
use crate::transport::bluetooth::driver::{self, BleReader, BleWriter};
// 外设角色的驱动按平台切换：macOS 用 CoreBluetooth（objc2），Android 用 JNI 调 Kotlin。
// 两者对外接口**完全同形**（`start` / `PeripheralServer` / `PeripheralWriter` / `PeripheralEvent`），
// 因此下面所有外设逻辑（事件循环、握手、路由、读写循环）两个平台共用一份。
#[cfg(target_os = "macos")]
use crate::transport::bluetooth_peripheral as peripheral;
#[cfg(target_os = "android")]
use crate::transport::ble_android as peripheral;
#[cfg(target_os = "macos")]
use crate::transport::bluetooth_peripheral::{PeripheralEvent, PeripheralWriter};
#[cfg(target_os = "android")]
use crate::transport::ble_android::{PeripheralEvent, PeripheralWriter};

/// 每轮扫描的观察窗口（`btleplug` 的扫描是"持续到显式停止"，给一个窗口再收结果）。
const SCAN_WINDOW: Duration = Duration::from_secs(3);
/// 两轮扫描之间的间隔。10s 与 LAN 的 announce 周期同量级：足够快发现，也不至于耗电。
const SCAN_INTERVAL: Duration = Duration::from_secs(10);
/// 握手（发自己的 Hello → 等对端 Hello）上限。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 读循环的单次等待窗口：到点就回到循环顶部，让 shutdown/cancel 有机会被轮询，
/// 同时顺手回收半截消息。
const READ_IDLE: Duration = Duration::from_millis(1_500);
/// 停止时等待后台任务的上限（与 LAN 的 `STOP_TASK_TIMEOUT` 同口径）。
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// 蓝牙运行时的句柄（放在 `AppState` 里，与 LAN 的 `NetworkHandle` 同思路）。
pub struct BleHandle {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

/// 蓝牙运行时的**真实**状态：`(是否已启动, 已建立 BLE 链路的对端数)`。
///
/// 为什么需要它：`TransportManager::status()` 里那个 `BluetoothTransport` 是"尚未接线"的
/// 占位实现 —— 它的 `running` 恒为 `false`、`peers` 恒为 `0`。界面直接采信它就会永远显示
/// "蓝牙未运行"，用户点了开关也看不到任何变化（用户 2026-09-12 安卓实测的
/// 「蓝牙通道打不开」里，有一部分就是这个假状态造成的误导）。
pub async fn runtime_state(state: &Arc<AppState>) -> (bool, usize) {
    let running = state.ble.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    let peers = {
        let links = state.links.lock().await;
        links
            .values()
            .filter(|ls| ls.iter().any(|l| l.path_kind == PathKind::Bluetooth))
            .count()
    };
    (running, peers)
}

/// 启动蓝牙通道：探测适配器 → 起扫描循环。已在运行时幂等。
pub async fn start(state: Arc<AppState>) -> Result<(), String> {
    {
        let slot = state.ble.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Ok(());
        }
    }
    // 没有适配器 / 用户未授权 ⇒ 明确报错，由上层把通道标为不可用。
    // **绝不能影响局域网**：调用方（`set_channel_enabled`）只在成功时才认为已开启。
    let adapter = driver::adapter().await?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let st = state.clone();
    let task = tokio::spawn(async move { scan_loop(st, adapter, shutdown_rx).await });

    // 外设角色（GATT server）：只做 central 的话，手机**永远连不上** Mac
    // （btleplug 只能主动连，不能被连 —— ADR-0015 §3.1）。这里独立启动、
    // 独立失败：外设起不来只影响"别人连我们"，不该把整个蓝牙开关判死。
    #[cfg(any(target_os = "macos", target_os = "android"))]
    start_peripheral(state.clone(), shutdown_tx.subscribe()).await;

    *state.ble.lock().unwrap_or_else(|e| e.into_inner()) = Some(BleHandle {
        shutdown: shutdown_tx,
        task,
    });
    state.logger.info("ble", "蓝牙通道已启动（每 10s 扫描一次）");
    Ok(())
}

/// 停止蓝牙通道：发停机信号 → 有界等待 → **摘掉所有 BLE 链路**（不动 LAN 链路）。
pub async fn stop(state: &Arc<AppState>) {
    let handle = state.ble.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(handle) = handle {
        let _ = handle.shutdown.send(true);
        if tokio::time::timeout(STOP_TIMEOUT, handle.task).await.is_err() {
            state.logger.warn("ble", "蓝牙后台任务未在 2s 内退出，继续收尾");
        }
    }
    detach_all_ble_links(state).await;
    // "不要再拨"的名单只对本次运行有效：下次开启允许重新学（对端可能换了角色/设备）
    state
        .ble_no_dial
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    state.logger.info("ble", "蓝牙通道已停止");
}

/// 摘掉所有 BLE 链路（只筛 `PathKind::Bluetooth`，LAN/Routed 链路原样保留）。
async fn detach_all_ble_links(state: &Arc<AppState>) {
    // 先收集待处理的 (peer, endpoint)，再逐个拆 —— 避免持有 links 锁时做别的锁操作
    let victims: Vec<(String, MeshEndpoint)> = {
        let links = state.links.lock().await;
        links
            .iter()
            .flat_map(|(peer, list)| {
                list.iter()
                    .filter(|l| l.path_kind == PathKind::Bluetooth)
                    .map(|l| (peer.clone(), l.endpoint.clone()))
            })
            .collect()
    };
    for (peer, ep) in victims {
        teardown_link(state, &peer, &ep).await;
    }
}

/// 拆掉**一条** BLE 链路：取消读写任务 → 从链路表移除 → mesh 侧注销 →
/// 该 peer 若已无任何链路则标记离线。
///
/// 与 TCP 的 `reader_loop` 收尾同口径（"断一条 ≠ peer 下线"）：
/// 同一 peer 可能同时有 LAN 与 BLE 两条链路。
async fn teardown_link(state: &Arc<AppState>, peer_id: &str, ep: &MeshEndpoint) {
    let cancel = {
        let links = state.links.lock().await;
        links
            .get(peer_id)
            .and_then(|v| v.iter().find(|l| &l.endpoint == ep))
            .map(|l| l.cancel.clone())
    };
    if let Some(cancel) = cancel {
        let _ = cancel.send(true);
    }
    let peer_offline = {
        let mut links = state.links.lock().await;
        let mut offline = false;
        if let Some(v) = links.get_mut(peer_id) {
            v.retain(|l| &l.endpoint != ep);
            if v.is_empty() {
                links.remove(peer_id);
                offline = true;
            }
        }
        offline
    };
    unregister_connection(state, peer_id, ep);
    if peer_offline {
        mark_peer_offline(state, peer_id).await;
    }
}

async fn scan_loop(state: Arc<AppState>, adapter: Adapter, mut shutdown: watch::Receiver<bool>) {
    loop {
        match driver::scan_peers(&adapter, SCAN_WINDOW).await {
            Ok((peers, total)) => {
                // 每次扫描都要留痕（**包括 0 个**）：真机上这两个数字是排查的关键 ——
                // "收到 0 个广播"= 扫描/权限/硬件问题；"收到 N 个但 0 个是本服务"= 对端没在广播
                // 或广播里没有我们的服务 UUID。用户 2026-09-12 的"互相搜不到"当时日志里
                // 什么都没有，只能靠猜。
                state.logger.info(
                    "ble",
                    format!(
                        "BLE 扫描：收到 {total} 个广播，其中 {} 个是本应用服务",
                        peers.len()
                    ),
                );
                for peripheral in peers {
                    if *shutdown.borrow() {
                        return;
                    }
                    // 对端是这条链路上的**指定拨号方**（它比我大）⇒ 别去拨它：
                    // 我们拨过去只会被它按镜像规则拒掉，而每次连接都会打断它拨过来的那条
                    // 好链路（真机症状：45s 收不到帧 → 看门狗拆链 → "加好友时连接已关闭"）。
                    if state
                        .ble_no_dial
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .contains(&peripheral.id().to_string())
                    {
                        continue;
                    }
                    // 失败退避：刚连不上的候选先别急着再试（指数退避 5s→60s，见
                    // `ble_dial_backoff_ms` 的注释：旧上限 10 分钟会把暂时性失败变成
                    // 用户可见的"好友申请等了几分钟"）。
                    //
                    // ⚠️ 跳过时**必须留痕**（含剩余毫秒）：否则真机上只能看到
                    // "候选 X 未建立链路"，完全看不出"其实是被退避锁住了"。
                    {
                        let now = crate::db::now_ms();
                        let skip = ble_dial_backoff(&state, &peripheral.id().to_string(), now);
                        if skip {
                            let left = state
                                .ble_dial_failures
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .get(&peripheral.id().to_string())
                                .map(|(_, next)| (*next - now).max(0))
                                .unwrap_or(0);
                            state.logger.info(
                                "ble",
                                format!(
                                    "[DISCOVERY] 跳过候选 id={} 原因=退避中 剩余={left}ms",
                                    peripheral.id()
                                ),
                            );
                            continue;
                        }
                    }
                    let st = state.clone();
                    let sd = shutdown.clone();
                    let dial_id = peripheral.id().to_string();
                    state.logger.info(
                        "ble",
                        format!("[DISCOVERY] 候选可拨 id={dial_id} ⇒ 开始连接（GATT central）"),
                    );
                    // 每个候选一个任务：连接 + 握手最长 10s，串行会把扫描周期拖垮
                    tokio::spawn(async move {
                        let id = peripheral.id().to_string();
                        match dial_and_register(st.clone(), peripheral, sd).await {
                            // 成功 ⇒ 清掉这个候选的失败计数（下次断了还能正常重拨）
                            Ok(()) => clear_ble_dial_failure(&st, &id),
                            // 连接失败是常态（对方正在忙、走远了、不是 Gosslan 端），
                            // 记 info 不记 warn —— 否则日志会被邻居设备刷满
                            Err(e) => {
                                note_ble_dial_failure(&st, &id);
                                st.logger.info(
                                    "ble",
                                    format!("[DISCONNECT] 候选 {id} 未建立链路：{e}（已进入退避）"),
                                );
                            }
                        }
                    });
                }
            }
            Err(e) => state.logger.warn("ble", format!("扫描失败：{e}")),
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = tokio::time::sleep(SCAN_INTERVAL) => {}
        }
    }
}

/// BLE 候选失败退避的**纯函数内核**：连续失败 `failures` 次后，要等多久才允许再试。
///
/// 指数退避：5s → 10s → 20s → 40s → 60s（上限 1 分钟）。
///
/// ## 为什么上限从 10 分钟砍到 1 分钟（2026-09-13 真机）
///
/// 旧值 60s→…→600s（10 分钟）。用户真机实测：**好友申请等了 5～6 分钟才到**。
/// 复盘：BLE 上"连过去被拒"是常态（对端 GATT server 还没起来、镜像链路、对端正忙），
/// 每次失败都把一个**稳定的** BLE 地址推进下一档退避；而"小 id 只接受"那条规则又让
/// **只有一侧会拨**（另一方永远不拨），于是这条唯一的拨号通道被退避锁死到分钟级 ——
/// 一旦恰好卡在 480s/600s 档，好友申请就真的等几分钟。
///
/// 退避的本意是"别每 10s 打扰对端一次"，5s 起步 + 60s 上限已经足够做到这一点
/// （扫描周期本来就是 10s），而 10 分钟的上限只会把**暂时性**失败变成用户可见的故障。
fn ble_dial_backoff_ms(failures: u32) -> i64 {
    const BASE_MS: i64 = 5_000;
    const MAX_MS: i64 = 60_000;
    let shift = failures.saturating_sub(1).min(4);
    (BASE_MS << shift).min(MAX_MS)
}

/// 该候选现在是否处于退避期（true = 跳过）。
fn ble_dial_backoff(state: &Arc<AppState>, id: &str, now: i64) -> bool {
    let map = state
        .ble_dial_failures
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.get(id).is_some_and(|(_, next)| now < *next)
}

/// 记一次失败（连续失败次数 +1，并按指数退避设下次允许时间）。
fn note_ble_dial_failure(state: &Arc<AppState>, id: &str) {
    let mut map = state
        .ble_dial_failures
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entry = map.entry(id.to_string()).or_insert((0, 0));
    entry.0 = entry.0.saturating_add(1);
    entry.1 = crate::db::now_ms() + ble_dial_backoff_ms(entry.0);
}

/// 连上了就清掉失败计数（下次断了还能正常重拨）。
fn clear_ble_dial_failure(state: &Arc<AppState>, id: &str) {
    state
        .ble_dial_failures
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
}

/// **BLE 链路谁拨号**：大 id 拨、小 id 只接受（与 TCP 的 `should_dial` 同一条规则）。
///
/// 抽成纯函数的理由：它是"两端都跑 central+peripheral 时不互相拨号"的**唯一判据**，
/// 而这类缺陷在真机上表现成"链路时好时坏、点加好友说连接已关闭"（镜像链路互相打断），
/// 极难复现；纯函数可以一次钉死，并让护栏在有人把它改成"总是拨"时立刻 FAIL。
#[cfg(any(target_os = "macos", target_os = "android"))]
fn should_dial_ble(my_id: &str, peer_id: &str) -> bool {
    my_id > peer_id
}

/// 往已有链路投递，还是当作**新连接**重新握手（外设侧收到一帧时的唯一判据）。
#[cfg(any(target_os = "macos", target_os = "android"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeripheralRouteAction {
    /// 投给该 central 已登记的链路（正常数据帧）。
    ToExistingLink,
    /// 走握手路径（没有链路，或这是**重连**发来的新 Hello）。
    ToHandshake,
}

/// 判定外设侧收到的一帧该投给旧链路还是重新握手。
///
/// ## 为什么必须有这条判据（2026-09-12 真机）
///
/// BLE 上同一个 central 的地址在**重连**时会被复用（macOS 侧是 CoreBluetooth 给同一台
/// 手机分配的 UUID，Android 侧是同一个 MAC）。旧连接的链路任务可能还没被清理，
/// 于是新连接发来的 **Hello 会被投给旧链路的管道**：
///   · 旧链路的写句柄指向**旧连接** ⇒ 新连接永远收不到 Hello 回应
///     ⇒ 对端报「握手超时：对端未回 Hello」；
///   · 旧链路把这条 Hello 当普通帧消费掉 ⇒ 对端报「对端首帧不是 Hello」。
/// 两种报错在用户侧都是"蓝牙时好时坏、加好友没反应"。
///
/// 所以：**有活路由 + 收到 Hello ⇒ 一定是重连**，必须换路由并重新握手。
/// 其余情况（普通数据帧、或本来就没有路由）都按原来的投递/握手走。
///
/// 抽成纯函数的理由同 `should_dial_ble`：这类判据写反了在真机上极难复现，
/// 而这里可以把它一次钉死，并让护栏在有人改成"永远投旧链路"时立刻 FAIL。
#[cfg(any(target_os = "macos", target_os = "android"))]
fn peripheral_route_action(has_route: bool, frame_is_hello: bool) -> PeripheralRouteAction {
    // 没有活路由 ⇒ 只能握手；有路由且这帧是 Hello ⇒ 一定是重连 ⇒ 也必须握手。
    // 只有「有路由 + 不是 Hello」才是正常的"在已有链路上收数据"。
    if !has_route || frame_is_hello {
        PeripheralRouteAction::ToHandshake
    } else {
        PeripheralRouteAction::ToExistingLink
    }
}

/// 判断一帧**是不是 Hello** 的成本上限（字节）：Hello 只有设备 id + 两个公钥 + 签名，
/// 几百字节量级；超过这个长度的帧不可能是握手首帧，直接跳过解析。
///
/// 为什么要设上限：外设侧会对**每一个**到达的帧做这个判断（见
/// `peripheral_accept_loop`），而大文件分片是 256 KiB —— 对它们做一次
/// `serde_json::from_slice::<Message>` 就是白烧一倍解析成本。
#[cfg(any(target_os = "macos", target_os = "android"))]
const HELLO_PEEK_MAX_BYTES: usize = 1024;

/// 轻量判断：这帧是不是 `Message::Hello`（用于上面的重连判据）。
#[cfg(any(target_os = "macos", target_os = "android"))]
fn frame_is_hello(bytes: &[u8]) -> bool {
    bytes.len() <= HELLO_PEEK_MAX_BYTES
        && matches!(
            serde_json::from_slice::<Message>(bytes),
            Ok(Message::Hello { .. })
        )
}

/// 连接一个候选 → 双向 Hello 验签 → 登记链路 → 起收发循环。
async fn dial_and_register(
    state: Arc<AppState>,
    peripheral: btleplug::platform::Peripheral,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let ble_id = peripheral.id().to_string();
    // ── 在途去重（与 TCP 同款 `DialGuard`）────────────────────────────────
    // 真机证据（2026-09-13）：扫描每 10s 一轮，而握手最长 10s ⇒ 同一个外设上会**叠起
    // 2~3 个拨号任务**，每个都建一条 CoreBluetooth 连接并各自订阅一次通知流。
    // 而 Android 的 GATT server 对同一地址**只保留最后一条连接**，于是通知很可能被投给
    // "已经没人读的那条" ⇒ Mac 侧一个字节都收不到，而安卓侧 `notify` 全部返回成功。
    let Some(_dial_guard) = crate::state::DialGuard::try_acquire(&state, format!("ble:{ble_id}"))
    else {
        state.logger.info(
            "ble",
            format!("[CONNECT] 跳过 {ble_id}：已有在途拨号（避免在同一对端上叠连接）"),
        );
        return Ok(());
    };
    let ep = MeshEndpoint::Ble(BleEndpoint::new(ble_id.clone()));
    // 这个端点已经连着 ⇒ 跳过（`connect_to_peer` 的同款去重）
    if state.has_endpoint_addr(&ep).await {
        return Ok(());
    }
    // 上一次失败可能在 CoreBluetooth 上留了一条**已经没人读**的连接：先断开再重连。
    // 不这么做的话，`connect()` 会直接复用那条旧连接，而新订阅的通知流收不到任何东西。
    if matches!(peripheral.is_connected().await, Ok(true)) {
        state.logger.info(
            "ble",
            format!("[CONNECT] {ble_id} 仍处于已连接状态 ⇒ 先断开，避免复用幽灵连接"),
        );
        let _ = peripheral.disconnect().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let conn = driver::connect(&peripheral).await?;
    state.logger.info(
        "ble",
        format!("[GATT] 已就绪 ep={ble_id}（连接 + 服务发现 + 通知订阅都成功）"),
    );
    // 从这里开始，任何失败都必须**显式断开** —— drop 一个 btleplug `Peripheral`
    // 不会断开 CoreBluetooth 连接，残留会累积成"幽灵连接"（真机症状见上面的注释）。
    match finish_dial(state.clone(), &peripheral, conn, &mut shutdown).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = peripheral.disconnect().await;
            Err(e)
        }
    }
}

/// `dial_and_register` 的握手与登记阶段（拆出来只为让失败路径能统一断开连接）。
async fn finish_dial(
    state: Arc<AppState>,
    peripheral: &btleplug::platform::Peripheral,
    conn: driver::BleConnection,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let ble_id = peripheral.id().to_string();
    let ep = MeshEndpoint::Ble(BleEndpoint::new(ble_id.clone()));
    let (mut writer, mut reader) = conn.into_split();

    // ---- 握手：先发自己的 Hello，再读对端的、并**必须验签**（§8 / ADR-0011）----
    // BLE 地址不是身份，所以这里身份一定是"未知"（conv_clock 传 0 即可：
    // 对端 observe_clock 取 max，不会因此倒退）。
    let hello = build_signed_hello(&state, 0);
    let bytes = serde_json::to_vec(&hello).map_err(|e| format!("Hello 序列化失败：{e}"))?;
    writer.send_frame(&bytes).await?;

    // ⚠️ **允许跳过握手前导帧**（2026-09-13 真机抓到的真因）：
    //    日志里反复出现 `对端首帧不是 Hello（收到 chat_message）` ⇒ 链路**永久建不起来**。
    //    原因是 Android 的 notify 按**central 地址**投递：上一条链路的待发帧（outbox flush）
    //    会落在**新连接**上，于是新连接的"第一帧"是先前的业务帧，而不是 Hello。
    //    旧行为直接放弃 ⇒ 双方各自重拨、互相打断，好友申请/消息全部过期。
    //    新行为：窗口内继续读，丢掉非 Hello 的前导帧（**不处理**——身份还没验签），
    //    读到 Hello 就正常握手；窗口耗尽仍只报错（并说明收到了什么）。
    let first =
        read_hello_frame(&mut reader, HANDSHAKE_TIMEOUT, &mut *shutdown, &state, &ble_id).await?;
    let Message::Hello {
        device_id,
        tcp_port,
        nonce,
        sig,
        x25519_pubkey,
        ed25519_pubkey,
        ..
    } = &first
    else {
        unreachable!("read_hello_frame 只返回 Hello");
    };
    crate::network::transport::verify_hello_for_ble(
        &state,
        device_id,
        *tcp_port,
        nonce,
        x25519_pubkey,
        ed25519_pubkey,
        sig,
    )?;
    let peer_id = device_id.clone();

    // ---- 指定拨号方判据（与 TCP 的 `should_dial` 同一条规则：**大 id 拨，小 id 只接受**）----
    //
    // 两端都同时跑 central + peripheral ⇒ 会互相拨号。若对端 id 比我大，说明它也会拨我：
    // 我拨过去建成的是一条**镜像链路**，它会把这条拒掉（不回 Hello），而这条连接的建立
    // 过程会打断它拨给我的那条好链路 —— 于是好链路 45s 收不到帧被看门狗拆掉、再重来
    // （用户 2026-09-12 实测：「点加好友：发送失败，连接已关闭」）。
    // 所以：记进"不要再拨"，并主动放弃这一条。
    if !should_dial_ble(&state.device_id, &peer_id) {
        state
            .ble_no_dial
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(ble_id.clone());
        state.logger.info(
            "ble",
            format!(
                "对端 {peer_id} 是这条链路的指定拨号方（id 更大）⇒ 记下不再主动拨它，避免镜像链路互扰"
            ),
        );
        // 显式断开：只 return 的话这条连接会挂着，继续占着对端 GATT server 的那个连接槽
        //（对端每次收到我们的新连接都会替换旧连接 ⇒ 正好打断它拨过来的好链路）。
        let _ = peripheral.disconnect().await;
        return Ok(());
    }

    // ---- 去重：与 TCP 入站**同一个判据**（不要在这里复制第二份"有没有同路径连接"）----
    let existing = link_snapshot(&state, &peer_id).await;
    if !should_accept_inbound_public(
        &state.device_id,
        &peer_id,
        PathKind::Bluetooth,
        &existing,
    ) {
        return Err("已有蓝牙链路（或该 peer 链路数已满），不重复建链".to_string());
    }

    // ---- 登记链路（端点 = BLE 标识，路径 = Bluetooth）----
    let (bulk_tx, bulk_rx) = mpsc::channel(1024);
    let (prio_tx, prio_rx) = mpsc::channel(1024);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state
        .links
        .lock()
        .await
        .entry(peer_id.clone())
        .or_default()
        .push(Link {
            endpoint: ep.clone(),
            path_kind: PathKind::Bluetooth,
            bulk: bulk_tx.clone(),
            priority: prio_tx.clone(),
            cancel: cancel_tx,
        });
    register_connection(&state, &peer_id, ep.clone(), PathKind::Bluetooth);
    state.logger.info(
        "ble",
        format!("[SESSION] 已就绪 peer={peer_id} ep={ep}（双向 Hello 已验签，transport 可用）"),
    );
    state.logger.info(
        "ble",
        format!("+ble-link peer={peer_id} ep={ep}（双向 Hello 已验签）"),
    );

    // 首帧（对端 Hello）交给统一的处理路径：写身份 + 双公钥、对齐会话时钟、冲刷待发队列
    handle_message(&state, &peer_id, first).await;

    tokio::spawn(ble_writer_loop(
        state.clone(),
        peer_id.clone(),
        ep.clone(),
        writer,
        bulk_rx,
        prio_rx,
        shutdown.clone(),
        cancel_rx.clone(),
    ));
    // ↑ 写循环泛型化：central 写 GATT 特征、外设发通知，逻辑同一份（见 `FrameSink`）
    tokio::spawn(ble_reader_loop(
        state.clone(),
        peer_id.clone(),
        ep.clone(),
        reader,
        shutdown.clone(),
        cancel_rx,
    ));

    // 建链即冲一次待发队列（与 TCP 拨号成功后的序列一致）
    flush_outbox(&state, &peer_id).await;
    flush_group_outbox(&state, &peer_id).await;
    flush_pending_reads(&state, &peer_id).await;
    flush_pending_group_reads(&state, &peer_id).await;
    flush_pending_group_keys(&state, &peer_id).await;
    crate::commands::flush_pending_files(&state, &peer_id).await;
    crate::commands::flush_pending_group_files(&state, &peer_id).await;
    Ok(())
}

/// 在读循环之外（握手阶段）读一条完整消息：窗口内没有分片就继续等，直到超时。
async fn read_one(
    reader: &mut BleReader,
    overall: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Option<Message>, String> {
    let deadline = tokio::time::Instant::now() + overall;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Ok(None);
        }
        let frame = tokio::select! {
            biased;
            _ = shutdown.changed() => return Ok(None),
            res = reader.next_frame(READ_IDLE) => res?,
        };
        let Some(frame) = frame else {
            let _ = reader.gc();
            continue;
        };
        return serde_json::from_slice::<Message>(&frame)
            .map(Some)
            .map_err(|e| format!("握手帧无法解析：{e}"));
    }
}

/// 这一帧值不值得在 BLE 生命周期日志里留一行。
///
/// 为什么过滤：`Heartbeat` / `Presence` 每 5s 一条、`Gossip` 也可能是同一件事的转发；
/// 全打会把真机日志刷满，而排查"好友申请为什么几分钟才到 / 消息为什么一直发送中"
/// 需要的恰恰是**控制帧与业务帧**的收发轨迹（用户 2026-09-13 明确要求）。
fn is_logworthy_frame(msg: &Message) -> bool {
    match msg {
        Message::Heartbeat { .. } | Message::UserInfo { .. } => false,
        // Presence（节点通告）每 5s 一条，经 Gossip 承载 ⇒ 只跳过它；
        // 其它 Gossip（好友申请/同意、单聊、群聊、送达确认）都值得留痕。
        Message::Gossip { envelope } => envelope.kind != crate::protocol::GossipKind::Presence,
        _ => true,
    }
}

/// 一条帧的**可 grep 标识**：类型名 + 消息 id（如果有）。
fn frame_trace(msg: &Message) -> String {
    match msg {
        Message::Ack { msg_id } => format!("type=ack msg_id={msg_id}"),
        Message::ChatMessage { msg_id, kind, .. } => {
            format!("type=chat_message kind={kind:?} msg_id={msg_id}")
        }
        // 好友申请/同意走的是 `Gossip` 信封（GossipKind::FriendRequest/FriendAccept）——
        // **必须把 kind 打出来**，否则日志里只有 `type=gossip`，根本分不清
        // "好友申请到底发出去没有"（用户 2026-09-13 排查时正是卡在这里）。
        Message::Gossip { envelope } => format!("type=gossip kind={:?}", envelope.kind),
        Message::FriendRequest { from, .. } => format!("type=friend_request from={from}"),
        Message::FriendAccept { from, .. } => format!("type=friend_accept from={from}"),
        Message::FileChunk { transfer_id, seq, .. } => {
            format!("type=file_chunk transfer={transfer_id} seq={seq}")
        }
        other => format!("type={}", other.wire_kind()),
    }
}

/// 握手期间最多跳过多少个"非 Hello 的前导帧"。
///
/// 为什么要上限：既能让"上一条链路的残留帧"过去，又不能让对端无限灌帧把握手拖住
/// （每一帧都要过一遍 JSON 解析）。
const MAX_HANDSHAKE_PREAMBLE_FRAMES: u32 = 32;

/// 读**首个 Hello**：跳过并丢弃握手前导帧（见调用点的说明）。
///
/// 安全性：被丢掉的帧**绝不进入 `handle_message`** —— 身份来自 Hello 的签名验证，
/// 验签之前任何帧都只是字节。
async fn read_hello_frame(
    reader: &mut BleReader,
    overall: Duration,
    shutdown: &mut watch::Receiver<bool>,
    state: &AppState,
    ep_for_log: &str,
) -> Result<Message, String> {
    let deadline = tokio::time::Instant::now() + overall;
    let mut dropped = 0u32;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err(format!(
                "握手超时：窗口内没等到 Hello（丢掉了 {dropped} 个前导帧）"
            ));
        }
        let Some(frame) = read_one(reader, left, shutdown).await? else {
            return Err(format!(
                "握手超时：对端未回 Hello（丢掉了 {dropped} 个前导帧）"
            ));
        };
        match preamble_action(dropped, matches!(frame, Message::Hello { .. })) {
            PreambleAction::Hello => {
                if dropped > 0 {
                    state.logger.info(
                        "ble",
                        format!("[SESSION] 跳过 {dropped} 个握手前导帧后收到 Hello ep={ep_for_log}"),
                    );
                }
                return Ok(frame);
            }
            PreambleAction::GiveUp => {
                return Err(format!(
                    "对端首帧不是 Hello（连续 {dropped} 帧都不是，最后一帧 type={}）",
                    frame.wire_kind()
                ));
            }
            PreambleAction::Drop => {}
        }
        dropped += 1;
        state.logger.info(
            "ble",
            format!(
                "[SESSION] 丢弃握手前导帧 type={} ep={ep_for_log}（等 Hello，已丢 {dropped}）",
                frame.wire_kind()
            ),
        );
    }
}

/// 握手前导帧的处理决定（纯函数内核，见 `read_hello_frame`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreambleAction {
    /// 收到 Hello ⇒ 进入握手。
    Hello,
    /// 还不是 Hello，但额度没用完 ⇒ 丢掉它继续等。
    Drop,
    /// 额度用尽 ⇒ 明确报错（带上最后一帧的类型，便于真机定位）。
    GiveUp,
}

/// 纯函数：`dropped` = 已经丢掉了多少个前导帧。
fn preamble_action(dropped: u32, is_hello: bool) -> PreambleAction {
    if is_hello {
        PreambleAction::Hello
    } else if dropped >= MAX_HANDSHAKE_PREAMBLE_FRAMES {
        PreambleAction::GiveUp
    } else {
        PreambleAction::Drop
    }
}

/// 写方向的抽象：BLE central 用 [`BleWriter`]（GATT client 写特征），
/// 外设角色用 [`PeripheralSink`]（GATT server 发通知）。
/// 抽出来只为让「取消息 → 序列化 → 发送 → 失败即收尾」这套逻辑**只有一份**，
/// 两个角色的差异全部收在各自的适配器里。
#[async_trait::async_trait]
trait FrameSink: Send {
    async fn send_frame(&mut self, payload: &[u8]) -> Result<usize, String>;
}

#[async_trait::async_trait]
impl FrameSink for BleWriter {
    async fn send_frame(&mut self, payload: &[u8]) -> Result<usize, String> {
        BleWriter::send_frame(self, payload).await
    }
}

/// 外设侧的一条链路 = 「发通知的句柄 + 对端 central 标识」。
#[cfg(any(target_os = "macos", target_os = "android"))]
struct PeripheralSink {
    writer: PeripheralWriter,
    central: String,
}

#[cfg(any(target_os = "macos", target_os = "android"))]
#[async_trait::async_trait]
impl FrameSink for PeripheralSink {
    async fn send_frame(&mut self, payload: &[u8]) -> Result<usize, String> {
        self.writer.send_frame(&self.central, payload).await
    }
}

/// 读方向的抽象：central 从 [`BleReader`] 取帧，外设角色从通道取帧
/// （帧在驱动的 delegate 里就已经重组好了）。
#[async_trait::async_trait]
trait FrameSource: Send {
    /// 等一条**完整帧**；`Ok(None)` = 这个窗口内没有。
    async fn next_frame(&mut self, wait: Duration) -> Result<Option<Vec<u8>>, String>;
    /// 回收半截消息（对端半途断连时不会永久占内存）。
    fn gc(&mut self) -> usize;
    /// 分片级统计 `(本特征通知数, 字节数, 非本特征通知数)`；没有这层信息就返回 `None`。
    fn frag_stats(&self) -> Option<(u64, usize, u64)> {
        None
    }
}

/// 泛型薄封装：让读循环不必关心具体实现有没有分片统计。
fn stats_fn<S: FrameSource>(reader: &S) -> Option<(u64, usize, u64)> {
    reader.frag_stats()
}

#[async_trait::async_trait]
impl FrameSource for BleReader {
    async fn next_frame(&mut self, wait: Duration) -> Result<Option<Vec<u8>>, String> {
        BleReader::next_frame(self, wait).await
    }
    fn gc(&mut self) -> usize {
        BleReader::gc(self)
    }
    fn frag_stats(&self) -> Option<(u64, usize, u64)> {
        Some(BleReader::stats(self))
    }
}

/// 外设侧的读方向：帧已经重组好，直接从通道拿。
#[cfg(any(target_os = "macos", target_os = "android"))]
struct ChannelSource {
    rx: mpsc::Receiver<Vec<u8>>,
}

#[cfg(any(target_os = "macos", target_os = "android"))]
#[async_trait::async_trait]
impl FrameSource for ChannelSource {
    async fn next_frame(&mut self, _wait: Duration) -> Result<Option<Vec<u8>>, String> {
        // 通道关闭 = 驱动退出（对端断开 / 蓝牙被关）⇒ 当成"链路结束"而不是"暂时没数据"
        match self.rx.recv().await {
            Some(bytes) => Ok(Some(bytes)),
            None => Err("外设链路已关闭".to_string()),
        }
    }
    fn gc(&mut self) -> usize {
        // 半截消息由驱动侧的 `BleReassembler`（带 30s TTL）负责回收
        0
    }
}

async fn ble_writer_loop<S: FrameSink + 'static>(
    state: Arc<AppState>,
    peer_id: String,
    ep: MeshEndpoint,
    mut writer: S,
    mut bulk_rx: mpsc::Receiver<Message>,
    mut prio_rx: mpsc::Receiver<Message>,
    mut shutdown: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut bulk_open = true;
    let mut prio_open = true;
    loop {
        if !bulk_open && !prio_open {
            break;
        }
        let msg = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = cancel.changed() => break,
            maybe = prio_rx.recv(), if prio_open => maybe,
            maybe = bulk_rx.recv(), if bulk_open => maybe,
        };
        match msg {
            Some(msg) => {
                let trace = is_logworthy_frame(&msg).then(|| frame_trace(&msg));
                let Ok(bytes) = serde_json::to_vec(&msg) else {
                    continue;
                };
                // 写也要能被停机/判死打断（与 TCP 的 writer_loop 同一考虑）
                let res = tokio::select! {
                    biased;
                    _ = shutdown.changed() => Err("停机中".to_string()),
                    _ = cancel.changed() => Err("链路已取消".to_string()),
                    res = writer.send_frame(&bytes) => res,
                };
                // 分片数要留痕：对端会打 `[FRAG] 收到通知 N 条`，两边的数字一比就知道
                // **是发少了还是收丢了**（真机 2026-09-13：742B 的帧需要 53 片，对端只到 38 片）。
                if let (Ok(n), Some(trace)) = (&res, trace.as_deref()) {
                    state.logger.info(
                        "ble",
                        format!("[SEND] {trace} → peer={peer_id} ep={ep} bytes={} 分片={n}", bytes.len()),
                    );
                }
                let ok = res.is_ok();
                if !ok {
                    state.logger.warn(
                        "ble",
                        format!(
                            "[SEND] 写失败 ⇒ 结束该链路写循环 peer={peer_id} ep={ep} {}{}",
                            trace.as_deref().unwrap_or("type=?"),
                            ""
                        ),
                    );
                    break;
                }

            }
            None => {
                if prio_rx.is_closed() {
                    prio_open = false;
                }
                if bulk_rx.is_closed() {
                    bulk_open = false;
                }
            }
        }
    }
}

async fn ble_reader_loop<S: FrameSource + 'static>(
    state: Arc<AppState>,
    peer_id: String,
    ep: MeshEndpoint,
    mut reader: S,
    mut shutdown: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) {
    // 分片统计只在 central 侧（`BleReader`）有意义；外设侧没有这个计数。
    let mut last_frag_n: u64 = 0;
    let mut last_frag_other: u64 = 0;
    loop {
        let frame = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = cancel.changed() => break,
            res = reader.next_frame(READ_IDLE) => res,
        };
        match frame {
            Ok(Some(bytes)) => match serde_json::from_slice::<Message>(&bytes) {
                Ok(msg) => {
                    if is_logworthy_frame(&msg) {
                        state.logger.info(
                            "ble",
                            format!(
                                "[RECV] {} ← peer={peer_id} ep={ep} bytes={}",
                                frame_trace(&msg),
                                bytes.len()
                            ),
                        );
                    }
                    handle_message(&state, &peer_id, msg).await
                }
                Err(e) => state
                    .logger
                    .warn("ble", format!("丢弃无法解析的 BLE 帧 peer={peer_id}: {e}")),
            },
            Ok(None) => {
                // 窗口内没有分片：顺手回收半截消息（对端在半途断连时不会永久占内存）
                let _ = reader.gc();
                // **分片级可见性**：真机里"对端说发了、这边什么都没收到"时，
                // 这条日志能一眼区分"没发出来"与"发出来但没到"。
                if let Some((n, bytes, other)) = stats_fn(&reader) {
                    if n != last_frag_n || other != last_frag_other {
                        state.logger.info(
                            "ble",
                            format!(
                                "[FRAG] 收到通知 {n} 条 / {bytes} 字节（非本特征 {other} 条）                                 ← peer={peer_id} ep={ep}"
                            ),
                        );
                        last_frag_n = n;
                        last_frag_other = other;
                    }
                }
            }
            Err(e) => {
                state
                    .logger
                    .info("ble", format!("BLE 读结束 peer={peer_id} ep={ep}: {e}"));
                break;
            }
        }
    }
    // 收尾：只拆这一条（同一 peer 可能还有 LAN 链路）
    teardown_link(&state, &peer_id, &ep).await;
}

// ===========================================================================
//                        外设（GATT server）方向
// ===========================================================================
//
// 与上面 central 方向的**唯一**区别是"谁先连谁"：
//   * central（digits 上面那段）：我们扫 → 我们连 → 我们发 Hello → 等对端 Hello；
//   * 外设（本段）：对端连我们 → 对端发 Hello（首帧）→ 我们验签 → **我们回 Hello**。
// 其余全部相同：同一个 `verify_hello_for_ble`、同一个 `should_accept_inbound_public`
// 去重判据、同一份 `Link`/`PathKind::Bluetooth` 登记、同一套冲刷序列。
// 因此下面没有第二套身份/信任判断 —— 身份**只能**由双向 Hello 验签建立。

/// 外设事件循环收到的路由控制消息（握手成功后把"往这个 central 投帧"的管道交给循环）。
#[cfg(any(target_os = "macos", target_os = "android"))]
enum RouteCtl {
    Add {
        central: String,
        tx: mpsc::Sender<Vec<u8>>,
    },
}

/// 启动外设角色。失败只记日志：能扫别人但别人连不上我们，属于**降级**而不是故障，
/// 不该把整个蓝牙开关判为不可用（LAN 更不受影响）。
#[cfg(any(target_os = "macos", target_os = "android"))]
async fn start_peripheral(state: Arc<AppState>, shutdown: watch::Receiver<bool>) {
    let startup = match peripheral::start() {
        Ok(startup) => startup,
        Err(e) => {
            state.logger.warn(
                "ble",
                format!("蓝牙外设角色未启动（central 角色不受影响，仍可主动连别人）：{e}"),
            );
            return;
        }
    };
    // 等 CoreBluetooth 上报状态：把"未授权 / 蓝牙关着 / 广播失败"变成一条**说得清**的错误。
    // 超时不致命（系统可能只是还没上报），此时按"已启动"继续。
    match tokio::time::timeout(peripheral::STATE_WAIT, startup.state).await {
        Ok(Ok(Ok(()))) => state
            .logger
            .info("ble", "蓝牙外设角色已启动（广播服务 UUID，等待手机/PC 连入）"),
        Ok(Ok(Err(e))) => {
            state
                .logger
                .warn("ble", format!("蓝牙外设角色不可用（central 角色不受影响）：{e}"));
            startup.server.stop();
            return;
        }
        Ok(Err(_)) => {
            state
                .logger
                .warn("ble", "蓝牙外设角色的状态回调通道被关闭，放弃启动");
            startup.server.stop();
            return;
        }
        Err(_) => state
            .logger
            .info("ble", "蓝牙外设角色已启动（未在 3s 内收到状态回调，继续广播）"),
    }
    tokio::spawn(peripheral_accept_loop(state, startup.server, shutdown));
}

/// 外设侧的总循环：把每个 central 的帧分派给它的链路任务，首帧走握手。
#[cfg(any(target_os = "macos", target_os = "android"))]
async fn peripheral_accept_loop(
    state: Arc<AppState>,
    mut server: peripheral::PeripheralServer,
    mut shutdown: watch::Receiver<bool>,
) {
    // central 标识 → 该链路的帧管道；`handshaking` 防止同一个 central 触发多次握手
    let mut routes: HashMap<String, mpsc::Sender<Vec<u8>>> = HashMap::new();
    let mut handshaking: HashSet<String> = HashSet::new();
    let (route_tx, mut route_rx) = mpsc::channel::<RouteCtl>(16);

    loop {
        let ev = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            Some(ctl) = route_rx.recv() => {
                let RouteCtl::Add { central, tx } = ctl;
                handshaking.remove(&central);
                routes.insert(central, tx);
                continue;
            }
            maybe = server.events.recv() => match maybe {
                Some(ev) => ev,
                None => break,
            },
        };

        match ev {
            PeripheralEvent::Frame { central, bytes } => {
                // 先判「投旧链路 还是 重新握手」（判据与理由见 `peripheral_route_action`）：
                // 同一个 central 地址的**重连**发来的 Hello 绝不能被投给旧链路的管道,
                // 否则新连接永远收不到 Hello 回应（对端表现为"握手超时"/"首帧不是 Hello"）。
                let has_route = routes.contains_key(&central);
                let action = peripheral_route_action(has_route, has_route && frame_is_hello(&bytes));
                let mut pending = Some(bytes);
                if action == PeripheralRouteAction::ToHandshake && has_route {
                    routes.remove(&central);
                    state.logger.info(
                        "ble",
                        format!("外设侧收到新连接的 Hello（central={central}）⇒ 换路由并重新握手"),
                    );
                }
                if action == PeripheralRouteAction::ToExistingLink {
                    if let Some(tx) = routes.get(&central).cloned() {
                        match tx.send(pending.take().expect("pending 刚被设置")).await {
                            Ok(()) => continue,
                            Err(e) => {
                                pending = Some(e.0);
                                routes.remove(&central);
                                state.logger.info(
                                    "ble",
                                    format!("外设侧旧链路已失效，按重连处理 central={central}"),
                                );
                            }
                        }
                    }
                }
                let bytes = pending.expect("未投递的帧必须还在");
                // 外设侧的同一类问题：新连接的"第一帧"可能仍是上一条链路的残留业务帧
                // （Android 的 notify 按 central 地址投递）。这里**丢掉**它并等 Hello ——
                // 既不能投给旧路由（那条链路已死），也不能当握手首帧（会立刻失败）。
                if action == PeripheralRouteAction::ToHandshake && !frame_is_hello(&bytes) {
                    let kind = serde_json::from_slice::<Message>(&bytes)
                        .map(|m| m.wire_kind())
                        .unwrap_or_else(|_| "无法解析".to_string());
                    state.logger.info(
                        "ble",
                        format!(
                            "[SESSION] 丢弃外设侧握手前导帧 type={kind} central={central}（等 Hello）"
                        ),
                    );
                    continue;
                }
                if handshaking.insert(central.clone()) {
                    tokio::spawn(accept_handshake(
                        state.clone(),
                        server.writer.clone(),
                        central,
                        bytes,
                        route_tx.clone(),
                        shutdown.clone(),
                    ));
                }
            }
            PeripheralEvent::Unlinked { central } => {
                handshaking.remove(&central);
                routes.remove(&central);
                state
                    .logger
                    .info("ble", format!("外设侧对端取消订阅（视为断开）central={central}"));
                let ep = MeshEndpoint::Ble(BleEndpoint::new(central));
                detach_by_endpoint(&state, &ep).await;
            }
            // 驱动侧的诊断/告警：**必须**记进日志 —— 蓝牙在真机上出问题时，
            // 这是用户唯一能贴给我们的线索（"开着蓝牙却没人能发现我们"就是这类）。
            PeripheralEvent::Notice(text) => state.logger.info("ble", text),
            PeripheralEvent::Warning(text) => state.logger.warn("ble", text),
        }
    }

    server.stop();
    state.logger.info("ble", "蓝牙外设角色已停止广播");
}

/// 按 BLE 端点摘链路（外设侧只知道 central 标识，peer_id 要反查）。
#[cfg(any(target_os = "macos", target_os = "android"))]
async fn detach_by_endpoint(state: &Arc<AppState>, ep: &MeshEndpoint) {
    let peer = {
        let links = state.links.lock().await;
        links
            .iter()
            .find(|(_, v)| v.iter().any(|l| &l.endpoint == ep))
            .map(|(p, _)| p.clone())
    };
    if let Some(peer) = peer {
        teardown_link(state, &peer, ep).await;
    }
}

/// 外设侧握手的外壳：失败一律**只记日志**（对端可能只是路过、或者根本不是 Gosslan 端）。
#[cfg(any(target_os = "macos", target_os = "android"))]
async fn accept_handshake(
    state: Arc<AppState>,
    writer: PeripheralWriter,
    central: String,
    first_bytes: Vec<u8>,
    route_tx: mpsc::Sender<RouteCtl>,
    shutdown: watch::Receiver<bool>,
) {
    if let Err(e) =
        try_accept_handshake(&state, writer, &central, first_bytes, route_tx, shutdown).await
    {
        state
            .logger
            .info("ble", format!("外设侧未建链 central={central}：{e}"));
    }
}

/// 真身：验签对端 Hello → 回我们的 Hello → 登记链路 → 起收发。
#[cfg(any(target_os = "macos", target_os = "android"))]
async fn try_accept_handshake(
    state: &Arc<AppState>,
    writer: PeripheralWriter,
    central: &str,
    first_bytes: Vec<u8>,
    route_tx: mpsc::Sender<RouteCtl>,
    shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let ep = MeshEndpoint::Ble(BleEndpoint::new(central.to_string()));

    // ---- 1. 首帧必须是 Hello，且签名必须验过（BLE 地址不是身份）----
    let first: Message = serde_json::from_slice(&first_bytes)
        .map_err(|e| format!("对端首帧无法解析：{e}"))?;
    let Message::Hello {
        device_id,
        tcp_port,
        nonce,
        sig,
        x25519_pubkey,
        ed25519_pubkey,
        ..
    } = &first
    else {
        return Err(format!(
            "外设侧首帧不是 Hello（收到 {}，central={central}）",
            first.wire_kind()
        ));
    };
    crate::network::transport::verify_hello_for_ble(
        state,
        device_id,
        *tcp_port,
        nonce,
        x25519_pubkey,
        ed25519_pubkey,
        sig,
    )?;
    let peer_id = device_id.clone();

    // ---- 2. 同一个 BLE 端点的旧链路让位 ----
    // CoreBluetooth 的外设角色**没有**"central 断开"回调（只有取消订阅），
    // 所以旧链路可能早就死了而我们还留着它；对端重新连上来时必须由新链路取代，
    // 否则这个 central 会永远撞在 `should_accept_inbound_public` 上、彻底连不进来。
    detach_by_endpoint(state, &ep).await;

    // ---- 3. 链路数上限仍然要守（防无界增长），但**同路径的镜像链路要放行** ----
    //
    // 为什么不能像 TCP 那样"按同路径去重直接拒"（4.2.6 的教训，用户真机日志）：
    // BLE 上两端都跑 central+peripheral，小 id 那一侧（Mac）会不停来拨我们；
    // 如果我们**在回 Hello 之前**就拒掉，它就**永远学不到对端 device_id** ⇒
    // 也就永远进不了它自己的"不要再拨"名单 ⇒ 每 13s 重拨一次，
    // 而**每次连接都会打断我们拨过去的那条好链路**（Android GATT server 对同一 central
    // 的新连接会替换旧的）⇒ 好链路 45s 收不到帧被看门狗拆掉 ⇒ 加好友时"连接已关闭"。
    // 所以：**让它握手成功**，它拿到 device_id 后会自己判"我比你小 ⇒ 该你拨我"并把这条
    // 镜像链路收掉（`dial_and_register` 里的 `should_dial_ble`）。一次性打扰，换来永久安静。
    let existing = link_snapshot(state, &peer_id).await;
    if !should_accept_inbound_public(&state.device_id, &peer_id, PathKind::Bluetooth, &existing)
        && existing.len() >= crate::network::transport::MAX_LINKS_PER_PEER
    {
        return Err("该 peer 链路数已满，不重复建链".to_string());
    }
    if existing.iter().any(|(_, k, healthy)| *k == PathKind::Bluetooth && *healthy) {
        state.logger.info(
            "ble",
            format!("对端 {peer_id} 已有蓝牙链路，这条是镜像入站 —— 仍然完成握手，好让它自己退让"),
        );
    }

    // ---- 4. 路由先就位，再回 Hello ----
    // 对端收到我们的 Hello 后会**立刻**开始冲刷待发队列；路由早一步挂上，
    // 那批帧才不会被"注册还没完成"的缝隙吞掉（通道有缓冲，读者随后就来）。
    let (frame_tx, frame_rx) = mpsc::channel::<Vec<u8>>(1024);
    route_tx
        .send(RouteCtl::Add {
            central: central.to_string(),
            tx: frame_tx,
        })
        .await
        .map_err(|_| "外设事件循环已退出".to_string())?;

    // ---- 5. 回我们的 Hello（对端正卡在 10s 超时里等它）----
    if shutdown.borrow().to_owned() {
        return Err("蓝牙通道正在停止".to_string());
    }
    let hello = build_signed_hello(state, 0);
    let bytes = serde_json::to_vec(&hello).map_err(|e| format!("Hello 序列化失败：{e}"))?;
    writer
        .send_frame(central, &bytes)
        .await
        .map_err(|e| format!("回 Hello 失败：{e}"))?;

    // ---- 6. 登记链路（端点 = BLE central 标识，路径 = Bluetooth）----
    let (bulk_tx, bulk_rx) = mpsc::channel(1024);
    let (prio_tx, prio_rx) = mpsc::channel(1024);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    state
        .links
        .lock()
        .await
        .entry(peer_id.clone())
        .or_default()
        .push(Link {
            endpoint: ep.clone(),
            path_kind: PathKind::Bluetooth,
            bulk: bulk_tx.clone(),
            priority: prio_tx.clone(),
            cancel: cancel_tx,
        });
    register_connection(state, &peer_id, ep.clone(), PathKind::Bluetooth);
    // 对端能连上我们 ⇒ 之前"我拨不上它"的失败计数已经过期，必须清掉。
    // 不清的话：唯一的拨号方（大 id/不能被拨入的那侧）会被自己的退避锁住，
    // 而它恰恰是断线后唯一会重连的一方（真机表现：好友申请等几分钟）。
    clear_ble_dial_failure(state, central);
    state.logger.info(
        "ble",
        format!("[SESSION] 已就绪（外设侧）peer={peer_id} ep={ep}（双向 Hello 已验签）"),
    );
    state.logger.info(
        "ble",
        format!("+ble-link(外设) peer={peer_id} ep={ep}（双向 Hello 已验签）"),
    );

    // 对端 Hello 交给统一处理路径：写身份 + 双公钥、对齐会话时钟、冲刷待发队列
    handle_message(state, &peer_id, first).await;

    tokio::spawn(ble_writer_loop(
        state.clone(),
        peer_id.clone(),
        ep.clone(),
        PeripheralSink {
            writer,
            central: central.to_string(),
        },
        bulk_rx,
        prio_rx,
        shutdown.clone(),
        cancel_rx.clone(),
    ));
    tokio::spawn(ble_reader_loop(
        state.clone(),
        peer_id.clone(),
        ep.clone(),
        ChannelSource { rx: frame_rx },
        shutdown,
        cancel_rx,
    ));

    // 建链即冲一次待发队列（与 central / TCP 拨号成功后的序列完全一致）
    flush_outbox(state, &peer_id).await;
    flush_group_outbox(state, &peer_id).await;
    flush_pending_reads(state, &peer_id).await;
    flush_pending_group_reads(state, &peer_id).await;
    flush_pending_group_keys(state, &peer_id).await;
    crate::commands::flush_pending_files(state, &peer_id).await;
    crate::commands::flush_pending_group_files(state, &peer_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(unused_imports)]
    use super::*;

    /// **拨号退避必须"能快速恢复"**：旧上限 10 分钟把暂时性失败变成用户可见的故障
    /// （真机：好友申请等了 5～6 分钟才到）。
    #[test]
    fn dial_backoff_recovers_within_a_minute() {
        // 5s → 10s → 20s → 40s → 60s（封顶 1 分钟）
        assert_eq!(ble_dial_backoff_ms(1), 5_000);
        assert_eq!(ble_dial_backoff_ms(2), 10_000);
        assert_eq!(ble_dial_backoff_ms(3), 20_000);
        assert_eq!(ble_dial_backoff_ms(4), 40_000);
        assert_eq!(
            ble_dial_backoff_ms(5),
            60_000,
            "第 5 次失败必须封顶在 60s（上限必须 60s）"
        );
        // 上限必须**封在 1 分钟**：再多失败也不许退到分钟级以上
        for n in 6..50 {
            assert_eq!(
                ble_dial_backoff_ms(n),
                60_000,
                "第 {n} 次失败仍在退避 {0}ms —— 上限必须 60s",
                ble_dial_backoff_ms(n)
            );
        }
        // 0 次失败（理论上不会查）也不能 panic / 退化为 0
        assert!(ble_dial_backoff_ms(0) >= 5_000);
    }

    /// **握手必须容忍前导帧**（真机 2026-09-13 的真因之一）。
    ///
    /// 日志证据：`[GATT] 已就绪 → [DISCONNECT] 对端首帧不是 Hello（收到 chat_message）`，
    /// 反复出现 ⇒ 链路永久建不起来（双方各自重拨、互相打断）。
    /// 原因是 Android 的 notify 按 **central 地址**投递：上一条链路的待发帧会落在新连接上。
    #[test]
    fn handshake_tolerates_leading_non_hello_frames_but_is_bounded() {
        // Hello 一到就进握手（无论之前丢过几个）
        assert_eq!(preamble_action(0, true), PreambleAction::Hello);
        assert_eq!(preamble_action(7, true), PreambleAction::Hello);
        // 非 Hello：额度内丢掉继续等
        assert_eq!(
            preamble_action(0, false),
            PreambleAction::Drop,
            "非 Hello 且额度未用尽必须丢弃 —— 额度过小会把残留帧当失败，链路又建不起来"
        );
        assert_eq!(
            preamble_action(MAX_HANDSHAKE_PREAMBLE_FRAMES - 1, false),
            PreambleAction::Drop
        );
        // 额度用尽：明确失败（不能无限被灌帧拖住）
        assert_eq!(
            preamble_action(MAX_HANDSHAKE_PREAMBLE_FRAMES, false),
            PreambleAction::GiveUp
        );
        assert!(MAX_HANDSHAKE_PREAMBLE_FRAMES >= 8, "额度过小会让残留帧把链路打死");
    }

    /// **重连判据**：同一个 central 地址的**新连接**发来的 Hello，绝不能被投给旧链路。
    ///
    /// 真机（2026-09-12）：旧链路的写句柄指向旧连接 ⇒ 新连接收不到 Hello 回应，
    /// 对端报「握手超时：对端未回 Hello」，或者旧链路把 Hello 当普通帧吃掉 ⇒
    /// 对端报「对端首帧不是 Hello」。用户看到的是"蓝牙时好时坏、加好友没反应"。
    #[test]
    fn reconnect_hello_must_not_go_to_the_stale_route() {
        assert_eq!(
            peripheral_route_action(true, true),
            PeripheralRouteAction::ToHandshake,
            "有活路由 + 收到 Hello ⇒ 一定是重连，必须换路由重新握手"
        );
        // 三条对照：普通数据帧仍走旧链路；没有路由时一律走握手分支（与旧行为一致）
        assert_eq!(
            peripheral_route_action(true, false),
            PeripheralRouteAction::ToExistingLink
        );
        assert_eq!(
            peripheral_route_action(false, true),
            PeripheralRouteAction::ToHandshake
        );
        assert_eq!(
            peripheral_route_action(false, false),
            PeripheralRouteAction::ToHandshake
        );
    }

    /// `frame_is_hello` 必须**真的认得出 Hello**，且不把大分片当 Hello 去解析。
    #[test]
    fn frame_is_hello_peeks_only_small_hello_frames() {
        let hello = Message::Hello {
            device_id: "dev-a".into(),
            nickname: "A".into(),
            avatar: None,
            device_type: "desktop".into(),
            tcp_port: 59992,
            x25519_pubkey: "xk".into(),
            ed25519_pubkey: "ek".into(),
            conv_clock: 0,
            nonce: "n1".into(),
            sig: "sig".into(),
        };
        let bytes = serde_json::to_vec(&hello).unwrap();
        assert!(
            bytes.len() < HELLO_PEEK_MAX_BYTES,
            "真实 Hello（{} 字节）必须在上限内，否则重连判据会失效",
            bytes.len()
        );
        assert!(frame_is_hello(&bytes), "Hello 必须被认出来");

        // 非 Hello 的小帧：认成 false，而不是 panic
        let hb = serde_json::to_vec(&Message::Heartbeat {
            device_id: "dev-a".into(),
        })
        .unwrap();
        assert!(!frame_is_hello(&hb));

        // 超上限的帧：一律 false（跳过解析，避免给 256KiB 分片白烧一次解析）
        let big = vec![b'{'; HELLO_PEEK_MAX_BYTES + 1];
        assert!(!frame_is_hello(&big));
        // 坏帧也不能 panic
        assert!(!frame_is_hello(b"not json at all"));
    }
}
