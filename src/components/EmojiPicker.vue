<script setup lang="ts">
import { EMOJIS } from "@/utils/emoji";

defineProps<{ open: boolean }>();
const emit = defineEmits<{
  /** 选中表情 → 输出 token 语法（如 "[微笑]"），由输入框插入。 */
  (e: "select", displayName: string): void;
  (e: "close"): void;
}>();
</script>

<template>
  <!-- 抖音式表情面板：单分类、上下滚动；正方形格子 + object-contain 保持原图比例 -->
  <div
    v-if="open"
    class="frost absolute bottom-full left-0 z-50 mb-2 w-[340px] select-none rounded-xl border border-[var(--gosslan-border)] shadow-xl"
    @click.stop
  >
    <div
      class="grid grid-cols-8 content-start gap-1 overflow-y-auto p-2"
      style="height: 300px"
    >
      <button
        v-for="e in EMOJIS"
        :key="e.file"
        class="flex h-9 w-9 items-center justify-center rounded-md transition hover:bg-[var(--gosslan-hover)]"
        :title="e.displayName"
        @click="emit('select', e.displayName)"
      >
        <img
          :src="e.url"
          :alt="e.name"
          class="h-full w-full object-contain"
          draggable="false"
        />
      </button>
    </div>
  </div>
</template>
