<script setup lang="ts">
/**
 * 统一滚动容器（naive-ui Scrollbar 内核，2026-11-26 第四版）。
 *
 * 为什么换成 naive-ui：前三版把"条"和"滚动"都压在 OverlayScrollbars 上，显隐、宽度、
 * 拖动手势都由库的 JS 状态机决定，在 Windows/WebView2 与 WKWebView 上表现不同；
 * 第四版把滚动交给 naive 的 `Scrollbar`（原生滚动 + 自绘条 + 自量几何），本组件只负责
 * 本仓的语义：档位、内边距移植、hover/滚动淡入淡出、无障碍属性落点、对外 API 兼容。
 *
 * ── DOM 结构（naive 的真实结构，改样式前必读）────────────────────────────
 *   .n-scrollbar            ← 宿主（class 落在这里；height:100%; overflow:hidden）
 *     .n-scrollbar-container  ← **真正的滚动元素**（containerRef，overflow:scroll）
 *       .n-scrollbar-content  ← 内容盒（contentRef，高度 = 内容高度）
 *     .n-scrollbar-rail       ← 轨道（absolute，pointer-events:none）
 *       .n-scrollbar-rail__scrollbar ← 滑块
 * 所以：读滚动几何用 `scrollElement()`（container），不要读宿主；`role/aria-live` 也
 * 必须显式搬到 container（naive 不会转发 attrs 到它，见 `applyAria`）。
 *
 * ── 内边距为什么由 JS 搬到 content（别改成"留在宿主上"）──────────────────
 * naive 的宿主是 `height:100%`，padding 会让 `.n-scrollbar-container`（height:100%）
 * 只占**内容盒**、轨道却按 padding-box 定位 ⇒ 滚动区与轨道不等高 ⇒ 滑块长度/位置
 * 与内容不匹配（就是"到底了滑块还没到底"那类错乱）。本仓 35 个调用点里大量
 * `px-4 / py-2 / pb-6 / .gosslan-scroll{padding-inline:16px}`，逐个改会漏。
 * ⇒ 挂载后把宿主的 computed padding 读出来、写到 content 上，再给宿主加
 * `gosslan-os--pads`（`padding:0 !important`）。语义也更对：内边距属于滚动内容，
 * 滚到底时 `pb-6` 的留白仍在末行下方（与迁移前 OverlayScrollbars 的读数一致）。
 *
 * ── 显隐为什么用 trigger="none" + CSS（别再交给 naive 的 hover 状态机）────
 * naive 的 `trigger="hover"` 只在鼠标进入容器时显示，**滚动时不显示**；而用户要的是
 * 「默认不可见、hover 或滚动时淡入、停手 1s 淡出」（微信桌面端）。`trigger="none"`
 * 下 naive 不渲染 Transition、滑块常驻 DOM（`needYBar` 时才渲染），显隐就能由
 * `.is-scrolling` / `:hover` 两个纯 CSS 条件决定 —— 同一个 DOM、同一份 CSS、三端一致。
 *
 * ── 触屏 ────────────────────────────────────────────────────────────────
 * naive 在 iOS 上本来就不渲染滑块（`isIos`）；Android 由 `@media (hover:none)`
 * 兜底隐藏。触屏不需要拖拽条，隐藏后不会出现"摸一下就有一条灰线"。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from "vue";
import { NScrollbar } from "naive-ui";

const props = withDefaults(
  defineProps<{
    /** 只在需要时滚动（默认 y）。x 轴仅 axis="both" 时开（代码块等横向场景不走本组件）。 */
    axis?: "y" | "both";
    /**
     * 滑块粗细分档：`thick` 主内容区（会话/消息列表）、`normal` 内容页、`thin` 弹窗小列表。
     * 带宽由 `--n-scrollbar-width` 覆盖（见 style.css 的 `.gosslan-os--*`）。
     */
    size?: "thin" | "normal" | "thick";
    /** 无障碍属性：落在真正滚动的 container 上，不是宿主。 */
    role?: string;
    ariaLive?: string;
    ariaRelevant?: string;
    /** 追加到滚动元素的内联样式（极少用；内边距已自动移植）。 */
    contentStyle?: Record<string, string>;
  }>(),
  { axis: "y", size: "thin" },
);

const emit = defineEmits<{ (e: "scroll"): void }>();

