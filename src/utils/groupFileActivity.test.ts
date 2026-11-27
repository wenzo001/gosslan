import assert from "node:assert/strict";
import test from "node:test";
import { groupFileActivityConvId, groupFileActivityMatches } from "./groupFileActivity.ts";

test("群文件事件保留 group_id/conv_id，只失效当前群", () => {
  assert.equal(groupFileActivityConvId({ group_id: "g1", conv_id: "group:g1" }), "group:g1");
  assert.equal(groupFileActivityMatches({ group_id: "g1" }, "g1"), true);
  assert.equal(groupFileActivityMatches({ conv_id: "group:g2" }, "g1"), false);
});

test("反例：无归属事件不再盲刷当前群", () => {
  assert.equal(groupFileActivityMatches({}, "g1"), false);
  assert.equal(groupFileActivityMatches({ conv_id: "dm" }, "g1"), false);
});
