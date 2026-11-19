# 群机器人的群管理能力（2026-11-17）

> ⚠️ **后续变更（以此为准）**：本文是 2026-11-17 首版快照。此后两轮改动：
> ① 2026-11-18 机器人已在 UI 层混排进群成员列表（成员面板可见），正文改用持久标记
> `bot:<botId>#<eventId>` 归因，不再带名字前缀；
> ② **2026-11-19 机器人派任务**：机器人发的任务指派人固定为 `bot:<botId>`（默认必选、
> 不可取消，前后端都强制），真人发的任务全体群成员可编辑/认领。绑定键/校验见
> `src-tauri/src/commands/group_files.rs` 的 `BOT_ASSIGNEE_PREFIX` / `check_bot_assignee`
> / `bot_assignee_locked_violation`，前端判据在 `src/utils/todos.ts`。
>
> 用户诉求：群机器人有权限在群里添加任务等群管理操作 ——
> 「除了危险操作，其他管理员能操作的他都能操作」；第三方通过 Webhook 正文指令触发；
> 以机器人代发（网关设备身份 + 来源前缀），不动线格式。

## 1. 触发方式（一条 curl）

第三方在通知 JSON 里带 `action`：

```bash
curl "http://host:59994/publish/<send_token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "CI 发现 3 个失败用例",
    "action": {
      "type": "create_todo",
      "title": "修复失败用例",
      "assignees": []
    }
  }'
```

公告：
```json
{ "text": "服务器今晚 23:00 维护", "action": { "type": "announcement" } }
```

- 没有 `action` ⇒ 普通通知（沿用现有投递）。
- `action` 只在 **scope=group** 的机器人上生效；个人机器人带 `action` ⇒ 忽略（不报错，避免外部误用把通知搞丢）。

## 2. 允许的 action（管理员级，排除危险操作）

| type | 效果 | 复用既有命令 |
|---|---|---|
| `create_todo` | 在群里建任务（title/assignees/description 可选） | `send_group_todo` |
| `announcement` | 把 `text` 作为群公告发 | `send_group_announcement` |

**明确不允许**（危险操作，Webhook 一律忽略/拒绝）：
`remove_member` / `add_member` / `appoint_admin` / `remove_admin` /
`transfer_owner` / `rename_group` / `dissolve_group` / `pin_message` 等。
⇒ 白名单制：只有上表两个 type 生效，其它一律当普通通知（不执行、不报错），
防止第三方通过构造 action 触达危险路径。

## 3. 身份与线格式

- 任务/公告以**网关设备身份**发（调用既有命令，权限走 `is_manager`），
  正文带 `【机器人名】` 前缀 ⇒ 群里显示为「本机代投递」；
- **线格式不动**（Frozen Core）：不加新的消息 kind、不加结构化元数据；
- 机器人不是群成员，不出现在成员列表。

## 4. 权限来源

群机器人创建时已校验「群主/管理员」（`bot_create` 里的 `is_manager` 等价判定）。
执行 action 时**再校验一次**：
- 机器人记录的 `scope == "group"` 且 `target.group_id` 与 action 目标一致；
- 本机仍在该群且仍是管理员（权限被撤后不再执行）。
⇒ 双重校验，撤销权限后立即失效。

## 5. 失败与兜底

- action 执行失败（群被删/权限撤销/参数非法）⇒ 记 `last_error`，**仍 ACK** 该事件
  （避免无限重投；错误信息在机器人详情可见）；
- `create_todo` 缺 title ⇒ 回落用 `text` 前 60 字作为标题（不让通知变任务时丢内容）；
- 一次通知只执行**一个** action，不支持批量/链式。

## 6. 判据

- 服务端：`action` 字段透传（只当 JSON 字段，不解析）。
- 客户端：白名单（`create_todo` / `announcement` 两个）、危险操作不执行、
  scope=group 才生效、双重权限校验、失败写 last_error、线格式不动。
- 端到端：curl 带 action → 群里出现任务/公告（带机器人前缀）。

## 7. 明确不做的

- 不给机器人独立设备身份（Frozen Core 不动）；
- 不开踢人/任免/转让/解散等危险操作（白名单外）；
- 不支持任务更新/删除（首版只建）。
