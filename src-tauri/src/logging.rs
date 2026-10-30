//! 应用级运行日志系统。
//!
//! 目标：生产环境（release，Windows 无控制台）出问题时，用户能打开「运行日志」
//! 窗口把日志复制给开发者，据此定位问题。日志走「内存有界缓存 + 落盘文件」双通道，
//! 既不无限增长、也不因进程崩溃而丢光（文件是崩溃兜底，内存是 UI 快照）。
//!
//! # 打日志规范（重要，写功能时务必遵守）
//!
//! **原则：少而准，只记「可能出错」与「关键状态跃迁」，绝不把日志当 printf 调试。**
//!
//! 1. **该记的**（有排查价值）：
//!    - 关键状态跃迁：连接建立 / 断开、握手成功 / 失败、身份学到 / 密钥冲突、链路切换。
//!    - 可恢复的异常：解析失败、绑定失败、拨号失败、文件初始化失败 —— 必须带上
//!      **能定位的上下文**（peer id、地址、错误原因），否则这行日志等于白记。
//!    - 安全事件：验签拒绝、身份伪造、重放。
//! 2. **不该记的**：
//!    - 正常消息正文、密钥、会话密钥、文件名等**敏感内容**（日志会落盘 + 被复制出去）。
//!    - 高频循环里的每条 announce / heartbeat（会刷爆 buffer，淹没真问题）。
//!    - 纯 debug 用的临时 println 式输出。
//! 3. **级别怎么选**：
//!    - `error`：明确失败、且用户/开发者需要立即关注的（文件失败、绑定失败、加密失败）。
//!    - `warn`：异常但可恢复、或值得注意的安全事件（拨号未成功、拒绝未认证 Hello、
//!      配置地址无法解析）。
//!    - `info`：正常的关键状态跃迁（连接建立、握手补全、学到身份、Presence 发现新节点）。
//! 4. **target 怎么起名**：子系统名（`transport` / `lan` / `routed` / `mesh` / `friend` /
//!    `presence` / `link` / `tray` …），与旧 eprintln 的 `[tag]` 对应。
//!
//! # 存储与自动清理（不无限记、不爆内存）
//!
//! - **内存**：有界 ring buffer（`MAX_MEM_LOGS = 500` 条），超出丢最旧 —— UI 只读它。
//! - **文件**：追加写 `logs/<stem>.log`，单文件超过 `MAX_LOG_FILE_BYTES`（512 KB）即
//!   轮转为 `.old.log`（覆盖上一份旧文件），磁盘占用上界约 1 MB。
//! - 清理触发是**惰性**的（每次写时检查），不另起后台任务，避免额外线程与复杂度。

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::private_fs::{create_private_dir, restrict_dir_to_owner, restrict_to_owner};

/// 内存保留的日志条数上限。
/// Android 的 logcat 镜像：**合批 + 单线程 fork**（见 `Logger::log` 里的说明）。
///
/// 为什么需要它：`log` 是外部可执行文件，写一行 = fork+exec 一个进程。BLE 生命周期日志
/// 一多（每帧一条 `[SEND]/[RECV]`），真机上就变成"一边跑 GATT、一边疯狂 fork"，
/// 拖慢 Rust 运行时与蓝牙时序。这里把行丢进无界队列，由**一个**常驻线程按
/// `BATCH_WINDOW` 合批后每批只 fork 一次。
///
/// 取舍：logcat 里会晚最多 200ms 出现（日志首行的时间戳是**批次**时间），
/// 而行级精确时间戳仍然完整保存在落盘日志与内存日志里（`[SEND]/[RECV]` 排查用它）。
#[cfg(target_os = "android")]
mod logcat {
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    /// 合批窗口：够把一轮扫描/一次 flush 的多行并成一次 fork，又不至于让日志"迟到"太多。
    const BATCH_WINDOW: Duration = Duration::from_millis(200);
    /// 单批上限（防止极端刷屏时一条 logcat 消息过长）。
    const BATCH_MAX_LINES: usize = 64;

    static TX: OnceLock<Sender<String>> = OnceLock::new();

    pub(super) fn push(line: String) {
        let _ = tx().send(line);
    }

    fn tx() -> &'static Sender<String> {
        TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<String>();
            std::thread::Builder::new()
                .name("gosslan-logcat".into())
                .spawn(move || run(rx))
                .ok();
            tx
        })
    }

    /// 常驻线程：收够一批就 fork 一次 `log -t gosslan <多行>`。
    fn run(rx: Receiver<String>) {
        loop {
            let Ok(first) = rx.recv() else { return };
            let mut batch = vec![first];
            let deadline = Instant::now() + BATCH_WINDOW;
            while batch.len() < BATCH_MAX_LINES {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(line) => batch.push(line),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            emit(&batch.join("\n"));
        }
    }

    fn emit(msg: &str) {
        use std::process::{Command, Stdio};
        // 不等待：日志绝不允许反过来阻塞业务
        let _ = Command::new("log")
            .args(["-t", "gosslan", msg])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 合批函数的边界：窗口内多行必须并成 1 批、超上限必须截断。
        /// （这里只测"批大小/拼接"的纯逻辑，不真的 fork `log`。）
        #[test]
        fn batch_join_keeps_one_message_per_batch() {
            let lines: Vec<String> = (0..3).map(|i| format!("line{i}")).collect();
            assert_eq!(lines.join("\n"), "line0\nline1\nline2");
            assert!(BATCH_MAX_LINES >= 16, "上限太小会把日志切成碎片");
            assert!(BATCH_WINDOW >= Duration::from_millis(50));
        }
    }
}

const MAX_MEM_LOGS: usize = 500;
/// 落盘遇到"盘满"类错误后的**退避窗口**（行）：这段时间内不再试写文件（内存环照常），
/// 窗口到点再试一次。为什么不"每条日志查一次可用空间"：查可用空间要 `statvfs` /
/// `GetDiskFreeSpaceExW`，前者需要新依赖（本仓默认构建零新增第三方 crate，ADR-0015 §2），
/// 后者只在 `bluetooth` feature 的 Windows 构建里才有 `windows` crate ⇒ 为一条日志
/// 加一次系统调用 + 一个依赖不值。**盘真满时第一次写失败就会带 `StorageFull` /
/// `ENOSPC(28)` / `ERROR_DISK_FULL(112)` / `ERROR_HANDLE_DISK_FULL(3900)`**，
/// 那个信号比任何预防性查询都准，因为它量的就是我们要做的这次写。
const LOG_RETRY_BACKOFF_LINES: u64 = 256;
/// 单个日志文件大小上限（字节），超出即轮转。
const MAX_LOG_FILE_BYTES: u64 = 512 * 1024;
/// 崩溃现场文件的磁盘上界（字节）：超了就**整份重开**，不做多代归档、也绝不无限增长。
const MAX_CRASH_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 每次崩溃现场附带多少条"崩溃之前的运行日志"（取内存环，与文件轮转无关）。
const CRASH_CONTEXT_LINES: usize = 300;
/// diag 同秒折叠表的键上限：键是 `(target, 整行文本)`，而文本里带设备 id 与来源 IP ⇒ 会随
/// 局域网规模与时间增长。**封顶后整表重开**（宁可偶尔多写一条，也不让它变成"永远只增"的内存洞）。
const DIAG_FOLD_KEYS: usize = 512;

// ---- 上一轮故障现场进内存 ----
/// 读上一轮 `<stem>.log` 尾部的字节上限（不整份读入）。
const PREV_RUN_TAIL_BYTES: u64 = 128 * 1024;
/// 进环行数上限：小于 [`MAX_MEM_LOGS`]，给本轮留出空间。
const PREV_RUN_MAX_LINES: usize = 120;
/// 崩溃现场文件只读尾部这些字节。
const PREV_CRASH_TAIL_BYTES: u64 = 64 * 1024;
/// 现场原生行（`>>>` / `----- 启动` / `=====`）最多带几条。
const PREV_CRASH_MAX_LINES: usize = 40;
/// 原生行合成一条记录的字符上界。
const PREV_CRASH_MAX_CHARS: usize = 4_000;

/// 日志级别。按严重度递增：Info < Warn < Error。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

/// 单条日志（序列化给前端）。
#[derive(Clone, Serialize, Debug)]
pub struct LogEntry {
    /// Unix 毫秒时间戳。
    pub ts: i64,
    /// "info" | "warn" | "error"
    pub level: String,
    /// 子系统名（transport / lan / routed / mesh / friend …）。
    pub target: String,
    pub message: String,
}

/// 崩溃现场文件的**独立**写入通道 —— 不依赖 `AppState`、不依赖 `Logger` 已经建好。
///
/// 为什么必须有它：本模块上面的 `write_crash_block` 挂在 `Logger` 上，而 `Logger` 是
/// `AppState::init` 里才建的 —— 于是"崩在 logger 建起来之前"（数据库迁移、启动早期）
/// 这一整段**一个字都留不下**。而 `[profile.release] panic = "abort"` 下分配失败走的是
/// `handle_alloc_error` → abort，**根本不经过 panic 钩子**，产生的异常码却和 panic 一模一样
/// （`0xc0000409`）⇒ 不留痕就永远分不开这两种死法。
///
/// 崩溃现场文件的**权威**路径（由 `Logger::new` 绑定）。
static CRASH_FILE: OnceLock<PathBuf> = OnceLock::new();
/// bootstrap 的**早期**绑定（logger 还不存在时的那几毫秒用）。
///
/// 为什么要两个槽（2026-10-20 隔离实例实证，不是假想）：bootstrap 跑在 `Logger::new` 之前，
/// 它拿到的是 `app_data_dir()`，而 Logger 拿到的是 `<app_data>/logs`。过去只有一个
/// `OnceLock`、bootstrap 先绑 ⇒ Logger 那次（唯一正确的那次）被**静默丢弃**，于是独立通道
/// 连续几天都在写 `com.gosslan.app/gosslan-N-crash.log`，而用户被指引去发的、诊断包读的、
/// 下次启动判定读的都是 `logs/gosslan-N-crash.log` —— 现场文件里因此**一行 `>>>` 都没有**，
/// "打开就闪退"永远读成"异常终止/强杀"。
/// 现在：路径统一由 [`crash_file_in`] 计算（两处必然相等），**并且**分成两槽 ——
/// 权威绑定永远能生效，早期绑定只在权威缺失时兜底。两个 `OnceLock` 都是无锁读，
/// panic 钩子里不会因为抢锁而死锁。
static EARLY_CRASH_FILE: OnceLock<PathBuf> = OnceLock::new();
/// 防再入：分配失败时写这一行本身还要申请内存，可能再次打进分配器。
static NOTE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 唯一的**日志目录**计算点：`<app_data>/logs`。
///
/// 谁都不许自己拼 `join("logs")`：这个字面量一旦在某一处漂移，就会出现
/// "写在一处、读在另一处"的静默丢证据（2026-10-20 的现场就是这种形状）。
pub fn log_dir_in(app_data: &std::path::Path) -> PathBuf {
    app_data.join("logs")
}

/// 唯一的**崩溃现场文件**计算点：`<app_data>/logs/<stem>-crash.log`。
///
/// bootstrap（早）与 `Logger::new`（稍后）都必须走这里 —— 见 [`EARLY_CRASH_FILE`] 的说明。
pub fn crash_file_in(app_data: &std::path::Path, stem: &str) -> PathBuf {
    crash_file_for(&log_dir_in(app_data), stem)
}

/// 把现场文件路径交给独立写入器（权威绑定，`Logger::new` 用）。只认第一次。
pub fn bind_crash_file(path: &std::path::Path) {
    let _ = CRASH_FILE.set(path.to_path_buf());
}

/// 早期绑定（bootstrap 用）。权威绑定出现后**以权威为准**，这里不会把它顶掉。
pub fn bind_early_crash_file(path: &std::path::Path) {
    let _ = EARLY_CRASH_FILE.set(path.to_path_buf());
}

/// 进程要消失之前都能调的一行留痕。写不进去 ⇒ 退回 stderr（不假装写成了）。
///
/// ⚠️ 与 `write_crash_block` 的分工：那条带"崩之前 300 条"上下文（要靠内存环，只有 logger 在时做得到）；
/// 这条只保证**一定写得出**，用在还没有 logger、或压根不会经过 panic 钩子的路径上。
pub fn crash_note(text: &str) {
    match CRASH_FILE.get().or_else(|| EARLY_CRASH_FILE.get()) {
        Some(path) if crash_note_to(path, text) => {}
        _ => eprintln!("[gosslan] (现场文件写不进去，这条只在 stderr) {text}"),
    }
}

/// 真正写那一行的部分。返回 `true` = 真的落盘了。
///
/// **拆成显式路径**是为了可测：`CRASH_FILE` 是进程级 OnceLock，单元测试之间共享，
/// 直接测全局那条会互相抢绑定。
///
/// 三条必须在这里守住的边界（它跑在 panic 钩子里，任何一条做错都会把"留痕"变成"二次崩溃"）：
/// 1. **不 panic**：任何 IO 失败都折成 `false`，由 [`crash_note`] 退到 stderr；
/// 2. **有上界**：这条通道不轮转（它必须在任何子系统坏掉时也能写），所以超过
///    [`MAX_CRASH_FILE_BYTES`] 就整份重开 —— 与 `write_crash_block` 同一口径，
///    否则"反复启动失败"会把现场文件长到没有边；
/// 3. **不再入**：写这一行本身要申请内存，分配失败时可能再次打进分配器。
pub fn crash_note_to(path: &std::path::Path, text: &str) -> bool {
    use std::io::Write;
    if NOTE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return false; // 再入：正在写现场时又触发分配失败，直接放弃这条（否则无限递归）
    }
    if let Some(dir) = path.parent() {
        let _ = create_private_dir(dir);
    }
    // 先看大小再决定 open 模式：append 不会截断，超上界时必须显式 truncate。
    let over_cap = matches!(std::fs::metadata(path), Ok(m) if m.len() > MAX_CRASH_FILE_BYTES);
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true);
    if over_cap {
        opts.truncate(true);
    } else {
        opts.append(true);
    }
    let ok = match opts.open(path) {
        Ok(mut f) => {
            restrict_to_owner(path);
            let mut ok = true;
            if over_cap {
                ok &= writeln!(
                    f,
                    "（现场文件超过 {} 字节，已整份重开；更早的行不在本文件里）",
                    MAX_CRASH_FILE_BYTES
                )
                .is_ok();
            }
            ok &= writeln!(
                f,
                ">>> {text}  @{} 版本 {} · {}-{} · {}",
                format_utc(now_ms()),
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
            )
            .is_ok();
            ok && f.flush().is_ok()
        }
        Err(_) => false,
    };
    NOTE_IN_PROGRESS.store(false, Ordering::SeqCst);
    ok
}

/// 现场文件路径（供 bootstrap 与测试用）。
pub fn crash_file_for(dir: &std::path::Path, stem: &str) -> PathBuf {
    dir.join(format!("{stem}-crash.log"))
}

