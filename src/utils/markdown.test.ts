/**
 * 更新说明渲染的**长度闸**（审计第 5 项）：`marked.parse` + `DOMPurify.sanitize`
 * 是同步主线程活，判据是"进这两步的文本必须有上限" —— 超长说明（病态输入/取数出错）
 * 不许把更新面板的主线程卡住。
 *
 * 注：渲染入口 `renderNotesMarkdown` 依赖 DOM（DOMPurify），Node 里够不着；
 * 这里测的是它进 parse 之前必经的纯函数 `capNotesText`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capNotesText, NOTES_MAX_CHARS, renderNotesMarkdown } from "./markdown.ts";

test("不超上限的说明原样通过（正常路径零改动）", () => {
  const normal = "### 5.16.83\n\n- 修了一件事\n- 又修了一件事";
  assert.equal(capNotesText(normal), normal);
  // 恰好压线也算不超（边界不许漂移）
  assert.equal(capNotesText("x".repeat(NOTES_MAX_CHARS)).length, NOTES_MAX_CHARS);
});

test("超上限必须截到上限，并留下可见的省略标记（不许无声吞掉）", () => {
  const tooLong = "y".repeat(NOTES_MAX_CHARS + 5_000);
  const capped = capNotesText(tooLong);
  // 截断后的**正文部分**恰好是上限长；整体多出的是换行 + 省略号那一笔
  assert.ok(capped.startsWith("y".repeat(NOTES_MAX_CHARS)), "正文必须保留前上限个字符");
  assert.ok(capped.endsWith("\n\n…"), "必须以独立段落的省略号收尾（用户要看得见被截了）");
  assert.ok(
    capped.length <= NOTES_MAX_CHARS + 4,
    "截断产物不许反过来比上限长出一大截",
  );
});

test("正控：把闸摘掉（恒等返回）必须被上面的判据抓到", () => {
  // 模拟"有人把截断改成直接返回"：超长输入原样出来 ⇒ 长度判据立刻不成立。
  const gutted = (text: string) => text;
  const tooLong = "z".repeat(NOTES_MAX_CHARS + 10);
  assert.ok(gutted(tooLong).length > NOTES_MAX_CHARS + 4, "对照：摘闸之后确实超长 ⇒ 判据量得到");
});

test("渲染入口的空输入短路（不碰 marked/DOMPurify 就返回）", () => {
  assert.equal(renderNotesMarkdown(null), "");
  assert.equal(renderNotesMarkdown(undefined), "");
  assert.equal(renderNotesMarkdown("   \n  "), "");
});
