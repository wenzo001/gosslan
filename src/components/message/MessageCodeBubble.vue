<script setup lang="ts">
import { computed } from "vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { CODE_CLAMP_HEIGHT } from "@/utils/previewMetrics";
import { Check, Copy } from "lucide-vue-next";

const props = defineProps<{
  /** inline code 消息取消息正文，代码附件取本地读到的文本。 */
  code: string;
  clamped: boolean;
  copied: boolean;
  dark: boolean;
}>();
const emit = defineEmits<{
  (e: "expand", code: string): void;
  (e: "copy", code: string): void;
}>();

/**
 * 操作条取 CodeBlock 代码区的同款底色与描边色（对应 CodeBlock.vue 的 codeBg / borderStyle），
 * 这样「代码块 + 操作条」是一整张卡片，中间不再露出聊天背景。
 */
const actionsStyle = computed(() => ({
  background: props.dark ? "#0d1117" : "#f6f8fa",
  borderColor: props.dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
}));
</script>

<template>
  <div class="min-w-0 flex-1">
    <div v-if="clamped" class="overflow-hidden rounded-t-lg" :style="{ height: `${CODE_CLAMP_HEIGHT}px` }">
      <CodeBlock :code="code" />
    </div>
    <CodeBlock v-else :code="code" />
    <!-- 操作条＝代码卡片的底栏：总高恒为 previewMetrics.CODE_ACTION_BAR(28px)，改样式不要动高度 -->
    <div class="code-actions" :class="clamped ? 'code-actions-divided' : ''" :style="actionsStyle">
      <button v-if="clamped" class="preview-action" @click="emit('expand', code)">展开显示</button>
      <button
        class="preview-action"
        :class="copied ? 'text-primary' : ''"
        @click="emit('copy', code)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? "已复制" : "复制" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
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
