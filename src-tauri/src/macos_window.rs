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
//! 与 body 实际底色 `--gosslan-app-bg` 一致的浅/深色（浅 `#edf1f6` / 深 `#0b1220`），
//! 圆角外与内容同色、零色差（早期误用 `--gosslan-bg` `#f1f5f9`/`#0f172a`，比 body 亮
//! 一档，圆角外透出"淡淡一层"）。
//!
//! 真透明窗口（圆角外透出桌面）需 `macos-private-api`，会失去 App Store 上架资格，
//! 故不采用（用户已确认优先保持上架资格）。

/**
 * macOS：把窗口改成「透明标题栏 + 全尺寸内容」，露出**系统原生**的红绿灯。
 *
 * 用户 2026-10-23：「那三颗键用原生的，不要自己画；每个窗口都用同一套」。之前是
 * `decorations: false` + 前端自绘三颗圆点（`TitleBar.vue`），于是：
 *   · 自绘的按下态/失焦变灰/悬停符号都要自己复刻，永远差一口气；
 *   · borderless 窗口的系统阴影是**矩形**，与 contentView 的 10px 圆角冲突 ⇒ 旧代码只能
 *     调 `setHasShadow(false)` 把阴影整个关掉（用户同日：「整个软件没有阴影」）。
 *
 * 现在补 `Titled` 位并打开 `FullSizeContentView`：内容区仍铺满整窗（不会凭空少 28px），
 * 标题栏透明、标题隐藏，三颗键由 AppKit 画；titled 窗口的系统阴影是**圆角**的，与
 * contentView 的圆角一致 ⇒ 阴影可以打开，且窗口与桌面背景之间的边界重新出现。
 *
 * ⚠️ 必须在**主线程**调用（AppKit）；`lib.rs` 的 setup 与 `decorate_aux_window` 都已经在主线程上。
 * ⚠️ 前端 `TitleBar.vue` 在 macOS 上不再画那三颗圆点，改用等宽占位让出系统按钮的位置。
 */
#[cfg(target_os = "macos")]
pub fn use_native_titlebar(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility};

    let Ok(raw) = window.ns_window() else { return };
    if raw.is_null() {
        return;
    }
    let ns_window: &NSWindow = unsafe { &*(raw as *mut NSWindow) };

    let mask = ns_window.styleMask()
        | NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    ns_window.setStyleMask(mask);
    ns_window.setTitlebarAppearsTransparent(true);
    ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    // 圆角阴影（见函数注释）：borderless 才需要关，titled 之后应当打开。
    ns_window.setHasShadow(true);
    for button in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(btn) = ns_window.standardWindowButton(button) {
            btn.setHidden(false);
        }
    }
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

    // 背景色跟随主题（与 body 实际底色 --gosslan-app-bg 一致：浅 #edf1f6 / 深 #0b1220），
    // 圆角外与内容同色、零色差（早期误用 --gosslan-bg #f1f5f9/#0f172a，比 body 亮一档，
    // 圆角外透出"淡淡一层"）。透明需 macos-private-api（会失去 App Store 上架资格），不采用。
    let (r, g, b) = if dark {
        (11.0 / 255.0, 18.0 / 255.0, 32.0 / 255.0)
    } else {
        (237.0 / 255.0, 241.0 / 255.0, 246.0 / 255.0)
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
