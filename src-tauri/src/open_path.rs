//! 用系统默认应用打开本地文件（跨平台）。三端各有一条真实踩过的坑，所以这里按平台分派。
//!
//! - **macOS**：走 `NSWorkspace.openURL` 而非 `tauri-plugin-opener`。后者在 macOS 底层
//!   调 `open` crate → `Command::new("/usr/bin/open")`，而 **App Sandbox 禁止沙盒应用 fork
//!   外部可执行文件**，`/usr/bin/open` 会被拦 → 「打开文件失败」。`NSWorkspace.openURL`
//!   是纯 Foundation API，不 fork 子进程，沙盒应用允许调用。
//! - **Android**：走 FileProvider + `ACTION_VIEW`（见 [`crate::android_open`]）。opener 在
//!   Android 上只有 `Intent(ACTION_VIEW, url.toUri())`，而应用私有目录的文件以 `file://`
//!   暴露会被系统直接拒绝（Android 7+ 的 `FileUriExposedException`）→「文件打开失败」。
//! - **Windows / Linux**：无沙盒，继续用 opener（`ShellExecuteW` / `xdg-open`）。

/// 打开一个本地文件。
///
/// 三个平台都**先做一次存在性检查**：文件还没同步完 / 已被清理时，用户该看到
/// 「文件不存在」，而不是一个笼统的「打开失败」。
pub fn open_path_native(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    open_existing(path)
}

#[cfg(target_os = "macos")]
fn open_existing(path: &std::path::Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let workspace = NSWorkspace::sharedWorkspace();
    if workspace.openURL(&url) {
        Ok(())
    } else {
        Err("系统没有可打开此文件的默认应用".to_string())
    }
}

#[cfg(target_os = "android")]
fn open_existing(path: &std::path::Path) -> Result<(), String> {
    // MIME 交给 Kotlin 侧按扩展名推断（`MimeTypeMap` 是系统表，比我们在 Rust 里维护一份准）。
    crate::android_open::open_path(&path.to_string_lossy(), "")
}

#[cfg(all(not(target_os = "macos"), not(target_os = "android")))]
fn open_existing(path: &std::path::Path) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// 在系统文件管理器里打开一个**目录**（FUNC-01 / SOL-04）。
///
/// 为什么不能和 [`open_path_native`] 共用一份实现：两条入口的差别就在 macOS 这一支。
/// 旧实现（`commands/share.rs` 的 `open_in_file_manager`）在 macOS 上 fork
/// `Command::new("open")` —— App Sandbox **禁止沙盒应用 fork 外部可执行文件**，
/// 于是「打开接收目录」点了毫无反应，也没有任何日志可查。
/// `NSWorkspace.openURL` 是纯 Foundation API，不 fork 子进程，沙盒应用允许调用。
pub fn open_dir_native(path: &std::path::Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("目录不存在：{}", path.display()));
    }
    open_existing_dir(path)
}

#[cfg(target_os = "macos")]
fn open_existing_dir(path: &std::path::Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let path_str = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path_str);
    let workspace = NSWorkspace::sharedWorkspace();
    if workspace.openURL(&url) {
        Ok(())
    } else {
        Err("系统文件管理器没有接受这个目录".to_string())
    }
}

#[cfg(all(
    not(target_os = "macos"),
    not(target_os = "android"),
    not(target_os = "ios")
))]
fn open_existing_dir(path: &std::path::Path) -> Result<(), String> {
    // Windows / Linux：没有沙盒，opener 分别走 `explorer` / `xdg-open`。
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn open_existing_dir(_path: &std::path::Path) -> Result<(), String> {
    // 移动端没有"文件管理器"这种东西：保持旧行为（命令可调用，但什么都不做）。
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::open_dir_native;

    /// FUNC-01 回归：目录不存在时必须**报错**，不能像旧实现那样
    /// `Command::new("open").spawn()` 后静默返回 `Ok(())`（用户只看到"点了没反应"）。
    #[test]
    fn open_dir_native_reports_a_missing_directory() {
        let missing = std::path::Path::new("/nonexistent/gosslan/open-dir-probe");
        let err = open_dir_native(missing).expect_err("目录不存在必须报错");
        assert!(err.contains("目录不存在"), "错误信息要能让用户看懂：{err}");
    }

    /// FUNC-01 回归（静态判据）：macOS 沙盒禁止 fork 外部进程，`/usr/bin/open`
    /// 那条路在安装包里必然失败。这条守卫钉住"打开目录"只走 `open_dir_native` 门面，
    /// 且发送侧源码里不再出现 `Command::new("open")`。
    #[test]
    fn opening_a_directory_never_forks_the_open_binary() {
        let share_src = include_str!("commands/share.rs");
        assert!(
            !share_src.contains("Command::new(\"open\")"),
            "打开目录不得再 fork /usr/bin/open（App Sandbox 会拒绝）"
        );
        assert!(
            share_src.contains("crate::open_path::open_dir_native"),
            "open_downloads_dir 必须走唯一打开门面 open_dir_native"
        );
    }
}
