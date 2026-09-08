# ADR-0012: Per-Conversation Logical Sequence (Lamport-style)

- Status: Accepted
- Date: 2026-09-08
- Owners: Gosslan
- Related:
  - Protocol: `ChatMessage.seq`, `GossipEnvelope.seq`, `Hello.conv_clock`, `GroupKey.clock`
  - CHANGELOG: 1.0.0

---

## 1. Context

设备间没有中心服务器，且各设备墙上时钟不可信。此前消息排序与群聊清空边界依赖发送方时间戳，导致时钟偏差下已读失效、消息错位、清空后旧消息回灌。

## 2. Decision

每个会话维护本地逻辑时钟 `conversation_clocks`，消息携带 `seq`，排序统一使用 `seq,id`。

## 3. Detailed Design

- 发送：`seq = local_clock + 1`，持久化本地时钟。
- 接收：`local_clock = max(local_clock, received_seq)`。
- 单聊建链通过 `Hello.conv_clock` 对齐；群聊通过 `GroupKey.clock` 对齐。
- 群聊清空边界记录 `seq`，`seq <= boundary` 的旧消息拒绝落库。

## 4. Invariants

- INV-P09：Transport ordering is not application ordering。
- INV-P19：Per-conversation logical sequence。

## 5. Alternatives

- 继续用墙上时钟 + 钳制：仍会猜测对端时钟，已证明不可靠。
- 全局 Lamport：跨会话无用，且无中心节点无法收敛。

## 6. Compatibility

- 旧数据库启动时自动补列并回填 `seq`。
- 协议为预发布，不保留旧信封兼容层。

## 7. Failure Modes

- 发送成功但进程崩溃，时钟可能跳号：可接受，逻辑时钟只要求单调递增。
- 离线成员重连后首次发消息：通过 `Hello.conv_clock` / `GroupKey.clock` 对齐。

## 8. Testing

- DB 单测：`next_clock` / `observe_clock` 单调性。
- 协议单测：`ts` 不参与 message_id，`seq` 参与签名。
- 前端单测：`mergeMessages` 按 `seq,id` 排序。

## 9. Consequences

- Positive：消息排序/已读/清空边界不再依赖墙上时钟。
- Negative：需要维护 `conversation_clocks` 表与协议字段。
