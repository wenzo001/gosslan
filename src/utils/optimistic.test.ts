import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canApplyOptimisticFailure,
  canRollback,
  dropByMsgId,
  findByMsgId,
  isLatestReadSeq,
  isSupersededProjection,
  nextReadSeq,
  pendingRollbackIndex,
  recallRollbackTarget,
  rollbackUnread,
  settle,
  summaryOwnedByProjection,
} from "./optimistic.ts";

/**
 * 第一批乐观更新（1:1 发消息 / 1:1 发文件 / 标记已读）的**对偶用例**。
 *
 * 三种乱序都必须断言 UI 不回退成错误状态：
 *   ① 真实结果先到、乐观回滚后到；
 *   ② 重复到达；
 *   ③ 回滚之后再收到真实成功。
 */

test("真实成功先到：迟到回滚被丢弃，状态不回退", () => {
  let s = settle("pending", "succeeded");
  assert.equal(s, "succeeded");
  assert.equal(canRollback(s), false);
  // 迟到失败到达 —— 必须无效果
  s = settle(s, "failed");
  assert.equal(s, "succeeded");
});

test("重复失败到达幂等；回滚只认第一次", () => {
  // 回滚前先问：还没等到真实结果 ⇒ 可以回滚
  assert.equal(canRollback("pending"), true);
  const s = settle("pending", "failed");
  assert.equal(s, "failed");
  // 同一个失败重复到达：状态不变（幂等），且**不许再回滚一次**
  // （store 侧按"槽是否还在"判断；这里钉住纯判据这一半：failed 之上不再回滚）。
  assert.equal(canRollback(s), false, "第二次失败不许再把未读/摘要加回去");
  assert.equal(settle(s, "failed"), "failed");
});

test("回滚之后再收到真实成功：允许升级成 succeeded", () => {
  let s = settle("pending", "failed");
  assert.equal(s, "failed");
  s = settle(s, "succeeded");
  assert.equal(s, "succeeded");
});

test("迟到失败只能落在仍 sending 的同一条投影上", () => {
  // 投影还在（sending）⇒ 可以回滚
  assert.equal(
    canApplyOptimisticFailure({ msg_id: "tmp-a", status: "sending" }, "tmp-a"),
    true,
  );
  // 真实结果先到（同一条 msg_id 已被推进到 sent）⇒ 丢弃迟到失败
  assert.equal(
    canApplyOptimisticFailure({ msg_id: "tmp-a", status: "sent" }, "tmp-a"),
    false,
  );
  // 真实行换了 msg_id（乐观已经替换）⇒ 不能按 local_id 去改它
  assert.equal(
    canApplyOptimisticFailure({ msg_id: "file-1", status: "sent" }, "tmp-a"),
    false,
  );
  // 行已经不在（真实记录只剩另一行）
  assert.equal(canApplyOptimisticFailure(undefined, "tmp-a"), false);
});

test("摘要回滚只归这次投影：更新的消息已接管就不动", () => {
  assert.equal(summaryOwnedByProjection(1000, 1000), true);
  assert.equal(summaryOwnedByProjection(1001, 1000), false);
  assert.equal(summaryOwnedByProjection(undefined, 1000), false);
});

test("未读回滚把旧值加回当前值，期间新到的未读不丢", () => {
  assert.equal(rollbackUnread(0, 5), 5); // 期间没有新消息
  assert.equal(rollbackUnread(2, 5), 7); // 期间又到 2 条
  assert.equal(rollbackUnread(0, 0), 0);
});

test("真实记录先到：同一 local_id 的乐观批次必须作废", () => {
  const real = { msg_id: "file-1", local_id: "L1" };
  assert.equal(isSupersededProjection({ msg_id: "tmp-L1", local_id: "L1" }, [real]), true);
  // 乐观批次先到：真实记录还没出现 ⇒ 照常合并
  assert.equal(isSupersededProjection({ msg_id: "tmp-L1", local_id: "L1" }, []), false);
  // 不是乐观行 / local_id 不同 ⇒ 不误伤
  assert.equal(isSupersededProjection(real, [real]), false);
  assert.equal(
    isSupersededProjection({ msg_id: "tmp-L1", local_id: "L1" }, [{ msg_id: "tmp-L2", local_id: "L2" }]),
    false,
  );
});

