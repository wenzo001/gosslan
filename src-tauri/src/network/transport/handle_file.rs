// 职责边界：`handle_message` 的「1:1 文件收发」分支组 —— 只处理 `FileOffer`、`FileAccept`、`FileReject`、`FileCompleteAck`、`FileChunk`、`FileDone` 这些变体；不做路由、不起新连接，落库/发送都在各自臂体里（与原函数逐字相同）。
// 为什么单独一册：`handle_message` 原来 1,540 行 / 38 个臂挤在一个函数里。已用 AST 现量过
//   **match 之前没有裸 let 绑定、分支之间不共享局部量** ⇒ 按消息族拆出去是机械搬家而不是改控制流，
//   依据与量法见 docs/large-file-split-plan.md §5.1。
// 恒等判据（每族都跑同一套）：`cargo test --features bluetooth --lib -- --list` 用例名差集 0 行、
//   `verify-guards.py --list` 每条锚点仍恰好命中一次、clippy `-D warnings`、`cargo fmt --check`。
// 为什么这一族先拆：它是 handle_message 里最厚的一组（6 个变体 499 行），且锚点最密（5 条护栏用例钉在臂体里）——
//   先动它能把「搬完锚点必须改 file=」这条流程走通，后面四族就是重复同一条路径。

async fn handle_file_messages(state: &Arc<AppState>, peer_id: &str, msg: Message) {
    // 这层 match 与原函数里的同一层（臂仍是 8 格缩进 ⇒ 逐字未改）。
    // `_ => {}` 不是吞消息：调用方只在命中本族变体时才把 msg 交进来。
    match msg {
        Message::FileOffer {
            transfer_id,
            from,
            name,
            size,
            sealed_file_key,
            file_sha256,
            from_bytes,
            attempt,
            ..
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            let is_friend = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_friend(&dbc, &from).is_some()
            };
            if !is_friend {
                let _ = try_send(
                    state,
                    peer_id,
                    &Message::FileReject {
                        transfer_id,
                        received: 0,
                    },
                )
                .await;
                return;
            }
            // SHA-256 元数据格式校验：非法即拒绝（文件级完整性无法验证）
            if !file::valid_sha256_hex(&file_sha256) {
                let _ = try_send(
                    state,
                    peer_id,
                    &Message::FileReject {
                        transfer_id,
                        received: 0,
                    },
                )
                .await;
                return;
            }
            // E2EE：解封文件会话密钥（发送方用我方公钥封装，只有我能解开）。
            // 解封失败必须拒绝传输——密文分片绝不能落盘。
            let file_key = (|| {
                let sender_pub = resolve_member_x25519(state, &from)?;
                let shared = state.identity.dh(&sender_pub)?;
                let sealed = STANDARD.decode(&sealed_file_key).ok()?;
                crypto::open(&shared, &sealed).and_then(|k| k.try_into().ok())
            })();
            let Some(file_key) = file_key else {
                let _ = try_send(
                    state,
                    peer_id,
                    &Message::FileReject {
                        transfer_id,
                        received: 0,
                    },
                )
                .await;
                return;
            };
            // 位置判据**只有一份**（`file::decide_offer`）：有活跃接收器时以它的内存计数为准，
            // 没有时以磁盘 `.part` 前缀为准。
            //
            // 以前这里是两套规矩：`!has_receiver` 才比对前缀、`has_receiver` 一律裸 Accept。
            // 后者在真机上把 160MB 判了死刑 —— 发送端每轮重试都从 `from_bytes = 0` 重发
            // （`flush_pending_files` 走不带位置的 `send_file_from_path`），接收端回 Accept 后
            // 把已收的几十 MB 当"迟到的重复片"静默丢掉 ⇒ 每轮都重传一遍前缀 ⇒ 永不收敛、
            // 界面恒 0%、最后报"分片失败"。回真实位置才是正解（发送端 `file.rs` 那一侧
            // 早就听得懂 `FileReject.received`，它只是从来没被这样告诉过）。
            let active = file::receiver_progress(state, &transfer_id);
            let disk_retained = file::retained_part_len(state, &transfer_id);
            // 「本机已收完」也是判据输入（2026-09-23 审计 A6）：收完后 .part 已改名、
            // 接收器已清空，三输入全归零 ⇒ 旧判据把重复 Offer 判成 Accept ⇒ 整份
            // 重推落"名字(1)"副本。已 done 的传输一律回 AlreadyHave。
            let done_query = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::is_transfer_done(&dbc, &transfer_id)
            };
            // 查询失败按「还没收完」处理（保守方向：最坏重传一次，不会丢数据），但必须留痕。
            let already_completed = done_query.unwrap_or_else(|e| {
                state.logger.warn(
                    "file",
                    format!("查询传输终态失败，按未收完处理 transfer={transfer_id}: {e}"),
                );
                false
            });
            let decided = file::decide_offer(
                active.is_some(),
                active.unwrap_or(0),
                disk_retained,
                size,
                from_bytes,
                already_completed,
            );
            match decided {
                file::OfferDecision::AlreadyHave => {
                    state.logger.info(
                        "file",
                        format!(
                            "本机已完整收下该文件，拒绝重推 transfer={transfer_id}（回 received=size）"
                        ),
                    );
                    let _ = try_send(
                        state,
                        peer_id,
                        &Message::FileReject {
                            transfer_id,
                            received: size,
                        },
                    )
                    .await;
                    return;
                }
                file::OfferDecision::ResumeFrom(held) => {
                    state.logger.info(
                        "file",
                        format!(
                            "接收端已有 {held} 字节，要求发送端从此续发 transfer={transfer_id}"
                        ),
                    );
                    let _ = try_send(
                        state,
                        peer_id,
                        &Message::FileReject {
                            transfer_id: transfer_id.clone(),
                            received: held,
                        },
                    )
                    .await;
                    return;
                }
                file::OfferDecision::Accept | file::OfferDecision::AcceptResumeSegment => {
                    if active.is_some() {
                        // **重复的 offer 必须幂等接受**：对端没收到我们的 accept 时会重发同一个
                        // transfer_id，旧行为回 `FileReject("重复的文件传输")` ⇒ 对端判定失败、
                        // 停止重试 ⇒ 文件永远到不了（真机：大图两边都显示成功、接收侧列表里没有）。
                        let resumed = matches!(decided, file::OfferDecision::AcceptResumeSegment);
                        state.logger.info(
                            "file",
                            format!(
                                "重复的文件请求 ⇒ 幂等回 accept{} transfer={transfer_id}",
                                if resumed {
                                    "（续传段：段号归零）"
                                } else {
                                    ""
                                }
                            ),
                        );
                        // 段号归零：发送端续传时按段从 `seq = 0` 重编，而归零后那些**新数据**
                        // 会被 `write_chunk` 判成"迟到的重复片"静默丢掉 ⇒ 文件永远差一截。
                        // 判据（只有续传段才归零，`from_bytes = 0` 的重复 offer 不归零）在
                        // `file::decide_offer` 里 —— 那边写了为什么：无条件归零会把上一轮
                        // 还在排空的分片打成「跳号」，那是一整单死的另一种死法。
                        if resumed {
                            file::restart_segment(state, &transfer_id);
                        }
                        // Offer 是权威：它带来的轮次就是"当前轮次"，此后只有同轮次的
                        // 分片/完成帧会被处理（`file::frame_is_current`）。
                        file::note_offer_attempt(state, &transfer_id, attempt);
                        let _ = try_send(
                            state,
                            peer_id,
                            &Message::FileAccept {
                                transfer_id: transfer_id.clone(),
                            },
                        )
                        .await;
                        return;
                    }
                    // 位置对得上、且没有活跃接收器 ⇒ 落到下面照常建/续接收器。
                }
            }
            let received = if from_bytes > 0 {
                // ⚠️ 这一格交给阻塞线程池，与 4.39.3 的单聊收尾、4.40.1 的群收尾是同一条规矩，
                // 收的是 4.40.1 登记的 ②：`resume_receive` 要把 `.part` 前缀**整份**喂进校验器，
                // 而前缀最长就等于整个文件（本机实测这条流式 SHA-256 ≈ 1 GB/s ⇒ 3 GB 前缀就是
                // 约 3 秒，精简 Windows 的冷盘上还要再乘）。留在 async 路径上就是钉住一个
                // tokio worker，同一个 runtime 上还排着所有 async 命令（开设置窗 / 日志窗）
                // ⇒ 续传那几秒点了没窗，与问题 A 的已证实根因同一种病。
                //
                // 顺序一字未动：校验跑完才注册接收器、才回 Accept。本连接后面的分片在这期间
                // 本来就读不进来（全仓六处 handle_message 调用点都是就地 await，没有一处 spawn
                // 出去），所以"让出 worker"既不新开竞态窗口，也不改变发送端等到 Accept 的时长。
                let st = state.clone();
                let tid = transfer_id.clone();
                let from_owner = from.clone();
                let fname = name.clone();
                let sha = file_sha256.clone();
                tokio::task::spawn_blocking(move || {
                    file::resume_receive(&st, &tid, &from_owner, &fname, size, file_key, sha, from_bytes)
                })
                .await
                .unwrap_or_else(|e| Err(format!("续传校验任务被线程池中断: {e}")))
            } else {
                file::begin_receive(
                    state,
                    &transfer_id,
                    &from,
                    &name,
                    size,
                    file_key,
                    file_sha256.clone(),
                )
            };
            match received {
                Ok(_) => {
                    // 新建/续建的接收器一律以这份 Offer 的轮次为准（Offer 是权威，见
                    // `file::frame_is_current` 第 3 条）。
                    file::note_offer_attempt(state, &transfer_id, attempt);
                    // Phase 1：接收一开始就登记一条 Active 记录（cid → 暂无 path）。
                    // 中途断链 / 超时由 record_failure 标成 Incomplete ⇒ 建链时自动重取。
                    {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let now = db::now_ms();
                        let rec = crate::content::model::TransferRecord {
                            cid: file_sha256.clone(),
                            transfer_id: Some(transfer_id.clone()),
                            peer_id: from.clone(),
                            group_id: None,
                            name: name.clone(),
                            size,
                            direction: crate::content::model::Direction::Receive,
                            status: crate::content::model::TransferStatus::Active,
                            received: 0,
                            attempts: 0,
                            next_attempt_at: 0,
                            last_error: None,
                            path: None,
                            created_at: now,
                            updated_at: now,
                        };
                        let _ = crate::content::store::upsert(&dbc, &rec);
                    }
                    let _ = try_send(
                        state,
                        peer_id,
                        &Message::FileAccept {
                            transfer_id: transfer_id.clone(),
                        },
                    )
                    .await;
                    let _ = state.app.emit(
                        "file-progress",
                        &FileProgress {
                            transfer_id: transfer_id.clone(),
                            received: 0,
                            total: size,
                        },
                    );
                }
                Err(e) => {
                    let _ = try_send(
                        state,
                        peer_id,
                        &Message::FileReject {
                            transfer_id,
                            received: 0,
                        },
                    )
                    .await;
                    state
                        .logger
                        .error("file", format!("接收文件初始化失败: {e}"));
                }
            }
        }
        Message::FileAccept { transfer_id } => {
            if let Some(tx) = state
                .pending_file_accept
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&transfer_id)
            {
                let _ = tx.send(Ok(()));
            } else if log_throttled("file_accept_no_waiter", 5_000) {
                // ⚠️ 不静默（2026-10-13 真机第 7 条那轮审计点名的"关键异常被吞掉"）：
                // 这一支以前是 `if let Some(tx)` 没有 else ⇒ "对端回了 accept 而本机没有在等"
                // 这条事实在日志里**一个字都不留**。而它恰恰是区分两种死法的唯一读数：
                // ① 对端根本没答（链路/对端问题）；② 对端答了、但那台机器的入站循环正被
                // 上一次握手的 await 占着 ⇒ 应答读回来时等待者已经超时撤走（内容拉取自死锁就是这种）。
                // 只记 id 与 peer，不记任何正文；节流 5s 挡掉"整批迟到的应答"刷屏。
                state.logger.warn(
                    "file",
                    format!("收到 FileAccept 但本机没在等它，按迟到丢弃 transfer={transfer_id} peer={peer_id}"),
                );
            }
        }
        Message::FileReject {
            transfer_id,
            received,
        } => {
            if let Some(tx) = state
                .pending_file_accept
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&transfer_id)
            {
                // 把"接收端已持有多少字节"回给发送端 ⇒ 它从该偏移续发，无需重头。
                let _ = tx.send(Err(received));
            } else if log_throttled("file_reject_no_waiter", 5_000) {
                // 同 FileAccept 那一支：迟到的 reject 过去也是静默吞掉，而 reject 带着
                // 「对端实际持有多少字节」这个续传关键量 —— 丢了它就只能整份重灌，
                // 现场却读不出"丢过"。（`received` 是字节数，不是正文，可以进日志。）
                state.logger.warn(
                    "file",
                    format!(
                        "收到 FileReject 但本机没在等它，按迟到丢弃 transfer={transfer_id} peer={peer_id} received={received}"
                    ),
                );
            }
        }
        Message::FileCompleteAck {
            transfer_id,
            success,
        } => {
            // 只有该 transfer 的实际接收方发来的完成确认才有效。
            let expected_peer = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                dbc.query_row(
                    "SELECT peer_id FROM file_transfers WHERE id = ?1",
                    params![transfer_id],
                    |r| r.get::<_, String>(0),
                )
                .ok()
            };
            if expected_peer.as_deref() != Some(peer_id) {
                return;
            }
            if let Some(tx) = state
                .pending_file_complete
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&transfer_id)
            {
                let _ = tx.send(success);
            }
        }
        Message::FileChunk {
            transfer_id,
            seq,
            data,
            attempt,
        } => {
            // base64 解码 + AEAD 解密 + 增量 SHA-256 + 同步 `write_all`：整段离开 tokio worker
            // （10-22 审计 R-01 的一半）。`reader_loop` 与各条链路的入站帧读取共用这批 worker，
            // 慢盘上一个 256KB 分块的同步写就把这个 worker 按住 —— 表现是"传文件时整个界面一顿一顿"，
            // 连开窗一类的 IPC 也会排队（同一条 runtime）。
            //
            // ⚠️ 顺序没有被改掉：这条连接的分片本来就是**逐条 await** 处理的，这里只是把
            //    "在 worker 上同步做"换成"在阻塞池里做完再取下一条"，不是 fire-and-forget；
            //    所以「同一传输的分片必须串行」这条判据照旧成立（拆成并发才会丢块/乱序）。
            //    `file_receivers` 那把进程级锁**仍在**（那是另一半：改它要动 59+27 个引用点，
            //    且只有跨进程 E2E 能证，见审计报告 §E.2）。
            let st = state.clone();
            let tid = transfer_id.clone();
            let peer_owned = peer_id.to_string();
            let written = tokio::task::spawn_blocking(move || {
                STANDARD
                    .decode(&data)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| {
                        file::write_chunk(&st, &tid, &peer_owned, seq, &bytes, attempt)
                    })
            })
            .await
            // 阻塞池把这个任务丢掉（panic/取消）不能当"没发生"：那等于悄悄放弃这一单接收。
            // 交回 Err 走下面既有的失败分支 —— 判死接收器 + 回否定确认，发送端立刻知道。
            .unwrap_or_else(|e| Err(format!("文件分片处理任务被线程池中断: {e}")));
            match written {
                Ok(received) => {
                    // 节流：每 250ms 至多上报一次进度，避免大文件 IPC 事件风暴
                    let (total, should_emit) = {
                        let mut recv = state
                            .file_receivers
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        match recv.get_mut(&transfer_id) {
                            Some(r) => {
                                let now = db::now_ms();
                                let emit = now - r.last_report_ms >= 250;
                                if emit {
                                    r.last_report_ms = now;
                                }
                                (r.size, emit)
                            }
                            None => (0, false),
                        }
                    };
                    if should_emit {
                        let _ = state.app.emit(
                            "file-progress",
                            &FileProgress {
                                transfer_id: transfer_id.clone(),
                                received,
                                total,
                            },
                        );
                    }
                }
                Err(e) => {
                    // true = 本次真的中止了一个在途接收器（false = 早已中止/未知传输/来源不符，
                    // 再发通知只会重复）。**必须回否定确认**：旧行为是"判死但谁也不告诉"，
                    // 发送端于是把剩下的整份文件继续灌进一条已经死掉的传输，最后 FileDone
                    // 无人应答、干等一个 FILE_ACK_IDLE，再按"可重试"整发 5 次 —— 真机上
                    // 表现为两边都显示失败，而中间几十分钟界面上一直"发送中"。
                    if file::fail_receive(state, &transfer_id, peer_id, &e) {
                        if let Err(se) = try_send(
                            state,
                            peer_id,
                            &Message::FileCompleteAck {
                                transfer_id: transfer_id.clone(),
                                success: false,
                            },
                        )
                        .await
                        {
                            state.logger.error(
                                "file",
                                file::ack_send_failure_note(
                                    file::ACK_STAGE_CHUNK_ABORTED,
                                    &transfer_id,
                                    &se,
                                ),
                            );
                        }
                    }
                }
            }
        }
        Message::FileDone {
            transfer_id,
            attempt,
        } => {
            // 上一轮残留的完成帧：这一轮才刚开始，拿它去 finish_receive 会把整单
            // 判成"文件传输未完成"打死（或补一个莫须有的成功 Ack）。先按轮次挡掉。
            if !file::done_is_current(state, &transfer_id, attempt) {
                state.logger.info(
                    "file",
                    format!("丢掉非当前轮次的完成帧 transfer={transfer_id}"),
                );
                return;
            }
            match file::finish_receive(state, &transfer_id, peer_id).await {
                Err(e) => {
                    let _ = state.app.emit(
                        "file-failed",
                        &FileFailedInfo {
                            transfer_id: transfer_id.clone(),
                            reason: e,
                        },
                    );
                    if let Err(se) = try_send(
                        state,
                        peer_id,
                        &Message::FileCompleteAck {
                            transfer_id: transfer_id.clone(),
                            success: false,
                        },
                    )
                    .await
                    {
                        state.logger.error(
                            "file",
                            file::ack_send_failure_note(
                                file::ACK_STAGE_FINISH_FAILED,
                                &transfer_id,
                                &se,
                            ),
                        );
                    }
                }
                Ok(None) => {
                    // 重复 FileDone：若本机此前已成功完成该 transfer，则补一个成功确认，
                    // 避免发送方因重试而一直等待。
                    let already_done = {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        db::is_transfer_done(&dbc, &transfer_id).unwrap_or(false)
                    };
                    if already_done {
                        if let Err(se) = try_send(
                            state,
                            peer_id,
                            &Message::FileCompleteAck {
                                transfer_id: transfer_id.clone(),
                                success: true,
                            },
                        )
                        .await
                        {
                            state.logger.error(
                                "file",
                                file::ack_send_failure_note(
                                    file::ACK_STAGE_DUP_DONE,
                                    &transfer_id,
                                    &se,
                                ),
                            );
                        }
                    } else {
                        // 接收器已清且库非 done（接收态被 TTL 回收 / 本机从未接受该
                        // 传输）：也必须回一帧失败确认（2026-09-23 审计 A5）—— 旧实现
                        // 这里静默，发送端收不到任何帧只能干等静默窗口超时。立刻拿到
                        // 失败终态才不会白等；发送端只认 file_transfers 里登记的
                        // peer_id，伪造面不变。
                        if let Err(se) = try_send(
                            state,
                            peer_id,
                            &Message::FileCompleteAck {
                                transfer_id: transfer_id.clone(),
                                success: false,
                            },
                        )
                        .await
                        {
                            state.logger.error(
                                "file",
                                file::ack_send_failure_note(
                                    file::ACK_STAGE_NO_RECEIVER,
                                    &transfer_id,
                                    &se,
                                ),
                            );
                        }
                    }
                }
                Ok(Some((name, size, path, sender_id))) => {
                    let rec = {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let subtype = file::classify_file_subtype(&name);
                        // 与发送端同口径（`commands::send_file`，4.22.1 起；现为 send_file_auto 的私有实现）：kind 只区分
                        // image|file，细分留 content.subtype —— 接收端不再按文件名
                        // 重新猜一遍（旧写法把 mp4 标成 kind="video"，前端渲染链
                        // 不认，气泡整个退化成 JSON；真机 2026-09-19）。
                        let kind = if subtype == "image" { "image" } else { "file" };
                        let mut content = serde_json::json!({
                            "name": name,
                            "path": path.to_string_lossy().to_string(),
                            "size": size,
                            "subtype": subtype,
                        });
                        if kind == "image" {
                            file::attach_image_size(&mut content, &path);
                        }
                        let content = content.to_string();
                        let seq = db::next_clock(&dbc, &sender_id).unwrap_or(1);
                        let rec = MessageRecord {
                            fail_code: None,
                            id: 0,
                            msg_id: format!("file-{transfer_id}"),
                            conv_id: sender_id.clone(),
                            sender_id: sender_id.clone(),
                            receiver_id: state.device_id.clone(),
                            kind: kind.to_string(),
                            content,
                            ts: db::now_ms(),
                            seq,
                            status: "delivered".to_string(),
                            mention_targets: None,
                            local_id: None,
                        };
                        // 落库失败必须留痕（审计 2026-10-16）：吞掉后界面没这张文件卡、日志无痕。
                        if let Err(e) = db::insert_message(&dbc, &rec) {
                            state.logger.error(
                                "file",
                                format!("单聊文件卡片落库失败 msg={}：{e}", rec.msg_id),
                            );
                        }
                        drop(dbc);
                        let nm = resolve_nickname(state, &sender_id);
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let preview = if kind == "image" {
                            "[图片]".to_string()
                        } else {
                            format!("[文件] {name}")
                        };
                        db::touch_conversation(&dbc, &sender_id, "single", &nm, None, &preview, 1)
                            .ok();
                        rec
                    };
                    let _ = state.app.emit("message-received", &rec);
                    let _ = state.app.emit(
                        "file-done",
                        &FileDoneInfo {
                            transfer_id: transfer_id.clone(),
                            name: name.clone(),
                            size,
                            path: path.to_string_lossy().to_string(),
                        },
                    );
                    if let Err(se) = try_send(
                        state,
                        peer_id,
                        &Message::FileCompleteAck {
                            transfer_id: transfer_id.clone(),
                            success: true,
                        },
                    )
                    .await
                    {
                        state.logger.error(
                            "file",
                            file::ack_send_failure_note(
                                file::ACK_STAGE_COMPLETED,
                                &transfer_id,
                                &se,
                            ),
                        );
                    }
                }
            }
        }
        // ── 对端取消了这一单（B3：`FileCancel` 帧）───────────────────────────
        // 语义与"本机用户点了取消"**完全相同** ⇒ 走同一个入口
        // `commands::files::apply_local_cancel`，落同一格终态（INV-P26 里"取消"这一档的
        // 第二种来源），这里**不**再抄一份收尾 —— 两处各写一遍就是上一批点过名的漂移形状。
        //
        // 多做的只有一件 `FileCompleteAck` 那支早就做了的事：**认人**。
        // 只接受"台账里这一单的那个对端"发来的取消；否则链路上任何一台设备凭一个
        // 猜到的 transfer_id 就能把别人的传输打死（transfer_id 不是秘密）。
        // 读 route 的那把锁必须在 await 之前放开 —— 收尾里有 emit，持锁 emit 是禁的。
        Message::FileCancel { transfer_id, from } => {
            let route = {
                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                db::get_transfer_route(&dbc, &transfer_id)
            };
            let Some((direction, peer)) = route else {
                if log_throttled("file_cancel_no_ledger", 5_000) {
                    state.logger.warn(
                        "file",
                        format!("收到 FileCancel 但本机没有这一单的台账，丢弃 transfer={transfer_id} peer={peer_id}"),
                    );
                }
                return;
            };
            if from != peer || peer != peer_id || from == state.device_id {
                if log_throttled("file_cancel_wrong_peer", 5_000) {
                    state.logger.warn(
                        "file",
                        format!(
                            "收到 FileCancel 但发它的人不是这一单的对端，丢弃 transfer={transfer_id} frame_from={from} ledger_peer={peer} link_peer={peer_id}"
                        ),
                    );
                }
                return;
            }
            let res = crate::commands::apply_local_cancel(state, &transfer_id, "peer").await;
            state.logger.info(
                "file",
                format!(
                    "对端取消了这一单，本机按已取消收尾 transfer={transfer_id} dir={direction} already_done={}",
                    res.already_done
                ),
            );
        }
        _ => {}
    }
}
