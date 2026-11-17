# 通知机器人 v6 重构方案（2026-11-16）

> **状态（2026-11-17）：v6 已实施**，对应版本 **6.0.0**。接入指南见
> `docs/notes/webhook-bot-integration-guide-2026-11-16.md`。
>
> 用户诉求：机器人要像**联系人**一样在通讯录/会话里；个人 bot 从「加好友」入口创建，
> 群 bot 从群成员面板由**群主/管理员**添加；创建时顺便配好全部（含中转地址与密钥），
> 点机器人详情可看配置/密钥/删除；设置里不再堆机器人配置；服务端配合做到
> 「配好就能发」；支持纯文本与 Markdown、长度上限、免打扰；每个用户可建自己的机器人；
> 写一份给外部发送方的接入文档；全部完成后发 **6.0.0**。

## 0. 产品决策（2026-11-16 已确认）

| 决策点 | 选择 | 影响 |
|---|---|---|
| 机器人身份 | **本机假身份** | 不改网络协议、不跨设备同步、其他成员看不到机器人身份 ⇒ Frozen Core 不动 |
| 群机器人作用域 | **按群配置** | 每个群各自添加/配置/删除；hook 存在该群下；仅群主/管理员可操作 |
| 服务端部署 | **沿用独立进程** | TCP 盲中继一个字不动；配置简单靠 UI 自动生成 |
| 配置入口 | **两处入口 + 详情** | 个人：加好友弹窗；群：群成员面板；详情看配置/密钥/免打扰/删除；设置里移除 BotSection |
| 个人 bot 落点 | **转成真会话** | `conv_id = bot:<bot_id>`，进会话列表；消息落 messages 表但不发网络 |
| 免打扰默认 | **关**（每条都通知） | 用户可在详情里开 |
| 版本节奏 | **一次性 6.0.0** | 全部做完验证后发一个大版本 |

## 1. Frozen Core 边界（硬约束）

**不许动**：msg_id 生成 / E2EE / Outbox / Ack / SQLite 表 schema / 好友关系 / 文件 / 通知 / Chat UI 组件本体。

机器人用的每一格都在既有结构里：

| 需求 | 落法 | 为什么安全 |
|---|---|---|
| 个人 bot 进会话列表 | `conversations` 表一行，`id = "bot:<bot_id>"`、`kind = "single"` | 会话表 schema 不变；`bot:` 前缀是本机命名空间 |
| 个人 bot 的消息 | `messages` 表：`conv_id = "bot:<id>"`、`sender_id = "bot:<id>"`、`status = "delivered"`、**不写 outbox** | 消息表 schema 不变；不进 outbox ⇒ 网络层永远看不到 ⇒ 不跨设备同步 |
| 群 bot 的消息 | 既有 `send_group_payload`，正文带 `【机器人名】` 前缀 | 群线格式一字不改；发送者仍是网关设备 |
| 机器人清单 / 配置 / 收件箱 | `settings` 表键值对 | 不动表结构 |

## 2. 数据模型

```rust
pub struct BotRecord {
    pub bot_id: String,
    pub name: String,
    pub scope: String,            // "personal" | "group"（v6 新增；取代旧 target）
    pub group_id: Option<String>, // scope=group 时必填
    pub server_url: String,       // 中转 Webhook 服务地址
    pub client_token: String,     // 取件凭证（不叫 secret；不是 E2EE 私钥）
    pub status: String,           // active | paused | revoked
    pub do_not_disturb: bool,     // v6 新增
    pub created_at: i64,
    pub last_event_at: Option<i64>,
    pub last_error: Option<String>,
    pub pending: u32,
    pub failed: u32,
}
```

**存储键**：`bot:<bot_id>`（清单）；`bot_inbox:<bot_id>`（收件箱，幂等，上限 200）。
旧版 `target: {kind, groupId}` 的记录在读取时迁移到 `scope/group_id`（`serde(default)` +
兼容函数，不写 DB 迁移）。

## 3. 服务端契约（gosslan-relay-server）

沿用 `webhook.mjs` 独立进程，**协议改动最小**：

1. **创建时服务端生成两把密钥**（现在已经是：`send_secret` / `client_secret`）⇒ UI
   不再让用户填密钥，只让用户填中转地址（或选预设）⇒「配置简单」。
2. `target` 扩展为 `{ kind: "personal" | "group", group_id?: string }`（兼容旧 inbox/group）。
3. **文本长度上限**：`WEBHOOK_MAX_TEXT_BYTES`（默认 8192 UTF-8 字节）已存在；
   **超长按字节截断**（不报错）—— 对发送方更友好（不会因超长整条丢），也不会把
   长度信息泄露给外部。Markdown 与纯文本同一把尺子。
