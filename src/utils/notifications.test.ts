import { test } from "node:test";
import assert from "node:assert/strict";
import { notificationBody } from "./notifications.ts";

test("显示正文 + 单条 → 返回正文预览", () => {
  assert.equal(
    notificationBody({ showContent: true, count: 1, sender: "张三", preview: "你好" }),
    "你好",
  );
});

test("显示正文 + 多条 → 合并提示（带昵称与条数）", () => {
  assert.equal(
    notificationBody({ showContent: true, count: 3, sender: "张三", preview: "" }),
    "张三 等 3 条新消息",
  );
});

test("隐藏正文 + 单条 → 只提示收到，不泄内容", () => {
  assert.equal(
    notificationBody({ showContent: false, count: 1, sender: "张三", preview: "机密内容" }),
    "你收到一条新消息",
  );
});

test("隐藏正文 + 多条 → 只提示收到，不泄内容（回归：隐私开关必须同时挡单条与多条）", () => {
  assert.equal(
    notificationBody({ showContent: false, count: 5, sender: "张三", preview: "机密内容" }),
    "你收到 5 条新消息",
  );
});

test("隐藏正文时正文内容完全不出现（锁屏隐私）", () => {
  const body = notificationBody({ showContent: false, count: 1, sender: "张三", preview: "银行卡号 6222" });
  assert.ok(!body.includes("6222"), `正文不得泄露，实际=${body}`);
});
