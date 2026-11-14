import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_AUTH_ALWAYS_DISCLOSED,
  DEVICE_AUTH_CLAIM_KEYS,
  createPendingGuard,
  deviceAuthClaimKey,
  deviceAuthSecondsLeft,
  disclosedClaims,
  guardClear,
  guardConsume,
  guardRefresh,
  guardSetPending,
} from "./deviceAuth.ts";
import type { DeviceAuthPrompt } from "@/types";

/** 造一份确认页数据（只填守卫/披露用得到的字段）。 */
function prompt(requestId: string, requested: string[] = ["device_subject"]): DeviceAuthPrompt {
  return {
    request_id: requestId,
    rp_origin: "https://app.example.com",
    client_id: "com.example.product",
    display_name: "示例",
    action: "link",
    account_hint: "",
    requested_claims: requested,
    expires_at_ms: 4_000_000_000_000,
    nickname_default: false,
  };
}

test("deviceAuthClaimKey：allowlist 三项映射到文案 key，未知原样返回（不静默吞）", () => {
  assert.equal(deviceAuthClaimKey("device_subject"), "deviceAuth.claim.device_subject");
  assert.equal(deviceAuthClaimKey("device_public_key"), "deviceAuth.claim.device_public_key");
  assert.equal(deviceAuthClaimKey("nickname"), "deviceAuth.claim.nickname");
  assert.equal(deviceAuthClaimKey("phone_number"), "phone_number");
  // 映射表只覆盖首期 allowlist 三项（与后端 ALLOWED_CLAIMS 同口径）。
  assert.deepEqual(Object.keys(DEVICE_AUTH_CLAIM_KEYS).sort(), ["device_public_key", "device_subject", "nickname"]);
});

test("deviceAuthSecondsLeft：向上取整、过期恒 0、不为负", () => {
  assert.equal(deviceAuthSecondsLeft(10_000, 0), 10);
  assert.equal(deviceAuthSecondsLeft(10_500, 1_000), 10); // 9.5s → 10
  assert.equal(deviceAuthSecondsLeft(10_000, 9_999), 1); // 不足 1s 按 1（不提前显示过期）
  assert.equal(deviceAuthSecondsLeft(10_000, 10_000), 0);
  assert.equal(deviceAuthSecondsLeft(10_000, 20_000), 0); // 已过期不为负
});

// ---------------- #4 恒发披露 ----------------

test("disclosedClaims：只请求 nickname 也恒披露 device_subject/device_public_key（#4 核心反例）", () => {
  // 这正是 #4 的缺陷形状：RP 只请求 nickname，旧确认页只列 nickname，漏掉恒发的 subject/公钥。
  assert.deepEqual(disclosedClaims(["nickname"]), ["device_subject", "device_public_key", "nickname"]);
  // 空请求也恒披露两项。
  assert.deepEqual(disclosedClaims([]), ["device_subject", "device_public_key"]);
  // 已含恒发项时去重，不重复列出。
  assert.deepEqual(
    disclosedClaims(["device_subject", "device_public_key", "nickname"]),
    ["device_subject", "device_public_key", "nickname"],
  );
  // 恒发项与后端断言口径一致（allowlist 的两项绑定必需 claim）。
  assert.deepEqual([...DEVICE_AUTH_ALWAYS_DISCLOSED], ["device_subject", "device_public_key"]);
});

// ---------------- #8 代际守卫 ----------------

test("guard：setPending/clear 推进代际，异步回填凭代际对账（#8）", () => {
  const g = createPendingGuard();
  assert.equal(g.generation, 0);
  assert.equal(g.pending, null);

  guardSetPending(g, prompt("req-1"));
  assert.equal(g.generation, 1);
  assert.equal(g.pending?.request_id, "req-1");

  // 刷新（同一事务）：代际未变 ⇒ 生效，且**不**推进代际（否则会误伤在途批准）。
  const captured = g.generation;
  assert.equal(guardRefresh(g, captured, prompt("req-1")), true);
  assert.equal(g.generation, captured, "刷新不推进代际");

  // 清数据：推进代际，pending 清空。
  guardClear(g);
  assert.equal(g.pending, null);
  assert.equal(g.generation, captured + 1);

  // 反例：清数据后，出发前 capture 的旧刷新结果必须被丢弃，绝不复活已清事务。
  assert.equal(guardRefresh(g, captured, prompt("req-1")), false);
  assert.equal(g.pending, null, "旧代际刷新不许复活已清事务");
  // 反例：旧代际的消费也不许清掉新事务。
  guardSetPending(g, prompt("req-2"));
  const gen2 = g.generation;
  assert.equal(guardConsume(g, captured), false, "旧代际消费不生效");
  assert.equal(g.pending?.request_id, "req-2", "新事务不被旧消费清掉");
  // 当前代际消费：生效并推进代际。
  assert.equal(guardConsume(g, gen2), true);
  assert.equal(g.pending, null);
  assert.equal(g.generation, gen2 + 1);
});

test("guard：新事务到达后旧批准结果不得清掉新确认页（#8 竞态反例）", () => {
  const g = createPendingGuard();
  guardSetPending(g, prompt("req-old"));
  const capturedOld = g.generation;
  // 批准 req-old 仍在途时，新深链 req-new 到达。
  guardSetPending(g, prompt("req-new"));
  // req-old 的批准这时才返回：代际已变 ⇒ 不许清掉 req-new 的确认页。
  assert.equal(guardConsume(g, capturedOld), false);
  assert.equal(g.pending?.request_id, "req-new");
});