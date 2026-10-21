// 职责边界：
// - transport 行为测试分册之9 —— Gossip 消费判据与传播层：非成员也转发、大块分级、传播层不依赖本地落库
// 为什么拆：`transport/tests.rs` 原来 3,227 行、7 个顶层项全挤在同一个 `mod tests` 里。
// 机制与 `file_tests.rs` / `logs_tests.rs` 同一条：`include!` 是文本粘贴 ⇒ 这些项仍属于
// `crate::network::transport::tests` 这同一个模块 ⇒ 模块路径、`use`、可见性、**测试全名一字不变**
// （恒等判据＝`cargo test --features bluetooth --lib -- --list` 的 789 条用例名差集 0 行）。
// ⚠️ 本册**不进** `network::transport_src_for_guards()` 那份"生产码全集"视图：视图掺测试字面量会把
// 按窗口取段的守卫飘到测试文本上（2026-10-06 实测 4 条假红）。`lib_tests.rs` 里那条登记对账守卫
// 按 `_tests.rs` 结尾豁免本册 —— 别为了消红把测试文本并进去（那正是假绿的形状）。
/// 这条测试只钉"能不能消费"；"非成员仍要转发"由下面那条 + `handle_gossip` 的结构保证。
#[test]
fn group_envelope_consumption_rule() {
    let members = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let group = members(&["me", "other"]);
    let me = "me";
    let other = "other";

    // 是群成员、且发送者也在成员表里 ⇒ 可以消费
    assert!(group_envelope_consumable(
        &GossipKind::Group,
        &group,
        me,
        other
    ));
    // 我不是成员 ⇒ 不消费（但**不影响转发** —— 见 group_envelope_consumable 的注释）
    assert!(!group_envelope_consumable(
        &GossipKind::Group,
        &group,
        "stranger",
        other
    ));
    // 发送者自称不在成员表里（伪造者想把群消息广播给别人）⇒ 不消费
    assert!(!group_envelope_consumable(
        &GossipKind::Group,
        &group,
        me,
        "outsider"
    ));
    // 成员表为空 = 旧端发的群信封 ⇒ 保持兼容，允许消费
    assert!(group_envelope_consumable(
        &GossipKind::Group,
        &[],
        me,
        other
    ));
    // 非群种类一律不受这条判据影响
    assert!(group_envelope_consumable(
        &GossipKind::Presence,
        &group,
        "stranger",
        other
    ));
    assert!(group_envelope_consumable(
        &GossipKind::ChatAck,
        &group,
        "stranger",
        other
    ));
}

/// 群会话键只能来自群目标；同一群换发送者，归属不变（`sender_id` 不是会话键）。
#[test]
fn inbound_conversation_group_never_uses_sender() {
    let a = inbound_conversation(&GossipKind::Group, Some("g1"), "dev-a").unwrap();
    let b = inbound_conversation(&GossipKind::Group, Some("g1"), "dev-b").unwrap();
    assert_eq!(a.conv_id, "group:g1");
    assert_eq!(b.conv_id, "group:g1");
    assert_ne!(a.conv_id, "dev-a");
    assert_ne!(b.conv_id, "dev-b");
    assert_eq!(a.kind, "group");
}

/// 缺目标/空白目标必须拒绝 —— 不许回退成 `group:`，更不许回退成单聊。
#[test]
fn inbound_conversation_rejects_missing_or_blank_group_target() {
    assert!(inbound_conversation(&GossipKind::Group, None, "dev-a").is_none());
    assert!(inbound_conversation(&GossipKind::Group, Some(""), "dev-a").is_none());
    assert!(inbound_conversation(&GossipKind::Group, Some("   "), "dev-a").is_none());
}

