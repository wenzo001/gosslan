//! macOS 窗口外观定制：圆角 + 关系统阴影 + 背景色跟随主题。
//!
//! ## 关键时序（务必理解，否则圆角不生效）
//!
//! 项目用 `decorations: false` 自绘标题栏。Tauri 的窗口是 `visible: false` 创建的，
//! wry 在**窗口显示时才**创建 WKWebView，并用 `WryWebViewParent`（自定义 NSView）
//! **替换** NSWindow 的 contentView（`ns_window.setContentView(Some(&parent_view))`）。
//!
//! 因此在 `setup` 里拿到的 `contentView()` 是**默认视图**，给它设圆角会在 wry 替换时
//! **丢失**。正确时机是 **WebView 加载完成之后**（由前端 onMounted 调 `apply_rounded_corners`
//! 命令触发），此时 `contentView()` 已是 wry 的 parent_view，圆角才能裁到 WKWebView。
//!
//! ## 圆角的正确做法
//!
//! ⚠️ `NSWindow` **没有** `setCornerRadius:`（cornerRadius 是 CALayer 的属性，不是 NSWindow 的）。
//! 正确做法是给 contentView 的 layer 设圆角（StackOverflow 经典方案）：
//!
//! ```objc
//! view.wantsLayer = YES;
//! view.layer.cornerRadius = 10.0;
//! view.layer.masksToBounds = YES;
//! ```
//!
//! ## 背景色跟随主题
//!
//! contentView 圆角只裁内容层，圆角外露出 NSWindow 的 backgroundColor（tauri.conf.json
//! 写死浅色 `#edf1f6`）——暗色主题下就成了"白角"。故运行时按主题把窗口背景色设成
//! 与 `--gosslan-bg` 一致的浅/深色（浅 `#f1f5f9` / 深 `#0f172a`），圆角外与内容同色。
//!
//! 真透明窗口（圆角外透出桌面）需 `macos-private-api`，会失去 App Store 上架资格，
//! 故不采用。

#[cfg(target_os = "macos")]
pub fn disable_shadow(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;

    let Ok(raw) = window.ns_window() else { return };
    if raw.is_null() { return; }
    let ns_window: &NSWindow = unsafe { &*(raw as *mut NSWindow) };
    // 系统阴影画在窗口外、是矩形，与圆角冲突；在 setup 阶段即可关（NSWindow 级，不被 wry 替换）。
    ns_window.setHasShadow(false);
}

/// WebView 加载完成后（前端 onMounted 触发命令）调用：设背景色 + contentView 圆角。
#[cfg(target_os = "macos")]
pub fn apply_rounded_corners(window: &tauri::WebviewWindow, dark: bool) -> Result<(), String> {
    use objc2_app_kit::{NSColor, NSWindow};

    let raw = window.ns_window().map_err(|e| e.to_string())?;
    if raw.is_null() {
        return Err("NSWindow 指针为空".into());
    }
    let ns_window: &NSWindow = unsafe { &*(raw as *mut NSWindow) };

    // 背景色跟随主题（与 style.css 的 --gosslan-bg 一致：浅 #f1f5f9 / 深 #0f172a），
    // 消除暗色主题下圆角外露浅色（"白角"）。
    let (r, g, b) = if dark {
        (15.0 / 255.0, 23.0 / 255.0, 42.0 / 255.0)
    } else {
        (241.0 / 255.0, 245.0 / 255.0, 249.0 / 255.0)
    };
    let color = NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0);
    ns_window.setBackgroundColor(Some(&color));

    // contentView（此时已是 wry 的 WryWebViewParent）圆角。
    if let Some(view) = ns_window.contentView() {
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            layer.setCornerRadius(10.0);
            layer.setMasksToBounds(true);
        }
    }

    Ok(())
}
