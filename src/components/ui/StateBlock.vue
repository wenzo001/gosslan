<script setup lang="ts">
/**
 * 公共异步状态块：加载 / 空 / 错误 + 重试。
 *
 * 存在的理由：2026-10-18 盘点发现 20 个文件里有 ≥5 套内联空态，
 * 而独立预览窗口在 IPC 失败或空相册时**完全不画东西**（只剩空壳）。
 * 这里先给辅助窗口一个统一落点；后续页面按同一入口迁移。
 */
import { computed } from "vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { AlertCircle, ImageOff, Loader2, RotateCcw } from "@/components/ui/icons";

const props = withDefaults(
  defineProps<{
    kind: "loading" | "empty" | "error";
    title: string;
    detail?: string;
    retryLabel?: string;
  }>(),
  { detail: "", retryLabel: "" },
);

defineEmits<{ retry: [] }>();

const icon = computed(() =>
  props.kind === "loading" ? Loader2 : props.kind === "empty" ? ImageOff : AlertCircle,
);
</script>

<template>
  <div
    class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    :role="kind === 'error' ? 'alert' : 'status'"
    :aria-live="kind === 'loading' ? 'polite' : undefined"
  >
    <component
      :is="icon"
      class="h-8 w-8 text-[var(--gosslan-text-caption)]"
      :class="kind === 'loading' ? 'animate-spin' : ''"
      aria-hidden="true"
    />
    <div class="text-sm font-medium text-[var(--gosslan-text-body)]">{{ title }}</div>
    <div
      v-if="detail"
      class="max-w-[42ch] text-[13px] leading-relaxed text-[var(--gosslan-text-caption)]"
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
