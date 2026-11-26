<script setup lang="ts">
/**
 * 统一滚动容器（OverlayScrollbars v2 封装，2026-11-20）。
 *
 * 为什么统一：用户要求"轨道完全不可见、hover 才显、idle 隐藏、且不占布局宽度"。
 * 最后一条是硬约束 —— 原生 `scrollbar-gutter: stable` 会给滚动条留 8px 布局宽度，
 * 输入卡与消息列表的右边距因此永远差 8px。true overlay 不占位，三边距才可能相等。
 *
 * ⚠️ 接线纪律（迁移期间）：
 * 1. 读滚动几何用 `scrollElement()`（= OS 的 viewport，**不是** host：host 自己不滚）；
 *    写位置用 `scrollTo()`/`scrollToBottom()`；
 * 2. 不要在 host 上再写 `overflow-y-auto`：OS 会接管，双份滚动条是必然的；
 * 3. 轨道默认完全透明，只有 `.os-scrollbar-visible` 期间才画（样式在 `style.css`
 *    的 `.os-theme-gosslan` 段，颜色全部走语义令牌，不写死色值）。
 *
 * ── 为什么中间有一层 `gosslan-os-wrap`（别删）──────────────────────────────
 * OS v2 会把 host 的现有子节点**搬进**它新建的 viewport。Vue 的 patch 容器是
 * "组件根元素"（host），而新插入的节点会被 `insertBefore(新节点, 视口内的兄弟节点)`
 * 送到 host 上 —— 跨父节点锚点直接抛 `NotFoundError`（2026-11-20 真浏览器实测），
 * 而且即便不抛也会落在视口外被裁掉。所以插槽内容必须先落在一个**稳定**的包裹层里：
 * Vue 只在包裹层内部做增删，包裹层自身不参与布局。
 *
 * 包裹层是**有盒子的真块**（`display: flex; flex-direction: column; min-height: 100%`）：
 *   ① OS 用它测内容高度（滑块行程 / 滚动范围都靠它）—— `display: contents` 的盒子是 0×0，
 *      内容异步变高时 OS 测不到 ⇒ 滑块行程停在旧值 ⇒「拖到底也到不了底」（2026-11-20 实测）；
 *   ② `min-height: 100%` 让短内容也撑满视口，空态不塌；里面的 `flex-1` 段（空态居中）有确定高度可分。
 * ⚠️ 代价：子元素的**百分比高度**（`min-h-full`）不再按视口解析 ⇒ 用 `flex-1` 代替（见会话列表空态）。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { ClickScrollPlugin, OverlayScrollbars, type PartialOptions } from "overlayscrollbars";

/**
 * 「点轨道翻页」由 `ClickScrollPlugin` 提供 —— `clickScroll: true` 只是它的**配置**，
 * 不注册这个插件，选项写了也不生效（2026-11-20 真浏览器实测：不注册时点轨道 scrollTop 纹丝不动，
 * 注册后一次点击正好翻一屏 400px）。
 * 注册是**静态**的（挂在库上，不是挂在实例上），所以在这里做一次即可。
 */
OverlayScrollbars.plugin(ClickScrollPlugin);

const props = withDefaults(
  defineProps<{
    /** 只在需要时滚动（默认 y）。x 轴一律 hidden：横向滚动条在这个产品里从来不该出现。 */
    axis?: "y" | "both";
    /**
     * 滑块粗细分档（用户 2026-11-20：「滚动把手宽度可以按照业务不同粗细不同」）。
     * · `thick`（12px 带）：主内容区 —— 会话列表 / 消息列表（拖得动最重要）；
     * · `normal`（10px 带）：内容页 —— 设置 / 日志 / 任务详情；
     * · `thin`（8px 带）：弹窗里的小列表、表情面板、代码气泡。
     */
    size?: "thin" | "normal" | "thick";
    /**
     * 无障碍属性：**落在真正滚动的元素上**（OS 建的 viewport），不是 host。
     *
     * 为什么不让它自然落到 host：`role="log"` / `aria-live` 说的是"这个区域的内容在变"，
     * 而滚动根就是 viewport。原先（原生滚动条时代）这三个属性就挂在滚动容器上，
     * 迁移后必须原样跟过去 —— 挂在 host 上虽然也能播报，但语义上"活的区域"变成了外层盒子。
     * 声明成 props 而不是留在 attrs 里，就是为了**不再**落到 host 上。
     */
    role?: string;
    ariaLive?: string;
    ariaRelevant?: string;
  }>(),
  { axis: "y", size: "normal" },
);

