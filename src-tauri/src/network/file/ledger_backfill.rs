// 群文件台账的一次性补账作业（2026-10-16 负责人拍板走方案 A）。
//
// 治的是哪一格：群接收收尾把三张台账（`group_file_recipients` / `file_transfers` /
// `content_transfers`）包进过一个**忘了 commit 的事务**（`2de9264`，判据后来补在
// `lib_file_tests.rs`）⇒ 三张一起回滚，而字节早已 rename 成正式名躺在 downloads 里、
// 消息行也活着（卡片是 Offer 插的、`path` 是 Done 在**事务外**回填的）。
// 后果不是丢文件，是**这台不算种子**：`content_transfers` 没有行 ⇒ `find_source` 捞不到 ⇒
// 别人再也拉不到这份内容；而对账扫描器（`outbox_sweep.rs::list_reconcilable_content`）的谓词
// 要求"已有一行且 path IS NULL"，它捞不到"行根本没写成"这一格 —— 所以这一格没有兜底，只能补。
//
// 为什么是"启动后一次性的后台作业"而不是 DB 迁移：补账唯一的判据是**整文件 SHA-256 相等**，
// 而群文件可以到 GB 级。迁移跑在启动路径上 ⇒ 那段哈希就钉在界面前面，正是 INV-P34 那一族
// 已经数到十一家的同一个根因（本作业落笔就在池里 ⇒ 登记在册的第十二格，见 `docs/migration-ledger.md` 第 13 行）。设计前提与五种反证见
// `docs/notes/group-file-ledger-backfill-2026-10-16.md`。
//
// ⚠️ 搬家/改这一册同批必须做的两件事（成例见 `network/file/send.rs` 头部）：
//   ① `network/mod.rs::file_src_for_guards()` 登记本册 —— 漏了 = 以"生产码全集"为判据的形状守卫看不见这段，那是假绿；
//   ② `docs/domains.data.mjs` 的 files 领域 —— 本目录按目录认领（不是逐册点名），加新册不用改 paths，
//      但那条「分册目录」注释要一起改，否则下一个人按注释找册会漏。

/// settings 表里"这台机器跑过这一趟没有"的开关（布尔口径 = `db::parse_config_bool`）。
///
/// ⚠️ 这个标记的语义是**"有一整趟跑到底了"**，不是"到过一次启动"：候选扫描失败、扫描任务被中断、
/// 或任一条台账写失败，都算**没收口** ⇒ 不写标记（见 `GfileLedgerBackfillStats::incomplete`）。
/// 写在这里而不是只写在注释里，是因为一次 SQLITE_BUSY 就把自己永久钉成"不再补账"，
/// 比不补更糟 —— 那是把一个临时故障变成一个不可恢复的决定。
pub const GFILE_LEDGER_BACKFILL_DONE_KEY: &str = "gfile_ledger_backfill_done";

/// 一条"消息行在、台账缺行"的候选。每个字段都取自库里已有的实物，作业侧不许猜。
pub struct GfileLedgerGap {
    pub transfer_id: String,
    pub group_id: String,
    pub sender_id: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub path: String,
}

/// 一趟的读数，只为最后那条"跑过"的日志与**要不要写完成标记**而存在（每条候选自己另有一行明细）。
#[derive(Default)]
pub struct GfileLedgerBackfillStats {
    pub gaps: usize,
    pub repaired: usize,
    pub skipped: usize,
    /// 卡片写着 path、却对不回 `group_files` 的那样的行数 ⇒ **本轮补不了、只能数出来**的那一块
    pub orphan: usize,
    /// **这一趟有没有收口**。假 = 一整趟跑到底 ⇒ 才允许写完成标记；
    /// 真 = 扫描失败 / 任务被中断 / 任一条台账写失败 ⇒ 下次启动必须再来一遍。
    /// 注意 `SkippedHashMismatch` 与 `SkippedLocal` **不算**没收口：那是终局判定，重试一万次还是它。
    pub incomplete: bool,
}

