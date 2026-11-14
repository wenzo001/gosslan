/**
 * 群历史同步「启动中」登记与去重（2026-11-13 功能闭环审计 P3 #35）：行为 + 接线判据。
 *
 * 治什么：`syncGroupHistoryNow` 先 await IPC 裁决才 toast，按钮 busy 与横幅又都只认
 * 第一条 `group-history-progress` 事件 ⇒ 点击到首条事件之间有一段「按了没反应」的空窗，
 * 连点每次都打 IPC（后端 already_running 只是最后一道防线）。这里钉两半：
 *   ① 原语行为：启动写 pending / 同群去重 / 非 started 裁决撤销 / 进度事件接管 /
 *      事件先于裁决返回的竞态下不许把已接管的群重新挂回「启动中」；
 *   ② 接线：store 真的在 await 之前登记、裁决后 settle、进度/取消/清库都收口，
 *      ChatWindow 的按钮 busy 真的读这份登记 —— 反例自证保证删掉任何一环即红。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beginHistoryStart, settleHistoryStart, releaseHistoryStart } from "./groupHistoryStart.ts";
import { readChatStoreSrc } from "../../scripts/chatStoreSrc.ts";

test("begin：启动即写 pending（新登记含该群），不改原对象", () => {
  const before = {};
  const after = beginHistoryStart(before, "g1");
  assert.deepEqual(after, { g1: true });
  assert.deepEqual(before, {}, "原对象不许被就地改写（ref 替换语义）");
  assert.notEqual(after, before);
});

test("begin：同群启动中再点 ⇒ null（去重，不打 IPC）；别的群不受影响", () => {
  const flying = beginHistoryStart({}, "g1")!;
  assert.equal(beginHistoryStart(flying, "g1"), null, "同群在飞必须去重 —— 空窗连点每次都打 IPC 就是本条要治的病");
  const other = beginHistoryStart(flying, "g2");
  assert.deepEqual(other, { g1: true, g2: true }, "按群去重，不是全局一刀切");
});

test("settle：started 保留（等进度事件接管）；其余裁决一律撤销", () => {
  const flying = { g1: true as const, g2: true as const };
  assert.equal(settleHistoryStart(flying, "g1", "started"), flying, "started ⇒ 留给首条进度事件接管");
  for (const verdict of ["already_running", "no_source", "no_group", "unknown_future_code"]) {
    assert.deepEqual(settleHistoryStart(flying, "g1", verdict), { g2: true }, `${verdict} ⇒ 必须撤销 pending，否则按钮永久转圈`);
  }
});

test("release：无条件撤销；未登记时返回原引用", () => {
  const flying = { g1: true as const, g2: true as const };
  assert.deepEqual(releaseHistoryStart(flying, "g1"), { g2: true });
  assert.equal(releaseHistoryStart(flying, "g3"), flying, "没有登记就不该制造一轮空响应式更新");
});

test("竞态：进度事件先于 IPC 裁决到达 ⇒ settle(started) 不许把已接管的群重新挂回启动中", () => {
  let flags = beginHistoryStart({}, "g1")!;
  // 首条 running 事件先到（takeover），甚至 done 先到（收口）都一样：
  flags = releaseHistoryStart(flags, "g1");
  flags = settleHistoryStart(flags, "g1", "started");
  assert.deepEqual(flags, {}, "settle 只减不增 —— 裁决晚到时不许复活已被进度事件接管的登记");
});

test("反例自证：不去重 / settle 恒保留 两种错误实现必须被上面的尺子量出违规", () => {
  // 错误实现①：begin 不查在飞（= 没有去重）。同群第二次必须被判出「不是 null」。
  const wrongBegin = (flags: Record<string, true>, id: string) => ({ ...flags, [id]: true as const });
  const flying = wrongBegin({}, "g1");
  assert.notEqual(wrongBegin(flying, "g1"), null, "不去重的实现若也能过去重断言 ⇒ 判据恒过");
  // 错误实现②：settle 不看裁决（= 非 started 也不撤销）。already_running 必须被判出「还挂着」。
  const wrongSettle = (flags: Record<string, true>, _id: string, _v: string) => flags;
  assert.deepEqual(wrongSettle(flying, "g1", "already_running"), { g1: true }, "恒保留的实现必须与正确形状可区分");
  assert.notDeepEqual(wrongSettle(flying, "g1", "already_running"), {}, "非 started 撤销那条若量不出违规 ⇒ 判据恒过");
});

// ---------------- 接线判据 ----------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function sliceFn(src: string, startAt: string, endAt: string, label: string): string {
  const s = src.indexOf(startAt);
  assert.ok(s >= 0, `${label}：起始锚点没命中 ⇒ 判据已经不知道自己在读什么`);
  const e = src.indexOf(endAt, s + startAt.length);
  assert.ok(e > s, `${label}：结束锚点没命中 ⇒ 同上`);
  return src.slice(s, e);
}

const storeSrc = () => stripComments(readChatStoreSrc(join(import.meta.dirname, "..", "stores", "useChatStore.ts")));

test("接线：syncGroupHistoryNow 启动即登记、同群去重、裁决后 settle、抛错撤销", () => {
  const body = sliceFn(storeSrc(), "async function syncGroupHistoryNow(", "async function cancelGroupHistory(", "syncGroupHistoryNow");
  const begin = "beginHistoryStart(groupHistoryStarting.value, groupId)";
  const gate = "if (!begun) return;";
  const write = "groupHistoryStarting.value = begun;";
  const ipc = "await api.syncGroupHistoryNow(groupId)";
  const release = "releaseHistoryStart(groupHistoryStarting.value, groupId)";
  const settle = "settleHistoryStart(groupHistoryStarting.value, groupId, verdict)";

  const beginAt = body.indexOf(begin);
  const ipcAt = body.indexOf(ipc);
  assert.ok(beginAt >= 0, "启动没有登记「启动中」⇒ 按钮 busy 又要等首条进度事件");
  assert.ok(ipcAt > beginAt, "登记必须在 await IPC 之前 —— 之后登记就盖不住启动空窗");
  assert.ok(body.includes(gate), "没有同群去重闸门 ⇒ 空窗连点每次都打 IPC");
  assert.ok(body.indexOf(gate) < ipcAt, "去重闸门必须在 IPC 之前");
  assert.ok(body.indexOf(write) > beginAt && body.indexOf(write) < ipcAt, "pending 必须在 IPC 前写进 store（按钮立刻 busy）");
  const catchAt = body.indexOf("catch (e)");
  assert.ok(catchAt > ipcAt, "IPC 没有 catch ⇒ 抛错时 pending 永久挂着");
  assert.ok(body.indexOf(release, catchAt) > catchAt, "抛错没有撤销 pending ⇒ 按钮永久转圈");
  assert.ok(body.indexOf(settle) > ipcAt, "裁决后没有 settle ⇒ 非 started 的 pending 不会被撤销");

  // 反例自证：把去重闸门摘掉 ⇒ 闸门断言必须不再成立（判据不是空转）。
  const noGate = body.replace(gate, "");
  assert.notEqual(noGate, body, "对照替换没生效 ⇒ 这条对照什么都没测");
  assert.ok(!noGate.includes(gate), "摘掉闸门后必须判不出来 ⇒ 否则判据恒过");
  // 反例自证：把登记挪到 IPC 之后（= 旧病灶形状）⇒ 顺序断言必须不再成立。
  const lateBegin = body.replace(begin, "").replace(ipc, `${ipc};\n  const begun = ${begin};`);
  assert.ok(lateBegin.indexOf(begin) > lateBegin.indexOf(ipc), "对照形状没构造出来 ⇒ 这条对照什么都没测");
});

test("接线：进度事件任何相位都接管/收口「启动中」；取消裁决过期与两条清库路径同批收", () => {
  const st = storeSrc();
  const progress = sliceFn(st, "function onGroupHistoryProgress(", "\n  return {", "onGroupHistoryProgress");
  assert.ok(
    progress.includes("releaseHistoryStart(groupHistoryStarting.value, p.group_id)"),
    "进度事件没有接管「启动中」⇒ 首条事件到达后按钮仍被旧登记钉住；done/failed/cancelled 先到时更是永久转圈",
  );
  const cancel = sliceFn(st, "async function cancelGroupHistory(", "const unreadClearedAt", "cancelGroupHistory");
  assert.ok(
    cancel.includes("releaseHistoryStart(groupHistoryStarting.value, groupId)"),
    "取消裁决 not_running/no_group 撤横幅时没有一并撤「启动中」⇒ 界面这一行过期了按钮还busy",
  );
  const clears = st.split("groupHistoryStarting.value = {};").length - 1;
  assert.equal(clears, 2, `两条清库路径（resetAfterDataCleared / clearAllData）必须都清启动登记，实际 ${clears} 处`);

  // 反例自证：摘掉进度事件里的接管 ⇒ 断言必须不再成立。
  const noTakeover = progress.replace("releaseHistoryStart(groupHistoryStarting.value, p.group_id)", "");
  assert.notEqual(noTakeover, progress, "对照替换没生效 ⇒ 这条对照什么都没测");
  assert.ok(
    !noTakeover.includes("releaseHistoryStart(groupHistoryStarting.value, p.group_id)"),
    "摘掉接管后必须判不出来 ⇒ 否则判据恒过",
  );
});

test("接线：ChatWindow 按钮 busy 真的读「启动中」登记（不是只认进度横幅）", () => {
  const win = readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8");
  assert.match(
    win,
    /const historyStartPending = computed\([\s\S]{0,220}chat\.groupHistoryStarting\[/,
    "ChatWindow 没有读 store 的启动登记 ⇒ 登记写了个寂寞（假字段）",
  );
  assert.match(
    win,
    /const groupHistoryBusy = computed\(\(\) => !!groupHistory\.value \|\| historyStartPending\.value\)/,
    "按钮 busy 必须是「横幅存在 或 启动中」两个来源的并 —— 只认横幅就回到启动空窗",
  );
  assert.match(win, /:history-syncing="groupHistoryBusy"/, "ChatHeader 的 busy 没有接上新的并集");

  // 反例自证：旧形状（只认横幅）必须被这条判据拒绝。
  const oldShape = win.replace(':history-syncing="groupHistoryBusy"', ':history-syncing="!!groupHistory"');
  assert.notEqual(oldShape, win, "对照替换没生效 ⇒ 这条对照什么都没测");
  assert.ok(!/:history-syncing="groupHistoryBusy"/.test(oldShape), "旧形状若也能过 ⇒ 判据恒过");
});