/// 单聊与群聊的会话键恒不相交；控制帧不产生会话归属。
#[test]
fn inbound_conversation_chat_and_group_are_disjoint() {
    let dm = inbound_conversation(&GossipKind::Chat, Some("g1"), "dev-a").unwrap();
    let group = inbound_conversation(&GossipKind::Group, Some("g1"), "dev-a").unwrap();
    assert_eq!((dm.conv_id.as_str(), dm.kind), ("dev-a", "single"));
    assert_eq!((group.conv_id.as_str(), group.kind), ("group:g1", "group"));
    assert_ne!(dm.conv_id, group.conv_id);
    assert!(inbound_conversation(&GossipKind::Presence, None, "dev-a").is_none());
    assert!(inbound_conversation(&GossipKind::ChatAck, None, "dev-a").is_none());
}

/// 真实 schema + 真实落库/历史/离线队列函数：群文本、图片、群文件卡片只进群会话，
/// 重复投递不改归属，群改元数据不生成消息，单聊完全不受影响。
#[test]
fn real_db_keeps_group_and_dm_conversations_isolated() {
    use crate::protocol::{GroupHistoryItem, GroupHistoryPage};
    use crate::state::MessageRecord;
    use rusqlite::Connection;

    fn rec(id: &str, conv: &str, kind: &str, content: &str, seq: i64) -> MessageRecord {
        MessageRecord {
            id: 0,
            msg_id: id.to_string(),
            conv_id: conv.to_string(),
            sender_id: "dev-a".to_string(),
            receiver_id: "me".to_string(),
            kind: kind.to_string(),
            content: content.to_string(),
            ts: 1000 + seq,
            seq,
            status: "delivered".to_string(),
            mention_targets: None,
        }
    }

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::db::SCHEMA).unwrap();
    crate::db::upsert_group(
        &conn,
        "g1",
        "群一",
        "dev-a",
        &["dev-a".to_string(), "me".to_string()],
    )
    .unwrap();
    crate::db::upsert_group(
        &conn,
        "g2",
        "群二",
        "dev-a",
        &["dev-a".to_string(), "me".to_string()],
    )
    .unwrap();

    for m in [
        rec("g-text", "group:g1", "text", "群文本", 1),
        rec(
            "g-img",
            "group:g1",
            "image",
            r#"{"name":"a.png","path":"/tmp/a"}"#,
            2,
        ),
        rec(
            "gfile-t1",
            "group:g1",
            "file",
            r#"{"name":"big.bin","size":100}"#,
            3,
        ),
        rec("g2-text", "group:g2", "text", "另一个群", 1),
        rec("dm-text", "dev-b", "text", "单聊", 1),
    ] {
        assert!(
            crate::db::insert_message_if_new(&conn, &m).unwrap(),
            "{}",
            m.msg_id
        );
    }

    let g1 = crate::db::get_messages(&conn, "group:g1", 100, 0).unwrap();
    let g2 = crate::db::get_messages(&conn, "group:g2", 100, 0).unwrap();
    let dm = crate::db::get_messages(&conn, "dev-b", 100, 0).unwrap();
    assert_eq!(g1.len(), 3);
    assert_eq!(g2.len(), 1);
    assert_eq!(dm.len(), 1);
    assert!(g1.iter().all(|m| m.conv_id == "group:g1"));
    assert!(dm.iter().all(|m| m.conv_id == "dev-b"));
    assert_eq!(
        crate::db::get_messages(&conn, "dev-a", 100, 0)
            .unwrap()
            .len(),
        0
    );

    // 重复投递：库内仍是 3 条，归属不变。
    assert!(!crate::db::insert_message_if_new(
        &conn,
        &rec("g-text", "group:g1", "text", "群文本", 1)
    )
    .unwrap());
    assert_eq!(crate::db::count_messages(&conn, "group:g1"), 3);
    assert_eq!(crate::db::count_messages(&conn, "dev-b"), 1);

    crate::db::touch_conversation(&conn, "group:g1", "group", "群一", None, "群文本", 1).ok();
    crate::db::touch_conversation(&conn, "group:g2", "group", "群二", None, "另一个群", 1).ok();
    crate::db::touch_conversation(&conn, "dev-b", "single", "B", None, "单聊", 1).ok();
    assert_eq!(
        crate::db::get_conversation(&conn, "group:g1")
            .unwrap()
            .unread,
        1
    );
    assert_eq!(
        crate::db::get_conversation(&conn, "group:g2")
            .unwrap()
            .unread,
        1
    );
    assert_eq!(
        crate::db::get_conversation(&conn, "dev-b").unwrap().unread,
        1
    );
    assert!(crate::db::get_conversation(&conn, "dev-a").is_none());

    // 群已读只清本群，不串单聊/别的群。
    crate::db::mark_read(&conn, "group:g1").unwrap();
    assert_eq!(
        crate::db::get_conversation(&conn, "group:g1")
            .unwrap()
            .unread,
        0
    );
    assert_eq!(
        crate::db::get_conversation(&conn, "dev-b").unwrap().unread,
        1
    );
    assert_eq!(
        crate::db::get_conversation(&conn, "group:g2")
            .unwrap()
            .unread,
        1
    );

    // 群元数据同步/改名：会话标题跟着变，但不凭空生成消息。
    crate::db::rename_group(&conn, "g1", "更名后的群").unwrap();
    assert_eq!(
        crate::db::get_conversation(&conn, "group:g1").unwrap().name,
        "更名后的群"
    );
    assert_eq!(crate::db::count_messages(&conn, "group:g1"), 3);
    assert_eq!(crate::db::count_messages(&conn, "dev-b"), 1);

    // 群历史同步写进同一个群键；重复页只计 duplicate。
    crate::db::upsert_group(
        &conn,
        "g3",
        "群三",
        "dev-a",
        &["dev-a".to_string(), "me".to_string()],
    )
    .unwrap();
    let page = GroupHistoryPage {
        items: vec![
            GroupHistoryItem {
                msg_id: "h1".into(),
                sender_id: "dev-a".into(),
                kind: "text".into(),
                content: "历史一".into(),
                ts: 2000,
                seq: 10,
                mention_targets: None,
            },
            GroupHistoryItem {
                msg_id: "h2".into(),
                sender_id: "dev-b".into(),
                kind: "image".into(),
                content: r#"{"name":"h.png"}"#.into(),
                ts: 2001,
                seq: 11,
                mention_targets: None,
            },
        ],
        files: vec![],
    };
    let first = crate::db::apply_group_history_page(&conn, "g3", "me", "群三", &page).unwrap();
    assert_eq!(first.inserted, 2);
    assert_eq!(crate::db::count_messages(&conn, "group:g3"), 2);
    assert_eq!(crate::db::count_messages(&conn, "dev-b"), 1);
    assert!(crate::db::get_messages(&conn, "group:g3", 100, 0)
        .unwrap()
        .iter()
        .all(|m| m.conv_id == "group:g3"));
    let again = crate::db::apply_group_history_page(&conn, "g3", "me", "群三", &page).unwrap();
    assert_eq!(again.inserted, 0);
    assert_eq!(again.duplicate, 2);
    assert_eq!(crate::db::count_messages(&conn, "group:g3"), 2);

    // 离线补发队列里的帧仍是 Group + 原 group_id（重放不改归属）。
    let env = crate::gossip_engine::GossipEngine::new(100, 10, 2, 4).build_envelope(
        &crate::crypto::Identity::generate(),
        "dev-a",
        GossipKind::Group,
        Some("g1".to_string()),
        Some("群一".to_string()),
        "cipher",
        1000,
        1,
    );
    let frame = Message::Gossip {
        envelope: env.clone(),
    };
    crate::db::insert_group_outbox(
        &conn,
        &env.message_id,
        "g1",
        "dev-b",
        &serde_json::to_string(&frame).unwrap(),
    )
    .unwrap();
    let rows = crate::db::list_group_outbox(&conn, "dev-b").unwrap();
    assert_eq!(rows.len(), 1);
    let Message::Gossip { envelope } = serde_json::from_str(&rows[0].1).unwrap() else {
        panic!("群队列必须是 Gossip 帧");
    };
    assert_eq!(envelope.kind, GossipKind::Group);
    assert_eq!(envelope.group_id.as_deref(), Some("g1"));
    assert_eq!(envelope.message_id, env.message_id);
}

