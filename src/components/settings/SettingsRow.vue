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
  <div class="flex items-center gap-3 px-4 py-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm text-[var(--gosslan-text)]">{{ label }}</div>
      <p v-if="description" class="mt-0.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
        {{ description }}
      </p>
    </div>
    <div class="shrink-0"><slot /></div>
  </div>
  <div v-if="!last" class="ml-4 h-px bg-[var(--gosslan-divider)]" />
</template>
