import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "components", name), "utf8");
/** 外壳（独立窗 / 移动页两种）—— 虚拟器与滚动容器住在这里。 */
const SHELL = read("LogViewer.vue");
/** 行模板（2026-10-29 审计 DUP-05 后只有一个家）—— `v-html` 与 `v-memo` 住在这里。 */
const ROWS = read("LogRows.vue");

test("日志列表：长列表走 TanStack Virtual，行模板只有一份", () => {
  assert.match(SHELL, /useVirtualizer\(/, "必须用成熟的虚拟化原语");
  // 两个外壳各挂一处同一份行组件；行模板本身只许存在一份（原先是两壳各抄一遍逐字相同的 4 个 v-html）。
  assert.equal(
    (SHELL.match(/<LogRows\s/g) ?? []).length,
    2,
    "独立窗与移动页两条外壳都要挂 <LogRows>（少一个 = 那一档外壳没有列表）",
  );
  assert.equal(
    (ROWS.match(/v-for="v in items"/g) ?? []).length,
    1,
    "虚拟行模板必须只有一份（被抄回第二份 = 两种窗口的渲染判据从此分叉）",
  );
  assert.equal(
    (SHELL.match(/v-html=/g) ?? []).length,
    0,
    "外壳里又长出 v-html= ⇒ 行模板被抄回第二份了",
  );
  assert.ok(!/v-for="r in mergedRows"/.test(SHELL), "不许退回整表 v-for");
  assert.match(ROWS, /:data-index="v\.index"/, "measureElement 要靠 data-index 找回行下标");
  assert.match(ROWS, /:ref="measure"/, "每行必须交给 TanStack 实测高度（外壳把 measureRow 传进来）");
  assert.match(SHELL, /:measure="measureRow"/, "外壳必须把实测函数接到行组件上");
  assert.match(SHELL, /getItemKey:/, "键要跟日志行而不是数组下标，过滤/刷新时才不会整列重测");
});

/**
 * `v-memo` 少一个字段不报错、不崩，只让那一格在 2 秒轮询后仍画旧值（用户看到的是"日志没更新"）。
 * 这条把"模板里真正渲染的字段"与"memoDeps 里列的判据"逐项比 —— 新增字段忘了加进依赖会当场红。
 */
test("LogRows：模板里渲染的每个 row 字段都必须进 v-memo 判据", () => {
  const rendered = new Set([...ROWS.matchAll(/\bv\.row\.(\w+)/g)].map((m) => m[1]));
  assert.ok(rendered.size >= 4, `只解析到 ${rendered.size} 个渲染字段 ⇒ 提取器坏了`);
  const at = ROWS.indexOf("function memoDeps");
  assert.ok(at > 0, "找不到 memoDeps（判据会空转）");
  const listed = new Set(
    [...ROWS.slice(at, ROWS.indexOf("]", ROWS.indexOf("[", at))).matchAll(/\br\.(\w+)/g)].map((m) => m[1]),
  );
  assert.ok(listed.size >= 4, `memoDeps 里只解析到 ${listed.size} 个判据 ⇒ 提取器坏了`);
  const missing = [...rendered].filter((f) => !listed.has(f)).sort();
  assert.deepEqual(missing, [], `这些字段渲染了却没进 v-memo 判据 ⇒ 永远不会刷新：${missing.join(", ")}`);
});

test("LogViewer：过滤变化回到顶部（结果变短时不会落在越界滚动位）", () => {
  assert.match(
    SHELL,
    /watch\(trimmedFilter,\s*\(\)\s*=>\s*\{[\s\S]{0,240}virtualizer\.value\.measure\(\)[\s\S]{0,240}virtualizer\.value\.scrollToOffset\(0\)/,
    "过滤值一变就清测量缓存并 scrollToOffset(0)",
  );
});

/**
 * 开发环境日志窗口白屏的真实根因（2026-10-19）：
 * `useVirtualizer` 的 options 是一个 computed，Vue dev 构建会在 setup 期间**立即求值**
 * `count: mergedRows.value.length`；如果 `mergedRows` 声明在后面，就抛
 * `Cannot access 'mergedRows' before initialization`（TDZ），LogViewer 整棵子树退化成
 * 注释节点 ⇒ 窗口空白；生产构建晚一步求值，所以看起来正常。
 * 这条钉住声明顺序，防止以后把 `rows`/`mergedRows` 再挪到 virtualizer 之后。
 */
test("LogViewer：virtualizer 依赖的 mergedRows 必须先于 useVirtualizer 声明（dev TDZ 白屏）", () => {
  assert.match(SHELL, /count:\s*mergedRows\.value\.length/, "virtualizer 的 count 依赖 mergedRows");
  // 独立窗与移动页两条外壳各有一个滚动容器；少挂一个，virtualizer 就拿不到滚动元素，
  // 工具栏显示 N 条而列表区永远空白（2026-10-19 实测）。
  assert.equal(
    (SHELL.match(/ref="logScroll"/g) ?? []).length,
    2,
    "独立窗与移动页都必须挂 logScroll，否则虚拟列表没有滚动元素",
  );
  const rowsAt = SHELL.indexOf("const rows = computed(");
  const mergedAt = SHELL.indexOf("const mergedRows = computed(");
  const virtualAt = SHELL.indexOf("useVirtualizer(");
  assert.ok(rowsAt >= 0 && mergedAt >= 0 && virtualAt >= 0, "三个锚点都必须命中");
  assert.ok(rowsAt < virtualAt, "rows 必须先于 useVirtualizer 声明");
  assert.ok(mergedAt < virtualAt, "mergedRows 必须先于 useVirtualizer 声明（dev 立即求值 count）");
});
