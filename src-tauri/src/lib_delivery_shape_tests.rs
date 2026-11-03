// 职责边界：
// - `lib_tests.rs` 测试分册之11 —— 投递形状：未知帧容忍、离线仍列出、群密钥先于群消息、发送成功后才落身份
// 为什么拆：`src-tauri/src/lib_tests.rs` 原来 4,009 行、96 个顶层项挤在同一个 `mod tests` 里。
// 机制与 `network/transport/tests.rs` 那一刀同一条：`include!` 是文本粘贴 ⇒ 这些项仍属于
// `crate::lib_tests` 里那同一个 `mod tests` ⇒ 模块路径、`use`、可见性、**测试全名一字不变**
// （恒等判据＝`cargo test --features bluetooth --lib -- --list` 的 789 条用例名差集 0 行）。
// ⚠️ **本册必须与 `lib_tests.rs` 同级平铺**（不许挪进 `lib_tests/` 子目录）：册里到处是
// `include_str!("commands.rs")`、`include_str!("../gen/android/…")` 这类**相对本文件**的路径，
// 换目录会让它们整体偏移一位 —— 编译器会拒（不会静默），但那就不再是"逐字未变"的搬家，
// 恒等判据当场降级成"我读过觉得没变"。同目录先例：`protocol_tests.rs`。
// ⚠️ 册名以 `_tests.rs` 结尾也是被判据选定的：`transport_src_for_guards()` 那份"生产码全集"视图
// 只许装生产码，而登记对账守卫按 `_tests.rs` 后缀豁免测试分册（并进视图是最顺手却假绿的消红办法）。
    /// **INV-P24 第 1 条：未知帧类型必须降级，不得成为连接错误**（ADR-0007 落地①）。
    ///
    /// 为什么只能钉源码：这条的行为是"什么都没发生"—— 没有测试会因为**缺少**它而失败，
    /// 而它的缺失后果极重：新版本上线任何一种新帧，老设备不是少收一条消息，
    /// 而是**跟新设备连不上**（反序列化失败 → io::Error → reader 退出 → 重连再失败）。
    /// 同时**握手首帧不许降级**：未认证的连接没有"看不懂就放过"的理由。
    #[test]
    fn unknown_wire_frame_is_tolerated_after_auth() {
        let out = code_flat(include_str!("network/transport/outbound.rs"));
        assert!(
            out.contains("Err(e)ife.to_string().starts_with(\"unknownvariant\")"),
            "未知变体必须由 serde 自己的措辞识别（不维护第二份类型清单，清单会漂移）"
        );
        assert!(
            out.contains("Ok(Message::Unknown{wire_type:tag})"),
            "未知 type 必须降级成 Message::Unknown"
        );
        assert!(
            out.contains("fnread_frame") && out.contains("decode_frame(&buf)"),
            "数据面 read_frame 必须走 decode_frame，否则降级形同不存在"
        );
        let preauth = rust_fn_body(
            include_str!("network/transport/outbound.rs"),
            "async fn read_frame_preauth",
        );
        assert!(
            !preauth.contains("decode_frame"),
            "握手首帧不得降级：非 Hello / 看不懂的帧在认证前就该拒掉"
        );
        let agg = code_flat(&crate::network::transport_src_for_guards());
        assert!(
            agg.contains("Message::Unknown{wire_type}=>{"),
            "handle_message 必须有 Unknown 分支（忽略 + 节流日志），否则会退化成 panic 或误判"
        );
    }

    /// **老端收到撤回好友申请帧的实际行为**：丢弃这一帧，不断链、不重投。
    ///
    /// 这是上面那条源码判据的**行为证据**：用一帧"已知 type=gossip、嵌套 kind 不认识"
    /// 的原始字节跑真正的 `decode_frame`。老端的 `GossipKind` 就是缺这个变体，
    /// 解析会报 `unknown variant ...` ⇒ 被降级成 `Message::Unknown`，而不是 `Err`。
    #[test]
    fn an_old_client_drops_an_unknown_gossip_kind_instead_of_breaking_the_link() {
        let raw = br#"{"type":"gossip","envelope":{
            "message_id":"m1","sender_id":"peer-a","nonce":"n1",
            "sender_pubkey":"x25519-a","sender_ed25519":"ed-a","sender_sig":"sig",
            "ttl":3,"kind":"future_friend_kind",
            "payload":"","ts":1,"encrypted":false
        }}"#;
        let decoded = crate::network::transport::decode_frame(raw);
        match decoded {
            Ok(crate::protocol::Message::Unknown { wire_type }) => {
                assert_eq!(wire_type, "gossip", "外层 type 认得出，内层变体认不出");
            }
            Ok(other) => panic!("老端不该解析出已知变体：{other:?}"),
            Err(e) => panic!("老端收到未知 kind 不许变成连接错误（会拆链）：{e}"),
        }
    }

    /// **掉线的节点要留在发现列表里，但不能算"在线"**（两个坑必须同时躲开）。
    ///
    /// 2026-09-12 真机（用户 4.2.11，只开蓝牙）：**手机能看到 Mac（"已发现未建联"），
    /// Mac 里安卓什么都不显示**。根因是链路一断就把节点条目删了 —— BLE 上
    /// "连上 → 被对端按指定拨号方退让 → 断开"是常态，Mac 刚学到身份就被删，
    /// 「添加好友」列表里只闪一下，用户根本点不到。
    ///
    /// 反过来，如果只是"保留条目"而沿用旧的「在 peers 表里就算在线」判据，
    /// 就会把复核抓到过的那个 High 缺陷重新引入（一次"连过又掉线"的节点永久在线）。
    /// 所以两件事必须一起成立：**条目保留**（`mark_peer_offline` 不删 peer）+
    /// **在线看 last_seen 新鲜度**（`friend_is_online`）。
    #[test]
    fn offline_peer_stays_listed_but_is_not_online() {
        let transport = crate::network::transport_src_for_guards();
        let body = rust_fn_body(&transport, "pub(crate) async fn mark_peer_offline(");
        assert!(
            !body.contains("remove(device_id)"),
            "链路断了**不能**立刻删节点条目：BLE 上「连上→退让→断开」是常态，\
             删掉的话「添加好友」列表里对端只闪一下（真机症状）"
        );
        assert!(
            body.contains("clear_conv_link"),
            "链路快照必须立刻清掉 —— 否则聊天头部会一直显示「桥接 N」（用户实测过）"
        );

        let commands = all_commands_src();
        assert!(
            commands.contains("fn friend_is_online("),
            "在线判据必须是独立纯函数（可单测、可护栏）"
        );
        assert!(
            commands
                .contains("friend_is_online(last_seen, now, active_links.contains(&f.device_id))"),
            "get_friends 必须走 friend_is_online：**只看「在不在节点表里」会让刚掉线的节点\
             保持在线的假象**（就是那个 High 缺陷）"
        );
        assert!(
            !commands.contains("f.online = peers.contains_key(&f.device_id)"),
            "旧的 presence 判据不得复活（条目现在会被保留，presence 不再等价于在线）"
        );
    }

    /// **在途文件不能被当成"已被清理"**（用户 2026-09-14：群里收图时好时坏，点几次/
    /// 等一会儿/重发才出来）。
    ///
    /// 接收方在 FileDone 之前写的是 <transfer_id>.part，final 路径尚不存在。若
    /// resolve_media_path 直接报 Gone，前端会把"正在接收"的图片标成「已被清理」并缓存。
    #[test]
    fn in_flight_media_is_not_reported_as_deleted() {
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "fn resolve_media_path(");
        assert!(
            body.contains("file_receivers")
                && body.contains("group_file_receivers")
                && body.contains("仍在接收"),
            "缺失的 final 文件必须先在途判定（file_receivers / group_file_receivers），在途报 Unknown 而不是 Gone"
        );
    }

    /// **链路徽标与在线状态必须"实时"**（用户 2026-09-14：两边全在局域网，却显示「已桥接」，
    /// 且好友在线状态不实时）。
    ///
    /// 两个必须同时成立的判据：
    /// 1. get_conv_link 有直连时按**此刻实际选路**返回 hop=0，不再回放"上一条消息"的快照；
    /// 2. peers-updated 要带上每个节点的活跃链路（link 字段），前端才能把"有链路但广播没收到"
    ///    的节点也算在线（与后端 friend_is_online 同口径）。
    #[test]
    fn link_badge_and_presence_are_live() {
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "pub async fn get_conv_link(");
        assert!(
            body.contains("has_link") && body.contains("hop: 0"),
            "有直连时 get_conv_link 必须以实时链路 + hop=0 返回，不能回放消息快照"
        );
        let state = include_str!("state.rs");
        assert!(
            state.contains("p.link = best_link_kind(&kinds)"),
            "peers-updated 必须带上活跃链路（link 字段），否则前端判不出「有链路但广播缺席」的在线"
        );
    }

    /// 任务的两条写命令必须**只在发送成功之后**打一行带 `task=` 的日志（第二阶段 §29）。
    ///
    /// 为什么以前是零：现算过，`src-tauri/src/commands` 里 29 处 `logger.` 调用**无一与任务有关**，
    /// 全仓日志密度都堆在网络层（ble 51 / transport 47 / file 13）⇒ "任务没同步过去"只能靠比对
    /// 两侧的库来定位死在哪一段。判据取**顺序 + 内容 + 不泄漏**三件，不是"那串字面量在不在"：
    /// - 日志早于 `send_group_payload(` ⇒ 会记出一条其实没建成的任务（与"emit 必须由写库成功门控"同族）；
    /// - 少任一行的标记 ⇒ 任务链退回零可观测；
    /// - 格式串里出现 `{title}` 或 `description` ⇒ 用户内容进日志（同"token 值不得入日志"那一族约束）。
    #[test]
    fn todo_commands_log_identity_only_after_the_send_succeeded() {
        let commands = all_commands_src();
        for (head, marker) in [
            ("pub async fn send_group_todo(", "群任务已建 task="),
            ("pub async fn update_group_todo(", "群任务已改 task="),
        ] {
            let body = rust_fn_body(commands, head);
            let send = body.find("send_group_payload(").unwrap_or_else(|| {
                panic!("{head} 里找不到 send_group_payload ⇒ 形状变了，这条判据要跟着改")
            });
            let log = body.find(marker).unwrap_or_else(|| {
                panic!("{head} 没有打「{marker}」⇒ 任务生命周期又回到零日志（§29）")
            });
            assert!(
                send < log,
                "{head} 的日志早于发送：会记出一条其实没成功的任务"
            );
            let logged = &body[log..(log + 400).min(body.len())];
            // ⚠️ 这里查的是**真实泄漏形状**而不是字面量 `{title}`：非空转实测过，
            // 只查 `{title}` 时"把 payload.title 用 {} 铺进日志"这种坏法完全抓不到（退码仍 0），
            // 那条 clause 等于装饰。故三种写法都堵：字段访问 `.title`、行内捕获 `{title}`、描述字段。
            assert!(
                !logged.contains(".title")
                    && !logged.contains("{title}")
                    && !logged.contains("description"),
                "{head} 的任务日志把用户内容（标题/描述）铺进了日志行"
            );
        }
        // 内核自 emit 之后必须留一行痕迹：双实例 harness 没有任何入口让应用自己执行动作，
        // 所以「A 为什么看得见自己发的那条」只能靠这一行来判（否则永远是循环论证）。
        // 判据仍取顺序：痕迹早于 emit 就成了"还没通知就先记账"，与上面那条同族。
        let kernel = rust_fn_body(commands, "async fn send_group_payload(");
        let emit = kernel
            .find(r#"emit("message-received""#)
            .expect("群发送内核没有回送本机窗口 ⇒ #82 那格修复被移走了");
        let klog = kernel
            .find("群消息已回送本机窗口 msg=")
            .expect("群发送内核回送后没留痕 ⇒ harness 无法判「本端确实被通知」（§29）");
        assert!(
            emit < klog,
            "自 emit 的痕迹早于 emit 本身：会记出一条其实没通知出去的消息"
        );
    }

    /// 群密钥必须**先于**群消息补发，且每次建链 / Hello / 心跳都重新登记（2026-09-24 RC2）。
    ///
    /// 三个触发点顺序错任何一处，表现都一样：`handle_gossip` 在解密之前就把 msg_id 登进
    /// 去重表 ⇒ 密钥后到时那条群消息已经被"见过"挡掉，之后 group_outbox 重发多少次都
    /// 没有消费者（而且行还会在窗口到期时被删掉）。这条只能钉接线 —— 判据本身没有纯函数，
    /// 是三步调用的先后。
    #[test]
    fn group_keys_always_precede_group_messages() {
        let flat = code_flat(&crate::network::transport_src_for_guards());
        // 只数**调用**（`state,&xxx)` 这种实参形状）：函数定义那行 `state: &AppState` 也含同样的前缀，
        // 按前缀数会多数一次 ⇒ 判据必须是"调用点"的完整形状。
        let calls = flat
            .matches("requeue_group_keys_for_peer(state,&peer_id);")
            .count()
            + flat
                .matches("requeue_group_keys_for_peer(state,&device_id);")
                .count();
        assert_eq!(
            calls, 3,
            "三处触发点（拨号建链 / Hello / 心跳）都要先重新登记密钥；少一处 = 那条路径上\\
             链路抖动丢过的 GroupKey 永远不会再发（GroupKey 没有回执帧）"
        );
        // 每一处 flush_group_outbox 之前必须已经有 flush_pending_group_keys（同一串里）
        let mut seen_ok = 0;
        for (i, _) in flat.match_indices("flush_group_outbox(state,") {
            // 按字节回退窗口会切进多字节字符里直接 panic ⇒ 必须先吸附到字符边界
            let raw = i.saturating_sub(220);
            let start = (raw..i).find(|&k| flat.is_char_boundary(k)).unwrap_or(i);
            let window = &flat[start..i];
            if window.contains("flush_pending_group_keys(state,") {
                seen_ok += 1;
            }
        }
        assert_eq!(
            seen_ok,
            flat.matches("flush_group_outbox(state,").count(),
            "有一处群消息补发排在群密钥之前 ⇒ 密钥没到的那条消息会被去重表永久挡掉"
        );
    }

    /// attempt epoch 的**接线**（2026-09-23 真机 600MB 根治，用户拍板选 B）。
    ///
    /// 判据本身有单测（`frame_is_current`、协议双向兼容），这里钉的是接线是否四处都在：
    /// ① 三帧都带上轮次；② 轮次来自持久化的 outbox.attempts 且必须门控；
    /// ③ 接收侧分片与完成帧都过判据；④ Offer 那两条接受路径都设定轮次。
    /// 为什么用源码守卫：要跑通"上一轮分片还压在链路队列里、新一轮已经开始"需要双链路夹具
    /// 加真实背压，本仓没有这种夹具；而接错任何一处的表现都是真机上那份大文件又死了。
    #[test]
    fn file_attempt_epoch_is_wired_on_both_sides() {
        // 视图读"一个家"`network::file_src_for_guards()`（2026-10-07 file.rs 按角色切成 include! 分册）：
            // 读单个文件只会看见主册 ⇒ 形状守卫对分册失明（假绿形状）。登记对账由 lib_source_view_tests 第四个用例钉两侧。
                    let file = &crate::network::file_src_for_guards();
        let tv = crate::network::transport_src_for_guards();
        // ① 三帧都必须带轮次（少一处 = 那一类帧逃过过滤，病根原样保留）
        let stream = code_flat(&rust_fn_body(file, "async fn stream_file("));
        assert!(
            stream.contains(
                "Message::FileChunk{transfer_id:transfer_id.to_string(),seq,data,attempt,}"
            ),
            "FileChunk 必须带 attempt"
        );
        assert!(
            stream.contains("Message::FileDone{transfer_id:transfer_id.to_string(),attempt,}"),
            "FileDone 必须带 attempt —— 陈旧完成帧会把这一轮刚开头的传输判成\"未完成\"并打死"
        );
        assert!(
            code_flat(&rust_fn_body(file, "pub async fn send_file_from_path_at("))
                .contains("from_bytes:resume_from,attempt,}"),
            "FileOffer 必须带 attempt（它是接收端设定当前轮次的唯一来源）"
        );
        // ② 轮次必须门控，且必须来自**持久化**的 attempts
        let gate = code_flat(&rust_fn_body(file, "fn send_attempt("));
        assert!(
            gate.contains("CONTENT_FEATURE_FILE_EPOCH==0{returnNone;}"),
            "不门控就等于对老端发新语义（违反 ADR-0007 / INV-P24：新帧新语义必须先按能力位门控）"
        );
        assert!(
            gate.contains("get_file_outbox_attempts("),
            "轮次必须取持久化的 outbox.attempts：进程内计数器重启后回到 1，会比接收端已存的轮次还小 ⇒              这份文件的每一轮都被自己判成陈旧（永久饿死）"
        );
        assert!(
            !gate.contains("static") && !gate.contains("AtomicU32"),
            "同上：绝不允许改用进程内计数器当轮次"
        );
        // ③ 接收侧两处过滤
        assert!(
            code_flat(&rust_fn_body(file, "pub fn write_chunk("))
                .contains("!frame_is_current(attempt,r.attempt)"),
            "write_chunk 必须先挡非当前轮次的分片，且必须排在 chunk_seq_decision 之前"
        );
        assert!(
            tv.contains("file::done_is_current(state, &transfer_id, attempt)"),
            "FileDone 必须在 finish_receive 摘走接收器之前判轮次（摘完就分不清\"陈旧\"与\"重复\")"
        );
        // ④ Offer 的两条接受路径都要设定轮次：漏一条 = 那条路径上接收器停在第 0 轮，
        //    于是**所有**新轮分片都被当陈旧丢掉 ⇒ 文件永远差一截且不报错。
        assert_eq!(
            tv.matches("file::note_offer_attempt(state, &transfer_id, attempt)")
                .count(),
            2,
            "幂等 accept 与新建/续建接收器两条路径各一次，少一次就是半边没接"
        );
    }

    /// 「和自己聊天」必须是**纯本地**路径（用户 2026-09-16 的功能）。
    ///
    /// 为什么必须守：自聊一旦走成网络路径，会同时破坏两条不变量 ——
    /// ① 自己的消息进 outbox 后**永远等不到 Ack**（没有对端），那一行会被每次心跳/建链的
    ///    `flush_outbox` 重发，"outbox 必然排空"直接失效；
    /// ② `target = 自己` 的 gossip 信封对本机（`handle_gossip` 里 `sender == 自己` 早退）
    ///    和别人（解不开）都是噪声。
    /// 这两条在界面上**都看不出来**（消息照样显示、列表照样刷新），只有库里悄悄长出一条
    /// 永不消失的 outbox 行 —— 属于只能靠护栏拦的那类退化。
    #[test]
    fn self_chat_stays_local() {
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "fn insert_self_message(");
        assert!(
            !body.is_empty(),
            "找不到 insert_self_message（这条护栏会变成空转）"
        );
        // 先查"不该有的"：注入成 `insert_message_and_outbox(` 时下面那条 contains 也会失败，
        // 但真正该说的是"你接回了网络路径"——所以把这条放在前面报。
        for forbidden in [
            "insert_message_and_outbox(",
            "broadcast_gossip(",
            "try_send(",
            "crypto::seal(",
            "seal_symmetric(",
        ] {
            assert!(
                !body.contains(forbidden),
                "自聊消息里不得出现 `{forbidden}`：消息不出本机、也不该进 outbox（详见该函数文档）"
            );
        }
        assert!(
            body.contains("db::insert_message("),
            "自聊消息必须只落本地库（`db::insert_message`）"
        );
    }

    /// gossip / 不透明帧的转发候选必须来自**可达链路集**（2026-09-19 审计 P0#7）。
    ///
    /// 为什么必须守：`peers` 是知识集（Presence/announce 跨跳登记，异网段节点在里面
    /// 却没有链路）。历史版本 `choose_fanout` 的三个调用点都拿 `peers.keys()` 当候选，
    /// 跨网段时扇出全部拨向不可达节点、又被 `let _ =` 静默吞掉 —— 「节点互相帮转发」
    /// 在最需要它的场景无声失效。界面上**看不出任何异常**（本地收发一切正常），
    /// 只有跨网段压测才暴露，正是只能靠护栏钉死的那类退化。
    #[test]
    fn gossip_fanout_targets_reachable_links() {
        let transport = crate::network::transport_src_for_guards();
        assert!(
            !transport.contains("choose_fanout(&peers"),
            "转发候选不得再来自 peers（知识集）—— 用 reachable_neighbors（links 中有非空链路的邻居）"
        );
        // 定义 1 处 + 调用 3 处（gossip 广播分支 / 定向洪泛兜底 / OpaqueExternal）
        let uses = transport.matches("reachable_neighbors(").count();
        // 收成 ==：`>= 4` 只拦"少了一处"，拦不住"计数被测试文本垫上去"——视图里含内联测试段，
        // 一处生产调用点被删掉时，测试里那句同名字符串可以把计数补回 4（今天现算就是 4/4 全在生产侧）。
        assert_eq!(
            uses, 4,
            "reachable_neighbors 应为「定义 1 处 + 3 个转发调用点」，实际 {uses} 处\n\
             （多了=有新转发点没走可达集；少了=有转发点退回旧写法或被测试文本垫数）"
        );
    }

    /// 群发送内核必须**在写库成功之后、且不持 DB 锁**时把这条消息回送给本机窗口（#82）。
    ///
    /// 为什么要这条：群任务看板跑在独立窗口里、有自己的 store 实例，所以 `createTodo`
    /// 的乐观插入只落在任务窗那份 `messages` 上，主聊天窗完全不知情 ⇒ 用户自己发的任务
    /// 在自己的时间线上看不见（重进会话才看见）。同类的群发送（群文件/公告
    /// `commands/group_announcements.rs`）早就在写库后自 emit，缺的正是内核这一句。
    ///
    /// 判据刻意取**顺序 + 作用域**，不是"有没有那串字面量"：
    /// - emit 早于 `tx.commit()` ⇒ 会 emit 一条没落库的消息（本仓不变量明令禁止）；
    /// - emit 落在 `s.db.lock()` 的作用域里 ⇒ 持锁 emit（同样是既有不变量）。
    ///
    /// 这两条任一被破坏，下面的相对位置断言都会红。
    #[test]
    fn group_send_kernel_emits_to_own_windows_after_commit_outside_the_lock() {
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "fn send_group_payload(");
        let lock = body
            .find("s.db.lock()")
            .expect("群发送内核应当有一段持锁写库，找不到 `s.db.lock()` 说明形状变了");
        let commit = body
            .find("tx.commit()")
            .expect("落库与入队必须在同一个事务里（`tx.commit()`）");
        assert!(lock < commit, "持锁段必须包住 commit，否则写入不是原子的");
        let emit = body
            .find(r#"emit("message-received""#)
            .expect("群发送内核没有把这条消息回送给本机窗口：别的窗口（群任务看板）自己发的东西，\
                     主聊天窗收不到 ⇒ 用户看不见自己刚发的任务卡片。\n\
                     对照 `commands/group_announcements.rs` 的同形写法：写库成功后 `let _ = s.app.emit(\"message-received\", &rec);`");
        assert!(
            commit < emit,
            "emit 必须晚于 commit：先通知再落库，前端会渲染出一条其实没存的记录"
        );
        assert!(
            body[commit..emit].contains("\n    }"),
            "emit 不能落在 `s.db.lock()` 的作用域内（持锁 emit 是既有不变量）—— 它必须在锁作用域闭合之后"
        );
    }

    /// #22（负责人 2026-10-10 拍板要的两半）：**群主改名的新群名已经到离线成员机器上了，
    /// 必须落到那一行已存在的会话；而这条同步永远不许凭空造出一行会话。**
    ///
    /// 为什么钉源码而不是只写 db 层测试：`db/groups.rs` 那三条正/反例判的是
    /// `rename_group` 这个函数自己**会不会**做对，而 #22 的缺陷恰好是"**没人调它**"——
    /// 群关系同步那条路（`handle_group_key`）当时只写 `groups`，会话标题留在旧名。
    /// 表现是两个用户都直接看得见的地方名字不一样，而任何一条"函数自身正确"的测试都发现不了。
    /// 同 `group_keys_always_precede_group_messages` 的理由：**这条判据本身是接线，不是纯函数**。
    ///
    /// 两半都要，缺一半就回到某个已知缺陷：
    /// · 少了 `db::rename_group` ⇒ #22 复发（离线成员上线仍是旧标题）；
    /// · 冒出 `ensure_conversation` ⇒ 用户清库重装后，仅凭群关系同步群聊就自己冒回聊天列表
    ///   （那条不变量原先**只有一句注释**守着，这一格把它提成了判据）。
    #[test]
    fn group_relation_sync_updates_existing_conversation_title_but_never_creates_one() {
        let body = code_flat(&rust_fn_body(
            include_str!("network/transport.rs"),
            "async fn handle_group_key",
        ));
        assert!(
            body.contains("db::rename_group(&dbc,&group_id,&display_name)"),
            "群关系同步里没有把当前群名落到会话行 ⇒ 离线成员上线后聊天列表仍是旧群名（#22）。\
             要修的是调用点，不许在别处再写一份 UPDATE conversations 的 SQL（那会长出第二个家）。"
        );
        assert!(
            !body.contains("ensure_conversation("),
            "群关系同步里出现了 ensure_conversation ⇒ 清库重装后群聊会凭空回到聊天列表\
             （关系同步 ≠ 聊天同步；conversation 只能由聊天活动驱动）。"
        );
    }

    /// 离线成员回来后发的第一条消息，不许排到当天更早的消息**前面**（负责人 2026-10-26 实报：
    /// 群聊时间分割线读作 15:34 → 12:13 → 12:57，那个人 5 天没上线且只从老版本升级来）。
    ///
    /// 机理：每会话逻辑时钟只在本机**观察到**的序号上前进（`observe_clock` 取 MAX），而排序权威是
    /// `seq`、显示时间是本地接收时间（ADR-0012 §2/§3）。成员离线 5 天 ⇒ 他的时钟停在离线前；
    /// 回来后第一条消息的 `seq` 低于群里当天已有的那些 ⇒ 在**所有对端**界面上落到当天更早的消息
    /// 前面，而它显示的时间是最新的。ADR-0012 §7 写的补救是"靠 `GroupKey.clock` 对齐"，而
    /// `Message::GroupKey` 每一帧确实都带 `clock`（`pending_keys::try_send_group_key`），建链/Hello
    /// 时**每个成员**都会重发一遍（`requeue_group_keys_for_peer`）—— 旧接收侧在"发送方不是群主"
    /// 那一支直接 return，这一格时钟从来没被消费掉。
    ///
    /// 为什么只能钉接线（同上一条 `group_relation_sync_…` 的理由）：`observe_clock` 自己的单调 MAX
    /// 早有 db 层单测，那条判的是**函数**；这里的缺陷形态是"函数都在、这一支里没有调用点"，
    /// 任何"函数自身正确"的测试都发现不了。
    #[test]
    fn group_key_from_non_creator_still_advances_the_conversation_clock() {
        let src =
            rust_fn_body(include_str!("network/transport.rs"), "async fn handle_group_key");
        // 整行注释先摘掉再压平：`code_flat` 不剥注释，而这一支的注释里正好写着 `observe_clock`
        // 这类词 —— 留着它们，"没有调用点"也能被注释喂成假绿（提取器会读判据自己的注释）。
        let code = src
            .lines()
            .map(str::trim_start)
            .filter(|l| !l.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let body = code_flat(&code);
        let at = body
            .find("ifgroup.creator!=from{")
            .expect("群主早退那一支没了 ⇒ 先确认是不是把整道闸拆了（那是密钥注入的防线，不许拆）");
        // 只取这一支到 `return;` 为止：早退之后是群主专属路径，算不得"非群主也会推进时钟"的证据。
        let branch = &body[at..];
        let end = branch.find("return;").unwrap_or(branch.len());
        let branch = &branch[..end];
        assert!(
            branch.contains(r#"db::observe_clock(&dbc,&format!("group:{group_id}"),clock)"#),
            "非群主发来的 GroupKey 携带的会话时钟没有被观察 ⇒ 离线成员回来后第一条消息会排到\
             当天更早的消息前面（2026-10-26 用户截图那一格）。这是 ADR-0012 §7 承诺的对齐通道。"
        );
        assert!(
            branch.contains("group.members.iter().any(|m|m==&from)"),
            "观察时钟也要先确认发送方在本机记录的成员表里：否则任何好友都能给任意 group_id 推时钟。"
        );
        // ★ 反向那一半：这一支**只**观察时钟。把群资料/密钥的写放宽给普通成员才是这条真正的
        //   危险面（恶意成员用他自己持有的密钥替换受害者的群密钥 ⇒ 读到受害者之后的群消息）。
        for forbidden in ["db::upsert_group(", "db::replace_group_members(", "state.group_keys"] {
            assert!(
                !branch.contains(forbidden),
                "非群主那一支里出现了 `{forbidden}` ⇒ 把群主专属的群资料/密钥写放宽给了普通成员，\
                 正是上方注释点名不能放宽的那条（密钥注入）。"
            );
        }
    }

    /// 强提醒第 2 阶段①：群 remind 帧**必须搭群消息内核**（⇒ 离线恢复），
    /// 且受众在出帧前按现读成员校验过 —— 空受众 / 目标消息不存在的帧不许出。
    ///
    /// 为什么这条只能钉接线：离线恢复没有任何"缺了就红"的纯函数测试 ——
    /// `send_group_payload` 内核把「messages 落库 + 每成员 group_outbox 行」放在
    /// 同一事务里，建链/Hello/心跳时 `flush_group_outbox` 补发、收到 GroupAck 删行。
    /// `send_group_remind` 只要绕过内核（比如自己 broadcast_gossip），
    /// 离线成员就永远收不到且没有任何测试会红。受众那两半同理：
    /// `partition_remind_actors` 的劈分自身有单测（protocol_tests），
    /// 但"出帧前调它 / good 为空必须拒"是这里独有的接线判据。
    #[test]
    fn group_remind_rides_delivery_kernel_with_validated_audience() {
        // 群 remind 复用已注册的 send_group_message（kind 臂），不新增命令：
        // 与 1:1 send_message 同形，也过「注册命令必须有门面调用」那条零容忍门禁。
        let cmds = all_commands_src();
        let body = code_flat(&rust_fn_body(cmds, "pub async fn send_group_message("));
        let partition = body
            .find("crate::protocol::partition_remind_actors(&p.actors,&known)")
            .expect("出帧前必须按现读成员快照劈分受众（已离群者不许进 actors）");
        let kernel = body
            .find("send_group_payload(s,&group_id,\"remind\",content,None")
            .expect(
                "群 remind 必须走 send_group_payload：那是离线恢复的唯一来源\
                 （同事务写 group_outbox，GroupAck 才删行）；绕过它 = 离线成员永远收不到",
            );
        assert!(
            partition < kernel,
            "受众劈分必须在出帧之前：先入队再校验会给已离群的人留下投递行"
        );
        assert!(
            body.contains("ifgood.is_empty()"),
            "没有有效受众时必须拒发，不许静默出一条没人该提醒的帧"
        );
        assert!(
            body.contains("db::get_message_record(&dbc,&p.target)")
                && body.contains("m.conv_id==format!(\"group:{group_id}\")"),
            "被提醒的原消息必须是本群时间线上真实存在的一行（防凭空/跨群提醒）"
        );
        assert!(
            body.contains("group.members.iter().any(|m|m==&s.device_id)"),
            "发送者必须仍在群中：成员身份在出帧前现读校验"
        );
    }

    /// 强提醒第 2 阶段②：用户层证据（`remind_ack`）与传输层证据（`GroupAck`）
    /// 必须严格分层。
    ///
    /// 传输层 GroupAck 臂（handle_group.rs）只删 group_outbox 行、emit
    /// group-message-acked —— 它不允许出现任何 remind 语义；用户「我知道了」
    /// 只能由 send_group_message 的 remind_ack 臂出 kind="remind_ack" 帧承载，
    /// 且该帧必须先过 parse（stage 白名单）、现读成员身份、target 确实是
    /// 本群一行 kind=="remind" 的记录。少任何一格都是"把传输成功当用户确认"
    /// （需求明写的禁令 / S3·S4 的分界）。
    #[test]
    fn group_remind_ack_is_user_layer_separate_from_transport_group_ack() {
        let cmds = all_commands_src();
        let body = code_flat(&rust_fn_body(cmds, "pub async fn send_group_message("));
        // stage 校验由 parse_remind_ack_payload 承载（alerted/confirmed 白名单，
        // 纯函数侧有单测）；接线层必须真的调它。
        let ack_parse = body
            .find("crate::protocol::parse_remind_ack_payload(&content)")
            .expect(
                "remind_ack 出帧前必须 parse：stage 只允许 alerted（接收端已触发提醒处理）\
                 / confirmed（用户点了我知道了）",
            );
        assert!(
            body.contains("if!group.members.iter().any(|m|m==&s.device_id)"),
            "出回执前必须现读成员身份：已离群者不能确认（R6）"
        );
        assert!(
            body.contains("m.conv_id==format!(\"group:{group_id}\")&&m.kind==\"remind\""),
            "回执必须指向本群一行真实的 remind 帧，防止凭空确认"
        );
        let kernel = body
            .find("send_group_payload(s,&group_id,\"remind_ack\",content,None")
            .expect("remind_ack 也必须走群内核（可靠投递 + 离线补发）");
        // 校验必须在出帧之前
        assert!(ack_parse < kernel, "必须先验回执再出帧");

        // 传输层 GroupAck 臂：只清 outbox（现在与状态推进同事务），不碰 remind 状态。
        let group = code_flat(include_str!("network/transport/handle_group.rs"));
        assert!(
            group.contains("Message::GroupAck{group_id,msg_id,from,}")
                && group.contains("db::ack_group_delivered(&dbc,&msg_id,&from)")
                && group.contains("\"group-message-acked\""),
            "GroupAck 臂的既有形状（事务收尾 + emit acked）找不到了"
        );
        assert!(
            !group.contains("remind"),
            "传输层 GroupAck 臂出现 remind 语义 ⇒ 把传输成功当作用户确认（S2 与 S4 被合并）"
        );
    }

    /// 强提醒第 2 阶段③：受众必须跟着群成员变化走（R6）。
    ///
    /// 现读的三处家，缺一处 R6 就开着：
    /// 1. 别人被移 / 主动退群：本地先 `delete_group_outbox_for_peer_in_group`
    ///    再 `remove_group_member` ⇒ 提醒**发出前**就排队的待补发行不会继续投给离群者；
    /// 2. 我本人被移出：删 group + 删 gk ⇒ 迟到的旧帧解不开（内核取不到 key），
    ///    出回执也会被"群不存在"挡下；
    /// 3. 回执出口的成员现读（见上一条）。
    #[test]
    fn remind_audience_follows_group_membership_removal() {
        let transport = code_flat(&crate::network::transport_src_for_guards());
        // 移人：先删该 peer 的待发群消息，再改成员表。
        let outbox_del = transport
            .find("db::delete_group_outbox_for_peer_in_group(&dbc,&group_id,&to)")
            .expect("移人处理必须清掉指向离群者的待补发 group_outbox（含在途的 remind 帧）");
        let member_del = transport
            .find("db::remove_group_member(&dbc,&group_id,&to)")
            .expect("成员表删除点");
        assert!(
            outbox_del < member_del,
            "必须先删 outbox 再改成员表，否则竞态里那一帧仍会被投出去"
        );
        // 主动退群：同一条规则。
        assert!(
            transport.contains("db::delete_group_outbox_for_peer_in_group(&dbc,&group_id,&from)")
                && transport.contains("db::remove_group_member(&dbc,&group_id,&from)"),
            "退群路径也必须停投待补发消息"
        );
        // 我本人被移出：群与群密钥都要清 —— 迟到帧不可解密 ⇒ 不会被提醒也不能确认。
        assert!(
            transport.contains("db::delete_group(&dbc,&group_id)")
                && transport.contains("DELETEFROMsettingsWHEREkey=?1"),
            "自我移除必须同时删 group 行与 gk 设置（缺密钥，迟到的 remind 帧才打不开）"
        );
    }

    /// 强提醒第 3 阶段④：**1:1** 发送侧也要做目标真实性校验（与群内核同一条例）。
    ///
    /// 群路径在 `group_files.rs` 已校验；1:1 `send_message` 只 parse 不验真就会放行
    /// 指向"幽灵消息"的 remind —— 对方收到通知、点开定位不到。这条钉住发送侧：
    /// remind 的 target 必须是本会话真实一行；remind_ack 的 target 必须是真实 remind 行。
    #[test]
    fn direct_remind_validates_target_message_exists() {
        let cmds = all_commands_src();
        // 先 code_flat 压掉所有空白：cargo fmt 会把 match 臂 / 链式调用拆行，
        // 直接在原文上搜 `"remind"=>{` 这类无空格锚点必然假失败（本册既有条例）。
        let body = code_flat(&rust_fn_body(cmds, "pub async fn send_message("));
        assert!(
            body.contains("\"remind\"=>{")
                && body.contains("parse_remind_payload(&content)")
                && body.contains("db::get_message_record(&dbc,&p.target)")
                && body.contains("m.conv_id==friend_id"),
            "1:1 remind 出帧前必须现读消息表，确认 target 真实存在于本会话"
        );
        assert!(
            body.contains("\"remind_ack\"=>{")
                && body.contains("m.conv_id==friend_id&&m.kind==\"remind\""),
            "1:1 remind_ack 的 target 必须是本会话一行真实 remind（防止凭空确认）"
        );
        assert!(
            body.contains("\"要提醒的消息不存在\"")
                && body.contains("\"对应的强提醒不存在\""),
            "校验失败必须明确拒发（不能让幽灵提醒发出去）"
        );
    }

    /// 群消息的 `GroupAck` 臂必须**把 `messages.status` 一起推进**（INV-006/P15：状态的唯一真相源在库里）。
    ///
    /// 现场是用户 2026-10-12 那份库（只读现算，一个字节没写）：
    /// `group_outbox` 与 `outbox` 都是 **0 行**，而 **16 条群消息**（9 text、5 todo_update、
    /// 1 todo、1 reaction）的 `messages.status` 永远停在 `sent`；同一时段对端自己的已读标记
    /// `group_reads.last_read_ts` 落在这批消息**之后**（12:36:19.873 vs 最后一条 12:36:19）。
    /// ⇒ 队列行不是被清扫器删的（`finalize_expired_message` 判失败会同时把 status 写成 `failed`），
    ///   而是被 **GroupAck** 删的 ⇒ **对面真收到了**，缺的只是本机这一侧的终态写入。
    /// 后果：那条"已送达"只活在内存里（前端 `onMessageAcked` advance 一次），一重启就退回单勾
    /// ⇒ 用户读成"手机端收不到"。1:1 那一臂早就写 `db::set_message_status(..., "delivered")`，
    /// 群这一臂漏了同一次写 —— 下面那句阳性对照钉的就是"两臂口径必须一致"，
    /// 它同时保证本判据不会在"两边都没有"的世界里假绿。
    #[test]
    fn group_ack_advances_sender_message_status_like_dm_ack_does() {
        let dm = code_flat(include_str!("network/transport/handle_messaging.rs"));
        let group = code_flat(include_str!("network/transport/handle_group.rs"));
        // 2026-10-20：1:1 那边把"置 delivered + 删队列行"收进了同一个事务出口
        // `db::ack_delivered`（删行失败必须回滚状态）。判据跟着挪到新出口，
        // 并单独钉住那个出口**确实**写 delivered —— 不是放宽，是把对照指向更强的证据。
        assert!(
            dm.contains("db::ack_delivered(&dbc,&msg_id,peer_id)"),
            "1:1 Ack 臂必须走 `db::ack_delivered` 事务收尾（旧的两条独立写 + 吞错已删除）"
        );
        // SQL 字面量里的空格有意义，这里看**原文**而不是 `code_flat`（后者会把
        // `DELETE FROM outbox` 压成 `DELETEFROMoutbox`）。
        let ack_body = rust_fn_body(include_str!("db/messages.rs"), "pub fn ack_delivered(");
        assert!(
            ack_body.contains("SET status = 'delivered'") && ack_body.contains("DELETE FROM outbox"),
            "1:1 Ack 的事务出口必须真的把状态写成 delivered 并删 outbox 行"
        );
        assert!(
            group.contains("db::ack_group_delivered(&dbc,&msg_id,&from)"),
            "GroupAck 臂只删队列 + emit 前端事件 ⇒ 送达事实不落库（INV-006 被破），\
             重启后那批群消息永远显示未送达（真机 16 行 stuck at sent 就是这个形状）。\
             现在口径与 1:1 一致：走同一个事务出口 `db::ack_group_delivered`"
        );
        let group_ack_body =
            rust_fn_body(include_str!("db/group_offline_queue.rs"), "pub fn ack_group_delivered(");
        assert!(
            group_ack_body.contains("UPDATE group_outbox SET status = 'delivered'")
                && group_ack_body.contains("NOT IN ('cancelled', 'partial_cancelled', 'failed')"),
            "群 Ack 必须以**台账**为准（2026-10-25）：行条件置 delivered（删行就再也回答不了\
             「谁没收到」，取消与补发都失去依据），且已取消/已判失败的消息必须保留墓碑"
        );
    }

    /// R-10：`reader_loop` **之前**那次「回发 Hello」必须是**有界**的。
    ///
    /// 那一发发生在读循环起来之前，而 `high_tx.send(..).await` 本身没有期限：
    /// 控制队列满（writer 被 bulk 压住）或对端接受连接后不再读 ⇒ 整条连接永远到不了
    /// 读循环。界面上的表现不是"卡住"，而是**链路在表里、一个入站帧都没有**，
    /// 于是发送侧看到的是"消息投进队列就成功"、接收侧什么都没收到。
    ///
    /// 修法是把这一发包进与拨号侧同一个 `HANDSHAKE_TIMEOUT`；超时只丢这一次身份补发
    /// （对端的 identity 由下一次 Hello / announce 补），链路照常进读循环。
    #[test]
    fn hello_reply_before_reader_loop_is_bounded() {
        let flat = code_flat(&crate::network::transport_src_for_guards());
        assert!(
            flat.contains("build_signed_hello(&state,conv_clock)"),
            "锚点没找到（写法变了要同步这条判据）—— 否则它会静默空转"
        );
        assert!(
            flat.contains("timeout(HANDSHAKE_TIMEOUT,high_tx.send(build_signed_hello"),
            "回发 Hello 必须包在 tokio::time::timeout 里：无界 send 会把连接楔死在握手补全这一步"
        );
    }

/// **STB-05：1:1 消息走两条线（直连 `ChatMessage` / 多跳 `GossipEnvelope`），
/// 但"什么样的 kind 要不要提醒"必须只有一份判据。**
///
/// 两条线的**线格式**不同是刻意的（直连帧 vs 可转发的信封，统一就得改协议，
/// 而老端还在网上）；风险在这条链的另一半：两侧各写一套 kind 判断，日后只改了
/// 其中一侧 ⇒ 同一条消息"直连来会提醒、多跳来不提醒"（或反过来），
/// 而这种不对称**没有任何行为用例会红**。
///
/// 判据 = 两侧都调同一个 `protocol::is_non_notifying_kind`，且这个谓词与它依赖的
/// `DM_LEGACY_KINDS` 清单在全仓只有一份定义（没有第二个家可以漂）。
#[test]
fn both_dm_paths_share_one_notification_kind_predicate() {
    for (path, src) in [
        ("handle_messaging.rs", include_str!("network/transport/handle_messaging.rs")),
        ("gossip.rs", include_str!("network/transport/gossip.rs")),
    ] {
        assert_eq!(
            src.matches("crate::protocol::is_non_notifying_kind(").count(),
            1,
            "{path} 必须恰好调一次共享谓词 —— 少一次说明这一侧改用自己那套（两侧会静默分叉）"
        );
    }
    let protocol = include_str!("protocol.rs");
    assert_eq!(
        protocol.matches("pub fn is_non_notifying_kind").count(),
        1,
        "共享谓词只能有一个定义"
    );
    // 冻结清单也只有一份：三份源码里**合计**只许出现一次这个字面清单 ——
    // 谁把它再抄一遍（哪怕抄进注释当"备忘"），就是第二个家。
    let list = "\"text\", \"code\", \"image\", \"file\", \"system\"";
    let copies: usize = [
        protocol,
        include_str!("network/transport/handle_messaging.rs"),
        include_str!("network/transport/gossip.rs"),
    ]
    .iter()
    .map(|src| src.matches(list).count())
    .sum();
    assert_eq!(
        copies, 1,
        "`DM_LEGACY_KINDS` 的清单被抄了 {copies} 份 ⇒ 两侧的 kind 口径从此可以各自漂"
    );
}

/// **STB-04 半格：1:1 收件路径的身份判定不许用会折叠读失败的读法。**
///
/// `db::get_friend` 把 `Err` 折成 `None`（"不是好友"，展示路径上没问题）。可收件路径拿它做
/// **权限判定**：读失败被读成"不是好友"就拒收 + `return`，而这条消息的 `msg_id` 已经进过
/// 去重表 ⇒ 之后每一次补发都被判 Duplicate，**永久进不来**（直到进程重启）。
///
/// 判据钉三件事：① 用 `get_friend_checked`（末尾没有 `&env.sender_id)` 的折叠读法出现）；
/// ② 读失败那一臂要 `allow_message_retry` 放行补发重入；③ 要留具名码（否则事后只看到
/// "消息没到"）。变异：换回 `get_friend`、或删掉撤销那一行，都必须红。
#[test]
fn dm_recipient_friend_check_keeps_read_errors_and_undoes_dedupe() {
    let src = include_str!("network/transport/gossip.rs");
    let body = rust_fn_body(src, "async fn handle_gossip(");
    assert!(
        body.contains("db::get_friend_checked(&dbc, &env.sender_id)"),
        "1:1 收件路径必须用 checked 读：折叠读会把一次读抖动读成「不是好友」"
    );
    // 两条权限判定（收件 / 中继转发授权）都不许用折叠读法：`get_friend` 把 Err 折成 None。
    assert!(
        !body.contains("db::get_friend(&dbc"),
        "`db::get_friend` 把 Err 折成 None —— handle_gossip 里的权限判定一律用 checked 读"
    );
    assert!(
        body.contains("code=GOSSIP_RELAY_AUTH_READ_FAILED"),
        "中继转发授权的读失败也要留具名码（失败关闭，但别让它表现为「中继莫名其妙不走」）"
    );
    assert!(
        body.contains("allow_message_retry(state, &env.message_id, \"friend_read_failed\")"),
        "读失败那一臂必须撤销去重：否则对方之后每一次补发都被判 Duplicate"
    );
    assert!(
        body.contains("code=GOSSIP_FRIEND_READ_FAILED"),
        "读失败要留具名码 —— 否则事后只能看到「消息没到」"
    );
}

/// 群密钥扇出：**跳过成员必须留痕**（闭环矩阵 F-GRP-003）。
///
/// 形状判据而不是行为判据：真跑一次扇出要 AppState + 真密钥，成本远高于这条守的东西。
/// 守的是比例 —— 两个扇出点各 3 个可失败臂（没有公钥 / DH 失败 / 密封失败），
/// 每个臂都必须写一行 `code=GROUP_KEY_MEMBER_SKIPPED` 且带 reason。
/// 删掉任一臂的留痕、或把 reason 合并成一句，这里立刻红。
#[test]
fn group_key_fanout_never_skips_a_member_silently() {
    let src = include_str!("commands/groups.rs");
    let sites = src.matches("resolve_member_x25519(s, m)").count();
    assert_eq!(sites, 2, "扇出点数量变了（{sites}）⇒ 本判据的分母要跟着改");
    let codes = src.matches("code=GROUP_KEY_MEMBER_SKIPPED").count();
    assert_eq!(
        codes,
        sites * 3,
        "每个可失败臂都要留痕：实际 {codes} 处，期望 {}（静默 continue 会让成员「永远收不到群密钥」无记录）",
        sites * 3
    );
    for reason in ["reason=no_pubkey", "reason=dh_failed", "reason=seal_failed"] {
        assert_eq!(
            src.matches(reason).count(),
            sites,
            "{reason} 的臂数不对 ⇒ 跳过原因没法归因"
        );
    }
}

/// 群命令的**拒绝**必须留痕（越权 / 目标没了 / 状态不对）。
///
/// 界面只拿到一句中文；事后问「为什么这次点不动」时日志里得有一行能按 `code=` 筛的。
/// 守的是「配对的形状」：每个调用点都把 action 与 reason 两个**字面量**并排放进
/// `reject(s, &group_id, "action", "reason", …)` —— 因此这里可以逐对断言，
/// 而不是只断言"码出现过"。输入格式校验（空标题/超长）刻意不在这个族里。
#[test]
fn group_command_rejections_are_traced_not_silent() {
    let src = include_str!("commands/group_files.rs");
    let calls = src.matches("reject(s,").count();
    assert_eq!(calls, 9, "拒绝留痕的调用点数变了（{calls}）⇒ 本判据的分母要跟着改");
    for (action, reason) in [
        ("remind", "target_missing"),
        ("remind", "not_member"),
        ("remind_ack", "not_member"),
        ("remind_ack", "target_missing"),
        ("todo", "not_member"),
        ("todo_edit", "not_authorized"),
        ("todo_edit", "state_refused"),
        ("announcement", "not_owner"),
        ("announcement_delete", "not_owner"),
    ] {
        let needle = format!("\"{action}\", \"{reason}\"");
        assert!(
            src.contains(&needle),
            "少了一格拒绝留痕：{needle}（{action}/{reason} 不再进日志 ⇒ 这一格又变回静默）"
        );
    }
}

/// 收藏 / 预览 / 清数据的**失败与拒绝**必须留痕（闭环矩阵「可诊断可追溯」）。
///
/// 守两层：① 调用点数（分母）＝10；② 每个 `reason` 字面量都必须出现在某个
/// `reject_favorite(` 调用里（同一句内，跨行也算）—— 只数"码出现过"会被别处的同名串骗过。
/// 纯输入校验（批量超上限、导出路径为空）刻意不在这个族里。
#[test]
fn favorite_failure_paths_are_traced_not_silent() {
    let src = include_str!("commands/favorites.rs");
    let calls = src.matches("reject_favorite(").count() - 1; // 扣掉 fn 定义
    assert_eq!(calls, 10, "留痕调用点数变了（{calls}）⇒ 本判据的分母要跟着改");
    let reasons = [
        ("add", "source_gone", 1),
        ("add", "copy_failed", 1),
        ("preview", "file_gone", 1),
        ("preview", "too_large", 1),
        ("content_preview", "content_missing", 1),
        ("content_preview", "store_read_failed", 1),
        ("content_preview", "path_escape", 1),
        ("content_preview", "file_gone", 1),
        ("content_preview", "too_large", 1),
        ("clear_data", "partial_fs_error", 1),
    ];
    for (action, reason, want) in reasons {
        let got = src.matches(&format!("\"{reason}\"")).count();
        assert!(got >= want, "{action}/{reason} 的留痕不见了（{got} < {want}）");
        let paired = src
            .split("reject_favorite(")
            .skip(1)
            .any(|tail| {
                let head = tail.split(';').next().unwrap_or("");
                head.contains(&format!("\"{action}\"")) && head.contains(&format!("\"{reason}\""))
            });
        assert!(
            paired,
            "{action}/{reason} 没有并排出现在同一个 reject_favorite( … ) 里 ⇒ 配对断了"
        );
    }
}

/// 外链导入/清理与资料推送的失败要留痕（「可诊断可追溯」那两格）。
///
/// ① 外链：`code=LINK_ACTION_REJECTED action=… reason=…`，4 个出口
///    （`clean_export/outside_export` 是**安全信号**；`import` 的 HTTP 非 2xx 与两处超大中止）。
/// ② 资料推送：`PROFILE_PUSH_CLOSED` / `PROFILE_PUSH_TIMEOUT` —— 以前只有中文 warn、按码筛不到。
#[test]
fn link_and_profile_failures_carry_named_codes() {
    let links = include_str!("commands/external_links.rs");
    assert_eq!(
        links.matches("reject_link(").count(),
        5,
        "外链留痕调用点数变了（含定义应为 5）⇒ 分母要跟着改"
    );
    for (action, reason) in [("clean_export", "outside_export"), ("import", "http_status")] {
        let paired = links.split("reject_link(").skip(1).any(|tail| {
            let head = tail.split(';').next().unwrap_or("");
            head.contains(&format!("\"{action}\"")) && head.contains(&format!("\"{reason}\""))
        });
        assert!(paired, "{action}/{reason} 没有并排出现在同一个 reject_link( … ) 里");
    }
    assert_eq!(
        links.matches("\"too_large\"").count(),
        2,
        "超大中止应有两处（Content-Length 预检 + 流式累计）"
    );
    let sys = include_str!("commands/system.rs");
    for code in ["code=PROFILE_PUSH_CLOSED", "code=PROFILE_PUSH_TIMEOUT"] {
        assert_eq!(sys.matches(code).count(), 1, "{code} 的出现次数不是 1（留痕被删或重复）");
    }
}

/// 手机端选图转码 / 同意好友两条链的失败要留痕（「可诊断可追溯」那几格）。
///
/// ① HEIC 转码：Kotlin 返回 null 与 JNI 调用失败是两种不同的降级（前者"转不了但文件还在"，
///    后者"根本没跑通"），共用一句中文时排查分不开 ⇒ 两个码。
/// ② 同意好友：缺对端公钥那条**返回值**早有 `E2EE_PUBKEY_MISSING`（走 `coded()`），
///    但**日志**里没有码；这次把同一件事的两个通道都点名。回执发送失败另有一个
///    `FRIEND_ACCEPT_RESEND_QUEUED`（已登记待补发），与 handshake 的补发码成对。
/// ③ 同意/拒绝时申请已不在待处理表：`FRIEND_REQUEST_GONE`。
#[test]
fn mobile_picker_failures_carry_named_codes() {
    let src = include_str!("commands/mobile_picker.rs");
    for code in [
        "code=HEIC_TRANSCODE_NULL",
        "code=HEIC_TRANSCODE_FAILED",
        "code=FRIEND_ACCEPT_RESEND_QUEUED",
    ] {
        assert_eq!(src.matches(code).count(), 1, "{code} 的出现次数不是 1（留痕被删或重复）");
    }
    // 缺公钥那条复用已有常量，不新造字符串：申请/同意两个返回值出口 + 一个日志出口，
    // 再加撤回帧发送的返回值出口 ⇒ 常量共出现 4 次，且日志那句必须是 `code={}` 拼出来的。
    assert_eq!(
        src.matches("crate::error_codes::E2EE_PUBKEY_MISSING").count(),
        4,
        "缺公钥的常量出现次数变了（三个 coded 出口 + 一个日志出口 = 4）"
    );
    assert!(
        src.contains("code={} 同意好友但缺对端公钥"),
        "缺公钥的**日志**没有配码（返回值的码不能替代日志里的码）"
    );
}

/// F-MSG-060：消息页读失败必须是 `Err`，**不许**折叠成空列表。
///
/// 行为那半：库坏了（表都不在）时 `db::get_messages` 必须报错 —— 如果它返回 `Ok(vec![])`，
/// 界面看到的是「这个会话一条记录都没有」，用户会以为聊天记录全没了（B1-F7 的形状）。
/// 接线那半：命令层必须把错误包成 `消息页读取失败: …` 而不是 `.ok()` / `unwrap_or_default()`。
#[test]
fn broken_db_reading_messages_is_an_error_not_an_empty_page() {
    let conn = rusqlite::Connection::open_in_memory().expect("内存库");
    let got = crate::db::get_messages(&conn, "peer:nobody", 10, 0);
    assert!(
        got.is_err(),
        "表都不存在却返回 Ok ⇒ 这一页会被画成「一条记录都没有」：{got:?}"
    );
    let src = include_str!("commands/chat.rs");
    let body = src
        .split("pub async fn get_messages(")
        .nth(1)
        .expect("get_messages 不见了 ⇒ 判据的锚点要跟着改");
    let head = body.split("\n}\n").next().unwrap_or(body);
    assert!(
        head.contains("消息页读取失败"),
        "命令层没有把读失败包成具名错误 ⇒ 前端只能拿到空列表"
    );
    assert!(
        !head.contains("unwrap_or_default()"),
        "命令层把读失败折成了空列表（正是 B1-F7 要禁的形状）"
    );
}

/// B3-F2 / F-PST-004：「清除聊天数据」的清表清单**不许再手抄漂移**。
///
/// 清单与 schema 是两个事实源，中间原先没有任何判据：加一张表时没人会记得回来加一行
/// ⇒ 新账本表默认成为「清除数据清不掉的东西」（B3-F2 的原始读数就是 20 张表只清 15 张）。
/// 这里从两处 `CREATE TABLE` 现解析全部表名（`db.rs` + `content/store.rs` —— 后者建在
/// `content_transfers` 上，只数 `db.rs` 会看不见它），再与清表清单双向对账：
///   ① 每张表必须在「整表清 / 局部清 / 显式豁免」三者之一里，豁免必须带理由；
///   ② 清单里点名的表必须真的存在（反向：改名/删表后清单不许留幽灵）。
fn create_table_names(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for marker in ["CREATE TABLE IF NOT EXISTS ", "CREATE TABLE "] {
        let mut rest = src;
        while let Some(i) = rest.find(marker) {
            let after = &rest[i + marker.len()..];
            let name: String = after
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() && name != "IF" {
                out.push(name);
            }
            rest = after;
        }
    }
    out.sort();
    out.dedup();
    out
}

#[test]
fn clear_chat_data_covers_every_table_or_says_why_not() {
    let mut tables = create_table_names(include_str!("db.rs"));
    tables.extend(create_table_names(include_str!("content/store.rs")));
    tables.sort();
    tables.dedup();

    let fav = include_str!("commands/favorites.rs");
    let block = fav
        .split("for table in [")
        .nth(1)
        .expect("清表循环不见了 ⇒ 判据锚点要跟着改")
        .split(']')
        .next()
        .unwrap_or("");
    let mut cleared: Vec<String> = block
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .filter(|s| s.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
        .collect();
    cleared.sort();
    cleared.dedup();

    // 局部清（`LIKE` 删前缀）与显式豁免（带理由）。豁免是**产品口径**，不是"忘了"。
    let partial = ["settings", "conversation_clocks"];
    let exempt = [
        ("friends", "通讯录不是聊天数据：清聊天记录不该把好友删掉"),
        (
            "favorites",
            "用户 2026-10-31 决策：普通清理保留收藏；要删必须走独立、明确、有告知的操作（A3/F-CLR-01）",
        ),
    ];
    for (t, why) in exempt {
        assert!(!why.trim().is_empty(), "豁免表 {t} 没写理由");
        assert!(tables.iter().any(|x| x == t), "豁免表 {t} 在 schema 里不存在（清单漂了）");
    }

    let uncovered: Vec<&str> = tables
        .iter()
        .map(String::as_str)
        .filter(|t| !cleared.iter().any(|c| c == t))
        .filter(|t| !partial.contains(t))
        .filter(|t| !exempt.iter().any(|(e, _)| e == t))
        .collect();
    assert!(
        uncovered.is_empty(),
        "这些表既不在清表清单里、也没有显式豁免 ⇒ 清除数据之后会留下无主残留：{uncovered:?}\n\
         （要么加进 `for table in [...]`，要么在 exempt 里写一句为什么不删）"
    );

    let ghosts: Vec<&str> = cleared
        .iter()
        .map(String::as_str)
        .filter(|t| !tables.iter().any(|x| x == t))
        .collect();
    assert!(ghosts.is_empty(), "清表清单里有 schema 中不存在的表（改名/删表后没同步）：{ghosts:?}");
}

/// F-GRP-001：群管理的三条授权闸必须在**写之前**，且三条越权话术都得在。
///
/// 存储层的半边已有行为测试（`group_name_only_updates_for_the_recorded_creator`、
/// `set_group_creator_updates_creator_only`）；这里守的是**命令层**：谁能发起、什么时候拒绝。
/// 顺序断言不是形式主义 —— 检查挪到写之后，非群主照样能改，而界面只会看到"成功"。
#[test]
fn group_management_authorization_is_checked_before_the_write() {
    fn body<'a>(src: &'a str, sig: &str) -> &'a str {
        let tail = src
            .split(sig)
            .nth(1)
            .unwrap_or_else(|| panic!("{sig} 不见了 ⇒ 判据锚点要跟着改"));
        let end = tail.find("\n}\n").unwrap_or(tail.len());
        &tail[..end]
    }
    let src = include_str!("commands/groups.rs");
    for (sig, denial, write) in [
        (
            "pub async fn rename_group(",
            "只有群创建者可以修改群名称",
            "db::rename_group(",
        ),
        (
            "pub async fn transfer_group_creator(",
            "只有群创建者可以转让群主",
            "db::set_group_creator(",
        ),
        (
            "pub async fn leave_group(",
            "群主退群前请先转让群主",
            "db::delete_group(",
        ),
    ] {
        let b = body(src, sig);
        let d = b
            .find(denial)
            .unwrap_or_else(|| panic!("{sig} 的越权拒绝「{denial}」不见了"));
        let w = b
            .find(write)
            .unwrap_or_else(|| panic!("{sig} 的写调用 {write} 不见了"));
        assert!(
            d < w,
            "{sig}: 越权检查在写之后（检查 {d} / 写 {w}）⇒ 非群主也能改，而界面只看到成功"
        );
    }
    // 转让群主另有两道闸：不许转给自己、目标必须是成员
    let b = body(src, "pub async fn transfer_group_creator(");
    let w = b.find("db::set_group_creator(").unwrap();
    for denial in ["不能把群主转让给自己", "只能转让给群成员"] {
        let d = b.find(denial).unwrap_or_else(|| panic!("转让群主少了「{denial}」这道闸"));
        assert!(d < w, "「{denial}」必须在写库之前");
    }
}

/// F-GRP-007：群列表读失败也必须是 `Err`，不许折叠成空列表（与 F-MSG-060 同一条 B1-F7 口径）。
///
/// 行为半：库坏了（表都不在）时 `db::list_groups` 必须报错 —— `Ok(vec![])` 会被画成
/// 「你的群都不见了」。接线半：`get_groups` 必须包成 `群列表读取失败: …` 且体内不得
/// 出现 `unwrap_or_default()`。
#[test]
fn broken_db_reading_groups_is_an_error_not_an_empty_list() {
    let conn = rusqlite::Connection::open_in_memory().expect("内存库");
    let got = crate::db::list_groups(&conn);
    assert!(got.is_err(), "表都不存在却返回 Ok ⇒ 界面会画成「群全没了」：{got:?}");
    let src = include_str!("commands/groups.rs");
    let body = src
        .split("pub async fn get_groups(")
        .nth(1)
        .expect("get_groups 不见了 ⇒ 判据锚点要跟着改");
    let head = body.split("\n}\n").next().unwrap_or(body);
    assert!(head.contains("群列表读取失败"), "命令层没有把读失败包成具名错误");
    assert!(
        !head.contains("unwrap_or_default()"),
        "命令层把读失败折成了空列表（B1-F7 的形状）"
    );
}

/// F-FRN-004：删好友的**级联范围与顺序**都有判据。
///
/// 只删 `friends` 那一行会留下四种"看得见的错"：在途发送把 transfer 写回 active、
/// 文件补发队列继续推、内存 `peers` 里的旧公钥让"重新加好友"被硬拒（必须重启）、
/// 待发消息永远停在「发送中」而日志里没有一行。
/// 存储层的样式缓存另有行为测试（`removing_a_friend_forgets_its_chat_style`）。
#[test]
fn removing_a_friend_cancels_before_deleting_and_forgets_identity() {
    let src = include_str!("commands/friends.rs");
    let tail = src
        .split("pub async fn remove_friend(")
        .nth(1)
        .expect("remove_friend 不见了 ⇒ 判据锚点要跟着改");
    let body = tail.split("\n}\n").next().unwrap_or(tail);
    let cancel = body
        .find("cancel_send_transfers_for_peer")
        .expect("删好友前不取消在途发送 ⇒ 发送任务会把 transfer 写回 active");
    let del = body
        .find("db::remove_friend(")
        .expect("删好友的写调用不见了");
    assert!(
        cancel < del,
        "顺序反了：必须先取消在途发送（{cancel}），再删好友行（{del}）"
    );
    for (needle, why) in [
        ("db::delete_file_outbox_for_peer", "文件补发队列要一起清（否则下次建链把文件推给已删好友）"),
        ("db::forget_chat_peer_style", "样式缓存要按 device_id 摘掉（不留幽灵）"),
        ("db::fail_pending_messages_for_peer", "待发消息要落 failed（否则永远停在「发送中」）"),
        ("code=REMOVE_FRIEND_OUTBOX_FAILED", "队列清理失败必须留痕"),
        ("forget_peer_identity", "内存身份不解除 ⇒ 对方换过公钥时要重启才能重新加"),
    ] {
        assert!(body.contains(needle), "删好友少了「{needle}」这一步：{why}");
    }
}

/// F-MSG-004：重发的三步顺序是**先密封 → 再入队并置 sending → 再投递**。
///
/// 旧形状反过来（先 `set_message_status("sending")`，再判群聊/取钥/加密）：任一步失败都不回滚
/// ⇒ 状态永久卡 `sending`，而重发入口的守卫又把它挡死 ⇒ 这条消息**永远发不出去**，
/// outbox 也从未写入。这条判据钉的就是那个顺序，以及"加密之前不许出现 sending 的写"。
#[test]
fn resend_seals_before_it_enqueues_and_marks_sending() {
    let src = include_str!("commands/chat.rs");
    let tail = src
        .split("pub async fn resend_message(")
        .nth(1)
        .expect("resend_message 不见了 ⇒ 判据锚点要跟着改");
    let body = tail.split("\n}\n").next().unwrap_or(tail);
    let seal = body
        .find("crypto::seal(")
        .expect("重发不再密封 ⇒ 线上会是明文（接收端 `open_direct_content` 直接拒收）");
    let enqueue = body
        .find("requeue_message_for_resend(")
        .expect("重发的入队+置 sending 不见了");
    assert!(
        seal < enqueue,
        "顺序反了：必须先密封（{seal}）再入队并置 sending（{enqueue}）—— 反过来任一步失败都会把状态永久卡在 sending"
    );
    // 加密之前不许出现任何把状态写成 sending 的调用（旧 bug 的形状）
    let head = &body[..seal];
    assert!(
        !head.contains("\"sending\""),
        "密封之前就写了 sending ⇒ 又回到「失败后永久卡住、outbox 从未写入」的旧形状"
    );
}

/// F-GRP-003：建群是**一笔事务**，而"分发密钥"是另一件事 —— 建群成功不依赖分发。
///
/// 这条守的是"部分成功"的形状：群行 / 成员行 / 群密钥 / 会话行必须同进同退（少一样就会
/// 出现"有群没成员"或"有会话没群"），而校验（成员必须是好友）必须在事务**之前**；
/// 分发（`try_send` / `distribute_group_key`）不许出现在事务里 —— 网络 I/O 持着 db 锁
/// 会把整台机器的读命令一起卡住。
#[test]
fn create_group_commits_its_rows_together_and_keeps_io_out_of_the_transaction() {
    let src = include_str!("commands/groups.rs");
    let tail = src
        .split("pub fn create_group(")
        .nth(1)
        .expect("create_group 不见了 ⇒ 判据锚点要跟着改");
    let body = tail.split("\n}\n").next().unwrap_or(tail);
    for needle in [
        "INSERT INTO groups(",
        "INSERT OR IGNORE INTO group_members(",
        "INSERT INTO settings(",
        "INSERT OR IGNORE INTO conversations(",
    ] {
        assert!(body.contains(needle), "建群少了「{needle}」这一步：少一样就会留下半建成的群");
    }
    assert_eq!(
        body.matches("unchecked_transaction").count(),
        1,
        "建群必须**恰好一笔**事务（多开一笔就会有半可见的中间态）"
    );
    let tx = body.find("unchecked_transaction").unwrap();
    let commit = body.find("tx.commit()").expect("建群没有 commit");
    let validate = body
        .find("db::get_friend(")
        .expect("成员必须是好友这条校验不见了");
    assert!(
        validate < tx,
        "校验必须在事务之前（{validate} / {tx}）—— 进事务再发现不是好友，已经写进去的行要回滚，白白持锁"
    );
    let window = &body[tx..commit];
    for net in ["try_send(", "distribute_group_key(", ".await"] {
        assert!(
            !window.contains(net),
            "事务里出现了「{net}」⇒ 持着 db 锁做网络 I/O，全机的读命令都会被它堵住"
        );
    }
}

/// F-PLF-021 的网络启停那半：**先起/停网络，再落开关；最后广播且不回发发起窗口**。
///
/// 三条顺序都是真事故换来的：
/// ① 先落开关再起网络 ⇒ 起失败时库里已经写着"开了"，重启后界面显示开着而实际没起；
/// ② 广播不带 `Some(window.label())` ⇒ 发起窗口收到自己发的事件（回声）；
/// ③ 快照必须在起/停**之后**构建 —— 否则回给界面的还是旧状态。
#[test]
fn network_start_and_stop_persist_after_the_action_and_do_not_echo() {
    let src = include_str!("commands/network.rs");
    for (sig, call, flag) in [
        ("pub async fn start_network(", "network::start(", "set_lan_enabled(&dbc, true)"),
        ("pub async fn stop_network(", "network::stop(", "set_lan_enabled(&dbc, false)"),
    ] {
        let tail = src
            .split(sig)
            .nth(1)
            .unwrap_or_else(|| panic!("{sig} 不见了 ⇒ 判据锚点要跟着改"));
        let body = tail.split("\n}\n").next().unwrap_or(tail);
        let act = body.find(call).unwrap_or_else(|| panic!("{sig} 里没调 {call}"));
        let persist = body
            .find(flag)
            .unwrap_or_else(|| panic!("{sig} 没有落开关（{flag}）"));
        assert!(
            act < persist,
            "{sig}: 先落开关再起/停网络（{persist} < {act}）⇒ 动作失败时库里已经写着新状态"
        );
        let snap = body
            .find("build_runtime_snapshot(")
            .unwrap_or_else(|| panic!("{sig} 没有重建快照"));
        assert!(
            persist < snap,
            "{sig}: 快照在建/停之前构建 ⇒ 回给界面的还是旧状态"
        );
        let echo = body
            .find("notify_runtime_changed(snap.clone(), Some(window.label()))")
            .unwrap_or_else(|| panic!("{sig} 的广播没有排除发起窗口（回声）"));
        assert!(snap < echo, "{sig}: 广播必须在快照之后");
    }
}

/// 共享目录两条命令的拒绝与失败必须留痕（此前 `share.rs` 是 **0 个 `code=`** 的整族）。
///
/// 用户点「共享目录」打不开、或下载不了时，界面只拿到一句中文；日志里按码筛不到任何东西。
/// 这四条各对应一种真实结局：不是好友（两种动作各一）/ 对端没回目录树（超时）/ 没有可达的中继邻居
/// （下载请求**从未离开本机** —— 那正是 2026-09-23 审计 A1 的旧形状）。
#[test]
fn share_command_failures_carry_named_codes() {
    let src = include_str!("commands/share.rs");
    assert_eq!(
        src.matches("reject_share(").count(),
        5,
        "共享目录留痕调用点数变了（含定义应为 5）⇒ 分母要跟着改"
    );
    for (action, reason) in [
        ("tree", "not_friend"),
        ("tree", "timeout"),
        ("download", "not_friend"),
        ("download", "no_route"),
    ] {
        let paired = src.split("reject_share(").skip(1).any(|tail| {
            let head = tail.split(';').next().unwrap_or("");
            head.contains(&format!("\"{action}\"")) && head.contains(&format!("\"{reason}\""))
        });
        assert!(
            paired,
            "{action}/{reason} 没有并排出现在同一个 reject_share( … ) 里 ⇒ 这一格又变回静默"
        );
    }
}

/// F-PRE-004：任务中心「消息还没送到对端」那一行的读取，**读失败必须是 Err**。
///
/// 与 F-MSG-060 同一族：这条读折叠成空时，任务中心会画成「没有等待投递的消息」——
/// 用户以为都送到了，而真相是一次 IO 失败。行为半钉 DB 层、接线半钉命令体。
#[test]
fn broken_db_reading_pending_message_ops_is_an_error() {
    let conn = rusqlite::Connection::open_in_memory().expect("内存库");
    let got = crate::db::list_pending_message_operations(&conn, crate::db::MESSAGE_OPS_LIMIT);
    assert!(got.is_err(), "表都不存在却返回 Ok ⇒ 任务中心会画成「没有等待投递的消息」：{got:?}");
    let src = include_str!("commands/chat.rs");
    let body = src
        .split("pub async fn get_pending_message_operations(")
        .nth(1)
        .expect("get_pending_message_operations 不见了 ⇒ 判据锚点要跟着改");
    let head = body.split("\n}\n").next().unwrap_or(body);
    assert!(
        head.contains("list_pending_message_operations(&dbc"),
        "命令层不再调那条读（改了取数方式？先确认再改判据）"
    );
    assert!(
        !head.contains("unwrap_or_default()"),
        "命令层把读失败折成了空列表（F-PRE-004 / B1-F7 的形状）"
    );
}
