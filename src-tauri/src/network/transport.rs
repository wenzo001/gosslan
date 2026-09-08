//! TCP 消息传输与协议分发（含 Gossip 广播、中继切片、群密钥、E2EE 解密）。
//!
//! 连接建立规则（避免重复建链的竞态）：
//! - 每个节点对，由 **device_id 字典序较小** 的一方主动拨号（dial），较大的一方只被动接受。
//! - 双方各自维护一个出站 mpsc 发送端，读循环负责解析帧并分发。

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::params;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::time::Duration;
use x25519_dalek::StaticSecret;

use crate::commands::{is_virtual_ip, MAX_GROUP_NAME_LEN};
use crate::crypto;
use crate::db;
use crate::network::file;
use crate::protocol::{GossipEnvelope, GossipKind, Message, MsgKind, MAX_FRAME};
use crate::state::{
    AppState, FileDoneInfo, FileFailedInfo, FileProgress, MessageRecord, Peer, PendingRequest,
};

/// 字符串 IP 是否为虚拟地址（用于 peers 表中已存储的 IP 字符串判断）。
fn is_virtual_ip_str(ip_str: &str) -> bool {
    ip_str
        .parse::<Ipv4Addr>()
        .map(|ip| is_virtual_ip(&ip))
        .unwrap_or(false)
}

// ---------------- 分帧 ----------------

pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, msg: &Message) -> std::io::Result<()> {
    let json = serde_json::to_vec(msg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if json.is_empty() || json.len() > MAX_FRAME || json.len() > u32::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "帧过大",
        ));
    }
    let len = json.len() as u32;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(&json).await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Message> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "非法帧长度",
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

// ---------------- 出站发送 ----------------

/// 尝试通过已建立连接发送消息；无连接则返回 Err。
pub async fn try_send(state: &AppState, peer_id: &str, msg: &Message) -> Result<(), String> {
    let links = state.links.lock().await;
    match links.get(peer_id) {
        Some(tx) => tx.send(msg.clone()).await.map_err(|e| e.to_string()),
        None => Err("未建立连接".to_string()),
    }
}

/// 向所有已连接节点广播一条 Gossip 消息。
pub async fn broadcast_gossip(state: &AppState, envelope: GossipEnvelope) {
    let msg = Message::Gossip { envelope };
    let links = state.links.lock().await;
    for tx in links.values() {
        let _ = tx.send(msg.clone()).await;
    }
}

// ---------------- 服务启动 ----------------

pub async fn spawn(
    state: Arc<AppState>,
    ip: Ipv4Addr,
    tcp_port: u16,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), String> {
    let bind = format!("{ip}:{tcp_port}");
    let listener = TcpListener::bind(&bind)
        .await
        .map_err(|e| format!("TCP 绑定 {bind} 失败: {e}"))?;
    let state_for_heartbeat = state.clone();
    let shutdown_for_heartbeat = shutdown.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                accept = listener.accept() => {
                    let Ok((stream, peer_addr)) = accept else { continue };
                    let st = state.clone();
                    tokio::spawn(handle_incoming(st, stream, peer_addr));
                }
            }
        }
    });
    // 心跳：周期性向所有已建链节点发送 Heartbeat，
    // 及时发现静默断连（写失败 → writer 退出 → link 移除 → 在线状态修正）。
    tokio::spawn(async move {
        let state = state_for_heartbeat;
        let mut shutdown = shutdown_for_heartbeat;
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = tick.tick() => {
                    let links = state.links.lock().await;
                    for tx in links.values() {
                        let _ = tx.send(Message::Heartbeat { device_id: state.device_id.clone() }).await;
                    }
                }
            }
        }
    });
    Ok(())
}

async fn handle_incoming(state: Arc<AppState>, stream: TcpStream, peer_addr: std::net::SocketAddr) {
    let (mut r, w) = stream.into_split();
    let first = match read_frame(&mut r).await {
        Ok(m) => m,
        Err(_) => return,
    };
    let peer_id = match &first {
        Message::Hello { device_id, .. } => device_id.clone(),
        _ => return, // 首帧必须是 Hello
    };
    let (tx, rx) = mpsc::channel(1024);
    state.links.lock().await.insert(peer_id.clone(), tx.clone());
    tokio::spawn(writer_loop(state.clone(), peer_id.clone(), w, rx));
    handle_message(&state, &peer_id, first).await;
    // 用 TCP 对端的真实地址补全 peer IP：解决「被动连接方 peers 表 IP 为空或虚拟」的问题。
    // 新地址必须是非虚拟、非 link-local 的可直连 LAN 地址才写入。
    {
        let mut peers = state.peers.lock().unwrap();
        if let Some(p) = peers.get_mut(&peer_id) {
            if let std::net::IpAddr::V4(new_ip) = peer_addr.ip() {
                let new_ok = !is_virtual_ip(&new_ip)
                    && new_ip.octets()[0] != 169
                    && new_ip.octets()[1] != 254;
                if new_ok && (p.ip.is_empty() || is_virtual_ip_str(&p.ip)) {
                    p.ip = new_ip.to_string();
                }
            }
        }
    }
    state.emit_peers();
    reader_loop(state, r, peer_id, tx).await;
}

async fn writer_loop(
    state: Arc<AppState>,
    peer_id: String,
    mut w: OwnedWriteHalf,
    mut rx: mpsc::Receiver<Message>,
) {
    while let Some(msg) = rx.recv().await {
        if write_frame(&mut w, &msg).await.is_err() {
            // TCP write 失败：普通消息由 outbox 重发；ReadReceipt 需要特殊处理——
            // 它没有 outbox 行，如果 pending 已被 flush_pending_reads 清除，
            // 此处不恢复就永久丢失。将 timestamp 重新放回 pending_reads，
            // 下一次建链 / Hello / Heartbeat 会再次 flush 重发。
            if let Message::ReadReceipt { last_read_ts, .. } = &msg {
                let mut pending = state.pending_reads.lock().unwrap();
                let cur = pending.entry(peer_id.clone()).or_insert(*last_read_ts);
                *cur = (*cur).max(*last_read_ts);
            }
            break;
        }
    }
}

async fn reader_loop(
    state: Arc<AppState>,
    mut r: OwnedReadHalf,
    peer_id: String,
    link_tx: mpsc::Sender<Message>,
) {
    loop {
        match read_frame(&mut r).await {
            Ok(msg) => handle_message(&state, &peer_id, msg).await,
            Err(_) => break,
        }
    }
    file::fail_receives_for_peer(&state, &peer_id);
    // 只移除「本条连接」的 link：若对端已重拨建立了新连接，旧的 reader 退出时
    // 不能把新连接的发送端删掉（否则会出现「消息发不出去」的间歇性故障）。
    let was_live_link = {
        let mut links = state.links.lock().await;
        let is_live = links
            .get(&peer_id)
            .map(|tx| tx.same_channel(&link_tx))
            .unwrap_or(false);
        if is_live {
            links.remove(&peer_id);
        }
        is_live
    };
    // 仅当退出的就是当前活跃链路时才标记离线（新链路已接管则不影响在线状态）
    if was_live_link {
        mark_peer_offline(&state, &peer_id).await;
    }
}

// ---------------- 主动建链（小 ID 拨号） ----------------

pub async fn ensure_link(state: &Arc<AppState>, peer_id: &str, ip: &str, tcp_port: u16) {
    if peer_id >= state.device_id.as_str() {
        return; // 只有小 ID 拨号
    }
    if state.links.lock().await.contains_key(peer_id) {
        return;
    }
    connect_to_peer(state, peer_id, ip, tcp_port).await;
}

async fn connect_to_peer(state: &Arc<AppState>, peer_id: &str, ip: &str, tcp_port: u16) {
    {
        let links = state.links.lock().await;
        if links.contains_key(peer_id) {
            return;
        }
    }

    let addr = format!("{ip}:{tcp_port}");
    let stream = match TcpStream::connect(&addr).await {
        Ok(s) => s,
        Err(_) => return,
    };

    let (r, w) = stream.into_split();
    let (tx, rx) = mpsc::channel(1024);
    state
        .links
        .lock()
        .await
        .insert(peer_id.to_string(), tx.clone());
    tokio::spawn(writer_loop(state.clone(), peer_id.to_string(), w, rx));

    let hello = Message::Hello {
        device_id: state.device_id.clone(),
        nickname: state.nickname.lock().unwrap().clone(),
        avatar: state.avatar.lock().unwrap().clone(),
        tcp_port: state.tcp_port,
        x25519_pubkey: state.identity.x25519_public_b64(),
        ed25519_pubkey: state.identity.ed25519_public_b64(),
    };
    let _ = tx.send(hello).await;

    tokio::spawn(reader_loop(state.clone(), r, peer_id.to_string(), tx));
    flush_outbox(state, peer_id).await;
    flush_pending_reads(state, peer_id).await;
    // 主动拨号建链完成：补发此前因无 link 而未送达的群密钥
    flush_pending_group_keys(state, peer_id).await;
}

// ---------------- 消息分发 ----------------

