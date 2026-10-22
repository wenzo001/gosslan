// 职责边界：
// - 一对一聊天（send_message、会话查询、已读）
// - 消息删除、合并转发
// ⚠️ **撤回与重发不在这里**（2026-09-25 删掉了 `recall_message` / `resend_message` /
// `cancel_send` —— 前端一次都没调过）：撤回只有群聊版（`group_announcements.rs`），
// 界面上的「重发」是 `chat.send` 重发一条**新消息**。
// 重做「按原 msg_id 重投」前必读 docs/protocol-invariants.md §6 那两条事故规则。
// ---------------- 单聊（Gossip + E2EE） ----------------

/// 撤回一条自己发的 1:1 消息（仅原作者；5 分钟窗口只在发送端强制）。
///
/// 复用公开的 `send_message(..., "recall")` 走完整的 E2EE / outbox / 幂等管道；
/// 事件先入可靠队列，成功后再物化本地 —— 顺序反了会出现「本地已撤回、对端没收到」。
#[tauri::command(async)]
pub async fn recall_message(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    target: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    if friend_id == s.device_id {
        return Err("不能撤回自己会话里的消息".to_string());
    }
    // SQLite 读写交给阻塞池：`#[tauri::command(async)]` 的整段函数体在 tokio worker 上，
    // 直接持锁等 DB 会占住一个 worker（worker 数 = CPU 核数，传文件时会让开窗也白等）。
    let s_db = s.clone();
    let target_db = target.clone();
    let friend_db = friend_id.clone();
    let already_recalled = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
        let Some(msg) = db::get_message_record(&dbc, &target_db) else {
            return Err("消息不存在".to_string());
        };
        crate::protocol::recall_verdict(
            &msg.sender_id,
            &s_db.device_id,
            &msg.conv_id,
            &friend_db,
            msg.ts,
            db::now_ms(),
        )?;
        Ok(db::is_recalled(&dbc, &target_db))
    })
    .await
    .map_err(|e| format!("撤回校验被线程池中断: {e}"))??;
    if already_recalled {
        return Ok(()); // 幂等：已撤回过就直接成功
    }
    let payload = crate::protocol::RecallPayload {
        target: target.clone(),
    };
    let content = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    // 先发可靠事件（send_message 内部会做好友/目标/能力位校验并写 outbox）。
    send_message(state, friend_id.clone(), content, "recall".to_string()).await?;
    let s_db = s.clone();
    let target_db = target.clone();
    let friend_db = friend_id.clone();
    tokio::task::spawn_blocking(move || {
        let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
        let seq = db::get_clock(&dbc, &friend_db);
        db::insert_recall(&dbc, &friend_db, &target_db, &s_db.device_id, seq).ok();
        db::materialize_recall(&dbc, &target_db).ok();
    })
    .await
    .map_err(|e| format!("撤回物化被线程池中断: {e}"))?;
    let _ = s.app.emit("message-recalled", &target);
    Ok(())
}

