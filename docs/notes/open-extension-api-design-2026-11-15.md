# 开放接口设计：好友同步 / 定向分享 / 事件推送（2026-11-15）

> 状态：**设计稿，未实现**。用户 2026-11-15 提出四项诉求（见 §1），本文给出通道模型、授权模型、
> 四组接口契约、隐私红线与实现顺序。**代码一行未动**。
> ⚠️ 本设计**跨过了 Frozen Core 的好友 / 消息 / 通知边界**（见 §6），落地前需要用户显式裁决。

## 0. 先说结论

| 诉求 | 可行性 | 关键限制 |
|---|---|---|
| 电脑端快捷登录 | ✅ **已有** | 见接入指南 §1，本文不重复 |
| RP 页面拉好友列表并同步 | ✅ 可做 | 走**出站 POST**（§2 的 T1），RP 不能主动连本机 |
| 页面上一键分享到指定会话 | ✅ 可做 | **仍需用户点确认**（不可静默代发，见 §4.2） |
| 页面收消息 / 通知类事件 | ⚠️ 可做但**须分档** | 元事件可做；**正文外送是产品定位级决定**，须单独裁决 |

## 1. 需求复述与现状盘点

用户诉求（2026-11-15 原话要点）：

1. 让第三方应用接入，在**电脑端**支持快捷登录。
2. 接入后能**同步好友列表**。
3. 能在第三方页面上分享，**直接落到本机聊天框**（群与单聊都行）。
4. 第三方页面能收到**消息 / 通知类事件**（只要用户对上）。

现状（读活代码，不引旧结论）：

| 能力 | 现状 | 位置 |
|---|---|---|
| 快捷登录 | ✅ 已实现（device auth：深链 → 用户确认 → 绑定 → JWS 断言 → 决策回写） | `src-tauri/src/device_auth.rs`、`commands/device_auth.rs` |
| 分享到会话 | ✅ 已实现，但**单向**：RP 触发 → 用户在面板里**自己勾选**会话 → 发送；**无回执** | `src-tauri/src/share.rs`、`commands/external_share.rs` |
| 好友列表 | 内部命令已有（`get_friends`），**没有任何对外通道** | `src-tauri/src/commands/friends.rs` |
| 定向分享（指定目标） | ❌ 无（深链无 `to` 参数，面板不预选） | `src-tauri/src/share.rs` |
| 分享回执 | ❌ 无（接入指南 §2.4 明写「没有回调」） | — |
| 消息事件外送 | ❌ 无（`message-received` 只 emit 到本机前端） | `src-tauri/src/state.rs` |

## 2. 通道模型（先定这个，否则后面全是空谈）

**硬约束**：Gosslan 跑在用户本机（LAN / BLE mesh），第三方 RP 跑在公网。
⇒ **RP 无法主动连到 Gosslan**（没有入站通道，Gosslan 没有公网地址）。

但 device auth 已经证明**出站可用**：决策回写是 Gosslan 主动 `POST` 到 RP 的
`decision_endpoint`（接入指南 §1.5）。所以本设计只允许两种通道：

| 代号 | 通道 | 用途 | 先例 |
|---|---|---|---|
| **T1** | Gosslan → RP 的 HTTPS 端点（出站 POST） | 决策回写、好友同步、事件推送、分享回执 | 决策回写（已有） |
| **T2** | RP 页面 → 深链唤起 Gosslan → 用户确认 → 结果经 T1 或深链回跳带回 | 发起定向分享、申请 scope | device auth（已有） |

**T3（RP 轮询 Gosslan）不成立** —— RP 连不到本机。若某个需求看起来需要它，
只能改写成「Gosslan 推给 RP」。

所有新增端点沿用 device auth 的既有规矩：**HTTPS 且与 `issuer` 同源**，
空串 = 该 RP 未提供 = 不做（不是失败）。幂等键沿用
`revoke_idempotency_key` 的同款确定性派生（不落库、跨重试恒定）。

## 3. 授权模型：claim 与 scope 是两件事

现有 `ALLOWED_CLAIMS = [device_subject, device_public_key, nickname]` 管的是
**「这条断言里带什么」**（登录凭据的面），不放行任何读取本机数据的权限。

本设计引入**第二层：`scope`**（这个应用**被允许做什么**）。

