// 职责边界：
// - 外部应用设备认证 RP 绑定表（rp_device_bindings）CRUD
// ---------------- 外部应用设备认证绑定（2026-11-13，Phase 2） ----------------

use crate::crypto;

/// RP 绑定的**内部行**：含 RP 专属登录私钥，**刻意不 derive Serialize**（INV-P18）。
///
/// 私钥只在命令层签名时本地读取，绝不进命令返回值/事件载荷；前端「已授权应用」清单走
/// `device_auth::RpBindingInfo`（只公钥面）。这与身份密钥同一保护类（本地 SQLite + 0700
/// 目录，无系统 Keychain，限制见设计文档 §3.1）。
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

/// 新建一条绑定。主键 (rp_origin, client_id) 冲突即拒（不静默覆盖旧公钥，设计文档 §3.1）。
pub fn insert_binding(conn: &Connection, b: &RpBindingRow) -> Result<()> {
    conn.execute(
        "INSERT INTO rp_device_bindings \
         (rp_origin, client_id, display_name, kid, public_key, secret_key, pairwise_subject, scopes, status, created_at, last_used_at, revoked_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            b.rp_origin, b.client_id, b.display_name, b.kid, b.public_key, b.secret_key,
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
pub fn get_binding(conn: &Connection, rp_origin: &str, client_id: &str) -> Result<Option<RpBindingRow>> {
    conn.query_row(
        &format!("SELECT {BINDING_COLS} FROM rp_device_bindings WHERE rp_origin = ?1 AND client_id = ?2"),
        params![rp_origin, client_id],
        map_binding_row,
    )
    .optional()
}

/// 全部绑定（含已撤销，前端清单要能显示并管理撤销态），按创建时间倒序。
pub fn list_bindings(conn: &Connection) -> Result<Vec<RpBindingRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BINDING_COLS} FROM rp_device_bindings ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], map_binding_row)?;
    rows.collect()
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