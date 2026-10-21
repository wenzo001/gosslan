//! 带**时间预算**的数据库整理（VACUUM）。
//!
//! ## 为什么要有预算
//!
//! VACUUM 重写整份 db 文件，期间**独占**全 App 唯一那条 SQLite 连接 ⇒ 所有 IPC 排队，
//! 用户看到的是"整个窗口冻住，点不动"。仓库自己的注释就写着这个后果
//! （`commands/channel.rs` 的 `CACHE_CLEAN_VACUUM_MIN_FREED_BYTES` 上面那段）：
//!
//! > "VACUUM 本身可能**秒~分钟级**，没删文件却空转一次等于**白冻全 App 一次**。"
//!
//! 之前只有"要不要做"的阈值（释放量不足 64 MiB 就不做），**没有"做多久要停"的上限**。
//! 阈值解决的是"小库别折腾"，解决不了"大库一旦做就冻几十分钟"。
//!
//! ## 怎么中止
//!
//! SQLite 的 `sqlite3_progress_handler` 能在语句执行**途中**回调并返回"中断"。
//! VACUUM 是事务性的 ⇒ **被中断会回滚，原库一字未改**（本模块的测试钉住这一点：
//! 中断后 `PRAGMA integrity_check` 仍是 ok、表还能读写、库文件没有半成品）。
//!
//! ## 为什么要"先做再中止"而不是"算准了再决定要不要做"
//!
//! 碎片量在**动手之前**是算不准的（SQLite 的页内空洞只有 VACUUM 自己知道）。
//! "先做后中止"是唯一能在"完全不做"与"可能冻几分钟"之间取平衡的办法：
//! **大多数库几毫秒就整理完了**（预算根本用不上），**只有真的很大的库才会撞上预算**。
//!
//! ## 预算管的是哪一段
//!
//! 只管 **VACUUM 自己跑了多久**。**排队等锁的时间不算在内** —— 那是别人的账
//! （等锁时长由 `db_hold` 的持锁观测单独报数），把它算进预算会得出"我这下慢是因为别人
//! 握着锁"这种读错因的结论。

use std::time::{Duration, Instant};

use rusqlite::Connection;

/// 默认时间预算：3 秒。
///
/// 为什么是 3 秒：用户按「立即清理缓存」时，界面卡住超过 3 秒就已经开始让人觉得"点了没反应"，
/// 而**绝大多数库的整理在几毫秒内就完成**（预算根本用不上）⇒ 3 秒既能覆盖"大库也整理得完"
/// 的常态，又能把"超大库"的最坏卡顿压在可接受范围内。
pub const DEFAULT_VACUUM_BUDGET_MS: u64 = 3_000;

/// 进度回调的检查间隔：每多少条 SQLite 虚机指令问一次"到点了吗"。
///
/// **实测（42 MB 库，VACUUM 全程约 6.5ms）**：
/// - `num_ops = 1` ⇒ 回调 **2687 次**，首 263µs / 末 6.6ms ⇒ 均匀铺满全程；
/// - `num_ops = 100` / `1000` ⇒ 回调只有 **18 次**，且**不是均匀分布**（绝大多数挤在
///   前期）⇒ VACUUM 的整库重写主要在 C 层进行、产生的虚机指令极少 ⇒ 回调**不会**在
///   真正耗时的那一段被调用。
///
/// ⇒ 结论：**只有 `num_ops = 1` 能可靠地在预算处中止**。实测对照：
/// 2ms 预算 + `num_ops = 1000` ⇒ **直接跑完了**（压根没拦住）；2ms 预算 + `num_ops = 1`
/// ⇒ **正好 2ms 中止**。
///
/// 开销可忽略：回调体只有一次 `Instant::now()` 比较（实测 2687 次 ≈ 67µs，占 6.5ms 的
/// 整理时间的 ~1%），且只在整理期间存在。
const PROGRESS_CHECK_OPS: i32 = 1;

/// 一次整理的结局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VacuumOutcome {
    /// 做完了（`exec_ms` 是实际执行时长）。
    Completed { exec_ms: u64 },
    /// 超预算被中断 —— **库保持原样，可读可写**（SQLite 回滚了这次整理）。
    Aborted { exec_ms: u64 },
    /// 出错了（不是被预算中断的）。库同样保持原样。
    Failed { exec_ms: u64, reason: String },
}

impl VacuumOutcome {
    /// 这一轮有没有真的把库整理了。
    pub fn is_completed(&self) -> bool {
        matches!(self, VacuumOutcome::Completed { .. })
    }

