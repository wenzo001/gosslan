<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/useAppStore";
import EmojiPicker from "@/components/EmojiPicker.vue";
import { QUOTE_BORDER, QUOTE_BG, QUOTE_TEXT_STYLE } from "@/utils/quoteStyle";
import { mentionHighlightColor, resolveChatColors } from "@/utils/chatStyle";
import { avatarInitial, nameToColor } from "@/utils/color";
import { Code2, FilePlus, Smile, X } from "lucide-vue-next";
import type { MsgKind } from "@/types";

const props = defineProps<{
  /** 会话切换时聚焦输入框（切换会话 = 新会话，重置草稿由父组件卸载/挂载决定）。 */
  convId: string | null;
  /** 待引用消息（右键"引用"设置）；发送时拼进消息首行，显示为引用块。msgId 用于点击跳转原消息。 */
  quote?: { sender: string; snippet: string; msgId?: string | number } | null;
  /** 群成员（不含自己）：非空时输入 @ 弹出成员选择（群聊 @ 功能）。 */
  mentionMembers?: { id: string; name: string }[];
}>();
const emit = defineEmits<{
  (e: "send", payload: { content: string; kind: MsgKind }): void;
  (e: "send-image", dataUrl: string): void;
  (e: "attach"): void;
  (e: "close-quote"): void;
  (e: "paste-files", paths: string[]): void;
}>();

const app = useAppStore();
const codeMode = ref(false);
// ---------------- contenteditable 输入框（DOM 为源，uncontrolled） ----------------
// textarea 画不了局部颜色、overlay mirror 又会排版错位（已踩坑回退），改用
// contenteditable：@提及 是真正的内联原子 token（contenteditable=false 的 span，
// 退格整删、光标原生管理）。Vue 不控制 innerHTML（受控重渲染会毁光标/IME），
// 只在 input 事件里把「是否可发送」投影成响应式 hasDraft；发送时读 innerText。
const editorRef = ref<HTMLDivElement | null>(null);
const hasDraft = ref(false);

/** @提及 高亮文字色：输入框底是面板（亮白/暗深灰），按对方气泡同档中性底校验对比。 */
const composerMentionFg = computed(() =>
  mentionHighlightColor(
    app.themeColor,
    app.dark,
    resolveChatColors("theme", app.themeColor, app.dark).otherBubble,
  ),
);

/** 输入框自适应高度：内容换行时自动长高，超过 5 行（128px）出现滚动。 */
function autoResize() {
  const el = editorRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
}

/** 清空但残留空壳（空的 div/br）时规范化为真·空，让 :empty 的 placeholder 回来。 */
function normalizeEmpty() {
  const el = editorRef.value;
  if (el && el.innerText.trim() === "") el.innerHTML = "";
}

watch(codeMode, () => nextTick(() => autoResize()));

// 打开会话即聚焦输入框（移动端不自动弹软键盘）
watch(
  () => props.convId,
  async () => {
    await nextTick();
    if (!app.isMobile) focusEditor();
    autoResize();
  },
  { immediate: true },
);

