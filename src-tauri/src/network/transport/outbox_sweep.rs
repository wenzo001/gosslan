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
    // 两步写由 `db::finalize_expired_message` 收进**同一事务**（顺序仍是语义：
    // 状态写失败就不删行，否则行没了、状态还是 sending，两个清扫器都看不见）。
    // 失败只返回 false，由调用方保留队列行并在日志里留 code=OUTBOX_FINALIZE_FAILED。
    db::finalize_expired_message(dbc, msg_id, group).is_ok()
}

/// 把一条过期的**文件** outbox 落终态（审计 A3 同型）：两个消息前缀（`file-` / `gfile-`）
/// 置 failed + transfer 落 failed + 标记 file_outbox 失败。**全部成功**才返回 true（门控
/// `emit("file-failed")`）。
///
/// 写序、`done` 闸门、"这一路不碰群气泡"三条都在 `db::finalize_file_failure` 里 ——
/// 本函数只保留"清扫器这一侧"的两件事：把错误转成可读串，并交出 emit 的门控值
/// （见 `expired_file_never_rewrites_a_completed_transfer` /
/// `expired_file_does_not_touch_the_group_bubble` 两条判据）。
fn finalize_expired_file(dbc: &rusqlite::Connection, transfer_id: &str) -> Result<bool, String> {
    // 实现已并入唯一的出口 `db::finalize_file_failure`（P7：三份收尾合成一份）。
    // 返回 `Result` 而不是 `bool`：写失败的原因必须能被调用方写进日志
    // （审计 FUNC-02 复审 —— 折成 false 会让"为什么没落终态"在现场彻底消失）。
    db::finalize_file_failure(dbc, transfer_id, db::FileJobEnd::Expired).map_err(|e| e.to_string())
}

/// 「发现层在线」的有效窗口：与 discovery 回收跨跳节点的 45s 同源。
///
/// 为什么清扫器的可达性不能只看 `links`（2026-10-20 永久发送中 P0）：
/// 链路断开后 `links` 会立刻被移除，而对端仍在每 5s 广播 announce、仍显示在线。
/// 旧判据把这种对端当"离线" ⇒ 消息按 7 天离线保留窗口挂着，界面就是长期"发送中"。
/// 用户说的"双方局域网在线"对应的是**发现层在线**，这里必须认它。
pub(crate) const OUTBOX_PEER_ONLINE_WINDOW_MS: i64 =
    crate::protocol::RELAY_PEER_TIMEOUT_SECS * 1000;

/// 一个 peer 在清扫器眼里是否"可达"。纯函数：链路与发现层在线两条证据任一成立。
///
/// `last_seen_ms` 是**本机收到 announce/Presence 的时刻**（不是对端时钟），
/// 因此不受设备间时钟偏差影响；窗口按本机时钟算。
pub(crate) fn outbox_peer_reachable(
    has_live_link: bool,
    last_seen_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    if has_live_link {
        return true;
    }
    last_seen_ms.is_some_and(|seen| seen >= now_ms - OUTBOX_PEER_ONLINE_WINDOW_MS)
}