/// **非成员中继必须转发群消息**（结构护栏）：`handle_gossip` 里那句早期 `return` 一旦
/// 被加回来，BLE-only 多跳的群聊就又断了 —— 而它**不会让任何测试失败**，
/// 只会让真机上的群聊静默不通。所以用源码断言把"只记判据、不 return"钉住。
#[test]
fn handle_gossip_does_not_bail_out_for_non_members() {
    let src = crate::network::transport_src_for_guards();
    // 锚点必须"行首 + 带左括号"：聚合文本里本测试自己那句字面量 `"async fn handle_gossip("`
    // 也算一次命中，不带行首锚点会先匹配到它，然后 body 里含下面那条 forbidden 字面量
    // —— 守卫自证其罪（分册之后主文件排在前面，这个陷阱才暴露出来）。
    let start = src
        .find("\nasync fn handle_gossip(")
        .map(|i| i + 1)
        .expect("必须还有 handle_gossip");
    let body = &src[start..];
    let end = body.find("\n}\n").unwrap_or(body.len());
    let body = &body[..end];
    assert!(
        body.contains("group_envelope_consumable("),
        "handle_gossip 必须用 group_envelope_consumable 判据"
    );
    assert!(
        !body.contains("if matches!(env.kind, GossipKind::Group) && !env.group_members.is_empty()"),
        "不能恢复『非成员直接 return』的旧写法 —— 那会让非成员中继不再转发群消息，\
             多跳（BLE-only 手机↔电脑↔手机）群聊永远不通"
    );
}

