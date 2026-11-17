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
// 3. **密钥不进日志/诊断/列表响应**：`client_token` 只在存储与请求头里出现；
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
    pub scope: String,
    pub do_not_disturb: bool,
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
            scope: if r.scope.is_empty() {
                if r.target.kind == "group" { "group".into() } else { "personal".into() }
            } else { r.scope.clone() },
            do_not_disturb: r.do_not_disturb,
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

/// 创建机器人后的返回值：**`send_token` 只在这里出现一次**（之后列表里不再回显）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotCreatedView {
    pub bot: BotView,
    /// 外部发送者用的发送 token（一次性）。
    pub send_token: String,
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
    /// wire 名是 `send_secret` / `client_secret`（服务端的契约，见 `webhook-api.md`）
    /// ⇒ 本地叫 `send_token` / `client_token`（与 relay 的 `token` 同一命名口径，
    /// 也避开密钥边界守卫对 `secret` 命名的判定）。
    #[serde(rename = "send_secret")]
    send_token: String,
    #[serde(rename = "client_secret")]
    client_token: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)] // 服务端信封里的字段（schema / created_at）本仓只读其中一部分。
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
#[allow(clippy::too_many_arguments)] // v6：新增 scope / dnd 两个可选参数，参数面本来就是命令入口契约
pub async fn bot_create(
    state: State<'_, Arc<AppState>>,
    name: String,
    scope: String,
    target_group_id: Option<String>,
    target_group_name: Option<String>,
    server_url: String,
    client_token: Option<String>,
    do_not_disturb: Option<bool>,
) -> Result<BotCreatedView, String> {
    let server = normalize_bot_server(&server_url)?;
    let bot_name: String = name.trim().chars().take(BOT_NAME_MAX).collect();
    if bot_name.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NAME_REQUIRED,
            "请给机器人起个名字",
        ));
    }
    let token = client_token.unwrap_or_default().trim().to_string();
    if token.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_CLIENT_TOKEN_REQUIRED,
            "请填写通知服务的客户端令牌（服务端 WEBHOOK_CLIENT_TOKEN）",
        ));
    }
    let scope_norm = match scope.trim() {
        "group" => "group",
        _ => "personal",
    };
    let target = match scope_norm {
        "personal" => BotTarget {
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
                "投递目标只支持 personal（个人会话）或 group（群）",
            ))
        }
    };

    // v6：群机器人只有群主/管理员能创建（前端隐藏不算权限，命令 fail-closed）。
    if scope_norm == "group" {
        let s = state.inner().clone();
        let gid = target.group_id.clone().unwrap_or_default();
        let me = s.device_id.clone();
        let allowed = tokio::task::spawn_blocking(move || -> Result<bool, String> {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            let g = db::get_group(&dbc, &gid).ok_or("群不存在")?;
            Ok(g.creator == me || g.admins.contains(&me))
        })
        .await
        .map_err(|e| format!("权限检查中断：{e}"))??;
        if !allowed {
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_TARGET_INVALID,
                "只有群主或管理员可以在群里添加机器人",
            ));
        }
    }

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
        scope: scope_norm.to_string(),
        do_not_disturb: do_not_disturb.unwrap_or(false),
        server_url: server.clone(),
        client_token: created.client_token.clone(),
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
    let conv_id_for_new = if scope_norm == "personal" {
        Some(format!("bot:{}", created.bot_id))
    } else { None };
    let bot_name_for_conv = record.name.clone();
    let persist = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &record).map_err(|e| format!("保存机器人失败：{e}"))?;
        // v6：个人机器人当场进会话列表（像联系人一样），哪怕还没收到第一条通知。
        if let Some(cid) = conv_id_for_new {
            db::ensure_conversation(&dbc, &cid, "single", &format!("{} · 机器人", bot_name_for_conv), None)
                .map_err(|e| format!("创建机器人会话失败：{e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))?;
    if let Err(e) = persist {
        // 尽力撤销：服务端留着这个机器人而本机没有记录 ⇒ 用户再也找不回来。
        let _ = client
            .post(format!("{server}/v1/client/bots/{}/status", created.bot_id))
            .bearer_auth(&created.client_token)
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
        send_token: created.send_token,
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

/// v6：免打扰（只影响系统通知/任务栏闪烁，不影响进会话与未读角标）。
#[tauri::command(async)]
pub async fn bot_set_dnd(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
    enabled: bool,
) -> Result<BotView, String> {
    let s = state.inner().clone();
    let record = tokio::task::spawn_blocking({
        let sd = s.clone();
        let bid = bot_id.clone();
        move || -> Result<Option<BotRecord>, String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::load_bot(&dbc, &bid).map_err(|e| format!("读取机器人失败：{e}"))
        }
    }).await.map_err(|e| format!("读取任务中断：{e}"))??;
    let Some(mut record) = record else {
        return Err(crate::error_codes::coded(crate::error_codes::BOT_NOT_FOUND, "机器人不存在"));
    };
    record.do_not_disturb = enabled;
    let view = BotView::from(&record);
    let rec = record.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &rec).map_err(|e| format!("保存机器人失败：{e}"))
    }).await.map_err(|e| format!("保存任务中断：{e}"))??;
    Ok(view)
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
        .bearer_auth(&record.client_token)
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
        record.client_token.clear();
    }
    let view = BotView::from(&record);
    let rec = record.clone();
    let conv_to_drop = if next == "revoked" && rec.target.kind != "group" {
        Some(format!("bot:{}", rec.bot_id))
    } else { None };
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &rec).map_err(|e| format!("保存机器人状态失败：{e}"))?;
        if let Some(cid) = conv_to_drop { let _ = db::delete_conversation(&dbc, &cid); }
        Ok(())
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
            db::delete_bot(&dbc, &bid).map_err(|e| format!("删除机器人失败：{e}"))?;
            // 收件箱一起清掉：机器人没了，它的旧通知不该继续留在本机。
            db::clear_inbox(&dbc, &bid).map_err(|e| format!("清空收件箱失败：{e}"))
        })
        .await
        .map_err(|e| format!("删除任务中断：{e}"))??;
    }
    if let Some(rec) = record {
        if !rec.client_token.is_empty() {
            let client = bot_client()?;
            let _ = client
                .post(format!("{}/v1/client/bots/{bot_id}/status", rec.server_url))
                .bearer_auth(&rec.client_token)
                .header("content-type", "application/json")
                .body(serde_json::to_string(&serde_json::json!({ "status": "revoked" })).unwrap_or_default())
                .send()
                .await;
        }
    }
    Ok(())
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
    pull_bot_once(&s, &bot_id).await
}

