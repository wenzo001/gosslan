// ---------------- Gossip 处理 ----------------

// 本文件由 transport.rs 用 include! 展开进同一模块（见该文件末尾的分册登记）。
/// 新链路建立时补递一次（#77）：把窗口内替别人转发过、而当时那条链路还不存在的群信封重递。
///
/// 为什么 spawn 而不是就地 await：四个调用点全在**建链热路径**上（入站 accept、
/// 出站拨号、BLE 两条），而 `try_send` 在信道满时有界补试 500ms —— 同步等就是
/// 把握手后的第一步拖住。补递失败不另加补救：对端下一次建链还会再试，窗口本来
/// 就是有界的（这一条是"尽力补递"，不是"必达"）。
pub(crate) fn replay_group_frames_to(
    state: &std::sync::Arc<crate::state::AppState>,
    peer_id: &str,
) {
    let st = state.clone();
    let peer = peer_id.to_string();
    tokio::spawn(async move {
        let first = replay_group_frames_once(&st, &peer).await;
        if first == 0 {
            return; // 没递出去（多半是间隔门挡住了）⇒ 不占着一个 30s 的定时器
        }
        // 第二趟是**这条链路的判据本身**，不是保险丝：对端刚上线那几秒还不认识发送方
        // （`peers` 是内存态、群消息不在 TOFU 白名单里），第一趟必然被静默丢掉。
        // 2026-09-27 第一次跑 `--round=gossip-late` 就是这个形状 —— B 记了成功、C 库里 0 行。
        // 不能改成"等下一个链路事件"：对端会拒绝重复入站（实测 C 每 10s 拒一次），
        // 那等于把第二趟的触发权交给不一定会发生的时序。
        tokio::time::sleep(std::time::Duration::from_millis(
            crate::mesh::gossip_replay::REPLAY_MIN_INTERVAL_MS as u64,
        ))
        .await;
        replay_group_frames_once(&st, &peer).await;
    });
}

/// 一趟补递：取出这个 peer 此刻该补的信封、逐条发出去，返回发出去几条。
async fn replay_group_frames_once(state: &std::sync::Arc<crate::state::AppState>, peer: &str) -> usize {
    let frames = {
        let mut cache = state
            .gossip_relay
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // take_due 而不是 eligible：同一个 peer 两次补递之间要有最小间隔 ——
        // 链路会在几十秒里反复登记，每次都重发一遍既没用也费电。
        cache.take_due(peer, &state.device_id, crate::mesh::gossip_replay::now_ms())
    };
    if frames.is_empty() {
        return 0;
    }
    let mut sent = 0usize;
    for mut env in frames {
        // `eligible` 已保证 ttl >= 2 ⇒ 这里 -= 不会下溢，递出去的副本对端还能再转
        env.ttl -= 1;
        if try_send(state, peer, &Message::Gossip { envelope: env })
            .await
            .is_ok()
        {
            sent += 1;
        }
    }
    if sent > 0 {
        state.logger.info(
            "link",
            format!(
                "补递群消息 peer={peer} 条数={sent}（窗口 {}ms）",
                crate::mesh::gossip_replay::RELAY_WINDOW_MS
            ),
        );
    }
    sent
}

/// 群信封能否被**本机消费**（= 是否允许进入第 5 步的本地处理）。
///
/// ⚠️ 这条判据**只管"消费"，不管"转发"**（2026-09-13 审计的真缺陷）。
///
/// 旧实现在这里直接 `return`，于是**非成员中继根本不会转发群消息**：
/// 三个 BLE-only 设备串成 A—B—C 时，只要 B 不在群里，A 发的群消息到 B 就没了
/// —— 而同一条链路上单聊是通的（单聊走定向 target 分支）。
/// 表现就是"BLE mesh 上群聊永远不通、私聊却正常"。
///
/// 语义边界（为什么"非成员转发"是安全的）：
/// - 群消息正文用**群密钥**对称加密，非成员没有密钥 ⇒ 解不开（`plaintext = None`），
///   转发它只是搬密文，不泄露任何内容；
/// - 是否愿意替别人转发，由**中继授权（M4）**决定（`decide_forward`），不靠这条判据；
/// - `sender` 必须在成员表里：签名只证明"是谁发的"，不证明"发送者有权把人拉进群"，
///   所以伪造者发的群信封即使广播过来，本机也不消费它。
pub(crate) fn group_envelope_consumable(
    kind: &GossipKind,
    members: &[String],
    me: &str,
    sender: &str,
) -> bool {
    if !matches!(kind, GossipKind::Group) {
        return true;
    }
    // 成员表为空 = 旧端 / 早期实现发的群信封，保持兼容（与旧代码同口径）
    if members.is_empty() {
        return true;
    }
    members.iter().any(|m| m == me) && members.iter().any(|m| m == sender)
}

/// 撤销一次「已登记但没消费成功」的去重（补发重入）。
///
/// 去重登记发生在解密/落库**之前**（防止伪造 id 污染 Bloom），而发送方补发的是**同一个
/// 信封**（outbox 存的就是签名后的原始 payload）⇒ 不撤销的话，第一次没消费成功就等于
/// 之后每一份补发都被判 `Duplicate`，这条消息永远进不来（直到进程重启）。
///
/// 两张表都要撤：`MeshRouter` 的帧级去重在外层，`GossipEngine` 的 message_id 去重在里层。
fn allow_message_retry(state: &AppState, message_id: &str, why: &'static str) {
    state
        .mesh_router
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .allow_retry(message_id);
    state
        .gossip
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .allow_retry(message_id);
    if log_throttled(why, 5_000) {
        state.logger.warn(
            "chat",
            format!("已放行补发重入 msg={message_id} reason={why}"),
        );
    }
}

/// 入站信封的会话归属（唯一定义点）。
///
/// 群聊的会话键只能来自 `group_id`；`sender_id` 是「谁说的」，不是「说在哪个会话」。
/// 目标缺失/空白时返回 `None`，由调用方丢弃并留痕 —— **不许**回退到 `group:` 或单聊。
pub(crate) struct InboundConversation {
    pub conv_id: String,
    pub kind: &'static str,
    /// 仅群聊有值；供群名/边界等后续步骤复用，避免再从 `sender_id` 猜。
    pub group_id: Option<String>,
}

