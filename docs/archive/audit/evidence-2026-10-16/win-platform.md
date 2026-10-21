# Windows 平台只读审计（2026-10-16）

跑了：grep/Read/wc/diff、python3 现算计数、`scripts/verify-guards.py --list`。没跑：编译、`npm run verify`、cargo test、真机、commit。上游行号取 Cargo.lock 锁定版（tauri 2.11.5 / tao 0.35.3 / tray-icon 0.24.2 / single-instance 2.4.5）。路径相对 `src-tauri/src` 或 `src`。

## 1 平台分支面
含 windows 的 `#[cfg]` 48 处/14 文件：`target_os="windows"` 31（10 文件）、`#[cfg(windows)]` 9（3）、`cfg!(windows)` 1（network/transport/listen_tests.rs:46）。`unsafe` 37 处/4 文件全在 macOS/Android 侧 ⇒ Windows 分支产品码 unsafe/Win32/winreg 各 0 处；原生面只有 clipboard-win 5 处（commands/helpers.rs:36-70）与 windows crate（transport/bluetooth_peripheral_windows.rs，722 行）。`feature="bluetooth"` 65 处。护栏 234 条（--list 现数）；CI rust job 矩阵 [macos-latest, windows-latest]（.github/workflows/verify.yml:166）。基线 863 vs 851 行：macOS 独有 15、Windows 独有 3。**本机无判据**（macOS 整块不编译）：network/ble/peripheral.rs 10 处、network/ble.rs 6 处、ble/central.rs、ble/frame_io.rs、bluetooth_peripheral_windows.rs（只 2 条用例）；notifications.rs:200-223 无行为测试；clipboard 两命令 0 测试。

## 2 崩溃候选
放大器：Cargo.toml `[profile.release] panic="abort"` + main.rs:2 `windows_subsystem="windows"` ⇒ 任意 panic 就是进程消失且无 stderr；产品码 `catch_unwind` 0 处。非测试 unwrap/expect 仅 28 处，可达的是 relay_seal.rs:483/488/573/578、file_relay.rs:230、commands/group_file_keys.rs:68；Windows FFI 返回值上 0 处。锁纪律好：`.lock().unwrap()` 产品码 1 处 vs `into_inner` 679 处。跨线程回调 panic：notifications.rs:212 每批通知起一条线程、内部 :215 `wait_for_response`；tray.rs:264 `app.state::<…>()` 未 manage 即 panic，今天只靠 lib.rs:307 早于 :314 的顺序、无代码护栏。硬退出：tray.rs:421-425 无条件 1.5s 看门狗 `process::exit(0)`。无界线程：通知线程无上限（去抖 useChatStore.ts:214 1500ms ⇒ ≤40/分）、`spawn_blocking` 63 处、commands/network.rs:370 把托盘丢进阻塞池。递归无风险：share_walk.rs:22 深度 >8 停、cache_cleaner.rs:104 显式栈、export.rs:66 明令不递归对端可控输入。HICON：tray.rs:274-287 每次未读都重建 RGBA 再 `set_icon`，落到 tray-icon windows/mod.rs:170-194 —— `Shell_NotifyIconW` 一失败就早退，后面那次 `Box::into_raw`+`SendMessageW` 不执行 ⇒ 那枚 HICON 的 `DestroyIcon`（同库 icon.rs:150）不会调用；成对与否本机无判据。

## 3 常驻窗
6 个 label（lib.rs:72-104，link :88 刻意不进 capability）、5 个 HTML 入口（vite.config.ts:88-92）。常驻=main/tasks/preview/link（commands/logs.rs:41/60/71），销毁=settings/logs（logs.rs:36）。**"每群一扇任务窗"已是旧设计**：lib.rs:79-84 明写 label 固定、全局一扇。预热只备 preview（logs.rs:1061-1067）。preventDefault 三处：tray.rs:468、logs.rs:127、PreviewWindow.vue:79；判据 src/utils/previewHosting.test.ts:93。`on_window_event` 只在 created 时注册一次（logs.rs:121-131）；前端 27 条监听（api/index.ts:614-651）由 initScope.ts:31-42 逆序拆。**可能不回收（只给证据）**：常驻窗文档/JS 堆不释放，blob LRU 每窗各一份 60+8+60 MiB（filePreview.ts:37/97、favoritePreview.ts:27），6 扇上界≈408 MiB；state.rs:1037 `preview_gallery`、:1044 `task_window_group` 是进程级、不随窗销毁。

## 4 Windows 特有链
单实例 lib.rs:236-243：第二进程在 initialize_plugins（tauri app.rs:2440）里 `process::exit(0)`（插件 windows.rs:105），**早于建窗与开库**；边界 lib.rs:189-194 —— `GOSSLAN_INSTANCE` 或 `GOSSLAN_AUTOSTART=1` 时守卫整块不注册；互斥名只按 identifier（windows.rs:59-68，semver 未开）。托盘 tray.rs:324-460，勿扰 CheckMenuItem :349 靠控件自翻转 + :370-374 读库取反（点击与落库之间失败即不一致、无回滚）；托盘建失败则不拦关闭（:330-332）。**开机自启不存在**：Cargo.toml 无 autostart 插件、src 内注册表 0 处，`GOSSLAN_AUTOSTART` 只局域网自起（lib.rs:390）。通知点击 notifications.rs:200-223：AUMID 仅在非 target/debug|release 时设（:105-117）⇒ 便携版的通知与点击通道整条不存在。

## 5 可能殃及别的应用（只列结构候选，不下结论）
(a) 共享桌面堆 / USER+GDI 配额：tray.rs:274-287 反复重建图标 + 插件的隐藏消息窗与类注册（windows.rs:66-68）+ 最多 6 扇窗 + `FLASHW_TIMERNOFG/uCount=u32::MAX` 在主窗藏进托盘时永不自停（commands/network.rs:294-303，注释 :227-229）。要 Process Explorer 的 GDI Objects / USER Objects / Handles 三列（是否顶到 10k）。
(b) 提交电荷：无上限通知线程 × 每线程栈保留 + 63 处阻塞池。要 Task Manager「提交大小」列 + 性能页提交限制、Process Explorer 的 Threads 与 Private Bytes。
(c) 同一 WebView2 user data folder ⇒ 同一 msedgewebview2 进程组：全仓 0 处 `WEBVIEW2_*`/UDF/浏览器参数配置（走按 exe 名的默认目录），而便携版 `gosslan.exe`（scripts/build-windows-portable.ps1:14）与安装版 `Gosslan.exe` 在大小写不敏感的 NTFS 上同名。要各 `msedgewebview2.exe` 命令行里的 `--user-data-dir=` 是否同路径。
(d) 显卡 TDR：硬件加速从未关（同 (c) 的 0 处）+ 最多 6 个 controller。要事件查看器 System、来源 `nvlddmkm`/`amdkmdag`、事件 ID 4101；再用 Application Error 1000 / WER 1001 的故障模块名区分"我们崩"还是"runtime 崩"。
(e) `tray.rs:424` 的 `exit(0)` 跳过析构 ⇒ 半写状态只在盘上留痕。**最省事的一格**：给崩溃机配 WER `LocalDumps` 取 minidump，并把应用内 `channel="panic"` 那条运行日志（lib.rs:166-173）发回 —— 它能直接证/伪第 2 节全部候选。
