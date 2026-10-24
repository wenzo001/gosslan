// 职责边界：
// - 文件传输记录（FileTransfer CRUD）
// ---------------- 文件传输记录 ----------------

#[allow(clippy::too_many_arguments)]
pub fn upsert_transfer(
    conn: &Connection,
    id: &str,
    peer_id: &str,
    name: &str,
    size: u64,
    direction: &str,
    status: &str,
    path: Option<&str>,
    progress: f64,
) -> Result<()> {
    // ⚠️ path 用 COALESCE：进度节流的 upsert 一律传 path=None，没有 COALESCE 时
    // 第一次进度 tick 就把建行时写入的本地路径擦成 NULL。前端把 `file_transfers.path`
    // 当作 content 缺 path 时的唯一兜底来源（useMessageFile），群图片预览失效的机制
    // 就有它一份。写法与 content_transfers 保持同口径。
    //
    // ★ `WHERE file_transfers.status <> 'done'` 是**终态契约**（第 4 步 P7）：本函数有 39 个
    //   调用点（其中 12 处写 failed、12 处写 active），任何一处晚到一步 —— 清扫器、重复帧、
    //   上一轮 attempt 还堵在链路队列里的残留 —— 都会把"已收到"改成"失败"并把进度从 100%
    //   打回 0%，而那个文件此刻正躺在下载目录里能打开。
    //   集合刻意**只含 `done`**：`failed` / `cancelled` / `pending` 都必须还能被新一轮
    //   attempt 改回 active（`retry_incomplete_content` 复用同一个 transfer_id），
    //   把它们一起钉死就是"一判死永远停在失败"。判据见
    //   `cascade_tests::a_completed_transfer_row_is_never_downgraded`（正向）与
    //   `cascade_tests::a_failed_row_can_be_reactivated_by_the_next_attempt`（反向，
    //   专门给"顺手扩大集合"的下一次准备）。
    //
    //   `cancel_terminal=1` 是**唯一例外**：只有用户/对端主动取消会置位；它必须挡住
    //   后续 active/done 的晚到写，否则取消只是界面状态。自动 failed（超时/放弃）
    //   不置位，仍可续传。
    conn.execute(
        "INSERT INTO file_transfers(id, peer_id, name, size, direction, status, path, progress, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status,
             size = excluded.size,
             path = COALESCE(excluded.path, file_transfers.path),
             progress = excluded.progress
         WHERE file_transfers.status <> 'done' AND file_transfers.cancel_terminal = 0",
        params![id, peer_id, name, size as i64, direction, status, path, progress, now_ms()],
    )?;
    Ok(())
}