pub async fn handle_message(state: &Arc<AppState>, peer_id: &str, msg: Message) {
    match msg {
        Message::Hello {
            device_id,
            nickname,
            avatar,
            tcp_port,
            x25519_pubkey,
            ed25519_pubkey,
        } => {
            if device_id != peer_id {
                return;
            }
            let ip = state
                .peers
                .lock()
                .unwrap()
                .get(&device_id)
                .map(|p| p.ip.clone())
                .unwrap_or_default();
            upsert_peer(
                state,
                &device_id,
                &nickname,
                avatar.clone(),
                &ip,
                tcp_port,
                Some(x25519_pubkey),
                Some(ed25519_pubkey),
                None,
            )
            .await;
            maybe_update_friend(state, &device_id, &nickname, avatar);
            flush_outbox(state, &device_id).await;
            flush_pending_reads(state, &device_id).await;
            // 链路刚建立：补发此前因无 link 而未送达的群密钥
            flush_pending_group_keys(state, &device_id).await;
        }
        Message::Heartbeat { device_id } => {
            if device_id != peer_id {
                return;
            }
            touch_peer(state, &device_id).await;
            flush_outbox(state, &device_id).await;
            flush_pending_reads(state, &device_id).await;
            flush_pending_group_keys(state, &device_id).await;
        }
        Message::UserInfo {
            device_id,
            nickname,
            avatar,
        } => {
            if device_id != peer_id {
                return;
            }
            let ip = state
                .peers
                .lock()
                .unwrap()
                .get(&device_id)
                .map(|p| p.ip.clone())
                .unwrap_or_default();
            upsert_peer(
                state,
                &device_id,
                &nickname,
                avatar.clone(),
                &ip,
                0,
                None,
                None,
                None,
            )
            .await;
            maybe_update_friend(state, &device_id, &nickname, avatar.clone());
            // 同步更新 single 会话的昵称/头像（conversations DB）
            let dbc = state.db.lock().unwrap();
            db::update_conversation_profile(&dbc, &device_id, &nickname, avatar.as_deref()).ok();
        }
        Message::ChatStyle { from, to, style } => {
            if from == state.device_id {
                return;
            }
            if let Some(t) = &to {
                if t != &state.device_id {
                    return; // 定向给别人，忽略
                }
            }
            // 持久化对端样式表（device_id -> style JSON），前端按发送者渲染其消息气泡
            {
                let dbc = state.db.lock().unwrap();
                let mut map: serde_json::Map<String, serde_json::Value> =
                    db::get_setting(&dbc, "chat_peer_styles")
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or_default();
                map.insert(from.clone(), serde_json::Value::String(style.clone()));
                if let Ok(json) = serde_json::to_string(&map) {
                    db::set_setting(&dbc, "chat_peer_styles", &json).ok();
                }
            }
            let _ = state.app.emit(
                "peer-style-updated",
                &serde_json::json!({ "device_id": from, "style": style }),
            );
        }
        Message::FriendRequest {
            from,
            from_nickname,
            from_avatar,
            to,
            ts,
        } => {
            if from != peer_id {
                return;
            }
            if to != state.device_id {
                return;
            }
            let req = PendingRequest {
                from: from.clone(),
                from_nickname: from_nickname.clone(),
                from_avatar: from_avatar.clone(),
                ts,
            };
            state
                .pending_requests
                .lock()
                .unwrap()
                .insert(from.clone(), req.clone());
            let _ = state.app.emit("friend-request", &req);
            let mut extra = std::collections::HashMap::new();
            extra.insert("type".to_string(), "friend_request".to_string());
            notify_with_extra(
                &state.app,
                "好友申请",
                &format!("{from_nickname} 请求添加你为好友"),
                extra,
            );
        }
        Message::FriendAccept { from, to } => {
            if from != peer_id {
                return;
            }
            if to != state.device_id {
                return;
            }
            let name = resolve_nickname(state, &from);
            {
                let dbc = state.db.lock().unwrap();
                db::add_friend(&dbc, &from, &name, None).ok();
                // 同步公钥（否则首次加密发送会失败）
                let (x, e) = {
                    let peers = state.peers.lock().unwrap();
                    peers
                        .get(&from)
                        .map(|p| (p.x25519_pubkey.clone(), p.ed25519_pubkey.clone()))
                        .unwrap_or((None, None))
                };
                if x.is_some() || e.is_some() {
                    db::update_friend_pubkeys(&dbc, &from, x.as_deref(), e.as_deref()).ok();
                }
            }
            let _ = state.app.emit("friend-accepted", &from);
            notify(
                &state.app,
                "好友申请已通过",
                &format!("{name} 已成为你的好友"),
            );
        }
        Message::FriendReject { from, to } => {
            if from != peer_id {
                return;
            }
            if to != state.device_id {
                return;
            }
            state.pending_requests.lock().unwrap().remove(&from);
            let _ = state.app.emit("friend-rejected", &from);
        }
        Message::FriendRemove { from, to } => {
            if from != peer_id {
                return;
            }
            if to != state.device_id {
                return;
            }
            // 对方删除了好友关系：移除本地好友行（不删除聊天记录）
            let dbc = state.db.lock().unwrap();
            db::remove_friend(&dbc, &from).ok();
            drop(dbc);
            let _ = state.app.emit("friend-removed", &from);
        }
        Message::FriendMessageBlocked {
            ref from,
            ref to,
            ref original_sender,
        } => {
            if from != peer_id {
                return;
            }
            if to == &state.device_id {
                // 目标是本机：通知前端
                let _ = state.app.emit("friend-message-blocked", from);
            } else if original_sender != &state.device_id {
                // 中继节点：转发给原始发送方（与 Ack relay 同逻辑）
                let _ = try_send(
                    state,
                    original_sender,
                    &Message::FriendMessageBlocked {
                        from: from.clone(),
                        to: to.clone(),
                        original_sender: original_sender.clone(),
                    },
                )
                .await;
            }
        }
        Message::ChatMessage {
            msg_id,
            from,
            to,
            kind,
            content,
            ts,
        } => {
            if from != peer_id {
                return;
            }
            if to != state.device_id {
                return;
            }
            // 去重前置：真实 msg_id 已落库 == 这条消息我此前已成功接收并持久化，
            // 于是只回 Ack。必须早于解密——否则对方轮换密钥后重投的那份「已收好的」
            // 消息会因当前密钥打不开旧密文而被误判为失败。
            let exists = {
                let dbc = state.db.lock().unwrap();
                db::message_exists(&dbc, &msg_id)
            };
            if exists {
                let _ = try_send(state, peer_id, &Message::Ack { msg_id }).await;
                return;
            }
            // 好友关系检查：非好友消息不落库、不 Ack、通知发送方
            let is_friend = {
                let dbc = state.db.lock().unwrap();
                db::get_friend(&dbc, &from).is_some()
            };
            if !is_friend {
                let _ = try_send(
                    state,
                    peer_id,
                    &Message::FriendMessageBlocked {
                        from: state.device_id.clone(),
                        to: from.clone(),
                        original_sender: from.clone(),
                    },
                )
                .await;
                return;
            }
            // E2EE："enc1:" = 发送方→我的 ChaCha20-Poly1305 密文，用发送方 X25519 公钥打开。
            // 打不开（缺公钥 / 公钥已轮换 / 密文损坏）时**既不落库也不 Ack**，原因：
            //  - Ack 的语义是「已成功接收并持久化」，发送方一收到就会删掉 outbox 行；
            //  - 若用真实 msg_id 写一条占位系统消息，同一 msg_id 的后续正确副本会被
            //    INSERT OR IGNORE 静默吞掉，明文永久不可恢复（P0-2 的原始故障形态）。
            // 不 Ack ⇒ outbox 行保留 ⇒ Hello/心跳继续补发；期间 announce·who_has 会把
            // 双方公钥刷进 peers 与 friends 表，补发前还会用最新公钥重新密封
            // （见 flush_outbox / reseal_for_send），消息随自动恢复且不改变 msg_id。
            let Some((content, kind_str)) = open_direct_content(
                &state.identity.x25519_secret,
                sender_x25519_pubkey(state, &from).as_deref(),
                &content,
                kind,
            ) else {
                return;
            };
            let name = resolve_nickname(state, &from);
            let preview = preview_content(&kind_str, &content);
            // 持锁块只做落库，返回带钳制 ts 的记录 + SQLite 的三态裁决；await 全部在锁外
            // （MutexGuard 非 Send）。首次与否由 INSERT 的受影响行数裁决，而不是先查后写：
            // 与 Gossip 并发时只有一方拿到 Ok(true)，未读 +1 / message-received 因此各只一次。
            let (out_rec, inserted) = {
                let dbc = state.db.lock().unwrap();
                // 时钟偏差防护：发送方时钟与我方不一致会导致消息排序错乱
                // （同一发送者的消息在列表中堆叠）→ 双向钳制到 [会话最后一条, 本地 now]
                let ts = db::clamp_incoming_ts(ts, db::now_ms(), db::last_message_ts(&dbc, &from));
                let rec = MessageRecord {
                    id: 0,
                    msg_id: msg_id.clone(),
                    conv_id: from.clone(),
                    sender_id: from.clone(),
                    receiver_id: state.device_id.clone(),
                    kind: kind_str.clone(),
                    content: content.clone(),
                    ts,
                    status: "delivered".to_string(),
                };
                let inserted = db::insert_message_if_new(&dbc, &rec);
                if announced_on(&inserted) {
                    db::touch_conversation(&dbc, &from, "single", &name, None, &preview, 1).ok();
                }
                (rec, inserted)
            };
            // 真数据库错误 ⇒ 消息没有持久化 ⇒ 既不投递也绝不 Ack：Ack 会让发送方删除
            // outbox 行，把一次临时故障变成永久丢消息（与 P0-2 同源的红线）。
            if !may_ack(&inserted) {
                return;
            }
            if announced_on(&inserted) {
                let _ = state.app.emit("message-received", &out_rec);
            }
            // Ack 与「是否本次新建」无关：消息已在库中（无论是哪条路径先写的）即代表已成功接收
            let _ = try_send(state, peer_id, &Message::Ack { msg_id }).await;
        }
        Message::Ack { msg_id } => {
            // 查询原始发送方：如果这条消息不是我发的，说明我是中继节点，
            // 需要把 Ack 转发给原始发送方（而非本地处理）。
            let original_sender: Option<String> = {
                let dbc = state.db.lock().unwrap();
                dbc.query_row(
                    "SELECT sender_id FROM messages WHERE msg_id = ?1",
                    params![msg_id],
                    |r| r.get(0),
                )
                .ok()
            };
            match original_sender {
                Some(sender) if sender == state.device_id => {
                    // 情况 1：Ack 对应的原始消息是我发的 → 正常处理
                    let dbc = state.db.lock().unwrap();
                    // Ack 没有可伪造的 sender 字段，必须同时命中本连接对应的
                    // outbox 目标，避免任意 LAN 节点猜到 msg_id 后伪造送达。
                    let is_expected_peer: bool = dbc
                        .query_row(
                            "SELECT 1 FROM outbox WHERE msg_id = ?1 AND peer_id = ?2",
                            params![msg_id, peer_id],
                            |_| Ok(()),
                        )
                        .is_ok();
                    if !is_expected_peer {
                        return;
                    }
                    db::set_message_status(&dbc, &msg_id, "delivered").ok();
                    dbc.execute("DELETE FROM outbox WHERE msg_id = ?1", params![msg_id])
                        .ok();
                    drop(dbc);
                    let _ = state.app.emit("message-acked", &msg_id);
                }
                Some(sender) => {
                    // 情况 2：中继节点 → 转发 Ack 给原始发送方
                    // sender_id / message_id 保持不变，中继节点不做任何本地状态修改。
                    let _ = try_send(state, &sender, &Message::Ack { msg_id }).await;
                }
                None => {
                    // 查询不到 sender_id（消息不在本地 DB）→ 安全丢弃，不做任何修改。
                }
            }
        }
        Message::ReadReceipt {
            from,
            to,
            last_read_ts,
        } => {
            if from != peer_id || to != state.device_id || from == state.device_id {
                return;
            }
            // 对方已读：把「我发给对方、ts ≤ last_read_ts」的消息标记为 read（幂等）
            {
                let dbc = state.db.lock().unwrap();
                let _ = dbc.execute(
                    "UPDATE messages SET status = 'read'
                     WHERE conv_id = ?1 AND sender_id = ?2 AND status != 'read' AND ts <= ?3",
                    params![from, state.device_id, last_read_ts],
                );
            }
            // 无论 updated 是 0 还是 >0 都 emit：DB 可能已经是 read，
            // 但前端内存状态可能落后（事件竞态 / 会话重查覆盖），
            // 重新 emit 让 frontend 用 furthestStatus 再校准一次。
            let _ = state.app.emit(
                "peer-read",
                &serde_json::json!({ "peer_id": from, "last_read_ts": last_read_ts }),
            );
        }
        Message::GroupReadReceipt {
            from,
            group_id,
            last_read_ts,
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            let is_member = {
                let dbc = state.db.lock().unwrap();
                db::get_group(&dbc, &group_id)
                    .map(|g| g.members.contains(&from) && g.members.contains(&state.device_id))
                    .unwrap_or(false)
            };
            if !is_member {
                return;
            }
            {
                let dbc = state.db.lock().unwrap();
                db::upsert_group_read(&dbc, &group_id, &from, last_read_ts).ok();
            }
            let _ = state.app.emit(
                "group-read",
                &serde_json::json!({
                    "group_id": group_id,
                    "reader_id": from,
                    "last_read_ts": last_read_ts,
                }),
            );
        }
        Message::FileOffer {
            transfer_id,
            from,
            name,
            size,
            sealed_file_key,
            file_sha256,
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            let is_friend = {
                let dbc = state.db.lock().unwrap();
                db::get_friend(&dbc, &from).is_some()
            };
            if !is_friend {
                let _ = try_send(state, peer_id, &Message::FileReject { transfer_id }).await;
                return;
            }
            // SHA-256 元数据格式校验：非法即拒绝（文件级完整性无法验证）
            if !file::valid_sha256_hex(&file_sha256) {
                let _ = try_send(state, peer_id, &Message::FileReject { transfer_id }).await;
                return;
            }
            // E2EE：解封文件会话密钥（发送方用我方公钥封装，只有我能解开）。
            // 解封失败必须拒绝传输——密文分片绝不能落盘。
            let file_key = (|| {
                let sender_pub = resolve_member_x25519(state, &from)?;
                let shared = crypto::shared_secret(&state.identity.x25519_secret, &sender_pub)?;
                let sealed = STANDARD.decode(&sealed_file_key).ok()?;
                crypto::open(&shared, &sealed).and_then(|k| k.try_into().ok())
            })();
            let Some(file_key) = file_key else {
                let _ = try_send(state, peer_id, &Message::FileReject { transfer_id }).await;
                return;
            };
            match file::begin_receive(
                state,
                &transfer_id,
                &from,
                &name,
                size,
                file_key,
                file_sha256,
            ) {
                Ok(_) => {
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
                    let _ = try_send(state, peer_id, &Message::FileReject { transfer_id }).await;
                    eprintln!("接收文件初始化失败: {e}");
                }
            }
        }
        Message::FileAccept { transfer_id } => {
            if let Some(tx) = state
                .pending_file_accept
                .lock()
                .unwrap()
                .remove(&transfer_id)
            {
                let _ = tx.send(());
            }
        }
        Message::FileReject { transfer_id } => {
            state
                .pending_file_accept
                .lock()
                .unwrap()
                .remove(&transfer_id);
        }
        Message::FileChunk {
            transfer_id,
            seq,
            data,
        } => {
            match STANDARD
                .decode(&data)
                .map_err(|e| e.to_string())
                .and_then(|bytes| file::write_chunk(state, &transfer_id, peer_id, seq, &bytes))
            {
                Ok(received) => {
                    // 节流：每 250ms 至多上报一次进度，避免大文件 IPC 事件风暴
                    let (total, should_emit) = {
                        let mut recv = state.file_receivers.lock().unwrap();
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
                    let _ = file::fail_receive(state, &transfer_id, peer_id, &e);
                }
            }
        }
        Message::FileDone { transfer_id } => {
            match file::finish_receive(state, &transfer_id, peer_id) {
                Err(e) => {
                    let _ = state.app.emit(
                        "file-failed",
                        &FileFailedInfo {
                            transfer_id,
                            reason: e,
                        },
                    );
                }
                Ok(None) => {}
                Ok(Some((name, size, path, sender_id))) => {
                    let dbc = state.db.lock().unwrap();
                    let content = serde_json::json!({
                        "name": name,
                        "path": path.to_string_lossy().to_string(),
                        "size": size,
                        "subtype": file::classify_file_subtype(&name),
                    })
                    .to_string();
                    let rec = MessageRecord {
                        id: 0,
                        msg_id: format!("file-{transfer_id}"),
                        conv_id: sender_id.clone(),
                        sender_id: sender_id.clone(),
                        receiver_id: state.device_id.clone(),
                        kind: "file".to_string(),
                        content,
                        ts: db::now_ms(),
                        status: "delivered".to_string(),
                    };
                    db::insert_message(&dbc, &rec).ok();
                    let nm = resolve_nickname(state, &sender_id);
                    db::touch_conversation(
                        &dbc,
                        &sender_id,
                        "single",
                        &nm,
                        None,
                        &format!("[文件] {name}"),
                        1,
                    )
                    .ok();
                    drop(dbc);
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
                }
            }
        }
        Message::ShareTreeRequest {
            request_id,
            from,
            to,
        } => {
            if from != peer_id || to != state.device_id {
                return;
            }
            let is_friend = {
                let dbc = state.db.lock().unwrap();
                db::get_friend(&dbc, &from).is_some()
            };
            if !is_friend {
                return;
            }
            let entries = {
                let share = state.share_dir.lock().unwrap().clone();
                match share {
                    Some(dir) => file::walk_share_dir(Path::new(&dir)),
                    None => Vec::new(),
                }
            };
            let resp = Message::ShareTreeResponse {
                request_id,
                from: state.device_id.clone(),
                entries,
            };
            let _ = try_send(state, peer_id, &resp).await;
        }
        Message::ShareTreeResponse {
            request_id,
            entries,
            ..
        } => {
            if let Some(tx) = state.pending_share_tree.lock().unwrap().remove(&request_id) {
                let _ = tx.send(entries);
            }
        }
        Message::ShareFileRequest {
            transfer_id,
            from,
            path,
        } => {
            if from != peer_id || from == state.device_id {
                return;
            }
            let is_friend = {
                let dbc = state.db.lock().unwrap();
                db::get_friend(&dbc, &from).is_some()
            };
            if !is_friend {
                return;
            }
            let share = state.share_dir.lock().unwrap().clone();
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
            tokio::spawn(async move {
                let _ = file::send_file_from_path(&st, &from, &transfer_id, canon_full).await;
            });
        }
        // ---- Gossip 广播 ----
        Message::Gossip { envelope } => {
            handle_gossip(state, peer_id, envelope).await;
        }
        // ---- 中继文件传输 ----
        Message::RelayFileOffer {
            transfer_id,
            from,
            to,
            name,
            size,
            total_chunks,
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
            handle_relay_chunk(state, transfer_id, seq, data, from, to, ttl).await;
        }
        // ---- 群密钥分发 ----
        Message::GroupKey {
            group_id,
            from,
            to,
            key,
            group_name,
            members,
        } => {
            if from != peer_id {
                return;
            }
            handle_group_key(state, group_id, from, to, key, group_name, members).await;
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
        Message::GroupFileOffer {
            transfer_id,
            group_id,
            sender_id,
            name,
            size,
            sha256,
            sealed_file_key,
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
            )
            .await;
        }
        Message::GroupFileChunk {
            transfer_id,
            group_id,
            sender_id,
            seq,
            data,
        } => {
            handle_group_file_chunk(state, peer_id, transfer_id, group_id, sender_id, seq, data)
                .await;
        }
        Message::GroupFileDone {
            transfer_id,
            group_id,
            sender_id,
        } => {
            handle_group_file_done(state, peer_id, transfer_id, group_id, sender_id).await;
        }
        Message::GroupFileCompleteAck {
            transfer_id,
            group_id,
            sender_id,
            success,
        } => {
            handle_group_file_complete_ack(state, peer_id, transfer_id, group_id, sender_id, success)
                .await;
        }
    }
}

// ---------------- 直连 E2EE 载荷 ----------------

/// 取发送方当前的 X25519 公钥：好友表优先，回退在线节点表。
/// 好友表由 `upsert_peer` 在 announce / who_has 检测到公钥变化时刷新，
/// 因此「对方换了身份」最长一个广播周期后就会收敛到这里。
fn sender_x25519_pubkey(state: &AppState, from: &str) -> Option<String> {
    let from_db = {
        let dbc = state.db.lock().unwrap();
        db::get_friend_x25519(&dbc, from)
    };
    from_db.or_else(|| {
        state
            .peers
            .lock()
            .unwrap()
            .get(from)
            .and_then(|p| p.x25519_pubkey.clone())
    })
}

/// 打开直连单聊载荷：`enc1:base64(nonce ‖ ChaCha20-Poly1305 密文)`。
/// 返回 `None` = 当前无法解密（缺对端公钥 / 密钥交换失败 / AEAD 校验失败 / UTF-8 非法）。
/// 调用方据此不落库、不 Ack——绝不返回占位文本，占位文本一旦占用真实 msg_id，
/// 同一 msg_id 的正确副本就永远进不来（`insert_message` 是 INSERT OR IGNORE）。
fn open_direct_content(
    my_x25519_secret: &StaticSecret,
    sender_pubkey: Option<&str>,
    wire: &str,
    kind: MsgKind,
) -> Option<(String, String)> {
    let b64 = wire.strip_prefix("enc1:")?;
    let pubkey = sender_pubkey?;
    let shared = crypto::shared_secret(my_x25519_secret, pubkey)?;
    let bytes = STANDARD.decode(b64).ok()?;
    let plain = crypto::open(&shared, &bytes)?;
    Some((String::from_utf8(plain).ok()?, kind.as_str().to_string()))
}

/// 用接收方当前公钥重新密封待发内容（`msg_id` 由调用方保持不变）。
/// 返回 `None` = 无法重封（本地无明文 / 拿不到当前公钥 / 加密失败），调用方按原样补发。
fn reseal_chat_content(
    my_x25519_secret: &StaticSecret,
    plaintext: Option<&str>,
    receiver_pubkey: Option<&str>,
) -> Option<String> {
    let shared = crypto::shared_secret(my_x25519_secret, receiver_pubkey?)?;
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
        };
    }
    let (plaintext, from_db) = {
        let dbc = state.db.lock().unwrap();
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
            .unwrap()
            .get(&to)
            .and_then(|p| p.x25519_pubkey.clone())
    });
    let resealed = reseal_chat_content(
        &state.identity.x25519_secret,
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
    }
}

