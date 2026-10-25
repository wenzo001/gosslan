import assert from "node:assert/strict";
import test from "node:test";
import { beginOp, endOp, inflightOps } from "./ipcTracker.ts";

test("set_channel_enabled 的标签带上通道名（卡死归因要看得出是不是蓝牙）", () => {
  const id = beginOp("set_channel_enabled", { channel: "bluetooth" });
  const done = endOp(id);
  assert.equal(done?.label, "set_channel_enabled(bluetooth)");
});

test("心跳与慢调用上报不进追踪表（防止自我递归/自噪声）", () => {
  assert.equal(beginOp("ui_heartbeat"), 0);
  assert.equal(beginOp("report_frontend_slow_op"), 0);
  assert.equal(endOp(0), null);
});

test("在途表只留未结束的操作", () => {
  const before = inflightOps().length;
  const id = beginOp("get_messages");
  assert.equal(inflightOps().length, before + 1);
  endOp(id);
  assert.equal(inflightOps().length, before);
});