4. `format`: `text` | `markdown`（已有）；其他值回落 text。
5. **撤销即失效**：`POST /v1/client/bots/:id/status {status:"revoked"}` ⇒ 旧 send_secret
   立刻 401（已有）。群 bot 删除走同一条。
6. 自测补：scope=personal/group、撤销后 401、Markdown 超限拒收。

**endpoint 形状不变**：`POST https://<host>/v1/hooks/<bot_id>/messages`
+ `Authorization: Bearer <send_secret>` + `Idempotency-Key`。

## 4. 客户端命令

| 命令 | 变化 |
|---|---|
| `bot_create(name, scope, group_id?, server_url, dnd?)` | :auto: 服务端注册；个人 bot 顺带建 `bot:<id>` 会话；返回一次性的 send token + endpoint + curl |
| `bot_list` | 增加 scope/group_id/dnd；可按群过滤 |
| `bot_set_status` | 暂停 / 恢复 / 撤销（撤销 = hook 立即失效 + 清 token） |
| `bot_set_dnd` | 免打扰开关 |
| `bot_delete` | 撤销 + 清本地 + 个人 bot 删会话 / 群 bot 从群解绑 |
| `bot_inbox` / `bot_pull_once` | 不变；投递分两路：个人 → messages 表 + 会话；群 → send_group_payload |

**权限**：群 bot 的 create/delete/status 命令先查 `group.admins` 或 `group.creator`
（复用 `GroupMemberPanel` 的 `isAdmin/isOwner` 口径）⇒ 非管理员一律拒，且前端不显示入口。

## 5. UI 结构

1. **加好友弹窗**（`AddFriendModal.vue`）新增「添加机器人」Tab/区块：
   - 名称 → 中转服务地址（可给默认预设）→ 创建；
   - 创建后一屏展示：endpoint / send token（一次性）/ curl 示例（可复制）。
2. **群成员面板**（`GroupMemberPanel.vue`）新增「添加机器人」（仅管理员/群主）：
   - 同样向导，scope 固定为 group + 当前 group_id。
3. **机器人详情**：点会话里的机器人头像 或 群成员列表里的机器人 ⇒ 详情页：
   - 配置（名称 / scope / 中转地址 / 状态）
   - 密钥（send token 只在创建时可见；此处可**轮换**生成新 token）
   - 免打扰开关 / 暂停 / 恢复 / 删除
4. **设置**：移除 `BotSection`，把「关于」里堆的配置拆到独立分区
   （`settingsManifest.ts` 加 `bots` 分区或并入合适的分区）—— 机器人本身不在设置里配。
5. **会话里机器人消息**：`botMessage.ts` 的 Markdown 渲染复用，接进消息气泡
   （`v-html` 落点登记 + 消毒判据）。

## 6. 状态机与边界

| 状态 | 含义 | 用户可见 |
|---|---|---|
| active | 正常收取并投递 | 会话/群里显示消息 |
| paused | 服务端拒收 | 详情显示「已暂停」；hook 返回 403 |
| revoked | 不可逆，hook 立即 401 | 会话保留历史消息但不再收新消息 |

**边界清单**：
- 文本上限：8192 UTF-8 字节（含 Markdown），超长按字节截断（不报错）；
- 图片：v6 首版仍走 `image[]` 附件（不改）；Markdown 里的远程图片不自动加载；
- 免打扰：只影响系统通知/任务栏闪烁，**不影响进会话与未读角标**；
- 群 bot 删除：只删该群的 hook，不影响其它群；个人 bot 删除：删会话 + hook 失效；
- 每个用户独立：bot 存在本机 settings，不跨设备同步，不同用户各建各的；
- 密钥可见性：send token 只在创建/轮换时显示一次；client token 永不进列表响应/日志。

## 7. 判据与验证

- Rust：权限（非管理员拒）、scope 校验、撤销即失效、不写 outbox（个人 bot 消息不上网络）、
  会话/消息落库正确、文本超限；
- 前端：两处入口存在、设置里不再有 BotSection、详情可看配置/密钥/删除、
  dnd 开关、Markdown 渲染消毒、配置流程步骤数；
- 服务端：scope 兼容、撤销 401、Markdown 超限、format 回落；
- 全量：Rust/前端/九个守门/构建/i18n；发版后盯 Gitee 镜像。

## 8. 复跑与文档

- 接入文档（给外部发送方）：本轮**新增**一份《Webhook 机器人接入指南》
  —— endpoint / 密钥 / format / 限额 / 幂等 / 状态查询 / 常见错误码 / curl 示例
  （文件名在实现时确定并登记到索引，避免引用守卫追一个还不存在的文件）。
- 本方案随 v6 实现同步更新状态。
