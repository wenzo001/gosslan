/**
 * `memberNameCache` 的判据（用户 2026-10-14：「名字同步，有时候还会显示设备名，会变」里
 * 「会变」那一半的机制本体 = 这份缓存，所以判据判的是**它到底有没有被写、会不会无界增长**，
 * 而不只是"读出来对不对"）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEMBER_NAME_CACHE_KEY,
  MEMBER_NAME_CACHE_MAX,
  observeMemberNames,
  readMemberNames,
  writeMemberNames,
  type MemberNameCache,
} from "./memberNameCache.ts";

/** 最小假存储：不依赖 node 有没有 localStorage，且能记写入次数。 */
function fakeStore(initial: Record<string, string> = {}, opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const values: Record<string, string> = { ...initial };
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem(key: string): string | null {
      if (opts.throwOnGet) throw new Error("storage disabled");
      return values[key] ?? null;
    },
    setItem(key: string, value: string): void {
      if (opts.throwOnSet) throw new Error("quota exceeded");
      values[key] = value;
      writes.push(value);
    },
  };
}

const node = (device_id: string, nickname: string | null) => ({ device_id, nickname });

test("读：脏数据 / 非对象 / 存储抛错 / 没有存储 ⇒ 一律空表，不许炸", () => {
  assert.deepEqual(readMemberNames(fakeStore({ [MEMBER_NAME_CACHE_KEY]: "{not json" })), {});
  assert.deepEqual(readMemberNames(fakeStore({ [MEMBER_NAME_CACHE_KEY]: "[1,2]" })), {});
  assert.deepEqual(readMemberNames(fakeStore({ [MEMBER_NAME_CACHE_KEY]: "7" })), {});
  assert.deepEqual(readMemberNames(fakeStore({}, { throwOnGet: true })), {});
  assert.deepEqual(readMemberNames(null), {});
});

test("读：只收非空字符串，空串与数字键值丢掉（脏值不许被当成一个名字）", () => {
  const raw = JSON.stringify({ a: "A机", b: "", c: 3, d: "   " });
  const got = readMemberNames(fakeStore({ [MEMBER_NAME_CACHE_KEY]: raw }));
  assert.deepEqual(got, { a: "A机" });
});

test("写：没有真变化 ⇒ 返回 null 且不写盘（peers 反复刷新不该每次落一次存储）", () => {
  const cache: MemberNameCache = { a: "A机" };
  const store = fakeStore();
  const next = observeMemberNames(cache, [node("a", "A机")]);
  assert.equal(next, null, "同名字同键 ⇒ 不该产出新表");
  writeMemberNames(store, cache);
  const before = store.writes.length;
  const again = observeMemberNames(cache, [node("a", "A机")]);
  assert.equal(again, null);
  assert.equal(store.writes.length, before);
});

test("写：新名字要覆盖旧名字，并记为最近见过", () => {
  const next = observeMemberNames({ a: "旧名" }, [node("a", "新名")]);
  assert.ok(next);
  assert.equal(next.a, "新名");
});

test("空昵称不覆盖上次见到的名字（对方改名中间态、老对端不带昵称）", () => {
  const next = observeMemberNames({ a: "老王" }, [node("a", "  "), node("b", "")]);
  assert.equal(next, null, "全是空昵称 ⇒ 没有任何变化");
});

test("上限：超过 MEMBER_NAME_CACHE_MAX 时从最老的裁，总数不许越界", () => {
  let cache: MemberNameCache = {};
  for (let i = 0; i < MEMBER_NAME_CACHE_MAX; i++) cache[`id${i}`] = `名字${i}`;
  const next = observeMemberNames(cache, [node("brand-new", "新来的")]);
  assert.ok(next);
  const keys = Object.keys(next);
  assert.equal(keys.length, MEMBER_NAME_CACHE_MAX, `裁完必须正好等于上限，实际 ${keys.length}`);
  assert.equal(next["brand-new"], "新来的");
  assert.ok(!("id0" in next), "最老的那条应当被裁掉");
});

test("写盘失败（配额满/隐私模式）⇒ 静默吞掉，不许把异常抛给 peers 刷新链路", () => {
  const store = fakeStore({}, { throwOnSet: true });
  assert.doesNotThrow(() => writeMemberNames(store, { a: "A机" }));
  assert.equal(store.writes.length, 0);
});

test("写进去的能被读回来（这条链的往返恒等 = 「重启后名字还在」的机制证明）", () => {
  const store = fakeStore();
  const next = observeMemberNames({}, [node("a", "A机")]);
  assert.ok(next);
  writeMemberNames(store, next);
  assert.deepEqual(readMemberNames(store), { a: "A机" });
});

/**
 * 覆盖面判据（按形状数，不按记忆数）：store 里每一个"换掉 peers 整表"的写入点，
 * 后面必须跟着一次 `rememberSeenNames(...)`。
 * 少接一个的后果正是用户报的那个形状 —— 某条路径刷新见过的人，离线后名字又变回"未知成员"。
 * 新增第四个写入点而没接缓存时，这条会红（而不是等用户再看一次名字会变）。
 */
test("每个 peers 写入点都接了缓存：赋值处数量 == 记名处数量", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "stores", "useChatStore.ts"), "utf8");
  const assign = src.match(/peers\.value = merged;/g) ?? [];
  const remember = src.match(/rememberSeenNames\((list|p)\);/g) ?? [];
  // 阳性对照：两边都必须非空，否则"两个 0"也会相等 —— 那是一种假绿。
  assert.ok(assign.length >= 1, "一个 peers 整表赋值点都没找到 ⇒ 尺子的锚点过期了，不是产品坏了");
  assert.ok(remember.length >= 1, "一个 rememberSeenNames 调用点都没找到 ⇒ 缓存根本没接上");
  assert.equal(
    remember.length,
    assign.length,
    `peers 整表赋值 ${assign.length} 处、记名 ${remember.length} 处 ⇒ 有路径漏接缓存`,
  );
});
