// `blobLru` 的单测。
//
// 这一层的存在理由（见 blobLru.ts 文件头）：预览缓存的正确形状是**按累计字节数**封顶，
// 而不是按条数 —— `IMAGE_MAX_BYTES = 15 MiB` 是单条上限，取 K 条的最坏情况就是 K × 15 MiB。
// 因此这里钉的是三件互相独立的事：
//   ① 字节账本算得对（含"同一 url 重复 put 不许重复计账"）；
//   ② 超限时逐出**最旧**（LRU：get 过的要活得比没 get 过的久）；
//   ③ 每一条消失路径（逐出 / delete / clear / 覆盖）都**必须** revoke ——
//      这正是 `invalidateFilePreview` 当年漏掉、把 objectURL 永久留在内存里的那个缺陷。
//
// ⚠️ revoke 用**注入的假函数**数次数：Node 里没有 objectURL，真去调 DOM 会抛。
// 被测的是"缓存有没有把 revoke 叫出来、叫了几次、叫的是哪个 url"，不是浏览器行为。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBlobLru, type BlobLruOptions } from "./blobLru.ts";

/** 造一个可观测的 LRU：字节数由 caller 直接给，revoke 记进数组。 */
function makeLru(overrides: Partial<BlobLruOptions> = {}) {
  const revoked: string[] = [];
  const lru = createBlobLru({
    maxBytes: 100,
    revoke: (url: string) => revoked.push(url),
    ...overrides,
  });
  return { lru, revoked };
}

test("put/get 命中同一对象；未命中返回 undefined", () => {
  const { lru, revoked } = makeLru();
  const value = { url: "blob:a", bytes: 10 };
  lru.put("k1", value);
  assert.equal(lru.get("k1"), value);
  assert.equal(lru.get("nope"), undefined);
  assert.deepEqual(revoked, [], "命中不该 revoke");
});

test("字节账本：累计字节 = 各条之和", () => {
  const { lru } = makeLru();
  lru.put("a", { url: "blob:a", bytes: 10 });
  lru.put("b", { url: "blob:b", bytes: 25 });
  assert.equal(lru.bytes(), 35);
  assert.equal(lru.size(), 2);
});

test("超过累计上限 ⇒ 按最旧先逐，且逐出时必须 revoke", () => {
  const { lru, revoked } = makeLru({ maxBytes: 30 });
  lru.put("a", { url: "blob:a", bytes: 10 });
  lru.put("b", { url: "blob:b", bytes: 10 });
  lru.put("c", { url: "blob:c", bytes: 10 });
  assert.deepEqual(revoked, [], "刚好 30 不该逐出");
  lru.put("d", { url: "blob:d", bytes: 10 });
  assert.deepEqual(revoked, ["blob:a"], "超限逐出最旧的，并 revoke 它");
  assert.equal(lru.get("a"), undefined);
  assert.equal(lru.get("d")?.url, "blob:d");
  assert.equal(lru.bytes(), 30);
});

test("LRU 语义：get 过的条目比没 get 过的活得久", () => {
  const { lru, revoked } = makeLru({ maxBytes: 30 });
  lru.put("a", { url: "blob:a", bytes: 10 });
  lru.put("b", { url: "blob:b", bytes: 10 });
  lru.put("c", { url: "blob:c", bytes: 10 });
  // a 被读过 ⇒ 它比 b 新；下一次逐出应当先拿 b。
  assert.equal(lru.get("a")?.url, "blob:a");
  lru.put("d", { url: "blob:d", bytes: 10 });
  assert.deepEqual(revoked, ["blob:b"], "先逐没被读过的 b，而不是被读过的 a");
  assert.equal(lru.get("a")?.url, "blob:a", "a 仍在");
});

test("单条超过上限 ⇒ 不入缓存，且**不得**把它 revoke（调用方还要用它）", () => {
  const { lru, revoked } = makeLru({ maxBytes: 30 });
  const huge = { url: "blob:huge", bytes: 99 };
  lru.put("h", huge);
  assert.equal(lru.has("h"), false, "超单条上限的条目不该进缓存");
  assert.deepEqual(revoked, [], "刚 put 进来的那条还没被缓存接管，revoke 它=把调用方手里的 url 弄死");
  assert.equal(lru.bytes(), 0);
});

