<script setup lang="ts">
/**
 * 消息虚拟列表 —— **@tanstack/vue-virtual** 实现（2026-10-25 迁移）。
 *
 * 迁移前是手写的前缀和 + 二分 + 自建 ResizeObserver；现在几何、可视区间、
 * 动态行测量全部交给 TanStack，应用只保留"产品语义"：
 *   · `pinned`（是否贴底）/ 「回到最新」按钮 / 用户上滚豁免；
 *   · 切会话后的收敛窗口（避免测量风暴来回拽滚动条）；
 *   · 历史 prepend 的锚定（TanStack `anchorTo: "end"` 负责）；
 *   · 跳转落定（`scrollToIndex` 粗定位 + 真实 DOM 轮询校正）；
 *   · 滚动位置读取/恢复（`getScrollTop`/`scrollToOffset`，供会话切换）。
 *
 * 对外 API（props / emits / defineExpose）与迁移前**逐字相同**，ChatWindow 与
 * perf/vlist 不需要改调用点。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/vue-virtual";

const props = withDefaults(
  defineProps<{
    items: any[];
    estimateHeight: (item: any, index?: number) => number;
    overscan?: number;
    /** 切换会话（末条 key 变化）时是否自动贴底；未读跳转场景由父组件关掉，改走 scrollToIndex */
    autoScrollOnSwap?: boolean;
    /**
     * 布局签名（字号 / 主题等）。变化时清空测量缓存并重测：宽度/字体变了而继续用旧高度
     * 会让前插/跳转落到错位置。窗口宽度变化由容器 ResizeObserver 现读，不靠父组件传。
     */
    layoutKey?: string;
    /**
     * 作为**实时日志区域**播报（用户 2026-09-12 HIG 审查）：聊天列表的核心事件是
     * "来了新消息"，但本组件此前没有任何 live region ⇒ 读屏用户**完全听不到新消息**。
     * 打开后容器带 `role="log" aria-live="polite" aria-relevant="additions"`。
     */
    live?: boolean;
  }>(),
  { overscan: 6, autoScrollOnSwap: true, layoutKey: "", live: false },
);

const emit = defineEmits<{
  (e: "loadMore"): void;
  (e: "nearBottom", v: boolean): void;
}>();

const container = ref<HTMLElement | null>(null);

/** 消息身份：持久本地 id 优先；其次 msg_id；再次行 id。**绝不回退数组下标**。 */
function keyOf(it: any): string {
  return String(it?.local_id ?? it?.msg_id ?? it?.id ?? "");
}

/**
 * TanStack 的关键选项：
 * - `anchorTo: "end"`：count/edge key 变化时按"当前视口里那一条"重算偏移 ⇒
 *   历史 prepend 不再需要手写 `prevFirstKey`，且不会把用户正在读的那屏顶走。
 * - `followOnAppend: true`：只有**当前在底部**时才跟随追加；用户上滚后不会被抢。
 * - `measureElement` 默认按真实 border-box 高度测；这里换成"高度 <= 0 时不用 0 覆盖"
 *   的版本 —— 隐藏/未布局的行测到 0 会把后续 top 全塌到顶部。
 * - options 里显式读 `props.items`：数组被**同长度替换**时也要触发 setOptions，
 *   否则 anchor 逻辑看不到新的首尾 key。
 */
