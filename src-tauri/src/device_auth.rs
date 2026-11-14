//! 外部应用设备认证（2026-11-13，external-app-device-auth Phase 2）—— Gosslan 作为本地设备确认器。
//!
//! 设计依据：`docs/notes/external-app-device-auth-design-2026-11-13.md`。Gosslan **不**是中心
//! 账号提供方：外部应用（RP）自有账号后端，Gosslan 只在用户明确批准后证明「本安装持有该 RP
//! 专属密钥」。本模块是纯协议核心（解析/校验/签名），命令层在 `commands/device_auth.rs`。
//!
//! 安全边界（INV-P18 延伸）：
//! - RP 专属 Ed25519 登录密钥与 P2P 身份密钥**分开**（避免跨站关联）；私钥只在签名时本地用，
//!   绝不进任何 `Serialize` 类型 / 命令返回值 / 事件载荷。前端清单只拿公钥面（`RpBindingInfo`）。
//! - 来源只信 HTTPS 同源 metadata 的 `issuer`，不信深链里的 display_name/callback；端点跨域即拒。
//! - 短时、一次性、防重放；未知 version/action/claim 整笔拒（fail closed）。
//! - 本流程**不**加好友、不接受好友申请、不改 P2P 身份锚点。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::crypto;
use crate::error_codes;

/// 协议版本（metadata/request 都必须等于它，未知版本整笔拒）。
pub const PROTOCOL_VERSION: &str = "1";
/// JWS 断言的固定 `typ`。
pub const ASSERTION_TYP: &str = "gosslan-device-auth+jwt";
/// 断言有效期（秒）：签名后 60s 内有效，设计文档 §4.4 建议 ≤60s。
pub const ASSERTION_TTL_SECS: i64 = 60;
/// 待确认事务的**本地兜底 TTL**（毫秒）：有效期取 RP `expires_at` 与「插入后这段时长」的较早者。
/// 为什么：TTL 完全来自 RP，RP 给了超长/畸形过期时间时事务会无限期挂在内存；本地封顶保证
/// 事务必然有终点，重启即空之外也有一道可证明的上限（就绪度审计 §4 最大 TTL）。
pub const LOCAL_PENDING_TTL_MS: i64 = 5 * 60 * 1000;
/// 首期支持的 RP 动作。
pub const ALLOWED_ACTIONS: [&str; 2] = ["link", "authenticate"];
/// 首期 claim allowlist：pairwise subject + 设备公钥；昵称仅用户主动允许（默认不选）。
pub const ALLOWED_CLAIMS: [&str; 3] = ["device_subject", "device_public_key", "nickname"];

/// RP 元数据（`GET https://<origin>/.well-known/gosslan-device-auth`）。
#[derive(Debug, Clone, Deserialize)]
pub struct RpMetadata {
    pub protocol_version: String,
    pub client_id: String,
    pub display_name: String,
    pub issuer: String,
    pub request_endpoint: String,
    pub decision_endpoint: String,
    /// 浏览器轮询端点：桌面客户端不轮询（由 RP 页面轮询），deserialize 保留只为契约完整。
    #[serde(default)]
    #[allow(dead_code)]
    pub poll_endpoint: String,
    pub supported_actions: Vec<String>,
    pub supported_claims: Vec<String>,
}

/// RP 待确认请求（`GET request_endpoint`）。
#[derive(Debug, Clone, Deserialize)]
pub struct RpRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub client_id: String,
    pub issuer: String,
    #[serde(default)]
    pub display_name: String,
    pub action: String,
    #[serde(default)]
    pub account_hint: String,
    pub requested_claims: Vec<String>,
    pub challenge: String,
    pub expires_at: String,
}

/// 深链解析结果：规范化 HTTPS 来源 + 不透明事务引用（= request_id）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizeLink {
    pub rp_origin: String,
    pub request_ref: String,
}

