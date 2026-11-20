# 开放接口设计：好友同步 / 定向分享 / 事件交付（2026-11-15）

> 状态：**设计稿，裁决已下，待实现**。用户 2026-11-15 提出四项诉求（见 §1），
> 同日裁决四条（见 §6），本文按裁决改成最终口径。
> ⚠️ 本设计**跨过了 Frozen Core 的好友 / 消息边界**，**已获用户显式授权**（裁决范围见 §6）。
>
> **2026-11-17 更新**：两处口径随用户新决定变化 —— ① 端点从「必须 HTTPS 同源」
> 改为「**与 issuer 同协议同源**」（issuer 是 http 时端点也可是 http，便于 `http://IP:端口`
> 接入）；② 确认页从「默认全关逐项勾选」改为「**请求项默认全勾、一键允许**」，
> 但交付集合仍是「请求 ∩ 实际勾选 ∩ allowlist」，用户可逐项取消。

## 0. 结论

| 诉求 | 结论 | 关键限制 |
|---|---|---|
| 电脑端快捷登录 | ✅ **已有**（device auth） | 见接入指南 §1，本文不重复 |
| 好友列表给第三方页面 | ✅ 做，**按需交付** | 只放行 `friends.read`；**无后台推送** |
| 群列表给第三方页面 | ✅ 做（2026-11-15 用户裁决「群列表 要开」） | 放行 `groups.read`（id / 名称 / 人数，**无成员明细**） |
| 页面上一键分享到本机聊天框 | ✅ 做，**仍需用户点确认** | 目标必须在双向好友表内，否则 fail-closed |
| 页面收消息 / 通知类事件 | ✅ 做，**只做元数据** | **正文不外送**（与 E2EE 定位冲突） |

## 1. 需求复述与现状盘点

用户诉求（2026-11-15 原话要点）：

1. 让第三方应用接入，在**电脑端**支持快捷登录。
2. 接入后能**同步好友列表**。
3. 能在第三方页面上分享，**直接落到本机聊天框**（群与单聊都行）。
4. 第三方页面能收到**消息 / 通知类事件**（只要用户对上）。

现状（读活代码）：

| 能力 | 现状 | 位置 |
|---|---|---|
| 快捷登录 | ✅ 已实现（device auth：深链 → 用户确认 → 绑定 → JWS 断言 → 决策回写） | `src-tauri/src/device_auth.rs`、`commands/device_auth.rs` |
| 分享到会话 | ✅ 已实现：RP 触发 → 面板勾选 → 显式发送；可选回执 | `src-tauri/src/share.rs`、`commands/external_share.rs` |
| 好友列表 | 内部命令已有（`get_friends`），**没有对外通道**（仅 `sync` scope 交付 device_id+昵称） | `src-tauri/src/commands/friends.rs` |
| 定向分享（指定目标） | ✅ 已实现（深链 `to` + `to_kind` 预选，目标不存在整笔拒） | `src-tauri/src/share.rs` |
| 分享回执 | ✅ 已实现（可选，深链带 `receipt=` + 同源 `origin`；回执体见 §4.2） | `commands/external_share.rs` |

> 2026-11-20 更正：本表旧版写「无回执 / 定向分享 ❌ / 分享回执 ❌」是**实现前快照**，与 §4.2「已实现」自相矛盾；现已按实现更正。
| 消息事件外送 | ❌ 无（`message-received` 只 emit 到本机前端） | `src-tauri/src/state.rs` |

## 2. 通道模型（先定这个，否则后面全是空谈）

**硬约束**：Gosslan 跑在用户本机（LAN / BLE mesh），第三方 RP 跑在公网。
⇒ **RP 无法主动连到 Gosslan**（没有入站通道，Gosslan 没有公网地址）。

但 device auth 已经证明**出站可用**：决策回写是 Gosslan 主动 `POST` 到 RP 的
`decision_endpoint`（接入指南 §1.5）。所以本设计只允许两种通道：

