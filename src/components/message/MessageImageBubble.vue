<script setup lang="ts">
defineProps<{ src: string }>();
const emit = defineEmits<{ (e: "open", src: string): void }>();
</script>

<template>
  <div class="cursor-pointer overflow-hidden rounded-[var(--gosslan-bubble-radius)]" @click="emit('open', src)">
    <img :src="src" class="block max-h-72 max-w-full rounded-[var(--gosslan-bubble-radius)] object-contain" />
  </div>
</template>
