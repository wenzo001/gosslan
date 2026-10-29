// 直连 E2EE 载荷：解封、重密封与公钥回查
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第三批；守卫视图与领域图的分册清单一同登记。

/// 取发送方当前的 X25519 公钥：**好友表优先**，只有好友表为空才回退在线节点表。
///
/// ⚠️ 这里原先写的"好友表由 `upsert_peer` 在检测到公钥变化时刷新，所以对方换了身份
/// 最长一个广播周期后就会收敛到这里"**与实现相反**，会把人带错方向（2026-10-13 逐处核对）：
/// `upsert_peer` 唯一的那次写入走 `db::update_friend_pubkeys`，而它是 `COALESCE(col, ?)` ——
/// **只填空位、绝不覆盖**（`db/friends.rs` 的注释把这条定为"防劫持的最后一道闸"，
/// 还有一条测试专门钉住"这里只许一处写钥匙"）。检测到公钥变化时它做的是
/// **在聊天里插一条 ⚠️「身份密钥发生变化，已保留原密钥未替换」**（`peer_registry.rs`），
/// 不是刷新。覆盖式写入只有 `replace_friend_pubkeys` 那一条路，而它要求用户显式确认。
/// ⇒ 后果：好友表里那把钥匙一旦是错的，就**一直错**，直到删好友重加或用户点「同步新密钥」。
///
/// ⚠️ 另注（口径分叉，排查时会咬人）：同一个"这位好友的公钥是哪一把"在本仓有两套顺序 ——
/// 这里与 `commands/chat.rs` 的密封是**好友表优先**，而 `resolve_member_x25519`（群密钥分发）
/// 与 `get_safety_number`（界面那串安全码）是 **peers 优先**。所以两份记录不一致时，
/// **「双方安全码对得上」并不证明消息解得开**：核对读的是新钥匙，加密用的是旧钥匙。
fn sender_x25519_pubkey(state: &AppState, from: &str) -> Option<String> {
    let from_db = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend_x25519(&dbc, from)
    };
    from_db.or_else(|| {
        state
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(from)
            .and_then(|p| p.x25519_pubkey.clone())
    })
}

/// 打开直连单聊载荷：`enc1:base64(nonce ‖ ChaCha20-Poly1305 密文)`。
/// 返回 `None` = 当前无法解密（缺对端公钥 / 密钥交换失败 / AEAD 校验失败 / UTF-8 非法）。
/// 调用方据此不落库、不 Ack——绝不返回占位文本，占位文本一旦占用真实 msg_id，
/// 同一 msg_id 的正确副本就永远进不来（`insert_message` 是 INSERT OR IGNORE）。
fn open_direct_content(
    me: &crate::crypto::Identity,
    sender_pubkey: Option<&str>,
    wire: &str,
    kind: String,
) -> Option<(String, String)> {
    let b64 = wire.strip_prefix("enc1:")?;
    let pubkey = sender_pubkey?;
    let shared = me.dh(pubkey)?;
    let bytes = STANDARD.decode(b64).ok()?;
    let plain = crypto::open(&shared, &bytes)?;
    // kind **原样透传**（不做 `from_wire_str` 那样的回落）：本机不认识的 kind 也要带着真值
    // 入库，前端才会显示「不支持的消息类型」而不是把它当成 text 渲染出一坨裸 JSON。
    Some((String::from_utf8(plain).ok()?, kind))
}

/// 用接收方当前公钥重新密封待发内容（`msg_id` 由调用方保持不变）。
/// 返回 `None` = 无法重封（本地无明文 / 拿不到当前公钥 / 加密失败），调用方按原样补发。
fn reseal_chat_content(
    me: &crate::crypto::Identity,
    plaintext: Option<&str>,
    receiver_pubkey: Option<&str>,
) -> Option<String> {
    let shared = me.dh(receiver_pubkey?)?;
    let sealed = crypto::seal(&shared, plaintext?.as_bytes())?;
    Some(format!("enc1:{}", STANDARD.encode(sealed)))
}

/// 补发前重封一条 `ChatMessage`：密文是「加密时刻」的产物，若双方任一身份在那之后
/// 变化（重装 / 重新加好友），旧密文在接收方永远解不开，重发同一份密文没有意义。
/// 发送方 `messages` 表存的就是明文（见 `commands::send_message`），据此恢复明文并用
/// 最新公钥重封即可；`msg_id` 取自 Gossip 信封 ID、与密文无关，故重封不改变消息身份。
fn reseal_for_send(state: &AppState, msg: Message) -> Message {
    let Message::ChatMessage {
        msg_id,
        from,
        to,
        kind,
        content,
        ts,
        seq,
    } = msg
    else {
        return msg;
    };
    if !content.starts_with("enc1:") {
        return Message::ChatMessage {
            msg_id,
            from,
            to,
            kind,
            content,
            ts,
            seq,
        };
    }
    let (plaintext, from_db) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // 只认「我自己发出的那条记录」：接收方行的 content 是对方会话的明文，语义不同
        let plaintext = dbc
            .query_row(
                "SELECT content FROM messages WHERE msg_id = ?1 AND sender_id = ?2",
                params![msg_id, state.device_id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        (plaintext, db::get_friend_x25519(&dbc, &to))
    };
    let pubkey = from_db.or_else(|| {
        state
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&to)
            .and_then(|p| p.x25519_pubkey.clone())
    });
    let resealed = reseal_chat_content(
        &state.identity,
        plaintext.as_deref(),
        pubkey.as_deref(),
    );
    Message::ChatMessage {
        content: resealed.unwrap_or(content),
        msg_id,
        from,
        to,
        kind,
        ts,
        seq,
    }
}
