// Outbox 超时清扫与过期终态（spawn_outbox_sweeper / finalize_expired_*）
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第二批，判据与顺序见 docs/large-file-split-plan.md。

/// outbox 清扫间隔（毫秒）。
/// 30s 跑一次，每次扫描 created_at < now - OUTBOX_FAIL_DEADLINE_MS 的条目。
pub const OUTBOX_SWEEPER_INTERVAL_MS: u64 = 30_000;

/// 把一条过期的**消息** outbox 落终态：置 `messages.status = "failed"` + 删 outbox 行。
/// **两步都成功**才返回 `true` —— 调用方据此决定是否 `emit("message-failed")`。
///
/// 为什么必须返回这个 conjunction（审计 A3）：旧代码把 emit 写在写库**之外**、还用 `let _ =`
/// 丢掉写库返回值 ⇒ 锁中毒或写库失败时**界面报失败、而 outbox 行还在** ⇒ 下次 `flush_outbox`
/// 又把它发出去 = 重复投递（"我以为失败了的消息又发出去了"）。返回 `false` 时调用方**保留行、
/// 不 emit、留一条 warn**，下一 tick 重试。`group` 决定删哪张 outbox 表（单聊 / 群是两张表）。
fn finalize_expired_message(dbc: &rusqlite::Connection, msg_id: &str, group: bool) -> bool {
    let status_ok = db::set_message_status(dbc, msg_id, "failed").is_ok();
    let deleted = if group {
        db::delete_group_outbox_by_msg_id(dbc, msg_id).is_ok()
    } else {
        db::delete_outbox_by_msg_id(dbc, msg_id).is_ok()
    };
    status_ok && deleted
}

/// 把一条过期的**文件** outbox 落终态（审计 A3 同型）：两个消息前缀（`file-` / `gfile-`）
/// 置 failed + transfer 落 failed + 标记 file_outbox 失败。**全部成功**才返回 true（门控
/// `emit("file-failed")`）。
///
/// 写序、`done` 闸门、"这一路不碰群气泡"三条都在 `db::finalize_file_failure` 里 ——
/// 本函数只是把它的 `Result<bool>` 折成清扫器要的 bool（见那里的注释与
/// `expired_file_never_rewrites_a_completed_transfer` /
/// `expired_file_does_not_touch_the_group_bubble` 两条判据）。
fn finalize_expired_file(dbc: &rusqlite::Connection, transfer_id: &str) -> bool {
    // 实现已并入唯一的出口 `db::finalize_file_failure`（P7：三份收尾合成一份）。
    // 保留这一层是因为清扫器要的是 bool（emit 的门控条件），而顺序/闸门都在里面。
    db::finalize_file_failure(dbc, transfer_id, db::FileJobEnd::Expired).unwrap_or(false)
}

