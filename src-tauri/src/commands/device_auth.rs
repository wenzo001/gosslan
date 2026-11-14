// 职责边界：
// - 外部应用设备认证命令层（Phase 2）：深链处理、确认/拒绝、授权清单/撤销。
// - 协议核心在 crate::device_auth；RP 绑定 CRUD 在 crate::db（db/device_auth.rs）。
// ---------------- 外部应用设备认证（2026-11-13，Phase 2） ----------------
//
// Gosslan 是本地设备确认器，不是中心账号方。安全边界（设计文档 §6）：
// - 来源/端点只信 HTTPS 同源 metadata；reqwest 用 Policy::none() **不跟随任何重定向**。
// - 待确认事务内存态、cap 4、过期清除 + 本地 TTL 兜底、复合键 + 代际（#8）；批准与拒绝都
//   **RP 回写 2xx 后**才消费（失败可重试，#1），同一 RP 的多个批准排队依次处理；满载拒新事务
//   不淘汰；拒绝以 `rp_notified` 区分本机已拒绝 / RP 已收到拒绝。
// - RP 私钥的生成/编码/签名都收在 `crypto::RpKey` 能力封装内（#3，INV-P18 延伸）：命令层与
//   协议层只拿公钥面与能力，落库导出只许持久化那一家（db/device_auth.rs）；命令返回值/事件
//   只含公钥面与断言结果，绝不带私钥。
// - 本流程不触好友/传输/身份锚点。

use crate::device_auth as da;
use crate::error_codes;
use std::future::Future;
use std::sync::atomic::Ordering;

/// 同时待确认事务上限（设计文档 §5：后台只保留有限个）。
const MAX_PENDING_DEVICE_AUTH: usize = 4;
/// RP JSON 响应字节上限（流式累计，防无 Content-Length 的超大响应撑爆内存）。
const MAX_RP_JSON_BYTES: usize = 64 * 1024;
/// RP 网络请求超时。
const RP_TIMEOUT_SECS: u64 = 10;

// 本任务新增的错误码：按硬性边界，**定义在命令层内部**，不改全局 `error_codes.rs`
// （那张表由 `errors.test.ts` 与前端 `CODE_RULES` 双向对账，本任务无权改动）。需主任务登记。
/// 待确认队列已满：拒绝新事务、明确「暂不能处理」，不静默淘汰、不顶掉已有确认页。
const CODE_DEVICE_AUTH_BUSY: &str = "DEVICE_AUTH_BUSY";
/// 拒绝回写 RP 失败：本机已拒绝、RP 未收到（进日志，结果由 `rp_notified=false` 上报前端）。
const CODE_DENY_NOTIFY_FAILED: &str = "DEVICE_AUTH_DENY_NOTIFY_FAILED";

/// RP 专用 HTTPS 客户端：**不跟随重定向**（防跨域凭据转发 / open redirect / SSRF）。
fn rp_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(RP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("网络初始化失败：{e}")))
}

/// 流式拉取并解析 JSON（累计到上限即中止，与 external_links 导入同口径）。
async fn fetch_rp_json<T: serde::de::DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T, String> {
    let mut resp = client.get(url).send().await
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("拉取失败：{e}")))?;
    if !resp.status().is_success() {
        // Policy::none() 下 3xx 也走这里 ⇒ 不跟随跨域跳转，直接拒。
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("RP 返回 HTTP {}", resp.status())));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取失败：{e}")))? {
        if bytes.len() + chunk.len() > MAX_RP_JSON_BYTES {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_BAD_METADATA, "RP 响应超过大小上限"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| error_codes::coded(error_codes::DEVICE_AUTH_BAD_METADATA, "RP 响应不是合法 JSON"))
}

/// 构造 decision 回写请求（**纯函数，不发送**），便于单测校验 `Idempotency-Key` 头。
/// 生产回写与测试校验共用这一处构造，避免「测试构造一套、实际发另一套」。
fn decision_request(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    idempotency_key: &str,
) -> Result<reqwest::Request, String> {
    // reqwest 未开 json feature：手动序列化 + 显式 Content-Type（不引入新依赖特性）。
    client.post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("Idempotency-Key", idempotency_key)
        .body(body.to_string())
        .build()
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("构造回写请求失败：{e}")))
}

/// 回写 decision（approve/deny）到 RP。非 2xx 视为失败。
///
/// `idempotency_key` 作为 `Idempotency-Key` 请求头随每次回写发送，且跨重试**恒定不变**：
/// RP 据此把同一决策的网络重试合并成一次（不重复登记公钥 / 建会话），不再只靠 RP 自己
/// 猜幂等（就绪度审计 §4 idempotency key）。值就是该事务断言里的 `jti`。
/// `client.execute` 与 `RequestBuilder::send` 走同一条 `execute_request`，仍套用
/// `Policy::none()` 的不跟随重定向与超时配置。
async fn post_decision(
    client: &reqwest::Client,
    url: &str,
    body: &serde_json::Value,
    idempotency_key: &str,
) -> Result<(), String> {
    let req = decision_request(client, url, body, idempotency_key)?;
    let resp = client.execute(req).await
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("回写失败：{e}")))?;
    if !resp.status().is_success() {
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("RP 回写返回 HTTP {}", resp.status())));
    }
    Ok(())
}

/// 内部行 → 前端清单条目（**只公钥面**，丢弃 secret_key，INV-P18）。
fn binding_to_info(b: &crate::db::RpBindingRow) -> da::RpBindingInfo {
    let scopes = serde_json::from_str::<Vec<String>>(&b.scopes).unwrap_or_default();
    da::RpBindingInfo {
        rp_origin: b.rp_origin.clone(),
        client_id: b.client_id.clone(),
        display_name: b.display_name.clone(),
        kid: b.kid.clone(),
        public_key: b.public_key.clone(),
        pairwise_subject: b.pairwise_subject.clone(),
        scopes,
        status: b.status.clone(),
        created_at: b.created_at,
        last_used_at: b.last_used_at,
        revoked_at: b.revoked_at,
    }
}