test("同 key 覆盖：旧值必须 revoke，账本按新值算", () => {
  const { lru, revoked } = makeLru();
  lru.put("k", { url: "blob:old", bytes: 10 });
  lru.put("k", { url: "blob:new", bytes: 4 });
  assert.deepEqual(revoked, ["blob:old"], "覆盖丢掉的旧 url 必须释放");
  assert.equal(lru.get("k")?.url, "blob:new");
  assert.equal(lru.bytes(), 4, "账本要扣掉旧值");
  assert.equal(lru.size(), 1);
});

test("delete：命中即 revoke 并扣账；未命中是 no-op 且不 revoke", () => {
  const { lru, revoked } = makeLru();
  lru.put("k", { url: "blob:k", bytes: 10 });
  lru.delete("k");
  assert.deepEqual(revoked, ["blob:k"]);
  assert.equal(lru.get("k"), undefined);
  assert.equal(lru.bytes(), 0);
  lru.delete("k");
  assert.deepEqual(revoked, ["blob:k"], "重复 delete 不该再 revoke 一次");
});

test("clear：全部 revoke，账本归零", () => {
  const { lru, revoked } = makeLru();
  lru.put("a", { url: "blob:a", bytes: 10 });
  lru.put("b", { url: "blob:b", bytes: 20 });
  lru.clear();
  assert.deepEqual(revoked.sort(), ["blob:a", "blob:b"]);
  assert.equal(lru.bytes(), 0);
  assert.equal(lru.size(), 0);
});

test("没有 url 的条目（失败/纯文本结果）不参与字节账本，也不逐出别人", () => {
  const { lru, revoked } = makeLru({ maxBytes: 30 });
  lru.put("note", { note: "文件过大" });
  lru.put("a", { url: "blob:a", bytes: 10 });
  assert.equal(lru.bytes(), 10, "无 url 的条目按 0 字节计");
  assert.equal(lru.size(), 2);
  lru.clear();
  assert.deepEqual(revoked, ["blob:a"], "只 revoke 真的有 url 的那条");
});

test("单条上限可注入，默认取自 options.maxEntryBytes", () => {
  const { lru } = makeLru({ maxBytes: 1000, maxEntryBytes: 10 });
  lru.put("big", { url: "blob:big", bytes: 11 });
  assert.equal(lru.has("big"), false);
  lru.put("ok", { url: "blob:ok", bytes: 10 });
  assert.equal(lru.has("ok"), true, "等于上限应当收下（> 才拒）");
});

test("clear 之后再放入仍能正常工作（清完不是把实例弄坏）", () => {
  const { lru, revoked } = makeLru();
  lru.put("a", { url: "blob:a", bytes: 10 });
  lru.clear();
  lru.put("b", { url: "blob:b", bytes: 5 });
  assert.equal(lru.get("b")?.url, "blob:b");
  assert.equal(lru.bytes(), 5);
  assert.deepEqual(revoked, ["blob:a"]);
});

test("maxBytes 为非正数 ⇒ 一条都不留（不静默忽略，与 trimOldest 同口径）", () => {
  const { lru, revoked } = makeLru({ maxBytes: 0 });
  lru.put("a", { url: "blob:a", bytes: 1 });
  assert.equal(lru.size(), 0, "上限为 0 ⇒ 一条都不留");
  assert.equal(lru.bytes(), 0);
  // ⚠️ 拒收而不是"收下再逐出"：即使上限是 0，一条都放不进去也**不许** revoke ——
  // 那个 url 从没被缓存接管过，仍归调用方所有。收下再逐出会把它当场弄死（裂图）。
  assert.deepEqual(revoked, [], "从未被接管的 url 不许 revoke");
});

test("maxBytes 为负数 ⇒ 同样一条都不留（不静默忽略）", () => {
  const { lru, revoked } = makeLru({ maxBytes: -5 });
  lru.put("a", { url: "blob:a", bytes: 1 });
  assert.equal(lru.size(), 0);
  assert.deepEqual(revoked, []);
});

test("value 允许自定义取 url / 取字节（给 data URL 这类形态留口子）", () => {
  const revoked: string[] = [];
  const lru = createBlobLru<{ src: string; n: number }>({
    maxBytes: 30,
    revoke: (url: string) => revoked.push(url),
    urlOf: (v) => v.src,
    bytesOf: (v) => v.n,
  });
  lru.put("a", { src: "data:a", n: 10 });
  lru.put("b", { src: "data:b", n: 25 });
  assert.equal(lru.bytes(), 35 - 10, "b 超限 ⇒ 逐出 a");
  assert.deepEqual(revoked, ["data:a"]);
  assert.equal(lru.get("b")?.src, "data:b");
});