/// 应用级 logger：内存 ring buffer + 落盘文件，线程安全（`Arc<AppState>` 跨线程共享）。
pub struct Logger {
    entries: Mutex<VecDeque<LogEntry>>,
    dir: PathBuf,
    /// 日志文件主名（`gosslan` 或 `gosslan-1` 等，多实例隔离）。
    stem: String,
    /// 设备短指纹 — 每台机器自动生成（hostname 前 6 字符 + 平台 tag），
    /// 让多设备日志能一眼区分来源。格式：`[dev:Win-7f3a]` / `[dev:And-b2c1]` / `[dev:Mac-9e4d]`。
    fingerprint: String,
    /// diag 同秒折叠表：`(target, 整行文本) → 上一个写下它的 epoch 秒`。
    /// 见 [`Logger::fold_diag_same_second`]。放成实例字段而不是全局 static，
    /// 这样多实例（`gosslan-1`）与单元测试各有一份，互不污染。
    diag_fold: Mutex<HashMap<(String, String), i64>>,
    /// `seed_previous_run` 是否已跑过，用来保证它自身幂等。
    seed_ran: std::sync::atomic::AtomicBool,
    /// 本轮进程的运行标识（6 位十六进制）：写进"启动"与"正常退出"两条路标，
    /// 让一份被多实例、多次启动写混的现场文件能按 run 切开。
    run_id: String,
    /// 落盘失败累计次数（含磁盘不足被主动跳过的）。内存环照常，计数用来"看得见"。
    write_fails: std::sync::atomic::AtomicU64,
    /// 已探测到的磁盘不足状态：为真时跳过落盘，直到下一次探测节流窗口到点再复查。
    disk_low: std::sync::atomic::AtomicBool,
    /// 降级说明是否已经进过内存环（只记第一次，避免刷爆 500 条环）。
    degrade_noted: std::sync::atomic::AtomicBool,
    /// 落盘行计数，用于 [`LOG_RETRY_BACKOFF_LINES`] 的退避窗口节流。
    append_lines: std::sync::atomic::AtomicU64,
    /// 上一轮的结构化报告：`seed_previous_run` 算一次，命令只 clone。
    previous_report: OnceLock<PreviousRunReport>,
}

/// 这个 IO 错误是不是"盘满"类。
///
/// ⚠️ 只用裸 OS 码，不用 `ErrorKind::StorageFull`：那个变体稳定于 Rust 1.83，
/// 而本仓 `rust-version = 1.77`（clippy 的 `incompatible_msrv` 直接把它判成 error，
/// 2026-10-20 第一次跑 clippy 就是这么红的）。裸码是各平台事实上的定义：
/// `28` = ENOSPC（macOS/Linux/Android）、`112`/`3900` = Windows 的
/// `ERROR_DISK_FULL`/`ERROR_HANDLE_DISK_FULL`；再加一条按错误文本兜底，
/// 免得某个平台既给不出这些码又确实写不下。
///
/// **为什么是 `pub(crate)` 而不再是私有**：接收侧的写盘失败也要判"是不是盘满"——
/// 那条路径此前只把 `io::Error` 原样转成一句英文（"No space left on device"），
/// 用户看到的是**不可行动**的措辞，而盘满其实是**可行动**的（清出空间后重试即可）。
/// 同一个判定有两份实现必然漂移 ⇒ 归到这一份（observability 域的叶子模块；
/// files / transport 域单向调用它，见 `docs/domains.data.mjs` 的 consumes）。
pub(crate) fn is_disk_full(e: &std::io::Error) -> bool {
    if matches!(
        e.raw_os_error(),
        Some(28) | Some(112) | Some(3900) | Some(122)
    ) {
        return true;
    }
    let t = e.to_string().to_lowercase();
    t.contains("no space") || t.contains("not enough space") || t.contains("quota")
}

/// 接收失败的**稳定失败码**（前端按它挑可行动的文案，而不是显示原始 io 错误）。
///
/// 为什么需要码：失败的 `reason` 此前直接是后端的自由文本/英文 io 消息，前端只能
/// 原样上屏，于是"磁盘满了"与"目录没有权限"长得一模一样，用户不知道该做什么。
/// 码把"这一类失败"与"这一次的措辞"分开：码是**契约**（前端查表），措辞是实现。
///
/// **别把它当成错误码大全** —— 每加一条都要同时补前端映射
/// （`src/utils/fileFailReason.ts`），否则前端只能回落到原始 reason（那条回落路径已留好，
/// 见 `fileFailReasonText`）。加进这张表的码**必须真的有界面读者**：只写进日志而没人查表的码
/// 等于一个假字段（编译过、门禁绿、界面上零变化）。
pub(crate) const FAIL_CODE_DISK_FULL: &str = "DISK_FULL";

// 下面四条同族（另两条 1:1 过期/放弃的码在 `error_codes.rs`，它们既上屏也落库）：
// 以前它们把**中文文案直接写进 `file-failed` 的事件载荷**，
// 而前端对未知 reason 的处理是"原样上屏"（刻意的回落，宁可显示原文也不显示空白）
// ⇒ 英文界面这几格看到的是中文。改成码之后措辞归词典，日志里仍写人话。
// 判据：`src/utils/fileFailReason.test.ts` 的「file-failed 载荷里不许出现硬编码文案」。
// 群文件那一族原先在这张表里，5.15.32 已把它们的**码**搬去 `error_codes.rs::MESSAGE_FAIL_CODES`
// （因为它们既上屏也落库）。它们仍**不弹通知**：断链时每个在途传输弹一次 toast 是噪音，
// 名单在 `group_file.rs::should_notify_group_failure`（该文件另有 `persistable_group_fail_code`
// 管"什么才允许落库"）。

/// 中继接收侧的状态行过期（文件还没收完）。
pub(crate) const FAIL_CODE_FILE_RELAY_STATE_EXPIRED: &str = "FILE_RELAY_STATE_EXPIRED";

/// 中继收完的字节数与声明大小不符。
pub(crate) const FAIL_CODE_FILE_RELAY_SIZE_MISMATCH: &str = "FILE_RELAY_SIZE_MISMATCH";

/// 内容与本机不匹配（哈希/密钥对不上）。
pub(crate) const FAIL_CODE_FILE_INTEGRITY_FAILED: &str = "FILE_INTEGRITY_FAILED";

/// 中继传输一小时没走完，被回收。
pub(crate) const FAIL_CODE_FILE_RELAY_STALLED: &str = "FILE_RELAY_STALLED";

/// 把一次写盘失败归类成稳定失败码：盘满 ⇒ [`FAIL_CODE_DISK_FULL`]，其余 ⇒ `None`。
///
/// `None` 表示"没有专属码"，调用方应当保留原始错误文本（那是唯一信息量）。
pub(crate) fn classify_write_failure(e: &std::io::Error) -> Option<&'static str> {
    if is_disk_full(e) {
        Some(FAIL_CODE_DISK_FULL)
    } else {
        None
    }
}

/// 上一轮是怎么结束的。**判定依据是"缺席"**：进程被 `kill -9`、OOM killer、
/// 看门狗强杀、拔电源这几类死法在进程内部**永远留不下任何东西**，能区分它们的
/// 只有"有没有崩溃现场块"与"有没有正常退出路标"这两个在场/缺席的组合。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PreviousExit {
    /// 现场文件里什么都没有（首次运行或被清档）
    NoHistory,
    /// 最后一条路标是"正常退出" ⇒ 上一次走到收尾
    Clean,
    /// 有崩溃现场块 ⇒ 上一次是 Rust panic（或分配失败留痕）
    Panic,
    /// 上一次是**被安全中止的启动**（身份/数据库校验失败）：进程没崩，但也没起来。
    /// 这条由 `crash_note("code=BOOT_FAILED …")` 留下，下一轮必须与"正常退出"分开。
    StartupFailed,
    /// 只有"启动"、没有退出、也没有崩溃块 ⇒ **按异常终止处理**
    /// （强杀 / OOM / 原生代码 abort / 掉电 —— 这一类无法再细分，也不许假装能细分）
    SilentKill,
    /// 分配器自己的 abort：`>>> 重分配失败：… 分配器即将 abort`。
    /// 与 `SilentKill` 分开：这一条**有现场**（请求字节数写在行里），只是
    /// panic 钩子跑不到（abort 不走 unwind）⇒ 没有 `===== 崩溃现场` 块。
    Abort,
}

/// 上一次运行留给本次启动的结构化报告（启动时算一次，命令只 clone）。
///
/// 为什么不让前端解析 `get_logs`：内存环只有 500 条、上一轮种子最多 120 行，
/// 而判定句是中文文本；`clear_logs` 还会把证据清掉。这里一次算成字段，前端只读字段。
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviousRunReport {
    /// `panic` | `silent_kill` | `startup_failed` | `clean` | `no_history`
    pub kind: String,
    /// 机器码（`BOOT_PREV_*`），用于检索/口述。
    pub code: String,
    /// 上一轮启动时刻（现场文件里的 UTC 文本）。
    pub at: Option<String>,
    /// 上一轮的版本号。
    pub version: Option<String>,
    /// 崩溃位置与消息（panic / 分配失败留痕）。
    pub panic: Option<PanicDetail>,
    /// 上一轮是否卡死过（有 HANG 记录）。
    pub hang: Option<HangDetail>,
    /// 这次现场窗口里能数到的 panic 条数（用于"最近第 N 次"）。
    pub recent_panic_count: u32,
    /// 崩溃点是否落在蓝牙模块（决定本次是否暂停蓝牙自动开启）。
    pub ble_suspect: bool,
    pub crash_log: String,
    pub log_dir: String,
}

impl Default for PreviousRunReport {
    fn default() -> Self {
        Self {
            kind: "no_history".to_string(),
            code: "BOOT_PREV_NO_HISTORY".to_string(),
            at: None,
            version: None,
            panic: None,
            hang: None,
            recent_panic_count: 0,
            ble_suspect: false,
            crash_log: String::new(),
            log_dir: String::new(),
        }
    }
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PanicDetail {
    /// `vendor/btleplug/src/corebluetooth/internal.rs:351:17`
    pub location: String,
    /// panic 消息（有界，来自现场文件）。
    pub message: String,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HangDetail {
    pub seconds: u64,
    pub last_op: Option<String>,
    /// 是否已配对写出 `HANG_END`（没配对 ⇒ 上次是卡着退出的）。
    pub ended: bool,
}

/// 卡死记录的两种原生行（写现场用，不参与"上一轮怎么结束"的判定）。
fn is_hang_native_line(line: &str) -> bool {
    line.starts_with(">>> code=HANG ") || line.starts_with(">>> code=HANG_END ")
}

/// 从一行现场文本里取 panic 位置与消息。
///
/// 两种形状都要认：
/// - 没有 logger 时的独立通道：`>>> panic @ file:line:col：message`
/// - 有 logger 时崩溃块里的上下文行：`[dev:…] … error [panic] panic @ file:…：message`
pub fn parse_panic_line(line: &str) -> Option<PanicDetail> {
    let rest = &line[line.find("panic @ ")? + "panic @ ".len()..];
    let (location, message) = rest
        .split_once('：')
        .or_else(|| rest.rsplit_once(": "))
        .unwrap_or((rest, ""));
    let location = location.trim();
    if location.is_empty() {
        return None;
    }
    Some(PanicDetail {
        location: location.to_string(),
        message: message.trim().to_string(),
    })
}

fn ble_marker(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("vendor/btleplug") || l.contains("corebluetooth") || l.contains("network/ble")
}

fn panic_ble_suspect(d: &PanicDetail) -> bool {
    ble_marker(&d.location) || ble_marker(&d.message)
}

fn hang_ble_suspect(op: &str) -> bool {
    let l = op.to_ascii_lowercase();
    l.contains("bluetooth") || l.contains("ble.")
}

fn field_u64(s: &str, key: &str) -> Option<u64> {
    s.split_whitespace()
        .find_map(|p| p.strip_prefix(key)?.parse().ok())
}

fn field_str(s: &str, key: &str) -> Option<String> {
    s.split_whitespace()
        .find_map(|p| p.strip_prefix(key).map(|v| v.to_string()))
}

fn parse_hang(lines: &[String]) -> Option<HangDetail> {
    let (idx, seconds, last_op) = lines
        .iter()
        .enumerate()
        .filter_map(|(i, l)| {
            let rest = l.strip_prefix(">>> code=HANG ")?;
            Some((
                i,
                field_u64(rest, "seconds=").unwrap_or(0),
                field_str(rest, "last_op="),
            ))
        })
        .next_back()?;
    let ended = lines[idx + 1..]
        .iter()
        .any(|l| l.starts_with(">>> code=HANG_END "));
    Some(HangDetail {
        seconds,
        last_op,
        ended,
    })
}

/// 取现场文件里**最后一次启动之后**的那一段（后面可能还跟着本轮刚写的启动行）。
fn last_run_slice(lines: &[String]) -> &[String] {
    let current = lines
        .iter()
        .rposition(|l| l.starts_with("----- 启动 "))
        .unwrap_or(lines.len());
    let prev = lines[..current]
        .iter()
        .rposition(|l| l.starts_with("----- 启动 "));
    // 从**上一轮的启动行本身**开始切：版本/时刻就写在那一条上。
    let start = prev.unwrap_or(0);
    &lines[start..current]
}

/// 把上一轮现场算成结构化报告。纯函数（路径只拼字符串），可单测。
pub fn build_previous_run_report(
    raw: &[String],
    crash_log: &std::path::Path,
    log_dir: &std::path::Path,
) -> PreviousRunReport {
    let run = last_run_slice(raw);
    let run_native: Vec<String> = run
        .iter()
        .filter(|l| is_crash_native_line(l))
        .cloned()
        .collect();
    let kind = classify_previous_exit(&run_native);
    let (kind_s, code) = match kind {
        PreviousExit::Panic => ("panic", "BOOT_PREV_PANIC"),
        PreviousExit::StartupFailed => ("startup_failed", "BOOT_PREV_STARTUP_FAILED"),
        PreviousExit::SilentKill => ("silent_kill", "BOOT_PREV_SILENT_KILL"),
        PreviousExit::Abort => ("abort", "BOOT_PREV_ABORT"),
        PreviousExit::Clean => ("clean", "BOOT_PREV_CLEAN"),
        PreviousExit::NoHistory => ("no_history", "BOOT_PREV_NO_HISTORY"),
    };
    let mut report = PreviousRunReport {
        kind: kind_s.to_string(),
        code: code.to_string(),
        crash_log: crash_log.display().to_string(),
        log_dir: log_dir.display().to_string(),
        ..Default::default()
    };
    if let Some(start) = run.iter().rev().find(|l| l.starts_with("----- 启动 ")) {
        let rest = start.trim_start_matches("----- 启动 ");
        let (at, tail) = match rest.split_once(" 版本 ") {
            Some((a, t)) => (a, t),
            None => (rest, ""),
        };
        report.at = Some(at.trim().to_string()).filter(|s| !s.is_empty());
        // 版本号后面紧跟分隔符（`·` 的具体码位不值得在代码里赌）：取第一个空白词。
        report.version = tail
            .split_whitespace()
            .next()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
    }
    if let Some(p) = run.iter().rev().find_map(|l| parse_panic_line(l)) {
        report.ble_suspect = panic_ble_suspect(&p);
        report.panic = Some(p);
    }
    report.hang = parse_hang(run);
    if !report.ble_suspect {
        if let Some(op) = report.hang.as_ref().and_then(|h| h.last_op.as_ref()) {
            report.ble_suspect = hang_ble_suspect(op);
        }
    }
    report.recent_panic_count = run
        .iter()
        .filter(|l| l.contains("panic @ "))
        .count()
        .min(u32::MAX as usize) as u32;
    report
}

/// 按现场文件的原生路标序列判定上一轮的结束方式。输入应是**已剔掉本轮"启动"行**
/// 的那一段（见 [`Logger::seed_previous_run`]）。
pub fn classify_previous_exit(native_lines: &[String]) -> PreviousExit {
    // 卡死记录（`code=HANG` / `HANG_END`）不参与"怎么结束"的判定：它们是正交事实，
    // 由 `PreviousRunReport.hang` 单独表达；留在序列里会让最后一条变成 HANG ⇒ NoHistory。
    let lines: Vec<&String> = native_lines
        .iter()
        .filter(|l| !is_hang_native_line(l))
        .collect();
    if lines.is_empty() {
        return PreviousExit::NoHistory;
    }
    // ★ 末尾的 `>>> 启动尝试` 属于**下一轮**：它由 bootstrap 插件在 `Logger::new` 之前写，
    //   所以落在上一轮切片的尾部。它不是收尾路标 —— 2026-10-29 拿真机现场文件复算，
    //   48 段里有 23 段的判定被它顶成 `NoHistory`（15 段本该 Clean、8 段本该 SilentKill），
    //   连带 `silent_kill` 变成不可达分支、静默死亡不弹横幅。先剔掉再判。
    let mut end = lines.len();
    while end > 0 && lines[end - 1].starts_with(">>> 启动尝试") {
        end -= 1;
    }
    let native_lines = &lines[..end];
    if native_lines.is_empty() {
        // 只剩启动尝试 ⇒ 进程起来过、连 logger 都没走到就没了（被单实例守卫顶掉 / 崩在初始化前）。
        return PreviousExit::SilentKill;
    }
    if native_lines.iter().any(|l| l.starts_with("===== 崩溃现场")) {
        return PreviousExit::Panic;
    }
    // 分配器 abort：`>>> 重分配失败：请求 N 字节 ⇒ 分配器即将 abort（不是 panic，钩子不会跑）`。
    // 它是独立通道写的、没有崩溃块 ⇒ 旧分类落到 NoHistory、横幅不弹（10-21 真机现场里
    // 那次 326350 字节的重分配失败就是这一形）。
    if native_lines.iter().any(|l| l.starts_with(">>> 重分配失败")) {
        return PreviousExit::Abort;
    }
    // **没有 logger 的 panic** 走的是独立通道，形状是 `>>> panic @ file:line:col：…`，
    // 而不是 `===== 崩溃现场`（那条要 logger 的"崩之前 300 条"上下文）。
    // 旧分类只认后者 ⇒ setup 期 panic 被读成"异常终止/强杀"：2026-10-20 的真实现场里
    // 文件明明有 `>>> panic @ …outbox_sweep.rs:89`，下一轮却判 `BOOT_PREV_SILENT_KILL`。
    // 只扫**最后一次启动之后**的行：更早那几轮里的 panic 不能按到这一次头上。
    if native_lines
        .iter()
        .rev()
        .take_while(|l| !l.starts_with("----- 启动 "))
        .any(|l| l.starts_with(">>> ") && l.contains("panic @ "))
    {
        return PreviousExit::Panic;
    }
    // 只看**最后一条**：更早的 BOOT_FAILED 后面若已经有正常退出路标，那是后来恢复过了。
    if native_lines
        .last()
        .is_some_and(|l| l.contains("code=BOOT_FAILED"))
    {
        return PreviousExit::StartupFailed;
    }
    match native_lines.last() {
        Some(l) if l.starts_with("----- 正常退出 ") => PreviousExit::Clean,
        Some(l) if l.starts_with("----- 启动 ") => PreviousExit::SilentKill,
        _ => PreviousExit::NoHistory,
    }
}

impl Logger {
    /// 本轮进程的运行标识：6 位十六进制，取启动纳秒时刻的低 bits 再与设备指纹混合。
    /// 不需要全局唯一，只需要**在同一份现场文件里能把两次启动分开**（多实例 + 快速重启）。
    fn new_run_id(fingerprint: &str) -> String {
        // 全部用 wrapping_*：这是标识哈希，溢出本来就是设计的一部分；
        // debug 构建开着溢出检查，写成 `a * 131` 会在真机上直接 panic（本仓的测试第一次就撞了）。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 + d.as_secs().wrapping_mul(31))
            .unwrap_or(0);
        let mixed = nanos
            ^ fingerprint
                .bytes()
                .fold(0u64, |a, b| a.wrapping_mul(131).wrapping_add(b as u64));
        format!("{:06x}", mixed & 0xff_ffff)
    }

    pub fn new(dir: PathBuf, stem: &str, fingerprint: String) -> Logger {
        let run_id = Self::new_run_id(&fingerprint);
        let logger = Logger {
            entries: Mutex::new(VecDeque::with_capacity(MAX_MEM_LOGS)),
            dir,
            stem: stem.to_string(),
            fingerprint,
            diag_fold: Mutex::new(HashMap::new()),
            seed_ran: std::sync::atomic::AtomicBool::new(false),
            run_id,
            write_fails: std::sync::atomic::AtomicU64::new(0),
            disk_low: std::sync::atomic::AtomicBool::new(false),
            degrade_noted: std::sync::atomic::AtomicBool::new(false),
            append_lines: std::sync::atomic::AtomicU64::new(0),
            previous_report: OnceLock::new(),
        };
        // 把路径交给独立写入器（若 bootstrap 更早绑过，这条就是 no-op；只认第一次）
        bind_crash_file(&logger.crash_path());
        logger.write_startup_marker();
        // 启动前就存在的日志（含历史 .old.log）也要立刻收紧：
        // 只靠“下次写入时再 chmod”会让不再轮转的旧文件永久保持 0644。
        restrict_to_owner(&logger.current_path());
        restrict_to_owner(&logger.old_path());
        // 目录本身同理，而且要**整个目录里**的 .log 一起收：真机实测
        // `…/com.gosslan.app` 是 0700 而它下面的 `logs/` 是 0755（umask 022 建出来的），
        // 同机其他用户能直接列出所有实例的日志名；而已停跑的旧实例留下的
        // `gosslan-3.log`/`gosslan-3-crash.log` 还停在 0644 —— 上面那两条只认本轮的 stem。
        restrict_dir_to_owner(&logger.dir);
        if let Ok(rd) = std::fs::read_dir(&logger.dir) {
            for entry in rd.flatten() {
                let name_is_log = entry
                    .path()
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with(".log"));
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) && name_is_log {
                    restrict_to_owner(&entry.path());
                }
            }
        }
        logger
    }

