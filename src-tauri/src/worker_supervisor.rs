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

/// 把清单里的 worker 全部拉起，再起一条**永久的**看门狗。
///
/// 看门狗自己不登记进清单：监督者死了没人监督它，这是这类设计的固有边界，
/// 写在这里免得读的人以为漏了一层。
pub fn start(state: &Arc<AppState>, specs: &'static [WorkerSpec]) {
    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut running: Vec<RunningWorker> = specs
            .iter()
            .map(|s| (s.name, s.spawn, (s.spawn)(&st), 0))
            .collect();
        loop {
            tokio::time::sleep(SUPERVISOR_TICK).await;
            running.retain_mut(|(name, spawn, handle, restarts)| {
                match verdict(handle.inner().is_finished(), *restarts) {
                    WorkerVerdict::Alive => true,
                    WorkerVerdict::Restart => {
                        *restarts += 1;
                        st.logger.warn(
                            "worker",
                            format!("常驻 worker `{name}` 已结束，正在重启（第 {} 次）", *restarts),
                        );
                        let spawn = *spawn;
                        *handle = spawn(&st);
                        true
                    }
                    WorkerVerdict::GiveUp => {
                        st.logger.error(
                            "worker",
                            format!(
                                "常驻 worker `{name}` 反复结束（已重启 {MAX_RESTARTS} 次），不再自动拉起 —— \
                                 它守的那条链现在没有兜底，重启应用才能恢复"
                            ),
                        );
                        false
                    }
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
