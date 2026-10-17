//! Gosslan 应用入口（库目标，供 Tauri 加载）。

// ⚠️ 注意：不要在这里加 crate-level 的 clippy lint（`#![warn(...)]`）。
// CI 的 clippy 用 `-D warnings`，会把所有 warn 升级成 error，
// 而 transport.rs / state.rs / lib.rs::run() 等**未重构的旧代码**里
// 已经存在 25+ 个 `too_many_lines` / `cognitive_complexity` 命中，
// 一启用就秒挂。
//
// 膨胀守卫放在**已经物理拆分的模块**里（commands.rs / db.rs / 子模块），
// 那些文件已控制在 700 行以内，不会误伤。

/// Android 的「打开文件」JNI 桥（FileProvider：私有目录文件必须以 content:// 交出去）。
#[cfg(target_os = "android")]
mod android_open;
mod commands;
/// 内容传输**逻辑层**（统一生命周期 + 状态机 + 重试策略）；见 content/mod.rs 的分层说明。
pub mod content;
/// 公开给 `examples/e2e_peer.rs` 协议级 E2E 测试对端复用（线格式与密码学原语）。
pub mod crypto;
mod db;
mod db_hold;
mod device;
pub mod discovery;
/// 聊天记录导出（纯文字单文件）：磁盘满 / 换机时的自救手段。
pub mod export;
mod file_relay;
mod gossip_engine;
/// JNI 方法登记宏（Android 的两条桥共用，见该文件注释）。
#[cfg(target_os = "android")]
mod jni_method;
mod logging;
/// macOS App Sandbox 的安全作用域书签（共享目录重启后不失访，见该文件注释）。
#[cfg(target_os = "macos")]
mod macos_bookmark;
/// macOS 窗口外观：运行时加 squircle 圆角 + 关掉与圆角不兼容的系统阴影。
/// 见 macos_window.rs 注释（与自绘标题栏的取舍）。
#[cfg(target_os = "macos")]
mod macos_window;
/// macOS 原生菜单栏（自绘标题栏 + `decorations: false` 导致系统菜单栏缺失，需补回）。
/// 只在 macOS 建：Windows / Linux 用自绘标题栏，加系统菜单条会顶在标题栏之上破坏布局。
#[cfg(target_os = "macos")]
mod menu;
pub mod mesh;
mod network;
mod nickname;
mod notifications;
/// 打开本地文件的平台实现：macOS 用 NSWorkspace（沙盒下 /usr/bin/open 被拦）、
/// Android 用 FileProvider + ACTION_VIEW（opener 只发 file:// 会被系统拒绝）、
/// Windows/Linux 走 opener。
mod open_path;
pub mod protocol;
mod state;
mod storage;
mod transport;
#[cfg(desktop)]
mod tray;
mod user_dirs;

use tauri::Manager;

/// 运行时会创建的全部窗口标签。
///
/// **为什么要有这份清单**：Tauri 的 capability 是按**窗口标签**匹配的（见 tauri 源码
/// `webview::mod.rs` 里 `resolve_access(cmd, window.label(), webview.label(), origin)`）。
/// 运行期新建的窗口如果没有被任何 capability 覆盖，它的 `plugin:*` 与 `core:*` 调用会被
/// ACL 直接拒绝 —— 而本项目没有 app ACL manifest（`src-tauri/permissions/` 不存在），
/// 本地来源的**自定义命令不受 ACL 校验**，所以窗口看起来"基本能用"，
/// 只有选目录（dialog）、开链接（opener）、订阅事件（core:event）这些静默失败，很难发现。
/// 曾经的真实缺陷：capability 只写了 `["main"]`，于是设置窗口里"选择共享目录"必然失败。
///
/// 因此：**新建窗口时必须把标签加进这里**，`capability_covers_every_window_label` 测试
/// 会拿它去核对 `capabilities/default.json`（改错就红）。
pub const WINDOW_MAIN: &str = "main";
/// 独立的「设置」窗口（`open_settings_window`）。
pub const WINDOW_SETTINGS: &str = "settings";
/// 独立的「运行日志」窗口（`open_log_window`）。
pub const WINDOW_LOGS: &str = "logs";
/// 独立的「群任务」窗口（`open_group_todos_window`）。
///
/// label **固定** ⇒ 全局只有一扇，看的是哪个群由后端那份"当前上下文"决定
/// （[`crate::state::AppState::task_window_group`]），切换群就是换内容 ——
/// 与图片预览窗口同一套做法。这样做唯一的动机是：固定 label 才能**不传参数预热**
/// （用户 2026-09-24："创建完先放着，用的时候瞬间激活"）；每群一扇的动态 label
/// 在启动时根本不知道该建哪一扇。代价是任务栏里不再能分清"这是哪个群的窗口"。
pub const WINDOW_TASKS: &str = "tasks";
/// 独立的「外部链接」窗口（`open_link_window`）。**刻意不进 [`WINDOW_LABELS`]、也不进
/// capabilities**：它加载的是**远端页面**，不给它任何 capability 才能保证远端内容
/// 调不动本应用的任何命令（`link_window_is_not_capability_covered` 测试锁死这一点）。
pub const WINDOW_LINK: &str = "link";
/// 主窗口在 `tray::MAIN_WINDOW_LABEL` 也有一份（那里是 `#[cfg(desktop)]`），
/// 测试里断言两者一致，避免漂移。
/// 独立的「图片预览」窗口（`open_image_preview`，用户 2026-09-24 #40）。
///
/// label 固定 ⇒ **全局只有一个**：从会话 / 任务 / 收藏点开的图都替换这一个窗口的内容，
/// 而不是叠出第二、第三扇看图窗。
pub const WINDOW_PREVIEW: &str = "preview";
/// 主窗口在 `tray::MAIN_WINDOW_LABEL` 也有一份（那里是 `#[cfg(desktop)]`），
/// 测试里断言两者一致，避免漂移。
pub const WINDOW_LABELS: &[&str] = &[
    WINDOW_MAIN,
    WINDOW_SETTINGS,
    WINDOW_LOGS,
    WINDOW_PREVIEW,
    WINDOW_TASKS,
];