/// 读/建绑定并签断言（**非命令 helper**：私钥在此本地解码使用，命令体只拿回断言串）。
///
/// 返回 (assertion, 公钥面清单条目, 批准 claims)。link 首绑生成 RP 专属密钥；已有 active
/// 绑定幂等复用；撤销态绑定不许静默覆盖（须先在 RP 解绑）。authenticate 必须有 active 绑定。
fn prepare_assertion(
    conn: &rusqlite::Connection,
    pending: &da::PendingDeviceAuth,
    allow_nickname: bool,
    now_ms: i64,
) -> Result<(String, da::RpBindingInfo, serde_json::Value), String> {
    let meta = &pending.meta;
    let req = &pending.request;
    let origin = &pending.rp_origin;
    let existing = crate::db::get_binding(conn, origin, &meta.client_id)
        .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取绑定失败：{e}")))?;

    let row = match (req.action.as_str(), existing) {
        ("link", Some(b)) if b.status == "revoked" => {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_BINDING_EXISTS, "该应用已有撤销态绑定，须先在其账号页解绑再重新绑定"));
        }
        // 已有绑定（active / pending_registration / registration_failed）一律复用同一密钥，
        // 不重复 insert。首绑分叉修复后：回写失败落 registration_failed 的重试、以及幂等
        // 重绑都走这里，签名后由回写结果再决定激活（见 activate_binding）。
        ("link", Some(b)) => b,
        ("link", None) => {
            // 私钥的生成/编码/落库都在 crypto 能力封装 + 持久化路径内（#3）：
            // 命令层只拿公钥面（public_b64/kid/subject）与能力 `key`，绝不触碰 secret 字节。
            let (key, public_b64, kid, subject) = da::generate_rp_key();
            let scopes = serde_json::to_string(&req.requested_claims).unwrap_or_else(|_| "[]".into());
            crate::db::insert_rp_binding(
                conn, origin, &meta.client_id, &meta.display_name,
                &key, public_b64, kid, subject, scopes, now_ms,
            )
            .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("写入绑定失败：{e}")))?
        }
        ("authenticate", Some(b)) if b.status == "active" => {
            crate::db::touch_last_used(conn, origin, &meta.client_id, now_ms)
                .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("更新绑定失败：{e}")))?;
            b
        }
        // 待登记 / 登记失败的绑定**不是 active**：绝不能拿它直接签名发断言（就绪度审计 §3.3
        // 要求 get_binding 的中间态分支正确处理）。给出明确「未完成登记」错误，复用既有码。
        ("authenticate", Some(b))
            if b.status == "pending_registration" || b.status == "registration_failed" =>
        {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_NO_BINDING, "绑定尚未完成 RP 登记，请重新绑定或重试"));
        }
        ("authenticate", Some(_)) => {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_BINDING_REVOKED, "绑定已撤销，请重新绑定"));
        }
        ("authenticate", None) => {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_NO_BINDING, "尚未绑定该应用，请先绑定"));
        }
        _ => return Err(error_codes::coded(error_codes::DEVICE_AUTH_UNSUPPORTED, "不支持的动作")),
    };

    // jti = 事务幂等键：重试复用同一个值，不每次换新（见 sign_assertion / post_decision）。
    let assertion = da::sign_with_binding(
        &row.secret_key, &row.kid, &row.pairwise_subject, meta, req, now_ms / 1000,
        &pending.idempotency_key,
    )?;

    // 批准 claims：subject/公钥恒在断言里；昵称仅用户主动允许且 RP 请求时才共享。
    let mut claims = serde_json::Map::new();
    if allow_nickname && req.requested_claims.iter().any(|c| c == "nickname") {
        if let Some(nick) = crate::db::get_setting(conn, "nickname") {
            claims.insert("nickname".into(), json!(nick));
        }
    }
    Ok((assertion, binding_to_info(&row), serde_json::Value::Object(claims)))
}

/// 处理授权深链：解析 → 拉 metadata/请求 → 校验 → 存待确认 → 唤起主窗并 emit 确认页数据。
#[tauri::command(async)]
pub async fn device_auth_handle_link(
    state: State<'_, Arc<crate::state::AppState>>,
    url: String,
) -> Result<da::DeviceAuthPrompt, String> {
    handle_device_auth_link(&state.inner().app, url).await
}

/// 深链回调 / 冷启动用：spawn 处理，失败留痕（不阻断启动/前台）。
///
/// 唯一的调用点都在 `lib.rs` 的 `#[cfg(desktop)]` 里（单实例转发 / `on_open_url` / 冷启动
/// argv）⇒ 移动端暂时没人调。**保留入口而不是 cfg 掉**：移动端链接交接是下一阶段要接的
/// 骨架（契约文档 §6/§10），到那天由插件的 mobile 回调调它，而不是重新写一份。
#[cfg_attr(not(desktop), allow(dead_code))]
pub fn spawn_device_auth_link(app: tauri::AppHandle, url: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = handle_device_auth_link(&app, url).await {
            eprintln!("[device-auth] 深链处理失败：{e}");
        }
    });
}

/// 从启动参数里挑出授权深链（冷启动唤起）；只认 gosslan:// 与 https app link 形态。
/// 解析合法性留给 `handle_device_auth_link`（这里只做粗筛，避免把普通启动参数当深链）。
#[cfg_attr(not(desktop), allow(dead_code))]
pub fn authorize_link_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| {
        a.starts_with("gosslan://authorize/") || (a.starts_with("https://") && a.contains("/authorize/"))
    }).cloned()
}

/// 深链入口核心逻辑（命令 / 深链回调 / 冷启动共用）。从 AppHandle 取状态。
pub async fn handle_device_auth_link(app: &tauri::AppHandle, url: String) -> Result<da::DeviceAuthPrompt, String> {
    let s = app.state::<Arc<crate::state::AppState>>().inner().clone();
    let link = da::parse_authorize_link(&url)?;
    let client = rp_client()?;

    let meta_url = format!("{}/.well-known/gosslan-device-auth", link.rp_origin);
    let meta: da::RpMetadata = fetch_rp_json(&client, &meta_url).await?;
    da::validate_metadata(&meta, &link.rp_origin)?;

    let req_url = meta.request_endpoint.replace("{request_id}", &link.request_ref);
    let req: da::RpRequest = fetch_rp_json(&client, &req_url).await?;
    if req.request_id != link.request_ref {
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_BAD_REQUEST, "request_id 与链接引用不一致"));
    }
    let now_ms = crate::db::now_ms();
    // 本地 TTL 兜底：取 RP expires_at 与「插入后固定上限」的较早者。
    let expires_at_ms = da::clamp_pending_expiry(da::validate_request(&req, &meta, now_ms)?, now_ms);

    let generation = s.device_auth_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let key = da::pending_key(&link.rp_origin, &meta.client_id, &req.request_id);
    let pending = da::PendingDeviceAuth {
        meta,
        request: req,
        rp_origin: link.rp_origin,
        expires_at_ms,
        generation,
        // 每个事务生成一次，随内存态持久化：prepare 的 jti 与 post 的 Idempotency-Key 都读它。
        idempotency_key: uuid::Uuid::new_v4().to_string(),
    };
    let prompt = pending.prompt();
    {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        // 满载返回明确错误（不淘汰、不顶掉已有确认页）；返回 Err 时下面的 emit 不会执行。
        admit_pending(&mut map, key, pending, now_ms, MAX_PENDING_DEVICE_AUTH)?;
    }
    if let Some(w) = s.app.get_webview_window(crate::WINDOW_MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = s.app.emit("device-auth-request", &prompt);
    Ok(prompt)
}

