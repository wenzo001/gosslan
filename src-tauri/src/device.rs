//! 设备指纹：用机器码（MachineGuid / machine-id / IOPlatformUUID）生成稳定的设备 ID。
//! 同一台电脑重启后仍是同一 ID，从而在“无登录”前提下识别同一用户。

use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 由硬件指纹派生的稳定设备 ID（取哈希前 16 位）。
/// 无法获取机器码时返回 None，由上层回退为持久化的 UUID。
///
/// 移动端（Android/iOS）无机器码概念，且 `machine-uid` 上游不支持移动目标，
/// 故直接返回 None，由 `state.rs` 用持久化 UUID / 主机名指纹兜底。
#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn hardware_fingerprint() -> Option<String> {
    None
}

/// 桌面端实现：MachineGuid / machine-id / IOPlatformUUID。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn hardware_fingerprint() -> Option<String> {
    // machine-uid 0.5 不支持 Android（其 `machine_id` 模块无 android 分支），
    // 故该依赖仅对非 Android 目标引入（见 Cargo.toml），Android 上直接返回 None，
    // 由 state.rs 回退到持久化的 device_id / 主机名指纹。
    #[cfg(target_os = "android")]
    {
        return None;
    }

    #[cfg(not(target_os = "android"))]
    {
        let uid = machine_uid::get().ok()?;
        let uid = uid.trim();
        if uid.is_empty() {
            return None;
        }
        let mut h = Sha256::new();
        h.update(b"gosslan-machine:");
        h.update(uid.as_bytes());
        Some(format!("gosslan-{}", &hex(&h.finalize())[..16]))
    }
}

/// 回退：基于主机名派生（稳定性弱于机器码，仅作兜底）。
pub fn hostname_fingerprint() -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut h = Sha256::new();
    h.update(b"gosslan-host:");
    h.update(host.as_bytes());
    format!("gosslan-{}", &hex(&h.finalize())[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_has_prefix() {
        if let Some(id) = hardware_fingerprint() {
            assert!(id.starts_with("gosslan-"));
            assert_eq!(id.len(), 24); // "gosslan-" + 16 hex
        }
    }

    /// **所有派生路径都必须产出同一个前缀**（真机 2026-09-13 第七轮）。
    ///
    /// 真机证据：安卓的 device_id 是 `dev-gosslan-f3d6b7dddf73aab2`，而 Mac/Windows 是
    /// `gosslan-…`。原因是 `state.rs` 的兜底路径又套了一层 `dev-` 前缀
    /// （`format!("dev-{}", hostname_fingerprint())`），而 `hostname_fingerprint()`
    /// **本身已经带前缀**。后果不只是难看：`'d' < 'g'` 让安卓**在三端里恒为最小 id**，
    /// 而镜像规则是「大 id 拨、小 id 只接受」⇒ **安卓永远不主动拨任何人**。
    ///
    /// 这条护栏把"前缀只有一个"钉死：任何人再套一层前缀都会立刻 FAIL。
    #[test]
    fn every_fingerprint_path_shares_one_prefix() {
        let host = hostname_fingerprint();
        assert!(
            host.starts_with("gosslan-"),
            "主机名兜底也必须带 gosslan- 前缀，实际：{host}"
        );
        assert!(
            !host.starts_with("dev-"),
            "不许再套 dev- 前缀 —— 那会让设备 id 的排序恒为最小、永远不主动拨号：{host}"
        );
        assert_eq!(host.len(), 24, "兜底指纹长度必须与机器码路径一致：{host}");
        // 单测里拿不到机器码时（CI/容器）也要满足同一形状
        if let Some(hw) = hardware_fingerprint() {
            assert_eq!(
                hw.len(),
                host.len(),
                "机器码路径与主机名兜底路径的 id 长度必须一致，否则前缀约定会被打断"
            );
        }
    }
}
