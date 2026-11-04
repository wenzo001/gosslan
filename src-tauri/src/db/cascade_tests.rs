//! 删除级联与消息字段回填的行为测试（2026-09-19 审计 P0#6 + 2026-09-20 大文件体验轮）。
//!
//! 钉住的几类事故：
//!   ① 删会话后 `outbox`/`group_outbox`/`file_outbox` 残留 → 下次建链把已删消息补发回去；
//!   ② 退群/删群不删 `messages` 与已读水位 → 全局搜索命中「点不开的孤儿」；
//!   ③ 收口前入库的历史孤儿由 v7 迁移一次性清掉；
//!   ④ 发送行的 `sha256` 由投递任务回填 —— 只补一个字段，且同值不得产生第二次写入。

use super::*;
use rusqlite::Connection;

fn fresh_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

fn ins_msg(conn: &Connection, msg_id: &str, conv: &str, kind: &str, content: &str, seq: i64) {
    conn.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq)
         VALUES (?1, ?2, 'me', 'peer', ?3, ?4, 1000, ?5)",
        params![msg_id, conv, kind, content, seq],
    )
    .unwrap();
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn delete_conversation_purges_inflight_queues_and_keeps_cards() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO conversations(id, kind, name) VALUES ('p1','single','P')",
        [],
    )
    .ok();
    ins_msg(&conn, "m1", "p1", "text", "hello", 1);
    ins_msg(&conn, "m2", "p1", "file", "{\"name\":\"a\"}", 2);
    ins_msg(&conn, "c1", "p1", "announcement", "{\"text\":\"g\"}", 3); // Card：不属于聊天历史
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m1','p1','{}',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at) VALUES ('m2','p1','x','{}',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, group_id, local_path, name, size, status, attempts, next_attempt_at, created_at)
         VALUES ('t1','p1',NULL,'/tmp/a','a',1,'pending',0,0,1)",
        [],
    )
    .unwrap();

    delete_conversation(&conn, "p1").unwrap();

    // Bubble 消息与三条在途队列全清；Card 与会话外数据不动
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM messages WHERE kind IN ('text','file')"
        ),
        0,
        "被删会话的 Bubble 消息必须清零"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM messages WHERE kind = 'announcement'"
        ),
        1,
        "Card 不属于聊天历史，不得顺手删"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM outbox"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM group_outbox"), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM file_outbox"), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM conversations WHERE id='p1'"),
        0
    );
}

#[test]
fn delete_group_cascade_clears_history_reads_and_queues() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO groups(id, name, creator, created_at) VALUES ('g1','G','me',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO group_members(group_id, device_id) VALUES ('g1','me'),('g1','a')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversations(id, kind, name) VALUES ('group:g1','group','G')",
        [],
    )
    .ok();
    ins_msg(&conn, "gm1", "group:g1", "text", "hi", 5);
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at) VALUES ('gm1','g1','a','{}',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, group_id, local_path, name, size, status, attempts, next_attempt_at, created_at)
         VALUES ('t9','a','g1','/tmp/x','x',1,'pending',0,0,1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO group_reads(group_id, reader_id, last_read_ts) VALUES ('g1','a',9)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO pending_group_reads(group_id, peer_id, last_read_ts) VALUES ('g1','a',9)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO group_recalled_messages(conv_id, msg_id, recaller_id, seq) VALUES ('group:g1','gm1','me',5)",
        [],
    )
    .unwrap();
    set_setting(&conn, &clear_boundary_key("g1"), "5").unwrap();
    conn.execute(
        "INSERT INTO conversation_clocks(conv_id, seq) VALUES ('group:g1', 5)",
        [],
    )
    .ok();

    delete_group(&conn, "g1").unwrap();

    for (label, sql) in [
        (
            "messages 历史",
            "SELECT COUNT(*) FROM messages WHERE conv_id='group:g1'",
        ),
        ("group_outbox", "SELECT COUNT(*) FROM group_outbox"),
        (
            "file_outbox(group)",
            "SELECT COUNT(*) FROM file_outbox WHERE group_id='g1'",
        ),
        ("group_reads", "SELECT COUNT(*) FROM group_reads"),
        (
            "pending_group_reads",
            "SELECT COUNT(*) FROM pending_group_reads",
        ),
        ("撤回墓碑", "SELECT COUNT(*) FROM group_recalled_messages"),
        (
            "boundary 设置",
            "SELECT COUNT(*) FROM settings WHERE key='clear_boundary:group:g1'",
        ),
        ("群行", "SELECT COUNT(*) FROM groups WHERE id='g1'"),
        (
            "会话行",
            "SELECT COUNT(*) FROM conversations WHERE id='group:g1'",
        ),
    ] {
        assert_eq!(count(&conn, sql), 0, "{label} 未被级联清理");
    }
    // 刻意保留：逻辑时钟只增不减，删了会让重建的同名会话撞历史序号
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM conversation_clocks WHERE conv_id='group:g1'"
        ),
        1,
        "conversation_clocks 必须保留（单调性护栏）"
    );
}

#[test]
fn search_history_skips_orphan_conversations() {
    let conn = fresh_db();
    ins_msg(&conn, "o1", "group:gone", "text", "kw orphan", 1);
    assert!(
        search_history(&conn, "kw", None, None, None, 10)
            .unwrap()
            .is_empty(),
        "会话行不在列表里的孤儿消息不得出现在搜索结果（点不开还挤占计数）"
    );
    conn.execute(
        "INSERT INTO conversations(id, kind, name) VALUES ('group:gone','group','G')",
        [],
    )
    .ok();
    assert_eq!(
        search_history(&conn, "kw", None, None, None, 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn migration_v7_purges_legacy_group_orphans_only() {
    use std::env;
    let mut p = env::temp_dir();
    p.push(format!(
        "gosslan-cascade-v7-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&p);
    {
        let conn = Connection::open(&p).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        ins_msg(&conn, "live", "p1", "text", "stays", 1);
        conn.execute(
            "INSERT INTO conversations(id, kind, name) VALUES ('p1','single','P')",
            [],
        )
        .ok();
        // 孤儿：群已不在 groups 表、会话也不在 conversations
        ins_msg(&conn, "orph", "group:dead", "text", "legacy garbage", 1);
        // ⚠️ 陷阱用例（自审 #2）：**用户删过群会话但群还在** —— 合法状态，
        // 一条都不能清（旧口径 `NOT IN conversations` 单锚会在这里造成不可逆数据丢失）
        conn.execute(
            "INSERT INTO groups(id, name, creator, created_at) VALUES ('alive','A','me',1)",
            [],
        )
        .unwrap();
        ins_msg(&conn, "kept", "group:alive", "text", "在册群历史", 1);
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at) VALUES ('orph','dead','a','{}',1)",
            [],
        )
        .unwrap();
        conn.execute("PRAGMA user_version = 6", []).unwrap();
    }
    let conn = init(&p).unwrap();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM messages WHERE msg_id='orph'"),
        0,
        "v7 迁移必须清掉存量孤儿群消息"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM group_outbox"), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM messages WHERE msg_id='live'"),
        1,
        "在册会话的消息一条都不能误伤"
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM messages WHERE msg_id='kept'"),
        1,
        "群在册（groups 有行）而会话被删过 —— 历史必须保留，这不是孤儿"
    );
    let uv: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(uv as u32, DB_VERSION, "迁移链必须把库带到最新版本");
    drop(conn);
    let _ = std::fs::remove_file(&p);
}

#[test]
fn expired_rows_carry_peer_and_age_for_group_and_file_queues() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
         VALUES ('gm1','g1','offline-meet','{}',1),('gm1','g1','online-a','{}',1),
               ('gm2','g1','offline-meet','{}',1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, group_id, local_path, name, size, status, attempts, next_attempt_at, created_at)
         VALUES ('t1','offline-meet','g1','/p','p',1,'pending',0,0,1)",
        [],
    )
    .unwrap();
    let g = list_expired_group_outbox(&conn, 500).unwrap();
    // 行级：同一 msg 的离线成员与在线成员各自成行，sweeper 才能做「全部放弃才算失败」
    assert_eq!(g.len(), 3);
    assert!(g
        .iter()
        .any(|(m, _g, p, _c)| m == "gm1" && p == "offline-meet"));
    let f = list_expired_file_outbox(&conn, 500).unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].1, "offline-meet");
    assert_eq!(f[0].2.as_deref(), Some("g1"));
}

/// 发送行的 `sha256` 回填：只补一个字段、同值不重复写、缺行/空值静默通过。
///
/// 为什么要钉"不重复写"：回填点在投递任务里，每次 outbox 重试都会再进来一次；
/// 若同值也写，就是在拥塞链路上给全局单连接 DB 多加无谓的写放大。
#[test]
fn fill_message_sha256_backfills_once_and_keeps_other_fields() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO conversations(id, kind, title, ts) VALUES ('p1','single','P',1)",
        [],
    )
    .ok();
    ins_msg(
        &conn,
        "file-t1",
        "p1",
        "file",
        "{\"name\":\"a.bin\",\"size\":7,\"sha256\":\"\",\"subtype\":\"bin\"}",
        1,
    );
    // 用触发器数真实写入次数（不看返回值，返回值两种情况都是 Ok）
    conn.execute("CREATE TABLE write_log(n INTEGER NOT NULL DEFAULT 0)", [])
        .unwrap();
    conn.execute("INSERT INTO write_log(n) VALUES (0)", [])
        .unwrap();
    conn.execute(
        "CREATE TRIGGER trg AFTER UPDATE ON messages BEGIN UPDATE write_log SET n = n + 1; END",
        [],
    )
    .unwrap();

    assert!(
        fill_message_sha256(&conn, "file-t1", "aa11").unwrap(),
        "第一次回填必须报告「真的改了」—— 调用方据此决定是否通知前端"
    );
    let content: String = conn
        .query_row(
            "SELECT content FROM messages WHERE msg_id = 'file-t1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        content.contains("\"sha256\":\"aa11\""),
        "回填没生效：{content}"
    );
    assert!(
        content.contains("\"name\":\"a.bin\"") && content.contains("\"size\":7"),
        "只补一个字段，同载荷的其余键不得丢：{content}"
    );

    // 同值再进来（= outbox 重试的第二次尝试）不得再写一次，也不得报"改了"
    assert!(
        !fill_message_sha256(&conn, "file-t1", "aa11").unwrap(),
        "同值回填必须是 no-op"
    );
    assert_eq!(
        count(&conn, "SELECT n FROM write_log"),
        1,
        "同值回填不得产生第二次写入"
    );

    // 空值不覆盖已有值；不存在的 msg_id 静默通过（内容补发复用同一个投递函数）
    assert!(
        !fill_message_sha256(&conn, "file-t1", "").unwrap(),
        "空 sha256 必须直接跳过"
    );
    let after: String = conn
        .query_row(
            "SELECT content FROM messages WHERE msg_id = 'file-t1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        after.contains("\"sha256\":\"aa11\""),
        "空值不得擦掉已有 cid"
    );
    assert!(
        !fill_message_sha256(&conn, "file-missing", "bb22").unwrap(),
        "缺行必须返回 false（没有东西被补，也就没必要通知前端）"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM messages WHERE msg_id = 'file-missing'"
        ),
        0,
        "缺行必须静默通过，且不得凭空插入"
    );
    assert_eq!(
        count(&conn, "SELECT n FROM write_log"),
        1,
        "空值/缺行两条路径都不该产生写入"
    );
}

