<script setup lang="ts">
import { t } from "@/i18n";
import BubbleTail from "@/components/message/BubbleTail.vue";
import { computed } from "vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { CODE_CLAMP_HEIGHT, CODE_SURFACE } from "@/utils/previewMetrics";
import { Copy } from "lucide-vue-next";
import { Check } from "@/components/ui/icons";

const props = defineProps<{
  /** inline code 消息取消息正文，代码附件取本地读到的文本。 */
  code: string;
  clamped: boolean;
  copied: boolean;
  dark: boolean;
  /** 自己的消息气泡尖角朝右、对方朝左，指向头像。 */
  mine: boolean;
}>();
const emit = defineEmits<{
  (e: "expand", code: string): void;
  (e: "copy", code: string): void;
}>();

/**
 * 代码卡片底色（亮/暗）。截断容器 / 操作条 / 尖角三处必须同色：
 * 截断容器若透明，CodeBlock 实际高度不足 CODE_CLAMP_HEIGHT 时，容器底部会露出一条画布色亮缝。
 */
const surface = computed(() => (props.dark ? CODE_SURFACE.dark : CODE_SURFACE.light));
/** 操作条与 CodeBlock 代码区同底色（分隔线颜色仍取同款描边色）。 */
const actionsStyle = computed(() => ({
  background: surface.value,
  borderColor: "var(--gosslan-border)",
}));
/** 尖角取代码卡片底色（代码气泡不走 bubbleStyle，得自己给 --bubble-bg 赋值）。 */
const tailBg = computed(() => surface.value);
</script>

<template>
  <div class="relative min-w-0 flex-1" :style="{ '--bubble-bg': tailBg }">
    <!-- 截断容器固定 CODE_CLAMP_HEIGHT（与 VirtualList 的估算常量同源）。
         若容器透明，CodeBlock 实际渲染高度不足该值时，底部会空出一条画布色亮缝
         （卡片与操作条之间「露出聊天背景」）；故容器自身填卡片底色兜底。
         同时卡片不画下边框，分隔线统一由操作条上边框绘制，避免叠出双线。 -->
    <div
      v-if="clamped"
      class="overflow-hidden rounded-t-[var(--gosslan-radius-sm)]"
      :style="{ height: `${CODE_CLAMP_HEIGHT}px`, background: surface }"
    >
      <CodeBlock :code="code" attached />
    </div>
    <CodeBlock v-else :code="code" attached />
    <!-- 操作条＝代码卡片的底栏：总高恒为 previewMetrics.CODE_ACTION_BAR(28px)，改样式不要动高度 -->
    <div class="code-actions" :style="actionsStyle">
      <button v-if="clamped" class="tap-safe preview-action" @click="emit('expand', code)">{{ t("common.expand") }}</button>
      <button
        class="tap-safe preview-action"
        :class="copied ? 'opacity-100' : 'opacity-70 hover:opacity-100'"
        @click="emit('copy', code)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? t("common.copied") : t("common.copy") }}
      </button>
    </div>
    <BubbleTail :mine="mine" />
  </div>
</template>

<style scoped>
/* 代码气泡尖角：**位置跟全局 `.bubble-tail`（竖向对准头像中心），这里只补颜色。**
   卡片顶部是 32px 的 CodeBlock toolbar，尖角落在这一档里 ⇒ 相邻色是 toolbar 而不是卡片本体，
   直接用卡片色会比 toolbar 亮一档、仍能看出边界；蒙层与 CodeBlock 的 toolbarBg 同款
   （亮色 4% 黑 / 暗色 5% 白）。
   ⚠️ 旧版这里还写着 `top: auto; bottom: 12px`（把尖角钉在卡片底栏上），与头像完全错开 ——
   用户 2026-10-23 截图点名的就是这一格。位置只有全局那一个家，别在这里再钉一份。 */
/* 尾巴现在是 SVG：只换**填充**（描边仍取卡片边线 `--bubble-line`），
   所以覆盖的是 `--bubble-tail-fill` 而不是 background。 */
.bubble-tail.tail-mine,
.bubble-tail.tail-other {
  --bubble-tail-fill: color-mix(in srgb, var(--bubble-bg) 96%, #000);
}
:global(.dark) .bubble-tail.tail-mine,
:global(.dark) .bubble-tail.tail-other {
  --bubble-tail-fill: color-mix(in srgb, var(--bubble-bg) 95%, #fff);
}
/* 代码卡片底栏：与上面的 CodeBlock 共用同款底色，衔接成一张完整卡片。
   高度锁死 28px（border-box）= previewMetrics.CODE_ACTION_BAR，不要动。
   卡片已无描边，这里也只画「上分隔线」——代码区与底栏同色，没有这条线会糊成一片；
   四边描边则会让气泡重新出现一圈外描边（正是本次要去掉的东西）。 */
.code-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 4px;
  border-style: solid;
  border-width: 1px 0 0;
  border-radius: 0 0 var(--gosslan-radius-md) var(--gosslan-radius-md);
}
</style>
