// 职责边界：
// - transport 行为测试分册之2 —— peers 表在线判定 + 成员 X25519 公钥解析与好友接受时的补绑
// 为什么拆：`transport/tests.rs` 原来 3,227 行、5 个顶层项全挤在同一个 `mod tests` 里。
// 机制与 `file_tests.rs` / `logs_tests.rs` 同一条：`include!` 是文本粘贴 ⇒ 这些项仍属于
// `crate::network::transport::tests` 这同一个模块 ⇒ 模块路径、`use`、可见性、**测试全名一字不变**
// （恒等判据＝`cargo test --features bluetooth --lib -- --list` 的 789 条用例名差集 0 行）。
// ⚠️ 本册**不进** `network::transport_src_for_guards()` 那份"生产码全集"视图：视图掺测试字面量会把
// 按窗口取段的守卫飘到测试文本上（2026-10-06 实测 4 条假红）。`lib_tests.rs` 里那条登记对账守卫
// 按 `_tests.rs` 结尾豁免本册 —— 别为了消红把测试文本并进去（那正是假绿的形状）。
    /// 「这个 peer 到底离线了没有」的真值表（#162）。
    ///
    /// 旧写法是 `removed && empty`，而**半开看门狗**会先把整条 key 摘掉
    /// （`transport.rs` 的看门狗那段：`if v.is_empty() { links.remove(&peer); }`），
    /// 于是读循环收尾时 `removed=false`、`empty=true` ⇒ 判成"没离线"：
    /// 徽标继续显示在线、在途的接收要等 5 分钟空闲超时才失败、也不打掉线日志。
    /// 正确的定义只有一件事可判：**这个 peer 一条链路都不剩了没有**。
    #[test]
    fn peer_offline_after_tail_truth_table() {
        // 我摘掉了它最后一条链路 ⇒ 离线
        assert!(super::peer_offline_after_tail(true, true));
        // 别人（半开看门狗）先摘了 key，我这边只是没摘到东西 ⇒ 仍然是离线（本轮修的就是这一格）
        assert!(
            super::peer_offline_after_tail(false, true),
            "链路已空却不点亮离线 ⇒ 徽标停在在线、在途接收卡在 5 分钟超时"
        );
        // 还剩别的链路（LAN + Tailscale + BLE 并存）⇒ 不许判离线，那是 failover
        assert!(!super::peer_offline_after_tail(true, false));
        assert!(!super::peer_offline_after_tail(false, false));
    }

    /// 那条判据只许有一个家：读循环收尾必须调用它，不许再内联一份 `removed && empty`。
    #[test]
    fn peer_offline_rule_has_one_home() {
        let src = crate::network::transport_src_for_guards();
        assert!(
            src.contains("peer_offline_after_tail(removed, empty)"),
            "读循环收尾不再调用那个判据 ⇒ 真值表与现场分家"
        );
        assert!(
            !src.contains("let offline = removed && empty;"),
            "transport.rs 里又出现内联的第二份判据"
        );
    }
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

    /// 成为好友那一刻：**加密钥匙照绑，身份锚点只认被证明过的来源**（#32 这一片的核心判据）。
    ///
    /// 为什么值得单独钉：`friends.ed25519_pubkey` 此后既是 Hello 的验签锚点（INV-P21）、
    /// 安全码的输入，又是**公网中继电路的准入判据**（`list_bound_friend_identities` 只看它
    /// 非空），而 `update_friend_pubkeys` 只填空、首写者永久胜出 —— 一次伪造的 UDP announce
    /// 抢先写进来就是永久的。反过来留 NULL 不是死路，见下面第三段。
    #[test]
    fn accept_binds_encryption_key_but_defers_unverified_anchor() {
        let (x, e) = acceptable_friend_keys(false, Some("xk-b".into()), Some("ek-evil".into()));
        assert_eq!(
            x.as_deref(),
            Some("xk-b"),
            "加密钥匙必须照旧早绑，否则首次加密发送失败（那三条路径原本各写一遍的理由）"
        );
        assert_eq!(
            e, None,
            "未 verified 的来源不得成为身份锚点：写进去就再也改不掉"
        );

        let (x2, e2) = acceptable_friend_keys(true, Some("xk-b".into()), Some("ek-b".into()));
        assert_eq!(
            (x2, e2),
            (Some("xk-b".into()), Some("ek-b".into())),
            "验签通过的来源两列都照绑"
        );

        // 留 NULL 的自愈路径：这一轮只绑到加密钥匙，下一轮一次 verified 的写入补上锚点，
        // 且不许把先绑上的 x25519 换掉（两列各自 COALESCE，互不牵连）。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::add_friend(&conn, "b", "Bob", None).unwrap();
        db::update_friend_pubkeys(&conn, "b", Some("xk-b"), None).ok();
        assert!(
            db::get_friend_ed25519(&conn, "b").is_none(),
            "未 verified 的这一轮就该没有锚点"
        );
        db::update_friend_pubkeys(&conn, "b", Some("xk-other"), Some("ek-b")).ok();
        assert_eq!(db::get_friend_ed25519(&conn, "b").as_deref(), Some("ek-b"));
        assert_eq!(
            db::get_friend_x25519(&conn, "b").as_deref(),
            Some("xk-b"),
            "先绑上的加密钥匙不许被后来的值改掉（fill-only 是最后一道闸）"
        );
    }

    // ---------------- P0：TCP 监听端口生命周期（生产 1.0 重启掉线） ----------------

    /// peers 表的淘汰选谁（2026-10-29 审计 SEC-02）：`last_seen` 最旧的那个。
    ///
    /// 这条钉的是"表被广播刷爆时让谁让位" —— 选错（例如按 device_id 最小）会把刚见过的
    /// 活跃节点挤掉，而最久没露面的那条反而常驻。边界：空表返回 None（不许 panic）。
    #[test]
    fn peer_eviction_picks_the_stalest_entry() {
        use crate::network::transport::peer_to_evict;
        let mk = |id: &str, last_seen: i64| crate::state::Peer {
            device_id: id.to_string(),
            nickname: String::new(),
            avatar: None,
            device_type: String::new(),
            ip: String::new(),
            tcp_port: 0,
            last_seen,
            rtt_ms: None,
            x25519_pubkey: None,
            ed25519_pubkey: None,
            keys_verified: false,
            first_seen: None,
            link: None,
        };
        let none = std::collections::HashSet::new();
        let mut peers = std::collections::HashMap::new();
        assert_eq!(peer_to_evict(&peers, &none), None, "空表不许 panic");

        peers.insert("fresh".into(), mk("fresh", 900));
        peers.insert("stale".into(), mk("stale", 100));
        peers.insert("mid".into(), mk("mid", 500));
        assert_eq!(peer_to_evict(&peers, &none).as_deref(), Some("stale"), "淘汰最久没露面的那条");

        // 最旧的那条是好友/群成员 ⇒ 让位给次旧的**陌生**节点，而不是把受保护的身份挤掉。
        // （2026-10-29 发版前 review §4.0h：这张表同时是公钥读取源，非好友群成员没有回落。）
        let mut protected = std::collections::HashSet::new();
        protected.insert("stale".to_string());
        assert_eq!(
            peer_to_evict(&peers, &protected).as_deref(),
            Some("mid"),
            "受保护的条目必须跳过，即使它是全场最旧的"
        );

        // 全都受保护 ⇒ None：调用方据此**放弃新条目**，而不是随便挑一个人淘汰。
        for id in ["fresh", "mid"] {
            protected.insert(id.to_string());
        }
        assert_eq!(
            peer_to_evict(&peers, &protected),
            None,
            "没有可淘汰的对象时必须返回 None（宁可少记一个陌生节点）"
        );
    }

    /// 对端样式表的准入（2026-10-29 审计 SEC-04）：已知 peer 永远可更新，新 peer 满员即拒。
    /// 边界两侧各一格 —— 把 `||` 写成 `&&` 或把 `<` 写成 `<=` 这里当场红。
    #[test]
    fn peer_style_admission_truth_table() {
        // `handle_messaging.rs` 是 `include!` 进来的 ⇒ 它的项就落在 `transport` 模块里。
        use crate::network::transport::peer_style_admitted;
        assert!(peer_style_admitted(true, 0));
        assert!(peer_style_admitted(true, 9999), "已知 peer 满员也要能更新（样式是会变的）");
        assert!(peer_style_admitted(false, 0));
        assert!(!peer_style_admitted(false, 256), "满员时陌生 peer 不登记");
    }

    // ---------------- Block 1：跨跳好友的身份锚点（Case A / Case B） ----------------
    //
    // 现场（RC-1）：只有验签通过的直连 Hello 才写 `friends.ed25519_pubkey`，
    // 纯中继好友从来没有 Hello ⇒ 该列永远 NULL ⇒ 信任门把 Chat/ChatAck 全静默丢掉，
    // 双向都断、120s 后变 `OUTBOX_EXPIRED`。下面三条钉住修复的边界。

    /// Case B 的真值表：**唯一**的补锚判据。
    ///
    /// 反例（写成"只要验签通过就绑"）：攻击者用某个好友的 `device_id` 自签一条 Chat
    /// ⇒ 验签通过 ⇒ 锚点被永久钉成他的钥匙（`update_friend_pubkeys` 只填空、
    /// 首写者永久胜出）。所以只有「已有 x25519 且与信封一致」这一格允许补。
    #[test]
    fn friend_anchor_binding_truth_table() {
        use super::{friend_anchor_binding_decision, FriendAnchorBinding as B};
        let x = |v: &str| Some(v.to_string());
        let e = |v: &str| Some(v.to_string());

        assert_eq!(
            friend_anchor_binding_decision(None, "xk"),
            B::NotApplicable,
            "不是好友：轮不到这套机制（走既有信任门）"
        );
        assert_eq!(
            friend_anchor_binding_decision(Some(&(x("xk-a"), e("ek-a"))), "xk-a"),
            B::NotApplicable,
            "已经绑过 ed25519 ⇒ fill-only，绝不覆盖（哪怕值一致也不再写一次）"
        );
        assert_eq!(
            friend_anchor_binding_decision(Some(&(x("xk-a"), None)), "xk-a"),
            B::BindToExistingX25519,
            "历史 NULL 行 + x25519 锚点一致 ⇒ 允许补"
        );
        assert_eq!(
            friend_anchor_binding_decision(Some(&(x("xk-a"), None)), "xk-evil"),
            B::X25519Mismatch,
            "信封自报 x25519 与已绑定值不一致 ⇒ 拒绝（这一格正是防冒充的闸）"
        );
        assert_eq!(
            friend_anchor_binding_decision(Some(&(None, None)), "xk-any"),
            B::Unanchored,
            "两把钥匙都 NULL ⇒ 没有任何既有锚点可比对，纯 TOFU 等于允许冒充 ⇒ 拒绝"
        );
    }

    /// Case A 的真值表：跨跳 `FriendAccept` 能不能当身份锚点的证明。
    ///
    /// 关键一格是「本机没发过申请」/「id 对不上」⇒ 一律 false。
    /// 验签只证明持有该 ed25519 私钥，不证明 sender_id 身份；绑定点必须是本机那条申请。
    #[test]
    fn accept_proof_requires_local_request_and_anchor_agreement() {
        use super::accept_proves_friend_anchor;
        assert!(accept_proves_friend_anchor(77, Some(77), None, "xk-b"));
        assert!(
            accept_proves_friend_anchor(77, Some(77), Some("xk-b"), "xk-b"),
            "已有 x25519 且一致 ⇒ 仍可绑（补 ed25519 那一格）"
        );
        assert!(
            !accept_proves_friend_anchor(77, Some(77), Some("xk-b"), "xk-evil"),
            "已有 x25519 与信封不一致 ⇒ 拒绝"
        );
        assert!(
            !accept_proves_friend_anchor(0, Some(77), None, "xk-b"),
            "老端回执是 `{{}}`（id=0）⇒ 无法关联，退回 Case B"
        );
        assert!(
            !accept_proves_friend_anchor(77, None, None, "xk-b"),
            "本机没发过申请 ⇒ 不能拿它当绑定点（这正是 SEC-01 的形状）"
        );
        assert!(
            !accept_proves_friend_anchor(78, Some(77), None, "xk-b"),
            "id 对不上 ⇒ 不是对我那次申请的答复"
        );
    }

    /// 补锚写入必须**只填 ed25519**，且首写者永久胜出（fill-only 是最后一道闸）。
    ///
    /// 这条同时钉住 `update_friend_pubkeys` 的 COALESCE 语义：Case B 传 x25519=None，
    /// 即便之后又有人在别的路径传了另一个 x25519，先前那个也不会被换掉。
    #[test]
    fn anchor_backfill_writes_only_ed25519_and_keeps_first_x25519() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::add_friend(&conn, "b", "Bob", None).unwrap();
        db::update_friend_pubkeys(&conn, "b", Some("xk-b"), None).ok();
        assert!(db::get_friend_ed25519(&conn, "b").is_none(), "复现修复前：锚点为 NULL");

        // Case B 的写入形状：x25519=None（绝不覆盖），ed25519=信封自报值
        db::update_friend_pubkeys(&conn, "b", None, Some("ek-b")).ok();
        assert_eq!(db::get_friend_ed25519(&conn, "b").as_deref(), Some("ek-b"));
        assert_eq!(
            db::get_friend_x25519(&conn, "b").as_deref(),
            Some("xk-b"),
            "补锚不许把已绑的加密钥匙改掉"
        );

        // 第二次（或别的路径）写入不得覆盖已绑定的身份锚点
        db::update_friend_pubkeys(&conn, "b", Some("xk-other"), Some("ek-evil")).ok();
        assert_eq!(
            db::get_friend_ed25519(&conn, "b").as_deref(),
            Some("ek-b"),
            "身份锚点首写者永久胜出（否则一次伪造回执就能永久把锚点换成攻击者的钥匙）"
        );
        assert_eq!(db::get_friend_x25519(&conn, "b").as_deref(), Some("xk-b"));
    }

    /// 源码守卫：Case B 必须真的挂在信任门里、且写入形状是 fill-only、且必留码。
    ///
    /// 为什么用源码断言：这三件事（调用点、`None` 那一列、日志码）任一漂移，
    /// 上面的纯函数测试仍然全绿，而现场会退回"永远绑不上"或"绑上了但没人知道"。
    #[test]
    fn gossip_anchor_home_is_named_fill_only_and_coded() {
        let src = crate::network::transport_src_for_guards();
        let flat: String = src.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            src.contains("friend_anchor_binding_decision("),
            "handle_gossip 不再调用那个唯一判据 ⇒ 真值表与现场分家"
        );
        assert!(
            flat.contains("update_friend_pubkeys(&dbc,&env.sender_id,None,Some(&env.sender_ed25519)"),
            "Case B 的写入必须是 fill-only（x25519 传 None、只填 ed25519）"
        );
        assert!(
            src.contains("code=FRIEND_ANCHOR_BOUND"),
            "绑定成功必须留可聚合的日志码（否则现场无从判断'到底绑没绑'）"
        );
        assert!(
            src.contains("code=FRIEND_ANCHOR_UNANCHORED"),
            "无锚点拒绝也必须留码（不许静默丢弃）"
        );
        assert!(
            src.contains("friend_anchor_unanchored_notice"),
            "无锚点场景必须给出可见系统提示（'未送达（身份未验证）'）"
        );
    }

    /// Case A 的回执必须**回显本机申请 id**，否则新朋友仍会卡在 Case B 之前。
    ///
    /// 三个点各钉一下：发送端载荷带 `request_id`、接受时取入站申请的 id、
    /// 补发那一路从 DB 行取同一个 id（否则首帧能绑、补发不能，两边结论不一致）。
    #[test]
    fn friend_accept_echoes_the_request_id_on_both_first_and_retry() {
        let picker = include_str!("../../commands/mobile_picker.rs");
        assert!(
            picker.contains(r#"|r| r.request_id"#),
            "accept_friend_request 必须从 pending_requests 取入站申请的 id"
        );
        assert!(
            picker.contains(r#"{"request_id": request_id}"#)
                || picker.contains(r#"json!({ "request_id": request_id })"#),
            "同意回执的载荷必须回显 request_id（老端 `{{}}` 收到 0 就退回 Case B）"
        );

        let src = crate::network::transport_src_for_guards();
        assert!(
            src.contains("let rid = row.request_id;"),
            "flush_pending_friend_accept 补发时必须沿用同一个 request_id"
        );
        assert!(
            src.contains("proven_by_matched_request("),
            "匹配成功必须交出一份'证明快照'，而不是直接把信封公钥当已验证"
        );
    }

    /// Block 4：入站信任门的每条"静默丢弃"都必须留下 `code=`。
    ///
    /// 反例自证：把 `GOSSIP_TRUST_REJECT` 那行删掉（恢复成裸 `return`），这条会红；
    /// 而纯函数与业务测试全绿 —— 这正是"今天这次排查最大障碍"的形状。
    #[test]
    fn every_trust_gate_rejection_leaves_a_code() {
        let src = crate::network::transport_src_for_guards();
        for code in [
            "code=GOSSIP_TRUST_REJECT",
            "code=GOSSIP_SIGNATURE_INVALID",
            "code=GOSSIP_MESH_DROP",
            "code=GOSSIP_DUPLICATE",
            "code=GOSSIP_UNEXPECTED_ENCRYPTED",
        ] {
            assert!(src.contains(code), "入站路径缺了 {code} —— 又会变回静默丢弃");
        }
        // 拒绝行必须带分诊维度：否则拿到包只能知道"被拒"，不知道"为什么被拒"。
        assert!(
            src.contains("anchor={anchor}"),
            "GOSSIP_TRUST_REJECT 必须带 anchor=（none/friend_bound/peer_verified/self）"
        );
    }
