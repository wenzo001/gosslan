//! RP 绑定密钥的**导出/恢复**（格式、加解密、冲突判定）。
//!
//! 设计稿：`docs/notes/rp-key-export-recovery-design-2026-11-15.md`。这里只放**纯逻辑**
//! （字节格式 + Argon2id + XChaCha20-Poly1305 + 导入计划），不碰文件系统、不碰 tauri、
//! 不碰数据库 —— 命令层负责那三样，测试因此可以在任何平台上跑。
//!
//! ## 一句话
//!
//! 导出 = 把每把 RP 私钥（32B seed）与绑定元数据打成一份**口令加密**的单文件；
//! 恢复 = 解密、逐条自校验、按冲突矩阵**不覆盖**地写回。
//!
//! ## 为什么必须自校验（而不是信文件）
//!
//! `secret_key` 是唯一秘密，其余字段都可以由它重算：`public_key` 与 `kid` 必须与 seed 对得上，
//! `kid` 还必须满足 `base64url(sha256(pubkey))`。文件被手工改过（换 seed 但留旧公钥，或反之）
//! 就在这一步被挡下 —— 否则会出现「列表里显示 A 应用、签出来的却是另一把钥」的错绑。
//!
//! ## 头部为什么参与 AEAD
//!
//! KDF 参数写在密文外面（解密前就要读）。若不做认证，攻击者可以把 `m_cost` 改成 1024
//! 重新加密同一份明文，诱导客户端用弱参数派生 —— 所以**整个头部作为 AAD**，改一个字节就解不开。
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::error_codes;

/// 文件魔数：13 字节 ASCII。
pub const MAGIC: &[u8; 13] = b"GOSSLAN-RPKEY";
/// 当前格式版本。**更高版本一律拒绝**（不猜格式）。
pub const FORMAT_VERSION: u16 = 1;
/// KDF 编号：1 = Argon2id。
pub const KDF_ARGON2ID: u8 = 1;

/// Argon2id 内存下限（KiB）。低于它视为被降级。
pub const MIN_M_COST_KIB: u32 = 65_536;
/// Argon2id 迭代下限。
pub const MIN_T_COST: u32 = 3;
/// 并行度固定 1（跨平台可复现）。
pub const P_COST: u8 = 1;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
/// magic(13) + version(2) + kdf(1) + m(4) + t(4) + p(1) + salt(16) + nonce(24)
pub const HEADER_LEN: usize = 65;

/// 单文件上限：防止把任意大文件喂进解析器。
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
/// 单包最多多少条绑定。
pub const MAX_BINDINGS: usize = 256;
/// 口令最短长度。
pub const MIN_PASSPHRASE_CHARS: usize = 12;

/// 一条可导出的绑定（字段与 `rp_device_bindings` 同形，但**不含** `last_used_at`：
/// 恢复后不伪造"刚刚用过"）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BackupBinding {
    pub rp_origin: String,
    pub client_id: String,
    /// 确认页 / 列表里显示的应用名（非密）。
    pub display_name: String,
    pub kid: String,
    pub public_key: String,
    /// base64(std) 32B Ed25519 seed —— **唯一秘密**。
    pub secret_key: String,
    pub pairwise_subject: String,
    #[serde(default)]
    pub scopes: String,
    pub created_at: i64,
    /// `active` / `revoked`。其它状态不该出现在导出包里（导出端已过滤）。
    pub status: String,
}

/// 明文文档（加密前的 JSON）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BackupDoc {
    pub v: u16,
    pub exported_at: i64,
    /// 导出时的应用名（"小院儿" / "Gosslan"），仅用于人工识别，不参与任何判断。
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub app_version: String,
    pub bindings: Vec<BackupBinding>,
}

/// KDF 参数（导出时写入，导入时校验下限）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u8,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost_kib: MIN_M_COST_KIB,
            t_cost: MIN_T_COST,
            p_cost: P_COST,
        }
    }
}

/// 导入时对**单条**的判定结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportAction {
    /// 本机没有这条 ⇒ 新增。
    Add,
    /// 本机已有同一把公钥 ⇒ 跳过（幂等：重复导入同一文件不产生变化）。
    Skip,
    /// 本机已有同一个 (rp_origin, client_id) 但**公钥不同** ⇒ 不覆盖，报冲突。
    Conflict,
    /// 本机该条已是撤销态，而文件要恢复成 active ⇒ 拒绝复活。
    RefuseRevived,
    /// 文件里这条本身不合法（自校验失败 / 状态不认识）⇒ 拒绝。
    Rejected,
}

