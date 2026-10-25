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
import { classifyItemsChange } from "@/utils/scrollIntent";
import { computeListBuffer } from "@/utils/listBuffer";

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
     * 当前会话的稳定标识（ChatWindow 传 `activeConv`）。
     *
     * 这是"切会话"的**唯一判据**：此前用"末条 key 变了"代替，结果把「末尾追加一条新消息」
     * 也当成切会话 ⇒ 用户读历史时被一帧拽到底部（2026-10-25 P0，实测 +70,702px）。
     * 同一会话内的整表刷新（重连/重载）不算切换，锚点由 TanStack 保留。
     */
    conversationKey?: string;
    /**
     * 作为**实时日志区域**播报（用户 2026-09-12 HIG 审查）：聊天列表的核心事件是
     * "来了新消息"，但本组件此前没有任何 live region ⇒ 读屏用户**完全听不到新消息**。
     * 打开后容器带 `role="log" aria-live="polite" aria-relevant="additions"`。
     */
    live?: boolean;
  }>(),
  { overscan: 6, autoScrollOnSwap: true, layoutKey: "", conversationKey: "", live: false },
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

// ---------------- 自适应缓冲（范围扩展器，O(1)） ----------------
//
// 为什么不是"把 overscan 调大"：条目数缓冲在长行/短行混合时与像素脱钩。
// 实测 400px/帧时 overscan=6 有 45/90 帧白带，overscan=36 才能归零；但同样 36 在
// 800px/帧时把 DOM 拉到 81 行、p95 97ms、单帧 700ms（更差）。⇒ 按速度/视口/平均行高算，
// 并且有硬上限；方向优先给前进侧。
const edgeBuffer = { forward: 0, backward: 0 };
/**
 * 是否把 RO 测量合到一帧：**只在切会话的收敛窗口内**为 true。
 * 平时 false（逐条、绘制前测量）——贴底时也要逐条，否则"加表情先掉 40px 再弹回"
 * （scrollreact 的 8 帧判据就是抓这个）。
 * 必须在 `useVirtualizer` **之前**声明：options 的 computed 在 setup 阶段就会求值，
 * 引用后面才 `let` 的变量会直接 TDZ。
 */
let roBatched = false;
let velocity = 0;
let lastVelocityTop = 0;
let velocityReady = false;