const virtualizer = useVirtualizer(
  computed(() => {
    void props.items;
    void props.items.length;
    void props.overscan;
    return {
      count: props.items.length,
      getScrollElement: () => container.value,
      estimateSize: (i: number) => props.estimateHeight(props.items[i], i),
      overscan: props.overscan,
      getItemKey: (i: number) => keyOf(props.items[i]),
      anchorTo: "end" as const,
      // 追加贴底由本组件的 `pinned`/`schedulePin` 独占：开着库的 follow 会在
      // 切会话/高度收敛期间再写一次 scrollTop，与自研收敛窗口抢滚动条。
      followOnAppend: false,
      indexAttribute: "data-index",
      // 把一帧内的多条 ResizeObserver 测量合并成一次更新：冷滚动时逐行首次测量
      // 会各 bump 一次版本、各触发一次整表测量重算（实测 1000 条冷滚 34 万次 estimate 调用）。
      useAnimationFrameWithResizeObserver: true,
      measureElement: (
        element: HTMLElement,
        entry: ResizeObserverEntry | undefined,
        instance: Virtualizer<HTMLElement, HTMLElement>,
      ): number => {
        const size =
          entry?.borderBoxSize?.[0]?.blockSize ??
          element.getBoundingClientRect().height;
        const raw = Number(element.getAttribute("data-index"));
        const index = Number.isFinite(raw) ? raw : 0;
        const key = keyOf(props.items[index]);
        const prev = instance.itemSizeCache.get(key);
        if (!Number.isFinite(size) || size <= 0) {
          // 隐藏 / 未布局：保留上一次实测或估算值，绝不把 0 写进测量表。
          if (typeof prev === "number" && prev > 0) return prev;
          return props.estimateHeight(props.items[index], index);
        }
        // 与旧 `commitHeight` 同一口径：保留两位小数（半像素白线），但 <=1px 的变化不重排。
        // TanStack 默认对每次 RO 都写缓存 ⇒ 亚像素抖动会让 totalSize 每帧变一次，
        // 贴底态就会每帧重写 scrollTop（走查实测切会话出现 5 次方向反转）。
        const rounded = Math.round(size * 100) / 100;
        if (typeof prev === "number" && Math.abs(prev - rounded) <= 1) return prev;
        return rounded;
      },
    };
  }),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

/** 行测量入口：高度 <= 0 时不写缓存（隐藏/未布局）。 */
function measureRowRef(el: unknown) {
  if (!(el instanceof HTMLElement)) return;
  if (el.getBoundingClientRect().height <= 0) return;
  virtualizer.value.measureElement(el);
}

/** 滚出屏幕的行不再需要实测值：缓存超过上限就整体重测（按会话 × 1000 条留足余量）。 */
const MAX_MEASURED_KEYS = 6_000;
function boundMeasureCache() {
  if (virtualizer.value.itemSizeCache.size > MAX_MEASURED_KEYS) {
    virtualizer.value.measure();
  }
}

// ---------------- 滚动状态机（贴底 / 「回到最新」按钮 / 用户上滚豁免） ----------------
let raf = 0;
let pinned = true;
let prevScrollTop = 0;
let lastScrollUpAt = 0;
let suppressNearBottomUntil = 0;
let settleTimer = 0;
let pinHoldUntil = 0;
let pinHoldHardUntil = 0;
const SWAP_SETTLE_QUIET_MS = 120;
const SWAP_SETTLE_MAX_MS = 900;
let pinRaf = 0;
/** 置位：下一次 computeScrollState 把 scrollTop 下降视为程序化滚动，不计用户上滚。 */
let programmaticTop = false;

/** 距底部 150px 内视为底部：容忍高度估算与实测的抖动 */
const NEAR_BOTTOM_THRESHOLD = 150;

/** 近 ms 毫秒内用户是否向上滚动过（父组件贴底前应检查）。 */
function recentScrollUp(ms = 1200): boolean {
  return Date.now() - lastScrollUpAt < ms;
}

/**
 * "视口上方那一行变高"要不要自动补 scrollTop。
 *
 * 与 TanStack 默认规则同形（首次测量：top 在视口上方；重测：整行完全在视口上方），
 * 外加两条产品口径：用户刚上滚 1.2s 内不抢；贴底态交给 `schedulePin` 统一钉底。
 */
virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (
  item: VirtualItem,
  _delta: number,
  inst: Virtualizer<HTMLElement, HTMLElement>,
) => {
  if (recentScrollUp()) return false;
  if (pinned) return false;
  const offset = inst.scrollOffset ?? 0;
  const isFirstMeasure = !inst.itemSizeCache.has(item.key);
  if (isFirstMeasure) return item.start < offset;
  return item.start + item.size <= offset && inst.scrollDirection !== "backward";
};

/** 统一入口写 scrollTop：标记为程序化滚动，避免被当成用户上滚。 */
function setScrollTop(v: number) {
  const el = container.value;
  if (!el) return;
  programmaticTop = true;
  el.scrollTop = v;
}

function suppressTransient() {
  suppressNearBottomUntil = Math.max(suppressNearBottomUntil, Date.now() + 300);
}

/**
 * 收敛窗口：切换会话后不逐次贴底，等高度安静下来再统一贴一次。
 * 用户 2026-10-22 实测：切到群聊时滚动区小幅快速抖动一阵才停。
 */
function armSettleHold() {
  const now = Date.now();
  if (!pinHoldHardUntil) pinHoldHardUntil = now + SWAP_SETTLE_MAX_MS;
  pinHoldUntil = Math.min(pinHoldHardUntil, now + SWAP_SETTLE_QUIET_MS);
  if (settleTimer) {
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  }
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    pinHoldUntil = 0;
    pinHoldHardUntil = 0;
    // 收口这一刻同时结束瞬态窗口：否则 computeScrollState 会再排一个 pin 定时器，
    // 两个定时器各写一次 scrollTop（走查实测 1000 条切会话出现 5 次方向反转）。
    suppressNearBottomUntil = 0;
    pinToBottom();
    computeScrollState();
  }, Math.max(0, pinHoldUntil - now) + 16);
}

