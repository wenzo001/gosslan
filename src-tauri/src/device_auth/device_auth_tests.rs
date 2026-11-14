//! 外部应用设备认证协议核心的行为判据（含安全反例）。
//! 跑法：cargo test --lib device_auth

use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

const ORIGIN: &str = "https://app.example.com";

fn challenge_b64() -> String {
    URL_SAFE_NO_PAD.encode([7u8; 32])
}

fn future_expiry() -> String {
    // 2099 年，远在未来 ⇒ 不会被 now 判过期。
    "2099-01-01T00:00:00Z".to_string()
}

fn good_metadata() -> RpMetadata {
    RpMetadata {
        protocol_version: "1".into(),
        client_id: "com.example.product".into(),
        display_name: "示例工作台".into(),
        issuer: ORIGIN.into(),
        request_endpoint: format!("{ORIGIN}/api/device-auth/requests/{{request_id}}"),
        decision_endpoint: format!("{ORIGIN}/api/device-auth/requests/{{request_id}}/decision"),
        poll_endpoint: format!("{ORIGIN}/api/device-auth/requests/{{request_id}}/status"),
        supported_actions: vec!["link".into(), "authenticate".into()],
        supported_claims: vec![
            "device_subject".into(),
            "device_public_key".into(),
            "nickname".into(),
        ],
    }
}

fn good_request() -> RpRequest {
    RpRequest {
        protocol_version: "1".into(),
        request_id: "req-opaque-123".into(),
        client_id: "com.example.product".into(),
        issuer: ORIGIN.into(),
        display_name: "示例工作台".into(),
        action: "link".into(),
        account_hint: "li***@example.com".into(),
        requested_claims: vec!["device_subject".into(), "device_public_key".into()],
        challenge: challenge_b64(),
        expires_at: future_expiry(),
    }
}

#[test]
fn normalize_origin_https_only_and_strips_extras() {
    assert_eq!(
        normalize_rp_origin("https://app.example.com").unwrap(),
        ORIGIN
    );
    assert_eq!(
        normalize_rp_origin("https://app.example.com:8443").unwrap(),
        "https://app.example.com:8443"
    );
    // http 降级拒。
    assert!(normalize_rp_origin("http://app.example.com").is_err());
    // userinfo / query / fragment 拒。
    assert!(normalize_rp_origin("https://user@app.example.com").is_err());
    assert!(normalize_rp_origin("https://app.example.com/?x=1").is_err());
    assert!(normalize_rp_origin("https://app.example.com/#f").is_err());
    assert!(normalize_rp_origin("not a url").is_err());
}

#[test]
fn parse_link_https_app_link_and_custom_scheme() {
    let a = parse_authorize_link("https://app.example.com/authorize/req-abc").unwrap();
    assert_eq!(a.rp_origin, ORIGIN);
    assert_eq!(a.request_ref, "req-abc");

    let b =
        parse_authorize_link("gosslan://authorize/req-abc?origin=https%3A%2F%2Fapp.example.com")
            .unwrap();
    assert_eq!(b.rp_origin, ORIGIN);
    assert_eq!(b.request_ref, "req-abc");

    // 坏 scheme / 缺 ref / 自定义 scheme 缺 origin / http origin 都拒。
    assert!(parse_authorize_link("javascript:alert(1)").is_err());
    assert!(parse_authorize_link("https://app.example.com/authorize/").is_err());
    assert!(parse_authorize_link("gosslan://authorize/req-abc").is_err());
    assert!(parse_authorize_link(
        "gosslan://authorize/req-abc?origin=http%3A%2F%2Fapp.example.com"
    )
    .is_err());
}

#[test]
fn metadata_validation_accepts_good_and_rejects_cross_origin() {
    let meta = good_metadata();
    assert!(validate_metadata(&meta, ORIGIN).is_ok());

    // issuer 与期望来源不一致。
    let mut m = good_metadata();
    m.issuer = "https://evil.example.com".into();
    assert!(validate_metadata(&m, ORIGIN).is_err());

    // 端点跨域。
    let mut m = good_metadata();
    m.decision_endpoint = "https://evil.example.com/decision".into();
    assert!(validate_metadata(&m, ORIGIN).is_err());

    // 端点 http 降级。
    let mut m = good_metadata();
    m.request_endpoint = "http://app.example.com/api/device-auth/requests/{request_id}".into();
    assert!(validate_metadata(&m, ORIGIN).is_err());

    // 未知版本 / 动作 / claim。
    let mut m = good_metadata();
    m.protocol_version = "2".into();
    assert!(validate_metadata(&m, ORIGIN).is_err());
    let mut m = good_metadata();
    m.supported_actions = vec!["delete_account".into()];
    assert!(validate_metadata(&m, ORIGIN).is_err());
    let mut m = good_metadata();
    m.supported_claims = vec!["email".into()];
    assert!(validate_metadata(&m, ORIGIN).is_err());
}

#[test]
fn request_validation_expiry_claims_challenge() {
    let meta = good_metadata();
    let now = 1_700_000_000_000i64;
    assert!(validate_request(&good_request(), &meta, now).is_ok());

    // 过期。
    let mut r = good_request();
    r.expires_at = "2020-01-01T00:00:00Z".into();
    assert!(validate_request(&r, &meta, now).is_err());

    // 未知 claim 整笔拒。
    let mut r = good_request();
    r.requested_claims = vec!["device_subject".into(), "phone_number".into()];
    assert!(validate_request(&r, &meta, now).is_err());

    // challenge 熵不足。
    let mut r = good_request();
    r.challenge = URL_SAFE_NO_PAD.encode([1u8; 8]);
    assert!(validate_request(&r, &meta, now).is_err());

    // client_id 与 metadata 不一致。
    let mut r = good_request();
    r.client_id = "com.evil".into();
    assert!(validate_request(&r, &meta, now).is_err());

    // 不支持的动作。
    let mut r = good_request();
    r.action = "transfer".into();
    assert!(validate_request(&r, &meta, now).is_err());
}

