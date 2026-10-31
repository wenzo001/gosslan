// 职责边界：
// - 群历史同步的两半：**服务端**按游标分页取数 + 摘要；**客户端**（新成员侧）幂等落库
// - 群任务编号高水位的"抬地板"（只从应答里那一个数推上去，不改分配规则）
//
// 为什么单独一册（而不是长在 `db/messages.rs` 或 `db/groups.rs` 里）：这两半共享一组只有在
// "补历史"这件事上才成立的判据 —— 保留源机的 `ts`、状态一律 `delivered`、正文里的本机路径
// 必须剥掉、`clear_boundary` 那一道水位照常生效。散进两册会让这五条各写一遍，
// 而它们恰恰是最容易被"照抄实时接收那段码"抄错的地方。
//
// ⚠️ 与实时接收（`network/transport/gossip.rs`）刻意不同的两处，改动时不要"顺手统一"：
//   ① `ts` 用**源机那一行**的值，不用 `now_ms()`：实时路径的"显示时间=本机收到时刻"是对的，
//      历史同步照抄就把 800 条旧消息全标成"刚刚"，时间线直接失真。
//   ② `kind` 从库里**原样取**，不走 `display_kind()`（它把 video/audio 折成 file 给界面用）。
//      走了就会让"同步来的这条"与"实时收到的同一条"在库里成两种 kind（INV-P08）。

use crate::protocol::{
    GroupHistoryFile, GroupHistoryItem, GroupHistoryPage, GROUP_HISTORY_PAGE_ITEMS,
    GROUP_HISTORY_PAGE_MAX_BYTES,
};
use crate::state::GroupHistorySyncState;

/// 这一群的历史同步状态放在 `settings` 的哪一个键。
///
/// 为什么不另建表：`settings` 已经是本仓"每群一份本地状态"的那个家（群密钥 `gk:`、
/// 群任务水位 `todo_num:`、清除边界 `clear_boundary:group:` 都在那儿），
/// 为一趟后台作业开一张表就是给它开第二个家。
/// 为什么这个函数住在这里而不是引擎里：`delete_group` 退群收口必须一起删掉它
/// —— 那是 `db` 层的职责，而键只能有一处定义。
pub fn group_history_state_key(group_id: &str) -> String {
    format!("ghsync:group:{group_id}")
}

pub const GROUP_HISTORY_STATUS_PENDING: &str = "pending";
pub const GROUP_HISTORY_STATUS_DONE: &str = "done";
/// 用户明确在任务中心按了「停止」。
///
/// 与 `pending` 分开是语义，不是状态机洁癖：`pending` 会被 60 秒清扫任务自动重跑，
/// 而用户按「停止」的意思是**现在别再跑**；留 pending 等于 60 秒后又自己开始，
/// 界面上的「已停止」变成一句只维持一分钟的假话。手动同步会把它重新写回 pending。
pub const GROUP_HISTORY_STATUS_STOPPED: &str = "stopped";

/// 读本机这一群的历史同步状态。坏 JSON 按"没有状态"处理（返回 `None`），
/// 因为一次写坏的偏好不该把这个群永久钉成"不同步"。
pub fn read_group_history_state(
    conn: &Connection,
    group_id: &str,
) -> Option<GroupHistorySyncState> {
    let raw = get_setting(conn, &group_history_state_key(group_id))?;
    serde_json::from_str(&raw).ok()
}

/// 写状态（覆盖式）。`updated_at` 由这里统一盖，调用方不必各自取时间。
pub fn write_group_history_state(
    conn: &Connection,
    group_id: &str,
    status: &str,
    source: &str,
    synced: i64,
    total: i64,
) -> Result<()> {
    let st = GroupHistorySyncState {
        status: status.to_string(),
        source: source.to_string(),
        synced,
        total,
        updated_at: now_ms(),
    };
    set_setting(
        conn,
        &group_history_state_key(group_id),
        &serde_json::to_string(&st).unwrap_or_default(),
    )
}

/// 一群的历史摘要。**按逻辑序号量**，不按墙上时钟：
/// `seq` 是全序权威（INV-P09），`ts` 是各机自己的显示时间、跨设备不可比。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GroupHistorySummary {
    pub total: i64,
    pub oldest_seq: i64,
    pub newest_seq: i64,
}

/// 服务端：这一群我有多少历史、最早到哪儿。空群返回全 0。
pub fn group_history_summary(conn: &Connection, group_id: &str) -> Result<GroupHistorySummary> {
    let conv_id = format!("group:{group_id}");
    let (total, oldest, newest) = conn.query_row(
        "SELECT COUNT(*), COALESCE(MIN(seq), 0), COALESCE(MAX(seq), 0)
         FROM messages WHERE conv_id = ?1",
        params![conv_id],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )?;
    Ok(GroupHistorySummary {
        total,
        oldest_seq: if total == 0 { 0 } else { oldest },
        newest_seq: newest,
    })
}

/// 服务端交出的一页 + 下一页的游标。
pub struct GroupHistoryServedPage {
    pub page: GroupHistoryPage,
    pub next_seq: i64,
    pub next_id: i64,
    /// 游标之后**还有**行（不是"本页给了几条"）。
    pub has_more: bool,
    /// 因为封顶而**没带上**的台账行数（只可能出现在第一页）。
    /// 必须有这个数：静默少给 = 新成员那边的文件卡片永远缺台账，而谁都不说。
    pub files_dropped: usize,
}

/// 剥掉文件卡片正文里的**本机路径**。
///
/// 为什么必须剥：`path` 是这台机器落盘后的本地绝对路径（`update_message_content` 在 Done
/// 时回填的那一份）。把它交给新成员，等于让对面预览一个本机不存在的路径 ——
/// 界面表现是"图片打不开/预览失败"，而库里那行看着完全正常（最坏的那种失真）。
/// 非 JSON 载荷（纯文本消息）原样返回：这一句不许改成"解析失败就丢"，
/// 那会把整个会话的历史删掉一半。
pub fn strip_local_path(content: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(content) else {
        return content.to_string();
    };
    if !value.is_object() {
        return content.to_string();
    }
    if value.as_object().and_then(|o| o.get("path")).is_some() {
        value["path"] = serde_json::Value::Null;
        return value.to_string();
    }
    content.to_string()
}

