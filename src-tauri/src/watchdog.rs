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
/// 密集阶段写满 [`MAX_NOTES`] 条之后，降到这个间隔一条 —— **不许彻底停**：
/// 2026-10-27 那次渲染层卡死正好写满 20 条就哑了（574 s 处），之后到用户手动退出
/// 的 78 秒里一条都没有，而"它到底恢复没恢复"正是排查最需要的那一格。
/// 5 分钟 × 一天 = 288 行，现场文件的 2 MiB 上界照旧兜底。
const SLOW_NOTE_INTERVAL_MS: i64 = 300_000;
/// 密集阶段（每 [`MIN_NOTE_INTERVAL_MS`] 一条）最多写这么多条，之后转慢速。
const MAX_NOTES: u32 = 20;

/// 这一条该按哪个间隔判重：先密后疏。
fn note_interval(notes: u32) -> i64 {
    if notes < MAX_NOTES {
        MIN_NOTE_INTERVAL_MS
    } else {
        SLOW_NOTE_INTERVAL_MS
    }
}

/// 慢速间隔必须真的比密集间隔长 —— 写反了"转慢速"就变成"越卡写得越勤"。
/// 放在编译期断言（clippy 也不许在测试里写常量断言）。
const _: () = assert!(SLOW_NOTE_INTERVAL_MS > MIN_NOTE_INTERVAL_MS);

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
                    note_hang("main_thread", main_stall, op.as_ref(), &mut notes);
                }
                Some((_, last_note)) if now - *last_note >= note_interval(notes) => {
                    *last_note = now;
                    note_hang("main_thread", main_stall, op.as_ref(), &mut notes);
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
                        note_hang("ui_renderer", stale, op.as_ref(), &mut notes);
                    }
                    Some((_, last_note, notified)) => {
                        if now - *last_note >= note_interval(notes) {
                            *last_note = now;
                            note_hang("ui_renderer", stale, op.as_ref(), &mut notes);
                        }
                        if !*notified && stale >= NOTIFY_AT_MS {
                            *notified = true;
                            // 尊重「勿扰 / 通知总开关」：被关掉时仍有现场与下一轮横幅。
                            // 丢弃的是返回值，不是失败：跳过/失败都在 notifications 里带码落日志
                            // （code=NOTIFY_PERMISSION_DENIED / NOTIFY_SEND_FAILED），这里只发起。
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

// 时钟的家在 `logging`（不是 `db::now_ms`）：命令体扫描器会把 `db::` 当成"访问 SQLite"，
// 而心跳只写两个原子量，不该被算成重活命令（`lib_window_tests` 的棘轮）。
use crate::logging::now_ms;

/// 取**最后一次已知**的在途命令与它距今的秒数。
///
/// 为什么不能只看"此刻"：卡死现场里 `ui_current_op` 常常已经空了（那一刻没有 IPC 在飞），
/// 旧写法于是只写得出 `last_op=unknown` —— 5.14.7 那次 574 秒的渲染层卡死因此不可归因。
/// 现在心跳只在拿到命令时覆盖该字段（不清空），这句就能说出"最后一步是 X、距今 N 秒"。
fn current_op(state: &crate::state::AppState) -> Option<(String, i64)> {
    let op = state
        .ui_current_op
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()?;
    let at = state.ui_current_op_at.load(Ordering::SeqCst);
    let age_s = if at > 0 {
        (now_ms() - at).max(0) / 1000
    } else {
        -1
    };
    Some((op, age_s))
}

fn note_hang(scope: &str, ms: i64, op: Option<&(String, i64)>, notes: &mut u32) {
    *notes = notes.saturating_add(1);
    let seconds = (ms.max(0) / 1000).max(1);
    // op 名里不许出现空白：现场行按空白分字段（`field_str` 取第一个词）。
    let (op_name, op_age) = match op {
        Some((name, age)) => (
            name.split_whitespace()
                .next()
                .unwrap_or("unknown")
                .chars()
                .take(80)
                .collect::<String>(),
            *age,
        ),
        None => ("unknown".to_string(), -1),
    };
    crate::logging::crash_note(&format!(
        ">>> code=HANG scope={scope} seconds={seconds} last_op={op_name} last_op_age_s={op_age} {}",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-27 真机：574 s 的渲染层卡死正好写满 20 条（`MAX_NOTES`）就哑了，
    /// 之后到用户手动退出那 78 秒一条都没有 —— 而"它恢复没恢复"正是最需要的那格。
    /// 这条钉住：密集阶段之后**转慢速**，不是停。
    #[test]
    fn hang_notes_throttle_after_the_dense_phase_but_never_stop() {
        assert_eq!(note_interval(0), MIN_NOTE_INTERVAL_MS);
        assert_eq!(note_interval(MAX_NOTES - 1), MIN_NOTE_INTERVAL_MS);
        assert_eq!(note_interval(MAX_NOTES), SLOW_NOTE_INTERVAL_MS);
        assert_eq!(note_interval(MAX_NOTES + 10_000), SLOW_NOTE_INTERVAL_MS);
    }
}
