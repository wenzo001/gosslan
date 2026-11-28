//! **用户数据全量备份**的加密外壳（J1-4b，旅程走查 2026-11-20，用户拍板：
//! 「私钥进备份，加密备份」）。这里只放**纯逻辑**（字节格式 + Argon2id +
//! XChaCha20-Poly1305 + SQLite 快照校验），不碰文件系统、不碰 tauri、不碰数据库
//! —— 命令层（`commands/user_backup.rs`）负责那三样，测试因此可以在任何平台跑。
//!
//! ## 一句话
//!
//! v1 导出 = `VACUUM INTO` 一份一致性快照（**信封列解成明文**——备份外壳自己加密）
//! → 整库字节按口令加密成单文件。v2 外层是单个 tar，内含沿用的 `database.enc`、
//! `stickers/<cid>.enc` 与 `stickers/<cid>.thumb.enc`；同一次 Argon2id 派生的 key
//! 复用于所有条目，每个表情使用独立 nonce 且以 cid 为 AAD。恢复 = 解密、校验 SQLite、
//! schema、条目集合、大小与 SHA-256，落成 pending 文件，**重启时**替换主库。
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

use chacha20poly1305::aead::{Aead, AeadInPlace, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand_core::RngCore;
use rusqlite::OptionalExtension;
use std::io::{Read, Write};

use crate::error_codes::{self, coded};

/// 文件魔数：14 字节 ASCII。与 RP 密钥备份（`GOSSLAN-RPKEY`）**只差一个字母** ——
/// 恢复时拿错文件在这一步就被挡下，不要指望用户自己分得清两种备份。
pub const MAGIC: &[u8; 14] = b"GOSSLAN-BACKUP";
/// 旧版（database.enc 单文件）格式版本。v2 是外层 tar，不经过这里的版本头。
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
///
/// 类型是 **`u64`**，不是 `usize`：2026-11-21 的教训 —— 它曾经是 `usize`，调用处写成
/// `MAX_DB_BYTES * 2`，在 **armv7 的 32 位 usize** 上就是 `2^31 * 2 = 2^32`，**编译期**
/// 直接 `#[deny(arithmetic_overflow)]` 失败（aarch64 是 64 位，全绿 ⇒ 本地门禁当时只查
/// aarch64，整类 32 位问题看不见）。文件长度本来就是 `u64`（`Metadata::len()`），
/// 按字节数比较全程留在 `u64` 里，就不会再有"目标位宽决定能不能编译"这种事。
pub const MAX_DB_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

pub(crate) fn derive_key(
    passphrase: &str,
    params: KdfParams,
    salt: &[u8],
) -> Result<[u8; 32], String> {
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
pub(crate) fn parse_header(
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
    if version != FORMAT_VERSION {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            format!("不支持的旧版备份格式版本 {version}（本机为 {FORMAT_VERSION}）"),
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
    // 不可信文件头不能把恢复进程推进无限内存/CPU 消耗。
    if m_cost_kib > 1_048_576 || t_cost > 16 || p_cost != P_COST {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            "KDF 参数超过本机安全上限",
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
#[cfg(test)]
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
    // `usize as u64` 是**无损**的（32 位也一样），所以这条在两种目标位宽上判据一致。
    if db_bytes.len() as u64 > MAX_DB_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("快照超过 {MAX_DB_BYTES} 字节上限，拒绝打包"),
        ));
    }
    let key = derive_key(passphrase, params, &salt)?;
    seal_snapshot_with_key(db_bytes, params, salt, nonce, &key)
}

/// v2 复用同一次 Argon2id 派生的 key：数据库与每张表情共用 key，但 nonce 各自独立。
#[cfg(test)]
pub fn seal_snapshot_with_key(
    db_bytes: &[u8],
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    if db_bytes.len() as u64 > MAX_DB_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("快照超过 {MAX_DB_BYTES} 字节上限，拒绝打包"),
        ));
    }
    let header = header_bytes(params, &salt, &nonce);
    let cipher = XChaCha20Poly1305::new(key.into());
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

pub fn seal_snapshot_with_key_owned(
    mut db_bytes: Vec<u8>,
    params: KdfParams,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
    key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    if db_bytes.len() as u64 > MAX_DB_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("快照超过 {MAX_DB_BYTES} 字节上限，拒绝打包"),
        ));
    }
    let header = header_bytes(params, &salt, &nonce);
    let plain_len = db_bytes.len();
    db_bytes
        .try_reserve(HEADER_LEN + 16)
        .map_err(|_| coded(error_codes::RP_KEY_BACKUP_IO, "加密快照内存分配失败"))?;
    db_bytes.resize(HEADER_LEN + plain_len, 0);
    db_bytes.copy_within(0..plain_len, HEADER_LEN);
    db_bytes[..HEADER_LEN].copy_from_slice(&header);
    let cipher = XChaCha20Poly1305::new(key.into());
    let tag = {
        let (aad, ciphertext) = db_bytes.split_at_mut(HEADER_LEN);
        cipher
            .encrypt_in_place_detached(XNonce::from_slice(&nonce), aad, ciphertext)
            .map_err(|_| coded(error_codes::RP_KEY_BACKUP_IO, "加密失败"))?
    };
    db_bytes.extend_from_slice(&tag);
    Ok(db_bytes)
}

