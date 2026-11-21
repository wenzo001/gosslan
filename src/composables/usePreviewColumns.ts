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
import { shouldRemeasure } from "@/utils/remeasureGate";

/** 列数的合理区间：低于 8 列连一个汉字加省略号都放不下，高于 400 只可能是量错了。 */
const MIN_COLUMNS = 8;
const MAX_COLUMNS = 400;

const unitCache = new Map<string, number>();

/**
 * 正文能用的宽度 —— **取「列宽上限」而不是正文自己的实测宽**（2026-11-21 第六刀）。
 *
 * ## 为什么必须换源（Windows 上量到的闭环）
 * 气泡是**收缩贴合**（shrink-to-fit）的：宽度 = min(内容宽, 68% / 560px)。于是
 * "正文实测宽"这个读数里混着**截断结果**：
 *
 *     列数 ↓⇒ 截掉更多字 ⇒ 最宽的那行变短 ⇒ 气泡变窄 ⇒ 实测宽变小 ⇒ 列数 ↓
 *
 * 反过来同样成立（换行点被挪动时最宽行会变长），所以稳定态是**两个值来回翻**：
 * 用户机器上量到 `spacer 高 831.23 ↔ 851.23`（正好差一行 20px）、`scrollTop 404 ↔ 424`、
 * 正文文本每拍重写一次 —— 那就是肉眼看到的"抖"。锁死正文宽度后立刻停止 ⇒ 闭环确认。
 *
 * 列宽上限（`.msg-stack` 的 `max-width: min(68%, 560px)`）**只跟窗口宽度有关**，
 * 与文字长短无关 ⇒ 拿它当宽度源，上面那条环从定义上就不存在。
 *
 * 上限是**盒宽**，正文能用的要扣掉中间各层的左右内边距/边框（气泡的 `px-3` 就在这里）。
 * 找不到上限元素（不在消息气泡里）时返回 null，调用方退回实测宽 —— 保持这个
 * composable 的通用性。
 */
export function allowedColumnWidth(el: HTMLElement): number | null {
  const cap = el.closest(".msg-stack");
  if (!cap) return null;
  const max = parseFloat(getComputedStyle(cap).maxWidth);
  if (!Number.isFinite(max) || max <= 0) return null;
  let inset = 0;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    inset +=
      (parseFloat(cs.paddingLeft) || 0) +
      (parseFloat(cs.paddingRight) || 0) +
      (parseFloat(cs.borderLeftWidth) || 0) +
      (parseFloat(cs.borderRightWidth) || 0);
    if (n === cap) break;
  }
  const width = max - inset;
  return width > 0 ? width : null;
}

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
  /** 上次真正用于测量的宽度（`<0` = 还没量过，或元素刚换过）。 */
  let lastWidth = -1;
  /** 上次测量时的字体指纹（`getComputedStyle().font`）。宽度之外**唯一**能让列数变的输入。 */
  let lastFont = "";

  /**
   * ⚠️ 2026-11-21（Windows 振荡根因，第六刀定案）：宽度源必须是「列宽上限」。
   *
   * 前五刀都在"怎么读宽度"上打补丁（`clientWidth` → `contentRect` 浮点宽 → 加容差 →
   * 容差放宽到 1px），但**读哪个元素**一直没换：读的是正文自己。而正文所在的气泡是
   * 收缩贴合的，正文宽 = 截断后的内容宽 ⇒ 列数与宽度互为因果（见 `allowedColumnWidth`
   * 的注释）。用户 7.1.64 实测量到闭环的两个稳态：`spacer 831.23 ↔ 851.23`、
   * `scrollTop 404 ↔ 424`、正文文本每拍重写 —— 锁死正文宽度后抖动立即停止。
   *
   * 所以宽度源改成 `.msg-stack` 的 `max-width`（只跟窗口宽度有关）。容器本身的实测宽
   * 只在**找不到上限元素**时兜底（这个 composable 理论上也能被别处用）。
   *
   * 高度环的断点仍然保留：宽度与字体指纹都没变 ⇒ 直接返回（RO 的高度回调在这里止步）。
   */
  const measure = (entry?: ResizeObserverEntry) => {
    const el = getEl();
    if (!el || !el.isConnected) return;
    const inner =
      allowedColumnWidth(el) ??
      (entry != null
        ? entry.contentRect.width // content box 浮点宽，已不含 padding
        : (() => {
            const cs = getComputedStyle(el);
            const padL = parseFloat(cs.paddingLeft) || 0;
            const padR = parseFloat(cs.paddingRight) || 0;
            return el.clientWidth - padL - padR;
          })());
    if (inner <= 0) return;
    // ⚠️ 高度变化触发的 RO 回调在这里止步：宽度没变 ⇒ 列数**通常**不可能变。
    // 缺了这道门，第一刀的"切断高度环"只存在于注释里（2026-11-21 补齐）。
    //
    // 但"宽度不变"是**必要不充分**：用户改正文字号时宽度一点不动，而 `unit`
    // （一个半角字符的宽度）变了 ⇒ 列数必须重算。所以门前再比一个**字体指纹**：
    // 宽度和字体都没变才 return（2026-11-21 review 修回：只按宽度设门，会把
    // 「只改字号」这条合法路径一起挡掉，`textColumns` 的注释承诺就落空了）。
    //
    // 代价：每次 RO 回调付一次 `getComputedStyle`。RO 回调发生在布局之后、样式没有
    // 脏标记 ⇒ 这是**干净读**，不是强制 recalc；真正会放大抖动的是"被门挡掉之后还要
    // 继续往下跑"，那一步已经被 return 掐掉了。
    const widthChanged = shouldRemeasure(lastWidth, inner);
    const font = getComputedStyle(el).font;
    if (!widthChanged && font === lastFont) return;
    const unit = halfCharWidth(font);
    if (unit <= 0) return;
    lastFont = font;
    if (widthChanged) lastWidth = inner;
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
      // 新元素的宽度与旧元素无关 ⇒ 必须重新建立基线，否则宽度差落在容差内会被误跳过。
      lastWidth = -1;
      lastFont = "";
      measure();
    },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return columns;
}
