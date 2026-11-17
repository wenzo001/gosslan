// 职责边界：
// - 通知机器人（Webhook bot）的**命令层**：注册 / 列表 / 状态 / 删除 / 取件 / 收件箱。
//   服务端在独立仓库 `wenzo001/gosslan-relay-server`（`server.mjs` + `notify.mjs`），
//   部署与接口契约见该仓库 `README-v7-notify.md`；主仓的完整使用说明见
//   `docs/notify-bot-guide.md`。
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
/// 服务端长轮询最多挂 15s ⇒ HTTP 超时要留足余量（否则每次空轮都超时报错）。
const BOT_HTTP_TIMEOUT_SECS: u64 = 25;
/// 机器人名字上限（显示用）。
const BOT_NAME_MAX: usize = 60;

// ---------------- 纯逻辑（可单测） ----------------

/// 服务地址规范化：http / https 都接受（内网可按 IP 直连 59994）。
///
/// 服务端 59994 默认就是明文 HTTP，且通知服务的取舍是「可信网络 / 内网直连」，
/// 因此 http 与 https 都接受；公网部署应由 nginx 反代终结 TLS（见使用说明）。
pub fn normalize_bot_server(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "请填写通知服务地址，例如 http://你的服务器:59994",
        ));
    }
    // 审计：用**标准 URL parser**（此前是字符串 split，userinfo / 非法端口 /
    // query / fragment 都能混过去，甚至 `https://user:pass@evil.com` 被当成合法）。
    let parsed = url::Url::parse(raw).map_err(|_| {
        crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址不是合法 URL（要带 http:// 或 https://）",
        )
    })?;
    // 只接受 http/https：服务端 59994 默认明文 HTTP，允许内网按 IP 直连；
    // 公网部署要用 HTTPS 反代（见 `docs/notify-bot-guide.md`）。其它 scheme 一律拒绝。
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址必须带 http:// 或 https://",
        ));
    }
    // 只接受「scheme://host[:port]」这一种形状 ⇒ 不接受 userinfo / query / fragment /
    // 路径里带东西（服务端地址是根，endpoint 由客户端按 bot_id 拼）。
    if !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.query().is_some() || parsed.fragment().is_some()
        || parsed.path() != "/" {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址只能写 scheme://主机[:端口]（不要带路径 / 参数 / 账号密码）",
        ));
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_SERVER_INVALID,
            "通知服务地址缺少主机名",
        ));
    }
    // Url::parse 会拒绝非法端口（>65535），这里拿 origin 作为归一化结果（去掉尾斜杠）。
    Ok(parsed.origin().ascii_serialization())
}

