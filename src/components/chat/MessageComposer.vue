<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { t } from "@/i18n";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useAppStore } from "@/stores/useAppStore";
import { MAX_PASTED_IMAGE_BYTES, PASTED_IMAGE_LIMIT_MB } from "@/utils/imageBytes";
import EmojiPicker from "@/components/EmojiPicker.vue";
import { QUOTE_BORDER, QUOTE_BG, QUOTE_TEXT_STYLE } from "@/utils/quoteStyle";
import { buildQuoteHeader } from "@/utils/quote";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { clearComposerDraft, getComposerDraft, saveComposerDraft } from "@/utils/composerDrafts";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { haptic } from "@/utils/haptics";
import { shouldRunThrottled } from "@/utils/defer";
import { mentionHighlightColor, resolveChatColors } from "@/utils/chatStyle";
import { classifyPaste } from "@/utils/clipboard";
import { isImeKey } from "@/utils/ime";
import { X } from "@/components/ui/icons";
import type { MsgKind } from "@/types";
import { MENTION_ALL_TOKEN, textMentionsName } from "@/utils/messages";
import { isMentionLead } from "@/utils/linkify";
import { isSelfConversation } from "@/utils/selfChat";
import { detectCode, stripCodeFence } from "@/utils/codeDetect";
import { requestDetectLanguage } from "@/utils/codeHighlight";
import CodeLangMenu from "@/components/CodeLangMenu.vue";
import { api } from "@/api";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import { composerMaxHeight, clampComposerHeight } from "@/utils/composerLayout";
import { pastedImageRejection, type PastedImageRejection } from "@/utils/composerAttachments";
import { emojiUrl } from "@/utils/emoji";
import { POPOVER_EDGE } from "@/utils/popoverBounds";

const props = defineProps<{
  /** 会话切换时聚焦输入框（切换会话 = 新会话，重置草稿由父组件卸载/挂载决定）。 */
  convId: string | null;
  /** 待引用消息（右键"引用"设置）；发送时拼进消息首行，显示为引用块。msgId 用于点击跳转原消息。 */
  quote?: { sender: string; snippet: string; msgId?: string | number } | null;
  /** 群成员（不含自己）：非空时输入 @ 弹出成员选择（群聊 @ 功能）。 */
  mentionMembers?: { id: string; name: string }[];
  /** 是否显示「抖动」按钮：仅单聊（非群聊、非自聊）为 true。群聊/自聊无意义，不给入口。 */
  shakeEnabled?: boolean;
}>();
const emit = defineEmits<{
  // `mentionIds` = 这条文本 @ 了谁（设备 id）。缺省 = 这条不带名单 = 接收端按昵称兜底，
  // 与"空数组 = 明确回答谁都没 @"是两回事，所以这里不能给默认值。
  (e: "send", payload: { content: string; kind: MsgKind; mentionIds?: string[]; lang?: string | null }): void;
  // 交出去的是 **File 本身**，不是 data URL：读文件是异步的，若在组件里 await 完再 emit，
  // 接收方只能在"读完之后"才知道要发给谁 —— 期间用户切了会话，图片就发到别的会话去了。
  // 读取挪到发送方，让会话 id 在按下发送的那一刻被同步捕获（审计阶段 4 · 4.1-5）。
  (e: "send-image", file: File): void;
  (e: "attach"): void;
  (e: "close-quote"): void;
  (e: "paste-files", paths: string[]): void;
  (e: "shake"): void;
}>();

const app = useAppStore();

/**
 * 当前会话是不是「和自己聊天」。自聊只支持文本（用户 2026-09-16），
 * 所以这里要拿掉附件入口、并把粘贴文件拦成一条明确提示
 * （拦不住的入口（粘贴/拖入）宁可明确报错，也不要让消息静默消失）。
 */
const isSelfChat = computed(() =>
  isSelfConversation({ id: props.convId ?? "" }, app.device?.device_id),
);
const codeMode = ref(false);
/** 自动识别出来的代码模式：与手动开关分开，撤销只关自动那一次。 */
const autoCode = ref(false);
const autoCodeLang = ref<string | null>(null);
const autoCodeSuppressed = ref(false);
/** 发送前用户选定/自动识别出的语言；null = 自动（渲染端再按内容识别）。 */
const codeLang = ref<string | null>(null);
/** 每次手动改语言都递增，晚到的异步识别结果不许覆盖用户的选择。 */
let codeLangSeq = 0;
let codeDetectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCodeDetect() {
  if (codeMode.value || autoCodeSuppressed.value) return;
  if (codeDetectTimer) clearTimeout(codeDetectTimer);
  codeDetectTimer = setTimeout(() => {
    codeDetectTimer = null;
    if (codeMode.value || autoCodeSuppressed.value) return;
    const draft = serializeDraft();
    const d = detectCode(draft);
    if (!d.likely) return;
    codeMode.value = true;
    autoCode.value = true;
    autoCodeLang.value = d.language;
    codeLang.value = d.language;
    // 未标语言的围栏/粘贴代码：语言交给 Worker 里的 highlightAuto（成熟方案），
    // 识别不确定就保持 null（发送后渲染端会落纯文本），绝不在这里手写正则猜。
    if (!d.language) {
      const token = ++codeLangSeq;
      void requestDetectLanguage(stripCodeFence(draft).text).then((lang) => {
        if (!lang || token !== codeLangSeq || !autoCode.value || !codeMode.value) return;
        autoCodeLang.value = lang;
        codeLang.value = lang;
      });
    }
  }, 250);
}
function onCodeLangChange(value: string | null) {
  codeLangSeq++;
  codeLang.value = value;
  autoCodeLang.value = value;
  autoCode.value = false;
}
function toggleCodeMode() {
  codeMode.value = !codeMode.value;
  autoCode.value = false;
  autoCodeLang.value = null;
  codeLang.value = null;
  autoCodeSuppressed.value = true;
}
function undoAutoCode() {
  codeMode.value = false;
  autoCode.value = false;
  autoCodeLang.value = null;
  codeLang.value = null;
  autoCodeSuppressed.value = true;
}
onUnmounted(() => {
  if (codeDetectTimer) clearTimeout(codeDetectTimer);
});

/**
 * 抖动冷却（毫秒）：与 QQ 一致 —— 短时间不能连抖，避免刷屏打扰对方。
 * 冷却期间按钮置灰不可点；这是**纯 UI 节流**，真正的发送链路在 store。
 */
const SHAKE_COOLDOWN_MS = 3000;
const shakeCooling = ref(false);
let shakeTimer: ReturnType<typeof setTimeout> | null = null;

function onShakeClick() {
  if (shakeCooling.value || !props.shakeEnabled) return;
  emit("shake");
  haptic("light");
  shakeCooling.value = true;
  shakeTimer = setTimeout(() => {
    shakeCooling.value = false;
    shakeTimer = null;
  }, SHAKE_COOLDOWN_MS);
}

/** 草稿**总量**的字符硬上限。三处兜底：粘贴按剩余容量截断、发送前再截一次。
 *  为什么要按总量（而不是"单次粘贴量"）：按住 Ctrl+V 连发时每次都会成功插入一份，
 *  草稿无界增长 ⇒ contenteditable 的布局/绘制成本随字符数线性上升，越粘越卡。 */
const MAX_INPUT_LENGTH = 50_000;

/**
 * 草稿总长度上限提示的节流窗口（ms）。
 * 按住 Ctrl+V 连发时每次粘贴都会撞上限，提示必须节流，否则刷屏。
 */
const FULL_WARN_INTERVAL_MS = 3000;
let lastFullWarnAt = 0;