/// 确认页给前端的数据（**无密钥材料**，INV-P18 判据 A）。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceAuthPrompt {
    pub request_id: String,
    /// 规范化来源域（来自 metadata.issuer，主要防钓鱼线索）。
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
    pub action: String,
    pub account_hint: String,
    pub requested_claims: Vec<String>,
    /// 过期时间（Unix ms）。
    pub expires_at_ms: i64,
    /// 昵称是否默认勾选（恒 false：最小披露，用户主动允许才共享）。
    pub nickname_default: bool,
}

/// 「已授权应用」清单条目（**只公钥面**，无 secret_key，INV-P18 判据 A）。
#[derive(Debug, Clone, Serialize)]
pub struct RpBindingInfo {
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
    pub kid: String,
    pub public_key: String,
    pub pairwise_subject: String,
    pub scopes: Vec<String>,
    pub status: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
}

/// 批准/拒绝的结果（**无断言/密钥**：断言只发给 RP，不回前端）。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceAuthOutcome {
    /// approved | denied。保持既有语义不变（前端既按此字段分支）。
    pub decision: String,
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
    /// 决策是否已被 RP 以 2xx 确认收到（**新增可观察字段**，不破坏 `decision` 兼容语义）。
    /// 为什么：旧实现丢弃拒绝回写结果，恒回 `denied`，本机已拒绝 / RP 已收到拒绝不可区分。
    /// `approve` 恒为 true（结果只在 RP 回写 2xx 后返回）；`deny` 回写失败为 false
    /// ⇒ 前端据此显示重试入口，事务保留可重试态（就绪度审计 §4 拒绝可观察状态与重试）。
    pub rp_notified: bool,
}

/// 待确认事务（命令层**内存态**，不落库；拒绝/过期/退出即清除，设计文档 §5）。
/// 不含密钥材料；确认页数据由它派生（`DeviceAuthPrompt`）。
///
/// `generation`（#8）：本事务的代际号，插入时由全局计数器分配。批准排队期间若事务被
/// 消费/清数据/同键重插，代际对不上 ⇒ 旧的在途批准必须放弃（不重复回写、不复活已清事务）。
#[derive(Clone)]
pub struct PendingDeviceAuth {
    pub meta: RpMetadata,
    pub request: RpRequest,
    pub rp_origin: String,
    pub expires_at_ms: i64,
    pub generation: u64,
    /// 本事务的**幂等键**（插入时生成一次，随事务持久化在内存态，重试全程复用）。
    /// 为什么：断言 `jti` 与回写 `Idempotency-Key` 都必须跨重试稳定，否则网络重试会被 RP
    /// 当成两次不同决策（重复登记公钥 / 重复建会话）。放在 pending 上，prepare/sign/post
    /// 各步都读同一个值（就绪度审计 §4 idempotency key / 挑战一次性消费）。
    pub idempotency_key: String,
}

/// 待确认事务的**复合键**（rp_origin + client_id + request_id，#8）：
/// 不同 RP 即便复用同一 request_id 也不会互相顶掉（单键 request_id 的撞键缺陷）。
/// 分隔符用不可见单元分隔符 `\u{1f}`，避免与字段内容歧义。
pub fn pending_key(rp_origin: &str, client_id: &str, request_id: &str) -> String {
    format!("{rp_origin}\u{1f}{client_id}\u{1f}{request_id}")
}

/// 同一 RP 的授权**排队键**（rp_origin + client_id，#1）：同 RP 的多个批准依次处理，
/// 不同 RP 并行。与复合键的区别：排队按 RP 聚合（一个 RP 一把锁），事务按复合键区分。
pub fn rp_queue_key(rp_origin: &str, client_id: &str) -> String {
    format!("{rp_origin}\u{1f}{client_id}")
}

