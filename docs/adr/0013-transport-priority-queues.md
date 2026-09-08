# ADR-0013: Transport Priority Queues

- Status: Accepted
- Date: 2026-09-08
- Owners: Gosslan
- Related:
  - Protocol: 无新协议字段，仅内部发送队列分层
  - CHANGELOG: 1.0.0

---

## 1. Context

大文件分片会持续占用单条 TCP 连接的发送队列。若聊天消息与文件分片共用 FIFO 队列，发送大文件时后续聊天消息会被大量分片阻塞，表现为“文件先到、消息过了很久才一起出现”。

## 2. Decision

每条 TCP 连接维护两条发送队列：

- `links`：bulk 通道。
- `priority_links`：priority 通道。

写入端 `try_send` 按消息类型分流；`writer_loop` 使用 `biased` select 优先消费 priority 通道。

## 3. Detailed Design

- priority：聊天、Gossip、Ack、回执、好友/群控制、心跳、Hello、文件握手等。
- bulk：`FileChunk`、`GroupFileChunk`、`RelayChunk`、`FileDone`、`GroupFileDone`。
- `FileDone` / `GroupFileDone` 必须和分片同队列，保证 `Chunk → Done` 顺序。

## 4. Invariants

- INV-P20：Chat must not be starved by bulk transfers。
- INV-P17：File chunks must be verifiable / ordered。

## 5. Alternatives

- 继续单队列：大文件会饿死聊天消息，已实测不可接受。
- 每文件独立连接：复杂度高，收益有限。

## 6. Compatibility

- 纯内部发送策略，无协议变化。

## 7. Failure Modes

- priority 通道满：退化为 priority 消息之间 FIFO，不会比单队列更差。
- bulk 通道满：文件发送方背压，不影响聊天。

## 8. Testing

- 单测：`is_bulk_message` 分类，包含 FileDone/GroupFileDone。
- 真机回归：大文件发送中并发多条消息，消息即时到达。

## 9. Consequences

- Positive：大文件不再阻塞聊天与控制消息。
- Negative：连接生命周期需同步维护两套 map。
