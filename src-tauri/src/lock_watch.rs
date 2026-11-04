//! 非 `db` 锁的具名持锁观测与等待关系。
//!
//! **要治的那一格**（2026-11-04 审计）：现场反复出现「无 panic、CPU 很低、界面卡住」，
//! 但除了 `db` 那把锁（`db_hold.rs` 已量）之外，其余进程级锁**谁握了多久、谁在等谁**
//! 在 HANG 报告里一行都没有。没有名字就只能靠读代码猜。
//!
//! 覆盖范围如实限定：只有显式包成 [`NamedLock`] 的锁才计入（今天接的是
//! `file_receivers` / `group_file_receivers` 这两张「持锁写盘」的表）。其余锁的争用关系
//! 仍按 `scripts/check-lock-scope.mjs` 的静态判据论证，不靠这里的读数。
//!
//! 开销与判据：
//! - 快路径（没人抢、持有时间短）只多两次原子加减 + 一次 `Instant::now()`；
//!   释放时比阈值小 ⇒ 不加锁、不分配、不写日志。
//! - 只有**持锁超过阈值**（[`DEFAULT_HOLD_WARN_MS`]）才进事件环，由看门狗线程统一落盘
//!   （`LOCK_HELD_LONG name=… holder=… waited_by=… ms=…`）。
//! - 等待者标签只在 `waiters > 1` 时写进小 `Vec`，并在取得锁时清空 —— 无竞争时一次都不碰。
//!
//! ⚠️ 与 `db_hold.rs` 同一条硬约束：**不实现 `Deref`**。一旦能 `Deref` 成裸 `Mutex`，
//! 就能把它当 `&Mutex<T>` 传出去，那里每次取锁都不计数（判据见本文件用例）。

use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

/// 持锁超过这个时长就产一条 `LOCK_HELD_LONG`（生产默认值，可在启动面按需下调）。
pub const DEFAULT_HOLD_WARN_MS: u64 = 2_000;

/// 事件环上限：只留最近若干条，防止"真的卡死很久"时把内存吃满。
pub const EVENT_RING_CAP: usize = 32;

/// 注册表上限：生产只有一个 `AppState`（2 把锁）；单元测试会反复建，封顶防无界增长。
const REGISTRY_CAP: usize = 64;

/// HANG 现场里最多列几把锁（按持有时长降序），再多就截断并标 `+N`。
const SNAPSHOT_MAX_LOCKS: usize = 4;

/// 单调毫秒（进程内基准）。只用相对差，不落盘、不需要墙钟；比 `SystemTime::now`
/// 便宜（快路径每次取锁都要读一次，省下的是每次取锁的固定成本）。
fn mono_ms() -> i64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as i64
}

/// 当前线程的诊断标识（懒分配、单调递增）。
///
/// 不用 `ThreadId`：它没有稳定的数字表示，而现场行按空白分字段、要短。
fn thread_token() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::thread_local!(static TOKEN: u64 = NEXT.fetch_add(1, Ordering::Relaxed));
    TOKEN.with(|t| *t)
}

/// 一把锁的现场。`held_since_ms == 0` 表示没人持有。
pub struct LockProbe {
    pub name: &'static str,
    held_since_ms: AtomicI64,
    holder: AtomicU64,
    waiters: AtomicU32,
    /// 有没有人往 `waiter_tags` 里写过。快路径靠它一个原子读就跳过 Mutex（见 `guard`）。
    tags_dirty: std::sync::atomic::AtomicBool,
    waiter_tags: Mutex<Vec<u64>>,
    hold_max_ms: AtomicU64,
    long_count: AtomicU64,
    last_long_ms: AtomicU64,
    warn_ms: AtomicU64,
}

