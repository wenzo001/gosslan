import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_COUNT_MAX, formatQueueCount } from "./queueCount.ts";

test("边界：999 本身照常显示，1000 才是 `999+`", () => {
  assert.equal(formatQueueCount(998), "998");
  assert.equal(formatQueueCount(QUEUE_COUNT_MAX), "999");
  assert.equal(formatQueueCount(1000), "999+");
  assert.equal(formatQueueCount(12345), "999+");
});

test("非正数与脏数据收敛到 0（不会渲染成 `NaN` / `-1`）", () => {
  assert.equal(formatQueueCount(0), "0");
  assert.equal(formatQueueCount(-3), "0");
  assert.equal(formatQueueCount(Number.NaN), "0");
  assert.equal(formatQueueCount(Number.POSITIVE_INFINITY), "0");
});

test("小数向下取整（队列长度不该出现小数，但别把 `1.5` 画到界面上）", () => {
  assert.equal(formatQueueCount(1.9), "1");
});

// 反例自证：如果哪天有人把上限摘掉，这里必须能看出来。
test("反例：不截断的实现会输出 `1000`，与契约不同", () => {
  const noCap = (n: number) => String(n);
  assert.notEqual(noCap(1000), formatQueueCount(1000), "摘掉 999+ 截断必须与契约不一致");
});

test("页脚真的用了这个格式化（不是算了却渲染原始值）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "ConversationList.vue"), "utf8");
  assert.match(src, /import \{ formatQueueCount \}/, "页脚没引用 utils/queueCount");
  assert.match(src, /\{\{\s*taskCountLabel\s*\}\}/, "模板渲染的不是截断后的值");
  assert.match(src, /const taskCountLabel = computed\(\(\) => formatQueueCount\(taskCount\.value\)\)/);
});
