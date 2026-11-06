<script setup lang="ts">
defineProps<{ title: string; footer?: string }>();
</script>

<template>
  <section>
    <h3 class="settings-group-caption mb-2 text-xs font-medium tracking-wide text-[var(--gosslan-text-2)]">
      {{ title }}
    </h3>
    <div
      data-settings-rows
      class="overflow-hidden rounded-[var(--gosslan-radius-lg)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] shadow-sm"
    >
      <slot />
    </div>
    <p v-if="footer" class="settings-group-caption mt-2 text-caption leading-relaxed text-[var(--gosslan-text-2)]">
      {{ footer }}
    </p>
  </section>
</template>
