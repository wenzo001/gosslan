# Gosslan Protocol & Reliability Invariants

> Version: 1.0
>
> 本文件定义 Gosslan 网络、消息、ACK、Outbox、Gossip、E2EE、身份和持久化必须长期保持的系统不变量。
>
> 修改协议或网络核心代码时必须阅读。

---

## 1. Message Identity

### INV-P01 — Stable Message ID

可靠消息必须具有稳定的业务 `msg_id`。

同一消息经过：

```text
Direct
Gossip
Relay
Retry
Outbox
Reconnect
```

不得因为传输路径变化而变成不同业务消息。

### 验证

```text
A → B direct
A → Gossip → B
A → outbox → B
```

最终 B 必须只产生一个业务消息。

---

## 2. Idempotency

### INV-P02 — Duplicate Delivery Is Safe

同一 `msg_id` 重复到达：

```text
DB: 不重复
UI: 不重复
Notification: 不重复
Read state: 不回退
ACK: 可重复发送
```

### 推荐测试

```text
receive(msg)
receive(msg)
receive(msg)

assert database_count(msg_id) == 1
assert ui_count(msg_id) == 1
```

---

## 3. ACK

### INV-P03 — ACK Means Durable Receive

ACK 只有在接收方完成项目定义的“接收确认”后才能发送。

不能把：

```text
socket write
```

等价为：

```text
message delivered
```

### 发送方

```text
queued
→ sending
→ waiting_ack
→ delivered
```

### 无 ACK

```text
waiting_ack
→ reconnect / retry
```

而不是立即：

```text
failed
```

---

## 4. Outbox

### INV-P04 — Outbox Is Reliability Boundary

发送可靠消息：

```text
BEGIN
  insert message
  insert outbox
COMMIT
```

然后才允许：

```text
network attempt
```

ACK 到达：

```text
delete outbox
```

### 绝对禁止

```text
send() == Ok
→ delete outbox
```

---

## 5. Crash Safety

### INV-P05 — Process Crash Must Not Lose Queued Message

以下场景：

```text
write outbox
process crash
restart
```

重启后必须仍能发现：

```text
pending outbox
```

并尝试补发。

---

## 6. Retry

### INV-P06 — Retry Must Be Idempotent

重试不得生成新的业务消息 ID。

```text
retry(msg_id)
```

不是：

```text
create_new_message()
```

---

## 7. Gossip

### INV-P07 — Gossip Must Converge

Gossip 消息允许多路径到达。

必须：

```text
TTL bounded
dedupe bounded
fanout bounded
```

禁止无限传播。

---

## 8. Gossip + Direct

### INV-P08 — Direct and Gossip Are Same Logical Message

如果：

```text
Direct(ChatMessage)
```

和：

```text
Gossip(ChatMessage)
```

同时到达：

```text
one DB row
one UI message
one logical delivery
```

---

## 9. Ordering

### INV-P09 — Transport Ordering Is Not Application Ordering

不能假设：

```text
TCP order == global message order
```

因为 Gosslan 同时存在：

```text
Direct
Gossip
Outbox
Relay
```

最终排序必须使用项目定义的消息时间/序列/稳定排序策略。

不得用“最后收到的”作为业务真相。

---

## 10. E2EE

### INV-P10 — Ciphertext Must Not Become Plaintext Silently

如果：

```text
ciphertext
+
missing key
```

必须：

```text
observable failure
```

不得：

```text
decrypt failed
→ show plaintext
```

也不得：

```text
decrypt failed
→ silently drop
```

---

## 11. Key Changes

### INV-P11 — Public Key Change Is Security-Relevant

如果发现：

```text
device_id 相同
public_key 不同
```

不能静默覆盖后继续发送。

必须明确决定：

```text
accept
reject
re-key
warn
```

当前实现若尚未具备完整 key rotation，应记录为已知限制，而不是让 AI 自行决定。

---

## 12. Identity

### INV-P12 — Device Identity Persistence

重启不能随机产生新身份。

身份数据：

```text
device_id
identity private key
identity public key
```

必须保持一致，除非用户显式重置身份。

---

## 13. Protocol Version

### INV-P13 — Protocol Evolution Must Be Explicit

协议发生不兼容变化时必须：

```text
version bump
+
compatibility decision
+
ADR
```

禁止：

```text
旧客户端收到新消息
→ panic
→ crash
→ silently corrupt state
```

未知扩展应在协议允许的情况下安全忽略。

---

## 14. Persistence

### INV-P14 — DB Is Not Cache

消息、好友、身份、outbox 等持久化数据不能只存在：

```text
Pinia
memory
peer map
```

如果数据定义为 durable：

```text
SQLite must be source of truth
```

---

## 15. Event / UI

### INV-P15 — Event Is Notification, Not Durable Storage

