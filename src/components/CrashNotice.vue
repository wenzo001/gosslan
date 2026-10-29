<script setup lang="ts">
/**
 * 上一轮崩溃/启动失败的横幅卡片。
 *
 * 只收 props、只 emit 动作：接线（复制/开日志/重启/重开蓝牙）都在 `App.vue`，
 * 这样运行时探针能用 `H.install` 直接挂载它，不需要 pinia / store。
 */
import { computed } from "vue";
import { t } from "@/i18n";
import type { PreviousRunReport } from "@/types";

const props = defineProps<{ report: PreviousRunReport; mobile?: boolean }>();
defineEmits<{
  copy: [];
  openLogs: [];
  restart: [];
  reEnableBle: [];
  dismiss: [];
}>();

const body = computed(() => {
  const r = props.report;
  if (r.kind === "silent_kill") return t("crash.silentKill");
  if (r.kind === "startup_failed") return t("crash.startupFailed");
  if (r.kind === "abort") return t("crash.abort");
  const base = t("crash.body", {
    time: r.at ?? "—",
    version: r.version ?? "—",
    location: r.panic?.location ?? "—",
  });
  return r.recentPanicCount >= 2
    ? `${base} ${t("crash.panicCount", { n: r.recentPanicCount })}`
    : base;
});

const extra = computed(() => {
  const r = props.report;
  const parts: string[] = [];
  if (r.bleSuspect) parts.push(t("crash.bleHeld"));
  if (r.hang && !r.hang.ended) {
    parts.push(t("crash.hang", { seconds: r.hang.seconds, op: r.hang.lastOp ?? "—" }));
  }
  return parts.join(" ");
});
</script>

<template>
  <div class="crash-notice" :class="{ 'crash-notice--mobile': mobile }">
    <section class="crash-card" role="alert" aria-live="polite">
      <header class="crash-head">
        <span class="crash-title">{{ t("crash.title") }}</span>
        <button class="crash-close" type="button" :aria-label="t('crash.dismiss')" @click="$emit('dismiss')">
          ×
        </button>
      </header>
      <p class="crash-body">{{ body }}</p>
      <p v-if="extra" class="crash-extra">{{ extra }}</p>
      <div class="crash-actions">
        <button type="button" class="crash-btn" @click="$emit('copy')">{{ t("crash.copy") }}</button>
        <button type="button" class="crash-btn" @click="$emit('openLogs')">
          {{ t("crash.openLogs") }}
        </button>
        <button type="button" class="crash-btn" @click="$emit('restart')">
          {{ t("crash.restart") }}
        </button>
        <button
          v-if="report.bleSuspect"
          type="button"
          class="crash-btn crash-btn--primary"
          @click="$emit('reEnableBle')"
        >
          {{ t("settings.network.bluetooth.reEnable") }}
        </button>
        <button type="button" class="crash-btn crash-btn--ghost" @click="$emit('dismiss')">
          {{ t("crash.dismiss") }}
        </button>
      </div>
      <p class="crash-code">{{ report.code }}</p>
    </section>
  </div>
</template>

<style scoped>
.crash-notice {
  position: fixed;
  top: var(--gosslan-header-h, 38px);
  left: 12px;
  right: 12px;
  z-index: 60;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.crash-notice--mobile {
  top: 0;
  left: 0;
  right: 0;
}
.crash-card {
  pointer-events: auto;
  width: min(720px, 100%);
  border: 1px solid var(--gosslan-card-line, var(--gosslan-border));
  border-radius: var(--gosslan-item-radius, 12px);
  background: var(--gosslan-card);
  color: var(--gosslan-text);
  box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
  padding: 12px 14px;
}
.crash-notice--mobile .crash-card {
  width: 100%;
  border-radius: 0 0 var(--gosslan-item-radius, 12px) var(--gosslan-item-radius, 12px);
}
.crash-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.crash-title {
  font-weight: 600;
  color: var(--gosslan-danger, #d64545);
}
.crash-close {
  border: 0;
  background: transparent;
  color: var(--gosslan-text-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.crash-close:hover {
  background: var(--gosslan-hover);
}
.crash-body {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.55;
}
.crash-extra {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--gosslan-text-2);
}
.crash-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.crash-btn {
  border: 1px solid var(--gosslan-border);
  background: var(--gosslan-hover);
  color: var(--gosslan-text);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.crash-btn:hover {
  filter: brightness(1.05);
}
.crash-btn--primary {
  border-color: var(--gosslan-primary);
  color: var(--gosslan-on-primary, #fff);
}
.crash-btn--ghost {
  background: transparent;
}
.crash-code {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--gosslan-text-2);
  user-select: text;
}
</style>
