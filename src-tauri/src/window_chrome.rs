//! 窗口外壳在 Windows 上的**系统级**对齐（用户 2026-11-20）。
//!
//! ## 为什么需要
//! macOS 的圆角与阴影由 AppKit 给（`NSWindow` 自带），Windows 在 `decorations: false`
//! 下是**直角** —— 同一份 CSS 圆角在两端观感就不一样：Windows 的方角露在 CSS 圆角外侧，
//! 外层那圈细边与玻璃质感也对不上。
//!
//! 系统给的做法是 DWM 的 `DWMWA_WINDOW_CORNER_PREFERENCE`（Windows 11 22000+）：
//! 设成 `DWMWCP_ROUND` 后由合成器裁剪整窗，阴影跟着圆角走 —— 与 macOS 一致。
//!
//! ## 失败一律降级、绝不拦路（用户要求：系统调用失败就兜底）
//! Win10 / 组策略 / 调用被拒 ⇒ 返回 `Err`，调用方只记一条日志，外观保持现状（直角）。
//! 这里**不 panic、不重试、不阻塞启动**：窗口能不能用，比圆角重要。
//!
//! ## 为什么不顺手改 JS 里的半径
//! 圆角是由合成器裁的，CSS 那层只需要不再画超出裁剪的面。先只上系统能力，
//! 观感差异等真机确认后再动 CSS —— 没有 Windows 机器时改 CSS 只能靠猜。

/// `DWMWA_WINDOW_CORNER_PREFERENCE`（dwmapi.h 的枚举值 33）。
#[cfg(target_os = "windows")]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
/// `DWMWCP_ROUND`（四角小圆角，与 Win11 原生窗口一致）。
#[cfg(target_os = "windows")]
const DWMWCP_ROUND: i32 = 2;

/// 给一扇窗套上系统圆角。非 Windows 直接返回 `Ok`（调用方不必写 cfg）。
#[cfg(target_os = "windows")]
pub fn apply(win: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = win.hwnd().map_err(|e| format!("拿不到 HWND: {e}"))?;
    // tauri 的 HWND 来自 `windows` crate（newtype 里是 `*mut c_void`），
    // windows-sys 用的是裸指针别名 ⇒ 取内层指针即可，不需要额外的 crate 依赖。
    let raw = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    apply_rounding(raw)
}

/// 真正的调用（单独一层，便于在**非 Windows** 机器上做类型检查：
/// windows-sys 在 mac 上也能编译，见 `docs` 里"Windows 专属逻辑抽成纯函数"的做法）。
#[cfg(target_os = "windows")]
fn apply_rounding(hwnd: windows_sys::Win32::Foundation::HWND) -> Result<(), String> {
    let pref = DWMWCP_ROUND;
    // SAFETY: `hwnd` 来自 `WebviewWindow::hwnd()`（窗口在我们手里且尚未销毁）；
    // 传入的缓冲区是栈上的 `i32`，长度按 `size_of::<i32>()` 给，DWM 只按长度读。
    let hr = unsafe {
        windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const i32 as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };
    if hr < 0 {
        // Win10 上是 E_INVALIDARG（这个属性不认识）—— 正常降级，不是故障。
        return Err(format!("DwmSetWindowAttribute(圆角) 失败 hr=0x{hr:08X}"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply(_win: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}
