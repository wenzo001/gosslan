## REQ-INV-P01 — Stable Message ID

> "可靠消息必须具有稳定的业务 `msg_id`。
>
> 同一消息经过：
>
> ```text
> Direct
> Gossip
> Relay
> Retry
> Outbox
> Reconnect
> ```
>
> 不得因为传输路径变化而变成不同业务消息。"
> — docs/protocol-invariants.md §INV-P01, line 15-28

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 一条业务消息在六条投递路径（直连 / Gossip / 中继 / 重试 / Outbox 补发 / 重连）上必须携带**同一个** `msg_id`；路径变化只许改变承载它的帧（`ChatMessage` vs `Gossip`），不许改变身份。落库、去重、Ack 回执、outbox 行键都必须以这个 id 为准。

**Where enforcement lives:**

1) **身份在发送侧一次性确定**（Direct 与 Gossip 共用同一 id）：

```rust
// src-tauri/src/commands/chat.rs:736-L790
let mut env = { gossip.build_envelope(&s.identity, &s.device_id, GossipKind::Chat, None, None, &payload_b64, ts, seq) };
// 统一 msg_id：本地记录 / Gossip 投递 / outbox 补发共用同一确定性 ID，
// 接收方 message_exists 跨路径去重（防建链竞态窗口内的重复投递）。
let msg_id = env.message_id.clone();
...
let queued = Message::ChatMessage { msg_id: msg_id.clone(), from: ..., to: ..., kind: ..., content: wire_content, ts, seq };
```

`env.message_id` 由 `GossipEnvelope::compute_message_id` 算出（`src-tauri/src/protocol.rs:1676-L1683`：SHA-256 of `sender_id ‖ nonce ‖ payload`），**不含 `ts`/`seq`/`target`** ⇒ 直发帧与 Gossip 信封同源同 id。`env.target` 在 `:755` 之后才被改写并重签（`:756`），`message_id` 不参与 `signing_bytes`（`protocol.rs:1688` 起），所以改 target 不换 id。

2) **接收侧跨路径去重（唯一落库口）**：

```rust
// src-tauri/src/db/messages.rs:28-L39
pub fn insert_message_if_new(conn: &Connection, m: &MessageRecord) -> Result<bool> {
    let changed = conn.execute(
        "INSERT INTO messages(msg_id, ...) SELECT ?1, ...
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE msg_id = ?1)", ...)?;
    Ok(changed > 0)
}
```
判定与插入在同一条 SQL 内完成（不先 SELECT 再 INSERT）⇒ Direct 与 Gossip 并发投递同一 `msg_id` 时只有一方拿到 `Ok(true)`（`db/messages.rs:23-L24` 注释明示此意图）。

