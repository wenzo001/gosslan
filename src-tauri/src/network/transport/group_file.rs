// 群文件传输：offer / chunk / done / 完成回执、失败与停滞回收
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第三批；守卫视图与领域图的分册清单一同登记。

/// 接收器至少静默这么久，才把重复 Offer 当成“发送方在重试”而不是网络重复。
///
/// 发送侧的停滞判据是 15s 告警 / 60s 中止，重试一定发生在接收器已经停喂之后；
/// 而网络层重复送达的 Offer 往往落在正在收的那一段里（`fed_at_ms` 是新鲜的）。
const GROUP_FILE_RETRY_RESET_MIN_IDLE_MS: i64 = 5_000;

/// 收到重复 GroupFileOffer 时该怎么办（纯函数，便于单测钉住三种结局）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GroupOfferRetry {
    /// 本地已收完 ⇒ 只重发完成 ACK（发送端可能丢了上一条），绝不重传文件。
    ReAck,
    /// 会话还在、但接收段已经停了 ⇒ 按 transfer_id 截断 `.part`，从 seq 0 重来。
    Reset,
    /// 会话还在、而且刚刚还在收 ⇒ 网络重复，忽略。
    /// 也用于“接收器不在”（收尾中/刚被清扫）：不在 Offer 时抢 `.part`。
    Ignore,
}

pub(crate) fn group_offer_retry_action(
    already_completed: bool,
    receiver_idle_ms: Option<i64>,
) -> GroupOfferRetry {
    if already_completed {
        return GroupOfferRetry::ReAck;
    }
    match receiver_idle_ms {
        Some(idle) if idle < GROUP_FILE_RETRY_RESET_MIN_IDLE_MS => GroupOfferRetry::Ignore,
        // 接收器不在 = 可能正在 `spawn_blocking` 收尾（receiver 已摘、key 还在）。
        // 这时候按 Offer 截断 `.part` 会与收尾线程抢同一个文件 ⇒ 只忽略；
        // 重试的分片到达时 `handle_group_file_chunk` 会自己建一份新接收器。
        None => GroupOfferRetry::Ignore,
        _ => GroupOfferRetry::Reset,
    }
}

/// 这一帧属于当前轮次吗（P1-03 真续传的轮次隔离）。
///
/// `None`（旧端/本字段上线前的帧）⇒ 恒真，保持旧行为；`Some` 必须等于该 transfer 的
/// 当前轮次；查不到当前轮次也恒真（没有 Offer 的旧帧不该因为本机没记轮次而被丢）。
fn group_frame_is_current(state: &AppState, transfer_id: &str, attempt: Option<u64>) -> bool {
    let cur = state
        .group_file_rounds
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(transfer_id)
        .copied();
    file::group_frame_round_is_current(attempt, cur)
}

/// 收到「取消这一格」的帧（B3b）：发送方与接收方都可能发，方向由**谁发**决定。
///
/// 三种落法（都先把「这一帧是不是关于这一单的」验掉，再动手）：
///
/// 1. 本机是**发送方** + 成员说他不再收了 ⇒ 点亮那一格的取消槽位（在途投递循环自己退出）
///    + 那一行落 `cancelled`（硬终态：离线补发与续传复位都看不见它）；
/// 2. 本机是**接收方** + 发送方说这一格停了 ⇒ 摘接收器、删 `.part`、整单行落 `cancelled`；
/// 3. 其余（既不是我的单、group_id 对不上、recipient 不是我）⇒ 记一条日志丢掉。
///
/// 不做「收到取消再回一条取消」的回声：回执的语义是「我停了」，双方各说一次就够了 ——
/// 回声会让两边在链路上互相确认到对方超时。
pub(crate) async fn handle_group_file_cancel(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    recipient: String,
    from: String,
) {
    if from != peer_id || from == state.device_id {
        return;
    }
    // 这个 id 会拼进删除路径（`cancel_group_receive` 的 `<tid>.part`）⇒ 入口必须过白名单。
    // 只记长度，不把对端给的原串写进日志（它可以带换行/控制字符）。
    let Some(transfer_id) = file::safe_transfer_id(&transfer_id) else {
        state.logger.warn(
            "group_file",
            format!(
                "GroupFileCancel 的 transfer_id 非法，丢弃 frame_len={} peer={peer_id}",
                transfer_id.len()
            ),
        );
        return;
    };
    let gf = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group_file(&dbc, &transfer_id)
    };
    let Some(gf) = gf else {
        state.logger.warn(
            "group_file",
            format!("收到 GroupFileCancel 但本机没有这一单 transfer={transfer_id} peer={peer_id}"),
        );
        return;
    };
    if gf.group_id != group_id {
        state.logger.warn(
            "group_file",
            format!(
                "收到 GroupFileCancel 但 group 对不上 transfer={transfer_id} frame_group={group_id} ledger_group={} peer={peer_id}",
                gf.group_id
            ),
        );
        return;
    }
    if gf.sender_id == state.device_id {
        // 我是发送方：只有本人能说"我不收了"。
        if recipient != from {
            state.logger.warn(
                "group_file",
                format!("收到 GroupFileCancel 但 recipient 不是发帧那台设备 transfer={transfer_id} recipient={recipient} from={from}"),
            );
            return;
        }
        let signalled = file::signal_cancel_slot(state, &transfer_id, &recipient);
        let cancelled = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::cancel_group_file_recipient(&dbc, &transfer_id, &recipient).unwrap_or(false)
        };
        if cancelled {
            let _ = state
                .app
                .emit("message-status-changed", &format!("gfile-{transfer_id}"));
        }
        state.logger.info(
            "group_file",
            format!(
                "对端取消了这一格 transfer={transfer_id} recipient={recipient} signalled={signalled} row_cancelled={cancelled}"
            ),
        );
        return;
    }
    if recipient == state.device_id {
        // 我是接收方：发送方说这一格停了。删 `.part` 是阻塞活 ⇒ 挪出 worker（INV-P34）。
        let s2 = state.clone();
        let tid = transfer_id.clone();
        let stopped = match tokio::task::spawn_blocking(move || {
            file::cancel_group_receive(&s2, &tid)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => {
                state.logger.error(
                    "group_file",
                    format!("对端取消后收尾被线程池中断 transfer={transfer_id}：{e}（.part 可能还在）"),
                );
                false
            }
        };
        {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            // FUNC-02：写失败必须留痕（旧写法 `let _ =` 把台账失败吞掉，界面照样说"已停手"）。
            if let Err(e) = db::mark_group_file_cancelled(&dbc, &transfer_id) {
                state.logger.error(
                    "group_file",
                    format!("code=GROUP_CANCEL_COMMIT_FAILED transfer={transfer_id} source=peer_cancel：{e}"),
                );
            }
        }
        let _ = state.app.emit("file-cancelled", &transfer_id);
        let _ = state
            .app
            .emit("message-status-changed", &format!("gfile-{transfer_id}"));
        state.logger.info(
            "group_file",
            format!("发送方取消了这一格，本机已停手 transfer={transfer_id} stopped={stopped}"),
        );
        return;
    }
    state.logger.warn(
        "group_file",
        format!("收到 GroupFileCancel 但与本机无关 transfer={transfer_id} recipient={recipient} peer={peer_id}"),
    );
}

/// 收到接收端的续传回执：把 `received` 交给正在等这个成员回执的发送任务。
async fn handle_group_file_resume(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    to_sender: String,
    received: u64,
) {
    if to_sender != state.device_id {
        return;
    }
    let gf = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group_file(&dbc, &transfer_id)
    };
    let Some(gf) = gf else {
        return;
    };
    if gf.sender_id != state.device_id || gf.group_id != group_id {
        return;
    }
    let key = file::file_peer_key(&transfer_id, peer_id);
    let tx = state
        .group_file_resume_waiters
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    if let Some(tx) = tx {
        let _ = tx.send(received);
    }
}

/// 确保接收侧的 `group_files` / recipient 行存在（续传/接收端重启后内存丢了、
/// 但会话行可能还在）。只写库，不建接收器。
#[allow(clippy::too_many_arguments)]
fn ensure_group_file_row(
    state: &AppState,
    transfer_id: &str,
    group_id: &str,
    sender_id: &str,
    name: &str,
    size: u64,
    sha256: &str,
    scope: &str,
    todo_id: &str,
) -> bool {
    let gf = crate::state::GroupFile {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: sender_id.to_string(),
        name: name.to_string(),
        size,
        sha256: sha256.to_string(),
        status: "sending".to_string(),
        created_at: db::now_ms(),
        scope: scope.to_string(),
        todo_id: todo_id.to_string(),
    };
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db::upsert_group_file_receive(&dbc, &gf, &state.device_id).is_ok()
}

/// 给发送端回一条续传偏移（接收端是权威）。
async fn send_group_file_resume(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    sender_id: &str,
    received: u64,
) {
    let msg = Message::GroupFileResume {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        to_sender: sender_id.to_string(),
        received,
    };
    if let Err(e) = try_send(state, sender_id, &msg).await {
        state.logger.warn(
            "group_file",
            format!("续传回执发送失败 transfer={transfer_id} peer={sender_id}：{e}"),
        );
    }
}

