pub const PENDING_RECALL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const PENDING_RECALL_GLOBAL_CAP: usize = 256;
pub const PENDING_RECALL_GROUP_CAP: usize = 64;
pub const PENDING_RECALL_SENDER_CAP: usize = 32;
pub const PENDING_RECALL_ENVELOPE_MAX_BYTES: usize = 256 * 1024;
pub const PENDING_RECALL_REPLAY_BACKOFF_MAX_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct PendingGroupRecall {
    pub conv_id: String,
    pub target_msg_id: String,
    pub recaller_id: String,
    pub seq: i64,
    pub attempts: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingRecallEnqueue {
    Stored,
    Duplicate,
    TooLarge,
}

fn evict_oldest(conn: &Connection, where_sql: &str, arg: &str) -> Result<()> {
    conn.execute(
        &format!(
            "DELETE FROM pending_group_recalls WHERE rowid IN (
               SELECT rowid FROM pending_group_recalls WHERE {where_sql}
               ORDER BY received_at, rowid LIMIT 1
             )"
        ),
        params![arg],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn enqueue_pending_group_recall(
    conn: &Connection,
    conv_id: &str,
    target_msg_id: &str,
    recaller_id: &str,
    event_id: &str,
    seq: i64,
    envelope_json: &str,
    now: i64,
) -> Result<PendingRecallEnqueue> {
    if envelope_json.len() > PENDING_RECALL_ENVELOPE_MAX_BYTES {
        return Ok(PendingRecallEnqueue::TooLarge);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM pending_group_recalls WHERE expires_at <= ?1", params![now])?;
    let exists: bool = tx
        .query_row(
            "SELECT 1 FROM pending_group_recalls
             WHERE conv_id=?1 AND target_msg_id=?2 AND recaller_id=?3",
            params![conv_id, target_msg_id, recaller_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        tx.commit()?;
        return Ok(PendingRecallEnqueue::Duplicate);
    }
    let sender_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pending_group_recalls WHERE recaller_id=?1",
        params![recaller_id],
        |r| r.get(0),
    )?;
    if sender_count as usize >= PENDING_RECALL_SENDER_CAP {
        evict_oldest(&tx, "recaller_id=?1", recaller_id)?;
    }
    let group_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pending_group_recalls WHERE conv_id=?1",
        params![conv_id],
        |r| r.get(0),
    )?;
    if group_count as usize >= PENDING_RECALL_GROUP_CAP {
        evict_oldest(&tx, "conv_id=?1", conv_id)?;
    }
    let total: i64 = tx.query_row("SELECT COUNT(*) FROM pending_group_recalls", [], |r| r.get(0))?;
    if total as usize >= PENDING_RECALL_GLOBAL_CAP {
        tx.execute(
            "DELETE FROM pending_group_recalls WHERE rowid IN (
               SELECT rowid FROM pending_group_recalls ORDER BY received_at, rowid LIMIT 1
             )",
            [],
        )?;
    }
    tx.execute(
        "INSERT INTO pending_group_recalls(
            conv_id,target_msg_id,recaller_id,event_id,seq,envelope_json,
            received_at,expires_at,attempts,next_attempt_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?7)",
        params![
            conv_id,
            target_msg_id,
            recaller_id,
            event_id,
            seq,
            envelope_json,
            now,
            now.saturating_add(PENDING_RECALL_TTL_MS)
        ],
    )?;
    tx.commit()?;
    Ok(PendingRecallEnqueue::Stored)
}

pub fn sweep_pending_group_recalls(conn: &Connection, now: i64) -> Result<usize> {
    conn.execute(
        "DELETE FROM pending_group_recalls WHERE expires_at <= ?1",
        params![now],
    )
}

pub fn list_pending_recall_groups(conn: &Connection, now: i64) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT conv_id FROM pending_group_recalls
         WHERE expires_at > ?1 ORDER BY conv_id",
    )?;
    let rows = stmt.query_map(params![now], |r| r.get(0))?;
    rows.collect::<Result<Vec<_>, _>>()
}

