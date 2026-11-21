/**
 * 「宽度变了才重量」的门（2026-11-21，Windows 抖动）。
 *
 * 抽成独立纯函数而不是留在 `composables/usePreviewColumns.ts` 里，是因为那个文件
 * import 了 `vue`，而 `npm test`（node --test + strip-types）不解析 `@/` 别名、
 * 也不该为了测一道算术去加载运行时框架。这里**零依赖**，测试可以直接 import。
 *
 * ── 它到底在防什么 ──────────────────────────────────────────────────────────
 * `ResizeObserver` 观察的是**全维度**：行内容变高也会回调。列数（这一行能放几个
 * 半角字）只跟**宽度**有关，高度变化时重算是纯浪费；而一旦重算结果变了，
 * 内容又会变高/变矮 ⇒ 又一次 RO 回调 ⇒ 闭环：
 *
 *     列数 → 内容高度 → RO(高度) → 再次重算列数 → …
 *
 * 表现就是「某条长文本每帧都在重排」。它只在 Windows 上闭合，因为：
 *   · WebView2 在 DPI 缩放（125% / 150%）下，同一个盒子的 `contentRect.width`
 *     会在亚像素级来回抖（375.2 / 375.1999…）；
 *   · `floor(width / 半角字宽)` 一旦贴着字素边界，这点抖动就翻转 ±1 列；
 *   · Mac 的 DPR 是整数（2.0），宽度恒定，闭合条件根本不成立。
 * 这解释了「Mac 从复现不了、Windows 一开就抖」的全部差异。
 */

/**
 * 宽度变化多少才值得重算（px）。
 *
 * 0.5px 远小于一个半角字（通常 6~9px），所以真正该更新列数的宽度变化不会被漏掉；
 * 又能吸收掉 WebView2 的亚像素抖动。
 */
export const WIDTH_EPSILON_PX = 0.5;

/**
 * 这次回调要不要继续测量。
 *
 * @param prevWidth 上次**真正用于测量**的宽度；`< 0` 表示还没有基线（首次 / 元素刚换过）。
 * @param nextWidth 本次拿到的宽度（优先 RO 的 `contentRect.width`，它是浮点）。
 */
export function shouldRemeasure(prevWidth: number, nextWidth: number): boolean {
  if (!Number.isFinite(nextWidth) || nextWidth <= 0) return false;
  if (!Number.isFinite(prevWidth) || prevWidth < 0) return true;
  return Math.abs(nextWidth - prevWidth) >= WIDTH_EPSILON_PX;
}
