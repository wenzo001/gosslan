import test from "node:test";
import assert from "node:assert/strict";
import { isWaitingForPeer, isTransferBacked, countWaitingTexts, WAITING_FOR_PEER_AFTER_MS } from "./sendWaiting.ts";

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

// J2-5（旅程走查 2026-11-20）：发送那一刻就知道对端离线 ⇒ 排队态立即翻面，
// 不再等满 2 分钟（前 2 分钟"对方离线"与"正在发"此前视觉不可分）。
test("对端明确离线 ⇒ 立即翻，不等 2 分钟", () => {
  const at = (ago: number, peerOnline: boolean | null | undefined) =>
    isWaitingForPeer({ status: "sending", ts: T0 - ago, peerOnline }, T0);
  // 刚发出 1 秒、对端明确离线 ⇒ 立即是排队态（时钟 + 等待文案）
  assert.equal(at(1_000, false), true, "明确离线 ⇒ 立即翻");
  // 在线 / 未知（null）/ 未传（undefined）⇒ 保持原时间口径，1 秒仍是正在发
  assert.equal(at(1_000, true), false, "在线 ⇒ 仍按时间");
  assert.equal(at(1_000, null), false, "无在线概念（群/机器人/自己）⇒ 仍按时间");
  assert.equal(at(1_000, undefined), false, "没传 ⇒ 仍按时间（旧调用点行为不变）");
  // 离线但过了 2 分钟 ⇒ 照样翻（结果一致，只是路径不同）
  assert.equal(at(WAITING_FOR_PEER_AFTER_MS, false), true);
  // 离线判据不许越过其它守门：文件类 / 非 sending / 坏时间戳仍不翻
  assert.equal(
    isWaitingForPeer({ status: "sending", ts: T0 - 1_000, msgId: "file-abc", peerOnline: false }, T0),
    false,
    "文件类传输不翻",
  );
  assert.equal(
    isWaitingForPeer({ status: "sent", ts: T0 - 1_000, peerOnline: false }, T0),
    false,
    "非 sending 不翻",
  );
  assert.equal(
    isWaitingForPeer({ status: "sending", ts: 0, peerOnline: false }, T0),
    false,
    "坏时间戳不翻",
  );
});

// J2-3：对端上线时说得出「排队的 N 条将陆续送达」—— 计数与 isWaitingForPeer 同一排除口径。
test("countWaitingTexts：只数文本类 sending，文件与终态不算", () => {
  const msgs = [
    { status: "sending", msg_id: "m-1" },
    { status: "sending", msg_id: "m-2" },
    { status: "sending", msg_id: "file-x" }, // 传输 backed 不算
    { status: "sending", msg_id: "gfile-y" }, // 群文件不算
    { status: "delivered", msg_id: "m-3" }, // 已推进不算
    { status: "failed", msg_id: "m-4" }, // 终态不算
  ];
  assert.equal(countWaitingTexts(msgs), 2);
  assert.equal(countWaitingTexts([]), 0);
  assert.equal(countWaitingTexts([{ status: "sending", msg_id: null }]), 1, "乐观期 msg_id 为空也按文本算");
});
