/**
 * 批次 4A：主窗口 watchdog 的生命周期判据（零运行时，只读源码形状）。
 *
 * 拆 store / 拆组件时最容易断的不是函数体，而是「谁在 onMounted 起、谁在
 * onUnmounted 停」以及「心跳有没有把在途读数带出去」。这里把这两条钉住，
 * 不声称验证了浏览器里的真实时序。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const app = readFileSync(join(import.meta.dirname, "..", "App.vue"), "utf8");

function bodyOf(marker: string, endMarker: string): string {
  const at = app.indexOf(marker);
  assert.ok(at >= 0, `找不到 ${marker}`);
  const end = app.indexOf(endMarker, at);
  assert.ok(end > at, `找不到 ${marker} 的结束 ${endMarker}`);
  return app.slice(at, end);
}

test("watchdog 定时器与 long task observer 必须成对起停", () => {
  const start = bodyOf("function startWatchdogTimers()", "function stopWatchdogTimers()");
  assert.ok(start.includes("stallTimer = window.setInterval"), "缺少卡顿计时器");
  assert.ok(start.includes("heartbeatTimer = window.setInterval"), "缺少心跳计时器");
  assert.ok(start.includes("startLongTaskObserver()"), "缺少 long task 观察器");

  const stop = bodyOf("function stopWatchdogTimers()", "async function copyCrashReport");
  for (const line of [
    "window.clearInterval(stallTimer)",
    "window.clearInterval(heartbeatTimer)",
    "removeEventListener(\"visibilitychange\", heartbeatTick)",
    "longTaskObserver?.disconnect()",
  ]) {
    assert.ok(stop.includes(line), `stopWatchdogTimers 缺 ${line}：卸载后会留下上一代监听`);
  }

  assert.match(
    app,
    /onMounted\(async \(\) => \{[\s\S]{0,240}startWatchdogTimers\(\);/,
    "onMounted 必须启动 watchdog",
  );
  assert.match(app, /onUnmounted\(stopWatchdogTimers\)/, "onUnmounted 必须停 watchdog");
});

test("心跳必须带在途 IPC 读数；long task 只走上报通道", () => {
  const start = bodyOf("function startWatchdogTimers()", "function stopWatchdogTimers()");
  assert.ok(start.includes("inflightSnapshot()"), "心跳没读在途 IPC 快照");
  assert.match(
    start,
    /uiHeartbeat\([^\n]*snap\.count[^\n]*snap\.oldestMs/,
    "心跳必须把在途数量与最老等待带给后端",
  );

  const longTask = bodyOf("function startLongTaskObserver()", "function stopWatchdogTimers()");
  assert.ok(longTask.includes('entryTypes: ["longtask"]'), "long task observer 没订阅 longtask");
  assert.ok(longTask.includes("shouldLogLongTask("), "long task 没有阈值/节流判据");
  assert.ok(longTask.includes("reportFrontendSlowOp("), "long task 没有落到后端取证日志");
});
