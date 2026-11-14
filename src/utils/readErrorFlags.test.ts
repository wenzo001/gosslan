/**
 * 读失败登记原语（2026-11-13 功能闭环审计 P2 #33）：行为 + 接线判据。
 *
 * 治什么：`refreshGroupDeliveries` 读失败保留旧值但**无任何标记** ⇒ 角标把上一轮的
 * 投递计数当成最新事实画给用户。正对照是 `groupReadsErrors`（失败记原因、成功清除、
 * store 导出、ChatWindow 错误档 + 重试）。这里钉两半：
 *   ① 原语行为：按 key 记 / 只清自己的 key / 无标记时返回原引用（不制造响应式空转）；
 *   ② 接线：`refreshGroupDeliveries` 的 catch 真的记、成功路径真的清 ——
 *      删掉任何一半，下面的反例自证会证明判据立刻红（不是空转）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { withReadError, withoutReadError } from "./readErrorFlags.ts";
import { readChatStoreSrc } from "../../scripts/chatStoreSrc.ts";

test("withReadError：按 key 记下原因，不动别的 key，也不改原对象", () => {
  const before = { "group:a": "IO 错误" };
  const after = withReadError(before, "group:b", "数据库锁超时");
  assert.deepEqual(after, { "group:a": "IO 错误", "group:b": "数据库锁超时" });
  assert.deepEqual(before, { "group:a": "IO 错误" }, "原对象不许被就地改写（ref 替换语义）");
  assert.notEqual(after, before);
});

test("withReadError：同一 key 再失败 ⇒ 覆盖为最新原因", () => {
  const after = withReadError({ "group:a": "旧原因" }, "group:a", "新原因");
  assert.equal(after["group:a"], "新原因");
});

test("withoutReadError：只清自己的 key，别的群的失败登记必须保住（各路失败互相独立）", () => {
  const before = { "group:a": "IO 错误", "group:b": "锁超时" };
  const after = withoutReadError(before, "group:a");
  assert.deepEqual(after, { "group:b": "锁超时" });
  assert.deepEqual(before, { "group:a": "IO 错误", "group:b": "锁超时" }, "原对象不许被就地改写");
});

test("withoutReadError：没有标记时返回原引用（成功刷新不制造一轮空响应式更新）", () => {
  const before = { "group:b": "锁超时" };
  assert.equal(withoutReadError(before, "group:a"), before);
  const empty = {};
  assert.equal(withoutReadError(empty, "group:a"), empty);
});

test("反例自证：「成功整表清空」的错误实现必须被独立性断言抓住", () => {
  // 这是本判据要拦的回归形状：成功时 `errors.value = {}` 会把**别的群**仍在失败的
  // 登记一起抹掉 ⇒ 那些群的错误档凭空消失。用同一把尺子量错误实现，必须量出违规。
  const wrongClear = (_flags: Record<string, string>, _key: string) => ({});
  const before = { "group:a": "IO 错误", "group:b": "锁超时" };
  const after = wrongClear(before, "group:a");
  assert.notDeepEqual(after, { "group:b": "锁超时" }, "错误实现若也能过独立性断言 ⇒ 这条判据是恒过的");
});

// ---------------- 接线判据：catch 记标记 / 成功清标记 ----------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 取 refreshGroupDeliveries 的函数体（到下一个顶层函数锚点为止；锚点失配直接红）。 */
function deliveryFnBody(): string {
  const st = stripComments(readChatStoreSrc(join(import.meta.dirname, "..", "stores", "useChatStore.ts")));
  const start = st.indexOf("async function refreshGroupDeliveries(");
  assert.ok(start >= 0, "找不到 refreshGroupDeliveries ⇒ 改名必须同步这条判据");
  const end = st.indexOf("function clearHistoryError(", start);
  assert.ok(end > start, "找不到 refreshGroupDeliveries 的结束锚点 ⇒ 同上");
  return st.slice(start, end);
}

test("接线：refreshGroupDeliveries 失败记标记、成功清标记（删掉任何一半即红）", () => {
  const body = deliveryFnBody();
  const mark = "withReadError(groupDeliveryErrors.value, convId, asReadError(e))";
  const clear = "withoutReadError(groupDeliveryErrors.value, convId)";
  const catchAt = body.indexOf("catch (e)");
  assert.ok(catchAt >= 0, "refreshGroupDeliveries 没有 catch(e) ⇒ 读失败又被静默吞掉了");
  assert.ok(body.indexOf(mark, catchAt) > catchAt, "catch 里没有按会话记失败原因 ⇒ 旧角标又被当成最新事实");
  const clearAt = body.indexOf(clear);
  assert.ok(clearAt > catchAt, "成功路径没有清标记 ⇒ 一次失败之后错误档永远挂着");

  // 反例自证①：把 catch 里记标记那一行摘掉 ⇒ 「记标记」断言必须不再成立。
  const noMark = body.replace(mark, "");
  assert.notEqual(noMark, body, "对照替换没生效 ⇒ 这条对照什么都没测");
  assert.ok(noMark.indexOf(mark, noMark.indexOf("catch (e)")) < 0, "摘掉记标记后必须判不出来 ⇒ 否则判据恒过");
  // 反例自证②：把成功路径清标记那一行摘掉 ⇒ 「清标记」断言必须不再成立。
  const noClear = body.replace(clear, "");
  assert.notEqual(noClear, body, "对照替换没生效 ⇒ 这条对照什么都没测");
  assert.ok(!noClear.includes(clear), "摘掉清标记后必须判不出来 ⇒ 否则判据恒过");
});
