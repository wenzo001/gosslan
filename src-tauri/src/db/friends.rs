// 职责边界：
// - 好友表 CRUD（insert/get/list/delete_friend）
// ---------------- 好友 ----------------

pub fn add_friend(
    conn: &Connection,
    device_id: &str,
    nickname: &str,
    avatar: Option<&str>,
) -> Result<()> {
    // 冲突分支原来是整行覆盖（`nickname = excluded.nickname, avatar = excluded.avatar`）。
    // 这条语句在 Hello / announce 热路径上被反复调用，而调用方有**拿不到信息**的情形：
    // `mobile_picker::accept_friend_request` 两次都传 `avatar: None`、老客户端的 Hello 不带头像、
    // peers 快照也可能没有头像 ⇒ 一次"信息更少"的帧会把已知头像清成 NULL（好友列表回退到种子头像）。
    // 口径与 `update_friend_pubkeys` 同一句：**没有信息时保留已有值**；
    // 有信息时仍然跟随（改名要跟着变，这是既定语义）。
    conn.execute(
        "INSERT INTO friends(device_id, nickname, avatar, added_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(device_id) DO UPDATE SET
           nickname = CASE WHEN excluded.nickname <> '' THEN excluded.nickname ELSE friends.nickname END,
           avatar   = COALESCE(excluded.avatar, friends.avatar)",
        params![device_id, nickname, avatar, now_ms()],
    )?;
    Ok(())
}

pub fn remove_friend(conn: &Connection, device_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM friends WHERE device_id = ?1",
        params![device_id],
    )?;
    Ok(())
}

pub fn get_friend(conn: &Connection, device_id: &str) -> Option<(String, Option<String>)> {
    // ⚠️ 读失败在这里被折成 `None`（"不是好友"）。这只适合"没有就能继续"的展示路径；
    // **权限/身份判定**必须用 [`get_friend_checked`]：把一次读抖动读成"不是好友"会做出
    // 不可逆的决定（审计 STB-04 半格：非好友分支直接拒收并 return，而那条消息的 msg_id
    // 已经进过去重表 ⇒ 之后每一次补发都被判 Duplicate，永久进不来）。
    get_friend_checked(conn, device_id).ok().flatten()
}