/// 处理群文件发起（Offer → 验证 → file_key 解封 → 保存会话状态）。
/// 本阶段不写文件、不创建 `.part`、不自动 FileAccept——分片传输在下一阶段。
#[allow(clippy::too_many_arguments)]
async fn handle_group_file_offer(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    sender_id: String,
    name: String,
    size: u64,
    sha256: String,
    sealed_file_key: String,
    scope: String,
    todo_id: String,
    attempt: Option<u64>,
) {
    // 链路上报的 sender 必须与 Offer 声明一致，且不能是自己
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 文件名同理（2026-10-29 审计 SEC-12）：它会被显示在气泡/任务卡片上，也会参与落盘目录
    // 之外的展示逻辑 —— 带 `/`、`\\`、NUL 或 `..` 的名字一律拒收，规则与分享/单聊那条共用
    // `file::safe_file_name`（唯一一份）。空名也在这里挡掉（`None` 就是"这个名字不能用"）。
    let Some(name) = file::safe_file_name(&name) else {
        state.logger.warn(
            "group_file",
            format!("GroupFileOffer 的 name 非法，丢弃 transfer={transfer_id} peer={peer_id}"),
        );
        return;
    };
    // 这个 id 会落进台账，并在取消/续传分支拼成 `<tid>.part` 的**删除路径**
    // （`cancel_group_receive` 与下面 Restart 分支）⇒ 在第一次落库之前就过白名单。
    let Some(transfer_id) = file::safe_transfer_id(&transfer_id) else {
        state.logger.warn(
            "group_file",
            format!(
                "GroupFileOffer 的 transfer_id 非法，丢弃 frame_len={} peer={peer_id}",
                transfer_id.len()
            ),
        );
        return;
    };
    // ⚠️ 重复 Offer 的处置必须排在权限校验**之后**（下面）：重试会重置接收段，
    // 若不过在群/成员校验，任何群成员都能拿一个已知 transfer_id 打断别人的接收。
    // 权限：本地群存在，且 sender ∈ group_members（防群外 peer 伪造 Offer）
    let (group_exists, sender_is_member) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::get_group(&dbc, &group_id) {
            Some(g) => (true, g.members.contains(&sender_id)),
            None => (false, false),
        }
    };
    if !group_exists || !sender_is_member {
        return;
    }
    // 已有的 transfer 必须仍由同一个 sender 发往同一个群 —— 否则任何群成员都能拿一个
    // 已知 transfer_id 发重复 Offer，触发下面的接收段重置，打断别人的接收。
    let existing_gf = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group_file(&dbc, &transfer_id)
    };
    if let Some(gf) = &existing_gf {
        if gf.sender_id != sender_id || gf.group_id != group_id {
            return;
        }
    }
    // 轮次：只有同一发送者的**新**轮次才推进；落后轮次忽略，同轮次重复 Offer 不重置接收段。
    let mut is_new_round = false;
    if let Some(a) = attempt {
        let mut rounds = state
            .group_file_rounds
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = rounds.get(&transfer_id).copied();
        if prev.is_some_and(|cur| a < cur) {
            return;
        }
        is_new_round = prev != Some(a);
        rounds.insert(transfer_id.clone(), a);
    }
    // 已收完 / 会话还在 = 重复 Offer（发送方重试，或网络重复）。这两条都不需要解封群密钥。
    let already_done = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group_file_recipient_status(&dbc, &transfer_id, &state.device_id).as_deref()
            == Some("completed")
    };
    // 命中即刷新 TTL：续传/重试也是活动，2h 的清扫器不该把大文件中途收走。
    let existing_key = state.touch_group_file_key(&transfer_id);
    // ── 真续传（S2）：带轮次的 Offer 说明发送端**确实在等**回执（我方宣告了能力位）──
    // `attempt` 不是"发送端支持"的声明，而是"这一轮发送端会等 Resume"的握手标记；
    // 发送端只在看到我方能力位时才带它 ⇒ 这里不需要再查对端的 feature 位，避免双方
    // feature 表不同步时"一边等、一边不回"的死等。
    if attempt.is_some() {
        if !is_new_round {
            // 同轮的重复 Offer：发送方已经在收/在等第一份回执，绝不能重置接收段。
            return;
        }
        // 取现有 key；接收端重启后 key 丢了 ⇒ 用 Offer 的 sealed_file_key 现解封并回填。
        let key = match existing_key {
            Some(k) => k,
            None => {
                let Some(group_key) = get_group_key(state, &group_id).await else {
                    return;
                };
                let Ok(sealed) = STANDARD.decode(&sealed_file_key) else {
                    return;
                };
                let Some(file_key) =
                    crypto::open_symmetric(&group_key, &sealed).and_then(|k| k.try_into().ok())
                else {
                    return;
                };
                state
                    .group_file_keys
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        transfer_id.clone(),
                        crate::state::GroupFileKey::new(file_key),
                    );
                file_key
            }
        };
        if already_done {
            send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, true).await;
            // 让发送方别干等一个不会来的 Resume：已收完 = received 等于总长。
            send_group_file_resume(state, &transfer_id, &group_id, &sender_id, size).await;
            return;
        }
        if !ensure_group_file_row(
            state,
            &transfer_id,
            &group_id,
            &sender_id,
            &name,
            size,
            &sha256,
            &scope,
            &todo_id,
        ) {
            return;
        }
        // 续传分支也必须建气泡（幂等）：否则接收端整段传输期间没有文件卡片。
        create_group_file_receive_bubble(
            state,
            &transfer_id,
            &group_id,
            &sender_id,
            &name,
            size,
            &sha256,
            &scope,
        );
        let usable = existing_gf
            .as_ref()
            .map(|gf| file::prefix_usable(size, &sha256, gf.size, &gf.sha256))
            .unwrap_or(true);
        if !usable {
            state.logger.warn(
                "group_file",
                format!("群文件续传前缀身份不符，回退整份 transfer={transfer_id}"),
            );
        }
        let (has_active, active_received, active_path) = {
            let recv = state
                .group_file_receivers
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match recv.get(&transfer_id) {
                Some(r) => (true, r.received, Some(r.tmp_path.clone())),
                None => (false, 0, None),
            }
        };
        let downloads = state
            .downloads_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let part_path = active_path
            .clone()
            .unwrap_or_else(|| downloads.join(format!("{transfer_id}.part")));
        let disk_len = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        let decision = if usable {
            file::decide_group_offer(false, has_active, active_received, disk_len, size)
        } else {
            file::GroupOfferDecision::Restart
        };
        match decision {
            file::GroupOfferDecision::AlreadyHave => {
                send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, true)
                    .await;
                send_group_file_resume(state, &transfer_id, &group_id, &sender_id, size).await;
            }
            file::GroupOfferDecision::Resume(n) => {
                // 活跃接收器与磁盘一致 ⇒ 只重置段号；否则丢掉旧句柄、按磁盘前缀重建。
                if has_active && active_received != n {
                    state
                        .group_file_receivers
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&transfer_id);
                }
                let prepared = if has_active && active_received == n {
                    let mut recv = state
                        .group_file_receivers
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    match recv.get_mut(&transfer_id) {
                        Some(r) => {
                            r.next_seq = 0;
                            r.fed_at_ms = db::now_ms();
                            true
                        }
                        None => false,
                    }
                } else {
                    let built = {
                        let (downloads, tid, peer, name2, sha2) = (
                            downloads.clone(),
                            transfer_id.clone(),
                            sender_id.clone(),
                            name.clone(),
                            sha256.clone(),
                        );
                        tokio::task::spawn_blocking(move || {
                            file::build_group_resume_receiver(
                                &downloads, &tid, &peer, &name2, size, key, sha2,
                            )
                        })
                        .await
                    };
                    match built {
                        Ok(Ok(r)) => {
                            // 重建出来的接收器同样要占一格入站配额（审计 SEC-05）：
                            // 群续传以前直接 insert，等于给配额留了一条侧门。
                            // `replacing=false`：走到这里说明上面已经确认没有活跃接收器。
                            match file::admit_inbound(state, false, &transfer_id, &sender_id, size) {
                                Ok(_admission) => {
                                    state
                                        .group_file_receivers
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .insert(transfer_id.clone(), r);
                                    true
                                }
                                Err(why) => {
                                    state.logger.warn(
                                        "group_file",
                                        format!(
                                            "群文件续传重建被入站配额拒绝 transfer={transfer_id}：{why}"
                                        ),
                                    );
                                    false
                                }
                            }
                        }
                        Ok(Err(why)) => {
                            state.logger.warn(
                                "group_file",
                                format!("群文件重建续传接收器失败 transfer={transfer_id}：{why}"),
                            );
                            false
                        }
                        Err(e) => {
                            state.logger.warn(
                                "group_file",
                                format!("群文件续传重建任务被中断 transfer={transfer_id}：{e}"),
                            );
                            false
                        }
                    }
                };
                if !prepared {
                    state
                        .group_file_receivers
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&transfer_id);
                    {
                        // 锁只在写库这一格活着；下面 send 的 await 不能跨 std MutexGuard。
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = db::update_group_file_recipient(
                            &dbc,
                            &transfer_id,
                            &state.device_id,
                            "sending",
                            0.0,
                        );
                    }
                    send_group_file_resume(state, &transfer_id, &group_id, &sender_id, 0).await;
                    return;
                }
                let progress = n as f64 / size as f64;
                {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = db::update_group_file_recipient(
                        &dbc,
                        &transfer_id,
                        &state.device_id,
                        "sending",
                        progress,
                    );
                    let final_path = state
                        .group_file_receivers
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&transfer_id)
                        .map(|r| r.final_path.clone())
                        .unwrap_or_else(|| part_path.clone());
                    let _ = db::upsert_transfer(
                        &dbc,
                        &transfer_id,
                        &sender_id,
                        &name,
                        size,
                        "receive",
                        "active",
                        Some(final_path.to_string_lossy().as_ref()),
                        progress,
                    );
                }
                send_group_file_resume(state, &transfer_id, &group_id, &sender_id, n).await;
            }
            file::GroupOfferDecision::Restart => {
                state
                    .group_file_receivers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&transfer_id);
                // 走到 Restart = 磁盘上没有可用前缀（0 字节 / ≥声明总长 / 身份不符）。
                // 旧 `.part` 必须一起删：否则下一次 Offer 会把"旧字节 + 新字节"当成
                // 可续前缀，最终 SHA 永远不符，陷入"续传→失败→再续传"的循环。
                let _ = std::fs::remove_file(&part_path);
                {
                    // 同上：guard 不能跨下面的 await。
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = db::update_group_file_recipient(
                        &dbc,
                        &transfer_id,
                        &state.device_id,
                        "sending",
                        0.0,
                    );
                }
                send_group_file_resume(state, &transfer_id, &group_id, &sender_id, 0).await;
            }
        }
        return;
    }
    if let Some(key) = existing_key {
        let idle_ms = {
            let now = db::now_ms();
            state
                .group_file_receivers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&transfer_id)
                .map(|r| now - r.fed_at_ms)
        };
        match group_offer_retry_action(already_done, idle_ms) {
            GroupOfferRetry::ReAck => {
                // 本机早已收完，只是上一条完成 ACK 丢了 ⇒ 再回一条（幂等，不重传文件）。
                send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, true)
                    .await;
            }
            GroupOfferRetry::Reset => {
                // 发送侧每次重试都从 seq 0 重发；接收器的 next_seq 还停在上一段末尾。
                // `begin_group_receive → make_receiver` 会按 transfer_id 截断同一个 `.part`
                // 并从零建接收器（单聊重试共用这一份实现）⇒ 新段分片不会被判 Duplicate 丢掉，
                // Done 时 `received == size`。
                if let Err(why) = file::begin_group_receive(
                    state,
                    &transfer_id,
                    &sender_id,
                    &name,
                    size,
                    key,
                    sha256.clone(),
                ) {
                    state.logger.warn(
                        "group_file",
                        format!("群文件重试重置接收段失败 transfer={transfer_id}：{why}"),
                    );
                } else {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = db::update_group_file_recipient(
                        &dbc,
                        &transfer_id,
                        &state.device_id,
                        "sending",
                        0.0,
                    );
                }
            }
            GroupOfferRetry::Ignore => {}
        }
        return;
    }
    if already_done {
        // 内存 key 随重启丢失，但本地确实收完过 ⇒ 只补 ACK，别重建会话。
        send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, true).await;
        return;
    }
    // 本地 GroupKey 解封 file_key（GroupKey 不离开设备；群外无法解开）
    let Some(group_key) = get_group_key(state, &group_id).await else {
        return;
    };
    let Ok(sealed) = STANDARD.decode(&sealed_file_key) else {
        return;
    };
    let Some(file_key) =
        crypto::open_symmetric(&group_key, &sealed).and_then(|k| k.try_into().ok())
    else {
        return;
    };

    // 落库前最后一道消毒（审计 P1 #13）：Offer 入口已消毒，但这一层是**写进表**之前
    // 的最后位置 —— 坏 id 一旦进 `group_files`，后续所有按 id 拼 `<tid>.part` 的路径都跟着它走。
    let Some(transfer_id) = file::safe_transfer_id(&transfer_id) else {
        state.logger.warn(
            "file",
            format!(
                "code=GROUP_FILE_BAD_TRANSFER_ID group={group_id} from={sender_id} —— 拒绝落库"
            ),
        );
        return;
    };
    // 幂等建立/重建接收会话（重启后内存 file_key 丢失，这里回填 key + 复位 recipient）
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let gf = crate::state::GroupFile {
            transfer_id: transfer_id.clone(),
            group_id: group_id.clone(),
            sender_id: sender_id.clone(),
            name: name.clone(),
            size,
            sha256: sha256.clone(),
            status: "sending".to_string(),
            created_at: db::now_ms(),
            scope: scope.clone(),
            todo_id: todo_id.clone(),
        };
        if db::upsert_group_file_receive(&dbc, &gf, &state.device_id).is_err() {
            return;
        }
    }
    create_group_file_receive_bubble(
        state,
        &transfer_id,
        &group_id,
        &sender_id,
        &name,
        size,
        &sha256,
        &scope,
    );
    // 会话密钥仅存内存，供下一阶段解密 GroupFileChunk
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(transfer_id, crate::state::GroupFileKey::new(file_key));
}

