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

/// 分享回执的超时：比常规请求短 —— 用户已经看到消息发出去了，
/// 回执只是给 RP 的附带信息，等太久没意义。
const SHARE_RECEIPT_TIMEOUT_SECS: u64 = 5;

/// 外部内容入口（深链回调 / 冷启动 argv / 单实例转发）。
///
/// 失败一律回具名码：调用方（网页/系统）看不见，但用户会看到一条可读提示，
/// 日志里也能检索到是哪一类不合法。
#[cfg_attr(not(desktop), allow(dead_code))] // 移动端深链未接线（见 `lib.rs` 里 `mod share` 的说明）
/// 目标是否**已知**（纯函数，便于单测）。
///
/// - `peer`：目标 device_id 在好友列表里。
/// - `group`：目标是 `group:<id>` 形态，剥前缀后与已知群 id 比对。
/// - 其它种类 ⇒ 一律 false（`normalize_target` 已拒过，这里是兜底）。
fn target_is_known(to: &str, kind: &str, friend_ids: &[String], group_ids: &[String]) -> bool {
    match kind {
        "peer" => friend_ids.iter().any(|id| id == to),
        "group" => {
            let gid = to.strip_prefix("group:").unwrap_or(to);
            group_ids.iter().any(|id| id == gid)
        }
        _ => false,
    }
}

/// 定向目标**存在性**校验（**fail closed**）。
///
/// 形状（字符集/种类）已在 `share::normalize_target` 判过；这里只判「有没有这个人/这个群」。
///
/// 查不到 ⇒ **整笔拒**（`EXTERNAL_SHARE_BAD_TARGET`）：绝不新建会话、绝不猜、绝不广播。
/// 「预填一个不存在的目标」会让用户以为自己发给了谁，而消息可能进了另一个会话。
fn resolve_share_target(
    conn: &rusqlite::Connection,
    payload: &sh::SharePayload,
) -> Result<(), String> {
    let (Some(to), Some(kind)) = (payload.to.as_deref(), payload.to_kind.as_deref()) else {
        return Ok(());
    };
    match kind {
        "peer" => {
            let friends = crate::db::list_friends(conn).map_err(|e| {
                error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    format!("读取好友列表失败：{e}"),
                )
            })?;
            let ids: Vec<String> = friends.iter().map(|f| f.device_id.clone()).collect();
            if !target_is_known(to, kind, &ids, &[]) {
                return Err(error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    "要分享给的那个人不在你的好友列表里",
                ));
            }
            let Some(f) = friends.iter().find(|f| f.device_id == to) else {
                return Err(error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    "要分享给的那个人不在你的好友列表里",
                ));
            };
            // 目标好友**还没聊过** ⇒ 库里没有会话行 ⇒ 面板里列不出来，就没法「一键发给他」。
            // 建一个空会话（不发送任何消息，与用户在界面新建会话是一回事），
            // 这样面板能列出并预勾这个目标。
            crate::db::ensure_conversation(conn, &f.device_id, "single", &f.nickname, f.avatar.as_deref())
                .map_err(|e| {
                    error_codes::coded(
                        error_codes::EXTERNAL_SHARE_BAD_TARGET,
                        format!("准备目标会话失败：{e}"),
                    )
                })?;
            Ok(())
        }
        "group" => {
            // 群会话 id 形如 `group:<id>`；`get_group` 用的是不带前缀的群 id。
            let gid = to.strip_prefix("group:").unwrap_or(to);
            let groups = crate::db::list_groups(conn).map_err(|e| {
                error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    format!("读取群列表失败：{e}"),
                )
            })?;
            let gids: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
            if !target_is_known(to, kind, &[], &gids) {
                return Err(error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    "要分享给的那个群不在你的群列表里",
                ));
            }
            let Some(g) = groups.into_iter().find(|g| g.id == gid) else {
                return Err(error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    "要分享给的那个群不在你的群列表里",
                ));
            };
            // 同样：没有会话行就建一个（群名从 groups 表取，不覆盖）。
            crate::db::ensure_conversation(conn, to, "group", &g.name, None).map_err(|e| {
                error_codes::coded(
                    error_codes::EXTERNAL_SHARE_BAD_TARGET,
                    format!("准备目标会话失败：{e}"),
                )
            })?;
            Ok(())
        }
        other => Err(error_codes::coded(
            error_codes::EXTERNAL_SHARE_BAD_TARGET,
            format!("未知的分享目标种类：{other}"),
        )),
    }
}

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
    // 定向目标的存在性在**入队前**判：命中不了就不该弹一个预填着假目标的面板。
    // 读库很短（好友表全表 + 群单行），锁持有时间可忽略。
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        resolve_share_target(&dbc, &payload)?;
    }
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

