// 职责边界：
// - 撤回事件（G-Set 去重 + 物化视图）
// ---------------- 撤回（G-Set + 物化视图） ----------------

/// 记下一条撤回事件（幂等）。返回 true 表示本次是首次记录。
pub fn insert_recall(
    conn: &Connection,
    conv_id: &str,
    msg_id: &str,
    recaller_id: &str,
    seq: i64,
) -> Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO group_recalled_messages(conv_id, msg_id, recaller_id, seq)
         VALUES(?1, ?2, ?3, ?4)",
        params![conv_id, msg_id, recaller_id, seq],
    )?;
    Ok(n > 0)
}

/// 该消息是否已被撤回（权威判定）。
pub fn is_recalled(conn: &Connection, msg_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM group_recalled_messages WHERE msg_id = ?1",
        params![msg_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// 这条消息被谁、在哪个会话里登记过墓碑。
///
/// 为什么返回 conv_id 而不是直接给 bool：墓碑表 PK 是 `(conv_id, msg_id)`，而收件热路径
/// 手上只有 msg_id ⇒ 索引按 msg_id 建（`db.rs` 那句注释自己写着"PK 的前缀用不上"）。
/// 于是**命中不等于该生效**：经 A 群信封插入的墓碑会命中 B 群/单聊的同名消息，
/// 先把 conv 带回去让调用方核对，是这条通道唯一的收口方式（2026-10-28 review 抓到）。
pub fn recall_source(conn: &Connection, msg_id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT conv_id, recaller_id FROM group_recalled_messages WHERE msg_id = ?1 LIMIT 1",
        params![msg_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 撤回的**一笔收口**：墓碑 + 物化 + 会话预览，同一个事务（B1-F6）。
///
/// 为什么必须合成一个：这三笔原先在三个调用点各写一遍、而且前两笔都是 `.ok()` ——
/// 墓碑写进去而物化失败（或反过来）就**永久分裂**：`is_recalled` 说"撤过"、正文还在；
/// 而幂等短路看的正是 `is_recalled` ⇒ 重试再也补不上（用户看到的是"有时撤回不生效"）。
///
/// 事务还顺带让"预览重算"落进同一笔：它原先在三个调用点各写一遍、错漏一处就是
/// "正文清了、列表还挂着原文"。
pub fn apply_recall(
    conn: &Connection,
    conv_id: &str,
    msg_id: &str,
    recaller_id: &str,
    seq: i64,
) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let inserted = insert_recall(&tx, conv_id, msg_id, recaller_id, seq)?;
    materialize_recall(&tx, msg_id)?;
    refresh_conversation_summary(&tx, conv_id)?;
    tx.commit()?;
    Ok(inserted)
}

/// 把撤回**物化**到消息行：清空正文、改 kind。
///
/// `content` 清空后，搜索 / 导出 / 已读水位**一行都不用改就自动正确**（没有正文可命中）。
///
/// ⚠️ 但**会话预览不在这一列里**：会话列表读的是 `conversations.last_msg`（存储列，
/// 见 `db.rs` 的 SCHEMA），它只在发送与删除时被改写。这里曾经写着"会话预览…自动正确"，
/// 那句话与实现相反（2026-10-28 实测），害处是"撤回后会话列表那行还挂着原文"。
/// 所以每个调用点在物化之后必须再跑一次 `db::refresh_conversation_summary`（同一条事务里）。
/// 返回 true 表示确实改到了行（消息已在本机）。
pub fn materialize_recall(conn: &Connection, msg_id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE messages SET kind = ?2, content = '' WHERE msg_id = ?1 AND kind != ?2",
        params![msg_id, crate::protocol::KIND_RECALLED],
    )?;
    Ok(n > 0)
}
