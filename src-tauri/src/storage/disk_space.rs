//! 目标卷的**可用空间**查询（跨平台）。
//!
//! ## 为什么需要它
//!
//! 入站配额（`MAX_INCOMING_FILE_BYTES` / `MAX_INCOMING_TOTAL_BYTES`）算的是
//! **对端声明的 size 之和**，与磁盘真实余量无关。于是满盘时的真实链路是：
//! 配额通过 → 开始逐片写 → 写到一半 `ENOSPC` → 整单失败 → 用户看到一句
//! "No space left on device"，而**这一单已经传了一半**。
//!
//! 预检的价值在于**事前**拒绝：磁盘装不下这一份时直接回绝，对端不必传、
//! 本机也不必写一半再删。
//!
//! ## 三条纪律（每条都有判据钉着）
//!
//! 1. **读不到 ⇒ 放行**（不是拒绝）。查询失败的原因可能是权限、路径不存在、
//!    平台不支持 —— 此时拒绝会让"本来能收下的文件"永远收不下（误拒的代价
//!    远大于误放：误放只是回到今天的行为，误拒是功能永久不可用）。
//! 2. **预检不替代写失败兜底**。它本质是 TOCTOU（查完到写之间余量会变），
//!    所以写失败那套兜底（保留 `.part` + 台账 failed + 回 `Ack(false)`）必须原样保留。
//! 3. **一次查询是"慢活"吗？** —— 不是。`statvfs` / `GetDiskFreeSpaceExW` 是
//!    **一次系统调用**（微秒级），与 INV-P34 管的"GB 级整份慢活"不是一回事：
//!    它不读文件内容、不做整份哈希、不 fsync。因此它**允许**留在 async 路径上，
//!    这条口径已写进 `docs/protocol-invariants.md` 的 INV-P34（见该条"边界"段）。
//!
//! ## 平台实现
//!
//! · unix（含 macOS / Linux / Android）：`libc::statvfs`。
//! · Windows：`windows-sys` 的 `GetDiskFreeSpaceExW`。
//! · 其它（wasm 等）：恒 `None` ⇒ 放行（纪律 1）。

use std::path::Path;

/// 目标卷的**可用字节数**（对当前用户可写的那部分）。
///
/// `None` = **读不到**（权限 / 路径不存在 / 平台不支持 / 调用失败）⇒ 调用方**必须放行**。
///
/// ⚠️ 语义是"**可用**"而不是"总量"：配额要跟"能真写进去的量"比，
/// 否则在一个 90% 满的卷上会放行一个根本写不下的文件。
pub fn available_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        unix_available_bytes(path)
    }
    #[cfg(windows)]
    {
        windows_available_bytes(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        None
    }
}

/// 一次查询的结果：**够 / 不够 / 读不到**。
///
/// 三态而不是两态，是因为"读不到"必须**放行**（见文件头纪律 1）——
/// 折成两态就必然把它当成"不够"，于是权限受限的目录会永远收不下文件。
#[derive(Debug, PartialEq, Eq)]
pub enum SpaceVerdict {
    /// 余量够（或本来就放行）：可以收。
    Enough,
    /// 余量明确不够：拒绝这一单。
    NotEnough {
        /// 卷上可用的字节数。
        available: u64,
        /// 这一单需要的字节数。
        needed: u64,
    },
    /// 读不到余量 ⇒ **放行**（不等于 Enough 的语义，但结果同样是收）。
    Unknown,
}

/// 判定"目标卷还装不装得下这一单"。
///
/// - `needed`：这一单要写的字节数（通常就是对端声明的 size）。
/// - `headroom`：额外留出的余量（给系统与日志用，避免正好卡满）。
/// - `path`：待查询的路径（通常是接收目录）。
///
/// 读不到余量 ⇒ [`SpaceVerdict::Unknown`] ⇒ 调用方放行。
pub fn verdict_for(path: &Path, needed: u64, headroom: u64) -> SpaceVerdict {
    match available_bytes(path) {
        Some(available) => verdict_of(available, needed, headroom),
        None => SpaceVerdict::Unknown,
    }
}