/** 草稿已满时提示一次（3 秒内不重复）。 */
function warnDraftFull() {
  const now = Date.now();
  if (!shouldRunThrottled(now, lastFullWarnAt, FULL_WARN_INTERVAL_MS)) return;
  lastFullWarnAt = now;
  app.toast(t("chat.composer.tooLong", { max: MAX_INPUT_LENGTH }), "error");
}
// ---------------- contenteditable 输入框（DOM 为源，uncontrolled） ----------------
// textarea 画不了局部颜色、overlay mirror 又会排版错位（已踩坑回退），改用
// contenteditable：@提及 是真正的内联原子 token（contenteditable=false 的 span，
// 退格整删、光标原生管理）。Vue 不控制 innerHTML（受控重渲染会毁光标/IME），
// 只在 input 事件里把「是否可发送」投影成响应式 hasDraft；发送时读 innerText。
const editorRef = ref<HTMLDivElement | null>(null);
const hasDraft = ref(false);

/**
 * 编辑区封顶高度（px）。按实际字号算：设置里字号有 13/14/16 三档，
 * 固定 128px 会让「几行封顶」随字号漂移。字号变化时由下面的 watch 重算。
 */
const composerMaxPx = ref(composerMaxHeight(14));
function measureComposerMax() {
  const el = editorRef.value;
  if (!el) return;
  const fontSize = Number.parseFloat(getComputedStyle(el).fontSize);
  composerMaxPx.value = composerMaxHeight(fontSize);
}

/**
 * 输入框自适应高度：内容换行时平滑长高，5 行封顶后内部滚动。
 *
 * ⚠️ 不能再用「把 height 设 auto、读 scrollHeight、再写回 px」的老办法：
 * 读到 scrollHeight 时浏览器已经把 auto 落成内容高度，收缩时过渡的起点变成
 * 「内容高度」而不是「旧高度」——实测 109→40 会瞬间跳（不是过渡）。
 *
 * 改为：拿一个**屏外克隆**量内容高度，真实编辑区的 inline height 不动；
 * 再一次性写到目标 px。这样浏览器只看到「旧 px → 新 px」，CSS 过渡才能插值。
 */
let composerMirror: HTMLDivElement | null = null;

function measureComposerContentHeight(el: HTMLDivElement): number {
  let mirror = composerMirror;
  if (!mirror) {
    mirror = el.cloneNode(false) as HTMLDivElement;
    // 屏外镜像只用于量高度：不能带 id/role/aria，避免和真实输入框重复。
    mirror.removeAttribute("id");
    mirror.removeAttribute("role");
    mirror.removeAttribute("aria-label");
    mirror.removeAttribute("data-placeholder");
    mirror.contentEditable = "false";
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.position = "fixed";
    mirror.style.left = "-10000px";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.overflow = "hidden";
    document.body.appendChild(mirror);
    composerMirror = mirror;
  }
  const cs = getComputedStyle(el);
  mirror.style.width = `${el.getBoundingClientRect().width}px`;
  mirror.style.height = "auto";
  mirror.style.maxHeight = "none";
  // 克隆保留了 class（padding / whitespace / min-height），字号与断行策略跟着设置走。
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.whiteSpace = cs.whiteSpace;
  mirror.style.wordBreak = cs.wordBreak;
  mirror.style.overflowWrap = cs.overflowWrap;
  mirror.style.paddingTop = cs.paddingTop;
  mirror.style.paddingRight = cs.paddingRight;
  mirror.style.paddingBottom = cs.paddingBottom;
  mirror.style.paddingLeft = cs.paddingLeft;
  mirror.innerHTML = el.innerHTML;
  return mirror.scrollHeight;
}

function autoResize() {
  const el = editorRef.value;
  if (!el) return;
  if (!composerMaxPx.value) measureComposerMax();
  const target = `${clampComposerHeight(measureComposerContentHeight(el), composerMaxPx.value)}px`;
  // 只在目标值变化时写：同值重复写会打断正在进行的过渡。
  if (el.style.height !== target) el.style.height = target;
}

/** 输入框里待发送的图片附件（粘贴图片先入框，发送时才走 send-image）。 */
interface PendingImage {
  /** 内容指纹：重复粘贴同一张图时按它去重。 */
  hash: string;
  file: File;
  /** `URL.createObjectURL` 的预览地址，移除/发送/卸载时必须 revoke。 */
  objectUrl: string;
}
const pendingImages = ref<PendingImage[]>([]);
const pendingImageHashes = new Set<string>();
/** 只有文本草稿或待发送图片时才允许发送（图片-only 也要能点发送键）。 */
const canSend = computed(() => hasDraft.value || pendingImages.value.length > 0);

function revokePendingImage(image: PendingImage) {
  URL.revokeObjectURL(image.objectUrl);
}
function removePendingImage(image: PendingImage) {
  const index = pendingImages.value.indexOf(image);
  if (index < 0) return;
  pendingImages.value.splice(index, 1);
  pendingImageHashes.delete(image.hash);
  revokePendingImage(image);
}
function clearPendingImages() {
  for (const image of pendingImages.value) revokePendingImage(image);
  pendingImages.value = [];
  pendingImageHashes.clear();
}

/** 内容指纹：重复粘贴同一张位图（File 的 name/lastModified 每次都会变）也能识别。 */
async function pendingImageHash(file: File): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = await file.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // 极老 WebView 的兜底：至少能拦住同名同尺寸同时间的重复文件。
  return `${file.type}:${file.size}:${file.name}:${file.lastModified}`;
}

function pastedImageToast(reason: PastedImageRejection, type: string) {
  app.toast(
    reason === "too-large"
      ? t("chat.imageTooLarge", { max: PASTED_IMAGE_LIMIT_MB })
      : t("chat.composer.imageUnsupported", { type: type || t("msg.image") }),
    "error",
  );
}

/**
 * 把一张粘贴进来的图片加入待发送列表。
 *
 * `convIdAtPaste`：指纹是异步算的，算完必须确认仍停在同一个会话 ——
 * 否则切走期间算完的图会落进新会话，发送时就发错人了。
 */
async function enqueuePastedImage(file: File, convIdAtPaste: string | null) {
  try {
    const hash = await pendingImageHash(file);
    if (props.convId !== convIdAtPaste) return;
    if (pendingImageHashes.has(hash)) {
      app.toast(t("chat.composer.imageDuplicate"), "info");
      return;
    }
    pendingImageHashes.add(hash);
    pendingImages.value.push({ hash, file, objectUrl: URL.createObjectURL(file) });
  } catch {
    if (props.convId === convIdAtPaste) app.toast(t("chat.composer.imageReadFail"), "error");
  }
}

/** @提及 高亮文字色：输入框底是面板（亮白/暗深灰），按对方气泡同档中性底校验对比。 */
const composerMentionFg = computed(() =>
  mentionHighlightColor(
    app.themeColor,
    app.dark,
    resolveChatColors("theme", app.themeColor, app.dark).otherBubble,
  ),
);

/** 清空但残留空壳（空的 div/br）时规范化为真·空，让 :empty 的 placeholder 回来。 */
function normalizeEmpty() {
  const el = editorRef.value;
  // 用 textContent 而非 innerText：innerText 会强制同步 reflow（对超长文本极慢），
  // 这里只需判断"是否空壳"，textContent 语义足够且不触发布局。
  if (el && (el.textContent ?? "").trim() === "") el.innerHTML = "";
}

