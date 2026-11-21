//! **用户数据全量备份**的加密外壳（J1-4b，旅程走查 2026-11-20，用户拍板：
//! 「私钥进备份，加密备份」）。这里只放**纯逻辑**（字节格式 + Argon2id +
//! XChaCha20-Poly1305 + SQLite 快照校验），不碰文件系统、不碰 tauri、不碰数据库
//! —— 命令层（`commands/user_backup.rs`）负责那三样，测试因此可以在任何平台跑。
//!
//! ## 一句话
//!
//! 导出 = `VACUUM INTO` 一份一致性快照（**信封列解成明文**——备份外壳自己加密）
//! → 整库字节按口令加密成单文件；恢复 = 解密、校验 SQLite 魔数与 schema 版本、
//! 落成 pending 文件，**重启时**替换主库（运行中的连接动不得）。
//!
//! ## 与 `rp_key_backup` 同骨架、不同文件
//!
//! 加密骨架（header 布局 / KDF 参数下限 / 整个头部作为 AAD）与 RP 密钥备份逐字同源，
//! **magic 不同是刻意的**：两种备份互相不可用，恢复错文件在第一字节就被挡下，
//! 而不是解密半途报一个费解的 AEAD 错。
//!
//! ## 为什么私钥能跨机器恢复
//!
//! 身份私钥（`x25519_secret` / `ed25519_secret`）就是 settings 表的两行 ⇒ 整库快照
//! 天然包含；RP 绑定私钥在**有密钥库的系统**上存的是平台信封（DPAPI/Keystore 绑机器）
//! ⇒ 导出时命令层把信封**解成明文**写进快照（备份外壳自己加密，明文只存在于密文层内）；
//! 恢复后目标机器按「旧格式行第一次被读到时升级信封」的既有逻辑重新封 —— 这套
//! 升级机制现成，恢复端零新代码。异机信封解不开的行**原样保留**（部分恢复好过全失败，
//! 命令层把这类行数报给界面）。
//!
//! ## 口令无找回
//!
//! 忘记口令 = 备份作废。这是安全边界的另一面：有找回就有绕过加密的路径。
//! 界面必须把这句话写明（`backup.noRecovery`）。

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::error_codes::{self, coded};

/// 文件魔数：14 字节 ASCII。与 RP 密钥备份（`GOSSLAN-RPKEY`）**只差一个字母** ——
/// 恢复时拿错文件在这一步就被挡下，不要指望用户自己分得清两种备份。
pub const MAGIC: &[u8; 14] = b"GOSSLAN-BACKUP";
/// 当前格式版本。**更高版本一律拒绝**（不猜格式）。
pub const FORMAT_VERSION: u16 = 1;
/// KDF 编号：1 = Argon2id（与 rp_key_backup 同一家）。
pub const KDF_ARGON2ID: u8 = 1;

/// Argon2id 内存下限（KiB）。低于它视为被降级（64 MiB）。
pub const MIN_M_COST_KIB: u32 = 65_536;
/// Argon2id 迭代下限。
pub const MIN_T_COST: u32 = 3;
/// 并行度固定 1（跨平台可复现）。
pub const P_COST: u8 = 1;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 24;
/// magic(14) + version(2) + kdf(1) + m(4) + t(4) + p(1) + salt(16) + nonce(24)
pub const HEADER_LEN: usize = 66;

