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

use crate::private_fs::restrict_to_owner;

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
/// 路径由 [`bind_crash_file`] 尽早绑定（见 lib.rs 那个 bootstrap 插件）。
static CRASH_FILE: OnceLock<PathBuf> = OnceLock::new();
/// 防再入：分配失败时写这一行本身还要申请内存，可能再次打进分配器。
static NOTE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// 把现场文件路径交给独立写入器。**只认第一次绑定**（后来的 `Logger::new` 用的是同一个路径）。
pub fn bind_crash_file(path: &std::path::Path) {
    let _ = CRASH_FILE.set(path.to_path_buf());
}

/// 进程要消失之前都能调的一行留痕。目录没绑定 ⇒ 退回 stderr（不假装写成了）。
///
/// ⚠️ 与 `write_crash_block` 的分工：那条带"崩之前 300 条"上下文（要靠内存环，只有 logger 在时做得到）；
/// 这条只保证**一定写得出**，用在还没有 logger、或压根不会经过 panic 钩子的路径上。
pub fn crash_note(text: &str) {
    match CRASH_FILE.get() {
        Some(path) => crash_note_to(path, text),
        None => eprintln!("[gosslan] (现场文件未绑定，只能打到 stderr) {text}"),
    }
}

/// 真正写那一行的部分。**拆成显式路径**是为了可测：`CRASH_FILE` 是进程级 OnceLock，
/// 单元测试之间共享，直接测全局那条会互相抢绑定。
pub fn crash_note_to(path: &std::path::Path, text: &str) {
    use std::io::Write;
    if NOTE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return; // 再入：正在写现场时又触发分配失败，直接放弃这条（否则无限递归）
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        restrict_to_owner(path);
        let _ = writeln!(
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
        );
        let _ = f.flush();
    }
    NOTE_IN_PROGRESS.store(false, Ordering::SeqCst);
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
}

impl Logger {
    pub fn new(dir: PathBuf, stem: &str, fingerprint: String) -> Logger {
        let logger = Logger {
            entries: Mutex::new(VecDeque::with_capacity(MAX_MEM_LOGS)),
            dir,
            stem: stem.to_string(),
            fingerprint,
            diag_fold: Mutex::new(HashMap::new()),
            seed_ran: std::sync::atomic::AtomicBool::new(false),
        };
        // 把路径交给独立写入器（若 bootstrap 更早绑过，这条就是 no-op；只认第一次）
        bind_crash_file(&logger.crash_path());
        logger.write_startup_marker();
        // 启动前就存在的日志（含历史 .old.log）也要立刻收紧：
        // 只靠“下次写入时再 chmod”会让不再轮转的旧文件永久保持 0644。
        restrict_to_owner(&logger.current_path());
        restrict_to_owner(&logger.old_path());
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
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.crash_path())
        {
            restrict_to_owner(&self.crash_path());
            let _ = writeln!(
                f,
                "----- 启动 {} 版本 {} · {}-{} · {} · 设备 {} -----",
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
            );
        }
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
        self.append_file(ts, level, target, &message);

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

    fn current_path(&self) -> PathBuf {
        self.dir.join(format!("{}.log", self.stem))
    }
    fn old_path(&self) -> PathBuf {
        self.dir.join(format!("{}.old.log", self.stem))
    }
    /// 崩溃现场文件（**不参与轮转**）：`logs/gosslan-crash.log`，多实例是 `gosslan-1-crash.log`。
    fn crash_path(&self) -> PathBuf {
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

    fn append_file(&self, ts: i64, level: Level, target: &str, message: &str) {
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.current_path();

        // 惰性轮转：当前文件超限时，把旧内容挪到 `.old.log`（覆盖上一份旧文件）。
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_LOG_FILE_BYTES {
                let _ = std::fs::remove_file(self.old_path());
                let _ = std::fs::rename(&path, self.old_path());
            }
        }

        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            restrict_to_owner(&path);
            let line = format!(
                "{} {} {} [{}] {}",
                self.fingerprint,
                format_utc(ts),
                level.as_str(),
                target,
                message
            );
            let _ = writeln!(f, "{line}");
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
        let mut native: Vec<String> = read_tail_lines(&self.crash_path(), PREV_CRASH_TAIL_BYTES)
            .into_iter()
            .filter(|l| is_crash_native_line(l))
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把 Unix 毫秒时间戳格式化为 UTC `YYYY-MM-DD HH:MM:SS`（落盘文件用，可读）。
///
/// 不引入 chrono：标准库没有本地时区，这里给 UTC 时间，配合毫秒戳足够定位。
fn format_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

/// Howard Hinnant 的 civil_from_days：Unix 天数 → (年, 月, 日)，纯函数、无时区依赖。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// [`civil_from_days`] 的逆：(年, 月, 日) → Unix 天数。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// UTC `YYYY-MM-DD HH:MM:SS` → Unix 毫秒。解析不出来返回 `None`，不拿当前时间凑。
fn parse_utc_to_ms(text: &str) -> Option<i64> {
    let (date, time) = text.split_once(' ')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let dd: i64 = d.next()?.parse().ok()?;
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let s: i64 = t.next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&dd) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let days = days_from_civil(y, mo as u32, dd as u32);
    Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000)
}

/// 崩溃现场文件独有的三类行：独立通道留痕、启动路标、崩溃块头。
/// 指纹开头的行是运行日志的副本，由 `<stem>.log` 负责，不重复搬。
fn is_crash_native_line(line: &str) -> bool {
    line.starts_with(">>> ")
        || line.starts_with("----- 启动 ")
        || line.starts_with("===== 崩溃现场")
}

/// 现场文件里是否有原生行：区分"首次启动什么都没有"与"有但读不全"。
fn crash_native_exists(path: &std::path::Path) -> bool {
    read_tail_lines(path, PREV_CRASH_TAIL_BYTES)
        .iter()
        .any(|l| is_crash_native_line(l))
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
        let _ = std::fs::remove_dir_all(&dir);
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
    fn days_from_civil_inverts_civil_from_days() {
        for days in [-719_468i64, 0, 20_545, 25_500, 100_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(
                days_from_civil(y, m, d),
                days,
                "civil_from_days({days}) 的逆不成立"
            );
        }
        // 与 format_utc 互逆（整秒）
        let ms = 1_789_132_854_000i64;
        assert_eq!(parse_utc_to_ms(&format_utc(ms)), Some(ms));
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
}
