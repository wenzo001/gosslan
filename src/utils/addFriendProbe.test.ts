import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_MISS_PROBE_COOLDOWN_MS, shouldProbeOnSearchMiss } from "./addFriendProbe.ts";

test("搜索未命中且过了冷却 ⇒ 触发一次探测", () => {
  assert.equal(
    shouldProbeOnSearchMiss({ query: "abc", matches: 0, lastProbeAt: 0, now: 12_000 }),
    true,
  );
});

test("空关键词 / 有命中 / 冷却内 ⇒ 都不触发", () => {
  assert.equal(shouldProbeOnSearchMiss({ query: "   ", matches: 0, lastProbeAt: 0, now: 12_000 }), false);
  assert.equal(shouldProbeOnSearchMiss({ query: "abc", matches: 1, lastProbeAt: 0, now: 12_000 }), false);
  assert.equal(
    shouldProbeOnSearchMiss({
      query: "abc",
      matches: 0,
      lastProbeAt: 10_000,
      now: 10_000 + SEARCH_MISS_PROBE_COOLDOWN_MS - 1,
    }),
    false,
  );
});

test("冷却恰好到期 ⇒ 允许（边界不提前）", () => {
  assert.equal(
    shouldProbeOnSearchMiss({
      query: "abc",
      matches: 0,
      lastProbeAt: 10_000,
      now: 10_000 + SEARCH_MISS_PROBE_COOLDOWN_MS,
    }),
    true,
  );
});