const emit = defineEmits<{ (e: "scroll"): void }>();const host = ref<HTMLElement | null>(null);
const instance = shallowRef<ReturnType<typeof OverlayScrollbars> | null>(null);
/** 原生 scroll 监听器要能解绑，且 scroll **不冒泡** ⇒ 只能挂在 viewport 上自己转发。 */
let detachScroll: (() => void) | null = null;
/** 内容高度变化的观察者（见 onMounted）。 */
let ro: ResizeObserver | null = null;

/**
 * 滚动条：**本组件自己画**（2026-11-26 定稿）。
 *
 * 为什么不再用 OverlayScrollbars 自带的条：三轮实修都卡在同一处 —— 条能不能看见，
 * 取决于库给 `.os-scrollbar` 加的一串类名（`os-scrollbar-visible` /
 * `os-scrollbar-auto-hide-hidden` …），而类名由库的 JS 状态机决定，还会被引擎差异
 * （Chromium 在 Windows 上默认 overlay 滚动条、WKWebView 画系统条）左右。结果是：
 * 同一份代码 mac 上"有"、Windows 上"没有"，我们能改的只有猜测。
 *
 * 现在把职责切开，两边都变简单：
 *   · **滚动**仍交给 OverlayScrollbars（原生滚动、尺寸测量、虚拟列表兼容都靠它）；
 *   · **条**由本组件用两个 div 画（`.gosslan-os-bar` + `-thumb`），实色、常驻、
 *     高度按 `clientHeight / scrollHeight` 算 —— 两端同一个 DOM、同一份 CSS，
 *     逐像素一致，且不依赖任何"库状态"。
 * 库自带的条用官方 `os-theme-none` 主题彻底隐藏（库 CSS 里有 `display:none !important`），
 * 不会出现"两套条"。
 *
 * 代价与边界（如实记着）：拖动手势、轨道点击是本组件实现的，换行/换库时要一起搬；
 * 只做垂直条（全站没有 `axis="both"` 的用法，真需要时再补水平条）。
 */
const options: PartialOptions = {
  scrollbars: {
    // 官方"无主题"：`display: none !important` ⇒ 库的条完全不参与视觉。
    theme: "os-theme-none",
    // 这两项对 none 主题已无视觉效果，留着是为了万一将来回退时行为可预期。
    autoHide: "never",
    autoHideSuspend: false,
    clickScroll: true,
  },
  overflow: { x: props.axis === "both" ? "scroll" : "hidden", y: "scroll" },
};

// ---------------- 自绘滚动条 ----------------

/** 轨道上下各留的空白（px）：滑块顶到底时不要贴死边角。 */
const BAR_INSET = 2;
/** 滑块最小高度（px）：太短就抓不住。 */
const MIN_THUMB = 24;

const barVisible = ref(false);
const thumbHeight = ref(0);
const thumbTop = ref(0);
/** scroll 事件很密，合并到一帧里算一次（避免每像素都触发 Vue 更新）。 */
let barRaf = 0;

/** 按当前滚动几何重算滑块的高度与位置。 */
function syncBar() {
  const vp = instance.value?.elements().viewport;
  const hostEl = host.value;
  if (!vp || !hostEl) return;
  const trackLen = hostEl.clientHeight - BAR_INSET * 2;
  const overflow = vp.scrollHeight - vp.clientHeight;
  // 内容不足一屏（或容器还没高度）⇒ 不画条。这是唯一"没有条"的情形，且它是正确的。
  if (trackLen <= 0 || overflow <= 1) {
    barVisible.value = false;
    return;
  }
  barVisible.value = true;
  const h = Math.max(MIN_THUMB, Math.round((trackLen * vp.clientHeight) / vp.scrollHeight));
  const maxTop = Math.max(0, trackLen - h);
  const top = Math.round((maxTop * vp.scrollTop) / overflow);
  thumbHeight.value = Math.min(h, trackLen);
  thumbTop.value = Math.max(0, Math.min(maxTop, top));
}

