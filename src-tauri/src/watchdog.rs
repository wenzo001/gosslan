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
use std::time::{Duration, Instant};

#[cfg(desktop)]
use tauri::Manager;

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

/// 墙钟与单调时钟差多少毫秒就认定"这一跳不能用进程内的停顿时长解释"。
///
/// 为什么是 5 s：看门狗每秒一跳，正常调度抖动是毫秒级；NTP 是缓慢 slew，不会在一个
/// tick 内跳 5 s。真机上误报的 gap 是 30–71 s（2026-10-31 / 11-01，`last_op=set_app_active`，
/// 全部落在睡眠/唤醒附近）⇒ 都远大于这个阈值。
pub(crate) const CLOCK_JUMP_TOLERANCE_MS: i64 = 5_000;

/// 一跳的判定：只看**这一跳**的墙钟增量能不能被单调时钟解释。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TickVerdict {
    /// 墙钟与单调时钟同步 ⇒ 主线程/渲染层停住多少就是多少，照旧判 HANG。
    Judge,
    /// 墙钟多走（睡眠恢复 / 墙钟被改）或少走（墙钟回拨）
    /// ⇒ 这一段**无法区分**"系统没在跑"与"进程真死" ⇒ 只重定基线。
    Skip,
}

/// 纯判定（虚拟时钟可直接构造，见下方 `virtual_clock_*` 用例）。
///
/// 睡 8 小时回来：墙钟 +28 800 000，单调时钟只走了 ~1 s ⇒ Skip。
/// 墙钟被调快 71 s：墙钟 +72 000，单调时钟 ~1 s ⇒ Skip。
/// 真卡死 40 s：看门狗自己在跑（墙钟与单调时钟同走 ~1 s）⇒ Judge，
/// 由调用方按 40 s 的停顿照旧写 HANG。
///
/// ⚠️ 边界：**只**看墙钟与单调时钟的分叉。不把"看门狗这一跳自己隔了很久"
/// （墙钟与单调时钟同走）当成豁免 —— 那正好是"进程整体停住"的形状
/// （SIGSTOP / 整机冻住），按用户 2026-11-03 的口径必须照旧判 HANG，
/// 否则豁免会宽到盖住真死。
pub(crate) fn tick_verdict(wall_delta_ms: i64, mono_delta_ms: i64) -> TickVerdict {
    let mono = mono_delta_ms.max(0);
    if (wall_delta_ms - mono).abs() >= CLOCK_JUMP_TOLERANCE_MS {
        TickVerdict::Skip
    } else {
        TickVerdict::Judge
    }
}

pub fn start<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: Arc<crate::state::AppState>) {
    let _ = std::thread::Builder::new()
        .name("gosslan-watchdog".to_string())
        .spawn(move || run(app, state));
}

