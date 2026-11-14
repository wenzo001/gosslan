/**
 * 任务详情回复草稿的两条接线判据（bug #6）：
 *  ① 切任务（todoId 变化）必须重置草稿与回复目标 —— 右栏/弹窗复用同一个组件实例，
 *     不重置会把 A 任务写了一半的回复带进 B 任务；
 *  ② 发送成功才清草稿、失败保留 —— 旧的"emit 后立刻清"会在发送失败时丢稿。
 *
 * 为什么读源码：这两条都是"回退后界面看起来仍然正常"的退化 —— 草稿串任务 /
 * 失败丢稿只在特定操作序列下现形，肉眼回归很难抓到。每条都带反例自证：
 * 把修复删掉必须红，防止守卫空转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tsFnBody } from "./tsSource.ts";

const compDir = join(import.meta.dirname, "..", "components");
const fieldsSrc = readFileSync(join(compDir, "TodoDetailFields.vue"), "utf8");
const dialogSrc = readFileSync(join(compDir, "TodoDetailDialog.vue"), "utf8");
const boardSrc = readFileSync(join(compDir, "GroupTasksBoard.vue"), "utf8");

/** ① 必须有 watch todoId，且_watch 体内_草稿与回复目标都重置。 */
function resetsDraftOnTodoSwitch(src: string): boolean {
  const at = src.indexOf("() => props.item.todoId");
  if (at < 0) return false;
  const start = src.lastIndexOf("watch(", at);
  const end = src.indexOf(");", at);
  if (start < 0 || end < 0 || end < start) return false;
  const block = src.slice(start, end);
  return block.includes('replyDraft.value = ""') && block.includes("replyTarget.value = null");
}

test("切任务必须重置回复草稿与目标（删掉 watch 或重置语句会红，bug #6）", () => {
  assert.ok(resetsDraftOnTodoSwitch(fieldsSrc), "TodoDetailFields 必须在 todoId 变化时重置草稿 + 目标");

  // 反例自证：摘掉 watch 体内任一条重置语句必须红（守卫不空转）
  const at = fieldsSrc.indexOf("() => props.item.todoId");
  const block = fieldsSrc.slice(fieldsSrc.lastIndexOf("watch(", at), fieldsSrc.indexOf(");", at));
  const noDraftReset = fieldsSrc.replace(block, block.replace('replyDraft.value = "";', ""));
  assert.notEqual(noDraftReset, fieldsSrc, "锚点没命中：草稿重置不在 watch 体内");
  assert.ok(!resetsDraftOnTodoSwitch(noDraftReset), "反例：不重置草稿必须判红");
  const noTargetReset = fieldsSrc.replace(block, block.replace("replyTarget.value = null;", ""));
  assert.ok(!resetsDraftOnTodoSwitch(noTargetReset), "反例：不重置回复目标必须判红");
  const wrongField = fieldsSrc.replace("() => props.item.todoId", "() => props.item.title");
  assert.ok(!resetsDraftOnTodoSwitch(wrongField), "反例：watch 错字段必须判红");
});

/** ② submitReply 必须把 ack 交给宿主，清草稿只能出现在成功守卫之后。 */
function clearsDraftOnlyOnSuccess(src: string): boolean {
  const body = tsFnBody(src, "function submitReply(");
  if (!body) return false;
  const emitAt = body.indexOf('emit("reply"');
  const ackAt = body.indexOf("(ok) =>");
  const okAt = body.indexOf("if (ok");
  const clearAt = body.indexOf('replyDraft.value = ""');
  // emit 必须带 ack 回调；清草稿必须排在成功守卫之后（不是 emit 后无条件清）
  return emitAt >= 0 && ackAt > emitAt && okAt > emitAt && clearAt > okAt;
}

