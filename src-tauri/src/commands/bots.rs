// 职责边界：
// - 通知机器人（Webhook bot）的**命令层**：注册 / 列表 / 状态 / 删除 / 取件 / 收件箱。
//   服务端在独立仓库 `wenzo001/gosslan-relay-server`（`webhook.mjs`），接口契约见
//   该仓库的 `webhook-api.md`；客户端实施计划见主仓
//   `docs/notes/webhook-bot-client-plan-2026-11-16.md`。
//
// ## 三条不可让步的顺序/边界（判据钉着）
//
// 1. **先落本地、再 ACK**：取到的事件必须先写进本地收件箱（事务提交成功）才 ACK；
//    否则「ACK 成功但本地没存」= 消息永久丢失。
// 2. **按 `event_id` 幂等**：重复投递不重复显示（收件箱写入返回 false 时只 ACK 不追加）。
// 3. **密钥不进日志/诊断/列表响应**：`client_secret` 只在存储与请求头里出现；
//    列表接口只回公钥面（没有公钥，就回「不可见」的字段一律不出现）。
// ---------------- 通知机器人（Webhook bot） ----------------

// ⚠️ `commands.rs` 已经 import 了 `serde::{Deserialize, Serialize}` / `Arc` / `Duration`
//    （这些模块是被 `include!` 进同一个模块的 ⇒ 同名 import 会撞）⇒ 这里不再重复导入。
// ⚠️ `State` / `db` 也已经在 `commands.rs` 里导入了 ⇒ 这里不再重复。
use crate::db::{BotImage, BotInboxEntry, BotRecord, BotTarget};

/// 取件/注册用的 HTTP 超时（秒）。短一点：拉件是后台行为，卡住就下一轮。
const BOT_HTTP_TIMEOUT_SECS: u64 = 20;
/// 机器人名字上限（显示用）。
const BOT_NAME_MAX: usize = 60;

// ---------------- 纯逻辑（可单测） ----------------

/// 服务地址规范化：**强制 HTTPS**。
///
/// 回环地址（127.0.0.1 / localhost / ::1）放行 `http://` —— 本机联调自托管服务时
/// 常常还没配证书；但**任何非回环的 http:// 一律拒绝**（bot 密钥与消息正文会明文过网）。
pub fn normalize_bot_server(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "请填写通知服务地址，例如 https://hooks.example.com",
        ));
    }
    let Some(rest) = raw.strip_prefix("https://") else {
        if let Some(rest) = raw.strip_prefix("http://") {
            let host = rest.split('/').next().unwrap_or("");
            let hostname = host.split(':').next().unwrap_or("");
            if matches!(hostname, "127.0.0.1" | "localhost" | "::1" | "[::1]") {
                return Ok(raw.trim_end_matches('/').to_string());
            }
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_SERVER_INVALID,
                "通知服务必须用 HTTPS（http:// 只允许本机 127.0.0.1 / localhost 联调）",
            ));
        }
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址应以 https:// 开头",
        ));
    };
    if rest.split('/').next().unwrap_or("").is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址缺少主机名",
        ));
    }
    Ok(raw.trim_end_matches('/').to_string())
}

/// 外部发送者用的 endpoint（给用户复制的那条）。
pub fn bot_hook_endpoint(server_url: &str, bot_id: &str) -> String {
    format!("{}/v1/hooks/{bot_id}/messages", server_url.trim_end_matches('/'))
}

/// 群投递时的来源前缀（**发送者仍是网关设备**，只是加一个可见来源标记）。
///
/// ⚠️ 线格式属 Frozen Core ⇒ 首版不改协议字段，用正文前缀表达来源；
/// 结构化 `webhook_bot` 元数据留到协议评审之后（计划 §1.3）。
pub fn bot_group_prefix(bot_name: &str) -> String {
    format!("【{}】", bot_name.trim())
}

/// 机器人状态：只允许这三个。
pub fn normalize_bot_status(raw: &str) -> Result<&'static str, String> {
    match raw.trim() {
        "active" => Ok("active"),
        "paused" => Ok("paused"),
        "revoked" => Ok("revoked"),
        _ => Err(crate::error_codes::coded(
            crate::error_codes::BOT_BAD_STATUS,
            "机器人状态只支持 active / paused / revoked",
        )),
    }
}

