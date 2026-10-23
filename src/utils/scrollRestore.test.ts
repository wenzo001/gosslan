import assert from "node:assert/strict";
import test from "node:test";
import {
  SCROLL_RESTORE_TTL_MS,
  shouldRestoreScroll,
  type SavedScroll,
} from "./scrollRestore.ts";

const T0 = 1_700_000_000_000;
const saved = (over: Partial<SavedScroll> = {}): SavedScroll => ({
  top: 420,
  at: T0,
  atBottom: false,
  ...over,
});

test("刚离开就回来：恢复原像素位置", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + 5_000, false), true);
});

test("边界停在恰好 3 分钟：仍然恢复（阈值那一格走「仍算刚离开」）", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + SCROLL_RESTORE_TTL_MS, false), true);
});

test("超过 3 分钟：不恢复（回到底部看最新）", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + SCROLL_RESTORE_TTL_MS + 1, false), false);
});

test("来新消息触发未读：位置让给未读，即使刚离开也不恢复", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + 1_000, true), false);
});

test("离开时本来就在底部：回来贴底，哪怕只离开 1 秒", () => {
  assert.equal(shouldRestoreScroll(saved({ atBottom: true }), T0 + 1_000, false), false);
});

test("没有保存过：不恢复（交给默认贴底）", () => {
  assert.equal(shouldRestoreScroll(undefined, T0, false), false);
});

// 三个出口互相独立：把任意一条规则摘掉，上面都至少有一格会红。
test("三个出口各自都能独立生效（互不掩盖）", () => {
  const fresh = saved();
  assert.equal(shouldRestoreScroll(fresh, T0 + 1, false), true);
  assert.equal(shouldRestoreScroll({ ...fresh, atBottom: true }, T0 + 1, false), false);
  assert.equal(shouldRestoreScroll(fresh, T0 + 1, true), false);
  assert.equal(shouldRestoreScroll(fresh, T0 + SCROLL_RESTORE_TTL_MS + 1, false), false);
});
