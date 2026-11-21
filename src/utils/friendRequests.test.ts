/**
 * 「新朋友」过滤规则的单测 + 接线守卫。
 *
 * 用户 2026-09-12 真机实测：双方互发过申请、其中一方点了同意之后，另一方点进「新朋友」，
 * 那条申请**还在**。根因是"同意"的各条路径行为不一致（直连那条忘了清 pending），
 * 所以除了把路径统一，还要用**事实**兜一层：人已经是好友 ⇒ 申请不显示。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionableRequests, outgoingRequestExpired, FRIEND_REQUEST_EXPIRE_MS } from "./friendRequests.ts";

const req = (from: string) => ({ from, from_nickname: from, from_avatar: null, ts: 1 });

test("已是好友的申请被过滤掉（用户要求的那条规则）", () => {
  const list = [req("A"), req("B"), req("C")];
  const out = actionableRequests(list, ["B"]);
  assert.deepEqual(
    out.map((r) => r.from),
    ["A", "C"],
    "B 已经是好友 ⇒ 他的申请不该再出现",
  );
});

test("没有好友时全保留；好友列表里没有的人不受影响", () => {
  const list = [req("A"), req("B")];
  assert.equal(actionableRequests(list, []).length, 2);
  assert.equal(actionableRequests(list, ["X", "Y"]).length, 2);
});

test("顺序保持不变（列表顺序就是申请顺序）", () => {
  const list = [req("C"), req("A"), req("B")];
  assert.deepEqual(
    actionableRequests(list, ["A"]).map((r) => r.from),
    ["C", "B"],
  );
});

test("全部都是好友 → 列表清空（「新的朋友」回到空态）", () => {
  assert.deepEqual(actionableRequests([req("A"), req("B")], ["A", "B"]), []);
});

test("接线：store 的 pendingRequests 必须走这个纯函数（不能只信后端列表）", () => {
  const store = readFileSync(
    join(import.meta.dirname, "..", "stores", "useChatStore.ts"),
    "utf8",
  );
  assert.match(
    store,
    /const pendingRequests = computed\(\(\) =>\s*actionableRequests\(/,
    "pendingRequests 必须是「按好友过滤后的 computed」—— 直接暴露后端原始列表会让过期的申请一直挂在界面上",
  );
  assert.match(store, /const rawPendingRequests = ref<PendingRequest\[\]>\(\[\]\)/, "原始列表要单独存");
});

// J1-3（旅程走查 2026-11-20，用户 2026-11-21 拍板）：出站申请 7 天无回应判「已失效」。
// 判定时钟用 first_at（协议身份）而非 last_sent_at —— 补发引擎对方在线时每 30s 刷一次
// last_sent_at，按它判会永不失效。
test("outgoingRequestExpired：waiting 且首申请超 7 天才判失效", () => {
  const T0 = 1_800_000_000_000;
  const at = (age: number, status = "waiting", first_at = T0 - age) =>
    outgoingRequestExpired({ status, first_at }, T0);
  assert.equal(at(FRIEND_REQUEST_EXPIRE_MS), true, "正好 7 天 = 失效");
  assert.equal(at(FRIEND_REQUEST_EXPIRE_MS - 1), false, "差 1ms 未失效");
  assert.equal(at(FRIEND_REQUEST_EXPIRE_MS * 3), true, "挂了 21 天的");
  assert.equal(at(FRIEND_REQUEST_EXPIRE_MS, "withdrawn"), false, "已撤回不判失效");
  assert.equal(at(FRIEND_REQUEST_EXPIRE_MS, "waiting", 0), false, "坏时间戳不判");
});
