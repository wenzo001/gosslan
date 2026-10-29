// 职责边界：
// - `lib_tests.rs` 测试分册之7 —— Outbox 与过期终态：先落库再 emit、破坏性写延后、清扫覆盖半截与停滞接收端
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

/// 常驻 worker 的**启动面**：`worker_supervisor.rs`（唯一的名单 `RESIDENT_WORKERS`）
/// + `lib.rs`（唯一的 `start` 调用点）。
///
/// 下面几条「恰好接一处」的接线判据都按这两份**合起来**数，理由与 `db_hold.rs` 里那条
/// 跨文件计数相同：只看 `lib.rs` 会因为我 2026-10-22 把启动点搬进 `worker_supervisor`
/// 而变成 0（判据误红），只看名单文件又会放过"某人在 `lib.rs` 里又直接 `spawn_*` 一份"
/// （同一个 worker 跑两份，推送频率翻倍，比死掉更难查）。
fn resident_startup_src() -> String {
    format!(
        "{}\n{}",
        include_str!("lib.rs"),
        include_str!("worker_supervisor.rs")
    )
}
/// 出站清扫器的「失败终态」必须**由写库成功门控**（审计 A3）。
///
/// 旧缺陷：三处 `emit("message-failed"/"file-failed")` 都写在 `if let Ok(dbc){ 写库 }` **之外**，
/// 且写库返回值被 `let _ =` 丢掉 ⇒ 锁中毒或写库失败时**界面照样报失败、而 outbox 行还在**
/// ⇒ 下一次 `flush_outbox` 把它再发一遍 = 用户看到「我以为失败了的消息又发出去了」（重复投递）。
/// 判据：① 三处终态各由 finalize 助手落库，emit 在 `if finalized {` 分支里（写库成功才发）；
///      ② 新增的孤儿/耗尽对账 emit 在 `Ok(ids) if !ids.is_empty()` 分支里（写库成功且有行才发）；
///      ③ db 锁中毒不许 `else { continue }` 静默跳过整个 tick（消息会永久停在 sending）。
/// 为什么是源码守卫：本仓没有能驱动这个清扫循环 + 捕获 emit 的异步夹具（同 4.25.7 打标顺序那条）。
#[test]
fn outbox_sweeper_emits_only_after_db_write_succeeds() {
    let src = crate::network::transport_src_for_guards();
    let body = rust_fn_body(&src, "pub fn spawn_outbox_sweeper(");
    assert_eq!(
        body.matches("finalize_expired_message(").count(),
        2,
        "单聊 + 群两处终态必须各调一次 finalize_expired_message（两步写库都成功才返回 true）"
    );
    assert_eq!(
        body.matches("finalize_expired_file(").count(),
        1,
        "文件终态必须调 finalize_expired_file"
    );
    assert_eq!(
        body.matches("if finalized {").count(),
        2,
        "message 两处 emit 必须各自被 `if finalized {{ … }}` 门控 —— 写库没成功就不许 emit，否则重复投递"
    );
    // 文件终态改为 `Result` 之后用 `match Ok(true)` 门控（复审：失败原因要能写进日志）。
    assert_eq!(
        body.matches("Ok(true) =>").count(),
        1,
        "file-failed 的 emit 必须在 `Ok(true)` 分支里（写库成功才发）"
    );
    assert_eq!(
        body.matches("emit(\"message-failed\"").count(),
        2,
        "message-failed 仍恰好两处（单聊 + 群）"
    );
    // 判据按**去掉空白后的源码**数：rustfmt 会把 `emit(\n "file-failed",\n …)`
    // 拆成多行，逐字匹配会在格式化之后失明（实测：这条断言曾因此报 0）。
    let flat: String = body.split_whitespace().collect();
    assert_eq!(
        flat.matches("emit(\"file-failed\"").count(),
        2,
        "file-failed 两处：过期终态 + 孤儿/耗尽对账；两处都必须由写库成功分支门控"
    );
    assert_eq!(
        flat.matches("Ok(report)").count(),
        1,
        "对账 emit 必须由 `Ok(report)` 分支门控 —— 读库失败就不许 emit"
    );
    assert_eq!(
        flat.matches("fortransfer_idinreport.changed").count(),
        1,
        "只在 report.changed 上 emit（写成功的行），失败行只记日志"
    );
    // N-01：载荷必须是 `FileFailedInfo`（前端 listen<FileFailedInfo> 按 {transfer_id, reason} 取值）。
    // 曾经发的是裸 `&transfer_id` ⇒ toast 显示 undefined、气泡永远停在发送中。
    assert!(
        flat.contains("emit(\"file-failed\",&FileFailedInfo{"),
        "file-failed 必须发 FileFailedInfo 结构体，不得退化成裸字符串（N-01）"
    );
    assert!(
            !body.contains(".db.lock() else { continue }"),
            "db 锁中毒必须可见（poison-tolerant + 日志），不许 `else {{ continue }}` 静默跳过整个清扫 tick"
        );
}