/// 外部发送者用的 endpoint（给用户复制的那条）。
/// 外部发送者用的 endpoint（认证 token 就在 URL 路径里，一条 curl 可发）。
pub fn bot_hook_endpoint(server_url: &str, send_token: &str) -> String {
    format!("{}/publish/{send_token}", server_url.trim_end_matches('/'))
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
    /// 外部发通知的完整 URL（资料页展示/复制用）。
    pub publish_url: String,
    /// 用户可编辑的头像（SVG data URL；空 = 种子默认脸）。
    pub avatar: String,
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
            publish_url: r.publish_url.clone(),
            avatar: r.avatar.clone(),
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

/// 极简协议：服务端只生成两把 token + publish_url（认证在 URL，不用 header）。
#[derive(Deserialize)]
struct ServerBotCreated {
    #[serde(default)]
    bot_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    target: BotTarget,
    send_token: String,
    client_token: String,
    #[serde(default)]
    publish_url: String,
}

#[derive(Deserialize, Clone)]
#[allow(dead_code)] // 服务端信封里的字段（schema / created_at）本仓只读其中一部分。
struct ServerEnvelope {
    #[serde(default)]
    schema: String,
    /// 字段名是 `id`，旧版是 `event_id` —— 两个都收（本地统一用 event_id）。
    #[serde(alias = "id")]
    event_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    format: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    images: Vec<BotImage>,
    #[serde(default)]
    created_at: String,
    /// 群机器人管理指令（服务端只透传，白名单在客户端）。
    #[serde(default)]
    action: Option<serde_json::Value>,
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
#[allow(clippy::too_many_arguments)] // 新增 scope / dnd 两个可选参数，参数面本来就是命令入口契约
pub async fn bot_create(
    state: State<'_, Arc<AppState>>,
    name: String,
    scope: String,
    target_group_id: Option<String>,
    target_group_name: Option<String>,
    server_url: String,
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
    // 审计：未知 scope **拒绝**，不能静默当成个人机器人
    // （否则前端传错值会建出一个用户没预期的机器人）。
    let scope_norm = match scope.trim() {
        "group" => "group",
        "personal" | "inbox" => "personal", // inbox = v5 旧名，兼容
        _ => {
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_TARGET_INVALID,
                "机器人作用域只能是 personal（个人会话）或 group（群）",
            ))
        }
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

    // 群机器人只有群主/管理员能创建（前端隐藏不算权限，命令 fail-closed）。
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
    // `POST /v1/bots`，body 只带 name/scope/group_id —— 不需要引导令牌/请求头。
    let body = serde_json::to_string(&serde_json::json!({
        "name": bot_name,
        "scope": scope_norm,
        "group_id": target.group_id.clone().unwrap_or_default(),
    })).map_err(|e| format!("请求体序列化失败：{e}"))?;
    let resp = client
        .post(format!("{server}/v1/bots"))
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
    // 服务端只给两把 token；bot_id 本地从 send_token 派生（稳定且唯一）。
    let bot_id = if created.bot_id.is_empty() {
        format!("bot_{}", created.send_token.chars().take(16).collect::<String>())
    } else { created.bot_id.clone() };
    let record = BotRecord {
        bot_id: bot_id.clone(),
        name: if created.name.trim().is_empty() { bot_name } else { created.name },
        scope: scope_norm.to_string(),
        do_not_disturb: do_not_disturb.unwrap_or(false),
        avatar: String::new(), // 默认种子脸；用户可在详情页改
        publish_url: if created.publish_url.is_empty() {
            bot_hook_endpoint(&server, &created.send_token)
        } else {
            format!("{}{}", server, created.publish_url)
        },
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
        Some(format!("bot:{}", bot_id))
    } else { None };
    let bot_name_for_conv = record.name.clone();
    let persist = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::save_bot(&dbc, &record).map_err(|e| format!("保存机器人失败：{e}"))?;
        // 个人机器人当场进会话列表（像联系人一样），哪怕还没收到第一条通知。
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
        let _ = client.delete(format!("{server}/v1/bots/{}", created.client_token)).send().await;
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_CREATE_FAILED,
            e,
        ));
    }

    // ⚠️ 发送密钥**只在这里返回一次**：之后列表接口不再回显（前端要用户当场复制）。
    Ok(BotCreatedView {
        bot: view,
        send_token: created.send_token.clone(),
        endpoint: if created.publish_url.is_empty() {
            bot_hook_endpoint(&server, &created.send_token)
        } else { format!("{}{}", server, created.publish_url) },
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

/// 免打扰（只影响系统通知/任务栏闪烁，不影响进会话与未读角标）。
#[tauri::command(async)]
pub async fn bot_set_dnd(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
    enabled: bool,
) -> Result<BotView, String> {
    let s = state.inner().clone();
    // 字段级更新：一次 spawn_blocking 内持锁读改写，不与轮询统计互相覆盖。
    let bid = bot_id.clone();
    let record = tokio::task::spawn_blocking(move || -> Result<Option<BotRecord>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_bot_dnd(&dbc, &bid, enabled).map_err(|e| format!("保存机器人失败：{e}"))
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))??;
    let Some(record) = record else {
        return Err(crate::error_codes::coded(crate::error_codes::BOT_NOT_FOUND, "机器人不存在"));
    };
    Ok(BotView::from(&record))
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
    // 极简协议：服务端只有 DELETE（撤销）= hook 立即失效；
    // pause/resume 只是本机开关（轮询时不拉 paused 的机器人），不再问服务端。
    if next == "revoked" {
        let client = bot_client()?;
        let resp = client
            .delete(format!("{}/v1/bots/{}", record.server_url, record.client_token))
            .send()
            .await
            .map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::BOT_STATUS_FAILED,
                    format!("连不上通知服务，撤销失败（本地已保留，可重试）：{e}"),
                )
            })?;
        if !resp.status().is_success() {
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_STATUS_FAILED,
                format!("服务端拒绝撤销（HTTP {}），本地已保留，可重试", resp.status()),
            ));
        }
    }
    record.status = next.to_string();
    // 撤销：清 token 前先记墓碑 ⇒ 后台能清掉服务端残留的孤儿消息（本机再也不会拉这个 token）。
    let tombstone = if next == "revoked" && !record.client_token.is_empty() {
        Some((record.client_token.clone(), record.server_url.clone()))
    } else { None };
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
        if let Some((token, url)) = tombstone {
            db::add_bot_tombstone(&dbc, &token, &url)
                .map_err(|e| format!("记录撤销墓碑失败：{e}"))?;
        }
        if let Some(cid) = conv_to_drop { let _ = db::delete_conversation(&dbc, &cid); }
        Ok(())
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))??;
    Ok(view)
}

