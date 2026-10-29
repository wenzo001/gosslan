## REQ-INV-P25 — 发射事件不得持有 db 锁

> "**规则**：`AppState.db` 那把 `Mutex<Connection>` 的**存活期内不许出现任何 `emit`，也不许调用"自己还会取这把锁"的函数**。
> 写库要用 `{ … }` 圈住（或 `drop(dbc);`），事件放到圈外再发；要调自锁 helper 就先结束守卫，
> 需要继续写库再重新 `let dbc = …`（先例：`network/transport/group_file.rs` 那段带注释的 `drop(dbc);`）。
> **判据在哪跑**：`scripts/check-lock-scope.mjs`（`npm run verify` 快速层，CI frontend 组）。
> ...分四类判：guard 绑定（活到块结束或 `drop`）、`if let` 条件与实参位置的语句级临时量（活到本语句结束）、以及"判不出作用域"——第三类**直接红**，因为一个会因看不懂而静默放过的守卫比没有守卫更坏；第四类是**持锁调用自锁 helper**。"
> — docs/protocol-invariants.md §25. Lock Scope / INV-P25, line 1037

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** `AppState.db` 的守卫存活期内不得有任何 `emit`；也不得调用内部还会取这把锁的函数（不可重入 Mutex ⇒ 二次取锁 = 永久 park）；判据必须能判出"作用域看不出来"的情况并因此报红，而不是静默放过。

**Where enforcement lives:**

判据脚本（四个分类）：

