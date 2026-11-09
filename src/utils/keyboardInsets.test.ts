import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_SHRINK_PX, resolveKeyboardState } from "./keyboardInsets.ts";

const CLOSED = { base: 844, baseWidth: 390 };
const sample = (over: Partial<{ innerHeight: number; innerWidth: number; vvHeight: number; vvOffsetTop: number }>) => ({
  innerHeight: 844,
  innerWidth: 390,
  vvHeight: 844,
  vvOffsetTop: 0,
  ...over,
});

test("键盘收起：不补、不判开", () => {
  const s = resolveKeyboardState(sample({}), CLOSED, false);
  assert.equal(s.inset, 0);
  assert.equal(s.open, false);
});

test("iOS：布局视口不变、视觉视口缩了 ⇒ 补被盖住的高度", () => {
  const s = resolveKeyboardState(sample({ vvHeight: 544 }), CLOSED, false);
  assert.equal(s.inset, 300);
  assert.equal(s.open, true);
});

test("Android resize：布局已经缩到键盘之上 ⇒ 补量必须是 0（否则多出一段空隙）", () => {
  const s = resolveKeyboardState(sample({ innerHeight: 544, vvHeight: 544 }), CLOSED, true);
  assert.equal(s.inset, 0);
  assert.equal(s.open, true);
});

test("Android resize 但视觉视口仍差 40px：补量仍是 0，只判开", () => {
  const s = resolveKeyboardState(sample({ innerHeight: 544, vvHeight: 504 }), CLOSED, true);
  assert.equal(s.inset, 0);
  assert.equal(s.open, true);
});

test("Android 没 resize 但真被盖住（adjustPan 一类）：退回按 covered 补偿", () => {
  const s = resolveKeyboardState(sample({ vvHeight: 544 }), CLOSED, true);
  assert.equal(s.inset, 300);
  assert.equal(s.open, true);
});

test("阈值：布局只矮了不到 120px（工具栏抖动）不算键盘", () => {
  const s = resolveKeyboardState(sample({ innerHeight: 844 - (LAYOUT_SHRINK_PX - 1), vvHeight: 844 - (LAYOUT_SHRINK_PX - 1) }), CLOSED, true);
  assert.equal(s.open, false);
  assert.equal(s.inset, 0);
});

test("转屏：宽度变了就重置基线，不把变矮当键盘", () => {
  const s = resolveKeyboardState(sample({ innerWidth: 844, innerHeight: 390, vvHeight: 390 }), CLOSED, true);
  assert.equal(s.open, false);
  assert.equal(s.base, 390);
  assert.equal(s.baseWidth, 844);
});

test("键盘收起后基线回到最大高度（不会把键盘期的高度留成新基线）", () => {
  const open = resolveKeyboardState(sample({ innerHeight: 544, vvHeight: 544 }), CLOSED, true);
  const closed = resolveKeyboardState(sample({}), { base: open.base, baseWidth: open.baseWidth }, true);
  assert.equal(closed.open, false);
  assert.equal(closed.inset, 0);
  assert.equal(closed.base, 844);
});

test("首次调用（base=0）：把当前高度当基线，不把这一次判成键盘", () => {
  const s = resolveKeyboardState(sample({}), { base: 0, baseWidth: 0 }, true);
  assert.equal(s.open, false);
  assert.equal(s.inset, 0);
  assert.equal(s.base, 844);
  assert.equal(s.baseWidth, 390);
});
