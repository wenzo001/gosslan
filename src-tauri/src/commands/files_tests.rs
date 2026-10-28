// 职责边界：`commands/files.rs` 里「打开/删除本地文件」那条目录边界的纯函数用例。
// 由 `files.rs` 末尾 `include!` 拼进 `commands` 模块 ⇒ 本文件的 mod 落在 `commands::files_gate_tests`
// （与同形的 `commands/helpers.rs` + `helpers_tests.rs` 一致）。
//
// 为什么必须有这一格：`open_file_native` 收到的 `path` 来自**消息内容**，也就是**对端可控**
// （`delete_file` 上方的注释自己就写着这个担忧，而那边已经加了闸）。本机点不出来"对端发一条
// 恶意 path"，所以这条只能靠纯函数判 —— 判的是分量比对，不是字符串前缀。
#[cfg(test)]
mod files_gate_tests {
    use super::{ledger_path_owns, path_under_any, transfer_id_of_owner};
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

    /* ---------------- SEC-01 / SOL-01：打开必须绑定到这条消息的传输台账 ---------------- */

    /// `file-{tid}` / `gfile-{tid}` 都要能还原出 tid；其它形状（合并转发、普通文本）返回 None。
    /// 前缀解析在这条链上只有一份，错一处就会把"无台账"误判成"有台账"。
    #[test]
    fn owner_prefix_maps_to_transfer_id() {
        assert_eq!(transfer_id_of_owner("file-t1"), Some("t1"));
        assert_eq!(transfer_id_of_owner("gfile-t1"), Some("t1"));
        for bad in ["merge-1", "t1", "file", "gfile", "", "GFile-t1"] {
            assert_eq!(
                transfer_id_of_owner(bad),
                None,
                "{bad} 不是文件消息的 msg_id 形状"
            );
        }
    }

    /// **SEC-01 的核心回归**：台账说这条消息的文件是 A，消息载荷却让本机打开 B
    /// （B 可以是下载目录里此前投递的 `.command`）⇒ 必须拒绝。
    /// 旧实现只比目录，A 与 B 同在 downloads 内时会放行。
    #[test]
    fn forged_payload_path_is_rejected_when_ledger_points_elsewhere() {
        let ledger = Path::new("/app/data/downloads/real.pdf");
        let forged = Path::new("/app/data/downloads/payload.command");
        assert_eq!(
            ledger_path_owns(forged, Some(ledger)),
            Err("OPEN_PATH_NOT_OWNED"),
            "载荷路径与台账不一致时必须拒绝"
        );
    }

    /// 合法路径：前端取的就是台账那一份，必须放行。
    #[test]
    fn ledger_owned_path_is_allowed() {
        let path = Path::new("/app/data/downloads/real.pdf");
        assert_eq!(ledger_path_owns(path, Some(path)), Ok(()));
    }

    /// 台账行不存在（群文件第一条进度之前、或纯 merge 内容）⇒ 未绑定的必须拒绝，
    /// 不能因为"查不到"就退化成"目录内都放行"。
    #[test]
    fn missing_ledger_row_is_unbound_not_allowed() {
        assert_eq!(
            ledger_path_owns(Path::new("/app/data/downloads/x.pdf"), None),
            Err("OPEN_PATH_UNBOUND")
        );
    }

    /// P0 #2 回归：三条「对端可控路径」出口必须**共用同一份**判据。
    ///
    /// 2026-10-27 复核暴露的形状正是"判据存在、但只在一条链上"：`open_file_native` 有
    /// 台账回绑，`copy_file`（另存为）与 `send_file_auto` / `send_group_file`（转发）
    /// 却只有 `is_file()`。这里按**调用点**钉出现次数，钉存在性挡不住"只接上一条"。
    #[test]
    fn save_as_and_forward_share_the_same_ownership_gate() {
        assert_eq!(
            include_str!("files.rs")
                .matches("owned_payload_rejection(")
                .count(),
            3,
            "files.rs：定义 1 + 打开 1 + 单聊转发 1"
        );
        assert_eq!(
            include_str!("helpers.rs")
                .matches("owned_payload_rejection(")
                .count(),
            1,
            "helpers.rs：另存为（copy_file）"
        );
        assert_eq!(
            include_str!("group_announcements.rs")
                .matches("owned_payload_rejection(")
                .count(),
            1,
            "group_announcements.rs：群转发"
        );
    }
}
