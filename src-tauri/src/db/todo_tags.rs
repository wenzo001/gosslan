// ---------------- 群任务标签（2026-11-05） ----------------
//
// 两份本地状态：
//  1. `todo_task_tags`：**当前关联**（哪个任务挂了哪些标签）。主键 `(todo_id, tag)` 是
//     "同一个任务重复挂同一个标签"的硬约束 —— 归一化会先去重，这里再兜底，
//     反例自证见 `migration_tests::v16_to_v17_backfills_todo_tags_and_enforces_unique_constraint`。
//  2. `todo_tag_pool`：**历史候选池**（按 group 维度）。从任务上移除标签**只删关联**，
//     候选池行保留（用户 2026-11-05 明确）；长期未用的由
//     [`TODO_TAG_POOL_RETENTION_DAYS`] 在读取候选时自动清理。
//
// 权威数据仍然是消息载荷里的 `tags` 数组（随 `todo` / `todo_update` 同步）；
// 这两张表只是本机索引/候选池，任何一路消息落库都会经过 [`sync_todo_tags_from_message`]，
// 所以远端改动也能进入候选池。

/// 候选池保留天数：超过这个天数没有被任何任务"说"过的标签，在读取候选时被清理。
///
/// 90 天是"一个季度"的口径：跨季度还在用的标签几乎一定是长期分类（如"线上问题"），
/// 而一次性的临时词（"下周对齐"）三个月后基本不会再复用。写进 `docs/todo-tags.md`。
pub const TODO_TAG_POOL_RETENTION_DAYS: i64 = 90;

const TODO_TAG_POOL_MAX_CANDIDATES: i64 = 50;

/// 候选池的一行（前端按下拉列表直接渲染）。
#[derive(serde::Serialize, Clone, Debug)]
pub struct TodoTagCandidate {
    pub tag: String,
    pub use_count: i64,
    pub last_used_at: i64,
}

fn todo_tags_table_exists(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'todo_task_tags'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0)
}

/// 把一条任务的标签集合**同步**进关联表与候选池（幂等）。
///
/// - 关联表：先删掉不在新集合里的行（= 解除关联），再 `INSERT OR IGNORE` 补齐。
/// - 候选池：每次"说"到某个标签都推进 `last_used_at`；`use_count` **只在新挂上时 +1**
///   （同一份定义被重复落库/重放不会虚增使用次数）。
/// - 空集合 = 明确清空关联，但**不动候选池**（用户 2026-11-05：移除只解除关联）。
pub fn apply_todo_tags(
    conn: &Connection,
    group_id: &str,
    todo_id: &str,
    tags: &[String],
    now: i64,
) -> Result<()> {
    if !todo_tags_table_exists(conn)? {
        return Ok(());
    }
    // 候选池里同一个小写键可能已经有一行（首次输入时的写法），新输入只用于命中它，
    // 不新建 `bug` / `Bug` 两条（用户 2026-11-05：不区分大小写，保留首次写法）。
    let pool: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT tag FROM todo_tag_pool WHERE group_id = ?1 ORDER BY rowid ASC")?;
        let rows: Vec<String> = stmt
            .query_map([group_id], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };
    let tags: Vec<String> = crate::protocol::normalize_todo_tags(tags)
        .into_iter()
        .take(crate::protocol::TODO_MAX_TAGS)
        .map(|t| {
            let lowered = t.to_lowercase();
            pool.iter()
                .find(|x| x.to_lowercase() == lowered)
                .cloned()
                .unwrap_or(t)
        })
        .collect();
    let mut stmt = conn.prepare("SELECT tag FROM todo_task_tags WHERE todo_id = ?1")?;
    let existing: Vec<String> = stmt
        .query_map([todo_id], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for old in &existing {
        // 逐字相等才算"保留"：只差大小写的旧写法也删掉，下面按候选池的规范写法重插。
        if !tags.iter().any(|t| t == old) {
            conn.execute(
                "DELETE FROM todo_task_tags WHERE todo_id = ?1 AND tag = ?2",
                params![todo_id, old],
            )?;
        }
    }
    for tag in &tags {
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO todo_task_tags(group_id, todo_id, tag, updated_at) \
             VALUES(?1, ?2, ?3, ?4)",
            params![group_id, todo_id, tag, now],
        )?;
        conn.execute(
            "INSERT INTO todo_tag_pool(group_id, tag, use_count, last_used_at) VALUES(?1, ?2, ?3, ?4) \
             ON CONFLICT(group_id, tag) DO UPDATE SET \
               use_count = todo_tag_pool.use_count + excluded.use_count, \
               last_used_at = excluded.last_used_at",
            params![group_id, tag, if inserted > 0 { 1 } else { 0 }, now],
        )?;
        if inserted == 0 {
            conn.execute(
                "UPDATE todo_task_tags SET updated_at = ?3 WHERE todo_id = ?1 AND tag = ?2",
                params![todo_id, tag, now],
            )?;
        }
    }
    Ok(())
}

/// 删除一条任务的全部关联（墓碑消息落库时用）。候选池保留。
pub fn clear_todo_tags(conn: &Connection, todo_id: &str) -> Result<()> {
    if !todo_tags_table_exists(conn)? {
        return Ok(());
    }
    conn.execute("DELETE FROM todo_task_tags WHERE todo_id = ?1", [todo_id])?;
    Ok(())
}

