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
/// completed/failed/cancelled/未到终态 四类计数。
#[derive(serde::Serialize)]
pub struct GroupFileDeliverySummary {
    pub total: i64,
    pub completed: i64,
    pub failed: i64,
    /// 用户主动取消的成员数（B2）。这一格**必须单独数**：`waiting` 以前是
    /// `NOT IN ('completed','failed')`，取消掉的成员会被一直算成"还在等"，
    /// 于是气泡永远挂着「等待在线 K 人」，而 K 里那几个人其实永远不会再收了。
    pub cancelled: i64,
    pub waiting: i64, // pending + sending（未到终态，且不含已取消）
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
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),
               SUM(CASE WHEN status NOT IN ('completed','failed','cancelled') THEN 1 ELSE 0 END)
             FROM group_file_recipients WHERE transfer_id = ?1",
        )
        .ok()?;
    let r = stmt
        .query_row(params![transfer_id], |r| {
            Ok(GroupFileDeliverySummary {
                total: r.get::<_, i64>(0)?,
                completed: r.get::<_, i64>(1).unwrap_or(0),
                failed: r.get::<_, i64>(2).unwrap_or(0),
                cancelled: r.get::<_, i64>(3).unwrap_or(0),
                waiting: r.get::<_, i64>(4).unwrap_or(0),
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
///
/// ⚠️ `cancelled` 是这一张表的**硬终态**（B2）：已取消的行不许被晚到的进度、
/// 迟到的 ACK 或下一轮 attempt 改回 `sending`/`completed` —— 与 `file_transfers`
/// 那条 `cancel_terminal` 墓碑同一口径，只是这里**不需要新列**：本表的状态里
/// 只有"用户主动取消"会写 `cancelled`（自动路径写的是 `failed`/`pending`），
/// 所以状态本身就是墓碑。判据：`group_files_tests::a_cancelled_recipient_row_is_a_hard_terminal`。
#[allow(dead_code)]
pub fn update_group_file_recipient(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    status: &str,
    progress: f64,
) -> Result<()> {
    let touched = conn.execute(
        "UPDATE group_file_recipients SET status = ?3, progress = ?4, updated_at = ?5
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND status <> 'cancelled'",
        params![transfer_id, recipient_id, status, progress, now_ms()],
    )?;
    if touched > 0 {
        return Ok(());
    }
    // 改 0 行有两种原因，必须分开：**这一格不存在**要沿用旧行为报错（调用方靠它发现
    // "给群外 peer 建了 state"），而**已被取消**是正常跳过 —— 把它也报成错，
    // 取消之后的每一笔晚到写都会在生产日志里留一条假故障。
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Ok(());
    }
    Err(rusqlite::Error::InvalidParameterName(format!(
        "群文件投递状态不存在：{transfer_id}/{recipient_id}"
    )))
}

/// 用户取消一条**本机发出的**群文件：把所有还没到终态的收件人行落 `cancelled`，
/// 返回被改写的行数（= 0 也是成功：这一单要么全收完了、要么本来就是 1:1 文件）。
///
/// 三条边界都是语义，不是风格：
///  · 只动 `pending` / `sending`：已经 `completed` 的成员**真的收到了**，把那一格改成
///    "已取消"是谎报；`failed` 已经是一个说得清的终态，不许被取消覆盖成另一件事。
///  · 不动 `group_files` 里别人的单（收件端的行由 `mark_group_file_cancelled` 的调用方
///    按 `sender_id` 判，见 `commands/files.rs::cancel_file_transfer`）。
///  · 必须让 `requeue_stale_group_file_sending` 与 `list_pending_group_files_for_recipient`
///    都看不到这些行 —— 前者只捞 `sending`、后者只捞 `pending`，写 `cancelled` 之后
///    离线成员重连时不再被补发（判据：`a_cancelled_group_file_is_not_requeued_by_the_offline_path`）。
pub fn cancel_group_file_recipients(conn: &Connection, transfer_id: &str) -> Result<usize> {
    let n = conn.execute(
        "UPDATE group_file_recipients SET status = 'cancelled', progress = 0.0, updated_at = ?2
         WHERE transfer_id = ?1 AND status IN ('pending', 'sending')",
        params![transfer_id, now_ms()],
    )?;
    Ok(n)
}

/// 取消群文件里的**一格**（按成员取消，B3b）。
///
/// 与 [`cancel_group_file_recipients`] 的差别只有受众：那条是"整单取消"（用户点取消一条群文件），
/// 这条是"某个成员说他不收了" / "发送方让某个成员别再收"。只动 `pending|sending`：
/// `completed` 是他真的收到了，`failed` 已经说清它死于什么，`cancelled` 是幂等的目标态。
/// 返回 `true` = 这一格确实从"还在传"变成了"已取消"。
pub fn cancel_group_file_recipient(
    conn: &Connection,
    transfer_id: &str,
    recipient: &str,
) -> Result<bool> {
    let n = conn.execute(
        "UPDATE group_file_recipients SET status = 'cancelled', progress = 0.0, updated_at = ?3
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND status IN ('pending', 'sending')",
        params![transfer_id, recipient, now_ms()],
    )?;
    Ok(n > 0)
}

/// 群文件这一单本身落 `cancelled`（台账摘要、离线补发的入口都读它）。
/// `completed` 不动 —— 与 `file_transfers` 的终态契约同一条口径。
pub fn mark_group_file_cancelled(conn: &Connection, transfer_id: &str) -> Result<usize> {
    let n = conn.execute(
        "UPDATE group_files SET status = 'cancelled'
         WHERE transfer_id = ?1 AND status <> 'completed'",
        params![transfer_id],
    )?;
    Ok(n)
}

/// 该群文件是否已被用户取消（投递入口的闸门用）。行不存在 = 没取消（1:1 文件走这条路）。
pub fn is_group_file_cancelled(conn: &Connection, transfer_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM group_files WHERE transfer_id = ?1 AND status = 'cancelled'",
        params![transfer_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// 某个收件人这一格是否已被取消（按成员投递那条路的闸门用）。
pub fn is_group_file_recipient_cancelled(conn: &Connection, transfer_id: &str, recipient: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2 AND status = 'cancelled'",
        params![transfer_id, recipient],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
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
    // 未完成的遗留记录复位回 sending（completed 不动，**cancelled 也不动** —— B2）。
    // 这一张表两边共用：发送端按成员各写一行，接收端给自己的那一行写的 recipient
    // 就是本机 device_id（`transport/group_file.rs` 那条失败出口）。所以"cancelled 是硬终态"
    // 在这里同样成立：已经被用户取消的那一格，不许被"重建接收会话 / 重投同一单"点亮回
    // sending —— 点亮之后的表现是"取消过的文件又自己开始传"。
    // 注意这里**不是**离线补发的查询入口（那条在 `list_pending_group_files_for_recipient`，
    // 它只捞 pending，本来就看不见 cancelled 行）。
    conn.execute(
        "UPDATE group_files SET status = 'sending' WHERE transfer_id = ?1 AND status NOT IN ('completed', 'cancelled')",
        params![f.transfer_id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
         VALUES(?1, ?2, 'sending', 0.0, ?3)",
        params![f.transfer_id, recipient_id, now_ms()],
    )?;
    conn.execute(
        "UPDATE group_file_recipients SET status = 'sending', progress = 0.0, updated_at = ?2
         WHERE transfer_id = ?1 AND recipient_id = ?3 AND status NOT IN ('completed', 'cancelled')",
        params![f.transfer_id, now_ms(), recipient_id],
    )?;
    Ok(())
}

// 模块名刻意不叫 tests：本文件被 db.rs 用 include! 贴进 db 命名空间，名字要全局唯一。
#[cfg(test)]
mod group_file_delivery_tests {
    use super::{
        cancel_group_file_recipient, cancel_group_file_recipients,
        get_group_file_delivery_summary, is_group_file_cancelled,
        is_group_file_recipient_cancelled, list_pending_group_files_for_recipient,
        list_stale_group_file_sending, mark_group_file_cancelled, requeue_stale_group_file_sending,
        update_group_file_recipient, upsert_group_file_receive,
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

    /// 四格必须**互斥且求和等于 total**（界面拿这几个数画进度条）。
    ///
    /// B2 加 `cancelled` 那一格时，这条从三格扩成四格 —— 而且刻意把"已取消"放进分母：
    /// 旧写法 `waiting = NOT IN ('completed','failed')` 会把取消掉的成员一直算成"还在等"，
    /// 于是那句「等待在线 K 人」里的 K 永不下线（人已经不会再收了）。
    #[test]
    fn delivery_summary_counts_each_recipient_into_exactly_one_bucket() {
        let conn = mem();
        seed(&conn, "t1", "b", "completed");
        seed(&conn, "t1", "c", "failed");
        seed(&conn, "t1", "d", "sending");
        seed(&conn, "t1", "e", "pending");
        seed(&conn, "t1", "f", "cancelled");
        let s = get_group_file_delivery_summary(&conn, "t1").expect("这一单存在，摘要不该是 None");
        assert_eq!(s.total, 5, "五个人五行台账");
        assert_eq!(s.completed, 1, "只有 b 完成");
        assert_eq!(s.failed, 1, "只有 c 失败");
        assert_eq!(s.cancelled, 1, "只有 f 是用户取消（这一格必须单独数出来）");
        assert_eq!(
            s.waiting, 2,
            "sending 与 pending 都算「还没到」；**已取消的不算在等**（漏掉 sending 会把在途中报成零）"
        );
        assert_eq!(
            s.completed + s.failed + s.cancelled + s.waiting,
            s.total,
            "四格互斥且求和等于 total —— 少一格或重一格都会让界面上的数字对不上人数"
        );
    }

    /// 用户取消群文件：只有**还没到终态**的成员被落 cancelled。
    ///
    /// 钉三条边界（每条都对应一种会把话说错的写法）：
    ///  · `completed` 的成员**真的收到了**，改成"已取消"是谎报；
    ///  · `failed` 已经是一个说得清的终态，不许被"取消"覆盖成另一件事（排查时会读错）；
    ///  · 返回值是被改写的行数（=0 也是成功：这一单可能全收完了，也可能是 1:1 文件）。
    #[test]
    fn cancelling_a_group_file_touches_only_the_members_that_are_not_terminal() {
        let conn = mem();
        seed(&conn, "t2", "b", "completed");
        seed(&conn, "t2", "c", "failed");
        seed(&conn, "t2", "d", "sending");
        seed(&conn, "t2", "e", "pending");
        assert_eq!(
            cancel_group_file_recipients(&conn, "t2").unwrap(),
            2,
            "sending + pending 两行该被取消，completed/failed 一行都不许动"
        );
        let read = |rid: &str| -> String {
            conn.query_row(
                "SELECT status FROM group_file_recipients WHERE transfer_id='t2' AND recipient_id=?1",
                params![rid],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read("b"), "completed", "已收到的成员不能被改口成已取消");
        assert_eq!(read("c"), "failed", "已失败的成员不许被取消覆盖（两个终态各说各的事）");
        assert_eq!(read("d"), "cancelled");
        assert_eq!(read("e"), "cancelled");
        // 再取消一次：幂等，且 0 行不是错误
        assert_eq!(cancel_group_file_recipients(&conn, "t2").unwrap(), 0);
        // 群文件行不存在时也不报错（1:1 文件走同一个取消入口）
        assert_eq!(cancel_group_file_recipients(&conn, "nope").unwrap(), 0);
    }

    /// `cancelled` 是这张表的**硬终态**：晚到的进度、迟到的 ACK、下一轮 attempt
    /// 都不许把它改回 sending/completed（与 `file_transfers.cancel_terminal` 同一口径）。
    ///
    /// 同时钉住"改 0 行"的两种原因不许合并：这一格不存在必须**继续报错**（调用方靠它
    /// 发现"给群外 peer 建了 state"），而已被取消是正常跳过 —— 把后者也报成错，
    /// 取消之后的每一笔晚到写都会在生产日志里留一条假故障。
    #[test]
    fn a_cancelled_recipient_row_is_a_hard_terminal() {
        let conn = mem();
        seed(&conn, "t3", "d", "sending");
        assert_eq!(cancel_group_file_recipients(&conn, "t3").unwrap(), 1);

        for (status, progress) in [("sending", 0.6), ("completed", 1.0), ("failed", 0.0)] {
            update_group_file_recipient(&conn, "t3", "d", status, progress).unwrap();
            let got: String = conn
                .query_row(
                    "SELECT status FROM group_file_recipients WHERE transfer_id='t3' AND recipient_id='d'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                got, "cancelled",
                "已取消的行不许被 {status} 的晚到写复活（复活就是「按了取消它自己又活了」）"
            );
        }
        // 反向：不存在的行仍然要报错（这一格不能被"跳过取消"顺手放宽掉）
        assert!(
            update_group_file_recipient(&conn, "t3", "ghost", "sending", 0.0).is_err(),
            "群外/不存在的收件人必须继续报错，否则「给群外 peer 建 state」这条路就没人管了"
        );
    }

    /// 取消之后的三条"复活入口"都必须看不见这一行 —— 这才是"取消得动"的真凭据。
    ///
    /// 每一行都对应一段真实代码路径，少一行就是"界面上取消了、链路上照样发完"：
    ///  · 离线补发查询（成员重连时捞 pending）；
    ///  · 接收会话重建 `upsert_group_file_receive`（它会把非终态复位成 sending）；
    ///  · stale-sending 清扫器（10 分钟无进度就 requeue）。
    #[test]
    fn a_cancelled_group_file_is_not_requeued_by_the_offline_or_sweep_paths() {
        let conn = mem();
        seed(&conn, "t4", "d", "pending");
        assert_eq!(cancel_group_file_recipients(&conn, "t4").unwrap(), 1);
        assert_eq!(
            list_pending_group_files_for_recipient(&conn, "d")
                .unwrap()
                .len(),
            0,
            "离线补发只捞 pending：已取消的成员重连时不该再被捞出来发一遍"
        );

        // 接收会话重建那条路（同 transfer / 同 recipient 再进来一次）
        let gf = crate::state::GroupFile {
            transfer_id: "t4".to_string(),
            group_id: "g1".to_string(),
            sender_id: "me".to_string(),
            name: "f.bin".to_string(),
            size: 10,
            sha256: "x".to_string(),
            status: "sending".to_string(),
            created_at: 1,
            scope: "chat".to_string(),
            todo_id: String::new(),
        };
        upsert_group_file_receive(&conn, &gf, "d").unwrap();
        let got: String = conn
            .query_row(
                "SELECT status FROM group_file_recipients WHERE transfer_id='t4' AND recipient_id='d'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            got, "cancelled",
            "重建接收会话不许把已取消的那一格点亮回 sending"
        );

        // stale-sending 清扫器：先看得到吗（行已不是 sending ⇒ 看不见），再直接试一次 requeue
        assert!(
            !list_stale_group_file_sending(&conn, i64::MAX, 0, "me")
                .unwrap()
                .iter()
                .any(|s| s.transfer_id == "t4" && s.recipient_id == "d"),
            "清扫器只捞 sending：已取消的行不能出现在它的输入里"
        );
        assert!(
            !requeue_stale_group_file_sending(&conn, "t4", "d", i64::MAX).unwrap(),
            "requeue 的 WHERE 也是 status='sending' ⇒ 必须回报「没改成」"
        );
    }

    /// 群文件行本身落 cancelled；`completed` 的那一单不动（终态契约同一口径）。
    #[test]
    fn group_file_row_cancel_does_not_downgrade_completed() {
        let conn = mem();
        seed(&conn, "t5", "b", "completed");
        conn.execute(
            "UPDATE group_files SET status = 'completed' WHERE transfer_id = 't5'",
            [],
        )
        .unwrap();
        assert_eq!(
            mark_group_file_cancelled(&conn, "t5").unwrap(),
            0,
            "已收完的群文件行不许被降级成已取消（INV-P26 同一口径：取消不成立时一行都不该改）"
        );
        assert!(!is_group_file_cancelled(&conn, "t5"));

        seed(&conn, "t6", "b", "sending");
        assert_eq!(mark_group_file_cancelled(&conn, "t6").unwrap(), 1);
        assert!(is_group_file_cancelled(&conn, "t6"));
        // 群文件行与成员行是**两个不同的写**，故意不合并：投递入口那道闸读的是
        // "这一单 OR 这一格"，所以只落群文件行也拦得住；但气泡摘要那句「已取消 N 人」
        // 按成员数说话，必须等 `cancel_group_file_recipients` 才数得出来。
        // 这一格断言钉的就是"mark 群文件行**不会**顺手改成员行"——
        // 有人把它合成一句 UPDATE 时，摘要里的人数会突然变成全群，而实际上有人已经收完了。
        assert!(
            !is_group_file_recipient_cancelled(&conn, "t6", "b"),
            "群文件行落 cancelled 不该顺带改写成员行（两笔写各有受众）"
        );
        assert_eq!(cancel_group_file_recipients(&conn, "t6").unwrap(), 1);
        assert!(is_group_file_recipient_cancelled(&conn, "t6", "b"));
        assert!(!is_group_file_recipient_cancelled(&conn, "t6", "ghost"));
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

    /// 按**单个成员**取消（B3b）：只动还在传的那一格，`completed` 与 `failed` 各说各的事。
    ///
    /// 为什么这一格必须是"只动 pending/sending"：`completed` 是他真的收到了 ——
    /// 把他一起改成 cancelled，摘要里"收到的人"会凭空少一个，而文件其实在他盘上。
    #[test]
    fn cancelling_one_recipient_leaves_the_others_alone() {
        let conn = mem();
        seed(&conn, "t9", "a", "sending");
        seed(&conn, "t9", "b", "pending");
        seed(&conn, "t9", "c", "completed");
        seed(&conn, "t9", "d", "failed");

        assert!(cancel_group_file_recipient(&conn, "t9", "a").unwrap());
        // 幂等：再按一次返回 false（没有还在传的行可改），但状态仍是 cancelled
        assert!(
            !cancel_group_file_recipient(&conn, "t9", "a").unwrap(),
            "重复取消同一格必须返回 false（幂等：这一格已经不是还在传的状态了）"
        );
        // 已收完 / 已失败的那两格不许被这条路径改写
        assert!(
            !cancel_group_file_recipient(&conn, "t9", "c").unwrap(),
            "已收到的那一格不许被按成员取消改写"
        );
        assert!(
            !cancel_group_file_recipient(&conn, "t9", "d").unwrap(),
            "失败那一格不许被按成员取消改写"
        );
        // 没点名的成员不受影响
        assert!(cancel_group_file_recipient(&conn, "t9", "b").unwrap());

        let read = |rid: &str| -> (String, f64) {
            conn.query_row(
                "SELECT status, progress FROM group_file_recipients WHERE transfer_id='t9' AND recipient_id=?1",
                params![rid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(read("a"), ("cancelled".to_string(), 0.0), "取消的格子进度归零");
        assert_eq!(read("b"), ("cancelled".to_string(), 0.0));
        assert_eq!(read("c").0, "completed", "已收到的那一格不许被按成员取消改写");
        assert_eq!(read("d").0, "failed", "失败那一格已经说清了它死于什么");
    }
}
