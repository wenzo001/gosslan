//! 安卓应用内升级：纯逻辑（清单解析、版本比较、ABI 选包、校验和）。
//!
//! 为什么单独一册：这些判据在**主机**上就能跑（`cargo test --lib`），
//! 而命令层 / JNI 桥只有 Android 目标才会编译。把容易写错的格式逻辑与平台胶水拆开，
//! 才能在 CI 的 mac/linux 上提前发现回归。

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// GitHub Release 的一个安装包资产。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// `sha256:<hex>` 里的 hex；缺失时为 `None`（此时拒绝安装，不跳过校验）。
    pub sha256: Option<String>,
}

/// 解析后的 Release。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    pub version: String,
    pub notes: Option<String>,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

#[derive(Debug, Deserialize)]
struct RawAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

/// Gitee 固定清单（`updates/latest.json`）的顶层结构。桌面平台会被忽略，
/// 只取 `android-*` 条目；桌面客户端读同一个文件时也不会看 Android 条目。
#[derive(Debug, Deserialize)]
struct RawFixedManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    platforms: HashMap<String, RawFixedPlatform>,
}

#[derive(Debug, Deserialize)]
struct RawFixedPlatform {
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: Option<String>,
}

/// GitHub Releases API 的返回体 → `ReleaseInfo`。
///
/// 不依赖 `semver`（它只对桌面目标声明）：版本合法性在这里只做最小校验，
/// 真正的“是否更新”由 [`version_is_newer`] 判断。
pub fn parse_release_json(json: &str) -> Result<ReleaseInfo, String> {
    let raw: RawRelease = serde_json::from_str(json)
        .map_err(|e| format!("code=ANDROID_UPDATE_MANIFEST：发布信息解析失败（{e}）"))?;
    let version = normalize_version(&raw.tag_name)
        .ok_or_else(|| "code=ANDROID_UPDATE_MANIFEST：发布信息缺少可解析的版本号".to_string())?;
    let assets = raw
        .assets
        .into_iter()
        .map(|a| ReleaseAsset {
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
            sha256: a.digest.as_deref().and_then(parse_digest),
        })
        .collect();
    Ok(ReleaseInfo {
        version,
        notes: raw.body,
        assets,
    })
}

/// Gitee 固定清单 → `ReleaseInfo`。
///
/// 只保留 `android-*` 平台；文件名从 url 末尾取（APK 文件名只含 `[A-Za-z0-9._-]`，
/// 不依赖百分号解码）。没有 Android 条目时返回错误 —— 调用方会退 GitHub，
/// 不会把“桌面清单”当成“没有安卓更新”。
pub fn parse_fixed_manifest(json: &str) -> Result<ReleaseInfo, String> {
    let raw: RawFixedManifest = serde_json::from_str(json)
        .map_err(|e| format!("code=ANDROID_UPDATE_MANIFEST：Gitee 清单解析失败（{e}）"))?;
    let version = normalize_version(&raw.version)
        .ok_or_else(|| "code=ANDROID_UPDATE_MANIFEST：Gitee 清单缺少可解析的版本号".to_string())?;
    let mut assets = Vec::new();
    for (platform, entry) in raw.platforms {
        if !platform.starts_with("android-") {
            continue;
        }
        let Some(name) = entry.url.rsplit('/').next().filter(|n| !n.is_empty()) else {
            continue;
        };
        assets.push(ReleaseAsset {
            name: name.to_string(),
            url: entry.url,
            size: entry.size,
            sha256: entry.sha256.as_deref().and_then(parse_digest),
        });
    }
    if assets.is_empty() {
        return Err("code=ANDROID_UPDATE_MANIFEST：Gitee 清单没有 Android 平台".to_string());
    }
    Ok(ReleaseInfo {
        version,
        notes: raw.notes,
        assets,
    })
}

/// `v5.18.2` → `5.18.2`；空串/只有 `v` 时返回 `None`。
pub fn normalize_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let stripped = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

/// 当前 ABI 对应的资产名片段。与 CI 的 APK 命名对齐。
pub fn abi_name() -> &'static str {
    #[cfg(target_arch = "aarch64")]
    {
        "arm64-v8a"
    }
    #[cfg(target_arch = "arm")]
    {
        "armeabi-v7a"
    }
    #[cfg(target_arch = "x86_64")]
    {
        "x86_64"
    }
    #[cfg(target_arch = "x86")]
    {
        "x86"
    }
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "x86_64",
        target_arch = "x86"
    )))]
    {
        "unknown"
    }
}