/// 从一条已经落库的 `todo` / `todo_update` 消息同步标签。
///
/// **键不存在 = 没说**：老版本对端重建的载荷不带 `tags`，这里直接跳过，
/// 关联与候选池都不动（与 `latest_todo_def` 的 carry 规则、前端 `carryAbsentTodoFields` 同一口径）。
/// 坏 JSON / 非群会话 / 没有 `todo_id` 一律安静跳过 —— 这条是消息落库的附带维护，
/// 不能因为一条脏消息让主消息写入失败。
pub fn sync_todo_tags_from_message(
    conn: &Connection,
    conv_id: &str,
    kind: &str,
    content: &str,
    now: i64,
) {
    if kind != "todo" && kind != "todo_update" {
        return;
    }
    let Some(group_id) = conv_id.strip_prefix("group:") else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        return;
    };
    let Some(todo_id) = v.get("todo_id").and_then(|x| x.as_str()) else {
        return;
    };
    if v.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false) {
        let _ = clear_todo_tags(conn, todo_id);
        return;
    }
    // 键不存在 = 没说（沿用），空数组 = 明确清空。
    let Some(arr) = v.get("tags").and_then(|x| x.as_array()) else {
        return;
    };
    let tags: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= crate::protocol::TODO_TAG_MAX_LEN)
        .map(str::to_string)
        .collect();
    let _ = apply_todo_tags(conn, group_id, todo_id, &tags, now);
}

/// 迁移 v16→v17 的回填：混合版本期间，旧库可能已经从新对端收到过带 `tags` 的消息。
/// 按 `(ts, id)` 顺序重放一遍，把关联与候选池补齐；SCHEMA 表达不了这件事，所以它是迁移 step。
pub fn rebuild_todo_tags_from_messages(conn: &Connection) -> Result<()> {
    if !todo_tags_table_exists(conn)? {
        return Ok(());
    }
    let messages_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !messages_exists {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT conv_id, kind, content FROM messages \
         WHERE kind IN ('todo', 'todo_update') ORDER BY ts ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok::<_, rusqlite::Error>((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    for row in rows.flatten() {
        let (conv_id, kind, content) = row;
        sync_todo_tags_from_message(conn, &conv_id, &kind, &content, crate::db::now_ms());
    }
    Ok(())
}

/// 候选池里"只差大小写"的旧行合并成一行：保留**最早插入**那行（= 首次输入时的写法），
/// `use_count` 求和、`last_used_at` 取最大，其余删除。
///
/// 改造前（v17 之前没有大小写判等）同一个小写键可能已经并存 `Bug` 与 `bug`；
/// 新写入由 [`apply_todo_tags`] 直接复用候选池里的首次写法，这里负责把历史残留收口。
fn merge_pool_case_variants(conn: &Connection, group_id: &str) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT rowid, tag, use_count, last_used_at FROM todo_tag_pool \
         WHERE group_id = ?1 ORDER BY rowid ASC",
    )?;
    let rows: Vec<(i64, String, i64, i64)> = stmt
        .query_map([group_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    let mut merged: std::collections::HashMap<String, (i64, i64, i64)> =
        std::collections::HashMap::new();
    let mut stale_rowids: Vec<i64> = Vec::new();
    for (rowid, tag, use_count, last_used_at) in rows {
        match merged.get_mut(&tag.to_lowercase()) {
            Some((_, count, last)) => {
                *count += use_count;
                *last = (*last).max(last_used_at);
                stale_rowids.push(rowid);
            }
            None => {
                merged.insert(tag.to_lowercase(), (rowid, use_count, last_used_at));
            }
        }
    }
    if stale_rowids.is_empty() {
        return Ok(());
    }
    for rowid in stale_rowids {
        conn.execute("DELETE FROM todo_tag_pool WHERE rowid = ?1", [rowid])?;
    }
    for (_, (rowid, count, last_used_at)) in merged {
        conn.execute(
            "UPDATE todo_tag_pool SET use_count = ?2, last_used_at = ?3 WHERE rowid = ?1",
            params![rowid, count, last_used_at],
        )?;
    }
    Ok(())
}

/// 读某群的标签候选：先清理超过保留期的行、合并只差大小写的旧行，再按
/// **使用次数降序 → 最近使用降序 → 字典序** 排。
pub fn list_todo_tag_candidates(
    conn: &Connection,
    group_id: &str,
    now: i64,
) -> Result<Vec<TodoTagCandidate>> {
    if !todo_tags_table_exists(conn)? {
        return Ok(Vec::new());
    }
    let cutoff = now - TODO_TAG_POOL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    conn.execute(
        "DELETE FROM todo_tag_pool WHERE group_id = ?1 AND last_used_at < ?2",
        params![group_id, cutoff],
    )?;
    merge_pool_case_variants(conn, group_id)?;
    let mut stmt = conn.prepare(
        "SELECT tag, use_count, last_used_at FROM todo_tag_pool WHERE group_id = ?1 \
         ORDER BY use_count DESC, last_used_at DESC, tag ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![group_id, TODO_TAG_POOL_MAX_CANDIDATES], |r| {
        Ok(TodoTagCandidate {
            tag: r.get(0)?,
            use_count: r.get(1)?,
            last_used_at: r.get(2)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