/// 取（或建）同一 RP 的排队锁（#1）：同 RP 的多个批准依次处理，不同 RP 并行。
fn rp_queue_lock(
    locks: &std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    queue_key: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    locks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(queue_key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 待确认队列**准入**（纯逻辑，便于单测）：先惰性清理过期项，再判断能否接纳新事务。
///
/// 满载时**拒绝新事务并留 `code=` 日志**，绝不静默淘汰最老一条 —— 旧写法会把用户正在看的
/// 确认页顶掉，且没有任何反馈（就绪度审计 §3.3 队列边界）。同键重插（同一事务重新发起）
/// 不占新槽位，始终允许：它只替换，不把别的事务挤出去。
fn admit_pending(
    map: &mut std::collections::HashMap<String, da::PendingDeviceAuth>,
    key: String,
    pending: da::PendingDeviceAuth,
    now_ms: i64,
    max: usize,
) -> Result<(), String> {
    map.retain(|_, p| p.expires_at_ms > now_ms);
    if !map.contains_key(&key) && map.len() >= max {
        let err = error_codes::coded(CODE_DEVICE_AUTH_BUSY, "暂不能处理，请稍后重试（待确认事务已达上限）");
        eprintln!("[device-auth] {err}");
        return Err(err);
    }
    map.insert(key, pending);
    Ok(())
}

/// 读取待确认事务并**在读取时清理到明确终态**：过期项直接移除（不再无限期挂内存），
/// 返回该键当前有效的事务克隆，不消费。缺失/过期分别给明确错误码（就绪度审计 §4 最大 TTL）。
///
/// `missing_code` 由调用方给：批准/拒绝路径沿用 `DEVICE_AUTH_REPLAYED`，确认页拉取沿用
/// `DEVICE_AUTH_NOT_FOUND`，保持既有语义。
fn read_live_pending(
    map: &std::sync::Mutex<std::collections::HashMap<String, da::PendingDeviceAuth>>,
    key: &str,
    now_ms: i64,
    missing_code: &'static str,
    missing_msg: &str,
) -> Result<da::PendingDeviceAuth, String> {
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    if map.get(key).is_some_and(|p| p.expires_at_ms <= now_ms) {
        map.remove(key);
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
    }
    map.get(key)
        .cloned()
        .ok_or_else(|| error_codes::coded(missing_code, missing_msg))
}

/// 批准编排收尾：按 RP 回写结果迁移首绑状态。整笔成功（内含 post 2xx）才把「待登记」推进到
/// active；任何失败/超时落 registration_failed（保留同一密钥、可重试、不重复 insert）。
///
/// 为什么单独一步：DB 写要 `spawn_blocking`，且必须在 `run_approval` 给出最终结局之后，
/// 才能把「post 成功」和「active」严格绑定（就绪度审计 §3.2 目标不变式）。
async fn settle_binding_after_post(
    s: Arc<crate::state::AppState>,
    rp_origin: String,
    client_id: String,
    post_ok: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let r = if post_ok {
            crate::db::activate_binding(&dbc, &rp_origin, &client_id)
        } else {
            crate::db::mark_registration_failed(&dbc, &rp_origin, &client_id)
        };
        r.map(|_| ()).map_err(|e| {
            error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("绑定状态迁移失败：{e}"))
        })
    })
    .await
    .map_err(|e| {
        error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("绑定状态迁移任务中断：{e}"))
    })?
}

/// 排队拿到锁后**复核**事务仍在且代际一致（#1/#8）：被消费/清数据/同键重插 ⇒ 放弃旧批准。
/// 只克隆不消费——消费要等 RP 回写 2xx 之后（见 `consume_pending_if`）。
fn recheck_pending(
    map: &std::sync::Mutex<std::collections::HashMap<String, da::PendingDeviceAuth>>,
    key: &str,
    generation: u64,
    now_ms: i64,
) -> Result<da::PendingDeviceAuth, String> {
    let map = map.lock().unwrap_or_else(|e| e.into_inner());
    let p = map.get(key).ok_or_else(|| {
        error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在")
    })?;
    if p.generation != generation {
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务代际已变更"));
    }
    if p.expires_at_ms <= now_ms {
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
    }
    Ok(p.clone())
}

/// RP 回写 2xx 后**才真正消费**事务（#1）：仅当键仍在且代际一致才移除（防误删新事务）。
/// 返回是否真的消费了一条。POST 失败时调用方不调它 ⇒ 事务保留可重试态。
fn consume_pending_if(
    map: &std::sync::Mutex<std::collections::HashMap<String, da::PendingDeviceAuth>>,
    key: &str,
    generation: u64,
) -> bool {
    let mut map = map.lock().unwrap_or_else(|e| e.into_inner());
    match map.get(key) {
        Some(p) if p.generation == generation => {
            map.remove(key);
            true
        }
        _ => false,
    }
}

/// 批准的可重试编排（#1）：排队 → 复核 → 签名(prepare) → 回写 RP(post) → **2xx 后才消费**。
/// prepare/post 注入为闭包，便于单测用桩替换签名与网络（不依赖 AppState/真实 RP）。
/// post 失败 ⇒ 直接返回 Err 且**不消费**事务（保留可重试态，不丢事务、不假授权）。
#[allow(clippy::too_many_arguments)] // 状态引用 + 注入的 prepare/post 闭包：打包成结构体反而把可单测的编排藏起来
async fn run_approval<PF, QF>(
    map: &std::sync::Mutex<std::collections::HashMap<String, da::PendingDeviceAuth>>,
    locks: &std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    key: &str,
    generation: u64,
    queue_key: &str,
    now_ms: i64,
    prepare: impl FnOnce(da::PendingDeviceAuth) -> PF,
    post: impl FnOnce(serde_json::Value) -> QF,
) -> Result<(), String>
where
    PF: Future<Output = Result<serde_json::Value, String>>,
    QF: Future<Output = Result<(), String>>,
{
    let lock = rp_queue_lock(locks, queue_key);
    let _guard = lock.lock().await;
    let pending = recheck_pending(map, key, generation, now_ms)?;
    let body = prepare(pending).await?;
    post(body).await?;
    consume_pending_if(map, key, generation);
    Ok(())
}

/// 清数据时一并清掉设备认证待确认事务并推进代际（#8）：清库路径（`clear_all_data`）必须调它，
/// 否则清完数据后旧确认页/排队批准仍能复活已清事务。代际 +1 让任何在途批准对账失败。
pub fn clear_device_auth_pending(
    map: &std::sync::Mutex<std::collections::HashMap<String, da::PendingDeviceAuth>>,
    generation: &std::sync::atomic::AtomicU64,
) {
    map.lock().unwrap_or_else(|e| e.into_inner()).clear();
    generation.fetch_add(1, Ordering::Relaxed);
}