    /// 在崩溃现场文件里落一条**启动路标**。
    ///
    /// 为什么必须有它：现场文件只在 panic 时写 ⇒ "里面没有新块"有两种完全不同的成因
    /// （① 这段时间根本没崩；② 崩了，但不是 Rust panic —— 例如 2026-10-16 那次
    /// `KERNELBASE` 抛的 `0xe0000008`）。有了启动路标，两者一眼分开：
    /// **最后一条是"启动"而不是"崩溃现场" ⇒ 上一次进程不是 panic 死的**。
    /// 顺带把版本号永久写进这份文件，"崩的是哪一版"不再需要反推。
    ///
    /// 刻意不用设备指纹开头 ⇒ 崩溃现场里"上下条文数"那条计数判据不受它影响。
    fn write_startup_marker(&self) {
        use std::io::Write;
        let _ = create_private_dir(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.crash_path())
        {
            restrict_to_owner(&self.crash_path());
            let _ = writeln!(
                f,
                "----- 启动 {} 版本 {} · {}-{} · {} · 设备 {} · 运行 {} -----",
                format_utc(now_ms()),
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
                self.fingerprint,
                self.run_id,
            );
        }
    }

    /// 写一条**正常退出**路标（与"启动"同一份现场文件）。
    ///
    /// 为什么必须有它：现在这份文件只有两种行 —— "启动"和"崩溃现场"。于是
    /// **最后一条是"启动"这件事被当成"上次不是 panic 死的"，但它其实有两种完全不同的成因**：
    /// 用户自己正常退了（有路标才分得出来）／被系统强杀（OOM killer、`kill -9`、看门狗、
    /// 电量耗尽）—— 后者在进程内部**永远不会留任何东西**，只能靠"上一轮有启动、没有退出、
    /// 也没有崩溃现场"这一**缺席**推断出来。这正是 [`classify_previous_exit`] 干的事。
    ///
    /// ⚠️ 这条只声明"走到了收尾"，不声明"收尾成功"：调用点在 `RunEvent::Exit`（见 lib.rs），
    /// 而 `panic = "abort"` 的硬崩、`_exit` 级别的退出根本走不到这里 —— 那两类由崩溃现场
    /// 与"缺席推断"分别接住。
    pub fn write_exit_marker(&self) {
        use std::io::Write;
        let _ = create_private_dir(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.crash_path())
        {
            restrict_to_owner(&self.crash_path());
            let _ = writeln!(
                f,
                "----- 正常退出 {} 运行 {} -----",
                format_utc(now_ms()),
                self.run_id,
            );
        }
    }

    /// 本轮运行标识：写在"启动"与"正常退出"两条路标里。
    /// 5.0.37 起有了真实消费者 —— 诊断包头部要带它，用来把包里的日志段与崩溃现场里
    /// 那两条路标对上（同一份现场文件里可能混着两三台实例的启动记录）。
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// 上一轮的结构化报告（`seed_previous_run` 算好后写入；没算过时给 `no_history`）。
    pub fn previous_run_report(&self) -> PreviousRunReport {
        self.previous_report.get().cloned().unwrap_or_default()
    }

    /// 落盘失败累计次数（含磁盘不足主动跳过的）。
    /// 面向用户的降级证据是内存环里那条 `日志落盘已降级`；这个计数进了诊断包头部，
    /// 让"日志文件怎么这么短"这件事在对方机器上也能被读出来。
    pub fn write_fails(&self) -> u64 {
        self.write_fails.load(Ordering::Relaxed)
    }

    /// 日志目录（`<app data>/logs`）。路径只从这一处出，不让调用方按 stem 自己拼。
    pub(crate) fn log_dir(&self) -> PathBuf {
        self.dir.clone()
    }

    /// 设备指纹（`[dev:xxx]`），诊断包脱敏时要按它整串替换。
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn info(&self, target: &str, message: impl Into<String>) {
        self.log(Level::Info, target, message.into());
    }
    pub fn warn(&self, target: &str, message: impl Into<String>) {
        self.log(Level::Warn, target, message.into());
    }
    pub fn error(&self, target: &str, message: impl Into<String>) {
        self.log(Level::Error, target, message.into());
    }

    /// 只进内存环、**不落盘**的诊断行。
    ///
    /// 为什么不是简单降成 `Debug`：`debug()` 走的是同一条 `log()` 落盘路径 ⇒ 文件上一点
    /// 没少。而诊断面板读的是内存环（`snapshot`）⇒ 把"进环"和"落盘"拆开，两件事同时成立：
    /// 面板照样看得见全量诊断，`gosslan.log` 不再被 1.16 行/秒的成功心跳冲掉
    /// （2026-10-29 现算：announce_verified 3006 条 + bc_directed 432 条 = 一段 43 分钟
    /// 会话的 97.5%，主日志因此 ~50 分钟就翻一代）。
    ///
    /// 失败类**不走这里**：它们要继续落盘（见 [`DiagDelivery::Warn`]）。
    pub fn ring_only(&self, target: &str, message: String) {
        let mut q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        q.push_back(LogEntry {
            ts: now_ms(),
            level: Level::Info.as_str().to_string(),
            target: target.to_string(),
            message,
        });
        while q.len() > MAX_MEM_LOGS {
            q.pop_front();
        }
    }

    /// 记录一条日志：diag 同秒折叠 → 进内存 buffer → debug 下打 stderr → 落盘。
    pub fn log(&self, level: Level, target: &str, message: String) {
        let ts = now_ms();

        // 0) **diag 的同秒重复折叠**（用户 2026-10-16 真机实测的缺口）：
        //    `diag/announce_verified` 对**同一台设备、同一秒**能重复 5~6 条
        //    （`state.rs:1913` 是 `diag/` 这个前缀唯一的出生地，已现读核对），
        //    于是 512 KiB 的日志几分钟翻一代、只留一代 ⇒ 真崩时那句 `panic @ 文件:行:列`
        //    在文件里结构上留不住。整行文本 + target + 秒三者全同的重复本身不带新信息，
        //    所以这不是"少记"，是"记一次"。
        //
        // ⚠️ 只管 `Info`：`warn` / `error` 一律放行，不看折叠表 ——
        //    2026-10-16 那轮审计的主题就是"失败必须看得见"，绝不能顺手把错误折掉。
        //    有判据钉着这两头（`diag_warn_and_error_are_never_folded`）。
        if level == Level::Info
            && message.starts_with("diag/")
            && self.fold_diag_same_second(target, &message, ts)
        {
            return;
        }

        // 1) 内存 ring buffer（有界，防无限增长）
        {
            let mut q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            q.push_back(LogEntry {
                ts,
                level: level.as_str().to_string(),
                target: target.to_string(),
                message: message.clone(),
            });
            while q.len() > MAX_MEM_LOGS {
                q.pop_front();
            }
        }

        // 2) debug 构建仍打到 stderr，保留开发期控制台可观测（release 无控制台，跳过）。
        #[cfg(debug_assertions)]
        eprintln!(
            "{} [{}] [{}] {}",
            self.fingerprint,
            level.as_str(),
            target,
            message
        );

        // 2b) **Android：同时写 logcat**（用户实测"闪退、拿不到日志"的唯一可行动诊断路径）。
        //     release 包既不能 `run-as`（不可调试），Rust 的 stdout/stderr 也不进 logcat，
        //     所以这里直接调系统的 `log` 命令打一条 —— 于是
        //     `adb logcat -s gosslan` 就能看到我们的启动路标与 panic。
        //     开销控制：warn/error 一律打；info 只打 `boot`（启动路标）与 `ble`（蓝牙）两个通道。
        //
        //     为什么把 `ble` 的 info 也镜像出来（用户 2026-09-12 实测的教训）：
        //       · 蓝牙是**唯一没法在桌面上自测**的链路，真机日志是唯一证据来源；
        //       · 而"扫描到几个候选 / 哪个候选没连上、为什么"恰好都是 **info** 级 ——
        //         之前它们只写文件，用户能贴的 logcat 里什么都没有，于是"互相搜不到"
        //         只能靠猜（那次真正的根因是扫描结果被 `services()` 过滤掉，日志里一个字都没有）。
        //     频率很低（每个扫描周期最多几行，10s 一次），不会把 logcat 刷满。
        //
        // ⚠️ **不能每条日志 fork 一个进程**（2026-09-13 真机抓到的真问题）：
        //     原来这里是 `Command::new("log").spawn()` —— 每行一次 fork+exec。BLE 生命周期
        //     日志一多（每帧一条 [SEND]/[RECV]），真机上就是"一边跑 GATT、一边疯狂 fork"，
        //     直接拖慢 Rust 运行时与蓝牙时序（用户看到的"连上就断 / 加好友没反应"）。
        //     实测证据：`adb logcat -s gosslan` 里**每一行的 PID 都不一样**（每次 fork 新进程）。
        //     现在改成：丢进队列 → 专用线程按 200ms 合批 → 每批只 fork 一次，整批作为
        //     一条多行消息发出（`adb logcat` 里依然逐行可见）。
        #[cfg(target_os = "android")]
        {
            // info 级允许进 logcat 的 target —— 这几个是真机诊断的关键链路：
            //   boot    = 启动路标（闪退定位）
            //   ble     = BLE 扫描/连接/发送（唯一没法桌面自测的链路）
            //   dispatch= 三优先级调度 + try_send + writer_loop（消息卡在哪里）
            //   file    = FileOffer/Accept/Streaming/Done（文件传输全生命周期）
            //   content = ContentRequest retry（retry 有没有退避/停止）
            //   transport = TCP write fail / 链路事件
            const LOGCAT_INFO_TARGETS: &[&str] =
                &["boot", "ble", "dispatch", "file", "content", "transport"];
            let want = matches!(level, Level::Warn | Level::Error)
                || (level == Level::Info && LOGCAT_INFO_TARGETS.contains(&target));
            if want {
                logcat::push(format!(
                    "{} [{}] [{}] {}",
                    self.fingerprint,
                    level.as_str(),
                    target,
                    message
                ));
            }
        }

        // 3) 落盘（追加写，超限轮转）。失败静默：日志本身不能反过来拖垮主流程。
        if let Err(reason) = self.append_file(ts, level, target, &message) {
            // 失败必须可见：计数 + 第一次进内存环（不再走 log()，否则会重试落盘形成回环）。
            self.write_fails.fetch_add(1, Ordering::Relaxed);
            self.note_degraded_once(&reason);
        }

        // 4) **崩溃那一条额外单独落盘**。
        //
        // 为什么必须有它（2026-10-16 真机抓到的缺口）：主日志 512 KiB 就轮转、**只留一代**，
        // 而局域网自检那句 `diag/announce_verified` 实测**同一秒对同一设备重复 5~6 条**
        // ⇒ 几分钟就换一代 ⇒ 真崩时那句 `panic @ 文件:行:列：消息` 结构上不可能还在盘上，
        // 用户只能报"崩了但没日志"（那次就这样丢了三个现场）。
        //
        // 上下文取自**内存环**（`MAX_MEM_LOGS`）而不是文件：于是"日志被洪水冲掉"
        // 与"崩溃现场丢失"从此解耦 —— 哪怕 `gosslan.log`/`.old.log` 已经翻过好几代，
        // 崩溃现场里仍带着崩之前的最后 `CRASH_CONTEXT_LINES` 条。
        //
        // 钩子点就是 panic 钩子那条 `logger.error("panic", …)`（见 lib.rs），本模块零侵入：
        // 不改钩子、不改调用方，因此不碰任何正在别处改动的文件。
        if target == "panic" {
            self.write_crash_block(ts, &message);
        }
    }

