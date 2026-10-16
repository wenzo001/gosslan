// 职责边界：`commands/files.rs` 里「打开/删除本地文件」那条目录边界的纯函数用例。
// 由 `files.rs` 末尾 `include!` 拼进 `commands` 模块 ⇒ 本文件的 mod 落在 `commands::files_gate_tests`
// （与同形的 `commands/helpers.rs` + `helpers_tests.rs` 一致）。
//
// 为什么必须有这一格：`open_file_native` 收到的 `path` 来自**消息内容**，也就是**对端可控**
// （`delete_file` 上方的注释自己就写着这个担忧，而那边已经加了闸）。本机点不出来"对端发一条
// 恶意 path"，所以这条只能靠纯函数判 —— 判的是分量比对，不是字符串前缀。
#[cfg(test)]
mod files_gate_tests {
    use super::path_under_any;
    use std::path::Path;

    /// 自家目录之内必须放行。
    #[test]
    fn allows_files_inside_a_managed_dir() {
        let roots = vec![std::path::PathBuf::from("/app/data/downloads")];
        assert!(
            path_under_any(Path::new("/app/data/downloads/photo.png"), &roots),
            "收到的文件就在托管目录里，打开必须能成"
        );
    }

    /// 目录外一律拒绝 —— 含 Windows 侧最典型的两种写法。
    #[test]
    fn rejects_paths_outside_every_managed_dir() {
        let roots = vec![
            std::path::PathBuf::from("/app/data/downloads"),
            std::path::PathBuf::from("/app/data/cache"),
        ];
        for bad in [
            "C:/Windows/System32/cmd.exe",
            "/etc/passwd",
            "\\\\attacker\\share\\x.docx",
        ] {
            assert!(
                !path_under_any(Path::new(bad), &roots),
                "{bad} 不在托管目录内，不许交给系统默认应用"
            );
        }
    }

    /// **按分量**比，不是按字符串前缀：`downloads_evil` 不许被 `downloads` 放行。
    /// 这条是这一格里唯一会被"随手写成 starts_with 字符串比对"放过去的形状。
    #[test]
    fn sibling_dir_with_the_same_prefix_is_not_allowed() {
        let roots = vec![std::path::PathBuf::from("/app/data/downloads")];
        assert!(
            !path_under_any(Path::new("/app/data/downloads_evil/x.png"), &roots),
            "同前缀的隔壁目录不是自家目录"
        );
    }

    /// 多格托管目录里任意一格都算自家（收藏/缓存/合并转发暂存各有自己的合法用例）。
    #[test]
    fn any_of_several_managed_dirs_matches() {
        let roots = vec![
            std::path::PathBuf::from("/app/data/downloads"),
            std::path::PathBuf::from("/app/data/favorites/media"),
            std::path::PathBuf::from("/app/data/cache"),
        ];
        assert!(path_under_any(Path::new("/app/data/favorites/media/a.jpg"), &roots));
        assert!(path_under_any(Path::new("/app/data/cache/b.png"), &roots));
        assert!(!path_under_any(Path::new("/home/u/Desktop/c.docx"), &roots));
    }

    /// 空目录清单必须判"不放行" —— 否则 canonicalize 失败退化成空表时，边界会被静默打开。
    #[test]
    fn empty_root_list_denies_everything() {
        assert!(!path_under_any(
            Path::new("/app/data/downloads/a.png"),
            &[],
        ));
    }
}