impl LockProbe {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            held_since_ms: AtomicI64::new(0),
            holder: AtomicU64::new(0),
            waiters: AtomicU32::new(0),
            tags_dirty: std::sync::atomic::AtomicBool::new(false),
            waiter_tags: Mutex::new(Vec::new()),
            hold_max_ms: AtomicU64::new(0),
            long_count: AtomicU64::new(0),
            last_long_ms: AtomicU64::new(0),
            warn_ms: AtomicU64::new(DEFAULT_HOLD_WARN_MS),
        }
    }

    /// 供 HANG 现场用：`name:held=Nms:holder=tK:wait=[tA,tB]`；没人持有 ⇒ `None`。
    fn snapshot(&self) -> Option<String> {
        let since = self.held_since_ms.load(Ordering::Relaxed);
        if since <= 0 {
            return None;
        }
        let held = (mono_ms() - since).max(0);
        let holder = self.holder.load(Ordering::Relaxed);
        let waiting = self
            .waiter_tags
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if waiting.is_empty() {
            Some(format!("{}:held={held}ms:holder=t{holder}", self.name))
        } else {
            Some(format!(
                "{}:held={held}ms:holder=t{holder}:wait=[{}]",
                self.name,
                waiting
                    .iter()
                    .map(|t| format!("t{t}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        }
    }
}

/// 全局注册表：生产只有一个实例在写，读的是看门狗线程。
fn registry() -> &'static Mutex<Vec<std::sync::Arc<LockProbe>>> {
    static REG: OnceLock<Mutex<Vec<std::sync::Arc<LockProbe>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Vec::new()))
}

/// 超阈值事件环。看门狗每拍 `drain_events()` 落盘（`logger.warn`）。
fn events() -> &'static Mutex<std::collections::VecDeque<String>> {
    static RING: OnceLock<Mutex<std::collections::VecDeque<String>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

/// 一条具名锁 + 它的现场。取锁 API 与 `std::sync::Mutex` 一致（含 poisoning），
/// 既有调用点写法一字不变。
pub struct NamedLock<T> {
    inner: Mutex<T>,
    probe: std::sync::Arc<LockProbe>,
}

impl<T> NamedLock<T> {
    pub fn new(name: &'static str, value: T) -> Self {
        let probe = std::sync::Arc::new(LockProbe::new(name));
        {
            let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            if reg.len() < REGISTRY_CAP {
                reg.push(std::sync::Arc::clone(&probe));
            }
        }
        Self {
            inner: Mutex::new(value),
            probe,
        }
    }

    pub fn lock(&self) -> Result<NamedGuard<'_, T>, PoisonError<NamedGuard<'_, T>>> {
        let tag = thread_token();
        // 快路径：先占一个等待名额。无人竞争时这次加减是唯一的额外成本。
        let ahead = self.probe.waiters.fetch_add(1, Ordering::AcqRel);
        if ahead > 0 || self.probe.holder.load(Ordering::Relaxed) != 0 {
            // 真的有人在前面（或已经有主）⇒ 才去记"谁在等"（诊断用，允许少量竞态）。
            self.probe
                .waiter_tags
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(tag);
            self.probe.tags_dirty.store(true, Ordering::Release);
        }
        let started = Instant::now();
        match self.inner.lock() {
            Ok(guard) => {
                self.probe.waiters.fetch_sub(1, Ordering::AcqRel);
                Ok(self.guard(guard, started, tag))
            }
            Err(poisoned) => {
                self.probe.waiters.fetch_sub(1, Ordering::AcqRel);
                Err(PoisonError::new(self.guard(
                    poisoned.into_inner(),
                    started,
                    tag,
                )))
            }
        }
    }

    fn guard<'a>(
        &'a self,
        guard: MutexGuard<'a, T>,
        started: Instant,
        tag: u64,
    ) -> NamedGuard<'a, T> {
        // 取得锁 ⇒ 换我持有；"谁在等"这张表本拍清空（下一批等待者会重新填）。
        // 没人写过时只花一个原子读，不碰 Mutex（这是快路径的一部分）。
        self.probe.holder.store(tag, Ordering::Relaxed);
        self.probe.held_since_ms.store(mono_ms(), Ordering::Relaxed);
        if self.probe.tags_dirty.swap(false, Ordering::AcqRel) {
            self.probe
                .waiter_tags
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
        }
        NamedGuard {
            guard: std::mem::ManuallyDrop::new(guard),
            acquired: Instant::now(),
            waited: started.elapsed(),
            probe: std::sync::Arc::clone(&self.probe),
            tag,
        }
    }
}

