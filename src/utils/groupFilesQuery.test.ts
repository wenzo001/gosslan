/**
 * 群文件查询策略的判据（真实 QueryClient，不 mock 缓存层）。
 *
 * 这些断言对应旧实现里那两句手工守卫的**语义**：
 * · 切群后旧响应不能回填 ⇒ 不同群是不同 key；
 * · 并发/重复请求 ⇒ 合并成一次；每次打开仍重拉（staleTime 0）；
 * · 刷新失败保留旧清单（`failed && files.length > 0` 走的仍是有数据的错误态）。
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import {
  GROUP_FILES_QUERY,
  groupFilesKey,
  groupFilesQueryOptions,
  invalidateGroupFiles,
} from "./groupFilesQuery.ts";
import type { GroupFileEntry } from "../types.ts";

function entry(id: string): GroupFileEntry {
  return {
    transfer_id: id,
    name: `${id}.bin`,
    size: 1,
    sender_id: "me",
    created_at: 0,
    local_state: "local",
    local_path: `/tmp/${id}`,
    delivered: 1,
    total: 1,
  };
}

// 每个 QueryClient 都挂着 5 分钟的 gc 定时器；不清掉 node:test 会等它自然到期才退出。
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient();
  clients.push(qc);
  return qc;
};
afterEach(() => {
  while (clients.length) clients.pop()?.clear();
});

test("按群分键：不同群各进各的缓存，键共享可前缀失效的根", async () => {
  const qc = client();
  const fetcher = async (id: string) => [entry(id)];
  await qc.fetchQuery(groupFilesQueryOptions("g1", fetcher));
  await qc.fetchQuery(groupFilesQueryOptions("g2", fetcher));

  assert.deepEqual(groupFilesKey("g1"), [GROUP_FILES_QUERY, "g1"]);
  assert.equal(qc.getQueryData<GroupFileEntry[]>(groupFilesKey("g1"))?.[0].transfer_id, "g1");
  assert.equal(qc.getQueryData<GroupFileEntry[]>(groupFilesKey("g2"))?.[0].transfer_id, "g2");
});

test("staleTime 0：同一群再次取数必须重新请求（面板每次打开都重拉）", async () => {
  const qc = client();
  let calls = 0;
  const opts = groupFilesQueryOptions("g1", async () => {
    calls += 1;
    return [entry("g1")];
  });
  await qc.fetchQuery(opts);
  await qc.fetchQuery(opts);
  assert.equal(calls, 2);
});

test("并发取同一个群只发一次请求（旧实现没有合并）", async () => {
  const qc = client();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opts = groupFilesQueryOptions("g1", async () => {
    calls += 1;
    await gate;
    return [entry("g1")];
  });

  const first = qc.fetchQuery(opts);
  const second = qc.fetchQuery(opts);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("重试一次后仍失败：保留上一次成功的数据，并给出 error 状态", async () => {
  const qc = client();
  let calls = 0;
  await qc.fetchQuery(
    groupFilesQueryOptions("g1", async () => {
      calls += 1;
      return [entry("keep")];
    }),
  );

  const failing = groupFilesQueryOptions("g1", async () => {
    calls += 1;
    throw new Error("ipc down");
  });
  await assert.rejects(qc.fetchQuery(failing));

  assert.equal(calls, 3, "1 次成功 + 失败后的 2 次尝试（retry 1）");
  assert.equal(qc.getQueryData<GroupFileEntry[]>(groupFilesKey("g1"))?.[0].transfer_id, "keep");
  const query = qc.getQueryCache().find({ queryKey: groupFilesKey("g1") });
  assert.equal(query?.state.status, "error");
});

test("事件失效只打当前群；不传群才命中所有群", async () => {
  const qc = client();
  const fetcher = async (id: string) => [entry(id)];
  await qc.fetchQuery(groupFilesQueryOptions("g1", fetcher));
  await qc.fetchQuery(groupFilesQueryOptions("g2", fetcher));

  await invalidateGroupFiles(qc, "g1");
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g1") })?.state.isInvalidated, true);
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g2") })?.state.isInvalidated, false);

  await invalidateGroupFiles(qc);
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g2") })?.state.isInvalidated, true);
});