// 滑块最小长度由 naive 的 `1.5 × theme.width` 决定（`yBarSize` 的公式里是个常数项）。
// 直接用 8px 带宽时，几万像素的长列表滑块只有 12px —— 抓不住，也不像微信。
// 把**主题宽度**抬到 16px（最小长度 24px），视觉宽度再由 style.css 的
// `--n-scrollbar-width: 8/10/12px !important` 压回去；两者解耦，位置计算不受影响。
const themeOverrides = { width: "16px" };

type NaiveScrollbarInternal = {
  containerRef?: HTMLElement | null;
  contentRef?: HTMLElement | null;
  scrollTo: (options: unknown, y?: number) => void;
  scrollBy: (options: unknown, y?: number) => void;
  sync: () => void;
};

const barRef = ref<{ $el?: HTMLElement; scrollbarInstRef?: NaiveScrollbarInternal } | null>(null);

/**
 * 宿主元素（`.n-scrollbar`）。
 *
 * ⚠️ 不能用 `barRef.value.$el`：naive 的根是 `VResizeObserver`，它渲染成 Fragment，
 * `$el` 落在注释锚点上（`nodeType=8`，没有 `classList`）—— 2026-11-26 实测：
 * 读 padding 时抛 `Cannot read properties of undefined (reading 'contains')`，
 * 同一个回调里的 `applyAria` 也一起没跑（`role` 停在 naive 的 `none`）。
 * 从真正滚动的 container 向上找，才是那个带 class 的盒子。
 */
function rootEl(): HTMLElement | null {
  return scrollElement()?.closest<HTMLElement>(".n-scrollbar") ?? null;
}

/** naive 的内层实例（container/content/命令都从这里取）。 */
function internal(): NaiveScrollbarInternal | null {
  return barRef.value?.scrollbarInstRef ?? null;
}

/** 原生滚动元素（几何读取的唯一入口；写位置请走 `scrollTo`）。 */
function scrollElement(): HTMLElement | null {
  return internal()?.containerRef ?? null;
}

// ---------------- 滚动时的显隐 ----------------

/**
 * 滚动中 = 滑块可见。滚动事件很密，这里只在"由不可见转可见"时写一次响应式状态，
 * 之后重置 1s 定时器；停手 1s 后淡出。hover 不经过这里（由 CSS `:hover` 负责）。
 */
const scrolling = ref(false);
const SCROLL_VISIBLE_MS = 1000;
let hideTimer = 0;

function markScrolling() {
  if (!scrolling.value) scrolling.value = true;
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = 0;
    scrolling.value = false;
  }, SCROLL_VISIBLE_MS);
}

function onScroll() {
  markScrolling();
  emit("scroll");
}

// ---------------- 内边距移植 ----------------

type Pad = { t: number; r: number; b: number; l: number };
const pad = ref<Pad>({ t: 0, r: 0, b: 0, l: 0 });
const PAD_CLASS = "gosslan-os--pads";
/** 捕获期间忽略 RO 回调，避免「去类 → 尺寸变 → 再捕获」的自激循环。 */
let capturing = false;
let captureRaf = 0;
let ro: ResizeObserver | null = null;
let lastWidth = 0;
/**
 * 外部 class 变化的唯一入口。
 *
 * ⚠️ 不要用 MutationObserver 监听 class（2026-11-26 实测过，必须撤）：
 * `capturePadding` 自己会 remove/add `gosslan-os--pads`，MO 收到后又要重算 ⇒
 * 自激；加窗口期抑制后仍会在"滚动开始/结束切换 is-scrolling"时反复强制重排，
 * 复杂页面（聊天 + 手势输入）会把 renderer 拖到 120s 不回 CDP 包。
 * `useAttrs()` 本来就是响应式的：只在**父组件**更新 class 时触发，滚动热路径零观察者。
 */
const attrs = useAttrs();

function readPad(cs: CSSStyleDeclaration): Pad {
  return {
    t: parseFloat(cs.paddingTop) || 0,
    r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0,
    l: parseFloat(cs.paddingLeft) || 0,
  };
}

/**
 * 读宿主 padding 并搬到 content。规则：
 * 1. 先摘掉清零类，读**真实**的计算值（否则读到 0）；
 * 2. 写回 `pad`，有 padding 就立刻把清零类补回（同帧内不能留"双份 padding"的窗口）。
 * 只在挂载后、class 变化、宽度跨断点时跑，不参与滚动热路径。
 *
 * ⚠️ 清零类**必须同时**出现在模板的 `:class` 绑定里（`hasPad`），不能只靠这里手工
 * `classList.add`（2026-11-26 实测：切主题/`is-scrolling` 变化时 Vue 重算 class 串，
 * 把手工加的类整串覆盖掉 ⇒ 宿主 16px 复活、和 content 的 16px 叠成 32px，
 * 表现为「暗色下内容比标题多缩进 16px」，scrollstable 的卡片对齐判据就是这么红的）。
 */
