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
import { COLUMN_HYSTERESIS, bubbleColumnCap, shouldRemeasure } from "@/utils/remeasureGate";

/** 列数的合理区间：低于 8 列连一个汉字加省略号都放不下，高于 400 只可能是量错了。 */
const MIN_COLUMNS = 8;
const MAX_COLUMNS = 400;

const unitCache = new Map<string, number>();

/* ── 切会话首帧：把逐行布局读取合批到绘制之前 ────────────────────────────────
 *
 * 为什么（2026-11-26 用户实测「点列表切换，右边要顿一下」）：切会话那一轮
 * patch 单次 93~406ms，而 12 条 MessageItem 在干净页面里挂载只要 50ms。逐行看栈，
 * **全部** `getComputedStyle` 都来自这里：`allowedColumnWidth` 读 cap / parent /
 * 每一层祖先的 padding+border（一行 6~10 次），再读两次 font。每行挂载都紧接着
 * 一次读样式 ⇒ 每次都是强制 recalc，切会话那 10 来行就是十几次全文档样式重算。
 *
 * 做法：VirtualList 在切会话那一帧开一个短窗口；窗口内的测量不逐行立刻读，而是攒到
 * **当前 patch 结束后的同一个微任务**里集中读。一次强制重算供所有行复用，
 * 又赶在绘制之前完成 —— 行高/截断不会晚一帧（rAF 版实测让切换后滚动跨帧跳 28px，
 * 所以这里必须是微任务而不是下一帧）。
 * 没开窗口时（正常打字、收消息）行为与原来逐字一致。
 */
let layoutReadDeadline = 0;
let pendingReads: Array<() => void> = [];
let readQueued = false;

export function deferLayoutReadsFor(ms: number): void {
  layoutReadDeadline = performance.now() + ms;
}

export function afterLayoutReadWindow(task: () => void): void {
  if (performance.now() >= layoutReadDeadline) {
    task();
    return;
  }
  pendingReads.push(task);
  if (readQueued) return;
  readQueued = true;
  queueMicrotask(() => {
    readQueued = false;
    const jobs = pendingReads;
    pendingReads = [];
    for (const job of jobs) job();
  });
}

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
  const parent = cap?.parentElement;
  if (!cap || !parent) return null;
  // ⚠️ **不要** `parseFloat(getComputedStyle(cap).maxWidth)`：`.msg-stack` 上写的是
  // `max-width: min(68%, 560px)`，而 computed 值**不会被解析成 px** —— 真浏览器实测返回
  // 字符串 `"min(68%, 560px)"`，`parseFloat` 得到 `NaN`。7.1.65 就是这么"修完还是抖"的：
  // `NaN` 被当成「没有上限」，静默退回正文实测宽，闭环一点没动。
  // 改成读两个令牌自己算 min（纯函数在 `utils/remeasureGate.ts`，有单测）。
  const cs = getComputedStyle(cap);
  const pct = parseFloat(cs.getPropertyValue("--gosslan-msg-max"));
  const pxLimit = parseFloat(cs.getPropertyValue("--gosslan-msg-max-px"));
  const pcs = getComputedStyle(parent);
  const parentContent =
    parent.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
  const capPx = bubbleColumnCap(pct, pxLimit, parentContent);
  if (capPx == null) return null;
  // 上限是**盒宽**；正文能用的要扣掉中间各层的左右内边距/边框（气泡的 `px-3` 在这里）。
  let inset = 0;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs2 = getComputedStyle(n);
    inset +=
      (parseFloat(cs2.paddingLeft) || 0) +
      (parseFloat(cs2.paddingRight) || 0) +
      (parseFloat(cs2.borderLeftWidth) || 0) +
      (parseFloat(cs2.borderRightWidth) || 0);
    if (n === cap) break;
  }
  const width = capPx - inset;
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
 * **会话级共享列数**（2026-11-22）：最后一个被实测过的气泡的列数。
 *
 * 为什么能共享：列数只由「列宽上限（容器宽的 min(68%,560px)）+ 字号」决定，与文字长短
 * 无关 ⇒ 同一个聊天视口里**所有气泡的列数相同**。估算端（`messageHeight`）拿不到 DOM，
 * 过去只能用写死 35 列的粗模型 —— 与实测列数差出的每一行都是虚拟列表的一笔校正
 * （探针实测算出 40 行的种子会话估算总高比实测多 736px，切回时整列肉眼可见地缩）。
 * 渲染端量一次就把准确值抄给估算端，两边从此同一个家。
 *
 * ⚠️ 模块级 ref 是**每个 WebView 一个实例**，不跨窗口共享 —— 正好符合"列数是窗口属性"。
 */
export const sharedPreviewColumns = ref(0);

/**
 * 共享值的"世代"。窗口宽度 / 字号变化时要让所有行放弃复用、重新量一次；
 * 只在 VirtualList 确认过的真实布局变化处（`>24px` 宽度变化 / `layoutKey` 变化）递增。
 */
let layoutEpoch = 0;
let sharedEpoch = -1;
let sharedLayoutKey = "";
export function invalidatePreviewLayout(): void {
  layoutEpoch += 1;
}

