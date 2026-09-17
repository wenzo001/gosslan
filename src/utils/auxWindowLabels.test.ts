import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUP_TODOS_LABEL_PREFIX, groupTodosGroupId, groupTodosLabel } from "./auxWindowLabels.ts";

test("groupTodosLabel / groupTodosGroupId 往返一致", () => {
  const id = "g-1f2e3d4c-0000-0000-0000-000000000000";
  assert.equal(groupTodosLabel(id), `${GROUP_TODOS_LABEL_PREFIX}${id}`);
  assert.equal(groupTodosGroupId(groupTodosLabel(id)), id);
});

test("groupTodosGroupId：前缀不符 → null", () => {
  assert.equal(groupTodosGroupId("main"), null);
  assert.equal(groupTodosGroupId("settings"), null);
  // 前缀只算「开头」：中间的 todo- 不算
  assert.equal(groupTodosGroupId("xtodo-g-1"), null);
});

test("groupTodosGroupId：前缀对但 ID 非法/为空/超长 → null", () => {
  assert.equal(groupTodosGroupId(GROUP_TODOS_LABEL_PREFIX), null, "空 ID");
  assert.equal(groupTodosGroupId(`${GROUP_TODOS_LABEL_PREFIX}a b`), null, "含空格");
  assert.equal(groupTodosGroupId(`${GROUP_TODOS_LABEL_PREFIX}a/b`), null, "含斜杠");
  assert.equal(groupTodosGroupId(`${GROUP_TODOS_LABEL_PREFIX}${"x".repeat(41)}`), null, "超 40");
});

test("groupTodosGroupId：合法字符集（字母/数字/下划线/连字符）通过", () => {
  assert.equal(groupTodosGroupId(`${GROUP_TODOS_LABEL_PREFIX}AbC_123-x`), "AbC_123-x");
});