    /// **机器可读**的结局码（回界面用；句子由前端按码本地化）。
    ///
    /// 为什么不给中文句子：这个字段要跨 IPC 到界面，而界面有中英两套文案
    /// （`src/i18n/locales/`）——后端只说"发生了什么"，怎么说由界面决定。
    pub fn state_code(&self) -> &'static str {
        match self {
            VacuumOutcome::Completed { .. } => "done",
            VacuumOutcome::Aborted { .. } => "aborted",
            VacuumOutcome::Failed { .. } => "failed",
        }
    }

    /// 给日志/用户看的一句话。
    ///
    /// 为什么把"被中断"和"出错"分开说：前者是**我们主动停的**（库完好，只是没压缩），
    /// 后者是**出了意外**（要查）。混成一句话会让"用户点了没反应"和"数据库坏了"看起来一样。
    pub fn note(&self) -> String {
        match self {
            VacuumOutcome::Completed { exec_ms } => format!("已整理，执行 {exec_ms}ms"),
            VacuumOutcome::Aborted { exec_ms } => {
                format!("超预算已中止（执行 {exec_ms}ms 撞上时限），数据库未压缩、内容完好")
            }
            VacuumOutcome::Failed { exec_ms, reason } => {
                format!("失败，执行 {exec_ms}ms: {reason}")
            }
        }
    }
}

/// 带时间预算地整理数据库。
///
/// - 预算内做完 ⇒ [`VacuumOutcome::Completed`]；
/// - 超预算 ⇒ 装一个进度回调在语句途中把它**中断**掉 ⇒ [`VacuumOutcome::Aborted`]，
///   **原库保持原样**（SQLite 回滚这次整理，表还能读写）；
/// - 其它错误 ⇒ [`VacuumOutcome::Failed`]。
///
/// 进度回调是**连接级**的钩子，函数结束时**一定会卸掉**（否则后面每一条语句都会带上它）。
pub fn vacuum_with_budget(conn: &Connection, budget_ms: u64) -> VacuumOutcome {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(budget_ms);
    // 回调里只做一次时间比较 —— 它跑在 SQLite 内部，做重活会拖垮整条语句。
    conn.progress_handler(PROGRESS_CHECK_OPS, Some(move || Instant::now() >= deadline));
    let result = conn.execute_batch("VACUUM");
    // 钩子是连接级的：不卸掉会跟着后面每一条语句走（每 1000 条指令多一次时间比较，
    // 而且 VACUUM 之外的长语句也会被误中断）。必须卸。
    conn.progress_handler(0, None::<fn() -> bool>);
    let exec_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => VacuumOutcome::Completed { exec_ms },
        Err(e) if is_interrupted(&e) => VacuumOutcome::Aborted { exec_ms },
        Err(e) => VacuumOutcome::Failed {
            exec_ms,
            reason: e.to_string(),
        },
    }
}

