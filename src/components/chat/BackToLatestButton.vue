<script setup lang="ts">
/**
 * 「回到最新」悬浮圆钮（用户 2026-11-05：截图里它的 tooltip 正压在图片上）。
 *
 * 两条硬约束：
 *  ① **只覆盖按钮本体**：不挂 `tap-safe`，也没有 `::after` / `inset` 这类扩热区的写法。
 *     36×36 就是全部命中区 —— 用户点图片时不该打到它；
 *  ② **真正离底才可点**：`visible` 由 VirtualList 现算的几何间隙驱动
 *     （`utils/backToLatest.ts`），不贴底时 `pointer-events: none` + `opacity-0`
 *     + `aria-hidden` + `tabindex=-1`（鼠标/触屏/键盘三条路都进不来）。
 *
 * 出现时只播一次 fade（`style.css` 的 `.gosslan-back-to-latest`）；类名只在可见时挂上，
 * 所以每次"从无到有"才重播，可见状态内的重渲染不会重播。
 *
 * ③ **按压反馈必须自己带 `translate`**：全站 `:where(button…):active { transform: scale(.97) }`
 *    会把这里的 `-translate-x-1/2` 整个顶掉 ⇒ 按下瞬间按钮向右跳半个身位（18px），
 *    pointerup 落到下面的图片上，click 被派发到共同祖先 ⇒ `press` 丢事件（2026-11-05 实测）。
 *    `active:scale-[0.97]` 是 Tailwind 的**组合 transform**（含 `translate(var(--tw-translate-x)…)`），
 *    既保住水平居中又保留按下去的缩小反馈。
 *
 * ④ **不许压住时间/未读分割行**（2026-11-06 用户拍板）：`bottom-4` 是基准位，
 *    按钮可见时实测自己与可视区内 `[data-time-divider]` / `[data-unread-divider]` 的矩形，
 *    相交才按「行高 + 8px」上移（最多 3 步，见 `computeBackToLatestAvoidOffset`）；
 *    不相交就回到基准位 —— 绝不"永远抬高"去压消息正文。
 *    位移直接写 `bottom`，不新增 transition 属性/曲线。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ArrowDown } from "lucide-vue-next";
import { t } from "@/i18n";
import { computeBackToLatestAvoidOffset } from "@/utils/backToLatest";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: "press"): void }>();

const root = ref<HTMLButtonElement | null>(null);
const avoidOffset = ref(0);
let raf = 0;

/** 实测避让：基准位矩形 → 分割行矩形 → 需要上移多少。 */
function measure() {
  raf = 0;
  const btn = root.value;
  if (!btn || !props.visible) return;
  // `getBoundingClientRect` 读到的已经是"上移后"的位置；先把 offset 加回去，
  // 否则每次重算都在上一次结果上再抬一次，按钮会一路往上爬。
  const r = btn.getBoundingClientRect();
  const base = {
    top: r.top + avoidOffset.value,
    bottom: r.bottom + avoidOffset.value,
    left: r.left,
    right: r.right,
  };
  const scope = btn.parentElement;
  const dividers = scope
    ? Array.from(scope.querySelectorAll<HTMLElement>("[data-time-divider], [data-unread-divider]"))
        .map((el) => el.getBoundingClientRect())
        // overscan 会渲染视口外的行，先筛掉（重叠判据本身也会排除，这里省点算术）。
        .filter((x) => x.bottom > 0 && x.top < window.innerHeight)
    : [];
  avoidOffset.value = computeBackToLatestAvoidOffset(base, dividers);
}

function schedule() {
  if (!props.visible || raf) return;
  raf = requestAnimationFrame(measure);
}

watch(
  () => props.visible,
  (v) => {
    if (!v) {
      avoidOffset.value = 0;
      return;
    }
    nextTick(schedule);
  },
);

// 滚动/窗口尺寸变化时分割行的位置会变：只重算位移，不改出现阈值（`gap > 150` 仍由 VirtualList 驱动）。
onMounted(() => {
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  window.addEventListener("resize", schedule);
});
onBeforeUnmount(() => {
  document.removeEventListener("scroll", schedule, { capture: true });
  window.removeEventListener("resize", schedule);
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});
</script>

<template>
  <button
    ref="root"
    type="button"
    data-back-to-latest
    class="frost absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full text-[var(--gosslan-text)] transition active:scale-[0.97]"
    :style="avoidOffset ? { bottom: `calc(1rem + ${avoidOffset}px)` } : undefined"
    :class="
      visible
        ? 'gosslan-back-to-latest pointer-events-auto opacity-100 hover:bg-[var(--gosslan-hover)]'
        : 'pointer-events-none opacity-0'
    "
    :aria-hidden="!visible"
    :tabindex="visible ? 0 : -1"
    :aria-label="visible ? t('chat.backToLatest') : undefined"
    :title="visible ? t('chat.backToLatest') : undefined"
    @click="emit('press')"
  >
    <ArrowDown class="h-4 w-4" aria-hidden="true" />
  </button>
</template>