/// 接收侧建群文件气泡（Offer 与续传分支共用）。
///
/// `insert_message` 是 `INSERT OR IGNORE` ⇒ 幂等。续传分支（`attempt.is_some()`）**也必须**
/// 建一次气泡：旧路径只在 `attempt=None` 的老路里建，若续传分支跳过，接收端在整段
/// 传输期间没有气泡，完成时 `update_message_content` 也会因为行不存在而落空。
#[allow(clippy::too_many_arguments)] // 与同文件其它处理器同形：帧字段直传
fn create_group_file_receive_bubble(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    sender_id: &str,
    name: &str,
    size: u64,
    sha256: &str,
    scope: &str,
) {
    if scope == "todo" {
        return;
    }
    // 接收气泡：与发送端同一 msg_id（gfile-{transfer_id}），前端据 file-progress
    // 之外的状态事件推进。此处 status=sending，Done 校验通过后转 delivered。
    // 图片文件保持 kind="image"，业务语义不降级。
    let subtype = file::classify_file_subtype(name);
    // 同口径收敛（见单聊 FileOffer 处的说明）
    let kind = if subtype == "image" { "image" } else { "file" };
    let conv_id = format!("group:{group_id}");
    let seq = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &conv_id).unwrap_or(1)
    };
    let rec = crate::state::MessageRecord {
        fail_code: None,
        id: 0,
        msg_id: format!("gfile-{transfer_id}"),
        conv_id: conv_id.clone(),
        sender_id: sender_id.to_string(),
        receiver_id: state.device_id.clone(),
        kind: kind.to_string(),
        content: serde_json::json!({
            "name": name,
            "size": size,
            "sha256": sha256,
            "subtype": subtype,
            "progress": 0.0,
        })
        .to_string(),
        ts: db::now_ms(),
        seq,
        status: "sending".to_string(),
        // 群文件这条没有 @ 落点这回事（发送侧从来不算 mention_targets）⇒ NULL = 不知道。
        mention_targets: None,
        local_id: None,
    };
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // 落库失败必须留痕（审计 2026-10-16）：这一格是"卡片类"消息，吞掉后界面没有那张卡
        // 而日志一字不记 ⇒ 现场无从归因。不改行为：仍然继续往下走（文件已在盘上是事实），
        // 只是不再静默。
        let inserted = match db::insert_message_if_new(&dbc, &rec) {
            Ok(inserted) => inserted,
            Err(e) => {
                state.logger.error(
                    "group_file",
                    format!("群文件卡片落库失败 msg={}：{e}", rec.msg_id),
                );
                false
            }
        };
        // ⚠️ 未读只在**真的插入新行**时 +1。本函数现在被两条入口调用（fan-out 的
        // `attempt=None` pre-Offer 与 dispatch 的带轮次 Offer），无条件 touch 会让
        // 同一个群文件把群未读 +2，重试每轮再 +1（标准轴审查 2026-10-21 的回归）。
        if inserted {
            db::touch_conversation(
                &dbc,
                &format!("group:{group_id}"),
                "group",
                name,
                None,
                &format!("[群文件] {name}"),
                1,
            )
            .ok();
        }
    }
    // 重复 Offer 也重发一次（幂等 upsert）：重试时让前端把气泡从 failed 刷回 sending。
    let _ = state.app.emit("message-received", &rec);
}

/// 群文件接收失败的**原因文案**。
///
/// 为什么集中在这里而不是散在各调用点：同一句原因在两个地方写就会出现两种措辞，
/// 而"失败原因"是用户据以决定下一步的唯一依据。
const REASON_STALLED_GROUP_RECEIVE: &str = "接收超时：对方久未继续发送";
const REASON_NO_CHUNK_RECEIVED: &str = "文件传输未完成：没有收到任何分片";
const REASON_CHUNK_DECRYPT_FAILED: &str = "文件分片解密失败：内容与本机不匹配";
const REASON_CHUNK_SEQ_GAP: &str = "文件分片顺序错误：中间缺片";
const REASON_CHUNK_EXCEEDS_SIZE: &str = "文件分片超出声明大小";
/// 对端一条链路都不剩（断链）⇒ 这一单收不下去了。
pub(crate) const REASON_PEER_UNLINKED: &str = "对方连接已断开";

/// 这个失败原因是不是**稳定失败码**（⇒ 要上屏给用户）。
///
/// 判据是形状：大写字母 / 数字 / 下划线。中文自由文本一律**不上屏** ——
/// 群文件失败此前只发 `message-status-changed`（气泡转 failed），界面安静；
/// 若把每一条原因都发成 `file-failed`，断链时**每个在途群文件都会弹一次 toast**
/// （peer 断链常常同时挂着一堆传输）⇒ 那是把"可归因"做成"噪音回归"。
///
/// 稳定码则相反：它一定对应一件**用户能动手**的事（清出磁盘空间后重试），
/// 弹一次 toast 正是想要的。前端按码翻成文案（`src/utils/fileFailReason.ts`）。
fn is_stable_fail_code(reason: &str) -> bool {
    !reason.is_empty()
        && reason
            .chars()
            .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
}

/// 失败收尾：删除 `.part`、移除接收状态与会话密钥、recipient 置 failed。
/// 只影响本 transfer，不 panic、不影响其他群文件。
///
/// `reason` 是失败原因（中文自由文本或稳定码）。它**一定进日志**（可归因），
/// 但只有稳定码才上屏（见 [`is_stable_fail_code`]）。
/// 此前这里压根不往上送原因：群文件失败只发 `message-status-changed`（气泡转 failed），
/// 于是"磁盘满了"与"对方断线了"在界面上长得一模一样，用户无从下手。
/// 稳定失败码（如 `DISK_FULL`）由前端查表翻成文案；自由文本原样上屏。
fn fail_group_file_chunk(state: &Arc<AppState>, transfer_id: &str, reason: &str) {
    file::fail_group_receive(state, transfer_id);
    finalize_failed_group_receive(state, transfer_id, reason);
}

