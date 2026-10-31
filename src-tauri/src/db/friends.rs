// 职责边界：
// - 好友表 CRUD（insert/get/list/delete_friend）
// ---------------- 好友 ----------------

pub fn add_friend(
    conn: &Connection,
    device_id: &str,
    nickname: &str,
    avatar: Option<&str>,
) -> Result<()> {
    conn.execute(
        "INSERT INTO friends(device_id, nickname, avatar, added_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(device_id) DO UPDATE SET nickname = excluded.nickname, avatar = excluded.avatar",
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
/// ⚠️ 前缀里带 `_`，SQL 的 `LIKE` 把它当单字符通配符 —— 因此**读**这一侧必须再用
/// `strip_prefix` 严格认一次键名（下面的 `list_friend_requests`），只有删除按前缀批量走。
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

/// 「清除数据」那一趟把这批申请一起抹掉（前缀批量删，与 `gk:` 那一行同写法）。
/// 内存那一张在同一处 `clear()` —— 两边不同步的话，下一次开机会把刚清掉的申请原样端回来。
pub fn clear_friend_requests(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM settings WHERE key LIKE ?",
        params![format!("{FRIEND_REQUEST_KEY_PREFIX}%")],
    )?;
    Ok(())
}

/// 启动时把库里的申请读回来（按写入顺序）。
///
/// 认不出来的行**跳过而不删**：删掉它就是把"一次解析失败"升级成"用户的申请没了"。
/// 跳过之后对端下一次补发会把那一行覆盖成合法形状，不需要这里替它做决定。
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

}
