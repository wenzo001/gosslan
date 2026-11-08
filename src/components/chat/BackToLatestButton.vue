<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
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
 * ④ **位置必须恒定**（2026-11-08 用户报"上下滚动时一直在上下跳动"后改，取代 11-06 的实测避让）。
 *    旧实现在滚动/尺寸变化时实测自己与 `[data-time-divider]` / `[data-unread-divider]`
 *    是否相交，相交就按「行高 + 8px」逐级上移（最多 3 步）—— 分割行滚过按钮的那一刻跳一格，
 *    滚回去又跳回来。运行时探针 `--only=backjump` 实测：连滚 0→800px，`top` 序列出现
 *    `372 → 336 → 300 → 372`，唯一值 3 个、跨度 72px。
 *    现在只认一个位置：`bottom: calc(1rem + bottomOffset)`（输入区高度由 ChatWindow 实测传入）。
 *    不读滚动位置、不测量分割行、不挂 scroll/resize 监听；出现/消失只走透明度，不带位移。
 *    代价（明确记账）：分割行滚到按钮脚下时会被圆钮压住一角 —— 用户选择"位置稳定"优先。
 */
import { t } from "@/i18n";

defineProps<{
  visible: boolean;
  /**
   * 悬浮输入区实测高度（px）。输入卡现在是覆盖层，消息区虽已留出 padding-bottom，
   * 但这条按钮的定位基准是**消息区**（`bottom-4`），不让位就会被输入卡压住。
   * 由 ChatWindow 的 ResizeObserver 实测传入，不用固定常量。
   */
  bottomOffset?: number;
}>();
const emit = defineEmits<{ (e: "press"): void }>();
</script>

<template>
  <button
    type="button"
    data-back-to-latest
    class="frost absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full text-[var(--gosslan-text)] transition active:scale-[0.97]"
    :style="{ bottom: `calc(1rem + ${bottomOffset ?? 0}px)` }"
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
    <Icon name="arrow-down" class="h-4 w-4" aria-hidden="true" />
  </button>
</template>
