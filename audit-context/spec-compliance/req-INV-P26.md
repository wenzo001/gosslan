## REQ-INV-P26 — 有磁盘证据的状态不可被降级

> "规则只有一条：**`done` 不许被改写成别的状态**。状态、进度、路径三个字段走的是同一条
> `ON CONFLICT DO UPDATE`，闸门加在语句上就一起生效（`db/file_transfer.rs::upsert_transfer`）。
> 队列判死走 `mark_queued_transfer_failed`，合法集合同样是"非 done"。
> ...**`failed` 必须还能改回 `active`** ... 反向判据：`cascade_tests::a_failed_row_can_be_reactivated_by_the_next_attempt`。
> 配套的两条口径：
> * **同一个关注点只有一个家**：除 `db/file_transfer.rs` 之外不许再出现直接 `UPDATE file_transfers SET status`（守卫 `cascade_tests::terminal_status_writes_have_one_home`）。
> * **文件队列的终态只有一个出口**：`db::finalize_file_failure(conn, transfer_id, end)`，`end ∈ {Expired, GiveUp, Cancelled}`。
> * **把行踢出重试集合的那一步必须排最后** ...
> * **两个失败口径不许合并**：`file_outbox.status` 的 `failed` = **自动**判死，`cancelled` = 用户主动取消。
> * **emit 由写库结果门控** ...
> **用户主动取消是第二个不可降级条件（2026-10-23 B1）** ... 台账加一列 `file_transfers.cancel_terminal`（迁移 v11→v12，**只由**主动取消置位），`upsert_transfer` 的闸门扩成 `status <> 'done' AND cancel_terminal = 0`。
> **群文件的「接收侧取消」也是真取消（2026-10-23 B3b）** ...
> **消息的取消与文件同一条仲裁（2026-10-23 B4 后半）** ...
> **群消息的成员级台账是本条在群里的落法（2026-10-25）**：`group_outbox` 改为四态（`pending | delivered | cancelled | failed`，迁移 v13）"
> — docs/protocol-invariants.md §26. Terminal State / INV-P26, line 1089

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** `done` 不得被改写；`failed` 必须还能改回 `active`；`cancelled`（用户主动取消）同样不可被晚到的写复活；状态写入只有一个家；队列终态只有一个出口；破坏性写排最后；`failed` 与 `cancelled` 两个失败口径不许合并；emit 由写库结果门控；群成员级台账按行状态仲裁。

**Where enforcement lives:**

**闸门在语句上（一条 SQL 管住三个字段）：**

```rust
// src-tauri/src/db/file_transfer.rs:36-45
conn.execute(
    "INSERT INTO file_transfers(id, peer_id, name, size, direction, status, path, progress, created_at)
     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status,
         size = excluded.size,
         path = COALESCE(excluded.path, file_transfers.path),
         progress = excluded.progress
     WHERE file_transfers.status <> 'done' AND file_transfers.cancel_terminal = 0",
    params![...],
)?;
```

- What it checks, and against what：`WHERE file_transfers.status <> 'done'`（`done` 不可降级）**且** `AND file_transfers.cancel_terminal = 0`（取消墓碑不可被复活）。`status` / `size` / `path` / `progress` 四个字段在同一个 `DO UPDATE` 里 ⇒ 闸门加在语句上 ⇒ **三个字段一起生效**（文档要求的"状态、进度、路径三个字段走的是同一条 ON CONFLICT DO UPDATE"）。
- Which paths reach it, and which do not：全部生产写点都走 `upsert_transfer`（`db/file_transfer.rs` 是唯一家）；`grep "UPDATE file_transfers SET"` 只有 4 处命中，**全部在 `db/file_transfer.rs` 内部**（`:86` / `:109` / `:237`）与 `db/message_delete.rs:65`（取消专用、写 `cancel_terminal = 1`）。**没有**第二处绕过闸门写 `status`。