test("待落地批次的回滚索引：只命中同 msg_id 且仍 sending 的那一格", () => {
  const rows = [
    { msg_id: "tmp-a", status: "sending" },
    { msg_id: "tmp-b", status: "sending" },
  ];
  assert.equal(pendingRollbackIndex(rows, "tmp-b"), 1);
  // 已落成 failed ⇒ 第二次失败不许再命中（否则未读会被加回两次）
  rows[0].status = "failed";
  assert.equal(pendingRollbackIndex(rows, "tmp-a"), -1);
  assert.equal(pendingRollbackIndex(rows, "nope"), -1);
});

test("按 msg_id 只读查找：不存在时返回 undefined，不凭空造行", () => {
  const rows = [{ msg_id: "m1" }, { msg_id: "m2" }];
  assert.equal(findByMsgId(rows, "m2"), rows[1]);
  assert.equal(findByMsgId(rows, "nope"), undefined);
  assert.equal(findByMsgId(undefined, "m1"), undefined);
});

/**
 * 第二批乐观更新（表情回应 / 撤回，5.16.93）的对偶用例。
 * 判据同样只有两组：临时行只按 `msg_id` 摘除；撤回只在"仍是我投影的 recalled"时还原。
 */

test("乐观任务中心行只摘临时 msg_id：真实先到不误删", () => {
  const ops = [
    { msg_id: "tmp-L1" },
    { msg_id: "reaction-1" },
    { msg_id: "tmp-L2" },
  ];
  // 正常路径：真实行还没来，摘掉自己的临时行
  assert.deepEqual(dropByMsgId(ops, "tmp-L1"), [
    { msg_id: "reaction-1" },
    { msg_id: "tmp-L2" },
  ]);
  // 真实先到：临时行已被替换成真实 msg_id ⇒ 迟到回滚摘不到任何行
  //（`reaction-1` 与 `tmp-L1` 逐字不同，摘除只认临时 id）
  assert.deepEqual(dropByMsgId([{ msg_id: "reaction-1" }], "tmp-L1"), [
    { msg_id: "reaction-1" },
  ]);
  // 重复摘除：第二次是空操作（幂等）
  assert.deepEqual(dropByMsgId([{ msg_id: "reaction-1" }], "reaction-1"), []);
  assert.deepEqual(dropByMsgId([{ msg_id: "reaction-1" }], "reaction-1"), []);
  // 没有快照（读失败）⇒ 不动，绝不凭空造空表
  assert.equal(dropByMsgId(undefined, "tmp-L1"), undefined);
});

test("撤回回滚：真实事件先到（settled）⇒ 不还原", () => {
  const before = { msg_id: "m1", kind: "text" };
  const projected = { msg_id: "m1", kind: "recalled" };
  assert.equal(recallRollbackTarget(projected, before, true), null);
  // 事件没到、投影仍在 ⇒ 还原
  assert.deepEqual(recallRollbackTarget(projected, before, false), before);
});

test("撤回回滚：重复失败幂等，已还原的行不再命中", () => {
  const before = { msg_id: "m1", kind: "text" };
  const projected = { msg_id: "m1", kind: "recalled" };
  assert.deepEqual(recallRollbackTarget(projected, before, false), before);
  // 第一次回滚后，这一行已不是 `recalled` ⇒ 第二次失败不许再动
  assert.equal(recallRollbackTarget(before, before, false), null);
  // 已被别的路径改掉（消息换了人）⇒ 不碰
  assert.equal(
    recallRollbackTarget({ msg_id: "m2", kind: "recalled" }, before, false),
    null,
  );
  // 行已经不在（整表重读后这一条被删）⇒ 不凭空造行
  assert.equal(recallRollbackTarget(undefined, before, false), null);
});