fn due_pending(conn: &Connection, conv_id: &str, now: i64, limit: i64) -> Result<Vec<PendingGroupRecall>> {
    let mut stmt = conn.prepare(
        "SELECT conv_id,target_msg_id,recaller_id,seq,attempts
         FROM pending_group_recalls
         WHERE conv_id=?1 AND expires_at>?2 AND next_attempt_at<=?2
         ORDER BY received_at, rowid LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![conv_id, now, limit], |r| {
        Ok(PendingGroupRecall {
            conv_id: r.get(0)?,
            target_msg_id: r.get(1)?,
            recaller_id: r.get(2)?,
            seq: r.get(3)?,
            attempts: r.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
}

fn defer_pending(conn: &Connection, pending: &PendingGroupRecall, now: i64) -> Result<()> {
    let attempts = pending.attempts.saturating_add(1);
    let shift = 1_i64.saturating_mul(2_i64.saturating_pow(attempts.min(16) as u32)).saturating_mul(1000);
    let delay = shift.min(PENDING_RECALL_REPLAY_BACKOFF_MAX_MS);
    conn.execute(
        "UPDATE pending_group_recalls
         SET attempts=?1,next_attempt_at=?2
         WHERE conv_id=?3 AND target_msg_id=?4 AND recaller_id=?5",
        params![attempts, now.saturating_add(delay), pending.conv_id, pending.target_msg_id, pending.recaller_id],
    )?;
    Ok(())
}

fn replay_one(conn: &Connection, pending: &PendingGroupRecall, now: i64) -> Result<Option<String>> {
    let group_id = pending.conv_id.strip_prefix("group:").unwrap_or_default();
    let group = get_group_checked(conn, group_id)?;
    let is_manager = group
        .as_ref()
        .is_some_and(|g| g.is_manager(&pending.recaller_id));
    let is_member = group
        .as_ref()
        .is_some_and(|g| g.members.contains(&pending.recaller_id));
    let target = get_message_record_checked(conn, &pending.target_msg_id)?;
    let allowed = crate::protocol::recall_receive_allowed(
        target.as_ref().map(|m| {
            (
                m.sender_id.as_str(),
                m.conv_id.as_str(),
                m.kind.as_str(),
            )
        }),
        &pending.recaller_id,
        &pending.conv_id,
        true,
        is_manager,
        is_member,
    );
    if !allowed {
        defer_pending(conn, pending, now)?;
        return Ok(None);
    }
    let applied = apply_recall(
        conn,
        &pending.conv_id,
        &pending.target_msg_id,
        &pending.recaller_id,
        pending.seq,
    )?;
    conn.execute(
        "DELETE FROM pending_group_recalls
         WHERE conv_id=?1 AND target_msg_id=?2 AND recaller_id=?3",
        params![pending.conv_id, pending.target_msg_id, pending.recaller_id],
    )?;
    Ok(applied.then(|| pending.target_msg_id.clone()))
}

pub fn replay_pending_group_recalls(conn: &Connection, conv_id: &str, now: i64) -> Result<Vec<String>> {
    sweep_pending_group_recalls(conn, now)?;
    let pending = due_pending(conn, conv_id, now, PENDING_RECALL_GROUP_CAP as i64)?;
    let mut applied = Vec::new();
    for item in pending {
        match replay_one(conn, &item, now) {
            Ok(Some(target)) => applied.push(target),
            Ok(None) => {}
            Err(_) => {
                defer_pending(conn, &item, now)?;
            }
        }
    }
    Ok(applied)
}

pub fn replay_pending_recall_for_message(
    conn: &Connection,
    conv_id: &str,
    target_msg_id: &str,
    now: i64,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT conv_id,target_msg_id,recaller_id,seq,attempts
         FROM pending_group_recalls
         WHERE conv_id=?1 AND target_msg_id=?2 AND expires_at>?3 AND next_attempt_at<=?3
         ORDER BY received_at LIMIT 1",
    )?;
    let pending = stmt
        .query_row(params![conv_id, target_msg_id, now], |r| {
            Ok(PendingGroupRecall {
                conv_id: r.get(0)?,
                target_msg_id: r.get(1)?,
                recaller_id: r.get(2)?,
                seq: r.get(3)?,
                attempts: r.get(4)?,
            })
        })
        .optional()?;
    match pending {
        Some(item) => replay_one(conn, &item, now),
        None => Ok(None),
    }
}

pub fn delete_pending_group_recalls(conn: &Connection, conv_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM pending_group_recalls WHERE conv_id=?1",
        params![conv_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod pending_recall_tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn message(msg_id: &str, conv_id: &str) -> crate::state::MessageRecord {
        crate::state::MessageRecord {
            fail_code: None,
            id: 0,
            msg_id: msg_id.into(),
            conv_id: conv_id.into(),
            sender_id: "owner".into(),
            receiver_id: "me".into(),
            kind: "text".into(),
            content: "hello".into(),
            ts: 1,
            seq: 1,
            status: "delivered".into(),
            mention_targets: None,
            local_id: None,
        }
    }

    #[test]
    fn pending_recall_replays_only_after_authority_catches_up() {
        let conn = db();
        create_group(&conn, "g1", "G", "owner", &["owner".into(), "next".into(), "me".into()]).unwrap();
        insert_message_if_new(&conn, &message("m1", "group:g1")).unwrap();
        assert_eq!(
            enqueue_pending_group_recall(&conn, "group:g1", "m1", "next", "e1", 2, "{}", 100).unwrap(),
            PendingRecallEnqueue::Stored
        );
        assert_eq!(
            enqueue_pending_group_recall(&conn, "group:g1", "m1", "next", "e1", 2, "{}", 100).unwrap(),
            PendingRecallEnqueue::Duplicate
        );
        assert!(replay_pending_group_recalls(&conn, "group:g1", 100).unwrap().is_empty());
        assert_eq!(get_message_record(&conn, "m1").unwrap().kind, "text");

        set_group_creator(&conn, "g1", "next").unwrap();
        assert_eq!(
            replay_pending_group_recalls(&conn, "group:g1", 5_000).unwrap(),
            vec!["m1".to_string()]
        );
        assert_eq!(get_message_record(&conn, "m1").unwrap().kind, "recalled");
        assert!(replay_pending_group_recalls(&conn, "group:g1", 6_000).unwrap().is_empty());
    }

    #[test]
    fn pending_recall_before_target_creates_the_tombstone() {
        let conn = db();
        create_group(&conn, "g1", "G", "owner", &["owner".into(), "next".into(), "me".into()]).unwrap();
        enqueue_pending_group_recall(&conn, "group:g1", "later", "next", "e1", 2, "{}", 100).unwrap();
        set_group_creator(&conn, "g1", "next").unwrap();
        assert_eq!(
            replay_pending_group_recalls(&conn, "group:g1", 5_000).unwrap(),
            vec!["later".to_string()]
        );
        assert!(is_recalled(&conn, "later"));
    }

    #[test]
    fn pending_recall_never_crosses_conversation_boundaries() {
        let conn = db();
        create_group(&conn, "g1", "G1", "owner", &["owner".into(), "next".into(), "me".into()]).unwrap();
        create_group(&conn, "g2", "G2", "owner", &["owner".into(), "next".into(), "me".into()]).unwrap();
        insert_message_if_new(&conn, &message("m-other", "group:g2")).unwrap();
        enqueue_pending_group_recall(&conn, "group:g1", "m-other", "next", "e1", 2, "{}", 100).unwrap();
        set_group_creator(&conn, "g1", "next").unwrap();
        assert!(replay_pending_group_recalls(&conn, "group:g1", 5_000).unwrap().is_empty());
        assert_eq!(get_message_record(&conn, "m-other").unwrap().kind, "text");
        assert!(!is_recalled(&conn, "m-other"));
    }

    #[test]
    fn pending_recall_ttl_and_envelope_limits_are_enforced() {
        let conn = db();
        let huge = "x".repeat(PENDING_RECALL_ENVELOPE_MAX_BYTES + 1);
        assert_eq!(
            enqueue_pending_group_recall(&conn, "group:g1", "m1", "a", "e1", 1, &huge, 100).unwrap(),
            PendingRecallEnqueue::TooLarge
        );
        enqueue_pending_group_recall(&conn, "group:g1", "m1", "a", "e1", 1, "{}", 100).unwrap();
        assert_eq!(sweep_pending_group_recalls(&conn, 100 + PENDING_RECALL_TTL_MS).unwrap(), 1);
        assert!(list_pending_recall_groups(&conn, 100 + PENDING_RECALL_TTL_MS).unwrap().is_empty());
    }

    #[test]
    fn pending_recall_capacity_evicts_the_oldest() {
        let conn = db();
        for i in 0..=PENDING_RECALL_GLOBAL_CAP {
            enqueue_pending_group_recall(
                &conn,
                &format!("group:g{i}"),
                &format!("m{i}"),
                &format!("r{i}"),
                &format!("e{i}"),
                1,
                "{}",
                1_000 + i as i64,
            )
            .unwrap();
        }
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM pending_group_recalls", [], |r| r.get(0)).unwrap();
        assert_eq!(total as usize, PENDING_RECALL_GLOBAL_CAP);
        let oldest: bool = conn.query_row(
            "SELECT 1 FROM pending_group_recalls WHERE target_msg_id='m0'",
            [],
            |_| Ok(()),
        ).optional().unwrap().is_some();
        assert!(!oldest);
    }
}