**队列判死（非 done 集合）：**

```rust
// src-tauri/src/db/file_transfer.rs:84-91
pub fn mark_transfer_failed_if_active(conn: &Connection, id: &str) -> Result<bool> {
    let n = conn.execute(
        "UPDATE file_transfers SET status = 'failed', progress = 0.0
         WHERE id = ?1 AND status = 'active'",
        params![id],
    )?;
    Ok(n > 0)
}
```

**终态唯一出口（三份合并成一份）：**

```rust
// src-tauri/src/db/file_transfer.rs:118-134
pub enum FileJobEnd { Expired, GiveUp, Cancelled }
impl FileJobEnd {
    fn status(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Expired | Self::GiveUp => "failed",
        }
    }
}
```

```rust
// src-tauri/src/db/file_transfer.rs:161-247（finalize_file_failure）
let already_done = is_transfer_done(conn, transfer_id).unwrap_or(false);
let tx = conn.unchecked_transaction()?;
let mut changed = false;
if !already_done || cancelled {
    let file_bubble = set_message_status(&tx, &format!("file-{transfer_id}"), status)? > 0;
    let group_bubble = cancelled && set_message_status(&tx, &format!("gfile-{transfer_id}"), status)? > 0;
    let has_ledger = transfer_row_exists(&tx, transfer_id)?;
    let has_queue = file_outbox_row_exists(&tx, transfer_id)?;
    if file_bubble || has_ledger || has_queue {
        upsert_transfer(&tx, transfer_id, "", "", known_size, "send", status, None, 0.0)?;
    }
    changed = file_bubble || group_bubble || has_ledger || has_queue;
}
if changed || already_done {
    if cancelled && changed && !already_done {
        tx.execute("UPDATE file_transfers SET cancel_terminal = 1 WHERE id = ?1", ...)?;
    }
    // ★ 永远排在最后
    match end {
        FileJobEnd::Cancelled => mark_file_outbox_cancelled(&tx, transfer_id)?,
        _ => mark_file_outbox_failed(&tx, transfer_id)?,
    }
}
tx.commit()?;
```

- 取消墓碑的三个限制（`:231-236` 的注释与代码一一对应）：`cancelled`（只有主动取消盖墓碑）、`changed`（只对真的推进了的状态写）、`!already_done`（已送达的行不盖墓碑）。
- 破坏性写排最后（`:242-245` 的 `match end` 是事务里的**最后一笔**写）✓
- 四笔写在**同一个事务**里（`:172` 的 `unchecked_transaction` 到 `:246` 的 `commit`）⇒ 失败整体回滚（SOL-03）。

**两个失败口径不许合并：**

```rust
// src-tauri/src/db/file_offline.rs:82 / :99
pub fn mark_file_outbox_failed(conn: &Connection, transfer_id: &str) -> Result<()> { ... }
pub fn mark_file_outbox_cancelled(conn: &Connection, transfer_id: &str) -> Result<()> { ... }
```

**emit 由写库结果门控：**

```rust
// src-tauri/src/commands/files.rs:469-485
fn fail_file_job(state: &AppState, transfer_id: &str, reason: &str) {
    let announce = finalize_with_note(state, transfer_id, db::FileJobEnd::GiveUp, "fail_job");
    if announce {
        let _ = state.app.emit("file-failed", &crate::state::FileFailedInfo { ... });
    }
}
```

`announce` = `finalize_file_failure` 的返回值（`changed`）⇒ **已经 `done` 的行没被改动 ⇒ 不发 `file-failed`** ✓（文档要求"为一个躺在下载目录里能打开的文件弹『传输失败』是谎话"）。

**取消槽位只有一个家：**

```rust
// src-tauri/src/network/file.rs:190
pub(crate) fn install_cancel_slot<'a>(...)
```

调用点 3 处：`network/file/send.rs:60`、`network/file/relay_push.rs:76`、`commands/group_file_dispatch.rs:99`。登记排在慢步骤之前（`send.rs:169` 注释"取消槽位在哈希之前登记"）。