/// 用户编辑机器人名字 / 头像（2026-11-17）。
///
/// 字段级更新：一次 `spawn_blocking` 内持锁读-改-写，不与轮询统计互相覆盖；
/// 个人机器人同时更新会话表的名字/头像 ⇒ 会话列表立即跟着变（群机器人没有个人会话）。
#[tauri::command(async)]
pub async fn bot_set_profile(
    state: State<'_, Arc<AppState>>,
    bot_id: String,
    name: String,
    avatar: Option<String>,
    server_url: Option<String>,
) -> Result<BotView, String> {
    let s = state.inner().clone();
    let clean_name: String = name.trim().chars().take(BOT_NAME_MAX).collect();
    if clean_name.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::BOT_TARGET_INVALID,
            "机器人名字不能为空",
        ));
    }
    let bid = bot_id.clone();
    let view = tokio::task::spawn_blocking(move || -> Result<BotView, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut rec = db::load_bot(&dbc, &bid)
            .map_err(|e| format!("读取机器人失败：{e}"))?
            .ok_or_else(|| crate::error_codes::coded(crate::error_codes::BOT_NOT_FOUND, "机器人不存在"))?;
        rec.name = clean_name;
        if let Some(a) = avatar {
            rec.avatar = a.chars().take(8192).collect();
        }
        // 地址也可改（用户 2026-11-17）：同样走标准 URL 校验，拒 userinfo/query/fragment。
        // ⚠️ 换服务地址不等于迁移 token —— 新服务上得先建同名机器人，否则取件会 401；
        //    bot_id 创建后**永不改变**（它是会话 id 的一部分，改了会丢历史）。
        if let Some(u) = server_url {
            if !u.trim().is_empty() {
                rec.server_url = normalize_bot_server(&u)?;
            }
        }
        db::save_bot(&dbc, &rec).map_err(|e| format!("保存机器人资料失败：{e}"))?;
        if rec.target.kind != "group" {
            db::update_conversation_profile(
                &dbc,
                &format!("bot:{bid}"),
                &rec.name,
                if rec.avatar.is_empty() { None } else { Some(&rec.avatar) },
            )
            .map_err(|e| format!("更新机器人会话资料失败：{e}"))?;
        }
        Ok(BotView::from(&rec))
    })
    .await
    .map_err(|e| format!("保存任务中断：{e}"))??;
    Ok(view)
}