function capturePadding() {
  const el = rootEl();
  if (!el || capturing) return;
  capturing = true;
  try {
    if (el.classList.contains(PAD_CLASS)) el.classList.remove(PAD_CLASS);
    const next = readPad(getComputedStyle(el));
    // 同值赋值不会触发渲染，所以可以无条件写：逻辑只剩"读 → 记 → 按需补类"一条线。
    pad.value = next;
    if (next.t || next.r || next.b || next.l) el.classList.add(PAD_CLASS);
  } finally {
    // 把基准同步到**捕获结束后的稳定宽度**：宿主 `clientWidth` 含 padding，
    // 捕获期间去掉清零类会让它短暂变小。RO 若拿中间值当基准，下一帧就会判成
    // "跨断点"再排一次捕获（自激）。这里记最终值，中间态一律不参与比较。
    lastWidth = el.clientWidth;
    capturing = false;
  }
}

function scheduleCapture() {
  if (captureRaf) return;
  captureRaf = requestAnimationFrame(() => {
    captureRaf = 0;
    capturePadding();
  });
}

/**
 * **内容盒**（`.n-scrollbar-content`）的最终样式：自动移植的 padding + 调用方补充。
 *
 * ⚠️ 必须落在 content，不是滚动元素 container（2026-11-26 两次实测后的结论）：
 * TanStack 的贴底口径是 `totalSize - clientHeight`。padding 若在 container 上，
 * `clientHeight` 会含 `pb-6` 的 24px ⇒ 与"内容总高"口径差 24px，切会话收敛时
 * 跨帧跳 24px（scrollswitch 的「目标会话出现后跨帧跳」读数正是 24）。
 * padding 属于内容留白：放 content 后 totalSize / scrollHeight / clientHeight 三者
 * 口径自洽，贴底不跳；探针读合法留白时也从 content 取 paddingBottom。
 */
const mergedContentStyle = computed<Record<string, string>>(() => {
  const p = pad.value;
  const out: Record<string, string> = { ...(props.contentStyle ?? {}) };
  if (p.t || p.r || p.b || p.l) out.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
  return out;
});

/**
 * 宿主是否需要"清零 padding"类。**这是清零类的权威来源**（模板 `:class` 绑定它）。
 * 手工 `classList.add` 只是让状态在同一帧就位；真正的归属权必须在 Vue 手里，
 * 否则任何一次 class 重算都会把它抹掉（见 `capturePadding` 的注释）。
 */
const hasPad = computed(() => !!(pad.value.t || pad.value.r || pad.value.b || pad.value.l));

// ---------------- 无障碍 ----------------

function applyAria() {
  const el = scrollElement();
  if (!el) return;
  if (props.role) el.setAttribute("role", props.role);
  else el.removeAttribute("role");
  if (props.ariaLive) el.setAttribute("aria-live", props.ariaLive);
  else el.removeAttribute("aria-live");
  if (props.ariaRelevant) el.setAttribute("aria-relevant", props.ariaRelevant);
  else el.removeAttribute("aria-relevant");
}

watch(() => [props.role, props.ariaLive, props.ariaRelevant], applyAria);

/**
 * 父组件换 class（响应式断点 / 条件类）⇒ 重读 padding。
 *
 * ⚠️ 必须在 setup 顶层注册：之前写在 `onMounted` 的 `nextTick` 回调里，
 * 那个时刻 `getCurrentInstance()` 已是 null，`watch` 建的是**独立 effect**，
 * 组件卸载时不会被自动 stop（每个滚动容器漏一份闭包）。顶层注册由组件 scope 托管。
 * 挂载前 `rootEl()` 还是 null 也无妨：`scheduleCapture` 的 rAF 回调会自行判空。
 */
watch(() => attrs.class, () => scheduleCapture());

