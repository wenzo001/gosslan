// 职责边界：
// - 会话表 CRUD（ensure/touch_conversation）
// ---------------- 会话 ----------------

pub fn touch_conversation(
    conn: &Connection,
    id: &str,
    kind: &str,
    name: &str,
    avatar: Option<&str>,
    last_msg: &str,
    unread_inc: i64,
) -> Result<()> {
    // group 类型：INSERT 时 name 必须从 groups 表查（防止文件/群聊消息把群名覆盖成文件名）。
    // UPDATE 时已由 CASE WHEN 保护不会被覆盖，但 INSERT 无保护 → 必须提前纠正。
    let effective_name = if kind == "group" {
        let real_name = conn.query_row(
            "SELECT name FROM groups WHERE id = ?1",
            params![id.strip_prefix("group:").unwrap_or(id)],
            |r| r.get::<_, String>(0),
        );
        match real_name {
            Ok(n) if !n.is_empty() => n,
            _ => name.to_string(),
        }
    } else {
        name.to_string()
    };
    conn.execute(
        "INSERT INTO conversations(id, kind, name, avatar, last_msg, last_ts, unread, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN conversations.kind = 'group' THEN conversations.name ELSE excluded.name END,
            avatar = COALESCE(excluded.avatar, conversations.avatar),
            last_msg = excluded.last_msg,
            last_ts = excluded.last_ts,
            unread = conversations.unread + excluded.unread,
            updated_at = excluded.updated_at",
        params![id, kind, effective_name, avatar, last_msg, now_ms(), unread_inc],
    )?;
    Ok(())
}

pub fn ensure_conversation(
    conn: &Connection,
    id: &str,
    kind: &str,
    name: &str,
    avatar: Option<&str>,
) -> Result<()> {
    // 与 touch_conversation 同理：group 必须从 groups 表取真实群名
    let effective_name = if kind == "group" {
        let real_name = conn.query_row(
            "SELECT name FROM groups WHERE id = ?1",
            params![id.strip_prefix("group:").unwrap_or(id)],
            |r| r.get::<_, String>(0),
        );
        match real_name {
            Ok(n) if !n.is_empty() => n,
            _ => name.to_string(),
        }
    } else {
        name.to_string()
    };
    conn.execute(
        "INSERT OR IGNORE INTO conversations(id, kind, name, avatar, unread, updated_at)
         VALUES(?1, ?2, ?3, ?4, 0, ?5)",
        params![id, kind, effective_name, avatar, now_ms()],
    )?;
    Ok(())
}

/// 会话行 → Conversation 的唯一映射（list / get 共用，避免两处列序漂移）。
fn row_to_conversation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        avatar: r.get(3)?,
        last_msg: r.get(4)?,
        last_ts: r.get(5)?,
        unread: r.get(6)?,
        pinned: r.get::<_, i64>(7)? != 0,
    })
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<Conversation>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, avatar, last_msg, last_ts, unread, pinned
         FROM conversations ORDER BY pinned DESC, COALESCE(last_ts, updated_at, 0) DESC",
    )?;
    let rows = stmt.query_map([], row_to_conversation)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_conversation(conn: &Connection, id: &str) -> Option<Conversation> {
    conn.query_row(
        "SELECT id, kind, name, avatar, last_msg, last_ts, unread, pinned
         FROM conversations WHERE id = ?1",
        params![id],
        row_to_conversation,
    )
    .optional()
    .ok()
    .flatten()
}

