//! 那唯一一条 SQLite 连接的持锁耗时观测。
//!
//! `AppState::db` 用的是这里的 `DbLock`：取锁语义与 `std::sync::Mutex` 一致（含 poisoning，
//! 调用点写法一字不变），只在**释放锁之后**更新几个原子计数，因此不会因为埋点加长持锁。
//!
//! 两个量分得很开：`wait` = 开始请求锁到真正取得锁；`hold` = 取得锁到释放。慢锁判定、
//! `hold_total_ms`、`hold_max_ms` **只认 hold**，等锁排到多久都不算慢持锁 —— 否则一次
//! 纯排队的取锁会被读成"有人握了 800ms"，而排队的真正原因是别人那一次握得久。
//!
//! 覆盖范围如实限定：`AppState::db` 上经 `DbLock::lock()` / `try_lock()` 的取锁全部计入
//! （`try_lock()` 拿不到的那次没有持锁区间，不计；其调用点都在 `#[cfg(desktop)]` 里，
//! 移动端今天只有 `lock()`）。这里**刻意不实现 `Deref`**：一旦有 `Deref`，`&state.db` 就能
//! 悄悄当 `&Mutex<Connection>` 传出去，函数里那次 `.lock()` 走裸 Mutex、一笔都不计（2026-10-17
//! 实测这样漏过 6 处，见判据 `the_only_way_to_bypass_the_timer_is_closed`）。
//! 测试夹具里直接构造的 `Mutex<Connection>` 不在这把锁上，也不该计。
//! 持有多久能测到，但测不出"是谁拿的"（没有标签体系），所以定位要靠
//! "最长持有 + 最长等待 + 超阈值次数"三条一起看。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::{Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

/// 慢持锁的默认阈值（ms）。
pub const DEFAULT_SLOW_MS: u64 = 500;

/// 一把锁的持锁统计。放在 `DbLock` 上而不是全局静态里：
/// 全局计数会被 libtest 的并发用例互相清掉，那条"超阈值要产一行"的判据就永远测不准。
#[derive(Default)]
struct HoldStats {
    takes: AtomicU64,
    hold_total_ms: AtomicU64,
    hold_max_ms: AtomicU64,
    wait_max_ms: AtomicU64,
    slow: AtomicU64,
}

/// 一个窗口内的持锁统计快照。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DbHoldSummary {
    pub takes: u64,
    pub hold_total_ms: u64,
    pub hold_max_ms: u64,
    pub wait_max_ms: u64,
    pub slow: u64,
}

/// 一句话摘要；`None` 表示这个窗口里没有值得说的持锁，不产噪声。
/// 只含数字与阈值，不含 SQL、参数、文件名或任何正文。
pub fn summary_line(s: &DbHoldSummary, threshold_ms: u64) -> Option<String> {
    if s.slow == 0 && s.hold_max_ms < threshold_ms {
        return None;
    }
    Some(format!(
        "db 持锁观测：{} 次取锁，最长持有 {}ms（等待 {}ms），累计 {}ms，超 {}ms 的 {} 次",
        s.takes, s.hold_max_ms, s.wait_max_ms, s.hold_total_ms, threshold_ms, s.slow
    ))
}

/// 一条事务收尾观测（B15）。**只量不改**：调用点把 `.transaction()`（或只含它的那次收口调用）
/// 的结果原样传进来，本函数不取锁、不重试、不碰 commit/rollback 与错误语义。
/// 内容只有阶段名、关联键、毫秒与成败 —— 没有 SQL、参数、正文、文件名或密钥。
///
/// 只在**超阈值**或**失败**时留一行：`finish_receiver_into` 那条既有不变量
/// 「正常路径不留痕」（`network::file_tests::normal_completion_writes_no_ledger_note`）钉的是
/// 正常收尾**一行都不许写**，而快且成功的事务读数本来就在 60s 锁摘要里（`summary_line` 的
/// 最长持有/累计）⇒ 这里补的是"到底慢在哪一格、失败那次的耗时"，不是给每条正常事务加噪声。
/// 阈值沿用 [`DbLock::slow_threshold_ms`]（同一个家，不另造常数）。
pub fn note_tx(
    logger: &crate::logging::Logger,
    stage: &'static str,
    key: &str,
    started: std::time::Instant,
    slow_ms: u64,
    ok: bool,
) {
    let ms = started.elapsed().as_millis() as u64;
    if ok && ms < slow_ms.max(1) {
        return;
    }
    logger.warn("db", format!("tx {stage} {key} ms={ms} ok={ok}"));
}