/// 取某条待确认事务的确认页数据（前端弹窗打开时拉一次）。复合键定位（#8）。
#[tauri::command(async)]
pub async fn device_auth_get_pending(
    state: State<'_, Arc<crate::state::AppState>>,
    rp_origin: String,
    client_id: String,
    request_id: String,
) -> Result<da::DeviceAuthPrompt, String> {
    let s = state.inner().clone();
    let key = da::pending_key(&rp_origin, &client_id, &request_id);
    tokio::task::spawn_blocking(move || {
        let pending = read_live_pending(
            &s.device_auth_pending,
            &key,
            crate::db::now_ms(),
            error_codes::DEVICE_AUTH_NOT_FOUND,
            "待确认事务不存在或已清除",
        )?;
        Ok(pending.prompt())
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取任务被中断：{e}")))?
}

/// 用户批准（可重试，#1）：排队 → 复核 → 读/建绑定并签名 → 回写 RP → **2xx 后才消费**事务。
/// 同一 RP 的多个批准排队依次处理（不是单飞拒绝）；POST 失败保留可重试态（不丢事务、不假授权）。
/// 首绑在 prepare 只落 `pending_registration`，整笔成功（含 RP 2xx）后才 `active`（见下方收尾）。
#[tauri::command(async)]
pub async fn device_auth_approve(
    state: State<'_, Arc<crate::state::AppState>>,
    rp_origin: String,
    client_id: String,
    request_id: String,
    allow_nickname: bool,
) -> Result<da::DeviceAuthOutcome, String> {
    let s = state.inner().clone();
    let key = da::pending_key(&rp_origin, &client_id, &request_id);
    let queue_key = da::rp_queue_key(&rp_origin, &client_id);
    // 先读一次（不消费，顺带清理过期）：拿代际 / meta / 幂等键。真正的消费在 RP 2xx 之后。
    let (generation, meta, idempotency_key) = {
        let p = read_live_pending(
            &s.device_auth_pending, &key, crate::db::now_ms(),
            error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在",
        )?;
        (p.generation, p.meta.clone(), p.idempotency_key.clone())
    };

    let s_db = s.clone();
    let decision_url = meta.decision_endpoint.replace("{request_id}", &request_id);
    let approval = run_approval(
        &s.device_auth_pending,
        &s.device_auth_rp_locks,
        &key,
        generation,
        &queue_key,
        crate::db::now_ms(),
        move |pending| async move {
            let prepared = tokio::task::spawn_blocking(move || {
                let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
                prepare_assertion(&dbc, &pending, allow_nickname, crate::db::now_ms())
            })
            .await
            .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("签名任务被中断：{e}")))??;
            let (assertion, info, claims) = prepared;
            Ok(json!({
                "decision": "approve",
                "key_id": info.kid,
                "public_key": info.public_key,
                "device_subject": info.pairwise_subject,
                "claims": claims,
                "assertion": assertion,
            }))
        },
        move |body| async move {
            let client = rp_client()?;
            // Idempotency-Key 与断言 jti 同源：重试发同一个值，RP 可合并重复回写。
            post_decision(&client, &decision_url, &body, &idempotency_key).await
        },
    )
    .await;

    // 严格绑定「post 2xx」与「active」：整笔成功才激活首绑，失败/超时落 registration_failed。
    // run_approval 为 Ok 即代表回写 2xx 且已消费；为 Err 则事务保留可重试态。
    let post_ok = approval.is_ok();
    if let Err(e) = settle_binding_after_post(
        s.clone(), rp_origin.clone(), meta.client_id.clone(), post_ok,
    ).await {
        eprintln!("[device-auth] {e}");
    }
    approval?;

    Ok(da::DeviceAuthOutcome {
        decision: "approved".into(),
        rp_origin,
        client_id: meta.client_id.clone(),
        display_name: meta.display_name.clone(),
        rp_notified: true,
    })
}

/// 拒绝回写的 **settlement**（纯函数，便于单测）：返回「是否消费事务」与上报给前端的结果。
///
/// 只有 RP 2xx 确认收到拒绝（`rp_notified=true`）才消费事务；失败保留可重试态，前端据
/// `rp_notified=false` 显示重试入口。`decision` 恒为 `denied`（保持既有兼容语义）。
/// 把「消费决策」抽成纯函数，是为了让「失败可重试」这条语义能被单测直接钉住，而不依赖 AppState。
fn settle_deny(
    pending: &da::PendingDeviceAuth,
    rp_origin: String,
    rp_notified: bool,
) -> (bool, da::DeviceAuthOutcome) {
    let outcome = da::DeviceAuthOutcome {
        decision: "denied".into(),
        rp_origin,
        client_id: pending.meta.client_id.clone(),
        display_name: pending.meta.display_name.clone(),
        rp_notified,
    };
    (rp_notified, outcome)
}

/// 用户拒绝：读事务（不消费）→ 回写 deny → **仅 RP 2xx 后才消费**，并上报回写结果。复合键定位（#8）。
///
/// 旧实现先 remove 再丢弃回写结果，恒回 `decision: "denied"`：本机已拒绝 / RP 已收到拒绝
/// 不可区分、失败无重试。现在 `rp_notified=false` 表示「本机已拒绝、RP 未收到」，事务保留可重试，
/// 前端据此显示重试入口；`decision` 保持 `denied` 兼容语义不变（就绪度审计 §4 拒绝可观察）。
#[tauri::command(async)]
pub async fn device_auth_deny(
    state: State<'_, Arc<crate::state::AppState>>,
    rp_origin: String,
    client_id: String,
    request_id: String,
) -> Result<da::DeviceAuthOutcome, String> {
    let s = state.inner().clone();
    let key = da::pending_key(&rp_origin, &client_id, &request_id);
    // 队列读 + 时钟读数本身是内存操作（不碰 SQLite），但命令体里出现 `db::` 这个时钟别名
    // 会让 R-18「重活留在 tokio worker 上的命令只许降」把它算成重活命令。该判据指定的补救
    // 是进阻塞池，不是调大上限；与同文件 `device_auth_list_bindings` / `settle_binding_after_post`
    // 保持同一形状。真实收益：`read_live_pending` 要抢的 std Mutex 可能正被并发的确认页操作持有。
    let read_s = s.clone();
    let read_key = key.clone();
    let pending = tokio::task::spawn_blocking(move || {
        read_live_pending(
            &read_s.device_auth_pending,
            &read_key,
            crate::db::now_ms(),
            error_codes::DEVICE_AUTH_REPLAYED,
            "事务已消费或不存在",
        )
    })
    .await
    .map_err(|e| {
        error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取待确认事务任务中断：{e}"))
    })??;
    let generation = pending.generation;
    let idempotency_key = pending.idempotency_key.clone();
    let decision_url = pending.meta.decision_endpoint.replace("{request_id}", &request_id);

    // 保留并上报回写结果，不再 `let _ =` 丢弃。网络初始化失败也归到「未收到」，不阻断本地拒绝。
    let post_result = match rp_client() {
        Ok(client) => {
            post_decision(&client, &decision_url, &json!({"decision": "deny"}), &idempotency_key).await
        }
        Err(e) => Err(e),
    };
    let notified = post_result.is_ok();
    if let Err(e) = &post_result {
        eprintln!("[device-auth] code={CODE_DENY_NOTIFY_FAILED} 拒绝回写失败，本机已拒绝、RP 未收到：{e}");
    }
    let (should_consume, outcome) = settle_deny(&pending, rp_origin, notified);
    // 只有 RP 确认收到拒绝才消费；失败保留可重试态（前端显示重试入口，重试复用同一幂等键）。
    if should_consume {
        consume_pending_if(&s.device_auth_pending, &key, generation);
    }
    Ok(outcome)
}

