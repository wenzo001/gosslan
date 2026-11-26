//! Windows 电源 / 锁屏探针。
//!
//! - 电源：`GetSystemPowerStatus`（`ACLineStatus`：0=电池 / 1=交流 / 255=未知）。
//! - 锁屏：`WTSQuerySessionInformationW(WTSSessionInfoEx)` 的 `SessionFlags`。
//!   这个 API 的取值是**反的**（`WTS_SESSIONSTATE_LOCK = 0`），判定语义在
//!   [`super::session_flags_locked`] 里（纯函数、本机可测），这里只负责取字段。
//!
//! ## 为什么不用 WTS 的"注册会话通知"（`WTSRegisterSessionNotification`）
//!
//! 那套要走窗口消息循环：必须把 `HWND` 注册进会话、在 `WM_WTSSESSION_CHANGE` 里改状态、
//! 窗口重建/销毁时还要 `WTSUnRegisterSessionNotification`，句柄生命周期一错就静默失效
//! （而且本仓的窗口会被 `tauri` 重建）。轮询这个只读查询每 15s 一次、微秒级，
//! 省掉一整套句柄生命周期管理 —— 对一个"省电"功能来说，**可靠性比实时性更重要**。
//!
//! ⚠️ 本文件只在 Windows 上编译。类型名/字段名已用独立 scratch crate 做 `cargo check`
//! 验证过（见 `docs/architecture/runtime-profile.md` 的验证一节），改这里必须重跑那一步。

use super::{on_ac_from_line_status, session_flags_locked, Snapshot};
use std::ffi::c_void;
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
};

pub fn snapshot() -> Snapshot {
    Snapshot {
        on_ac: on_ac(),
        screen_locked: screen_locked(),
    }
}

/// 是否接着交流电。读不到（含老系统/虚拟机返回 255）一律当作插电。
fn on_ac() -> bool {
    // SAFETY: `SYSTEM_POWER_STATUS` 是 POD，零初始化即合法；只写不读，由返回码决定是否采用。
    let mut st: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    // SAFETY: 传的是我们自己栈上的有效指针。
    let ok = unsafe { GetSystemPowerStatus(&mut st) };
    if ok == 0 {
        return true;
    }
    on_ac_from_line_status(st.ACLineStatus)
}

/// 屏幕是否已锁定。读不到一律按"未锁屏"（安全默认：不降档）。
fn screen_locked() -> bool {
    // SAFETY: 全部指针来自本函数栈；成功返回的 buffer 由 `WTSFreeMemory` 归还。
    unsafe {
        let mut buf: *mut u16 = std::ptr::null_mut();
        let mut bytes: u32 = 0;
        let ok = WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buf,
            &mut bytes,
        );
        if ok == 0 || buf.is_null() {
            return false;
        }
        let info = buf as *const WTSINFOEXW;
        let flags = if (*info).Level == 1 {
            (*info).Data.WTSInfoExLevel1.SessionFlags
        } else {
            // 不是 level 1（未来版本新增层级）⇒ 按解锁处理（1 = UNLOCK），不猜。
            1
        };
        WTSFreeMemory(buf as *mut c_void);
        session_flags_locked(flags as u32)
    }
}
