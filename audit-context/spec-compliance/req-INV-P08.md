## REQ-INV-P08 — Direct and Gossip Are Same Logical Message

> "如果：
>
> ```text
> Direct(ChatMessage)
> ```
>
> 和：
>
> ```text
> Gossip(ChatMessage)
> ```
>
> 同时到达：
>
> ```text
> one DB row
> → one UI message
> → one logical delivery
> ```"
> — docs/protocol-invariants.md §INV-P08, line 261-279

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 同一业务消息的两条承载路径（直连 `ChatMessage` 帧 / Gossip 信封）必须收敛到**同一条 DB 行**、**同一个 UI 气泡**、**同一次逻辑送达**（不是两次）。

**Where enforcement lives:**

1) **两侧用同一个 id 落库**：

- Direct 侧：`handle_messaging.rs:142-L156` 用 `msg_id`（帧里的字段）构造 `MessageRecord` 并调 `db::insert_message_if_new`。
- Gossip 侧：`gossip.rs:1104-L1119` 用 `env.message_id` 构造 `MessageRecord` 并调**同一个** `db::insert_message_if_new`（`gossip.rs:1167`）。
⇒ 两侧的落库口是**同一个函数、同一个唯一约束**（`db/messages.rs:34` 的 `WHERE NOT EXISTS (SELECT 1 FROM messages WHERE msg_id = ?1)`）。

2) **发送侧保证两条路径同源**：`commands/chat.rs:736-L752` —— Gossip 信封**先**构造，本地记录、outbox payload、Gossip 投递三处共用 `env.message_id`（`:752` `let msg_id = env.message_id.clone();`）。⇒ 接收方无论先看到哪个帧，拿到的都是同一个 id。

3) **副作用只发生一次**：

```rust
// src-tauri/src/network/transport.rs:1290-L1298
fn announced_on(inserted: &Result<bool, rusqlite::Error>) -> bool { matches!(inserted, Ok(true)) }
fn may_ack(inserted: &Result<bool, rusqlite::Error>) -> bool { !inserted.is_err() }
```
Direct：`handle_messaging.rs:157`（未读 +1）、`:187-L192`（`message-received` 事件）。
Gossip：`gossip.rs:1168`（未读 +1 / 会话预览）、`:1200-L1209`（`message-received`）、`:1213`（链路信息）。
⇒ 只有拿到 `Ok(true)` 的那一方产生未读与事件。

4) **Direct 侧的"已存在"前置短路**：`handle_messaging.rs:59-L72` —— `message_exists` 命中 ⇒ 只回一次 Ack、零副作用、立即 return。

5) **传播层与持久化层互相独立（这是本条的关键设计）**：

```rust
// src-tauri/src/network/transport/gossip_tests.rs:522-L536
/// P1-3：两层去重必须互相独立——Gossip 的 Bloom/LRU 属网络传播层（只认 `message_id`），
/// SQLite 的 `msg_id` 属业务持久化层。业务层的「本机已落库」只能抑制未读/事件，
/// 绝不能前移到转发之前，否则已经 Direct 收到过该消息的节点会拒绝继续 fan-out，
/// epidemic 传播在此断链。
```
生产对应：`gossip.rs:296-L301`（MeshRouter 判决，在业务落库**之前**）→ `:304-L306`（GossipEngine 去重）→ 之后才走到 `:1167` 的业务落库。⇒ **Direct 先落库不会阻断 Gossip 的转发**，但会阻断它的副作用。

6) **UI 一条**：`useChatStore.ts:877-L895` 的 upsert（按 `msg_id` 命中即替换而非追加）+ `utils/messages.ts:16-L53` 的 `mergeMessages`（`byMsg` 去重）。

