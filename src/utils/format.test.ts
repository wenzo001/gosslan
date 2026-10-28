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

test("字节格式化只有一个家：src 下不许再出现第二份实现（审计 P2 #35）", async () => {
  // UpdatePanel 曾自建一份（KB 取整、没有 GB 档），于是同一台机器上两处显示同一个大小
  // 却是两个数。分母现扫 src（不含测试与依赖），名字命中即红。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "assets" || e.name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|vue)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
        const src = fs.readFileSync(p, "utf8");
        if (/function formatBytes\s*\(/.test(src)) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, ["utils/format.ts"], `字节格式化出现了第二份实现：${hits.join(", ")}`);
});
