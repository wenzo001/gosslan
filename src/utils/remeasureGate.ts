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

/**
 * 气泡的**列宽上限**（px）—— 列数真正该用的宽度源（2026-11-21 第六刀）。
 *
 * ## 为什么不能用"正文自己的实测宽"
 * 气泡是收缩贴合的：宽度 = min(内容宽, 上限)。于是"正文实测宽"里混着**截断结果**，
 * 列数与宽度互为因果：
 *
 *     列数 ↓ ⇒ 截掉更多字 ⇒ 最宽那行变短 ⇒ 气泡变窄 ⇒ 实测宽变小 ⇒ 列数 ↓
 *
 * 反向同样成立（换行点被挪动时最宽行会变长）⇒ 稳定态是两个值来回翻。用户 7.1.64 在
 * Windows 上量到：`spacer 831.23 ↔ 851.23`（正好一行 20px）、`scrollTop 404 ↔ 424`、
 * 同一条正文文本每拍重写；把正文宽度锁死后抖动立即停止。
 *
 * ## 为什么不能 `parseFloat(getComputedStyle(cap).maxWidth)`
 * CSS 里写的是 `max-width: min(68%, 560px)`，而 **computed 值不会被解析成 px** ——
 * 真浏览器实测返回字符串 `"min(68%, 560px)"`，`parseFloat` 得到 `NaN`。
 * 7.1.65 就是这么"修完还是抖"的：`NaN` 被当成"没有上限"，静默退回正文实测宽。
 * ⇒ 读两个令牌（`--gosslan-msg-max` / `--gosslan-msg-max-px`）自己算 `min`。
 *
 * @param pct              `--gosslan-msg-max` 的百分数（`"68%"` → 68）
 * @param pxLimit          `--gosslan-msg-max-px` 的像素值（`"560px"` → 560）
 * @param parentContentW   上限元素的**包含块内容宽**（`max-width` 的百分比按它解析）
 * @returns 上限（px）；一个有效输入都没有、或包含块量不到时返回 `null`（调用方退回实测宽）。
 */
export function bubbleColumnCap(
  pct: number,
  pxLimit: number,
  parentContentW: number,
): number | null {
  if (!Number.isFinite(parentContentW) || parentContentW <= 0) return null;
  let cap = Number.POSITIVE_INFINITY;
  if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
    cap = Math.min(cap, (pct / 100) * parentContentW);
  }
  if (Number.isFinite(pxLimit) && pxLimit > 0) {
    cap = Math.min(cap, pxLimit);
  }
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * 列数的**迟滞带**（2026-11-21）：差 1 列不跟。
 *
 * 为什么还要这一层：宽度源换成「上限」之后，截断↔宽度那条环本该从定义上断掉；
 * 但它唯一的可见形状就是 **±1 列**（→ 一行 20px）。留一条带子把"差一列"吸收掉，
 * 相当于给闭环上第二把锁 —— 万一上限源哪天又被改回实测宽（7.1.65 就发生过一次：
 * `min()` 的 computed 值 `parseFloat` 得 NaN，静默退回实测宽），这里也不会立刻抖起来。
 *
 * 为什么不更大：真实 resize 一次动很多列；带子取 2 只挡住"差一列"这种量级。
 */
export const COLUMN_HYSTERESIS = 2;
