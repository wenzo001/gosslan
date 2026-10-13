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

/**
 * 最大化/全屏状态必须**跟窗口同步刷新**。
 *
 * 真实缺陷（用户 2026-10-12）：「点了最大化 / 全屏，按钮图标不变成还原的样子」。
 * 根因：`refreshMaximized()` 只在 `onMounted` 里问一次，之后按钮是用户点的、
 * 状态天天在变，不订阅就一直是初始字形——方法成功失败都看不出来。
 * 前端 go green 的另一半在 `src-tauri/src/commands/window.rs`：那里原先用
 * `is_maximizable()` 当判据，而它在 macOS Borderless 窗上**恒 false**
 * （tao 0.35.3 `platform_impl/macos/window.rs:216-222` 无 Titled 位 ⇒ 无 zoom button
 * ⇒ `is_maximizable()` 取不到 button 返回 false），于是命令整条早退**什么都没做**。
 * 两侧都修才有反应：Rust 换成显式白名单，前端订阅 `onResized` 刷字形。
 *
 * 这条守卫两个断言分别钉住两侧的接线：订阅函数必须在，且两个刷新函数都要在
 * onMounted/onResized 两条路径上被真正调到。
 */
test("最大化/全屏状态必须订阅窗口尺寸变化（否则图标永远是初始字形）", () => {
  assert.ok(
    script.includes("onResized"),
    "TitleBar 必须订阅 onResized —— 只在 onMounted 问一次，用户点了按钮图标也不会变",
  );
  for (const fn of ["refreshMaximized", "refreshFullscreen"]) {
    assert.ok(
      script.includes(`${fn}()`),
      `${fn} 必须存在且被调用（缺 = 该状态永远不刷新）`,
    );
  }
  // onMounted 与 onResized 两条路径都要刷（只刷挂载 = 用户点了没反应；只刷事件 = 首帧错）
  assert.ok(
    /onMounted\(\(\) => \{[\s\S]*?refreshMaximized\(\);[\s\S]*?refreshFullscreen\(\);/.test(script),
    "onMounted 里要同时刷 maximized 与 fullscreen",
  );
  assert.ok(
    /onResized\(\(\) => \{[\s\S]*?refreshMaximized\(\);[\s\S]*?refreshFullscreen\(\);/.test(script),
    "onResized 回调里要同时刷 maximized 与 fullscreen",
  );
  // 退订必须成对出现（漏退订 = 组件反复挂载后监听器堆积）
  assert.ok(
    /onBeforeUnmount\(\(\) => \{[\s\S]*?unlistenResize\?\.\(\);[\s\S]*?unlistenResize = null;/.test(script),
    "onBeforeUnmount 必须退订 onResized",
  );
});
