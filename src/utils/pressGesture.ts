//! 列表行「长按 = 右键菜单」的**纯判据**（`node --test` 直接跑，零 `@/` 依赖）。
//!
//! 为什么抽出来：`ConversationListItem` 与 `FriendListItem` 曾各抄一份**逐字相同**的
//! 计时器 + 位移容差 + click 抑制，两个文件各自记着 500ms / 10px 这两个数 —— 改一处另一处就漂，
//! 而漂了不报错，只是"某一边长按要按久一点才出菜单"。
//!
//! 分工：计时器与事件绑定在 `composables/usePressMenu.ts`（需要组件作用域），
//! 这里只留能在 node 下判的部分。

/** 长按判定时长（ms）。与微信「按住约 0.5s 弹菜单」同一量级。 */
export const LONG_PRESS_MS = 500;

/** 手指抖动容差（px）：小于它不算"滑动"，不取消长按（否则轻微抖动就长按不出来）。 */
export const PRESS_MOVE_TOLERANCE = 10;

export interface PressPoint {
  x: number;
  y: number;
}

/**
 * 位移是否已经超出"这仍是一次按压"的容差。
 *
 * ⚠️ 必须用欧氏距离、不能只看单轴：横向滑列表要取消长按，纵向滚动**同样**要取消 ——
 * 只看 `dx` 的话，手指竖着滚列表仍会弹出菜单（真机 2026-09-13 踩过）。
 */
export function movedBeyondTolerance(
  from: PressPoint,
  to: PressPoint,
  tolerance: number = PRESS_MOVE_TOLERANCE,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > tolerance;
}
