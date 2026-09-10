//! macOS 原生菜单栏。
//!
//! 为什么需要：本应用为了自绘标题栏用了 `decorations: false`，于是**没有系统菜单栏**。
//! 而在 macOS 上菜单栏是基础体验的一部分（HIG *The menu bar*）：⌘Q 退出、⌘, 偏好设置、
//! ⌘W 关闭窗口、⌘M 最小化、以及标准的「编辑」菜单（撤销/剪切/复制/粘贴/全选），
//! 用户都会下意识地去按、去菜单里找。没有它，应用会显得"不像 Mac 应用"。
//!
//! 为什么只在 macOS 建：Windows / Linux 用的是自绘标题栏（无边框），
//! 在这些平台上加一条系统菜单条会顶在自绘标题栏之上，破坏已经调好的窗口布局。
//!
//! 失败处理：菜单属于"锦上添花"，**初始化失败不得阻断启动**（与托盘同一策略），
//! 只打印日志。快捷键另有前端兜底，不会因此完全失效。

use tauri::{
    menu::{MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter,
};

/// 菜单事件名（前端 `api/index.ts` 监听后转成 window 事件）。
const MENU_SETTINGS: &str = "menu://settings";
const MENU_ADD_FRIEND: &str = "menu://add-friend";
const MENU_SEARCH: &str = "menu://search";

/// 建立菜单栏并挂上事件监听。失败时返回 Err，**由调用方决定是否忽略**。
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    // ---- 应用菜单（macOS 上第一个子菜单自动成为应用菜单）----
    let app_menu = SubmenuBuilder::new(app, "Gosslan")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "settings",
            "偏好设置…",
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // ---- 编辑：标准项（转发给 WebView 的第一响应者）----
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // ---- 会话：本应用自己的动作 ----
    let session_menu = SubmenuBuilder::new(app, "会话")
        .item(&MenuItem::with_id(
            app,
            "add-friend",
            "添加好友…",
            true,
            Some("CmdOrCtrl+N"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "search",
            "搜索",
            true,
            Some("CmdOrCtrl+F"),
        )?)
        .build()?;

    // ---- 窗口：交给系统的标准项（⌘W / ⌘M / 全屏等）----
    // set_as_windows_menu_for_nsapp 让这个子菜单被识别为「窗口」菜单，
    // 系统会自动往里补窗口列表、并接管全屏/缩放等标准行为。
    let window_menu = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, None)?)
        .build()?;
    window_menu.set_as_windows_menu_for_nsapp()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&session_menu)
        .item(&window_menu)
        .build()?;
    app.set_menu(menu)?;

    // 自定义项 → 发事件给前端（统一由前端执行动作，避免菜单与快捷键两条路径行为不一致）
    let handle = app.clone();
    app.on_menu_event(move |_app: &AppHandle, event| match event.id().as_ref() {
        "settings" => {
            let _ = handle.emit(MENU_SETTINGS, ());
        }
        "add-friend" => {
            let _ = handle.emit(MENU_ADD_FRIEND, ());
        }
        "search" => {
            let _ = handle.emit(MENU_SEARCH, ());
        }
        _ => {}
    });

    Ok(())
}