/// 启动 outbox 超时清扫后台任务。
///
/// 每 `OUTBOX_SWEEPER_INTERVAL_MS` 扫一次：单聊 outbox 和群 outbox 里
/// created_at + OUTBOX_FAIL_DEADLINE < now 的条目 → 删 outbox 行 + 置
/// messages.status = "failed" + emit("message-failed", msg_id) 通知前端。
///
/// 为什么必须有这个任务：
/// - outbox 的 flush_outbox 只在「建链 / Hello / 心跳」时触发，完全无链路的 peer
///   会让消息永远停在 outbox 里，前端永远看到 "sending"
/// - 即使有链路，writer_loop 可能被 bulk backpressure 挂起，ChatMessage 虽然已入
///   channel 但 writer_loop 还没写 → Ack 永远到不了 → outbox 永远不删
/// - 这个任务打破"无限等待"：对端**可达**却等不到 Ack 的条目 120s 判 failed；
///   对端**离线**的条目不是失败，保留到 `OUTBOX_OFFLINE_HOLD_MS`（上线补发承诺，
///   见 `db::should_fail_expired_outbox`）
pub fn spawn_outbox_sweeper(
    state: Arc<AppState>,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(OUTBOX_SWEEPER_INTERVAL_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                _ = tick.tick() => {}
            }

            let now = db::now_ms();
            let deadline_single = now - crate::db::OUTBOX_FAIL_DEADLINE_MS;
            let deadline_group = now - crate::db::GROUP_OUTBOX_FAIL_DEADLINE_MS;
            let deadline_file = now - crate::db::FILE_OUTBOX_FAIL_DEADLINE_MS;
            // 可达性快照：每 tick 取一次 links 键集，三条队列复用。
            // 此前每个候选行各抢一次 links 锁（500 离线行 = 500 次/tick，自审建议#4）；
            // 非空判定与 `has_link` 同口径（残留空 Vec 不算可达）。
            let reachable: std::collections::HashSet<String> = {
                let links = state.links.lock().await;
                links
                    .iter()
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, _)| k.clone())
                    .collect()
            };
            let is_reachable = |peer: &str| reachable.contains(peer);

            // --- 单聊 outbox ---
            // 候选行 = 过了 120s 仍未 Ack 的行；是否判 failed 由对端可达性决定：
            // 对端**离线**不是失败理由 —— 产品承诺「对方离线暂存、上线后自动补发」
            //（INV-P04），保留到 OUTBOX_OFFLINE_HOLD_MS 才当僵尸清理。
            // 2026-09-19 P0：此前离线 2 分钟即删行置 failed，离线补发被 sweeper 自己击穿。
            let candidates: Vec<(String, String, i64)> = {
                // 锁中毒也要可见地继续（into_inner）：这个清扫器是"无链路消息"唯一的终态出口，
                // `else { continue }` 静默跳过整个 tick = 消息永久停在 sending（审计 A3）。
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_outbox(&dbc, deadline_single)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(_, mid, peer, created)| (mid, peer, created))
                    .collect()
            };
            for (msg_id, peer_id, created_at) in candidates {
                if !db::should_fail_expired_outbox(is_reachable(&peer_id), now - created_at) {
                    continue;
                }
                // 写库（置 failed + 删行）成功才 emit；锁只在这块作用域内持有，不跨 emit（审计 B1）。
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_message(&dbc, &msg_id, false)
                };
                if finalized {
                    let _ = state.app.emit("message-failed", &msg_id);
                } else {
                    // 不 emit、不删行 ⇒ 下一 tick 重试；留痕便于排障（绝不"界面说失败、行还在、又重发"）
                    state.logger.warn(
                        "outbox",
                        format!("过期单聊消息终态落库失败，保留 outbox 行下轮重试 msg={msg_id}"),
                    );
                }
            }

            // --- 群 outbox：行级分类 + msg 粒度放弃（2026-09-19 自审建议#5）---
            // 一条群消息按成员各一行；某成员离线 ⇒ 他的行保留（上线补发），
            // 只有**所有行都该放弃**时整条消息才置 failed。
            let group_rows: Vec<(String, String, String, i64)> = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_group_outbox(&dbc, deadline_group).unwrap_or_default()
            };
            let mut per_msg: std::collections::HashMap<String, (String, Vec<(String, i64)>)> =
                std::collections::HashMap::new();
            for (msg_id, group_id, peer_id, created_at) in group_rows {
                per_msg
                    .entry(msg_id)
                    .or_insert_with(|| (group_id, Vec::new()))
                    .1
                    .push((peer_id, created_at));
            }
            for (msg_id, (_group_id, rows)) in per_msg {
                let all_give_up = rows.iter().all(|(peer, created)| {
                    // 群走**自己的**窗口（30min，见 `GROUP_OUTBOX_FAIL_DEADLINE_MS` 的理由）：
                    // 群 outbox 行是群消息唯一的补发载体，删早了就是永久丢。
                    db::should_fail_expired(
                        is_reachable(peer),
                        now - created,
                        crate::db::GROUP_OUTBOX_FAIL_DEADLINE_MS,
                        crate::db::OUTBOX_OFFLINE_HOLD_MS,
                    )
                });
                if !all_give_up {
                    continue;
                }
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_message(&dbc, &msg_id, true)
                };
                if finalized {
                    let _ = state.app.emit("message-failed", &msg_id);
                } else {
                    state.logger.warn(
                        "outbox",
                        format!("过期群消息终态落库失败，保留 outbox 行下轮重试 msg={msg_id}"),
                    );
                }
            }

            // --- 文件 outbox：与消息队列同一离线判据（窗口用文件自己的 30min）---
            // 自审建议#5：离线接收方的文件此前 30min 一律判 failed ——
            // 「关机一晚回来收不到大文件」与被修的 P0#2 同型。
            let expired_files: Vec<(String, String, Option<String>, i64)> = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_file_outbox(&dbc, deadline_file).unwrap_or_default()
            };
            for (transfer_id, peer_id, _group_id, created_at) in expired_files {
                if !db::should_fail_expired(
                    is_reachable(&peer_id),
                    now - created_at,
                    crate::db::FILE_OUTBOX_FAIL_DEADLINE_MS,
                    crate::db::OUTBOX_OFFLINE_HOLD_MS,
                ) {
                    continue;
                }
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_file(&dbc, &transfer_id)
                };
                if finalized {
                    let _ = state.app.emit("file-failed", &transfer_id);
                } else {
                    state.logger.warn(
                        "outbox",
                        format!("过期文件终态落库失败，保留 file_outbox 行下轮重试 transfer={transfer_id}"),
                    );
                }
            }

            // --- 内容台账对账（B2）：文件层说"done"、内容层却还不知道的那些行 ---
            // 见 `reconcile_completed_content` 的注释：这一格就是"每次建链整批重投"的永动来源。
            // 两相位：① 短锁取候选；② **不持锁**读盘算摘要（600MB 的哈希不能占着 db 锁）；
            // ③ 短锁写回。每 tick 上限 `CONTENT_RECONCILE_PER_TICK` 条 ⇒ 有界，不随积压增长。
            let cands = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                list_reconcilable_content(&dbc, CONTENT_RECONCILE_PER_TICK).unwrap_or_default()
            };
            for c in cands {
                let ok = content_file_matches(&c.cid, &c.path, c.size);
                let wrote = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finish_reconcile(&dbc, &c, db::now_ms(), ok)
                };
                if ok && !wrote {
                    state.logger.warn(
                        "content",
                        format!("内容台账对账写回失败，保留可恢复状态下轮再试 cid={} from={}", c.cid, c.peer_id),
                    );
                } else if !ok && log_throttled("content_reconcile_invalid", 30_000) {
                    state.logger.warn(
                        "content",
                        format!(
                            "文件层已 done 但盘上那份不可用（缺失/长度不符/摘要不等），不标记完成 cid={} from={}",
                            c.cid, c.peer_id
                        ),
                    );
                }
            }
        }
    })
}

