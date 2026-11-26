//! 电源与锁屏探针（桌面端）：给 [`crate::runtime_profile`] 提供判据。
//!
//! ## 分档依据（用户 2026-11-26 拍板）
//!
//! | 情况 | 档位 | 依据 |
//! |---|---|---|
//! | 插电 + 前台 | Active | 完全维持现状 |
//! | 电池 + 前台 | Saver | 周期 ×3（温和档） |
//! | 锁屏 | Dormant | 停主动、留保活与收包 |
//!
//! ## 为什么锁屏要单独探，不能靠"窗口失焦"
//!
//! 锁屏时窗口在多数平台**仍然是"前台"**（macOS 上 `app_active` 不会因为锁屏变 false），
//! 所以只靠焦点判断会把锁屏当成 Active —— 而"人不在机器前"恰恰是最该省电的时刻。
//!
//! ## 平台覆盖（如实）
//!
//! - **macOS**：电源走 IOKit `IOPSGetProvidingPowerSourceType`，锁屏走
//!   `CGSessionCopyCurrentDictionary` 的 `CGSSessionScreenIsLocked`。两者都是手写 FFI
//!   （零新依赖），且本机可实测。
//! - **Windows**：电源走 `GetSystemPowerStatus`，锁屏走 `WTSQuerySessionInformationW`
//!   的 `WTSSessionInfoEx.SessionFlags`。**判定语义抽成纯函数**（[`session_flags_locked`] /
//!   [`on_ac_from_line_status`]）以便在没有 MSVC 的机器上单测；FFI 本身由 CI 交叉编译验证。
//! - **其它桌面（Linux 等）**：暂返回"插电 + 未锁屏"（即 Active），不降档 —— 宁可少省电，
//!   也不要在没有验证过的平台上乱降频。Linux 的 `/sys/class/power_supply` 与 logind
//!   的 `LockedHint` 留作后续，接口已在这里定型。
//! - **移动端**：不编译本模块（`#[cfg(desktop)]`）。Android/iOS 自己会冻结后台进程，
//!   我们再压一层只会被系统判定为异常并杀掉。
//!
//! ## 采样节奏
//!
//! Active/Saver 下 15s 采一次；Dormant 下 60s。采样是几个只读系统调用（微秒级），
//! 15s 一次的开销可以忽略。锁屏后最长 15s 才降档 —— 这段延迟换来的是"绝不在用户
//! 面前误降档"，值得。

use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::runtime_profile::{
    compose, profile, set_profile, Profile, ProfileGate, PROFILE_DEBOUNCE_MS,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod other;
#[cfg(target_os = "windows")]
mod windows;

/// 一次采样得到的系统状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot {
    /// `true` = 接着交流电（含"读不到电量信息"这种安全默认）。
    pub on_ac: bool,
    /// `true` = 屏幕已锁定。
    pub screen_locked: bool,
}

/// 采样间隔（非锁屏 / 锁屏）。
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(15);
pub const SAMPLE_INTERVAL_DORMANT: Duration = Duration::from_secs(60);

// ---------------- 纯判定（跨平台可测，不碰 FFI 类型） ----------------

/// Windows `SYSTEM_POWER_STATUS.ACLineStatus` → 是否插电。
///
/// `1` = 交流电，`0` = 电池，`255` = 未知（以及任何未来新增值）。未知**必须**当作插电：
/// 老机器/虚拟机上这个字段常年是 255，若把 255 当电池，用户会莫名其妙被降档。
#[cfg(any(target_os = "windows", test))]
pub fn on_ac_from_line_status(ac_line_status: u8) -> bool {
    ac_line_status != 0
}

/// Windows `WTSINFOEX_LEVEL1_W.SessionFlags` → 是否锁屏。
///
/// ⚠️ 这个 enum 的取值**是反的**（`WTS_SESSIONSTATE_LOCK = 0`、`UNLOCK = 1`），
/// 且文档里明确写了"不要用 `!flags` 判断"。现场踩过的坑：把 0 当成"未设置/未知"，
/// 结果锁屏时反而判成未锁屏。这里只认两个合法值，其余视为未锁屏（安全默认）。
#[cfg(any(target_os = "windows", test))]
pub fn session_flags_locked(flags: u32) -> bool {
    /// `WTS_SESSIONSTATE_LOCK`
    const LOCK: u32 = 0;
    /// `WTS_SESSIONSTATE_UNLOCK`
    const UNLOCK: u32 = 1;
    match flags {
        LOCK => true,
        UNLOCK => false,
        _ => false,
    }
}

