/**
 * 群文件查询键的判据（真实 QueryClient，不 mock 缓存层）。
 *
 * 这些断言对应旧实现里那两句手工守卫的**语义**：
 * · 切群后旧响应不能回填 ⇒ 不同群是不同 key；
 * · 事件失效只打当前打开的那个群。
 *
 * 重拉/重试/并发合并属于 `PANEL_QUERY_POLICY` 的通用语义，判据在 `panelQuery.test.ts`，
 * 不在这里重复。
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import {
  GROUP_FILES_QUERY,
  groupFilesKey,
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
  await qc.fetchQuery({ queryKey: groupFilesKey("g1"), queryFn: () => fetcher("g1") });
  await qc.fetchQuery({ queryKey: groupFilesKey("g2"), queryFn: () => fetcher("g2") });

  assert.deepEqual(groupFilesKey("g1"), [GROUP_FILES_QUERY, "g1"]);
  assert.equal(qc.getQueryData<GroupFileEntry[]>(groupFilesKey("g1"))?.[0].transfer_id, "g1");
  assert.equal(qc.getQueryData<GroupFileEntry[]>(groupFilesKey("g2"))?.[0].transfer_id, "g2");
});

test("事件失效只打当前群；不传群才命中所有群", async () => {
  const qc = client();
  const fetcher = async (id: string) => [entry(id)];
  await qc.fetchQuery({ queryKey: groupFilesKey("g1"), queryFn: () => fetcher("g1") });
  await qc.fetchQuery({ queryKey: groupFilesKey("g2"), queryFn: () => fetcher("g2") });

  await invalidateGroupFiles(qc, "g1");
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g1") })?.state.isInvalidated, true);
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g2") })?.state.isInvalidated, false);

  await invalidateGroupFiles(qc);
  assert.equal(qc.getQueryCache().find({ queryKey: groupFilesKey("g2") })?.state.isInvalidated, true);
});
