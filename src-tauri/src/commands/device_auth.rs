// 职责边界：
// - 外部应用设备认证命令层（Phase 2）：深链处理、确认/拒绝、授权清单/撤销。
// - 协议核心在 crate::device_auth；RP 绑定 CRUD 在 crate::db（db/device_auth.rs）。
// ---------------- 外部应用设备认证（2026-11-13，Phase 2） ----------------
//
// Gosslan 是本地设备确认器，不是中心账号方。安全边界（设计文档 §6）：
// - 来源/端点只信 HTTPS 同源 metadata；reqwest 用 Policy::none() **不跟随任何重定向**。
// - 待确认事务内存态、cap 4、过期清除、复合键 + 代际（#8）；批准**RP 回写 2xx 后**才消费
//   （可重试，#1），同一 RP 的多个批准排队依次处理；拒绝即消费（一次性，防重放）。
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

/// 回写 decision（approve/deny）到 RP。非 2xx 视为失败（幂等由 RP 保证）。
async fn post_decision(client: &reqwest::Client, url: &str, body: &serde_json::Value) -> Result<(), String> {
    // reqwest 未开 json feature：手动序列化 + 显式 Content-Type（不引入新依赖特性）。
    let resp = client.post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .send().await
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
        ("link", Some(b)) => b, // 已有 active 绑定：幂等复用，不静默轮换密钥
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
        ("authenticate", Some(_)) => {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_BINDING_REVOKED, "绑定已撤销，请重新绑定"));
        }
        ("authenticate", None) => {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_NO_BINDING, "尚未绑定该应用，请先绑定"));
        }
        _ => return Err(error_codes::coded(error_codes::DEVICE_AUTH_UNSUPPORTED, "不支持的动作")),
    };

    let assertion = da::sign_with_binding(
        &row.secret_key, &row.kid, &row.pairwise_subject, meta, req, now_ms / 1000,
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
pub fn spawn_device_auth_link(app: tauri::AppHandle, url: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = handle_device_auth_link(&app, url).await {
            eprintln!("[device-auth] 深链处理失败：{e}");
        }
    });
}

/// 从启动参数里挑出授权深链（冷启动唤起）；只认 gosslan:// 与 https app link 形态。
/// 解析合法性留给 `handle_device_auth_link`（这里只做粗筛，避免把普通启动参数当深链）。
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
    let expires_at_ms = da::validate_request(&req, &meta, now_ms)?;

    let generation = s.device_auth_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let key = da::pending_key(&link.rp_origin, &meta.client_id, &req.request_id);
    let pending = da::PendingDeviceAuth { meta, request: req, rp_origin: link.rp_origin, expires_at_ms, generation };
    let prompt = pending.prompt();
    {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, p| p.expires_at_ms > now_ms);
        if map.len() >= MAX_PENDING_DEVICE_AUTH {
            if let Some(oldest) = map.iter().min_by_key(|(_, p)| p.expires_at_ms).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(key, pending);
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
        let map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending = map.get(&key)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_NOT_FOUND, "待确认事务不存在或已清除"))?;
        if pending.expires_at_ms <= crate::db::now_ms() {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
        }
        Ok(pending.prompt())
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取任务被中断：{e}")))?
}

/// 用户批准（可重试，#1）：排队 → 复核 → 读/建绑定并签名 → 回写 RP → **2xx 后才消费**事务。
/// 同一 RP 的多个批准排队依次处理（不是单飞拒绝）；POST 失败保留可重试态（不丢事务、不假授权）。
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
    // 先取一次（不消费）：拿代际与 meta；不存在/过期直接拒。真正的消费在 RP 2xx 之后。
    let (generation, meta) = {
        let map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        let p = map.get(&key)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在"))?;
        if p.expires_at_ms <= crate::db::now_ms() {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
        }
        (p.generation, p.meta.clone())
    };

    let s_db = s.clone();
    let decision_url = meta.decision_endpoint.replace("{request_id}", &request_id);
    run_approval(
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
            post_decision(&client, &decision_url, &body).await
        },
    )
    .await?;

    Ok(da::DeviceAuthOutcome {
        decision: "approved".into(),
        rp_origin,
        client_id: meta.client_id.clone(),
        display_name: meta.display_name.clone(),
    })
}

/// 用户拒绝：消费事务 → 回写 deny（不带断言）→ 返回结果。复合键定位（#8）。
#[tauri::command(async)]
pub async fn device_auth_deny(
    state: State<'_, Arc<crate::state::AppState>>,
    rp_origin: String,
    client_id: String,
    request_id: String,
) -> Result<da::DeviceAuthOutcome, String> {
    let s = state.inner().clone();
    let key = da::pending_key(&rp_origin, &client_id, &request_id);
    let pending = {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&key)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在"))?
    };
    let meta = pending.meta.clone();
    let client = rp_client()?;
    let decision_url = meta.decision_endpoint.replace("{request_id}", &request_id);
    // 拒绝回写失败不阻断本地拒绝（用户意图已明确）；尽力通知 RP。
    let _ = post_decision(&client, &decision_url, &json!({"decision": "deny"})).await;
    Ok(da::DeviceAuthOutcome {
        decision: "denied".into(),
        rp_origin,
        client_id: meta.client_id.clone(),
        display_name: meta.display_name.clone(),
    })
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
        da::PendingDeviceAuth { meta, request, rp_origin: ORIGIN.into(), expires_at_ms: 4_000_000_000_000, generation: 1 }
    }

    #[test]
    fn link_creates_active_binding_and_signs() {
        let conn = test_db();
        let p = pending("link", vec!["device_subject".into(), "device_public_key".into()]);
        let (assertion, info, _claims) = prepare_assertion(&conn, &p, false, 1_000).unwrap();
        assert_eq!(info.status, "active");
        assert!(!info.public_key.is_empty());
        assert_eq!(assertion.split('.').count(), 3, "JWS 三段");
        let b = crate::db::get_binding(&conn, ORIGIN, CLIENT).unwrap().unwrap();
        assert_eq!(b.status, "active");
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