// ---------------- 视图（**不含任何密钥**） ----------------

/// 机器人列表项（前端拿到的形状）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotView {
    pub bot_id: String,
    pub name: String,
    pub server_url: String,
    pub target: BotTarget,
    pub status: String,
    pub created_at: i64,
    pub last_event_at: Option<i64>,
    pub last_error: Option<String>,
    pub pending: u32,
    pub failed: u32,
}

impl From<&BotRecord> for BotView {
    fn from(r: &BotRecord) -> Self {
        BotView {
            bot_id: r.bot_id.clone(),
            name: r.name.clone(),
            server_url: r.server_url.clone(),
            target: r.target.clone(),
            status: r.status.clone(),
            created_at: r.created_at,
            last_event_at: r.last_event_at,
            last_error: r.last_error.clone(),
            pending: r.pending,
            failed: r.failed,
        }
    }
}

/// 创建机器人后的返回值：**`send_secret` 只在这里出现一次**（之后列表里不再回显）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotCreatedView {
    pub bot: BotView,
    /// 外部发送者用的发送密钥（一次性）。
    pub send_secret: String,
    /// 外部发送者用的 endpoint（可复制）。
    pub endpoint: String,
}

// ---------------- HTTP（与服务端对话） ----------------

fn bot_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(BOT_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| crate::error_codes::coded(crate::error_codes::BOT_HTTP_FAILED, format!("HTTP 客户端初始化失败：{e}")))
}

#[derive(Deserialize)]
struct ServerBotCreated {
    bot_id: String,
    name: String,
    #[serde(default)]
    target: BotTarget,
    send_secret: String,
    client_secret: String,
}

#[derive(Deserialize, Clone)]
struct ServerEnvelope {
    #[serde(default)]
    schema: String,
    event_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    images: Vec<BotImage>,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct ServerPullResponse {
    #[serde(default)]
    events: Vec<ServerEnvelope>,
}

/// 从服务端错误响应里取一句可读的原因（不把内部细节/路径泄给用户）。
fn server_error_text(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("message").and_then(|x| x.as_str()) {
            return m.to_string();
        }
        if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
            return e.to_string();
        }
    }
    if body.trim().is_empty() {
        "服务端未说明原因".to_string()
    } else {
        body.chars().take(200).collect()
    }
}

// ---------------- 命令 ----------------

/// 注册一个机器人（客户端去服务端注册 ⇒ 拿一次性密钥 ⇒ 落本地）。
#[tauri::command(async)]
pub async fn bot_create(
    state: State<'_, Arc<AppState>>,
    name: String,
    target_kind: String,
    target_group_id: Option<String>,
    target_group_name: Option<String>,
    server_url: String,
    client_token: String,
) -> Result<BotCreatedView, String> {
    let server = normalize_bot_server(&server_url)?;
    let bot_name: String = name.trim().chars().take(BOT_NAME_MAX).collect();
    if bot_name.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NAME_REQUIRED,
            "请给机器人起个名字",
        ));
    }
    let token = client_token.trim().to_string();
    if token.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_CLIENT_TOKEN_REQUIRED,
            "请填写通知服务的客户端令牌（服务端 WEBHOOK_CLIENT_TOKEN）",
        ));
    }
    let target = match target_kind.trim() {
        "inbox" => BotTarget {
            kind: "inbox".into(),
            group_id: None,
            group_name: None,
        },
        "group" => {
            let gid = target_group_id.clone().unwrap_or_default();
            if gid.trim().is_empty() {
                return Err(crate::error_codes::coded(
                    crate::error_codes::BOT_TARGET_INVALID,
                    "请选择要投递到的群",
                ));
            }
            BotTarget {
                kind: "group".into(),
                group_id: Some(gid.trim().to_string()),
                group_name: target_group_name.clone(),
            }
        }
        _ => {
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_TARGET_INVALID,
                "投递目标只支持本机收件箱（inbox）或群（group）",
            ))
        }
    };

    let client = bot_client()?;
    let body = serde_json::to_string(&serde_json::json!({ "name": bot_name, "target": target }))
        .map_err(|e| format!("请求体序列化失败：{e}"))?;
    let resp = client
        .post(format!("{server}/v1/client/bots"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::BOT_CREATE_FAILED,
                format!("连不上通知服务：{e}"),
            )
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_CREATE_FAILED,
            format!("注册失败（{status}）：{}", server_error_text(&text)),
        ));
    }
    let created: ServerBotCreated = serde_json::from_str(&text).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::BOT_CREATE_FAILED,
            format!("服务端返回的机器人信息无法解析：{e}"),
        )
    })?;

    let now = db::now_ms();
    let record = BotRecord {
        bot_id: created.bot_id.clone(),
        name: if created.name.trim().is_empty() { bot_name } else { created.name },
        server_url: server.clone(),
        client_secret: created.client_secret.clone(),
        target: if created.target.kind.is_empty() { target } else { created.target },
        status: "active".into(),
        created_at: now,
        last_event_at: None,
        last_error: None,
        pending: 0,
        failed: 0,
    };
    let view = BotView::from(&record);
    // 落库：写库失败 ⇒ 服务端那个机器人也一并撤销（别留一个孤儿机器人）。
    let s = state.inner().clone();
    let persist = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &record).map_err(|e| format!("保存机器人失败：{e}"))
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))?;
    if let Err(e) = persist {
        // 尽力撤销：服务端留着这个机器人而本机没有记录 ⇒ 用户再也找不回来。
        let _ = client
            .post(format!("{server}/v1/client/bots/{}/status", created.bot_id))
            .bearer_auth(&created.client_secret)
            .header("content-type", "application/json")
            .body(serde_json::to_string(&serde_json::json!({ "status": "revoked" })).unwrap_or_default())
            .send()
            .await;
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_CREATE_FAILED,
            e,
        ));
    }

    // ⚠️ 发送密钥**只在这里返回一次**：之后列表接口不再回显（前端要用户当场复制）。
    Ok(BotCreatedView {
        bot: view,
        send_secret: created.send_secret,
        endpoint: bot_hook_endpoint(&server, &created.bot_id),
    })
}

