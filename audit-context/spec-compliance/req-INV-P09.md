## REQ-INV-P09 — Transport Ordering Is Not Application Ordering

> "不能假设：
>
> ```text
> TCP order == global message order
> ```
>
> 因为 Gosslan 同时存在：
>
> ```text
> Direct
> Gossip
> Outbox
> Relay
> ```
>
> 最终排序必须使用项目定义的消息时间/序列/稳定排序策略。
>
> 不得用"最后收到的"作为业务真相。"
> — docs/protocol-invariants.md §INV-P09, line 289-306

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 排序**不能**由到达顺序决定；必须有一个项目定义的、与传输无关的排序键（逻辑序号 / 稳定时间戳 / 稳定 tie-break），并且该键在乱序到达时仍给出同一个全序。

**Where enforcement lives:**

1) **排序权威 = 每会话逻辑序号 `seq`（Lamport 风格）+ `id` 兜底**：

```rust
// src-tauri/src/db/messages.rs:99-L126
pub fn get_messages(conn: &Connection, conv_id: &str, limit: i64, offset: i64) -> Result<Vec<MessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, ... FROM messages WHERE conv_id = ?1 ORDER BY seq ASC, id ASC LIMIT ?2 OFFSET ?3")?;
```
```rust
// src-tauri/src/db/messages.rs:183-L211
pub fn get_latest_messages(conn: &Connection, conv_id: &str, limit: i64) -> Result<Vec<MessageRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, msg_id, ... FROM messages WHERE conv_id = ?1 ORDER BY seq DESC, id DESC LIMIT ?2")?;
    ...
    out.reverse();     // ← 取尾部但保持与升序查询逐行同序
    Ok(out)
}
```
⇒ **两个方向都是 `seq` 优先、`id` 兜底**，且取尾部与取全表**逐行同序**。

2) **逻辑时钟（排序键的来源）**：

```rust
// src-tauri/src/db/clocks.rs:18-L48
/// 发送前取下一个逻辑序号：`max(local, 0) + 1` 并持久化。
pub fn next_clock(conn: &Connection, conv_id: &str) -> Result<i64> { ... }
/// 收到消息后推进本地会话时钟：`seq = max(local, observed)`。
pub fn observe_clock(conn: &Connection, conv_id: &str, observed: i64) -> Result<()> {
    conn.execute("INSERT INTO conversation_clocks(conv_id, seq) VALUES(?1, ?2)
        ON CONFLICT(conv_id) DO UPDATE SET seq = MAX(conversation_clocks.seq, excluded.seq)", params![conv_id, observed])?;
```
⇒ 键**不依赖墙上时钟**（`db.rs:797-L800` 的 SCHEMA 注释明写："消息排序与群聊清空边界都以此为准，不使用发送方或接收方的墙上时钟"）。

3) **接收侧落库时用的 `seq` 是对端给的逻辑序号，不是到达时刻**：

```rust
// src-tauri/src/network/transport/handle_messaging.rs:139-L155
// 展示时间用本地接收时间；排序用对端给出的逻辑序号 seq。
let ts = db::now_ms();
let seq = seq.max(1);
let rec = MessageRecord { ..., ts, seq, ... };
```
Gossip 侧同形（`gossip.rs:1101-L1103`：`let ts = db::now_ms(); let seq = env.seq.max(1);`）。
⇒ **`ts` 是本地墙钟（只用于显示），`seq` 才是排序键** —— 这正是"不得用最后收到的作为业务真相"的结构性保证：晚到的消息 `ts` 更大但 `seq` 更小 ⇒ 仍排在前面。

4) **前端也按同一把键排**：

```ts
// src/utils/messages.ts:50-L52
// 排序以每会话逻辑序号为主，id 兜底，完全不依赖墙上时钟。
merged.sort((a, b) => a.seq - b.seq || a.id - b.id);
```

5) **观察时钟推进（保证本地后续序号不落后）**：
- Direct：`handle_messaging.rs:159` `db::observe_clock(&dbc, &from, seq).ok();`
- Gossip：`gossip.rs:1171` `db::observe_clock(&dbc, &conv_id, seq).ok();`
- 群密钥帧（非群主那一支也必须观察）：`lib_delivery_shape_tests.rs:433` `group_key_from_non_creator_still_advances_the_conversation_clock` 钉住 `network/transport.rs::handle_group_key` 的非群主分支里有 `db::observe_clock(&dbc, &format!("group:{group_id}"), clock)`。

6) **索引与形状**：`idx_messages_conv_seq` 建在迁移加列之后（`db.rs:790-L798` 注释 + `ensure_post_schema_shape`），保证排序查询走索引。

**Paths walked:**
- A 发两条（seq 1、2），B 按 2、1 的顺序收到 → 落库时 `seq` 分别为 2、1 → `get_messages` 按 `seq ASC` 返回 ⇒ 界面顺序 = 发送顺序 ✓
- 同一 `seq` 撞号（Lamport 允许）→ `id ASC` / `id DESC` 兜底 ⇒ 两条查询**同序** ✓（钩子 `latest_page_breaks_seq_ties_by_id_exactly_like_the_ascending_query`）
- Direct 与 Gossip 乱序到达同一会话 → 两者都用对端给的 `seq` ⇒ 合并后仍按 `seq` ✓
- 消息晚到但 `ts` 更大 → 排序不受影响（排序键是 `seq`）✓
- 取尾部（`get_latest_messages`）与取全表（`get_messages`）⇒ `out.reverse()` 后**逐行同序** ✓（钩子 `latest_page_is_identical_to_the_count_plus_offset_two_step`）
- 群聊：离线成员回来后第一条的 `seq` 可能低于群里当天的 ⇒ 排序键上是"更早" ⇒ 排在前面（**这是 spec 承认的语义**，见 Open questions）
- 内存态 `conversation_clocks` 被 `observe_clock` 的 MAX 语义推进 ⇒ 本机之后发的消息 `seq` 更大 ⇒ 不会插到历史前面 ✓

