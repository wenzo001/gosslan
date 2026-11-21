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
 * **1px 不是随手取的**（2026-11-21 第二版，用户实测 Windows 是 125% 缩放）：
 * 一个**物理像素**在 DPI 缩放下对应的 CSS 宽是 `1 / dpr`：
 *
 * | 系统缩放 | dpr  | 一个物理像素 = CSS px |
 * |---------|------|----------------------|
 * | 100%    | 1.0  | 1.0                  |
 * | **125%**| 1.25 | **0.8**              |
 * | 150%    | 1.5  | 0.667                |
 * | 200%    | 2.0  | 0.5                  |
 * | macOS 2x| 2.0  | 0.5                  |
 *
 * 第一版取 0.5 只挡得住 200%（Mac）那一档 —— 而用户在 125% 上，WebView2 把
 * `contentRect.width` 吸附到物理像素网格后，同一盒子的读数会在 375.2 / 376.0 之间
 * 来回跳（差 **0.8px**）：0.5 的容差**一次也拦不住**，闭环照旧闭合（这就是"改完还在抖"
 * 的原因）。取 1px 把 125%/150% 两档都吸收掉。
 *
 * 会不会漏掉真实变化：列数 = `floor(宽 / 半角字宽)`，而半角字宽是 6~9px ⇒ 1px 的宽度变化
 * **不可能**改变列数（要变列数至少得挪动一个字的宽度）。所以这条容差对真实 resize 零代价。
 */
export const WIDTH_EPSILON_PX = 1;

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
