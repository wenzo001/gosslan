<script setup lang="ts">
import { injectToastProviderContext, ToastClose, ToastRoot, ToastTitle, ToastViewport } from "reka-ui";
import { CheckCircle2, Info, XCircle } from "lucide-vue-next";
import { t as translate } from "@/i18n";
import { releaseToastCount } from "@/utils/toastManager";

/**
 * `ToastProvider` 的 toast 列表只存在于它 provide 的上下文里，而 provider 是
 * `ToastHud` 模板里的子节点 ⇒ 读列表的这一小段必须是独立的子组件。
 * 这里只管外观（图标/配色/限流隐藏），停留时长、堆叠、滑动与 live region 由库负责。
 */
/**
 * ⚠️ 不要在这里用 `@escape-key-down` 阻止库关闭 toast：Reka 的 ToastRoot 把 Escape
 * 监听在 **window** 上，回调里一次 `preventDefault()` 会污染这次按键，让同一次 Esc
 * 再也关不掉 Dialog / Menu / Select（实测：有 toast 时下拉按 Esc 无反应）。
 * 这里保持库默认语义：Esc 关闭 toast。
 */
const { toastStore } = injectToastProviderContext();
const toasts = toastStore.toasts;
</script>

<template>
  <ToastViewport
    :label="translate('common.toastLabel')"
    class="m-0 flex list-none flex-col items-center gap-2 p-0"
  >
    <ToastRoot
      v-for="toast in toasts"
      :key="toast.id"
      :toast="toast"
      class="gosslan-toast pointer-events-auto flex max-w-[min(92vw,32rem)] items-center gap-2 rounded-[var(--gosslan-radius-md)] border border-white/10 px-4 py-2 text-sm text-white shadow-[var(--gosslan-glass-2-shadow)] backdrop-blur-sm transition data-[limited]:hidden data-[swipe=move]:translate-x-[var(--reka-toast-swipe-move-x,0px)]"
      :class="toast.data?.kind === 'error' ? 'bg-[var(--gosslan-danger)]' : 'bg-[var(--gosslan-hud)]'"
      @close="releaseToastCount(toast.id)"
    >
      <CheckCircle2 v-if="toast.data?.kind === 'success'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <XCircle v-else-if="toast.data?.kind === 'error'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <Info v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      <ToastTitle class="min-w-0" />
      <!-- 同 key 重复时只加计数，不叠新条（A1 裁决）。 -->
      <span
        v-if="(toast.data?.count ?? 1) > 1"
        data-toast-count
        class="shrink-0 rounded-[var(--gosslan-radius-sm)] bg-white/20 px-1.5 py-0.5 text-xs font-medium tabular-nums"
      >×{{ toast.data!.count }}</span>
      <!--
        只有"说得出下一步"的失败才带按钮（目前只有辅助窗口创建失败）。
        用库的 `ToastClose` 当容器：点按钮会顺手关掉这条 toast，不需要自己管计时。
      -->
      <ToastClose
        v-if="toast.data?.action"
        class="ml-2 shrink-0 rounded-[var(--gosslan-radius-sm)] bg-white/20 px-2 py-0.5 text-xs font-medium hover:bg-white/30"
        @click="toast.data.action.run()"
      >
        {{ toast.data.action.label }}
      </ToastClose>
    </ToastRoot>
  </ToastViewport>
</template>