#[test]
fn parse_expiry_handles_rfc3339() {
    assert!(parse_expiry_ms("2026-11-13T08:15:00Z").is_some());
    assert!(parse_expiry_ms("2026-11-13T08:15:00+08:00").is_some());
    assert!(parse_expiry_ms("not-a-date").is_none());
}

#[test]
fn rp_keys_are_distinct_and_kid_is_sha256_of_public() {
    let (sk1, pub1, kid1, sub1) = generate_rp_key();
    let (_sk2, pub2, kid2, sub2) = generate_rp_key();
    // 每次生成独立密钥与 pairwise subject（跨 RP 不关联）。
    assert_ne!(pub1, pub2);
    assert_ne!(sub1, sub2);
    // kid = base64url(sha256(raw 公钥))。
    let raw = URL_SAFE_NO_PAD.decode(&pub1).unwrap();
    assert_eq!(kid1, kid_from_public(&raw));
    assert_ne!(kid1, kid2);
    // 公钥能由私钥推出（一致性）；公钥面经能力封装暴露，不触碰原始 SigningKey。
    assert_eq!(pub1, URL_SAFE_NO_PAD.encode(sk1.public_key_bytes()));
}

#[test]
fn assertion_jws_roundtrip_verifies_and_fields_consistent() {
    let (signing, _pub, kid, subject) = generate_rp_key();
    let meta = good_metadata();
    let req = good_request();
    let now = 1_700_000_000i64;
    let jws = sign_assertion(&signing, &kid, &subject, &meta, &req, now);

    let parts: Vec<&str> = jws.split('.').collect();
    assert_eq!(parts.len(), 3, "JWS 三段");
    let header: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();

    assert_eq!(header["alg"], "EdDSA");
    assert_eq!(header["typ"], ASSERTION_TYP);
    assert_eq!(header["kid"], kid.as_str());
    assert_eq!(payload["iss"], subject.as_str());
    assert_eq!(payload["aud"], assertion_audience(ORIGIN).as_str());
    assert_eq!(payload["client_id"], meta.client_id.as_str());
    assert_eq!(payload["transaction_id"], req.request_id.as_str());
    assert_eq!(payload["challenge"], req.challenge.as_str());
    assert_eq!(payload["action"], "link");
    assert_eq!(payload["iat"], now);
    assert_eq!(payload["exp"], now + ASSERTION_TTL_SECS);
    assert!(payload["jti"]
        .as_str()
        .map(|s| !s.is_empty())
        .unwrap_or(false));

    // 用 RP 专属公钥验签：签名主体 = header.payload。
    let vk = VerifyingKey::from_bytes(&signing.public_key_bytes()).unwrap();
    let sig = Signature::from_slice(&sig_bytes).unwrap();
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    assert!(vk.verify(signing_input.as_bytes(), &sig).is_ok());

    // 反例：篡改 payload 后验签必失败。
    let tampered = format!(
        "{}.{}",
        parts[0],
        URL_SAFE_NO_PAD.encode(b"{\"action\":\"authenticate\"}")
    );
    assert!(vk.verify(tampered.as_bytes(), &sig).is_err());
}

#[test]
fn assertion_audience_derives_from_issuer() {
    assert_eq!(
        assertion_audience(ORIGIN),
        "https://app.example.com/api/device-auth"
    );
    assert_eq!(
        assertion_audience("https://app.example.com/"),
        "https://app.example.com/api/device-auth"
    );
}

/// 损坏的绑定密钥（非法 base64 / 非 32 字节）必须明确报错，绝不静默用新密钥覆盖（#3）。
/// 解码与签名都在 crypto::RpKey 能力内完成，协议层只透传不透明 seed 串。
#[test]
fn sign_with_binding_rejects_corrupt_secret() {
    let meta = good_metadata();
    let req = good_request();
    let err =
        sign_with_binding("not-base64!!", "kid", "sub", &meta, &req, 1_700_000_000).unwrap_err();
    assert!(err.contains("DEVICE_AUTH_BAD_REQUEST"));
    let short = base64::engine::general_purpose::STANDARD.encode([1u8; 16]);
    assert!(
        sign_with_binding(&short, "kid", "sub", &meta, &req, 1_700_000_000).is_err(),
        "非 32 字节 seed 也拒"
    );
}

/// 复合键（#8）：不同 RP 复用同一 request_id 不会撞键；同 RP 同事务键稳定。
#[test]
fn pending_key_is_composite_and_queue_key_groups_by_rp() {
    let a = pending_key("https://a.example", "client", "req-1");
    let b = pending_key("https://b.example", "client", "req-1");
    assert_ne!(a, b, "跨 RP 同 request_id 不许撞键");
    assert_eq!(a, pending_key("https://a.example", "client", "req-1"));
    // 排队键按 RP 聚合：同 RP 不同事务共用一把锁，不同 client_id 分开。
    assert_eq!(
        rp_queue_key("https://a.example", "c"),
        rp_queue_key("https://a.example", "c")
    );
    assert_ne!(
        rp_queue_key("https://a.example", "c1"),
        rp_queue_key("https://a.example", "c2")
    );
}
