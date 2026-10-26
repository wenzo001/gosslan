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
  群聊这一格 2026-10-26 起对**任意成员**都生效（只观察时钟，群资料与密钥仍只认群主）：
  每一帧 `GroupKey` 都带 `clock`，而每个成员在建链/Hello 时都会重发一遍。
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
  ⚠️ 这一句在 2026-10-26 之前**只对群主成立**：接收侧在"发送方不是群主"那一支直接 return，
  帧里带的 `clock` 从没被消费 ⇒ 离线几天的成员回来后第一条消息的 `seq` 低于群里当天已有的那些，
  于是在**所有对端**界面上排到当天更早的消息前面（现象是时间分割线倒着走：15:34 → 12:13 → 12:57）。
  现在这一支只观察时钟（取 MAX，旧读数无操作），且只接受本机成员表里的人；残余：对齐只发生在
  他与某个更高时钟的成员建链/Hello 之后，那条消息本身仍带旧序号，不会回填重排。

## 8. Testing

- DB 单测：`next_clock` / `observe_clock` 单调性。
- 协议单测：`ts` 不参与 message_id，`seq` 参与签名。
- 前端单测：`mergeMessages` 按 `seq,id` 排序。

## 9. Consequences

- Positive：消息排序/已读/清空边界不再依赖墙上时钟。
- Negative：需要维护 `conversation_clocks` 表与协议字段。