| 代号 | 通道 | 用途 | 先例 |
|---|---|---|---|
| **T1** | Gosslan → RP 的 HTTPS 端点（出站 POST） | 决策回写（**携带交付数据**）、分享回执 | 决策回写（已有） |
| **T2** | RP 页面 → 深链唤起 Gosslan → 用户确认 → 结果经 T1 带回 | 发起交付申请、定向分享 | device auth（已有） |

**T3（RP 轮询 Gosslan）不成立** —— RP 连不到本机。
**常驻后台推送也不做**（裁决 1）—— 那意味着即使应用闲置也在向外发数据。

⇒ 结论：**一切交付都是「用户当场触发的一次性出站」**。

所有新增端点沿用 device auth 的既有规矩：**与 `issuer` 同协议同源**
（2026-11-17 起支持 http，跨协议/跨域仍拒），
空串 = 该 RP 未提供 = 不做（不是失败）。幂等键沿用 `revoke_idempotency_key`
的同款确定性派生（不落库、跨重试恒定）。

## 3. 授权模型：claim 与 scope 是两件事

现有 `ALLOWED_CLAIMS = [device_subject, device_public_key, nickname]` 管的是
**「这条断言里带什么」**（登录凭据的面），不放行任何读取本机数据的权限。

本设计引入**第二层：`scope`**（这个应用**这一次**被允许交付什么）。
**裁决后的 scope 有三项**（前两项 2026-11-15 首版，`groups.read` 同日追加）：

| scope | 含义 | 交付内容 |
|---|---|---|
| `friends.read` | 读好友列表 | `device_id` + 昵称 + 在线态 |
| `events.metadata` | 读消息**元事件** | 谁 / 何时 / 哪个会话 / 什么类型（**无正文**） |
| `groups.read` | 读群列表 | `group_id` + 群名 + 成员数（**无成员明细、无群密钥**） |

**不做**（裁决 1、2、3）：`chat.send`（免确认直发）、`events.content`（正文外送）、
`groups.members`（群成员明细 —— 成员集合基本是好友集合的子集，已由 `friends.read`
单独授权，再给一遍就是「一个 scope 偷渡另一个 scope 的内容」）。
**不做的 scope 不出现在 allowlist 里** ——
未知 scope **整笔拒**（与未知 claim 同口径），不静默忽略。

规则：

1. **2026-11-17 起默认全勾、一键允许**：请求的 scope 在确认页默认全选，
   用户点一次「允许」即完成；页面明列将同步什么，仍可逐项取消。
   RP 声明要什么会在页面上明示，用户看得见（不是暗中授权）。
2. scope 写在事务的 `requested_scopes` 里（与 `requested_claims` 并列）。
3. **scope 只对本次事务有效**：交付完成后即失效，**不落库、不持久化**。
   ⇒ 重启后要再交付一次，重新走一遍确认。**这是裁决 1「不做后台推送」的直接后果**，
   也让本设计**完全不碰 SQLite 表 schema**（Frozen Core）。
4. 授权以 **pairwise subject** 为界：同一个 RP 在不同 RP 侧互不可见；
   撤销一个 RP 的授权不影响另一个。

> **既有 `scopes` 列的说明**：`rp_device_bindings.scopes` 存的是 `requested_claims`
> （历史命名，不是本设计的 scope）。本设计**不改该列语义、不加列**。

## 4. 三组接口契约

### 4.1 好友与事件交付（T1 + T2，走 device auth 事务）

- RP 申请一个 `action=sync` 的事务，`requested_scopes` 列出要什么。
- 用户在确认页看到「这个应用想要：好友列表 / 消息元事件」，逐项可拒绝。
- 批准 ⇒ **决策回写**（`POST <decision_endpoint>`）的 body **附带可选 `data` 字段**：

```json
{ "decision": "approve", "key_id": "…", "public_key": "…", "device_subject": "…",
  "claims": { … },
  "data": {
    "subject": "<pairwise subject>",
    "friends": [ { "device_id": "…", "nickname": "…", "online": true } ],
    "events": [ { "conv_id": "…", "sender_id": "…", "kind": "text", "ts": 1731600000000, "seq": 42 } ]
  } }
```

