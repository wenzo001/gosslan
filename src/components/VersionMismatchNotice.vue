<script setup lang="ts">
/**
 * 版本错配提示条：启动时前端构建版本与后端 `APP_VERSION` 不一致时出现。
 *
 * 只收 props、只 emit 重启：动作接线在 `App.vue`（走既有 `api.restartApp`）。
 * 不误报判据见 `utils/versionGuard.ts`：任一版本拿不到就不显示。
 */
import { computed } from "vue";
import { t } from "@/i18n";
import type { VersionMismatch } from "@/utils/versionGuard";

const props = defineProps<{ mismatch: VersionMismatch; mobile?: boolean }>();
defineEmits<{ restart: [] }>();

const body = computed(() =>
  t("versionMismatch.body", {
    frontend: props.mismatch.frontend,
    backend: props.mismatch.backend,
  }),
);
</script>

<template>
  <div
    class="version-notice"
    :class="{ 'version-notice--mobile': mobile }"
    role="alert"
    aria-live="polite"
  >
    <div class="version-card">
      <div class="version-text">
        <span class="version-title">{{ t("versionMismatch.title") }}</span>
        <span class="version-body">{{ body }}</span>
      </div>
      <button type="button" class="version-btn" @click="$emit('restart')">
        {{ t("versionMismatch.restart") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.version-notice {
  position: fixed;
  left: 50%;
  bottom: calc(var(--gosslan-inset-bottom) + 16px);
  transform: translateX(-50%);
  z-index: 58;
  width: min(560px, calc(100vw - 24px));
  pointer-events: none;
}
.version-notice--mobile {
  bottom: calc(var(--gosslan-inset-bottom) + var(--gosslan-mobile-tabbar-h, 56px) + 10px);
}
.version-card {
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
.version-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.version-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--gosslan-danger, #d64545);
}
.version-body {
  font-size: 12px;
  color: var(--gosslan-text-2);
  overflow-wrap: anywhere;
}
.version-btn {
  flex: none;
  border: 1px solid var(--gosslan-border);
  background: var(--gosslan-hover);
  color: var(--gosslan-text);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
</style>