/// 已授权应用清单（含撤销态，前端可管理）。
#[tauri::command(async)]
pub async fn device_auth_list_bindings(
    state: State<'_, Arc<crate::state::AppState>>,
) -> Result<Vec<da::RpBindingInfo>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let rows = crate::db::list_bindings(&dbc)
            .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取授权清单失败：{e}")))?;
        Ok(rows.iter().map(binding_to_info).collect())
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取任务被中断：{e}")))?
}

/// 撤销某 RP 绑定（本地置撤销态；服务端解绑仍由 RP 账号页负责）。
#[tauri::command(async)]
pub async fn device_auth_revoke(
    state: State<'_, Arc<crate::state::AppState>>,
    rp_origin: String,
    client_id: String,
) -> Result<bool, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::db::revoke_binding(&dbc, &rp_origin, &client_id, crate::db::now_ms())
            .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("撤销失败：{e}")))
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("撤销任务被中断：{e}")))?
}

#[cfg(test)]
mod device_auth_cmd_tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};

    const ORIGIN: &str = "https://app.example.com";
    const CLIENT: &str = "com.example.product";

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE rp_device_bindings (
                rp_origin TEXT NOT NULL, client_id TEXT NOT NULL, display_name TEXT NOT NULL,
                kid TEXT NOT NULL, public_key TEXT NOT NULL, secret_key TEXT NOT NULL,
                pairwise_subject TEXT NOT NULL, scopes TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
                last_used_at INTEGER, revoked_at INTEGER, PRIMARY KEY (rp_origin, client_id));
             CREATE UNIQUE INDEX idx_rp_bindings_kid ON rp_device_bindings(kid);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        conn
    }

    fn pending(action: &str, claims: Vec<String>) -> da::PendingDeviceAuth {
        let meta = da::RpMetadata {
            protocol_version: "1".into(),
            client_id: CLIENT.into(),
            display_name: "示例".into(),
            issuer: ORIGIN.into(),
            request_endpoint: format!("{ORIGIN}/api/device-auth/requests/{{request_id}}"),
            decision_endpoint: format!("{ORIGIN}/api/device-auth/requests/{{request_id}}/decision"),
            poll_endpoint: String::new(),
            supported_actions: vec!["link".into(), "authenticate".into()],
            supported_claims: vec!["device_subject".into(), "device_public_key".into(), "nickname".into()],
        };
        let request = da::RpRequest {
            protocol_version: "1".into(),
            request_id: "req-1".into(),
            client_id: CLIENT.into(),
            issuer: ORIGIN.into(),
            display_name: "示例".into(),
            action: action.into(),
            account_hint: String::new(),
            requested_claims: claims,
            challenge: URL_SAFE_NO_PAD.encode([7u8; 32]),
            expires_at: "2099-01-01T00:00:00Z".into(),
        };
        da::PendingDeviceAuth {
            meta, request, rp_origin: ORIGIN.into(),
            expires_at_ms: 4_000_000_000_000, generation: 1,
            idempotency_key: "idempotency-key-for-test".into(),
        }
    }

    /// 首绑分叉判据（P1，名字沿用基线不许改）：prepare 后**只能**是 `pending_registration`，
    /// 只有模拟 RP 回写 2xx 成功（activate_binding）之后才是 `active`。
    #[test]
    fn link_creates_active_binding_and_signs() {
        let conn = test_db();
        let p = pending("link", vec!["device_subject".into(), "device_public_key".into()]);
        let (assertion, info, _claims) = prepare_assertion(&conn, &p, false, 1_000).unwrap();
        assert_eq!(info.status, "pending_registration", "回调前绝不提前写 active");
        assert!(!info.public_key.is_empty());
        assert_eq!(assertion.split('.').count(), 3, "JWS 三段");
        let b = crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap();
        assert_eq!(b.status, "pending_registration", "DB 行回调前也必须是待登记");
        // 模拟 RP 回写 2xx 成功后才激活。
        assert!(crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap());
        let b = crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap();
        assert_eq!(b.status, "active", "回写成功后才 active");
    }

    #[test]
    fn link_is_idempotent_reuses_key() {
        let conn = test_db();
        let p = pending("link", vec!["device_subject".into()]);
        let (_, info1, _) = prepare_assertion(&conn, &p, false, 1_000).unwrap();
        let (_, info2, _) = prepare_assertion(&conn, &p, false, 2_000).unwrap();
        assert_eq!(info1.kid, info2.kid, "重复 link 复用同一密钥，不静默轮换");
        assert_eq!(info1.pairwise_subject, info2.pairwise_subject);
    }

    #[test]
    fn authenticate_requires_active_binding() {
        let conn = test_db();
        let p = pending("authenticate", vec!["device_subject".into()]);
        let err = prepare_assertion(&conn, &p, false, 1_000).unwrap_err();
        assert!(err.contains("DEVICE_AUTH_NO_BINDING"));
    }

    #[test]
    fn authenticate_after_link_succeeds() {
        let conn = test_db();
        prepare_assertion(&conn, &pending("link", vec!["device_subject".into()]), false, 1_000).unwrap();
        // 首绑要 RP 回写 2xx 后才 active；authenticate 必须有 active 绑定。
        assert!(crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap());
        let (assertion, info, _) =
            prepare_assertion(&conn, &pending("authenticate", vec!["device_subject".into()]), false, 2_000).unwrap();
        assert_eq!(info.status, "active");
        assert_eq!(assertion.split('.').count(), 3);
    }

    #[test]
    fn revoked_binding_blocks_link_and_authenticate() {
        let conn = test_db();
        let link = pending("link", vec!["device_subject".into()]);
        prepare_assertion(&conn, &link, false, 1_000).unwrap();
        // 撤销只允许 active：先把待登记绑定激活（模拟回写 2xx），再撤销。
        assert!(crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap());
        crate::db::revoke_binding(&conn, ORIGIN, CLIENT, 2_000).unwrap();
        let err = prepare_assertion(&conn, &link, false, 3_000).unwrap_err();
        assert!(err.contains("DEVICE_AUTH_BINDING_EXISTS"), "撤销态不许静默覆盖");
        let err = prepare_assertion(&conn, &pending("authenticate", vec!["device_subject".into()]), false, 3_000).unwrap_err();
        assert!(err.contains("DEVICE_AUTH_BINDING_REVOKED"));
    }

    #[test]
    fn nickname_only_when_allowed_and_requested() {
        let conn = test_db();
        crate::db::set_setting(&conn, "nickname", "小院").unwrap();
        let p = pending("link", vec!["device_subject".into(), "nickname".into()]);
        let (_, _, claims_off) = prepare_assertion(&conn, &p, false, 1_000).unwrap();
        assert!(claims_off.get("nickname").is_none(), "默认不共享昵称");
        let (_, _, claims_on) = prepare_assertion(&conn, &p, true, 2_000).unwrap();
        assert_eq!(claims_on.get("nickname").unwrap().as_str().unwrap(), "小院");
    }

    // ---------------- P1 首绑状态机：pending_registration → active，失败落 registration_failed ----------------

    /// 回写失败落 registration_failed 后重试：复用同一密钥、不重复 insert，回写成功才 active。
    #[test]
    fn registration_failed_retry_reuses_key_and_can_activate() {
        let conn = test_db();
        let p = pending("link", vec!["device_subject".into()]);
        let (_, first, _) = prepare_assertion(&conn, &p, false, 1_000).unwrap();
        assert_eq!(first.status, "pending_registration");
        assert!(crate::db::mark_registration_failed(&conn, ORIGIN, CLIENT).unwrap());
        assert_eq!(
            crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status,
            "registration_failed"
        );
        // 重试：复用同一密钥，仍能签名（不会因中间态被当成新首绑重复 insert）。
        let (_, retry, _) = prepare_assertion(&conn, &p, false, 2_000).unwrap();
        assert_eq!(retry.kid, first.kid, "重试复用同一密钥");
        assert_eq!(retry.pairwise_subject, first.pairwise_subject);
        // 这次回写成功才激活。
        assert!(crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap());
        assert_eq!(crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status, "active");
        assert_eq!(crate::db::list_bindings(&conn).unwrap().len(), 1, "重试不重复 insert");
    }

    /// 只有中间态能推进到 active；已 active 幂等、已撤销不许被复活。
    #[test]
    fn activate_binding_only_promotes_intermediate_states() {
        let conn = test_db();
        prepare_assertion(&conn, &pending("link", vec![]), false, 1_000).unwrap();
        assert!(crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap());
        assert!(!crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap(), "已 active 幂等");
        crate::db::revoke_binding(&conn, ORIGIN, CLIENT, 3_000).unwrap();
        assert!(!crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap(), "撤销态不许复活");
        assert_eq!(crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status, "revoked");
    }

    /// 失败态只从 pending_registration 落，不许把 active 回退。
    #[test]
    fn mark_registration_failed_only_affects_pending() {
        let conn = test_db();
        prepare_assertion(&conn, &pending("link", vec![]), false, 1_000).unwrap();
        assert!(crate::db::mark_registration_failed(&conn, ORIGIN, CLIENT).unwrap());
        assert!(!crate::db::mark_registration_failed(&conn, ORIGIN, CLIENT).unwrap(), "已是失败态幂等");
        crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap();
        assert!(!crate::db::mark_registration_failed(&conn, ORIGIN, CLIENT).unwrap(), "active 不许回退");
        assert_eq!(crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status, "active");
    }

    /// 撤销只允许 active：待登记 / 登记失败的绑定不许被撤销。
    #[test]
    fn revoke_binding_only_allows_active() {
        let conn = test_db();
        prepare_assertion(&conn, &pending("link", vec![]), false, 1_000).unwrap();
        assert!(!crate::db::revoke_binding(&conn, ORIGIN, CLIENT, 2_000).unwrap(), "待登记不许撤销");
        assert_eq!(
            crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status,
            "pending_registration"
        );
        crate::db::activate_binding(&conn, ORIGIN, CLIENT).unwrap();
        assert!(crate::db::revoke_binding(&conn, ORIGIN, CLIENT, 3_000).unwrap(), "active 才允许撤销");
        assert_eq!(crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap().status, "revoked");
    }

    /// get_binding 中间态不许被当成 active 直接签名发断言（就绪度审计 §3.3）。
    #[test]
    fn authenticate_rejects_pending_registration_binding() {
        let conn = test_db();
        prepare_assertion(&conn, &pending("link", vec![]), false, 1_000).unwrap();
        let err = prepare_assertion(
            &conn, &pending("authenticate", vec!["device_subject".into()]), false, 2_000,
        ).unwrap_err();
        assert!(err.contains("DEVICE_AUTH_NO_BINDING"), "未完成登记的绑定绝不能签名发断言");
        assert!(err.contains("登记"), "错误信息要点明「尚未完成 RP 登记」");
    }

    // ---------------- P2 队列满载：拒新事务、不淘汰、不顶掉已有确认页 ----------------

    #[test]
    fn admit_pending_rejects_when_full_without_evicting() {
        let mut map: HashMap<String, da::PendingDeviceAuth> = HashMap::new();
        for i in 0..2 {
            let mut p = pending("link", vec![]);
            p.request.request_id = format!("req-{i}");
            map.insert(da::pending_key(ORIGIN, CLIENT, &format!("req-{i}")), p);
        }
        let oldest_key = da::pending_key(ORIGIN, CLIENT, "req-0");
        let new_key = da::pending_key(ORIGIN, CLIENT, "req-new");
        let mut new_p = pending("link", vec![]);
        new_p.request.request_id = "req-new".into();
        let err = admit_pending(&mut map, new_key.clone(), new_p, 1_000, 2).unwrap_err();
        assert!(err.contains("DEVICE_AUTH_BUSY"), "满载必须返回明确错误码");
        assert!(err.contains("暂不能处理"), "须含「暂不能处理，请稍后」语义");
        assert_eq!(map.len(), 2, "满载不淘汰、不插入新事务");
        assert!(map.contains_key(&oldest_key), "最老一条不许被静默淘汰（用户已有确认页不被顶掉）");
        assert!(!map.contains_key(&new_key), "被拒绝的新事务不许入库");
    }

    #[test]
    fn admit_pending_allows_same_key_reinsertion_when_full() {
        let mut map: HashMap<String, da::PendingDeviceAuth> = HashMap::new();
        for i in 0..2 {
            let mut p = pending("link", vec![]);
            p.request.request_id = format!("req-{i}");
            map.insert(da::pending_key(ORIGIN, CLIENT, &format!("req-{i}")), p);
        }
        let key = da::pending_key(ORIGIN, CLIENT, "req-0");
        let mut reissue = pending("link", vec![]);
        reissue.request.request_id = "req-0".into();
        reissue.generation = 9;
        admit_pending(&mut map, key.clone(), reissue, 1_000, 2).unwrap();
        assert_eq!(map.len(), 2, "同键重插只替换、不占新槽位");
        assert_eq!(map.get(&key).unwrap().generation, 9, "重插以新事务替换旧值");
    }

    #[test]
    fn admit_pending_cleans_expired_before_cap_check() {
        let mut map: HashMap<String, da::PendingDeviceAuth> = HashMap::new();
        for i in 0..2 {
            let mut p = pending("link", vec![]);
            p.request.request_id = format!("req-{i}");
            if i == 0 {
                p.expires_at_ms = 500; // 早于 now_ms=1_000 ⇒ 已过期
            }
            map.insert(da::pending_key(ORIGIN, CLIENT, &format!("req-{i}")), p);
        }
        let new_key = da::pending_key(ORIGIN, CLIENT, "req-new");
        let mut new_p = pending("link", vec![]);
        new_p.request.request_id = "req-new".into();
        admit_pending(&mut map, new_key.clone(), new_p, 1_000, 2).unwrap();
        assert!(!map.contains_key(&da::pending_key(ORIGIN, CLIENT, "req-0")), "过期项被惰性清理");
        assert!(map.contains_key(&new_key), "腾出槽位后新事务可接纳");
        assert_eq!(map.len(), 2);
    }

    // ---------------- P2 本地 TTL 兜底：读取时清理到明确终态 ----------------

    #[test]
    fn read_live_pending_reaps_expired_and_keeps_live() {
        let map = Mutex::new(HashMap::new());
        let live_key = da::pending_key(ORIGIN, CLIENT, "req-live");
        let dead_key = da::pending_key(ORIGIN, CLIENT, "req-dead");
        {
            let mut m = map.lock().unwrap();
            let mut live = pending("link", vec![]);
            live.request.request_id = "req-live".into();
            m.insert(live_key.clone(), live);
            let mut dead = pending("link", vec![]);
            dead.request.request_id = "req-dead".into();
            dead.expires_at_ms = 500; // 已过期
            m.insert(dead_key.clone(), dead);
        }
        let err = read_live_pending(&map, &dead_key, 1_000, error_codes::DEVICE_AUTH_NOT_FOUND, "不存在").err().unwrap();
        assert!(err.contains("DEVICE_AUTH_EXPIRED"));
        assert!(!map.lock().unwrap().contains_key(&dead_key), "过期项读取时清理到明确终态，不再无限期挂着");
        let p = read_live_pending(&map, &live_key, 1_000, error_codes::DEVICE_AUTH_NOT_FOUND, "不存在").unwrap();
        assert_eq!(p.request.request_id, "req-live");
        assert!(map.lock().unwrap().contains_key(&live_key), "读取不消费事务");
        let err = read_live_pending(&map, "missing", 1_000, error_codes::DEVICE_AUTH_NOT_FOUND, "不存在").err().unwrap();
        assert!(err.contains("DEVICE_AUTH_NOT_FOUND"), "缺失按调用方给的码");
    }

    // ---------------- P2 幂等键 + P1 拒绝可观察 ----------------

    /// 回写请求真的带 `Idempotency-Key` 头，且同一幂等键重试时该头恒定（行为级，非源码判据）。
    #[test]
    fn decision_request_carries_idempotency_key_header() {
        let client = reqwest::Client::builder().build().unwrap();
        let body = json!({"decision": "deny"});
        let url = "https://app.example.com/api/device-auth/requests/req-1/decision";
        let req = decision_request(&client, url, &body, "idem-abc-123").unwrap();
        assert_eq!(
            req.headers().get("Idempotency-Key").unwrap().to_str().unwrap(),
            "idem-abc-123",
            "回写必须带 Idempotency-Key 头（P2 幂等键）"
        );
        assert_eq!(req.headers().get(reqwest::header::CONTENT_TYPE).unwrap(), "application/json");
        // 同一幂等键重试 ⇒ 头一致，RP 可据以合并重复回写。
        let req2 = decision_request(&client, url, &body, "idem-abc-123").unwrap();
        assert_eq!(req.headers().get("Idempotency-Key"), req2.headers().get("Idempotency-Key"));
    }

    /// 拒绝 settlement（P1）：本机已拒绝 / RP 已收到拒绝可区分，且失败保留可重试态。
    #[test]
    fn settle_deny_distinguishes_local_denial_from_rp_ack() {
        let map = Mutex::new(HashMap::new());
        let key = da::pending_key(ORIGIN, CLIENT, "req-1");
        map.lock().unwrap().insert(key.clone(), pending("link", vec![]));

        // RP 未收到拒绝：本机已拒绝、不消费事务（可重试），前端据 rp_notified=false 显示重试入口。
        let (consume_fail, out_fail) = settle_deny(&pending("link", vec![]), ORIGIN.into(), false);
        if consume_fail {
            consume_pending_if(&map, &key, 1);
        }
        assert!(!consume_fail, "RP 未收到 ⇒ 不消费");
        assert!(map.lock().unwrap().contains_key(&key), "失败必须保留可重试态");
        assert_eq!(out_fail.decision, "denied", "保持既有 decision 兼容语义");
        assert!(!out_fail.rp_notified, "前端据此显示重试入口");

        // RP 2xx 确认收到拒绝：消费事务（一次性），rp_notified=true。
        let (consume_ok, out_ok) = settle_deny(&pending("link", vec![]), ORIGIN.into(), true);
        if consume_ok {
            consume_pending_if(&map, &key, 1);
        }
        assert!(consume_ok, "RP 已收到 ⇒ 消费");
        assert!(!map.lock().unwrap().contains_key(&key), "成功后一次性消费");
        assert_eq!(out_ok.decision, "denied");
        assert!(out_ok.rp_notified);
        assert_eq!(out_ok.client_id, CLIENT);
        assert_eq!(out_ok.rp_origin, ORIGIN);
    }

    // ---------------- #1 可重试批准 + 同 RP 排队 ----------------

    /// 反例自证（#1 核心）：RP 回写失败时**绝不消费**事务 —— 保留可重试态，不丢事务、不假授权。
    /// 把「先消费再回写」的旧写法搬回来，这条立刻红。
    #[tokio::test]
    async fn approve_keeps_pending_retryable_on_post_failure() {
        let map = Mutex::new(HashMap::new());
        let locks = Mutex::new(HashMap::new());
        let p = pending("link", vec!["device_subject".into()]);
        let key = da::pending_key(ORIGIN, CLIENT, "req-1");
        map.lock().unwrap().insert(key.clone(), p.clone());
        let err = run_approval(
            &map, &locks, &key, p.generation, &da::rp_queue_key(ORIGIN, CLIENT), 1_000,
            |_| async { Ok(json!({"decision": "approve"})) },
            |_| async { Err(error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, "回写失败")) },
        ).await.unwrap_err();
        assert!(err.contains("DEVICE_AUTH_NETWORK"));
        assert!(map.lock().unwrap().contains_key(&key), "POST 失败必须保留可重试态，不丢事务");
    }

    /// RP 回写 2xx 后**才**消费事务（一次性，防重放）。
    #[tokio::test]
    async fn approve_consumes_pending_only_after_post_success() {
        let map = Mutex::new(HashMap::new());
        let locks = Mutex::new(HashMap::new());
        let p = pending("link", vec!["device_subject".into()]);
        let key = da::pending_key(ORIGIN, CLIENT, "req-1");
        map.lock().unwrap().insert(key.clone(), p.clone());
        run_approval(
            &map, &locks, &key, p.generation, &da::rp_queue_key(ORIGIN, CLIENT), 1_000,
            |_| async { Ok(json!({"decision": "approve"})) },
            |_| async { Ok(()) },
        ).await.unwrap();
        assert!(!map.lock().unwrap().contains_key(&key), "RP 2xx 后才消费事务");
    }

    /// 代际对账（#8）：事务被同键重插（代际推进）后，旧在途批准必须放弃，且不消费现有事务。
    #[tokio::test]
    async fn approve_rejects_stale_generation() {
        let map = Mutex::new(HashMap::new());
        let locks = Mutex::new(HashMap::new());
        let p = pending("link", vec!["device_subject".into()]); // generation = 1
        let key = da::pending_key(ORIGIN, CLIENT, "req-1");
        map.lock().unwrap().insert(key.clone(), p.clone());
        let err = run_approval(
            &map, &locks, &key, 0, &da::rp_queue_key(ORIGIN, CLIENT), 1_000,
            |_| async { Ok(json!({})) },
            |_| async { Ok(()) },
        ).await.unwrap_err();
        assert!(err.contains("DEVICE_AUTH_REPLAYED"));
        assert!(map.lock().unwrap().contains_key(&key), "代际不符不许消费现有事务");
    }

    /// 清数据后在途批准对账失败（#8）：清表 + 推进代际 ⇒ 排队中的批准不再回写已清事务。
    #[tokio::test]
    async fn approve_after_data_cleared_is_rejected() {
        let map = Mutex::new(HashMap::new());
        let locks = Mutex::new(HashMap::new());
        let gen = AtomicU64::new(1);
        let p = pending("link", vec!["device_subject".into()]);
        let key = da::pending_key(ORIGIN, CLIENT, "req-1");
        map.lock().unwrap().insert(key.clone(), p.clone());
        clear_device_auth_pending(&map, &gen);
        assert!(map.lock().unwrap().is_empty());
        let err = run_approval(
            &map, &locks, &key, p.generation, &da::rp_queue_key(ORIGIN, CLIENT), 1_000,
            |_| async { Ok(json!({})) },
            |_| async { Ok(()) },
        ).await.unwrap_err();
        assert!(err.contains("DEVICE_AUTH_REPLAYED"), "清数据后在途批准必须对账失败");
    }

    /// 同一 RP 的多个批准**排队依次处理**（#1，用户选定排队而非单飞拒绝）：
    /// 两条事务并发批准，回写期间在途数恒为 1（绝不重叠）。把排队锁去掉即红。
    #[tokio::test]
    async fn same_rp_approvals_serialize() {
        use std::sync::atomic::AtomicUsize;
        let map = Mutex::new(HashMap::new());
        let locks = Mutex::new(HashMap::new());
        let inflight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        for rid in ["req-a", "req-b"] {
            let mut p = pending("link", vec!["device_subject".into()]);
            p.request.request_id = rid.into();
            map.lock().unwrap().insert(da::pending_key(ORIGIN, CLIENT, rid), p);
        }
        let qk = da::rp_queue_key(ORIGIN, CLIENT);
        let key_a = da::pending_key(ORIGIN, CLIENT, "req-a");
        let key_b = da::pending_key(ORIGIN, CLIENT, "req-b");
        let make_post = || {
            let inf = inflight.clone();
            let mx = max_seen.clone();
            move |_| {
                let inf = inf.clone();
                let mx = mx.clone();
                async move {
                    let n = inf.fetch_add(1, Ordering::SeqCst) + 1;
                    mx.fetch_max(n, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    inf.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        };
        let (a, b) = tokio::join!(
            run_approval(&map, &locks, &key_a, 1, &qk, 1_000,
                |_| async { Ok(json!({})) }, make_post()),
            run_approval(&map, &locks, &key_b, 1, &qk, 1_000,
                |_| async { Ok(json!({})) }, make_post()),
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(max_seen.load(Ordering::SeqCst), 1, "同一 RP 的批准必须依次处理，绝不重叠");
        assert!(map.lock().unwrap().is_empty(), "两条都成功后都消费");
    }

    /// 复合键防撞（#8）：不同 RP 复用同一 request_id 不许互相顶掉。
    #[test]
    fn pending_key_is_composite_and_collision_safe() {
        let k1 = da::pending_key("https://a.example", "client", "req-1");
        let k2 = da::pending_key("https://b.example", "client", "req-1");
        assert_ne!(k1, k2, "不同 RP 同 request_id 不许撞键");
        assert_eq!(k1, da::pending_key("https://a.example", "client", "req-1"));
        assert_ne!(
            da::rp_queue_key("https://a.example", "c1"),
            da::rp_queue_key("https://a.example", "c2")
        );
    }

    /// 清数据助手：清空待确认事务并推进代际（#8）。
    #[test]
    fn clear_device_auth_pending_empties_and_bumps_generation() {
        let map = Mutex::new(HashMap::new());
        let gen = AtomicU64::new(5);
        map.lock().unwrap().insert(da::pending_key(ORIGIN, CLIENT, "req-1"), pending("link", vec![]));
        clear_device_auth_pending(&map, &gen);
        assert!(map.lock().unwrap().is_empty());
        assert_eq!(gen.load(Ordering::Relaxed), 6, "清数据推进代际，让在途批准对账失败");
    }

    /// 接线判据（#8）：清库路径必须真的调清设备认证待确认事务 —— 删掉那行调用，这条即红。
    #[test]
    fn clear_all_data_wires_device_auth_pending_clear() {
        let src = include_str!("favorites.rs");
        assert!(
            src.contains("clear_device_auth_pending(&s.device_auth_pending, &s.device_auth_generation)"),
            "清库路径必须清设备认证待确认事务（#8），否则清完数据旧确认页仍能复活已清事务"
        );
    }
}