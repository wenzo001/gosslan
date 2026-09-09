<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/stores/useAppStore";
import { PREVIEW_LINES } from "@/utils/previewMetrics";
import { linkify, displayUrl, type LinkSegment } from "@/utils/linkify";
import { QUOTE_BORDER, QUOTE_BG, QUOTE_TEXT_STYLE } from "@/utils/quoteStyle";
import { Check, Copy } from "lucide-vue-next";

const props = defineProps<{
  content: string;
  bubbleStyle: CSSProperties;
  /** 超过预览行数：正文截断为固定行数，「展开显示」走独立 Modal。 */
  clamped: boolean;
  copied: boolean;
}>();
const emit = defineEmits<{
  (e: "expand", content: string): void;
  (e: "copy", content: string): void;
  (e: "locate", msgId: string): void;
}>();

const app = useAppStore();

/** 截断行数由 PREVIEW_LINES 驱动，避免 Tailwind 类名与估算常量各写一份。 */
const clampStyle = computed<CSSProperties>(() =>
  props.clamped
    ? {
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: PREVIEW_LINES,
        overflow: "hidden",
      }
    : {},
);
const bubbleStyle = computed<CSSProperties>(() => ({
  ...props.bubbleStyle,
  fontSize: "var(--gosslan-msg-size, 14px)",
}));

// ---------------- 引用解析 ----------------
// 引用消息的 content 首行为 `「引用 {sender}：{snippet}|{msg_id}」`（msg_id 可省略），
// 其余为正文。渲染成引用块（左侧竖线 + 灰字），带 msg_id 时可点击跳转原消息；
// 复制/转发仍是完整原文。
const QUOTE_PREFIX = "「引用 ";

const parsed = computed(() => {
  if (!props.content.startsWith(QUOTE_PREFIX)) return { quote: "", body: props.content, msgId: "" };
  const nl = props.content.indexOf("\n");
  if (nl < 0 || !props.content.slice(0, nl).trimEnd().endsWith("」")) {
    return { quote: "", body: props.content, msgId: "" };
  }
  let line = props.content.slice(0, nl).trimEnd();
  let msgId = "";
  const m = line.match(/\|([^\s|」]+)」$/);
  if (m) {
    msgId = m[1];
    line = line.slice(0, m.index) + "」";
  }
  return { quote: line, body: props.content.slice(nl + 1), msgId };
});

/** 正文切成 text/link 段，按段渲染（不拼 HTML，天然防 XSS）。 */
const segments = computed<LinkSegment[]>(() => linkify(parsed.value.body));

/** 点击链接：调 Tauri opener 走系统默认浏览器；失败 toast 提示。 */
async function openLink(href: string) {
  try {
    await openUrl(href);
  } catch (e) {
    app.toast(`打开链接失败：${e}`, "error");
  }
}
</script>

<template>
  <div
    class="group relative min-w-0 px-3 py-2 leading-relaxed"
    :style="bubbleStyle"
  >
    <!-- 引用块：首行「引用 发送者：片段」，带 msg_id 时可点击跳转原消息 -->
    <button
      v-if="parsed.quote && parsed.msgId"
      class="quote-block mb-1.5 block w-full cursor-pointer rounded-md border-l-2 px-2 py-1 text-left text-[12px] leading-4 transition hover:brightness-110"
      :style="{ borderColor: QUOTE_BORDER, background: QUOTE_BG }"
      :title="`点击定位到原消息（${parsed.msgId}）`"
      @click="emit('locate', parsed.msgId)"
    >
      <span class="quote-text" :style="QUOTE_TEXT_STYLE">{{ parsed.quote }}</span>
    </button>
    <div
      v-else-if="parsed.quote"
      class="quote-block mb-1.5 rounded-md border-l-2 px-2 py-1 text-[12px] leading-4"
      :style="{ borderColor: QUOTE_BORDER, background: QUOTE_BG }"
    >
      <span class="quote-text" :style="QUOTE_TEXT_STYLE">{{ parsed.quote }}</span>
    </div>
    <div
      class="whitespace-pre-wrap break-words"
      :style="{ wordBreak: 'break-word', ...clampStyle }"
    >
      <template v-for="(seg, i) in segments" :key="i">
        <a
          v-if="seg.kind === 'link'"
          class="cursor-pointer break-all underline decoration-1 underline-offset-2 transition hover:opacity-80"
          :title="seg.href"
          @click.stop.prevent="openLink(seg.href)"
        >{{ displayUrl(seg.value) }}</a>
        <span v-else>{{ seg.value }}</span>
      </template>
    </div>
    <!-- 长文本操作条：高度固定，展开走独立 Modal，消息 DOM 不再变化 -->
    <div
      v-if="clamped"
      class="mt-1.5 flex items-center gap-2 border-t pt-1.5"
      :style="{ borderColor: 'rgba(128,128,128,0.2)' }"
    >
      <button class="text-xs opacity-70 transition hover:opacity-100" @click="emit('expand', content)">
        展开显示
      </button>
      <button
        class="flex items-center gap-1 whitespace-nowrap text-xs transition"
        :class="copied ? 'text-primary' : 'opacity-70 hover:opacity-100'"
        @click="emit('copy', content)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? "已复制" : "复制" }}
      </button>
    </div>
    <!-- 普通文本：不显示悬停复制气泡（复制走右键菜单），避免干扰 -->
  </div>
</template>