test("回复草稿只在发送成功时清、失败保留（改回 emit 后立刻清会红，bug #6）", () => {
  assert.ok(clearsDraftOnlyOnSuccess(fieldsSrc), "submitReply 必须带 ack 且只在成功分支清草稿");
  const body = tsFnBody(fieldsSrc, "function submitReply(");
  // 在途防重：ack 回来前不许第二次提交（双击 / 回车重入只放行一次）
  assert.ok(body.includes("if (replySending.value) return;"), "在途必须防重复提交");
  assert.ok(body.includes("replySending.value = false"), "ack 必须释放在途标记");
  assert.ok(
    fieldsSrc.includes(':disabled="!replyDraft.trim() || replySending"'),
    "发送按钮在途必须禁用",
  );

  // 反例自证：旧形状（emit 后无条件清草稿、无 ack）必须红
  const oldShape = body.replace(
    /emit\("reply"[\s\S]*$/,
    'emit("reply", text, replyTarget.value ?? undefined);\n  replyDraft.value = "";\n  replyTarget.value = null;\n}',
  );
  const regressed = fieldsSrc.replace(body, oldShape);
  assert.notEqual(regressed, fieldsSrc, "锚点没命中：submitReply 形状变了");
  assert.ok(!clearsDraftOnlyOnSuccess(regressed), "反例：改回 emit 后立刻清必须判红");
});

/** 宿主必须在发送落定后回 ack：成功 true、失败 false（含提前返回分支）。 */
function hostAcksSettled(src: string): boolean {
  const body = tsFnBody(src, "async function sendDetailReply(");
  if (!body) return false;
  const awaitAt = body.indexOf("await chat.sendTodoReply(");
  const okAt = body.indexOf("ack(true)");
  const catchAt = body.indexOf("catch");
  if (awaitAt < 0 || okAt < awaitAt || catchAt < 0) return false;
  // 失败分支（catch）与提前返回分支都必须 ack(false)：漏一处，草稿就卡在在途或丢稿
  return body.slice(catchAt).includes("ack(false)") && body.slice(0, awaitAt).includes("ack(false)");
}

test("宿主发送落定必须回 ack 且两处 @reply 都透传（删掉接线会红，bug #6）", () => {
  assert.ok(hostAcksSettled(boardSrc), "sendDetailReply 必须成功 ack(true)、失败 ack(false)");
  // 两个宿主形态（右栏常驻 + 弹窗）都把 ack 透传给 sendDetailReply
  const wired = boardSrc.split("sendDetailReply(text, parentReplyId, ack)").length - 1;
  assert.equal(wired, 2, `两处 @reply 必须都透传 ack（实际 ${wired}）`);
  // 弹窗是纯透传：ack 必须原样转给外层宿主
  assert.ok(dialogSrc.includes("emit('reply', text, parentReplyId, ack)"), "TodoDetailDialog 必须透传 ack");
  // 契约必须写进两侧 emit 类型（否则 TS 拦不住漏传 ack 的宿主）
  const contract = '(e: "reply", text: string, parentReplyId: string | undefined, ack: (ok: boolean) => void): void;';
  assert.ok(fieldsSrc.includes(contract), "TodoDetailFields 的 reply emit 必须带 ack 契约");
  assert.ok(dialogSrc.includes(contract), "TodoDetailDialog 的 reply emit 必须带 ack 契约");

  // 反例自证①：吞掉成功 ack（成功却不告诉字段区）必须红
  const swallowed = boardSrc.replace("ack(true);", "");
  assert.notEqual(swallowed, boardSrc, "锚点没命中：成功 ack 变了");
  assert.ok(!hostAcksSettled(swallowed), "反例：成功不回 ack 必须判红");
  // 反例自证②：catch 里不回 ack（失败丢草稿 + 卡在途）必须红
  const noCatchAck = boardSrc.replace('ack(false); // 失败保留草稿，用户不用重打一遍', "");
  assert.notEqual(noCatchAck, boardSrc, "锚点没命中：catch 形状变了");
  assert.ok(!hostAcksSettled(noCatchAck), "反例：失败不回 ack 必须判红");
});