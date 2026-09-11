import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findBranchIssues } from "./templateBranches.ts";

// ---------------- 分支链切断：一条消息被渲染两遍的成因 ----------------
//
// 事故复盘（提交 fd02f62）：MessageItem 的「图片已被清理」占位写成 v-if，
// 切断了「文本 → 代码 → 图片 → 文件 → 兜底」这条链，兜底的
// `<div v-else>{{ content }}</div>` 因此对每条文本/代码消息都成立。
// 下面这段就是按当时的真实结构缩写的。

/** 修复前：尾部链以 v-if 起头 → 切断上面的链 → 兜底 v-else 变成独立分支。 */
const BUGGY = `<template>
  <div class="group/row">
    <MessageReceipt v-if="mine" />
    <MessageTextBubble v-if="kind === 'text'" />
    <MessageCodeBubble v-else-if="streamCode !== null" />
    <div v-if="kind === 'image' && attachmentMissing">图片已被清理</div>
    <MessageImageBubble v-else-if="kind === 'image'" />
    <MessageFileBubble v-else-if="kind === 'file' && fileMeta" />
    <div v-else>{{ content }}</div>
  </div>
</template>`;

/** 修复后：只把那一行改成 v-else-if。 */
const FIXED = BUGGY.replace(
  'v-if="kind === \'image\' && attachmentMissing"',
  'v-else-if="kind === \'image\' && attachmentMissing"',
);

test("修复前的写法会被判为分支链切断，并指到那一行", () => {
  const issues = findBranchIssues(BUGGY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "chain-break");
  // `<template>` 在第 1 行，故 v-if 落在第 6 行
  assert.equal(issues[0].line, 6, "应精确指到那一行 v-if");
  assert.match(issues[0].message, /渲染两次/);
});

test("改成 v-else-if 后不再报（链完整）", () => {
  assert.deepEqual(findBranchIssues(FIXED), []);
});

test("彼此独立的 v-if 不误报（回执 / 拖拽提示层 / 昵称是本项目的合法写法）", () => {
  // 关键：这些 v-if 各自独立、不存在互斥关系，后者的 v-else 也不会覆盖前者。
  const independent = `<template>
    <div>
      <MessageReceipt v-if="mine" />
      <MessageTextBubble v-if="kind === 'text'" />
      <MessageCodeBubble v-else-if="streamCode !== null" />
    </div>
  </template>`;
  assert.deepEqual(findBranchIssues(independent), []);
});

test("孤儿 v-else 会被报出来", () => {
  const orphan = `<template>
    <div>
      <span>静态元素</span>
      <div v-else>{{ content }}</div>
    </div>
  </template>`;
  const issues = findBranchIssues(orphan);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "orphan");
});

test("单层 v-if / v-else 是正常的，不报", () => {
  const ok = `<template>
    <div>
      <span v-if="loading">载入中</span>
      <span v-else>好了</span>
    </div>
  </template>`;
  assert.deepEqual(findBranchIssues(ok), []);
});

// ---------------- 2026-09-10 修正：两个此前被掩盖的问题 ----------------
//
// ① 提取模板时用非贪婪 `</template>` → 遇到**嵌套 <template>** 就截断，
//    其后整段模板不检查（护栏给出"全绿"假象）。修正后 `ChatHeader.vue`
//    从"只扫到 1 个按钮"变为扫到全部。
// ② 判据只看"前面有几个带条件的兄弟"，会把**连续多个独立 v-if** 误判为链。
//    真实误报：`ImageLightbox` 的两个 `v-if="hasMultiple"` 翻页按钮、
//    `GroupMemberPanel` 的 `v-if="!isOwner"` 按钮 + 提示。

test("嵌套 <template> 之后的模板仍会被检查（不再截断）", () => {
  // 下面的嵌套 <template> 会让旧的 extractTemplate 提前收尾；
  // 若不修，后面那个真正的链切断会被静默漏掉。
  const nested = `<template>
    <div>
      <span>{{ name }}<template v-if="isGroup"> ({{ n }})</template></span>
      <A v-if="k === 'a'" />
      <B v-else-if="k === 'b'" />
      <C v-if="extra" />
      <D v-else />
    </div>
  </template>`;
  const issues = findBranchIssues(nested);
  assert.equal(issues.length, 1, "嵌套 template 之后的链切断必须被扫到");
  assert.equal(issues[0].tag, "C");
});

test("连续多个独立 v-if 不算链，插在其后的 v-else 不报（真实误报回归）", () => {
  // 形状取自 ImageLightbox：两个 v-if="hasMultiple" 的按钮，之后才是 v-if/v-else。
  const lightbox = `<template>
    <div>
      <button v-if="hasMultiple">上一张</button>
      <button v-if="hasMultiple">下一张</button>
      <template v-if="src" />
      <div v-else>无法预览</div>
    </div>
  </template>`;
  assert.deepEqual(findBranchIssues(lightbox), []);

  // 形状取自 GroupMemberPanel：独立 v-if 的按钮 + 独立的 v-if/v-else 提示。
  const panel = `<template>
    <div>
      <template v-if="isOwner">群主区</template>
      <button v-if="!isOwner">退出群聊</button>
      <p v-if="!isOwner">仅群创建者可管理成员</p>
      <p v-else>群主如需退出请先转让</p>
    </div>
  </template>`;
  assert.deepEqual(findBranchIssues(panel), []);
});

test("真链（含 v-else-if）被切断仍然要报 —— 收紧判据不能放过真缺陷", () => {
  const real = `<template>
    <div>
      <A v-if="k === 'a'" />
      <B v-else-if="k === 'b'" />
      <C v-if="extra" />
      <D v-else />
    </div>
  </template>`;
  const issues = findBranchIssues(real);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "chain-break");
});

// ---------------- 全库扫描：本项目现存模板必须全部干净 ----------------
//
// 这条是真正的护栏。上面那个缺陷是"静默"的 —— vue-tsc 与既有单测都覆盖不到
// 模板分支结构，所以它随 fd02f62 一路提交进仓库。改成渲染两遍后用户一眼可见，
// 但根因藏在模板里、且修复只是一个词的差别，极易复发。

function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectVueFiles(full, out);
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out;
}

test("src 下所有 .vue 模板都没有分支链问题", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findBranchIssues(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line} <${issue.tag}> ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现分支链问题：\n${bad.join("\n")}`);
});