/// 进度节流的 upsert 传 `path=None` 时**不得擦掉**已记录的本地路径。
///
/// 钉的事故：发送行在建行时写入真实 path，而每 250ms 的进度 upsert 一律传 None ——
/// 没有 COALESCE 时第一次 tick 就把路径擦成 NULL，前端把 `file_transfers.path` 当作
/// content 缺 path 时的唯一兜底来源（useMessageFile），于是群图片预览整类失效。
#[test]
fn transfer_progress_upsert_never_erases_the_known_path() {
    let conn = fresh_db();
    upsert_transfer(
        &conn,
        "t1",
        "p1",
        "a.bin",
        10,
        "send",
        "pending",
        Some("/d/a.bin"),
        0.0,
    )
    .unwrap();
    let read = |conn: &Connection| {
        conn.query_row("SELECT path FROM file_transfers WHERE id = 't1'", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap()
    };
    assert_eq!(read(&conn).as_deref(), Some("/d/a.bin"));

    // 进度 tick：只有 progress 变，path 必须留着
    upsert_transfer(&conn, "t1", "p1", "a.bin", 10, "send", "active", None, 0.5).unwrap();
    assert_eq!(
        read(&conn).as_deref(),
        Some("/d/a.bin"),
        "传 None 表示「这次不知道」，不是「把它清空」"
    );
    let progress: f64 = conn
        .query_row(
            "SELECT progress FROM file_transfers WHERE id = 't1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        progress, 0.5,
        "其余字段照常更新，不能为了保 path 把进度也冻住"
    );

    // 真知道新路径时（收完 rename 到最终名）必须覆盖
    upsert_transfer(
        &conn,
        "t1",
        "p1",
        "a.bin",
        10,
        "receive",
        "done",
        Some("/d/a (1).bin"),
        1.0,
    )
    .unwrap();
    assert_eq!(read(&conn).as_deref(), Some("/d/a (1).bin"));
}

/// **传输行的终态契约（第 4 步 P7）**：`done` 是唯一不可降级的状态。
///
/// 为什么只有它：`done` 有磁盘证据（长度对 + sha256 对 + `sync_all()` 之后才 rename），
/// 用户此刻能在文件管理器里打开那个文件；而 `failed` / `cancelled` / `sent` 都**没有**
/// 这种证据 —— 尤其 `failed` 必须还能改回 `active`（见下面那条反向断言）。
///
/// 钉住的形状：39 个 `upsert_transfer` 调用点里有 12 处写 `failed`、12 处写 `active`，
/// 任何一处晚到一步（清扫器 / 重复帧 / 上一轮 attempt 的残留）就会把"已收到"改成
/// "失败"并把进度条从 100% 打回 0% —— 用户看到的是一个**打开就在那儿**的文件显示失败。
#[test]
fn a_completed_transfer_row_is_never_downgraded() {
    let conn = fresh_db();
    upsert_transfer(
        &conn,
        "t1",
        "p1",
        "a.bin",
        10,
        "receive",
        "done",
        Some("/d/a.bin"),
        1.0,
    )
    .unwrap();

    let read = |col: &str| -> String {
        conn.query_row(
            &format!("SELECT {col} FROM file_transfers WHERE id = 't1'"),
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    };
    // progress 是 REAL 列，rusqlite 不会替它转成 String ⇒ 单独一个读数器
    let progress = || -> f64 {
        conn.query_row(
            "SELECT progress FROM file_transfers WHERE id = 't1'",
            [],
            |r| r.get::<_, f64>(0),
        )
        .unwrap()
    };
    assert_eq!(read("status"), "done");

    // 晚到的失败判定：状态、进度、路径三样都不许动
    upsert_transfer(
        &conn, "t1", "p1", "a.bin", 10, "receive", "failed", None, 0.0,
    )
    .unwrap();
    assert_eq!(
        read("status"),
        "done",
        "done 行不许被晚到的 failed 判定降级（文件确实在盘上，界面却说失败）"
    );
    assert_eq!(
        progress(),
        1.0,
        "进度条不许从 100% 打回去 —— 它和 status 是同一条 DO UPDATE 的三个字段"
    );
    assert_eq!(
        read("path"),
        "/d/a.bin",
        "已完成行的本地路径必须留住（前端靠它打开文件）"
    );

    // 晚到的"重新开收"同样不许把它复活成 active
    upsert_transfer(
        &conn, "t1", "p1", "a.bin", 10, "receive", "active", None, 0.1,
    )
    .unwrap();
    assert_eq!(
        read("status"),
        "done",
        "同一 transfer_id 的迟到帧/残留不得把 done 改回 active"
    );
}

/// 反向断言：**非 done 的终态必须还能改回 `active`** —— 断点续传复用同一个 transfer_id
/// （`retry_incomplete_content` 直接取 `rec.transfer_id` 发 `ContentRequest`）。
///
/// 所以"终态不可覆盖"这条规则**不能**顺手扩到 failed/cancelled/pending：那样一判死
/// 就永远停在失败，而字节其实还在流 —— 症状恰好是本次要修的那个的反面。
/// 这条测试今天就会过，它存在的意义是当下一次有人把集合写成
/// `NOT IN ('done','failed','cancelled')` 时，让它红。
#[test]
fn a_failed_row_can_be_reactivated_by_the_next_attempt() {
    let conn = fresh_db();
    for (id, status) in [
        ("t-failed", "failed"),
        ("t-cancelled", "cancelled"),
        ("t-pending", "pending"),
    ] {
        upsert_transfer(&conn, id, "p1", "x.bin", 10, "receive", status, None, 0.0).unwrap();
        upsert_transfer(&conn, id, "p1", "x.bin", 10, "receive", "active", None, 0.0).unwrap();
        let got: String = conn
            .query_row(
                "SELECT status FROM file_transfers WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            got, "active",
            "{status} 行必须能被新一轮 attempt 改回 active，否则续传永远停在旧终态"
        );
    }
}

// ---------------------------------------------------------------------------
// B1：用户取消的终态墓碑（`cancel_terminal`）。
//
// 上面那条反向断言说的对：`cancelled` 今天必须还能被下一轮 attempt 改回 active ——
// 因为**自动**写下的 cancelled（对端拒绝、中继判死）确实该能重来。但用户主动取消是
// 另一件事：`cancel_file_transfer` 落库之后，投递任务是**异步**退出的，它可能带着上一轮
// 的进度、甚至带着"这次其实发完了"的 done 判定回来。没有墓碑时，那几笔晚到的写会把
// 用户刚按下的"已取消"改回"发送中 92%"或"已完成"。
//
// 所以这一族把两件事拆开：主动取消 ⇒ 盖墓碑、此后任何写都不许动它；自动终态 ⇒ 不盖。
// ---------------------------------------------------------------------------

fn transfer_row(conn: &Connection, id: &str) -> (String, f64, i64) {
    conn.query_row(
        "SELECT status, progress, cancel_terminal FROM file_transfers WHERE id = ?1",
        params![id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )
    .unwrap()
}

/// 正向：用户取消之后，晚到的进度写、晚到的 done 都改不动这一行。
#[test]
fn a_user_cancelled_transfer_is_never_revived_by_a_late_write() {
    let conn = fresh_db();
    upsert_transfer(&conn, "t1", "p1", "a.bin", 100, "send", "active", None, 0.3).unwrap();
    assert!(
        finalize_file_failure(&conn, "t1", FileJobEnd::Cancelled).unwrap(),
        "取消是用户动作：面向用户的写落地后必须回报 true"
    );
    assert_eq!(
        transfer_row(&conn, "t1"),
        ("cancelled".to_string(), 0.0, 1),
        "取消必须同时落 status=cancelled 与墓碑"
    );

    // 晚到的进度 tick（上一轮 attempt 还堵在链路队列里的那个形状）
    upsert_transfer(
        &conn, "t1", "p1", "a.bin", 100, "send", "active", None, 0.92,
    )
    .unwrap();
    assert_eq!(
        transfer_row(&conn, "t1"),
        ("cancelled".to_string(), 0.0, 1),
        "墓碑必须挡住晚到的 active —— 用户看到的就是\"取消了又自己变成发送中 92%\""
    );

    // 晚到的 done（对端真的收完了才回 ACK，而用户已经取消）同样不许把它升成完成：
    // 那会让界面从"已取消"跳到"✓"，与用户按下的动作相反。
    upsert_transfer(&conn, "t1", "p1", "a.bin", 100, "send", "done", None, 1.0).unwrap();
    assert_eq!(
        transfer_row(&conn, "t1").0,
        "cancelled",
        "墓碑行也不许被晚到的 done 升级（终态口径以用户动作为准）"
    );

    // 启动复位那条"active→failed"的批量写也必须绕开它（它只吃 active，墓碑行是 cancelled）
    assert_eq!(fail_interrupted_transfers_on_startup(&conn).unwrap(), 0);
    assert_eq!(transfer_row(&conn, "t1").0, "cancelled");
}

/// 反向：自动判死（超时/重试耗尽）**不许**盖墓碑 —— 那些行要能被断点续传救回来。
/// 这条是给"顺手把墓碑扩大到所有终态"的下一次准备的。
#[test]
fn an_auto_expired_transfer_keeps_its_resume_door_open() {
    let conn = fresh_db();
    upsert_transfer(
        &conn, "t2", "p1", "b.bin", 100, "receive", "active", None, 0.4,
    )
    .unwrap();
    finalize_file_failure(&conn, "t2", FileJobEnd::Expired).unwrap();
    assert_eq!(
        transfer_row(&conn, "t2"),
        ("failed".to_string(), 0.0, 0),
        "自动判死落 failed，且墓碑必须是 0（落库口径与续传能力都靠这一格区分）"
    );
    upsert_transfer(
        &conn, "t2", "p1", "b.bin", 100, "receive", "active", None, 0.5,
    )
    .unwrap();
    assert_eq!(
        transfer_row(&conn, "t2").0,
        "active",
        "同一 transfer_id 的续传必须还能把它改回 active —— 否则一次超时就永远停在失败"
    );
}

/// 已收完的那一单没有"被取消"这回事：`upsert_transfer` 被 `done` 闸门挡住时返回 Ok
/// 且改 0 行，所以 `changed` 会是 true —— 墓碑必须单独判 `already_done`，
/// 不然一个"已送达"的行会带着墓碑被读成"已取消"。
#[test]
fn a_cancel_on_an_already_done_transfer_writes_no_tombstone() {
    let conn = fresh_db();
    upsert_transfer(
        &conn,
        "t3",
        "p1",
        "c.bin",
        100,
        "receive",
        "done",
        Some("/d/c.bin"),
        1.0,
    )
    .unwrap();
    finalize_file_failure(&conn, "t3", FileJobEnd::Cancelled).unwrap();
    let (status, _, tomb) = transfer_row(&conn, "t3");
    assert_eq!(status, "done", "done 行不许被取消降级（INV-P26）");
    assert_eq!(
        tomb, 0,
        "已送达的行不许被盖上取消墓碑 —— 墓碑的语义是\"这一单被主动中止\"，与它相反"
    );
    // 本地路径仍在（前端靠它打开文件）
    assert_eq!(get_transfer_path(&conn, "t3").as_deref(), Some("/d/c.bin"));
}

/// 投递开始的抢占必须**如实回报**有没有真的迁移成功。
///
/// 旧签名是 `Result<()>`：取消发生在 `list_pending_file_outbox` 之后、这一笔之前时，
/// `WHERE status='pending'` 让 UPDATE 改 0 行（对的），但调用方看不出来，
/// 照样把整份文件发出去 —— 快照竞态。判据两头：pending 抢到 = true；已被取消 = false。
#[test]
fn claiming_an_outbox_row_reports_whether_it_was_actually_claimed() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, local_path, name, size, status,
                                 attempts, next_attempt_at, created_at)
         VALUES('t4','p1','/d/a.bin','a.bin',10,'pending',0,0,1)",
        [],
    )
    .unwrap();
    assert!(
        mark_file_outbox_sending(&conn, "t4", 0).unwrap(),
        "第一次必须真的从 pending 迁移成功"
    );
    assert!(
        !mark_file_outbox_sending(&conn, "t4", 0).unwrap(),
        "第二次（已被自己置 sending）必须报 false —— 调用方靠这个数决定发不发"
    );
    mark_file_outbox_cancelled(&conn, "t4").unwrap();
    assert!(
        !mark_file_outbox_sending(&conn, "t4", 0).unwrap(),
        "用户取消过的队列行再抢一次必须 false：false = 不发完整份"
    );
    // 不存在的那一行同样 false（不是 Err）—— 调用方不区分"没这行"和"被别人抢走"
    assert!(!mark_file_outbox_sending(&conn, "t-none", 0).unwrap());
}

