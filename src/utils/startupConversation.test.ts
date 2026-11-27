import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "@/types";
import { restoreLastConversationId } from "./startupConversation.ts";

const conv = (id: string) => ({ id }) as Conversation;

test("冷启动恢复 last：last 非首条时只选 last", () => {
  assert.equal(restoreLastConversationId("second", [conv("first"), conv("second")]), "second");
});

test("反例：无 last 或 last 已删除时不再回退首条", () => {
  assert.equal(restoreLastConversationId(null, [conv("first")]), null);
  assert.equal(restoreLastConversationId("gone", [conv("first")]), null);
});
