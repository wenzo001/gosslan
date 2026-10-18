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
       层级 z-[90] 是阶梯里 Toast 专属的一格（见 designGuards ㉕/⑫），不要再往上加浮层。 -->
  <div
    class="pointer-events-none fixed left-1/2 z-[90] -translate-x-1/2"
    :style="{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }"
  >
    <ToastProvider :toast-manager="toastManager" :label="t('common.toastLabel')" :limit="3">
      <ToastList />
    </ToastProvider>
  </div>
</template>