/// 落终态的**写序**：把行踢出重试集合的那一次写必须排最后（2026-09-23 审计 A3 的自身缺陷）。
///
/// `finalize_*` 返回 `false` 时对不 emit、"下一 tick 重试" —— 这个承诺只有在**行还在重试集合里**
/// 时才成立。文件那趟里 `mark_file_outbox_failed` 是唯一会让 `list_expired_file_outbox`
/// 再也扫不到该行的写（它只选 pending/sending），一旦排到最前面，后面任何一步失败就变成
/// "界面报失败、行再也扫不到"，或者更糟：永久停在"发送中"。消息那趟同型（删行必须最后）。
/// 判据用位置而不是数量：把破坏性写挪回前面时数量不变，只有顺序变。
#[test]
fn terminal_finalize_defers_the_destructive_write() {
    // P7 之后实现并进了唯一出口 `db::finalize_file_failure`（`finalize_expired_file`
    // 只剩一层 bool 包装）⇒ 这条逐函数守卫跟着挪到新家；迁移本身由
    // `every_finalize_path_defers_the_destructive_write`（自动扫）与
    // `expired_file_*` 那两条行为测试兜着。
    let dbc = all_db_src();
    let file_body = rust_fn_body(dbc, "pub fn finalize_file_failure(");
    let destructive = file_body
        .find("mark_file_outbox_failed(")
        .expect("文件终态必须仍由 mark_file_outbox_failed 关队列行");
    for anchor in ["set_message_status(", "upsert_transfer("] {
        let at = file_body
            .rfind(anchor)
            .unwrap_or_else(|| panic!("finalize_file_failure 少了 {anchor} 这一步"));
        assert!(
            at < destructive,
            "破坏性写（把行踢出重试集合）必须排最后：它先跑 ⇒ 后续步骤失败时行已是 failed，\
                 下一轮再也扫不到 ⇒ {anchor} 的失败永久无人重试，界面卡在「发送中」"
        );
    }

    // 消息终态的两步写已收进 `db::finalize_expired_message`（同一事务）⇒ 顺序守卫跟着
    // 迁到新家（与上面文件那趟同一个理由：实现搬走，守卫留在旧地址就会静默空转）。
    let db_src = all_db_src();
    let msg_body = rust_fn_body(db_src, "pub fn finalize_expired_message(");
    let deleted = msg_body
        .find("delete_outbox_by_msg_id(")
        .expect("单聊终态必须仍删 outbox 行");
    assert!(
        msg_body
            .find("set_message_failed(")
            .expect("少了置 failed 那一步")
            < deleted,
        "删行是消息终态里唯一不可重放的写，必须排在置 failed 之后"
    );
}