/// 摘表之后的群接收**收尾**三件事：气泡转 failed、丢掉内存里的 file_key、台账写 failed。
///
/// 从 `fail_group_file_chunk` 里单列出来，是因为对端下线那条路必须先"原子摘"再"逐个收尾"
/// （见 `file::take_group_receives_for_peer`）：摘与收尾合成一个函数的话，
/// 调用点就只能走"快照 id → 逐个收尾"，而那正是本文件 `:5232` 注释判死过的形状。
fn finalize_failed_group_receive(state: &Arc<AppState>, transfer_id: &str, reason: &str) {
    set_gfile_bubble_status(state, transfer_id, "failed");
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(transfer_id);
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::update_group_file_recipient(&dbc, transfer_id, &state.device_id, "failed", 0.0);
    }
    // 状态落了库，但**不发事件就没人知道**：前端只在收到终态事件时才动那一条气泡，
    // 于是群文件失败永远显示「发送中」，要重开会话才看得见（10-22 审计 R-02；
    // 前端那一半 `gfile-` 前缀漏匹配已同日修掉）。
    // 复用已线的 `message-status-changed` 帧（载荷就是 msg_id 字符串，与 commands/files.rs
    // 取消路径同一形状）⇒ 不新增协议消息类型。emit 必须在 db 锁**外**（锁内不许 emit）。
    let _ = state
        .app
        .emit("message-status-changed", &format!("gfile-{transfer_id}"));
    // **失败原因**：稳定码才上屏（另发一帧 `file-failed`，载荷与单聊同一形状
    // `{transfer_id, reason}`；前端 `onFileFailed` 本来就认 `gfile-` 前缀，
    // 那一族是群文件气泡的 msg_id 形状 ⇒ 复用同一帧，不新增协议消息类型）。
    // 自由文本的原因只进日志（下面那条 warn）—— 上屏会造成断链时的 toast 风暴。
    if is_stable_fail_code(reason) {
        let _ = state.app.emit(
            "file-failed",
            &crate::state::FileFailedInfo {
                transfer_id: transfer_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }
    state.logger.warn(
        "group_file",
        format!("code=GROUP_FILE_RECEIVE_FAILED transfer={transfer_id} reason={reason}"),
    );
}

/// 回收"再也没被喂过片"的接收器（第 1 步 · 故障隔离 P1 的另一半）。
///
/// 为什么必须有：断链清理现在只在**该 peer 已无任何链路**时才动手（断一条 ≠ peer 下线），
/// 于是"对端还在线、但这一单被发送侧放弃"的接收器没人回收。协议里**没有 cancel 帧**
/// （`protocol.rs` 里 `Cancel` 零命中），发送侧 60s 停滞只是自己退回 `file_outbox`，
/// 不会通知接收端。另外两个 TTL 都救不了它：`sweep_stale_parts` 明确跳过"还在表里"的
/// `.part`（把泄漏的接收器当活跃证据），而 `resume_receive` 的 24h TTL 只在**有人再来敲
/// 这一单**时才生效 —— 被放弃的单没人再来敲 ⇒ 表项与文件句柄永久留着。
///
/// 这里只摘**内存态**；摘掉之后那条 `.part` 就重新落回 `sweep_stale_parts` 的 24h 管辖，
/// 磁盘侧不另立第二份清理 policy。判据只有一份：`file::receive_is_stale`，
/// 且**与摘表同一次持锁**（`take_stalled_receive`）。落终态与 emit 一律在锁外，同 `sweep_stale_relay`。
pub fn sweep_stalled_receives(state: &Arc<AppState>) -> usize {
    const REASON: &str = "接收超时：对端久未继续发送";
    let now = db::now_ms();
    let mut reclaimed = 0usize;
    // 每轮只摘一条：判据与摘表在**同一次持锁**里完成（见 `file::take_stalled_receive`）。
    // 不能"先快照一批 id 再逐个收尾"—— 那两步之间完全可以挤进一个新 FileOffer
    // （同一 transfer_id 重建接收器、`fed_at_ms` 就是现在），按 id 收尾会把**正在收**的
    // 那一单判死。循环必然终止：`take_*` 每次真的 remove 一条。
    while let Some((id, r)) = file::take_stalled_receive(state, now) {
        file::fail_taken_receive(state, &id, &r, REASON);
        reclaimed += 1;
    }
    while let Some((id, r)) = file::take_stalled_group_receive(state, now) {
        file::fail_taken_group_receive(state, &r);
        // 剩下的收尾（气泡 / 会话密钥 / recipient）按 transfer_id 定位，与表项在不在无关；
        // 其中的 `fail_group_receive` 会因为已摘而跳过 —— 正好复用同一份收尾，不另写一份。
        fail_group_file_chunk(state, &id, REASON_STALLED_GROUP_RECEIVE);
        reclaimed += 1;
    }
    reclaimed
}

/// 群文件气泡状态推进：msg_id = gfile-{transfer_id}（收发双方本地记录）。
///
/// FUNC-02：写失败必须留痕。旧写法用 `.ok()` 吞掉 —— 气泡停在发送中而没有任何日志，
/// 排查时只能靠猜。这里只记日志、不改控制流：气泡是**投影**，它的失败不该打断传输本身
/// （真正的台账写在 `group_files` / `group_file_recipients` 里）。
fn set_gfile_bubble_status(state: &AppState, transfer_id: &str, status: &str) {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = db::set_message_status(&dbc, &format!("gfile-{transfer_id}"), status) {
        state.logger.error(
            "group_file",
            format!("code=GFILE_BUBBLE_STATUS_FAILED transfer={transfer_id} status={status}：{e}"),
        );
    }
}

/// 处理群文件发送完毕：最终校验（size + SHA-256）→ sync_all → rename → completed。
/// 幂等：session 已清理（已完成或从未建立）时安全忽略。
/// sender-side 的 completed 只代表「本机接收完成」，不是发送端 recipient 状态。
async fn handle_group_file_done(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    sender_id: String,
    attempt: Option<u64>,
) {
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 上一轮的 Done 不能把这一轮刚开头判成"未完成并删掉 .part"。
    if !group_frame_is_current(state, &transfer_id, attempt) {
        return;
    }
    // 幂等 / 无 session：已完成或从未建立 Offer session → 安全忽略
    if !state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&transfer_id)
    {
        return;
    }
    // 权限：群存在 && sender 是群成员
    let (group_exists, sender_is_member) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::get_group(&dbc, &group_id) {
            Some(g) => (true, g.members.contains(&sender_id)),
            None => (false, false),
        }
    };
    if !group_exists || !sender_is_member {
        return;
    }
    let Some(gf) = db::get_group_file(
        &state.db.lock().unwrap_or_else(|e| e.into_inner()),
        &transfer_id,
    ) else {
        return;
    };

    // 空文件：无 Chunk 阶段，Done 时才建立接收状态（0 字节 .part）
    if !state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&transfer_id)
    {
        if gf.size == 0 {
            if file::begin_group_receive(
                state,
                &transfer_id,
                &sender_id,
                &gf.name,
                0,
                [0u8; 32],
                gf.sha256.clone(),
            )
            .is_err()
            {
                return;
            }
        } else {
            // 有声明大小但一个分片都没收到 → 不完整：failed + 清理
            fail_group_file_chunk(state, &transfer_id, REASON_NO_CHUNK_RECEIVED);
            return;
        }
    }

    // 从接收表移除（取得所有权），做最终校验与落盘
    let r = match state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&transfer_id)
    {
        Some(r) => r,
        None => return,
    };

    // 1-4. 最终校验（size + SHA-256）→ sync_all → drop → rename：**整段交给阻塞线程池**。
    //
    // 这段是 GB 级秒级到几十秒的磁盘慢活，原本直接在 `reader_loop` 的 tokio 任务里跑 ⇒ 钉住一个
    // async worker，而同一个 runtime 上还排着所有 `#[tauri::command(async)]`（开设置窗/日志窗）⇒
    // 用户真机那句"传大文件期间点设置没窗"。单聊那份收尾 4.39.3 已经交出去（`finish_receive`），
    // 群这一处是**同一个根因的第二家**（4.39.4 评审登记、本轮收掉）。
    //
    // 四个失败出口原本各写一遍收尾，其中 **SHA-256 那一格漏了 `upsert_transfer`** ⇒ 校验失败时
    // `file_transfers` 永远停在 `active`（另三格写 failed）。收成一份之后那一格不再可能单独漏。
    let finalized = match tokio::task::spawn_blocking(move || file::finish_group_receive_into(r))
        .await
    {
            Ok(res) => res,
            Err(e) => Err(format!("群文件收尾任务被中断: {e}")),
        };
    let final_path = match finalized {
        Ok(p) => p,
        Err(why) => {
            state.logger.warn(
                "group_file",
                format!("群文件收尾失败 transfer={transfer_id} 原因={why}"),
            );
            set_gfile_bubble_status(state, &transfer_id, "failed");
            state
                .group_file_keys
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&transfer_id);
            {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                let _ = db::update_group_file_recipient(
                    &dbc,
                    &transfer_id,
                    &state.device_id,
                    "failed",
                    0.0,
                );
                // 接收 transfer 同步 failed（四种失败都要走到这一格，不许停在 active）
                db::upsert_transfer(
                    &dbc,
                    &transfer_id,
                    &sender_id,
                    &gf.name,
                    gf.size,
                    "receive",
                    "failed",
                    None,
                    0.0,
                )
                .ok();
            }
            send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, false).await;
            return;
        }
    };
    // 全部成功：正式文件已落盘 → completed / progress 1.0 → 气泡转 delivered → 清理
    {
        // 三张表**同一个事务**（2026-10-15 全链路审计 ⑥）。这一格此前有三处各自吞错：`let _ =` /
        // `.ok()` ⇒ 收件方那行可能停在非 completed、`file_transfers` 说 done 而 `content_transfers`
        // 那一行**根本没被构造**（群侧这一行就是在这里首次写的）。对账扫
        // `outbox_sweep.rs::list_reconcilable_content` 的谓词要求内容层**已有一行**且 `path IS NULL`
        // ⇒「行根本没写成」它捞不到 ⇒ 这一格**没有兜底**：盘上有文件、台账不知道，这一台从此不算种子。
        // 单聊那一家在 10-13 真机第 7 条之后已经是「同一事务、要么一起收口要么一起不动」
        // （`network/file/receive.rs`），群这一处是同一个形状的第二家。
        // 三处写只写**一份**（闭包），事务与失败补写共用同一段 ⇒ 补写那半边不会和事务里那半边漂开。
        let write_ledgers = |conn: &rusqlite::Connection| -> rusqlite::Result<()> {
            db::update_group_file_recipient(
                conn,
                &transfer_id,
                &state.device_id,
                "completed",
                1.0,
            )?;
            db::upsert_transfer(
                conn,
                &transfer_id,
                &sender_id,
                &gf.name,
                gf.size,
                "receive",
                "done",
                Some(final_path.to_string_lossy().as_ref()),
                1.0,
            )?;
            crate::content::store::record_local(
                conn,
                &gf.sha256,
                &sender_id,
                Some(&group_id),
                &gf.name,
                gf.size,
                crate::content::model::Direction::Receive,
                &final_path.to_string_lossy(),
                db::now_ms(),
            )
        };
        let mut dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // 闭包末尾必须 `tx.commit()`：rusqlite 的 `Transaction` 默认 drop 行为是 Rollback
        // （锁定版 0.31.0 `transaction.rs:127`），少这一步就是「三张表一起回滚、而 wrote 仍是 Ok」
        // ⇒ 下面那条 Err 分支永不触发，界面看着成功、台账一句都没落库。
        let tx_started = std::time::Instant::now();
        let wrote = dbc.transaction().and_then(|tx| {
            write_ledgers(&tx)?;
            tx.commit()
        });
        note_tx(
            &state.logger,
            "gfile_finalize",
            &format!("transfer_id={transfer_id}"),
            tx_started,
            state.db.slow_threshold_ms(),
            wrote.is_ok(),
        );
        if let Err(e) = wrote {
            // 事务失败 ⇒ 三张表一起没动。这里**退回今天的形状**逐句补写，不选「整体不动」：
            // 收件方与 `file_transfers` 不收口会把气泡停在「文件确实已在盘上但永不完成」那一格
            // （指令 §3.2.C），而那一格只能靠重启恢复 ⇒ 等于用一个新故障去修一个旧故障。
            // 内容台账那一半才是可留给下次建链补的。失败必须留痕，不许再静默。
            state.logger.warn(
                "group_file",
                format!(
                    "群文件收尾事务失败 transfer_id={transfer_id}：已退回逐句补写，内容台账那一半仍可能缺（缺 ⇒ 这台不算种子，别人拉不到）: {e}"
                ),
            );
            let _ = write_ledgers(&dbc);
        }
    }
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&transfer_id);
    // `scope == "todo"`：待办描述图片只走传输管线，不回填聊天气泡、不 emit message-received
    // （文件已按 sha256 经 content store 登记，待办卡片按 sha256 即可解析本地路径）。
    if gf.scope != "todo" {
        // 重发带本地路径的记录（applyIncoming 按 msg_id 合并更新，未读不重复）：
        // 前端气泡 content.path 就绪 → 打开/另存/图片代码预览立即可用
        let msg_id = format!("gfile-{transfer_id}");
        let seq = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            dbc.query_row(
                "SELECT seq FROM messages WHERE msg_id = ?1",
                params![msg_id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(1)
        };
        let subtype = file::classify_file_subtype(&gf.name);
        // 同口径收敛（完成回填路径的气泡重发也不能再把 kind 打回 video/audio）
        let kind = if subtype == "image" { "image" } else { "file" };
        let done_rec = crate::state::MessageRecord {
            fail_code: None,
            id: 0,
            msg_id,
            conv_id: format!("group:{group_id}"),
            sender_id: sender_id.clone(),
            receiver_id: state.device_id.clone(),
            kind: kind.to_string(),
            content: {
                let mut c = serde_json::json!({
                    "name": gf.name,
                    "path": final_path.to_string_lossy(),
                    "size": gf.size,
                    "sha256": gf.sha256,
                    "subtype": subtype,
                    "progress": 1.0,
                });
                if kind == "image" {
                    file::attach_image_size(&mut c, &final_path);
                }
                c.to_string()
            },
            ts: db::now_ms(),
            seq,
            status: "delivered".to_string(),
            // 同上：群文件收尾这条不带 @ 落点 ⇒ NULL。
            mention_targets: None,
            local_id: None,
        };
        // 回填本地 path 到 messages 表：read_file_preview 按 msg_id 反查 content 定位文件。
        // 单聊 FileDone 走 insert_message 直接落库带 path 的内容；群聊 Offer 先落库无 path 的
        // 内容（文件尚未下载），Done 时必须显式更新，否则接收方图片/代码预览因缺 path 失败。
        {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = db::update_message_content(
                &dbc,
                &done_rec.msg_id,
                &done_rec.content,
                &done_rec.status,
            ) {
                // 落库失败必须留痕（第八家）：这一句写的是 `content.path`。它没写成 ⇒
                // `read_file_preview` 按 msg_id 反查不到本地文件，而那个"已被清理"的确定性失败判定
                // 会被前端**永久缓存**（见下面那条 `file-done` 的注释）⇒ 盘上有文件、气泡永远空白。
                // 行为一字不改：仍然继续往下 emit。
                state.logger.error(
                    "group_file",
                    format!("群文件 path 回填失败 msg={}：{e}", done_rec.msg_id),
                );
            }
        }
        let _ = state.app.emit("message-received", &done_rec);
        // 群**接收**端也必须 emit `file-done`：单聊、中继、群发送方都发，唯独这里漏了。
        // 漏掉不是"少一个事件"这么轻 —— 接收端在字节落盘前读预览会得到「已被清理」，
        // 而那个确定性失败判定被**永久缓存**（utils/filePreview.ts 只缓存确定性失败），
        // 清缓存的唯一入口就是 `onFileDone` 里的 invalidateFilePreview。不触发 ⇒
        // 文件早就好好躺在磁盘上，气泡却永远空白；重启前都不会自己好回来。
        let _ = state.app.emit(
            "file-done",
            &crate::state::FileDoneInfo {
                transfer_id: transfer_id.to_string(),
                name: gf.name.clone(),
                size: gf.size,
                path: final_path.to_string_lossy().to_string(),
            },
        );
    }
    // 完成确认：无论 ACK 发送成败，file_key 已清理不再保留（ACK 丢失由后续阶段处理）
    send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, true).await;
}

/// 向原始群文件发送者回送接收完成确认（receiver → sender）。
/// ACK 丢失可接受（发送端保持 sending，等待后续 retry/offline recovery），
/// 不因此重新保留 file_key。
async fn send_group_file_complete_ack(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    original_sender: &str,
    success: bool,
) {
    let ack = Message::GroupFileCompleteAck {
        transfer_id: transfer_id.to_string(),
        group_id: group_id.to_string(),
        sender_id: state.device_id.clone(),
        success,
    };
    let _ = try_send(state, original_sender, &ack).await;
}

