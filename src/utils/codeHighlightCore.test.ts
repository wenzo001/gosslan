import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCode, knownLanguage } from "./codeHighlightCore.ts";

test("已知语言：输出高亮 span 与语言名", () => {
  const r = highlightCode("const x: number = 1;", "typescript");
  assert.equal(r.lang, "typescript");
  assert.match(r.html, /<span/);
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