/// **终态写入只有一个家**：除 `db/file_transfer.rs` 之外，不许再有第二处直接
/// `UPDATE file_transfers SET status = …`。
///
/// 为什么单独钉这条：`upsert_transfer` 加上"不得降级 done"之后，契约看起来就齐了 ——
/// 可 `commands/files.rs::fail_file_job` 里还有一句**绕过它**的裸 UPDATE，
/// 同一件事有两个家时，改一个忘一个是常态（本仓 P5/§9 那族"平行实现"反复就是这个形状）。
/// 状态迁移一律走 `db/file_transfer.rs` 里的具名助手，判据测试才能只认一处。
#[test]
fn terminal_status_writes_have_one_home() {
    let files = include_str!("../commands/files.rs");
    let leaked: Vec<&str> = files
        .lines()
        .filter(|l| {
            l.contains("UPDATE file_transfers")
                && l.contains("status")
                && !l.trim_start().starts_with("//")
                && !l.trim_start().starts_with("///")
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "commands/files.rs 里出现了 {} 处绕过 db 助手的裸状态写：{:?}",
        leaked.len(),
        leaked
    );
}

/// **用户主动取消不许记成失败**（第 4 步 P7 第 3 条）。
///
/// `cancel_file_transfer` 自己的注释写着「用户主动停止用 cancelled，自动失败用 failed」，
/// 而它紧接着调的是 `mark_file_outbox_failed` ⇒ `file_outbox.status` 落在 'failed'。
/// 三条队列查询都只认 pending/sending，所以**功能上没坏** —— 坏的是台账：
/// 下一次有人按 status 统计/排查"为什么这单失败"，读到的是一个用户自己按下的取消。
/// 注释与代码相反是本仓点过名的那类漂移（它会把下一个 AI 引去"照代码改注释"）。
#[test]
fn a_user_cancel_is_not_recorded_as_a_failure() {
    let files = include_str!("../commands/files.rs");
    // 锚点跟着 B3 搬家：命令体已经抽成唯一入口 `apply_local_cancel`
    // （对端的 `FileCancel` 帧也走这一个家），所以"取消不许记成失败"这条口径
    // 现在钉在那个家上，而不是钉在 IPC 包装层上 —— 判据要盯的是**写库那一处**，
    // 不是谁调它。（盯包装层的话，第二个入口就可以绕过它。）
    let at = files
        .find("pub(crate) async fn apply_local_cancel(")
        .expect("apply_local_cancel 不见了 ⇒ 本测试的锚点失效");
    let tail = &files[at..];
    let stop = tail
        .find("pub ")
        .map(|i| if i == 0 { tail.len() } else { i })
        .unwrap_or(tail.len());
    // 取到下一个顶层 `pub` 之前（本文件里取消命令之后紧跟 request_content）
    let body = &tail[..stop.max(1)];
    // P7 之后取消路径不再自己写库，而是把口径交给唯一出口 ⇒ 判据跟着改成
    // "必须声明 Cancelled 这一档，且不许自己碰队列状态写"。
    assert!(
        body.contains("FileJobEnd::Cancelled"),
        "取消必须走 `db::finalize_file_failure(.., FileJobEnd::Cancelled)` —— 三份收尾已合成一份"
    );
    for raw in ["mark_file_outbox_failed(", "mark_file_outbox_cancelled("] {
        assert!(
            !body.contains(raw),
            "取消路径里不该再出现 {raw}：队列状态只有唯一出口能写，两处各写一遍就是上次漂移的成因"
        );
    }
}

/// 反向的一半：**取消必须写群气泡**。上面那条"清扫器不碰 gfile-"不能被泛化成
/// "谁都别碰 gfile-" —— 取消入口是 1:1 与群文件共用的，用户取消的是整条消息，
/// 界面必须立刻变成"已取消"。（夹具刻意同时造 outbox 行与 `gfile-` 气泡：真实群文件
/// 只有气泡那一半存在，outbox 写 0 行无害 —— 这里要钉的是气泡那笔写有没有发生。）
#[test]
fn a_cancelled_group_file_marks_its_own_bubble() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
         VALUES('gfile-t5', 'group:g1', 'me', '', 'file', 'x', 1000, 1, 'sending')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, local_path, name, size, status,
                                 attempts, next_attempt_at, created_at)
         VALUES('t5', 'p1', '/d/z.bin', 'z.bin', 10, 'pending', 0, 0, 1)",
        [],
    )
    .unwrap();

    assert!(
        finalize_file_failure(&conn, "t5", FileJobEnd::Cancelled).unwrap(),
        "取消是用户动作：面向用户的写落地后必须回报 true"
    );
    let got: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'gfile-t5'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        got, "cancelled",
        "取消必须改写群气泡（与超时/放弃明确不同）"
    );
    let q: String = conn
        .query_row(
            "SELECT status FROM file_outbox WHERE transfer_id = 't5'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(q, "cancelled", "队列行走 cancelled 口径，不是 failed");
}

/// 「一台设备已经收完这份文件」的行，队列超时**不许把它报成失败** ——
/// 但队列行必须照样关掉。这两半都是语义，缺任何一边用户都会看见东西：
///  · 少了 `done` 闸门 ⇒ 用户看到一个「打开就在那儿的文件」显示失败（气泡被改成 failed）；
///  · 少了关行 ⇒ 那一行永远留在 pending/sending 集合里，`list_expired_file_outbox`
///    每个 tick 重扫一遍又什么都不做（活锁，且每次都白拿一次 db 锁）。
///
/// 为什么要单独钉：`commands::fail_file_job` 与 `finalize_expired_file` 都**只把
/// 这个返回值当作"要不要 emit file-failed"的唯一依据**（A3 那条纪律）。
/// 它一旦回归，编译器不会响、其余测试也不会响 —— 只有界面会。
#[test]
fn a_done_transfer_is_not_announced_failed_yet_its_queue_row_closes() {
    let conn = fresh_db();
    seed_send_job(&conn, "t6", "done");

    assert!(
        !finalize_file_failure(&conn, "t6", FileJobEnd::GiveUp).unwrap(),
        "台账已 done ⇒ 没有任何面向用户的写发生，必须回报 false（调用方据此不发 file-failed）"
    );
    assert_eq!(
        message_status(&conn, "file-t6"),
        "sending",
        "已收完的文件气泡不许被改成失败"
    );
    assert_eq!(
        transfer_status(&conn, "t6"),
        "done",
        "done 是不可降级的那一头"
    );
    assert_eq!(
        outbox_status(&conn, "t6"),
        "failed",
        "队列行仍然要关掉：它是它自己的状态机，且不能留在重试集合里"
    );
}

