import assert from "node:assert/strict";
import test from "node:test";
import {
  isAuxWindowCreateFailure,
  reportAuxWindowFailure,
} from "./auxWindowFailure.ts";

/** 后端 `error_codes::coded()` 的真实形状（含 Windows 上那串 HRESULT 转储）。 */
const REAL_WINDOWS_ERROR =
  "code=AUX_WINDOW_CREATE_FAILED 创建 logs 窗口失败 " +
  "runtime error: failed to create webview. WebView2 error: WindowsError(Error { " +
  'code: HRESULT(0x80010108), message: "被调用的对象已与其客户端断开连接。" })';

const TEXTS = { friendly: "辅助窗口没能打开，请完全退出应用再打开。", restart: "立即重启" };

function harness() {
  const calls: { notices: string[]; fallbacks: unknown[]; restarts: number } = {
    notices: [],
    fallbacks: [],
    restarts: 0,
  };
  const deps = {
    noticeWithRestart: (text: string) => calls.notices.push(text),
    fallback: (e: unknown) => calls.fallbacks.push(e),
    restartApp: () => {
      calls.restarts += 1;
    },
  };
  return { calls, deps };
}

test("正判据：认得出 AUX_WINDOW_CREATE_FAILED ⇒ 新文案 + 重启动作", () => {
  const { calls, deps } = harness();
  const verdict = reportAuxWindowFailure(REAL_WINDOWS_ERROR, TEXTS, deps);
  assert.equal(verdict, "friendly");
  assert.deepEqual(calls.notices, [TEXTS.friendly], "上屏只应有本地化人话");
  assert.equal(calls.fallbacks.length, 0, "不该再走旧提示");
  assert.equal(calls.restarts, 0, "按钮要用户点，不该自动重启");
});

test("码在 Error 对象里也认（invoke 抛 Error 是常态）", () => {
  const { calls, deps } = harness();
  assert.equal(isAuxWindowCreateFailure(new Error(REAL_WINDOWS_ERROR)), true);
  assert.equal(reportAuxWindowFailure(new Error(REAL_WINDOWS_ERROR), TEXTS, deps), "friendly");
  assert.deepEqual(calls.notices, [TEXTS.friendly]);
});

test("反判据：别的失败原样交还调用方，一个字都不改写", () => {
  const { calls, deps } = harness();
  const other = new Error("boom");
  const verdict = reportAuxWindowFailure(other, TEXTS, deps);
  assert.equal(verdict, "fallback");
  assert.deepEqual(calls.fallbacks, [other]);
  assert.equal(calls.notices.length, 0, "普通失败不该冒出'请重启'");
});

test("反判据：只是文案里含 0x80010108、但没有码 ⇒ 不算这类失败", () => {
  const { calls, deps } = harness();
  assert.equal(
    reportAuxWindowFailure("failed to create webview: HRESULT(0x80010108)", TEXTS, deps),
    "fallback",
  );
  assert.equal(calls.notices.length, 0);
  assert.equal(calls.fallbacks.length, 1);
});

test("空值/非错误输入不崩，也不冒充这类失败", () => {
  assert.equal(isAuxWindowCreateFailure(undefined), false);
  assert.equal(isAuxWindowCreateFailure(null), false);
  assert.equal(isAuxWindowCreateFailure({}), false);
});