/// **允许被最大化**的窗口标签白名单。
///
/// ## 为什么需要它（用户 2026-10-12 实测：macOS 绿灯与标题栏双击"点了没反应"）
///
/// 曾用 `WebviewWindow::is_maximizable()` 作判据，看着正是标准 API，实则**在 macOS 上恒 false**：
/// 我们的窗口全是 `decorations:false`，tao 建出的 styleMask 里**没有 `Titled` 位**
/// （`tao-0.35.3/platform_impl/macos/window.rs:216-222`），而 AppKit 的 zoom button
/// 只在 Titled 窗上存在 ⇒ `is_maximizable()` 读不到 button 就返回 false
/// （同文件 L1105-1115，`set_maximizable` 也因此静默失效，见 L826-834）。
/// 独立探针实测：borderless 窗 `is_maximizable()`=false，但直接 `set_maximized(true)`
/// 照样铺满可见区、`set_maximized(false)` 照样还原 —— **能力一直在，只是判据说谎**。
/// 完整推导见 `commands/window.rs::window_toggle_maximize` 的注释。
///
/// 受影响的只有 `WINDOW_MAIN`：`logs.rs` 里设置/日志/群任务/预览四扇辅助窗都在 builder 上
/// 显式写了 `.maximizable(false)`（小窗口不给放大），那才是"不能最大化"的可信来源。
/// 本清单与那四处 builder 由 `window_maximizable_matches_builder` 测试交叉核对
/// （改一边忘另一边会红）。
///
/// ⚠️ 只在桌面有意义；移动端没有窗口概念，`window_toggle_maximize` 走另一个桩。
#[cfg(desktop)]
pub const MAXIMIZABLE_WINDOWS: &[&str] = &[WINDOW_MAIN];

/// 安装 panic hook：把 panic（位置 + 消息）写进应用日志文件，并打到 stderr。
///
/// 为什么必须装（用户 2026-09-12 安卓实测「点进去 3 秒闪退，拿不到任何日志」）：
/// 默认的 panic 输出在安卓上**看不到**（stdout/stderr 不进文件、Release 也没人读），
/// 而 `[profile.release] panic = "abort"` 时进程直接消失 ⇒ 用户和我都无从下手。
/// 现在 panic 会以 `channel="panic"` 落进「运行日志」页，adbd 下也能从 logcat 捞到。
/// ⚠️ 这个 hook 必须在**任何可能 panic 的代码之前**装好（`run()` 的第一行）。
/// 启动路标：此刻 logger 可能还没就绪，所以只打 logcat（`log -t gosslan`）——
/// 用户「打开就闪退」时，这一步能告诉我们崩在 init 之前还是之后。
fn state_mark(target: &str, message: &str) {
    #[cfg(target_os = "android")]
    {
        use std::process::{Command, Stdio};
        let line = format!("[info] [{target}] {message}");
        let _ = Command::new("log")
            .args(["-t", "gosslan", &line])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (target, message);
    }
}

/// 分配失败也要在进程消失前留一行。
///
/// 为什么这条不是"顺手加的保险"：`[profile.release] panic = "abort"` 下，分配失败走的是
/// `handle_alloc_error` → abort，**根本不经过 panic 钩子**，而它产生的 Windows 异常码
/// 与 panic 完全一样（`0xc0000409`，都是 `__fastfail`）⇒ 不留痕就永远分不开这两种死法。
/// 2026-10-16 那台机器上恰好两种都有登记，所以这一格不是假想需求。
///
/// 只做"记一笔再把 null 原样交回去"，**不改任何分配行为**：调用方照旧走它自己的
/// `handle_alloc_error`。写入本身要申请内存 ⇒ [`logging::crash_note`] 里带再入闸。
struct NotingAlloc;

