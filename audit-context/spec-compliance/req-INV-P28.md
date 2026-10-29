## REQ-INV-P28 — 摘表与判据必须同一次持锁，收尾只吃已摘出来的那一件

> "凡是"按某个条件把东西从**内存表**里摘出来、再对它做收尾（写库 / emit / 改名 / 记台账）"的地方，
> **判据与 `remove` 必须在同一次持锁里完成**；收尾一律在锁外，且只使用已经摘出来的那一份。
> 规则：
> * **一个家**：摘取动作只许住在 `take_*` 这一族里 —— `take_stalled_receive` /
>   `take_stalled_group_receive` / `take_receives_for_peer` / `take_group_receives_for_peer`。
> * **收尾函数成对存在**：每个 `take_*` 配一个 `fail_taken_*`，签名里带**已摘出来的那份**（`&FileReceiver`）。
> * ⚠️ 但"成对存在"不等于"被调用"：`take_*` 返回的那一份**必须在调用点被用完**。下划线前缀的绑定
>   （`for (x, _y)`）在 Rust 里是"我故意不用"，编译器与 clippy 都不响 ⇒ 本条的第四次就是这么犯下的。
>   ⇒ 判据要钉**带实参的调用形状**（`fail_taken_group_receive(&state, &r)`），钉函数名存在性会被注释喂饱。"
> — docs/protocol-invariants.md §28. INV-P28, line 1297

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 凡是从内存表按条件摘取条目再收尾的地方，判据与 `remove` 必须在同一次持锁里完成；收尾在锁外；收尾只吃已经摘出来的那一份（签名带 `&FileReceiver`）；摘取动作只住在 `take_*` 一族。

**Where enforcement lives:**

**单聊侧：**

```rust
// src-tauri/src/network/file/receive.rs:1170-1180
pub fn take_stalled_receive(state: &AppState, now: i64) -> Option<(String, FileReceiver)> {
    let mut recv = state.file_receivers.lock().unwrap_or_else(|e| e.into_inner());
    let key = recv.iter().find(|(_, r)| receive_is_stale(now - r.fed_at_ms)).map(|(k, _)| k.clone())?;
    recv.remove(&key).map(|r| (key, r))
}

// src-tauri/src/network/file/receive.rs:1184
pub fn fail_taken_receive(state: &AppState, transfer_id: &str, r: &FileReceiver, reason: &str)

// src-tauri/src/network/file/receive.rs:1245-1258
pub fn take_receives_for_peer(state: &AppState, peer_id: &str) -> Vec<(String, FileReceiver)> {
    let mut recv = state.file_receivers.lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<String> = recv.iter().filter(|(_, r)| r.peer_id == peer_id).map(|(k, _)| k.clone()).collect();
    ids.into_iter().filter_map(|k| recv.remove(&k).map(|r| (k, r))).collect()
}

// src-tauri/src/network/file/receive.rs:1260-1265
pub fn fail_receives_for_peer(state: &AppState, peer_id: &str) {
    for (id, r) in take_receives_for_peer(state, peer_id) {
        fail_taken_receive(state, &id, &r, "对端连接已断开");
    }
}
```

**群侧：**

```rust
// src-tauri/src/network/file/group_receive.rs:167-183
pub fn take_group_receives_for_peer(state: &AppState, peer_id: &str) -> Vec<(String, FileReceiver)> {
    let mut recv = state.group_file_receivers.lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<String> = recv.iter().filter(|(_, r)| r.peer_id == peer_id).map(|(k, _)| k.clone()).collect();
    ids.into_iter().filter_map(|k| recv.remove(&k).map(|r| (k, r))).collect()
}

// src-tauri/src/network/file/group_receive.rs:186-194
pub fn take_stalled_group_receive(state: &AppState, now: i64) -> Option<(String, FileReceiver)>

// src-tauri/src/network/file/group_receive.rs:266
pub fn fail_taken_group_receive(state: &AppState, r: &FileReceiver)
```

- What it checks, and against what：四个 `take_*` 全部在**同一把表锁的同一个作用域内**完成"找"与"remove" ⇒ 判据与摘取之间不可能挤进新条目。四个 `fail_taken_*` 的签名都带 `&FileReceiver`（已摘出来的那份）⇒ "拿 id 回头再查表"在类型上就走不通。
- Which paths reach it, and which do not：四个 `take_*` 的生产调用点各只有一处（见下）。

**调用点（摘出来的那份被用完）：**

```rust
// src-tauri/src/network/transport/queue_policy.rs:327-340（对端下线）
file::fail_receives_for_peer(&state, &peer_id);
let taken = file::take_group_receives_for_peer(&state, &peer_id);
for (tid, r) in taken {
    file::fail_taken_group_receive(&state, &r);                       // ← 摘出来的那份被吃掉
    finalize_failed_group_receive(&state, &tid, REASON_PEER_UNLINKED);
}
```