/// 机器人列表（**不含任何密钥**）。
#[tauri::command(async)]
pub async fn bot_list(state: State<'_, Arc<AppState>>) -> Result<Vec<BotView>, String> {
    let s = state.inner().clone();
    let records = tokio::task::spawn_blocking(move || -> Result<Vec<BotRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_bots(&dbc).map_err(|e| format!("读取机器人列表失败：{e}"))
    })
    .await
    .map_err(|e| format!("读取任务中断：{e}"))??;
    Ok(records.iter().map(BotView::from).collect())
}

/// 暂停 / 恢复 / 撤销。
///
/// 撤销**不可逆**（要重新创建）⇒ 撤销时同时清掉本机的取件凭证。
#[tauri::command(async)]
pub async fn bot_set_status(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
    status: String,
) -> Result<BotView, String> {
    let next = normalize_bot_status(&status)?;
    let s = state.inner().clone();
    // 读机器人：进阻塞池（等 DB 锁不该占住 tokio worker —— R-18 棘轮）。
    let record = {
        let sd = s.clone();
        let bid = bot_id.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<BotRecord>, String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::load_bot(&dbc, &bid).map_err(|e| format!("读取机器人失败：{e}"))
        })
        .await
        .map_err(|e| format!("读取任务中断：{e}"))??
    };
    let Some(mut record) = record else {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NOT_FOUND,
            "机器人不存在",
        ));
    };
    // 先问服务端（服务端才是**拒收**的裁决方；本机状态只是镜像）。
    let client = bot_client()?;
    let resp = client
        .post(format!(
            "{}/v1/client/bots/{bot_id}/status",
            record.server_url
        ))
        .bearer_auth(&record.client_secret)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&serde_json::json!({ "status": next })).unwrap_or_default())
        .send()
        .await
        .map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::BOT_STATUS_FAILED,
                format!("连不上通知服务：{e}"),
            )
        })?;
    let st = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !st.is_success() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_STATUS_FAILED,
            format!("服务端拒绝了这次状态变更（{st}）：{}", server_error_text(&text)),
        ));
    }
    record.status = next.to_string();
    if next == "revoked" {
        // 撤销后不再保留取件凭证（它已经没有用途，留着只是风险）。
        record.client_secret.clear();
    }
    let view = BotView::from(&record);
    let rec = record.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &rec).map_err(|e| format!("保存机器人状态失败：{e}"))
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))??;
    Ok(view)
}