watch(codeMode, () => nextTick(() => autoResize()));
// 字号档位变了 ⇒ 5 行封顶高度也要跟着变，否则 16px 字号下只能看到 4 行多。
watch(
  () => app.chatStyle.fontSize,
  () => nextTick(() => {
    measureComposerMax();
    autoResize();
  }),
);

// 切换会话：先存旧草稿，再恢复新草稿；输入框不再随会话卸载重挂。
/**
 * 草稿只允许编辑器自己产生的结构：文本、`<br>`/块边界、以及 @提及/表情的 token span。
 * 恢复前按白名单重建（丢标签名/属性/样式，只留 token 的 data 属性与高亮色），
 * 这样即使拖入或历史版本留下奇怪标记，也不会被当成 HTML 重新解析执行。
 */
const DRAFT_TAGS = new Set(["BR", "DIV", "P", "SPAN"]);

/**
 * 表情 token：输入框里直接显示**表情图形**（与消息气泡同一套资源），
 * `data-emoji` 保留发送时要读回的 `[名字]` 文本。
 *
 * 为什么不把 `[微笑]` 直接当文字：用户 2026-11-04 明确要求"在输入框里直接看到表情本身"。
 * 消息渲染用的就是这张图片资源（字体无关、跨端一致），输入框跟着它走，
 * 用户看到的和发出去的才是同一个东西。
 */
function createEmojiToken(displayName: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "emoji-token";
  span.contentEditable = "false";
  span.dataset.emoji = displayName;
  const src = emojiUrl(displayName);
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = displayName;
    img.className = "emoji-img";
    img.draggable = false;
    img.decoding = "async";
    span.appendChild(img);
  } else {
    span.textContent = displayName;
  }
  return span;
}

function sanitizeDraftHtml(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const el of Array.from(tpl.content.querySelectorAll("*"))) {
    // 表情 token 不从存盘 HTML 里信任 src：按 data-emoji 重建，旧草稿（曾经存的是
    // 纯文字 `[微笑]`）也能无损升级成图片。
    if (el.classList.contains("emoji-token")) {
      const display = (el as HTMLElement).dataset.emoji ?? el.textContent ?? "";
      const rebuilt = createEmojiToken(display);
      el.replaceWith(rebuilt);
      continue;
    }
    if (!DRAFT_TAGS.has(el.tagName)) {
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const keep =
        attr.name === "class" ||
        attr.name === "contenteditable" ||
        attr.name.startsWith("data-mention-");
      if (!keep) el.removeAttribute(attr.name);
    }
    const color = (el as HTMLElement).style.color;
    if (color) (el as HTMLElement).style.color = color;
    else el.removeAttribute("style");
  }
  return tpl.innerHTML;
}
function currentDraftHtml(): string {
  return sanitizeDraftHtml(editorRef.value?.innerHTML ?? "");
}
/**
 * 草稿**同步**落盘（用户 2026-11-04 硬要求）：按输入事件写 `localStorage`，不用定时器。
 *
 * 为什么不能用防抖/定时器：渲染层冻住时定时器回调正好不会跑 —— 最后几百毫秒的输入
 * 会丢，而"注入冻结前输入 20 字、reload 后仍有这 20 字"正是验收判据。
 *
 * 这里写编辑器**原始** innerHTML：白名单重建只在恢复时做一次（`restoreDraft`），
 * 每个按键都重建一遍会把 50k 草稿的解析成本摊到每次输入上。
 */
function persistDraft() {
  saveComposerDraft(props.convId, editorRef.value?.innerHTML ?? "");
}
function restoreDraft(convId: string | null) {
  const el = editorRef.value;
  if (!el) return;
  el.innerHTML = sanitizeDraftHtml(getComposerDraft(convId));
  syncDraftState();
}
watch(
  () => props.convId,
  async (next, prev) => {
    if (prev) saveComposerDraft(prev, currentDraftHtml());
    // 待发送图片属于"这个会话的临时草稿"，切走即丢弃，避免把 A 会话的图发进 B 会话。
    clearPendingImages();
    await nextTick();
    measureComposerMax();
    restoreDraft(next);
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

/**
 * 序列化草稿：文本原样、`<br>`/块边界读成 `\n`、@提及读回 `@名字`、
 * 表情 token 读回 `data-emoji`（`[名字]`）。
 *
 * 为什么不再用 `innerText`：输入框里的表情现在是 `<img>`（见 `createEmojiToken`），
 * `innerText` 不会返回图片的 `alt`/token 文本，直接用会把表情发丢。
 * 这里按白名单结构显式走一遍，代价与文本长度线性相关，比 `innerText` 的同步 reflow 更可控。
 * 块尾的 `\n` 是渲染 artifact，剥掉；maxlength 语义挪到发送前截断兜底。
 */
function serializeDraft(): string {
  const root = editorRef.value;
  if (!root) return "";
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains("emoji-token")) {
      out += el.dataset.emoji ?? "";
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    if (el.tagName === "IMG") return;
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out && !out.endsWith("\n")) out += "\n";
    for (const child of el.childNodes) walk(child);
    if (isBlock && out && !out.endsWith("\n")) out += "\n";
  };
  for (const child of root.childNodes) walk(child);
  return out.replace(/\n+$/, "").slice(0, MAX_INPUT_LENGTH);
}

/**
 * 这条文本 @ 了谁（设备 id 名单）。两种来源取并集：
 *  ① **成员选择器**插入的 token —— `data-mention-id` 就是权威答案（选中了就是那个人，
 *     同名成员因此不会互相顶掉）；
 *  ② 用户**手打**的 `@名字` —— 只能按名字回解，用的是接收端兜底**同一份**边界规则
 *     （`textMentionsName`）；两边不同源就会出现「发送方没带、接收方按名字误亮」的割裂。
 * 「所有人」不进名单：它是正文里的固定中文字面量，接收端按字面判（见 MENTION_ALL_ID）。
 *
 * ⚠️ 必须在 `send()` 清空 innerHTML **之前**调用：DOM 一清，① 就没有来源了。
 */
function draftMentionIds(text: string): string[] {
  const ids = new Set<string>();
  editorRef.value
    ?.querySelectorAll<HTMLElement>(".mention-token[data-mention-id]")
    .forEach((el) => {
      const id = el.dataset.mentionId;
      if (id && id !== MENTION_ALL_ID) ids.add(id);
    });
  for (const m of props.mentionMembers ?? []) {
    if (textMentionsName(text, m.name)) ids.add(m.id);
  }
  return [...ids];
}

