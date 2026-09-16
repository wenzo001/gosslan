import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("TitleBar 用到的 lucide 图标都在 script 里 import（Windows 最大化按钮消失的回归）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "TitleBar.vue"), "utf8");
  const scriptEnd = src.indexOf("</script>");
  assert.ok(scriptEnd > 0, "TitleBar.vue 应有 script setup 块");
  const script = src.slice(0, scriptEnd);
  const template = src.slice(scriptEnd);
  // 这两个只在 Windows/Linux 分支用；0e07dd4 删了 import 后模板仍引用它，
  // 于是整颗「最大化/还原」按钮渲染为空（真机现象：按钮消失）。
  for (const icon of ["Maximize2", "Minimize2"]) {
    assert.ok(template.includes(icon), "护栏锚点：TitleBar 模板应仍在用 " + icon);
    assert.ok(
      script.includes(icon),
      "TitleBar.vue 的 script 必须 import " + icon + "（删掉它 Windows 上最大化/还原按钮会消失）",
    );
  }
});
