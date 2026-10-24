<script setup lang="ts">
/**
 * 分段控件（Segmented Control）—— 统一应用内所有 tabs / 切换器的视觉。
 *
 * 用法：
 *   <SegmentedControl v-model="value" :options="[{value:'a',label:'A'},{value:'b',label:'B'}]" />
 *
 * 激活态配方（设计规范）：
 *   border + primary-light 底 + accent-ink 字 + font-medium
 * 非激活：border-transparent + text-2 + hover-bg
 *
 * 行为交给 Reka `RadioGroupRoot/RadioGroupItem`：方向键在选项间移动并选中、
 * 整组只有一个 Tab 停靠点、禁用态与 `role=radio/aria-checked` 由库维护。
 * 本组件只保留 Gosslan 的尺寸、配色与徽标槽。
 *
 * 为什么抽：此前多处手搓、激活态各写各的（有的 border + 主题色，有的
 * bg-panel shadow-sm，有的干脆没样式）。现在 AppearanceSection / GeneralSection
 * 共用这一份。GroupTasksBoard 的筛选胶囊（带计数）与草稿状态（带语义色）
 * **刻意不并入**：前者是 chips 而非分段，后者合并会丢掉状态色信息。
 */
import { RadioGroupItem, RadioGroupRoot } from "reka-ui";

type Option = {
  value: string;
  label: string;
  /** 可选：激活态时 label 旁边展示的徽标（如计数小圆片）。 */
  badge?: string | number;
};

withDefaults(
  defineProps<{
    modelValue: string;
    options: Option[];
    /** 按钮内边距尺寸 —— 不同场景密度不同：Appearance 用 xs，ChatStyle 用 default */
    size?: "xs" | "sm" | "default";
    /** aria-label（无障碍：给读屏人知道这是啥分组） */
    ariaLabel?: string;
    /** 禁用某些选项 */
    disabled?: boolean;
  }>(),
  { size: "default" },
);

const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
}>();

const sizeClasses: Record<string, string> = {
  xs: "px-2 py-0.5 text-caption",
  sm: "px-2.5 py-1 text-xs",
  default: "py-1.5 text-meta",
};
</script>

<template>
  <RadioGroupRoot
    :model-value="modelValue"
    :disabled="disabled"
    orientation="horizontal"
    :aria-label="ariaLabel"
    class="flex gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] p-0.5"
    @update:model-value="(v) => emit('update:modelValue', String(v))"
  >
    <RadioGroupItem
      v-for="opt in options"
      :key="opt.value"
      :value="opt.value"
      :disabled="disabled"
      class="tap-safe flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--gosslan-radius-sm)] border transition disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--gosslan-primary-active)] data-[state=checked]:font-medium data-[state=checked]:text-[var(--gosslan-on-primary)] data-[state=checked]:shadow-sm data-[state=unchecked]:border-transparent data-[state=unchecked]:text-[var(--gosslan-text-2)] hover:data-[state=unchecked]:bg-[var(--gosslan-hover)]"
      :class="sizeClasses[size]"
    >
      {{ opt.label }}
      <span
        v-if="opt.badge !== undefined"
        class="rounded-full px-1.5 text-caption leading-4 tabular-nums"
        :class="
          modelValue === opt.value
            ? 'bg-white/25 text-white'
            : 'text-[var(--gosslan-text-2)] opacity-70'
        "
      >
        {{ opt.badge }}
      </span>
    </RadioGroupItem>
  </RadioGroupRoot>
</template>