/// 处理接收完成确认（sender 侧）：更新对应 recipient 的 completed/failed 状态。
///
/// 群文件 ACK 终态写入的**有界重试**：最多 3 次、间隔 25ms，全失败才返回 `Err`。
///
/// 抽成独立函数是为了能用"前两次失败、第三次成功"的闭包把**真实重试策略**测穿
/// （不是源码文本断言）。调用方每次重试之间会释放全局 DB 锁，所以这里的 sleep
/// 不会把等待塞进锁里。
pub(crate) async fn retry_ack_write<F, E>(mut attempt_write: F) -> Result<(), E>
where
    F: FnMut() -> Result<(), E>,
{
    const ACK_WRITE_ATTEMPTS: u32 = 3;
    let mut last: Option<E> = None;
    for i in 0..ACK_WRITE_ATTEMPTS {
        match attempt_write() {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        if i + 1 < ACK_WRITE_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
    Err(last.expect("至少尝试过一次"))
}

/// 发送气泡的聚合判定（纯函数：把"空集合 ≠ 全部失败"这条边界钉在真值表上）。
///
/// 返回 `None` = **不决定**（还有成员在途 / 账本里一行都没有）—— 调用方必须保持原状态、
/// 不 emit、不写终态。空集合**不是** failed：`unwrap_or_default()` 时代，一次读库失败
/// 就会让 `all_terminal` 恒真，把一批成功送达的群文件写成 failed（2026-10-20 审计）。
pub(crate) fn group_file_bubble(statuses: &[&str], success: bool) -> Option<&'static str> {
    if success {
        return Some("delivered");
    }
    if statuses.is_empty() {
        return None;
    }
    let all_terminal = statuses
        .iter()
        .all(|status| *status == "completed" || *status == "failed");
    if !all_terminal {
        return None;
    }
    Some(if statuses.contains(&"completed") {
        "delivered"
    } else {
        "failed"
    })
}

/// 身份验证（防伪造）：
/// 1. ACK.sender_id == TCP peer_id（不能只相信消息字段）；
/// 2. sender_id != 本机；
/// 3. transfer 对应的 group_file.sender_id == 本机（只有本机发起的群文件
///    的 ACK 才会被处理，B 发给 A 的 transfer 的 ACK 到 C 手上会被拒绝）；
/// 4. ACK 发送者必须是该 transfer 的 recipient（update 不命中即拒绝）。
///
/// 一条群文件 ACK 的收尾结果。
#[derive(Debug, PartialEq)]
pub(crate) enum GroupFileAckOutcome {
    /// 已落终态。`bubble` = 新的发送端气泡状态；`None` 表示**还有成员在途**（气泡保持原样）。
    Applied { bubble: Option<&'static str> },
    /// 幂等：该 recipient 已是 `completed`，又来了一条失败 ACK ⇒ 不降级、不动任何行。
    NoChange,
    /// 这条 ACK 的发送者不是该 transfer 的 recipient（伪造/串台）⇒ 拒绝，**不该重放**。
    NotRecipient,
}

/// 群文件 ACK 的**状态收尾（纯 DB 层）**：一次事务里做三件必须同生共死的事。
///
/// ① 该 recipient 的投递状态落终态；② 读全体 recipient 聚出发送端气泡；③ 把气泡写回 `messages`。
/// 少做任何一件都会留下"账本说完成、界面还 sending"这种半状态 —— 这正是本轮要根治的形状。
///
/// 拆成纯函数是为了**能在单测里注入 DB 故障**（用触发器让 UPDATE 失败），
/// 而不是只能靠源码形状判据说"这里应该会回滚"。
///
/// `Err` = **可重试的失败**（DB 忙/写错/磁盘满）；调用方要保留账本行让清扫器重放。
pub(crate) fn apply_group_file_ack_db(
    conn: &rusqlite::Connection,
    transfer_id: &str,
    recipient_id: &str,
    success: bool,
) -> Result<GroupFileAckOutcome, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // ① 这个 recipient 存在吗？（存在性要单独查：`query_row` 把"没有这行"和"查询出错"混成一个错）
    let current: Option<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT status FROM group_file_recipients WHERE transfer_id = ?1 AND recipient_id = ?2",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![transfer_id, recipient_id])
            .map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Some(r.get::<_, String>(0).map_err(|e| e.to_string())?),
            None => None,
        }
    };
    let Some(current) = current else {
        // 不是 recipient ⇒ 拒绝。不写任何行（事务回滚），调用方要**丢掉账本行**。
        let _ = tx.rollback();
        return Ok(GroupFileAckOutcome::NotRecipient);
    };
    // ② 幂等保护：completed 是终态，迟到的失败 ACK 不许把它降级成 failed。
    if !success && current == "completed" {
        let _ = tx.rollback();
        return Ok(GroupFileAckOutcome::NoChange);
    }
    let (status, progress) = if success {
        ("completed", 1.0)
    } else {
        ("failed", 0.0)
    };
    tx.execute(
        "UPDATE group_file_recipients SET status = ?3, progress = ?4, updated_at = ?5
         WHERE transfer_id = ?1 AND recipient_id = ?2",
        params![transfer_id, recipient_id, status, progress, db::now_ms()],
    )
    .map_err(|e| e.to_string())?;
    // ③ 聚合：读全体 recipient ⇒ 决定发送端气泡。空集合绝不能判 failed（见 group_file_bubble）。
    let statuses: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT status FROM group_file_recipients WHERE transfer_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![transfer_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for row in rows {
            v.push(row.map_err(|e| e.to_string())?);
        }
        v
    };
    let refs: Vec<&str> = statuses.iter().map(|s| s.as_str()).collect();
    let bubble = group_file_bubble(&refs, success);
    // ④ 气泡写回（只有聚合能决定时才写；"还有成员在途"就保持原状态）
    if let Some(b) = bubble {
        db::set_message_status(&tx, &format!("gfile-{transfer_id}"), b)
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(GroupFileAckOutcome::Applied { bubble })
}

/// 把一条 ACK 落到"发送端可见"的终态：DB 收尾 + 发送端镜像行 + 前端事件。
///
/// `Err` = 可重试失败（调用方要**保留账本行**）；`Ok` = 已经落终态或无需动作（**可以删账本行**）。
pub(crate) fn apply_group_file_ack(
    state: &Arc<AppState>,
    transfer_id: &str,
    group_id: &str,
    peer_id: &str,
    success: bool,
) -> Result<GroupFileAckOutcome, String> {
    let outcome = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        apply_group_file_ack_db(&dbc, transfer_id, peer_id, success)?
    };
    let GroupFileAckOutcome::Applied { bubble } = outcome else {
        return Ok(outcome);
    };
    // 发送端镜像行（file_transfers）：它是**进度镜像**，不是事实来源 ⇒ 失败只留日志，
    // 不影响上面的终态（也不该因此把 ACK 当成没落终态）。
    let tf_status = if bubble == Some("delivered") {
        "done"
    } else {
        "failed"
    };
    let (path, name, size) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // 取某一条的 `path` 用按 id 的点查。原来这里是 `list_transfers()` 全表扫再 `find` ——
        // 那是在**唯一那条 db 连接的持锁段里**按行数收费，而 `file_transfers` 是只增的历史表；
        // 语义一字不差（就是要这一条的 path）。见 10-22 审计 D-23：这也是给那张表加界限的前置。
        let path = db::get_transfer_path(&dbc, transfer_id);
        // name/size 必须取自 group_files（发送端事实来源）：填空会把镜像行写坏。
        let (name, size) = db::get_group_file(&dbc, transfer_id)
            .map(|gf| (gf.name, gf.size))
            .unwrap_or_else(|| (String::new(), 0));
        (path, name, size)
    };
    // ⚠️ `group_file_online_progress` 内部取 db 锁：必须先放掉本段持有的锁，否则同锁重入即死锁。
    let tf_progress = crate::commands::group_file_online_progress(state, transfer_id, 0.0);
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = db::upsert_transfer(
            &dbc,
            transfer_id,
            group_id,
            &name,
            size,
            "send",
            tf_status,
            path.as_deref(),
            tf_progress,
        ) {
            state.logger.error(
                "group_file",
                format!(
                    "code=GFILE_TRANSFER_MIRROR_FAILED transfer_id={transfer_id} err={e} —— \
                     终态已落库，只是进度镜像没更新"
                ),
            );
        }
    }
    if bubble == Some("delivered") {
        let _ = state
            .app
            .emit("message-acked", &format!("gfile-{transfer_id}"));
    }
    Ok(outcome)
}

/// 群文件会话密钥的保留上限：正常发送期限最多 1h；2h 还没收尾的只可能是
/// 「只发了 Offer 没发分片」或死单 —— 密钥不落库，留着会随对端行为增长（P3-06）。
pub(crate) const GROUP_FILE_KEY_TTL_MS: i64 = 2 * 60 * 60 * 1000;

/// 密钥是否已超过保留上限（纯函数，便于单测钉住边界）。
pub(crate) fn group_file_key_is_stale(at_ms: i64, now: i64) -> bool {
    now.saturating_sub(at_ms) >= GROUP_FILE_KEY_TTL_MS
}

/// 清掉过期密钥。发送/接收两侧共用同一张表；只按登记时刻判，不额外看传输状态：
/// 2h 已超过最大发送期限，活着的传输不可能还在等这把钥匙。
pub(crate) fn sweep_stale_group_file_keys(state: &AppState) -> usize {
    let now = db::now_ms();
    let removed = {
        let mut keys = state
            .group_file_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let before = keys.len();
        keys.retain(|_, k| !group_file_key_is_stale(k.at_ms, now));
        before - keys.len()
    };
    if removed > 0 {
        state.logger.info(
            "group_file",
            format!(
                "code=GFILE_KEY_TTL_EXPIRED removed={removed} —— 只发 Offer/死单的会话密钥已清"
            ),
        );
    }
    // 轮次表只保留还有密钥的 transfer（密钥在终态/兜底 TTL 时被清 ⇒ 轮次一起回收）。
    let live: std::collections::HashSet<String> = state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .keys()
        .cloned()
        .collect();
    state
        .group_file_rounds
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|tid, _| live.contains(tid));

    // 在线目标快照（进度分母）也在**这一个**清扫点回收（10-23 审计 P2-C）。
    // 判据用台账状态而不是盲 TTL：快照是气泡分母的来源，还在传的时候清掉会让分母退回"未知"；
    // 而一单到终态（completed/failed/cancelled）或台账行已经不在了，这块快照就没人会再读。
    let stale_targets: Vec<String> = {
        let keys: Vec<String> = state
            .group_file_online_targets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        keys.into_iter()
            .filter(|tid| {
                !online_targets_entry_is_live(db::get_group_file(&dbc, tid).map(|g| g.status).as_deref())
            })
            .collect()
    };
    if !stale_targets.is_empty() {
        let mut targets = state
            .group_file_online_targets
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for tid in &stale_targets {
            targets.remove(tid);
        }
        state.logger.info(
            "group_file",
            format!(
                "code=GFILE_TARGETS_TTL_EXPIRED removed={} —— 已到终态/没有台账的单不再留分母快照",
                stale_targets.len()
            ),
        );
    }
    removed
}

/// 这张"发送那一刻在线成员"的快照还值得留吗（唯一判据，P2-C）。
///
/// 只留**还在传**的单：`None` = 台账行都不在了（删群/清理），`completed/failed/cancelled`
/// = 终态 ⇒ 气泡不会再展示"K 人待收"，快照没人读。`pending/sending` 必须留 ——
/// 那时分母正是用户在看的那个数。
pub(crate) fn online_targets_entry_is_live(status: Option<&str>) -> bool {
    matches!(status, Some("pending") | Some("sending"))
}

/// 卡住的群文件投递清扫（P2-01）。
///
/// `sending` 行 10 分钟没有任何进度更新 ⇒ 回 `pending`，由建链/心跳重投；
/// 超过 7 天 ⇒ 用 ACK 失败同一份事务收尾（recipient + 气泡 + 镜像），
/// 不让一行永远停在“发送中”。正常发送时 dispatch 每 250ms 刷一次 `updated_at`，
/// 所以扫到的行不可能是还在跑的任务。
pub(crate) fn sweep_stale_group_sending(state: &Arc<AppState>) -> usize {
    let now = db::now_ms();
    // 开机第一拍：`sending` 只可能是上一次进程遗留的孤儿（任务活不过进程）⇒ 不设下界，
    // 全部回 `pending`，对端一上线就能续传。之后按 10 分钟的 stale 阈值正常收敛。
    let boot = state
        .group_file_boot_sweep_pending
        .swap(false, std::sync::atomic::Ordering::Relaxed);
    let before = if boot {
        i64::MAX
    } else {
        now - crate::db::GROUP_FILE_SENDING_STALE_MS
    };
    let max_age_before = now - crate::db::GROUP_FILE_SENDING_MAX_AGE_MS;
    let rows = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_stale_group_file_sending(&dbc, before, max_age_before, &state.device_id)
    };
    let rows = match rows {
        Ok(v) => v,
        Err(e) => {
            state.logger.error(
                "group_file",
                format!("code=GFILE_STALE_READ_FAILED err={e} —— 本轮跳过，下轮重试"),
            );
            return 0;
        }
    };
    let mut changed = 0usize;
    for row in rows {
        let age_ms = now.saturating_sub(row.updated_at);
        if row.expired {
            // dispatch 的最长期限是 1h，7 天没更新绝不可能是活跃任务 ⇒ 直接按失败收尾。
            match apply_group_file_ack(
                state,
                &row.transfer_id,
                &row.group_id,
                &row.recipient_id,
                false,
            ) {
                Ok(_) => {
                    state.logger.warn(
                        "group_file",
                        format!(
                            "code=GFILE_SENDING_STALE transfer_id={} peer={} age_ms={age_ms} action=failed",
                            row.transfer_id, row.recipient_id
                        ),
                    );
                    changed += 1;
                }
                Err(e) => state.logger.error(
                    "group_file",
                    format!(
                        "code=GFILE_SENDING_STALE_FAILED transfer_id={} peer={} err={e} —— 行仍是 sending，下轮重试",
                        row.transfer_id, row.recipient_id
                    ),
                ),
            }
        } else {
            // 条件 UPDATE（同一个 stale 谓词）：查出来之后任务刚好刷新进度 ⇒ 不改。
            let requeued = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::requeue_stale_group_file_sending(
                    &dbc,
                    &row.transfer_id,
                    &row.recipient_id,
                    before,
                )
            };
            match requeued {
                Ok(true) => {
                    state.logger.info(
                        "group_file",
                        format!(
                            "code=GFILE_SENDING_STALE transfer_id={} peer={} age_ms={age_ms} action=retry",
                            row.transfer_id, row.recipient_id
                        ),
                    );
                    changed += 1;
                }
                Ok(false) => {} // 期间被发送任务刷新了
                Err(e) => state.logger.error(
                    "group_file",
                    format!(
                        "code=GFILE_SENDING_REQUEUE_FAILED transfer_id={} peer={} err={e}",
                        row.transfer_id, row.recipient_id
                    ),
                ),
            }
        }
    }
    changed
}

