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
import { scrollbarAutoHide } from "@/utils/platform";

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
     * 何时显示滚动条。**不传时按平台给默认值**（`utils/platform.ts` 的
     * `scrollbarAutoHide`）：
     *
     * · Windows 默认 `never`（**常驻**）—— 2026-11-25 用户实报「Windows 上滚动条直接
     *   没了」：原生条被归零、自绘条又要指针移动才出现 ⇒ 静止时两条都没有。Windows 的
     *   惯例本来就是常驻（资源管理器 / VS Code），常驻态用更淡的 `-idle` 令牌；
     * · 其余平台默认 `move`：**滚动或指针在容器内移动**时出现，停手 `hideDelay` 后淡出
     *   —— 同时满足"hover 才显"和"idle 隐藏"（v2 文档原文：hidden unless the pointer
     *   moves in the host element **or** the user scrolls）；
     * · `leave`：指针停在容器里就一直显示（macOS 原生那种，长时间阅读会常驻）；
     * · `scroll`：只有滚动才显示（微信 PC 的旧口径，hover 不出）；
     *
     * 显式传值一律优先于平台默认（例如某个面板就是要常驻/就是要更安静）。
     */
    autoHide?: "move" | "scroll" | "leave" | "never";
    /**
     * 滑块粗细分档（用户 2026-11-20：「滚动把手宽度可以按照业务不同粗细不同」）。
     * · `thick`（12px 带）：主内容区 —— 会话列表 / 消息列表（拖得动最重要）；
     * · `normal`（10px 带）：内容页 —— 设置 / 日志 / 任务详情；
     * · `thin`（8px 带）：弹窗里的小列表、表情面板、代码气泡。
     */
    size?: "thin" | "normal" | "thick";
    /** 停手多久后淡出（ms）。 */
    hideDelay?: number;
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
  { axis: "y", size: "normal", hideDelay: 1200 },
);

const emit = defineEmits<{ (e: "scroll"): void }>();

const host = ref<HTMLElement | null>(null);
const instance = shallowRef<ReturnType<typeof OverlayScrollbars> | null>(null);
/** 原生 scroll 监听器要能解绑，且 scroll **不冒泡** ⇒ 只能挂在 viewport 上自己转发。 */
let detachScroll: (() => void) | null = null;

/**
 * 显式传入优先，否则用平台默认（Windows 常驻 / 其余 hover 才显）。
 * 为什么要一个变量而不是直接写进 options：模板也要用它决定 `gosslan-os--persistent`，
 * 而那个类名决定滑块用哪一档颜色（常驻必须更淡，见 `style.css`）。
 */
const effectiveAutoHide = props.autoHide ?? scrollbarAutoHide;

const options: PartialOptions = {
  scrollbars: {
    theme: "os-theme-gosslan",
    autoHide: effectiveAutoHide,
    autoHideDelay: props.hideDelay,
    // 默认 true 时"第一次滚动之前不让出现"，会把 hover 显现也一起压掉。
    autoHideSuspend: false,
    clickScroll: true,
  },
  overflow: { x: props.axis === "both" ? "scroll" : "hidden", y: "scroll" },
};

onMounted(() => {
  if (!host.value) return;
  instance.value = OverlayScrollbars(host.value, options);
  const viewport = instance.value.elements().viewport;
  // 无障碍属性搬到底层滚动根（见 props 注释）。
  if (props.role) viewport.setAttribute("role", props.role);
  if (props.ariaLive) viewport.setAttribute("aria-live", props.ariaLive);
  if (props.ariaRelevant) viewport.setAttribute("aria-relevant", props.ariaRelevant);
  const onScroll = () => emit("scroll");
  viewport.addEventListener("scroll", onScroll, { passive: true });
  detachScroll = () => viewport.removeEventListener("scroll", onScroll);
});

onBeforeUnmount(() => {
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
  <div
    ref="host"
    class="gosslan-os min-h-0"
    :class="[`gosslan-os--${size}`, { 'gosslan-os--persistent': effectiveAutoHide === 'never' }]"
  >
    <div class="gosslan-os-wrap">
      <slot />
    </div>
  </div>
</template>