/// 与 [`get_friend`] 同一句 SQL，但**保留读错误**（身份判定路径用它）。
pub fn get_friend_checked(
    conn: &Connection,
    device_id: &str,
) -> rusqlite::Result<Option<(String, Option<String>)>> {
    conn.query_row(
        "SELECT nickname, avatar FROM friends WHERE device_id = ?1",
        params![device_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// 补齐好友**尚缺**的 X25519 / Ed25519 公钥（首次学到时持久化）。
///
/// ⚠️ **只填空位，绝不覆盖已有值**（`COALESCE(x25519_pubkey, ?2)` 而非反过来）。
///
/// 这是身份绑定不被劫持的最后一道闸：调用方来自多个信任级别不同的路径，
/// 只要有一个环节漏判（或将来新增了一条），覆盖式写入就会让一次伪造广播**永久**
/// 改掉好友的真实公钥 —— 此后发给该好友的消息改用攻击者公钥加密，而消息是广播给
/// 所有已连接节点的，攻击者用自己的私钥即可解开；重启也不恢复（只有删好友才清）。
/// 填充式写入把最坏后果从「E2EE 被击穿」降级为「公钥为空时被抢先填一次」。
///
/// 密钥**变更**（对方重装应用）不走这里：那需要用户明确确认，
/// 现有路径是删好友后重新添加（`remove_friend` 会连带删除公钥列，重新添加即重新学习）。
pub fn update_friend_pubkeys(
    conn: &Connection,
    device_id: &str,
    x25519: Option<&str>,
    ed25519: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE friends SET x25519_pubkey = COALESCE(x25519_pubkey, ?2),
                            ed25519_pubkey = COALESCE(ed25519_pubkey, ?3)
         WHERE device_id = ?1",
        params![device_id, x25519, ed25519],
    )?;
    Ok(())
}

/// **用户显式确认后**覆盖好友的两把公钥（密钥轮换）。
///
/// 与 [`update_friend_pubkeys`]（只填空、绝不覆盖）刻意分开：对方卸载重装应用后
/// 身份密钥重建，旧绑定会导致「文件分片解密失败」、消息发不出。自动覆盖会击穿 E2EE
/// （一次自报公钥就能冒充好友），所以只有用户在聊天界面点「同步新密钥」（且候选密钥
/// 已通过新私钥的 Hello 自验签）才允许走到这里。
pub fn replace_friend_pubkeys(
    conn: &Connection,
    device_id: &str,
    x25519: &str,
    ed25519: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE friends SET x25519_pubkey = ?2, ed25519_pubkey = ?3
         WHERE device_id = ?1",
        params![device_id, x25519, ed25519],
    )?;
    Ok(())
}

/// 获取好友的 X25519 公钥（用于 ECDH 加密）。
pub fn get_friend_x25519(conn: &Connection, device_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT x25519_pubkey FROM friends WHERE device_id = ?1",
        params![device_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// 一次取回好友绑定的两把公钥（X25519, Ed25519）。
///
/// 外层 Option 区分「不是好友」（None）与「是好友但键列还是 NULL」
/// （Some((None, None))，旧行/早期版本）—— 信任锚判定两者语义不同。
pub fn get_friend_pubkeys(
    conn: &Connection,
    device_id: &str,
) -> Option<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT x25519_pubkey, ed25519_pubkey FROM friends WHERE device_id = ?1",
        params![device_id],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
            ))
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// 列出所有**已绑定 Ed25519 公钥**的好友 `(device_id, ed25519_pubkey)`。
///
/// 公网中继的会合循环用它算通道哈希并做协商验签（`network/transport/relay.rs`）。
/// 两个刻意的选择：
/// - 单条查询而不是"N 次 `get_friend_ed25519`"：这个循环每 10 秒跑一轮，好友上百时
///   N+1 会成为它唯一的成本来源。
/// - `ed25519_pubkey IS NULL` 的老记录**直接不进候选**：没有绑定值就没有可验的身份。
///   走公网时绝不拿"自报公钥 + TOFU"凑数（ADR-0020 D4）—— 那等于把冒充的门开在公网侧。
pub fn list_bound_friend_identities(
    conn: &Connection,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT device_id, ed25519_pubkey FROM friends WHERE ed25519_pubkey IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    // 单行读取失败**跳过而不是整表作废**：一个脏行不该让其余好友都失去公网通路。
    // 但错误本身必须能被调用方看见，所以这里只在行级容忍，语句级错误由 `?` 上抛。
    rows.collect()
}

/// 获取好友的 Ed25519 公钥（用于 Hello 握手验签，确认 TCP 对端确实是该 device_id）。
pub fn get_friend_ed25519(conn: &Connection, device_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT ed25519_pubkey FROM friends WHERE device_id = ?1",
        params![device_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

pub fn list_friends(conn: &Connection) -> Result<Vec<Friend>> {
    let mut stmt =
        conn.prepare("SELECT device_id, nickname, avatar FROM friends ORDER BY added_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(Friend {
            device_id: r.get(0)?,
            nickname: r.get(1)?,
            avatar: r.get(2)?,
            device_type: String::new(),
            // 版本是**内存里的东西**（Hello 时写入），DB 层给空值，由命令层读时富化
            peer_app_version: None,
            peer_version_newer: false,
            online: false,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------- 待处理的好友申请（入站，审计 A4 的持久化） ----------------

use crate::state::PendingRequest;

/// 一条**入站**待处理申请在 `settings` 里的那一行（键前缀）。
///
/// 为什么不另建一张表：`settings` 已经是本仓"每 X 一份本地状态"的那个家（群密钥 `gk:`、
/// 群任务水位 `todo_num:`、群历史同步状态 `ghsync:` 都在那儿 —— 口径见
/// `db/group_history.rs::group_history_state_key` 那段说明）。这一份状态只有一个需求：
/// **重启后还要在**。没有查询、没有索引、没有外键 ⇒ 为它开一张表就是给同一个需求开第二个家。
///
/// ⚠️ 前缀里带 `_`，SQL 的 `LIKE` 把它当单字符通配符 ⇒ `friend_req:%` **不等于**"这一族的键"。
/// 所以读侧（`list_friend_requests`）与删侧（`clear_friend_requests`）都必须在 `LIKE` 之后
/// 再用 `strip_prefix` 严格认一次键名 —— 两边同一把尺子，别各自发明口径。
pub const FRIEND_REQUEST_KEY_PREFIX: &str = "friend_req:";

pub fn friend_request_key(peer_id: &str) -> String {
    format!("{FRIEND_REQUEST_KEY_PREFIX}{peer_id}")
}

/// 落一行申请（upsert）。同一个人补发时后到的那份覆盖前一份 ⇒ 昵称/头像跟着更新，
/// 而"这条我已经握着了"的判定仍然只看键在不在（`pending_friend_request_admitted`）。
pub fn put_friend_request(conn: &Connection, req: &PendingRequest) -> Result<()> {
    let json = serde_json::to_string(req)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("好友申请序列化失败：{e}")))?;
    set_setting(conn, &friend_request_key(&req.from), &json)
}

/// 清掉一行（同意 / 拒绝 / 被"已是好友"过滤掉时）。行本来不在 = 成功（幂等）。
pub fn forget_friend_request(conn: &Connection, peer_id: &str) -> Result<()> {
    delete_setting(conn, &friend_request_key(peer_id))
}

/// 「清除数据」那一趟把这批申请一起抹掉。内存那一张在同一处 `clear()` ——
/// 两边不同步的话，下一次开机会把刚清掉的申请原样端回来。
///
/// ★ 不拿 `LIKE` 的匹配结果直接删：SQL 的 `LIKE` 把前缀里的 `_` 当**单字符通配符**，
/// `friend_req:%` 同时命中 `friendXreq:…`（`_` 顶掉下划线）与 `friend_req2:…`
/// （`_` 顶掉后面的真字符）—— 那些键不属于这一族，一次"清好友申请"不许顺手删掉别人的键。
/// `LIKE` 在这里只用来缩小候选范围，**真正的归属判定交给 `strip_prefix`**（与
/// `list_friend_requests` 同一把尺子，读侧与删侧不许各有各的口径）。
pub fn clear_friend_requests(conn: &Connection) -> Result<()> {
    let keys: Vec<String> = {
        let mut stmt = conn.prepare("SELECT key FROM settings WHERE key LIKE ?1")?;
        let rows = stmt.query_map(params![format!("{FRIEND_REQUEST_KEY_PREFIX}%")], |r| {
            r.get::<_, String>(0)
        })?;
        // 读不出键名 = 宁可整趟失败，不许静默跳过：跳过等于"清了但那一行还在"，
        // 下一次开机会把用户以为删掉的申请原样端回来（假"已清除"比报错贵）。
        rows.collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?
    };
    for key in keys
        .iter()
        .filter(|k| k.strip_prefix(FRIEND_REQUEST_KEY_PREFIX).is_some())
    {
        delete_setting(conn, key)?;
    }
    Ok(())
}

/// 启动时把库里的申请读回来（按写入顺序）。
///
/// 认不出来的行**跳过而不删**：删掉它就是把"一次解析失败"升级成"用户的申请没了"。
/// 跳过之后对端下一次补发会把那一行覆盖成合法形状，不需要这里替它做决定。
pub fn get_friend_request(conn: &Connection, peer_id: &str) -> Result<Option<PendingRequest>> {
    let Some(raw) = get_setting(conn, &friend_request_key(peer_id)) else {
        return Ok(None);
    };
    let Ok(req) = serde_json::from_str::<PendingRequest>(&raw) else {
        return Ok(None);
    };
    if req.from != peer_id {
        return Ok(None);
    }
    Ok(Some(req))
}

pub fn list_friend_requests(conn: &Connection) -> Result<Vec<PendingRequest>> {
    let mut stmt = conn.prepare(
        "SELECT key, value FROM settings WHERE key LIKE ?1 ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![format!("{FRIEND_REQUEST_KEY_PREFIX}%")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (key, value) = row?;
        let Some(peer) = key.strip_prefix(FRIEND_REQUEST_KEY_PREFIX) else {
            continue;
        };
        let Ok(req) = serde_json::from_str::<PendingRequest>(&value) else {
            continue;
        };
        // 键与载荷必须是同一个人：手写/半写坏的行（键是 A、载荷 from 是 B）不许进列表，
        // 否则同意的时候删掉的是 B 那一行，A 这条永远留在「新朋友」里。
        if req.from == peer {
            out.push(req);
        }
    }
    Ok(out)
}

/// 同意一条待处理申请的结果。三态是**仲裁的一部分**：调用方必须能区分
/// "我刚把它变成好友"、"本来就是好友"、"这条申请已经被撤回/处理掉了"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingAcceptOutcome {
    Accepted,
    AlreadyFriend,
    NotPending,
}

/// **同意 vs 撤回的唯一状态迁移**：在同一个 SQLite 事务里检查申请仍在、写好友、
/// 建会话、删申请行。先提交者赢；后到者拿到明确的三态之一。
///
/// 为什么必须是一个事务：分开做的话，撤回删掉申请行之后同意仍可能把好友写进去
/// ⇒ 撤回方收到"已撤回"、同意方却已加成好友，两边都以为成功。
pub fn accept_pending_friend_request(
    conn: &Connection,
    peer_id: &str,
    name: &str,
    avatar: Option<&str>,
) -> Result<PendingAcceptOutcome> {
    let tx = conn.unchecked_transaction()?;
    if get_friend_checked(&tx, peer_id)?.is_some() {
        // 已经是好友：申请行只是残留，顺手清掉，但不再重复写好友。
        forget_friend_request(&tx, peer_id)?;
        tx.commit()?;
        return Ok(PendingAcceptOutcome::AlreadyFriend);
    }
    if get_setting(&tx, &friend_request_key(peer_id)).is_none() {
        tx.commit()?;
        return Ok(PendingAcceptOutcome::NotPending);
    }
    add_friend(&tx, peer_id, name, avatar)?;
    ensure_conversation(&tx, peer_id, "single", name, None)?;
    forget_friend_request(&tx, peer_id)?;
    tx.commit()?;
    Ok(PendingAcceptOutcome::Accepted)
}

/// 收到撤回帧后的仲裁结果。与 [`PendingAcceptOutcome`] 共享同一把尺子：
/// 好友关系已经落库 ⇒ `AlreadyFriend`（同意赢，撤回让位）；申请还在 ⇒ `Withdrawn`；
/// 既没好友也没这条申请 ⇒ `NoMatch`（迟到的重复撤回，不重复写墓碑）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawOutcome {
    AlreadyFriend,
    Withdrawn,
    NoMatch,
}

/// **撤回 vs 同意在接收侧的唯一状态迁移**：同一个 SQLite 事务里先查好友、再查申请、
/// 删申请行并写墓碑。调用方（`state.db` 互斥锁）与同意命令串行，先提交者赢。
///
/// 为什么必须是一个事务：`forget_friend_request` 与 `put_withdrawn_request_tombstone`
/// 分开提交时，中间崩一次会留下「申请没了、墓碑也没有」的空洞，迟到的重复申请就能
/// 再次弹出来；这也让「撤回赢」缺少可观察的终态证据。
pub fn withdraw_pending_friend_request(
    conn: &Connection,
    peer_id: &str,
    request_id: i64,
) -> Result<WithdrawOutcome> {
    let tx = conn.unchecked_transaction()?;
    if get_friend_checked(&tx, peer_id)?.is_some() {
        tx.commit()?;
        return Ok(WithdrawOutcome::AlreadyFriend);
    }
    let pending = get_friend_request(&tx, peer_id)?;
    let hit = pending
        .as_ref()
        .is_some_and(|p| p.request_id == 0 || request_id == 0 || p.request_id == request_id);
    if !hit {
        tx.commit()?;
        return Ok(WithdrawOutcome::NoMatch);
    }
    forget_friend_request(&tx, peer_id)?;
    put_withdrawn_request_tombstone(&tx, peer_id, request_id)?;
    tx.commit()?;
    Ok(WithdrawOutcome::Withdrawn)
}

// ---------------- 出站申请 / 同意回执 / 撤回墓碑 ----------------

/// 出站好友申请。`first_at` 同时是这条申请的稳定 `request_id`：
/// 补发不会改它，撤回帧靠它精确命中同一条申请。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OutgoingFriendRequest {
    pub peer: String,
    pub first_at: i64,
    pub last_sent_at: i64,
    /// `"waiting"` 或 `"withdrawn"`。
    pub status: String,
    /// 撤回帧是否已收到对端回执。旧客户端 / 帧丢失时为 `false`。
    pub withdraw_confirmed: bool,
    pub withdraw_attempts: u32,
    pub withdraw_last_at: i64,
}

