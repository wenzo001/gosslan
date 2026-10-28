// 职责边界：
// - `lib_tests.rs` 测试分册之3 —— 安卓 JNI：Rust extern 与 Kotlin 签名互点、release 的 proguard keep 名单
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
    /// **Kotlin ↔ Rust 的 JNI 方法签名必须逐字对齐**。
    ///
    /// JNI 调用**不做任何编译期检查**：描述符写错只会在运行期抛 `NoSuchMethodError`，
    /// 而且只有真机上才现形。真实缺陷（本轮 code review 抓到）：
    /// Kotlin 的 `fun stop()` 是 Unit 方法（JNI `()V`），Rust 侧却用 `()Z` 调用 ⇒
    /// 用户关掉「蓝牙通道」后手机**仍在广播**（耗电 + 隐私），日志里一个字都没有。
    ///
    /// 这条护栏在**主机上**就能跑：解析 Kotlin 源码里 `fun` 的形参/返回类型推出 JNI 描述符，
    /// 与 Rust 侧 `kotlin_method!("名字", "描述符")` 的登记逐条比对；
    /// 并检查每个 `extern fn`（native 回调）在 Kotlin 里确有同名 `external fun`。
    #[test]
    fn android_jni_signatures_match_kotlin() {
        let kotlin =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/BlePeripheral.kt");
        let rust = include_str!("transport/ble_android.rs");
        // 第二条 JNI 桥：「用系统里的其它应用打开文件」（FileProvider）。同一个坑，
        // 所以必须同一条护栏盯着 —— 新桥单独立一份检查只会漂移。
        let kotlin_open =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/OpenWith.kt");
        let rust_open = include_str!("android_open.rs");

        // 第三条 JNI 桥：「后台连接的前台服务」（ADR-0022）。同一个坑（描述符写错只在真机
        // 运行期抛 NoSuchMethodError）⇒ 必须同一条护栏盯着；给新桥单独立一份检查只会漂移。
        let kotlin_bg =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/BackgroundService.kt");
        let rust_bg = include_str!("android_background.rs");

        let kotlin_fns = parse_kotlin_funs(kotlin);
        let open_fns = parse_kotlin_funs(kotlin_open);
        let bg_fns = parse_kotlin_funs(kotlin_bg);
        for expected in [
            "start",
            "stop",
            "send",
            "isConnected",
            "payloadMtu",
            "nativeBootstrap",
            "nativeOnFrame",
            "nativeOnUnlinked",
            "nativeOnNotice",
            "nativeOnWarning",
        ] {
            assert!(
                kotlin_fns.iter().any(|(n, _, _)| n == expected),
                "没在 BlePeripheral.kt 里解析到 `{expected}` —— Kotlin 写法变了就要同步更新本护栏"
            );
        }
        // 打开/保存文件的桥：Rust 调 openWith / saveWith / writeBytesWith / convertHeicToJpeg
        // / isHevcVideo / isMotionPhoto，Kotlin 调 nativeAttachOpenWith
        for (file, fns, expected) in [
            ("OpenWith.kt", &open_fns, "openWith"),
            ("OpenWith.kt", &open_fns, "saveWith"),
            ("OpenWith.kt", &open_fns, "writeBytesWith"),
            ("OpenWith.kt", &open_fns, "convertHeicToJpeg"),
            ("OpenWith.kt", &open_fns, "isHevcVideo"),
            ("OpenWith.kt", &open_fns, "isMotionPhoto"),
            ("OpenWith.kt", &open_fns, "nativeAttachOpenWith"),
        ] {
            assert!(
                fns.iter().any(|(n, _, _)| n == expected),
                "没在 {file} 里解析到 `{expected}` —— Kotlin 写法变了就要同步更新本护栏"
            );
        }
        // 后台服务桥：Rust 调 start / stop / isRunning / foregroundTypes / lastStartError，
        // Kotlin 调 nativeAttachBackground。这五个名字钉住的是"解析器真的吃到了这一册"——
        // 解析器一失效，下面的逐字比对会整批空转（本仓反复踩过的假绿形状）。
        for expected in [
            "start",
            "stop",
            "isRunning",
            "foregroundTypes",
            "lastStartError",
            "nativeAttachBackground",
        ] {
            assert!(
                bg_fns.iter().any(|(n, _, _)| n == expected),
                "没在 BackgroundService.kt 里解析到 `{expected}` —— Kotlin 写法变了就要同步更新本护栏"
            );
        }

        // ① Rust 登记的每个 Kotlin 方法，描述符必须与 Kotlin 源码推出的**逐字相同**
        let registered = parse_kotlin_method_registrations(rust);
        assert!(
            registered.len() >= 5,
            "Rust 侧至少应登记 5 个 Kotlin 方法，实际 {}",
            registered.len()
        );
        let open_registered = parse_kotlin_method_registrations(rust_open);
        assert_eq!(
            open_registered.len(),
            6,
            "android_open.rs 应恰好登记 6 个 Kotlin 方法（openWith + saveWith + writeBytesWith + convertHeicToJpeg + isHevcVideo + isMotionPhoto），实际 {} —— \
             解析器失效或有人漏登记",
            open_registered.len()
        );
        // 后台服务桥：应恰好 5 个登记（start + stop + isRunning + foregroundTypes + lastStartError）。
        let bg_registered = parse_kotlin_method_registrations(rust_bg);
        assert_eq!(
            bg_registered.len(),
            5,
            "android_background.rs 应恰好登记 5 个 Kotlin 方法（start + stop + isRunning + foregroundTypes + lastStartError），实际 {} —— \
             解析器失效或有人漏登记",
            bg_registered.len()
        );
        let mut static_checked = 0usize;
        // ⚠️ **按册配对**比对，不把三条桥的方法名混进一张表再 chain 着查：
        // `start` / `stop` 在 BlePeripheral.kt 与 BackgroundService.kt 里**都存在**，描述符也恰好
        // 一样（都是 `()Z`）。链在一起查时后台服务那两个名字会被蓝牙那册的答案判过 ⇒
        // 真写错的描述符照样绿（"锚点命中同文另一元素"那一族，本仓踩过多次）。
        for (regs, fns, file, kt) in [
            (&registered, &kotlin_fns, "BlePeripheral.kt", kotlin),
            (&open_registered, &open_fns, "OpenWith.kt", kotlin_open),
            (&bg_registered, &bg_fns, "BackgroundService.kt", kotlin_bg),
        ] {
            for (name, desc) in regs {
                let (_, kotlin_desc, _) = fns
                    .iter()
                    .find(|(n, _, _)| n == name)
                    .unwrap_or_else(|| panic!("Rust 登记了 {file} 里不存在的 `{name}`"));
                assert_eq!(
                    kotlin_desc, desc,
                    "`{name}` 的 JNI 描述符不一致：Kotlin 是 `{kotlin_desc}`，Rust 却按 `{desc}` 调用 \
                     —— JNI 不做任何编译期检查，这只会在真机上抛 NoSuchMethodError"
                );

                // ③ Rust 用 `call_static_method` 调它 ⇒ Kotlin 侧必须有**静态桥**。
                //    顶层函数天然是 static；`object`/`class`/companion 的成员**必须带 `@JvmStatic`** ——
                //    少了它真机日志是 `JNI 调用失败：Method not found: start ()Z`
                //    （蓝牙外设整条路径失效，而 central 扫描不受影响 ⇒ 症状极其隐蔽）。
                // ⚠️ 找声明行要**跳过注释行**：KDoc/注释里转述的 `` `fun lastStartError()` `` 不是声明，
                // 命中它之后"往上 12 行找 @JvmStatic"必然找不到 ⇒ 报一条与事实相反的假红
                // （实测就是被 BackgroundService.kt 里那句说明触发的）。口径同本册另一条守卫：
                // 判形状之前先剥注释，否则判据咬到自己的说明文字。
                let (idx, decl) = kt
                    .lines()
                    .enumerate()
                    .filter(|(_, l)| {
                        let t = l.trim_start();
                        !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
                    })
                    .find(|(_, l)| l.contains(&format!("fun {name}(")))
                    .unwrap_or_else(|| panic!("在 {file} 里找不到 `fun {name}(` 的声明行"));
                let indented = decl.starts_with(' ') || decl.starts_with('\t');
                if indented {
                    let lines: Vec<&str> = kt.lines().collect();
                    let from = idx.saturating_sub(12);
                    let annotated = lines[from..idx].iter().any(|l| l.trim() == "@JvmStatic");
                    assert!(
                        annotated,
                        "`{name}` 是 {file} 里 object/class 的成员，而 Rust 用 call_static_method 调它 \
                         ⇒ 必须在它上面加 `@JvmStatic`（否则没有静态桥：真机 `Method not found: {name}`）"
                    );
                }
                static_checked += 1;
            }
        }
        assert!(
            static_checked >= 14,
            "应检查 ≥14 个 Kotlin 方法：OpenWith 那批先钉死为 6、BlePeripheral 至少 5，\
             再加后台服务桥的 5 个 ⇒ 14 是「三条桥都走进来了」的最小分母（实际 {static_checked}，\
             少一个就说明某条桥的登记没被解析到）"
        );

        // ② Rust 导出的 native 回调（snake_case → lowerCamelCase）必须在 Kotlin 里是 external fun
        for snake in parse_extern_fn_names(rust)
            .into_iter()
            .chain(parse_extern_fn_names(rust_open))
            .chain(parse_extern_fn_names(rust_bg))
        {
            let camel = snake_to_lower_camel(&snake);
            let found = kotlin_fns
                .iter()
                .chain(open_fns.iter())
                .chain(bg_fns.iter())
                .find(|(n, _, _)| n == &camel)
                .unwrap_or_else(|| {
                    panic!(
                        "Rust 导出了 native 方法 `{snake}`（Java 名 `{camel}`），但 Kotlin 里没有这个 \
                         `external fun` —— JVM 会 UnsatisfiedLinkError"
                    )
                });
            assert!(
                found.2,
                "Kotlin 的 `{camel}` 不是 `external` 声明，JVM 不会去查 native 实现"
            );
        }
    }

    /// 安卓「另存为」桥：**成功也必须返回 null**。
    ///
    /// 真实缺陷：`openOutputStream(...)?.use { ...; null } ?: "无法写入所选位置"`
    /// 里 `use` 返回 block 的最后一个表达式（null），于是成功也走 Elvis 右侧 ⇒
    /// 文件已写完、界面却报“无法打开/保存”。这条判据在主机上跑，按函数体形状判：
    /// 必须先判空流，再用 use 写完，最后显式返回 null；禁止把 `use` 的结果当成功标志。
    #[test]
    fn android_save_bridge_does_not_report_success_as_failure() {
        let kotlin =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/OpenWith.kt");
        for name in ["saveWith", "writeBytesWith"] {
            let at = kotlin
                .find(&format!("fun {name}("))
                .unwrap_or_else(|| panic!("OpenWith.kt 里找不到 fun {name}("));
            let rest = &kotlin[at..];
            let end = rest
                .find("\n  /**")
                .or_else(|| rest.find("\n  @JvmStatic"))
                .unwrap_or(rest.len());
            let body = &rest[..end];
            // 注释里会转述旧写法（`use { ...; null } ?: 失败串`）；判形状前先剥注释，
            // 否则这条判据会咬到自己的说明文字（本仓反复踩过的那一类）。
            let code = body
                .lines()
                .filter(|l| {
                    let s = l.trim();
                    !s.starts_with("//") && !s.starts_with("*") && !s.starts_with("/*")
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                code.contains("openOutputStream(uri, \"wt\")"),
                "{name} 必须自己打开 content:// 输出流"
            );
            assert!(
                code.contains("if (out == null)"),
                "{name} 必须先把空流判成“无法写入所选位置”，不能拿 use 的返回值做 Elvis 判据"
            );
            assert!(
                code.contains("out.use {"),
                "{name} 必须在判空后用 use 关闭输出流"
            );
            assert!(
                !code.contains("} ?: \"无法写入所选位置\""),
                "{name} 仍在用 `use {{ ...; null }} ?: 失败串`：成功会被当成失败"
            );
        }
    }

    /// **JNI 的 static / 实例形态必须与 Kotlin 声明的形态一致**。
    ///
    /// 真实缺陷（2026-09-12 真机实测的**启动闪退**，而且编译、单测、构建全绿）：
    /// `OpenWith.kt` 里 `nativeAttachOpenWith()` 是**文件级（顶层）函数** ⇒ 编译成
    /// `OpenWithKt` 的 **static** 方法；而 Rust 侧的 `native_method!` 少了 `static` 关键字
    /// ⇒ 宏把它按**实例方法**注册。ART 在第一次调用时判定不一致并**直接 abort 整个进程**：
    ///   `Native method '"nativeAttachOpenWith"' was registered as instance but called as static method`
    /// （崩溃栈落在 `MainActivity.onCreate` → `OpenWith.bootstrap`）。
    ///
    /// 判据（Kotlin 的一行声明就足够）：**顶格声明的 `external fun` = 顶层 = static**；
    /// 缩进在 `object`/`class` 里的 = 成员 = 实例。两者与 Rust 的 `static` 关键字必须一一对应。
    /// 对照：`BlePeripheral` 的 `nativeBootstrap()` 在 object 内 ⇒ 实例 ⇒ 宏不加 `static`。
    #[test]
    fn jni_static_matches_kotlin_toplevel() {
        let ble_kt =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/BlePeripheral.kt");
        let open_kt = include_str!("../gen/android/app/src/main/java/com/gosslan/app/OpenWith.kt");
        let bg_kt = include_str!("../gen/android/app/src/main/java/com/gosslan/app/BackgroundService.kt");
        let cases = [
            (include_str!("transport/ble_android.rs"), ble_kt),
            (include_str!("android_open.rs"), open_kt),
            (include_str!("android_background.rs"), bg_kt),
        ];
        let mut checked = 0usize;
        for (rust, kotlin) in cases {
            for (snake, is_static) in rust_native_methods(rust) {
                let camel = snake_to_lower_camel(&snake);
                let toplevel = kotlin_fun_is_toplevel(kotlin, &camel).unwrap_or_else(|| {
                    panic!("Kotlin 里找不到 native 方法 `{camel}` —— 护栏需要同步更新")
                });
                assert_eq!(
                    is_static, toplevel,
                    "`{camel}` 的 static 形态与 Kotlin 不一致：Rust 注册为{}，Kotlin 却是{}函数 ——                      真机第一次调用时 ART 会直接 abort（进程消失、连日志都来不及写全）",
                    if is_static { "static" } else { "实例" },
                    if toplevel { "顶层（=static）" } else { "成员（=实例）" },
                );
                checked += 1;
            }
        }
        assert!(
            checked >= 6,
            "应至少检查 6 个 native 方法（BlePeripheral 5 个 + OpenWith 1 个 + BackgroundService 1 个），实际 {checked} —— 解析器失效了"
        );
    }

    /// 解析 Rust 侧 `native_method! { … extern fn <名字> … }` → (snake 名, 是否 static)。
    fn rust_native_methods(src: &str) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        let mut rest = src;
        while let Some(i) = rest.find("native_method! {") {
            rest = &rest[i + "native_method! {".len()..];
            let head = match rest.find("fn =") {
                Some(e) => &rest[..e],
                None => continue,
            };
            if let Some(p) = head.find("extern fn ") {
                let after = &head[p + "extern fn ".len()..];
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if !name.is_empty() {
                    out.push((name, head[..p].contains("static")));
                }
            }
        }
        out
    }

    /// Kotlin 里 `fun <camel>(` 这一行是否**顶格**（顶格 = 顶层函数 = JNI static）。
    fn kotlin_fun_is_toplevel(src: &str, camel: &str) -> Option<bool> {
        let needle = format!("fun {camel}(");
        src.lines().find(|l| l.contains(&needle)).map(|l| {
            let mut chars = l.chars();
            !matches!(chars.next(), Some(' ') | Some('\t'))
        })
    }

    /// **release 包必须 keep 住 Rust 按名字调用的 Kotlin 方法**。
    ///
    /// R8 在 release 下会把它们改名（**实测**：`stop`/`start`/`send`/… 全变成 `a`/`b`/`c`/…），
    /// 而 JNI 只按「名字 + 签名」查找 ⇒ release 真机包上蓝牙外设整条路径 `NoSuchMethodError`。
    /// debug 包不做混淆，所以这个坑在开发期完全看不见（我是在打 release 包时才抓到的）。
    /// 这条护栏同时盯两种漂移：规则里**漏了**方法，以及规则里**多留了**已废弃的方法。
    #[test]
    fn release_keeps_every_kotlin_method_called_from_rust() {
        let rust = include_str!("transport/ble_android.rs");
        // 单一事实来源：`scripts/android/proguard-gosslan.pro`（`gen/android` 是生成物，
        // `tauri android init` 会重生它，所以注入脚本每次构建前都把这份搬进去）。
        let source = include_str!("../../scripts/android/proguard-gosslan.pro");
        let generated = include_str!("../gen/android/app/proguard-rules.pro");

        let source_block = proguard_jni_block(source)
            .expect("scripts/android/proguard-gosslan.pro 里没有 GOSSLAN_JNI 标记块");
        let generated_block = proguard_jni_block(generated).expect(
            "gen/android/app/proguard-rules.pro 里没有 GOSSLAN_JNI 标记块 —— \
             跑 `node scripts/inject-android-signing.mjs`（或任意一次 android 构建）就会补上；\
             缺了它，release 包的蓝牙在真机上会 NoSuchMethodError",
        );
        assert_eq!(
            source_block, generated_block,
            "两处 JNI keep 规则漂移了：事实来源是 scripts/android/proguard-gosslan.pro，\
             gen/android/app/proguard-rules.pro 只是构建时注入的副本"
        );

        let registered = parse_kotlin_method_registrations(rust);
        assert!(
            registered.len() >= 5,
            "Rust 侧至少应登记 5 个 Kotlin 方法，实际 {}",
            registered.len()
        );
        // 打开文件的桥（android_open.rs）同样只被 JNI 按名字调用 ⇒ 必须一起 keep。
        // 两条桥放在一起查，避免"新加的桥忘了写 keep 规则"这种只在 release 真机上现形的漏。
        let registered: Vec<(String, String)> = registered
            .into_iter()
            .chain(parse_kotlin_method_registrations(include_str!(
                "android_open.rs"
            )))
            .chain(parse_kotlin_method_registrations(include_str!(
                "android_background.rs"
            )))
            .collect();
        assert!(
            registered.iter().any(|(n, _)| n == "openWith"),
            "没在 android_open.rs 里解析出 `openWith` 的 JNI 登记 —— 解析器失效了，\
             这条护栏会静默变成空转"
        );
        let kept = proguard_kept_method_names(&source_block);
        assert!(
            kept.len() >= 5,
            "从 keep 块里只解析出 {} 个方法名 —— 护栏解析器失效了（这才是真正的风险：\
             它一旦静默返回空，下面的检查就全是空转）",
            kept.len()
        );

        for (name, _) in &registered {
            assert!(
                kept.iter().any(|k| k == name),
                "keep 规则里缺少 `{name}` —— R8 会把它改名，release 真机上 JNI 找不到这个方法"
            );
        }
        for name in &kept {
            assert!(
                registered.iter().any(|(n, _)| n == name),
                "keep 规则里的 `{name}` 在 Rust 侧已经没有调用登记了（陈旧规则），删掉它"
            );
            // ⚠️ 还必须是 **static**：Rust 用 `env.call_static_method(...)` 调它们，而 Kotlin 的
            // `@JvmStatic fun x()` 在 object 里生成"实例方法 + 静态桥"两个条目 —— 只 keep 实例方法
            // 时 R8 会把静态桥当死代码删掉，真机日志：`JNI 调用失败：Method not found: start ()Z`
            // （蓝牙外设整条路径失效，central 角色不受影响，所以症状很隐蔽）。
            // 只看真正的规则行（`public …;`），别把说明注释里引用的同一句当成规则
            let line = source_block
                .lines()
                .map(str::trim)
                .find(|l| {
                    l.starts_with("public ") && l.ends_with(';') && l.contains(&format!(" {name}("))
                })
                .unwrap_or_else(|| panic!("keep 块里找不到 `{name}` 的规则行"));
            assert!(
                line.trim_start().starts_with("public static"),
                "keep 规则里的 `{name}` 必须写成 `public static …`（实际：`{}`）—— \
                 Rust 是按**静态**方法调它的，只 keep 实例方法会让真机报 `Method not found: {name}`",
                line.trim()
            );
        }

        // ⚠️ 上面那一圈是按**名字**在整块文本里 `find` 规则行，而 `start` / `stop` 在两个
        // `-keep class` 块里各有一份（蓝牙外设与后台服务）—— `find` 只会命中先出现的那一块，
        // 于是后台服务块里的这两行**根本没被检查过**（同文另一元素命中那一族假绿）。
        // 这一圈按**类块**复查后台服务，把盲区关掉：五个名字都必须在它自己的块里、且是 static。
        let bg_block = proguard_class_block(&source_block, "com.gosslan.app.BackgroundService")
            .expect(
                "keep 块里没有 `-keep class com.gosslan.app.BackgroundService` —— \
                 R8 会改掉这些名字，release 真机上后台服务起不来（而症状只是锁屏后收不到消息）",
            );
        for name in [
            "start",
            "stop",
            "isRunning",
            "foregroundTypes",
            "lastStartError",
        ] {
            assert!(
                bg_block.lines().any(|l| {
                    let l = l.trim();
                    l.starts_with("public static") && l.ends_with(';') && l.contains(&format!(" {name}("))
                }),
                "BackgroundService 的 keep 块里缺 `{name}` 的 public static 规则行；块内实测：\n{}",
                bg_block.trim()
            );
        }
        // 反向那格：块里不许留已经没人调用的名字（陈旧 keep 规则会让下一个人以为还有第六个方法）
        let bg_kept = proguard_kept_method_names(&bg_block);
        for name in &bg_kept {
            assert!(
                registered.iter().any(|(n, _)| n == name),
                "BackgroundService 块里的 `{name}` 在 Rust 侧已经没有登记了（陈旧规则），删掉它"
            );
        }
        assert_eq!(
            bg_kept.len(),
            5,
            "BackgroundService 块应恰好 keep 5 个方法，实际 {} —— 解析器失效或有人漏加",
            bg_kept.len()
        );
    }

    /// 取出 `-keep class <类名> { … }` 那一块的正文。
    ///
    /// 为什么需要它：`release_keeps_every_kotlin_method_called_from_rust` 原来的规则行查找是
    /// 在**整块**文本里按名字 `find`，两个类块里有同名方法时只会命中先出现的那一块 ⇒
    /// 后一块里的漏项/非 static 都查不出来。按类取块才是逐类可查的口径。
    fn proguard_class_block(block: &str, class_name: &str) -> Option<String> {
        let header = format!("-keep class {class_name} {{");
        let start = block.find(&header)? + header.len();
        let end = start + block[start..].find('}')?;
        Some(block[start..end].trim().to_string())
    }

    /// **后台服务的接线必须跟着「局域网通道」这一个开关走**（ADR-0022 的决策表第 1 行）。
    ///
    /// 为什么钉源码形状而不是端到端：前台服务只在真机上活着，本机没有安卓设备 ——
    /// `verify:full` 的 Android 那档只 `cargo check --target aarch64-linux-android`，
    /// 既不装 APK 也不跑 Kotlin。而这一格真正会错的正是**接线**三件事：
    /// ① 服务必须在通道**启动成功之后**才起（通道没起来就挂一条"正在后台接收"的常驻通知，
    ///    等于让通知替代码说谎）；
    /// ② 停服务**不许**放进 `network::stop()`：`start()` 的第一件事就是 `stop()`
    ///    （换网卡 / 重开通道），放里面会让每次重绑都经历"销毁服务→重建"，而 Android 12+
    ///    **从后台重新拉起前台服务会被拒**（`network::start_from_prefs` 的 5s→30s 自动重试
    ///    正好可能在后台跑）⇒ 服务从此没了，而症状只是"锁屏后收不到消息"；
    /// ③ 清单那三样声明（服务 + 双类型 + 两个类型权限）缺任何一样都是**静默**失效。
    /// 每条都配反向那格：只钉"应该有"的判据，删掉一处就会红，加回错误的落点不会红。
    #[test]
    fn background_service_wiring_follows_the_lan_channel() {
        let net = include_str!("network/mod.rs");
        let cmds_network = include_str!("commands/network.rs");
        let cmds_channel = include_str!("commands/channel.rs");
        let manifest = include_str!("../gen/android/app/src/main/AndroidManifest.xml");
        let activity =
            include_str!("../gen/android/app/src/main/java/com/gosslan/app/MainActivity.kt");

        // ① 起：必须在成功路径的尾部
        let start_body = rust_fn_body(
            net,
            "pub async fn start(state: Arc<AppState>, bind_ip: String) -> Result<(), String>",
        );
        assert!(
            start_body.contains("android_background::ensure_running("),
            "network::start 里没接前台服务 ⇒ ADR-0022 的承诺没有实现支撑"
        );
        // 顺序判据：`bump_network_generation()` 只在 TCP+UDP 都起来之后执行（见那两行注释），
        // 起服务排在它后面 ⇒ 失败路径不会挂上常驻通知。挪到前面就是把通知变成谎话。
        let wired_at = start_body
            .find("android_background::ensure_running(")
            .expect("上一条已确认存在");
        let bumped_at = start_body
            .find("bump_network_generation()")
            .expect("network::start 里找不到 bump_network_generation —— 成功路径的锚点变了，本判据要跟着改");
        assert!(
            wired_at > bumped_at,
            "前台服务必须在通道**启动成功之后**才起（实测起服务的偏移 {wired_at} 早于成功锚点 {bumped_at}）"
        );

        // ② 停：两条用户出口上各一处，且 network::stop 里必须**没有**
        let stop_body = rust_fn_body(net, "pub async fn stop(state: &AppState)");
        assert!(
            !stop_body.contains("android_background::stop("),
            "停服务不许放进 network::stop()：start() 第一件事就是 stop()，\
             放这里等于每次换网卡都把服务销毁重建 —— 而 Android 12+ 从后台重拉会被拒（见 ADR-0022 §5.2）"
        );
        assert!(
            cmds_network.contains("android_background::stop("),
            "commands::stop_network（用户点「停止网络」）必须停掉前台服务"
        );
        assert!(
            cmds_channel.contains("android_background::stop("),
            "commands::set_channel_enabled(\"lan\", false) 必须停掉前台服务"
        );
        // 分母现算：全仓生产码里 `android_background::stop(` 只许有 2 处（上面那两条出口）。
        // 多出来一处 = 有人又接到一个不该停的位置；少一处 = 出口漏接，通知会常驻不退。
        // ⚠️ 先剥整行注释再数：`network/mod.rs` 里那句"这里**不调** android_background::stop()"
        // 是**说明**，不是出口 —— 带着注释一起数会把它数成第 3 处（口径同 lib_file_tests.rs 那批
        // 按形状扫的守卫：先剥注释再判形状，否则判据会咬到自己的说明文字）。
        let code_only = |src: &str| -> String {
            src.lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !(t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'))
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let stop_sites = [net, cmds_network, cmds_channel]
            .iter()
            .map(|src| code_only(src).matches("android_background::stop(").count())
            .sum::<usize>();
        assert_eq!(
            stop_sites, 2,
            "前台服务的停止出口应恰好 2 处（stop_network / set_channel_enabled），实测 {stop_sites} —— \
             改了接线就得同步这里，并回写 ADR-0022 的落点小节"
        );

        // ③ 清单三样声明 + 诊断读数接线 + Kotlin 侧的 bootstrap
        assert!(
            manifest.contains("android:name=\".BackgroundService\""),
            "清单里没有 <service> 声明 ⇒ 系统在 Android 14 上直接抛 MissingForegroundServiceTypeException"
        );
        assert!(
            manifest.contains("android:foregroundServiceType=\"remoteMessaging|connectedDevice\""),
            "清单里必须是**双类型**（remoteMessaging|connectedDevice）：只声明一个，\
             另一个在启动时按位传过去会被 IllegalArgumentException 拒掉"
        );
        for perm in [
            "android.permission.FOREGROUND_SERVICE\"",
            "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING",
            "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
        ] {
            assert!(
                manifest.contains(perm),
                "清单里缺 `{perm}` —— 缺类型权限时 startForeground 抛 SecurityException，\
                 而症状只是锁屏后收不到消息"
            );
        }
        assert!(
            activity.contains("BackgroundService.bootstrap("),
            "MainActivity 没调 BackgroundService.bootstrap ⇒ JavaVM/类引用交不过来，桥永远没就绪\
             （而界面只会显示\"桥未接上\"，用户看不出为什么）"
        );
        assert!(
            cmds_channel.contains("android_background::diag()"),
            "get_runtime_diag 没带前台服务读数 ⇒ 这一族静默失效在界面上零入口（ADR-0022 §2 最后一行）"
        );
    }

    /// 取出 `# GOSSLAN_JNI_BEGIN … # GOSSLAN_JNI_END` 之间的正文（不含两端的标记行）。
    fn proguard_jni_block(src: &str) -> Option<String> {
        const BEGIN: &str = "# GOSSLAN_JNI_BEGIN";
        const END: &str = "# GOSSLAN_JNI_END";
        let start = src.find(BEGIN)? + BEGIN.len();
        let end = src[start..].find(END)? + start;
        Some(src[start..end].trim().to_string())
    }

    /// 从 keep 块里抽出被 keep 的**方法名**（跳过 `native <methods>;` 这类通配与注释）。
    fn proguard_kept_method_names(block: &str) -> Vec<String> {
        let mut out = Vec::new();
        for line in block.lines() {
            let line = line.trim();
            if !line.ends_with(';') || line.starts_with('#') || line.starts_with("-keep") {
                continue;
            }
            let Some(open) = line.find('(') else { continue };
            let Some(name) = line[..open].split_whitespace().last() else {
                continue;
            };
            if name.starts_with('<') {
                continue; // `native <methods>;`
            }
            out.push(name.to_string());
        }
        out
    }

    /// 解析 Kotlin 里**单行**的 `[modifiers] fun name(params): Ret` → `(名字, JNI 描述符, 是否 external)`。
    fn parse_kotlin_funs(src: &str) -> Vec<(String, String, bool)> {
        let mut out = Vec::new();
        for line in src.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with('*') {
                continue;
            }
            let Some(pos) = line.find("fun ") else {
                continue;
            };
            let after = &line[pos + 4..];
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let (Some(open), Some(close)) = (after.find('('), after.find(')')) else {
                continue;
            };
            if close < open {
                continue;
            }
            let params = &after[open + 1..close];
            let ret = after[close + 1..]
                .trim_start()
                .strip_prefix(':')
                .and_then(|r| r.split_whitespace().next())
                .map(|r| r.trim_end_matches(['{', '=']))
                .filter(|r| !r.is_empty())
                .unwrap_or("Unit");
            // 只解析"Rust 可能调用"的方法：形参/返回类型里有本项目没映射过的类型
            // （例如 `bootstrap(context: Context)`）就跳过 —— 护栏只关心被登记的那几个。
            let mut desc = String::from("(");
            let mut mapped = true;
            for p in params.split(',').filter(|p| !p.trim().is_empty()) {
                let ty = p.split(':').nth(1).map(str::trim).unwrap_or("Unit");
                match jni_type(ty) {
                    Some(t) => desc.push_str(&t),
                    None => {
                        mapped = false;
                        break;
                    }
                }
            }
            if !mapped {
                continue;
            }
            desc.push(')');
            match jni_type(ret) {
                Some(t) => desc.push_str(&t),
                None => continue,
            }
            out.push((name, desc, line.contains("external")));
        }
        out
    }

    /// 解析 Rust 侧 `kotlin_method!("名字", "描述符")` 的登记。
    fn parse_kotlin_method_registrations(src: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut rest = src;
        const NEEDLE: &str = "kotlin_method!(";
        while let Some(i) = rest.find(NEEDLE) {
            let after = &rest[i + NEEDLE.len()..];
            // 结束括号要在**引号外**找：描述符形如 `"()V"`，里面也有 `)`
            let mut end = None;
            let mut in_quotes = false;
            for (idx, ch) in after.char_indices() {
                match ch {
                    '"' => in_quotes = !in_quotes,
                    ')' if !in_quotes => {
                        end = Some(idx);
                        break;
                    }
                    _ => {}
                }
            }
            let Some(end) = end else { break };
            let parts: Vec<&str> = after[..end].split(',').map(str::trim).collect();
            if parts.len() == 2 {
                out.push((
                    parts[0].trim_matches('"').to_string(),
                    parts[1].trim_matches('"').to_string(),
                ));
            }
            rest = &after[end..];
        }
        out
    }

    /// 解析 Rust 侧 `extern fn name(` 的 native 回调名。
    fn parse_extern_fn_names(src: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = src;
        const NEEDLE: &str = "extern fn ";
        while let Some(i) = rest.find(NEEDLE) {
            let after = &rest[i + NEEDLE.len()..];
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                out.push(name);
            }
            rest = after;
        }
        out
    }

    fn snake_to_lower_camel(snake: &str) -> String {
        let mut parts = snake.split('_');
        let mut out = parts.next().unwrap_or_default().to_string();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                out.push_str(&first.to_uppercase().collect::<String>());
                out.push_str(chars.as_str());
            }
        }
        out
    }

    /// Kotlin 类型名 → JNI 描述符；本项目没映射过的类型返回 `None`（调用方跳过那个方法）。
    ///
    /// `Context`/`BluetoothGattServer` 这类只出现在 Kotlin 内部方法的形参里，
    /// Rust 从不调用它们，因此不需要（也不该）在这里维护映射。
    ///
    /// 可空标记 `?` 对 JNI 描述符**没有影响**（`String?` 与 `String` 都是
    /// `Ljava/lang/String;`）—— 这里显式去掉再匹配，否则 `OpenWith.openWith` 这种
    /// "返回 String? 表示成功/失败原因" 的方法会被整条跳过，护栏就静默失效了。
    fn jni_type(kotlin: &str) -> Option<String> {
        Some(match kotlin.trim().trim_end_matches('?') {
            "String" => "Ljava/lang/String;".to_string(),
            "ByteArray" => "[B".to_string(),
            "Boolean" => "Z".to_string(),
            "Int" => "I".to_string(),
            "Long" => "J".to_string(),
            "Float" => "F".to_string(),
            "Double" => "D".to_string(),
            "Unit" | "" => "V".to_string(),
            _ => return None,
        })
    }