impl PendingDeviceAuth {
    /// 派生确认页数据（来源取 metadata.issuer 规范化值，防钓鱼；昵称默认不勾选）。
    pub fn prompt(&self) -> DeviceAuthPrompt {
        DeviceAuthPrompt {
            request_id: self.request.request_id.clone(),
            rp_origin: self.rp_origin.clone(),
            client_id: self.meta.client_id.clone(),
            // 应用名优先取 metadata（受信来源）；metadata 没给时回落请求里的显示名。
            display_name: if self.meta.display_name.is_empty() {
                self.request.display_name.clone()
            } else {
                self.meta.display_name.clone()
            },
            action: self.request.action.clone(),
            account_hint: self.request.account_hint.clone(),
            requested_claims: self.request.requested_claims.clone(),
            expires_at_ms: self.expires_at_ms,
            nickname_default: false,
        }
    }
}

/// 规范化 RP 来源：只接受 HTTPS，拒 userinfo/query/fragment，返回 `scheme://host[:port]`。
///
/// 比 `validate_external_url` 更严：RP 来源不允许 http 降级（设计文档 §6 callback 限制）。
pub fn normalize_rp_origin(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| {
        error_codes::coded(
            error_codes::DEVICE_AUTH_INVALID_ORIGIN,
            "RP 来源网址格式不正确",
        )
    })?;
    if parsed.scheme() != "https" {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_INVALID_ORIGIN,
            "RP 来源必须是 HTTPS",
        ));
    }
    let host = parsed.host_str().filter(|h| !h.is_empty()).ok_or_else(|| {
        error_codes::coded(error_codes::DEVICE_AUTH_INVALID_ORIGIN, "RP 来源缺少主机名")
    })?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_INVALID_ORIGIN,
            "RP 来源不许带用户名/密码",
        ));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_INVALID_ORIGIN,
            "RP 来源不许带 query/fragment",
        ));
    }
    let mut origin = format!("https://{host}");
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

/// 两个 URL 是否同源（scheme + host + port 相同）。
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 校验 metadata：版本、issuer 与期望来源一致、各端点 HTTPS 同源、动作/claim 在 allowlist。
pub fn validate_metadata(meta: &RpMetadata, expected_origin: &str) -> Result<(), String> {
    if meta.protocol_version != PROTOCOL_VERSION {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNSUPPORTED,
            "不支持的协议版本",
        ));
    }
    let issuer = normalize_rp_origin(&meta.issuer)?;
    if issuer != expected_origin {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_CROSS_ORIGIN,
            "metadata 的 issuer 与请求来源不一致",
        ));
    }
    let issuer_url = Url::parse(&issuer).map_err(|_| {
        error_codes::coded(error_codes::DEVICE_AUTH_BAD_METADATA, "issuer 解析失败")
    })?;
    for endpoint in [&meta.request_endpoint, &meta.decision_endpoint] {
        let u = Url::parse(endpoint).map_err(|_| {
            error_codes::coded(error_codes::DEVICE_AUTH_BAD_METADATA, "端点网址格式不正确")
        })?;
        if u.scheme() != "https" || !same_origin(&u, &issuer_url) {
            return Err(error_codes::coded(
                error_codes::DEVICE_AUTH_CROSS_ORIGIN,
                "端点必须与 issuer 同源且为 HTTPS",
            ));
        }
    }
    if meta.client_id.trim().is_empty() {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_BAD_METADATA,
            "client_id 不能为空",
        ));
    }
    if meta.supported_actions.is_empty()
        || meta
            .supported_actions
            .iter()
            .any(|a| !ALLOWED_ACTIONS.contains(&a.as_str()))
    {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNSUPPORTED,
            "含不支持的动作",
        ));
    }
    if meta
        .supported_claims
        .iter()
        .any(|c| !ALLOWED_CLAIMS.contains(&c.as_str()))
    {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNKNOWN_CLAIM,
            "含未知 claim",
        ));
    }
    Ok(())
}

/// 解析 RFC3339 过期时间为 Unix ms；非法返回 None。
pub fn parse_expiry_ms(rfc3339: &str) -> Option<i64> {
    let dt = time::OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339)
        .ok()?;
    Some((dt.unix_timestamp_nanos() / 1_000_000) as i64)
}

