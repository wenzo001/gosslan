// 职责边界：
// - 外部应用设备认证 RP 绑定表（rp_device_bindings）CRUD
// ---------------- 待确认事务的幂等键（跨重启复用，2026-11-16） ----------------
//
// ## 为什么单独存一条
//
// 待确认事务本身是**内存态**（设计文档 §5：拒绝/过期/退出即清除，不落库）——
// 那是刻意的：事务里有 RP 的 claim 列表，放进库里就得管它的过期与清理。
//
// 但**幂等键（jti）必须跨重启活下来**：应用在用户点「同意」之前被关掉/重启，
// 用户重新点同一个链接时，如果新生成了 jti，RP 侧就会看到**两笔不同的决策**
// （断言的 jti 变了 ⇒ 挑战一次性消费 / 登记公钥那条链会当成第二笔事务）。
// 审计原话：「失败、超时和重试必须具备幂等键」—— 重试包括「重启后重来」。
//
// ## 存哪
//
// `settings` 表（键值对）—— **不动表结构**（SQLite schema 属 Frozen Core）。
// 键 = `device_auth_idem:<复合键>`，值 = `<jti>|<过期毫秒>`。
// 过期时间跟着事务的 TTL 走：过期即视为没有（读的时候顺手删掉）。
//
// ## 为什么不是「私钥那套密钥库」
//
// 这里存的是**幂等键**，不是私钥材料：它没有「泄露即伪造身份」的杀伤力
// （RP 侧还要验签 + 一次性消费），但它泄露会让 RP 把两次重试当成两笔事务。
// 落库即明文即可 —— 与「单机安全不额外考虑」的口径一致。

/// 幂等键在 settings 表里的键前缀。
pub const IDEMPOTENCY_KEY_PREFIX: &str = "device_auth_idem:";

/// settings 表里的键（复合键 → 完整键）。
pub fn idempotency_setting_key(pending_key: &str) -> String {
    format!("{IDEMPOTENCY_KEY_PREFIX}{pending_key}")
}

/// 记住某笔待确认事务的幂等键（带过期时间）。
pub fn save_pending_idempotency(
    conn: &Connection,
    pending_key: &str,
    idempotency_key: &str,
    expires_at_ms: i64,
) -> Result<()> {
    crate::db::set_setting(
        conn,
        &idempotency_setting_key(pending_key),
        &format!("{idempotency_key}|{expires_at_ms}"),
    )
}

/// 取某笔待确认事务记住的幂等键。
///
/// 过期 ⇒ 返回 `None` **并顺手删掉**（终态清理：过期的事务不留残迹）。
/// 读失败**上抛**，不折叠成「没有」（读失败与「没这条」必须可分 —— B1-F7）。
pub fn load_pending_idempotency(
    conn: &Connection,
    pending_key: &str,
    now_ms: i64,
) -> Result<Option<String>> {
    let key = idempotency_setting_key(pending_key);
    let raw = crate::db::get_setting_checked(conn, &key)?;
    let Some(raw) = raw else { return Ok(None) };
    let Some((idem, expires)) = raw.rsplit_once('|') else {
        // 形状不对（旧值/被手改过）⇒ 当没有，并清掉。
        crate::db::delete_setting(conn, &key)?;
        return Ok(None);
    };
    let expires_at_ms: i64 = expires.parse().unwrap_or(0);
    if expires_at_ms <= now_ms {
        crate::db::delete_setting(conn, &key)?;
        return Ok(None);
    }
    Ok(Some(idem.to_string()))
}

/// 事务进终态（批准 / 拒绝 / 过期 / 清理）⇒ 删掉记住的幂等键。
pub fn delete_pending_idempotency(conn: &Connection, pending_key: &str) -> Result<()> {
    crate::db::delete_setting(conn, &idempotency_setting_key(pending_key))
}

// ---------------- 外部应用设备认证绑定（2026-11-13，Phase 2） ----------------

use crate::crypto;
// 跨域依赖走 `use` 而不是 `crate::rp_key_store::…` 内联：领域依赖守门只看得见 use 形式
// （内联全路径会变成「判据看不见的耦合」，该守门有棘轮，不许调大）。
use crate::rp_key_store;