/// `Mutex<T>` 的替身：既有的 `db.lock().unwrap_or_else(|e| e.into_inner())` 一字不改地继续成立
/// （返回同样的 `Result<_, PoisonError<_>>`），另外把每次持锁区间量出来。
pub struct DbLock<T> {
    inner: Mutex<T>,
    stats: Arc<HoldStats>,
    slow_ms: Arc<AtomicU64>,
}

impl<T> DbLock<T> {
    pub fn new(value: T) -> Self {
        Self {
            inner: Mutex::new(value),
            stats: Arc::new(HoldStats::default()),
            slow_ms: Arc::new(AtomicU64::new(DEFAULT_SLOW_MS)),
        }
    }

    pub fn lock(&self) -> Result<DbGuard<'_, T>, PoisonError<DbGuard<'_, T>>> {
        let started = Instant::now();
        match self.inner.lock() {
            Ok(guard) => Ok(self.guard(guard, started)),
            Err(poisoned) => Err(PoisonError::new(self.guard(poisoned.into_inner(), started))),
        }
    }

    /// 非阻塞取锁。拿不到的那次没有持锁区间，因此不计数。
    ///
    /// 调用点（开窗时那一点群名、辅助窗初始底色）都在 `#[cfg(desktop)]` 里 —— 移动端今天没有
    /// "不许阻塞主线程的 db 读"。按 `tray.rs` 立的口径用 `cfg_attr` 静音这一条，而不是整块 `#[cfg]`
    /// 掉：方法与它自己的用例在所有平台都参与编译。
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn try_lock(&self) -> Result<DbGuard<'_, T>, TryLockError<DbGuard<'_, T>>> {
        let started = Instant::now();
        match self.inner.try_lock() {
            Ok(guard) => Ok(self.guard(guard, started)),
            Err(TryLockError::WouldBlock) => Err(TryLockError::WouldBlock),
            Err(TryLockError::Poisoned(poisoned)) => Err(TryLockError::Poisoned(PoisonError::new(
                self.guard(poisoned.into_inner(), started),
            ))),
        }
    }

    /// 读走并清零计数。一个锁只允许有一个读者，两个读者会互相吞计数。
    pub fn take_summary(&self) -> DbHoldSummary {
        DbHoldSummary {
            takes: self.stats.takes.swap(0, Ordering::Relaxed),
            hold_total_ms: self.stats.hold_total_ms.swap(0, Ordering::Relaxed),
            hold_max_ms: self.stats.hold_max_ms.swap(0, Ordering::Relaxed),
            wait_max_ms: self.stats.wait_max_ms.swap(0, Ordering::Relaxed),
            slow: self.stats.slow.swap(0, Ordering::Relaxed),
        }
    }

    pub fn slow_threshold_ms(&self) -> u64 {
        self.slow_ms.load(Ordering::Relaxed)
    }

    /// 只给用例把阈值调小（生产走 [`DEFAULT_SLOW_MS`]，没有运行期改它的入口）：
    /// 没有这个入口的话，「超阈值要产一行」那条判据就得睡 500ms 才能观测到。
    #[cfg(test)]
    pub fn set_slow_threshold_ms(&self, ms: u64) {
        self.slow_ms.store(ms.max(1), Ordering::Relaxed);
    }

    fn guard<'a>(&'a self, guard: MutexGuard<'a, T>, started: Instant) -> DbGuard<'a, T> {
        let wait = started.elapsed();
        DbGuard {
            guard: Some(guard),
            acquired: Instant::now(),
            wait,
            stats: Arc::clone(&self.stats),
            slow_ms: Arc::clone(&self.slow_ms),
        }
    }
}