/// 解密并校验快照。**所有失败都回同一个码族**（口令错 / 文件损坏 / 被篡改），
/// 只在消息里给类别 —— 不让攻击者从错误码里学出「口令对不对」。
pub fn open_snapshot(bytes: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    let (params, salt, _, _) = parse_header(bytes)?;
    let key = derive_key(passphrase, params, &salt)?;
    open_snapshot_with_key(bytes, &key)
}

pub fn open_snapshot_with_key(bytes: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let (_, _, nonce, header_len) = parse_header(bytes)?;
    let cipher = XChaCha20Poly1305::new(key.into());
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

pub fn open_snapshot_with_key_in_place(
    mut bytes: Vec<u8>,
    key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let (_, _, nonce, header_len) = parse_header(&bytes)?;
    let aad = bytes[..header_len].to_vec();
    bytes.drain(..header_len);
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt_in_place(XNonce::from_slice(&nonce), &aad, &mut bytes)
        .map_err(|_| {
            coded(
                error_codes::RP_KEY_BACKUP_UNREADABLE,
                "解密失败：口令不对，或文件被改过",
            )
        })?;
    validate_sqlite_bytes(&bytes)?;
    Ok(bytes)
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

// ---------------------------------------------------------------------------
// Backup v2：单个 tar，database.enc + stickers/<cid>.enc + stickers/<cid>.thumb.enc
// ---------------------------------------------------------------------------

pub const V2_MANIFEST_PATH: &str = "manifest.json";
pub const V2_DATABASE_PATH: &str = "database.enc";
pub const V2_FORMAT_VERSION: u32 = 1;
pub const MAX_STICKER_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_STICKER_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
// 数据库 + 表情明文上限，外加加密认证头、tar 块与 1 MiB 清单的余量。
pub const MAX_ARCHIVE_BYTES: u64 = MAX_DB_BYTES + MAX_STICKER_TOTAL_BYTES + 64 * 1024 * 1024;
pub const MAX_STICKER_COUNT: usize = 10_000;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const STICKER_MAGIC: &[u8; 8] = b"GSTICKER";
const STICKER_VERSION: u16 = 1;
// magic(8) + version(2) + cid_len(2) + nonce(24)
const STICKER_HEADER_LEN: usize = 36;

fn backup_error(message: impl Into<String>) -> String {
    coded(error_codes::RP_KEY_BACKUP_UNREADABLE, message.into())
}

/// cid 同时是文件名、AAD 与主键：只允许无路径语义的 ASCII 内容寻址标识。
pub fn validate_cid(cid: &str) -> Result<(), String> {
    let valid = !cid.is_empty()
        && cid.len() <= 64
        && cid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid || cid == "." || cid == ".." {
        return Err(backup_error(format!("非法表情 cid：{cid:?}")));
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FileManifest {
    pub size: u64,
    pub sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StickerManifest {
    pub cid: String,
    pub original: FileManifest,
    pub thumbnail: Option<FileManifest>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct BackupManifest {
    pub version: u32,
    pub database: FileManifest,
    pub stickers: Vec<StickerManifest>,
}

pub struct StickerInput {
    pub cid: String,
    pub data: Vec<u8>,
    pub thumbnail: Option<Vec<u8>>,
    /// custom_stickers.sha256；导出时再次核对，防止磁盘损坏被静默打包。
    pub sha256: String,
}

/// 恢复期的单张表情只保留路径与校验元数据；内容始终在磁盘上，绝不整包驻留内存。
#[derive(Debug)]
pub struct RestoredSticker {
    pub original_path: std::path::PathBuf,
    pub thumbnail_path: Option<std::path::PathBuf>,
    pub original: FileManifest,
    pub thumbnail: Option<FileManifest>,
}

#[derive(Debug)]
pub struct RestoredV2 {
    pub db_bytes: Vec<u8>,
    pub stickers: std::collections::BTreeMap<String, RestoredSticker>,
    #[cfg(test)]
    pub _tempdir: Option<tempfile::TempDir>,
}

fn file_manifest(data: &[u8]) -> FileManifest {
    use sha2::{Digest, Sha256};
    FileManifest {
        size: data.len() as u64,
        sha256: format!("{:x}", Sha256::digest(data)),
    }
}

fn check_manifest_file(file: &FileManifest, data: &[u8], what: &str) -> Result<(), String> {
    if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(backup_error(format!("{what} 的 SHA-256 清单无效")));
    }
    if file.size != data.len() as u64 {
        return Err(backup_error(format!("{what} 大小与清单不符")));
    }
    if file_manifest(data).sha256 != file.sha256.to_ascii_lowercase() {
        return Err(backup_error(format!("{what} SHA-256 与清单不符")));
    }
    Ok(())
}

fn seal_sticker(cid: &str, data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    validate_cid(cid)?;
    if data.len() as u64 > MAX_STICKER_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "表情文件超过 32 MiB 上限",
        ));
    }
    let mut nonce = [0u8; NONCE_LEN];
    use rand_core::RngCore;
    rand_core::OsRng.fill_bytes(&mut nonce);
    let mut header = Vec::with_capacity(STICKER_HEADER_LEN + cid.len());
    header.extend_from_slice(STICKER_MAGIC);
    header.extend_from_slice(&STICKER_VERSION.to_be_bytes());
    header.extend_from_slice(&(cid.len() as u16).to_be_bytes());
    header.extend_from_slice(&nonce);
    header.extend_from_slice(cid.as_bytes());
    let cipher = XChaCha20Poly1305::new(key.into());
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: data,
                aad: &header,
            },
        )
        .map_err(|_| coded(error_codes::RP_KEY_BACKUP_IO, "表情加密失败"))?;
    header.extend_from_slice(&ct);
    Ok(header)
}