/// 单条预览结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedItem {
    pub rp_origin: String,
    pub client_id: String,
    pub display_name: String,
    pub action: ImportAction,
    /// 给人看的原因（`Rejected` / `Conflict` 才有）。
    pub reason: String,
}

/// 本地已存在的绑定里，冲突判定只需要这两个字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBinding {
    pub rp_origin: String,
    pub client_id: String,
    pub public_key: String,
    pub status: String,
}

fn coded(code: &'static str, msg: impl std::fmt::Display) -> String {
    error_codes::coded(code, msg)
}

/// 口令够不够长（只做长度闸，不做复杂度强制 —— 强制只会催生 `Password1!`）。
pub fn passphrase_error(passphrase: &str) -> Option<String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Some(coded(
            error_codes::RP_KEY_BACKUP_WEAK_PASSPHRASE,
            format!("口令至少 {MIN_PASSPHRASE_CHARS} 个字符"),
        ));
    }
    None
}

/// 头部字节（导出/解析共用同一段拼装，避免两处布局漂移）。
pub fn header_bytes(params: KdfParams, salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    h.push(KDF_ARGON2ID);
    h.extend_from_slice(&params.m_cost_kib.to_be_bytes());
    h.extend_from_slice(&params.t_cost.to_be_bytes());
    h.push(params.p_cost);
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    debug_assert_eq!(h.len(), HEADER_LEN);
    h
}

/// 由口令 + salt 派生 32B 密钥（Argon2id）。
fn derive_key(passphrase: &str, params: KdfParams, salt: &[u8]) -> Result<[u8; 32], String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let p = Params::new(
        params.m_cost_kib,
        params.t_cost,
        params.p_cost as u32,
        Some(32),
    )
    .map_err(|e| {
        coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("密钥派生参数无效：{e}"),
        )
    })?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| {
            coded(
                error_codes::RP_KEY_BACKUP_UNSUPPORTED,
                format!("密钥派生失败：{e}"),
            )
        })?;
    Ok(out)
}

/// 把文档转成要加密的 JSON —— **私钥在这里唯一一次被写成字节**。
///
/// 为什么不用 `#[derive(Serialize)]`：那样 `BackupBinding` 就成了"能序列化且带 seed"的类型，
/// 而 INV-P18 的判据 A 正是禁止这种形状（可序列化类型一旦被误放进命令返回值/emit 载荷，
/// 私钥就整体泄漏且界面无症状）。改成显式组装后，"谁能把 seed 交出去"只剩这一个函数，
/// 审起来只有 20 行，也不会被顺手加到别的 DTO 上。
fn doc_to_json(doc: &BackupDoc) -> serde_json::Value {
    use serde_json::json;
    let bindings: Vec<serde_json::Value> = doc
        .bindings
        .iter()
        .map(|b| {
            json!({
                "rp_origin": b.rp_origin,
                "client_id": b.client_id,
                "display_name": b.display_name,
                "kid": b.kid,
                "public_key": b.public_key,
                "secret_key": b.secret_key,
                "pairwise_subject": b.pairwise_subject,
                "scopes": b.scopes,
                "created_at": b.created_at,
                "status": b.status,
            })
        })
        .collect();
    json!({
        "v": doc.v,
        "exported_at": doc.exported_at,
        "app_name": doc.app_name,
        "app_version": doc.app_version,
        "bindings": bindings,
    })
}

