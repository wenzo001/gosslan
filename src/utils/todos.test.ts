import { test } from "node:test";
import assert from "node:assert/strict";
import { TODO_STATUS_DEFAULT, TODO_STATUSES, canUpdateTodo, foldTodos, parseTodo } from "./todos.ts";
import type { MessageRecord } from "../types";

function rec(kind: string, msg_id: string, sender: string, content: unknown, seq: number): MessageRecord {
  return {
    id: 0, msg_id, conv_id: "group:g1", sender_id: sender, receiver_id: "g1",
    kind: kind as MessageRecord["kind"], content: JSON.stringify(content), ts: 0, seq, status: "delivered",
  };
}
const def = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
  rec("todo", `m-${id}-${seq}`, "a", { todo_id: id, title: "写周报", assignees: ["a"], status: "todo", creator: "a", deleted: false, ...extra }, seq);

test("parseTodo：畸形载荷返回 null，不抛错", () => {
  const bad = (c: string, k = "todo"): MessageRecord =>
    ({ ...def("x", 1), kind: k as MessageRecord["kind"], content: c });
  assert.equal(parseTodo(bad("{")), null);
  assert.equal(parseTodo(bad("{}")), null);                       // 缺 todo_id
  assert.equal(parseTodo(bad('{"todo_id":""}')), null);
  assert.equal(parseTodo({ ...def("x", 1), kind: "text" }), null);
});

test("parseTodo：未知或缺失的状态回落「待办」（任务不会从列表里消失）", () => {
  const noStatus = parseTodo(rec("todo", "m1", "a", { todo_id: "t1", title: "x" }, 1));
  assert.equal(noStatus?.status, TODO_STATUS_DEFAULT);
  const junk = parseTodo(rec("todo", "m2", "a", { todo_id: "t2", status: "fly" }, 1));
  assert.equal(junk?.status, TODO_STATUS_DEFAULT, "脏状态按待办处理，不整条丢掉");
});

test("折叠：创建后可列出，墓碑（deleted）不列", () => {
  assert.equal(foldTodos([def("t1", 1)]).length, 1);
  assert.equal(foldTodos([def("t1", 1, { deleted: true })]).length, 0);
});

test("状态改动走同一条定义（LWW）：取版本最大的那一份", () => {
  const recs = [def("t1", 1), def("t1", 9, { status: "doing" })];
  assert.equal(foldTodos(recs)[0].status, "doing");
  // 到达顺序无关（离线两端各改一次，合并结果一致）
  assert.equal(foldTodos([def("t1", 9, { status: "doing" }), def("t1", 1)])[0].status, "doing");
});

/**
 * 改动事件走的是 **`todo_update`（Silent）**，创建走 `todo`（Card）——
 * 两种 kind 载荷同构、同属一条 LWW 序列，折叠必须一视同仁。
 *
 * 为什么要拆成两个 kind（只是通知口径，不是合并语义）：若改动也用 Card，
 * 用户每改一次状态，全群就多一条未读 + 一条通知。
 */
test("折叠同时接受 todo 与 todo_update（拆分只为通知口径）", () => {
  const created = def("t1", 1, { title: "旧", status: "todo" });
  const updated = { ...def("t1", 5, { title: "新", status: "doing" }), kind: "todo_update" as MessageRecord["kind"] };
  const [t] = foldTodos([created, updated]);
  assert.equal(t.title, "新", "改动的定义必须参与折叠");
  assert.equal(t.status, "doing");
  // 反向到达也一致
  assert.equal(foldTodos([updated, created])[0].status, "doing");
  assert.equal(foldTodos([updated, created]).length, 1, "两个 kind 是同一条任务，不是两条");
});

test("同 seq 时按 msg_id 取更大者（与 Rust 的 ORDER BY seq DESC, msg_id DESC 同规则）", () => {
  const a = def("t1", 5, { status: "doing" });
  const b = { ...def("t1", 5, { status: "done" }), msg_id: "zzz" };
  assert.equal(foldTodos([a, b])[0].status, "done");
  assert.equal(foldTodos([b, a])[0].status, "done", "换顺序结果必须一致");
});

test("改标题 / 换指派人 / 删除都是同一层的 LWW", () => {
  const recs = [
    def("t1", 1, { title: "旧", assignees: ["a"] }),
    def("t1", 5, { title: "新", assignees: ["alice", "bob"] }),
  ];
  const [t] = foldTodos(recs);
  assert.equal(t.title, "新");
  assert.deepEqual(t.assignees, ["alice", "bob"]);
  assert.equal(foldTodos([...recs, def("t1", 6, { deleted: true })]).length, 0, "删除是最高版本的墓碑");
});

test("排序：按创建版本从新到旧（此前按随机 todo_id 字符串，等于没排序）", () => {
  const out = foldTodos([def("t1", 1), def("t2", 7), def("t3", 3)]);
  assert.deepEqual(out.map((t) => t.todoId), ["t2", "t3", "t1"]);
});

test("多个任务互不干扰；非任务消息被忽略", () => {
  const out = foldTodos([def("t1", 1), def("t2", 2)]);
  assert.equal(out.length, 2);
  const text: MessageRecord = { ...def("t3", 1), kind: "text", content: "hi" };
  assert.equal(foldTodos([text]).length, 0);
});

test("状态取值表：四态且缺省是待办（与 protocol.rs 的 TODO_STATUSES 对齐）", () => {
  assert.deepEqual([...TODO_STATUSES], ["todo", "doing", "overdue", "done"]);
  assert.equal(TODO_STATUS_DEFAULT, "todo");
});

/**
 * 授权矩阵 —— **必须与 Rust `commands::may_update_todo` 的用例表逐项一致**。
 * 后端是权威（真正的拦截在命令层），这份是界面显示用的镜像；两边都各自有一条用例表，
 * 改口径时两处一起改（`src-tauri/src/commands.rs` 的 `todo_update_permission_matrix`）。
 */
test("授权矩阵：创建者全权 / 被指派人只能改状态 / 群主能改结构", () => {
  const item = { creator: "alice", assignees: ["bob", "carol"] };
  // 创建者：改状态、改结构都行
  assert.ok(canUpdateTodo(item, "alice", "owner", false));
  assert.ok(canUpdateTodo(item, "alice", "owner", true));
  // 被指派人：只能改状态
  assert.ok(canUpdateTodo(item, "bob", "owner", false));
  assert.equal(canUpdateTodo(item, "bob", "owner", true), false, "被指派人不得改标题 / 删除");
  // 群主：能改结构；改状态不是他的特权（除非他同时是创建者或被指派人）
  assert.ok(canUpdateTodo(item, "owner", "owner", true));
  assert.equal(canUpdateTodo(item, "owner", "owner", false), false);
  // 无关成员：什么都不行
  assert.equal(canUpdateTodo(item, "dave", "owner", false), false);
  assert.equal(canUpdateTodo(item, "dave", "owner", true), false);
});