fn open_sticker(bytes: &[u8], expected_cid: &str, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    validate_cid(expected_cid)?;
    if bytes.len() < STICKER_HEADER_LEN || &bytes[..8] != STICKER_MAGIC {
        return Err(backup_error("表情文件头无效"));
    }
    if u16::from_be_bytes([bytes[8], bytes[9]]) != STICKER_VERSION {
        return Err(backup_error("表情文件版本不支持"));
    }
    let cid_len = u16::from_be_bytes([bytes[10], bytes[11]]) as usize;
    if cid_len == 0 || STICKER_HEADER_LEN + cid_len > bytes.len() {
        return Err(backup_error("表情文件头中的 cid 无效"));
    }
    let cid = std::str::from_utf8(&bytes[STICKER_HEADER_LEN..STICKER_HEADER_LEN + cid_len])
        .map_err(|_| backup_error("表情 cid 不是 UTF-8"))?;
    if cid != expected_cid {
        return Err(backup_error("表情文件头 cid 与条目名不符"));
    }
    let header_len = STICKER_HEADER_LEN + cid_len;
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(
            XNonce::from_slice(&bytes[12..36]),
            Payload {
                msg: &bytes[header_len..],
                aad: &bytes[..header_len],
            },
        )
        .map_err(|_| backup_error("表情解密失败：口令错误或文件被篡改"))
}

/// 流式写 v2：同一时刻只保留一张表情明文/密文，清单最后写。
/// 数据库仍沿用既有整库加密快照；表情由调用方按需从磁盘读取。
pub fn write_v2_archive<W: Write, F>(
    db_bytes: Vec<u8>,
    mut out: W,
    passphrase: &str,
    params: KdfParams,
    salt: [u8; SALT_LEN],
    sticker_count: usize,
    mut sticker_at: F,
) -> Result<usize, String>
where
    F: FnMut(usize) -> Result<StickerInput, String>,
{
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    if sticker_count > MAX_STICKER_COUNT {
        return Err(backup_error("表情数量超过上限"));
    }
    let key = derive_key(passphrase, params, &salt)?;
    let mut db_nonce = [0u8; NONCE_LEN];
    rand_core::OsRng.fill_bytes(&mut db_nonce);
    let database = seal_snapshot_with_key_owned(db_bytes, params, salt, db_nonce, &key)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut total = 0u64;
    let mut manifest_stickers = Vec::with_capacity(sticker_count);
    let mut ar = tar::Builder::new(&mut out);
    append_tar_file(&mut ar, V2_DATABASE_PATH, &database)?;
    for index in 0..sticker_count {
        let sticker = sticker_at(index)?;
        validate_cid(&sticker.cid)?;
        if !seen.insert(sticker.cid.clone()) {
            return Err(backup_error(format!("表情 cid 重复：{}", sticker.cid)));
        }
        let expected = FileManifest {
            size: sticker.data.len() as u64,
            sha256: sticker.sha256.to_ascii_lowercase(),
        };
        check_manifest_file(&expected, &sticker.data, "表情原件")?;
        total = add_sticker_total(total, sticker.data.len() as u64, MAX_STICKER_TOTAL_BYTES)?;
        total = add_sticker_total(
            total,
            sticker.thumbnail.as_ref().map_or(0, |t| t.len() as u64),
            MAX_STICKER_TOTAL_BYTES,
        )?;
        append_tar_file(
            &mut ar,
            &format!("stickers/{}.enc", sticker.cid),
            &seal_sticker(&sticker.cid, &sticker.data, &key)?,
        )?;
        if let Some(data) = &sticker.thumbnail {
            append_tar_file(
                &mut ar,
                &format!("stickers/{}.thumb.enc", sticker.cid),
                &seal_sticker(&sticker.cid, data, &key)?,
            )?;
        }
        manifest_stickers.push(StickerManifest {
            cid: sticker.cid.clone(),
            original: file_manifest(&sticker.data),
            thumbnail: sticker.thumbnail.as_ref().map(|data| file_manifest(data)),
        });
    }
    let manifest = BackupManifest {
        version: V2_FORMAT_VERSION,
        database: file_manifest(&database),
        stickers: manifest_stickers,
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|e| backup_error(format!("清单编码失败: {e}")))?;
    if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(backup_error("备份清单超过上限"));
    }
    append_tar_file(&mut ar, V2_MANIFEST_PATH, &manifest_bytes)?;
    ar.finish()
        .map_err(|e| backup_error(format!("tar 收尾失败: {e}")))?;
    drop(ar);
    out.flush()
        .map_err(|e| backup_error(format!("刷新备份失败: {e}")))?;
    Ok(sticker_count)
}

