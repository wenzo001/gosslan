import assert from "node:assert/strict";
import { test } from "node:test";
import { flipTransform, type ImageRect } from "./imageZoom.ts";

const rect = (left: number, top: number, width: number, height: number): ImageRect => ({
  left,
  top,
  width,
  height,
});

/**
 * 把"以中心为原点缩放 + 平移"的映射算回视觉矩形，用来断言**结果**（不是断言那几个系数）：
 * 系数写错时，只有还原成矩形才能一眼看出"第一帧其实没盖住缩略图"。
 */
function mapped(rectIn: ImageRect, origin: ImageRect): ImageRect {
  const t = flipTransform(rectIn, origin);
  const cx = rectIn.left + rectIn.width / 2;
  const cy = rectIn.top + rectIn.height / 2;
  return {
    left: cx + (rectIn.left - cx) * t.scaleX + t.x,
    top: cy + (rectIn.top - cy) * t.scaleY + t.y,
    width: rectIn.width * t.scaleX,
    height: rectIn.height * t.scaleY,
  };
}

test("同宽高比：第一帧的视觉矩形必须精确等于缩略图矩形", () => {
  const big = rect(0, 0, 640, 360);
  const thumb = rect(160, 90, 320, 180);
  const t = flipTransform(big, thumb);
  assert.equal(t.scaleX, 0.5);
  assert.equal(t.scaleY, 0.5);
  // 两边中心重合 ⇒ 不需要任何平移；有平移就说明"从别处滑进来"
  assert.equal(t.x, 0);
  assert.equal(t.y, 0);
  const m = mapped(big, thumb);
  assert.deepEqual(m, thumb);
});

test("不同宽高比：双轴各自缩放，中心对齐后四边严丝合缝", () => {
  const big = rect(100, 50, 800, 400);
  const thumb = rect(20, 300, 200, 150);
  const t = flipTransform(big, thumb);
  assert.equal(t.scaleX, 0.25);
  assert.equal(t.scaleY, 0.375);
  assert.equal(t.x, -380);
  assert.equal(t.y, 125);
  const m = mapped(big, thumb);
  assert.equal(m.left, 20);
  assert.equal(m.top, 300);
  assert.equal(m.width, 200);
  assert.equal(m.height, 150);
});

test("缩略图在右侧偏下：横向位移只用于对齐中心，量级由两条中心线的差决定", () => {
  const big = rect(58, 57.5, 640, 360); // 查看器里图片的落定矩形（中心 378 / 237.5）
  const thumb = rect(274, 285, 208, 117); // 屏幕底部居中的缩略图（中心 378 / 343.5）
  const t = flipTransform(big, thumb);
  // 水平中心本来就重合 ⇒ 横向分量恰好 0（"向右一下"在这一格里无处可藏）
  assert.equal(t.x, 0);
  assert.equal(t.y, 106, "纵向位移必须把 237.5 的中心送到 343.5，差 106");
  const m = mapped(big, thumb);
  assert.equal(m.left, 274);
  assert.equal(m.top, 285);
  assert.equal(m.width, 208);
  assert.equal(m.height, 117);
});

test("退化：缩略图矩形与落定矩形完全一致时是恒等变换（不缩放、不位移）", () => {
  const big = rect(10, 20, 300, 200);
  const t = flipTransform(big, big);
  assert.deepEqual(t, { scaleX: 1, scaleY: 1, x: 0, y: 0 });
});
