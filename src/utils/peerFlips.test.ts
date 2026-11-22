import assert from "node:assert/strict";
import { test } from "node:test";
import { advancePeerFlips, createPeerFlipState } from "./peerFlips.ts";

/** 启动首个快照：只喂 everSeen，不产生任何「回来了」（否则开屏满屏已上线）。 */
test("首个快照只建档，不产生翻转", () => {
  const st = createPeerFlipState();
  const flipped = advancePeerFlips(st, [{ device_id: "a" }, { device_id: "b" }]);
  assert.deepEqual(flipped, []);
  assert.ok(st.everSeen.has("a") && st.lastSnapshot.has("a"));
});

/** 离线 → 在线：上一轮有、本轮没有（消失）、再本轮出现 ⇒ 算「回来了」。 */
test("消失再出现才算回来", () => {
  const st = createPeerFlipState();
  advancePeerFlips(st, [{ device_id: "a" }]);
  advancePeerFlips(st, []); // a 离线
  assert.deepEqual(advancePeerFlips(st, [{ device_id: "a" }]), ["a"]);
});

/** 连续在线不翻；本轮消失后状态必须摘除（否则永远不算"回来"）。 */
test("连续在线不翻，消失会摘除", () => {
  const st = createPeerFlipState();
  advancePeerFlips(st, [{ device_id: "a" }]);
  assert.deepEqual(advancePeerFlips(st, [{ device_id: "a" }]), []);
  assert.deepEqual(advancePeerFlips(st, [{ device_id: "a" }]), []);
  advancePeerFlips(st, []);
  assert.ok(!st.lastSnapshot.has("a"), "本轮消失 ⇒ 从 lastSnapshot 摘除");
  assert.ok(st.everSeen.has("a"), "历史还在（下次出现算回来）");
});

/** 同轮既有人回又有人掉线：只报「回来」的那些。 */
test("同轮混合只报回来的人", () => {
  const st = createPeerFlipState();
  advancePeerFlips(st, [{ device_id: "a" }, { device_id: "b" }]);
  advancePeerFlips(st, [{ device_id: "a" }]); // b 掉线
  const flipped = advancePeerFlips(st, [{ device_id: "a" }, { device_id: "b" }]);
  assert.deepEqual(flipped, ["b"], "a 连续在线不翻，b 算回来");
});

/** 重复出现的 id（快照里同 id 两行）去重：同一次调用只报一次。 */
test("同轮重复 id 只报一次", () => {
  const st = createPeerFlipState();
  advancePeerFlips(st, [{ device_id: "a" }]);
  advancePeerFlips(st, []);
  const flipped = advancePeerFlips(st, [
    { device_id: "a" },
    { device_id: "a" },
  ]);
  assert.deepEqual(flipped, ["a"]);
});
