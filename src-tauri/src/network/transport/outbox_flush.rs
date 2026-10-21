// 单聊 / 群聊离线队列的补发：**只补发不删行**，收到 Ack / GroupAck 才删对应行。
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。

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
    for (id, payload) in pending {
        let msg = match serde_json::from_str::<Message>(&payload) {
            Ok(m) => m,
            Err(e) => {
                // 坏载荷永远发不出去；不删行，交给清扫器按超时落 failed（行还在 = 可见）。
                state.logger.error(
                    "outbox",
                    format!(
                        "code=OUTBOX_PAYLOAD_CORRUPT peer={peer_id} outbox_id={id} err={e} \
                         —— 保留行，等清扫器落终态"
                    ),
                );
                continue;
            }
        };
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
