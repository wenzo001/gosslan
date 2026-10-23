// 职责边界：`handle_message` 的「群聊与群文件」分支组 —— 只处理 `GroupReadReceipt`、`GroupAck`、`GroupKey`、`GroupRename`、`GroupMemberRemoved`、`GroupCreatorChanged`、`GroupMemberLeft`、`GroupFileOffer`、`GroupFileChunk`、`GroupFileDone`、`GroupFileCompleteAck`、`GroupHistoryRequest`、`GroupHistoryReply` 这些变体；不做路由、不起新连接，落库/发送都在各自臂体里（与原函数逐字相同）。
// 为什么单独一册：`handle_message` 原来 1,540 行 / 38 个臂挤在一个函数里。已用 AST 现量过
//   **match 之前没有裸 let 绑定、分支之间不共享局部量** ⇒ 按消息族拆出去是机械搬家而不是改控制流，
//   依据与量法见 docs/large-file-split-plan.md §5.1。
// 恒等判据（每族都跑同一套）：`cargo test --features bluetooth --lib -- --list` 用例名差集 0 行、
//   `verify-guards.py --list` 每条锚点仍恰好命中一次、clippy `-D warnings`、`cargo fmt --check`。
// 为什么并成一族：这 13 个变体共用同一套群前提——密钥必须先到（GroupKey 排在消息之前，2026-09-27 #77 补递轮钉的就是这条次序）、
//   受众按群算（GroupAck/GroupReadReceipt 是 G-Set 语义，群历史两帧同样只服务本群成员）、群文件走另一条 outbox（每人一行）。
//   留在 handle_message 里时这些前提散在 11 个臂中间，读一处看不到另一处。