7) **"one logical delivery" 的另一半：Ack 只算一次**：
- 接收方：Direct 路径回 `Message::Ack`（`handle_messaging.rs:199`）；Gossip 路径回 `GossipKind::ChatAck`（`gossip.rs:1236-L1265`）。**两条路径都会回**（各自一次），但它们是同一个 `msg_id` 的两个 Ack。
- 发送方：`db::ack_delivered`（`db/messages.rs:841-L863`）按 `(msg_id, peer_id)` 命中 outbox 行 ⇒ 第一次 Ack 命中并删行；第二次（另一条路径的 Ack）命中不到 ⇒ `Ok(false)` ⇒ 不 emit `message-acked`、不改状态（`handle_messaging.rs:230-L232` 静默丢弃）。
⇒ 逻辑送达只记一次。

8) **发送侧的"一条投递"**：发送方**只**发 Gossip（`commands/chat.rs:828`/`:843`），Direct 的 `ChatMessage` 只进 outbox（`:791-L794`）用于**补发**（`flush_outbox` → `reseal_for_send`），不做即时直发。也就是说：同一时刻通常只有 Gossip 在飞；Direct 帧是补发形态。⇒ 两条路径在接收方**天然**会先后到达（各一次），靠 id 去重收敛。

**Paths walked:**
- Direct 先到、Gossip 后到 → Direct `insert_message_if_new` → `Ok(true)`（1 行、+1 未读、1 事件）；Gossip 后到 → `Ok(false)` ⇒ 0 副作用，但**仍然会**回 `ChatAck`（`gossip.rs:1236` 的 `!inserted.is_err()` 为真）⇒ 发送方收到两个 Ack，第二个被 `ack_delivered` 判为 `Ok(false)` 静默 ⇒ 逻辑送达一次 ✓
- Gossip 先到、Direct 后到 → Gossip 赢（`Ok(true)`）；Direct 走 `message_exists` 命中 ⇒ 只回 Ack、零副作用 ✓
- 两者**并发**到达 → `insert_message_if_new` 的单条 SQL 裁决（`db/messages.rs:29-L37`）⇒ 只有一方 `Ok(true)` ⇒ 副作用恰好一次 ✓
- Direct 落库**失败**（`Err`）+ Gossip 随后成功 → Direct 侧 `may_ack` 假 ⇒ 不回 Ack；Gossip 侧落库成功 ⇒ 落库 + 副作用 + 回 ChatAck ⇒ 最终 1 行 ✓
- Direct 落库**失败** + Gossip 也失败 → 0 行、0 副作用、两边都不回 Ack ⇒ 发送方 outbox 行保留 ⇒ 补发 ✓
- Gossip 落库失败 → `gossip.rs:1188-L1198` 记 error + `allow_message_retry` 撤销去重 ⇒ 补发能重入 ✓
- Direct 先落库、Gossip 的**传播**仍要继续 → `gossip.rs:296-L301` 的 MeshRouter 判决在业务落库之前 ⇒ Direct 已落库**不**阻断 Gossip 转发 ✓（这正是 `business_duplicate_still_enters_the_propagation_layer` 钉的那条）
- UI 侧两侧事件都到了 → `useChatStore.ts:880-L895` upsert ⇒ 1 个气泡（内容取 `pickMediaContent`，状态取 `furthestStatus`）✓

**Searched:**
- `insert_message_if_new(` → 生产 2 处：`handle_messaging.rs:156`、`gossip.rs:1167` ⇒ **两侧共用同一个落库口** ✓
- `message_exists(` → 生产 1 处：`handle_messaging.rs:61`（Direct 侧前置短路）
- `announced_on(` → 生产 5 处：`handle_messaging.rs:157`、`:187`、`gossip.rs:1168`、`:1200`、`:1213`
- `may_ack(` → 生产 1 处：`handle_messaging.rs:171`
- `Message::Ack { msg_id }` → 生产 2 处：`handle_messaging.rs:70`、`:199`
- `GossipKind::ChatAck` → 生产 1 处构造：`gossip.rs:1241`
- `ack_delivered(` → 生产 2 处：`handle_messaging.rs:224`、`gossip.rs:668`（同一个事务出口，`lib_outbox_tests.rs:405` 守卫）
- `pickMediaContent` / `furthestStatus` → `utils/messages.ts`，调用点 `useChatStore.ts:891-L892`
- `mergeMessages` → `utils/messages.ts:16`，调用点 `useChatStore.ts:896`
- "gossip 层先判 DB 存在就 return" 形态 → **0 hits**（`message_exists` 在生产代码里只出现在 `handle_messaging.rs`）—— 这正是 `gossip_tests.rs:538-L542` 注释警告的"顺手简化"

