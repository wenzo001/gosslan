// 单聊 / 群聊离线队列的补发：**只补发不删行**，收到 Ack / GroupAck 才删对应行。
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。

/// outbox 行载荷（Block 2）：同一行里同时存**直连帧**与**跨跳信封**。
///
/// 为什么不是一个 `Message`（两条路径的要求是冲突的）：
/// - 直连补发要 `reseal_for_send`：对端换过身份时用**当前**公钥重封，`ChatMessage`
///   的 `msg_id` 是显式字段 ⇒ 密文变了但 id 不变，对端仍按 id 幂等；
/// - 跨跳补发必须**原样重发签名信封**：`message_id = sha256(sender + nonce + payload)`，
///   一旦重新签名/重新加密，id 就变了 ⇒ 对端会把它当成**另一条消息**（重复入库 + 重复 ACK）。
///
/// 所以两份都要留。老版本写的裸 `Message` 行仍能解析（见 [`parse_outbox_payload`]），
/// 只是那类行没有可信赖的信封，跨跳补发不猜、不重建（重建就是换 id）。
#[derive(serde::Serialize, serde::Deserialize)]
pub struct OutboxPayload {
    pub direct: Message,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<GossipEnvelope>,
}

/// 解析 outbox 载荷：新形状（`{direct, relay}`）优先，老行（裸 `Message`）回落。
pub fn parse_outbox_payload(payload: &str) -> Option<OutboxPayload> {
    if let Ok(v2) = serde_json::from_str::<OutboxPayload>(payload) {
        return Some(v2);
    }
    serde_json::from_str::<Message>(payload)
        .ok()
        .map(|direct| OutboxPayload {
            direct,
            relay: None,
        })
}

/// 跨跳补发（Block 2）：**只对没有直连链路的 peer**，把 outbox 里存的那份签名信封
/// 原样交给 `broadcast_gossip`，由网格层按信封的 `target` 定向投递。
///
/// 调度口径（用户定的"15s×8"）：由 `spawn_outbox_retrier` 每
/// `OUTBOX_RELAY_INTERVAL_SECS`(15s) 驱动一轮；120s 的
/// `OUTBOX_FAIL_DEADLINE_MS` 恰好容纳 8 轮。**同一个 peer 的并发上限是 1** ——
/// 驱动它的是一条顺序循环（不 spawn 子任务），天然不会对同一行并发重投。
///
/// 幂等性（验收点）：信封含 `nonce`，原样重发 ⇒ `message_id` 不变 ⇒ 对端
/// `gossip.is_new()` 判重 ⇒ **不重复入库**；重复副本被丢时也不会再发一次 ACK，
/// 而首份的 ACK 已经让发送方删掉了这一行。
///
/// 直连路径（`flush_outbox`，5s）一行不动：有链路就走那边，这条路只补"永远等不到
/// 直连"的那一类 peer（现场 RC-3：无直连时 send_message 只广播一次，之后没人再试）。
pub async fn flush_outbox_via_relay(state: &AppState, peer_id: &str) {
    if state.has_link(peer_id).await {
        return; // 直连路径已经在补，别让两条路径对同一行同时施压
    }
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_outbox(&dbc, peer_id)
    };
    let pending = match pending {
        Ok(v) => v,
        Err(e) => {
            state.logger.error(
                "outbox",
                format!("code=OUTBOX_RELAY_READ_FAILED peer={peer_id} err={e} —— 本轮跨跳补发跳过"),
            );
            return;
        }
    };
    let peer_features = state
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(peer_id)
        .copied();
    for (id, msg_id, payload) in pending {
        let parsed = match parse_outbox_payload(&payload) {
            Some(p) => p,
            None => {
                // 与直连路径同一口径：坏载荷不删行，交给清扫器落终态（行还在 = 可见）
                state.logger.error(
                    "outbox",
                    format!(
                        "code=OUTBOX_PAYLOAD_CORRUPT peer={peer_id} outbox_id={id} \
                         —— 保留行，等清扫器落终态"
                    ),
                );
                continue;
            }
        };
        let Some(envelope) = parsed.relay else {
            // 老队列行只有直连帧：**不重建信封**（重建会换 message_id ⇒ 对端重复入库）。
            if log_throttled("outbox_relay_no_envelope", 30_000) {
                state.logger.warn(
                    "outbox",
                    format!(
                        "code=OUTBOX_RELAY_NO_ENVELOPE peer={peer_id} msg_id={msg_id} outbox_id={id} \
                         —— 该行没有跨跳信封（老版本入队），只能等直连"
                    ),
                );
            }
            continue;
        };
        // 能力协商与直连同一判据：Hold 就留着等握手；Unsupported 不硬发，交给清扫器落终态。
        let (kind, extra_required) = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::message_gating(&dbc, &msg_id).unwrap_or_default()
        };
        match crate::protocol::deferred_send_decision_extra(&kind, peer_features, extra_required) {
            crate::protocol::DeferredSend::Hold => {
                if log_throttled("outbox_relay_capability_hold", 30_000) {
                    state.logger.info(
                        "outbox",
                        format!(
                            "code=OUTBOX_RELAY_HOLD peer={peer_id} msg_id={msg_id} \
                             reason=capability_pending —— 保留队列行，等对端握手"
                        ),
                    );
                }
                continue;
            }
            crate::protocol::DeferredSend::Unsupported => continue,
            crate::protocol::DeferredSend::Send => {}
        }
        broadcast_gossip(state, envelope).await;
        // 一行读数：跨跳到底试过几次、试的哪条（今天缺的就是这个）
        state.logger.info(
            "outbox",
            format!(
                "code=OUTBOX_RELAY_SENT peer={peer_id} msg_id={msg_id} outbox_id={id} \
                 —— 无直连链路，经网格定向重投（信封原样，message_id 不变）"
            ),
        );
    }
}