/// **结构护栏：入站会话归属只有 `inbound_conversation` 一个定义点。**
///
/// 上面那三条真值表只证明"那个函数本身判得对"。一旦有人把归属逻辑重新内联回
/// `handle_gossip`（最可能的那一种：`conv_id = env.sender_id`，即群消息按发送者
/// 归到单聊 —— 2026-10-20 修的正是这个形状），三条纯函数判据会**全绿**，
/// 而真机上群消息又开始污染个人聊天。判据与被验对象必须住在同一条路径上。
///
/// 为什么不用端到端用例：`handle_gossip` 要 `&Arc<AppState>`（tauri AppHandle +
/// 真数据库 + 网络），本仓没有这层夹具；能在这层钉住"归属从哪来"的就是源码形状。
#[test]
fn handle_gossip_takes_conversation_only_from_the_single_definition() {
    let src = crate::network::transport_src_for_guards();
    let start = src
        .find("\nasync fn handle_gossip(")
        .map(|i| i + 1)
        .expect("必须还有 handle_gossip");
    let body = &src[start..];
    let end = body.find("\n}\n").unwrap_or(body.len());
    let body = &body[..end];

    assert_eq!(
        body.matches("inbound_conversation(").count(),
        1,
        "handle_gossip 必须恰好调用一次 `inbound_conversation` —— \
             改成就地拼会话键等于开出第二个定义点，群/单聊的归属从此可以漂移"
    );
    // ⚠️ 这几条都在**原文**上搜（不 `code_flat`）：带空格的 Rust 语句一旦去空白
    // 就变成 `letconv_id=env.sender_id;`，断言会永远为真 ⇒ 判据自等。
    assert!(
        body.contains("let conv_id = target.conv_id;"),
        "会话键必须原样取自 `inbound_conversation` 的结论（`target.conv_id`）"
    );
    for forbidden in ["conv_id = env.sender_id", "conv_id: env.sender_id"] {
        assert!(
            !body.contains(forbidden),
            "handle_gossip 里又出现 `{forbidden}` —— 群信封会被写成发送者的单聊，\
                 这正是 2026-10-20 修掉的串会话根因"
        );
    }
    assert!(
        !body.contains("format!(\"group:\")"),
        "群会话键不许在 handle_gossip 里就地拼：`group:{{gid}}` 的唯一定义点在 \
             `inbound_conversation`（另有一处 `member_notices` 只用于系统提示）"
    );
}