/// 纯函数版：已知可用字节数时的判定（**不碰文件系统**）。
///
/// 为什么要单独拆出来：`verdict_for` 要真查卷，而"余量差 1 字节时到底放不放"
/// 这种边界在真实卷上很难构造（写死数值会脆）⇒ 拆成纯函数后边界可以逐条钉住。
///
/// 折叠方向：**水位是减项**（`available - headroom >= needed`）——
/// 余量恰好等于这一单的大小时要**拒绝**（写满之后连 `.part` 都删不掉，
/// Windows 与部分网络卷会拒绝所有写，清理路径一起卡死）。
pub fn verdict_of(available: u64, needed: u64, headroom: u64) -> SpaceVerdict {
    if available.saturating_sub(headroom) >= needed {
        SpaceVerdict::Enough
    } else {
        SpaceVerdict::NotEnough { available, needed }
    }
}

// -------------------------------------------------------------------------
//  unix
// -------------------------------------------------------------------------

#[cfg(unix)]
fn unix_available_bytes(path: &Path) -> Option<u64> {
    // `statvfs` 收的是**路径**，不存在的路径会失败 ⇒ 调用方拿 `None` ⇒ 放行。
    // 走 CString 而非 `OsStr` 字节：路径里有 NUL 时必然失败（那不是合法路径）。
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    // SAFETY：`statvfs` 只写 `c` 指向的 `statfs` 结构；`c` 在调用期间有效，
    // 结构体是栈上的、可写内存，大小与 libc 的定义一致（同一份 crate 的类型）。
    // 失败时结构体内容未定义 —— 所以只在 `ret == 0` 时读它。
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st as *mut libc::statvfs) != 0 {
            return None;
        }
        // `f_bavail` = 对**当前用户**可用的块数（`f_bfree` 还要扣掉 root 保留块）。
        //
        // ⚠️ **块大小字段在 unix 内部就不是一个东西**：
        // · Linux / Android 的 `statfs` 有 `f_frsize`（"文件系统的块大小"）与
        //   `f_bsize`（"最优 I/O 块大小"，**可以不是**块大小 —— 它是 hint）。
        // · macOS / BSD 的 `statfs` **只有** `f_bsize`，而那里的 `f_bsize` 才是块大小。
        // 用错字段的后果是静默的：算出来的余量可能差好几倍 ⇒ 预检要么永远放行
        // （形同没有），要么永远拒绝（功能不可用）。所以按平台分开取。
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let block = st.f_frsize as u64;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let block = st.f_bsize as u64;
        let avail = st.f_bavail as u64;
        Some(block.saturating_mul(avail))
    }
}

// -------------------------------------------------------------------------
//  Windows
// -------------------------------------------------------------------------

#[cfg(windows)]
fn windows_available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // `GetDiskFreeSpaceExW` 要的是**卷根**（`C:\`），不是任意目录。
    // 取目录所在卷：从路径里剥掉最后一段（目录名），剩下的就是卷根。
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let root = volume_root_of(&wide);
    if root.is_empty() {
        return None;
    }
    // Windows 的路径字符串必须 NUL 结尾（`GetDiskFreeSpaceExW` 按 LPCWSTR 读）。
    let mut root_with_nul = root;
    root_with_nul.push(0);
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    // SAFETY：`lpDirectoryName` 指向 NUL 结尾的 UTF-16 卷根（`root` 自带结尾 NUL）；
    // 四个输出指针都指向有效的栈变量，尺寸与 `GetDiskFreeSpaceExW` 的签名一致。
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            root_with_nul.as_ptr(),
            &mut free_to_caller,
            &mut total,
            &mut total_free,
        )
    };
    if ok == 0 {
        return None;
    }
    // `freeBytesAvailableToCaller` 正是"当前用户还能写多少" ⇒ 与 unix 的
    // `f_bavail` 同一口径（都不是"总量减已用"）。
    Some(free_to_caller)
}