/// 每 tick 最多对账几条内容台账。有界性就在这里：积压再多也只按这个速度消化，
/// 不会在某一个 tick 里把整盘文件哈希一遍。
pub(crate) const CONTENT_RECONCILE_PER_TICK: usize = 8;

/// 一条待对账的候选（文件层 done + 内容层还认为没收完）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReconcileCandidate {
    pub cid: String,
    pub peer_id: String,
    pub transfer_id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// 取候选：`content_transfers` 里方向为 receive、状态仍可恢复、**自己没有 path**，
/// 而它的 `transfer_id` 在 `file_transfers` 里是 `done` 且带着 path 的那些行。
/// 三者同时成立才是"两张表各执一词"；任一不成立都不许进来（尤其不许只看数据库就说完成）。
///
/// 为什么这一格必须有人管（2026-10-13 真机第 7 条）：单聊收尾此前只写 `file_transfers`，
/// 于是内容台账那一行永远停在可恢复态 ⇒ `retry_incomplete_content` 每次建链整批重投，
/// 而服务侧那 15 秒把接收循环堵死。B1 修今后的收尾，**这一条修已经卡住的存量**。
pub(crate) fn list_reconcilable_content(
    dbc: &rusqlite::Connection,
    limit: usize,
) -> rusqlite::Result<Vec<ReconcileCandidate>> {
    // 参数化 LIMIT（不拼 SQL）。⚠️ **path 取的是文件层那一份（`ft.path`）**：内容层那一行的 path
    // 恰恰是 NULL（这正是"各执一词"的定义），把它 SELECT 出来会在类型转换上直接炸
    // （`InvalidColumnType(_, "path", Null)`，实测踩过）；`transfer_id` 为 NULL 时 JOIN 不命中
    // ⇒ 没有实物证据的行不进候选。
    let mut stmt = dbc.prepare(
        "SELECT ct.cid, ct.peer_id, ct.transfer_id, ct.name, ft.path, ct.size
           FROM content_transfers ct
           JOIN file_transfers ft ON ft.id = ct.transfer_id
          WHERE ct.direction = 'receive'
            AND ct.status IN ('queued','active','incomplete')
            AND ct.path IS NULL
            AND ft.status = 'done'
            AND ft.path IS NOT NULL
          ORDER BY ct.updated_at ASC
          LIMIT ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit as i64], |r| {
        Ok(ReconcileCandidate {
            cid: r.get(0)?,
            peer_id: r.get(1)?,
            transfer_id: r.get(2)?,
            name: r.get(3)?,
            path: r.get(4)?,
            size: r.get::<_, i64>(5)?.max(0) as u64,
        })
    })?;
    rows.collect()
}

