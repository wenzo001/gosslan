// 外部分享到会话的命令层：入口解析 → 入队 → 聚焦主窗 → 通知前端；以及前端来取/来清。
//
// ⚠️ 与同目录的 `share.rs` 不是一件事：那是 **P2P 共享目录 / 共享请求**（`SHARE_DIR_*` /
// `SHARE_NOT_FRIEND` 那一族）。这里是「外部网页/应用把一条链接分享进来」，前缀统一
// `EXTERNAL_SHARE_*`，别把两者混成一个概念。
//
// 职责边界：
// - 解析与限额全在 `crate::share`（纯函数，有单测）；这里只碰状态与事件。
// - **不发送消息**：发送由前端在用户显式点选会话后走既有 `send`，命令层不提供
//   「按 id 直接发」的入口 —— 那会变成「网页能静默发消息」的通道（活契约 §D 的红线）。
// - 队列是内存态：进程退出即失效。分享是一次性动作，不需要跨重启恢复（与更新意图相反）。

// ⚠️ 本文件是 `include!` 拼进 `commands.rs` 的（见 `commands.rs:161`）：`Arc` / `State` /
// `Emitter` / `Manager` / `error_codes` 等名字由父模块与相邻分册提供，**这里再 `use` 一遍会
// `E0252`**。同理 `spawn_device_auth_link` 是同一模块里的兄弟函数，直接按名字调即可。
//
// 只有 `sh` 这个别名是本文件独有的（父模块没有导入 `crate::share`），可以留一条。
use crate::share as sh;

/// 外部内容入口（深链回调 / 冷启动 argv / 单实例转发）。
///
/// 失败一律回具名码：调用方（网页/系统）看不见，但用户会看到一条可读提示，
/// 日志里也能检索到是哪一类不合法。
#[cfg_attr(not(desktop), allow(dead_code))] // 移动端深链未接线（见 `lib.rs` 里 `mod share` 的说明）
pub async fn begin_share(app: &tauri::AppHandle, raw: &str) -> Result<sh::SharePrompt, String> {
    let payload = match sh::parse_share_intent(raw)? {
        sh::ShareIntent::Inline(p) => p,
        // 受控引用要拿 `<ref>` 去 RP 换内容，本仓还没有那个端点。明确说不支持，
        // 而不是「先弹个空面板」或「静默失败」——后者会让接入方以为已经在工作。
        sh::ShareIntent::Reference(r) => {
            return Err(error_codes::coded(
                error_codes::EXTERNAL_SHARE_REFERENCE_UNSUPPORTED,
                format!(
                    "受控分享（{} 的 {}）需要 RP 侧 share-request 端点，本期只支持内联内容",
                    r.rp_origin, r.share_ref
                ),
            ));
        }
    };

    let state = (*app.state::<Arc<crate::state::AppState>>()).clone();
    let now_ms = crate::logging::now_ms();
    let prompt = sh::SharePrompt {
        share_id: uuid::Uuid::new_v4().to_string(),
        payload,
        received_at_ms: now_ms,
        expires_at_ms: now_ms + sh::PENDING_TTL_MS,
    };
    // 入队只在锁内做一次 retain+insert，不跨 await 持锁；刻意不进阻塞池：
    // 本函数是 `async`（深链回调里 await），再套 `spawn_blocking` 反而多一次调度。
    let admitted = {
        let mut map = state
            .external_share_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sh::admit(&mut map, prompt, now_ms, sh::MAX_PENDING)?
    };

    // 先把窗口叫到前面再 emit：用户点了链接却看着别的应用，会以为没反应。
    //
    // 只用 `show()` + `set_focus()`（与 `device_auth` 的深链一致）：
    // `unminimize` / `set_minimized` 在 tauri v2 的 `WebviewWindow` 上**没有**这两个方法
    // （E0599，macOS clippy 与 Android 门禁各实测一次）。窗口被最小化时靠 `show()` 唤回，
    // 这与既有授权深链的行为一致 —— 不为分享单独发明一套抬窗语义。
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window(crate::WINDOW_MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("share-request", &admitted);
    Ok(admitted)
}

/// 深链线程入口：失败**必须留痕并告知用户**（与设备认证不同：那边关掉确认页就等于拒绝，
/// 而分享失败是「点了链接什么也没发生」，不给提示用户只会反复点）。
#[cfg_attr(not(desktop), allow(dead_code))] // 移动端深链未接线（见 `lib.rs` 里 `mod share` 的说明）
pub fn spawn_share_link(app: tauri::AppHandle, raw: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = begin_share(&app, &raw).await {
            eprintln!("[share] 分享入口处理失败：{e}");
            let _ = app.emit("share-error", &e);
        }
    });
}

/// 把一条深链分派给正确的处理者：分享入口走分享，其余（授权深链）保持原路。
///
/// 单独一个分派函数而不是在每个调用点各判一次：`lib.rs` 里三处会收到深链
/// （单实例转发 / `on_open_url` / 冷启动），判据写在三处必然有一处漏。
#[cfg_attr(not(desktop), allow(dead_code))] // 移动端深链未接线（见 `lib.rs` 里 `mod share` 的说明）
pub fn route_deep_link(app: &tauri::AppHandle, raw: String) {
    if sh::is_share_entry(&raw) {
        spawn_share_link(app.clone(), raw);
    } else {
        spawn_device_auth_link(app.clone(), raw);
    }
}

/// 手动粘贴一条分享链接（浏览器/系统没把深链交接过来时的兜底）。
///
/// 与 `device_auth_handle_link` 对称：那边也有一个粘贴入口。**这条命令不是给网页用的**，
/// 网页照旧走深链；它解决的是「深链压根没被系统注册」的场景 —— 开发期构建、未签名包、
/// 以及没做协议注册的 Linux 桌面。没有它，接入方在本地只能靠「先打签名包」才能自测分享。
///
/// 与深链入口走**同一个** `begin_share`：解析、限额、去重、排队、事件全不变，
/// 所以测试这条路径等于测真实入口，不会出现「自测通过、线上不同」。
#[tauri::command(async)]
pub async fn share_handle_link(
    state: State<'_, Arc<crate::state::AppState>>,
    url: String,
) -> Result<sh::SharePrompt, String> {
    begin_share(&state.inner().app, &url).await
}

/// 取当前待处理的分享（最新一条）。冷启动时前端拿不到「到达那一刻」的事件，靠这一条补拉。
#[tauri::command(async)]
pub async fn share_get_pending(
    state: State<'_, Arc<crate::state::AppState>>,
) -> Result<Option<sh::SharePrompt>, String> {
    let state = (*state.inner()).clone();
    let now_ms = crate::logging::now_ms();
    tokio::task::spawn_blocking(move || {
        let mut map = state
            .external_share_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sh::newest_live(&mut map, now_ms)
    })
    .await
    .map_err(|e| {
        error_codes::coded(
            error_codes::EXTERNAL_SHARE_INVALID_LINK,
            format!("读取分享失败：{e}"),
        )
    })
}

/// 处理完（已发送 / 用户关掉）就把这一条移出队列。返回是否真的删掉了。
#[tauri::command(async)]
pub async fn share_dismiss(
    state: State<'_, Arc<crate::state::AppState>>,
    share_id: String,
) -> Result<bool, String> {
    let state = (*state.inner()).clone();
    tokio::task::spawn_blocking(move || {
        let mut map = state
            .external_share_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        sh::dismiss(&mut map, &share_id)
    })
    .await
    .map_err(|e| {
        error_codes::coded(
            error_codes::EXTERNAL_SHARE_INVALID_LINK,
            format!("关闭分享失败：{e}"),
        )
    })
}