/** 非响应式：TanStack 在 range 变化时会重新调用它，读到的是本帧最新值。 */
function rangeExtractor(range: {
  startIndex: number;
  endIndex: number;
  count: number;
  overscan: number;
  lanes?: number;
}): number[] {
  // ⚠️ 自定义 extractor **替换**库的默认实现，默认里那份 `overscan` 必须自己补回来：
  // 漏了它等于 overscan=0（实测：首帧只有 11 行、200px/帧时白带 16/90）。
  const base = range.overscan * Math.max(range.lanes ?? 1, 1);
  const start = Math.max(0, range.startIndex - base - edgeBuffer.backward);
  const end = Math.min(range.count - 1, range.endIndex + base + edgeBuffer.forward);
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** 每帧只做一次 O(1) 算术；绝不在滚动处理器里遍历条目。 */
function updateBufferFromScroll(top: number) {
  const el = container.value;
  if (!el) return;
  const delta = top - lastVelocityTop;
  lastVelocityTop = top;
  // 一次超过两屏的位移是跳转（原生恢复 / 外部写 scrollTop），不是甩动：
  // 把 7 万 px 当成速度会让缓冲瞬间顶到上限并一直留着一屏多余的行。
  velocity = Math.abs(delta) > el.clientHeight * 2 ? 0 : velocity * 0.55 + delta * 0.45;
  const total = virtualizer.value.getTotalSize();
  const avg = props.items.length > 0 ? total / props.items.length : 0;
  const next = computeListBuffer({
    viewport: el.clientHeight,
    velocity,
    avgRow: avg,
    overscan: props.overscan,
  });
  if (next.forward !== edgeBuffer.forward || next.backward !== edgeBuffer.backward) {
    edgeBuffer.forward = next.forward;
    edgeBuffer.backward = next.backward;
  }
}

/** 程序化跳转/换会话后速度必须归零，否则会拿上一段的甩动速度去预渲染一大片。 */
function resetBuffer() {
  velocity = 0;
  velocityReady = false;
  lastVelocityTop = container.value?.scrollTop ?? 0;
  edgeBuffer.forward = 0;
  edgeBuffer.backward = 0;
}

/** 收敛窗口内合批测量；窗口结束恢复逐条（绘制前）。 */
function setRoBatched(next: boolean) {
  if (roBatched === next) return;
  roBatched = next;
  const v = virtualizer.value;
  if (v) v.options.useAnimationFrameWithResizeObserver = next;
}

/**
 * TanStack 的关键选项：
 * - `anchorTo: "end"`：count/edge key 变化时按"当前视口里那一条"重算偏移 ⇒
 *   历史 prepend 不再需要手写 `prevFirstKey`，且不会把用户正在读的那屏顶走。
 * - `followOnAppend: false`：追加贴底由本组件的 `pinned`/`schedulePin` 独占（用户上滚后不被抢）；
 *   实测回调里还会按总高增量同步跟一次（见 `measureElement`），避免贴底晚一帧。
 * - `rangeExtractor`：按速度/视口/平均行高扩展预渲染范围（见 `edgeBuffer`），替代固定条目 overscan。
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
      rangeExtractor,
      getItemKey: (i: number) => keyOf(props.items[i]),
      anchorTo: "end" as const,
      // 追加贴底由本组件的 `pinned`/`schedulePin` 独占：开着库的 follow 会在
      // 切会话/高度收敛期间再写一次 scrollTop，与自研收敛窗口抢滚动条。
      followOnAppend: false,
      // `anchorTo:"end"` 还带一条"在底部时每次实测都按总高度增量同步写 scrollTop"的路径；
      // 它按**每次 RO 条目**各写一次，切会话/图片改高时 6 条实测就是 6 次方向相反的写入
      // （探针实测 reversals 5，阈值 3）。把阈值设成 -1 关掉这条路径：贴底由本组件的
      // `measureElement`（同步跟 delta）+ `schedulePin`（rAF 兜底）负责 —— 单一所有者，
      // 也仍然保留 prepend 的按键锚定。
      scrollEndThreshold: -1,
      indexAttribute: "data-index",
      // 平时 false：RO 在**绘制前**逐条测，避免"先按估算画一帧"的白带
      // （实测 400px/帧 45/90 → 19/90，800px/帧 83/90 → 33/90）。
      // 只在切会话的收敛窗口内由 `setRoBatched(true)` 合批：那一阵有 6+ 条实测同时到达，
      // 逐条写 scrollTop 会出现方向反转（vlist 探针 reversals 5，阈值 3）；安静后恢复逐条。
      useAnimationFrameWithResizeObserver: roBatched,
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
        // 贴底态的**同步**跟随：RO 回调发生在布局后、绘制前；此刻写 scrollTop 增量，
        // 这一帧就是贴着底的。交给 `schedulePin`（rAF）会晚一帧 —— scrollreact 实测
        // 首帧 gap 40px（用户看到的就是"加表情先掉一下再弹回"）。
        // 只跟总高度增量，不重写 scrollHeight：Vue 还没把新总高 patch 上去。
        if (pinned && !recentScrollUp() && Date.now() >= pinHoldUntil) {
          const oldSize = typeof prev === "number" ? prev : props.estimateHeight(props.items[index], index);
          const delta = rounded - oldSize;
          const el = container.value;
          if (el && Math.abs(delta) > 0.5) setScrollTop(el.scrollTop + delta);
        }
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
  // 贴底由 measureElement 的同步增量负责（避免和库各写一次）。
  if (pinned) return false;
  const offset = inst.scrollOffset ?? 0;
  const isFirstMeasure = !inst.itemSizeCache.has(item.key);
  // **整行完全在视口上方**才补：这是"读着读着，上面一张图变高/变矮"的正解。
  // 不能再加 `recentScrollUp()` 一票否决 —— 上翻时上方行变高同样会把正在读的内容推走
  // （scrollreact 实测参照行位移 40px）；跨视口上沿的行（内容在锚点下方变化）仍然不补。
  if (isFirstMeasure) return item.start < offset;
  return item.start + item.size <= offset;
};

/** 统一入口写 scrollTop：标记为程序化滚动，避免被当成用户上滚。 */
function setScrollTop(v: number) {
  const el = container.value;
  if (!el) return;
  programmaticTop = true;
  el.scrollTop = v;
}

/**
 * 贴底态切换的**唯一出口**：同步 `nearBottom`，并切换 RO 测量批次策略。
 * - 阅读（false）：逐条、绘制前测量 ⇒ 不给"估算高度"任何被画出去的机会；
 * - 贴底（true）：一帧合批 ⇒ 多条实测不会在同一帧里来回改 scrollTop。
 * 直接改运行时 options（库在 RO 回调里现读），不重建虚拟器、不触发 anchor 重算。
 */
function setPinning(next: boolean) {
  if (pinned === next) return;
  pinned = next;
  emit("nearBottom", next);
}

function suppressTransient() {
  suppressNearBottomUntil = Math.max(suppressNearBottomUntil, Date.now() + 300);
}

/**
 * 收敛窗口：切换会话后不逐次贴底，等高度安静下来再统一贴一次。
 * 用户 2026-10-22 实测：切到群聊时滚动区小幅快速抖动一阵才停。
 */
function armSettleHold() {
  setRoBatched(true);
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
    // 窗口结束：恢复逐条测量（绘制前），再按当前几何/上滚记录决定贴底。
    // 顺序是语义：先按当前几何/上滚记录更新 pinned，再决定要不要贴底。
    // 反过来会在"用户已在静默期上翻"时用旧的 pinned=true 抢回滚动条。
    setRoBatched(false);
    computeScrollState();
    pinToBottom();
  }, Math.max(0, pinHoldUntil - now) + 16);
}

