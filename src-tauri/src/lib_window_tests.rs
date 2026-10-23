// 职责边界：
// - `lib_tests.rs` 测试分册之2 —— 窗口面：capability 标签、辅助窗口单例/串行、Cmd-W、外链协议门
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
    /// capability 的 `windows` 模式匹配。Tauri 内部用 glob；本项目只需要支持
    /// 全匹配 / `前缀*` / `*后缀` 三种写法（够用且不引入新依赖）。
    fn window_pattern_matches(pattern: &str, label: &str) -> bool {
        if pattern == "*" {
            return true;
        }
        if let Some(prefix) = pattern.strip_suffix('*') {
            return label.starts_with(prefix);
        }
        if let Some(suffix) = pattern.strip_prefix('*') {
            return label.ends_with(suffix);
        }
        pattern == label
    }

    /// 匹配器本身不许"永远为真"（否则下面的守卫会变成空转）。
    #[test]
    fn window_pattern_matcher_is_not_vacuous() {
        assert!(window_pattern_matches("main", "main"));
        assert!(!window_pattern_matches("main", "settings"));
        assert!(window_pattern_matches("*", "settings"));
        assert!(window_pattern_matches("set*", "settings"));
        assert!(window_pattern_matches("*ings", "settings"));
        assert!(!window_pattern_matches("settings", "settings-extra"));
    }

    /// 每一个会创建窗口的标签都必须被 capability 覆盖 —— 否则那个窗口的
    /// `plugin:*` / `core:*` 调用会被 ACL 拒绝（本项目没有 app ACL manifest，
    /// 自定义命令不校验，所以症状是"设��窗口里选目录/开链接/订阅事件静默失败"）。
    #[test]
    fn capability_covers_every_window_label() {
        let raw = include_str!("../capabilities/default.json");
        let caps: serde_json::Value =
            serde_json::from_str(raw).expect("capabilities/default.json 必须是合法 JSON");
        let patterns: Vec<String> = caps
            .get("windows")
            .and_then(|v| v.as_array())
            .expect("capabilities/default.json 缺少 windows 数组")
            .iter()
            .map(|v| v.as_str().expect("windows 数组项必须是字符串").to_string())
            .collect();
        // 防"清单被删空 ⇒ 循环空转"：固定窗口至少这三个。
        assert!(
            WINDOW_LABELS.len() >= 3,
            "WINDOW_LABELS 至少要有 main/settings/logs 三个"
        );
        // 群任务窗口现在是**固定** label（`tasks`），已经在 WINDOW_LABELS 里 ⇒ 不再有动态通配要验。
        for label in WINDOW_LABELS.iter().copied() {
            assert!(
                patterns.iter().any(|p| window_pattern_matches(p, label)),
                "窗口 `{label}` 没有被任何 capability 覆盖（windows = {patterns:?}）"
            );
        }
    }

    /// 自定义窗口命令**内部调到的** core 权限必须都在 capability 里。
    ///
    /// ## 这条守卫的真实价值（2026-10-12 复盘修正）
    ///
    /// 最初写它时的归因是错的：当时以为 `window_toggle_maximize` / `window_toggle_fullscreen`
    /// "点了没反应"是 ACL 静默拒绝 `core:window:set-fullscreen` / `allow-unmaximize` 导致的。
    /// 源码核对后**不成立**：Tauri 2.11.5 `tauri/src/webview/mod.rs:1823` 的闸门是
    /// `(plugin_command.is_some() || has_app_acl_manifest || !is_local) && request.cmd
    /// != FETCH_CHANNEL_DATA_COMMAND && invoke.acl.is_none()`，而本项目
    /// `gen/schemas/acl-manifests.json` 的 keys 里**没有 `__app-acl__`** ⇒
    /// `has_app_acl_manifest=false` ⇒ 本地来源的**自定义命令**压根不进 ACL 闸门。
    /// 真根因是 tao 的 `is_maximizable()` 在 Borderless 窗上恒 false（见
    /// `commands/window.rs::window_toggle_maximize` 的长注释与
    /// [`window_maximizable_matches_builder`]）。
    ///
    /// 即便如此，这条守卫本身**仍然要留**：它保证"命令实现里新出现的 core 方法调用
    /// 都在 capability 里"，那对**将来**某个真走 ACL 的场景（远端来源、将来引入 app
    /// ACL manifest、`plugin:` 前缀命令）是必须的。保留，但别再拿它解释历史缺陷。
    #[test]
    fn capability_grants_every_window_permission_the_commands_use() {
        let raw = include_str!("../capabilities/default.json");
        let caps: serde_json::Value =
            serde_json::from_str(raw).expect("capabilities/default.json 必须是合法 JSON");
        let perms: Vec<String> = caps
            .get("permissions")
            .and_then(|v| v.as_array())
            .expect("capabilities/default.json 缺少 permissions 数组")
            .iter()
            .map(|v| v.as_str().expect("permissions 数组项必须是字符串").to_string())
            .collect();
        // 前端 `api.window*` 那族 + TitleBar 的缩放/全屏/拖拽/聚焦真正会走到的 core 权限。
        // 取"命令实现里现读"而不是"凭记忆抄"：命令源码必须真的出现对应的 core 方法名。
        // `.show()` 不在 window.rs 而在 commands/logs.rs（辅助窗口共用那条构造），
        // 所以这里读"窗口命令那几份源码的并集" —— 只读 window.rs 会把 show 漏掉，
        // 而 show 恰恰是辅助窗口能不能现身的那一个。
        let window_src = format!(
            "{}\n{}\n{}",
            include_str!("commands/window.rs"),
            include_str!("commands/logs.rs"),
            include_str!("commands/network.rs"),
        );
        let required: [(&str, &str); 6] = [
            ("allow-maximize", ".maximize()"),
            ("allow-unmaximize", ".unmaximize()"),
            ("allow-is-maximized", ".is_maximized()"),
            ("allow-minimize", ".minimize()"),
            ("allow-show", ".show()"),
            ("allow-hide", ".hide()"),
        ];
        // 注意 `allow-start-dragging` **不在这张表里**：那条是前端
        // `getCurrentWindow().startDragging()` 直接调 Tauri 自己的 core 命令，不走我们的
        // Rust 源码 ⇒ 用"源码里找不找得到"当锚点会永远对不上。它由前端契约那侧保证。
        for (perm, needle) in required {
            // 只对**桌面**那一支提要求：移动端那两个 #[cfg(mobile)] 桩什么都不调，
            // 而 capability 是桌面产物（android 有另一份 schema）。
            #[cfg(desktop)]
            assert!(
                window_src.contains(needle),
                "窗口命令源码里找不到 {needle} ⇒ 上面那张 required 表过期了，请同步改这条守卫"
            );
            assert!(
                perms.iter().any(|p| p == &format!("core:window:{perm}")),
                "capability 缺 `core:window:{perm}` —— {needle} 会被 ACL 静默拒绝，\
                 表现为「按钮点了没反应」而前端日志一切正常"
            );
        }
    }

    /// `MAXIMIZABLE_WINDOWS` 与 `logs.rs` 里各窗 builder 的 `.maximizable(...)` 必须一致。
    ///
    /// ## 为什么会有这份清单（用户 2026-10-12：macOS 绿灯 / 双击标题栏"点了没反应"）
    ///
    /// 根因不是权限、不是前端，是 **tao 的 `is_maximizable()` 在 Borderless 窗上恒 false**：
    /// 我们所有窗口都是 `decorations:false`，tao 建出的 styleMask 缺 `Titled` 位
    /// （`tao-0.35.3/platform_impl/macos/window.rs:216-222`），AppKit 的 zoom button
    /// 只在 Titled 窗上存在，于是 `is_maximizable()` 取不到 button 就 return false
    /// （同文件 L1105-1115）。实测探针：borderless 窗 `is_maximizable()`=false，
    /// 但直接 `set_maximized(true)` 照样铺满可见区、还原也正常 ⇒ **能力一直在，判据说谎**。
    ///
    /// 所以判据换成"我们自己写进 builder 的显式配置"，而那份配置运行时读不回来
    /// ⇒ 由 `crate::MAXIMIZABLE_WINDOWS` 维护白名单，两边由本测试交叉核对
    /// （改一边忘另一边会红）。同时"辅助窗那几处 `.maximizable(false)` 的数量必须等于
    /// 白名单之外的窗口数"把两侧真正绑在一起：往白名单里多加一扇辅助窗（本该禁用的），
    /// 数量立刻对不上 ⇒ 红。
    ///
    /// ⚠️ 这条守卫本身也按同一套规矩验证过非空转：把 `WINDOW_SETTINGS` 加进白名单会红
    /// （4 扇 builder vs 3 扇白名单外窗口），把未登记的 `WINDOW_LINK` 加进去也会红
    /// （子集断言）。
    #[test]
    fn window_maximizable_matches_builder() {
        #[cfg(desktop)]
        {
            let logs_src = include_str!("commands/logs.rs");
            // 白名单必须是 WINDOW_LABELS 的子集（否则等于给不存在的窗口授权）。
            for label in crate::MAXIMIZABLE_WINDOWS {
                assert!(
                    crate::WINDOW_LABELS.contains(label),
                    "MAXIMIZABLE_WINDOWS 含未登记的窗口 `{label}`"
                );
            }
            // 双向绑定：builder 里显式禁掉的窗数 == 白名单之外的已登记窗数。
            // 左侧 4 = settings/logs/preview/tasks（见 `commands/logs.rs` 四扇辅助窗）；
            // 右侧 = WINDOW_LABELS − MAXIMIZABLE_WINDOWS = 5 − 1 = 4。
            let disabled = logs_src.matches(".maximizable(false)").count();
            let allowed = crate::WINDOW_LABELS
                .iter()
                .filter(|l| !crate::MAXIMIZABLE_WINDOWS.contains(l))
                .count();
            assert_eq!(
                disabled, allowed,
                "commands/logs.rs 里有 {disabled} 处 `.maximizable(false)`，但 \
                 WINDOW_LABELS − MAXIMIZABLE_WINDOWS 有 {allowed} 扇 —— 两侧漂移了。\
                 新增辅助窗时请同时决定它的 builder 与白名单归属"
            );
            assert!(
                !crate::MAXIMIZABLE_WINDOWS.is_empty(),
                "白名单为空 ⇒ 没有任何窗口能最大化（用户实测绿灯/双击无反应）"
            );
        }
    }

    /// **反向**守卫：外链窗口**必须不被**任何 capability 覆盖。
    ///
    /// 它加载的是远端页面；一旦被 capability 覆盖，第三方内容就能调用本应用的
    /// `plugin:*` / `core:*`（对话框、打开器、事件……）—— 等于把命令面交出去。
    /// 与上一条互为镜像：上一条保证"该覆盖的都被覆盖"，这条保证"不该覆盖的没被覆盖"。
    #[test]
    fn link_window_is_not_capability_covered() {
        let raw = include_str!("../capabilities/default.json");
        let caps: serde_json::Value =
            serde_json::from_str(raw).expect("capabilities/default.json 必须是合法 JSON");
        let patterns: Vec<String> = caps
            .get("windows")
            .and_then(|v| v.as_array())
            .expect("capabilities/default.json 缺少 windows 数组")
            .iter()
            .map(|v| v.as_str().expect("windows 数组项必须是字符串").to_string())
            .collect();
        assert!(
            !patterns
                .iter()
                .any(|p| window_pattern_matches(p, WINDOW_LINK)),
            "外链窗口 `{WINDOW_LINK}` 不得被任何 capability 覆盖（远端页面会因此拿到命令面）：{patterns:?}"
        );
        // 同时确认它没被误加进固定窗口清单。
        assert!(
            !WINDOW_LABELS.contains(&WINDOW_LINK),
            "WINDOW_LINK 不该进 WINDOW_LABELS（那份清单是 capability 覆盖的正向清单）"
        );
    }

    /// **规则式**守卫：任何会碰重资源（数据库 / 文件系统 / 日志 / 剪贴板 / 网卡枚举 / 阻塞睡眠）
    /// 的命令，都必须声明 `#[tauri::command(async)]`。
    ///
    /// 依据（读过上游源码，不是猜的）：
    /// - `tauri-macros` 的 `body_blocking` 把命令函数**内联调用**在 IPC 处理器里；
    ///   只有 `ExecutionContext::Async` 才走 `respond_async_serialized`
    ///   → `crate::async_runtime::spawn(...)`（异步运行时线程）。
    /// - wry 的 `WKScriptMessageHandler::did_receive` 在 AppKit 消息循环里同步回调
    ///   （`wry-*/src/wkwebview/class/wry_web_view_delegate.rs`），即 **macOS 主线程**。
    ///
    /// 于是同步命令 = 在 UI 主线程上跑：**整个进程**（所有窗口）都会卡住，不只是发起调用的那个窗口。
    ///
    /// 为什么从"名字清单"改成"规则"：清单只能盯住写清单时想到的那几个。
    /// 真实事故（2026-09-12 用户反馈"点清除数据/恢复，设置窗口直接卡死；点添加好友主窗口卡死"）：
    /// 清单里 12 个命令是 async，但**另外 42 个**（`get_settings`/`get_friends`/`get_transfers`/
    /// `get_logs`/`list_interfaces`/`reset_settings`/`open_settings_window` …）仍是同步命令。
    /// 它们本身很快，但 `clear_all_data` 那种长事务会把 `db` 互斥锁握住数秒，
    /// 于是这些同步读**在主线程上等锁** ⇒ 两个窗口一起冻住。
    /// 规则式守卫能覆盖"以后新加的命令"，名字清单不能。
    #[test]
    fn blocking_commands_run_off_the_main_thread() {
        let src = all_commands_src();
        // ⚠️ 例外清单已清空（2026-09-20）：v4.22.2 曾把 4 个开窗命令登记成例外（理由是
        // "macOS 必须主线程调 AppKit"），结果在 Windows 上换来了更严重的故障 ——
        // 同步命令在 IPC 回调里内联跑主线程，而 Windows 建 WebView2 会在调用线程里泵消息
        // ⇒ 与 IPC 重入 ⇒ 持锁自锁 ⇒ 整个界面永久无响应。macOS 的约束改由
        // `commands::logs::decorate_aux_window` 把 AppKit 调用单独投回主线程解决，
        // 不再需要任何例外。

        // 重资源标记 → 人类可读的原因（与下面「不许把 tokio worker 占住」那条判据**共用同一份**：
        // 两条判的是同一个"什么算重活"的判定，抄两份就会有一份漂 ⇒ 见 `heavy_markers`）
        let markers = heavy_markers();

        // 建窗命令单独判：`open_*_window` 的函数体里没有上面那些重资源标记（db 访问都在
        // 已 try_lock 的辅助函数里），光靠 markers 抓不到它 —— 而它恰恰是最不能同步的一条。
        let window_markers = ["ensure_aux_window(", "WebviewWindowBuilder::new("];

        let mut offenders: Vec<String> = Vec::new();
        for (name, is_async, _fn_is_async, body) in command_bodies(src) {
            if is_async {
                continue;
            }
            let hit: Vec<&str> = markers
                .iter()
                .filter(|(m, _)| body.contains(m))
                .map(|(_, why)| *why)
                .collect();
            if !hit.is_empty() {
                offenders.push(format!("  {name}: {}", hit.join("、")));
            }
            if window_markers.iter().any(|m| body.contains(m)) {
                offenders.push(format!(
                    "  {name}: 创建窗口 —— Windows 上主线程内联建 WebView2 会泵消息、\
                     与 IPC 回调重入 ⇒ 永久挂死（见 commands/logs.rs 的 ensure_aux_window）"
                ));
            }
        }
        assert!(
            offenders.is_empty(),
            "以下命令会阻塞 macOS 主线程（同步命令在 wry 的 IPC 回调里内联执行），\
             必须加 `#[tauri::command(async)]` —— 否则长事务/读盘期间**所有窗口**一起卡死：\n{}",
            offenders.join("\n")
        );
    }

    /// 「什么算重活」的标记表 —— **上面那条主线程判据与下面那条 worker 棘轮共用这一份**。
    /// 抄两份的后果是既成事实：主线程那份后来加过 `tray::`，worker 那份如果另起炉灶就会漏。
    fn heavy_markers() -> [(&'static str, &'static str); 10] {
        // `tray::` 标记（审计 2.2j）：托盘更新 = 整张图标逐像素混合 + 平台角标重绘，
        // 同步命令里内联跑等于在主线程 IPC 回调里做 CPU/平台活（macOS 主线程同时
        // 驱动整个 UI 事件循环）。set_unread_badge 曾因此漏网——字面量 marker
        // 匹配不到跨模块调用，本标记补上这个洞。
        [
            (".db", "访问 SQLite（可能等锁数秒）"),
            ("db::", "访问 SQLite"),
            ("std::fs", "文件系统 IO"),
            ("logger.", "日志（含整份快照）"),
            ("Clipboard", "系统剪贴板（可能被别的程序占着）"),
            ("list_interfaces", "枚举网卡"),
            ("if_addrs", "枚举网卡"),
            ("thread::sleep", "阻塞睡眠"),
            ("block_on", "阻塞等待异步任务"),
            ("tray::", "托盘图标重绘（逐像素混合 + set_icon/badge）"),
        ]
    }

    /// 棘轮（审计 R-18）：把重活**留在 tokio worker 上**的命令数只许降、不许升。
    ///
    /// 为什么上一条守卫挡不住这个：它只判"在不在主线程"，而 `#[tauri::command(async)]`
    /// 贴在同步 `fn` 上就已经算"离开主线程"了 —— 宏的语义是**整段函数体进
    /// `async_runtime::spawn`**（INV-P34；`tauri-macros` 里那个 `sync_threadpool` 只是
    /// tracing 标签，不是阻塞池）。于是 76 条命令可以守卫全绿、却把 worker 一个个占死：
    /// worker 数 = CPU 核数，而"打开辅助窗/设置窗"这些命令也要 worker ⇒ 传文件时点设置窗
    /// 白等一下，就是这个半径。
    ///
    /// 判据口径：函数体里有重活标记 **且** 函数体里没有 `spawn_blocking(` ⇒ 算"占 worker"。
    /// 只看函数体文本，不看它调用的 helper（helper 里进阻塞池的，命令体里通常只剩
    /// 一次 `.await`；真接错了由行为层与 `check-lock-scope` 负责）。
    #[test]
    fn worker_bound_heavy_commands_do_not_grow() {
        // ⚠️ 这是**棘轮上限**，不是"应该有的数量"。收敛轨迹（都按本判据现数）：
        // 75（第一批之前）→ 66（第一批 9 条）→ 61（第二批 9 条里只有 5 条原本在集合内）
        // → 51（第三批 10 条：写侧与广播前的持锁段，全部原本在集合内 ⇒ 差值恰好等于条数）
        // → **47**（第四批 4 条：db 读写与网络 await 在同一条命令里交错的 mark_read + ensure/delete_conversation + save_settings；
        //   mark_read 是逐段搬而不是整函数搬 —— 中间那些网络 await 绝不能和持锁段合成一段）。
        // → **31**（第六批 9 条：焦点/通知/测试通知/激活窗口四条 + 好友密钥轮换 + 三条文件族 +
        //   资料更新的写侧）。
        //   每批都按"上限压到读数 −1 去探针 ⇒ 报出真实数 ⇒ 再钉住"走 ⇒ 差值必须等于改的条数，
        //   对不上就说明有一条本来不在集合里（第二、三批就各抓到过一次），不许拿"大约"糊过去。
        // 每再转一条就把这里调小，调小之后这条判据仍必须绿 ⇒ 见审计文档 E.0 的计数行。
        // 如果新增/登记了分册导致这里变红：先按报错逐条把那条命令的重活搬进 `spawn_blocking`，
        // **不要**调大上限 —— 调大就是承认倒退（真要倒退也得到这里写理由，让红有名字）。
        //
        // 这条判据是**下限而不是普查**：标记是函数体的字面文本，所以"重活藏在 helper 调用里"的
        // 命令它看不见。同一批里 4 条（`media_present`/`read_clipboard_file_paths`/
        // `get_cache_info`/`get_discovery_diag`）改造前根本不在集合内 —— 它们分别把 stat、
        // 剪贴板读、目录递归 walk、蓝牙采集藏在 `resolve_media_path`/`clipboard_win::…`（小写，
        // 不匹配 `Clipboard`）/`cache_cleaner::usage`/`collect_ble_diag` 后面。
        // 想把那个洞堵上，得改成"沿调用图一跳看 helper 体"，那是另一件事，别靠加别名标记糊。
        const CEILING: usize = 31;
        let src = all_commands_src();
        let markers = heavy_markers();
        let mut bound: Vec<String> = Vec::new();
        for (name, _off_main_thread, fn_is_async, body) in command_bodies(&src) {
            if body.contains("spawn_blocking(") {
                continue;
            }
            let hits: Vec<&str> = markers
                .iter()
                .filter(|(m, _)| body.contains(m))
                .map(|(_, why)| *why)
                .collect();
            if !hits.is_empty() {
                bound.push(format!(
                    "  {name}（{}）: {}",
                    if fn_is_async {
                        "async fn 里直接阻塞"
                    } else {
                        "(async) 贴同步 fn ⇒ 整段在 worker 上"
                    },
                    hits.join("、")
                ));
            }
        }
        // 下限：只判上限时，"命令扫描器退化成一条都认不出"会让 `bound` 恒空 ⇒ 判据恒绿。
        // 28 是给当前真实读数 31 留的余量；真收敛到更低时这条也要跟着调小
        // （调小之前先确认扫描器还认得 `#[tauri::command]`，否则调小只是把假绿钉死）。
        assert!(
            bound.len() >= 28,
            "重活命令现数到 {} 条，比下限 28 还少 —— 多半是扫描器退化（认不出命令属性），\
             不是真的收敛了；先确认 `command_bodies()` 的解析，再谈调小上限",
            bound.len()
        );
        assert!(
            bound.len() <= CEILING,
            "把重活留在 tokio worker 上的命令现数到 {} 条（棘轮上限 {CEILING}）。要么把新加的那条改成 \
             `async fn` + `spawn_blocking`，要么按本轮真实收敛结果把上限调小 —— 调大就是承认倒退：\n{}",
            bound.len(),
            bound.join("\n")
        );
    }

    /// 拆出 `commands.rs` 里每个 `#[tauri::command…]` 的
    /// `(名字, 是否离开主线程, 函数本身是不是 async fn, 函数体)`。
    ///
    /// 两个布尔不合并成一条：`是否离开主线程` = 属性 `(async)` **或** `async fn`（宏两条路都不在主线程），
    /// 而**占不占 tokio worker** 只看"函数本身是不是 `async fn` + 函数体里有没有 `spawn_blocking`" ——
    /// `(async)` 贴在同步 `fn` 上只是把整段搬到 worker 上跑（INV-P34），阻塞活照样吃 worker。
    ///
    /// 手写扫描而不是上 syn：本测试只做文本判据，不引入新依赖；字符串/注释/生命周期都跳过，
    /// 否则函数体里的花括号（`format!("{}")` 之类）会让配对错位。
    fn command_bodies(src: &str) -> Vec<(String, bool, bool, String)> {
        let bytes = src.as_bytes();
        let mut out = Vec::new();
        let mut i = 0usize;
        while let Some(pos) = src[i..].find("#[tauri::command") {
            let attr_start = i + pos;
            let attr_end = match src[attr_start..].find(']') {
                Some(e) => attr_start + e,
                None => break,
            };
            // 两条路都算"off main thread"：属性 `#[tauri::command(async)]`（同步函数被 spawn），
            // 或函数本身是 `async fn`（宏直接走 respond_async_serialized）。
            let attr_async = src[attr_start..attr_end].contains("async");
            // 从属性之后找 `fn 名字(`
            let after = &src[attr_end..];
            let fn_pos = match after.find("fn ") {
                Some(p) => attr_end + p,
                None => {
                    i = attr_end;
                    continue;
                }
            };
            let name: String = src[fn_pos + 3..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let is_async = attr_async || src[attr_end..fn_pos].contains("async");
            let fn_is_async = src[attr_end..fn_pos].contains("async fn");
            // 花括号配对取函数体（跳过字符串/字符/注释）
            let mut depth = 0i32;
            let mut j = fn_pos;
            let mut in_str = false;
            let mut in_line_comment = false;
            let mut in_block_comment = false;
            let mut body = String::new();
            while j < bytes.len() {
                let c = bytes[j] as char;
                let next = bytes.get(j + 1).map(|b| *b as char);
                if in_line_comment {
                    if c == '\n' {
                        in_line_comment = false;
                    }
                } else if in_block_comment {
                    if c == '*' && next == Some('/') {
                        in_block_comment = false;
                        j += 1;
                    }
                } else if in_str {
                    if c == '\\' {
                        j += 1;
                    } else if c == '"' {
                        in_str = false;
                    }
                } else if c == '/' && next == Some('/') {
                    in_line_comment = true;
                    j += 1;
                } else if c == '/' && next == Some('*') {
                    in_block_comment = true;
                    j += 1;
                } else if c == '"' {
                    in_str = true;
                } else if c == '\'' {
                    // 生命周期（`'_` / `'a`）不是字符字面量：只有 `'x'` 形式才算
                    if next == Some('\\') || bytes.get(j + 2).map(|b| *b as char) == Some('\'') {
                        j += 2;
                    }
                } else if c == '{' {
                    depth += 1;
                } else if c == '}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                if depth > 0 {
                    body.push(c);
                }
                j += 1;
            }
            out.push((name, is_async, fn_is_async, body));
            i = j.max(attr_end + 1);
        }
        out
    }

    /// 主窗口标签在 `tray` 里还有一份（那份是 `#[cfg(desktop)]`），两边不许漂移。
    #[cfg(desktop)]
    #[test]
    fn main_window_label_matches_tray_constant() {
        assert_eq!(tray::MAIN_WINDOW_LABEL, WINDOW_MAIN);
    }

    /// **⌘W 必须由我们自己的菜单项处理**（用户 2026-09-13 真机：主窗口 ⌘W 只会"滴滴滴"）。
    ///
    /// 系统预定义项 `PredefinedMenuItem::close_window` 的动作是 `performClose:`，AppKit 按
    /// 窗口的 `Closable` 样式位校验可用性；而本项目**所有应用窗口**都是 `decorations: false`
    /// ⇒ Borderless ⇒ 该项被判不可用 ⇒ 只有系统提示音，且**没有任何日志**。
    /// （2026-09-17 之前只有主窗口是无边框的、辅助窗口靠系统标题栏所以"正常"，更容易让人以为
    /// 是"主窗口特有的 bug"；现在辅助窗口也由 `decorate_aux_window` 补回 `Closable` 位。）
    ///
    /// 判据：窗口菜单不得再用预定义关闭项；必须有一个带 `CmdOrCtrl+W` 的自定义项，
    /// 且菜单事件处理里真的关掉"当前聚焦窗口"（回落到主窗口）。
    #[test]
    fn cmd_w_is_handled_by_our_own_menu_item() {
        let m = include_str!("menu.rs");
        // ⚠️ 先**去掉注释**再查"有没有用错项"：menu.rs 里那段解释恰恰写着这个名字，
        // 不剥注释就会把"解释这个坑"误判成"又踩了这个坑"（本项目已踩过一次这种假阳性）。
        let code: String = m
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !code.contains("PredefinedMenuItem::close_window"),
            "不许用系统预定义的关闭项 —— 它会被 AppKit 按 `Closable` 样式位判为不可用，\
             表现就是主窗口 ⌘W 只响一声提示音（用户 2026-09-13 真机）"
        );
        assert!(
            m.contains("\"close-window\"") && m.contains("CmdOrCtrl+W"),
            "必须有一个 id=close-window、快捷键 CmdOrCtrl+W 的自定义菜单项"
        );
        let handler = m
            .find("\"close-window\" =>")
            .expect("菜单事件处理里必须接住 close-window（否则点了没反应）");
        let body = &m[handler..(handler + 700).min(m.len())];
        assert!(
            body.contains("is_focused"),
            "关的应当是**当前聚焦**的窗口（与 macOS 原生 ⌘W 语义一致）"
        );
        assert!(
            body.contains(".close()"),
            "走 `close()` 才会触发各窗口自己的 CloseRequested → 隐藏处理器（与「×」一致）"
        );
    }

    /// **独立窗口必须各自一个前端文档与入口**，不许再共用主窗口的 `index.html`。
    ///
    /// 为什么（用户 2026-09-12 实测）：「第二次打开设置，窗口会先刷成主聊天窗口、
    /// 然后立马变成设置界面」+「点一下要等很久」—— 根因就是设置/日志窗口加载的是主窗口的
    /// HTML，前端再按窗口 label 把聊天三栏挂起来换成设置页。窗口 URL 与前端文档的对应关系
    /// 只有这条护栏盯着（前端测试看得到 HTML，看不到 Rust 的 URL）。
    #[cfg(desktop)]
    #[test]
    fn aux_windows_open_their_own_document() {
        let commands = all_commands_src();

        let mut urls: Vec<String> = Vec::new();
        for part in commands.split("WebviewUrl::App(").skip(1) {
            let rest = part.trim_start().trim_start_matches('"');
            let end = rest
                .find('"')
                .unwrap_or_else(|| panic!("WebviewUrl::App 里的字符串没有闭合"));
            urls.push(rest[..end].to_string());
        }
        assert!(
            urls.len() >= 4,
            "应当能找到设置 / 日志 / 群任务 / 图片预览四个窗口的 URL，实际 {}",
            urls.len()
        );
        assert!(
            !urls.iter().any(|u| u == "index.html"),
            "独立窗口不得再共用主窗口的 index.html（那会让它先把聊天三栏挂起来）：{urls:?}"
        );
        // 外链窗口是唯一**不走 App 文档**的窗口（它加载远端 URL），必须真的是 External。
        assert!(
            commands.contains("WebviewUrl::External("),
            "外链窗口必须用 `WebviewUrl::External` 加载远端 URL"
        );

        // 每个 URL 都必须真的存在，且它引用的入口也必须存在 —— 这是"改了文件名忘改另一处"
        // 的唯一防线（前端构建不会因为 Rust 里的字符串写错而失败）。
        for (url, entry) in [
            ("settings.html", "src/entries/settings.ts"),
            ("logs.html", "src/entries/logs.ts"),
            ("todos.html", "src/entries/todos.ts"),
            ("preview.html", "src/entries/preview.ts"),
        ] {
            assert!(
                urls.iter().any(|u| u == url),
                "Rust 侧应当打开 {url}：{urls:?}"
            );
            // 每条 URL 都要显式列出来：`_ =>` 兜底会让新增的窗口"读到别人的 HTML"，
            // 于是下面那条 contains 断言替别人通过 —— 护栏变成空转。
            let html = match url {
                "settings.html" => include_str!("../../settings.html").to_string(),
                "logs.html" => include_str!("../../logs.html").to_string(),
                "todos.html" => include_str!("../../todos.html").to_string(),
                "preview.html" => include_str!("../../preview.html").to_string(),
                _ => unreachable!("新增 url 必须在这里补自己的 include_str!"),
            };
            assert!(
                html.contains(&format!("/{entry}")),
                "{url} 必须加载自己的入口 /{entry}（窗口差异由文档承担，而不是在一个入口里 if/else）"
            );
            // 入口文件真的存在（`include_str!` 让"文件被删/改名"在编译期就报错）
            match entry {
                "src/entries/settings.ts" => {
                    let _ = include_str!("../../src/entries/settings.ts");
                }
                "src/entries/logs.ts" => {
                    let _ = include_str!("../../src/entries/logs.ts");
                }
                "src/entries/todos.ts" => {
                    let _ = include_str!("../../src/entries/todos.ts");
                }
                "src/entries/preview.ts" => {
                    let _ = include_str!("../../src/entries/preview.ts");
                }
                _ => unreachable!("新增 entry 必须在这里补自己的 include_str!"),
            }
        }
    }

    /// **独立窗口的打开必须是"单例 + 串行创建 + 关闭即隐藏"**。
    ///
    /// 为什么（用户 2026-09-12 实测）：
    ///   - 连点两下会**开出第二个窗口**：`WebviewWindowBuilder::build()` 的重复 label 检查在
    ///     `prepare_window` 里做，而窗口被登记进 manager 是在主线程创建完成之后 ——
    ///     两个并发调用会双双通过检查（后者还会覆盖 manager 的记录）。
    ///   - 关闭即销毁 ⇒ 每次打开都要重建 WebView + 重新加载前端 + 重新 `app.init()`，
    ///     这正是"点一下要等很久"。
    #[cfg(desktop)]
    #[test]
    fn aux_window_open_is_singleton_serialized_and_resident() {
        let commands = all_commands_src();

        for signature in [
            "pub fn open_settings_window(",
            "pub fn open_log_window(",
            "pub fn open_link_window(",
            "fn ensure_preview_window(",
            "fn ensure_tasks_window(",
        ] {
            let body = rust_fn_body(commands, signature);
            assert!(
                body.contains("ensure_aux_window("),
                "{signature}…）必须走 `ensure_aux_window`（单例 + 串行创建）——                  自己写 `if let Some(win) = get_webview_window(..)` 会在并发时开出第二个窗口"
            );
            assert!(
                !body.contains("get_webview_window("),
                "{signature}…）不该自己查窗口存在性：那是 `ensure_aux_window` 的职责"
            );
        }

        let helper = rust_fn_body(commands, "fn ensure_aux_window<F, P>(");
        // 防"锚点过期 ⇒ 拿到空/残段 ⇒ 下面的断言空转"。
        assert!(
            !helper.is_empty(),
            "找不到 `ensure_aux_window` 的函数体（这条护栏会变成空转）"
        );
        assert!(
            helper.contains("AUX_WINDOW_CREATE_LOCK"),
            "`ensure_aux_window` 必须用创建锁串行化（否则并发会开出第二个窗口）"
        );
        assert!(
            // 签名在 2026-09-24 多了 `reveal`（预热那条路要"建好但不显示"），
            // 2026-10-14 又多了 `placed`（摆位必须落在锁外）。判据本身没变：
            // **拿锁前后各查一次**，少一次就会在并发下开出第二个窗口。
            // 变的是"锁内那一次怎么查"：现在必须是 `get_webview_window`（只读管理器那张表），
            // **不许**是 `show_existing_aux_window`（它里面要 `recenter` ⇒ 等主线程应答的 getter，
            // 那就是"带着不可重入的锁等主线程"，见 `aux_window_create_lock_scope_never_waits_on_the_main_thread`）。
            helper.contains("show_existing_aux_window(app, label, geo, reveal)")
                && helper.contains("app.get_webview_window(label)"),
            "`ensure_aux_window` 必须做双重检查（锁外快路径 + 锁内存在性判定），少一次就会开出第二个窗口"
        );
        assert!(
            // 2026-09-17：`resident` 改成参数（设置/日志常驻；群任务窗口每群一个 ⇒ 关闭即销毁）。
            // 判据是"常驻开关接上了 hide-on-close"，不再要求 helper 里出现某个具体常量。
            helper.contains("resident: bool") && helper.contains("install_hide_on_close(&win)"),
            "`ensure_aux_window` 里必须接上「关闭即隐藏」（常驻）——              否则每次打开都要重新加载 WebView + 前端，用户要等（`resident` 是开关）"
        );
        // 2026-09-24 策略翻转（用户："其他新窗口默认不销毁，第二次打开速度优化快点"）：
        // 常驻 = 群任务 / 预览 / 外链；销毁 = 设置 / 日志（这两个每次都要读最新的环境与日志尾部）。
        // 钉四件事，缺一条都是一个具体的回归：
        for (signature, want_resident) in [
            ("const AUX_TASKS_RESIDENT: bool = ", true),
            ("const AUX_PREVIEW_RESIDENT: bool = ", true),
            ("const AUX_LINK_RESIDENT: bool = ", true),
            ("const AUX_WINDOWS_RESIDENT: bool = ", false),
        ] {
            let want = format!("{signature}{want_resident}");
            assert!(
                commands.contains(&want),
                "常驻策略被改动了：{want} —— 改成销毁要连「为什么」一起写进这条注释，别只翻布尔值"
            );
        }
        // 常驻的群任务窗口必须只有**一扇**（固定 label）：动态 label 既需要淘汰逻辑，
        // 也让"不传参数预热"做不到。
        assert!(
            !code_flat(&commands).contains("WINDOW_GROUP_TODOS_PREFIX"),
            "群任务窗口又回到动态 label 了：那样既不累积不了（需要淘汰），也没法不传参数预热"
        );
        // 预热必须是"建好但不显示"：reveal 传 false，且它自己不许出现 show/focus。
        // 少了这条，预热就变成"启动时弹出一扇没内容的预览窗"（比慢更糟）。
        let prewarm = rust_fn_body(commands, "pub fn prewarm_aux_windows(");
        assert!(
            code_flat(&prewarm).contains("ensure_preview_window(&app,&state,false)"),
            "预热必须把预览窗备好，且走共用的窗口构造、reveal 传 false"
        );
        // ⚠️ **群任务窗不预热**（2026-10-12 决策，反了这条就是回归）：
        // 它常驻（`AUX_TASKS_RESIDENT = true`）⇒ 启动时那 ~23 MB 的 WebView 是**白占**的，
        // 而首开群任务是低频动作，付一次 1–2 秒完全可以接受，付完之后照样秒开。
        // 旧注释里"label 是 `todo-<groupId>`、启动时不知道是哪个群"那套说法**已过时**：
        // label 现在是固定常量 `WINDOW_TASKS`（`ensure_tasks_window` 里实证），
        // 全应用只有一扇常驻群任务窗，切群是对已存在的窗发 `group-todos-target` 事件。
        // ⇒ 当年"预热没有确定性"的理由不成立，但"不预热"这个结论仍然成立，只是理由换成了收益。
        assert!(
            !code_flat(&prewarm).contains("ensure_tasks_window("),
            "群任务窗不许再预热：它常驻 ⇒ 启动预热纯属白占约 23 MB 常驻内存（2026-10-12）"
        );
        assert!(
            !code_flat(&prewarm).contains(".show()")
                && !code_flat(&prewarm).contains(".set_focus()"),
            "预热路径里不许出现 show / set_focus —— 那会变成启动时弹一扇空窗"
        );
        let hide = rust_fn_body(commands, "fn install_hide_on_close(");
        assert!(
            hide.contains("prevent_close()") && hide.contains("hide()"),
            "`install_hide_on_close` 必须是 prevent_close + hide（关闭即隐藏）"
        );
        // ⚠️ 这条只判**函数体**：`rust_fn_body` 的起点是签名，所以上面那段解释"淘汰为什么不能
        // 放在这里"的注释（里面写着 `destroy()`）不会被算进来。
        assert!(
            !code_flat(&hide).contains(".destroy()"),
            "销毁不得发生在窗口事件回调里 —— 那是 wry 的主线程事件循环，\
             本文件已经为此死锁过一次（见 `log_window_body` 的说明）"
        );

        // 尺寸/位置必须走**物理像素**的 setter，不能走 builder 的逻辑坐标 `position()`：
        // `tao` 创建窗口时会把逻辑坐标**逐个显示器**按各自缩放换回物理、取第一个命中的显示器
        // （见 commands.rs 的 `fit_aux_window`），所以多屏不同缩放时子窗口会跑到另一块屏上
        // —— 用户 2026-09-16 实测报的正是这个，且它在单屏上完全看不出来。
        for signature in [
            "pub fn open_settings_window(",
            "pub fn open_log_window(",
            "pub fn open_link_window(",
            "fn ensure_preview_window(",
            "fn ensure_tasks_window(",
        ] {
            let body = rust_fn_body(commands, signature);
            assert!(
                body.contains("apply_aux_geometry("),
                "{signature}…）必须用 `apply_aux_geometry` 在 `build()` 之后按物理像素落地尺寸与位置"
            );
            assert!(
                !body.contains(".position("),
                "{signature}…）不得用 builder 的 `.position()`：它只有逻辑坐标，多屏不同缩放时\n\
                 会被 tao 换算到另一块显示器上（改用 apply_aux_geometry）"
            );
            assert!(
                body.contains(".visible(false)"),
                "{signature}…）必须**隐藏创建**：`ensure_aux_window` 随后才 show，\n\
                 中间这段用来摆位置/尺寸，否则窗口会先在默认位置闪一下再跳过去"
            );
        }
    }

    /// 装饰性数据**不得否决用户的动作**（2026-09-24 复查辅助窗口时找到的同形状缺陷）。
    ///
    /// `open_group_todos_window` 原先在"取群名填系统标题"那一步，拿不到 DB 锁时直接
    /// 拒掉整个开窗 —— 于是 DB 一忙（文件传输的进度写库、批量落库都算），这扇窗**根本
    /// 打不开**，而失败在前端只变成一句 toast，用户读到的是"点了没反应"。
    /// 群名只是任务栏那一点装饰（文档加载后前端会按同样口径再取一次并接管标题），
    /// 为它牺牲一次用户动作是彻头彻尾的错配。
    ///
    /// 判据取**正向形状**两条（必须是 match、拿不到锁那支必须给空串）。刻意不写负向断言：
    /// 本文件读的是原始源码（不剥注释），一句解释"以前错在哪"的注释就会把自己踩红 ——
    /// 同一课今天上午刚踩过一次（`windowEntries` 被"这里绝不调用 chat.init()"那句注释判红）。
    #[test]
    fn cosmetic_title_read_cannot_abort_the_window() {
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "pub fn open_group_todos_window(");
        let flat = code_flat(&body);
        assert!(
            flat.contains("matchstate.db.try_lock()"),
            "群名那一步必须是 try_lock 的 match（两支都往下走），不能是拿不到锁就中止"
        );
        assert!(
            flat.contains("Err(_)=>String::new()"),
            "拿不到锁的分支必须降级成空群名 —— 这是开窗路径上唯一允许「软失败」的地方"
        );
    }

    /// 外链 URL 的**协议白名单**（用户配置的网址会被 `WebviewUrl::External` 直接加载）。
    ///
    /// 为什么必须表驱动钉死：`javascript:` / `data:` / `file:` / `tauri:` 一旦漏过，
    /// 等于把"在应用 WebView 里执行脚本 / 读本机文件"的能力交给一段用户随手粘贴的字符串。
    #[test]
    fn external_link_rejects_non_http_schemes() {
        use crate::commands::validate_external_url;
        for ok in [
            "http://example.com",
            "https://example.com/a?b=c",
            "  https://a.b.c  ",
        ] {
            assert!(validate_external_url(ok).is_ok(), "应当放行：{ok}");
        }
        for bad in [
            "",
            "   ",
            "example.com",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "tauri://localhost",
            "https://",
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "必须拒绝非 http/https 或缺少主机名的输入：{bad}"
            );
        }
    }

    /// 导出清理只许删 `cache/exports` 的直接子文件，且文件名必须是导出命令生成的形状。
    ///
    /// 真实风险：`Path::starts_with` 是词法比较，`exports/../../x` 也能过；`remove_file`
    /// 随后按 OS 语义解析 `..` ⇒ 一条 IPC 就能删到目录外。这条钉住那个绕过形状。
    #[test]
    fn external_link_cleanup_rejects_paths_outside_exports() {
        use crate::commands::is_export_artifact_path;
        use std::path::Path;
        let dir = Path::new("/tmp/cache/exports");
        assert!(is_export_artifact_path(
            dir,
            Path::new("/tmp/cache/exports/gosslan-links-abc.json")
        ));
        for bad in [
            "/tmp/cache/exports/../secrets.json",
            "/tmp/cache/exports/../../etc/passwd",
            "/tmp/cache/other/gosslan-links-abc.json",
            "/tmp/cache/exports/other.json",
            "/tmp/cache/exports/gosslan-links-abc.json.bak",
            "/tmp/cache/exports/gosslan-links-..json",
            "/tmp/cache/exports",
        ] {
            assert!(!is_export_artifact_path(dir, Path::new(bad)), "必须拒绝：{bad}");
        }
    }

    /// 群任务窗口是**固定 label** `tasks`，"看哪个群"改由后端那份当前上下文给。
    ///
    /// 为什么钉这个形状（用户 2026-09-24）："可不传参数、后台默默先把 WebView 建好，用的时候
    /// 瞬间激活" —— 动态 label（`todo-<groupId>`）在预热那一刻不知道该建哪一扇，"秒开"
    /// 只能建立在固定 label 上。两头各钉一次：Rust 常量与前端启动器的字面量必须同为 `tasks`
    /// （两份各写一遍必然漂移，这是本仓库反复踩过的一族）。
    #[cfg(desktop)]
    #[test]
    fn tasks_window_uses_one_fixed_label_cross_checked_with_frontend() {
        assert_eq!(WINDOW_TASKS, "tasks");
        assert!(
            WINDOW_LABELS.contains(&WINDOW_TASKS),
            "固定 label 必须进 WINDOW_LABELS（capability 覆盖那条守卫才不会漏看它）"
        );
        let commands = all_commands_src();
        let body = rust_fn_body(commands, "fn ensure_tasks_window(");
        assert!(
            body.contains("crate::WINDOW_TASKS"),
            "窗口 label 必须取自常量，不许在 builder 里另写字面量"
        );
        // groupId 不再是 label 的一部分，但它仍然跨窗口当指令拿去查数据 ⇒ 校验不能省
        let open = rust_fn_body(commands, "pub fn open_group_todos_window(");
        assert!(
            open.contains("is_ascii_alphanumeric()") && open.contains("is_empty()"),
            "groupId 会被别的文档拿去查数据，必须先做非空/字符集校验"
        );
        let ts = include_str!("../../src/composables/useWindowLauncher.ts");
        assert!(
            ts.contains(r#""tasks""#),
            "前端启动器的 label 联合类型必须含 `tasks`（与 Rust WINDOW_TASKS 同一份字面量）"
        );
    }

    /// 建窗那把**不可重入**创建锁的作用域里，不许出现任何"要等主线程应答"的调用
    /// （2026-10-14 Windows 真机：Mac 往 Windows 传 3.x GB，收尾那一段
    /// 「点设置没窗、拖窗口没反应」）。
    ///
    /// 为什么必须有这条：`ensure_aux_window` 的注释把"锁里只留建窗"写得很清楚，而注释挡不住
    /// 任何人把 `apply_aux_geometry(win, g)` 这类摆位调用挪回锁内 —— 那几步问的是窗口自己的
    /// 外框 / 所在屏（`tauri-runtime-wry` 的 `getter!` 就是 `rx.recv()`，**真等主线程**）。
    /// 主线程一忙，这个工作线程就带着创建锁挂住 ⇒ 四扇辅助窗一起点不开。
    ///
    /// 判据形状：按花括号配对切出**每一处持锁块**逐块扫标记；再反钉这些标记在文件里确实存在
    /// （否则"全文已经没有摆位调用"会让这条判据静默空转）。
    #[test]
    fn aux_window_create_lock_scope_never_waits_on_the_main_thread() {
        let src = include_str!("commands/logs.rs");
        let bytes = src.as_bytes();
        // 只算"真的在取锁"的那几处（`static AUX_WINDOW_CREATE_LOCK: …` 那行声明不算）。
        let sites: Vec<usize> = bytes
            .iter()
            .enumerate()
            .filter(|(_, b)| **b == b'A')
            .map(|(i, _)| i)
            .filter(|i| {
                src[*i..].starts_with("AUX_WINDOW_CREATE_LOCK")
                    && src[*i + "AUX_WINDOW_CREATE_LOCK".len()..]
                        .chars()
                        .filter(|c| !c.is_whitespace())
                        .collect::<String>()
                        .starts_with(".lock()")
            })
            .collect();
        assert!(
            !sites.is_empty(),
            "一处持锁点都没找到 ⇒ 这条判据会空转（锁被删掉时它也必须报红，而不是变绿）"
        );
        // 等主线程应答的 runtime getter，以及会走到它们身上的本项目函数
        let blocking = [
            "outer_size(",
            "outer_position(",
            "scale_factor(",
            "inner_position(",
            "current_monitor(",
            "primary_monitor(",
            "monitor_from_point(",
            "is_maximized(",
            "recenter_aux_window(",
            "apply_aux_geometry(",
            "restore_aux_window_size(",
            "show_existing_aux_window(",
            "install_hide_on_close(",
            "decorate_aux_window(",
            // `placed` 是"建好之后要做的摆位/收尾"整段（里面就是上面那些 getter）。
            // 需求 4 说的"锁内只执行必要创建逻辑"，落在源码上就是这一条不许进锁块 ——
            // 少了这个标记，把 `placed(&win)` 挪回锁内仍然判绿（评审 2026-10-14 抓到）。
            "placed(",
        ];
        for at in sites {
            // 反向扫到"包含这次取锁的块"的开括号
            let mut depth = 0i32;
            let mut open = None;
            for j in (0..at).rev() {
                match bytes[j] {
                    b'}' => depth += 1,
                    b'{' => {
                        if depth == 0 {
                            open = Some(j);
                            break;
                        }
                        depth -= 1;
                    }
                    _ => {}
                }
            }
            let open =
                open.expect("取锁语句必须落在某个块里（切不出块首 = 本判据不认识这个形状）");
            let mut depth = 0i32;
            let mut close = None;
            for k in open..bytes.len() {
                match bytes[k] {
                    b'{' => depth += 1,
                    b'}' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(k);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let close = close.expect("持锁块的括号不配对");
            let block = &src[open..=close];
            for marker in blocking {
                assert!(
                    !block.contains(marker),
                    "创建锁的作用域里出现了 `{marker}`：它要等主线程应答。主线程一忙，这个线程就带着\
                     不可重入的创建锁挂住 ⇒ 所有辅助窗一起点不开（2026-10-14 Windows 真机）。\
                     挪到锁外去 —— `ensure_aux_window` 的 `placed` 闭包就是为这件事拆出来的。"
                );
            }
            assert!(
                block.contains("build()"),
                "持锁块里必须仍有 build()：串行创建是这条锁存在的理由。\
                 若有意改成\"锁外建窗\"，要连同本判据一起重写，不是绕过它。"
            );
        }
        // 反空转：这些调用在文件里必须仍然存在（只是必须落在锁外）
        for marker in [
            "recenter_aux_window(",
            "apply_aux_geometry(",
            "decorate_aux_window(",
        ] {
            assert!(
                src.contains(marker),
                "logs.rs 里已经没有 `{marker}` ⇒ 上面那圈断言会因为\"全文没有这种调用\"而空转：\
                 请把这条判据一并改掉，别留一条永远为真的守卫"
            );
        }
    }
