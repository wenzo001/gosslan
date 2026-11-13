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

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::error_codes;

/// 协议版本（metadata/request 都必须等于它，未知版本整笔拒）。
pub const PROTOCOL_VERSION: &str = "1";
/// JWS 断言的固定 `typ`。
pub const ASSERTION_TYP: &str = "gosslan-device-auth+jwt";
/// 断言有效期（秒）：签名后 60s 内有效，设计文档 §4.4 建议 ≤60s。
pub const ASSERTION_TTL_SECS: i64 = 60;
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
    /// approved | denied。
    pub decision: String,
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
}

/// 待确认事务（命令层**内存态**，不落库；拒绝/过期/退出即清除，设计文档 §5）。
/// 不含密钥材料；确认页数据由它派生（`DeviceAuthPrompt`）。
pub struct PendingDeviceAuth {
    pub meta: RpMetadata,
    pub request: RpRequest,
    pub rp_origin: String,
    pub expires_at_ms: i64,
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

/// 公钥指纹 kid = base64url(sha256(raw 32B 公钥))。
pub fn kid_from_public(public_bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_bytes))
}

/// 生成 RP 专属登录密钥 + pairwise subject。**绝不**复用 `state.identity`（避免跨站关联）。
///
/// 返回 (签名密钥, base64url 公钥, kid, pairwise subject)。签名密钥由命令层落库（内部行，
/// 不序列化），公钥/kid/subject 进绑定记录与断言。
pub fn generate_rp_key() -> (SigningKey, String, String, String) {
    let signing = SigningKey::generate(&mut OsRng);
    let public_bytes = signing.verifying_key().to_bytes();
    let public_b64 = URL_SAFE_NO_PAD.encode(public_bytes);
    let kid = kid_from_public(&public_bytes);
    let subject = uuid::Uuid::new_v4().to_string();
    (signing, public_b64, kid, subject)
}

/// 断言 audience：issuer + `/api/device-auth`（与 RP 约定一致，mock RP 同口径校验）。
pub fn assertion_audience(issuer: &str) -> String {
    format!("{}/api/device-auth", issuer.trim_end_matches('/'))
}

/// 构造并签名 JWS EdDSA 断言（设计文档 §4.4）。
///
/// header `{alg:EdDSA, typ, kid}`；payload `{iss:subject, aud, client_id, transaction_id,
/// challenge, action, iat, exp=iat+60, jti}`。签名主体 = b64url(header).b64url(payload)。
/// `now_secs` 由调用方传入（便于测试）；jti 随机一次性。
pub fn sign_assertion(
    signing: &SigningKey,
    kid: &str,
    subject: &str,
    meta: &RpMetadata,
    req: &RpRequest,
    now_secs: i64,
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
        "jti": uuid::Uuid::new_v4().to_string(),
    });
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
    let signing_input = format!("{header_b64}.{payload_b64}");
    let sig = signing.sign(signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(sig.to_bytes());
    format!("{signing_input}.{sig_b64}")
}

/// 用绑定行里的 RP 私钥（base64 std 32B seed）签断言。
///
/// 私钥只在此**本地解码使用**，绝不返回（INV-P18）；本函数不是命令，命令层只拿回断言串。
/// 密钥损坏（非法 base64 / 非 32 字节）⇒ 明确报错，不静默用新密钥覆盖。
pub fn sign_with_binding(
    secret_b64: &str,
    kid: &str,
    subject: &str,
    meta: &RpMetadata,
    req: &RpRequest,
    now_secs: i64,
) -> Result<String, String> {
    let seed = STANDARD
        .decode(secret_b64)
        .map_err(|_| error_codes::coded(error_codes::DEVICE_AUTH_BAD_REQUEST, "绑定密钥损坏"))?;
    let seed: [u8; 32] = seed.try_into().map_err(|_| {
        error_codes::coded(error_codes::DEVICE_AUTH_BAD_REQUEST, "绑定密钥长度不正确")
    })?;
    let signing = SigningKey::from_bytes(&seed);
    Ok(sign_assertion(&signing, kid, subject, meta, req, now_secs))
}

#[cfg(test)]
mod device_auth_tests;
