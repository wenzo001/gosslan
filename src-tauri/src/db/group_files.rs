// 职责边界：
// - 群文件 per-recipient 投递状态（每群文件每行一个 recipient）
// ---------------- 群文件（per-recipient 投递状态） ----------------

// ---------------- 群文件 ACK 持久化账本 ----------------

/// 一条"收到过、但可能还没落终态"的群文件 ACK。
///
/// 为什么要有它：ACK 帧是**一次性**的，而落库可能失败（SQLITE_BUSY / 磁盘满 / 进程被杀）。
/// 旧形状下这类失败 ⇒ 一条已经送达的群文件**永远停在 sending**（用户能看见，对端不会再说第二遍）。
/// 现在：先落这行账本，再做状态收尾；收尾失败 ⇒ 行留着，由进程级清扫器重放 ⇒ 跨进程也能恢复。
pub struct GroupFileAck {
    pub transfer_id: String,
    pub recipient_id: String,
    pub group_id: String,
    pub success: bool,
    pub received_at: i64,
    pub attempts: i64,
    pub last_error: String,
}

/// 记一条"收到过的 ACK"。幂等：同一 `(transfer_id, recipient_id)` 覆盖旧行
/// （重放的 ACK 不会把尝试次数清零 —— 次数是"这条卡了多久"的证据）。
pub fn insert_group_file_ack(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    group_id: &str,
    success: bool,
) -> Result<()> {
    conn.execute(
        "INSERT INTO group_file_acks(transfer_id, recipient_id, group_id, success, received_at, attempts, last_error)
         VALUES(?1, ?2, ?3, ?4, ?5, 0, '')
         ON CONFLICT(transfer_id, recipient_id) DO UPDATE SET
           group_id = excluded.group_id,
           success = excluded.success,
           received_at = excluded.received_at",
        params![
            transfer_id,
            recipient_id,
            group_id,
            if success { 1i64 } else { 0i64 },
            now_ms()
        ],
    )?;
    Ok(())
}

/// 列出待重放的 ACK（最早收到的先放；每 tick 只取一小批）。
pub fn list_group_file_acks(conn: &Connection, limit: i64) -> Result<Vec<GroupFileAck>> {
    let mut stmt = conn.prepare(
        "SELECT transfer_id, recipient_id, group_id, success, received_at, attempts, last_error
         FROM group_file_acks ORDER BY received_at ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(GroupFileAck {
            transfer_id: r.get(0)?,
            recipient_id: r.get(1)?,
            group_id: r.get(2)?,
            success: r.get::<_, i64>(3)? != 0,
            received_at: r.get(4)?,
            attempts: r.get(5)?,
            last_error: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// ACK 已经落终态 ⇒ 账本行删掉（"收尾成功"的事实标记）。
pub fn delete_group_file_ack(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM group_file_acks WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id],
    )?;
    Ok(())
}

/// 重放失败：记一次尝试与错误原因（下一轮还能看见"卡在哪、卡了几次"）。
pub fn bump_group_file_ack_attempt(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    err: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE group_file_acks SET attempts = attempts + 1, last_error = ?3
         WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id, err],
    )?;
    Ok(())
}

/// 插入群文件记录。校验：群必须存在、sender 必须是群成员。
// 传输流程在后续 GroupFileOffer 步骤启用；本步骤仅 DB 层 + 测试调用。
#[allow(dead_code)]
pub fn insert_group_file(conn: &Connection, f: &GroupFile) -> Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM groups WHERE id = ?1",
            params![f.group_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)?;
    if !exists {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "群不存在：{}",
            f.group_id
        )));
    }
    let is_member: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM group_members WHERE group_id = ?1 AND device_id = ?2",
            params![f.group_id, f.sender_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)?;
    if !is_member {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "发送者不是群成员：{}",
            f.sender_id
        )));
    }
    conn.execute(
        "INSERT INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            f.transfer_id,
            f.group_id,
            f.sender_id,
            f.name,
            f.size as i64,
            f.sha256,
            f.status,
            f.created_at,
            f.scope,
            f.todo_id
        ],
    )?;
    Ok(())
}