fn run<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: Arc<crate::state::AppState>) {
    install_window_event_probe(&app, &state);
    let last_main_tick = Arc::new(AtomicI64::new(now_ms()));
    let posted_at = Arc::new(AtomicI64::new(0));
    let mut notes = 0u32;
    // (episode 开始, 上次写 HANG 的时刻)
    let mut main_episode: Option<(i64, i64)> = None;
    // (episode 开始, 上次写 HANG 的时刻, 是否已通知)
    let mut renderer_episode: Option<(i64, i64, bool)> = None;
    // 墙钟与进程内单调时钟的双基线：睡眠/墙钟被改时两者会分叉（见 [`tick_verdict`]）。
    let mut wall_prev = now_ms();
    let mut mono_prev = Instant::now();
    // 唤醒被检出时把渲染层"停滞起点"抬到此刻：睡眠那几个小时不该算成界面卡死。
    let mut hb_floor = 0i64;

    loop {
        let now = now_ms();
        let mono = Instant::now();
        let wall_delta = now - wall_prev;
        let mono_delta = mono.duration_since(mono_prev).as_millis() as i64;
        wall_prev = now;
        mono_prev = mono;

        if tick_verdict(wall_delta, mono_delta) == TickVerdict::Skip {
            // 睡眠恢复 / 墙钟被改：墙钟相对单调时钟分叉的那一段**无法区分**
            // "系统没在跑"与"进程真死"。用户 2026-11-03 的验收口径：不判 HANG、
            // 不写 HANG 族路标、不弹通知。只重定基线，并留一条**非 HANG 族**的
            // 路标证明豁免确实发生过（下一轮能据此解释"为什么这里没有 HANG"）。
            crate::logging::crash_note(&format!(
                ">>> code=WATCHDOG_CLOCK_JUMP wall_delta_ms={wall_delta} mono_delta_ms={mono_delta}"
            ));
            last_main_tick.store(now, Ordering::SeqCst);
            posted_at.store(0, Ordering::SeqCst);
            // 已在睡前写过 HANG 的 episode 在这里静默丢弃：宁可让那一轮显示"未配对"，
            // 也不在豁免时刻再写一条 HANG/HANG_END（否则豁免本身又会污染现场）。
            main_episode = None;
            renderer_episode = None;
            hb_floor = now;
            #[cfg(desktop)]
            crate::tray::set_watchdog_tooltip(&app, None);
            std::thread::sleep(TICK);
            continue;
        }

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
                    note_hang("main_thread", main_stall, op.as_ref(), &mut notes, &state);
                }
                Some((_, last_note)) if now - *last_note >= note_interval(notes) => {
                    *last_note = now;
                    note_hang("main_thread", main_stall, op.as_ref(), &mut notes, &state);
                }
                _ => {}
            }
        } else if let Some((start, _)) = main_episode.take() {
            note_end("main_thread", now - start);
        }

        // ---- 渲染层心跳：只有它发过至少一次才判（启动早期 hb=0）----
        let hb = state.ui_heartbeat_ms.load(Ordering::SeqCst);
        let active = state.ui_heartbeat_active.load(Ordering::SeqCst);
        // IPC 堆积取证：日志工作留在看门狗线程，心跳路径只写原子量。
        let inflight = state.ui_inflight.load(Ordering::SeqCst);
        let oldest_ms = state.ui_inflight_oldest_ms.load(Ordering::SeqCst);
        if active && (inflight >= 8 || oldest_ms >= 2_000) {
            let last = state.ui_backlog_note_at.load(Ordering::SeqCst);
            if now - last >= 30_000 {
                state.ui_backlog_note_at.store(now, Ordering::SeqCst);
                let op = current_op(&state)
                    .map(|(name, _)| name)
                    .unwrap_or_else(|| "unknown".to_string());
                state.logger.warn(
                    "ui",
                    format!(
                        "code=IPC_BACKLOG inflight={inflight} oldest_ms={oldest_ms} active={active} last_op={op}"
                    ),
                );
            }
        }
        if hb > 0 {
            // 唤醒后心跳时间戳还停在睡前 ⇒ 用 `hb_floor`（唤醒时刻）兜住：
            // 只豁免睡眠那一段，唤醒之后渲染层若仍不恢复，停滞照常从 0 长起来。
            let hb_effective = if hb_floor > 0 { hb.max(hb_floor) } else { hb };
            let stale = now - hb_effective;
            if active && stale >= RENDERER_STALE_MS {
                let op = current_op(&state);
                match &mut renderer_episode {
                    None => {
                        renderer_episode = Some((now - stale, now, false));
                        note_hang("ui_renderer", stale, op.as_ref(), &mut notes, &state);
                    }
                    Some((_, last_note, notified)) => {
                        if now - *last_note >= note_interval(notes) {
                            *last_note = now;
                            note_hang("ui_renderer", stale, op.as_ref(), &mut notes, &state);
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

/// 主窗口 focus/resize 的**轻量探针**：只写原子量，不写日志、不取锁。
///
/// Windows 假死现场里最缺的两格是「卡死前窗口是不是刚被最小化/切走」与
/// 「渲染层最后一次 resize 距今多久」。真正落盘由看门狗在 HANG 行里带出去，
/// 这里绝不直接 IO —— 窗口事件回调可能就在主线程上。
#[cfg(desktop)]
fn install_window_event_probe<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<crate::state::AppState>,
) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let st = state.clone();
    win.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(focused) => {
            st.ui_last_focus_ms.store(now_ms(), Ordering::SeqCst);
            st.ui_last_focus_focused.store(*focused, Ordering::SeqCst);
        }
        tauri::WindowEvent::Resized(_) => {
            st.ui_last_resize_ms.store(now_ms(), Ordering::SeqCst);
        }
        _ => {}
    });
}

#[cfg(not(desktop))]
fn install_window_event_probe<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _state: &Arc<crate::state::AppState>,
) {
}

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

