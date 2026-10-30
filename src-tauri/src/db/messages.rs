// 职责边界：
// - 消息表 CRUD（insert/get/list/update_message_status）
// ---------------- 消息 ----------------

/// @ 的落点 ⇄ 库里那一列。**编解码规则本身不在这里**（在 `protocol::mention_targets_from_value`，
/// 与线上那一份共用），因为这一列与网络字段必须给同一个三态答案：
/// `NULL` / 坏 JSON / 半截 = 不知道 ⇒ 呈现层按昵称兜底；`'[]'` 才是"权威地说没有"。
fn encode_mention_targets(v: &Option<Vec<crate::protocol::MentionTarget>>) -> Option<String> {
    v.as_ref().and_then(|t| serde_json::to_string(t).ok())
}

fn decode_mention_targets(raw: Option<String>) -> Option<Vec<crate::protocol::MentionTarget>> {
    raw.as_deref()
        .and_then(crate::protocol::parse_mention_targets_column)
}

/// 插入一条消息，并返回「本次是否真的新建了记录」的三态裁决。
///
/// - `Ok(true)` ：本次真的插入一条新行 —— 唯一应产生投递副作用（未读 +1、`message-received`）的情形。
/// - `Ok(false)`：`msg_id` 已存在，被 `INSERT OR IGNORE` 命中唯一约束而忽略 —— 消息在库中，但本次无新行。
/// - `Err(e)`   ：真正的数据库故障（表不可用、SQL/IO 错误等）—— 消息**没有**持久化。
///
/// 判定与插入在同一条 SQL 语句内完成（不先 `SELECT` 再 `INSERT`），因此 Direct 与 Gossip
/// 并发投递同一业务 `msg_id` 时，只可能有一方拿到 `Ok(true)`。
///
/// ⚠️ 调用方不得把 `Err` 折叠成 `false`（如 `unwrap_or(false)`）：那会把一次临时故障误判成
/// 「重复」并照常回 Ack，而 Ack 会让发送方删除 outbox 行，导致消息永久丢失。
pub fn insert_message_if_new(conn: &Connection, m: &MessageRecord) -> Result<bool> {
    let changed = conn.execute(
        // 按 msg_id 幂等用 `WHERE NOT EXISTS`，**不用 `OR IGNORE`**：后者会把
        // `local_id` 唯一冲突也一起吞掉 ⇒ 新消息被静默丢弃（列表 key 重复反过来又覆盖测量）。
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, ?1)
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE msg_id = ?1)",
        params![m.msg_id, m.conv_id, m.sender_id, m.receiver_id, m.kind, m.content, m.ts, m.seq, m.status,
                encode_mention_targets(&m.mention_targets), m.local_id],
    )?;
    Ok(changed > 0)
}

pub fn insert_message(conn: &Connection, m: &MessageRecord) -> Result<()> {
    insert_message_if_new(conn, m).map(|_| ())
}

/// 原子地写入本地消息与可靠发送队列。
/// 发送路径不能出现「消息已落库但 outbox 没写入」或反过来的半状态。
pub fn insert_message_and_outbox(
    conn: &Connection,
    m: &MessageRecord,
    peer_id: &str,
    payload: &str,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, ?1))",
        params![
            m.msg_id,
            m.conv_id,
            m.sender_id,
            m.receiver_id,
            m.kind,
            m.content,
            m.ts,
            m.seq,
            m.status,
            encode_mention_targets(&m.mention_targets),
            m.local_id
        ],
    )?;
    tx.execute(
        "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![m.msg_id, peer_id, payload, now_ms()],
    )?;
    tx.commit()
}

pub fn message_exists(conn: &Connection, msg_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub fn count_messages(conn: &Connection, conv_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE conv_id = ?1",
        params![conv_id],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0)
}