/** 贴底也按帧合并：一次重测风暴只写一次 scrollTop。 */
function schedulePin() {
  if (pinRaf) return;
  pinRaf = requestAnimationFrame(() => {
    pinRaf = 0;
    const el = container.value;
    if (!el) return;
    if (el.scrollTop < prevScrollTop - 1 && !programmaticTop) {
      lastScrollUpAt = Date.now();
      setPinning(false);
      computeScrollState();
      return;
    }
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
  const top = el.scrollTop;
  if (!velocityReady) {
    lastVelocityTop = top;
    velocityReady = true;
  } else if (top !== lastVelocityTop) {
    updateBufferFromScroll(top);
  }
  if (!programmaticTop && el.scrollTop < prevScrollTop - 1) {
    lastScrollUpAt = Date.now();
    // ⚠️ 静默期也必须立刻解除吸附：否则用户在上翻、而 settleTimer 到期时
    // `pinToBottom()` 还会按"旧的 pinned=true"把人拽回底部（2026-10-25 实测：
    // 扫描页在 settle 窗口内滚到 10% 被一帧拉回底部，整轮读数作废）。
    setPinning(false);
  }
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
        computeScrollState();
        pinToBottom();
      }, suppressNearBottomUntil - Date.now() + 30);
    }
    return;
  }
  if (nearBottom !== pinned) setPinning(nearBottom);
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
  setPinning(true);
  suppressTransient();
  // 收敛窗口内（切会话后的测量风暴）把贴底交给 settleTimer 统一做一次；
  // 父组件在 nextTick 后补的那一次也走这里，避免与实测修正各写一次。
  if (Date.now() < pinHoldUntil) {
    armSettleHold();
    return;
  }
  resetBuffer();
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
  setPinning(false);
  suppressTransient();
  const i = Math.max(0, Math.min(index, props.items.length - 1));
  resetBuffer();
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
let prevEdges: { first: string; last: string } | null = null;
/** 上一次 items 变化时属于哪个会话（切会话检测，见 `conversationKey`）。 */
let prevItemsConv: string | null = null;
/** 上一次用于判"布局宽度变了"的 clientWidth；首帧初始化，滚动条出现/消失（~15px）不算。 */
let lastWidth = 0;

