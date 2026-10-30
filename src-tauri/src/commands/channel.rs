// 职责边界：
// - 双通道开关（蓝牙/LAN）、运行态快照
// - 缓存读、权限检查（蓝牙权限）
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
    // 跨网可达性（**不是发现通道**，配置在设置页）：只取"有没有 / 通没通"，绝不取口令与服务器地址。
    // 「添加好友」页据此如实告知"局域网/蓝牙之外还开着什么"（用户 2026-09-22）。
    let (routed_endpoints, relay_enabled) = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        (
            crate::discovery::routed::parse_endpoints(&match db::get_setting_checked(
                &dbc,
                crate::discovery::routed::ROUTED_ENDPOINTS_KEY,
            ) {
                Ok(v) => v.unwrap_or_default(),
                Err(e) => {
                    // 这一格是**同步、非 Result** 的只读诊断（界面没有错误通道可承接）⇒
                    // 仍然折叠成空，但**必须留痕**：否则"读不到"会被当成"没有配置"
                    //（B1-F7 的同一形状，只是这一处没法上抛）。
                    s.logger
                        .warn("config", format!("code=ROUTED_ENDPOINTS_READ_FAILED {e}"));
                    String::new()
                }
            })
            .len(),
            db::get_config_bool(&dbc, RELAY_ENABLED_KEY, false),
        )
    };
    // 中继是否真的连通：有任意一条 `path_kind==Relay` 的活跃链路即算（用枚举判，不按服务器地址）。
    // 判据与快照里 `relay.connected` 同源（`state::link_is_relay_circuit`）。
    let relay_connected = {
        let links = s.links.lock().await;
        links
            .values()
            .any(|ls| ls.iter().any(crate::state::link_is_relay_circuit))
    };
    RuntimeSnapshot {
        present,
        channels: list,
        online,
        bound_ip,
        ble: BleRuntimeFacts {
            feature_compiled: cfg!(feature = "bluetooth"),
        },
        ble_autostart_held: s
            .ble_autostart_hold
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        peer_count,
        routed_endpoints,
        relay: crate::state::RelayRuntimeStatus {
            enabled: relay_enabled,
            connected: relay_connected,
        },
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
                // 用户关掉通道 ⇒ 后台连接的前台服务一起收掉（与 `stop_network` 同一条口径；
                // 为什么不在 `network::stop` 里做，见 `network/mod.rs` 那段 ⚠️）
                crate::android_background::stop(&s.logger);
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
                // 显式开启成功 = 用户已经决定再用蓝牙 ⇒ 清掉"上次崩溃后的自动暂停"。
                // 自动路径不会走到这条命令（前端闸在 `ensureBluetoothOn`），所以这里
                // 是**唯一**的清除点。
                if enabled {
                    *s.ble_autostart_hold
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                }
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

/// 纳入**占用统计**的目录：接收的图片/文件目录 + 历史遗留的 cache 目录 + 收藏副本。
/// 旧 `cache/` 可能残留早期版本抽取的图片，一并纳入，避免"看不见也清不掉"。
fn media_dirs(s: &AppState) -> Vec<PathBuf> {
    let downloads = s
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    vec![downloads, s.cache_dir.clone(), s.favorites_dir.clone()]
}

/// 清理目标 = 统计目录里**去掉收藏**的那一组。
///
/// 收藏是"用户明确要留住的东西"（见 `AppState::favorites_dir` 的注释）：原消息删了、
/// 会话删了、缓存清了，收藏仍要能打开。把它当缓存按 mtime/配额删掉，删掉的是用户
/// 唯一的那份副本，且不可恢复。所以它只计入占用，永不参与删除。
fn cleanable_dirs(all: Vec<PathBuf>, favorites: &std::path::Path) -> Vec<PathBuf> {
    all.into_iter().filter(|d| d != favorites).collect()
}

/// 自动缓存清理调度（README 承诺的「3/7/30 天 + 配额自动清理」此前只有手动按钮）。
///
/// 间隔口径的**唯一来源**（下面那条结构判据读的就是这三个常量名）。
///
/// 首轮刻意排在 `loop` 外面：以前第一句就是 `sleep(6h)`，于是这段注释承诺的
/// 「启动 60s 后跑第一轮」从来没成立过 —— 开着不到 6 小时的会话一次都不会清，
/// 而那正是"文件夹怎么又涨了"最常问的一种场景。
const CACHE_CLEAN_FIRST_DELAY_SECS: u64 = 60;
/// 之后每 6h 一轮。
const CACHE_CLEAN_INTERVAL_SECS: u64 = 6 * 3600;
/// 自动路径上做 VACUUM 的**释放量下限**。
///
/// 为什么要阈值而不是"删了东西就 VACUUM"：VACUUM 要重写整份 db 文件，期间持住那**唯一**
/// 一条 SQLite 连接 ⇒ 所有 IPC 排队（用户看到的是界面卡几秒）。而本仓只有这一条连接，
/// `check-db-lock-scope` 盯的是"持锁 emit"，这种"持锁做重活"是它的盲区。
/// 删几个几 KB 的过期图就重写整库，代价和收益完全不成比例。
const CACHE_CLEAN_VACUUM_MIN_FREED_BYTES: u64 = 64 * 1024 * 1024;

/// 这一轮自动清理是否值得做 VACUUM（纯函数，便于把边界测出来）。
fn cache_clean_should_vacuum(freed_bytes: u64) -> bool {
    freed_bytes >= CACHE_CLEAN_VACUUM_MIN_FREED_BYTES
}

/// 释放量没达阈值时那句（也是 `format_vacuum_note` 之外唯一的一种结局）。
const VACUUM_SKIPPED_NOTE: &str = "跳过（释放量未达阈值）";

/// VACUUM 那一句话说的是什么（纯函数，便于把句子形状测出来）。
///
/// **等锁**与**执行**是两个数，不许合成一个"用时"：合成之后读不出"这一下慢是别人还
/// 握着那条连接，还是 VACUUM 自己慢"——而这两件事的处置完全相反（前者去看持锁观测里
/// 谁握得久，后者去查 db 体量）。执行时长严格从**取得锁之后**起算。
///
/// 三种结局必须分开说（决策 2）：
/// - **做完了** ⇒ "已做"；
/// - **超预算被我们自己中止** ⇒ "已中止……数据库未压缩、内容完好"（这是预期内的行为，
///   不是故障；混进"失败"会让用户以为数据库坏了）；
/// - **真出错了** ⇒ "失败: 原因"。
fn format_vacuum_note(wait_ms: u64, outcome: &crate::storage::vacuum::VacuumOutcome) -> String {
    use crate::storage::vacuum::VacuumOutcome;
    match outcome {
        VacuumOutcome::Completed { exec_ms } => {
            format!("已做，执行 {exec_ms}ms（等锁 {wait_ms}ms）")
        }
        VacuumOutcome::Aborted { exec_ms } => format!(
            "已中止（超 {}ms 预算，执行 {exec_ms}ms，等锁 {wait_ms}ms）：数据库未压缩、内容完好",
            crate::storage::vacuum::DEFAULT_VACUUM_BUDGET_MS
        ),
        VacuumOutcome::Failed { exec_ms, reason } => {
            format!("失败，执行 {exec_ms}ms（等锁 {wait_ms}ms）: {reason}")
        }
    }
}

/// 一次性运行时读数（10-22 审计 R-30 / D-16：DevDiag 面板此前缺「队列 / 活跃任务 / DB 锁」三节）。
///
/// 为什么是一条**按需**命令，而不是往 `RuntimeSnapshot` 里加字段：那份快照每次通道开关、
/// 每次 `runtime-changed` 都要重发给每个窗口，而这里要的是四条 COUNT ——
/// 把 db 读数挂在高频出口上就是给那唯一一条连接加排队（诊断规范也写明不许 >1/min 轮询）。
/// 诊断面板是手动打开、手动刷新的，正好是这类读数的唯一合理触发点。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiag {
    pub sending_msgs: i64,
    pub outbox: i64,
    pub group_outbox: i64,
    pub file_outbox: i64,
    /// 非空链路条数（口径与 `RUNTIME_SNAPSHOT` 那行日志同一个判据：只数非空）。
    pub links: usize,
    pub peers: usize,
    pub windows: usize,
    pub hidden_windows: usize,
    /// 最近一次「慢持锁」那行原文（由 `db_hold` 的**唯一读者**留档）。None = 本轮没有慢持锁。
    /// 面板不许自己 `take_summary()` —— 那是第二个读者，会把计数吞掉。
    pub db_hold_note: Option<String>,
    /// 在飞的「等点击」通知线程数与它的上限（审计 R-08）。上限由后端给：
    /// 前端抄一份常数就等于给这条约束判了死刑（改一侧另一侧不会红）。
    pub notify_waiters: usize,
    pub notify_waiters_max: usize,
    /// 安卓后台连接的前台服务读数（ADR-0022）。
    ///
    /// `None` = 这个平台**没有**这个东西（桌面），界面那一行整行不出现；
    /// 不是"服务没在跑"。安卓上永远是 `Some`，即使桥没接上（那时三个读数是"未知"）。
    /// 加它的原因与通知/前台服务这一族故障的性质一致：**失效全是静默的**，
    /// 用户说"锁屏后收不到"时，界面上必须有一个能区分"没跑/跑了但没前台地位/桥没接上"的出口。
    pub background: Option<crate::android_background::BackgroundDiag>,
}

