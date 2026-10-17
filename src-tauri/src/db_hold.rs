//! 那唯一一条 SQLite 连接的持锁耗时观测。
//!
//! `AppState::db` 用的是这里的 `DbLock`：取锁语义与 `std::sync::Mutex` 一致（含 poisoning，
//! 调用点写法一字不变），只在**释放锁之后**更新几个原子计数，因此不会因为埋点加长持锁。
//!
//! 覆盖范围如实限定：经 `DbLock` 的 `lock()` / `try_lock()` 全部计入；直接构造的
//! `Mutex<Connection>`（例如测试夹具）不在这把锁上，不计入。持有期间的耗时能测到，
//! 但测不出"是谁拿的"（没有标签体系），所以定位要靠"最长持有 + 最长等待 + 超阈值次数"三条一起看。

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

    pub fn set_slow_threshold_ms(&self, ms: u64) {
        self.slow_ms.store(ms.max(1), Ordering::Relaxed);
    }

    fn guard<'a>(&'a self, guard: MutexGuard<'a, T>, started: Instant) -> DbGuard<'a, T> {
        DbGuard {
            guard: Some(guard),
            started,
            wait: started.elapsed(),
            stats: Arc::clone(&self.stats),
            slow_ms: Arc::clone(&self.slow_ms),
        }
    }
}

impl<T> std::ops::Deref for DbLock<T> {
    type Target = Mutex<T>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

/// 持锁区间。`Drop` 里先放锁再记账：记一笔虽然只是几个原子量，但排在放锁之前就是加长持锁。
pub struct DbGuard<'a, T> {
    guard: Option<MutexGuard<'a, T>>,
    started: Instant,
    wait: Duration,
    stats: Arc<HoldStats>,
    slow_ms: Arc<AtomicU64>,
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
        let held = self.started.elapsed();
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

    /// 接线判据：字段必须真的换成这把带计时的锁，读者与产日志点各只许一处。
    #[test]
    fn timed_lock_is_wired_into_the_app() {
        let state = include_str!("state.rs");
        assert_eq!(
            state.matches("pub db: DbLock<Connection>").count(),
            1,
            "AppState.db 必须换成 DbLock，否则 315 处取锁一条都不计"
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
