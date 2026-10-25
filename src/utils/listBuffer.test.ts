import { test } from "node:test";
import assert from "node:assert/strict";
import { computeListBuffer } from "./listBuffer.ts";

test("静止时只留库自带 overscan（不额外预渲染）", () => {
  const b = computeListBuffer({ viewport: 800, velocity: 0, avgRow: 80, overscan: 6 });
  assert.deepEqual(b, { forward: 0, backward: 0 });
});

test("向下甩：前进侧大于后退侧；向上甩反之", () => {
  const down = computeListBuffer({ viewport: 800, velocity: 400, avgRow: 80, overscan: 6 });
  assert.ok(down.forward > down.backward, JSON.stringify(down));
  const up = computeListBuffer({ viewport: 800, velocity: -400, avgRow: 80, overscan: 6 });
  assert.ok(up.backward > up.forward, JSON.stringify(up));
  assert.deepEqual(
    { forward: down.forward, backward: down.backward },
    { forward: up.backward, backward: up.forward },
  );
});

test("速度越快预渲染越多，但有硬上限（总行数 ≤ maxRows）", () => {
  const slow = computeListBuffer({ viewport: 800, velocity: 100, avgRow: 80, overscan: 6 });
  const fast = computeListBuffer({ viewport: 800, velocity: 1200, avgRow: 80, overscan: 6 });
  assert.ok(fast.forward >= slow.forward);
  const huge = computeListBuffer({ viewport: 800, velocity: 20000, avgRow: 24, overscan: 6, maxRows: 56 });
  const visible = Math.ceil(800 / 24);
  assert.ok(huge.forward + huge.backward + visible + 12 <= 56, JSON.stringify(huge));
});

test("坏输入不产生 NaN / 负数", () => {
  const b = computeListBuffer({ viewport: Number.NaN, velocity: Number.NaN, avgRow: 0, overscan: 6 });
  assert.ok(Number.isFinite(b.forward) && b.forward >= 0);
  assert.ok(Number.isFinite(b.backward) && b.backward >= 0);
});
