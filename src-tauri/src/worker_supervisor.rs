//! 常驻 worker 的看门狗（审计 R-05）。
//!
//! **要治的那一格**：`AppState::spawn_*` 与 `spawn_outbox_sweeper` 全是
//! `tauri::async_runtime::spawn` 出来的无限循环，句柄在调用点被丢弃 —— 全仓此前
//! `is_finished` **0 命中**。`panic = "abort"` 下 panic 会杀整个进程，所以这里防的不是 panic，
//! 而是**任务被提前结束**：循环体 `return`/`break`（改代码时最容易漏的那一格）、
//! `abort()`（网络 stop 那条路曾对整个 tasks 列表干过）、或运行时异常收尾。
//!
//! 后果不对称，所以必须有人盯着：outbox 清扫器一死，`sending` 行就**再也没有终态出口**，
//! 用户看到的是"消息永远发送中直到重启"——而界面一切正常，没有任何信号。
//!
//! **不受监督的常驻循环**一律登记在 [`UNSUPERVISED_LOOPS`]（每条带理由）；一次性 spawn 在
//! [`ONE_SHOT_SPAWNS`]。判据 `every_spawn_fn_has_a_home` 要求：仓里每个 `fn spawn_*`、
//! 以及每处 `spawn(async move {` 都必须有归属且只属于一处 —— 新增常驻循环忘了登记会直接红。
//!
//! ⚠️ 这段以前写着"`spawn_group_history_sweeper` 刻意不碰"，而它（P1 #12）**早已被收编**
//! 进 [`RESIDENT_WORKERS`] —— 过期的是文档，不是代码（审计 B4-F2 的"文档漂"那一半）。
//!
//! **重启有上限**：每 10s 判一次活，同一个 worker 最多被拉起 [`MAX_RESTARTS`] 次
//! （含首次之外的次数）。反复秒退说明是代码坏了，再拉也是白拉，这时只留 error 一行。
//!
//! **第二层**（审计 REL-01，2026-10-24）：监督循环自己的句柄此前也被丢弃 —— 它静默结束后
//! "消息不收不发但界面正常"，没人发现、没人拉起。现在另有一条守护每 tick 判它是否已结束，
//! 结束就带 `code=WORKER_DEAD` 重启它，收口用的是**同一份** [`MAX_RESTARTS`] 闸与真值表。
//! 重启时复用同一张句柄表（[`SharedRunning`]）：新循环**接管**旧 worker，绝不重复 spawn。

use std::sync::Arc;

use tauri::async_runtime::JoinHandle;

use crate::state::AppState;

/// 判活周期。三档时间里它最短：worker 死掉到被发现，最多耽误一个周期。
const SUPERVISOR_TICK: std::time::Duration = std::time::Duration::from_secs(10);

/// 同一个 worker 允许被重新拉起的次数。超过就只告警、不再拉起（防"每周期重启一次"把 CPU 打满）。
const MAX_RESTARTS: u32 = 5;

/// 一个可被监督的常驻 worker。
///
/// `spawn` 必须是**幂等**的：重启就是再调一次 `spawn`。现有那几个都是
/// "拿 state → 起一个 loop"，重复调用只是多一条循环，不会重复注册监听。
pub struct WorkerSpec {
    /// 诊断名。日志与判据都读它，不从函数名现拼（改函数名不该改日志口径）。
    pub name: &'static str,
    pub spawn: fn(&Arc<AppState>) -> JoinHandle<()>,
}