pub(crate) fn inbound_conversation(
    kind: &GossipKind,
    group_id: Option<&str>,
    sender_id: &str,
) -> Option<InboundConversation> {
    match kind {
        GossipKind::Chat => Some(InboundConversation {
            conv_id: sender_id.to_string(),
            kind: "single",
            group_id: None,
        }),
        GossipKind::Group => {
            // 只判空白，不改写目标本身：群 id 是身份，不是展示文本。
            let gid = group_id.filter(|g| !g.trim().is_empty())?;
            Some(InboundConversation {
                conv_id: format!("group:{gid}"),
                kind: "group",
                group_id: Some(gid.to_string()),
            })
        }
        _ => None,
    }
}

/// peers 里查不到的发送方，能否按 kind 建立信任。
///
/// 唯一判定点（`handle_gossip` 的 sender_trusted 与回归测试共用）：
/// - `friend_ed25519 = Some`（friends 表在册且绑过键）⇒ **只认绑定值**，任何 kind
///   都不给 TOFU —— friends 是持久化身份锚，「重启后 peers 为空」不是放行冒充的理由；
/// - 不在册、或旧行键列为 NULL ⇒ 只放行 Presence（节点可见性）与加好友流程的
///   FriendRequest/FriendAccept（它们本来就来自陌生节点），其余（Chat/Group/回执）
///   仍然拒绝。NULL 键好友的宽容行为与修复前一致，避免误伤旧数据。
fn gossip_trust_for_unpeer_sender(
    kind: &GossipKind,
    friend_ed25519: Option<&str>,
    env_ed25519: &str,
) -> bool {
    if let Some(stored) = friend_ed25519 {
        return stored == env_ed25519;
    }
    matches!(
        kind,
        GossipKind::Presence | GossipKind::FriendRequest | GossipKind::FriendAccept
    )
}

/// 本机可继续转发时，转发信封应带的 TTL；`None` = 不再转发。
///
/// 唯一真相是 [`MeshRouter::on_receive`] 的 Forward 决策（`max_ttl` 裁剪 + 递减）。
/// TTL 不在 Ed25519 签名范围内，绝不能拿信封自报的 `env.ttl` 直接减一 ——
/// 对端自报 255 时那就是一条能跨 254 跳扩散的信封（设计上限 6）。
fn forward_ttl_from(decision: &ForwardDecision) -> Option<u8> {
    match decision {
        ForwardDecision::Forward { frame, .. } => Some(frame.ttl),
        _ => None,
    }
}

