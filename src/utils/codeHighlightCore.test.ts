import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCodeLanguage, highlightCode, knownLanguage } from "./codeHighlightCore.ts";

test("已知语言：输出高亮 span 与语言名", () => {
  const r = highlightCode("const x: number = 1;", "typescript");
  assert.equal(r.lang, "typescript");
  assert.match(r.html, /<span/);
});

test("语言别名归一化：ts 按 typescript 渲染", () => {
  const r = highlightCode("const x: number = 1;", "ts");
  assert.equal(r.lang, "typescript");
});

test("显式纯文本：即使内容像代码也不高亮，只转义", () => {
  const r = highlightCode("const x = 1;", "plaintext");
  assert.equal(r.lang, "plaintext");
  assert.ok(!r.html.includes("<span"));
});

test("自动识别不确定时落纯文本", () => {
  const r = highlightCode("hello world, just some words", undefined);
  assert.equal(r.lang, "plaintext");
  assert.equal(detectCodeLanguage("hello world").lang, null);
});

test("自动识别对足够长的典型代码给出语言", () => {
  const src = [
    "import { ref } from \"vue\";",
    "const count = ref(0);",
    "function inc() { count.value += 1; }",
    "export default { count, inc };",
  ].join("\n");
  const r = highlightCode(src, undefined);
  assert.ok(["javascript", "typescript"].includes(r.lang), `实际识别为 ${r.lang}`);
});

test("未知语言 + 认不出的内容：按纯文本转义，绝不把原文当 HTML", () => {
  const r = highlightCode("<script>alert(1)</script>", "not-a-language");
  assert.equal(r.lang, "plaintext");
  assert.ok(r.html.includes("&lt;script&gt;"));
  assert.ok(!r.html.includes("<script>"));
});

test("语言名判定不认识的返回 null", () => {
  assert.equal(knownLanguage("typescript"), "typescript");
  assert.equal(knownLanguage("nope"), null);
  assert.equal(knownLanguage(undefined), null);
});
