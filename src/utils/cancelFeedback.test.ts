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

import { cancelOutcome, fileCancelKey } from "./cancelFeedback.ts";

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

test("文件已写出（sent）后取消 ⇒ 文案必须承认字节可能已到对方", () => {
  // 用户 2026-10-25：「文件 sent 取消措辞」——已经发出去的字节收不回来，
  // 只说"已取消"会让人以为对方没收到。
  assert.equal(fileCancelKey("notified", true), "transfer.cancelSent");
  assert.equal(
    fileCancelKey("notified", false),
    "task.cancelDone",
    "还没写出去的取消就是干净的「已取消」",
  );
  // 另外三档压过 sent/未写出：它们描述的是更根本的事实（已送达 / 台账没落地 / 对面可能还在传）。
  assert.equal(fileCancelKey("already_done", true), "msg.cancelSend.alreadyDone");
  assert.equal(fileCancelKey("ledger_pending", true), "transfer.cancelLedgerPending");
  assert.equal(fileCancelKey("local_only", true), "transfer.cancelLocalOnly");
});
