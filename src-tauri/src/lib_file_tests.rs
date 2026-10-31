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
/// 取消的**结局**必须有具名码（审计 B1-F1）。
///
/// 原状：群消息取消从 v1 起就有 `code=GROUP_CANCEL`，而 1:1 消息 / 文件 / 更新这三条通道
/// **只有失败码**，取消的正常结局与竞态拒绝一条行都没有。于是用户报「我明明点了取消、
/// 对方还是收到了」时，诊断包里没有任何东西能区分「竞态（already_delivered）」
/// 「没点到（not_found）」「真取消了」—— 而这三者的处理方式完全不同。
///
/// 判据按通道取**函数体**（`rust_fn_body`），只钉"这一格里必须出现这个码"；
/// 挂错文件由"找不到函数名"当场红。变异：删掉任一行 ⇒ 对应那格红。
#[test]
fn every_cancel_channel_leaves_a_named_outcome() {
    let dm = rust_fn_body(include_str!("commands/chat.rs"), "pub async fn cancel_message(");
    assert!(
        dm.contains("code=DM_CANCEL msg_id="),
        "1:1 消息取消的结局没有码 ⇒ 「点了取消、对方还是收到了」时查不出是竞态还是没点到"
    );
    // 群侧那一行早就有：别为了"统一命名"把它删掉。
    assert!(
        dm.contains("code=GROUP_CANCEL"),
        "群消息取消的 `code=GROUP_CANCEL` 不许丢（它是这条通道最早的那一行）"
    );

    let file = rust_fn_body(
        include_str!("commands/files.rs"),
        "pub async fn cancel_file_transfer(",
    );
    assert!(
        file.contains("code=FILE_CANCEL transfer="),
        "文件取消的结局没有码 ⇒ 分不清「真取消了」「早就传完了」「通知没发出去」"
    );

    // `updater_cancel` 在 `mod desktop` 的 `impl` 里（`rust_fn_body` 的收尾锚点只认列 0 的
    // `}`），所以这一格用**计数**：两种结局各一行（安装中被拒 / 真的取消）。
    // ⚠️ 针头带上后面那半（`outcome=`）而不是只到码名：`matches` 是子串计数，
    //    只认前缀的话 `code=UPDATER_CANCEL_X` 也会被算成一行（实测过）。
    let updater = include_str!("commands/updater.rs");
    assert_eq!(
        updater.matches("code=UPDATER_CANCEL outcome=").count(),
        2,
        "更新取消的两种结局各要一行（refused_installing / cancelled），少了哪种都查不出来"
    );
}

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

/// P3-05：整轮超时会把内层 future 丢掉，Offer 等待者的清理分支不会执行 ⇒ 外层必须
/// 无条件再摘一次（键是 transfer_id，下一次重投会重建）。
///
/// B1 换了这段的形状，判据跟着换，**不是放宽**：
///  · 旧写法拿 `cancel_cleanup();` 当"收尾段起点"的位置锚 —— 那个手写闭包已被
///    `install_cancel_slot` 的 RAII 守卫取代（判据 `cancel_slot_has_exactly_one_home`），
///    它本来也管不到"内层 future 被 drop"那一格，正是这次要修的；
///  · 这里剩下的那件事照旧钉：accept 等待者的摘除必须排在整轮 timeout **之后**；
///  · 另加一条反向位置判据：取消槽位必须登记在 timeout 之前，否则哈希与 Offer 等待
///    期间的取消没有接收者（用户点了没反应，文件照发）。
#[test]
fn offer_timeout_clears_the_accept_registration() {
    let f = code_flat(&crate::network::file_src_for_guards());
    let at = f
        .find("timeout(send_deadline,async{")
        .expect("offer 整轮的超时锚点改名/搬家了 ⇒ 同步改这条判据");
    assert!(
        f[..at].contains("install_cancel_slot(state,transfer_id,peer_id)"),
        "取消槽位必须登记在整轮 timeout 之前：哈希/Offer 期间的取消要有接收者，否则静默丢掉"
    );
    assert!(
        f[at..].contains("pending_file_accept.lock()"),
        "超时收尾必须摘掉可能还挂着的 accept 等待者（内层 future 被 drop 时它走不到）"
    );
}

