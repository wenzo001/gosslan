import assert from "node:assert/strict";
import test from "node:test";
import { createGeneration, optimisticMutate } from "./optimisticMutate.ts";

/**
 * 乐观回滚并发安全判据（2026-11-13 功能闭环审计 P2）。
 * 核心反例：A 先成功、B 后失败，B 的回滚只撤销自己的改动，**不覆盖 A 的成功**。
 * 把 inverse 换回"整份快照恢复"时，并发覆盖那条会红。
 */

interface Row {
  id: number;
  name: string;
}

test("成功：施加 apply、不施加 inverse、返回结果", async () => {
  const state = { value: [{ id: 1, name: "a" }] as Row[] };
  const r = await optimisticMutate(
    state,
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "A" } : x)),
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "a" } : x)),
    async () => "ok",
  );
  assert.equal(r, "ok");
  assert.equal(state.value[0].name, "A");
});

test("失败：inverse 作用于当前态，保留并发期间另一实体的成功变更（不整份覆盖）", async () => {
  const state = {
    value: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ] as Row[],
  };
  await optimisticMutate(
    state,
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "A" } : x)),
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "a" } : x)),
    async () => "ok",
  );
  await assert.rejects(
    optimisticMutate(
      state,
      (cur) => cur.map((x) => (x.id === 2 ? { ...x, name: "B" } : x)),
      (cur) => cur.map((x) => (x.id === 2 ? { ...x, name: "b" } : x)),
      async () => {
        throw new Error("boom");
      },
    ),
    /boom/,
  );
  assert.equal(state.value.find((x) => x.id === 1)?.name, "A", "A 的成功不许被 B 的回滚覆盖");
  assert.equal(state.value.find((x) => x.id === 2)?.name, "b", "B 自己的改动要撤销");
});

test("generation 守卫：权威刷新已前进 ⇒ 晚到失败跳过逆操作（后端状态优先）", async () => {
  const gen = createGeneration();
  const state = { value: [{ id: 1, name: "a" }] as Row[] };
  let fail!: () => void;
  const pending = new Promise<void>((_, rej) => {
    fail = () => rej(new Error("late"));
  });
  const op = optimisticMutate(
    state,
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "OPT" } : x)),
    (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "a" } : x)),
    () => pending,
    gen,
  );
  state.value = [{ id: 1, name: "BACKEND" }];
  gen.bump();
  fail();
  await assert.rejects(op, /late/);
  assert.equal(state.value[0].name, "BACKEND", "generation 已前进 ⇒ 不许用逆操作盖掉后端事实");
});

test("generation 守卫：未前进 ⇒ 照常施加逆操作", async () => {
  const gen = createGeneration();
  const state = { value: [{ id: 1, name: "a" }] as Row[] };
  await assert.rejects(
    optimisticMutate(
      state,
      (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "OPT" } : x)),
      (cur) => cur.map((x) => (x.id === 1 ? { ...x, name: "a" } : x)),
      async () => {
        throw new Error("boom");
      },
      gen,
    ),
    /boom/,
  );
  assert.equal(state.value[0].name, "a", "无权威刷新 ⇒ 回滚自己的乐观改动");
});

test("createGeneration：bump 单调递增", () => {
  const gen = createGeneration();
  assert.equal(gen.value, 0);
  gen.bump();
  gen.bump();
  assert.equal(gen.value, 2);
});

test("接线判据：群操作回滚真的走 optimisticMutate（删掉即红）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(
    join(import.meta.dirname, "../stores/chat/groups.ts"),
    "utf8",
  );
  assert.ok(
    src.includes("return optimisticMutate(groups, apply, inverse, call, groupsGen)"),
    "withGroupRollback 必须走 optimisticMutate（按项逆操作 + generation），不许回退整份快照",
  );
  assert.ok(src.includes("createGeneration()"), "群模块必须有 generation 计数器");
});