<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { api } from "@/api";
import { Minus, X, Maximize2, Minimize2 } from "lucide-vue-next";
import { isMac } from "@/utils/platform";
import { t } from "@/i18n";

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

/** macOS 绿灯的 Option-click → 全屏（HIG：缩放按钮按住 Option 进入/退出全屏）。 */
const fullscreen = ref(false);
async function toggleFullscreen() {
  try {
    fullscreen.value = await api.windowToggleFullscreen();
  } catch {
    fullscreen.value = false;
  }
}

function onGreenClick(e: MouseEvent) {
  if (e.altKey) void toggleFullscreen();
  else void toggleMaximize();
}

/**
 * 双击标题栏 → 缩放（仅 macOS；Windows 由 tao 的拖拽区原生处理双击最大化）。
 * ⚠️ 系统偏好「双击标题栏的动作」在 WebView 里读不到，这里用系统默认的"缩放"。
 * 若要完全跟随用户偏好，需改为 `decorations + titleBarStyle: Overlay` 交给系统，属后续项。
 */
function onTitlebarDblClick() {
  if (app.isMobile || !isMac) return;
  void toggleMaximize();
}

/**
 * Ctrl+W 关闭窗口（仅 Windows/Linux）：与标题栏「×」一致，最小化到托盘。
 *
 * macOS **不在这里处理**：自绘标题栏 + `decorations:false` 下本无系统 ⌘W，
 * 现已由 src-tauri/src/menu.rs 补回原生「窗口 → 关闭」菜单（lib.rs 亦恢复了
 * NSWindow 的 `Closable` 位），交给系统处理即可，避免前端兜底与原生菜单双触发。
 */
function onKeydown(e: KeyboardEvent) {
  if (app.isMobile) return;
  if (isMac) return;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
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
    @dblclick="onTitlebarDblClick"
  >
    <!-- macOS：红绿灯（最左，模拟系统样式；悬停整组时显示符号）。
         组上加 @dblclick.stop：双击红绿灯不应冒泡成"双击标题栏"触发缩放。 -->
    <div v-if="isMac" class="group/traffic flex h-full items-center gap-2" @dblclick.stop>
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#ff5f57]"
        :title="t('window.close')" :aria-label="t('window.close')"
        @click="api.windowClose()"
      >
        <X class="hover-reveal-op h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover/traffic:opacity-100" />
      </button>
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#febc2e]"
        :title="t('window.minimize')" :aria-label="t('window.minimize')"
        @click="api.windowMinimize()"
      >
        <Minus class="hover-reveal-op h-2 w-2 text-black/50 opacity-0 transition-opacity group-hover/traffic:opacity-100" />
      </button>
      <button
        class="flex h-3 w-3 items-center justify-center rounded-full border border-black/15 bg-[#28c840]"
        :title="fullscreen ? t('window.fullscreenExit') : maximized ? t('window.restore') : t('window.zoom')"
        :aria-label="fullscreen ? t('window.fullscreenExit') : maximized ? t('window.restore') : t('window.zoom')"
        @click="onGreenClick"
      >
        <component
          :is="fullscreen || maximized ? Minimize2 : Maximize2"
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
        :title="t('window.minimize')" :aria-label="t('window.minimize')"
        @click="api.windowMinimize()"
      >
        <Minus class="h-3.5 w-3.5" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        :title="maximized ? t('window.restore') : t('window.maximize')" :aria-label="maximized ? t('window.restore') : t('window.maximize')"
        @click="toggleMaximize"
      >
        <Minimize2 v-if="maximized" class="h-3 w-3" />
        <Maximize2 v-else class="h-3 w-3" />
      </button>
      <button
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-danger)] hover:text-white"
        :title="t('window.closeToTray')" :aria-label="t('window.closeToTray')"
        @click="api.windowClose()"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