fn note_hang(
    scope: &str,
    ms: i64,
    op: Option<&(String, i64)>,
    notes: &mut u32,
    state: &crate::state::AppState,
) {
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
    let hb = state.ui_heartbeat_ms.load(Ordering::SeqCst);
    let hb_age_ms = if hb > 0 { (now_ms() - hb).max(0) } else { -1 };
    let active = state.ui_heartbeat_active.load(Ordering::SeqCst);
    let inflight = state.ui_inflight.load(Ordering::SeqCst);
    let oldest_ms = state.ui_inflight_oldest_ms.load(Ordering::SeqCst);
    let focused = state.ui_last_focus_focused.load(Ordering::SeqCst);
    let focus_age_s = age_s(state.ui_last_focus_ms.load(Ordering::SeqCst));
    let resize_age_s = age_s(state.ui_last_resize_ms.load(Ordering::SeqCst));
    let db_hold = state
        .db_hold_note
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| "none".to_string())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_")
        .chars()
        .take(160)
        .collect::<String>();
    crate::logging::crash_note(&format!(
        ">>> code=HANG scope={scope} seconds={seconds} last_op={op_name} last_op_age_s={op_age} \
         hb_age_ms={hb_age_ms} active={active} inflight={inflight} inflight_oldest_ms={oldest_ms} \
         focused={focused} focus_age_s={focus_age_s} resize_age_s={resize_age_s} db_hold={db_hold} {}",
        // 冻住的那一刻我们占了多少内存 / 正在读多少帧字节 —— 没有这一格，
        // "主线程 + 渲染层同一秒双双停滞"只能猜，有了它才分得开"代码死循环"与"提交内存耗尽"。
        // 按 key 取字段的老解析（`logging.rs::field_str`）不受追加影响。
        crate::mem_diag::sample().line()
    ));
}

fn age_s(at: i64) -> i64 {
    if at > 0 {
        (now_ms() - at).max(0) / 1000
    } else {
        -1
    }
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

    /// 虚拟时钟三用例（用户 2026-11-03 的验收口径，必须能证伪）：
    /// 前两种"唤醒/墙钟跳变"必须**静默**，第三种"真卡死"必须**照旧判**。
    #[test]
    fn virtual_clock_sleep_and_jump_are_exempt_but_a_real_stall_is_not() {
        let one_tick_sleep = 8 * 3600 * 1000 + 1_000; // 睡 8h 回来，墙钟 +8h，单调时钟只走 1s
        assert_eq!(
            tick_verdict(one_tick_sleep, 1_000),
            TickVerdict::Skip,
            "纯睡眠 8h 回来不许判 HANG"
        );
        // 墙钟被调快 71s：墙钟增量比单调时钟多 71s。
        assert_eq!(
            tick_verdict(72_000, 1_000),
            TickVerdict::Skip,
            "墙钟 +71s 不许判 HANG"
        );
        // 真卡死 40s：看门狗自己在跑，墙钟与单调时钟同走 1s ⇒ 交给老判据，
        // 40s 的停顿仍超过 MAIN_STALL_NOTE_MS ⇒ 会写 HANG。
        assert_eq!(
            tick_verdict(1_000, 1_000),
            TickVerdict::Judge,
            "进程内真卡死不许被豁免"
        );
        let real_stall_ms = 40_000i64;
        assert!(
            real_stall_ms >= MAIN_STALL_NOTE_MS,
            "真卡死 40s 仍在写现场阈值以上"
        );
        // 反控：墙钟回拨 71s（少走）也要静默并重定基线，否则下一次读数会是负数/乱序。
        assert_eq!(tick_verdict(-70_000, 1_000), TickVerdict::Skip);
    }

    /// 阈值边界：正常调度抖动不许被当成唤醒（否则豁免会宽到盖住真死）。
    #[test]
    fn sub_threshold_drift_still_judges() {
        assert_eq!(tick_verdict(1_050, 1_000), TickVerdict::Judge);
        assert_eq!(tick_verdict(1_000, 4_900), TickVerdict::Judge);
        assert_eq!(tick_verdict(6_000, 1_000), TickVerdict::Skip);
        // 反控：看门狗自己隔了 6 s 才跑（墙钟与单调时钟同走）⇒ 这是"进程整体停住"，
        // 不是睡眠 ⇒ 仍然判（不许用豁免盖住真死）。
        assert_eq!(tick_verdict(6_000, 6_000), TickVerdict::Judge);
    }
}