#[tauri::command(async)]
pub async fn get_runtime_diag(state: State<'_, Arc<AppState>>) -> Result<RuntimeDiag, String> {
    let s = state.inner().clone();
    // `links` 是 async 锁 ⇒ 只能在 await 侧读；四个 COUNT 进阻塞池
    // （INV-P34：命令体即使标了 `(async)` 也跑在 tokio worker 上，db 读数不该留在 worker 里）。
    let links: usize = s
        .links
        .lock()
        .await
        .values()
        .filter(|v| !v.is_empty())
        .count();
    let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner()).len();
    let windows = s.app.webview_windows();
    let hidden_windows = windows
        .values()
        .filter(|w| !w.is_visible().unwrap_or(false))
        .count();
    let windows_total = windows.len();
    drop(windows);
    let db_hold_note = s
        .db_hold_note
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let counts = tokio::task::spawn_blocking(move || s.runtime_counts())
        .await
        .unwrap_or(crate::state::RuntimeCounts {
            sending_msgs: -1,
            outbox: -1,
            group_outbox: -1,
            file_outbox: -1,
        });
    Ok(RuntimeDiag {
        sending_msgs: counts.sending_msgs,
        outbox: counts.outbox,
        group_outbox: counts.group_outbox,
        file_outbox: counts.file_outbox,
        links,
        peers,
        windows: windows_total,
        hidden_windows,
        db_hold_note,
        notify_waiters: crate::notifications::click_waiters_used(),
        notify_waiters_max: crate::notifications::click_waiters_max(),
        background: crate::android_background::diag(),
    })
}

