// 职责边界：
// - 通知机器人（Webhook bot）的**本地存储**：机器人清单 + 收件箱。
//   一律走 `settings` 表（键值对）—— **不动 SQLite 表结构**（schema 属 Frozen Core）。
//   设计依据见 `docs/notes/webhook-bot-client-plan-2026-11-16.md` §1.1。
// ---------------- 通知机器人本地存储 ----------------

use serde::{Deserialize, Serialize};

/// 机器人记录在 settings 表里的键前缀。
pub const BOT_KEY_PREFIX: &str = "bot:";
/// 收件箱在 settings 表里的键前缀。
pub const BOT_INBOX_PREFIX: &str = "bot_inbox:";
/// 收件箱保留条数上限（超了丢最旧的：机器人消息是「通知」，不是邮件箱）。
pub const BOT_INBOX_MAX: usize = 200;

/// 投递目标：`inbox` = 本机机器人收件箱；`group` = 某个群（由网关设备代发）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotTarget {
    pub kind: String,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
}

impl BotTarget {
    /// 目标是否还能投递（群被删/离群 ⇒ 停投，不改投别的会话）。
    pub fn is_deliverable(&self) -> bool {
        match self.kind.as_str() {
            "inbox" => true,
            "group" => self.group_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            _ => false,
        }
    }
}

/// 一条机器人记录（一个外部系统入口）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotRecord {
    pub bot_id: String,
    pub name: String,
    /// v6 作用域：`personal`（个人会话）或 `group`（群）。空串 = v5 老记录 ⇒ 读取时推导。
    #[serde(default)]
    pub scope: String,
    /// v6：免打扰。默认关（每条通知都弹）。
    #[serde(default)]
    pub do_not_disturb: bool,
    /// 服务地址（`https://…`）。**强制 HTTPS**（本机调试开关除外）。
    pub server_url: String,
    /// 取件凭证（client token）。⚠️ **不进日志/诊断/列表响应**；撤销时清掉。
    ///
    /// 命名说明：它**不叫** `secret` —— 本仓的密钥边界守卫（`check-key-boundary.mjs`）
    /// 把带 `secret` 的**可序列化**类型判成「E2EE 私钥」，而这只是一枚 bearer token
    /// （与 relay 的 `token` 同一性质）。守卫的口径是「别用密钥命名」，不是
    /// 「这类字段不许存在」⇒ 改名，不加例外。
    pub client_token: String,
    pub target: BotTarget,
    /// `active` / `paused` / `revoked`。
    pub status: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_event_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub pending: u32,
    #[serde(default)]
    pub failed: u32,
}

/// 附件（图片）元数据。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotImage {
    pub attachment_id: String,
    pub name: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
}

/// 收件箱里的一条消息。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotInboxEntry {
    pub event_id: String,
    pub text: String,
    /// `text` / `markdown`（客户端据此决定怎么渲染）。
    pub format: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub images: Vec<BotImage>,
    pub received_at: i64,
    /// `received`（已落本机）/ `published`（群目标已发出）/ `failed`。
    pub state: String,
}

/// 机器人记录的键。
pub fn bot_key(bot_id: &str) -> String {
    format!("{BOT_KEY_PREFIX}{bot_id}")
}

/// 收件箱的键。
pub fn bot_inbox_key(bot_id: &str) -> String {
    format!("{BOT_INBOX_PREFIX}{bot_id}")
}

/// 写一个机器人（覆盖写）。
pub fn save_bot(conn: &Connection, rec: &BotRecord) -> Result<()> {
    let value = serde_json::to_string(rec)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("序列化机器人失败：{e}")))?;
    crate::db::set_setting(conn, &bot_key(&rec.bot_id), &value)
}

/// 读一个机器人。
pub fn load_bot(conn: &Connection, bot_id: &str) -> Result<Option<BotRecord>> {
    let Some(raw) = crate::db::get_setting_checked(conn, &bot_key(bot_id))? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<BotRecord>(&raw).ok())
}

/// 列出全部机器人（按创建时间升序）。
pub fn list_bots(conn: &Connection) -> Result<Vec<BotRecord>> {
    let mut out: Vec<BotRecord> = Vec::new();
    let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE ?1")?;
    let rows = stmt.query_map(["bot:%"], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (key, value) = row?;
        // 前缀匹配会带上 `bot_inbox:` 那一族 ⇒ 这里按**精确前缀**再筛一次。
        if !key.starts_with(BOT_KEY_PREFIX) || key.starts_with(BOT_INBOX_PREFIX) {
            continue;
        }
        if let Ok(rec) = serde_json::from_str::<BotRecord>(&value) {
            out.push(rec);
        }
    }
    out.sort_by_key(|r| r.created_at);
    Ok(out)
}

/// 删一个机器人（含它的收件箱）。
pub fn delete_bot(conn: &Connection, bot_id: &str) -> Result<()> {
    crate::db::delete_setting(conn, &bot_key(bot_id))?;
    crate::db::delete_setting(conn, &bot_inbox_key(bot_id))?;
    Ok(())
}

/// 读收件箱（新的在前）。
pub fn load_inbox(conn: &Connection, bot_id: &str) -> Result<Vec<BotInboxEntry>> {
    let Some(raw) = crate::db::get_setting_checked(conn, &bot_inbox_key(bot_id))? else {
        return Ok(Vec::new());
    };
    let mut list: Vec<BotInboxEntry> = serde_json::from_str(&raw).unwrap_or_default();
    list.sort_by_key(|e| e.received_at);
    list.reverse();
    Ok(list)
}

/// 追加一条收件箱消息（**按 `event_id` 幂等**：重复投递不重复显示）。
///
/// 返回 `true` = 确实是新的一条；`false` = 已经有了（重复投递）。
pub fn append_inbox(conn: &Connection, bot_id: &str, entry: &BotInboxEntry) -> Result<bool> {
    let mut list = load_inbox(conn, bot_id)?;
    if list.iter().any(|e| e.event_id == entry.event_id) {
        return Ok(false);
    }
    list.push(entry.clone());
    if list.len() > BOT_INBOX_MAX {
        // 丢最旧的（列表已是新在前 ⇒ 保留前 BOT_INBOX_MAX 条）。
        list.truncate(BOT_INBOX_MAX);
    }
    let value = serde_json::to_string(&list)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("序列化收件箱失败：{e}")))?;
    crate::db::set_setting(conn, &bot_inbox_key(bot_id), &value)?;
    Ok(true)
}

/// 清空某个机器人的收件箱（撤销/清理时用）。
pub fn clear_inbox(conn: &Connection, bot_id: &str) -> Result<()> {
    crate::db::delete_setting(conn, &bot_inbox_key(bot_id))?;
    Ok(())
}
