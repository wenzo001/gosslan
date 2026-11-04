import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStoredReducedTransparency,
  resolveReducedTransparency,
} from "./reducedTransparency.ts";

test("减少透明：存储值只有 true/false；缺失/脏值 = 从未选择（null）", () => {
  assert.equal(parseStoredReducedTransparency("true"), true);
  assert.equal(parseStoredReducedTransparency("false"), false);
  assert.equal(parseStoredReducedTransparency(null), null);
  // 脏值不能被当成"用户选过" —— 否则系统偏好变化后界面不再跟随。
  assert.equal(parseStoredReducedTransparency("1"), null);
  assert.equal(parseStoredReducedTransparency("yes"), null);
});

test("减少透明：显式选择优先；从未选择时跟随系统；系统读不到 → 关闭", () => {
  assert.equal(resolveReducedTransparency(true, false), true, "显式开启必须压过系统关闭");
  assert.equal(resolveReducedTransparency(false, true), false, "显式关闭必须压过系统开启");
  assert.equal(resolveReducedTransparency(null, true), true, "未选择时跟随系统开启");
  assert.equal(resolveReducedTransparency(null, false), false, "未选择且系统读不到 → 关闭");
});
