import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEEN_MAX_ENTRIES,
  advanceSeen,
  countUnseen,
  parseSeen,
  pruneSeen,
  seenScopeKey,
} from "./todoReplySeen.ts";

const r = (ts: number, author = "dev-other") => ({ ts, author });

test("键按群 + 任务分开：同一 todoId 在两个群不会互相洗白", () => {
  assert.notEqual(seenScopeKey("conv-a", "t1"), seenScopeKey("conv-b", "t1"));
  assert.equal(seenScopeKey("conv-a", "t1"), "conv-a:t1");
});

test("解析：坏 JSON / 非对象 / 脏值一律退化为空表或逐条丢弃（不许崩）", () => {
  assert.deepEqual(parseSeen(null), {});
  assert.deepEqual(parseSeen(""), {});
  assert.deepEqual(parseSeen("{"), {}, "坏 JSON ⇒ 空表，不是抛错");
  assert.deepEqual(parseSeen("[]"), {}, "数组不是表");
  assert.deepEqual(parseSeen('"x"'), {});
  assert.deepEqual(parseSeen('null'), {});
  assert.deepEqual(
    parseSeen('{"a:1":123,"b:2":"123","c:3":-5,"d:4":null,"e:5":1e999}'),
    { "a:1": 123 },
    "只收非负有限数：字符串 / 负数 / null / Infinity 全丢",
  );
});

test("未读计数：只数比游标新的，且不数自己发的那条", () => {
  const list = [r(100), r(200), r(300), r(400, "dev-me")];
  assert.equal(countUnseen(list, 0, "dev-me"), 3, "游标 0 ⇒ 别人的全部未读，自己的不算");
  assert.equal(countUnseen(list, 250, "dev-me"), 1, "只有 300 比游标新");
  assert.equal(countUnseen(list, 300, "dev-me"), 0, "等于游标不算未读（看过了）");
  assert.equal(countUnseen([], 0, "dev-me"), 0, "没有回复 ⇒ 0");
  assert.equal(countUnseen(list, 0), 4, "selfId 未就绪时不做排除（宁可多算自己一条）");
});

test("游标只增不减：行迟到 / 回复变少都不许把已读重新变未读", () => {
  assert.equal(advanceSeen(0, [r(100), r(300)]), 300);
  assert.equal(advanceSeen(500, [r(100), r(300)]), 500, "旧游标更大 ⇒ 保持 500");
  assert.equal(advanceSeen(Number.NaN, [r(10)]), 10, "脏游标按 0 处理");
  assert.equal(advanceSeen(200, []), 200, "空列表不回退");
});

test("裁剪：超过上限丢最旧的，且不改入参", () => {
  const map: Record<string, number> = {};
  for (let i = 0; i < SEEN_MAX_ENTRIES + 3; i += 1) map[`c:${i}`] = i;
  const pruned = pruneSeen(map);
  assert.equal(Object.keys(pruned).length, SEEN_MAX_ENTRIES);
  assert.equal(pruned["c:0"], undefined, "最旧的三条被丢");
  assert.equal(pruned[`c:${SEEN_MAX_ENTRIES + 2}`], SEEN_MAX_ENTRIES + 2, "最新的留着");
  assert.equal(Object.keys(map).length, SEEN_MAX_ENTRIES + 3, "入参不许被改");
  // 没超限时也要返回副本（调用方直接替换 ref，共享同一个对象会漏更新）
  const small = { "c:1": 1 };
  const copy = pruneSeen(small);
  assert.deepEqual(copy, small);
  assert.notEqual(copy, small);
});

/**
 * 接线判据（读源码）：`openDetail` 必须**先按旧游标算高亮、再推游标**。
 * 顺序反了不会报错、不会崩，只是"永远没有一条被标成新的" —— 属于静默失效，必须钉住。
 */
test("openDetail 先算高亮再推游标（顺序反了高亮永远为空）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "..", "components", "GroupTasksBoard.vue"), "utf8");
  const at = src.indexOf("function openDetail(");
  assert.ok(at > 0, "找不到 openDetail ⇒ 判据没有分母");
  const body = src.slice(at, src.indexOf("\nfunction ", at + 10));

  /** 顺序判据：先算高亮、再落盘游标。 */
  const ordered = (s: string) => {
    const calc = s.indexOf("highlightReplyIds.value = list");
    const save = s.indexOf("saveSeen(");
    return calc > 0 && save > calc;
  };
  assert.ok(ordered(body), "先推游标再算高亮 ⇒ 新回复永远算不出来（静默失效）");
  // 反例自证：把两段调换后，同一个判据必须**不成立**（证明它真的在看顺序，不是在读注释）
  assert.equal(
    ordered('saveSeen(map);\nhighlightReplyIds.value = list.filter(...)'),
    false,
    "反例：顺序调换后判据仍成立 ⇒ 这条判据空转",
  );
});
