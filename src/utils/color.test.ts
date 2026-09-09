import { test } from "node:test";
import assert from "node:assert/strict";
import { hexToRgb, lighten, darken, rgba, humanSize, nameToColor } from "./color.ts";

test("hexToRgb 解析 6 位与 3 位 hex", () => {
  assert.deepEqual(hexToRgb("#3b82f6"), [59, 130, 246]);
  assert.deepEqual(hexToRgb("#ffffff"), [255, 255, 255]);
  assert.deepEqual(hexToRgb("#fff"), [255, 255, 255]);
});

test("lighten 向白混合、darken 向黑混合", () => {
  assert.equal(lighten("#000000", 1), "rgb(255, 255, 255)");
  assert.equal(darken("#ffffff", 1), "rgb(0, 0, 0)");
});

test("rgba 输出带透明度", () => {
  assert.equal(rgba("#3b82f6", 0.12), "rgba(59, 130, 246, 0.12)");
});

test("主题色派生链：hover 比主色浅、active 比主色深", () => {
  const base = [59, 130, 246];
  const hv = (lighten("#3b82f6", 0.08).match(/\d+/g) ?? []).map(Number);
  const av = (darken("#3b82f6", 0.08).match(/\d+/g) ?? []).map(Number);
  assert.ok(hv[0] >= base[0]);
  assert.ok(av[0] <= base[0]);
});

test("humanSize 单位换算与精度", () => {
  assert.equal(humanSize(0), "0.0 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1024 * 1024), "1.0 MB");
  assert.equal(humanSize(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(humanSize(1536), "1.5 KB");
});

test("nameToColor 同一名字稳定返回同一颜色", () => {
  assert.equal(nameToColor("Alice"), nameToColor("Alice"));
  assert.equal(nameToColor("张三"), nameToColor("张三"));
  // 大小写/前后空格视为同一名字
  assert.equal(nameToColor("Alice"), nameToColor("  alice  "));
});

test("nameToColor 不同名字大概率拿到不同颜色（10 人分发到 8 色）", () => {
  const names = [
    "Alice", "Bob", "Carol", "Dave", "Eve",
    "Frank", "Grace", "Heidi", "Ivan", "Judy",
  ];
  const colors = new Set(names.map(nameToColor));
  // 8 色调色板 + 10 个名字 → 至少出现 5 种不同颜色
  assert.ok(colors.size >= 5, `只出现了 ${colors.size} 种颜色，不够分散`);
});

test("nameToColor 空/空白名走兜底，不会返回 undefined", () => {
  const c1 = nameToColor("");
  const c2 = nameToColor("   ");
  const c3 = nameToColor(undefined as unknown as string);
  assert.ok(/^#[0-9a-f]{6}$/i.test(c1));
  assert.ok(/^#[0-9a-f]{6}$/i.test(c2));
  assert.ok(/^#[0-9a-f]{6}$/i.test(c3));
  // 三个空输入应映射到同一兜底色
  assert.equal(c1, c2);
  assert.equal(c2, c3);
});