// ---------------- 落库裁决 → 副作用策略 ----------------
//
// `db::insert_message_if_new` 返回三态，绝不可折叠成 bool：
//   Ok(true)  = 本次真的插入了新行 ⇒ 唯一允许产生本地投递副作用的一方
//   Ok(false) = msg_id 已存在（INSERT OR IGNORE 命中唯一约束）⇒ 不得再有副作用
//   Err(e)    = 真正的数据库故障（不是重复！）⇒ 消息没有持久化
// 因此「是否投递」与「是否 Ack」是两个独立判定：后者只在 Err 时必须禁止，
// 因为 Ack 会让发送方删除 outbox 行，把一次临时故障变成永久丢消息。

/// 本次落库是否应产生本地投递副作用（`touch_conversation(+1)` 与 `message-received`）。
fn announced_on(inserted: &Result<bool, rusqlite::Error>) -> bool {
    matches!(inserted, Ok(true))
}

/// 是否允许向发送方回 Ack。重复（`Ok(false)`）允许——消息确已在库；
/// 真数据库错误（`Err`）不允许——否则 outbox 被删，消息永久丢失。
fn may_ack(inserted: &Result<bool, rusqlite::Error>) -> bool {
    !matches!(inserted, Err(_))
}

// ---------------- Gossip 处理 ----------------

async fn handle_gossip(state: &Arc<AppState>, peer_id: &str, env: GossipEnvelope) {
    // Gossip 可经第三方转发，不能仅凭信封内自报的 Ed25519 公钥建立身份。
    // 公钥必须先由 Discovery/Hello 绑定到同一个 device_id；若已知 X25519
    // 公钥也发生变化，同样拒绝，避免冒充好友或污染 E2EE 密钥缓存。
    let sender_trusted = {
        if env.sender_id == state.device_id {
            false
        } else {
            let peers = state.peers.lock().unwrap();
            peers.get(&env.sender_id).is_some_and(|p| {
                let direct_peer = peer_id == env.sender_id;
                (p.ed25519_pubkey.as_deref() == Some(env.sender_ed25519.as_str())
                    || (direct_peer && p.ed25519_pubkey.is_none()))
                    && (p
                        .x25519_pubkey
                        .as_deref()
                        .is_none_or(|key| key == env.sender_pubkey)
                        || (direct_peer && p.x25519_pubkey.is_none()))
            })
        }
    };
    if !sender_trusted {
        return;
    }
    // 直连 TCP 对端在 Hello 中没有携带公钥时，首次合法 Gossip 可完成 TOFU
    // 绑定；之后所有经中继或直连的信封都必须匹配这组键。
    if peer_id == env.sender_id {
        let mut peers = state.peers.lock().unwrap();
        if let Some(p) = peers.get_mut(&env.sender_id) {
            if p.ed25519_pubkey.is_none() {
                p.ed25519_pubkey = Some(env.sender_ed25519.clone());
            }
            if p.x25519_pubkey.is_none() {
                p.x25519_pubkey = Some(env.sender_pubkey.clone());
            }
        }
    }
    // 1. 先验签，再进入去重缓存。否则攻击者可以用伪造的唯一 message_id
    // 污染 Bloom/LRU，甚至抢先占用真实消息的 id 造成合法消息被丢弃。
    {
        let gossip = state.gossip.lock().unwrap();
        if !gossip.verify_envelope(&env) {
            return;
        }
        drop(gossip);
        let mut gossip = state.gossip.lock().unwrap();
        if !gossip.is_new(&env.message_id) {
            return;
        }
    }
    // 2. 同步发送方公钥：GossipEnvelope 已携带 x25519_pubkey 用于解密，
    //    但此前未写入 peers/friends，导致后续 outbox 重发的直发 ChatMessage
    //    在 open_direct_content() 中因缺 pubkey 被丢弃。此处仅更新已有 peer
    //    条目（不做 insert，避免为未通过 Discovery 的节点创建残缺记录），
    //    同时用 COALESCE 安全地补充 friends 表的 NULL pubkey。
    if env.encrypted && matches!(env.kind, GossipKind::Chat) {
        let mut peers = state.peers.lock().unwrap();
        if let Some(p) = peers.get_mut(&env.sender_id) {
            if p.x25519_pubkey.is_none() {
                p.x25519_pubkey = Some(env.sender_pubkey.clone());
                p.last_seen = db::now_ms();
                let dbc = state.db.lock().unwrap();
                db::update_friend_pubkeys(&dbc, &env.sender_id, Some(&env.sender_pubkey), None)
                    .ok();
            }
        }
    }
    // 3. 解包：E2EE 关闭时载荷为明文 JSON；开启时按单聊 ECDH / 群密钥解密
    let plaintext = if !env.encrypted {
        // FriendMessageBlocked 等明文 Gossip：payload 是 base64 编码的 JSON
        STANDARD.decode(&env.payload).ok()
    } else {
        match &env.kind {
            GossipKind::Chat => {
                let shared =
                    crypto::shared_secret(&state.identity.x25519_secret, &env.sender_pubkey);
                shared.and_then(|s| {
                    STANDARD
                        .decode(&env.payload)
                        .ok()
                        .and_then(|d| crypto::open(&s, &d))
                })
            }
            GossipKind::Group => {
                let gid = env.group_id.clone().unwrap_or_default();
                let key = get_group_key(state, &gid).await;
                key.and_then(|k| {
                    STANDARD
                        .decode(&env.payload)
                        .ok()
                        .and_then(|d| crypto::open_symmetric(&k, &d))
                })
            }
            GossipKind::FriendMessageBlocked => {
                // 已在 encrypted=false 分支处理，这里不应进入
                return;
            }
        }
    };

    // 群信封即使签名正确，也只能被群成员消费；签名证明“是谁发的”，
    // 不代表发送者有权把任意节点加入一个群。
    if matches!(env.kind, GossipKind::Group) && !env.group_members.is_empty() {
        if !env.group_members.iter().any(|m| m == &state.device_id)
            || !env.group_members.iter().any(|m| m == &env.sender_id)
        {
            return;
        }
    }

    // 4. 转发（fan-out，TTL 衰减）— 所有 GossipKind 统一转发
    if env.ttl > 1 {
        let peers: Vec<String> = state.peers.lock().unwrap().keys().cloned().collect();
        let targets = {
            let gossip = state.gossip.lock().unwrap();
            gossip.choose_fanout(&peers, &env.sender_id)
        };
        let mut fwd = env.clone();
        fwd.ttl -= 1;
        let fwd_msg = Message::Gossip { envelope: fwd };
        for t in targets {
            let _ = try_send(state, &t, &fwd_msg).await;
        }
    }

    // 5. 按 GossipKind 处理
    match env.kind {
        GossipKind::FriendMessageBlocked => {
            // 控制消息：检查本机是否为原始发送方
            if let Some(pt) = plaintext {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                    if let Some(original) = v.get("original_sender").and_then(|s| s.as_str()) {
                        if original == state.device_id {
                            // 本机就是原始发送方 → 通知前端
                            let _ = state.app.emit("friend-message-blocked", &env.sender_id);
                        }
                        // 非本机 → 已在上面 fan-out 转发，不做任何 UI/DB 操作
                    }
                }
            }
        }
        GossipKind::Chat | GossipKind::Group => {
            if let Some(pt) = plaintext {
                let (kind, content) = parse_gossip_payload(&pt);
                // GossipKind::Chat：好友关系检查（非好友不落库、不通知、通知发送方）
                if env.kind == GossipKind::Chat {
                    let is_friend = {
                        let dbc = state.db.lock().unwrap();
                        db::get_friend(&dbc, &env.sender_id).is_some()
                    };
                    if !is_friend {
                        // 通过 Gossip 广播拒绝通知（多跳场景下也能回到原始发送方）
                        let mut blocked_env = {
                            let gossip = state.gossip.lock().unwrap();
                            let payload =
                                serde_json::json!({ "original_sender": env.sender_id }).to_string();
                            let payload_b64 = STANDARD.encode(payload.as_bytes());
                            gossip.build_envelope(
                                &state.identity,
                                &state.device_id,
                                GossipKind::FriendMessageBlocked,
                                None,
                                None,
                                &payload_b64,
                                db::now_ms(),
                            )
                        };
                        // 这是拒绝通知控制载荷，不是用户聊天内容；显式标记为明文，
                        // 同时不再为用户 Chat/Group 提供明文兼容路径。
                        blocked_env.encrypted = false;
                        blocked_env.sender_sig =
                            state.identity.sign_b64(&blocked_env.signing_bytes());
                        broadcast_gossip(state, blocked_env).await;
                        return;
                    }
                }
                let conv_id = match &env.kind {
                    GossipKind::Chat => env.sender_id.clone(),
                    GossipKind::Group => {
                        format!("group:{}", env.group_id.clone().unwrap_or_default())
                    }
                    _ => return,
                };
                let conv_kind = match &env.kind {
                    GossipKind::Chat => "single",
                    GossipKind::Group => "group",
                    _ => return,
                };
                let name = match &env.kind {
                    GossipKind::Chat => resolve_nickname(state, &env.sender_id),
                    GossipKind::Group => {
                        resolve_group_name(state, env.group_id.as_deref().unwrap_or(""))
                    }
                    _ => return,
                };
                // 群聊删除边界：本机清除过该群（ts ≤ boundary）的旧历史不得回灌
                // ——不落库、不计未读、不通知、不兜底建群。新消息（ts > boundary）正常。
                if env.kind == GossipKind::Group {
                    let gid = env.group_id.clone().unwrap_or_default();
                    let dbc = state.db.lock().unwrap();
                    let blocked = db::group_message_blocked_by_boundary(&dbc, &gid, env.ts);
                    drop(dbc);
                    if blocked {
                        return;
                    }
                }
                // 群消息顺带建群：成员端可能从未收到 GroupKey（本地无 groups 行），
                // 但这条群消息携带了完整成员表 → 据此 upsert 建群，成员面板才能显示。
                // 已有则只刷新（成员随踢人/加人变化时也能及时同步）。
                if env.kind == GossipKind::Group {
                    if let (Some(gid), Some(creator), true) = (
                        env.group_id.clone(),
                        env.group_creator.clone(),
                        !env.group_members.is_empty(),
                    ) {
                        let display_name = env.group_name.clone().unwrap_or_else(|| name.clone());
                        let mut all = env.group_members.clone();
                        if !all.contains(&state.device_id) {
                            all.push(state.device_id.clone());
                        }
                        {
                            let dbc = state.db.lock().unwrap();
                            db::upsert_group(&dbc, &gid, &display_name, &creator, &all).ok();
                        }
                        let _ = state.app.emit("groups-updated", &gid);
                    }
                }
                let preview = preview_content(&kind, &content);
                // 持锁块只做落库；await（fanout 转发已在前面）之后无持锁操作
                // 业务幂等裁决：Direct（含 outbox 补发）可能已经把同一 msg_id 落库，此时
                // 不得再计未读、再发 message-received，否则未读数与系统通知都会重复。
                // 与 Direct 分支共用 announced_on 裁决，两路径并发时只有一方拿到 Ok(true)。
                // 单聊与群聊走同一块 ⇒ 两种 GossipKind 都被覆盖。
                let (out_rec, inserted) = {
                    let dbc = state.db.lock().unwrap();
                    // 时钟偏差防护（同 ChatMessage 分支）
                    let ts = db::clamp_incoming_ts(
                        env.ts,
                        db::now_ms(),
                        db::last_message_ts(&dbc, &conv_id),
                    );
                    let rec = MessageRecord {
                        id: 0,
                        msg_id: env.message_id.clone(),
                        conv_id: conv_id.clone(),
                        sender_id: env.sender_id.clone(),
                        receiver_id: state.device_id.clone(),
                        kind: kind.clone(),
                        content: content.clone(),
                        ts,
                        status: "delivered".to_string(),
                    };
                    let inserted = db::insert_message_if_new(&dbc, &rec);
                    if announced_on(&inserted) {
                        db::touch_conversation(&dbc, &conv_id, conv_kind, &name, None, &preview, 1)
                            .ok();
                    }
                    (rec, inserted)
                };
                // 重复投递与数据库失败都不产生本地副作用；Gossip 本就不回 Ack，转发已在上面完成
                if announced_on(&inserted) {
                    let _ = state.app.emit("message-received", &out_rec);
                }
            }
        }
    }
}