/// 持锁区间。`Drop` 里**先放锁再记账**（与 `DbGuard` 同一条口径：记账不许加长持锁）。
///
/// 用 `ManuallyDrop` 而不是 `Option`：`Deref`/`DerefMut` 是 40+ 个既有调用点的透明入口，
/// 若要 `Option` 就得在每次解引用写 `.expect(...)` —— 那是会 abort 整个进程的 panic 站点
/// （本仓 `panic = "abort"`，且 panic 站点棘轮只许降）。这里只有 `Drop` 里一次
/// `take`，且当场 `drop`，不存在"拿走不还"的路径。
pub struct NamedGuard<'a, T> {
    guard: std::mem::ManuallyDrop<MutexGuard<'a, T>>,
    acquired: Instant,
    waited: std::time::Duration,
    probe: std::sync::Arc<LockProbe>,
    tag: u64,
}

impl<T> NamedGuard<'_, T> {
    /// 这一段排队排了多久（ms）。给"等待大、持有小"的诊断用。
    pub fn wait_ms(&self) -> u64 {
        self.waited.as_millis() as u64
    }

    /// 从取得锁到现在的持有时长（ms）。
    pub fn held_ms(&self) -> u64 {
        self.acquired.elapsed().as_millis() as u64
    }
}

impl<T> std::fmt::Debug for NamedGuard<'_, T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamedGuard")
            .field("name", &self.probe.name)
            .field("wait_ms", &self.wait_ms())
            .field("held_ms", &self.held_ms())
            .finish()
    }
}

impl<T> std::ops::Deref for NamedGuard<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        // ManuallyDrop<MutexGuard<T>> 在引用上自动解两跳 → &T。
        &self.guard
    }
}

impl<T> std::ops::DerefMut for NamedGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.guard
    }
}

impl<T> Drop for NamedGuard<'_, T> {
    fn drop(&mut self) {
        let held = self.acquired.elapsed();
        let waited = self.waited;
        let held_ms = held.as_millis() as u64;
        let warn_ms = self.probe.warn_ms.load(Ordering::Relaxed);
        // "谁在等"必须在**放锁前**抄走：放锁之后下一个等待者会立刻清空这张表，
        // 之后再读就只剩空数组（现场会读成"没人等"，恰好把有竞争的那次说反）。
        // 抄一张小 Vec 是微秒级，且只在已经超阈值的这一格做（正常释放不走这里）。
        let waiting = if held_ms >= warn_ms {
            self.probe
                .waiter_tags
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        } else {
            Vec::new()
        };
        drop(unsafe { std::mem::ManuallyDrop::take(&mut self.guard) });
        self.probe.held_since_ms.store(0, Ordering::Relaxed);
        self.probe.holder.store(0, Ordering::Relaxed);
        self.probe.hold_max_ms.fetch_max(held_ms, Ordering::Relaxed);
        if held_ms < warn_ms {
            return;
        }
        self.probe.long_count.fetch_add(1, Ordering::Relaxed);
        self.probe.last_long_ms.store(held_ms, Ordering::Relaxed);
        // 一行、可 grep：`LOCK_HELD_LONG name=… holder=… waited_by=… ms=…`
        let mut ring = events().lock().unwrap_or_else(|e| e.into_inner());
        if ring.len() >= EVENT_RING_CAP {
            ring.pop_front();
        }
        ring.push_back(format!(
            "LOCK_HELD_LONG name={} holder=t{} waited_by=[{}] ms={} wait_ms={}",
            self.probe.name,
            self.tag,
            waiting
                .iter()
                .map(|t| format!("t{t}"))
                .collect::<Vec<_>>()
                .join(","),
            held_ms,
            waited.as_millis() as u64
        ));
    }
}