/// 持锁区间。`Drop` 里先放锁再记账：记一笔虽然只是几个原子量，但排在放锁之前就是加长持锁。
pub struct DbGuard<'a, T> {
    guard: Option<MutexGuard<'a, T>>,
    /// **取得**锁的那一刻（不含排队），所以 `held_ms()` 里一个毫秒都不掺等待。
    acquired: Instant,
    /// 请求锁到取得锁的时长，在取得锁的那一次调用里就量好了。
    wait: Duration,
    stats: Arc<HoldStats>,
    slow_ms: Arc<AtomicU64>,
}

impl<T> DbGuard<'_, T> {
    /// 这一段排队排了多久（ms）。给"等待大、持有小"那种诊断用。
    pub fn wait_ms(&self) -> u64 {
        self.wait.as_millis() as u64
    }

    /// 从取得锁到现在的持有时长（ms）。
    pub fn held_ms(&self) -> u64 {
        self.acquired.elapsed().as_millis() as u64
    }
}

/// 只为 `.expect()` / `.unwrap()` 的失败分支服务：`Result<DbGuard, PoisonError<DbGuard>>`
/// 要 `DbGuard: Debug` 才解得开。不把内层 `Connection` 打出来（它也不 `Debug`），
/// 只报这次区间自身的两个量 —— 够定位"哪一次解不开"，也不引入新的读数口径。
impl<T> std::fmt::Debug for DbGuard<'_, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbGuard")
            .field("wait_ms", &self.wait_ms())
            .field("held_ms", &self.held_ms())
            .field("released", &self.guard.is_none())
            .finish()
    }
}

impl<T> std::ops::Deref for DbGuard<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.guard
            .as_ref()
            .expect("DbGuard 的区间已经在 Drop 里结束")
    }
}

impl<T> std::ops::DerefMut for DbGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        self.guard
            .as_mut()
            .expect("DbGuard 的区间已经在 Drop 里结束")
    }
}

