<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { version } from "../../../package.json";

const emit = defineEmits<{ (e: "dev-open"): void }>();
const app = useAppStore();
const fullId = computed(() => app.device?.device_id ?? "");

/** 隐藏开发者诊断面板：连续点击设备指纹 7 次（2.5 秒窗口）。 */
const DEV_TAP_TARGET = 7;
const DEV_TAP_WINDOW_MS = 2500;
let tapCount = 0;
let tapTimer: ReturnType<typeof setTimeout> | null = null;

function onFingerprintTap() {
  tapCount++;
  if (tapTimer) clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    tapCount = 0;
  }, DEV_TAP_WINDOW_MS);
  if (tapCount >= DEV_TAP_TARGET) {
    tapCount = 0;
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
    emit("dev-open");
  }
}
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">关于</h3>
    <div class="text-xs leading-relaxed text-[var(--gosslan-text-2)]">
      设备指纹：<span class="select-text break-all font-mono" @click="onFingerprintTap">{{ fullId }}</span>
    </div>
    <div class="mt-1 text-xs text-[var(--gosslan-text-2)]">
      Gosslan v{{ version }} · 无服务器 P2P · 端到端加密 · 数据仅存本机
    </div>
  </section>
</template>
