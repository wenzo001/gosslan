import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "./concurrencyGate.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("并发闸：同时在飞不超过上限，且排队者按 FIFO 依次进入", async () => {
  const gate = createGate(2);
  let live = 0;
  let peak = 0;
  const d1 = deferred();
  const d2 = deferred();
  const d3 = deferred();
  const order: string[] = [];
  const run = (name: string, d: { promise: Promise<void> }) =>
    gate(async () => {
      order.push(`in:${name}`);
      live++;
      peak = Math.max(peak, live);
      await d.promise;
      live--;
      order.push(`out:${name}`);
    });
  const p1 = run("a", d1);
  const p2 = run("b", d2);
  const p3 = run("c", d3); // 排队
  await Promise.resolve();
  assert.deepEqual(order, ["in:a", "in:b"], "第三个必须还在排队");
  d1.resolve();
  await p1;
  await Promise.resolve();
  assert.deepEqual(order, ["in:a", "in:b", "out:a", "in:c"], "空出的槽位直接交给队首");
  d2.resolve();
  d3.resolve();
  await Promise.all([p2, p3]);
  assert.equal(peak, 2, "峰值并发必须 <= 上限");
  assert.equal(live, 0);
});

test("并发闸：任务抛错也必须释放槽位", async () => {
  const gate = createGate(1);
  await assert.rejects(() => gate(async () => { throw new Error("x"); }));
  // 槽位已释放：再来一个能立刻跑完（不挂起）。
  assert.equal(await gate(async () => 42), 42);
});