/// 一条候选的结局。**四种都合法**，所以分开写而不是折成一个 bool：
/// 后两条是"认不上 ⇒ 一格都不写"，正是这条补账不会把台账写错的那道闸。
#[derive(Debug, PartialEq, Eq)]
pub enum GfileLedgerOutcome {
    Repaired,
    /// recipient 行压根不在（`update_group_file_recipient` 自己的规矩是不静默创建群外 state）：
    /// 另两格照写 ⇒ 这一台重新算种子，但群里的投递名册补不出来，必须留痕。
    RepairedWithoutRecipientRow,
    /// 盘上没有 / 读不动 / 那个阻塞任务被中断 —— 原因原样带出去，日志不许替它挑一个
    /// （写成「已不在盘上」会把「任务被中断」那种形状说成另一件事，正是本轮在修的那类误导）。
    SkippedLocal { reason: String },
    /// 声明值与实测算值不等：同名同大小、内容不同。带着两个 hex，现场要的就是这两个数。
    SkippedHashMismatch { declared: String, actual: String },
}

/// 扫候选：只把**台账确实缺**的那些交出去，全程不碰磁盘。
///
/// 三道闸的顺序是有意的 —— 库里三个点查（都走索引）排在哈希前面，健康机器上一格哈希都不会算。
pub fn list_gfile_ledger_gaps(
    conn: &rusqlite::Connection,
    device_id: &str,
) -> rusqlite::Result<(Vec<GfileLedgerGap>, usize)> {
    let mut gaps = Vec::new();
    // 卡片写着 path、却对不回这一单的群/声明哈希 —— 本轮**补不了**（设计那节第 5 条那一块），
    // 但必须数出来：没有这个数，「存量到底还剩多少」在日志里就是零条证据。
    let mut orphan = 0usize;
    for (msg_id, conv_id, content) in db::list_gfile_message_rows(conn)? {
        // 卡片键 = `gfile-{transfer_id}`（收发两侧共用），会话键 = `group:{group_id}`
        let Some(transfer_id) = msg_id.strip_prefix("gfile-") else {
            continue;
        };
        let Some(group_id) = conv_id.strip_prefix("group:") else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        // `path` 是 Done 回填的那一份：没有它 = 这单压根没落盘（还在收 / 失败 / 已清理），
        // 那不属于补账 ⇒ 跳过。**不靠文件名猜**：落盘名是 `unique_path(downloads, 原始名)`，
        // 既不含 sha256 也不含 transfer_id，重名还会被加成"名字 (1).ext"。
        let Some(path) = parsed
            .get("path")
            .and_then(|p| p.as_str())
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        // 身份三元组以 `group_files` 为准（Offer 写的，同样不在那笔回滚里）。
        let Some(gf) = db::get_group_file(conn, transfer_id) else {
            orphan += 1;
            continue;
        };
        if gf.group_id != group_id || gf.sha256.is_empty() {
            orphan += 1;
            continue;
        }
        // 本机是发送方 ⇒ 这条的 recipient 名册记的是"别人收没收到"、内容台账那一半方向是 Send，
        // 都不归本作业管（本作业只把**我这台**补回种子）。
        if gf.sender_id == device_id {
            continue;
        }
        if !gfile_ledger_cells_missing(conn, transfer_id, device_id, &gf.sha256, &gf.sender_id)? {
            continue;
        }
        gaps.push(GfileLedgerGap {
            transfer_id: transfer_id.to_string(),
            group_id: group_id.to_string(),
            sender_id: gf.sender_id,
            name: gf.name,
            size: gf.size,
            sha256: gf.sha256,
            path: path.to_string(),
        });
    }
    Ok((gaps, orphan))
}

/// 三张台账里有没有**任何一张**还没收口（都齐 ⇒ 这条连盘都不用碰）。
fn gfile_ledger_cells_missing(
    conn: &rusqlite::Connection,
    transfer_id: &str,
    device_id: &str,
    cid: &str,
    peer_id: &str,
) -> rusqlite::Result<bool> {
    if db::get_group_file_recipient_status(conn, transfer_id, device_id).as_deref()
        != Some("completed")
    {
        return Ok(true);
    }
    if !db::is_transfer_done(conn, transfer_id)? {
        return Ok(true);
    }
    let local = crate::content::store::get(
        conn,
        cid,
        peer_id,
        crate::content::model::Direction::Receive,
    )?;
    Ok(match local {
        None => true,
        Some(rec) => rec.path.filter(|p| !p.is_empty()).is_none(),
    })
}