async fn handle_gossip(state: &Arc<AppState>, peer_id: &str, env: GossipEnvelope) {
    // Gossip 可经第三方转发，不能仅凭信封内自报的 Ed25519 公钥建立身份。
    // 公钥必须先由 Discovery/Hello 绑定到同一个 device_id；若已知 X25519
    // 公钥也发生变化，同样拒绝，避免冒充好友或污染 E2EE 密钥缓存。
    // peers 快照必须在 db 锁**之前**取完并放锁：`peers` 与 `db` 是两把独立的
    // std Mutex，而下面 None 分支要读 friends 表（db）。本函数在每条 Gossip 的接收
    // 热路径上，若持 peers 求 db，就与 Hello 路径的 db→peers 构成 ABBA ——
    // 重启后 `peers` 为空，第一封 Gossip 必走 None 分支，正是最容易撞上的时刻。
    let peer_anchor = {
        let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers
            .get(&env.sender_id)
            .map(|p| (p.ed25519_pubkey.clone(), p.x25519_pubkey.clone()))
    };
    let sender_trusted = {
        if env.sender_id == state.device_id {
            false
        } else {
            match peer_anchor {
                // 已认识：公钥必须匹配（无论是直连还是跨跳转发），防冒充。
                Some((ed25519, x25519)) => {
                    let direct_peer = peer_id == env.sender_id;
                    (ed25519.as_deref() == Some(env.sender_ed25519.as_str())
                        || (direct_peer && ed25519.is_none()))
                        && (x25519
                            .as_deref()
                            .map_or(true, |key| key == env.sender_pubkey)
                            || (direct_peer && x25519.is_none()))
                }
                // 未认识（peers 里查不到）。⚠️ peers 是**内存态**，进程重启后为空、
                // 好友恰好不在线时也会缺席 —— 「不在 peers」不等于「陌生节点」。
                // friends 表才是持久化的身份锚：已在册的 id 一律按绑定的 ed25519 判，
                // 不给 Presence/FriendRequest/FriendAccept 留 TOFU 后门
                //（2026-09-19 审计 P0#3：此前攻击者可用自签信封冒充重启后缺席的好友）。
                None => {
                    let stored = {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        db::get_friend_ed25519(&dbc, &env.sender_id)
                    };
                    gossip_trust_for_unpeer_sender(
                        &env.kind,
                        stored.as_deref(),
                        &env.sender_ed25519,
                    )
                }
            }
        }
    };
    if !sender_trusted {
        return;
    }
    // 直连 TCP 对端在 Hello 中没有携带公钥时，首次合法 Gossip 可完成 TOFU
    // 绑定；之后所有经中继或直连的信封都必须匹配这组键。
    if peer_id == env.sender_id {
        let mut peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
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
    // 块返回值 = 本机可继续转发的 TTL（None = 不再转发），供第 4 步使用。
    let mesh_forward_ttl = {
        let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
        if !gossip.verify_envelope(&env) {
            return;
        }
        drop(gossip);
        // Mesh 层：**全局去重 + TTL 判定**（§15 / §16 / §17）。
        //
        // 必须在**验签之后**才登记去重表，否则攻击者可用伪造的 frame_id 污染
        // Bloom，抢先占用真实帧的 id 造成合法消息被丢弃 —— 与上面 GossipEngine
        // 的防护同理。
        //
        // ⚠️ 这里**只判定不转发**：真正的多跳转发在下面第 4 步（`decide_forward` +
        // `choose_fanout`）。历史上这里还有一条由 `MeshRouter::relay_enabled` 门控的
        // 转发路径（默认关闭、生产从不调用），2026-09-12 已删除 ——
        // **中继授权的唯一真相是 `settings.relay_policy`**（ADR-0016），
        // 接 BLE 时不要再复制第二份转发记账。
        //
        // 转发出去的信封 TTL **只能取自这里的 Forward 决策**（`max_ttl` 裁剪 + 递减）。
        // TTL 不参与 Ed25519 签名（`protocol.rs` 的 signing_bytes），对端可自报 255；
        // 旧写法用 `env.ttl - 1` 重建信封 ⇒ 一条 Gossip 能跨 254 跳扩散（设计上限 6）。
        let mesh_ttl = {
            let mut router = state.mesh_router.lock().unwrap_or_else(|e| e.into_inner());
            let frame = MeshFrame {
                frame_id: env.message_id.clone(),
                source_node_id: env.sender_id.clone(),
                destination: MeshDestination::Broadcast,
                ttl: env.ttl,
                kind: MeshFrameKind::Gosslan,
                // 转发在别处做，这里只需要元数据（MeshRouter 不解析载荷，P-A03）
                payload: Vec::new(),
            };
            let decision = router.on_receive(frame, &state.device_id);
            if let ForwardDecision::Drop(_) = decision {
                return;
            }
            forward_ttl_from(&decision)
        };
        // 业务层去重（Mesh 之后的第二道防线）
        let mut gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
        if !gossip.is_new(&env.message_id) {
            return;
        }
        mesh_ttl
    };
    // 2. 同步发送方公钥：GossipEnvelope 已携带 x25519_pubkey 用于解密，
    //    但此前未写入 peers/friends，导致后续 outbox 重发的直发 ChatMessage
    //    在 open_direct_content() 中因缺 pubkey 被丢弃。此处仅更新已有 peer
    //    条目（不做 insert，避免为未通过 Discovery 的节点创建残缺记录），
    //    同时用 COALESCE 安全地补充 friends 表的 NULL pubkey。
    if env.encrypted && matches!(env.kind, GossipKind::Chat) {
        // 先在 peers 锁内完成内存更新并**立刻放锁**，再取 db 写：见上方 peer_anchor
        // 的锁序说明（gossip 的另一条路径就是 peers→db，本处不能反向嵌套）。
        let learned = {
            let mut peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
            match peers.get_mut(&env.sender_id) {
                Some(p) if p.x25519_pubkey.is_none() => {
                    p.x25519_pubkey = Some(env.sender_pubkey.clone());
                    p.last_seen = db::now_ms();
                    true
                }
                _ => false,
            }
        };
        if learned {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::update_friend_pubkeys(&dbc, &env.sender_id, Some(&env.sender_pubkey), None).ok();
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
            GossipKind::Presence => {
                // Presence 必然是明文；收到 encrypted=true 的是异常，丢弃。
                return;
            }
            GossipKind::FriendRequest | GossipKind::FriendAccept => {
                // 定向好友控制消息：发送方用 target 的 X25519 公钥加密，只有 target
                // 能用自己的私钥解开；中间节点解不开（plaintext=None），无害。
                let shared =
                    crypto::shared_secret(&state.identity.x25519_secret, &env.sender_pubkey);
                shared.and_then(|s| {
                    STANDARD
                        .decode(&env.payload)
                        .ok()
                        .and_then(|d| crypto::open(&s, &d))
                })
            }
            GossipKind::ChatAck | GossipKind::ChatReadReceipt => {
                // 回执/确认必然是明文；收到 encrypted=true 的是异常，丢弃。
                return;
            }
        }
    };

    // 群信封即使签名正确，也只能被群成员**消费**；签名证明“是谁发的”，
    // 不代表发送者有权把任意节点加入一个群。
    //
    // ⚠️ 这里**只记判据、不 return**（2026-09-13 审计）：非成员也要继续走第 4 步的转发，
    // 否则 BLE-only 三点中继里的群聊永远不通（细节见 `group_envelope_consumable` 的注释）。
    let group_consumable = group_envelope_consumable(
        &env.kind,
        &env.group_members,
        &state.device_id,
        &env.sender_id,
    );

    // 解不开 = 这次**没有消费成功**（缺群密钥 / 缺对端 X25519）。放行补发重入，
    // 否则发送方每一次重试都会被上面的去重判成 Duplicate。只对本机该消费的信封放行：
    // 替别人转发的密文本来就解不开，撤销只会放大噪声。
    let addressed_to_me = env
        .target
        .as_deref()
        .map_or(true, |t| t == state.device_id.as_str());
    if plaintext.is_none()
        && addressed_to_me
        && matches!(env.kind, GossipKind::Chat | GossipKind::Group)
        && group_consumable
    {
        allow_message_retry(state, &env.message_id, "no_plaintext");
    }

    // 4. 转发（fan-out，TTL 衰减）— 先过**中继授权**（P2 / M4），再选人转发。
    //
    // 三条判据全部收在 `mesh::relay_policy::decide_forward` 里（真值表有单测），
    // 这里只负责喂事实，避免把传播语义散落成 if：
    //   ① 定向帧到达目标后**停止转发**（本机就是 target，只消费）：否则目标会把定向帧
    //      再洪泛给其他邻居，邻居又按 target 定向转发回来，形成冗余中转与回环。真机反馈
    //      「同网段好友申请一直中转、清掉还冒出来」正是这个回环造成的；
    //   ② TTL 耗尽不再转发；
    //   ③ 替**别人**转发要过授权策略（自己发的信封不受策略限制）。
    //
    // ⚠️ 默认策略是 `all`（与今天逐字节一致）；好友/白名单查询是**按需**的 ——
    // `all`/`off` 下一次库都不查，转发热路径零额外开销。
    let is_target = env.target.as_deref() == Some(state.device_id.as_str());
    let sender_is_me = env.sender_id == state.device_id;
    let relay_cfg = state.relay_policy_config();
    // 只有 MeshRouter 判了“可以继续转发”的信封才进入授权判定。
    // 授权判据仍喂**信封自报的 ttl**（`decide_forward` 的 `ttl <= 1` 是“别再转发”的语义，
    // 与路由器 Deliver 一致）；真正写给下一跳的 TTL 用路由器**裁剪并递减后**的值。
    // 不能把递减后的 1 喂给 `decide_forward`：那会把 `env.ttl=2`（还能再走一跳）提前停掉。
    let forward_ttl = match mesh_forward_ttl {
        Some(fwd_ttl)
            if crate::mesh::relay_policy::decide_forward(
                &relay_cfg,
                is_target,
                env.ttl,
                sender_is_me,
                &env.sender_id,
                || {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::get_friend(&dbc, &env.sender_id).is_some()
                },
            ) =>
        {
            Some(fwd_ttl)
        }
        _ => None,
    };
    if let Some(fwd_ttl) = forward_ttl {
        // 定向帧（FriendRequest/FriendAccept/ChatAck/ChatReadReceipt）优先精确定向：
        // target 是本机直连就只发它；无直连路径时洪泛兜底（第一版无路由表）。广播帧保持 fan-out。
        let targets: Vec<String> = match env.target.as_deref() {
            Some(t) => {
                // ⚠️ 必须判「有**非空**链路」（等价于 `has_link`），不能用 `contains_key`：
                // 后者会把残留的空 Vec 当成「直连」→ 走只发 target 的分支 →
                // `try_send` 返回「未建立连接」，而**洪泛兜底不会执行** ⇒
                // 跨跳的好友申请 / 送达回执 / 已读回执可能永久丢失（复核抓到的缺陷）。
                let direct = {
                    let links = state.links.lock().await;
                    links.get(t).is_some_and(|v| !v.is_empty())
                };
                if direct {
                    vec![t.to_string()]
                } else {
                    let neighbors = reachable_neighbors(state, &env.sender_id).await;
                    let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
                    gossip.choose_fanout(&neighbors, &env.sender_id)
                }
            }
            None => {
                let neighbors = reachable_neighbors(state, &env.sender_id).await;
                let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
                gossip.choose_fanout(&neighbors, &env.sender_id)
            }
        };
        let mut fwd = env.clone();
        // TTL 的唯一真相是 MeshRouter（`max_ttl` 裁剪 + 递减），不是在信封自报值上再减一。
        fwd.ttl = fwd_ttl;
        // 记下这条**准备转发出去的原样信封**（#77）：窗口内新建成链路的成员由
        // `replay_group_frames_to` 补递一次。只记 Group + 成员表非空的（口径同
        // `group_envelope_consumable`）。
        // ⚠️ 记在这里、**在 `targets` 之后**是刻意的：这一刻邻居可能一个都没有
        //（`targets` 为空 ⇒ 一次也发不出去），而"当时递不到、以后要递"恰恰是这一格的产品行为。
        // 记在发送成功之后就等于什么都没记。
        {
            let mut cache = state
                .gossip_relay
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            cache.remember(&fwd, crate::mesh::gossip_replay::now_ms());
        }
        let fwd_msg = Message::Gossip { envelope: fwd };
        // ⚠️ 转发**不阻塞本连接的读循环**：`try_send` 在信道满时有界补试 500ms，
        // 逐条 await 最坏 4 × 500ms = 2s —— 期间这条连接的后续帧（含心跳）都要排队，
        // shutdown/取消也要等。顺序在这里无关紧要（接收侧按 msg_id 去重，而且这些
        // 只是同一条消息发给**不同**邻居）。用一个任务串行发完：并发度不变、任务数可控。
        let st = state.clone();
        tokio::spawn(async move {
            for t in targets {
                let _ = try_send(&st, &t, &fwd_msg).await;
            }
        });
    }

    // 5. 按 GossipKind 处理
    //
    // 非成员**跳过本地消费**（上面的转发已经做完了）：群密钥不在手上，本来也解不开，
    // 但绝不能因为"我不是这个群的成员"就把整条消息丢掉 —— 那样多跳群聊永远不通。
    if !group_consumable {
        return;
    }
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
        GossipKind::Presence => {
            // TOFU 记录远端节点：跨跳转发的 Presence，sender 可能不在 peers 里。
            // 「去中心化发现」的落地 —— A 经 B 转发看到 C，C 进入 peers 表，
            // 前端「添加好友」列表即出现 C（即使 A 与 C 无直连）。
            if let Some(pt) = plaintext {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                    let nickname = v
                        .get("nickname")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let avatar = v
                        .get("avatar")
                        .and_then(|a| a.as_str())
                        .map(|s| s.to_string());
                    let device_type = v
                        .get("device_type")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string();
                    // 首次学到才留痕：peers 是内存结构、不落库，这行日志是唯一可观测
                    // 「跨跳发现了谁」的手段（与 [mesh] ±conn、握手学到身份同理）。
                    let is_new = {
                        let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
                        !peers.contains_key(&env.sender_id)
                    };
                    if is_new {
                        state.logger.info(
                            "presence",
                            format!("学到远端节点 peer={} nickname={}", env.sender_id, nickname),
                        );
                        // 🎯 同局域网却走桥接的直接修复（真机 2026-09-14 全 Windows 局域网）：
                        // 新学到的**跨跳**节点只有 ip="" 的 Presence，永远不会触发 LAN 拨号
                        // （ensure_link 只由 UDP announce 驱动）⇒ 同网段也只能一直走中继。
                        // 主动喊一轮 who_has：同网段的节点会用**单播**把 announce 回给我们，
                        // 我们随即建立直连；不在同网段的节点收不到单播、不受影响。
                        if let Some(tx) = state
                            .probe
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .as_ref()
                        {
                            let next = tx.borrow().saturating_add(1);
                            let _ = tx.send(next);
                        }
                    }
                    // ip 空、tcp_port 0：跨跳转发不知道对端真实地址，仅记录身份
                    // （可被「看到」，但不可直连）。
                    upsert_peer(
                        state,
                        &env.sender_id,
                        &nickname,
                        avatar,
                        &device_type,
                        "",
                        0,
                        Some(env.sender_pubkey.clone()),
                        Some(env.sender_ed25519.clone()),
                        None,
                    )
                    .await;
                }
            }
        }
        GossipKind::FriendRequest => {
            // 定向好友申请：只有 target == 本机才处理（中间节点已转发，不消费）。
            if env.target.as_deref() == Some(state.device_id.as_str()) {
                if let Some(pt) = plaintext {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                        let from_nickname = v
                            .get("from_nickname")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        let from_avatar = v
                            .get("from_avatar")
                            .and_then(|a| a.as_str())
                            .map(|s| s.to_string());
                        // 同步记录申请方身份与公钥：这样「同意」时才有对方 X25519 公钥
                        // 可加密回发的 FriendAccept（跨跳场景下 Presense 可能还没到）。
                        upsert_peer(
                            state,
                            &env.sender_id,
                            &from_nickname,
                            from_avatar.clone(),
                            "",
                            "",
                            0,
                            Some(env.sender_pubkey.clone()),
                            Some(env.sender_ed25519.clone()),
                            None,
                        )
                        .await;
                        // 登记、事件、留痕与系统通知都在 `apply_friend_request` 那一个家里做
                        // （直连那条走同一个家）—— 通知由「本机是否第一次握着这条申请」门控，
                        // 发送方每 5s 心跳补发一份新 message_id 的信封不该刷屏。
                        apply_friend_request(
                            state,
                            PendingRequest {
                                from: env.sender_id.clone(),
                                from_nickname,
                                from_avatar,
                                ts: env.ts,
                            },
                            "收到跨跳好友申请",
                        )
                        .await;
                    }
                }
            }
        }
        GossipKind::FriendAccept => {
            // 定向好友同意：只有 target == 本机才处理（即「我发的申请被对方同意」）。
            if env.target.as_deref() == Some(state.device_id.as_str()) {
                let from = env.sender_id.clone();
                // 与直连同一家（`apply_friend_accept`，就在本模块里 —— 这个文件是被
                // `include!` 进 transport.rs 的）。"重复投递不许刷屏"这条判据原先**只有这一份有**
                // ⇒ 直连链路上"被『好友申请已通过』反复刷屏"照旧存在（2026-09-28 复审抓到）。
                apply_friend_accept(state, &from, "收到跨跳好友同意");
            }
        }
        GossipKind::ChatAck => {
            // 定向送达确认：只有 target == 本机才处理（即「我发的消息被对方收到」）。
            if env.target.as_deref() == Some(state.device_id.as_str()) {
                if let Some(pt) = plaintext {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                        if let Some(msg_id) = v.get("msg_id").and_then(|m| m.as_str()) {
                            // 只有「我发给 sender、且仍在 outbox」的 msg_id 才接受：
                            // msg_id 随机不可预测 + 必须命中 outbox 目标，双重防伪造送达
                            // —— 这条校验现在由 `db::ack_delivered` 在事务里做（见下）。
                            //
                            // ⚠️ 与直连 `Message::Ack` / 群 `GroupAck` 走**同一处**事务出口
                            // （2026-10-20 永久发送中 P0 的第四个入口）：这里旧写法是
                            // `set_message_status(...).ok()` + 内联 `DELETE ... .ok()` 两条独立写，
                            // 状态写失败而删行成功就留下「队列行没了、消息还是 sending」——
                            // 清扫器只扫 outbox、补发也没有行可发，界面永久发送中。
                            // `ack_delivered` 把「校验命中 + 置 delivered + 删行」放进一个事务，
                            // 失败全回滚（队列行与 sending 都保留，等下一次补发再收尾）。
                            let applied = {
                                let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                                db::ack_delivered(&dbc, msg_id, &env.sender_id)
                            };
                            match applied {
                                Ok(true) => {
                                    let _ = state.app.emit("message-acked", msg_id);
                                }
                                Ok(false) => {
                                    // 不是发给这个发送方的 / 已经收尾过的 Ack：
                                    // 与旧行为一致，静默丢弃（不 emit、不动任何行）。
                                }
                                Err(e) => {
                                    state.logger.error(
                                        "ack",
                                        format!(
                                            "code=ACK_COMMIT_FAILED via=gossip msg_id={msg_id} \
                                             peer={} err={e} —— 队列行与 sending 状态都保留，\
                                             等下一次补发后再收尾",
                                            env.sender_id
                                        ),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        GossipKind::ChatReadReceipt => {
            // 定向已读回执：只有 target == 本机才处理。
            if env.target.as_deref() == Some(state.device_id.as_str()) {
                if let Some(pt) = plaintext {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&pt) {
                        let from = env.sender_id.clone();
                        let last_read_ts =
                            v.get("last_read_ts").and_then(|t| t.as_i64()).unwrap_or(0);
                        let last_read_msg_id = v
                            .get("last_read_msg_id")
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string());
                        // 与 Message::ReadReceipt 分支同构：用 msg_id 换算回本机时间戳。
                        let effective_ts = {
                            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                            last_read_msg_id
                                .as_deref()
                                .and_then(|msg_id| {
                                    dbc.query_row(
                                        "SELECT ts FROM messages WHERE msg_id = ?1 AND sender_id = ?2 AND conv_id = ?3",
                                        params![msg_id, state.device_id, from],
                                        |r| r.get::<_, i64>(0),
                                    )
                                    .ok()
                                })
                                .unwrap_or(last_read_ts)
                        };
                        {
                            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                            // 与直连回执同一个家（`db::mark_own_messages_read_upto`）：
                            // 这两处原先各写一份只排除 `read` 的 UPDATE，
                            // 会把本端发送失败的消息一起点亮成「已读」。
                            let _ = db::mark_own_messages_read_upto(
                                &dbc,
                                &from,
                                &state.device_id,
                                effective_ts,
                            );
                        }
                        let _ = state.app.emit(
                            "peer-read",
                            &serde_json::json!({ "peer_id": from, "last_read_ts": effective_ts }),
                        );
                    }
                }
            }
        }
        GossipKind::Chat | GossipKind::Group => {
            // 单聊定向：target 存在且不是本机 → 中间节点只转发不消费。即便不判断，
            // 中间节点也会因 ECDH 解不开而 plaintext=None（不会落库），但明确判断
            // 语义更清晰、也避免无谓的好友关系检查。群聊无 target，走原广播消费逻辑。
            if env.kind == GossipKind::Chat
                && env
                    .target
                    .as_deref()
                    .is_some_and(|t| t != state.device_id.as_str())
            {
                return;
            }
            // ⚠️ 可观测性缺口（用户 2026-10-13：「刚加了好友，两端能看到互相在线，但我发的单聊他收不到」）。
            // 定向给**本机**的加密单聊信封如果在这里解不开，下面那句 `if let Some(pt)` 整块跳过：
            // 不落库、不通知界面、也**不回 ChatAck** ⇒ 发送端状态永远停在「已发送」（不是"没送达"），
            // outbox 行永远留着，每次重连再用同一把（可能已过期的）公钥重新密封发一遍 ——
            // 失败是静默且自我一致的，两端日志各留一片空白，事后根本分不出"没收到"与"收到了打不开"。
            // 这一条就是那道分界；只报布尔量，不报密钥本身（日志会进报告产物）。
            if env.kind == GossipKind::Chat && env.encrypted && plaintext.is_none() {
                let (has_local_key, local_matches_envelope) = {
                    let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
                    match peers.get(&env.sender_id).and_then(|p| p.x25519_pubkey.as_deref()) {
                        // 本机没有对方的 X25519：这条一定解不开（要等同步新密钥或对方重新上线补齐）
                        None => (false, false),
                        Some(k) => (true, k == env.sender_pubkey.as_str()),
                    }
                };
                state.logger.warn(
                    "chat",
                    format!(
                        "单聊信封解不开（本机为接收方）msg={} peer={} 本机存有对方密钥={} 与信封自报一致={}",
                        env.message_id, env.sender_id, has_local_key, local_matches_envelope
                    ),
                );
            }
            if let Some(pt) = plaintext {
                let crate::protocol::GossipPlaintext {
                    kind,
                    content,
                    mentions,
                    mention_targets,
                } = crate::protocol::parse_gossip_plaintext(&pt);
                // 入站内容长度（审计 P1 #7）：发送侧的 5 万字符闸只约束本机用户，对端可以
                // 绕过它投一条超大 content ⇒ 明文整份进 SQLite。口径与发送侧同一份
                // （`commands::content_within_limit`），超限**不落库、不通知**。
                // 泛洪转发在解密之前（盲中继，看不到明文）⇒ 这里只负责本机落库边界。
                if !crate::commands::content_within_limit(&content) {
                    state.logger.warn(
                        "chat",
                        format!(
                            "code=INBOUND_CONTENT_TOO_LONG msg={} kind={} chars={} from={}",
                            env.message_id,
                            kind,
                            content.chars().count(),
                            env.sender_id
                        ),
                    );
                    return;
                }
                // §29 可观测性：这一行是「有人@我 为什么亮 / 为什么不亮」唯一能事后归因的留痕。
                // 修之前判不到根的机制就在这儿 —— 链路里只有昵称、没有「@ 了谁」，日志也就
                // 永远分不开「对端没带名单（旧版本，按昵称兜底）」和「对端明确说谁都没 @」。
                // 只记条数，不记 id、不记正文（日志会进报告产物）。
                if env.kind == GossipKind::Group {
                    state.logger.info(
                        "group",
                        format!(
                            "群消息@输入 msg={} mentions={} targets={}",
                            env.message_id,
                            mentions.as_ref().map_or("none".to_string(), |v| v.len().to_string()),
                            // 只记条数：落点里带昵称，昵称不进日志（日志会进报告产物）
                            mention_targets.as_ref().map_or("none".to_string(), |v| v.len().to_string())
                        ),
                    );
                } else {
                    // 单聊也要留一条"到达本机并解开"的正向痕迹（此前只有群聊有 ⇒ 手机日志里
                    // "没收到"与"收到了但没有任何一行"完全同形，用户只能报"不知道为什么收不到"）。
                    // 记 kind 不记正文：与群聊那条同一口径，正文/昵称不进日志。
                    state.logger.info(
                        "chat",
                        format!("单聊消息已收 msg={} kind={}", env.message_id, kind),
                    );
                }
                // GossipKind::Chat：好友关系检查（非好友不落库、不通知、通知发送方）
                if env.kind == GossipKind::Chat {
                    let is_friend = {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        db::get_friend(&dbc, &env.sender_id).is_some()
                    };
                    if !is_friend {
                        // 通过 Gossip 广播拒绝通知（多跳场景下也能回到原始发送方）
                        let mut blocked_env = {
                            let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
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
                                0,
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
                let Some(target) =
                    inbound_conversation(&env.kind, env.group_id.as_deref(), &env.sender_id)
                else {
                    if env.kind == GossipKind::Group {
                        state.logger.warn(
                            "group",
                            format!(
                                "丢弃缺少群目标的群信封 msg={} sender={} —— 会话归属不猜、不回退到单聊",
                                env.message_id, env.sender_id
                            ),
                        );
                    }
                    return;
                };
                let conv_id = target.conv_id;
                let conv_kind = target.kind;
                let name = match conv_kind {
                    "single" => resolve_nickname(state, &env.sender_id),
                    _ => resolve_group_name(state, target.group_id.as_deref().unwrap_or("")),
                };
                // 群聊删除边界：本机清除过该群（seq ≤ boundary）的旧历史不得回灌。
                // 逻辑序号不依赖墙上时钟，也不猜测发送方时钟。
                if env.kind == GossipKind::Group {
                    let gid = env.group_id.clone().unwrap_or_default();
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let blocked = db::group_message_blocked_by_boundary(&dbc, &gid, env.seq, &kind);
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
                        // ⚠️ **信封里的群名只有群主本人能生效**。
                        //
                        // `group_name` / `group_creator` 都是发送方自报的字段，任何持群密钥的
                        // 成员都能填任意文本。但「改名」已经有专用帧 `GroupRename` 且严格要求
                        // 群主 —— 若这里无条件采信，同一个效果就有了两条路径、一条有检查一条
                        // 没有，成员即可绕过授权改掉所有人的群名（伪造成"系统通知"做社工）。
                        //
                        // 两层判断缺一不可：
                        //   ① 发送者必须**自称**群主（否则填别人的 id 就能对上 creator）；
                        //   ② 该自称还要与本地已存的 creator 一致（由 `db::upsert_group` 兜底），
                        //      挡住「自称是群主、但本地记录里群主另有其人」。
                        // 本地无该群时（首次接触，无从校验）按 TOFU 采信信封，与建链口径一致。
                        let mut all = env.group_members.clone();
                        if !all.contains(&state.device_id) {
                            all.push(state.device_id.clone());
                        }
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let known = db::get_group(&dbc, &gid);
                        // 本机从没建过这个群的记录 = 第一次成为它的成员（与 `handle_group_key`
                        // 里那个读数同一个用途，只是这一路是"从未收到 GroupKey、只收到群消息"的成员）。
                        let first_membership = known.is_none();
                        let is_self_declared_creator = env.sender_id == creator;
                        let display_name = match &known {
                            // 已有该群：只有群主自称时才更新名字，否则沿用本地名字
                            Some(g) => {
                                if is_self_declared_creator {
                                    env.group_name.clone().unwrap_or_else(|| g.name.clone())
                                } else {
                                    g.name.clone()
                                }
                            }
                            None => env.group_name.clone().unwrap_or_else(|| name.clone()),
                        };
                        // 群名长度与建群/改名一致封顶，避免这条路径塞进超长字符串
                        let display_name: String =
                            display_name.chars().take(MAX_GROUP_NAME_LEN).collect();
                        if let Err(e) = db::upsert_group(&dbc, &gid, &display_name, &creator, &all) {
                            state.logger.warn(
                                "group",
                                format!("code=GROUP_SYNC_WRITE_FAILED op=upsert group={gid} err={e}"),
                            );
                        }
                        // 只有「发送者自称群主且与本地已知群主一致（首次接触按 TOFU）」的成员表
                        // 才当权威表整体替换；普通成员的成员表仍只增不减，避免一条伪造的
                        // group_members 把别人从本地成员视图里抹掉。
                        let authoritative_members = is_self_declared_creator
                            && known.as_ref().map_or(true, |g| g.creator == creator);
                        if authoritative_members {
                            if let Err(e) = db::replace_group_members(&dbc, &gid, &all) {
                                state.logger.warn(
                                    "group",
                                    format!("code=GROUP_SYNC_WRITE_FAILED op=members group={gid} err={e}"),
                                );
                            }
                        }
                        drop(dbc);
                        let _ = state.app.emit("groups-updated", &gid);
                        // 这一路也是"第一次成为成员"（有些人只收到过群消息、从没收到 GroupKey，
                        // 见上面那段建群注释）。不喊这一声，那一类新成员就永远拿不到历史 ——
                        // 而需求写的是"新进群的人员"，与他靠哪一帧知道自己在群里无关。
                        // 放在 `drop(dbc)` 之后：`note_new_membership` 自己还要取那把锁（INV-P25）。
                        if first_membership {
                            crate::network::group_history::note_new_membership(state, &gid);
                        }
                    }
                }
                let preview = preview_content(&kind, &content);
                // 撤回事件：把「已撤回」物化到被撤回的那条消息上（幂等）。
                // 授权两档（作者 / 群主，2026-10-28），判定收在 `protocol::recall_receive_allowed`
                // 那一份纯函数里 —— 信封被 Ed25519 签名，`sender_id` 不可伪造，而"是不是群主"
                // 比的是**本机库里**那份 `groups.creator`，所以发帧人自报不作数、也改不动别人。
                // 接收端不校验时间窗（无法验证发送方的墙上时钟，那是产品规则不是安全边界）。
                let group_id_for_check = conv_id
                    .strip_prefix("group:")
                    .unwrap_or_default()
                    .to_string();
                if kind == crate::protocol::KIND_RECALL {
                    if let Ok(p) = serde_json::from_str::<crate::protocol::RecallPayload>(&content)
                    {
                        // DB 那半单独成一个块，**块里没有 await**：`MutexGuard` 不是 `Send`，
                        // 只要它的活期跨过任何一个 await，整条 gossip future 就不能被 tokio
                        // 搬线程（这台库里那把锁跨 await 是本仓反复付账的形状）。
                        let applied = {
                            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                            // ⚠️ **目标消息可能还没落库**（撤回事件先到）。此时不能因为
                            // "查不到作者"就把整条撤回丢掉 —— 那恰好把权威集合存在的意义
                            // （解决先撤后到）封死了：随后消息带着完整正文落库，撤回永久失效。
                            // 已落库时要把作者的**会话**一起读出来：跨会话归属闸（拿 A 群的合法
                            // 信封去清 B 群的一条消息）只有拿到目标自己的 conv_id 才判得了。
                            let target_row = db::get_message_record(&dbc, &p.target);
                            let is_group = conv_id.starts_with("group:");
                            let (is_creator_here, is_member_here) = if is_group {
                                db::get_group(&dbc, &group_id_for_check)
                                    .map(|g| {
                                        (
                                            g.creator == env.sender_id,
                                            g.members.contains(&env.sender_id),
                                        )
                                    })
                                    .unwrap_or((false, false))
                            } else {
                                (false, false)
                            };
                            let allowed = crate::protocol::recall_receive_allowed(
                                target_row.as_ref().map(|m| {
                                    (m.sender_id.as_str(), m.conv_id.as_str(), m.kind.as_str())
                                }),
                                &env.sender_id,
                                &conv_id,
                                is_group,
                                is_creator_here,
                                is_member_here,
                            );
                            if allowed {
                                db::insert_recall(
                                    &dbc,
                                    &conv_id,
                                    &p.target,
                                    &env.sender_id,
                                    env.seq,
                                )
                                .ok();
                                db::materialize_recall(&dbc, &p.target).ok();
                                // 会话列表那一行读的是 `conversations.last_msg`（存储列），
                                // 不重算就是"对端撤了、我这台预览还挂着原文"。
                                if let Err(e) = db::refresh_conversation_summary(&dbc, &conv_id) {
                                    state.logger.warn(
                                        "chat",
                                        format!("code=RECALL_PREVIEW_REFRESH_FAIL conv={conv_id}：{e}"),
                                    );
                                }
                            }
                            allowed
                        };
                        if applied {
                            let _ = state.app.emit("message-recalled", &p.target);
                            // 在途附件：本机这一侧也停掉自己那笔。通知**不再外发** ——
                            // 这条 recall 帧本来就全群广播过，每台都发 FileCancel 会变成
                            // N 份取消通知（回声），而真正的发送方自己也会走到这一格。
                            crate::commands::cancel_transfer_for_recalled_message(
                                state,
                                &p.target,
                                crate::commands::CancelNotify::LocalOnly,
                            )
                            .await;
                        }
                    }
                }
                // 渲染切换：只认原作者，且目标必须在本会话；LWW 后才广播给前端。
                if kind == crate::protocol::KIND_RENDER {
                    if let Ok(p) = crate::protocol::parse_render_payload(&content) {
                        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                        let allowed = db::get_message_record(&dbc, &p.target)
                            .map(|m| {
                                m.conv_id == conv_id
                                    && m.sender_id == env.sender_id
                                    && (m.kind == "code" || m.kind == "text")
                            })
                            .unwrap_or(false);
                        let applied = allowed
                            && db::apply_message_render(&dbc, &p.target, env.seq, &p.mode)
                                .unwrap_or(false);
                        if applied {
                            drop(dbc);
                            let _ = state.app.emit(
                                "message-render-changed",
                                &crate::state::RenderChangedInfo {
                                    msg_id: p.target,
                                    kind: p.mode,
                                },
                            );
                        }
                    }
                }
                // 群公告：**仅群主可发布/删除**。发送侧已校验（send_group_announcement），
                // 但接收侧原先没有任何检查 —— 任何持群密钥的成员构造一条
                // kind="announcement" 的群消息就能改掉所有人的公告横幅，
                // 与「公告是发给全群的权威信息」相悖，也与群名那处（同一批修的）口径不一致。
                if kind == crate::protocol::KIND_ANNOUNCEMENT
                    || kind == crate::protocol::KIND_ANNOUNCEMENT_DELETE
                {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    let is_creator = db::get_group(&dbc, &group_id_for_check)
                        .map(|g| g.creator == env.sender_id)
                        .unwrap_or(false);
                    if !is_creator {
                        state.logger.warn(
                            "group",
                            format!(
                                "丢弃非群主发布的公告：sender={} group={group_id_for_check}",
                                env.sender_id
                            ),
                        );
                        return;
                    }
                }
                // 持锁块只做落库；await（fanout 转发已在前面）之后无持锁操作
                // 业务幂等裁决：Direct（含 outbox 补发）可能已经把同一 msg_id 落库，此时
                // 不得再计未读、再发 message-received，否则未读数与系统通知都会重复。
                // 与 Direct 分支共用 announced_on 裁决，两路径并发时只有一方拿到 Ok(true)。
                // 单聊与群聊走同一块 ⇒ 两种 GossipKind 都被覆盖。
                let (out_rec, inserted) = {
                    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    // 展示时间用本地接收时间；排序用信封携带的逻辑序号 seq。
                    let ts = db::now_ms();
                    let seq = env.seq.max(1);
                    let rec = MessageRecord {
                        id: 0,
                        msg_id: env.message_id.clone(),
                        conv_id: conv_id.clone(),
                        sender_id: env.sender_id.clone(),
                        receiver_id: state.device_id.clone(),
                        kind: kind.clone(),
                        content: content.clone(),
                        ts,
                        seq,
                        status: "delivered".to_string(),
                        // #122 第二段：解出来的落点跟着这一行进库。
                        // 三态原样带过去：`None`（老对端/没带这个键）就写 NULL ⇒ 重启后仍按昵称兜底，
                        // 不许在这里替对端补成空数组（那会把"不知道"写成"谁都没 @"）。
                        mention_targets: mention_targets.clone(),
                        local_id: None,
                    };
                    // **先撤后到**：撤回事件可能早于被撤回的消息到达（Gossip 泛洪与
                    // outbox 直发是两条无顺序保证的路径）。命中权威集合就直接以
                    // 「已撤回」形态入库 —— 否则消息会带着完整正文落地，撤回失效。
                    let mut rec = rec;
                    if db::is_recalled(&dbc, &rec.msg_id) {
                        rec.kind = crate::protocol::KIND_RECALLED.to_string();
                        rec.content = String::new();
                    }
                    let inserted = db::insert_message_if_new(&dbc, &rec);
                    if announced_on(&inserted) {
                        // 时钟推进与静默**无关**，必须照常：漏掉它本机后续 seq 会落后，
                        // 之后自己发的消息会排到历史前面。
                        db::observe_clock(&dbc, &conv_id, seq).ok();
                        if crate::protocol::is_non_notifying_kind(&kind) {
                            // 静默事件（表情回应/撤回）与系统提示都不计未读、不改会话预览 ——
                            // 否则「回个表情」或「X 加入了群聊」会把会话顶到列表最前并弹通知。
                            // 但会话行必须存在，前端要靠它把事件归属到正确的会话。
                            db::ensure_conversation(&dbc, &conv_id, conv_kind, &name, None).ok();
                        } else {
                            db::touch_conversation(
                                &dbc, &conv_id, conv_kind, &name, None, &preview, 1,
                            )
                            .ok();
                        }
                    }
                    (rec, inserted)
                };
                // 落库失败必须留痕（同上第七家）：这一格行为不改 —— Err 时既不 emit 也不回 GroupAck，
                // 发送方保留 outbox 继续补发；补的是"这台为什么没收到这条"在日志里的存在感。
                if let Err(e) = &inserted {
                    state.logger.error(
                        "chat",
                        format!(
                            "Gossip 消息落库失败 msg={}：{e} —— 不产生本地副作用，群侧不回 Ack（发送方保留待发）",
                            env.message_id
                        ),
                    );
                    // 不撤销就会把发送方之后每一份补发都判成重复（同一信封同一 id）。
                    allow_message_retry(state, &env.message_id, "insert_failed");
                }
                // 重复投递与数据库失败都不产生本地副作用；Gossip 的转发已在上面完成。
                if announced_on(&inserted) {
                    let _ = state.app.emit(
                        "message-received",
                        &crate::state::IncomingMessage {
                            record: &out_rec,
                            mention_ids: mentions.as_deref(),
                            mention_targets: mention_targets.as_deref(),
                        },
                    );
                }
                // 更新会话「当前链路」：单聊消息的 hop 由 Gossip ttl 反推
                // （初始 ttl - 收到 ttl），path 取入站连接的路径（直连准确，桥接为最后一段）。
                // 仅首次落库（非重复投递）才更新，避免「走了不同路径的重复副本」干扰。
                if conv_kind == "single" && announced_on(&inserted) {
                    let hop = {
                        let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
                        gossip.ttl.saturating_sub(env.ttl)
                    };
                    let path = inbound_path_kind(state, peer_id).await;
                    update_conv_link(state, &conv_id, &path, hop);
                }
                // 群消息现在有 outbox 兜底：只要消息确实已持久化（无论本次是否新建），
                // 就回 GroupAck 让发送方删除对应 (msg_id, peer_id) 的待发记录。
                // 数据库 Err 时不回 Ack，发送方保留 outbox 继续补发。
                if conv_kind == "group" && !inserted.is_err() {
                    let ack = Message::GroupAck {
                        group_id: env.group_id.clone().unwrap_or_default(),
                        msg_id: env.message_id.clone(),
                        from: state.device_id.clone(),
                    };
                    let _ = try_send(state, &env.sender_id, &ack).await;
                }
                // 单聊送达确认：跨跳（无直连）时直连 Ack 到不了原始发送方，改走定向
                // Gossip ChatAck；有直连时也走 Gossip，让「已送达」立即出现，不必等
                // 心跳触发 outbox 直发补 Ack。接收端按 outbox(msg_id, sender) 命中才接受，
                // 防伪造送达。
                if conv_kind == "single" && !inserted.is_err() {
                    let payload = serde_json::json!({ "msg_id": env.message_id }).to_string();
                    let payload_b64 = STANDARD.encode(payload.as_bytes());
                    let mut ack_env = {
                        let gossip = state.gossip.lock().unwrap_or_else(|e| e.into_inner());
                        gossip.build_envelope(
                            &state.identity,
                            &state.device_id,
                            GossipKind::ChatAck,
                            None,
                            None,
                            &payload_b64,
                            db::now_ms(),
                            0,
                        )
                    };
                    ack_env.encrypted = false;
                    ack_env.target = Some(env.sender_id.clone());
                    ack_env.sender_sig = state.identity.sign_b64(&ack_env.signing_bytes());
                    if state.has_link(&env.sender_id).await {
                        let _ = try_send(
                            state,
                            &env.sender_id,
                            &Message::Gossip { envelope: ack_env },
                        )
                        .await;
                    } else {
                        broadcast_gossip(state, ack_env).await;
                    }
                }
            }
        }
    }
}

