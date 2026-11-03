//! Windows 桌面快捷方式**一次性对账**（5.16.95 回归：桌面上同时存在
//! `Gosslan.lnk` 与 `小院儿.lnk`）。
//!
//! ## 为什么会多出一个
//!
//! 安装器钩子（`src-tauri/nsis/hooks.nsh`）的 `NSIS_HOOK_POSTINSTALL` 只把**已经存在**的
//! 快捷方式改名；而官方模板的图形完成页（`MUI_FINISHPAGE_SHOWREADME` →
//! `CreateOrUpdateDesktopShortcut`）是在 POSTINSTALL **之后**才 `CreateShortcut`
//! `$DESKTOP\${PRODUCTNAME}.lnk`。所以「先有一份旧 `Gosslan.lnk`」的机器上，
//! 钩子把它改成小院儿，完成页又新建了一份 `Gosslan.lnk` ⇒ 两份都在。
//! （已核实 tauri 2.12.x 模板：`CreateOrUpdateDesktopShortcut` 在完成页回调里，
//! 静默/被动安装才在 POSTINSTALL 之前调用。）
//!
//! 本次修复分两层：
//! 1. 安装器：钩子里在“确实改到了桌面那一份”时置 `$NoShortcutMode = 1`，完成页便不再新建；
//! 2. 应用首次启动：本模块做一次对账，处理**已经**装出两份的机器（以及别的历史残留）。
//!
//! ## 只动“能证明是自己的”那一份
//!
//! 硬约束：**两个文件都存在，且两个 `.lnk` 的目标都等于当前进程的 exe** 才删旧名那份。
//! 只要有一个目标读不出来、或指向别的程序，就原样保留（宁可少做，绝不误删用户自建）。
//!
//! ## 失败不反复扫盘
//!
//! 尝试记录写在 settings 表里（键 [`MARKER_KEY`]，值为**当前版本号**），并且**先记再扫**：
//! 同一版本内无论成功失败都只扫一次；升级到新版本才允许再试一次。这样既不会每次启动
//! 都碰桌面目录，也不会让未来一次安装器的边界回归永远失去自愈机会。
//!
//! ## 平台
//!
//! `.lnk` 解析是纯函数（MS-SHLLINK），在 macOS 上也跑单测；真正碰桌面目录的
//! [`reconcile_once`] 只在 Windows 编译。

#[cfg(windows)]
use std::path::Path;

/// 旧版（锚点名）快捷方式文件名。
#[cfg(windows)]
const LEGACY_STEM: &str = "Gosslan";
/// 本地化快捷方式文件名。与 `src-tauri/nsis/zh-CN.nsh` 的 `appShortcutName` 保持一致；
/// 英文语言包里两者同名，因此只有中文场景会同时出现两份。
#[cfg(windows)]
const LOCALIZED_STEM: &str = "小院儿";

/// “本版本已尝试过对账”的 settings 键。
#[cfg(windows)]
pub const MARKER_KEY: &str = "win_shortcut_reconcile_version";

/// `ShellLinkHeader` 固定长度（MS-SHLLINK 2.1）。
const HEADER_SIZE: usize = 0x4C;
/// `{00021401-0000-0000-C000-000000000046}`（小端字节序）。
const LINK_CLSID: [u8; 16] = [
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];
/// `HasLinkTargetIDList`：头后先跟一个 IDList（要按它的长度跳过）。
const FLAG_HAS_ID_LIST: u32 = 0x0000_0001;
/// `HasLinkInfo`：头后（或 IDList 之后）跟 `LinkInfo` 结构。
const FLAG_HAS_LINK_INFO: u32 = 0x0000_0002;
/// `VolumeIDAndLocalBasePath`：`LinkInfo` 里带本地目标路径。
const LINK_INFO_LOCAL_PATH: u32 = 0x0000_0001;

/// 从 `.lnk` 字节里读出目标路径（读不出就返回 `None`，调用方据此“保留不动”）。
///
/// 只认 `LinkInfo` 的本地路径。`LinkTargetIDList`（shell item ID）解析复杂且容易把
/// 目录项误当成最终目标，所以这里**不用它**；拿不到可证明的目标就不删，符合硬约束。
pub fn parse_target_path(bytes: &[u8]) -> Option<String> {
    if bytes.len() < HEADER_SIZE {
        return None;
    }
    let header_size = u32::from_le_bytes(bytes[0..4].try_into().ok()?) as usize;
    if header_size != HEADER_SIZE {
        return None;
    }
    if bytes[4..20] != LINK_CLSID {
        return None;
    }
    let flags = read_u32(bytes, 0x14)?;
    if flags & FLAG_HAS_LINK_INFO == 0 {
        return None;
    }

    let mut pos = HEADER_SIZE;
    if flags & FLAG_HAS_ID_LIST != 0 {
        let id_list_size = u16::from_le_bytes(bytes.get(pos..pos + 2)?.try_into().ok()?) as usize;
        pos = pos.checked_add(2)?.checked_add(id_list_size)?;
    }
    if pos >= bytes.len() {
        return None;
    }
    parse_link_info(bytes, pos)
}

