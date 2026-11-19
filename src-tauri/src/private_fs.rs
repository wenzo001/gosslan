//! 敏感文件与专用目录的 Unix 权限边界：文件只允许属主读写（`0600`），
//! 专用目录只允许属主进入（`0700`，新建时就直接带位，不等事后 chmod）。
//!
//! 真实安装实测：`gosslan.db`、`-wal` 与日志文件都是 `0644`，同机其他用户可读；
//! 库里存着身份密钥与全部消息，日志里有 peer id、IP 与文件名。数据库、侧车、
//! 迁移备份与日志/崩溃现场统一走这里，避免每个写文件的地方各写一份 chmod。
//!
//! 失败只告警、不阻断：某些文件系统不支持 POSIX 权限，启动可用性优先；
//! 正常磁盘上由各模块的判据保证成功（`db::migration_tests` 与 `logging::tests`）。
//!
//! ── 这里为什么还放「文件名规则」 ────────────────────────────────────────
//!
//! 同一条纪律：**平台差异不许漏给用户**。Windows 的文件名规则比 Unix 严得多
//! （非法字符 / 保留设备名 / 不能以点或空格结尾），而落盘的地方有两条来路
//! （对端发来的协议名、系统选择器给的建议名）。规则只有这一份，
//! 两个来路各自按自己的语义调用它（拒绝式 / 改写式），**规则本身不复制**。

// ---------------- 文件名的平台规则 ----------------

/// Windows 保留设备名（**带扩展名照样保留**：`CON.txt` 在 Windows 上也打不开）。
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Windows 名字里非法的字符：`< > : " / \ | ? *`。
const WINDOWS_ILLEGAL_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 这个名字在 **Windows** 上根本落不了盘吗？
///
/// 三类硬伤（Windows 官方命名规则）：
/// 1. 非法字符：`< > : " / \ | ? *` 与 0x00–0x1F 控制字符；
/// 2. 保留设备名：`CON` `PRN` `AUX` `NUL` `COM1..9` `LPT1..9`；
/// 3. 以空格或点结尾（Windows 会悄悄剥掉 ⇒ 落盘名与界面显示的名字对不上）。
///
/// ⚠️ 判据是**纯逻辑**（`windows_rules` 是参数）：这样 macOS/Linux 上也能测
/// Windows 的规则，不必等一台 Windows 机器。
pub(crate) fn unusable_on_windows(name: &str, windows_rules: bool) -> bool {
    if !windows_rules {
        return false;
    }
    if name.is_empty() {
        return true;
    }
    // ① 非法字符（含控制字符）
    if name
        .chars()
        .any(|c| WINDOWS_ILLEGAL_CHARS.contains(&c) || (c as u32) < 0x20)
    {
        return true;
    }
    // ② 保留设备名（取扩展名前那段；`CON.txt` 与 `CON` 同样保留）。
    //    Windows 会先剥掉点前的空格再判定 ⇒ `CON .txt` 也是保留名。这里同步剥掉 stem
    //    结尾的空格/点，与 rewrite_with_platform_rules 的 trim 口径一致（W14）。
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if WINDOWS_RESERVED_NAMES.contains(&stem.as_str()) {
        return true;
    }
    // ③ 结尾是空格或点
    name.ends_with(' ') || name.ends_with('.')
}