/// 扫系统分享目标的**落地区**：把平台扩展写进来的文件转成待处理分享。
///
/// 落地区是**别的进程**写的 ⇒ 每个文件都要过 `incoming_share::parse_file` 的校验
/// （严格文件名、大小、时效、内容与深链同一把尺子）。不合规的文件丢掉并留日志，
/// **绝不让它影响分享流程本身** —— 这一层是锦上添花，深链那条主路不能被它带崩。
///
/// 顺序刻意是「先入队、后删文件」：入队失败就把文件留着（下次再试），
/// 删文件失败也只是下次再入一次队（`admit` 会按内容去重，不会刷屏）。
///
/// 返回新入队的那些（可能空）。
fn scan_incoming_shares(app: &tauri::AppHandle, now_ms: i64) -> Vec<sh::SharePrompt> {
    let Ok(local_dir) = app.path().app_local_data_dir() else {
        return Vec::new();
    };
    let dir = crate::incoming_share::incoming_dir(&local_dir);
    // 目录不存在 = 平台扩展没装/没写过 = 常态，不是错误（`scan_dir` 直接回空）。
    let candidates = crate::incoming_share::scan_dir(&dir, now_ms);
    if candidates.is_empty() {
        return Vec::new();
    }

    let state = (*app.state::<Arc<crate::state::AppState>>()).clone();
    let mut admitted: Vec<sh::SharePrompt> = Vec::new();
    for (path, verdict) in candidates {
        let ready = match verdict {
            crate::incoming_share::IncomingVerdict::Ready(s) => s,
            crate::incoming_share::IncomingVerdict::Expired => {
                // 过期：静默删掉（留着只会一直失败）。
                let _ = std::fs::remove_file(&path);
                continue;
            }
            crate::incoming_share::IncomingVerdict::Malformed(why) => {
                eprintln!(
                    "[share] code={} 落地区文件不合规，丢弃：{}：{why}",
                    error_codes::EXTERNAL_SHARE_INCOMING_INVALID,
                    path.display()
                );
                let _ = std::fs::remove_file(&path);
                continue;
            }
            crate::incoming_share::IncomingVerdict::Unreadable(why) => {
                // 读不了可能是临时的（权限、占用）⇒ 文件**留着**，下次再扫。
                eprintln!(
                    "[share] code={} 落地区文件读不了（保留，下次再试）：{}：{why}",
                    error_codes::EXTERNAL_SHARE_INCOMING_UNREADABLE,
                    path.display()
                );
                continue;
            }
        };

        let prompt = sh::SharePrompt {
            // 队列里的 id 沿用深链那套 UUID 空间；落地区自己的 id 只用来对账与日志。
            share_id: uuid::Uuid::new_v4().to_string(),
            payload: ready.payload,
            received_at_ms: now_ms,
            expires_at_ms: now_ms + sh::PENDING_TTL_MS,
        };
        let result = {
            let mut map = state
                .external_share_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            sh::admit(&mut map, prompt, now_ms, sh::MAX_PENDING)
        };
        match result {
            Ok(p) => {
                // 入队成功才删文件（顺序反了会在崩溃时丢分享）。
                let _ = std::fs::remove_file(&path);
                admitted.push(p);
            }
            Err(e) => {
                // 队列满了：文件留着，等用户处理完再扫一次。
                eprintln!(
                    "[share] code={} 落地区分享入队失败（文件保留，下次再试）：{e}",
                    error_codes::EXTERNAL_SHARE_BUSY
                );
            }
        }
    }
    admitted
}

