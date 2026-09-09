<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import EmojiPicker from "@/components/EmojiPicker.vue";
import { QUOTE_BORDER, QUOTE_BG, QUOTE_TEXT_STYLE } from "@/utils/quoteStyle";
import { Code2, FilePlus, Smile, X } from "lucide-vue-next";
import type { MsgKind } from "@/types";

const props = defineProps<{
  /** 会话切换时聚焦输入框（切换会话 = 新会话，重置草稿由父组件卸载/挂载决定）。 */
  convId: string | null;
  /** 待引用消息（右键"引用"设置）；发送时拼进消息首行，显示为引用块。msgId 用于点击跳转原消息。 */
  quote?: { sender: string; snippet: string; msgId?: string | number } | null;
}>();
const emit = defineEmits<{
  (e: "send", payload: { content: string; kind: MsgKind }): void;
  (e: "attach"): void;
  (e: "close-quote"): void;
}>();

const app = useAppStore();
const draft = ref("");
const codeMode = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);

/** 输入框自适应高度：内容换行时自动长高，超过 5 行（max-h-32 ≈ 8rem）出现滚动。 */
function autoResize() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}

watch(draft, () => autoResize());
watch(codeMode, () => nextTick(() => autoResize()));

// 打开会话即聚焦输入框（移动端不自动弹软键盘）
watch(
  () => props.convId,
  async () => {
    await nextTick();
    if (!app.isMobile) inputRef.value?.focus();
    autoResize();
  },
  { immediate: true },
);

/** 发送：立即清空输入框（optimistic UI，不等 IPC 返回）。引用消息在首行拼接引用头。 */
function send(kind?: MsgKind, content?: string) {
  let text = content ?? draft.value;
  const k = kind ?? (codeMode.value ? "code" : "text");
  if (k === "text" && !text.trim()) return;
  if (k === "text" && props.quote && text.trim()) {
    const idSuffix = props.quote.msgId != null ? `|${props.quote.msgId}` : "";
    text = `「引用 ${props.quote.sender}：${props.quote.snippet}${idSuffix}」\n${text}`;
  }
  draft.value = "";
  if (!kind) codeMode.value = false;
  if (props.quote) emit("close-quote");
  // 清空 + DOM 更新后重新聚焦并把光标放到末尾：连续发送/继续输入无缝衔接
  // （Enter 与点击发送共用本函数，行为完全一致；autoResize 由既有 watch 驱动）
  void nextTick(() => {
    autoResize();
    if (!app.isMobile) {
      const el = inputRef.value;
      if (el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    }
  });
  emit("send", { content: text, kind: k });
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// ---------------- 表情面板 ----------------
const emojiOpen = ref(false);

/** 点击面板外关闭（面板自身已 @click.stop，触发按钮也 stop） */
function onDocClickForEmoji() {
  emojiOpen.value = false;
}
onMounted(() => document.addEventListener("click", onDocClickForEmoji));
onUnmounted(() => document.removeEventListener("click", onDocClickForEmoji));
watch(emojiOpen, () => {
  if (emojiOpen.value) autoResize();
});

/** 把表情插到输入框光标处（无光标信息则追加末尾），插入后收起面板（微信式：选完即关）。 */
function insertEmoji(e: string) {
  const el = inputRef.value;
  emojiOpen.value = false;
  if (!el) {
    draft.value += e;
    return;
  }
  const start = el.selectionStart ?? draft.value.length;
  const end = el.selectionEnd ?? draft.value.length;
  draft.value = draft.value.slice(0, start) + e + draft.value.slice(end);
  void nextTick(() => {
    el.focus();
    const pos = start + e.length;
    el.setSelectionRange(pos, pos);
    autoResize();
  });
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) {
        const dataUrl = await fileToDataUrl(f);
        send("image", dataUrl);
      }
      break;
    }
  }
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- 微信 4.0 输入卡：白底圆角带细边；文本域在上，图标行在卡内底部，发送键靠右下 -->
    <div class="rounded-lg border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 pb-1.5 pt-2">
      <!-- 引用预览条：右键"引用"后出现在输入框上方，可取消 -->
      <div
        v-if="quote"
        class="mb-1.5 flex items-center gap-2 rounded-md border-l-2 px-2 py-1 text-[12px]"
        :style="{ borderColor: QUOTE_BORDER, background: QUOTE_BG, color: 'var(--gosslan-text)' }"
      >
        <span class="min-w-0 flex-1 truncate" :style="QUOTE_TEXT_STYLE">引用 {{ quote.sender }}：{{ quote.snippet }}</span>
        <button
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:bg-[var(--gosslan-hover)]"
          title="取消引用"
          @click="emit('close-quote')"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        ref="inputRef"
        v-model="draft"
        maxlength="50000"
        class="min-h-12 w-full resize-none overflow-y-auto bg-transparent px-0.5 py-0.5 leading-relaxed outline-none placeholder:text-[var(--gosslan-text-2)]"
        :class="codeMode ? 'font-mono text-[13px]' : ''"
        :style="{ fontSize: 'var(--gosslan-msg-size, 14px)', overflowWrap: 'anywhere', wordBreak: 'break-word' }"
        :placeholder="codeMode ? '粘贴或输入代码…' : '输入消息…'"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
      <div class="mt-1 flex items-center gap-1">
        <div class="relative">
          <button
            class="flex h-7 w-7 items-center justify-center rounded-md transition"
            :class="emojiOpen ? 'text-primary' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
            title="表情"
            @click.stop="emojiOpen = !emojiOpen"
          >
            <Smile class="h-[18px] w-[18px]" />
          </button>
          <EmojiPicker :open="emojiOpen" @select="insertEmoji" @close="emojiOpen = false" />
        </div>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md transition"
          :class="codeMode ? 'text-primary' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
          title="代码消息"
          @click="codeMode = !codeMode"
        >
          <Code2 class="h-[18px] w-[18px]" />
        </button>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          title="发送文件（自动选择最优路线）"
          @click="emit('attach')"
        >
          <FilePlus class="h-[18px] w-[18px]" />
        </button>
        <button
          class="ml-auto flex h-7 shrink-0 items-center rounded-md bg-[var(--gosslan-hover)] px-4 text-[13px] transition"
          :class="draft.trim() ? 'text-primary hover:bg-[var(--gosslan-list-active)]' : 'cursor-default text-[var(--gosslan-text-2)]'"
          :disabled="!draft.trim()"
          @mousedown.prevent
          @click="send()"
        >
          发送
        </button>
      </div>
    </div>
  </div>
</template>