#[cfg(test)]
fn build_v2_archive(
    db_bytes: &[u8],
    stickers: &[StickerInput],
    passphrase: &str,
    params: KdfParams,
    salt: [u8; SALT_LEN],
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    write_v2_archive(
        db_bytes.to_vec(),
        &mut out,
        passphrase,
        params,
        salt,
        stickers.len(),
        |i| {
            let s = &stickers[i];
            Ok(StickerInput {
                cid: s.cid.clone(),
                data: s.data.clone(),
                thumbnail: s.thumbnail.clone(),
                sha256: s.sha256.clone(),
            })
        },
    )?;
    Ok(out)
}

fn append_tar_file<W: std::io::Write>(
    ar: &mut tar::Builder<W>,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o600);
    header.set_mtime(0);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    ar.append_data(&mut header, path, data)
        .map_err(|e| backup_error(format!("写入 tar 条目 {path} 失败: {e}")))
}

/// 流式打开 v2：tar 条目逐项读，表情密文先落 staging，随后逐张解密/校验/落盘。
/// 内存中只允许一份清单、数据库密文与当前单张表情，绝无全量表情 BTreeMap。
pub fn open_v2_archive_file(
    archive_path: &std::path::Path,
    passphrase: &str,
    current_db_version: u32,
    final_stickers_dir: &std::path::Path,
    staging: &std::path::Path,
) -> Result<RestoredV2, String> {
    if let Some(e) = passphrase_error(passphrase) {
        return Err(e);
    }
    let file = std::fs::File::open(archive_path)
        .map_err(|e| backup_error(format!("打开备份失败: {e}")))?;
    if file
        .metadata()
        .map_err(|e| backup_error(format!("读取备份大小失败: {e}")))?
        .len()
        > MAX_ARCHIVE_BYTES
    {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "备份超过大小上限",
        ));
    }
    let encrypted_dir = staging.join("encrypted");
    std::fs::create_dir_all(&encrypted_dir)
        .map_err(|e| backup_error(format!("创建表情暂存目录失败: {e}")))?;
    let mut ar = tar::Archive::new(file);
    let mut manifest_bytes = None;
    let mut database = None;
    let mut encrypted = std::collections::BTreeMap::<String, std::path::PathBuf>::new();
    let mut total = 0u64;
    let mut entry_count = 0usize;
    for entry in ar
        .entries()
        .map_err(|e| backup_error(format!("读取 tar 失败: {e}")))?
    {
        let mut entry = entry.map_err(|e| backup_error(format!("读取 tar 条目失败: {e}")))?;
        entry_count += 1;
        if entry_count > MAX_STICKER_COUNT * 2 + 2 {
            return Err(backup_error("备份条目数量超过上限"));
        }
        if !entry.header().entry_type().is_file() {
            return Err(backup_error("备份包含非普通文件条目"));
        }
        let path = entry
            .path()
            .map_err(|e| backup_error(format!("tar 路径无效: {e}")))?
            .to_string_lossy()
            .into_owned();
        if path == V2_MANIFEST_PATH && manifest_bytes.is_some()
            || path == V2_DATABASE_PATH && database.is_some()
            || encrypted.contains_key(&path)
        {
            return Err(backup_error(format!("备份条目重复：{path}")));
        }
        let limit = if path == V2_DATABASE_PATH {
            MAX_DB_BYTES + HEADER_LEN as u64 + 16
        } else if path == V2_MANIFEST_PATH {
            MAX_MANIFEST_BYTES
        } else if path.starts_with("stickers/") {
            MAX_STICKER_BYTES + STICKER_HEADER_LEN as u64 + 1024
        } else {
            return Err(backup_error(format!("备份包含清单外条目：{path}")));
        };
        if entry.size() > limit {
            return Err(backup_error("备份条目超过大小上限"));
        }
        let data = read_bounded_entry(&mut entry, limit)?;
        total = total
            .checked_add(data.len() as u64)
            .ok_or_else(|| backup_error("备份解压大小溢出"))?;
        if total > MAX_ARCHIVE_BYTES {
            return Err(coded(
                error_codes::RP_KEY_BACKUP_TOO_LARGE,
                "备份解压后超过上限",
            ));
        }
        if path == V2_MANIFEST_PATH {
            manifest_bytes = Some(data);
        } else if path == V2_DATABASE_PATH {
            database = Some(data);
        } else {
            let stored = encrypted_dir.join(format!("{entry_count}.enc"));
            std::fs::write(&stored, &data)
                .map_err(|e| backup_error(format!("暂存表情密文失败: {e}")))?;
            encrypted.insert(path, stored);
        }
    }
    let manifest_bytes = manifest_bytes.ok_or_else(|| backup_error("v2 备份缺少 manifest.json"))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| backup_error(format!("备份清单无效：{e}")))?;
    if manifest.version != V2_FORMAT_VERSION {
        return Err(backup_error("不支持的 v2 清单版本"));
    }
    if manifest.stickers.len() > MAX_STICKER_COUNT {
        return Err(backup_error("表情数量超过上限"));
    }
    let database = database.ok_or_else(|| backup_error("v2 备份缺少 database.enc"))?;
    check_manifest_file(&manifest.database, &database, "数据库密文")?;
    let (params, salt, _, _) = parse_header(&database)?;
    let key = derive_key(passphrase, params, &salt)?;
    let db_bytes = open_snapshot_with_key_in_place(database, &key)?;
    let staged_stickers = final_stickers_dir;
    std::fs::create_dir_all(staged_stickers.join("thumbs"))
        .map_err(|e| backup_error(format!("创建表情恢复目录失败: {e}")))?;
    let mut stickers = std::collections::BTreeMap::new();
    let mut sticker_total = 0u64;
    for sticker in &manifest.stickers {
        validate_cid(&sticker.cid)?;
        if stickers.contains_key(&sticker.cid) {
            return Err(backup_error("清单中的表情 cid 重复"));
        }
        let original_path = staged_stickers.join(&sticker.cid);
        let original_enc = encrypted
            .remove(&format!("stickers/{}.enc", sticker.cid))
            .ok_or_else(|| backup_error(format!("缺少表情原件：{}", sticker.cid)))?;
        let original = decrypt_sticker_file(&original_enc, &sticker.cid, &key)?;
        check_sticker_size_and_hash(&sticker.original, &original, "表情原件")?;
        sticker_total = add_sticker_total(
            sticker_total,
            original.len() as u64,
            MAX_STICKER_TOTAL_BYTES,
        )?;
        std::fs::write(&original_path, &original)
            .map_err(|e| backup_error(format!("写入表情 {} 失败: {e}", sticker.cid)))?;
        let _ = std::fs::remove_file(&original_enc);
        let thumbnail = if let Some(meta) = &sticker.thumbnail {
            let encrypted_path = encrypted
                .remove(&format!("stickers/{}.thumb.enc", sticker.cid))
                .ok_or_else(|| backup_error(format!("缺少表情缩略图：{}", sticker.cid)))?;
            let data = decrypt_sticker_file(&encrypted_path, &sticker.cid, &key)?;
            check_sticker_size_and_hash(meta, &data, "表情缩略图")?;
            sticker_total =
                add_sticker_total(sticker_total, data.len() as u64, MAX_STICKER_TOTAL_BYTES)?;
            let thumbnail_path = staged_stickers
                .join("thumbs")
                .join(format!("{}.png", sticker.cid));
            std::fs::write(&thumbnail_path, &data)
                .map_err(|e| backup_error(format!("写入表情缩略图 {} 失败: {e}", sticker.cid)))?;
            let _ = std::fs::remove_file(&encrypted_path);
            Some(meta.clone())
        } else {
            None
        };
        stickers.insert(
            sticker.cid.clone(),
            RestoredSticker {
                original_path,
                thumbnail_path: sticker.thumbnail.as_ref().map(|_| {
                    staged_stickers
                        .join("thumbs")
                        .join(format!("{}.png", sticker.cid))
                }),
                original: sticker.original.clone(),
                thumbnail,
            },
        );
    }
    if !encrypted.is_empty() {
        return Err(backup_error(format!(
            "备份包含清单外条目：{:?}",
            encrypted.keys().collect::<Vec<_>>()
        )));
    }
    let db_bytes = rewrite_restored_database(
        db_bytes,
        &mut stickers,
        current_db_version,
        final_stickers_dir,
        &staging.join("restored.db"),
    )?;
    Ok(RestoredV2 {
        db_bytes,
        stickers,
        #[cfg(test)]
        _tempdir: None,
    })
}

