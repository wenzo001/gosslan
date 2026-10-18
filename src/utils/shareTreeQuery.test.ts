/**
 * 共享目录查询策略的判据（真实 QueryClient）。
 *
 * 重点不是缓存本身，而是那条业务不变量：**一棵树只能向它自己的主人要文件**。
 * 做法是把「这棵树属于谁」随数据一起缓存（`snapshot.friendId`），而不是点击时读当前会话。
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import { SHARE_TREE_QUERY, shareTreeKey, shareTreeQueryOptions } from "./shareTreeQuery.ts";
import type { ShareEntry } from "../types.ts";

const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient();
  clients.push(qc);
  return qc;
};
afterEach(() => {
  while (clients.length) clients.pop()?.clear();
});

const entry = (name: string): ShareEntry => ({ name, path: `/${name}`, is_dir: false, size: 1 });

test("按好友分键，且快照自带归属（下载不依赖当前会话）", async () => {
  const qc = client();
  const a = await qc.fetchQuery(shareTreeQueryOptions("A", async () => [entry("a.txt")]));
  const b = await qc.fetchQuery(shareTreeQueryOptions("B", async () => [entry("b.txt")]));

  assert.deepEqual(shareTreeKey("A"), [SHARE_TREE_QUERY, "A"]);
  assert.equal(a.friendId, "A");
  assert.equal(b.friendId, "B");
  assert.deepEqual(a.entries.map((e) => e.name), ["a.txt"]);
  assert.deepEqual(b.entries.map((e) => e.name), ["b.txt"]);
});

test("慢的 A 后到：只写回 A 的 key，B 的当前快照不被覆盖", async () => {
  const qc = client();
  let releaseA: (entries: ShareEntry[]) => void = () => {};
  const slowA = shareTreeQueryOptions(
    "A",
    () =>
      new Promise<ShareEntry[]>((resolve) => {
        releaseA = resolve;
      }),
  );

  const inFlight = qc.fetchQuery(slowA);
  await qc.fetchQuery(shareTreeQueryOptions("B", async () => [entry("b.txt")]));
  releaseA([entry("a.txt")]);
  await inFlight;

  assert.equal(qc.getQueryData<{ friendId: string }>(shareTreeKey("B"))?.friendId, "B");
  assert.equal(qc.getQueryData<{ friendId: string }>(shareTreeKey("A"))?.friendId, "A");
});
