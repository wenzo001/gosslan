// 职责边界：启动安全边界（2026-10-20 P0）——孤儿 sending 恢复、启动数据计数、可恢复备份探测。
// 本册由 db.rs 末尾的 `#[cfg(test)] mod startup_safety_tests;` 直接声明（不是 include!），
// 所以这里的 `use super::*` 指的就是 db 模块。
use super::*;

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

fn insert_msg(conn: &Connection, msg_id: &str, status: &str) {
    conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'peer', 'me', 'peer', 'text', 'x', 1, 1, ?2)",
            params![msg_id, status],
        )
        .unwrap();
}

fn status(conn: &Connection, msg_id: &str) -> String {
    conn.query_row(
        "SELECT status FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn a_failing_ddl_batch_leaves_no_half_schema_behind() {
    let conn = Connection::open_in_memory().unwrap();
    // 第一句是合法 DDL（本该建出 half_applied），第二句语法错误 ⇒ 整批必须回滚。
    // 这正是 DB-01 的注入点：旧实现两句分开跑时，这一段会留下 half_applied。
    let ddl = "CREATE TABLE half_applied(x INTEGER);\nCREATE TABLE oops (";
    let err = apply_base_schema_atomically(&conn, ddl, None).unwrap_err();
    assert_eq!(
        err.code(),
        "SCHEMA_MIGRATE_FAILED",
        "DDL 事务失败必须可定位到错误码：{err}"
    );
    assert!(
        err.to_string().contains("基础 schema"),
        "错误串要指出是哪一段 DDL 失败：{err}"
    );
    let tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        tables, 0,
        "DDL 事务失败后一张业务表都不许留下（留下 half_applied 就是 DB-01 的半迁移状态）"
    );
}

/// DB-01 的正面半边：两个 DDL 段落地后都在，且内容层那张表也随事务一起提交。
#[test]
fn the_base_schema_and_the_content_schema_land_together() {
    let conn = Connection::open_in_memory().unwrap();
    apply_base_schema_atomically(&conn, SCHEMA, None).unwrap();
    let has = |name: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    };
    assert!(has("messages"), "基础 schema 必须建出业务表");
    assert!(
        has("content_transfers"),
        "内容层 schema 必须与基础 schema 同批提交（分层不变，事务只有一个）"
    );
}

/// 全新库的 `user_version` 必须和建表在**同一个事务**里（审计 DB-01 复审）。
///
/// 旧写法在 DDL 事务提交之后单独 `pragma_update`：崩在两者之间会留下
/// "表齐全、version=0" 的库，下次启动按老库处理、重放整条迁移链。
#[test]
fn fresh_version_is_written_inside_the_ddl_transaction() {
    let conn = Connection::open_in_memory().unwrap();
    apply_base_schema_atomically(&conn, SCHEMA, Some(DB_VERSION)).unwrap();
    let v: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, DB_VERSION, "成功路径：版本与表一起落地");

    let conn = Connection::open_in_memory().unwrap();
    let ddl = "CREATE TABLE half_applied(x INTEGER);\nCREATE TABLE oops (";
    assert!(
        apply_base_schema_atomically(&conn, ddl, Some(DB_VERSION)).is_err(),
        "中途失败的 DDL 必须回传错误"
    );
    let v: u32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 0, "DDL 回滚时版本号也必须回滚（否则就是半迁移状态）");
}