pub fn get_messages(
    conn: &Connection,
    conv_id: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<MessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id, fail_code
         FROM messages WHERE conv_id = ?1 ORDER BY seq ASC, id ASC LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![conv_id, limit, offset], |r| {
        Ok(MessageRecord {
            id: r.get(0)?,
            msg_id: r.get(1)?,
            conv_id: r.get(2)?,
            sender_id: r.get(3)?,
            receiver_id: r.get(4)?,
            kind: crate::protocol::display_kind(&r.get::<_, String>(5)?),
            content: r.get(6)?,
            ts: r.get(7)?,
            seq: r.get(8)?,
            status: r.get(9)?,
            mention_targets: decode_mention_targets(r.get(10)?),
                local_id: r.get(11)?,
                fail_code: r.get(12)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 一次拿到**多个会话**里全部的任务行（`todo` / `todo_update`），供前端折叠出徽标数字。
///
/// 为什么只到"取原始行"为止：一条任务的真值是**多写者 LWW**（`(seq, msg_id)` 元组取最新）
/// 加两态排除（完成 / 归档，其中归档还含"完成满 7 天自动归档"），这套折叠语义
/// 今天在前端 `utils/todos.ts::foldTodos` 已经有一份、Rust `latest_todo_def` 有另一份，
/// 再到 SQL 里数一遍就是**第三个真源** —— 那正是本仓反复付学费的漂移形状。
/// 所以这里只负责"把料取回来"，判定仍然只有那一份。
///
/// 走 `idx_messages_conv_kind(conv_id, kind)`（见 `db.rs::ensure_post_schema_shape`）。
pub fn get_todo_messages_for_conns(
    conn: &Connection,
    conv_ids: &[String],
) -> Result<Vec<MessageRecord>> {
    let mut out = Vec::new();
    for conv_id in conv_ids {
        let mut stmt = conn.prepare(
            "SELECT id, msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id, fail_code
             FROM messages WHERE conv_id = ?1 AND kind IN ('todo', 'todo_update')
             ORDER BY seq ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![conv_id], |r| {
            Ok(MessageRecord {
                id: r.get(0)?,
                msg_id: r.get(1)?,
                conv_id: r.get(2)?,
                sender_id: r.get(3)?,
                receiver_id: r.get(4)?,
                kind: crate::protocol::display_kind(&r.get::<_, String>(5)?),
                content: r.get(6)?,
                ts: r.get(7)?,
                seq: r.get(8)?,
                status: r.get(9)?,
            mention_targets: decode_mention_targets(r.get(10)?),
                local_id: r.get(11)?,
                fail_code: r.get(12)?,
            })
        })?;
        out.extend(rows.filter_map(|r| r.ok()));
    }
    Ok(out)
}

/// 取「最新一页」：一次查询拿到会话尾部的 `limit` 条，返回顺序与 `get_messages` 一致（正序）。
///
/// ## 为什么要有这一条而不是用 `get_messages(limit, total - limit)`
/// 后者要先 `COUNT(*)` 才知道 offset ⇒ 冷加载一个会话要打**两次** IPC，而每次都得排队过
/// 全局那把 `Mutex<Connection>`（所有业务共用一个连接）。多出来的那一轮不是"慢一点"，
/// 是用户切到冷会话时**先看到骨架、过一会儿才看到内容**的那半拍。
/// 合成一条还顺带去掉一个窗口：原来 `COUNT` 与取页之间若插进新消息，拿旧 offset 去查新状态
/// 会让这一页**漏掉最底部那几条**（要等下一次重查才出现）。
///
/// ## 顺序
/// `ORDER BY seq DESC, id DESC` 是 `get_messages` 那份全序的镜像，取完再 `reverse()`
/// 回来 —— 判据测试 `db::favorites_tests::latest_page_is_identical_to_the_count_plus_offset_two_step`
/// 逐行比对两者。**不能只用 `seq`**：它是 Lamport 逻辑时钟，双方同时发送时同一会话内
/// 会撞号，`id` 才是那根打破平局的稳定锚。
pub fn get_latest_messages(
    conn: &Connection,
    conv_id: &str,
    limit: i64,
) -> Result<Vec<MessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id, fail_code
         FROM messages WHERE conv_id = ?1 ORDER BY seq DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![conv_id, limit], |r| {
        Ok(MessageRecord {
            id: r.get(0)?,
            msg_id: r.get(1)?,
            conv_id: r.get(2)?,
            sender_id: r.get(3)?,
            receiver_id: r.get(4)?,
            kind: crate::protocol::display_kind(&r.get::<_, String>(5)?),
            content: r.get(6)?,
            ts: r.get(7)?,
            seq: r.get(8)?,
            status: r.get(9)?,
            mention_targets: decode_mention_targets(r.get(10)?),
                local_id: r.get(11)?,
                fail_code: r.get(12)?,
        })
    })?;
    let mut out: Vec<MessageRecord> = rows.filter_map(|r| r.ok()).collect();
    out.reverse();
    Ok(out)
}

/// 预览取源：按 msg_id 返回 (sender_id, content)，供 read_file_preview 定位本地路径
/// 并判定归属（本机的自选文件 / 接收方 downloads 路径），避免命令层直连 rusqlite。
pub fn get_message_preview_source(conn: &Connection, msg_id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT sender_id, content FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 群文件卡片行的原文：`(msg_id, conv_id, content)`，按 msg_id 稳定排序。
///
/// 只有群台账补账作业读它（`network/file/ledger_backfill.rs`）。为什么消息行是那条路的起点：
/// 卡片是 Offer 时插的，而 4.40.8 那次回滚只吞掉了收尾的三张台账 ⇒ **消息行活着**，
/// 它带的 `path`（Done 在事务外回填的）与 `gfile-{transfer_id}` 这个键正好能把台账对回去。
/// 这里只交行，"要不要补、能不能补"全在作业侧判。
pub fn list_gfile_message_rows(conn: &Connection) -> Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT msg_id, conv_id, content FROM messages
         WHERE msg_id LIKE 'gfile-%' ORDER BY msg_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

/// 任务中心（统一后台任务）里"消息还没送到对端"那一类行的读模型。
///
/// 只读派生，不新增表、不新增列。**起点是补发队列本身**（`outbox` / `group_outbox`），
/// 不是 `messages.status` —— 两条理由：
///  1. 队列两张表只装"还没送到"的行 ⇒ 天然有界，`ORDER BY created_at DESC LIMIT n` 走的
///     就是既有的 `idx_outbox_created` / `idx_group_outbox_created`。反过来从
///     `messages WHERE status='sending'` 起查要扫全历史，而这条查询排在全局那一把
///     `Mutex<Connection>` 后面 —— 同一个形状在 `idx_messages_conv_kind` 的注释里记过账。
///  2. "还在队列里"就是用户真正在等的事实（字节还没离开本机链路）；而 `status='sending'`
///     还包含"已写出、等 ACK"那一格 —— 那一格今天**没有可执行动作**（消息取消在 B4），
///     列出来只会多一行点不动的任务（计划里那条"不在 UI 造假任务"）。
#[derive(Clone, Debug, serde::Serialize)]
pub struct PendingMessageOp {
    /// 稳定 id：前端按它去重，B4 的撤回/取消也按它下发。
    pub msg_id: String,
    /// 1:1 时是对方 device_id（本仓里它同时就是 conv_id）；群消息为 `None`。
    pub peer_id: Option<String>,
    /// 群消息的群 id；1:1 为 `None`。
    pub group_id: Option<String>,
    pub kind: String,
    /// 还没收到的成员数：1:1 恒为 1；群消息是仍留在队列里的成员数（已送达的成员不在表里）。
    pub waiting_for: i64,
    pub created_at: i64,
    /// 只有 `text` / `code` 给正文截断；其它 kind 的 `content` 是 JSON 载荷，
    /// 宁可不给 —— 把机器格式直接上屏等于让界面说胡话，让调用方按 kind 说类型。
    pub preview: Option<String>,
    /// 这一刻**没有可用链路**通向这个对端 ⇒ 任务中心要说"对方离线"，不能说"发送中"。
    /// 数据库侧一律给 `false`：链路是内存里的事实，只有命令层（`has_link`）能填。
    /// 与 `file_transfers` 那条 `blocked_reason='peer_offline'` 同一口径 ——
    /// "离线"这个判断只此一个出处，不在前端按 `peers` 列表再猜一遍。
    pub peer_offline: bool,
    /// 这一行**现在点取消会不会成功**（与 `cancel_queued_message` 同一判据：
    /// 消息状态还没到 `delivered/read/recalled/cancelled`）。
    /// 为什么不让前端自己猜：群消息只要**任一成员** Ack 过就会把消息状态推成
    /// `delivered`，但其余成员的队列行还在 ⇒ 任务中心仍该列出"还有几个人没收到"，
    /// 而取消已经被后端拒绝。界面给一颗点了一定弹"已送达，不能取消"的按钮，
    /// 用户看到的就是「明明还在排队，为什么说已送达」（2026-10-25 实报）。
    pub can_cancel: bool,
    /// 群消息：已经至少有一个成员确认收到（消息状态 delivered/read），但队列里还有人。
    /// 界面据此把状态写成「部分成员已收到」，而不是泛泛的「排队中」。
    pub some_delivered: bool,
}

/// 一次读取的条数上限：队列行数本身有界（离线保留 7 天），这个数只是防止
/// "任务中心一次拉走一整段离线历史"把锁握住太久。
pub const MESSAGE_OPS_LIMIT: i64 = 200;

/// 预览的字符窗口：比要显示的字符数**多一个**。SQLite 的 `substr()` 对 TEXT 值是按
/// **字符**计数的（不是字节），所以这里不需要"按字节切再怕切半个字"那套；
/// 多出来的那一个字符只用来判断"后面还有没有"，据此补省略号。
/// （实测路径：`message_ops_tests::a_multibyte_message_is_truncated_by_characters_not_bytes`
/// —— 若 `substr` 真按字节，取回的半字符会让 rusqlite 报错，那一行会整个从列表里消失。）
const PREVIEW_CHAR_WINDOW: i64 = 41;
const PREVIEW_MAX_CHARS: usize = 40;

/// 只有人能直接读的两种 kind 才给截断；其余 kind 的 `content` 是 JSON 载荷 ⇒ 返回 `None`，
/// 由界面按 kind 说类型（把 `{"items":…` 直接上屏等于让界面说胡话）。
fn text_preview(kind: &str, content: Option<&str>) -> Option<String> {
    if kind != "text" && kind != "code" {
        return None;
    }
    let raw = content?;
    let mut chars = raw.chars();
    let head: String = chars.by_ref().take(PREVIEW_MAX_CHARS).collect();
    if chars.next().is_some() {
        Some(format!("{head}…"))
    } else {
        Some(head)
    }
}

/// 还没送达的消息行（1:1 + 群），按入队时间倒序，总量受 `limit` 约束。
pub fn list_pending_message_operations(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<PendingMessageOp>> {
    let mut ops: Vec<PendingMessageOp> = Vec::new();

    let mut dm = conn.prepare(
        // 终态的消息不该再挂着一行队列：`ack_delivered` 是「置 delivered + 删行」同一事务，
        // 但历史库/旧版本可能留下"状态已 delivered、outbox 还在"的孤儿（用户看到一条永远
        // 取消不掉、进度也不动的任务）。这里按状态把它滤掉；**消息行整体缺失**的孤儿
        // 仍要列出（`a_queue_row_without_its_message_row_is_still_listed`），那是另一类真实故障。
        "SELECT o.msg_id, o.peer_id,
                COALESCE(m.kind, 'text'),
                substr(m.content, 1, ?2),
                o.created_at,
                m.status
         FROM outbox o LEFT JOIN messages m ON m.msg_id = o.msg_id
         WHERE COALESCE(m.status, 'sending')
               NOT IN ('delivered', 'read', 'recalled', 'cancelled', 'partial_cancelled')
         ORDER BY o.created_at DESC LIMIT ?1",
    )?;
    let dm_rows = dm.query_map(params![limit, PREVIEW_CHAR_WINDOW], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })?;
    for row in dm_rows.flatten() {
        let (msg_id, peer_id, kind, content, created_at, status) = row;
        let preview = text_preview(&kind, content.as_deref());
        ops.push(PendingMessageOp {
            msg_id,
            peer_id: Some(peer_id),
            group_id: None,
            kind,
            waiting_for: 1,
            created_at,
            preview,
            peer_offline: false,
            // 被上面的 WHERE 过滤后，唯一不可取消的只剩"消息行根本没了的孤儿队列行"：
            // 后端取消会回 NotFound，界面不该给一颗注定失败的按钮。
            can_cancel: status.is_some(),
            some_delivered: false,
        });
    }

    let mut grp = conn.prepare(
        // 群消息：只列**还有 pending 行**的消息。任一成员 Ack 会被台账记成 delivered，
        // 其余成员仍在队列里 ⇒ 这类行仍要列（"还有 N 人没收到"是真实事实），
        // 并且**可以取消剩余成员**（`can_cancel = waiting_for > 0`）。
        // ⚠️ 不能再用 `WHERE g.status = 'pending'`：那样 delivered 行会被 WHERE 过滤掉，
        // 下面的 `SUM(delivered)` 恒为 0，`some_delivered` 就永远是假的（10-25 复审抓出）。
        "SELECT g.msg_id, g.group_id,
                COALESCE(SUM(CASE WHEN g.status = 'pending' THEN 1 ELSE 0 END), 0) AS waiting,
                COALESCE(MAX(CASE WHEN g.status = 'pending' THEN g.created_at END),
                         MAX(g.created_at)),
                COALESCE(m.kind, 'text'),
                substr(m.content, 1, ?2),
                m.status,
                COALESCE(SUM(CASE WHEN g.status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered
         FROM group_outbox g LEFT JOIN messages m ON m.msg_id = g.msg_id
         WHERE COALESCE(m.status, 'sending')
               NOT IN ('cancelled', 'partial_cancelled', 'recalled', 'read')
         GROUP BY g.msg_id, g.group_id
         HAVING waiting > 0
         ORDER BY 4 DESC LIMIT ?1",
    )?;
    let grp_rows = grp.query_map(params![limit, PREVIEW_CHAR_WINDOW], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;
    for row in grp_rows.flatten() {
        let (msg_id, group_id, waiting_for, created_at, kind, content, status, delivered) = row;
        let preview = text_preview(&kind, content.as_deref());
        ops.push(PendingMessageOp {
            msg_id,
            peer_id: None,
            group_id: Some(group_id),
            kind,
            waiting_for,
            created_at,
            preview,
            peer_offline: false,
            // 有 pending 行且消息行存在 ⇒ 后端可以取消剩余成员。
            can_cancel: status.is_some(),
            some_delivered: delivered > 0,
        });
    }

    // 两个队列各按自己的时间倒序取过前 `limit` 条，合并后必须再按全局时间倒序截一次，
    // 否则"最近 200 条"会变成"最近的 200 条单聊 + 最近的 200 条群聊"（口径不同）。
    ops.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.msg_id.cmp(&b.msg_id)));
    ops.truncate(limit.max(0) as usize);
    Ok(ops)
}

#[cfg(test)]
mod message_ops_tests {
    use super::*;
    use crate::db::SCHEMA;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn ins_msg(conn: &Connection, msg_id: &str, conv: &str, kind: &str, content: &str, ts: i64) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, ?2, 'me', 'peer', ?3, ?4, ?5, 1, 'sending')",
            params![msg_id, conv, kind, content, ts],
        )
        .unwrap();
    }

    fn ins_dm(conn: &Connection, msg_id: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1,'p1','{}',?2)",
            params![msg_id, created_at],
        )
        .unwrap();
    }

    fn ins_group(conn: &Connection, msg_id: &str, member: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES(?1,'g1',?2,'{}',?3)",
            params![msg_id, member, created_at],
        )
        .unwrap();
    }

    /// 两条队列都要被看见，群消息按"还剩几个人"说话。
    #[test]
    fn pending_message_ops_cover_both_queues_and_count_group_waiters() {
        let conn = mem();
        ins_msg(&conn, "m1", "p1", "text", "晚上七点老地方见", 10);
        ins_dm(&conn, "m1", 11);
        ins_msg(&conn, "m2", "group:g1", "merge", "{\"items\":[]}", 20);
        ins_group(&conn, "m2", "b", 21);
        ins_group(&conn, "m2", "c", 21);
        // 已送达的成员（d）的台账行是 delivered 墓碑：不参与 waiting，但要能数出来
        conn.execute(
            "UPDATE group_outbox SET status = 'delivered'
              WHERE msg_id = 'm2' AND peer_id = 'c'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at, status)
             VALUES('m2', 'g1', 'd', '{}', 21, 'delivered')",
            [],
        )
        .unwrap();

        let ops = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        assert_eq!(ops.len(), 2, "一条单聊 + 一条群聊");
        let dm = ops.iter().find(|o| o.msg_id == "m1").unwrap();
        assert_eq!(dm.peer_id.as_deref(), Some("p1"), "1:1 的目标是对端");
        assert!(dm.group_id.is_none());
        assert_eq!(dm.waiting_for, 1, "1:1 恒为一个人在等");
        assert_eq!(dm.preview.as_deref(), Some("晚上七点老地方见"), "文本给正文截断");
        assert!(dm.can_cancel, "还在队列里的单聊行必须可取消");
        assert!(!dm.some_delivered, "单聊没有「部分成员」这回事");

        let grp = ops.iter().find(|o| o.msg_id == "m2").unwrap();
        assert_eq!(grp.group_id.as_deref(), Some("g1"), "群消息的目标是群");
        assert!(grp.peer_id.is_none(), "群消息没有单个对端（按成员各自一行队列）");
        assert_eq!(grp.waiting_for, 1, "只剩 b 一个人没收到（c/d 已是 delivered）");
        assert!(grp.can_cancel, "还有 pending 行 ⇒ 取消剩余成员必须成立");
        assert!(grp.some_delivered, "c/d 的 delivered 行必须被数出来（不能恒为 false）");
        assert!(
            grp.preview.is_none(),
            "merge 的 content 是 JSON 载荷 ⇒ 宁可不给，让界面按 kind 说类型，别把机器格式上屏"
        );
    }

    /// 群消息只要一个成员 Ack，消息状态就变 `delivered`，但其余成员的台账行还是 pending。
    ///
    /// 2026-10-25 用户实报：任务中心给这种行一颗「取消」，点了必弹「已送达，不能取消」，
    /// 而行上还写着「排队中」—— 状态与底层事实对不上。
    /// 修法不是隐藏按钮，而是让取消真的成立：只停剩余成员的 pending 行，消息落
    /// `partial_cancelled`，已收下的成员原样保留（这就是「部分已发送，可补发」）。
    #[test]
    fn group_partial_delivery_is_listed_and_the_rest_can_be_cancelled() {
        let conn = mem();
        ins_msg(&conn, "gm", "group:g1", "text", "群里等回复", 10);
        conn.execute("UPDATE messages SET status='delivered' WHERE msg_id='gm'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at, status)
             VALUES('gm', 'g1', 'a', '{}', 10, 'delivered')",
            [],
        )
        .unwrap();
        ins_group(&conn, "gm", "b", 11);

        let ops = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        let row = ops.iter().find(|o| o.msg_id == "gm").unwrap();
        assert_eq!(row.waiting_for, 1, "还剩 1 个成员没收到");
        assert!(row.can_cancel, "还有 pending 行 ⇒ 取消必须成立（旧实现答「已送达」是真缺陷）");
        assert!(row.some_delivered, "状态要能说「部分成员已收到」");

        assert_eq!(
            cancel_queued_group_message(&conn, "gm").unwrap(),
            crate::db::GroupMessageCancelOutcome::PartiallyCancelled {
                delivered: 1,
                cancelled: 1
            }
        );
        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id='gm'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "partial_cancelled");
        assert!(
            list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT)
                .unwrap()
                .is_empty(),
            "取消之后就没有 pending 行，任务中心必须清掉这一行"
        );
    }

    /// 1:1 的终态消息不该再挂着补发队列行（历史库/旧版本留下的孤儿）：
    /// 它会变成一条永远取消不掉、进度也不动的任务。消息行整体缺失的孤儿另算（下面那条）。
    #[test]
    fn delivered_dm_with_stale_outbox_row_is_not_listed() {
        let conn = mem();
        ins_msg(&conn, "dm", "p1", "text", "已经送达", 10);
        conn.execute("UPDATE messages SET status='delivered' WHERE msg_id='dm'", [])
            .unwrap();
        ins_dm(&conn, "dm", 11);
        let ops = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        assert!(ops.is_empty(), "状态已终态的单聊行必须从任务列表里消失");
    }

    /// 队列行存在但消息行不见了（孤儿队列行）也必须列出来 —— 那正是"发不出去又没人收"的形状。
    #[test]
    fn a_queue_row_without_its_message_row_is_still_listed() {
        let conn = mem();
        ins_dm(&conn, "orphan", 30);
        let ops = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        assert_eq!(ops.len(), 1, "消息行没了也要看得见这条还堵着");
        assert_eq!(ops[0].kind, "text", "读不到 kind 时退回最中性的取值，不编一个图标");
        assert!(ops[0].preview.is_none(), "没有正文可给");
        assert!(!ops[0].can_cancel, "取消命令会回 NotFound，不许给一颗注定失败的按钮");
    }

    /// 合并后的排序与截断必须是**全局**的：各队列自己取前 N 条再拼起来，
    /// 得到的不是"最近 N 条"，而是"最近 N 条单聊 + 最近 N 条群聊"。
    #[test]
    fn merge_sorts_and_truncates_globally_not_per_queue() {
        let conn = mem();
        for (id, ts) in [("d1", 100), ("d2", 300)] {
            ins_msg(&conn, id, "p1", "text", "x", ts);
            ins_dm(&conn, id, ts);
        }
        ins_msg(&conn, "g1m", "group:g1", "text", "y", 200);
        ins_group(&conn, "g1m", "b", 200);

        let all = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        assert_eq!(
            all.iter().map(|o| o.created_at).collect::<Vec<_>>(),
            vec![300, 200, 100],
            "两条队列合起来按时间倒序"
        );
        let top2 = list_pending_message_operations(&conn, 2).unwrap();
        assert_eq!(
            top2.iter().map(|o| o.msg_id.as_str()).collect::<Vec<_>>(),
            vec!["d2", "g1m"],
            "limit 截的是全局最近的行"
        );
        assert!(
            list_pending_message_operations(&conn, 0).unwrap().is_empty(),
            "limit=0 必须是空集，不能忽略参数返回全量"
        );
    }

    /// 截断按**字符**不按字节 —— 这条同时是 SQLite 语义的证明：
    /// 若 `substr` 按字节，窗口 41 会落在第 14 个汉字中间，取回的值不是合法 UTF-8，
    /// rusqlite 读 `String` 直接报错，而调用方 `flatten()` 会把 Err 吞掉
    /// ⇒ 这一行**整个从任务列表里消失**（用户看到的"任务不见了"就是这么来的）。
    #[test]
    fn a_multibyte_message_is_truncated_by_characters_not_bytes() {
        let conn = mem();
        let long = "测".repeat(120); // 360 字节、120 字符
        ins_msg(&conn, "m-long", "p1", "text", &long, 40);
        ins_dm(&conn, "m-long", 40);
        let ops = list_pending_message_operations(&conn, MESSAGE_OPS_LIMIT).unwrap();
        assert_eq!(ops.len(), 1, "长中文消息不许因为截断方式而从列表里消失");
        let p = ops[0].preview.clone().unwrap_or_default();
        assert_eq!(
            p.chars().count(),
            PREVIEW_MAX_CHARS + 1,
            "恰好 40 个字 + 一个省略号（窗口取 41 是为了知道「后面还有没有」）：{p:?}"
        );
        assert!(p.ends_with('…'), "被截断必须说出来，不能看起来像原文：{p:?}");
        assert!(
            !p.contains('\u{FFFD}'),
            "不该出现替换符（出现了就说明切在字符中间）：{p:?}"
        );
    }
}