/// 服务端：取 `(seq, id)` 严格大于游标的一页。
///
/// 为什么用 keyset（`WHERE (seq, id) > 游标`）而不是 `LIMIT/OFFSET`：
/// 分页期间源机自己还在往这个会话里写新消息，`OFFSET` 会在两页之间整体错位
/// —— 要么同一条给两遍，要么**漏一条**（漏的那条在界面上没有任何痕迹，
/// 新成员只会以为"这个群本来就说到这儿"）。keyset 只认游标，插入的新行排在后面，
/// 不影响已经取过的那一段。
///
/// 两道预算先到哪个算哪个（`limit` 条 或 `GROUP_HISTORY_PAGE_MAX_BYTES` 字节），
/// 但**至少给一条** —— 否则一条超长消息会让这一页永远推不动游标（活锁）。
/// `limit == 0` = 只要摘要：返回空页、`has_more = false`，选源用的那一次问话就走这条。
pub fn serve_group_history_page(
    conn: &Connection,
    group_id: &str,
    after_seq: i64,
    after_id: i64,
    limit: u32,
) -> Result<GroupHistoryServedPage> {
    let conv_id = format!("group:{group_id}");
    if limit == 0 {
        return Ok(GroupHistoryServedPage {
            page: GroupHistoryPage::default(),
            next_seq: after_seq,
            next_id: after_id,
            has_more: false,
            files_dropped: 0,
        });
    }
    // 多取一条做不到"先看条数再决定"，所以逐行累加字节：超预算就停在这一行之前，
    // 而那一行仍然是"has_more 为真"的证据（下面 EXISTS 会再确认一次）。
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, sender_id, kind, content, ts, seq, mention_targets
         FROM messages
         WHERE conv_id = ?1 AND (seq > ?2 OR (seq = ?2 AND id > ?3))
         ORDER BY seq ASC, id ASC
         LIMIT ?4",
    )?;
    let rows = stmt.query_map(params![conv_id, after_seq, after_id, limit as i64], |r| {
        let raw_kind: String = r.get(3)?;
        let raw_content: String = r.get(4)?;
        Ok((
            r.get::<_, i64>(0)?,
            GroupHistoryItem {
                msg_id: r.get(1)?,
                sender_id: r.get(2)?,
                // 原样搬，不折 display_kind（见文件头第 ② 条）
                kind: raw_kind,
                content: strip_local_path(&raw_content),
                ts: r.get(5)?,
                seq: r.get(6)?,
                mention_targets: decode_mention_targets(r.get::<_, Option<String>>(7)?),
            },
        ))
    })?;

    // 群文件台账只在**第一页**带一次（纯元数据，不含路径，也不带本机那份投递名册）。
    // 先取台账、再把它的字节算进**同一份**预算：预算只有一个家（INV-P23），
    // 而"条目算、台账不算"会让整页实际大小越过 `GROUP_HISTORY_PAGE_MAX_BYTES` ——
    // 台账行数只受群里文件个数约束，越过上限就是一帧几十 MB，
    // 而那一帧在接收侧要**握着全仓唯一那把 db 锁**逐行插 ⇒ 那就是用户手上的卡顿
    // （本轮评审抓出来的，比"少几行台账"贵得多）。
    // 条数同样封顶（用同一个 `GROUP_HISTORY_PAGE_ITEMS`，不再造第二个数）：
    // 装不下的那些**数出来**交给调用方留痕，不静默丢。
    let (files, files_dropped) = if after_seq < 0 {
        served_group_history_files(conn, group_id)?
    } else {
        (Vec::new(), 0)
    };
    let mut budget: usize = files
        .iter()
        .map(|f| serde_json::to_string(f).map(|s| s.len()).unwrap_or(0))
        .sum();
    let mut items: Vec<GroupHistoryItem> = Vec::new();
    let mut last: Option<(i64, i64)> = None;
    for row in rows.flatten() {
        let (id, item) = row;
        let size = serde_json::to_string(&item).map(|s| s.len()).unwrap_or(0);
        if !items.is_empty() && budget + size > GROUP_HISTORY_PAGE_MAX_BYTES {
            break;
        }
        budget += size;
        last = Some((item.seq, id));
        items.push(item);
    }

    let (next_seq, next_id, has_more) = match last {
        None => (after_seq, after_id, false),
        Some((seq, id)) => {
            let more: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM messages
                 WHERE conv_id = ?1 AND (seq > ?2 OR (seq = ?2 AND id > ?3)))",
                params![conv_id, seq, id],
                |r| r.get::<_, i64>(0),
            )? != 0;
            (seq, id, more)
        }
    };

    Ok(GroupHistoryServedPage {
        page: GroupHistoryPage { items, files },
        next_seq,
        next_id,
        has_more,
        files_dropped,
    })
}

/// 服务端：这一群的 `group_files` 台账行（不含 `path` —— 那张表本来就不存路径）。
/// 返回 `(要交出去的那些, 因为封顶而没带的行数)`。
fn served_group_history_files(
    conn: &Connection,
    group_id: &str,
) -> Result<(Vec<GroupHistoryFile>, usize)> {
    let rows = list_group_files(conn, group_id)?;
    let dropped = rows.len().saturating_sub(GROUP_HISTORY_PAGE_ITEMS as usize);
    Ok((
        rows.into_iter()
            .take(GROUP_HISTORY_PAGE_ITEMS as usize)
            .map(|f| GroupHistoryFile {
                transfer_id: f.transfer_id,
                sender_id: f.sender_id,
                name: f.name,
                size: f.size,
                sha256: f.sha256,
                scope: f.scope,
                todo_id: f.todo_id,
                created_at: f.created_at,
            })
            .collect(),
        dropped,
    ))
}

/// 新成员一侧一页的落库读数。**每条都要能解释为什么不算成功也不算失败**，
/// 所以四格分开数，不折成两个 bool。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GroupHistoryApplyStats {
    /// 本次真的新建的行
    pub inserted: usize,
    /// `msg_id` 已存在 ⇒ `INSERT OR IGNORE` 命中（重复投递，不是故障）
    pub duplicate: usize,
    /// 被本机「清空聊天记录」那道水位挡住 ⇒ **故意不落**。
    /// 没有这一格，"我清过这个群"就会被历史同步静默复活成原样。
    pub blocked_by_boundary: usize,
    /// 本次补上的群文件台账行数
    pub files: usize,
    /// **认不上身份、没补成**的台账行数（最常见：发这个文件的人后来退群了，
    /// 而 `insert_group_file` 要求 sender 在册）。这一格必须数出来：
    /// 折成"跳过就好"就是静默吞错（本仓那一族已经补过九处留痕）。
    pub files_skipped: usize,
    /// 本页最大的逻辑序号（引擎用它推进进度与游标核对）
    pub max_seq: i64,
}

