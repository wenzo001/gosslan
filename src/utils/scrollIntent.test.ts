import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyItemsChange } from "./scrollIntent.ts";

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

test("**追加不是切会话**（P0 的回归锁）", () => {
  const c = classifyItemsChange(prev, ["a", "b", "c", "d", "new"]);
  assert.equal(c.kind, "append");
});
