<script setup lang="ts">
import { computed } from "vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { CODE_CLAMP_HEIGHT, CODE_SURFACE } from "@/utils/previewMetrics";
import { Check, Copy } from "lucide-vue-next";

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
/** 操作条与 CodeBlock 代码区同底同描边，衔接成一整张卡片。 */
const actionsStyle = computed(() => ({
  background: surface.value,
  borderColor: props.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
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
      class="overflow-hidden rounded-t-lg"
      :style="{ height: `${CODE_CLAMP_HEIGHT}px`, background: surface }"
    >
      <CodeBlock :code="code" flush-bottom />
    </div>
    <CodeBlock v-else :code="code" />
    <!-- 操作条＝代码卡片的底栏：总高恒为 previewMetrics.CODE_ACTION_BAR(28px)，改样式不要动高度 -->
    <div class="code-actions" :class="clamped ? 'code-actions-divided' : ''" :style="actionsStyle">
      <button v-if="clamped" class="preview-action" @click="emit('expand', code)">展开显示</button>
      <button
        class="preview-action"
        :class="copied ? 'opacity-100' : 'opacity-70 hover:opacity-100'"
        @click="emit('copy', code)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? "已复制" : "复制" }}
      </button>
    </div>
    <span aria-hidden="true" class="bubble-tail" :class="mine ? 'tail-mine' : 'tail-other'"></span>
  </div>
</template>

<style scoped>
/* 代码气泡尖角：代码卡片顶部是 32px toolbar，尖角对齐到 toolbar 中线（16px），
   与文本气泡（无 toolbar、top 10px）区分开。 */
.bubble-tail {
  top: 16px;
}
/* 代码卡片底栏：与上面的 CodeBlock 共用同款底色和描边，衔接成一张完整卡片。
   高度锁死 28px（border-box，含边框）= previewMetrics.CODE_ACTION_BAR，
   与代码块之间不留 margin，否则中间会露出聊天背景。 */
.code-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 4px;
  border-style: solid;
  border-width: 0 1px 1px;
  border-radius: 0 0 8px 8px;
}
/* 截断态代码块被裁掉、自身没有下边框，分隔线由底栏画；未截断态用 CodeBlock 的下边框，不重复叠加。 */
.code-actions-divided {
  border-top-width: 1px;
}
</style>
