import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

/**
 * 这两条判据原先盯着详情弹窗/看板里的**本地 draft**（各自一份 `customInput` ref）。
 *
 * 2026-11-05 的统一属性控件把「自定义类型名」收进 `TodoAttrTypeField` 的面板里：
 * 聚焦逻辑只有一份，详情弹窗与看板表单共用。判据跟着锚点一起搬到新家 ——
 * 否则旧断言会一直绿着，却查不到真正负责聚焦的那段代码（"检查还在跑、但已查不到东西"）。
 */
test("任务详情：切到「自定义…」立刻展开并聚焦名字输入框", () => {
  const field = readFileSync(join(root, "src/components/TodoAttrTypeField.vue"), "utf8");
  assert.match(
    field,
    /const customOpen = ref\(false\)/,
    "必须有本地 draft 档位，不能等 item.category 先落库",
  );
  assert.match(field, /customOpen\.value = true/, "选自定义时必须展开本地档位");
  assert.match(field, /customInput\.value\?\.focus\(\)/, "展开后必须聚焦输入框");
  assert.match(field, /ref="customInput"/, "面板里的 input 必须挂上 ref");
  assert.match(field, /v-if="customOpen"/, "输入框的显示条件必须看本地档位");
  assert.match(
    field,
    /o\.value === modelValue/,
    "菜单必须按当前值显示选中项，否则打开面板看起来没选中",
  );
});

test("任务看板/详情都通过 TodoAttrTypeField 复用同一份聚焦实现", () => {
  const board = readFileSync(join(root, "src/components/GroupTasksBoard.vue"), "utf8");
  // 2026-11-08：详情字段区拆到 `TodoDetailFields.vue`（弹窗与群任务窗口右栏共用）。
  const detail = readFileSync(join(root, "src/components/TodoDetailFields.vue"), "utf8");
  assert.match(board, /<TodoAttrTypeField/, "看板表单必须走统一类型控件");
  assert.match(detail, /<TodoAttrTypeField/, "详情弹窗必须走统一类型控件");
  assert.ok(
    !/draftCustomInput/.test(board),
    "看板不许再留第二份自定义名输入框（两份迟早只改一处）",
  );
});