/// 补一条：**哈希认得上才算数**，认不上（或文件不在）⇒ 一格都不写。
///
/// `local` 是调用方在阻塞线程池里算出来的那份（`Ok(hex)` / `Err(原因)`），传进来而不是在这儿算，
/// 是为了让这段哈希**不握着 db 锁** —— 本仓只有一个 tokio runtime，而 `state.db` 这把锁上排着
/// 消息收发与所有会读库的命令；GB 级哈希握着它几秒钟，就是"发消息没反应"几秒钟。
pub fn gfile_ledger_repair(
    conn: &mut rusqlite::Connection,
    gap: &GfileLedgerGap,
    device_id: &str,
    local: Result<String, String>,
) -> rusqlite::Result<GfileLedgerOutcome> {
    let actual_hex = match local {
        Ok(hex) => hex,
        Err(reason) => return Ok(GfileLedgerOutcome::SkippedLocal { reason }),
    };
    if !actual_hex.eq_ignore_ascii_case(&gap.sha256) {
        return Ok(GfileLedgerOutcome::SkippedHashMismatch {
            declared: gap.sha256.clone(),
            actual: actual_hex,
        });
    }
    // recipient 行不在就不造它（那是"群外 state"，权限由 Offer 那一段负责，补账不越这道线）。
    let has_recipient =
        db::get_group_file_recipient_status(conn, &gap.transfer_id, device_id).is_some();
    let transfer_id = gap.transfer_id.clone();
    let path = gap.path.clone();
    // 三处写只写**一份**，且闭包末尾必须 `tx.commit()`（rusqlite 0.31.0 的 `Transaction`
    // 默认 drop 行为是 Rollback）—— 少那一句就是这一轮要治的那个形状本身。
    let wrote = conn.transaction().and_then(|tx| {
        if has_recipient {
            db::update_group_file_recipient(&tx, &transfer_id, device_id, "completed", 1.0)?;
        }
        db::upsert_transfer(
            &tx,
            &transfer_id,
            &gap.sender_id,
            &gap.name,
            gap.size,
            "receive",
            "done",
            Some(&path),
            1.0,
        )?;
        crate::content::store::record_local(
            &tx,
            &gap.sha256,
            &gap.sender_id,
            Some(&gap.group_id),
            &gap.name,
            gap.size,
            crate::content::model::Direction::Receive,
            &path,
            db::now_ms(),
        )?;
        // ★ 这一句不许省，也不许被"最后那个表达式的结果就是事务的结果"顶掉：
        // rusqlite 0.31.0 的 `Transaction` 默认 drop 行为是 Rollback（`transaction.rs:127`），
        // 少了 commit ⇒ 三张表一起回滚、`wrote` 仍是 Ok、界面一句都不记。
        // 本仓 4.40.8 的群收尾那一格就是这么坏的，而这条判据第一次跑就把我自己在同一轮里
        // 写出来的同一个形状判红了（正向用例 `positive_fill_completes_all_three_ledgers`）。
        tx.commit()
    });
    wrote?;
    Ok(if has_recipient {
        GfileLedgerOutcome::Repaired
    } else {
        GfileLedgerOutcome::RepairedWithoutRecipientRow
    })
}