/// 把上面那条**点名式**写序守卫升级成**自动扫全部收尾路径**（第 4 步 P7 第 4 条）。
///
/// 为什么必须升级：`fail_file_job` 与 `cancel_file_transfer` 各自也做"落终态 + 把行踢出
/// 重试集合"这件事，形状与 `finalize_expired_file` 一模一样，但它们是**另写的两份**
/// （§9 那族平行实现）。点名式守卫看不见没被点名的那个 —— 于是那里明令禁止的顺序
/// （先踢出集合、后置气泡状态）在这里照样成立：outbox 行先变 failed/cancelled，
/// 后面任何一步失败，清扫器再也扫不到这一行 ⇒ 那条气泡**永久停在「发送中」**，
/// 而且再没有人会去修它（它已经不在任何重试集合里）。
///
/// 判据是**结构**的，不是清单：凡调用了"把行踢出重试集合"那一类写的函数，
/// 该调用必须排在同函数内所有"面向用户的写"之后。新增第三个收尾函数会**自动**被扫到，
/// 不必记得来这张表里登记 —— 这正是点名式做不到的那一点。
///
/// ⚠️ 两个刻意的保守性，都是为了**不静默放过**：
///  · 注释里提到的函数名也算命中（保守方向 = 多报）。所以收尾函数不许在注释里写
///    `mark_file_outbox_failed(` 这种带左括号的形式，要写就用别的措辞 ——
///    多报会立刻被人看见并改掉，漏报不会。
///  · 分两个分支各调一次破坏性写会被判红（文本顺序看不出分支）。合并成
///    "分支只决定要不要做面向用户的写，破坏性写在分支之后统一做一次" ——
///    本来就是更少的重复，不是为迁就判据而绕路。
#[test]
fn every_finalize_path_defers_the_destructive_write() {
    /// 会让这一行**从此扫不到**的写。
    const DESTRUCTIVE: &[&str] = &[
        "mark_file_outbox_failed(",
        "mark_file_outbox_cancelled(",
        "delete_file_outbox(",
        "delete_outbox_by_msg_id(",
        "delete_group_outbox_by_msg_id(",
        // B2：群文件的两笔"取消"落库同样是**把这一单踢出补发集合**的写 ——
        // `list_pending_group_files_for_recipient` 只捞 pending、`ensure_group_file_row`
        // 不再点亮 cancelled ⇒ 它们一跑，就没有第二个入口会替这一单补状态。
        // 不列进这一张表，"先关群台账、后面气泡写失败"这种顺序就没人判得出。
        "cancel_group_file_recipients(",
        "mark_group_file_cancelled(",
    ];
    /// 终态在界面上的投影：气泡状态、传输台账。
    ///
    /// `db::finalize_file_failure(` 也在这里（B2 一起加）：它就是"面向用户的两笔写"的
    /// 唯一出口（气泡 + 台账都在里面）。不加进来，扫描就看不出
    /// 「先做面向用户的写、再关集合」这一条在 `cancel_file_transfer` 里其实成立 ——
    /// 那个函数体里既没有裸 `set_message_status(` 也没有裸 `upsert_transfer(`，
    /// 于是它会被当成"没有面向用户的写"直接跳过，新加的两笔群台账关行写**没人排序**。
    const USER_FACING: &[&str] = &[
        "set_message_status(",
        // v15 起"带原因的失败"走这一扇门（`set_message_failed`）：它同样是面向用户的写，
        // 不列进来就等于给新的终态出口开了一条不受写序守卫的通道。
        "set_message_failed(",
        "upsert_transfer(",
        "mark_transfer_failed_if_active(",
        "finalize_file_failure(",
    ];
    let mut scanned = 0usize;
    let mut bad: Vec<String> = Vec::new();
    let transport = crate::network::transport_src_for_guards();
    for src in [transport.as_str(), all_commands_src(), all_db_src()] {
        for (name, body) in top_level_fns(src) {
            // 最早的破坏性写；没有就不是收尾函数
            let Some(destroy_at) = DESTRUCTIVE.iter().filter_map(|d| body.find(d)).min() else {
                continue;
            };
            scanned += 1;
            // 最晚的面向用户的写；没有就无从比较（如 flush 的成功分支只删行）
            let Some(last_user_write) = USER_FACING.iter().filter_map(|u| body.rfind(u)).max()
            else {
                continue;
            };
            if last_user_write > destroy_at {
                bad.push(format!(
                    "{name}：把行踢出重试集合的那一步在前，面向用户的写在后"
                ));
            }
        }
    }
    assert!(
            scanned >= 4,
            "只扫到 {scanned} 个收尾函数 ⇒ 这条判据已经空转（至少该有 finalize_expired_* 两条 +              fail_file_job + cancel_file_transfer）。通常是锚点或聚合清单变了，先去核对聚合源"
        );
    assert!(
            bad.is_empty(),
            "有 {} 个收尾路径的写序反了：{bad:?}\n             破坏性写（failed/cancelled/删行）必须排最后 —— 它先跑，后续步骤失败时行已扫不到，             那条气泡就永久停在「发送中」且无人再修",
            bad.len()
        );
}