unsafe impl std::alloc::GlobalAlloc for NotingAlloc {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        let p = std::alloc::System.alloc(layout);
        if p.is_null() {
            note_alloc_failure("分配", layout.size(), layout.align());
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        std::alloc::System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        let p = std::alloc::System.realloc(ptr, layout, new_size);
        if p.is_null() {
            note_alloc_failure("重分配", new_size, layout.align());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        let p = std::alloc::System.alloc_zeroed(layout);
        if p.is_null() {
            note_alloc_failure("分配(清零)", layout.size(), layout.align());
        }
        p
    }
}

#[global_allocator]
static GLOBAL_ALLOC: NotingAlloc = NotingAlloc;

#[inline]
fn note_alloc_failure(what: &str, size: usize, align: usize) {
    crate::logging::crash_note(&format!(
        "{what}失败：请求 {size} 字节（对齐 {align}）⇒ 分配器即将 abort（不是 panic，钩子不会跑）"
    ));
}

/// 最早把崩溃现场路径绑好的插件。
///
/// ⚠️ **注册顺序就是它的功能**：必须排在所有插件最前面，尤其是单实例守卫之前 ——
/// 插件 setup 按注册顺序跑（锁定版 tauri 2.11.5 `app.rs:2440` 的 `initialize_plugins`），
/// 而守卫一旦判定"已有另一份在跑"就直接 `std::process::exit(0)`，那时我们的 logger 还不存在。
/// 绑好之后立刻写一条"启动尝试"：**文件里只有启动尝试、没有后面的路标** ⇒ 进程在极早期就消失了
/// （被守卫顶掉 / 崩在初始化之前），这本身就是需要的读数，而不是"机制没生效"。
fn crash_bootstrap_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("crash-bootstrap")
        .setup(|app, _api| {
            use tauri::Manager as _;
            match app.path().app_data_dir() {
                Ok(dir) => {
                    let instance = crate::state::instance_id();
                    let stem = if instance > 0 {
                        format!("gosslan-{instance}")
                    } else {
                        "gosslan".to_string()
                    };
                    crate::logging::bind_crash_file(&crate::logging::crash_file_for(&dir, &stem));
                    crate::logging::crash_note(
                        "启动尝试：进程已起，logger 尚未建立（bootstrap 已绑定现场路径）",
                    );
                }
                Err(e) => {
                    eprintln!("[gosslan] bootstrap 拿不到 app_data_dir，崩溃现场无法落盘：{e}")
                }
            }
            Ok(())
        })
        .build()
}

fn install_panic_hook(app: Option<tauri::AppHandle>) {
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "(未知位置)".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(无消息)".to_string());
        let text = format!("panic @ {location}：{payload}");
        // ① 文件日志（应用内「运行日志」页能看到）——
        //    通过 AppHandle 取 `Arc<AppState>` 的 logger，避免给 Logger 加 Clone
        let mut recorded = false;
        if let Some(handle) = &app {
            use tauri::Manager as _;
            if let Some(st) = handle.try_state::<std::sync::Arc<crate::state::AppState>>() {
                st.logger.error("panic", text.clone());
                recorded = true;
            }
        }
        // ② **还没有 logger 也必须留痕**（启动早期、数据库迁移中途 panic —— 就是"打开就闪退、
        //    盘上一个字没有"那种）。走不依赖 state 的独立通道；这条臂就是那三个丢掉的现场。
        if !recorded {
            crate::logging::crash_note(&text);
        }
        // ② stderr：android logcat / 终端都能捞到（`adb logcat | grep -i panic`）
        eprintln!("[gosslan]{text}");
    }));
}

