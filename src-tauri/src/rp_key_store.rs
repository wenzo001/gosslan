//! RP 绑定私钥的**平台密钥库**存放（Windows 凭据管理器 / Android Keystore）。
//!
//! ## 这件事在做什么
//!
//! RP 绑定私钥（`rp_device_bindings.secret_key` 列）过去是**明文**躺在本地 SQLite 里，
//! 保护强度只等于「本机文件权限」。这台机器上任何能读用户目录的进程都能拿到它，
//! 而它就是「本安装对某个第三方应用的身份凭据」—— 泄露 ⇒ 第三方应用能以用户身份登录。
//!
//! 现在：**私钥明文不再落盘**。列里存的是一个**信封**：
//!
//! ```text
//! gsk1.<后端>.<base64url(载荷)>
//! ```
//!
//! 载荷由**本机密钥库**加密，只有同一个用户、同一个系统能解开：
//!
//! | 平台 | 后端 | 载荷是什么 |
//! |---|---|---|
//! | Windows | 凭据管理器（DPAPI） | `CryptProtectData` 的密文 blob |
//! | Android | Android Keystore | AES-256-GCM（密钥在 TEE 里，不可导出） |
//! | macOS / Linux | **无**（暂缓） | 维持旧行为（明文列） |
//!
//! ## 为什么 macOS 先不做
//!
//! macOS 的 Keychain 按**签名身份**记访问控制：没签名的构建每次读都要弹授权框，
//! 而本应用有「开机自启」和「更新后自动重启」—— 没人点「允许」就是卡死。
//! 拿到稳定的签名身份（免费 Apple Development 证书就够）后再接。
//! 详见 `docs/notes/platform-keychain-free-path-2026-11-15.md`。
//!
//! ## 三条硬约束
//!
//! ① **不回落明文**：信封解不开就是解不开（错误上抛），绝不「解不开就用明文凑合」——
//!    那种静默降级会让用户以为密钥受保护了。
//! ② **升级顺序是「封 → 开回来验 → 才写回」**：任何一步失败都停在旧值，
//!    绝不先删后写（中途崩溃 ⇒ 下次启动重试，不会出现两条并存）。
//! ③ **不迁 P2P 身份密钥**：那是「你是你」的根，与 RP 绑定密钥不是一回事。
//!
//! ## 平台代码只碰最后一层
//!
//! 信封格式、后端选择、升级编排都是**跨平台纯逻辑**（本文件），可在本机单测；
//! 平台后端只在「加密/解密」这一步落地（`dpapi` / `keystore_android` 子模块）。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

#[cfg(target_os = "windows")]
mod dpapi;
#[cfg(target_os = "android")]
mod keystore_android;

/// 信封前缀（含格式版本）。**改它等于换格式**，旧信封要能读（见 `open_secret`）。
pub const ENVELOPE_PREFIX: &str = "gsk1";

/// 本机可用的密钥库后端。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// 本机没有密钥库（macOS 暂缓 / Linux）：保持旧行为（明文列）。
    None,
    /// Windows 凭据管理器（DPAPI）。
    WindowsDpapi,
    /// Android Keystore（AES-256-GCM，密钥在 TEE）。
    AndroidKeystore,
}

impl Backend {
    /// 后端 id（写进信封里的那一段）。**跨平台稳定**：导出/恢复不依赖它，但排障要看它。
    pub fn id(self) -> &'static str {
        match self {
            Backend::None => "none",
            Backend::WindowsDpapi => "dpapi",
            Backend::AndroidKeystore => "aks",
        }
    }

    /// 从 id 还原（读信封时用）。
    pub fn from_id(id: &str) -> Option<Backend> {
        match id {
            "none" => Some(Backend::None),
            "dpapi" => Some(Backend::WindowsDpapi),
            "aks" => Some(Backend::AndroidKeystore),
            _ => None,
        }
    }

    /// 人读的说明（设置页与日志用）。
    pub fn label(self) -> &'static str {
        match self {
            Backend::None => "未启用（本机没有系统密钥库）",
            Backend::WindowsDpapi => "Windows 凭据管理器（DPAPI）",
            Backend::AndroidKeystore => "Android Keystore（AES-GCM）",
        }
    }
}

