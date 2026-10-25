import assert from "node:assert/strict";
import test from "node:test";
import {
  decideStall,
  UI_STALL_BANNER_MS,
  UI_STALL_ESCALATE_MS,
  UI_STALL_SNOOZE_MS,
} from "./uiStall.ts";
import type { InflightOp } from "./ipcTracker.ts";

const at = (startedAt: number): InflightOp => ({
  id: 1,
  cmd: "send_message",
  label: "send_message",
  startedAt,
});

test("9.9s 不提示（阈值 10s）", () => {
  assert.equal(decideStall([at(0)], UI_STALL_BANNER_MS - 100, 0), null);
});

test("刚过 10s：显示并给出秒数", () => {
  const v = decideStall([at(0)], UI_STALL_BANNER_MS, 0);
  assert.equal(v?.seconds, 10);
  assert.equal(v?.escalated, false);
  assert.equal(v?.label, "send_message");
});

test("30s 升级成更重的提示", () => {
  assert.equal(decideStall([at(0)], UI_STALL_ESCALATE_MS, 0)?.escalated, true);
});

test("「继续等待」的静默窗口内不再提示", () => {
  assert.equal(decideStall([at(0)], 40_000, 40_000 + UI_STALL_SNOOZE_MS), null);
});

test("空表不提示（没有等待就不该打扰）", () => {
  assert.equal(decideStall([], 99_999, 0), null);
});
