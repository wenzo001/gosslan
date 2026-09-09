<script setup lang="ts">
defineProps<{ title: string; footer?: string }>();
</script>

<template>
  <section>
    <h3 class="mb-2 px-1 text-xs font-medium tracking-wide text-[var(--gosslan-text-2)]">
      {{ title }}
    </h3>
    <div
      class="overflow-hidden rounded-xl border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] shadow-sm"
    >
      <slot />
    </div>
    <p v-if="footer" class="mt-2 px-1 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
      {{ footer }}
    </p>
  </section>
</template>