/// 「这第二次启动该不该真的起一个新进程」的判定（纯函数、可单测）。
///
/// 只有**开发与测试的多开出口**算该：双实例 E2E harness 起实例时带
/// `GOSSLAN_INSTANCE=<n>`（见 `scripts/e2e/core.mjs`），并常配 `GOSSLAN_AUTOSTART=1` 选绑定地址。
/// 那一层是本仓唯一能证跨进程行为的路线，守卫不许把它一起关掉。
///
/// 真用户环境里第二个进程 = 第二扇主窗 + 第二个托盘图标 + 第二份 mesh 身份，
/// 同一条好友申请会被两个进程各弹一次通知（用户 2026-10-14：「同时启动了两个程序，这有问题」）。
#[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn allow_second_instance_launch(
    instance_env: Option<&str>,
    autostart_env: Option<&str>,
) -> bool {
    instance_env.is_some() || autostart_env == Some("1")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先装 hook（此刻还没有 state，先只打 stderr；setup 里拿到 logger 后再装一次带上文件日志）
    install_panic_hook(None);
    // 移动端没有那段"桌面才加插件"的 `builder = builder.plugin(...)`（见下面的 #[cfg(desktop)]），
    // 于是 `mut` 在移动端是多余的 —— 显式标注而不是去掉 `mut`（桌面端确实要改）。
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        // ⚠️ 必须排第一：插件 setup 按注册顺序跑，而单实例守卫会在 logger 建立之前就 `exit(0)`
        .plugin(crash_bootstrap_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // 桌面端记住窗口尺寸/位置（HIG：重开应用恢复窗口状态，macOS/Windows 一致）。
    // 只保存 SIZE/POSITION/MAXIMIZED/FULLSCREEN，**刻意排除 VISIBLE**：
    // 本应用「关闭=隐藏到托盘」，若把 visible 也持久化，会记成"关闭后是隐藏态"，
    // 重启就可能不再显示窗口。DECORATIONS 也排除——自绘标题栏由本项目自己管理。
    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                // 设置/日志窗口是**关闭即销毁**（每次开窗由 `aux_window_geometry` 重新摆位），
                // 不让插件按 label 恢复旧几何/最大化 —— 否则会与重新居中打架
                // （用户 2026-09-17：这两个窗口改为"关闭即销毁"，见 commands.rs 的
                // `AUX_WINDOWS_RESIDENT`）。其余窗口（群任务 / 预览 / 外链）都是**固定 label 的常驻窗**，
                // 几何由 `apply_aux_geometry` + `restore_aux_window_size` 自己管，插件不参与按 label 恢复。
                .with_denylist(&[WINDOW_SETTINGS, WINDOW_LOGS])
                .build(),
        );
    }

    // 单实例守卫：第二个进程不再建窗，而是把**已有那份**主窗叫到前台。
    // 平台清单必须与 Cargo.toml 里那条依赖的 `cfg` 同一组（判据在 lib_startup_config_tests）。
    #[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]
    if !allow_second_instance_launch(
        std::env::var("GOSSLAN_INSTANCE").ok().as_deref(),
        std::env::var("GOSSLAN_AUTOSTART").ok().as_deref(),
    ) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            crate::tray::show_main_window(app);
        }));
    }

    let app = builder
        .setup(|app| {
            state_mark("boot", "AppState::init 之前");
            let state = match state::AppState::init(app.handle().clone()) {
                Ok(state) => state,
                Err(e) => {
                    // 数据来自**更新**的版本 ⇒ 拒绝打开（"能升不能毁"红线），但"拒绝"
                    // 必须是用户看得懂、知道该干什么的一句话，而不是一个悄悄消失的窗口：
                    // setup 返回 Err 会被 Tauri 变成 panic，而 Windows 发布版是
                    // `windows_subsystem = "windows"`（无控制台）⇒ stderr 无处可去 = 用户
                    // 看到窗口闪一下就没了，什么提示都没有。
                    //
                    // 按**类型**分支而不是错误字符串：协议层已经因为"按前缀分类"吞过一整条
                    // 消息（INV-P24 第 2 条，v4.22.34 才修掉）。
                    if let Some(db::InitError::Downgrade { current }) =
                        e.downcast_ref::<db::InitError>()
                    {
                        let msg = db::InitError::downgrade_message(*current);
                        state_mark("boot", "数据库版本比本机程序新，拒绝启动");
                        eprintln!("[gosslan]{msg}");
                        // 弹窗**只在桌面端**做。移动端不是"顺手也弹一下"：那个时点原生对话框
                        // 到底能不能显示，我在这里没有任何实测手段，而"弹出来了但没有 state"
                        // 与"压根没弹"在 Android 上的分别是**崩溃 vs 永久白屏** —— 后者更糟。
                        // 宁可让移动端保持现状（panic + logcat 一行），也不把未验证的行为写进
                        // 移动端启动路径。
                        #[cfg(desktop)]
                        {
                            use tauri_plugin_dialog::DialogExt as _;
                            let handle = app.handle().clone();
                            // ⚠️ **只能非阻塞 `show` + 提前 `return Ok(())`**。
                            // 插件的桌面实现是 `run_on_main_thread(...)`
                            // （tauri-plugin-dialog-2.7.3/src/desktop.rs:222），而 setup 正跑在
                            // 主线程上 ⇒ 阻塞版 API 的 `rx.recv()` 会钉住主线程，排在队列
                            // 里的弹窗任务永远执行不到 = 开机自锁（与 v4.22.30 修掉的 Windows
                            // 开窗卡死同一个形状）。让主线程回到事件循环，弹窗才会出现。
                            handle
                                .dialog()
                                .message(msg)
                                .title("Gosslan")
                                .show(move |_| {
                                    // 用户点掉提示之后才退出（exit 走事件循环代理，跨线程安全）
                                    handle.exit(1);
                                });
                            // 提前返回 ⇒ 不 `manage(state)`、不建托盘：前端所有命令都会拿到
                            // "state not found" 的 IPC 错误（不 panic），界面停在空白 ——
                            // 这比"半死的界面"诚实，而且原生弹窗盖在上面。
                            return Ok(());
                        }
                    }
                    // 非降级的启动错误、以及移动端（上面那段 cfg(desktop) 不参与编译）
                    // 都走原路：Err → 框架 panic → 退出。文案已经进 stderr，
                    // 安卓上 `state_mark` 还会把它送进 logcat。
                    return Err(e);
                }
            };
            state
                .logger
                .info("boot", "AppState::init 完成（设置/目录/局域网就绪）");
            // 拿到 AppHandle 之后**重装** panic hook：这次的 hook 会把 panic 同时写进
            // 「运行日志」页（安卓上这是唯一能拿到的诊断路径，见 `install_panic_hook`）。
            install_panic_hook(Some(app.handle().clone()));
            state::AppState::spawn_peer_emitter(&state);
            app.manage(state.clone());
            // 系统托盘：关闭主窗口仅隐藏到托盘，退出需走托盘菜单
            // ⚠️ 三条语句必须一起包进 `#[cfg(desktop)]` 块：属性只作用于**紧跟其后的那一条**，
            //    拆开写会让 `tray::setup(...)` 掉出 cfg ⇒ 移动端编不过（E0433，真踩过）。
            #[cfg(desktop)]
            {
                state.logger.info("boot", "开始 tray::setup");
                tray::setup(app.handle())?;
                state.logger.info("boot", "tray::setup 完成");
            }
            // macOS 菜单栏：⌘Q / ⌘, / ⌘W / ⌘M 与标准「编辑」项。
            // 属"锦上添花"——初始化失败**不阻断启动**（与托盘不同：托盘失败会改行为，
            // 菜单失败只是没有菜单，快捷键还有前端兜底）。
            #[cfg(target_os = "macos")]
            {
                // 初始语言取持久化的**显式**偏好（"跟随系统"交给前端推到 `set_ui_language`，
                // 避免后端再实现一份系统语言检测 —— 见 menu.rs 顶部注释）。
                let persisted = {
                    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::get_setting(&conn, "language")
                };
                let lang = menu::initial_lang(persisted.as_deref());
                if let Err(e) = menu::setup(app.handle(), lang) {
                    state
                        .logger
                        .warn("menu", format!("菜单栏初始化失败（不影响启动）：{e}"));
                }
            }
            // macOS：`decorations: false` 使 tao 以 `Borderless`（不含 `Closable` 位）样式
            // 掩码创建 NSWindow，AppKit 据此把「关闭窗口」菜单项（Cmd+W / performClose:）
            // 判为不可用，导致 Cmd+W 无效。窗口创建后补回 `Closable` 位，恢复系统原生
            // Cmd+W（仍无标题栏/关闭按钮，因未加 `Titled` 位）；关闭动作照旧走
            // CloseRequested → 托盘隐藏路径，与点击自定义标题栏「×」行为一致。
            #[cfg(all(desktop, target_os = "macos"))]
            if let Some(win) = app.handle().get_webview_window(tray::MAIN_WINDOW_LABEL) {
                if let Err(e) = win.set_closable(true) {
                    state
                        .logger
                        .warn("window", format!("恢复 macOS Cmd+W 关闭能力失败: {e}"));
                }
                // 关系统阴影（与圆角冲突；NSWindow 级、不被 wry 替换 contentView 影响）。
                // 圆角本身在 WebView 加载完成后由前端调 `apply_macos_window_shape` 命令设置
                // （wry 在窗口显示时才用 parent_view 替换 contentView，setup 阶段设圆角会丢）。
                macos_window::disable_shadow(&win);
            }
            // 窗口以 `visible: false` 创建（见 tauri.conf.json），由前端在挂载完成后调用
            // `focus_window` 显示——目的是让窗口露出来的第一帧就是 index.html 的内联骨架，
            // 消除暗色主题下"整屏浅色一闪"（窗口静态 backgroundColor 只能是浅色或深色之一）。
            //
            // 兜底：前端若因初始化异常没能调用，必须仍然把窗口显示出来。否则用户面对的是
            // 「应用启动了、却没有窗口」——比闪一下白严重得多，且无法自行恢复。
            // 只在"确定处于隐藏态"时才强制显示，避免 4 秒后抢走用户当前焦点。
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                let st_timeout = state.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    if let Some(win) = handle.get_webview_window(tray::MAIN_WINDOW_LABEL) {
                        if matches!(win.is_visible(), Ok(false)) {
                            st_timeout
                                .logger
                                .warn("window", "前端未在超时内显示窗口，兜底显示");
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                });
            }
            // 局域网默认开启：首次安装（以及尚未写入该键的旧版本升级）启动即自动联网；
            // 用户在设置页关闭后持久化为关闭，重启不再联网。「恢复默认」清除该键 ⇒ 回到默认开启。
            // GOSSLAN_AUTOSTART=1 的职责**只剩绑定地址**（以 0.0.0.0 起，headless 多实例互测用，
            // examples/e2e_peer.rs 依赖此行为），它**不再**决定"开不开"（2026-09-27 改掉，见下）。
            // ⚠️ 旧写法是 `if forced || enabled` ⇒ 库里显式写着"关"也会被这个 env 覆盖成"开"。
            //    2026-09-26 那条"关掉局域网发现还能被别人学到"的产品结论就是这么来的——
            //    预置明明写的是关，跑起来的却是开（复跑与改口见 roadmap §12.7「#76 的实测证据是脚手架造的」）。
            //    现在"关"就是关：要联网的轮次由 harness **显式预置 lan_enabled**（e2e-multi-instance.mjs 的
            //    L-A 预置里那条 `lan_enabled='true'`），而不是由环境变量替用户表态。
            // ⚠️ 不在 cfg(desktop) 里：移动端同样需要读 lan_enabled 设置并自动启动 ——
            // 用户在设置里打开后、杀掉 App 再进来，LAN 应该恢复上次的状态。
            {
                let st = state.clone();
                tauri::async_runtime::spawn(async move {
                    let forced = std::env::var("GOSSLAN_AUTOSTART").ok().as_deref() == Some("1");
                    // 键缺失（首次安装 / 旧版本升级）→ 持久化为 true，之后每次启动
                    // 读到明确的 "1" 而非依赖 unwrap_or(true) 的隐式默认。
                    //
                    // ⚠️ 失败后要**继续试**（2026-10-15 全链路审计：旧写法试一次就放弃，
                    // 而"auto 模式这一刻找不到可用网卡"与"发现套接字 bind/组播失败"都会在
                    // 几十秒内自己变好 —— 开机自启跑在 DHCP 之前正是这个形状）。旧形状下
                    // 本进程此后既没监听也没 announce，唯一出路是重启应用。
                    // 间隔与停止条件都是 `network` 里的纯函数（有单测）。
                    let mut attempt = 0u32;
                    loop {
                        // 每一轮都重读这个键：用户在设置里关掉 ⇒ 立刻收手，不得替他联网
                        // （上面 2026-09-27 那段历史讲的是同一条规矩）。
                        let enabled = {
                            let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                            crate::db::get_lan_enabled(&dbc)
                        };
                        // 已经起来就不再插手（也包括用户或 harness 在重试窗口里自己打开的那次）。
                        let running = st
                            .network
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .is_some();
                        if !network::should_keep_retrying_lan_autostart(running, enabled) {
                            break;
                        }
                        let started = if forced {
                            network::start(st.clone(), "0.0.0.0".to_string()).await
                        } else {
                            network::start_from_prefs(st.clone()).await
                        };
                        match started {
                            Ok(()) => {
                                if attempt > 0 {
                                    // 恢复要留痕：没有这一行，"重试链后来自己通了"在日志里是看不见的
                                    st.logger.info(
                                        "lan",
                                        format!("局域网通道在第 {} 次重试后开启成功", attempt),
                                    );
                                }
                                break;
                            }
                            Err(e) => {
                                attempt += 1;
                                let delay = network::lan_autostart_delay(attempt);
                                // 前 3 次与此后每 10 次各记一条：永久没有局域网的机器不该
                                // 被这条重试链刷成每 30 秒一条 error。
                                if attempt <= 3 || attempt % 10 == 0 {
                                    st.logger.error(
                                        "lan",
                                        format!(
                                            "自动开启局域网通道失败（第 {attempt} 次）: {e} —— {} 秒后自行重试，无需重启应用",
                                            delay.as_secs()
                                        ),
                                    );
                                }
                                tokio::time::sleep(delay).await;
                            }
                        }
                    }
                });
            }
            // db 持锁观测：每分钟读走一次计数，只有真出现慢持锁才产一行。
            // 读者必须只有这一处（take_summary 会清零，两个读者会互相吞计数）。
            {
                let st = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        let summary = st.db.take_summary();
                        if let Some(line) =
                            db_hold::summary_line(&summary, st.db.slow_threshold_ms())
                        {
                            st.logger.info("db", line);
                        }
                    }
                });
            }
            // 定期清扫过期的 .part 断点前缀（审计 §7 风险 2）：启动后立即一次，之后每小时一次。
            {
                let st = state.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        // spawn_blocking（对照缓存自动清理的用法，审计 2.3o）：sweep_stale_parts
                        // 是同步 read_dir/删除 + 抢 3 把锁，直接在 async 任务里跑会占住一个
                        // tokio worker（慢盘上整套消息收发一起挨饿），且启动时立刻跑一轮。
                        let removed = match tauri::async_runtime::spawn_blocking({
                            let st = st.clone();
                            move || crate::network::file::sweep_stale_parts(&st)
                        })
                        .await
                        {
                            Ok(n) => n,
                            Err(e) => {
                                st.logger.error("file", format!(".part 清扫任务失败: {e}"));
                                0
                            }
                        };
                        if removed > 0 {
                            st.logger
                                .info("file", format!("清理过期 .part：{removed} 个"));
                        }
                        // 同一趟里清扫内存态的中继表（见 sweep_stale_relay 的说明）。
                        let swept = crate::network::transport::sweep_stale_relay(&st);
                        if swept > 0 {
                            st.logger
                                .info("relay", format!("清理过期中继态：{swept} 项"));
                        }
                        // 同一趟里回收"再也没被喂片"的接收器（第 1 步 · 故障隔离 P1）。
                        // 存在的理由：断链清理现在只在 peer 真的没链路时才动手，而协议里没有
                        // cancel 帧 ⇒ 发送侧放弃的那一单在接收端没人管（表项 + 文件句柄 +
                        // `.part` 一起永久留着，且 `sweep_stale_parts` 会因为"还在表里"而跳过它）。
                        // 延迟 ≤ 本趟的节奏是有意的：它治的是**永久**泄漏，不是界面 spinner。
                        let stalled = crate::network::transport::sweep_stalled_receives(&st);
                        if stalled > 0 {
                            st.logger
                                .info("file", format!("回收静默接收器：{stalled} 个"));
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    }
                });
            }
            // 群文件台账一次性补账（2026-10-16 方案 A，见
            // `docs/notes/group-file-ledger-backfill-2026-10-16.md`）：治的是"文件在盘上、消息行也写着
            // 路径，但收尾那三张台账一张都没落库"的那一格 —— 那一格让这台**不算种子**，别人再也拉不到
            // 这份内容，而对账扫描器的谓词捞不到"行根本没写成"，所以它没有兜底。
            //
            // ⚠️ 刻意**不是** DB 迁移：补账唯一的判据是整文件 SHA-256，而群文件能到 GB 级；迁移跑在
            // 启动路径上，等于把 INV-P34 那一族已经修过十一家的根因（打开应用就卡）亲手装回起点。
            // 形态因此是"启动后一次性的后台作业 + settings 一个开关"，整趟跑完才写开关 ⇒ 中途崩下次重启重来，
            // 而每一条写都幂等。
            {
                let st = state.clone();
                tauri::async_runtime::spawn(async move {
                    // 晚一点再动：首屏、局域网自启、`.part` 清扫都排在同一段，
                    // 一次后台补账不该跟它们抢盘（这条链上没有用户在等的东西）。
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    let already = {
                        let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                        crate::db::get_config_bool(
                            &dbc,
                            crate::network::file::GFILE_LEDGER_BACKFILL_DONE_KEY,
                            false,
                        )
                    };
                    if already {
                        return;
                    }
                    let stats = crate::network::file::run_group_ledger_backfill(&st).await;
                    st.logger.info(
                        "file",
                        format!(
                            "群文件台账补账跑完：候选 {}、补上 {}、跳过 {}、对不回身份的卡片 {}、收口 {}",
                            stats.gaps,
                            stats.repaired,
                            stats.skipped,
                            stats.orphan,
                            if stats.incomplete { "否" } else { "是" }
                        ),
                    );
                    if stats.incomplete {
                        // **没收口就不写标记**（2026-10-16 评审抓出来的 P1）：作业里两条提前返回
                        // （扫描失败 / 任务被中断）与任一条事务写失败都算没收口。旧形状下标记照写 ⇒
                        // 一次 SQLITE_BUSY 就把这台**永久**钉成"不再补账"，而那本来只是一次临时故障；
                        // 比"不补"更糟的是"把不补变成不可恢复的决定"。
                        st.logger.error(
                            "file",
                            "群文件台账补账：这一趟没收口 ⇒ 完成标记**不写**，下次启动会再来一遍（每一条写都是幂等的）",
                        );
                        return;
                    }
                    let marked = {
                        let dbc = st.db.lock().unwrap_or_else(|e| e.into_inner());
                        crate::db::set_setting(
                            &dbc,
                            crate::network::file::GFILE_LEDGER_BACKFILL_DONE_KEY,
                            "1",
                        )
                    };
                    if let Err(e) = marked {
                        // 开关写不上 ⇒ 下次启动会再跑一遍（写本身幂等）。这不算故障，但必须看得见。
                        st.logger.error(
                            "file",
                            format!("群文件台账补账：完成标记写失败，下次启动会重跑一遍 —— {e}"),
                        );
                    }
                });
            }
            // 群历史同步的清扫任务（负责人 2026-10-16 需求）：入群那一刻常常没有人在线，
            // 只靠那一次喊话，"自动同步"就变成看运气。这一格每 60 秒看一次还挂着
            // "待同步"标记的群，有人在线就补上。形态与上面那条补账作业同一条纪律：
            // **没跑完不写完成标记**，所以这一轮没跑成不会被钉成永久不做。
            crate::network::group_history::spawn_group_history_sweeper(&state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_device_info,
            commands::update_profile,
            commands::list_interfaces,
            commands::get_runtime_snapshot,
            commands::start_network,
            commands::stop_network,
            commands::get_peers,
            commands::search_nearby_peers,
            commands::focus_window,
            commands::shake_window,
            commands::request_attention,
            commands::set_unread_badge,
            commands::list_favorites,
            commands::add_favorite,
            commands::remove_favorite,
            commands::read_favorite_preview,
            commands::delete_messages,
            commands::notify_desktop,
            commands::send_test_notification,
            commands::get_topology,
            commands::set_channel_enabled,
            commands::get_cache_info,
            commands::set_cache_policy,
            commands::clean_cache_now,
            commands::get_settings,
            commands::log_frontend_error,
            commands::import_picked_file,
            commands::default_nickname,
            commands::request_ble_permissions,
            commands::set_ui_language,
            commands::search_chat_history,
            commands::save_settings,
            commands::reset_settings,
            commands::broadcast_chat_style,
            commands::get_friends,
            commands::get_safety_number,
            commands::get_friend_key_rotations,
            commands::sync_friend_keys,
            commands::remove_friend,
            commands::get_pending_requests,
            commands::send_friend_request,
            commands::respond_friend_request,
            commands::send_message,
            commands::get_messages,
            commands::get_group_todo_messages,
            commands::get_latest_messages,
            commands::get_conv_link,
            commands::get_message_count,
            commands::get_conversations,
            commands::ensure_conversation,
            commands::set_conversation_pinned,
            commands::mark_read,
            commands::delete_conversation,
            commands::create_group,
            commands::distribute_group_key,
            commands::rename_group,
            commands::group_add_member,
            commands::group_remove_member,
            commands::transfer_group_creator,
            commands::leave_group,
            commands::get_groups,
            commands::get_group_reads,
            commands::sync_group_history_now,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_is_maximized,
            commands::window_toggle_fullscreen,
            commands::window_close,
            commands::send_group_message,
            commands::send_group_reaction,
            commands::recall_group_message,
            commands::pin_group_message,
            commands::send_group_announcement,
            commands::send_group_todo,
            commands::update_group_todo,
            commands::send_group_file,
            commands::send_todo_image,
            commands::todo_image_meta,
            commands::get_group_file_delivery_summary,
            commands::list_group_files,
            commands::cancel_file_transfer,
            commands::request_content,
            commands::request_content_by_cid,
            commands::get_content_transfers,
            commands::send_file_auto,
            commands::get_transfers,
            commands::set_share_dir,
            commands::get_share_dir,
            commands::get_downloads_dir,
            commands::set_downloads_dir,
            commands::open_downloads_dir,
            commands::request_share_tree,
            commands::download_shared_file,
            commands::copy_file,
            commands::copy_file_to_clipboard,
            commands::read_clipboard_file_paths,
            commands::save_data_file,
            commands::delete_file,
            commands::save_outgoing_image,
            commands::open_file_native,
            commands::apply_macos_window_shape,
            commands::read_file_preview,
            commands::read_content_preview,
            commands::media_present,
            commands::export_chat_text,
            commands::clear_all_data,
            commands::get_discovery_diag,
            commands::set_app_active,
            commands::list_routed_endpoints,
            commands::add_routed_endpoint,
            commands::remove_routed_endpoint,
            commands::get_relay_config,
            commands::save_relay_config,
            commands::check_relay_server,
            commands::get_logs,
            commands::clear_logs,
            commands::open_log_window,
            commands::open_settings_window,
            commands::close_settings_window,
            commands::open_group_todos_window,
            commands::take_group_todo_focus,
            commands::request_group_todo_focus,
            commands::open_image_preview,
            commands::prewarm_aux_windows,
            commands::get_group_todos_context,
            commands::get_image_preview_gallery,
            commands::open_link_window,
            commands::list_external_links,
            commands::add_external_link,
            commands::update_external_link,
            commands::remove_external_link,
            commands::save_todo_image_bytes,
            commands::delete_group_announcement,
            commands::list_active_group_announcements,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        // macOS：点击 Dock 图标且无可见窗口时恢复主窗口（避免「程序没反应」的错觉）
        #[cfg(all(desktop, target_os = "macos"))]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if !has_visible_windows {
                tray::show_main_window(app_handle);
            }
        }
        #[cfg(not(all(desktop, target_os = "macos")))]
        let _ = (app_handle, event);
    });
}

include!("lib_tests.rs");
