/**
 * 「取消发送」两条通道的判据（纯函数）。
 *
 * 守的是负责人 2026-10-23 那两句："所有未完成的发送都可以取消" +
 * "文件/图片走取消、文本类走撤回"。这一册只判**入口该不该出现、该走哪条通道**；
 * 命令本身的行为（删队列行、晚到 Ack 不复活）在 Rust 侧。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cancelSendChannelFor, type CancelSendContext } from "./cancelSend.ts";

const ctx = (over: Partial<CancelSendContext>): CancelSendContext => ({
  msgId: "m-1",
  kind: "text",
  status: "sending",
  group: false,
  selfChat: false,
  mine: true,
  ...over,
});

test("文本族在补发队列里 ⇒ 走消息通道", () => {
  assert.equal(cancelSendChannelFor(ctx({})), "message");
  assert.equal(cancelSendChannelFor(ctx({ kind: "code" })), "message");
  assert.equal(cancelSendChannelFor(ctx({ kind: "merge" })), "message");
});

test("文件消息 ⇒ 走传输通道（按 id 前缀认，不看 kind）", () => {
  assert.equal(cancelSendChannelFor(ctx({ msgId: "file-t1", kind: "file" })), "transfer");
  assert.equal(cancelSendChannelFor(ctx({ msgId: "gfile-t2", kind: "file", group: true })), "transfer");
});

test("文件/图片的真实消息不走消息通道：那条通道停不掉字节", () => {
  assert.equal(cancelSendChannelFor(ctx({ kind: "file" })), "none");
  assert.equal(cancelSendChannelFor(ctx({ kind: "image" })), "none");
});

test("只给自己发的、没出门的、非自聊、非群", () => {
  assert.equal(cancelSendChannelFor(ctx({ mine: false })), "none", "别人发的没有「我取消」");
  assert.equal(cancelSendChannelFor(ctx({ selfChat: true })), "none", "自聊没有送达这回事");
  for (const status of ["sent", "delivered", "read", "failed", "cancelled"]) {
    assert.equal(cancelSendChannelFor(ctx({ status })), "none", `${status} 已经不在队列里了`);
  }
  assert.equal(
    cancelSendChannelFor(ctx({ group: true })),
    "none",
    "群消息取消还没做：宁可不给，也不要「界面已取消、其余成员照样收到」",
  );
});

test("MessageItem 真按这条判据分派（两条通道各一个出口）", () => {
  const item = readFileSync(join(import.meta.dirname, "..", "components", "MessageItem.vue"), "utf8");
  assert.ok(
    item.includes('from "@/utils/cancelSend"'),
    "MessageItem 没接 cancelSend ⇒ 入口还是自己按前缀猜的第二套口径",
  );
  assert.match(item, /api\.cancelFileTransfer\(transferId\)/, "传输通道那条出口必须还在");
  assert.match(item, /api\.cancelMessage\(/, "消息通道必须接上（否则新命令就是没人用的包装）");
});