/// 投递失败的重试裁决必须**只有一个判据点**（#25 第 2 段）。
///
/// 三条新单测证的是纯函数本身；这条守的是**调用点有没有真的在用它** —— 那正是这类
/// "抽成纯函数"最容易漏的半边：判据搬走了、测试全绿，循环里却还留着旧的
/// `if !retryable || over_limit`，两份判据不一致时没人发现（界面上就是"有的文件永远转圈、
/// 有的一试就判死"）。退避毫秒数同理：调用点再写死一个 5000 就是第二份事实来源。
#[test]
fn the_outbox_retry_decision_has_exactly_one_judge_and_one_caller() {
    let flat = code_flat(include_str!("commands/files.rs"));
    assert_eq!(
        flat.matches("file::send_retry_verdict(&e,attempts)")
            .count(),
        1,
        "投递失败必须走那一份纯函数裁决；0 处 = 调用点被换回内联判据，三条单测集体失效"
    );
    assert!(
        !flat.contains(">=MAX_FILE_OUTBOX_RETRIES")
            && !flat.contains(">=crate::network::file::MAX_FILE_OUTBOX_RETRIES"),
        "commands 里再比一次 attempts 就是第二份判据"
    );
    // 两个分支各自必须做对那一件事。切片两端都锚在 ASCII 起始处（GiveUp / Retry），
    // 不会因为切进中文字符里 panic —— 这条写法本身是被踩过一次才定下来的。
    let give = flat
        .find("RetryVerdict::GiveUp(reason)=>{")
        .expect("找不到 GiveUp 分支");
    let retry = flat
        .find("RetryVerdict::Retry{backoff_ms}=>")
        .expect("找不到 Retry 分支");
    assert!(
        retry > give,
        "两个分支的先后锚点看不懂了（护栏需要同步更新）"
    );
    let give_arm = &flat[give..retry];
    assert!(
        give_arm.contains("fail_file_job("),
        "GiveUp 必须真的落终态，否则\"放弃\"只存在于日志里，行还留在 sending"
    );
    assert!(
        give_arm.contains("logger.warn("),
        "放弃必须留痕：只写库不记日志，事后无从查清是哪条链路、哪一次判的死"
    );
    assert!(
        flat[retry..].contains("mark_file_outbox_pending(&dbc,&transfer_id,backoff_ms)"),
        "退避时长必须由裁决给出，不是调用点写死的第二个数"
    );
}

/// 每小时那一趟必须**三件事都做**（P1：断链清理改成"只在 peer 全掉线时清"之后，
/// 静默接收器的回收是唯一的兜底）。
///
/// 为什么钉在这里而不是写成行为测试：这三件事的共同点是"对端不会再来敲这一单了，
/// 得有人替它收尾"。漏掉任何一件的**表现都是永不回收**（`.part` + 文件句柄 / 中继内存表 /
/// 静默接收器），既不报错也不影响别的功能可见性 —— 只有把它当成**一个集合**来钉才有意义。
///
/// 顺序也有讲究：`sweep_stale_parts` 是"只删不在表里的"，所以接收器回收**必须在这一趟里**，
/// 否则它摘掉表项之后要再等一小时才会轮到 `.part`。
#[test]
fn hourly_sweep_covers_parts_relay_and_stalled_receivers() {
    let src = include_str!("lib.rs");
    let at = src
        .find(".part 清扫任务失败")
        .expect("找不到每小时清扫任务（这条护栏会空转）");
    // 窗口必须**止于测试模块**：本文件末尾就有 `mod tests`，而它自己写着这些字面量 ——
    // 取到文件末尾等于"护栏在自己的源码上找自己的名字"，永远命中、永远绿。
    // （同一个自参照坑已经坑过两次：`!tail.contains(FILE_RECEIVE…)` 那半截也是这么假过的。）
    // 窗口止于**文件末尾**：测试整段已在 lib_tests.rs，lib.rs 里不会再有自参照的名字。
    // 同时钉住"lib.rs 只许生产码"这条搬家后的新边界。
    assert!(
        !src.contains("#[cfg(test)]"),
        "lib.rs 现在只该是生产码（测试在 lib_tests.rs）；这条护栏的窗口要重新界定"
    );
    let end = src.len();
    let tail = &src[at..end];
    for call in ["sweep_stale_relay(", "sweep_stalled_receives("] {
        assert!(
            tail.contains(call),
            "每小时清扫少了 {call} —— 内存态就没人回收了"
        );
    }
    // 超时判据必须只有一份，且在 network 侧（这里不许长出第二份"多久算静默"）
    assert!(
        !tail.contains("FILE_RECEIVE_IDLE"),
        "lib.rs 不该自己算接收超时——判据在 file::receive_is_stale"
    );
}

