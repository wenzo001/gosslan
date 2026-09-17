import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 模板里用到的组件（含 lucide 图标）都必须在 script 里 import。
 *
 * 背景（2026-09-17 真实缺陷）：GroupTasksBoard 的状态胶囊写了 `<ChevronDown>` 却没
 * import —— Vue 把未知标签当**原生元素**静默渲染成空，界面上箭头直接消失，
 * 不报任何错，`vue-tsc` 默认也不查（非 strictTemplates 模式下未知标签当作合法的
 * 自定义元素）。这类退化只有全量比对能拦住。
 *
 * 判定：模板（去掉 HTML 注释）里每个 `<PascalCase` 标签，其名字必须出现在
 * script 段中（import 语句里）。Vue 内置组件白名单放行。
 */
const BUILT_INS = new Set(["Transition", "TransitionGroup", "KeepAlive", "Teleport", "Suspense"]);

function listVueFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listVueFiles(p, out);
    else if (name.endsWith(".vue")) out.push(p);
  }
  return out;
}

test("模板里用到的组件（含 lucide 图标）都必须在 script 里 import", () => {
  const srcDir = join(import.meta.dirname, "..");
  const bad: string[] = [];
  for (const file of listVueFiles(srcDir)) {
    const src = readFileSync(file, "utf8");
    const scriptEnd = src.indexOf("</script>");
    if (scriptEnd < 0) continue;
    const script = src.slice(0, scriptEnd);
    const template = src.slice(scriptEnd).replace(/<!--[\s\S]*?-->/g, "");
    for (const m of template.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) {
      const name = m[1];
      if (BUILT_INS.has(name)) continue;
      if (!script.includes(name)) bad.push(`${file}: <${name}> 在模板中使用但未 import`);
    }
  }
  assert.deepEqual(bad, [], `以下组件在模板中使用但没有 import（Vue 会静默渲染成空）:\n${bad.join("\n")}`);
});
