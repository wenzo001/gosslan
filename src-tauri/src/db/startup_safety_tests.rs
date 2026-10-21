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
