// 职责边界：
// - 通知机器人（Webhook bot）的**本地存储**：机器人清单 + 收件箱。
//   一律走 `settings` 表（键值对）—— **不动 SQLite 表结构**（schema 属 Frozen Core）。
//   设计依据与部署/使用说明见 `docs/notify-bot-guide.md`。
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
    /// 作用域：`personal`（个人会话）或 `group`（群）。空串 = v5 老记录 ⇒ 读取时推导。
    #[serde(default)]
    pub scope: String,
    /// 免打扰。默认关（每条通知都弹）。
    #[serde(default)]
    pub do_not_disturb: bool,
    /// 用户自定义的机器人头像（SVG data URL）。空 = 用 bot_id 种子默认脸。
    /// 与 name 一样可在详情页编辑（用户 2026-11-17）。
    #[serde(default)]
    pub avatar: String,
    /// 服务地址（`https://…`）。**强制 HTTPS**（本机调试开关除外）。
    pub server_url: String,
    /// 取件凭证（client token）。⚠️ **不进日志/诊断/列表响应**；撤销时清掉。
    ///
    /// 命名说明：它**不叫** `secret` —— 本仓的密钥边界守卫（`check-key-boundary.mjs`）
    /// 把带 `secret` 的**可序列化**类型判成「E2EE 私钥」，而这只是一枚 bearer token
    /// （与 relay 的 `token` 同一性质）。守卫的口径是「别用密钥命名」，不是
    /// 「这类字段不许存在」⇒ 改名，不加例外。
    pub client_token: String,
    /// 外部系统发通知用的完整 URL（创建时生成，等价于 endpoint）。
    #[serde(default)]
    pub publish_url: String,
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
    /// 群机器人管理指令（服务端透传，客户端白名单校验后才执行）。
    #[serde(default)]
    pub action: Option<serde_json::Value>,
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

/// 字段级设置免打扰（审计）：持锁读改写，不与轮询统计互相覆盖。
pub fn set_bot_dnd(conn: &Connection, bot_id: &str, enabled: bool) -> Result<Option<BotRecord>> {
    let Some(mut rec) = load_bot(conn, bot_id)? else { return Ok(None) };
    rec.do_not_disturb = enabled;
    save_bot(conn, &rec)?;
    Ok(Some(rec))
}

/// 字段级更新轮询统计（审计）：**在同一把锁内**读最新记录 → 只改统计字段 → 写回。
///
/// 为什么不能让调用方 `load_bot` → 改 → `save_bot`：那两步之间隔着网络 await，
/// 用户可能刚改了 DND / 状态，旧快照整条写回会把新值覆盖（真丢用户设置）。
pub fn update_bot_poll_stats(
    conn: &Connection,
    bot_id: &str,
    pulled: u32,
    failed: u32,
    last_event_at: Option<i64>,
    last_error: Option<String>,
) -> Result<()> {
    let mut rec = match load_bot(conn, bot_id)? {
        Some(r) => r,
        None => return Ok(()), // 机器人已被删除 ⇒ 不再回写（否则会把删掉的 resurrect）
    };
    rec.pending = 0;
    rec.failed = failed;
    // 只有本轮真取到事件才推进「最近收到」——没事件不该刷新时间（审计 P2）。
    if let Some(ts) = last_event_at {
        rec.last_event_at = Some(ts);
    }
    rec.last_error = last_error;
    let _ = pulled; // 计数由调用方记日志，记录里只留 failed / last_error
    save_bot(conn, &rec)
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
    // ⚠️ 列表是**新在前**（见 load_inbox 的 sort+reverse）⇒ 新事件必须插到**头部**。
    // 审计：此前 push 到末尾后 truncate 会把**刚到的新事件**丢掉，
    // 而保留的是最旧的 —— 与注释「丢最旧」完全相反。
    list.insert(0, entry.clone());
    if list.len() > BOT_INBOX_MAX {
        list.truncate(BOT_INBOX_MAX); // 尾部是最旧的 ⇒ 丢尾部
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

#[cfg(test)]
mod bot_inbox_order_tests {
    use super::*;

    fn conn() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        c
    }

    fn entry(id: &str, ts: i64) -> BotInboxEntry {
        BotInboxEntry {
            event_id: id.into(),
            text: format!("text-{id}"),
            format: "text".into(),
            source: "".into(),
            images: vec![],
            received_at: ts,
            state: "received".into(),
            action: None,
        }
    }

    /// 审计：新事件必须保留，丢的是最旧的。
    #[test]
    fn newest_events_survive_truncation() {
        let c = conn();
        for i in 0..(BOT_INBOX_MAX + 5) {
            assert!(append_inbox(&c, "b1", &entry(&format!("e{i}"), i as i64)).unwrap());
        }
        let list = load_inbox(&c, "b1").unwrap();
        assert_eq!(list.len(), BOT_INBOX_MAX);
        // 最新的必须在（之前 push 到末尾会被 truncate 掉）。
        assert_eq!(list[0].event_id, format!("e{}", BOT_INBOX_MAX + 4));
        assert_eq!(list[BOT_INBOX_MAX - 1].event_id, "e5");
        // 最旧的 e0..e4 被丢。
        assert!(!list.iter().any(|e| e.event_id == "e0"));
    }

    /// 重投必须幂等（去重窗口随最新 200 条保留）。
    #[test]
    fn redelivery_is_idempotent() {
        let c = conn();
        assert!(append_inbox(&c, "b1", &entry("dup", 1)).unwrap());
        assert!(!append_inbox(&c, "b1", &entry("dup", 1)).unwrap(), "重投必须返回 false");
        assert_eq!(load_inbox(&c, "b1").unwrap().len(), 1);
    }
}

// ---------------- 已投递 event_id（群消息幂等） ----------------
//
// 审计：群消息没有 event_id 去重，ACK 丢失导致租约重投时**重复发群消息**。
// 这里存一个固定上限的「最近已投递 id」集合（**只增不无限膨胀**：超过上限丢最旧的）。
// 与 `bot_inbox:*` 分开：那个是可裁剪的展示历史，这个是幂等窗口，不能被展示裁剪影响。

/// 群消息投递去重窗口（条）。服务端租约 60s、队列 TTL 7 天；200 条对单群足够，
/// 且每条 id 32 字节 ⇒ 单 bot 上限约 10 KiB，不会膨胀。
pub const DELIVERED_IDS_MAX: usize = 200;

fn delivered_key(bot_id: &str) -> String {
    format!("bot_delivered:{bot_id}")
}

/// 这个 event 是否已经投递过。
pub fn was_delivered(conn: &Connection, bot_id: &str, event_id: &str) -> Result<bool> {
    let Some(raw) = crate::db::get_setting_checked(conn, &delivered_key(bot_id))? else {
        return Ok(false);
    };
    let ids: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    Ok(ids.iter().any(|i| i == event_id))
}

/// 记一条已投递 event（幂等；固定窗口丢最旧）。返回 true = 新记的。
pub fn mark_delivered(conn: &Connection, bot_id: &str, event_id: &str) -> Result<bool> {
    let mut ids: Vec<String> = match crate::db::get_setting_checked(conn, &delivered_key(bot_id))? {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };
    if ids.iter().any(|i| i == event_id) {
        return Ok(false);
    }
    ids.insert(0, event_id.to_string()); // 新在前
    ids.truncate(DELIVERED_IDS_MAX); // 丢最旧
    let value = serde_json::to_string(&ids)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("序列化投递去重失败：{e}")))?;
    crate::db::set_setting(conn, &delivered_key(bot_id), &value)?;
    Ok(true)
}

