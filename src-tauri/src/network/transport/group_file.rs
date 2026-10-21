// 群文件传输：offer / chunk / done / 完成回执、失败与停滞回收
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第三批；守卫视图与领域图的分册清单一同登记。

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
) {
    // 链路上报的 sender 必须与 Offer 声明一致，且不能是自己
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 幂等：会话已激活（内存有 file_key）→ 重复 Offer 忽略。
    // 注意不能因为「group_files 里有记录」就跳过：重启后内存 key 丢失但记录还在，
    // 跳过会让离线补发永远无法重建会话（接收卡死）。改为下方「已完成则跳过」+「幂等重建」。
    if state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&transfer_id)
    {
        return;
    }
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

    // 已完成的 transfer → 忽略（避免重复接收 / 重复 emit）
    let already_done = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group_file_recipient_status(&dbc, &transfer_id, &state.device_id).as_deref()
            == Some("completed")
    };
    if already_done {
        return;
    }

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
    // `scope == "todo"`：待办描述图片，仅走传输管线把字节投递给全员，
    // 不进聊天时间线、不弹气泡、不改会话预览（与发送端对称）。
    if scope != "todo" {
        // 接收气泡：与发送端同一 msg_id（gfile-{transfer_id}），前端据 file-progress
        // 之外的状态事件推进。此处 status=sending，Done 校验通过后转 delivered。
        // 图片文件保持 kind="image"，业务语义不降级。
        let subtype = file::classify_file_subtype(&name);
        // 同口径收敛（见单聊 FileOffer 处的说明）
        let kind = if subtype == "image" { "image" } else { "file" };
        let conv_id = format!("group:{group_id}");
        let seq = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::next_clock(&dbc, &conv_id).unwrap_or(1)
        };
        let rec = crate::state::MessageRecord {
            id: 0,
            msg_id: format!("gfile-{transfer_id}"),
            conv_id: conv_id.clone(),
            sender_id: sender_id.clone(),
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
        };
        {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            // 落库失败必须留痕（审计 2026-10-16）：这一格是"卡片类"消息，吞掉后界面没有那张卡
            // 而日志一字不记 ⇒ 现场无从归因。不改行为：仍然继续往下走（文件已在盘上是事实），
            // 只是不再静默。
            if let Err(e) = db::insert_message(&dbc, &rec) {
                state.logger.error(
                    "group_file",
                    format!("群文件卡片落库失败 msg={}：{e}", rec.msg_id),
                );
            }
            db::touch_conversation(
                &dbc,
                &format!("group:{group_id}"),
                "group",
                &name,
                None,
                &format!("[群文件] {name}"),
                1,
            )
            .ok();
        }
        let _ = state.app.emit("message-received", &rec);
    }
    // 会话密钥仅存内存，供下一阶段解密 GroupFileChunk
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(transfer_id, file_key);
}

/// 失败收尾：删除 `.part`、移除接收状态与会话密钥、recipient 置 failed。
/// 只影响本 transfer，不 panic、不影响其他群文件。
fn fail_group_file_chunk(state: &Arc<AppState>, transfer_id: &str) {
    file::fail_group_receive(state, transfer_id);
    finalize_failed_group_receive(state, transfer_id);
}

/// 摘表之后的群接收**收尾**三件事：气泡转 failed、丢掉内存里的 file_key、台账写 failed。
///
/// 从 `fail_group_file_chunk` 里单列出来，是因为对端下线那条路必须先"原子摘"再"逐个收尾"
/// （见 `file::take_group_receives_for_peer`）：摘与收尾合成一个函数的话，
/// 调用点就只能走"快照 id → 逐个收尾"，而那正是本文件 `:5232` 注释判死过的形状。
fn finalize_failed_group_receive(state: &Arc<AppState>, transfer_id: &str) {
    set_gfile_bubble_status(state, transfer_id, "failed");
    state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(transfer_id);
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db::update_group_file_recipient(&dbc, transfer_id, &state.device_id, "failed", 0.0);
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
        fail_group_file_chunk(state, &id);
        reclaimed += 1;
    }
    reclaimed
}