/// 取单条 transfer 的本地 path（群文件离线投递时校验源文件仍在）。
pub fn get_transfer_path(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT path FROM file_transfers WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// 这一单在本机台账里的**方向 + 对端**（`send` / `receive`，对端 = 那条 `peer_id`）。
///
/// 取消入口按它分派（B3a/B3）：
///  · 接收中的那一单没有"在途发送任务"可通知，取消的含义是"本机停手"；
///  · 要不要给对端发 `FileCancel`、发给谁，也只看这两个字段 —— 所以它们必须一次读回来，
///    分两次读就有"方向是 send、对端却是另一单"的窗口（`peer_id` 与 `direction` 同一行）。
/// 读不到行 = 不是本机记过账的单（取消照样落台账，只是没地方发通知）。
pub fn get_transfer_route(conn: &Connection, id: &str) -> Option<(String, String)> {
    conn.query_row(
        "SELECT direction, peer_id FROM file_transfers WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// 只把**仍处 active** 的传输行标为 failed，返回是否有行被改。
///
/// 回收中继态时给接收端一个显式失败终态（2026-09-23 审计 A2：旧行为只从内存
/// retain 掉，DB 行永远停在 active/某个百分比，前端永久卡 X%）。只改 active 行：
/// done/failed 等既有终态不许被回收动作改写。
pub fn mark_transfer_failed_if_active(conn: &Connection, id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE file_transfers SET status = 'failed', progress = 0.0
         WHERE id = ?1 AND status = 'active'",
        params![id],
    )?;
    Ok(n > 0)
}

/// 启动复位：把上一个进程留在途中的接收行落 `failed`（2026-10-22 审计 R-14）。
///
/// 为什么必须有：启动的两条崩溃恢复只碰 `file_outbox`（sending→pending）与
/// `messages`（孤儿 sending→failed），而后者那段 SQL **显式排除** `file-%` / `gfile-%`。
/// 于是 SIGKILL / 断电之后没有任何东西会把 `file_transfers` 的 `active` 行推进终态：
/// 内存里的接收器随进程没了、`.part` 还在、对端也不一定会再来敲同一单，
/// 而前端把 `status='active'` 直接画成进度条（不看年龄、也没有心跳）⇒ 卡片**永远**显示
/// 「接收中 X%」，直到用户重启应用。这正是"只能靠重启恢复"那一族里最容易自己撞到的一条。
///
/// 只改 `active`：done/failed/cancelled 等既有终态不许被启动动作改写。
/// **不碰 `content_transfers`**：那张表的 `queued/active/incomplete` 是
/// `list_resumable_for_peer` 的续传队列（建链时自动重试），启动即判死会真的打掉断点续传。
/// 本表也不影响续传：`resume_receive` 的闸门是磁盘上的 `.part` + 24h TTL，
/// 而对端真的重来时，`:35` 的 upsert 会把这一行的 status 写回去。
pub fn fail_interrupted_transfers_on_startup(conn: &Connection) -> Result<usize> {
    let rows = conn.execute(
        "UPDATE file_transfers SET status = 'failed', progress = 0.0
         WHERE status = 'active'",
        [],
    )?;
    Ok(rows)
}

/// 一单文件"从此不再重发"的三种原因 —— 落库形状相同、口径不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileJobEnd {
    /// 超时（outbox 清扫器判死）
    Expired,
    /// 重试耗尽 / 明确不可重试的错误（发送侧放弃）
    GiveUp,
    /// 用户主动取消
    Cancelled,
}

impl FileJobEnd {
    fn status(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Expired | Self::GiveUp => "failed",
        }
    }
}

