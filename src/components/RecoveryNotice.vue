<script setup lang="ts">
/**
 * 渲染层自愈的恢复横幅（判定与动作都在后端 `watchdog`，这里只显示结局）。
 *
 * 文案要点（用户 2026-11-04 硬要求）：说清"界面刚才无响应，已自动恢复"，并明确
 * **草稿已保留** —— 这句是"可恢复"承诺的一部分，中英各一份（`recovery.*`）。
 * 只在 `recovered` 时提草稿；`suggest_restart` 是"自动恢复没救回来"的升级态，
 * 给一个立即重启按钮（渲染层还活着时这条才有意义，真死了走系统通知 + 托盘）。
 *
 * 非模态、不抢焦点；只收 props、只 emit —— 取走时机在 `App.vue` 的心跳回调
 * （搭每秒心跳的顺车，不新增常驻轮询）。
 */
import { computed } from "vue";
import { t } from "@/i18n";

const props = defineProps<{
  kind: "recovered" | "suggest_restart";
  mobile?: boolean;
}>();
defineEmits<{ restart: []; dismiss: [] }>();

const suggestRestart = computed(() => props.kind === "suggest_restart");
</script>

<template>
  <div
    class="recovery-notice"
    :class="{ 'recovery-notice--mobile': mobile }"
    role="status"
    aria-live="polite"
  >
    <div class="recovery-card">
      <div class="recovery-text">
        <span class="recovery-title">{{ t("recovery.title") }}</span>
        <span class="recovery-body">
          {{ suggestRestart ? t("recovery.suggestRestart") : t("recovery.recovered") }}
          <span v-if="!suggestRestart" class="recovery-draft">{{ t("recovery.draftKept") }}</span>
        </span>
      </div>
      <div class="recovery-actions">
        <button type="button" class="recovery-btn" @click="$emit('dismiss')">
          {{ t("recovery.dismiss") }}
        </button>
        <button
          v-if="suggestRestart"
          type="button"
          class="recovery-btn recovery-btn--primary"
          @click="$emit('restart')"
        >
          {{ t("recovery.restart") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 占独立占位行：过去是 `position: fixed; top: 16px`，会压在左栏搜索行与右栏首行上
   （用户 2026-11-06 截图，矮窗尤其明显）。现在由 `ResponsiveLayout` 的 #banner 插槽
   放在流内（移动端 safe-top 之后、桌面 caption 之前），内容整体下移，横幅自身也不会
   再被父容器裁切。z-index 保留只是为了盖住 `ambient` 的极光层，不再影响布局。 */
.recovery-notice {
  position: relative;
  z-index: 59;
  display: flex;
  flex: none;
  width: 100%;
  justify-content: center;
  padding: 8px 12px;
  pointer-events: none;
}
.recovery-notice--mobile {
  padding: 4px 8px;
}
.recovery-card {
  pointer-events: auto;
  display: flex;
  width: min(560px, 100%);
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
.recovery-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.recovery-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--gosslan-success, #2f9e5f);
}
.recovery-body {
  font-size: 12px;
  color: var(--gosslan-text-2);
  overflow-wrap: anywhere;
}
.recovery-draft {
  color: var(--gosslan-text);
  font-weight: 600;
}
.recovery-actions {
  display: flex;
  gap: 8px;
  flex: none;
}
.recovery-btn {
  border: 1px solid var(--gosslan-border);
  background: var(--gosslan-hover);
  color: var(--gosslan-text);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
}
.recovery-btn--primary {
  border-color: var(--gosslan-primary);
  color: var(--gosslan-on-primary, #fff);
}
</style>
