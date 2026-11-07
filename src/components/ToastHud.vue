<script setup lang="ts">
/**
 * Toast HUD：应用内唯一的轻量反馈层（发送失败 / 删除失败 / 操作成功都靠它）。
 *
 * 主窗口（`ResponsiveLayout`）与各独立窗口共用这一份。停留计时、堆叠、滑动关闭、
 * 限流与 live region 由 Reka `ToastProvider/Viewport/Root` 提供；这里只保留
 * 窗口顶部的固定定位（安全区偏移）和 Gosslan 的配色/图标。
 */
import { ToastProvider } from "reka-ui";
import ToastList from "@/components/ToastList.vue";
import { toastManager } from "@/utils/toastManager";
import { t } from "@/i18n";
</script>

<template>
  <!-- `pointer-events-none`：HUD 区域不吃点击；单条 toast 自己恢复命中（ToastList 里）。
       层级 z-[90] 是阶梯里 Toast 专属的一格（见 designGuards ㉕/⑫），不要再往上加浮层。
       位置：桌面贴顶部安全区；移动端改到底部 TabBar 之上 —— A1 裁决（2026-11-06）要求
       390 宽下不得盖住页头标题区、搜索框与列表首行（详见 scoped 样式）。 -->
  <!-- `w-[min(92vw,32rem)]`：不定宽时 fixed 元素从 left:50% 起 shrink-to-fit，
       只剩半屏可用宽度，短句也会被折成两行（实测 390 下 8 个字就折行）。 -->
  <div class="gosslan-toast-hud pointer-events-none fixed left-1/2 z-[90] w-[min(92vw,32rem)] -translate-x-1/2">
    <ToastProvider :toast-manager="toastManager" :label="t('common.toastLabel')" :limit="2">
      <ToastList />
    </ToastProvider>
  </div>
</template>

<style scoped>
/* 桌面：顶部 1rem（让开安全区）。 */
.gosslan-toast-hud {
  top: calc(var(--gosslan-inset-top) + 1rem);
}
/* 移动布局：两根手指宽的头区（标题 + 搜索）是导航入口，不能被消息条盖住；
   抬到 TabBar 之上既避开头部，也不会压住聊天输入区最下面那一排按钮。 */
html.is-mobile .gosslan-toast-hud {
  top: auto;
  bottom: calc(var(--gosslan-inset-bottom) + var(--gosslan-mobile-tabbar-h) + 1rem);
}
</style>