/// 待补发的好友同意回执（与内存 `pending_out_accepts` 同序）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingOutAccept {
    pub peer: String,
    pub issued_at: i64,
    pub attempts: u32,
    pub last_at: i64,
}

pub const OUTGOING_FRIEND_REQUEST_KEY_PREFIX: &str = "friend_out:";
pub const PENDING_OUT_ACCEPT_KEY_PREFIX: &str = "friend_acc:";
pub const WITHDRAWN_REQUEST_KEY_PREFIX: &str = "friend_req_wd:";

pub fn outgoing_friend_request_key(peer_id: &str) -> String {
    format!("{OUTGOING_FRIEND_REQUEST_KEY_PREFIX}{peer_id}")
}

fn pending_out_accept_key(peer_id: &str) -> String {
    format!("{PENDING_OUT_ACCEPT_KEY_PREFIX}{peer_id}")
}

fn withdrawn_request_key(peer_id: &str) -> String {
    format!("{WITHDRAWN_REQUEST_KEY_PREFIX}{peer_id}")
}

/// `LIKE` 只缩范围；真正的归属判定一律交给 `strip_prefix`（与 `list_friend_requests` 同一把尺子）。
fn list_settings_family<T>(conn: &Connection, prefix: &str) -> Result<Vec<(String, T)>>
where
    T: serde::de::DeserializeOwned,
{
    let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key LIKE ?1 ORDER BY rowid")?;
    let rows = stmt.query_map(params![format!("{prefix}%")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (key, value) = row?;
        if key.strip_prefix(prefix).is_none() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<T>(&value) else {
            continue;
        };
        out.push((key, parsed));
    }
    Ok(out)
}

fn clear_settings_family(conn: &Connection, prefix: &str) -> Result<()> {
    let keys: Vec<String> = {
        let mut stmt = conn.prepare("SELECT key FROM settings WHERE key LIKE ?1")?;
        let rows = stmt.query_map(params![format!("{prefix}%")], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?
    };
    for key in keys.iter().filter(|k| k.strip_prefix(prefix).is_some()) {
        delete_setting(conn, key)?;
    }
    Ok(())
}

pub fn put_outgoing_friend_request(conn: &Connection, req: &OutgoingFriendRequest) -> Result<()> {
    let json = serde_json::to_string(req)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("出站申请序列化失败：{e}")))?;
    set_setting(conn, &outgoing_friend_request_key(&req.peer), &json)
}