/// 启动 [`CACHE_CLEAN_FIRST_DELAY_SECS`] 后跑第一轮，之后每 [`CACHE_CLEAN_INTERVAL_SECS`]；
/// 清理走 `clean_files`，VACUUM 只在释放量过 [`CACHE_CLEAN_VACUUM_MIN_FREED_BYTES`] 时才做 ——
/// 整段在 spawn_blocking 里做：文件遍历/删除与偶发 VACUUM 都不该占用 tokio worker，
/// 更不跨 await 持 db 锁。手动那条（`clear_cache`）不受这个阈值约束：是用户按的，等得起。
pub fn spawn_cache_auto_clean(s: &std::sync::Arc<crate::state::AppState>) {
    // 只起一次（10-22 审计 R-07）。这条 loop 挂在 `network::start()` 末尾、且刻意不进 `tasks`
    // （见 `network/mod.rs`，所以 `stop()` 也收不掉它），而 `start()` 有多个生产入口：
    // 前端 `start_network`、`set_channel_enabled("lan", true)`、启动时的自动重试。
    // 没有这根闩，用户每拨一次 LAN 开关就永久多出一个清理器，它们全都排在**那唯一一条**
    // SQLite 连接上做 VACUUM ⇒ 症状是"反复开关通道之后，App 隔一会儿冻一下"。
    // 用 compare_exchange 而不是"先读再写"：两个入口可以并发进来，读判写之间会都放行。
    if s.cache_clean_started
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_err()
    {
        s.logger.info(
            "cache",
            "code=CACHE_CLEAN_ALREADY_RUNNING —— 清理器已在跑，本次启动请求被合并",
        );
        return;
    }
    let st = s.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(CACHE_CLEAN_FIRST_DELAY_SECS)).await;
        loop {
            let st2 = st.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let policy = load_policy(&st2);
                let dirs = cleanable_dirs(media_dirs(&st2), &st2.favorites_dir);
                let report = cache_cleaner::clean_files(&dirs, policy);
                let vacuumed = report.removed > 0 && cache_clean_should_vacuum(report.freed_bytes);
                // VACUUM 重写整份 db、期间持住唯一那条连接 ⇒ 用时与失败都必须说出来。
                // 计时在锁内、产日志在锁外：把 logger 的同步落盘塞进持锁区间是反方向。
                // 两个数分开报：`wait_ms` 是**排队等这把锁**，`exec_ms` 是拿到锁之后 VACUUM
                // 自己跑了多久。合成一个"用时"就读不出"这一下慢是因为别人握着，还是因为它真慢"。
                let vacuum_note = if vacuumed {
                    // 取锁 → 读等锁数 → **在这把锁里**跑带预算的 VACUUM → 出锁才拼话。
                    // 计时起点在 `vacuum_with_budget` 内部（它自己起表），所以它天然落在
                    // "已经拿到锁"之后 —— 这条不变量由本模块的源码形状判据钉住。
                    let (wait_ms, outcome) = {
                        let dbc = st2.db.lock().unwrap_or_else(|e| e.into_inner());
                        let wait_ms = dbc.wait_ms();
                        let outcome = crate::storage::vacuum::vacuum_with_budget(
                            &dbc,
                            crate::storage::vacuum::DEFAULT_VACUUM_BUDGET_MS,
                        );
                        (wait_ms, outcome)
                    };
                    format_vacuum_note(wait_ms, &outcome)
                } else {
                    VACUUM_SKIPPED_NOTE.to_string()
                };
                if report.removed > 0 {
                    // 三态都要留痕：做了多久、失败在哪儿、还是压根没做。
                    // 只说"已做/跳过"的话，盘上 db 没缩时读日志的人分不清阈值与失败。
                    st2.logger.info(
                        "storage",
                        format!(
                            "自动缓存清理：删 {} 个文件、释放 {} 字节，VACUUM {vacuum_note}",
                            report.removed, report.freed_bytes,
                        ),
                    );
                }
            })
            .await;
            // 周期 sleep 必须排在**动作之后**、且必须在循环**里面**：
            // 少了这一句就等于无间隔死循环（本仓刚踩过：把首轮 sleep 挪出循环时顺手删了周期那一句，
            // 结构判据只查"首轮在外面"，抓不到"循环里没有间隔"这一半 ⇒ 两条一起钉）。
            tokio::time::sleep(std::time::Duration::from_secs(CACHE_CLEAN_INTERVAL_SECS)).await;
        }
    });
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
pub async fn get_cache_info(state: State<'_, Arc<AppState>>) -> Result<CacheInfo, String> {
    let s = state.inner().clone();
    // `usage()` 是对媒体目录的**递归 walk**，`db_file_bytes` 还 stat 数据库文件：
    // 这条挂在设置页"缓存"那一行，打开设置就打 ⇒ 不能在 worker 上跑（审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<CacheInfo, String> {
        let policy = load_policy(&s);
        let (media_count, media_bytes) = cache_cleaner::usage(&media_dirs(&s));
        Ok(CacheInfo {
            media_count,
            media_bytes,
            db_bytes: db_file_bytes(&s),
            retention_days: policy.retention_days,
            max_bytes: policy.max_bytes,
        })
    })
    .await
    .map_err(|e| format!("缓存用量统计被线程池中断: {e}"))?
}

