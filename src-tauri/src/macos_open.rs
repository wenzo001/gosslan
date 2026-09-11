//! 用系统默认应用打开本地文件（跨平台）。
//!
//! macOS 单独走 `NSWorkspace.openURL` 而非 `tauri-plugin-opener`：后者在 macOS 底层
//! 调 `open` crate → `Command::new("/usr/bin/open")`，而 **App Sandbox 禁止沙盒应用 fork
//! 外部可执行文件**，`/usr/bin/open` 会被拦 → 「打开文件失败」。`NSWorkspace.openURL`
//! 是纯 Foundation API，不 fork 子进程，沙盒应用允许调用。
//!
//! Windows / Linux 无沙盒，继续用 opener（`ShellExecuteW` / `xdg-open`）。

#[cfg(target_os = "macos")]
pub fn open_path_native(path: &std::path::Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    // 先做一次存在性检查：给「文件尚未同步 / 已被清理」一个明确的可行动错误，
    // 而不是让 NSWorkspace 返回一个笼统的 false。
    if !path.exists() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let workspace = NSWorkspace::sharedWorkspace();
    if workspace.openURL(&url) {
        Ok(())
    } else {
        Err("系统没有可打开此文件的默认应用".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_path_native(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}