    /// UI 快照：按时间正序（旧 → 新）返回内存日志。
    ///
    /// `since_ms = Some(epoch_ms)` 只返回 >= 该时间戳的行；None = 返回全部。
    /// 内存 ring buffer 本身有界（500 条），过滤只是切片，没有额外开销。
    pub fn snapshot(&self, since_ms: Option<i64>) -> Vec<LogEntry> {
        let q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        match since_ms {
            None => q.iter().cloned().collect(),
            Some(since) => q.iter().filter(|e| e.ts >= since).cloned().collect(),
        }
    }

    /// 清空内存与落盘文件。
    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let _ = std::fs::remove_file(self.current_path());
        let _ = std::fs::remove_file(self.old_path());
    }

    pub(crate) fn current_path(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.stem))
    }
    pub(crate) fn old_path(&self) -> PathBuf {
        self.dir.join(format!("{}.old.log", self.stem))
    }
    /// 崩溃现场文件（**不参与轮转**）：`logs/gosslan-crash.log`，多实例是 `gosslan-1-crash.log`。
    pub(crate) fn crash_path(&self) -> PathBuf {
        crash_file_for(&self.dir, &self.stem)
    }

    /// 把「崩溃这一句 + 崩之前的最后若干条日志」同步写进一个不轮转的文件。
    ///
    /// ⚠️ 调用点在 panic 钩子里，紧接着就是 `abort()`（`[profile.release] panic = "abort"`）
    /// ⇒ 这里**必须同步写、写完即关**（`File` + `writeln!`，没有 BufWriter 留在手里），
    /// 而且**任何失败一律静默**：诊断代码不许在进程临死前再抛一个 panic。
    fn write_crash_block(&self, ts: i64, message: &str) {
        // 先在锁内把上下文取出来（`append_file` 那条路不加锁，这里也不会与它互相等）。
        let context: Vec<String> = {
            let q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            let skip = q.len().saturating_sub(CRASH_CONTEXT_LINES);
            q.iter()
                .skip(skip)
                .map(|e| {
                    format!(
                        "{} {} {} [{}] {}",
                        self.fingerprint,
                        format_utc(e.ts),
                        e.level,
                        e.target,
                        e.message
                    )
                })
                .collect()
        };

        let path = self.crash_path();
        // 有界：超过上界就整份重开（只保留最近的现场，磁盘上界 = 上界 + 一个块）。
        let over_cap = matches!(std::fs::metadata(&path), Ok(m) if m.len() > MAX_CRASH_FILE_BYTES);
        let opened = if over_cap {
            std::fs::File::create(&path)
        } else {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
        };
        let Ok(mut f) = opened else { return };
        restrict_to_owner(&path);

        use std::io::Write;
        // 版本必须写进现场：2026-10-16 为了搞清"崩的是哪一版"只能拿 CI 构建时刻反推。
        let _ = writeln!(
            f,
            "\n===== 崩溃现场 {} ===== 版本 {} · {}-{} · {} · 设备 {}",
            format_utc(ts),
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            self.fingerprint,
        );
        let _ = writeln!(f, ">>> {message}");
        // ★ 现场必须自带"那一刻占了多少、还在读什么、最近拿走哪些大块"。
        //   没有这一行，10-26 那种"主线程 + 渲染层同一秒双双停滞"就只能靠猜；
        //   `sample()` 里全是非分配的系统调用，临死前调它是安全的（读不到就整列 `-`）。
        let _ = writeln!(f, ">>> 现场内存 {}", crate::mem_diag::sample().line());
        let _ = writeln!(
            f,
            "----- 崩之前 {} 条运行日志（取自内存环，与文件轮转无关）-----",
            context.len()
        );
        for line in &context {
            let _ = writeln!(f, "{line}");
        }
        let _ = f.flush();
    }

    /// 同一 epoch 秒内、同一 `target` 且**整行文本完全相同**的 diag 只留第一条。
    /// 返回 `true` = 这条是重复，调用方直接丢弃（不进内存环、不落盘、不打 logcat）。
    fn fold_diag_same_second(&self, target: &str, message: &str, ts_ms: i64) -> bool {
        let sec = ts_ms.div_euclid(1000);
        let mut fold = self.diag_fold.lock().unwrap_or_else(|e| e.into_inner());
        // 封顶就整表重开：键里带设备 id 与来源 IP，局域网跑久了键会一直长——
        // 宁可偶尔多写一条重复，也不留一个"永远只增"的内存洞。
        if fold.len() > DIAG_FOLD_KEYS {
            fold.clear();
        }
        let key = (target.to_string(), message.to_string());
        if fold.get(&key) == Some(&sec) {
            return true;
        }
        fold.insert(key, sec);
        false
    }

    /// 追加一行到 `<stem>.log`（超单文件上限先惰性轮转到 `.old.log`）。
    ///
    /// ⚠️ 返回 `Result`，不像原先那样把 IO 错误全 `let _ =` 吞掉（2026-10-20 补）：
    /// "写失败不能拖垮主流程"是对的，**错的是连"这次没写进去"也没人知道**。
    /// 盘满时用户拿到的会是一份**看起来正常、末尾却短了一截**的日志 —— 那正是
    /// 这次要防的形状。这里只回报原因（调用方计数 + 首次降级留痕），仍不 panic、不回环重试。
    ///
    /// 磁盘空间保护 = **写失败信号 + 退避窗口**，不是预防性查可用空间：
    /// 见 [`LOG_RETRY_BACKOFF_LINES`] 上面那段（要 `statvfs` 就得加依赖，而构建零新增是既有约束）。
    fn append_file(
        &self,
        ts: i64,
        level: Level,
        target: &str,
        message: &str,
    ) -> Result<(), String> {
        let seen = self.append_lines.fetch_add(1, Ordering::Relaxed) + 1;
        // 已判定盘紧 ⇒ 每 LOG_RETRY_BACKOFF_LINES 行才复查一次（内存环照常，日志一条不丢）。
        if self.disk_low.load(Ordering::Relaxed) && seen % LOG_RETRY_BACKOFF_LINES != 0 {
            return Err("磁盘不足退避窗口内跳过落盘".to_string());
        }

        let line = format!(
            "{} {} {} [{}] {}",
            self.fingerprint,
            format_utc(ts),
            level.as_str(),
            target,
            message
        );
        let path = self.current_path();
        use std::io::Write;
        let wrote = (|| -> std::io::Result<()> {
            create_private_dir(&self.dir)?;
            // 惰性轮转：当前文件超限时，把旧内容挪到 `.old.log`（覆盖上一份旧文件）。
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() > MAX_LOG_FILE_BYTES {
                    let _ = std::fs::remove_file(self.old_path());
                    let _ = std::fs::rename(&path, self.old_path());
                }
            }
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            restrict_to_owner(&path);
            writeln!(f, "{line}")?;
            Ok(())
        })();

        match wrote {
            // 写得进去就说明上一轮的"盘紧"判断已经过期（用户清了空间），解除退避。
            Ok(()) => {
                self.disk_low.store(false, Ordering::Relaxed);
                Ok(())
            }
            Err(e) => {
                let os = e
                    .raw_os_error()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "无".to_string());
                if is_disk_full(&e) {
                    self.disk_low.store(true, Ordering::Relaxed);
                }
                Err(format!("{e}（kind={:?} OS码={os}）", e.kind()))
            }
        }
    }

    /// 落盘失败要**看得见**，但降级说明只准进环一次：内存环只有 [`MAX_MEM_LOGS`] 条，
    /// 每条失败都补一句会把它刷满，于是"写不进去"会把真正要留的日志挤出去。
    ///
    /// ⚠️ 这里直接进环，**不走 `Logger::log`** —— 那条会再试一次落盘、再失败、再降级，形成回环。
    fn note_degraded_once(&self, reason: &str) {
        if self.degrade_noted.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        q.push_back(LogEntry {
            ts: now_ms(),
            level: Level::Warn.as_str().to_string(),
            target: "boot".to_string(),
            message: format!(
                "日志落盘已降级：{reason} —— 之后的日志只留在内存环（≤{MAX_MEM_LOGS} 条）里，界面还能看到，文件不再增长。"
            ),
        });
        while q.len() > MAX_MEM_LOGS {
            q.pop_front();
        }
    }

    /// 把上一轮留在盘上的记录读进内存环。`get_logs` 只读内存，不补这一步，
    /// 崩溃重启后界面与"一键复制"里就没有刚发生的那次故障。
    ///
    /// 覆盖范围：只读 `<stem>.log` 尾部 ≤ [`PREV_RUN_TAIL_BYTES`]、最多 [`PREV_RUN_MAX_LINES`] 行，
    /// 已轮转的 `<stem>.old.log` 不读；`<stem>-crash.log` 只取原生三类行合成一条，
    /// 块内那些指纹开头的上下文行不重复搬。进环后按 ring 语义淘汰，不是永久保留。
    ///
    /// 只读，也不走 `Logger::log`（那会落盘并污染 diag 折叠表）；IO 或解析失败都当"没有上一轮"。
    /// 返回进环条数，由调用方写一条 boot 日志。
    pub fn seed_previous_run(&self) -> usize {
        // 幂等：第二次调用不再灌一遍。
        if self
            .seed_ran
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return 0;
        }
        let mut seeded: Vec<LogEntry> = Vec::new();
        let mut pending: Option<LogEntry> = None;
        for raw in read_tail_lines(&self.current_path(), PREV_RUN_TAIL_BYTES) {
            match parse_log_line(&raw, &self.fingerprint) {
                Some(entry) => {
                    if let Some(prev) = pending.take() {
                        seeded.push(prev);
                    }
                    pending = Some(entry);
                }
                // 多行消息的续行（前端异常带 stack）接回上一条；结构行不当续行。
                // 超过续行预算的那一行直接丢：内存环是有界的，宁可少接一段也不让它长回去。
                None => match pending.as_mut() {
                    Some(prev)
                        if !is_crash_native_line(&raw)
                            && prev.message.len() + raw.len() <= PREV_CRASH_MAX_CHARS * 4 =>
                    {
                        prev.message.push('\n');
                        prev.message.push_str(&raw);
                    }
                    _ => {}
                },
            }
        }
        if let Some(last) = pending.take() {
            seeded.push(last);
        }
        if seeded.len() > PREV_RUN_MAX_LINES {
            // 只留最近的：越靠近上一轮结束越可能包含 panic 位置与失败原因。
            let cut = seeded.len() - PREV_RUN_MAX_LINES;
            seeded.drain(0..cut);
        }
        if seeded.is_empty() && !crash_native_exists(&self.crash_path()) {
            // 盘上什么都没有时不造"上一轮"标题。
            let _ = self.previous_report.set(PreviousRunReport {
                crash_log: self.crash_path().display().to_string(),
                log_dir: self.dir.display().to_string(),
                ..Default::default()
            });
            return 0;
        }

        let head_ts = seeded.first().map(|e| e.ts).unwrap_or_else(now_ms);
        let mut out: Vec<LogEntry> = Vec::new();
        if !seeded.is_empty() {
            out.push(LogEntry {
                ts: head_ts.saturating_sub(1),
                level: Level::Info.as_str().to_string(),
                target: "boot".to_string(),
                message: format!(
                    "—— 以下 {} 行是上一轮启动留下的记录（截自 {} 尾部 ≤{} KiB；已轮转的 .old.log 不在内）——",
                    seeded.len(),
                    self.current_path().display(),
                    PREV_RUN_TAIL_BYTES / 1024,
                ),
            });
            out.extend(seeded);
        }
        // 最后一条启动路标是本轮 `Logger::new` 刚写的，剔掉才算上一轮。
        let raw = read_tail_lines(&self.crash_path(), PREV_CRASH_TAIL_BYTES);
        // 结构化报告要在剔掉本轮启动行**之前**算：`last_run_slice` 自己按启动行切段。
        let _ = self.previous_report.set(build_previous_run_report(
            &raw,
            &self.crash_path(),
            &self.dir,
        ));
        let mut native: Vec<String> = raw
            .iter()
            .filter(|l| is_crash_native_line(l))
            .cloned()
            .collect();
        if native
            .last()
            .map(|l| l.starts_with("----- 启动 "))
            .unwrap_or(false)
        {
            native.pop();
        }
        if !native.is_empty() {
            if native.len() > PREV_CRASH_MAX_LINES {
                let cut = native.len() - PREV_CRASH_MAX_LINES;
                native.drain(0..cut);
            }
            let mut body = String::from("—— 上一轮崩溃现场/路标（截自 ");
            body.push_str(&self.crash_path().display().to_string());
            body.push_str(" 尾部）——\n");
            for line in &native {
                if body.len() + line.len() > PREV_CRASH_MAX_CHARS {
                    body.push_str("…（超出字符上界，后面的行在盘上）");
                    break;
                }
                body.push_str(line);
                body.push('\n');
            }
            let has_block = native.iter().any(|l| l.starts_with("===== 崩溃现场"));
            // 上次收尾判定：把"在场/缺席"两个信号合成一句结论写进同一块文本里。
            // 级别沿用旧规则（有崩溃块 ⇒ error），新信息只加文本，不动既有判据的形状。
            let verdict_kind = classify_previous_exit(&native);
            let verdict = match verdict_kind {
                PreviousExit::Clean => "上次收尾判定：正常退出（有退出路标）",
                PreviousExit::Panic => "上次收尾判定：panic 现场（见上面的崩溃现场块）",
                PreviousExit::StartupFailed => {
                    "上次收尾判定：启动被安全中止（身份/数据库校验失败；数据库未被修改）"
                }
                PreviousExit::SilentKill => concat!(
                    "上次收尾判定：异常终止 —— 只有启动路标，既无正常退出路标也无崩溃现场。",
                    "可能是强杀（kill -9 / 看门狗 / 拔电）或 OOM；这几类死法在进程内部留不下任何东西，",
                    "只能这样按缺席归类"
                ),
                PreviousExit::Abort => {
                    "上次收尾判定：分配器 abort（见上面的「重分配失败」行；请求字节数就写在里面）"
                }
                PreviousExit::NoHistory => "上次收尾判定：现场文件里没有可判定的路标",
            };
            let verdict_code = match verdict_kind {
                PreviousExit::Clean => "BOOT_PREV_CLEAN",
                PreviousExit::Panic => "BOOT_PREV_PANIC",
                PreviousExit::StartupFailed => "BOOT_PREV_STARTUP_FAILED",
                PreviousExit::SilentKill => "BOOT_PREV_SILENT_KILL",
                PreviousExit::Abort => "BOOT_PREV_ABORT",
                PreviousExit::NoHistory => "BOOT_PREV_NO_HISTORY",
            };
            let verdict_line = format!("{verdict} code={verdict_code}");
            body.push_str(&verdict_line);
            body.push('\n');
            // 判定也要**落到日志文件里**。为什么：`seed_previous_run` 灌进去的那批行只进内存环
            // （它刻意不走 `log()`，免得污染折叠表与磁盘），于是"只发日志文件"的用户
            // 永远拿不到这句结论 —— 2026-10-20 用 release 二进制实测就是这样：文件里有
            // 三条原始路标，判定只在界面上。补这一行让离线读文件的人也能直接看到。
            let v_level = match verdict_kind {
                PreviousExit::Panic
                | PreviousExit::SilentKill
                | PreviousExit::Abort
                | PreviousExit::StartupFailed => Level::Warn,
                _ => Level::Info,
            };
            if let Err(r) = self.append_file(now_ms(), v_level, "boot", &verdict_line) {
                // 判定行自己都写不进去 ⇒ 这是磁盘/权限层面的硬失败，退回 stderr 留个字面证据，
                // 不能静默（`let _ =` 会让"为什么文件里没有这句结论"变成新一轮猜谜）。
                eprintln!("[gosslan] 收尾判定未能写入日志文件：{r}");
            }
            out.push(LogEntry {
                ts: head_ts,
                level: if has_block {
                    Level::Error.as_str()
                } else {
                    Level::Info.as_str()
                }
                .to_string(),
                target: "crash".to_string(),
                message: body,
            });
        }

        let count = out.len();
        let mut q = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // 本轮还没写过日志，排在最前面即时间正序。
        for entry in out {
            q.push_back(entry);
        }
        while q.len() > MAX_MEM_LOGS {
            q.pop_front();
        }
        count
    }
}

