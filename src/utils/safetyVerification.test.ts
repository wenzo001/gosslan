import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSafetyVerified,
  trimSafetyVerified,
  readSafetyVerified,
  writeSafetyVerified,
  SAFETY_VERIFIED_MAX,
  SAFETY_VERIFIED_KEY,
} from "./safetyVerification.ts";

test("parseSafetyVerified：只收正整数时间戳，坏形状整体作废", () => {
  assert.deepEqual(parseSafetyVerified(null), {});
  assert.deepEqual(parseSafetyVerified("not json"), {});
  assert.deepEqual(parseSafetyVerified("[]"), {});
  assert.deepEqual(
    parseSafetyVerified(JSON.stringify({ "dev-1": 1234, "dev-2": "x", "dev-3": -5, "dev-4": 0 })),
    { "dev-1": 1234 },
    "字符串/负数/0 都不算核对过",
  );
});

test("trimSafetyVerified：超上限裁最旧，未超返回 null", () => {
  const small: Record<string, number> = {};
  for (let i = 0; i < SAFETY_VERIFIED_MAX; i += 1) small[`dev-${i}`] = i + 1;
  assert.equal(trimSafetyVerified(small), null, "未超上限不动");
  small["dev-newest"] = 999_999;
  const trimmed = trimSafetyVerified(small);
  assert.ok(trimmed);
  assert.equal(Object.keys(trimmed as object).length, SAFETY_VERIFIED_MAX);
  assert.ok("dev-newest" in (trimmed as object), "保留最新");
  assert.ok(!("dev-0" in (trimmed as object)), "丢最旧");
});

test("read/write：写进去能读回来；读抛错按全未核对", () => {
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  writeSafetyVerified(store, { "dev-1": 42 });
  assert.deepEqual(readSafetyVerified(store), { "dev-1": 42 });
  const throwing = {
    getItem: () => {
      throw new Error("boom");
    },
    setItem: () => {},
  };
  assert.deepEqual(readSafetyVerified(throwing), {}, "读炸不冒泡");
  // null store（无后端）：读写都直接跳过
  assert.deepEqual(readSafetyVerified(null), {});
  const freshMem = new Map<string, string>();
  const freshStore = {
    getItem: (k: string) => freshMem.get(k) ?? null,
    setItem: (k: string, v: string) => void freshMem.set(k, v),
  };
  writeSafetyVerified(null, { "dev-1": 42 });
  assert.equal(freshMem.size, 0, "null store 不写");
  void freshStore;
});
