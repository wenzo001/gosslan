//! 端到端加密（E2EE）模块。
//!
//! 密码学原语：
//! - **X25519**：ECDH 密钥交换，为单聊双方派生共享密钥；
//! - **Ed25519**：消息签名，用于身份校验（防伪造 / 防中间人）；
//! - **ChaCha20-Poly1305**：AEAD 对称加密，密文格式 = `nonce(12B) || ciphertext`。
//!
//! 密钥持久化：私钥以 base64 存于本地 SQLite `settings` 表，重启后身份不变。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::{OsRng, RngCore};
use x25519_dalek::{PublicKey, StaticSecret};

const NONCE_LEN: usize = 12;

/// 节点身份：X25519 私钥（ECDH）+ Ed25519 私钥（签名）。
pub struct Identity {
    pub x25519_secret: StaticSecret,
    pub ed25519_signing: SigningKey,
}

impl Identity {
    /// 生成全新身份。
    pub fn generate() -> Self {
        let x25519_secret = StaticSecret::random_from_rng(OsRng);
        let ed25519_signing = SigningKey::generate(&mut OsRng);
        Self {
            x25519_secret,
            ed25519_signing,
        }
    }

    /// 从持久化的 base64 私钥重建身份。
    pub fn from_secrets(x25519_b64: &str, ed25519_b64: &str) -> Option<Self> {
        let xs = STANDARD.decode(x25519_b64).ok()?;
        let es = STANDARD.decode(ed25519_b64).ok()?;
        let xs: [u8; 32] = xs.try_into().ok()?;
        let es: [u8; 32] = es.try_into().ok()?;
        Some(Self {
            x25519_secret: StaticSecret::from(xs),
            ed25519_signing: SigningKey::from_bytes(&es),
        })
    }

    pub fn x25519_secret_b64(&self) -> String {
        STANDARD.encode(self.x25519_secret.to_bytes())
    }

    pub fn ed25519_secret_b64(&self) -> String {
        STANDARD.encode(self.ed25519_signing.to_bytes())
    }

    pub fn x25519_public_b64(&self) -> String {
        STANDARD.encode(self.x25519_public().as_bytes())
    }

    pub fn ed25519_public_b64(&self) -> String {
        STANDARD.encode(self.ed25519_signing.verifying_key().to_bytes())
    }

    pub fn x25519_public(&self) -> PublicKey {
        PublicKey::from(&self.x25519_secret)
    }

    /// 用 Ed25519 私钥签名，返回 base64。
    pub fn sign_b64(&self, data: &[u8]) -> String {
        STANDARD.encode(self.ed25519_signing.sign(data).to_bytes())
    }
}

/// ECDH：用对方 X25519 公钥（base64）+ 自己私钥派生共享密钥。
pub fn shared_secret(my_secret: &StaticSecret, their_public_b64: &str) -> Option<[u8; 32]> {
    let bytes = STANDARD.decode(their_public_b64).ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    let their = PublicKey::from(arr);
    Some(*my_secret.diffie_hellman(&their).as_bytes())
}

/// ChaCha20-Poly1305 加密：返回 `nonce || ciphertext`。
pub fn seal(shared: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(shared));
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).ok()?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Some(out)
}

/// ChaCha20-Poly1305 解密：输入 `nonce || ciphertext`。
pub fn open(shared: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < NONCE_LEN {
        return None;
    }
    let (nonce, ct) = data.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(shared));
    cipher.decrypt(Nonce::from_slice(nonce), ct).ok()
}

/// 群密钥加密（对称）。
pub fn seal_symmetric(key: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    seal(key, plaintext)
}

/// 群密钥解密（对称）。
pub fn open_symmetric(key: &[u8; 32], data: &[u8]) -> Option<Vec<u8>> {
    open(key, data)
}

/// 生成随机对称密钥（群密钥）。
pub fn random_key() -> [u8; 32] {
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    k
}

/// 用 Ed25519 公钥校验签名。
/// 一方的身份三元组（设备 ID + 两把公钥），用于派生安全码。
pub struct SafetyParty<'a> {
    pub device_id: &'a str,
    pub x25519_pubkey: &'a str,
    pub ed25519_pubkey: &'a str,
}