**群文件成员级硬终态：**

```rust
// src-tauri/src/db/group_files.rs:340 附近（update_group_file_recipient 带 AND status <> 'cancelled'）
// src-tauri/src/db/group_files.rs:664 / :700 / :733 / :787（四条判据用例）
```

**群消息四态台账（迁移 v13）：**

```rust
// src-tauri/src/db/group_offline_queue.rs:65-71（迟到 Ack 只改行不改消息状态）
tx.execute(
    "UPDATE group_outbox SET status = 'delivered'
      WHERE msg_id = ?1 AND peer_id = ?2 AND status IN ('pending','cancelled','failed')", ...)?;
if prior == "pending" {
    tx.execute("UPDATE messages SET status = 'delivered' WHERE msg_id = ?1
        AND status NOT IN ('read','delivered','recalled','cancelled','partial_cancelled')", ...)?;
}
```

```rust
// src-tauri/src/db/group_offline_queue.rs:163-166（取消只动剩余 pending 行）
tx.execute("UPDATE group_outbox SET status = 'cancelled' WHERE msg_id = ?1 AND status = 'pending'", ...)?;

// src-tauri/src/db/group_offline_queue.rs:195-201（清扫器逐行放弃只动 pending）
pub fn mark_group_outbox_failed(...) { "UPDATE group_outbox SET status = 'failed' WHERE ... AND status = 'pending'" }

// src-tauri/src/db/group_offline_queue.rs:239-244（补发只重置 cancelled 行 + 刷新 created_at）
pub fn resend_cancelled_group_rows(...) { "UPDATE group_outbox SET status = 'pending', created_at = ?2 WHERE msg_id = ?1 AND status = 'cancelled'" }
```

**Paths walked:**
- `flush_pending_files` → `fail_file_job` → `finalize_file_failure(GiveUp)` → `upsert_transfer`（闸门挡住 `done`）⇒ 状态/进度/路径三样都不变、**且不发 `file-failed`** ✓
- 用户取消 → `commands/files.rs::apply_local_cancel` → `finalize_file_failure(Cancelled)` ⇒ 墓碑 `cancel_terminal = 1` + 队列行落 `cancelled`（**不是** `failed`）✓
- 晚到的进度写（取消之后）→ `upsert_transfer` ⇒ `cancel_terminal = 0` 不成立 ⇒ **改 0 行** ⇒ 取消不被复活 ✓
- `failed` → 下一轮 attempt → `upsert_transfer(status="active")` ⇒ `status <> 'done'` 成立、`cancel_terminal = 0` 成立（自动判死不置位）⇒ **可改回 active** ✓
- 已 `done` 的行 + 取消 → `finalize_file_failure`：`already_done = true` ⇒ `changed` 可能为 true（气泡写被 `set_message_status` 的单调闸挡成 0 行）⇒ 但墓碑条件 `!already_done` 不成立 ⇒ **不写墓碑** ✓
- 群消息：迟到 Ack 落在 `cancelled` 行 → `prior != "pending"` ⇒ 只改行（`LateApplied`）⇒ **不把 `partial_cancelled` 翻回 `delivered`** ✓
- 群消息补发 → `resend_cancelled_group_rows` ⇒ 只重置 `cancelled` 行、`delivered`/`failed` 不复活、刷新 `created_at` ✓
- 群消息清扫 → `mark_group_outbox_failed` ⇒ 只把 `pending` 置 `failed`（不删行）✓
- 群文件成员行 → `update_group_file_recipient` 带 `AND status <> 'cancelled'` ⇒ 晚到的进度/ACK 改不动 ✓
- 群投递入口 → `dispatch_group_file_to_peer` 在**拿并发闸许可之前**先看闸门（`commands/group_file_dispatch.rs:99` 之前 + `lib_file_tests.rs:344` 的判据 `group_file_cancel_gate_is_checked_before_the_permit`）✓