/** 贴底也按帧合并：一次重测风暴只写一次 scrollTop。 */
function schedulePin() {
  if (pinRaf) return;
  pinRaf = requestAnimationFrame(() => {
    pinRaf = 0;
    const el = container.value;
    if (!el) return;
    if (pinned && !recentScrollUp()) setScrollTop(el.scrollHeight);
    computeScrollState();
  });
}

/** 若处于贴底吸附态，把视口钉到当前真实底部。 */
function pinToBottom() {
  const el = container.value;
  if (el && pinned && !recentScrollUp()) setScrollTop(el.scrollHeight);
}

function computeScrollState() {
  const el = container.value;
  if (!el) return;
  const settling = Date.now() < suppressNearBottomUntil;
  if (!programmaticTop && el.scrollTop < prevScrollTop - 1) lastScrollUpAt = Date.now();
  programmaticTop = false;
  prevScrollTop = el.scrollTop;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
  if (settling) {
    // 收敛窗口由 `armSettleHold` 独占收口；只有"没有 settle 窗口"的瞬态
    //（scrollToBottom / scrollToIndex / resize）才在这里补一个定时器。
    if (!settleTimer && !pinHoldUntil) {
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        pinHoldUntil = 0;
        pinHoldHardUntil = 0;
        suppressNearBottomUntil = 0;
        pinToBottom();
        computeScrollState();
      }, suppressNearBottomUntil - Date.now() + 30);
    }
    return;
  }
  if (nearBottom !== pinned) {
    pinned = nearBottom;
    emit("nearBottom", pinned);
  }
  if (el.scrollTop < 60) emit("loadMore");
}

function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    computeScrollState();
  });
}

/**
 * 真实用户输入 ⇒ 放弃"待落定"。判据必须是输入事件而不是 scroll：
 * 程序化滚动也会触发 scroll，用 scroll 判断会把自动位移当成用户滚动。
 */
function onUserInput() {
  if (pendingJump) pendingJump = null;
}

function onResize() {
  suppressTransient();
  computeScrollState();
}

// ---------------- 定位 ----------------
function scrollToBottom() {
  const el = container.value;
  if (!el) return;
  if (!pinned) {
    pinned = true;
    emit("nearBottom", true);
  }
  suppressTransient();
  // 收敛窗口内（切会话后的测量风暴）把贴底交给 settleTimer 统一做一次；
  // 父组件在 nextTick 后补的那一次也走这里，避免与实测修正各写一次。
  if (Date.now() < pinHoldUntil) {
    armSettleHold();
    return;
  }
  setScrollTop(el.scrollHeight);
}

/**
 * 「跳到指定消息」的待落定状态：先按虚拟器粗定位，再按真实 DOM 位置轮询校正。
 * 待落定记 **key** 而不是下标（prepend 会让下标整体位移）。
 */
let pendingJump: { key: string; align: "top" | "bottom"; tries: number; until: number } | null =
  null;
let jumpTimer = 0;

function pollJump() {
  if (jumpTimer) return;
  jumpTimer = window.setInterval(() => {
    if (!pendingJump) {
      window.clearInterval(jumpTimer);
      jumpTimer = 0;
      return;
    }
    applyJump();
  }, 100);
}

function applyJump() {
  const j = pendingJump;
  const el = container.value;
  if (!j || !el) return;
  if (Date.now() > j.until) {
    pendingJump = null;
    return;
  }
  const node = el.querySelector<HTMLElement>(`[data-vlist-key="${CSS.escape(j.key)}"]`);
  if (!node) return;
  const cRect = el.getBoundingClientRect();
  const nRect = node.getBoundingClientRect();
  const desiredTop =
    j.align === "top" ? cRect.top + 8 : cRect.top + el.clientHeight - nRect.height - 8;
  const delta = nRect.top - desiredTop;
  if (Math.abs(delta) < 0.5) return;
  setScrollTop(Math.max(0, el.scrollTop + delta));
  computeScrollState();
  j.tries += 1;
  if (j.tries > 10) pendingJump = null;
}