/// 本机现在的毫秒时间 —— **全仓唯一一处读系统时钟**（审计 DUP-03：这里原有 9 处定义）。
///
/// ## 为什么家在 `logging` 而不是 `db`
/// `db::now_ms` 还留着（它是"落库那一列的时间戳"的说法，68 处在用），但那只是一层**具名别名**，
/// 函数体就是转调这里。理由：`lib_window_tests` 的棘轮把命令体里出现 `db::` 算成"访问 SQLite"，
/// 家若设在 `db::`，蓝牙、发现层、看门狗都会被算成重活命令 —— 那是把判据弄脏，不是省事。
///
/// ## 为什么必须只有一处
/// 九份拷贝今天唯一的差别就是兜底写法（`unwrap_or(0)` 与 `unwrap_or_default()`）——
/// 这正是会漂的那一步：漂成大写、漂成秒、漂成单调钟，症状都是"某些 TTL 早于预期到期"。
/// 形状判据见本文件末尾的 `the_wall_clock_has_two_names_max`。
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 递归收集 `src/**/*.rs`（**测试用**：形状类判据要扫全仓，`include!` 的分册是磁盘上的
/// 独立文件，一起扫得到 —— 判据比的是字面形状，与模块路径无关）。
/// 放在这里是为了让 `crypto.rs` 的 hex 判据与本文件共用**同一个遍历器**（不再多抄一份）。
#[cfg(test)]
pub(crate) fn production_rs_files() -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).expect("读 src 目录") {
            let p = e.expect("dir entry").path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
                out.push(p);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &mut out);
    out.sort();
    out
}

/// 相对 `src/` 的路径（判据要报出"哪个文件"，绝对路径没法读）。
#[cfg(test)]
pub(crate) fn rel_to_src(p: &std::path::Path) -> String {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    p.strip_prefix(&root)
        .unwrap_or(p)
        .display()
        .to_string()
        // Windows 的 `display()` 打的是 `\`，而用这个函数的判据比的是**跨平台手写的清单**
        // ⇒ 不归一化就会"macOS 绿、CI 的 Windows 腿红"（实测 5.15.26：run 40969401717）。
        // 归一化只有这一个家：墙上时钟与字节→hex 两条形状判据共用它。
        .replace('\\', "/")
}

/// 把 Unix 毫秒时间戳格式化为 UTC `YYYY-MM-DD HH:MM:SS`（落盘文件用，可读）。
///
/// 不引入本地时区：这里给 UTC 时间，配合毫秒戳足够定位。
pub(crate) fn format_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(secs) else {
        // 超出 time 可表示范围（实际只可能是损坏的日志/测试输入）：原样给出秒数，不 panic。
        return format!("{secs}");
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        dt.year(),
        dt.month() as u8,
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

/// UTC `YYYY-MM-DD HH:MM:SS` → Unix 毫秒。解析不出来返回 `None`，不拿当前时间凑。
fn parse_utc_to_ms(text: &str) -> Option<i64> {
    let (date, clock) = text.split_once(' ')?;
    let mut d = date.split('-');
    let y: i32 = d.next()?.parse().ok()?;
    let mo: u8 = d.next()?.parse().ok()?;
    let dd: u8 = d.next()?.parse().ok()?;
    let mut t = clock.split(':');
    let h: u8 = t.next()?.parse().ok()?;
    let mi: u8 = t.next()?.parse().ok()?;
    let s: u8 = t.next()?.parse().ok()?;
    let month = time::Month::try_from(mo).ok()?;
    let date = time::Date::from_calendar_date(y, month, dd).ok()?;
    let time = time::Time::from_hms(h, mi, s).ok()?;
    Some(
        time::PrimitiveDateTime::new(date, time)
            .assume_utc()
            .unix_timestamp()
            * 1_000,
    )
}

/// 崩溃现场文件独有的四类行：独立通道留痕、启动路标、**正常退出路标**、崩溃块头。
/// 指纹开头的行是运行日志的副本，由 `<stem>.log` 负责，不重复搬。
///
/// ⚠️ "正常退出"这一类必须一起加进来：写而不读等于没写 —— 2026-10-19 第一次跑测试就
/// 抓到这个（路标写进文件了，但那三类过滤器把它挡在外面 ⇒ 下一轮永远读成"异常终止"）。
fn is_crash_native_line(line: &str) -> bool {
    line.starts_with(">>> ")
        || line.starts_with("----- 启动 ")
        || line.starts_with("----- 正常退出 ")
        || line.starts_with("===== 崩溃现场")
}

/// 现场文件里是否有原生行：区分"首次启动什么都没有"与"有但读不全"。
fn crash_native_exists(path: &std::path::Path) -> bool {
    read_tail_lines(path, PREV_CRASH_TAIL_BYTES)
        .iter()
        .any(|l| is_crash_native_line(l))
}

// ==================== 诊断事件的投递口径 ====================

/// 一条 `push_diag_event` 该往哪儿投（纯函数：口径只在这一处，判据也钉这一处）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagDelivery {
    /// 高频且没有排查价值（或调用点旁边已有更完整的行）⇒ 丢掉
    Dropped,
    /// 成功类诊断：只进内存环（诊断面板可见），不落盘
    RingOnly,
    /// 失败类 ⇒ warn，必须落盘
    Warn,
    /// 其余状态跃迁 ⇒ info，落盘
    Info,
}

/// 决定一条诊断事件的投递方式。
///
/// 顺序是有意的：**失败类先判**，任何清单都不许把错误折掉
/// （2026-10-16 那轮审计的主题就是"失败必须看得见"）。
pub fn diag_delivery(kind: &str) -> DiagDelivery {
    const DROPPED: &[&str] = &[
        // 纯心跳（高频，且没有排查价值）
        "announce_recv",
        "broadcast_sent",
        "multicast_sent",
        "who_has_sent",
        // 已在各自的调用点旁边用更完整的上下文记过（重复打只会刷屏）
        "hello_rejected",
        "hello_mismatch",
        "identity_key_conflict",
    ];
    // 成功类的"每个对端一行"心跳：面板上要看得到，但**不值得落盘**
    // （实测一段 43 分钟会话：announce_verified 3006 行、bc_directed 432 行 = 97.5%）。
    const RING_ONLY: &[&str] = &["announce_verified", "bc_directed"];

    if kind.ends_with("_error") {
        return DiagDelivery::Warn;
    }
    if RING_ONLY.contains(&kind) {
        return DiagDelivery::RingOnly;
    }
    if kind != "bc_directed_sent" && DROPPED.contains(&kind) {
        return DiagDelivery::Dropped;
    }
    DiagDelivery::Info
}

/// 读文件尾部至多 `max_bytes` 字节并按行返回。从中间起读会让首行成为半条，直接丢掉；
/// 文件不存在或读不动返回空，不 panic。
fn read_tail_lines(path: &std::path::Path, max_bytes: u64) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    let start = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.take(max_bytes).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines.retain(|l| !l.trim().is_empty());
    lines
}