/// **三份收尾合并成一份**（第 4 步 P7）：文件队列任务的终态落库只有这一个出口。
///
/// 合并之前有三份各写一遍的实现（清扫器 / 发送放弃 / 用户取消），后果都实测到了：
///  · "把行踢出重试集合的那一步排最后"这条规矩只在其中两处成立（第三刀修的正是那两处）；
///  · `done` 不可降级（INV-P26）的闸门只装在两扇门上，清扫器那扇没有；
///  · 清扫器还多写了一句 `gfile-` —— 群文件的气泡不归这条路径管（群文件的逐人台账在
///    `group_file_recipients`），今天撞不到只是因为没人往 `file_outbox` 写 `group_id`。
///
/// ★ 顺序与"关行"的条件都是语义，不是风格：气泡 → 台账 → **只有面向用户的写都落地了**
/// 才关队列行。`mark_file_outbox_*` 一跑，`list_expired_file_outbox` 就再也扫不到这一行，
/// 所以前面任何一步失败时它必须**还在**集合里，否则"返回 false、下一 tick 再试"是假话
/// （审计 A3 的自身缺陷；判据 `finalize_expired_file_failure_leaves_the_row_retryable`）。
/// 唯一的例外是"台账已 done"：那时没有任何面向用户的写要做，行必须关掉 ——
/// 不然它每个 tick 被重扫一遍又什么都不做（活锁）。
///
/// 台账那一笔写刻意走 `upsert_transfer` 而不是"返回改动与否"的助手：后者在**台账行不存在**时
/// 报 false，会让上面的关行条件永不成立 ⇒ 清扫器空转。少一次 emit 不值得换来一个活锁，
/// 而"不许把 done 降级"这件事由 `upsert_transfer` 自己守（INV-P26）。
///
/// 返回 `true` = 面向用户的状态真的推进了 ⇒ 调用方据此决定要不要 emit。
///
/// SOL-03（2026-10-24 审计）：**这一次的四笔写放进同一个事务** —— 气泡、台账、墓碑、
/// 关队列行要么一起落地，要么一起不动。此前它们是四条独立语句，中间任一失败都会留下
/// "界面已取消、台账还在发送中"（FUNC-02）；现在失败会整体回滚并把 `Err` 交给调用方，
/// 调用方记 `CANCEL_COMMIT_FAILED` 并让界面说"本地已停止、台账待重试"。
pub fn finalize_file_failure(
    conn: &Connection,
    transfer_id: &str,
    end: FileJobEnd,
) -> Result<bool> {
    let status = end.status();
    let cancelled = end == FileJobEnd::Cancelled;
    // 读失败当作"没收成"继续判失败 —— 那正是加这道闸门之前的行为：宁可维持现状，
    // 也不要在读不到状态时静默放过一个真的失败。
    let already_done = is_transfer_done(conn, transfer_id).unwrap_or(false);

    let tx = conn.unchecked_transaction()?;

    let mut changed = false;
    if !already_done || cancelled {
        // 取消是用户动作：界面必须立刻响应。已 done 的行不会被真降级（闸门在 upsert 里）。
        // 两处气泡分开记：`file-` 是 1:1 那一半，`gfile-` 是群那一半。
        let file_bubble =
            set_message_status(&tx, &format!("file-{transfer_id}"), status)? > 0;
        // `gfile-` 只在取消时写：取消入口是 1:1 与群文件**共用**的（用户取消整条消息），
        // 而超时/放弃只代表"某一个收件人没收到"，群气泡由 `group_file_recipients` 决定。
        // 两个方向各有判据：`expired_file_does_not_touch_the_group_bubble` /
        // `a_cancelled_group_file_marks_its_own_bubble`。
        let group_bubble = cancelled
            && set_message_status(&tx, &format!("gfile-{transfer_id}"), status)? > 0;
        // FUNC-03：**只有 1:1 那一半真的存在时才写 `file_transfers`**。
        // `upsert_transfer` 的语义是无则插入 —— 只看"有没有气泡"（旧代码用
        // `set_message_status(..).is_ok()`，无匹配行也是 Ok）会为一条只在 `group_files`
        // 里存在的群文件插出 peer_id/name 全空的幽灵行。群文件的台账在
        // `group_files` / `group_file_recipients`，这里不该有它。
        //
        // `file_outbox` 也算"这一单存在"：它有队列行 ⇒ 清扫器还扫得到它，必须有人收尾
        // （那条行不存在时 `upsert_transfer` 报 false，会让关行条件永不成立 ⇒ 清扫器空转）。
        let has_ledger = transfer_row_exists(&tx, transfer_id)?;
        let has_queue = file_outbox_row_exists(&tx, transfer_id)?;
        if file_bubble || has_ledger || has_queue {
            // 终态写入不知道"这次传了多大"，必须沿用台账里已知的 size：A-11 之后
            // `upsert_transfer` 的冲突分支会同步 size，原样传 0 会把已知大小抹掉。
            let known_size: u64 = tx
                .query_row(
                    "SELECT size FROM file_transfers WHERE id = ?1",
                    params![transfer_id],
                    |r| r.get::<_, i64>(0),
                )
                .map(|v| v.max(0) as u64)
                .unwrap_or(0);
            upsert_transfer(
                &tx,
                transfer_id,
                "",
                "",
                known_size,
                "send",
                status,
                None,
                0.0,
            )?;
        }
        // 面向用户的状态真的推进了吗：1:1 气泡、群气泡、或这一单确实有台账/队列行要收尾。
        // 三者都没有（只在 `group_files` 里、且连群气泡都还没有）= 界面看不见这一单，
        // 那就什么都不写、也回报 false（群文件不走 `file_outbox`）。
        changed = file_bubble || group_bubble || has_ledger || has_queue;
    }

    if changed || already_done {
        // 主动取消的终态墓碑。三条限制都是语义：
        //  · `cancelled`：自动超时/重试耗尽**不盖**墓碑 —— 那些行要能被下一轮 attempt
        //    复活（断点续传 + `retry_incomplete_content` 复用同一个 transfer_id）。
        //  · `changed`：只对真的推进了的状态写，失败重放时不重复盖。
        //  · `!already_done`：已收完的那一单没有"被取消"这回事。注意 `changed` 在 done 行上
        //    也可以是 true（`upsert_transfer` 被 `status <> 'done'` 挡住时返回 Ok 且改 0 行），
        //    所以这一条必须单独判，否则一个"已送达"的行会带着墓碑被读成"已取消"。
        //    判据：`cascade_tests::a_cancel_on_an_already_done_transfer_writes_no_tombstone`。
        // 顺序：墓碑 → 关队列行 —— 关行是破坏性写，永远排最后。
        if cancelled && changed && !already_done {
            tx.execute(
                "UPDATE file_transfers SET cancel_terminal = 1 WHERE id = ?1",
                params![transfer_id],
            )?;
        }
        // ★ 永远排在最后
        match end {
            FileJobEnd::Cancelled => mark_file_outbox_cancelled(&tx, transfer_id)?,
            _ => mark_file_outbox_failed(&tx, transfer_id)?,
        }
    }
    tx.commit()?;
    Ok(changed)
}