/// 设置缓存清理策略（保留时长 / 磁盘配额；`None` 或 `0` 表示不限制）。
#[tauri::command(async)]
pub async fn set_cache_policy(
    state: State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    retention_days: Option<u32>,
    max_bytes: Option<u64>,
) -> Result<(), String> {
    let s = state.inner().clone();
    const CHANGED: [&str; 2] = ["retentionDays", "maxBytes"];
    // 持锁段整块进阻塞池（审计 R-18）。`patch` 必须在**同一把锁里**读好
    // （`settings_patch_values` 的调用约定：广播的值要和刚写进去的那一份同源）。
    let patch = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let d = retention_days.unwrap_or(0);
        db::set_setting(&dbc, RETENTION_KEY, &d.to_string()).map_err(|e| e.to_string())?;
        let m = max_bytes.unwrap_or(0);
        db::set_setting(&dbc, MAX_BYTES_KEY, &m.to_string()).map_err(|e| e.to_string())?;
        Ok(settings_patch_values(&dbc, &CHANGED))
    })
    .await
    .map_err(|e| format!("缓存策略写入被线程池中断: {e}"))??;
    // 广播留在 await 之后：它给别的窗口发事件，不该占着 db 锁做。
    state.notify_settings_changed(&CHANGED, Some(window.label()), patch);
    Ok(())
}