3) **Direct 路径的"已存在"前置去重**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:59-L72
let exists = { let dbc = state.db.lock()...; db::message_exists(&dbc, &msg_id) };
if exists {
    state.logger.info("ble", format!("[ACK] 重复消息仍回执 msg_id={msg_id} ← peer={peer_id}"));
    let _ = try_send(state, peer_id, &Message::Ack { msg_id }).await;
    return;
}
```
`message_exists` = `SELECT 1 FROM messages WHERE msg_id = ?1`（`db/messages.rs:78-L88`）。

4) **Gossip 路径用的是同一个 id 字段**：`env.message_id` 直接写进 `MessageRecord.msg_id`（`network/transport/gossip.rs:1106`），并作为 `Message::Ack`/`ChatAck` 的载荷（`gossip.rs:1237`、`handle_messaging.rs:199`）。

5) **Outbox 补发不换 id**：`flush_outbox`（`network/transport/outbox_flush.rs:12`）只重发 outbox 里**原样存着的 payload**；重封只改 content，`msg_id` 由 `reseal_for_send` 原样带回（`network/transport/e2ee_payload.rs:120-L128`）。

6) **Retry（界面「重发」）复用原 id**：`resend_message` 显式把信封 id 改回原值：

```rust
// src-tauri/src/commands/chat.rs:953-L958
// ⚠️ 这一行是"复用稳定身份"的全部：信封身份默认由 (sender, nonce, payload) 现算，
// 重新密封必然换密文 ⇒ 换 ID。这里显式改回原 msg_id，再重签。
env.message_id = msg_id.clone();
env.target = Some(peer.clone());
env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
```
并复用原 `ts`/`seq`（`chat.rs:932-L933`：`let ts = msg.ts; let seq = msg.seq;`），入队与置 `sending` 在一个事务里（`db/messages.rs:794-L827` `requeue_message_for_resend`）。

7) **Relay 路径不产生新 id**：中继只是把**收到的帧原样**转投（`handle_share.rs` / `relay.rs` 的定向借道与 `Message::Gossip` 转发都转投原 `Message`），`handle_message` 的 `directed_relay_target` 分支（`network/transport.rs:1090-L1108`）把整帧 `try_send` 出去，不重写 `msg_id`。

**Paths walked:**
- `send_message`（1:1 首发）→ `env.message_id` = 本地行 id = outbox payload 里的 `ChatMessage.msg_id` = Gossip 信封 `message_id` ⇒ 四处同一 id ✓
- `send_message` → 无直连 → `broadcast_gossip(env)`（`commands/chat.rs:843`）⇒ 仍是同一信封 ⇒ 同一 id ✓
- `flush_outbox` → `reseal_for_send` → 密文换了、`msg_id` 没换 ✓
- `resend_message` → `env.message_id = msg_id.clone()` + `requeue_message_for_resend` ⇒ 复用原 id、原 ts/seq ✓
- Direct 入站 → `handle_messaging_arm` `Message::ChatMessage` → `message_exists` 命中即回 Ack 并 return ⇒ 不产生第二个业务消息 ✓
- Gossip 入站 → `handle_gossip` → `insert_message_if_new`（`gossip.rs:1167`）⇒ 与 Direct 共用唯一约束 ⇒ 只有一行 ✓
- Direct 与 Gossip **并发**到达 ⇒ `insert_message_if_new` 单条 SQL 裁决 ⇒ 只有一方 `Ok(true)` ⇒ 副作用只发生一次 ✓
- Relay 定向借道 ⇒ 原帧转发 ⇒ id 不变 ✓
- Reconnect ⇒ 重连后走 `flush_outbox` ⇒ outbox 里那条 payload 的 id 不变 ✓

**Searched:**
- `fn compute_message_id` → 1 hit: `src-tauri/src/protocol.rs:1676`（唯一身份计算点）
- `env.message_id = ` → 2 hits: `commands/chat.rs:956`（重发改回原 id）、`network/transport/gossip.rs:1054`（`allow_message_retry` 的撤销登记）
- `message_id = env.message_id.clone()` / `msg_id: env.message_id.clone()` → 4 hits: `commands/chat.rs:752`、`commands/chat.rs:765`、`commands/chat.rs:782`、`commands/window.rs:287`
- `INSERT OR IGNORE INTO messages` → 0 hits（**已弃用**）：落库改用 `WHERE NOT EXISTS`（`db/messages.rs:34`），注释 `db/messages.rs:30-L31` 明说为何不用 `OR IGNORE`（会把 `local_id` 唯一冲突一起吞掉）
- `uuid::Uuid::new_v4()` → 1 hit: `gossip_engine.rs:197`（只在 Gossip 信封 nonce 上，与 msg_id 无关）
- `random` / `rand` 生成 msg_id → 0 hits：`msg_id` 不由随机数生成（除群文件 `file-{transfer_id}` 那族，见 Open questions）
- `create_new_message` → 0 hits（全仓无此函数）
- `msg_id = `（在 `commands/chat.rs` 内）→ 3 hits：`:752`（取信封 id）、`:765`（本地行）、`:782`（outbox payload）

**Hook verification:**
- `db::tests::message_dedup_by_unique_msg_id` → 定义于 `src-tauri/src/db/favorites_tests.rs:625`；在 `src-tauri/test-baseline.macos.txt` 与 `test-baseline.windows.txt` **均在册**（两平台基线各一行）⇒ 已注册为 Rust lib 测试运行。
- `db::tests::direct_and_gossip_same_msg_id_persist_single_row` → `src-tauri/src/db/favorites_tests.rs:742`；两平台基线在册 ✓
- `db::tests::outbox_identity_is_msg_id_not_payload` → `src-tauri/src/db/favorites_tests.rs:1072`；两平台基线在册 ✓
- `db::tests::concurrent_same_msg_id_has_exactly_one_winner` → `src-tauri/src/db/favorites_tests.rs:982`（8 线程 Barrier 竞态）；两平台基线在册 ✓
- 注册机制：`scripts/check-invariant-hooks.mjs` 解析 `- 钩子：` 行里的每个反引号名；Rust 形态（`a::b::c`）要求名字出现在**本平台** `src-tauri/test-baseline.<os>.txt`（`check-invariant-hooks.mjs:132-L135`）。实跑 `node scripts/check-invariant-hooks.mjs` → `✓ 不变量钩子：36 条全部绑定（具名钩子 36 条、登记为无自动化 0 条） · 形态 rust:112 e2e:3 guard-case:15 frontend:26 script:5`。

**How the verdict was reached:** 六条路径逐条走完，每条都能指出"id 从哪来、到哪去、哪一处把它钉住"。落库去重不是靠 `INSERT OR IGNORE`（会被 `local_id` 冲突吞掉），而是 `WHERE NOT EXISTS` 单条 SQL 裁决，所以并发也只有一方赢。重发路径显式把 `env.message_id` 改回原值并重签 —— 这一步是 INV-P06 与 INV-P01 在代码上的同一个开关。所以不是 `partial`（没有哪条路径走丢），也不是 `stronger-than-spec`（spec 只要求"不因路径变化而变"，代码没有额外加约束）。

**Open questions:**
- 群文件 / 1:1 文件那族的业务 id 是 `file-{transfer_id}` / `gfile-{transfer_id}`（构造口径见 `commands/files.rs`、`network/transport/group_file.rs`），**不是** Gossip 信封 id，也不走 `insert_message_if_new` 的 `msg_id` 唯一约束（它们各有专门的台账表 `file_transfers` / `group_files`）。spec 的六条路径清单（Direct/Gossip/Relay/Retry/Outbox/Reconnect）字面上不含"文件分片重传"，所以本条不判它；但若把 spec 的"可靠消息"读成含文件，则这条不成立。**需要确认 spec 的"可靠消息"是否限定为聊天消息族。**
- 群消息侧 `send_group_payload` 用 `env.message_id`（`commands/window.rs:287`），但群消息的 `group_outbox` 行键是 `(msg_id, group_id, peer_id)`（`db.rs:861` 一带），同一 `msg_id` 在群里的多个成员各一行 —— 这是"一个业务消息多份投递"，与本条的"多个业务消息"相反，不构成违反；但 spec 未描述群的多成员模型。