/// 取单个群文件。不存在返回 None。
#[allow(dead_code)]
/// group_files 行 → GroupFile 的唯一映射（get / list 共用，避免两处列序漂移）。
fn row_to_group_file(r: &rusqlite::Row<'_>) -> rusqlite::Result<GroupFile> {
    Ok(GroupFile {
        transfer_id: r.get(0)?,
        group_id: r.get(1)?,
        sender_id: r.get(2)?,
        name: r.get(3)?,
        size: r.get::<_, i64>(4)? as u64,
        sha256: r.get(5)?,
        status: r.get(6)?,
        created_at: r.get(7)?,
        scope: r.get(8)?,
        todo_id: r.get(9)?,
    })
}

pub fn get_group_file(conn: &Connection, transfer_id: &str) -> Option<GroupFile> {
    conn.query_row(
        "SELECT transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id
         FROM group_files WHERE transfer_id = ?1",
        params![transfer_id],
        row_to_group_file,
    )
    .optional()
    .ok()
    .flatten()
}

/// 列出某群的全部群文件（按创建时间倒序，最新在前）。
/// 走 idx_group_files_group 索引。注意：这张表**不随「删除聊天记录」清空** ——
/// 群文件是群级资产（同钉盘/群文件语义），清空聊天历史不应连带删掉文件记录。
pub fn list_group_files(conn: &Connection, group_id: &str) -> Result<Vec<GroupFile>> {
    let mut stmt = conn.prepare(
        "SELECT transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id
         FROM group_files WHERE group_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![group_id], row_to_group_file)?;
    rows.collect()
}

/// 离线投递定向查询：某 peer 的全部 pending 群文件（按 recipient 精确命中
/// idx_group_file_recipients_recipient 索引，不扫描全表）。
/// 返回 (transfer_id, group_id) 供逐个投递。
pub fn list_pending_group_files_for_recipient(
    conn: &Connection,
    recipient_id: &str,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT r.transfer_id, f.group_id
         FROM group_file_recipients r
         JOIN group_files f ON f.transfer_id = r.transfer_id
         WHERE r.recipient_id = ?1 AND r.status = 'pending'
         ORDER BY f.created_at",
    )?;
    let rows = stmt.query_map(params![recipient_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    rows.collect()
}

/// 群文件 recipient 投递状态摘要（气泡文案用）：
/// completed/failed/pending(or sending) 计数。
#[derive(serde::Serialize)]
pub struct GroupFileDeliverySummary {
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    pub waiting: i64, // pending + sending（未到终态）
}

/// 汇总某群文件的全部 recipient 状态（定向查询，气泡显示用）。
pub fn get_group_file_delivery_summary(
    conn: &Connection,
    transfer_id: &str,
) -> Option<GroupFileDeliverySummary> {
    get_group_file(conn, transfer_id)?;
    let mut stmt = conn
        .prepare(
            "SELECT
               COUNT(*),
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status NOT IN ('completed','failed') THEN 1 ELSE 0 END)
             FROM group_file_recipients WHERE transfer_id = ?1",
        )
        .ok()?;
    let r = stmt
        .query_row(params![transfer_id], |r| {
            Ok(GroupFileDeliverySummary {
                total: r.get::<_, i64>(0)?,
                completed: r.get::<_, i64>(1).unwrap_or(0),
                failed: r.get::<_, i64>(2).unwrap_or(0),
                waiting: r.get::<_, i64>(3).unwrap_or(0),
            })
        })
        .ok()?;
    Some(r)
}

/// 为群文件添加一个 recipient 投递状态（初始 pending）。
/// 校验：群文件必须存在、recipient 必须是群成员（不允许给群外 peer 建 state）；
/// 同一 (transfer_id, recipient_id) 重复插入报错（PRIMARY KEY 冲突）。
#[allow(dead_code)]
pub fn insert_group_file_recipient(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
) -> Result<()> {
    let group_id: Option<String> = conn
        .query_row(
            "SELECT group_id FROM group_files WHERE transfer_id = ?1",
            params![transfer_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(group_id) = group_id else {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "群文件不存在：{transfer_id}"
        )));
    };
    let is_member: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM group_members WHERE group_id = ?1 AND device_id = ?2",
            params![group_id, recipient_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)?;
    if !is_member {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "接收者不是群成员：{recipient_id}"
        )));
    }
    conn.execute(
        "INSERT INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
         VALUES(?1, ?2, 'pending', 0.0, ?3)",
        params![transfer_id, recipient_id, now_ms()],
    )?;
    Ok(())
}