/// 删除机器人（**先远端撤销、成功后才清本地**）。
///
/// 审计：此前「本地先删、远端撤销尽力而为并吞掉失败」⇒
/// 远端 token 可能仍有效（谁拿着旧 hook 还能发），而本地已经没有记录了，
/// 用户既看不到也重试不了。现在顺序反过来：远端失败 ⇒ 报错 + 本地保留 ⇒ 可重试。
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
    let Some(rec) = record else {
        return Err(crate::error_codes::coded(crate::error_codes::BOT_NOT_FOUND, "机器人不存在"));
    };

    // ① 先撤销远端（真正的「hook 失效」裁决方）。失败 ⇒ 报错，本地**不删**，可重试。
    if !rec.client_token.is_empty() {
        let client = bot_client()?;
        let resp = client
            .delete(format!("{}/v1/bots/{}", rec.server_url, rec.client_token))
            .send()
            .await
            .map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::BOT_STATUS_FAILED,
                    format!("连不上通知服务，未能撤销 hook（本地记录已保留，可重试）：{e}"),
                )
            })?;
        if !resp.status().is_success() {
            return Err(crate::error_codes::coded(
                crate::error_codes::BOT_STATUS_FAILED,
                format!(
                    "通知服务拒绝了撤销（HTTP {}），本地记录已保留，可重试",
                    resp.status()
                ),
            ));
        }
    }

    // ② 远端确认撤销后才清本地：记录 + 收件箱 + 个人会话（与 set_status(revoked) 同口径）。
    let is_personal = rec.target.kind != "group";
    let sd = s.clone();
    let bid = bot_id.clone();
    // 墓碑：万一删除前已有消息入队（或服务端清队列有延迟），记下 token 让后台清孤儿。
    let tomb_token = rec.client_token.clone();
    let tomb_url = rec.server_url.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
        db::delete_bot(&dbc, &bid).map_err(|e| format!("删除机器人失败：{e}"))?;
        db::clear_inbox(&dbc, &bid).map_err(|e| format!("清空收件箱失败：{e}"))?;
        db::add_bot_tombstone(&dbc, &tomb_token, &tomb_url)
            .map_err(|e| format!("记录删除墓碑失败：{e}"))?;
        if is_personal {
            let _ = db::delete_conversation(&dbc, &format!("bot:{bid}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除任务中断：{e}"))??;
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
    pull_bot_once(&s, &bot_id, 0).await // 手动「立即取件」不等待
}