/// 造一个只关心 payload 长度/类型的 Gossip 信封（其余字段对优先级分类无意义）。
fn test_envelope(payload_len: usize, kind: GossipKind) -> GossipEnvelope {
    GossipEnvelope {
        message_id: "m".into(),
        sender_id: "a".into(),
        nonce: "n".into(),
        sender_pubkey: "pk".into(),
        sender_ed25519: "ek".into(),
        sender_sig: "sig".into(),
        ttl: 4,
        kind,
        group_id: None,
        group_name: None,
        group_creator: None,
        group_members: vec![],
        payload: "p".repeat(payload_len),
        ts: 1,
        seq: 0,
        encrypted: false,
        target: None,
    }
}

#[test]
fn bulk_messages_are_only_large_chunks() {
    // 旧 is_bulk_message 的判据已迁移到 `dispatch::message_priority`（单一事实来源）。
    // 本测试保住的是**同一张真值表**：bulk ⇔ Low，且边界值不变。
    use crate::network::dispatch::{message_priority, MessagePriority};
    let is_bulk = |m: &Message| message_priority(m) == MessagePriority::Low;
    let chat = Message::ChatMessage {
        msg_id: "m1".into(),
        from: "a".into(),
        to: "b".into(),
        kind: "text".into(),
        content: "hi".into(),
        ts: 1,
        seq: 1,
    };
    assert!(!is_bulk(&chat));
    let file_chunk = Message::FileChunk {
        transfer_id: "t1".into(),
        seq: 0,
        data: "abc".into(),
        attempt: None,
    };
    assert!(is_bulk(&file_chunk));
    let group_file_chunk = Message::GroupFileChunk {
        transfer_id: "t1".into(),
        group_id: "g1".into(),
        sender_id: "a".into(),
        seq: 0,
        data: "abc".into(),
        attempt: None,
    };
    assert!(is_bulk(&group_file_chunk));
    // 文件终止帧必须走 bulk，避免跑到未写完的分片前面。
    let file_done = Message::FileDone {
        transfer_id: "t1".into(),
        attempt: None,
    };
    assert!(is_bulk(&file_done));
    let group_file_done = Message::GroupFileDone {
        transfer_id: "t1".into(),
        group_id: "g1".into(),
        sender_id: "a".into(),
        attempt: None,
    };
    assert!(is_bulk(&group_file_done));

    // 小头像资料帧：资料变更要立刻可见 ⇒ 仍走优先道。
    let small_user_info = Message::UserInfo {
        device_id: "a".into(),
        nickname: "A".into(),
        avatar: Some("x".repeat(CONTROL_AVATAR_MAX_BYTES)),
        device_type: "desktop".into(),
    };
    assert!(!is_bulk(&small_user_info), "恰好等于上限的头像仍应走优先道");

    // 大头像资料帧：内容大、可晚到 ⇒ 必须降级到 bulk，绝不占聊天/好友的优先道。
    let big_user_info = Message::UserInfo {
        device_id: "a".into(),
        nickname: "A".into(),
        avatar: Some("x".repeat(CONTROL_AVATAR_MAX_BYTES + 1)),
        device_type: "desktop".into(),
    };
    assert!(
        is_bulk(&big_user_info),
        "超过上限的头像资料帧必须走 bulk（否则会堵住聊天与好友请求）"
    );

    // 小载荷 Gossip 走优先道；内联大载荷（例如带大图的 Presence）降级到 bulk。
    let small_gossip = Message::Gossip {
        envelope: test_envelope(BULK_GOSSIP_PAYLOAD_MAX_BYTES, GossipKind::Presence),
    };
    assert!(!is_bulk(&small_gossip));
    let big_gossip = Message::Gossip {
        envelope: test_envelope(BULK_GOSSIP_PAYLOAD_MAX_BYTES + 1, GossipKind::Presence),
    };
    assert!(is_bulk(&big_gossip));
}

