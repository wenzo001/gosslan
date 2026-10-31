// 职责边界：数据库/状态初始化失败之后那扇**独立错误窗口**（审计 A2）——显示什么、
// 重试怎么做、打开数据目录、退出这四件事都只住在这里；`lib.rs` 的 setup 失败分支
// 只负责"把这扇窗开起来"，不再自己摆文案。
//
// ## 为什么不再是 `tauri_plugin_dialog().message(...)`（旧形状）
//
// 插件那条对话框只有一个确定按钮（`MessageDialogButtons::OkCancel*` 最多两个），
// 放不下"重试 / 打开数据目录 / 退出"这三个动作；而旧写法是**点掉提示才 `exit(1)`** ⇒
// 数据库只是临时不可用（移动硬盘还没挂载、杀软正占着文件、iCloud 还没把目录放下来）时，
// 用户唯一的出路仍然是重启应用，而重启常常撞上同一次故障。
//
// ## 为什么移动端不跟着做
//
// 不是"顺手也弹一下"：那个时点原生窗口在 Android 上到底能不能显示，这里没有任何实测手段，
// 而"开了窗但没有 state"与"压根没开"分别是半死界面与永久白屏。移动端保持原路
// （`Err` → 框架 panic → 退出，文案已进 stderr/logcat），下面那几个命令在移动端只是
// 让 `generate_handler!` 的名字仍然存在（移动端永远不建这扇窗，也就没人调）。
#![cfg_attr(not(desktop), allow(dead_code, unused_imports))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// `try_state` / `path()` / `get_webview_window` / `run_on_main_thread` 都在 `Manager` 上。
/// 只在桌面端要：移动端那几个命令是桩，只碰 `AppHandle::exit`（那是 inherent 方法）。
#[cfg(desktop)]
use tauri::Manager;

/// 只有**失败路径**才会被 manage 的那一份状态。
///
/// 三个字段管三件事，缺一不可（都是这条链上真会发生的形状）：
/// - `message`：界面显示什么，以及重试失败后要刷新成"这一次"的原因；
/// - `retrying`：同一时刻只许有一个 init 在跑 —— 两个并发 init 会各开一个 sqlite 连接、
///   各起一套常驻 worker（同一个队列被两条链同时消费）；
/// - `resolved`：已经恢复成功 ⇒ 之后所有重试调用都必须拒。第二次成功 init 会 `manage`
///   出第二份 AppState、再跑一遍 `finish_boot`，那正是"重复初始化/多个实例"的形状。
pub struct StartupFailure {
    pub message: Mutex<String>,
    pub retrying: AtomicBool,
    pub resolved: AtomicBool,
}

impl StartupFailure {
    pub fn new(message: String) -> Self {
        Self {
            message: Mutex::new(message),
            retrying: AtomicBool::new(false),
            resolved: AtomicBool::new(false),
        }
    }

    /// 取当前文案（`into_inner` 而不是 `unwrap`：这里没有"并发写坏数据"可言，
    /// 而一次已经 panic 过的持锁者不该让错误窗口自己也读不出来）。
    pub fn message(&self) -> String {
        self.message
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn set_message(&self, message: String) {
        *self.message.lock().unwrap_or_else(|e| e.into_inner()) = message;
    }
}

/// 这一次重试能不能开始（纯函数，便于逐格判）。
///
/// 顺序是**先拒已恢复、再拒在途**：已恢复时 `retrying` 也已经是 false，两种状态
/// 若只判后者，"成功后再点一次"会被放行成第二次 init。
pub fn retry_gate(retrying: bool, resolved: bool) -> Result<(), &'static str> {
    if resolved {
        return Err("应用已经恢复正常，无需再重试。");
    }
    if retrying {
        return Err("上一次重试还没有结束，请等它跑完。");
    }
    Ok(())
}

/// 原子地把"这一轮重试"占下来；被别人抢走时返回 false（调用方直接拒，不许硬跑）。
pub fn claim_retry(slot: &AtomicBool) -> bool {
    !slot.swap(true, Ordering::SeqCst)
}