/// `DbLock` 量了 wait/hold，但摘要必须真的接到生产日志 —— 只测 `summary_line`
/// 不够：没人读 `take_summary()` 时，现场依旧看不到"谁握了多久、排队多久"。
/// 同时钉住唯一读者：两个读者会互相清计数，读到的都是残缺窗口。
/// A-17：`flush_outbox` 只在建链/Hello 触发，多链路并发窗口里没发出去的消息会停在
/// `sending`；必须有一个**按周期对当前有链路的 peer 重放**的接线点，且覆盖群队列。
#[test]
fn outbox_retrier_is_wired_and_covers_both_queues() {
    let lib = resident_startup_src();
    let state = include_str!("state.rs");
    assert_eq!(
        lib.matches("AppState::spawn_outbox_retrier(").count(),
        1,
        "离线队列重放必须恰好接一处（多一处会重复跑）",
    );
    assert_eq!(
        state.matches("pub fn spawn_outbox_retrier(").count(),
        1,
        "重放器只能有一份"
    );
    let body = rust_fn_body(state, "pub fn spawn_outbox_retrier(");
    for needle in [
        "tauri::async_runtime::spawn",
        "OUTBOX_RETRY_SECS",
        "st.links.lock().await",
        "flush_outbox(",
        "flush_group_outbox(",
    ] {
        assert!(
            body.contains(needle),
            "重放器缺 {needle} —— 不重放/只重放一半/不按链路筛选都会让 A-17 复发"
        );
    }
}

/// 2026-10-20 永久发送中 P0 的接线判据：
/// - 清扫器必须**进程级**恰好接一处，且不再绑在 `network::start` 的生命周期上；
/// - "可达"必须同时认 TCP 链路与发现层在线（`peers.last_seen`），不能只看 links。
#[test]
fn outbox_sweeper_is_process_lifetime_and_reachability_includes_discovery() {
    let lib = resident_startup_src();
    assert_eq!(
        lib.matches("spawn_outbox_sweeper(").count(),
        1,
        "清扫器必须恰好接一处（多一处会双扫，少一处 = 无终态出口）"
    );
    let net = include_str!("network/mod.rs");
    assert!(
        !net.contains("spawn_outbox_sweeper("),
        "清扫器不许再绑在 network::start 上：局域网起不来/被关掉时它就没了"
    );

    let src = crate::network::transport_src_for_guards();
    let body = rust_fn_body(&src, "pub fn spawn_outbox_sweeper(");
    let flat = code_flat(&body);
    assert!(
            flat.contains("state.peers.lock()") && flat.contains("peer.last_seen"),
            "可达性快照必须并入发现层在线（peers.last_seen）—— 只看 links 会把\"在线但对端链路刚断\"按离线挂 7 天"
        );
    assert!(
        flat.contains("outbox_peer_reachable("),
        "可达判据必须走那个纯函数（单测钉边界；内联一份就会漂）"
    );
    assert!(
        !flat.contains("shutdown.changed()"),
        "清扫器是进程级常驻，不许再随网络 shutdown 退出"
    );
    // 2026-10-20 双实例 E2E 实测：从 `lib.rs` setup 里调这个函数时，`tokio::spawn` 会 panic
    // 「there is no reactor running」⇒ 应用启动即崩（release panic=abort）。setup 跑在主线程、
    // 没有 Tokio 上下文，只有 `tauri::async_runtime::spawn` 能从任意线程惰性建 runtime。
    // 单测不跑 setup，所以这条**形状判据**是唯一的静态防线（行为证据见该轮 E2E）。
    assert!(
        flat.contains("tauri::async_runtime::spawn(") && !flat.contains("tokio::spawn("),
        "清扫器必须用 `tauri::async_runtime::spawn`：`tokio::spawn` 在 setup 线程里没有 reactor，\
             会 panic 并把启动带崩"
    );
    assert_eq!(
        flat.matches("OUTBOX_SWEEP_READ_FAILED").count(),
        3,
        "单聊/群/文件三条过期队列的读失败必须各自留 code=OUTBOX_SWEEP_READ_FAILED，\
             不许折成\"没有过期行\"静默跳过"
    );
    assert_eq!(
        flat.matches("OUTBOX_OFFLINE_HELD").count(),
        3,
        "对端离线时的\"保留\"必须三条队列各留一次可见读数（code=OUTBOX_OFFLINE_HELD），\
             否则用户看到的长期发送中在日志里没有解释"
    );
}

