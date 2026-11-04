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

/// 面板用：只要最近的 `limit` 条。
///
/// 群文件是**只增表**（同钉盘语义，清聊天记录不删），长期群能到几千条；而
/// `list_group_files` 的调用方还要给每行做 3~4 次点查 + 一次磁盘 stat ⇒ 整表取回
/// 等于"打开面板就冻住几秒"。历史同步仍走全量那条（它要所有行，不能截断）。
pub fn list_group_files_page(
    conn: &Connection,
    group_id: &str,
    limit: i64,
) -> Result<Vec<GroupFile>> {
    let mut stmt = conn.prepare(
        "SELECT transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id
         FROM group_files WHERE group_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![group_id, limit], row_to_group_file)?;
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

// ---------------- 群文件成员行的写门（纯判据） ----------------
//
// 三扇门各自只排一组状态，集合写在这里、SQL 由 `sql_in` / `sql_not_in` 生成（与手写逐字
// 等价，SQLite 只认语义）。特征测试 `group_file_status_doors_pin_every_status` 逐状态钉住
// 每扇门的结论 —— 改成员或改顺序都会在那里红。

/// 进度推进与「卡住行回收」只能动**仍在发送中**的格子：晚到的进度写不许把终态拉回来。
const GROUP_FILE_IN_FLIGHT: [&str; 1] = ["sending"];

/// 取消只动还没到终态的格子：`completed` 是真的收到了，`failed` 已经说清死因。
const GROUP_FILE_CANCELLABLE: [&str; 2] = ["pending", "sending"];

/// 通用状态迁移的墓碑：`cancelled` 是本表唯一的硬终态（本表没有独立墓碑列）。
const GROUP_FILE_STATE_WRITE_BLOCKED: [&str; 1] = ["cancelled"];

/// 接收侧登记（重建接收会话 / 重投同一单）不覆盖的格子：`completed` 已经收完，
/// `cancelled` 是用户按过取消 —— 两者都不许被"再传一次"点亮回 sending。
const GROUP_FILE_RECEIVE_WRITE_BLOCKED: [&str; 2] = ["completed", "cancelled"];

/// 更新单个 recipient 的投递状态与进度（时间戳只进不退由 updated_at 刷新保证）。
/// recipient 不存在时报错（不静默创建群外 state）。
///
/// ⚠️ `cancelled` 是这一张表的**硬终态**（B2）：已取消的行不许被晚到的进度、
/// 迟到的 ACK 或下一轮 attempt 改回 `sending`/`completed` —— 与 `file_transfers`
/// 那条 `cancel_terminal` 墓碑同一口径，只是这里**不需要新列**：本表的状态里
/// 只有"用户主动取消"会写 `cancelled`（自动路径写的是 `failed`/`pending`），
/// 所以状态本身就是墓碑。判据：`group_files_tests::a_cancelled_recipient_row_is_a_hard_terminal`。
#[allow(dead_code)]
/// 进度推进专用：**只更新仍在 `sending` 的那一格**。
///
/// 为什么要与 [`update_group_file_recipient`] 分开（2026-11-01 盘满探针连读三轮）：
/// 那条通用更新只挡 `cancelled`，于是**一条迟到的进度写能把 `failed`/`done` 拉回 `sending`** ——
/// 现场就是"日志已判 DISK_FULL、`.part` 也删了，台账仍显示接收中"。进度写天然是"晚到就作废"的语义，
/// 所以它自己带终止性；而状态机迁移（`failed`/`completed` 等）仍走通用那条，语义不变。
pub fn bump_group_file_recipient_progress(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    progress: f64,
) -> Result<()> {
    let sql = format!(
        "UPDATE group_file_recipients SET progress = ?3, updated_at = ?4
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND {}",
        sql_in("status", &GROUP_FILE_IN_FLIGHT)
    );
    conn.execute(
        &sql,
        params![transfer_id, recipient_id, progress, now_ms()],
    )?;
    Ok(())
}

pub fn update_group_file_recipient(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
    status: &str,
    progress: f64,
) -> Result<()> {
    let sql = format!(
        "UPDATE group_file_recipients SET status = ?3, progress = ?4, updated_at = ?5
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND {}",
        sql_not_in("status", &GROUP_FILE_STATE_WRITE_BLOCKED)
    );
    let touched = conn.execute(
        &sql,
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
    let sql = format!(
        "UPDATE group_file_recipients SET status = 'cancelled', progress = 0.0, updated_at = ?2
         WHERE transfer_id = ?1 AND {}",
        sql_in("status", &GROUP_FILE_CANCELLABLE)
    );
    let n = conn.execute(&sql, params![transfer_id, now_ms()])?;
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
    let sql = format!(
        "UPDATE group_file_recipients SET status = 'cancelled', progress = 0.0, updated_at = ?3
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND {}",
        sql_in("status", &GROUP_FILE_CANCELLABLE)
    );
    let n = conn.execute(&sql, params![transfer_id, recipient, now_ms()])?;
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

/// 整单取消群文件：**成员行 + 聚合行必须在同一个事务里**（审计 FUNC-02 复审）。
///
/// 分两笔写的后果：第一笔成功、第二笔失败 ⇒ 成员行已经 cancelled（不会被补发），
/// 而聚合行仍停在 sending（气泡与摘要显示"还在传"），下次启动也没有任何入口会修正它。
/// 返回被取消的成员行数；任一写失败即整体回滚并回传 `Err`。
pub fn cancel_group_file_atomically(conn: &Connection, transfer_id: &str) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let n = cancel_group_file_recipients(&tx, transfer_id)?;
    mark_group_file_cancelled(&tx, transfer_id)?;
    tx.commit()?;
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

/// 列出**本机发出的**群文件里卡住的投递行，两类：
/// 1. `status='sending'` 且 `updated_at < before_ms`（任务死了/ACK 丢了）；
/// 2. `status='pending'` 且整单创建时间已过最长年龄（?3）—— 等离线成员的行
///    （闪退取证第 4 项：成员永不上线时，旧形状里这类行**没有任何终态视野**，
///    气泡永久 sending）。7 天窗口与离线补发承诺（INV-P04）同源：窗口内成员
///    上线照常补发，窗口到了按失败收尾。
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
         WHERE f.sender_id = ?2 AND (
           (r.status = 'sending' AND r.updated_at < ?1)
           OR (r.status = 'pending' AND f.created_at <= ?3)
         )",
    )?;
    let rows = stmt.query_map(
        params![before_ms, local_sender_id, max_age_before_ms],
        |r| {
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
    let sql = format!(
        "UPDATE group_file_recipients SET status = 'pending', progress = 0.0, updated_at = ?3
         WHERE transfer_id = ?1 AND recipient_id = ?2 AND {} AND updated_at < ?4",
        sql_in("status", &GROUP_FILE_IN_FLIGHT)
    );
    let n = conn.execute(
        &sql,
        params![transfer_id, recipient_id, now_ms(), before_ms],
    )?;
    Ok(n > 0)
}

/// 群文件成员行的只读投影：**区分「这一格不存在」与「读库失败」**。
///
/// 写侧（ACK 收尾，`transport/group_file.rs::apply_group_file_ack_db`）必须能分辨这两者：
/// 不存在 ⇒ 这条 ACK 是串台的，账本行可以丢；读库失败 ⇒ 必须返回 `Err`，让账本行留下、
/// 由清扫器重放。混成一个 `Option` 的后果是：一次 SQLITE_BUSY 就把一条真实送达的 ACK
/// 当成伪造丢掉，群文件永远停在 sending。
pub fn group_file_recipient_status(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
) -> Result<Option<String>> {
    conn.query_row(
        "SELECT status FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id],
        |r| r.get(0),
    )
    .optional()
}

/// 群文件成员行的只读投影：这一单**全部**成员的状态（气泡聚合的输入）。
/// 终态聚合只关心集合成员，顺序不影响结论；排序仅让结果稳定、便于测试对账。
pub fn group_file_recipient_statuses(conn: &Connection, transfer_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT status FROM group_file_recipients WHERE transfer_id = ?1 ORDER BY recipient_id",
    )?;
    let rows = stmt.query_map(params![transfer_id], |r| r.get(0))?;
    rows.collect()
}

/// 取单个 recipient 的投递状态（用于「已完成则跳过重建」判断）。不存在返回 None，读库失败也返回 None。
///
/// 读侧只需要「有没有 / 是什么」，吞错是既有契约（行为不变）；写侧要分辨失败请走
/// [`group_file_recipient_status`]。
pub fn get_group_file_recipient_status(
    conn: &Connection,
    transfer_id: &str,
    recipient_id: &str,
) -> Option<String> {
    group_file_recipient_status(conn, transfer_id, recipient_id)
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
    let sql = format!(
        "UPDATE group_files SET status = 'sending' WHERE transfer_id = ?1 AND {}",
        sql_not_in("status", &GROUP_FILE_RECEIVE_WRITE_BLOCKED)
    );
    conn.execute(&sql, params![f.transfer_id])?;
    conn.execute(
        "INSERT OR IGNORE INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
         VALUES(?1, ?2, 'sending', 0.0, ?3)",
        params![f.transfer_id, recipient_id, now_ms()],
    )?;
    let sql = format!(
        "UPDATE group_file_recipients SET status = 'sending', progress = 0.0, updated_at = ?2
         WHERE transfer_id = ?1 AND recipient_id = ?3 AND {}",
        sql_not_in("status", &GROUP_FILE_RECEIVE_WRITE_BLOCKED)
    );
    conn.execute(
        &sql,
        params![f.transfer_id, now_ms(), recipient_id],
    )?;
    Ok(())
}

// 模块名刻意不叫 tests：本文件被 db.rs 用 include! 贴进 db 命名空间，名字要全局唯一。
#[cfg(test)]
mod group_file_delivery_tests {
    use super::{
        cancel_group_file_recipient, cancel_group_file_recipients,
        bump_group_file_recipient_progress, get_group_file_delivery_summary,
        get_group_file_recipient_status, group_file_recipient_status, group_file_recipient_statuses,
        is_group_file_cancelled, is_group_file_recipient_cancelled,
        list_pending_group_files_for_recipient, list_stale_group_file_sending,
        mark_group_file_cancelled, requeue_stale_group_file_sending, update_group_file_recipient,
        upsert_group_file_receive,
    };
    use crate::db::SCHEMA;
    use rusqlite::{params, Connection};

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    /// ★ 迟到的**进度写**不许动终态（2026-11-01 盘满探针连读三轮：日志判 DISK_FULL、`.part` 已删，
    /// 台账却仍是 `sending` —— 收尾写了 `failed`，同一秒另一条进度写把它盖回去）。
    #[test]
    fn progress_write_only_touches_rows_still_sending() {
        let conn = mem();
        conn.execute(
            "INSERT INTO group_files(transfer_id,group_id,sender_id,name,size,sha256,status,created_at,scope,todo_id)
             VALUES('gf-p','g1','me','x.bin',10,'00','pending',1,'chat','')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_file_recipients(transfer_id,recipient_id,status,progress,updated_at)
             VALUES('gf-p','peer-b','sending',0.0,1)",
            [],
        )
        .unwrap();
        // 正常：sending 时可以推进度
        bump_group_file_recipient_progress(&conn, "gf-p", "peer-b", 0.5).unwrap();
        update_group_file_recipient(&conn, "gf-p", "peer-b", "failed", 0.0).unwrap();
        // 迟到：终态之后再来一次进度写，必须一个字都不改
        bump_group_file_recipient_progress(&conn, "gf-p", "peer-b", 0.9).unwrap();
        let (st, pg): (String, f64) = conn
            .query_row(
                "SELECT status, progress FROM group_file_recipients WHERE transfer_id='gf-p' AND recipient_id='peer-b'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(st, "failed", "终态被迟到的进度写改回了 sending ⇒ 界面会一直挂「接收中」");
        assert_eq!(pg, 0.0, "终态的进度也该被钉住，不许被迟到写推进");
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

    /// 群文件成员行的只读投影：一条 `transfer` 的全部状态，稳定排序，不串别人的行。
    #[test]
    fn recipient_status_projection_reads_every_member_of_one_transfer_only() {
        let conn = mem();
        seed(&conn, "t1", "c", "completed");
        seed(&conn, "t1", "a", "sending");
        seed(&conn, "t2", "b", "failed");
        assert_eq!(
            group_file_recipient_statuses(&conn, "t1").unwrap(),
            vec!["sending".to_string(), "completed".to_string()],
            "按 recipient_id 稳定排序，且不串入别的 transfer"
        );
    }

    /// 两条读法必须继续分工：写侧能分辨「没有这一格」与「读库失败」，读侧按旧契约吞错。
    ///
    /// 这是 ACK 收尾的生死线：`not_recipient`（可以丢账本行）与「读库失败」（必须留着
    /// 账本行重放）被合并成一个 `Option` 时，一次 SQLITE_BUSY 就会把真实送达的 ACK 当成
    /// 伪造丢掉 —— 群文件永远停在 sending，对端不会再说第二遍。
    #[test]
    fn strict_recipient_status_read_tells_absent_apart_from_unreadable() {
        let conn = mem();
        seed(&conn, "t1", "b", "sending");
        assert_eq!(
            group_file_recipient_status(&conn, "t1", "b")
                .unwrap()
                .as_deref(),
            Some("sending")
        );
        assert_eq!(
            group_file_recipient_status(&conn, "t1", "ghost").unwrap(),
            None
        );
        assert_eq!(get_group_file_recipient_status(&conn, "t1", "ghost"), None);

        // 读库失败：严格投影必须报 Err，宽松投影仍答 None（既有行为，不许改）
        conn.execute_batch("DROP TABLE group_file_recipients").unwrap();
        assert!(
            group_file_recipient_status(&conn, "t1", "b").is_err(),
            "读库失败必须能被区分出来，否则 ACK 账本行会被当串台丢掉"
        );
        assert_eq!(
            get_group_file_recipient_status(&conn, "t1", "b"),
            None,
            "读侧吞错的旧契约不变"
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

    /// 闪退取证第 4 项：等离线成员的 `pending` 行也必须有终态视野。
    /// 旧形状只捞 `sending` ⇒ 成员永不上线时 pending 行永远没人碰，气泡永久 sending。
    /// 现在：过最长年龄的 pending 行按 expired 捞出（清扫器按失败收尾）；
    /// 窗口内的不捞 —— 7 天内上线照常补发（INV-P04 离线承诺不许破）。
    #[test]
    fn over_age_pending_rows_are_listed_expired_and_fresh_ones_are_not() {
        let conn = mem();
        seed(&conn, "t1", "offline-member", "pending");
        let rows = list_stale_group_file_sending(&conn, 0, 1, "me").unwrap();
        assert_eq!(rows.len(), 1, "过最长年龄的 pending 行必须被捞到");
        assert_eq!(rows[0].recipient_id, "offline-member");
        assert!(
            rows[0].expired,
            "pending 行被捞起时必须带 expired（它是行被失败收尾的唯一通道）"
        );
        // 窗口内（max_age_before=0 < created_at=1）：一律不捞。
        let fresh = list_stale_group_file_sending(&conn, 0, 0, "me").unwrap();
        assert!(
            fresh.is_empty(),
            "窗口内的 pending 行不许被捞 —— 离线补发承诺（INV-P04）"
        );
        // 正控：把 pending 臂从查询里摘掉（退回旧形状）⇒ 上面第一条断言立刻红。
        // 这里用"只捞 sending 的等价查询"模拟旧形状，证明判据量得到这个变异。
        let mut old_shape = conn
            .prepare(
                "SELECT r.transfer_id FROM group_file_recipients r
                 JOIN group_files f ON f.transfer_id = r.transfer_id
                 WHERE r.status = 'sending' AND r.updated_at < ?1 AND f.sender_id = ?2",
            )
            .unwrap();
        let old_rows: Vec<String> = old_shape
            .query_map(params![0i64, "me"], |r| r.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(
            old_rows.is_empty(),
            "旧形状确实看不见 pending 行 ⇒ 本条判据不是恒绿"
        );
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

    /// 五扇写门在同一张状态矩阵上各自给答案：集合成员或顺序一改，这条就红。
    ///
    /// 五扇门分别是：进度写（只进 sending）、卡住行回收（只收 sending）、
    /// 取消（只动 pending/sending）、通用状态迁移（只被 cancelled 挡）、
    /// 接收侧登记（只保留 completed/cancelled）。
    #[test]
    fn group_file_status_doors_pin_every_status() {
        fn read(conn: &Connection, tid: &str, rid: &str) -> (String, f64) {
            conn.query_row(
                "SELECT status, progress FROM group_file_recipients
                 WHERE transfer_id = ?1 AND recipient_id = ?2",
                params![tid, rid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        }

        for status in ["pending", "sending", "completed", "failed", "cancelled"] {
            // ① 进度写只进 sending
            let conn = mem();
            seed(&conn, "t", "p", status);
            bump_group_file_recipient_progress(&conn, "t", "p", 0.7).unwrap();
            assert_eq!(
                read(&conn, "t", "p").1,
                if status == "sending" { 0.7 } else { 0.0 },
                "进度写门对 {status} 的结论变了"
            );

            // ② 卡住行回收只在 sending 且过期时发生（before 取 MAX，避免与 ① 刚写的 updated_at 比毫秒）
            assert_eq!(
                requeue_stale_group_file_sending(&conn, "t", "p", i64::MAX).unwrap(),
                status == "sending",
                "回收门对 {status} 的结论变了"
            );

            // ③ 取消只动 pending / sending
            assert_eq!(
                cancel_group_file_recipient(&conn, "t", "p").unwrap(),
                matches!(status, "pending" | "sending"),
                "取消门对 {status} 的结论变了"
            );

            // ④ 通用状态迁移只被 cancelled 挡
            let conn2 = mem();
            seed(&conn2, "t", "p", status);
            update_group_file_recipient(&conn2, "t", "p", "failed", 0.0).unwrap();
            assert_eq!(
                read(&conn2, "t", "p").0,
                if status == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                },
                "状态写门对 {status} 的结论变了"
            );

            // ⑤ 接收侧登记只保留 completed / cancelled，其余复位成 sending
            let conn3 = mem();
            seed(&conn3, "t", "p", status);
            let gf = crate::state::GroupFile {
                transfer_id: "t".to_string(),
                group_id: "g".to_string(),
                sender_id: "me".to_string(),
                name: "x".to_string(),
                size: 1,
                sha256: String::new(),
                status: "sending".to_string(),
                created_at: 1,
                scope: "chat".to_string(),
                todo_id: String::new(),
            };
            upsert_group_file_receive(&conn3, &gf, "p").unwrap();
            assert_eq!(
                read(&conn3, "t", "p").0,
                if matches!(status, "completed" | "cancelled") {
                    status
                } else {
                    "sending"
                },
                "接收登记门对 {status} 的结论变了"
            );
        }
    }
}
