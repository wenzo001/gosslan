import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyItemsChange, shouldPinOnItemsChange, shouldSettleOnItemsChange } from "./scrollIntent.ts";

const prev = { first: "a", last: "d" };

test("追加 / 前插 / 同时 / 替换 / 整换 五种形状", () => {
  assert.equal(classifyItemsChange(prev, ["a", "b", "c", "d", "e"]).kind, "append");
  assert.equal(classifyItemsChange(prev, ["z", "a", "b", "c", "d"]).kind, "prepend");
  assert.equal(classifyItemsChange(prev, ["z", "a", "b", "c", "d", "e"]).kind, "both");
  assert.equal(classifyItemsChange(prev, ["a", "b", "c", "x"]).kind, "replace");
  assert.equal(classifyItemsChange(prev, ["x", "y"]).kind, "swap");
  assert.equal(classifyItemsChange(prev, []).kind, "swap");
  assert.equal(classifyItemsChange(null, ["a"]).kind, "initial");
  assert.equal(classifyItemsChange(prev, ["a", "b", "c", "d"]).kind, "none");
});

test("只有 initial/swap 允许重置贴底；只有 swap 需要收敛窗口", () => {
  const kinds = ["initial", "none", "append", "prepend", "both", "replace", "swap"] as const;
  assert.deepEqual(kinds.filter(shouldPinOnItemsChange), ["initial", "swap"]);
  assert.deepEqual(kinds.filter(shouldSettleOnItemsChange), ["swap"]);
});

test("**追加不是切会话**（P0 的回归锁）", () => {
  const c = classifyItemsChange(prev, ["a", "b", "c", "d", "new"]);
  assert.equal(c.kind, "append");
  assert.equal(shouldPinOnItemsChange(c.kind), false);
  assert.equal(shouldSettleOnItemsChange(c.kind), false);
});