/// 本地 TTL 兜底：待确认事务有效期取「RP expires_at」与「插入后固定上限」的较早者。
/// 为什么：只信 RP 的过期时间没有上界，畸形或超长值会让事务永远留在内存；取较早者既不缩短
/// RP 自己设的短 TTL，又给所有事务一个可证明的本地终点（就绪度审计 §4 最大 TTL）。
pub fn clamp_pending_expiry(rp_expires_at_ms: i64, now_ms: i64) -> i64 {
    rp_expires_at_ms.min(now_ms.saturating_add(LOCAL_PENDING_TTL_MS))
}

/// 校验请求：版本、与 metadata 一致、动作/claim 合法、challenge 形状、未过期。
pub fn validate_request(req: &RpRequest, meta: &RpMetadata, now_ms: i64) -> Result<i64, String> {
    if req.protocol_version != PROTOCOL_VERSION {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNSUPPORTED,
            "不支持的协议版本",
        ));
    }
    if req.request_id.trim().is_empty() {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_BAD_REQUEST,
            "request_id 不能为空",
        ));
    }
    if req.client_id != meta.client_id
        || normalize_rp_origin(&req.issuer)? != normalize_rp_origin(&meta.issuer)?
    {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_CROSS_ORIGIN,
            "请求与 metadata 的 client_id/issuer 不一致",
        ));
    }
    if !ALLOWED_ACTIONS.contains(&req.action.as_str())
        || !meta.supported_actions.contains(&req.action)
    {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNSUPPORTED,
            "不支持的动作",
        ));
    }
    if req.requested_claims.is_empty()
        || req
            .requested_claims
            .iter()
            .any(|c| !ALLOWED_CLAIMS.contains(&c.as_str()) || !meta.supported_claims.contains(c))
    {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_UNKNOWN_CLAIM,
            "请求了未知或未支持的 claim",
        ));
    }
    // challenge：base64url，解码后至少 32 字节（256-bit nonce）。
    let challenge_bytes = URL_SAFE_NO_PAD.decode(req.challenge.trim()).map_err(|_| {
        error_codes::coded(
            error_codes::DEVICE_AUTH_BAD_REQUEST,
            "challenge 不是合法 base64url",
        )
    })?;
    if challenge_bytes.len() < 32 {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_BAD_REQUEST,
            "challenge 熵不足",
        ));
    }
    let expires_ms = parse_expiry_ms(&req.expires_at).ok_or_else(|| {
        error_codes::coded(
            error_codes::DEVICE_AUTH_BAD_REQUEST,
            "expires_at 不是合法 RFC3339",
        )
    })?;
    if expires_ms <= now_ms {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_EXPIRED,
            "事务已过期",
        ));
    }
    Ok(expires_ms)
}

/// 解析授权深链。支持两种形态：
/// - HTTPS App Link：`https://<rp-origin>/authorize/<ref>`（来源即链接主机，优先）。
/// - 自定义 scheme 回退：`gosslan://authorize/<ref>?origin=<https-origin>`。
///
/// 无论哪种，来源都经 `normalize_rp_origin` 收紧；真实来源仍以 metadata.issuer 为准（防钓鱼）。
pub fn parse_authorize_link(raw: &str) -> Result<AuthorizeLink, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| {
        error_codes::coded(error_codes::DEVICE_AUTH_INVALID_LINK, "授权链接格式不正确")
    })?;
    let (origin, ref_seg) = match parsed.scheme() {
        "https" => {
            let origin = normalize_rp_origin(&parsed[..url::Position::AfterPort])?;
            let seg = parsed
                .path_segments()
                .and_then(|mut s| {
                    let first = s.next()?;
                    if first != "authorize" {
                        return None;
                    }
                    s.next().map(str::to_string)
                })
                .ok_or_else(|| {
                    error_codes::coded(
                        error_codes::DEVICE_AUTH_INVALID_LINK,
                        "链接路径必须是 /authorize/<ref>",
                    )
                })?;
            (origin, seg)
        }
        "gosslan" => {
            if parsed.host_str() != Some("authorize") {
                return Err(error_codes::coded(
                    error_codes::DEVICE_AUTH_INVALID_LINK,
                    "自定义 scheme 主机必须是 authorize",
                ));
            }
            let seg = parsed
                .path_segments()
                .and_then(|mut s| s.next().map(str::to_string))
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    error_codes::coded(error_codes::DEVICE_AUTH_INVALID_LINK, "缺少事务引用")
                })?;
            let origin_param = parsed
                .query_pairs()
                .find(|(k, _)| k == "origin")
                .map(|(_, v)| v.to_string())
                .ok_or_else(|| {
                    error_codes::coded(
                        error_codes::DEVICE_AUTH_INVALID_LINK,
                        "自定义 scheme 必须带 origin 参数",
                    )
                })?;
            (normalize_rp_origin(&origin_param)?, seg)
        }
        _ => {
            return Err(error_codes::coded(
                error_codes::DEVICE_AUTH_INVALID_LINK,
                "不支持的链接 scheme",
            ))
        }
    };
    if ref_seg.trim().is_empty() {
        return Err(error_codes::coded(
            error_codes::DEVICE_AUTH_INVALID_LINK,
            "事务引用不能为空",
        ));
    }
    Ok(AuthorizeLink {
        rp_origin: origin,
        request_ref: ref_seg,
    })
}