/// 失败收尾调用的是 `upsert_transfer(..., size = 0, ...)`（"这次不知道大小"）：
/// A-11 之后冲突分支会同步 size ⇒ 若原样把 0 写进去，一个已知 10 字节的失败单会被抹成 0。
#[test]
fn a_failure_finalize_keeps_the_known_transfer_size() {
    let conn = fresh_db();
    seed_send_job(&conn, "t8", "sending");

    finalize_file_failure(&conn, "t8", FileJobEnd::GiveUp).unwrap();

    let size: i64 = conn
        .query_row("SELECT size FROM file_transfers WHERE id = 't8'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(size, 10, "失败收尾只改状态/进度，不许把已知 size 抹成 0");
}

/// 反向的一半：没收成的那一行，三处必须**一起**推进并回报 true。
/// 只钉正向会变成"永远返回 false 也通过" —— 那正好是关掉 emit、让前端永久卡在 X% 的形状。
#[test]
fn an_unfinished_transfer_is_announced_failed_and_all_three_rows_move() {
    let conn = fresh_db();
    seed_send_job(&conn, "t7", "sending");

    assert!(
        finalize_file_failure(&conn, "t7", FileJobEnd::GiveUp).unwrap(),
        "没收到 ⇒ 面向用户的状态真的推进了，必须回报 true"
    );
    assert_eq!(message_status(&conn, "file-t7"), "failed");
    assert_eq!(transfer_status(&conn, "t7"), "failed");
    assert_eq!(outbox_status(&conn, "t7"), "failed");
}

/// 夹具：一条 1:1 文件消息气泡 + 一行台账（`status` 由用例决定）+ 一行 pending 队列。
fn seed_send_job(conn: &Connection, tid: &str, status: &str) {
    conn.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
         VALUES(?1, 'p1', 'me', 'p1', 'file', 'x', 1000, 1, 'sending')",
        params![format!("file-{tid}")],
    )
    .unwrap();
    upsert_transfer(conn, tid, "p1", "z.bin", 10, "send", status, None, 0.5).unwrap();
    conn.execute(
        "INSERT INTO file_outbox(transfer_id, peer_id, local_path, name, size, status,
                                 attempts, next_attempt_at, created_at)
         VALUES(?1, 'p1', '/d/z.bin', 'z.bin', 10, 'pending', 0, 0, 1)",
        params![tid],
    )
    .unwrap();
}

fn message_status(conn: &Connection, msg_id: &str) -> String {
    conn.query_row(
        "SELECT status FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn transfer_status(conn: &Connection, tid: &str) -> String {
    conn.query_row(
        "SELECT status FROM file_transfers WHERE id = ?1",
        params![tid],
        |r| r.get(0),
    )
    .unwrap()
}

fn outbox_status(conn: &Connection, tid: &str) -> String {
    conn.query_row(
        "SELECT status FROM file_outbox WHERE transfer_id = ?1",
        params![tid],
        |r| r.get(0),
    )
    .unwrap()
}

/// 源文件在发送前变大/变小时，**台账 size 必须跟实际值**；`done` 终态仍不许被晚到的写入改掉。
#[test]
fn transfer_upsert_keeps_size_in_sync_until_done() {
    let conn = fresh_db();
    upsert_transfer(
        &conn, "t1", "p1", "a.bin", 1_048_576, "send", "pending", None, 0.0,
    )
    .unwrap();
    upsert_transfer(
        &conn, "t1", "p1", "a.bin", 4096, "send", "active", None, 0.0,
    )
    .unwrap();
    let size: i64 = conn
        .query_row("SELECT size FROM file_transfers WHERE id = 't1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(size, 4096, "源文件变小后，台账必须跟实际发送字节数");

    upsert_transfer(
        &conn,
        "t1",
        "p1",
        "a.bin",
        4096,
        "send",
        "done",
        Some("/d/a.bin"),
        1.0,
    )
    .unwrap();
    upsert_transfer(&conn, "t1", "p1", "a.bin", 999, "send", "active", None, 0.0).unwrap();
    let (size, status): (i64, String) = conn
        .query_row(
            "SELECT size, status FROM file_transfers WHERE id = 't1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (size, status.as_str()),
        (4096, "done"),
        "done 终态不许被晚到的 size/status 覆盖"
    );
}

/// 发送文件气泡的 `size` 回填：只补这一个字段、同值幂等、缺行/非 JSON 静默跳过。
#[test]
fn fill_message_size_backfills_the_actual_size_once() {
    let conn = fresh_db();
    ins_msg(
        &conn,
        "file-t1",
        "p1",
        "file",
        "{\"name\":\"a.bin\",\"size\":1048576,\"sha256\":\"aa11\"}",
        1,
    );
    assert!(
        fill_message_size(&conn, "file-t1", 4096).unwrap(),
        "第一次回填必须报告真的改了行"
    );
    let content: String = conn
        .query_row(
            "SELECT content FROM messages WHERE msg_id = 'file-t1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(v["size"], 4096);
    assert_eq!(v["sha256"], "aa11", "其余字段不许被改动");
    assert!(
        !fill_message_size(&conn, "file-t1", 4096).unwrap(),
        "同值必须幂等，不产生第二次写"
    );
    assert!(!fill_message_size(&conn, "missing", 1).unwrap());
    ins_msg(&conn, "file-bad", "p1", "file", "not json", 2);
    assert!(!fill_message_size(&conn, "file-bad", 1).unwrap());
}

// ---------------- 取消一条还在队列里的消息（B4 的另一半，2026-10-23） ----------------
//
// 三格各管一条边界，缺任何一条都会留下一种"看得见"的错：
//  · 队列行没删 ⇒ 下一轮 flush 照样把它发出去（界面说已取消，对方照样收到）；
//  · 晚到的 Ack 能把 cancelled 提成 delivered ⇒ 回执从"已取消"跳回"已送达"；
//  · 已送达的行被改成 cancelled ⇒ 谎报"撤下来了"。

#[test]
fn cancelling_a_queued_message_drops_its_outbox_row_and_marks_it_cancelled() {
    let conn = fresh_db();
    ins_msg(&conn, "m-c1", "p1", "text", "在吗", 1);
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-c1','p1','{}',1)",
        [],
    )
    .unwrap();
    assert_eq!(
        super::cancel_queued_message(&conn, "m-c1").unwrap(),
        super::MessageCancelOutcome::Cancelled
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM outbox WHERE msg_id = 'm-c1'"),
        0,
        "队列行必须删掉：留着它下一轮 flush 就会把「已取消」的消息照常发出去"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled");
}

#[test]
fn a_late_ack_cannot_promote_a_cancelled_message() {
    let conn = fresh_db();
    ins_msg(&conn, "m-c2", "p1", "text", "这条已经被取消了", 1);
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-c2','p1','{}',1)",
        [],
    )
    .unwrap();
    super::cancel_queued_message(&conn, "m-c2").unwrap();
    // 取消之后 Ack 才到（Ack 与取消是两把锁先后拿到的）
    let acked = super::ack_delivered(&conn, "m-c2", "p1").unwrap();
    assert!(
        !acked,
        "晚到的 Ack 必须命中不到队列行（`ack_delivered` 的 expected 判据）—— 命中就说明它能把取消复活"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-c2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        status, "cancelled",
        "取消是硬终态：晚到的 Ack 不许把它提升成 delivered"
    );
}

#[test]
fn cancelling_an_already_delivered_message_reports_it_and_changes_nothing() {
    let conn = fresh_db();
    ins_msg(&conn, "m-c3", "p1", "text", "已经送到了", 1);
    conn.execute(
        "UPDATE messages SET status = 'delivered' WHERE msg_id = 'm-c3'",
        [],
    )
    .unwrap();
    assert_eq!(
        super::cancel_queued_message(&conn, "m-c3").unwrap(),
        super::MessageCancelOutcome::AlreadyDelivered,
        "已送达就是已送达：界面要说实话，不能假装撤回来了"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-c3'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "delivered", "已送达的行不许被取消降级");
    assert_eq!(
        super::cancel_queued_message(&conn, "m-nope").unwrap(),
        super::MessageCancelOutcome::NotFound
    );
}

/// 删好友要把他的聊天样式缓存也摘掉（10-23 审计 P2-B）。
///
/// 那张表（`settings.chat_peer_styles`）是设备级缓存：写入只在对方带 style 的消息到达时发生，
/// 而删除以前**只有**「恢复默认设置」一处 —— 删掉的好友会留一行 JSON 到进程退出之后，
/// 下次同设备再加回来还会继承上次的配色。这一格钉两件事：删掉的那个没了、别人的还在。
#[test]
fn removing_a_friend_forgets_its_chat_style() {
    let conn = fresh_db();
    super::set_setting(
        &conn,
        "chat_peer_styles",
        r#"{"p1":{"font":"x"},"p2":{"font":"y"}}"#,
    )
    .unwrap();
    super::forget_chat_peer_style(&conn, "p1").unwrap();
    let raw = super::get_setting(&conn, "chat_peer_styles").expect("键还在（还有 p2）");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(v.get("p1").is_none(), "删掉的那台设备不许留样式");
    assert!(v.get("p2").is_some(), "别人的样式不许被动");
    // 幂等：再摘一次、以及摘一个表里没有的 id，都不许报错、也不许把表写坏
    super::forget_chat_peer_style(&conn, "p1").unwrap();
    super::forget_chat_peer_style(&conn, "nobody").unwrap();
    let again: serde_json::Value =
        serde_json::from_str(&super::get_setting(&conn, "chat_peer_styles").unwrap()).unwrap();
    assert!(again.get("p2").is_some());
    // 接线：光有这个 helper 不够，删好友那条路必须真的调它（否则等于没修）
    let friends = include_str!("../commands/friends.rs");
    assert!(
        friends.contains("forget_chat_peer_style("),
        "删好友必须调用 forget_chat_peer_style：只写 helper 不接等于没修"
    );
}

/// 群消息的取消（2026-10-25 每成员台账）：判据是「**台账里还有没有 pending 行**」，
/// 不再是 `messages.status` —— 后者会被第一个成员的 Ack 推成 delivered，于是
/// 「明明还在排队」的消息被答成「已送达，不能取消」（用户实报的那条）。
///
/// 行也不再删掉：删除之后就再也回答不了「谁还没收到」，补发与部分送达都失去依据。
/// 取消 = 把 pending 行置 cancelled；迟到 Ack 只改行（`LateApplied`），消息停在 cancelled。
#[test]
fn cancelling_a_group_message_marks_every_member_row_and_survives_a_late_ack() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g1", "group:g1", "text", "大家好", 1);
    for member in ["a", "b", "c"] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES ('m-g1', 'g1', ?1, '{}', 1)",
            params![member],
        )
        .unwrap();
    }
    assert_eq!(
        super::cancel_queued_group_message(&conn, "m-g1").unwrap(),
        super::GroupMessageCancelOutcome::Cancelled {
            delivered: 0,
            cancelled: 3
        }
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_outbox WHERE msg_id = 'm-g1' AND status = 'cancelled'"
        ),
        3,
        "每个成员的 pending 行都要落 cancelled：留着谁，下一轮 flush 就会把它发出去"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-g1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled");
    // 迟到/在途的 Ack：只改台账（LateApplied），不许把 cancelled 提成 delivered。
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g1", "b").unwrap(),
        super::GroupAckOutcome::LateApplied,
        "取消之后迟到的 GroupAck 只允许记账，否则回执会从已取消跳回已送达"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-g1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled", "取消是硬终态（迟到 Ack 不推翻它）");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_outbox WHERE msg_id = 'm-g1' AND peer_id = 'b' \
             AND status = 'delivered'"
        ),
        1,
        "已取消消息的 delivered 墓碑必须保留：它是「已取消（对方已收到）」的唯一证据"
    );
}