/// 取走本窗口的超阈值事件（看门狗调用）。空 ⇒ 不产日志。
pub fn drain_events() -> Vec<String> {
    let mut ring = events().lock().unwrap_or_else(|e| e.into_inner());
    ring.drain(..).collect()
}

/// HANG 现场用的一句话：当前被持有的锁（按持有时长降序），没人持有 ⇒ `none`。
/// 只含锁名、线程标识与毫秒，不含任何业务正文；按空白分字段的旧解析不受影响。
pub fn snapshot_field() -> String {
    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let mut held: Vec<(u64, String)> = reg
        .iter()
        .filter_map(|p| {
            let since = p.held_since_ms.load(Ordering::Relaxed);
            if since <= 0 {
                return None;
            }
            let ms = (mono_ms() - since).max(0) as u64;
            p.snapshot().map(|s| (ms, s))
        })
        .collect();
    drop(reg);
    if held.is_empty() {
        return "none".to_string();
    }
    held.sort_by_key(|a| std::cmp::Reverse(a.0));
    let extra = held.len().saturating_sub(SNAPSHOT_MAX_LOCKS);
    let mut out: Vec<String> = held
        .into_iter()
        .take(SNAPSHOT_MAX_LOCKS)
        .map(|(_, s)| s)
        .collect();
    if extra > 0 {
        out.push(format!("+{extra}"));
    }
    out.join(",")
}

