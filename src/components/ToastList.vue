<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { injectToastProviderContext, ToastClose, ToastRoot, ToastTitle, ToastViewport } from "reka-ui";
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

/**
 * 条真正关闭（到点 / 手动按钮 / Esc / 滑动）时库会发 `update:open = false`：
 * 那才是释放「×N」计数的时机。`ToastRoot` **没有** `close` 事件 —— 旧绑定是死代码。
 */
function onOpenChange(id: string, open: boolean) {
  if (!open) releaseToastCount(id);
}
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
      @update:open="(open: boolean) => onOpenChange(toast.id, open)"
    >
      <Icon name="check-circle2" v-if="toast.data?.kind === 'success'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <Icon name="x-circle" v-else-if="toast.data?.kind === 'error'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <Icon name="info" v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      <ToastTitle class="min-w-0" />
      <!-- 同 key 重复时只加计数，不叠新条（A1 裁决）。
           计数 chip 必须是**暗**的叠层（2026-11-08 按场景普查量出来的）：白字压在 danger 实底上
           本来 4.9，叠 20% 白后有效底被提亮到 3.7 ⇒ 11px 的「×N」读不动。叠 25% 黑把底压深，
           白字回到 7.x；普通 toast 的 hud 底同理。 -->
      <span
        v-if="(toast.data?.count ?? 1) > 1"
        data-toast-count
        class="shrink-0 rounded-[var(--gosslan-radius-sm)] bg-black/25 px-1.5 py-0.5 text-xs font-medium tabular-nums"
      >×{{ toast.data!.count }}</span>
      <!--
        只有"说得出下一步"的失败才带按钮（目前只有辅助窗口创建失败）。
        用库的 `ToastClose` 当容器：点按钮会顺手关掉这条 toast，不需要自己管计时。
      -->
      <ToastClose
        v-if="toast.data?.action"
        class="ml-2 shrink-0 rounded-[var(--gosslan-radius-sm)] bg-black/25 px-2 py-0.5 text-xs font-medium hover:bg-black/35"
        @click="toast.data.action.run()"
      >
        {{ toast.data.action.label }}
      </ToastClose>
    </ToastRoot>
  </ToastViewport>
</template>
