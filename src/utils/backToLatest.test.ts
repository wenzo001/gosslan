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

// ---------------- 位置恒定（2026-11-08 取代 11-06 的「按滚动位置避让」） ----------------
//
// 旧实现导出过 computeBackToLatestAvoidOffset / overlapArea / RectLike：按滚动位置实测
// 分割行、逐级上移按钮。运行时探针 --only=backjump 实测连滚 0→800px，按钮 top 序列
// 372 → 336 → 300 → 372（唯一值 3 个、跨度 72px）—— 就是用户报的"一直在上下跳动"。
// 现在位移只由 bottomOffset 决定，这里断言的正是"**不许有**跟随滚动位置的计算入口"：
// 把避让函数加回来，下面这条会红（模块级导出面变了）。
test("位移不再有「按滚动位置重算」的入口（把避让函数加回来必须红）", async () => {
  const mod = await import("./backToLatest.ts");
  for (const name of [
    "computeBackToLatestAvoidOffset",
    "overlapArea",
    "BACK_TO_LATEST_AVOID_GAP_PX",
    "BACK_TO_LATEST_AVOID_MAX_STEPS",
  ]) {
    assert.equal(name in mod, false, `backToLatest.ts 又导出了 ${name} —— 按钮会重新跟着滚动位置跳动`);
  }
});