/** 聚焦编辑器；atEnd 时把 caret 挪到内容末尾（发送后/切会话用）。 */
function focusEditor(atEnd = true) {
  const el = editorRef.value;
  if (!el) return;
  el.focus();
  if (!atEnd) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 序列化草稿：innerText 把 token 读成 @名字、<br>/块边界读成 \n；
 *  块尾的 \n 是渲染 artifact，剥掉；maxlength 语义挪到发送前截断兜底。 */
function serializeDraft(): string {
  return (editorRef.value?.innerText ?? "").replace(/\n+$/, "").slice(0, 50000);
}

/** 发送：立即清空输入框（optimistic UI，不等 IPC 返回）。引用消息在首行拼接引用头。 */
function send(kind?: MsgKind, content?: string) {
  let text = content ?? serializeDraft();
  const k = kind ?? (codeMode.value ? "code" : "text");
  if (k === "text" && !text.trim()) return;
  if (k === "text" && props.quote && text.trim()) {
    const idSuffix = props.quote.msgId != null ? `|${props.quote.msgId}` : "";
    text = `「引用 ${props.quote.sender}：${props.quote.snippet}${idSuffix}」\n${text}`;
  }
  if (editorRef.value) editorRef.value.innerHTML = "";
  hasDraft.value = false;
  mention.value = null;
  if (!kind) codeMode.value = false;
  if (props.quote) emit("close-quote");
  // 清空 + DOM 更新后重新聚焦并把 caret 放到末尾：连续发送/继续输入无缝衔接
  void nextTick(() => {
    autoResize();
    if (!app.isMobile) focusEditor();
  });
  emit("send", { content: text, kind: k });
}

function onKeydown(e: KeyboardEvent) {
  // 微信式 token 联删：caret 前是「token + 尾随 nbsp」时一次退格删掉两者
  // （token 本身是原子，浏览器默认已整删；只补 nbsp 这一格的差距）。
  if (e.key === "Backspace" && !e.isComposing && deleteMentionBeforeCaret()) {
    e.preventDefault();
    return;
  }
  // @ 选择器打开时：↑↓ 导航、Enter 选中（吞掉发送）、Esc 关闭，其余键正常输入
  if (mention.value && mentionFiltered.value.length > 0) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mentionActive.value = (mentionActive.value + 1) % mentionFiltered.value.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mentionActive.value =
        (mentionActive.value - 1 + mentionFiltered.value.length) % mentionFiltered.value.length;
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      applyMention(mentionFiltered.value[mentionActive.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      mention.value = null;
      return;
    }
  }
  // 中文 IME 确认候选的 Enter 也带 isComposing=true，必须放行，否则选字=发送
  if (e.key === "Enter" && e.shiftKey && !e.isComposing) {
    // 统一换行为 <br>：浏览器默认 insertParagraph 会造嵌套 div，序列化不可控
    e.preventDefault();
    document.execCommand("insertLineBreak");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

// ---------------- 群聊 @ 成员选择 ----------------
/** 触发态：caret 前最近的 @query（无空白隔断）；startIndex 是 @ 在所在文本节点内的偏移。 */
const mention = ref<{ query: string; startIndex: number } | null>(null);
const mentionActive = ref(0);

const mentionFiltered = computed(() => {
  if (!mention.value) return [];
  const q = mention.value.query.toLowerCase();
  const list = props.mentionMembers ?? [];
  return (q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list).slice(0, 8);
});

function isMentionSpan(n: Node | null): boolean {
  return n !== null && n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains("mention-token");
}

/** caret 的 Range 上下文：仅当 selection 折叠且落在编辑器内的文本节点上时有效。 */
function caretContext(): { node: Text; offset: number } | null {
  const el = editorRef.value;
  const sel = window.getSelection();
  if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const node = sel.focusNode;
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
  return { node: node as Text, offset: sel.focusOffset };
}

/** 由 caret 位置推导 @ 触发态（输入/点击/方向键挪 caret 时都会调用）。 */
function updateMentionState() {
  if (!props.mentionMembers?.length) {
    mention.value = null;
    return;
  }
  const ctx = caretContext();
  if (!ctx) {
    mention.value = null;
    return;
  }
  const m = (ctx.node.textContent ?? "").slice(0, ctx.offset).match(/@([^\s@]{0,20})$/);
  if (m) {
    const start = ctx.offset - m[0].length;
    const sameAt = mention.value?.startIndex === start;
    mention.value = { query: m[1], startIndex: start };
    if (!sameAt) mentionActive.value = 0;
  } else {
    mention.value = null;
  }
}

/** 选中成员：把「@query」替换为 mention token（原子 span）+ 尾随 nbsp，caret 落到 nbsp 后。 */
function applyMention(member: { id: string; name: string }) {
  const el = editorRef.value;
  const sel = window.getSelection();
  if (!el || !sel || sel.rangeCount === 0) return;
  const ctx = caretContext();
  if (!ctx) return;
  const m = (ctx.node.textContent ?? "").slice(0, ctx.offset).match(/@([^\s@]{0,20})$/);
  if (!m) return;
  const range = document.createRange();
  range.setStart(ctx.node, ctx.offset - m[0].length);
  range.setEnd(ctx.node, ctx.offset);
  range.deleteContents();
  // token：不可编辑原子 → 退格/选区删除天然整块处理；nbsp 保证 token 与后续文字不粘连
  // （接收端「被 @ 检测」要求 @名字 后是空白边界，nbsp 的 \u00A0 恰在 JS \s 集合内）
  const span = document.createElement("span");
  span.className = "mention-token";
  span.contentEditable = "false";
  span.dataset.mentionId = member.id;
  span.dataset.mentionName = member.name;
  if (composerMentionFg.value) span.style.color = composerMentionFg.value;
  span.textContent = `@${member.name}`;
  range.collapse(false);
  range.insertNode(span);
  const space = document.createTextNode("\u00A0");
  span.after(space);
  range.setStart(space, 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  mention.value = null;
  if (!app.isMobile) el.focus();
  autoResize();
}

/** caret 前是「token 尾随的 nbsp」→ 连 token 一起删（微信式一次退格删全）。
 *  token 紧邻 caret（无 nbsp）的场景交给浏览器：原子 span 本就整块删除。 */
function deleteMentionBeforeCaret(): boolean {
  const el = editorRef.value;
  if (!el) return false;
  const ctx = caretContext();
  if (!ctx) return false;
  const { node, offset } = ctx;
  const text = node.textContent ?? "";
  if (offset !== 1 || text[offset - 1] !== "\u00A0") return false;
  const prev = node.previousSibling;
  if (!isMentionSpan(prev) || !prev) return false;
  const range = document.createRange();
  range.setStartBefore(prev);
  range.setEnd(node, 1);
  range.deleteContents();
  normalizeEmpty();
  return true;
}

/** input 统一入口：投影 hasDraft、规范化空壳、非组合输入时更新 @ 触发态。 */
function onInput(e: Event) {
  const el = editorRef.value;
  hasDraft.value = (el?.innerText.trim().length ?? 0) > 0;
  normalizeEmpty();
  if (!(e as InputEvent).isComposing) updateMentionState();
}

/** 方向键挪 caret 不触发 input/click：监听 selectionchange 兜底关弹层/换过滤。 */
function onSelectionChange() {
  const el = editorRef.value;
  if (!el || document.activeElement !== el) return;
  updateMentionState();
}

// ---------------- 表情面板 ----------------
const emojiOpen = ref(false);

/** 点击面板外关闭（面板自身已 @click.stop，触发按钮也 stop） */
function onDocClickForEmoji() {
  emojiOpen.value = false;
}
/** @ 成员选择：点击输入卡以外任意处关闭（卡内点击交给 updateMentionState 按光标推断） */
function onDocClickForMention(e: MouseEvent) {
  if (composerCard.value?.contains(e.target as Node)) return;
  mention.value = null;
}
const composerCard = ref<HTMLElement | null>(null);
onMounted(() => {
  document.addEventListener("click", onDocClickForEmoji);
  document.addEventListener("click", onDocClickForMention);
  document.addEventListener("selectionchange", onSelectionChange);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClickForEmoji);
  document.removeEventListener("click", onDocClickForMention);
  document.removeEventListener("selectionchange", onSelectionChange);
});
watch(emojiOpen, () => {
  if (emojiOpen.value) autoResize();
});

/** 把表情插到输入框 caret 处（insertText 保 undo 栈）；caret 不在编辑器内则追加末尾。 */
function insertEmoji(e: string) {
  const el = editorRef.value;
  emojiOpen.value = false;
  if (!el) return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    document.execCommand("insertText", false, e);
  } else {
    el.appendChild(document.createTextNode(e));
    if (!app.isMobile) focusEditor();
  }
  autoResize();
}

async function onPaste(e: ClipboardEvent) {
  const cd = e.clipboardData;
  if (!cd) return;
  // 剪贴板带文件数据：同步先拦掉默认插入（await 之后再 preventDefault 就晚了），
  // 再问原生剪贴板里是否有真实文件（资源管理器复制的 CF_HDROP）——
  // 有 → 直接当文件发送（微信式）；没有 → 是位图（截图/网页图片），走下方图片分支。
  if (Array.from(cd.types ?? []).includes("Files")) {
    e.preventDefault();
    try {
      const paths = await invoke<string[]>("read_clipboard_file_paths");
      if (paths.length > 0) {
        emit("paste-files", paths);
        return;
      }
    } catch {
      // 非 Windows / 命令缺失 → 回退图片分支
    }
    for (const item of Array.from(cd.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) {
          // P1：粘贴图片走 save_outgoing_image → 文件传输，data URL 不进入 SQLite
          const dataUrl = await fileToDataUrl(f);
          emit("send-image", dataUrl);
        }
        return;
      }
    }
    return;
  }
  // 纯文本：contenteditable 默认粘贴会带外来 HTML 结构（污染 token/样式），
  // 统一拦掉按纯文本插入（execCommand 保 undo 栈；含 \n 时 Chromium 自行转 <br>）。
  e.preventDefault();
  const text = cd.getData("text/plain");
  if (text) document.execCommand("insertText", false, text);
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
    <div ref="composerCard" class="relative rounded-lg border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 pb-1.5 pt-2">
      <!-- 群聊 @ 成员选择：输入 @ 后浮出，↑↓ 导航 / Enter 或点击选中 -->
      <div
        v-if="mention && mentionFiltered.length > 0"
        class="frost absolute bottom-full left-2 right-2 z-30 mb-2 max-h-44 overflow-y-auto rounded-lg border border-[var(--gosslan-border)] p-1 shadow-lg"
      >
        <div class="px-2 py-1 text-[11px] text-[var(--gosslan-text-2)]">选择提醒的人</div>
        <button
          v-for="(m, i) in mentionFiltered"
          :key="m.id"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition"
          :class="i === mentionActive ? 'bg-[var(--gosslan-list-active)]' : 'hover:bg-[var(--gosslan-hover)]'"
          @mousedown.prevent
          @click="applyMention(m)"
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] text-white"
            :style="{ backgroundColor: nameToColor(m.name) }"
          >{{ avatarInitial(m.name) }}</span>
          <span class="min-w-0 flex-1 truncate">{{ m.name }}</span>
        </button>
      </div>
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
      <!-- contenteditable 编辑区：@提及 为内联原子 token（高亮+整删），placeholder 走 :empty::before -->
      <div
        ref="editorRef"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        class="min-h-12 w-full overflow-y-auto bg-transparent px-0.5 py-0.5 leading-relaxed outline-none whitespace-pre-wrap break-words"
        :class="codeMode ? 'font-mono text-[13px]' : ''"
        :style="{ fontSize: 'var(--gosslan-msg-size, 14px)', overflowWrap: 'anywhere', wordBreak: 'break-word' }"
        :data-placeholder="codeMode ? '粘贴或输入代码…' : '输入消息…'"
        @keydown="onKeydown"
        @input="onInput"
        @click="updateMentionState"
        @paste="onPaste"
      ></div>
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
          :class="hasDraft ? 'text-primary hover:bg-[var(--gosslan-list-active)]' : 'cursor-default text-[var(--gosslan-text-2)]'"
          :disabled="!hasDraft"
          @mousedown.prevent
          @click="send()"
        >
          发送
        </button>
      </div>
    </div>
  </div>
</template>
