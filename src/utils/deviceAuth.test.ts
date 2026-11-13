import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_AUTH_CLAIM_KEYS, deviceAuthClaimKey, deviceAuthSecondsLeft } from "./deviceAuth.ts";

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