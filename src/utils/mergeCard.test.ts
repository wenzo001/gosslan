/**
 * 合并转发卡片载荷的纯函数（微信式「聊天记录」）。
 *
 * 为什么值得单测：这里是**跨进程的内容格式** —— 发送侧构建、接收侧解析，
 * 而且解析失败必须"退化成人话"而不是抛错（否则一条畸形载荷会让整个消息列表崩掉，
 * 而它来自对端，本机无从修复）。这类边界只有测试能钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MERGE_ITEMS,
  buildMergePayload,
  mergeItemLine,
  mergeSummary,
  parseMergePayload,
} from "./mergeCard.ts";

const REC = {
  id: 1,
  msg_id: "m1",
  conv_id: "c1",
  sender_id: "a",
  receiver_id: "b",
  kind: "text" as const,
  content: "你好",
  ts: 100,
  seq: 1,
  status: "sent",
};

test("构建 → 解析往返：标题、条数、每条的内容都保真", () => {
  const payload = buildMergePayload(
    [
      { ...REC, msg_id: "m1", kind: "text", content: "你好" },
      { ...REC, msg_id: "m2", kind: "image", content: '{"name":"a.png"}', ts: 200 },
    ],
    "群聊的聊天记录",
    (m) => (m.sender_id === "a" ? "张三" : "我"),
  );
  const parsed = parseMergePayload(payload);
  assert.ok(parsed);
  assert.equal(parsed.title, "群聊的聊天记录");
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].sender, "张三");
  assert.equal(parsed.items[1].kind, "image");
  assert.equal(parsed.items[1].ts, 200, "时间要保真（卡片里按时间展示）");
});

test("畸形载荷一律返回 null（渲染路径不能抛错）", () => {
  for (const bad of ["", "not json", "{}", '{"items":[]}', '{"items":[{"kind":"text"}]}', "null"]) {
    assert.equal(parseMergePayload(bad), null, `应判为畸形：${bad}`);
  }
  // 解析失败时摘要也要是人话，不能把裸 JSON 顶到会话列表上
  assert.equal(mergeSummary("not json"), "[聊天记录]");
  assert.equal(mergeSummary(buildMergePayload([REC], "t", () => "我")), "[聊天记录] 1 条");
});

test("每行摘要：媒体只写类型，文本折叠空白并截断", () => {
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: "{}", ts: 1 }), "[图片]");
  assert.equal(mergeItemLine({ sender: "a", kind: "file", content: "{}", ts: 1 }), "[文件]");
  assert.equal(mergeItemLine({ sender: "a", kind: "merge", content: "{}", ts: 1 }), "[聊天记录]");
  assert.equal(mergeItemLine({ sender: "a", kind: "text", content: "a\n  b", ts: 1 }), "a b");
  const long = "字".repeat(60);
  assert.equal(mergeItemLine({ sender: "a", kind: "text", content: long, ts: 1 }).length, 41);
});

test("条数上限与 Rust 侧一致（100）", () => {
  assert.equal(MAX_MERGE_ITEMS, 100);
});
