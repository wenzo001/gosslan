import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_TO_LATEST_MIN_GAP_PX,
  gapAtBottom,
  shouldShowBackToLatest,
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