/// 上报**分享回执**（可选能力）：RP 想知道「到底发出去没有」。
///
/// 三条设计：
/// ① **回执体只含状态与条数**：会话名与分享内容**不回**（RP 不需要知道内容，
///    一个被冒充的端点也不该知道）。
/// ② **没有回执端点 ⇒ 直接回 false**，不是错误（与「没提供撤销端点」的既有口径一致）。
/// ③ 幂等键就是 `share_id` ⇒ 重复上报能被 RP 侧合并。
#[tauri::command(async)]
pub async fn share_report_receipt(
    state: State<'_, Arc<crate::state::AppState>>,
    share_id: String,
    status: String,
    sent: i64,
    failed: i64,
) -> Result<bool, String> {
    let state = (*state.inner()).clone();
    // 从队列里按 share_id 找回那条分享（回执端点存在它的载荷里）。
    let endpoint = {
        let map = state
            .external_share_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.values()
            .find(|p| p.share_id == share_id)
            .and_then(|p| p.payload.receipt_endpoint.clone())
    };
    let Some(endpoint) = endpoint else {
        // 没有回执端点（或这条已被清掉）⇒ 不上报，不是失败。
        return Ok(false);
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(SHARE_RECEIPT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            error_codes::coded(
                error_codes::EXTERNAL_SHARE_BUSY,
                format!("回执网络初始化失败：{e}"),
            )
        })?;
    let body = serde_json::json!({
        "share_id": share_id,
        "status": status,
        "sent": sent,
        "failed": failed,
    });
    let req = client
        .post(&endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        // 幂等键就是 share_id：重复上报能被 RP 侧合并成一次。
        .header("Idempotency-Key", share_id.clone())
        .body(body.to_string())
        .build()
        .map_err(|e| {
            error_codes::coded(
                error_codes::EXTERNAL_SHARE_BUSY,
                format!("构造回执请求失败：{e}"),
            )
        })?;
    match client.execute(req).await {
        Ok(resp) if resp.status().is_success() => Ok(true),
        Ok(resp) => {
            eprintln!(
                "[share] code={} 分享回执被拒：HTTP {}",
                error_codes::EXTERNAL_SHARE_BUSY,
                resp.status()
            );
            Ok(false)
        }
        Err(e) => {
            eprintln!(
                "[share] code={} 分享回执失败：{e}",
                error_codes::EXTERNAL_SHARE_BUSY
            );
            Ok(false)
        }
    }
}

/// 取当前待处理的分享（最新一条）。冷启动时前端拿不到「到达那一刻」的事件，靠这一条补拉。
///
/// 顺带扫一次系统分享目标的落地区：平台扩展写进来的文件也是「外部递进来的内容」，
/// 走同一条队列与同一个面板（用户仍要自己选会话、点发送）。
#[tauri::command(async)]
pub async fn share_get_pending(
    state: State<'_, Arc<crate::state::AppState>>,
) -> Result<Option<sh::SharePrompt>, String> {
    let state = (*state.inner()).clone();
    let now_ms = crate::logging::now_ms();
    tokio::task::spawn_blocking(move || {
        // ① 先扫落地区。扫不出来（没装扩展 / 目录不可读）只是没有，不影响本命令。
        let incoming = scan_incoming_shares(&state.app, now_ms);
        // ② 再取队列里最新的一条（落地区刚入队的那条也会被取到）。
        let newest = {
            let mut map = state
                .external_share_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            sh::newest_live(&mut map, now_ms)
        };
        // ③ 新到的那些也 emit 出去：面板立刻弹，不必等下一次轮询。
        for p in &incoming {
            let _ = state.app.emit("share-request", p);
        }
        newest
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

#[cfg(test)]
mod external_share_tests {
    use super::*;

    /// 定向目标的判定：**只认好友与已知群**，其余一律拒（fail closed）。
    #[test]
    fn target_is_known_only_accepts_friends_and_known_groups() {
        let friends = vec!["gosslan-peer-1".to_string(), "gosslan-peer-2".to_string()];
        let groups = vec!["g1".to_string()];

        // 单聊：命中好友。
        assert!(target_is_known("gosslan-peer-1", "peer", &friends, &groups));
        // 单聊：不认识 ⇒ 拒（绝不新建会话）。
        assert!(!target_is_known("gosslan-stranger", "peer", &friends, &groups));
        // 单聊：**不能**拿群 id 冒充。
        assert!(!target_is_known("g1", "peer", &friends, &groups));
        // 群：`group:` 前缀要剥掉再比。
        assert!(target_is_known("group:g1", "group", &friends, &groups));
        assert!(!target_is_known("group:g2", "group", &friends, &groups));
        // 群：**不能**拿好友 device_id 冒充。
        assert!(!target_is_known("gosslan-peer-1", "group", &friends, &groups));
        // 未知种类 ⇒ 拒。
        assert!(!target_is_known("gosslan-peer-1", "everyone", &friends, &groups));
    }
}
