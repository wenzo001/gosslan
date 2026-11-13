/**
 * 日历网格的键盘导航索引数学（无业务依赖的叶子）。
 *
 * 为什么单独一个家（2026-11-13 组件复审 P1 跟进，ADR 决策 2 短期方案）：Todo 自绘月历
 * 此前 42 个日期格都是普通按钮，键盘用户要 Tab 穿过整片网格。这里把"按哪个键移到哪一格"
 * 收口成纯函数，组件只负责落焦与 roving tabindex；数学由 `calendarGrid.test.ts` 逐键钉死。
 *
 * 约定：网格按 `cols` 列行优先排布（默认 7 列＝一周），索引从 0 起。方向键在网格边界
 * **夹取**（不环绕）——邻月日期已在 42 格里可见，跨月切换交给 PageUp/PageDown（组件处理）。
 */

/** 一周七列。 */
export const CALENDAR_COLS = 7;

/**
 * 给定当前格索引与按键，返回目标格索引；非导航键返回 `null`（调用方不拦默认行为）。
 *
 * - ArrowLeft/Right：±1，夹取到 [0, total-1]
 * - ArrowUp/Down：±cols，夹取到 [0, total-1]
 * - Home/End：本周首日 / 末日（End 夹取到 total-1）
 * - PageUp/PageDown 不在这里（它们是跨月，组件 shiftMonth 处理）
 */
export function calendarGridNext(
  index: number,
  key: string,
  total: number,
  cols: number = CALENDAR_COLS,
): number | null {
  const last = total - 1;
  const rowStart = index - (index % cols);
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(last, index + 1);
    case "ArrowUp":
      return Math.max(0, index - cols);
    case "ArrowDown":
      return Math.min(last, index + cols);
    case "Home":
      return rowStart;
    case "End":
      return Math.min(last, rowStart + cols - 1);
    default:
      return null;
  }
}