/// `/share` 深链解析结果（**骨架**）：规范化 HTTPS 来源 + 不透明分享引用。
/// 与授权深链分开建模，避免分享借 `authenticate` 的通道（活契约 §6：认证与分享不得混成网页桥）。
// 本任务只交付解析骨架，按要求**不注册命令 / 不发网络 / 不实现分享发送**，故当下只有单测引用。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLinkRef {
    /// 规范化 HTTPS 来源（来自链接主机或 `origin` 参数，经 `normalize_rp_origin` 收紧）。
    pub rp_origin: String,
    /// 不透明分享引用，本函数不做任何语义解释。
    pub share_ref: String,
}

/// 解析 `/share` 深链的**纯函数骨架**：只校验形状与来源，不注册命令、不发网络、不实现分享发送。
///
/// 只接受两种形态，其余一律 `None`（fail closed）：
/// - HTTPS App Link：`https://<host>/share/<opaque-ref>`，来源即链接主机。
/// - 自定义 scheme：`gosslan://share/<ref>?origin=<https-origin>`，来源来自 `origin` 参数。
///
/// 来源复用 `normalize_rp_origin` 的 HTTPS 同源收紧口径：拒 http 降级、userinfo、query/fragment、
/// 缺主机。为什么放在协议核心而不是命令层：这是纯解析/校验，和 `parse_authorize_link` 同一类，
/// 也便于在真正接入分享前先用单测把边界钉死（`device_auth_tests.rs`）。
// 骨架暂不接线（见 ShareLinkRef 的说明），当下仅由单测引用。
#[allow(dead_code)]
pub fn parse_share_link(raw: &str) -> Option<ShareLinkRef> {
    let parsed = Url::parse(raw.trim()).ok()?;
    // 收集非空路径段：尾斜杠折出的空段忽略，但多出来的非空段一律拒（ref 是不透明单段）。
    let segments: Vec<String> = parsed
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let (origin, share_ref) = match parsed.scheme() {
        "https" => {
            let origin = normalize_rp_origin(&parsed[..url::Position::AfterPort]).ok()?;
            if segments.len() != 2 || segments[0] != "share" {
                return None;
            }
            (origin, segments[1].clone())
        }
        "gosslan" => {
            if parsed.host_str() != Some("share") || segments.len() != 1 {
                return None;
            }
            let origin_param = parsed
                .query_pairs()
                .find(|(k, _)| k == "origin")
                .map(|(_, v)| v.to_string())?;
            (
                normalize_rp_origin(&origin_param).ok()?,
                segments[0].clone(),
            )
        }
        _ => return None,
    };
    if share_ref.trim().is_empty() {
        return None;
    }
    Some(ShareLinkRef {
        rp_origin: origin,
        share_ref,
    })
}

