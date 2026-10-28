import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 局部错误边界的**接线**判据（审计 P2 #34）。
 *
 * 为什么只能静态钉：这条链的运行时验证需要"让子树在渲染中抛错"，而本仓没有组件级
 * 运行时测试基建（没有 @vue/test-utils），真机验证也只能靠手工构造。静态判据能保证的是
 * 三件最容易退化的接线：装着谁、包在哪、有没有真的拦住冒泡。行为本身的兜底语义由
 * `ErrorBoundary` 的模板直接表达（v-if 到 StateBlock），不经过中间层。
 */
const ROOT = new URL("../../src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

test("消息列表被 ErrorBoundary 包住（不是只 import 了没用）", () => {
  const src = read("components/ChatWindow.vue");
  assert.match(src, /import ErrorBoundary from "@\/components\/ui\/ErrorBoundary\.vue";/);
  const open = src.indexOf("<ErrorBoundary");
  const list = src.indexOf("<VirtualList", open);
  const close = src.indexOf("</ErrorBoundary>", list);
  assert.ok(open > 0 && list > open && close > list, "VirtualList 必须落在 ErrorBoundary 的开闭标签之间");
  assert.equal(
    (src.match(/<ErrorBoundary\b/g) ?? []).length,
    1,
    "同一块子树只包一层边界（嵌套两层会让外层接不到里层的异常）",
  );
});

test("边界必须真的拦住冒泡：onErrorCaptured 里返回 false，且用 StateBlock 给可重试的说明", () => {
  const src = read("components/ui/ErrorBoundary.vue");
  assert.match(src, /onErrorCaptured\(/, "没有 onErrorCaptured 就不是错误边界");
  assert.match(src, /return false;/, "返回 true/undefined 会把异常继续交给全局 errorHandler，子树照样被卸载");
  assert.match(src, /StateBlock/, "降级渲染必须有说明块");
  assert.match(src, /@retry="retry"/, "说明块必须带重试入口");
  assert.match(src, /:key="gen"/, "重试必须重建子树（只清错误文案会把坏掉的状态留在原地）");
});
