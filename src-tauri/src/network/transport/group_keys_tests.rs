// 职责边界：
// - transport 行为测试分册之11 —— 待发群密钥登记表 + 群成员变动后的重发与文案判据
// 为什么拆：`transport/tests.rs` 原来 3,227 行、6 个顶层项全挤在同一个 `mod tests` 里。
// 机制与 `file_tests.rs` / `logs_tests.rs` 同一条：`include!` 是文本粘贴 ⇒ 这些项仍属于
// `crate::network::transport::tests` 这同一个模块 ⇒ 模块路径、`use`、可见性、**测试全名一字不变**
// （恒等判据＝`cargo test --features bluetooth --lib -- --list` 的 789 条用例名差集 0 行）。
// ⚠️ 本册**不进** `network::transport_src_for_guards()` 那份"生产码全集"视图：视图掺测试字面量会把
// 按窗口取段的守卫飘到测试文本上（2026-10-06 实测 4 条假红）。`lib_tests.rs` 里那条登记对账守卫
// 按 `_tests.rs` 结尾豁免本册 —— 别为了消红把测试文本并进去（那正是假绿的形状）。
    /// 「该给谁重发群密钥」的判据（2026-09-24 RC2：链路抖动后 GroupKey 永不重发）。
    #[test]
    fn group_ids_containing_picks_only_actual_members() {
        let groups = vec![
            crate::state::Group {
                id: "g2".into(),
                name: "b".into(),
                creator: "me".into(),
                members: vec!["me".into(), "p1".into()],
            },
            crate::state::Group {
                id: "g1".into(),
                name: "a".into(),
                creator: "me".into(),
                members: vec!["me".into(), "p2".into()],
            },
        ];
        // 只含"成员里有他"的那几个，且**顺序稳定**（登记进 HashSet 后靠它保证重试次序可预期）
        assert_eq!(group_ids_containing(&groups, "p1"), vec!["g2".to_string()]);
        assert_eq!(group_ids_containing(&groups, "p2"), vec!["g1".to_string()]);
        // 我自己在每个群里 ⇒ 拿到全部（排序后）
        assert_eq!(
            group_ids_containing(&groups, "me"),
            vec!["g1".to_string(), "g2".to_string()]
        );
        // 陌生人 ⇒ 空，调用方据此完全不碰 pending 表
        assert!(group_ids_containing(&groups, "nobody").is_empty());
    }

    /// **好友同意回执补发策略**：窗口 + 次数 + 间隔三条边界。
    ///
    /// 真机（2026-09-13）：Android 点了「接受」、Android 侧好友已出现，但 Mac 端状态一直
    /// 没同步 —— 那一帧在 BLE 链路抖动时静默丢了且**永不重发**。修法是"有界补发"，
    /// 而"窗口 + 次数 + 间隔"这种策略最容易写反（写反的后果是要么永不补发、要么疯狂打扰
    /// 对端），所以在这里用真值表钉死。
    #[test]
    fn friend_accept_flush_is_bounded_and_spaced() {
        let now = 1_000_000_i64;
        let (max, interval, window) = (3u32, 5_000i64, 120_000i64);

        // 没有登记 ⇒ 什么都不做
        assert_eq!(
            friend_accept_flush_decision(None, now, max, interval, window),
            FriendAcceptFlush::Nothing
        );
        // 刚登记（last=0）⇒ 立刻补发第 1 次
        assert_eq!(
            friend_accept_flush_decision(Some((now, 0, 0)), now, max, interval, window),
            FriendAcceptFlush::Flush(1)
        );
        // 刚发过（距上次不足间隔）⇒ 等下一次心跳，不打扰
        assert_eq!(
            friend_accept_flush_decision(
                Some((now - 10_000, 1, now - 1_000)),
                now,
                max,
                interval,
                window
            ),
            FriendAcceptFlush::Nothing
        );
        // 距上次够了 ⇒ 继续补发（第 2 次）
        assert_eq!(
            friend_accept_flush_decision(
                Some((now - 10_000, 1, now - 5_000)),
                now,
                max,
                interval,
                window
            ),
            FriendAcceptFlush::Flush(2)
        );
        // 次数用尽 ⇒ 收尾
        assert_eq!(
            friend_accept_flush_decision(
                Some((now - 10_000, 3, now - 60_000)),
                now,
                max,
                interval,
                window
            ),
            FriendAcceptFlush::GiveUp
        );
        // 窗口用尽（哪怕一次都没发出去）⇒ 收尾，并让调用方留一条 warn
        assert_eq!(
            friend_accept_flush_decision(
                Some((now - 121_000, 1, now - 60_000)),
                now,
                max,
                interval,
                window
            ),
            FriendAcceptFlush::GiveUp
        );
    }

    // ---- 好友申请到达：通知只按"第一次握着这条申请"决定 ----
    //
    // 真机（2026-10-14 用户反馈）：正常聊天时「群内加好友」会**连续弹出很多条**通知。
    // 根因不在网络层重复投递本身 —— 申请没有回执，发送方每次建链和每轮心跳都会补发一份
    // **新 message_id** 的信封（那是保住「离线补发」承诺所必需的）—— 根因在接收端把
    // `pending_requests.insert(..)` 的返回值丢掉了：结构上看不见"这条我已经握着了"，
    // 于是每份补发都算一次新申请、各弹一条通知。帧 id 判不住重复，所以幂等只能判在这里。
    #[test]
    fn friend_request_arrival_notifies_only_the_first_time() {
        // 第一次握着这条申请 ⇒ 该通知
        assert_eq!(
            friend_request_arrival_decision(true),
            FriendRequestArrival::Notify
        );
        // 已经握着（补发到达）⇒ 只做静默刷新，不通知（只换一个输入的反向对照）
        assert_eq!(
            friend_request_arrival_decision(false),
            FriendRequestArrival::SilentRefresh
        );
    }

    /// **待发好友申请的补发必须有间隔，不能每轮心跳发一次**（与上一条通知门控是同一个
    /// 真机缺陷的两半：接收端不再刷屏，发送端也不该每 5 秒向整个群洪泛一份新 `message_id`）。
    ///
    /// 与 `friend_accept_flush_is_bounded_and_spaced` 的关键差别：**没有次数上限、没有放弃窗口**。
    /// 同意回执是"我这边的动作已做完"，补 3 次足够；而申请是**等对方做人**，对方可能几天后才看到，
    /// 所以这里只受"最小间隔"约束 —— 收成有上限就等于偷偷废掉「离线补发」那条承诺（INV-P04）。
    #[test]
    fn pending_friend_request_reflush_is_spaced_not_per_heartbeat() {
        let now = 1_000_000_i64;
        let min_interval = 30_000_i64;
        // 没有登记 ⇒ 什么都不做
        assert_eq!(
            friend_request_flush_decision(None, now, min_interval),
            FriendRequestFlush::Nothing
        );
        // 刚登记、一次都没补发过（last=0）⇒ 立刻补发（建链补发就是这条登记的本职）
        assert_eq!(
            friend_request_flush_decision(Some((now - 1_000, 0)), now, min_interval),
            FriendRequestFlush::Flush
        );
        // 距上次补发只过了一轮心跳（5s）⇒ 不发。这一格就是「连续多条弹窗」的流量来源。
        assert_eq!(
            friend_request_flush_decision(Some((now - 60_000, now - 5_000)), now, min_interval),
            FriendRequestFlush::Nothing
        );
        // 间隔够了 ⇒ 继续补发
        assert_eq!(
            friend_request_flush_decision(Some((now - 60_000, now - 30_000)), now, min_interval),
            FriendRequestFlush::Flush
        );
        // 一天前登记的，仍然补发（不设放弃窗口 —— 与 accept 那条必须不同）
        assert_eq!(
            friend_request_flush_decision(
                Some((now - 86_400_000, now - 31_000)),
                now,
                min_interval
            ),
            FriendRequestFlush::Flush
        );
    }

    // ---- 群成员变更：接收端的分支选择 ----
    //
    // 真实事故（2026-09-12 用户反馈）：群主移人后，**其余成员**的成员表不变小、
    // 也没有任何提示。根因是接收端 `handle_group_member_removed` 开头就
    // `if to != 本机 { return }` —— 压根没有「别人被移出」这个分支。
    // 下面把三分支的选择（纯函数）用真值表钉住。

    #[test]
    fn member_removed_action_full_truth_table() {
        use MemberRemovedAction::*;
        // 发起方不是创建者 → 一律忽略（防成员互踢），与 `to` 是谁无关
        assert_eq!(member_removed_action(false, false, false), Ignore);
        assert_eq!(member_removed_action(false, false, true), Ignore);
        // 本机自己发起的 → 忽略（本地已处理，含群主自己的系统消息）
        assert_eq!(member_removed_action(true, true, false), Ignore);
        assert_eq!(member_removed_action(true, true, true), Ignore);
        assert_eq!(member_removed_action(true, false, false), Ignore);
        assert_eq!(member_removed_action(true, false, true), Ignore);
        // 创建者发起 + 被移出者是别人 → **同步成员表**（本次补齐的分支，
        // 这条断言正是对「其余成员不能 Ignore」的回归钉子）
        assert_eq!(member_removed_action(false, true, false), RemoveOther);
        // 创建者发起 + 被移出者是我 → 清理本地群
        assert_eq!(member_removed_action(false, true, true), RemoveSelf);
    }

    // ---- 拨号决策（M2 双向建链 + P1-2 镜像重复连接修正）----

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
        assert_eq!(
            pending_group_key_ids(&pending, "peer-c"),
            vec!["g-1".to_string()]
        );
    }

    /// 链路仍未就绪（NoLink）或非可重试原因（Fatal）的判定：
    /// NoLink 必须保留登记项等待下一次 flush；Fatal / Ok 必须清除。
    #[test]
    fn flush_failure_retains_or_clears_pending_correctly() {
        // 仍无链路 → 保留
        assert!(should_retain_pending_group_key(&Err(
            GroupKeySendErr::NoLink
        )));
        // 非可重试 → 清除
        assert!(!should_retain_pending_group_key(&Err(
            GroupKeySendErr::Fatal
        )));
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
        assert_eq!(
            pending_group_key_ids(&pending, "peer-b"),
            vec!["g-1".to_string()]
        );

        // 下一轮 flush：Fatal 分支必须清除（重试无意义：缺公钥 / 非成员 / 无密钥）
        clear_pending_group_key(&mut pending, "peer-b", "g-1");
        let result: Result<(), GroupKeySendErr> = Err(GroupKeySendErr::Fatal);
        if !should_retain_pending_group_key(&result) {
            clear_pending_group_key(&mut pending, "peer-b", "g-1");
        }
        assert!(pending_group_key_ids(&pending, "peer-b").is_empty());
    }

    // ---------- 群成员公钥解析（peers 优先、friends 回落） ----------

    // ---------- 显示名判据（与前端 utils/memberName.ts 同一顺序、同一兜底） ----------
    //
    // ⚠️ 别把这一族和上面那条「公钥 peers 优先」混为一谈：公钥要的是**最新那一份**，
    // 名字要的是**我起的那一个**（用户 2026-10-14：「名字同步，有时候还会显示设备名，会变」）。
    // 两个方向相反，合成一个口径会一边对一边错。
    //
    // 旧实现返回 `device_id` 原文，而群系统消息是**落库**的 ⇒ 一串 `gosslan-xxxx` 永久留在时间线里。
    #[test]
    fn display_name_prefers_local_alias_over_self_report() {
        // 「会变」那一半：对方改自报昵称，不该盖掉我给他起的备注。
        let zh = |alias: Option<&str>, peer: Option<&str>| {
            pick_member_display_name("gosslan-abcdef12", "me", "", alias, peer, None, true)
        };
        assert_eq!(zh(Some("阿强"), Some("Q")), "阿强");
        // 只换这一个输入：备注缺席时才轮到对方自报（反向对照，防止把优先级写反）。
        assert_eq!(zh(None, Some("Q")), "Q");
        assert_eq!(zh(Some(""), Some("Q")), "Q");
    }

    #[test]
    fn display_name_never_returns_raw_device_id() {
        // 三格来源全查不到 ⇒ 只能是「未知成员 + 后四位」，不许出现整串 id。
        let id = "gosslan-abcdef12";
        let zh = pick_member_display_name(id, "me", "", None, None, None, true);
        assert_eq!(zh, "未知成员 ef12");
        assert!(!zh.contains(id), "兜底不许带上完整设备标识: {zh}");
        assert_eq!(
            pick_member_display_name(id, "me", "", None, None, None, false),
            "Unknown member ef12"
        );
    }

    #[test]
    fn display_name_treats_blank_source_as_absent() {
        // 空格昵称不该把兜底吃掉（旧代码 `is_empty()` 只挡空串，且请求名那一支完全不判空
        // ⇒「」加入了群聊）。三格全空白必须落到「未知成员」。
        let r = pick_member_display_name(
            "gosslan-abcdef12",
            "me",
            "",
            Some("   "),
            Some("\t"),
            Some(" "),
            true,
        );
        assert_eq!(r, "未知成员 ef12");
        // 反证：只把备注换成真名字，就必须用备注（证明上面那格不是恒落兜底）。
        assert_eq!(
            pick_member_display_name("gosslan-abcdef12", "me", "", Some("阿强"), Some("\t"), None, true),
            "阿强"
        );
    }

    #[test]
    fn display_name_self_branch_and_empty_id() {
        assert_eq!(
            pick_member_display_name("me", "me", "我本人", Some("x"), Some("y"), None, true),
            "我本人"
        );
        // 昵称还没写进内存（极早期）：中英两份兜底，与 `self_display_name` 同口径。
        assert_eq!(pick_member_display_name("me", "me", "  ", None, None, None, true), "我");
        assert_eq!(pick_member_display_name("me", "me", "", None, None, None, false), "Me");
        // 空 id = "没有这个人"，返回空串（调用方靠这一点区分，前端 resolveMemberName 同一格）。
        assert_eq!(pick_member_display_name("", "me", "", None, None, None, true), "");
    }

    #[test]
    fn member_id_tail_shape_and_oversize_id() {
        assert_eq!(member_id_tail("abcdef"), "cdef");
        // 不足位数原样（不许把 "ab" 截成别的形状）。
        assert_eq!(member_id_tail("ab"), "ab");
        assert_eq!(member_id_tail("abcd"), "abcd");
        // 按码点数而不是按字节切：非 ASCII 输入不许 panic，也不许落在码点中间
        // （这一支的全部意义是"任何输入都弄不坏界面"；字节切片会在多字节处直接崩）。
        assert_eq!(member_id_tail("张三李四王"), "三李四王");
        assert_eq!(member_id_tail(""), "");
    }