/// 删除机器人（撤销 + 清本地记录与收件箱）。
#[tauri::command(async)]
pub async fn bot_delete(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    let record = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::load_bot(&dbc, &bot_id).map_err(|e| format!("读取机器人失败：{e}"))?
    };
    // 本地先清（本地清不掉就是真失败；服务端的撤销是尽力而为）。进阻塞池（R-18）。
    {
        let sd = s.clone();
        let bid = bot_id.clone();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::delete_bot(&dbc, &bid).map_err(|e| format!("删除机器人失败：{e}"))
        })
        .await
        .map_err(|e| format!("删除任务中断：{e}"))??;
    }
    if let Some(rec) = record {
        if !rec.client_secret.is_empty() {
            let client = bot_client()?;
            let _ = client
                .post(format!("{}/v1/client/bots/{bot_id}/status", rec.server_url))
                .bearer_auth(&rec.client_secret)
                .header("content-type", "application/json")
                .body(serde_json::to_string(&serde_json::json!({ "status": "revoked" })).unwrap_or_default())
                .send()
                .await;
        }
    }
    Ok(())
}

/// 收件箱（某个机器人的消息列表，新的在前）。
#[tauri::command(async)]
pub async fn bot_inbox(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
) -> Result<Vec<BotInboxEntry>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<BotInboxEntry>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::load_inbox(&dbc, &bot_id).map_err(|e| format!("读取收件箱失败：{e}"))
    })
    .await
    .map_err(|e| format!("读取任务中断：{e}"))?
}

/// 拉一次件并投递（**先落本地、再 ACK**）。
///
/// 返回本次取到/投递/失败的数量。前端与后台 worker 都调它。
#[tauri::command(async)]
pub async fn bot_pull_once(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
) -> Result<BotPullOutcome, String> {
    let s = state.inner().clone();
    // 读机器人：进阻塞池（R-18）。
    let record = {
        let sd = s.clone();
        let bid = bot_id.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<BotRecord>, String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::load_bot(&dbc, &bid).map_err(|e| format!("读取机器人失败：{e}"))
        })
        .await
        .map_err(|e| format!("读取任务中断：{e}"))??
    };
    let Some(record) = record else {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NOT_FOUND,
            "机器人不存在",
        ));
    };
    if record.status != "active" {
        return Ok(BotPullOutcome::default());
    }
    if record.client_secret.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NO_CREDENTIAL,
            "这个机器人已被撤销，没有取件凭证",
        ));
    }
    let client = bot_client()?;
    let pull_url = format!("{}/v1/client/bots/{bot_id}/pull", record.server_url);
    let resp = client
        .post(&pull_url)
        .bearer_auth(&record.client_secret)
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::BOT_PULL_FAILED,
                format!("取件失败：{e}"),
            )
        })?;
    let st = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !st.is_success() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_PULL_FAILED,
            format!("取件被拒（{st}）：{}", server_error_text(&text)),
        ));
    }
    let pulled: ServerPullResponse = serde_json::from_str(&text).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::BOT_PULL_FAILED,
            format!("取件结果无法解析：{e}"),
        )
    })?;

    let mut outcome = BotPullOutcome {
        pulled: pulled.events.len() as u32,
        ..Default::default()
    };
    for ev in pulled.events {
        // ① 先落本地（收件箱；群目标还要真的发出去）—— 落库失败**不 ACK**。
        let entry = BotInboxEntry {
            event_id: ev.event_id.clone(),
            text: ev.text.clone(),
            format: if ev.format.is_empty() { "text".into() } else { ev.format.clone() },
            source: ev.source.clone(),
            images: ev.images.clone(),
            received_at: db::now_ms(),
            state: "received".into(),
        };
        let delivered = deliver_event(&s, &record, &entry).await;
        // ② 落库/投递成功才 ACK；失败 ⇒ NACK（可重试）⇒ 服务端会在租约到期后重投。
        let ok = delivered.is_ok();
        if !ok {
            outcome.failed += 1;
            if let Err(e) = &delivered {
                s.logger
                    .info("bot", format!("投递失败 event={} err={}", entry.event_id, e));
            }
        } else {
            outcome.delivered += 1;
        }
        let ack_url = format!("{}/v1/client/bots/{bot_id}/ack", record.server_url);
        let nack_url = format!("{}/v1/client/bots/{bot_id}/nack", record.server_url);
        let (url, body) = if ok {
            (
                ack_url,
                serde_json::json!({ "event_id": entry.event_id, "durable_receipt": entry.event_id }),
            )
        } else {
            (
                nack_url,
                serde_json::json!({ "event_id": entry.event_id, "permanent": false, "error": "本地投递失败" }),
            )
        };
        let _ = client
            .post(url)
            .bearer_auth(&record.client_secret)
            .header("content-type", "application/json")
            .body(serde_json::to_string(&body).unwrap_or_default())
            .send()
            .await;
    }
    // 更新本机的「最近收到时间 / 待投递数 / 失败数」。
    {
        let mut rec = record.clone();
        rec.last_event_at = Some(db::now_ms());
        rec.pending = 0;
        rec.failed = outcome.failed;
        rec.last_error = if outcome.failed > 0 {
            Some(format!("{} 条投递失败", outcome.failed))
        } else {
            None
        };
        // 回写状态：进阻塞池（R-18）。写失败不影响本轮投递结果（下一轮会再写）。
        let sd = s.clone();
        let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::save_bot(&dbc, &rec).map_err(|e| format!("保存机器人状态失败：{e}"))
        })
        .await;
    }
    Ok(outcome)
}

