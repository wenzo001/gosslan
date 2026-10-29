import test from "node:test";
import assert from "node:assert/strict";
import { isWaitingForPeer, isTransferBacked, WAITING_FOR_PEER_AFTER_MS } from "./sendWaiting.ts";

const T0 = 1_790_000_000_000;

test("到点才翻：刚好卡在阈值两侧（边界两侧各一格）", () => {
  const at = (ago: number, extra: Partial<{ status: string; msgId: string }> = {}) =>
    isWaitingForPeer({ status: "sending", ts: T0 - ago, ...extra }, T0);
  assert.equal(at(WAITING_FOR_PEER_AFTER_MS - 1), false, "差 1ms 仍算正在发");
  assert.equal(at(WAITING_FOR_PEER_AFTER_MS), true, "到阈值就翻");
  assert.equal(at(27 * 3600_000), true, "真机实测那种挂了 27 小时的");
});

test("非 sending 一律不翻（送达链上的状态不许被这条改写）", () => {
  for (const status of ["sent", "delivered", "read", "failed", "cancelled", "recalled"]) {
    assert.equal(isWaitingForPeer({ status, ts: T0 - 3600_000 }, T0), false, status);
  }
});

test("文件类消息不翻：传输期间本来就是 sending，大文件传十分钟很正常", () => {
  assert.equal(isTransferBacked("file-abc"), true);
  assert.equal(isTransferBacked("gfile-abc"), true);
  assert.equal(isTransferBacked("m-abc"), false);
  assert.equal(isTransferBacked(undefined), false);
  assert.equal(
    isWaitingForPeer({ status: "sending", ts: T0 - 3600_000, msgId: "file-abc" }, T0),
    false,
  );
  assert.equal(
    isWaitingForPeer({ status: "sending", ts: T0 - 3600_000, msgId: "gfile-abc" }, T0),
    false,
  );
});

test("没有可信时间戳时不翻（宁可不显示，也不要说错）", () => {
  assert.equal(isWaitingForPeer({ status: "sending", ts: 0 }, T0), false);
  assert.equal(isWaitingForPeer({ status: "sending", ts: -1 }, T0), false);
  // 时钟回拨（ts 在未来）同样不许翻
  assert.equal(isWaitingForPeer({ status: "sending", ts: T0 + 60_000 }, T0), false);
});
