<script setup lang="ts">
import type { CSSProperties } from "vue";
import type { FileMeta } from "@/types";
import { humanSize } from "@/utils/color";
import { Download, FileText, X } from "lucide-vue-next";

defineProps<{
  meta: FileMeta;
  bubbleStyle: CSSProperties;
  /** 0~1；null 表示不显示进度条（历史消息 / 已完成）。 */
  progress: number | null;
  statusText: string | null;
  failed: boolean;
  note: string | null;
  /** 群文件（gfile-）专用：按成员聚合的投递状态（单聊为 null 不显示）。 */
  delivery?: { completed: number; failed: number; waiting: number } | null;
}>();
const emit = defineEmits<{
  (e: "open"): void;
  (e: "save"): void;
}>();
</script>

<template>
  <div class="flex min-w-0 flex-1 flex-col gap-2 rounded-[var(--gosslan-bubble-radius)] px-3 py-2.5" :style="bubbleStyle">
    <div class="flex items-center gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        :class="failed ? 'bg-red-100 text-red-500 dark:bg-red-900/30' : 'bg-primary-light text-primary'"
      >
        <FileText v-if="!failed" class="h-5 w-5" />
        <X v-else class="h-5 w-5" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{{ meta.name }}</div>
        <div v-if="failed" class="text-xs text-red-500">发送失败</div>
        <div v-else class="text-xs opacity-70">{{ humanSize(meta.size) }}</div>
        <div v-if="note" class="text-[11px] opacity-70">{{ note }}</div>
      </div>
      <button
        v-if="!failed"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary transition hover:bg-[var(--gosslan-hover)]"
        title="打开文件"
        @click="emit('open')"
      >
        <FileText class="h-4 w-4" />
      </button>
      <button
        v-if="!failed"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-primary transition hover:bg-[var(--gosslan-hover)]"
        title="下载文件"
        @click="emit('save')"
      >
        <Download class="h-4 w-4" />
      </button>
    </div>
    <!-- 群文件成员投递状态：已发送给 N 人 · M 人待上线（失败单列） -->
    <div v-if="delivery" class="flex items-center gap-1.5 text-[11px] opacity-70">
      <span>已发送给 {{ delivery.completed }} 人</span>
      <span v-if="delivery.waiting > 0">· {{ delivery.waiting }} 人待上线</span>
      <span v-if="delivery.failed > 0" class="text-red-500">· {{ delivery.failed }} 人失败</span>
    </div>
    <!-- 传输进度条（发送/接收中实时显示，完成后消失） -->
    <template v-if="progress !== null">
      <div class="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          class="h-full rounded-full bg-primary transition-all duration-200"
          :style="{ width: `${Math.round(progress * 100)}%` }"
        ></div>
      </div>
      <div class="text-[11px] opacity-70">{{ statusText }}</div>
    </template>
  </div>
</template>