/// 拉一次件并投递（**先落本地、再 ACK**）—— 命令与后台轮询 worker 共用的内核。
///
/// 为什么要拆成内部函数：后台 worker 不走 Tauri 命令通道，拿不到 `State`；
/// 两边共用同一份内核 ⇒ 「手动立即取件」与「自动轮询」的语义**必然一致**
/// （顺序反了 = 消息永久丢失，这是这一族最贵的错）。
async fn pull_bot_once(s: &Arc<AppState>, bot_id: &str, wait_secs: u64) -> Result<BotPullOutcome, String> {
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
    // GET /pull/<client_token>?wait=N，认证在 URL，不要 header/body。
    // 后台轮询传 15（长轮询：新消息一到立刻返回）；手动取件传 0（立即返回）。
    let pull_url = if wait_secs > 0 {
        format!("{}/pull/{}?wait={}", record.server_url, record.client_token, wait_secs)
    } else {
        format!("{}/pull/{}", record.server_url, record.client_token)
    };
    let resp = client
        .get(&pull_url)
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
            action: ev.action.clone(),
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
        // 极简协议：只有投递成功才 `GET /ack/<client_token>/<event_id>`；
        // 失败**不 ack** ⇒ 服务端继续留存，下一轮还能取到（本地 event_id 幂等挡重复）。
        // 没有 nack / 租约 / 幂等键 —— 按用户 2026-11-17 的简化决定。
        if ok {
            let ack_url = format!(
                "{}/ack/{}/{}",
                record.server_url, record.client_token, entry.event_id
            );
            match client.get(&ack_url).send().await {
                Ok(resp) if resp.status().is_success() => {}
                other => {
                    // ack 失败不是灾难：服务端留存 ⇒ 下轮重投，本地幂等挡重复。
                    s.logger.info(
                        "bot",
                        format!("event={} ack 未确认（{other:?}），下轮靠本地幂等兜底", entry.event_id),
                    );
                }
            }
        }
    }
    // 字段级回写统计（审计）：持锁读最新记录再改统计字段，
    // 不覆盖期间用户改的 DND / 状态；没取到事件也不推进 last_event_at。
    {
        let sd = s.clone();
        let bid = bot_id.clone();
        let pulled = outcome.pulled;
        let failed = outcome.failed;
        let last_ev = if pulled > 0 { Some(db::now_ms()) } else { None };
        let last_err = if failed > 0 { Some(format!("{failed} 条投递失败")) } else { None };
        let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::update_bot_poll_stats(&dbc, &bid, pulled, failed, last_ev, last_err)
                .map_err(|e| format!("保存机器人统计失败：{e}"))
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
    // 审计：服务端契约写了 images，但客户端首版**没有**附件下载/校验/渲染链路。
    // 不能假装支持（把 metadata 当图片），也不能 NACK（会无限重投）⇒
    // 明确在正文里告知「图片未随通知送达」，并照常 ACK。
    let mut normalized = entry.clone();
    if !entry.images.is_empty() {
        let n = entry.images.len();
        normalized.text = format!(
            "{}\n\n⚠️ 这条通知附带 {n} 张图片，当前版本**不支持图片通知**；请让发送方改用文字描述。",
            entry.text
        );
    }
    let entry = &normalized;
    match record.target.kind.as_str() {
        "inbox" | "personal" => {
            // 个人机器人 = 本机假身份会话。消息落 messages + 会话列表，
            // sender_id = conv_id = `bot:<id>` ⇒ **不写 outbox** ⇒ 不上网络、不跨设备。
            let bot_id = record.bot_id.clone();
            let bot_name = record.name.clone();
            let e = entry.clone();
            let sd = s.clone();
            let emitted = tokio::task::spawn_blocking(move || -> Result<Option<crate::state::MessageRecord>, String> {
                let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                // ⚠️ 审计：去重标记、消息行、会话行必须**同一事务**。
                // 此前 append_inbox 成功但消息写失败时，重投会命中「已去重」直接 ACK
                // ⇒ 聊天消息永久缺失（用户永远看不到那条通知）。
                let tx = dbc.unchecked_transaction()
                    .map_err(|x| format!("开启机器人投递事务失败：{x}"))?;
                if !db::append_inbox(&tx, &bot_id, &e)
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
                let seq: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conv_id = ?1",
                    rusqlite::params![conv_id], |r| r.get(0),
                ).unwrap_or(1);
                // 审计：消息体必须存**全文**（服务端已限 8192 字节），
                // 会话列表的「显示几行」交给 UI 的 line-clamp —— 不能在落库时截断，
                // 否则用户永远看不到全文（此前截 240 字且无全文入口）。
                let content: String = e.text.clone();
                let rec = crate::state::MessageRecord {
                    id: 0, msg_id: msg_id.clone(), conv_id: conv_id.clone(),
                    sender_id: conv_id.clone(), receiver_id: sd.device_id.clone(),
                    kind: "text".into(), content, ts, seq, status: "delivered".into(),
                    mention_targets: None, local_id: Some(msg_id), fail_code: None,
                };
                // ⚠️ 只写本地消息表，**不**写 outbox（Frozen Core 红线，勿加可靠发送队列）。
                db::insert_message(&tx, &rec).map_err(|x| format!("写入机器人消息失败：{x}"))?;
                db::touch_conversation(&tx, &conv_id, "single", &format!("{} · 机器人", bot_name), None, &rec.content, 1)
                    .map_err(|x| format!("更新机器人会话失败：{x}"))?;
                // 三处全成功才提交 ⇒ 任何一步失败整体回滚，重投能重新走完整路径。
                tx.commit().map_err(|x| format!("提交机器人投递事务失败：{x}"))?;
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
            // 审计：群消息按 event_id 幂等 —— ACK 丢失导致租约重投时，
            // 同一条不能重复发进群。去重记录**独立于可裁剪的 inbox**（固定 200 条窗口）。
            let already = {
                let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                db::was_delivered(&dbc, &record.bot_id, &entry.event_id)
                    .map_err(|x| format!("检查群消息去重失败：{x}"))?
            };
            if already {
                s.logger.info(
                    "bot",
                    format!("群消息 event={} 已投递过，跳过重投", entry.event_id),
                );
                return Ok(());
            }
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
            // 白名单群管理指令（第三方通过 Webhook 正文 action 触发）。
            // 只认 create_todo；其它 type 一律**当普通通知处理**（不执行、不报错），
            // 杜绝构造 action 触达踢人/任免/转让等危险路径。
            if let Some(action) = entry.action.as_ref() {
                let kind = action.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "create_todo" {
                    // 双重校验：机器人 scope=group + 本机仍是该群管理员（权限撤销后立即失效）。
                    let permitted = {
                        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
                        match db::get_group(&dbc, &group_id) {
                            Some(g) => g.is_manager(&s.device_id),
                            None => false,
                        }
                    };
                    if permitted {
                        let title = action.get("title").and_then(|v| v.as_str())
                            .filter(|t| !t.trim().is_empty())
                            .map(|t| t.chars().take(120).collect::<String>())
                            .unwrap_or_else(|| entry.text.chars().take(60).collect());
                        // 发内部事件让前端调既有 send_group_todo（不复制建任务逻辑）。
                        let _ = s.app.emit("bot-group-action", serde_json::json!({
                            "type": "create_todo",
                            "groupId": group_id,
                            "title": title,
                            "botName": record.name,
                        }));
                        s.logger.info("bot", format!("群机器人 {} 触发建任务：{title}", record.bot_id));
                    } else {
                        s.logger.info("bot", format!("群机器人 {} 的建任务被拒（已非管理员）", record.bot_id));
                    }
                }
            }
            let sent = send_group_payload(s, &group_id, "text", content, None, None, None)
                .await
                .map(|_| ())
                .map_err(|e| format!("发进群失败：{e}"));
            if sent.is_ok() {
                // **只在真发出去之后**记去重标记；失败不留标记 ⇒ 重投能重试。
                let sd = s.clone();
                let bid = record.bot_id.clone();
                let eid = entry.event_id.clone();
                let eid_for_log = eid.clone();
                let marked = tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::mark_delivered(&dbc, &bid, &eid)
                        .map(|_| ())
                        .map_err(|e| format!("记录群消息去重失败：{e}"))
                })
                .await;
                if let Err(e) = marked {
                    // 已发出但去重没记上 ⇒ 重申风险可观测（不能假装 exactly-once）。
                    s.logger.error("bot", format!("event={eid_for_log} {e}：服务端重投可能重复发一条"));
                }
            }
            sent
        }
        _ => Err("投递目标类型不认识".into()),
    }
}