#[tokio::test]
async fn e2e_gossip_encrypt_sign_decrypt() {
    // 端到端：A 加密→签名→广播信封，B 验签→解密
    let a = crate::crypto::Identity::generate();
    let b = crate::crypto::Identity::generate();

    // A 用 B 的公钥 ECDH 派生共享密钥并加密
    let shared = crate::crypto::shared_secret(&a.x25519_secret, &b.x25519_public_b64()).unwrap();
    let plaintext = b"{\"kind\":\"text\",\"content\":\"hello\"}";
    let sealed = crate::crypto::seal(&shared, plaintext).unwrap();
    let payload_b64 = STANDARD.encode(&sealed);

    // 构造并签名信封
    let engine = GossipEngine::new(100, 10, 4, 6);
    let env = engine.build_envelope(
        &a,
        "dev-a",
        GossipKind::Chat,
        None,
        None,
        &payload_b64,
        1,
        1,
    );

    // B 验签 + 解密
    assert!(engine.verify_envelope(&env));
    let shared_b = crate::crypto::shared_secret(&b.x25519_secret, &env.sender_pubkey).unwrap();
    let decrypted = STANDARD.decode(&env.payload).unwrap();
    let opened = crate::crypto::open(&shared_b, &decrypted).unwrap();
    assert_eq!(opened, plaintext);
}

// ---------------- P0-2：直连 E2EE 解密失败不得消费真实 msg_id ----------------

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
    let neighbors = vec!["b".to_string(), "c".to_string(), "d".to_string()];
    let targets = engine.choose_fanout(&neighbors, "a");
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
        seq: 1,
        status: "delivered".into(),
        mention_targets: None,
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

/// 转发 TTL 的唯一真相是 MeshRouter：对端自报 255 时必须被压到 `max_ttl-1`。
/// 旧写法用 `env.ttl - 1` 重建信封 ⇒ 一条 Gossip 可跨 254 跳扩散（设计上限 6）。
#[test]
fn forwarded_ttl_is_clamped_by_the_mesh_router() {
    let mut router = crate::mesh::router::MeshRouter::new(100, 100, 6, 4, 16);
    let frame = MeshFrame {
        frame_id: "f-ttl".into(),
        source_node_id: "A".into(),
        destination: MeshDestination::Broadcast,
        ttl: 255,
        kind: MeshFrameKind::Gosslan,
        payload: Vec::new(),
    };
    let decision = router.on_receive(frame, "me");
    assert_eq!(
        super::forward_ttl_from(&decision),
        Some(5),
        "255 必须被压到 5（max_ttl=6 再减一），不是 254"
    );
    // 边界：env.ttl=2 还能再走一跳（转发出去 ttl=1），不许被 `decide_forward` 的
    // `ttl <= 1` 提前停掉 —— 授权判据喂的是**入站** ttl，不是递减后的值。
    let two = router.on_receive(
        MeshFrame {
            frame_id: "f-ttl-2".into(),
            source_node_id: "A".into(),
            destination: MeshDestination::Broadcast,
            ttl: 2,
            kind: MeshFrameKind::Gosslan,
            payload: Vec::new(),
        },
        "me",
    );
    assert_eq!(
        super::forward_ttl_from(&two),
        Some(1),
        "2 跳的信封必须能再走一跳"
    );
    assert_eq!(
        super::forward_ttl_from(&ForwardDecision::Deliver),
        None,
        "本机消费、不再扩散时不得再转发"
    );
}
