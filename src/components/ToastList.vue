<script setup lang="ts">
import { injectToastProviderContext, ToastRoot, ToastTitle, ToastViewport } from "reka-ui";
import { CheckCircle2, Info, XCircle } from "lucide-vue-next";
import { t as translate } from "@/i18n";

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
      class="pointer-events-auto flex max-w-[min(92vw,32rem)] items-center gap-2 rounded-[var(--gosslan-radius-md)] px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm transition data-[limited]:hidden data-[swipe=move]:translate-x-[var(--reka-toast-swipe-move-x,0px)]"
      :class="toast.data?.kind === 'error' ? 'bg-[var(--gosslan-danger)]' : 'bg-[var(--gosslan-hud)]'"
    >
      <CheckCircle2 v-if="toast.data?.kind === 'success'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <XCircle v-else-if="toast.data?.kind === 'error'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <Info v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      <ToastTitle class="min-w-0" />
    </ToastRoot>
  </ToastViewport>
</template>