async fn handle_group_messages(state: &Arc<AppState>, peer_id: &str, msg: Message) {
    // 这层 match 与原函数里的同一层（臂仍是 8 格缩进 ⇒ 逐字未改）。
    // `_ => {}` 不是吞消息：调用方只在命中本族变体时才把 msg 交进来。
    match msg {
        Message::GroupReadReceipt {
            from,
            group_id,
            last_read_ts,
            last_read_msg_id,
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            let is_member = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_group(&dbc, &group_id)
                    .map(|g| g.members.contains(&from) && g.members.contains(&state.device_id))
                    .unwrap_or(false)
            };
            if !is_member {
                return;
            }
            let effective_ts = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                last_read_msg_id
                    .as_deref()
                    .and_then(|msg_id| {
                        dbc.query_row(
                            "SELECT ts FROM messages WHERE msg_id = ?1 AND sender_id = ?2 AND conv_id = ?3",
                            params![msg_id, state.device_id, format!("group:{group_id}")],
                            |r| r.get::<_, i64>(0),
                        )
                        .ok()
                    })
                    .unwrap_or(last_read_ts)
            };
            {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::upsert_group_read(&dbc, &group_id, &from, effective_ts).ok();
            }
            let _ = state.app.emit(
                "group-read",
                &serde_json::json!({
                    "group_id": group_id,
                    "reader_id": from,
                    "last_read_ts": effective_ts,
                }),
            );
        }
        Message::GroupAck {
            group_id,
            msg_id,
            from,
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            // 只清除该 peer 在该群中的待发记录；不存在时删除是安全的 no-op。
            // 命中失败不向外暴露，避免用伪造 Ack 探测本地 outbox。
            //
            // 状态推进与删行必须在**同一个事务**里（2026-10-20 永久发送中 P0）：
            // 旧写法先删 `group_outbox`、再 `set_message_status(...).ok()`，删行成功而
            // 状态写失败就留下「队列行没了、消息还是 sending」的孤儿 —— 清扫器只扫
            // group_outbox，补发也没有行可发。与 1:1 的 `ack_delivered` 同一纪律。
            let applied = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::ack_group_delivered(&dbc, &msg_id, &from)
            };
            match applied {
                Ok(true) => {
                    let _ = state.app.emit(
                        "group-message-acked",
                        &serde_json::json!({ "group_id": group_id, "msg_id": msg_id }),
                    );
                }
                Ok(false) => {
                    // 伪造 / 重复 / 已收尾的 GroupAck：与旧行为一致，静默丢弃。
                }
                Err(e) => {
                    state.logger.error(
                        "ack",
                        format!(
                            "code=GROUP_ACK_COMMIT_FAILED msg_id={msg_id} group_id={group_id} \
                             peer={peer_id} err={e} —— 队列行与状态都保留，等待重发后再收尾"
                        ),
                    );
                }
            }
        }
        // 「1:1 文件收发」6 个变体的处理体在 `transport/handle_file.rs::handle_file_messages`
        // （2026-10-07 拆出；分发臂用 `{ .. }` 不绑字段，绑定留在分册里那条同形状的模式上）。
        Message::GroupKey {
            group_id,
            from,
            to,
            key,
            group_name,
            members,
            clock,
        } => {
            if from != peer_id {
                return;
            }
            handle_group_key(state, group_id, from, to, key, group_name, members, clock).await;
        }
        Message::GroupRename {
            group_id,
            from,
            name,
        } => {
            if from != peer_id {
                return;
            }
            handle_group_rename(state, group_id, from, name).await;
        }
        Message::GroupMemberRemoved { group_id, from, to } => {
            if from != peer_id {
                return;
            }
            handle_group_member_removed(state, group_id, from, to).await;
        }
        Message::GroupCreatorChanged { group_id, from, to } => {
            if from != peer_id {
                return;
            }
            handle_group_creator_changed(state, group_id, from, to).await;
        }
        Message::GroupMemberLeft { group_id, from } => {
            if from != peer_id {
                return;
            }
            handle_group_member_left(state, group_id, from).await;
        }
        Message::GroupFileOffer {
            transfer_id,
            group_id,
            sender_id,
            name,
            size,
            sha256,
            sealed_file_key,
            scope,
            todo_id,
            attempt,
        } => {
            handle_group_file_offer(
                state,
                peer_id,
                transfer_id,
                group_id,
                sender_id,
                name,
                size,
                sha256,
                sealed_file_key,
                scope,
                todo_id,
                attempt,
            )
            .await;
        }
        Message::GroupFileChunk {
            transfer_id,
            group_id,
            sender_id,
            seq,
            data,
            attempt,
        } => {
            handle_group_file_chunk(
                state,
                peer_id,
                transfer_id,
                group_id,
                sender_id,
                seq,
                data,
                attempt,
            )
            .await;
        }
        Message::GroupFileDone {
            transfer_id,
            group_id,
            sender_id,
            attempt,
        } => {
            handle_group_file_done(state, peer_id, transfer_id, group_id, sender_id, attempt).await;
        }
        Message::GroupFileCompleteAck {
            transfer_id,
            group_id,
            sender_id,
            success,
        } => {
            handle_group_file_complete_ack(
                state,
                peer_id,
                transfer_id,
                group_id,
                sender_id,
                success,
            )
            .await;
        }
        Message::GroupFileResume {
            transfer_id,
            group_id,
            to_sender,
            received,
        } => {
            handle_group_file_resume(state, peer_id, transfer_id, group_id, to_sender, received)
                .await;
        }
        // 群历史同步（2026-10-16 需求）：臂体只做搬运，判定与取数都在 `network/group_history.rs`
        // —— 那一个家同时管着"该不该给/给哪一页"与"拿到一页怎么落库"，
        // 拆在两处就会各写一遍授权（本仓为"同一开关的另一个面"付过学费）。
        Message::GroupHistoryRequest {
            request_id,
            from,
            to,
            group_id,
            after_seq,
            after_id,
            limit,
        } => {
            crate::network::group_history::handle_request(
                state, peer_id, request_id, from, to, group_id, after_seq, after_id, limit,
            )
            .await;
        }
        Message::GroupHistoryReply {
            request_id,
            from,
            to,
            reply,
        } => {
            crate::network::group_history::handle_reply(
                state, peer_id, request_id, from, to, reply,
            );
        }
        // 按成员取消（B3b）：整单取消与"某一格不再传了"是两件事，这一帧只管后者。
        Message::GroupFileCancel {
            transfer_id,
            group_id,
            recipient,
            from,
        } => {
            handle_group_file_cancel(state, peer_id, transfer_id, group_id, recipient, from).await;
        }
        _ => {}
    }
}