/// RP 绑定的**内部行**：含 RP 专属登录私钥，**刻意不 derive Serialize**（INV-P18）。
///
/// 私钥只在命令层签名时本地读取，绝不进命令返回值/事件载荷；前端「已授权应用」清单走
/// `device_auth::RpBindingInfo`（只公钥面）。这与身份密钥同一保护类（本地 SQLite + 0700
/// 目录，无系统 Keychain，限制见设计文档 §3.1）。
///
/// ⚠️ `secret_key` 这一格**有两种可能的形态**，取决于取行用的是哪个函数。
///
/// - `get_binding` / `list_bindings_with_secrets` ⇒ **明文**（已从平台密钥库解开）；
/// - `list_bindings` ⇒ **库里的原样值**（在有密钥库的机器上就是信封 `gsk1.…`）。
///
/// 需要私钥的路径一律走前两个；只需要公钥面的（清单展示）走 `list_bindings`，
/// 免得「密钥库打不开」把整个设置页顶掉。
pub struct RpBindingRow {
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
    pub kid: String,
    pub public_key: String,
    pub secret_key: String,
    pub pairwise_subject: String,
    /// JSON 数组字符串（allowlisted claims）。
    pub scopes: String,
    /// 绑定状态：pending_registration | active | revoked | registration_failed。
    /// 只扩展 status 取值，不改表结构（无 CHECK 约束、无新列），见就绪度审计 §3.2 目标态。
    pub status: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

const BINDING_COLS: &str = "rp_origin, client_id, display_name, kid, public_key, secret_key, \
     pairwise_subject, scopes, status, created_at, last_used_at, revoked_at";

fn map_binding_row(r: &rusqlite::Row<'_>) -> Result<RpBindingRow> {
    Ok(RpBindingRow {
        rp_origin: r.get(0)?,
        client_id: r.get(1)?,
        display_name: r.get(2)?,
        kid: r.get(3)?,
        public_key: r.get(4)?,
        secret_key: r.get(5)?,
        pairwise_subject: r.get(6)?,
        scopes: r.get(7)?,
        status: r.get(8)?,
        created_at: r.get(9)?,
        last_used_at: r.get(10)?,
        revoked_at: r.get(11)?,
    })
}

/// 写库前：把私钥封进**本机平台密钥库**（Windows DPAPI / Android Keystore）。
///
/// 三种结果，**没有第四种**：
/// - 本机有密钥库 ⇒ 返回信封（`gsk1.<后端>.<载荷>`）；
/// - 本机没有（macOS 暂缓 / Linux）⇒ 原样返回（维持旧行为，不是失败）；
/// - 密钥库**用不了** ⇒ 报错。**绝不**回落成明文写库 ——
///   那种静默降级会让用户以为私钥已经受系统保护了。
fn sealed_for_storage(stored: &str) -> Result<String> {
    if rp_key_store::is_envelope(stored) {
        return Ok(stored.to_string());
    }
    match rp_key_store::seal_secret(stored) {
        Ok(Some(envelope)) => Ok(envelope),
        Ok(None) => Ok(stored.to_string()),
        Err(e) => Err(rusqlite::Error::ToSqlConversionFailure(Box::new(e))),
    }
}

/// 读库后：把信封解回明文（非信封 = 旧格式明文，原样返回）。
///
/// 解不开 ⇒ 报错上抛（fail closed）：密钥库不可用时**不回落明文**。
fn opened_secret(stored: &str) -> Result<String> {
    rp_key_store::open_secret(stored)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

/// 把库里那一格私钥处理成「内存里的明文」，并**顺手把旧格式升级成密钥库信封**。
///
/// 升级顺序（**封 → 开回来逐字验 → 才写回**，见 `rp_key_store.rs` 的硬约束②）：
/// 1. 已是信封 ⇒ 直接开；开不开 ⇒ 报错（不回落明文）；
/// 2. 还是旧格式明文 ⇒ 本机有密钥库就封一份、开回来比对一致才写回；
///    封不上（本机没有密钥库）⇒ 原样返回（本机不支持，不算失败）。
///
/// 写回只动 `secret_key` 一列，**不动表结构**（SQLite schema 属 Frozen Core）。
fn upgrade_and_open(conn: &Connection, row: &RpBindingRow) -> Result<String> {
    if rp_key_store::is_envelope(&row.secret_key) {
        return opened_secret(&row.secret_key);
    }
    let Some(envelope) = rp_key_store::seal_secret(&row.secret_key)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?
    else {
        // 本机没有密钥库（macOS 暂缓 / Linux）：保持旧行为。
        return Ok(row.secret_key.clone());
    };
    // 验一次：开回来必须与原文逐字相同，否则**不写回**（宁可不升级，也不能写坏）。
    let back = opened_secret(&envelope)?;
    if back != row.secret_key {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            rp_key_store::KeyStoreError::Malformed(
                "升级校验不一致（封回去解出来不是同一串）—— 已放弃写回，库里仍是旧值".into(),
            ),
        )));
    }
    conn.execute(
        "UPDATE rp_device_bindings SET secret_key = ?3 WHERE rp_origin = ?1 AND client_id = ?2",
        params![row.rp_origin, row.client_id, envelope],
    )?;
    Ok(row.secret_key.clone())
}

