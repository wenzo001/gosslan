// 职责边界：
// - `lib_tests.rs` 测试分册之5 —— 文件传输形状：泡前不整档扫、进度按已写出字节、收尾在锁外、取消登记按收件人
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
    /// **气泡前不得做 O(体积) 的整文件扫描**（真机 Mac 发 600MB：点完"卡一会儿"才出现
    /// 发送中气泡 —— 建发送记录时先整读一遍文件算 sha256，而投递任务待会儿还要再读一遍）。
    ///
    /// 这条不变量很容易"顺手写回去"：它看起来只是"提前把 cid 准备好"，代价却挂在用户
    /// 点下发送按钮之后。cid 的正确来源是投递任务（它本来就要算，用于 FileOffer 校验值），
    /// 算完回填发送行。
    #[test]
    fn no_whole_file_scan_before_the_file_bubble() {
        let files = include_str!("commands/files.rs");
        let build = rust_fn_body(files, "fn build_file_message(");
        assert!(
            !build.contains("sha256_file_hex("),
            "建发送记录前不得整读文件算哈希：那会把气泡挡在一次 O(体积) 扫描之后"
        );
        assert!(
            build.contains("\"sha256\": \"\""),
            "cid 必须以空串占位（载荷形状不能变，前端按 sha256 键取值）"
        );

        // 视图读"一个家"`network::file_src_for_guards()`（2026-10-07 file.rs 按角色切成 include! 分册）：
            // 读单个文件只会看见主册 ⇒ 形状守卫对分册失明（假绿形状）。登记对账由 lib_source_view_tests 第四个用例钉两侧。
                    let file = &crate::network::file_src_for_guards();
        let body = rust_fn_body(file, "pub async fn send_file_from_path_at(");
        assert!(
            body.contains("spawn_blocking"),
            "整文件哈希必须在阻塞线程池：占住 async worker 会连带拖慢其它传输"
        );
        assert!(
            body.contains("fill_message_sha256"),
            "投递任务算出的 cid 必须回填发送行，否则本地合并卡片按 cid 找不回字节"
        );
        assert!(
            body.contains("backfilled") && body.contains("emit(\"message-received\", &rec)"),
            "回填改了库就必须通知前端：只写库时内存里那条记录仍是 cid 空的版本，\
             同一会话把刚发的文件转成合并卡片会丢掉对端的拉取钥匙（v4.22.16 的回归）"
        );
    }

    /// **接收端判死必须把否定确认送回，而且发送端要能在分片循环里立刻看到**。
    ///
    /// 旧行为是"判死但谁也不告诉"：发送端把剩下的整份文件继续灌进一条已经死掉的传输，
    /// FileDone 无人应答 → 干等一个 `FILE_ACK_IDLE` → 判"可重试" → 再整发 5 次。
    /// 真机形状：600MB 跑到 100% 两边都显示失败，中间几十分钟界面一直"发送中"。
    /// 这条链有**三个环节**（回帧、早注册、循环里盯），断掉任意一个都看不出差别，
    /// 所以三个点一起钉。
    #[test]
    fn receiver_abort_notifies_the_sender_inside_the_loop() {
        let tr = code_flat(&crate::network::transport_src_for_guards());
        assert!(
            tr.contains("iffile::fail_receive(state,&transfer_id,peer_id,&e){")
                && tr.contains(
                    "Message::FileCompleteAck{transfer_id:transfer_id.clone(),success:false,}"
                ),
            "分片判死必须回 FileCompleteAck{{success:false}}（fail_receive 返回 false 表示没有活的\
             接收器，不重复回）"
        );
        assert!(
            !tr.contains("let _=file::fail_receive(state,&transfer_id,peer_id,&e);"),
            "不得退回「abort 了但不告诉发送端」的旧写法"
        );
        let f = code_flat(&crate::network::file_src_for_guards());
        assert!(
            f.contains("_=&mutack_rx=>"),
            "分片循环必须盯着否定确认，才能当场停手而不是把剩余字节灌完"
        );
        assert_eq!(
            f.matches(".insert(transfer_id.to_string(),tx)").count(),
            2,
            "pending_file_accept 与 pending_file_complete 各登记一次；出现第三次说明有人\
             又把 complete 注册挪回了循环之后（那样循环里的 ack_rx 就成了死代码）"
        );
    }

    /// **群文件投递的取消登记必须按 (transfer_id, recipient) 分键**（真机：三成员以上
    /// 的群文件只有一个人收得到）。
    ///
    /// 群发是「每个可达成员各 `tokio::spawn` 一个任务、共用同一个 `transfer_id`」。
    /// 单键时后注册的 `HashMap::insert` 会挤掉前一个任务的 `Sender`，对方的 oneshot 立刻
    /// 以 `Err(RecvError)` 完成，而投递循环的取消分支分不清「用户真点了取消」和
    /// 「登记被顶替」⇒ N-1 个成员以「用户取消发送」这个假原因当场中断。
    /// 只能钉源码：这是语言级细节，行为测试要先构造出"顶替"才看得到。
    #[test]
    fn group_file_cancel_registry_is_scoped_per_recipient() {
        let dispatch = code_flat(include_str!("commands/group_file_dispatch.rs"));
        let fanout = code_flat(include_str!("commands/group_announcements.rs"));
        assert!(
            dispatch.contains("file_cancel_key(transfer_id,recipient)"),
            "群投递的取消登记必须带 recipient（否则同 transfer_id 的任务互相挤掉登记）"
        );
        assert!(
            !dispatch.contains(".insert(transfer_id.to_string(),cancel_tx)"),
            "不得回退成 transfer_id 单键"
        );
        // ★ 出错必须落终态，而且**两条投递路径共用同一个裁决**（#154-4）。
        // 原先只有群发那条写状态、且按错误**文案**猜 cancelled/failed；离线补发那条
        // 什么都不写 ⇒ 补发失败一次就把该成员永久卡在 sending（重试查询只捞 pending）。
        let requeue = code_flat(include_str!("commands/group_file_keys.rs"));
        for (name, src) in [
            ("group_announcements.rs（群发 fan-out）", fanout.clone()),
            ("group_file_keys.rs（离线补发）", requeue.clone()),
        ] {
            assert!(
                src.contains("group_file_status_after_fail(&e)"),
                "{name} 必须走那一个终态裁决，不许自己判状态"
            );
            assert!(
                src.contains("update_group_file_recipient("),
                "{name} 必须真的把终态写回库：离线补发只捞 status='pending'，\
                 留在 sending 就是「永远在发、重启也不重试」"
            );
        }
        assert!(
            !fanout.contains("\"用户取消发送\""),
            "不许再按错误**文案**猜状态（文案一改就判错；状态由 GroupFileSendErr 的种类决定）"
        );
    }

    /// 发送进度必须落在"已写出链路"上，不许回到"已入队"（v4.22.37 的用户可见症状）。
    ///
    /// 六处同时成立才有意义，所以一起钉：
    ///   ① writer 那唯一的证据点必须**累加片数**（只记时刻的话进度算不出来）；
    ///   ② 状态表的值必须是带 `chunks` 的结构，而不是裸时间戳；
    ///   ③ `stream_file` 的进度与 `file-progress` 事件必须用换算后的 `on_wire` ——
    ///      旧写法 `received: sent` 就是那个"262MB 还在队列里就 100%"的假象。
    ///   ④ 生命周期：装了回收守卫，且清理只此一处；
    ///   ⑤ 键按 (传输 × 收件人)：写侧与读侧必须同一个 `file_peer_key`（#35 —— 群发是 N 个
    ///      任务共用一个 `transfer_id`，退回裸 id 就是"甲的写出替乙续命"）；
    ///   ⑥ 群投递侧同样装守卫、同样按收件人判停滞，且**中继帧不记账**这条决定被钉住。
    /// 判据都取**函数体**而不是全文：`received: sent` 在中继发文件那条路径里是合法的
    /// （另一套语义），全文一扫会误伤。
    #[test]
    fn file_send_progress_counts_wire_not_queue() {
        let file = &crate::network::file_src_for_guards();
        let body = rust_fn_body(file, "async fn stream_file(");
        assert!(
            body.contains("wire_progress_bytes("),
            "stream_file 的进度必须经 wire_progress_bytes 换算"
        );
        assert!(
            body.contains("file_wire_chunks_at("),
            "换算必须读 writer 记的已写出片数，否则等于没换"
        );
        assert!(
            !body.contains("received: sent"),
            "file-progress 不许再直接发入队量（那就是 100% 假象）"
        );
        // ④ 记账的生命周期：装了回收守卫，且**没有第二处手写清理**。
        //    只测 `WireLedger` 的 Drop 语义不够 —— 把 stream_file 里那行装守卫的代码删掉，
        //    Drop 测试照样全绿（它测的是辅助类型，不是接线）。
        assert!(
            body.contains("WireLedger::install("),
            "stream_file 必须装写出记账的回收守卫，否则失败路径的残留会让重试退回入队口径"
        );
        assert!(
            !body.contains("clear_file_wire_progress"),
            "清理只许有 WireLedger::drop 一处，第二处迟早与它口径不同"
        );
        // ⑤ 键必须按收件人（#35）。读侧只要有一处退回裸 `transfer_id`，读到的就是
        //    "别人的写出"或"永远没有写出" —— 两者都静默。
        assert!(
            body.contains("file_wire_chunks_at(state, &wire_key)"),
            "进度换算必须读 (传输 × 收件人) 那一条记账，裸 transfer_id 是旧口径"
        );
        assert!(
            !body.contains("file_wire_chunks_at(state, transfer_id)"),
            "stream_file 里出现裸 transfer_id 读记账 = 与 writer 的键不一致，进度会永远 0"
        );

        // ⑥ 群发投递侧同样要装回收守卫并按收件人查停滞（N 个任务共用一个 transfer_id）。
        let dispatch = include_str!("commands/group_file_dispatch.rs");
        assert!(
            dispatch.contains("file::WireLedger::install("),
            "群文件投递必须回收自己的写出记账，否则每个成员一条记录永久留在表里"
        );
        assert!(
            dispatch.contains("file::stall_tick(") && dispatch.contains("recipient,"),
            "群侧停滞判定必须带上收件人，不然甲的写出会把乙的卡死盖住"
        );

        let transport = crate::network::transport_src_for_guards();
        let mark = rust_fn_body(&transport, "pub(crate) fn mark_file_wire_progress(");
        assert!(
            code_flat(&mark).contains("bump_file_wire_progress_in(&state.file_wire_progress,&"),
            "writer 的写出证据点必须落进记账表（拆成 bump_* 是为了单测能直接喂一张表）"
        );
        assert!(
            code_flat(&mark).contains("file_peer_key(transfer_id,recipient)"),
            "证据点必须按 (传输 × 收件人) 成键 —— 群发 N 个任务共用一个 transfer_id"
        );
        // 中继帧**故意**不记账（见 `mark_file_wire_progress` 的注释）。这条断言不是装饰：
        // 没有它，下一个"顺手补上 RelayChunk"的改动会让每个转发节点都为别人的传输留一条
        // 没人回收的记录 —— 转发侧没有 WireLedger，那是比"进度不准"更糟的形状。
        assert!(
            !mark.contains("RelayChunk"),
            "RelayChunk 不进入写出记账是**已登记的决定**；要改必须先解决\"谁回收转发侧的记录\""
        );
        let bump = rust_fn_body(&transport, "pub(crate) fn bump_file_wire_progress_in(");
        assert!(
            code_flat(&bump).contains("p.chunks=p.chunks.saturating_add(1)"),
            "writer 的写出证据点必须累加片数"
        );
        let state = include_str!("state.rs");
        assert!(
            state.contains("Mutex<HashMap<String, FileWireProgress>>"),
            "进展表的值必须是 {{at_ms, chunks}} 结构，时间戳单独一个字段撑不起进度口径"
        );
    }

    /// 重复 FileDone 不许静默（2026-09-23 审计 A5）：接收器已被清时，两个出口都得回 Ack。
    ///
    /// 旧代码只有 `if already_done { 回成功 Ack }` 而**没有 else** ⇒ 本机从没收下这份文件时
    /// 一帧都不回，发送端只能干等整个静默窗口（`FILE_ACK_IDLE`）才判失败，然后整套重发。
    /// 为什么是源码守卫：这一条是文件收发族的一个 match 臂（2026-10-07 起住在
    /// `transport/handle_file.rs::handle_file_messages`，原来在 `handle_message` 里），本仓没有
    /// 能驱动它并捕获出站帧的异步夹具（与 A3 那条同理）。判据取「锚点注释 → 下一个 `Ok(Some(`
    /// 之间」这段区域，避开同函数里其他 FileCompleteAck 的计数干扰。
    #[test]
    fn duplicate_file_done_still_answers_with_an_ack() {
        let src = crate::network::transport_src_for_guards();
        // 开窗锚点跟着臂走：FileDone 那一臂现在在文件族的分册里（漏改这里 = 窗口里根本没有那段文本，
        // 下面的 expect 会响，不是静默变弱 —— 这条红是本次搬家自己报出来的）。
        let body = rust_fn_body(&src, "async fn handle_file_messages(");
        let at = body.find("重复 FileDone").expect(
            "文件族里那段「重复 FileDone」判据注释不见了 ⇒ 这条守卫的区域锚点失效",
        );
        let arm = &body[at..];
        let region = &arm[..arm
            .find("Ok(Some(")
            .expect("接收器在位的那条分支锚点不见了")];
        let flat = code_flat(region);
        assert_eq!(
            flat.matches("Message::FileCompleteAck{").count(),
            2,
            "两个出口各回一帧 Ack：已收完回成功、没收下也必须回失败（静默 = 发送端白等一整个静默窗口）"
        );
        assert!(
            flat.contains("Message::FileCompleteAck{transfer_id,success:false,}")
                || {
                    // 2026-10-17：ack 出口要留痕之后，那一支的 `transfer_id` 必须 `.clone()`
                    // （错误文本还要同一个 id），简写字面量因此不再存在。判据改按**位置**读契约：
                    // `if already_done { … } else { … }` 的 else 段里那一帧必须是失败回执。
                    // 比原来那条更紧：原文只证"这句字面量在场"，这条证"失败帧在 else 那一支"。
                    let else_at = flat
                        .find("}else{")
                        .expect("重复 FileDone 那一臂里 if already_done 的 else 支不见了");
                    let tail = &flat[else_at..];
                    tail.matches("Message::FileCompleteAck{").count() == 1
                        && tail.contains("success:false")
                        && !tail.contains("success:true")
                },
            "「本机没这份文件」的出口必须回**失败** Ack；写成功会让发送端把没收下的文件标成已送达"
        );
    }

    /// 「对方已收完」这条捷径必须和成功回执走**同一份**收尾（2026-09-23 审计 A6 的自审发现）。
    ///
    /// Offer 阶段对方直接回 `received = size` 时，发送端 `return Ok(())` 是不再发一个分片的
    /// 正确决定 —— 但收尾（`file_transfers` 落 done、`file-*` 推进 delivered、
    /// `message-acked` / `file-done` / `file-progress` 三个事件）原本整段写在 `stream_file`
    /// 里，捷径一绕过去就是**对方已经收到、我方气泡永久转圈**。判据用定义+调用的总数，
    /// 因为"少了哪一处"正是这类缺陷的形状；两个调用点各自对应一条成功证据。
    #[test]
    fn already_have_shortcut_shares_the_send_finalization() {
        let file = &crate::network::file_src_for_guards();
        assert_eq!(
            file.matches("finalize_send_accepted(").count(),
            3,
            "1 处定义 + 2 处调用（stream_file 成功回执 / Offer 的 received≥size 捷径）。\
             少于 3 = 又出现一条「发送成功却没落终态」的出口 —— 用户看到的是文件气泡一直转圈"
        );
        let arm = rust_fn_body(file, "pub async fn send_file_from_path_at(");
        let at = arm
            .find("if n >= size && size > 0")
            .expect("Offer 阶段「对方已收完」那条分支的判据锚点不见了");
        assert!(
            arm[at..]
                .find("finalize_send_accepted(")
                .is_some_and(|i| i < arm[at..].find("return Ok(())").unwrap_or(usize::MAX)),
            "「对方已收完」必须先落收尾再 return，否则本机状态永远停在 pending"
        );
    }

    /// 接收端 `finish_receive`：慢活必须在**放锁之后**（2026-09-23 真机 600MB + 多文件复核）。
    ///
    /// 为什么钉形状而不是钉行为：要复现"持锁 fsync 堵住别的并发传输"需要两条在途传输 +
    /// 真实磁盘 + 计时，单元层拿不住；而形状一旦退化（锁挪回函数作用域），表现是
    /// "多文件里有一个大文件时其它文件莫名停滞判死"，回查成本极高。
    /// 判据用**位置比较**而不是"调用了几次"：退化前后 `sync_all()` / `finalize()` 的次数一模一样。
    ///
    /// 2026-09-24（#25）慢活整体搬进了 `finish_receiver_into`（那个函数不要 `AppState`，
    /// 所以"显示成功是不是真成功"终于能被单测驱动）⇒ 判据跟着升级成三件事：
    /// 摘锁形状留在包装函数里、慢活留在核心里、而**核心拿不到 `file_receivers` 那张表**
    /// （拿不到就不可能把锁再写回来，这比"位置在后面"强：它是结构性的）。
    #[test]
    fn receive_finalize_slow_work_happens_outside_the_receiver_lock() {
        let file = &crate::network::file_src_for_guards();
        let body = rust_fn_body(file, "pub async fn finish_receive(");
        let flat = code_flat(&body);
        assert!(
            flat.contains("letr={letmutrecv=state.file_receivers.lock()"),
            "接收器必须在块内摘出（块尾即放锁）。函数作用域的锁会把 SHA+fsync+rename \
             全包进锁里 —— 600MB 的 fsync 期间，其它并发文件的 write_chunk 全堵在同一把锁上，\
             它们不再写出 ⇒ 发送端 60s 停滞判据把它们判死"
        );
        assert!(
            !flat.contains("letmutrecv=state.file_receivers.lock().unwrap_or_else(|e|e.into_inner());letr=matchrecv.remove"),
            "旧的函数作用域形状不许回来（那份守卫横跨全部慢活）"
        );
        // 来源不符时的"塞回去"必须留在锁内
        assert!(
            flat.contains("returnErr(\"文件传输来源不匹配\".to_string());}"),
            "找不到来源不符分支 —— 护栏需要同步更新"
        );
        // 摘出来的那份接收器必须**交给核心**，不是就地收尾（就地收尾 = 慢活回到锁的同一作用域）
        assert!(
            flat.contains("finish_receiver_into(&st.db,&st.logger,&transfer_id,r)"),
            "包装函数必须把摘出的接收器整体交给 finish_receiver_into —— 自己留着用就是持锁慢活"
        );
        // ★ 2026-10-14 新增的那一半（用户真机：3.x GB 收尾期间 Windows 窗口操作全失灵）：
        // 慢活必须整体在 `spawn_blocking` 里。留在 async 路径上 = 钉住一个 tokio worker，
        // 而同一个 runtime 上还跑着所有 async 命令（开设置窗/日志窗）⇒ 点了没窗。
        assert!(
            flat.contains("tokio::task::spawn_blocking(move||finish_receiver_into("),
            "收尾慢活必须交给 spawn_blocking（写回成同步调用就是把 GB 级 fsync 重新钉回 tokio worker）"
        );
        let core = rust_fn_body(file, "fn finish_receiver_into(");
        let core_flat = code_flat(&core);
        for slow in [".sync_all()", "hasher.clone().finalize()"] {
            assert!(
                core_flat.contains(slow),
                "慢活 {slow} 必须在 finish_receiver_into 里（挪走≠删掉，掉了它这份文件永远不会落盘）"
            );
        }
        assert!(
            !core_flat.contains("file_receivers"),
            "核心函数不得再碰 file_receivers 表：一碰就能把锁写回慢活的作用域（这条是结构性的）"
        );
    }

    /// 群文件收尾的**同一格**（2026-10-15）：慢活必须整体在 `spawn_blocking` 里，
    /// 而四种失败的终态收尾只许有**一个家**。
    ///
    /// 为什么要单独钉一条、不复用上面那条：4.39.3 只把单聊那份交出去，群那份
    /// （`handle_group_file_done`）仍在 `reader_loop` 的 tokio 任务里做 GB 级 fsync + rename
    /// ⇒ 传大群文件时"点设置没窗 / 拖窗口没反应"会原样复发。同时群那四个失败出口各写一遍
    /// 收尾，其中 SHA-256 那一格漏了 `file_transfers` 的终态写（校验失败后那一行永远停在
    /// `active`）。两条都是"同一个根因的第二个家"，而这类形状正好要靠一条**按数量**说话的守卫。
    #[test]
    fn group_receive_finalize_slow_work_runs_off_the_async_worker() {
        let view = &crate::network::transport_src_for_guards();
        let body = rust_fn_body(view, "async fn handle_group_file_done(");
        let flat = code_flat(&body);
        // ★ 慢活整体交给阻塞线程池（写回成就地调用 = 把 GB 级 fsync 重新钉回 tokio worker）
        assert!(
            flat.contains(
                "tokio::task::spawn_blocking(move||{file::finish_group_receive_into(r,&downloads)})"
            ),
            "群收尾的校验+fsync+rename 必须整体交给 spawn_blocking（同一个 runtime 上还排着所有 async 开窗命令）"
        );
        // 摘表形状：接收器必须按 transfer_id 摘出后再收尾（摘在锁内、收在锁外）
        assert!(
            flat.contains(
                ".group_file_receivers.lock().unwrap_or_else(|e|e.into_inner()).remove(&transfer_id)"
            ),
            "群接收器必须先按 transfer_id 摘出，锁不在慢活的作用域里"
        );

        // 终态收尾按数量说话：一失败一成功，各恰好一处。整行注释不计入分母（否则注释里
        // 复述一遍这句话就能把判据喂绿）。
        let stripped: String = body
            .lines()
            .map(str::trim_start)
            .filter(|t| !t.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let flat_no_comment = code_flat(&stripped);
        assert_eq!(
            flat_no_comment.matches("db::update_group_file_recipient(").count(),
            2,
            "recipient 终态写入必须恰好两处（失败一处 + 成功一处）；四个失败出口各写一遍就是漏改 SHA 那格的成因"
        );
        assert_eq!(
            flat_no_comment.matches("db::upsert_transfer(").count(),
            2,
            "file_transfers 终态写入必须恰好两处 —— 少一处就意味着某种失败把那一行永远留在 active"
        );

        // 真正干活的那一份：三件慢活都还在，而且它拿不到接收表（结构性的，长不回去）
        let core_view = &crate::network::file_src_for_guards();
        let core = rust_fn_body(core_view, "pub fn finish_group_receive_into(");
        let core_flat = code_flat(&core);
        for slow in [".sync_all()", "hasher.clone().finalize()", "std::fs::rename("] {
            assert!(
                core_flat.contains(slow),
                "慢活 {slow} 必须在 finish_group_receive_into 里（挪走≠删掉，掉了它这份文件永远不会落盘）"
            );
        }
        assert!(
            !core_flat.contains("group_file_receivers"),
            "核心函数不得碰 group_file_receivers：一碰就能把接收表的锁写回慢活的作用域"
        );
    }

    /// 续传那格（4.40.1 登记的 ②，2026-10-15 收掉）：**整份 `.part` 前缀的校验必须交给阻塞线程池**。
    ///
    /// 为什么还要单独钉一条：4.39.3 交出的是单聊收尾、4.40.1 交出的是群收尾，而 Offer 分支里
    /// `from_bytes > 0` 那一格一直没动 ⇒ "传到九成断链、对端来续传"时接收端仍会在几秒到几十秒里
    /// 点什么都没反应（同一个 runtime 上还排着所有 async 开窗命令）。本机实测这条流式 SHA-256
    /// ≈ 1 GB/s（256 MiB / 0.26 s，`python hashlib` 同分块尺寸现量），3 GB 前缀就是约 3 秒；
    /// 精简 Windows 的冷盘上还要再乘一次读。
    ///
    /// 判据钉形状不钉行为：单元层拿不住"真实 GB 级文件 + 计时 + 看窗口点不点得动"，
    /// 而形状一旦退化成同步调用，表现就是"续传时界面僵一下"，回查成本极高（同上一条守卫的理由）。
    #[test]
    fn resume_prefix_hash_runs_off_the_async_worker() {
        let view = &crate::network::transport_src_for_guards();
        let body = rust_fn_body(view, "async fn handle_file_messages(");
        // 注释不计入判据（否则注释里复述一遍这句话就能把守卫喂绿）
        let stripped: String = body
            .lines()
            .map(str::trim_start)
            .filter(|t| !t.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let flat = code_flat(&stripped);

        // ★ 慢活整体交给阻塞线程池（写回成就地调用 = 把整份前缀哈希重新钉回 tokio worker）
        assert!(
            flat.contains("tokio::task::spawn_blocking(move||{file::resume_receive("),
            "续传的整份前缀校验必须整体交给 spawn_blocking"
        );
        // 旧的同步形状不许回来
        assert!(
            !flat.contains("letreceived=iffrom_bytes>0{file::resume_receive("),
            "旧的同步续传形状不许回来"
        );

        // 位置判据：交出的是**续传那一格**，不是随便某一格（两格对调不改变出现次数，
        // 所以只数个数会漏 —— 这条与 4.40.2 那条"现取 socket"的教训同一种病）。
        let at = flat.find("letreceived=iffrom_bytes>0{");
        let arm_end = flat.find("}else{file::begin_receive(");
        let bl = flat.find("tokio::task::spawn_blocking(");
        let awaited = flat.find(".await.unwrap_or_else(|e|Err(format!(");
        assert!(
            at.is_some() && arm_end.is_some() && bl.is_some() && awaited.is_some(),
            "判据锚点缺失（护栏需要同步更新）: if={at:?} else={arm_end:?} blocking={bl:?} await={awaited:?}"
        );
        let (at, arm_end, bl, awaited) = (at.unwrap(), arm_end.unwrap(), bl.unwrap(), awaited.unwrap());
        assert!(
            bl > at && bl < arm_end,
            "spawn_blocking 必须就在续传那一格里（续传臂起点 {at}、臂尾 {arm_end}、实得 {bl}）：\
             挪去新建接收器那一臂就是把没哈希的那一格交出去、而真正哈希的那格留在 worker 上"
        );
        assert!(
            awaited > bl && awaited < arm_end,
            "线程池的结果必须在续传臂内被接住（{bl} → {awaited} → 臂尾 {arm_end}）"
        );
        // JoinError 不许被当成成功：假装收到 Ok 会**回 Accept 却没注册接收器** ⇒ 整单静默死掉
        assert!(
            flat.contains(".await.unwrap_or_else(|e|Err(format!("),
            "线程池中断必须落成 Err 走拒绝出口，不许 unwrap_or(Ok(..)) 假装成功"
        );

        // 生产调用点按数量说话（两个家必然漂移，与上面那两条守卫同一条规矩）
        assert_eq!(
            flat.matches("file::resume_receive(").count(),
            1,
            "续传只许有一个生产调用点"
        );
        assert_eq!(
            flat.matches("file::begin_receive(").count(),
            1,
            "新建接收器同理只许一个调用点"
        );

        // ★ 反面的一半：被交出去的那份活儿**不许被删掉**。有人把守卫判绿的最短路径是
        // 干脆不校验前缀（哈希器换成空的）—— 那会让"前缀被外部改过"永远查不出来。
        let file_view = &crate::network::file_src_for_guards();
        let core = rust_fn_body(file_view, "pub fn resume_receive(");
        // 这一份**也必须去注释**：那句"这曾经是 std::fs::read(&tmp_path)"就写在注释里，
        // 带着注释跑反面判据会当场假红（而正面判据带着注释则会假绿 —— 两个方向都得防）。
        let core_stripped: String = core
            .lines()
            .map(str::trim_start)
            .filter(|t| !t.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let core_flat = code_flat(&core_stripped);
        for keep in ["letmutbuf=vec![0u8;FILE_CHUNK];", "h.update(&buf[..n]);"] {
            assert!(
                core_flat.contains(keep),
                "续传必须**逐块**把前缀喂进校验器（缺 `{keep}`：整份读入会占满内存，不读就是放行改过的前缀）"
            );
        }
        assert!(
            !core_flat.contains("std::fs::read(&tmp_path)"),
            "不许退回整份读进内存的那一版（GB 级前缀 = 等量内存峰值）"
        );
    }

    /// 群文件收尾的三处写库必须**先在同一个事务里**，事务失败时**必须留痕**再退回逐句补写
    /// （2026-10-15 全链路审计 ⑥）。
    ///
    /// 旧形状：`update_group_file_recipient` / `upsert_transfer` / `content::store::record_local`
    /// 三处各自 `let _ =` / `.ok()` 吞错 ⇒ 内容台账那一行**可能根本没被构造**，而对账扫
    /// （`outbox_sweep.rs::list_reconcilable_content`）的谓词要求 `content_transfers` 已有一行
    /// 且 `path IS NULL` ⇒「行没写成」这一格**没有兜底**：盘上有文件、台账不知道，这台不算种子。
    ///
    /// 为什么不是「失败就整体不动」：收件方与 `file_transfers` 不收口会把气泡停在
    /// 「文件已在盘上但永不完成」的中间态（指令 §3.2.C），那一格只能靠重启恢复 ⇒ 用新故障修旧故障。
    ///
    /// 为什么是源码护栏：这段收尾吃 `Arc<AppState>`（要真实 tauri `AppHandle`），单测造不出来
    /// ⇒ 与本文件 `group_receive_finalize_slow_work_runs_off_the_async_worker` 同一条先例。
    /// 窗口按两条注释锚切，不用定长窗口（2026-10-15 护栏纪律：定长会跨进邻规则）。
    #[test]
    fn group_receive_finalize_writes_three_ledgers_in_one_transaction_with_logged_fallback() {
        let src = crate::network::transport_src_for_guards();
        let start = src
            .find("// 全部成功：正式文件已落盘")
            .expect("找不到群收尾锚点（这条护栏会空转）");
        let end = src[start..]
            .find("group_file_keys")
            .map(|i| start + i)
            .expect("群收尾之后找不到 group_file_keys（边界变了，护栏需同步）");
        let body = &src[start..end];
        let flat: String = body.chars().filter(|c| !c.is_whitespace()).collect();

        // ① 三处写只有**一份**（闭包），事务与失败补写共用 ⇒ 补写不会和事务里那半边漂开
        assert!(
            flat.contains("letwrite_ledgers=|conn:&rusqlite::Connection|->rusqlite::Result<()>{"),
            "三张台账的写必须收成一个闭包（两份手写迟早少一张表）"
        );
        for w in [
            "db::update_group_file_recipient(",
            "db::upsert_transfer(",
            "crate::content::store::record_local(",
        ] {
            assert_eq!(
                flat.matches(w).count(),
                1,
                "{w} 在这个块里只许一份；两份 ⇒ 又回到「手写两遍迟早漂开」"
            );
        }
        // ② 这一份先整体进事务，并且**必须显式提交**（要么三张表一起收口，要么一起不动）。
        // rusqlite 的 `Transaction::new_unchecked` 把 `drop_behavior` 初始化为 `Rollback`
        // （锁定版 rusqlite 0.31.0 `src/transaction.rs:127`）⇒ 少了 `tx.commit()` 时闭包末尾
        // 一 drop 就整段回滚，而 `and_then` 仍返回 `Ok` ⇒ 下面的 Err 分支永不触发 ⇒ 三张台账
        // 一句都没落库却「看起来成功」。单聊那一家（`network/file/receive.rs`）闭包末尾就有 commit。
        assert!(
            flat.contains("letwrote=dbc.transaction().and_then(|tx|{write_ledgers(&tx)?;tx.commit()})"),
            "群收尾三处写必须包在同一个事务里并显式 commit：不 commit ⇒ 默认 drop 即回滚，wrote 仍是 Ok ⇒ 补写分支永不触发"
        );
        // ③ 失败必须留痕，且只许这一格留痕。两条探针分开：Err 分支里注释写在 `warn(` 之前，
        //    而去空白**不去注释** ⇒ 跨注释的形状判不了（护栏纪律第 48 条的反面）。
        assert!(
            flat.contains("ifletErr(e)=wrote{"),
            "事务结果必须有失败分支：没有 ⇒ 写库失败仍然静默"
        );
        assert!(
            flat.contains("state.logger.warn(\"group_file\""),
            "事务失败必须打一条 warn：否则「文件收下了但没人能从我这里拉」在日志里没有任何形状"
        );
        assert_eq!(
            body.matches(".warn(").count(),
            1,
            "群收尾只许给事务失败那一格留痕（多了就是又给常态收尾打日志）"
        );
        // ④ 反证：旧的静默形状不许回来
        assert!(!flat.contains(".ok();"), "群收尾块里不许再有 `.ok()` 吞错");
        // ⑤ 事务失败后仍要落一次写：补写必须在 warn 之后（= 挂在 Err 分支里，不是被删）
        let warn_at = flat
            .find("state.logger.warn(\"group_file\"")
            .expect("失败留痕必须存在");
        let fb_at = flat
            .find("let_=write_ledgers(&dbc)")
            .expect("事务失败的补写不许被删（删 ⇒ 事务一失败就永不收口，气泡停在中间态）");
        assert!(warn_at < fb_at, "补写必须在 warn 之后、Err 分支之内");
    }
