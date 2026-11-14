/**
 * 群历史同步「启动中」登记与去重（2026-11-13 功能闭环审计 P3 #35）。
 *
 * 治什么：`syncGroupHistoryNow` 先 await IPC 裁决才 toast，按钮 busy 与横幅又都只认
 * 第一条 `group-history-progress` 事件 ⇒ 点击到首条事件之间有一段「按了没反应」的空窗，
 * 连点每次都打 IPC。这份登记让按钮点下去立刻 busy，并按群去重：启动中再点不打 IPC。
 *
 * 生命周期：begin（点击）→ settle（IPC 裁决：started 保留、其余撤销）→
 * release（任何相位的进度事件接管 / 取消裁决过期 / 清库）。事件可能先于 IPC 返回：
 * release 在前、settle 在后也安全 —— settle 只减不增，不会把已接管的群重新挂回去。
 *
 * 三个函数都返回新对象（Vue ref 替换语义）；无需变更时返回原引用，不制造空响应式更新。
 */
export type HistoryStartFlags = Record<string, true>;

/** 点击入口：同群已在启动中 ⇒ null（去重，不打 IPC）；否则返回含该群的新登记。 */
export function beginHistoryStart(flags: HistoryStartFlags, groupId: string): HistoryStartFlags | null {
  if (flags[groupId]) return null;
  return { ...flags, [groupId]: true };
}

/** IPC 裁决回填：`started` ⇒ 保留（等进度事件接管）；其余裁决 ⇒ 撤销。只减不增。 */
export function settleHistoryStart(flags: HistoryStartFlags, groupId: string, verdict: string): HistoryStartFlags {
  return verdict === "started" ? flags : releaseHistoryStart(flags, groupId);
}

/** 进度事件 / 取消 / 清库：无条件撤销该群的「启动中」；未登记时返回原引用。 */
export function releaseHistoryStart(flags: HistoryStartFlags, groupId: string): HistoryStartFlags {
  if (!flags[groupId]) return flags;
  const next = { ...flags };
  delete next[groupId];
  return next;
}
