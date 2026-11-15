//! 密钥库信封的判据（跨平台纯逻辑）。
//!
//! 钉住四件事：
//! ① **信封格式**：`gsk1.<后端>.<载荷>`，多一段少一段都不算信封；
//! ② **往返**：封 → 开回来必须逐字相同（用假加密函数跑，不依赖系统密钥库 ——
//!    否则这条判据只在 Windows/Android 上存在，本机永远绿）；
//! ③ **不回落明文**：别人的后端 / 不认识的后端 / 坏载荷 ⇒ 一律报错，
//!    **绝不**把原文吐出来；
//! ④ **没有密钥库的平台**保持旧行为（明文原样进出）。

use super::*;

/// 假加密函数：把字节**反过来**（可逆、够用，且一眼看出不是明文）。
fn fake_cipher(bytes: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    Ok(bytes.iter().rev().copied().collect())
}

/// 假解密：把字节正回来。故意不校验长度（让判据聚焦在信封语义上）。
fn fake_decipher(bytes: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    Ok(bytes.iter().rev().copied().collect())
}

#[test]
fn envelope_format_is_strict() {
    assert!(is_envelope("gsk1.dpapi.AAAA"));
    assert!(is_envelope("gsk1.aks.AAAA"));
    // 少一段 / 多一段 / 前缀不对 / 载荷为空 ⇒ 都不是信封。
    assert!(!is_envelope("gsk1.dpapi"));
    assert!(!is_envelope("gsk1.dpapi.AAAA.BBBB"));
    assert!(!is_envelope("gsk2.dpapi.AAAA"));
    assert!(!is_envelope("gsk1..AAAA"));
    assert!(!is_envelope("gsk1.dpapi."));
    // 旧格式（明文 base64）不是信封。
    assert!(!is_envelope(
        "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ));
}

#[test]
fn envelope_backend_is_readable() {
    assert_eq!(envelope_backend("gsk1.dpapi.AAAA"), Some("dpapi"));
    assert_eq!(envelope_backend("gsk1.aks.AAAA"), Some("aks"));
    assert_eq!(envelope_backend("gsk1"), None);
    assert_eq!(envelope_backend("明文"), None);
}

#[test]
fn seal_and_open_round_trip_byte_for_byte() {
    let secret = "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let envelope = seal_with(Backend::WindowsDpapi, fake_cipher, secret).unwrap();
    assert!(is_envelope(&envelope), "封出来的必须是信封：{envelope}");
    assert!(!envelope.contains(secret), "信封里不许出现明文私钥");
    let back = open_with(Backend::WindowsDpapi, fake_decipher, &envelope).unwrap();
    assert_eq!(back, secret, "开回来必须逐字相同");
}

#[test]
fn open_rejects_other_backends_instead_of_returning_plaintext() {
    let envelope = seal_with(Backend::AndroidKeystore, fake_cipher, "秘密").unwrap();
    // 拿 Windows 去开 Android 的信封 ⇒ 报错，**不许**返回原文。
    let err = open_with(Backend::WindowsDpapi, fake_decipher, &envelope).unwrap_err();
    match err {
        KeyStoreError::ForeignBackend { found, local } => {
            assert_eq!(found, "aks");
            assert_eq!(local, "dpapi");
        }
        other => panic!("应是「别的后端」错误，实际：{other}"),
    }
}

#[test]
fn open_rejects_unknown_backend_and_broken_payload() {
    let unknown = "gsk1.zzz.AAAA";
    match open_with(Backend::WindowsDpapi, fake_decipher, unknown).unwrap_err() {
        KeyStoreError::UnknownBackend(id) => assert_eq!(id, "zzz"),
        other => panic!("应是「不认识的后端」错误，实际：{other}"),
    }
    // 载荷不是 base64 ⇒ 报错。
    match open_with(Backend::WindowsDpapi, fake_decipher, "gsk1.dpapi.!!!!").unwrap_err() {
        KeyStoreError::Malformed(_) => {}
        other => panic!("应是「载荷坏了」错误，实际：{other}"),
    }
}

#[test]
fn legacy_plaintext_passes_through_unchanged() {
    let secret = "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    assert_eq!(
        open_with(Backend::WindowsDpapi, fake_decipher, secret).unwrap(),
        secret
    );
}

#[test]
fn platform_without_keystore_keeps_legacy_behavior() {
    // 本机没有密钥库时（macOS 暂缓 / Linux）：封不动（返回 None，让调用方保持原样），
    // 而旧格式明文原样进出。
    if backend() == Backend::None {
        assert!(seal_secret("秘密").unwrap().is_none());
        assert_eq!(open_secret("秘密").unwrap(), "秘密");
        // 但**别人的信封**在本机必须报错（不许当成明文放行）。
        let foreign = "gsk1.dpapi.AAAA";
        match open_secret(foreign).unwrap_err() {
            KeyStoreError::ForeignBackend { found, .. } => assert_eq!(found, "dpapi"),
            other => panic!("应是「别的后端」错误，实际：{other}"),
        }
    } else {
        // 有密钥库的平台：封得出、也解得回。
        let secret = "3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let envelope = seal_secret(secret)
            .unwrap()
            .expect("本机有密钥库 ⇒ 必须封得出");
        assert!(is_envelope(&envelope));
        assert_eq!(open_secret(&envelope).unwrap(), secret);
    }
}

#[test]
fn backend_ids_are_stable_and_round_trippable() {
    for b in [
        Backend::None,
        Backend::WindowsDpapi,
        Backend::AndroidKeystore,
    ] {
        assert_eq!(
            Backend::from_id(b.id()),
            Some(b),
            "后端 id 必须能还原：{}",
            b.id()
        );
    }
    assert_eq!(Backend::from_id("不存在的"), None);
    // id 不许重复（信封里靠它区分后端）。
    let ids = [
        Backend::None.id(),
        Backend::WindowsDpapi.id(),
        Backend::AndroidKeystore.id(),
    ];
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "后端 id 重复了：{ids:?}");
}
