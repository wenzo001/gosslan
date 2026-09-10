import { test } from "node:test";
import assert from "node:assert/strict";
import { haptic } from "./haptics.ts";

type VibrateCall = number | number[];

/**
 * 临时替换全局 navigator。
 * 注意：Node 21+ 的 `navigator` 是**只读 getter**，直接赋值会抛
 * "Cannot set property navigator"，必须用 defineProperty 重定义（用完还原）。
 */
function withNavigator(value: unknown, fn: () => void) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
  }
}

test("触觉：按语义映射到不同节奏（不是一律一个震法）", () => {
  const calls: VibrateCall[] = [];
  withNavigator(
    {
      vibrate: (p: VibrateCall) => {
        calls.push(p);
        return true;
      },
    },
    () => {
      haptic("light");
      haptic("selection");
      haptic("error");
    },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0], 8, "light 应是短促轻点");
  assert.equal(calls[1], 6, "selection 应更轻");
  assert.ok(Array.isArray(calls[2]) && (calls[2] as number[]).length === 5, "error 应是三连震");
});

test("触觉：不支持的平台（无 vibrate，如 iOS WKWebView/桌面）静默 no-op，不抛错", () => {
  withNavigator({}, () => {
    assert.doesNotThrow(() => haptic("medium"));
  });
});

test("触觉：vibrate 内部抛错（无 VIBRATE 权限/被策略拦截）也不能影响主流程", () => {
  withNavigator(
    {
      vibrate: () => {
        throw new Error("SecurityError: no VIBRATE permission");
      },
    },
    () => {
      assert.doesNotThrow(() => haptic("heavy"));
    },
  );
});