/// 孤儿消息兜底（用户 2026-11-17）：本机已删但服务端 token 还在时，
/// 第三方发给它的消息会在服务端积压 7 天没人取。这里用墓碑 token 把残留**全部 ACK 丢弃**
/// （只删服务端队列，本机不投递不入队），清到空 ⇒ 墓碑自删。
/// 返回本轮丢弃的条数。
async fn purge_tombstoned_events(s: &Arc<AppState>) -> u32 {
    let tombstones: Vec<db::BotTombstone> = {
        let sd = s.clone();
        match tokio::task::spawn_blocking(move || -> Result<Vec<db::BotTombstone>, String> {
            let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
            db::list_bot_tombstones(&dbc).map_err(|e| format!("读取墓碑失败：{e}"))
        }).await {
            Ok(Ok(v)) => v,
            _ => return 0,
        }
    };
    if tombstones.is_empty() { return 0; }
    let Ok(client) = bot_client() else { return 0 };
    let mut dropped = 0u32;
    for t in tombstones {
        let url = format!("{}/pull/{}", t.server_url.trim_end_matches('/'), t.client_token);
        let events: Vec<serde_json::Value> = match client.get(&url).send().await {
            Ok(r) if r.status().is_success() => {
                let body: serde_json::Value = serde_json::from_str(&r.text().await.unwrap_or_default())
                    .unwrap_or_default();
                body.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default()
            }
            // 401 = 服务端 token 已被删（正常收敛）⇒ 墓碑可以清掉。
            Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => {
                let sd = s.clone(); let tok = t.client_token.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                    db::remove_bot_tombstone(&dbc, &tok)
                }).await;
                continue;
            }
            _ => continue, // 网络抖动 ⇒ 下轮再试，不误删墓碑
        };
        for ev in &events {
            let id = ev.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() { continue; }
            let ack = format!("{}/ack/{}/{}", t.server_url.trim_end_matches('/'), t.client_token, id);
            if client.get(&ack).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
                dropped += 1;
            }
        }
        // 这个 token 已清空 ⇒ 删墓碑（下次不再拉）。
        if events.is_empty() {
            let sd = s.clone(); let tok = t.client_token.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let dbc = sd.db.lock().unwrap_or_else(|e| e.into_inner());
                db::remove_bot_tombstone(&dbc, &tok)
            }).await;
        }
    }
    dropped
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
            // 先清孤儿消息（本机已删但服务端残留的 token）——不让它们在服务端积压。
            let purged = purge_tombstoned_events(&st).await;
            if purged > 0 {
                st.logger.info("bot", format!("已丢弃 {purged} 条已删除机器人的孤儿通知"));
            }
            for rec in bots {
                if rec.status != "active" || rec.client_token.is_empty() {
                    continue;
                }
                // 一轮里**逐个**拉：一个机器人失败不许卡住整轮。
                let sd = st.clone();
                let bid = rec.bot_id.clone();
                let outcome = pull_bot_once(&sd, &bid, BOT_LONG_POLL_SECS).await;
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
                        // 失败不轰炸：日志 + 把原因写进 bot.last_error（详情可见）。
                        // 否则用户只会「一直收不到」却不知道为什么（审计 P2）。
                        sd.logger.info("bot", format!("轮询取件失败 bot={bid}：{e}"));
                        let sd2 = sd.clone();
                        let bid2 = bid.clone();
                        let reason = e.clone();
                        let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
                            let dbc = sd2.db.lock().unwrap_or_else(|x| x.into_inner());
                            let mut rec = match db::load_bot(&dbc, &bid2) {
                                Ok(Some(r)) => r,
                                _ => return Ok(()),
                            };
                            rec.last_error = Some(reason.chars().take(200).collect());
                            db::save_bot(&dbc, &rec).map_err(|x| format!("记录轮询错误失败：{x}"))
                        }).await;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(BOT_PULL_INTERVAL_SECS)).await;
        }
    })
}

