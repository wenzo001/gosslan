//! 敏感文件的 Unix 权限边界：只允许属主读写（`0600`）。
//!
//! 真实安装实测：`gosslan.db`、`-wal` 与日志文件都是 `0644`，同机其他用户可读；
//! 库里存着身份密钥与全部消息，日志里有 peer id、IP 与文件名。数据库、侧车、
//! 迁移备份与日志/崩溃现场统一走这里，避免每个写文件的地方各写一份 chmod。
//!
//! 失败只告警、不阻断：某些文件系统不支持 POSIX 权限，启动可用性优先；
//! 正常磁盘上由各模块的判据保证成功（`db::migration_tests` 与 `logging::tests`）。

#[cfg(unix)]
pub(crate) fn restrict_to_owner(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if !path.exists() {
        return;
    }
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("[gosslan-fs] 无法把 {} 收紧到 0600：{e}", path.display());
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_to_owner(_path: &std::path::Path) {}

/// Unix：把**专用数据目录**收紧到仅属主可进入/列出（`0700`）。
///
/// 文件是 `0600` 只挡住读取，挡不住同机其他用户 `ls` 出备份名/日志名/实例库名。
/// 只允许在生产启动路径对解析出的 app data 目录调用；测试里的共享临时目录不要调。
#[cfg(unix)]
pub(crate) fn restrict_dir_to_owner(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if !path.is_dir() {
        return;
    }
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)) {
        eprintln!(
            "[gosslan-fs] 无法把目录 {} 收紧到 0700：{e}",
            path.display()
        );
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_dir_to_owner(_path: &std::path::Path) {}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn restrict_dir_to_owner_sets_0700() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "gosslan-private-dir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        super::restrict_dir_to_owner(&dir);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700,
            "app data 目录必须收紧到 0700"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
