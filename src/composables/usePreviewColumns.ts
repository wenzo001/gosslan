/**
 * 「这一行能放多少个半角列」的**实测**来源（2026-11-08，长文本/长代码截断）。
 *
 * 为什么要量、而不是用 `previewMetrics` 里的估算值 `COLUMNS_PER_LINE = 35`：
 * 那个数是按 68% × 560px 的**最宽**情形反推的常量，只适合"要不要截"这种粗判断。
 * 真拿去切内容就会两头都难看 —— 窄窗（360 / 390）下切少了、被 CSS 再裁一次（半截字），
 * 宽窗下切多了、第五行只剩一两个字。所以进 DOM 的那一刀必须按**当前这一格的真实宽度**算。
 *
 * 量法：读元素的内容宽（clientWidth 减去左右内边距）+ 用 canvas 以该元素的真实字体
 * 量一个半角字符的宽度 ⇒ `列数 = floor(内容宽 / 半角列宽)`。字形宽度只跟 font 串有关，
 * 按 font 串缓存，一屏几十条长消息也只量一两次。
 *
 * 首帧仍用估算值兜底（否则连挂载都做不到）：量到之后 `columns` 变化会触发一次重算，
 * 那一帧的 CSS clamp / 固定高度仍然兜着，不会闪出第六行。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

/** 列数的合理区间：低于 8 列连一个汉字加省略号都放不下，高于 400 只可能是量错了。 */
const MIN_COLUMNS = 8;
const MAX_COLUMNS = 400;

const unitCache = new Map<string, number>();

/**
 * 一个半角字符在当前字体下的宽度（px）。用 `"0"` 量：数字/拉丁字母的宽度一致，
 * CJK 按两列算（与 `columnWidth` 同一口径）。量不出来（无 canvas）时返回 0，调用方跳过。
 */
export function halfCharWidth(font: string): number {
  const hit = unitCache.get(font);
  if (hit !== undefined) return hit;
  let width = 0;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = font;
      width = ctx.measureText("0").width;
    }
  } catch {
    width = 0;
  }
  unitCache.set(font, width);
  return width;
}

/**
 * 跟着元素真实宽度走的列数。
 *
 * @param getEl 要量的元素（必须已挂载）；返回 null 时保持上一次的值。
 * @param fallback 首帧预算（估算值），量到之后被真实值替换。
 */
export function usePreviewColumns(getEl: () => HTMLElement | null, fallback: number): Ref<number> {
  const columns = ref(fallback);
  let observer: ResizeObserver | null = null;

  /**
   * ⚠️ 2026-11-21（Windows 振荡根因）：此函数过去有两个形状缺陷，合起来构成一个
   * **无限重排循环** —— 用户在 Windows 7.1.52/7.1.54 实测「某条长文本一直在重新算
   * 高度」（移动端宽度不抖、桌面宽度抖；Mac 从不复现）：
   *
   * ① 宽度取自 `clientWidth` —— 它是**取整整数**。WebView2 的亚像素布局下（DPI
   *    缩放 + 中文长文本），同一列宽会在两个整数之间交替；columns = floor(inner/unit)
   *    ⇒ columns ±1 翻转 ⇒ 截断切刀差一个字 ⇒ 行内容变 ⇒ 微小高度变化 ⇒
   * ② RO 观察的是**全维度**（高度变化也触发回调）⇒ measure 再次执行 ⇒ 循环闭合，
   *    每帧重排。宽度相关的"桌面宽度才抖"正是列数大时切刀落在字素边界附近；
   *    窄宽度下列数小、切刀远离边界 ⇒ 不抖。
   *
   * 修复：① 优先取 RO 的 `contentRect.width` —— **content box 的浮点宽**（不含
   *    padding、不取整），布局稳定时它恒定；② 只在宽度真的变化时才继续测量
   *    （高度变化、同宽度 ⇒ 直接返回），切断高度环。手动路径（挂载/watch）没有
   *    entry，保留 clientWidth 兜底。
   */
  const measure = (entry?: ResizeObserverEntry) => {
    const el = getEl();
    if (!el || !el.isConnected) return;
    const unit = halfCharWidth(getComputedStyle(el).font);
    if (unit <= 0) return;
    const inner =
      entry != null
        ? entry.contentRect.width // content box 浮点宽，已不含 padding
        : (() => {
            const cs = getComputedStyle(el);
            const padL = parseFloat(cs.paddingLeft) || 0;
            const padR = parseFloat(cs.paddingRight) || 0;
            return el.clientWidth - padL - padR;
          })();
    if (inner <= 0) return;
    const next = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.floor(inner / unit)));
    if (next !== columns.value) columns.value = next;
  };

  onMounted(() => {
    measure();
    const el = getEl();
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) => measure(entries[entries.length - 1]));
      observer.observe(el);
    }
  });

  // 元素被换掉（v-if 分支切换、消息内容变了重建节点）时重新挂观察者。
  watch(
    () => getEl(),
    (el, prev) => {
      if (el === prev) return;
      if (prev && observer) observer.unobserve(prev);
      if (el && observer) observer.observe(el);
      measure();
    },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return columns;
}