/// 重放"收到过、但没落终态"的群文件 ACK —— **跨进程恢复的出口**。
///
/// 场景：ACK 帧是**一次性**的，而落库可能失败（DB 忙/磁盘满/进程被杀）。
/// 旧形状下这类失败 ⇒ 一条已经送达的群文件**永远停在 sending**。
/// 现在 ACK 收到时先落 `group_file_acks` 账本，收尾失败就由本函数按 tick 重放；
/// 进程重启后账本还在 ⇒ 跨进程也能恢复。
///
/// 放弃策略：同一行重放超过 [`GROUP_FILE_ACK_MAX_ATTEMPTS`] 次仍失败 ⇒ 用"失败"语义收尾
/// （把该 recipient 置 `failed`），**不留永久挂起**。
pub(crate) fn replay_pending_group_file_acks(state: &Arc<AppState>) -> usize {
    const BATCH: i64 = 32;
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_group_file_acks(&dbc, BATCH)
    };
    let pending = match pending {
        Ok(v) => v,
        Err(e) => {
            state.logger.error(
                "group_file",
                format!("code=GFILE_ACK_LEDGER_READ_FAILED err={e} —— 本轮跳过重放，下轮重试"),
            );
            return 0;
        }
    };
    let mut settled = 0usize;
    for ack in pending {
        let outcome = apply_group_file_ack(
            state,
            &ack.transfer_id,
            &ack.group_id,
            &ack.recipient_id,
            ack.success,
        );
        match outcome {
            Ok(_) => {
                // 落终态（或幂等/拒绝）⇒ 账本行删掉。
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                if db::delete_group_file_ack(&dbc, &ack.transfer_id, &ack.recipient_id).is_ok() {
                    settled += 1;
                }
            }
            Err(e) => {
                let give_up = ack.attempts + 1 >= GROUP_FILE_ACK_MAX_ATTEMPTS;
                {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    if let Err(err) = db::bump_group_file_ack_attempt(
                        &dbc,
                        &ack.transfer_id,
                        &ack.recipient_id,
                        &e,
                    ) {
                        state.logger.error(
                            "group_file",
                            format!(
                                "code=GFILE_ACK_LEDGER_BUMP_FAILED transfer_id={} peer={} err={err}",
                                ack.transfer_id, ack.recipient_id
                            ),
                        );
                    }
                }
                state.logger.warn(
                    "group_file",
                    format!(
                        "code=GFILE_ACK_REPLAY_FAILED transfer_id={} peer={} attempts={} \
                         age_ms={} last_error={} err={e}",
                        ack.transfer_id,
                        ack.recipient_id,
                        ack.attempts + 1,
                        db::now_ms().saturating_sub(ack.received_at),
                        ack.last_error,
                    ),
                );
                if give_up {
                    // 放弃重试：用"失败"语义收尾（明确的终态，不许永久挂起）。
                    let forced = apply_group_file_ack(
                        state,
                        &ack.transfer_id,
                        &ack.group_id,
                        &ack.recipient_id,
                        false,
                    );
                    match forced {
                        Ok(_) => {
                            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                            let _ = db::delete_group_file_ack(
                                &dbc,
                                &ack.transfer_id,
                                &ack.recipient_id,
                            );
                            state.logger.error(
                                "group_file",
                                format!(
                                    "code=GFILE_ACK_GAVE_UP transfer_id={} peer={} attempts={} err={e} \
                                     —— 已按失败收尾（明确终态），账本行已清理",
                                    ack.transfer_id, ack.recipient_id, ack.attempts + 1
                                ),
                            );
                        }
                        Err(e2) => {
                            state.logger.error(
                                "group_file",
                                format!(
                                    "code=GFILE_ACK_GIVEUP_FAILED transfer_id={} peer={} err={e2} \
                                     —— 连失败收尾都写不进去（DB 可能整体不可用），账本行保留，下轮再试",
                                    ack.transfer_id, ack.recipient_id
                                ),
                            );
                        }
                    }
                }
            }
        }
    }
    settled
}

/// 同一行群文件 ACK 最多重放几次；超过就按"失败"收尾（明确终态，不留永久挂起）。
const GROUP_FILE_ACK_MAX_ATTEMPTS: i64 = 5;

/// 幂等：重复 ACK 重复 UPDATE 同状态，无副作用、不报错。
async fn handle_group_file_complete_ack(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    sender_id: String,
    success: bool,
) {
    // 1+2. ACK 发送者必须与链路对端一致，且不能是自己
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 3. transfer 必须是本机发出的群文件，且 group_id 一致
    let Some(gf) = db::get_group_file(
        &state.db.lock().unwrap_or_else(|e| e.into_inner()),
        &transfer_id,
    ) else {
        return;
    };
    if gf.sender_id != state.device_id || gf.group_id != group_id {
        return;
    }

    // ④ **先落持久化账本**：这一行是"跨进程还能恢复"的全部依据。
    //    ACK 帧是一次性的（对端不会为同一条 transfer 再发第二遍），落库失败就没有第二次机会
    //    ⇒ 必须先留下"收到过"的痕迹，再去做状态收尾。
    //    这一步本身失败 ⇒ 连"记得住"都没有 ⇒ 只留日志，绝不假装已经收尾。
    let ledger = retry_ack_write(|| {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::insert_group_file_ack(&dbc, &transfer_id, peer_id, &group_id, success)
    })
    .await;
    if let Err(e) = ledger {
        state.logger.error(
            "group_file",
            format!(
                "code=GFILE_ACK_LEDGER_FAILED transfer_id={transfer_id} peer={peer_id} err={e} \
                 —— 这条 ACK 没有 durable 记录，此刻若进程被杀就再也补不回来"
            ),
        );
        return;
    }

    // ⑤ 状态收尾：可能失败（DB 忙/写错/磁盘满）⇒ **账本行留着**，由进程级清扫器重放；
    //    进程重启后账本还在 ⇒ 跨进程也能恢复（这正是旧形状最缺的一环）。
    match apply_group_file_ack(state, &transfer_id, &group_id, peer_id, success) {
        Ok(GroupFileAckOutcome::Applied { bubble }) => {
            // 本 transfer 已到终态 ⇒ 进度条口径快照用完即弃（避免无界增长）。
            if bubble == Some("delivered") || bubble == Some("failed") {
                state
                    .group_file_online_targets
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&transfer_id);
            }
            // ⑥ 已落终态 ⇒ 账本行删掉（"不需要再重放"的事实标记）。
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = db::delete_group_file_ack(&dbc, &transfer_id, peer_id) {
                state.logger.error(
                    "group_file",
                    format!(
                        "code=GFILE_ACK_LEDGER_DELETE_FAILED transfer_id={transfer_id} \
                         peer={peer_id} err={e} —— 下轮重放会再算一遍（幂等，不会重复收尾）"
                    ),
                );
            }
        }
        Ok(_) => {
            // 幂等（已是 completed 又来失败 ACK）或被拒（不是 recipient）⇒ 同样不需要重放。
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::delete_group_file_ack(&dbc, &transfer_id, peer_id);
        }
        Err(e) => {
            state.logger.error(
                "group_file",
                format!(
                    "code=GFILE_ACK_PERSIST_FAILED transfer_id={transfer_id} peer={peer_id} \
                     status={} err={e} —— 账本行已留存，清扫器会重放（跨进程也能恢复）",
                    if success { "completed" } else { "failed" }
                ),
            );
        }
    }
}

#[cfg(test)]
mod group_file_bubble_tests {
    use super::{group_file_bubble, retry_ack_write};

    /// 真值表：把"空集合 ≠ 全部失败"和"有成员在途 ⇒ 不决定"两条边界钉住。
    /// 这两条正是 2026-10-20 审计里两个真实误判的形状（读失败被折成空集合）。
    #[test]
    fn bubble_is_decided_only_when_every_recipient_is_terminal() {
        // 成功 ACK：有人收到即算 delivered，不看其他人
        assert_eq!(
            group_file_bubble(&[], true),
            Some("delivered"),
            "success ACK 必须直接推进，不能因为账本空就卡住"
        );
        // **核心**：空账本 + 失败 ACK ⇒ 不决定（旧实现会判 failed）
        assert_eq!(
            group_file_bubble(&[], false),
            None,
            "空集合不许判 failed —— 那是「读不到」不是「全都失败」"
        );
        // 有成员在途 ⇒ 不决定
        assert_eq!(
            group_file_bubble(&["completed", "sending"], false),
            None,
            "还有人在途时不许提前定终态"
        );
        // 全部终态：有人成功 ⇒ delivered；全失败 ⇒ failed
        assert_eq!(
            group_file_bubble(&["completed", "failed"], false),
            Some("delivered")
        );
        assert_eq!(
            group_file_bubble(&["failed", "failed"], false),
            Some("failed")
        );
        assert_eq!(
            group_file_bubble(&["completed", "completed"], false),
            Some("delivered")
        );
    }

    /// **重试策略**：前两次失败、第三次成功 ⇒ `Ok` 且恰好 3 次；一直失败 ⇒ `Err` 且**有界**（3 次）。
    /// 这条钉的是"一次性 ACK 遇到瞬时 BUSY 不该把消息判死"，也是"不许无限重试"的上界。
    #[test]
    fn ack_write_retries_are_bounded_and_stop_on_first_success() {
        let mut calls = 0u32;
        let ok = tauri::async_runtime::block_on(retry_ack_write(|| {
            calls += 1;
            if calls < 3 {
                Err("busy")
            } else {
                Ok(())
            }
        }));
        assert!(ok.is_ok(), "第三次成功必须返回 Ok");
        assert_eq!(calls, 3, "前两次失败后应当在第三次成功并停止");

        let mut calls2 = 0u32;
        let bad: Result<(), &str> = tauri::async_runtime::block_on(retry_ack_write(|| {
            calls2 += 1;
            Err("busy")
        }));
        assert!(bad.is_err(), "一直失败必须返回 Err（不许假装成功）");
        assert_eq!(calls2, 3, "重试必须有界：最多 3 次");

        let mut calls3 = 0u32;
        let first: Result<(), &str> = tauri::async_runtime::block_on(retry_ack_write(|| {
            calls3 += 1;
            Ok(())
        }));
        assert!(first.is_ok());
        assert_eq!(calls3, 1, "一次就成功时不许再重试");
    }
}

