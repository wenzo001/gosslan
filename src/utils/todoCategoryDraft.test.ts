import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

test("任务详情：切到「自定义…」立刻展开并聚焦名字输入框", () => {
  const detail = readFileSync(
    join(root, "src/components/TodoDetailDialog.vue"),
    "utf8",
  );
  assert.match(
    detail,
    /const categoryDraft = ref<TodoCategory \| null>\(null\)/,
    "必须有一个本地 draft 档位，不能等 item.category 先落库",
  );
  assert.match(detail, /categoryDraft\.value = "custom"/, "选自定义时必须切本地档位");
  assert.match(detail, /customInput\.value\?\.focus\(\)/, "展开后必须聚焦输入框");
  assert.match(
    detail,
    /v-if="canChangeStatus && showCustomCategory"/,
    "输入框的显示条件必须看本地 draft",
  );
  assert.match(
    detail,
    /:model-value="categoryDraft \?\? item\.category \?\? 'task'"/,
    "类型选择器也要显示本地 draft，否则菜单看起来没选中",
  );
});

test("任务看板：新建/编辑表单选自定义后也自动聚焦", () => {
  const board = readFileSync(
    join(root, "src/components/GroupTasksBoard.vue"),
    "utf8",
  );
  assert.match(
    board,
    /const draftCustomInput = ref<HTMLInputElement \| null>\(null\)/,
    "必须有输入框 ref",
  );
  assert.match(board, /draftCustomInput\.value\?\.focus\(\)/, "选自定义后必须聚焦");
  assert.match(board, /ref="draftCustomInput"/, "模板 input 必须挂上 ref");
});