**Hook verification:**
- `db::tests::direct_and_gossip_same_msg_id_persist_single_row` → `src-tauri/src/db/favorites_tests.rs:742`；断言两次不同来源的插入只留一行、且**先到者胜出**（`:748` `assert_eq!(rows[0].content, "via gossip")`）；两平台基线在册 ✓
- `network::transport::tests::gossip_propagation_layer_stays_independent_of_local_persistence` → `src-tauri/src/network/transport/gossip_tests.rs:527`；两平台基线在册 ✓
- 支撑（spec 未点名但在册）：`db::tests::unread_and_event_fire_only_for_the_winning_insert`（`favorites_tests.rs:950`）、`db::tests::group_msg_id_duplicate_counts_unread_and_event_once`（`:957`）、`db::tests::concurrent_same_msg_id_has_exactly_one_winner`（`:982`）、`network::transport::tests::business_duplicate_still_enters_the_propagation_layer`（`gossip_tests.rs:544`）、`db::tests::repeated_delivery_of_same_msg_id_yields_single_side_effect`（`favorites_tests.rs:965`）

**How the verdict was reached:** 三个"one"各有独立证据：one DB row = 两侧共用 `insert_message_if_new` 的唯一约束；one UI message = 前端按 `msg_id` upsert；one logical delivery = 后端 `ack_delivered` 的 `(msg_id, peer_id)` 命中判据让第二个 Ack 静默。这条还有一个容易漏掉的反向约束（"传播层不能被持久化层前移打断"），代码里也成立。所以判 `implemented`。

**Open questions:**
- **接收方对同一 `msg_id` 会回**两个** Ack（`Message::Ack` + `GossipKind::ChatAck`），只是发送方只认第一次。spec 的 "one logical delivery" 在**发送方状态**上成立，但在**网络层**上是两帧 Ack。**需要确认 spec 的 "one logical delivery" 指状态还是指网络帧。**
- **`direct_and_gossip_same_msg_id_persist_single_row` 判的是 db 层**（两次 `insert_message` 调用），不是"真的走两条网络路径"。真正的路径级证据在 `db::tests::unread_and_event_fire_only_for_the_winning_insert`（也是 db 层，用 `deliver` 夹具模拟两条路径，`favorites_tests.rs:781-L788`）与 `network::transport::tests::business_duplicate_still_enters_the_propagation_layer`（db + GossipEngine 组合）。**全仓没有任何测试真的驱动 `handle_message` 走 Direct 与 Gossip 两条路径**（见 INV-P03 的 ⚠️：AppState 接不进测试夹具，`handle_message(` 的 6 个调用点全是生产代码）。
- 群消息不走 Direct 路径（只有 `GossipKind::Group` 一条路），所以本条的"Direct vs Gossip"对群消息不适用；群消息的重复到达靠 `gossip.rs:1167` 同一落库口收敛（由 `db::tests::group_msg_id_duplicate_counts_unread_and_event_once` 覆盖 db 层）。
- `send_message` 只发 Gossip（不即时直发 `ChatMessage`）这件事，spec 未描述；它意味着"Direct(ChatMessage)"实际上是**补发**形态而非**首发**形态。spec 的 `### 验证` 段（INV-P01 line 34-L40）画的是 "A → B direct" 与 "A → Gossip → B" 两条路径并列，代码里它们其实是同一条 Gossip 路径的两个时间点（首发 + 补发）。
