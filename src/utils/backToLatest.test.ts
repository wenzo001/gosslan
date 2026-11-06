import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_TO_LATEST_AVOID_GAP_PX,
  BACK_TO_LATEST_AVOID_MAX_STEPS,
  BACK_TO_LATEST_MIN_GAP_PX,
  computeBackToLatestAvoidOffset,
  gapAtBottom,
  overlapArea,
  shouldShowBackToLatest,
  type RectLike,
} from "./backToLatest.ts";

test("离底判据只认真的离底（删掉阈值比较会红）", () => {
  // 阈值与 VirtualList 的 NEAR_BOTTOM_THRESHOLD 同口径：按钮出现时机保持旧行为。
  assert.equal(BACK_TO_LATEST_MIN_GAP_PX, 150);

  // 反例锚点：贴底/微抖（gap 0~150）一律不显示 —— 旧实现按陈旧的 pinned 判定，
  // 用户滚回底部后按钮仍留着，正好压住最新那条图片。
  for (const gap of [0, 1, 60, 149, 150]) {
    assert.equal(shouldShowBackToLatest(gap), false, `gap=${gap} 不该显示`);
  }
  // 真正离底才显示。
  for (const gap of [151, 200, 4096]) {
    assert.equal(shouldShowBackToLatest(gap), true, `gap=${gap} 应该显示`);
  }
  // 量不到（NaN/Infinity）时宁可不显示，也不猜。
  assert.equal(shouldShowBackToLatest(Number.NaN), false);
  assert.equal(shouldShowBackToLatest(Number.POSITIVE_INFINITY), false);
});

test("gapAtBottom 现算离底距离，overscroll 夹到 0（回退成负值会红）", () => {
  assert.equal(gapAtBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 600 }), 0);
  assert.equal(gapAtBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 600 }), 100);
  // 内容收缩后浏览器把 scrollTop 夹到新最大值 ⇒ 间隙必须仍是非负。
  assert.equal(gapAtBottom({ scrollHeight: 590, scrollTop: 600, clientHeight: 500 }), 0);
});

// ---------------- 避让分割行（2026-11-06 用户拍板） ----------------

/** 基准位按钮：36×36，`bottom-4`(16px)，消息区底边 800 ⇒ 748..784。 */
const BTN: RectLike = { top: 748, bottom: 784, left: 602, right: 638 };
/** 时间分割行：通栏，行高 38.5（`pt-3.5 + pb-2 + caption`）。 */
const DIV = (top: number, h = 38.5): RectLike => ({ top, bottom: top + h, left: 0, right: 1280 });

test("按钮可见时与分割行文字的重叠面积为 0（把避让关掉必须红）", () => {
  // 反例锚点：分割行正好落在按钮的底部带里（top 748 = 按钮上沿）。
  const hit = DIV(748);
  // 不避让（offset=0）时确实压字 —— 这条断言就是"关掉避让必须红"的判据。
  assert.ok(overlapArea(BTN, hit) > 0, "构造场景失效：分割行没有落在按钮矩形内");

  const offset = computeBackToLatestAvoidOffset(BTN, [hit]);
  assert.equal(offset, hit.bottom - hit.top + BACK_TO_LATEST_AVOID_GAP_PX); // 38.5 + 8
  const moved = { ...BTN, top: BTN.top - offset, bottom: BTN.bottom - offset };
  assert.equal(overlapArea(moved, hit), 0, "避让后仍然压字");
});

test("分割行不与按钮相交时保持基准位（避免永远抬高压正文）", () => {
  // 分割行整行都在按钮上方（bottom 738.5 < 748）。
  assert.equal(computeBackToLatestAvoidOffset(BTN, [DIV(700)]), 0);
  // 完全在按钮下方（虚拟列表 overscan 的视口外行）。
  assert.equal(computeBackToLatestAvoidOffset(BTN, [DIV(800)]), 0);
  // 没有分割行。
  assert.equal(computeBackToLatestAvoidOffset(BTN, []), 0);
});

test("连续两行分割行会级联上移，直到重叠为 0", () => {
  const first = DIV(748);
  const second = DIV(694); // 第一步之后按钮落到 701.5..737.5，正好压到第二行
  const offset = computeBackToLatestAvoidOffset(BTN, [first, second]);
  const moved = { ...BTN, top: BTN.top - offset, bottom: BTN.bottom - offset };
  assert.equal(overlapArea(moved, first), 0);
  assert.equal(overlapArea(moved, second), 0);
});

test("最多上移 3 步：走满上限就停手，不无限抬高", () => {
  assert.equal(BACK_TO_LATEST_AVOID_MAX_STEPS, 3);
  // 叠 4 行、行距正好等于一步（46.5），走满 3 步仍会压着第 4 行 —— 上限必须封顶在 3 步。
  const stacked = [DIV(748), DIV(701.5), DIV(655), DIV(608.5)];
  const max = 3 * (38.5 + BACK_TO_LATEST_AVOID_GAP_PX);
  assert.equal(computeBackToLatestAvoidOffset(BTN, stacked), max);
  assert.equal(computeBackToLatestAvoidOffset(BTN, stacked, 10), 4 * (38.5 + BACK_TO_LATEST_AVOID_GAP_PX));
});
