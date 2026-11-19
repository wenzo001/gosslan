/**
 * 开窗单飞的**运行时行为**判据（2026-11-19 review 补）：
 * 之前 windowLaunch.test.ts 只测纯函数 + 源码形状，把 `opening.delete(label)` 从 finally
 * 删掉照样全绿 —— 而那正是「点了没反应」的核心防线。这里真调 launchAuxWindow，验证 IPC
 * 永不 settle 时单飞会被超时释放、下一次点击能重新发起。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchAuxWindow,
  __isOpeningForTest,
  type WindowTimer,
} from "../composables/useWindowLauncher.ts";
import { WINDOW_LAUNCH_TIMEOUT_MS } from "./windowLaunch.ts";

function fakeTimer() {
  let cb: (() => void) | null = null;
  return {
    set(fn: () => void, _ms: number) { cb = fn; return 1; },
    clear() { cb = null; },
    fire() { const f = cb; cb = null; f?.(); },
  } satisfies WindowTimer;
}

test("IPC 永不 settle：超时后 opening 被释放，下一次点击能重新发起", async () => {
  const label = "settings";
  const timer = fakeTimer();
  const never = new Promise<void>(() => {});
  // 第一次：open 永不返回 ⇒ 单飞置位，Promise 挂起
  const first = launchAuxWindow(label, () => never, timer);
  assert.equal(__isOpeningForTest(label), true, "发起后 opening=true");
  // 触发超时 ⇒ raceWithTimeout reject ⇒ finally 释放 opening
  timer.fire();
  await assert.rejects(first, /WINDOW_LAUNCH_TIMEOUT/);
  assert.equal(__isOpeningForTest(label), false, "超时后 opening 必须释放（否则后续点击全被吞）");

  // 推进时间越过 300ms 防抖，再点一次 —— 必须能重新发起（证明单飞没粘死）
  const realNow = Date.now;
  Date.now = () => realNow() + 5000;
  try {
    let secondCalled = false;
    const second = launchAuxWindow(label, () => { secondCalled = true; return Promise.resolve(); }, timer);
    assert.equal(secondCalled, true, "超时后第二次点击必须真发起 open()");
    assert.equal(await second, true);
    assert.equal(__isOpeningForTest(label), false, "正常完成后 opening 也要释放");
  } finally {
    Date.now = realNow;
  }
});

test("正常完成路径：opening 置位再释放", async () => {
  const label = "logs";
  const timer = fakeTimer();
  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;
  try {
    const done = launchAuxWindow(label, () => Promise.resolve(), timer);
    assert.equal(__isOpeningForTest(label), true);
    assert.equal(await done, true);
    assert.equal(__isOpeningForTest(label), false);
  } finally {
    Date.now = realNow;
  }
});
