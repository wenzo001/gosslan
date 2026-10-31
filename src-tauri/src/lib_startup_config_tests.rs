// 职责边界：
// - `lib_tests.rs` 测试分册之10 —— 启动与配置：降级拒绝早于写、锁内不 await、符号链不吃、开关读持久值
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
    /// 启动期"数据比本机新 ⇒ 拒绝打开"这条路径的三个形状都必须钉住（AI_RULES §13）。
    ///
    /// ① **判定早于任何写操作**：`execute_batch(SCHEMA)` 是 `CREATE TABLE IF NOT EXISTS`，
    ///    看着无害，但它确实写文件；先写再判，`downgrade_message()` 里"数据没有被修改"就成了
    ///    谎话，而用户正是凭这句话决定"可以放心装新版本"。（回归过的位置：v4.22.36 之前
    ///    判定在 `run_migrations` 里 = SCHEMA 之后。）
    /// ② **调用方按类型分支**，不许 `to_string().contains("user_version")` —— 协议层已经
    ///    因为按错误字符串分类吞过一整条消息（INV-P24 第 2 条，v4.22.34）。
    /// ③ **弹窗只能非阻塞**：`blocking_show()` 的桌面实现是 `run_on_main_thread`
    ///    （tauri-plugin-dialog-2.7.3/src/desktop.rs:222），而 `setup` 正跑在主线程上 ⇒
    ///    排在队列里的弹窗永远执行不到 = 开机自锁，与 v4.22.30 修掉的 Windows 开窗卡死
    ///    同一个形状。写错成 blocking 版本不会报错，只会**永远白屏**，所以必须机器拦。
    #[test]
    fn boot_downgrade_refusal_is_typed_precedes_writes_and_non_blocking() {
        /// 只留**代码行**：这条守卫判的是"有没有真的调用"，注释里提到 API 名字是
        /// 常事（本条第一次跑就被自己的注释判红了），所以先把行注释剥掉 ——
        /// 既不让散文误伤守卫，也不让散文冒充成实现。
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        let db = code_only(include_str!("db.rs"));
        // ⚠️ 只取**测试模块之前**那段代码：守卫自己就在 lib.rs 里，全文一起扫的话
        // 下面这几个字面串会先命中守卫自己的源码 —— 正判据永远为真、负判据永远为假，
        // 这条守卫会变成看着严密实际空转的那种。
        let lib = code_only(
            include_str!("lib.rs")
                .split("#[cfg(test)]")
                .next()
                .unwrap_or_default(),
        );

        let check = "if current > DB_VERSION";
        // DB-01 之后 SCHEMA 的应用点收进 `apply_base_schema_atomically`（同一个 DDL 事务），
        // 它仍然是"第一次写文件"的位置 ⇒ 降级判定必须排在它前面。
        let write = "apply_base_schema_atomically(&conn, SCHEMA, is_fresh.then_some(DB_VERSION))?;";
        assert_eq!(
            db.matches(check).count(),
            1,
            "降级判定全仓只许一处（第二处迟早与第一处口径不同）"
        );
        assert_eq!(
            db.matches(write).count(),
            1,
            "本机 schema 只许在一处写入，否则这条顺序断言无法判定位置"
        );
        assert!(
            db.find(check).unwrap() < db.find(write).unwrap(),
            "降级判定必须早于应用 SCHEMA（首次写文件）：先写再判 = 「数据未被修改」是谎话"
        );

        assert!(
            lib.contains("downcast_ref::<db::InitError>()"),
            "启动期必须按 db::InitError 类型分支，而不是按错误字符串猜"
        );
        assert!(
            !lib.contains("blocking_show"),
            "主线程上 blocking_show() 会自锁（弹窗任务排在被钉住的主线程队列里）"
        );
        assert!(
            lib.contains(".show(move |_|"),
            "降级提示必须非阻塞排队 + 提前 return，让主线程回到事件循环"
        );
    }

    /// 不得「先绑定 `links` 守卫、再在循环里 await 发送」。
    ///
    /// `links` 是 `tokio::sync::Mutex`，跨 await 持锁**编译器不拦**，而发送目标都是有界队列
    /// （1024）：对端僵死（半开 TCP / 休眠 / 写缓冲满）时 `send().await` 会一直挂起却握着
    /// 全局 links 锁 ⇒ try_send、心跳、get_peers、mark_peer_offline、teardown_link 以及
    /// 看门狗全部阻塞。看门狗恰恰是唯一能发 cancel 拆掉那条卡死连接、让队列排空的机制，
    /// 它被同一把锁挡住就是自锁死循环，只能靠用户手动重开局域网。
    /// 正确写法：锁内只 `clone` 发送端快照，发送放到锁外（与心跳发送同一纪律）。
    #[test]
    fn never_awaits_while_holding_the_links_lock() {
        let cmds = all_commands_src();
        for f in [
            "pub async fn update_profile(",
            "pub async fn broadcast_chat_style(",
        ] {
            let body = rust_fn_body(cmds, f);
            assert!(
                !body.contains("for link in links"),
                "{f} 又回到「持有 links 守卫时 await 发送」的写法：\
                 队列有界，对端僵死会让 send().await 永久挂起并握着全局 links 锁，\
                 连看门狗都拿不到锁 ⇒ 网络层自锁死。必须先 collect 发送端快照、再在锁外发送。"
            );
        }
    }

    /// transport 生产代码的 std Mutex 一律**抗中毒**取锁（审计 A8）。
    ///
    /// 全仓主导写法是 `.lock().unwrap_or_else(|e| e.into_inner())`（`state.rs` 的注释也明令"不要写
    /// `.lock().unwrap()`"），但 `network/transport.rs` 曾留了 11 处多行链式 `.lock().unwrap()`。
    /// 后果：全仓没有 `catch_unwind` ⇒ 一次锁中毒 panic 会带走 `reader_loop` 并**跳过它紧接着的收尾**
    /// （`links.remove` / `mark_peer_offline` / 接收器清理），于是那条连接的对端在界面上永久显示"在线"。
    ///
    /// 判据：**去掉所有空白后**扫 transport 全集视图，不得出现 `.lock().unwrap()` —— 一并覆盖单行与
    /// 多行链式两种写法。为什么能整文件扫而不误伤测试：transport.rs 与各 `transport/*.rs` 分册的
    /// `#[cfg(test)]` 模块本来就不用这个写法（实测 0 处），test 代码里的 4 处都在 `file.rs`/`logs_tests.rs`
    /// （不在这份视图里），测试可以合理地对中毒 panic。
    #[test]
    fn transport_locks_tolerate_poison() {
        let src = crate::network::transport_src_for_guards();
        let flat = src.split_whitespace().collect::<String>();
        assert!(
            !flat.contains(".lock().unwrap()"),
            "transport 生产代码里出现 `.lock().unwrap()`：一次中毒 panic 会带走 reader_loop、跳过收尾，\
             对端永久\"在线\"（审计 A8）。改用 `.lock().unwrap_or_else(|e| e.into_inner())`。"
        );
    }

    /// 缓存清理器的目录遍历**绝不跟随符号链接**（2026-09-23 审计 1.1）。
    ///
    /// 后果链：缓存目录是远端输入可达面（收到的文件名/目录名不受信）。旧实现用
    /// `e.path().metadata()` 判类型 —— 它**跟随软链**：缓存里一个指向任意位置的软链
    /// （文件或目录）会让其目标被收集进清理列表并 `remove_file` **永久删除**，
    /// 报告里只算"清理了多少缓存"。这是全仓唯一确认的数据丢失点。
    ///
    /// 判据：`walk_files` 体内必须用 `DirEntry::file_type()`（不跟随链接）判真身，
    /// 且不得出现 `e.path().metadata()`（跟随链接的旧写法）。
    #[test]
    fn cache_cleaner_walk_never_follows_symlinks() {
        let src = include_str!("storage/cache_cleaner.rs");
        let body = rust_fn_body(src, "pub fn walk_files(");
        assert!(
            body.contains("e.file_type()"),
            "walk_files 必须用 DirEntry::file_type()（不跟随软链）判文件真身（审计 1.1）"
        );
        assert!(
            !body.contains("e.path().metadata()"),
            "walk_files 里出现 e.path().metadata()：它跟随符号链接，软链目标会被当缓存删除（审计 1.1）\
             —— 数据丢失，不是清理"
        );
    }

    /// **headless 开关不许覆盖用户显式关掉的局域网**（2026-09-27，根因级修法）。
    ///
    /// 现场：2026-09-26 有一条产品结论"关掉局域网发现还能被别人学到"，复跑发现**那个实例从来没真的
    /// 关掉过** —— 启动路径写的是 `if forced || enabled`，`GOSSLAN_AUTOSTART=1` 把库里的"关"覆盖成"开"。
    /// 现在这个 env 只剩一件事可做：**选绑定地址**（0.0.0.0），"开不开"只由持久化偏好决定。
    ///
    /// ⚠️ 这条钉的是源码形状（半个守卫）：换一种拼法（比如把 `forced` 并进 `enabled` 再判）它看不见。
    ///    真判据是"预置 lan_enabled='0' 的那个实例，对端日志里不该出现它的 announce" —— 那需要
    ///    单独一轮（第 4 处登记），已记在 roadmap #89，不在这里顺手接线。
    #[test]
    fn autostart_env_never_overrides_an_explicit_lan_off() {
        let src = include_str!("lib.rs");
        let at = src
            .find("GOSSLAN_AUTOSTART")
            .expect("启动路径必须还认这个 headless 开关");
        // 只看**测试模块之前**那一段：本条判据自己的字符串里就写着被禁的那种拼法，
        // 拿整份文件去 contains 会匹配到自己身上（第一次跑正是这么红的）。
        // 范围 = 整份 lib.rs。2026-09-28 之后成立的方式变了：测试整段搬进
        // `include!("lib_tests.rs")` 的那个文件，**lib.rs 里不该再有 `#[cfg(test)]`** ⇒ 判据不可能匹配到自己。
        // 这一格同时把"lib.rs 只许生产码"钉住：谁再往启动装配文件里塞测试模块，这里当场红。
        assert!(
            !src.contains("#[cfg(test)]"),
            "lib.rs 现在只该是生产码（测试在 lib_tests.rs）；出现测试模块意味着本条判据的范围要重新界定"
        );
        let test_at = src.len();
        assert!(
            at < test_at,
            "这个开关必须出现在启动路径里，而不是只活在测试里"
        );
        // 先抹掉行注释再匹配：本文件**启动块自己的注释**就写着"旧写法是 `if forced || enabled`"，
        // 不抹的话这条禁令会因为一段说明文字而永远红（同一族坑见 `cmd_w_is_handled_by_our_own_menu_item`）。
        let block: String = src[at..test_at]
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !block.contains("if forced || enabled"),
            "GOSSLAN_AUTOSTART 不许再把用户显式关掉的局域网判成开（那条假产品结论就是这么来的）"
        );
        // 2026-10-15 这条判据跟着启动块的形状改口（旧锚点是字面量 `if enabled {`）。
        // **判据的意思一个字没变**：开不开只由 db 里的 `lan_enabled` 决定。变的是实现形状 ——
        // 失败后不再有"一次就放弃"，而是每轮重新读这个键、由纯函数决定还试不试
        // （旧形状下用户在重试窗口里关掉开关会被下一次尝试覆盖；现在每一轮都重读）。
        assert!(
            block.contains("let enabled = {") && block.contains("crate::db::get_lan_enabled(&dbc)"),
            "开不开网络必须由 db 里的 lan_enabled 决定，而且这个键要在启动块里现读（不许拿进程启动时的快照）"
        );
        assert!(
            block.contains("should_keep_retrying_lan_autostart(running, enabled)"),
            "重试链的停止条件必须是 (通道已在跑 ⇒ 停) 或 (库里说关 ⇒ 停) 这两条之一；\
             把 enabled 换成常量 true 就是替用户联网，正是本条判据要拦的形状"
        );
        assert!(
            block.contains("let started = if forced {") && block.contains("\"0.0.0.0\""),
            "forced 剩下的职责必须是**选绑定地址**；它一旦无事可做就该整个删掉，而不是留着覆盖偏好"
        );
    }

    /// **通道偏好必须与运行状态分开表达**（用户 2026-09-14 桌面实测：关掉蓝牙、退出重进又被打开）。
    ///
    /// 根因：快照里 channels[bluetooth].enabled 用的是"运行时是否在跑"，应用刚启动、BLE 还没
    /// 拉起时必然是 false ⇒ 前端 ensureBluetoothOn 无法区分"用户明确关掉"与"还没启动"，
    /// 于是把偏好覆盖成开。判据：通道状态必须有独立的 preferred 字段，且快照从持久化键
    /// （lan_enabled / bt_enabled）填充。
    #[test]
    fn channel_status_exposes_persisted_preference() {
        let tm = include_str!("transport/mod.rs");
        assert!(
            tm.contains("pub preferred: bool"),
            "ChannelStatus 必须有独立的 preferred 字段（与 running 分开），否则前端只能拿运行状态猜偏好"
        );
        let cmds = all_commands_src();
        let body = rust_fn_body(cmds, "pub async fn build_runtime_snapshot(");
        assert!(
            body.contains("get_lan_enabled") && body.contains("get_bt_enabled"),
            "快照必须从持久化键填充 preferred（开机后偏好不能丢）"
        );
        assert!(
            body.contains("c.preferred"),
            "必须把 db 里的偏好写回通道状态"
        );
    }

    /// **系统通知必须真的发得出去、且能被观察**（用户 2026-09-14：Windows 同事收不到任何通知）。
    ///
    /// 三个必须同时成立的判据：
    /// 1. Rust 侧通知统一走 crate::notifications（能返回错误），不再用插件那个把错误 spawn
    ///    掉丢掉的 show()；
    /// 2. **不经前端**的好友申请/好友通过通知必须尊重 notify_enabled（否则关了通知还会被弹）；
    /// 3. 设置页要有能如实报告失败的“发送测试通知”入口，否则 Windows 上（未安装 / 勿扰）
    ///    永远只能靠猜。
    #[test]
    fn notifications_are_observable_and_respect_the_switch() {
        let transport = crate::network::transport_src_for_guards();
        assert!(
            !transport.contains("tauri_plugin_notification::NotificationExt"),
            "network 层不得再直接用插件的 show()（它把错误 spawn 掉丢了）—— 统一走 crate::notifications"
        );
        assert_eq!(
            transport.matches("crate::notifications::show").count(),
            2,
            "两处 Rust 侧通知（好友申请×1 + 好友通过×1）都必须走 notifications（含开关与错误）。\
             历史：原先是 4（两件事各在直连与跨跳写一遍）→ 2026-09-28 收成一个 `apply_friend_accept` \
             变 3 → 2026-10-14 申请也收成一个 `apply_friend_request` 变 2（真机缺陷：发送方每轮心跳\
             补发一份新 message_id 的信封，两处各弹各的通知 ⇒ 「加好友弹出很多个」）。\
             这个数字**只许因为又漏了一条路而变大**；「两条路径都走进那个家」由\
             lib_friend_identity_tests 的 every_friend_request_path_notifies_only_on_first_sighting \
             钉住，所以这里收窄不会放过漏掉某条路。"
        );
        let notif = include_str!("notifications.rs");
        assert!(
            notif.contains("pub fn show_if_enabled") && notif.contains("notify_enabled"),
            "notifications 必须提供“尊重总开关”的入口"
        );
        assert!(
            notif.contains("map_err(|e| e.to_string())"),
            "notify-rust 的错误必须返回出来，不能吞"
        );
        let commands = all_commands_src();
        // 锚点只到 `fn 名字(`（这条现在是 `async fn` + spawn_blocking，审计 R-18）：
        // 光看签名会在"换形状而语义没变"时红，而真正要防的事故是**没注册进 generate_handler!**
        // —— 那才是前端一调就 command not found 的形状（与 mapContract 在前端侧钉的是同一条）。
        assert!(
            commands.contains("fn send_test_notification("),
            "必须有设置页可调用的测试通知命令"
        );
        assert!(
            include_str!("lib.rs").contains("commands::send_test_notification,"),
            "测试通知命令必须注册进 generate_handler! —— 前一条只证明它存在，不证明前端调得到"
        );
    }

    /// **第二次启动不许再起一份完整应用**（用户 2026-10-14：「点了一下弹出加好友的那个，
    /// 然后就又弹出另一个聊天主框 —— 同时启动了两个程序」）。
    ///
    /// 为什么这是唯一可能的形状：一个进程内造不出第二个"聊天主框"——
    /// `main` 只来自 `tauri.conf.json` 那一份窗口声明，`WebviewWindowBuilder` 全仓只有
    /// `commands/logs.rs` 的五处辅助窗在用，前端 0 处 `new WebviewWindow`（`lib_window_tests.rs`
    /// 还钉着"谁都不许按 label 分支渲染聊天"）。所以看到两扇主框 = **两个进程**，
    /// 各自有独立的托盘图标、数据库句柄与 mesh 身份 —— 同一条好友申请会被两个进程
    /// 各弹一次通知，这同时放大了"加好友弹出很多个"。
    ///
    /// ⚠️ 守卫**必须给开发/测试的双实例出口留活路**：`scripts/e2e/core.mjs` 起实例时
    /// 带 `GOSSLAN_INSTANCE=<n>` + `GOSSLAN_AUTOSTART=1`，无条件守卫会直接废掉整条
    /// 双实例 E2E 路线（那是本仓唯一能证跨进程行为的一层）。
    #[test]
    fn second_launch_focuses_the_running_app_instead_of_duplicating_it() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("tauri_plugin_single_instance::init("),
            "没装单实例守卫 ⇒ 多点一次图标就是再起一份完整应用（用户报的那一格）"
        );
        let at = src
            .find("tauri_plugin_single_instance::init(")
            .expect("上面已判过");
        // 按**字节**切片会把中文注释劈成两半（`is_char_boundary` panic）。源码上下文
        // 只是给人看的窗口，先向内对齐到合法字符边界，再切。
        let mut start = at.saturating_sub(1_200);
        while start > 0 && !src.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = (at + 600).min(src.len());
        while end < src.len() && !src.is_char_boundary(end) {
            end += 1;
        }
        let around = &src[start..end];
        assert!(
            around.contains("allow_second_instance_launch("),
            "守卫必须走那个纯函数出口判定（开发/测试双实例靠它），不许无条件注册"
        );
        assert!(
            around.contains("crate::tray::show_main_window("),
            "第二次的正确结局是把已有主窗叫到前台 —— 而不是新建窗口、也不是静默退出"
        );
        // 依赖必须只在桌面三平台（插件上游不支持 android/ios，装上会让移动端编译失败）
        let cargo = include_str!("../Cargo.toml");
        let c = code_flat(cargo);
        assert!(
            c.contains("tauri-plugin-single-instance"),
            "Cargo.toml 缺 tauri-plugin-single-instance 依赖"
        );
        let lib_f = code_flat(src);
        assert!(
            lib_f.contains("cfg(all(desktop,any(target_os=\"macos\",windows,target_os=\"linux\")))"),
            "守卫与其依赖的 cfg 必须是同一组平台（不一致 = 移动端构建当场断）"
        );
    }

    /// 上面那条守卫的**放行出口**必须只认开发/测试那两个变量（真值表）。
    ///
    /// 为什么单独立一条：源码形状判据管得住"注册处走了这个函数"，管不住函数本身被改宽
    /// （比如顺手写成恒 `true` ⇒ 守卫变成装饰，用户还是会看到两个进程）。
    /// 而改窄会把双实例 E2E 整条路线关掉 —— 两个方向都要有读数。
    #[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]
    #[test]
    fn second_instance_exit_is_only_the_dev_multi_open() {
        // 真用户环境（两个变量都没设）⇒ 必须拦下来
        assert!(!allow_second_instance_launch(None, None));
        // 双实例 harness 那一档：带 GOSSLAN_INSTANCE ⇒ 放行
        assert!(allow_second_instance_launch(Some("2"), None));
        // headless 起绑定地址那一档：GOSSLAN_AUTOSTART=1 ⇒ 放行
        assert!(allow_second_instance_launch(None, Some("1")));
        // 反证：AUTOSTART 写成别的值不算多开出口（别把"任意非空"当放行）
        assert!(!allow_second_instance_launch(None, Some("0")));
        assert!(!allow_second_instance_launch(None, Some("yes")));
        // GOSSLAN_INSTANCE 只要存在（含空串）就算开发多开 —— 判的是"有没有这个出口"
        assert!(allow_second_instance_launch(Some(""), None));
    }

    /// CSP 必须是**严格**策略（审计 SEC-06 复审）。
    ///
    /// 事实修正：Tauri 2.12 在打包时会给内联 `<script>` 计算 sha256、给 `<style>` 注入
    /// nonce（`tauri-codegen` 的 `inject_script_hashes` / `inject_nonce_token`，本项目
    /// 没有开 `dangerousDisableAssetCspModification`）。CSP3 规定：script/style 里一旦出现
    /// nonce 或 hash，`'unsafe-inline'` 会被**忽略** ⇒ 之前那两个 `'unsafe-inline'` 在生产里
    /// 既没放宽也没买到东西，只是把配置写得不诚实。
    ///
    /// 这条只钉"配置在场 + 必要来源齐全 + 不含失效的 unsafe-inline"；真机是否零违规
    /// 仍由 `docs/notes/csp-candidate-2026-10-16.md` §三那组冒烟回答，本测试答不了那个。
    #[test]
    fn webview_csp_is_configured_with_the_sources_the_frontend_actually_needs() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            !conf.contains("\"csp\": null"),
            "csp 退回 null = 这一格回到缺陷原状（WebView 不设任何策略）"
        );
        for needle in [
            "default-src 'none'",
            "script-src 'self';",
            "style-src 'self';",
            "img-src 'self' blob: data:",
            "font-src 'self'",
            "media-src 'self' blob:",
            "connect-src 'self' ipc: http://ipc.localhost http://tauri.localhost blob:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(conf.contains(needle), "CSP 缺指令：{needle}");
        }
        // 内联脚本/样式由 Tauri 的 hash/nonce 放行；`'unsafe-inline'` 在这里是**失效的**，
        // 留着只会让人误读成"这一格放宽了"。谁要加回来，必须先改这条与决策文档。
        assert_eq!(
            conf.matches("'unsafe-inline'").count(),
            0,
            "严格 CSP 不许出现 'unsafe-inline'（它会被 Tauri 的 nonce/hash 忽略）"
        );
    }

    /// 窗口状态插件的恢复范围按**构建配置**分档（负责人 2026-10-26：「dev 起来默认就该是电脑端，
    /// 我拖到移动端才是移动端」）。
    ///
    /// 为什么这条必须钉住：dev 与安装包共用同一个 identifier ⇒ 同一份 `.window-state.json`。
    /// 插件无条件恢复 SIZE 时，"把窗口拖窄测移动端"会变成落盘的默认值（实测活的 dev 窗口
    /// 360×681，而移动端断点是 767px）—— 每次启动直接进移动端布局，`tauri.conf.json` 里
    /// 那个 1000×680 再也用不上，而且用户自己改不回来。
    ///
    /// 四格各判一件事：① dev 档 = `StateFlags::empty()`（既不存也不恢复）；② release 档四条
    /// 一条不少（HIG 那条"重开恢复窗口状态"是给正式版的，不能顺手一起删）；③  builder 读的
    /// 必须是那个按 cfg 分档的变量（把它改回硬编码 = 两档又合成一档，本条要红）；
    /// ④ 插件仍然要注册 —— 辅助窗的 `restore_aux_window_size` 走它的 `WindowExt::restore_state`，
    /// 摘掉插件会让那条路径整个失效（那才是真的"没记住尺寸"）。
    #[test]
    fn window_state_geometry_is_restored_only_in_release_builds() {
        /// 只留代码行：这条判的是"实际传进去的 flags"，而注释里写着 `StateFlags`、
        /// `restore_state` 这些名字（本仓已经被"判据读自己的注释"咬过两次）。
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        let src = code_only(include_str!("lib.rs"));
        assert!(
            src.contains(
                "#[cfg(debug_assertions)]\n        let window_state_flags = tauri_plugin_window_state::StateFlags::empty();"
            ),
            "dev 档没有把窗口状态 flags 收成 empty() ⇒ 开发构建会继续恢复上次几何（拖窄一次就永远是移动端）"
        );
        let rel = src
            .find("#[cfg(not(debug_assertions))]\n        let window_state_flags")
            .expect("找不到 release 档那条 `let window_state_flags`");
        let rel_body = &src[rel..rel + 520];
        for flag in ["SIZE", "POSITION", "MAXIMIZED", "FULLSCREEN"] {
            assert!(
                rel_body.contains(&format!("StateFlags::{flag}")),
                "release 档少了 {flag} ⇒ 正式版丢掉了「重开恢复窗口状态」这条原生体验"
            );
        }
        assert!(
            src.contains(".with_state_flags(window_state_flags)"),
            "builder 没有读那个按 cfg 分档的变量（改回硬编码 = dev/release 又合成同一档）"
        );
        assert!(
            src.contains("tauri_plugin_window_state::Builder::default()"),
            "插件不再注册 ⇒ 辅助窗的 restore_aux_window_size（WindowExt::restore_state）一起失效"
        );
    }

    /// A7：窗口状态文件必须**按实例分开**，而 0 号实例继续读旧版本那一份。
    ///
    /// 真实缺陷：`--instance` 只用来错开 DB/日志，插件的 `.window-state.json` 一直是共享的
    /// ⇒ 同目录里两个实例互相盖对方的几何（后保存的赢，先那个窗口的记忆当场没了）。
    ///
    /// 三格各判一件事：① 0 号 = **插件自己的常量**（不是手抄字面量 —— 旧版本就是按那个名字
    /// 落盘的，改名字等于让单实例用户"记住的尺寸"凭空消失，而这条只能靠"取同一个源"来保）；
    /// ② 任意两个不同的实例号不许撞到同一个文件名（这就是这次缺陷的形状本身）；
    /// ③ 名字必须是**单个路径段**（插件把它拼在 app data 目录下；带 `/`、`\`、`..` 会写到
    /// 别处或直接被拒 ⇒ 变成"没记住尺寸"，而且是一条静默的路径）。
    #[test]
    fn window_state_file_is_per_instance_and_keeps_the_legacy_default_name() {
        assert_eq!(
            window_state_filename(0),
            tauri_plugin_window_state::DEFAULT_FILENAME,
            "0 号实例没有用插件的默认名 ⇒ 老用户已经记住的窗口几何读不回来（单实例用户不许受影响）"
        );
        let nums = [1u32, 2, 3, 7, 10, 99];
        let names: Vec<String> = nums.iter().map(|n| window_state_filename(*n)).collect();
        let distinct: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(
            distinct.len(),
            names.len(),
            "不同实例号算出了同一个文件名 ⇒ 多开还是会互相覆盖：{names:?}"
        );
        for n in nums {
            let name = window_state_filename(n);
            assert_eq!(
                name,
                window_state_filename(n),
                "同一个实例号两次算出不同名字 ⇒ 重启后读不回自己那一份"
            );
            assert_ne!(
                name,
                window_state_filename(0),
                "实例 {n} 撞上了 0 号那一份（等于没隔离）：{name}"
            );
            for seg in ["/", "\\", ".."] {
                assert!(
                    !name.contains(seg),
                    "文件名里出现了 {seg} ⇒ 不再是一个路径段，插件会写到别处或拒写：{name}"
                );
            }
        }
    }

    /// A7 的**接线**判据：那份按实例算出来的名字必须真的传给插件（本仓的老规矩 ——
    /// 纯函数写得再对，没人调就等于还在共享同一份文件）。
    ///
    /// 钉的是"实际传进去的表达式"与**出现次数**，不是存在性：同一句话也可能只活在注释里
    /// （所以先 `code_only`），而 `.with_filename(` 出现两处就意味着有两个真源在打架。
    #[test]
    fn window_state_filename_is_wired_into_the_plugin_builder() {
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        let src = code_only(include_str!("lib.rs"));
        assert_eq!(
            src.matches(".with_filename(").count(),
            1,
            "设置窗口状态文件名的地方必须只有一处（两处 = 两个真源，最后一处赢）"
        );
        assert!(
            src.contains(".with_filename(window_state_filename(crate::state::instance_id()))"),
            "builder 没有把实例号传进文件名 ⇒ 退回共享的那一份，第二个实例又会盖掉第一个"
        );
        assert_eq!(
            src.matches("fn window_state_filename(").count(),
            1,
            "命名规则必须只有一个定义（多处 = 改一处漏一处）"
        );
    }

    /// 崩溃现场的内存读数**接在哪三个出口**上 —— 采样函数写得再对，没接上就等于零。
    ///
    /// 这是本仓的"接线判据"规矩：钉**出现次数**与**先后顺序**，不钉存在性
    /// （存在性会被注释里的同名句子喂饱 —— 上面那条 `code_only` 就是为此存在）。
    /// 三个出口对应三种死法：`RUNTIME_SNAPSHOT` = 长跑趋势；HANG = 冻住的那一刻；
    /// 分配失败钩子 = 进程消失前的最后一格。少接任何一个，那一种死法就重新变成猜。
    #[test]
    fn memory_readings_are_wired_into_all_three_crash_surfaces() {
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }

        // ① 5 分钟一格的结构快照：既采样，也把这一格存成缓存。
        let state = code_only(include_str!("state.rs"));
        assert_eq!(
            state.matches("crate::mem_diag::sample()").count(),
            1,
            "RUNTIME_SNAPSHOT 没有恰好一次采样 ⇒ 读数要么没接、要么被抄成第二份平行实现"
        );
        assert_eq!(
            state.matches("crate::mem_diag::remember(&mem)").count(),
            1,
            "采样结果没进缓存 ⇒ 下一次分配失败时只能退回 `cached_age=-`（等于白采）"
        );
        let snap = state
            .find("code=RUNTIME_SNAPSHOT")
            .expect("那条快照行改名/搬家了 ⇒ 同步改这条判据");
        assert!(
            state[snap..snap + 900].contains("mem.line()"),
            "格式串里没有 `mem.line()` ⇒ 采到的数压根没上那一行（假接线）"
        );

        // ② HANG 现场。
        let wd = code_only(include_str!("watchdog.rs"));
        assert_eq!(
            wd.matches("crate::mem_diag::sample().line()").count(),
            1,
            "HANG 现场少了内存那一格 ⇒ 「主线程 + 渲染层同一秒双双停滞」还是只能猜"
        );
        let hang = wd
            .find(">>> code=HANG scope=")
            .expect("HANG 行的形状变了 ⇒ 同步改 `logging.rs` 的解析与这条判据");
        assert!(
            wd[hang..].contains("crate::mem_diag::sample().line()"),
            "读数必须拼在 HANG 那一行里（写在别处 = 现场文件里查不到）"
        );

        // ③ 分配失败钩子：新采样优先，采不到才退缓存。
        let lib = code_only(include_str!("lib.rs"));
        let hook = lib
            .find("fn note_alloc_failure")
            .expect("分配失败钩子改名 ⇒ 这条接线判据同步改");
        let body = &lib[hook..hook + 1_400];
        assert!(
            body.contains("crate::mem_diag::sample()") && body.contains("crate::mem_diag::cached_line()"),
            "钩子里既要有当场采样、也要有采不到时的缓存兜底"
        );
        assert!(
            body.find("crate::mem_diag::sample()") < body.find("crate::mem_diag::cached_line()"),
            "必须先试新采样再退缓存（反了 = 每次报的都是五分钟前那一格）"
        );

        // ④ 帧读仪表：只在**长度校验之后**预约一次。
        let tcp = code_only(include_str!("transport/tcp.rs"));
        assert_eq!(
            tcp.matches("FrameReadGauge::new(").count(),
            1,
            "读帧路径上的预约必须恰好一处（两处 = 双计；零处 = 这一格永远是 0）"
        );
        let check = tcp
            .find("len > max")
            .expect("长度校验的写法变了 ⇒ 这条判据的顺序断言要跟着改");
        let gauge = tcp.find("FrameReadGauge::new(").unwrap();
        assert!(
            gauge > check,
            "必须先校验长度再预约：否则一个非法长度也会被算进聚合值（那是量具自己造假）"
        );

        // ⑤ 子树 CPU 那一列的**基准推进**：`tree_cpu` 是"距上一次采样烧了多少毫秒"，
        // 全靠读旧值→算增量→再写新值这个顺序。把 store 挪到 load 前面，增量就恒等于 0 ——
        // 而那正是"渲染进程被挂起"的读数形状：量具会替每一次卡死都指认错的那个方向。
        let mem = code_only(include_str!("mem_diag.rs"));
        for name in ["TREE_CPU_LAST", "TREE_CPU_AT"] {
            assert_eq!(
                mem.matches(&format!("{name}.load(")).count(),
                1,
                "{name} 只该在 sample() 里读一次（多一处 = 两条平行基准，增量算的是哪次说不清）"
            );
            assert_eq!(
                mem.matches(&format!("{name}.store(")).count(),
                1,
                "{name} 只该在 sample() 里推进一次"
            );
            assert!(
                mem.find(&format!("{name}.load(")) < mem.find(&format!("{name}.store(")),
                "{name} 必须先读旧值再推进基准：反了 ⇒ `tree_cpu` 永远是 0ms，每次卡死都被读成挂起"
            );
        }
        assert_eq!(
            mem.matches("tree_cpu_window_s = ").count(),
            1,
            "窗口必须和增量在同一格里成对写出（只写增量的话，`1500ms` 分不清是 30 秒还是 5 分钟）"
        );
    }

    /// 崩溃归因的另外两条接线：**大分配记账的出生地**与**现场/压力行**。
    ///
    /// 规矩与上一条一样：钉出现次数与位置，不钉存在性。少一个出生地，那一类分配就永远
    /// 不会出现在现场里 —— 而"日志里没看到"与"它没发生"是两件事（本仓在日志判据上反复强调过）。
    #[test]
    fn big_alloc_sites_and_the_crash_block_carry_the_picture() {
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        // ① 四个已知的"一次拿走一大块"的出生地，一个都不许漏。
        // （`include_str!` 只收字面量 ⇒ 这里逐项写，不用循环拼路径。）
        let per_file = [
            (
                "transport/tcp.rs",
                code_only(include_str!("transport/tcp.rs")),
                1, // 64 MiB 级的帧体
            ),
            (
                "transport/relay_seal.rs",
                code_only(include_str!("transport/relay_seal.rs")),
                2, // 内层帧 + 密封记录，两处都按对端声明长度增长
            ),
            (
                "export.rs",
                code_only(include_str!("export.rs")),
                2, // 全量读进行 + 整篇字符串 with_capacity
            ),
            (
                "commands/updater.rs",
                code_only(include_str!("commands/updater.rs")),
                1, // 整包常驻内存
            ),
        ];
        for (file, src, want) in per_file {
            assert_eq!(
                    src.matches("mem_diag::note_big_alloc(").count(),
                    want,
                    "{file} 的大分配记账必须是 {want} 处（多一处 = 同一件事两处出生，少一处 = 那一类分配在现场里隐形）"
                );
        }
        // ② 崩溃块自带那一刻的画面（内存 + 仪表 + 近期大分配都在 `line()` 里）。
        let logging = code_only(include_str!("logging.rs"));
        assert_eq!(
            logging.matches("crate::mem_diag::sample().line()").count(),
            1,
            "现场块里没有这一行 ⇒ panic 那种死法仍然只留得下一句 panic 文本"
        );
        let block = logging
            .find("fn write_crash_block")
            .expect("崩溃块函数改名 ⇒ 同步改这条判据");
        assert!(
            logging[block..].contains("现场内存"),
            "读数必须写在 `write_crash_block` 里（写在别处 = 现场文件里查不到）"
        );
        // ③ 提交压力的快线：接在 5 分钟那一格之后，且必须同时进应用日志与现场。
        let state = code_only(include_str!("state.rs"));
        assert_eq!(
            state
                .matches("crate::mem_diag::under_commit_pressure(&mem)")
                .count(),
            1,
            "快线必须恰好一处，且读的是这一格刚采的样本（不是缓存）"
        );
        // 同一行还要**每格**写进不轮转的现场文件：应用日志 512 KiB 就转、只留一代，
        // 而被外部拿走那种死法没有钩子可挂 ⇒ 走势是唯一还剩着的证据。
        // （数的是码名而不是 `crash_note(` 本身：那个函数在本文件里另有 6 处生产调用点，
        //   拿它当计数分母会先撞上一条假红 —— 与本仓"分母要现算"同一条道理。）
        assert_eq!(
            state.matches("\">>> code=RUNTIME_MEM ").count(),
            1,
            "每格都要往现场写一行内存走势，且只写一处（两处 = 同一行落两遍，2 MiB 的现场会被自己刷掉）"
        );
        assert_eq!(
            state.matches("\">>> code=COMMIT_PRESSURE ").count(),
            1,
            "越界时的压力行必须落进不轮转的现场（应用日志那一侧另有 warn，这里数的是现场那一份）"
        );
        let press = state
            .find("code=COMMIT_PRESSURE")
            .expect("压力码没了 ⇒ 临界期又变成没有留痕");
        assert!(
                state[press..press + 700].contains("crate::logging::crash_note"),
                "压力行必须同时落现场文件：应用日志会轮转（512 KiB / 只留一代），临界的几分钟可能正好被转掉"
            );
    }

    /// 更新器**交棒给安装器之前**必须往不轮转的现场里写一行。
    ///
    /// 为什么这条值得钉：Windows 的 NSIS 安装器成功后直接结束本进程，走不到任何 shutdown 钩子
    /// ⇒ 现场里就只剩"这次运行没有任何收尾标记地结束了"。2026-10-27 那一趟（01:39）正是这样
    /// 被当成一次不明崩溃来分析的 —— 白找了半小时凶手动机。
    ///
    /// 钉的是**顺序**而不是存在性：BEGIN 写在 `update.install(&bytes)` 之后等于没写，
    /// 安装器一接管，后面那行再也出不来。
    #[test]
    fn updater_marks_the_handoff_in_the_crash_file_before_it_leaves() {
        fn code_only(src: &str) -> String {
            src.lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        let up = code_only(include_str!("commands/updater.rs"));
        assert_eq!(
            up.matches(">>> code=UPDATER_INSTALL_BEGIN").count(),
            1,
            "交棒前的标记必须恰好一处（两处 = 同一个结局落两行，2 MiB 的现场会被自己刷掉）"
        );
        let begin = up
            .find(">>> code=UPDATER_INSTALL_BEGIN")
            .expect("BEGIN 码没了 ⇒ 装完更新那次退出又变成'不明死法'");
        let install = up
            .find("update.install(&bytes)")
            .expect("安装调用改了名/搬了家 ⇒ 同步改这条判据");
        assert!(
            begin < install,
            "BEGIN 必须写在把字节交给安装器**之前**：之后写的那行永远可能出不来"
        );
        let done = up.find(">>> code=UPDATER_INSTALL_DONE");
        assert!(
            matches!(done, Some(i) if i > install),
            "DONE（若有）必须跟在安装调用之后：它的作用是'安装器已交棒'，装之前就写 = 谎报"
        );
        // 非 Windows 那一支由本进程自己重启，同样要有标记（`restart` 里会 exit）。
        let restart = up
            .find("app.restart()")
            .expect("重启调用改名 ⇒ mac/linux 那次'没有收尾标记的退出'又会复活");
        let note = up
            .find(">>> code=UPDATER_RESTART")
            .expect("重启前没有现场标记");
        assert!(
            note < restart,
            "重启标记必须紧邻在 restart 之前（写后面读不到）"
        );
    }


    /// 全仓**用到 windows-sys 的文件**清单（相对路径 + 源码）。
    ///
    /// 为什么现解析而不是手抄：手抄清单必然漂（新增一个用 windows-sys 的文件时，
    /// 忘了把它加进来 ⇒ 那次漏 feature 只有 Windows CI 会发现）。
    /// 判法是"文件里出现过 `windows_sys::`"——比"有没有 `use windows_sys::` 行"更宽，
    /// 所以漏不掉（哪怕将来有人写成 `windows_sys::Win32::…` 的全路径调用）。
    fn windows_sys_usage_sites() -> Vec<(&'static str, &'static str)> {
        vec![
            ("src/mem_diag.rs", include_str!("mem_diag.rs")),
            // 接收前的卷余量预检（2026-10-27）：Windows 那一半用
            // `Win32_Storage_FileSystem::GetDiskFreeSpaceExW`。
            ("src/storage/disk_space.rs", include_str!("storage/disk_space.rs")),
        ]
    }

    /// **每一个**用到 windows-sys 的文件里用到的**每一个** windows-sys 命名空间，
    /// 都必须在 `Cargo.toml` 里点名成 feature。
    ///
    /// 这条专门为本机看不见的那一半代码存在：那些 `use windows_sys::…` 全在
    /// `#[cfg(target_os = "windows")]` 的函数体里 ⇒ mac 上 `cargo check`、clippy、单测三样全绿，
    /// 只有 Windows 那条腿编不过。而 windows-sys 的 feature **没有传递关系**（现读 0.61.2 的
    /// Cargo.toml：`Win32_System_ProcessStatus` 只展开到 `["Win32_System"]`，
    /// `Win32_System_Diagnostics_ToolHelp` 谁也不顺带打开）⇒ 用到哪个就得开哪个。
    /// 2026-10-27 加"我们家那棵 WebView2 子进程树"的遍历时就是这么漏了 ToolHelp 一次。
    ///
    /// ⚠️ **分母是"所有用到 windows-sys 的文件"，不是一个**（2026-10-27 补）：
    /// 收尾余量预检的 Windows 那一半（`storage/disk_space.rs`）要用
    /// `Win32_Storage_FileSystem::GetDiskFreeSpaceExW`，而它住在**另一个文件**里 ——
    /// 只扫 `mem_diag.rs` 的话，那次漏 feature 只有 Windows CI 会发现。
    /// 现在分母是"全仓出现 `windows_sys::` 的文件"，逐个扫它们的 `use` 行。
    #[test]
    fn every_windows_sys_namespace_used_is_declared_as_a_feature() {
        let cargo = include_str!("../Cargo.toml");
        // 分母从"用它的地方"现解析，不手抄清单（本仓在判据上反复吃过手抄清单漂移的亏）。
        let mut need: Vec<String> = Vec::new();
        for (path, src) in windows_sys_usage_sites() {
            for line in src.lines() {
                let l = line.trim();
                if l.starts_with("//") || !l.starts_with("use windows_sys::Win32::") {
                    continue;
                }
                let tail = l.trim_start_matches("use ").trim_end_matches(';');
                // `…::{X, Y};` ⇒ 命名空间是 `::{` 之前那一段；
                // `…::ITEM;`（只引进一个符号）⇒ 最后一段是符号本身，砍掉才是命名空间。
                let ns = match tail.split_once("::{") {
                    Some((ns, _items)) => ns.to_string(),
                    None => tail[..tail.rfind("::").unwrap_or(0)].to_string(),
                };
                let feature = ns.trim_start_matches("windows_sys::").replace("::", "_");
                if !need.contains(&feature) {
                    need.push(feature);
                }
            }
            let _ = path;
        }
        assert!(
            need.len() >= 5,
            "解析器只数出 {} 个命名空间 ⇒ import 的写法变了而这条判据在空转：{need:?}",
            need.len()
        );
        let missing: Vec<&String> = need
            .iter()
            .filter(|f| !cargo.contains(&format!("\"{f}\"")))
            .collect();
        assert!(
            missing.is_empty(),
            "Cargo.toml 的 windows-sys feature 少了 {missing:?} —— mac 全绿、Windows CI 当场编不过"
        );
    }