```rust
// src-tauri/src/network/transport/group_file.rs:911-919（停滞回收）
while let Some((id, r)) = file::take_stalled_receive(state, now) {
    file::fail_taken_receive(state, &id, &r, REASON);
    reclaimed += 1;
}
while let Some((id, r)) = file::take_stalled_group_receive(state, now) {
    file::fail_taken_group_receive(state, &r);
    fail_group_file_chunk(state, &id, REASON_STALLED_GROUP_RECEIVE);
    reclaimed += 1;
}
```

**收尾在锁外：**

```rust
// src-tauri/src/network/file/receive.rs:1187-1234（fail_taken_receive）
let fail_notes = {
    let dbc = state.db.lock()...;      // db 锁只在块内
    ... upsert_transfer ... record_failure ...
    notes
};                                     // 块尾 ⇒ 锁结束
for note in fail_notes { state.logger.error("file", note); }
emit_failed(state, transfer_id, reason);   // ← emit 在锁外 ✓
```

```rust
// src-tauri/src/network/file/group_receive.rs:266-280（fail_taken_group_receive）
pub fn fail_taken_group_receive(state: &AppState, r: &FileReceiver) {
    let _ = &r.tmp_path;
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = crate::content::store::record_failure(&dbc, &r.expected_sha256, &r.peer_id, ...);
}
```

**Paths walked:**
- `handle_peer_unlinked` → `file::fail_receives_for_peer` → `take_receives_for_peer`（锁内摘）→ 锁外 `fail_taken_receive(&id, &r, ...)`（用摘出来的那份）✓
- `handle_peer_unlinked` → `file::take_group_receives_for_peer`（锁内摘）→ 锁外 `file::fail_taken_group_receive(&state, &r)`（用摘出来的那份）✓
- `sweep_stalled_receives` → `take_stalled_receive` → 锁外 `fail_taken_receive` ✓
- `sweep_stalled_receives` → `take_stalled_group_receive` → 锁外 `fail_taken_group_receive(&r)` ✓（随后 `fail_group_file_chunk` 里的 `file::fail_group_receive` 会因为已摘而跳过 —— 注释 `:917-919` 明写"正好复用同一份收尾，不另写一份"）
- `file::fail_receive`（`receive.rs:1086-1101`）：**自己**做"锁内 remove + 核对 peer_id（不符则插回）+ 锁外 `fail_taken_receive`" ⇒ 判据与摘取同一次持锁 ✓（这是单条取消/失败的路径，不走 `take_*` 族）
- `file::fail_group_receive`（`group_receive.rs:150-159`）：同样"锁内 remove + 锁外 `fail_taken_group_receive`" ✓

**⚠️ 一处需要看清的形状（不是缺口，但值得记）：**

```rust
// src-tauri/src/network/transport/group_file.rs:843-846
fn fail_group_file_chunk(state: &Arc<AppState>, transfer_id: &str, reason: &str) {
    file::fail_group_receive(state, transfer_id);
    finalize_failed_group_receive(state, transfer_id, reason);
}
```

`fail_group_file_chunk` 是**按 transfer_id** 收尾的（不是按已摘出来的那份）。它有两个调用点：
1. `sweep_stalled_receives`（`:917`）—— 在那之前已经 `take_stalled_group_receive` + `fail_taken_group_receive(&r)` 过了；此处的 `fail_group_receive` 因为已摘而**跳过**（`remove` 返回 `None`）⇒ 内容台账只写一次 ✓
2. 其它路径（群分片失败）：`fail_group_receive` 自己锁内摘 + 锁外收尾 ⇒ 仍是原子摘取 ✓

所以"按 id 收尾"这个形状**没有**绕过 `take_*` 族 —— 它要么已被前面的 `take_*` 摘过（因而 no-op），要么自己走 `fail_group_receive` 的原子摘。文档第 ③ 条判据正是钉这个（"不许出现 `fail_group_file_chunk(&state, &tid)`"）—— 但注意：那条断言只针对**对端下线那段窗口**（`peer_offline_group_cleanup_takes_before_finalizing` 的窗口取"到下一个函数头为止"），**不**覆盖 `sweep_stalled_receives` 那一路（那里确实有 `fail_group_file_chunk(state, &id, ...)`）。

