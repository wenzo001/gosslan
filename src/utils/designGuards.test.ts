import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkStyleCascade, findHoverRevealIssues } from "./designGuards.ts";

// ---------------- ① 悬停揭示必须有触屏兜底 ----------------
//
// 真实事故（2026-09-10 审计 P0-1）：会话行的删除键写成
// `hidden` + `group-hover/conv:flex` —— 桌面能删、**Android 上按钮永远不显示**，
// 因为触屏没有 hover。第一段用例就是照当时的真实写法缩写的。

test("复现历史缺陷：hidden + group-hover:flex 没有兜底类 → 报出", () => {
  const buggy = `<template>
  <div class="group/conv relative flex h-[64px]">
    <button class="absolute bottom-1.5 right-1.5 z-10 hidden h-6 w-6 group-hover/conv:flex">
      <X />
    </button>
  </div>
</template>`;
  const issues = findHoverRevealIssues(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 3, "应精确指到那一行");
  assert.match(issues[0].message, /永远不显示/);
});

test("加了 hover-reveal 之后通过", () => {
  const fixed = `<template>
  <button class="hover-reveal hidden h-6 w-6 group-hover/conv:flex"><X /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(fixed), []);
});

test("opacity-0 + group-hover 揭示 → 需要 hover-reveal-op", () => {
  const buggy = `<template>
  <span class="absolute inset-0 bg-black/40 opacity-0 transition group-hover:opacity-100"><Camera /></span>
</template>`;
  const issues = findHoverRevealIssues(buggy);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /hover-reveal-op/);

  const fixed = buggy.replace('class="absolute', 'class="hover-reveal-op absolute');
  assert.deepEqual(findHoverRevealIssues(fixed), []);
});

test("常显但 hover 时更不透明（opacity-70 → opacity-100）不算揭示，不报", () => {
  const ok = `<template>
  <button class="opacity-70 transition hover:opacity-100"><Copy /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(ok), []);
});

test("独立的 hover 效果（不是揭示）不报", () => {
  const ok = `<template>
  <button class="hidden hover:bg-red-500/10"><X /></button>
  <button class="opacity-0 hover:opacity-100"><X /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(ok), []);
});

test("逃生阀：带 hover-reveal-ok 的文件整体跳过", () => {
  const optedOut = `<!-- hover-reveal-ok -->
<template><button class="hidden group-hover:flex"><X /></button></template>`;
  assert.deepEqual(findHoverRevealIssues(optedOut), []);
});

// ---------------- ② 降级媒体查询必须排在 style.css 末尾 ----------------
//
// 真实踩坑：`.glass` / `.frost` 的定义在文件中更靠后，同优先级下"后定义者胜"，
// 降级块写在前面会被**完整覆盖**——不报错、不失败，只是静默无效。

const OK_CSS = `
.glass { backdrop-filter: blur(6px); }
.frost { backdrop-filter: blur(6px); }

@media (hover: none) {
  .hover-reveal { display: flex !important; }
  .hover-reveal-op { opacity: 1 !important; }
}

@media (prefers-reduced-transparency: reduce) {
  .frost { backdrop-filter: none; }
  .glass { backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  :root { --gosslan-border: #94a3b8; }
}
`;

test("正确顺序（降级块在末尾）→ 通过", () => {
  assert.deepEqual(checkStyleCascade(OK_CSS), []);
});

test("降级块排在 .glass/.frost 定义之前 → 报出（会被覆盖而静默失效）", () => {
  const wrongOrder = `
@media (prefers-reduced-transparency: reduce) {
  .glass { backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  :root { --gosslan-border: #94a3b8; }
}
.glass { backdrop-filter: blur(6px); }
.frost { backdrop-filter: blur(6px); }
@media (hover: none) {
  .hover-reveal { display: flex !important; }
  .hover-reveal-op { opacity: 1 !important; }
}
`;
  const issues = checkStyleCascade(wrongOrder);
  const messages = issues.map((i) => i.message).join("\n");
  assert.match(messages, /降低透明度/);
  assert.match(messages, /提高对比度/);
});

test("缺少降级块 / 缺少 hover 兜底块 → 都要报", () => {
  const bare = `.glass { backdrop-filter: blur(6px); }\n`;
  const messages = checkStyleCascade(bare).map((i) => i.message).join("\n");
  assert.match(messages, /降低透明度/);
  assert.match(messages, /提高对比度/);
  assert.match(messages, /hover: none/);
});

test(".hover-reveal 定义在 (hover: none) 之外 → 报出（会在有 hover 的设备上也常显）", () => {
  const wrong = `
.hover-reveal { display: flex !important; }
.hover-reveal-op { opacity: 1 !important; }
@media (hover: none) {
  .tap-safe { position: relative; }
}
.glass { backdrop-filter: blur(6px); }
@media (prefers-reduced-transparency: reduce) { .glass { backdrop-filter: none; } }
@media (prefers-contrast: more) { :root { --gosslan-border: #94a3b8; } }
`;
  const messages = checkStyleCascade(wrong).map((i) => i.message).join("\n");
  assert.match(messages, /@media \(hover: none\) 之外/);
});

// ---------------- 全库扫描：真实文件必须干净 ----------------

function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectVueFiles(full, out);
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out;
}

test("src 下所有 .vue 的悬停揭示都带了触屏兜底", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findHoverRevealIssues(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现缺少触屏兜底的悬停揭示：\n${bad.join("\n")}`);
});

test("真实的 src/style.css 级联顺序正确", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  const issues = checkStyleCascade(css);
  assert.deepEqual(issues, [], issues.map((i) => `L${i.line} ${i.message}`).join("\n"));
});