**Searched:**
- `ORDER BY seq` → 2 hits：`db/messages.rs:107`（`seq ASC, id ASC`）、`db/messages.rs:190`（`seq DESC, id DESC`）
- `ORDER BY ts` → 命中 `db.rs:793` 的 `CREATE INDEX ... idx_messages_conv ON messages(conv_id, ts)`（索引，不是查询排序）与 `db/conversations.rs` 里的会话列表排序（**会话列表**按 `ts` 排，**消息列表**按 `seq` 排 —— 两个不同的对象）
- `a.seq - b.seq` → `src/utils/messages.ts:51`
- `next_clock(` → 生产 3 处：`commands/chat.rs:721`（1:1 发送）、`commands/window.rs:196`（群发送）、`db/clocks.rs` 的测试
- `observe_clock(` → 生产 3 处：`handle_messaging.rs:159`、`gossip.rs:1171`、`network/transport.rs::handle_group_key`（非群主分支）
- `now_ms()` 用作排序键 → **0 hits**：落库时 `ts = db::now_ms()` 与 `seq` 是两个独立字段（`handle_messaging.rs:139-L140`），排序 SQL 里没有 `ts`
- `push` / `unshift` 到前端列表尾部的"追加即最新"形态 → 0 hits（前端走 `mergeMessages` 排序）
- `messages.value[convId].push(` → 0 hits；前端只经 `mergeMessages`

**Hook verification:**
- `db::tests::conversation_clock_is_monotonic` → `src-tauri/src/db/favorites_tests.rs:2410`；两平台基线在册 ✓
- `db::tests::latest_page_breaks_seq_ties_by_id_exactly_like_the_ascending_query` → `src-tauri/src/db/favorites_tests.rs:670`；两平台基线在册 ✓
- `db::tests::late_ack_never_regresses_a_read_message` → `src-tauri/src/db/favorites_tests.rs:1138`；两平台基线在册 ✓ —— 它判的是"已读状态不被迟到 Ack 退回"，属**状态**单调而非**位置**排序；作为 INV-P09 的钩子属于**次要/间接**关联（位置排序的单调性由前两条覆盖）
- 支撑（spec 未点名但在册）：`db::tests::latest_page_is_identical_to_the_count_plus_offset_two_step`（`favorites_tests.rs:654`）、`db::clock_contention_tests::concurrent_writers_keep_seq_contiguous_and_lose_nothing`（`db/clocks.rs:107`，8 线程 × 12 条，断言 `seq` 连续不重号 + `msg_id` 唯一 + 一条都不丢）、`db::clock_contention_tests::long_batch_transaction_does_not_wedge_plain_writers`（`db/clocks.rs:156`）、`tests::group_key_from_non_creator_still_advances_the_conversation_clock`（`lib_delivery_shape_tests.rs:433`）

**How the verdict was reached:** spec 的三条要求逐条对上：排序键存在且项目定义（`seq` + `id`，`db/messages.rs:107`/`:190`、`utils/messages.ts:51`）；键与传输路径无关（`seq` 来自对端的逻辑序号，落库时不取到达时刻）；"最后收到的"不作为真相（`ts` 与 `seq` 是两个独立字段，排序 SQL 里没有 `ts`）。Direct / Gossip / Outbox / Relay 四条路径落库时都写同一个 `seq` 字段 ⇒ 收敛到同一全序。所以判 `implemented`。

**Open questions:**
- **群聊的"逻辑时间"有一个自认的缺陷**：`src-tauri/src/lib_delivery_shape_tests.rs:418-L470` 的注释与断言记录了"离线成员回来后发的第一条消息会排到当天更早的消息**前面**"（2026-10-26 用户截图），根因是每会话逻辑时钟只在本机观察到的序号上前进，ADR-0012 §7 承诺的 `GroupKey.clock` 对齐通道只覆盖了"发送方不是群主"那一支的旧实现（现已由 `group_key_from_non_creator_still_advances_the_conversation_clock` 补上）。**这条不违反 spec（排序键仍是项目定义的稳定键），但它意味着"逻辑序号 ≈ 真实时间顺序"这个隐含假设在离线成员上不成立。需要确认 spec 是否要求这一层对齐。**
- `late_ack_never_regresses_a_read_message` 作为 INV-P09 的钩子判的是**状态**单调（read 不退回 delivered），不是**位置**单调。spec 把三个钩子并列在 INV-P09 下，前两个是位置排序、第三个是状态单调 —— 分类上第三个属于 INV-P02（Read state: 不回退）。**需要确认 spec 的钩子归类。**
- **会话列表**（不是消息列表）按 `ts` 排序（`db/conversations.rs` 的 `list_conversations`）。spec 的 "最终排序" 若被读成"包括会话列表"，则那一处是按墙钟排的。**需要确认 spec 的范围是消息列表还是也包括会话列表。**
- `ts` 字段在落库时被钳制为**本地接收时刻**（`handle_messaging.rs:140`、`gossip.rs:1102`）⇒ 同一业务消息在两端显示的 `ts` 不同。排序不受影响（用 `seq`），但"时间分割线"这类 UI 呈现依赖 `ts` ⇒ 跨端可能有细微差异。spec 未提这条。