function scheduleSyncBar() {
  if (barRaf) return;
  barRaf = requestAnimationFrame(() => {
    barRaf = 0;
    syncBar();
  });
}

/** 拖滑块：1px 轨道位移对应 `overflow / maxTop` px 滚动。 */
function onThumbDown(e: PointerEvent) {
  const vp = instance.value?.elements().viewport;
  const hostEl = host.value;
  if (!vp || !hostEl) return;
  e.preventDefault();
  const trackLen = hostEl.clientHeight - BAR_INSET * 2;
  const overflow = vp.scrollHeight - vp.clientHeight;
  const maxTop = Math.max(1, trackLen - thumbHeight.value);
  const startY = e.clientY;
  const startScroll = vp.scrollTop;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    vp.scrollTop = startScroll + ((ev.clientY - startY) / maxTop) * overflow;
    scheduleSyncBar();
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

/** 点轨道：把该位置当成滑块中心，滚过去（macOS 的直觉，不是"翻一屏"）。 */
function onTrackDown(e: PointerEvent) {
  const vp = instance.value?.elements().viewport;
  if (!vp) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const overflow = vp.scrollHeight - vp.clientHeight;
  const maxTop = Math.max(1, rect.height - thumbHeight.value);
  const target = ((e.clientY - rect.top - thumbHeight.value / 2) / maxTop) * overflow;
  vp.scrollTo({ top: Math.max(0, Math.min(overflow, target)), behavior: "smooth" });
}

onMounted(() => {
  if (!host.value) return;
  instance.value = OverlayScrollbars(host.value, options);
  const viewport = instance.value.elements().viewport;
  // 无障碍属性搬到底层滚动根（见 props 注释）。
  if (props.role) viewport.setAttribute("role", props.role);
  if (props.ariaLive) viewport.setAttribute("aria-live", props.ariaLive);
  if (props.ariaRelevant) viewport.setAttribute("aria-relevant", props.ariaRelevant);
  const onScroll = () => {
    emit("scroll");
    scheduleSyncBar();
  };
  viewport.addEventListener("scroll", onScroll, { passive: true });
  detachScroll = () => viewport.removeEventListener("scroll", onScroll);
  // 内容高度会异步变（图片加载、异步列表、展开折叠）⇒ 用 ResizeObserver 跟住，
  // 只靠 scroll 事件会让滑块行程停在旧值上（"拖到底也到不了底"那类症状）。
  const wrap = host.value.querySelector(".gosslan-os-wrap");
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => scheduleSyncBar());
    ro.observe(viewport);
    if (wrap) ro.observe(wrap);
  }
  scheduleSyncBar();
});

onBeforeUnmount(() => {
  if (barRaf) cancelAnimationFrame(barRaf);
  barRaf = 0;
  ro?.disconnect();
  ro = null;
  detachScroll?.();
  detachScroll = null;
  instance.value?.destroy();
  instance.value = null;
});

/** 原生滚动元素（几何读取的唯一入口；写位置请走下面的方法）。 */
function scrollElement(): HTMLElement | null {
  return instance.value?.elements().viewport ?? null;
}

/** 滚到底（消息列表跟底、日志自动滚底都用这一个）。 */
function scrollToBottom() {
  instance.value?.elements().viewport.scrollTo({ top: Number.MAX_SAFE_INTEGER });
}

/** 当前是否贴底（容差内）。 */
function isAtBottom(tolerance = 2): boolean {
  const el = instance.value?.elements().viewport;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance;
}

defineExpose({ scrollElement, scrollToBottom, isAtBottom });
</script>

<template>
  <div ref="host" class="gosslan-os min-h-0" :class="`gosslan-os--${size}`">
    <div class="gosslan-os-wrap">
      <slot />
    </div>
    <!-- 自绘条：只画滑块，轨道透明（用户 2026-11-20「轨道不要能看见」）。
         结构固定为「轨道 div > 滑块 div」，样式在同名类里；两端同一份实现。 -->
    <div v-show="barVisible" class="gosslan-os-bar" @pointerdown="onTrackDown">
      <div
        class="gosslan-os-bar-thumb"
        :style="{ height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)` }"
        @pointerdown.stop="onThumbDown"
      />
    </div>
  </div>
</template>