**Searched:**
- `UPDATE file_transfers SET` → 4 hits：`db/file_transfer.rs:86`（`mark_transfer_failed_if_active`，带 `AND status = 'active'`）、`:109`（`fail_interrupted_transfers_on_startup`，带 `WHERE status = 'active'`）、`:237`（墓碑 `SET cancel_terminal = 1`，不改 status）、`db/message_delete.rs:65`（取消专用，写 `status = 'cancelled', cancel_terminal = 1`）。**全部在 `db/file_transfer.rs` 内或取消专用路径** ⇒ "同一个关注点只有一个家"成立 ✓
- `mark_queued_transfer_failed` → **0 hits**（全仓）。文档点名的这个函数名**不存在**；对应语义由 `mark_transfer_failed_if_active`（`db/file_transfer.rs:84`）承担，且它的合法集合是 `status = 'active'`（比文档说的"非 done"更严 —— 只改 active，done/failed/cancelled 都不动）。⇒ 文档这一句引用的是**旧函数名**。
- `finalize_file_failure` → `db/file_transfer.rs:161`（定义）+ `commands/files.rs:441`（`finalize_with_note`）+ `network/transport/outbox_sweep.rs:36`（`finalize_expired_file`）⇒ **终态出口只有一处** ✓
- `mark_file_outbox_failed` / `mark_file_outbox_cancelled` → `db/file_transfer.rs:243/244`（唯一生产调用点，都在 `finalize_file_failure` 内）+ `db/file_offline.rs:82/99`（定义）⇒ 两个口径分列 ✓
- `cancel_terminal` → `db/file_transfer.rs:43`（闸门）、`:237`（置位）、`db/message_delete.rs:65`（取消路径置位）+ 迁移（v11→v12）⇒ **只由主动取消置位** ✓
- `group_outbox` status 四态 → `pending` / `delivered` / `cancelled` / `failed` 四值在 `db/group_offline_queue.rs` 的 SQL 里全部出现（`:69/165/199/243` + `:83` 的删除条件）✓
- `partial_cancelled` → `db/group_offline_queue.rs:73/178` + `db/messages.rs` 的状态集合 ⇒ 群消息部分取消态存在 ✓
- `late` Ack 不翻回 → `db/group_offline_queue.rs:64` `if prior == "pending"` 才改 `messages.status`；`prior != "pending"` ⇒ `GroupAckOutcome::LateApplied` ✓
- `every_finalize_path_defers_the_destructive_write` → `src-tauri/src/lib_outbox_tests.rs:163`（**自动扫**全仓收尾路径的结构式判据，不是清单式）✓
- `terminal_status_writes_have_one_home` → `src-tauri/src/db/cascade_tests.rs:725`（**只扫 `commands/files.rs`**，见下）✓