pub fn get_outgoing_friend_request(
    conn: &Connection,
    peer_id: &str,
) -> Result<Option<OutgoingFriendRequest>> {
    let Some(raw) = get_setting(conn, &outgoing_friend_request_key(peer_id)) else {
        return Ok(None);
    };
    let Ok(req) = serde_json::from_str::<OutgoingFriendRequest>(&raw) else {
        return Ok(None);
    };
    if req.peer != peer_id {
        return Ok(None);
    }
    Ok(Some(req))
}

pub fn list_outgoing_friend_requests(conn: &Connection) -> Result<Vec<OutgoingFriendRequest>> {
    Ok(list_settings_family::<OutgoingFriendRequest>(conn, OUTGOING_FRIEND_REQUEST_KEY_PREFIX)?
        .into_iter()
        .filter_map(|(key, req)| {
            key.strip_prefix(OUTGOING_FRIEND_REQUEST_KEY_PREFIX)
                .filter(|peer| req.peer == *peer)
                .map(|_| req)
        })
        .collect())
}

pub fn forget_outgoing_friend_request(conn: &Connection, peer_id: &str) -> Result<()> {
    delete_setting(conn, &outgoing_friend_request_key(peer_id))
}

pub fn clear_outgoing_friend_requests(conn: &Connection) -> Result<()> {
    clear_settings_family(conn, OUTGOING_FRIEND_REQUEST_KEY_PREFIX)
}

