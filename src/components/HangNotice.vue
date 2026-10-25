<script setup lang="ts">
/**
 * 卡顿提示条：只在"某个 IPC 已等待 ≥10 s"时出现（判定在 `utils/uiStall.ts`）。
 *
 * 只收 props、只 emit：轮询与接线在 `App.vue`。非模态，不抢焦点。
 */
import { computed } from "vue";
import { t } from "@/i18n";

const props = defineProps<{
  label: string;
  seconds: number;
  escalated: boolean;
  mobile?: boolean;
}>();
defineEmits<{ wait: []; restart: [] }>();

const text = computed(() =>
  props.escalated
    ? t("hang.escalated", { seconds: props.seconds })
    : t("hang.body", { op: props.label, seconds: props.seconds }),
);
</script>

<template>
  <div class="hang-notice" :class="{ 'hang-notice--mobile': mobile }" role="status" aria-live="polite">
    <div class="hang-card">
      <div class="hang-text">
        <span class="hang-title">{{ t("hang.title") }}</span>
        <span class="hang-body">{{ text }}</span>
      </div>
      <div class="hang-actions">
        <button type="button" class="hang-btn" @click="$emit('wait')">{{ t("hang.wait") }}</button>
        <button type="button" class="hang-btn hang-btn--primary" @click="$emit('restart')">
          {{ t("hang.restart") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hang-notice {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 59;
  width: min(560px, calc(100vw - 24px));
  pointer-events: none;
}
.hang-notice--mobile {
  bottom: calc(var(--gosslan-mobile-tabbar-h, 56px) + 10px);
}
.hang-card {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--gosslan-border);
  border-radius: var(--gosslan-item-radius, 12px);
  background: var(--gosslan-card);
  color: var(--gosslan-text);
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
}
.hang-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.hang-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--gosslan-danger, #d64545);
}
.hang-body {
  font-size: 12px;
  color: var(--gosslan-text-2);
  overflow-wrap: anywhere;
}
.hang-actions {
  display: flex;
  gap: 8px;
  flex: none;
}
.hang-btn {
  border: 1px solid var(--gosslan-border);
  background: var(--gosslan-hover);
  color: var(--gosslan-text);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.hang-btn--primary {
  border-color: var(--gosslan-primary);
  color: var(--gosslan-on-primary, #fff);
}
</style>
