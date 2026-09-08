<script setup lang="ts">
/** 消息头像：连续消息合并时由父组件渲染等宽占位，组件本身不感知合并规则。 */
defineProps<{
  name: string;
  avatar?: string | null;
}>();
</script>

<template>
  <div class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] bg-primary text-white">
    <img v-if="avatar" :src="avatar" class="h-full w-full object-cover" />
    <span v-else class="text-sm font-medium">{{ (name || "?").slice(0, 1) }}</span>
  </div>
</template>
