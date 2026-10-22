import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTransferProgress,
  clampProgress,
  isLiveTransfer,
  liveTransfers,
  sortLiveTransfers,
} from "./transferSummary.ts";

test("还在动的只有 active 与 queued，终态一个都不算", () => {
  assert.equal(isLiveTransfer("active"), true);
  assert.equal(isLiveTransfer("pending"), true);
  // 下面这些在 `transferState` 里分别映射成 done / failed / cancelled / unknown，
  // 面板一个都不该展示。`sent` 尤其容易误判：发送侧写完了但对端还没回执，
  // 它仍然是终态（见 transport 里那一行注释）。
  for (const status of ["done", "sent", "failed", "cancelled", "weird-status"]) {
    assert.equal(isLiveTransfer(status), false, `${status} 不该被当成进行中`);
  }
});

test("liveTransfers 只留下还在动的行", () => {
  const rows = [
    { status: "active", size: 10, progress: 0.4 },
    { status: "done", size: 10, progress: 1 },
    { status: "pending", size: 10, progress: 0 },
    { status: "failed", size: 10, progress: 0.2 },
  ];
  const live = liveTransfers(rows);
  assert.equal(live.length, 2);
  assert.deepEqual(
    live.map((r) => r.status),
    ["active", "pending"],
  );
});

test("聚合进度按字节加权，不是按条数平均", () => {
  // 这条用例的形状是刻意的：条数平均会得到 (100% + 0%) / 2 = 50%，
  // 字节加权得到 100 / (100 + 300) = 25%。断言 25 才能证明用的是后者。
  const rows = [
    { status: "active", size: 100, progress: 1 },
    { status: "active", size: 300, progress: 0 },
  ];
  assert.deepEqual(aggregateTransferProgress(rows), { count: 2, percent: 25 });
});

test("大小未知的行按权重 1 计，不会除零也不会支配总数", () => {
  const rows = [
    { status: "active", size: 0, progress: 0.5 },
    { status: "active", size: 0, progress: 0.5 },
  ];
  // 权重 1:1 ⇒ (0.5 + 0.5) / 2 = 50%，不是 NaN。
  assert.deepEqual(aggregateTransferProgress(rows), { count: 2, percent: 50 });
});

test("越界进度被夹回 0..1，NaN 归零", () => {
  assert.equal(clampProgress(1.5), 1);
  assert.equal(clampProgress(-0.2), 0);
  assert.equal(clampProgress(Number.NaN), 0);
  assert.equal(clampProgress(undefined), 0);
  assert.equal(clampProgress(0.42), 0.42);
  // 越界值不能把聚合画成 140%。
  assert.equal(
    aggregateTransferProgress([{ status: "active", size: 100, progress: 1.4 }]).percent,
    100,
  );
});

test("传完了就不再出现在面板里（传完后 count 为 0）", () => {
  const rows = [
    { status: "done", size: 100, progress: 1 },
    { status: "cancelled", size: 100, progress: 0.3 },
  ];
  assert.deepEqual(aggregateTransferProgress(rows), { count: 0, percent: 0 });
});

test("行序：真在传的排在排队前面，同档按进度多的在前", () => {
  const rows = [
    { name: "queued-a", status: "pending", size: 10, progress: 0 },
    { name: "active-slow", status: "active", size: 10, progress: 0.1 },
    { name: "active-fast", status: "active", size: 10, progress: 0.9 },
    { name: "queued-b", status: "pending", size: 10, progress: 0 },
  ];
  assert.deepEqual(
    sortLiveTransfers(rows).map((r) => r.name),
    ["active-fast", "active-slow", "queued-a", "queued-b"],
  );
});

test("排序不改原数组（调用方在 computed 里直接传快照）", () => {
  const rows = [
    { name: "queued", status: "pending", size: 10, progress: 0 },
    { name: "active", status: "active", size: 10, progress: 0.5 },
  ];
  sortLiveTransfers(rows);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["queued", "active"],
  );
});
