// 群台账补账那条路的判据（`ledger_backfill.rs`）。
// 五种反证是设计那一轮就写死的（`docs/notes/group-file-ledger-backfill-2026-10-16.md` §四）：
// 只验"补上了"的用例等于给一个会写错台账的函数盖章 —— 值钱的是**认不上时不写**那三条。
#[cfg(test)]
mod gfile_ledger_backfill_tests {
    use super::*;
    use rusqlite::Connection;

    const DEVICE: &str = "dev-self";
    const PEER: &str = "dev-peer";
    const GROUP: &str = "g1";

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        crate::content::store::ensure_schema(&conn).unwrap();
        conn
    }

    fn hex_of(bytes: &[u8]) -> String {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(bytes);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// 盘上一份真文件（每个用例自己的目录，跑完删掉）。
    fn temp_file(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "gosslan-gfile-backfill-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{tag}.bin"));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// 预置"消息行在、收尾那三张台账缺"的样子：
    /// Offer 写了 `group_files` + recipient(sending)，Done 在**事务外**把 path 回填进卡片，
    /// 而三张台账（recipient completed / file_transfers / content_transfers）一张都没写成。
    fn seed_gap_rows(conn: &Connection, transfer_id: &str, path: &str, sha: &str, size: u64) {
        let gf = crate::state::GroupFile {
            transfer_id: transfer_id.to_string(),
            group_id: GROUP.to_string(),
            sender_id: PEER.to_string(),
            name: "a.bin".to_string(),
            size,
            sha256: sha.to_string(),
            status: "sending".to_string(),
            created_at: 1,
            scope: "chat".to_string(),
            todo_id: String::new(),
        };
        db::upsert_group_file_receive(conn, &gf, DEVICE).unwrap();
        let rec = crate::state::MessageRecord {
            id: 0,
            msg_id: format!("gfile-{transfer_id}"),
            conv_id: format!("group:{GROUP}"),
            sender_id: PEER.to_string(),
            receiver_id: DEVICE.to_string(),
            kind: "file".to_string(),
            content: serde_json::json!({
                "name": "a.bin",
                "path": path,
                "size": size,
                "sha256": sha,
                "subtype": "document",
                "progress": 1.0,
            })
            .to_string(),
            ts: 1,
            seq: 1,
            status: "delivered".to_string(),
            mention_targets: None,
        };
        db::insert_message(conn, &rec).unwrap();
    }

    fn first_gap(conn: &Connection) -> GfileLedgerGap {
        let (gaps, orphan) = list_gfile_ledger_gaps(conn, DEVICE).unwrap();
        assert_eq!(
            gaps.len(),
            1,
            "这条预置必须被认成候选（否则正例判的是空集）"
        );
        assert_eq!(orphan, 0, "预置里不该有对不回身份的卡片");
        gaps.into_iter().next().unwrap()
    }

    fn recipient_status(conn: &Connection) -> Option<String> {
        db::get_group_file_recipient_status(conn, "t1", DEVICE)
    }

    fn transfer_row_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM file_transfers WHERE id = 't1'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn content_row_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM content_transfers WHERE peer_id = ?1 AND direction = 'receive'",
            [PEER],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **正向**：文件在盘上、哈希对得上、三张台账缺 ⇒ 补齐，且补完不再被认成候选。
    #[test]
    fn positive_fill_completes_all_three_ledgers() {
        let bytes = b"gosslan-backfill-payload".to_vec();
        let sha = hex_of(&bytes);
        let file = temp_file("positive", &bytes);
        let conn = mem();
        seed_gap_rows(
            &conn,
            "t1",
            &file.to_string_lossy(),
            &sha,
            bytes.len() as u64,
        );

        let gap = first_gap(&conn);
        assert_eq!(gap.sha256, sha, "候选得带 group_files 那份声明值");
        assert_eq!(gap.path, file.to_string_lossy());

        let local = sha256_file_hex(&file);
        let mut conn = conn;
        let outcome = gfile_ledger_repair(&mut conn, &gap, DEVICE, local).unwrap();
        assert_eq!(outcome, GfileLedgerOutcome::Repaired);

        assert_eq!(recipient_status(&conn).as_deref(), Some("completed"));
        assert!(db::is_transfer_done(&conn, "t1").unwrap());
        assert_eq!(
            db::get_transfer_path(&conn, "t1").as_deref(),
            Some(file.to_string_lossy().as_ref()),
            "file_transfers.path 必须补上：前端把它当 content 缺 path 时唯一兜底"
        );
        let content = crate::content::store::get(
            &conn,
            &sha,
            PEER,
            crate::content::model::Direction::Receive,
        )
        .unwrap()
        .expect("content_transfers 那一行必须被构造出来（这一格原本就是没兜底的那一格）");
        assert_eq!(
            content.path.as_deref(),
            Some(file.to_string_lossy().as_ref())
        );
        assert_eq!(
            content.status,
            crate::content::model::TransferStatus::Complete
        );

        // 补完再扫一次：三张台账都收口 ⇒ 不该再是候选
        let (again, orphan) = list_gfile_ledger_gaps(&conn, DEVICE).unwrap();
        assert!(again.is_empty(), "已补齐的行不许第二次进候选");
        assert_eq!(orphan, 0);
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    /// **反向一（最值钱的一条）**：盘上那份的哈希与声明值对不上 ⇒ **一格都不许写**。
    /// 这条拦的是"同名同大小却不同内容"被按名字补进台账 —— 那正是对账扫描器看不见的新形状。
    #[test]
    fn hash_mismatch_writes_not_a_single_cell() {
        let bytes = b"real-payload".to_vec();
        let sha = hex_of(&bytes);
        let file = temp_file("mismatch", &bytes);
        let conn = mem();
        seed_gap_rows(
            &conn,
            "t1",
            &file.to_string_lossy(),
            &sha,
            bytes.len() as u64,
        );
        let gap = first_gap(&conn);

        // 把盘上那份改掉一个字节（大小不变 ⇒ 只看 name/size 的话完全认不出来）
        let mut tampered = bytes.clone();
        tampered[0] ^= 0xFF;
        std::fs::write(&file, &tampered).unwrap();
        let local = sha256_file_hex(&file);

        let mut conn = conn;
        let outcome = gfile_ledger_repair(&mut conn, &gap, DEVICE, local).unwrap();
        // 两个 hex 都要出现在结局里：现场归因靠的就是「声明的是什么、实测的是什么」这两个数
        match outcome {
            GfileLedgerOutcome::SkippedHashMismatch { declared, actual } => {
                assert_eq!(declared, sha, "声明值要带的是 group_files 那份");
                assert_ne!(actual, sha, "实测值必须确实是另一份");
                assert_eq!(
                    actual,
                    hex_of(&tampered),
                    "带出来的实测值要等于盘上那份的真哈希"
                );
            }
            other => panic!("哈希对不上时只许报 SkippedHashMismatch，实际 {other:?}"),
        }
        assert_eq!(recipient_status(&conn).as_deref(), Some("sending"));
        assert_eq!(transfer_row_count(&conn), 0);
        assert_eq!(content_row_count(&conn), 0);
        assert!(!db::is_transfer_done(&conn, "t1").unwrap());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    /// **反向二**：文件已被清理 / 路径失效 ⇒ 同样一格都不写（不许留半条账）。
    #[test]
    fn absent_file_writes_not_a_single_cell() {
        let sha = hex_of(b"whatever");
        let conn = mem();
        let tmp = tempfile::TempDir::new().unwrap();
        let gone = tmp.path().join("a.bin");
        seed_gap_rows(&conn, "t1", &gone.to_string_lossy(), &sha, 8);
        let gap = first_gap(&conn);

        // 驱动侧那个阻塞任务对不存在的路径交回的就是 Err ⇒ 这里按同一条形状喂进去
        let local = Err("文件已不在盘上".to_string());
        let mut conn = conn;
        let outcome = gfile_ledger_repair(&mut conn, &gap, DEVICE, local).unwrap();
        match outcome {
            // 原因要**原样**带出去：日志替它挑一个说法（「已不在盘上」）会把「任务被中断」那种
            // 形状说成另一件事，而那一格正是本轮在修的误导。
            GfileLedgerOutcome::SkippedLocal { reason } => {
                assert_eq!(reason, "文件已不在盘上");
            }
            other => panic!("路径失效时只许报 SkippedLocal，实际 {other:?}"),
        }
        assert_eq!(recipient_status(&conn).as_deref(), Some("sending"));
        assert_eq!(transfer_row_count(&conn), 0);
        assert_eq!(content_row_count(&conn), 0);
    }

    /// **反向三**：同一行第二次补必须幂等 —— 不重复插行、不把已前进的终态打回去。
    #[test]
    fn second_repair_is_idempotent() {
        let bytes = b"idempotent-payload".to_vec();
        let sha = hex_of(&bytes);
        let file = temp_file("idempotent", &bytes);
        let conn = mem();
        seed_gap_rows(
            &conn,
            "t1",
            &file.to_string_lossy(),
            &sha,
            bytes.len() as u64,
        );
        let gap = first_gap(&conn);
        let local = || sha256_file_hex(&file);

        let mut conn = conn;
        let first = gfile_ledger_repair(&mut conn, &gap, DEVICE, local()).unwrap();
        let second = gfile_ledger_repair(&mut conn, &gap, DEVICE, local()).unwrap();
        assert_eq!(first, GfileLedgerOutcome::Repaired);
        assert_eq!(second, GfileLedgerOutcome::Repaired);

        assert_eq!(transfer_row_count(&conn), 1, "第二次不许多插一行");
        assert_eq!(content_row_count(&conn), 1, "第二次不许多插一行");
        assert_eq!(recipient_status(&conn).as_deref(), Some("completed"));
        assert!(db::is_transfer_done(&conn, "t1").unwrap());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    /// 候选闸：健康的行、本机是发送方的行、还没落盘的行 —— 都不许进候选（一次盘都不碰）。
    #[test]
    fn candidate_gate_skips_healthy_send_side_and_unfinished_rows() {
        // ① 三张台账齐全 ⇒ 不是候选
        let bytes = b"healthy".to_vec();
        let sha = hex_of(&bytes);
        let file = temp_file("gate-healthy", &bytes);
        {
            let mut conn = mem();
            seed_gap_rows(
                &conn,
                "t1",
                &file.to_string_lossy(),
                &sha,
                bytes.len() as u64,
            );
            let gap = first_gap(&conn);
            let local = sha256_file_hex(&file);
            gfile_ledger_repair(&mut conn, &gap, DEVICE, local).unwrap();
            let (again, _) = list_gfile_ledger_gaps(&conn, DEVICE).unwrap();
            assert!(again.is_empty(), "已收口的行不许被反复补");
        }
        // ② 本机是发送方 ⇒ 那条 recipient 名册记的是别人，内容台账方向是 Send，不归本作业
        {
            let conn = mem();
            let gf = crate::state::GroupFile {
                transfer_id: "t2".to_string(),
                group_id: GROUP.to_string(),
                sender_id: DEVICE.to_string(),
                name: "a.bin".to_string(),
                size: bytes.len() as u64,
                sha256: sha.clone(),
                status: "completed".to_string(),
                created_at: 1,
                scope: "chat".to_string(),
                todo_id: String::new(),
            };
            db::upsert_group_file_receive(&conn, &gf, DEVICE).unwrap();
            let rec = crate::state::MessageRecord {
                id: 0,
                msg_id: "gfile-t2".to_string(),
                conv_id: format!("group:{GROUP}"),
                sender_id: DEVICE.to_string(),
                receiver_id: DEVICE.to_string(),
                kind: "file".to_string(),
                content: serde_json::json!({
                    "name": "a.bin", "path": file.to_string_lossy(), "size": bytes.len(),
                    "sha256": sha, "subtype": "document",
                })
                .to_string(),
                ts: 1,
                seq: 1,
                status: "delivered".to_string(),
                mention_targets: None,
            };
            db::insert_message(&conn, &rec).unwrap();
            let (again, orphan) = list_gfile_ledger_gaps(&conn, DEVICE).unwrap();
            assert!(again.is_empty(), "发送方那半本作业不管");
            assert_eq!(
                orphan, 0,
                "发送方那条是「不该管」，不是「对不回身份」⇒ 不许计入孤儿"
            );
        }
        // ③ 卡片里还没有 path（还在收 / 失败 / 从未落盘）⇒ 没有任何证据，不猜
        {
            let conn = mem();
            let gf = crate::state::GroupFile {
                transfer_id: "t3".to_string(),
                group_id: GROUP.to_string(),
                sender_id: PEER.to_string(),
                name: "a.bin".to_string(),
                size: bytes.len() as u64,
                sha256: sha.clone(),
                status: "sending".to_string(),
                created_at: 1,
                scope: "chat".to_string(),
                todo_id: String::new(),
            };
            db::upsert_group_file_receive(&conn, &gf, DEVICE).unwrap();
            let rec = crate::state::MessageRecord {
                id: 0,
                msg_id: "gfile-t3".to_string(),
                conv_id: format!("group:{GROUP}"),
                sender_id: PEER.to_string(),
                receiver_id: DEVICE.to_string(),
                kind: "file".to_string(),
                content: serde_json::json!({
                    "name": "a.bin", "size": bytes.len(), "sha256": sha, "progress": 0.4,
                })
                .to_string(),
                ts: 1,
                seq: 1,
                status: "sending".to_string(),
                mention_targets: None,
            };
            db::insert_message(&conn, &rec).unwrap();
            let (again, orphan) = list_gfile_ledger_gaps(&conn, DEVICE).unwrap();
            assert!(again.is_empty(), "没落盘的行不是补账的对象");
            assert_eq!(orphan, 0, "没落盘那条连 path 都没有 ⇒ 也不该计入孤儿");
        }
        // ④ 卡片写着 path、`group_files` 那一行却没了 ⇒ 本轮补不了（没有任何证据能对回群），
        //    但**必须数进孤儿那一格**：没有这个数，"存量还剩多少补不了"在日志里就是零条证据。
        //    这一条同时是那条 `orphan += 1` 的非空转证（把它删掉，本用例就红）。
        {
            let conn = mem();
            let rec = crate::state::MessageRecord {
                id: 0,
                msg_id: "gfile-t4".to_string(),
                conv_id: format!("group:{GROUP}"),
                sender_id: PEER.to_string(),
                receiver_id: DEVICE.to_string(),
                kind: "file".to_string(),
                content: serde_json::json!({
                    "name": "a.bin", "path": file.to_string_lossy(), "size": bytes.len(),
                    "sha256": sha, "subtype": "document",
                })
                .to_string(),
                ts: 1,
                seq: 1,
                status: "delivered".to_string(),
                mention_targets: None,
            };
            db::insert_message(&conn, &rec).unwrap();
            let (again, orphan) = list_gfile_ledger_gaps(&conn, DEVICE).unwrap();
            assert!(again.is_empty(), "对不回 group_files 的行不许被硬补");
            assert_eq!(orphan, 1, "补不了的那一块必须被数出来，不是静默跳过");
        }
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    /// **形状（INV-P34 按格点名）**：这一格那份整文件哈希只许在阻塞线程池里算，
    /// 且必须等它（丢掉 JoinHandle = 台账永远不推进）。
    ///
    /// 为什么要单独一条：分母判据认的是**名字**（`sha256_file_hex(`），它看得见"没包"，
    /// 却看不见"包了不等"；反过来这条只读本册，新加第二处哈希它就报数。
    #[test]
    fn group_ledger_backfill_hashes_off_the_async_worker() {
        let raw = include_str!("ledger_backfill.rs");
        // 先去注释再比：注释里复述被断言的那句，会把这条判据带成假绿。
        let code: String = raw
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                    ""
                } else {
                    match l.find("//") {
                        Some(i) => &l[..i],
                        None => l,
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let flat: String = code.chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(
            flat.matches("sha256_file_hex(").count(),
            1,
            "本册现数到 {n} 处整文件哈希（登记 1 处）。对不上先分清：\
             ① 又多了一处哈希 ⇒ 它也必须整体在池子里，别就地算；\
             ② 有人把这一处搬去握 db 锁的那一段（`gfile_ledger_repair` 里）⇒ 那是「GB 级哈希握着 \
             `state.db` 几秒」，消息收发和所有读库的命令一起挨饿，形状同样不许。",
            n = flat.matches("sha256_file_hex(").count()
        );
        let call = flat.find("sha256_file_hex(").expect("哈希那一处必须还在");
        let wrapped = flat[..call]
            .rfind("spawn_blocking(")
            .expect("整份哈希必须在 spawn_blocking 闭包里");
        assert!(
            !flat[wrapped..call].contains(".await"),
            "交出点在池子和哈希之间出现了 .await ⇒ 这活其实是在当前 worker 上跑的"
        );
        assert!(
            flat.contains("sha256_file_hex(&target)}).await"),
            "包进了 spawn_blocking 却没等它：丢掉 JoinHandle = 慢活照跑、台账永不推进"
        );
        // 同一册里的**第二个** commit 陷阱（第一个是 4.40.8 的群收尾）：三张表写进事务却不 commit
        // ⇒ 一起回滚、`wrote` 仍是 Ok。行为侧那条正向用例已经钉住它（本轮实测：漏 commit 时
        // `positive_fill_completes_all_three_ledgers` 当场红在"recipient 仍是 sending"），
        // 这里只再钉一次"别有人把 commit 删成一句注释"。
        assert_eq!(
            flat.matches(".transaction().and_then(|tx|").count(),
            1,
            "本册的事务写法变了（登记 1 处）⇒ 判据要一起改，不许只改一边"
        );
        assert_eq!(
            flat.matches("tx.commit()").count(),
            1,
            "事务闭包里现数到 {n} 处 `tx.commit()`（登记 1 处）：0 处就是三张表一起回滚那一格",
            n = flat.matches("tx.commit()").count()
        );
    }
    /// **接线判据**：这一格作业今天只有"库里缺行 + 盘上有文件 + 跑得起来"三件事同时成立才有意义，
    /// 而**删掉 `lib.rs` 里那一格 spawn，878 条用例全绿、补账从此再也不跑**（静默失效那一类）。
    /// 所以钉四件事：只接一次、经 `GFILE_LEDGER_BACKFILL_DONE_KEY` 这个**名字**（不是手抄字符串）、
    /// 由 `spawn` 驱动、**跑完整趟才写完成标记**（提前写 ⇒ 中途崩的那台永远不会再补）。
    #[test]
    fn group_ledger_backfill_is_wired_once_at_startup_after_the_run() {
        let raw = include_str!("../../lib.rs");
        // 去整行注释（这一册的历史教训是"注释里复述被断言的那句会带假绿"），再扁平化。
        let code: String = raw
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                    String::new()
                } else {
                    match l.find("//") {
                        Some(i) => l[..i].to_string(),
                        None => l.to_string(),
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let flat: String = code.chars().filter(|c| !c.is_whitespace()).collect();

        assert_eq!(
            flat.matches("run_group_ledger_backfill(").count(),
            1,
            "补账作业在 lib.rs 里现数到 {n} 个调用点（登记 1 处）：0 = 没人接（静默不跑），2 = 两个家（会补两趟）",
            n = flat.matches("run_group_ledger_backfill(").count()
        );
        // 开关键只能有那一个家：这里认名字，不认字面量。
        assert_eq!(
            flat.matches("GFILE_LEDGER_BACKFILL_DONE_KEY").count(),
            2,
            "完成标记现数到 {n} 次引用（登记 2 处：读一次、写一次）",
            n = flat.matches("GFILE_LEDGER_BACKFILL_DONE_KEY").count()
        );
        assert!(
            !flat.contains("\"gfile_ledger_backfill_done\""),
            "lib.rs 里手抄了那个 settings 键的字面量 ⇒ 键名一旦改，标记就静默失效（读一个家、写另一个家）"
        );
        let call = flat
            .find("run_group_ledger_backfill(")
            .expect("调用点必须存在");
        let mark = flat
            .find("GFILE_LEDGER_BACKFILL_DONE_KEY,\"1\"")
            .expect("完成标记那一句必须还在");
        assert!(
            call < mark,
            "完成标记必须在整趟跑完之后再写：先写 ⇒ 中途崩的那台以后再也不补（而每条写本来是幂等的）"
        );
        // 标记的写还必须被"这一趟收没收口"那个门挡住（2026-10-16 评审抓出来的 P1）：
        // 旧形状是跑完作业就无条件写 ⇒ 一次 SQLITE_BUSY 或一条事务失败，就把这台**永久**钉成"不再补账"，
        // 把一次临时故障变成一个不可恢复的决定。次序：跑作业 → 判断收口 → 才写标记。
        // 数的是**出现次数**，不是"存在与否"：这条字符串在 lib.rs 里有两处 ——
        // 一处是日志里那句三元式 `if stats.incomplete { "否" } else { "是" }`，另一处才是拦标记的门。
        // 只判"找得到"会被前者喂成假绿（本轮实测：把门改成 `if false` 之后判据照样绿，
        // 因为三元式那句还写着同一个字面量）。所以钉次数 == 2，再取 mark 之前那**最后一次**出现当门。
        assert_eq!(
            flat.matches("ifstats.incomplete{").count(),
            2,
            "lib.rs 里 `if stats.incomplete {{` 现数到 {} 处（登记 2 处：日志三元式 1 + 拦标记的门 1）。\
             少一处最常见的原因是**门被改成 `if false` 或换成别的条件** —— 那时标记又会无条件写了",
            flat.matches("ifstats.incomplete{").count()
        );
        let gate = flat[..mark]
            .rfind("ifstats.incomplete{")
            .expect("完成标记之前必须有一道 stats.incomplete 门");
        assert!(
            call < gate && gate < mark,
            "门的位置不对：跑作业 → 判断收口 → 写标记 才是这个次序（现在 call/gate/mark 不满足）"
        );
        // 门不能是个永远不亮的摆设：**置位那一侧必须真存在**，而且它在被调的那一册里，不在 lib.rs。
        let shard_flat: String = include_str!("ledger_backfill.rs")
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(
            shard_flat.matches("stats.incomplete=true").count() >= 3,
            "补账那一册里现数不到 3 处置位（扫描 Err / 扫描任务被中断 / 单条台账写失败）⇒ lib.rs 那个门永远不拦"
        );
        // 认的是「spawn 一个 async move 块」这个整体形状，而不是"spawn 与调用之间没有 .await"：
        // 那一格是 INV-P34 交给阻塞池那条的口径，这里**不适用** —— 本作业在 spawn 之后先 sleep 20 秒
        // 再动（让首屏与自启先跑），那个 `.await` 是刻意排在调用前面的。
        flat[..call]
            .rfind("tauri::async_runtime::spawn(asyncmove{")
            .expect("补账作业必须由 spawn 出去的后台任务驱动，不许挂在 setup 的就地路径上");
        assert!(
            flat.contains("tokio::time::sleep(std::time::Duration::from_secs"),
            "那一格作业刻意**晚一点**再动（首屏 / 局域网自启 / .part 清扫排在同一段）；把它挪成开机就跑 ⇒ 补账跟首帧抢盘"
        );
    }

    /// **执行计划现读**（用应用里那台引擎，不是本机 CLI）。
    ///
    /// 起因：2026-10-16 那轮评审拿本机 `sqlite3` 3.50.6 量到
    /// `SCAN messages USING INDEX sqlite_autoindex_messages_1`，据此否证了"LIKE 不走索引"那句 ——
    /// 但**应用里那台不是它**：`Cargo.lock` 锁的是 `libsqlite3-sys 0.28.0`，它 bundled 的 SQLite 版本
    /// 本地读不到源码 ⇒ 那条只能算"另一台引擎的读数"。这条把同一个查询搬到真要发出去的那台上重测。
    /// 钉两件事：用了 msg_id 上的自动索引、ORDER BY msg_id 不需要额外排序。
    /// 为什么值得钉：这一段握着全仓唯一那把 db 锁，计划退化成无索引扫 = 消息落链路与每个读库命令一起排队。
    #[test]
    fn candidate_query_is_index_scanned_by_the_engine_we_ship() {
        let conn = mem();
        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN SELECT msg_id, conv_id, content FROM messages
                 WHERE msg_id LIKE 'gfile-%' ORDER BY msg_id",
                [],
                |r| r.get::<_, String>(3),
            )
            .unwrap();
        println!("EXPLAIN QUERY PLAN（应用内引擎实测）→ {plan}");
        assert!(
            plan.contains("USING INDEX") || plan.contains("sqlite_autoindex_messages"),
            "候选查询退化成不带索引的扫描（现读 {plan}）"
        );
        assert!(
            !plan.contains("USE TEMP B-TREE"),
            "ORDER BY msg_id 走了额外排序（现读 {plan}）⇒ 没按索引序取行，候选扫描比想象的贵"
        );
    }
}
