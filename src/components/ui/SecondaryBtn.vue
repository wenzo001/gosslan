<script setup lang="ts">
/**
 * 次要操作按钮（Secondary）—— 幽灵底 + 悬停浅填充；`outline` 变体加一圈描边。
 *
 * 为什么需要它：确认框里的「取消」、转发方式二选一里的次选、成员面板的「取消」……
 * 这些**文本按钮**此前在 12 处各写一遍，尺寸三档（px-3/py-1.5、px-4/py-2、px-4/py-1.5）
 * 与前景色两种（text-2 / text）并存。和同排的 PrimaryBtn/DangerBtn 并排时，
 * 高度/字重/垂直居中各自漂移 —— 用户 2026-10-28 报的「撤回弹窗按钮文字上下没居中」
 * 就是这一族。
 *
 * 三个共享按钮（Primary / Danger / Secondary）现在共用同一套盒模型：
 *   · 根元素是 `inline-flex items-center justify-center` —— 垂直居中**不靠 line-box**
 *     （slot 里包一层 `<span class="inline-flex">` 时，行盒会把文字顶高一两像素）；
 *   · 三档尺寸在同一档位内**逐字相同**（dense/default/large）。
 *
 * 判据：`designGuards` 的「对话框取消键只走 SecondaryBtn」与「三个按钮必须 flex 居中」
 * 两条钉住这两件事。
 */
withDefaults(
  defineProps<{
    /** dense: px-3 py-2 text-body / default: px-3 py-1.5 text-body / large: px-4 py-2 text-sm */
    size?: "xs" | "dense" | "default" | "large";
    shrink?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    type?: "button" | "submit";
    /** 描边变体（成员面板那类"次要但要看得见边界"的场合）。 */
    outline?: boolean;
  }>(),
  { size: "default", shrink: false, disabled: false, type: "button", outline: false },
);
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :aria-label="ariaLabel"
    class="tap-safe inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
    :class="[
      outline ? 'border border-[var(--gosslan-border)]' : '',
      shrink ? 'shrink-0' : '',
      size === 'xs' ? 'px-2.5 py-1 text-meta' : '',
      size === 'dense' ? 'px-3 py-2 text-body' : '',
      size === 'default' ? 'px-3 py-1.5 text-body' : '',
      size === 'large' ? 'px-4 py-2 text-sm' : '',
    ]"
  >
    <slot />
  </button>
</template>
