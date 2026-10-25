import assert from "node:assert/strict";
import test from "node:test";
import { decideBleAutostart } from "./crashLoop.ts";

const base = {
  manual: false,
  heldReason: null as string | null,
  report: null as { bleSuspect: boolean } | null,
  reportUnreadable: false,
};

test("手动入口永远放行（用户明确要用）", () => {
  assert.deepEqual(
    decideBleAutostart({ ...base, manual: true, reportUnreadable: true }),
    { start: true, reason: null },
  );
});

test("后端 hold 优先于报告：启动即熔断", () => {
  assert.deepEqual(decideBleAutostart({ ...base, heldReason: "上次运行在蓝牙模块崩溃" }), {
    start: false,
    reason: "上次运行在蓝牙模块崩溃",
  });
});

test("读不到报告 ⇒ fail-closed（不自动开）", () => {
  assert.equal(decideBleAutostart(base).start, false);
  assert.equal(decideBleAutostart({ ...base, reportUnreadable: true }).start, false);
});

test("崩溃点在蓝牙 ⇒ 本次不自动开", () => {
  assert.deepEqual(decideBleAutostart({ ...base, report: { bleSuspect: true } }), {
    start: false,
    reason: "ble_suspect",
  });
});

test("干净报告 ⇒ 照常自动开", () => {
  assert.deepEqual(decideBleAutostart({ ...base, report: { bleSuspect: false } }), {
    start: true,
    reason: null,
  });
});