/// 处理群文件分片（E2EE 解密 → seq/size 校验 → 增量哈希 → 写 `.part`）。
/// 无 GroupFileDone / 无 rename / 不标 completed——完成确认在下一阶段。
#[allow(clippy::too_many_arguments)] // 与同文件另外两个处理器同形：帧字段全量直传，打包反而多一层
async fn handle_group_file_chunk(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    sender_id: String,
    seq: u32,
    data: String,
    attempt: Option<u64>,
) {
    // 权限：链路 sender 与声明一致、不能是自己、群存在、sender 是群成员
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 轮次隔离：上一轮还堵在链路队列里的高 seq 分片不能把这一轮判成"跳号"打死。
    if !group_frame_is_current(state, &transfer_id, attempt) {
        return;
    }
    let (group_exists, sender_is_member) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::get_group(&dbc, &group_id) {
            Some(g) => (true, g.members.contains(&sender_id)),
            None => (false, false),
        }
    };
    if !group_exists || !sender_is_member {
        return;
    }
    // 会话必须已经由合法 GroupFileOffer 建立；无 key 直接丢弃（不尝试其他密钥）
    // 每片都刷新 TTL：长传输（BLE / 多轮重试）不应在 2h 被清扫掉。
    let Some(file_key) = state.touch_group_file_key(&transfer_id) else {
        return;
    };
    // 本地群文件记录（Offer 阶段建立）提供 name/size/sha256
    let Some(gf) = db::get_group_file(
        &state.db.lock().unwrap_or_else(|e| e.into_inner()),
        &transfer_id,
    ) else {
        return;
    };
    // 只有该 transfer 的原始 sender 发来的 chunk 才合法。
    // 其他群成员（无 file_key）发送的垃圾 chunk 不得终止合法接收：
    // 直接忽略，不删 .part、不清 session、不改 recipient 状态。
    if gf.sender_id != sender_id {
        return;
    }

    // 首个合法 chunk 到达时才创建 `.part`（安全路径，downloads 目录内）
    if !state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&transfer_id)
        && file::begin_group_receive(
            state,
            &transfer_id,
            &sender_id,
            &gf.name,
            gf.size,
            file_key,
            gf.sha256.clone(),
        )
        .is_err()
    {
        return;
    }

    // 解码 + AEAD 解密：纯 CPU、不持任何锁、入参都是自有数据 ⇒ 先离开 tokio worker
    // （10-22 审计 R-20 的一半，理由与单聊那条相同：这批 worker 也扛着别的链路的入站帧读取
    //  和开窗一类 IPC）。**只搬这两步**：下面的 seq/写盘段手里有一把锁和五个提前返回，
    //  把它整体搬进阻塞池就等于"在等待里持锁"，那正是本仓 A-14 那族同线程二次取锁死锁的反面教材。
    // 两种失败（base64 解不开 / AEAD 验不过）原本走的是同一个收尾，合并成一个 Option 不改变行为；
    // 阻塞池把任务丢了也当失败处理，不静默放弃这一单。
    let plaintext = {
        let key = file_key;
        tokio::task::spawn_blocking(move || {
            let Ok(sealed) = STANDARD.decode(&data) else {
                return None;
            };
            crypto::open_symmetric(&key, &sealed)
        })
        .await
        .unwrap_or(None)
    };
    let Some(plaintext) = plaintext else {
        fail_group_file_chunk(state, &transfer_id, REASON_CHUNK_DECRYPT_FAILED);
        return;
    };

    // seq / size 校验 + 增量哈希 + 写盘 + 进度落库：这一整段是**同步重活**（慢盘上一个
    // 256KB 分块的 `write_all` 轻易几十毫秒），跑在 tokio worker 上会把同一条 runtime 上的
    // 其它入站帧与开窗类 IPC 一起按住 —— 单聊那条（`handle_file.rs` 的 `spawn_blocking`）早就
    // 为同一件事付过学费，群文件这一支当时只搬了"解码 + 解密"。
    //
    // 与单聊同形：锁在**池内**取（不在 await 里持锁），且这条链路的帧本来就是逐条 await 处理，
    // 搬进阻塞池不等于并发化 —— "同一传输的分片必须串行"照旧成立。
    // `group_file_receivers` 那把进程级锁本轮**不动**（改它要动几十个引用点，只有跨进程 E2E
    // 能证；见审计 STB-03）。
    let st = state.clone();
    let tid = transfer_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        write_group_chunk_blocking(&st, &tid, seq, &plaintext)
    })
    .await
    // 阻塞池把任务丢掉不能当"没发生"：交回失败码走既有判死分支，发送端立刻知道。
    .unwrap_or_else(|e| {
        GroupChunkWrite::Failed(format!("code=GROUP_CHUNK_POOL_ABORT 文件分片处理任务被线程池中断: {e}"))
    });
    if let GroupChunkWrite::Failed(reason) = outcome {
        fail_group_file_chunk(state, &transfer_id, &reason);
    }
}

/// 群文件分片的"落到盘上那一段"（阻塞池内执行）。
///
/// 结构与搬进来之前**逐字对应**：seq 判定 → 超尺寸判定 → 增量哈希 → `write_all` →
/// 进度落库；差别只在"谁来跑"。返回值只表达怎么收尾，失败收尾（`fail_group_file_chunk`）
/// 留在 async 侧调用 —— 那里要动文件 key、气泡状态与台账，都是跨锁的顺序动作。
enum GroupChunkWrite {
    /// 重复/迟到片：不写盘、不打死、不回错误（群文件经中继扇出时同一片会来两次）
    Duplicate,
    /// 这一单已经不在接收表里（被并发收尾摘掉）⇒ 什么都不做
    Gone,
    /// 失败：给 `fail_group_file_chunk` 的原因（稳定码或原始错误串）
    Failed(String),
    /// 已写盘并落了进度
    Written,
}

fn write_group_chunk_blocking(
    state: &Arc<AppState>,
    transfer_id: &str,
    seq: u32,
    plaintext: &[u8],
) -> GroupChunkWrite {
    use std::io::Write;
    let mut recv = state
        .group_file_receivers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(r) = recv.get_mut(transfer_id) else {
        return GroupChunkWrite::Gone;
    };
    // ⚠️ 群侧以前这里是 `if seq != r.next_seq { 整单失败 }`，注释写的理由是"TCP 有序"。
    // 那个前提在群里不成立：群文件经**中继扇出**，同一片可以被两条链路各送一次，
    // 而单聊那一族早就为同一件事付过学费（`file.rs` 里 `chunk_seq_decision` 的注释：
    // 把重复/迟到当致命 ⇒ 整单永远拼不齐）。规则只许有一份 ⇒ 这里直接调那个纯函数。
    match file::chunk_seq_decision(seq, r.next_seq) {
        // 重复/迟到片：与单聊同一处置（不写盘、不打死、不回错误），下一片照常进来。
        file::ChunkSeq::Duplicate => return GroupChunkWrite::Duplicate,
        // 正好是下一片 ⇒ 往下写。
        file::ChunkSeq::Accept => {}
        // 真跳号：中间确实缺片，只能靠重传 ⇒ 终止这一单。
        file::ChunkSeq::Gap => {
            return GroupChunkWrite::Failed(REASON_CHUNK_SEQ_GAP.to_string())
        }
    }
    if plaintext.len() as u64 > r.size.saturating_sub(r.received) {
        // 超出声明大小：防恶意 sender
        return GroupChunkWrite::Failed(REASON_CHUNK_EXCEEDS_SIZE.to_string());
    }
    // 增量哈希（为下一阶段 FileDone 校验准备；本阶段不比对）
    use sha2::Digest;
    r.hasher.update(plaintext);
    // 写盘失败：**盘满**归类成稳定码（前端据此给"清出空间后可重试"的可行动文案），
    // 其余错误保留原文。与单聊 `write_chunk` 同一份判定（`logging::classify_write_failure`）。
    if let Some(e) = r.file.write_all(plaintext).err() {
        let reason = match crate::logging::classify_write_failure(&e) {
            Some(code) => {
                state.logger.error(
                    "group_file",
                    format!(
                        "code={code} transfer={transfer_id} peer={} received={} size={} —— 磁盘空间不足",
                        r.peer_id, r.received, r.size
                    ),
                );
                code.to_string()
            }
            None => e.to_string(),
        };
        return GroupChunkWrite::Failed(reason);
    }
    r.received += plaintext.len() as u64;
    // 群接收器与单聊共用 `FileReceiver` ⇒ 同一个 idle 时钟，回收判据也只有一份
    r.fed_at_ms = db::now_ms();
    r.next_seq = r.next_seq.wrapping_add(1);
    let progress = if r.size == 0 {
        1.0
    } else {
        (r.received as f64 / r.size as f64).min(1.0)
    };
    // 进度落库：本阶段最高 sending，不标 completed。
    // 锁序 receivers→db（与本文件其它地方一致）：先放掉 receivers 再取 db。
    drop(recv);
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db::update_group_file_recipient(&dbc, transfer_id, &state.device_id, "sending", progress);
    GroupChunkWrite::Written
}

