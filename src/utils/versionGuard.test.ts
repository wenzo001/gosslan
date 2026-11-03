import assert from "node:assert/strict";
import test from "node:test";
import { detectVersionMismatch } from "./versionGuard.ts";

test("正判据：前后端版本不同 ⇒ 报错配", () => {
  assert.deepEqual(detectVersionMismatch("5.17.2", "5.17.1"), {
    frontend: "5.17.2",
    backend: "5.17.1",
  });
});

test("反判据：同一版本 ⇒ 不报（含 v 前缀/空白差异）", () => {
  assert.equal(detectVersionMismatch("5.17.2", "5.17.2"), null);
  assert.equal(detectVersionMismatch("v5.17.2", " 5.17.2 "), null);
});

test("拿不到任一版本 ⇒ 不报（避免把抖动误报成错配）", () => {
  assert.equal(detectVersionMismatch("5.17.2", null), null);
  assert.equal(detectVersionMismatch(null, "5.17.2"), null);
  assert.equal(detectVersionMismatch("5.17.2", "  "), null);
  assert.equal(detectVersionMismatch(undefined, undefined), null);
});