#[cfg(desktop)]
pub const WINDOW_STARTUP_ERROR: &str = "startup-error";

/// 数据目录/日志目录 + 失败文案，一次给全（界面自己不做任何猜测）。
#[cfg(desktop)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupErrorInfo {
    pub message: String,
    pub data_dir: String,
    pub log_dir: String,
}

/// 建那扇错误窗口（桌面端）。
///
/// 文案**不从参数走**：它只有一个真源，就是调用方先 `manage` 好的那份 [`StartupFailure`]，
/// 页面加载后自己用 `startup_error_info` 取 —— 传参数进来就等于造第二份，而重试失败后
/// 要更新的正是这一份（两个真源迟早会说不一样的话）。
///
/// ⚠️ 这条路径上**还没有 logger、没有 state**：任何一步失败都只能打到 stderr，
/// 而"窗没开成"必须留下痕迹 —— 否则就回到 A2 立案时那一格（无窗口、进程一直活着，
/// 而日志里什么都看不出来）。
#[cfg(desktop)]
pub fn open(app: &tauri::AppHandle) {
    let title = "Gosslan — 启动失败";
    let built = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_STARTUP_ERROR,
        tauri::WebviewUrl::App("startup-error.html".into()),
    )
    .title(title)
    .inner_size(560.0, 400.0)
    .min_inner_size(420.0, 320.0)
    // 系统标题栏：这扇窗是独立文档（不加载主界面那套自绘标题栏），而它必须能被拖动、
    // 能被看见标题；用系统那套是原生做法，也与"错误提示"这种一次性窗口的惯例一致。
    .decorations(true)
    .resizable(true)
    // 三个按钮全部按住：这扇窗唯一的出口是那三个动作之一。允许用红色按钮关掉它
    // 就等于允许"窗口没了而进程还在"——那正是这次要修的形态。
    .closable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .center()
    .visible(true)
    .build();
    if let Err(e) = built {
        eprintln!("[gosslan] 错误窗口建不出来（code=STARTUP_ERROR_WINDOW_FAILED）：{e}");
        crate::logging::crash_note(&format!(
            "code=STARTUP_ERROR_WINDOW_FAILED 错误窗口建不出来：{e}"
        ));
    }
}

/// 读这一次启动失败的文案与两个目录（错误窗口首帧用）。
#[cfg(desktop)]
#[tauri::command(async)]
pub fn startup_error_info(app: tauri::AppHandle) -> Result<StartupErrorInfo, String> {
    let failure = app
        .try_state::<std::sync::Arc<StartupFailure>>()
        .ok_or_else(|| "没有待处理的启动失败".to_string())?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("数据目录读不出来：{e}"))?;
    Ok(StartupErrorInfo {
        message: failure.message(),
        data_dir: data_dir.display().to_string(),
        log_dir: crate::logging::log_dir_in(&data_dir).display().to_string(),
    })
}

/// 打开数据目录，让用户自己看（审计 A2 的第二个动作）。
///
/// 走 [`crate::open_path::open_dir_native`] 这唯一门面：macOS 的沙盒路径与
/// 其他平台不一样，绕过它会在那一端静默失败。
#[cfg(desktop)]
#[tauri::command(async)]
pub fn startup_error_open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("数据目录读不出来：{e}"))?;
    crate::open_path::open_dir_native(&data_dir)?;
    Ok(data_dir.display().to_string())
}