/// Ack 的「状态前进 + 删队列行」必须走同一个事务出口。
///
/// 旧写法是两条独立写、错误全吞：状态写失败 + 删行成功 = 永久发送中（队列行没了，
/// 清扫器与补发都看不见）。行为判据在 `db::messages::ack_delivery_tests`（含删行
/// 失败必须回滚状态），这条只钉**调用点没有再长出第二份内联实现**。
#[test]
fn ack_commit_uses_the_single_transaction_helper() {
    let src = crate::network::transport_src_for_guards();
    let body = rust_fn_body(&src, "async fn handle_messaging_arm(");
    let flat = code_flat(&body);
    assert_eq!(
        flat.matches("ack_delivered(").count(),
        1,
        "Ack 收尾必须走 `db::ack_delivered` 这一处事务出口"
    );
    // ⚠️ 这一格必须看**原文**（`body`），不能看 `flat`：`code_flat` 把空白全删了
    // ⇒ `DELETE FROM outbox …` 变成 `DELETEFROMoutbox…`，`!flat.contains("DELETE FROM …")`
    // 恒为真 —— 那是判据自等（源码里真长出内联删行它也照绿）。2026-10-20 复核查出。
    assert!(
        !body.contains("DELETE FROM outbox WHERE msg_id"),
        "Ack 臂里又出现了内联删行 ⇒ 状态与删行重新变成两条独立写"
    );

    // 群聊同一纪律：GroupAck 也必须走事务出口，不许再出现"先删后写、错误全吞"。
    let group_body = rust_fn_body(&src, "async fn handle_group_messages(");
    let group_flat = code_flat(&group_body);
    assert_eq!(
        group_flat.matches("ack_group_delivered(").count(),
        1,
        "GroupAck 收尾必须走 `db::ack_group_delivered` 这一处事务出口"
    );
    assert!(
        !group_body.contains("DELETE FROM group_outbox WHERE msg_id"),
        "GroupAck 臂里又出现了内联删行 ⇒ 状态与删行重新变成两条独立写"
    );

    // 跨跳 `GossipKind::ChatAck` 是同一件事的**第三个**入口（2026-10-20 补齐）：
    // 它此前仍是 `set_message_status(...).ok()` + 内联 `DELETE ... .ok()` 两条独立写，
    // 与刚修掉的那两处完全同型。这条钉住它也不许再退回去。
    let gossip_body = rust_fn_body(&src, "async fn handle_gossip(");
    let gossip_flat = code_flat(&gossip_body);
    assert_eq!(
        gossip_flat.matches("ack_delivered(").count(),
        1,
        "跨跳 ChatAck 收尾必须走 `db::ack_delivered` 同一个事务出口"
    );
    assert!(
        !gossip_body.contains("DELETE FROM outbox WHERE msg_id"),
        "跨跳 ChatAck 臂里又出现了内联删行 ⇒ 状态与删行重新变成两条独立写"
    );
}