/// 把一个名字改写成本机**一定落得了盘**的样子（`windows_rules` 为真时按 Windows 规则）。
///
/// 返回 `None` 表示改写后仍然没法用（空名、只剩 `.`/`..`）。
///
/// 改写而不是拒绝，是为了**平台差异对用户无感**：对端发来 `报告:终稿.txt`，
/// macOS/Linux 本来就能收，Windows 上把 `:` 换成 `_` 照样收 —— 而不是让
/// 「只有 Windows 用户」整单接收失败。
pub(crate) fn rewrite_with_platform_rules(name: &str, windows_rules: bool) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    if !windows_rules {
        // Unix/macOS：只有「空/纯点」这两种真的没法用。
        if name == "." || name == ".." {
            return None;
        }
        return Some(name.to_string());
    }
    // ① 非法字符 → `_`（目录分隔符也在这里一并处理）
    let cleaned: String = name
        .chars()
        .map(|c| {
            if WINDOWS_ILLEGAL_CHARS.contains(&c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    // ② 剥掉结尾的点与空格（Windows 自己会剥 ⇒ 不剥就会出现「显示名 ≠ 落盘名」）
    let trimmed = cleaned.trim_end().trim_end_matches('.').to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    // ③ 保留设备名 → 加前缀（`CON.txt` → `_CON.txt`，扩展名保留）
    let (stem, ext) = match trimmed.split_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (trimmed.clone(), String::new()),
    };
    if WINDOWS_RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str()) {
        return Some(format!("_{stem}{ext}"));
    }
    // 不变式自证：改写完的名字必须**本机一定落得了盘**（这条判据就是它的定义）。
    debug_assert!(
        !unusable_on_windows(&trimmed, windows_rules),
        "改写后的名字仍不可用：{trimmed}"
    );
    Some(trimmed)
}

/// 按**本机**规则改写文件名（Windows 用 Windows 规则，其余平台原样）。
pub(crate) fn rewrite_for_local_platform(name: &str) -> Option<String> {
    rewrite_with_platform_rules(name, cfg!(target_os = "windows"))
}

/// 这个条目在本机算不算「隐藏」——**按名字**判（各平台都认的隐藏习惯：点前缀）。
///
/// 点前缀那条在所有平台都保留：它是各平台都认的隐藏习惯，且跳过它更保守。
pub(crate) fn is_hidden_by_name(name: &str) -> bool {
    name.starts_with('.')
}

/// 这个条目在本机算不算「隐藏」——**按文件属性**判。
///
/// - Windows：文件属性里的 `FILE_ATTRIBUTE_HIDDEN` 位（用户在资源管理器里勾了「隐藏」）。
/// - 其余平台：没有这个概念 ⇒ 恒 false。
///
/// ⚠️ 只按名字判 ⇒ Windows 用户勾了「隐藏」的文件照样进共享目录树**发给对端**
/// ⇒ 同一份共享目录在两个平台的暴露面不同（这是往别的设备**泄数据**，不是功能差异）。
#[cfg(target_os = "windows")]
pub(crate) fn is_hidden_by_attributes(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn is_hidden_by_attributes(_meta: &std::fs::Metadata) -> bool {
    false
}

// ⚠️ 上面那两个「隐藏」判定刻意**分开**而不是收成一个 `Option<&Metadata>` 的入口：
// 收成一个入口就得在调用点构造那个 `Option` ⇒ 只能写 `.ok()`（本仓的静默丢弃形状，
// `check-silent-drops.mjs` 棘轮只许降）或 `match { Ok(v) => Some(v), Err(_) => None }`
// （clippy 判 `manual_ok_err`）⇒ 两条门禁夹在一起时两边都不许写。
// 分开之后调用点是两个纯判断，零死角。

#[cfg(unix)]
pub(crate) fn restrict_to_owner(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if !path.exists() {
        return;
    }
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("[gosslan-fs] 无法把 {} 收紧到 0600：{e}", path.display());
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_to_owner(_path: &std::path::Path) {}

/// Unix：把**专用数据目录**收紧到仅属主可进入/列出（`0700`）。
///
/// 文件是 `0600` 只挡住读取，挡不住同机其他用户 `ls` 出备份名/日志名/实例库名。
/// 只允许在生产启动路径对解析出的 app data 目录调用；测试里的共享临时目录不要调。
#[cfg(unix)]
pub(crate) fn restrict_dir_to_owner(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if !path.is_dir() {
        return;
    }
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)) {
        eprintln!(
            "[gosslan-fs] 无法把目录 {} 收紧到 0700：{e}",
            path.display()
        );
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_dir_to_owner(_path: &std::path::Path) {}

/// 创建**私有目录**（Unix `0700`，其它平台交给各自的模型）。
///
/// 为什么不复用 `create_dir_all` + 事后 `restrict_dir_to_owner`：
/// `create_dir_all` 用的是进程 umask（真机实测 `022`），于是新建的 `logs/` 落地就是
/// `drwxr-xr-x` —— 从 mkdir 到 chmod 之间那段窗口里，同机其他用户已经能 `ls` 出
/// 日志文件名（里面带设备 id 与实例号）。`mkdir` 的 mode 参数只会被 umask **减**位，
/// `0o700` 在常见 umask（022/002/077）下原样生效。
///
/// ⚠️ 已存在的目录**不会被改写**（`recursive(true)` 撞到 EEXIST 就返回 Ok）。
/// 这是刻意的：`logging::tests::disk_write_failure_is_counted_and_noted_in_memory`
/// 靠"把目录调成不可写"来制造落盘失败，如果这里顺手 chmod 回去，那条判据的失败机制
/// 会被产品代码静默修好 ⇒ 变成空转。收紧**已存在**目录是 [`restrict_dir_to_owner`] 的活，
/// 只允许在启动路径上调用一次。
#[cfg(unix)]
pub(crate) fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

/// Windows：没有 POSIX mode 位。app data 落在 `%APPDATA%`（用户 profile 下），
/// 该树的 ACL 由系统只授给该用户与 SYSTEM，本来就等价于"仅当前用户可访问"；
/// 因此这里不做任何事，也不能拿 `0o700` 那套语义去"补"（`set_permissions` 在 Windows
/// 只影响只读位，改它反而会让用户以为权限被放开了）。
#[cfg(not(unix))]
pub(crate) fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)
}

