import { test } from "node:test";
import assert from "node:assert/strict";
import { clampImageBox } from "./imageAspect.ts";

const B = (w: number, h: number) => clampImageBox(w, h, 208, 288, 3);

test("普通比例：不裁、按真实比例落在框内", () => {
  const b = B(400, 300);
  assert.equal(b.cover, false);
  assert.equal(b.width, 208);
  assert.ok(Math.abs(b.height - 156) < 1);
});

test("超长竖图：夹到 1:3 并标裁切，宽度不再缩成细条", () => {
  const b = B(1080, 5000);
  assert.equal(b.cover, true);
  assert.equal(b.height, 288);
  assert.ok(Math.abs(b.width - 96) < 1, `width=${b.width}`);
});

test("超宽横图：夹到 3:1 并标裁切", () => {
  const b = B(5000, 1000);
  assert.equal(b.cover, true);
  assert.equal(b.width, 208);
  assert.ok(Math.abs(b.height - 69.33) < 0.1, `height=${b.height}`);
});

test("刚好 1:3 / 3:1 不判裁切（边界不抖）", () => {
  assert.equal(B(100, 300).cover, false);
  assert.equal(B(300, 100).cover, false);
});

test("未知尺寸：回退固定框且不裁", () => {
  assert.deepEqual(clampImageBox(0, 0, 208, 288), { width: 208, height: 288, cover: false });
});
