import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主界面版本号（用户 2026-11-07）：会话列表页脚右端，纯展示、桌面与移动共用同一落点。
 *
 * 判据（任何一条不满足即红）：
 *   1. 值只能来自 `package.json`：必须有 `import { version } from "…/package.json"`，
 *      并用 `` `v${version}` `` 拼出来 —— 手写第二处 `v5.18.78` 就红。
 *   2. 模板里渲染的是那个变量（`{{ appVersion }}`），不是字面量。
 *   3. 它是 `<span data-app-version>`：带 `pointer-events-none`，标签内没有 `@click` / `href` /
 *      `role="button"` —— 不许变成「关于」的第二个入口。
 *
 * 反例自证在文件末尾两条：写死版本号 / 改成可点按钮 ⇒ 都会红。
 */
export function checkMainVersionBadge(src: string): string[] {
  const issues: string[] = [];
  if (!/import\s*\{\s*version\s*\}\s*from\s*"(\.\.\/)+package\.json"/.test(src)) {
    issues.push('缺少 `import { version } from "../…/package.json"` —— 版本号必须来自唯一数据源。');
  }
  if (!/const\s+appVersion\s*=\s*`v\$\{version\}`/.test(src)) {
    issues.push("缺少 `const appVersion = `v${version}`` —— 前缀可以手写，数字不许。");
  }
  if (!/\{\{\s*appVersion\s*\}\}/.test(src)) {
    issues.push("模板没有渲染 `{{ appVersion }}`（疑似写死了版本号字面量）。");
  }
  // 只要在组件里出现形如 5.18.78 / v5.18.78 的版本字面量 ⇒ 第二处手写，红。
  const literal = src.match(/\bv?\d+\.\d+\.\d+\b/);
  if (literal) issues.push(`源码里出现写死的版本字面量 \`${literal[0]}\` —— 改版本时会漂。`);

  const span = src.match(/<span[^>]*data-app-version[^>]*>/);
  if (!span) {
    issues.push("找不到 `<span data-app-version>`（主界面版本号那一个落点）。");
  } else {
    if (!/pointer-events-none/.test(span[0])) {
      issues.push("版本号必须 `pointer-events-none`（纯展示，不参与点击命中）。");
    }
    if (/@click|href=|role="button"/.test(span[0])) {
      issues.push("版本号不许可点 —— 它不是「关于」的入口。");
    }
  }
  return issues;
}

const COMPONENT = join(import.meta.dirname, "..", "components", "ConversationList.vue");

test("主界面版本号：真实源码通过", () => {
  const issues = checkMainVersionBadge(readFileSync(COMPONENT, "utf8"));
  assert.deepEqual(issues, []);
});

test("反例：把变量换成写死的版本号 ⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace(/\{\{\s*appVersion\s*\}\}/, "{{ 'v5.18.78' }}");
  const issues = checkMainVersionBadge(src);
  assert.ok(issues.some((x) => x.includes("appVersion") || x.includes("字面量")), issues.join(" / "));
});

test("反例：把版本号改成可点按钮（当成第二个「关于」入口）⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace(
    "<span\n          data-app-version",
    '<button\n          data-app-version\n          @click="router.push(\'/me\')"',
  );
  const issues = checkMainVersionBadge(src);
  assert.ok(issues.some((x) => x.includes("data-app-version")), issues.join(" / "));
});
