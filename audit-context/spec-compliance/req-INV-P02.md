## REQ-INV-P02 — Duplicate Delivery Is Safe

> "同一 `msg_id` 重复到达：
>
> ```text
> DB: 不重复
> UI: 不重复
> Notification: 不重复
> Read state: 不回退
> ACK: 可重复发送
> ```"
> — docs/protocol-invariants.md §INV-P02, line 48-56

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 同一个 `msg_id` 被投递 N 次，五个后果各自必须只发生一次：DB 一行、UI 一条、通知一次、已读状态不倒退、Ack 可以反复发（收方不因重复而拒绝再回执）。

**Where enforcement lives:**

1) **DB — 一次插入，三态裁决**：

```rust
// src-tauri/src/db/messages.rs:28-L39
pub fn insert_message_if_new(conn: &Connection, m: &MessageRecord) -> Result<bool> {
    let changed = conn.execute(
        "INSERT INTO messages(msg_id, conv_id, sender_id, receiver_id, kind, content, ts, seq, status, mention_targets, local_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, COALESCE(?11, ?1)
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE msg_id = ?1)",
        params![...])?;
    Ok(changed > 0)
}
```
`Ok(true)`=本次真新建（唯一允许产生副作用的一方）；`Ok(false)`=重复（`msg_id` 已存在）；`Err`=真故障（消息**没有**持久化）。

2) **副作用门控 —— 三态不折叠**：

```rust
// src-tauri/src/network/transport.rs:1290-L1298
fn announced_on(inserted: &Result<bool, rusqlite::Error>) -> bool { matches!(inserted, Ok(true)) }
fn may_ack(inserted: &Result<bool, rusqlite::Error>) -> bool { !inserted.is_err() }
```
- `announced_on` 门控未读 +1 与 `message-received` 事件：`handle_messaging.rs:157`（`touch_conversation`）、`:187-L192`（emit）；Gossip 侧 `gossip.rs:1168`、`:1200-L1209`、`:1213`。
- `may_ack` 门控 Ack：重复（`Ok(false)`）**允许**回 Ack，真故障（`Err`）**禁止**回 Ack。

