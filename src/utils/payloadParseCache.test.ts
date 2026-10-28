import { test } from "node:test";
import assert from "node:assert/strict";

import { createPayloadParseCache } from "./payloadParseCache.ts";
import { foldPinned, parsePin } from "./pins.ts";
import type { MessageRecord } from "@/types";

function rec(over: Partial<MessageRecord> & Pick<MessageRecord, "msg_id" | "kind" | "content">): MessageRecord {
  return {
    conv_id: "c1",
    sender_id: "p1",
    ts: 1,
    seq: 1,
    status: "sent",
    ...over,
  } as MessageRecord;
}

test("缓存：未命中是 undefined；命中返回同一个值；超上限整表清空（不是 LRU）", () => {
  const c = createPayloadParseCache<number>(2);
  assert.equal(c.get("a", "x"), undefined);
  c.set("a", "x", 1);
  c.set("b", "y", 2);
  assert.equal(c.get("a", "x"), 1);
  c.set("c", "z", 3); // 满了 ⇒ 清空后再放 c
  assert.equal(c.get("a", "x"), undefined, "上限到了是整表清空");
  assert.equal(c.get("c", "z"), 3);
});

test("同一个 id 换了 content：必须重新解析（夹具复用 id 的常见形状）", () => {
  const c = createPayloadParseCache<number>();
  c.set("m1", '{"a":1}', 1);
  assert.equal(c.get("m1", '{"a":1}'), 1);
  assert.equal(c.get("m1", '{"a":2}'), undefined, "content 不同 ⇒ 视作未命中");
});

test("折叠重复扫描时 JSON.parse 只发生一次（审计 P2 #27 的可观测量）", () => {
  const msgs = [
    rec({ msg_id: "m1", kind: "pin", content: JSON.stringify({ target: "x", pinned: true }) }),
    rec({ msg_id: "m2", kind: "pin", content: JSON.stringify({ target: "x", pinned: false }) }),
    rec({ msg_id: "m3", kind: "text", content: "不是置顶" }),
  ];
  const original = JSON.parse;
  let parses = 0;
  (JSON as { parse: typeof JSON.parse }).parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return original(...args);
  }) as typeof JSON.parse;
  try {
    assert.deepEqual(foldPinned(msgs), []);
    const afterFirst = parses;
    assert.equal(afterFirst, 2, "第一次折叠只解析两条 pin 载荷（text 被 kind 挡住）");
    foldPinned(msgs);
    foldPinned(msgs);
    assert.equal(parses, afterFirst, "同样的消息再折叠多少次都不再解析");
  } finally {
    (JSON as { parse: typeof JSON.parse }).parse = original;
  }
});

test("派生对象每次新建：调用方改返回值不会污染别人的读数", () => {
  const m = rec({ msg_id: "pin-1", kind: "pin", content: JSON.stringify({ target: "t", pinned: true }) });
  const a = parsePin(m);
  assert.ok(a);
  a.pinned = false;
  assert.equal(parsePin(m)?.pinned, true, "第二次拿到的必须是重新派生的对象");
});
