<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import { isMac } from "@/utils/platform";
import ResponsiveLayout from "@/layouts/ResponsiveLayout.vue";

const app = useAppStore();
const chat = useChatStore();

/** macOS 窗口圆角：必须在 WebView 加载完成后设（wry 此时才用 parent_view 替换 contentView，
 *  setup 阶段设会被替换丢失），并让窗口背景色跟随主题（消除暗色下圆角外露浅色的"白角"）。 */
async function applyWindowShape() {
  if (isMac && !app.isMobile) {
    await api.applyMacosWindowShape(app.dark).catch(() => {});
  }
}

onMounted(async () => {
  // 屏蔽 WebView 默认右键菜单（返回 / 刷新 / 另存为等），改为应用自定义交互：
  // 有功能的元素自行绑定右键菜单（见 MessageItem 的复制菜单），无功能的区域右键无效果。
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  try {
    await app.init();
    await chat.init();
  } finally {
    // 真实数据就绪 → 让 main.ts 撤掉首屏骨架（index.html 内联）。
    // 放在 finally：init 失败也要撤，否则骨架会一直挡在界面上。
    window.dispatchEvent(new Event("gosslan:app-ready"));
  }
  await applyWindowShape();
});

// 主题切换（浅/深/跟随系统变化）时同步窗口背景色，保持圆角外与内容同色。
watch(() => app.dark, () => void applyWindowShape());
</script>

<template>
  <ResponsiveLayout />
</template>
