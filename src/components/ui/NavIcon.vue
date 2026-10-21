<script setup lang="ts">
/**
 * 一级导航图标的唯一渲染出口 —— PC 左侧栏与移动端底栏**都从这里渲染**，
 * 这样"同一语义两端同一个图标"是结构上的事实，不靠两边各自抄一份 path。
 *
 * 只画图形本身，不带按钮：热区、圆角、配色档与 `UnreadBadge` 挂点都由调用方决定
 * （与 `ui/BackArrow.vue` 同一分工）。
 *
 * `aria-hidden` 写死在这里：图标不是文案，可访问名永远由外层按钮的 `aria-label` 给。
 * 自绘的理由（lucide 是描边库、选中态靠填充）登记在 `navIconPaths.ts`，判据在
 * `designGuards.test.ts`。
 */
import { NAV_ICON_PATHS, type NavIconName } from "@/components/ui/navIconPaths";

const props = withDefaults(
  defineProps<{
    name: NavIconName;
    /** 选中态：填充成实心（lucide 那套描边图标做不到，所以这四枚才允许自绘）。 */
    active?: boolean;
    /** 尺寸档：栏位 22px（默认）、移动端底栏 20px。 */
    sizeClass?: string;
  }>(),
  { active: false, sizeClass: "h-[22px] w-[22px]" },
);
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :class="props.sizeClass"
    :fill="props.active ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="1.9"
    stroke-linejoin="round"
    :fill-rule="NAV_ICON_PATHS[props.name].evenodd ? 'evenodd' : undefined"
    :clip-rule="NAV_ICON_PATHS[props.name].evenodd ? 'evenodd' : undefined"
    aria-hidden="true"
  >
    <path :d="NAV_ICON_PATHS[props.name].d" />
  </svg>
</template>