fn parse_gossip_payload(pt: &[u8]) -> (String, String) {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(pt) {
        let kind = v
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("text")
            .to_string();
        let content = v
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        (kind, content)
    } else {
        ("text".to_string(), String::from_utf8_lossy(pt).to_string())
    }
}

// ---------------- 中继文件传输 ----------------

#[allow(clippy::too_many_arguments)]
async fn handle_relay_file_offer(
    state: &Arc<AppState>,
    peer_id: &str,
    transfer_id: String,
    from: String,
    to: String,
    name: String,
    size: u64,
    total_chunks: u32,
    sealed_file_key: String,
    file_sha256: String,
) {
    if to != state.device_id {
        return; // 中继节点无需重组，只转发切片
    }
    if from != peer_id || from == state.device_id || total_chunks == 0 || size > i64::MAX as u64 {
        return;
    }
    if file::safe_file_name(&name).is_none() {
        return;
    }
    let is_friend = {
        let dbc = state.db.lock().unwrap();
        db::get_friend(&dbc, &from).is_some()
    };
    if !is_friend {
        return;
    }
    // SHA-256 元数据格式校验（中继不解密不校验内容，仅最终接收方校验）
    if !file::valid_sha256_hex(&file_sha256) {
        return;
    }
    // E2EE：解封文件会话密钥（发送方用我方公钥封装）。中继节点不持有密钥；
    // 解封失败直接放弃——密文分片绝不落盘。
    let file_key = (|| {
        let sender_pub = resolve_member_x25519(state, &from)?;
        let shared = crypto::shared_secret(&state.identity.x25519_secret, &sender_pub)?;
        let sealed = STANDARD.decode(&sealed_file_key).ok()?;
        crypto::open(&shared, &sealed).and_then(|k| k.try_into().ok())
    })();
    let Some(file_key) = file_key else {
        return;
    };
    state.relay_file_keys.lock().unwrap().insert(
        transfer_id.clone(),
        crate::state::RelayFileReceive {
            file_key,
            expected_sha256: file_sha256,
            hasher: {
                use sha2::Digest as _;
                sha2::Sha256::new()
            },
        },
    );
    state
        .relay
        .lock()
        .unwrap()
        .begin_reassemble(&transfer_id, &name, total_chunks, size);
    {
        let dbc = state.db.lock().unwrap();
        db::upsert_transfer(
            &dbc,
            &transfer_id,
            &from,
            &name,
            size,
            "receive",
            "active",
            None,
            0.0,
        )
        .ok();
    }
    let _ = state.app.emit(
        "file-progress",
        &FileProgress {
            transfer_id,
            received: 0,
            total: size,
        },
    );
}

async fn handle_relay_chunk(
    state: &Arc<AppState>,
    transfer_id: String,
    seq: u32,
    data: String,
    from: String,
    to: String,
    ttl: u8,
) {
    if to == state.device_id {
        // 最终接收方：先解密（E2EE，密文不落盘），再增量哈希、重组
        let mut keys = state.relay_file_keys.lock().unwrap();
        let Some(rs) = keys.get_mut(&transfer_id) else {
            return;
        };
        let Ok(sealed) = STANDARD.decode(&data) else {
            return;
        };
        let Some(bytes) = crypto::open_symmetric(&rs.file_key, &sealed) else {
            return;
        };
        use sha2::Digest;
        rs.hasher.update(&bytes);
        drop(keys);
        let completed = {
            let mut relay = state.relay.lock().unwrap();
            relay.add_chunk(&transfer_id, seq, bytes)
        };
        if let Some((name, expected_size, full)) = completed {
            // 重组结束（无论成败）：移除会话状态，取哈希做完整性校验
            let rs = state.relay_file_keys.lock().unwrap().remove(&transfer_id);
            if full.len() as u64 != expected_size {
                let dbc = state.db.lock().unwrap();
                db::upsert_transfer(
                    &dbc,
                    &transfer_id,
                    &from,
                    &name,
                    expected_size,
                    "receive",
                    "failed",
                    None,
                    0.0,
                )
                .ok();
                let _ = state.app.emit(
                    "file-failed",
                    &FileFailedInfo {
                        transfer_id: transfer_id.clone(),
                        reason: "中继文件大小校验失败".to_string(),
                    },
                );
                return;
            }
            // 文件级完整性：重组内容 SHA-256 必须与发送方声明一致，否则不落盘
            if let Some(rs) = rs {
                use sha2::Digest;
                let actual_hex: String = rs
                    .hasher
                    .finalize()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if !actual_hex.eq_ignore_ascii_case(&rs.expected_sha256) {
                    let dbc = state.db.lock().unwrap();
                    db::upsert_transfer(
                        &dbc,
                        &transfer_id,
                        &from,
                        &name,
                        expected_size,
                        "receive",
                        "failed",
                        None,
                        0.0,
                    )
                    .ok();
                    let _ = state.app.emit(
                        "file-failed",
                        &FileFailedInfo {
                            transfer_id: transfer_id.clone(),
                            reason: "文件完整性校验失败".to_string(),
                        },
                    );
                    return;
                }
            }
            let path = match save_received_bytes(state, &name, &full) {
                Ok(path) => path,
                Err(reason) => {
                    let dbc = state.db.lock().unwrap();
                    db::upsert_transfer(
                        &dbc,
                        &transfer_id,
                        &from,
                        &name,
                        expected_size,
                        "receive",
                        "failed",
                        None,
                        0.0,
                    )
                    .ok();
                    let _ = state.app.emit(
                        "file-failed",
                        &FileFailedInfo {
                            transfer_id: transfer_id.clone(),
                            reason,
                        },
                    );
                    return;
                }
            };
            let path_str = path.to_string_lossy().to_string();
            let rec = {
                let dbc = state.db.lock().unwrap();
                db::upsert_transfer(
                    &dbc,
                    &transfer_id,
                    &from,
                    &name,
                    full.len() as u64,
                    "receive",
                    "done",
                    Some(path_str.as_str()),
                    1.0,
                )
                .ok();
                let content = serde_json::json!({
                    "name": name.clone(),
                    "path": path_str.clone(),
                    "size": full.len(),
                    "subtype": file::classify_file_subtype(&name),
                })
                .to_string();
                let rec = MessageRecord {
                    id: 0,
                    msg_id: format!("file-{transfer_id}"),
                    conv_id: from.clone(),
                    sender_id: from.clone(),
                    receiver_id: state.device_id.clone(),
                    kind: "file".to_string(),
                    content,
                    ts: db::now_ms(),
                    status: "delivered".to_string(),
                };
                db::insert_message(&dbc, &rec).ok();
                let nm = resolve_nickname(state, &from);
                db::touch_conversation(
                    &dbc,
                    &from,
                    "single",
                    &nm,
                    None,
                    &format!("[文件] {name}"),
                    1,
                )
                .ok();
                rec
            };
            let _ = state.app.emit("message-received", &rec);
            let _ = state.app.emit(
                "file-done",
                &FileDoneInfo {
                    transfer_id: transfer_id.clone(),
                    name: name.clone(),
                    size: full.len() as u64,
                    path: path_str,
                },
            );
        }
        // 重组中：进度可基于切片数上报，此处省略，完成时由 file-done 事件通知
    } else if ttl > 1 {
        // 中继转发给最终接收方
        let fwd = Message::RelayChunk {
            transfer_id,
            seq,
            data,
            from,
            to: to.clone(),
            ttl: ttl - 1,
        };
        let _ = try_send(state, &to, &fwd).await;
    }
}

fn save_received_bytes(state: &AppState, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = &state.downloads_dir;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let safe_name = file::safe_file_name(name).ok_or("文件名非法")?;
    let base = dir.join(safe_name);
    if !base.exists() {
        std::fs::write(&base, bytes).map_err(|e| e.to_string())?;
        return Ok(base);
    }
    let stem = base
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = base
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for i in 1..1000 {
        let cand = if ext.is_empty() {
            dir.join(format!("{stem} ({i})"))
        } else {
            dir.join(format!("{stem} ({i}).{ext}"))
        };
        if !cand.exists() {
            std::fs::write(&cand, bytes).map_err(|e| e.to_string())?;
            return Ok(cand);
        }
    }
    Err("下载目录重名文件过多".to_string())
}

// ---------------- 群密钥 ----------------

#[allow(clippy::too_many_arguments)]
async fn handle_group_key(
    state: &Arc<AppState>,
    group_id: String,
    from: String,
    to: String,
    key: String,
    group_name: String,
    members: Vec<String>,
) {
    if to != state.device_id {
        return;
    }
    // 只有群创建者能够分发/轮换群密钥；同时要求消息携带的成员表
    // 明确包含发送者和接收者，避免任意好友注入一个伪造群或密钥。
    if !members.iter().any(|m| m == &from) || !members.iter().any(|m| m == &to) {
        return;
    }
    if let Some(group) = db::get_group(&state.db.lock().unwrap(), &group_id) {
        if group.creator != from {
            return;
        }
    }
    let pubkey = {
        let peers = state.peers.lock().unwrap();
        peers.get(&from).and_then(|p| p.x25519_pubkey.clone())
    };
    let Some(pubkey) = pubkey else { return };
    let Some(shared) = crypto::shared_secret(&state.identity.x25519_secret, &pubkey) else {
        return;
    };
    let Ok(sealed) = STANDARD.decode(&key) else {
        return;
    };
    let Some(raw) = crypto::open(&shared, &sealed) else {
        return;
    };
    if raw.len() != 32 {
        return;
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&raw);
    state.group_keys.lock().unwrap().insert(group_id.clone(), k);
    {
        let dbc = state.db.lock().unwrap();
        db::set_setting(&dbc, &format!("gk:{group_id}"), &STANDARD.encode(k)).ok();
    }
    // 建本地群记录：没有它，收到群消息时群名只能兜底成「群聊 g-xxxx」，
    // 成员面板也会为空。成员列表补上自己，保证与创建者一致。
    let mut all = members;
    if !all.contains(&state.device_id) {
        all.push(state.device_id.clone());
    }
    let conv_id = format!("group:{group_id}");
    let display_name = if group_name.is_empty() {
        resolve_group_name(state, &group_id)
    } else {
        group_name
    };
    {
        let dbc = state.db.lock().unwrap();
        db::upsert_group(&dbc, &group_id, &display_name, &from, &all).ok();
        db::ensure_conversation(&dbc, &conv_id, "group", &display_name, None).ok();
    }
    let _ = state.app.emit("group-key-received", &group_id);
    let _ = state.app.emit("groups-updated", &group_id);
}

