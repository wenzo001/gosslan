<script setup lang="ts">
/**
 * Toast HUD：应用内唯一的轻量反馈层（发送失败 / 删除失败 / 操作成功都靠它）。
 *
 * 抽成组件的原因：独立窗口（如群任务窗口）也要显示 toast —— 否则那些窗口里的
 * "创建/更新失败"是**静默**的（用户点了没反应）。主窗口（`ResponsiveLayout`）与
 * 各独立窗口共用这一份。
 *
 * 定位固定在窗口顶部居中：`left-1/2 -translate-x-1/2` + 安全区顶部偏移。
 */
import { useAppStore } from "@/stores/useAppStore";
import { CheckCircle2, Info, XCircle } from "lucide-vue-next";

const app = useAppStore();
</script>

<template>
  <!-- 统一中性 HUD 底 + 白字（微信式，与主题色解耦；错误红保留语义）。
       底色走 --gosslan-hud：亮色是深灰、暗色抬亮一档，两套主题下都是"浮在界面之上"的一层。
       ♿ role="status" + aria-live：toast 是**唯一的失败反馈通道**（发送失败/删除失败都靠它），
       没有 live region 时读屏用户完全收不到 —— 等于失败被静默。polite 而非 assertive，
       避免连续失败时打断朗读；每条 aria-atomic 让整句被完整播报而不是只读增量。
       图标纯装饰，标 aria-hidden，否则读屏会念出图形名。 -->
  <div
    role="status"
    aria-live="polite"
    class="pointer-events-none fixed left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2"
    :style="{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }"
  >
    <div
      v-for="t in app.toasts"
      :key="t.id"
      aria-atomic="true"
      class="flex items-center gap-2 rounded-[var(--gosslan-radius-md)] px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm"
      :class="t.type === 'error' ? 'bg-[var(--gosslan-danger)]' : 'bg-[var(--gosslan-hud)]'"
    >
      <CheckCircle2 v-if="t.type === 'success'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <XCircle v-else-if="t.type === 'error'" class="h-4 w-4 shrink-0" aria-hidden="true" />
      <Info v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
      {{ t.text }}
    </div>
  </div>
</template>