/// 新建一条绑定。主键 (rp_origin, client_id) 冲突即拒（不静默覆盖旧公钥，设计文档 §3.1）。
///
/// 私钥在这里**封进平台密钥库**再落库（有密钥库的平台）/ 原样落库（没有密钥库的平台）。
pub fn insert_binding(conn: &Connection, b: &RpBindingRow) -> Result<()> {
    let secret = sealed_for_storage(&b.secret_key)?;
    conn.execute(
        "INSERT INTO rp_device_bindings \
         (rp_origin, client_id, display_name, kid, public_key, secret_key, pairwise_subject, scopes, status, created_at, last_used_at, revoked_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            b.rp_origin, b.client_id, b.display_name, b.kid, b.public_key, secret,
            b.pairwise_subject, b.scopes, b.status, b.created_at, b.last_used_at, b.revoked_at
        ],
    )?;
    Ok(())
}

/// 首绑落库（#3）：RP 私钥的**导出只在此持久化路径**发生 —— `key.rp_secret_b64()` 是
/// INV-P18 判据 C 授权给本文件（与身份密钥导出器只许 state.rs 调同一口径）。命令层只交来
/// 能力封装 `key` 与公钥面（public_key/kid/subject），绝不触碰 secret 字节或原始 SigningKey。
///
/// 状态刻意落 `pending_registration` 而不是 `active`：只有 RP 回写 2xx 后才由 `activate_binding`
/// 推进到 active。为什么：旧实现回调前就写 active，回写失败便形成「本地已授权、RP 未登记」
/// 的分叉（就绪度审计 §3.3 首绑分叉）。重试时该行已存在，`prepare_assertion` 复用同一密钥。
#[allow(clippy::too_many_arguments)] // 绑定字段直传（与 insert_binding 的列同形）；不打包成含 secret 的结构体，免得私钥面扩散
pub fn insert_rp_binding(
    conn: &Connection,
    rp_origin: &str,
    client_id: &str,
    display_name: &str,
    key: &crypto::RpKey,
    public_key: String,
    kid: String,
    pairwise_subject: String,
    scopes: String,
    now_ms: i64,
) -> Result<RpBindingRow> {
    let row = RpBindingRow {
        rp_origin: rp_origin.to_string(),
        client_id: client_id.to_string(),
        display_name: display_name.to_string(),
        kid,
        public_key,
        secret_key: key.rp_secret_b64(),
        pairwise_subject,
        scopes,
        status: "pending_registration".to_string(),
        created_at: now_ms,
        last_used_at: Some(now_ms),
        revoked_at: None,
    };
    insert_binding(conn, &row)?;
    Ok(row)
}

/// 取一条绑定。**读库错误与「没有这条」分开**：`optional()` 只把 NoRows 折成 None，
/// 其它错误向上抛（读-改-写路径不能把读抖动当成「没绑定」）。
///
/// 私钥**已解密**（平台密钥库的信封在此解开）；顺手把旧格式（明文）升级成信封。
pub fn get_binding(conn: &Connection, rp_origin: &str, client_id: &str) -> Result<Option<RpBindingRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {BINDING_COLS} FROM rp_device_bindings WHERE rp_origin = ?1 AND client_id = ?2"),
            params![rp_origin, client_id],
            map_binding_row,
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some(mut r) => {
            r.secret_key = upgrade_and_open(conn, &r)?;
            Ok(Some(r))
        }
    }
}

