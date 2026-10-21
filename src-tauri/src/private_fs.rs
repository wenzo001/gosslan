//! 敏感文件与专用目录的 Unix 权限边界：文件只允许属主读写（`0600`），
//! 专用目录只允许属主进入（`0700`，新建时就直接带位，不等事后 chmod）。
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

/// 创建**私有目录**（Unix `0700`，其它平台交给各自的模型）。
///
/// 为什么不复用 `create_dir_all` + 事后 `restrict_dir_to_owner`：
/// `create_dir_all` 用的是进程 umask（真机实测 `022`），于是新建的 `logs/` 落地就是
/// `drwxr-xr-x` —— 从 mkdir 到 chmod 之间那段窗口里，同机其他用户已经能 `ls` 出
/// 日志文件名（里面带设备 id 与实例号）。`mkdir` 的 mode 参数只会被 umask **减**位，
/// `0o700` 在常见 umask（022/002/077）下原样生效。
///
/// ⚠️ 已存在的目录**不会被改写**（`recursive(true)` 撞到 EEXIST 就返回 Ok）。
/// 这是刻意的：`logging::tests::disk_write_failure_is_counted_and_noted_in_memory`
/// 靠"把目录调成不可写"来制造落盘失败，如果这里顺手 chmod 回去，那条判据的失败机制
/// 会被产品代码静默修好 ⇒ 变成空转。收紧**已存在**目录是 [`restrict_dir_to_owner`] 的活，
/// 只允许在启动路径上调用一次。
#[cfg(unix)]
pub(crate) fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

/// Windows：没有 POSIX mode 位。app data 落在 `%APPDATA%`（用户 profile 下），
/// 该树的 ACL 由系统只授给该用户与 SYSTEM，本来就等价于"仅当前用户可访问"；
/// 因此这里不做任何事，也不能拿 `0o700` 那套语义去"补"（`set_permissions` 在 Windows
/// 只影响只读位，改它反而会让用户以为权限被放开了）。
#[cfg(not(unix))]
pub(crate) fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn restrict_dir_to_owner_sets_0700() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::TempDir::new().unwrap();
        let dir = root.path().join("private");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        super::restrict_dir_to_owner(&dir);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700,
            "app data 目录必须收紧到 0700"
        );
    }

    /// `create_private_dir` 的两格必须分开证：**新建**时 mkdir 就带 0700，
    /// **已存在**时不许被改写（后一半是 `disk_write_failure_is_counted_and_noted_in_memory`
    /// 那条"目录调成只读"判据的生存前提）。只测前一半会放过一个"顺手 chmod 一切"的实现。
    #[cfg(unix)]
    #[test]
    fn create_private_dir_makes_0700_and_leaves_an_existing_dir_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mode_of = |p: &std::path::Path| -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };

        // ① 新建：不等事后 chmod
        let fresh = root.join("logs");
        super::create_private_dir(&fresh).unwrap();
        assert_eq!(
            mode_of(&fresh),
            0o700,
            "新建的日志目录必须 0700（实测 {:o} ⇒ mode 没传进 mkdir）",
            mode_of(&fresh)
        );

        // ② 已存在：不许顺手改写
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o500)).unwrap();
        super::create_private_dir(&fresh).unwrap();
        assert_eq!(
            mode_of(&fresh),
            0o500,
            "已存在的目录不能被 create_private_dir 改回去，否则只读目录那条落盘失败判据会被静默修好"
        );
    }
}
