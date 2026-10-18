// 职责边界：
// - `lib_tests.rs` 测试分册之6 —— 公网中继数据面：定向策略、回收终态落库在锁外、口令不进日志、电路标 Relay
//   ＋ 两条**按形状扫全仓**的分母判据（INV-P34 整份慢活在哪条线程上 / 卡片类落库失败不许静默吞掉）
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
    /// 数据面转发必须吃中继策略（2026-09-19 审计 P0#5 回归护栏）。
    ///
    /// 为什么必须守：控制面（gossip）从 ADR-0016 起就走 `decide_forward`，而数据面
    /// （定向借道 / RelayChunk / OpaqueExternal）曾长期裸奔 —— 用户把中继设成
    /// 「关闭」，文件分片照样借他的带宽一跳一跳地跑，**设置项只有一半是真的**。
    /// 这类"开关只管一条路径"的分裂在 UI 上完全看不出来，只能源码钉死。
    ///
    /// ⚠️ 2026-10-07 改严：这条原来钉的是 `decide_relay_from_peer(` 出现 **≥3 次**，
    /// 而"三次"正是三段抄写的产物 —— 于是它把缺陷形状当成了要求：谁把闸收成一处 helper
    /// 让三个消费者共调，计数掉到 1，这条判据当场红，而代码其实变好了（最顺手的消红动作
    /// 是再抄第四遍）。现在钉的是**形状**：策略判定恰好一个家 + 三个转发点各自走它。
    /// 两条反证（本轮实测过，不是设计意图）：摘掉任意一个消费者 ⇒ `wired` 少一 ⇒ 红；
    /// 把闸内联回任一调用点 ⇒ `homes` 变 2 ⇒ 红。
    #[test]
    fn relay_data_plane_respects_policy() {
        let transport = crate::network::transport_src_for_guards();
        // ① 闸只有一个家：策略判定在整份生产码视图里恰好出现一次（就在 relay_denied 内部）。
        let homes = transport.matches("decide_relay_from_peer(").count();
        assert_eq!(
            homes, 1,
            "中继授权闸必须只有 relay_denied 一个家，实际 {homes} 处 —— \
             多于 1 处就是把同一段判断抄在多个转发点里（这条判据以前正替那个形状把关）"
        );
        // ② 那个家必须是**函数**，不是一处裸调用（防止有人把三处合并成一处后删掉 helper）。
        let defs = transport.matches("fn relay_denied(").count();
        assert_eq!(defs, 1, "relay_denied 必须是唯一的闸函数，实际 {defs} 处定义");
        // ③ 三个数据面转发点各自经过它：定向借道 / OpaqueExternal 转投 / RelayChunk 转投。
        let wired = transport.matches("if relay_denied(").count();
        assert_eq!(
            wired, 3,
            "数据面三个转发点（定向借道 / RelayChunk / OpaqueExternal）都要走 relay_denied，\
             实际 {wired} 处 —— 少一个就是那条路径又变成不经策略裸奔（P0#5 的原病灶）"
        );
        // gossip 控制面原有闸不得被拆掉
        assert!(
            transport.contains("decide_forward("),
            "gossip 转发的 relay 授权闸（decide_forward）被删了？"
        );
    }

    /// 中继态回收（审计 A2）：被回收的传输必须**落 DB 终态**并 emit，且 emit 在 db 锁**之外**。
    ///
    /// 两条各挡一种退化：① 只 `retain` 内存不写库 ⇒ DB 行永远停在 active/某个百分比，
    /// 接收端界面永久卡 X%（旧行为）；② 顺手在 `for id in &removed { 写库 + emit }` 里 emit
    /// ⇒ 把阶段 2 刚消灭的「锁内慢活」请回来（前端收到 file-failed 后下一次 IPC 要抢同一把锁）。
    #[test]
    fn relay_reclaim_finalizes_in_db_and_emits_outside_the_lock() {
        let src = crate::network::transport_src_for_guards();
        let body = rust_fn_body(&src, "pub fn sweep_stale_relay(");
        assert!(
            body.contains("mark_transfer_failed_if_active("),
            "回收中继态必须把仍 active 的传输行落 failed，否则接收端界面永久卡在百分比上"
        );
        let lock_at = body
            .find("state.db.lock()")
            .expect("回收必须写库（db 锁）才能落终态");
        // ⚠️ 探针刻意**不带左括号**：`src/api/events.test.ts` 扫 Rust 源码时不抹字符串字面量
        // （它必须看见 `emit("x")` 里那个串本身才认得出事件名），于是守卫里写全 `emit(` 会被
        // 当成一个真实发送点、把它后面那截文本当成"事件名" ⇒ 结构门禁无故变红。
        let emit_at = body
            .find("state.app.emit")
            .expect("回收必须 emit file-failed：只写库不发事件的话前端要等下一次刷新才知道");
        assert!(
            !body.contains(".db.lock().unwrap()"),
            "db 取锁必须抗中毒（`.unwrap_or_else(|e| e.into_inner())`）"
        );
        assert!(
            code_flat(&body[lock_at..emit_at]).contains("};"),
            "emit 必须在 db 锁作用域**之外**：锁内只收集要通知的 id，出锁再 emit"
        );
    }

    /// 中继发送不许宣称「未经证明的成功」（2026-09-23 审计 A1 的 L1 那一半）。
    ///
    /// 四处必须同时成立，拆掉任何一处就退回"写出 = 送达"那个假成功：
    /// ① `relay_send_to_neighbors` 交出**接住该帧的邻居数**（旧实现把每个 `try_send` 的结果
    ///    用 `let _ =` 丢掉，于是"没人接住"和"全都接住"在调用方看来一模一样）；
    /// ② `relay_push_file` 把它当**下限判据**用在两处：Offer 与每一片。注意方向 ——
    ///    `0 ⇒ 必然没送出` 才可用，`≥1` 不代表某个邻居与目标有直连，所以它不是送达证明
    ///    （真证明要等接收端回执，即尚未实施的 A1-L2）；
    /// ③ 失败必须落 DB 终态，且**只能经包装层这一个出口**：发送方向没有任何清扫器
    ///    （`sweep_stale_relay` 清的是接收侧那两张内存表），漏一条 Err 路径就是一行 active
    ///    永久挂在"进行中"，重启后又被捞出来显示百分比；
    /// ④ 推流之前插的那条系统消息必须是「请求下载」而不是完成时态 —— 写下它的那一刻，
    ///    这条链上还没有任何成功证据。
    /// 为什么是源码守卫：判定需要"邻居接住数为 0"的链路夹具 + 事件捕获，本仓没有这种夹具。
    #[test]
    fn relay_send_does_not_claim_unproven_success() {
        let tv = crate::network::transport_src_for_guards();
        let relay = rust_fn_body(&tv, "pub(crate) async fn relay_send_to_neighbors(");
        assert!(
            relay.contains("-> usize"),
            "relay_send_to_neighbors 必须返回接住该帧的邻居数 —— 返回 () 就等于把假成功留给调用方"
        );
        assert!(
            code_flat(&relay).contains("try_send(state,&p,msg).await.is_ok()"),
            "计数必须建立在 try_send 的成功判定上（`let _ =` 丢弃返回值就永远数不出来）"
        );

        // 视图读"一个家"`network::file_src_for_guards()`（2026-10-07 file.rs 按角色切成 include! 分册）：
            // 读单个文件只会看见主册 ⇒ 形状守卫对分册失明（假绿形状）。登记对账由 lib_source_view_tests 第四个用例钉两侧。
                    let file = &crate::network::file_src_for_guards();
        let push = rust_fn_body(file, "async fn relay_push_file(");
        let flat_push = code_flat(&push);
        assert_eq!(
            flat_push.matches(".await==0{returnErr(").count(),
            2,
            "Offer 与每一片各一处「0 个邻居接住 ⇒ 失败」的判据，少一处就是又退回无条件发送。\
             探针带 `.await` 与 `return Err` 两段形状：本函数里还有一处无害的 `if size == 0`，\
             只数 `==0{{` 会把它算进来（实测第一次就跑出 3）。刻意不再单列「调用处数」那条断言：\
             它被这条完全覆盖（少调用必然同时少判据），留着只会让变异用例打在它前面那条上、\
             得到一句弱确认（2026-09-23 真踩过）。"
        );

        // L2 那一半：写出 ≠ 送达。走完分片循环只证明"每一片被至少一个邻居接住"，
        // 所以终态只能是 `sent`，也不能广播"本机这条已完成"的事件。
        assert!(
            flat_push.contains("\"send\",\"sent\",") && !flat_push.contains("\"send\",\"done\","),
            "中继推送写完分片必须落 sent：直接写 done 就是无证据的成功\
             （验收红线「不要因为 TCP write 成功就认为消息已送达」）"
        );
        assert!(
            !flat_push.contains("\"file-done\""),
            "没有回执的推送不许广播完成事件：前端 onFileDone 会把内存里那行写成 done，\
             于是「库里 sent、界面上 ✓」。只准发 file-progress（那说的是本机写出进度）。\
             探针带引号，避开的正是本函数注释里那句反引号包裹的同名事件。"
        );

        let wrap = rust_fn_body(file, "pub async fn send_file_via_relay(");
        assert!(
            wrap.contains("mark_transfer_failed_if_active("),
            "失败必须落 DB 终态：发送方向没有清扫器，漏一条 Err 路径就是一行 active 永久挂着"
        );
        assert!(
            !wrap.contains("return Err("),
            "落终态依赖「唯一出口」这个形状：判据留在 relay_push_file 里，包装层只做 outcome→终态；\
             包装层里任何提前 return 都会绕过落终态，那就又是「界面说失败、库里说进行中」"
        );

        assert!(
            tv.contains("请求下载你的文件"),
            "共享下载的系统消息必须是「请求下载」：插它的时候还没有任何成功证据"
        );
        assert!(
            !tv.contains("下载了你的文件"),
            "「下载了你的文件」是在证据之前下的断言 —— 中继发送失败时它就成了一句假话"
        );
    }

    /// 中继收文件：① 完整性校验必须对**已按 seq 归位的字节一次性**算（审计 1.8）；
    /// ② 归位的字节必须在**磁盘上**，不在内存里（架构复审 P4）。
    ///
    /// 后果链（1.8）：旧实现逐片"到达即喂"增量哈希 —— 但中继链路分片天然**重复**
    /// （多邻居泛洪各送一份）且**乱序**（多路径时延不同），喂哈希发生在去重/排序
    /// 之前 ⇒ 分片收齐却必然校验失败：接收端报"文件完整性校验失败"、发送端却显示
    /// 成功（无回执），两端状态互相矛盾且无重试路径。
    ///
    /// 后果链（P4）：重组表原先是 `chunks: HashMap<u32, Vec<u8>>`，完成时再组装出第二份
    /// ⇒ 峰值 ≈ 2× 文件大小（600MB 文件 = 1.2GB 内存，移动端必被系统杀掉），
    /// 而当时的尺寸闸门只有一句 `size > i64::MAX`，等于没有。
    ///
    /// 判据分两组，都取**语义形状**：
    /// ① `handle_relay_chunk` 里不得出现 `.hasher`（增量喂哈希的旧写法），
    ///    校验点必须是对文件整体流式算的 `sha256_file_hex(`；
    /// ② `file_relay.rs` 的 `Reassembly` 不得再持有 `Vec<u8>` 载荷、`add_chunk`
    ///    必须真的 `seek + write_all` 落盘，且开档时预分配（`set_len`）——
    ///    少任何一件，"内存与文件大小无关"这个结论就不成立。
    #[test]
    fn relay_receive_hashes_assembled_plaintext_once() {
        let src = crate::network::transport_src_for_guards();
        let body = rust_fn_body(&src, "async fn handle_relay_chunk(");
        assert!(
            !body.contains(".hasher"),
            "handle_relay_chunk 里出现增量哈希：分片按到达顺序喂、在去重/排序之前，\
             重复与乱序都会算错 ⇒ 收齐了也报校验失败（审计 1.8）"
        );
        assert!(
            body.contains("sha256_file_hex("),
            "完整性校验必须对**已归位的整份字节**一次性算（流式 `sha256_file_hex`，\
             审计 1.8 + P4）：既不能逐片喂，也不能先把整份读回内存再 digest"
        );
        assert!(
            !body.contains("Sha256::digest(&"),
            "又出现了「把一份完整缓冲喂给 digest」的写法：中继接收的内存峰值必须与\
             文件大小无关（P4）"
        );

        let relay = include_str!("file_relay.rs");
        let begin = rust_fn_body(relay, "pub fn begin_reassemble(");
        let add = rust_fn_body(relay, "pub fn add_chunk(");
        assert!(
            begin.contains("set_len("),
            "开档必须预分配到声明的尺寸：既是「写到 offset 之外当场可判」的依据，\
             也让乱序落盘不必自己补零（P4）"
        );
        assert!(
            add.contains("SeekFrom::Start(") && add.contains("write_all("),
            "add_chunk 必须按 `seq × chunk_size` 直接写盘，而不是把分片存进内存表（P4）"
        );
        let struct_at = relay
            .find("pub struct Reassembly {")
            .expect("找不到 Reassembly —— 改名要同步这条守卫");
        let struct_body = &relay[struct_at..relay[struct_at..].find("\n}").unwrap() + struct_at];
        assert!(
            !struct_body.contains("Vec<u8>"),
            "Reassembly 又持有 `Vec<u8>` 载荷 = 退回整份驻内存，那正是 P4 要消灭的形状：{struct_body}"
        );
        assert!(
            struct_body.contains("HashSet<u32>") && struct_body.contains("file:"),
            "Reassembly 只许持有「收到过哪些 seq」+「已打开的文件句柄」两样：\
             多了任何一份字节缓冲都是 P4 复发"
        );
    }

    /// **解除好友关系必须同时解除内存里的身份绑定**（用户 2026-09-13 真机：不然"必须重启"）。
    ///
    /// 好友身份锚点的**绑定来源**必须问同一道闸（#32 第一片）。
    ///
    /// 后果链：`friends.ed25519_pubkey` 是 Hello 的验签锚点（INV-P21）与安全码的输入，
    /// 现在还是公网中继电路的准入判据（`list_bound_friend_identities` 只看它非空）；
    /// 而写入是 fill-only —— 首写者永久胜出。此前 `upsert_peer` 要求 `keys_verified`，
    /// 三条"成为好友"的路径读的却是**同一张 `peers` 表**且不过闸 ⇒ 一次伪造的 UDP announce
    /// 就能永久钉死锚点（E2EE 被击穿之外，还多了一条"我们主动跨公网给它建电路"）。
    ///
    /// 三件判据：① 三处都走同一个 helper（闸只有一份）；② 写钥匙的直调只许出现在
    /// "自己问过闸"的那几处；③ 三条"验签通过"的握手都必须打标 —— 漏一条就是
    /// "验过签却不标"，让收紧后的锚点永远补不上（安全改动做成可用性回退）。
    /// **口令值不许进日志、也不许进诊断事件**（`INTEGRATION.md` 要求 7 的硬部分）。
    ///
    /// 这条链路上"服务器口令"是唯一准入手段，而调试时最容易手滑写出的就是
    /// `format!("token={}", cfg.token)` 那一行 —— 日志会被导出、会被贴进求助帖。
    /// 判据按**语句**切（`;` 分隔）而不是按行：日志调用普遍跨行，逐行扫会漏掉真正插值的
    /// 那一行，那样这条守卫就成了摆设。
    ///
    /// 允许的唯一形态是"只报长度"（`token_len={}` + `chars().count()`），
    /// `save_relay_config` 与 `check_relay_server` 就是这么写的。
    #[test]
    fn relay_token_never_reaches_logs_or_diagnostics() {
        const VALUE_EXPRS: [&str; 2] = [".token", "token_norm"];
        const COUNT_ONLY: [&str; 2] = ["token_len", "chars().count()"];
        let sources = [
            ("transport", crate::network::transport_src_for_guards()),
            ("commands", all_commands_src().to_string()),
        ];
        // 先自证"这两份视图真的看得见中继"。`transport/relay.rs` 与 `commands/relay.rs` 都是
        // `include!` 进同一模块的分册，而守卫读的是**文件文本** —— 漏登记不会报错，
        // 只会让这条守卫扫描不到任何中继代码，于是**永远绿**（假绿比假红危险）。
        assert!(
            sources[0].1.contains("fn relay_negotiate("),
            "transport 视图里没有 `transport/relay.rs` 分册 ⇒ 这条守卫扫不到拨号器，会假绿。\
             新增分册时要在 `network::transport_src_for_guards()` 里同步登记一行。"
        );
        assert!(
            sources[1].1.contains("fn check_relay_server("),
            "commands 视图里没有 `commands/relay.rs` 分册 ⇒ 这条守卫扫不到中继命令，会假绿。\
             新增分册时要在 `all_commands_src()` 里同步登记一行。"
        );
        let mut offenders: Vec<String> = Vec::new();
        for (name, src) in sources {
            for stmt in src.split(';') {
                if !(stmt.contains("logger.") || stmt.contains("push_diag_event")) {
                    continue;
                }
                if !VALUE_EXPRS.iter().any(|p| stmt.contains(p)) {
                    continue;
                }
                if COUNT_ONLY.iter().any(|p| stmt.contains(p)) {
                    continue;
                }
                offenders.push(format!(
                    "[{name}] {}",
                    stmt.trim().replace('\n', " ").trim()
                ));
            }
        }
        assert!(
            offenders.is_empty(),
            "把口令**值**写进了日志或诊断事件（要求 7：不写日志、不进上报、不出现在诊断截图里）。\
             要留痕就只报长度：{}{}",
            "token_len={}",
            ", …chars().count()"
        );
    }

    /// 中继会合拨号必须把电路登记成 `PathKind::Relay`，**不能复用 `Routed`**。
    ///
    /// 为什么钉接线而不是只钉枚举：`path_rank` / `best_link_kind` / `path_kind_names_are_stable`
    /// 的单测只证明"枚举里有 Relay、优先级对、串名对"。把 relay.rs 那处拨号改回
    /// `PathKind::Routed`，它们**照样全绿** —— 而后果是用户能看见的：中转电路又会被界面标成
    /// 「跨网段 / VPN」、并和真正的 VPN 直达路径挤进同一个选路优先级（用户 2026-09-22 要求
    /// "局域网 / VPN / 蓝牙 / 公网中转四种通道全局统一"）。判据落在**唯一的那处拨号构造点**。
    #[test]
    fn relay_circuit_is_tagged_relay_not_routed() {
        let src = crate::network::transport_src_for_guards();
        // 自证视图里真的有中继分册（漏登记 ⇒ 扫不到拨号点 ⇒ 永远绿 = 假绿）。
        assert!(
            src.contains("fn relay_rendezvous_task("),
            "transport 视图里没有 `transport/relay.rs` 分册 ⇒ 这条守卫扫不到拨号点，会假绿。\
             新增分册时要在 `network::transport_src_for_guards()` 里同步登记一行。"
        );
        let body = rust_fn_body(&src, "pub async fn relay_rendezvous_task(");
        assert!(
            body.contains("PathKind::Relay"),
            "中继会合拨号必须用 PathKind::Relay 登记电路；改回 Routed 会让中转被标成「跨网段 / VPN」、\
             并与 VPN 直达路径同优先级（四种通道必须可区分）"
        );
    }

    /// 中继文件链上**四格整份文件慢活**必须都在阻塞线程池里（INV-P34，2026-10-15）。
    ///
    /// 为什么上一条不够（`relay_receive_hashes_assembled_plaintext_once` 判的是"整份一次性算、
    /// 不逐片喂、不整读进内存"）：那一族的病不在**算法**在**线程** —— 同一句正确的流式哈希，
    /// 写在 async worker 上就是秒级钉住一个 worker，而同一个 runtime 上还排着所有
    /// `#[tauri::command(async)]` 的开窗命令（4.39.3 单聊收尾 / 4.40.1 群收尾 / 4.40.3 续传
    /// 都是这一条根因，用户 2026-10-14 真机：传 3.x GB 那一段"点设置没窗、拖窗口没反应"）。
    /// "算法对"的守卫看不见它，必须按执行上下文钉。
    ///
    /// 四格：`relay_push_file` 发送前的整份哈希；`handle_relay_chunk` 的①重组（完成那一片时对
    /// 整份 `.part` 做 `sync_all`，同时还攥着 relay 全局锁）②整份哈希③改名落盘（跨卷退化为整份 copy）。
    ///
    /// 每格钉三件事：**包住了**（`spawn_blocking(` 就在它前面）、**等它跑完了**（紧跟 `.await` 并兜住
    /// JoinError —— 丢掉 JoinHandle 是另一种死法：活照跑但状态机不推进，传输永远停在完成前一秒）、
    /// **旧形状没了**（负向锚点，防"改回去了但注释还留着"）。
    #[test]
    fn relay_file_lifecycle_slow_work_runs_off_the_async_worker() {
        // 先剥整行注释再扁平化：这些格子上方都挂着"为什么必须在池里"的警告注释，
        // 不剥的话**旧写法在注释里被复述一遍**就会被当成命中（既假红也假绿）。
        fn flat_code(s: &str) -> String {
            let kept: Vec<&str> = s
                .lines()
                .map(str::trim_start)
                .filter(|t| !t.starts_with("//") && !t.starts_with("/*") && !t.starts_with('*'))
                .collect();
            code_flat(&kept.join("\n"))
        }
        let t = crate::network::transport_src_for_guards();
        let f = crate::network::file_src_for_guards();
        assert!(
            t.contains("fn handle_relay_chunk("),
            "transport 视图里没有 `transport/relay_file.rs` ⇒ 这条守卫扫的是空集，会假绿。\
             新增分册要在 `transport_src_for_guards()` 里同步登记一行。"
        );
        assert!(
            f.contains("fn relay_push_file("),
            "file 视图里没有 `file/relay_push.rs` ⇒ 同上，扫不到发送前那一格哈希。"
        );
        let chunk = flat_code(&rust_fn_body(&t, "async fn handle_relay_chunk("));
        let push = flat_code(&rust_fn_body(&f, "async fn relay_push_file("));
        // 0 = handle_relay_chunk 的体，1 = relay_push_file 的体。
        let bodies = [chunk.clone(), push.clone()];
        let cases: [(&str, usize, &str, &str, &str); 4] = [
            (
                "中继发送前的整份哈希",
                1,
                "tokio::task::spawn_blocking(move||sha256_file_hex(&hash_path))",
                "sha256_file_hex(&hash_path)).await.unwrap_or_else(",
                "letfile_sha256=sha256_file_hex(&path)?",
            ),
            (
                "中继重组（完成片整份 fsync + 全局锁）",
                0,
                "tokio::task::spawn_blocking(move||{letmutrelay=st.relay.lock()",
                "relay.add_chunk(&tid,seq,&bytes)}).await.unwrap_or_else(",
                "letcompleted={letmutrelay=state.relay.lock()",
            ),
            (
                "中继接收的整份 .part 哈希",
                0,
                "tokio::task::spawn_blocking(move||file::sha256_file_hex(&p))",
                "file::sha256_file_hex(&p)).await.unwrap_or_else(",
                "letactual_hex=matchfile::sha256_file_hex(&part_path)",
            ),
            (
                "中继落盘（rename / 跨卷整份 copy）",
                0,
                "tokio::task::spawn_blocking(move||move_received_file(&st,&nm,&pp))",
                "move_received_file(&st,&nm,&pp)).await.unwrap_or_else(",
                "letpath=matchmove_received_file(state,&name,&part_path)",
            ),
        ];
        for (what, idx, wrap, awaited, legacy) in cases {
            let b = &bodies[idx];
            assert!(
                b.contains(wrap),
                "`{what}` 这一格找不到 `{wrap}` ⇒ 整份文件慢活又回到 async 执行路径上了：\
                 几百 MB 就是秒级钉住一个 tokio worker，而所有开窗命令排在同一个池里\
                 （用户 2026-10-14 真机）。交回 spawn_blocking，写法与同链另三格一致。"
            );
            assert!(
                b.contains(awaited),
                "`{what}` 包进了 spawn_blocking 却没等它（缺 `{awaited}`）：丢掉 JoinHandle = 慢活照跑，\
                 但状态机永远不推进 ⇒ 传输停在完成前一秒，既没有 file-done 也没有失败终态。"
            );
            assert!(
                !b.contains(legacy),
                "`{what}` 的旧写法又出现了（`{legacy}`）：这一格不许跑在 async worker 上。"
            );
        }
        // 分母：这两册里"池化"的次数各自钉死（相等而不是 `>=`）。
        // 为什么用相等：这一族是"同一条根因有四个家"里唯一会**自己长新家**的地方 ——
        // 有人在这里新增一处慢活却忘了包，`>=` 会放过去；相等逼作者要么搬进池里、要么把这一格数上来。
        assert_eq!(
            chunk.matches("tokio::task::spawn_blocking(").count(),
            3,
            "`handle_relay_chunk` 现数到的 spawn_blocking 与登记的 3 次（重组 / 整份哈希 / 落盘）不符"
        );
        assert_eq!(
            push.matches("tokio::task::spawn_blocking(").count(),
            1,
            "`relay_push_file` 现数到的 spawn_blocking 与登记的 1 次（发送前整份哈希）不符"
        );
    }

    /// **INV-P34 的分母**：全生产码里"整份文件级慢活"只许出现在登记过的那几个家，
    /// 而且每一处都必须被 `spawn_blocking` 包着。
    ///
    /// 为什么不满足于上一条按文件锚定的守卫：这条根因**已经复发过四次**，而按文件/按函数锚定的守卫
    /// 对新分册、对新函数一律看不见 ⇒ 下一次复发照样全绿（4.40.3 那一条就是这么漏掉续传那一格的）。
    /// 所以这条按**形状**扫整个 `src/`。
    ///
    /// 判据词法可判定：**一个 `async fn` 体内出现的慢活调用，它前面最近的一次 `spawn_blocking(`
    /// 与它之间不许出现 `.await`**（出现了就说明"这活是在当前 worker 上跑的、那次 await 之后才轮到下一格）。
    ///
    /// ⚠️ 诚实边界：这条看得见 `add_chunk(` 这种"同步 helper 里藏着 GB 级 fsync"的间接形状，
    /// **靠的是 helper 的名字在清单里**。以后新增一类整份慢活（新 helper 名），这条守卫看不见它 ——
    /// 所以清单本身就是法条的一部分，加名字时要在 `docs/migration-ledger.md` 第 13 行说一句。
    #[test]
    fn whole_file_slow_work_never_runs_on_an_async_worker() {
        // `std::fs::copy(` 是 2026-10-15 补的第八个：收藏 / 另存为拷的都是**没有体积上限**的整份文件。
        // 反过来，`std::fs::read(` 不进来 —— 它和"读一份 8 KB 配置"字面同形，按字面数会把尺子稀释成
        // 噪声；预览那三格的真有界性由同一体内的 `max_bytes.min(15 MiB)` 保证，那是**契约**不是尺子。
        const PRIMITIVES: [&str; 10] = [
            "sha256_file_hex(",
            "sync_all()",
            "add_chunk(",
            "resume_receive(",
            "finish_receiver_into(",
            "finish_group_receive_into(",
            "move_received_file(",
            "std::fs::copy(",
            // 4.40.6 补的第九个名字：按名字它**只**表示"整棵树删除"（不会与"读 8 KB 配置"
            // 那种小活儿字面同形），所以进清单不制造噪声。现算生产码 12 处里 9 处在
            // `#[cfg(test)]` 的测试体内、一处是 `Drop`（不扫），剩下 3 处全在同一个
            // async 命令体内 —— 复跑 `grep -rn "std::fs::remove_dir_all(" src-tauri/src`。
            "std::fs::remove_dir_all(",
            // 4.40.6 同一轮补的第十个名字。为什么**必须**有它：把整棵树删除抽进一个同步
            // helper（`clear_dir_contents`）之后，`std::fs::remove_dir_all(` 在受扫体内出现 0 次、
            // 尺子判绿 —— 这正是台账第 13 行写的盲区①「同步 helper 里藏着整份慢活」的第一次真实命中。
            // 登记 helper 自己的名字，才拦得住「以后有人把它直接搬回 async 体里就地调」。
            // 复跑：grep -rn "clear_dir_contents(" src-tauri/src/commands/favorites.rs
            "clear_dir_contents(",
        ];
        // 登记好的"家"（顺序即排序后的比较顺序）。
        let registered: Vec<&str> = vec![
            "commands/favorites.rs",
            "commands/group_announcements.rs",
            "commands/group_todo_media.rs",
            "commands/helpers.rs",
            "commands/mobile_picker.rs",
            // 4.40.9 群台账一次性补账：候选闸之后的那份整文件哈希（在 spawn_blocking 里、且等它）。
            "network/file/ledger_backfill.rs",
            "network/file/receive.rs",
            "network/file/relay_push.rs",
            "network/file/send.rs",
            "network/transport/group_file.rs",
            "network/transport/handle_file.rs",
            "network/transport/relay_file.rs",
        ];
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        let mut stack = vec![src_root];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if p.is_dir() {
                    // `gen/` 是 Tauri 生成的工程壳（android/ios 里有整份第三方源码），不是本仓生产码。
                    if name != "gen" {
                        stack.push(p);
                    }
                } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
                    files.push(p);
                }
            }
        }
        files.sort();
        let mut offenders: Vec<String> = Vec::new();
        let mut homes: Vec<String> = Vec::new();
        let mut total = 0usize;
        for f in &files {
            let Ok(raw) = std::fs::read_to_string(f) else { continue };
            // 与 `rust_fn_body` 同一条归一化：Windows 上 git 会检出成 CRLF，不归一化就看不见收尾锚点。
            let norm = raw.replace("\r\n", "\n");
            // 只剥整行注释，**保留换行**（收尾锚点 `\n}` 靠它）。
            // ⚠️ 判「是不是注释」要剥前导空白，但**留下的那一行必须保持原样**：
            // 收尾锚点靠的是第 0 列的 `}`。一旦把每行 trim_start，每个函数体都会在
            // 第一个内层 `}` 处被腰斩 ⇒ 尺子读到 0 处、offenders 恰好为空 = 假绿
            // （本轮实测踩过：同一条规则 python 版读到 10 处，Rust 版读到 0 处）。
            let kept: Vec<&str> = norm
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
                })
                .collect();
            let body = kept.join("\n");
            let full = f.to_string_lossy().replace('\\', "/");
            let rel = full.rsplit("/src/").next().unwrap_or(&full).to_string();
            let mut hit_here = false;
            // 「跑在池上的体」有两种（2026-10-15 补第二种，此前整格看不见）：
            // ① `async fn`；② 挂了 `#[tauri::command(async)]` 的**同步 fn**。
            // 第二种不是豁免：读过锁定版本源码 —— 宏对 `ExecutionContext::Async` 一律生成
            // `respond_async_serialized(async move { 函数(...) })`（tauri-macros 2.6.3
            // `command/wrapper.rs:249`），而那个 future 被 `async_runtime::spawn` 投递
            // （tauri 2.11.5 `ipc/mod.rs:375`） ⇒ 同步命令体同样占 tokio worker。本仓
            // `lib_window_tests.rs:225` 那条守卫自己的依据句写的就是这一句，此前 INV-P34 却
            // 反过来把它当成"已在池外"，于是 favorites / helpers / group_todo_media 三处漏网。
            let mut segs: Vec<(usize, usize)> = Vec::new();
            let mut at = 0usize;
            while let Some(k) = body[at..].find("async fn ") {
                let start = at + k;
                let end = body[start..]
                    .find("\n}")
                    .map(|i| start + i)
                    .unwrap_or(body.len());
                segs.push((start, end));
                at = start + "async fn ".len();
            }
            {
                const MARKER: &str = "command(async)]";
                let mut at = 0usize;
                while let Some(k) = body[at..].find(MARKER) {
                    let from = at + k + MARKER.len();
                    let Some(f) = body[from..].find("fn ") else {
                        at = from;
                        continue;
                    };
                    let start = from + f;
                    // 紧贴的已是 `async fn` ⇒ 上面那一支数过了，这里不重复数。
                    if body[from..start].contains("async") {
                        at = start;
                        continue;
                    }
                    let end = body[start..]
                        .find("\n}")
                        .map(|i| start + i)
                        .unwrap_or(body.len());
                    segs.push((start, end));
                    at = start + MARKER.len();
                }
            }
            for (start, end) in segs {
                let seg = &body[start..end];
                for pr in PRIMITIVES {
                    let mut p = 0usize;
                    while let Some(j) = seg[p..].find(pr) {
                        let call = p + j;
                        total += 1;
                        hit_here = true;
                        let wrapped = seg[..call]
                            .rfind("spawn_blocking(")
                            .map(|i| !seg[i..call].contains(".await"))
                            .unwrap_or(false);
                        if !wrapped {
                            offenders.push(format!(
                                "{rel}  [{pr}]  ← 跑在池上的体内、前面最近的 spawn_blocking 与它之间已经 .await（或根本没有）"
                            ));
                        }
                        p = call + pr.len();
                    }
                }
            }
            if hit_here {
                homes.push(rel);
            }
        }
        // 阳性对照（本仓吃过"检索条件写窄、把存在筛成不存在"的亏）：尺子空转时 offenders 也是空的。
        assert!(
            files.len() > 100,
            "生产码只现数到 {} 个 .rs —— 目录走错了，这条守卫是在空集上恒绿",
            files.len()
        );
        assert_eq!(
            total,
            18,
            "整份慢活现数到 {total} 处、登记 18 处。对不上时先分清哪一种：\\n             ① 新增的是**合规**的一格（也在池里跑）⇒ 把这一格数与 `homes` 清单一起改上来，\\n             ② 新增的是**没包的** ⇒ 先搬进 spawn_blocking（同链已有 18 处写法可抄），\\n             ③ 改了 helper 的名字 ⇒ PRIMITIVES 清单要同步，否则这条法就悄悄少了一格。"
        );
        assert!(
            offenders.is_empty(),
            "INV-P34：整份文件级慢活不许跑在 tokio worker 上（同一个 runtime 还排着所有 async 开窗命令；\\n             本机实测流式 SHA-256 ≈ 1 GB/s ⇒ 3 GB 就是约 3 秒「点设置没窗、拖窗口没反应」）。\\n             命中 {} 处：\\n{}",
            offenders.len(),
            offenders.join("\n")
        );
        assert_eq!(
            homes,
            registered,
            "整份慢活的「家」清单与登记不一致（现数 {} 个 / 登记 {} 个）。新增一册就把那一册登记进来，\
             并在 `docs/migration-ledger.md` 第 13 行说一句 —— 没登记就红是刻意的：\
             这条根因复发过四次，前三次都因为守卫按文件锚定而没看见新家。",
            homes.len(),
            registered.len()
        );
    }

    /// **卡片类落库失败不许被静默吞掉**（2026-10-16 稳定性体检那一族的护栏）。
    ///
    /// 这一族的失败形状既不崩也不报错：那条消息/那张卡从此不存在，或者 `content.path` 永远缺着
    /// ⇒ 预览被判成"已被清理"并**永久缓存**（负责人报的"气泡没出现 / 图片打不开而日志一字不记"）。
    /// 14 处里 5 处本来就向上报错（`?` / `.map_err`），**9 处是这两轮改成留痕的**（上一批 5 处 + 本轮 4 处，
    /// 其中两处正是上一批漏在同一文件另一面的第二面）。这条判据负责拦**下一次复发**，包括复发在一家我从没见过的文件里。
    /// （第 14 处是 2026-10-16 群历史同步新加的 `db/group_history.rs::apply_group_history_page`：
    ///  一页里逐行 `insert_message_if_new(...) ?` 上抛，引擎据此判"没跑完"并**不写完成标记**。）
    ///
    /// 为什么按**括号配对**取调用尾部而不是按行窗口 / 按 `;` 切语句：多行实参是常态
    /// （`update_message_content` 那一句就跨四行），按 `;` 切会把 `match` 与块表达式腰斩，
    /// 按行取窗口会漏 —— 本仓已经吃过"单行正则数跨行 `expect(...)` 返回 0"的亏。
    ///
    /// 允许名单只有四种（其余一律算吞）：`?`、`.map_err`、调用前是 `if let Err(e) =`、
    /// 或调用前把 `Result` 赋给变量交给三态判据（`let inserted =` / `let backfilled =`）。
    /// `.unwrap()` / `.expect()` **故意不在名单里**：那会 panic 在 `reader_loop` 或命令体上，比留痕更糟。
    ///
    /// 明写的三条边界（不装作它管一切）：
    /// ① 认的是"紧跟调用的那 24 个字符" ⇒「先存进一个不在名单里的变量、到别处才 `.ok()`」它看不见，
    ///    那一半由 `total_sites` 钉住：新增或改写调用点必须让分母跟着变，逼作者来这里看一眼。
    /// ② `if let Err(e) = …` 那一臂如果被人**清空**并把变量改名成 `_e`，本判据仍然判绿 ——
    ///    那种形状由 `cargo clippy -D warnings` 的 unused-variable 拦（不改名就红），不由这条判据管。
    ///    M-B 那笔变异（把 `Err(e)` 臂的留痕摘掉）之所以红，是因为它落在了 `match` 那一支上，
    ///    而 `match` 这一支判的是"Err 臂里到底有没有 logger"，不是"有没有 Err 臂"。
    /// ③ 只认这五个名字 ⇒ 以后新增一类"卡片类落库"函数（例如 `insert_notice_message`），
    ///    不进 NAMES 就看不见；这与 INV-P34 分母的盲区①是同一条，加名字时连同本注释一起改。
    #[test]
    fn card_message_writes_never_swallow_their_error() {
        const NAMES: [&str; 5] = [
            "insert_message_and_outbox(",
            "insert_message_if_new(",
            "insert_message(",
            "update_message_content(",
            "fill_message_sha256(",
        ];
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        let mut stack = vec![src_root];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if p.is_dir() {
                    if name != "gen" {
                        stack.push(p);
                    }
                } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs"
                {
                    files.push(p);
                }
            }
        }
        files.sort();
        let mut offenders: Vec<String> = Vec::new();
        let mut total_sites = 0usize;
        for f in &files {
            let Ok(raw) = std::fs::read_to_string(f) else { continue };
            let norm = raw.replace("\r\n", "\n");
            // 去注释但保留换行（与本族另两条判据同一条规矩）。
            let code: String = norm
                .lines()
                .map(|l| {
                    let t = l.trim_start();
                    if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                        ""
                    } else {
                        match l.find("//") {
                            Some(i) => &l[..i],
                            None => l,
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            // 全程按 char 走，不按 byte：这些文件里大量中文串，字节下标与 char 下标不等价。
            let mut chars: Vec<char> = code.chars().filter(|c| !c.is_whitespace()).collect();
            // 内联 `#[cfg(test)] mod …{…}` 整段抹掉：本仓测试多数住在 `*_tests.rs`（上面已按文件名跳过），
            // 但 `db/groups.rs`、`db/clocks.rs` 里还有历史遗留的内联测试模块，那里 `.unwrap()` 是**对的**
            // （测试该 panic）。不抹就会把六处测试代码报成生产缺陷 ⇒ 而"判据一片假红"的下一步
            // 通常是有人把它放宽，那才是真损失。
            let mut at = 0usize;
            while let Some(pos) = find(&chars, at, "#[cfg(test)]") {
                let Some(m) = find(&chars, pos, "mod") else { break };
                let Some(o) = find(&chars, m, "{") else { break };
                let Some(c) = brace_close(&chars, o) else { break };
                for slot in &mut chars[m..=c] {
                    *slot = '_';
                }
                at = c + 1;
            }
            for nm in NAMES {
                let mut at = 0usize;
                while let Some(call) = find(&chars, at, nm) {
                    at = call + 1;
                    let pre: String = chars[..call].iter().collect();
                    if pre.ends_with("pubfn") || pre.ends_with("fn") {
                        continue; // 定义自身
                    }
                    // **定义体内部的转调不算一家**：`pub fn insert_message(conn, m)` 的函数体就是
                    // `insert_message_if_new(conn, m).map(|_| ())` —— 一句薄包装（`.map` 原样带着 Err 上抛）。
                    // 按" enclosing fn 是不是这几个名字之一"来认，而不是整册豁免 `db/messages.rs`：
                    // 豁免整册会让"以后有人在这册里新加一处吞错"从此看不见（那正是本轮在修的形状）。
                    if let Some(k) = pre.rfind("fn") {
                        let id: String = chars[k + 2..]
                            .iter()
                            .take_while(|c| c.is_alphanumeric() || **c == '_')
                            .collect();
                        if NAMES.iter().any(|n| *n == format!("{id}(")) {
                            continue;
                        }
                    }
                    total_sites += 1;
                    let open = call + nm.len() - 1;
                    let Some(close) = brace_close(&chars, open) else {
                        offenders.push(format!(
                            "{}  [{nm}]  ← 圆括号没配对上（判据自己读不动这一处，必须人工看）",
                            f.display()
                        ));
                        continue;
                    };
                    let tail: String =
                        chars[close + 1..(close + 25).min(chars.len())].iter().collect();
                    let head: String = chars[call.saturating_sub(16)..call].iter().collect();
                    let handled = head.contains("ifletErr(e)=")
                        || head.contains("letinserted=")
                        || head.contains("letbackfilled=")
                        || tail.starts_with('?')
                        || tail.starts_with(".map_err(")
                        // `match <调用> { Ok(..) => .., Err(..) => { 记一笔 } }`：认**尾部形状**而不是
                        // 认 head 里的 `match` —— 扁平化后 `match` 会被路径粘住（`matchdb::fill_…`），
                        // 按 head 认关键字是"我以为的实现形状"那种错法（本仓吃过同形的一次）。
                        || (tail.starts_with("{Ok(") && match_logs_err(&chars, close + 1));
                    if !handled {
                        offenders.push(format!(
                            "{}  [{nm}]  尾部 {tail:?} 头部 {head:?} —— 结果既没向上报错也没有留痕",
                            f.display()
                        ));
                    }
                }
            }
        }
        assert!(
            files.len() > 100,
            "生产码只现数到 {} 个 .rs ⇒ 目录走错了，这条判据是在空集上恒绿",
            files.len()
        );
        assert_eq!(
            total_sites, 14,
            "卡片类落库点现数到 {total_sites} 处、登记 14 处。对不上先分清哪一种：\
             ① 新增了一家 ⇒ 它也必须要么向上报错、要么留痕，再把这一格数改上来；\
             ② 有人把某处的形状改了（比如从 `if let Err` 换成先存变量）⇒ 上面那份允许名单要一起改，\
             不许只改登记数让它继续空转；\
             ③ 新增了内联 `#[cfg(test)]` 模块 ⇒ 抹除那一步要一起看。"
        );
        assert!(
            offenders.is_empty(),
            "落库失败不许静默吞掉（`.ok()` / `let _ =` / `.unwrap_or(_)` / 裸丢弃都算）——\n\
             这一族这两轮已改过九家（另 4 处本来就向上报错）；命中 {} 处：\n{}",
            offenders.len(),
            offenders.join("\n")
        );
    }

    /// `match <调用> { Ok(..) => .., Err(..) => { 记一笔 } }` 这一族：
    /// **Err 臂里真的调了 logger** 才算留痕 —— `match … { Err(_) => false }` 就是吞
    /// （本仓 `network/file/send.rs` 在 2026-10-16 之前是 `.unwrap_or(false)`，同一个形状的两种写法）。
    fn match_logs_err(chars: &[char], after_call: usize) -> bool {
        // 紧跟调用右括号的必须是 match 的那个左花括号（不然 `match` 认的是别的东西）
        if find(chars, after_call, "{") != Some(after_call) {
            return false;
        }
        let Some(close) = brace_close(chars, after_call) else {
            return false;
        };
        let seg: String = chars[after_call..=close].iter().collect();
        seg.contains("Err(") && seg.contains("logger.")
    }

    /// 在 `chars` 里从 `from` 起找一段 ASCII 字面量（判据只找自己写的这些名字，全是 ASCII）。
    fn find(chars: &[char], from: usize, needle: &str) -> Option<usize> {
        let n: Vec<char> = needle.chars().collect();
        if n.is_empty() || from + n.len() > chars.len() {
            return None;
        }
        (from..=chars.len() - n.len()).find(|&i| chars[i..i + n.len()] == n[..])
    }

    /// 从 `open`（必须是左括号/左花括号）起做配对，返回匹配的右括号下标。
    fn brace_close(chars: &[char], open: usize) -> Option<usize> {
        let mut depth = 0usize;
        for i in open..chars.len() {
            match chars[i] {
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// ★ **能让进程消失的路径，消失之前必须留一行。**
    ///
    /// 为什么单独钉这一族（2026-10-16 真机）：那台机器上同时存在两种死法，异常码都是 `0xc0000409`
    /// （`__fastfail`）—— 一种是 panic（`panic = "abort"` 走 abort），另一种是**分配失败**
    /// （`handle_alloc_error` → abort，**根本不经过 panic 钩子**）。不留痕就永远分不开，
    /// 而"分不开"的代价是把内存耗尽当成代码 bug 去查。
    ///
    /// 四条各管一件事，全部按**站点数**钉，不是"存在即通过"：
    /// ① 生产码里每一处 `std::process::exit(` 前面 8 行内必须有 `crash_note(` —— 现在钉 1 处
    ///    （托盘那条 1.5s 兜底硬退；它在用户那边**看起来就是一次闪退**，不留痕就会被当成崩溃）。
    /// ② 必须有 `#[global_allocator]` 包装，且它的失败路径调 `crash_note`。
    /// ③ panic 钩子必须有"还没有 logger 也要写"那一臂（`if !recorded`）。
    /// ④ bootstrap 插件必须注册在单实例守卫**之前** —— 守卫会在 logger 建立之前就 `exit(0)`，
    ///    顺序错了这条通道等于白装（"注册顺序就是功能"的实例）。
    ///
    /// ⚠️ 已知盲区：只认字面 `std::process::exit(`；`std::process::abort()` 与**依赖里**的 exit
    ///    （单实例守卫那条就在插件里）扫不到 —— 后者由 ④ 的顺序 + 启动留痕兜住。
    #[test]
    fn no_path_can_end_the_process_without_leaving_a_note_first() {
        let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        let mut stack = vec![src_root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let pth = e.path();
                let name = pth
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if pth.is_dir() {
                    if name != "gen" {
                        stack.push(pth);
                    }
                } else if name.ends_with(".rs")
                    && !name.ends_with("_tests.rs")
                    && name != "tests.rs"
                {
                    files.push(pth);
                }
            }
        }
        files.sort();

        let mut exit_sites = 0usize;
        let mut naked: Vec<String> = Vec::new();
        for f in &files {
            let Ok(raw) = std::fs::read_to_string(f) else { continue };
            // 去注释：守卫自己的注释里也写着这两个字面串，不剥就会自己判自己绿。
            let norm = raw.replace("\r\n", "\n");
            let lines: Vec<&str> = norm
                .lines()
                .map(|l| {
                    let t = l.trim_start();
                    if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                        ""
                    } else {
                        l
                    }
                })
                .collect();
            for (i, l) in lines.iter().enumerate() {
                if l.contains("std::process::exit(") {
                    exit_sites += 1;
                    let from = i.saturating_sub(8);
                    if !lines[from..=i].iter().any(|x| x.contains("crash_note(")) {
                        naked.push(format!("{}:{}", f.display(), i + 1));
                    }
                }
            }
        }
        assert_eq!(
            exit_sites, 1,
            "生产码里 `std::process::exit(` 的站点数变了（现在钉 1 处 = 托盘 1.5s 兜底）\
             ⇒ 多出来的那一处必须先按同样形状留痕，再把这里改到位"
        );
        assert!(naked.is_empty(), "这些硬退前面没有 crash_note ⇒ 退出会静默：{naked:?}");

        let lib_raw = std::fs::read_to_string(src_root.join("lib.rs")).expect("lib.rs 必须读得到");
        let lib_norm = lib_raw.replace("\r\n", "\n");
        let lib: Vec<&str> = lib_norm
            .lines()
            .map(|l| {
                let t = l.trim_start();
                if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') {
                    ""
                } else {
                    l
                }
            })
            .collect();
        let libj = lib.join("\n");
        assert!(
            libj.contains("#[global_allocator]"),
            "分配失败不经过 panic 钩子 —— 没有 global_allocator 包装，这一族死法就永远没有记录"
        );
        assert!(
            libj.contains("crash_note("),
            "分配器包装必须真的调 crash_note，光有 #[global_allocator] 是空壳"
        );
        assert!(
            libj.contains("if !recorded"),
            "panic 钩子少了\u{201c}还没有 logger 也要写\u{201d}那一臂 ⇒ 启动早期崩就是静默"
        );
        let boot = libj
            .find("crash_bootstrap_plugin()")
            .expect("bootstrap 插件没注册 ⇒ 现场路径要等 logger 建好才绑得上");
        let single = libj
            .find("tauri_plugin_single_instance::init(")
            .expect("单实例守卫注册点不见了（这条顺序判据要跟着重写，不是删掉）");
        assert!(
            boot < single,
            "bootstrap 必须排在单实例守卫**之前**：守卫会在 logger 建立之前就 exit(0)，\
             顺序反了这条留痕通道永远来不及绑"
        );
    }
