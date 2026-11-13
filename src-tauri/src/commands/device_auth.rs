// 职责边界：
// - 外部应用设备认证命令层（Phase 2）：深链处理、确认/拒绝、授权清单/撤销。
// - 协议核心在 crate::device_auth；RP 绑定 CRUD 在 crate::db（db/device_auth.rs）。
// ---------------- 外部应用设备认证（2026-11-13，Phase 2） ----------------
//
// Gosslan 是本地设备确认器，不是中心账号方。安全边界（设计文档 §6）：
// - 来源/端点只信 HTTPS 同源 metadata；reqwest 用 Policy::none() **不跟随任何重定向**。
// - 待确认事务内存态、cap 4、过期清除；批准/拒绝即消费移除（一次性，防重放）。
// - 私钥只在非命令 helper `prepare_assertion` 里本地解码签名（INV-P18 判据 B 不扫非命令体），
//   命令返回值/事件只含公钥面与断言结果，绝不带私钥。
// - 本流程不触好友/传输/身份锚点。

use crate::device_auth as da;
use crate::error_codes;

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
            let (signing, public_b64, kid, subject) = da::generate_rp_key();
            let secret_b64 = STANDARD.encode(signing.to_bytes());
            let scopes = serde_json::to_string(&req.requested_claims).unwrap_or_else(|_| "[]".into());
            let b = crate::db::RpBindingRow {
                rp_origin: origin.clone(),
                client_id: meta.client_id.clone(),
                display_name: meta.display_name.clone(),
                kid,
                public_key: public_b64,
                secret_key: secret_b64,
                pairwise_subject: subject,
                scopes,
                status: "active".into(),
                created_at: now_ms,
                last_used_at: Some(now_ms),
                revoked_at: None,
            };
            crate::db::insert_binding(conn, &b)
                .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("写入绑定失败：{e}")))?;
            b
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

    let pending = da::PendingDeviceAuth { meta, request: req, rp_origin: link.rp_origin, expires_at_ms };
    let prompt = pending.prompt();
    {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, p| p.expires_at_ms > now_ms);
        if map.len() >= MAX_PENDING_DEVICE_AUTH {
            if let Some(oldest) = map.iter().min_by_key(|(_, p)| p.expires_at_ms).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(prompt.request_id.clone(), pending);
    }
    if let Some(w) = s.app.get_webview_window(crate::WINDOW_MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = s.app.emit("device-auth-request", &prompt);
    Ok(prompt)
}

/// 取某条待确认事务的确认页数据（前端弹窗打开时拉一次）。
#[tauri::command(async)]
pub async fn device_auth_get_pending(
    state: State<'_, Arc<crate::state::AppState>>,
    request_id: String,
) -> Result<da::DeviceAuthPrompt, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        let pending = map.get(&request_id)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_NOT_FOUND, "待确认事务不存在或已清除"))?;
        if pending.expires_at_ms <= crate::db::now_ms() {
            return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
        }
        Ok(pending.prompt())
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("读取任务被中断：{e}")))?
}

/// 用户批准：消费事务（一次性）→ 读/建绑定并签名 → 回写 RP → 返回结果。
#[tauri::command(async)]
pub async fn device_auth_approve(
    state: State<'_, Arc<crate::state::AppState>>,
    request_id: String,
    allow_nickname: bool,
) -> Result<da::DeviceAuthOutcome, String> {
    let s = state.inner().clone();
    let pending = {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&request_id)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在"))?
    };
    if pending.expires_at_ms <= crate::db::now_ms() {
        return Err(error_codes::coded(error_codes::DEVICE_AUTH_EXPIRED, "事务已过期"));
    }
    let meta = pending.meta.clone();
    let rp_origin = pending.rp_origin.clone();

    let s_db = s.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let dbc = s_db.db.lock().unwrap_or_else(|e| e.into_inner());
        prepare_assertion(&dbc, &pending, allow_nickname, crate::db::now_ms())
    })
    .await
    .map_err(|e| error_codes::coded(error_codes::DEVICE_AUTH_NETWORK, format!("签名任务被中断：{e}")))??;
    let (assertion, info, claims) = prepared;

    let body = json!({
        "decision": "approve",
        "key_id": info.kid,
        "public_key": info.public_key,
        "device_subject": info.pairwise_subject,
        "claims": claims,
        "assertion": assertion,
    });
    let client = rp_client()?;
    let decision_url = meta.decision_endpoint.replace("{request_id}", &request_id);
    post_decision(&client, &decision_url, &body).await?;

    Ok(da::DeviceAuthOutcome {
        decision: "approved".into(),
        rp_origin,
        client_id: meta.client_id.clone(),
        display_name: meta.display_name.clone(),
    })
}

/// 用户拒绝：消费事务 → 回写 deny（不带断言）→ 返回结果。
#[tauri::command(async)]
pub async fn device_auth_deny(
    state: State<'_, Arc<crate::state::AppState>>,
    request_id: String,
) -> Result<da::DeviceAuthOutcome, String> {
    let s = state.inner().clone();
    let pending = {
        let mut map = s.device_auth_pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&request_id)
            .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_REPLAYED, "事务已消费或不存在"))?
    };
    let meta = pending.meta.clone();
    let rp_origin = pending.rp_origin.clone();
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
        da::PendingDeviceAuth { meta, request, rp_origin: ORIGIN.into(), expires_at_ms: 4_000_000_000_000 }
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
}