/// 启动恢复只碰「sending 且两张 outbox 表都没有行」的孤儿。
/// 有队列行的（还能补发）、以及其他终态的，一个都不许改。
#[test]
fn orphan_sending_is_recovered_but_queued_and_terminal_rows_are_untouched() {
    let conn = db();
    insert_msg(&conn, "orphan", "sending");
    insert_msg(&conn, "queued", "sending");
    insert_msg(&conn, "group-queued", "sending");
    insert_msg(&conn, "delivered", "delivered");
    insert_msg(&conn, "failed", "failed");
    // 文件管线：1:1 与群文件都以 sending 起步，但由 file_transfers / group_files
    // 管状态，从不写这两张 outbox 表 ⇒ 启动恢复**不许**把它们判死。
    insert_msg(&conn, "file-transfer-1", "sending");
    insert_msg(&conn, "gfile-transfer-2", "sending");
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES('queued','peer','{}',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES('group-queued','g','peer','{}',1)",
        [],
    )
    .unwrap();

    assert_eq!(recover_orphan_sending_messages(&conn).unwrap(), 1);
    assert_eq!(
        status(&conn, "orphan"),
        "failed",
        "无队列行的 sending 必须落终态"
    );
    assert_eq!(
        status(&conn, "queued"),
        "sending",
        "有单聊队列行 ⇒ 还能补发，不许判死"
    );
    assert_eq!(
        status(&conn, "group-queued"),
        "sending",
        "有群队列行 ⇒ 同上"
    );
    assert_eq!(status(&conn, "delivered"), "delivered");
    assert_eq!(status(&conn, "failed"), "failed");
    assert_eq!(
        status(&conn, "file-transfer-1"),
        "sending",
        "1:1 文件由 file_outbox/file_transfers 管状态，孤儿恢复不许误判"
    );
    assert_eq!(
        status(&conn, "gfile-transfer-2"),
        "sending",
        "群文件由 group_files 管状态，孤儿恢复不许误判（发送与接收两侧都以 sending 起步）"
    );
    // 幂等：第二次没有可改的行
    assert_eq!(recover_orphan_sending_messages(&conn).unwrap(), 0);
    // ★ 原因必须落库（DB v14→v15）：这类失败**只有本机知道**，对方从没收到过任何东西。
    //   不写码就等于"重启之后连本机也不记得这条为什么红了"。
    let code = |msg: &str| -> Option<String> {
        conn.query_row(
            "SELECT fail_code FROM messages WHERE msg_id = ?1",
            rusqlite::params![msg],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert_eq!(
        code("orphan").as_deref(),
        Some(crate::error_codes::SEND_ORPHAN_AT_START),
        "孤儿恢复要把原因一起写进去，界面才说得出为什么"
    );
    assert_eq!(
        code("failed"),
        None,
        "这一次没碰的那条（本来就是 failed）不许凭空长出一个它没有的原因"
    );
}

#[test]
fn boot_counts_ignore_default_settings_but_see_real_rows() {
    fn has_data(conn: &Connection) -> bool {
        let (messages, friends, conversations, groups) = boot_data_counts(conn).unwrap();
        messages + friends + conversations + groups > 0
    }
    let conn = db();
    assert!(!has_data(&conn), "空库不算已有安装");
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('device_id','d')",
        [],
    )
    .unwrap();
    assert!(
        !has_data(&conn),
        "只有 settings 默认键（设备标识）时仍可能是首次安装，不能算业务数据"
    );
    insert_msg(&conn, "m", "sent");
    assert!(has_data(&conn), "有消息行就是已有安装");
}

#[test]
fn backup_detection_picks_the_newest_migration_backup_and_ignores_the_main_db() {
    let dir = std::env::temp_dir().join(format!(
        "gosslan-backup-scan-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let main = dir.join("gosslan.db");
    let old = dir.join("gosslan.pre-v9-to-v10-1-100.db");
    let new = dir.join("gosslan.pre-v10-to-v11-2-200.db");
    let unrelated = dir.join("other.pre-v1-to-v2-3-300.db");
    for p in [&main, &old, &new, &unrelated] {
        std::fs::write(p, b"x").unwrap();
    }
    let stamp = |p: &Path, secs: u64| {
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
            .unwrap();
    };
    stamp(&main, 500);
    stamp(&old, 1_000);
    stamp(&new, 2_000);
    stamp(&unrelated, 3_000);
    assert_eq!(
        find_recovery_backup(&main).as_deref(),
        Some(new.as_path()),
        "必须取本库最新的迁移备份，且不得把其它库的备份当成本库的"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 新库必须真的进 WAL，且**不该**报耐久性降级。
///
/// 这条同时钉住「读回校验真的在跑」：两个 PRAGMA 以前是 `.ok()` 吞错，改成读回比对之后，
/// 正常路径必须一声不响（否则每次启动都刷一条假告警），异常路径才 push 告警。
#[test]
fn fresh_database_lands_in_wal_without_a_degraded_notice() {
    let dir = std::env::temp_dir().join(format!("gosslan-wal-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.db");
    let (conn, notices) = init_with_notices(&path).unwrap();
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        mode.to_ascii_lowercase(),
        "wal",
        "新库没进 WAL ⇒ DELETE 日志 + synchronous=NORMAL 是可能损坏的组合"
    );
    assert!(
        notices
            .iter()
            .all(|n| !n.contains("DB_DURABILITY_DEGRADED")),
        "正常路径不该报降级：{notices:?}"
    );
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

// ───────────────────────── 状态机 / 事务边界（审计 P1 #4 #5 #6）─────────────────────────

/// #5：迟到写不许撤销用户的取消，也不许把已判失败的行推回 `sent`。
#[test]
fn late_status_writes_cannot_undo_hard_terminal_states() {
    let conn = db();
    for (i, terminal) in ["cancelled", "partial_cancelled", "failed"]
        .iter()
        .enumerate()
    {
        let id = format!("m-{i}");
        insert_msg(&conn, &id, terminal);
        let rows = set_message_status(&conn, &id, "sent").unwrap();
        assert_eq!(rows, 0, "{terminal} 必须挡住迟到写");
        assert_eq!(status(&conn, &id), *terminal, "{terminal} 不得被改写");
    }
    // 合法路径：sending 仍可推进（重发链先 requeue 到 sending）。
    insert_msg(&conn, "m2", "sending");
    assert_eq!(set_message_status(&conn, "m2", "sent").unwrap(), 1);
}

/// #5 的配套（群补发）：取消过的群消息被合法复活时，队列行与 messages 必须一起回到
/// 可推进状态 —— 否则 `set_message_status("sent")` 会被新的守卫挡成 0 行。
#[test]
fn group_resend_flips_cancelled_message_back_to_sending_in_the_same_tx() {
    let conn = db();
    insert_msg(&conn, "g1", "cancelled");
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at, status)
         VALUES('g1', 'G', 'peer-b', '{}', 1, 'cancelled')",
        [],
    )
    .unwrap();
    let flipped = resend_cancelled_group_rows(&conn, "g1", 2).unwrap();
    assert_eq!(flipped, 1);
    assert_eq!(status(&conn, "g1"), "sending", "复活后必须可被 sent 推进");
    let row_status: String = conn
        .query_row(
            "SELECT status FROM group_outbox WHERE msg_id = 'g1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row_status, "pending");
    assert_eq!(set_message_status(&conn, "g1", "sent").unwrap(), 1);
}

/// #6：置 failed 与删队列行同一事务 —— 删行失败必须整体回滚，不能留下
/// 「界面已判失败、队列行还在（还会被补发）」。
#[test]
fn expired_finalize_is_atomic_when_outbox_delete_fails() {
    let conn = db();
    insert_msg(&conn, "m1", "sending");
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES('m1', 'peer', '{}', 1)",
        [],
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER block_outbox_delete BEFORE DELETE ON outbox
         BEGIN SELECT RAISE(ABORT, 'x'); END;",
    )
    .unwrap();
    assert!(
        finalize_expired_message(&conn, "m1", false).is_err(),
        "删行失败必须报错"
    );
    assert_eq!(status(&conn, "m1"), "sending", "状态必须随事务回滚");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1,
        "队列行必须还在（下一 tick 重试）"
    );

    conn.execute_batch("DROP TRIGGER block_outbox_delete;")
        .unwrap();
    finalize_expired_message(&conn, "m1", false).unwrap();
    assert_eq!(status(&conn, "m1"), "failed");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

/// #4：`rename_group` 两笔写同一事务 —— 第二笔失败时群表也不许改。
#[test]
fn rename_group_rolls_back_when_conversation_update_fails() {
    let conn = db();
    conn.execute(
        "INSERT INTO groups(id, name, creator, created_at) VALUES('g1', '旧名', 'me', 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversations(id, kind, name, unread, updated_at) VALUES('group:g1', 'group', '旧名', 0, 1)",
        [],
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER block_conv_rename BEFORE UPDATE ON conversations
         BEGIN SELECT RAISE(ABORT, 'x'); END;",
    )
    .unwrap();
    assert!(rename_group(&conn, "g1", "新名").is_err());
    let name: String = conn
        .query_row("SELECT name FROM groups WHERE id = 'g1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "旧名", "会话行写失败时群表必须回滚");
}

/// #4：`upsert_group` 成员表半写必须整体回滚。
#[test]
fn upsert_group_rolls_back_when_member_insert_fails() {
    let conn = db();
    conn.execute_batch(
        "CREATE TRIGGER block_member BEFORE INSERT ON group_members
         BEGIN SELECT RAISE(ABORT, 'x'); END;",
    )
    .unwrap();
    let members = vec!["me".to_string(), "peer".to_string()];
    assert!(upsert_group(&conn, "g1", "群", "me", &members).is_err());
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM groups WHERE id = 'g1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0, "成员写失败时群行也不许留下");
}

/// 审计 P2 #24：`foreign_keys` 不能只写 `.ok()` —— 读回实际值并让失败进启动通知。
#[test]
fn fresh_database_really_has_foreign_keys_on_and_reports_no_degradation() {
    // 本册不依赖 `migration_tests` 的私有 helper：自己造一份临时路径（同形）。
    let path = std::env::temp_dir().join(format!(
        "gosslan-fk-on-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let (_conn, notices) = init_with_notices(&path).expect("init fresh db");
    assert!(
        !notices.iter().any(|n| n.contains("DB_FOREIGN_KEYS_OFF")),
        "新库上 foreign_keys 必须真的开着：{notices:?}"
    );
}

/// **WAL 没开成之后的措辞真值表**（§4.0bb 缺口⑤）。
///
/// 原先那一格是 `pragma_update(..FULL).ok()` + 一句「已把 synchronous 提到 FULL」——
/// 设不上时那句通知就是假的，而掉电损坏风险正好落在这里。现在措辞由**读回值**决定：
///   · 读回 2（FULL）⇒ 才允许说"已提到 FULL"；
///   · 其它任何值 ⇒ 必须说"没能提上去、掉电可能损坏"，且不许出现"已提到 FULL"这几个字。
#[test]
fn durability_notice_follows_the_read_back_value() {
    let raised = durability_after_wal_failure("delete", 2).expect("降级分支必有通知");
    assert!(
        raised.contains("code=DB_DURABILITY_DEGRADED")
            && raised.contains("已把 synchronous 提到 FULL"),
        "真到了 FULL 才许这么说：{raised}"
    );
    for now in [-1, 0, 1, 3] {
        let n = durability_after_wal_failure("delete", now).expect("降级分支必有通知");
        assert!(
            n.contains("code=DB_DURABILITY_NOT_RAISED"),
            "读回 {now} 时必须是 NOT_RAISED：{n}"
        );
        assert!(
            !n.contains("已把 synchronous 提到 FULL"),
            "读回 {now} 时不许声称已经提上去了（那正是原来的假话）：{n}"
        );
        assert!(
            n.contains(&format!("synchronous={now}")),
            "通知里要带读回值，排障才知道当时是多少：{n}"
        );
    }
}
