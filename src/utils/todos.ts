/**
 * 群任务的**折叠**（纯函数，便于单测）。
 *
 * 任务在协议层由**两层独立事件**组成（见 `protocol::TodoPayload` 的说明）：
 *
 * | 层 | kind | 合并规则 | 谁写 |
 * |---|---|---|---|
 * | 定义 | `todo` | LWW per `todo_id`，版本 `(seq, msg_id)` | 任意成员创建 |
 * | 完成 | `todo_done` | **LWW per `(todo_id, actor)`** | 每人只写自己那一格 |
 *
 * **为什么不能合成一层**：朴素做法是一个 `{..., done_by[]}` 寄存器，
 * A 和 B 同时勾完成时后到的整体覆盖前者 —— B 的勾被吞掉（经典丢更新）。
 * 拆成"每人一格"后不存在这个问题，且 `done: false`（取消勾选）天然支持。
 */
import type { MessageRecord } from "@/types";

export interface TodoItem {
  todoId: string;
  title: string;
  assignees: string[];
  dueTs: number;
  creator: string;
  /** 已勾选的成员 */
  doneBy: string[];
  /** 我勾了吗（决定复选框状态） */
  mine: boolean;
}

interface TodoDef {
  todoId: string;
  title: string;
  assignees: string[];
  dueTs: number;
  creator: string;
  deleted: boolean;
  seq: number;
  msgId: string;
}

/** 版本序比较：**(seq, msg_id) 元组**。只看 seq 会让不同副本算出不同结果
 *  （seq 是 Lamport 时钟，两端离线后各发一条都可能拿到同一个 seq）。 */
function newer(seq: number, msgId: string, cur: { seq: number; msgId: string } | undefined): boolean {
  return !cur || seq > cur.seq || (seq === cur.seq && msgId > cur.msgId);
}

export function parseTodo(rec: MessageRecord): TodoDef | null {
  if (rec.kind !== "todo") return null;
  try {
    const p = JSON.parse(rec.content) as Record<string, unknown>;
    if (typeof p.todo_id !== "string" || !p.todo_id) return null;
    return {
      todoId: p.todo_id,
      title: typeof p.title === "string" ? p.title : "",
      assignees: Array.isArray(p.assignees) ? (p.assignees as string[]) : [],
      dueTs: typeof p.due_ts === "number" ? p.due_ts : 0,
      creator: typeof p.creator === "string" ? p.creator : "",
      deleted: p.deleted === true,
      seq: rec.seq,
      msgId: rec.msg_id,
    };
  } catch {
    return null;
  }
}

export function parseTodoDone(rec: MessageRecord): { todoId: string; done: boolean } | null {
  if (rec.kind !== "todo_done") return null;
  try {
    const p = JSON.parse(rec.content) as Record<string, unknown>;
    if (typeof p.todo_id !== "string" || !p.todo_id) return null;
    if (typeof p.done !== "boolean") return null;
    return { todoId: p.todo_id, done: p.done };
  } catch {
    return null;
  }
}

/** 折叠出当前全部任务（已删除的不列），按创建版本从新到旧。 */
export function foldTodos(records: MessageRecord[], myDeviceId: string): TodoItem[] {
  const defs = new Map<string, TodoDef>();
  for (const rec of records) {
    const d = parseTodo(rec);
    if (!d) continue;
    if (newer(d.seq, d.msgId, defs.get(d.todoId))) defs.set(d.todoId, d);
  }

  // 完成层：`(todoId, actor)` → 最新一条
  const done = new Map<string, { done: boolean; seq: number; msgId: string }>();
  for (const rec of records) {
    const p = parseTodoDone(rec);
    if (!p) continue;
    const key = `${p.todoId} ${rec.sender_id}`;
    const cur = done.get(key);
    if (newer(rec.seq, rec.msg_id, cur)) {
      done.set(key, { done: p.done, seq: rec.seq, msgId: rec.msg_id });
    }
  }

  const out: TodoItem[] = [];
  for (const d of defs.values()) {
    if (d.deleted) continue;
    const doneBy: string[] = [];
    for (const [key, v] of done) {
      if (!v.done) continue;
      const [tid, actor] = key.split(" ");
      if (tid === d.todoId) doneBy.push(actor);
    }
    out.push({
      todoId: d.todoId,
      title: d.title,
      assignees: d.assignees,
      dueTs: d.dueTs,
      creator: d.creator,
      doneBy: doneBy.sort(),
      mine: doneBy.includes(myDeviceId),
    });
  }
  return out.sort((a, b) => (a.todoId < b.todoId ? 1 : -1));
}