/// 一次取件的计数。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotPullOutcome {
    /// 服务端这次给了多少条。
    pub pulled: u32,
    /// 本地成功落盘/发出多少条。
    pub delivered: u32,
    /// 失败多少条（已 NACK，服务端会重投）。
    pub failed: u32,
}

/// 把一条事件投递到目标（收件箱 or 群）。
async fn deliver_event(
    s: &Arc<AppState>,
    record: &BotRecord,
    entry: &BotInboxEntry,
) -> Result<(), String> {
    match record.target.kind.as_str() {
        "inbox" => {
            let bot_id = record.bot_id.clone();
            let e = entry.clone();
            let sd = s.clone();
            tokio::task::spawn_blocking(move || -> Result<bool, String> {
                let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                db::append_inbox(&dbc, &bot_id, &e).map_err(|e| format!("写入收件箱失败：{e}"))
            })
            .await
            .map_err(|e| format!("写入任务中断：{e}"))??;
            Ok(())
        }
        "group" => {
            let group_id = record.target.group_id.clone().unwrap_or_default();
            if group_id.is_empty() {
                return Err("群目标已失效（没有群 id）".into());
            }
            // 群消息的**发送者仍是网关设备**；正文加来源前缀（线格式不动，见计划 §1.3）。
            let content = format!("{}{}", bot_group_prefix(&record.name), entry.text);
            let sd = s.clone();
            let gid = group_id.clone();
            let res = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                let group = db::get_group(&dbc, &gid).ok_or("群不存在")?;
                if !group.members.iter().any(|m| m == &sd.device_id) {
                    return Err("你已不在这个群里".to_string());
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("校验群失败：{e}"))??;
            send_group_payload(s, &group_id, "text", content, None, None, None)
                .await
                .map(|_| ())
                .map_err(|e| format!("发进群失败：{e}"))
        }
        _ => Err("投递目标类型不认识".into()),
    }
}

// ---------------- 判据 ----------------

