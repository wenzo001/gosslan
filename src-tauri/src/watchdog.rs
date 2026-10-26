//! 卡死看门狗：主线程往返探针 + 渲染层心跳。
//!
//! 只做两件事：把卡死写成现场（`>>> code=HANG ...`），以及在渲染层完全无响应时
//! 发一条系统通知 —— JS 主线程死循环时 Vue 渲染不出任何东西，通知是唯一还能让
//! 用户"看到"的通道。真正的恢复动作是托盘「重启」（`restart::request_restart`）。
//!
//! 阈值分两档，别混：
//! - 2 s / 3 s 是**写现场**的诊断阈值（不打扰用户）；
//! - 10 s 是**用户可见**的通知阈值（与前端 HangNotice 的 10 s 同一口径）。
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 探针/心跳检查周期。
const TICK: Duration = Duration::from_secs(1);
/// 主线程往返超过这么久 ⇒ 记一次 HANG（episode 内只记一次）。
const MAIN_STALL_NOTE_MS: i64 = 2_000;
/// 前端心跳超过这么久没更新 ⇒ 渲染层疑似卡死。
const RENDERER_STALE_MS: i64 = 3_000;
/// 心跳停滞这么久 ⇒ 发系统通知（每轮一次）。
const NOTIFY_AT_MS: i64 = 10_000;
/// 同一 episode 内两次 HANG 记录的最小间隔。
const MIN_NOTE_INTERVAL_MS: i64 = 30_000;
/// 整个进程最多写多少条 HANG（现场文件有 2 MiB 上界，这里再加一层）。
const MAX_NOTES: u32 = 20;

pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: Arc<crate::state::AppState>) {
    let _ = std::thread::Builder::new()
        .name("gosslan-watchdog".to_string())
        .spawn(move || run(app, state));
}

fn run<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: Arc<crate::state::AppState>) {
    let last_main_tick = Arc::new(AtomicI64::new(now_ms()));
    let posted_at = Arc::new(AtomicI64::new(0));
    let mut notes = 0u32;
    // (episode 开始, 上次写 HANG 的时刻)
    let mut main_episode: Option<(i64, i64)> = None;
    // (episode 开始, 上次写 HANG 的时刻, 是否已通知)
    let mut renderer_episode: Option<(i64, i64, bool)> = None;

    loop {
        let now = now_ms();

        // ---- 主线程探针：一次只挂一个，避免主线程恢复时堆满事件队列 ----
        let tick = last_main_tick.load(Ordering::SeqCst);
        if posted_at.load(Ordering::SeqCst) <= tick {
            posted_at.store(now, Ordering::SeqCst);
            let last = last_main_tick.clone();
            if app
                .run_on_main_thread(move || {
                    last.store(now_ms(), Ordering::SeqCst);
                })
                .is_err()
            {
                return; // 事件循环已退出
            }
        }
        let main_stall = now - last_main_tick.load(Ordering::SeqCst);
        if main_stall >= MAIN_STALL_NOTE_MS {
            let op = current_op(&state);
            match &mut main_episode {
                None => {
                    main_episode = Some((now - main_stall, now));
                    note_hang("main_thread", main_stall, op.as_deref(), &mut notes);
                }
                Some((_, last_note)) if now - *last_note >= MIN_NOTE_INTERVAL_MS => {
                    *last_note = now;
                    note_hang("main_thread", main_stall, op.as_deref(), &mut notes);
                }
                _ => {}
            }
        } else if let Some((start, _)) = main_episode.take() {
            note_end("main_thread", now - start);
        }

        // ---- 渲染层心跳：只有它发过至少一次才判（启动早期 hb=0）----
        let hb = state.ui_heartbeat_ms.load(Ordering::SeqCst);
        let active = state.ui_heartbeat_active.load(Ordering::SeqCst);
        if hb > 0 {
            let stale = now - hb;
            if active && stale >= RENDERER_STALE_MS {
                let op = current_op(&state);
                match &mut renderer_episode {
                    None => {
                        renderer_episode = Some((now - stale, now, false));
                        note_hang("ui_renderer", stale, op.as_deref(), &mut notes);
                    }
                    Some((_, last_note, notified)) => {
                        if now - *last_note >= MIN_NOTE_INTERVAL_MS {
                            *last_note = now;
                            note_hang("ui_renderer", stale, op.as_deref(), &mut notes);
                        }
                        if !*notified && stale >= NOTIFY_AT_MS {
                            *notified = true;
                            // 尊重「勿扰 / 通知总开关」：被关掉时仍有现场与下一轮横幅。
                            let _ = crate::notifications::show_if_enabled(
                                &state,
                                "Gosslan 界面无响应",
                                "可以从状态栏菜单点击「重启」恢复。",
                            );
                            // 托盘只在桌面端存在（`mod tray` 是 cfg(desktop)）。
                            #[cfg(desktop)]
                            crate::tray::set_watchdog_tooltip(
                                &app,
                                Some("界面无响应，可从状态栏重启"),
                            );
                        }
                    }
                }
            } else if let Some((start, _, _)) = renderer_episode.take() {
                note_end("ui_renderer", now - start);
                #[cfg(desktop)]
                crate::tray::set_watchdog_tooltip(&app, None);
            }
        }

        std::thread::sleep(TICK);
    }
}

fn now_ms() -> i64 {
    // 用日志模块的时钟而不是 `db::now_ms`：命令体扫描器会把 `db::` 当成"访问 SQLite"，
    // 而心跳只写两个原子量，不该被算成重活命令（lib_window_tests 的棘轮）。
    crate::logging::now_ms()
}

fn current_op(state: &crate::state::AppState) -> Option<String> {
    state
        .ui_current_op
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

fn note_hang(scope: &str, ms: i64, op: Option<&str>, notes: &mut u32) {
    if *notes >= MAX_NOTES {
        return;
    }
    *notes += 1;
    let seconds = (ms.max(0) / 1000).max(1);
    // op 名里不许出现空白：现场行按空白分字段（`field_str` 取第一个词）。
    let op: String = op
        .unwrap_or("unknown")
        .split_whitespace()
        .next()
        .unwrap_or("unknown")
        .chars()
        .take(80)
        .collect();
    crate::logging::crash_note(&format!(
        ">>> code=HANG scope={scope} seconds={seconds} last_op={op} {}",
        // 冻住的那一刻我们占了多少内存 / 正在读多少帧字节 —— 没有这一格，
        // "主线程 + 渲染层同一秒双双停滞"只能猜，有了它才分得开"代码死循环"与"提交内存耗尽"。
        // 按 key 取字段的老解析（`logging.rs::field_str`）不受追加影响。
        crate::mem_diag::sample().line()
    ));
}

fn note_end(scope: &str, ms: i64) {
    let seconds = (ms.max(0) / 1000).max(1);
    crate::logging::crash_note(&format!(
        ">>> code=HANG_END scope={scope} seconds={seconds}"
    ));
}
