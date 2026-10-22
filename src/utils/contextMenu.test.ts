import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldPreventContextMenu } from "./contextMenu.ts";

test("shouldPreventContextMenu：有选区一律放行；移动端选择模式放行；其余拦默认菜单", () => {
  const cases = [
    { isMobile: false, textSelecting: false, hasSelection: true, expected: false },
    { isMobile: false, textSelecting: true, hasSelection: true, expected: false },
    { isMobile: true, textSelecting: true, hasSelection: true, expected: false },
    { isMobile: false, textSelecting: false, hasSelection: false, expected: true },
    { isMobile: true, textSelecting: false, hasSelection: false, expected: true },
    { isMobile: true, textSelecting: true, hasSelection: false, expected: false },
    { isMobile: false, textSelecting: true, hasSelection: false, expected: true },
  ];
  for (const c of cases) {
    assert.equal(shouldPreventContextMenu(c), c.expected, JSON.stringify(c));
  }
});

test("MessageItem 不再无条件 prevent：接上闸门，选区交给系统复制菜单", () => {
  const item = readFileSync(
    join(import.meta.dirname, "..", "components", "MessageItem.vue"),
    "utf8",
  );
  assert.match(item, /@contextmenu="onContextMenu"/, "消息行必须走带判据的处理器");
  assert.doesNotMatch(item, /@contextmenu\.prevent=/, "不许再有无条件 prevent");
  assert.match(item, /shouldPreventContextMenu\(/, "必须调用共享判据");
  assert.match(item, /window\.getSelection\(\)/, "必须现算非折叠选区");
});