/// 正常结束进程（第三个动作）。
///
/// 用 `app.exit(0)` 而不是 `process::restart`：前者走 Tauri 的正常退出路径
/// （会留下"这次是干净退出"的标记），后者绕开它 ⇒ 下一次启动会被判成
/// 「上次运行异常退出」（审计 A5 刚修掉的那格，不能在这里重新造出来）。
#[tauri::command(async)]
pub fn startup_error_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// 重试：重新走一遍**正确的**初始化流程（同一个 `AppState::init` + 同一个 `finish_boot`），
/// 成功后把这扇窗关掉、让主窗口按正常启动的路子自己显示。
///
/// 三个必须：
/// - **不重复建库、不覆盖原文件**：init 内部本来就不删不改（那道"主库不可用 + 有备份 ⇒
///   拒启"的闸也在这里生效），所以重试与首启走同一条路，没有任何"重来一遍所以先清一下"的分支；
/// - **失败要留在原地**：`Err(新文案)` 让窗口继续存在并可再次重试；
/// - **不许并发/重复初始化**：`retry_gate` + `claim_retry` + `resolved` 三格。
///
/// ⚠️ 线程模型：init 是重 IO（开库、跑 schema 迁移、建四个私有目录、读身份），而
/// `command(async)` 的同步体跑在 **tokio worker**（不是阻塞池，INV-P34 那条老账），
/// 所以显式进 `spawn_blocking`；`finish_boot` 里要建托盘、改 macOS 窗口位、注册菜单
/// ⇒ 必须回主线程（`run_on_main_thread`），否则就是"开窗命令挂到错误线程上永久卡死"
/// 那一族。
#[cfg(desktop)]
#[tauri::command(async)]
pub async fn startup_error_retry(app: tauri::AppHandle) -> Result<(), String> {
    let Some(failure) = app.try_state::<std::sync::Arc<StartupFailure>>() else {
        return Err("没有待处理的启动失败（这次启动不需要重试）".to_string());
    };
    let failure = failure.inner().clone();
    retry_gate(
        failure.retrying.load(Ordering::SeqCst),
        failure.resolved.load(Ordering::SeqCst),
    )
    .map_err(|e| e.to_string())?;
    if !claim_retry(&failure.retrying) {
        return Err("上一次重试还没有结束，请等它跑完。".to_string());
    }

    // ⚠️ 跨线程的边界上只能过 `Send` 的东西：`AppState::init` 的错误是
    // `Box<dyn Error>`（**不是** Send），所以那句错误必须在这同一个阻塞线程里就地换算成
    // 给人看的 String 再跨回来 —— 否则 `spawn_blocking` 直接不让编（`Result<_, Box<dyn Error>>`
    // 不满足 `R: Send`）。`raw` 留着写日志：那才是能定位技术原因的那一句。
    let init_handle = app.clone();
    let msg_handle = app.clone();
    let attempt = tokio::task::spawn_blocking(move || {
        crate::state::AppState::init(init_handle)
            .map_err(|e| (crate::boot_failure_message(&msg_handle, &*e), e.to_string()))
    })
    .await;
    let init_result = match attempt {
        Ok(r) => r,
        Err(e) => {
            failure.retrying.store(false, Ordering::SeqCst);
            return Err(format!("重试任务被线程池中断：{e}"));
        }
    };
    match init_result {
        Ok(state) => {
            failure.resolved.store(true, Ordering::SeqCst);
            failure.retrying.store(false, Ordering::SeqCst);
            // 收尾必须回**主线程**：`finish_boot` 里要建托盘、注册菜单、动 macOS 窗口位。
            // 两个句柄不能是同一个：`run_on_main_thread(&self, closure)` 借走 receiver，
            // 而闭包又要拿走它 ⇒ 同一份 clone 会撞"borrowed value moved"。
            let host = app.clone();
            let inner = app.clone();
            if let Err(e) = host.run_on_main_thread(move || {
                crate::finish_boot(&inner, state);
                // 先关错误窗（`destroy` 而不是 `close`：这扇窗 `closable(false)`，
                // close 那条路会被"不可关闭"挡住，而这里要的是确定性地让它消失）。
                if let Some(win) = inner.get_webview_window(WINDOW_STARTUP_ERROR) {
                    let _ = win.destroy();
                }
                // 主窗口此刻仍然藏着：首屏那次 `focus_window` 因为当时没有 state 而失败。
                // 重新加载让它按正常启动的路子再走一遍（自己去读数据、自己显示自己），
                // 于是这里不新建窗口、也不会出现第二扇主窗。
                if let Some(win) = inner.get_webview_window(crate::tray::MAIN_WINDOW_LABEL) {
                    let _ = win.reload();
                }
            }) {
                // ⚠️ 调度失败＝这一次**并没有**恢复：两格必须复位。否则下一次点重试会被
                // `retry_gate` 按 `resolved` 拒掉并回「应用已经恢复正常，无需再重试」——
                // 那是一句假话，而用户当时的唯一出路只剩「退出」。
                // （2026-10-31 复核发现：置真写在调度之前；修法只动这一支，成功路不变。）
                failure.resolved.store(false, Ordering::SeqCst);
                failure.retrying.store(false, Ordering::SeqCst);
                return Err(format!("恢复主线程调度失败：{e}"));
            }
            Ok(())
        }
        Err((message, raw)) => {
            failure.set_message(message.clone());
            failure.retrying.store(false, Ordering::SeqCst);
            // 每一次失败的尝试都要留痕：只有第一轮那条 BOOT_FAILED 的话，
            // "重试过、每次都卡在同一格"与"从没重试过"在日志里长得一样。
            crate::state_mark("boot", &format!("重试仍然失败：{raw}"));
            crate::logging::crash_note(&format!("code=BOOT_RETRY_FAILED 重试仍然失败：{raw}"));
            Err(message)
        }
    }
}

