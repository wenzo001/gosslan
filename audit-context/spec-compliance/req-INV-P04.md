## REQ-INV-P04 — Outbox Is Reliability Boundary

> "发送可靠消息：
>
> ```text
> BEGIN
>   insert message
>   insert outbox
> COMMIT
> ```
>
> 然后才允许：
>
> ```text
> network attempt
> ```
>
> ACK 到达：
>
> ```text
> delete outbox
> ```
>
> ### 绝对禁止
>
> ```text
> send() == Ok
> → delete outbox
> ```"
> — docs/protocol-invariants.md §INV-P04, line 123-151

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 可靠消息的"本地已接受"与"已进入可靠队列"必须**同时**成立（一个事务）；网络投递只能发生在事务提交之后；outbox 行只能由**真正的 Ack** 删除，绝不能由"写进 channel 成功"删除。

**Where enforcement lives:**

1) **消息 + outbox 同一事务**：

```rust
// src-tauri/src/db/messages.rs:47-L76
pub fn insert_message_and_outbox(conn: &Connection, m: &MessageRecord, peer_id: &str, payload: &str) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id) VALUES(?1,...?10)", params![...])?;
    tx.execute("INSERT INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)", params![m.msg_id, peer_id, payload, now_ms()])?;
    tx.commit()
}
```
⇒ 任一步失败 ⇒ 两张表都不动（钩子 `message_and_outbox_are_written_atomically` 钉住这一点）。

2) **调用顺序：先落库、后投递**：

```rust
// src-tauri/src/commands/chat.rs:792-L845
{
    let dbc = s.db.lock()...;
    db::insert_message_and_outbox(&dbc, &rec, &friend_id, &payload).map_err(...)?;
    ...
}
...
let try_ok = if has {
    let r = try_send(s, &friend_id, &Message::Gossip { envelope: env.clone() }).await.is_ok();
    r
} else { broadcast_gossip(s, env).await; true };
```
落库块（`:792-L807`）**在** `try_send`（`:828`）之前，且中间没有任何 await 打断事务边界。

3) **outbox 行只由 Ack 删除**（`db::ack_delivered`）：

```rust
// src-tauri/src/db/messages.rs:841-L863
pub fn ack_delivered(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let expected = tx.query_row("SELECT 1 FROM outbox WHERE msg_id = ?1 AND peer_id = ?2", ...).optional()?.is_some();
    if !expected { return Ok(false); }
    tx.execute("UPDATE messages SET status = 'delivered' WHERE msg_id = ?1 AND status NOT IN ('read','delivered','recalled')", ...)?;
    tx.execute("DELETE FROM outbox WHERE msg_id = ?1", params![msg_id])?;
    tx.commit()?;
    Ok(true)
}
```
调用点：`handle_messaging.rs:224`（直连 Ack）、`gossip.rs:668`（跨跳 ChatAck）。

4) **禁令形态（`send() == Ok → delete outbox`）在代码里不存在**：

```rust
// src-tauri/src/network/transport/outbox_flush.rs:1-L11
// 单聊 / 群聊离线队列的补发：**只补发不删行**，收到 Ack / GroupAck 才删对应行。
// ...
// 注意：这里**只补发、不删除**——outbox 行仅在收到对方 `Ack`（真正确认送达）时删除。
// 旧实现 `try_send` 返回 Ok（仅表示已入发送队列）就删行，半开 TCP 链路上会静默丢消息，
```
`flush_outbox`（`:12-L56`）循环体里只有 `try_send` 与日志，**没有**任何删除；`flush_group_outbox`（`:62-L110`）同理。

5) **outbox 身份是 msg_id 而不是 payload**（重封不破幂等）：

```rust
// src-tauri/src/db/offline_queue.rs:59-L65
pub fn insert_outbox(conn: &Connection, msg_id: &str, peer_id: &str, payload: &str) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO outbox(msg_id, peer_id, payload, created_at) VALUES(?1, ?2, ?3, ?4)", ...)?;
```
`outbox.msg_id` 是 UNIQUE（`db.rs` 的 SCHEMA）⇒ 同一 msg_id 再入队不产生第二行、不覆盖首行。