#[tauri::command(async)]
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
    content: String,
    kind: String,
) -> Result<MessageRecord, String> {
    let s = state.inner();

    // 「和自己聊天」分流：target 是自己时走**纯本地路径**（见 `insert_self_message`）。
    // 放在最前面是有意的 —— 下面每一步（好友校验 / 公钥查找 / 加密 / outbox / gossip）
    // 对自己都不成立。
    if friend_id == s.device_id {
        return insert_self_message(s, &kind, content);
    }

    let msg_kind = match kind.as_str() {
        "text" => MsgKind::Text,
        "code" => MsgKind::Code,
        "file" => MsgKind::File,
        // 合并转发：载荷先过校验（能解析、条数合法），别等到对方那边才炸。
        "merge" => {
            crate::protocol::parse_merge_payload(&content)?;
            MsgKind::Merge
        }
        // 表情回应：和 merge 同构的"载荷先在这里过一遍"，畸形载荷不该变成
        // 对端一条折不出来的事件（见 protocol::parse_reaction_payload）。
        "reaction" => {
            crate::protocol::parse_reaction_payload(&content)?;
            MsgKind::Reaction
        }
        // 强提醒发起 / 回执：载荷先过校验；1:1 门控在下面统一处理。
        "remind" => {
            crate::protocol::parse_remind_payload(&content)?;
            MsgKind::Remind
        }
        "remind_ack" => {
            crate::protocol::parse_remind_ack_payload(&content)?;
            MsgKind::RemindAck
        }
        // 撤回：载荷先过校验；目标/作者/窗口在下面的 DB 块与专用命令里再判。
        "recall" => {
            crate::protocol::parse_recall_payload(&content)?;
            MsgKind::Recall
        }
        _ => return Err("不支持的消息类型".to_string()),
    };

    // 好友关系检查：必须优先于公钥查找
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        if db::get_friend(&dbc, &friend_id).is_none() {
            return Err("对方不是好友，请先扫描添加好友之后再继续聊天。".to_string());
        }
        // 强提醒的目标真实性（与群内核 group_files.rs 同一条例）：
        // remind 指向的原消息、remind_ack 指向的 remind 行都必须真实存在于本会话，
        // 否则对方点开通知只会定位到"幽灵消息"。
        match kind.as_str() {
            "remind" => {
                let p = crate::protocol::parse_remind_payload(&content)?;
                let valid = db::get_message_record(&dbc, &p.target)
                    .map(|m| m.conv_id == friend_id)
                    .unwrap_or(false);
                if !valid {
                    return Err("要提醒的消息不存在".to_string());
                }
            }
            "remind_ack" => {
                let p = crate::protocol::parse_remind_ack_payload(&content)?;
                let valid = db::get_message_record(&dbc, &p.target)
                    .map(|m| m.conv_id == friend_id && m.kind == "remind")
                    .unwrap_or(false);
                if !valid {
                    return Err("对应的强提醒不存在".to_string());
                }
            }
            "recall" => {
                let p = crate::protocol::parse_recall_payload(&content)?;
                let Some(msg) = db::get_message_record(&dbc, &p.target) else {
                    return Err("要撤回的消息不存在".to_string());
                };
                crate::protocol::recall_verdict(
                    &msg.sender_id,
                    &s.device_id,
                    &msg.conv_id,
                    &friend_id,
                    msg.ts,
                    db::now_ms(),
                )?;
            }
            _ => {}
        }
    }

    // 长度保护：text/code 等普通内容超限直接报错（UTF-8 安全，按字符数计）。
    let content = check_message_content(content)?;

    // INV-P24 第 4 条：**不门控不许发**。老对端（v4.20.0 及更早）的 `ChatMessage.kind`
    // 还是嵌套枚举，收到不认识的 kind 会**整帧丢掉** —— v4.22.34 只修了我们这一侧的容忍，
    // 那边没有，所以只能由发送侧挡下来，并给用户一句能照着做的话。
    // 判据只有 `protocol::dm_required_features` / `dm_allowed_by_features` 一处（1:1 侧它还额外
    // 要求对端具备"能吃任意 wire kind"的声明位，见那两个函数的说明）；对端从没交换过 Hello 或已离线
    // ⇒ 位图按 0 处理 = "不知道就当不支持"（宁可少发一条，也不要静默丢帧）。
    // 但"不知道"与"它自己声明过不支持"要分开说：这张表是内存态、离线就被 sweep 回收，
    // 所以缺条目绝大多数时候只意味着对方此刻不在线，把两种情况混成一句"版本较旧"是假指控
    // （文案本身仍只住在 `protocol.rs`，这里只做选择）。
    // 放在公钥探测**之前**：这条本来就不会发出去，不该再触发一次 who_has 探测白等 1.2s。
    if crate::protocol::dm_required_features(&kind) != 0 {
        let peer_features = s
            .peer_content_features
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&friend_id)
            .copied();
        if !crate::protocol::dm_allowed_by_features(&kind, peer_features.unwrap_or(0)) {
            return Err(crate::protocol::kind_blocked_hint(&kind, peer_features));
        }
    }

    // E2EE 恒开（v0.11.0 起默认且不可关闭）：发送必须拿到对端 X25519 公钥。
    // 好友表优先，回退在线节点表；都缺失时主动探测一次（who_has）等对方/中继
    // announce 落库（约 1.2s）后再查，仍缺失则报错指引。
    let pubkey = {
        let from_db = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_friend_x25519(&dbc, &friend_id)
        };
        let from_peers = s
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&friend_id)
            .and_then(|p| p.x25519_pubkey.clone());
        // ⚠️ 库里那把**优先**，而它一旦是错的就一直是错的（好友表只填空、绝不覆盖，
        // 见 `db/friends.rs` 与 `network/transport/e2ee_payload.rs` 同一条说明）。
        // 两份都在且不同 ⇒ 本机正在用的这把，**不是**界面那串安全码所依据的那一份
        // ⇒ 「双方安全码对得上」这时并不能证明消息解得开。
        // 没有这一行时，"我发的他收不到"在发送端日志里完全 invisible：对端解不开是不回
        // 送达确认的静默丢弃，本机只会一直显示"已发送"（用户 2026-10-13 撞的正是这个形状）。
        // 只报布尔量与 peer，不报密钥本身（日志会进报告产物）。持续不一致时每条发送各记一行。
        if let (Some(db_key), Some(peer_key)) = (&from_db, &from_peers) {
            if db_key != peer_key {
                s.logger.warn(
                    "dispatch",
                    format!("单聊密封用的密钥与在线自报的不一致（取库里那把）peer={friend_id}"),
                );
            }
        }
        match from_db.or(from_peers) {
            Some(k) => Some(k),
            None => {
                let triggered =
                    if let Some(tx) = s.probe.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                        let next = tx.borrow().saturating_add(1);
                        let _ = tx.send(next);
                        true
                    } else {
                        false
                    };
                if triggered {
                    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                }
                let again_db = {
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::get_friend_x25519(&dbc, &friend_id)
                };
                let again_peers = s
                    .peers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&friend_id)
                    .and_then(|p| p.x25519_pubkey.clone());
                again_db.or(again_peers)
            }
        }
    };
    let Some(pubkey) = pubkey else {
        return Err(format!(
            "尚未获取 {friend_id} 的公钥：对方可能离线或处于不同子网，请让对方上线后重试"
        ));
    };

    let ts = db::now_ms();
    let seq = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &friend_id).map_err(|e| format!("逻辑时钟推进失败：{e}"))?
    };
    let name = resolve_nickname(s, &friend_id);
    let preview = crate::protocol::preview_text(&kind, &content);

    // E2EE 加密 + Gossip 信封（先于本地落库：msg_id 三处统一用 Gossip 信封 ID）
    // 1:1 没有 @，恒传 None —— 但走**同一个**编码器：明文形状两处各写一份，
    // 迟早只改对一边（接收端是同一只函数解的）。
    let plaintext = crate::protocol::gossip_plaintext(&kind, &content, None);
    let shared = crypto::shared_secret(&s.identity.x25519_secret, &pubkey).ok_or("密钥交换失败")?;
    // Gossip 载荷与直发内容都走 ChaCha20-Poly1305（直发内容加 "enc1:" 前缀标识）
    let sealed = crypto::seal(&shared, plaintext.as_bytes()).ok_or("加密失败")?;
    let sealed_content = crypto::seal(&shared, content.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let wire_content = format!("enc1:{}", STANDARD.encode(&sealed_content));
    let mut env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Chat,
            None,
            None,
            &payload_b64,
            ts,
            seq,
        )
    };
    // 信封 encrypted 默认 true（build_envelope 内置），无需改写
    // 统一 msg_id：本地记录 / Gossip 投递 / outbox 补发共用同一确定性 ID，
    // 接收方 message_exists 跨路径去重（防建链竞态窗口内的重复投递）。
    let msg_id = env.message_id.clone();
    // 单聊定向：target = 接收方。中间节点按 target 定向转发（一跳精确，无路由表时洪泛
    // 兜底），直连场景不再全网广播（消除广播放大）。target 参与 signing_bytes，必须重签。
    env.target = Some(friend_id.clone());
    env.sender_sig = s.identity.sign_b64(&env.signing_bytes());

    // 本地落库（明文）
    // 初始状态 = "sending"：消息刚写库、正在入发送队列。
    // try_send 成功（进 mpsc channel）后前进到 "sent"；
    // Ack 到达 → "delivered"；ReadReceipt → "read"。
    // 超时 / 主动取消 → "failed" / "cancelled"（见 P2/P3）。
    let rec = MessageRecord {
        id: 0,
        msg_id: msg_id.clone(),
        conv_id: friend_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: friend_id.clone(),
        kind: kind.clone(),
        content: content.clone(),
        ts,
        seq,
        status: "sending".to_string(),
        mention_targets: None,
    };
    // 一律写离线队列兜底（INSERT OR IGNORE 按 msg_id 幂等）：直连链路存在但已失效
    // （半开 TCP）时 broadcast 会静默丢包，此前只在「无链路」时入队导致消息永久丢失。
    // Ack 到达后由 transport.rs 删除该行；若链路中断，对方上线建链（Hello）或心跳
    // 会触发 flush_outbox 自动补发，接收方按 msg_id 去重不会重复入库。
    let queued = Message::ChatMessage {
        msg_id: msg_id.clone(),
        from: s.device_id.clone(),
        to: friend_id.clone(),
        // 线格式是字符串（见 `ChatMessage::kind`）；发送侧仍只产出 `MsgKind` 的词表。
        kind: msg_kind.as_str().to_string(),
        content: wire_content,
        ts,
        seq,
    };
    let payload = serde_json::to_string(&queued).map_err(|e| e.to_string())?;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::insert_message_and_outbox(&dbc, &rec, &friend_id, &payload)
            .map_err(|e| format!("消息写入失败：{e}"))?;
        if crate::protocol::is_non_notifying_kind(&kind) {
            // 静默事件（表情回应…）不改预览、不顶会话 —— 与群内核同一条例
            // （commands/window.rs 里那条）。漏掉它的症状不是报错，是"回个表情把这条会话
            // 顶到列表最前、摘要变成一段 JSON"，所以必须在这里分叉而不是在前端过滤。
            // 会话行仍要确保存在：本机可能从没在这条会话里发过内容（例如先回应对端最后一条）。
            db::ensure_conversation(&dbc, &friend_id, "single", &name, None)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        } else {
            db::touch_conversation(&dbc, &friend_id, "single", &name, None, &preview, 0)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        }
    }

    // 先入队再投递（INV-003）：此前 broadcast 在插队之前，若心跳的 flush_outbox 正好
    // 落在这个窗口，它看不到 outbox 行 ⇒ 这一轮直发缺席 ⇒ Ack 要等下一个心跳（+5s）。
    // 定向投递：目标直连 → 只发它（精确，不再全网广播）；否则广播，靠中间节点按 target
    // 定向转发（跨跳）。投递失败**不返回 Err**：消息已落 outbox 兜底，链路刚断的竞态
    // 下由 flush_outbox 在下次建链/心跳时补发，返回 Err 会让前端误判「发送失败」而重发。
    //
    // 状态前进：try_send 成功（进 writer_loop channel）→ "sent"；
    // 广播模式无条件乐观前进（广播是尽力而为，视为已发出）；
    // try_send 失败则保持 "sending"（在 outbox 等下次 flush_outbox 重试）。
    let has = s.has_link(&friend_id).await;
    s.logger.info(
        "dispatch",
        format!(
            "[SEND-MSG] has_link={has} peer={friend_id} msg_id={msg_id} \
             (links_table_entries={})",
            s.links.lock().await.len()
        ),
    );
    let try_ok = if has {
        let r = try_send(s, &friend_id, &Message::Gossip { envelope: env.clone() })
            .await
            .is_ok();
        s.logger.info(
            "dispatch",
            format!("[SEND-MSG] try_send result={r} peer={friend_id}"),
        );
        r
    } else {
        s.logger.warn(
            "dispatch",
            format!(
                "[SEND-MSG] NO-LINK → broadcast_gossip peer={friend_id} (links table empty!)"
            ),
        );
        broadcast_gossip(s, env).await;
        true // 广播视为乐观已发出
    };
    if try_ok {
        // poison-tolerant（全仓纪律）：锁中毒时静默跳过 = 状态停在 sending，
        // 与 resend 的卡死同形（审计 2.3m）；中毒也要前进到 sent。
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::set_message_status(&dbc, &msg_id, "sent");
    }
    // 更新会话「当前链路」（发送方视角）：有直连则 hop=0 + 出站路径；无直连
    // （经中继广播）则乐观记 hop=1（实际跳数发送方不可知，等对端回执侧视角校正）。
    {
        let hop = if s.has_link(&friend_id).await { 0 } else { 1 };
        let path = crate::network::transport::inbound_path_kind(s, &friend_id).await;
        crate::network::transport::update_conv_link(s, &friend_id, &path, hop);
    }

    Ok(rec)
}

