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
import { AlertCircle, RotateCcw } from "@/components/ui/icons";

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

/**
 * 空态**不出图标**（2026-11-06）。
 *
 * 旧版对所有空态统一画一颗 `ImageOff`（"图片坏了"的图形）。日志为空、任务为空、
 * 通讯录为空，都不是"图片加载失败"，那颗图标既不对题，又让每个空态长得像同一张模板卡。
 * 空态收敛成「一行结论 + 可选一行说明」；加载与错误仍保留图标，因为那两种状态需要
 * 一眼分辨"还在转"和"出事了"。
 */
const showIcon = computed(() => props.kind !== "empty");

const titleClass = computed(() => {
  // 字号/字重只做两级：空态是正文档 + 中等字重；错误态靠颜色而不是加粗。
  // 非紧凑档用 `text-[length:…]` 显式声明**长度类型**：Tailwind 对裸的
  // `text-[var(--x)]` 分辨不出颜色还是字号，会编译成 `color: 14px`（无效值被丢弃）。
  const tone = props.kind === "error"
    ? "text-[var(--gosslan-danger-ink)]"
    : props.compact
      ? "text-[var(--gosslan-text-2)]"
      : "text-[var(--gosslan-text)]";
  return props.compact
    ? `text-sm font-medium ${tone}`
    : `font-medium text-[length:var(--gosslan-text-body)] ${tone}`;
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
      class="text-[var(--gosslan-text-2)]"
    />
    <AlertCircle
      v-else-if="showIcon"
      :class="compact ? 'h-4 w-4' : 'h-8 w-8'"
      class="text-[var(--gosslan-text-2)]"
      aria-hidden="true"
    />
    <div :class="titleClass">{{ title }}</div>
    <div
      v-if="detail"
      class="max-w-[42ch] text-body leading-relaxed text-[var(--gosslan-text-2)]"
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
