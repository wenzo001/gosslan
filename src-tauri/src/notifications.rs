//! 系统通知（桌面直接用 notify-rust，移动端走 tauri-plugin-notification）。
//!
//! ## 为什么不直接用插件的 show()
//!
//! 插件的桌面实现把真正的一次 toast 放进 spawn，然后丢掉结果：
//!
//!   tauri::async_runtime::spawn(async move { let _ = notification.show(); });
//!   Ok(())
//!
//! 于是用户报“收不到通知”时，日志里连“有没有尝试发”都看不到，更别说失败原因。
//! Windows 上尤其要命：未安装的 exe、AUMID 未注册、专注助手（勿扰）都会让 toast
//! 静默失败；插件自己的平台说明也写着 “Only works for installed apps.”。
//!
//! 这里直接用同一个底层库 notify-rust（版本与插件一致），额外做三件事：
//! 1. 把错误**返回出来**（命令层能如实告诉用户，日志也会记）；
//! 2. 每次尝试都打一条 info（含标题），排障时能确认“到底调没调”；
//! 3. 后端也判一次 notify_enabled —— 好友申请/好友通过是**不经前端**的，
//!    只在命令层判开关会漏掉它们（用户关掉通知仍会被弹）。
//!
//! 平台细节与插件保持一致：
//! - Windows：只有**已安装**的包才设 AppUserModelID（target/debug|release 下不设，
//!   否则开发期会因没有对应开始菜单快捷方式而更糟）；
//! - macOS：先 set_application（dev 下用 Terminal 标识）。
//!
//! 移动端没有 notify-rust，继续走插件（通知上带 extra，供点击回调识别类型）。

use std::collections::HashMap;
use std::sync::Arc;

use crate::state::AppState;

/// 通知总开关（notify_enabled，缺省开）。
///
/// 与前端 app.notifyEnabled 是同一份持久化键；这里是后端也判一次的第二道闸门。
pub fn notifications_enabled(conn: &rusqlite::Connection) -> bool {
    crate::db::get_setting(conn, "notify_enabled")
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// 当前平台的通知排障说明（测试通知与失败日志里带上，避免“发不出去也不知道为什么”）。
pub fn platform_hint() -> &'static str {
    #[cfg(windows)]
    {
        "Windows：系统通知只对**已安装**的应用生效 —— 请用 NSIS 安装包安装、从开始菜单启动；         便携版 / cargo dev 下不会显示。若已安装仍收不到，检查「设置 → 系统 → 通知」里          Gosslan 是否被关闭、以及是否开了「专注助手 / 勿扰」。"
    }
    #[cfg(target_os = "macos")]
    {
        "macOS：请在「系统设置 → 通知」里允许 Gosslan（开发构建归属 Terminal）。"
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        "Linux：需要桌面通知守护进程（如 dunst / GNOME 通知）。"
    }
}

/// 桌面（macOS / Windows / Linux）：直接用 notify-rust，错误返回给调用方。
#[cfg(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
pub fn show(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();

    #[cfg(windows)]
    {
        use std::path::MAIN_SEPARATOR as SEP;
        if let Ok(exe) = std::env::current_exe() {
            let curr_dir = exe
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let in_dev = curr_dir.ends_with(format!("{SEP}target{SEP}debug"))
                || curr_dir.ends_with(format!("{SEP}target{SEP}release"));
            if !in_dev {
                notification.app_id(&identifier);
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            identifier.as_str()
        });
    }

    notification.show().map(|_| ()).map_err(|e| e.to_string())
}

/// 移动端：没有 notify-rust，继续走 tauri-plugin-notification。
#[cfg(not(any(
    target_os = "macos",
    windows,
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
pub fn show(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// 带 extra 的通知：桌面忽略 extra（notify-rust 无点击路由），移动端交给插件。
pub fn show_with_extra(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    extra: HashMap<String, String>,
) -> Result<(), String> {
    #[cfg(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        let _ = extra;
        show(app, title, body)
    }
    #[cfg(not(any(
        target_os = "macos",
        windows,
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app.notification().builder().title(title).body(body);
        for (k, v) in &extra {
            builder = builder.extra(k, v);
        }
        builder.show().map_err(|e| e.to_string())
    }
}

fn enabled(state: &Arc<AppState>) -> bool {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    notifications_enabled(&dbc)
}

fn log_result(state: &Arc<AppState>, title: &str, r: Result<(), String>) -> Result<bool, String> {
    match r {
        Ok(()) => {
            state
                .logger
                .info("notify", format!("已发送系统通知：{title}"));
            Ok(true)
        }
        Err(e) => {
            state.logger.warn(
                "notify",
                format!("系统通知发送失败：{e}（{}）", platform_hint()),
            );
            Err(e)
        }
    }
}

/// 尊重总开关的通知（前端消息通知走这里）。
///
/// 返回 Ok(false) 表示“用户关了通知，跳过”；Ok(true) 表示已提交给系统。
pub fn show_if_enabled(state: &Arc<AppState>, title: &str, body: &str) -> Result<bool, String> {
    if !enabled(state) {
        return Ok(false);
    }
    log_result(state, title, show(&state.app, title, body))
}

/// 尊重总开关 + 带 extra 的通知（好友申请走这里）。
pub fn show_extra_if_enabled(
    state: &Arc<AppState>,
    title: &str,
    body: &str,
    extra: HashMap<String, String>,
) -> Result<bool, String> {
    if !enabled(state) {
        return Ok(false);
    }
    log_result(state, title, show_with_extra(&state.app, title, body, extra))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        conn
    }

    #[test]
    fn notify_enabled_defaults_on_and_uses_the_same_key_as_the_frontend() {
        let conn = mem();
        assert!(notifications_enabled(&conn), "缺省必须是开（与前端 notifyEnabled 一致）");
        crate::db::set_setting(&conn, "notify_enabled", "0").unwrap();
        assert!(!notifications_enabled(&conn), "显式关掉必须生效");
        crate::db::set_setting(&conn, "notify_enabled", "1").unwrap();
        assert!(notifications_enabled(&conn));
    }

    #[test]
    fn platform_hint_is_never_empty() {
        assert!(!platform_hint().trim().is_empty());
        #[cfg(windows)]
        assert!(
            platform_hint().contains("已安装"),
            "Windows 的排障说明必须点出“只对已安装应用生效”"
        );
    }
}