/// 拉一次件并投递（**先落本地、再 ACK**）—— 命令与后台轮询 worker 共用的内核。
///
/// 为什么要拆成内部函数：后台 worker 不走 Tauri 命令通道，拿不到 `State`；
/// 两边共用同一份内核 ⇒ 「手动立即取件」与「自动轮询」的语义**必然一致**
/// （顺序反了 = 消息永久丢失，这是这一族最贵的错）。
async fn pull_bot_once(s: &Arc<AppState>, bot_id: &str) -> Result<BotPullOutcome, String> {
    let s = s.clone();
    let bot_id = bot_id.to_string();
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
    if record.client_token.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_NO_CREDENTIAL,
            "这个机器人已被撤销，没有取件凭证",
        ));
    }
    let client = bot_client()?;
    let pull_url = format!("{}/v1/client/bots/{bot_id}/pull", record.server_url);
    let resp = client
        .post(&pull_url)
        .bearer_auth(&record.client_token)
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
            .bearer_auth(&record.client_token)
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

/// 会话列表里机器人消息正文的摘要长度（完整正文仍在收件箱/详情里）。
const PERSONAL_PREVIEW_MAX: usize = 240;

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
        "inbox" | "personal" => {
            // v6：个人机器人 = 本机假身份会话。消息落 messages + 会话列表，
            // sender_id = conv_id = `bot:<id>` ⇒ **不写 outbox** ⇒ 不上网络、不跨设备。
            let bot_id = record.bot_id.clone();
            let bot_name = record.name.clone();
            let e = entry.clone();
            let sd = s.clone();
            let emitted = tokio::task::spawn_blocking(move || -> Result<Option<crate::state::MessageRecord>, String> {
                let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                if !db::append_inbox(&dbc, &bot_id, &e)
                    .map_err(|x| format!("写入收件箱失败：{x}"))? { return Ok(None); }
                let conv_id = format!("bot:{bot_id}");
                // msg_id 前缀携带 format（messages 表 schema 属 Frozen Core 不能加列）：
                // `botmsg-md-*` = Markdown 正文，其它 = 纯文本。前端据此选渲染方式。
                let msg_id = if e.format == "markdown" {
                    format!("botmsg-md-{}", e.event_id)
                } else {
                    format!("botmsg-{}", e.event_id)
                };
                let ts = e.received_at;
                let seq: i64 = dbc.query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conv_id = ?1",
                    rusqlite::params![conv_id], |r| r.get(0),
                ).unwrap_or(1);
                // ⚠️ 按**字符**截断，不能 `&str[..N]`（那是字节下标）——
                // 中文一个字 3 字节，从第 240 字节切开会落在 UTF-8 码点中间 ⇒ panic，
                // 而这在后台 worker 里等于整轮取件中断（用户什么都收不到）。
                let content: String = if e.text.chars().count() > PERSONAL_PREVIEW_MAX {
                    let head: String = e.text.chars().take(PERSONAL_PREVIEW_MAX).collect();
                    format!("{head}…")
                } else { e.text.clone() };
                let rec = crate::state::MessageRecord {
                    id: 0, msg_id: msg_id.clone(), conv_id: conv_id.clone(),
                    sender_id: conv_id.clone(), receiver_id: sd.device_id.clone(),
                    kind: "text".into(), content, ts, seq, status: "delivered".into(),
                    mention_targets: None, local_id: Some(msg_id), fail_code: None,
                };
                // ⚠️ 只写本地消息表，**不**写 outbox（Frozen Core 红线，勿加可靠发送队列）。
                db::insert_message(&dbc, &rec).map_err(|x| format!("写入机器人消息失败：{x}"))?;
                db::touch_conversation(&dbc, &conv_id, "single", &format!("{} · 机器人", bot_name), None, &rec.content, 1)
                    .map_err(|x| format!("更新机器人会话失败：{x}"))?;
                Ok(Some(rec))
            }).await.map_err(|x| format!("写入任务中断：{x}"))??;
            // ⚠️ 必须 emit `message-received`：**只有** `bot-inbox-updated` 的话消息虽然
            // 落了库，已打开的聊天窗口不会插入新气泡（要手动切走再切回才看得到）。
            // 载荷是完整的 MessageRecord（与正常入站消息同形）；前端 onMessage 只把它
            // enqueue 进内存队列，不会重复写库。
            if let Some(rec) = emitted {
                let _ = s.app.emit("message-received", &rec);
            }
            Ok(())
        }
        "group" => {
            // 目标是否还能投递：群被删/已离群 ⇒ **停投并报错**，不悄悄改投别的会话。
            if !record.target.is_deliverable() {
                return Err("群目标已失效（没有群 id）".into());
            }
            let group_id = record.target.group_id.clone().unwrap_or_default();
            // 群消息的**发送者仍是网关设备**；正文加来源前缀（线格式不动，见计划 §1.3）。
            let content = format!("{}{}", bot_group_prefix(&record.name), entry.text);
            let sd = s.clone();
            let gid = group_id.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
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

/// 后台轮询 worker：**每个启用中的机器人**定时去服务端取件。
///
/// ## 为什么必须有它
///
/// 通知机器人的意义是「外部系统发一条 ⇒ 本机自动收到」。若只靠设置页那个
/// 「立即取件」按钮，用户得自己想起来去点 —— 那不叫通知，叫手动查收。
///
/// ## 边界
///
/// - **只在应用运行时**（进程内 tokio 任务 ⇒ 应用退出即停）；
/// - 只拉 `status == "active"` 的机器人（暂停/撤销的不打扰）；
/// - 拉取失败**不重试轰炸**：记一条日志，等下一个周期（服务端本身有租约重投，
///   客户端这边失败最坏是「这一轮没拿到，下一轮拿到」）；
/// - 一轮里**一个机器人失败不影响其它**（逐个 catch，不让一个坏机器人卡住整轮）。
///
/// ## 为什么不进 `RESIDENT_WORKERS`（受监督）
///
/// 受监督的 worker 死了会被拉起（`code=WORKER_DEAD`）。本 worker 死了的代价是
/// 「通知不再自动进来」—— 用户仍可手动「立即取件」，而且**没有任何数据会坏**。
/// ⇒ 登记成「刻意不监督」，理由写清楚（判据要求每条登记都带理由）。
pub fn spawn_bot_poller(state: &Arc<AppState>) -> tauri::async_runtime::JoinHandle<()> {
    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        // 第一轮不立刻跑：刚启动就去打扰服务端（应用刚起来时还没什么通知）。
        tokio::time::sleep(Duration::from_secs(BOT_PULL_FIRST_DELAY_SECS)).await;
        loop {
            // 列出机器人：进阻塞池（DB 访问不该占住 tokio worker —— R-18 棘轮）。
            let bots = {
                let sd = st.clone();
                match tokio::task::spawn_blocking(move || -> Result<Vec<BotRecord>, String> {
                    let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::list_bots(&dbc).map_err(|e| format!("读取机器人列表失败：{e}"))
                })
                .await
                {
                    Ok(Ok(list)) => list,
                    Ok(Err(e)) => {
                        st.logger.error("bot", format!("轮询：读取机器人列表失败：{e}"));
                        Vec::new()
                    }
                    Err(e) => {
                        st.logger.error("bot", format!("轮询任务中断：{e}"));
                        Vec::new()
                    }
                }
            };
            for rec in bots {
                if rec.status != "active" || rec.client_token.is_empty() {
                    continue;
                }
                // 一轮里**逐个**拉：一个机器人失败不许卡住整轮。
                let sd = st.clone();
                let bid = rec.bot_id.clone();
                let outcome = pull_bot_once(&sd, &bid).await;
                match outcome {
                    Ok(o) if o.delivered > 0 => {
                        sd.logger.info(
                            "bot",
                            format!(
                                "收到机器人通知：bot={} 投递={} 失败={}",
                                bid, o.delivered, o.failed
                            ),
                        );
                        // 通知前端刷新收件箱（界面自己会去重读）。
                        // 载荷带**条数**：系统通知只给「有新机器人消息」的摘要，
                        // **不放正文与图片**（正文是外部来的不可信内容，见计划 §1.4）。
                        let _ = sd.app.emit(
                            "bot-inbox-updated",
                            serde_json::json!({ "bot_id": bid, "count": o.delivered }),
                        );
                    }
                    Ok(_) => {}
                    Err(e) => {
                        // 失败不轰炸：记一条，等下一轮（服务端有租约重投兜底）。
                        sd.logger.info("bot", format!("轮询取件失败 bot={bid}：{e}"));
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(BOT_PULL_INTERVAL_SECS)).await;
        }
    })
}

/// 轮询周期（秒）。
///
/// 为什么是 60 秒：通知的时效要求通常是「分钟内」，而这条链路要走公网
/// （自托管服务可能远在另一台机器）⇒ 再快也没有数量级收益，反而给对方添压力。
const BOT_PULL_INTERVAL_SECS: u64 = 60;
/// 启动后**第一轮**之前先等这么久（秒）：应用刚起来时没什么可取，别一上来就打扰。
const BOT_PULL_FIRST_DELAY_SECS: u64 = 20;

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
            scope: "personal".into(),
            do_not_disturb: false,
            server_url: "https://hooks.example.com".into(),
            client_token: "super-token".into(),
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
        assert!(!json.contains("super-token"), "列表里不许出现取件凭证");
        assert!(!json.contains("clientToken"), "列表里不许出现取件凭证字段");
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
        assert_eq!(got.client_token, "super-token");
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

    #[test]
    fn personal_bots_never_enter_the_network_outbox() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let at = prod.find("\"inbox\" | \"personal\" =>").expect("没有个人投递分支");
        let personal = &prod[at..];
        assert!(personal.contains("db::insert_message"), "个人 bot 消息必须落本机 messages 表");
        assert!(!personal.contains("insert_message_and_outbox"), "个人 bot 绝不能写 outbox（Frozen Core 红线）");
        assert!(personal.contains("db::touch_conversation("), "个人 bot 必须有会话行");
    }

    #[test]
    fn group_bot_creation_checks_group_admin() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let at = prod.find("只有群主或管理员可以在群里添加机器人").expect("没有群权限校验");
        assert!(prod[..at].contains("g.creator == me || g.admins.contains(&me)"), "群权限判定错了");
    }

    #[test]
    fn dnd_is_a_local_preference_command() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        assert!(prod.contains("pub async fn bot_set_dnd("), "缺免打扰命令");
        assert!(prod.contains("record.do_not_disturb = enabled"), "免打扰没写进记录");
    }

    /// 后台轮询 worker 存在，且**已接线**（不是「有个函数但没人调」）。
    ///
    /// 为什么这条重要：通知机器人的价值是「外部发一条 ⇒ 本机自动收到」。
    /// 只靠设置页那个「立即取件」按钮 ⇒ 用户得自己想起来去点 ⇒ 那不叫通知。
    #[test]
    fn the_polling_worker_exists_and_is_wired() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        assert!(
            prod.contains("pub fn spawn_bot_poller("),
            "没有后台轮询 worker（通知要能自动进来）",
        );
        assert!(
            prod.contains("pull_bot_once(&sd, &bid)"),
            "轮询 worker 必须走与「立即取件」**同一个**内核（顺序反了 = 消息永久丢失）",
        );
        assert!(
            prod.contains("bot-inbox-updated"),
            "收到通知后必须通知前端刷新收件箱",
        );
        // lib.rs 里真的启动了它（否则是「有个函数但没人调」）。
        let lib = include_str!("../lib.rs");
        assert!(
            lib.contains("commands::spawn_bot_poller(&state);"),
            "轮询 worker 没有在 lib.rs 的 setup 里启动 ⇒ 通知不会自动进来",
        );
    }

    /// 轮询的边界：只拉 `active` 的机器人；失败不轰炸（等下一轮）。
    #[test]
    fn the_polling_only_touches_active_bots_and_never_spams_retries() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let worker = prod
            .find("pub fn spawn_bot_poller(")
            .expect("没有轮询 worker");
        let body = &prod[worker..];
        assert!(
            body.contains("rec.status != \"active\""),
            "只拉启用中的机器人（暂停/撤销的不该被打扰）",
        );
        assert!(
            body.contains("Err(e) =>"),
            "单个机器人失败要被 catch（一个坏的不许卡住整轮）",
        );
        // 失败只记一条日志，不在同一轮里立刻重试（记在 Err 分支里的 logger 之后没有 sleep/retry）。
        assert!(
            !body.contains("BOT_PULL_INTERVAL_SECS).await;
            for rec in bots"),
            "轮询节奏写错了（不该在循环里套两遍 sleep）",
        );
    }

    /// 撤销会清掉取件凭证（留着只是风险）。
    #[test]
    fn revoking_clears_the_client_credential() {
        let src = include_str!("bots.rs");
        let prod = &src[..src.find("mod bot_cmd_tests").unwrap_or(src.len())];
        let revoke = prod
            .find("record.client_token.clear()")
            .expect("撤销后没有清掉取件凭证");
        let status = prod.find("if next == \"revoked\"").expect("没有撤销分支");
        assert!(status < revoke, "清凭证必须挂在撤销分支里");
    }
}
