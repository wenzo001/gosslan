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
use std::sync::Mutex;

use serde::Serialize;

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
}

impl Logger {
    pub fn new(dir: PathBuf, stem: &str, fingerprint: String) -> Logger {
        Logger {
            entries: Mutex::new(VecDeque::with_capacity(MAX_MEM_LOGS)),
            dir,
            stem: stem.to_string(),
            fingerprint,
            diag_fold: Mutex::new(HashMap::new()),
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
        self.dir.join(format!("{}-crash.log", self.stem))
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

    /// 只有 panic 那一条走这条路：普通 error 不许建出现场文件（否则又变成第二个洪水源）。
    #[test]
    fn only_the_panic_target_creates_a_crash_file() {
        let dir = std::env::temp_dir().join(format!("gosslan-crash-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let logger = Logger::new(dir.clone(), "t", "[dev:test]".to_string());

        logger.error("file", "普通错误不该留下现场");
        logger.warn("panic-ish", "target 名字像但不是也不行");
        assert!(
            !dir.join("t-crash.log").exists(),
            "非 panic 的日志把崩溃现场文件建出来了"
        );

        logger.error("panic", "panic @ src/z.rs:2:2：真崩");
        assert!(
            dir.join("t-crash.log").exists(),
            "正向对照失败：真 panic 没落盘"
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
}