/// 长轮询等待上限（秒）：队列空时服务端挂起请求，新消息一到立即返回。
const BOT_LONG_POLL_SECS: u64 = 15;

/// 两轮之间的间隔（秒）。长轮询已把「消息到 → 客户端知道」压到秒级，
/// 这里只需在长轮询返回后快速再挂下一轮（不是消息延迟的来源）。
///
/// 历史：此前是 60 秒纯轮询，用户报「curl 发了但收到很慢」⇒ 改长轮询 + 短间隔。
/// 原 60 秒的理由（通知时效通常「分钟内」、链路走公网）已不再适用。
/// （自托管服务可能远在另一台机器）⇒ 再快也没有数量级收益，反而给对方添压力。
const BOT_PULL_INTERVAL_SECS: u64 = 2;
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
            avatar: String::new(),
            publish_url: "https://hooks.example.com/publish/token".into(),
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

    /// 审计：URL parser 必须挡住 userinfo / query / fragment / 非法端口 / 路径。
    #[test]
    fn server_url_rejects_tricky_shapes() {
        for bad in [
            "https://user:pass@hooks.example.com",     // userinfo（凭证会被塞进 URL）
            "https://hooks.example.com?token=abc",     // query（密钥会进日志）
            "https://hooks.example.com/#frag",         // fragment
            "https://hooks.example.com:99999",         // 非法端口
            "https://hooks.example.com/v1/hooks",      // 带路径（endpoint 由客户端拼）
            "not-a-url",                                // 没 scheme
            "ftp://hooks.example.com",                  // 不支持的协议
        ] {
            assert!(normalize_bot_server(bad).is_err(), "危险地址不该通过：{bad}");
        }
        // 合法带端口 / IPv6 回环仍要过
        assert!(normalize_bot_server("https://hooks.example.com:8443").is_ok());
        assert!(normalize_bot_server("http://[::1]:59994").is_ok());
    }

    /// 服务地址接受 http/https（内网可直连 IP）；危险形状仍一律拒绝。
    #[test]
    fn server_address_accepts_http_and_https() {
        assert_eq!(
            normalize_bot_server("https://hooks.example.com/").unwrap(),
            "https://hooks.example.com"
        );
        // 回环 http 可直连
        assert_eq!(
            normalize_bot_server("http://127.0.0.1:59994").unwrap(),
            "http://127.0.0.1:59994"
        );
        assert_eq!(
            normalize_bot_server("http://localhost:59994").unwrap(),
            "http://localhost:59994"
        );
        // 非回环 http（内网 IP:端口）也放行 —— 服务端 59994 默认就是明文 HTTP
        assert_eq!(
            normalize_bot_server("http://192.168.1.10:59994").unwrap(),
            "http://192.168.1.10:59994"
        );
        // 但危险形状仍然拒绝
        assert!(normalize_bot_server("ftp://hooks.example.com").is_err());
        // 缺协议 / 空 / 垃圾
        assert!(normalize_bot_server("").is_err());
        assert!(normalize_bot_server("hooks.example.com").is_err());
        assert!(normalize_bot_server("https://").is_err());
    }

    /// 外部发送者拿到的 endpoint 与状态取值。
    #[test]
    fn endpoint_and_status_normalization() {
        // 认证在 URL 路径里，一条 curl 可发（GET/POST/PUT 都兼容）。
        assert_eq!(
            bot_hook_endpoint("https://hooks.example.com/", "tok_x"),
            "https://hooks.example.com/publish/tok_x"
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
            action: None,
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
            .find("client.get(&ack_url)")
            .expect("没有 ACK 调用（GET /ack/<client_token>/<id>）");
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
        assert!(
            prod.contains("db::set_bot_dnd("),
            "免打扰必须走字段级原子更新（同一把锁内读改写，不与轮询统计互相覆盖）",
        );
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
            prod.contains("pull_bot_once(&sd, &bid, BOT_LONG_POLL_SECS)"),
            "轮询 worker 必须走与「立即取件」**同一个**内核（顺序反了 = 消息永久丢失）",
        );
        // 2026-11-17：长轮询已接线 —— 服务端队列空时挂起，新消息立即唤醒返回。
        // 拆掉任一环（URL 的 wait 参数 / 15s 上限 / 短间隔 / 超时余量）都会让「curl 收到很慢」复发。
        assert!(
            prod.contains("/pull/{}?wait={}"),
            "后台取件没带 wait 参数 ⇒ 退回 60s 纯轮询，外部发通知要等很久",
        );
        assert!(
            prod.contains("const BOT_LONG_POLL_SECS: u64 = 15;"),
            "长轮询上限丢了（须小于服务端 15s 上限与客户端 HTTP 超时）",
        );
        assert!(
            prod.contains("const BOT_PULL_INTERVAL_SECS: u64 = 2;"),
            "长轮询返回后必须快速再挂下一轮，否则仍要空等 60s",
        );
        assert!(
            prod.contains("const BOT_HTTP_TIMEOUT_SECS: u64 = 25;"),
            "HTTP 超时必须大于长轮询等待上限，否则每轮空转都报超时",
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