/// 在资产列表里挑出当前 ABI 的 APK（文件名必须以 `-{abi}-release.apk` 结尾）。
pub fn select_asset<'a>(assets: &'a [ReleaseAsset], abi: &str) -> Option<&'a ReleaseAsset> {
    let suffix = format!("-{abi}-release.apk");
    assets.iter().find(|a| a.name.ends_with(&suffix))
}

/// `sha256:<64 hex>` → 小写 hex；也接受裸的 64 位 hex。
pub fn parse_digest(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let hex = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// 校验和比较：大小写不敏感，但长度必须一致（防止前缀匹配式假通过）。
pub fn checksum_matches(expected: &str, actual: &str) -> bool {
    expected.len() == 64 && actual.len() == 64 && expected.eq_ignore_ascii_case(actual)
}

/// 候选版本是否**严格高于**当前版本。
///
/// 比较规则（只覆盖本仓的 `X.Y.Z` 与 `X.Y.Z-pre.N`）：
/// - 数字段逐段比较，缺省段视为 0；
/// - 正式版高于同号的预发布版；
/// - 两个预发布版按段字典序比较；
/// - **任一版本无法解析 → `false`**：宁可“不提示更新”，也不把畸形版本当升级。
pub fn version_is_newer(current: &str, candidate: &str) -> bool {
    match (parse_semver_like(current), parse_semver_like(candidate)) {
        (Some(a), Some(b)) => b > a,
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemverLike {
    core: (u64, u64, u64),
    pre: Option<Vec<String>>,
}

impl PartialOrd for SemverLike {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemverLike {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let core = self.core.cmp(&other.core);
        if core != std::cmp::Ordering::Equal {
            return core;
        }
        match (&self.pre, &other.pre) {
            (None, None) => std::cmp::Ordering::Equal,
            // 正式版 > 预发布版
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        }
    }
}

fn parse_semver_like(raw: &str) -> Option<SemverLike> {
    let value = normalize_version(raw)?;
    let (core_raw, pre_raw) = match value.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (value.as_str(), None),
    };
    let mut parts = core_raw.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let pre = pre_raw.map(|p| {
        if p.is_empty() {
            vec![]
        } else {
            p.split('.').map(|s| s.to_string()).collect()
        }
    });
    Some(SemverLike {
        core: (major, minor, patch),
        pre,
    })
}

/// 流式读取文件并算 sha256（小写 hex）。用于下载后的二次校验与单测。
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> String {
        let digest = "a".repeat(64);
        format!(
            r#"{{
                "tag_name": "v5.18.2",
                "body": "本次更新修复了若干问题",
                "assets": [
                    {{"name":"gosslan-5.18.2-arm64-v8a-release.apk","browser_download_url":"https://example.com/arm64.apk","size":123456,"digest":"sha256:{digest}"}},
                    {{"name":"gosslan-5.18.2-armeabi-v7a-release.apk","browser_download_url":"https://example.com/armv7.apk","size":98765,"digest":"sha256:{digest}"}},
                    {{"name":"latest.json","browser_download_url":"https://example.com/latest.json","size":200,"digest":null}}
                ]
            }}"#
        )
    }

    fn sample_fixed_json() -> String {
        let digest = "c".repeat(64);
        format!(
            r#"{{
                "version": "5.18.78",
                "notes": "本次更新修复了若干问题",
                "pub_date": "2026-01-01T00:00:00Z",
                "platforms": {{
                    "darwin-aarch64": {{"signature":"desktop-sig","url":"https://example.com/Gosslan-arm64.app.tar.gz"}},
                    "android-aarch64": {{"signature":"","url":"https://example.com/gosslan-5.18.78-arm64-v8a-release.apk","size":17521727,"sha256":"{digest}"}},
                    "android-armv7": {{"signature":"","url":"https://example.com/gosslan-5.18.78-armeabi-v7a-release.apk","size":13066897,"sha256":"{digest}"}}
                }}
            }}"#
        )
    }

    #[test]
    fn fixed_manifest_keeps_android_platforms_only() {
        let release = parse_fixed_manifest(&sample_fixed_json()).unwrap();
        assert_eq!(release.version, "5.18.78");
        assert_eq!(release.notes.as_deref(), Some("本次更新修复了若干问题"));
        assert_eq!(release.assets.len(), 2);
        let arm64 = release
            .assets
            .iter()
            .find(|a| a.name.ends_with("-arm64-v8a-release.apk"))
            .unwrap();
        assert_eq!(arm64.size, 17521727);
        assert_eq!(arm64.sha256.as_deref(), Some("c".repeat(64).as_str()));
        assert_eq!(
            select_asset(&release.assets, "arm64-v8a").unwrap().size,
            17521727
        );
        assert!(select_asset(&release.assets, "x86_64").is_none());
    }

    #[test]
    fn fixed_manifest_requires_version_and_android_entries() {
        assert!(parse_fixed_manifest(r#"{"platforms":{}}"#).is_err());
        assert!(parse_fixed_manifest(
            r#"{"version":"5.18.78","platforms":{"darwin-aarch64":{"url":"https://example.com/a"}}}"#
        )
        .is_err());
        assert!(parse_fixed_manifest("not json").is_err());
    }

    #[test]
    fn fixed_manifest_without_sha256_is_rejected_later() {
        let release = parse_fixed_manifest(
            r#"{"version":"5.18.78","platforms":{"android-aarch64":{"url":"https://example.com/a.apk","size":1}}}"#,
        )
        .unwrap();
        assert!(release.assets[0].sha256.is_none());
        assert_eq!(release.assets[0].size, 1);
    }

    #[test]
    fn parse_release_reads_version_notes_and_digest() {
        let release = parse_release_json(&sample_json()).unwrap();
        assert_eq!(release.version, "5.18.2");
        assert_eq!(release.notes.as_deref(), Some("本次更新修复了若干问题"));
        assert_eq!(release.assets.len(), 3);
        assert_eq!(release.assets[0].size, 123456);
        assert_eq!(
            release.assets[0].sha256.as_deref(),
            Some("a".repeat(64).as_str())
        );
        assert!(release.assets[2].sha256.is_none());
    }

    #[test]
    fn select_asset_matches_abi_suffix_only() {
        let release = parse_release_json(&sample_json()).unwrap();
        let arm64 = select_asset(&release.assets, "arm64-v8a").unwrap();
        assert_eq!(arm64.name, "gosslan-5.18.2-arm64-v8a-release.apk");
        let armv7 = select_asset(&release.assets, "armeabi-v7a").unwrap();
        assert_eq!(armv7.name, "gosslan-5.18.2-armeabi-v7a-release.apk");
        assert!(select_asset(&release.assets, "x86_64").is_none());
    }

    #[test]
    fn parse_digest_rejects_wrong_length_and_non_hex() {
        assert_eq!(
            parse_digest(&format!("sha256:{}", "A".repeat(64))).unwrap(),
            "a".repeat(64)
        );
        assert_eq!(parse_digest(&"b".repeat(64)).unwrap(), "b".repeat(64));
        assert!(parse_digest("sha256:abc").is_none());
        assert!(parse_digest(&format!("sha256:{}", "z".repeat(64))).is_none());
    }

    #[test]
    fn version_comparison_is_strict_and_fails_closed() {
        assert!(version_is_newer("5.18.1", "5.18.2"));
        assert!(version_is_newer("v5.18.1", "5.18.2"));
        assert!(version_is_newer("5.18", "5.18.1"));
        assert!(!version_is_newer("5.18.2", "5.18.2"));
        assert!(!version_is_newer("5.18.2", "5.18.1"));
        assert!(!version_is_newer("5.18.2", "v5.18.2-beta.1"));
        assert!(version_is_newer("5.18.2-beta.1", "5.18.2"));
        assert!(!version_is_newer("not-a-version", "5.18.2"));
        assert!(!version_is_newer("5.18.1", "banana"));
    }

    #[test]
    fn checksum_comparison_is_case_insensitive_but_length_strict() {
        assert!(checksum_matches(&"a".repeat(64), &"A".repeat(64)));
        assert!(!checksum_matches(&"a".repeat(64), &"a".repeat(63)));
        assert!(!checksum_matches(
            &"a".repeat(64),
            &format!("{}b", "a".repeat(63))
        ));
    }

    #[test]
    fn sha256_file_matches_known_digest_and_detects_content() {
        let dir = std::env::temp_dir().join(format!(
            "gosslan-android-core-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::write(&path, b"abcd").unwrap();
        assert_ne!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
