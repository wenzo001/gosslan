## REQ-INV-P20 — 聊天不得被大文件传输饿死

> "每条 TCP 连接同时维护：
> ```
> priority 通道：聊天 / Gossip / Ack / 回执 / 好友群控制 / 心跳 / Hello / 文件握手
> bulk 通道：FileChunk / GroupFileChunk / RelayChunk / FileDone / GroupFileDone
> ```
> 文件终止帧必须和分片同属 bulk 通道，保证 `Offer → Chunk... → Done` 的协议顺序不被破坏。
> 禁止：
> ```
> 大文件分片占满唯一队列，导致聊天消息长时间排队
> ```"
> — docs/protocol-invariants.md §20. Transport Priority / INV-P20, line 650

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 每条连接必须同时维护独立的 priority 与 bulk 通道；分类表只有一份；终止帧（Done）与分片同属 bulk，保证协议顺序；大文件分片不得占满聊天消息的排队空间。

**Where enforcement lives:**

分类表（单一事实来源）：

```rust
// src-tauri/src/network/dispatch.rs:42-109
pub fn message_priority(msg: &Message) -> MessagePriority {
    match msg {
        // High：链路控制，必须立即处理
        Message::Ack { .. } | Message::Heartbeat { .. }
        | Message::FileAccept { .. } | Message::FileReject { .. }
        | Message::FileCancel { .. } | Message::GroupFileCancel { .. }
        | Message::GroupAck { .. } | Message::GroupReadReceipt { .. }
        | Message::FriendRequest { .. } | Message::FriendAccept { .. }
        | Message::FriendReject { .. } | Message::Hello { .. } => MessagePriority::High,
        // Low：后台 bulk
        Message::FileChunk { .. } | Message::RelayChunk { .. } | Message::GroupFileChunk { .. }
        | Message::GroupHistoryReply { .. }
        // 终止帧**必须和分片同 channel**，保证 FileChunk 流的协议顺序不被调度打乱
        | Message::FileDone { .. } | Message::GroupFileDone { .. } => MessagePriority::Low,
        // Normal：用户交互
        Message::ChatMessage { .. } | Message::FileOffer { .. } | ... => MessagePriority::Normal,
        ...
    }
}
```

三档枚举（`:29-36`）：`High = 0` / `Normal = 1` / `Low = 2`，`Ord` 派生 ⇒ `High < Normal < Low`。

物理通道（每条连接三个独立 mpsc）：

```rust
// src-tauri/src/network/transport/outbound.rs:381-390
let tx = match crate::network::dispatch::message_priority(msg) {
    MessagePriority::High => &link.high,
    MessagePriority::Normal => &link.normal,
    MessagePriority::Low => &link.low,
};
```

```rust
// src-tauri/src/network/transport/outbound.rs:226-268（send_over_order）
for &i in order {
    let Some((high_tx, normal_tx, low_tx)) = senders.get(i) else { continue; };
    let tx = match priority {
        MessagePriority::High => high_tx,
        MessagePriority::Normal => normal_tx,
        MessagePriority::Low => low_tx,
    };
    match tx.try_send(msg.clone()) { ... }
}
```

**三个队列彼此独立** ⇒ Low 队列（1024 槽）在满时**不会**阻塞 High/Normal 的 `try_send`（`outbound.rs:248-258`：只有 Low 队列满才会走 `first_full` 的等待分支，High/Normal 各自的 `try_send` 失败才会等）。

- What it checks, and against what：分类按**消息语义**（不是按大小），分片/终止帧 ⇒ Low，聊天 ⇒ Normal，控制帧 ⇒ High；终止帧与分片同档 ⇒ 顺序不被打乱。
- Which paths reach it, and which do not：`try_send`（`outbound.rs:271`）与 `send_on_link`（`outbound.rs:381`）都经 `message_priority` 选通道；`send_over_order` 在选路顺序上按同一分类投递。

**Paths walked:**
- `try_send(state, peer, Message::ChatMessage)` → `message_priority` ⇒ Normal → `link.normal` ⇒ 与 Low 队列完全独立 ⇒ **聊天不会被分片占满的 Low 队列挡住** ✓
- `try_send(state, peer, Message::FileChunk)` → Low → `link.low` ⇒ 大文件只占 bulk 通道 ✓
- `try_send(state, peer, Message::FileDone)` → Low ⇒ 与 `FileChunk` **同档同通道** ⇒ `Offer → Chunk... → Done` 的协议顺序不被调度打乱 ✓
- `send_on_link(link, msg)`（文件分片专用的保序路径）→ 同样经 `message_priority`（`outbound.rs:387`）⇒ 分片流固定在 Low 通道上，不会与 High 交错破坏追加写顺序 ✓
- `send_over_order` 的 failover 分支（`:239-258`）：**Low 队列满**时记 `first_full` 并最终在 `first_full` 上等（`:260-266`）；**其它链路上的 High/Normal 仍先试过** ⇒ failover 不会让 Low 挤掉 High ✓
- 边界：`message_priority` 的 `_ => MessagePriority::Normal` 兜底（`dispatch.rs:107`）⇒ 未列入分类表的新帧默认 Normal（不落 Low），分类表漏新变体时**不会**误入 bulk ✓

