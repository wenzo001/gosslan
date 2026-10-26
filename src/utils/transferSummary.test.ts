import { test } from "node:test";
import assert from "node:assert/strict";
import { clampProgress } from "./transferSummary.ts";

test("越界进度被夹回 0..1，NaN 归零", () => {
  assert.equal(clampProgress(1.5), 1);
  assert.equal(clampProgress(-0.2), 0);
  assert.equal(clampProgress(Number.NaN), 0);
  assert.equal(clampProgress(undefined), 0);
  assert.equal(clampProgress(0.42), 0.42);
  // 越界值不能把进度条画成 140%。
  assert.equal(clampProgress(1.4), 1);
});