/// 取消槽位的登记与回收**只有一个家**（B1）。
///
/// 三条投递路径原先三种写法：群投递已经是 RAII 守卫，单聊直发与中继直发各手写一个
/// 清理闭包、在函数末尾调一次。闭包那一族的失效形状是这一族反复付过钱的：
/// 外层 `timeout(deadline, async {…})` 触发时内层 future 被直接 drop，函数末尾那句
/// 照样执行 ⇒ 槽位残留、表单调增长；而同键的下一次 `insert` 把残留 `Sender` 挤掉，
/// 对方的 rx 当场以 `Err(RecvError)` 完成 ⇒ 下一次投递"一进来就被取消"。
///
/// ⚠️ 用**去掉整行注释**后的文本判定：缺席型判据吃全文的话，任何一句"这里以前写着 X"
/// 的说明都会把自己判红（本仓踩过 —— 注释里的名字不是代码里的名字）。
#[test]
fn cancel_slot_has_exactly_one_home() {
    let code_only = |src: &str| -> String {
        src.lines()
            .map(str::trim_start)
            .filter(|t| !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*')))
            .flat_map(|t| t.chars().filter(|c| !c.is_whitespace()))
            .collect()
    };
    let file_src = code_only(&crate::network::file_src_for_guards());
    let dispatch = code_only(include_str!("commands/group_file_dispatch.rs"));
    assert_eq!(
        file_src.matches("fninstall_cancel_slot").count(),
        1,
        "登记 + 回收的那个家必须恰好一个实现（出现第二个就是同一件事两个口径）"
    );
    // 三个调用点：单聊直发、中继直发、群投递（定义那处带 `state:` 不是 `state,`，不计入）。
    assert_eq!(
        file_src
            .matches("install_cancel_slot(state,transfer_id,")
            .count(),
        2,
        "单聊直发与中继直发都必须由这个家登记（少一处就是那条路径还自己手写一份）"
    );
    assert!(
        dispatch.contains("install_cancel_slot(state,transfer_id,recipient)"),
        "群投递必须由同一个家登记，键仍按收件人"
    );
    assert!(
        !dispatch.contains("CancelSlotGuard"),
        "群投递不许再自带一份取消槽守卫：守卫只有一个家"
    );
    for (name, src) in [
        ("network/file.rs（send + relay_push）", file_src.clone()),
        ("commands/group_file_dispatch.rs", dispatch.clone()),
    ] {
        assert!(
            !src.contains("cancel_cleanup"),
            "{name} 的代码里不许再出现手写清理：整轮超时丢掉内层 future 时它走不到"
        );
    }
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
    // B1 起登记与键都收进了那个唯一的家，所以两头一起钉：调用方必须把 recipient 传进去，
    // 家内部必须用 `file_cancel_key(transfer_id, recipient)` 成键。只钉一头的话，
    // "调用方传了 recipient 但家里改回裸 id"或"键正确但某条路径不走家"都能溜过去。
    let dispatch = code_flat(include_str!("commands/group_file_dispatch.rs"));
    let fanout = code_flat(include_str!("commands/group_announcements.rs"));
    let file_src = code_flat(&crate::network::file_src_for_guards());
    assert!(
        dispatch.contains("install_cancel_slot(state,transfer_id,recipient)"),
        "群投递的取消登记必须带 recipient（否则同 transfer_id 的任务互相挤掉登记）"
    );
    assert!(
        file_src.contains("letkey=file_cancel_key(transfer_id,recipient)"),
        "取消登记的家必须按 (transfer_id, recipient) 成键"
    );
    assert!(
        !dispatch.contains(".insert(transfer_id.to_string(),cancel_tx)"),
        "不得回退成 transfer_id 单键"
    );
    assert!(
        !dispatch.contains(".insert(transfer_id.to_string(),"),
        "群投递不许自己往任何内存表按裸 transfer_id 登记取消槽"
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

/// 续传分支（`attempt.is_some()`）也必须建接收气泡。
///
/// 旧路径只在 `attempt=None` 的老路里建；续传分支跳过时，接收端在**整段传输期间没有卡片**，
/// 完成时 `update_message_content` 因为 `messages` 行不存在而落空（DB 里永远没有那一行）。
/// `insert_message` 是 `INSERT OR IGNORE` ⇒ 两处都调用是幂等的。
#[test]
fn resume_branch_creates_the_receive_bubble() {
    let src = include_str!("network/transport/group_file.rs");
    let body = rust_fn_body(src, "async fn handle_group_file_offer(");
    let flat = code_flat(&body);
    assert_eq!(
        flat.matches("create_group_file_receive_bubble(").count(),
        2,
        "旧路径 + 续传分支必须各建一次气泡（少一处就是接收端整段没有卡片）"
    );
    let at = flat
        .find("if!ensure_group_file_row(")
        .expect("续传分支的 ensure_group_file_row 锚点失效");
    let after = &flat[at..];
    assert!(
        after.find("create_group_file_receive_bubble(").is_some(),
        "续传分支在 ensure_group_file_row 之后必须建气泡"
    );
}

/// 群文件会话密钥的 2h TTL 只能清"死单"：Offer 命中、每一片、发送端每片都要刷新 `at_ms`。
/// 否则大文件（BLE / 多轮重试 > 2h）传到一半 key 被清扫，分片在 handler 里静默 return。
#[test]
fn active_group_file_transfers_refresh_the_key_ttl() {
    let src = crate::network::transport_src_for_guards();
    let offer = rust_fn_body(&src, "async fn handle_group_file_offer(");
    assert!(
        code_flat(&offer).contains("touch_group_file_key(&transfer_id)"),
        "Offer 命中已有 key 时必须刷新 TTL"
    );
    let chunk = rust_fn_body(&src, "async fn handle_group_file_chunk(");
    assert!(
        code_flat(&chunk).contains("touch_group_file_key(&transfer_id)"),
        "每个分片都必须刷新 TTL（长传输不能被 2h 清扫器收走）"
    );
    let dispatch = code_flat(include_str!("commands/group_file_dispatch.rs"));
    assert!(
        dispatch.contains("touch_group_file_key(transfer_id)"),
        "发送端分片循环也必须刷新 TTL"
    );
}

/// 拍板 4A(8)：群文件投递的并发闸必须在**传输调度层**（两条投递路径的唯一入口
/// `dispatch_group_file_to_peer`），而不是命令层的"起几个任务"。
///
/// 两件事一起钉：
///   ① 闸是 `acquire().await`（**无损等待**）——`try_acquire` 会在满时直接失败，
///      等于"排队=丢文件"，违反"文件完整性不得为省资源静默降级"；
///   ② fan-out **不得提前写 `sending`**：投递任务可能还在闸后面排队，提前写会让
///      10 分钟的 stale-sending 清扫器把排队成员当卡死重投 ⇒ 同一成员两个任务。
#[test]
fn group_file_send_concurrency_is_gated_at_the_scheduler() {
    assert_eq!(
        crate::state::MAX_CONCURRENT_GROUP_FILE_SENDS,
        8,
        "拍板值就是 8（改它要重新做内存峰值/吞吐实测）"
    );
    let dispatch = code_flat(include_str!("commands/group_file_dispatch.rs"));
    assert!(
        dispatch.contains("group_file_permits.acquire()"),
        "并发闸必须由唯一投递入口在调度层获取（群发与离线补发都走它）"
    );
    assert!(
        !dispatch.contains("group_file_permits.try_acquire"),
        "闸必须无损等待：满了不许直接失败/丢文件"
    );
    let fanout = code_flat(include_str!("commands/group_announcements.rs"));
    assert!(
        !fanout.contains("update_group_file_recipient(&dbc,&transfer_id,m,\"sending\",0.0)"),
        "排队中的成员必须保持 pending —— 提前标 sending 会被 stale 清扫器当卡死重投"
    );
    // 状态行不再是去重闸（排队时它必须是 pending）⇒ 必须有按成员的内存在途闸，
    // 覆盖 fan-out 与离线补发两条入口；行为面由 `network::file::tests::
    // group_file_dispatch_gate_is_per_member_and_releases_on_drop` 钉住。
    assert!(
        dispatch.contains("GroupFileDispatchGuard::try_acquire"),
        "并发闸的配套：同一 (transfer, recipient) 的在途去重不能丢"
    );
    // 续传回执槽位也必须 RAII 回收：外层 deadline 在等回执期间触发时 future 被 drop，
    // 手写 remove 走不到 ⇒ 每次重投漏一个等待者（与 P2-02 同一族）。
    assert!(
        dispatch.contains("ResumeWaiterGuard"),
        "续传回执槽位必须有 RAII 守卫"
    );
    assert!(
        !dispatch.contains("remove(&waiter_key)"),
        "不得回到手写 remove：超时/取消路径走不到"
    );
    // 取消槽位必须在**并发闸之前**登记：排队期间点"取消发送"时，信号才有接收者。
    // 顺序用位置判（两处都在，但挪回闸后时数量不变、只有顺序变）。
    // B1 起登记走那个唯一的家（`file::install_cancel_slot`），键仍按收件人。
    let cancel_at = dispatch
        .find("file::install_cancel_slot(state,transfer_id,recipient)")
        .expect("取消登记不见了");
    let gate_at = dispatch
        .find("group_file_permits.acquire()")
        .expect("并发闸不见了");
    assert!(
        cancel_at < gate_at,
        "取消登记必须排在并发闸之前（否则排队期间的取消被静默丢掉）"
    );
    assert!(
        !dispatch.contains("file_send_cancels"),
        "群投递不许直接碰取消表：登记与回收只有 install_cancel_slot 一个家"
    );
}

/// 群投递的取消闸门必须排在**并发闸之前**，并且两头都读（B2）。
///
/// 为什么用位置判而不是数量判：任务可能在 `group_file_permits.acquire().await` 后面排队
/// 几十秒（200 成员群 + 8 路并发），闸门若排在拿到许可之后，**取消发生在排队期间的那一次**
/// 会照常把整份文件发出去 —— 用户看到的就是"按了取消没反应"。两处代码都在、数量不变、
/// 只有顺序变，所以只有位置判据抓得到。
///
/// 两条变异用例各证一格（"有断言"不等于"被证明会失败"）：
///  · 把 `if cancelled_here {` 短路成 `if false {` ⇒ 第一个 `.expect` 就红（闸门不再是闸门）；
///  · 把整单那一半判据换成恒 `false` ⇒ "闸门必须先看整单"那一格红。
#[test]
fn group_file_cancel_gate_is_checked_before_the_permit() {
    let dispatch = code_flat(include_str!("commands/group_file_dispatch.rs"));
    let gate_at = dispatch
        .find("ifcancelled_here{")
        .expect("取消闸门不见了 ⇒ 排队期间的取消没人拦（本条判据的锚点失效）");
    let permit_at = dispatch
        .find("group_file_permits.acquire()")
        .expect("并发闸不见了");
    assert!(
        gate_at < permit_at,
        "取消闸门必须排在并发闸之前（拿到许可那一刻，文件已经开始发了）"
    );
    // 两头都要判：只判整单会漏"这一格被单独取消过"，只判这一格会漏"整单已取消而成员行
    // 由另一条路（离线补发）写进来"。
    assert!(
        dispatch.contains("is_group_file_cancelled(&dbc,transfer_id)"),
        "闸门必须先看整单是否已取消"
    );
    assert!(
        dispatch.contains("is_group_file_recipient_cancelled(&dbc,transfer_id,recipient)"),
        "闸门必须先看这一格是否已取消"
    );
    // 命中闸门时必须走 Cancelled 那一档，不是 Retryable/Unrecoverable（否则台账落 failed）
    let after_gate = &dispatch[gate_at..];
    assert!(
        after_gate.contains("GroupFileSendErr::Cancelled"),
        "闸门退出必须回报 Cancelled —— 落 failed 就是「取消记成失败」那条旧缺陷"
    );
}

/// 发送进度必须落在"已写出链路"上，不许回到"已入队"（v4.22.37 的用户可见症状）。
///
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
    let at = body
        .find("重复 FileDone")
        .expect("文件族里那段「重复 FileDone」判据注释不见了 ⇒ 这条守卫的区域锚点失效");
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
        flat.contains("Message::FileCompleteAck{transfer_id,success:false,}") || {
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
        // 5.15.40：这一支会 emit ⇒ 载荷改成了码（`FILE_RECEIVE_SOURCE_MISMATCH`）；
        // 判据的意图不变：**塞回去必须留在锁内**（`recv.insert(..)` 与 return 在同一个块里）。
        flat.contains("returnErr(crate::logging::FAIL_CODE_FILE_RECEIVE_SOURCE_MISMATCH.to_string());}"),
        "找不到来源不符分支 —— 护栏需要同步更新"
    );
    // 摘出来的那份接收器必须**交给核心**，不是就地收尾（就地收尾 = 慢活回到锁的同一作用域）
    assert!(
        flat.contains("finish_receiver_into(&st.db,&st.logger,&tid_for_task,r)"),
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
                "tokio::task::spawn_blocking(move||{file::finish_group_receive_into(r,&st_for_finalize.logger)})"
            ) || flat.contains(
                "tokio::task::spawn_blocking(move||file::finish_group_receive_into(r,&st_for_finalize.logger))"
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
    // `place_unique` 是收尾那一步的**新家**（审计 P2 #42：硬链接原子占名，替掉
    // `exists()`+`rename` 的覆盖窗口）。它仍是同步文件操作，必须留在同一个阻塞闭包里 ——
    // 所以这里钉的是"落盘这一步在这个函数里"，而不是某个具体系统调用的字面量。
    for slow in [
        ".sync_all()",
        "hasher.clone().finalize()",
        "place_unique(",
    ] {
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

// ---------------- B3：`FileCancel` 帧（对端真的知道这一单不再继续了） ----------------
//
// 这一族三格各管一件事，缺任何一件都会有一种**静默**的坏法：
//  · 漏路由 ⇒ 帧被 transport.rs 的 match 丢掉，编译照过、现场"我取消了，对面还在发"；
//  · 处理臂排在 `_ => {}` 之后 ⇒ 死代码，症状与漏路由一模一样；
//  · 臂体里自己抄一份收尾 ⇒ 两处口径迟早漂移（这正是 B1 之前那四行墓碑注释撒谎的形状）。

/// 路由与位置：新帧必须被 **接住**，而且接它的那条臂必须在 catch-all 之前。
///
/// 两次失败形状长得分不开：分发臂漏了它 ⇒ 帧在 transport 就被丢；分册漏了它 ⇒
/// 帧掉进这册末尾的 `_ => {}` 静默丢弃。两种都编译照过、都表现为"我取消了，对面还在发"。
#[test]
fn file_cancel_frame_is_routed_and_not_after_the_catch_all() {
    let transport = code_flat(&crate::network::transport_src_for_guards());
    assert!(
        transport.contains("Message::FileCancel{..})=>handle_file_messages"),
        "FileCancel 没进 transport 的路由表 ⇒ 它在那层就被丢掉（假绿，不是假红 —— 更危险的那种）"
    );
    // 只在**函数体内**比位置：本册文件头那段说明里就写着 `_ => {}`，
    // 拿整份文件去找第一个 catch-all 会落在注释上（判据自己骗自己，实测就这么红的）。
    let body = rust_fn_body(
        include_str!("network/transport/handle_file.rs"),
        "async fn handle_file_messages(",
    );
    let arm_at = body
        .find("Message::FileCancel { transfer_id, from } =>")
        .expect("handle_file 里没有 FileCancel 的处理臂 ⇒ 这一帧今天没人接");
    // `rfind` 而不是 `find`：函数体**开头**那两行说明里就写着 `_ => {}`
    // （"这层 match 的 `_ => {}` 不是吞消息"），`find` 会先撞上注释、把位置判据倒过来。
    // 外层那条 catch-all 恒在末尾 ⇒ 取最后一次出现才是它。
    let catch_at = body
        .rfind("_ => {}")
        .expect("这册的 catch-all 不见了 ⇒ 本测试的锚点失效（位置判据没有作用点了）");
    assert!(
        arm_at < catch_at,
        "处理臂排在 catch-all 之后就是死代码：症状与漏路由完全一样（取消静默失效）"
    );
}

/// 收尾只有一个家：对端取消与用户取消共用 `apply_local_cancel`，臂体里不许再抄一份。
#[test]
fn file_cancel_and_user_cancel_share_one_local_home() {
    let cmds = all_commands_src();
    assert_eq!(
        cmds.matches("pub(crate) async fn apply_local_cancel(").count(),
        1,
        "「本机按已取消收尾」必须只有一个家（第二个家就是下一处口径漂移的起点）"
    );
    let body = rust_fn_body(
        include_str!("network/transport/handle_file.rs"),
        "async fn handle_file_messages(",
    );
    let arm_at = body
        .find("Message::FileCancel { transfer_id, from } =>")
        .expect("处理臂不见了 ⇒ 本测试的锚点失效");
    let catch_at = body.rfind("_ => {}").expect("catch-all 不见了 ⇒ 锚点失效");
    // 只取**这一条臂**：整册里别的臂本来就要 emit，拿整册当作用点会把它当成违规。
    let arm = &body[arm_at..catch_at];
    assert!(
        arm.contains("crate::commands::apply_local_cancel(state, &transfer_id, \"peer\")"),
        "对端取消必须复用同一个收尾入口；`by` 只进日志，不新增状态、不新增列"
    );
    // ⚠️ 第三个 needle 刻意写成 `app.emit`（不带左引号）：`src/api/events` 那条
    // "每个后端事件都要有前端消费者"的守卫会从 Rust 源码里抠 `emit("…"` 的形状，
    // 测试里写一个**没有收尾引号**的 `emit("` 会让它把后面几百行当成一个事件名
    // （实测报出的"事件"是一段源码）。判据文本自己不能把别人的量具带偏。
    for forbidden in ["finalize_file_failure(", "mark_file_outbox_", "app.emit"] {
        assert!(
            !arm.contains(forbidden),
            "FileCancel 这条臂里不许出现 {forbidden}：终态与 emit 都属于那一个家，两处各写一遍就是漂移"
        );
    }
    // 取消槽位的直接读写也只有一个家（`signal_cancel_slots` / 登记 / 守卫回收三处都在 file.rs）。
    // 数的是**读写点**而不是名字：needle 带着 `.lock()`，注释里那句"点亮 `file_send_cancels`"
    // 不会被误数成一次读写（现成的 `code_flat` 只剥空白，够用）。
    assert_eq!(
        code_flat(&crate::network::file_src_for_guards())
            .matches(".file_send_cancels.lock()")
            .count(),
        4,
        "槽位的登记 / 整单点亮 / 单格点亮（B3b 按成员取消）/ 回收必须在同一个文件里（现算四处）；多出来的那处就是第二个家"
    );
    assert_eq!(
        code_flat(cmds).matches(".file_send_cancels.lock()").count(),
        0,
        "命令层不许再自己扫这张表：点亮槽位只走 `file::signal_cancel_slots`"
    );
}

/// 通知那一半：门控必须存在，而且它**不许挡住**本机自己的收尾。
#[test]
fn file_cancel_notice_is_gated_and_never_blocks_the_local_cancel() {
    let cmds = all_commands_src();
    let notify = rust_fn_body(cmds, "async fn send_cancel_notice(");
    // 门控只有一个家：`peer_declares_file_cancel`。通知那三种形状必须**逐条**先问它 ——
    // 少问一条就是"某一种取消会对老端发新帧"（INV-P24 第 4 条），而其余两条照旧。
    assert_eq!(
        notify.matches("peer_declares_file_cancel(s,").count(),
        3,
        "1:1 / 群成员逐个 / 群接收方→发送方，三种通知都要各自过门控"
    );
    let gate = rust_fn_body(cmds, "fn peer_declares_file_cancel(");
    assert!(
        gate.contains("CONTENT_FEATURE_FILE_CANCEL"),
        "门控函数里必须读那一位（INV-P24 第 4 条：不门控不许发）"
    );
    // 「没记过账的单不许通知」这一条搬进了 `plan_cancel_notice`：两本账都查不到就返回 None
    // （群文件那一步的 `?` 就是这个意思）。发给一个猜出来的对端比不发更糟。
    let plan = rust_fn_body(cmds, "fn plan_cancel_notice(");
    assert!(
        plan.contains("db::get_transfer_route(") && plan.contains("db::get_group_file(&dbc, transfer_id)?"),
        "通知名单必须从两本台账里读出来；两本都没有 ⇒ None（不许凭空造一个对端）"
    );
    // 顺序判据：先落本机终态，再发通知 —— 反过来就是"通知的 await 挡住了取消的响应"
    let body = rust_fn_body(cmds, "pub async fn cancel_file_transfer(");
    let cancel_at = body
        .find("apply_local_cancel(s, &transfer_id, \"user\")")
        .expect("取消命令必须调用本机收尾那个家");
    let notify_at = body
        .find("send_cancel_notice(s, &transfer_id, notice)")
        .expect("取消命令必须通知对端（声明过能力位的话）");
    assert!(
        cancel_at < notify_at,
        "本机收尾必须先于通知：取消的界面响应不能等一次网络 await"
    );
}

/// B3b：按成员取消那一帧的三件事 —— 路由接住、臂可达、**只动这一格**。
///
/// 第三件是这条帧与"整单取消"最容易混淆的地方：发送方取消一条群文件是每个成员各一条
/// （`signal_cancel_slots` / `cancel_group_file_recipients`），而"某个成员不收了"必须
/// 只命中 `(transfer_id, 这个成员)` —— 用整单那一对函数会让其余成员一起停。
#[test]
fn group_file_cancel_is_routed_handled_and_scoped_per_recipient() {
    let transport = code_flat(&crate::network::transport_src_for_guards());
    // 群那一族是一条 `m @ (A | B | … ) => handle_group_messages(…)` 或模式，变体之间用 `|` 相连，
    // 所以判"在不在这一族里"只能查**变体本身**是否出现在路由视图里；"它真的被接住"由下面
    // 臂体位置 + `dispatch_arms_and_volume_arms_agree`（两侧逐一对应，含数量）共同钉住。
    assert!(
        transport.contains("Message::GroupFileCancel{..}"),
        "GroupFileCancel 没进 transport 的路由视图 ⇒ 它在那层就被丢掉（帧发了等于没发）"
    );
    let arms = include_str!("network/transport/handle_group.rs");
    let body = rust_fn_body(arms, "async fn handle_group_messages(");
    let arm_at = body
        .find("Message::GroupFileCancel {")
        .expect("handle_group 里没有 GroupFileCancel 的处理臂 ⇒ 这一帧今天没人接");
    let catch_at = body.rfind("_ => {}").expect("catch-all 不见了 ⇒ 锚点失效");
    assert!(
        arm_at < catch_at,
        "处理臂排在 catch-all 之后就是死代码：症状与漏路由一样（取消静默失效）"
    );
    let arm = &body[arm_at..catch_at];
    assert!(
        arm.contains("handle_group_file_cancel("),
        "臂体必须把这件事交给群文件那一册（判定与落库都在那儿）"
    );

    let handler = rust_fn_body(
        include_str!("network/transport/group_file.rs"),
        "pub(crate) async fn handle_group_file_cancel(",
    );
    assert!(
        handler.contains("file::signal_cancel_slot("),
        "发送方那一侧必须点亮**单格**槽位（`signal_cancel_slot`）"
    );
    assert!(
        handler.contains("db::cancel_group_file_recipient("),
        "那时必须只落这一格（`cancel_group_file_recipient`）"
    );
    for whole in ["signal_cancel_slots(", "cancel_group_file_recipients("] {
        assert!(
            !handler.contains(whole),
            "这条帧不许碰整单那一对（{whole}）：一个成员不收了，其余成员还要继续收"
        );
    }
    assert!(
        handler.contains("recipient != from"),
        "发送方只接受**本人**说「我不收了」：别人不能替他取消"
    );
    assert!(
        handler.contains("file::cancel_group_receive("),
        "接收方那一侧必须停掉自己的接收器（否则界面说取消了、`.part` 还在写）"
    );
}

/// 取消结果里那个 `notifiedPeer` 必须是**真事实**，不是常量（B3 的界面口径）。
///
/// 为什么这条值得单独钉：界面靠它决定说"已取消"还是"仅本机已取消"。如果它恒为 false，
/// 用户永远看不到"已取消"（功能看起来坏了）；恒为 true 则又说满了（老端还在传）。
/// 三处必须连成一条链：`send_cancel_notice` 返回 bool → 命令把它回填 → 结构体带 camelCase 字段。
#[test]
fn file_cancel_reports_whether_the_peer_was_actually_notified() {
    let cmds = all_commands_src();
    assert!(
        cmds.contains("pub notified_peer: bool"),
        "FileCancelResult 必须带 notified_peer 这一格（界面据此选文案）"
    );
    let cmd = rust_fn_body(cmds, "pub async fn cancel_file_transfer(");
    assert!(
        cmd.contains("res.notified_peer = send_cancel_notice(s, &transfer_id, notice).await"),
        "命令必须把通知那半的结论回填到结果里；写死一个常量就是界面在猜"
    );
    let notice = rust_fn_body(cmds, "async fn send_cancel_notice(");
    assert!(
        notice.contains("-> bool"),
        "send_cancel_notice 必须回报「有没有真的发出去」"
    );
    // 三个分支都要有结论：没台账/未声明/发送失败 ⇒ false；发成功 ⇒ true。
    assert!(
        notice.matches("return false").count() >= 1 && notice.matches("true").count() >= 2,
        "分支结论缺了：至少要有「不通知 ⇒ false」与「发成功 ⇒ true」两处"
    );
}

/// 按 cid 取消内容拉取（2026-10-25 Stage 4）：三件顺序与口径都必须钉住。
///
/// ① 只认**接收方向**的行：发送方向的台账是"本机是源"，按 cid 取消会把对端的拉取算成本机的事；
/// ② 先停接收器、再写台账：反过来的话，`cancel_receive` 之后 `record_failure` 会再覆盖一次，
///    而那一次若先落地、接收器还在写 `.part` ⇒ 界面说取消、磁盘还在长；
/// ③ 必须记 `FailReason::Cancelled`：记成 `Partial` 会走 Incomplete，下一次建链的
///    `retry_incomplete_content` 会**自动再把用户刚取消的东西拉一遍**（用户实报过的形状）。
#[test]
fn content_cancel_stops_the_receiver_then_writes_a_cancelled_terminal() {
    let cmds = all_commands_src();
    assert!(
        cmds.contains("pub struct ContentCancelResult"),
        "内容取消必须有结构化结果（already_done / ledger_committed 都要能说出来）"
    );
    let body = rust_fn_body(cmds, "pub async fn cancel_content_fetch(");
    assert!(
        body.contains("r.direction == Direction::Receive"),
        "只认接收方向的行 —— 发送方向的 cid 行不是「本机在拉」"
    );
    let stop_at = body
        .find("crate::network::file::cancel_receive(")
        .expect("必须先停本机接收器（否则 .part 还在写）");
    let ledger_at = body
        .find("record_failure(")
        .expect("必须落内容台账，否则任务中心那一行永远挂着");
    assert!(
        stop_at < ledger_at,
        "顺序反了：台账先落、接收器还在写 ⇒ 界面说取消、磁盘还在长"
    );
    assert!(
        body.contains("FailReason::Cancelled"),
        "必须记 Cancelled（Rejected 终态）：记成 Partial 会被建链的自动重取拉回来"
    );
    assert!(
        body.contains("TransferStatus::Incomplete"),
        "Incomplete 也算 live：用户取消时它还能被自动重取，必须一起收口"
    );
}

/// 图片尺寸只读文件头（PNG/JPEG/GIF/WebP），不引解码库。
/// 这份值写进消息 content 的可选 w/h，供虚拟列表按真实比例预留；读不出就回退 288。
#[test]
fn image_dimensions_reads_common_headers_without_decoding() {
    use crate::network::file::image_dimensions_from_bytes;

    // PNG: 8B 签名 + 4B 长度 + "IHDR" + 宽/高（大端）
    let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    png.extend_from_slice(&320u32.to_be_bytes());
    png.extend_from_slice(&180u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    assert_eq!(image_dimensions_from_bytes(&png), Some((320, 180)));

    // GIF: 逻辑屏幕宽高（小端）
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&640u16.to_le_bytes());
    gif.extend_from_slice(&480u16.to_le_bytes());
    gif.extend_from_slice(&[0, 0, 0]);
    assert_eq!(image_dimensions_from_bytes(&gif), Some((640, 480)));

    // JPEG: SOI → APP0(len 4) → SOF0(h/w)
    let jpeg = [
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00,
        0xB4, 0x01, 0x40, 0x03, 0x01, 0x11, 0x00,
    ];
    assert_eq!(image_dimensions_from_bytes(&jpeg), Some((320, 180)));

    // WebP VP8X: 24 位 w-1 / h-1
    let mut webp = b"RIFF\x00\x00\x00\x00WEBPVP8X\x00\x00\x00\x00".to_vec();
    webp.extend_from_slice(&[0, 0, 0, 0]); // flags/reserved
    webp.extend_from_slice(&[0x3F, 0x01, 0x00]); // 320 - 1
    webp.extend_from_slice(&[0xB3, 0x00, 0x00]); // 180 - 1
    assert_eq!(image_dimensions_from_bytes(&webp), Some((320, 180)));

    // 认不出的格式 / 截断：None（调用方回退 288，不影响正确性）
    assert_eq!(image_dimensions_from_bytes(b"not an image"), None);
    assert_eq!(image_dimensions_from_bytes(b"\x89PNG\r\n\x1a\nshort"), None);
}

/// 真实临时文件 → content JSON 补 w/h；读不出尺寸时**不动**原 JSON（旧口径 288）。
#[test]
fn attach_image_size_keeps_json_shape_when_dimensions_are_unknown() {
    use crate::network::file::{attach_image_size, image_dimensions};
    use std::path::PathBuf;

    let mut path: PathBuf = std::env::temp_dir();
    path.push(format!("gosslan-img-dims-{}.png", std::process::id()));
    let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
    png.extend_from_slice(&320u32.to_be_bytes());
    png.extend_from_slice(&180u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    std::fs::write(&path, &png).expect("write temp png");
    assert_eq!(image_dimensions(&path), Some((320, 180)));

    let mut v = serde_json::json!({ "name": "a.png", "subtype": "image" });
    attach_image_size(&mut v, &path);
    assert_eq!(v["w"], 320);
    assert_eq!(v["h"], 180);

    let missing = path.with_extension("nope");
    let mut untouched = serde_json::json!({ "name": "a.bin", "subtype": "file" });
    attach_image_size(&mut untouched, &missing);
    assert!(untouched.get("w").is_none(), "读不出尺寸时不许凭空写 w");
    assert!(untouched.get("h").is_none(), "读不出尺寸时不许凭空写 h");
    let _ = std::fs::remove_file(&path);
}

/// 群文件的两个入口都必须先过 `safe_transfer_id`，且**在第一次写台账/删文件之前**。///
/// 为什么是源码形状而不是行为用例：`transfer_id` 有两个下游汇点（`cancel_group_receive`
/// 的 fallback 路径、续传 `Restart` 分支的 `remove_file`），两处都直接
/// `downloads.join(format!("{tid}.part"))`。行为用例要造 AppState + 真群 + 群密钥；
/// 而这两个入口是**唯一**的收口点，钉住"入口校验 + 顺序"就够了。
#[test]
fn both_group_file_entries_validate_the_transfer_id_before_any_side_effect() {
    let src = include_str!("network/transport/group_file.rs");
    for (anchor, first_side_effect) in [
        ("async fn handle_group_file_offer(", "upsert_group_file_receive("),
        (
            "pub(crate) async fn handle_group_file_cancel(",
            "cancel_group_receive(",
        ),
    ] {
        let body = code_flat(&rust_fn_body(src, anchor));
        let at = body
            .find("safe_transfer_id(&transfer_id)")
            .unwrap_or_else(|| panic!("{anchor} 没过 safe_transfer_id ⇒ 越界删除的入口又开了"));
        let effect = body
            .find(first_side_effect)
            .unwrap_or_else(|| panic!("{anchor} 里找不到 {first_side_effect}，锚点要跟着改"));
        assert!(
            at < effect,
            "{anchor} 里校验排在了 {first_side_effect} 之后 ⇒ 脏 id 已经落库/落了盘"
        );
    }
}

/// 中继接收的配额登记必须排在 `begin_reassemble` **成功之后**。
///
/// 失败路径（老端 `chunk_size=0`、非法 tid）若已占一条 `relay_file_keys`，那条记录没人释放，
/// 而 `inbound_usage` 把这张表的**条数与字节**都算进全局入站配额 ⇒ 两条 8 GiB 的失败
/// Offer 就能让此后一小时所有入站文件被拒。
#[test]
fn relay_key_is_registered_only_after_the_reassembly_begins() {
    let src = include_str!("network/transport/relay_file.rs");
    let body = code_flat(&rust_fn_body(
        src,
        "async fn handle_relay_file_offer(",
    ));
    let begin = body
        .find("begin_reassemble(")
        .expect("找不到 begin_reassemble ⇒ 锚点要跟着改");
    // 只认**插入**（`.entry(...).or_insert_with(...)`）：函数开头那句 `replacing` 查询
    // 本来就在 `begin_reassemble` 之前，拿第一次出现判会误报。
    let keyed = body
        .find("or_insert_with(")
        .expect("找不到 relay_file_keys 的插入点 ⇒ 登记点搬家了");
    assert!(
        begin < keyed,
        "先把 key 记进 relay_file_keys 再开单 ⇒ 失败时白占一条入站配额直到 1h 清扫"
    );
}

/// 共享文件请求必须走**每对端有界串行队列**，不许再回到裸 `tokio::spawn`。
///
/// 旧写法每帧起一个任务、没有信号量、没有 transfer_id 去重 ⇒ 一个好友连发 N 个
/// `ShareFileRequest` 就能让本机并发做 N 次整文件哈希 + N 份发送（还把聊天刷满）。
#[test]
fn share_file_requests_go_through_the_bounded_queue() {
    let src = include_str!("network/transport/handle_share.rs");
    let body = code_flat(&rust_fn_body(
        src,
        "async fn handle_share_and_relay_messages(",
    ));
    let start = body
        .find("Message::ShareFileRequest{")
        .expect("ShareFileRequest 臂的锚点失效");
    let arm = &body[start..];
    let end = arm
        .find("Message::RelayFileOffer{")
        .unwrap_or(arm.len());
    let arm = &arm[..end];
    assert!(
        arm.contains("submit(FileServeJob{"),
        "共享文件请求没入有界队列 ⇒ 并发无上限"
    );
    assert!(
        !arm.contains("tokio::spawn("),
        "又回到裸 spawn ⇒ 一个好友就能让本机并发发 N 份整文件"
    );
}

/// **STB-03 的可失败判据**（那条计时用例是"量具"，读数随机器漂，做不成门）。
///
/// 真正要守的性质只有一句：**接收表锁里只许有"一片"的活**（解密 + 哈希 + 写）。
/// 一旦有人把整份文件级的慢活（fsync / 整份哈希 / 整份读 / 删文件）挪进锁里，
/// 单表聚合上限就掉一个数量级（§4.0w 的 133.5 MB/s 就是这么量出来的）——
/// 而那种退化**不会**让任何行为测试失败。
///
/// 两条路径各一个锁：1:1 的 `write_chunk`（锁只圈住那个块）与群的
/// `write_group_chunk_blocking`（整函数都在锁里）。
#[test]
fn receiver_lock_holds_only_one_chunk_worth_of_work() {
    const WHOLE_FILE: [&str; 4] = ["sync_all", "sha256_file_hex", "std::fs::read", "remove_file"];
    let check = |what: &str, text: &str, must_have: &[&str]| {
        for m in must_have {
            assert!(
                text.contains(m),
                "`{what}` 的锁段里没有 `{m}` ⇒ 这段取错了（判据在空集上恒绿）"
            );
        }
        for w in WHOLE_FILE {
            assert!(
                !text.contains(w),
                "`{what}` 的锁段里出现了整份文件级的活 `{w}` ⇒ 锁不再是「一片」的粒度\
                 （STB-03：单表聚合上限会掉一个数量级）"
            );
        }
    };

    let file = crate::network::file_src_for_guards();
    let one = rust_fn_body(&file, "pub fn write_chunk(");
    let block = rust_fn_body(&one, "let (received, cid, owner, report) = {");
    assert!(block.len() > 200, "没取到 write_chunk 的锁块 ⇒ 锚点写法变了");
    check(
        "1:1 write_chunk 锁块",
        &block,
        &["file_receivers", "open_symmetric", "hasher.update", "write_all"],
    );

    let tr = crate::network::transport_src_for_guards();
    let group = rust_fn_body(&tr, "fn write_group_chunk_blocking(");
    assert!(group.len() > 200, "没取到 write_group_chunk_blocking ⇒ 锚点写法变了");
    // 群侧的**解密不在这把锁里**（它在 `handle_group_file_chunk` 里、锁外做）⇒ 锁内只该有
    // 哈希更新与写一片。这条差别本身就是"只一片活"的正面证据。
    check(
        "群 write_group_chunk_blocking",
        &group,
        &["group_file_receivers", "hasher.update", "write_all"],
    );

    // 量具本身不许被顺手删掉（它是"要重构时先跑它读数"的唯一入口）
    let tests_src = include_str!("network/file_tests.rs");
    assert!(
        tests_src.contains("fn stb03_receiver_critical_section_cost("),
        "STB-03 的计时量具不见了 ⇒ 将来要动这把锁时没有读数可用"
    );
    // 反控：把整份活塞进锁块文本，上面那把尺子必须说"有"
    let gutted = format!("{block}\n    r.file.sync_all().unwrap();");
    assert!(WHOLE_FILE.iter().any(|w| gutted.contains(w)));
}

/// **B2-F1 的例外只有一处**：盘满时**删除 `.part`**，其余失败档继续保留（续传前缀）。
///
/// 为什么值得单独钉：`fail_receive` 那段注释明写"不要删 `.part`，它是续传前缀"，
/// 而盘满这一档的后果正好相反 —— 半截文件把本就不够的盘继续占着，重试又 ENOSPC
/// ⇒「一直满、一直失败」，用户只能手动取消。两者语义不同，**结构上分开写**才不会
/// 被下一个人当成 bug 改回去（或者把其它档一起改坏）。
#[test]
fn disk_full_deletes_the_part_and_other_failures_keep_it() {
    let file = crate::network::file_src_for_guards();
    let body = rust_fn_body(&file, "pub fn fail_taken_receive(");
    assert!(body.len() > 300, "没取到 fail_taken_receive ⇒ 锚点写法变了");
    assert!(
        body.contains("reason == crate::logging::FAIL_CODE_DISK_FULL"),
        "盘满例外不见了 ⇒ 那一档又会保留 .part（盘一直满、一直失败）"
    );
    assert!(
        body.contains("std::fs::remove_file(&r.tmp_path)"),
        "盘满这一档必须真的删 .part"
    );
    assert!(
        body.contains("code=FILE_DISK_FULL"),
        "盘满必须有具名码（日志/排障要能看见）"
    );
    // 反向对照：这一档的删除必须是**条件**的 —— 无条件删会把断链/超时的续传前缀一起改坏。
    // ⚠️ 旧写法只 grep 一个**不存在**的串（"let _ = …\n let fail_notes"）⇒ 恒真、什么都没守
    // （发版前 review 抓到）。现在的形状断言：删文件那一句必须在 `if reason == …DISK_FULL {`
    // 的**块内**，而且整个函数里只出现一次。
    let cond = "if reason == crate::logging::FAIL_CODE_DISK_FULL {";
    let at = body.find(cond).expect("盘满分支不见了");
    let tail = &body[at..];
    let end = tail.find("\n    }\n").unwrap_or(tail.len());
    assert!(
        tail[..end].contains("std::fs::remove_file(&r.tmp_path)"),
        "删除必须在盘满那一支**里面**（提到条件外 = 所有失败档都不留续传前缀）"
    );
    assert_eq!(
        body.matches("std::fs::remove_file(&r.tmp_path)").count(),
        1,
        "整个函数只许删这一次：第二处几乎一定是无条件删"
    );
    // 三种结局要分开说（review：`is_ok()` 会把权限/占用说成「文件已不在，视作已删除」）
    assert!(
        tail[..end].contains("std::io::ErrorKind::NotFound"),
        "删除失败要与「文件本来就不在」分开说 —— 否则一块没释放的空间会被记成成功"
    );
    // 群侧那一半（B2-F1，5.15.66）：同一份语义，但 `reason` 必须一路传到收尾函数里
    // （原先它没有这个入参 ⇒ 只能一律保留 .part）。判据与单聊同形：条件按码判、
    // 删除在那一支里面、整个函数只删一次、三种结局分开说。
    let group = rust_fn_body(&file, "pub fn fail_taken_group_receive(");
    assert!(group.len() > 200, "没取到 fail_taken_group_receive ⇒ 锚点写法变了");
    assert!(
        group.contains("reason == crate::logging::FAIL_CODE_DISK_FULL"),
        "群侧盘满例外不见了 ⇒ 那一档又会保留 .part（盘一直满、一直失败）"
    );
    let gcond = "if reason == crate::logging::FAIL_CODE_DISK_FULL {";
    let gat = group.find(gcond).expect("群侧盘满分支不见了");
    let gtail = &group[gat..];
    let gend = gtail.find("\n    }\n").unwrap_or(gtail.len());
    assert!(
        gtail[..gend].contains("std::fs::remove_file(&r.tmp_path)"),
        "群侧删除必须在盘满那一支里面（提到条件外 = 所有失败档都不留续传前缀）"
    );
    assert_eq!(
        group.matches("std::fs::remove_file(&r.tmp_path)").count(),
        1,
        "群侧整个函数只许删这一次：第二处几乎一定是无条件删"
    );
    assert!(
        gtail[..gend].contains("std::io::ErrorKind::NotFound"),
        "群侧删除失败也要与「本来就不在」分开说"
    );
    assert!(
        gtail[..gend].contains("code=GFILE_DISK_FULL"),
        "群侧盘满要有具名码（与单聊 FILE_DISK_FULL 同口径）"
    );

    // 三条调用链必须把**本轮的 reason** 传进收尾函数（发版前 review：只钉签名前缀的话，
    // 传空串也能过）。分片失败那一链要透传 `reason`，另两链各传自己的码。
    let tr = crate::network::transport_src_for_guards();
    assert!(
        tr.contains("file::fail_group_receive(state, transfer_id, reason)"),
        "分片失败链没有把 reason 透传给收尾（盘满就永远走不到删 .part 那一支）"
    );
    assert!(
        tr.contains("fail_taken_group_receive(state, &id, &r, REASON_STALLED_GROUP_RECEIVE)"),
        "超时清扫那一条丢了 reason（盘满被当成超时 ⇒ 保留 .part 的老行为）"
    );
    assert!(
        tr.contains("fail_taken_group_receive(&state, &tid, &r, REASON_PEER_UNLINKED)"),
        "对端下线那一条丢了 reason（同上）"
    );
}

/// **B4-F1 的运行时/结构判据**：每一处"写库失败要留痕"的分支都只能**记一行日志**，
/// 不许在失败分支里 `return` / `break` / `continue` / `?` 或退出进程 —— 也就是说
/// "写库抖动"这条路径**不可能改变控制流**（行为层与 v5.15.65 前逐处等价，这一条把它钉死）。
///
/// 为什么需要它：那 64 处是脚本批量改的，review 逐处读过等价，但没有任何机器判据；
/// 以后谁在失败分支里顺手加一句 `return Ok(())`，界面上的表现就是"一次写库抖动 ⇒ 整条链路
/// 静默少做一半"，而所有现有用例都不会红。
///
/// ⚠️ 已知边界：只跳过 `*_tests.rs` / `tests.rs` 分册，**不剥离**生产文件里的内联
/// `#[cfg(test)]` 块（与 `worker_supervisor.rs` 的同类扫描不同）。当前那些块里没有本判据的靶形状
/// （实测 0 命中）；真出现时的表现是**多扫到**一块（大概率是假红而不是假绿），红的时候先看归属。
#[test]
fn every_db_write_failure_branch_only_logs_and_never_changes_control_flow() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    collect_rs_files(&root, &mut files);
    assert!(files.len() > 50, "只读到 {} 个生产文件 ⇒ 走错了目录", files.len());

    let mut checked = 0usize;
    let mut offenders: Vec<String> = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).expect("读文件");
        let mut from = 0usize;
        while let Some(i) = text[from..].find("if let Err(") {
            let after = from + i + "if let Err(".len();
            // ① 绑定名任意（`Err(e)` / `Err(source)` / `Err(err)` 都合法）
            let name: String = text[after..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let close = after + name.len();
            let rest_all = &text[close..];
            // ② `)` 与 `=` 之间**允许任意空白**、`=` 之后也允许换行/缩进 ——
            //    两处真实写法就是 `if let Err(e) =\n    db::…`，卡死 `) = ` 会静默漏掉它们
            //    （实测：漏两处时在那两块里加 `return` 判据仍绿）。
            let Some(cp) = rest_all.find(')') else {
                from = after;
                continue;
            };
            let after_paren = &rest_all[cp + 1..];
            let Some(rel_eq) = after_paren.find('=') else {
                from = after;
                continue;
            };
            if !after_paren[..rel_eq].trim().is_empty() {
                from = after;
                continue;
            }
            let rest = after_paren[rel_eq + 1..].trim_start();
            if !(rest.starts_with("db::") || rest.starts_with("crate::content::store::")) {
                from = after;
                continue;
            }
            let Some(body) = balanced_block(rest) else {
                from = after;
                continue;
            };
            checked += 1;
            let flat: String = body.split_whitespace().collect();
            let rel = f.strip_prefix(&root).unwrap_or(f).display().to_string();
            let traced = flat.contains("crate::logging::log_write_failure(")
                || flat.contains("logger.")
                || flat.contains("terminal_ledger_failure_note(");
            if !traced {
                offenders.push(format!("{rel}: 失败分支没有任何痕迹 —— {flat}"));
            }
            // ③ 「不许改控制流」只对**调 log_write_failure 的那一族**成立：
            //    别处（例如 `state.rs` 的设备标识写入失败）是**刻意上抛**的，`return Err` 是对的。
            if flat.contains("crate::logging::log_write_failure(") {
                for bad in ["return", "break", "continue", "process::exit", "?;"] {
                    if flat.contains(bad) {
                        offenders.push(format!("{rel}: 失败分支里出现了 `{bad}` —— {flat}"));
                    }
                }
            }
            from = after;
        }
    }
    // 下限只防「扫描器退化」（实测 90：88 处单行 + 2 处 `=` 后换行 + 1 处文档示例），
    // **不卡在实测值上** —— 精确的那一半由下面的 `helper_uses >= 64` 负责。
    assert!(
        checked >= 80,
        "只认出 {checked} 处 `if let Err(..) = db::…` ⇒ 提取器失效（L1 归零这件事要靠它守）"
    );
    // 分母的另一半：B4-F1  Conversions 全部走同一个助手 —— 数量掉下来 = 有人把某处撤回了。
    // 只数**调用语句**（行首就是它）：文档注释里的用法示例也会命中子串，
    // 按子串数会把"少了一处调用"抵掉（实测：回填一处后仍是 64 ⇒ 判据不红）。
    let helper_uses: usize = files
        .iter()
        .map(|f| {
            std::fs::read_to_string(f)
                .expect("读文件")
                .lines()
                .filter(|l| l.trim_start().starts_with("crate::logging::log_write_failure("))
                .count()
        })
        .sum();
    assert!(
        helper_uses >= 64,
        "全仓只有 {helper_uses} 处在用 log_write_failure ⇒ 有处转换被撤回了（`.ok();` 棘轮只认语句形态，`let _ =` 绕过它）"
    );
    assert_eq!(offenders, Vec::<String>::new(), "\n{}", offenders.join("\n"));
}

/// 递归收集 `.rs`（跳过 `_tests.rs` / `tests.rs` 分册）。
fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).expect("读目录") {
        let p = e.expect("目录项").path();
        if p.is_dir() {
            collect_rs_files(&p, out);
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            out.push(p);
        }
    }
}

/// 从一段以调用开头的文本里取出 `{ … }` 块体（先按括号找到调用的 `)`，再配花括号）。
///
/// ⚠️ 全程在 `Vec<char>` 上做，最后重建成 String：按**字节**切会在中文注释里 panic
/// （"not a char boundary"）—— 本仓已经在这上面栽过两次。
fn balanced_block(rest: &str) -> Option<String> {
    let chars: Vec<char> = rest.chars().collect();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    i += 1;
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i >= chars.len() || chars[i] != '{' {
        return None;
    }
    let open = i;
    let mut d = 0i32;
    while i < chars.len() {
        match chars[i] {
            '{' => d += 1,
            '}' => {
                d -= 1;
                if d == 0 {
                    return Some(chars[open..=i].iter().collect());
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}