/// 部分送达：有成员已经收下、其余还在排队 ⇒ 取消只停剩余成员，消息落 `partial_cancelled`。
/// 这是「部分已发送，可补发」的数据基础，也是不再用 `delivered` 一刀切挡住取消的原因。
#[test]
fn partially_delivered_group_message_can_cancel_the_rest_then_resend() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g3", "group:g1", "text", "一部分人收到", 1);
    for member in ["a", "b"] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES ('m-g3', 'g1', ?1, '{}', 1)",
            params![member],
        )
        .unwrap();
    }
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g3", "a").unwrap(),
        super::GroupAckOutcome::Applied
    );
    assert_eq!(
        super::cancel_queued_group_message(&conn, "m-g3").unwrap(),
        super::GroupMessageCancelOutcome::PartiallyCancelled {
            delivered: 1,
            cancelled: 1
        }
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-g3'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "partial_cancelled");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_outbox WHERE msg_id = 'm-g3' AND status = 'delivered'"
        ),
        1,
        "已收下的成员不许被取消改写"
    );
    // 补发：只把 cancelled 行重置为 pending，并刷新 created_at（否则清扫器会立刻判死旧行）。
    assert_eq!(
        super::resend_cancelled_group_rows(&conn, "m-g3", 9_999).unwrap(),
        1
    );
    let (status, created): (String, i64) = conn
        .query_row(
            "SELECT status, created_at FROM group_outbox
              WHERE msg_id = 'm-g3' AND peer_id = 'b'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "pending");
    assert_eq!(created, 9_999, "补发必须刷新 created_at");
    assert_eq!(
        super::list_group_pending_peers(&conn, "m-g3").unwrap(),
        vec!["b".to_string()]
    );
    // 已 delivered 的行不能被补发复活（证据不许被抹掉）。
    assert_eq!(
        super::resend_cancelled_group_rows(&conn, "m-g3", 10_000).unwrap(),
        0,
        "delivered 不是 cancelled：再次补发必须无行可动"
    );
}

/// 已有成员收下（状态 delivered）之后不许再取消：那一步只能走撤回。
///
/// 全部送达时墓碑已被即时清理（台账 0 行），所以这里同时钉住「空台账必须用消息状态兜底」——
/// 否则一条真·已送达的消息会被答成 `not_found`。
#[test]
fn a_delivered_group_message_cannot_be_cancelled() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g2", "group:g1", "text", "已经有人收到了", 1);
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
         VALUES ('m-g2', 'g1', 'b', '{}', 1)",
        [],
    )
    .unwrap();
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g2", "b").unwrap(),
        super::GroupAckOutcome::Applied
    );
    assert_eq!(
        super::cancel_queued_group_message(&conn, "m-g2").unwrap(),
        super::GroupMessageCancelOutcome::AlreadyDelivered {
            delivered: 0,
            remaining: 0
        },
        "有人收下了就只能撤回，不能假装「取消发送」"
    );
    assert_eq!(
        super::cancel_queued_group_message(&conn, "nope").unwrap(),
        super::GroupMessageCancelOutcome::NotFound
    );
}

/// 清扫判死之后才到的 Ack：只改台账（`LateApplied`），不许把 failed 翻成 delivered。
///
/// 现实顺序：成员离线超时 ⇒ 清扫器把他的 pending 行置 failed（不删，保留证据）⇒
/// 该成员其实收到了（半开链路对端已落库）⇒ 迟到 Ack 到达。若这里返回 `Applied`，
/// 界面会收到第二条"已送达"事件，而库里那条消息早就是 failed。
#[test]
fn a_late_ack_after_sweeper_failure_only_updates_the_ledger() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g4", "group:g1", "text", "清扫之后才到", 1);
    conn.execute(
        "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
         VALUES ('m-g4', 'g1', 'b', '{}', 1)",
        [],
    )
    .unwrap();
    assert_eq!(
        super::mark_group_outbox_failed(&conn, "m-g4", "b").unwrap(),
        1
    );
    conn.execute(
        "UPDATE messages SET status = 'failed' WHERE msg_id = 'm-g4'",
        [],
    )
    .unwrap();
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g4", "b").unwrap(),
        super::GroupAckOutcome::LateApplied,
        "failed 行上的迟到 Ack 只记账"
    );
    let status: String = conn
        .query_row(
            "SELECT status FROM messages WHERE msg_id = 'm-g4'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "failed", "本端判死的结论不会被对端迟到的 Ack 推翻");
    let (delivered, _) = super::group_outbox_progress_counts(&conn, "m-g4").unwrap();
    assert_eq!(delivered, 1, "台账要留下「他其实收到了」这一条证据");
}

/// 投递摘要：正常完成的消息不进摘要（墓碑已清），有尚未送达成员的消息才在。
#[test]
fn delivery_summaries_only_list_messages_with_unfinished_rows() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g5", "group:g1", "text", "全部送达", 1);
    ins_msg(&conn, "m-g6", "group:g1", "text", "还差一个", 2);
    ins_msg(&conn, "m-g7", "group:g2", "text", "别的群", 3);
    for (mid, gid, peer) in [
        ("m-g5", "g1", "a"),
        ("m-g6", "g1", "a"),
        ("m-g6", "g1", "b"),
        ("m-g7", "g2", "a"),
    ] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES (?1, ?2, ?3, '{}', 1)",
            params![mid, gid, peer],
        )
        .unwrap();
    }
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g5", "a").unwrap(),
        super::GroupAckOutcome::Applied
    );
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g6", "a").unwrap(),
        super::GroupAckOutcome::Applied
    );
    let rows = super::group_message_delivery_summaries(&conn, "group:g1").unwrap();
    assert_eq!(rows.len(), 1, "全部送达的那条必须已经从摘要里消失");
    assert_eq!(rows[0].msg_id, "m-g6");
    assert_eq!(
        (
            rows[0].delivered,
            rows[0].pending,
            rows[0].cancelled,
            rows[0].failed
        ),
        (1, 1, 0, 0),
        "摘要四个计数直接来自台账"
    );
    assert!(
        super::group_message_delivery_summaries(&conn, "group:g2").unwrap()[0].pending == 1,
        "别的群互不影响"
    );
}

// ---------------------------------------------------------------------------
// FUNC-02/03/04（2026-10-24 审计）：取消收口一个事务、不造幽灵行、复位尊重墓碑。
// ---------------------------------------------------------------------------

/// FUNC-03：群文件的台账在 `group_files` / `group_file_recipients` 里 ——
/// `file_transfers` 里没有它的行。旧实现把"有没有气泡"当成"要不要写台账"的判据，
/// 而群那一半**只有气泡**（`gfile-`），于是取消一条群文件会插出一行 peer_id/name 全空的
/// 幽灵记录：任务中心多出一条打不开的传输，且 `file_transfers` 会被它永久污染。
#[test]
fn a_group_only_cancel_writes_no_ghost_transfer_row() {
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
         VALUES('gfile-t12', 'group:g1', 'me', '', 'file', 'x', 1000, 1, 'sending')",
        [],
    )
    .unwrap();
    let before = count(&conn, "SELECT COUNT(*) FROM file_transfers");

    assert!(
        finalize_file_failure(&conn, "t12", FileJobEnd::Cancelled).unwrap(),
        "群气泡真的推进了 ⇒ 界面必须被通知（不能因为不写台账就回报 false）"
    );
    assert_eq!(
        message_status(&conn, "gfile-t12"),
        "cancelled",
        "群气泡仍必须落 cancelled：这一笔是面向用户的写"
    );
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM file_transfers"),
        before,
        "不许为一条只在 group_files 里的群文件插出幽灵台账行（FUNC-03）"
    );
}

/// FUNC-02 复审：群取消的**成员行 + 聚合行**必须在同一个事务里。
///
/// 旧实现分两笔写：成员行已 cancelled、聚合行仍 sending ⇒ 不会被补发，但气泡/摘要
/// 一直显示"还在传"，而且没有任何入口会修正它。
#[test]
fn group_cancel_writes_recipients_and_summary_atomically() {
    fn seed(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at)
             VALUES('t13','g1','me','a.bin',10,'x','sending',1);
             INSERT INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
             VALUES('t13','bob','pending',0.0,1),('t13','carol','sending',0.5,1);",
        )
        .unwrap();
    }
    fn status(conn: &Connection, sql: &str) -> String {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    let conn = fresh_db();
    seed(&conn);
    let n = cancel_group_file_atomically(&conn, "t13").unwrap();
    assert_eq!(n, 2, "两条还在途的成员行都必须被取消");
    assert_eq!(
        status(
            &conn,
            "SELECT status FROM group_files WHERE transfer_id='t13'"
        ),
        "cancelled",
        "聚合行必须同批落 cancelled"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_file_recipients WHERE status='cancelled'"
        ),
        2,
        "成员行必须同批落 cancelled"
    );

    // 失败路：第二笔写失败时，第一笔必须一起回滚（不能留下"成员已取消、聚合仍在发送"）
    let conn = fresh_db();
    seed(&conn);
    conn.execute_batch(
        "CREATE TRIGGER block_group_files BEFORE UPDATE ON group_files
         BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;",
    )
    .unwrap();
    assert!(
        cancel_group_file_atomically(&conn, "t13").is_err(),
        "写失败必须回传 Err（调用方据此把 ledger_committed 置 false）"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_file_recipients WHERE status='cancelled'"
        ),
        0,
        "第一笔必须随事务回滚 —— 否则成员行与聚合行口径分裂"
    );
    assert_eq!(
        status(
            &conn,
            "SELECT status FROM group_files WHERE transfer_id='t13'"
        ),
        "sending",
        "聚合行保持原状（事务整体回滚）"
    );
}

