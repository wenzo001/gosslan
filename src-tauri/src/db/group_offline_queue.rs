// 职责边界：
// - 群消息离线补发队列（flush_group_outbox）
// ---------------- 群消息离线补发队列 ----------------

/// 幂等写入一条群消息离线投递记录。`(msg_id, peer_id)` 唯一，
/// 重复写入不会产生第二行。
pub fn insert_group_outbox(
    conn: &Connection,
    msg_id: &str,
    group_id: &str,
    peer_id: &str,
    payload: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![msg_id, group_id, peer_id, payload, now_ms()],
    )?;
    Ok(())
}

/// 取某成员的全部待补发群消息（按插入顺序）。
pub fn list_group_outbox(conn: &Connection, peer_id: &str) -> Result<Vec<(i64, String)>> {
    let mut stmt =
        conn.prepare("SELECT id, payload FROM group_outbox WHERE peer_id = ?1 ORDER BY id")?;
    let rows = stmt.query_map(params![peer_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// GroupAck 的**原子收尾**：验证该成员确实还有待发记录 → 置 delivered → 删这一行。
///
/// 与 1:1 的 [`ack_delivered`] 同一条纪律（2026-10-20 永久发送中 P0）：
/// 旧写法先 `delete_group_outbox`、再 `set_message_status(...).ok()`，删行成功而
/// 状态写失败时留下「队列行没了、消息还是 sending/sent」的孤儿 —— 清扫器只扫
/// group_outbox，补发也没有行可发，界面永久发送中。事务保证要么两者都成，要么都不动。
///
/// 群语义与 1:1 一致：**任一成员的第一个 Ack 就推进 delivered**（后续成员 Ack 幂等，
/// `set_message_status` 的 WHERE 保证不把 read 退回 delivered）。
///
/// 返回 `Ok(false)` = 没有命中该成员的待发行（伪造/重复 Ack），调用方不得 emit。
pub fn ack_group_delivered(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let expected = tx
        .query_row(
            "SELECT 1 FROM group_outbox WHERE msg_id = ?1 AND peer_id = ?2",
            params![msg_id, peer_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !expected {
        return Ok(false);
    }
    tx.execute(
        "UPDATE messages SET status = 'delivered'
          WHERE msg_id = ?1
            AND status NOT IN ('read', 'delivered', 'recalled')",
        params![msg_id],
    )?;
    tx.execute(
        "DELETE FROM group_outbox WHERE msg_id = ?1 AND peer_id = ?2",
        params![msg_id, peer_id],
    )?;
    tx.commit()?;
    Ok(true)
}

/// 收到 GroupAck 后删除指定成员、指定消息的待发记录。
///
/// 生产收尾已改用 [`ack_group_delivered`]（状态 + 删行同事务）；这个低层原语只剩
/// 测试与将来的维护路径在用，保留它是为了不在测试里复制一份 DELETE。
#[allow(dead_code)]
pub fn delete_group_outbox(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM group_outbox WHERE msg_id = ?1 AND peer_id = ?2",
        params![msg_id, peer_id],
    )?;
    Ok(())
}

/// 删除指定群的全部待发记录（删除群 / 清空数据时使用）。
pub fn delete_group_outbox_for_group(conn: &Connection, group_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM group_outbox WHERE group_id = ?1",
        params![group_id],
    )?;
    Ok(())
}

/// 删除指定成员在指定群中的待发记录，并把**因此失去最后一条队列行**的消息落终态。
///
/// 为什么删行本身不够（2026-10-20 永久发送中 P0 的第三个入口，与 Ack 那条同型）：
/// 移人出群 / 主动退群会删掉指向他的 `group_outbox` 行，但消息自己还是 `sending`。
/// 若那条消息只剩这一行（两人群，或其余成员都已经收尾），删完就变成
/// 「队列行 0 行、状态 sending」—— 清扫器只扫 `group_outbox`、补发也没有行可发，
/// 界面永久"发送中"，直到下一次启动才被 `db::recover_orphan_sending_messages` 收掉。
///
/// 这里在**同一个事务**里做两件事：删掉该成员的行，然后把「没有任何剩余行、且仍是
/// `sending`」的消息落 `failed`。置 failed 而不是 sent：没有 Ack 就没有送达证据；
/// 已经 `delivered`/`read` 的行一个都不碰（`WHERE status = 'sending'`），所以
/// **任一成员 Ack 过**的消息不会被这里改写。接收端按 msg_id 幂等，重发安全。
///
/// 返回被落终态的消息条数（0 = 这条消息还有别的成员的行，仍可补发）。
pub fn delete_group_outbox_for_peer_in_group(
    conn: &Connection,
    group_id: &str,
    peer_id: &str,
) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    // 先记下会被这次删除影响到的 msg_id，删完再按它们判"是否还有剩余行"。
    // 反过来做（先删再按 msg_id 反查）就拿不到被影响集合了。
    let ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT msg_id FROM group_outbox WHERE group_id = ?1 AND peer_id = ?2",
        )?;
        let rows = stmt.query_map(params![group_id, peer_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>>>()?
    };
    tx.execute(
        "DELETE FROM group_outbox WHERE group_id = ?1 AND peer_id = ?2",
        params![group_id, peer_id],
    )?;
    let mut settled = 0usize;
    for msg_id in ids {
        settled += tx.execute(
            "UPDATE messages SET status = 'failed'
              WHERE msg_id = ?1
                AND status = 'sending'
                AND NOT EXISTS (SELECT 1 FROM group_outbox g WHERE g.msg_id = messages.msg_id)",
            params![msg_id],
        )?;
    }
    tx.commit()?;
    Ok(settled)
}

/// 列出**超时未 GroupAck**的群 outbox 候选行。
/// 返回 Vec<(msg_id, group_id, peer_id, created_at)>，供清扫任务按成员分类。
///
/// 群 outbox 一条 msg_id 对应 N 个 peer_id 行，超时判定按 msg_id 粒度
/// （同一条群消息对所有接收方要么一起成功、要么一起放弃）。
pub fn list_expired_group_outbox(
    conn: &Connection,
    deadline_ms: i64,
) -> Result<Vec<(String, String, String, i64)>> {
    // 行级返回（msg_id, group_id, peer_id, created_at）： sweeper 要按**每个成员**的
    // 可达性分类（2026-09-19 自审建议#5）——某成员离线时他的行必须保留，
    // 只有整条消息的**所有行**都该放弃时，msg 粒度才置 failed。
    let mut stmt = conn.prepare(
        "SELECT msg_id, group_id, peer_id, created_at FROM group_outbox WHERE created_at < ?1",
    )?;
    let rows = stmt.query_map(params![deadline_ms], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 群 outbox 的**逐行**放弃判定：只按该成员自己的可达性算。
///
/// 不能把一条消息的所有行 `all()` 成一个结论（P1-04）：群里只要有一个成员长期离线，
/// 在线成员的行也会被一起保留 ⇒ 每 5s 重发一次、最长 7 天。逐行判定后，在线成员
/// 30 分钟就独立放弃，离线成员仍按 7 天保留（INV-P04 不受影响）。
pub fn group_outbox_row_expired(peer_reachable: bool, age_ms: i64) -> bool {
    should_fail_expired(
        peer_reachable,
        age_ms,
        GROUP_OUTBOX_FAIL_DEADLINE_MS,
        OUTBOX_OFFLINE_HOLD_MS,
    )
}

/// 删掉一条消息里**指定成员**的待发行（逐行放弃时用；不影响其它成员的行）。
pub fn delete_group_outbox_row(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM group_outbox WHERE msg_id = ?1 AND peer_id = ?2",
        params![msg_id, peer_id],
    )?;
    Ok(())
}

/// 按 msg_id 删除**所有** peer 的 group_outbox 行。
pub fn delete_group_outbox_by_msg_id(conn: &Connection, msg_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM group_outbox WHERE msg_id = ?1",
        params![msg_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod group_outbox_removal_tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn seed_msg(conn: &Connection, msg_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'group:g', 'me', 'g', 'text', 'x', 1, 1, ?2)",
            params![msg_id, status],
        )
        .unwrap();
    }

    fn seed_row(conn: &Connection, msg_id: &str, peer: &str) {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES(?1, 'g', ?2, '{}', 1)",
            params![msg_id, peer],
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

    fn rows_of(conn: &Connection, msg_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM group_outbox WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// 移人出群删掉的是**队列行**，不是"这条消息的终态"。
    ///
    /// 旧实现只删行：当那条消息只剩这一行时，删完就变成「0 行 + sending」—— 清扫器
    /// 只扫 group_outbox、补发也没有行可发 ⇒ 界面永久"发送中"（直到下次启动被孤儿恢复
    /// 收掉）。这条用例把三个方向分开钉：
    ///   ① 还有别的成员在队列里 ⇒ 消息不许被判死（否则会误伤"等别人上线补发"）；
    ///   ② 删掉最后一行 ⇒ 必须落 failed（诚实终态，不是继续挂 sending）；
    ///   ③ 已经 delivered 的行 ⇒ 一个都不许被改写。
    #[test]
    fn removing_a_member_settles_only_messages_that_lose_their_last_row() {
        let conn = db();
        // m1 两个收件人；m2 只有 peer-a；m3 只有 peer-a 但已经 delivered。
        seed_msg(&conn, "m1", "sending");
        seed_row(&conn, "m1", "peer-a");
        seed_row(&conn, "m1", "peer-b");
        seed_msg(&conn, "m2", "sending");
        seed_row(&conn, "m2", "peer-a");
        seed_msg(&conn, "m3", "delivered");
        seed_row(&conn, "m3", "peer-a");

        // ① + ③：删 peer-a 的行 —— m1 还有 peer-b 的行，m3 已经不是 sending。
        assert_eq!(
            delete_group_outbox_for_peer_in_group(&conn, "g", "peer-a").unwrap(),
            1,
            "只有 m2 失去最后一行，才该被判终态"
        );
        assert_eq!(status(&conn, "m1"), "sending", "还有别的成员的行 ⇒ 不许判死");
        assert_eq!(rows_of(&conn, "m1"), 1, "peer-b 的行必须留着补发");
        assert_eq!(status(&conn, "m2"), "failed", "失去最后一行 ⇒ 落终态");
        assert_eq!(rows_of(&conn, "m2"), 0);
        assert_eq!(status(&conn, "m3"), "delivered", "已送达不许被删行改回失败");
        assert_eq!(rows_of(&conn, "m3"), 0);

        // ②：再删 peer-b 的行 ⇒ m1 失去最后一行，必须落终态。
        assert_eq!(
            delete_group_outbox_for_peer_in_group(&conn, "g", "peer-b").unwrap(),
            1
        );
        assert_eq!(
            status(&conn, "m1"),
            "failed",
            "最后一个收件人被移出 ⇒ 队列行 0 行，继续 sending 就是永久发送中"
        );
        assert_eq!(rows_of(&conn, "m1"), 0);

        // 幂等：没有行可删、没有消息可判 ⇒ 0，且不报错。
        assert_eq!(
            delete_group_outbox_for_peer_in_group(&conn, "g", "peer-b").unwrap(),
            0
        );
    }

    /// P1-04 回归：群 outbox 必须**逐行**判死。
    ///
    /// 旧实现 `rows.iter().all(...)` 把结论聚合到消息级：一条消息里只要有一个成员离线，
    /// 在线成员的行也被保留 ⇒ 每 5s 重发一次、最长 7 天。
    #[test]
    fn group_outbox_expiry_is_per_row_not_per_message() {
        let min = 60_000i64;
        assert!(
            group_outbox_row_expired(true, 40 * min),
            "在线成员 40min 必须独立放弃"
        );
        assert!(
            !group_outbox_row_expired(false, 40 * min),
            "离线成员 40min 必须保留（INV-P04）"
        );
        assert!(
            !group_outbox_row_expired(true, 10 * min),
            "在线成员未到 30min 不放弃"
        );
        assert!(
            group_outbox_row_expired(false, OUTBOX_OFFLINE_HOLD_MS + 1),
            "离线成员超过 7 天才是僵尸行"
        );
    }

    /// 逐行放弃只删指定成员那一行，不碰同消息的其它成员。
    #[test]
    fn deleting_one_expired_row_keeps_the_other_members() {
        let conn = db();
        seed_msg(&conn, "m1", "sending");
        seed_row(&conn, "m1", "online");
        seed_row(&conn, "m1", "offline");
        delete_group_outbox_row(&conn, "m1", "online").unwrap();
        assert_eq!(rows_of(&conn, "m1"), 1);
        assert_eq!(
            status(&conn, "m1"),
            "sending",
            "还有离线成员没收到 ⇒ 消息不许被判死"
        );
    }
}