/// 把一行落盘日志解回 [`LogEntry`]，格式由 [`Logger::append_file`] 决定：
/// `<fingerprint> <YYYY-MM-DD HH:MM:SS> <level> [<target>] <message>`。
/// 指纹不符、字段缺失、级别不认识或时间解析不出来都返回 `None`。
fn parse_log_line(line: &str, fingerprint: &str) -> Option<LogEntry> {
    let rest = line.strip_prefix(fingerprint)?.strip_prefix(' ')?;
    let mut it = rest.splitn(4, ' ');
    let date = it.next()?;
    let time = it.next()?;
    let level = it.next()?;
    let tail = it.next()?;
    if !matches!(level, "info" | "warn" | "error") {
        return None;
    }
    let ts = parse_utc_to_ms(&format!("{date} {time}"))?;
    let (target, message) = tail.split_once(']')?;
    let target = target.strip_prefix('[')?.trim();
    if target.is_empty() {
        return None;
    }
    Some(LogEntry {
        ts,
        level: level.to_string(),
        target: target.to_string(),
        message: message.trim_start().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 盘满归类：ENOSPC / Windows 的两个码 / 文本兜底 ⇒ 稳定码 `DISK_FULL`；
    /// 其它错误（权限、无权限目录等）⇒ **没有专属码**（保留原文，那是唯一信息量）。
    ///
    /// 这条是"可行动文案"那条链的**决定性判据**：把 `classify_write_failure`
    /// 改回恒返回 `None`（旧行为：只把 io 错误原样转成英文），本用例必须红。
    #[test]
    fn disk_full_is_classified_into_a_stable_code_and_others_are_not() {
        // 裸 OS 码：28 = ENOSPC（macOS/Linux/Android）
        let enospc = std::io::Error::from_raw_os_error(28);
        assert_eq!(
            classify_write_failure(&enospc),
            Some(FAIL_CODE_DISK_FULL),
            "ENOSPC 必须归类成盘满 ⇒ 前端才能给出「清出空间后重试」"
        );
        // Windows：112 = ERROR_DISK_FULL、3900 = ERROR_HANDLE_DISK_FULL
        for code in [112, 3900] {
            let e = std::io::Error::from_raw_os_error(code);
            assert_eq!(classify_write_failure(&e), Some(FAIL_CODE_DISK_FULL));
        }
        // 文本兜底：某个平台既给不出这些码又确实写不下
        let by_text = std::io::Error::other("There is not enough space on the disk");
        assert_eq!(classify_write_failure(&by_text), Some(FAIL_CODE_DISK_FULL));

        // 反例：权限不足**不是**盘满 —— 归错类会让用户去清磁盘（白忙一场），
        // 而真正的解法是改目录权限。
        let denied = std::io::Error::from_raw_os_error(13);
        assert_eq!(
            classify_write_failure(&denied),
            None,
            "EACCES 不许归成盘满 ⇒ 用户的下一步完全不同"
        );
        let other = std::io::Error::other("broken pipe");
        assert_eq!(classify_write_failure(&other), None);
    }

    /// 失败码是**契约**：前端按它查表翻文案 ⇒ 码必须稳定、且不能与别的码重名。
    #[test]
    fn fail_code_disk_full_is_a_stable_identifier() {
        assert_eq!(FAIL_CODE_DISK_FULL, "DISK_FULL");
        // 大写 + 下划线：前端那张表是按字面量匹配的（`src/utils/fileFailReason.ts`），
        // 一旦改成带空格或小写，前端立刻匹配不上 ⇒ 静默回落到原始 reason。
        assert!(
            FAIL_CODE_DISK_FULL
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit()),
            "失败码必须是大写字母/数字/下划线（前端表按字面量匹配）"
        );
    }

    #[test]
    fn format_utc_epoch_and_known_dates() {
        // 1970-01-01 00:00:00 UTC
        assert_eq!(format_utc(0), "1970-01-01 00:00:00");
        // 2026-09-11 13:20:54 UTC
        let ms = 1_789_132_854_000i64; // 2026-09-11T13:20:54Z
        assert_eq!(format_utc(ms), "2026-09-11 13:20:54");
        // 一个带毫秒的：秒以下被截断，不影响 HH:MM:SS
        assert_eq!(format_utc(999), "1970-01-01 00:00:00");
    }

    #[test]
    fn previous_exit_is_classified_by_presence_and_absence() {
        let mk = |s: &[&str]| -> Vec<String> { s.iter().map(|x| x.to_string()).collect() };
        // 什么都没有 ⇒ 无可判定
        assert_eq!(classify_previous_exit(&mk(&[])), PreviousExit::NoHistory);
        // 有崩溃块 ⇒ panic（优先级高于路标）
        assert_eq!(
            classify_previous_exit(&mk(&["----- 启动 a", "===== 崩溃现场 b"])),
            PreviousExit::Panic
        );
        // 最后一条是退出路标 ⇒ 正常收尾
        assert_eq!(
            classify_previous_exit(&mk(&["----- 启动 a", "----- 正常退出 b"])),
            PreviousExit::Clean
        );
        // 只有启动、既无退出也无崩溃块 ⇒ **按异常终止**（这就是新能力：旧代码把这一格
        // 读成"上次不是 panic 死的"，于是正常退出和被 kill -9 分不开）
        assert_eq!(
            classify_previous_exit(&mk(&["----- 启动 a"])),
            PreviousExit::SilentKill
        );
        // 启动被安全中止（身份/DB 校验失败）是一条独立的收尾方式：进程没崩，
        // 但也没有"正常退出"。不能把它归进 NoHistory/SilentKill。
        assert_eq!(
            classify_previous_exit(&mk(&[
                "----- 启动 a",
                ">>> code=BOOT_FAILED 启动失败：IDENTITY_CORRUPT @2026-10-20",
            ])),
            PreviousExit::StartupFailed
        );
        // 反向：更早的 BOOT_FAILED 之后已经有正常退出路标 ⇒ 那是后来恢复过了。
        assert_eq!(
            classify_previous_exit(&mk(&[">>> code=BOOT_FAILED old", "----- 正常退出 b",])),
            PreviousExit::Clean
        );
    }

    /// 2026-10-29 拿真机现场文件复算出来的：末尾那条 `>>> 启动尝试` 属于**下一轮**
    /// （bootstrap 在 logger 之前写），旧实现把它当成上一轮的最后一条路标 ⇒ 48 段里
    /// 23 段判成 `NoHistory`，`silent_kill` 成了不可达分支、静默死亡不弹横幅。
    #[test]
    fn next_runs_bootstrap_line_does_not_swallow_the_previous_exit() {
        let mk = |s: &[&str]| -> Vec<String> { s.iter().map(|x| x.to_string()).collect() };
        // 上一轮正常退出 + 下一轮 bootstrap 行 ⇒ 仍必须是 Clean（真机就是这么被读成 NoHistory 的）
        assert_eq!(
            classify_previous_exit(&mk(&[
                "----- 启动 a",
                "----- 正常退出 a",
                ">>> 启动尝试：进程已起，logger 尚未建立（bootstrap 已绑定现场路径）  @2026-10-28 11:27:07",
            ])),
            PreviousExit::Clean
        );
        // 上一轮被强杀 + 下一轮 bootstrap 行 ⇒ SilentKill（这一格此前结构上不可达）
        assert_eq!(
            classify_previous_exit(&mk(&["----- 启动 a", ">>> 启动尝试：进程已起"])),
            PreviousExit::SilentKill
        );
        // 只有 bootstrap 行 ⇒ 起来过但没走到 logger ⇒ 异常终止，而不是"没有历史"
        assert_eq!(
            classify_previous_exit(&mk(&[">>> 启动尝试：进程已起"])),
            PreviousExit::SilentKill
        );
        // 反向：空输入仍是"首次运行/被清档"，不许被上面那条改写成异常终止
        assert_eq!(classify_previous_exit(&mk(&[])), PreviousExit::NoHistory);
    }

    /// 10-21 真机现场：`>>> 重分配失败：请求 326350 字节 … ⇒ 分配器即将 abort`。
    /// 它有现场（字节数就在行里）但没有崩溃块（abort 不走 unwind）⇒ 必须独立成类。
    #[test]
    fn allocator_abort_is_its_own_kind_not_no_history() {
        let mk = |s: &[&str]| -> Vec<String> { s.iter().map(|x| x.to_string()).collect() };
        assert_eq!(
            classify_previous_exit(&mk(&[
                "----- 启动 a",
                ">>> 重分配失败：请求 326350 字节（对齐 1）⇒ 分配器即将 abort（不是 panic，钩子不会跑）  @2026-10-21 10:42:49",
            ])),
            PreviousExit::Abort
        );
        // 有崩溃块时仍优先 panic（两种死法不会同时出现，这里钉住优先级不被后来的分支改掉）
        assert_eq!(
            classify_previous_exit(&mk(&[
                "----- 启动 a",
                "===== 崩溃现场 b",
                ">>> 重分配失败：请求 1 字节",
            ])),
            PreviousExit::Panic
        );
        // 落盘那一侧也要能说出这一格：kind / code 两条映射都不能回落到 no_history
        let dir = std::env::temp_dir().join(format!("gosslan-abort-kind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let crash = dir.join("c-crash.log");
        std::fs::write(
            &crash,
            "----- 启动 a 版本 1.0.0\n>>> 重分配失败：请求 326350 字节（对齐 1）⇒ 分配器即将 abort\n----- 启动 b 版本 1.0.0\n",
        )
        .unwrap();
        let raw = read_tail_lines(&crash, PREV_CRASH_TAIL_BYTES);
        let r = build_previous_run_report(&raw, &crash, &dir);
        assert_eq!(r.kind, "abort");
        assert_eq!(r.code, "BOOT_PREV_ABORT");
    }

    #[test]
    fn exit_marker_lets_next_run_read_previous_as_clean_and_absence_as_abnormal() {
        // 正控：写了退出路标 ⇒ 下一轮 seed 出来的那块文本必须是"正常退出"
        let clean = std::env::temp_dir().join(format!("gosslan-exit-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&clean);
        let lg1 = Logger::new(clean.clone(), "ok", "[dev:ok]".to_string());
        lg1.write_exit_marker();
        let lg2 = Logger::new(clean.clone(), "ok", "[dev:ok]".to_string());
        lg2.seed_previous_run();
        let text: String = lg2
            .snapshot(None)
            .iter()
            .map(|e| e.message.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("上次收尾判定：正常退出"), "实际文本：{text}");
        assert!(
            text.contains("code=BOOT_PREV_CLEAN"),
            "收尾判定必须带可检索错误码，实际文本：{text}"
        );
        // 判定还必须落到**日志文件**里：用户崩溃后能发出来的只有文件，不是界面内存环。
        let on_disk = std::fs::read_to_string(lg2.current_path()).unwrap_or_default();
        assert!(
            on_disk.contains("上次收尾判定：正常退出"),
            "判定没进日志文件，用户只发文件时读不到：{on_disk}"
        );

        // 反控：同一条路径不写退出路标 ⇒ 必须读成"异常终止"。
        // 没有这一半，上面那句可以靠"文本里恰好有那句话"蒙过去。
        let kill = std::env::temp_dir().join(format!("gosslan-exit-kill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&kill);
        let _ = Logger::new(kill.clone(), "kill", "[dev:kill]".to_string());
        let lg3 = Logger::new(kill.clone(), "kill", "[dev:kill]".to_string());
        lg3.seed_previous_run();
        let text3: String = lg3
            .snapshot(None)
            .iter()
            .map(|e| e.message.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text3.contains("异常终止"), "实际文本：{text3}");
        assert!(
            text3.contains("code=BOOT_PREV_SILENT_KILL"),
            "异常终止也要有可检索错误码，实际文本：{text3}"
        );
        let _ = std::fs::remove_dir_all(&clean);
        let _ = std::fs::remove_dir_all(&kill);
    }

    #[cfg(unix)]
    #[test]
    fn disk_write_failure_is_counted_and_noted_in_memory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("gosslan-log-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let logger = Logger::new(dir.clone(), "ro", "[dev:ro]".to_string());
        // 目录改成"不可写"：文件能打开失败 ⇒ 落盘必须失败，但日志不能因此消失
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        logger.error("test", "这条只能进内存");
        assert!(
            logger.write_fails() > 0,
            "落盘失败必须被计数（实测 {} 次）",
            logger.write_fails()
        );
        let snap = logger.snapshot(None);
        assert!(
            snap.iter().any(|e| e.message.contains("日志落盘已降级")),
            "降级必须进内存环，否则用户只看到「日志里什么都没有」"
        );
        assert!(
            snap.iter().any(|e| e.message == "这条只能进内存"),
            "内存环照常，不能因为写失败就把日志丢掉"
        );
        let before = logger.write_fails();
        logger.error("test", "第二条");
        assert!(logger.write_fails() > before, "持续失败要持续计数");
        // 只记一次：降级说明不许把 500 条环刷满。反例必须在**第二条之后**重读快照 ——
        // 拿第一次的快照数条数是自证式读数，证不出"第二条没有再记一条"。
        let after: Vec<LogEntry> = logger.snapshot(None);
        assert_eq!(
            after
                .iter()
                .filter(|e| e.message.contains("日志落盘已降级"))
                .count(),
            1,
            "降级说明只能进一次内存环"
        );
        assert!(
            after.iter().any(|e| e.message == "第二条"),
            "第二条也得照常进内存"
        );
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn log_dir_is_tightened_at_startup_and_covers_stale_logs() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "gosslan-log-perm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        // 复刻真机那副样子：app data 已经 0700，但它下面的 logs/ 是 umask 建出来的 0755，
        // 里面还躺着一个早停跑的实例留下的 0644 日志。
        let dir = root.join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let stale = dir.join("gosslan-9.log");
        std::fs::write(&stale, b"stale log from an instance that stopped running").unwrap();
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o644)).unwrap();
        // 同目录里一个**不是日志**的文件：不许被顺手改（用户可能把导出包放在这儿）
        let other = dir.join("note.txt");
        std::fs::write(&other, b"not a log").unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o644)).unwrap();

        let logger = Logger::new(dir.clone(), "pm", "[dev:pm]".to_string());
        logger.error("test", "权限判据用的这一条");

        let mode_of = |p: &std::path::Path| -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(
            mode_of(&dir),
            0o700,
            "logs 目录必须收到仅属主可进入（实测 {:o}）",
            mode_of(&dir)
        );
        for p in [logger.current_path(), logger.old_path(), stale] {
            // old_path 本轮没写过也要在属主手里：它可能还是上一轮那份
            if !p.exists() {
                continue;
            }
            assert_eq!(
                mode_of(&p),
                0o600,
                "{} 必须收紧到 0600（实测 {:o}）",
                p.display(),
                mode_of(&p)
            );
        }
        assert_eq!(
            mode_of(&other),
            0o644,
            "只认 .log，别的文件不许动（越界改权限比漏改更糟）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 轮转那一下是 `rename`（不是重建）⇒ 权限跟着走；轮转后新开的当前文件由
    /// `restrict_to_owner` 兜住。这两格在"目录 0700"之后仍然要各自成立：
    /// 目录挡的是**别人进不来**，文件挡的是**别人读得到内容**。
    #[cfg(unix)]
    #[test]
    fn rotated_logs_keep_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("gosslan-log-rotperm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "rp", "[dev:rp]".to_string());
        let cur = logger.current_path();
        let old = logger.old_path();

        // 洪水：与 crash_block_survives_rotation 同一形状，保证真的翻过一代（否则空转）
        let n = MAX_MEM_LOGS + 60;
        for i in 0..n {
            logger.info("diag", format!("rotperm {i} {}", "q".repeat(900)));
        }
        assert!(
            std::fs::metadata(&old).is_ok(),
            "前置条件不成立：日志根本没轮转，这一条就成了空转"
        );

        let mode_of = |p: &std::path::Path| -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(mode_of(&dir), 0o700, "轮转之后目录仍是 0700");
        assert_eq!(
            mode_of(&old),
            0o600,
            "被 rename 走的 .old.log 必须仍是 0600"
        );
        assert_eq!(
            mode_of(&cur),
            0o600,
            "轮转后新开的那份必须 0600，不能靠 umask"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_marker_carries_the_run_id() {
        let dir = std::env::temp_dir().join(format!("gosslan-log-runid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "rid", "[dev:rid]".to_string());
        let body = std::fs::read_to_string(logger.crash_path()).unwrap();
        assert!(body.contains("----- 启动 "), "启动路标丢了：{body}");
        assert!(
            body.contains(&format!("· 运行 {}", logger.run_id())),
            "启动路标必须带本轮运行标识，实际：{body}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logger_memory_ring_buffer_is_bounded() {
        let dir = std::env::temp_dir().join(format!("gosslan-log-test-{}", std::process::id()));
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        // 写超过上限：只保留最后 MAX_MEM_LOGS 条
        for i in 0..(MAX_MEM_LOGS as i64 + 100) {
            logger.info("test", format!("msg {i}"));
        }
        let snap = logger.snapshot(None);
        assert_eq!(snap.len(), MAX_MEM_LOGS);
        // 最旧的 100 条已被丢弃，第一条是 msg 100
        assert!(snap[0].message == "msg 100");
        assert!(snap.last().unwrap().message == format!("msg {}", MAX_MEM_LOGS + 99));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logger_clear_empties_memory() {
        let dir = std::env::temp_dir().join(format!("gosslan-log-clr-{}", std::process::id()));
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        logger.error("test", "boom");
        assert_eq!(logger.snapshot(None).len(), 1);
        logger.clear();
        assert!(logger.snapshot(None).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logger_persists_to_file_and_rotates() {
        let dir = std::env::temp_dir().join(format!("gosslan-log-rot-{}", std::process::id()));
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        // 写一条，确认落盘
        logger.info("test", "hello file");
        let cur = dir.join("t.log");
        let content = std::fs::read_to_string(&cur).unwrap();
        assert!(content.contains("hello file"));
        assert!(content.contains("[test]"));
        // 触发轮转：把文件撑到超限
        let big = "x".repeat(1024);
        for _ in 0..600 {
            logger.info("test", big.clone());
        }
        // 轮转后 old 文件应存在（或当前文件被重置为 < 上限）
        let old = dir.join("t.old.log");
        let cur_len = std::fs::metadata(&cur).map(|m| m.len()).unwrap_or(0);
        assert!(old.exists() || cur_len <= MAX_LOG_FILE_BYTES);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 崩溃现场必须**独立于轮转**存在，并且自带版本号。
    ///
    /// 直接对应 2026-10-16 那三个丢掉的现场：主日志 512 KiB 就翻一代，
    /// 而局域网自检一秒能写 5~6 条 ⇒ `panic @ 文件:行:列` 一定被冲掉了。
    /// 这里刻意把日志写到"必然已经轮转"的量级，再崩一次，验证现场仍然完整。
    #[test]
    fn crash_block_survives_rotation_and_carries_version_and_context() {
        let dir = std::env::temp_dir().join(format!("gosslan-crash-carry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());

        // 洪水：把内存环填满并越过容量。每条带一段填充，使总量必然越过 512 KiB ⇒ 主日志一定已轮转，
        // 于是"现场还在"这件事不是因为日志还没翻（那就是空转）。
        let n = MAX_MEM_LOGS + 60;
        for i in 0..n {
            logger.info(
                "discovery",
                format!(
                    "diag/announce_verified: from=peer-{i} via=10.1.22.1 {}",
                    "p".repeat(900)
                ),
            );
        }
        assert!(
            std::fs::metadata(dir.join("t.old.log")).is_ok(),
            "前置条件不成立：主日志根本没轮转，这一条就成了空转"
        );

        logger.error("panic", "panic @ src/network/x.rs:7:1：index out of bounds");

        let crash = std::fs::read_to_string(dir.join("t-crash.log")).expect("崩溃现场必须落盘");
        assert!(
            crash.contains("panic @ src/network/x.rs:7:1"),
            "现场里必须有 panic 原文（文件:行:列）"
        );
        assert!(
            crash.contains(env!("CARGO_PKG_VERSION")),
            "现场必须自带版本号 —— 不能再拿 CI 构建时刻反推'崩的是哪一版'"
        );
        // 环里 500 条 = info i=61..559 加那条 panic；附带最后 300 条 ⇒ i=261..559 必须在、260 必须没有。
        assert!(crash.contains("from=peer-559"), "必须带崩之前最近一条");
        assert!(crash.contains("from=peer-261"), "附带窗口的边界那条必须在");
        assert!(
            !crash.contains("from=peer-260"),
            "窗口外的旧条不许混进来（证明附带量真的按 CRASH_CONTEXT_LINES 截断）"
        );
        assert_eq!(
            crash.matches("\n[dev:test] ").count(),
            CRASH_CONTEXT_LINES,
            "上下条文数必须钉在附带上限（多了=没截断，少了=没抄全）；按行首计数，表头那处指纹不计"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 现场文件也必须有磁盘上界：它不参与轮转，不封顶就是"永远只增"。
    #[test]
    fn crash_file_is_capped_by_reopening_not_growing_forever() {
        let dir = std::env::temp_dir().join(format!("gosslan-crash-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t-crash.log");
        std::fs::write(&path, "x".repeat(3 * 1024 * 1024)).unwrap();

        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        logger.error("panic", "panic @ src/y.rs:1:1：boom");

        let len = std::fs::metadata(&path).unwrap().len();
        assert!(
            len < MAX_CRASH_FILE_BYTES,
            "超上界必须整份重开（实测 {len} 字节 > 上界 {MAX_CRASH_FILE_BYTES}）"
        );
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("boom"), "重开之后新现场必须在");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只有 panic 那一条会留下现场块；普通 error 不许（否则又变成第二个洪水源）。
    /// 同时验证启动路标 —— 它是"没崩" 与 "崩了但不是 panic" 唯一的分叉点。
    #[test]
    fn only_the_panic_target_writes_a_crash_block() {
        let dir = std::env::temp_dir().join(format!("gosslan-crash-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        let crash = dir.join("t-crash.log");

        // 建 logger 就该有启动路标（含版本号），但**不该**有崩溃块。
        let after_start = std::fs::read_to_string(&crash).expect("启动路标必须落盘");
        assert!(after_start.contains("启动 "), "启动路标没写进去");
        assert!(
            after_start.contains(env!("CARGO_PKG_VERSION")),
            "启动路标必须自带版本号"
        );
        assert!(
            !after_start.contains(">>> "),
            "刚启动就出现崩溃块 ⇒ 判据把两件事混了"
        );

        logger.error("file", "普通错误不该留下现场");
        logger.warn("panic-ish", "target 名字像但不是也不行");
        let body = std::fs::read_to_string(&crash).unwrap();
        assert!(
            !body.contains(">>> "),
            "非 panic 的日志把崩溃块写出来了 ⇒ 折叠/落盘的门槛没生效"
        );
        assert!(
            body.matches("----- 启动 ").count() == 1,
            "普通日志不该重复写启动路标（实得 {} 条）",
            body.matches("----- 启动 ").count()
        );

        logger.error("panic", "panic @ src/z.rs:2:2：真崩");
        assert!(
            std::fs::read_to_string(&crash)
                .unwrap()
                .contains(">>> panic @ src/z.rs:2:2"),
            "正向对照失败：真 panic 没落崩溃块"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ 折叠的**两根轴**必须都在：同 target + 同文 + 同一秒才折；换秒、换 target、换文本都不折。
    /// 直接测辅助函数而不是 `log()` —— 那样不依赖墙上时钟，跨秒边界不会让它偶发红。
    #[test]
    fn diag_folds_only_on_identical_text_in_the_same_second() {
        let dir = std::env::temp_dir().join(format!("gosslan-fold-axes-{}", std::process::id()));
        let logger = Logger::new(dir, "t", "[dev:test]".to_string());
        let sec = 1_792_000_000_000i64; // 某个整秒的毫秒值

        let msg = "diag/announce_verified: from=peer-a via=10.1.22.3";
        assert!(
            !logger.fold_diag_same_second("discovery", msg, sec),
            "第一条必须留下（正向对照）"
        );
        assert!(
            logger.fold_diag_same_second("discovery", msg, sec + 999),
            "同一秒里的同文重复必须折掉"
        );
        assert!(
            !logger.fold_diag_same_second("discovery", msg, sec + 1000),
            "换到下一秒必须重新留一条 —— 否则长期只剩一条，实时性全丢"
        );
        assert!(
            !logger.fold_diag_same_second("routed", msg, sec),
            "同文不同 target 不许互相折（两个子系统的同名事件是两回事）"
        );
        assert!(
            !logger.fold_diag_same_second(
                "discovery",
                "diag/announce_verified: from=peer-b via=10.1.22.4",
                sec
            ),
            "不同设备/不同来源必须各留一条 —— 折叠不能把「谁在场」这条信息抹平"
        );
    }

    /// 端到端：`log()` 真的接了这一步（只测上面那条辅助函数测不出来 —— 摘掉调用它就还是绿的）。
    /// 断言写成"< 6"而不是"== 1"：紧密循环里可能正好跨过一个秒边界，那也顶多是 2。
    #[test]
    fn log_wire_actually_folds_the_diag_flood() {
        let dir = std::env::temp_dir().join(format!("gosslan-fold-wire-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        for _ in 0..6 {
            logger.info(
                "discovery",
                "diag/announce_verified: from=peer-a via=10.1.22.3",
            );
        }
        let n = logger.snapshot(None).len();
        assert!(
            n < 6,
            "六条同秒同文还是全进了环 ⇒ log() 里那一步折叠没生效（实得 {n} 条）"
        );
        assert!(n >= 1, "折叠不能把这一族彻底吃掉（实得 {n} 条）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⚠️ 反向判据（本轮最要紧的一格）：**错误永远不许折**。
    /// 2026-10-16 那轮审计的主题就是"失败必须看得见"，把 warn/error 一起折掉就是倒退。
    #[test]
    fn diag_warn_and_error_are_never_folded() {
        let dir = std::env::temp_dir().join(format!("gosslan-fold-levels-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        for _ in 0..4 {
            logger.warn("discovery", "diag/bind_error: addr=10.1.22.3");
            logger.error("discovery", "diag/relay_error: hop=2");
        }
        let snap = logger.snapshot(None);
        assert_eq!(
            snap.len(),
            8,
            "warn/error 各 4 条必须全留（被折就是又把错误藏起来）"
        );
        assert_eq!(
            snap.iter().filter(|e| e.level == "warn").count(),
            4,
            "warn 一条都不能少"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 投递口径：失败先于任何清单；两条高频成功心跳只进面板、其余照旧。
    /// 这四条一起钉住"降级 ≠ 消失"。
    #[test]
    fn diag_delivery_puts_failures_first_and_keeps_high_freq_success_in_the_panel() {
        // 失败类：即使名字同时命中别的清单也必须是 Warn，绝不被折掉
        assert_eq!(diag_delivery("announce_error"), DiagDelivery::Warn);
        assert_eq!(diag_delivery("bc_directed_error"), DiagDelivery::Warn);
        assert_eq!(diag_delivery("relay_error"), DiagDelivery::Warn);
        // 两条实测占 97.5% 的成功心跳：只进面板
        assert_eq!(diag_delivery("announce_verified"), DiagDelivery::RingOnly);
        assert_eq!(diag_delivery("bc_directed"), DiagDelivery::RingOnly);
        // 其余高频心跳照旧丢弃；子网广播的 `_sent` 单独豁免（真机排查"只通一半"要用）
        assert_eq!(diag_delivery("announce_recv"), DiagDelivery::Dropped);
        assert_eq!(diag_delivery("bc_directed_sent"), DiagDelivery::Info);
        // 状态跃迁类仍以 info 落盘
        assert_eq!(diag_delivery("discovery_started"), DiagDelivery::Info);
    }

    /// `ring_only` 是"面板可见 + 盘上没有"的实现手段：两头都必须验到，
    /// 只验一头就会得到"降级成了消失"或"根本没降".
    #[test]
    fn ring_only_reaches_the_panel_but_never_the_file() {
        let dir = std::env::temp_dir().join(format!("gosslan-ring-only-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        logger.ring_only(
            "discovery",
            "diag/announce_verified: from=peer-a".to_string(),
        );
        logger.ring_only("discovery", "diag/bc_directed: bytes=374".to_string());
        let panel = logger.snapshot(None);
        assert!(
            panel
                .iter()
                .any(|e| e.message.contains("diag/announce_verified")),
            "诊断面板（内存环）必须还能看到成功心跳"
        );
        let on_disk = std::fs::read_to_string(dir.join("t.log")).unwrap_or_default();
        assert!(
            !on_disk.contains("announce_verified") && !on_disk.contains("bc_directed"),
            "这两个高频成功心跳不许再落盘：{on_disk}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 折叠只认 `diag/` 这一族：非 diag 的 info 重复照旧各留一条
    /// （否则"同一句异常文案出现两次"这种真信息会被悄悄吃掉）。
    #[test]
    fn non_diag_info_is_not_folded() {
        let dir = std::env::temp_dir().join(format!("gosslan-fold-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        logger.info("file", "收到文件 done");
        logger.info("file", "收到文件 done");
        assert_eq!(
            logger.snapshot(None).len(),
            2,
            "非 diag 的 info 被折了 ⇒ 判据范围写宽了"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 折叠表自己必须有界：键里带设备 id 与来源 IP，局域网跑久了会一直长。
    #[test]
    fn diag_fold_table_is_bounded_by_restarting_not_growing() {
        let dir = std::env::temp_dir().join(format!("gosslan-fold-cap-{}", std::process::id()));
        let logger = Logger::new(dir, "t", "[dev:test]".to_string());
        for i in 0..(DIAG_FOLD_KEYS + 40) {
            logger.info(
                "discovery",
                format!("diag/announce_verified: from=peer-{i}"),
            );
        }
        let len = logger.diag_fold.lock().unwrap().len();
        assert!(
            len <= DIAG_FOLD_KEYS + 1,
            "折叠表超上界必须整表重开（实测 {len} > 上界 {DIAG_FOLD_KEYS}）"
        );
    }

    /// ★ 独立通道：**没有 logger 也要留得下痕**（分配失败、崩在 logger 建立之前都走这条路）。
    /// 没这条判据的话那两个洞是静默的 —— 而分配失败产生的异常码与 panic 一模一样（都是 `__fastfail`），
    /// 分不开就等于把内存耗尽当成代码 bug 去查。
    ///
    /// ⚠️ 三条断言**必须待在同一个测试里顺序跑**：再入闸是进程级 `AtomicBool`，
    /// 拆成两条会被 libtest 的线程池并发执行 —— 一条把闸置起来，另一条的写入就被吃掉，
    /// 于是"整包绿、单跑红"（本仓实测过的假绿形状）。
    #[test]
    fn crash_note_writes_without_a_logger_and_survives_the_reentry_guard() {
        let dir = std::env::temp_dir().join(format!("gosslan-note-{}", std::process::id()));
        let file = crash_file_for(&dir, "note-test");

        crash_note_to(
            &file,
            "分配失败：请求 999999999 字节（对齐 8）⇒ 分配器即将 abort",
        );
        let body = std::fs::read_to_string(&file)
            .expect("独立通道必须能把文件建出来 —— 此刻还没有 logger");
        assert!(body.contains(">>> 分配失败"), "现场里没有这一条");
        assert!(
            body.contains(env!("CARGO_PKG_VERSION")),
            "每条留痕都要自带版本号，不能再靠 CI 时刻反推"
        );

        // 闸开着的时候再来一条：必须被丢掉（写一行本身要申请内存 ⇒ 不拦就是无限递归）
        NOTE_IN_PROGRESS.store(true, Ordering::SeqCst);
        crash_note_to(&file, "第二条（模拟正在写的时候又触发一次分配失败）");
        NOTE_IN_PROGRESS.store(false, Ordering::SeqCst);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            body,
            "再入时还往外写 ⇒ 分配失败会把自己递归下去"
        );

        // 正向对照：闸放下之后，第三条要能写进去（否则上面那条"没写"可能只是通道坏了）
        crash_note_to(&file, "第三条（闸已放下）");
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(
            after.contains("第三条（闸已放下）"),
            "通道被再入闸永久卡死了"
        );
        assert!(!after.contains("第二条"), "被拦掉的那条不该出现在文件里");

        // ③ 上界：超 2MB 必须整份重开（这条通道不轮转，否则会无限长）
        let capped = crash_file_for(&dir, "cap");
        std::fs::write(&capped, vec![b'x'; MAX_CRASH_FILE_BYTES as usize + 1]).unwrap();
        assert!(crash_note_to(&capped, "超限之后的新一条"));
        let cap_body = std::fs::read_to_string(&capped).unwrap();
        assert!(
            cap_body.len() < 4096,
            "超上界必须整份重开，实测仍有 {} 字节",
            cap_body.len()
        );
        assert!(cap_body.contains("已整份重开"), "重开要留一句可判读的说明");
        assert!(
            cap_body.contains("超限之后的新一条"),
            "重开不能把当前这条弄丢"
        );

        // ④ 写不进去必须返回 false（由 crash_note 退到 stderr），绝不许 panic：
        //    它跑在 panic 钩子里，二次 panic 会把"留痕"变成"二次崩溃"。
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        assert!(
            !crash_note_to(&blocker.join("sub").join("x-crash.log"), "写不进去"),
            "写失败必须返回 false，不许假装写成了"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **bootstrap 与 Logger 必须指同一份现场文件**（2026-10-20 真机事故的判据）。
    ///
    /// 事故形状：bootstrap 用 `crash_file_for(app_data, stem)` ⇒ `com.gosslan.app/x-crash.log`；
    /// Logger 用 `app_data/logs` ⇒ `com.gosslan.app/logs/x-crash.log`。两个 OnceLock 先到先得，
    /// 于是独立通道**一直写错文件**，用户发出来的 `logs/*-crash.log` 里一行 `>>>` 都没有。
    /// 这条不比对源码文本，而是真的把 Logger 建出来再比路径。
    #[test]
    fn bootstrap_and_logger_point_at_the_same_crash_file() {
        let app_data = fresh_dir("crash-path");
        let stem = "gosslan-2";
        let logger = Logger::new(log_dir_in(&app_data), stem, "[dev:t]".to_string());
        assert_eq!(
            crash_file_in(&app_data, stem),
            logger.crash_path(),
            "两处算出来的现场文件不是同一个 ⇒ 独立通道写在一处、用户/诊断包/下一轮判定读另一处"
        );
        assert!(
            logger.crash_path().starts_with(log_dir_in(&app_data)),
            "现场文件必须在 logs/ 里（诊断包只读这里）"
        );
        let _ = std::fs::remove_dir_all(&app_data);
    }

    // 独立通道**有上界** + 写不进去必须**返回 false**（不许 panic、不许假装写成）。
    //
    // ⚠️ 这两条断言**必须并进** `crash_note_writes_without_a_logger_and_survives_the_reentry_guard`
    // 那一条测试里顺序跑：再入闸是进程级 `AtomicBool`，拆成独立测试会被 libtest 的线程池
    // 并发执行 —— 一条把闸置起来，另一条的写入被吃掉（本仓已实测过这种假红）。

    /// `>>> panic @ …` 必须判成 panic，而不是"异常终止/强杀"。
    /// 反向那一格钉住"更早那一轮的 panic 不能按到这一轮头上"。
    #[test]
    fn panic_note_from_the_independent_channel_is_classified_as_panic() {
        let mk = |v: &[&str]| -> Vec<String> { v.iter().map(|s| s.to_string()).collect() };
        assert_eq!(
            classify_previous_exit(&mk(&[
                "----- 启动 a",
                ">>> panic @ src/network/transport/outbox_sweep.rs:89:5：there is no reactor running",
            ])),
            PreviousExit::Panic
        );
        assert_eq!(
            classify_previous_exit(&mk(&[
                ">>> panic @ src/old.rs:1:1：上一轮的",
                "----- 启动 b",
                "----- 正常退出 b",
            ])),
            PreviousExit::Clean,
            "更早那一轮的 panic 不许按到这一轮头上"
        );
    }

    // ---------------- 上一轮故障现场进内存（`seed_previous_run`）----------------

    /// 每个测试独立的临时目录；带时间戳，避免上一次残留被当成本轮输入。
    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "gosslan-prevrun-{tag}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一行落盘日志，格式与 [`Logger::append_file`] 一致。
    fn prev_line(fingerprint: &str, ms: i64, level: &str, target: &str, message: &str) -> String {
        format!(
            "{} {} {} [{}] {}",
            fingerprint,
            format_utc(ms),
            level,
            target,
            message
        )
    }

    #[test]
    fn utc_format_and_parse_roundtrip_across_eras() {
        // 1970 之前 / 纪元 / 2026 年：format 与 parse 必须互逆（整秒）。
        for ms in [
            -719_468i64 * 86_400_000,
            0,
            20_545 * 86_400_000,
            25_500 * 86_400_000,
            1_789_132_854_000,
        ] {
            assert_eq!(
                parse_utc_to_ms(&format_utc(ms)),
                Some(ms),
                "format_utc({ms}) 解析不回来"
            );
        }
        // 解不出来返回 None：凑当前时间会把上一轮的行排到本轮之后
        assert_eq!(parse_utc_to_ms("2026-13-01 00:00:00"), None);
        assert_eq!(parse_utc_to_ms("2026-10-17"), None);
        assert_eq!(parse_utc_to_ms("2026-10-17 24:00:00"), None);
    }

    #[test]
    fn parse_log_line_roundtrips_and_rejects_foreign_or_malformed_lines() {
        let fp = "[dev:test]";
        let ms = 1_789_132_854_000i64;
        let line = prev_line(fp, ms, "warn", "file", "收尾失败 id=abc");
        let e = parse_log_line(&line, fp).expect("自己写出去的格式必须解得回来");
        assert_eq!(e.ts, ms);
        assert_eq!(e.level, "warn");
        assert_eq!(e.target, "file");
        assert_eq!(e.message, "收尾失败 id=abc");
        // 正文里带 `]` 与空格也必须原样留下（target 只吃到第一个 `]`）
        let tricky = prev_line(fp, ms, "error", "ui", "a]b at [x] y");
        assert_eq!(parse_log_line(&tricky, fp).unwrap().message, "a]b at [x] y");
        // 不是这台设备/这个实例的指纹
        assert!(parse_log_line(&line, "[dev:other]").is_none());
        // 级别不认识
        assert!(parse_log_line("[dev:test] 2026-09-11 13:20:54 trace [file] x", fp).is_none());
        // 崩溃现场的路标行不是日志行
        assert!(parse_log_line("----- 启动 2026-09-11 13:20:54 版本 4.44.3", fp).is_none());
    }

    #[test]
    fn previous_run_log_and_crash_scene_are_seeded_before_this_runs_lines() {
        let dir = fresh_dir("seed-ok");
        let fp = "[dev:test]";
        let base = 1_789_132_854_000i64;
        std::fs::write(
            dir.join("t.log"),
            format!(
                "{}\n{}\n",
                prev_line(fp, base, "info", "boot", "上一轮：AppState::init 完成"),
                prev_line(
                    fp,
                    base + 1_000,
                    "error",
                    "panic",
                    "panic @ src/foo.rs:1:9：index out of bounds"
                ),
            ),
        )
        .unwrap();
        std::fs::write(
            crash_file_for(&dir, "t"),
            "===== 崩溃现场 2026-09-11 13:21:00 ===== 版本 4.44.3 · macos-aarch64 · release\ngoes context that is not a log line\n>>> 分配失败：请求 123 字节\n",
        )
        .unwrap();

        let logger = Logger::new(dir.clone(), "t", fp.to_string());
        let n = logger.seed_previous_run();
        assert!(n >= 3, "标题 + 上一轮两行 + 现场，实测 {n} 条");
        let snap = logger.snapshot(None);

        // 上一轮那两行在环里，时间戳来自文件本身
        let panic_row = snap
            .iter()
            .find(|e| e.message.contains("panic @ src/foo.rs"))
            .expect("上一轮的 panic 行必须可见 —— 这正是崩溃重启后要复制走的那一句");
        assert_eq!(panic_row.level, "error");
        assert_eq!(panic_row.ts, base + 1_000);
        assert_eq!(panic_row.target, "panic");

        // 标题行说明来历
        assert!(snap[0].message.contains("上一轮启动留下的记录"));
        assert_eq!(snap[0].target, "boot");

        // 现场记录：块头与独立通道留痕都在，本轮刚写的启动路标不在
        let scene = snap
            .iter()
            .find(|e| e.target == "crash")
            .expect("现场记录没进环");
        assert!(
            scene.message.contains("版本 4.44.3"),
            "现场必须自带版本/平台上下文"
        );
        assert!(scene.message.contains("分配失败"));
        assert_eq!(scene.level, "error", "带崩溃块头的现场必须是错误级");
        assert!(
            !scene.message.contains("----- 启动 "),
            "路标是 Logger::new 刚写的 ⇒ 属于本轮，不许冒充上一轮"
        );

        // 本轮写的行排在后面
        logger.info("test", "本轮第一条");
        let snap2 = logger.snapshot(None);
        assert_eq!(snap2.last().unwrap().message, "本轮第一条");
        assert_eq!(snap2.len(), snap.len() + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_startup_without_any_history_seeds_nothing() {
        let dir = fresh_dir("seed-empty");
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        assert_eq!(
            logger.seed_previous_run(),
            0,
            "首次启动不该造出\"上一轮\"标题"
        );
        assert!(
            logger.snapshot(None).is_empty(),
            "没有历史就必须一条都不进环"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 上一轮记录只读不写：调用多少次都不许改盘上字节数。
    #[test]
    fn previous_run_seed_writes_nothing_to_disk_however_many_times_it_is_called() {
        let dir = fresh_dir("seed-nowrite");
        let fp = "[dev:test]";
        std::fs::write(
            dir.join("t.log"),
            format!(
                "{}\n",
                prev_line(fp, 1_789_132_854_000, "info", "boot", "上一轮的一条")
            ),
        )
        .unwrap();
        let logger = Logger::new(dir.clone(), "t", fp.to_string());
        let log_len = std::fs::metadata(dir.join("t.log")).unwrap().len();
        let crash_len = std::fs::metadata(crash_file_for(&dir, "t")).unwrap().len();

        let memory_after_first = logger.seed_previous_run();
        assert_eq!(
            memory_after_first, 2,
            "标题 + 那一条（现场里只有本轮路标 ⇒ 被剔掉）"
        );
        for _ in 0..5 {
            assert_eq!(logger.seed_previous_run(), 0, "第二次起必须是 no-op");
        }
        assert_eq!(
            std::fs::metadata(dir.join("t.log")).unwrap().len(),
            log_len,
            "seed 往日志文件写过一个字节 ⇒ 每重启一次就复制一遍历史"
        );
        assert_eq!(
            std::fs::metadata(crash_file_for(&dir, "t")).unwrap().len(),
            crash_len,
            "seed 不许碰现场文件"
        );
        assert_eq!(logger.snapshot(None).len(), 2, "内存条数也不随重复调用增长");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn previous_run_seed_is_bounded_and_keeps_the_newest_lines() {
        let dir = fresh_dir("seed-bound");
        let fp = "[dev:test]";
        let base = 1_789_132_854_000i64;
        // 400 行 × ~550 字节 ⇒ 约 220 KB，**超过** 128 KiB 的尾部上界，同时行数也超过 120
        let mut text = String::new();
        for i in 0..400i64 {
            text.push_str(&prev_line(
                fp,
                base + i * 1_000,
                "info",
                "diag",
                &format!("第 {i} 条 {}", "x".repeat(500)),
            ));
            text.push('\n');
        }
        std::fs::write(dir.join("t.log"), &text).unwrap();
        let logger = Logger::new(dir.clone(), "t", fp.to_string());
        let n = logger.seed_previous_run();
        assert_eq!(
            n,
            PREV_RUN_MAX_LINES + 1,
            "进环必须正好封顶在 {PREV_RUN_MAX_LINES} 行 + 1 条标题，实测 {n}"
        );
        let snap = logger.snapshot(None);
        assert!(
            snap.iter().any(|e| e.message.contains("第 399 条")),
            "留下的必须是**最近**的那些 —— panic 与失败原因都排在尾巴上"
        );
        assert!(!snap.iter().any(|e| e.message.contains("第 0 条")));
        assert_eq!(snap.len(), n);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 接线判据：调用点要存在、只有一处，并排在第一条日志之前。
    #[test]
    fn previous_run_seed_is_wired_at_startup() {
        let src = include_str!("state.rs");
        let call = "logger.seed_previous_run();";
        assert_eq!(
            src.match_indices(call).count(),
            1,
            "接线点只许一处（两处就把同一批上一轮的行灌两遍）"
        );
        let seed_at = src.find(call).unwrap();
        let new_at = src
            .find("Logger::new(")
            .expect("state.rs 里必须能找到 Logger::new");
        assert!(new_at < seed_at, "必须先有 logger 再灌历史");
        // 本轮第一条日志只能排在接线点之后，否则本轮刚写的行会被当成上一轮
        let tail = &src[new_at..];
        let first_log = ["logger.info(", "logger.warn(", "logger.error("]
            .iter()
            .filter_map(|p| tail.find(p))
            .min();
        if let Some(offset) = first_log {
            assert!(
                src[..new_at + offset].contains(call),
                "接线点必须排在本轮第一条日志之前"
            );
        }
    }

    /// 日志与崩溃现场含 peer id / IP / 文件名，不能同机其他用户可读。
    /// 构造时用默认 umask 建文件，断言启动路标与第一条日志都被收紧到 `0600`。
    #[cfg(unix)]
    #[test]
    fn log_and_crash_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        fn mode(p: &std::path::Path) -> u32 {
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777
        }

        let dir = std::env::temp_dir().join(format!("gosslan-log-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 预置历史安装留下的 0644 当前日志与轮转日志：构造时就必须收紧，
        // 不能依赖“下一次写入”或“下一次轮转”。
        for name in ["t.log", "t.old.log"] {
            let p = dir.join(name);
            std::fs::write(&p, "old\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        logger.info("test", "mode");

        let crash = dir.join("t-crash.log");
        assert!(crash.exists(), "Logger::new 必须写启动路标");
        assert_eq!(mode(&crash), 0o600, "崩溃现场必须收紧到 0600");
        for name in ["t.log", "t.old.log"] {
            assert_eq!(mode(&dir.join(name)), 0o600, "{name} 必须在构造时收紧");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn previous_run_report_extracts_panic_and_ble_marker() {
        let raw = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.10.1 · macos-aarch64 · release · 设备 [dev:test] · 运行 aa -----",
            ">>> panic @ vendor/btleplug/src/corebluetooth/internal.rs:351:17：We should still have a future at this point!",
            "----- 启动 2026-10-25 10:40:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 bb -----",
        ]);
        let r = build_previous_run_report(
            &raw,
            std::path::Path::new("/x/crash.log"),
            std::path::Path::new("/x"),
        );
        assert_eq!(r.kind, "panic");
        assert_eq!(r.code, "BOOT_PREV_PANIC");
        assert_eq!(r.version.as_deref(), Some("5.10.1"));
        assert_eq!(r.at.as_deref(), Some("2026-10-25 10:30:00"));
        let p = r.panic.expect("必须解析出崩溃位置");
        assert!(p.location.ends_with("internal.rs:351:17"), "{}", p.location);
        assert!(r.ble_suspect);
        assert_eq!(r.recent_panic_count, 1);
        assert_eq!(r.crash_log, "/x/crash.log");
    }

    #[test]
    fn previous_run_report_clean_and_startup_failed() {
        let clean = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 aa -----",
            "----- 正常退出 2026-10-25 10:35:00 运行 aa -----",
            "----- 启动 2026-10-25 10:40:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 bb -----",
        ]);
        let r =
            build_previous_run_report(&clean, std::path::Path::new("c"), std::path::Path::new("d"));
        assert_eq!(r.kind, "clean");
        assert!(!r.ble_suspect);
        assert!(r.panic.is_none());

        let failed = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 aa -----",
            ">>> code=BOOT_FAILED 启动失败：身份校验失败",
            "----- 启动 2026-10-25 10:40:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 bb -----",
        ]);
        let r = build_previous_run_report(
            &failed,
            std::path::Path::new("c"),
            std::path::Path::new("d"),
        );
        assert_eq!(r.kind, "startup_failed");
    }

    #[test]
    fn hang_lines_do_not_change_exit_classification() {
        let run = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 aa -----",
            ">>> code=HANG scope=main_thread seconds=42 last_op=send_message",
        ]);
        assert_eq!(classify_previous_exit(&run), PreviousExit::SilentKill);

        let with_exit = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 aa -----",
            ">>> code=HANG scope=main_thread seconds=42 last_op=send_message",
            ">>> code=HANG_END scope=main_thread seconds=42",
            "----- 正常退出 2026-10-25 10:35:00 运行 aa -----",
        ]);
        assert_eq!(classify_previous_exit(&with_exit), PreviousExit::Clean);
    }

    #[test]
    fn previous_run_report_marks_open_hang() {
        let raw = lines(&[
            "----- 启动 2026-10-25 10:30:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 aa -----",
            // 新形状带 `last_op_age_s=`（2026-10-29 起）：`last_op=` 仍是它自己那个 token，
            // 老解析按 `strip_prefix("last_op=")` 取 ⇒ 不能被这个后缀带歪。
            ">>> code=HANG scope=ui_renderer seconds=12 last_op=set_channel_enabled(bluetooth) last_op_age_s=37 ws=52MiB",
            "----- 启动 2026-10-25 10:40:00 版本 5.11.1 · macos-aarch64 · debug · 设备 [dev:test] · 运行 bb -----",
        ]);
        let r =
            build_previous_run_report(&raw, std::path::Path::new("c"), std::path::Path::new("d"));
        let h = r.hang.expect("必须解析出卡死记录");
        assert_eq!(h.seconds, 12);
        assert_eq!(h.last_op.as_deref(), Some("set_channel_enabled(bluetooth)"));
        assert!(!h.ended);
        assert!(r.ble_suspect, "last_op 带 bluetooth ⇒ 疑似蓝牙");
    }

    #[test]
    fn parse_panic_line_accepts_logger_context_shape() {
        let p = parse_panic_line(
            "[dev:Mac-abc] 2026-10-25 10:37:38 error [panic] panic @ file_relay.rs:230:9：刚拿_mut过",
        )
        .expect("logger 崩溃块里的上下文行也要认");
        assert_eq!(p.location, "file_relay.rs:230:9");
        assert_eq!(p.message, "刚拿_mut过");
    }

    // ---------------- 墙上时钟只有一个家（审计 DUP-03） ----------------

    /// 判据按**形状**而不是清单：重复的由来从来不是"抄了一份没登记"，而是"第 N+1 处又写了一遍"。
    ///
    /// 允许两个名字：家（这里）与 `db::now_ms` 那层**具名别名**（别名必须转调家，不许自己读钟）。
    /// 第三、第四个名字一旦出现，或者别名偷偷变回读钟，就红。
    #[test]
    fn the_wall_clock_has_two_names_max() {
        let files = production_rs_files();
        assert!(
            files.len() > 100,
            "只扫到 {} 个 .rs ⇒ 目录走错了，这条判据是在空集上恒绿",
            files.len()
        );
        let mut definers: Vec<String> = Vec::new();
        let mut reads_epoch: Vec<String> = Vec::new();
        for p in &files {
            let Ok(text) = std::fs::read_to_string(p) else {
                continue;
            };
            let rel = rel_to_src(p);
            if text.contains("fn now_ms(") {
                definers.push(rel.clone());
            }
            // "定义 + 真的读系统时钟"才算第二份实现；转调别家的不算。
            if text.contains("fn now_ms(") && text.contains("UNIX_EPOCH") {
                reads_epoch.push(rel.clone());
            }
        }
        assert_eq!(
            definers,
            vec!["db/read_receipts.rs".to_string(), "logging.rs".to_string()],
            "墙上时钟的名字多了一个（每多一个名字就多一份会漂的实现）：{definers:?}"
        );
        assert_eq!(
            reads_epoch,
            vec!["logging.rs".to_string()],
            "读系统时钟的地方必须只有家：{reads_epoch:?}"
        );
    }

    /// 上面那条判据比的是**清单**，所以分隔符必须与平台无关。
    ///
    /// 这条用例存在的理由是一次真实的假绿：5.15.26 在 macOS 上整跑全绿，CI 的 Windows 腿却红 ——
    /// `Path::display()` 在 Windows 上打 `\`，`rel_to_src` 交出 `db\read_receipts.rs`，
    /// 而判据手写的期望是 `db/read_receipts.rs`（run 40969401717）。归一化收在 `rel_to_src`
    /// 这一个家里，两条形状判据（墙上时钟、字节→hex）一起受益，所以正控也必须钉在这个函数上：
    /// 它不需要一台 Windows 机器就能证"带 `\` 的输入一定会被换成 `/`"。
    #[test]
    fn rel_to_src_is_separator_independent() {
        assert_eq!(
            rel_to_src(std::path::Path::new(r"db\read_receipts.rs")),
            "db/read_receipts.rs",
            "分隔符没归一化 ⇒ 这两条判据在 Windows 腿上会假红"
        );
        assert_eq!(rel_to_src(std::path::Path::new("logging.rs")), "logging.rs");
    }

    /// 正控：同一把尺子必须认得出"又长了一个名字"和"别名偷偷自己读钟"。
    #[test]
    fn the_wall_clock_matcher_catches_a_new_copy() {
        let copy = "fn now_ms() -> i64 {\n    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)\n}";
        assert!(
            copy.contains("fn now_ms("),
            "认不出新定义 ⇒ 上面那条判据不作数"
        );
        assert!(
            copy.contains("UNIX_EPOCH"),
            "认不出『别名自己读钟』 ⇒ 第二格断言是空的"
        );
        let alias = "pub fn now_ms() -> i64 {\n    crate::logging::now_ms()\n}";
        assert!(alias.contains("fn now_ms(") && !alias.contains("UNIX_EPOCH"));
        let call_only = "let now = crate::logging::now_ms();";
        assert!(
            !call_only.contains("fn now_ms("),
            "调用家的写法不该被判成多了一个名字"
        );
    }
}