/// FUNC-04：盖了墓碑的行不许被**启动复位**复活。
///
/// 复现的是崩溃窗口：取消事务已经提交（墓碑 + cancelled 都在），进程在下一次 flush
/// 之前死掉，重启时队列行还是 `sending`。旧 SQL 只看 `status='sending'` ⇒ 把它改回
/// `pending` ⇒ 用户取消过的文件又被重发一遍。对照组证明复位本身没有被整条废掉。
#[test]
fn a_tombstoned_file_is_not_requeued_by_startup_reset() {
    let conn = fresh_db();
    seed_send_job(&conn, "t9", "active");
    assert!(finalize_file_failure(&conn, "t9", FileJobEnd::Cancelled).unwrap());
    conn.execute(
        "UPDATE file_outbox SET status = 'sending' WHERE transfer_id = 't9'",
        [],
    )
    .unwrap();

    // 对照组：同样的 sending，但没有墓碑 ⇒ 必须照旧复活。
    seed_send_job(&conn, "t10", "active");
    conn.execute(
        "UPDATE file_outbox SET status = 'sending' WHERE transfer_id = 't10'",
        [],
    )
    .unwrap();

    assert_eq!(
        reset_sending_to_pending(&conn).unwrap(),
        1,
        "只该复活对照组那一行 —— 修 FUNC-04 不等于废掉整条崩溃恢复"
    );
    assert_eq!(
        outbox_status(&conn, "t9"),
        "sending",
        "墓碑行不许被改回 pending：下一轮 flush 会把它重发一遍"
    );
    assert_eq!(
        outbox_status(&conn, "t10"),
        "pending",
        "没有墓碑的在途行仍必须被复位（真机：发了一半的图重启后再也没到）"
    );
}

/// FUNC-02：取消的四笔写共处一个事务 —— 任何一处失败都必须**整体回滚**并把 `Err`
/// 交回调用方，界面据此改说"本机已停止、状态待重试"，而不是谎称"已取消"。
///
/// 这里用触发器让**最后一步**（关队列行）失败：前面几笔已经写进去了，正好考回滚。
/// 如果实现退回"四条独立语句"，气泡与台账会留在改后的状态，这条就会红。
#[test]
fn a_failed_cancel_write_rolls_back_the_whole_finalize() {
    let conn = fresh_db();
    seed_send_job(&conn, "t11", "active");
    conn.execute_batch(
        "CREATE TRIGGER block_outbox_update BEFORE UPDATE ON file_outbox
         BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;",
    )
    .unwrap();

    assert!(
        finalize_file_failure(&conn, "t11", FileJobEnd::Cancelled).is_err(),
        "写失败必须回传 Err：`Ok(false)` 会让调用方以为「没什么要改」，界面继续谎称已取消"
    );
    assert_eq!(
        message_status(&conn, "file-t11"),
        "sending",
        "气泡必须跟着回滚：否则刷新前说已取消、刷新后又是发送中"
    );
    assert_eq!(transfer_status(&conn, "t11"), "active", "台账必须跟着回滚");
    assert_eq!(
        transfer_row(&conn, "t11").2,
        0,
        "墓碑必须跟着回滚：落下了就再也不会被重试"
    );
    assert_eq!(
        outbox_status(&conn, "t11"),
        "pending",
        "队列行必须还在重试集合里：它失败的那一笔正是要重试的东西"
    );
}

/// 撤回的三笔写是**一笔事务**（B1-F6，5.15.50）。
///
/// 原先三个调用点各自 `insert_recall(..).ok(); materialize_recall(..).ok()`：
/// 一笔成一笔败就永久分裂，而幂等短路只看墓碑 ⇒ 重试也补不上。
/// 这里钉三件事：① 正常路径三笔都落；② 幂等；③ **第三笔失败时前两笔必须回滚**（事务的意义）。
#[test]
fn apply_recall_is_one_transaction_and_idempotent() {
    let conn = fresh_db();
    ins_msg(&conn, "m-1", "c-1", "text", "原文", 1);
    conn.execute(
        "INSERT INTO conversations(id, kind, name, last_msg, last_ts, unread) VALUES ('c-1','single','p','原文',1000,1)",
        [],
    )
    .unwrap();
    // ① 正常路径：墓碑 + 物化 + 预览三笔都落
    apply_recall(&conn, "c-1", "m-1", "me", 2).expect("正常撤回不该失败");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_recalled_messages WHERE msg_id='m-1'"
        ),
        1,
        "墓碑必须落下"
    );
    let (kind, content): (String, String) = conn
        .query_row(
            "SELECT kind, content FROM messages WHERE msg_id='m-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (kind.as_str(), content.as_str()),
        ("recalled", ""),
        "物化必须清正文、改 kind"
    );
    let last: String = conn
        .query_row(
            "SELECT last_msg FROM conversations WHERE id='c-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(last, "原文", "会话预览必须跟着重算（否则列表还挂着原文）");

    // ② 幂等：再来一次不报错、状态不变
    apply_recall(&conn, "c-1", "m-1", "me", 2).expect("重复撤回必须幂等");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM group_recalled_messages WHERE msg_id='m-1'"
        ),
        1,
        "幂等：墓碑不许变两行"
    );

    // ③ 原子性：把第三笔依赖的表拿掉 ⇒ 前两笔必须回滚
    let conn2 = fresh_db();
    ins_msg(&conn2, "m-2", "c-2", "text", "另一条原文", 1);
    conn2.execute("DROP TABLE conversations", []).unwrap();
    let err = apply_recall(&conn2, "c-2", "m-2", "me", 3).expect_err("预览重算失败必须整笔失败");
    assert!(!err.to_string().is_empty());
    assert_eq!(
        count(
            &conn2,
            "SELECT COUNT(*) FROM group_recalled_messages WHERE msg_id='m-2'"
        ),
        0,
        "第三笔失败 ⇒ 墓碑必须回滚（否则就是那个「说撤过、正文还在」的永久分裂）"
    );
    let still: String = conn2
        .query_row("SELECT content FROM messages WHERE msg_id='m-2'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(still, "另一条原文", "物化也必须回滚");
}

/// F-MSG-040：撤回的三笔写（墓碑 / 物化 / 会话预览）必须是**一笔事务**。
///
/// B1-F6 之前前两笔各 `.ok()`：墓碑写进去而物化失败就永久分裂，而幂等短路**只看墓碑**
/// ⇒ 重试也补不上（用户看到"撤回了"但正文还在，或者反过来永远撤不掉）。
/// 这里抽掉第三步要写的父表（`DROP TABLE conversations`）造出"最后一步必失败"的结局，
/// 断言**墓碑没有留下来**、消息行也一字未改 —— 半成品状态一条都不许可见。
#[test]
fn a_failed_recall_write_leaves_no_tombstone_behind() {
    let conn = fresh_db();
    ins_msg(&conn, "m-r1", "p-r1", "text", "要撤回的话", 1);
    conn.execute("DROP TABLE conversations", []).unwrap();
    let got = super::apply_recall(&conn, "p-r1", "m-r1", "me", 7);
    assert!(
        got.is_err(),
        "最后一步写失败却返回 Ok ⇒ 事务没起作用：{got:?}"
    );
    assert!(
        !super::is_recalled(&conn, "m-r1"),
        "墓碑被提前提交了：幂等短路会把它当成「已撤回」，重试永远补不上物化"
    );
    let (kind, content): (String, String) = conn
        .query_row(
            "SELECT kind, content FROM messages WHERE msg_id = 'm-r1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        (kind.as_str(), content.as_str()),
        ("text", "要撤回的话"),
        "物化被提前提交了：半成品状态在界面上可见"
    );
}

// ---------------- 批次 2A：消息生命周期的纯策略 oracle + 序列对照 ----------------
//
// 这一组**不碰任何写入点**：oracle 只把现有 SQL/台账里已经写死的策略再表达一遍，
// 然后用真实 DB 调用跑同一串事件，逐条比对状态与行。它的价值是给 2B 的解禁
// 留一份“决策面”证据，而不是把 SQL 换成一个看似更优雅的纯函数。

fn direct_ack_policy(has_outbox_row: bool) -> bool {
    has_outbox_row
}

fn direct_cancel_policy(status: &str) -> bool {
    !matches!(status, "delivered" | "read" | "recalled")
}

fn direct_resend_policy(status: &str) -> bool {
    matches!(status, "failed" | "cancelled")
}

fn group_cancel_target_policy(pending: i64, delivered: i64) -> Option<&'static str> {
    if pending == 0 {
        None
    } else if delivered > 0 {
        Some("partial_cancelled")
    } else {
        Some("cancelled")
    }
}

fn group_ack_advances_message_policy(prior: &str) -> bool {
    prior == "pending"
}

fn group_resend_revives_policy(status: &str) -> bool {
    status == "cancelled"
}