6) **群侧同一纪律**：群消息走 `send_group_payload`（`commands/window.rs:307-L328`），**一个事务**里 `insert_message` + `touch_conversation` + 每成员一行 `insert_group_outbox`（`:324`），`tx.commit()` 在 `:327`；投递在 `:352`（`broadcast_gossip`）—— 也在提交之后。

7) **Ack 与删行同事务**（状态推进与删行不可分）：`db/messages.rs:832-L837` 的注释与 `lib_outbox_tests.rs:405` 的守卫（`ack_commit_uses_the_single_transaction_helper`）钉住"不许长出内联删行"。

**Paths walked:**
- `send_message` 成功路径 → `insert_message_and_outbox` 提交（消息 + outbox 同时在）→ `try_send` 进 channel → 状态 `sent`（`chat.rs:850`）→ 对端回 Ack → `ack_delivered` 命中 outbox 行 ⇒ 置 delivered + 删行 ✓（一次事务）
- `send_message` 在 `insert_message_and_outbox` 处失败 → 事务回滚 ⇒ 消息与 outbox 行**都不存在** ⇒ 无网络尝试（`:795` 的 `?` 直接返回 Err）✓
- `insert_message_and_outbox` 提交后、`try_send` 失败（链路满）→ outbox 行仍在 ⇒ 状态停在 `sending` ⇒ 后续 `flush_outbox`（建链/Hello/心跳，`handle_identity.rs:86`/`:122`；或 5s 周期重放器 `state.rs:2674`）补发 ⇒ **没有 "send() == Ok 就删行" 的窗口** ✓
- `try_send` 返回 Ok（仅表示进了 channel）但链路随后半开 → outbox 行仍在 ⇒ 补发 ✓
- 对端**未**回 Ack → outbox 行保留 → 清扫器在 120s（可达对端）后落 failed（`outbox_sweep.rs:161-L207`，走 `db::finalize_expired_message` 同一事务：置 failed + 删行，`db/messages.rs:713-L729`）；对端**离线**则保留 7 天（`db/offline_queue.rs:38-L56` `should_fail_expired_outbox`）✓
- 用户取消 → `cancel_queued_message`（`db/messages.rs:751-L779`）在一个事务里删 outbox 行 + 置 cancelled ⇒ 这是**第三条**删行路径，但它的触发是用户显式动作，不是"send 成功" ✓
- 删好友 → `fail_pending_messages_for_peer`（`db/offline_queue.rs:131-L153`）删该 peer 的所有队列行 + 落 failed（一个事务）✓
- 群消息：`send_group_payload` 一个事务写消息 + 每成员 outbox 行 → 投递 → `GroupAck` 到达 → `db::ack_group_delivered`（`handle_group.rs:74`）把该成员行置 delivered ✓

**Searched:**
- `insert_message_and_outbox` → 4 hits：`db/messages.rs:47`（定义）、`commands/chat.rs:794`、`db/favorites_tests.rs:1095`（+ `:1100`）
- `unchecked_transaction()` → 在 `db/messages.rs` 里 4 处（`:53`、`:718`、`:752`、`:800`、`:842`、`:877`）
- `DELETE FROM outbox` → 3 hits：`db/messages.rs:860`（ack_delivered）、`db/offline_queue.rs:115`（delete_outbox_by_msg_id）、`db/offline_queue.rs:138`（fail_pending_messages_for_peer）
- `delete_outbox_by_msg_id` → 2 hits（定义 + `db/messages.rs:725` 的 `finalize_expired_message`）
- `try_send` 后紧跟 `delete_outbox` / `DELETE FROM outbox` → **0 hits**（禁令形态不存在）
- `try_send(...).is_ok()` → 命中：`chat.rs:829`、`commands/window.rs` 之外、`outbox_flush.rs:44`（`if let Err(e) = try_send(...)` —— 注意是 Err 分支才处理，成功分支**不删行**）
- `INSERT OR IGNORE INTO outbox` → 2 hits：`db/offline_queue.rs:61`、`db/messages.rs:817`（`requeue_message_for_resend`）
- `insert_group_outbox` → 命中：`commands/window.rs:324`、`db/group_offline_queue.rs:7`
- `outbox` 表 SCHEMA → `src-tauri/src/db.rs:850`（`msg_id TEXT NOT NULL UNIQUE`）

