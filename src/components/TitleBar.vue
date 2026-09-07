<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { api } from "@/api";
import { Minus, X, Maximize2, Minimize2 } from "lucide-vue-next";

const app = useAppStore();
const maximized = ref(false);

async function refreshMaximized() {
  try {
    maximized.value = await api.windowIsMaximized();
  } catch {
    maximized.value = false; // 移动端 / 命令不可用时忽略
  }
}

async function toggleMaximize() {
  try {
    maximized.value = await api.windowToggleMaximize();
  } catch {
    /* 忽略 */
  }
}

onMounted(refreshMaximized);
</script>

<template>
  <!-- 自绘标题栏：与下方导航/列表同 panel 底色、无割裂分割线，视觉上与主界面连成一体。
       data-tauri-drag-region 提供拖拽移动窗口能力（Tauri v2）。 -->
  <div
    v-if="!app.isMobile"
    data-tauri-drag-region
    class="flex h-9 shrink-0 select-none items-center justify-between bg-[var(--gosslan-panel)] pl-3"
  >
    <div class="flex items-center gap-2 text-xs text-[var(--gosslan-text-2)]">
      <span class="font-semibold text-[var(--gosslan-text)]">Gosslan</span>
      <span class="opacity-60">· 无服务器局域网即时通讯</span>
    </div>
    <div class="flex h-full items-stretch">
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        title="最小化"
        @click="api.windowMinimize()"
      >
        <Minus class="h-4 w-4" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="maximized ? '向下还原' : '最大化'"
        @click="toggleMaximize"
      >
        <Minimize2 v-if="maximized" class="h-3.5 w-3.5" />
        <Maximize2 v-else class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-text-2)] transition hover:bg-red-500 hover:text-white"
        title="关闭（最小化到托盘，后台继续收消息）"
        @click="api.windowClose()"
      >
        <X class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>
