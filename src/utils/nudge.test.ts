import { test } from "node:test";
import assert from "node:assert/strict";
import { NUDGE_STALE_MS, isStaleNudge } from "./nudge.ts";

test("抖动迟到帧：60 秒边界内有效，过界/非法 ts 丢弃", () => {
  const now = 10_000_000;
  assert.equal(isStaleNudge(now, now), false);
  assert.equal(isStaleNudge(now - NUDGE_STALE_MS, now), false);
  assert.equal(isStaleNudge(now - NUDGE_STALE_MS - 1, now), true);
  assert.equal(isStaleNudge(0, now), true);
});
