import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import type { BotView } from "@/types";
import { BOTS_QUERY_KEY, fetchBots } from "./botsQuery.ts";

const clients: QueryClient[] = [];
afterEach(() => { while (clients.length) clients.pop()?.clear(); });
const client = () => { const qc = new QueryClient(); clients.push(qc); return qc; };

test("同窗多入口并发复用 [\"bots\"]：只打一次 botList", async () => {
  const qc = client();
  let calls = 0;
  let release!: (bots: BotView[]) => void;
  const gate = new Promise<BotView[]>((resolve) => { release = resolve; });
  const fetcher = () => { calls += 1; return gate; };
  const a = fetchBots(qc, fetcher);
  const b = fetchBots(qc, fetcher);
  assert.deepEqual(BOTS_QUERY_KEY, ["bots"]);
  assert.equal(calls, 1);
  release([]);
  assert.deepEqual(await a, []);
  assert.deepEqual(await b, []);
});

test("边界自证：不同窗口 QueryClient 不共享，仍需后端 single-flight", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return []; };
  await Promise.all([fetchBots(client(), fetcher), fetchBots(client(), fetcher)]);
  assert.equal(calls, 2);
});
