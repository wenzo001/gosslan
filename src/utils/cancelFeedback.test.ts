/**
 * 取消之后那句话的判据（纯函数）。
 *
 * 守的是负责人 2026-10-23 那一族要求里的一个细节：**界面不许比事实说得更满**。
 * 「已取消」只在真的把取消通知送出去时才成立；老端没声明能力位（或通知没送出去）时
 * 对面会继续传，界面必须说"仅本机已取消"。
 *
 * 第四态（FUNC-02）：取消的落库现在是一个事务，失败整体回滚 ⇒ 本机停了手但台账还是
 * "发送中"。这时连"本机已取消"都不能说，必须单独一句「本机已停止、状态待重试」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelOutcome } from "./cancelFeedback.ts";

const res = (
  over: Partial<{
    cancelled: boolean;
    alreadyDone: boolean;
    notifiedPeer: boolean;
    ledgerCommitted: boolean;
  }>,
) => ({
  cancelled: true,
  alreadyDone: false,
  notifiedPeer: true,
  ledgerCommitted: true,
  ...over,
});

test("已经送达 ⇒ 说「已经传完」而不是「已取消」", () => {
  assert.equal(cancelOutcome(res({ cancelled: false, alreadyDone: true })), "already_done");
});

test("台账写失败（事务回滚）⇒ 只说「本机已停止、状态待重试」", () => {
  assert.equal(
    cancelOutcome(res({ cancelled: false, ledgerCommitted: false })),
    "ledger_pending",
  );
});

test("已经送达优先于台账写失败：那一单根本没有「取消」这回事", () => {
  assert.equal(
    cancelOutcome(res({ cancelled: false, alreadyDone: true, ledgerCommitted: false })),
    "already_done",
  );
});

test("通知没送出去（老端没声明能力位 / 离线）⇒ 只说「仅本机已取消」", () => {
  assert.equal(cancelOutcome(res({ notifiedPeer: false })), "local_only");
});

test("通知真的进了链路 ⇒ 才说「已取消」", () => {
  assert.equal(cancelOutcome(res({})), "notified");
});
