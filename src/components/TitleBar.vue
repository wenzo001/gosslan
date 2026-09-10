<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { api } from "@/api";
import { Minus, X, Maximize2, Minimize2 } from "lucide-vue-next";

const app = useAppStore();
const maximized = ref(false);

/** 平台判定（Tauri WebView UA：macOS 含 Macintosh，Windows 含 Windows NT）。 */
const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);

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

/** Cmd+W（macOS）/ Ctrl+W（Windows/Linux）关闭窗口：与标题栏「×」一致，最小化到托盘。
 *  前端兜底，不依赖系统原生菜单对 borderless 窗口的 Cmd+W 支持是否生效。 */
function onKeydown(e: KeyboardEvent) {
  if (app.isMobile) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
    e.preventDefault();
    void api.windowClose();
  }
}

onMounted(() => {
  refreshMaximized();
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <!-- 顶部 caption（桌面端）：横贯整窗，作为窗口拖拽区 + 窗口控制按钮。
       整条浅灰，与下方三列的 rail/chat 浅灰连成一体（list 白底除外）。 -->
  <div
    v-if="!app.isMobile"
    data-tauri-drag-region
    class="flex shrink-0 select-none items-center bg-[var(--gosslan-caption)]"
    :class="isMac ? 'justify-start pl-3' : 'justify-end'"
    :style="{ height: 'var(--gosslan-title-h)' }"
  >
    <!-- macOS：红绿灯（最左，模拟系统样式；悬停整组时显示符号） -->
    <div v-if="isMac" class="group/traffic flex h-full items-center gap-2">
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#ff5f57]"
        title="关闭" aria-label="关闭"
        @click="api.windowClose()"
      >
        <X class="hover-reveal-op h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover/traffic:opacity-100" />
      </button>
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#febc2e]"
        title="最小化" aria-label="最小化"
        @click="api.windowMinimize()"
      >
        <Minus class="hover-reveal-op h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover/traffic:opacity-100" />
      </button>
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#28c840]"
        :title="maximized ? '向下还原' : '缩放'" :aria-label="maximized ? '向下还原' : '缩放'"
        @click="toggleMaximize"
      >
        <component
          :is="maximized ? Minimize2 : Maximize2"
          class="hover-reveal-op h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover/traffic:opacity-100"
        />
      </button>
    </div>

    <!-- Windows/Linux：右侧三键（顶到窗口最右缘）。
         ⚠️ 这三个按钮**不要加圆角**：外框容器（ResponsiveLayout 根节点）是
         `rounded-[var(--gosslan-radius-lg)] + overflow-hidden`，关闭键右上角由它裁——两者曲线重合，hover 底
         与窗口边界严丝合缝。若给按钮自己加 border-radius（试过 8px），按钮的圆角曲线
         与窗口边界曲线不重合，中间会夹出一条浅色月牙缝（看起来"没贴合"）。
         同理只加圆角不加宽度补偿也不行：那会让 hover 底与窗口边缘脱开。
         原生 Windows 的窗口按钮 hover 也是整块矩形、由窗口圆角裁切。 -->
    <div v-else class="flex h-full items-stretch">
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        title="最小化" aria-label="最小化"
        @click="api.windowMinimize()"
      >
        <Minus class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        :title="maximized ? '向下还原' : '最大化'" :aria-label="maximized ? '向下还原' : '最大化'"
        @click="toggleMaximize"
      >
        <Minimize2 v-if="maximized" class="h-3 w-3" />
        <Maximize2 v-else class="h-3 w-3" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-danger)] hover:text-white"
        title="关闭（最小化到托盘，后台继续收消息）" aria-label="关闭（最小化到托盘，后台继续收消息）"
        @click="api.windowClose()"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