/// 把事件环里的行落盘。看门狗每拍调一次；`logger` 由调用方给（本模块不持 logger，
/// 避免在锁释放路径上再取另一把锁）。
pub fn flush_events(logger: &crate::logging::Logger) {
    for line in drain_events() {
        logger.warn("lock", line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本模块的读数是**进程级全局**（事件环 + 注册表），而 Rust 默认并行跑测试。
    /// 不串行化时「另一个用例的锁」会出现在本用例的快照里 —— 那不是产品缺陷，
    /// 是判据自己没隔离（第一次就真红在这里）。所有碰全局状态的用例都先拿这把锁。
    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn logger_for(name: &str) -> crate::logging::Logger {
        let dir =
            std::env::temp_dir().join(format!("gosslan-lock-watch-{name}-{}", std::process::id()));
        crate::logging::Logger::new(dir, name, "[dev:test]".to_string())
    }

    /// 阈值下调只给用例用（生产走常量，没有运行期改它的入口）。
    fn set_warn_ms<T>(lock: &NamedLock<T>, ms: u64) {
        lock.probe.warn_ms.store(ms.max(1), Ordering::Relaxed);
    }

    /// ① 短持有 ⇒ 事件环空（默认开启但不产噪声）。
    #[test]
    fn short_hold_stays_quiet() {
        let _serial = serial();
        let _ = drain_events(); // 清掉前一个用例的尾巴
        let lock = NamedLock::new("unit_short", 0u32);
        {
            let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
        }
        assert!(
            drain_events().is_empty(),
            "没超阈值的持锁不许产事件，否则日志会被正常使用打满"
        );
        assert!(
            !snapshot_field().contains("unit_short"),
            "短持有已经结束了，HANG 快照里不该再有它：{}",
            snapshot_field()
        );
    }

    /// ② 超阈值 ⇒ **恰好一条**，且名字/持有者/等待者/毫秒都在。
    #[test]
    fn long_hold_emits_one_named_line() {
        let _serial = serial();
        let _ = drain_events();
        let lock = NamedLock::new("unit_long", 0u32);
        set_warn_ms(&lock, 30);
        {
            let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let events = drain_events();
        assert_eq!(events.len(), 1, "超阈值必须恰好一条，实得 {events:?}");
        let line = &events[0];
        assert!(line.starts_with("LOCK_HELD_LONG name=unit_long"), "{line}");
        assert!(line.contains("holder=t"), "{line}");
        assert!(line.contains("waited_by=["), "{line}");
        assert!(line.contains("ms="), "{line}");
        // 第一个 token 是 `code=`（本身就是检索键），其后的字段之间用空格分隔；
        // 值里若再出现空格就会把字段切断，现场解析会读出半个值。
        let pairs: Vec<&str> = line.split_whitespace().skip(1).collect();
        assert!(
            pairs.iter().all(|p| p.contains('=')),
            "现场行必须是纯 `k=v` 字段，实得 {pairs:?}"
        );
        assert!(!line.contains('\n'), "{line}");
    }

    /// ②′ 真实复现：**生产默认阈值 2000ms** 下人为持锁 3s，必须打出带名字的报告，
    /// 且 `waited_by` 里要有那个真的排了 2s 以上的线程（不是靠调小阈值"造"出来的绿）。
    #[test]
    fn three_second_hold_is_reported_with_default_threshold() {
        let _serial = serial();
        let _ = drain_events();
        let lock = NamedLock::new("repro_hold_3s", 0u32);
        assert_eq!(
            lock.probe.warn_ms.load(Ordering::Relaxed),
            DEFAULT_HOLD_WINDOW_MS_FOR_TEST,
            "复现必须走生产阈值；调小阈值就证明不了「卡住 3s 能被发现」"
        );
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
                held_tx.send(()).expect("乙还在");
                std::thread::sleep(std::time::Duration::from_secs(3));
            });
            held_rx.recv().expect("甲没先握住");
            let g = lock.lock().unwrap_or_else(|e| e.into_inner());
            assert!(
                g.wait_ms() >= 2_000,
                "乙必须真的排了 ≥2s（实得 {}ms），否则这条复现没有意义",
                g.wait_ms()
            );
        });
        let events = drain_events();
        assert_eq!(events.len(), 1, "3s 持锁必须正好报一条：{events:?}");
        assert!(
            events[0].contains("name=repro_hold_3s"),
            "报告里必须有锁名：{}",
            events[0]
        );
        assert!(
            events[0].contains("waited_by=[t"),
            "报告必须写出谁在等：{}",
            events[0]
        );
        let at = events[0].find("ms=").expect("必须有 ms=");
        let ms: u64 = events[0][at + 3..]
            .split_whitespace()
            .next()
            .and_then(|s| s.parse().ok())
            .expect("ms= 后面必须是数字");
        assert!(ms >= 2_000, "报告的持有毫秒必须 ≥2000，实得 {ms}");
    }

    /// 临时压测：量化「加了观测」每次取锁多花多少（生产空闲时的增量按这个折算）。
    #[test]
    #[ignore]
    fn bench_overhead() {
        const N: u32 = 2_000_000;
        let bare = Mutex::new(0u32);
        let t = Instant::now();
        for _ in 0..N {
            let mut g = bare.lock().unwrap_or_else(|e| e.into_inner());
            *g += 1;
        }
        let bare_ns = t.elapsed().as_nanos() as f64 / N as f64;
        let named = NamedLock::new("bench", 0u32);
        let t = Instant::now();
        for _ in 0..N {
            let mut g = named.lock().unwrap_or_else(|e| e.into_inner());
            *g += 1;
        }
        let named_ns = t.elapsed().as_nanos() as f64 / N as f64;
        println!(
            "BENCH bare={bare_ns:.1}ns named={named_ns:.1}ns delta={:.1}ns",
            named_ns - bare_ns
        );
    }

    /// 生产默认阈值（只读常量，不在用例里改它）。
    const DEFAULT_HOLD_WINDOW_MS_FOR_TEST: u64 = 2_000;

    /// ③ 「谁在等谁」：乙排队时，甲持有期内的快照必须把乙的线程标识列出来。
    #[test]
    fn snapshot_names_the_waiter() {
        let _serial = serial();
        let _ = drain_events();
        let lock = NamedLock::new("unit_wait", 0u32);
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (measured_tx, measured_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let g = lock.lock().unwrap_or_else(|e| e.into_inner());
                held_tx.send(()).expect("乙还在");
                // 让乙进入排队，再看快照。
                std::thread::sleep(std::time::Duration::from_millis(120));
                let snap = snapshot_field();
                measured_tx.send(snap).expect("主线程还在收");
                drop(g);
            });
            held_rx.recv().expect("甲没先握住");
            let g = lock.lock().unwrap_or_else(|e| e.into_inner());
            assert!(
                g.wait_ms() >= 50,
                "乙必须真的排过队，实得 {}ms",
                g.wait_ms()
            );
        });
        let snap = measured_rx.recv().expect("快照必须取回来");
        assert!(
            snap.contains("unit_wait") && snap.contains("wait=["),
            "快照必须写出等待者：{snap}"
        );
    }

    /// ④ 取锁语义与 `Mutex` 一致：中毒也照旧能拿到内层值。
    #[test]
    fn poisoning_still_reaches_the_caller() {
        let lock = NamedLock::new("unit_poison", 3u32);
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
            panic!("模拟持锁时 panic");
        }));
        assert!(panicked.is_err());
        let g = lock.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(*g, 3, "中毒之后 into_inner 这条路必须照旧可用");
    }

    /// ⑤ 绕开计时的唯一那条路是 `Deref` 成裸 `Mutex` —— 钉住它不存在（反例自证）。
    #[test]
    fn no_deref_to_bare_mutex() {
        let src = include_str!("lock_watch.rs");
        let prod = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let deref_impl = concat!("impl<T> std::ops::", "Deref for NamedLock");
        assert!(
            !prod.contains(deref_impl),
            "NamedLock 又可以被 Deref 成裸 Mutex 了：&state.file_receivers 会悄悄退化成 \
             &Mutex<…>，那里每次取锁都不计数"
        );
    }

    /// ⑥ 接线判据：两张接收表必须真的是 `NamedLock`（否则本模块一行读数都不会有）。
    #[test]
    fn receiver_locks_are_wired() {
        let state = include_str!("state.rs");
        let wired = "crate::lock_watch::NamedLock<HashMap<String, FileReceiver>>";
        assert_eq!(
            state.matches(wired).count(),
            2,
            "两张接收表必须都是 NamedLock（单聊 + 群文件），否则持锁写盘那段永远没有名字"
        );
        // 反例自证：字段若退回裸 Mutex，上面那条立刻变 0 ⇒ 红（不是空过）。
        assert!(
            !state.contains("file_receivers: Mutex<HashMap<String, FileReceiver>>")
                && !state.contains("group_file_receivers: Mutex<HashMap<String, FileReceiver>>"),
            "state.rs 里还留着旧的裸 Mutex 字段"
        );
    }

    /// ⑦ 看门狗必须把事件落盘、并把快照写进 HANG 行 —— 否则测到的现象只活在内存里。
    #[test]
    fn watchdog_consumes_events_and_snapshot() {
        let wd = include_str!("watchdog.rs");
        assert!(
            wd.contains("lock_watch::flush_events"),
            "看门狗没有把 LOCK_HELD_LONG 落盘：事件环只进不出"
        );
        assert!(
            wd.contains("lock_watch::snapshot_field"),
            "HANG 行没有 locks= 现场：卡住时仍然读不出谁握着锁"
        );
        assert!(
            wd.contains("worker_lag_ms"),
            "HANG 行没有 worker 阻塞读数：这一层与主线程/渲染层是三条独立证据"
        );
    }

    /// ⑧ 落盘路径本身可用（真实 Logger，验证事件环 → logger 这一跳）。
    #[test]
    fn flush_writes_the_event_to_the_logger() {
        let _serial = serial();
        let _ = drain_events();
        let logger = logger_for("flush");
        let lock = NamedLock::new("unit_flush", 0u32);
        set_warn_ms(&lock, 20);
        {
            let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        flush_events(&logger);
        let entries = logger.snapshot(None);
        assert_eq!(entries.len(), 1, "必须恰好一条，实得 {entries:?}");
        assert!(
            entries[0]
                .message
                .starts_with("LOCK_HELD_LONG name=unit_flush"),
            "实得：{}",
            entries[0].message
        );
        let _ = std::fs::remove_dir_all(
            std::env::temp_dir().join(format!("gosslan-lock-watch-flush-{}", std::process::id())),
        );
    }
}