/// 作业主体：逐条把整份哈希交给阻塞线程池（**这条就是 INV-P34 按格点名盯着的那一格**），
/// 认得上才补三张台账，每条之间让出一次。跑不跑由调用方按 settings 那个开关决定。
pub async fn run_group_ledger_backfill(state: &Arc<AppState>) -> GfileLedgerBackfillStats {
    let mut stats = GfileLedgerBackfillStats::default();
    // 整段扫描交给阻塞线程池。为什么这一半不能留在 async worker 上：候选那句是
    // `msg_id LIKE 'gfile-%'`，`EXPLAIN QUERY PLAN` 实测是 `SCAN messages USING INDEX
    // sqlite_autoindex_messages_1` —— 索引用上了（不是"整表无索引扫"），但那是**全索引扫**，
    // 代价随消息总数长，而且它在里面握着**全仓唯一那把 db 锁**：消息落链路与所有读库命令
    // 在这一段里一起排队。同一段 setup 里的 `.part` 清扫正是为了这件事才进池的（`lib.rs` 那一格）。
    let scanned = {
        let st = state.clone();
        tokio::task::spawn_blocking(move || {
            let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
            list_gfile_ledger_gaps(&dbc, &st.device_id)
        })
        .await
    };
    let (gaps, orphan) = match scanned {
        Ok(Ok(pair)) => pair,
        // 扫不动 ⇒ 这一趟**没收口**：这里没有任何"半条账"可写，但标记也一定不许写
        //（否则一次 SQLITE_BUSY 就把这台永久钉成"不再补账"）。
        Ok(Err(e)) => {
            state.logger.error(
                "file",
                format!("群文件台账补账：候选扫描失败，本轮不补、完成标记也不写 —— {e}"),
            );
            stats.incomplete = true;
            return stats;
        }
        Err(e) => {
            state.logger.error(
                "file",
                format!("群文件台账补账：扫描任务被中断，本轮不补、完成标记也不写 —— {e}"),
            );
            stats.incomplete = true;
            return stats;
        }
    };
    stats.gaps = gaps.len();
    stats.orphan = orphan;
    for gap in gaps {
        let target = std::path::PathBuf::from(&gap.path);
        let local = tokio::task::spawn_blocking(move || {
            if !target.exists() {
                return Err("文件已不在盘上".to_string());
            }
            sha256_file_hex(&target)
        })
        .await
        .unwrap_or_else(|e| Err(format!("补账哈希任务被中断: {e}")));
        let outcome = {
            let mut dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            gfile_ledger_repair(&mut dbc, &gap, &state.device_id, local)
        };
        match &outcome {
            Ok(GfileLedgerOutcome::Repaired) => {
                stats.repaired += 1;
                state.logger.info(
                    "file",
                    format!("群文件台账补账：补上 transfer={} 文件={}", gap.transfer_id, gap.name),
                );
            }
            Ok(GfileLedgerOutcome::RepairedWithoutRecipientRow) => {
                stats.repaired += 1;
                state.logger.warn(
                    "file",
                    format!(
                        "群文件台账补账：transfer={} 的 recipient 行不在，另两格已补（这台重新算种子，但群里那份投递名册补不出来）",
                        gap.transfer_id
                    ),
                );
            }
            Ok(GfileLedgerOutcome::SkippedHashMismatch { declared, actual }) => {
                stats.skipped += 1;
                state.logger.warn(
                    "file",
                    format!(
                        "群文件台账补账跳过 transfer={}：哈希对不上（声明 {declared} ≠ 实测 {actual}），同名同大小不同内容 ⇒ 绝不按名字猜着补",
                        gap.transfer_id
                    ),
                );
            }
            Ok(GfileLedgerOutcome::SkippedLocal { reason }) => {
                stats.skipped += 1;
                state.logger.warn(
                    "file",
                    format!(
                        "群文件台账补账跳过 transfer={}：{reason}（{}）",
                        gap.transfer_id, gap.path
                    ),
                );
            }
            Err(e) => {
                stats.skipped += 1;
                // 这一条没收口 ⇒ 整趟都不算收口：那一行台账可能还是缺的，下次启动必须再来一遍。
                // （与 `SkippedHashMismatch` / `SkippedLocal` 的区别就在这儿：那两条是终局判定，
                //  重试一万次还是同一个答案，所以它们不置这个位。）
                stats.incomplete = true;
                state.logger.error(
                    "file",
                    format!(
                        "群文件台账补账失败 transfer={}：{e} —— 完成标记不写，下次启动会再来一遍",
                        gap.transfer_id
                    ),
                );
            }
        }
        // 一条补完就让一次：这条链上排在后面的收发先走。
        tokio::task::yield_now().await;
    }
    stats
}

include!("ledger_backfill_tests.rs");