/// 群文件气泡状态推进：msg_id = gfile-{transfer_id}（收发双方本地记录）。
fn set_gfile_bubble_status(state: &AppState, transfer_id: &str, status: &str) {
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    db::set_message_status(&dbc, &format!("gfile-{transfer_id}"), status).ok();
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
) {
    if sender_id != peer_id || sender_id == state.device_id {
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
            fail_group_file_chunk(state, &transfer_id);
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
    let downloads = state
        .downloads_dir
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let finalized = match tokio::task::spawn_blocking(move || {
        file::finish_group_receive_into(r, &downloads)
    })
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
            db::update_group_file_recipient(conn, &transfer_id, &state.device_id, "completed", 1.0)?;
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
            id: 0,
            msg_id,
            conv_id: format!("group:{group_id}"),
            sender_id: sender_id.clone(),
            receiver_id: state.device_id.clone(),
            kind: kind.to_string(),
            content: serde_json::json!({
                "name": gf.name,
                "path": final_path.to_string_lossy(),
                "size": gf.size,
                "sha256": gf.sha256,
                "subtype": subtype,
                "progress": 1.0,
            })
            .to_string(),
            ts: db::now_ms(),
            seq,
            status: "delivered".to_string(),
            // 同上：群文件收尾这条不带 @ 落点 ⇒ NULL。
            mention_targets: None,
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
                    format!(
                        "群文件 path 回填失败 msg={}：{e}",
                        done_rec.msg_id
                    ),
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
        db::set_message_status(&tx, &format!("gfile-{transfer_id}"), b).map_err(|e| e.to_string())?;
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
        let path = db::list_transfers(&dbc)
            .unwrap_or_default()
            .into_iter()
            .find(|t| t.id == transfer_id)
            .and_then(|t| t.path);
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
        let _ = state.app.emit("message-acked", &format!("gfile-{transfer_id}"));
    }
    Ok(outcome)
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
                            let _ = db::delete_group_file_ack(&dbc, &ack.transfer_id, &ack.recipient_id);
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
async fn handle_group_file_chunk(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    group_id: String,
    sender_id: String,
    seq: u32,
    data: String,
) {
    // 权限：链路 sender 与声明一致、不能是自己、群存在、sender 是群成员
    if sender_id != peer_id || sender_id == state.device_id {
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
    let Some(file_key) = state
        .group_file_keys
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&transfer_id)
        .copied()
    else {
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

    // 解密（AEAD 失败 → 失败收尾：删 `.part`、置 failed，不写错误明文）
    let Ok(sealed) = STANDARD.decode(&data) else {
        fail_group_file_chunk(state, &transfer_id);
        return;
    };
    let Some(plaintext) = crypto::open_symmetric(&file_key, &sealed) else {
        fail_group_file_chunk(state, &transfer_id);
        return;
    };

    // seq / size 校验与写盘（复用一对一 FileReceiver 的严格语义）
    {
        use std::io::Write;
        let mut recv = state
            .group_file_receivers
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(r) = recv.get_mut(&transfer_id) else {
            return;
        };
        // ⚠️ 群侧以前这里是 `if seq != r.next_seq { 整单失败 }`，注释写的理由是"TCP 有序"。
        // 那个前提在群里不成立：群文件经**中继扇出**，同一片可以被两条链路各送一次，
        // 而单聊那一族早就为同一件事付过学费（`file.rs` 里 `chunk_seq_decision` 的注释：
        // 把重复/迟到当致命 ⇒ 整单永远拼不齐）。规则只许有一份 ⇒ 这里直接调那个纯函数。
        let seq_call = file::chunk_seq_decision(seq, r.next_seq);
        if seq_call == file::ChunkSeq::Duplicate {
            // 重复/迟到片：与单聊同一处置（不写盘、不打死、不回错误），下一片照常进来。
            drop(recv);
            return;
        }
        if seq_call == file::ChunkSeq::Gap {
            // 真跳号：中间确实缺片，只能靠重传 ⇒ 终止这一单。
            drop(recv);
            fail_group_file_chunk(state, &transfer_id);
            return;
        }
        if plaintext.len() as u64 > r.size.saturating_sub(r.received) {
            // 超出声明大小：防恶意 sender
            drop(recv);
            fail_group_file_chunk(state, &transfer_id);
            return;
        }
        // 增量哈希（为下一阶段 FileDone 校验准备；本阶段不比对）
        use sha2::Digest;
        r.hasher.update(&plaintext);
        if r.file.write_all(&plaintext).is_err() {
            drop(recv);
            fail_group_file_chunk(state, &transfer_id);
            return;
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
        drop(recv);
        // 进度落库：本阶段最高 sending，不标 completed
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::update_group_file_recipient(
            &dbc,
            &transfer_id,
            &state.device_id,
            "sending",
            progress,
        );
    }
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
        conn.query_row("SELECT status FROM messages WHERE msg_id='gfile-t1'", [], |r| {
            r.get(0)
        })
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
        assert!(outcome.is_err(), "写失败必须报错，不许假装成功：{outcome:?}");
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
        conn.execute_batch("DROP TRIGGER block_recipient_update").unwrap();
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
        let dir = std::env::temp_dir().join(format!(
            "gosslan-ack-ledger-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
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
            assert_eq!(out, GroupFileAckOutcome::Applied { bubble: Some("delivered") });
            crate::db::delete_group_file_ack(&c, "t1", "peer-a").unwrap();
            assert!(
                crate::db::list_group_file_acks(&c, 10).unwrap().is_empty(),
                "落终态后账本必须清空（否则每 tick 都会重放一遍）"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 老库兼容：**没有这张表的旧库**，升级后启动一次就自动补齐（历史数据一行不动）。
    #[test]
    fn an_old_database_gains_the_ledger_table_on_next_start() {
        let dir = std::env::temp_dir().join(format!(
            "gosslan-ack-old-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
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
            assert_eq!(n, 1, "升级后启动一次就该把账本表补齐（SCHEMA 每次启动都跑）");
            // 老数据不受影响
            let rows: i64 = c
                .query_row("SELECT COUNT(*) FROM group_file_recipients", [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 0, "新表不许动历史数据");
        }
        let _ = std::fs::remove_dir_all(&dir);
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