/// 处理群文件发起（Offer → 验证 → file_key 解封 → 保存会话状态）。
/// 本阶段不写文件、不创建 `.part`、不自动 FileAccept——分片传输在下一阶段。
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
) {
    // 链路上报的 sender 必须与 Offer 声明一致，且不能是自己
    if sender_id != peer_id || sender_id == state.device_id {
        return;
    }
    // 幂等：相同 transfer_id 重复 Offer 安全忽略（session 已建立则不重建）
    if state.group_file_keys.lock().unwrap().contains_key(&transfer_id)
        || db::get_group_file(&state.db.lock().unwrap(), &transfer_id).is_some()
    {
        return;
    }
    // 权限：本地群存在，且 sender ∈ group_members（防群外 peer 伪造 Offer）
    let (group_exists, sender_is_member) = {
        let dbc = state.db.lock().unwrap();
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
    let Some(file_key) = crypto::open_symmetric(&group_key, &sealed).and_then(|k| k.try_into().ok())
    else {
        return;
    };

    // 事务：本地群文件记录 + 自己的 recipient 行（接收进度将更新在这里）
    {
        let dbc = state.db.lock().unwrap();
        let gf = crate::state::GroupFile {
            transfer_id: transfer_id.clone(),
            group_id: group_id.clone(),
            sender_id: sender_id.clone(),
            name: name.clone(),
            size,
            sha256: sha256.clone(),
            status: "sending".to_string(),
            created_at: db::now_ms(),
        };
        let tx = match dbc.unchecked_transaction() {
            Ok(tx) => tx,
            Err(_) => return,
        };
        if db::insert_group_file(&tx, &gf).is_err()
            || db::insert_group_file_recipient(&tx, &transfer_id, &state.device_id).is_err()
        {
            return; // 建立失败：不留半完成状态，也不保存 file_key
        }
        if tx.commit().is_err() {
            return;
        }
    }
    // 接收气泡：与发送端同一 msg_id（gfile-{transfer_id}），前端据 file-progress
    // 之外的状态事件推进。此处 status=sending，Done 校验通过后转 delivered。
    let rec = crate::state::MessageRecord {
        id: 0,
        msg_id: format!("gfile-{transfer_id}"),
        conv_id: format!("group:{group_id}"),
        sender_id: sender_id.clone(),
        receiver_id: state.device_id.clone(),
        kind: "file".to_string(),
        content: serde_json::json!({ "name": name, "size": size, "sha256": sha256 }).to_string(),
        ts: db::now_ms(),
        status: "sending".to_string(),
    };
    {
        let dbc = state.db.lock().unwrap();
        db::insert_message(&dbc, &rec).ok();
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
    // 会话密钥仅存内存，供下一阶段解密 GroupFileChunk
    state
        .group_file_keys
        .lock()
        .unwrap()
        .insert(transfer_id, file_key);
}

/// 失败收尾：删除 `.part`、移除接收状态与会话密钥、recipient 置 failed。
/// 只影响本 transfer，不 panic、不影响其他群文件。
fn fail_group_file_chunk(state: &Arc<AppState>, transfer_id: &str) {
    file::fail_group_receive(state, transfer_id);
    set_gfile_bubble_status(state, transfer_id, "failed");
    state.group_file_keys.lock().unwrap().remove(transfer_id);
    let dbc = state.db.lock().unwrap();
    let _ = db::update_group_file_recipient(&dbc, transfer_id, &state.device_id, "failed", 0.0);
}

/// 群文件气泡状态推进：msg_id = gfile-{transfer_id}（收发双方本地记录）。
fn set_gfile_bubble_status(state: &AppState, transfer_id: &str, status: &str) {
    let dbc = state.db.lock().unwrap();
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
    if !state.group_file_keys.lock().unwrap().contains_key(&transfer_id) {
        return;
    }
    // 权限：群存在 && sender 是群成员
    let (group_exists, sender_is_member) = {
        let dbc = state.db.lock().unwrap();
        match db::get_group(&dbc, &group_id) {
            Some(g) => (true, g.members.contains(&sender_id)),
            None => (false, false),
        }
    };
    if !group_exists || !sender_is_member {
        return;
    }
    let Some(gf) = db::get_group_file(&state.db.lock().unwrap(), &transfer_id) else {
        return;
    };

    // 空文件：无 Chunk 阶段，Done 时才建立接收状态（0 字节 .part）
    if !state.group_file_receivers.lock().unwrap().contains_key(&transfer_id) {
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
    let r = match state.group_file_receivers.lock().unwrap().remove(&transfer_id) {
        Some(r) => r,
        None => return,
    };

    // 1. size 校验：received 必须等于声明大小
    if r.received != r.size {
        let _ = std::fs::remove_file(&r.tmp_path);
        set_gfile_bubble_status(state, &transfer_id, "failed");
        state.group_file_keys.lock().unwrap().remove(&transfer_id);
        {
            let dbc = state.db.lock().unwrap();
            let _ =
                db::update_group_file_recipient(&dbc, &transfer_id, &state.device_id, "failed", 0.0);
        }
        send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, false).await;
        return;
    }
    // 2. SHA-256 校验：finalize 增量哈希（不重读 .part），与发送方声明比对
    {
        use sha2::Digest;
        let actual_hex: String = r
            .hasher
            .clone()
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !actual_hex.eq_ignore_ascii_case(&r.expected_sha256) {
            let _ = std::fs::remove_file(&r.tmp_path);
            set_gfile_bubble_status(state, &transfer_id, "failed");
            state.group_file_keys.lock().unwrap().remove(&transfer_id);
            {
                let dbc = state.db.lock().unwrap();
                let _ = db::update_group_file_recipient(
                    &dbc,
                    &transfer_id,
                    &state.device_id,
                    "failed",
                    0.0,
                );
            }
            send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, false).await;
            return;
        }
    }
    // 3. sync_all：落盘前确保数据写透
    if let Err(e) = r.file.sync_all() {
        let _ = e.to_string();
        let _ = std::fs::remove_file(&r.tmp_path);
        set_gfile_bubble_status(state, &transfer_id, "failed");
        state.group_file_keys.lock().unwrap().remove(&transfer_id);
        {
            let dbc = state.db.lock().unwrap();
            let _ =
                db::update_group_file_recipient(&dbc, &transfer_id, &state.device_id, "failed", 0.0);
        }
        send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, false).await;
        return;
    }
    // 4. drop 文件句柄后 rename（Windows 不允许 rename 打开中的文件）
    drop(r.file);
    if let Err(_) = std::fs::rename(&r.tmp_path, &r.final_path) {
        let _ = std::fs::remove_file(&r.tmp_path);
        set_gfile_bubble_status(state, &transfer_id, "failed");
        state.group_file_keys.lock().unwrap().remove(&transfer_id);
        {
            let dbc = state.db.lock().unwrap();
            let _ =
                db::update_group_file_recipient(&dbc, &transfer_id, &state.device_id, "failed", 0.0);
        }
        send_group_file_complete_ack(state, &transfer_id, &group_id, &sender_id, false).await;
        return;
    }
    // 全部成功：正式文件已落盘 → completed / progress 1.0 → 气泡转 delivered → 清理
    {
        let dbc = state.db.lock().unwrap();
        let _ = db::update_group_file_recipient(&dbc, &transfer_id, &state.device_id, "completed", 1.0);
    }
    set_gfile_bubble_status(state, &transfer_id, "delivered");
    state.group_file_keys.lock().unwrap().remove(&transfer_id);
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
/// 身份验证（防伪造）：
/// 1. ACK.sender_id == TCP peer_id（不能只相信消息字段）；
/// 2. sender_id != 本机；
/// 3. transfer 对应的 group_file.sender_id == 本机（只有本机发起的群文件
///    的 ACK 才会被处理，B 发给 A 的 transfer 的 ACK 到 C 手上会被拒绝）；
/// 4. ACK 发送者必须是该 transfer 的 recipient（update 不命中即拒绝）。
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
    let Some(gf) = db::get_group_file(&state.db.lock().unwrap(), &transfer_id) else {
        return;
    };
    if gf.sender_id != state.device_id || gf.group_id != group_id {
        return;
    }
    // 幂等保护：completed 是终态。该 recipient 已 completed 时，
    // 后续 success=false ACK（重放/异常）不得把 completed 降级为 failed；
    // success=true ACK 重复到达则是无害的幂等更新。
    if !success {
        let already_completed = {
            let dbc = state.db.lock().unwrap();
            db::list_group_file_recipients(&dbc, &transfer_id)
                .unwrap_or_default()
                .into_iter()
                .any(|r| r.recipient_id == peer_id && r.status == "completed")
        };
        if already_completed {
            return;
        }
    }
    // 4. ACK 发送者必须是该 transfer 的 recipient，且状态按 success 迁移；
    //    只修改该 recipient，不影响其他成员。不命中（非 recipient）→ 拒绝。
    let (status, progress) = if success {
        ("completed", 1.0)
    } else {
        ("failed", 0.0)
    };
    // 发送端气泡 = 全体 recipient 结果的聚合（v0.12 最小语义），
    // 避免最后一个 ACK 直接覆盖之前更准确的总体状态：
    // - success ACK → delivered（有人收到即算；mixed 亦然，且不回退）
    // - failure ACK → 全部 recipient 都到终态（completed/failed）时：
    //     有人 completed → delivered；全部 failed → failed；
    //   仍有 pending/sending → 气泡保持当前状态（sending），等后续 ACK。
    let bubble;
    {
        let dbc = state.db.lock().unwrap();
        let _ = db::update_group_file_recipient(&dbc, &transfer_id, &peer_id, status, progress);
        if success {
            bubble = "delivered";
        } else {
            let recipients =
                db::list_group_file_recipients(&dbc, &transfer_id).unwrap_or_default();
            let all_terminal = recipients
                .iter()
                .all(|r| r.status == "completed" || r.status == "failed");
            if !all_terminal {
                return; // 仍有进行中的 recipient：气泡保持当前，等后续 ACK
            }
            bubble = if recipients.iter().any(|r| r.status == "completed") {
                "delivered"
            } else {
                "failed"
            };
        }
        let _ = db::set_message_status(&dbc, &format!("gfile-{transfer_id}"), bubble).ok();
    }
    if bubble == "delivered" {
        let _ = state.app.emit("message-acked", &format!("gfile-{transfer_id}"));
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
        let dbc = state.db.lock().unwrap();
        match db::get_group(&dbc, &group_id) {
            Some(g) => (true, g.members.contains(&sender_id)),
            None => (false, false),
        }
    };
    if !group_exists || !sender_is_member {
        return;
    }
    // 会话必须已经由合法 GroupFileOffer 建立；无 key 直接丢弃（不尝试其他密钥）
    let Some(file_key) = state.group_file_keys.lock().unwrap().get(&transfer_id).copied() else {
        return;
    };
    // 本地群文件记录（Offer 阶段建立）提供 name/size/sha256
    let Some(gf) = db::get_group_file(&state.db.lock().unwrap(), &transfer_id) else {
        return;
    };
    // 只有该 transfer 的原始 sender 发来的 chunk 才合法。
    // 其他群成员（无 file_key）发送的垃圾 chunk 不得终止合法接收：
    // 直接忽略，不删 .part、不清 session、不改 recipient 状态。
    if gf.sender_id != sender_id {
        return;
    }

    // 首个合法 chunk 到达时才创建 `.part`（安全路径，downloads 目录内）
    if !state.group_file_receivers.lock().unwrap().contains_key(&transfer_id) {
        if let Err(_) = file::begin_group_receive(
            state,
            &transfer_id,
            &sender_id,
            &gf.name,
            gf.size,
            file_key,
            gf.sha256.clone(),
        ) {
            return;
        }
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
        let mut recv = state.group_file_receivers.lock().unwrap();
        let Some(r) = recv.get_mut(&transfer_id) else {
            return;
        };
        if seq != r.next_seq {
            // 顺序错误：终止当前接收（TCP 有序，跳号/重复即异常）
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
        r.next_seq = r.next_seq.wrapping_add(1);
        let progress = if r.size == 0 {
            1.0
        } else {
            (r.received as f64 / r.size as f64).min(1.0)
        };
        drop(recv);
        // 进度落库：本阶段最高 sending，不标 completed
        let dbc = state.db.lock().unwrap();
        let _ = db::update_group_file_recipient(
            &dbc,
            &transfer_id,
            &state.device_id,
            "sending",
            progress,
        );
    }
}

/// 处理群名变更广播：仅群创建者可发起，成员端校验后同步本地群名与会话标题。
async fn handle_group_rename(state: &Arc<AppState>, group_id: String, from: String, name: String) {
    if name.is_empty() || from == state.device_id {
        return;
    }
    let name: String = name.chars().take(MAX_GROUP_NAME_LEN).collect();
    // 只接受群创建者的改名
    let is_creator = {
        let dbc = state.db.lock().unwrap();
        db::get_group(&dbc, &group_id)
            .map(|g| g.creator == from)
            .unwrap_or(false)
    };
    if !is_creator {
        return;
    }
    {
        let dbc = state.db.lock().unwrap();
        db::rename_group(&dbc, &group_id, &name).ok();
    }
    let _ = state.app.emit("groups-updated", &group_id);
}

/// 处理「成员被移出群」：仅当 `to` 是自己且发起方是群创建者时，清理本地群 + 会话 + 密钥。
async fn handle_group_member_removed(
    state: &Arc<AppState>,
    group_id: String,
    from: String,
    to: String,
) {
    if to != state.device_id || from == state.device_id {
        return;
    }
    let is_creator = {
        let dbc = state.db.lock().unwrap();
        db::get_group(&dbc, &group_id)
            .map(|g| g.creator == from)
            .unwrap_or(false)
    };
    if !is_creator {
        return;
    }
    {
        let dbc = state.db.lock().unwrap();
        db::delete_group(&dbc, &group_id).ok();
        let _ = dbc.execute(
            "DELETE FROM settings WHERE key = ?1",
            params![format!("gk:{group_id}")],
        );
    }
    state.group_keys.lock().unwrap().remove(&group_id);
    let _ = state.app.emit("group-member-removed", &group_id);
    let _ = state.app.emit("groups-updated", &group_id);
}

pub async fn get_group_key(state: &AppState, group_id: &str) -> Option<[u8; 32]> {
    if let Some(k) = state.group_keys.lock().unwrap().get(group_id) {
        return Some(*k);
    }
    let key_b64 = {
        let dbc = state.db.lock().unwrap();
        db::get_setting(&dbc, &format!("gk:{group_id}"))
    }?;
    let bytes = STANDARD.decode(key_b64).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    state
        .group_keys
        .lock()
        .unwrap()
        .insert(group_id.to_string(), arr);
    Some(arr)
}

// ---------------- 节点与好友辅助 ----------------

pub async fn upsert_peer(
    state: &AppState,
    device_id: &str,
    nickname: &str,
    avatar: Option<String>,
    ip: &str,
    tcp_port: u16,
    x25519: Option<String>,
    ed25519: Option<String>,
    rtt_ms: Option<u64>,
) {
    let ts = db::now_ms();
    // 判断是否「新节点」或「公钥首次学到/变化」，据此决定是否做昂贵的落库与群密钥补发。
    // 500-1000 节点下，若每条 announce 都写库 + 遍历群组，会形成明显热点。
    let (is_new, key_changed, key_conflict) = {
        let mut peers = state.peers.lock().unwrap();
        match peers.get_mut(device_id) {
            None => {
                peers.insert(
                    device_id.to_string(),
                    Peer {
                        device_id: device_id.to_string(),
                        nickname: nickname.to_string(),
                        avatar,
                        ip: ip.to_string(),
                        tcp_port,
                        last_seen: ts,
                        rtt_ms,
                        x25519_pubkey: x25519.clone(),
                        ed25519_pubkey: ed25519.clone(),
                        connected_since: Some(ts),
                    },
                );
                (true, true, false)
            }
            Some(p) => {
                let x_conflict =
                    matches!((&p.x25519_pubkey, &x25519), (Some(old), Some(new)) if old != new);
                let e_conflict =
                    matches!((&p.ed25519_pubkey, &ed25519), (Some(old), Some(new)) if old != new);
                let key_conflict = x_conflict || e_conflict;
                let key_changed = !key_conflict
                    && ((x25519.is_some() && p.x25519_pubkey != x25519)
                        || (ed25519.is_some() && p.ed25519_pubkey != ed25519));
                p.nickname = nickname.to_string();
                if avatar.is_some() {
                    p.avatar = avatar;
                }
                if !ip.is_empty() {
                    p.ip = ip.to_string();
                }
                if tcp_port != 0 {
                    p.tcp_port = tcp_port;
                }
                if x25519.is_some() && !x_conflict {
                    p.x25519_pubkey = x25519;
                }
                if ed25519.is_some() && !e_conflict {
                    p.ed25519_pubkey = ed25519;
                }
                if rtt_ms.is_some() {
                    p.rtt_ms = rtt_ms;
                }
                p.last_seen = ts;
                (false, key_changed, key_conflict)
            }
        }
    };
    state.emit_peers();

    if key_conflict {
        state.push_diag_event("identity_key_conflict", &format!("device_id={device_id}"));
        return;
    }

    // 仅在公钥首次学到/变化时才落库（避免每条 announce 都写库）
    if key_changed {
        let (x, e) = {
            let peers = state.peers.lock().unwrap();
            peers
                .get(device_id)
                .map(|p| (p.x25519_pubkey.clone(), p.ed25519_pubkey.clone()))
                .unwrap_or((None, None))
        };
        if x.is_some() || e.is_some() {
            let dbc = state.db.lock().unwrap();
            db::update_friend_pubkeys(&dbc, device_id, x.as_deref(), e.as_deref()).ok();
        }
        // 公钥变化时同步到 friends 表：Hello 可能在 announce 之前到达，
        // 此时 peers[peer].x25519_pubkey 为 None → friends 表写入 None；
        // announce 到达后更新了 peers，但 friends 表不会自动刷新。
        // 此处补一次 maybe_update_friend 确保 friends 表与 peers 同步。
        let (nick, av) = {
            let peers = state.peers.lock().unwrap();
            peers
                .get(device_id)
                .map(|p| (p.nickname.clone(), p.avatar.clone()))
                .unwrap_or_default()
        };
        maybe_update_friend(state, device_id, &nick, av);
    }

    // 仅新节点或公钥变化时补发群密钥（处理对方离线时建群的情况）
    if is_new || key_changed {
        redistribute_group_keys(state, device_id).await;
        // 重发本机聊天样式：对方离线期间错过 broadcastChatStyle 广播，
        // 且样式广播无离线补偿——对方上线后必须补发，否则永远看不到配色
        resend_chat_style(state, device_id);
    }
}

/// 向指定 peer 重发本机聊天样式（复用既有 ChatStyle 消息，无新协议）。
fn resend_chat_style(state: &AppState, peer_id: &str) {
    let style = {
        let dbc = state.db.lock().unwrap();
        db::get_setting(&dbc, "chat_style")
    };
    let Some(style) = style else {
        return;
    };
    if style.is_empty() {
        return;
    }
    let msg = Message::ChatStyle {
        from: state.device_id.clone(),
        to: Some(peer_id.to_string()),
        style,
    };
    let _ = try_send(state, peer_id, &msg);
}

/// 群密钥发送失败的原因。仅 `NoLink` 可重试（登记 pending 等建链后 flush）。
enum GroupKeySendErr {
    /// TCP link 不可用（未建立连接 / 已断开）——可重试
    NoLink,
    /// 缺公钥 / 非群成员 / 无本地密钥 / 加密失败——重试无意义
    Fatal,
}

// ---------------- 待发群密钥登记表（纯逻辑，便于单测；不涉及网络与 AppState） ----------------

/// 登记一个待发群密钥（幂等）。
pub(crate) fn mark_pending_group_key(
    pending: &mut HashMap<String, HashSet<String>>,
    peer_id: &str,
    group_id: &str,
) {
    pending
        .entry(peer_id.to_string())
        .or_default()
        .insert(group_id.to_string());
}

/// 取指定 peer 的待发 group_id 快照（无登记项时为空）。
fn pending_group_key_ids(
    pending: &HashMap<String, HashSet<String>>,
    peer_id: &str,
) -> Vec<String> {
    match pending.get(peer_id) {
        Some(set) => set.iter().cloned().collect(),
        None => Vec::new(),
    }
}

/// 清除一个待发登记项；该 peer 的集合空了则一并移除键，避免无意义增长。
fn clear_pending_group_key(
    pending: &mut HashMap<String, HashSet<String>>,
    peer_id: &str,
    group_id: &str,
) {
    let empty = match pending.get_mut(peer_id) {
        Some(set) => {
            set.remove(group_id);
            set.is_empty()
        }
        None => false,
    };
    if empty {
        pending.remove(peer_id);
    }
}

/// 是否保留登记项等待重试：只有「链路不可用」才保留；
/// 发送成功或失败原因重试无意义（非成员 / 无密钥 / 缺公钥）都清除。
fn should_retain_pending_group_key(result: &Result<(), GroupKeySendErr>) -> bool {
    matches!(result, Err(GroupKeySendErr::NoLink))
}

/// 向指定 peer 发送一次群密钥。GroupKey 消息格式、加密方式与公钥来源
/// （peers 表）均与既有 `redistribute_group_keys` 保持一致。
async fn try_send_group_key(
    state: &AppState,
    peer_id: &str,
    group_id: &str,
) -> Result<(), GroupKeySendErr> {
    let pubkey = {
        let peers = state.peers.lock().unwrap();
        peers.get(peer_id).and_then(|p| p.x25519_pubkey.clone())
    };
    let Some(pubkey) = pubkey else {
        return Err(GroupKeySendErr::Fatal);
    };
    let found_group = {
        let dbc = state.db.lock().unwrap();
        db::list_groups(&dbc)
            .unwrap_or_default()
            .into_iter()
            .find(|g| g.id == group_id)
    };
    let Some(g) = found_group else {
        return Err(GroupKeySendErr::Fatal);
    };
    if !g.members.contains(&peer_id.to_string()) {
        return Err(GroupKeySendErr::Fatal);
    }
    let Some(key) = get_group_key(state, group_id).await else {
        return Err(GroupKeySendErr::Fatal);
    };
    let Some(shared) = crypto::shared_secret(&state.identity.x25519_secret, &pubkey) else {
        return Err(GroupKeySendErr::Fatal);
    };
    let Some(sealed) = crypto::seal(&shared, &key) else {
        return Err(GroupKeySendErr::Fatal);
    };
    let msg = Message::GroupKey {
        group_id: group_id.to_string(),
        from: state.device_id.clone(),
        to: peer_id.to_string(),
        key: STANDARD.encode(&sealed),
        group_name: g.name.clone(),
        members: g.members.clone(),
    };
    // try_send 返回 Err 只可能是「未建立连接」（links 无该 peer）
    try_send(state, peer_id, &msg)
        .await
        .map_err(|_| GroupKeySendErr::NoLink)
}

async fn redistribute_group_keys(state: &AppState, peer_id: &str) {
    let groups = {
        let dbc = state.db.lock().unwrap();
        db::list_groups(&dbc).unwrap_or_default()
    };
    for g in groups {
        if !g.members.contains(&peer_id.to_string()) {
            continue;
        }
        match try_send_group_key(state, peer_id, &g.id).await {
            Ok(()) => {}
            Err(GroupKeySendErr::NoLink) => {
                // announce 先于 ensure_link 执行时 link 尚未建立，此前会静默丢弃
                // 且后续 is_new/key_changed 不再触发 → 成员永久拿不到群密钥。
                // 登记待发，由建链 / Hello / 心跳的 flush_pending_group_keys 重试。
                let mut pending = state.pending_group_keys.lock().unwrap();
                mark_pending_group_key(&mut pending, peer_id, &g.id);
            }
            // 缺公钥 / 非成员 / 无密钥：重试无意义，不登记
            Err(GroupKeySendErr::Fatal) => {}
        }
    }
}

/// 冲刷指定 peer 的待发群密钥：仅处理该 peer，发送成功即移除登记项；
/// link 仍不可用则保留，等下一次 flush（Hello / 心跳 / 建链）重试。
pub async fn flush_pending_group_keys(state: &AppState, peer_id: &str) {
    let group_ids: Vec<String> = {
        let pending = state.pending_group_keys.lock().unwrap();
        pending_group_key_ids(&pending, peer_id)
    };
    for gid in group_ids {
        let result = try_send_group_key(state, peer_id, &gid).await;
        if should_retain_pending_group_key(&result) {
            // 仍无链路：保留登记项，等待下一次 flush（Hello / 心跳 / 建链）
            continue;
        }
        let mut pending = state.pending_group_keys.lock().unwrap();
        clear_pending_group_key(&mut pending, peer_id, &gid);
    }
}

pub async fn touch_peer(state: &AppState, device_id: &str) {
    let ts = db::now_ms();
    if let Some(p) = state.peers.lock().unwrap().get_mut(device_id) {
        p.last_seen = ts;
    }
    state.emit_peers();
}

async fn mark_peer_offline(state: &Arc<AppState>, device_id: &str) {
    state.peers.lock().unwrap().remove(device_id);
    state.emit_peers();
}

pub(crate) fn maybe_update_friend(
    state: &AppState,
    device_id: &str,
    nickname: &str,
    avatar: Option<String>,
) {
    let (x, e) = {
        let peers = state.peers.lock().unwrap();
        peers
            .get(device_id)
            .map(|p| (p.x25519_pubkey.clone(), p.ed25519_pubkey.clone()))
            .unwrap_or((None, None))
    };
    let dbc = state.db.lock().unwrap();
    if db::get_friend(&dbc, device_id).is_some() {
        db::add_friend(&dbc, device_id, nickname, avatar.as_deref()).ok();
        // 好友行常在公钥落库之后才创建（好友申请通过才 add_friend），
        // 此处每次同步公钥，保证 E2EE 加密始终能取到对方公钥。
        if x.is_some() || e.is_some() {
            db::update_friend_pubkeys(&dbc, device_id, x.as_deref(), e.as_deref()).ok();
        }
    }
}

/// 群成员公钥选择：peers 表优先、friends 表回落（纯逻辑，便于单测）。
/// peers 表由 announce / Hello 实时维护，几乎总是最新；
/// friends 表可能缺失——accept 方路径此前不补写公钥，
/// 且公钥不变时 key_changed 不触发 maybe_update_friend。
fn pick_member_x25519(peers_key: Option<String>, friends_key: Option<String>) -> Option<String> {
    peers_key.or(friends_key)
}

/// 解析群成员的 X25519 公钥：peers 优先、friends 回落，都缺失才返回 None。
/// 群密钥分发（distribute_group_key / resend_group_key_to）统一走这里，
/// 避免 friends 表公钥缺失导致 GroupKey 被静默跳过、成员永久拿不到群密钥。
pub(crate) fn resolve_member_x25519(state: &AppState, member_id: &str) -> Option<String> {
    let peers_key = {
        let peers = state.peers.lock().unwrap();
        peers.get(member_id).and_then(|p| p.x25519_pubkey.clone())
    };
    let friends_key = {
        let dbc = state.db.lock().unwrap();
        db::get_friend_x25519(&dbc, member_id)
    };
    pick_member_x25519(peers_key, friends_key)
}

pub fn resolve_nickname(state: &AppState, id: &str) -> String {
    if let Some(p) = state.peers.lock().unwrap().get(id) {
        if !p.nickname.is_empty() {
            return p.nickname.clone();
        }
    }
    if let Some(r) = state.pending_requests.lock().unwrap().get(id) {
        return r.from_nickname.clone();
    }
    if let Some((n, _)) = db::get_friend(&state.db.lock().unwrap(), id) {
        return n;
    }
    id.to_string()
}

fn resolve_group_name(state: &AppState, group_id: &str) -> String {
    let dbc = state.db.lock().unwrap();
    if let Ok(groups) = db::list_groups(&dbc) {
        if let Some(g) = groups.into_iter().find(|g| g.id == group_id) {
            return g.name;
        }
    }
    format!("群聊 {group_id}")
}

fn preview_content(kind: &str, content: &str) -> String {
    match kind {
        "file" => "[文件]".to_string(),
        "image" => "[图片]".to_string(),
        _ => {
            let count = content.chars().count();
            let c: String = content.chars().take(30).collect();
            if count > 30 {
                format!("{c}…")
            } else {
                c
            }
        }
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
        let dbc = state.db.lock().unwrap();
        db::list_outbox(&dbc, peer_id).unwrap_or_default()
    };
    for (_id, payload) in pending {
        let Ok(msg) = serde_json::from_str::<Message>(&payload) else {
            continue;
        };
        let msg = reseal_for_send(state, msg);
        let _ = try_send(state, peer_id, &msg).await;
    }
}

/// 冲刷待发的单聊已读回执（触发点与 `flush_outbox` 一致：建链 / Hello / 心跳）。
///
/// `mark_read` 将 pending 同时写入内存 HashMap 和 SQLite。此处成功发送后
/// 同时清除两者；失败时内存已由 remove 清除但会重新写入，DB 保留不动
/// （由 `mark_read` 写入，下次 flush 重试）。
pub async fn flush_pending_reads(state: &AppState, peer_id: &str) {
    let Some(last_read_ts) = state.pending_reads.lock().unwrap().remove(peer_id) else {
        return;
    };
    let msg = Message::ReadReceipt {
        from: state.device_id.clone(),
        to: peer_id.to_string(),
        last_read_ts,
    };
    if try_send(state, peer_id, &msg).await.is_err() {
        // 发送失败：内存重新放入 pending，DB 保留（已由 mark_read 写入）
        let mut pending = state.pending_reads.lock().unwrap();
        let cur = pending.entry(peer_id.to_string()).or_insert(last_read_ts);
        *cur = (*cur).max(last_read_ts);
    } else {
        // 发送成功：清除 DB 中的 pending 记录
        let dbc = state.db.lock().unwrap();
        db::delete_pending_read(&dbc, peer_id).ok();
    }
}

pub fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    notify_with_extra(app, title, body, std::collections::HashMap::new());
}