/// 立即执行一次清理：按保留时长 / 配额删除过期的图片与文件（含历史遗留 cache 目录），
/// 并对数据库执行 VACUUM。**不删除聊天文字**；被清理的图片/文件在历史消息里将无法再打开。
#[tauri::command(async)]
pub async fn clean_cache_now(state: State<'_, Arc<AppState>>) -> Result<CleanupReport, String> {
    let s = state.inner().clone();
    let policy = load_policy(&s);
    let dirs = cleanable_dirs(media_dirs(&s), &s.favorites_dir);
    // 文件遍历/删除不碰 db：放 spawn_blocking（大缓存/慢盘上秒级起步）。
    // ⚠️ 绝不能持全局 db 锁做这件事（审计 2.1a 的旧形状）：期间全 App 的消息落库/
    // 发送/写好友全在排队等这把锁 —— 用户点一下"立即清理"，整个应用冻住。
    let mut report = match tauri::async_runtime::spawn_blocking(move || {
        cache_cleaner::clean_files(&dirs, policy)
    })
    .await
    {
        Ok(r) => r,
        Err(e) => {
            s.logger
                .error("cache", format!("缓存清理任务失败: {e}"));
            return Err(format!("缓存清理任务失败: {e}"));
        }
    };
    // VACUUM 只在真的删了文件时做，且锁只在 VACUUM 期间持有（与 6h 自动清理同纪律：
    // VACUUM 本身可能秒~分钟级，没删文件却空转一次等于白冻全 App 一次）。
    //
    // 决策 2：手动路径**同样有 3 秒预算** —— 用户按了按钮，界面照样不该被冻住。
    // 结局必须回到界面上（用户点了却看不到库变小会困惑）⇒ 塞进 `db_compact_state`，
    // 前端按码本地化一句话告诉他"整理完成"还是"超时已取消、内容完好、下次自动再试"。
    if report.removed > 0 {
        // VACUUM 进阻塞池（10-22 审计 R-19 的**手动**那一半）。
        // `s.db` 是那唯一一条连接的 `std::sync::Mutex`，而 `vacuum_with_budget` 是同步调用 ——
        // 留在 `pub async fn` 里就是"一个 tokio worker 被按住最长 3 秒，同时全 App 的读写排队"。
        // 上面 6h 自动那条早就走 spawn_blocking（同文件里就在旁边），手动这条是漏网的那个，
        // 而"点立即清理"恰恰是用户主动等结果的动作，冻住一个 worker 还会连带饿死别的任务。
        // 纪律与自动路径一致：锁只在 VACUUM 期间持有，拿到 outcome 立刻释放。
        let st2 = s.clone();
        let outcome = match tauri::async_runtime::spawn_blocking(move || {
            let dbc = st2.db.lock().unwrap_or_else(|e| e.into_inner());
            crate::storage::vacuum::vacuum_with_budget(
                &dbc,
                crate::storage::vacuum::DEFAULT_VACUUM_BUDGET_MS,
            )
        })
        .await
        {
            Ok(o) => o,
            Err(e) => crate::storage::vacuum::VacuumOutcome::Failed {
                exec_ms: 0,
                reason: format!("数据库整理任务被线程池中断: {e}"),
            },
        };
        report.db_compact_state = Some(outcome.state_code().to_string());
        if !outcome.is_completed() {
            s.logger
                .warn("cache", format!("手动清理：数据库整理未完成 —— {}", outcome.note()));
        }
    }
    Ok(report)
}

#[cfg(test)]
mod cache_clean_schedule_tests {
    use super::*;

    /// 收藏必须留在统计里、但**绝不出现在清理目标里**。
    /// 反面对照：把收藏一起传给 `plan_removal`，用户设了保留期就会删掉唯一副本。
    #[test]
    fn clean_targets_exclude_favorites_but_keep_counting_them() {
        let dl = PathBuf::from("/data/downloads");
        let cache = PathBuf::from("/data/cache");
        let fav = PathBuf::from("/data/favorites/media");
        let all = vec![dl.clone(), cache.clone(), fav.clone()];
        let clean = cleanable_dirs(all.clone(), &fav);
        assert_eq!(clean, vec![dl, cache], "清理目标只能是 downloads + cache");
        assert!(all.contains(&fav), "收藏仍要计入占用统计（否则配额是假数）");
        assert!(!clean.contains(&fav), "收藏被塞进清理目标 ⇒ 超期即删用户唯一副本");
    }

