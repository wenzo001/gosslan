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
  mediaCid,
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

test("每行摘要：媒体写类型 + 文件名，文本折叠空白并截断", () => {
  // 无名字（畸形/老版本载荷）→ 只给类型，不能因为解析不出就报错
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: "{}", ts: 1 }), "[图片]");
  // 旧格式 dataURL 同样退回纯类型
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: "data:image/png;base64,AA", ts: 1 }), "[图片]");
  assert.equal(mergeItemLine({ sender: "a", kind: "file", content: "{}", ts: 1 }), "[文件]");
  assert.equal(mergeItemLine({ sender: "a", kind: "merge", content: "{}", ts: 1 }), "[聊天记录]");
  assert.equal(mergeItemLine({ sender: "a", kind: "text", content: "a\n  b", ts: 1 }), "a b");
  const long = "字".repeat(60);
  assert.equal(mergeItemLine({ sender: "a", kind: "text", content: long, ts: 1 }).length, 41);
});

test("媒体行带上文件名（卡片看不到图时，名字是唯一的信息）", () => {
  // 契约来源：MergeCardModal 的文件头与 f075950 的提交信息都写了「[图片] 名字」，
  // 但实现只输出了 [图片] —— 这条把承诺钉住。
  const img = JSON.stringify({ name: "照片.png", size: 10, subtype: "image" });
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: img, ts: 1 }), "[图片] 照片.png");
  assert.equal(
    mergeItemLine({ sender: "a", kind: "file", content: JSON.stringify({ name: "报表.pdf" }), ts: 1 }),
    "[文件] 报表.pdf",
  );
  // 空名字 / 空白名字不能拼出 "[图片] "这种带尾空格的半成品
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: JSON.stringify({ name: "   " }), ts: 1 }), "[图片]");
  assert.equal(mergeItemLine({ sender: "a", kind: "image", content: JSON.stringify({ name: 42 }), ts: 1 }), "[图片]");
});

test("条数上限与 Rust 侧一致（100）", () => {
  assert.equal(MAX_MERGE_ITEMS, 100);
});

test("媒体条目不把发送方本机路径带进卡片，也不塞整段 dataURL", () => {
  // 真实背景（2026-09-17）：卡片不渲染媒体，但 content 原样打包会把
  // `D:\Users\…\downloads\a.png` 这类**发送方本机路径**送给对端；
  // 旧格式图片的 content 更是整段 dataURL —— 一条合并转发就能把帧撑爆。
  const payload = buildMergePayload(
    [
      {
        ...REC,
        kind: "image",
        content: JSON.stringify({
          name: "a.png",
          size: 10,
          subtype: "image",
          path: "D:\\secret\\a.png",
          sha256: "abc123",
        }),
      },
      { ...REC, kind: "image", content: "data:image/png;base64,AAAAAAAA" },
      { ...REC, kind: "file", content: JSON.stringify({ name: "b.pdf", path: "/home/me/b.pdf" }) },
    ],
    "t",
    () => "我",
  );
  assert.ok(!payload.includes("secret"), "不得带本机路径（图片）");
  assert.ok(!payload.includes("/home/me"), "不得带本机路径（文件）");
  assert.ok(!payload.includes("base64"), "不得把 dataURL 整段塞进卡片");
  // 名字与内容指纹必须留下：名字给卡片可读行，sha256(=cid) 是接收方按需拉取的钥匙
  const parsed = parseMergePayload(payload);
  assert.ok(parsed);
  assert.equal(parsed.items.length, 3);
  assert.equal(JSON.parse(parsed.items[0].content).name, "a.png");
  assert.equal(mediaCid(parsed.items[0]), "abc123", "sha256（cid）必须保留");
  assert.equal(mediaCid(parsed.items[1]), "", "dataURL 没有 cid，应回退为空");
});
