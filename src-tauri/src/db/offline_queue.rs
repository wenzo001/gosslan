// 职责边界：
// - 单聊离线补发队列（flush_pending_friend_request 等）
// - **超时自动失败**：outbox 里 created_at + OUTBOX_FAIL_DEADLINE < now 的条目
//   表示这条消息等了足够久还没 Ack（要么发不出去、要么发出去了但对端没回应），
//   清扫时删除 outbox 行 + 把 messages.status 置 "failed"。
// ---------------- 离线补发队列 ----------------
// 注意：本文件通过 include_str! 展开到 db.rs 模块内，
// 所以 crate::db 内的函数（如 now_ms）可以直接调用，不需要额外 use。

/// 单聊 outbox 超时阈值（毫秒）。
/// 120s 是"弱连接但仍应能发到对端"与"真的发不出去该放弃了"之间的合理分界：
/// 心跳 5s 一次，120s 内至少有 24 次 flush_outbox 机会。
/// ⚠️ 只对**可达对端**生效 —— 对端离线时按 `OUTBOX_OFFLINE_HOLD_MS` 保留。
pub const OUTBOX_FAIL_DEADLINE_MS: i64 = 120_000;

/// 离线对端的 outbox 保留窗口（毫秒）。
///
/// 产品承诺「对方离线时消息自动暂存，上线建链后自动补发」（README / INV-P04）：
/// 好友关机两分钟就把行删掉、置 failed，等于用 sweeper 击穿这条承诺
///（2026-09-19 审计 P0：sweeper 不区分「发出去没 Ack」和「对端根本不在网上」）。
/// 离线行保留 7 天后才当僵尸清理 —— 这是防止永久离场节点让队列无限增长的兜底，
/// 不是补发期限。
pub const OUTBOX_OFFLINE_HOLD_MS: i64 = 7 * 24 * 3600 * 1000;

/// 群 outbox 行的判死窗口：**30 分钟**，不是单聊那 120 秒。
///
/// 为什么单聊可以 120s 而群不行（2026-09-24 真机：大文件失败之后群聊一直不同步）：
/// 群消息是"每个成员一行、按成员各自判可达"，一条行只有在**所有成员都该放弃**时整条消息才 failed；
/// 而 120s 这个窗口比"链路抖动 + 群密钥重发"的收敛时间还短 —— 表现是行被删、消息置 failed，
/// 此后无论密钥什么时候补到，那条内容都不会再同步给任何人（**单聊**有直发 outbox 与内容拉取
/// 两条路，群只有这一行）。30min 与文件 outbox 同量级：够链路抖完，也不会把僵尸行留到看不见的地方。
pub const GROUP_OUTBOX_FAIL_DEADLINE_MS: i64 = 30 * 60 * 1000;

/// sweeper 判定：一条已过 `OUTBOX_FAIL_DEADLINE_MS` 的候选行现在该不该判 failed。
///
/// 可达（当前有 TCP 链路）⇒ 等了至少 120s 仍无 Ack，再等也没有意义 → 放弃；
/// 不可达（对端离线）⇒ 保留，直到超出 `OUTBOX_OFFLINE_HOLD_MS`。
pub fn should_fail_expired_outbox(peer_reachable: bool, age_ms: i64) -> bool {
    should_fail_expired(peer_reachable, age_ms, OUTBOX_FAIL_DEADLINE_MS, OUTBOX_OFFLINE_HOLD_MS)
}

/// 通用版：不同队列的放弃窗口不同（单聊/群 120s，文件 30min），离线保留窗口统一。
/// sweeper 的三条队列都从这一个判据出（2026-09-19 自审建议#5：
/// 文件 outbox 曾维持 30min 无条件 failed，离线对端的文件补发被同样击穿）。
pub fn should_fail_expired(
    peer_reachable: bool,
    age_ms: i64,
    deadline_ms: i64,
    hold_ms: i64,
) -> bool {
    if peer_reachable {
        age_ms >= deadline_ms
    } else {
        age_ms >= hold_ms
    }
}

#[allow(dead_code)]
pub fn insert_outbox(conn: &Connection, msg_id: &str, peer_id: &str, payload: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![msg_id, peer_id, payload, now_ms()],
    )?;
    Ok(())
}