/// 启动 outbox 超时清扫后台任务。**进程级常驻**，不再绑定 `network::start`。
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
///
/// ⚠️ 两个"必须常驻"的理由（旧实现只在 `network::start` 成功后 spawn，`stop` 时随
/// 网络任务一起退出）：
/// ① 局域网自启失败 / 用户关掉局域网 ⇒ 根本没有清扫器，队列里的 sending 永远不会终态；
/// ② 停网后 `links`/`peers` 被清空，若清扫器也跟着消失，重连前的窗口没有任何兜底。
/// 进程退出会自然结束它，不需要按网络生命周期回收。
///
/// ⚠️ **必须用 `tauri::async_runtime::spawn`，不能用 `tokio::spawn`**（2026-10-20 真机/双实例
/// E2E 抓到）：这个函数现在从 `lib.rs` 的 setup 钩子里调用，而 setup 跑在**主线程、没有进入任何
/// Tokio runtime 上下文**。`tokio::spawn` 在那种上下文里会直接 panic：
/// `there is no reactor running, must be called from the context of a Tokio 1.x runtime`
/// ⇒ 应用**启动即崩**（release 是 panic=abort），两个实例都死，E2E 连握手都到不了。
/// `tauri::async_runtime::spawn` 会在需要时惰性建 runtime，从任意线程都可调用。
/// 单测与源码形状判据都看不出这一层（它们不跑 setup），只有真起进程才会暴露。
pub fn spawn_outbox_sweeper(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(OUTBOX_SWEEPER_INTERVAL_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;

            let now = db::now_ms();
            // 群文件 ACK 账本重放：上一轮（**或上一次进程**）收到 ACK 却没落终态 ⇒ 在这里补上。
            // 账本在 DB 里 ⇒ 进程重启后照样能恢复 ⇒ 这就是"跨进程恢复"的出口。
            // 平时没有待重放行 ⇒ 只是一次空查询（走 idx_group_file_acks_received）。
            replay_pending_group_file_acks(&state);
            // 群文件投递卡死收敛（P2-01）：ACK 丢了/任务死了留下的 `sending` 行
            // 10 分钟后回 pending 重投，7 天后按失败收尾 —— 不再永久转圈。
            sweep_stale_group_sending(&state);
            // 群文件会话密钥 TTL（P3-06）：只发 Offer 不发分片/死单的密钥不落库，
            // 2h 后清掉，避免随对端行为无界增长。
            sweep_stale_group_file_keys(&state);
            let deadline_single = now - crate::db::OUTBOX_FAIL_DEADLINE_MS;
            let deadline_group = now - crate::db::GROUP_OUTBOX_FAIL_DEADLINE_MS;
            let deadline_file = now - crate::db::FILE_OUTBOX_FAIL_DEADLINE_MS;
            // 可达性快照：每 tick 取一次，三条队列复用。
            // 此前每个候选行各抢一次 links 锁（500 离线行 = 500 次/tick，自审建议#4）；
            // 非空判定与 `has_link` 同口径（残留空 Vec 不算可达）。
            //
            // 2026-10-20 P0：**links ∪ 发现层在线**。链路刚断、announce 还在的对端
            // 仍算可达 ⇒ 120s 无 Ack 必须落 failed，而不是按"离线"挂 7 天。
            let reachable: std::collections::HashSet<String> = {
                let links = state.links.lock().await;
                let mut set: std::collections::HashSet<String> = links
                    .iter()
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, _)| k.clone())
                    .collect();
                drop(links);
                let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
                for (device_id, peer) in peers.iter() {
                    if outbox_peer_reachable(false, Some(peer.last_seen), now) {
                        set.insert(device_id.clone());
                    }
                }
                set
            };
            let is_reachable = |peer: &str| reachable.contains(peer);

            // --- 单聊 outbox ---
            // 候选行 = 过了 120s 仍未 Ack 的行；是否判 failed 由对端可达性决定：
            // 对端**离线**不是失败理由 —— 产品承诺「对方离线暂存、上线后自动补发」
            //（INV-P04），保留到 OUTBOX_OFFLINE_HOLD_MS 才当僵尸清理。
            // 2026-09-19 P0：此前离线 2 分钟即删行置 failed，离线补发被 sweeper 自己击穿。
            let listed = {
                // 锁中毒也要可见地继续（into_inner）：这个清扫器是"无链路消息"唯一的终态出口，
                // `else { continue }` 静默跳过整个 tick = 消息永久停在 sending（审计 A3）。
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_outbox(&dbc, deadline_single)
            };
            let candidates: Vec<(String, String, i64)> = match listed {
                Ok(rows) => rows
                    .into_iter()
                    .map(|(_, mid, peer, created)| (mid, peer, created))
                    .collect(),
                Err(e) => {
                    // 读失败不许折成"没有过期条目"：那会让这一轮静默跳过、且没有任何读数。
                    state.logger.error(
                        "outbox",
                        format!("code=OUTBOX_SWEEP_READ_FAILED kind=single err={e} —— 本轮跳过，下轮重试"),
                    );
                    Vec::new()
                }
            };
            for (msg_id, peer_id, created_at) in candidates {
                let reachable = is_reachable(&peer_id);
                if !db::should_fail_expired_outbox(reachable, now - created_at) {
                    // 离线保留是产品承诺（INV-P04），但它必须**可见**：否则用户看到
                    // 长期"发送中"时，日志里没有任何一句解释。每 5 分钟最多一行。
                    if !reachable && log_throttled("outbox_hold_offline", 300_000) {
                        state.logger.info(
                            "outbox",
                            format!(
                                "code=OUTBOX_OFFLINE_HELD kind=single msg_id={msg_id} peer={peer_id} \
                                 age_ms={} reason=peer_offline(hold_7d)",
                                now - created_at
                            ),
                        );
                    }
                    continue;
                }
                // 写库（置 failed + 删行）成功才 emit；锁只在这块作用域内持有，不跨 emit（审计 B1）。
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_message(&dbc, &msg_id, false)
                };
                if !finalized {
                    // 队列行会保留、下一 tick 重试；失败必须留痕（带码可检索）。
                    state.logger.warn(
                        "outbox",
                        format!("code=OUTBOX_FINALIZE_FAILED kind=single msg_id={msg_id}"),
                    );
                }
                if finalized {
                    state.logger.warn(
                        "outbox",
                        format!(
                            "code=OUTBOX_EXPIRED kind=single msg_id={msg_id} peer={peer_id} \
                             age_ms={} reachable={reachable} action=failed",
                            now - created_at
                        ),
                    );
                    let _ = state.app.emit("message-failed", &msg_id);
                } else {
                    // 不 emit、不删行 ⇒ 下一 tick 重试；留痕便于排障（绝不"界面说失败、行还在、又重发"）
                    state.logger.warn(
                        "outbox",
                        format!("code=OUTBOX_FINALIZE_FAILED msg_id={msg_id} peer={peer_id} —— 保留 outbox 行下轮重试"),
                    );
                }
            }

            // --- 群 outbox：行级分类 + msg 粒度放弃（2026-09-19 自审建议#5）---
            // 一条群消息按成员各一行；某成员离线 ⇒ 他的行保留（上线补发），
            // 只有**所有行都该放弃**时整条消息才置 failed。
            let listed_group = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_group_outbox(&dbc, deadline_group)
            };
            let group_rows: Vec<(String, String, String, i64)> = match listed_group {
                Ok(rows) => rows,
                Err(e) => {
                    state.logger.error(
                        "outbox",
                        format!("code=OUTBOX_SWEEP_READ_FAILED kind=group err={e} —— 本轮跳过，下轮重试"),
                    );
                    Vec::new()
                }
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
            for (msg_id, (group_id, rows)) in per_msg {
                // 逐行判定（P1-04）：每一行只看**自己那个成员**的可达性。
                // 旧写法 `rows.iter().all(...)` 把结论聚合到消息级 ⇒ 群里只要一个成员离线，
                // 在线成员的行也被一起保留 ⇒ 每 5s 重发一次、最长 7 天（≈12 万次重复信封）。
                let expired_peers: Vec<&String> = rows
                    .iter()
                    .filter(|(peer, created)| {
                        db::group_outbox_row_expired(is_reachable(peer), now - created)
                    })
                    .map(|(peer, _)| peer)
                    .collect();
                let all_give_up = expired_peers.len() == rows.len();
                if !all_give_up {
                    // 在线成员的行独立放弃；离线成员的行继续按 7 天保留（INV-P04）。
                    // 行改成 failed（不是删掉）——删掉就再也说不清“谁没收到”。
                    if !expired_peers.is_empty() {
                        let (failures, marked) = {
                            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                            let mut failures = 0usize;
                            let mut marked = 0usize;
                            for peer in &expired_peers {
                                match db::mark_group_outbox_failed(&dbc, &msg_id, peer.as_str()) {
                                    Ok(n) => marked += n,
                                    Err(_) => failures += 1,
                                }
                            }
                            (failures, marked)
                        };
                        if failures > 0 {
                            state.logger.warn(
                                "outbox",
                                format!(
                                    "code=OUTBOX_ROW_DROP_FAILED kind=group msg_id={msg_id} \
                                     group_id={group_id} rows={failures} —— 保留这些行下轮重试"
                                ),
                            );
                        } else if log_throttled("outbox_row_expired", 300_000) {
                            state.logger.info(
                                "outbox",
                                format!(
                                    "code=OUTBOX_EXPIRED kind=group msg_id={msg_id} \
                                     group_id={group_id} recipients={} action=row-failed",
                                    expired_peers.len()
                                ),
                            );
                        }
                        if failures == 0 && marked > 0 {
                            // 气泡的“N 人未收到（已超时）”要跟着变；消息状态不动。
                            let _ = state.app.emit(
                                "group-delivery-changed",
                                &serde_json::json!({ "group_id": group_id, "msg_id": msg_id }),
                            );
                        }
                    }
                    if log_throttled("outbox_hold_offline", 300_000) {
                        if let Some((peer, created)) =
                            rows.iter().find(|(peer, _)| !is_reachable(peer))
                        {
                            state.logger.info(
                                "outbox",
                                format!(
                                    "code=OUTBOX_OFFLINE_HELD kind=group msg_id={msg_id} \
                                     peer={peer} age_ms={} reason=peer_offline(hold_7d)",
                                    now - created
                                ),
                            );
                        }
                    }
                    continue;
                }
                let (delivered, cancelled) = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::group_outbox_progress_counts(&dbc, &msg_id).unwrap_or((0, 0))
                };
                if delivered > 0 || cancelled > 0 {
                    // 已经有人收到 / 用户已经取消：只把剩余 pending 行置 failed，
                    // **不**把消息改成 failed（那会把“有人收到/已取消”的事实抹掉）。
                    let (failures, marked) = {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let mut failures = 0usize;
                        let mut marked = 0usize;
                        for peer in &expired_peers {
                            match db::mark_group_outbox_failed(&dbc, &msg_id, peer.as_str()) {
                                Ok(n) => marked += n,
                                Err(_) => failures += 1,
                            }
                        }
                        (failures, marked)
                    };
                    if failures == 0 && marked > 0 {
                        let _ = state.app.emit(
                            "group-delivery-changed",
                            &serde_json::json!({ "group_id": group_id, "msg_id": msg_id }),
                        );
                    }
                    state.logger.warn(
                        "outbox",
                        format!(
                            "code=OUTBOX_EXPIRED kind=group msg_id={msg_id} group_id={group_id} \
                             recipients={} action=partial-failed delivered={delivered} cancelled={cancelled}",
                            expired_peers.len()
                        ),
                    );
                    continue;
                }
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_message(&dbc, &msg_id, true)
                };
                if !finalized {
                    state.logger.warn(
                        "outbox",
                        format!("code=OUTBOX_FINALIZE_FAILED kind=group msg_id={msg_id}"),
                    );
                }
                if finalized {
                    state.logger.warn(
                        "outbox",
                        format!(
                            "code=OUTBOX_EXPIRED kind=group msg_id={msg_id} group_id={group_id} \
                             recipients={} action=failed",
                            rows.len()
                        ),
                    );
                    let _ = state.app.emit("message-failed", &msg_id);
                } else {
                    state.logger.warn(
                        "outbox",
                        format!("code=OUTBOX_FINALIZE_FAILED kind=group msg_id={msg_id} group_id={group_id} —— 保留 outbox 行下轮重试"),
                    );
                }
            }

            // --- 文件 outbox：与消息队列同一离线判据（窗口用文件自己的 30min）---
            // 自审建议#5：离线接收方的文件此前 30min 一律判 failed ——
            // 「关机一晚回来收不到大文件」与被修的 P0#2 同型。
            let listed_files = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::list_expired_file_outbox(&dbc, deadline_file)
            };
            let expired_files: Vec<(String, String, Option<String>, i64)> = match listed_files {
                Ok(rows) => rows,
                Err(e) => {
                    state.logger.error(
                        "outbox",
                        format!(
                            "code=OUTBOX_SWEEP_READ_FAILED kind=file err={e} —— 本轮跳过，下轮重试"
                        ),
                    );
                    Vec::new()
                }
            };
            for (transfer_id, peer_id, _group_id, created_at) in expired_files {
                let reachable = is_reachable(&peer_id);
                if !db::should_fail_expired(
                    reachable,
                    now - created_at,
                    crate::db::FILE_OUTBOX_FAIL_DEADLINE_MS,
                    crate::db::OUTBOX_OFFLINE_HOLD_MS,
                ) {
                    if !reachable && log_throttled("outbox_hold_offline", 300_000) {
                        state.logger.info(
                            "outbox",
                            format!(
                                "code=OUTBOX_OFFLINE_HELD kind=file transfer_id={transfer_id} \
                                 peer={peer_id} age_ms={} reason=peer_offline(hold_7d)",
                                now - created_at
                            ),
                        );
                    }
                    continue;
                }
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finalize_expired_file(&dbc, &transfer_id)
                };
                match finalized {
                    Ok(true) => {
                        state.logger.warn(
                            "outbox",
                            format!(
                                "code=FILE_OUTBOX_EXPIRED transfer_id={transfer_id} peer={peer_id} \
                                 age_ms={} reachable={reachable} action=failed",
                                now - created_at
                            ),
                        );
                        // 载荷必须是 `FileFailedInfo`（`{transfer_id, reason}`）：前端按这个形状取值。
                        // 曾经这里发的是裸字符串 ⇒ toast 显示「undefined」、气泡永远停在发送中（N-01）。
                        let _ = state.app.emit(
                            "file-failed",
                            &FileFailedInfo {
                                transfer_id: transfer_id.clone(),
                                reason: "文件发送超时：超过重发期限仍未送达".to_string(),
                            },
                        );
                    }
                    Ok(false) => {
                        state.logger.warn(
                            "outbox",
                            format!("code=FILE_OUTBOX_FINALIZE_FAILED transfer_id={transfer_id} changed=false —— 保留 file_outbox 行下轮重试"),
                        );
                    }
                    Err(e) => state.logger.error(
                        "outbox",
                        format!(
                            "code=FILE_FINALIZE_FAILED transfer_id={transfer_id} ctx=expired err={e} —— 事务已回滚，保留行下轮重试"
                        ),
                    ),
                }
            }

            // --- 发送侧 pending 台账对账（孤儿 / 重试耗尽）---
            // 与启动时同一个 DB 出口：只碰 direction='send'，每轮上限由查询自身决定。
            // 这一步是“传输面板里那条永远排队”的兜底：即使删会话/删好友留下了孤儿，
            // 2 分钟后也会被推进终态，而不是等用户重启或手动取消。
            let reconciled = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::reconcile_pending_send_transfers(&dbc)
            };
            match reconciled {
                Ok(report) => {
                    for transfer_id in report.changed {
                        state.logger.warn(
                            "outbox",
                            format!(
                                "code=FILE_TRANSFER_ORPHAN_RECONCILED transfer_id={transfer_id} action=pending→failed"
                            ),
                        );
                        let _ = state.app.emit(
                            "file-failed",
                            &FileFailedInfo {
                                transfer_id,
                                reason: "发送队列记录已丢失或重试次数已用尽，已停止重试".to_string(),
                            },
                        );
                    }
                    for (transfer_id, why) in report.failed {
                        state.logger.error(
                            "outbox",
                            format!(
                                "code=FILE_FINALIZE_FAILED transfer_id={transfer_id} ctx=orphan_reconcile err={why} —— 保留行下一轮再试"
                            ),
                        );
                    }
                }
                Err(e) => state.logger.warn(
                    "outbox",
                    format!("code=FILE_TRANSFER_ORPHAN_RECONCILE_FAILED err={e} —— 下一轮再试"),
                ),
            }

            // --- 内容台账对账（B2）：文件层说"done"、内容层却还不知道的那些行 ---
            // 见 `reconcile_completed_content` 的注释：这一格就是"每次建链整批重投"的永动来源。
            // 两相位：① 短锁取候选；② **不持锁**读盘算摘要（600MB 的哈希不能占着 db 锁）；
            // ③ 短锁写回。每 tick 上限 `CONTENT_RECONCILE_PER_TICK` 条 ⇒ 有界，不随积压增长。
            let cands = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                list_reconcilable_content(&dbc, CONTENT_RECONCILE_PER_TICK).unwrap_or_default()
            };
            // ★ 2026-10-14 真机之后加的两道隔离（用户：Mac 往 Windows 传 3.x GB，收尾那一段
            // 「点设置没窗、拖窗口没反应」）。条数上限**管不住字节**：8 条 GB 级候选就是单轮
            // 几十 GB 读盘，而这份读盘原本直接在 async 执行路径上 —— 同一个 runtime 上还跑着
            // 所有 async 命令（开设置窗就是其中之一），worker 被占满 ⇒ 用户点什么都没反应。
            //   ① 整文件哈希交给 `spawn_blocking`（阻塞线程池），worker 立刻回到调度池；
            //   ② 单轮**字节**预算 `CONTENT_RECONCILE_TICK_BYTE_BUDGET`，但**第一条恒放行**
            //      （否则一个超大候选永远排不进预算 ⇒ 那一行台账饿死；有界的含义是"每轮最多读
            //      这么多盘"，不是"大文件永远不对账"）；
            //   ③ 跳过**还在写的那半截**：`file_receivers` 里仍有同一个 `transfer_id`（那说明这份
            //      文件正在收，哈希必然对不上，纯抢带宽），或这份 `.part` 的 mtime 还在最近 60s 内
            //      （真的在落盘）。⚠️ 只看 `.part` 后缀会永久饿死一个"名字就叫 xxx.part"的成品文件
            //      —— 这一列里从来只写改名后的最终路径，判据细节见 `part_is_being_written`。
            let inflight: std::collections::HashSet<String> = {
                let recv = state
                    .file_receivers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                recv.keys().cloned().collect()
            };
            let mut byte_budget = CONTENT_RECONCILE_TICK_BYTE_BUDGET;
            let mut scanned = 0usize;
            for c in cands {
                if inflight.contains(&c.transfer_id) || part_is_being_written(&c.path, db::now_ms())
                {
                    state.logger.info(
                        "content",
                        format!(
                            "内容台账对账跳过在途的那半截（正在收/这份 .part 还在写），本轮不读盘 cid={} from={}",
                            c.cid, c.peer_id
                        ),
                    );
                    continue;
                }
                if !reconcile_take_next(scanned, byte_budget, c.size) {
                    // 预算用完 ⇒ 剩下的留到下一 tick（`ORDER BY updated_at ASC` 保证老的那批先做）
                    if log_throttled("content_reconcile_budget", 30_000) {
                        state.logger.info(
                            "content",
                            format!(
                                "内容台账对账本轮字节预算用完（剩余 {byte_budget} 字节 < 下一条 {} 字节），下轮继续",
                                c.size
                            ),
                        );
                    }
                    break;
                }
                byte_budget = byte_budget.saturating_sub(c.size);
                scanned += 1;
                let (cid, path, size) = (c.cid.clone(), c.path.clone(), c.size);
                let ok = match tokio::task::spawn_blocking(move || {
                    content_file_matches(&cid, &path, size)
                })
                .await
                {
                    Ok(v) => v,
                    // 阻塞任务被中断（panic / 运行时关闭）⇒ **不写回、不谎报**，那一行留在可恢复态，
                    // 下一 tick 自然重来。写 `false` 会把"我没验过"说成"文件坏了"。
                    Err(e) => {
                        state.logger.warn(
                            "content",
                            format!(
                                "内容台账对账的读盘任务被中断，保留可恢复态下轮再试 cid={}: {e}",
                                c.cid
                            ),
                        );
                        continue;
                    }
                };
                let wrote = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    finish_reconcile(&dbc, &c, db::now_ms(), ok)
                };
                if ok && !wrote {
                    state.logger.warn(
                        "content",
                        format!(
                            "内容台账对账写回失败，保留可恢复状态下轮再试 cid={} from={}",
                            c.cid, c.peer_id
                        ),
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

/// 每 tick 最多**读多少字节**的盘来做对账（2026-10-14 真机之后加的 second bound）。
///
/// 为什么条数上限不够：条数封顶管不住单件体积 —— 8 条 3 GB 的收件文件就是单轮 ~24 GB 读盘，
/// 而这份读盘是**同步**的（分块喂哈希器，但仍在线程上跑到完）。Windows 上表现就是用户报的
/// 「传大文件期间点设置没窗、拖窗口没反应」：同一个 async runtime 上还跑着所有 async 命令。
/// 256 MiB 的选择：够在 30s 一轮里消化掉若干普通图片/文件（一轮 ≪ 磁盘 30 秒的预算），
/// 又不至于让某个 tick 独占 I/O 几十秒。
pub(crate) const CONTENT_RECONCILE_TICK_BYTE_BUDGET: u64 = 256 * 1024 * 1024;

/// 字节预算判定（**纯函数**，便于单测）：本轮要不要读这一条的盘。两条规则合在这里，
/// 免得"第一条恒放行"与"预算够不够"两处各写一遍（那就是缺陷会漏的那族）。
/// ① 本轮还一条都没读 ⇒ 恒放行 —— 超大候选**不许被永久饿死**（那一行台账会永远停在可恢复态，
///    而每次建链都会整批重投它，正是 B2 要治的那个永动来源）；
/// ② 否则必须装得下剩余预算。边界取 `<=`：恰好等于预算算装得下。
pub(crate) fn reconcile_take_next(scanned: usize, budget: u64, size: u64) -> bool {
    scanned == 0 || size <= budget
}

/// 这一条路径是不是**还没写完的半截**（`.part` 是 `make_receiver` 的命名口径）。
/// 半截文件的字节数与摘要必然对不上，花几十秒读它再判"不完成"是纯浪费，
/// 而且会把**正在进行的传输**的磁盘带宽抢走 —— 那正是"越大的文件越容易卡住界面"的形状。
pub(crate) fn is_inflight_reconcile_path(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        == Some("part")
}

/// 「正在被写」的判定窗口：比一轮 tick（30s）宽一倍，覆盖两次写入之间的空档。
pub(crate) const RECONCILE_PART_ACTIVE_MS: i64 = 60_000;

/// 后缀是 `.part` **且此刻磁盘上那份还在被写**（mtime 落在 `RECONCILE_PART_ACTIVE_MS` 内）。
///
/// ⚠️ 为什么不能只看后缀（评审 2026-10-14 抓到的那条我自造的坑）：这里的 path 取自
/// `file_transfers.path`，而那一列**只有改名落盘之后才会被写**（`finish_receiver_into` 写的是
/// 最终路径；`fail_taken_receive` 里原话"不能把 .part 写进 path"，中继那份是 `<id>.relay.part`
/// 也从不进这一列）。⇒ 后缀命中"在途半截"的情况其实不存在，真正会命中的是
/// **用户本来就把文件叫做 `xxx.part`**（浏览器未完成的下载、分卷包都是这个后缀）——
/// 那份早就收完了，按后缀跳过就是**这一行台账每轮都被跳过、永远对不上账**，
/// 于是每次建链整批重投 ⇒ 又变回 B2 要杀的那个永动来源。
/// ⇒ "正在写"必须由 mtime 说话；真正的在途传输另有 `file_receivers` 那份 `transfer_id` 兜着。
pub(crate) fn part_is_being_written(path: &str, now_ms: i64) -> bool {
    if !is_inflight_reconcile_path(path) {
        return false;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(millis) = mtime.duration_since(std::time::UNIX_EPOCH) else {
        return false;
    };
    let written_at = millis.as_millis() as i64;
    // 允许 ±：机器时钟回拨时不许让一份文件永久判成"正在写"
    (now_ms - written_at).abs() < RECONCILE_PART_ACTIVE_MS
}

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
///
/// ⚠️ **分块喂哈希器，不许整读进内存**（与 `network/file/receive.rs` 的续传前缀校验、
///   `network/file/relay_push.rs` 的逐片读盘同一立场）。这里原先是**一次整读整份文件**：
///   这一条跑在**无人操作的 30s 空闲 tick** 上，一份几百 MB 的收件文件会让进程瞬间占用
///   ≈ 文件大小的内存；而分配失败在 Rust 里是 **abort 而不是 panic** —— panic hook 不记、
///   release 又开着 `panic = "abort"`，表现就是用户 2026-10-14 报的
///   「Windows 开着不动，过会儿自己就关了」（日志里一个字都没有，正是这条路径的形状）。
///   ⚠️ 这句刻意不写成那个调用的字面量：按形状扫全集的守卫
///   `transport_src_never_whole_file_read` 会把自己写的注释读成缺陷（"注释里复述被断言的那句"
///   这一族本仓踩过，见那条守卫的注释）。
pub(crate) fn content_file_matches(cid: &str, path: &str, size: u64) -> bool {
    use sha2::Digest as _;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() != size {
        return false;
    }
    let Ok(mut src) = std::fs::File::open(path) else {
        return false;
    };
    let mut h = sha2::Sha256::new();
    let mut buf = vec![0u8; crate::protocol::FILE_CHUNK];
    loop {
        // 读失败（权限、被外部删掉、磁盘错）都算"对不上"，交给下一 tick 再看，不谎报 complete。
        match std::io::Read::read(&mut src, &mut buf) {
            Ok(0) => break,
            Ok(n) => h.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    let hex = crate::crypto::hex_lower(&h.finalize());
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
mod outbox_reachability_tests {
    use super::{outbox_peer_reachable, OUTBOX_PEER_ONLINE_WINDOW_MS};

    /// 2026-10-20 永久发送中 P0 的判据：**链路没了但发现层还在线，也算可达**。
    ///
    /// 旧实现只看 `links`：链路一断就按"离线"保留 7 天，用户看到的就是长期"发送中"。
    /// 这里把三种证据分开钉：活链路、发现层在线（窗口内）、两者都没有。
    #[test]
    fn discovery_online_counts_as_reachable_even_without_a_live_link() {
        let now = 10_000_000i64;
        // 活链路：不看 last_seen
        assert!(outbox_peer_reachable(true, None, now));
        // 无链路，但 45s 内还在广播 ⇒ 可达（窗口边界取 >=）
        assert!(outbox_peer_reachable(
            false,
            Some(now - OUTBOX_PEER_ONLINE_WINDOW_MS),
            now
        ));
        // 再老 1ms ⇒ 不再算在线
        assert!(!outbox_peer_reachable(
            false,
            Some(now - OUTBOX_PEER_ONLINE_WINDOW_MS - 1),
            now
        ));
        // 从没发现过 ⇒ 不可达
        assert!(!outbox_peer_reachable(false, None, now));
        // 本机时钟回拨（last_seen 在未来）不许把在线读成离线
        assert!(outbox_peer_reachable(false, Some(now + 1_000), now));
    }

    /// 窗口必须与 discovery 回收跨跳节点的 45s 同源，不许在清扫器里另造一个数。
    #[test]
    fn online_window_comes_from_the_discovery_timeout() {
        assert_eq!(
            OUTBOX_PEER_ONLINE_WINDOW_MS,
            crate::protocol::RELAY_PEER_TIMEOUT_SECS * 1000
        );
    }
}

#[cfg(test)]
mod content_reconcile_tests {
    use super::{
        content_file_matches, finish_reconcile, is_inflight_reconcile_path,
        list_reconcilable_content, part_is_being_written, reconcile_take_next, ReconcileCandidate,
        CONTENT_RECONCILE_PER_TICK, CONTENT_RECONCILE_TICK_BYTE_BUDGET, RECONCILE_PART_ACTIVE_MS,
    };
    use crate::content::model::{Direction, TransferRecord, TransferStatus};

    use crate::crypto::sha256_hex as sha_hex;

    fn db_both() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        crate::content::store::ensure_schema(&c).unwrap();
        c
    }

    fn temp_file(tag: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "gosslan-reconcile-{tag}-{}.bin",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// 内容层的一行（默认 receive/incomplete、无 path，就是"还在等对端给"的形状）。
    fn seed_content(
        c: &rusqlite::Connection,
        cid: &str,
        tid: &str,
        status: TransferStatus,
        path: Option<&str>,
    ) {
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
        assert!(content_file_matches(
            &cid,
            &cands[0].path,
            bytes.len() as u64
        ));
        assert!(finish_reconcile(&c, &cands[0], crate::db::now_ms(), true));

        let rec = crate::content::store::get(&c, &cid, "dev-a", Direction::Receive)
            .unwrap()
            .unwrap();
        assert_eq!(rec.status, TransferStatus::Complete, "对账通过必须收口");
        assert_eq!(rec.path.as_deref(), Some(p.to_str().unwrap()));
        assert_eq!(rec.received, 2048);
        let resumable = crate::content::store::list_resumable_for_peer(&c, "dev-a").unwrap();
        assert!(
            resumable.is_empty(),
            "收口之后不许再被重投，实得 {resumable:?}"
        );
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
        assert!(
            !content_file_matches(&cid, &cands[0].path, 2048),
            "摘要不符必须判不可用"
        );
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
        seed_content(
            &c,
            "cid-done",
            "xa",
            TransferStatus::Complete,
            Some("/tmp/whatever.bin"),
        );
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
            seed_content(
                &c,
                &format!("cid{i:02}"),
                &tid,
                TransferStatus::Incomplete,
                None,
            );
            seed_file(&c, &tid, "done", Some("/tmp/none.bin"));
        }
        assert_eq!(
            list_reconcilable_content(&c, 8).unwrap().len(),
            8,
            "单轮上限必须生效"
        );
        assert_eq!(list_reconcilable_content(&c, 1).unwrap().len(), 1);
        let _: ReconcileCandidate; // 类型被用到（避免未使用告警）
    }

    /// ⑥ 第二条界（字节）与"第一条恒放行"（2026-10-14 真机：3.x GB 对账把窗口操作挤死）。
    /// 两条规则各一反一正：只看条数上限会放进来 8 个 GB 级候选；只按字节封顶会把超大那一条
    /// **永久饿死**（它永远排不进预算 ⇒ 那一行台账停在可恢复态，每次建链整批重投）。
    #[test]
    fn reconcile_byte_budget_bounds_a_round_without_starving_oversize_files() {
        // 正：装得下就下一轮继续读
        assert!(reconcile_take_next(1, 256 << 20, 200 << 20));
        // 边界：恰好等于剩余预算算装得下（`<=` 不是 `<`）
        assert!(reconcile_take_next(1, 100, 100));
        // 反：装不下就本轮收手（留到下一 tick，`ORDER BY updated_at ASC` 保证不饿死老的）
        assert!(!reconcile_take_next(1, 100, 101));
        // ★ 第一条恒放行：3 GB 的候选在 256 MiB 预算下也必须被读一次
        assert!(reconcile_take_next(0, 256 << 20, 3 << 30));
        // 有界性口径本身：预算与条数上限是两个独立界，都不许写死成"不限"
        assert_eq!(CONTENT_RECONCILE_PER_TICK, 8);
        assert_eq!(CONTENT_RECONCILE_TICK_BYTE_BUDGET, 256 * 1024 * 1024);
    }

    /// ⑦ 在途的那半截不许读盘：`.part` 是 `make_receiver` 的命名口径，
    /// ⑦ 在途的那半截不许读盘：`.part` 是 `make_receiver` 的命名口径，它的字节数与摘要
    /// 必然对不上 —— 花几十秒读它再判「不完成」，抢的正是当前传输的磁盘带宽。
    ///
    /// ★ 但**只按后缀会把一行台账永久饿死**（评审 2026-10-14 抓到我自己造的那条坑）：候选的 path
    /// 取自 `file_transfers.path`，而那一列只有改名落盘之后才被写 ⇒ 后缀命中的更可能是
    /// 「用户本来就把文件叫做 `xxx.part`」（浏览器未完成的下载、分卷包都是这个后缀），而那份早收完了。
    /// ⇒ 「正在写」必须由 **mtime** 说话。两个方向都钉住：新鲜 ⇒ 跳过；陈旧 ⇒ 必须放行去对账。
    #[test]
    #[allow(clippy::assertions_on_constants)] // 夹具时间必须落在对账窗口之外（常量断言）
    fn inflight_part_files_are_skipped_but_a_part_named_deliverable_is_not_starved() {
        use std::fs::OpenOptions;
        use std::time::{Duration, SystemTime};

        // 后缀判定本身（一正一反）
        assert!(is_inflight_reconcile_path("/x/y/abc.part"));
        assert!(is_inflight_reconcile_path("abc.part"));
        assert!(!is_inflight_reconcile_path("/x/y/报告.pdf"));
        assert!(!is_inflight_reconcile_path("/x/y/abc"));
        assert!(!is_inflight_reconcile_path("/x/part/abc.bin"));

        // 窗口至少覆盖一轮 tick，否则一次慢写入会被当成「已收完」而去哈希半截文件
        assert!(
            RECONCILE_PART_ACTIVE_MS as u64
                >= crate::network::transport::OUTBOX_SWEEPER_INTERVAL_MS,
            "判定窗口比 tick 还短的话，一轮没写完的文件会被当成品去哈希"
        );

        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let now = crate::db::now_ms();
        let fresh = dir.join("live.part");
        let aged = dir.join("named-as-part.part"); // 用户真的把文件叫这个名字，且早已收完
        let done = dir.join("final.pdf");
        for p in [&fresh, &aged, &done] {
            std::fs::write(p, b"x").unwrap();
        }
        assert!(600_000 >= RECONCILE_PART_ACTIVE_MS, "夹具必须落在窗口之外");
        let ten_min_ago = SystemTime::UNIX_EPOCH + Duration::from_millis((now - 600_000) as u64);
        for p in [&aged, &done] {
            let f = OpenOptions::new().write(true).open(p).unwrap();
            f.set_modified(ten_min_ago).unwrap();
        }

        assert!(
            part_is_being_written(fresh.to_str().unwrap(), now),
            "mtime 还新鲜的 .part = 真在写 ⇒ 本轮不读盘"
        );
        assert!(
            !part_is_being_written(aged.to_str().unwrap(), now),
            "十分钟没动过的 .part 就是成品 ⇒ 必须放行去对账，否则那一行台账每轮被跳过、永动重投又回来了"
        );
        assert!(
            !part_is_being_written(done.to_str().unwrap(), now),
            "后缀不是 .part 就不进这道判定"
        );
        assert!(
            !part_is_being_written(dir.join("gone.part").to_str().unwrap(), now),
            "文件不在盘上不算「正在写」（该走原来那条读不到内容的分支）"
        );
    }
}
