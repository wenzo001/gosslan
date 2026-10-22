<script setup lang="ts">
import Spinner from "@/components/ui/Spinner.vue";
/**
 * 公共异步状态块：加载 / 空 / 错误 + 重试。
 *
 * 存在的理由：2026-10-18 盘点发现 20 个文件里有 ≥5 套内联空态，
 * 而独立预览窗口在 IPC 失败或空相册时**完全不画东西**（只剩空壳）。
 * 这里先给辅助窗口一个统一落点；后续页面按同一入口迁移。
 *
 * 两种形态（不是为了好看，是因为它们真的在两种容器里）：
 * - 默认（完整）：整页/整栏的落点，`flex-1` 抢满剩余高度，图标 32px、`py-10`；
 * - `compact`：**弹窗内嵌列表**的落点（共享目录/群文件/诊断面板），`flex-none` + `py-8`，
 *   只有加载/错误出 16px 图标，空态保持一行字（原来这些位置的空态就是一行字），
 *   换过来不改变视觉密度，只把重试入口与 role 补齐。
 */
import { computed } from "vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { AlertCircle, ImageOff, RotateCcw } from "@/components/ui/icons";

const props = withDefaults(
  defineProps<{
    kind: "loading" | "empty" | "error";
    title: string;
    detail?: string;
    retryLabel?: string;
    /** 弹窗内嵌列表：不抢整高、不画大图标（见文件头）。 */
    compact?: boolean;
  }>(),
  { detail: "", retryLabel: "", compact: false },
);

defineEmits<{ retry: [] }>();

const icon = computed(() => (props.kind === "empty" ? ImageOff : AlertCircle));

/** compact 不出空态图标（原来这些位置的空态就是一行字）；加载/错误仍给 16px 图标，别把告警降级成纯文字。 */
const showIcon = computed(() => !props.compact || props.kind !== "empty");

const titleClass = computed(() => {
  if (!props.compact) return "font-medium text-[var(--gosslan-text-body)]";
  return props.kind === "error"
    ? "text-[var(--gosslan-danger-ink)]"
    : "text-[var(--gosslan-text-2)]";
});
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center"
    :class="compact ? 'flex-none gap-2 py-8' : 'flex-1 gap-3 px-6 py-10'"
    :role="kind === 'error' ? 'alert' : 'status'"
    :aria-live="kind === 'loading' ? 'polite' : undefined"
  >
    <Spinner
      v-if="showIcon && kind === 'loading'"
      :size-class="compact ? 'h-4 w-4' : 'h-8 w-8'"
      class="text-[var(--gosslan-text-caption)]"
    />
    <component
      v-else-if="showIcon"
      :is="icon"
      :class="compact ? 'h-4 w-4' : 'h-8 w-8'"
      class="text-[var(--gosslan-text-caption)]"
      aria-hidden="true"
    />
    <div class="text-sm" :class="titleClass">{{ title }}</div>
    <div
      v-if="detail"
      class="max-w-[42ch] text-body leading-relaxed text-[var(--gosslan-text-caption)]"
    >
      {{ detail }}
    </div>
    <PrimaryBtn v-if="kind === 'error' && retryLabel" shrink @click="$emit('retry')">
      <span class="inline-flex items-center gap-1.5">
        <RotateCcw class="h-4 w-4" aria-hidden="true" />
        {{ retryLabel }}
      </span>
    </PrimaryBtn>
  </div>
</template>