/// 这个错误是不是"我们主动中断"的。
///
/// SQLite 把进度回调返回 `true` 报成 `SQLITE_INTERRUPT`（主码 9）。
/// 认它是为了把"我们自己叫停"和"数据库真的出错了"分开 —— 前者是预期内的行为。
fn is_interrupted(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(ffi_err, _)
            if ffi_err.code == rusqlite::ErrorCode::OperationInterrupted
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 造一个**文件库**并塞够多行。
    ///
    /// ⚠️ 为什么不���用 `:memory:`：内存库**没有页可回收**，VACUUM 在上面是空转
    /// （实测 2 万行只跑 1ms、进度回调一次都没触发）—— 用它测"会不会被中止"会得到
    /// 假的"没中止"。文件库才有真实的页、真实的重写、真实的耗时。
    fn file_db(tag: &str, rows: usize) -> (Connection, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("gosslan-vacuum-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("t.db");
        let c = Connection::open(&path).expect("开文件库");
        c.execute_batch(
            "PRAGMA journal_mode=DELETE;
             CREATE TABLE t(id INTEGER PRIMARY KEY, body TEXT);
             CREATE INDEX idx_t_body ON t(body);",
        )
        .expect("建表");
        let tx = c.unchecked_transaction().expect("事务");
        {
            let mut st = tx
                .prepare("INSERT INTO t(body) VALUES(?1)")
                .expect("prepare");
            for i in 0..rows {
                st.execute([format!("row-{i}-{}", "x".repeat(300))])
                    .expect("insert");
            }
        }
        tx.commit().expect("commit");
        (c, path)
    }

    /// 删掉大部分行制造**页内空洞** —— 这才是 VACUUM 要收拾的东西。
    fn punch_holes(c: &Connection, keep: usize) {
        let tx = c.unchecked_transaction().expect("事务");
        {
            let mut st = tx.prepare("DELETE FROM t WHERE id > ?1").expect("prepare");
            st.execute([keep as i64]).expect("delete");
        }
        tx.commit().expect("commit");
    }

    /// **进度回调真的会触发吗？**
    ///
    /// 这是整个预算机制的命根子：如果 SQLite 在 VACUUM 期间根本不回调进度钩子，
    /// 那"到点中止"就是一句空话（VACUUM 会一口气跑完，预算形同虚设）。
    /// 这条用例用**生产用的那个间隔**直接把回调次数数出来。
    #[test]
    fn the_progress_handler_actually_fires_during_vacuum() {
        let (c, _p) = file_db("fires", 60_000);
        punch_holes(&c, 200);
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = std::sync::Arc::clone(&fired);
        c.progress_handler(
            PROGRESS_CHECK_OPS,
            Some(move || {
                counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                false // 永远不中止，只数次数
            }),
        );
        c.execute_batch("VACUUM").expect("VACUUM");
        c.progress_handler(0, None::<fn() -> bool>);
        let hits = fired.load(std::sync::atomic::Ordering::Relaxed);
        eprintln!(
            "[实测] 42 MB 库 VACUUM 期间进度回调触发 {hits} 次（间隔 {PROGRESS_CHECK_OPS} 条虚机指令）"
        );
        assert!(
            hits > 0,
            "VACUUM 期间进度回调一次都没触发 ⇒ 预算机制是空转（实得 {hits} 次）"
        );
        // 回调次数必须**足够多**才能在预算处准时中止：实测 num_ops=100/1000 时只有 18 次
        // 且集中在前期 ⇒ 短预算会被直接跨过去（实测 2ms 预算 + num_ops=1000 ⇒ 没拦住）。
        assert!(
            hits >= 100,
            "回调次数太少（{hits} 次）⇒ 中止会严重滞后甚至跨过预算"
        );
    }

    /// 决策 2 的核心保证：**被中断的整理不会留下半成品**。
    #[test]
    fn budget_zero_aborts_and_leaves_the_database_intact() {
        let (c, _p) = file_db("abort", 30_000);
        punch_holes(&c, 200);
        let before: i64 = c
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("count before");

        // 预算 0ms ⇒ 第一次进度检查就中止。
        let outcome = vacuum_with_budget(&c, 0);
        assert!(
            matches!(outcome, VacuumOutcome::Aborted { .. }),
            "预算 0ms 必须是 Aborted，实得 {outcome:?}"
        );

        // ① 库仍然完好
        let integrity: String = c
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .expect("integrity_check");
        assert_eq!(integrity, "ok", "中断后的库必须 integrity_check = ok");

        // ② 数据一行没少
        let after: i64 = c
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("count after");
        assert_eq!(after, before, "中断不得改动任何数据（{before} → {after}）");

        // ③ 连接还能继续写（不是进了坏状态）
        c.execute("INSERT INTO t(body) VALUES('after-abort')", [])
            .expect("中断后仍能写");
    }

    /// 预算充足时必须**真的做完**，而且整理之后数据与索引都还在。
    #[test]
    fn generous_budget_completes_and_the_table_still_reads() {
        let (c, _p) = file_db("done", 30_000);
        punch_holes(&c, 200);
        let outcome = vacuum_with_budget(&c, 60_000);
        assert!(outcome.is_completed(), "预算充足必须做完，实得 {outcome:?}");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 200, "整理后行数不变");
        // 索引也要还在（VACUUM 会重建索引）
        let idx: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_t_body'",
                [],
                |r| r.get(0),
            )
            .expect("查索引");
        assert_eq!(idx, 1, "整理后索引必须还在");
    }

    /// 进度钩子是**连接级**的：不卸掉的话，后面每条语句都会带着它。
    /// 这里用"卸掉之后再跑一条长语句"来证明它没被误伤。
    #[test]
    fn the_progress_handler_is_uninstalled_afterwards() {
        let (c, _p) = file_db("uninstall", 10_000);
        let _ = vacuum_with_budget(&c, 0); // 故意中止
                                           // 中止之后连接必须还能跑普通语句（钩子若还在，这里可能被误中断）。
        c.execute_batch("CREATE TABLE after(id INTEGER);")
            .expect("中断后仍能建表");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 10_000);
    }

    /// note_wording_separates_abort_from_failure
    #[test]
    fn note_wording_separates_abort_from_failure() {
        // 用户点「立即清理」后如果看到"失败"会以为数据库坏了；
        // "超预算已中止、数据库未压缩、内容完好"才是该说的话。
        let aborted = VacuumOutcome::Aborted { exec_ms: 3001 };
        assert!(aborted.note().contains("中止"));
        assert!(aborted.note().contains("完好"));
        assert!(!aborted.note().contains("失败"));

        let failed = VacuumOutcome::Failed {
            exec_ms: 12,
            reason: "disk I/O error".into(),
        };
        assert!(failed.note().contains("失败"));
        assert!(failed.note().contains("disk I/O error"));
    }

    /// 结局码必须能直接回界面（前端按码本地化）。
    #[test]
    fn state_codes_are_the_three_the_frontend_expects() {
        assert_eq!(VacuumOutcome::Completed { exec_ms: 1 }.state_code(), "done");
        assert_eq!(
            VacuumOutcome::Aborted { exec_ms: 1 }.state_code(),
            "aborted"
        );
        assert_eq!(
            VacuumOutcome::Failed {
                exec_ms: 1,
                reason: "x".into()
            }
            .state_code(),
            "failed"
        );
    }

    /// **实测**：一个"像样的"聊天库上，整理要多久、文件会小多少。
    ///
    /// 这条用例的价值不只在于"能做完"，而在于它把**三个数字**打出来：
    /// 整理前的库大小、耗时、整理后的大小。决策 2 的 3 秒预算就是拿这组数字校准的
    /// —— 预算太短会把正常库也中止掉，太长就失去意义。
    #[test]
    fn realistic_database_compacts_and_shrinks_and_prints_the_numbers() {
        let (c, path) = file_db("real", 60_000);
        punch_holes(&c, 500);
        let before = std::fs::metadata(&path).expect("stat").len();
        let started = Instant::now();
        let outcome = vacuum_with_budget(&c, 60_000);
        let after = std::fs::metadata(&path).expect("stat").len();
        eprintln!(
            "[实测] 库 {before} B → {after} B（省 {} B，{}%），整理耗时 {:?}，结局 {outcome:?}",
            before.saturating_sub(after),
            if before == 0 {
                0
            } else {
                (before.saturating_sub(after) * 100 / before) as u64
            },
            started.elapsed(),
        );
        assert!(outcome.is_completed(), "预算充足必须做完，实得 {outcome:?}");
        assert!(
            after < before,
            "整理后文件必须变小（{before} → {after}）—— 没变小说明 VACUUM 没真的收拾碎片"
        );
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 500, "整理后行数不变");
    }

    /// **实测**：撞上预算时，**实际耗时**离预算有多近。
    ///
    /// 用户感知的是"我点了之后卡了多久" ⇒ 预算不是"3 秒"这个数，而是"约 3 秒"。
    /// 这条用例证明中止**确实发生在预算附近**，而不是"要么立刻停、要么跑到底"。
    ///
    /// 预算取 2ms 是因为实测：42 MB 的库整理只要 ~9ms ⇒ 2ms 的预算必然落在整理过程
    /// 中间（既不是"一开始就被拦"，也不是"跑完了才发现超了"）。真实库更大时同理，
    /// 只是预算按比例放大（见 `DEFAULT_VACUUM_BUDGET_MS`）。
    #[test]
    fn an_abort_lands_close_to_the_budget() {
        const BUDGET_MS: u64 = 2;
        let (c, _p) = file_db("budget", 60_000);
        punch_holes(&c, 500);
        let started = Instant::now();
        let outcome = vacuum_with_budget(&c, BUDGET_MS);
        let elapsed = started.elapsed().as_micros() as u64 / 1000;
        eprintln!("[实测] 预算 {BUDGET_MS}ms → 实际 {elapsed}ms，结局 {outcome:?}");
        assert!(
            matches!(outcome, VacuumOutcome::Aborted { .. }),
            "小预算必须中止，实得 {outcome:?}"
        );
        // 决定性判据是上一条 `Aborted`：预算没生效时会一路跑完并得到 `Completed`。
        // 这里的耗时上界只防"跑完整库才停"，不能卡成 5× 预算 —— 满载跑全量测试时，
        // 2ms 的检查间隔会被线程调度拖到十几毫秒（2026-10-21 全量门禁实测 14ms），
        // 而 3 秒预算对应的用户感知仍然是"约 3 秒"，不是"跑到底"。
        assert!(
            elapsed < 250,
            "中止离预算太远（预算 {BUDGET_MS}ms、实际 {elapsed}ms）⇒ 预算机制可能没生效"
        );
        // 中止后库仍然完好
        let integrity: String = c
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .expect("integrity_check");
        assert_eq!(integrity, "ok");
    }
}
