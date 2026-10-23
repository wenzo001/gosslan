import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldPreventContextMenu } from "./contextMenu.ts";

test("shouldPreventContextMenu：桌面一律拦（有选区也不放行）；触屏选字/有选区才放行", () => {
  const cases = [
    // 用户 2026-10-23：桌面只要之前选过任何文字，右键气泡就会弹 WebKit 原生菜单。
    { isMobile: false, textSelecting: false, hasSelection: true, expected: true },
    { isMobile: false, textSelecting: true, hasSelection: true, expected: true },
    { isMobile: true, textSelecting: true, hasSelection: true, expected: false },
    { isMobile: false, textSelecting: false, hasSelection: false, expected: true },
    { isMobile: true, textSelecting: false, hasSelection: false, expected: true },
    { isMobile: true, textSelecting: true, hasSelection: false, expected: false },
    { isMobile: false, textSelecting: true, hasSelection: false, expected: true },
    // 触屏残留选区（系统手柄还在）也必须让位，否则复制工具条会被吃掉。
    { isMobile: true, textSelecting: false, hasSelection: true, expected: false },
  ];
  for (const c of cases) {
    assert.equal(shouldPreventContextMenu(c), c.expected, JSON.stringify(c));
  }
});

test("MessageItem 右键走共享闸门：不再无条件 prevent，也不再按选区放行原生菜单", () => {
  const item = readFileSync(
    join(import.meta.dirname, "..", "components", "MessageItem.vue"),
    "utf8",
  );
  // 处理器必须挂在**整条消息**的根上（昵称行 / 尖角 / 表情条都在行外）：
  // 只挂消息行时，右键落在气泡上方那几个像素仍会漏给 WebView 的原生菜单。
  assert.match(item, /class="group\/msg"[^>]*@contextmenu="onContextMenu"/,
    "contextmenu 处理器没有挂在整条消息的根上");
  assert.doesNotMatch(item, /@contextmenu\.prevent=/, "不许再有无条件 prevent");
  assert.match(item, /shouldPreventContextMenu\(/, "必须调用共享判据");
  assert.match(item, /window\.getSelection\(\)/, "必须现算非折叠选区");
  // 闸门说拦 ⇒ 先 preventDefault 再开自定义菜单（顺序反了菜单会盖在系统菜单上）
  assert.match(item, /e\.preventDefault\(\);\s*openContextMenu\(e\);/,
    "onContextMenu 没有「先 preventDefault 再开菜单」");
});
