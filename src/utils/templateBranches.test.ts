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