#[cfg(test)]
mod group_file_ack_recovery_tests {
    use super::{apply_group_file_ack_db, GroupFileAckOutcome};
    use rusqlite::{params, Connection};

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    /// 造一个"两个成员都在途"的群文件 + 它的发送端气泡。
    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO group_files(transfer_id, group_id, sender_id, name, size, sha256, status, created_at)
             VALUES('t1', 'g1', 'me', 'a.bin', 10, 'deadbeef', 'sending', 1)",
            [],
        )
        .unwrap();
        for peer in ["peer-a", "peer-b"] {
            conn.execute(
                "INSERT INTO group_file_recipients(transfer_id, recipient_id, status, progress, updated_at)
                 VALUES('t1', ?1, 'sending', 0.5, 1)",
                params![peer],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status)
             VALUES('gfile-t1', 'group:g1', 'me', 'g1', 'file', '{}', 1, 1, 'sending')",
            [],
        )
        .unwrap();
    }

    fn recipient_status(conn: &Connection, peer: &str) -> String {
        conn.query_row(
            "SELECT status FROM group_file_recipients WHERE transfer_id='t1' AND recipient_id=?1",
            params![peer],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn bubble_status(conn: &Connection) -> String {
        conn.query_row(
            "SELECT status FROM messages WHERE msg_id='gfile-t1'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// ★ 真故障注入：写失败 ⇒ **一个字节都不能改**（事务回滚），且不能把气泡写成 failed。
    ///
    /// 旧形状（两条独立写 + 吞错）在这里会留下"账本说完成、界面还 sending"或反过来
    /// "界面说 failed、账本还是 sending"的半状态。
    #[test]
    fn a_failed_write_rolls_back_completely_and_leaves_no_half_state() {
        let conn = mem_db();
        seed(&conn);
        // 让 recipient 的 UPDATE 必然失败（真实 DB 故障的最小注入）
        conn.execute_batch(
            "CREATE TRIGGER block_recipient_update BEFORE UPDATE ON group_file_recipients
             BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
        )
        .unwrap();

        let outcome = apply_group_file_ack_db(&conn, "t1", "peer-a", true);
        assert!(
            outcome.is_err(),
            "写失败必须报错，不许假装成功：{outcome:?}"
        );
        assert_eq!(
            recipient_status(&conn, "peer-a"),
            "sending",
            "写失败后 recipient 必须原样（事务回滚，不许半写）"
        );
        assert_eq!(
            bubble_status(&conn),
            "sending",
            "写失败后气泡必须原样（绝不能出现「收尾失败却把界面写成 failed」）"
        );

        // 故障消失后再来一次 ⇒ 正常落终态（这正是清扫器重放要走的路）
        conn.execute_batch("DROP TRIGGER block_recipient_update")
            .unwrap();
        let ok = apply_group_file_ack_db(&conn, "t1", "peer-a", true).unwrap();
        assert_eq!(
            ok,
            GroupFileAckOutcome::Applied {
                bubble: Some("delivered")
            }
        );
        assert_eq!(recipient_status(&conn, "peer-a"), "completed");
        assert_eq!(bubble_status(&conn), "delivered");
    }

    /// ★★ 原子性：失败发生在**后一步**（写气泡）时，前一步（recipient 落终态）必须被**回滚**。
    ///
    /// 这是"事务"与"两条独立写"的唯一可观察差别：
    /// 没有事务时，这里会留下「账本说 completed、界面还 sending」的半状态 ——
    /// 而这正是上一轮审计里"ACK 非原子收尾"那个形状。
    #[test]
    fn a_failure_after_the_recipient_write_rolls_the_whole_thing_back() {
        let conn = mem_db();
        seed(&conn);
        // 让**气泡**那一步失败（recipient 那一步会先成功 ⇒ 正好卡在中间）
        conn.execute_batch(
            "CREATE TRIGGER block_bubble_update BEFORE UPDATE ON messages
             BEGIN SELECT RAISE(ABORT, 'injected bubble write failure'); END;",
        )
        .unwrap();

        let outcome = apply_group_file_ack_db(&conn, "t1", "peer-a", true);
        assert!(outcome.is_err(), "气泡写失败必须整体报错：{outcome:?}");
        assert_eq!(
            recipient_status(&conn, "peer-a"),
            "sending",
            "气泡写失败 ⇒ 前一步的 recipient 更新必须被回滚（不许留下半状态）"
        );
        assert_eq!(bubble_status(&conn), "sending");
    }

    /// ★ 跨进程恢复：ACK 账本必须**真的持久**（换个连接还在），否则"跨进程恢复"是空话。
    #[test]
    fn the_ack_ledger_survives_a_new_connection() {
        let conn = mem_db();
        seed(&conn);
        crate::db::insert_group_file_ack(&conn, "t1", "peer-a", "g1", true).unwrap();
        // 同一进程内的另一个连接看不到内存库 ⇒ 用**文件库**才验得了"持久"
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let path = dir.join("gosslan.db");
        {
            let c = crate::db::init(&path).unwrap();
            crate::db::insert_group_file_ack(&c, "t1", "peer-a", "g1", true).unwrap();
        } // 连接关闭 ⇒ 模拟"进程结束"
        {
            // 新连接 = 新进程视角
            let c = crate::db::init(&path).unwrap();
            let rows = crate::db::list_group_file_acks(&c, 10).unwrap();
            assert_eq!(rows.len(), 1, "ACK 账本必须活过一次进程");
            assert_eq!(rows[0].transfer_id, "t1");
            assert!(rows[0].success);
            // 重放 ⇒ 落终态 ⇒ 账本清空
            seed(&c);
            let out = apply_group_file_ack_db(&c, "t1", "peer-a", true).unwrap();
            assert_eq!(
                out,
                GroupFileAckOutcome::Applied {
                    bubble: Some("delivered")
                }
            );
            crate::db::delete_group_file_ack(&c, "t1", "peer-a").unwrap();
            assert!(
                crate::db::list_group_file_acks(&c, 10).unwrap().is_empty(),
                "落终态后账本必须清空（否则每 tick 都会重放一遍）"
            );
        }
    }

    /// 老库兼容：**没有这张表的旧库**，升级后启动一次就自动补齐（历史数据一行不动）。
    #[test]
    fn an_old_database_gains_the_ledger_table_on_next_start() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        let path = dir.join("gosslan.db");
        {
            let c = crate::db::init(&path).unwrap();
            c.execute_batch("DROP TABLE group_file_acks").unwrap();
        } // 模拟"旧版本装过的库"
        {
            let c = crate::db::init(&path).unwrap();
            let n: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='group_file_acks'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                n, 1,
                "升级后启动一次就该把账本表补齐（SCHEMA 每次启动都跑）"
            );
            // 老数据不受影响
            let rows: i64 = c
                .query_row("SELECT COUNT(*) FROM group_file_recipients", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "新表不许动历史数据");
        }
    }

    /// 迟到的**失败** ACK 不许把已 completed 的 recipient 降级（completed 是终态）。
    #[test]
    fn a_late_failure_ack_never_downgrades_a_completed_recipient() {
        let conn = mem_db();
        seed(&conn);
        conn.execute(
            "UPDATE group_file_recipients SET status='completed', progress=1.0
             WHERE transfer_id='t1' AND recipient_id='peer-a'",
            [],
        )
        .unwrap();
        let out = apply_group_file_ack_db(&conn, "t1", "peer-a", false).unwrap();
        assert_eq!(out, GroupFileAckOutcome::NoChange, "已 completed 不许降级");
        assert_eq!(recipient_status(&conn, "peer-a"), "completed");
    }

    /// 不是该 transfer 的 recipient ⇒ 拒绝，**不写任何行**（伪造/串台不许碰到账本）。
    #[test]
    fn an_ack_from_a_stranger_is_rejected_without_touching_anything() {
        let conn = mem_db();
        seed(&conn);
        let out = apply_group_file_ack_db(&conn, "t1", "peer-z", true).unwrap();
        assert_eq!(out, GroupFileAckOutcome::NotRecipient);
        assert_eq!(recipient_status(&conn, "peer-a"), "sending");
        assert_eq!(bubble_status(&conn), "sending");
    }
}

/// 重复 Offer 的三种结局（P1-03 / P2-01 的判据）。
#[cfg(test)]
mod group_offer_retry_tests {
    use super::{
        group_file_key_is_stale, group_offer_retry_action, GroupOfferRetry, GROUP_FILE_KEY_TTL_MS,
        GROUP_FILE_RETRY_RESET_MIN_IDLE_MS,
    };

    /// 已收完：只补 ACK，**绝不**重传文件。
    #[test]
    fn completed_offer_only_reacks() {
        assert_eq!(
            group_offer_retry_action(true, Some(60_000)),
            GroupOfferRetry::ReAck,
            "已收完 + 发送方重发 Offer ⇒ 重发 ACK，不重传文件"
        );
        assert_eq!(
            group_offer_retry_action(true, None),
            GroupOfferRetry::ReAck,
            "重启后接收器不在，但本地已收完 ⇒ 仍只补 ACK"
        );
    }

    /// 刚刚还在收：网络重复，忽略（重置会打断正在收的那一单）。
    #[test]
    fn active_receiver_ignores_a_network_duplicate() {
        assert_eq!(
            group_offer_retry_action(false, Some(GROUP_FILE_RETRY_RESET_MIN_IDLE_MS - 1)),
            GroupOfferRetry::Ignore,
            "接收器还在被喂片 ⇒ 这是网络重复，不是发送方重试"
        );
    }

    /// 接收器静默：发送方在重试，必须从 seq 0 重建；接收器不在则留给分片自己重建。
    #[test]
    fn stalled_receiver_restarts_but_absent_receiver_is_left_to_chunks() {
        assert_eq!(
            group_offer_retry_action(false, Some(GROUP_FILE_RETRY_RESET_MIN_IDLE_MS)),
            GroupOfferRetry::Reset,
            "接收器已静默 ⇒ 发送方在重试，必须从 seq 0 重建接收段"
        );
        assert_eq!(
            group_offer_retry_action(false, None),
            GroupOfferRetry::Ignore,
            "接收器不在（可能正在 spawn_blocking 收尾）⇒ 不许在 Offer 时截断 .part"
        );
    }

    /// 接线判据：三种结局必须真的被 handler 使用（纯函数绿 ≠ 被接上）。
    ///
    /// 这条路径要造 AppState 才能跑行为测试（本仓没有夹具）；所以钉的是**生产码文本**：
    /// Reset 必须落到 `begin_group_receive`（截断同一个 `.part`），
    /// ReAck 必须真的再发一条成功 ACK。删掉任一行，这条红。
    #[test]
    fn offer_handler_wires_reset_and_reack() {
        let src = crate::network::transport_src_for_guards();
        let at = src
            .find("async fn handle_group_file_offer(")
            .expect("群文件 Offer handler 改名/搬家了 ⇒ 同步改这条判据");
        let rest = &src[at..];
        let end = rest.find("\n}\n").map(|i| i + 3).unwrap_or(rest.len());
        let flat: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            flat.contains("GroupOfferRetry::Reset=>"),
            "重复 Offer 的 Reset 分支被删了 ⇒ 重试会继续把新段分片判成 Duplicate"
        );
        assert!(
            flat.contains("file::begin_group_receive(state,&transfer_id,&sender_id,&name,size,key,sha256.clone(),)"),
            "Reset 必须走 begin_group_receive（按 transfer_id 截断 .part、从 seq 0 重建接收器）"
        );
        assert!(
            flat.contains("GroupOfferRetry::ReAck=>"),
            "已完成时的 ReAck 分支被删了 ⇒ 丢了 ACK 的发送侧只能无限重投"
        );
        assert!(
            flat.contains(
                "send_group_file_complete_ack(state,&transfer_id,&group_id,&sender_id,true)"
            ),
            "ReAck 必须真的再发一条成功 ACK"
        );
    }

    /// 接线判据：后台清扫器每个 tick 必须**恰好**调一次卡死清扫。
    /// 0 次 = 逻辑全绿但永远不会跑；>1 次 = 同一 tick 重复扫。
    #[test]
    fn outbox_sweeper_calls_the_stale_group_sweep_once() {
        let src = crate::network::transport_src_for_guards();
        let at = src
            .find("pub fn spawn_outbox_sweeper(")
            .expect("清扫器改名/搬家了 ⇒ 同步改这条判据");
        let rest = &src[at..];
        let end = rest.find("\n}\n").map(|i| i + 3).unwrap_or(rest.len());
        let flat: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(
            flat.matches("sweep_stale_group_sending(&state)").count(),
            1,
            "卡死清扫必须由后台清扫器驱动且只调一次（接线判据，不钉存在性）"
        );
    }

    /// P3-06：密钥 TTL 是 2h，边界取“到点即过期”。
    #[test]
    fn group_file_key_ttl_expires_at_the_boundary() {
        assert!(
            !group_file_key_is_stale(0, GROUP_FILE_KEY_TTL_MS - 1),
            "差 1ms 不删"
        );
        assert!(
            group_file_key_is_stale(0, GROUP_FILE_KEY_TTL_MS),
            "到点必须删（闭区间上限，与其它长度/时限判据一致）"
        );
        assert!(group_file_key_is_stale(0, GROUP_FILE_KEY_TTL_MS + 1));
    }

    /// 接线判据：后台清扫器每个 tick 必须**恰好**调一次密钥 TTL 清扫。
    #[test]
    fn outbox_sweeper_calls_the_key_ttl_sweep_once() {
        let src = crate::network::transport_src_for_guards();
        let at = src
            .find("pub fn spawn_outbox_sweeper(")
            .expect("清扫器改名/搬家了 ⇒ 同步改这条判据");
        let rest = &src[at..];
        let end = rest.find("\n}\n").map(|i| i + 3).unwrap_or(rest.len());
        let flat: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
        assert_eq!(
            flat.matches("sweep_stale_group_file_keys(&state)").count(),
            1,
            "密钥 TTL 清扫必须由后台清扫器驱动且只调一次（0 次 = 永不淘汰）"
        );
    }
}

/// 分母快照（`group_file_online_targets`）的留/删判据（10-23 审计 P2-C）。
///
/// 单独一个模块而不是塞进已有的气泡测试：那边只 `use super::{group_file_bubble, retry_ack_write}`，
/// 往里加一条会让"这个模块测什么"变糊（第一版就是插错位置、还把下一条用例的 doc 顶掉了）。
#[cfg(test)]
mod online_targets_tests {
    use super::online_targets_entry_is_live;

    #[test]
    fn online_targets_snapshot_is_kept_only_while_the_transfer_is_live() {
        for live in [Some("pending"), Some("sending")] {
            assert!(online_targets_entry_is_live(live), "{live:?} 还在传，分母要留");
        }
        for dead in [Some("completed"), Some("failed"), Some("cancelled"), None] {
            assert!(!online_targets_entry_is_live(dead), "{dead:?} 没人再读这块快照");
        }
    }
}

/// 群文件失败原因的**上屏判据**：只有稳定码才发 `file-failed`。
///
/// 为什么要钉住（2026-10-27 审计 §5 第 1 项）：
/// · 稳定码（如 `DISK_FULL`）⇒ 对应一件用户能动手的事 ⇒ 弹一次 toast 是对的；
/// · 自由文本（超时 / 断链 / 解密失败）⇒ 上屏会造成**toast 风暴**：
///   peer 断链时常常同时挂着一堆在途群文件（`queue_policy.rs` 那一路逐个收尾），
///   每条都弹一次 ⇒ 用户被十几条一模一样的 toast 淹没。
///
/// 反面对照：把 `is_stable_fail_code` 改成恒 `true` ⇒ 本用例必须红。
#[cfg(test)]
mod group_file_fail_reason_tests {
    use super::{is_stable_fail_code, REASON_PEER_UNLINKED, REASON_STALLED_GROUP_RECEIVE};

    #[test]
    fn only_stable_fail_codes_reach_the_user() {
        // 稳定码：上屏（前端按码翻成"清出磁盘空间后重试"）
        assert!(is_stable_fail_code("DISK_FULL"));
        assert!(is_stable_fail_code("PERMISSION_DENIED"));
        // 自由文本：只进日志，不上屏
        assert!(!is_stable_fail_code(REASON_PEER_UNLINKED));
        assert!(!is_stable_fail_code(REASON_STALLED_GROUP_RECEIVE));
        // 边界：空串不是码（否则会发一条空 reason 的 file-failed）
        assert!(!is_stable_fail_code(""));
    }
}