// INV-EXCEPTION: INV-P03, INV-P04 — 自聊收发双方都是本机，没有对端可等 Ack：
// 落库即终态 `read`（跳过 queued→sending→waiting_ack→delivered），且**不写 outbox**
// （那一行永远排不掉，反把「outbox 必然排空」破掉）。
// 登记在 docs/protocol-invariants.md §22，由 scripts/check-invariant-exceptions.mjs 双向校验。
/// 给自己发一条消息（「和自己聊天」）—— **纯本地，消息不出本机**。
///
/// 为什么必须是独立路径，而不是"把自己当好友"复用下面的发送流程：
///
/// 1. **没有传输**：收发双方都是本机 ⇒ 没有链路可发、没有对端公钥可用。
///    E2EE 保护的是**传输**（"E2EE 恒开"说的是网络路径）；本地落盘与其它会话一样是
///    SQLite 明文，所以这里不加密**不是**"加密失败就退明文"那种兜底。
/// 2. **绝不能进 outbox**：outbox 的唯一出队条件是收到对端 Ack，给自己发包永远不会有 Ack
///    ⇒ 那一行会永远留在库里、被每次心跳/建链的 `flush_outbox` 重发，
///    把"outbox 必然排空"这条不变量破掉。
/// 3. **绝不能广播**：`target = 自己` 的 gossip 信封对别人是解不开的噪声，
///    本机自己也会在 `handle_gossip` 的 `sender == 自己` 早退里丢掉 —— 纯浪费带宽与 TTL。
///
/// 状态直接给 `"read"`：本机既是发送方也是接收方，不存在"在途"阶段；
/// 前端也不会给自聊消息挂回执（见 `src/utils/selfChat.ts`）。
fn insert_self_message(s: &AppState, kind: &str, content: String) -> Result<MessageRecord, String> {
    // 只支持文本 / 代码：用户 2026-09-16 明确「先只支持文本」。图片与文件要落盘、要文件卡片，
    // 走的是另一条链路（`send_file`），自聊里前端也不会给附件入口 —— 真调到了就明确报错，
    // 不要静默吞掉。
    if kind != "text" && kind != "code" {
        return Err("和自己聊天暂不支持图片或文件".to_string());
    }
    let content = check_message_content(content)?;
    let ts = db::now_ms();
    let me = s.device_id.clone();
    // ⚠️ 名字/头像都在**拿 db 锁之前**取好：`self_display_name`/`self_avatar` 各自还要锁
    // 昵称与头像（`is_zh` 里还会再锁一次 db），持锁期间再回头锁它们就是在赌锁顺序
    // （本文件里"不能在持有 db 锁时调用 resolve_nickname"那条注释说的是同一件事）。
    let name = s.self_display_name();
    let avatar = s.self_avatar();
    let preview = crate::protocol::preview_text(kind, &content);
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    let seq = db::next_clock(&dbc, &me).map_err(|e| format!("逻辑时钟推进失败：{e}"))?;
    let rec = MessageRecord {
        id: 0,
        // 前缀 `self-` 让它一眼可辨（日志/排障时不会与网络消息的哈希 id 混淆）
        msg_id: format!("self-{}", Uuid::new_v4()),
        conv_id: me.clone(),
        sender_id: me.clone(),
        receiver_id: me.clone(),
        kind: kind.to_string(),
        content,
        ts,
        seq,
        status: "read".to_string(),
        mention_targets: None,
    };
    // ⚠️ `insert_message`（只落库）—— **不是** `insert_message_and_outbox`：
    // 自聊消息没有收件人，进 outbox 就永远排不掉（见上面的第 2 条）。
    db::insert_message(&dbc, &rec).map_err(|e| format!("消息写入失败：{e}"))?;
    // unread_inc = 0：自己发的消息不该让自己"有未读"（与 `send_message` 同口径）
    db::touch_conversation(&dbc, &me, "single", &name, avatar.as_deref(), &preview, 0)
        .map_err(|e| format!("会话写入失败：{e}"))?;
    Ok(rec)
}