fn read_bounded_entry<R: Read>(reader: &mut R, limit: u64) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| backup_error(format!("读取 tar 条目失败: {e}")))?;
    if data.len() as u64 > limit {
        return Err(backup_error("备份条目超过大小上限"));
    }
    Ok(data)
}

fn decrypt_sticker_file(
    path: &std::path::Path,
    cid: &str,
    key: &[u8; 32],
) -> Result<Vec<u8>, String> {
    let file =
        std::fs::File::open(path).map_err(|e| backup_error(format!("读取暂存表情失败: {e}")))?;
    let bytes = read_bounded_entry(
        &mut std::io::BufReader::new(file),
        MAX_STICKER_BYTES + STICKER_HEADER_LEN as u64 + 1024,
    )?;
    open_sticker(&bytes, cid, key)
}

fn check_sticker_size_and_hash(file: &FileManifest, data: &[u8], what: &str) -> Result<(), String> {
    if data.len() as u64 > MAX_STICKER_BYTES {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            format!("{what}超过上限"),
        ));
    }
    check_manifest_file(file, data, what)
}

fn add_sticker_total(total: u64, additional: u64, limit: u64) -> Result<u64, String> {
    let next = total
        .checked_add(additional)
        .ok_or_else(|| backup_error("表情总大小溢出"))?;
    if next > limit {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_TOO_LARGE,
            "表情总大小超过上限",
        ));
    }
    Ok(next)
}

#[cfg(test)]
fn open_v2_archive(
    bytes: &[u8],
    passphrase: &str,
    current_db_version: u32,
    _final_stickers_dir: &std::path::Path,
) -> Result<RestoredV2, String> {
    let dir = tempfile::tempdir().map_err(|e| backup_error(format!("创建测试暂存失败: {e}")))?;
    let archive = dir.path().join("backup.tar");
    std::fs::write(&archive, bytes).map_err(|e| backup_error(format!("写测试备份失败: {e}")))?;
    let staging = dir.path().join("staging");
    std::fs::create_dir_all(staging.join("stickers/thumbs"))
        .map_err(|e| backup_error(format!("创建测试目录失败: {e}")))?;
    let mut restored = open_v2_archive_file(
        &archive,
        passphrase,
        current_db_version,
        &staging.join("stickers"),
        &staging,
    )?;
    restored._tempdir = Some(dir);
    Ok(restored)
}

