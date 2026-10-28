<script setup lang="ts">
/**
 * 主要操作按钮（Primary）—— 主题色实底 + 白字 + hover 亮一档。
 *
 * 统一了之前各处手搓的 Primary 按钮：
 *   ResponsiveLayout / TodoDetailDialog / LinksList / GroupTasksBoard /
 *   GroupMemberPanel / NetworkSection / LogViewer / ForwardModal 等。
 *
 * 三种尺寸：dense(py-2) / default(py-1.5 text-body) / large(py-2 text-sm font-medium)。
 * 根元素是 `inline-flex items-center justify-center`：垂直居中不靠 line-box（见 SecondaryBtn 的说明）。
 */

withDefaults(
  defineProps<{
    /** dense: py-2 / default: py-1.5 / large: py-2 text-sm */
    size?: "xs" | "dense" | "default" | "large";
    /** 不要 flex-1（默认按钮会占满容器宽度） */
    shrink?: boolean;
    disabled?: boolean;
    /** aria-label（图标按钮时必须给） */
    ariaLabel?: string;
    type?: "button" | "submit";
  }>(),
  { size: "default", shrink: false, disabled: false, type: "button" },
);
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :aria-label="ariaLabel"
    class="tap-safe inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] transition hover:bg-[var(--gosslan-primary-hover)] disabled:opacity-50"
    :class="[
      shrink ? 'shrink-0' : '',
      size === 'xs' ? 'px-2.5 py-1 text-meta' : '',
      size === 'dense' ? 'px-3 py-2 text-body' : '',
      size === 'default' ? 'px-3 py-1.5 text-body' : '',
      size === 'large' ? 'px-4 py-2 text-sm font-medium' : '',
    ]"
  >
    <slot />
  </button>
</template>
