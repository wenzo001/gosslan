// 职责边界：`handle_message` 的「共享目录与单跳中继」分支组 —— 只处理 `ContentRequest`、`ShareTreeRequest`、`ShareTreeResponse`、`ShareFileRequest`、`RelayFileOffer`、`RelayChunk` 这些变体；不做路由、不起新连接，落库/发送都在各自臂体里（与原函数逐字相同）。
// 为什么单独一册：`handle_message` 原来 1,540 行 / 38 个臂挤在一个函数里。已用 AST 现量过
//   **match 之前没有裸 let 绑定、分支之间不共享局部量** ⇒ 按消息族拆出去是机械搬家而不是改控制流，
//   依据与量法见 docs/large-file-split-plan.md §5.1。
// 恒等判据（每族都跑同一套）：`cargo test --features bluetooth --lib -- --list` 用例名差集 0 行、
//   `verify-guards.py --list` 每条锚点仍恰好命中一次、clippy `-D warnings`、`cargo fmt --check`。
// 为什么并成一族：这 6 个变体都是「替别人取/传」而不是「给我」——ContentRequest 按 cid 拉取、ShareTree/ShareFile 读写共享目录、
//   RelayFileOffer/RelayChunk 是单跳借道。它们共用同一批判据（丢帧必留痕、单跳限制、授权闸）。

/// 「谁能从我这里按 cid 取走这份内容」的判定内核 —— ADR-0019「拥有即授权」的**受众那一半**。
/// （`content::store::find_source` 只判"本机是否真持有完整字节"，它**不看请求方是谁**；
/// 把请求方纳入判据的就是这里。此前这段逻辑长在 `async` + 两道锁中间，所以那五条边界
/// 一条都没法单测 —— 同 `friend_accept_flush_decision` / `diag_event_from_send_result` /
/// `should_keep_peer` 三条先例的做法：把判定抽成纯函数，臂里只负责把事实取出来。）
///
/// 最容易写反的两格，都是**该拒**的那两格：
/// ① 内容行挂着群 id 但**那一行群已经不存在**（退群/删群）⇒ 不能因为"有个群 id"就放行；
/// ② 既不是好友、内容又没挂群 ⇒ 陌生人不能凭一个 cid 把别人的文件拉走。
pub(crate) fn content_serve_allowed(
    is_friend: bool,
    source_group_id: Option<&str>,
    group_members: Option<&[String]>,
    requester: &str,
) -> bool {
    if is_friend {
        return true;
    }
    match (source_group_id, group_members) {
        (Some(_), Some(members)) => members.iter().any(|m| m == requester),
        _ => false,
    }
}

#[cfg(test)]
mod content_serve_gate_tests {
    use super::content_serve_allowed;

    /// 好友那一臂不看群：内容没挂群 id 也照服务（1:1 补拉走的正是这条路）。
    #[test]
    fn friend_is_allowed_without_any_group() {
        assert!(content_serve_allowed(true, None, None, "p-b"));
    }

    /// 「群成员当种子」这一格（ADR-0019 里内容寻址的意义所在）：A→B 送达后，
    /// 没拿到的 C **不是 B 的好友**，但仍能从 B 拉 —— 只要 C 在内容所属群的成员表里。
    #[test]
    fn group_member_is_allowed_without_being_a_friend() {
        let members = ["p-a".to_string(), "p-b".to_string(), "p-c".to_string()];
        assert!(content_serve_allowed(false, Some("g-1"), Some(&members[..]), "p-c"));
    }

    /// 反面对照①：同一条内容、同一张成员表，**不在群里**的请求方必须被拒。
    /// （没有这条，上一条会因为"成员表整个没被读"而假绿。）
    #[test]
    fn stranger_in_another_group_is_denied() {
        let members = ["p-a".to_string(), "p-b".to_string()];
        assert!(!content_serve_allowed(false, Some("g-1"), Some(&members[..]), "p-z"));
    }

    /// 反面对照②：内容行挂着群 id，但**那一行群已经不在了** ⇒ 拒。
    /// 写反成 `unwrap_or(true)` 的话，删群/退群之后陌生人反而能取走内容。
    #[test]
    fn missing_group_row_is_denied() {
        assert!(!content_serve_allowed(false, Some("g-gone"), None, "p-c"));
    }

    /// 反面对照③：不是好友且内容没挂群（纯 1:1 的内容被陌生人按 cid 请求）⇒ 拒。
    #[test]
    fn non_friend_without_group_binding_is_denied() {
        assert!(!content_serve_allowed(false, None, None, "p-z"));
    }
}

