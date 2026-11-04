import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectCode, stripCodeFence } from "./codeDetect.ts";

test("detectCode：围栏是强信号，语言取围栏标签", () => {
  const d = detectCode("```rust\nfn main() { println!(\"hi\"); }\n```");
  assert.equal(d.likely, true);
  assert.equal(d.language, "rust");
});

test("detectCode：多行 JSON / Python 命中，中文段落、URL、单行不命中", () => {
  assert.equal(detectCode('{\n  "a": 1,\n  "b": 2\n}').likely, true);
  assert.equal(detectCode("def f(x):\n    return x + 1").likely, true);
  assert.equal(detectCode("今天天气很好，我们出去走走吧。").likely, false);
  assert.equal(detectCode("https://example.com/a/b?c=d").likely, false);
  assert.equal(detectCode("const x = 1;").likely, false, "单行代码保持保守，避免误判聊天");
});

test("detectCode：未标语言的围栏不手写猜语言，交给 highlightAuto", () => {
  const d = detectCode("```\ndef f(x):\n    return x + 1\n```");
  assert.equal(d.likely, true);
  assert.equal(d.language, null);
});

test("detectCode：未知围栏标签落纯文本，不拿别的语言猜错", () => {
  const d = detectCode("```not-a-language\nhello world\n```");
  assert.equal(d.likely, true);
  assert.equal(d.language, "plaintext");
});

test("stripCodeFence：剥掉围栏与语言标签，其余原样", () => {
  const r = stripCodeFence("```ts\nconst x = 1;\n```");
  assert.deepEqual(r, { text: "const x = 1;", language: "typescript" });
  assert.deepEqual(stripCodeFence("普通文本"), { text: "普通文本", language: null });
  assert.deepEqual(stripCodeFence("```\nplain\n```"), { text: "plain", language: null });
});

test("MessageComposer 接线：输入检测、发送剥离围栏语言、可撤销", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "chat", "MessageComposer.vue"),
    "utf8",
  );
  assert.match(src, /scheduleCodeDetect\(\)/, "输入路径必须触发代码检测");
  assert.match(src, /stripCodeFence\(text\)/, "发送前必须剥离围栏");
  assert.match(src, /function toggleCodeMode\(/, "手动代码开关必须能撤销自动模式");
  // 围栏语言曾经在 `stripCodeFence(...).text` 这一步被丢掉；必须显式取 language 传下去。
  assert.match(
    src,
    /stripped\.language\s*\?\?\s*codeLang\.value/,
    "发送时必须把围栏语言或用户选择的语言传下去（删掉这行即变红）",
  );
  assert.match(src, /lang:\s*codeLangOut/, "发送载荷必须带 lang 字段");
});