**Searched:**
- `message_priority` → 生产调用点 2 处（`network/transport/outbound.rs:311` 与 `:387`），测试若干。**分类表只有一份** ✓
- `is_bulk_message` → 0 hits（旧的两级 bool 分类已删除，`network/dispatch.rs:7` 的注释与 `network/transport/gossip_tests.rs:411-414` 都记着这次迁移）
- `MessagePriority` → `dispatch.rs`（定义）、`outbound.rs`（消费）、`gossip_tests.rs`（测试）
- `FileDone` / `GroupFileDone` → 在 `dispatch.rs:71-72` 与 `FileChunk` / `GroupFileChunk` **同一个 match 臂** ⇒ 同档同通道 ✓
- `FileCancel` / `GroupFileCancel` → `dispatch.rs:51-52` 归 High（INV-P26 B3 要求："它要打断的正是一条占着 Low 队列的分片流，排在分片后面就等于没有这条帧"）✓
- `link.high` / `link.normal` / `link.low` → `state::Link` 三条独立 mpsc（`state.rs`），`outbound.rs:583-586` 的 `Link{ high, normal, low, cancel }` 构造证实三通道并存
- 单队列（只有一条）→ 0 hits：`state.rs` 的 `Link` 结构体字面量在三处出现（`outbound.rs:583`、`network/transport/dial.rs:582` 附近），每次都是 high/normal/low 三元组
- `GroupHistoryReply` → Low（`dispatch.rs:67`）：一页 800 条群历史是本特征里最大的流量，放在 Low 且被 High/Normal 随时打断；请求帧 `GroupHistoryRequest` 留在 Normal（`dispatch.rs:90`）—— 一半一半是**刻意**的（注释 `:86-89` 解释：请求要"尽快问到摘要好选源"）

**Hook verification:**
- `network::dispatch::tests::stress_mixed_priorities_no_starvation` — **存在**：`src-tauri/src/network/dispatch.rs:418`。用三个 mpsc 模拟三级队列，灌 200 Low + 50 Normal + 30 High，断言三档全部被调度到（`:446-451`）且前 30 个里有 High（`:454-460`）。
- `network::dispatch::tests::file_chunk_is_low_priority` — **存在**：`src-tauri/src/network/dispatch.rs:120` ✓
- `network::dispatch::tests::ack_is_high_priority` — **存在**：`src-tauri/src/network/dispatch.rs:185` ✓
- `network::dispatch::tests::ble_yield_fragments_allows_preemption` — **存在**：`src-tauri/src/network/dispatch.rs:392` ✓（注意：该用例的注释自陈"这个测试主要验证：Low 能完整跑完 50 个不 starvation"，它**不**验证真实生产 writer 循环的片间 yield —— 生产侧只在**帧间**严格优先，见 `dispatch.rs:12-17` 的模块头声明）
- 四条全部在基线中登记 ⇒ 注册到本平台基线 ✓

**How the verdict was reached:** 文档的三条硬要求逐条对上号：两条通道并存（`Link{high, normal, low}` 三个独立 mpsc）、终止帧与分片同档（`dispatch.rs:61-72` 同一个 match 臂）、大文件不占聊天排队空间（Low 与 Normal 是两个独立 channel，`send_over_order` 的 `try_send` 只在**本档**队列满时才等待）。定为 `implemented` 而非 `partial`：文档禁止的形状（"大文件分片占满唯一队列"）在代码里**结构上不可能** —— 不存在"唯一队列"。也不是 `stronger-than-spec`：代码的三档（High/Normal/Low）比文档的两档（priority/bulk）更细，但这是文档自身在别处（INV-P26 B3）明确要求的（`FileCancel` 必须是 High），不构成越权。

**Open questions:**
- `dispatch.rs:12-17` 自陈"一帧进入 `send_frame`（BLE 底层做 MTU 分片循环）就不会中途让出" ⇒ High 的最坏等待 = 单条 Low 帧的分片发送时长。这与文档"聊天不得长时间排队"是否有边界上的差距？文档没有给可接受的等待时长，故无法判定。
- `GroupHistoryReply`（一页 800 条）放在 Low，但它携带的是**正文**而不是分片 —— 文档的 bulk 通道清单里没有它。这是扩展还是偏离？