pub fn put_pending_out_accept(conn: &Connection, entry: &PendingOutAccept) -> Result<()> {
    let json = serde_json::to_string(entry)
        .map_err(|e| rusqlite::Error::InvalidParameterName(format!("同意回执序列化失败：{e}")))?;
    set_setting(conn, &pending_out_accept_key(&entry.peer), &json)
}

pub fn list_pending_out_accepts(conn: &Connection) -> Result<Vec<PendingOutAccept>> {
    Ok(list_settings_family::<PendingOutAccept>(conn, PENDING_OUT_ACCEPT_KEY_PREFIX)?
        .into_iter()
        .filter_map(|(key, entry)| {
            key.strip_prefix(PENDING_OUT_ACCEPT_KEY_PREFIX)
                .filter(|peer| entry.peer == *peer)
                .map(|_| entry)
        })
        .collect())
}

pub fn forget_pending_out_accept(conn: &Connection, peer_id: &str) -> Result<()> {
    delete_setting(conn, &pending_out_accept_key(peer_id))
}

pub fn clear_pending_out_accepts(conn: &Connection) -> Result<()> {
    clear_settings_family(conn, PENDING_OUT_ACCEPT_KEY_PREFIX)
}

/// 已撤回申请的墓碑：让处理完之后才迟到的重复申请不再重新弹出来。
pub fn put_withdrawn_request_tombstone(
    conn: &Connection,
    peer_id: &str,
    request_id: i64,
) -> Result<()> {
    set_setting(conn, &withdrawn_request_key(peer_id), &request_id.to_string())
}

pub fn get_withdrawn_request_tombstone(conn: &Connection, peer_id: &str) -> Result<Option<i64>> {
    let Some(raw) = get_setting(conn, &withdrawn_request_key(peer_id)) else {
        return Ok(None);
    };
    Ok(raw.parse::<i64>().ok())
}

pub fn forget_withdrawn_request_tombstone(conn: &Connection, peer_id: &str) -> Result<()> {
    delete_setting(conn, &withdrawn_request_key(peer_id))
}

pub fn clear_withdrawn_request_tombstones(conn: &Connection) -> Result<()> {
    clear_settings_family(conn, WITHDRAWN_REQUEST_KEY_PREFIX)
}

#[cfg(test)]
mod friend_request_store_tests {
    use super::*;
    use crate::db::SCHEMA;
    use rusqlite::Connection;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn req(from: &str, nickname: &str, avatar: Option<&str>, ts: i64) -> PendingRequest {
        PendingRequest {
            from: from.into(),
            from_nickname: nickname.into(),
            from_avatar: avatar.map(|a| a.to_string()),
            ts,
            request_id: 0,
        }
    }