/// 被监督的 worker 清单。**这是唯一一份名单**：`lib.rs` 只调 [`start`]，
/// 不再逐个直接 `spawn_*`（否则同一个 worker 会被起两次）。
pub static RESIDENT_WORKERS: &[WorkerSpec] = &[
    WorkerSpec {
        name: "peer_emitter",
        spawn: AppState::spawn_peer_emitter,
    },
    WorkerSpec {
        name: "outbox_retrier",
        spawn: AppState::spawn_outbox_retrier,
    },
    WorkerSpec {
        name: "runtime_diag_reporter",
        spawn: AppState::spawn_runtime_diag_reporter,
    },
    WorkerSpec {
        name: "db_hold_reporter",
        spawn: AppState::spawn_db_hold_reporter,
    },
    WorkerSpec {
        name: "outbox_sweeper",
        spawn: crate::network::transport::spawn_outbox_sweeper,
    },
    // 审计 P1 #12：群历史「待同步」清扫器原先直接 `spawn` 且句柄丢弃 —— 它一死，
    // "入群时没人在线"的那批群就永远等不到自动同步，而且没有任何人知道。
    WorkerSpec {
        name: "group_history_sweeper",
        spawn: crate::network::group_history::spawn_group_history_sweeper,
    },
];

/// **刻意不监督**的常驻循环：`(函数名, 为什么)`。每一条都在源码里真实存在，且都不在
/// [`RESIDENT_WORKERS`] 里。
///
/// 为什么用元组而不是带字段名的结构体：`why` 只给**判据与人**读，生产代码永远不碰它 ⇒
/// 结构体字段在 lib 构建里是 dead_code（`-D warnings` 直接红）。元组没有字段级分析。
pub static UNSUPERVISED_LOOPS: &[(&str, &str)] = &[
    (
        "spawn_supervisor",
        "它自己就是看门狗：第二层守护每 tick 判它是否结束，结束后带 code=WORKER_DEAD 重启",
    ),
    (
        "spawn_cache_auto_clean",
        "缓存自动清理按 retention 一天一趟，停了只影响「盘不缩」，不影响消息链路；重启一个已经跑完的它没有意义",
    ),
    (
        "spawn_part_sweeper",
        "每小时一趟的 .part / 中继内存态 / 静默接收器清扫；无状态（治的是永久泄漏，不是界面等待），重启无意义",
    ),
];

/// 一次性 spawn（不是常驻循环）。登记它只为让"每个 spawn 都有归属"这张清单完整。
pub static ONE_SHOT_SPAWNS: &[(&str, &str)] = &[
    ("spawn_sync", "按需替某个群拉历史，跑完即结束"),
    (
        "spawn_catch_up_after_hello",
        "Hello 之后补拉一轮，跑完即结束",
    ),
];

/// 对一个 worker 这一拍该做什么。单独拎出来是因为这是**整条监督逻辑的全部判据**，
/// 它必须有真值表 —— 写在内联分支里就没人测得到它。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerVerdict {
    /// 还活着（或还没开始跑）。
    Alive,
    /// 已经结束，可以再拉起。
    Restart,
    /// 反复结束，不再拉起。
    GiveUp,
}

pub fn verdict(is_finished: bool, restarts: u32) -> WorkerVerdict {
    if !is_finished {
        return WorkerVerdict::Alive;
    }
    if restarts < MAX_RESTARTS {
        WorkerVerdict::Restart
    } else {
        WorkerVerdict::GiveUp
    }
}

/// 运行中的一条记录：名字 / 重启用的 spawn 函数 / 当前句柄 / 已重启次数。
type RunningWorker = (
    &'static str,
    fn(&Arc<AppState>) -> JoinHandle<()>,
    JoinHandle<()>,
    u32,
);

/// 所有 supervisor 实例**共用**的句柄表（审计 REL-01）。
///
/// 为什么不是每个 supervisor 自己持有一份：二层守护会在监督循环结束后把它重新拉起，
/// 而旧 supervisor 手里的 worker 任务**不会**跟着结束（它们是 detached 的）。新实例若
/// 再 spawn 一遍清单，同一个 worker 就会跑两份 —— 推送/重放变成双倍频率，比死掉更难查。
/// 共享表让新实例**接管**旧句柄，只在句柄确实已结束时才重新 spawn。
type SharedRunning = Arc<std::sync::Mutex<Vec<RunningWorker>>>;

fn lock_running(running: &SharedRunning) -> std::sync::MutexGuard<'_, Vec<RunningWorker>> {
    // 与全仓纪律一致：锁中毒不 panic（transport 里一次中毒会带走整条循环）。
    running.lock().unwrap_or_else(|e| e.into_inner())
}

