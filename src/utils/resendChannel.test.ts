/**
 * 「重发该走哪条通道」的判据（纯函数矩阵 + 那根接线）。
 *
 * 守的是负责人 2026-10-23 那句"发送失败、取消了，其实也可以有个重试/再次发送 ——
 * 可打断、可恢复、可取消这种都应该有"，以及它背后那处真缺陷：
 * 图片以前被留在文本通道里重发（`retryable` 与 `retrySend` 都只排除 `file`），
 * 结果发出去一条"有名字没有字节"的 image 消息，本机还显示成功。
 *
 * 家为什么在这里：`resendChannel.ts` 零 Vue 依赖 ⇒ `node --test` 能量行为矩阵；
 * 而"组件真的引了它"这一格是**接线**判据（逻辑全绿而没人接上 = 功能为零），
 * 按本仓惯例用源码形状钉在这里，不靠真机点。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { resendChannelFor, type ResendContext } from "./resendChannel.ts";

const ctx = (over: Partial<ResendContext>): ResendContext => ({
  kind: "text",
  group: false,
  hasLocalFile: false,
  mine: true,
  ...over,
});

test("★ 回归那处缺陷：失败的图片必须回到文件通道，而不是 send_message", () => {
  assert.equal(
    resendChannelFor(ctx({ kind: "image", hasLocalFile: true })),
    "file",
    "图片是后端 send_file* 造的，重发必须回同一条通道 —— 走 send_message 发出去的是一条"
      + "内容=JSON 载荷的 image 消息，path 只在本机存在，对端拿到的是空图。",
  );
  assert.equal(resendChannelFor(ctx({ kind: "file", hasLocalFile: true })), "file");
});

test("本机已经没有那份附件 ⇒ 不给按钮（null），而不是给一颗点了没反应的键", () => {
  assert.equal(resendChannelFor(ctx({ kind: "image", hasLocalFile: false })), null);
  assert.equal(resendChannelFor(ctx({ kind: "file", hasLocalFile: false })), null);
});

test("群里的文件走群文件通道，群里的文本仍走群消息通道", () => {
  assert.equal(resendChannelFor(ctx({ kind: "file", group: true, hasLocalFile: true })), "group-file");
  assert.equal(resendChannelFor(ctx({ kind: "image", group: true, hasLocalFile: true })), "group-file");
  // payload 型 kind（poll / announcement / todo / merge…）本来就走 send_group_message，
  // 它们不是文件，不许被误并进文件通道。
  assert.equal(resendChannelFor(ctx({ kind: "poll", group: true })), "message");
  assert.equal(resendChannelFor(ctx({ kind: "merge", group: true })), "message");
});

test("文本族走消息通道；别人发的消息没有「我再发一次」这件事", () => {
  assert.equal(resendChannelFor(ctx({ kind: "text" })), "message");
  assert.equal(resendChannelFor(ctx({ kind: "code" })), "message");
  assert.equal(resendChannelFor(ctx({ kind: "text", mine: false })), null);
  // 附件类即使 mine=false 也必须 null（顺序判据：先判归属，再判通道）
  assert.equal(resendChannelFor(ctx({ kind: "image", mine: false, hasLocalFile: true })), null);
});

// ---------------- 接线：这两个消费者必须真的用它 ----------------

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("★ MessageItem 的重发入口按通道分派，旧的 `kind !== 'file'` 那一步不许长回来", () => {
  const item = read("components/MessageItem.vue");
  assert.ok(
    item.includes('from "@/utils/resendChannel"'),
    "MessageItem 没接 resendChannel ⇒ retryable 还是自己按 kind 猜的第二套口径",
  );
  assert.equal(
    item.includes(`:retryable="message.kind !== 'file'"`),
    false,
    "回执的可重发判据又退回「只排除 file」了 —— 图片正是这样漏在文本通道里的",
  );
  // 三条通道各有且只有一个出口：消息通道复用旧气泡，两条文件通道各回自己的命令
  assert.equal(
    (item.match(/await chat\.sendFileTo\(/g) || []).length,
    1,
    "单聊文件重发必须恰好一处调用 chat.sendFileTo（多了就是第二个家）",
  );
  assert.equal(
    (item.match(/await chat\.sendGroupFileTo\(/g) || []).length,
    1,
    "群文件重发必须恰好一处调用 chat.sendGroupFileTo",
  );
  // 消息通道那条不许被换成"新建一条"：第 5 个参数（旧 msg_id）是原地复用的唯一线索
  assert.match(
    item,
    /chat\.send\(msg\.conv_id, msg\.content, msg\.kind, undefined, msg\.msg_id\)/,
    "文本族重发必须把旧 msg_id 传下去（见 retrySend.test.ts 那三条）",
  );
});

test("★ 回执那颗键的可用性由 retryable 决定，取消那一格不再是「永远静态」", () => {
  const receipt = read("components/message/MessageReceipt.vue");
  // 失败与取消两格都要能长出可点的重发（负责人：取消了也该能再次发送）
  assert.match(
    receipt,
    /props\.state === "failed" \|\| props\.state === "cancelled"/,
    "回执的 canRetry 必须同时接住 failed 与 cancelled，否则取消掉的文件永远只有一个静态图标",
  );
  assert.equal(
    receipt.includes(`retryable !== false`),
    false,
    "`retryable !== false` 是「缺省就能点」的旧写法；现在 retryable 由通道算出来，" +
      "缺省（undefined）必须不可点，否则又是第二个口径",
  );
});