pub fn list_outbox(conn: &Connection, peer_id: &str) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, payload FROM outbox WHERE peer_id = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![peer_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[allow(dead_code)]
pub fn delete_outbox(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM outbox WHERE id = ?1", params![id])?;
    Ok(())
}

/// 列出**超时未 Ack**的单聊 outbox 候选条目（created_at 早于 deadline 的行）。
/// 返回 (outbox_id, msg_id, peer_id, created_at)——peer_id 与 created_at 供
/// 调用方用 `should_fail_expired_outbox` 区分「对端离线（保留）」与「可达无 Ack（放弃）」。
///
/// Ack 到达时 outbox 行已被删除，所以残留的必然是"发不出去"或"发出去但对端没回应"的条目。
/// 一次清扫最多读多少条过期行（10-23 审计 P3-D）。
///
/// 为什么要有上界：这条查询在**唯一那把 DB 锁**里跑，而它的候选集是"所有过期且没 Ack 的行"——
/// 离线一周之后那可能是几千条。清扫器每个 tick 都会再来一次，所以本轮只处理前 N 条完全够；
/// 没有上界时这一读会把整条消息落库链路（以及所有在等这把锁的传输）一起按下屏息。
/// 与 `list_outbox` 那种"一个对端的全部待发"不同：那条的规模由单个会话的消息量决定，
/// 这条是**全库**。
pub const OUTBOX_SWEEP_BATCH: i64 = 500;

pub fn list_expired_outbox(
    conn: &Connection,
    deadline_ms: i64,
) -> Result<Vec<(i64, String, String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, peer_id, created_at FROM outbox WHERE created_at < ?1 ORDER BY id LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![deadline_ms, OUTBOX_SWEEP_BATCH], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 按 msg_id 删除单聊 outbox（Ack 到达时按 outbox 行 id 删，
/// 超时清扫时按 msg_id 删更方便，因为同一条 msg_id 可能有多行重试）。
pub fn delete_outbox_by_msg_id(conn: &Connection, msg_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM outbox WHERE msg_id = ?1",
        params![msg_id],
    )?;
    Ok(())
}

/// 删除好友时**自动取消**发给这个人的待发消息（计划 D5-A）。
///
/// 判据是 outbox 行而不是 `messages.status`：真正"还会被发出去"的只有队列里有行的那几条。
/// 一条消息若已被 Ack 推进（delivered/read）、已取消或已判失败，这里只清队列行、不动状态。
///
/// 状态落 `failed` 而不是 `cancelled`：这不是用户对某条消息按了取消，而是关系被删除导致的
/// 投递失败 —— 界面因此显示失败角标（可重发），语义与"我主动不发了"不同（INV-P26）。
///
/// 返回真正被改成 `failed` 的 msg_id（调用方据此 emit `message-status-changed`）。
/// 整段一个事务：删行与置状态必须同时成立，否则会留下"队列空、状态仍 sending"的孤儿。
pub fn fail_pending_messages_for_peer(conn: &Connection, peer_id: &str) -> Result<Vec<String>> {
    let tx = conn.unchecked_transaction()?;
    let msg_ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT msg_id FROM outbox WHERE peer_id = ?1 ORDER BY id")?;
        let rows = stmt.query_map(params![peer_id], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    tx.execute("DELETE FROM outbox WHERE peer_id = ?1", params![peer_id])?;
    let mut changed = Vec::new();
    for msg_id in msg_ids {
        let n = tx.execute(
            "UPDATE messages SET status = 'failed'
              WHERE msg_id = ?1
                AND status NOT IN ('delivered', 'read', 'recalled', 'cancelled', 'partial_cancelled', 'failed')",
            params![msg_id],
        )?;
        if n > 0 {
            changed.push(msg_id);
        }
    }
    tx.commit()?;
    Ok(changed)
}

#[cfg(test)]
mod offline_queue_tests {
    // 注意：本文件经 include! 拼进 db 模块，模块名在 db 作用域里必须全局唯一
    // （favorites_tests.rs 已经占了 `tests`）。
    use super::*;

    /// 群 outbox 的判死窗口必须比单聊长（2026-09-24 真机：大文件失败之后群聊一直不同步）。
    ///
    /// 钉的是"120 秒这一档**不再适用于群**"：群 outbox 行是群消息唯一的补发载体，
    /// 删早了以后就算群密钥补到了也没人再消费那条内容（单聊还有直发 outbox 与内容拉取两条路）。
    #[test]
    #[allow(clippy::assertions_on_constants)] // 钉的是两个常量窗口的相对关系
    fn group_rows_survive_the_link_flap_window_that_kills_single_chats() {
        use std::time::Duration;
        assert!(
            GROUP_OUTBOX_FAIL_DEADLINE_MS > OUTBOX_FAIL_DEADLINE_MS,
            "群窗口必须严格长于单聊窗口，否则这条改动等于没做"
        );
        let flap = OUTBOX_FAIL_DEADLINE_MS + 1; // 刚过单聊窗口：单聊该放弃，群不该
        assert!(should_fail_expired(true, flap, OUTBOX_FAIL_DEADLINE_MS, OUTBOX_OFFLINE_HOLD_MS));
        assert!(
            !should_fail_expired(
                true,
                flap,
                GROUP_OUTBOX_FAIL_DEADLINE_MS,
                OUTBOX_OFFLINE_HOLD_MS
            ),
            "链路抖动 3 分钟内就删群行 ⇒ 那条群消息永久无人补发"
        );
        // 到点仍然要放弃：不许把窗口改成"永不放弃"
        let past = GROUP_OUTBOX_FAIL_DEADLINE_MS + 1;
        assert!(should_fail_expired(
            true,
            past,
            GROUP_OUTBOX_FAIL_DEADLINE_MS,
            OUTBOX_OFFLINE_HOLD_MS
        ));
        // 离线对端仍按 7 天保留（这条改动不许顺手削弱离线补发）
        assert!(!should_fail_expired(
            false,
            Duration::from_secs(86_400).as_millis() as i64,
            GROUP_OUTBOX_FAIL_DEADLINE_MS,
            OUTBOX_OFFLINE_HOLD_MS
        ));
    }

    #[test]
    fn offline_peer_is_held_while_reachable_peer_fails_at_deadline() {
        // 可达：过 120s 即放弃；未过 120s 不放弃
        assert!(should_fail_expired_outbox(true, OUTBOX_FAIL_DEADLINE_MS));
        assert!(!should_fail_expired_outbox(true, OUTBOX_FAIL_DEADLINE_MS - 1));
        // 离线：120s / 1 小时都不构成失败理由（承诺是上线后补发）
        assert!(!should_fail_expired_outbox(false, OUTBOX_FAIL_DEADLINE_MS));
        assert!(!should_fail_expired_outbox(false, 3_600_000));
        // 离线保留窗口的意义是防僵尸行：到点才清
        assert!(!should_fail_expired_outbox(false, OUTBOX_OFFLINE_HOLD_MS - 1));
        assert!(should_fail_expired_outbox(false, OUTBOX_OFFLINE_HOLD_MS));
    }

    #[test]
    fn list_expired_outbox_returns_peer_and_age_for_classification() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL UNIQUE,
                peer_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        // 一条过期（created_at=0）、一条新鲜
        insert_outbox(&conn, "m-old", "peer-a", "{}").unwrap();
        conn.execute(
            "UPDATE outbox SET created_at = 0 WHERE msg_id = 'm-old'",
            [],
        )
        .unwrap();
        insert_outbox(&conn, "m-fresh", "peer-b", "{}").unwrap();

        let expired = list_expired_outbox(&conn, now_ms() - OUTBOX_FAIL_DEADLINE_MS).unwrap();
        assert_eq!(expired.len(), 1);
        let (_, msg_id, peer_id, created_at) = &expired[0];
        assert_eq!(msg_id, "m-old");
        // peer_id 与 created_at 必须随行为一起返回：没有它们 sweeper 就无法区分
        // 「对端离线（保留）」与「可达无 Ack（放弃）」——回归 2026-09-19 P0。
        assert_eq!(peer_id, "peer-a");
        assert_eq!(*created_at, 0);
    }

    /// **读数型判据**（10-23 审计 A3 要的那一份）：队列 N 行时，一轮到期扫描读多久。
    ///
    /// 刻意**不断言**时间阈值（CI 机器负载会把一个猜的数变成掷硬币），只打印机器值 ——
    /// 用法是"想判断这条查询有没有变慢时，复跑它并对比同一个数量级"。
    /// 唯一断言的是一致性：有界那 500 条确实拿到了（没有 LIMIT 时这里会是 N）。
    #[test]
    fn expired_sweep_read_cost_reading() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL UNIQUE,
                peer_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX idx_outbox_created ON outbox(created_at);",
        )
        .unwrap();
        const N: i64 = 20_000;
        {
            let tx = conn.unchecked_transaction().unwrap();
            for i in 0..N {
                tx.execute(
                    "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES (?1, 'p', '{}', ?2)",
                    params![format!("m-{i}"), i],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        let started = std::time::Instant::now();
        let got = list_expired_outbox(&conn, N + 1).unwrap();
        let elapsed = started.elapsed();
        println!(
            "· 到期扫描读数：队列 {N} 行 / 一轮读 {} 行 / 耗时 {:.3} ms（上界 {}）",
            got.len(),
            elapsed.as_secs_f64() * 1000.0,
            OUTBOX_SWEEP_BATCH
        );
        assert_eq!(got.len() as i64, OUTBOX_SWEEP_BATCH);
    }

    /// 过期清扫的读是**有界**的（10-23 审计 P3-D）：全库候选集离线一周能到几千条，
    /// 而它跑在唯一那把 DB 锁里。上界之外的行留给下一个 tick —— 不许"一次全捞"。
    #[test]
    fn expired_sweep_read_is_bounded() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL UNIQUE,
                peer_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        for i in 0..(OUTBOX_SWEEP_BATCH + 7) {
            conn.execute(
                "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES (?1, 'p', '{}', ?2)",
                params![format!("m-{i}"), i],
            )
            .unwrap();
        }
        let got = list_expired_outbox(&conn, 10_000).unwrap();
        assert_eq!(
            got.len() as i64,
            OUTBOX_SWEEP_BATCH,
            "一次清扫最多读 {OUTBOX_SWEEP_BATCH} 条：多出来的留给下一个 tick"
        );
        // 而且取的是**最早的**那一批（ORDER BY id），否则尾部永远轮不到
        assert_eq!(got.first().map(|r| r.1.as_str()), Some("m-0"));
    }

    /// D5-A：删好友时清掉这个人的补发队列，并把**仍在路上**的消息落 failed。
    ///
    /// 三条都要判，缺一条就会留下另一个现场：
    /// ① 队列行清空（否则下一次 flush 还会往一个已不是好友的人发）；
    /// ② 状态从 sent/sending 落 failed（否则气泡永远停在"发送中"）；
    /// ③ 已 delivered/read、以及根本没有队列行的消息**不许被改写**（那是既成事实）。
    #[test]
    fn removing_a_friend_fails_only_the_messages_still_in_the_outbox() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
                msg_id TEXT UNIQUE NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL UNIQUE,
                peer_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            INSERT INTO messages(msg_id, status) VALUES
                ('m-pending','sent'),
                ('m-delivered','delivered'),
                ('m-no-row','sending'),
                ('m-other','sent');",
        )
        .unwrap();
        for (msg, peer) in [
            ("m-pending", "alice"),
            ("m-delivered", "alice"),
            ("m-other", "bob"),
        ] {
            conn.execute(
                "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES (?1, ?2, '{}', 1)",
                params![msg, peer],
            )
            .unwrap();
        }

        let changed = fail_pending_messages_for_peer(&conn, "alice").unwrap();
        assert_eq!(changed, vec!["m-pending".to_string()], "只有还在队列里的那条落 failed");
        assert!(list_outbox(&conn, "alice").unwrap().is_empty(), "关系没了就不该再给他的队列补发");
        assert_eq!(list_outbox(&conn, "bob").unwrap().len(), 1, "别人的队列不许被顺手清掉");

        let status = |msg: &str| -> String {
            conn.query_row(
                "SELECT status FROM messages WHERE msg_id = ?1",
                params![msg],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(status("m-pending"), "failed");
        assert_eq!(status("m-delivered"), "delivered", "已送达是既成事实，不许改写");
        assert_eq!(status("m-no-row"), "sending", "没有队列行的消息不归这次清理管");
        assert_eq!(status("m-other"), "sent");
    }
}