// ---------------- 点轨道翻页 ----------------
//
// naive 的轨道是 `pointer-events: none`，只支持拖滑块；微信桌面端（以及 macOS 原生）
// 还支持「点轨道把那一屏滚过去」。这里补上，并且只在**轨道带内**生效：
// 点在滑块上 ⇒ 直接放行给 naive 的拖拽；点在轨道其余位置 ⇒ 按点击位置跳转。
// 用 capture 阶段：内容自己在 pointerdown 上 stopPropagation 也拦不住我们。
function onRailPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const el = rootEl();
  const vp = scrollElement();
  if (!el || !vp) return;
  const rail = el.querySelector<HTMLElement>(".n-scrollbar-rail--vertical");
  if (!rail) return;
  const rr = rail.getBoundingClientRect();
  if (e.clientX < rr.left || e.clientX > rr.right || e.clientY < rr.top || e.clientY > rr.bottom) return;
  const thumb = el.querySelector<HTMLElement>(".n-scrollbar-rail__scrollbar");
  const thumbH = thumb?.offsetHeight ?? 0;
  if (thumb) {
    const tr = thumb.getBoundingClientRect();
    // 点在滑块上：交给 naive 的拖拽，不抢。
    if (e.clientY >= tr.top && e.clientY <= tr.bottom) return;
  }
  const overflow = vp.scrollHeight - vp.clientHeight;
  if (overflow <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  const maxTop = Math.max(1, rr.height - thumbH);
  // 把点击位置当成滑块中心（macOS 直觉），夹在两端之间。
  const ratio = (e.clientY - rr.top - thumbH / 2) / maxTop;
  vp.scrollTo({ top: Math.max(0, Math.min(overflow, ratio * overflow)), behavior: "smooth" });
}

// ---------------- 生命周期 ----------------

onMounted(() => {
  // **同步**搬 padding（别等到 nextTick）：父组件的 mounted 里常会立刻 scrollToBottom，
  // 晚一帧的话贴底用的是"还没有 padding"的几何，下一帧再跳 24px（scrollswitch 的
  // 「目标会话出现后跨帧跳」就是它）。子组件的 mounted 先于父组件 ⇒ 此刻 container 已在。
  capturePadding();
  applyAria();
  // 兜底：若某些路径下 naive 还没建好 container，下一 tick 再试一次（已就位时为空操作）。
  void nextTick(() => {
    capturePadding();
    applyAria();
    const el = rootEl();
    if (!el) return;
    if (typeof ResizeObserver !== "undefined") {
      lastWidth = el.clientWidth;
      ro = new ResizeObserver(() => {
        if (capturing) return;
        const w = el.clientWidth;
        // 只在宽度真的变了（跨断点）时重读：滚动条显隐不占布局，不会造成宽度抖动。
        if (w > 0 && Math.abs(w - lastWidth) > 1) {
          lastWidth = w;
          scheduleCapture();
        }
      });
      ro.observe(el);
    }
  });
});

onBeforeUnmount(() => {
  if (hideTimer) window.clearTimeout(hideTimer);
  hideTimer = 0;
  if (captureRaf) cancelAnimationFrame(captureRaf);
  captureRaf = 0;
  ro?.disconnect();
  ro = null;
});

// ---------------- 对外滚动 API（与旧版逐字兼容） ----------------

/** 滚到底（消息列表跟底、日志自动滚底都用这一个）。 */
function scrollToBottom() {
  internal()?.scrollTo({ position: "bottom" });
}

/** 滚到顶。 */
function scrollToTop() {
  internal()?.scrollTo({ top: 0 });
}

/** 按像素滚动。 */
function scrollTo(options: { top?: number; left?: number; behavior?: ScrollBehavior }) {
  internal()?.scrollTo(options);
}

function scrollBy(options: { top?: number; left?: number; behavior?: ScrollBehavior }) {
  internal()?.scrollBy(options);
}

/** 内容尺寸异步变化后手动同步滑块（正常由 naive 的 ResizeObserver 自动处理）。 */
function sync() {
  internal()?.sync();
}

/** 当前是否贴底（容差内）。 */
function isAtBottom(tolerance = 2): boolean {
  const el = scrollElement();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance;
}

defineExpose({ scrollElement, scrollToBottom, scrollToTop, scrollTo, scrollBy, sync, isAtBottom });
</script>

<template>
  <NScrollbar
    ref="barRef"
    class="gosslan-os"
    :class="[`gosslan-os--${size}`, { 'is-scrolling': scrolling, 'gosslan-os--pads': hasPad }]"
    trigger="none"
    :theme-overrides="themeOverrides"
    :x-scrollable="axis === 'both'"
    :content-style="mergedContentStyle"
    :on-scroll="onScroll"
    @pointerdown.capture="onRailPointerDown"
  >
    <slot />
  </NScrollbar>
</template>
