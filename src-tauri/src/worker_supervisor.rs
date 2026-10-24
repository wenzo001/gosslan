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
//! **刻意不去碰的两类**：
//! - `network::start` 管的那批连接/监听任务：它们有显式的 `stop()` + `await_tasks()` 生命周期，
//!   重启一个已被 stop 的任务会把"用户关了局域网"变成"局域网又自己起来了"。
//! - `spawn_group_history_sweeper`：它挂在"群文件台账一次性补账"那个延迟 20s 的启动作业里，
//!   搬出来会改变启动时序；要收编它得先单独确认时序，不在这条改动的半径内。
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
                        state.logger.error(
                            "worker",
                            format!(
                                "code=WORKER_GIVEUP worker={name} restarts={MAX_RESTARTS} —— \
                                 反复结束，不再自动拉起；它守的那条链现在没有兜底，重启应用才能恢复"
                            ),
                        );
                        false
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
        format!(
            "code=WORKER_WATCHDOG_STARTED workers={} tick_s={}",
            specs.len(),
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
            5,
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
