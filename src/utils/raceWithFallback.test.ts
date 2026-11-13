import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { raceWithFallback } from "./raceWithFallback.ts";

/**
 * "promise 与超时计时器赛跑、先胜即清计时器"这一层机制的判据
 * （2026-11-13 组件复审 P2 跟进，ADR 决策 3 记录的 waitPreviousExit 清理缺口）。
 *
 * 钉三件事：先胜给胜者的值、超时给调用方传入的 fallback、**无论谁胜都清掉计时器**。
 * 最后一条是这次修的核心：旧裸 Promise.race 在 p 先胜时不清 setTimeout，会空触发一次。
 * 超时给什么值/错误怎么处理仍是调用方的业务决策（这里只收口机制，不抹平各 withTimeout 契约）。
 */

/** 记录 clearTimeout 调用，证明计时器真被清（不是只 resolve 了就完事）。 */
function trackClear() {
  const cleared: unknown[] = [];
  const orig = globalThis.clearTimeout;
  globalThis.clearTimeout = ((id: unknown) => {
    cleared.push(id);
    return orig(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;
  return {
    cleared,
    restore: () => {
      globalThis.clearTimeout = orig;
    },
  };
}

test("p 先胜：给 p 的值，并清掉超时计时器（不再空触发）", async () => {
  const t = trackClear();
  try {
    let resolveP!: (v: string) => void;
    const p = new Promise<string>((r) => {
      resolveP = r;
    });
    const race = raceWithFallback(p, 10_000, "fallback");
    resolveP("win");
    assert.equal(await race, "win");
    assert.equal(t.cleared.length, 1, "p 先胜后必须清掉超时计时器");
  } finally {
    t.restore();
  }
});

test("超时：给调用方传入的 fallback，并清掉计时器", async () => {
  const t = trackClear();
  try {
    const never = new Promise<string>(() => {});
    const race = raceWithFallback(never, 15, "fallback");
    assert.equal(await race, "fallback");
    assert.equal(t.cleared.length, 1, "超时 settle 后也要清计时器");
  } finally {
    t.restore();
  }
});

test("p 拒绝：错误照常传播，且仍清掉计时器", async () => {
  const t = trackClear();
  try {
    const boom = Promise.reject(new Error("boom"));
    await assert.rejects(raceWithFallback(boom, 10_000, "fallback"), /boom/);
    assert.equal(t.cleared.length, 1, "拒绝路径也要清计时器");
  } finally {
    t.restore();
  }
});

test("waitPreviousExit 真的接上了 raceWithFallback（接线判据，删掉即红）", () => {
  const src = readFileSync(join(import.meta.dirname, "../stores/useAppStore.ts"), "utf8");
  assert.ok(src.includes("raceWithFallback"), "waitPreviousExit 必须走 raceWithFallback（先胜即清）");
  const fnStart = src.indexOf("async function waitPreviousExit");
  assert.ok(fnStart >= 0, "找不到 waitPreviousExit");
  const body = src.slice(fnStart, src.indexOf("\n  }", fnStart));
  assert.ok(body.includes("raceWithFallback("), "waitPreviousExit 体内必须调用 raceWithFallback");
  assert.ok(!body.includes("Promise.race("), "waitPreviousExit 不许再留裸 Promise.race（计时器不清的旧形状）");
});