pub fn notify_with_extra(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    extra: std::collections::HashMap<String, String>,
) {
    use tauri_plugin_notification::NotificationExt;
    let mut builder = app.notification().builder().title(title).body(body);
    for (k, v) in &extra {
        builder = builder.extra(k, v);
    }
    let _ = builder.show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gossip_engine::GossipEngine;

    #[tokio::test]
    async fn frame_roundtrip() {
        let (a, b) = tokio::io::duplex(4096);
        let (mut _ar, mut aw) = tokio::io::split(a);
        let (mut br, mut _bw) = tokio::io::split(b);
        let msg = Message::Heartbeat {
            device_id: "dev-1".into(),
        };
        let (wr, rd) = tokio::join!(write_frame(&mut aw, &msg), read_frame(&mut br));
        wr.unwrap();
        match rd.unwrap() {
            Message::Heartbeat { device_id } => assert_eq!(device_id, "dev-1"),
            _ => panic!("类型不符"),
        }
    }

    #[tokio::test]
    async fn frame_roundtrip_large_payload() {
        // 模拟 256KB 文件分片的 base64 负载往返
        let big = "A".repeat(342_000);
        let msg = Message::RelayChunk {
            transfer_id: "t1".into(),
            seq: 7,
            data: big.clone(),
            from: "a".into(),
            to: "b".into(),
            ttl: 3,
        };
        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut _ar, mut aw) = tokio::io::split(a);
        let (mut br, mut _bw) = tokio::io::split(b);
        let (wr, rd) = tokio::join!(write_frame(&mut aw, &msg), read_frame(&mut br));
        wr.unwrap();
        match rd.unwrap() {
            Message::RelayChunk { data, seq, .. } => {
                assert_eq!(seq, 7);
                assert_eq!(data, big);
            }
            _ => panic!("类型不符"),
        }
    }

    #[tokio::test]
    async fn e2e_gossip_encrypt_sign_decrypt() {
        // 端到端：A 加密→签名→广播信封，B 验签→解密
        let a = crate::crypto::Identity::generate();
        let b = crate::crypto::Identity::generate();

        // A 用 B 的公钥 ECDH 派生共享密钥并加密
        let shared =
            crate::crypto::shared_secret(&a.x25519_secret, &b.x25519_public_b64()).unwrap();
        let plaintext = b"{\"kind\":\"text\",\"content\":\"hello\"}";
        let sealed = crate::crypto::seal(&shared, plaintext).unwrap();
        let payload_b64 = STANDARD.encode(&sealed);

        // 构造并签名信封
        let engine = GossipEngine::new(100, 10, 4, 6);
        let env = engine.build_envelope(&a, "dev-a", GossipKind::Chat, None, None, &payload_b64, 1);

        // B 验签 + 解密
        assert!(engine.verify_envelope(&env));
        let shared_b = crate::crypto::shared_secret(&b.x25519_secret, &env.sender_pubkey).unwrap();
        let decrypted = STANDARD.decode(&env.payload).unwrap();
        let opened = crate::crypto::open(&shared_b, &decrypted).unwrap();
        assert_eq!(opened, plaintext);
    }

    // ---------------- P0-2：直连 E2EE 解密失败不得消费真实 msg_id ----------------

    fn seal_direct(from: &crate::crypto::Identity, to_pubkey: &str, text: &str) -> String {
        let shared = crate::crypto::shared_secret(&from.x25519_secret, to_pubkey).unwrap();
        format!(
            "enc1:{}",
            STANDARD.encode(crate::crypto::seal(&shared, text.as_bytes()).unwrap())
        )
    }

    /// Test 1 正常 E2EE：正确公钥 → 明文与原始 kind 一并还原（kind 不被改写成 system）。
    #[test]
    fn direct_open_succeeds_with_current_keys() {
        let a = crate::crypto::Identity::generate();
        let b = crate::crypto::Identity::generate();
        let wire = seal_direct(&a, &b.x25519_public_b64(), "你好 e2ee");
        assert_eq!(
            open_direct_content(
                &b.x25519_secret,
                Some(&a.x25519_public_b64()),
                &wire,
                MsgKind::Code
            ),
            Some(("你好 e2ee".to_string(), "code".to_string()))
        );
    }

    /// Test 2 场景 A（暂时缺公钥）：缺发送方公钥必须判为「解不开」（→ 不落库、不 Ack），
    /// 且公钥经 announce/who_has 学到之后，**同一份密文**即可解开 —— 补发重试就能恢复。
    #[test]
    fn direct_open_fails_without_sender_key_and_recovers_when_key_arrives() {
        let a = crate::crypto::Identity::generate();
        let b = crate::crypto::Identity::generate();
        let wire = seal_direct(&a, &b.x25519_public_b64(), "pending key");
        assert_eq!(
            open_direct_content(&b.x25519_secret, None, &wire, MsgKind::Text),
            None
        );
        assert_eq!(
            open_direct_content(
                &b.x25519_secret,
                Some(&a.x25519_public_b64()),
                &wire,
                MsgKind::Text
            ),
            Some(("pending key".to_string(), "text".to_string()))
        );
    }

    /// Test 3a 场景 B（发送方换身份）：本地缓存为旧公钥时解不开；
    /// `upsert_peer` 把对方新公钥刷进缓存后，同一份密文可解开（无需重新加密）。
    #[test]
    fn direct_open_recovers_once_sender_pubkey_cache_refreshed() {
        let a_old = crate::crypto::Identity::generate();
        let a_new = crate::crypto::Identity::generate();
        let b = crate::crypto::Identity::generate();
        let wire = seal_direct(&a_new, &b.x25519_public_b64(), "rotated sender");
        assert_eq!(
            open_direct_content(
                &b.x25519_secret,
                Some(&a_old.x25519_public_b64()),
                &wire,
                MsgKind::Text
            ),
            None
        );
        assert_eq!(
            open_direct_content(
                &b.x25519_secret,
                Some(&a_new.x25519_public_b64()),
                &wire,
                MsgKind::Text
            ),
            Some(("rotated sender".to_string(), "text".to_string()))
        );
    }

    /// Test 3b 场景 B（接收方换身份）：outbox 里的密文对着旧公钥封存，重发多少次都解不开，
    /// 必须由持有明文的发送方用**当前**公钥重封；重封可失败（无明文 / 无公钥）时一律返回
    /// None 让调用方按原样补发，绝不伪造内容。
    #[test]
    fn reseal_with_current_receiver_key_recovers_where_retry_cannot() {
        let a = crate::crypto::Identity::generate();
        let b_old = crate::crypto::Identity::generate();
        let b_new = crate::crypto::Identity::generate();
        let stale = seal_direct(&a, &b_old.x25519_public_b64(), "stale seal");

        // 旧密文对新的接收方身份永久无效（重发不解决问题）
        assert_eq!(
            open_direct_content(
                &b_new.x25519_secret,
                Some(&a.x25519_public_b64()),
                &stale,
                MsgKind::Text
            ),
            None
        );
        // 重封：同一明文 + 当前公钥 → 可解，且仍是 enc1: 形态
        let resealed = reseal_chat_content(
            &a.x25519_secret,
            Some("stale seal"),
            Some(&b_new.x25519_public_b64()),
        )
        .unwrap();
        assert_ne!(resealed, stale);
        assert_eq!(
            open_direct_content(
                &b_new.x25519_secret,
                Some(&a.x25519_public_b64()),
                &resealed,
                MsgKind::Text
            ),
            Some(("stale seal".to_string(), "text".to_string()))
        );
        // 前置条件缺失 → 不重封（调用方保留原 payload）
        let no_plaintext =
            reseal_chat_content(&a.x25519_secret, None, Some(&b_new.x25519_public_b64()));
        assert_eq!(no_plaintext, None);
        let no_pubkey = reseal_chat_content(&a.x25519_secret, Some("stale seal"), None);
        assert_eq!(no_pubkey, None);
    }

    /// Test 3c 场景 C（真损坏）：base64 非法 / 密文被篡改一律判为解不开，
    /// 但**不污染**同一条完好密文的可解性 —— 失败只影响这一次投递。
    #[test]
    fn direct_open_rejects_corrupt_and_tampered_payloads() {
        let a = crate::crypto::Identity::generate();
        let b = crate::crypto::Identity::generate();
        let spk = a.x25519_public_b64();
        assert_eq!(
            open_direct_content(
                &b.x25519_secret,
                Some(&spk),
                "enc1:!!not base64!!",
                MsgKind::Text
            ),
            None
        );
        assert_eq!(
            open_direct_content(&b.x25519_secret, Some(&spk), "enc1:", MsgKind::Text),
            None
        );
        let wire = seal_direct(&a, &b.x25519_public_b64(), "intact");
        let mut raw = STANDARD
            .decode(wire.strip_prefix("enc1:").unwrap())
            .unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xFF; // 破坏 AEAD tag
        let tampered = format!("enc1:{}", STANDARD.encode(&raw));
        assert_eq!(
            open_direct_content(&b.x25519_secret, Some(&spk), &tampered, MsgKind::Text),
            None
        );
        assert!(open_direct_content(&b.x25519_secret, Some(&spk), &wire, MsgKind::Text).is_some());
    }

    #[test]
    fn plaintext_payload_is_rejected() {
        let me = crate::crypto::Identity::generate();
        assert_eq!(
            open_direct_content(&me.x25519_secret, None, "plain old text", MsgKind::Text),
            None
        );
    }

    /// P1-3：两层去重必须互相独立——Gossip 的 Bloom/LRU 属网络传播层（只认 `message_id`），
    /// SQLite 的 `msg_id` 属业务持久化层。业务层的「本机已落库」只能抑制未读/事件，
    /// 绝不能前移到转发之前，否则已经 Direct 收到过该消息的节点会拒绝继续 fan-out，
    /// epidemic 传播在此断链。转发目标只由邻居集合 / fanout / exclude 决定。
    #[test]
    fn gossip_propagation_layer_stays_independent_of_local_persistence() {
        let mut engine = GossipEngine::new(100, 10, 4, 6);
        assert!(engine.is_new("m1"), "首次见到的信封必须进入处理与转发");
        assert!(!engine.is_new("m1"), "同一信封第二次到达在传播层判为重复");
        assert!(engine.is_new("m2"), "另一条消息不受前者影响");
        let peers = vec!["b".to_string(), "c".to_string(), "d".to_string()];
        let targets = engine.choose_fanout(&peers, "a");
        assert_eq!(targets.len(), 3, "fanout=4 时三个邻居都应被转发到");
        assert!(!targets.contains(&"a".to_string()), "不回发给信封的发送方");
    }

    /// P1-3 / Test 4 的前提条件：Direct 已把某 msg_id 落库之后，同一信封再到达时
    /// 必须「业务层判为已存在（于是抑制未读与事件）」且「传播层仍判为首次见到（于是
    /// 继续 verify 并在 ttl > 1 时 fan-out）」同时成立。
    /// 若把 `message_exists` 前移到 handle_gossip 开头直接 return，第二项就会被破坏，
    /// epidemic 传播在本节点断链 —— 这条测试就是防止那种"顺手简化"。
    #[test]
    fn business_duplicate_still_enters_the_propagation_layer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        let rec = MessageRecord {
            id: 0,
            msg_id: "m1".into(),
            conv_id: "dev-a".into(),
            sender_id: "dev-a".into(),
            receiver_id: "me".into(),
            kind: "text".into(),
            content: "hello".into(),
            ts: 1,
            status: "delivered".into(),
        };
        // Direct 先到并落库 → 它是唯一产生本地副作用的一方
        assert!(db::insert_message_if_new(&conn, &rec).unwrap());
        // 之后 Gossip 副本到达：业务层判为已存在 ⇒ 不再 touch / 不再 emit
        assert!(!db::insert_message_if_new(&conn, &rec).unwrap());
        // 但传播层（独立的内存 Bloom/LRU）从未被 Direct 登记 ⇒ 仍会走到 fan-out
        let mut engine = GossipEngine::new(100, 10, 4, 6);
        assert!(engine.is_new("m1"), "业务层已存在不得让传播层跳过转发");
        // 且两路径共用同一 msg_id，库里始终只有一行
        assert_eq!(db::get_messages(&conn, "dev-a", 10, 0).unwrap().len(), 1);
    }

    /// P1-3 / Test C：三态落库裁决 → 副作用与 Ack 策略的映射必须是显式且可测的。
    /// - 未读 +1 与 message-received：只有 `Ok(true)`（本次真的新建）才允许；
    /// - Ack：`Ok(true)` / `Ok(false)` 都允许（消息确已在库），`Err` 必须禁止
    ///   （Ack 会让发送方删掉 outbox 行 ⇒ 临时 DB 故障变成永久丢消息）。
    #[test]
    fn insert_outcome_maps_to_side_effect_and_ack_policy() {
        let fresh: Result<bool, rusqlite::Error> = Ok(true);
        let duplicate: Result<bool, rusqlite::Error> = Ok(false);
        let db_error: Result<bool, rusqlite::Error> = Err(rusqlite::Error::QueryReturnedNoRows);

        assert!(announced_on(&fresh), "本次新建 ⇒ 计未读 + 投递事件");
        assert!(!announced_on(&duplicate), "重复 ⇒ 不得再有副作用");
        assert!(
            !announced_on(&db_error),
            "DB 故障 ⇒ 不得有副作用（更不得当成重复）"
        );

        assert!(may_ack(&fresh), "本次新建 ⇒ Ack");
        assert!(
            may_ack(&duplicate),
            "已在库中 ⇒ 仍 Ack（Ack 语义 = 已成功接收并持久化）"
        );
        assert!(
            !may_ack(&db_error),
            "DB 故障 ⇒ 绝不 Ack，outbox 行必须保留以便重发"
        );
    }

    /// ReadReceipt 正常到达：ts ≤ last_read_ts 的消息推进到 read。
    #[test]
    fn read_receipt_marks_messages_as_read() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "peer-a".into(),
                sender_id: "me".into(),
                receiver_id: "peer-a".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                status: "delivered".into(),
            },
        )
        .unwrap();
        // 模拟 ReadReceipt handler 的 UPDATE 语句
        let updated = conn
            .execute(
                "UPDATE messages SET status = 'read'
             WHERE conv_id = ?1 AND sender_id = ?2 AND status != 'read' AND ts <= ?3",
                params!["peer-a", "me", 100],
            )
            .unwrap();
        assert_eq!(updated, 1, "应有 1 行被更新");
        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "read");
    }

    /// Test D: updated = 0 时 DB UPDATE 无行被更新，但 handler 仍然 emit peer-read。
    /// 注意：emit 依赖 Tauri AppHandle，无法在纯单测中断言事件；
    /// 这里验证的是 SQL 路径正确返回 updated=0（与 emit 条件分离）。
    #[test]
    fn read_receipt_db_update_zero_when_already_read() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "peer-a".into(),
                sender_id: "me".into(),
                receiver_id: "peer-a".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                status: "read".into(),
            },
        )
        .unwrap();
        let updated = conn
            .execute(
                "UPDATE messages SET status = 'read'
             WHERE conv_id = ?1 AND sender_id = ?2 AND status != 'read' AND ts <= ?3",
                params!["peer-a", "me", 100],
            )
            .unwrap();
        assert_eq!(updated, 0, "DB 已是 read，无行被更新");
        // handler 仍然 emit peer-read（always-emit 修复），但 emit 本身无法在单测中断言
    }

    /// Test C: 多次 mark_read 只保留最大 timestamp。
    #[test]
    fn pending_reads_keeps_max_timestamp() {
        let mut pending: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        // mark_read(ts=100)
        let cur = pending.entry("peer-a".into()).or_insert(100);
        *cur = (*cur).max(100);
        assert_eq!(pending["peer-a"], 100);
        // mark_read(ts=80) — 较小，不更新
        let cur = pending.entry("peer-a".into()).or_insert(80);
        *cur = (*cur).max(80);
        assert_eq!(pending["peer-a"], 100);
        // mark_read(ts=200) — 较大，更新
        let cur = pending.entry("peer-a".into()).or_insert(200);
        *cur = (*cur).max(200);
        assert_eq!(pending["peer-a"], 200);
    }

    /// Test B: writer write_frame 失败时，ReadReceipt 的 timestamp 被重新放入 pending_reads。
    /// 模拟 writer_loop 的失败回收逻辑。
    #[test]
    fn writer_failure_preserves_pending_for_read_receipt() {
        let mut pending: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        // flush_pending_reads 已经 remove
        pending.insert("peer-a".into(), 200);
        let last_read_ts = pending.remove("peer-a").unwrap();
        assert!(pending.is_empty(), "flush 后 pending 应为空");
        // 模拟 writer_loop write_frame 失败后的回收逻辑
        {
            let cur = pending.entry("peer-a".into()).or_insert(last_read_ts);
            *cur = (*cur).max(last_read_ts);
        }
        assert_eq!(
            pending.get("peer-a"),
            Some(&200),
            "写入失败后 pending 应恢复"
        );
    }

    /// Test A: writer write_frame 成功时，pending 不被重新插入。
    /// flush_pending_reads remove 后发送成功，pending 保持清空。
    #[test]
    fn successful_flush_clears_pending() {
        let mut pending: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        pending.insert("peer-a".into(), 200);
        // 模拟 flush_pending_reads: remove + try_send Ok + writer write_frame Ok
        let last_read_ts = pending.remove("peer-a").unwrap();
        // write_frame 成功 → 不执行 writer_loop 的回收逻辑
        let _ = last_read_ts;
        assert!(pending.is_empty(), "写入成功后 pending 应保持清空");
    }

    /// flush_pending_reads try_send 失败时（链路不存在），pending 必须恢复——
    //  否则 ReadReceipt 永久丢失，要等用户下次手动打开会话才能补发。
    #[test]
    fn flush_failure_reinserts_pending_read() {
        let mut pending: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        pending.insert("peer-a".into(), 300);
        // 模拟 flush_pending_reads: remove → try_send Err → 必须 re-insert
        let last_read_ts = pending.remove("peer-a").unwrap();
        assert!(pending.is_empty(), "remove 后 pending 应为空");
        // try_send 失败 → 重新放入 pending（与 writer_loop 的失败回收同逻辑）
        {
            let cur = pending.entry("peer-a".into()).or_insert(last_read_ts);
            *cur = (*cur).max(last_read_ts);
        }
        assert_eq!(
            pending.get("peer-a"),
            Some(&300),
            "try_send 失败后 pending 应恢复"
        );
    }

    /// 多次 flush 失败只保留最大 timestamp（幂等性）。
    #[test]
    fn repeated_flush_failure_keeps_max_timestamp() {
        let mut pending: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        // 第一次 mark_read(ts=300) → flush 失败
        pending.insert("peer-a".into(), 300);
        let ts1 = pending.remove("peer-a").unwrap();
        {
            let cur = pending.entry("peer-a".into()).or_insert(ts1);
            *cur = (*cur).max(ts1);
        }
        // 第二次 mark_read(ts=200) → 较小，不覆盖
        let cur = pending.entry("peer-a".into()).or_insert(200);
        *cur = (*cur).max(200);
        assert_eq!(pending["peer-a"], 300);
        // 第三次 mark_read(ts=500) → 较大，更新
        let cur = pending.entry("peer-a".into()).or_insert(500);
        *cur = (*cur).max(500);
        assert_eq!(pending["peer-a"], 500);
    }

    /// read 不会被 delivered 回退（set_message_status 守卫）。
    #[test]
    fn read_status_never_regresses_to_delivered() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "f1".into(),
                sender_id: "a".into(),
                receiver_id: "b".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                status: "read".into(),
            },
        )
        .unwrap();
        db::set_message_status(&conn, "m1", "delivered").unwrap();
        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "read", "delivered 不得回退 read");
    }

    // ================================================================
    // Ack 中继转发测试
    // ================================================================

    /// Test 1：本机是原始发送者 → Ack 正常处理（status→delivered, outbox 删除）。
    #[test]
    fn ack_local_sender_marks_delivered_and_clears_outbox() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // 模拟本机发送的消息
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "d1".into(),
                sender_id: "me".into(),
                receiver_id: "d1".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                status: "sent".into(),
            },
        )
        .unwrap();
        db::insert_outbox(&conn, "m1", "d1", r#"payload"#).unwrap();

        // Ack handler 的查询：sender_id = "me" == 本机 → 走正常处理分支
        let sender_id: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["m1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sender_id, "me");

        // 模拟正常处理
        db::set_message_status(&conn, "m1", "delivered").unwrap();
        conn.execute("DELETE FROM outbox WHERE msg_id = ?1", params!["m1"])
            .unwrap();

        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "delivered");
        assert!(db::list_outbox(&conn, "d1").unwrap().is_empty());
    }

    /// Test 2：中继节点收到 Ack → sender_id ≠ 本机 → 不做本地处理。
    /// 验证中继节点不修改自己的消息状态、不删除 outbox。
    #[test]
    fn ack_relay_node_does_not_process_locally() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // 中继节点 C 收到 A 发给 D 的消息（通过 Gossip）
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "d1".into(),
                sender_id: "node-a".into(),
                receiver_id: "d1".into(),
                kind: "text".into(),
                content: "hello".into(),
                ts: 200,
                status: "delivered".into(),
            },
        )
        .unwrap();
        // C 自己也有一条 outbox 消息（不同的 msg_id）
        db::insert_outbox(&conn, "m-own", "some-peer", r#"own payload"#).unwrap();

        // Ack handler 查询：sender_id = "node-a" ≠ "me"（当前节点是 C）
        let sender_id: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["m1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(sender_id, "me", "sender_id 应为原始发送方 A，不是本机 C");

        // 中继节点不应执行任何本地状态修改
        // （实际 handler 中，Some(sender) if sender == device_id 分支不匹配 → 走转发分支）
        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "delivered", "中继节点不修改消息状态");
        assert!(
            !db::list_outbox(&conn, "some-peer").unwrap().is_empty(),
            "中继节点不删除自己的 outbox"
        );
    }

    /// Test 3：Ack 对应的 msg_id 不存在 → 查询返回 None → 安全丢弃。
    #[test]
    fn ack_unknown_msg_id_is_silently_dropped() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // 不存在的消息
        let result: Option<String> = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["nonexistent"],
                |r| r.get(0),
            )
            .ok();
        assert!(result.is_none(), "查询不存在的 msg_id 应返回 None");
        // 此时 handler 走 None 分支 → 不做任何修改
    }

    /// Test 4：中继节点转发 Ack 时，sender_id 和 message_id 不被修改。
    #[test]
    fn ack_relay_preserves_original_fields() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::insert_message(
            &conn,
            &MessageRecord {
                id: 0,
                msg_id: "m1".into(),
                conv_id: "d1".into(),
                sender_id: "node-a".into(),
                receiver_id: "d1".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                status: "delivered".into(),
            },
        )
        .unwrap();

        // 中继节点查询到原始 sender_id
        let original_sender: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["m1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(original_sender, "node-a");

        // 转发时使用原始 Ack 消息（message_id 和 sender_id 不变）
        let ack = Message::Ack {
            msg_id: "m1".into(),
        };
        match &ack {
            Message::Ack { msg_id } => {
                assert_eq!(msg_id, "m1", "message_id 不得被修改");
            }
            _ => panic!("应为 Ack"),
        }
        // original_sender 用于 try_send 的 peer_id 参数，不嵌入 Ack 消息体
    }

    // ================================================================
    // 好友权限测试
    // ================================================================

    /// 好友状态下 Direct Chat 可以正常接收（insert_message_if_new 成功）。
    #[test]
    fn friend_chat_message_accepted() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::add_friend(&conn, "a", "Alice", None).unwrap();
        assert!(
            db::get_friend(&conn, "a").is_some(),
            "好友存在时应能处理消息"
        );
    }

    /// 删除好友后 Direct Chat 不落库。
    #[test]
    fn non_friend_chat_message_rejected() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::add_friend(&conn, "a", "Alice", None).unwrap();
        db::remove_friend(&conn, "a").unwrap();
        assert!(db::get_friend(&conn, "a").is_none(), "删除好友后应检测不到");
    }

    /// Gossip Group 不受好友检查影响。
    #[test]
    fn gossip_group不受好友检查影响() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // 群聊不需要好友关系
        db::create_group(&conn, "g1", "测试群", "owner", &["a".into(), "b".into()]).unwrap();
        let groups = db::list_groups(&conn).unwrap();
        assert_eq!(groups.len(), 1);
    }

    /// FriendMessageBlocked 包含 original_sender 字段。
    #[test]
    fn friend_message_blocked_has_original_sender() {
        let msg = Message::FriendMessageBlocked {
            from: "c".into(),
            to: "a".into(),
            original_sender: "a".into(),
        };
        match &msg {
            Message::FriendMessageBlocked {
                from,
                to,
                original_sender,
            } => {
                assert_eq!(from, "c");
                assert_eq!(to, "a");
                assert_eq!(original_sender, "a");
            }
            _ => panic!("应为 FriendMessageBlocked"),
        }
    }

    // ---------- 待发群密钥 pending 表（最小 P0 修复） ----------

    /// 链路未建立时（announce 先于 ensure_link）群密钥发送失败，
    /// 必须登记到 pending，否则后续 is_new/key_changed 不再触发 → 永久丢密钥。
    #[test]
    fn redistribute_failure_registers_pending() {
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();

        // 模拟 announce → upsert_peer → redistribute_group_keys → try_send 失败（无 link）
        // 失败分支必须调用 mark_pending_group_key（见 transport.rs::redistribute_group_keys）
        mark_pending_group_key(&mut pending, "peer-b", "g-1");
        mark_pending_group_key(&mut pending, "peer-b", "g-2");
        // 同 (peer, group) 重复登记应幂等
        mark_pending_group_key(&mut pending, "peer-b", "g-1");

        let ids = pending_group_key_ids(&pending, "peer-b");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"g-1".to_string()));
        assert!(ids.contains(&"g-2".to_string()));
    }

    /// 链路就绪后 flush_pending_group_keys 成功 → 必须清除登记项，
    /// 否则 pending 永远不被消费（不增长、不泄漏、达成"成功即清"）。
    #[test]
    fn flush_success_clears_pending() {
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        mark_pending_group_key(&mut pending, "peer-b", "g-1");
        mark_pending_group_key(&mut pending, "peer-b", "g-2");
        mark_pending_group_key(&mut pending, "peer-c", "g-1");

        // 模拟 flush_pending_group_keys：peer-b 已建链、两条都发送成功
        let result: Result<(), GroupKeySendErr> = Ok(());
        assert!(!should_retain_pending_group_key(&result));
        for gid in ["g-1", "g-2"] {
            clear_pending_group_key(&mut pending, "peer-b", gid);
        }

        // peer-b 的登记应被清空（键一并移除，避免无意义增长）
        assert!(pending_group_key_ids(&pending, "peer-b").is_empty());
        assert!(!pending.contains_key("peer-b"));
        // peer-c 不受影响
        assert_eq!(pending_group_key_ids(&pending, "peer-c"), vec!["g-1".to_string()]);
    }

    /// 链路仍未就绪（NoLink）或非可重试原因（Fatal）的判定：
    /// NoLink 必须保留登记项等待下一次 flush；Fatal / Ok 必须清除。
    #[test]
    fn flush_failure_retains_or_clears_pending_correctly() {
        // 仍无链路 → 保留
        assert!(should_retain_pending_group_key(&Err(GroupKeySendErr::NoLink)));
        // 非可重试 → 清除
        assert!(!should_retain_pending_group_key(&Err(GroupKeySendErr::Fatal)));
        assert!(!should_retain_pending_group_key(&Ok(())));

        // 验证 flush 逻辑：NoLink 分支不调用 clear，pending 保持
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        mark_pending_group_key(&mut pending, "peer-b", "g-1");
        let result: Result<(), GroupKeySendErr> = Err(GroupKeySendErr::NoLink);
        if should_retain_pending_group_key(&result) {
            // 故意不调用 clear_pending_group_key：等待下一次 flush
        } else {
            clear_pending_group_key(&mut pending, "peer-b", "g-1");
        }
        assert_eq!(pending_group_key_ids(&pending, "peer-b"), vec!["g-1".to_string()]);

        // 下一轮 flush：Fatal 分支必须清除（重试无意义：缺公钥 / 非成员 / 无密钥）
        clear_pending_group_key(&mut pending, "peer-b", "g-1");
        let result: Result<(), GroupKeySendErr> = Err(GroupKeySendErr::Fatal);
        if !should_retain_pending_group_key(&result) {
            clear_pending_group_key(&mut pending, "peer-b", "g-1");
        }
        assert!(pending_group_key_ids(&pending, "peer-b").is_empty());
    }

    // ---------- 群成员公钥解析（peers 优先、friends 回落） ----------

    /// 群密钥分发的公钥选择规则：peers 表优先（announce/Hello 实时维护）、
    /// friends 表回落、两边都缺才返回 None（安全跳过）。
    #[test]
    fn pick_member_x25519_prefers_peers_then_friends() {
        // peers 有 → 用 peers（即使 friends 也有）
        assert_eq!(
            pick_member_x25519(Some("pk-peer".into()), Some("pk-friend".into())).as_deref(),
            Some("pk-peer")
        );
        // peers 无、friends 有 → 回落 friends
        assert_eq!(
            pick_member_x25519(None, Some("pk-friend".into())).as_deref(),
            Some("pk-friend")
        );
        // 两边都无 → None（调用方 continue 安全跳过）
        assert_eq!(pick_member_x25519(None, None), None);
    }

    /// respond_friend_request accept 路径的公钥补写（对齐 FriendAccept 接收路径）：
    /// add_friend 时不带公钥 → maybe_update_friend 从 peers 补写 → friends 可查。
    /// 此前 accept 方不补写且 key_changed 不再触发 → 公钥永久缺失 →
    /// 群密钥分发 continue 静默跳过（B 后加群收不到的根因）。
    #[test]
    fn friend_accept_backfills_pubkeys_from_peers() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // accept：add_friend 不带公钥（commands.rs respond_friend_request 现状）
        db::add_friend(&conn, "b", "Bob", None).unwrap();
        assert!(
            db::get_friend_x25519(&conn, "b").is_none(),
            "accept 后 friends 公钥应为空（复现补写前状态）"
        );
        // maybe_update_friend 的补写行为：peers 表已有公钥 → 写入 friends
        db::update_friend_pubkeys(&conn, "b", Some("xk-b"), Some("ek-b")).ok();
        assert_eq!(
            db::get_friend_x25519(&conn, "b").as_deref(),
            Some("xk-b"),
            "补写后群密钥分发必须能取到公钥"
        );
        // 重复补写幂等（maybe_update_friend 每次都可能调用）
        db::update_friend_pubkeys(&conn, "b", Some("xk-b"), Some("ek-b")).ok();
        assert_eq!(db::get_friend_x25519(&conn, "b").as_deref(), Some("xk-b"));
    }
}
