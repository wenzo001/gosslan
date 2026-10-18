import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dirname, "..", "components", "LogViewer.vue"),
  "utf8",
);

test("LogViewer：长列表走 TanStack Virtual，不再整表渲染", () => {
  assert.match(SRC, /useVirtualizer\(/, "必须用成熟的虚拟化原语");
  const wrappers = SRC.match(/v-for="v in virtualRows"/g) ?? [];
  assert.equal(wrappers.length, 2, "独立窗与移动页两条外壳都要走同一套虚拟行");
  assert.ok(!/v-for="r in mergedRows"/.test(SRC), "不许退回整表 v-for");
  assert.match(SRC, /:data-index="v\.index"/, "measureElement 要靠 data-index 找回行下标");
  assert.match(SRC, /:ref="measureRow"/, "每行必须交给 TanStack 实测高度");
  assert.match(SRC, /getItemKey:/, "键要跟日志行而不是数组下标，过滤/刷新时才不会整列重测");
});

test("LogViewer：过滤变化回到顶部（结果变短时不会落在越界滚动位）", () => {
  assert.match(
    SRC,
    /watch\(trimmedFilter,\s*\(\)\s*=>\s*virtualizer\.value\.scrollToOffset\(0\)\)/,
    "过滤值一变就 scrollToOffset(0)",
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
  assert.match(SRC, /count:\s*mergedRows\.value\.length/, "virtualizer 的 count 依赖 mergedRows");
  // 独立窗与移动页两条外壳各有一个滚动容器；少挂一个，virtualizer 就拿不到滚动元素，
  // 工具栏显示 N 条而列表区永远空白（2026-10-19 实测）。
  assert.equal(
    (SRC.match(/ref="logScroll"/g) ?? []).length,
    2,
    "独立窗与移动页都必须挂 logScroll，否则虚拟列表没有滚动元素",
  );
  const rowsAt = SRC.indexOf("const rows = computed(");
  const mergedAt = SRC.indexOf("const mergedRows = computed(");
  const virtualAt = SRC.indexOf("useVirtualizer(");
  assert.ok(rowsAt >= 0 && mergedAt >= 0 && virtualAt >= 0, "三个锚点都必须命中");
  assert.ok(rowsAt < virtualAt, "rows 必须先于 useVirtualizer 声明");
  assert.ok(mergedAt < virtualAt, "mergedRows 必须先于 useVirtualizer 声明（dev 立即求值 count）");
});