/// 运行态快照的接线判据：只测纯函数不够，必须真的有人每 5 分钟读 WebView 数与队列数。
#[test]
fn runtime_diag_reporter_is_wired_once_and_covers_webviews_and_queues() {
    let lib = resident_startup_src();
    assert_eq!(
        lib.matches("AppState::spawn_runtime_diag_reporter(")
            .count(),
        1,
        "运行态快照必须恰好接一处"
    );
    let state = include_str!("state.rs");
    let body = rust_fn_body(state, "pub fn spawn_runtime_diag_reporter(");
    for needle in [
        "webview_windows(",
        "RUNTIME_DIAG_SECS",
        "logger.info(",
        "\"runtime\"",
        "status = 'sending'",
        "FROM outbox",
        "FROM group_outbox",
        "FROM file_outbox",
    ] {
        assert!(
            body.contains(needle),
            "运行态快照缺 {needle} —— 窗口泄漏/队列积压就又没有现场读数了"
        );
    }
}

#[test]
fn db_hold_summary_has_exactly_one_production_reader() {
    let lib = resident_startup_src();
    let state = include_str!("state.rs");
    assert_eq!(
        lib.matches("AppState::spawn_db_hold_reporter(").count(),
        1,
        "锁观测的启动点必须恰好一处（多一处就多一个读者，互相吞计数）"
    );
    assert_eq!(
        state.matches("pub fn spawn_db_hold_reporter(").count(),
        1,
        "锁观测上报器必须留在 state.rs 里且只有一份"
    );
    assert_eq!(
        state.matches("st.db.take_summary()").count(),
        1,
        "take_summary() 消费即清零：生产代码里只许这一个读者"
    );
    // 跨文件数总量的那条判据在 `db_hold.rs::timed_lock_is_wired_into_the_app`（锁观测的家）。
    // 这里不再摆第二份同一条谓词 —— 同一个判据摆两处，摘掉任何一处都看不出来（等价变异），
    // 而 10-22 审计 R-06 的教训恰恰是"每条都只数自己那个文件，合起来两个读者没人看得见"。
    for needle in [
        "tauri::async_runtime::spawn",
        "summary_line(",
        "DB_HOLD_REPORT_SECS",
        "logger.warn(\"db\"",
        "slow_threshold_ms()",
    ] {
        assert!(
            state.contains(needle),
            "锁观测缺 {needle} —— 摘要要么没进日志，要么读了错的阈值"
        );
    }
}

#[test]
fn production_transaction_sites_are_all_timed() {
    // B15 的接线判据：分母按"生产事务调用点"数，不按文件角色猜。三处收尾事务各有一条耗时观测，
    // 少一条就是"编译得过、门禁全绿，而那一格永远没有读数"的形状。
    let sites = [
        (
            "group_file.rs",
            include_str!("network/transport/group_file.rs"),
        ),
        ("receive.rs", include_str!("network/file/receive.rs")),
        (
            "ledger_backfill.rs",
            include_str!("network/file/ledger_backfill.rs"),
        ),
    ];
    for (name, src) in sites {
        assert_eq!(
            src.matches(".transaction()").count(),
            1,
            "{name} 的生产事务调用点数变了 ⇒ 分母要重数，别把没埋点的漏在外"
        );
        assert_eq!(
            src.matches("note_tx(").count(),
            1,
            "{name} 的收尾事务必须有且只有一条耗时观测"
        );
        assert!(
            src.contains("std::time::Instant::now()"),
            "{name} 缺计时起点（只有 note_tx 没有 Instant 就是量了个假的）"
        );
        assert!(
            src.contains("slow_threshold_ms()"),
            "{name} 的阈值要沿用 DbLock 那个家，不许另造常数"
        );
    }
    // 领域依赖方向那把棘轮认的是**声明出来的 use**，不是 consumes 名单：transport 域必须显式
    // import 这条出口，否则它又被数成一对"判据看不见的内联耦合"，第 13 步当场红。
    assert!(
        include_str!("network/transport.rs").contains("use crate::db_hold::note_tx;"),
        "transport 域的耗时出口必须是声明出来的 use（内联 crate::db_hold::… 会让领域棘轮长一对）"
    );
    let hold = include_str!("db_hold.rs");
    assert_eq!(hold.matches("pub fn note_tx(").count(), 1, "出口只许有一份");
    assert!(
        hold.contains("format!(\"tx {stage} {key} ms={ms} ok={ok}\")"),
        "这一行只许含阶段名/关联键/毫秒/成败 —— 塞进 SQL、参数、正文或文件名就是把隐私写进日志"
    );
}