- `data` 的键**按请求的 scope 决定**：没请求 `friends.read` 就**没有 `friends` 键**
  （形状断言，不是「值恰好为空」）。
- **不含**：对端公钥、消息正文、群成员名单。
- 幂等：同一 `Idempotency-Key` 的重放必须被 RP 合并（数据也幂等）。
- 失败：出站失败只记日志并上报 `rp_notified=false`（与既有语义一致），**不重试到天荒地老**。

### 4.2 定向分享（T2 + T1 回执）—— **已实现**

- 深链加两个参数：`to`（device_id 或 `group:<群 id>`）与 `to_kind`（`peer` | `group`）。
- **面板仍然出现，但目标被预勾并高亮，用户点「发送」才算**（裁决 2）。
  - 预勾 ≠ 自动发送：按钮的启用条件仍然要求 `selected` 非空，用户点「发送」才真的发。
  - 理由：若允许 RP 指定目标后**静默直发**，任意网页都能往用户聊天框注入内容。
- **目标解析必须 fail-closed**：
  - `to_kind=peer` ⇒ `to` 必须在**好友表**里；否则整笔拒（`EXTERNAL_SHARE_BAD_TARGET`），**不猜**。
  - `to_kind=group` ⇒ `to` 必须是本机已知的群 id（`group:<id>` 形态，判定时剥前缀）。
  - 匹配不到就报「目标不存在」，**绝不新建会话、绝不广播**。
  - **例外**：目标好友**还没聊过**（库里没有会话行）⇒ 客户端先建一个**空会话**（不发任何消息），
    否则面板列不出这个目标，「一键发给他」就无从谈起。
- 回执：深链可选 `receipt=`（必须与 `origin` 同协议同源，2026-11-20 起无 `origin` 的回执整笔拒）⇒
  发送完成后 POST `{ share_id, status: "sent" | "partial" | "failed", sent, failed }`。
  （旧文写的 `share_receipt_endpoint` 是死字段、body 含 `subject`/`targets` 均已过时，以 §2.7 接入指南为准。）
- 群与单聊**同一条路径**：都走既有发送通道（乐观上屏 / 台账 / 失败态），不改消息语义。

### 4.2.1 群列表（2026-11-15 已开放）

首版只放行 `friends.read` ⇒ RP 拿不到群列表，也就拿不到 `group:<群 id>`。
**2026-11-15 用户裁决「群列表 要开」** ⇒ 新增 `groups.read`：
交付 `group_id` / 群名 / 成员数，**不含成员明细**（见 §3 的 scope 表）。
连带后果：§2.7 的定向分享现在能由 RP 自己定位群（`groups[].group_id` ⇒ `group:<群 id>`），
不用再让用户在面板里手选。
因此「一键发到某个群」这条路径，RP 只能在自己已经知道群 id 的前提下用；
否则就让用户在面板里自己选群（**群分享能力本身没丢**，只是不能由 RP 自动定位）。

要补齐这一条，需要再放开 `groups.read`（群 id + 名称 + 成员数）——那是**另一次裁决**。

### 4.3 好友列表在页面上的用途（与 §4.1 的衔接）

RP 拿到的 `device_id` 是**对端设备 id**。RP 把它放进 `to` 回传时，
Gosslan 侧用**双向好友表**匹配（§4.2）。

- 不做「pairwise 化好友 id」—— 那会让 RP 拿到的 id 无法回传，等于自废 §4.2。
- 代价：RP 看到的是**设备 id**，可跨 RP 关联同一个好友（跨 RP 关联本来就是 P2P 的既有暴露面，
  不是本设计新增的）。本设计不扩大它，也不承诺隐藏。

## 5. 复用与「不改」清单

**复用**：metadata 同源校验、pairwise subject、幂等键派生、事务与确认页机制、
决策回写通道、既有发送通道（§4.2）。