/// 快照上限：2 GiB。整库快照比 RP 密钥清单大得多，但也不该把任意大文件喂进解析器
/// （解密后先看魔数再看大小，顺序不能反）。
pub const MAX_DB_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// 口令强度（与 rp_key_backup 同一把尺）。
pub fn passphrase_error(passphrase: &str) -> Option<String> {
    if passphrase.chars().count() < 8 {
        return Some(coded(
            error_codes::RP_KEY_BACKUP_WEAK_PASSPHRASE,
            "备份口令至少 8 位（这是唯一的锁，忘了口令备份就作废）",
        ));
    }
    None
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

fn header_bytes(params: KdfParams, salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    h.push(KDF_ARGON2ID);
    h.extend_from_slice(&params.m_cost_kib.to_be_bytes());
    h.extend_from_slice(&params.t_cost.to_be_bytes());
    h.push(params.p_cost);
    h.extend_from_slice(salt);
    h.extend_from_slice(nonce);
    h
}

/// 解析头部并校验参数下限（解密前就要读 KDF 参数 ⇒ 整个头部作为 AAD，改一个字节就解不开）。
fn parse_header(
    bytes: &[u8],
) -> Result<(KdfParams, [u8; SALT_LEN], [u8; NONCE_LEN], usize), String> {
    if bytes.len() < HEADER_LEN {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNREADABLE,
            "文件太短，不是本应用的备份",
        ));
    }
    if &bytes[..14] != MAGIC {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNREADABLE,
            "魔数不符 —— 这不是用户数据备份（RP 密钥备份与它只差一个字母，别拿错文件）",
        ));
    }
    let version = u16::from_be_bytes([bytes[14], bytes[15]]);
    if version > FORMAT_VERSION {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("备份格式版本 {version} 比本机（{FORMAT_VERSION}）新 —— 先升级应用再恢复"),
        ));
    }
    if bytes[16] != KDF_ARGON2ID {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("未知 KDF 编号 {}", bytes[16]),
        ));
    }
    let m_cost_kib = u32::from_be_bytes([bytes[17], bytes[18], bytes[19], bytes[20]]);
    let t_cost = u32::from_be_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
    let p_cost = bytes[25];
    // 参数**下限**：高于下限的新备份照解（算力涨是用户自己的选择），低于下限视为被降级。
    if m_cost_kib < MIN_M_COST_KIB || t_cost < MIN_T_COST {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("KDF 参数低于安全下限（m={m_cost_kib} t={t_cost}）—— 文件可能被降级重打包"),
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[26..42]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[42..66]);
    Ok((
        KdfParams {
            m_cost_kib,
            t_cost,
            p_cost,
        },
        salt,
        nonce,
        HEADER_LEN,
    ))
}

/// 把一份整库快照按口令加密。`salt`/`nonce` 由命令层生成（随机），纯函数只管封装。
pub fn seal_snapshot(
    db_bytes: &[u8],
    passphrase: &str,
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
) -> Result<Vec<u8>, String> {
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    if db_bytes.len() > MAX_DB_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("快照超过 {MAX_DB_BYTES} 字节上限，拒绝打包"),
        ));
    }
    let header = header_bytes(params, &salt, &nonce);
    let key = derive_key(passphrase, params, &salt)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: db_bytes,
                aad: &header,
            },
        )
        .map_err(|_| coded(error_codes::RP_KEY_BACKUP_IO, "加密失败"))?;
    let mut out = header;
    out.extend_from_slice(&ct);
    Ok(out)
}

/// 解密并校验快照。**所有失败都回同一个码族**（口令错 / 文件损坏 / 被篡改），
/// 只在消息里给类别 —— 不让攻击者从错误码里学出「口令对不对」。
pub fn open_snapshot(bytes: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    let (params, salt, nonce, header_len) = parse_header(bytes)?;
    let key = derive_key(passphrase, params, &salt)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &bytes[header_len..],
                aad: &bytes[..header_len],
            },
        )
        .map_err(|_| {
            coded(
                error_codes::RP_KEY_BACKUP_UNREADABLE,
                "解密失败：口令不对，或文件被改过",
            )
        })?;
    validate_sqlite_bytes(&plain)?;
    Ok(plain)
}

