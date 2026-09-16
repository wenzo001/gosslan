import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTodos, parseTodo, parseTodoDone } from "./todos.ts";
import type { MessageRecord } from "../types";

function rec(kind: string, msg_id: string, sender: string, content: unknown, seq: number): MessageRecord {
  return {
    id: 0, msg_id, conv_id: "group:g1", sender_id: sender, receiver_id: "g1",
    kind: kind as MessageRecord["kind"], content: JSON.stringify(content), ts: 0, seq, status: "delivered",
  };
}
const def = (id: string, seq: number, extra: Record<string, unknown> = {}) =>
  rec("todo", `m-${id}`, "a", { todo_id: id, title: "写周报", assignees: [], due_ts: 0, creator: "a", deleted: false, ...extra }, seq);
const done = (id: string, actor: string, v: boolean, seq: number, msgId?: string) =>
  rec("todo_done", msgId ?? `d-${id}-${actor}-${seq}`, actor, { todo_id: id, done: v }, seq);

test("parseTodo / parseTodoDone：畸形载荷返回 null，不抛错", () => {
  const bad = (c: string, k = "todo"): MessageRecord =>
    ({ ...def("x", 1), kind: k as MessageRecord["kind"], content: c });
  assert.equal(parseTodo(bad("{")), null);
  assert.equal(parseTodo(bad("{}")), null);                       // 缺 todo_id
  assert.equal(parseTodo(bad('{"todo_id":""}')), null);
  assert.equal(parseTodoDone(bad('{"todo_id":"t1"}', "todo_done")), null); // 缺 done
  assert.equal(parseTodo({ ...def("x", 1), kind: "text" }), null);
});

test("折叠：创建后可列出，deleted 的定义不列", () => {
  assert.equal(foldTodos([def("t1", 1)], "a").length, 1);
  assert.equal(foldTodos([def("t1", 1, { deleted: true })], "a").length, 0);
});

test("**不丢更新**：两人各自勾完成，两格都要保留", () => {
  // 这是把任务拆成两层的**唯一理由**：若合成一个 done_by[] 寄存器，
  // 后到的整体覆盖前者，B 的勾会被吞掉。
  const recs = [def("t1", 1), done("t1", "a", true, 2), done("t1", "b", true, 3)];
  const [t] = foldTodos(recs, "a");
  assert.deepEqual(t.doneBy, ["a", "b"], "两个人的勾都必须留下");
  assert.equal(t.mine, true);
});

test("取消勾选：本人那一格回退，不影响别人", () => {
  const recs = [
    def("t1", 1),
    done("t1", "a", true, 2),
    done("t1", "b", true, 3),
    done("t1", "a", false, 4), // a 取消
  ];
  const [t] = foldTodos(recs, "a");
  assert.deepEqual(t.doneBy, ["b"], "只有 b 还勾着");
  assert.equal(t.mine, false);
});

test("完成层是 per-(todo, actor) 的 LWW，与到达顺序无关", () => {
  const on = done("t1", "a", true, 5, "aaa");
  const off = done("t1", "a", false, 5, "zzz"); // 同 seq，msg_id 更大者胜
  assert.deepEqual(foldTodos([def("t1", 1), on, off], "a")[0].doneBy, []);
  assert.deepEqual(foldTodos([def("t1", 1), off, on], "a")[0].doneBy, [], "换顺序结果必须一致");
});

test("定义层：同 todo_id 取版本最大的那条（可改标题）", () => {
  const recs = [def("t1", 1), def("t1", 9, { title: "改过的标题" })];
  assert.equal(foldTodos(recs, "a")[0].title, "改过的标题");
});

test("多个任务互不干扰；非任务消息被忽略", () => {
  const recs = [def("t1", 1), def("t2", 2), done("t1", "a", true, 3)];
  const out = foldTodos(recs, "a");
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((t) => t.todoId === "t1")!.doneBy, ["a"]);
  assert.deepEqual(out.find((t) => t.todoId === "t2")!.doneBy, []);
  const text: MessageRecord = { ...def("t3", 1), kind: "text", content: "hi" };
  assert.equal(foldTodos([text], "a").length, 0);
});
