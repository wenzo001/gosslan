import { test } from "node:test";
import assert from "node:assert/strict";
import { foldPinned, isPinned, parsePin } from "./pins.ts";
import type { MessageRecord } from "../types";

function pin(msg_id: string, target: string, pinned: boolean, seq: number, sender = "a"): MessageRecord {
  return {
    id: 0, msg_id, conv_id: "group:g1", sender_id: sender, receiver_id: "g1",
    kind: "pin", content: JSON.stringify({ target, pinned }), ts: 0, seq, status: "delivered",
  };
}

test("parsePin：畸形载荷返回 null，不抛错", () => {
  const bad = (c: string): MessageRecord => ({ ...pin("x", "m1", true, 1), content: c });
  assert.equal(parsePin(bad("{")), null);
  assert.equal(parsePin(bad('{"target":"m1"}')), null);            // 缺 pinned
  assert.equal(parsePin(bad('{"target":"","pinned":true}')), null); // 空 target
  assert.equal(parsePin(bad('{"target":"m1","pinned":"yes"}')), null);
  assert.equal(parsePin({ ...pin("x", "m1", true, 1), kind: "text" }), null);
});

test("折叠：置顶后出现在列表，取消后消失", () => {
  assert.deepEqual(foldPinned([pin("p1", "m1", true, 1)]), ["m1"]);
  assert.deepEqual(foldPinned([pin("p1", "m1", true, 1), pin("p2", "m1", false, 2)]), []);
});

test("折叠：LWW 与到达顺序无关", () => {
  const on = pin("p1", "m1", true, 1);
  const off = pin("p2", "m1", false, 2);
  assert.deepEqual(foldPinned([on, off]), []);
  assert.deepEqual(foldPinned([off, on]), [], "乱序到达结果必须一致");
});

test("折叠：同一 seq 时用 msg_id 决胜（seq 不是全序）", () => {
  const a = pin("aaa", "m1", true, 7);
  const b = pin("zzz", "m1", false, 7);
  assert.deepEqual(foldPinned([a, b]), [], "msg_id 大的赢");
  assert.deepEqual(foldPinned([b, a]), [], "换顺序结果不变");
});

test("折叠：多个 target 各自独立，最近置顶的排最前", () => {
  const out = foldPinned([pin("p1", "m1", true, 1), pin("p2", "m2", true, 5)]);
  assert.deepEqual(out, ["m2", "m1"], "版本新的在前");
});

test("折叠：非置顶消息被忽略；空输入返回空数组", () => {
  assert.deepEqual(foldPinned([]), []);
  const text: MessageRecord = { ...pin("t", "m1", true, 1), kind: "text", content: "hi" };
  assert.deepEqual(foldPinned([text]), []);
});

test("isPinned：决定菜单显示「置顶」还是「取消置顶」", () => {
  const recs = [pin("p1", "m1", true, 1)];
  assert.equal(isPinned(recs, "m1"), true);
  assert.equal(isPinned(recs, "m2"), false);
});