    /// 落库 → 读回是同一份载荷；同一个人再落一次是**覆盖**（昵称跟着更新），不是多出一行。
    /// 这就是"重启恢复必须有真实数据库持久化证据"那一格（审计 A4）—— 内存里那份不算。
    #[test]
    fn a_pending_request_survives_a_write_then_read_and_a_repeat_updates_it() {
        let conn = mem();
        put_friend_request(&conn, &req("dev-a", "小李", Some("data:image/svg+xml;base64,AA"), 100))
            .unwrap();
        let back = list_friend_requests(&conn).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].from_nickname, "小李");
        assert_eq!(back[0].ts, 100);
        assert_eq!(back[0].from_avatar.as_deref(), Some("data:image/svg+xml;base64,AA"));

        put_friend_request(&conn, &req("dev-a", "小李（改名）", None, 100)).unwrap();
        let again = list_friend_requests(&conn).unwrap();
        assert_eq!(again.len(), 1, "同一个人补发不许变成两条申请");
        assert_eq!(again[0].from_nickname, "小李（改名）");

        // 库里的真身：前缀就是那一行的键名（不是"某处内存"）
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM settings")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(|v| v.ok())
            .collect();
        assert_eq!(keys, vec!["friend_req:dev-a".to_string()]);

        // 处理掉了 ⇒ 库里那行也要没了（下一次开机会把它端回来）
        forget_friend_request(&conn, "dev-a").unwrap();
        assert!(list_friend_requests(&conn).unwrap().is_empty());
        // 幂等：行已经不在，再删一次不报错
        forget_friend_request(&conn, "dev-a").unwrap();
    }

    /// ⚠️ 键名里的 `_` 在 SQL `LIKE` 里是**单字符通配符** ⇒ 只靠 LIKE 会把别人的键读进来。
    /// 读侧的 `strip_prefix` 必须真的咬住这一格（删侧仍按前缀批量走，见 `clear_friend_requests`）。
    #[test]
    fn a_lookalike_key_is_not_mistaken_for_a_friend_request() {
        let conn = mem();
        set_setting(&conn, "friendXreq:dev-z", "{\"from\":\"dev-z\"}").unwrap();
        // 正控：LIKE 本身确实会命中它（否则下面那条断言是在判空写）
        let like_hits: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key LIKE 'friend_req:%'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(like_hits, 1, "夹具没造出同形键，下面的严格判据就是在空集上恒绿");
        assert!(list_friend_requests(&conn).unwrap().is_empty());
    }

    /// 坏行**跳过而不删**：认不出来的载荷不许被升级成"用户的申请没了"；
    /// 键与载荷不是同一个人的半写行也不许进列表（否则同意时删错那一行，原行永远留在「新朋友」里）。
    #[test]
    fn corrupt_and_mismatched_rows_are_skipped_but_left_in_place() {
        let conn = mem();
        put_friend_request(&conn, &req("dev-good", "好人", None, 1)).unwrap();
        set_setting(&conn, "friend_req:dev-junk", "这不是 JSON").unwrap();
        set_setting(&conn, "friend_req:dev-mismatch", "{\"from\":\"dev-other\",\"from_nickname\":\"串了\",\"ts\":2}").unwrap();

        let back = list_friend_requests(&conn).unwrap();
        assert_eq!(
            back.iter().map(|r| r.from.as_str()).collect::<Vec<_>>(),
            vec!["dev-good"],
            "只有键与载荷一致、且能认出来的那一行该进列表"
        );
        // 两行坏数据都还在：跳过 ≠ 删除（对端下一次补发会把它们覆盖成合法形状）
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings WHERE key LIKE 'friend_req:%'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 3, "解析失败/串了键的行不许被这条路径删掉");
    }

    /// `_` 在 SQL 的 `LIKE` 里是**单字符通配符** ⇒ `friend_req:%` 会撞上形近但不属于这一族的键。
    /// 读侧靠 `strip_prefix` 已经挡住了（列表里不许出现它们），但"清除数据"那一趟原先直接按
    /// `LIKE` 的结果删 ⇒ 一次清申请会顺手把别人的键删掉。这一条同时钉两侧，且**不用 LIKE 计数**
    /// （测试与生产共用同一个错写法 = 一起瞎）：逐个按键名现读。
    #[test]
    fn wildcard_lookalike_keys_are_neither_listed_nor_cleared() {
        let conn = mem();
        put_friend_request(&conn, &req("dev-real", "真人", None, 1)).unwrap();
        // 两种误匹配形状：`_` 顶掉前缀里的下划线 / `_` 顶掉后面的一个真字符
        set_setting(&conn, "friendXreq:ghost", "不是这一族的键").unwrap();
        set_setting(&conn, "friend_req2:ghost", "也不是这一族的键").unwrap();

        assert_eq!(
            list_friend_requests(&conn)
                .unwrap()
                .iter()
                .map(|r| r.from.as_str())
                .collect::<Vec<_>>(),
            vec!["dev-real"],
            "LIKE 通配撞进来的键不许被当成待处理申请列出来"
        );

        clear_friend_requests(&conn).unwrap();
        assert!(
            list_friend_requests(&conn).unwrap().is_empty(),
            "真属于这一族的必须被清掉（严格化不许把该删的留下）"
        );
        assert_eq!(
            get_setting(&conn, "friendXreq:ghost").as_deref(),
            Some("不是这一族的键"),
            "★ 清好友申请不许顺手删掉 LIKE 误匹配的别的键（原先这条是红的）"
        );
        assert_eq!(
            get_setting(&conn, "friend_req2:ghost").as_deref(),
            Some("也不是这一族的键"),
            "同理：形近但不带这个前缀的键也不属于这一族"
        );
    }

    /// 「清除数据」那一趟：这批键整批改删，而**别的** settings 键（群密钥那一族）不受牵连。
    #[test]
    fn clearing_the_batch_leaves_other_setting_keys_alone() {
        let conn = mem();
        put_friend_request(&conn, &req("dev-a", "甲", None, 1)).unwrap();
        put_friend_request(&conn, &req("dev-b", "乙", None, 2)).unwrap();
        set_setting(&conn, "gk:group-1", "{\"k\":1}").unwrap();
        clear_friend_requests(&conn).unwrap();
        assert!(list_friend_requests(&conn).unwrap().is_empty());
        assert_eq!(
            get_setting(&conn, "gk:group-1").as_deref(),
            Some("{\"k\":1}"),
            "清申请不许顺手把群密钥那一族的键一起抹掉"
        );
    }

    /// 好友同意后两侧各自建会话用的必须是**幂等**那一把（审计 A10）：
    /// 重复回执 / 同一台收到两份同意 ⇒ 仍然只有一行；而已存在的那一行一个字都不动
    /// （不许把已有摘要、未读或名字抹成空）。
    #[test]
    fn ensuring_a_conversation_is_idempotent_and_never_rewrites_an_existing_row() {
        let conn = mem();
        ensure_conversation(&conn, "dev-b", "single", "小李", None).unwrap();
        ensure_conversation(&conn, "dev-b", "single", "小李", None).unwrap();
        ensure_conversation(&conn, "dev-b", "single", "改了名字", None).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversations WHERE id='dev-b'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "重复事件不许造出第二个会话");

        // 已经握着摘要与未读的那一行：再 ensure 一次不许把它擦平
        touch_conversation(&conn, "dev-c", "single", "小王", None, "最后一条", 2).unwrap();
        ensure_conversation(&conn, "dev-c", "single", "小王", None).unwrap();
        let after = get_conversation(&conn, "dev-c").unwrap();
        assert_eq!(after.last_msg.as_deref(), Some("最后一条"));
        assert_eq!(after.unread, 2, "ensure 只补行，不许动已有会话的内容");
        assert_eq!(after.name, "小王");
    }

    /// 好友资料：**没有信息时保留已有值**，有信息时跟随（与 `update_friend_pubkeys` 同口径）。
    ///
    /// 真实触发路径：`mobile_picker::accept_friend_request` 两次都传 `avatar: None`；
    /// 老客户端的 Hello 也可能不带头像 ⇒ 整行覆盖会把已知头像清成 NULL（好友列表回退到种子头像）。
    #[test]
    fn add_friend_never_clears_a_known_profile_with_less_information() {
        let conn = mem();
        add_friend(&conn, "dev-x", "老王", Some("data:avatar-1")).unwrap();
        // 改名 + 不带头像 ⇒ 名字跟随、头像保留
        add_friend(&conn, "dev-x", "老王改名了", None).unwrap();
        let (name, avatar) = get_friend_checked(&conn, "dev-x").unwrap().unwrap();
        assert_eq!(name, "老王改名了");
        assert_eq!(
            avatar.as_deref(),
            Some("data:avatar-1"),
            "没有头像的帧不许把已知头像清掉"
        );
        // 空名 + 新头像 ⇒ 名字保留、头像跟随
        add_friend(&conn, "dev-x", "", Some("data:avatar-2")).unwrap();
        let (name, avatar) = get_friend_checked(&conn, "dev-x").unwrap().unwrap();
        assert_eq!(name, "老王改名了", "空昵称不许覆盖已知名字");
        assert_eq!(avatar.as_deref(), Some("data:avatar-2"));
    }

    fn outgoing(peer: &str, first_at: i64) -> OutgoingFriendRequest {
        OutgoingFriendRequest {
            peer: peer.into(),
            first_at,
            last_sent_at: 0,
            status: "waiting".into(),
            withdraw_confirmed: false,
            withdraw_attempts: 0,
            withdraw_last_at: 0,
        }
    }

    /// 出站申请必须落库：重启后 `flush_pending_friend_request` 才有东西可补发。
    /// 同一个人再登记一次保留 `first_at`（稳定 request_id），只更新补发时刻。
    #[test]
    fn an_outgoing_request_survives_a_write_then_read_and_keeps_its_request_id() {
        let conn = mem();
        put_outgoing_friend_request(&conn, &outgoing("dev-a", 100)).unwrap();
        let back = list_outgoing_friend_requests(&conn).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].peer, "dev-a");
        assert_eq!(back[0].first_at, 100);
        assert_eq!(back[0].status, "waiting");

        let mut again = outgoing("dev-a", 200);
        again.last_sent_at = 300;
        put_outgoing_friend_request(&conn, &again).unwrap();
        let rows = list_outgoing_friend_requests(&conn).unwrap();
        assert_eq!(rows.len(), 1, "同一个人不许变成两行");
        assert_eq!(rows[0].first_at, 200, "覆盖写以调用方给的值为准（调用方负责保留 first_at）");
        assert_eq!(rows[0].last_sent_at, 300);

        forget_outgoing_friend_request(&conn, "dev-a").unwrap();
        assert!(list_outgoing_friend_requests(&conn).unwrap().is_empty());
        forget_outgoing_friend_request(&conn, "dev-a").unwrap();
    }

    /// 形近键（`_` 被 LIKE 当通配符）不许读出，也不许被这一族的清除误删。
    #[test]
    fn outgoing_and_withdrawn_families_do_not_touch_lookalike_or_other_keys() {
        let conn = mem();
        put_outgoing_friend_request(&conn, &outgoing("dev-a", 100)).unwrap();
        put_pending_out_accept(&conn, &PendingOutAccept {
            peer: "dev-b".into(),
            issued_at: 100,
            attempts: 0,
            last_at: 0,
        })
        .unwrap();
        put_withdrawn_request_tombstone(&conn, "dev-c", 100).unwrap();
        set_setting(&conn, "friendXout:ghost", "别人").unwrap();
        set_setting(&conn, "friend_acc2:ghost", "别人").unwrap();
        set_setting(&conn, "friend_req_wd2:ghost", "别人").unwrap();
        set_setting(&conn, "gk:group-1", "{\"k\":1}").unwrap();

        clear_outgoing_friend_requests(&conn).unwrap();
        clear_pending_out_accepts(&conn).unwrap();
        clear_withdrawn_request_tombstones(&conn).unwrap();

        assert!(list_outgoing_friend_requests(&conn).unwrap().is_empty());
        assert!(list_pending_out_accepts(&conn).unwrap().is_empty());
        assert_eq!(get_withdrawn_request_tombstone(&conn, "dev-c").unwrap(), None);
        for (key, value) in [
            ("friendXout:ghost", "别人"),
            ("friend_acc2:ghost", "别人"),
            ("friend_req_wd2:ghost", "别人"),
            ("gk:group-1", "{\"k\":1}"),
        ] {
            assert_eq!(
                get_setting(&conn, key).as_deref(),
                Some(value),
                "清这一族不许顺手删掉形近键或别的 settings 键：{key}"
            );
        }
    }

    /// 键与载荷不是同一个人的半写行不许进列表（否则启动恢复会把别人的申请塞进补发表）。
    #[test]
    fn mismatched_outgoing_rows_are_skipped() {
        let conn = mem();
        set_setting(
            &conn,
            "friend_out:dev-a",
            "{\"peer\":\"dev-other\",\"first_at\":1,\"last_sent_at\":0,\"status\":\"waiting\",\"withdraw_confirmed\":false,\"withdraw_attempts\":0,\"withdraw_last_at\":0}",
        )
        .unwrap();
        assert!(list_outgoing_friend_requests(&conn).unwrap().is_empty());
        assert!(
            get_setting(&conn, "friend_out:dev-a").is_some(),
            "跳过 ≠ 删除"
        );
    }

    #[test]
    fn withdrawn_tombstone_survives_a_write_then_read() {
        let conn = mem();
        put_withdrawn_request_tombstone(&conn, "dev-a", 12345).unwrap();
        assert_eq!(
            get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(),
            Some(12345)
        );
        forget_withdrawn_request_tombstone(&conn, "dev-a").unwrap();
        assert_eq!(get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(), None);
    }

    fn req_with_id(from: &str, request_id: i64) -> PendingRequest {
        let mut r = req(from, "小李", None, request_id);
        r.request_id = request_id;
        r
    }

    /// 仲裁方向一：**撤回先提交**。之后的同意必须拿到 `NotPending`，不写好友、不覆盖墓碑。
    /// 这就是「不能两边都以为成功」的接收侧证据。
    #[test]
    fn withdraw_wins_then_accept_gets_not_pending_and_writes_no_friend() {
        let conn = mem();
        put_friend_request(&conn, &req_with_id("dev-a", 100)).unwrap();

        assert_eq!(
            withdraw_pending_friend_request(&conn, "dev-a", 100).unwrap(),
            WithdrawOutcome::Withdrawn
        );
        assert!(get_friend_request(&conn, "dev-a").unwrap().is_none());
        assert_eq!(
            get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(),
            Some(100)
        );

        assert_eq!(
            accept_pending_friend_request(&conn, "dev-a", "小李", None).unwrap(),
            PendingAcceptOutcome::NotPending,
            "申请已被撤回 ⇒ 同意必须拿到明确失败，而不是静默加成好友"
        );
        assert!(
            get_friend_checked(&conn, "dev-a").unwrap().is_none(),
            "撤回赢时不许留下好友行"
        );
        assert_eq!(
            get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(),
            Some(100),
            "失败路径不许把墓碑抹掉（否则迟到的重复申请又会弹出来）"
        );
    }

    /// 仲裁方向二：**同意先提交**。之后的撤回必须拿到 `AlreadyFriend` 并让位，
    /// 不许删掉已经建立的好友关系，也不许写墓碑。
    #[test]
    fn accept_wins_then_withdraw_yields_already_friend_and_keeps_the_relationship() {
        let conn = mem();
        put_friend_request(&conn, &req_with_id("dev-a", 100)).unwrap();

        assert_eq!(
            accept_pending_friend_request(&conn, "dev-a", "小李", None).unwrap(),
            PendingAcceptOutcome::Accepted
        );
        assert!(get_friend_checked(&conn, "dev-a").unwrap().is_some());
        assert!(get_friend_request(&conn, "dev-a").unwrap().is_none());

        assert_eq!(
            withdraw_pending_friend_request(&conn, "dev-a", 100).unwrap(),
            WithdrawOutcome::AlreadyFriend,
            "对端要回执 already_friends，撤回方才能收敛到「已同意」"
        );
        assert!(
            get_friend_checked(&conn, "dev-a").unwrap().is_some(),
            "同意赢时撤回不许把好友删掉"
        );
        assert_eq!(
            get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(),
            None,
            "已经加为好友时不该留撤回墓碑"
        );
    }

    /// 重复同意：第二次必须拿到 `AlreadyFriend`（不是 `Accepted`、也不是 `NotPending`），
    /// 且好友表仍然只有一行。
    #[test]
    fn a_repeated_accept_reports_already_friend_without_duplicating_the_row() {
        let conn = mem();
        put_friend_request(&conn, &req_with_id("dev-b", 100)).unwrap();

        assert_eq!(
            accept_pending_friend_request(&conn, "dev-b", "小王", None).unwrap(),
            PendingAcceptOutcome::Accepted
        );
        assert_eq!(
            accept_pending_friend_request(&conn, "dev-b", "小王", None).unwrap(),
            PendingAcceptOutcome::AlreadyFriend
        );
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM friends WHERE device_id='dev-b'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rows, 1, "重复同意不许造出第二行好友");
    }

    /// 撤回必须按稳定 `request_id` 精确命中：id 对不上时不许删除当前申请。
    #[test]
    fn a_withdraw_with_a_different_request_id_does_not_remove_the_current_request() {
        let conn = mem();
        put_friend_request(&conn, &req_with_id("dev-a", 200)).unwrap();

        assert_eq!(
            withdraw_pending_friend_request(&conn, "dev-a", 100).unwrap(),
            WithdrawOutcome::NoMatch
        );
        assert_eq!(
            get_friend_request(&conn, "dev-a").unwrap().map(|r| r.request_id),
            Some(200),
            "旧 request_id 的迟到撤回不许误删新申请"
        );
        assert_eq!(get_withdrawn_request_tombstone(&conn, "dev-a").unwrap(), None);
    }
}