/// **安全码**（Safety Number）：由双方身份派生的短数字串，供**带外核对**。
///
/// ## 为什么必须对称
/// 核对的前提是双方各自算出的码**一致**。若把「我」和「对方」按位置喂进哈希，
/// A 看到的和 B 看到的会是两个完全不同的串，当面或电话核对就无从比起。
/// 这里把两方按 `device_id` 的**字典序**排列后再哈希 —— device_id 恒为 ASCII，
/// 两端排序结果必然相同，于是双方得到同一个码。
///
/// ## 它解决什么
/// 这是 TOFU（首次接触）唯一的解法。广播/Hello 里的公钥即便自签名也只证明
/// 「持有该私钥」，不证明「他就是那个 device_id」—— 攻击者可以抢先冒充。
/// 但只要双方在带外（当面、电话、另一条已知可信的信道）比对这串数字，
/// 就能发现中间人的存在：中间人持有的密钥对与真实对端不同，算出的码必然不同。
///
/// ## 覆盖范围
/// 两方的 device_id + 各自的 X25519 与 Ed25519 公钥，共 6 个字段，
/// **任一被替换码都会变**。域前缀 `gosslan-safety-v1` 与其它哈希隔离。
///
/// 输出 6 组 × 5 位十进制（30 位 ≈ 100 bit），比完整公钥好读、比 4 位尾码有实际强度。
pub fn safety_number(a: &SafetyParty<'_>, b: &SafetyParty<'_>) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(b"gosslan-safety-v1");
    // 规范序：字典序小的排前面，保证双方算出同一个码
    let (first, second) = if a.device_id <= b.device_id { (a, b) } else { (b, a) };
    for p in [first, second] {
        for field in [p.device_id, p.x25519_pubkey, p.ed25519_pubkey] {
            h.update(field.as_bytes());
            h.update([0u8]); // 分隔符：防止 "ab"+"c" 与 "a"+"bc" 撞成同一串
        }
    }
    let digest = h.finalize();
    // 每 5 字节取 4 字节 → 0..100000 → 5 位十进制（截断取模，与 Signal 的展示法同源）
    digest
        .chunks(5)
        .take(6)
        .map(|c| {
            let mut buf = [0u8; 4];
            buf.copy_from_slice(&c[..4]);
            format!("{:05}", u32::from_be_bytes(buf) % 100_000)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn verify_signature(pubkey_b64: &str, data: &[u8], sig_b64: &str) -> bool {
    let Ok(pk) = STANDARD.decode(pubkey_b64) else {
        return false;
    };
    let Ok(sig) = STANDARD.decode(sig_b64) else {
        return false;
    };
    let Ok(pk): Result<[u8; 32], _> = pk.try_into() else {
        return false;
    };
    let Ok(sig): Result<[u8; 64], _> = sig.try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    let sig = Signature::from_bytes(&sig);
    vk.verify(data, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn party<'a>(id: &'a Identity, device_id: &'a str) -> (String, String, String) {
        (
            device_id.to_string(),
            id.x25519_public_b64(),
            id.ed25519_public_b64(),
        )
    }

    fn as_party<'a>(t: &'a (String, String, String)) -> SafetyParty<'a> {
        SafetyParty {
            device_id: &t.0,
            x25519_pubkey: &t.1,
            ed25519_pubkey: &t.2,
        }
    }

    /// **对称性**是安全码能用于核对的前提：A 看到的必须与 B 看到的完全相同，
    /// 否则当面/电话核对无从比起（这道题错了整个功能就是白做的）。
    #[test]
    fn safety_number_is_symmetric() {
        let a = Identity::generate();
        let b = Identity::generate();
        let pa = party(&a, "device-aaa");
        let pb = party(&b, "device-bbb");

        let from_a = safety_number(&as_party(&pa), &as_party(&pb));
        let from_b = safety_number(&as_party(&pb), &as_party(&pa));
        assert_eq!(from_a, from_b, "双方必须算出同一个码");
        // 字典序与传入顺序无关：把 id 换成反序也要一致
        let pa2 = party(&a, "zzz-last");
        let pb2 = party(&b, "aaa-first");
        assert_eq!(
            safety_number(&as_party(&pa2), &as_party(&pb2)),
            safety_number(&as_party(&pb2), &as_party(&pa2)),
        );
    }

    #[test]
    fn safety_number_is_deterministic_and_well_formed() {
        let a = Identity::generate();
        let b = Identity::generate();
        let pa = party(&a, "d1");
        let pb = party(&b, "d2");
        let n = safety_number(&as_party(&pa), &as_party(&pb));
        assert_eq!(n, safety_number(&as_party(&pa), &as_party(&pb)), "同输入同输出");

        let groups: Vec<&str> = n.split(' ').collect();
        assert_eq!(groups.len(), 6, "6 组");
        for g in &groups {
            assert_eq!(g.len(), 5, "每组 5 位：{g}");
            assert!(g.bytes().all(|c| c.is_ascii_digit()), "只含十进制数字：{g}");
        }
    }

    /// 中间人检测的根据：**任一方任一字段被替换，码都必须变**。
    /// 尤其要覆盖 X25519 —— 攻击者能做的最有价值的事就是把加密公钥换成自己的。
    #[test]
    fn safety_number_changes_on_any_field_replacement() {
        let a = Identity::generate();
        let b = Identity::generate();
        let base_a = party(&a, "d-a");
        let base_b = party(&b, "d-b");
        let base = safety_number(&as_party(&base_a), &as_party(&base_b));

        // 换对方的 device_id（冒充者最省事的伪装：只改 id 不改密钥）
        let mut t = base_b.clone();
        t.0 = "d-b-impersonated".to_string();
        assert_ne!(base, safety_number(&as_party(&base_a), &as_party(&t)), "换 device_id");

        // 换对方的加密公钥（真正的中间人攻击：把 ECDH 目标换成攻击者）
        let mut t = base_b.clone();
        t.1 = Identity::generate().x25519_public_b64();
        assert_ne!(base, safety_number(&as_party(&base_a), &as_party(&t)), "换 X25519");

        // 换对方的签名公钥
        let mut t = base_b.clone();
        t.2 = Identity::generate().ed25519_public_b64();
        assert_ne!(base, safety_number(&as_party(&base_a), &as_party(&t)), "换 Ed25519");

        // 换我自己的字段同样要变（否则「只有对方变了才报警」会漏掉另一半）
        let mut t = base_a.clone();
        t.1 = Identity::generate().x25519_public_b64();
        assert_ne!(base, safety_number(&as_party(&t), &as_party(&base_b)), "换我自己的 X25519");
    }

    /// 字段分隔：`("ab","c")` 与 `("a","bc")` 不得撞成同一个码。
    #[test]
    fn safety_number_separates_concatenated_fields() {
        let a = Identity::generate();
        let b = Identity::generate();
        let t1 = ("ab".to_string(), "c".to_string(), "x".to_string());
        let t2 = ("a".to_string(), "bc".to_string(), "x".to_string());
        let anchor = party(&b, "d-b");
        assert_ne!(
            safety_number(&as_party(&t1), &as_party(&anchor)),
            safety_number(&as_party(&t2), &as_party(&anchor)),
            "拼接歧义必须由分隔符消除"
        );
        let _ = a; // a 仅为保持生成的设备身份互不相同
    }

    #[test]
    fn ecdh_symmetry() {
        let a = Identity::generate();
        let b = Identity::generate();
        let sa = shared_secret(&a.x25519_secret, &b.x25519_public_b64()).unwrap();
        let sb = shared_secret(&b.x25519_secret, &a.x25519_public_b64()).unwrap();
        assert_eq!(sa, sb);
    }

    #[test]
    fn seal_open_roundtrip() {
        let key = random_key();
        let msg = b"hello p2p";
        let sealed = seal_symmetric(&key, msg).unwrap();
        assert_eq!(open_symmetric(&key, &sealed).unwrap(), msg);
    }

    #[test]
    fn signature_verifies() {
        let id = Identity::generate();
        let msg = b"message id";
        let sig = id.sign_b64(msg);
        assert!(verify_signature(&id.ed25519_public_b64(), msg, &sig));
        assert!(!verify_signature(
            &id.ed25519_public_b64(),
            b"tampered",
            &sig
        ));
    }
}
