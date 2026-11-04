import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_LANGUAGES,
  PLAINTEXT,
  codeLanguageLabel,
  isPlaintextLanguage,
  normalizeCodeLanguage,
} from "./codeLanguages.ts";

test("语言别名归一化：js/ts/py/rs/sh/yml/md 都落到规范名", () => {
  assert.equal(normalizeCodeLanguage("js"), "javascript");
  assert.equal(normalizeCodeLanguage("TS"), "typescript");
  assert.equal(normalizeCodeLanguage("py"), "python");
  assert.equal(normalizeCodeLanguage("rs"), "rust");
  assert.equal(normalizeCodeLanguage("sh"), "bash");
  assert.equal(normalizeCodeLanguage("yml"), "yaml");
  assert.equal(normalizeCodeLanguage("md"), "markdown");
});

test("自动档：空值/auto/缺省返回 null，交给 highlightAuto", () => {
  assert.equal(normalizeCodeLanguage(""), null);
  assert.equal(normalizeCodeLanguage("  "), null);
  assert.equal(normalizeCodeLanguage("auto"), null);
  assert.equal(normalizeCodeLanguage(null), null);
  assert.equal(normalizeCodeLanguage(undefined), null);
});

test("纯文本档：显式 text/txt/plain 归一为 plaintext", () => {
  for (const raw of ["plain", "text", "txt", PLAINTEXT, "none"]) {
    assert.equal(normalizeCodeLanguage(raw), PLAINTEXT);
    assert.equal(isPlaintextLanguage(raw), true);
  }
});

test("未注册的围栏标签落纯文本，不猜成别的语言", () => {
  assert.equal(normalizeCodeLanguage("not-a-language"), PLAINTEXT);
  assert.equal(normalizeCodeLanguage("cobol"), PLAINTEXT);
});

test("目录只含已注册语言，标签不断档", () => {
  for (const lang of CODE_LANGUAGES) {
    assert.ok(codeLanguageLabel(lang), `${lang} 缺少展示名`);
  }
});