/// 客户端：把解开的一页写进本机库。**全程幂等**（同一个 msg_id 写第二遍只会 `duplicate`）。
///
/// 三条不许省的副作用：
///   ① `observe_clock` —— 与"这条要不要计未读"无关。漏了它，本机后续自己发的消息会拿到
///      比刚同步进来的历史**更小**的 seq，于是新消息排在旧消息前面（时钟推进是
///      `gossip.rs` 那句"时钟推进与静默无关，必须照常"的同一个道理）。
///   ② 会话行的末条摘要**每一趟都按库里真实的末条重算**（审计 A1，用户 2026-10-31 拍板：
///      不得因为会话行已经存在而跳过更新）。两个仍然保住的边界：`last_ts` 用的是那条消息
///      自己的 `ts` 而不是同步时刻 ⇒ 补一份早于现状的历史不会把用户处理到一半的会话顶到
///      列表最前；`unread` 一格不动（第 ③ 条）。会话行本身仍然只由**聊天活动**建出来，
///      不靠群关系同步 —— 见 `db/groups.rs` 那条既有不变量的边界。
///   ③ 未读**恒为 0**：同步进来的 800 条不该变成 800 条未读红点。用户看到的提示是
///      "已同步 N 条群消息"，不是 badges 爆炸。
///
/// `Err` 只在真故障时返回（rusqlite 错误），调用方据此判定"这一趟没收口"，
/// 不许把它折叠成 `duplicate`（那等于把一次 SQLITE_BUSY 说成"本来就有"）。
pub fn apply_group_history_page(
    conn: &Connection,
    group_id: &str,
    me: &str,
    group_name: &str,
    page: &GroupHistoryPage,
) -> Result<GroupHistoryApplyStats> {
    let mut stats = GroupHistoryApplyStats::default();
    let conv_id = format!("group:{group_id}");

    // 前置条件先查、再动任何一行（不是靠 `insert_group_file` 那道闸顺带挡下来的）：
    // 群行不在 = 本机已经不是这个群的成员（退群/被移出的收口把 groups 删了）。
    // 那种情况下**一条消息都不该写** —— 靠下面那条文件台账的闸来失败是碰巧挡住，
    // 而页面里没有文件行的时候它就会一路写下去，把一个已退出的群的历史塞回库里。
    if get_group(conn, group_id).is_none() {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "群不存在：{group_id}"
        )));
    }

    for item in &page.items {
        let blocked = group_message_blocked_by_boundary(conn, group_id, item.seq, &item.kind);
        if blocked {
            stats.blocked_by_boundary += 1;
            continue;
        }
        // 「先撤后到」的同一道闸（口径逐字照抄实时接收那一臂）：本机已经记着这条被撤回，
        // 就以已撤回形态入库，否则同步会把正文原样搬回来。
        // 墓碑命中要**同会话**才算：这张表按 msg_id 建索引（收件热路径），
        // 而历史同步是按会话跑的 ⇒ 这里显式比一次 conv，堵住"A 群的墓碑抹 B 群的行"。
        let (kind, content) = if recall_source(conn, &item.msg_id)
            .map(|(tconv, _)| tconv == conv_id)
            .unwrap_or(false)
        {
            (crate::protocol::KIND_RECALLED.to_string(), String::new())
        } else {
            (item.kind.clone(), item.content.clone())
        };
        let rec = MessageRecord {
            fail_code: None,
            id: 0,
            msg_id: item.msg_id.clone(),
            conv_id: conv_id.clone(),
            sender_id: item.sender_id.clone(),
            receiver_id: me.to_string(),
            kind,
            content,
            ts: item.ts,
            seq: item.seq,
            status: "delivered".to_string(),
            mention_targets: item.mention_targets.clone(),
            local_id: None,
        };
        let inserted = insert_message_if_new(conn, &rec)?;
        if item.seq > stats.max_seq {
            stats.max_seq = item.seq;
        }
        if inserted {
            stats.inserted += 1;
        } else {
            stats.duplicate += 1;
        }
        // 时钟推进对重复行也要做：游标只看源机那一侧，本机自己的 seq 不能被落下。
        observe_clock(conn, &conv_id, item.seq).ok();
    }

    for f in &page.files {
        // 已有就不动：那可能是本机**正在收**的一单（status/progress 是本机的真相），
        // 用源机那份覆盖会把一台正在传输的会话写成别人的终态。
        if get_group_file(conn, &f.transfer_id).is_some() {
            continue;
        }
        let gf = GroupFile {
            transfer_id: f.transfer_id.clone(),
            group_id: group_id.to_string(),
            sender_id: f.sender_id.clone(),
            name: f.name.clone(),
            size: f.size,
            sha256: f.sha256.clone(),
            // 台账行的身份三元组；**不**照抄源机的 status：那是"那一台收到没有"，
            // 与本机的传输状态不是同一件事。也不建 `group_file_recipients` 行 ——
            // 那张表是"这台算不算种子/还欠谁"的名册，替别人写它就是伪造投递记录
            // （口径同 `gfile_ledger_repair`：行不在就不造它）。
            status: "pending".to_string(),
            created_at: if f.created_at > 0 {
                f.created_at
            } else {
                now_ms()
            },
            scope: f.scope.clone(),
            todo_id: f.todo_id.clone(),
        };
        // 认不上身份就**不造这一行，但把它数出来**（`insert_group_file` 有两道闸：群要在册、
        // sender 也要在册 —— 最常见的是"发这个文件的人后来退群了"）。
        // 不许让一格辅助台账把整页历史打死：卡片消息行照样该落（时间线要完整），
        // 而文件本身仍可按 cid 从任何持有者那里拉（受众闸 `content_serve_allowed` 读的
        // 是**内容所属群**的成员表，与这一行台账无关）。
        match insert_group_file(conn, &gf) {
            Ok(()) => stats.files += 1,
            Err(_) => stats.files_skipped += 1,
        }
    }

    if stats.inserted > 0 {
        // 末条摘要**从库里现算**，不取"这一页的最大 seq"：本机可能已经握着比这一页更晚的
        // 消息（补齐是往回拉历史），照页内最大值写就会把列表摘要写成一条早就被盖住的历史。
        // 同一趟重复跑也收敛到同一个值（判据在库里，不在页里）。
        refresh_conversation_head_from_history(conn, &conv_id, "group", group_name)?;
    }
    Ok(stats)
}

