/**
 * mitt 事件总线的判据：按名投递、不串线、解绑真的摘掉监听。
 *
 * 这里不 mock mitt（它本身就是被测对象）；重点是**卸载语义** —— 旧实现用
 * `window.addEventListener/removeEventListener` 对称解绑，迁到 mitt 后如果忘了调
 * 返回的 disposer，组件重建会让一次菜单/快捷键执行多遍。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { APP_ACTION, NAVIGATE_TO_CONTACTS, emitAction, onAction } from "./appActions.ts";

test("mitt 总线按事件名投递；未订阅的动作不串线", () => {
  const got: string[] = [];
  const offSettings = onAction(APP_ACTION.openSettings, () => got.push("settings"));
  const offLogs = onAction(APP_ACTION.openLogs, () => got.push("logs"));
  try {
    emitAction(APP_ACTION.openSettings);
    assert.deepEqual(got, ["settings"]);
    emitAction(NAVIGATE_TO_CONTACTS);
    assert.deepEqual(got, ["settings"], "未订阅的动作不得触发其它处理器");
    emitAction(APP_ACTION.openLogs);
    assert.deepEqual(got, ["settings", "logs"]);
  } finally {
    offSettings();
    offLogs();
  }
});

test("解绑函数真的摘掉监听：三次 mount/unmount 后不残留，重新订阅只触发一次", () => {
  let calls = 0;
  for (let i = 0; i < 3; i += 1) {
    const off = onAction(APP_ACTION.focusSearch, () => {
      calls += 1;
    });
    off();
  }
  emitAction(APP_ACTION.focusSearch);
  assert.equal(calls, 0, "卸载后的处理器不得再收到事件（否则会执行多遍）");

  const off = onAction(APP_ACTION.focusSearch, () => {
    calls += 1;
  });
  emitAction(APP_ACTION.focusSearch);
  assert.equal(calls, 1);
  off();
});