#[cfg(test)]
mod tests {
    // ---------------- 文件名的平台规则（跨平台可测） ----------------

    /// Windows 的名字规则：**纯逻辑**，所以 macOS/Linux 上也能测 Windows 的那一套
    /// （不必等一台 Windows 机器 —— 真机上过一遍不够，CI 两条腿都要看得见）。
    #[test]
    fn windows_name_rules_reject_what_windows_cannot_create() {
        // ① 非法字符
        for name in [
            "报告:终稿.txt",
            "a*b.txt",
            "a?b.txt",
            "a|b.txt",
            "a<b.txt",
            "a>b.txt",
            "a\"b.txt",
        ] {
            assert!(
                super::unusable_on_windows(name, true),
                "{name} 在 Windows 上根本落不了盘（ERROR_INVALID_NAME）"
            );
            assert!(
                !super::unusable_on_windows(name, false),
                "Unix/macOS 上这些名字都能落盘 ⇒ 不许拦（平台差异不许漏给用户）"
            );
        }
        // ② 保留设备名（**带扩展名照样保留**：`CON.txt` 在 Windows 上也打不开）
        for name in [
            "CON",
            "con.txt",
            "PRN",
            "AUX",
            "NUL",
            "COM1",
            "com9.log",
            "LPT1",
            "CON .txt",
            "COM1 .log", // 点前空格：Windows 先剥空格再判保留名（W14）
        ] {
            assert!(
                super::unusable_on_windows(name, true),
                "{name} 是 Windows 保留设备名"
            );
        }
        // ③ 结尾是点或空格（Windows 会悄悄剥掉 ⇒ 落盘名与界面显示的名字对不上）
        for name in ["报告.", "报告 "] {
            assert!(super::unusable_on_windows(name, true), "{name} 结尾不合法");
        }
        // 反例：正常名字不许被误伤（判据必须拦得住真问题，也拦得住乱拦）
        for name in [
            "报告.txt",
            "a-b_c.png",
            "CON-cert.txt",
            "com10.txt",
            "文件 名.v2",
        ] {
            assert!(
                !super::unusable_on_windows(name, true),
                "{name} 是正常文件名，不许判成不可用"
            );
        }
    }

