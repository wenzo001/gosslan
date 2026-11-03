import assert from "node:assert/strict";
import test from "node:test";
import { notifyTitle } from "./notifyTitle.ts";

test("群消息标题 = 群名 · 发送者昵称", () => {
  assert.equal(notifyTitle("group:g1", "周明", "产品设计组"), "产品设计组 · 周明");
});

test("单聊标题只有昵称", () => {
  assert.equal(notifyTitle("dev-42", "周明", "产品设计组"), "周明");
});

test("群名拿不到时回落昵称，不露机器串", () => {
  assert.equal(notifyTitle("group:g1", "周明", null), "周明");
  assert.equal(notifyTitle("group:g1", "周明", "   "), "周明");
});

test("正控：把顺序写反（昵称 · 群名）必须红", () => {
  assert.notEqual(notifyTitle("group:g1", "周明", "产品设计组"), "周明 · 产品设计组");
});
