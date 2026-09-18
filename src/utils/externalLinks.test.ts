import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINK_NAME_CHARS,
  isValidExternalUrl,
  validateLinkInput,
} from "./externalLinks.ts";

test("isValidExternalUrl：只接受 http/https 且主机名非空", () => {
  for (const ok of ["http://example.com", "https://example.com/a?b=c", "  https://a.b.c  "]) {
    assert.equal(isValidExternalUrl(ok), true, `应当放行：${ok}`);
  }
  for (const bad of [
    "",
    "   ",
    "example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "tauri://localhost",
    "https://",
  ]) {
    assert.equal(isValidExternalUrl(bad), false, `必须拒绝：${bad}`);
  }
});

test("validateLinkInput：名称空 / 超长 / 网址非法 / 重复", () => {
  const existing = [{ id: "a", url: "https://a.com" }];
  assert.equal(validateLinkInput({ name: "", url: "https://x.com" }, [], undefined), "name");
  assert.equal(validateLinkInput({ name: "   ", url: "https://x.com" }, [], undefined), "name");
  assert.equal(
    validateLinkInput({ name: "x".repeat(MAX_LINK_NAME_CHARS + 1), url: "https://x.com" }),
    "nameTooLong",
  );
  assert.equal(validateLinkInput({ name: "ok", url: "javascript:alert(1)" }), "url");
  assert.equal(validateLinkInput({ name: "ok", url: "https://a.com" }, existing), "duplicate");
  // 编辑自己那条（exceptId 命中）不算重复
  assert.equal(validateLinkInput({ name: "ok", url: "https://a.com" }, existing, "a"), null);
  assert.equal(validateLinkInput({ name: "ok", url: "https://new.com" }, existing), null);
});