/// 导出：把文档加密成完整文件字节。
///
/// `salt` / `nonce` 由调用方给（便于测试与"同一输入可复现"），生产走 `OsRng`。
pub fn seal_doc(
    doc: &BackupDoc,
    passphrase: &str,
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>, String> {
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    if doc.bindings.len() > MAX_BINDINGS {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("绑定过多（上限 {MAX_BINDINGS} 条）"),
        ));
    }
    let plain = serde_json::to_vec(&doc_to_json(doc))
        .map_err(|e| coded(error_codes::RP_KEY_BACKUP_IO, format!("序列化失败：{e}")))?;
    let header = header_bytes(params, &salt, &nonce);
    let key = derive_key(passphrase, params, &salt)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &header,
            },
        )
        .map_err(|_| coded(error_codes::RP_KEY_BACKUP_IO, "加密失败"))?;
    let mut out = header;
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解析 + 解密。**所有失败都回同一个码**（口令错 / 文件损坏 / 被篡改），只在消息里给类别。
pub fn open_doc(bytes: &[u8], passphrase: &str) -> Result<BackupDoc, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(coded(error_codes::RP_KEY_BACKUP_TOO_LARGE, "文件过大"));
    }
    if bytes.len() <= HEADER_LEN {
        return Err(unreadable("文件太短"));
    }
    if &bytes[0..13] != MAGIC {
        return Err(unreadable("不是小院儿导出的密钥包"));
    }
    let version = u16::from_be_bytes([bytes[13], bytes[14]]);
    if version != FORMAT_VERSION {
        // 版本更高 ⇒ 明确提示升级，不猜格式（与"读不出来"分开，便于用户行动）。
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("密钥包版本 {version} 高于本机支持的 {FORMAT_VERSION}，请升级后再导入"),
        ));
    }
    if bytes[15] != KDF_ARGON2ID {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            "密钥包使用了未知的密钥派生算法",
        ));
    }
    let m = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let t = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    let p = bytes[24];
    if m < MIN_M_COST_KIB || t < MIN_T_COST || p as u32 != P_COST as u32 {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            "密钥派生参数低于安全下限，文件可能被篡改",
        ));
    }
    let params = KdfParams {
        m_cost_kib: m,
        t_cost: t,
        p_cost: p,
    };
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[25..25 + SALT_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[25 + SALT_LEN..HEADER_LEN]);

    let header = &bytes[..HEADER_LEN];
    let key = derive_key(passphrase, params, &salt)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &bytes[HEADER_LEN..],
                aad: header,
            },
        )
        .map_err(|_| unreadable("口令错误或文件已损坏"))?;
    let doc: BackupDoc =
        serde_json::from_slice(&plain).map_err(|e| unreadable(&format!("内容格式不正确：{e}")))?;
    if doc.bindings.len() > MAX_BINDINGS {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "绑定条数超出上限",
        ));
    }
    Ok(doc)
}

fn unreadable(why: &str) -> String {
    coded(
        error_codes::RP_KEY_BACKUP_UNREADABLE,
        format!("无法读取密钥包：{why}"),
    )
}

/// 自校验一条：由 seed 重算公钥与 kid，必须与文件里写的一致。
///
/// 只认 `active` / `revoked` 两种状态 —— 其它状态出现在导出包里说明文件来路不对。
pub fn validate_binding(b: &BackupBinding) -> Result<(), String> {
    if b.rp_origin.trim().is_empty() || b.client_id.trim().is_empty() {
        return Err("缺少应用来源或标识".into());
    }
    if !(b.rp_origin.starts_with("https://")) {
        return Err("应用来源必须是 https".into());
    }
    if b.status != "active" && b.status != "revoked" {
        return Err(format!("不认识的状态：{}", b.status));
    }
    let key = crate::crypto::RpKey::from_secret_b64(&b.secret_key)
        .ok_or_else(|| "私钥不是合法的 32 字节 seed".to_string())?;
    let pk = URL_SAFE_NO_PAD.encode(key.public_key_bytes());
    if pk != b.public_key {
        return Err("公钥与私钥不匹配（文件被改过？）".into());
    }
    let kid = crate::device_auth::kid_from_public(&key.public_key_bytes());
    if kid != b.kid {
        return Err("kid 与公钥不匹配（文件被改过？）".into());
    }
    // 再确认 public_key 本身是合法 base64url 32B（防"两处一起改"绕过上面的比较）。
    match URL_SAFE_NO_PAD.decode(&b.public_key) {
        Ok(v) if v.len() == 32 => {}
        _ => return Err("公钥编码不合法".into()),
    }
    if b.secret_key.len() != STANDARD.encode([0u8; 32]).len() {
        return Err("私钥编码长度不对".into());
    }
    Ok(())
}