#[cfg(test)]
mod bot_cmd_tests {
    use super::*;

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        conn
    }

    fn sample_bot() -> BotRecord {
        BotRecord {
            bot_id: "bot_1".into(),
            name: "CI 通知".into(),
            server_url: "https://hooks.example.com".into(),
            client_secret: "super-secret".into(),
            target: BotTarget {
                kind: "inbox".into(),
                group_id: None,
                group_name: None,
            },
            status: "active".into(),
            created_at: 1,
            last_event_at: None,
            last_error: None,
            pending: 0,
            failed: 0,
        }
    }

    /// 服务地址**必须 HTTPS**（回环除外）：bot 密钥与消息正文不能明文过网。
    #[test]
    fn server_address_must_be_https_except_loopback() {
        assert_eq!(
            normalize_bot_server("https://hooks.example.com/").unwrap(),
            "https://hooks.example.com"
        );
        // 本机联调放行 http
        assert_eq!(
            normalize_bot_server("http://127.0.0.1:59995").unwrap(),
            "http://127.0.0.1:59995"
        );
        assert_eq!(
            normalize_bot_server("http://localhost:59995").unwrap(),
            "http://localhost:59995"
        );
        // 非回环的 http 一律拒
        assert!(normalize_bot_server("http://hooks.example.com").is_err());
        // 缺协议 / 空 / 垃圾
        assert!(normalize_bot_server("").is_err());
        assert!(normalize_bot_server("hooks.example.com").is_err());
        assert!(normalize_bot_server("https://").is_err());
    }

    /// 外部发送者拿到的 endpoint 与状态取值。
    #[test]
    fn endpoint_and_status_normalization() {
        assert_eq!(
            bot_hook_endpoint("https://hooks.example.com/", "bot_x"),
            "https://hooks.example.com/v1/hooks/bot_x/messages"
        );
        assert_eq!(normalize_bot_status("active").unwrap(), "active");
        assert_eq!(normalize_bot_status("paused").unwrap(), "paused");
        assert_eq!(normalize_bot_status("revoked").unwrap(), "revoked");
        assert!(normalize_bot_status("deleted").is_err());
    }

    /// 群投递的来源前缀（发送者仍是网关设备，不冒充外部账号）。
    #[test]
    fn group_prefix_marks_the_source_but_not_the_sender() {
        assert_eq!(bot_group_prefix("CI 通知"), "【CI 通知】");
        // 前缀里不许出现设备 id（那是「谁发的」，由群消息本身承担）
        assert!(!bot_group_prefix("CI 通知").contains("device"));
    }

    /// 列表视图**不含任何密钥**。
    #[test]
    fn the_list_view_carries_no_secret() {
        let rec = sample_bot();
        let view = BotView::from(&rec);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("super-secret"), "列表里不许出现取件凭证");
        assert!(!json.contains("clientSecret"), "列表里不许出现密钥字段");
        assert!(json.contains("bot_1"));
    }

    /// 存储：存 → 读 → 列 → 删；收件箱**按 event_id 幂等**。
    #[test]
    fn storage_round_trips_and_the_inbox_is_idempotent() {
        let conn = test_db();
        let rec = sample_bot();
        crate::db::save_bot(&conn, &rec).unwrap();
        let got = crate::db::load_bot(&conn, "bot_1").unwrap().expect("机器人应能读回");
        assert_eq!(got.name, "CI 通知");
        assert_eq!(got.client_secret, "super-secret");
        assert_eq!(crate::db::list_bots(&conn).unwrap().len(), 1);

        let entry = crate::db::BotInboxEntry {
            event_id: "evt_1".into(),
            text: "构建完成".into(),
            format: "markdown".into(),
            source: "CI".into(),
            images: vec![],
            received_at: 1,
            state: "received".into(),
        };
        assert!(crate::db::append_inbox(&conn, "bot_1", &entry).unwrap());
        // 重复投递（租约到期重投）⇒ 不重复显示
        assert!(!crate::db::append_inbox(&conn, "bot_1", &entry).unwrap());
        assert_eq!(crate::db::load_inbox(&conn, "bot_1").unwrap().len(), 1);

        crate::db::delete_bot(&conn, "bot_1").unwrap();
        assert!(crate::db::load_bot(&conn, "bot_1").unwrap().is_none());
        assert!(crate::db::load_inbox(&conn, "bot_1").unwrap().is_empty());
    }

    /// **先落本地、再 ACK**：ACK 调用必须在投递（落库/发群）之后。
    ///
    /// 顺序反了 = 「ACK 成功但本地没存」⇒ 消息永久丢失（这是这一族最贵的错）。
    #[test]
    fn the_ack_happens_after_the_local_delivery() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let deliver = prod
            .find("deliver_event(&s, &record, &entry)")
            .expect("没有调用投递函数 ⇒ 事件被直接 ACK 掉了");
        let ack = prod
            .find(".post(url)")
            .expect("没有 ACK 调用");
        assert!(
            deliver < ack,
            "ACK 必须写在投递之后（先落本地、再 ACK）",
        );
    }

    /// 撤销会清掉取件凭证（留着只是风险）。
    #[test]
    fn revoking_clears_the_client_credential() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let revoke = prod
            .find("record.client_secret.clear()")
            .expect("撤销后没有清掉取件凭证");
        let status = prod.find("if next == \"revoked\"").expect("没有撤销分支");
        assert!(status < revoke, "清凭证必须挂在撤销分支里");
    }
}
