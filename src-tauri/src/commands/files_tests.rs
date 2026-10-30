// 职责边界：`commands/files.rs` 里「打开/删除本地文件」那条目录边界的纯函数用例。
// 由 `files.rs` 末尾 `include!` 拼进 `commands` 模块 ⇒ 本文件的 mod 落在 `commands::files_gate_tests`
// （与同形的 `commands/helpers.rs` + `helpers_tests.rs` 一致）。
//
// 为什么必须有这一格：`open_file_native` 收到的 `path` 来自**消息内容**，也就是**对端可控**
// （`delete_file` 上方的注释自己就写着这个担忧，而那边已经加了闸）。本机点不出来"对端发一条
// 恶意 path"，所以这条只能靠纯函数判 —— 判的是分量比对，不是字符串前缀。
#[cfg(test)]
mod files_gate_tests {
    use super::{inspect_drop_paths_blocking, ledger_path_owns, path_under_any, transfer_id_of_owner};
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

    /// 撤回附件能成立的前提：**撤回命令里真的先把传输停了**（2026-10-28 口径变更）。
    ///
    /// 只断言"函数存在"是半个守卫：这条链的价值全在"撤回命令调了它、且排在物化之前"。
    /// 所以钉两个命令各自的调用次数（1+1=2）与相对顺序。
    #[test]
    fn recall_commands_cancel_the_transfer_before_they_materialize() {
        fn body<'a>(src: &'a str, start: &str) -> &'a str {
            let i = src.find(start).unwrap_or_else(|| panic!("找不到 {start}"));
            let rest = &src[i + start.len()..];
            let end = rest.find("\npub async fn ").unwrap_or(rest.len());
            &rest[..end]
        }

        let chat = include_str!("chat.rs");
        let group = include_str!("group_announcements.rs");
        let calls = chat.matches("cancel_transfer_for_recalled_message(").count()
            + group.matches("cancel_transfer_for_recalled_message(").count();
        assert_eq!(
            calls, 2,
            "单聊 / 群 两个撤回命令各要调一次取消（改名/搬家时这里必须同步）"
        );

        for (name, src, start) in [
            ("chat.rs", chat, "pub async fn recall_message("),
            (
                "group_announcements.rs",
                group,
                "pub async fn recall_group_message(",
            ),
        ] {
            let fn_body = body(src, start);
            let cancel = fn_body
                .find("cancel_transfer_for_recalled_message(")
                .unwrap_or_else(|| panic!("{name} 的撤回命令没有先停传输"));
            let payload = fn_body
                .find("RecallPayload {")
                .unwrap_or_else(|| panic!("{name} 的撤回命令找不到载荷构造"));
            assert!(
                cancel < payload,
                "{name}：取消必须排在撤回物化之前（否则对端会先看到已撤回、字节还在流）"
            );
        }

        // 群主撤回是**收到帧那一侧**也要停传输：否则"群主把这条撤了、甲还在往全群发字节"。
        // 而那一侧必须**不再外发通知** —— 这条 recall 帧本来就全群广播过，
        // 每台都再发一份 FileCancel 就成一个撤回引发 N 份取消通知（回声）。
        let gossip = include_str!("../network/transport/gossip.rs");
        assert_eq!(
            gossip.matches("cancel_transfer_for_recalled_message(").count(),
            1,
            "接收侧停传输只许这一处出口（多处各写一份迟早漂）"
        );
        assert!(
            gossip.contains("CancelNotify::LocalOnly"),
            "接收侧必须用 LocalOnly；换成 Peers 就是每台都对外广播取消"
        );
        assert!(
            !gossip.contains("CancelNotify::Peers"),
            "接收侧出现 Peers ⇒ 一个撤回帧被 N 台各广播一份 FileCancel（回声）"
        );
        for (name, src) in [("chat.rs", chat), ("group_announcements.rs", group)] {
            assert!(
                src.contains("CancelNotify::Peers"),
                "{name}：发起侧要照常通知对端，常量名不写进去判据就抓不到换掉的另一半"
            );
        }
    }

    /// 撤回的**三笔写**必须一笔事务收口（B1-F6，5.15.50）。
    ///
    /// 原先三个调用点各自 `insert_recall(..).ok(); materialize_recall(..).ok();
    /// refresh_conversation_summary(..)`：前两笔一旦一笔成一笔败就**永久分裂**
    /// （`is_recalled` 说"撤过"、正文还在；幂等短路只看墓碑 ⇒ 重试也补不上），
    /// 而预览那一笔还各写一遍、漏一处就是"正文清了、列表还挂着原文"。
    ///
    /// 现在：所有撤回都走 `db::apply_recall`（墓碑 + 物化 + 预览**同一个事务**）。
    /// 判据改成两半：① 三个调用点只许调 `apply_recall`，不许再直接碰那两个原语；
    /// ② `apply_recall` 自己的块体里，物化之后必须紧跟预览重算（顺序错了算出来还是原文）。
    #[test]
    fn every_recall_site_goes_through_the_transactional_apply() {
        let sites = [
            ("commands/chat.rs", include_str!("chat.rs")),
            ("commands/group_announcements.rs", include_str!("group_announcements.rs")),
            (
                "network/transport/gossip.rs",
                include_str!("../network/transport/gossip.rs"),
            ),
        ];
        for (name, src) in sites {
            assert_eq!(
                src.matches("db::apply_recall(").count(),
                1,
                "{name}：撤回必须走一笔事务的 `db::apply_recall`（现数不是 1）"
            );
            for raw in ["db::insert_recall(", "db::materialize_recall("] {
                assert!(
                    !src.contains(raw),
                    "{name}：又直接调 `{raw}` 了 ⇒ 那一笔落在事务外，分裂的窗口回来了"
                );
            }
        }
        // ② 事务内部：物化之后必须紧跟预览重算（顺序反了算出来还是原文）
        let recalls = include_str!("../db/recalls.rs");
        let body_at = recalls
            .find("pub fn apply_recall(")
            .expect("apply_recall 搬家了 ⇒ 同步改这条判据");
        let body = &recalls[body_at..];
        let m = body.find("materialize_recall(&tx").expect("apply_recall 里没有物化");
        let r = body
            .find("refresh_conversation_summary(&tx")
            .expect("apply_recall 里没有预览重算");
        let c = body.find("tx.commit()").expect("apply_recall 没有 commit");
        assert!(m < r && r < c, "事务内的顺序必须是 物化 → 预览重算 → commit（现 m={m} r={r} c={c}）");
    }

    /// 群主那一档**被接上了**的判据（纯函数测得再全，命令层永远传 Author 就是零功能）。
    ///
    /// 三条各自点名一处会被悄悄退回的形状：① 群命令退回 Author（功能整体消失，而所有
    /// 纯函数用例照绿）；② 单聊那边"顺手也给了群主档"（单聊没有群主，等于任何人可撤）；
    /// ③ 接收侧不再走那份统一判据（改回只认作者 ⇒ 群主撤了、别人那台不消失，
    /// 选档的**行为**（审计 TST-07）：真/假两格各选哪一档。
    #[test]
    fn recall_authority_follows_local_creator() {
        // `group_announcements.rs` 是被 `group_files.rs` 里 `include!` 进来的 ⇒ 它的项
        // 落在 `commands` 模块里（`include!` 是文本粘贴，模块路径 ≠ 文件路径）。
        use crate::commands::recall_authority_for;
        use crate::protocol::RecallAuthority;
        assert_eq!(recall_authority_for(true), RecallAuthority::GroupCreator, "本机是群主 ⇒ 特权档");
        assert_eq!(recall_authority_for(false), RecallAuthority::Author, "不是群主 ⇒ 只有作者档");
    }

    /// 或反过来放宽成"谁都能撤"）。
    #[test]
    fn creator_recall_authority_is_wired_on_both_ends() {
        let group = include_str!("group_announcements.rs");
        let chat = include_str!("chat.rs");
        let gossip = include_str!("../network/transport/gossip.rs");

        // 钉的是**选档那一处调用**，不是那个标识符在文件里出现过 —— 受众提示那半个分支
        // 也写着同一个标识符，只断言"出现过"会把它当成已接上（本仓在存在性断言上反复付账）。
        // 2026-10-29 把 `if is_creator {…} else {…}` 抽成纯函数后，这里钉"命令确实调它"，
        // "真/假各选哪档"由下面的行为用例判（审计 TST-07：形状断言不算行为）。
        assert!(
            group.contains("let authority = recall_authority_for(is_creator);"),
            "群撤回命令必须按本地 creator 现选档位；只留纯函数 = 功能根本没接上"
        );
        assert!(
            !group.contains("CancelNotify::LocalOnly"),
            "发起侧不该用 LocalOnly（那等于发起撤回的人自己不再通知对端）"
        );
        assert!(
            group.contains("g.creator == s.device_id"),
            "群主身份必须现读本地库里那份 creator；换成别的来源就是把授权交给发帧人自报"
        );
        assert!(
            !chat.contains("RecallAuthority::GroupCreator"),
            "单聊没有群主这一档：那边出现 GroupCreator 等于让任何人撤任何消息"
        );
        // 接收侧有**两个时刻**要判同一件事：撤回帧先到（目标已落库）、被撤的消息后到
        // （先撤后到，那一刻才知道作者/类型/会话）。两处必须走**同一份**判据，
        // 且后到那一处只复核、不再写墓碑 —— 钉的是这两个语义，不是"调用次数等于几"。
        let judge_calls = gossip.matches("recall_receive_allowed(").count();
        assert!(
            judge_calls >= 2,
            "接收侧两个时刻都该走那份判据，现数到 {judge_calls} 处 ⇒ 少一处就是有一条通道不复核"
        );
        // 墓碑的写入口自 5.15.50 起只剩一处：`db::apply_recall` 内部（一笔事务）。
        // 三个调用点都只许调 apply_recall ⇒ `db::insert_recall(` 在这三份源码里现数 0。
        for (name, src) in [("chat.rs", chat), ("group_announcements.rs", group), ("gossip.rs", gossip)] {
            assert!(
                !src.contains("db::insert_recall("),
                "{name}：又出现直接写墓碑的调用 ⇒ 那是事务外的第二条状态来源"
            );
        }
        assert_eq!(
            gossip.matches("db::apply_recall(").count(),
            1,
            "接收侧那一臂必须走一笔事务的 apply_recall（现数不是 1）"
        );
    }

    /// 拖进来的路径先读元数据（确认弹窗要显示"名字 + 大小 + 是不是文件夹"）。
    /// 这条命令只读、不发送：目录必须能被认出来（前端据此在确认框里剔掉并说明）。
    #[test]
    fn inspect_drop_paths_reports_name_size_and_directory() {
        let dir = std::env::temp_dir().join(format!("gosslan-drop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();

        let out = inspect_drop_paths_blocking(vec![
            file.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(),
            String::new(),
        ]);
        assert_eq!(out.len(), 2, "空路径要剔掉，文件和目录都要留着给前端判断");
        assert_eq!(out[0].name, "a.txt");
        assert_eq!(out[0].size, 5);
        assert!(!out[0].is_dir);
        assert!(out[1].is_dir, "目录必须被认出来 —— 发送链路只收普通文件");
        assert_eq!(out[1].size, 0, "目录的大小没有意义");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有界：一次最多 200 条（拖 500 个文件进来不许把 IPC 撑爆）。
    #[test]
    fn inspect_drop_paths_is_capped() {
        let paths: Vec<String> = (0..500).map(|i| format!("/nonexistent/{i}.bin")).collect();
        assert_eq!(inspect_drop_paths_blocking(paths).len(), 200);
    }
}
