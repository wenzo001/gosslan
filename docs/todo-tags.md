# 群任务标签（todo tags）

> 2026-11-05 新增。本文只记录**语义与边界**，实现细节以代码为准：
> - Rust 协议/校验：`src-tauri/src/protocol.rs`（`TODO_TAG_MAX_LEN` / `TODO_MAX_TAGS` / `normalize_todo_tags`）
> - Rust 表与读写：`src-tauri/src/db/todo_tags.rs`
> - 迁移：`src-tauri/src/db.rs`（`DB_VERSION = 17`，v16→v17 回填历史消息里的 `tags`）
> - 前端解析/携带：`src/utils/todos.ts`（`normalizeTodoTags` / `carryAbsentTodoFields`）
> - 控件：`src/components/TodoAttrField.vue`（外壳）、`TodoAttrDateField.vue`、`TodoAttrTypeField.vue`、`TodoAttrTagsField.vue`

## 数据模型

任务标签的**权威**仍在消息载荷里：群任务定义是 `messages.content` 的 JSON（`kind = todo` / `todo_update`），
`tags` 是 `string[]`。本地两张表只是索引与候选池：

| 表 | 主键 | 作用 |
| --- | --- | --- |
| `todo_task_tags(group_id, todo_id, tag, updated_at)` | `(todo_id, tag)` | 当前任务挂了哪些标签。主键即**唯一约束**：同一任务同一标签不可能出现两行。 |
| `todo_tag_pool(group_id, tag, use_count, last_used_at)` | `(group_id, tag)` | 历史候选池，供下拉复用。按 `use_count DESC, last_used_at DESC, tag` 排序。 |

同步入口只有一处：`insert_message_if_new` 落库后调用 `sync_todo_tags_from_message`。
本地发送、Gossip 收包、历史回放都走这条路径，避免某个入口漏同步。

## 删除语义

- 从任务上移除某个标签 = **只删 `todo_task_tags` 里的那一行**，`todo_tag_pool` 不动。
  下次编辑同一个任务时它仍会出现在历史候选中。
- 删除整个任务（`deleted = true`）同理：只清关联，不删候选池。
- 任务被重新打开/回滚时，按消息里的 `tags` 重新建立关联（LWW 折叠口径不变）。

## 候选池清理阈值

`TODO_TAG_POOL_RETENTION_DAYS = 90`（`src-tauri/src/db/todo_tags.rs`）。

- 90 天按 `last_used_at` 算，不是 `use_count`：一个用了 50 次但最近一次是 100 天前的标签也会被清。
  理由：候选池是"最近怎么用过"的快捷入口，不是统计报表；保留一个半年没碰的标签只会把下拉变脏。
- 清理发生在**读取候选时**（`list_todo_tag_candidates`），不做后台定时任务：
  少一个常驻调度器、少一类"应用没开所以没清"的口径分叉。
- 若未来要改阈值，只改这一个常量；文档与测试引用同一常量，不另抄数字。

## 上限

- 单个标签 20 字符（`TODO_TAG_MAX_LEN`），按 Unicode 码点计数。
- 单个任务最多 10 个标签（`TODO_MAX_TAGS`）。
- 超长/空串/重复（首次出现保留）在**协议层归一**：Rust `normalize_todo_tags` 与前端
  `normalizeTodoTags` 是同一份口径；命令层再校验一次，DB 主键兜底。
- **大小写不敏感**：入库比较与候选匹配一律按 `to_lowercase()` 判等，`Bug` 与 `bug` 是同一枚；
  显示与落库保留**首次输入时的写法**（后来的 `bug` 命中已有的 `Bug`，不新建重复候选）。
  候选池里改造前可能并存的大小写变体，在读取候选时合并成最早插入那一行
  （`use_count` 求和、`last_used_at` 取最大）。

## 兼容性（老版本 / 老数据）

- **老版本收到未知字段**：`tags` 只是 JSON 里多出来的键。老端不读它，标题/描述/状态等
  解析不受影响；不会崩，也不会把标签当标题（`parseTodo` 只按白名单取字段）。
- **新端读老任务缺 `tags`**：按空数组处理（`parseTodo` 里 `!Array.isArray(p.tags)` ⇒ `[]`）。
- **部分更新（只改一格）**：键不存在 = "没说"，沿用旧值；显式 `[]` = 明确清空。
  前后端共用这一口径（`carryAbsentTodoFields` / `latest_todo_def` 的 `carry_tags`）。
  只改关联时间、只改标签都走同一个 `todo_update` 消息，其余字段原样携带。

## 权限

- 关联时间 / 任务类型 / 任务标签：**任何群成员随时可改**，不需要进编辑态
  （后端 `MemberLane::attributes_only` 这一条窄档；前端 `canEditAttributes` 只决定给不给控件）。
- 终态（延期 / 做不了 / 完成）、归档、删除、指派人的门控**不变**。
- 每次属性更新仍是一条 `todo_update` 消息，走原有同步协议（无新消息类型）。