    /// 接线判据：两个清理出口都必须**经过** `cleanable_dirs`，占用统计那一格故意不过。
    ///
    /// 为什么纯函数用例不够：上面那条只证明"这个函数会把收藏摘掉"，不证明"生产路径调了它"。
    /// 把 `clean_files(&dirs, …)` 改回直接喂 `media_dirs(&s)`，纯函数用例照样全绿，
    /// 而用户的收藏副本会被按保留期删掉、且不可恢复（那是他唯一的一份）。
    #[test]
    fn every_cleanup_path_is_wrapped_by_cleanable_dirs() {
        let src = include_str!("channel.rs");
        // 两道"别把自己数进去"的闸，缺一不可：
        // ① 切到第一个 `#[cfg(test)]` 之前 —— 本判据自己的代码里就写着
        //    `"cache_cleaner::clean_files("` 与 `"cleanable_dirs(media_dirs("` 这两个字面量，
        //    连着测试体一起数会得出 3 / 3（实测过），于是断言"两个出口都包了"变成自证。
        // ② 剥整行注释 —— 说明文字里也出现这些形状。
        let code: String = src
            .split("#[cfg(test)]")
            .next()
            .unwrap_or("")
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n");
        let deletes = code.matches("cache_cleaner::clean_files(").count();
        let wrapped = code.matches("cleanable_dirs(media_dirs(").count();
        assert_eq!(deletes, 2, "清理出口应是两条（自动清理 loop + 手动立即清理），实测 {deletes}");
        assert_eq!(
            wrapped, deletes,
            "有 {deletes} 个删除出口、只有 {wrapped} 个包了 cleanable_dirs ⇒ \
             某条路径会把收藏一起删掉（纯函数用例看不见这个，它只判函数本身）"
        );
        // `media_dirs(` 在本册的用量 = 1 处定义 + 2 处被包住的删除出口 + 1 处占用统计。
        // 数字对不上就是"新增了第三个消费者"：要么它该包，要么这里是漏网。
        let consumers = code.matches("media_dirs(").count() - 1;
        assert_eq!(
            consumers,
            deletes + 1,
            "media_dirs 的消费者应是 {expected}（两个删除出口 + 一个统计），实测 {consumers}",
            expected = deletes + 1
        );
    }

    /// 阈值两侧：差一字节都不许 VACUUM（这条锁的代价是界面卡几秒，放宽的门槛必须钉住）。
    #[test]
    fn vacuum_only_when_the_freed_bytes_are_worth_rewriting_the_db() {
        assert!(!cache_clean_should_vacuum(0), "什么都没删 ⇒ 绝不重写整库");
        assert!(
            !cache_clean_should_vacuum(CACHE_CLEAN_VACUUM_MIN_FREED_BYTES - 1),
            "差一字节不算过阈值"
        );
        assert!(cache_clean_should_vacuum(CACHE_CLEAN_VACUUM_MIN_FREED_BYTES));
        assert!(cache_clean_should_vacuum(CACHE_CLEAN_VACUUM_MIN_FREED_BYTES * 4));
    }

    /// 那句话必须把"等锁"与"执行"报成两个数：合成一个"用时"就读不出慢的是别人还是 VACUUM。
    #[test]
    fn vacuum_note_keeps_wait_and_execution_apart() {
        use crate::storage::vacuum::VacuumOutcome;
        let done = format_vacuum_note(900, &VacuumOutcome::Completed { exec_ms: 20 });
        assert!(done.contains("执行 20ms"), "实得：{done}");
        assert!(done.contains("等锁 900ms"), "实得：{done}");
        assert!(
            !done.contains("920"),
            "两个数又被加成一个了：它把排队算进了 VACUUM 自己。实得：{done}"
        );
        let failed = format_vacuum_note(
            5,
            &VacuumOutcome::Failed {
                exec_ms: 800,
                reason: "disk I/O error".to_string(),
            },
        );
        assert!(
            failed.contains("执行 800ms") && failed.contains("等锁 5ms") && failed.contains("失败"),
            "实得：{failed}"
        );
        assert!(
            !VACUUM_SKIPPED_NOTE.contains("ms"),
            "跳过那一档根本没取锁，不该出现任何时长"
        );
    }