function scrollToIndex(index: number, align: "top" | "bottom" = "top") {
  const el = container.value;
  if (!el || props.items.length === 0) return;
  if (pinned) {
    pinned = false;
    emit("nearBottom", false);
  }
  suppressTransient();
  const i = Math.max(0, Math.min(index, props.items.length - 1));
  pendingJump = {
    key: keyOf(props.items[i]),
    align,
    tries: 0,
    until: Date.now() + 1500,
  };
  virtualizer.value.scrollToIndex(i, {
    align: align === "bottom" ? "end" : "start",
    behavior: "instant",
  });
  void nextTick(() => applyJump());
  pollJump();
}

// ---------------- 数据变化 ----------------
let prevLastKey: string | null = null;
let prevFirstKey: string | null = null;
/** 上一次用于判"布局宽度变了"的 clientWidth；首帧初始化，滚动条出现/消失（~15px）不算。 */
let lastWidth = 0;

function onItemsChanged() {
  suppressTransient();
  // 收敛窗口内**任何** items 变化都顺延（不只是"末条 key 变了"）：切会话后的测量风暴
  // 常常伴随父组件连续替换数组；漏掉这一条，120ms 安静期会在风暴中途结束、随后逐次贴底。
  if (Date.now() < pinHoldHardUntil) armSettleHold();
  const arr = props.items;
  const newFirstKey = arr.length > 0 ? keyOf(arr[0]) : null;
  const newLastKey = arr.length > 0 ? keyOf(arr[arr.length - 1]) : null;
  const isSwap =
    prevLastKey !== null && newLastKey !== null && newLastKey !== prevLastKey;
  // **整会话切换**（首尾 key 都变了）与**底部追加**（只有末条变）分开：
  // 追加要立刻贴底；整会话切换要等测量风暴收敛后统一贴一次，否则立即贴底那一帧
  // 与随后的实测修正各写一次 scrollTop，表现为切会话后十几像素的来回抖。
  const isFullSwap =
    isSwap && prevFirstKey !== null && newFirstKey !== null && newFirstKey !== prevFirstKey;
  if (isSwap && !pinned) {
    pinned = true;
    emit("nearBottom", true);
  }
  if (isFullSwap) {
    // 换数据会让 scrollTop 被浏览器/新内容重置；那一次下降不是用户上滚，
    // 否则 `recentScrollUp()` 会拦住收敛窗口结束时的贴底（实测 finalTop 停在 0）。
    programmaticTop = true;
    lastScrollUpAt = 0;
  }
  prevFirstKey = newFirstKey;
  prevLastKey = newLastKey;
  boundMeasureCache();
  if (isSwap && props.autoScrollOnSwap) {
    armSettleHold();
    if (!isFullSwap) {
      void nextTick(() => {
        const el = container.value;
        if (!el) return;
        suppressTransient();
        setScrollTop(el.scrollHeight);
        computeScrollState();
      });
    }
  }
}

// **pre-flush** 先立收敛窗口：`onItemsChanged` 是 post，而 `watch(totalSize)` 在渲染期就会跑；
// 只靠 post 钩子的话，换会话那一帧会先被 totalSize 的贴底写一次（实测 4502→4607），
// 随后实测修正再写一次 ⇒ 十几像素的来回抖。
watch(
  () => props.items,
  (arr) => {
    if (Date.now() < pinHoldHardUntil) {
      // 收敛窗口内任何 items 变化都顺延（换会话后的分批实测、父组件连续替换数组）。
      armSettleHold();
      return;
    }
    if (prevFirstKey === null || prevLastKey === null) return;
    const first = arr.length > 0 ? keyOf(arr[0]) : null;
    const last = arr.length > 0 ? keyOf(arr[arr.length - 1]) : null;
    if (first && last && first !== prevFirstKey && last !== prevLastKey) {
      armSettleHold();
      programmaticTop = true;
      lastScrollUpAt = 0;
    }
  },
  { flush: "pre" },
);

watch(() => props.items, onItemsChanged, { flush: "post" });

