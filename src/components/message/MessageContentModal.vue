<script setup lang="ts">
import { computed } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/stores/useAppStore";
import BaseModal from "@/components/BaseModal.vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { linkify, displayUrl, type LinkSegment } from "@/utils/linkify";
import { splitEmoji } from "@/utils/emoji";
import { Check, Copy } from "lucide-vue-next";

const props = defineProps<{
  open: boolean;
  kind: "text" | "code";
  content: string;
  copied: boolean;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "copy", content: string): void;
}>();

const app = useAppStore();
type RenderSegment = LinkSegment | { kind: "emoji"; value: string; name: string; url: string };
const segments = computed<RenderSegment[]>(() => {
  if (props.kind !== "text") return [];
  const out: RenderSegment[] = [];
  for (const s of splitEmoji(props.content)) {
    if (s.kind === "emoji") out.push({ kind: "emoji", value: s.value, name: s.name, url: s.url });
    else out.push(...linkify(s.value));
  }
  return out;
});

async function openLink(href: string) {
  try {
    await openUrl(href);
  } catch (e) {
    app.toast(`打开链接失败：${e}`, "error");
  }
}
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
      >
        <template v-for="(seg, i) in segments" :key="i">
          <a
            v-if="seg.kind === 'link'"
            class="cursor-pointer break-all text-primary underline decoration-1 underline-offset-2 transition hover:opacity-80"
            :title="seg.href"
            @click.stop.prevent="openLink(seg.href)"
          >{{ displayUrl(seg.value) }}</a>
          <img
            v-else-if="seg.kind === 'emoji'"
            :src="seg.url"
            :alt="seg.value"
            :title="seg.value"
            class="emoji-img"
          />
          <span v-else>{{ seg.value }}</span>
        </template>
      </div>
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
