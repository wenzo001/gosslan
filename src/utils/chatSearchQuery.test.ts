/**
 * 搜索聊天记录查询策略的判据（真实 QueryClient，不 mock 缓存层）。
 *
 * 钉的是旧实现里那套手写竞态守卫的**语义**：
 * · 关键词 / 发送人 / 日期任一不同 ⇒ 不同键，旧响应不可能覆盖新结果；
 * · 同一组条件再次检索 ⇒ 真的重扫（staleTime 0）；
 * · 并发同键 ⇒ 合并成一次；失败 ⇒ 只尝试一次（retry 0，旧实现也没有自动重试）；
 * · 换条件时旧结果继续显示（keepPreviousData），且能被 `isPlaceholderData` 识别出来 ——
 *   组件靠这一点避免把"上一个关键词的结果"误记成当前关键词的发送人候选。
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/vue-query";
import {
  CHAT_SEARCH_QUERY,
  chatSearchKey,
  chatSearchQueryOptions,
  type ChatSearchParams,
} from "./chatSearchQuery.ts";
import type { ChatSearchGroup } from "../types.ts";

function group(convId: string): ChatSearchGroup {
  return {
    conv_id: convId,
    name: convId,
    kind: "single",
    avatar: null,
    total: 1,
    latest_ts: 0,
    messages: [],
  };
}

const P: ChatSearchParams = { keyword: "命中", senderId: null, preset: "all" };

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

async function waitFor(fn: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("关键词 / 发送人 / 日期都是键的一部分：三组条件的缓存互不覆盖", async () => {
  const qc = client();
  const fetchBy = async (p: ChatSearchParams) => [group(`${p.keyword}|${p.senderId}|${p.preset}`)];

  const a = { ...P, senderId: "a" };
  const b = { ...P, senderId: "b" };
  const c = { ...P, preset: "today" as const };
  await qc.fetchQuery(chatSearchQueryOptions(a, fetchBy));
  await qc.fetchQuery(chatSearchQueryOptions(b, fetchBy));
  await qc.fetchQuery(chatSearchQueryOptions(c, fetchBy));

  assert.deepEqual(chatSearchKey(a), [CHAT_SEARCH_QUERY, "命中", "a", "all"]);
  assert.equal(qc.getQueryData<ChatSearchGroup[]>(chatSearchKey(a))?.[0].conv_id, "命中|a|all");
  assert.equal(qc.getQueryData<ChatSearchGroup[]>(chatSearchKey(b))?.[0].conv_id, "命中|b|all");
  assert.equal(qc.getQueryData<ChatSearchGroup[]>(chatSearchKey(c))?.[0].conv_id, "命中|null|today");
});

test("staleTime 0：同条件再次检索必须重新请求（回车重搜 / 重开弹窗都走这里）", async () => {
  const qc = client();
  let calls = 0;
  const opts = chatSearchQueryOptions(P, async () => {
    calls += 1;
    return [group("g")];
  });
  await qc.fetchQuery(opts);
  await qc.fetchQuery(opts);
  assert.equal(calls, 2);
});

test("并发同键只发一次请求（旧实现靠 seq 守卫，但请求仍是两份）", async () => {
  const qc = client();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opts = chatSearchQueryOptions(P, async () => {
    calls += 1;
    await gate;
    return [group("g")];
  });

  const first = qc.fetchQuery(opts);
  const second = qc.fetchQuery(opts);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("失败只尝试一次（retry 0），状态落到 error 且没有假数据", async () => {
  const qc = client();
  let calls = 0;
  const opts = chatSearchQueryOptions(P, async () => {
    calls += 1;
    throw new Error("ipc down");
  });
  await assert.rejects(qc.fetchQuery(opts));
  assert.equal(calls, 1);
  const query = qc.getQueryCache().find({ queryKey: chatSearchKey(P) });
  assert.equal(query?.state.status, "error");
  assert.equal(qc.getQueryData(chatSearchKey(P)), undefined);
});

test("换条件时旧结果继续显示，并用 isPlaceholderData 标出它不是当前键的数据", async () => {
  const qc = client();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const optsFor = (p: ChatSearchParams) =>
    chatSearchQueryOptions(p, async () => {
      if (p.senderId === "b") await gate;
      return [group(p.senderId ?? "all")];
    });

  const observer = new QueryObserver(qc, optsFor({ ...P, senderId: "a" }));
  const unsubscribe = observer.subscribe(() => {});
  await waitFor(() => observer.getCurrentResult().isSuccess);
  assert.equal(observer.getCurrentResult().data?.[0].conv_id, "a");

  observer.setOptions(optsFor({ ...P, senderId: "b" }));
  await waitFor(() => observer.getCurrentResult().isFetching);
  const pending = observer.getCurrentResult();
  assert.equal(pending.isPlaceholderData, true, "新键在途时必须标记为占位数据");
  assert.deepEqual(pending.data, [group("a")], "占位数据 = 上一个键的结果");

  release();
  await waitFor(() => observer.getCurrentResult().isSuccess && !observer.getCurrentResult().isPlaceholderData);
  assert.equal(observer.getCurrentResult().data?.[0].conv_id, "b");
  unsubscribe();
});