/// 公钥指纹 kid = base64url(sha256(raw 32B 公钥))。
pub fn kid_from_public(public_bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_bytes))
}

/// 生成 RP 专属登录密钥 + pairwise subject。**绝不**复用 `state.identity`（避免跨站关联）。
///
/// 返回 (签名能力, base64url 公钥, kid, pairwise subject)。私钥的生成/编码/签名都在
/// `crypto::RpKey` 能力封装内（#3）：本函数与命令层只拿到**公钥面**与能力，不触碰原始
/// `SigningKey`。能力由持久化那一家（`db/device_auth.rs`）落库，公钥/kid/subject 进绑定与断言。
pub fn generate_rp_key() -> (crypto::RpKey, String, String, String) {
    let key = crypto::RpKey::generate();
    let public_bytes = key.public_key_bytes();
    let public_b64 = URL_SAFE_NO_PAD.encode(public_bytes);
    let kid = kid_from_public(&public_bytes);
    let subject = uuid::Uuid::new_v4().to_string();
    (key, public_b64, kid, subject)
}

/// 断言 audience：issuer + `/api/device-auth`（与 RP 约定一致，mock RP 同口径校验）。
pub fn assertion_audience(issuer: &str) -> String {
    format!("{}/api/device-auth", issuer.trim_end_matches('/'))
}

/// 构造并签名 JWS EdDSA 断言（设计文档 §4.4）。
///
/// header `{alg:EdDSA, typ, kid}`；payload `{iss:subject, aud, client_id, transaction_id,
/// challenge, action, iat, exp=iat+60, jti}`。签名主体 = b64url(header).b64url(payload)。
/// `now_secs` 由调用方传入（便于测试）；`jti` 由调用方传入并等于该事务的幂等键 —— 不再每次
/// 随机生成，重试全程复用同一值（就绪度审计 §4：jti 每次重试换新、客户端不持久化）。
/// 签名经 `crypto::RpKey` 能力完成，本函数不触碰原始私钥（#3）。
pub fn sign_assertion(
    signer: &crypto::RpKey,
    kid: &str,
    subject: &str,
    meta: &RpMetadata,
    req: &RpRequest,
    now_secs: i64,
    jti: &str,
) -> String {
    let header = serde_json::json!({ "alg": "EdDSA", "typ": ASSERTION_TYP, "kid": kid });
    let payload = serde_json::json!({
        "iss": subject,
        "aud": assertion_audience(&meta.issuer),
        "client_id": meta.client_id,
        "transaction_id": req.request_id,
        "challenge": req.challenge,
        "action": req.action,
        "iat": now_secs,
        "exp": now_secs + ASSERTION_TTL_SECS,
        "jti": jti,
    });
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
    let signing_input = format!("{header_b64}.{payload_b64}");
    let sig_b64 = URL_SAFE_NO_PAD.encode(signer.sign(signing_input.as_bytes()));
    format!("{signing_input}.{sig_b64}")
}

/// 用绑定行里的 RP 私钥（base64 std 32B seed）签断言。
///
/// 私钥的**解码与签名都在 `crypto::RpKey` 内**完成（#3）：本函数只把持久化的不透明 seed
/// 串交给能力封装重建，绝不返回私钥（INV-P18）；命令层只拿回断言串。
/// 密钥损坏（非法 base64 / 非 32 字节）⇒ 明确报错，不静默用新密钥覆盖。
pub fn sign_with_binding(
    secret_b64: &str,
    kid: &str,
    subject: &str,
    meta: &RpMetadata,
    req: &RpRequest,
    now_secs: i64,
    jti: &str,
) -> Result<String, String> {
    let key = crypto::RpKey::from_secret_b64(secret_b64)
        .ok_or_else(|| error_codes::coded(error_codes::DEVICE_AUTH_BAD_REQUEST, "绑定密钥损坏"))?;
    Ok(sign_assertion(&key, kid, subject, meta, req, now_secs, jti))
}

#[cfg(test)]
mod device_auth_tests;
