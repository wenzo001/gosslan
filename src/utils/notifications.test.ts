import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mergeNoticesInto, notificationBody, type QueuedNotice } from "./notifications.ts";
import type { MessageRecord } from "../types";

// 假 tr：把「选了哪个键、带了哪些参数」变成可直接断言的形状。
// ⇒ 这里钉的是**判据**（什么情况下走哪条文案），词典内容另有最后一条用例管两头齐全。
const tr = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("显示正文·单条：通知正文就是消息本身，不套模板", () => {
  assert.equal(
    notificationBody({ showContent: true, count: 1, sender: "张三", preview: "你好" }, tr),
    "你好",
  );
});

test("显示正文·多条：只报发送者与条数，不逐条铺正文", () => {
  assert.match(
    notificationBody({ showContent: true, count: 3, sender: "张三", preview: "" }, tr),
    /^notify\.senderCount\|/u,
  );
});

test("关掉正文：单条只剩通用提示，sender/preview 一个字都不出去", () => {
  assert.equal(
    notificationBody({ showContent: false, count: 1, sender: "张三", preview: "机密内容" }, tr),
    "notify.one",
  );
});

test("关掉正文·多条：条数是唯一带出去的信息", () => {
  assert.equal(
    notificationBody({ showContent: false, count: 5, sender: "张三", preview: "机密内容" }, tr),
    'notify.count|{"n":5}',
  );
});

test("隐私不变量：正文关了对端文本就进不了通知（任意输入都不许泄漏）", () => {
  for (const count of [1, 2, 9, 120]) {
    const body = notificationBody(
      { showContent: false, count, sender: "张三", preview: "银行卡号 6222" },
      tr,
    );
    assert.ok(!body.includes("6222"), `条数 ${count}：正文原文漏进通知`);
    assert.ok(!body.includes("张三"), `条数 ${count}：发送者漏进通知`);
  }
});

test("文案两头齐全：三个通知键在两种语言里都存在，否则界面直接显示裸 key", () => {
  const keys: string[] = [];
  const src = readFileSync(ROOT + "/utils/notifications.ts", "utf8");
  for (const m of src.matchAll(/tr\("([\w.]+)"/gu)) keys.push(m[1]);
  assert.ok(keys.length >= 3, `notifications.ts 里的 tr() 键只认出 ${keys.length} 个`);
  for (const dict of ["zh-cn", "en-us"]) {
    const d = readFileSync(`${ROOT}/i18n/locales/${dict}.ts`, "utf8");
    for (const k of keys) assert.ok(d.includes(`"${k}":`), `${dict} 缺 ${k} ⇒ 通知会显示裸 key`);
  }
  // 「不带参数」是隐私判据的一半：那两个键一旦加上 {sender}/{preview} 就漏了
  for (const dict of ["zh-cn", "en-us"]) {
    const d = readFileSync(`${ROOT}/i18n/locales/${dict}.ts`, "utf8");
    for (const k of ["notify.one", "notify.count"]) {
      const line = d.split("\n").find((l) => l.includes(`"${k}":`) || l.includes(`"${k}"`));
      assert.ok(line && !/\{(sender|preview)\}/u.test(line), `${dict} 的 ${k} 里出现了正文/发送者占位`);
    }
  }
});

// 「回队」那一组（权限查询失败时把已取出的通知放回）与文案无关，
// 从上一版原样保留 —— 这轮动的是 notificationBody，不该顺手少掉 5 条判据。
/** 只关心 conv_id / ts / sender_id / kind / content，其余字段填默认。 */
function rec(convId: string, ts: number, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 0,
    msg_id: `m-${convId}-${ts}`,
    conv_id: convId,
    sender_id: "a",
    receiver_id: "b",
    kind: "text",
    content: "hi",
    ts,
    seq: ts,
    status: "sent",
    ...over,
  } as MessageRecord;
}
const notice = (convId: string, ts: number, count: number): QueuedNotice => ({
  count,
  last: rec(convId, ts),
});

test("回队：队列是空的 ⇒ 原样放回", () => {
  const q = new Map<string, QueuedNotice>();
  mergeNoticesInto(q, [notice("c1", 10, 2)]);
  assert.equal(q.get("c1")?.count, 2);
  assert.equal(q.get("c1")?.last.ts, 10);
});

test("回队：窗口期内该会话又来了新消息 ⇒ 条数累加、last 取更新的那条", () => {
  const q = new Map<string, QueuedNotice>([["c1", notice("c1", 30, 1)]]);
  mergeNoticesInto(q, [notice("c1", 10, 2)]); // 放回的是更早的一批
  assert.equal(q.get("c1")?.count, 3, "两段条数必须合并");
  assert.equal(q.get("c1")?.last.ts, 30, "旧批次不许把更新的 last 覆盖回去");
});

test("回队：last 更新时按新的走（通知正文与点击跳转都读它）", () => {
  const q = new Map<string, QueuedNotice>([["c1", notice("c1", 10, 1)]]);
  mergeNoticesInto(q, [notice("c1", 99, 1, )]);
  assert.equal(q.get("c1")?.last.ts, 99);
  assert.equal(q.get("c1")?.count, 2);
});

test("回队：多个会话各自成项，不互相吞", () => {
  const q = new Map<string, QueuedNotice>();
  mergeNoticesInto(q, [notice("c1", 1, 1), notice("c2", 2, 3)]);
  assert.deepEqual([...q.keys()], ["c1", "c2"]);
  assert.equal(q.get("c2")?.count, 3);
});

test("回队：空批次不动队列", () => {
  const q = new Map<string, QueuedNotice>([["c1", notice("c1", 5, 1)]]);
  mergeNoticesInto(q, []);
  assert.equal(q.size, 1);
});
