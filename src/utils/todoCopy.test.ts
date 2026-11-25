/**
 * 「复制任务」正文的判据（用户 2026-11-25）。
 *
 * 事故形状：任务详情里描述常常就是标题（用户建的时候顺手把标题又粘进描述），
 * 于是「复制标题与描述」粘出去是同一句话两遍。规则：标题 === 描述 ⇒ 只留标题。
 * 但描述只要比标题多出任何正文，就必须两段都保留 —— 去重不能吃掉信息。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { todoCopyText } from "./todoCopy.ts";

test("有描述：标题 + 空行 + 描述", () => {
  assert.equal(todoCopyText("修复登录", "先看 401，再看回调"), "修复登录\n\n先看 401，再看回调");
});

test("没有描述（null / undefined / 纯空白）：只复制标题", () => {
  assert.equal(todoCopyText("修复登录", null), "修复登录");
  assert.equal(todoCopyText("修复登录", undefined), "修复登录");
  assert.equal(todoCopyText("修复登录", "   \n\t "), "修复登录");
});

test("描述与标题一模一样：去重，只复制一份（用户 2026-11-25）", () => {
  const out = todoCopyText("修复登录", "修复登录");
  assert.equal(out, "修复登录");
  assert.equal(out.includes("\n\n"), false, "不允许再出现重复的第二段");
});

test("首尾空白/换行不算差异：描述末尾多个换行仍是「一模一样」", () => {
  assert.equal(todoCopyText("修复登录", "  修复登录 \n\n"), "修复登录");
});

test("标题前后有空格时同样判定为一模一样，但输出保留原标题", () => {
  assert.equal(todoCopyText(" 修复登录 ", "修复登录"), " 修复登录 ");
});

test("反例：描述只是以标题开头（多出正文）⇒ 两段都要保留", () => {
  assert.equal(
    todoCopyText("修复登录", "修复登录失败时先看 401"),
    "修复登录\n\n修复登录失败时先看 401",
    "去重不能吃掉描述里多出来的内容",
  );
});

test("反例：描述与标题只差一个字 ⇒ 不是一模一样，仍两段", () => {
  assert.equal(todoCopyText("修复登录", "修复登陆"), "修复登录\n\n修复登陆");
});

test("接线：任务详情的复制按钮走 todoCopyText，而不是自己拼字符串", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "TodoDetailActions.vue"), "utf8");
  assert.match(src, /todoCopyText\(/, "复制按钮没走统一口径");
  assert.equal(
    /\$\{props\.item\.title\}\\n\\n/.test(src),
    false,
    "又在自己的函数里拼「标题\\n\\n描述」—— 去重逻辑会被绕过",
  );
});