**Hook verification:**
- `db::tests::message_and_outbox_are_written_atomically` → `src-tauri/src/db/favorites_tests.rs:1092`；断言第二次写同一 msg_id **事务失败**且不留下半条 outbox / 半条消息（`:1100-L1102`）；两平台基线在册 ✓
- `db::tests::outbox_offline_queue_dedup_and_delete` → `src-tauri/src/db/favorites_tests.rs:1058`；两平台基线在册 ✓
- `tests::the_outbox_retry_decision_has_exactly_one_judge_and_one_caller` → `src-tauri/src/lib_outbox_tests.rs:231`；两平台基线在册 ✓ —— **注意它判的是文件队列的重试裁决（`file::send_retry_verdict`），不是消息队列的**；消息队列的过期裁决另有 `db::offline_queue_tests::offline_peer_is_held_while_reachable_peer_fails_at_deadline`（`db/offline_queue.rs:202`）与 `db::offline_queue_tests::group_rows_survive_the_link_flap_window_that_kills_single_chats`（`:167`）
- `tests::outbox_sweeper_emits_only_after_db_write_succeeds` → `src-tauri/src/lib_outbox_tests.rs:38`；两平台基线在册 ✓
- 另有在册未被 spec 点名的：`tests::outbox_retrier_is_wired_and_covers_both_queues`（`lib_outbox_tests.rs:316`）、`tests::outbox_sweeper_is_process_lifetime_and_reachability_includes_discovery`（`:348`）、`tests::ack_commit_uses_the_single_transaction_helper`（`:405`）、`db::startup_safety_tests::expired_finalize_is_atomic_when_outbox_delete_fails`

**How the verdict was reached:** spec 的三段式（BEGIN/COMMIT → network attempt → ACK 删行）与"绝对禁止"形态都能在代码里一一指到具体行。特别验证了禁令：`flush_outbox` / `flush_group_outbox` 的成功分支**不含任何删除**，唯一的删除点是 `ack_delivered`（Ack 命中）、`finalize_expired_message`（超时终态，同事务）、`cancel_queued_message`（用户取消）、`fail_pending_messages_for_peer`（删好友）。四条都不是"send 成功"。所以不是 `partial`。

**Open questions:**
- **spec 的 `tests::the_outbox_retry_decision_has_exactly_one_judge_and_one_caller` 归类错位**：该用例（`lib_outbox_tests.rs:231`）判的是 `commands/files.rs` 里**文件**投递的重试裁决只有一处（`file::send_retry_verdict`），与 INV-P04 的消息 outbox 边界无关。消息 outbox 的"重试裁决"实际上是 `db::should_fail_expired_outbox`（`db/offline_queue.rs:38`）+ `db::should_fail_expired`（`:45`），对应钩子是 `db::offline_queue_tests::*`（未在 spec 的 INV-P04 名单里）。**需要确认 spec 想引用的是哪一个。**
- **群侧的 outbox 行不删、只置状态**：`db::ack_group_delivered`（`db/group_offline_queue.rs:49` 一带）把行置 `delivered` 而不是删（2026-10-25 的口径变化，理由是"行是『谁没收到』的唯一依据"）。spec 的 INV-P04 写的是 `delete outbox`，群侧**没有**这个动作 —— 群用的是另一张表 `group_outbox`（`db.rs:861`），spec 未区分单聊 `outbox` 与群 `group_outbox` 两张表。**需要确认 spec 的 INV-P04 是否只描述单聊。**
- `flush_outbox` 的触发点是"建链 / Hello / 心跳"（`handle_identity.rs:86`、`:122`；`dial.rs:631`；BLE 两条 `central.rs:656` / `peripheral.rs:587`）**加上** 5s 周期重放器（`state.rs:2674-L2699`，注册于 `worker_supervisor.rs:56-L58` 的 `RESIDENT_WORKERS` 名单）。周期重放器只对**当前有链路**的 peer 跑 ⇒ 一个完全离线的 peer 的 outbox 行在重连前不会被主动重试（这是产品承诺"对方离线暂存、上线补发"的一部分，另一部分由 5s 心跳 + 建链事件补上）。spec 未描述这一层。