/// 解析 `LinkInfo` 结构里的本地目标路径（ANSI / Unicode 两种偏移都支持）。
fn parse_link_info(bytes: &[u8], base: usize) -> Option<String> {
    let size = read_u32(bytes, base)? as usize;
    let header_size = read_u32(bytes, base + 4)? as usize;
    let flags = read_u32(bytes, base + 8)?;
    if size == 0 || size > bytes.len().checked_sub(base)? {
        return None;
    }
    if flags & LINK_INFO_LOCAL_PATH == 0 {
        return None;
    }
    let local_ansi = read_u32(bytes, base + 16)? as usize;
    // LinkInfoHeaderSize >= 0x24 时才存在 Unicode 偏移（MS-SHLLINK 2.2）。
    let local_unicode = if header_size >= 0x24 {
        read_u32(bytes, base + 28)? as usize
    } else {
        0
    };

    if local_unicode != 0 {
        if let Some(s) = read_utf16z(bytes, base, size, local_unicode) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    if local_ansi != 0 {
        if let Some(s) = read_ansiz(bytes, base, size, local_ansi) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    Some(u32::from_le_bytes(bytes.get(at..end)?.try_into().ok()?))
}

/// 读 `base + offset` 起、以 NUL 结尾的 ANSI 串（按 Windows ANSI 近似为 Latin-1；
/// 本应用路径是 ASCII，非 ASCII 也只影响“不相等 ⇒ 不删”，不会误删）。
fn read_ansiz(bytes: &[u8], base: usize, link_info_size: usize, offset: usize) -> Option<String> {
    if offset >= link_info_size {
        return None;
    }
    let start = base.checked_add(offset)?;
    let end = base.checked_add(link_info_size)?;
    let slice = bytes.get(start..end)?;
    let nul = slice.iter().position(|&b| b == 0)?;
    let raw = &slice[..nul];
    if raw.is_empty() {
        return None;
    }
    Some(raw.iter().map(|&b| b as char).collect())
}

/// 读 `base + offset` 起、以 UTF-16LE NUL 结尾的串。
fn read_utf16z(bytes: &[u8], base: usize, link_info_size: usize, offset: usize) -> Option<String> {
    if offset >= link_info_size {
        return None;
    }
    let start = base.checked_add(offset)?;
    let end = base.checked_add(link_info_size)?;
    let slice = bytes.get(start..end)?;
    if slice.len() < 2 {
        return None;
    }
    let mut units = Vec::new();
    for chunk in slice.chunks_exact(2) {
        let unit = u16::from_le_bytes([chunk[0], chunk[1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    if units.is_empty() {
        return None;
    }
    Some(String::from_utf16_lossy(&units))
}

/// Windows 路径比较用的规范化：去首尾空白、`/`→`\`、去掉扩展长度前缀与末尾分隔符。
fn normalize_for_compare(path: &str) -> String {
    let trimmed = path.trim();
    let trimmed = trimmed.strip_prefix("\\\\?\\").unwrap_or(trimmed);
    trimmed
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_string()
}

/// 目标路径是否就是当前 exe。
///
/// Windows 文件系统大小写不敏感 ⇒ 用 ASCII 大小写不敏感比较（非 ASCII 字节原样比较，
/// 中文目录名不会因大小写被误判）；不做 canonicalize，因为目标文件可能已被移动/删除，
/// 而“路径对不上”正是这里要保留的保守结果。
pub fn path_eq(a: &str, b: &str) -> bool {
    normalize_for_compare(a).eq_ignore_ascii_case(&normalize_for_compare(b))
}

/// 对账判据：**旧名存在且两个目标都可证明等于当前 exe** 才删旧名。
///
/// `localized_target` 为 `None` 同时覆盖“新名不存在”与“新名目标读不出”两种情形 ——
/// 两种都必须保留，不能靠猜测。
pub fn should_remove_legacy(
    legacy_exists: bool,
    legacy_target: Option<&str>,
    localized_target: Option<&str>,
    current_exe: &str,
) -> bool {
    if !legacy_exists {
        return false;
    }
    let Some(legacy) = legacy_target else {
        return false;
    };
    let Some(localized) = localized_target else {
        return false;
    };
    path_eq(legacy, current_exe) && path_eq(localized, current_exe)
}

/// 这个版本是否还没对账过（`stored` 是上次写下的版本号）。
pub fn needs_attempt(stored: Option<&str>, current_version: &str) -> bool {
    stored != Some(current_version)
}

/// 读 `.lnk` 的目标（文件不存在 / 读失败 / 解析失败都返回 `None`）。
#[cfg(windows)]
fn target_of(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    parse_target_path(&bytes)
}

/// 桌面快捷方式一次性对账（Windows；由 `finish_boot` 调用）。
///
/// 无论成功、无可做、还是失败，都会把“当前版本已尝试”写进 settings —— 同一个版本内
/// 不再第二次碰桌面目录。
#[cfg(windows)]
pub fn reconcile_once(app: &tauri::AppHandle, state: &crate::state::AppState) {
    use tauri::Manager as _;

    let version = env!("CARGO_PKG_VERSION");
    let should_try = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let stored = crate::db::get_setting(&conn, MARKER_KEY);
        needs_attempt(stored.as_deref(), version)
    };
    if !should_try {
        return;
    }
    // 先记“已尝试”再扫盘：崩溃或失败也不会让下一次启动反复扫。
    {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = crate::db::set_setting(&conn, MARKER_KEY, version) {
            state.logger.warn(
                "win_shortcut",
                format!("code=WIN_SHORTCUT_MARKER_FAILED 记录对账尝试失败，本轮不对账：{e}"),
            );
            return;
        }
    }

    let desktop = match app.path().desktop_dir() {
        Ok(dir) => dir,
        Err(e) => {
            state.logger.warn(
                "win_shortcut",
                format!("code=WIN_SHORTCUT_NO_DESKTOP 取桌面目录失败，跳过：{e}"),
            );
            return;
        }
    };
    let current_exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            state.logger.warn(
                "win_shortcut",
                format!("code=WIN_SHORTCUT_NO_EXE 取当前 exe 失败，跳过：{e}"),
            );
            return;
        }
    };

    let legacy = desktop.join(format!("{LEGACY_STEM}.lnk"));
    let localized = desktop.join(format!("{LOCALIZED_STEM}.lnk"));
    let legacy_exists = legacy.is_file();
    let localized_exists = localized.is_file();
    let legacy_target = if legacy_exists {
        target_of(&legacy)
    } else {
        None
    };
    let localized_target = if localized_exists {
        target_of(&localized)
    } else {
        None
    };

    if should_remove_legacy(
        legacy_exists,
        legacy_target.as_deref(),
        localized_target.as_deref(),
        &current_exe,
    ) {
        match std::fs::remove_file(&legacy) {
            Ok(()) => state.logger.info(
                "win_shortcut",
                format!(
                    "code=WIN_SHORTCUT_REMOVED 已删除重复的旧快捷方式 {}（目标与新名一致：{current_exe}）",
                    legacy.display()
                ),
            ),
            Err(e) => state.logger.warn(
                "win_shortcut",
                format!(
                    "code=WIN_SHORTCUT_REMOVE_FAILED 删除 {} 失败（本版本不再重试）：{e}",
                    legacy.display()
                ),
            ),
        }
    } else if legacy_exists && localized_exists {
        // 两份都在但对不上目标：**保留**，只留一行取证，方便下次按日志判断。
        state.logger.info(
            "win_shortcut",
            format!(
                "code=WIN_SHORTCUT_KEEP_UNVERIFIED 桌面同时存在旧名与新名，但目标无法确认为当前 exe ⇒ 保留。legacy={:?} localized={:?} current={current_exe}",
                legacy_target, localized_target
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一份最小可解析的 `.lnk`（只含 Header + LinkInfo）。
    fn make_lnk(target: &str, with_unicode: bool) -> Vec<u8> {
        let mut out = vec![0u8; HEADER_SIZE];
        out[0..4].copy_from_slice(&(HEADER_SIZE as u32).to_le_bytes());
        out[4..20].copy_from_slice(&LINK_CLSID);
        out[0x14..0x18].copy_from_slice(&FLAG_HAS_LINK_INFO.to_le_bytes());

        let ansi = target.as_bytes();
        let header_size: u32 = if with_unicode { 0x24 } else { 0x1C };
        let local_ansi_off = header_size as usize;
        let mut link_info = vec![0u8; header_size as usize];
        link_info[4..8].copy_from_slice(&header_size.to_le_bytes());
        link_info[8..12].copy_from_slice(&LINK_INFO_LOCAL_PATH.to_le_bytes());
        link_info[16..20].copy_from_slice(&(local_ansi_off as u32).to_le_bytes());
        link_info.extend_from_slice(ansi);
        link_info.push(0);
        if with_unicode {
            let unicode_off = link_info.len();
            link_info[28..32].copy_from_slice(&(unicode_off as u32).to_le_bytes());
            for unit in target.encode_utf16() {
                link_info.extend_from_slice(&unit.to_le_bytes());
            }
            link_info.extend_from_slice(&0u16.to_le_bytes());
        }
        let size = link_info.len() as u32;
        link_info[0..4].copy_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&link_info);
        out
    }

    #[test]
    fn parses_ansi_target() {
        let lnk = make_lnk(r"C:\Program Files\Gosslan\gosslan.exe", false);
        assert_eq!(
            parse_target_path(&lnk).as_deref(),
            Some(r"C:\Program Files\Gosslan\gosslan.exe")
        );
    }

    #[test]
    fn prefers_unicode_target() {
        // ANSI 段与 Unicode 段写不同路径 ⇒ 必须优先取 Unicode。
        let mut lnk = make_lnk(r"C:\wrong\gosslan.exe", true);
        let unicode_target = r"C:\Other\gosslan.exe";
        let off = u32::from_le_bytes(lnk[HEADER_SIZE + 28..HEADER_SIZE + 32].try_into().unwrap())
            as usize;
        let start = HEADER_SIZE + off;
        for (i, unit) in unicode_target.encode_utf16().enumerate() {
            let at = start + i * 2;
            lnk[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        let nul = start + unicode_target.encode_utf16().count() * 2;
        lnk[nul..nul + 2].copy_from_slice(&[0, 0]);
        assert_eq!(parse_target_path(&lnk).as_deref(), Some(unicode_target));
    }

    #[test]
    fn rejects_malformed_lnk() {
        assert_eq!(parse_target_path(&[]), None);
        assert_eq!(parse_target_path(&[0u8; 10]), None);
        let mut bad = make_lnk(r"C:\x\gosslan.exe", false);
        bad[4] = 0; // 破坏 CLSID
        assert_eq!(parse_target_path(&bad), None);
        // 截断 LinkInfo：只剩头。
        let truncated = &make_lnk(r"C:\x\gosslan.exe", false)[..HEADER_SIZE + 4];
        assert_eq!(parse_target_path(truncated), None);
    }

    #[test]
    fn rejects_lnk_without_link_info() {
        let mut lnk = make_lnk(r"C:\x\gosslan.exe", false);
        lnk[0x14..0x18].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_target_path(&lnk), None);
    }

    #[test]
    fn removes_only_when_both_targets_match_current_exe() {
        let exe = r"C:\Program Files\Gosslan\gosslan.exe";
        assert!(should_remove_legacy(true, Some(exe), Some(exe), exe));
        assert!(
            should_remove_legacy(
                true,
                Some(r"c:/program files/gosslan/gosslan.exe\"),
                Some(exe),
                exe
            ),
            "大小写/斜杠/末尾分隔符差异应按 Windows 语义视为同一路径"
        );
        assert!(
            !should_remove_legacy(true, Some(exe), None, exe),
            "新名不存在"
        );
        assert!(
            !should_remove_legacy(false, None, Some(exe), exe),
            "旧名不存在"
        );
        assert!(
            !should_remove_legacy(true, Some(exe), Some(r"C:\Other\app.exe"), exe),
            "新名目标不是当前 exe"
        );
        assert!(
            !should_remove_legacy(true, Some(r"C:\Other\app.exe"), Some(exe), exe),
            "旧名目标不是当前 exe（可能是用户自建）"
        );
        assert!(
            !should_remove_legacy(true, None, Some(exe), exe),
            "旧名目标读不出 ⇒ 不删"
        );
    }

    #[test]
    fn windows_path_comparison_is_case_and_separator_insensitive() {
        assert!(path_eq(r"C:\A\Gosslan.EXE", r"C:\a\gosslan.exe"));
        assert!(path_eq(r"C:/A/gosslan.exe", r"C:\a\gosslan.exe"));
        assert!(path_eq(r"\\?\C:\A\gosslan.exe", r"C:\a\gosslan.exe"));
        assert!(!path_eq(r"C:\A\gosslan.exe", r"C:\B\gosslan.exe"));
    }

    #[test]
    fn attempt_marker_is_once_per_version() {
        assert!(needs_attempt(None, "5.17.2"));
        assert!(
            !needs_attempt(Some("5.17.2"), "5.17.2"),
            "同版本失败也不再扫"
        );
        assert!(
            needs_attempt(Some("5.17.1"), "5.17.2"),
            "升级后允许再试一次"
        );
    }
}
