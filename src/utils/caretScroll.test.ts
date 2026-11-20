import { test } from "node:test";
import assert from "node:assert/strict";
import { caretScrollDelta } from "./caretScroll.ts";

const box = { top: 100, bottom: 200 };

test("光标在可视区中间：不滚动（每敲一个字符都不许抖）", () => {
  assert.equal(caretScrollDelta({ top: 140, bottom: 160 }, box), 0);
});

test("回车后光标落到下沿外：往下滚，且留 pad 余量", () => {
  // 新行底边 220，可视下沿 200 ⇒ 需要 28（20 越界 + 8 余量）
  assert.equal(caretScrollDelta({ top: 200, bottom: 220 }, box), 28);
});

test("上沿越界（在长文本顶部换行 / 删行）：往上滚，增量是负的", () => {
  // 光标上沿 90，可视上沿 100 ⇒ -18（10 越界 + 8 余量）
  assert.equal(caretScrollDelta({ top: 90, bottom: 106 }, box), -18);
});

test("pad 内侧：留够余量才算可见（临界值不会来回跳）", () => {
  assert.equal(caretScrollDelta({ top: 109, bottom: 190 }, box), 0, "刚过 pad 线 ⇒ 不滚");
  assert.equal(caretScrollDelta({ top: 105, bottom: 190 }, box), -3, "在 pad 线内侧 ⇒ 只补回差的那 3px，不多滚");
});

test("同一份坐标下上/下不会同时触发：返回单一方向的增量", () => {
  // 高度小于可视区时不可能两沿都越界；这里钉住"取先命中的那一支"的语义
  const d = caretScrollDelta({ top: 90, bottom: 210 }, box);
  assert.ok(d > 0, "两沿都越界时按下沿处理（先保证最新输入那行可见）");
});