Tauri event：

```text
Rust → Vue
```

是通知机制，不是数据库。

如果事件丢失：

```text
UI should be able to rehydrate from DB / command
```

不能因为一次 event 丢失而导致永久状态丢失。

---

## 16. Error Handling

### INV-P16 — Errors Must Have Semantics

错误至少区分：

```text
recoverable
retryable
permanent
user_action_required
security_related
```

禁止统一：

```text
Err → failed
```

---

## 17. File Transfer

### INV-P17 — File Chunks Must Be Verifiable

文件分片必须能够：

```text
identify
order
dedupe
validate
reassemble
```

不能仅依赖：

```text
arrival order
```

---

## 18. Security Boundary

### INV-P18 — Private Key Never Crosses UI Boundary

禁止：

```text
Rust private key
→ Tauri invoke result
→ JS
```

前端只能获得完成 UI 所需的公开信息或状态。

---

## 19. Logical Ordering

### INV-P19 — Per-Conversation Logical Sequence

同一会话内的消息排序使用本地维护的逻辑序号 `seq`，不使用墙上时钟，也不猜测对端时钟。

- 发送：`seq = local_clock + 1`，并持久化 `conversation_clocks`。
- 接收：`seq = max(1, received_seq)`，并推进本地时钟。
- 排序：`seq ASC, id ASC`。
- 群聊清空边界：记录清空时的 `seq`，`seq <= boundary` 的旧消息不再回灌。

禁止：

```text
sender_wall_clock 直接决定消息顺序
receiver 纠正/猜测 sender 时钟
```

---

## 20. Transport Priority

### INV-P20 — Chat Must Not Be Starved By Bulk Transfers

每条 TCP 连接同时维护：

```text
priority 通道：聊天 / Gossip / Ack / 回执 / 好友群控制 / 心跳 / Hello / 文件握手
bulk 通道：FileChunk / GroupFileChunk / RelayChunk / FileDone / GroupFileDone
```

文件终止帧必须和分片同属 bulk 通道，保证 `Offer → Chunk... → Done` 的协议顺序不被破坏。

禁止：

```text
大文件分片占满唯一队列，导致聊天消息长时间排队
```

---

## 21. Handshake Identity

### INV-P21 — Peer Identity Authenticated Before Link

TCP 链路建立**之前**，必须先用密码学手段确认对端确实是 `peer_id` 本人。

`Hello` 必须携带：

```text
nonce  : 每次握手新生成的随机串（防重放）
sig    : Ed25519 签名，覆盖 device_id | tcp_port | nonce | x25519_pubkey | ed25519_pubkey
```

接收方校验规则：

```text
friends / peers 中已绑定该 device_id 的 Ed25519 公钥？
    ├── 是 → 自报公钥必须等于绑定公钥，且 sig 必须用该公钥验证通过
    └── 否 → TOFU：sig 必须用 Hello 自报的 ed25519_pubkey 验证通过
校验失败 → 直接丢弃连接，且不得把 peer_id 写入 links / priority_links
```

原因：`handle_message` 中大量**明文控制消息**（`GroupMemberRemoved` / `GroupRename` /
`FriendRemove` / `FriendAccept` / `ReadReceipt` / `Heartbeat` / `UserInfo`）只做
`from == peer_id` 绑定校验。若 `peer_id` 可冒充，这些消息即可被伪造 —— 例如冒用群主
`device_id` 发送 `GroupMemberRemoved` 可让受害者本地删除整个群。

禁止：

```text
未经验签就把 Hello 自报的 device_id 当作链路身份
为「兼容旧版本」保留无签名的 Hello 分支
```

---

# 22. Invariant Change Procedure

如果一个新需求必须违反现有 invariant：

AI 不得直接修改。

必须先：

```text
1. 指出冲突
2. 说明为什么当前 invariant 不再成立
3. 给出新 invariant
4. 说明迁移策略
5. 增加回归测试
6. 新增/更新 ADR
7. 再修改实现
```

---

# 23. Required Test Matrix

核心消息功能至少覆盖：

| Scenario | Expected |
|---|---|
| Direct | 1 message |
| Gossip | 1 message |
| Direct + Gossip | 1 message |
| Duplicate | 1 DB row |
| ACK lost | Outbox remains |
| TCP half-open | Outbox remains |
| Peer offline | Outbox remains |
| Reconnect | Message delivered |
| App restart | Outbox recovered |
| Receiver restart | Duplicate safe |
| Key missing | Visible failure |
| Key changed | Security-relevant handling |
| Gossip TTL exhausted | Stop forwarding |
| Big file + chat burst | Chat delivered promptly |
| File chunk order | Chunk N before Done |
| Group clear boundary | seq <= boundary blocked |
| Clock skew | Ordering/read state unaffected |
