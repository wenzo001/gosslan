//! macOS 窗口外观定制：squircle 圆角 + 关掉与圆角不兼容的系统阴影。
//!
//! ## 为什么需要
//!
//! 项目所有平台用 `decorations: false` 自绘标题栏（`tauri.conf.json`），关掉了
//! 系统装饰。代价是 macOS 上：
//!   1. 窗口没有 macOS 默认的 squircle 圆角（HIG：macOS 窗口默认就是 squircle）
//!   2. Windows 11 上 Win DWM 仍会画圆角，所以 Win 看起来有圆角、Mac 看起来直角，
//!      跨平台观感割裂
//!
//! 两条出路：
//!   - A) macOS 恢复 `decorations: true` + `titleBarStyle: Overlay` + `hiddenTitle: true`，
//!     让系统接管圆角、阴影、交通灯。但 `decorations` 是单平台共用字段，没法做到
//!     「macOS true / Windows false」（WindowConfig 无平台子配置），会破坏 Windows 自绘。
//!   - B) 保留 `decorations: false`，运行时给 macOS 窗口调 `setCornerRadius:10.0`
//!     （borderless 窗口 macOS 10.15+ 有效），并 `setHasShadow:false`。
//!
//! 选 B：跨平台 `decorations` 配置不变（不破坏 Windows 自绘），只在 macOS 运行时定制。
//! 圆角是**圆角**（不是 squircle）—— macOS 12+ 的真 squircle 需要私有 API
//! (`setContinuousCorners:`)，对应用商店上架有风险；圆角对用户的视觉差异极小。
//!
//! 阴影：与圆角不兼容（NSWindow 的 shadow 画在窗口外，矩形 shadow 与圆角冲突）。
//! 改由 WebView 端根容器的 CSS `box-shadow` 接管（如需可后续加 token）。

#[cfg(target_os = "macos")]
pub fn apply(window: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // tauri 2 的 `ns_window()` 返回 `*mut c_void`（opaque objc 指针），
    // cast 成 `*mut AnyObject` 才能用 objc2 的 msg_send! 调方法。
    let Ok(raw) = window.ns_window() else { return };
    let ns_window = raw as *mut AnyObject;
    if ns_window.is_null() { return; }

    // 安全性：cast 后只通过 objc2 的 msg_send! 调方法，参数和 selector 都是编译期确定的。
    // NSWindow.setCornerRadius: 是 macOS 10.15+ 公开 API（selector 在 objc2 0.3.2
    // 未自动生成），用 msg_send! 手动调；CGFloat 在 arm64 上为 f64。
    // 10.0 是 macOS 系统窗口惯用值（与 Finder/Dock 窗口观感一致）。
    unsafe {
        let _: () = msg_send![ns_window, setCornerRadius: 10.0_f64];
    }

    // 关掉系统阴影：borderless 窗口的 shadow 画在窗口外，是矩形，破坏圆角观感。
    // 阴影改由 WebView 端根容器的 CSS box-shadow 接管（按需可后续加 token）。
    unsafe {
        let _: () = msg_send![ns_window, setHasShadow: false];
    }
}