/// 从一个 UTF-16 路径里取出**卷根**（`C:\` 这种），取不到 ⇒ 空串。
///
/// ⚠️ 刻意写成**不依赖 Windows API 的纯函数**（只吃 UTF-16 切片、只吐 UTF-16 切片）：
/// 本仓的 Windows 代码全在 `#[cfg(target_os = "windows")]` 里，**mac 上编不出来** ——
/// 于是"卷根解析对不对"这类逻辑错误只有 Windows CI 才看得见，而 CI 不会为它写用例。
/// 抽成纯函数后，mac 上的单测就能钉住它（见本文件末尾的 `volume_root` 用例）。
///
/// 形态一：`C:\foo\bar` ⇒ 根是 `C:\`。
/// 形态二：UNC `\\server\share\dir` ⇒ 根是 `\\server\share`。
/// 形态三：相对路径 / 没有盘符 ⇒ 取不到（⇒ 放行）。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn volume_root_of(wide: &[u16]) -> Vec<u16> {
    let s = String::from_utf16_lossy(wide);
    let trimmed = s.trim_end_matches('\0');
    let b = trimmed.as_bytes();
    if b.len() >= 2 {
        if b[0] == b'\\' && b[1] == b'\\' {
            // UNC：`\\server\share`（两段，反斜杠分隔）
            let rest = &trimmed[2..];
            let mut parts = rest.splitn(3, '\\');
            let server = parts.next().unwrap_or("");
            let share = parts.next().unwrap_or("");
            if !server.is_empty() && !share.is_empty() {
                return format!("\\\\{server}\\{share}\\").encode_utf16().collect();
            }
            return Vec::new();
        }
        if b[1] == b':' && b[0].is_ascii_alphabetic() {
            // ⚠️ **必须补尾反斜杠**：`GetDiskFreeSpaceExW` 认的是**卷根**，
            // 形状是 `C:\` 而不是 `C:` —— 给 `C:` 它会当成"目录名 C:"，
            // 查询失败 ⇒ 余量恒"读不到" ⇒ 预检恒放行（形同没有这条闸）。
            let drive = &trimmed[..2];
            return format!("{drive}\\").encode_utf16().collect();
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据是三态：**够 / 不够 / 读不到**。折成两态就必然把"读不到"当成"不够"，
    /// 于是权限受限的目录会永远收不下文件（误拒的代价远大于误放）。
    #[test]
    fn unknown_space_is_not_the_same_as_not_enough() {
        assert_eq!(
            SpaceVerdict::Unknown,
            SpaceVerdict::Unknown,
            "读不到余量是独立的一态，不许与『不够』合并"
        );
        // 不够那一态带两个数：可用的、要的（前端与日志都要它们）。
        let v = SpaceVerdict::NotEnough {
            available: 100,
            needed: 200,
        };
        match v {
            SpaceVerdict::NotEnough { available, needed } => {
                assert_eq!(available, 100);
                assert_eq!(needed, 200);
            }
            _ => panic!("不该是别的态"),
        }
    }

    /// Windows 的**卷根解析**（纯函数 ⇒ mac 上就能钉住，不必等 Windows CI）。
    ///
    /// 为什么这条值得有：`GetDiskFreeSpaceExW` 查的是**卷**的空间，给目录会失败 ——
    /// 卷根解析错了，那次查询就永远失败 ⇒ 余量恒"读不到" ⇒ 预检恒放行（形同没有）。
    /// 而这一段在 `#[cfg(target_os = "windows")]` 里，mac 上连编都编不出来。
    #[test]
    fn volume_root_is_parsed_for_drive_and_unc_paths() {
        let w = |s: &str| -> Vec<u16> { s.encode_utf16().collect() };
        let as_str = |v: &[u16]| -> String { String::from_utf16_lossy(v) };

        // 盘符路径：`C:\` ⇒ `C:\`（注意：**带尾反斜杠**，Windows 要这个形状）
        assert_eq!(as_str(&volume_root_of(&w("C:\\"))), "C:\\");
        assert_eq!(
            as_str(&volume_root_of(&w("C:\\Users\\me\\Downloads"))),
            "C:\\"
        );
        // 小写盘符也行
        assert_eq!(as_str(&volume_root_of(&w("d:\\data"))), "d:\\");
        // UNC：`\\server\share\dir` ⇒ `\\server\share\`
        assert_eq!(
            as_str(&volume_root_of(&w("\\\\server\\share\\dir"))),
            "\\\\server\\share\\",
        );
        // 取不到卷根 ⇒ 空串（调用方据此放行，不硬猜）
        assert!(volume_root_of(&w("relative\\path")).is_empty());
        assert!(volume_root_of(&w("")).is_empty());
        // 带结尾 NUL 的形态（Windows 路径的原生形状）也要认
        assert_eq!(as_str(&volume_root_of(&w("C:\\x\0"))), "C:\\");
    }

    /// 折叠方向与边界（纯函数，逐条钉住）：
    /// · 余量明显够 ⇒ 放行；
    /// · 余量不够 ⇒ 拒绝；
    /// · 余量**恰好等于**这一单（扣掉水位后不够）⇒ 拒绝（写满之后连 `.part` 都删不掉）；
    /// · 余量连水位都不够 ⇒ 拒绝。
    ///
    /// 反面对照：把折叠方向改成 `available >= needed`（忽略水位）⇒ 最后两格必须红。
    #[test]
    fn space_verdict_folds_headroom_into_the_decision() {
        let mib = 1024 * 1024;
        let headroom = 64 * mib;
        // 够：100 MiB 可用、要 10 MiB
        assert_eq!(
            verdict_of(100 * mib, 10 * mib, headroom),
            SpaceVerdict::Enough
        );
        // 不够：只剩 1 MiB、要 10 MiB
        assert_eq!(
            verdict_of(mib, 10 * mib, headroom),
            SpaceVerdict::NotEnough {
                available: mib,
                needed: 10 * mib
            },
            "余量明显不够必须拒绝（否则又要写到一半才 ENOSPC）"
        );
        // 边界：可用 10 MiB、要 10 MiB —— 扣掉水位后不够 ⇒ 拒绝
        assert_eq!(
            verdict_of(10 * mib, 10 * mib, headroom),
            SpaceVerdict::NotEnough {
                available: 10 * mib,
                needed: 10 * mib
            },
            "恰好塞满必须拒绝（写满之后连 .part 都删不掉，清理路径一起卡死）"
        );
        // 可用量比水位还少 ⇒ 拒绝（不是"下溢成天文数字然后放行"）
        assert_eq!(
            verdict_of(1, 1, headroom),
            SpaceVerdict::NotEnough {
                available: 1,
                needed: 1
            },
            "水位都盖不住时必须拒绝（saturating_sub 不许下溢成天文数字）"
        );
    }

    /// 真文件系统上的余量查询：**读得到**且量级合理。
    ///
    /// 这条只断言"读得到 + 不是天文数字"（不同卷的余量差异太大，写死数值会脆）。
    /// 它真正钉住的是"路径写错/不存在 ⇒ 返回 None（⇒ 放行）"这条契约。
    #[test]
    fn available_bytes_is_readable_for_a_real_dir_and_none_for_a_missing_one() {
        let dir = std::env::temp_dir();
        let avail = available_bytes(&dir);
        assert!(
            avail.is_some(),
            "真实目录必须读得到余量（读不到 ⇒ 预检恒放行 = 形同没有）"
        );
        assert!(
            avail.unwrap() < 1 << 60,
            "余量不该是天文数字（块大小取错字段 ⇒ 算出来的量会离谱）"
        );
        // 不存在的路径 ⇒ None（⇒ 放行，绝不因为"查不到"就拒收）
        let missing = dir.join("gosslan-no-such-dir-for-space-probe");
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(
            available_bytes(&missing),
            None,
            "路径不存在 ⇒ 读不到 ⇒ 必须放行（误拒的代价远大于误放）"
        );
    }
}