impl<T> Drop for DbGuard<'_, T> {
    fn drop(&mut self) {
        let held = self.acquired.elapsed();
        let wait = self.wait;
        drop(self.guard.take());
        let held_ms = held.as_millis() as u64;
        self.stats.takes.fetch_add(1, Ordering::Relaxed);
        self.stats
            .hold_total_ms
            .fetch_add(held_ms, Ordering::Relaxed);
        self.stats.hold_max_ms.fetch_max(held_ms, Ordering::Relaxed);
        self.stats
            .wait_max_ms
            .fetch_max(wait.as_millis() as u64, Ordering::Relaxed);
        if held_ms >= self.slow_ms.load(Ordering::Relaxed) {
            self.stats.slow.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_tx_stays_quiet_unless_slow_or_failed() {
        let dir = std::env::temp_dir().join(format!("gosslan-tx-note-{}", std::process::id()));
        let logger = crate::logging::Logger::new(dir.clone(), "t", "[dev:test]".to_string());
        let now = std::time::Instant::now();
        // ① 快且成功 ⇒ **一行都不写**（`normal_completion_writes_no_ledger_note` 钉的就是这一格）
        note_tx(&logger, "unit_ok", "transfer_id=t1", now, 10_000, true);
        assert!(
            logger.snapshot(None).is_empty(),
            "正常且不够慢的事务不该留痕，实得 {:?}",
            logger
                .snapshot(None)
                .iter()
                .map(|e| e.message.clone())
                .collect::<Vec<_>>()
        );
        let back = now
            .checked_sub(std::time::Duration::from_millis(50))
            .expect("Instant 可以往回取 50ms");
        // ② 超阈值 ⇒ warn，且耗时可读
        note_tx(&logger, "unit_slow", "transfer_id=t2", back, 10, true);
        // ③ 失败 ⇒ warn，且必须写清 ok=false
        note_tx(&logger, "unit_fail", "transfer_id=t3", now, 10_000, false);
        let entries = logger.snapshot(None);
        let line_of = |stage: &str| -> (String, String) {
            entries
                .iter()
                .find(|e| e.message.starts_with(&format!("tx {stage} ")))
                .map(|e| (e.level.clone(), e.message.clone()))
                .expect("这一格必须有出口")
        };
        let (level, msg) = line_of("unit_slow");
        assert_eq!(level, "warn", "超阈值的事务必须转 warn：{msg}");
        assert!(
            msg.contains("transfer_id=t2") && msg.contains("ms=") && msg.ends_with("ok=true"),
            "{msg}"
        );
        let (level, msg) = line_of("unit_fail");
        assert_eq!(level, "warn", "失败的事务不许静默无声：{msg}");
        assert!(msg.ends_with("ok=false"), "{msg}");
        assert_eq!(entries.len(), 2, "只有慢/失败两格留痕");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn short_hold_is_counted_but_not_slow() {
        let db = DbLock::new(1u32);
        {
            let mut g = db.lock().unwrap_or_else(|e| e.into_inner());
            *g += 1;
        }
        let s = db.take_summary();
        assert_eq!(s.takes, 1);
        assert_eq!(s.slow, 0, "空持锁不该被判成慢");
        assert_eq!(
            s.hold_total_ms, s.hold_max_ms,
            "一次持锁的累计与最长应当相等"
        );
        assert_eq!(
            *db.lock().unwrap_or_else(|e| e.into_inner()),
            2,
            "取锁语义必须与 Mutex 一致"
        );
    }

    #[test]
    fn hold_over_threshold_produces_exactly_one_line() {
        let db = DbLock::new(7u32);
        db.set_slow_threshold_ms(30);
        {
            let _g = db.lock().unwrap_or_else(|e| e.into_inner());
            std::thread::sleep(Duration::from_millis(80));
        }
        let s = db.take_summary();
        assert_eq!(s.slow, 1, "超阈值必须计一次，实得 {s:?}");
        assert!(s.hold_max_ms >= 60, "实测最长持有 {}ms", s.hold_max_ms);
        let line = summary_line(&s, db.slow_threshold_ms()).expect("超阈值要有这一句");
        assert!(line.contains("超 30ms 的 1 次"), "实得：{line}");
        assert!(line.contains("db 持锁观测"), "实得：{line}");
        assert!(
            summary_line(&db.take_summary(), db.slow_threshold_ms()).is_none(),
            "读走之后同一个窗口不该再说一遍"
        );
    }

    #[test]
    fn quiet_window_emits_nothing() {
        let db = DbLock::new(0u32);
        drop(db.lock().unwrap_or_else(|e| e.into_inner()));
        let s = db.take_summary();
        assert_eq!(s.slow, 0);
        assert!(
            summary_line(&s, db.slow_threshold_ms()).is_none(),
            "没超阈值就不该有日志，实得 {s:?}"
        );
        assert!(summary_line(&DbHoldSummary::default(), DEFAULT_SLOW_MS).is_none());
    }

    #[test]
    fn poisoning_still_reaches_the_caller_with_its_guard() {
        let db = DbLock::new(3u32);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = db.lock().unwrap_or_else(|e| e.into_inner());
            panic!("模拟持锁时 panic");
        }));
        assert!(panicked.is_err());
        {
            let g = db.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(*g, 3, "中毒之后 into_inner 这条路必须照旧可用");
        }
        assert!(db.take_summary().takes >= 2, "中毒那条路也要计数");
    }

    #[test]
    fn try_lock_blocked_by_a_holder_is_not_counted() {
        let db = DbLock::new(1u32);
        let held = db.lock().unwrap_or_else(|e| e.into_inner());
        assert!(db.try_lock().is_err(), "还被人拿着，try_lock 必须拿不到");
        drop(held);
        assert!(db.try_lock().is_ok());
        // 三次尝试、两次真拿到：拿不到的那次没有持锁区间，不许凭空计一笔
        let s = db.take_summary();
        assert_eq!(s.takes, 2, "实得 {s:?}");
    }

    /// 排队 ≠ 持有：甲握着锁不放，乙只是**等**了很久、拿到之后什么都没做。
    /// 这一条钉的是"两个量必须真的分开"，所以断言全是相对关系，不猜绝对耗时：
    /// 乙自己的 `wait_ms` 大而 `held_ms` 小；整把锁的 `slow` 只由甲那一次触发；
    /// `hold_total_ms` 不许把乙那段排队也累进去（旧实现里它是 `wait_max` 的两倍上下）。
    #[test]
    fn waiting_for_the_lock_is_not_counted_as_holding_it() {
        let db = DbLock::new(0u32);
        db.set_slow_threshold_ms(30);
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (about_to_wait_tx, about_to_wait_rx) = std::sync::mpsc::channel();
        let (measured_tx, measured_rx) = std::sync::mpsc::channel();
        let (released_tx, released_rx) = std::sync::mpsc::channel();
        let db_ref = &db;

        std::thread::scope(|scope| {
            // 两个闭包都 `move`：`Receiver` 不是 `Sync`，只能整只搬进线程；
            // `db_ref` 是共享引用（Copy），搬两次不冲突。
            scope.spawn(move || {
                let held = db_ref.lock().unwrap_or_else(|e| e.into_inner());
                // ⚠️ 必须先让乙看到"甲已经握住"再收乙的信号。旧写法让乙**先**发信号、
                // **后**调 lock()：系统忙时乙可能抢在甲之前拿到锁，等待自然量到 0ms，
                // 这不是产品缺陷而是测试自己的启动竞态（2026-10-18 实测红过一次）。
                held_tx.send(()).expect("乙还在");
                about_to_wait_rx.recv().expect("乙没到位，甲不该空握");
                std::thread::sleep(Duration::from_millis(200));
                drop(held);
                released_tx.send(()).expect("主线程还在收");
            });
            scope.spawn(move || {
                held_rx.recv().expect("甲没先握住，这条测量没有判别力");
                // 甲握着时 try_lock 必须失败 ⇒ 这一刻起乙再去 lock() 一定是在排队。
                assert!(db_ref.try_lock().is_err(), "甲握着时 try_lock 必须拿不到");
                about_to_wait_tx.send(()).expect("甲还在");
                let g = db_ref.lock().unwrap_or_else(|e| e.into_inner());
                let reading = (g.wait_ms(), g.held_ms());
                // 先放锁再报读数：记账排在 Drop 里，主线程要等的是**两条区间都结束**。
                drop(g);
                measured_tx.send(reading).expect("主线程还在收");
            });
            let (wait, hold) = measured_rx.recv().expect("乙的读数必须取回来");
            released_rx.recv().expect("甲的持锁区间没结束");
            assert!(wait >= 100, "乙实打实排了队，实得等待 {wait}ms");
            assert!(
                hold <= 10,
                "乙拿到锁之后什么都没做，这段不许被读成持有 {hold}ms"
            );
            let s = db.take_summary();
            assert_eq!(s.takes, 2, "两次真拿到");
            assert_eq!(
                s.slow, 1,
                "只有甲那次长持有该触发慢锁判定；把排队也算进来就变 2 次。实得 {s:?}"
            );
            assert!(s.wait_max_ms >= 50, "实得 {s:?}");
            assert!(
                s.hold_total_ms <= s.wait_max_ms + 40,
                "累计持有里掺进了排队：等待 {wait}ms，累计持有 {}ms，实得 {s:?}",
                s.hold_total_ms
            );
        });
    }

    /// 反面对照：锁没人抢，握得久才是真慢锁 —— 判定由 hold 触发，`wait` 保持贴着 0。
    #[test]
    fn a_long_hold_on_an_idle_lock_is_the_slow_one() {
        let db = DbLock::new(0u32);
        db.set_slow_threshold_ms(30);
        let g = db.lock().unwrap_or_else(|e| e.into_inner());
        assert!(g.wait_ms() <= 10, "没人抢的锁不该量出排队");
        assert!(g.held_ms() < 30, "刚拿到就判成慢，说明阈值读错了对象");
        std::thread::sleep(Duration::from_millis(80));
        assert!(g.held_ms() >= 60, "实得 {}ms", g.held_ms());
        drop(g);
        let s = db.take_summary();
        assert_eq!(s.slow, 1, "长持有必须触发判定，实得 {s:?}");
        assert!(s.hold_max_ms >= 60, "实得 {s:?}");
        assert!(s.wait_max_ms <= 10, "这条路上没有排队，实得 {s:?}");
    }

    /// 计数挂在每把锁自己的 `Arc` 上（不是全局 static）：多线程同抢一把、另有第二把，
    /// 三者互不污染。这条用例不含任何时序断言。
    #[test]
    fn counters_do_not_bleed_across_threads_or_across_locks() {
        let shared = DbLock::new(0u32);
        let other = DbLock::new(0u32);
        other.set_slow_threshold_ms(1);
        const THREADS: usize = 4;
        const TAKES: usize = 25;
        std::thread::scope(|scope| {
            for _ in 0..THREADS {
                scope.spawn(|| {
                    for _ in 0..TAKES {
                        let g = shared.lock().unwrap_or_else(|e| e.into_inner());
                        drop(g);
                    }
                });
            }
        });
        drop(other.lock().unwrap_or_else(|e| e.into_inner()));
        let s = shared.take_summary();
        assert_eq!(
            s.takes,
            (THREADS * TAKES) as u64,
            "{THREADS} 个线程各 {TAKES} 次，一次都不许少计"
        );
        assert_eq!(s.slow, 0, "空持锁不该被别的锁的阈值判成慢");
        let o = other.take_summary();
        assert_eq!(o.takes, 1, "另一把锁的计数不许串过来");
        assert_eq!(o.slow, 0);
        assert_eq!(shared.take_summary().takes, 0, "读走之后同一个窗口不该再报");
    }

    /// 绕开计时的唯一那条路就是"`&Mutex<Connection>` 形参 + 裸 `Mutex::lock()`"，
    /// 而它只有在 `DbLock` 能被 `Deref` 成 `Mutex` 时才走得通。三件事一起钉：
    /// 这里不许长出 `Deref`、那两份生产码的形参必须是带计时的锁、且不得再收裸 Mutex。
    #[test]
    fn the_only_way_to_bypass_the_timer_is_closed() {
        let hold = include_str!("db_hold.rs");
        // 分两段拼：写成一条完整字面量的话，这段源码自己就带着它，`contains` 永远为真。
        let deref_impl = concat!("impl<T> std::ops::", "Deref for DbLock");
        assert!(
            !hold.contains(deref_impl),
            "DbLock 又可以被 Deref 成裸 Mutex 了：&state.db 会悄悄退化成 &Mutex<Connection>"
        );
        for (name, src) in [
            ("receive.rs", include_str!("network/file/receive.rs")),
            ("favorites.rs", include_str!("commands/favorites.rs")),
        ] {
            assert_eq!(
                src.matches("&std::sync::Mutex<rusqlite::Connection>")
                    .count(),
                0,
                "{name} 里还有收裸 Mutex 的 db 形参，那里每次取锁都不计数"
            );
            assert!(
                src.contains("DbLock<rusqlite::Connection>"),
                "{name} 的 db 形参没换成带计时的锁"
            );
        }
    }

    /// 接线判据：字段必须真的换成这把带计时的锁，读者与产日志点各只许一处。
    #[test]
    fn timed_lock_is_wired_into_the_app() {
        let state = include_str!("state.rs");
        assert_eq!(
            state.matches("pub db: DbLock<Connection>").count(),
            1,
            "AppState.db 必须换成 DbLock，否则全仓那些取锁一条都不计"
        );
        assert!(
            !state.contains("db: Mutex<Connection>"),
            "state.rs 里还留着旧的字段类型"
        );
        let lib = include_str!("lib.rs");
        assert_eq!(
            lib.matches(".db.take_summary()").count(),
            1,
            "读者只能有一处：两个读者会互相吞计数"
        );
        assert_eq!(
            lib.matches("db_hold::summary_line").count(),
            1,
            "摘要的产日志点只能有一处"
        );
    }
}
