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
