/**
 * 取消之后那句话的判据（纯函数）。
 *
 * 守的是负责人 2026-10-23 那一族要求里的一个细节：**界面不许比事实说得更满**。
 * 「已取消」只在真的把取消通知送出去时才成立；老端没声明能力位（或通知没送出去）时
 * 对面会继续传，界面必须说"仅本机已取消"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelOutcome } from "./cancelFeedback.ts";

const res = (over: Partial<{ cancelled: boolean; alreadyDone: boolean; notifiedPeer: boolean }>) => ({
  cancelled: true,
  alreadyDone: false,
  notifiedPeer: true,
  ...over,
});

test("已经送达 ⇒ 说「已经传完」而不是「已取消」", () => {
  assert.equal(cancelOutcome(res({ cancelled: false, alreadyDone: true })), "already_done");
});

test("通知没送出去（老端没声明能力位 / 离线）⇒ 只说「仅本机已取消」", () => {
  assert.equal(cancelOutcome(res({ notifiedPeer: false })), "local_only");
});

test("通知真的进了链路 ⇒ 才说「已取消」", () => {
  assert.equal(cancelOutcome(res({})), "notified");
});
