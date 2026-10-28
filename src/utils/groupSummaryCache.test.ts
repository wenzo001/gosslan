import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroupSummaryCache, type GroupFileSummary } from "./groupSummaryCacheCore.ts";

function fakeFetch() {
  const calls: string[] = [];
  let fail = 0;
  const fetch = async (transferId: string): Promise<GroupFileSummary> => {
    calls.push(transferId);
    if (fail > 0) {
      fail--;
      throw new Error("boom");
    }
    return { completed: calls.length, failed: 0, waiting: 0, cancelled: 0 };
  };
  return { calls, fetch, failNext(n: number) { fail = n; } };
}

test("同状态 TTL 内复用；状态变化 / 过期才重取", async () => {
  const f = fakeFetch();
  const c = createGroupSummaryCache(f.fetch, 10_000);
  await c.load("gfile-abc", "sending", 1_000);
  await c.load("gfile-abc", "sending", 5_000);
  assert.equal(f.calls.length, 1, "TTL 内重复挂载不许再发 IPC");

  await c.load("gfile-abc", "delivered", 5_500);
  assert.equal(f.calls.length, 2, "状态变了必须重取");

  await c.load("gfile-abc", "sending", 12_000);
  assert.equal(f.calls.length, 3, "超过 TTL 必须重取");
});

test("同键并发单飞；不同键互不阻塞", async () => {
  const f = fakeFetch();
  const c = createGroupSummaryCache(f.fetch, 10_000);
  const [a, b] = await Promise.all([
    c.load("gfile-1", "sending", 0),
    c.load("gfile-1", "sending", 0),
  ]);
  assert.equal(f.calls.length, 1, "同键并发只发一次");
  assert.deepEqual(a, b);
  await c.load("gfile-2", "sending", 0);
  assert.equal(f.calls.length, 2);
});

test("失败不缓存：下一次挂载会重试", async () => {
  const f = fakeFetch();
  const c = createGroupSummaryCache(f.fetch, 10_000);
  f.failNext(1);
  await assert.rejects(() => c.load("gfile-x", "sending", 0));
  const v = await c.load("gfile-x", "sending", 1);
  assert.deepEqual(v, { completed: 2, failed: 0, waiting: 0, cancelled: 0 });
  assert.equal(f.calls.length, 2, "第一次失败不许被钉成缓存");
});