/// 移动端桩：那扇窗在移动端永远不建，也就没人调这几个命令；名字必须留着，
/// 否则 `generate_handler!` 那一份清单在移动端编不过。
#[cfg(mobile)]
#[tauri::command(async)]
pub fn startup_error_info(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app;
    Err("移动端不使用启动错误窗口".to_string())
}

#[cfg(mobile)]
#[tauri::command(async)]
pub fn startup_error_open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let _ = app;
    Err("移动端不使用启动错误窗口".to_string())
}

#[cfg(mobile)]
#[tauri::command(async)]
pub async fn startup_error_retry(app: tauri::AppHandle) -> Result<(), String> {
    let _ = app;
    Err("移动端不使用启动错误窗口".to_string())
}

#[cfg(test)]
mod startup_error_window_tests {
    use super::{claim_retry, retry_gate, StartupFailure};
    use std::sync::atomic::Ordering;

    /// 门控三格：**已恢复优先于在途**，两者都空才放行。
    ///
    /// 少判 `resolved` 的后果不是报错，而是第二次成功的 init —— 两份 AppState、两套常驻
    /// worker（同一个 outbox 被两条链消费），而界面上完全看不出来。
    #[test]
    fn retry_gate_refuses_resolved_first_and_inflight_second() {
        assert_eq!(retry_gate(false, false), Ok(()), "空闲且未恢复时必须放行");
        assert_eq!(
            retry_gate(true, false),
            Err("上一次重试还没有结束，请等它跑完。"),
            "在途要拒"
        );
        assert_eq!(
            retry_gate(false, true),
            Err("应用已经恢复正常，无需再重试。"),
            "已恢复要拒（这一格是并发那格挡不住的）"
        );
        assert_eq!(
            retry_gate(true, true),
            Err("应用已经恢复正常，无需再重试。"),
            "两格同时亮时按已恢复报，否则用户会去等一次永远不会结束的重试"
        );
    }

    /// `claim_retry` 是**抢占**而不是"看一眼再写"：两个调用同时进来只能有一个拿到 true。
    #[test]
    fn claim_retry_is_a_swap_not_a_check_then_set() {
        let slot = std::sync::atomic::AtomicBool::new(false);
        assert!(claim_retry(&slot), "第一次必须拿到");
        assert!(!claim_retry(&slot), "第二次必须被挡（读改写会放行两个）");
        slot.store(false, Ordering::SeqCst);
        assert!(claim_retry(&slot), "放开后要能再抢");
    }

    /// 文案是**这一轮**的：失败后必须换成新的原因，界面才会跟着变。
    #[test]
    fn message_is_replaced_with_the_latest_failure() {
        let f = StartupFailure::new("第一次：数据库打不开".to_string());
        assert_eq!(f.message(), "第一次：数据库打不开");
        f.set_message("第二次：目录仍然只读".to_string());
        assert_eq!(f.message(), "第二次：目录仍然只读");
    }
}