/// 补发离线队列中的所有消息。
///
/// 注意：这里**只补发、不删除**——outbox 行仅在收到对方 `Ack`（真正确认送达）时删除。
/// 旧实现 `try_send` 返回 Ok（仅表示已入发送队列）就删行，半开 TCP 链路上会静默丢消息，
/// outbox 兜底因此失效。接收方按 msg_id 去重，重复补发不会重复入库/通知。
///
/// 每条补发前用**当前**公钥重新密封（见 `reseal_for_send`）：outbox 存的是加密时刻的
/// 密文，若之后接收方换了身份，旧密文重发多少次都解不开；`msg_id` 不变，幂等性不受影响。
pub async fn flush_outbox(state: &AppState, peer_id: &str) {
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_outbox(&dbc, peer_id)
    };
    let pending = match pending {
        Ok(v) => v,
        Err(e) => {
            // 读失败不许折成"没有待发消息"：那会让这一轮补发静默缺席、也没有任何读数。
            state.logger.error(
                "outbox",
                format!("code=OUTBOX_FLUSH_READ_FAILED peer={peer_id} err={e} —— 本轮补发跳过"),
            );
            return;
        }
    };
    let peer_features = state
        .peer_content_features
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(peer_id)
        .copied();
    for (id, msg_id, payload) in pending {
        // 能力协商要业务 kind（外加载荷里的抖动位），而 GossipEnvelope 加密后看不出它 ⇒
        // 只能问落库那一行。查不到（消息已被清理 / 老队列行）就按"不需要能力位"放行，
        // 与升级前一致。读不到元数据绝不能成为判死理由。
        let (kind, extra_required) = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::message_gating(&dbc, &msg_id).unwrap_or_default()
        };
        let msg = match parse_outbox_payload(&payload) {
            Some(p) => p.direct,
            None => {
                // 坏载荷永远发不出去；不删行，交给清扫器按超时落 failed（行还在 = 可见）。
                state.logger.error(
                    "outbox",
                    format!(
                        "code=OUTBOX_PAYLOAD_CORRUPT peer={peer_id} outbox_id={id} \
                         —— 保留行，等清扫器落终态"
                    ),
                );
                continue;
            }
        };
        // 能力协商（5.16.92「先入队、后协商」）：判据只有
        // `protocol::deferred_send_decision(_extra)`。
        // - `Unsupported`：对端**自己声明过**不支持 ⇒ 落终态 + 删行 + emit，绝不硬发；
        // - `Hold`：能力未知（离线 / 从没握手）⇒ 本轮跳过，**行留着**等下次建链/心跳，
        //   兑现「离线先入队、建链后补发」；
        // - `Send`：照常补发。
        match crate::protocol::deferred_send_decision_extra(
            &kind,
            peer_features,
            extra_required,
        ) {
            crate::protocol::DeferredSend::Unsupported => {
                let finalized = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::finalize_blocked_message(
                        &dbc,
                        &msg_id,
                        crate::error_codes::SEND_KIND_UNSUPPORTED,
                        false,
                    )
                };
                match finalized {
                    Ok(true) => {
                        let _ = state.app.emit(
                            "message-failed",
                            &MessageFailedInfo {
                                msg_id: msg_id.clone(),
                                fail_code: crate::error_codes::SEND_KIND_UNSUPPORTED.to_string(),
                            },
                        );
                        state.logger.warn(
                            "outbox",
                            format!(
                                "code=SEND_KIND_UNSUPPORTED peer={peer_id} msg_id={msg_id} \
                                 outbox_id={id} action=failed（对端已声明不支持该 kind）"
                            ),
                        );
                    }
                    Ok(false) => {}
                    Err(e) => state.logger.error(
                        "outbox",
                        format!(
                            "code=OUTBOX_FINALIZE_FAILED peer={peer_id} msg_id={msg_id} err={e} \
                             —— 保留行，等清扫器按超时落终态"
                        ),
                    ),
                }
                continue;
            }
            crate::protocol::DeferredSend::Hold => {
                if log_throttled("outbox_capability_hold", 30_000) {
                    state.logger.info(
                        "outbox",
                        format!(
                            "code=SEND_DEFERRED peer={peer_id} msg_id={msg_id} outbox_id={id} \
                             reason=capability_pending —— 保留队列行，等对端上线/握手"
                        ),
                    );
                }
                continue;
            }
            crate::protocol::DeferredSend::Send => {}
        }
        let msg = reseal_for_send(state, msg);
        if let Err(e) = try_send(state, peer_id, &msg).await {
            if log_throttled("outbox_resend_fail", 30_000) {
                state.logger.warn(
                    "outbox",
                    format!(
                        "code=OUTBOX_RESEND_FAILED peer={peer_id} outbox_id={id} err={e} \
                         —— 保留队列行，等待下一次建链/心跳"
                    ),
                );
            }
        }
    }
}

