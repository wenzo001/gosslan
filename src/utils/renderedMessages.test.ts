import assert from "node:assert/strict";
import test from "node:test";
import type { MessageRecord } from "@/types";
import { reconcileRenderedMessages } from "./renderedMessages.ts";

const msg = (msg_id: string, kind: MessageRecord["kind"], status: MessageRecord["status"] = "sending") => ({
  msg_id, kind, status,
}) as MessageRecord;

test("Ack 后总列表引用稳定，只替换目标行", () => {
  const source = [msg("t1", "text"), msg("i1", "image"), msg("t2", "text"), msg("s1", "recall")];
  const rendered: MessageRecord[] = [];
  const visible = (m: MessageRecord) => m.kind === "text" || m.kind === "image";
  reconcileRenderedMessages(rendered, source, visible);
  const renderedRef = rendered;
  const imageRow = rendered[1];

  source[0] = msg("t1", "text", "delivered");
  reconcileRenderedMessages(rendered, source, visible);

  assert.equal(rendered, renderedRef);
  assert.equal(rendered[1], imageRow);
  assert.equal(rendered[0].status, "delivered");
});

test("反例：成员变化必须反映到总列表", () => {
  const rendered: MessageRecord[] = [];
  reconcileRenderedMessages(rendered, [msg("t1", "text"), msg("i1", "image")], () => true);
  reconcileRenderedMessages(rendered, [msg("i1", "image"), msg("i2", "image")], () => true);
  assert.deepEqual(rendered.map((row) => row.msg_id), ["i1", "i2"]);
});
