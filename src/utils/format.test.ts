import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes } from "./format.ts";

test("formatBytes 单位换算与精度", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
  assert.equal(formatBytes(1024 * 1024 * 1024 * 1024), "1.00 TB");
});