/// 监督循环本体。`start` 与二层守护都走这一个函数（重启 = 再调一次）。
///
/// 锁的边界：`sleep` 在锁外，锁内只有"判活 + 可能的重启"（均为同步调用，无 await）
/// —— 跨 await 持锁在本仓是明令禁止的（`links` 锁那次自锁死的教训）。
fn spawn_supervisor(state: Arc<AppState>, running: SharedRunning) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            tokio::time::sleep(SUPERVISOR_TICK).await;
            ticks += 1;
            let mut guard = lock_running(&running);
            // 每 30 拍（默认 5 分钟）留一行：与重启日志区分开，定期可被 grep 到。
            if ticks % 30 == 0 {
                state.logger.info(
                    "worker",
                    format!(
                        "code=WORKER_WATCHDOG_ALIVE supervised={} restarts={:?}",
                        guard.len(),
                        guard
                            .iter()
                            .map(|(n, _, _, r)| (*n, *r))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            guard.retain_mut(|(name, spawn, handle, restarts)| {
                match verdict(handle.inner().is_finished(), *restarts) {
                    WorkerVerdict::Alive => true,
                    WorkerVerdict::Restart => {
                        *restarts += 1;
                        state.logger.warn(
                            "worker",
                            format!(
                                "code=WORKER_RESTART worker={name} attempt={} —— 已结束，正在重启",
                                *restarts
                            ),
                        );
                        let spawn = *spawn;
                        *handle = spawn(&state);
                        true
                    }
                    WorkerVerdict::GiveUp => {
                        // 审计 P1 #11：原先这里**永久移除**该 worker —— `outbox_sweeper` 一死，
                        // 三条队列的终态出口就没人再跑，界面永久「发送中」直到重启应用。
                        // 改为"清零计数、保留监督"：下一拍按 Restart 重新拉起。
                        // 防 CPU 打满靠监督拍（10s）：真实崩溃循环最多每 10s 一次，且每次留一行
                        // WORKER_GIVEUP（可见、可查）。永久失守的代价远大于一条慢循环。
                        state.logger.error(
                            "worker",
                            format!(
                                "code=WORKER_GIVEUP worker={name} restarts={MAX_RESTARTS} —— \
                                 反复结束；已清零计数并保留监督，下一拍会再拉起（不再永久放弃）"
                            ),
                        );
                        *restarts = 0;
                        true
                    }
                }
            });
        }
    })
}

