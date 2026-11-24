import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideDefaultFilter } from "./todoFilter.ts";

const base = { open: true, dataReady: true, selfKnown: true, mineCount: 2, settled: false };

test("默认选「我的」：「我的」有任务时不动标签", () => {
  assert.equal(decideDefaultFilter(base), "mine");
});

test("「我的」为空 ⇒ 落到「全部」", () => {
  assert.equal(decideDefaultFilter({ ...base, mineCount: 0 }), "all");
});

test("面板关着不判（数据在关着的时候变化，不许提前落定）", () => {
  assert.equal(decideDefaultFilter({ ...base, open: false }), null);
  assert.equal(decideDefaultFilter({ ...base, open: false, mineCount: 0 }), null);
});

test("数据没到齐不判（加载中 / 读失败都不是「空的」）", () => {
  assert.equal(decideDefaultFilter({ ...base, dataReady: false }), null);
  assert.equal(decideDefaultFilter({ ...base, dataReady: false, mineCount: 0 }), null);
});

test("身份没回来但「我的」为 0 ⇒ 仍落「全部」（否则停在空页，用户 2026-11-18）", () => {
  assert.equal(decideDefaultFilter({ ...base, selfKnown: false, mineCount: 0 }), "all");
  assert.equal(decideDefaultFilter({ ...base, selfKnown: false, mineCount: 2 }), null);
});

test("判过就锁住：用户手动切过之后不再被拉回", () => {
  assert.equal(decideDefaultFilter({ ...base, settled: true }), null);
  assert.equal(decideDefaultFilter({ ...base, settled: true, mineCount: 0 }), null);
});

test("反例自证：漏掉「面板关着」这个前提，闭着时会把标签判成「全部」", () => {
  // 把 open 摘掉的实现会返回 "all" —— 与正确结果不同，说明这条判据不是空转。
  const naive = (i: typeof base) =>
    !i.dataReady || i.settled ? null : i.mineCount === 0 ? "all" : "mine";
  assert.equal(naive({ ...base, open: false, mineCount: 0 }), "all");
  assert.notEqual(
    naive({ ...base, open: false, mineCount: 0 }),
    decideDefaultFilter({ ...base, open: false, mineCount: 0 }),
  );
});

test("反例自证：漏掉「身份已知」这个前提，身份未到 + 「我的」有任务会误判成「我的」并锁住", () => {
  // selfKnown 仍然是前提：有内容但不知道我是谁时，正确实现必须返回 null（等身份），
  // 而摘掉前提的实现会直接判「我的」并锁死（身份回来后也不会重判）。
  const naive = (i: typeof base) =>
    !i.open || !i.dataReady || i.settled ? null : i.mineCount === 0 ? "all" : "mine";
  const late = { ...base, selfKnown: false, mineCount: 2 };
  assert.equal(naive(late), "mine");
  assert.notEqual(naive(late), decideDefaultFilter(late));
});

test("从任务栏 / ⌘Tab 唤回窗口 = 激活而非重开 ⇒ 不许重判页签（用户 2026-11-24 实测）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const win = readFileSync(join(root, "src/components/GroupTodosWindow.vue"), "utf8");
  // 现场：手动切到「已归档」→ 任务栏点该窗口 → 被打回「我的」。机制是 focus 回调走了
  // 「算一次新打开」的那条路（resetSeq++）⇒ 看板重判默认页签。
  const focusIdx = win.indexOf("onFocusChanged");
  assert.ok(focusIdx > 0, "找不到焦点兜底（从任务栏唤回时不再重读数据也不是本意）");
  const focusBlock = win.slice(focusIdx, focusIdx + 500);
  assert.match(
    focusBlock,
    /applyTarget\(groupId\.value,\s*\{\s*reopened:\s*false\s*\}\)/,
    "焦点唤回必须显式声明 reopened:false——否则每次从任务栏点回来都把用户选的页签打回默认",
  );
  // 重判信号只在 reopened 不为 false 时才递增（这条是上面那条的机制侧）。
  assert.match(
    win,
    /if \(opts\.reopened !== false\) resetSeq\.value \+= 1/,
    "resetSeq 必须在 reopened:false 时保持不动",
  );
});

test("常驻群任务窗口：每次打开都要重判默认页签（否则停在上一轮的页签）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const win = readFileSync(join(root, "src/components/GroupTodosWindow.vue"), "utf8");
  const board = readFileSync(join(root, "src/components/GroupTasksBoard.vue"), "utf8");
  // 窗口关=隐藏、同群重开不重挂看板 ⇒ 必须有一个「又打开了一次」的信号
  assert.ok(win.includes("resetSeq.value += 1"), "窗口每次被打开时没有发出重判信号");
  assert.ok(win.includes(':reset-seq="resetSeq"'), "重判信号没有传给看板");
  assert.ok(board.includes("() => props.resetSeq"), "看板没有监听重开信号");
  // 重开时按当前「我的」重判，不是无条件回「我的」
  assert.ok(
    board.includes('filter.value = counts.value.mine === 0 ? "all" : "mine"'),
    "重开时没有按「我的」是否为空重判",
  );
});