/// 全部绑定（含已撤销，前端清单要能显示并管理撤销态），按创建时间倒序。
///
/// ⚠️ 这里的 `secret_key` 是**库里的原样值**（可能是密钥库信封）：这个函数服务
/// 「只要公钥面」的清单展示，不去碰密钥库 —— 免得「密钥库打不开」把整个设置页顶掉。
/// 要私钥的路径用 `get_binding` 或 `list_bindings_with_secrets`。
pub fn list_bindings(conn: &Connection) -> Result<Vec<RpBindingRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BINDING_COLS} FROM rp_device_bindings ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], map_binding_row)?;
    rows.collect()
}

/// 全部绑定，**私钥已解密**。导出用。
///
/// 为什么导出要明文：导出包自己用**用户口令**加密（Argon2id + XChaCha20-Poly1305），
/// 它的卖点就是「换机/重装能迁移」⇒ 里面装的是这台机器的密钥库信封就废了
/// （DPAPI 绑机器、Keystore 绑设备，换台机器根本解不开）。
pub fn list_bindings_with_secrets(conn: &Connection) -> Result<Vec<RpBindingRow>> {
    let rows = list_bindings(conn)?;
    let mut out = Vec::with_capacity(rows.len());
    for mut r in rows {
        if rp_key_store::is_envelope(&r.secret_key) {
            r.secret_key = opened_secret(&r.secret_key)?;
        }
        out.push(r);
    }
    Ok(out)
}

/// 记一次最近使用（authenticate 成功后）。
pub fn touch_last_used(conn: &Connection, rp_origin: &str, client_id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE rp_device_bindings SET last_used_at = ?3 WHERE rp_origin = ?1 AND client_id = ?2",
        params![rp_origin, client_id, now],
    )?;
    Ok(())
}

/// 撤销绑定：只置 status/revoked_at，**不删密钥行**（旧公钥须由 RP 账号页撤销，本地保留审计痕迹）。
/// 返回是否真的撤销了一条 active 绑定（幂等：已撤销/不存在 ⇒ false）。
///
/// `WHERE status = 'active'` 即「撤销只允许 active」：pending_registration / registration_failed
/// 这类未登记完成的绑定不许被撤销（它们应走批准重试重新登记，撤销没有意义）。
pub fn revoke_binding(conn: &Connection, rp_origin: &str, client_id: &str, now: i64) -> Result<bool> {
    let n = conn.execute(
        "UPDATE rp_device_bindings SET status = 'revoked', revoked_at = ?3 \
         WHERE rp_origin = ?1 AND client_id = ?2 AND status = 'active'",
        params![rp_origin, client_id, now],
    )?;
    Ok(n > 0)
}

/// RP 回写 2xx 后把「待登记 / 登记失败重试成功」的绑定推进到 active。
/// 只作用于中间态，已是 active 或已 revoked 的行不动（幂等，不误把撤销态复活）。
/// 返回是否真的推进了一条。
pub fn activate_binding(conn: &Connection, rp_origin: &str, client_id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE rp_device_bindings SET status = 'active', revoked_at = NULL \
         WHERE rp_origin = ?1 AND client_id = ?2 \
           AND status IN ('pending_registration', 'registration_failed')",
        params![rp_origin, client_id],
    )?;
    Ok(n > 0)
}

/// RP 回写失败/超时后把「待登记」绑定落到可重试终态 `registration_failed`。
/// 只作用于 pending_registration（已是 registration_failed 无需再写，active 不许被回退）。
/// 重试复用同一密钥、不重复 insert（就绪度审计 §3.2 失败终态）。返回是否真的落了一条。
pub fn mark_registration_failed(conn: &Connection, rp_origin: &str, client_id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE rp_device_bindings SET status = 'registration_failed' \
         WHERE rp_origin = ?1 AND client_id = ?2 AND status = 'pending_registration'",
        params![rp_origin, client_id],
    )?;
    Ok(n > 0)
}