/// 把清单里的 worker 全部拉起，再起一条监督循环 + 一条**只盯监督循环自己**的守护。
///
/// 两层是必要的，也是这类设计的终点：守护者没人盯（它自己若结束，只可能是进程级问题）。
/// 这是**已知边界**，写在这里免得读的人以为漏了一层。
///
/// 审计 REL-01 补的就是第二层：此前监督循环连句柄都被丢弃，它自己静默退出后
/// "消息不收不发但界面正常"，没有任何日志、没有任何人拉起它。
pub fn start(state: &Arc<AppState>, specs: &'static [WorkerSpec]) {
    // 首次拉起：**只有这里会 spawn 清单**。二层守护重启监督循环时复用这张表。
    let running: SharedRunning = Arc::new(std::sync::Mutex::new(
        specs
            .iter()
            .map(|s| (s.name, s.spawn, (s.spawn)(state), 0))
            .collect(),
    ));
    // 活性证据（10-23 审计 P3-F）：看门狗自己不登记进清单 ——
    // 没有启动行与周期行时，"它到底还在不在"在日志里永远读不出来
    // （只在重启/放弃时说话，等于"安静可能是一切正常，也可能是它已经死了"）。
    state.logger.info(
        "worker",
        // `unsupervised` / `one_shot` 的规模进日志：两张登记表因此有生产读者
        // （否则它们只是测试夹具，`-D warnings` 会把它们当死代码），
        // 也让「哪些常驻循环受监督」在**运行时**一处可读（审计 B4-F2）。
        format!(
            "code=WORKER_WATCHDOG_STARTED workers={} unsupervised={} one_shot={} tick_s={}",
            specs.len(),
            UNSUPERVISED_LOOPS.len(),
            ONE_SHOT_SPAWNS.len(),
            SUPERVISOR_TICK.as_secs()
        ),
    );

    let mut supervisor = spawn_supervisor(state.clone(), running.clone());
    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut restarts: u32 = 0;
        loop {
            tokio::time::sleep(SUPERVISOR_TICK).await;
            // 复用 worker 那一份真值表（含 `MAX_RESTARTS` 闸）：守护者若自己再写一套
            // 阈值，两处的"反复退出"口径迟早不一致。
            match verdict(supervisor.inner().is_finished(), restarts) {
                WorkerVerdict::Alive => {}
                WorkerVerdict::Restart => {
                    restarts += 1;
                    st.logger.error(
                        "worker",
                        format!(
                            "code=WORKER_DEAD 监督循环已退出，正在重启（第 {restarts} 次）；\
                             已有 worker 句柄由新循环接管，不会重复拉起"
                        ),
                    );
                    supervisor = spawn_supervisor(st.clone(), running.clone());
                }
                WorkerVerdict::GiveUp => {
                    st.logger.error(
                        "worker",
                        format!(
                            "code=WORKER_DEAD 监督循环反复退出（已重启 {MAX_RESTARTS} 次），不再拉起 —— \
                             常驻 worker 从此无人看管，重启应用才能恢复"
                        ),
                    );
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 看门狗必须留**启动行**与**周期行**（10-23 审计 P3-F）。
    ///
    /// 这两行是"它还在不在"的唯一证据：只有重启/放弃日志时，安静既可能是正常、
    /// 也可能是它自己死了。判据读生产码（切掉本测试模块，避免把自己的字面量数进去）。
    #[test]
    fn watchdog_leaves_start_and_heartbeat_evidence() {
        let src = include_str!("worker_supervisor.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            prod.contains("code=WORKER_WATCHDOG_STARTED"),
            "看门狗启动必须留一行（否则重启次数全为 0 时，日志里没有任何\"它在跑\"的痕迹）"
        );
        assert!(
            prod.contains("code=WORKER_WATCHDOG_ALIVE"),
            "看门狗必须周期留一行：安静可能是一起正常，也可能是它已经死了"
        );
    }

    #[test]
    fn verdict_truth_table() {
        // 活着就是活着，重启次数再高也不碰它（不能因为历史次数去杀一个正在跑的任务）。
        assert_eq!(verdict(false, 0), WorkerVerdict::Alive);
        assert_eq!(verdict(false, MAX_RESTARTS), WorkerVerdict::Alive);
        // 结束了且还有额度 ⇒ 重启。
        assert_eq!(verdict(true, 0), WorkerVerdict::Restart);
        assert_eq!(verdict(true, MAX_RESTARTS - 1), WorkerVerdict::Restart);
        // 额度用光 ⇒ 放弃（这一格是防"每 10s 重启一次"的闸）。
        assert_eq!(verdict(true, MAX_RESTARTS), WorkerVerdict::GiveUp);
        assert_eq!(verdict(true, MAX_RESTARTS + 1), WorkerVerdict::GiveUp);
    }

    /// 「句柄已结束」这个**输入信号**必须真的成立 —— 否则 `verdict` 再对也只是读了一个常量。
    /// 用真实 tokio 任务证明两个方向：跑完的报 finished、还在等的报 not finished。
    #[tokio::test]
    async fn finished_signal_comes_from_the_real_handle() {
        let done = tokio::spawn(async {});
        // 让出一次，确保那条空任务真的被调度完。
        tokio::task::yield_now().await;
        assert!(
            done.is_finished(),
            "空任务跑完后句柄必须报 finished（否则监督永远看不见死亡）"
        );

        let parked = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });
        assert!(
            !parked.is_finished(),
            "还在等的任务不能被误判成已结束（会把它重启成两份）"
        );
        parked.abort();
    }

    /// 名单本身的判据：名字唯一、不是空表、每个都真的指向一个 `spawn_*` 函数。
    #[test]
    fn resident_worker_list_is_complete_and_unique() {
        assert_eq!(
            RESIDENT_WORKERS.len(),
            6,
            "被监督的常驻 worker 数量变了：要么是新增了一个（把它写进 RESIDENT_WORKERS 并更新这里），\
             要么是漏了一个（漏掉的那个死了没人知道）"
        );
        let mut names: Vec<&str> = RESIDENT_WORKERS.iter().map(|w| w.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            RESIDENT_WORKERS.len(),
            "worker 名字必须唯一（日志要按名字定位）"
        );
    }

    /// 接线判据（本仓踩过两次「逻辑全绿但没接上」）：`lib.rs` 必须**恰好调用一次** `start`，
    /// 而且不能再留任何一条直接 `spawn_*` 的老调用 —— 留着就是同一个 worker 起两份，
    /// 表现是"推送/重放突然变成双倍频率"，比死掉更难查。
    #[test]
    fn lib_rs_wires_the_supervisor_exactly_once() {
        let lib = include_str!("lib.rs");
        assert_eq!(
            lib.matches("worker_supervisor::start(").count(),
            1,
            "`worker_supervisor::start(` 必须恰好出现一次（0 = 整个监督没接线；2 = 起了两份）"
        );
        for legacy in [
            "state::AppState::spawn_peer_emitter(&state);",
            "state::AppState::spawn_outbox_retrier(&state);",
            "state::AppState::spawn_runtime_diag_reporter(&state);",
            "state::AppState::spawn_db_hold_reporter(&state);",
            "spawn_outbox_sweeper(state.clone());",
            "group_history::spawn_group_history_sweeper(&state);",
        ] {
            assert!(
                !lib.contains(legacy),
                "lib.rs 里还留着直接启动 `{legacy}` —— 它现在由 RESIDENT_WORKERS 统一拉起，\
                 两处都留着会让同一个 worker 跑两份"
            );
        }
    }

    /// 审计 REL-01：**监督循环自己也在被监督**。
    ///
    /// 此前监督循环的句柄被直接丢弃 —— 它静默结束后，worker 全都没人管，
    /// 但界面一切正常，日志里连一行都没有。这条判据钉住第二层真的存在：
    /// ① 判的是监督循环的句柄（不是又写一个自己永远不退出的循环）；
    /// ② 发现结束必须重启，并把**同一张**句柄表交出去；
    /// ③ 收口复用 worker 那份真值表（同一个 `MAX_RESTARTS` 闸）。
    #[test]
    fn supervisor_itself_is_supervised() {
        let src = include_str!("worker_supervisor.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];

        let guardian = &prod[prod.find("pub fn start(").expect("start 必须在")..];
        assert!(
            guardian.contains("verdict(supervisor.inner().is_finished(), restarts)"),
            "二层守护必须判**监督循环的句柄**：句柄不存/不判时，它死了没人知道"
        );
        assert!(
            guardian.contains("spawn_supervisor(st.clone(), running.clone())"),
            "发现监督循环已结束必须重启它，并把同一张句柄表传过去（接管，不重复 spawn）"
        );
        assert_eq!(
            guardian.matches("code=WORKER_DEAD").count(),
            2,
            "重启与放弃两格各要一条可检索日志（只有一处 = 另一种结局静默）"
        );
        // 活性证据不能断：监督循环的周期行 + 启动行都还在（10-23 审计 P3-F）。
        assert!(
            prod.contains("code=WORKER_WATCHDOG_STARTED")
                && prod.contains("code=WORKER_WATCHDOG_ALIVE"),
            "二层守护不能让原有活性证据消失"
        );
    }

    /// 每个 `fn spawn_*` 都必须有归属，且只属于一处（审计 B4-F2 的根治项）。
    ///
    /// 要治的那一格：新增一个常驻循环、裸 `spawn` 出去、句柄丢掉 —— 之后它停了没有任何信号
    /// （`.part` 只涨不降、被放弃的接收端永久留着）。所以分母不手抄：**从源码现解析**所有
    /// `fn spawn_*`，逐个要求出现在 `RESIDENT_WORKERS` / `UNSUPERVISED_LOOPS` /
    /// `ONE_SHOT_SPAWNS` 之一，且三处不能重复；反过来，登记表里的每个名字也必须真有定义
    /// （防"名字改过、表没改"的假绿）。
    #[test]
    fn every_spawn_fn_has_a_home() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // 生产源码 = 每个 .rs 里 `#[cfg(test)]` 之前的那一段（测试分册直接跳过）。
        let mut prod: Vec<(String, String)> = Vec::new();
        collect_rs(&root, &root, &mut prod);
        assert!(
            prod.len() > 50,
            "只读到 {} 个生产文件 ⇒ 走错了目录",
            prod.len()
        );

        let mut defined: Vec<String> = Vec::new();
        for (_, text) in &prod {
            for name in scan_spawn_names(text) {
                defined.push(name);
            }
        }
        defined.sort();
        defined.dedup();
        assert!(
            defined.len() >= 10,
            "只解析到 {} 个 `fn spawn_*` ⇒ 提取器失效",
            defined.len()
        );

        // 受监督的：从 RESIDENT_WORKERS 的 `spawn:` 字段现解析（函数指针拿不到名字）。
        let me = include_str!("worker_supervisor.rs");
        let me_prod = &me[..me.find("#[cfg(test)]").unwrap_or(me.len())];
        let mut resident: Vec<String> = me_prod
            .match_indices("spawn: ")
            .map(|(i, _)| {
                let rest = &me_prod[i + "spawn: ".len()..];
                let tail = rest.split([',', '\n']).next().unwrap_or("").trim();
                tail.rsplit("::").next().unwrap_or(tail).to_string()
            })
            .filter(|n| n.starts_with("spawn_"))
            .collect();
        resident.sort();
        assert!(
            resident.len() == RESIDENT_WORKERS.len(),
            "从源码解析到 {} 个受监督 spawn，而清单 {} 条 —— 解析口径或清单形状变了",
            resident.len(),
            RESIDENT_WORKERS.len()
        );

        let mut unsupervised: Vec<String> =
            UNSUPERVISED_LOOPS.iter().map(|d| d.0.to_string()).collect();
        let mut one_shot: Vec<String> = ONE_SHOT_SPAWNS.iter().map(|d| d.0.to_string()).collect();
        unsupervised.sort();
        one_shot.sort();

        // 每条登记都必须写得清「为什么」——不带理由的登记等于没登记。
        for (name, why) in UNSUPERVISED_LOOPS.iter().chain(ONE_SHOT_SPAWNS.iter()) {
            assert!(
                !why.trim().is_empty(),
                "`{name}` 登记成不监督/一次性，但没写理由 ⇒ 下一个人还是不知道该不该动它"
            );
        }

        // ① 每个定义都有归属。
        let orphan: Vec<&String> = defined
            .iter()
            .filter(|n| !resident.contains(n) && !unsupervised.contains(n) && !one_shot.contains(n))
            .collect();
        assert_eq!(
            orphan,
            Vec::<&String>::new(),
            "这些 `spawn_*` 既不受监督、也没登记为「刻意不监督 / 一次性」：{orphan:?}\n\
             ⇒ 它们停了没有任何信号（`.part` 只涨不降、被放弃的接收端永久留着）。\
             要么收编进 RESIDENT_WORKERS，要么在 UNSUPERVISED_LOOPS / ONE_SHOT_SPAWNS 里写清理由"
        );

        // ② 三张表互斥：同一名字出现在两处，说明登记本身已经不自洽。
        let mut all = resident.clone();
        all.extend(unsupervised.iter().cloned());
        all.extend(one_shot.iter().cloned());
        all.sort();
        let dup: Vec<&String> = all
            .windows(2)
            .filter(|w| w[0] == w[1])
            .map(|w| &w[0])
            .collect();
        assert_eq!(dup, Vec::<&String>::new(), "登记表里重复的名字：{dup:?}");

        // ③ 反向：登记表里的名字必须真有定义（改名/删除而表没改 = 假绿）。
        let stale: Vec<&String> = all.iter().filter(|n| !defined.contains(n)).collect();
        assert_eq!(
            stale,
            Vec::<&String>::new(),
            "登记表里有源码中不存在的名字：{stale:?}"
        );

        // 正控：提取器必须认得一个合成的新函数，且归属检查必须把它报成孤儿。
        let synthetic = "pub fn spawn_brand_new_loop(state: &Arc<AppState>) -> JoinHandle<()> {\n    todo!()\n}\n";
        let found = scan_spawn_names(synthetic);
        assert_eq!(
            found,
            vec!["spawn_brand_new_loop".to_string()],
            "提取器认不出新函数"
        );
        assert!(
            !resident.contains(&found[0])
                && !unsupervised.contains(&found[0])
                && !one_shot.contains(&found[0]),
            "合成的未登记函数竟然被认为有归属 ⇒ 上面那条在空集上恒绿"
        );
    }

    /// 递归读 `.rs`，跳过测试分册；每份只留 `#[cfg(test)]` 之前的生产段。
    fn collect_rs(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let entries = std::fs::read_dir(dir).expect("读目录");
        for e in entries {
            let p = e.expect("目录项").path();
            if p.is_dir() {
                collect_rs(root, &p, out);
                continue;
            }
            let name = p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "tests.rs" {
                continue;
            }
            // ⚠️ **不许**用「截到第一个 `#[cfg(test)]`」来切生产段：本仓有文件在**中段**
            // 就有 `#[cfg(test)]` 项（`state.rs` 的 `spawn_*` 全在它之后），截断会把半个
            // 生产文件当成测试代码（实测只解析到 7 个 `fn spawn_*`）。这里整份读，
            // 靠 `scan_spawn_names` 的逐行过滤挡掉测试里的字符串提及。
            let text = std::fs::read_to_string(&p).expect("读文件");
            out.push((
                p.strip_prefix(root).unwrap_or(&p).display().to_string(),
                text,
            ));
        }
    }

    /// 源码里所有 `fn spawn_<name>(` 的名字（按定义形状取，不手抄清单）。
    ///
    /// 逐行扫，跳过含引号的行与注释行：判据自己在别处用**字符串**找过某个 `spawn_*`
    /// 的完整签名（`group_file.rs` 的用例就是这么找的），不挡的话会把字符串里的提及当成定义。
    /// ⚠️ 连这段注释也不能写出完整签名串 —— `lib_outbox_tests` 的接线判据数的是
    /// 全文件出现次数，注释里多一处就会把它数成"接了两次"。
    fn scan_spawn_names(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for line in text.lines() {
            if line.contains('"') || line.trim_start().starts_with("//") {
                continue;
            }
            let mut from = 0usize;
            while let Some(i) = line[from..].find("fn spawn_") {
                let at = from + i + "fn ".len();
                let name: String = line[at..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                // 只认定义（名字后面紧跟 `(`）。
                let len = name.len();
                if line[at + len..].starts_with('(') {
                    out.push(name);
                }
                from = at + len.max(1);
            }
        }
        out
    }

    /// 重启监督循环时**接管**旧 worker，而不是再 spawn 一份。
    ///
    /// 旧 supervisor 结束后，它 spawn 的 worker 任务仍活着（detached）。若新实例按清单
    /// 再来一遍，每个 worker 就有两份 —— 推送/重放双倍频率，比死掉更难查。
    #[test]
    fn restarting_the_supervisor_adopts_worker_handles() {
        let src = include_str!("worker_supervisor.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert_eq!(
            prod.matches("(s.spawn)(state)").count(),
            1,
            "按清单 spawn 只许出现在 `start` 的首次填充里；多一处 = 重启时会重复拉起"
        );
        let from = prod.find("fn spawn_supervisor(").expect("spawn_supervisor");
        let to = prod.find("pub fn start(").expect("start");
        let body = &prod[from..to];
        assert!(
            !body.contains("specs"),
            "监督循环本体不许引用清单：它只接管共享句柄表，重拉 worker 由真值表驱动"
        );
    }
}