```js
// scripts/check-lock-scope.mjs:76-90（判据 A：guard 绑定）
//   存活终点取更早的：所在块的结束行；第一条 `drop(NAME)`。
// scripts/check-lock-scope.mjs:91-96（判据 B：语句级临时量）
//   `if let` 条件、let-else、实参位置 ⇒ 临时量在本语句结束时析构 ⇒ 只判"到本语句结束前不得 emit"。
// scripts/check-lock-scope.mjs:97-100（判据 C：覆盖率不许作假）
//   A 类找不到块结束行 ⇒ 直接 FAIL（不是跳过）。
// scripts/check-lock-scope.mjs:101-107（判据 D：持锁期间不许调用"自锁 helper"）
//   先全仓第一遍收集"函数体内出现 db 取锁"的函数名（自锁 helper 集合），
//   第二遍在每个 A 类守卫的存活期内找 `NAME(` 形式的调用。
```

被测对象：`AppState::db` 是 `DbLock<Connection>`（`src-tauri/src/state.rs:1062`），`DbLock` 的取锁语义与 `std::sync::Mutex` 一致（含 poisoning），**不可重入**（`src-tauri/src/db_hold.rs:1-20` 的文件头明写这一点，并解释为什么刻意不实现 `Deref`）。

实测 `node scripts/check-lock-scope.mjs` 输出：

```
✓ 判据自证：16 段夹具全部符合预期（抓 8 / 放 8）
✓ 锁作用域：db 389 个 guard 绑定 + 29 个语句临时量；peers 27 个 guard 绑定 + 19 个语句临时量 —— 全部判过，没有一处锁活着时 emit；自锁 helper 230 个（db）/ 26 个（peers）持锁调用 0 处；peers↔db 跨锁嵌套 0 处
```

- What it checks, and against what：扫全仓 `src-tauri/src` 的**每一个**取锁点，逐处判"守卫存活期内有没有 emit"与"有没有调自锁 helper"。**条数每次实算**（389 + 29 + 27 + 19），脚本自己打印，文档里不留副本 ⇒ 覆盖率不可漂移。
- Which paths reach it, and which do not：判据 A 覆盖 `let NAME = …lock()…;` 且 `.lock()` 在括号深度 0 的绑定；判据 B 覆盖 `if let` 条件、let-else、实参位置的临时量；判据 C 保证 A 类"看不懂"时直接红；判据 D 覆盖"持锁调用自锁 helper"。

**Paths walked — 写库圈住、事件圈外（典型形状）：**

```rust
// src-tauri/src/network/file/receive.rs:1184-1234（fail_taken_receive）
pub fn fail_taken_receive(state: &AppState, transfer_id: &str, r: &FileReceiver, reason: &str) {
    let fail_notes = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());   // ← 锁在这里开始
        let mut notes: Vec<String> = Vec::new();
        if let Err(e) = db::upsert_transfer(&dbc, ...) { notes.push(...); }
        if let Err(e) = crate::content::store::record_failure(&dbc, ...) { notes.push(...); }
        notes
    };                                        // ← 锁在这里结束（块尾）
    for note in fail_notes {
        state.logger.error("file", note);
    }
    emit_failed(state, transfer_id, reason);  // ← emit 在锁外 ✓
}
```

```rust
// src-tauri/src/network/transport/group_file.rs:855-890（finalize_failed_group_receive）
{
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = db::update_group_file_recipient(&dbc, transfer_id, &state.device_id, "failed", 0.0);
}                                          // ← 锁在块里结束
// 状态落了库，但**不发事件就没人知道** …
let _ = state.app.emit("message-status-changed", &format!("gfile-{transfer_id}"));   // ← 锁外 ✓
```

```rust
// src-tauri/src/network/transport.rs:1444-1452（note_new_membership 的顺序纪律）
let _ = state.app.emit("groups-updated", &group_id);
// 喊话放在两个 emit **之后**：`note_new_membership` 自己会取 db 锁，
// 而 INV-P25 那条规矩就是"持锁不许 emit"—— 顺序写反了就把这条纪律还回去了。
if known_group.is_none() {
    crate::network::group_history::note_new_membership(state, &group_id);
}
```

**Paths walked — 判据 D 的自锁 helper：**

```rust
// src-tauri/src/network/transport/queue_policy.rs:327-340（断链收尾）
file::fail_receives_for_peer(&state, &peer_id);
let taken = file::take_group_receives_for_peer(&state, &peer_id);
for (tid, r) in taken {
    file::fail_taken_group_receive(&state, &r);
    finalize_failed_group_receive(&state, &tid, REASON_PEER_UNLINKED);
}
```

这一段里 `finalize_failed_group_receive` **自己会取 db 锁**（`group_file.rs:861-864`）⇒ 它就是"自锁 helper"。调用点**不在任何 db 守卫的存活期内**（`links` 锁在 `:317` 已 `drop(links)`，db 锁此处尚未取）⇒ 判据 D 判绿 ✓

**Paths walked — `drop(dbc);` 先例（判据 A 认它为存活终点）：**

```rust
// src-tauri/src/network/transport/gossip.rs:953-960
drop(dbc);
let _ = state.app.emit("groups-updated", &gid);
// 放在 `drop(dbc)` 之后：`note_new_membership` 自己还要取那把锁（INV-P25）。
if first_membership {
    crate::network::group_history::note_new_membership(state, &group_id);
}
```

```rust
// src-tauri/src/network/transport/gossip.rs:1061-1068
if applied {
    drop(dbc);
    let _ = state.app.emit("message-render-changed", &crate::state::RenderChangedInfo { ... });
}
```

`drop(dbc)` 全仓 11 处生产命中（`commands/group_todo_media.rs:169`、`commands/share.rs:248`、`commands/settings.rs:368/407`、`commands/group_file_dispatch.rs:393`、`network/file/receive.rs:1629`、`network/transport/relay_file.rs:508`、`network/transport/handle_identity.rs:248`、`network/transport/handle_file.rs:583`、`network/transport/gossip.rs:884/953/1061`）。⚠️ **文档点名的那个具体先例位置已经漂移**：文档写的是"`network/transport/group_file.rs` 那段带注释的 `drop(dbc);`"，但该文件里现在只有 `drop(recv)`（`:2054/2059/2065/2089/2102`），**没有** `drop(dbc)`。带注释的 `drop(dbc)` 先例实际落在 `network/transport/gossip.rs:953` 与 `:1061`（`network/group_history.rs:2078-2081` 有一条判据正是钉 `gossip 那一路的喊话要在 drop(dbc) 之后`）。判据本身不依赖那个文件位置（它扫全仓），所以不变量本身不因此失效，但文档的那句"先例"已经指错了地方。

**Searched:**
- `emit` 与 db 锁同现 → 判据脚本实测 **0 处**（"没有一处锁活着时 emit"）。人工复核最危险的两处：`fail_taken_receive`（`receive.rs:1187-1234`，db 锁在 `:1188` 开始、`:1230` 块尾结束、`emit_failed` 在 `:1234` ⇒ 锁外 ✓）与 `fail_taken_group_receive`（`group_receive.rs:266-280`，db 锁在 `:269` 取、无 emit）✓
- `state.app.emit` → 全仓多处，但每处的 db 守卫都已出块。判据脚本逐处核过 389 个 db guard 绑定 + 29 个语句临时量。
- `Mutex` / `RwLock` → `AppState::db` 是 `DbLock<Connection>`（`state.rs:1062`）；`peers` / `file_receivers` / `group_file_receivers` / `links` / `relay` 等是别的 Mutex。判据脚本**也扫 peers**（判据 E：peers↔db 跨锁嵌套 0 处），比文档要求的范围更大。
- `tx`（事务）→ `db/clocks.rs:21` `conn.unchecked_transaction()`、`db/file_transfer.rs:171` `conn.unchecked_transaction()`。事务持锁期间是否有 emit：判据 A 把 `let dbc = state.db.lock()` 与 `let tx = conn.unchecked_transaction()` 都算 db 守卫作用域（`tx` 从 `dbc` 派生），实测 0 违规。
- `lock()` → 全仓 db 取锁点被脚本逐个扫过（389 + 29）。人工抽查 `db/file_transfer.rs:168`（`finalize_file_failure` 的 `tx`）：事务内无 emit；`:241` `mark_file_outbox_cancelled` / `:243` `mark_file_outbox_failed` 在 `tx.commit()` 之前，是写不是 emit ✓
- `drop(dbc)` → 全仓多处（判据 A 的存活终点识别它）。

**Hook verification:**
- `scripts/check-lock-scope.mjs` — **存在**（855 行）。**已接进门禁**：`scripts/verify.mjs` 含该文件名（`check-invariant-hooks.mjs` 的 `scripts/` 形态要求 `verify.mjs` 或 `package.json` 搜得到）✓。实测退出码 0，且**自证夹具 16 段全部符合预期（抓 8 / 放 8）** ⇒ 判据本身非空转。
- `guards:db 锁作用域守卫必须抓得住` — **存在**：`scripts/guard_cases/file_transfer.py:280`，name 为"db 锁作用域守卫必须抓得住「emit 写回锁内」"。实测 name 命中 1 次 ✓

**How the verdict was reached:** 文档要求的四类判据在 `scripts/check-lock-scope.mjs` 里逐条实现（A: guard 绑定存活期 / B: 语句级临时量 / C: 判不出作用域直接红 / D: 持锁调用自锁 helper），脚本已接进门禁，实测自证夹具 16 段全对（8 正 8 反 ⇒ 非空转），且全仓实算 389+29 个 db 取锁点全部判过、0 处锁活着时 emit、0 处持锁调自锁 helper。人工复核了三处最危险的路径（`fail_taken_receive`、`finalize_failed_group_receive`、`note_new_membership` 的 emit 顺序），都符合"写库圈住、事件圈外"。定为 `implemented`：文档的核心禁令（锁内 emit）与后来补的第四类（持锁调自锁 helper）都被机器判据覆盖，且脚本诚实登记了自己看不见的边界。

**Open questions:**
- 脚本自陈的四条盲区（`scripts/check-lock-scope.mjs:68-84`）：跨函数的 emit（靠"`emit*` 命名纪律"缓解，当前唯一 helper 是 `emit_failed`）；D 类认不出"把守卫当参数传下去后再调自锁 helper"；D 类的自锁集合按"函数体里有没有 `db….lock(`"认（字段改名或宏展开 ⇒ 漏收）；D 类只判 A 类守卫（B 类语句临时量未纳入，实测本仓 0 例）。这些盲区是文档自己登记的边界（§25 的"边界（这条规矩不管什么）"），不构成本条的偏差，但意味着"全绿"不等于"绝对无锁内 emit"。
- 脚本扫的锁是 `db` 与 `peers` 两把（判据 E）。文档 §25 明确说"只管 db 那把锁"，`peers` / `file_receivers` / `relay` 等"没有被前端 IPC 抢"，把它们一起管需要逐个论证 ⇒ 代码比文档**多**管了一把 `peers`。这是 `stronger-than-spec` 的一个局部，但整体判词仍是 `implemented`（文档的硬要求全部满足）。
- `DbLock` 刻意不实现 `Deref`（`db_hold.rs:11-15`），理由是"`&state.db` 能悄悄当 `&Mutex<Connection>` 传出去，那次 `.lock()` 走裸 Mutex、一笔都不计"。这意味着持锁观测可能漏计绕过 `DbLock::lock()` 的取锁路径 —— 这条不变量（INV-P25）判的是 emit 而不是观测，两者不冲突，但"锁活着时 emit"的判据也依赖同样的"取锁点识别"能力。