/** 发送：立即清空输入框（optimistic UI，不等 IPC 返回）。引用消息在首行拼接引用头。 */
function send(kind?: MsgKind, content?: string) {
  let text = content ?? serializeDraft();
  const k = kind ?? (codeMode.value ? "code" : "text");
  // 围栏只是输入时的语法；落库的代码消息不带 ```lang。
  // ⚠️ 这里的 language **必须**带下去：过去只取 `.text`，围栏语言在发送这一步就被丢掉了，
  // "已标语言按标记走"实际是假的（发送后两端只能自动识别）。
  let codeLangOut: string | null = null;
  if (content === undefined && k === "code") {
    const stripped = stripCodeFence(text);
    text = stripped.text;
    codeLangOut = stripped.language ?? codeLang.value;
  } else if (k === "code") {
    codeLangOut = codeLang.value;
  }
  const hasText = k !== "text" || text.trim().length > 0;
  const images = pendingImages.value.map((x) => x.file);
  // 文本与待发送图片是一个发送动作：只要其中一样有内容就能发（纯图片也允许）。
  if (!hasText && images.length === 0) return;
  if (k === "text" && props.quote && text.trim()) {
    // 引用头只在 `quote.ts` 构造一次（线上格式，见那里的注释）；这里不再自己拼字面量。
    text = `${buildQuoteHeader(props.quote.sender, props.quote.snippet, props.quote.msgId)}\n${text}`;
  }
  // 清空 DOM 前先把名单读走；非文本（代码 / 由 content 参数直接发的那些）不带名单
  const mentionIds = content === undefined && k === "text" ? draftMentionIds(text) : undefined;
  clearPendingImages();
  if (editorRef.value) editorRef.value.innerHTML = "";
  hasDraft.value = false;
  mention.value = null;
  // 发出去的内容不再是草稿；旧草稿若不清，回来会"复活"已发送的文字。
  clearComposerDraft(props.convId);
  if (!kind) codeMode.value = false;
  autoCode.value = false;
  autoCodeLang.value = null;
  codeLang.value = null;
  autoCodeSuppressed.value = false;
  if (codeDetectTimer) {
    clearTimeout(codeDetectTimer);
    codeDetectTimer = null;
  }
  // 纯图片发送不消耗引用：用户还能接着发送被引用的文字。
  if (props.quote && hasText) emit("close-quote");
  // 清空 + DOM 更新后重新聚焦并把 caret 放到末尾：连续发送/继续输入无缝衔接
  void nextTick(() => {
    autoResize();
    if (!app.isMobile) focusEditor();
  });
  // 消息已经乐观入列（DOM 立刻更新）→ 给一下轻触觉，确认"发出去了"。
  // 按 Apple 的触觉规则：只在关键动作给，且是按下即给（不是等网络回来才给）。
  haptic("light");
  // 先发文字，再按入框顺序发图片。渲染侧仍是独立的文字气泡 + 图片气泡，
  // 这里只把"一次点击"合并；不要合成"带图文字"复合消息。
  if (hasText) emit("send", { content: text, kind: k, mentionIds, lang: codeLangOut });
  for (const file of images) emit("send-image", file);
}

/**
 * 输入法组合态（拼音/日文等）。
 *
 * ⚠️ 不能只依赖 `KeyboardEvent.isComposing`：macOS WKWebView 上用 Enter 提交候选时，
 * 事件顺序是 `compositionend` → `keydown`，keydown 那一刻 `isComposing` 已是 false
 * ⇒ 会把"选字"当成"发送"，把半成品中文直接发出去（用户 2026-09-12 反馈的正是这个）。
 * 所以自己跟踪组合态，并保留一个"提交后短窗口"兜底；判定逻辑抽在
 * `utils/ime.ts`（纯函数，有单测钉死）。
 */
const composing = ref(false);
let compositionEndedAt = 0;

function onCompositionStart() {
  composing.value = true;
}
function onCompositionEnd() {
  composing.value = false;
  compositionEndedAt = Date.now();
}

/** 这次按键是否属于输入法组合（必须放行给 IME / 内容）。 */
function imeKey(e: KeyboardEvent): boolean {
  return isImeKey(e, composing.value, compositionEndedAt, Date.now());
}

