//! 信号处理（2026-11-03 闪退取证第 2 项）。
//!
//! `kill -TERM` 以前的结局是进程无声消失、不留任何痕迹 ⇒ 下一轮只能按"缺席"
//! 推断成 `SilentKill`（异常终止横幅照弹，把一次外部终止说成事故）。现在：
//! 专用线程 `sigwait` ⇒ 写 `code=SIGTERM_RECEIVED` 留痕 ⇒ 走正常退出流程
//!（`RunEvent::Exit` 写退出路标），下一轮 `classify_previous_exit` 判 `Sigterm`，
//! "被外部杀"与"崩溃"从此分开。
//!
//! 为什么是"屏蔽 + sigwait 专用线程"而不是异步信号处理函数：异步 handler 里
//! 只能碰 async-signal-safe 的原语，而写现场文件、调 Tauri 退出都是普通线程上
//! 的常规操作。sigwait 把"处理信号"变成普通线程上的普通代码，没有一类
//! 信号安全陷阱。

/// **尽早**屏蔽 SIGTERM（仅 Unix）：必须在任何工作线程派生**之前**调用。
///
/// 为什么这么早：新线程继承派生它的线程的信号掩码。tokio / WebView 的工作线程
/// 大多在 Tauri builder 阶段就派生 —— 那时还没屏蔽的话，SIGTERM 会被随便哪个
/// 未屏蔽线程按**默认处置**（直接终止进程）接走，`sigwait` 线程永远等不到
///（实测形状：进程退出、现场文件里一条路标都没有）。在 `run()` 的最开头屏蔽，
/// 之后派生的所有线程都继承"屏蔽" ⇒ 信号只能被 [`register_sigterm`] 的
/// sigwait 线程取走。
#[cfg(unix)]
pub fn block_sigterm() {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

/// 注册 SIGTERM 处理（仅 Unix：macOS / Linux / Android；Windows 没有 SIGTERM）。
///
/// 前置：[`block_sigterm`] 已在 `run()` 开头把 SIGTERM 屏蔽（本函数派生的线程
/// 继承掩码，`sigwait` 才收得到信号）。
#[cfg(unix)]
pub fn register_sigterm(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("gosslan-sigterm".into())
        .spawn(move || {
            let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut set);
                libc::sigaddset(&mut set, libc::SIGTERM);
            }
            loop {
                let mut sig = 0;
                let rc = unsafe { libc::sigwait(&set, &mut sig) };
                if rc == 0 && sig == libc::SIGTERM {
                    // 留痕走**独立通道**（不依赖 logger 还活着）：下一轮
                    // `classify_previous_exit` 就认这一行。
                    crate::logging::crash_note(
                        "code=SIGTERM_RECEIVED 收到 SIGTERM ⇒ 走正常退出流程（外部终止，不是崩溃）",
                    );
                    // 正常退出流程：RunEvent::Exit 里写退出路标、收重启兜底线程的尾。
                    app.exit(0);
                    return;
                }
                // 其它信号（不可能：掩码里只有 SIGTERM）或 EINTR ⇒ 继续等。
            }
        });
    if let Err(e) = spawned {
        // 线程都派不出来 ⇒ 留痕能力缺失，但应用本体照常跑（信号回到默认处置：
        // 终止时无痕，回到修复前的行为，而不是启动失败）。
        eprintln!("[gosslan] SIGTERM 监听线程未能启动：{e}");
    }
}

#[cfg(test)]
mod tests {
    /// 接线守卫（2026-11-03 闪退取证第 2 项）：注册点在 setup 成功路径上，
    /// 且"留痕 + 正常退出 + sigwait"三件套缺一即红 —— 摘掉任何一件，
    /// `kill -TERM` 就回到无声消失。
    #[test]
    fn sigterm_watchpoint_is_wired_into_boot() {
        let lib = include_str!("lib.rs");
        let flat: String = lib.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(
            flat.contains("crate::signals::register_sigterm(app.handle().clone())"),
            "setup 成功路径没注册 register_sigterm ⇒ kill -TERM 又会无声消失"
        );
        // 屏蔽必须在线程派生之前（run() 开头）：晚了信号会被未屏蔽线程按默认处置接走。
        assert!(
            flat.contains("crate::signals::block_sigterm()"),
            "run() 开头没有 block_sigterm ⇒ sigwait 线程永远收不到信号"
        );
        let run_at = flat.find("pubfnrun()").expect("找不到 run()");
        let block_at = flat.find("crate::signals::block_sigterm()").unwrap();
        let builder_at = flat[run_at..]
            .find("tauri::Builder::default()")
            .expect("找不到 builder");
        assert!(
            block_at < run_at + builder_at,
            "block_sigterm 必须排在 Builder（线程派生）之前"
        );
        let sig = include_str!("signals.rs");
        for needle in ["libc::sigwait(", "code=SIGTERM_RECEIVED", "app.exit(0)"] {
            assert!(sig.contains(needle), "SIGTERM 处理缺了 {needle}");
        }
        // 反控：摘掉注册行，同一把尺子必须说不。
        let gutted = flat.replace("crate::signals::register_sigterm(app.handle().clone())", "");
        assert_ne!(gutted, flat, "变异没落进去 ⇒ 判据盯错了形状");
        assert!(!gutted.contains("register_sigterm("));
    }
}
