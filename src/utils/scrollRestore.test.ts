import assert from "node:assert/strict";
import test from "node:test";
import {
  SCROLL_RESTORE_TTL_MS,
  clearSavedScrollPositions,
  rememberScrollPosition,
  savedScrollPosition,
  shouldRestoreScroll,
  type SavedScroll,
} from "./scrollRestore.ts";

const T0 = 1_700_000_000_000;
const saved = (over: Partial<SavedScroll> = {}): SavedScroll => ({
  top: 420,
  at: T0,
  atBottom: false,
  ...over,
});

test("刚离开就回来：恢复原像素位置", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + 5_000, false), true);
});

test("边界停在恰好 3 分钟：仍然恢复（阈值那一格走「仍算刚离开」）", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + SCROLL_RESTORE_TTL_MS, false), true);
});

test("超过 3 分钟：不恢复（回到底部看最新）", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + SCROLL_RESTORE_TTL_MS + 1, false), false);
});

test("来新消息触发未读：位置让给未读，即使刚离开也不恢复", () => {
  assert.equal(shouldRestoreScroll(saved(), T0 + 1_000, true), false);
});

test("离开时本来就在底部：回来贴底，哪怕只离开 1 秒", () => {
  assert.equal(shouldRestoreScroll(saved({ atBottom: true }), T0 + 1_000, false), false);
});

test("没有保存过：不恢复（交给默认贴底）", () => {
  assert.equal(shouldRestoreScroll(undefined, T0, false), false);
});

// 三个出口互相独立：把任意一条规则摘掉，上面都至少有一格会红。
test("三个出口各自都能独立生效（互不掩盖）", () => {
  const fresh = saved();
  assert.equal(shouldRestoreScroll(fresh, T0 + 1, false), true);
  assert.equal(shouldRestoreScroll({ ...fresh, atBottom: true }, T0 + 1, false), false);
  assert.equal(shouldRestoreScroll(fresh, T0 + 1, true), false);
  assert.equal(shouldRestoreScroll(fresh, T0 + SCROLL_RESTORE_TTL_MS + 1, false), false);
});

// 2026-10-25 用户实测回归：单聊上滑 → 点对方资料 → 返回，视口回到底部。
// 根因是位置表长在 ChatWindow 的 setup 里，卸载即丢；这里钉住"表在模块级"。
test("位置表跨组件挂载存活（点资料返回后仍能查到离开时的位置）", () => {
  clearSavedScrollPositions();
  rememberScrollPosition("peer-a", saved({ top: 880 }));
  // 新一次 ChatWindow 挂载只是重新读这张表，不重新创建它。
  assert.equal(savedScrollPosition("peer-a")?.top, 880);
  assert.equal(savedScrollPosition("peer-b"), undefined);
});

test("位置表有容量上限：超过 50 个会话时淘汰最旧的，且重复写入会刷新排序", () => {
  clearSavedScrollPositions();
  rememberScrollPosition("keep-fresh", saved({ top: 1 }));
  for (let i = 0; i < 50; i += 1) rememberScrollPosition(`conv-${i}`, saved({ top: i }));
  // 共 51 条 ⇒ 最旧的 keep-fresh 被淘汰。
  assert.equal(savedScrollPosition("keep-fresh"), undefined);
  // 再写一次已有会话：它排到队尾，下一次淘汰时不会被先删掉。
  rememberScrollPosition("conv-0", saved({ top: 100 }));
  rememberScrollPosition("conv-new", saved({ top: 2 }));
  assert.equal(savedScrollPosition("conv-0")?.top, 100);
  assert.equal(savedScrollPosition("conv-1"), undefined, "队首那条应被淘汰");
});