/// 把群任务编号的本地高水位**抬到**源机报的那个数（不低于它）。
///
/// 为什么要有这一句：`todo_number_high_water` 的两个来源是"settings 的水位"与
/// "扫消息行里的最大 number"。新成员同步来的历史只覆盖后者，而且如果源机把某条任务
/// 删了，那个号在本机根本看不见 ⇒ 本机下一次建任务会把同一个号再分配一遍，
/// 直接违反 INV-P29「编号永不复用」。
///
/// 只抬不降，也不改分配规则本身（分配仍然只有 `next_todo_number` 那一个家）。
pub fn raise_todo_number_floor(conn: &Connection, group_id: &str, seen: i64) -> Result<()> {
    if seen <= 0 {
        return Ok(());
    }
    let key = todo_number_key(group_id);
    let stored: i64 = get_setting(conn, &key)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if seen > stored {
        set_setting(conn, &key, &seen.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod group_history_db_tests {
    use super::*;
    use crate::db::{
        ensure_conversation, insert_message, set_clear_boundary, MessageRecord, SCHEMA,
    };
    use rusqlite::Connection;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // `apply_group_history_page` 的第一道前置条件就是"本机有这个群的记录"（新成员那边
        // 由入群路径的 `upsert_group` 保证）。夹具不建这一行的话，落库会整页被前置条件挡掉 ——
        // 那是判"群不存在"那条闸，不是判本测试想判的事。
        upsert_group(
            &conn,
            "g1",
            "群",
            "a",
            &["a".to_string(), "b".to_string(), "me".to_string()],
        )
        .unwrap();
        conn
    }

    fn rec(msg_id: &str, seq: i64, ts: i64, kind: &str, content: &str) -> MessageRecord {
        MessageRecord {
            fail_code: None,
            id: 0,
            msg_id: msg_id.into(),
            conv_id: "group:g1".into(),
            sender_id: "a".into(),
            receiver_id: String::new(),
            kind: kind.into(),
            content: content.into(),
            ts,
            seq,
            status: "sent".into(),
            mention_targets: None,
            local_id: None,
        }
    }

    /// 摘要按**逻辑序号**给最早/最晚，不是按 ts（两个数在夹具里刻意相反，
    /// 写反成 MIN(ts)/MAX(ts) 这条就红了）。
    #[test]
    fn summary_counts_by_logical_seq_not_wall_clock() {
        let conn = mem();
        insert_message(&conn, &rec("m1", 3, 9_000, "text", "旧消息但源机时间晚")).unwrap();
        insert_message(&conn, &rec("m2", 7, 1_000, "text", "新消息但源机时间早")).unwrap();
        let s = group_history_summary(&conn, "g1").unwrap();
        assert_eq!(s.total, 2);
        assert_eq!(s.oldest_seq, 3);
        assert_eq!(s.newest_seq, 7);
        // 空群：三个数全 0，不是"最旧 0 / 最新 0 / 条数 0"以外的形状
        let empty = group_history_summary(&mem(), "g-none").unwrap();
        assert_eq!(empty, GroupHistorySummary::default());
    }

    /// keyset 分页：一页一页取，一条不重、一条不漏（这是 `OFFSET` 分页做不到的保证）。
    #[test]
    fn paging_covers_every_row_once_and_stops_at_the_end() {
        let conn = mem();
        for i in 1..=7 {
            insert_message(&conn, &rec(&format!("m{i}"), i, 1_000 + i, "text", "x")).unwrap();
        }
        let mut got: Vec<String> = Vec::new();
        let (mut seq, mut id) = (-1i64, -1i64);
        let mut pages = 0;
        loop {
            let out = serve_group_history_page(&conn, "g1", seq, id, 3).unwrap();
            got.extend(out.page.items.iter().map(|i| i.msg_id.clone()));
            pages += 1;
            assert!(pages < 20, "游标没推进就是活锁：{seq}/{id}");
            if !out.has_more {
                assert_eq!((out.next_seq, out.next_id), (7, 7), "最后一页要停在末行");
                break;
            }
            let before = (seq, id);
            seq = out.next_seq;
            id = out.next_id;
            assert_ne!(before, (seq, id), "has_more 为真时游标必须前进");
        }
        let want: Vec<String> = (1..=7).map(|i| format!("m{i}")).collect();
        assert_eq!(got, want, "顺序与完整性：一条不多一条不少");
    }

    /// 分页期间源机**自己又写了一条**（生产里就是有人在群里说话那一刻），
    /// 已取过的段落不许被错位挤掉 —— 这条是选 keyset 而不是 OFFSET 的全部理由。
    #[test]
    fn a_row_inserted_mid_paging_does_not_shift_the_next_page() {
        let conn = mem();
        for i in 1..=3 {
            insert_message(&conn, &rec(&format!("m{i}"), i, 1_000, "text", "x")).unwrap();
        }
        let first = serve_group_history_page(&conn, "g1", -1, -1, 2).unwrap();
        assert_eq!(first.page.items.len(), 2);
        // 两页之间插一条新的（seq 更大 ⇒ 排在后面）
        insert_message(&conn, &rec("late", 9, 1_000, "text", "分页期间新发的")).unwrap();
        let second =
            serve_group_history_page(&conn, "g1", first.next_seq, first.next_id, 2).unwrap();
        let ids: Vec<String> = second.page.items.iter().map(|i| i.msg_id.clone()).collect();
        assert_eq!(
            ids,
            vec!["m3".to_string(), "late".to_string()],
            "第一页取过的两条不许重现或消失"
        );
        assert!(!second.has_more);
    }

    /// `limit = 0` = 只要摘要：空页、不带文件、`has_more` 假。
    #[test]
    fn zero_limit_answers_summary_only() {
        let conn = mem();
        insert_message(&conn, &rec("m1", 1, 1_000, "text", "x")).unwrap();
        let out = serve_group_history_page(&conn, "g1", -1, -1, 0).unwrap();
        assert!(out.page.items.is_empty());
        assert!(out.page.files.is_empty());
        assert!(!out.has_more);
    }

    /// 文件卡片正文里的本机 `path` 上 wire 之前必须剥掉；非 JSON 正文一个字都不动。
    #[test]
    fn served_card_drops_local_path_but_keeps_other_kinds_verbatim() {
        let conn = mem();
        insert_message(
            &conn,
            &rec(
                "gfile-t1",
                1,
                1_000,
                "file",
                r#"{"name":"a.bin","size":10,"sha256":"aa","path":"/Users/me/Downloads/a.bin"}"#,
            ),
        )
        .unwrap();
        insert_message(&conn, &rec("m2", 2, 1_000, "text", "就是一段文字")).unwrap();
        let out = serve_group_history_page(&conn, "g1", -1, -1, 10).unwrap();
        assert!(
            !out.page.items[0].content.contains("/Users/me"),
            "本机路径不许出现在线上：{}",
            out.page.items[0].content
        );
        assert!(
            out.page.items[0].content.contains("a.bin"),
            "名字/哈希要留着"
        );
        assert_eq!(
            out.page.items[1].content, "就是一段文字",
            "非 JSON 正文原样"
        );
    }

    /// `kind` 原样搬：库里是 `image` 就交 `image`，不许被折成 `file`（那会让同步来的
    /// 一条与实时收到的同一条在库里成两种 kind）。
    #[test]
    fn served_kind_is_not_folded_by_display_kind() {
        let conn = mem();
        insert_message(&conn, &rec("m1", 1, 1_000, "image", "{}")).unwrap();
        let out = serve_group_history_page(&conn, "g1", -1, -1, 10).unwrap();
        assert_eq!(out.page.items[0].kind, "image");
    }

    /// 落库幂等：同一页写两遍，第二遍全是 duplicate，一行不增。
    #[test]
    fn applying_the_same_page_twice_inserts_once() {
        let conn = mem();
        ensure_conversation(&conn, "group:g1", "group", "群", None).unwrap();
        let page = GroupHistoryPage {
            items: vec![
                GroupHistoryItem {
                    msg_id: "s1".into(),
                    sender_id: "a".into(),
                    kind: "text".into(),
                    content: "一".into(),
                    ts: 500,
                    seq: 5,
                    mention_targets: None,
                },
                GroupHistoryItem {
                    msg_id: "s2".into(),
                    sender_id: "b".into(),
                    kind: "text".into(),
                    content: "二".into(),
                    ts: 600,
                    seq: 6,
                    mention_targets: None,
                },
            ],
            files: vec![],
        };
        let first = apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        assert_eq!((first.inserted, first.duplicate), (2, 0));
        let second = apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        assert_eq!(
            (second.inserted, second.duplicate),
            (0, 2),
            "第二遍只认重复"
        );
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conv_id='group:g1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    /// 「老版本只同步了几条、现在信息不全」那一格的正面判据（负责人 2026-10-16 追加手动按钮时补齐）：
    /// 第二趟带进来的是一份**更全**的页 ⇒ 缺的那条补上、已有的一条**一个字都不动**。
    ///
    /// 为什么"已有那条不动"必须单独判：这一族最容易写成的形状是 `INSERT OR REPLACE`
    /// （看着也幂等），但它会把本机那一行的 `status`/`content` 按对端那份盖回去 ——
    /// 表现是"我在这条消息下面已经回复过/它已经撤回过，重跑一次同步又变回原样"。
    #[test]
    fn a_second_full_pass_fills_the_hole_and_touches_nothing_already_there() {
        let conn = mem();
        ensure_conversation(&conn, "group:g1", "group", "群", None).unwrap();
        let item = |id: &str, seq: i64, who: &str, text: &str| GroupHistoryItem {
            msg_id: id.into(),
            sender_id: who.into(),
            kind: "text".into(),
            content: text.into(),
            ts: 1_000 + seq,
            seq,
            mention_targets: None,
        };
        // 第一趟：本机只拿到 seq=5 那一条（老版本同步到的那几条）。
        let partial = GroupHistoryPage {
            items: vec![item("s1", 5, "a", "早就有的一条")],
            files: vec![],
        };
        let first = apply_group_history_page(&conn, "g1", "me", "群", &partial).unwrap();
        assert_eq!((first.inserted, first.duplicate), (1, 0));
        // 本机把自己那条推到 seq=9（对端那份只到 6）⇒ 第二趟必须既补洞又不压本机时钟。
        crate::db::observe_clock(&conn, "group:g1", 9).ok();
        let before: (String, i64, String) = conn
            .query_row(
                "SELECT content,ts,status FROM messages WHERE msg_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();

        let fuller = GroupHistoryPage {
            items: vec![
                item("s1", 5, "a", "早就有的一条"),
                item("s2", 6, "b", "那次错过的一条"),
            ],
            files: vec![],
        };
        let second = apply_group_history_page(&conn, "g1", "me", "群", &fuller).unwrap();
        assert_eq!(
            (second.inserted, second.duplicate),
            (1, 1),
            "缺的那条补上、已有那条认成重复：这就是「只补没有的或错过的」"
        );
        assert_eq!(
            conn.query_row(
                "SELECT content,ts,status FROM messages WHERE msg_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap(),
            before,
            "已有那一行必须逐字不动（本机状态不许被对端那份盖回去）"
        );
        assert_eq!(
            get_clock(&conn, "group:g1"),
            9,
            "本机已经推到 9 ⇒ 补两条旧历史不许把时钟压回去（否则我下一条排到它们前面）"
        );
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conv_id='group:g1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
    }

    /// 保留源机的 `ts`（不是本机收到时刻），并把本机时钟抬到历史之后。
    /// 这两格写反的表现分别是"全部显示刚刚"和"我新发的消息排在旧消息前面"。
    #[test]
    fn apply_keeps_source_timestamp_and_raises_local_clock() {
        let conn = mem();
        let page = GroupHistoryPage {
            items: vec![GroupHistoryItem {
                msg_id: "s1".into(),
                sender_id: "a".into(),
                kind: "text".into(),
                content: "上周说的话".into(),
                ts: 1_600_000_000_000,
                seq: 400,
                mention_targets: None,
            }],
            files: vec![],
        };
        apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        let ts: i64 = conn
            .query_row("SELECT ts FROM messages WHERE msg_id='s1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ts, 1_600_000_000_000, "显示时间必须是源机那一条的时间");
        assert_eq!(
            get_clock(&conn, "group:g1"),
            400,
            "本机时钟必须抬到历史之后"
        );
        let next = crate::db::next_clock(&conn, "group:g1").unwrap();
        assert!(
            next > 400,
            "本机之后发的消息要排在同步历史后面，实测 {next}"
        );
    }

    /// 本机清空过这个群 ⇒ 水位之前的历史**不得复活**，但仍算"这一页处理过了"。
    #[test]
    fn cleared_history_stays_cleared_after_a_sync() {
        let conn = mem();
        set_clear_boundary(&conn, "g1", 100).unwrap();
        let page = GroupHistoryPage {
            items: vec![
                GroupHistoryItem {
                    msg_id: "old".into(),
                    sender_id: "a".into(),
                    kind: "text".into(),
                    content: "清掉的旧消息".into(),
                    ts: 1,
                    seq: 100,
                    mention_targets: None,
                },
                GroupHistoryItem {
                    msg_id: "new".into(),
                    sender_id: "a".into(),
                    kind: "text".into(),
                    content: "清掉之后说的话".into(),
                    ts: 2,
                    seq: 101,
                    mention_targets: None,
                },
            ],
            files: vec![],
        };
        let st = apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        assert_eq!(st.blocked_by_boundary, 1);
        assert_eq!(st.inserted, 1);
        assert!(
            !crate::db::message_exists(&conn, "old"),
            "水位下的那条不许回来"
        );
        assert!(crate::db::message_exists(&conn, "new"));
    }

    /// 会话行不存在 ⇒ 由聊天活动建出来、**未读为 0**，末条时间用的是**那条消息自己的 ts**
    /// （不是同步时刻 —— 补的是历史，把它写成"刚刚"会凭空插到列表最前）。
    /// 会话行**已经存在** ⇒ 末条摘要照样按补齐后的真实末条重算（审计 A1：不许因为行已存在
    /// 而跳过更新），但 `unread` 一格不动。
    #[test]
    fn history_sync_recomputes_the_head_but_never_the_unread() {
        let conn = mem();
        let item = |msg_id: &str, kind: &str, content: &str, ts: i64, seq: i64| GroupHistoryItem {
            msg_id: msg_id.into(),
            sender_id: "a".into(),
            kind: kind.into(),
            content: content.into(),
            ts,
            seq,
            mention_targets: None,
        };
        apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &GroupHistoryPage {
                items: vec![item("s1", "text", "你好", 1, 1)],
                files: vec![],
            },
        )
        .unwrap();
        let conv = get_conversation(&conn, "group:g1").expect("会话行要由聊天活动建出来");
        assert_eq!(conv.unread, 0, "同步来的历史不该变成一排未读红点");
        assert_eq!(conv.last_msg.as_deref(), Some("你好"));
        assert_eq!(
            conv.last_ts,
            Some(1),
            "末条时间必须是那条消息自己的 ts：写 now 就是把一趟历史同步伪装成刚发生的活动"
        );

        // 现场二：会话行已经存在，且手里挂着一格陈旧摘要 + 一条真未读。
        let set = conn
            .execute(
                "UPDATE conversations SET last_msg='陈年旧事', last_ts=9, unread=3 WHERE id='group:g1'",
                [],
            )
            .unwrap();
        assert_eq!(
            set, 1,
            "夹具必须真的改到那一行，否则下面的断言是在判一次空写"
        );
        let st = apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &GroupHistoryPage {
                items: vec![item("s2", "text", "第二条", 2, 2)],
                files: vec![],
            },
        )
        .unwrap();
        assert_eq!(st.inserted, 1);
        let after = get_conversation(&conn, "group:g1").unwrap();
        assert_eq!(
            after.last_msg.as_deref(),
            Some("第二条"),
            "已有会话行也要把末条摘要挪到补齐后的真实末条（审计 A1）"
        );
        assert_eq!(
            after.last_ts,
            Some(2),
            "排序键跟着真实末条走，同样不许写成同步时刻"
        );
        assert_eq!(
            after.unread, 3,
            "补齐一格未读都不许加：新未读只能由实时投递那一条路径产生"
        );
    }

    /// 补齐**更早**的历史不动末条 / 重复补齐幂等 / 群任务卡片按 `[任务] …` 进摘要 /
    /// 静默事件（回应）不当末条 —— 审计 A1 余下四条要求一次判完。
    ///
    /// 夹具把 `seq` 与 `ts` 刻意拧着种（时间线按 `seq` 排 ⇒ 摘要必须跟着 `seq` 那份顺序）：
    /// 写反成"按 ts 取末条"，第一条断言就红。
    #[test]
    fn the_head_follows_the_logical_clock_and_ignores_silent_rows() {
        let conn = mem();
        ensure_conversation(&conn, "group:g1", "group", "群", None).unwrap();
        // 本机实时路径已经握着 seq=9 这条（它的 ts 比后面要补的页里所有行都晚）。
        insert_message(&conn, &rec("live", 9, 90_000, "text", "本机最新")).unwrap();
        let head = |conn: &Connection| {
            let c = get_conversation(conn, "group:g1").unwrap();
            (c.last_msg, c.last_ts, c.unread)
        };
        let page = |rows: Vec<(&str, &str, &str, i64, i64)>| GroupHistoryPage {
            items: rows
                .into_iter()
                .map(|(msg_id, kind, content, ts, seq)| GroupHistoryItem {
                    msg_id: msg_id.into(),
                    sender_id: "a".into(),
                    kind: kind.into(),
                    content: content.into(),
                    ts,
                    seq,
                    mention_targets: None,
                })
                .collect(),
            files: vec![],
        };

        // ① 补一页全都比 seq=9 早的历史：末条与时间都不许动（真实末条还是"本机最新"）。
        apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &page(vec![
                ("b1", "text", "更早的一条", 10, 3),
                ("b2", "file", "{\"name\":\"a.pdf\"}", 20, 4),
            ]),
        )
        .unwrap();
        assert_eq!(
            head(&conn),
            (Some("本机最新".into()), Some(90_000), 0),
            "补进来的历史比现状更早 ⇒ 列表那一行一个字都不该变"
        );

        // ② 同一页再跑一遍（重复补齐）：一条不新增，那一行照样不动。
        let again = apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &page(vec![
                ("b1", "text", "更早的一条", 10, 3),
                ("b2", "file", "{\"name\":\"a.pdf\"}", 20, 4),
            ]),
        )
        .unwrap();
        assert_eq!(
            (again.inserted, again.duplicate),
            (0, 2),
            "重复页要全判成 duplicate"
        );
        assert_eq!(
            head(&conn),
            (Some("本机最新".into()), Some(90_000), 0),
            "重复补齐必须幂等：错预览/错排序就是这么造出来的"
        );

        // ③ 群任务卡片当末条：预览用 `preview_text` 那一份口径（`[任务] 标题`），
        //    时间用卡片自己的 ts。
        apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &page(vec![(
                "t1",
                "todo",
                "{\"todo_id\":\"t1\",\"title\":\"买牛奶\",\"number\":7,\"status\":\"open\"}",
                5_000,
                10,
            )]),
        )
        .unwrap();
        assert_eq!(
            head(&conn),
            (Some("[任务] 买牛奶".into()), Some(5_000), 0),
            "群任务也是真实末条：摘要要按卡片口径显示，排序按它自己的时间"
        );

        // ④ 只有静默事件的一页（表情回应）：行要落库，但那一条**不能**当末条。
        let silent = apply_group_history_page(
            &conn,
            "g1",
            "me",
            "群",
            &page(vec![(
                "r1",
                "reaction",
                "{\"target\":\"t1\",\"emoji\":\"[赞]\",\"add\":true}",
                6_000,
                11,
            )]),
        )
        .unwrap();
        assert_eq!(silent.inserted, 1, "夹具没落库的话下面那条断言就是在判空写");
        assert_eq!(
            head(&conn),
            (Some("[任务] 买牛奶".into()), Some(5_000), 0),
            "静默事件不改会话摘要（与实时接收那一臂同判据），未读也一格不动"
        );
    }

    /// 群文件台账：缺的行补上（status 是本机的 pending，不照抄源机），
    /// 已有的行**一个字不改**（那可能是本机正在收的一单）。
    #[test]
    fn file_ledger_rows_are_seeded_without_overwriting_local_state() {
        let conn = mem();
        let local = GroupFile {
            transfer_id: "t1".into(),
            group_id: "g1".into(),
            sender_id: "a".into(),
            name: "本机在收.bin".into(),
            size: 1,
            sha256: "aa".into(),
            status: "sending".into(),
            created_at: 7,
            scope: "chat".into(),
            todo_id: String::new(),
        };
        insert_group_file(&conn, &local).unwrap();
        let page = GroupHistoryPage {
            items: vec![],
            files: vec![
                GroupHistoryFile {
                    transfer_id: "t1".into(),
                    sender_id: "a".into(),
                    name: "源机说已完成.bin".into(),
                    size: 999,
                    sha256: "zz".into(),
                    scope: "chat".into(),
                    todo_id: String::new(),
                    created_at: 3,
                },
                GroupHistoryFile {
                    transfer_id: "t2".into(),
                    sender_id: "b".into(),
                    name: "没见过的.bin".into(),
                    size: 20,
                    sha256: "bb".into(),
                    scope: "chat".into(),
                    todo_id: String::new(),
                    created_at: 4,
                },
                // 发这个文件的人早已退群（`insert_group_file` 要求 sender 在册）⇒
                // 这一格补不了，但必须**数出来**，而且不许把整页历史一起打死。
                GroupHistoryFile {
                    transfer_id: "t3".into(),
                    sender_id: "ghost".into(),
                    name: "发件人已退群.bin".into(),
                    size: 30,
                    sha256: "dd".into(),
                    scope: "chat".into(),
                    todo_id: String::new(),
                    created_at: 5,
                },
            ],
        };
        let st = apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        assert_eq!(st.files, 1, "只补缺的那一条（t2）");
        assert_eq!(
            st.files_skipped, 1,
            "认不上身份的那一条要数得出来，不许静默吞掉"
        );
        assert!(
            crate::db::get_group_file(&conn, "t3").is_none(),
            "退群那一台的身份不许被我们替他造出来"
        );
        let kept = crate::db::get_group_file(&conn, "t1").unwrap();
        assert_eq!(kept.size, 1, "本机那一行不许被源机的覆盖");
        assert_eq!(kept.status, "sending");
        let seeded = crate::db::get_group_file(&conn, "t2").unwrap();
        assert_eq!(
            seeded.status, "pending",
            "补的行是本机自己的起点，不照抄源机终态"
        );
        assert_eq!(seeded.created_at, 4, "创建时间用源机那一条，文件列表按它排");
        // 不造 recipient 名册：那是"这台算不算种子/还欠谁"，替别人写就是伪造投递记录
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM group_file_recipients", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0);
    }

    /// 被撤回的墓碑优先：本机已经记着这条被撤回 ⇒ 同步进来也只能是已撤回形态。
    #[test]
    fn a_known_recall_is_not_resurrected_as_plaintext() {
        let conn = mem();
        insert_recall(&conn, "group:g1", "s1", "a", 3).unwrap();
        let page = GroupHistoryPage {
            items: vec![GroupHistoryItem {
                msg_id: "s1".into(),
                sender_id: "a".into(),
                kind: "text".into(),
                content: "本来被撤回的正文".into(),
                ts: 1,
                seq: 3,
                mention_targets: None,
            }],
            files: vec![],
        };
        apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        let kind: String = conn
            .query_row("SELECT kind FROM messages WHERE msg_id='s1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(kind, crate::protocol::KIND_RECALLED);
    }

    /// 编号地板：只抬不降，且 `<= 0` 一个字都不写（老对端没带这一格时不能把水位清成 0）。
    #[test]
    fn todo_floor_only_raises_and_ignores_a_missing_field() {
        let conn = mem();
        raise_todo_number_floor(&conn, "g1", 9).unwrap();
        assert_eq!(todo_number_high_water(&conn, "g1"), 9);
        raise_todo_number_floor(&conn, "g1", 4).unwrap();
        assert_eq!(todo_number_high_water(&conn, "g1"), 9, "不许把地板降回去");
        raise_todo_number_floor(&conn, "g1", 0).unwrap();
        assert_eq!(
            crate::db::get_setting(&conn, &todo_number_key("g1")).as_deref(),
            Some("9"),
            "缺省/0 不许写成 0"
        );
        // 抬完以后分配要跳过去（这才是 INV-P29 要的那件事）
        assert_eq!(next_todo_number(&conn, "g1").unwrap(), 10);
    }

    /// 「清空聊天记录」那道水位**只管时间线上的气泡**，不许把群级沉淀物一起挡掉 ——
    /// 群任务(`todo`)与公告(`announcement`)是 Card 类，各成员必须看到同一份。
    /// 这一条是"同一个开关的另一个面"：`cleared_history_stays_cleared_after_a_sync` 钉住了
    /// Bubble 被挡，而只测那一面时，把 `group_message_blocked_by_boundary` 写成"一律挡"
    /// 会让**所有**新成员的群任务永远同步不过来（症状是"群任务列表是空的"，很难归因）。
    #[test]
    fn cleared_boundary_does_not_block_group_tasks_or_announcements() {
        let conn = mem();
        set_clear_boundary(&conn, "g1", 100).unwrap();
        let mk = |msg_id: &str, seq: i64, kind: &str| GroupHistoryItem {
            msg_id: msg_id.into(),
            sender_id: "a".into(),
            kind: kind.into(),
            content: match kind {
                "todo" => format!(r#"{{"todo_id":"{msg_id}","title":"买牛奶","number":{seq}}}"#),
                _ => "沉淀物".into(),
            },
            ts: 1,
            seq,
            mention_targets: None,
        };
        let page = GroupHistoryPage {
            items: vec![
                mk("bubble", 50, "text"),
                mk("task", 60, "todo"),
                mk("ann", 70, "announcement"),
            ],
            files: vec![],
        };
        let st = apply_group_history_page(&conn, "g1", "me", "群", &page).unwrap();
        assert_eq!(st.blocked_by_boundary, 1, "只有那条气泡被水位挡住");
        assert_eq!(st.inserted, 2, "群任务与公告必须同步过来");
        assert!(crate::db::message_exists(&conn, "task"));
        assert!(crate::db::message_exists(&conn, "ann"));
        // 编号也跟着这一条落库走：高水位扫消息行，所以同步来的 #60 之后本机该分配 #61
        assert_eq!(next_todo_number(&conn, "g1").unwrap(), 61);
    }

    /// 台账那两格预算：**条数封顶**（超出第一页只带 `GROUP_HISTORY_PAGE_ITEMS` 行、
    /// 剩下的**数出来**不静默丢），并且台账的字节**算进同一份**页预算。
    ///
    /// 后面那一半是本机评审轮补的判据：原来预算只累计条目字节 ⇒ 一群几千个文件就能把
    /// "1.5MB 一页"撑成几十 MB 的一帧，而接收侧是握着全局 db 锁逐行插的 ——
    /// 那正是本需求要避开的卡顿，也是"一份预算只有一个家"（INV-P23）被破掉的样子。
    #[test]
    fn served_file_ledger_is_capped_and_shares_the_page_byte_budget() {
        use crate::protocol::GROUP_HISTORY_PAGE_ITEMS;
        let conn = mem();
        let big = "x".repeat(10_000);
        for i in 0..(GROUP_HISTORY_PAGE_ITEMS as i64 + 3) {
            let gf = GroupFile {
                transfer_id: format!("t{i}"),
                group_id: "g1".into(),
                sender_id: "a".into(),
                name: format!("{big}-{i}.bin"),
                size: 1,
                sha256: "aa".into(),
                status: "completed".into(),
                created_at: i,
                scope: "chat".into(),
                todo_id: String::new(),
            };
            insert_group_file(&conn, &gf).unwrap();
        }
        // 4 条正文 + 203 行台账：台账单独就已经越过页预算
        for i in 1..=4 {
            insert_message(&conn, &rec(&format!("m{i}"), i, 1_000 + i, "text", "hi")).unwrap();
        }
        let out = serve_group_history_page(&conn, "g1", -1, -1, GROUP_HISTORY_PAGE_ITEMS).unwrap();
        assert_eq!(
            out.files_dropped, 3,
            "封顶之外的那 3 行必须被数出来，不许静默丢"
        );
        assert_eq!(out.page.files.len(), GROUP_HISTORY_PAGE_ITEMS as usize);
        assert_eq!(
            out.page.items.len(),
            1,
            "台账已把预算吃满时仍要**至少给一条**（给 0 条 = 游标永不前进 = 活锁）；\
             而这条只有把台账字节算进同一份预算才成立 —— 老写法这里会是 4 条、整页越过上限"
        );
        assert!(out.has_more, "还有正文没给完，必须报 has_more");
    }

    /**
     * 这一条是本轮跑出来的实测事实，不是设想：`insert_group_file` 自己带一道
     * "群不存在就不写"的闸（报 `InvalidParameterName("群不存在：g1")`），
     * 与 `update_group_file_recipient` 不静默造群外 state 同一条口径。
     * 这里把它钉住两件事：
     *   ① 历史同步不会替一个本机已经没有的群凭空造出台账行；
     *   ② `apply_group_history_page` 把它当故障往外抛 ⇒ 引擎那侧走"没收口"分支、
     *      **不写完成标记**（写成 `Ok` 就等于把"这一群我其实没同步成"说成"同步过了"）。
     */
    #[test]
    fn a_group_row_that_no_longer_exists_blocks_the_whole_page_and_the_error_reaches_the_caller() {
        let conn = mem();
        let page = GroupHistoryPage {
            items: vec![GroupHistoryItem {
                msg_id: "s1".into(),
                sender_id: "a".into(),
                kind: "text".into(),
                content: "已经退群了还收到的历史".into(),
                ts: 1,
                seq: 3,
                mention_targets: None,
            }],
            files: vec![GroupHistoryFile {
                transfer_id: "t9".into(),
                sender_id: "a".into(),
                name: "无主的文件.bin".into(),
                size: 5,
                sha256: "cc".into(),
                scope: "chat".into(),
                todo_id: String::new(),
                created_at: 1,
            }],
        };
        let err = apply_group_history_page(&conn, "g-gone", "me", "群", &page)
            .expect_err("群行不在时必须报 Err，不能静默跳过");
        assert!(
            err.to_string().contains("群不存在"),
            "报错原因要带着那句闸的话，实测：{err}"
        );
        let files: i64 = conn
            .query_row("SELECT COUNT(*) FROM group_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(files, 0, "一格台账都不许写进去");
        // ★ 这一格才是这条判据真正新增的东西：前置条件在**任何写之前**判。
        // 只靠下面那条文件台账的闸顺带失败，那么"这一页恰好没有文件行"时
        // 消息就会一路写进一个本机已经退出的群 —— 那正是 `delete_group` 刚清掉的东西。
        let msgs: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(msgs, 0, "群行不在时一条消息都不许落库");
    }
}