/// SQLite 数据库文件的魔数（任何合法库文件都以它开头）。
pub const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// 快照必须是合法 SQLite 库文件 —— 口令对了但内容不是库（比如手工拼的文件）在这里挡下。
pub fn validate_sqlite_bytes(db_bytes: &[u8]) -> Result<(), String> {
    if db_bytes.len() < 16 || &db_bytes[..16] != SQLITE_MAGIC {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNREADABLE,
            "解密结果不是 SQLite 数据库 —— 备份文件损坏",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "correct-horse-battery";

    #[test]
    fn seal_open_roundtrip_and_sqlite_gate() {
        let mut db = Vec::new();
        db.extend_from_slice(SQLITE_MAGIC);
        db.extend_from_slice(b"payload-whatever");
        let out = seal_snapshot(
            &db,
            PW,
            KdfParams::default(),
            [7u8; SALT_LEN],
            [9u8; NONCE_LEN],
        )
        .unwrap();
        assert_eq!(&out[..14], MAGIC);
        let back = open_snapshot(&out, PW).unwrap();
        assert_eq!(back, db, "回环必须逐字一致");
        // 非库载荷被拒：口令对、内容不对也不放行
        let fake = seal_snapshot(
            b"not a database",
            PW,
            KdfParams::default(),
            [7u8; SALT_LEN],
            [9u8; NONCE_LEN],
        )
        .unwrap();
        assert!(
            open_snapshot(&fake, PW).is_err(),
            "非 SQLite 内容必须在魔数闸被挡下"
        );
    }

    #[test]
    fn wrong_passphrase_and_tampering_both_fail() {
        let db = SQLITE_MAGIC.to_vec();
        let out = seal_snapshot(
            &db,
            PW,
            KdfParams::default(),
            [1u8; SALT_LEN],
            [2u8; NONCE_LEN],
        )
        .unwrap();
        assert!(
            open_snapshot(&out, "wrong-password").is_err(),
            "错口令必须失败"
        );
        // 篡改密文最后一字节（AEAD 认证必须抓住）
        let mut tampered = out.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(open_snapshot(&tampered, PW).is_err(), "密文被改必须失败");
        // 头部被改（整个头部作为 AAD）——哪怕改成另一个合法参数值，AEAD 也解不开
        let mut tampered_header = out.clone();
        tampered_header[20] ^= 0x01; // m_cost 最低字节 ±1
        assert!(
            open_snapshot(&tampered_header, PW).is_err(),
            "头部被改必须失败 —— 整个头部作为 AAD"
        );
        // KDF 参数**降级**（低于下限）在 parse_header 就被拒 —— 不给 AEAD 机会
        let mut downgraded = out.clone();
        downgraded[18] = 0x00; // m_cost 65536 = 0x00010000 ⇒ 清第二字节后 < 下限
        assert!(
            open_snapshot(&downgraded, PW).is_err(),
            "KDF 参数低于安全下限必须被拒"
        );
    }

    #[test]
    fn magic_separates_the_two_backup_families() {
        // 拿 RP 密钥备份的文件喂给全库恢复 ⇒ 魔数闸直接挡下（两种备份互不兼容是刻意的）
        let rp_file = b"GOSSLAN-RPKEY-not-a-db-snapshot";
        assert!(open_snapshot(rp_file, PW).is_err());
    }

    #[test]
    fn weak_passphrase_rejected_before_any_crypto() {
        assert!(seal_snapshot(
            &SQLITE_MAGIC[..],
            "1234567",
            KdfParams::default(),
            [0u8; SALT_LEN],
            [0u8; NONCE_LEN]
        )
        .is_err());
        assert!(passphrase_error("1234567").is_some());
        assert!(passphrase_error(PW).is_none());
    }

    #[test]
    fn newer_format_version_rejected() {
        let mut header = header_bytes(KdfParams::default(), &[3u8; SALT_LEN], &[4u8; NONCE_LEN]);
        header[14] = 0x00; // version 高字节
        header[15] = 0x02; // version 2 > 1 ⇒ 拒绝（不猜格式）
        assert!(parse_header(&header).is_err());
    }
}