#[cfg(test)]
pub(crate) fn connection_from_bytes(bytes: &[u8]) -> Result<rusqlite::Connection, String> {
    use rusqlite::ffi;
    use rusqlite::serialize::OwnedData;
    use std::ptr::NonNull;
    if bytes.is_empty() {
        return Err(backup_error("空数据库"));
    }
    // SAFETY: sqlite3_malloc64 分配的长度与 bytes 完全一致，拷贝不越界；
    // 非空由上面的检查保证，OwnedData::Drop 会用 sqlite3_free 释放同一指针。
    let data = unsafe {
        let ptr = ffi::sqlite3_malloc64(bytes.len() as u64) as *mut u8;
        let ptr = NonNull::new(ptr).ok_or_else(|| backup_error("内存库分配失败"))?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.as_ptr(), bytes.len());
        OwnedData::from_raw_nonnull(ptr, bytes.len())
    };
    let mut conn =
        rusqlite::Connection::open_in_memory().map_err(|e| backup_error(format!("{e}")))?;
    conn.deserialize(rusqlite::DatabaseName::Main, data, false)
        .map_err(|e| backup_error(format!("加载恢复库失败: {e}")))?;
    Ok(conn)
}

/// 校验库完整性、schema、条目集合与原始文件哈希，并把路径改写到最终 stickers 目录。
pub fn rewrite_restored_database(
    db_bytes: Vec<u8>,
    stickers: &mut std::collections::BTreeMap<String, RestoredSticker>,
    current_db_version: u32,
    final_stickers_dir: &std::path::Path,
    staging_db_path: &std::path::Path,
) -> Result<Vec<u8>, String> {
    validate_sqlite_bytes(&db_bytes)?;
    std::fs::write(staging_db_path, &db_bytes)
        .map_err(|e| backup_error(format!("写恢复库暂存文件失败: {e}")))?;
    drop(db_bytes);
    let conn = rusqlite::Connection::open(staging_db_path)
        .map_err(|e| backup_error(format!("打开恢复库暂存文件失败: {e}")))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| backup_error(format!("完整性检查失败: {e}")))?;
    if integrity != "ok" {
        return Err(backup_error(format!("完整性检查未通过: {integrity}")));
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| backup_error(format!("读取 schema 版本失败: {e}")))?;
    if version < 0 || version as u32 > current_db_version {
        return Err(coded(
            error_codes::RP_KEY_BACKUP_UNSUPPORTED,
            "备份 schema 版本不被本机支持",
        ));
    }
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_stickers'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| backup_error(format!("读取表情表失败: {e}")))?
        .unwrap_or(false);
    if !has_table {
        return Err(backup_error("v2 备份数据库缺少 custom_stickers 表"));
    }
    let rows: Vec<(String, String, i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, sha256, size, path, thumb_path FROM custom_stickers")
            .map_err(|e| backup_error(format!("读取 custom_stickers 失败: {e}")))?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(|e| backup_error(format!("读取 custom_stickers 失败: {e}")))?;
        it.collect::<Result<_, _>>()
            .map_err(|e| backup_error(format!("读取 custom_stickers 失败: {e}")))?
    };
    if rows.len() != stickers.len() {
        return Err(backup_error("custom_stickers 与 tar 表情条目集合不一致"));
    }
    let mut extensions = std::collections::BTreeMap::new();
    for (cid, sha256, size, old_path, _thumb_path) in rows {
        validate_cid(&cid)?;
        let sticker = stickers
            .get(&cid)
            .ok_or_else(|| backup_error("数据库表情在 tar 中不存在"))?;
        let meta = &sticker.original;
        if size < 0 || size as u64 != meta.size || sha256.to_ascii_lowercase() != meta.sha256 {
            return Err(backup_error(format!(
                "表情 {cid} 的大小或 SHA-256 与数据库不符"
            )));
        }
        if sticker.thumbnail.is_none() {
            return Err(backup_error(format!("表情 {cid} 缺少缩略图条目")));
        }
        let ext = std::path::Path::new(&old_path)
            .extension()
            .and_then(|e| e.to_str())
            .filter(|ext| matches!(*ext, "png" | "gif" | "webp"))
            .ok_or_else(|| backup_error(format!("表情 {cid} 的原件扩展名无效")))?;
        extensions.insert(cid.clone(), ext.to_string());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| backup_error(format!("改写路径事务失败: {e}")))?;
    for cid in stickers.keys().cloned().collect::<Vec<_>>() {
        let ext = extensions
            .get(&cid)
            .ok_or_else(|| backup_error(format!("表情 {cid} 缺少扩展名")))?;
        let path = final_stickers_dir
            .join(format!("{cid}.{ext}"))
            .to_string_lossy()
            .into_owned();
        let thumb_path = stickers
            .get(&cid)
            .and_then(|sticker| sticker.thumbnail_path.as_ref())
            .map(|path| path.to_string_lossy().into_owned());
        tx.execute(
            "UPDATE custom_stickers SET path=?1, thumb_path=?2 WHERE id=?3",
            rusqlite::params![path, thumb_path, cid],
        )
        .map_err(|e| backup_error(format!("改写表情路径失败: {e}")))?;
        let sticker = stickers
            .get_mut(&cid)
            .ok_or_else(|| backup_error(format!("表情 {cid} 缺少暂存文件")))?;
        std::fs::rename(&sticker.original_path, &path)
            .map_err(|e| backup_error(format!("落定表情 {cid} 失败: {e}")))?;
        sticker.original_path = std::path::PathBuf::from(&path);
    }
    tx.commit()
        .map_err(|e| backup_error(format!("提交表情路径失败: {e}")))?;
    let serialized = conn
        .serialize(rusqlite::DatabaseName::Main)
        .map_err(|e| backup_error(format!("序列化恢复库失败: {e}")))?
        .to_vec();
    drop(conn);
    let _ = std::fs::remove_file(staging_db_path);
    Ok(serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "correct-horse-battery";

    #[test]
    fn sticker_total_limit_accepts_boundary_and_rejects_overflow() {
        assert_eq!(add_sticker_total(6, 2, 8).unwrap(), 8);
        assert!(add_sticker_total(6, 3, 8).is_err());
        assert!(add_sticker_total(u64::MAX, 1, u64::MAX).is_err());
    }

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

    fn test_db(sha256: &str, size: i64, _thumb: bool) -> Vec<u8> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE custom_stickers (
            id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, path TEXT NOT NULL,
            thumb_path TEXT, name TEXT NOT NULL, mime TEXT NOT NULL,
            width INTEGER NOT NULL, height INTEGER NOT NULL, frame_count INTEGER NOT NULL,
            size INTEGER NOT NULL, sort_at INTEGER NOT NULL, source_msg_id TEXT);
            PRAGMA user_version=18;",
        )
        .unwrap();
        conn.execute("INSERT INTO custom_stickers VALUES ('cid1',?1,'/old/cid1.webp',?2,'n','image/webp',1,1,1,?3,0,NULL)",
            rusqlite::params![sha256, Some("/old/cid1.thumb"), size]).unwrap();
        conn.serialize(rusqlite::DatabaseName::Main)
            .unwrap()
            .to_vec()
    }

    fn hash(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(data))
    }

    fn archive_entries(bytes: &[u8]) -> std::collections::BTreeMap<String, Vec<u8>> {
        let mut ar = tar::Archive::new(bytes);
        let mut out = std::collections::BTreeMap::new();
        for e in ar.entries().unwrap() {
            let mut e = e.unwrap();
            let path = e.path().unwrap().to_string_lossy().into_owned();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut e, &mut data).unwrap();
            out.insert(path, data);
        }
        out
    }

    fn pack_entries(entries: &std::collections::BTreeMap<String, Vec<u8>>) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut ar = tar::Builder::new(&mut out);
            for (path, data) in entries {
                append_tar_file(&mut ar, path, data).unwrap();
            }
            ar.finish().unwrap();
        }
        out
    }

    #[test]
    fn v2_roundtrip_restores_database_original_thumb_and_paths() {
        let original = b"original-webp";
        let thumb = b"thumb-webp";
        let db = test_db(&hash(original), original.len() as i64, true);
        let archive = build_v2_archive(
            &db,
            &[StickerInput {
                cid: "cid1".into(),
                data: original.to_vec(),
                thumbnail: Some(thumb.to_vec()),
                sha256: hash(original),
            }],
            PW,
            KdfParams::default(),
            [5u8; SALT_LEN],
        )
        .unwrap();
        assert!(open_snapshot(&archive, PW).is_err(), "旧版必须拒绝 v2 tar");
        let names = archive_entries(&archive);
        assert_eq!(names.len(), 4);
        assert!(names.contains_key("database.enc"));
        assert_eq!(
            tar::Archive::new(&archive[..])
                .entries()
                .unwrap()
                .last()
                .unwrap()
                .unwrap()
                .path()
                .unwrap()
                .to_string_lossy(),
            V2_MANIFEST_PATH,
            "流式导出必须把 manifest 放在最后"
        );
        assert!(names.contains_key("stickers/cid1.enc"));
        assert!(names.contains_key("stickers/cid1.thumb.enc"));
        assert!(
            open_snapshot(&names["database.enc"], PW).is_ok(),
            "database.enc 必须沿用 v1 外壳"
        );
        let restored =
            open_v2_archive(&archive, PW, 18, std::path::Path::new("/app/stickers")).unwrap();
        assert_eq!(
            std::fs::read(&restored.stickers["cid1"].original_path).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read(restored.stickers["cid1"].thumbnail_path.as_ref().unwrap()).unwrap(),
            thumb
        );
        let conn = connection_from_bytes(&restored.db_bytes).unwrap();
        let (path, thumb_path): (String, Option<String>) = conn
            .query_row(
                "SELECT path,thumb_path FROM custom_stickers WHERE id='cid1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(path.ends_with("/stickers/cid1.webp"), "{path}");
        assert!(thumb_path
            .as_deref()
            .is_some_and(|p| p.ends_with("/stickers/thumbs/cid1.png")));
    }

    #[test]
    fn v2_wrong_password_missing_entry_hash_mismatch_and_tamper_fail() {
        let original = b"image";
        let db = test_db(&hash(original), original.len() as i64, true);
        let make = || {
            build_v2_archive(
                &db,
                &[StickerInput {
                    cid: "cid1".into(),
                    data: original.to_vec(),
                    thumbnail: Some(b"thumb".to_vec()),
                    sha256: hash(original),
                }],
                PW,
                KdfParams::default(),
                [6u8; SALT_LEN],
            )
            .unwrap()
        };
        let archive = make();
        assert!(
            open_v2_archive(&archive, "wrong password", 18, std::path::Path::new("/s")).is_err()
        );
        let mut entries = archive_entries(&archive);
        entries.remove("database.enc");
        assert!(
            open_v2_archive(&pack_entries(&entries), PW, 18, std::path::Path::new("/s")).is_err(),
            "缺 database.enc 必须拒"
        );
        let mut entries = archive_entries(&archive);
        entries.remove("stickers/cid1.thumb.enc");
        assert!(
            open_v2_archive(&pack_entries(&entries), PW, 18, std::path::Path::new("/s")).is_err()
        );
        let mut entries = archive_entries(&archive);
        let enc = entries.get_mut("stickers/cid1.enc").unwrap();
        *enc.last_mut().unwrap() ^= 1;
        assert!(
            open_v2_archive(&pack_entries(&entries), PW, 18, std::path::Path::new("/s")).is_err()
        );
        let bad_db = test_db(&hash(b"different"), original.len() as i64, true);
        let archive = build_v2_archive(
            &bad_db,
            &[StickerInput {
                cid: "cid1".into(),
                data: original.to_vec(),
                thumbnail: Some(b"thumb".to_vec()),
                sha256: hash(original),
            }],
            PW,
            KdfParams::default(),
            [6u8; SALT_LEN],
        )
        .unwrap();
        assert!(
            open_v2_archive(&archive, PW, 18, std::path::Path::new("/s")).is_err(),
            "数据库 SHA 不一致必须拒"
        );
        assert!(
            build_v2_archive(
                &db,
                &[StickerInput {
                    cid: "cid1".into(),
                    data: original.to_vec(),
                    thumbnail: Some(Vec::new()),
                    sha256: "0".repeat(64),
                }],
                PW,
                KdfParams::default(),
                [6u8; SALT_LEN]
            )
            .is_err(),
            "导出时磁盘哈希不符必须拒"
        );
    }

    #[test]
    fn v2_path_traversal_and_extra_entries_are_rejected() {
        for cid in ["../x", "a/b", "..", "", "a\\b"] {
            assert!(validate_cid(cid).is_err(), "危险 cid 必须拒: {cid}");
        }
        let original = b"image";
        let db = test_db(&hash(original), original.len() as i64, false);
        let archive = build_v2_archive(
            &db,
            &[StickerInput {
                cid: "cid1".into(),
                data: original.to_vec(),
                thumbnail: Some(Vec::new()),
                sha256: hash(original),
            }],
            PW,
            KdfParams::default(),
            [8u8; SALT_LEN],
        )
        .unwrap();
        let mut traversal = Vec::new();
        assert!(
            append_tar_file(&mut tar::Builder::new(&mut traversal), "../escape", b"bad").is_err()
        );
        let mut traversal = Vec::new();
        assert!(
            append_tar_file(
                &mut tar::Builder::new(&mut traversal),
                "stickers/../escape.enc",
                b"bad"
            )
            .is_err(),
            "tar 路径穿越必须拒"
        );
        let mut entries = archive_entries(&archive);
        entries.insert("unexpected".into(), b"bad".to_vec());
        assert!(
            open_v2_archive(&pack_entries(&entries), PW, 18, std::path::Path::new("/s")).is_err()
        );
    }

    #[test]
    fn v2_size_limits_and_newer_schema_are_rejected() {
        let original = b"image";
        let db = test_db(&hash(original), original.len() as i64, false);
        let archive = build_v2_archive(
            &db,
            &[StickerInput {
                cid: "cid1".into(),
                data: original.to_vec(),
                thumbnail: Some(Vec::new()),
                sha256: hash(original),
            }],
            PW,
            KdfParams::default(),
            [9u8; SALT_LEN],
        )
        .unwrap();
        assert!(open_v2_archive(&archive, PW, 16, std::path::Path::new("/s")).is_err());
        let too_big = vec![0u8; MAX_STICKER_BYTES as usize + 1];
        assert!(build_v2_archive(
            &db,
            &[StickerInput {
                cid: "cid1".into(),
                data: too_big,
                thumbnail: Some(Vec::new()),
                sha256: hash(original),
            }],
            PW,
            KdfParams::default(),
            [9u8; SALT_LEN]
        )
        .is_err());
        let mut header = header_bytes(KdfParams::default(), &[1u8; SALT_LEN], &[2u8; NONCE_LEN]);
        header[17..21].copy_from_slice(&2_000_000u32.to_be_bytes());
        assert!(parse_header(&header).is_err(), "KDF 超限必须拒");
    }
}
