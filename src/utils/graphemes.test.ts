import { test } from "node:test";
import assert from "node:assert/strict";
import {
  graphemeEndAfter,
  graphemeStartBefore,
  needsGraphemeDelete,
  needsGraphemeForwardDelete,
} from "./graphemes.ts";

/** 模拟「一次退格」：按字素边界删掉 caret 前的最后一个单位。 */
function backspaceOnce(text: string): string {
  const start = graphemeStartBefore(text, text.length);
  return text.slice(0, start);
}

/** 模拟「一次 Delete」：按字素边界删掉 caret 后的第一个单位。 */
function deleteOnce(text: string): string {
  return text.slice(graphemeEndAfter(text, 0));
}

test("两个连着的表情：一次退格只删后一个（用户 2026-11-07 安卓真机反馈）", () => {
  assert.equal(backspaceOnce("😀😀"), "😀");
  assert.equal(backspaceOnce("😀😀😀"), "😀😀");
  // caret 前那段确实是「跨了不止一个 UTF-16 单位」⇒ 该由我们接管
  assert.equal(needsGraphemeDelete("😀😀", 4), true);
});

test("反例自证：按 UTF-16 单位删会切出半个表情（这就是用户看到成批消失的算法层）", () => {
  const naive = "😀😀".slice(0, 3);
  assert.notEqual(naive, "😀", "按 UTF-16 删一次不等于「删掉一个表情」");
  assert.equal(naive.slice(-1).charCodeAt(0), 0xd83d, "留下一个孤立高位代理 ⇒ 渲染成问号/吞字");
  assert.equal(needsGraphemeDelete("😀😀", 3), false, "caret 落在代理对中间时不该由我们猜边界");
});

test("ZWJ 家庭 emoji 是一个单位", () => {
  const family = "👨‍👩‍👧";
  assert.equal(backspaceOnce(`a${family}`), "a");
  assert.equal(backspaceOnce(`${family}${family}`), family);
});

test("肤色修饰是一个单位", () => {
  assert.equal(backspaceOnce("👍🏽"), "");
  assert.equal(backspaceOnce("👍🏽👍🏽"), "👍🏽");
});

test("区域旗帜是一个单位（两个 regional indicator）", () => {
  assert.equal(backspaceOnce("🇨🇳🇺🇸"), "🇨🇳");
});

test("带变体选择符的 emoji 是一个单位", () => {
  assert.equal(backspaceOnce("❤️"), "");
});

test("普通单字符仍交回浏览器（保住原生 undo）", () => {
  assert.equal(needsGraphemeDelete("abc", 3), false);
  assert.equal(needsGraphemeDelete("中文", 2), false);
  assert.equal(needsGraphemeDelete("😀", 2), true, "单个 emoji 是两码元，也按字素簇删");
});

test("前向删与退格同一口径", () => {
  assert.equal(deleteOnce("😀😀"), "😀");
  assert.equal(deleteOnce("👨‍👩‍👧abc"), "abc");
  assert.equal(needsGraphemeForwardDelete("😀😀", 0), true);
  assert.equal(needsGraphemeForwardDelete("abc", 0), false);
});

test("边界：offset 越界不发散", () => {
  for (const text of ["", "a", "😀", "👨‍👩‍👧", "🇨🇳"]) {
    for (const offset of [-3, 0, 1, text.length, text.length + 5]) {
      const start = graphemeStartBefore(text, offset);
      const end = graphemeEndAfter(text, offset);
      assert.ok(start >= 0 && start <= text.length, `start 越界: ${text}/${offset}`);
      assert.ok(end >= 0 && end <= text.length, `end 越界: ${text}/${offset}`);
    }
  }
});