**不改（Frozen Core）**：`msg_id` / E2EE / Outbox / Ack / **SQLite 表 schema** / 好友 /
文件 / 通知 / Chat UI。

**为什么能完全不碰 schema**：scope 只对单次事务有效（§3 规则 3）⇒ 无需持久化授权关系；
事件元数据从已有消息记录里现读，不建新表。

## 6. 用户裁决（2026-11-15，四条全部采纳建议）

| # | 裁决 | 落在本文哪 |
|---|---|---|
| 1 | **只放行 `friends.read`；不做后台推送，改成用户打开应用时同步** | §3 scope 表（只两项）、§4.1（一次性交付）、§5（无持久化） |
| 2 | **定向分享不能免确认直发** | §4.2（预填但仍需点发送） |
| 3 | **只做元数据，正文留在本机** | §3（无 `events.content`）、§4.1（events 载荷无正文字段） |
| 4 | **「消息同步」＝在第三方页面显示，不是注入本机聊天历史** | §4.1（RP 侧显示）；注入本机历史碰 msg_id / Outbox / Ack，**不做** |

## 7. 实现顺序

1. **协议核心**（跨平台纯逻辑，可单测）：
   `ALLOWED_SCOPES`（三项）、`supported_actions` 加 `sync`、`RpRequest.requested_scopes`、
   `RpMetadata.share_receipt_endpoint`（可选，HTTPS 同源）、
   `validate_request` 对 scope 的整笔拒、`validate_metadata` 对新端点的同源校验、
   `DeviceAuthPrompt.requested_scopes`（前端要列出来）。
2. **交付编排**：`action=sync` 批准后组装 `data` 并随决策回写发出；
   只带被请求的 scope 对应的键。
3. **定向分享**：深链 `to` / `to_kind` + 目标 fail-closed 解析 + 回执。
4. **前端**：确认页逐项列出 scope（**2026-11-17 起请求项默认全勾、一键允许，可逐项取消**）；分享面板目标预填高亮。
5. **mock 与判据**：mock 加 `sync` 动作与新端点；跨语言契约对账 + 非空转自证。

每一步都要有：跨语言契约对账判据（Rust ↔ mock ↔ 前端）、非空转自证、
错误码双向对账、文档同批同步。

## 8. 验收判据

1. scope **默认全勾（2026-11-17 起）**：用户可逐项取消；全部取消的事务**交付数据为空**（`data` 里没有对应键）。
2. 未知 scope 整笔拒（与未知 claim 同口径）。
3. 决策回写体里**没有** `content` 字段（事件元数据形状断言）。
4. 好友交付载荷里**没有**公钥字段。
5. 定向分享：`to` 不在双向好友表 ⇒ 整笔拒 `EXTERNAL_SHARE_BAD_TARGET`，面板不出现、**不新建会话**（旧文"回执 unknown_target"已过时，实际上没有这种回执状态）。
6. 定向分享：面板仍出现、目标预填，**未点发送则一条都不发**。
7. 同源：新端点非 HTTPS 或跨域 ⇒ 拒（复用既有 metadata 校验判据）。
8. 撤销绑定后 ⇒ 后续 sync 事务被拒。
9. 缺 `share_receipt_endpoint` 的 RP ⇒ 分享行为与旧 RP 完全一致（不做 ≠ 失败）。
10. scope **不落库**：绑定行内容在一次交付前后完全相同（不碰 schema 的证据）。

## 9. 相关文件

- 活契约：[`external-auth-integration-contract-2026-11-14.md`](external-auth-integration-contract-2026-11-14.md)
- 接入指南（给 RP 方）：[`external-integration-guide-2026-11-14.md`](external-integration-guide-2026-11-14.md)
- RP mock（契约演示）：`scripts/device-auth-rp-mock.mjs`
- 登录协议核心：`src-tauri/src/device_auth.rs`
- 分享协议核心：`src-tauri/src/share.rs`
