import { test } from "node:test";
import assert from "node:assert/strict";
import { isMacUA } from "./platform.ts";

test("isMacUA：桌面 macOS UA 判为 Mac", () => {
  const uas = [
    // Safari（Intel）
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    // Chrome（Apple Silicon，UA 仍写 Intel Mac OS X）
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // 老版本 macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), true, ua);
});

test("isMacUA：Windows / Linux / Android 判为非 Mac", () => {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), false, ua);
});

test("isMacUA：iOS / iPadOS 判为非 Mac（回归：旧正则 /Mac OS X/ 会把 iPhone 误判成 Mac）", () => {
  const uas = [
    // iPhone —— "like Mac OS X" 会命中 /Mac OS X/，必须排除
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    // iPad
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    // iPod touch（老设备）
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), false, ua);
});

test("isMacUA：空 / 缺失 UA 不抛错、判为非 Mac", () => {
  assert.equal(isMacUA(""), false);
});
