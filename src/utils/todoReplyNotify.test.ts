/**
 * 回复通知闸门的**接线判据**（bug #7，用户 2026-11-14 fail-closed 拍板）。
 *
 * 纯函数判据（todoReplyConcernsMe：未知任务 ⇒ 抑制）在 todos.test.ts；
 * 这里守它**长在通知这条路上**：调用点漏接、被挪到 sender 过滤之前、或改查
 * 有上界的消息缓存，都会让"未加载 ⇒ 抑制"失效或误抑制，而纯函数测试全绿
 * （与 designGuards 里建卡闸门接线判据同族）。
 *
 * 每条都带反例自证：把接线改坏必须红，防止守卫空转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readChatStoreSrc } from "../../scripts/chatStoreSrc.ts";
import { tsFnBody } from "./tsSource.ts";

const storeSrc = readChatStoreSrc(join(import.meta.dirname, "..", "stores", "useChatStore.ts"));

/** 回复闸门必须在 maybeNotify 里恰好出现一次、排在 sender 过滤之后、定义查全表源。 */
function replyGateWired(src: string): boolean {
  const body = tsFnBody(src, "function maybeNotify(");
  if (body.length < 200) return false; // 锚点缺失即失败，不空转
  const calls = body.split("todoReplyConcernsMe(").length - 1;
  if (calls !== 1) return false; // 0＝没接上，2＝同一件事两个计算点
  const self = body.indexOf("rec.sender_id === myId");
  const gate = body.indexOf("todoReplyConcernsMe(");
  if (self < 0 || gate < self) return false; // 必须在 sender 过滤之后
  // 定义必须查 groupTodoRows（全表读）：改查有上界的 messages 缓存，
  // 缓存被逐出时会把"其实已加载"误判成"未加载"而过度抑制。
  return body.includes("foldTodos(groupTodoRows.value[rec.conv_id] ?? [])");
}

test("回复通知闸门必须接在 maybeNotify 上且定义查全表源（bug #7 接线，删掉抑制即红）", () => {
  assert.ok(replyGateWired(storeSrc), "闸门没接上 / 位置不对 / 定义数据源不对");

  // 反例自证①：摘掉闸门调用（0 次）必须红
  const removed = storeSrc.replace(
    "todoReplyConcernsMe(rec, myId,",
    "todoReplyConcernsMeBypass(rec, myId,",
  );
  assert.notEqual(removed, storeSrc, "锚点没命中：闸门调用点变了");
  assert.ok(!replyGateWired(removed), "反例：摘掉闸门调用必须判红");

  // 反例自证②：定义改查有上界的消息缓存必须红
  const wrongSource = storeSrc.replace(
    "foldTodos(groupTodoRows.value[rec.conv_id] ?? [])",
    "foldTodos(messages.value[rec.conv_id] ?? [])",
  );
  assert.notEqual(wrongSource, storeSrc, "锚点没命中：定义查询变了");
  assert.ok(!replyGateWired(wrongSource), "反例：改查消息缓存必须判红");
});