<script setup lang="ts">
import { t } from "@/i18n";
import { UserMinus } from "lucide-vue-next";

defineProps<{ x: number; y: number }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm"): void;
}>();
</script>

<template>
  <Teleport to="body">
    <div
      class="frost fixed z-50 min-w-[150px] select-none rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-1 shadow-xl"
      :style="{ left: x + 'px', top: y + 'px' }"
      @click.stop
    >
      <button
        class="flex w-full items-center gap-2 rounded-[var(--gosslan-radius-xs)] px-3 py-2 text-left text-sm text-[var(--gosslan-danger-ink)] transition hover:bg-[var(--gosslan-hover)]"
        @click="emit('confirm')"
      >
        <UserMinus class="h-4 w-4" />
        {{ t("common.deleteFriend") }}
      </button>
      <div class="px-3 pb-1.5 pt-1 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("friend.delete.keepHistory") }}
      </div>
    </div>
  </Teleport>
</template>
