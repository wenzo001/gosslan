//! macOS 窗口外观定制：圆角 + 关掉与圆角不兼容的系统阴影。
//!
//! ## 为什么需要
//!
//! 项目所有平台用 `decorations: false` 自绘标题栏（`tauri.conf.json`），关掉了
//! 系统装饰。代价是 macOS 上：
//!   1. 窗口没有 macOS 默认的圆角（HIG：macOS 窗口默认就是圆角）
//!   2. Windows 11 上 Win DWM 仍会画圆角，所以 Win 看起来有圆角、Mac 看起来直角，
//!      跨平台观感割裂
//!
//! ## 圆角的正确做法
//!
//! ⚠️ `NSWindow` **没有** `setCornerRadius:` 这个方法（容易误以为有，Apple 文档里
//! NSWindow 只有 `hasShadow` / `invalidateShadow`，没有 `cornerRadius`）。真正公开的
//! 做法是给 `contentView` 的 layer 设圆角（StackOverflow 经典方案）：
//!
//! ```objc
//! view.wantsLayer = YES;
//! view.layer.cornerRadius = 10.0;
//! view.layer.masksToBounds = YES;
//! ```
//!
//! 阴影与圆角不兼容（NSWindow 的 shadow 画在窗口外，矩形 shadow 与圆角冲突），
//! 关掉 `hasShadow`。如需阴影，由 WebView 端根容器 CSS `box-shadow` 接管（后续可加 token）。
//!
//! 注意：contentView 圆角只裁内容层，窗口背景色（`backgroundColor`）仍是矩形。本应用
//! 窗口背景色与浅色主题内容色一致（`#edf1f6`），圆角外与内容同色，视觉上即圆角窗口；
//! 暗色主题下窗口静态背景仍是浅色，圆角处可能露出浅色边——这是 `decorations: false`
//! 自绘方案固有权衡（真透明窗口需 `macos-private-api`，会失去 App Store 上架资格）。

#[cfg(target_os = "macos")]
pub fn apply(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(raw) = window.ns_window() else { return };
    if raw.is_null() { return; }
    let ns_window: &NSWindow = unsafe { &*(raw as *mut NSWindow) };

    // 给 contentView 的 layer 设圆角（公开 API）。NSView / CALayer 类型由返回值
    // 推断，无需显式 import。
    if let Some(view) = ns_window.contentView() {
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            // 10.0 与系统窗口圆角观感一致（CGFloat 在 arm64 为 f64）。
            layer.setCornerRadius(10.0);
            layer.setMasksToBounds(true);
        }
    }

    // 关掉系统阴影（与圆角冲突）。objc2 0.6 的方法调用是安全的，无需 unsafe。
    ns_window.setHasShadow(false);
}
