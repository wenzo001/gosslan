//! 一键重启：有界收尾 → 销毁单实例锁 → 重启；主线程不响应时由兜底线程强制 re-exec。
//!
//! 为什么必须单独一层：`AppHandle::restart()` 在**非主线程**上只做两件事 ——
//! 置 `restart_on_exit`、`request_exit`，然后 `sleep(Duration::MAX)` 等事件循环
//! 真正重启（tauri 2.11.5 `app.rs:588-610`）。主线程被卡住时这个等待永远不会结束，
//! 用户看到的就是"点了重启没反应"。兜底线程在 3s 后直接 `process::restart`，
//! 这条路不经过事件循环。
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager as _;

/// `RunEvent::Exit` 是否已经到达（lib.rs 置位）。兜底线程据此避免二次 spawn。
pub static EXIT_SEEN: AtomicBool = AtomicBool::new(false);

/// 网络收尾最多等这么久；超时就放弃（socket 由 OS 关闭，重启后 LAN 启动有重试）。
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(800);
/// 事件循环在这么久内没走到 Exit ⇒ 认为主线程卡住，强制重启。
const RESTART_GUARD: Duration = Duration::from_secs(3);

/// 请求重启。可从任意线程调用；真正的收尾与重启在独立线程里做。
///
/// 泛型 `R` 不能省：托盘菜单回调里的 `AppHandle<R>` 是泛型，若这里写死默认 `Wry`，
/// 会把 `TrayIconBuilder` 的推断收窄成 `Wry`，`build_tray<R>` 当场编译不过。
pub fn request_restart<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.try_state::<std::sync::Arc<crate::state::AppState>>();
        if let Some(st) = &state {
            st.logger.info("app", "code=APP_RESTART_REQUEST");
        }
        // ① 有界收尾：不 await 无上限；失败只记日志，不阻断重启。
        let cleanup_ok = match &state {
            Some(st) => {
                let st = st.inner().clone();
                tauri::async_runtime::block_on(async {
                    tokio::time::timeout(CLEANUP_TIMEOUT, crate::network::stop(&st))
                        .await
                        .is_ok()
                })
            }
            None => false,
        };
        if let Some(st) = &state {
            st.logger.info(
                "app",
                format!(
                    "code=APP_RESTART_CLEANUP ok={cleanup_ok} timeout_ms={}",
                    CLEANUP_TIMEOUT.as_millis()
                ),
            );
            // ② 重启算"正常收尾"：下一轮不该弹崩溃横幅。
            st.logger.write_exit_marker();
        }
        // ③ 单实例锁必须先销毁：`process::restart` 是"先 spawn 再 exit"，
        //    macOS 实现靠 /tmp/<identifier>_si.sock 判定；旧进程还活着时新进程会直接 exit(0)。
        #[cfg(desktop)]
        tauri_plugin_single_instance::destroy(&app);
        // ④ 兜底：事件循环 3s 内没走到 Exit ⇒ 主线程可能卡住，绕过它直接 re-exec。
        let guard = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(RESTART_GUARD);
            if EXIT_SEEN.load(Ordering::SeqCst) {
                return;
            }
            crate::logging::crash_note(
                "code=RESTART_TIMEOUT 重启未在 3s 内完成（主线程可能卡住）⇒ 强制 re-exec",
            );
            if let Some(st) = guard.try_state::<std::sync::Arc<crate::state::AppState>>() {
                st.logger.write_exit_marker();
            }
            #[cfg(desktop)]
            tauri_plugin_single_instance::destroy(&guard);
            // 不手写 spawn：macOS bundle 的重启在 Tauri 里有专门处理（Info.plist 取二进制）。
            // `Manager::env()` 返回 `Env` 值（不是引用），`process::restart` 要 `&Env`。
            let env = guard.env();
            tauri::process::restart(&env);
        });
        // ⑤ 正常路径：非主线程会 request_exit 并等事件循环；Exit 到达后由框架重启。
        app.restart();
    });
}