    /// 改写之后的名字必须**本机一定落得了盘**（这就是「平台差异对用户无感」的执行口径）。
    #[test]
    fn rewritten_name_is_always_usable_on_windows() {
        for name in ["报告:终稿.txt", "CON", "CON.txt", "a*b", "尾点.", "尾空格 "] {
            let fixed = super::rewrite_with_platform_rules(name, true)
                .unwrap_or_else(|| panic!("{name} 改写后不该为空"));
            assert!(
                !super::unusable_on_windows(&fixed, true),
                "改写后仍不可用：{name} → {fixed}"
            );
            assert!(
                !fixed.contains('/') && !fixed.contains('\\'),
                "改写后不能含分隔符：{fixed}"
            );
        }
        // 保留设备名加前缀，且**扩展名保留**（`_CON.txt` 仍能看出是什么文件）
        assert_eq!(
            super::rewrite_with_platform_rules("CON.txt", true).unwrap(),
            "_CON.txt"
        );
        // Unix/macOS 上原样返回（不许多余地改用户的文件名）
        assert_eq!(
            super::rewrite_with_platform_rules("报告:终稿.txt", false).unwrap(),
            "报告:终稿.txt"
        );
        // 真的没法用的（空名 / 纯点）⇒ None
        assert!(super::rewrite_with_platform_rules("", true).is_none());
        assert!(super::rewrite_with_platform_rules("..", false).is_none());
    }

    /// 点前缀在**所有平台**都算隐藏（各平台都认的习惯，且跳过它更保守）。
    #[test]
    fn dot_prefixed_names_are_hidden_on_every_platform() {
        assert!(super::is_hidden_by_name(".env"));
        assert!(!super::is_hidden_by_name("normal.txt"));
    }

    /// Windows 的「隐藏」是**文件属性位**，不是点前缀（2026-11-19 修）。
    ///
    /// ⚠️ 只测点前缀那条 = 没测到 Windows 的真实语义 ⇒ 共享目录树会把用户勾了「隐藏」
    /// 的文件**发给对端**（往别的设备泄数据）。这条真去设置隐藏属性位，
    /// 所以只有 Windows 那条腿跑它。
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_hidden_attribute_counts_as_hidden() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};

        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("secret.txt");
        std::fs::write(&path, b"x").unwrap();

        let meta = std::fs::metadata(&path).unwrap();
        assert!(!super::is_hidden_by_attributes(&meta), "普通文件不该算隐藏");

        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let ok = unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN) };
        assert_ne!(ok, 0, "SetFileAttributesW 失败（Windows 测试环境异常）");
        let meta = std::fs::metadata(&path).unwrap();
        assert!(
            super::is_hidden_by_attributes(&meta),
            "Windows 的隐藏属性位必须算隐藏（否则共享目录树会把它发给对端）"
        );
    }

    // ---------------- 权限（Unix） ----------------

    #[cfg(unix)]
    #[test]
    fn restrict_dir_to_owner_sets_0700() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::TempDir::new().unwrap();
        let dir = root.path().join("private");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        super::restrict_dir_to_owner(&dir);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700,
            "app data 目录必须收紧到 0700"
        );
    }

    /// `create_private_dir` 的两格必须分开证：**新建**时 mkdir 就带 0700，
    /// **已存在**时不许被改写（后一半是 `disk_write_failure_is_counted_and_noted_in_memory`
    /// 那条"目录调成只读"判据的生存前提）。只测前一半会放过一个"顺手 chmod 一切"的实现。
    #[cfg(unix)]
    #[test]
    fn create_private_dir_makes_0700_and_leaves_an_existing_dir_alone() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mode_of = |p: &std::path::Path| -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };

        // ① 新建：不等事后 chmod
        let fresh = root.join("logs");
        super::create_private_dir(&fresh).unwrap();
        assert_eq!(
            mode_of(&fresh),
            0o700,
            "新建的日志目录必须 0700（实测 {:o} ⇒ mode 没传进 mkdir）",
            mode_of(&fresh)
        );

        // ② 已存在：不许顺手改写
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o500)).unwrap();
        super::create_private_dir(&fresh).unwrap();
        assert_eq!(
            mode_of(&fresh),
            0o500,
            "已存在的目录不能被 create_private_dir 改回去，否则只读目录那条落盘失败判据会被静默修好"
        );
    }
}