/** 正文那一格的 class 链：同聊天视口内所有文本气泡相同；不同气泡形状不互相复用。 */
function previewLayoutKey(el: HTMLElement): string {
  const cap = el.closest(".msg-stack");
  return `${el.className}|${el.parentElement?.className ?? ""}|${cap?.className ?? ""}`;
}
/**
 * 会话级共享的**正文内容宽**（px）与**字体串**（2026-11-22）。
 *
 * 像素级行数估算需要这两个输入：行数 = Σ ceil(该行像素宽 / 内容宽)，比
 * 「CJK=2 列」的栅格模型准 —— 栅格假设 CJK 恰好是数字字形的 2 倍宽，而真实字体里
 * 数字字形只有 CJK 的 ~57%，CJK 长文因此被系统性多算一行（探针实测 -280px/14 行）。
 * 字体串由渲染端量一次抄上来（同一个家：`usePreviewColumns` 的 measure）。
 */
export const sharedPreviewWidth = ref(0);
export const sharedPreviewFont = ref("");

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
   * 是否已经有**一次真实测量被采纳过**。
   *
   * 迟滞带只对"已有真实值"生效（2026-11-21 review）：`columns` 的初值是
   * `fallback`（`textColumns()` 的估算），首次真实测量若只差 1 列就被带子挡掉，
   * 而基线（`lastWidth`/`lastFont`）已经提交 ⇒ 之后所有 RO 回调在宽度门就返回了，
   * 列数会**永久**停在估算值上。所以首次必须无条件采纳。
   */
  let hasMeasured = false;

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
    const cap = el.closest(".msg-stack");
    // 会话级复用（2026-11-26）：同一聊天视口里所有文本气泡的「内容宽 + 字体」相同，
    // 后到的行不必再逐层读 cap / parent / 祖先的 padding+border。世代或 class 链不同
    // 就老老实实全量量一次 —— 不同气泡形状（代码/文件）不共用同一份读数。
    const reuse =
      !!cap &&
      sharedEpoch === layoutEpoch &&
      sharedPreviewWidth.value > 0 &&
      !!sharedPreviewFont.value &&
      sharedLayoutKey === previewLayoutKey(el);
    const inner = reuse
      ? sharedPreviewWidth.value
      : (allowedColumnWidth(el) ??
        (entry != null
          ? entry.contentRect.width // content box 浮点宽，已不含 padding
          : (() => {
              const cs = getComputedStyle(el);
              const padL = parseFloat(cs.paddingLeft) || 0;
              const padR = parseFloat(cs.paddingRight) || 0;
              return el.clientWidth - padL - padR;
            })()));
    if (inner <= 0) return;
    const font = reuse ? sharedPreviewFont.value : getComputedStyle(el).font;
    if (!reuse && cap && font) {
      // 只有"全量量过"的那一行才有权写共享值（避免把 fallback 误抄成真值）。
      sharedPreviewWidth.value = inner;
      sharedPreviewFont.value = font;
      sharedEpoch = layoutEpoch;
      sharedLayoutKey = previewLayoutKey(el);
    }
    // ⚠️ 高度变化触发的 RO 回调在这里止步：宽度没变 ⇒ 列数**通常**不可能变。
    // 缺了这道门，第一刀的"切断高度环"只存在于注释里（2026-11-21 补齐）。
    //
    // 但"宽度不变"是**必要不充分**：用户改正文字号时宽度一点不动，而 `unit`
    // （一个半角字符的宽度）变了 ⇒ 列数必须重算。所以门前再比一个**字体指纹**：
    // 宽度和字体都没变才 return（2026-11-21 review 修回：只按宽度设门，会把
    // 「只改字号」这条合法路径一起挡掉，`textColumns` 的注释承诺就落空了）。
    //
    // 代价：每次 RO 回调付一次 font 读。RO 回调发生在布局之后、样式没有脏标记 ⇒
    // 干净读；切会话那批挂载读已由 `afterLayoutReadWindow` 合批到绘制前的微任务。
    const widthChanged = shouldRemeasure(lastWidth, inner);
    if (!widthChanged && font === lastFont) return;
    const unit = halfCharWidth(font);
    if (unit <= 0) return;
    lastFont = font;
    if (widthChanged) lastWidth = inner;
    const next = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.floor(inner / unit)));
    // 双保险（2026-11-21 第六刀）：宽度源换成上限之后闭环本该断了，但 ±1 列的翻转是
    // 这条链**唯一**的可见形状（20px = 一行），留一条带子：差 1 列不跟。
    // 代价是窗口按 1 列的步长变化时列数晚一拍更新，肉眼不可见。
    // ⚠️ 只对"已采纳过真实值"生效：首次测量必须无条件落地（否则会永久停在估算值上）。
    if (hasMeasured && Math.abs(next - columns.value) < COLUMN_HYSTERESIS) return;
    if (next !== columns.value) columns.value = next;
    hasMeasured = true;
    // 抄送会话级共享值（估算端读它，见上面的说明）。迟滞带**之后**抄：估算端拿到的
    // 是与渲染端当前生效值完全相同的那个数。
    sharedPreviewColumns.value = columns.value;
  };

  onMounted(() => {
    // 切会话窗口里不逐行读样式：攒到当前 patch 后的同一个微任务集中量（窗口外同步执行）。
    afterLayoutReadWindow(() => measure());
    const el = getEl();
    if (el && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) =>
        afterLayoutReadWindow(() => measure(entries[entries.length - 1])),
      );
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
      // `hasMeasured` 一起复位：新元素第一次量到的值必须落地，不能被迟滞带挡掉。
      lastWidth = -1;
      lastFont = "";
      hasMeasured = false;
      afterLayoutReadWindow(() => measure());
    },
  );

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return columns;
}
