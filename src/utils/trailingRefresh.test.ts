import assert from "node:assert/strict";
import test from "node:test";
import { createTrailingRefresh, REALTIME_REFRESH_MS } from "./trailingRefresh.ts";

function fakeTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; cb: () => void }>();
  globalThis.setTimeout = ((cb: () => void, ms = 0) => {
    const id = ++seq;
    jobs.set(id, { at: now + ms, cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { jobs.delete(id); }) as typeof clearTimeout;
  return {
    tick(ms: number) {
      now += ms;
      for (const [id, job] of [...jobs]) if (job.at <= now) { jobs.delete(id); job.cb(); }
    },
    restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
  };
}

test("20 条突发在 150ms 尾沿最多一次 IPC", () => {
  const clock = fakeTimers();
  try {
    let calls = 0;
    const refresh = createTrailingRefresh(() => { calls += 1; });
    for (let i = 0; i < 20; i += 1) refresh.schedule();
    clock.tick(REALTIME_REFRESH_MS - 1);
    assert.equal(calls, 0);
    clock.tick(1);
    assert.equal(calls, 1);
  } finally { clock.restore(); }
});

test("反例：cancel 丢弃待执行，不冒充已刷新", () => {
  const clock = fakeTimers();
  try {
    let calls = 0;
    const refresh = createTrailingRefresh(() => { calls += 1; });
    refresh.schedule();
    refresh.cancel();
    clock.tick(REALTIME_REFRESH_MS);
    assert.equal(calls, 0);
  } finally { clock.restore(); }
});
