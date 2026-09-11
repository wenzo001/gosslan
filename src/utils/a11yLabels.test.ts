import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findUnlabeledButtons, findUnnamedImages } from "./a11yLabels.ts";

// ---------------- 无名按钮：图标按钮只写 title 不算可访问名 ----------------
//
// 审计背景（2026-09-10）：全库 60 余处图标按钮只写了 `title`。`title` 是鼠标工具提示，
// 触屏（VoiceOver / TalkBack）基本读不到，桌面读屏也不保证作为控件标签播报 ——
// 于是"关闭 / 删除 / 返回 / 重新发送"这些按钮在读屏下等于**无名按钮**。

test("纯图标按钮没有 aria-label → 报出，并指到那一行", () => {
  const buggy = `<template>
  <div>
    <button
      class="flex h-7 w-7"
      title="删除"
      @click="del()"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>`;
  const issues = findUnlabeledButtons(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 3, "应精确指到 <button 那一行");
});

test("补上 aria-label 后通过", () => {
  const fixed = `<template>
  <button title="删除" aria-label="删除聊天记录"><X /></button>
</template>`;
  assert.deepEqual(findUnlabeledButtons(fixed), []);
});

test("动态绑定 :aria-label 与 v-bind:aria-label 都算数", () => {
  assert.deepEqual(
    findUnlabeledButtons(`<template><button :aria-label="label"><X /></button></template>`),
    [],
  );
  assert.deepEqual(
    findUnlabeledButtons(`<template><button v-bind:aria-label="label"><X /></button></template>`),
    [],
  );
});

test("有可见文本 / 插值 / v-html 的按钮不算无名（它们的名字来自内容）", () => {
  assert.deepEqual(findUnlabeledButtons(`<template><button><X />删除</button></template>`), []);
  assert.deepEqual(findUnlabeledButtons(`<template><button><X />{{ label }}</button></template>`), []);
  assert.deepEqual(findUnlabeledButtons(`<template><button v-html="html"></button></template>`), []);
});

test("内部 <img> 带非空 alt 时，alt 可作可访问名", () => {
  assert.deepEqual(
    findUnlabeledButtons(`<template><button><img src="a.png" alt="头像" /></button></template>`),
    [],
  );
});

test("嵌套 <template> 不会截断扫描（ChatHeader 曾因此漏报 3 个按钮）", () => {
  // 真实结构：标题里带一个嵌套 <template v-if>，其后仍有按钮需要检查。
  // 旧实现复用 templateBranches.extractTemplate（非贪婪匹配 </template>）会在这里截断，
  // 只扫得到第一个按钮 → 护栏给出"全绿"的假象。
  const withNested = `<template>
  <div>
    <span>{{ name }}<template v-if="isGroup"> ({{ n }})</template></span>
    <button title="返回" aria-label="返回"><ArrowLeft /></button>
    <button title="群成员"><Users /></button>
    <button title="共享目录"><FolderOpen /></button>
  </div>
</template>`;
  const issues = findUnlabeledButtons(withNested);
  assert.equal(issues.length, 2, "嵌套 template 之后的两个无名按钮都必须被扫到");
  assert.ok(issues[0].snippet.includes('title="群成员"'), `实际：${issues[0].snippet}`);
  assert.ok(issues[1].snippet.includes('title="共享目录"'), `实际：${issues[1].snippet}`);
  // 已带 aria-label 的「返回」不能被误报
  assert.ok(!issues.some((i) => i.snippet.includes("返回")));
});

test("逃生阀：带 a11y-label-ok 的文件整体跳过", () => {
  const optedOut = `<!-- a11y-label-ok -->
<template><button title="x"><X /></button><img :src="a" /></template>`;
  assert.deepEqual(findUnlabeledButtons(optedOut), []);
  assert.deepEqual(findUnnamedImages(optedOut), []);
});

// ---------------- 图片 alt ----------------
//
// `alt=""`（显式空）是"这是装饰、读屏请跳过"的**正确**写法，所以判据是
// 「出现过 alt」而不是「alt 非空」——真正要禁的是"忘记写 alt"。

test("没有 alt 的 <img> 会被报出来", () => {
  const buggy = `<template>
  <div>
    <img :src="avatar" class="h-full w-full object-cover" />
  </div>
</template>`;
  const issues = findUnnamedImages(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 3);
});

test("alt=\"\" / :alt / v-bind:alt 都算已声明", () => {
  assert.deepEqual(
    findUnnamedImages(`<template><img :src="a" alt="" /><img :src="b" :alt="name" /></template>`),
    [],
  );
  assert.deepEqual(findUnnamedImages(`<template><img :src="a" v-bind:alt="n" /></template>`), []);
});

test("嵌套 <template> 之后的 <img> 同样会被检查", () => {
  const nested = `<template>
  <div>
    <span>{{ n }}<template v-if="g"> ({{ n }})</template></span>
    <img :src="a" alt="" />
    <img :src="b" />
  </div>
</template>`;
  const issues = findUnnamedImages(nested);
  assert.equal(issues.length, 1, "嵌套之后的缺 alt 图片必须被扫到");
});

// ---------------- 全库扫描：本项目现存模板必须全部干净 ----------------

function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectVueFiles(full, out);
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out;
}

test("src 下所有 .vue 都没有「纯图标且无名字来源」的按钮", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findUnlabeledButtons(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.snippet}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `发现无名按钮（补 aria-label，或与 title 并存）：\n${bad.join("\n")}`,
  );
});

test("src 下所有 .vue 的 <img> 都声明了 alt（含装饰性 alt=\"\"）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findUnnamedImages(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.snippet}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `发现没有 alt 的图片（装饰性请写 alt=""，内容图写实际描述）：\n${bad.join("\n")}`,
  );
});
