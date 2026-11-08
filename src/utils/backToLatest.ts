/**
 * 「回到最新」按钮的可见判据（2026-11-05）。
 *
 * 为什么不复用 VirtualList 的 `pinned`（贴底态）：那个状态在**收敛窗口**里
 * （切会话/重测风暴期间，`suppressNearBottomUntil`，最长约 300ms+）故意不按几何更新
 * （见 `computeScrollState()` 的 `if (settling) return`）。用户在这个窗口里滚回底部时
 * `pinned` 会停在旧值 ⇒ 按钮常驻在消息区底部中央，压住最新一条消息里的图片。
 * 用户报的「点击区域有时候功能不生效」，点到的正是它（截图里 tooltip 还开着）。
 *
 * 所以按钮可见性改为**每次滚动都现算的几何间隙**，并且只认"真的离底"：
 * 不贴底时 `pointer-events: none` + 不可见（见 BackToLatestButton.vue）。
 *
 * ⚠️ 这里**只剩可见性**。2026-11-06 曾加过一套"按滚动位置实测分割行、逐级上移"的避让
 * （`computeBackToLatestAvoidOffset`），2026-11-08 用户报"上下滚动时圆钮一直在上下跳动"
 * 后被整段删除：运行时探针 `--only=backjump` 实测连滚 0→800px，按钮 `top` 序列出现
 * `372 → 336 → 300 → 372`（唯一值 3 个、跨度 72px）。按钮位置现在只由
 * `calc(1rem + bottomOffset)` 决定，与滚动位置无关。别再把它按滚动位置接回来。
 */

/**
 * 离底超过这个距离才显示。
 * 与 VirtualList 的 `NEAR_BOTTOM_THRESHOLD` **同口径**（150px，那边是模块内常量）：
 * 按钮出现时机与旧行为一致，只是从"pinned 状态"换成"现算几何"，避免收敛窗口里的陈旧值。
 */
export const BACK_TO_LATEST_MIN_GAP_PX = 150;

/** `gap`：滚动区底边到视口底边的距离（px）。非有限值一律不显示（不猜）。 */
export function shouldShowBackToLatest(gap: number): boolean {
  return Number.isFinite(gap) && gap > BACK_TO_LATEST_MIN_GAP_PX;
}

/** 现算离底距离；overscroll（负值）夹到 0。 */
export function gapAtBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}