3) **Ack 可重复发送（收方不因重复而拒回）**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:63-L72
if exists {
    state.logger.info("ble", format!("[ACK] 重复消息仍回执 msg_id={msg_id} ← peer={peer_id}"));
    let _ = try_send(state, peer_id, &Message::Ack { msg_id }).await;
    return;
}
```
Gossip 侧同样：`gossip.rs:1224`（群）/ `:1236`（单聊 `ChatAck`）在 `!inserted.is_err()` 时**无条件**回执 —— 重复（`Ok(false)`）也回。

4) **Ack 幂等（发方收重复 Ack 不改判）**：

```rust
// src-tauri/src/db/messages.rs:841-L863
pub fn ack_delivered(conn: &Connection, msg_id: &str, peer_id: &str) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let expected = tx.query_row("SELECT 1 FROM outbox WHERE msg_id = ?1 AND peer_id = ?2", ...).optional()?.is_some();
    if !expected { return Ok(false); }               // 已收尾过 ⇒ 重复 Ack 静默丢弃
    tx.execute("UPDATE messages SET status = 'delivered' WHERE msg_id = ?1 AND status NOT IN ('read','delivered','recalled')", ...)?;
    tx.execute("DELETE FROM outbox WHERE msg_id = ?1", ...)?;
    tx.commit()?;
    Ok(true)
}
```
重复 Ack 命中不到 outbox 行 ⇒ `Ok(false)` ⇒ 调用方不 emit `message-acked`（`handle_messaging.rs:230-L232`）、不改状态。

5) **Read state 不回退**：

```rust
// src-tauri/src/db/messages.rs:696-L705
pub fn set_message_status(conn: &Connection, msg_id: &str, status: &str) -> Result<usize> {
    let rows = conn.execute(
        "UPDATE messages SET status = ?2 WHERE msg_id = ?1
           AND status NOT IN ('read', 'delivered', 'recalled', 'cancelled', 'partial_cancelled', 'failed')", ...)?;
```
已读回执那条 UPDATE 另有一份更严的谓词（`db/read_receipts.rs:88-L101` `mark_own_messages_read_upto`），额外排除 `failed`。
前端侧也不许回退：`utils/messages.ts` 的 `furthestStatus` 只前进。

6) **UI 不重复**：

```ts
// src/stores/useChatStore.ts:877-L895
const existing = messages.value[convId] ?? [];
const indexOf = new Map(existing.map((m, i) => [m.msg_id, i] as const));
const next = [...existing];
for (const m of incoming) {
  const i = indexOf.get(m.msg_id);
  if (i === undefined) { indexOf.set(m.msg_id, next.length); next.push(m); }
  else { const prev = next[i]; next[i] = { ...m, content: pickMediaContent(prev, m), status: furthestStatus(prev.status, m.status) }; }
}
messages.value[convId] = mergeMessages([], next);
```
`mergeMessages`（`src/utils/messages.ts:16-L53`）再按 `msg_id` **与** `local_id` 双重去重、按 `seq`/`id` 排序。

未读只按"本地真正新增"累加（`useChatStore.ts:843-L854`）：
```ts
const known = existingIdsByConv.get(cid) ?? new Set<string>();
for (const item of list) { if (known.has(item.msg_id)) continue; known.add(item.msg_id); fresh.push(item); }
```

7) **Notification 不重复**：
- 收方只在 `announced_on` 为真时 emit `message-received`（`handle_messaging.rs:187`、`gossip.rs:1200`）⇒ 重复投递**根本不会产生第二条事件** ⇒ 前端不会二次通知。
- 前端侧还有两道：任务终态提示按 `msg_id` 去重（`useChatStore.ts:455` `notifiedTodoDone` Set）；强提醒按 `msg_id` 去重（`useChatStore.ts:506` `remindedIds` / `:509` `nudgedIds`）。
- 通知本身走 1.5s 去抖合并窗口（`useChatStore.ts:293-L310` `NOTIFY_DEBOUNCE_MS`），窗口内同会话只累积不重复弹。

**Paths walked:**
- Direct 入站 × 3 次同一 `msg_id` → 第一次 `Ok(true)` 落库 + 未读+1 + emit；后两次 `Ok(false)` ⇒ `announced_on` 假 ⇒ 不动未读、不 emit ✓（DB 1 行、UI 1 条、通知 0~1 次）
- Gossip 入站 × 3 次同一 `msg_id` → `gossip.is_new(&env.message_id)`（`gossip.rs:304`）在**传播层**先挡掉第二份；第三份即使过了传播层，`insert_message_if_new` 仍判 `Ok(false)` ⇒ 不动副作用 ✓
- Direct 先、Gossip 后 → Direct 赢 `Ok(true)`；Gossip 落库 `Ok(false)` ⇒ **无**第二次未读、**无**第二次事件 ✓
- Gossip 先、Direct 后 → Gossip 赢；Direct 走 `message_exists` 前置分支（`handle_messaging.rs:59-L72`）⇒ 只回 Ack、零副作用 ✓
- DB 真故障（`Err`）→ `may_ack` 假 ⇒ **不回 Ack**（发送方 outbox 行保留，等补发）；`announced_on` 假 ⇒ 不投递 ✓
- 重复 Ack（发方已收过一次）→ `ack_delivered` 命中不到 outbox 行 ⇒ `Ok(false)` ⇒ 不 emit `message-acked`、状态不回退 ✓
- 迟到 Ack 撞上已读消息 → `set_message_status` 的 `NOT IN ('read',...)` ⇒ 已读不被退回 delivered ✓
- 群消息重复（同一 `msg_id` 经 Gossip 两次）→ `gossip.rs:1167` 同一 `insert_message_if_new` ⇒ 一次副作用；群 Ack 在 `!inserted.is_err()` 时照发（`gossip.rs:1224`）⇒ 可重复发送 ✓

**Searched:**
- `INSERT OR IGNORE INTO messages` → 0 hits（已弃用；`db/messages.rs:30-L31` 注明理由：会把 `local_id` 唯一冲突一起吞掉）
- `insert_message_if_new(` → 9 hits：`db/messages.rs:28`（定义）、`db/messages.rs:42`（`insert_message` 包一层）、`handle_messaging.rs:156`、`gossip.rs:1167`、`db/favorites_tests.rs:783`（夹具 `deliver`）、`:827`、`:831`、`:562`、`:564`、`:994`、`db/messages.rs` 内 `local_id_tests`
- `announced_on(` → 6 hits：`transport.rs:1290`（定义）、`handle_messaging.rs:157`、`:187`、`gossip.rs:1168`、`:1200`、`:1213`
- `may_ack(` → 2 hits：`transport.rs:1296`（定义）、`handle_messaging.rs:171`
- `message_exists(` → 5 hits：`db/messages.rs:78`（定义）、`handle_messaging.rs:61`、`db/favorites_tests.rs` 若干
- `notifiedTodoDone` / `remindedIds` / `nudgedIds` → `useChatStore.ts:455` / `:506` / `:509`
- `furthestStatus` → `utils/messages.ts` 内多处；调用点 `useChatStore.ts:892`、`:3072`
- `duplicate` / `idempot` 关键词在 `src/` 下 → 命中集中在 `utils/messages.ts`、`useChatStore.ts` 的注释与 `mergeMessages`

**Hook verification:**
- `db::tests::repeated_delivery_of_same_msg_id_yields_single_side_effect` → `src-tauri/src/db/favorites_tests.rs:965`（5 次投递、事件恒 1、未读恒 1）；两平台基线在册 ✓
- `db::tests::unread_and_event_fire_only_for_the_winning_insert` → `src-tauri/src/db/favorites_tests.rs:950`（Direct→Gossip 与 Gossip→Direct 两种顺序）；两平台基线在册 ✓
- `db::tests::group_msg_id_duplicate_counts_unread_and_event_once` → `src-tauri/src/db/favorites_tests.rs:957`（群 kind 同一夹具）；两平台基线在册 ✓
- `db::tests::late_ack_never_regresses_a_read_message` → `src-tauri/src/db/favorites_tests.rs:1138`；两平台基线在册 ✓
- 支撑夹具（非钩子但被上面三条共用）：`deliver`（`favorites_tests.rs:781`）、`assert_one_side_effect`（`:792`）
- 另有 `db::ack_delivery_tests::duplicate_and_late_acks_are_idempotent_and_never_change_the_verdict`（`db/messages.rs:1064`）覆盖 Ack 幂等；在两平台基线在册。

**How the verdict was reached:** spec 列了五个"不重复/不回退"，代码里五个各有**不同的**执行点，且这些点分处三个文件（db 层、transport 层、前端 store）。不是 `partial`：五条路径都走到底，没有一条"该拦的没拦"。不是 `stronger-than-spec`：spec 的措辞已经覆盖了 `Err` 不回 Ack 这条额外约束（"ACK: 可重复发送" + DB 故障语义），代码没有超出 spec 的判据。

**Open questions:**
- spec 说的 "Notification: 不重复" 覆盖的是**系统通知**（notify-rust / plugin）。本仓的通知链有两段：Rust 侧 `notifications::show_click_if_enabled`（好友申请/好友通过）与前端 `queueNotification`（聊天消息）。聊天消息通知只在 `announced_on` 为真时才有机会产生 ⇒ 重复投递不会多弹。但**好友申请**路径的通知门控是"本机是不是第一次握着这条申请"（`lib_friend_identity_tests.rs:135` `every_friend_request_path_notifies_only_on_first_sighting`），它靠的是 `pending_requests.insert()` 的返回值而不是 `msg_id` —— 好友申请没有 `msg_id` 语义（每次补发是**新** `message_id` 的新信封，见 `handshake.rs` 的 `send_friend_request_via_link`），所以"同一 msg_id 重复到达"在好友申请这一族**不成立**。spec 的"同一 msg_id"措辞默认指聊天消息族，本条的判定按聊天消息族给出。**若 spec 想覆盖好友申请族，需要另行定义"同一申请"的身份键。**
- 前端 `applyIncoming` 的未读去重依赖内存里已有的 `messages.value[convId]`；若该会话被 LRU 逐出（`useChatStore.ts:1618-L1646`，上限 `MAX_CACHED_CONVS = 8`），一份**重复**的 `message-received` 会因为"内存里没有这条"而被计成新的未读。后端仍在 `announced_on` 层挡住了重复 emit（重复投递不会二次 emit），所以这条只在"前端漏收一次真事件 + 之后收到一份重复副本"这个组合下才会显现 —— 需要确认该组合是否可达。