| scope | 含义 | 默认 |
|---|---|---|
| `friends.read` | 读好友列表（device_id + 昵称 + 在线态） | 关 |
| `groups.read` | 读群列表（群 id + 名称 + 成员数） | 关 |
| `chat.send` | 把内容送到**指定**会话（每次仍要用户确认） | 关 |
| `events.metadata` | 收消息**元事件**（谁 / 何时 / 哪个会话 / 什么类型），**不含正文** | 关 |
| `events.content` | 收消息**正文** | 关（须单独裁决，见 §6.3） |

规则：

1. **默认全关**。scope 只由用户在确认页**逐项勾选**获得，RP 不能自己声明要什么就算什么。
2. scope 请求写在事务的 `requested_scopes` 里（与 `requested_claims` 并列）；
   **未知 scope 整笔拒**（与未知 claim 同口径，不静默忽略）。
3. 授权以 **pairwise subject** 为界：同一个 RP 在不同 RP 侧互不可见；
   撤销一个 RP 的授权不影响另一个。
4. 撤销 = 解除绑定 ⇒ **立即停止所有推送**，并回写 RP（复用 `revocation_endpoint`）。

## 4. 四组接口契约

### 4.1 好友同步（T1）

- `RpMetadata` 新增**可选** `friends_endpoint`（HTTPS + 同源）。
- 触发：绑定成功后推一次；此后好友表变化时推（加好友 / 删好友 / 密钥轮换 / 在线态变化，按节流合并）。
- 载荷：

```json
{ "subject": "<pairwise subject>", "updated_at": 1731600000000,
  "friends": [ { "device_id": "<对端设备 id>", "nickname": "…", "online": true } ] }
```

- **不含**：对端公钥、任何消息内容、群成员名单。
- 幂等：`updated_at` 单调递增，RP 据此去重；重发同一 `updated_at` 必须被 RP 合并。
- 失败：静默指数退避重试，**只进日志不上屏** —— RP 挂了不该打扰用户。

### 4.2 定向分享（T2 + T1 回执）

- 深链加两个参数：`to`（device_id 或 group id）与 `to_kind`（`peer` | `group`）。
- **面板仍然出现，但目标预填并高亮，用户点「发送」才算。**
  - 这是既有口径（「不预选任何会话」）的**最小延伸**：RP 不能静默代发，
    否则任意网页都能往用户聊天框塞内容 = 开放注入。
  - 预填 ≠ 预选：会话多选框里该目标仍需用户勾选。
- **目标解析必须 fail-closed**：
  - `to_kind=peer` ⇒ `to` 必须在**双向好友表**里；否则回执 `unknown_target`，**不猜**。
  - `to_kind=group` ⇒ `to` 必须是本机已知的群 id。
  - 匹配不到就报「目标不存在」，**绝不新建会话、绝不广播**。
- 回执：可选 `share_receipt_endpoint`（同源）⇒ 发送完成后 POST
  `{subject, share_id, status: "sent" | "partial" | "failed", targets: [...]}`。
- 群与单聊**同一条路径**：都走既有发送通道（乐观上屏 / 台账 / 失败态），不改消息语义。

### 4.3 事件推送（T1）

- `RpMetadata` 新增**可选** `events_endpoint`。
- 触发：本机用户**收到**消息时（`sender_id != 本机`）；群消息按 `conv_id` 归组。
- **两档载荷**，由 scope 决定：

| scope | 载荷 |
|---|---|
| `events.metadata` | `{conv_id, sender_id, kind, ts, seq, has_content}` —— **没有 `content` 字段** |
| `events.content` | 追加 `content`（原样） |

- 频次：按会话合并（短窗口内多条合并成一条，带 `count`），避免每条消息一次 POST。
- 失败：静默退避重试（同 §4.1）。

### 4.4 好友列表在页面上的用途（与 §4.1 的衔接）

RP 拿到的 `device_id` 是**对端设备 id**。RP 把它放进 `to` 回传时，Gosslan 侧
用**双向好友表**匹配（§4.2）。因此：

- 不做「pairwise 化好友 id」—— 那会让 RP 拿到的 id 无法回传，等于自废 §4.2。
- 代价：RP 看到的是**设备 id**，可跨 RP 关联同一个好友（跨 RP 关联本来就是 P2P 的既有暴露面，
  不是本设计新增的）。本设计不扩大它，也不承诺隐藏。

## 5. 复用与「不改」清单

**复用**：metadata 同源校验、pairwise subject、幂等键派生、`revocation_endpoint` 回写、
既有发送通道（§4.2 的定向分享走同一条路）。

**不改（Frozen Core）**：`msg_id` / E2EE / Outbox / Ack / SQLite 表 schema / 好友 / 文件 /
通知 / Chat UI。