/// 读取会话的「当前链路」。前端聊天窗口据此显示连接图标（LAN / 桥接 / 蓝牙 + 节点数）。
///
/// **有直连时以此刻实际选路为准（hop=0）**，而不是返回"上一条消息"的快照 ——
/// 否则链路从蓝牙/中继切回局域网后，聊天头会一直显示「桥接」直到再发一条消息
/// （用户 2026-09-14 真机：两边全在局域网，却显示「已桥接」）。
/// 无直连时才回落到最后一次的快照（桥接跳数由消息路径反推，只在收发时更新）。
/// 注意返回 Result<Option<_>, _>：Tauri 要求"带引用输入的 async 命令"必须返回 Result
/// （State<'_, _> 就是引用输入）。Ok 会被自动解包，前端拿到的仍是 LinkState | null，
/// 契约不变。
#[tauri::command(async)]
pub async fn get_conv_link(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
) -> Result<Option<crate::state::LinkState>, String> {
    let s = state.inner();
    if s.has_link(&conv_id).await {
        let path = crate::network::transport::inbound_path_kind(s, &conv_id).await;
        return Ok(Some(crate::state::LinkState { path, hop: 0 }));
    }
    Ok(s.conv_link
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&conv_id)
        .cloned())
}

#[tauri::command(async)]
pub async fn get_messages(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<MessageRecord>, String> {
    let s = state.inner().clone();
    // 整段进阻塞池：这条是"打开会话/翻页"的主读，持的又是**那唯一一条** db 连接。
    // 标了 `(async)` 的同步 `fn` 仍然跑在 tokio worker 上（INV-P34），留在 worker 里等锁
    // 就是拿稀缺的 worker 去换本来就该排队的位置。
    tokio::task::spawn_blocking(move || -> Result<Vec<MessageRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let safe_limit = limit.unwrap_or(100).clamp(1, 500);
        let safe_offset = offset.unwrap_or(0).max(0);
        Ok(db::get_messages(&dbc, &conv_id, safe_limit, safe_offset).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("消息页读取被线程池中断: {e}"))?
}

/// 一次拿到**所有群会话**的任务行，供前端折叠出「与我相关的未完成任务」蓝色徽标。
///
/// 为什么需要它而不是让前端用内存里已有的消息：会话消息缓存有上限
/// （`enforceMessageCacheBound` 会挤掉冷会话），用内存数据算徽标就等于"没缓存的群没有数字"
/// —— 那是**假状态**，比不显示更糟。这一条只把 `kind IN ('todo','todo_update')` 的原始行取回来，
/// 折叠与判定仍然只有前端 `utils/todos.ts::foldTodos` 那一份（理由见 `db::get_todo_messages_for_conns`）。
#[tauri::command(async)]
pub async fn get_group_todo_messages(
    state: State<'_, Arc<AppState>>,
    conv_ids: Vec<String>,
) -> Result<Vec<MessageRecord>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<MessageRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 群数量上限是个护栏而不是功能：调用方是会话列表，正常量级是几十；
        // 截断方向是"少算几个群的徽标"，不会算错已经算出来的那些。
        const MAX_CONVS: usize = 400;
        Ok(
            db::get_todo_messages_for_conns(&dbc, &conv_ids[..conv_ids.len().min(MAX_CONVS)])
                .unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("群任务徽标读取被线程池中断: {e}"))?
}

#[tauri::command(async)]
pub async fn get_message_count(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
) -> Result<i64, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db::count_messages(&dbc, &conv_id))
    })
    .await
    .map_err(|e| format!("消息计数读取被线程池中断: {e}"))?
}