/// 本机的后端（编译期决定，运行时不再变）。
pub fn backend() -> Backend {
    #[cfg(target_os = "windows")]
    {
        Backend::WindowsDpapi
    }
    #[cfg(target_os = "android")]
    {
        Backend::AndroidKeystore
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        Backend::None
    }
}

/// 这个字符串是不是信封（`gsk1.<后端>.<载荷>`）。
///
/// 判据刻意严格：前缀 + 恰好三段 + 载荷非空。少一段的（比如手抄错的）当**不是**信封，
/// 于是走「旧格式明文」那条路 —— 但旧格式明文只可能是本机自己写的，不会凭空出现。
pub fn is_envelope(stored: &str) -> bool {
    let mut parts = stored.split('.');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(p), Some(b), Some(payload), None) => {
            p == ENVELOPE_PREFIX && !b.is_empty() && !payload.is_empty()
        }
        _ => false,
    }
}

/// 信封里的后端 id（不是信封 ⇒ `None`）。
pub fn envelope_backend(stored: &str) -> Option<&str> {
    if !is_envelope(stored) {
        return None;
    }
    stored.split('.').nth(1)
}

/// 把明文封进本机密钥库。
///
/// 返回 `Ok(None)` = **本机没有密钥库**（调用方保持原样，不要报错 ——
/// macOS 暂缓期间这就是正常路径）。
/// 返回 `Err` = 密钥库**用不了**（DPAPI 失败 / Keystore 不可用）⇒ 上抛，绝不回落明文。
pub fn seal_secret(plaintext: &str) -> Result<Option<String>, KeyStoreError> {
    match backend() {
        Backend::None => Ok(None),
        _ => Ok(Some(platform_seal(plaintext)?)),
    }
}

/// 本机后端的「封」那一步（**平台代码只碰这一层**）。
///
/// 拆成 cfg 化的独立函数，是为了让 `seal_secret`/`open_secret` 里**不出现**
/// `keystore_android::…` 这类只在某个平台存在的路径（跨平台编译时那半边根本不存在）。
#[cfg(target_os = "windows")]
fn platform_seal(plaintext: &str) -> Result<String, KeyStoreError> {
    seal_with(Backend::WindowsDpapi, dpapi::protect, plaintext)
}