// 布局签名（字号/主题）变化：清测量缓存，下一次渲染重新实测。
watch(
  () => props.layoutKey,
  () => {
    suppressTransient();
    virtualizer.value.measure();
  },
  { flush: "post" },
);

// 总高度变化（实测修正估算 / 追加消息）后：贴底态钉住。
watch(totalSize, () => {
  if (Date.now() < pinHoldUntil) {
    armSettleHold();
    return;
  }
  schedulePin();
});

/** 外部显式设定贴底态（未读跳转/引用定位后置 false，点击回到最新置 true）。 */
function setPinned(v: boolean) {
  pinned = v;
  emit("nearBottom", pinned);
}

function getScrollTop(): number {
  return container.value?.scrollTop ?? 0;
}

function scrollToOffset(offset: number) {
  const el = container.value;
  if (!el) return;
  suppressTransient();
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  setScrollTop(Math.min(Math.max(0, offset), max));
  computeScrollState();
}

/**
 * 窗口 resize 才清测量缓存（字体/主题由 `layoutKey` 管）。
 *
 * ⚠️ **不能**把 `measure()` 挂在容器 RO 的宽度变化上：内容变高/变矮会让滚动条出现或消失，
 * clientWidth 随之变化 ⇒ 清缓存 ⇒ 高度重估 ⇒ 滚动条再变，形成 18px 级抖动环
 * （走查实测切会话出现 5 次方向反转）。容器 RO 只负责 nearBottom。
 */
function onWindowResize() {
  suppressTransient();
  virtualizer.value.measure();
  computeScrollState();
}
useEventListener(window, "resize", onWindowResize);

/** 容器尺寸：只补 nearBottom/瞬态（宽度失效由 window resize 负责）。隐藏时 clientHeight=0 不处理。 */
let containerResizeObserver: ResizeObserver | null = null;
function observeContainerSize() {
  const el = container.value;
  if (!el) return;
  containerResizeObserver?.disconnect();
  containerResizeObserver = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w > 0) {
      if (lastWidth === 0) {
        lastWidth = w;
      } else if (Math.abs(w - lastWidth) > 24) {
        // 面板开合/侧栏折叠这类真实布局变化（>24px）才清测量缓存；
        // 滚动条出现/消失只差 ~15px，清缓存会形成"高度↔滚动条"反馈环（实测 5 次反转）。
        lastWidth = w;
        virtualizer.value.measure();
      }
    }
    if (el.clientHeight > 0) onResize();
  });
  containerResizeObserver.observe(el);
}

onMounted(() => {
  prevFirstKey = props.items.length > 0 ? keyOf(props.items[0]) : null;
  prevLastKey = props.items.length > 0 ? keyOf(props.items[props.items.length - 1]) : null;
  const el0 = container.value;
  if (el0) lastWidth = el0.clientWidth;
  onResize();
  observeContainerSize();
  computeScrollState();
});

onBeforeUnmount(() => {
  containerResizeObserver?.disconnect();
  containerResizeObserver = null;
  if (raf) cancelAnimationFrame(raf);
  if (settleTimer) window.clearTimeout(settleTimer);
  if (pinRaf) cancelAnimationFrame(pinRaf);
  if (jumpTimer) {
    window.clearInterval(jumpTimer);
    jumpTimer = 0;
  }
});

defineExpose({ scrollToBottom, scrollToIndex, recentScrollUp, setPinned, getScrollTop, scrollToOffset });
</script>

<template>
  <div
    ref="container"
    class="vlist-no-anchor h-full overflow-y-auto overflow-x-hidden pb-6"
    :role="live ? 'log' : undefined"
    :aria-live="live ? 'polite' : undefined"
    :aria-relevant="live ? 'additions' : undefined"
    @scroll.passive="onScroll"
    @wheel.passive="onUserInput"
    @touchstart.passive="onUserInput"
    @pointerdown.passive="onUserInput"
  >
    <div :style="{ height: `${totalSize}px`, position: 'relative' }">
      <div
        v-for="v in virtualItems"
        :key="String(v.key)"
        :data-index="v.index"
        :data-vlist-index="v.index"
        :data-vlist-key="keyOf(items[v.index])"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          transform: `translateY(${v.start}px)`,
        }"
        :ref="measureRowRef"
      >
        <slot :item="items[v.index]" :index="v.index" />
      </div>
    </div>
  </div>
</template>