/// 会话列表那一行的「末条」在库里的取法：**与聊天时间线同一个全序**。
///
/// ⚠️ 排序键用 `seq` 不用 `ts`：`get_messages` 的时间线是 `ORDER BY seq ASC, id ASC`，
/// 列表摘要必须指向用户在会话里看到的最后那一条。群历史保留源机的 `ts`
/// （见 `db/group_history.rs` 函数头第 ① 条），两台时钟不同步时 ts 与 seq 可以反序 ⇒
/// 按 `ts` 取就会把摘要写成时间线里更早的一条（审计 A1 的原始症状之一）。
///
/// 可当选的种类 = 实时接收那一臂会写摘要的那些：`Silent` 类与 `system` 都不写
/// （`protocol::is_non_notifying_kind`）。清单从 `WIRE_KINDS` 现派生，不手写。
fn newest_message_for_summary(
    conn: &Connection,
    conv_id: &str,
) -> Result<Option<(String, String, i64)>> {
    let silent = crate::protocol::sql_kind_list(&[], |c| c == crate::protocol::KindClass::Silent);
    conn.query_row(
        &format!(
            "SELECT kind, content, ts FROM messages
             WHERE conv_id = ?1 AND kind NOT IN ({silent}, 'system')
             ORDER BY seq DESC, id DESC LIMIT 1"
        ),
        params![conv_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

/// 把会话行的末条摘要重算到库里那条真实末条**及其自己的时间**（群历史补齐用，审计 A1）。
///
/// 与 `touch_conversation` 的两点区别都是刻意的：
///  - `last_ts` 用消息的 `ts`：补齐的是历史，用 `now_ms()` 会把一个用户处理到一半的会话
///    无理由顶到列表最前，而"它该排哪儿"只由消息时间决定；
///  - **不动 `unread`**：同步进来的 800 条历史不该变成一排红点。
///
/// 会话行不存在时先由 `ensure_conversation` 建出来（group 那一支自己会从 `groups` 取真实群名）。
/// 返回 `false` = 这一页只带进静默事件（回应/置顶之类），库里没有可当末条的消息；
/// 调用方据此决定要不要保留旧摘要（行本身照样已经建出来）。
pub fn refresh_conversation_head_from_history(
    conn: &Connection,
    id: &str,
    kind: &str,
    name: &str,
) -> Result<bool> {
    let last = newest_message_for_summary(conn, id)?;
    ensure_conversation(conn, id, kind, name, None)?;
    let Some((last_kind, last_content, last_ts)) = last else {
        return Ok(false);
    };
    conn.execute(
        "UPDATE conversations SET last_msg = ?2, last_ts = ?3 WHERE id = ?1",
        params![
            id,
            crate::protocol::preview_text(&last_kind, &last_content),
            last_ts
        ],
    )?;
    Ok(true)
}

/// 设置会话置顶（纯本地偏好，不广播、不同步）。会话不存在时静默成功。
pub fn set_conversation_pinned(conn: &Connection, conv_id: &str, pinned: bool) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET pinned = ?2 WHERE id = ?1",
        params![conv_id, if pinned { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn mark_read(conn: &Connection, conv_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET unread = 0 WHERE id = ?1",
        params![conv_id],
    )?;
    Ok(())
}

/// 仅更新已有 single 会话的昵称和头像（由 UserInfo 同步触发）。
/// 不修改 last_msg / last_ts / unread / kind / id / 任何其他字段。
/// 如果会话不存在，UPDATE 0 行即可，不会创建新会话。
pub fn update_conversation_profile(
    conn: &Connection,
    id: &str,
    name: &str,
    avatar: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET name = ?2, avatar = ?3 WHERE id = ?1 AND kind = 'single'",
        params![id, name, avatar],
    )?;
    Ok(())
}

/// 取会话内「某发送者」最近一条消息的 (msg_id, ts)。
/// 已读回执用它替代全会话最大时间戳，避免把「接收方自己发的消息」或
/// 「被本地时钟钳制后的时间戳」当作回执阈值，跨设备时钟偏差时尤其重要。
pub fn last_message_from_sender(
    conn: &Connection,
    conv_id: &str,
    sender_id: &str,
) -> Option<(String, i64)> {
    let silent = crate::protocol::sql_kind_list(&[], |c| c == crate::protocol::KindClass::Silent);
    conn.query_row(
        // 排除静默类：否则别人（或我自己）回个表情，就把该发送者的群已读水位
        // 顶到了"刚回应的那条"上，群里其余消息会被误判为已读。
        &format!(
            "SELECT msg_id, ts FROM messages
             WHERE conv_id = ?1 AND sender_id = ?2
               AND kind NOT IN ({silent})
             ORDER BY ts DESC, id DESC LIMIT 1"
        ),
        params![conv_id, sender_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 删除一个会话及其所有消息（本地清理；不影响对方聊天记录）。
/// 事务包裹，确保消息与会话行同步删除；不存在则视为成功（幂等）。
pub fn delete_conversation(conn: &Connection, conv_id: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    // ⚠️ 只删 Bubble。Card（群公告/待办）与 Silent（回应/撤回/置顶）**不属于"聊天历史"** ——
    // 清空聊天记录顺手删掉群公告是错误语义（群文件同理：那是群资产，不是聊天记录）。
    // 清单从 `WIRE_KINDS` 派生，不手写：加了新 kind 而忘了同步这里就是静默的数据丢失。
    let keep =
        crate::protocol::sql_kind_list(&["system"], |c| c != crate::protocol::KindClass::Bubble);
    // 被删消息的在途投递队列必须同事务清空（与 delete_messages 同一口径）：
    // 留着这几行，flush_outbox 会在下次建链/心跳把**已删除的消息**补发回去，
    // 对端落库后还会反向出现在本机（对方再发回执/重同步时）——「删了又冒出来」。
    let doomed = format!("SELECT msg_id FROM messages WHERE conv_id = ?1 AND kind NOT IN ({keep})");
    tx.execute(
        &format!("DELETE FROM outbox WHERE msg_id IN ({doomed})"),
        params![conv_id],
    )?;
    tx.execute(
        &format!("DELETE FROM group_outbox WHERE msg_id IN ({doomed})"),
        params![conv_id],
    )?;
    // 文件队列按对话归属键删（单聊 peer_id / 群 group_id），
    // 否则补发任务会给一个已不存在的会话发 FileOffer。
    if let Some(gid) = conv_id.strip_prefix("group:") {
        tx.execute("DELETE FROM file_outbox WHERE group_id = ?1", params![gid])?;
    } else {
        tx.execute(
            "DELETE FROM file_outbox WHERE peer_id = ?1 AND group_id IS NULL",
            params![conv_id],
        )?;
    }
    // 撤回墓碑随它标记的消息一起走（留着只会让同 msg_id 的迟到副本被误挡）
    tx.execute(
        "DELETE FROM group_recalled_messages WHERE conv_id = ?1",
        params![conv_id],
    )?;
    // 渲染切换的 LWW 状态随消息一起走（否则同名 msg_id 的迟到事件会命中墓碑之外的旧状态）。
    tx.execute(
        &format!("DELETE FROM message_render WHERE msg_id IN ({doomed})"),
        params![conv_id],
    )?;
    tx.execute(
        &format!("DELETE FROM messages WHERE conv_id = ?1 AND kind NOT IN ({keep})"),
        params![conv_id],
    )?;
    tx.execute("DELETE FROM conversations WHERE id = ?1", params![conv_id])?;
    tx.commit()?;
    Ok(())
}
