/**
 * 输入框草稿的落盘/读回判据（用户 2026-11-04 的"可恢复"硬要求）：
 *
 * 1. 按输入事件**同步**写（接线判据在 `MessageComposer`：`onInput` 里直接调 `persistDraft`，
 *    没有防抖/定时器）；
 * 2. 键按会话区分；
 * 3. reload 回来只在**草稿非空且会话一致**时填回；
 * 4. 发送/清空之后不留旧草稿（否则回来会"复活"已发送的文字）。
 *
 * 反例自证：payload 的 `convId` 与请求不一致时，读回必须是空串。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearComposerDraft,
  DRAFT_INDEX_KEY,
  DRAFT_PREFIX,
  getComposerDraft,
  saveComposerDraft,
} from "./composerDrafts.ts";

/** 最小假存储：不依赖 node 有没有 localStorage（与 announcementDismiss.test 同款）。 */
function memStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    dump: () => Object.fromEntries(data),
    has: (k: string) => data.has(k),
  };
}

const payload = (convId: string, html: string) =>
  JSON.stringify({ v: 1, convId, html, at: 1 });

test("写入后能读回；键按会话区分，不串会话", () => {
  const st = memStore();
  saveComposerDraft("c1", "你好，世界", st);
  saveComposerDraft("c2", "another", st);
  assert.equal(getComposerDraft("c1", st), "你好，世界");
  assert.equal(getComposerDraft("c2", st), "another");
  assert.equal(getComposerDraft("c3", st), "", "没写过的会话必须是空");
  assert.equal(st.dump()[DRAFT_PREFIX + "c1"], JSON.stringify({ v: 1, convId: "c1", html: "你好，世界", at: JSON.parse(st.dump()[DRAFT_PREFIX + "c1"]).at }));
});

test("有落盘但内存没有（等价于 reload 之后）时，从 localStorage 读回", () => {
  const st = memStore({ [DRAFT_PREFIX + "c9"]: payload("c9", "20 个字的草稿在这里") });
  assert.equal(getComposerDraft("c9", st), "20 个字的草稿在这里");
});

test("反例：会话不一致 ⇒ 不填回，并清掉脏数据", () => {
  const st = memStore({ [DRAFT_PREFIX + "c4"]: payload("other-conv", "别处的内容") });
  assert.equal(getComposerDraft("c4", st), "");
  assert.equal(st.has(DRAFT_PREFIX + "c4"), false, "串会话的 payload 必须被清掉");
});

test("反例：空内容 / 坏 JSON 也一律不填回", () => {
  const st = memStore({
    [DRAFT_PREFIX + "c5"]: payload("c5", "   "),
    [DRAFT_PREFIX + "c6"]: "{not json",
  });
  assert.equal(getComposerDraft("c5", st), "", "空白内容不该填回");
  assert.equal(getComposerDraft("c6", st), "", "坏 JSON 不该填回");
  assert.equal(st.has(DRAFT_PREFIX + "c6"), false);
});

test("清空输入框 / 发送后：草稿被删除，回来不会复活旧文字", () => {
  const st = memStore();
  saveComposerDraft("c7", "旧文字", st);
  assert.equal(getComposerDraft("c7", st), "旧文字");
  saveComposerDraft("c7", "   ", st);
  assert.equal(getComposerDraft("c7", st), "");
  assert.equal(st.has(DRAFT_PREFIX + "c7"), false);

  saveComposerDraft("c8", "要发送的", st);
  clearComposerDraft("c8", st);
  assert.equal(getComposerDraft("c8", st), "");
  assert.equal(st.has(DRAFT_PREFIX + "c8"), false);
});

test("落盘条数上限：超出 PERSIST_MAX 时淘汰最久没写的会话（防配额吃满）", () => {
  const st = memStore();
  for (let i = 0; i < 25; i += 1) saveComposerDraft(`conv-${i}`, `draft-${i}`, st);
  const ids = JSON.parse(st.dump()[DRAFT_INDEX_KEY]) as string[];
  assert.equal(ids.length, 20);
  assert.equal(ids[ids.length - 1], "conv-24", "最近写过的必须在索引末尾");
  assert.equal(st.has(DRAFT_PREFIX + "conv-0"), false, "最早的会话应被淘汰");
  assert.equal(st.has(DRAFT_PREFIX + "conv-24"), true);
});

test("配额满（setItem 抛错）时不影响本会话内存态", () => {
  const st = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };
  saveComposerDraft("cq", "还在", st);
  assert.equal(getComposerDraft("cq", st), "还在", "落盘失败不该把内存草稿也弄丢");
});