**持久化的坑**：授权关系（「哪个 RP 订阅了哪些 scope」）需要持久化，
但 SQLite 表 schema 是 Frozen Core。本设计**先走内存态**（与 `device_auth_pending` 同款，
容量很小），**重启后由 RP 重新触发绑定**以恢复授权。

- 代价：用户重启应用后，RP 的推送要重新授权一次。
- 收益：不动 schema，不碰红线。
- 若后续要持久化 ⇒ 单独提案（加列还是加表）并单独裁决。

## 6. 需要用户裁决的点（本文不构成授权）

### 6.1 是否解锁 Frozen Core 的好友边界

`friends.read` / `groups.read` 允许第三方应用读取本机好友与群列表。
好友属于 Frozen Core。**这一条必须由用户显式解锁**，解锁范围建议逐项：

- 只放行 `friends.read`（好友列表），不放行 `groups.read`？
- 放行后是否要求「每次读取都要确认」？（更安全但体验差）
- 是否要求「只在用户打开应用时同步」（不做后台推送）？

### 6.2 定向分享是否允许「免确认直发」

本设计保留用户确认（§4.2）。若要允许 RP 指定目标后**直接发送、无确认**，
则任意网页都能往用户聊天框注入内容 ⇒ **不建议**，除非限定为「已绑定且用户显式信任的 RP」。

### 6.3 消息正文能否外送

`events.content` 把消息正文送到第三方服务器 —— 这与 Gosslan 的**端到端加密定位**
正面冲突（消息内容离开本机即脱离 E2EE 保护）。

- 建议：**只做 `events.metadata`**（谁发的、何时、哪个会话），正文留在本机。
- 若确需正文：至少要 (a) 逐会话单独授权、(b) 确认页上用警告级文案、
  (c) 明确记录「这条消息已离开 E2EE 保护范围」。

### 6.4 事件推送的形态

「消息同步到聊天框」有两种理解，实现差别很大：

- **(a) RP 页面显示这些消息**（RP 变成一个只读客户端）
- **(b) 把第三方应用的消息**插进 Gosslan 的聊天框（跨应用注入）

(b) 等于让第三方写入本地消息历史（碰 `msg_id` / Outbox / Ack 三条红线）⇒
**本设计不做**，也不建议做。(a) 是 §4.3 的直接结果。

## 7. 实现顺序（裁决之后）

1. **metadata 扩展 + scope 校验**：`RpMetadata` 加 `friends_endpoint` / `events_endpoint` /
   `share_receipt_endpoint` / `requested_scopes` 校验（跨平台纯逻辑，可单测）。
2. **好友同步**（T1）：出站 POST + 静默重试 + 幂等。
3. **定向分享**（T2）：深链 `to` 参数 + 目标 fail-closed 解析 + 回执。
4. **事件元数据推送**（T1）：按会话合并 + 两档载荷。
5. **正文推送**：仅在 §6.3 单独裁决后才做。

每一步都要有：跨语言契约对账判据（Rust ↔ mock ↔ 前端）、非空转自证、
错误码双向对账、文档同批同步。

## 8. 验收判据（草案）

1. scope 默认全关：未勾选任何 scope 的绑定，**任何**出站推送都不发生。
2. 未知 scope 整笔拒（与未知 claim 同口径）。
3. 定向分享：`to` 不在双向好友表 ⇒ 回执 `unknown_target`，**不新建会话**。
4. 定向分享：面板仍出现、目标预填，**未点发送则一条都不发**。
5. 事件元事件载荷里**没有** `content` 字段（形状断言，不是「值恰好为空」）。
6. 好友同步载荷里**没有**公钥字段。
7. 幂等：同一 `updated_at` 重复推 ⇒ RP 能合并（判据在 mock 侧）。
8. 同源：端点非 HTTPS 或跨域 ⇒ 拒（复用既有 metadata 校验判据）。
9. 撤销绑定后 ⇒ 推送立刻停止（判据：撤销后不再有出站请求）。
10. 缺 `*_endpoint` 的 RP ⇒ 行为与旧 RP 完全一致（不做 ≠ 失败）。

## 9. 相关文件

- 活契约：[`external-auth-integration-contract-2026-11-14.md`](external-auth-integration-contract-2026-11-14.md)
- 接入指南（给 RP 方）：[`external-integration-guide-2026-11-14.md`](external-integration-guide-2026-11-14.md)
- RP mock（契约演示）：`scripts/device-auth-rp-mock.mjs`
- 登录协议核心：`src-tauri/src/device_auth.rs`
- 分享协议核心：`src-tauri/src/share.rs`
