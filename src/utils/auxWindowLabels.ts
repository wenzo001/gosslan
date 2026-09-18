/**
 * 独立窗口 label 的构造 / 解析（群任务窗口）。
 *
 * 群任务窗口是**每群一个**（label = `todo-<groupId>`），窗口启动时靠**自己的 label**
 * 找回"我是哪个群的窗口"。label 在这里只是窗口的**身份/参数**，不是"按 label 分支渲染"——
 * 每个窗口仍然只有一份文档（`todos.html` + `src/entries/todos.ts`，ADR-0018）。
 *
 * ⚠️ 前缀必须与 Rust `lib.rs` 的 `WINDOW_GROUP_TODOS_PREFIX` 完全一致
 * （Rust 侧有一条守卫 `group_todos_window_label_derives_from_group_id` 做交叉核对）。
 */

/** 群任务窗口 label 前缀（= Rust `WINDOW_GROUP_TODOS_PREFIX`）。
 *  `as const` 是为了让它的类型是字面量 `"todo-"` —— `useWindowLauncher` 的
 *  `AuxWindowLabel` 联合类型依赖它推出 `` `todo-${string}` ``。 */
export const GROUP_TODOS_LABEL_PREFIX = "todo-" as const;

/** 由群 ID 构造窗口 label（返回模板字面量类型，供 `useWindowLauncher` 的联合类型收窄）。 */
export function groupTodosLabel(groupId: string): `${typeof GROUP_TODOS_LABEL_PREFIX}${string}` {
  return `${GROUP_TODOS_LABEL_PREFIX}${groupId}`;
}

/**
 * 从窗口 label 解析群 ID。
 *
 * 前缀不符、或 ID 含非法字符（Rust 侧同样只接受 `[A-Za-z0-9_-]`，且长度 ≤40）→ `null`。
 * 返回 `null` 时窗口应显示明确的错误态，而不是拿一个脏 ID 去查数据。
 */
export function groupTodosGroupId(label: string): string | null {
  if (!label.startsWith(GROUP_TODOS_LABEL_PREFIX)) return null;
  const id = label.slice(GROUP_TODOS_LABEL_PREFIX.length);
  if (!id || id.length > 40) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}
