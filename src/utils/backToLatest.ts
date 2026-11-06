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

/**
 * 「回到最新」避让时间/未读分割行（2026-11-06，用户拍板）。
 *
 * 背景：按钮 `bottom-4` 固定在消息区底部中央，用户上滚时正好压住滚到这里的
 * 时间分割行（`10月27日 16:21`）—— 圆钮生硬地盖在日期文字上。
 *
 * 为什么是**实测**而不是固定加 `bottom`：分割行只出现在部分滚动位置，
 * 固定抬高会让按钮在所有位置都压住消息正文，反而更差。因此只在按钮矩形
 * 与分割行矩形相交时，按「分割行行高 + 间距」上移，最多 {@link BACK_TO_LATEST_AVOID_MAX_STEPS} 步。
 */

/** 分割行与按钮之间要留的间距（px）。 */
export const BACK_TO_LATEST_AVOID_GAP_PX = 8;

/** 最多上移几步：超过就宁愿压一行正文，也不把按钮推到消息区中部。 */
export const BACK_TO_LATEST_AVOID_MAX_STEPS = 3;

/** 只用到视口坐标（`getBoundingClientRect` 直接给）。 */
export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 两个矩形的相交面积（px²）；不相交 = 0。 */
export function overlapArea(a: RectLike, b: RectLike): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * 算出按钮需要从基准位（`bottom-4`）上移多少 px，才能与所有分割行重叠为 0。
 *
 * - `button` 必须是**未上移**的基准矩形；已上移时调用方要把当前 offset 加回去。
 * - `dividers` 是当前可视区域内的分割行矩形（时间 + 未读）。
 * - 返回 0 表示保持原位；返回的 offset 可以安全地用到 `bottom` 上。
 *
 * 每一步的步长取「本次相交行的最大行高 + 间距」，所以行高变了也不用改常数。
 */
export function computeBackToLatestAvoidOffset(
  button: RectLike,
  dividers: RectLike[],
  maxSteps: number = BACK_TO_LATEST_AVOID_MAX_STEPS,
  gapPx: number = BACK_TO_LATEST_AVOID_GAP_PX,
): number {
  let offset = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const moved = {
      ...button,
      top: button.top - offset,
      bottom: button.bottom - offset,
    };
    const hits = dividers.filter((d) => overlapArea(moved, d) > 0);
    if (hits.length === 0) return offset;
    const rowHeight = Math.max(...hits.map((d) => d.bottom - d.top));
    offset += rowHeight + gapPx;
  }
  // 走满上限后停手：宁可保留一点重叠，也不无限上抬去压正文。
  return offset;
}