fn status_of(conn: &Connection, msg_id: &str) -> String {
    conn.query_row(
        "SELECT status FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn outbox_rows(conn: &Connection, msg_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE msg_id = ?1",
        params![msg_id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn direct_message_lifecycle_policy_matches_sql_guards() {
    let conn = fresh_db();

    // Ack 只有在补发队列行还在时才成立。
    ins_msg(&conn, "m-ac1", "p1", "text", "ack", 1);
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-ac1','p1','{}',1)",
        [],
    )
    .unwrap();
    assert!(direct_ack_policy(outbox_rows(&conn, "m-ac1") > 0));
    assert!(super::ack_delivered(&conn, "m-ac1", "p1").unwrap());
    assert_eq!(status_of(&conn, "m-ac1"), "delivered");
    assert_eq!(outbox_rows(&conn, "m-ac1"), 0);

    // 取消先删队列行；迟到 Ack 不再成立，消息停在 cancelled。
    ins_msg(&conn, "m-ac2", "p1", "text", "cancel", 2);
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-ac2','p1','{}',1)",
        [],
    )
    .unwrap();
    assert!(direct_cancel_policy(&status_of(&conn, "m-ac2")));
    assert_eq!(
        super::cancel_queued_message(&conn, "m-ac2").unwrap(),
        super::MessageCancelOutcome::Cancelled
    );
    assert!(!direct_ack_policy(outbox_rows(&conn, "m-ac2") > 0));
    assert!(!super::ack_delivered(&conn, "m-ac2", "p1").unwrap());
    assert_eq!(status_of(&conn, "m-ac2"), "cancelled");

    // 重发只接受 failed/cancelled；delivered 原地不动。
    ins_msg(&conn, "m-rs1", "p1", "text", "resend", 3);
    conn.execute(
        "UPDATE messages SET status='failed' WHERE msg_id='m-rs1'",
        [],
    )
    .unwrap();
    assert!(direct_resend_policy(&status_of(&conn, "m-rs1")));
    assert_eq!(
        super::requeue_message_for_resend(&conn, "m-rs1", "p1", "{}").unwrap(),
        1
    );
    assert_eq!(status_of(&conn, "m-rs1"), "sending");
    assert_eq!(outbox_rows(&conn, "m-rs1"), 1);

    conn.execute(
        "UPDATE messages SET status='delivered' WHERE msg_id='m-rs1'",
        [],
    )
    .unwrap();
    assert!(!direct_resend_policy(&status_of(&conn, "m-rs1")));
    assert_eq!(
        super::requeue_message_for_resend(&conn, "m-rs1", "p1", "{}").unwrap(),
        0
    );
    assert!(!direct_cancel_policy(&status_of(&conn, "m-rs1")));
    assert_eq!(
        super::cancel_queued_message(&conn, "m-rs1").unwrap(),
        super::MessageCancelOutcome::AlreadyDelivered
    );
    assert_eq!(status_of(&conn, "m-rs1"), "delivered");
}

#[test]
fn group_message_lifecycle_policy_matches_ledger_sequences() {
    let conn = fresh_db();
    ins_msg(&conn, "m-g1", "group:g1", "text", "群生命周期", 1);
    for member in ["a", "b", "c"] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES ('m-g1', 'g1', ?1, '{}', 1)",
            params![member],
        )
        .unwrap();
    }

    // 第一个成员 Ack：行 pending → delivered，消息推进成 delivered。
    assert!(group_ack_advances_message_policy("pending"));
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g1", "a").unwrap(),
        super::GroupAckOutcome::Applied
    );
    assert_eq!(status_of(&conn, "m-g1"), "delivered");

    // 取消剩余两个 pending：消息允许从 delivered 覆盖成 partial_cancelled。
    assert_eq!(group_cancel_target_policy(2, 1), Some("partial_cancelled"));
    assert_eq!(
        super::cancel_queued_group_message(&conn, "m-g1").unwrap(),
        super::GroupMessageCancelOutcome::PartiallyCancelled {
            delivered: 1,
            cancelled: 2
        }
    );
    assert_eq!(status_of(&conn, "m-g1"), "partial_cancelled");

    // 迟到 Ack 只改行，不把 partial_cancelled 翻回 delivered。
    assert!(!group_ack_advances_message_policy("cancelled"));
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g1", "b").unwrap(),
        super::GroupAckOutcome::LateApplied
    );
    assert_eq!(status_of(&conn, "m-g1"), "partial_cancelled");
    assert_eq!(
        super::ack_group_delivered(&conn, "m-g1", "a").unwrap(),
        super::GroupAckOutcome::Duplicate
    );

    // 补发只复活 cancelled；failed 永不复活。
    assert!(group_resend_revives_policy("cancelled"));
    assert_eq!(
        super::resend_cancelled_group_rows(&conn, "m-g1", 99).unwrap(),
        1,
        "b 已被迟到 Ack 改回 delivered ⇒ 只剩 c 一行 cancelled"
    );
    assert_eq!(status_of(&conn, "m-g1"), "sending");
    assert_eq!(
        super::mark_group_outbox_failed(&conn, "m-g1", "c").unwrap(),
        1
    );
    assert!(!group_resend_revives_policy("failed"));
    assert_eq!(
        super::resend_cancelled_group_rows(&conn, "m-g1", 100).unwrap(),
        0
    );
    assert_eq!(status_of(&conn, "m-g1"), "sending");
}

// ---------------- 批次 2B 第一笔：取消判据的两处落点必须给同一个答案 ----------------
//
// 这一笔**只加测试、不改实现**（特征测试）。同一条「现在能不能取消」被写了两遍：
//  · 写入口的判定 —— `cancel_queued_message` 的 `matches!`、`cancel_queued_group_message`
//    的台账计数；
//  · 读出口给界面的 `PendingMessageOp::can_cancel`。
//
// 两处漂移时用户看到的是「明明还在排队，点取消却说已送达」（2026-10-25 实报），
// 或者反过来 —— 一颗注定点不动的灰按钮。下面逐状态把「有没有列出来 / 按钮给不给」
// 与「后端真的答什么」对上；后续把判据收成一个纯函数时，这份断言原样保留。

fn pending_can_cancel(conn: &Connection, msg_id: &str) -> Option<bool> {
    super::list_pending_message_operations(conn, super::MESSAGE_OPS_LIMIT)
        .unwrap()
        .into_iter()
        .find(|op| op.msg_id == msg_id)
        .map(|op| op.can_cancel)
}

fn force_status(conn: &Connection, msg_id: &str, status: &str) {
    conn.execute(
        "UPDATE messages SET status = ?2 WHERE msg_id = ?1",
        params![msg_id, status],
    )
    .unwrap();
}

#[test]
fn direct_cancel_button_matches_the_backend_outcome_for_every_status() {
    for (status, listed, expected) in [
        ("sending", true, super::MessageCancelOutcome::Cancelled),
        ("sent", true, super::MessageCancelOutcome::Cancelled),
        ("failed", true, super::MessageCancelOutcome::Cancelled),
        // 取消过的行不再留队列行 ⇒ 列表里没有它（重复点由后端幂等吞掉，不给按钮）。
        ("cancelled", false, super::MessageCancelOutcome::Cancelled),
        (
            "partial_cancelled",
            false,
            super::MessageCancelOutcome::Cancelled,
        ),
        (
            "delivered",
            false,
            super::MessageCancelOutcome::AlreadyDelivered,
        ),
        ("read", false, super::MessageCancelOutcome::AlreadyDelivered),
        (
            "recalled",
            false,
            super::MessageCancelOutcome::AlreadyDelivered,
        ),
    ] {
        let conn = fresh_db();
        ins_msg(&conn, "m-1", "p1", "text", "取消判据", 1);
        force_status(&conn, "m-1", status);
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-1','p1','{}',1)",
            [],
        )
        .unwrap();

        let button = pending_can_cancel(&conn, "m-1");
        assert_eq!(
            button.is_some(),
            listed,
            "status={status}：任务中心列不列这条，口径变了"
        );
        assert!(
            !listed || button == Some(true),
            "status={status}：列出来的行必须给取消按钮"
        );
        let outcome = super::cancel_queued_message(&conn, "m-1").unwrap();
        assert_eq!(outcome, expected, "status={status}：后端取消结论变了");
        if let Some(btn) = button {
            assert_eq!(
                btn,
                matches!(outcome, super::MessageCancelOutcome::Cancelled),
                "status={status}：按钮说 {btn}，后端答 {outcome:?} —— 两处判据漂移"
            );
        }
    }

    // 队列行还在、消息行没了：列出来（这是另一类真实故障），但不给按钮 —— 后端回 NotFound。
    let conn = fresh_db();
    conn.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('orphan','p1','{}',1)",
        [],
    )
    .unwrap();
    assert_eq!(
        pending_can_cancel(&conn, "orphan"),
        Some(false),
        "孤儿队列行要看得见，但不能给一颗注定失败的取消按钮"
    );
    assert_eq!(
        super::cancel_queued_message(&conn, "orphan").unwrap(),
        super::MessageCancelOutcome::NotFound
    );
}