/// 按 msg_id 取完整消息记录（需要跨字段判断时用；今天只有 `network/file/receive.rs::resume_receive` 认领续传用它）。
pub fn get_message_record(conn: &Connection, msg_id: &str) -> Option<MessageRecord> {
    conn.query_row(
        "SELECT id, msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id, fail_code
         FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| {
            Ok(MessageRecord {
                id: r.get(0)?,
                msg_id: r.get(1)?,
                conv_id: r.get(2)?,
                sender_id: r.get(3)?,
                receiver_id: r.get(4)?,
                kind: crate::protocol::display_kind(&r.get::<_, String>(5)?),
                content: r.get(6)?,
                ts: r.get(7)?,
                seq: r.get(8)?,
                status: r.get(9)?,
            mention_targets: decode_mention_targets(r.get(10)?),
                local_id: r.get(11)?,
                fail_code: r.get(12)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// 收藏取源：按 msg_id 返回 `(sender_id, kind, content, ts)`。
///
/// 收藏的**内容一律以库里的消息为准**（前端只传 msg_id）：如果让前端把 content 传上来，
/// 收藏夹里就可能存进一份与消息记录不一致的副本，而"收藏"最不该做的事就是记录失真。
pub fn get_favorite_source(
    conn: &Connection,
    msg_id: &str,
) -> Option<(String, String, String, i64)> {
    conn.query_row(
        "SELECT sender_id, kind, content, ts FROM messages WHERE msg_id = ?1",
        params![msg_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 更新单条消息状态。**硬终态不可逆**：`read`（已读回执）、`delivered`（Ack）、
/// `recalled`（被撤回）一旦写入，任何后续 set 都会被拒绝。
///
/// 注意：`failed` 和 `cancelled` 是**软终态**，所以它们**不在** NOT IN 里 ——
/// outbox 补发成功要把 `failed` 往前推成 `sent`，卡在 failed 的行还要能被清扫器扫到。
/// （原先写在这里的理由「可通过 resend_message 回到 sending」已失效：那条命令 2026-09-25 删了。）
///
/// 典型竞态：Ack 因 outbox 补发晚于 ReadReceipt 到达，`read` 不能被回退成 `delivered`。
///
/// 返回**实际改动的行数**（SOL-03 / FUNC-03）：调用方据此区分"真的推进了这一行"与
/// "查无此处/已被硬终态挡住"。旧签名只给 `Result<()>`，无匹配行也是 `Ok`，
/// 于是取消路径会把"没有气泡可写"误读成"写成功了"，进而在 `upsert_transfer` 里
/// 凭空插出一条幽灵台账行。
///
/// ⚠️ `cancelled` / `partial_cancelled` / `failed` 也是**不可被迟到写撤销**的终态：
/// 发送路径在 `has_link` 与 `try_send` 之间可插入取消命令，取消先落地（状态 + 队列行同事务）
/// 之后，那一臂的 `set_message_status("sent")` 若不排掉 `cancelled`，就会把「用户已取消」
/// 静默改回「已发送」——而队列行已被取消路径删掉，消息**永远不会再发**（outbox_flush 只扫
/// 队列表），界面却显示已发出。`failed` 同理：它已由清扫器收口，迟到写不许把它推回 `sent`。
/// 重发链走 `requeue_message_for_resend`（同一事务把状态推到 `sending`）⇒ 不受这条影响。
///
/// 守卫只有一份（`status NOT IN (...)`），两扇门共用：
///  · [`set_message_status`] —— 只推进状态，**把原因码归零**（新的状态没有"上次为什么失败"要说）；
///  · [`set_message_failed`] —— 落 `failed` 并**同时写下原因**。
///
/// 为什么归零放在通用那扇门里：一条曾经失败过的行可以经重发回到 `sent`，
/// 如果旧码留在行上，之后任何一次"没有码的失败"都会把**上一次的**原因念给用户。
pub fn set_message_status(conn: &Connection, msg_id: &str, status: &str) -> Result<usize> {
    set_message_status_with_code(conn, msg_id, status, None)
}

/// 落 `failed` **并带上原因码**（DB v14→v15）。词表 = `error_codes::MESSAGE_FAIL_CODES`。
///
/// 带原因的失败只有这一个出口：`status = 'failed'` 与 `fail_code` 必须同一行同一次写落地，
/// 分开写就会造出"显示着原因、其实那次失败没记原因"的行（界面读的是这一对，不是各自单独）。
pub fn set_message_failed(conn: &Connection, msg_id: &str, code: &str) -> Result<usize> {
    set_message_status_with_code(conn, msg_id, "failed", Some(code))
}

fn set_message_status_with_code(
    conn: &Connection,
    msg_id: &str,
    status: &str,
    fail_code: Option<&str>,
) -> Result<usize> {
    let rows = conn.execute(
        "UPDATE messages SET status = ?2, fail_code = ?3
         WHERE msg_id = ?1
           AND status NOT IN ('read', 'delivered', 'recalled',
                              'cancelled', 'partial_cancelled', 'failed')",
        params![msg_id, status, fail_code],
    )?;
    Ok(rows)
}

/// 过期消息 outbox 落终态：置 `failed`（原因 = 重试窗口耗尽）+ 删队列行，**同一事务**。
///
/// 为什么必须原子（审计 P1 #6）：两步分开写时，"状态写成 failed、删行失败"会留下
/// 「界面已判失败、队列行还在」—— 而 `outbox_flush` 只看队列表、不看 messages.status ⇒
/// 这条"已失败"的消息**继续被补发**，对方确实收到了，界面却显示失败，且不可自愈。
/// 顺序也保留原语义：状态写失败就不删行（否则行没了、状态还是 sending，两个清扫器都看不见）。
pub fn finalize_expired_message(
    conn: &Connection,
    msg_id: &str,
    group: bool,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    set_message_failed(&tx, msg_id, crate::error_codes::SEND_RETRY_EXPIRED)?;
    // 复用既有的删行实现（不要在这里写第二份 SQL）：`Transaction` 解引用到 `Connection`。
    // 队列行本来就不在时它们同样是成功（幂等）。
    if group {
        delete_group_outbox_by_msg_id(&tx, msg_id)?;
    } else {
        delete_outbox_by_msg_id(&tx, msg_id)?;
    }
    tx.commit()?;
    Ok(())
}

/// 取消一条**还在补发队列里**的消息（用户按「取消发送」）。
///
/// 三件事在**同一个事务**里：把状态写成 `cancelled`、删掉 outbox 行、返回结论。
/// 顺序与 `ack_delivered`（置 delivered + 删行）互斥：两边都靠"队列行还在不在"仲裁 ——
/// 谁先拿到这把锁，谁的结果成立；**删掉行之后**，晚到的 Ack 在 `ack_delivered` 里
/// `expected == false` ⇒ 直接返回 false，不会把 `cancelled` 提升成 `delivered`。
/// 这就是"取消是硬终态"在这张表上的落地方式（INV-P26 的第二个来源，与文件的墓碑同口径）。
///
/// 为什么不是 `set_message_status` 一把梭：那条只改状态、不删队列行 ⇒ 下一轮 flush
/// 照样把它发出去（用户看到"已取消"却又送到了）。队列行才是"还没送达"的那件事实。
#[derive(Debug, PartialEq, Eq)]
pub enum MessageCancelOutcome {
    /// 这次真的取消掉了（状态改写 + 队列行删除，至少一处生效）。
    Cancelled,
    /// 已经送达/已读/已撤回 ⇒ 取消不成立，界面要说实话。
    AlreadyDelivered,
    /// 查无此消息。
    NotFound,
}

pub fn cancel_queued_message(conn: &Connection, msg_id: &str) -> Result<MessageCancelOutcome> {
    let tx = conn.unchecked_transaction()?;
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Ok(MessageCancelOutcome::NotFound);
    };
    if matches!(status.as_str(), "delivered" | "read" | "recalled") {
        return Ok(MessageCancelOutcome::AlreadyDelivered);
    }
    // 队列行必须在**状态之前**删：先写 cancelled 再删的话，中间那一刻的 Ack 仍能命中
    // outbox 行并把状态推成 delivered（两把锁之间没有别的事务，但顺序让结论更难读）。
    tx.execute("DELETE FROM outbox WHERE msg_id = ?1", params![msg_id])?;
    let changed = tx.execute(
        "UPDATE messages SET status = 'cancelled'
          WHERE msg_id = ?1
            AND status NOT IN ('delivered', 'read', 'recalled', 'cancelled')",
        params![msg_id],
    )?;
    tx.commit()?;
    // 已经是 cancelled（重复点）也算成功：幂等，界面上它就是"已取消"。
    let _ = changed;
    Ok(MessageCancelOutcome::Cancelled)
}

/// 重发一条**本端判失败/被用户取消**的 1:1 消息：重新入队并回到 `sending`。
///
/// 与「发一条新消息」的分界（计划 D1）：**复用原 `msg_id` / `ts` / `seq`**。
/// · 复用 `msg_id` ⇒ 接收端按它去重：如果上一次其实已经送到、只是 Ack 在半开链路上丢了，
///   对方会**再回一次 Ack** 而不是多出一条消息（这就是幂等的全部意义）。
/// · 复用 `ts`/`seq` ⇒ 重发不会把一条旧消息顶到会话最底、也不会打乱对方的时间线。
///
/// 为什么整段一个事务：`outbox` 行与 `sending` 必须同时成立。先写状态再插行，中间失败
/// 就留下「sending 但队列里没有行」的孤儿（清扫器看不见、flush 也没得补 ⇒ 永久发送中，
/// 2026-10-20 P0 同型）。先把行插入、状态写不上时整体回滚，界面仍是 failed/cancelled。
///
/// 返回**状态行实际改动数**：0 = 这条当前不是 failed/cancelled（已送达/已读/已撤回/
/// 正在发），调用方据此如实回答而不是假装重发成功。
pub fn requeue_message_for_resend(
    conn: &Connection,
    msg_id: &str,
    peer_id: &str,
    payload: &str,
) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Ok(0);
    };
    if !matches!(status.as_str(), "failed" | "cancelled") {
        return Ok(0);
    }
    // `INSERT OR IGNORE`：极少数情况下队列行还在（比如心跳 flush 与重发同时到达），
    // 直接复用它、不产生第二行（`outbox.msg_id` 是内联 UNIQUE）。
    tx.execute(
        "INSERT OR IGNORE INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![msg_id, peer_id, payload, now_ms()],
    )?;
    let changed = tx.execute(
        "UPDATE messages SET status = 'sending'
          WHERE msg_id = ?1 AND status IN ('failed', 'cancelled')",
        params![msg_id],
    )?;
    tx.commit()?;
    Ok(changed)
}

/// Ack 的**原子收尾**：验证 Ack 确实命中"我发给这个 peer 且仍在队列里"的那一行，
/// 置 `delivered`，再删 outbox 行 —— 三步在**同一个事务**里完成。
///
/// 为什么必须是事务（2026-10-20 P0「消息永久发送中」）：
/// 旧实现是 `set_message_status(...).ok(); DELETE ... .ok();` 两条独立写、错误全吞。
/// 只要第一条失败、第二条成功，就留下「outbox 行没了、状态还是 sending」的孤儿：
/// sweeper 只扫 outbox 表 ⇒ 再也看不见它；flush 也没有可重发的行 ⇒ 界面永久发送中。
/// 事务保证要么 delivered+删行、要么两者都不动；失败时 outbox 行保留，下一次补发
/// 会再次收到 Ack 并重试收尾。
///
/// 返回 `Ok(false)` = 没有命中期望 peer 的队列行（不是给我的 Ack / 已收尾过），
/// 调用方不得据此 emit `message-acked`。
pub fn ack_delivered(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let expected = tx
        .query_row(
            "SELECT 1 FROM outbox WHERE msg_id = ?1 AND peer_id = ?2",
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
    tx.execute("DELETE FROM outbox WHERE msg_id = ?1", params![msg_id])?;
    tx.commit()?;
    Ok(true)
}

/// 应用一次渲染切换：LWW per `msg_id`，旧事件不覆盖新事件。
///
/// `messages.kind` 是物化视图；`message_render` 表保存最后一次生效的 seq，供迟到/重投判断。
pub fn apply_message_render(
    conn: &Connection,
    msg_id: &str,
    event_seq: i64,
    mode: &str,
) -> Result<bool> {
    if mode != "code" && mode != "text" {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "INSERT INTO message_render(msg_id, seq, mode) VALUES(?1, ?2, ?3)
         ON CONFLICT(msg_id) DO UPDATE SET seq = excluded.seq, mode = excluded.mode
         WHERE excluded.seq > message_render.seq",
        params![msg_id, event_seq, mode],
    )? > 0;
    let mut updated = 0usize;
    if changed {
        updated = tx.execute(
            "UPDATE messages SET kind = ?2 WHERE msg_id = ?1 AND kind != 'recalled'",
            params![msg_id, mode],
        )?;
    }
    tx.commit()?;
    // 只有 messages 真的改了才算“生效”：已撤回消息的 render 事件不得让前端把墓碑复活。
    Ok(updated > 0)
}

#[cfg(test)]
mod message_render_tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn seed(conn: &Connection, msg_id: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'peer-a', 'me', 'peer-a', 'text', 'code-like', 1, 1, 'sent')",
            params![msg_id],
        )
        .unwrap();
    }

    fn kind(conn: &Connection, msg_id: &str) -> String {
        conn.query_row(
            "SELECT kind FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn render_lww_only_applies_newer_events() {
        let conn = db();
        seed(&conn, "r1");
        assert!(apply_message_render(&conn, "r1", 10, "code").unwrap());
        assert_eq!(kind(&conn, "r1"), "code");

        assert!(
            !apply_message_render(&conn, "r1", 9, "text").unwrap(),
            "迟到的旧事件不得把渲染翻回去"
        );
        assert_eq!(kind(&conn, "r1"), "code");

        assert!(apply_message_render(&conn, "r1", 11, "text").unwrap());
        assert_eq!(kind(&conn, "r1"), "text");

        assert!(
            !apply_message_render(&conn, "r1", 12, "image").unwrap(),
            "只允许 code/text 两种渲染方式"
        );

        // 已撤回的墓碑不能被 render 事件复活（UPDATE 0 行 ⇒ 不得 emit）。
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES('r2', 'peer-a', 'me', 'peer-a', 'recalled', '', 1, 1, 'sent')",
            [],
        )
        .unwrap();
        assert!(!apply_message_render(&conn, "r2", 20, "code").unwrap());
        assert_eq!(kind(&conn, "r2"), "recalled");
    }
}

#[cfg(test)]
mod ack_delivery_tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn seed(conn: &Connection, msg_id: &str, peer: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, ?2, 'me', ?2, 'text', 'x', 1, 1, 'sending')",
            params![msg_id, peer],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, '{}', 1)",
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

    fn outbox_rows(conn: &Connection, msg_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM outbox WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn seed_group(conn: &Connection, msg_id: &str, peer: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'group:g', 'me', 'g', 'text', 'x', 1, 1, 'sending')",
            params![msg_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_outbox(msg_id, group_id, peer_id, payload, created_at)
             VALUES(?1, 'g', ?2, '{}', 1)",
            params![msg_id, peer],
        )
        .unwrap();
    }

    fn group_outbox_rows(conn: &Connection, msg_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM group_outbox WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn ack_marks_delivered_and_clears_only_the_expected_peer_row() {
        let conn = db();
        seed(&conn, "m1", "peer-a");
        assert!(ack_delivered(&conn, "m1", "peer-a").unwrap());
        assert_eq!(status(&conn, "m1"), "delivered");
        assert_eq!(outbox_rows(&conn, "m1"), 0);

        // 不匹配的 peer ⇒ 什么都不动（防伪造 Ack 探测/误删）
        seed(&conn, "m2", "peer-a");
        assert!(!ack_delivered(&conn, "m2", "peer-b").unwrap());
        assert_eq!(status(&conn, "m2"), "sending");
        assert_eq!(outbox_rows(&conn, "m2"), 1);

        // 群聊同一纪律：状态与 group_outbox 行同事务收尾，且只认命中的成员。
        // 2026-10-25 起行不再删掉，而是条件置 delivered；全部送达后变成墓碑被即时清理。
        seed_group(&conn, "gm1", "peer-a");
        assert_eq!(
            ack_group_delivered(&conn, "gm1", "peer-a").unwrap(),
            GroupAckOutcome::Applied
        );
        assert_eq!(status(&conn, "gm1"), "delivered");
        assert_eq!(group_outbox_rows(&conn, "gm1"), 0);

        seed_group(&conn, "gm2", "peer-a");
        assert_eq!(
            ack_group_delivered(&conn, "gm2", "peer-b").unwrap(),
            GroupAckOutcome::Duplicate,
            "不匹配的成员 = 攻击面：只读不写，也不许 emit"
        );
        assert_eq!(status(&conn, "gm2"), "sending");
        assert_eq!(group_outbox_rows(&conn, "gm2"), 1);
    }

    /// 重复 Ack / 迟到 Ack 必须**幂等且不改判**（2026-10-20 验收补，2026-10-25 改为台账口径）。
    ///
    /// 调用方只在 `Applied` 时 emit `group-message-acked`，所以"第二次 Ack 返回 Duplicate"
    /// 就是"前端不会收到第二条已送达事件"的唯一保证；这里把它钉在 DB 层。
    /// 场景覆盖：重复 Ack（同 peer）、群聊重复 Ack、以及**已被清扫判失败**的消息收到迟到 Ack
    /// —— 失败行仍在台账里（不删），迟到 Ack 只改行（`LateApplied`），不改消息状态。
    #[test]
    fn duplicate_and_late_acks_are_idempotent_and_never_change_the_verdict() {
        let conn = db();
        // ① 重复 Ack（1:1）：第二次没有队列行可命中 ⇒ false，状态不回退、不重复 emit。
        seed(&conn, "m1", "peer-a");
        assert!(ack_delivered(&conn, "m1", "peer-a").unwrap());
        assert!(!ack_delivered(&conn, "m1", "peer-a").unwrap(), "重复 Ack 必须返回 false");
        assert_eq!(status(&conn, "m1"), "delivered");
        assert_eq!(outbox_rows(&conn, "m1"), 0);

        // ② 重复 GroupAck：群语义是"任一成员首个 Ack 推进 delivered"，后续成员/重复都幂等。
        seed_group(&conn, "gm1", "peer-a");
        assert_eq!(
            ack_group_delivered(&conn, "gm1", "peer-a").unwrap(),
            GroupAckOutcome::Applied
        );
        assert_eq!(
            ack_group_delivered(&conn, "gm1", "peer-a").unwrap(),
            GroupAckOutcome::Duplicate
        );
        assert_eq!(status(&conn, "gm1"), "delivered");
        assert_eq!(group_outbox_rows(&conn, "gm1"), 0);

        // ③ 迟到 Ack：清扫器已判 failed 并删队列行（见 outbox_sweep 的顺序），
        //    此时再来的 Ack 既不能改判、也不该被当成"还能重发"。
        seed(&conn, "m4", "peer-a");
        conn.execute(
            "UPDATE messages SET status = 'failed' WHERE msg_id = 'm4'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM outbox WHERE msg_id = 'm4'", [])
            .unwrap();
        assert!(
            !ack_delivered(&conn, "m4", "peer-a").unwrap(),
            "队列行已随终态删除 ⇒ 迟到 Ack 没有命中对象"
        );
        assert_eq!(
            status(&conn, "m4"),
            "failed",
            "没有队列行的迟到 Ack 不许把已判失败的消息改回送达"
        );
        assert_eq!(outbox_rows(&conn, "m4"), 0);
    }

    /// 半状态回归：删队列行失败时，**状态绝不能已经前进**。
    ///
    /// 用 SQLite 触发器让 DELETE 必然 ABORT，模拟"I/O 错误发生在第二步"。
    /// 旧实现下这里会留下 delivered + outbox 还在；更糟的失败组合（第一步失败、
    /// 第二步成功）会留下 sending + 无队列行 —— 那正是"永久发送中"的形状。
    #[test]
    fn ack_rolls_back_the_status_when_outbox_delete_fails() {
        let conn = db();
        seed(&conn, "m3", "peer-a");
        conn.execute_batch(
            "CREATE TRIGGER block_outbox_delete BEFORE DELETE ON outbox
             BEGIN SELECT RAISE(ABORT, 'simulated io failure'); END;",
        )
        .unwrap();

        assert!(ack_delivered(&conn, "m3", "peer-a").is_err());
        assert_eq!(
            status(&conn, "m3"),
            "sending",
            "删行失败却把状态写成 delivered（或任何前进值）= 收尾半状态"
        );
        assert_eq!(outbox_rows(&conn, "m3"), 1, "失败时队列行必须保留可重试");

        // 群聊反控：group_outbox 删行失败时，事务必须把 delivered 一起回滚。
        seed_group(&conn, "gm3", "peer-a");
        conn.execute_batch(
            "CREATE TRIGGER block_group_outbox_delete BEFORE DELETE ON group_outbox
             BEGIN SELECT RAISE(ABORT, 'simulated io failure'); END;",
        )
        .unwrap();
        assert!(ack_group_delivered(&conn, "gm3", "peer-a").is_err());
        assert_eq!(
            status(&conn, "gm3"),
            "sending",
            "群聊删行失败却写了 delivered = 同一种收尾半状态"
        );
        assert_eq!(group_outbox_rows(&conn, "gm3"), 1);
    }
}

/// 回填消息内容与状态（群文件接收完成时用）：content 需随传输完成补上本地 `path`，
/// 状态同时前进到 delivered。与 `set_message_status` 不同，这里会改写 content——
/// `read_file_preview` 按 msg_id 反查 content 定位本地文件，群文件 Offer 阶段先落库
/// 无 path 的内容，Done 时必须显式回填，否则接收方图片/代码预览因缺 path 失败。
///
/// ⚠️ **状态那一半必须有和 `set_message_status` 同一道单调闸**（2026-10-16 审计）：
/// 这是 `messages.status` 全仓唯一一处裸写（分母现算：`db/read_receipts.rs` 写 'read' 是前进、
/// `set_message_status` 有闸、这里没有），于是 `set_message_status` 上方注释点名的那条竞态
/// （Ack 晚于 ReadReceipt 到 ⇒ `read` 被回退成 `delivered`）**能从第二个家重新发生** ——
/// 而且走的是群文件 Done 这条路，正是"收消息时才跑"的那段码。
///
/// 闸只加在 status 上，**不加在 content 上**：路径回填必须无条件成功，否则预览缺 path。
/// `failed` / `cancelled` 仍是软终态（与 `set_message_status` 同口径）：它们允许被前进成 delivered。
pub fn update_message_content(
    conn: &Connection,
    msg_id: &str,
    content: &str,
    status: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE messages
            SET content = ?2,
                status = CASE
                    WHEN status NOT IN ('read', 'delivered', 'recalled') THEN ?3
                    ELSE status
                END
          WHERE msg_id = ?1",
        params![msg_id, content, status],
    )?;
    Ok(())
}

/// 回填文件消息 `content` 里的单个 `sha256` 字段（发送方建行时还算不起，见
/// `commands/files.rs::build_file_message`：整文件哈希是 O(体积) 的，不能挡在气泡前面）。
///
/// 返回 `true` = 这次真的改了行；`false` = 幂等跳过 / 缺行 / 载荷不是 JSON。
/// 调用方据此决定要不要通知前端（只改库不 emit 的话，内存里那条记录仍是 cid 空的版本）。
/// 只做读-改-写一次，且**幂等**：值已经是目标值就不写（投递任务每次尝试都会进来一次）。
/// `msg_id` 不存在时静默返回 `false` —— 内容补发（ContentRequest）复用同一个投递函数，
/// 那条路径的 msg_id 根本不是 `file-*`，此时没有任何东西要补。
pub fn fill_message_sha256(conn: &Connection, msg_id: &str, sha256: &str) -> Result<bool> {
    if sha256.is_empty() {
        return Ok(false);
    }
    let current: Option<String> = conn
        .query_row(
            "SELECT content FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .ok();
    let Some(content) = current else {
        return Ok(false);
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(false); // 非 JSON 载荷（理论上不会出现在 file 消息上）：不动它
    };
    if value.get("sha256").and_then(|v| v.as_str()) == Some(sha256) {
        return Ok(false);
    }
    value["sha256"] = serde_json::Value::String(sha256.to_string());
    conn.execute(
        "UPDATE messages SET content = ?2 WHERE msg_id = ?1",
        params![msg_id, value.to_string()],
    )?;
    Ok(true)
}


/// 发送文件气泡的 `size` 回填为**实际发出去的字节数**。
///
/// 气泡在建行时写的是用户点击那一刻的磁盘大小；源文件在发送前变小/变大时，
/// `file_transfers` 与气泡都必须跟实际值走（2026-10-19 `src-shrunk` 实测差异）。
/// 与 `fill_message_sha256` 同一形状：幂等、缺行/非 JSON 静默跳过、返回是否真的改了行。
pub fn fill_message_size(conn: &Connection, msg_id: &str, size: u64) -> Result<bool> {
    let current: Option<String> = conn
        .query_row(
            "SELECT content FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .ok();
    let Some(content) = current else {
        return Ok(false);
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Ok(false);
    };
    if value.get("size").and_then(|v| v.as_u64()) == Some(size) {
        return Ok(false);
    }
    value["size"] = serde_json::Value::Number(size.into());
    conn.execute(
        "UPDATE messages SET content = ?2 WHERE msg_id = ?1",
        params![msg_id, value.to_string()],
    )?;
    Ok(true)
}

/// 全历史检索的一条命中（含"该会话命中总数"，供「共 N 条相关聊天记录」用）。
#[derive(Debug, Clone, PartialEq)]
pub struct ChatSearchHit {
    pub conv_id: String,
    pub msg_id: String,
    pub sender_id: String,
    pub kind: String,
    pub content: String,
    pub ts: i64,
    /// **该会话**在本次筛选条件下的命中总数（`COUNT(*) OVER (PARTITION BY conv_id)`）。
    /// 注意与返回条数的区别：`limit` 只截断返回条数，总数仍是全量命中数
    /// —— 否则"共 N 条"会随分页变小，用户会以为搜漏了。
    pub total: i64,
}

/// 历史检索（「搜索聊天记录」用）。
///
/// 与 `search_messages_in_conv`（会话内取最新一条做摘要）的区别：这里要的是
/// **结果页**需要的形态 —— 跨会话、按时间倒序、每条都带发送者与类型，
/// 并且每个会话给出命中总数与最新命中时间。
///
/// 过滤条件都在 SQL 里做（而不是取回前端再筛）：① 命中数才是准的（"共 N 条"必须按
/// 当前筛选算）；② 不必把全库命中都搬到前端。
///   · `sender_id`：按**发送者**筛（微信搜索页的「发送人」）；
///   · `since_ms` / `until_ms`：时间区间（「日期」）。
///
/// 刻意排除 `kind = 'system'`：系统提示（被移出群聊、解密失败占位等）不是用户发的
/// 聊天内容，搜出来只会干扰 —— 微信也不会把它们算进"聊天记录"。
pub fn search_history(
    conn: &Connection,
    keyword: &str,
    sender_id: Option<&str>,
    since_ms: Option<i64>,
    until_ms: Option<i64>,
    limit: i64,
) -> Result<Vec<ChatSearchHit>> {
    let pattern = format!("%{}%", escape_like(keyword));
    // 清单从 WIRE_KINDS 派生（不手写）：system 是历史遗留的不可搜索项，
    // 静默类（表情回应/撤回）没有可搜正文。
    let unsearchable =
        crate::protocol::sql_kind_list(&["system"], |c| c == crate::protocol::KindClass::Silent);
    let mut stmt = conn.prepare(&format!(
        "SELECT conv_id, msg_id, sender_id, kind, content, ts,
                COUNT(*) OVER (PARTITION BY conv_id) AS total
         FROM messages
         WHERE content LIKE ?1 ESCAPE '\\'
           AND kind NOT IN ({unsearchable})
           -- 只搜**还在会话列表里**的会话：删除级联收口之前入库的历史孤儿
           -- （退群/删会话没清干净的消息）不该继续出现在搜索结果里——
           -- 点又点不开，还挤占「共 N 条」。新数据已在 delete_group/delete_conversation
           -- 同事务清掉，这一条兜住存量与未来任何漏网路径。
           AND conv_id IN (SELECT id FROM conversations)
           AND (?2 IS NULL OR sender_id = ?2)
           AND (?3 IS NULL OR ts >= ?3)
           AND (?4 IS NULL OR ts <= ?4)
         ORDER BY ts DESC, id DESC
         LIMIT ?5",
    ))?;
    let rows = stmt.query_map(
        params![pattern, sender_id, since_ms, until_ms, limit],
        |r| {
            Ok(ChatSearchHit {
                conv_id: r.get(0)?,
                msg_id: r.get(1)?,
                sender_id: r.get(2)?,
                kind: crate::protocol::display_kind(&r.get::<_, String>(3)?),
                content: r.get(4)?,
                ts: r.get(5)?,
                total: r.get(6)?,
            })
        },
    )?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 转义 LIKE 通配符：将 % 和 _ 替换为字面值。
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 1:1 原地重投（计划 D1）：`requeue_message_for_resend` 的状态门。
///
/// 只有 `failed` / `cancelled` 能复活 —— 其余状态要么已经在路上（`sending`/`sent`），
/// 要么是不可逆的硬终态（`delivered`/`read`/`recalled`）。第二条尤其重要：一条已送达的
/// 消息被"重发"会让对端收到第二条完全相同的情绪，而库里的 seq 还是旧的。
#[cfg(test)]
mod resend_requeue_tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn put(conn: &Connection, msg_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'p1', 'me', 'p1', 'text', 'x', 111, 7, ?2)",
            params![msg_id, status],
        )
        .unwrap();
    }

    fn status_of(conn: &Connection, msg_id: &str) -> String {
        conn.query_row(
            "SELECT status FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn outbox_n(conn: &Connection, msg_id: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM outbox WHERE msg_id = ?1",
            params![msg_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn failed_and_cancelled_come_back_to_sending_with_a_queue_row() {
        let conn = mem();
        for (id, st) in [("f1", "failed"), ("c1", "cancelled")] {
            put(&conn, id, st);
            assert_eq!(
                requeue_message_for_resend(&conn, id, "p1", "{}").unwrap(),
                1,
                "{st} 必须能回到 sending"
            );
            assert_eq!(status_of(&conn, id), "sending");
            assert_eq!(outbox_n(&conn, id), 1, "没有队列行 = 下一轮 flush 不会补发");
            // ts/seq 原样保留（复用稳定身份的一半）。
            let (ts, seq): (i64, i64) = conn
                .query_row(
                    "SELECT ts, seq FROM messages WHERE msg_id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((ts, seq), (111, 7), "重发不许改时间戳与逻辑序号");
        }
    }

    #[test]
    fn terminal_and_in_flight_states_are_refused_without_writing() {
        let conn = mem();
        for st in ["sending", "sent", "delivered", "read", "recalled"] {
            let id = format!("m-{st}");
            put(&conn, &id, st);
            assert_eq!(
                requeue_message_for_resend(&conn, &id, "p1", "{}").unwrap(),
                0,
                "{st} 不许被重发"
            );
            assert_eq!(status_of(&conn, &id), st, "被拒绝时状态一个字都不许动");
            assert_eq!(outbox_n(&conn, &id), 0, "被拒绝时也不许留下队列行");
        }
    }

    /// 队列行已在（心跳 flush 与重发撞在一起）：复用那一行，不产生第二行。
    #[test]
    fn an_existing_queue_row_is_reused_not_duplicated() {
        let conn = mem();
        put(&conn, "f2", "failed");
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES('f2','p1','{\"old\":1}',5)",
            [],
        )
        .unwrap();
        assert_eq!(requeue_message_for_resend(&conn, "f2", "p1", "{}").unwrap(), 1);
        assert_eq!(status_of(&conn, "f2"), "sending");
        assert_eq!(outbox_n(&conn, "f2"), 1, "outbox.msg_id 是 UNIQUE：重发不许插第二行");
    }

    /// 一条不存在的消息：0，不报错（调用方据此说"已经不在了"）。
    #[test]
    fn an_unknown_message_writes_nothing() {
        let conn = mem();
        assert_eq!(requeue_message_for_resend(&conn, "nope", "p1", "{}").unwrap(), 0);
        assert_eq!(outbox_n(&conn, "nope"), 0);
    }
}

#[cfg(test)]
mod local_id_tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        // 唯一索引住在 ensure_post_schema_shape（迁移加列 → 不能进 SCHEMA 批次）；测试里手建同一条。
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(local_id);",
        )
        .unwrap();
        conn
    }

    fn rec(msg_id: &str, local_id: Option<&str>) -> MessageRecord {
        MessageRecord {
            fail_code: None,
            id: 0,
            msg_id: msg_id.to_string(),
            conv_id: "c1".to_string(),
            sender_id: "me".to_string(),
            receiver_id: "peer".to_string(),
            kind: "text".to_string(),
            content: "hi".to_string(),
            ts: 1,
            seq: 1,
            status: "sent".to_string(),
            mention_targets: None,
            local_id: local_id.map(|s| s.to_string()),
        }
    }

    #[test]
    fn explicit_local_id_is_persisted_and_none_falls_back_to_msg_id() {
        let conn = mem();
        insert_message(&conn, &rec("m1", Some("lid-1"))).unwrap();
        insert_message(&conn, &rec("m2", None)).unwrap();
        let a = get_message_record(&conn, "m1").expect("m1");
        let b = get_message_record(&conn, "m2").expect("m2");
        assert_eq!(a.local_id.as_deref(), Some("lid-1"));
        assert_eq!(
            b.local_id.as_deref(),
            Some("m2"),
            "未提供本地 id 时必须由 SQL 回填 msg_id（列表 key 不能为空）"
        );
    }

    #[test]
    fn local_id_is_unique() {
        let conn = mem();
        insert_message(&conn, &rec("m1", Some("dup"))).unwrap();
        assert!(
            insert_message(&conn, &rec("m2", Some("dup"))).is_err(),
            "重复 local_id 会让列表两行互相覆盖测量/DOM ⇒ 唯一索引必须拒绝"
        );
    }
}

#[cfg(test)]
mod fail_code_tests {
    // 本文件经 include! 拼进 db 模块，模块名在 db 作用域里必须全局唯一。
    use super::*;
    use crate::error_codes;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn seed(conn: &Connection, msg_id: &str, kind: &str, status: &str) {
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES(?1, 'c1', 'me', 'peer', ?2, 'hi', 1, 1, ?3)",
            params![msg_id, kind, status],
        )
        .unwrap();
    }

    /// 一次读回 `(status, fail_code)` —— 这两个字段是一个契约的两半，分开读就看不出错位。
    fn pair(conn: &Connection, msg_id: &str) -> (String, Option<String>) {
        conn.query_row(
            "SELECT status, fail_code FROM messages WHERE msg_id = ?1",
            params![msg_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    /// 两扇门的分工（写顺序就是语义）：带原因的失败只走 `set_message_failed`，
    /// 通用那扇门推进状态时**必须把旧码归零** —— 否则一条重发后又失败的消息会
    /// 被界面念出**上一次**的原因。
    #[test]
    fn set_message_failed_writes_both_and_the_generic_door_clears_the_code() {
        let conn = mem();
        seed(&conn, "m1", "text", "sending");

        assert_eq!(
            set_message_failed(&conn, "m1", error_codes::SEND_RETRY_EXPIRED).unwrap(),
            1
        );
        assert_eq!(
            pair(&conn, "m1"),
            ("failed".to_string(), Some(error_codes::SEND_RETRY_EXPIRED.to_string())),
            "failed 与原因必须同一次写落地，缺一个界面就只能猜"
        );

        // 通用门写非 failed 的状态 ⇒ 码归零。这里先把状态放开（重发链走的是另一条 SQL，
        // 本条只验证"这一扇门会清码"这一半契约），所以直接从 failed 造回可写状态。
        conn.execute(
            "UPDATE messages SET status = 'sending' WHERE msg_id = 'm1'",
            [],
        )
        .unwrap();
        assert_eq!(set_message_status(&conn, "m1", "sent").unwrap(), 1);
        assert_eq!(
            pair(&conn, "m1"),
            ("sent".to_string(), None),
            "推进状态却留着旧原因 ⇒ 下一次没有码的失败会把这一次的原因念给用户"
        );
    }

    /// 硬终态守卫不许因为新列而变松：迟到的 `sent` 仍然改不动已判失败的行，
    /// 连带地也不许把那一格的原因码洗掉（它是那次失败的证据）。
    #[test]
    fn a_late_write_still_cannot_rewrite_a_failed_row_or_its_code() {
        let conn = mem();
        seed(&conn, "m2", "text", "sending");
        set_message_failed(&conn, "m2", error_codes::SEND_PEER_DELETED).unwrap();

        assert_eq!(
            set_message_status(&conn, "m2", "sent").unwrap(),
            0,
            "failed 是软终态但对迟到写不可撤销（INV：队列行已关，不许被推回已发送）"
        );
        assert_eq!(
            pair(&conn, "m2"),
            ("failed".to_string(), Some(error_codes::SEND_PEER_DELETED.to_string())),
            "0 行的写不许顺手动过那一格"
        );
    }

    /// 清扫器的过期终态必须**自带原因**：它是"重试窗口耗尽"这一格唯一的书写点。
    #[test]
    fn expired_settlement_records_the_reason_and_closes_the_queue_row() {
        let conn = mem();
        seed(&conn, "m3", "text", "sending");
        conn.execute(
            "INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES('m3','peer','{}',1)",
            [],
        )
        .unwrap();

        finalize_expired_message(&conn, "m3", false).unwrap();
        assert_eq!(
            pair(&conn, "m3"),
            ("failed".to_string(), Some(error_codes::SEND_RETRY_EXPIRED.to_string())),
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox WHERE msg_id = 'm3'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "同一事务里删行这一步不许因为加列而漏掉");
    }

    /// **四个读取口都要带上新列**（发送端与接收端是同一份规则的两半）：
    /// 漏任何一个，那条路径读回来的气泡就只能显示通用文案，而库里明明有原因。
    #[test]
    fn every_message_reader_carries_the_fail_code() {
        let conn = mem();
        seed(&conn, "m4", "text", "sending");
        seed(&conn, "t1", "todo", "sending");
        set_message_failed(&conn, "m4", error_codes::SEND_GROUP_MEMBER_GONE).unwrap();
        set_message_failed(&conn, "t1", error_codes::SEND_ORPHAN_AT_START).unwrap();

        let by_page = get_messages(&conn, "c1", 50, 0).unwrap();
        let by_tail = get_latest_messages(&conn, "c1", 50).unwrap();
        let by_kind = get_todo_messages_for_conns(&conn, &["c1".to_string()]).unwrap();
        let by_id = get_message_record(&conn, "m4").expect("m4");

        for (name, rec) in [
            ("get_messages", by_page.iter().find(|r| r.msg_id == "m4").unwrap()),
            ("get_latest_messages", by_tail.iter().find(|r| r.msg_id == "m4").unwrap()),
            ("get_message_record", &by_id),
        ] {
            assert_eq!(
                rec.fail_code.as_deref(),
                Some(error_codes::SEND_GROUP_MEMBER_GONE),
                "{name} 没把 fail_code 读回来"
            );
        }
        assert_eq!(
            by_kind
                .iter()
                .find(|r| r.msg_id == "t1")
                .and_then(|r| r.fail_code.clone())
                .as_deref(),
            Some(error_codes::SEND_ORPHAN_AT_START),
            "get_todo_messages_for_conns 走的是自己那份 SELECT，最容易漏"
        );
    }

    /// 码的形状是契约（前端按字面量查表）：必须是**只有大写字母/数字/下划线**的串。
    /// 这条不是形式主义 —— 小写或带空格的码在前端那张表里匹配不上，会静默回落到通用文案。
    #[test]
    fn message_fail_codes_are_stable_identifiers() {
        assert_eq!(
            error_codes::MESSAGE_FAIL_CODES.len(),
            16,
            "档位变了要同步三处：前端表 `src/utils/fileFailReason.ts`、中英词典、以及这条长度钉"
            // 5.15.31 加了 `FILE_SEND_EXPIRED` / `FILE_SEND_GIVEUP`（原先只活在事件载荷里，
            // 现在也会落进这一列，`FileJobEnd::fail_code`）；5.15.32 加了群文件那六格；
            // 5.15.35 加接收收尾那四格（`FILE_RECEIVE_INCOMPLETE` / `FILE_INTEGRITY_FAILED`
            // / `FILE_RECEIVE_WRITE_FAILED` / `FILE_RECEIVE_PLACE_FAILED`）—— 其中
            // `FILE_INTEGRITY_FAILED` 是从 `logging.rs` **搬过来**的：中继与直连收的是同一个事实，
            // 一个事实只许一个名字。按本仓口径，能落进这一列的码**必须**在这张表里。
        );
        for code in error_codes::MESSAGE_FAIL_CODES {
            assert!(
                !code.is_empty()
                    && code
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()),
                "失败码必须是大写字母/数字/下划线：{code}"
            );
            // 常量名与常量值逐字相同（对账判据按名字解析，两者不一致就会读错）。
            assert!(
                code.len() > 5,
                "过短的码会撞上别的字面量，读回来分不清是谁：{code}"
            );
        }
    }
}