async fn handle_share_and_relay_messages(state: &Arc<AppState>, peer_id: &str, msg: Message) {
    // 这层 match 与原函数里的同一层（臂仍是 8 格缩进 ⇒ 逐字未改）。
    // `_ => {}` 不是吞消息：调用方只在命中本族变体时才把 msg 交进来。
    match msg {
        Message::ContentRequest {
            from,
            cid,
            transfer_id,
            from_seq,
            from_bytes,
            ..
        } => {
            if from != peer_id {
                return;
            }
            let source = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                crate::content::store::find_source(&dbc, &cid)
                    .ok()
                    .flatten()
            };
            let Some((_owner, group_id, path)) = source else {
                state.logger.info(
                    "content",
                    format!("ContentRequest：本机没有该内容 cid={cid}"),
                );
                return;
            };
            // 授权：是好友，**或** 是该内容所属群的成员 —— 群聊里 A→B 成功后，
            // 没拿到的 C 可以从已收完的 B 拉（B 是种子，内容寻址的意义所在）。
            // 判据本体在 `content_serve_allowed`（纯函数 ⇒ 五条边界都有单测）；这里只把事实取出来。
            let allowed = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                let is_friend = db::get_friend(&dbc, &from).is_some();
                let members = if is_friend {
                    None
                } else {
                    group_id
                        .as_deref()
                        .and_then(|g| db::get_group(&dbc, g).map(|grp| grp.members))
                };
                content_serve_allowed(is_friend, group_id.as_deref(), members.as_deref(), &from)
            };
            if !allowed {
                state.logger.warn(
                    "content",
                    format!("ContentRequest：请求方无权限，拒绝服务 cid={cid} from={from}"),
                );
                return;
            }
            // 续传：沿用原 transfer_id（接收端才找得到 <tid>.part），并从已收字节起发。
            let transfer_id = if transfer_id.is_empty() {
                format!("refetch-{}", uuid::Uuid::new_v4())
            } else {
                transfer_id
            };
            // ⚠️ 不在这个臂里 await 整条握手（2026-10-13 真机第 7 条的自死锁）：
            // `send_file_from_path_at` 发完 FileOffer 要等对端的 FileAccept/FileReject，
            // 而那一帧正是由**这条被本函数堵住的 reader 循环**读回来的 ⇒ 每次必走满 15 秒，
            // 期间同链路群聊/单聊/心跳全部进不来。改成投给"每对端一个有界串行队列"：
            // 同一对端仍一次一单 ⇒ `pending_file_accept` 那个只按 transfer_id 登记的单键
            // 不会被并发踩到，但应答读得到 ⇒ 这条路径第一次能真正成功。
            let fs = state.file_service.clone();
            if !fs.has_worker(&from) {
                let exec_state = state.clone();
                fs.start_worker(&from, move |job| {
                    let exec_state = exec_state.clone();
                    async move {
                        match crate::network::file::send_file_from_path_at(
                            &exec_state,
                            &job.peer_id,
                            &job.transfer_id,
                            job.path.clone(),
                            job.from_seq,
                            job.from_bytes,
                        )
                        .await
                        {
                            Ok(()) => exec_state.logger.info(
                                "content",
                                format!(
                                    "已按 ContentRequest 回发内容 cid={} -> {}",
                                    job.cid, job.peer_id
                                ),
                            ),
                            Err(e) => exec_state.logger.warn(
                                "content",
                                format!(
                                    "ContentRequest 服务失败 cid={} from={}: {e:?}",
                                    job.cid, job.peer_id
                                ),
                            ),
                        }
                    }
                });
            }
            match fs.submit(FileServeJob {
                cid: cid.clone(),
                peer_id: from.clone(),
                transfer_id: transfer_id.clone(),
                path: std::path::PathBuf::from(&path),
                from_seq,
                from_bytes,
            }) {
                // Merged（同 cid 已在队里）也走这一支：不重复服务是设计，静默即可
                ServeTicket::Accepted | ServeTicket::Merged => {}
                // 队列满：**必须留痕**，因为"这条请求这一轮没被服务"只能靠这行看见；
                // 重投路径是既有的（请求方退避 + 心跳机会，见 `handle_identity.rs` 心跳臂）。
                ServeTicket::RejectedFull => {
                    if log_throttled("content_serve_full", 5_000) {
                        // 带上当前深度：这条日志就是"队列确实有界"的现场读数（否则只能靠读代码相信它）
                        let depth = fs.queued_len(&from);
                        state.logger.warn(
                            "content",
                            format!(
                                "ContentRequest 服务队列已满（每对端上限 {FILE_SERVICE_QUEUE_CAP}，当前深度 {depth}），本轮不服务、留给重投 cid={cid} from={from}"
                            ),
                        );
                    }
                }
            }
        }
        Message::ShareTreeRequest {
            request_id,
            from,
            to: _to,
        } => {
            // 定向中继已在 handle_message 顶部处理（不是给我的帧不会走到这里）。
            if from == state.device_id {
                return;
            }
            // 双好友判定（2026-09-19 自审 P1#4）：`from` 是**自报字段** —— 单查它，
            // 一个好友可以冒用另一个好友的 id 浏览别人的共享目录。也不能简单收紧成
            // from==peer_id：借一跳中继的合法帧到达时 peer 是转投邻居而非原 requester。
            // 残余风险（接受并记录）：中继好友 M 可以转发 from=他人 的请求，
            // 但 M 本身已通过 4.22.9 的中继授权闸，且处于 LAN 信任模型内。
            let allowed = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_friend(&dbc, &from).is_some() && db::get_friend(&dbc, peer_id).is_some()
            };
            if !allowed {
                return;
            }
            let entries = {
                let share = state
                    .share_dir
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                match share {
                    Some(dir) => {
                        // 递归遍历是同步文件系统调用，必须离开 tokio worker（10-22 审计 R-21）：
                        // 这段跑在 reader_loop 所在的那个 worker 上，共享目录里项数一多就是**秒级**
                        // 占住它，而同一个 worker 上还挂着别的链路的入站帧读取 —— 表现是"有人来浏览
                        // 我的共享目录时，整个 App 的消息一起顿一下"。
                        // `share_dir` 的守卫在 clone 之后就已经释放，这里不跨 await 持任何锁。
                        match tokio::task::spawn_blocking(move || file::walk_share_dir(Path::new(&dir)))
                            .await
                        {
                            Ok(entries) => entries,
                            Err(e) => {
                                state.logger.warn(
                                    "share",
                                    format!("code=SHARE_TREE_WALK_FAILED err={e} —— 本次共享目录树按空处理"),
                                );
                                Vec::new()
                            }
                        }
                    }
                    None => Vec::new(),
                }
            };
            let resp = Message::ShareTreeResponse {
                request_id,
                from: state.device_id.clone(),
                to: Some(from.clone()),
                entries,
            };
            // 有直连直接回；没有则借一跳中继送回（与请求路径对称）。
            if state.has_link(&from).await {
                let _ = try_send(state, &from, &resp).await;
            } else {
                // 邻居接住数不用：请求方自己有 10s 超时兜底，那边才是它的失败证据。
                let _ = relay_send_to_neighbors(state, &from, &resp).await;
            }
        }
        Message::ShareTreeResponse {
            request_id,
            entries,
            ..
        } => {
            if let Some(tx) = state
                .pending_share_tree
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id)
            {
                let _ = tx.send(entries);
            }
        }
        Message::ShareFileRequest {
            transfer_id,
            from,
            path,
            to: _to,
        } => {
            // 定向中继已在 handle_message 顶部处理。
            if from == state.device_id {
                return;
            }
            // 双好友判定，同 ShareTreeRequest（自审 P1#4）：`from` 自报可伪造，
            // 下载别人共享目录的文件必须「声称的 requester 是我的好友」**且**
            // 「提出这条链路的对端也是我的好友」（中继链两跳都在信任圈内）。
            let allowed = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_friend(&dbc, &from).is_some() && db::get_friend(&dbc, peer_id).is_some()
            };
            if !allowed {
                return;
            }
            let share = state
                .share_dir
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let Some(root) = share else { return };
            let root = PathBuf::from(root);
            let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
            let full = root.join(&path);
            let canon_full = full.canonicalize().unwrap_or_else(|_| full.clone());
            if !canon_full.starts_with(&canon_root) || !canon_full.is_file() {
                return;
            }
            let st = state.clone();
            let from = from.clone();
            // 本地提示：对端请求下载你的共享文件（聊天信息内简约系统消息）。
            // ⚠️ 措辞必须是「请求下载」而不是「下载了」：这条插入发生在**推第一个分片之前**，
            // 而中继发送此刻起还没任何成功证据（审计 A1）。写成完成时态就是一句可能被证伪的
            // 陈述句，用户会据此以为文件已经给出去了。
            let file_name = path
                .rsplit('/')
                .next()
                .map(|s| s.to_string())
                .unwrap_or_else(|| path.clone());
            let from_name = resolve_nickname(state, &from);
            crate::commands::insert_system_message(
                state,
                &from,
                &format!("「{from_name}」请求下载你的文件「{file_name}」"),
            );
            tokio::spawn(async move {
                // 有直连走原有可靠直传；没有直连则借一跳中继（RelayFileOffer/RelayChunk）。
                let result = if st.has_link(&from).await {
                    file::send_file_from_path(&st, &from, &transfer_id, canon_full)
                        .await
                        .map_err(|e| e.message)
                } else {
                    file::send_file_via_relay(&st, &from, &transfer_id, canon_full).await
                };
                if let Err(reason) = result {
                    let _ = st.app.emit(
                        "file-failed",
                        &FileFailedInfo {
                            transfer_id,
                            reason,
                        },
                    );
                }
            });
        }
        // ---- Gossip 广播 ----
        Message::RelayFileOffer {
            transfer_id,
            from,
            to,
            name,
            size,
            total_chunks,
            chunk_size,
            sealed_file_key,
            file_sha256,
        } => {
            handle_relay_file_offer(
                state,
                peer_id,
                transfer_id,
                from,
                to,
                name,
                size,
                total_chunks,
                chunk_size,
                sealed_file_key,
                file_sha256,
            )
            .await;
        }
        Message::RelayChunk {
            transfer_id,
            seq,
            data,
            from,
            to,
            ttl,
        } => {
            handle_relay_chunk(state, peer_id, transfer_id, seq, data, from, to, ttl).await;
        }
        // ---- 群密钥分发 ----
        _ => {}
    }
}