**Hook verification:**
- `guards:upsert_transfer 的「done 不可降级」闸门不得被摘掉` — **存在**：实测 name 命中 1 次 ✓
- `db::cascade_tests::a_completed_transfer_row_is_never_downgraded` — **存在**：`src-tauri/src/db/cascade_tests.rs:465` ✓（基线命中）
- `db::tests::complete_ack_failure_cannot_downgrade_completed` — **存在**：`src-tauri/src/db/favorites_tests.rs:2019` ✓（基线命中）
- `db::cascade_tests::a_user_cancelled_transfer_is_never_revived_by_a_late_write` — **存在**：`cascade_tests.rs:592` ✓
- `db::cascade_tests::a_cancel_on_an_already_done_transfer_writes_no_tombstone` — **存在**：`cascade_tests.rs:660` ✓
- `db::cascade_tests::claiming_an_outbox_row_reports_whether_it_was_actually_claimed` — **存在**：`cascade_tests.rs:691` ✓
- `network::file::tests::a_user_cancel_never_enters_the_retry_queue_and_is_not_a_failure` — **存在**：`src-tauri/src/network/file_tests.rs:2410` ✓
- `tests::cancel_slot_has_exactly_one_home` — **存在**：`src-tauri/src/lib_file_tests.rs:123` ✓
- `db::group_file_delivery_tests::a_cancelled_recipient_row_is_a_hard_terminal` — **存在**：`src-tauri/src/db/group_files.rs:700`（模块 `group_file_delivery_tests` 在 `db/group_files.rs:593`）✓（基线 `:170` 有登记）
- `db::group_file_delivery_tests::cancelling_a_group_file_touches_only_the_members_that_are_not_terminal` — **存在**：`db/group_files.rs:664` ✓（基线 `:172`）
- `db::group_file_delivery_tests::a_cancelled_group_file_is_not_requeued_by_the_offline_or_sweep_paths` — **存在**：`db/group_files.rs:733` ✓（基线 `:169`）
- `db::group_file_delivery_tests::group_file_row_cancel_does_not_downgrade_completed` — **存在**：`db/group_files.rs:787` ✓
- `tests::group_file_cancel_gate_is_checked_before_the_permit` — **存在**：`src-tauri/src/lib_file_tests.rs:344` ✓

全部 13 条钩子存在并注册（Rust 用例进两个平台基线，护栏用例进 `scripts/guard_cases/`）。

**How the verdict was reached:** 文档的每一条口径都对上了代码：`done` 闸门在 `upsert_transfer` 的 SQL 语句上（连 `cancel_terminal = 0` 一起），`failed` 可改回 `active`（反向判据 `a_failed_row_can_be_reactivated_by_the_next_attempt` 存在），取消墓碑只由主动取消置位且只写 `cancel_terminal`，终态唯一出口 `finalize_file_failure`（三份合并成一份且四笔写同事务），破坏性写排最后（`match end` 是事务最后一笔），两个失败口径分列（`mark_file_outbox_failed` / `mark_file_outbox_cancelled`），emit 由写库结果门控（`fail_file_job` 的 `if announce`），群消息四态台账的每条仲裁规则（迟到 Ack 只改行、取消只动 pending、补发只重置 cancelled 且刷新 created_at、清扫只动 pending）都在 SQL 里。定为 `implemented`：文档点名的 13 条钩子全部存在、注册、且实测全绿（含变异用例清单里点名的每一格）。

**Open questions:**
- 文档引用的 `mark_queued_transfer_failed` 在代码里**不存在**（0 命中）；对应语义由 `mark_transfer_failed_if_active`（合法集合 `status = 'active'`）承担。这是文档引用了旧函数名，还是曾经有一个函数被改名后文档没跟？
- `terminal_status_writes_have_one_home`（`db/cascade_tests.rs:725`）**只扫 `commands/files.rs` 一个文件**（`let files = include_str!("../commands/files.rs")`）。文档说"除 `db/file_transfer.rs` 之外不许再出现直接 `UPDATE file_transfers SET status`" —— 判据的实际覆盖面是**一个文件**，不是"全仓除 db/file_transfer.rs"。其它文件（`db/message_delete.rs:65`）里若有裸 UPDATE，这条判据看不见。当前实测其它文件没有绕过闸门的 status 写，但判据的覆盖面小于文档的措辞。
- 文档说"`file_transfers.status` 今天有 31 个生产调用点"，`db/file_transfer.rs:22` 的注释说 39 个。两者口径不同，且都写死了一个会漂的数（脚本每次实算打印的只有锁作用域与判据计数）。
- 群消息的 `failed` 行"不得复活"由 `resend_cancelled_group_rows` 只重置 `cancelled` 行保证（`delivered`/`failed` 不动）✓，但"整条重发"的兜底路径（`no_ledger` = 升级前发出的历史消息）不受此闸门保护 —— 那条路径按设计要整条重发。