/// 台账里是否**已有**这一单的行（只判存在，不判状态）。
///
/// 收尾路径用它区分"更新一行"与"凭空插一行"（FUNC-03 的幽灵行判据）。
fn transfer_row_exists(conn: &Connection, id: &str) -> Result<bool> {
    let row = conn
        .query_row(
            "SELECT 1 FROM file_transfers WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?;
    Ok(row.is_some())
}

/// 队列里是否还有这一单（`file_outbox` 只在单聊文件发送时写；群文件不走这张表）。
///
/// 它也是"这一单存在"的证据：队列行还在 ⇒ 清扫器还会扫到它，收尾必须真的做一次，
/// 否则 `list_expired_file_outbox` 每个 tick 重扫一行又什么都不做（活锁）。
fn file_outbox_row_exists(conn: &Connection, id: &str) -> Result<bool> {
    let row = conn
        .query_row(
            "SELECT 1 FROM file_outbox WHERE transfer_id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?;
    Ok(row.is_some())
}

/// 该传输是否已完整收下（status='done'）。Offer 判据的单行查询（审计 A6）。
///
/// 不用 `list_transfers()` 全表扫：那是在 db 锁内按行数收费，而 Offer 每收到一次
/// 就扫一遍，`file_transfers` 恰好是随使用单调增长的表。
///
/// `Err` 交给调用方裁决（不折叠成 `false`）：`false` 在这里意味着「还要收」，
/// 判错方向会让已完成的文件重传落一份"名字(1)"副本，必须留痕。
pub fn is_transfer_done(conn: &Connection, id: &str) -> Result<bool> {
    let n = conn.query_row(
        "SELECT 1 FROM file_transfers WHERE id = ?1 AND status = 'done'",
        params![id],
        |_| Ok(()),
    )
    .optional()?;
    Ok(n.is_some())
}

/// 终态行（`done` / `failed` / `sent` / `cancelled`）最多带回多少条。
///
/// DB-03：`file_transfers` 是**只增**的历史表（没有清理策略），而这条读在每次文件活动后
/// 都会被前端拉一遍（`get_transfers` → `refreshTransfers`），并且持着那唯一一条 db 连接。
/// 无上限 ⇒ 打开任务中心的代价随使用时长线性增长。
///
/// 200 是"够用但不必长大"的一档：前端真正要的是**未完成**（任务中心只列那一半），
/// 加上最近几条终态给气泡一句话（`failed` / `cancelled` 才有状态文案，`done`/`sent` 本来就不写）；
/// 更早的终态行在界面上没有任何一处会显示 —— 而**点开文件**那条路是按 msg_id 回后端查台账
/// （`open_file_native` / `resolve_media_path`），不依赖这份快照。
pub const MAX_TERMINAL_TRANSFERS: usize = 200;

/// 传输台账快照：**未完成一条不丢 + 最近 `MAX_TERMINAL_TRANSFERS` 条终态**。
///
/// 分成两腿是刻意的（DB-03）：
///  · 未完成（`pending` / `active`）走 `idx_file_transfers_open` 这个部分索引，命中行少且全要；
///  · 终态走 `idx_file_transfers_created` 按 `created_at DESC` 扫，凑够 N 条就停。
/// 单条 SQL 做不到"两半各自有界"：`ORDER BY created_at DESC` 加一个总 `LIMIT` 会把
/// 一条在途传输挤掉（它可能排得很靠后，而界面正靠它画进度条）。
pub fn list_transfers(conn: &Connection) -> Result<Vec<TransferInfo>> {
    list_transfers_with_terminal_cap(conn, MAX_TERMINAL_TRANSFERS)
}

/// 台账快照的生产 SQL（`?1` = now，`?2` = outbox 重试上限，`?3` = 终态条数上限）。
///
/// 抽成常量只为**读取计划能被测试盯住**（`migration_tests::transfer_snapshot_plan_uses_both_indexes`
/// 拿这同一份 SQL 跑 `EXPLAIN QUERY PLAN`）—— 测试里另抄一遍就等于给这条查询第二个家。
pub(crate) const LIST_TRANSFERS_SQL: &str = "WITH picked AS (
            SELECT id, created_at FROM file_transfers
             WHERE status IN ('pending','active')
            UNION ALL
            SELECT id, created_at FROM (
                SELECT id, created_at FROM file_transfers
                 WHERE status NOT IN ('pending','active')
                 ORDER BY created_at DESC
                 LIMIT ?3
            )
         )
         SELECT t.id, t.peer_id, t.name, t.size, t.direction, t.status, t.path, t.progress,
                CASE
                  WHEN t.direction = 'send' AND t.status = 'pending' AND o.transfer_id IS NULL
                    THEN 'queue_missing'
                  WHEN t.direction = 'send' AND t.status = 'pending' AND o.status IN ('failed','cancelled')
                    THEN 'queue_closed'
                  WHEN t.direction = 'send' AND t.status = 'pending' AND o.status = 'pending'
                       AND o.attempts >= ?2
                    THEN 'retry_exhausted'
                  WHEN t.direction = 'send' AND t.status = 'pending' AND o.next_attempt_at > ?1
                    THEN 'waiting_retry'
                  ELSE NULL
                END,
                t.created_at
         FROM picked p
         JOIN file_transfers t ON t.id = p.id
         LEFT JOIN file_outbox o ON o.transfer_id = t.id
         ORDER BY p.created_at DESC";

/// `list_transfers` 的可调上限版本（测试用它把"截断"跑在小数据上）。
///
/// 生产调用一律走 [`list_transfers`]；**不提供 OFFSET** —— 截断掉的那些终态行在界面上
/// 没有任何消费点（任务中心只列未完成、气泡只按 transfer_id 点查），分页没有读者。
fn list_transfers_with_terminal_cap(
    conn: &Connection,
    terminal_cap: usize,
) -> Result<Vec<TransferInfo>> {
    let now = now_ms();
    // `picked` 只挑 id + 排序键；列与 CASE 全留在外层一处，避免两腿各抄一遍。
    // 两腿的 status 集合互斥 ⇒ `UNION ALL` 不会产生重复 id（见 `LIST_TRANSFERS_SQL`）。
    let mut stmt = conn.prepare(LIST_TRANSFERS_SQL)?;
    let rows = stmt.query_map(
        params![
            now,
            crate::network::file::MAX_FILE_OUTBOX_RETRIES,
            terminal_cap as i64
        ],
        |r| {
            Ok(crate::state::TransferInfo {
                id: r.get(0)?,
                peer_id: r.get(1)?,
                name: r.get(2)?,
                size: r.get(3)?,
                direction: r.get(4)?,
                status: r.get(5)?,
                path: r.get(6)?,
                progress: r.get(7)?,
                blocked_reason: r.get(8)?,
                // 任务中心要按"最近发生的在前"排序，而这一列本来就已经是这张表的排序键
                // （`ORDER BY t.created_at DESC`）—— 带上它不是新增事实，只是把已经在用的
                // 那个顺序交给读侧，省得前端按数组下标猜时间（下标会被合并/过滤改乱）。
                created_at: r.get(9)?,
            })
        },
    )?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 发送侧仍在排队/传输中的 transfer id（删除会话/好友前要逐条取消）。
pub fn list_open_send_transfer_ids_for_peer(
    conn: &Connection,
    peer_id: &str,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM file_transfers
         WHERE peer_id = ?1 AND direction = 'send' AND status IN ('pending','active')",
    )?;
    let rows = stmt.query_map(params![peer_id], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 建行后至少留这么久才允许判成“孤儿”：`send_file` 先建 transfer、再写 outbox，
/// 中间那几毫秒不能被对账误杀。
pub const ORPHAN_PENDING_TRANSFER_GRACE_MS: i64 = 120_000;

/// 发送侧 pending、但 `file_outbox` 里**没有仍然活着的行**（pending/sending）的台账。
///
/// 这是“删会话/删好友只删 outbox、不清理 file_transfers”留下的可证孤儿；
/// 只查 `direction='send'`：接收行本来就没有 outbox，绝不能当孤儿判死。
pub fn list_orphan_pending_send_transfers(
    conn: &Connection,
    cutoff_ms: i64,
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM file_transfers t
         WHERE t.direction = 'send'
           AND t.status = 'pending'
           AND t.created_at < ?1
           AND NOT EXISTS (
             SELECT 1 FROM file_outbox o
             WHERE o.transfer_id = t.id AND o.status IN ('pending','sending')
           )
         ORDER BY t.created_at ASC",
    )?;
    let rows = stmt.query_map(params![cutoff_ms], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 发送侧 pending、但 outbox 已经用完重试次数的台账（`list_pending_file_outbox`
/// 只捞 `attempts < MAX`，这些行不会再被任何 worker 选中）。
pub fn list_exhausted_pending_send_transfers(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.id FROM file_transfers t
         JOIN file_outbox o ON o.transfer_id = t.id
         WHERE t.direction = 'send'
           AND t.status = 'pending'
           AND o.status = 'pending'
           AND o.attempts >= ?1
         ORDER BY t.created_at ASC",
    )?;
    let rows = stmt.query_map(
        params![crate::network::file::MAX_FILE_OUTBOX_RETRIES],
        |r| r.get::<_, String>(0),
    )?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 启动 / 每轮清扫器共用的对账：把两种“不会再有人碰”的发送台账走唯一终态出口。
///
/// 返回真正被推进终态的 transfer_id（调用方据此 emit `file-failed`）。
/// 单条失败不阻断其余：下一轮还会再看到它。
pub fn reconcile_pending_send_transfers(conn: &Connection) -> Result<Vec<String>> {
    let cutoff = now_ms().saturating_sub(ORPHAN_PENDING_TRANSFER_GRACE_MS);
    let mut ids = list_orphan_pending_send_transfers(conn, cutoff)?;
    ids.extend(list_exhausted_pending_send_transfers(conn)?);
    ids.sort();
    ids.dedup();
    let mut changed = Vec::new();
    for id in ids {
        if finalize_file_failure(conn, &id, FileJobEnd::GiveUp).unwrap_or(false) {
            changed.push(id);
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod file_transfer_status_tests {
    use super::*;
    use crate::db::SCHEMA;
    use rusqlite::{params, Connection};

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn transfer(conn: &Connection, id: &str, direction: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO file_transfers(id,peer_id,name,size,direction,status,path,progress,created_at)
             VALUES(?1,'peer-a','x.bin',10,?2,'pending',NULL,0.0,?3)",
            params![id, direction, created_at],
        )
        .unwrap();
    }

    fn terminal(conn: &Connection, id: &str, status: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO file_transfers(id,peer_id,name,size,direction,status,path,progress,created_at)
             VALUES(?1,'peer-a','x.bin',10,'receive',?2,NULL,1.0,?3)",
            params![id, status, created_at],
        )
        .unwrap();
    }

    /// DB-03 的正向判据：终态只回最近 N 条，**最旧的那批必须真的被截掉**。
    ///
    /// 断言"条数 = N"是不够的（把排序写反也满足），所以这里同时钉住首行是最新的、
    /// 窗口边界那一行还在、再往前一行不在 —— 与 B7 的备份保留同一种写法。
    #[test]
    fn terminal_transfers_are_capped_to_the_newest_rows() {
        let conn = mem();
        for i in 0..25 {
            terminal(&conn, &format!("t{i:02}"), "done", 1_000 + i);
        }

        let ids: Vec<String> = list_transfers_with_terminal_cap(&conn, 10)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();

        assert_eq!(ids.len(), 10, "终态必须被截到上限：{ids:?}");
        assert_eq!(ids[0], "t24", "最新的终态排第一：{ids:?}");
        assert!(ids.contains(&"t15".to_string()), "第 10 新仍在窗口内：{ids:?}");
        assert!(
            !ids.contains(&"t14".to_string()),
            "第 11 新的终态必须被删掉：{ids:?}"
        );
    }

    /// 反向判据（DB-03 最怕的那一格）：**一条在途传输都不许被终态上限挤掉**。
    ///
    /// 任务中心只列未完成、进度条只画 `active` —— 一条比所有终态都老的 `pending`
    /// 如果被"总行数上限"截走，界面上就是一个永远不动、也不报错的卡片。
    #[test]
    fn an_open_transfer_survives_even_the_tightest_terminal_cap() {
        let conn = mem();
        transfer(&conn, "old-pending", "send", 10);
        conn.execute(
            "INSERT INTO file_transfers(id,peer_id,name,size,direction,status,path,progress,created_at)
             VALUES('old-active','peer-a','x.bin',10,'receive','active',NULL,0.5,11)",
            [],
        )
        .unwrap();
        for i in 0..5 {
            terminal(&conn, &format!("d{i}"), "done", 1_000 + i);
        }

        let rows = list_transfers_with_terminal_cap(&conn, 1).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["d4", "old-active", "old-pending"], "实际：{ids:?}");
    }

    /// 生产默认上限必须真的生效（`list_transfers` 不许因为"反正调用方会截"而回到全表）。
    #[test]
    fn the_production_snapshot_caps_terminal_rows() {
        let conn = mem();
        for i in 0..(MAX_TERMINAL_TRANSFERS + 5) {
            terminal(&conn, &format!("t{i:04}"), "failed", 1_000 + i as i64);
        }

        let rows = list_transfers(&conn).unwrap();
        assert_eq!(rows.len(), MAX_TERMINAL_TRANSFERS, "生产上限没生效");
        assert_eq!(
            rows[0].id,
            format!("t{:04}", MAX_TERMINAL_TRANSFERS + 4),
            "最新的那一行必须在"
        );
    }

    fn outbox(conn: &Connection, id: &str, status: &str, attempts: i64, next_attempt_at: i64) {
        conn.execute(
            "INSERT INTO file_outbox(transfer_id,peer_id,group_id,local_path,name,size,status,attempts,next_attempt_at,created_at)
             VALUES(?1,'peer-a',NULL,'/tmp/x','x.bin',10,?2,?3,?4,0)",
            params![id, status, attempts, next_attempt_at],
        )
        .unwrap();
    }

    fn reason(conn: &Connection, id: &str) -> Option<String> {
        list_transfers(conn)
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("缺 transfer {id}"))
            .blocked_reason
    }

    #[test]
    fn blocked_reason_covers_missing_closed_exhausted_waiting_and_receive() {
        let conn = mem();
        let now = now_ms();
        transfer(&conn, "missing", "send", now);
        transfer(&conn, "closed", "send", now);
        outbox(&conn, "closed", "failed", 0, now);
        transfer(&conn, "exhausted", "send", now);
        outbox(&conn, "exhausted", "pending", 99, now - 1);
        transfer(&conn, "waiting", "send", now);
        outbox(&conn, "waiting", "pending", 0, now + 60_000);
        transfer(&conn, "receiving", "receive", now);

        assert_eq!(reason(&conn, "missing").as_deref(), Some("queue_missing"));
        assert_eq!(reason(&conn, "closed").as_deref(), Some("queue_closed"));
        assert_eq!(
            reason(&conn, "exhausted").as_deref(),
            Some("retry_exhausted")
        );
        assert_eq!(
            reason(&conn, "waiting").as_deref(),
            Some("waiting_retry")
        );
        assert_eq!(
            reason(&conn, "receiving"),
            None,
            "接收行本来就没有 file_outbox，绝不能被判成孤儿"
        );
    }

    #[test]
    fn reconcile_only_touches_old_orphan_or_exhausted_sends() {
        let conn = mem();
        let now = now_ms();
        transfer(&conn, "old-orphan", "send", now - 180_000);
        transfer(&conn, "fresh", "send", now);
        transfer(&conn, "has-outbox", "send", now - 180_000);
        outbox(&conn, "has-outbox", "pending", 0, now + 60_000);
        transfer(&conn, "recv", "receive", now - 180_000);
        transfer(&conn, "exhausted", "send", now);
        outbox(&conn, "exhausted", "pending", 99, now);

        let orphans = list_orphan_pending_send_transfers(
            &conn,
            now - ORPHAN_PENDING_TRANSFER_GRACE_MS,
        )
        .unwrap();
        assert_eq!(orphans, vec!["old-orphan".to_string()]);
        assert_eq!(
            list_exhausted_pending_send_transfers(&conn).unwrap(),
            vec!["exhausted".to_string()]
        );

        let changed = reconcile_pending_send_transfers(&conn).unwrap();
        assert!(changed.contains(&"old-orphan".to_string()));
        assert!(changed.contains(&"exhausted".to_string()));
        for id in ["old-orphan", "exhausted"] {
            let status: String = conn
                .query_row(
                    "SELECT status FROM file_transfers WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "failed", "{id} 必须被推进终态");
        }
        for id in ["fresh", "has-outbox", "recv"] {
            let status: String = conn
                .query_row(
                    "SELECT status FROM file_transfers WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(status, "pending", "{id} 不许被误杀");
        }
    }
}