function onKeydown(e: KeyboardEvent) {
  // 输入法组合中的按键**一律不拦截**：
  //   · Enter 交给 IME 提交字母（用户要的"把拼音字母落下来"）；
  //   · 若该 Enter 其实是给内容的，则走浏览器默认行为插入换行
  //     （用户要的"回车应该响应聊天内容的回车"）—— 两种情形都不该由我们发送。
  if (imeKey(e)) return;
  // 紧跟一次粘贴的 ⌘/Ctrl+Z 由这里接住：粘贴是一次 DOM 插入，原生 undo 栈里没有那一步
  // （实测按 ⌘/Ctrl+Z 什么都不回退）。不满足条件（粘贴后又编辑过 / 按的是 redo）一律放行给原生。
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && restorePasteUndo()) {
    e.preventDefault();
    return;
  }
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
  // 到这里的按键都已排除输入法组合（见上面的 `imeKey` 提前返回）
  if (e.key === "Enter" && e.shiftKey) {
    // 统一换行为 <br>：浏览器默认 insertParagraph 会造嵌套 div，序列化不可控
    e.preventDefault();
    document.execCommand("insertLineBreak");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// ---------------- 群聊 @ 成员选择 ----------------
/** 触发态：caret 前最近的 @query（无空白隔断）；startIndex 是 @ 在所在文本节点内的偏移。 */
const mention = ref<{ query: string; startIndex: number } | null>(null);
const mentionActive = ref(0);

/**
 * 「所有人」是**虚拟成员**：本组件内用它做 key 与展示，发送出去的仍是纯文本 `@所有人`
 * （见 `serializeDraft` 走 innerText 读回 token 文本）。因此它**不进** `draftMentionIds`
 * 那份名单 —— 真实成员的 id 现在会随载荷发给对端，而「所有人」永远只按字面量判。
 * 发送到正文里的字面量必须是固定中文 `MENTION_ALL_TOKEN`：它是一条**发给所有人的文本**，
 * 接收端按字面匹配，不能随发送方的界面语言变化，否则英文界面发出去的 @所有人 没人能识别。
 */
const MENTION_ALL_ID = "__mention_all__";

/** 候选 = 「所有人」+ 真实成员（不含自己）。所有人排首位，与微信一致。 */
const mentionCandidates = computed(() => [
  { id: MENTION_ALL_ID, name: MENTION_ALL_TOKEN },
  ...(props.mentionMembers ?? []),
]);

const mentionFiltered = computed(() => {
  if (!mention.value) return [];
  const q = mention.value.query.toLowerCase();
  const list = mentionCandidates.value;
  return (q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list).slice(0, 8);
});

/** 原子 token：@提及 与 表情 都是 contentEditable=false 的 span，退格时都应整体删除。 */
function isTokenSpan(n: Node | null): boolean {
  if (n === null || n.nodeType !== Node.ELEMENT_NODE) return false;
  const cl = (n as Element).classList;
  return cl.contains("mention-token") || cl.contains("emoji-token");
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

/**
 * @提及 查询串最长 20 字符（正则里就是 `{0,20}`），加 `@` 本身共 21 —— 所以只看
 * caret 前 21 个字符就够判定。
 *
 * ⚠️ 不要改回「取整个文本节点再匹配」：粘贴长文本后节点可能有几十万字符，
 * 每次输入/`selectionchange` 都要整段 slice + 正则扫描，连发粘贴时纯属白烧主线程
 * （表现为"越粘越卡"）。从 caret 往前取固定窗口，成本与文本长度**无关**。
 */
const MENTION_LOOKBEHIND = 21;

/** caret 前的 @查询（只看固定窗口，见 MENTION_LOOKBEHIND）。 */
function mentionQueryAt(ctx: { node: Text; offset: number }): { query: string; startIndex: number } | null {
  const from = Math.max(0, ctx.offset - MENTION_LOOKBEHIND);
  const tail = (ctx.node.data ?? "").slice(from, ctx.offset);
  const m = tail.match(/@([^\s@]{0,20})$/);
  if (!m) return null;
  return { query: m[1], startIndex: ctx.offset - m[0].length };
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
  const q = mentionQueryAt(ctx);
  if (q) {
    const sameAt = mention.value?.startIndex === q.startIndex;
    mention.value = q;
    if (!sameAt) mentionActive.value = 0;
  } else {
    mention.value = null;
  }
}

/** caret 之前那段内容里的最后一个字符（跨节点取）。
 *  ⚠️ 不能只看 `ctx.node.data`：@提及 与表情都是 `contentEditable=false` 的独立 token span，
 *  caret 前的字符往往落在它们身上（例如表情 token 的收尾 `]`）。 */
function charBeforeCaret(node: Text, offset: number): string {
  const el = editorRef.value;
  if (!el) return "";
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return r.toString().slice(-1);
}

/**
 * 外部入口（N6-2 群成员面板右键「@他」）：在正文**末尾**追加一个 @token。
 *
 * 为什么不复用 `applyMention`：那个函数是从"用户刚敲的 @query"替换出来的，依赖选区与被删的查询串；
 * 从面板触发时编辑器可能没有焦点、也没有 @query。这里直接按同一个 token 形状追加，
 * `data-mention-id` 仍是权威答案（`collectMentionIds` 读的就是它）。
 */
function insertMentionAtEnd(member: { id: string; name: string }) {
  const el = editorRef.value;
  if (!el) return;
  const span = document.createElement("span");
  span.className = "mention-token";
  span.contentEditable = "false";
  span.dataset.mentionId = member.id;
  span.dataset.mentionName = member.name;
  if (composerMentionFg.value) span.style.color = composerMentionFg.value;
  span.textContent = `@${member.name}`;
  // 边界：接收端要求 @名字 前是行首/空白；末尾已有内容时先补一个 nbsp（同 `applyMention` 的 needLead）。
  const tail = el.textContent ?? "";
  if (tail.length > 0 && !/\s$/.test(tail)) el.appendChild(document.createTextNode("\u00A0"));
  el.appendChild(span);
  const space = document.createTextNode("\u00A0");
  el.appendChild(space);
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStart(space, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  if (!app.isMobile) el.focus();
  autoResize();
  // 与输入事件同一条落盘路径（草稿存在 store，切会话/重开都靠它）。
  persistDraft();
  syncDraftState();
}
defineExpose({ insertMention: insertMentionAtEnd });

/** 选中成员：把「@query」替换为 mention token（原子 span）+ 尾随 nbsp，caret 落到 nbsp 后。 */
function applyMention(member: { id: string; name: string }) {
  const el = editorRef.value;
  const sel = window.getSelection();
  if (!el || !sel || sel.rangeCount === 0) return;
  const ctx = caretContext();
  if (!ctx) return;
  const q = mentionQueryAt(ctx);
  if (!q) return;
  /**
   * 前导边界：触发端刻意**不**要求 @ 前有空白（中文里「你好@张三」不敲空格是常态），
   * 但接收端的判定要求边界（`isMentionLead`：行首/空白/表情 token 的 `]`）。
   * 不在这里把边界补上，就会出现最坏的一种静默失效 ——
   * 发送端看着是个蓝色 chip、以为点名成功了，接收端**既不通知也不高亮**。
   * 用节点 API（span.before）而不是 range 插入：range 落在文本节点中间时
   * `insertNode` 的行为按规范是插到整个文本节点之前，位置不直观。
   */
  const needLead = !isMentionLead(charBeforeCaret(ctx.node, q.startIndex));
  const range = document.createRange();
  range.setStart(ctx.node, q.startIndex);
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
  if (needLead) span.before(document.createTextNode("\u00A0"));
  const space = document.createTextNode("\u00A0");
  span.after(space);
  range.setStart(space, 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  mention.value = null;
  if (!app.isMobile) el.focus();
  autoResize();
  // 程序化改 DOM 不触发 input：token 要立刻落盘，否则 reload 后只剩 "@张三" 半截文字。
  persistDraft();
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
  if (!isTokenSpan(prev) || !prev) return false;
  const range = document.createRange();
  range.setStartBefore(prev);
  range.setEnd(node, 1);
  range.deleteContents();
  normalizeEmpty();
  // 退格删 token 也不触发 input（浏览器不会为原子 span 的变化发 input）。
  persistDraft();
  return true;
}

/**
 * 把「输入框里有没有内容」投影成响应式 `hasDraft`（模板只读它，避免每次渲染都读 innerText）。
 *
 * ⚠️ 程序化改动内容后**必须**手动调它：浏览器的 `input` 事件只在用户输入时触发，
 * 我们直接改 DOM（如插入表情 token）不会触发 → 不调它就会出现「只有表情时发送键点不动」。
 */
function syncDraftState() {
  const el = editorRef.value;
  // ⚠️ 表情 token 的 textContent 现在是空（里面是 <img>），只看文本会把"只有表情"
  // 误判成空草稿（发送键点不动、草稿也可能不被保留）。所以 token 存在也算有内容。
  const hasToken = el?.querySelector(".emoji-token") != null;
  hasDraft.value = hasToken || ((el?.textContent ?? "").trim().length) > 0;
}

/** input 统一入口：投影 hasDraft、规范化空壳、非组合输入时更新 @ 触发态。 */
function onInput(e: Event) {
  // 粘贴那次是我们自己补发的 input（见 `insertPastedText`），不算"用户又编辑过"；
  // 之后的任何 input 都把粘贴快照作废 —— 那时按 ⌘/Ctrl+Z 该撤销的是这次编辑，交回原生。
  if (pasteUndoOwnEvent) pasteUndoOwnEvent = false;
  else pasteUndo = null;
  syncDraftState();
  normalizeEmpty();
  // 高度跟着内容走：以前只有切会话/发完才测量，用户连续换行时框并不会长高。
  autoResize();
  // 同步落盘：这一行必须在事件处理里就跑完（定时器在冻结时不会跑）。
  persistDraft();
  scheduleCodeDetect();
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

/**
 * 表情面板参与全局浮层互斥：右键菜单/已读弹层打开时会自动收起它，
 * 反之打开表情面板也会收起那两者（避免两层浮层叠在一起）。
 */
const emojiPopup = useExclusivePopup("emoji-picker");
watch(emojiPopup.isActive, (mine) => {
  if (!mine) emojiOpen.value = false;
});

/** Reka Popover 的受控开关：外点/Esc/触发键都由库管，这里只同步全局浮层互斥。 */
function onEmojiOpenChange(open: boolean) {
  emojiOpen.value = open;
  if (open) emojiPopup.claim();
  else emojiPopup.release();
}

function closeEmoji() {
  emojiPopup.release();
  emojiOpen.value = false;
}

/** @ 成员选择：点击输入卡以外任意处关闭（卡内点击交给 updateMentionState 按光标推断） */
function onDocClickForMention(e: MouseEvent) {
  if (composerCard.value?.contains(e.target as Node)) return;
  mention.value = null;
}
const composerCard = ref<HTMLElement | null>(null);
// @ 候选列表的「点别处收起」与选区变化：挂载即终身、无条件摘挂 ⇒ 交给库（卸载自动摘）。
useEventListener(document, "click", onDocClickForMention);
useEventListener(document, "selectionchange", onSelectionChange);
onUnmounted(() => {
  if (shakeTimer) clearTimeout(shakeTimer);
  // 卸载是少数路径：这里仍走白名单重建（与按输入事件那条原始 innerHTML 路径内容等价）。
  saveComposerDraft(props.convId, currentDraftHtml());
  // 待发送图片的预览 URL 是浏览器对象 URL，不 revoke 会一直占着 Blob。
  clearPendingImages();
  // 量高度用的屏外镜像挂在 body 上，组件卸载时必须摘掉。
  composerMirror?.remove();
  composerMirror = null;
});
watch(emojiOpen, () => {
  if (emojiOpen.value) autoResize();
});

/** 把表情作为原子 token 插入输入框 caret 处（contentEditable=false，退格/选区整体删除，
 *  与 @mention token 同一机制）；caret 不在编辑器内则追加末尾。 */
function insertEmoji(e: string) {
  const el = editorRef.value;
  closeEmoji();
  if (!el) return;
  // ⚠️ 两个分支都必须插「token span」，不能插纯文本：
  // token 是 contentEditable=false → 退格/选区删除整体生效；
  // 插纯文本会被浏览器一个字一个字地删掉（就是"表情文字被拆开"的那个 bug）。
  // 视觉上是表情图片（`createEmojiToken`），发送时仍读回 `[名字]` 文本。
  const span = createEmojiToken(e);
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(span);
    // 与 @mention 同一套：token 后补一个不换行空格，caret 才能落到 token 之后
    const space = document.createTextNode("\u00A0");
    span.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    // 点表情按钮会让编辑器失焦（移动端软键盘随之收起）。这里把焦点还给编辑器，
    // **不动已设好的 range** ⇒ 光标停在刚插入的表情之后，用户可以接着打字；
    // 桌面上这条通常已是焦点态，focus() 是空操作。
    if (document.activeElement !== el) el.focus();
  } else {
    el.appendChild(span);
    el.appendChild(document.createTextNode("\u00A0"));
    // 无选区（编辑器从未聚焦过）时内容追加到末尾，光标也放到末尾
    focusEditor();
  }
  // 直接改 DOM 不会触发 input 事件 → 必须手动同步，否则「只有表情时发送键是灰的」
  syncDraftState();
  autoResize();
  // 同上：表情 token 要立刻落盘（reload 后仍能恢复）。
  persistDraft();
  // EmojiPicker 的 open watcher 是 pre-flush：它会在下一拍把焦点还给触发按钮。
  // 选完表情后必须再抢回编辑器一次，否则用户还要手动点一下输入框才能接着打字。
  void nextTick(() => {
    if (document.activeElement !== el) el.focus();
  });
}

/**
 * 粘贴那一次的「撤销快照」。为什么需要：见 `insertPastedText` —— 粘贴改成一次 DOM 插入之后，
 * 原生 undo 栈里就没有这一步了（实测：手动插入后按 ⌘/Ctrl+Z 什么都不回退），
 * 而"粘错了立刻撤销"是聊天框最常用的反悔动作，不能悄悄没了。
 * `chars` 是**粘贴完成后**的字符数：只有内容还停在那个状态，这次按键才算"撤销粘贴"。
 */
let pasteUndo: { html: string; chars: number } | null = null;
/** `insertPastedText` 自己补发的那个 input 事件 —— `onInput` 见到它要跳过一次失效逻辑。 */
let pasteUndoOwnEvent = false;

/**
 * 把一段纯文本一次插进编辑器。
 *
 * ⚠️ 这里刻意**不再**用 `document.execCommand("insertText")`：带换行的文本会被 Chromium
 * 逐行开编辑事务（本机实测 300 行 ⇒ 299 个子元素、599 次 `input` 事件），整段同步跑在
 * paste 事件里 ⇒ 粘贴的文字要等它全部做完才画得出来。实测同一段文本：
 *   · 10k 字符 / 300 行：execCommand 70–86 ms，本函数 1.1–1.5 ms
 *   · 50k 字符 / 1500 行（草稿上限）：execCommand 780–863 ms，本函数 3.4–5 ms
 * 用户报的「粘贴大段文字会卡一下才显示」就是那一段阻塞。
 * 编辑区自己是 `whitespace-pre-wrap`（见模板那个类），文本节点里的 `\n` 就是换行，
 * 所以一个节点就够，不需要每行一个元素；`serializeDraft` 走 innerText 读回换行也照旧。
 *
 * 代价与它的补偿：手动改 DOM 不产生原生 undo 步骤，也不触发 `input` 事件 ⇒
 * 这里自己补发一个（`syncDraftState`/草稿保存/@ 触发态都靠它），并把撤销接到 `pasteUndo`。
 */
function insertPastedText(text: string): boolean {
  const el = editorRef.value;
  const sel = window.getSelection();
  if (!el || !sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const before = el.innerHTML;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  // caret 落在**这个文本节点内部的末尾**，而不是 `setStartAfter(node)`（那会把 caret
  // 的容器变成编辑器本身）。`caretContext()` 只认文本节点上的 caret ⇒ 容器错了就会出现
  // "粘完接着打 @ 不弹成员选择"这类看不出来的错。原生插入也是落在节点内。
  range.setStart(node, node.length);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  pasteUndo = { html: before, chars: (el.textContent ?? "").length };
  pasteUndoOwnEvent = true;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  return true;
}

/** 紧跟粘贴的那一次 ⌘/Ctrl+Z：回到粘贴前。返回 false = 交回原生 undo。 */
function restorePasteUndo(): boolean {
  const snap = pasteUndo;
  const el = editorRef.value;
  pasteUndo = null;
  if (!snap || !el) return false;
  // 粘贴之后用户又编辑过（长度不再是粘贴完成那一刻）⇒ 这次按键该撤销的是编辑，不是粘贴。
  if ((el.textContent ?? "").length !== snap.chars) return false;
  // 回灌也走那张白名单（与 `restoreDraft` 同一条口径）：快照里只允许编辑器自己产出的结构。
  el.innerHTML = sanitizeDraftHtml(snap.html);
  syncDraftState();
  persistDraft();
  focusEditor();
  return true;
}

async function onPaste(e: ClipboardEvent) {
  const cd = e.clipboardData;
  if (!cd) return;
  // 无论最终归到哪条分支，都在同步阶段拦掉默认插入（图片/文件/文本都不该由浏览器塞进编辑器）
  e.preventDefault();

  const types = Array.from(cd.types ?? []);
  const files = Array.from(cd.files ?? []);
  const items = Array.from(cd.items).map((i) => ({ kind: i.kind, type: i.type }));

  // 同步捕获图片 File（支持多图）：files 优先，其次 items.getAsFile()。
  // ⚠️ 必须在任何 await 之前完成——Chromium/WebKit 会在 paste 事件返回后清空 clipboardData，
  // 若先 await 再读 items，getAsFile() 会拿到 null，表现为"截图有时粘不进来"。
  // files 与 items 可能同时暴露同一张图，这里先按文件描述去重，避免同一次粘贴入框两次。
  const imageFiles: File[] = [];
  const seenCandidates = new Set<string>();
  const addCandidate = (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const key = `${file.type}:${file.size}:${file.name}:${file.lastModified}`;
    if (seenCandidates.has(key)) return;
    seenCandidates.add(key);
    imageFiles.push(file);
  };
  for (const file of files) addCandidate(file);
  for (const item of Array.from(cd.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) addCandidate(item.getAsFile());
  }

  // 图片优先：截图位图即使同时带 "Files"（Win11 临时文件引用），也按图片入框，
  // 避免去发那个可能已被清理的临时路径。
  if (imageFiles.length > 0) {
    if (isSelfChat.value) {
      app.toast(t("chat.selfChatTextOnly"), "error");
      return;
    }
    // 先入框（可删可继续打字），按发送键时才真正发出去；不再粘贴即发送。
    // 同步捕获会话 id：指纹运算在 await 之后，切走时据此丢弃，避免发错会话。
    const convIdAtPaste = props.convId;
    for (const file of imageFiles) {
      // 前置闸（同一判据的 TS 侧镜像，见 utils/imageBytes 的注释）：格式不支持/超限都
      // 给具名原因，不静默吞掉。
      const reason = pastedImageRejection(file.type, file.size, MAX_PASTED_IMAGE_BYTES);
      if (reason) {
        pastedImageToast(reason, file.type);
        continue;
      }
      void enqueuePastedImage(file, convIdAtPaste);
    }
    return;
  }

  // 无图片 → 尝试真实文件路径（资源管理器复制的 CF_HDROP）。非 Windows 命令返回空，回退文本。
  let filePaths: string[] = [];
  if (types.includes("Files")) {
    try {
      filePaths = await api.readClipboardFilePaths();
    } catch {
      filePaths = [];
    }
  }

  const action = classifyPaste(types, items, files, filePaths.length > 0);
  if (action.kind === "files") {
    // 自聊只支持文本（用户 2026-09-16）——粘贴文件时给明确提示，不要静默吞掉
    if (isSelfChat.value) {
      app.toast(t("chat.selfChatTextOnly"), "error");
      return;
    }
    emit("paste-files", filePaths);
    return;
  }

  // 纯文本：contenteditable 默认粘贴会带外来 HTML 结构（污染 token/样式），统一拦下来
  // 自己插。⚠️ 这里**不能**用 `document.execCommand("insertText")` 塞多行文本 ——
  // 它会被逐行开编辑事务，粘贴的文字要等全部做完才画得出来（实测 50k 字符阻塞 780–863 ms）。
  // 一次插入的写法与非显然之处全在 `insertPastedText` 的注释里。
  const text = cd.getData("text/plain");
  if (!text) return;
  // ⚠️ 上限要按**草稿总量**算，不能只看这一次粘贴的文本：按住 Ctrl+V 连发时
  // 每次都会成功插入一份，草稿无界增长 ⇒ contenteditable 的布局/绘制成本随字符数
  // 线性上升，越粘越卡、最后卡死（用户实测的"一直按着 Ctrl+V 一顿一顿"）。
  // 这里按剩余容量截断，满了就不再插入（并节流提示一次）。
  const used = (editorRef.value?.textContent ?? "").length;
  const room = MAX_INPUT_LENGTH - used;
  if (room <= 0) {
    warnDraftFull();
    return;
  }
  if (text.length > room) warnDraftFull();
  if (!insertPastedText(text.slice(0, room))) {
    // 拿不到 caret/range（极端情形，例如编辑器没被聚焦就收到粘贴）：退回原生插入。
    // 宁可那一次慢一点，也不能把用户粘贴的内容吞掉。
    document.execCommand("insertText", false, text.slice(0, room));
  }
}

</script>

<template>
  <div class="flex flex-col gap-2">
    <!-- 微信 4.0 输入卡：白底圆角；文本域在上，图标行在卡内底部，发送键靠右下。
         `px-4`（不是 px-3）与工具栏的 `-mx-1` 成对：编辑器的文字左边缘与工具栏第一个
         图标的**点击热区**左边缘取同一个 16px 起点（图标墨迹在其 28px 热区内再内缩 6px，
         与文字字形的光学起点对齐）—— 这是用户反馈「左右两边视觉上不在同一条线上」的修法。 -->
    <!-- `gosslan-composer` 只是个钩子：焦点提示由 style.css 的 `.gosslan-composer:focus-within`
         挂在**这张卡片自己的边框**上。编辑区（下面那个 contenteditable div）是卡片里一块
         透明矩形，不能给它画外框 —— 那会在卡片内部套一个方框（用户 2026-09-16 报的
         「输入框焦点态有个主题色方框」在消息输入框上就是这个形态）。 -->
    <!-- Material 3 Text Field 规范：容器垂直 padding 8dp (pt-2 pb-2)，
         这是文字可读性和点击热区的基线；WebView 中 1dp ≈ 1px（标准密度）。 -->
    <div ref="composerCard" class="gosslan-composer relative rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-4 pb-2 pt-2">
      <!-- 群聊 @ 成员选择：输入 @ 后浮出，↑↓ 导航 / Enter 或点击选中 -->
      <div
        v-if="mention && mentionFiltered.length > 0"
        class="frost absolute bottom-full left-2 right-2 z-30 mb-2 max-h-44 overflow-y-auto rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-1 shadow-[var(--gosslan-glass-2-shadow)]"
      >
        <div class="px-2 py-1 text-caption text-[var(--gosslan-text-2)]">{{ t("chat.composer.remind") }}</div>
        <button
          v-for="(m, i) in mentionFiltered"
          :key="m.id"
          class="tap-safe flex w-full items-center gap-2 rounded-[var(--gosslan-radius-sm)] px-2 py-1.5 text-left text-body transition"
          :class="i === mentionActive ? 'bg-[var(--gosslan-list-active)]' : 'hover:bg-[var(--gosslan-hover)]'"
          @mousedown.prevent
          @click="applyMention(m)"
        >
          <!-- 「所有人」不是真人，用图标而非首字头像：避免与真成员的名字首字混淆 -->
          <span
            v-if="m.id === MENTION_ALL_ID"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--gosslan-primary-light)] text-[var(--gosslan-primary)]"
          >
            <Icon name="users" class="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <AvatarBox v-else class="h-6 w-6 shrink-0" round="full" :id="m.id" />
          <span class="min-w-0 flex-1 truncate" :title="m.name">{{ m.name }}</span>
        </button>
      </div>
      <!-- 引用预览条：右键"引用"后出现在输入框上方，可取消 -->
      <div
        v-if="quote"
        class="mb-1.5 flex items-center gap-2 rounded-[var(--gosslan-radius-sm)] border-l-2 px-2 py-1 text-meta"
        :style="{ borderColor: QUOTE_BORDER, background: QUOTE_BG, color: 'var(--gosslan-text)' }"
      >
        <span
          class="min-w-0 flex-1 truncate"
          :style="QUOTE_TEXT_STYLE"
          :title="`${t('common.quote')} ${quote.sender}${t('common.sep.colon')}${quote.snippet}`"
        >{{ t("common.quote") }} {{ quote.sender }}{{ t("common.sep.colon") }}{{ quote.snippet }}</span>
        <button
          class="tap-safe flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-xs)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('chat.composer.cancelQuote')" :aria-label="t('chat.composer.cancelQuote')"
          @click="emit('close-quote')"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <!-- 待发送图片：粘贴进输入框后先出现在这里，可删、可继续打字，按发送键才真正发出。
           缩略图用 object URL（发送/删除/切会话/卸载时 revoke）。 -->
      <div
        v-if="pendingImages.length > 0"
        class="mb-1.5 flex gap-2 overflow-x-auto pb-0.5"
        :aria-label="t('chat.composer.pendingAttachments')"
      >
        <div
          v-for="image in pendingImages"
          :key="image.hash"
          class="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--gosslan-radius-sm)] border border-[var(--gosslan-border)] bg-[var(--gosslan-hover)]"
        >
          <img
            :src="image.objectUrl"
            :alt="image.file.name"
            class="h-full w-full object-cover"
            draggable="false"
          />
          <button
            type="button"
            class="tap-safe absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-white transition hover:bg-black/70"
            :title="t('chat.composer.removeAttachment')"
            :aria-label="t('chat.composer.removeAttachment')"
            @mousedown.prevent
            @click="removePendingImage(image)"
          >
            <X class="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
      <!-- contenteditable 编辑区：@提及 为内联原子 token（高亮+整删）。
           用户 2026-09-16 明确要求消息输入框不画任何焦点环（不要主题色/黑框），
           透明即「无替代焦点指示」是用户显式选择 ⇒ 下面那个 div 挂了 `data-focus-ring-ok`
           属性（**元素级**逃生阀，只豁免它自己）。
           ⚠️ 不要图省事改成**文件级**逃生阀（见 designGuards 里「两个逃生阀」的说明）：
           那会让本文件里其它键盘可聚焦元素（按钮等）一起失去「焦点可见」护栏的保护，
           也会让注入本文件的非空转用例退化成空转 —— 2026-09-16 就是这么踩过一次。
           ⚠️ **不放 placeholder**：用户 2026-09-12 明确要求「输入框里也不用 placeholder」
           （参考图是干净的输入区）。原先走 `:data-placeholder` + `:empty::before`，
           现连同 style.css 里的那条规则与两个 i18n key 一起删除，避免留死代码。
           `normalizeEmpty` 保留 —— 它现在只服务 `hasDraft`（空壳 div/br 会让"有草稿"误判）。 -->
      <!-- 代码档工具条：手动开代码模式也要能选语言 / 取消代码块。
           取消 = 回到普通长文本，正文一个字都不动（换行与原样字符全部保留，不高亮）。 -->
      <div
        v-if="codeMode"
        class="mb-1 flex items-center gap-2 text-meta text-[var(--gosslan-text-2)]"
      >
        <span v-if="autoCode">{{ t("chat.composer.codeDetected", { lang: autoCodeLang || t("chat.composer.code") }) }}</span>
        <CodeLangMenu
          :model-value="codeLang"
          :aria-label="t('code.lang')"
          @update:model-value="onCodeLangChange"
        />
        <button
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-sm)] px-1 underline-offset-2 hover:underline"
          @click="undoAutoCode"
        >
          {{ t("chat.composer.codeCancel") }}
        </button>
      </div>
      <div
        ref="editorRef"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        :aria-label="t('chat.composer.inputAria')"
        enterkeyhint="send"
        :spellcheck="!codeMode"
        :autocorrect="codeMode ? 'off' : 'on'"
        :autocapitalize="codeMode ? 'off' : 'sentences'"
        data-focus-ring-ok
        class="gosslan-composer-editor min-h-11 w-full overflow-y-auto bg-transparent px-0.5 py-0.5 leading-normal whitespace-pre-wrap break-words outline-none"
        :class="codeMode ? 'font-mono text-body' : ''"
        :style="{ fontSize: 'var(--gosslan-msg-size, 14px)', overflowWrap: 'anywhere', wordBreak: 'break-word' }"
        @keydown="onKeydown"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
        @input="onInput"
        @click="updateMentionState"
        @paste="onPaste"
      ></div>
      <!-- 工具栏行（2026-09-12 按用户反馈重做：对齐 + 统一规格 + 去掉"网页感"）。
           三条硬性约定，改这一行时必须同时满足：
           ① **对齐**：行用 `items-center`，左右两组**同高（h-7 = 28px）**。原先右侧发送键
              是 `h-7 + px-4 + text-body`，而左侧图标按钮 28px 见方、图标 18px ——
              两者行盒不同（图标按钮的 flex 行盒 vs 文本基线），`items-center` 居中的
              是两个不同高度的行盒 ⇒ 视觉上看不出在同一条中线上。
           ② **两侧留白一致**：卡片是 `px-4`（16px），编辑器滚到左边缘 ⇒ 工具栏左右各加
              `-mx-1`（4px）+ 按钮自身 4px 内缩 = 4px 光学内缩，左侧第一个图标与右侧发送键
              的边距对称；`-mx-1` 同时让 28px 按钮的点击热区不越出卡片。
           ③ **统一规格**（2026-09-12 晚按微信参考图二次校准）：
              图标按钮 **32×32**（`h-8 w-8`）/ 图标 **20px**（`h-5 w-5`）/ 线宽 1.75 /
              圆角 **radius-md(8px)** —— 圆角要与圆形字形"同心"，hover 底色块才像微信那样
              是一个包住图标的圆角方块（用户原话：「它的 hover 和周围的圆角感觉也是同心圆」）；
              按钮间距 8px、与文本间距 4px、卡片底距 10px。
           发送键改为**实心主按钮**（有草稿才点亮）：微信 4.0 的观感，
           无草稿时是低对比的占位态，不抢视觉。 -->
      <div class="-mx-1 mt-1 flex h-8 items-center gap-2">
        <PopoverRoot :open="emojiOpen" @update:open="onEmojiOpenChange">
          <PopoverTrigger as-child>
            <button
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] transition"
              :class="emojiOpen ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
              :title="t('chat.composer.emoji')" :aria-label="t('chat.composer.emoji')"
            >
              <Icon name="smile" class="h-5 w-5" :stroke-width="1.75" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              data-composer-emoji
              side="top"
              align="start"
              :side-offset="8"
              :collision-padding="POPOVER_EDGE"
              class="gosslan-popover-in z-[80] border-0 bg-transparent p-0 shadow-none"
              @open-auto-focus.prevent
              @close-auto-focus.prevent
            >
              <EmojiPicker :open="emojiOpen" @select="insertEmoji" @close="closeEmoji" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <!-- 窗口抖动（仿 QQ）：仅单聊显示。点一下 ⇒ 发独立 nudge（不锚定任何消息），
             对方窗口随即抖动。冷却期置灰防连抖；@mousedown.prevent 保持编辑器焦点。 -->
        <button
          v-if="shakeEnabled"
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] transition"
          :class="shakeCooling
            ? 'cursor-default text-[var(--gosslan-text-2)] opacity-40'
            : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
          :disabled="shakeCooling"
          :title="t('chat.composer.shake')" :aria-label="t('chat.composer.shake')"
          @mousedown.prevent
          @click="onShakeClick"
        >
          <Icon name="zap" class="h-5 w-5" />
        </button>
        <!-- @mousedown.prevent 保持编辑器焦点：否则点击按钮后焦点落到按钮上，
             紧接着按 Enter 会激活按钮（把 codeMode 再切回去）而非走编辑器 keydown 发送。 -->
        <button
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] transition"
          :class="codeMode ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
          :title="t('chat.composer.code')" :aria-label="t('chat.composer.code')"
          @mousedown.prevent
          @click="toggleCodeMode"
        >
          <!-- 代码模式图标（用户 2026-09-12 晚二次反馈：「找一个和代码相关的图标，
               但是又和左右两边的图标是统一风格类型的。现在这个图标不像是发送代码」）。
               上一版按参考图取了 `Box`（立体方块）—— 几何一致但**语义不对**（看不出是代码）。
               现改为 `SquareCode`：方形描边外框 + 内部 `</>`，既是代码语义，
               又与左 `Smile`（圆）、右 `Folder`（方）同属「几何外框 + 内部细节」一套；
               尺寸 16px / 线宽 1.75 与两侧完全一致（见上方工具栏规格说明）。 -->
          <Icon name="square-code" class="h-5 w-5" :stroke-width="1.75" />
        </button>
        <!-- 自聊只支持文本：不给附件入口（用户 2026-09-16）。粘贴/拖入文件时另给提示。 -->
        <button
          v-if="!isSelfChat"
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('chat.composer.sendFile')" :aria-label="t('chat.composer.sendFile')"
          @click="emit('attach')"
        >
          <Icon name="folder" class="h-5 w-5" :stroke-width="1.75" />
        </button>
        <button
          v-press-ripple
          class="tap-safe ml-auto flex h-8 shrink-0 items-center rounded-[var(--gosslan-radius-sm)] px-3.5 text-body font-medium transition"
          :class="canSend
            ? 'bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] hover:bg-[var(--gosslan-primary-hover)]'
            : 'cursor-default bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]'"
          :disabled="!canSend"
          @mousedown.prevent
          @click="send()"
        >
          {{ t("common.send") }}
        </button>
      </div>
    </div>
  </div>
</template>
