import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 窗口控制按钮的**字形与行为**守卫。
 *
 * 历史：0e07dd4 删了 `Maximize2/Minimize2` 的 import 而 Windows 分支仍在用 ⇒
 * 整颗「最大化/还原」按钮渲染为空（不报错、不影响构建，只有这条守卫能拦）。
 * 2026-09-17 起字形改为按 **Win11 Fluent** 自绘的细线 SVG（`data-win-glyph` 标记），
 * 守卫随之重定位：盯"三个字形 + 最大化真的调后端命令"，不再盯 lucide import。
 */
const src = readFileSync(join(import.meta.dirname, "..", "components", "TitleBar.vue"), "utf8");
const scriptEnd = src.indexOf("</script>");
const script = src.slice(0, scriptEnd);
const template = src.slice(scriptEnd);

test("Win11 细线字形都在（最小化/最大化/还原按钮不为空）", () => {
  for (const glyph of ["minimize", "maximize", "restore"]) {
    assert.ok(
      template.includes(`data-win-glyph="${glyph}"`),
      `TitleBar 模板应包含 ${glyph} 字形（缺了 = 该按钮渲染为空）`,
    );
  }
});

test("最大化切换必须真的调后端命令（否则按钮只是装饰）", () => {
  // 模板走 `toggleMaximize()` 包装函数，命令调用在 script 里
  assert.ok(script.includes("api.windowToggleMaximize"), "最大化按钮必须（经包装函数）调 windowToggleMaximize");
  assert.ok(template.includes("toggleMaximize"), "模板必须把最大化按钮接到 toggleMaximize");
  assert.ok(script.includes("api.windowIsMaximized"), "切图标需要 is_maximized（还原/最大化两态）");
  // 最小化/关闭直接在模板上调命令（两个平台分支各一处）
  assert.ok(template.includes("api.windowMinimize"), "最小化按钮必须调 windowMinimize");
  assert.ok(template.includes("api.windowClose"), "关闭按钮必须调 windowClose");
});