/// 一次拿到会话的**最新一页**（打开聊天时的冷加载）。
///
/// 与 `get_messages` + `get_message_count` 的关系：这条只服务"取尾部一页"这一个场景，
/// 把那两轮串行 IPC 压成一轮；翻页仍然按 offset 走 `get_messages`（那里 total 是
/// 判"还有没有更早历史"的依据，不是顺手拿来算 offset 的）。
/// 返回正序，前端整表覆盖时不需要再倒一遍。
#[tauri::command(async)]
pub async fn get_latest_messages(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    limit: Option<i64>,
) -> Result<Vec<MessageRecord>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<MessageRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let safe_limit = limit.unwrap_or(100).clamp(1, 500);
        Ok(db::get_latest_messages(&dbc, &conv_id, safe_limit).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("冷加载一页读取被线程池中断: {e}"))?
}

#[tauri::command(async)]
pub async fn get_conversations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Conversation>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<Conversation>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db::list_conversations(&dbc).unwrap_or_default())
    })
    .await
    .map_err(|e| format!("会话列表读取被线程池中断: {e}"))?
}

/// 打开与好友的会话时确保会话行存在（新加好友尚未发过消息时，
/// 会话列表无对应项 → 左侧无法高亮选中态）。
#[tauri::command(async)]
pub async fn ensure_conversation(
    state: State<'_, Arc<AppState>>,
    friend_id: String,
) -> Result<Conversation, String> {
    let s = state.inner().clone();
    // 整段进阻塞池：里面是 peers 快照 + db 的 ensure/回读两次，全同步且**不跨 await 持锁**
    // （原来就是一段一段取锁，形状没变，只是搬离 worker —— 审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<Conversation, String> {
        // 「和自己聊天」：名字/头像取**本机**的，否则 `resolve_nickname` 会回落到 device_id 原文，
        // 会话列表里就成了一串 gosslan-xxxx。
        let (name, avatar) = if friend_id == s.device_id {
            (s.self_display_name(), s.self_avatar())
        } else {
            let name = resolve_nickname(&s, &friend_id);
            let avatar = {
                let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
                peers.get(&friend_id).and_then(|p| p.avatar.clone())
            };
            (name, avatar)
        };
        {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::ensure_conversation(&dbc, &friend_id, "single", &name, avatar.as_deref())
                .map_err(|e| e.to_string())?;
            // 回读已存在的行：会话可能早已建立且被置顶，凭空造一个 pinned=false
            // 会让前端把它当成「未置顶」从而覆盖掉用户的置顶状态。
            if let Some(conv) = db::get_conversation(&dbc, &friend_id) {
                return Ok(conv);
            }
        }
        Ok(Conversation {
            id: friend_id.clone(),
            kind: "single".to_string(),
            name,
            avatar,
            last_msg: None,
            last_ts: None,
            unread: 0,
            pinned: false,
        })
    })
    .await
    .map_err(|e| format!("会话建行被线程池中断: {e}"))?
}