**Searched:**
- `take_stalled_receive` → 定义 `receive.rs:1170`；生产调用 `group_file.rs:911`（一处）✓
- `take_stalled_group_receive` → 定义 `group_receive.rs:186`；生产调用 `group_file.rs:915`（一处）✓
- `take_receives_for_peer` → 定义 `receive.rs:1245`；生产调用 `receive.rs:1262`（`fail_receives_for_peer` 内）✓
- `take_group_receives_for_peer` → 定义 `group_receive.rs:167`；生产调用 `queue_policy.rs:332`（一处）✓
- `fail_taken_receive` → 定义 `receive.rs:1184`；生产调用 `receive.rs:1099`（`fail_receive` 内）与 `receive.rs:1263`（`fail_receives_for_peer` 内）与 `group_file.rs:912` ✓
- `fail_taken_group_receive` → 定义 `group_receive.rs:266`；生产调用 `group_receive.rs:157`（`fail_group_receive` 内）、`group_receive.rs` 的 `take_*` 路径、`queue_policy.rs:338`、`group_file.rs:916` ✓
- `fail_receives_for_peer` → 定义 `receive.rs:1260`；生产调用 `queue_policy.rs:329` ✓
- `(tid, _r) in taken` / `_r` 下划线绑定 → **0 hits**（全仓）⇒ 文档点名的第四次犯案形状没有复现 ✓
- `let group_ids: Vec<String>`（快照 id 旧写法）→ **0 hits** ✓
- 其它"锁内 collect 出 id、锁外逐个收尾"的形状 → `grep "collect()" src-tauri/src/network/`：`receive.rs` 与 `group_receive.rs` 里的 `collect()` 都是**在锁内直接 remove 后**收集结果（`ids.into_iter().filter_map(|k| recv.remove(&k)...)`），不是"先快照 id 再锁外收尾" ✓

**Hook verification:**
- `network::file::group_receive_atomicity_tests::peer_offline_group_cleanup_takes_before_finalizing` — **存在**：`src-tauri/src/network/file_tests.rs:3370` ✓（基线命中）
  - 它的断言逐条对应文档的三条判据：`body.contains("take_group_receives_for_peer(")`（走原子摘取）、`body.contains("fail_taken_group_receive(&state, &r)")`（摘出来的那份被用完）、`!body.contains("(tid, _r) in taken")`（不許丢）、`!body.contains("let group_ids: Vec<String>")`（不许退回快照）、`!body.contains("fail_group_file_chunk(&state, &tid)")`（不许按 id 逐个走完整函数）
  - 还有一条**反空转闸**（`:3398-3402`）：窗口必须真的盖到 `finalize_failed_group_receive` 那一行，否则"盖不到就直接炸"
- `network::file::group_receive_atomicity_tests::single_peer_offline_cleanup_also_takes_before_finalizing` — **存在**：`file_tests.rs:3422` ✓（基线命中）
  - 断言 `body.contains("take_receives_for_peer(")` 且 `!body.contains("fail_receive(state,")` ⇒ 单聊侧不许退回"逐个调完整函数"
- `network::file::group_receive_atomicity_tests::completed_guard_reads_recipient_status_in_the_handler` — **存在**：`file_tests.rs:3455` ✓（基线命中）

三条全部存在并注册到本平台基线。

**How the verdict was reached:** 四个 `take_*` 的实现都是"锁内 find + 锁内 remove"（同一作用域），四个 `fail_taken_*` 的签名都带 `&FileReceiver`，两个生产调用点都把摘出来的那份**真的用完**（`fail_taken_group_receive(&state, &r)` / `fail_taken_receive(state, &id, &r, ...)`），收尾一律在锁外（db 锁用 `{ }` 圈住，emit 在块外）。文档点名的第四次犯案形状（`for (tid, _r) in taken`）与快照 id 旧写法全仓 0 命中。三条形状判据存在且都带反空转闸。定为 `implemented`：文档的"一个家 / 成对存在 / 被调用"三条规则逐条对上，且"成对存在 ≠ 被调用"这个文档特别强调的漏洞由 `fail_taken_group_receive(&state, &r)` 的**带实参调用形状**断言堵住。

**Open questions:**
- `sweep_stalled_receives`（`group_file.rs:917`）那一路调用了 `fail_group_file_chunk(state, &id, ...)`（按 id 收尾），而文档判据 ③ 的断言 `!body.contains("fail_group_file_chunk(&state, &tid)")` 只覆盖"对端下线"那个窗口。该路在 `take_stalled_group_receive` 之后已经写过 `fail_taken_group_receive(&r)`，`fail_group_receive` 会 no-op ⇒ 语义上无缺口，但**形状上**确实是"按 id 收尾"的一个调用点，而判据看不见它。
- `file::fail_receive`（`receive.rs:1086`）与 `file::fail_group_receive`（`group_receive.rs:150`）**不在** `take_*` 族里（它们自己锁内 remove + 锁外收尾）。文档说"摘取动作只许住在 `take_*` 这一族里 —— 新增同类逻辑要么调它们，要么照它们的形状另写一条判据" ⇒ 这两个函数属于"照形状另写"，且有 `fail_taken_*` 成对。判据（`single_peer_offline_cleanup_also_takes_before_finalizing`）只断言 `fail_receives_for_peer` 那一路，不覆盖 `fail_receive` 本体。
- 判据是**读源码文本**的形状判据（文档自陈："这段吃 `AppState`，本仓没有能驱动它的行为夹具，硬凑 mock 只会得到假绿"）。因此它能证明"代码形状是那样"，不能证明"运行时真的没有那个竞态"。