/// 列出群文件的全部 recipient 投递状态（按 recipient_id 稳定排序）。
#[allow(dead_code)]
pub fn list_group_file_recipients(
    conn: &Connection,
    transfer_id: &str,
) -> Result<Vec<GroupFileRecipient>> {
    let mut stmt = conn.prepare(
        "SELECT recipient_id, status, progress, updated_at
         FROM group_file_recipients WHERE transfer_id = ?1 ORDER BY recipient_id",
    )?;
    let rows = stmt.query_map(params![transfer_id], |r| {
        Ok(GroupFileRecipient {
            recipient_id: r.get(0)?,
            status: r.get(1)?,
            progress: r.get(2)?,
            updated_at: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// 更新单个 recipient 的投递状态与进度（时间戳只进不退由 updated_at 刷新保证）。
/// recipient 不存在时报错（不静默创建群外 state）。
#[allow(dead_code)]
pub fn update_group_file_recipient(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    status: &str,
    progress: f64,
) -> Result<()> {
    let n = conn.execute(
        "UPDATE group_file_recipients SET status = ?3, progress = ?4, updated_at = ?5
         WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id, status, progress, now_ms()],
    )?;
    if n == 0 {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "群文件投递状态不存在：{transfer_id}/{recipient_id}"
        )));
    }
    Ok(())
}

/// 群文件 recipient 行在 `sending` 上多久没有任何进度更新就算卡住。
///
/// 正常发送时 dispatch 每 250ms 刷新一次 `updated_at`；10 分钟不动只可能是
/// “任务已结束、但完成 ACK 丢了”或“任务死了没写终态” —— 两种都不该永远挂着。
pub const GROUP_FILE_SENDING_STALE_MS: i64 = 10 * 60 * 1000;

/// 卡住的投递行最多重试到群文件创建后 7 天（与离线补发同一个僵尸上限）。
pub const GROUP_FILE_SENDING_MAX_AGE_MS: i64 = 7 * 24 * 3600 * 1000;

/// 一行卡住的群文件投递（清扫器的输入）。
pub struct StaleGroupSending {
    pub transfer_id: String,
    pub group_id: String,
    pub recipient_id: String,
    pub updated_at: i64,
    /// 已经超过最长重试年龄 ⇒ 不再回 pending，直接判 failed。
    pub expired: bool,
}

/// 列出**本机发出的**群文件里 `status='sending'` 且 `updated_at < before_ms` 的投递行。
///
/// 只读候选；真正的改状态用下面的条件 UPDATE，避免“查出来之后发送任务刚好刷新了进度”
/// 被误重置。`local_sender_id` 过滤掉接收端自己的那一行（接收端也会把 recipient 写成
/// sending，但那条由 `sweep_stalled_receives` 管，不该走发送侧的放弃语义）。
pub fn list_stale_group_file_sending(
    conn: &Connection,
    before_ms: i64,
    max_age_before_ms: i64,
    local_sender_id: &str,
) -> Result<Vec<StaleGroupSending>> {
    let mut stmt = conn.prepare(
        "SELECT r.transfer_id, f.group_id, r.recipient_id, r.updated_at, f.created_at
         FROM group_file_recipients r
         JOIN group_files f ON f.transfer_id = r.transfer_id
         WHERE r.status = 'sending' AND r.updated_at < ?1 AND f.sender_id = ?2",
    )?;
    let rows = stmt.query_map(params![before_ms, local_sender_id], |r| {
        let created_at: i64 = r.get(4)?;
        Ok(StaleGroupSending {
            transfer_id: r.get(0)?,
            group_id: r.get(1)?,
            recipient_id: r.get(2)?,
            updated_at: r.get(3)?,
            expired: created_at <= max_age_before_ms,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 把一条**仍然卡住**的行改回 `pending`；返回 false = 期间已被发送任务刷新/改状态。
pub fn requeue_stale_group_file_sending(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    before_ms: i64,
) -> Result<bool> {
    let n = conn.execute(
        "UPDATE group_file_recipients SET status = 'pending', progress = 0.0, updated_at = ?3
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND status = 'sending' AND updated_at < ?4",
        params![transfer_id, recipient_id, now_ms(), before_ms],
    )?;
    Ok(n > 0)
}

/// 取单个 recipient 的投递状态（用于「已完成则跳过重建」判断）。不存在返回 None。
pub fn get_group_file_recipient_status(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
) -> Option<String> {
    conn.query_row(
        "SELECT status FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// 接收方：幂等建立/重建群文件接收会话。
/// 用于重启后（内存 file_key 丢失）离线补发重建——group_file / recipient 记录已存在时
/// 不报错、不覆盖已完成（completed）状态，只把未完成的中断态复位回 sending。
/// 权限（群存在 + sender 是成员）已由调用方 `handle_group_file_offer` 校验。
pub fn upsert_group_file_receive(
    conn: &Connection,
    f: &GroupFile,
    recipient_id: &str,
) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            f.transfer_id,
            f.group_id,
            f.sender_id,
            f.name,
            f.size as i64,
            f.sha256,
            f.status,
            f.created_at,
            f.scope,
            f.todo_id
        ],
    )?;
    // 未完成的遗留记录复位回 sending（completed 不动）
    conn.execute(
        "UPDATE group_files SET status = 'sending' WHERE transfer_id = ?1 AND status != 'completed'",
        params![f.transfer_id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
         VALUES(?1, ?2, 'sending', 0.0, ?3)",
        params![f.transfer_id, recipient_id, now_ms()],
    )?;
    conn.execute(
        "UPDATE group_file_recipients SET status = 'sending', progress = 0.0, updated_at = ?2
         WHERE transfer_id = ?1 AND recipient_id = ?3 AND status != 'completed'",
        params![f.transfer_id, now_ms(), recipient_id],
    )?;
    Ok(())
}

// 模块名刻意不叫 tests：本文件被 db.rs 用 include! 贴进 db 命名空间，名字要全局唯一。
#[cfg(test)]
mod group_file_delivery_tests {
    use super::{
        get_group_file_delivery_summary, list_stale_group_file_sending,
        requeue_stale_group_file_sending,
    };
    use crate::db::SCHEMA;
    use rusqlite::{params, Connection};

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    /// 投递台账的读侧聚合：界面那句"几个人收到 / 几个失败"就来自这一份摘要。
    /// 这里的四行状态用的是生产自己写进去的那四个取值（schema 注释里列的同一批），
    /// 不是为测试发明的中间态 —— 本用例只判读侧算数，不判谁去写。
    fn seed(conn: &Connection, tid: &str, rid: &str, status: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at)
             VALUES(?1, 'g1', 'me', 'f.bin', 10, 'x', 'sending', 1)",
            params![tid],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
             VALUES(?1, ?2, ?3, 0.0, 1)",
            params![tid, rid, status],
        )
        .unwrap();
    }

    #[test]
    fn delivery_summary_counts_each_recipient_into_exactly_one_bucket() {
        let conn = mem();
        seed(&conn, "t1", "b", "completed");
        seed(&conn, "t1", "c", "failed");
        seed(&conn, "t1", "d", "sending");
        seed(&conn, "t1", "e", "pending");
        let s = get_group_file_delivery_summary(&conn, "t1").expect("这一单存在，摘要不该是 None");
        assert_eq!(s.total, 4, "四个人四行台账");
        assert_eq!(s.completed, 1, "只有 b 完成");
        assert_eq!(s.failed, 1, "只有 c 失败");
        assert_eq!(
            s.waiting, 2,
            "sending 与 pending 都算「还没到」（漏掉 sending 会把在途中报成零）"
        );
        assert_eq!(
            s.completed + s.failed + s.waiting,
            s.total,
            "三格互斥且求和等于 total —— 界面拿这三个数画进度条"
        );
    }

    #[test]
    fn delivery_summary_of_unknown_transfer_is_none_not_a_zero_success() {
        let conn = mem();
        seed(&conn, "other", "b", "completed");
        assert!(
            get_group_file_delivery_summary(&conn, "missing").is_none(),
            "没有这一单时必须返回 None —— 一份 0/0 的空摘要会被界面当成「没有人要收，已完成」"
        );
    }

    #[test]
    fn delivery_summary_is_scoped_to_one_transfer() {
        let conn = mem();
        seed(&conn, "t1", "b", "completed");
        seed(&conn, "t2", "c", "failed");
        let s = get_group_file_delivery_summary(&conn, "t1").expect("t1 存在");
        assert_eq!(
            (s.total, s.completed, s.failed, s.waiting),
            (1, 1, 0, 0),
            "别人的行不许串进来"
        );
    }

    fn recipient_status(conn: &Connection, tid: &str, rid: &str) -> String {
        conn.query_row(
            "SELECT status FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2",
            params![tid, rid],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// P2-01：只有**真的卡住**的 sending 行才会被回 pending，新鲜行原样不动。
    #[test]
    fn stale_sending_is_requeued_and_fresh_sending_is_left_alone() {
        let conn = mem();
        seed(&conn, "t1", "stale", "sending");
        seed(&conn, "t1", "fresh", "sending");
        conn.execute(
            "UPDATE group_file_recipients SET updated_at = 100 WHERE recipient_id = 'fresh'",
            [],
        )
        .unwrap();

        let rows = list_stale_group_file_sending(&conn, 50, 0, "me").unwrap();
        assert_eq!(rows.len(), 1, "只捞 updated_at < 50 的那一行");
        assert_eq!(rows[0].recipient_id, "stale");
        assert!(!rows[0].expired, "创建才 1ms，远没到 7 天");

        // 别人发起的 transfer 里同形的行不许被本机清扫器碰（接收端自己的那一行）。
        seed(&conn, "t2", "foreign", "sending");
        conn.execute(
            "UPDATE group_files SET sender_id = 'other' WHERE transfer_id = 't2'",
            [],
        )
        .unwrap();
        let rows = list_stale_group_file_sending(&conn, 50, 0, "me").unwrap();
        assert_eq!(rows.len(), 1, "只扫本机作为 sender 的 transfer");

        assert!(requeue_stale_group_file_sending(&conn, "t1", "stale", 50).unwrap());
        assert_eq!(recipient_status(&conn, "t1", "stale"), "pending");
        assert_eq!(
            recipient_status(&conn, "t1", "fresh"),
            "sending",
            "新鲜行不许被扫到"
        );
        assert!(
            !requeue_stale_group_file_sending(&conn, "t1", "stale", 50).unwrap(),
            "已经不是 sending ⇒ 条件更新命中 0 行"
        );
    }

    /// 开机第一拍用不设下界的 `before` 回收**所有**本机发送中的行（发送方重启后立刻可续传，
    /// 不用等 10 分钟 stale 阈值）。别人发起的 transfer 仍然不许碰。
    #[test]
    fn boot_sweep_requeues_every_local_sending_row() {
        let conn = mem();
        seed(&conn, "t1", "fresh", "sending");
        conn.execute(
            "UPDATE group_file_recipients SET updated_at = 100 WHERE recipient_id = 'fresh'",
            [],
        )
        .unwrap();
        seed(&conn, "t2", "foreign", "sending");
        conn.execute(
            "UPDATE group_files SET sender_id = 'other' WHERE transfer_id = 't2'",
            [],
        )
        .unwrap();
        let rows = list_stale_group_file_sending(&conn, i64::MAX, 0, "me").unwrap();
        assert_eq!(rows.len(), 1, "只收本机作为 sender 的行");
        assert_eq!(rows[0].recipient_id, "fresh", "开机第一拍连新鲜行也要收");
        assert!(!rows[0].expired);
        assert!(requeue_stale_group_file_sending(&conn, "t1", "fresh", i64::MAX).unwrap());
        assert_eq!(recipient_status(&conn, "t1", "fresh"), "pending");
    }

    /// P2-01：超过 7 天的卡住行要标成 expired（清扫器据此直接按失败收尾）。
    #[test]
    fn over_age_stale_sending_is_marked_expired() {
        let conn = mem();
        seed(&conn, "t1", "old", "sending");
        let rows = list_stale_group_file_sending(&conn, 50, 1, "me").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(
            rows[0].expired,
            "created_at=1 <= max_age_before=1 ⇒ 已过最长重试年龄"
        );
        let not_expired = list_stale_group_file_sending(&conn, 50, 0, "me").unwrap();
        assert!(!not_expired[0].expired, "max_age_before=0 时同一行没过期");
    }
}