/// 补发指定成员的群消息离线队列。
///
/// 与单聊 outbox 同一语义：**只补发、不删除**，GroupAck 到达才删除对应行。
/// Gossip 信封在发送时已经签名，重发无需重新签名，接收方按 msg_id 幂等去重。
pub async fn flush_group_outbox(state: &AppState, peer_id: &str) {
    let pending = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_group_outbox(&dbc, peer_id)
    };
    let pending = match pending {
        Ok(v) => v,
        Err(e) => {
            state.logger.error(
                "outbox",
                format!("code=GROUP_OUTBOX_FLUSH_READ_FAILED peer={peer_id} err={e} —— 本轮补发跳过"),
            );
            return;
        }
    };
    for (id, payload) in pending {
        let envelope = match serde_json::from_str::<Message>(&payload) {
            Ok(Message::Gossip { envelope }) => envelope,
            Ok(_) => {
                state.logger.error(
                    "outbox",
                    format!("code=GROUP_OUTBOX_PAYLOAD_NOT_GOSSIP peer={peer_id} outbox_id={id}"),
                );
                continue;
            }
            Err(e) => {
                state.logger.error(
                    "outbox",
                    format!(
                        "code=GROUP_OUTBOX_PAYLOAD_CORRUPT peer={peer_id} outbox_id={id} err={e} \
                         —— 保留行，等清扫器落终态"
                    ),
                );
                continue;
            }
        };
        if let Err(e) = try_send(state, peer_id, &Message::Gossip { envelope }).await {
            if log_throttled("group_outbox_resend_fail", 30_000) {
                state.logger.warn(
                    "outbox",
                    format!(
                        "code=GROUP_OUTBOX_RESEND_FAILED peer={peer_id} outbox_id={id} err={e} \
                         —— 保留队列行，等待下一次建链/心跳"
                    ),
                );
            }
        }
    }
}