#[cfg(target_os = "android")]
fn platform_seal(plaintext: &str) -> Result<String, KeyStoreError> {
    seal_with(Backend::AndroidKeystore, keystore_android::seal, plaintext)
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn platform_seal(plaintext: &str) -> Result<String, KeyStoreError> {
    // 本机没有密钥库时这条路**不会被走到**（`seal_secret` 先判 `backend() == None` 就返回
    // `Ok(None)`）。仍然把它写成「走同一条封装」而不是另写一份，是为了让 `seal_with`
    // 在每个平台都有调用点 —— 否则它在 mac 上会被判死代码（而它恰恰是跨平台判据的主体）。
    seal_with(
        Backend::None,
        |_| Err(KeyStoreError::Backend("本机没有系统密钥库".into())),
        plaintext,
    )
}

/// 本机后端的「开」那一步（见 `platform_seal` 的说明）。
#[cfg(target_os = "windows")]
fn platform_open(stored: &str) -> Result<String, KeyStoreError> {
    open_with(Backend::WindowsDpapi, dpapi::unprotect, stored)
}

#[cfg(target_os = "android")]
fn platform_open(stored: &str) -> Result<String, KeyStoreError> {
    open_with(Backend::AndroidKeystore, keystore_android::open, stored)
}

#[cfg(not(any(target_os = "windows", target_os = "android")))]
fn platform_open(stored: &str) -> Result<String, KeyStoreError> {
    // 同 `platform_seal`：本机没有密钥库时不会被走到（`open_secret` 自己判）。
    open_with(
        Backend::None,
        |_| Err(KeyStoreError::Backend("本机没有系统密钥库".into())),
        stored,
    )
}

/// 打开信封，拿回明文。
///
/// **不是信封**（旧格式明文）⇒ 原样返回（兼容既有数据）。
/// 是信封但后端与本机不符 ⇒ 报错（这份密钥是别的机器/别的系统封的，本机解不开）。
pub fn open_secret(stored: &str) -> Result<String, KeyStoreError> {
    if backend() == Backend::None {
        // 本机没有密钥库：只有「旧格式明文」才允许原样返回；
        // 任何信封在本机都解不开 ⇒ 报错（不回落明文）。
        if is_envelope(stored) {
            return Err(KeyStoreError::ForeignBackend {
                found: envelope_backend(stored).unwrap_or_default().to_string(),
                local: Backend::None.id().to_string(),
            });
        }
        return Ok(stored.to_string());
    }
    platform_open(stored)
}

/// 用给定后端封一份（**核心纯逻辑**：平台只提供加解密那一步）。
///
/// 拆成两个参数是为了让「封 → 开回来」这条往返**能在没有系统密钥库的机器上单测**
/// （测试注入一个假加密函数）—— 否则信封逻辑只能靠真机验。
fn seal_with(
    backend: Backend,
    cipher: impl Fn(&[u8]) -> Result<Vec<u8>, KeyStoreError>,
    plaintext: &str,
) -> Result<String, KeyStoreError> {
    let blob = cipher(plaintext.as_bytes())?;
    Ok(build_envelope(backend, &blob))
}

/// 用给定后端解一份（**核心纯逻辑**，见 `seal_with` 的说明）。
fn open_with(
    backend: Backend,
    cipher: impl Fn(&[u8]) -> Result<Vec<u8>, KeyStoreError>,
    stored: &str,
) -> Result<String, KeyStoreError> {
    if !is_envelope(stored) {
        // 旧格式明文：原样返回（兼容既有数据）。
        return Ok(stored.to_string());
    }
    let found = envelope_backend(stored).unwrap_or_default().to_string();
    let found_backend =
        Backend::from_id(&found).ok_or_else(|| KeyStoreError::UnknownBackend(found.clone()))?;
    if found_backend != backend {
        return Err(KeyStoreError::ForeignBackend {
            found,
            local: backend.id().to_string(),
        });
    }
    let payload_b64 = stored.split('.').nth(2).unwrap_or_default();
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|e| KeyStoreError::Malformed(format!("信封载荷不是合法 base64：{e}")))?;
    let plain = cipher(&payload)?;
    String::from_utf8(plain)
        .map_err(|_| KeyStoreError::Malformed("解开后不是合法 UTF-8（不是本模块写的信封）".into()))
}

/// 组装信封文本（纯逻辑，可单测）。
fn build_envelope(backend: Backend, payload: &[u8]) -> String {
    format!(
        "{ENVELOPE_PREFIX}.{}.{}",
        backend.id(),
        URL_SAFE_NO_PAD.encode(payload)
    )
}

/// 密钥库相关的错误。**每一条都对应「密钥库不可用」这一类**，绝不含降级语义。
#[derive(Debug)]
pub enum KeyStoreError {
    /// 本机没有这个后端（信封来自别的平台）。
    ForeignBackend { found: String, local: String },
    /// 信封里的后端 id 不认识（格式被改过或数据损坏）。
    UnknownBackend(String),
    /// 信封本身不合法（base64 解不开 / 解开后不是 UTF-8）。
    Malformed(String),
    /// 平台后端调用失败（DPAPI / Keystore 返回了错误）。
    Backend(String),
}

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyStoreError::ForeignBackend { found, local } => {
                // 人读的后端名（`label`）比 id 好懂：用户看到的是「Windows 凭据管理器」
                // 而不是「dpapi」。
                let found_label = Backend::from_id(found)
                    .map(|b| b.label())
                    .unwrap_or("未知后端");
                let local_label = Backend::from_id(local)
                    .map(|b| b.label())
                    .unwrap_or("未知后端");
                write!(
                    f,
                    "这份密钥由「{found_label}」封存，本机是「{local_label}」，解不开（请在本机重新绑定该应用）"
                )
            }
            KeyStoreError::UnknownBackend(id) => {
                write!(f, "不认识的后端「{id}」（信封格式被改过或数据损坏）")
            }
            KeyStoreError::Malformed(why) => write!(f, "密钥信封不合法：{why}"),
            KeyStoreError::Backend(why) => write!(f, "系统密钥库不可用：{why}"),
        }
    }
}

impl std::error::Error for KeyStoreError {}

#[cfg(test)]
mod tests;