    /// 决策 2：被**我们自己**中止的那一档，措辞不许混进"失败"。
    ///
    /// 为什么要分开：用户点「立即清理」看到"失败"会以为数据库坏了；实际上库完好、
    /// 只是这次没压缩。"已中止……内容完好"才是该给用户的那句话。
    #[test]
    fn an_aborted_vacuum_never_reads_as_a_failure() {
        use crate::storage::vacuum::VacuumOutcome;
        let aborted = format_vacuum_note(12, &VacuumOutcome::Aborted { exec_ms: 3001 });
        assert!(aborted.contains("已中止"), "实得：{aborted}");
        assert!(aborted.contains("完好"), "实得：{aborted}");
        assert!(!aborted.contains("失败"), "实得：{aborted}");
        assert!(
            aborted.contains("3000ms"),
            "中止那一档必须报出预算上限，用户才知道下次还会不会再被中止。实得：{aborted}"
        );
    }

    /// 执行计时的**起点**必须排在取得锁之后、等待读数必须来自这把锁本身。
    ///
    /// 这条是按源码文本判形状（这里造不出真 VACUUM 的慢），把两行调回原位就当场红。
    /// 计时本身现在住在 `storage::vacuum::vacuum_with_budget` 内部（它自己起表），
    /// 所以这里要钉的是"**调用它的时候已经拿着锁**"。
    #[test]
    fn vacuum_execution_timer_starts_after_the_lock_is_held() {
        let src = include_str!("channel.rs");
        let at = src
            .find("let (wait_ms, outcome) = {")
            .expect("自动清理那段 VACUUM 的计时形状变了 ⇒ 这条判据要跟着改");
        let body = &src[at..src[at..].find("};").map(|e| e + at).unwrap_or(src.len())];
        let lock_at = body.find("st2.db.lock()").expect("函数里没有取锁");
        let wait_from_guard = body.find("dbc.wait_ms()").expect("等待没读这把锁自己的读数");
        let vacuum_at = body
            .find("vacuum_with_budget(")
            .expect("没有调带预算的 VACUUM");
        assert!(
            lock_at < wait_from_guard,
            "等锁的读数排在取锁之前 ⇒ 它量的不是这把锁的排队"
        );
        assert!(
            lock_at < vacuum_at,
            "VACUUM 排在取锁之前 ⇒ 它没在这把锁里跑（预算会管错对象，\
             而且「执行时长」会把别人的排队算进来）"
        );
    }

    /// 首轮必须排在 `loop` **外面**：那条 bug 的形状就是"sleep(6h) 是循环第一句"，
    /// 于是注释里的 60s 永远不会发生。这里按源码文本判形状，改名/改形状都会当场红。
    #[test]
    fn first_round_is_scheduled_before_the_loop_not_inside_it() {
        let src = include_str!("channel.rs");
        let at = src
            .find("pub fn spawn_cache_auto_clean")
            .expect("找不到 spawn_cache_auto_clean ⇒ 这条判据失去落点");
        let body = &src[at..src[at..].find("\n}\n").map(|e| e + at).unwrap_or(src.len())];
        let loop_at = body.find("loop {").expect("函数里没有 loop ⇒ 调度形状变了，判据要跟着改");
        let first_sleep = body
            .find("sleep(")
            .expect("函数里没有 sleep ⇒ 调度形状变了，判据要跟着改");
        assert!(
            first_sleep < loop_at,
            "首轮 sleep 又跑回循环里了 ⇒ 第一轮永远要等一个完整周期（就是这条 bug 的原形）"
        );
        assert!(
            body.contains("CACHE_CLEAN_FIRST_DELAY_SECS"),
            "首轮间隔没走那个常量 ⇒ 注释与代码会再次各说一套"
        );
        // 另一半：循环**里**必须有周期 sleep。把首轮挪出来时顺手删掉周期那一句，
        // 上面那条照样绿，而这棵树会无间隔转圈跑磁盘遍历 —— 那是比原 bug 更坏的结局。
        let inside = &body[loop_at..];
        assert!(
            inside.contains("CACHE_CLEAN_INTERVAL_SECS"),
            "循环体里没有周期 sleep ⇒ 自动清理变成无间隔死循环"
        );
    }
}
