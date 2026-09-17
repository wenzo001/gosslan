/**
 * 群任务的**折叠**（纯函数，便于单测）。
 *
 * 一条任务 = 定义层里的一个 **LWW 寄存器**：`kind = "todo"`，按 `todo_id` 合并，
 * 版本 = `(seq, msg_id)`。改标题 / 换指派人 / 改状态 / 删除都是"重新发一份定义"，
 * 所以折叠只需要"同 `todo_id` 取最新那一份"。
 *
 * **状态是任务级的单值**（用户 2026-09-16 定的四态：待办 / 进行中 / 延期 / 完成，
 * 手动选、不做截止时间）—— 不是"每人各自一格完成"。
 * 为什么单值用 LWW 就够：一条任务"当前处于什么阶段"本来就是单值语义，并发改动时后写者胜
 * 是期望行为（看板类工具都这样）；真正会丢更新的模型是"每人一格的完成标记"，而这里不做它。
 *
 * 授权口径与后端 `commands::may_update_todo` **必须一致**（后端是权威、这里是显示用的镜像）：
 * 改状态 = 创建者或被指派人；改标题/指派人/删除 = 创建者或群主。两边都有各自的用例表。
 */
import type { MessageRecord } from "@/types";

/**
 * 任务状态取值 —— **与 Rust `protocol::TODO_STATUSES` 必须一致**，
 * 由 `messageKinds.test.ts` 读 `protocol.rs` 逐项比对（与 `WIRE_KINDS` 同一套跨语言契约）。
 */
export const TODO_STATUSES = ["todo", "doing", "overdue", "done"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 新建任务的缺省状态（与 Rust `default_todo_status()` 同值）。 */
export const TODO_STATUS_DEFAULT: TodoStatus = "todo";

/**
 * 状态 → i18n key。放在这里而不是各面板里各写一份：任务状态在**两个**地方出现
 * （群任务面板、群成员面板的任务分区），两处各写一份就会漂移
 * （典型症状：一个面板写「进行中」、另一个写「处理中」）。
 */
export const TODO_STATUS_LABEL_KEY: Record<TodoStatus, string> = {
  todo: "todo.status.todo",
  doing: "todo.status.doing",
  overdue: "todo.status.overdue",
  done: "todo.status.done",
};

/** 状态 → 文字颜色。彩色**文字**一律走 `*-ink` 档（设计规范 §3.1 的硬约束）。 */
export const TODO_STATUS_CLASS: Record<TodoStatus, string> = {
  todo: "text-[var(--gosslan-text-2)]",
  doing: "text-[var(--gosslan-primary)]",
  overdue: "text-[var(--gosslan-danger-ink)]",
  done: "text-[var(--gosslan-success-ink)]",
};

export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && (TODO_STATUSES as readonly string[]).includes(v);
}

export interface TodoItem {
  todoId: string;
  title: string;
  assignees: string[];
  status: TodoStatus;
  creator: string;
}

interface TodoDef extends TodoItem {
  deleted: boolean;
  seq: number;
  msgId: string;
}

/** 版本序比较：**(seq, msg_id) 元组**。只看 seq 会让不同副本算出不同结果
 *  （seq 是 Lamport 时钟，两端离线后各发一条都可能拿到同一个 seq）。
 *  ⚠️ 与 Rust `commands::latest_todo_def` 的 `ORDER BY seq DESC, msg_id DESC` 同规则。 */
function newer(seq: number, msgId: string, cur: { seq: number; msgId: string } | undefined): boolean {
  return !cur || seq > cur.seq || (seq === cur.seq && msgId > cur.msgId);
}

export function parseTodo(rec: MessageRecord): TodoDef | null {
  // 两种 kind 同构：`todo` = 创建（Card，会通知），`todo_update` = 改状态/改标题/删除
  // （Silent，不打扰全群）。它们同属一条 LWW 序列，所以折叠时一视同仁。
  if (rec.kind !== "todo" && rec.kind !== "todo_update") return null;
  try {
    const p = JSON.parse(rec.content) as Record<string, unknown>;
    if (typeof p.todo_id !== "string" || !p.todo_id) return null;
    return {
      todoId: p.todo_id,
      title: typeof p.title === "string" ? p.title : "",
      assignees: Array.isArray(p.assignees)
        ? p.assignees.filter((x): x is string => typeof x === "string")
        : [],
      // 未知/缺失状态一律回落「待办」：宁可显示成一条待办，也不要让这条任务从列表里消失
      status: isTodoStatus(p.status) ? p.status : TODO_STATUS_DEFAULT,
      creator: typeof p.creator === "string" ? p.creator : "",
      deleted: p.deleted === true,
      seq: rec.seq,
      msgId: rec.msg_id,
    };
  } catch {
    return null;
  }
}

/** 折叠出当前全部任务（墓碑不列），按**创建版本从新到旧**。 */
export function foldTodos(records: MessageRecord[]): TodoItem[] {
  const defs = new Map<string, TodoDef>();
  for (const rec of records) {
    const d = parseTodo(rec);
    if (!d) continue;
    if (newer(d.seq, d.msgId, defs.get(d.todoId))) defs.set(d.todoId, d);
  }
  return [...defs.values()]
    .filter((d) => !d.deleted)
    .sort((a, b) => {
      if (a.seq !== b.seq) return b.seq - a.seq; // 新的在前
      return a.msgId < b.msgId ? 1 : -1; // 同 seq 按 msg_id 比（与 newer 同规则）
    })
    .map(({ todoId, title, assignees, status, creator }) => ({
      todoId,
      title,
      assignees,
      status,
      creator,
    }));
}

/**
 * 我能不能改这条任务（**显示用**的镜像，后端 `commands::may_update_todo` 才是权威）。
 *
 * `structural` = 改标题 / 换指派人 / 删除；false = 只改状态。
 * 判据与后端一致：创建者什么都能改；被指派人只能改状态；群主能改结构（但改状态要另算）。
 */
export function canUpdateTodo(
  item: Pick<TodoItem, "creator" | "assignees">,
  actor: string,
  groupCreator: string,
  structural: boolean,
): boolean {
  if (item.creator === actor) return true;
  if (structural) return groupCreator === actor;
  return item.assignees.includes(actor);
}
