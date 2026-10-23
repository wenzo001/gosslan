<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    description?: string;
    /** 是否最后一行（去掉底部分隔线） */
    last?: boolean;
  }>(),
  { description: "", last: false },
);
</script>

<template>
  <!-- 手机上控件（分段选择 / 长按钮）放不下时换到下一行，别把标题和说明挤成一条缝。
       basis-48 只约束换行时机，不改变桌面端原有的单行布局。 -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
    <div class="min-w-0 flex-1 basis-48">
      <div class="text-sm text-[var(--gosslan-text)]">{{ label }}</div>
      <p v-if="description" class="mt-0.5 text-caption leading-relaxed text-[var(--gosslan-text-2)]">
        {{ description }}
      </p>
    </div>
    <div class="shrink-0"><slot /></div>
  </div>
  <div v-if="!last" class="ml-4 h-px bg-[var(--gosslan-divider)]" />
</template>
