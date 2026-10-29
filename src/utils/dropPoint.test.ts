import test from "node:test";
import assert from "node:assert/strict";
import { dropPointToCss } from "./dropPoint.ts";

/**
 * 这条钉住"两个平台量纲不同"这件事：macOS 的点就是 CSS px（不除），Windows 是物理像素（除）。
 * 写反一侧的表现是"拖到正经位置不高亮、偏过去才高亮"（2026-10-29 在 Mac 上实测到）。
 */
test("macOS：拖拽坐标已经是点 ⇒ 原样返回（不再除 DPR）", () => {
  const p = { x: 820, y: 300 };
  assert.deepEqual(dropPointToCss(p, { mac: true, dpr: 2 }), p);
  assert.deepEqual(dropPointToCss(p, { mac: true, dpr: 1 }), p);
});

test("Windows：物理像素 ⇒ 除以 DPR", () => {
  assert.deepEqual(dropPointToCss({ x: 1640, y: 600 }, { mac: false, dpr: 2 }), { x: 820, y: 300 });
  assert.deepEqual(dropPointToCss({ x: 820, y: 300 }, { mac: false, dpr: 1 }), { x: 820, y: 300 });
});

test("DPR 读不到（0/NaN）时按 1 处理，绝不除出 Infinity", () => {
  for (const dpr of [0, Number.NaN]) {
    const p = dropPointToCss({ x: 100, y: 50 }, { mac: false, dpr });
    assert.equal(Number.isFinite(p.x), true, `dpr=${dpr} 不能算出非有限值`);
    assert.equal(p.x, 100);
  }
});