/// 当前系统状态。探针失败一律按"插电 + 未锁屏"返回（安全默认：宁可少省电也不误降档）。
pub fn snapshot() -> Snapshot {
    #[cfg(target_os = "macos")]
    {
        macos::snapshot()
    }
    #[cfg(target_os = "windows")]
    {
        windows::snapshot()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        other::snapshot()
    }
}

// ---------------- 采样任务 ----------------

/// 用「给定的前台状态 + 一次新的电源采样」立刻重算档位。
///
/// 焦点切换走这条：`set_app_active` 本身已经过 2s 防抖，这里直接落定 ——
/// 否则用户切回前台要等最长 15s 采样周期才恢复全速（可感知的"卡一下"）。
///
/// ⚠️ 采样任务那边每轮会先 `ProfileGate::set_applied` 对齐，不会被这里"改回去"。
pub fn recompute_now(app_active: bool) {
    let snap = snapshot();
    set_profile(compose(app_active, snap.on_ac, snap.screen_locked));
}

/// 起一个后台采样任务：每 [`SAMPLE_INTERVAL`] 采一次，结论过防抖后写全局档位。
///
/// 只写 `runtime_profile` 的全局状态，**不持有任何业务锁**，也不做 IO（日志除外，
/// 只在真正切档时写一行）。所以它不会成为新的卡顿点。
///
/// 注册进 `worker_supervisor::RESIDENT_WORKERS`（名字 `power_profile`）：它是个
/// `loop { … }` 的常驻任务，句柄丢掉后一旦提前结束就没有任何人知道 ——
/// 表现是"省电功能悄悄失效，日志里一行都没有"。
pub fn spawn_power_profile(
    state: &std::sync::Arc<crate::state::AppState>,
) -> tauri::async_runtime::JoinHandle<()> {
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut gate = ProfileGate::new(profile());
        loop {
            // 焦点切换会直接改全局档位（`recompute_now`）⇒ 先对齐基准，
            // 否则这一轮会拿旧值当基准把档位改回去。
            gate.set_applied(profile());
            let snap = snapshot();
            let app_active = state.app_active.load(Ordering::Relaxed);
            let target = compose(app_active, snap.on_ac, snap.screen_locked);
            let now = crate::logging::now_ms();
            if gate.signal(target, now) {
                // 稳定期后再落定；这期间用户完全感知不到（降档只改"下一轮等多久"）。
                tokio::time::sleep(Duration::from_millis(PROFILE_DEBOUNCE_MS as u64)).await;
                if let Some(p) = gate.tick(crate::logging::now_ms()) {
                    if set_profile(p) {
                        state.logger.info(
                            "power",
                            format!(
                                "code=PROFILE_SWITCH profile={} on_ac={} locked={} app_active={}",
                                p.as_str(),
                                snap.on_ac,
                                snap.screen_locked,
                                app_active
                            ),
                        );
                    }
                }
            }
            let wait = if profile() == Profile::Dormant {
                SAMPLE_INTERVAL_DORMANT
            } else {
                SAMPLE_INTERVAL
            };
            tokio::time::sleep(wait).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ac_line_status_treats_unknown_as_ac() {
        assert!(on_ac_from_line_status(1), "1 = 交流电");
        assert!(!on_ac_from_line_status(0), "0 = 电池");
        assert!(
            on_ac_from_line_status(255),
            "255 = 未知，必须当作插电（否则虚拟机会被莫名降档）"
        );
        assert!(on_ac_from_line_status(7), "未来新增值按插电处理，只降不升");
    }

    #[test]
    fn session_flags_lock_is_zero_not_one() {
        assert!(session_flags_locked(0), "WTS_SESSIONSTATE_LOCK = 0");
        assert!(!session_flags_locked(1), "WTS_SESSIONSTATE_UNLOCK = 1");
        assert!(!session_flags_locked(99), "非法值按未锁屏处理（安全默认）");
    }

    /// 探针不可用（读不到任何状态）必须落到 Active：绝不能因为探针坏了就偷偷降档。
    #[test]
    fn probe_failure_keeps_active() {
        // 「读不到」在实现里统一回落成 (on_ac = true, locked = false)
        assert_eq!(compose(true, true, false), Profile::Active);
    }
}
