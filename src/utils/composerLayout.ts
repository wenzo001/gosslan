/**
 * 聊天输入框的垂直尺寸口径（纯函数，便于 node --test 单测）。
 *
 * 为什么抽出来：编辑区高度是按**内容测量值**实时写的（`scrollHeight`），
 * 而「最多几行 / 一行多高 / 上下内边距多少」以前是三个散落的魔法数字
 * （`128`、`leading-normal`、`py-0.5`）。改字号（设置里的 13/14/16 三档）时
 * 那个 `128` 不会跟着变，于是「5 行封顶」在不同字号下时多时少。
 *
 * ⚠️ 三个常量必须与 `MessageComposer.vue` 编辑区的实际样式同步：
 * - `leading-normal` ⇒ 行高 1.5em；
 * - `py-0.5` ⇒ 上下各 2px（`scrollHeight` 含内边距，所以封顶值也要加）；
 * - 最大可见行数 5（用户 2026-11-04 的硬要求）。
 */

/** 输入框最多可见 5 行，超过后内部滚动（不要再往上长）。 */
export const COMPOSER_MAX_LINES = 5;

/** 编辑区行高倍数，对应 Tailwind `leading-normal`（1.5）。 */
export const COMPOSER_LINE_HEIGHT = 1.5;

/** 编辑区上下内边距之和（`py-0.5` = 2px + 2px）。 */
export const COMPOSER_VERTICAL_PADDING_PX = 4;

/** 给定字号，算出「5 行内容 + 上下内边距」的封顶高度（px）。 */
export function composerMaxHeight(fontSizePx: number): number {
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 14;
  return Math.round(size * COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES + COMPOSER_VERTICAL_PADDING_PX);
}

/**
 * 按内容高度与封顶值算最终写进 `style.height` 的像素值。
 *
 * 内容超过封顶时**恒定返回封顶值**（内部滚动），不会继续长高；这就是
 * 「5 行封顶后高度恒定」的判据。最小值交给 CSS 的 `min-h-10`（维持现状），
 * 这里不重复一份最小高度常量。
 */
export function clampComposerHeight(contentHeightPx: number, maxHeightPx: number): number {
  const content = Number.isFinite(contentHeightPx) ? Math.max(0, contentHeightPx) : 0;
  const max = Number.isFinite(maxHeightPx) ? Math.max(0, maxHeightPx) : 0;
  return Math.min(content, max);
}
