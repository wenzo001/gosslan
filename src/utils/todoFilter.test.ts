import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDefaultFilter } from "./todoFilter.ts";

const base = { open: true, dataReady: true, selfKnown: true, mineCount: 2, settled: false };

test("默认选「我的」：「我的」有任务时不动标签", () => {
  assert.equal(decideDefaultFilter(base), "mine");
});

test("「我的」为空 ⇒ 落到「全部」", () => {
  assert.equal(decideDefaultFilter({ ...base, mineCount: 0 }), "all");
});

test("面板关着不判（数据在关着的时候变化，不许提前落定）", () => {
  assert.equal(decideDefaultFilter({ ...base, open: false }), null);
  assert.equal(decideDefaultFilter({ ...base, open: false, mineCount: 0 }), null);
});

test("数据没到齐不判（加载中 / 读失败都不是「空的」）", () => {
  assert.equal(decideDefaultFilter({ ...base, dataReady: false }), null);
  assert.equal(decideDefaultFilter({ ...base, dataReady: false, mineCount: 0 }), null);
});

test("身份没回来不判（否则「我的」被数成 0 并锁死在「全部」，5.20.0 的实际缺陷）", () => {
  assert.equal(decideDefaultFilter({ ...base, selfKnown: false, mineCount: 0 }), null);
  assert.equal(decideDefaultFilter({ ...base, selfKnown: false, mineCount: 2 }), null);
});

test("判过就锁住：用户手动切过之后不再被拉回", () => {
  assert.equal(decideDefaultFilter({ ...base, settled: true }), null);
  assert.equal(decideDefaultFilter({ ...base, settled: true, mineCount: 0 }), null);
});

test("反例自证：漏掉「面板关着」这个前提，闭着时会把标签判成「全部」", () => {
  // 把 open 摘掉的实现会返回 "all" —— 与正确结果不同，说明这条判据不是空转。
  const naive = (i: typeof base) =>
    !i.dataReady || i.settled ? null : i.mineCount === 0 ? "all" : "mine";
  assert.equal(naive({ ...base, open: false, mineCount: 0 }), "all");
  assert.notEqual(
    naive({ ...base, open: false, mineCount: 0 }),
    decideDefaultFilter({ ...base, open: false, mineCount: 0 }),
  );
});

test("反例自证：漏掉「身份已知」这个前提，身份未到 + 「我的」有任务会误判成「全部」", () => {
  // 把 selfKnown 摘掉：mineCount 此时还是 0（`isAssignedToMe` 对空 myId 恒 false），
  // 于是会返回 "all" 并锁住 —— 正是发布版上用户看到的行为。这条必须与正确结果不同。
  const naive = (i: typeof base) =>
    !i.open || !i.dataReady || i.settled ? null : i.mineCount === 0 ? "all" : "mine";
  const late = { ...base, selfKnown: false, mineCount: 0 };
  assert.equal(naive(late), "all");
  assert.notEqual(naive(late), decideDefaultFilter(late));
});
