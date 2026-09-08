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
  <!-- 顶部 caption（桌面端）：横贯整窗，作为窗口拖拽区 + 左侧铃铛 + 右上窗口按钮，
       整条浅灰，与下方三列的 rail/chat 浅灰连成一体（list 白底除外）。 -->
  <div
    v-if="!app.isMobile"
    data-tauri-drag-region
    class="flex shrink-0 select-none items-center justify-end bg-[var(--gosslan-caption)] px-2"
    :style="{ height: 'var(--gosslan-title-h)' }"
  >
    <!-- 右侧：窗口三键（应用无通知中心，不放假铃铛）；左侧整条为拖拽区 -->
    <div class="flex h-full items-stretch">
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        title="最小化"
        @click="api.windowMinimize()"
      >
        <Minus class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        :title="maximized ? '向下还原' : '最大化'"
        @click="toggleMaximize"
      >
        <Minimize2 v-if="maximized" class="h-3 w-3" />
        <Maximize2 v-else class="h-3 w-3" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[#e81123] hover:text-white"
        title="关闭（最小化到托盘，后台继续收消息）"
        @click="api.windowClose()"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>