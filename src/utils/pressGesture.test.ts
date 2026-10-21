import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_PRESS_MS, PRESS_MOVE_TOLERANCE, movedBeyondTolerance } from "./pressGesture.ts";

/**
 * 列表行长按的两个真机事故（用户 2026-09-13 Android 实测）在纯判据这一层的形状：
 * 「按住不动能弹菜单」「滑列表时不该弹」—— 后者曾经因为只看 dx 而失效。
 */

test("容差边界：恰好 10px 仍算按压，超过 10px 才取消", () => {
  const from = { x: 100, y: 100 };
  assert.equal(movedBeyondTolerance(from, { x: 110, y: 100 }), false, "恰好 10px 是边界，不许取消");
  assert.equal(movedBeyondTolerance(from, { x: 110.5, y: 100 }), true);
  assert.equal(movedBeyondTolerance(from, { x: 100, y: 100 }), false, "没动就是按压");
});

test("纵向滚动同样取消长按（不是只看 dx）", () => {
  // 只看 dx 的旧写法在这里返回 false ⇒ 手指竖着滚列表仍会弹菜单（真机复现过）
  assert.equal(movedBeyondTolerance({ x: 50, y: 50 }, { x: 50, y: 61 }), true);
  assert.equal(movedBeyondTolerance({ x: 50, y: 50 }, { x: 50, y: 55 }), false);
});

test("斜向按欧氏距离算：dx=8 dy=8 已经超出 10px", () => {
  // 单轴取最大值会是 8（< 10，判成按压）；实际位移 11.3px，属于滑动
  assert.equal(movedBeyondTolerance({ x: 0, y: 0 }, { x: 8, y: 8 }), true);
});

test("容差可注入（只为测试）：传 0 时任何位移都取消", () => {
  assert.equal(movedBeyondTolerance({ x: 0, y: 0 }, { x: 0.1, y: 0 }, 0), true);
  assert.equal(movedBeyondTolerance({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), false);
});

test("阈值就是设计里的 500ms / 10px —— 改它们等于改手感，必须是有意的", () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(PRESS_MOVE_TOLERANCE, 10);
});