/// 实物校验：文件存在、字节数等于声明的 size、且**实际** SHA-256 等于 cid。
/// `file_transfers` 没有摘要列（`db.rs` 的建表语句），所以"内容对不对"只能靠重算，
/// 而重算必须发生在接收循环之外 —— 这就是 B2 住在这个清扫器里的原因。
/// 先比长度再算摘要：长度不对的（半截文件）不必再花一次全盘哈希。
pub(crate) fn content_file_matches(cid: &str, path: &str, size: u64) -> bool {
    use sha2::Digest as _;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() != size {
        return false;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let mut h = sha2::Sha256::new();
    h.update(&bytes);
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex.eq_ignore_ascii_case(cid)
}

/// 写回：校验通过 ⇒ `record_local`（Complete + path + received=size，幂等）；
/// 不通过 ⇒ `record_failure(Local)`（可恢复 ⇒ 仍在重试队列里，"文件没了"要能再拉一次，
/// 而不是被就地判死）。两条都必须**真写入成功**才返回 true（审计 A3 同型：
/// 写库没成就不算这一轮做过事，下 tick 重来）。
pub(crate) fn finish_reconcile(
    dbc: &rusqlite::Connection,
    c: &ReconcileCandidate,
    now_ms: i64,
    ok: bool,
) -> bool {
    use crate::content::model::{Direction, FailReason};
    if ok {
        return crate::content::store::record_local(
            dbc,
            &c.cid,
            &c.peer_id,
            None,
            &c.name,
            c.size,
            Direction::Receive,
            &c.path,
            now_ms,
        )
        .is_ok();
    }
    // 实物不可用 ⇒ 记一次可恢复失败：状态回 Incomplete、退避照走、8 次封顶后 Rejected。
    // 这里绝不写 path —— 写了就等于把一份没验过的文件当成"本机完整持有"的种子。
    crate::content::store::record_failure(
        dbc,
        &c.cid,
        &c.peer_id,
        Direction::Receive,
        FailReason::Local,
        now_ms,
    )
    .is_ok()
}

#[cfg(test)]
mod content_reconcile_tests {
    use super::{
        content_file_matches, finish_reconcile, list_reconcilable_content, ReconcileCandidate,
    };
    use crate::content::model::{Direction, TransferRecord, TransferStatus};
    use sha2::Digest as _;

    fn sha_hex(b: &[u8]) -> String {
        let mut h = sha2::Sha256::new();
        h.update(b);
        h.finalize().iter().map(|x| format!("{x:02x}")).collect()
    }

    fn db_both() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        crate::content::store::ensure_schema(&c).unwrap();
        c
    }

    fn temp_file(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("gosslan-reconcile-{tag}-{}.bin", std::process::id()));
        let _ = std::fs::remove_file(&p);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// 内容层的一行（默认 receive/incomplete、无 path，就是"还在等对端给"的形状）。
    fn seed_content(c: &rusqlite::Connection, cid: &str, tid: &str, status: TransferStatus, path: Option<&str>) {
        let now = crate::db::now_ms();
        crate::content::store::upsert(
            c,
            &TransferRecord {
                cid: cid.into(),
                transfer_id: Some(tid.into()),
                peer_id: "dev-a".into(),
                group_id: None,
                name: format!("{tid}.bin"),
                size: 2048,
                direction: Direction::Receive,
                status,
                received: 0,
                attempts: 0,
                next_attempt_at: 0,
                last_error: None,
                path: path.map(str::to_string),
                created_at: now,
                updated_at: now,
            },
        )
        .unwrap();
    }

    fn seed_file(c: &rusqlite::Connection, tid: &str, status: &str, path: Option<&str>) {
        crate::db::upsert_transfer(
            c,
            tid,
            "dev-a",
            &format!("{tid}.bin"),
            2048,
            "receive",
            status,
            path,
            if status == "done" { 1.0 } else { 0.0 },
        )
        .unwrap();
    }

    /// ① 两张表各执一词、且盘上那份真的对得上 ⇒ 收口成 Complete，且不再被重试队列捞起。
    #[test]
    fn reconciles_a_genuinely_received_file_into_complete() {
        let bytes: Vec<u8> = vec![0x4Du8; 2048];
        let cid = sha_hex(&bytes);
        let p = temp_file("ok", &bytes);
        let c = db_both();
        seed_content(&c, &cid, "x1", TransferStatus::Incomplete, None);
        seed_file(&c, "x1", "done", Some(p.to_str().unwrap()));
        // 先验夹具本身（前提不成立时，后面每一条都只是在判一个不存在的路径）
        let seeded = crate::content::store::get(&c, &cid, "dev-a", Direction::Receive)
            .unwrap()
            .expect("夹具要真的写出内容台账那一行");
        assert_eq!(seeded.status, TransferStatus::Incomplete);
        assert_eq!(seeded.transfer_id.as_deref(), Some("x1"));
        assert!(seeded.path.is_none());

        let cands = list_reconcilable_content(&c, 8).unwrap();
        assert_eq!(cands.len(), 1, "执一词的那一行必须被找出来，实得 {cands:?}");
        assert!(content_file_matches(&cid, &cands[0].path, bytes.len() as u64));
        assert!(finish_reconcile(&c, &cands[0], crate::db::now_ms(), true));

        let rec = crate::content::store::get(&c, &cid, "dev-a", Direction::Receive)
            .unwrap()
            .unwrap();
        assert_eq!(rec.status, TransferStatus::Complete, "对账通过必须收口");
        assert_eq!(rec.path.as_deref(), Some(p.to_str().unwrap()));
        assert_eq!(rec.received, 2048);
        let resumable = crate::content::store::list_resumable_for_peer(&c, "dev-a").unwrap();
        assert!(resumable.is_empty(), "收口之后不许再被重投，实得 {resumable:?}");
    }

    /// ② 盘上那份摘要不等于 cid（被换过/半截）⇒ **绝不**标记完成，且仍可恢复。
    #[test]
    fn a_hash_mismatch_is_never_marked_complete() {
        let bytes: Vec<u8> = vec![0x11u8; 2048];
        let wrong: Vec<u8> = vec![0x22u8; 2048];
        let cid = sha_hex(&bytes);
        let p = temp_file("bad", &wrong);
        let c = db_both();
        seed_content(&c, &cid, "x2", TransferStatus::Incomplete, None);
        seed_file(&c, "x2", "done", Some(p.to_str().unwrap()));

        let cands = list_reconcilable_content(&c, 8).unwrap();
        assert_eq!(cands.len(), 1);
        assert!(!content_file_matches(&cid, &cands[0].path, 2048), "摘要不符必须判不可用");
        assert!(finish_reconcile(&c, &cands[0], crate::db::now_ms(), false));
        let rec = crate::content::store::get(&c, &cid, "dev-a", Direction::Receive)
            .unwrap()
            .unwrap();
        assert_ne!(rec.status, TransferStatus::Complete, "没有实物证据不许收口");
        assert!(rec.path.is_none());
        let resumable = crate::content::store::list_resumable_for_peer(&c, "dev-a").unwrap();
        assert!(
            resumable.iter().any(|x| x.cid == cid),
            "文件坏了要还能再拉一次（就地判死 = 内容永久拿不到）"
        );
    }

    /// ③ 文件不存在 / 长度不符 ⇒ 同样不收口。
    #[test]
    fn missing_or_short_file_is_not_complete() {
        let bytes: Vec<u8> = vec![0x33u8; 2048];
        let cid = sha_hex(&bytes);
        let c = db_both();
        seed_content(&c, &cid, "x3", TransferStatus::Incomplete, None);
        seed_file(&c, "x3", "done", Some("/nope/definitely-not-here.bin"));
        let cands = list_reconcilable_content(&c, 8).unwrap();
        assert_eq!(cands.len(), 1);
        assert!(!content_file_matches(&cid, &cands[0].path, 2048));
        assert!(!content_file_matches(&cid, &cands[0].path, 17));
        assert!(finish_reconcile(&c, &cands[0], crate::db::now_ms(), false));
        let rec = crate::content::store::get(&c, &cid, "dev-a", Direction::Receive)
            .unwrap()
            .unwrap();
        assert_ne!(rec.status, TransferStatus::Complete);
    }

    /// ④ 候选口径本身：只有"文件层 done + 内容层未收口 + 内容层没有 path"三者同人才进来。
    #[test]
    fn candidates_exclude_every_healthy_or_unprovable_shape() {
        let c = db_both();
        // (a) 内容层已 Complete ⇒ 不动它
        seed_content(&c, "cid-done", "xa", TransferStatus::Complete, Some("/tmp/whatever.bin"));
        seed_file(&c, "xa", "done", Some("/tmp/whatever.bin"));
        // (b) 文件层还没 done（还在收）⇒ 不能当完成
        seed_content(&c, "cid-partial", "xb", TransferStatus::Incomplete, None);
        seed_file(&c, "xb", "active", None);
        // (c) 文件行根本没有 ⇒ 无实物证据
        seed_content(&c, "cid-nofile", "xc", TransferStatus::Incomplete, None);
        // (d) 合法的那一条
        let bytes: Vec<u8> = vec![0x55u8; 2048];
        let cid = sha_hex(&bytes);
        let p = temp_file("cand", &bytes);
        seed_content(&c, &cid, "xd", TransferStatus::Incomplete, None);
        seed_file(&c, "xd", "done", Some(p.to_str().unwrap()));
        let got: Vec<String> = list_reconcilable_content(&c, 8)
            .unwrap()
            .into_iter()
            .map(|x| x.cid)
            .collect();
        assert_eq!(got, vec![cid.clone()], "只许捞出 (d) 那一条，实得 {got:?}");
    }

    /// ⑤ 有界性：每 tick 至多 `limit` 条，积压再多也只按这个速度消化。
    #[test]
    fn candidate_pull_is_bounded_per_tick() {
        let c = db_both();
        for i in 0..12 {
            let tid = format!("t{i}");
            seed_content(&c, &format!("cid{i:02}"), &tid, TransferStatus::Incomplete, None);
            seed_file(&c, &tid, "done", Some("/tmp/none.bin"));
        }
        assert_eq!(list_reconcilable_content(&c, 8).unwrap().len(), 8, "单轮上限必须生效");
        assert_eq!(list_reconcilable_content(&c, 1).unwrap().len(), 1);
        let _: ReconcileCandidate; // 类型被用到（避免未使用告警）
    }
}