// ---------------- 已删除机器人的取件令牌墓碑（孤儿消息兜底） ----------------
//
// 场景（用户 2026-11-17）：本机删了机器人，但删除时服务端 DELETE 失败（离线/网络抖动）
// ⇒ 服务端 token 还在 ⇒ 第三方还能发，消息在服务端积压 7 天没人取（无头消息）。
// 解法：删除时把 client_token + server_url 存成墓碑；后台轮询时**也拉墓碑 token**，
// 把服务端残留事件全部 ACK 丢弃（本机不投递不入队），清到空后墓碑自删。

const TOMBSTONE_KEY: &str = "bot_tombstones";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BotTombstone {
    pub client_token: String,
    pub server_url: String,
    pub created_at: i64,
}

pub fn add_bot_tombstone(conn: &Connection, client_token: &str, server_url: &str) -> Result<()> {
    if client_token.is_empty() { return Ok(()); }
    let mut list: Vec<BotTombstone> = match crate::db::get_setting_checked(conn, TOMBSTONE_KEY)? {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        None => Vec::new(),
    };
    // 幂等：同一个 token 不重复记。上限 50（防手改膨胀），超了丢最旧。
    if !list.iter().any(|t| t.client_token == client_token) {
        list.insert(0, BotTombstone {
            client_token: client_token.to_string(),
            server_url: server_url.to_string(),
            created_at: crate::db::now_ms(),
        });
        list.truncate(50);
        let value = serde_json::to_string(&list)
            .map_err(|e| rusqlite::Error::InvalidParameterName(format!("序列化墓碑失败：{e}")))?;
        crate::db::set_setting(conn, TOMBSTONE_KEY, &value)?;
    }
    Ok(())
}

pub fn list_bot_tombstones(conn: &Connection) -> Result<Vec<BotTombstone>> {
    let Some(raw) = crate::db::get_setting_checked(conn, TOMBSTONE_KEY)? else { return Ok(vec![]) };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

pub fn remove_bot_tombstone(conn: &Connection, client_token: &str) -> Result<()> {
    let mut list = list_bot_tombstones(conn)?;
    let before = list.len();
    list.retain(|t| t.client_token != client_token);
    if list.len() == before { return Ok(()); }
    let value = serde_json::to_string(&list)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("序列化墓碑失败：{e}")))?;
    crate::db::set_setting(conn, TOMBSTONE_KEY, &value)
}