/// 计算导入计划（**不改任何状态**）。预览与真正写入都走这一函数，避免两套判定。
pub fn plan_import(local: &[LocalBinding], doc: &BackupDoc) -> Vec<PlannedItem> {
    let mut out = Vec::with_capacity(doc.bindings.len());
    for b in &doc.bindings {
        let item = match validate_binding(b) {
            Err(reason) => PlannedItem {
                rp_origin: b.rp_origin.clone(),
                client_id: b.client_id.clone(),
                display_name: b.display_name.clone(),
                action: ImportAction::Rejected,
                reason,
            },
            Ok(()) => {
                let existing = local
                    .iter()
                    .find(|l| l.rp_origin == b.rp_origin && l.client_id == b.client_id);
                let (action, reason) = match existing {
                    None => (ImportAction::Add, String::new()),
                    Some(l) if l.status == "revoked" && b.status == "active" => (
                        ImportAction::RefuseRevived,
                        "本机已撤销该应用，请重新绑定而不是导入旧钥".to_string(),
                    ),
                    Some(l) if l.public_key == b.public_key => {
                        (ImportAction::Skip, "本机已有同一把密钥".to_string())
                    }
                    Some(_) => (
                        ImportAction::Conflict,
                        "本机已有该应用的另一把密钥，覆盖会让已登录的会话失效".to_string(),
                    ),
                };
                PlannedItem {
                    rp_origin: b.rp_origin.clone(),
                    client_id: b.client_id.clone(),
                    display_name: b.display_name.clone(),
                    action,
                    reason,
                }
            }
        };
        out.push(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "correct horse battery staple";

    fn sample_binding(seed: [u8; 32], origin: &str, client: &str, status: &str) -> BackupBinding {
        let key = crate::crypto::RpKey::from_secret_b64(&STANDARD.encode(seed)).unwrap();
        BackupBinding {
            rp_origin: origin.into(),
            client_id: client.into(),
            display_name: "Acme 控制台".into(),
            kid: crate::device_auth::kid_from_public(&key.public_key_bytes()),
            public_key: URL_SAFE_NO_PAD.encode(key.public_key_bytes()),
            secret_key: STANDARD.encode(seed),
            pairwise_subject: "sub-1".into(),
            scopes: String::new(),
            created_at: 1_700_000_000_000,
            status: status.into(),
        }
    }

    fn sample_doc() -> BackupDoc {
        BackupDoc {
            v: 1,
            exported_at: 1_700_000_100,
            app_name: "小院儿".into(),
            app_version: "5.29.0".into(),
            bindings: vec![sample_binding(
                [7u8; 32],
                "https://a.example.com",
                "a",
                "active",
            )],
        }
    }

    /// 测试用弱参数：仍在下限之上（否则解析端会拒），只是把 m 压到下限。
    fn fast_params() -> KdfParams {
        KdfParams::default()
    }

    #[test]
    fn roundtrip_preserves_every_field() {
        let doc = sample_doc();
        let bytes = seal_doc(&doc, PASS, fast_params(), [9u8; 16], [3u8; 24]).unwrap();
        assert!(bytes.len() > HEADER_LEN);
        let back = open_doc(&bytes, PASS).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn wrong_passphrase_and_tampering_share_one_error_code() {
        let doc = sample_doc();
        let bytes = seal_doc(&doc, PASS, fast_params(), [9u8; 16], [3u8; 24]).unwrap();

        let wrong = open_doc(&bytes, "wrong passphrase here").unwrap_err();
        assert!(
            wrong.contains(error_codes::RP_KEY_BACKUP_UNREADABLE),
            "{wrong}"
        );

        // 翻密文一位
        let mut t = bytes.clone();
        let last = t.len() - 1;
        t[last] ^= 0x01;
        assert!(open_doc(&t, PASS)
            .unwrap_err()
            .contains(error_codes::RP_KEY_BACKUP_UNREADABLE));

        // 翻头部一位（nonce）：AAD 把头部一并认证了
        let mut h = bytes.clone();
        h[41] ^= 0x01;
        assert!(open_doc(&h, PASS)
            .unwrap_err()
            .contains(error_codes::RP_KEY_BACKUP_UNREADABLE));
    }

    #[test]
    fn rejects_downgraded_kdf_params_before_decrypting() {
        let doc = sample_doc();
        let mut bytes = seal_doc(&doc, PASS, fast_params(), [1u8; 16], [2u8; 24]).unwrap();
        // 把 m_cost 改成 1024（降级），即使攻击者拿到了口令也应按参数下限拒。
        bytes[16..20].copy_from_slice(&1024u32.to_be_bytes());
        let e = open_doc(&bytes, PASS).unwrap_err();
        assert!(e.contains(error_codes::RP_KEY_BACKUP_UNSUPPORTED), "{e}");
    }

    #[test]
    fn rejects_newer_format_instead_of_guessing() {
        let doc = sample_doc();
        let mut bytes = seal_doc(&doc, PASS, fast_params(), [1u8; 16], [2u8; 24]).unwrap();
        bytes[13..15].copy_from_slice(&2u16.to_be_bytes());
        let e = open_doc(&bytes, PASS).unwrap_err();
        assert!(e.contains(error_codes::RP_KEY_BACKUP_UNSUPPORTED), "{e}");
    }

    #[test]
    fn weak_passphrase_is_refused_on_export() {
        let e = seal_doc(&sample_doc(), "short", fast_params(), [0u8; 16], [0u8; 24]).unwrap_err();
        assert!(
            e.contains(error_codes::RP_KEY_BACKUP_WEAK_PASSPHRASE),
            "{e}"
        );
    }

    #[test]
    fn self_check_catches_swapped_secret_and_broken_kid() {
        let good = sample_binding([7u8; 32], "https://a.example.com", "a", "active");
        assert!(validate_binding(&good).is_ok());

        // 换私钥但留旧公钥 ⇒ 必须拒（这是"文件被改过"最典型的样子）
        let mut b = good.clone();
        b.secret_key = STANDARD.encode([8u8; 32]);
        assert!(validate_binding(&b).is_err());

        // 公钥与私钥自洽，但 kid 被改 ⇒ 也要拒
        let mut c = good.clone();
        c.kid = "not-a-real-kid".into();
        assert!(validate_binding(&c).is_err());

        // 非 https 来源
        let mut d = good.clone();
        d.rp_origin = "http://a.example.com".into();
        assert!(validate_binding(&d).is_err());

        // 不认识的本地状态
        let mut e = good.clone();
        e.status = "pending_registration".into();
        assert!(validate_binding(&e).is_err());
    }

    #[test]
    fn plan_matrix_covers_add_skip_conflict_revive_reject() {
        let incoming_active = sample_binding([7u8; 32], "https://a.example.com", "a", "active");
        let incoming_other = sample_binding([8u8; 32], "https://b.example.com", "b", "active");
        let doc = BackupDoc {
            v: 1,
            exported_at: 0,
            app_name: String::new(),
            app_version: String::new(),
            bindings: vec![incoming_active.clone(), incoming_other.clone()],
        };

        // 1) 全新：两条都 Add
        let plan = plan_import(&[], &doc);
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|p| p.action == ImportAction::Add));

        // 2) 本机已有同公钥 ⇒ Skip
        let local = vec![LocalBinding {
            rp_origin: incoming_active.rp_origin.clone(),
            client_id: incoming_active.client_id.clone(),
            public_key: incoming_active.public_key.clone(),
            status: "active".into(),
        }];
        let plan = plan_import(&local, &doc);
        assert_eq!(plan[0].action, ImportAction::Skip);

        // 3) 本机有同键不同公钥 ⇒ Conflict（不覆盖）
        let local = vec![LocalBinding {
            rp_origin: incoming_active.rp_origin.clone(),
            client_id: incoming_active.client_id.clone(),
            public_key: "different".into(),
            status: "active".into(),
        }];
        let plan = plan_import(&local, &doc);
        assert_eq!(plan[0].action, ImportAction::Conflict);

        // 4) 本机已撤销 + 文件想恢复成 active ⇒ RefuseRevived
        let local = vec![LocalBinding {
            rp_origin: incoming_active.rp_origin.clone(),
            client_id: incoming_active.client_id.clone(),
            public_key: incoming_active.public_key.clone(),
            status: "revoked".into(),
        }];
        let plan = plan_import(&local, &doc);
        assert_eq!(plan[0].action, ImportAction::RefuseRevived);

        // 5) 文件里那条自校验不过 ⇒ Rejected
        let mut bad = doc.clone();
        bad.bindings[0].public_key = "AAAA".into();
        let plan = plan_import(&[], &bad);
        assert_eq!(plan[0].action, ImportAction::Rejected);
    }
}
