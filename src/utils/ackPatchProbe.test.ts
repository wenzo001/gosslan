import assert from "node:assert/strict";
import test from "node:test";
import { computed, ref } from "vue";
import type { MessageRecord } from "../types.ts";
import { patchMessageInConv, patchMessageInConvLocal } from "./messages.ts";

function message(msg_id: string, kind: MessageRecord["kind"]): MessageRecord {
  return {
    id: msg_id,
    msg_id,
    conv_id: "a",
    sender_id: "me",
    receiver_id: "peer",
    kind,
    content: msg_id,
    ts: 1,
    seq: 1,
    status: "sending",
    fail_code: null,
  } as MessageRecord;
}

/** F-11 修复前基线探针：Ack 走不可变补丁时，根表、目标数组与派生列表都会换引用。 */
test("Ack 基线探针：旧补丁会让 ChatWindow 的派生消息列表整体换引用", () => {
  const source = ref<Record<string, MessageRecord[]>>({
    a: [message("m1", "text"), message("m2", "image")],
    b: [message("m1", "text")],
  });
  const rendered = computed(() =>
    (source.value.a ?? []).filter((m) => m.kind === "text" || m.kind === "image"),
  );
  const beforeRoot = source.value;
  const beforeList = source.value.a;
  const beforeRendered = rendered.value;

  const hit = patchMessageInConv(source.value, "a", "m1", (m) => ({
    ...m,
    status: "delivered",
  }));
  assert.ok(hit);
  source.value = hit.lists;

  assert.notEqual(source.value, beforeRoot, "旧实现替换根 Record");
  assert.notEqual(source.value.a, beforeList, "旧实现替换目标会话数组");
  assert.notEqual(rendered.value, beforeRendered, "旧实现让 computed 派生列表整体换引用");
});

test("Ack 局部补丁：根表、目标数组和其它会话引用不变", () => {
  const root: Record<string, MessageRecord[]> = {
    a: [message("m1", "text"), message("m2", "image")],
    b: [message("m1", "text")],
  };
  const list = root.a;
  const other = root.b;
  const hit = patchMessageInConvLocal(root, "a", "m1", (m) => ({ ...m, status: "delivered" }));
  assert.equal(hit?.status, "delivered");
  assert.equal(root.a, list);
  assert.equal(root.b, other);
  assert.equal(root.a[1], list[1]);
});