let keysCacheArr: any[] | null = null;
let keysCache: string[] = [];
function keysOfItems(): string[] {
  const arr = props.items;
  if (arr === keysCacheArr) return keysCache;
  const out = new Array<string>(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = keyOf(arr[i]);
  keysCacheArr = arr;
  keysCache = out;
  return out;
}

function onItemsChanged() {
  suppressTransient();
  // 收敛窗口内**任何** items 变化都顺延：切会话后的测量风暴常常伴随父组件连续替换数组；
  // 漏掉这一条，120ms 安静期会在风暴中途结束、随后逐次贴底。
  if (Date.now() < pinHoldHardUntil) armSettleHold();
  const keys = keysOfItems();
  const change = classifyItemsChange(prevEdges, keys);
  prevEdges = keys.length > 0 ? { first: keys[0], last: keys[keys.length - 1] } : null;
  boundMeasureCache();

  const conv = props.conversationKey ?? "";
  const convSwitch = prevItemsConv !== null && prevItemsConv !== "" && conv !== prevItemsConv;
  prevItemsConv = conv;

  if (convSwitch) {
    // 切会话是**唯一**允许重置贴底意图的时机。autoScrollOnSwap=false 的两种调用
    // （恢复上次位置 / 未读跳转）保持 pinned=false，由父组件的 scrollToOffset/scrollToIndex 落位。
    setPinning(props.autoScrollOnSwap);
    pendingJump = null;
    if (jumpTimer) {
      window.clearInterval(jumpTimer);
      jumpTimer = 0;
    }
    resetBuffer();
    programmaticTop = true;
    lastScrollUpAt = 0;
    if (props.autoScrollOnSwap) armSettleHold();
    return;
  }

  // 追加 / 前插 / 同会话整表刷新：**一律不重写 pinned、不贴底**。
  // 追加贴底只由 ChatWindow 的 `(isMine || nearBottom) && !recentScrollUp()` 决定；
  // 已在底部的会话由 `watch(totalSize)` → `schedulePin()` 跟随（pinned 仍为真）。
  // 这里只留一条"同会话整替换需要顺延收敛窗口"的防御：测量风暴期间不要逐次贴底。
  if (change.kind === "swap" && Date.now() < pinHoldHardUntil) armSettleHold();
}

// **pre-flush** 先立收敛窗口：`onItemsChanged` 是 post，而 `watch(totalSize)` 在渲染期就会跑；
// 只靠 post 钩子的话，换会话那一帧会先被 totalSize 的贴底写一次（实测 4502→4607），
// 随后实测修正再写一次 ⇒ 十几像素的来回抖。
watch(
  () => props.items,
  (arr) => {
    if (Date.now() < pinHoldHardUntil) {
      armSettleHold();
      return;
    }
    if (!prevEdges) return;
    const keys = arr === keysCacheArr ? keysCache : arr.map(keyOf);
    if (classifyItemsChange(prevEdges, keys).kind === "swap") {
      // 同会话重载也可能走到这里；真正"切会话"由 onItemsChanged 的 conversationKey 判定。
      programmaticTop = true;
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
  setPinning(v);
}

function getScrollTop(): number {
  return container.value?.scrollTop ?? 0;
}

function scrollToOffset(offset: number) {
  const el = container.value;
  if (!el) return;
  suppressTransient();
  resetBuffer();
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
  prevEdges = props.items.length > 0
    ? { first: keyOf(props.items[0]), last: keyOf(props.items[props.items.length - 1]) }
    : null;
  prevItemsConv = props.conversationKey ?? "";
  const el0 = container.value;
  if (el0) lastWidth = el0.clientWidth;
  resetBuffer();
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
