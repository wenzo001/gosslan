<script setup lang="ts">
import BaseModal from "@/components/BaseModal.vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { Check, Copy } from "lucide-vue-next";

defineProps<{
  open: boolean;
  kind: "text" | "code";
  content: string;
  copied: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "copy", content: string): void;
}>();
</script>

<template>
  <!-- 全文弹窗：文本 / 代码共用，内容可滚动、可复制；关闭后消息布局不变 -->
  <BaseModal
    :open="open"
    :title="kind === 'code' ? '代码预览' : '完整文本'"
    width="max-w-4xl"
    @close="emit('close')"
  >
    <div class="max-h-[70vh] overflow-y-auto">
      <CodeBlock v-if="kind === 'code'" :code="content" />
      <div
        v-else
        class="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--gosslan-text)]"
        :style="{ wordBreak: 'break-word' }"
      >{{ content }}</div>
    </div>
    <div class="mt-3 flex justify-end">
      <button
        class="preview-action"
        :class="copied ? 'text-primary' : ''"
        @click="emit('copy', content)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? "已复制" : "复制" }}
      </button>
    </div>
  </BaseModal>
</template>
