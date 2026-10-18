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