/// 设置会话置顶（纯本地偏好，不广播、不同步）。
#[tauri::command(async)]
pub async fn set_conversation_pinned(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
    pinned: bool,
) -> Result<(), String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_conversation_pinned(&dbc, &conv_id, pinned).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("会话置顶写入被线程池中断: {e}"))?
}

/// 群已读批查的一行：`(成员 id, (该成员最近一条消息 id, 它的 ts))`。
/// 起名字是为了给下面那个阻塞池闭包的返回类型签名用 —— 内联写 `Result<Vec<(String, (String, i64))>, String>`
/// 会被 clippy 的 `type_complexity` 判红（形状本身不改，只是别再让签名读三遍括号）。
type MemberLastRead = (String, (String, i64));

/// 标记会话已读；单聊时向对方发送已读回执（触发对方界面的「已读绿勾」）。
#[tauri::command(async)]
pub async fn mark_read(state: State<'_, Arc<AppState>>, conv_id: String) -> Result<(), String> {
    let s = state.inner().clone();
    // 这条命令里 6 段 db 读写各自进阻塞池（审计 R-18）。逐段搬而不是整函数搬：
    // 中间那些 `try_send(...).await` / `send_read_receipt_route(...).await` 是网络等待，
    // 把它们和 db 读写合成一段就等于"持锁跨 await"（本仓 A-14 那一族自死锁的反面教材）。
    {
        let s = s.clone();
        let cid = conv_id.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            db::mark_read(&dbc, &cid).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("已读写入被线程池中断: {e}"))??;
    }
    if !conv_id.starts_with("group:") {
        // 自聊（会话 id == 自己）：本机既是发送方也是接收方，没有"对方"可收回执。
        // 真发出去只会在 `pending_reads` 里留一条永远排不掉的记录（`flush_pending_reads`
        // 每次建链/心跳都会重试一次）。未读清空已经在上面做完了，这里直接返回。
        if conv_id == s.device_id {
            return Ok(());
        }
        // 通知对方：我已读到「对方最近一条消息」为止。
        // 这里不能取全会话最大 ts：一是可能取到自己发的消息，二是对方消息在本机
        // 落库时被时钟钳制过，直接回传 ts 会让对方用自己的原始时间戳匹配不上。
        // 回传 msg_id，由发送方换算成自己的本地时间戳。
        let last = {
            let s = s.clone();
            let cid = conv_id.clone();
            tokio::task::spawn_blocking(move || -> Result<Option<(String, i64)>, String> {
                let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                Ok(db::last_message_from_sender(&dbc, &cid, &cid))
            })
            .await
            .map_err(|e| format!("已读定位读取被线程池中断: {e}"))??
        };
        if let Some((msg_id, ts)) = last {
            // 同网段走直连 ReadReceipt，跨跳走定向 Gossip ChatReadReceipt。
            // try_send 返回 Ok 只代表消息进入 mpsc channel，不代表 TCP writer
            // 真正 write_frame 成功——writer_loop 可能随后发现链路已断而丢弃。
            // 因此无论结果都保留 pending：下一次心跳/建链时 flush 重发。
            let _ =
                crate::network::transport::send_read_receipt_route(&s, &conv_id, Some(msg_id), ts)
                    .await;
            {
                let mut pending = s.pending_reads.lock().unwrap_or_else(|e| e.into_inner());
                let cur = pending.entry(conv_id.clone()).or_insert(ts);
                *cur = (*cur).max(ts);
            }
            // 持久化到 DB：进程重启后 pending_reads 内存丢失时可从 DB 恢复。
            // 使用 max 语义（upsert_pending_read）保证较旧 timestamp 不覆盖较新。
            {
                let s = s.clone();
                let cid = conv_id.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::upsert_pending_read(&dbc, &cid, ts).ok();
                    Ok(())
                })
                .await
                .map_err(|e| format!("待发已读持久化被线程池中断: {e}"))??;
            }
        }
    } else if let Some(group_id) = conv_id.strip_prefix("group:") {
        let gid = group_id.to_string();
        let group = {
            let s = s.clone();
            let gid = gid.clone();
            tokio::task::spawn_blocking(move || -> Result<Option<Group>, String> {
                let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                Ok(db::get_group(&dbc, &gid))
            })
            .await
            .map_err(|e| format!("群成员读取被线程池中断: {e}"))??
        };
        if let Some(group) = group {
            // 单次锁内查齐全部成员的最近消息（审计 2.1h）：旧形状每成员 2 次抢锁，
            // 200 人群打开/滚动一次 = 400 次锁往返；查询本身是索引点查，一次锁持有
            // 内批查即可。发送（await）绝不持锁（全仓纪律），回执持久化再合并成一次锁。
            let lasts = {
                let s = s.clone();
                let cid = conv_id.clone();
                let mine = s.device_id.clone();
                tokio::task::spawn_blocking(move || -> Result<Vec<MemberLastRead>, String> {
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    Ok(group
                        .members
                        .iter()
                        .filter(|m| **m != mine)
                        .filter_map(|member| {
                            // 群回执同样按「该成员最近一条消息」发送，避免跨设备时钟偏差。
                            db::last_message_from_sender(&dbc, &cid, member)
                                .map(|last| (member.clone(), last))
                        })
                        .collect::<Vec<_>>())
                })
                .await
                .map_err(|e| format!("群已读定位读取被线程池中断: {e}"))??
            };
            let mut to_persist: Vec<(String, i64)> = Vec::new();
            for (member, (msg_id, last_read_ts)) in lasts {
                let msg = Message::GroupReadReceipt {
                    from: s.device_id.clone(),
                    group_id: gid.clone(),
                    last_read_ts,
                    last_read_msg_id: Some(msg_id),
                };
                let _ = crate::network::transport::try_send(&s, &member, &msg).await;
                to_persist.push((member, last_read_ts));
            }
            // 无论即时发送是否成功都持久化待发记录，由建链/Hello/心跳补发；
            // 接收端按 (group_id, reader_id) 单调去重，重复送达无副作用。
            if !to_persist.is_empty() {
                let s = s.clone();
                let gid = gid.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                    for (member, ts) in &to_persist {
                        db::upsert_pending_group_read(&dbc, &gid, member, *ts).ok();
                    }
                    Ok(())
                })
                .await
                .map_err(|e| format!("群待发已读持久化被线程池中断: {e}"))??;
            }
        }
    }
    Ok(())
}

/// 删除本地会话与全部消息（聊天记录清理）。
/// 仅删本地：不影响对方、不广播；前端负责二次确认弹窗。
/// 群聊同样支持（删除 group:xxx 会话及全部消息）。
#[tauri::command(async)]
pub async fn delete_conversation(
    state: State<'_, Arc<AppState>>,
    conv_id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // 群会话删除时写删除边界：其他成员保留的历史重放不得回灌本机。
        // 边界记录当前逻辑序号，而非墙上时钟。
        if let Some(gid) = conv_id.strip_prefix("group:") {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            let boundary = db::get_clock(&dbc, &conv_id);
            db::set_clear_boundary(&dbc, gid, boundary).map_err(|e| e.to_string())?;
        }
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::delete_conversation(&dbc, &conv_id).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("会话删除被线程池中断: {e}"))?
}