#[test]
fn group_cancel_button_matches_the_backend_outcome_for_every_status() {
    for (status, listed, expected) in [
        (
            "sending",
            true,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        (
            "sent",
            true,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        (
            "failed",
            true,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        // 台账两行仍 pending 的「已取消」是合成态（正常取消会把行一起置 cancelled），
        // 后端会再执行一次（幂等），列表不列 —— 没有按钮就无所谓一致性。
        (
            "cancelled",
            false,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        (
            "partial_cancelled",
            false,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        // 群消息 delivered 只代表「至少一人已收」：仍要列出并可取消剩余成员。
        (
            "delivered",
            true,
            super::GroupMessageCancelOutcome::Cancelled {
                delivered: 0,
                cancelled: 2,
            },
        ),
        ("read", false, super::GroupMessageCancelOutcome::Rejected),
        (
            "recalled",
            false,
            super::GroupMessageCancelOutcome::Rejected,
        ),
    ] {
        let conn = fresh_db();
        ins_msg(&conn, "m-g", "group:g1", "text", "群取消判据", 1);
        force_status(&conn, "m-g", status);
        for member in ["a", "b"] {
            conn.execute(
                "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
                 VALUES ('m-g','g1',?1,'{}',1)",
                params![member],
            )
            .unwrap();
        }

        let button = pending_can_cancel(&conn, "m-g");
        assert_eq!(
            button.is_some(),
            listed,
            "status={status}：任务中心列不列这条，口径变了"
        );
        assert!(
            !listed || button == Some(true),
            "status={status}：列出来的群消息必须给取消按钮"
        );
        let outcome = super::cancel_queued_group_message(&conn, "m-g").unwrap();
        assert_eq!(outcome, expected, "status={status}：群取消结论变了");
        if let Some(btn) = button {
            let backend_allows = matches!(
                outcome,
                super::GroupMessageCancelOutcome::Cancelled { .. }
                    | super::GroupMessageCancelOutcome::PartiallyCancelled { .. }
            );
            assert_eq!(
                btn, backend_allows,
                "status={status}：按钮说 {btn}，后端答 {outcome:?} —— 两处判据漂移"
            );
        }
    }

    // 2026-10-25 用户实报的那条：一个成员已 Ack（消息被推成 delivered），其余还在排队。
    // 任务中心必须仍列出、仍给按钮，后端必须真的只取消剩余成员。
    let conn = fresh_db();
    ins_msg(&conn, "m-part", "group:g1", "text", "部分送达", 1);
    for member in ["a", "b"] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES ('m-part','g1',?1,'{}',1)",
            params![member],
        )
        .unwrap();
    }
    // a 收下 ⇒ 行 delivered、消息被推成 delivered；b 仍是 pending（墓碑因此未被清理）。
    assert_eq!(
        super::ack_group_delivered(&conn, "m-part", "a").unwrap(),
        super::GroupAckOutcome::Applied
    );
    assert_eq!(status_of(&conn, "m-part"), "delivered");
    assert_eq!(
        pending_can_cancel(&conn, "m-part"),
        Some(true),
        "还有成员没收到 ⇒ 必须列出且可取消（这正是实报的死按钮）"
    );
    assert_eq!(
        super::cancel_queued_group_message(&conn, "m-part").unwrap(),
        super::GroupMessageCancelOutcome::PartiallyCancelled {
            delivered: 1,
            cancelled: 1
        },
        "已收下的成员保持 delivered，只取消剩余成员"
    );
    assert_eq!(status_of(&conn, "m-part"), "partial_cancelled");
}

// ---------------- 批次 2B 第二笔：迟到写被拒的门族逐状态钉死 ----------------
//
// 四扇门各自守一份 `status NOT IN (...)`：`set_message_status`、`ack_delivered`、
// 已读回执（`mark_own_messages_read_upto`）、重发（`requeue_message_for_resend`）。
// 这一笔只加测试（后续把集合搬进 `message_lifecycle`，行为必须逐字不变）：
// 逐状态记录「这道门动不动这一行、动成什么」，任何一格变了都是行为变化，不是重构。

#[test]
fn late_write_door_family_pins_every_status() {
    // (状态, set_message_status 能否改, 结果状态, Ack 后状态, 已读回执能否推, 能否重发)
    for (status, set_writes, after_set, after_ack, read_advances, can_resend) in [
        ("sending", true, "sent", "delivered", true, false),
        // 已经是 sent 的再写一次 sent：不是终态，门照开（幂等由调用方判是否需要）
        ("sent", true, "sent", "delivered", true, false),
        ("failed", false, "failed", "delivered", false, true),
        ("cancelled", false, "cancelled", "delivered", false, true),
        (
            "partial_cancelled",
            false,
            "partial_cancelled",
            "delivered",
            false,
            false,
        ),
        ("delivered", false, "delivered", "delivered", true, false),
        ("read", false, "read", "read", false, false),
        ("recalled", false, "recalled", "recalled", false, false),
    ] {
        // ① set_message_status：迟到写把状态推成 sent
        let conn = fresh_db();
        ins_msg(&conn, "m-1", "p1", "text", "迟到写", 1);
        force_status(&conn, "m-1", status);
        let changed = super::set_message_status(&conn, "m-1", "sent").unwrap();
        assert_eq!(
            changed == 1,
            set_writes,
            "status={status}：set_message_status 的门变了"
        );
        assert_eq!(status_of(&conn, "m-1"), after_set, "status={status}");

        // ② ack_delivered：队列行在 ⇒ 命中；状态只在硬终态才不动。
        let conn = fresh_db();
        ins_msg(&conn, "m-1", "p1", "text", "Ack", 1);
        force_status(&conn, "m-1", status);
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES ('m-1','p1','{}',1)",
            [],
        )
        .unwrap();
        assert!(
            super::ack_delivered(&conn, "m-1", "p1").unwrap(),
            "status={status}：队列行在时 Ack 必须命中"
        );
        assert_eq!(status_of(&conn, "m-1"), after_ack, "status={status}");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM outbox"),
            0,
            "Ack 收尾必须删掉队列行（否则下次补发会再发一遍）"
        );

        // ③ 已读回执：对端证据只能点亮「本端确实发出去过、且没被本端收口」的行。
        let conn = fresh_db();
        ins_msg(&conn, "m-1", "p1", "text", "回执", 1);
        force_status(&conn, "m-1", status);
        let advanced = super::mark_own_messages_read_upto(&conn, "p1", "me", 1000).unwrap();
        assert_eq!(
            advanced > 0,
            read_advances,
            "status={status}：已读回执的门变了"
        );
        assert_eq!(
            status_of(&conn, "m-1"),
            if read_advances { "read" } else { status },
            "status={status}"
        );

        // ④ 重发：只有本端判失败/被取消的行能整条重来。
        let conn = fresh_db();
        ins_msg(&conn, "m-1", "p1", "text", "重发", 1);
        force_status(&conn, "m-1", status);
        let requeued = super::requeue_message_for_resend(&conn, "m-1", "p1", "{}").unwrap();
        assert_eq!(requeued == 1, can_resend, "status={status}：重发的门变了");
        assert_eq!(
            status_of(&conn, "m-1"),
            if can_resend { "sending" } else { status },
            "status={status}"
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM outbox"),
            i64::from(can_resend),
            "status={status}：重发必须且只能在放行时留下队列行"
        );
    }
}

// ---------------- 批次 3A：四账只读投影 + 策略矩阵 ----------------
//
// 投影只做 SELECT；写数据是测试准备。它要证明的是「四张账的终态/复活/墓碑语义
// 本来就不同，门面只能保留 kind 标签，不能统一成一个 cancelled/failed」。

#[derive(Debug, Clone, PartialEq, Eq)]
struct LedgerProjection {
    kind: &'static str,
    id: String,
    status: String,
    hard_terminal: bool,
    reactivatable: bool,
}

fn ledger_policy(kind: &str, status: &str, tombstone: bool) -> (bool, bool) {
    match (kind, status) {
        // 群 outbox：delivered/failed 是证据或已放弃；cancelled 是唯一可显式补发的行。
        ("group_outbox", "delivered") => (true, false),
        ("group_outbox", "failed") => (true, false),
        ("group_outbox", "cancelled") => (false, true),
        // 群文件成员行：cancelled 是硬终态；failed 可被下一轮接收重置为 sending。
        ("group_recipient", "cancelled") => (true, false),
        ("group_recipient", "completed") => (true, false),
        ("group_recipient", "failed") => (false, true),
        // 文件传输：done 是唯一硬终态；failed 可续传；cancel_terminal 才是用户墓碑。
        ("file_transfer", "done") => (true, false),
        ("file_transfer", "failed") => (false, true),
        ("file_transfer", "cancelled") => (tombstone, !tombstone),
        // ACK 重放队列没有状态机：成功即删，失败重放。
        ("group_file_ack", "replay") => (false, true),
        _ => (false, false),
    }
}

fn project_ledgers(conn: &Connection) -> Vec<LedgerProjection> {
    let mut out = Vec::new();

    let mut stmt = conn
        .prepare("SELECT msg_id, peer_id, status FROM group_outbox")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap();
    for row in rows.flatten() {
        let (hard_terminal, reactivatable) = ledger_policy("group_outbox", &row.2, false);
        out.push(LedgerProjection {
            kind: "group_outbox",
            id: format!("{}:{}", row.0, row.1),
            status: row.2,
            hard_terminal,
            reactivatable,
        });
    }

    let mut stmt = conn
        .prepare("SELECT transfer_id, recipient_id, status FROM group_file_recipients")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap();
    for row in rows.flatten() {
        let (hard_terminal, reactivatable) = ledger_policy("group_recipient", &row.2, false);
        out.push(LedgerProjection {
            kind: "group_recipient",
            id: format!("{}:{}", row.0, row.1),
            status: row.2,
            hard_terminal,
            reactivatable,
        });
    }

    let mut stmt = conn
        .prepare("SELECT id, status, cancel_terminal FROM file_transfers")
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .unwrap();
    for row in rows.flatten() {
        let tombstone = row.2 != 0;
        let (hard_terminal, reactivatable) = ledger_policy("file_transfer", &row.1, tombstone);
        out.push(LedgerProjection {
            kind: "file_transfer",
            id: row.0,
            status: row.1,
            hard_terminal,
            reactivatable,
        });
    }

    let mut stmt = conn
        .prepare("SELECT transfer_id, recipient_id FROM group_file_acks")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap();
    for row in rows.flatten() {
        let (hard_terminal, reactivatable) = ledger_policy("group_file_ack", "replay", false);
        out.push(LedgerProjection {
            kind: "group_file_ack",
            id: format!("{}:{}", row.0, row.1),
            status: "replay".to_string(),
            hard_terminal,
            reactivatable,
        });
    }

    out
}

#[test]
fn read_only_ledger_projection_keeps_each_ledgers_terminal_policy() {
    let conn = fresh_db();

    for (msg, peer, status) in [
        ("m-o1", "a", "pending"),
        ("m-o2", "a", "delivered"),
        ("m-o3", "a", "cancelled"),
        ("m-o4", "a", "failed"),
    ] {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at, status)
             VALUES (?1, 'g1', ?2, '{}', 1, ?3)",
            params![msg, peer, status],
        )
        .unwrap();
    }

    conn.execute(
        "INSERT INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at)
         VALUES ('gf1','g1','me','a.bin',1,'sha','cancelled',1)",
        [],
    )
    .unwrap();
    for (recipient, status) in [
        ("a", "pending"),
        ("b", "sending"),
        ("c", "completed"),
        ("d", "failed"),
        ("e", "cancelled"),
    ] {
        conn.execute(
            "INSERT INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
             VALUES ('gf1', ?1, ?2, 0, 1)",
            params![recipient, status],
        )
        .unwrap();
    }

    for (id, status, tombstone) in [
        ("ft1", "active", 0),
        ("ft2", "done", 0),
        ("ft3", "failed", 0),
        ("ft4", "cancelled", 1),
    ] {
        conn.execute(
            "INSERT INTO file_transfers(id, peer_id, name, size, direction, status, path, progress, cancel_terminal, created_at)
             VALUES (?1,'p1','a.bin',1,'send',?2,NULL,0,?3,1)",
            params![id, status, tombstone],
        )
        .unwrap();
    }

    conn.execute(
        "INSERT INTO group_file_acks(transfer_id, recipient_id, group_id, success, received_at, attempts, last_error)
         VALUES ('gf1','a','g1',1,1,0,'')",
        [],
    )
    .unwrap();

    let first = project_ledgers(&conn);
    assert_eq!(first, project_ledgers(&conn), "投影必须可重入且纯读");

    let find = |kind: &str, status: &str| {
        first
            .iter()
            .find(|r| r.kind == kind && r.status == status)
            .unwrap_or_else(|| panic!("缺 {kind}/{status} 投影"))
    };

    assert_eq!(
        (
            find("group_outbox", "cancelled").hard_terminal,
            find("group_outbox", "cancelled").reactivatable
        ),
        (false, true),
        "群 outbox 的 cancelled 可显式补发"
    );
    assert_eq!(
        (
            find("group_outbox", "failed").hard_terminal,
            find("group_outbox", "failed").reactivatable
        ),
        (true, false),
        "群 outbox 的 failed 永不复活"
    );
    assert_eq!(
        (
            find("group_recipient", "cancelled").hard_terminal,
            find("group_recipient", "cancelled").reactivatable
        ),
        (true, false),
        "群文件成员 cancelled 是硬终态"
    );
    assert_eq!(
        (
            find("group_recipient", "failed").hard_terminal,
            find("group_recipient", "failed").reactivatable
        ),
        (false, true),
        "群文件成员 failed 可被下一轮接收重置"
    );
    assert_eq!(
        (
            find("file_transfer", "done").hard_terminal,
            find("file_transfer", "done").reactivatable
        ),
        (true, false),
        "file_transfers 的 done 是唯一硬终态"
    );
    assert_eq!(
        (
            find("file_transfer", "failed").hard_terminal,
            find("file_transfer", "failed").reactivatable
        ),
        (false, true),
        "file_transfers 的 failed 可续传"
    );
    assert_eq!(
        (
            find("file_transfer", "cancelled").hard_terminal,
            find("file_transfer", "cancelled").reactivatable
        ),
        (true, false),
        "file_transfers 的取消墓碑挡住晚到 attempt"
    );
    assert_eq!(
        (
            find("group_file_ack", "replay").hard_terminal,
            find("group_file_ack", "replay").reactivatable
        ),
        (false, true),
        "ACK 账是重放队列，不是成员状态机"
    );
}
