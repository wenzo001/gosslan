<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { useClipboard } from "@/composables/useClipboard";
import { useMessageDisplay } from "@/composables/useMessageDisplay";
import { useMessageFile } from "@/composables/useMessageFile";
import { textNeedsClamp } from "@/utils/previewMetrics";
import MessageAvatar from "@/components/message/MessageAvatar.vue";
import MessageTextBubble from "@/components/message/MessageTextBubble.vue";
import MessageCodeBubble from "@/components/message/MessageCodeBubble.vue";
import MessageFileBubble from "@/components/message/MessageFileBubble.vue";
import MessageImageBubble from "@/components/message/MessageImageBubble.vue";
import MessageReceipt from "@/components/message/MessageReceipt.vue";
import MessageContentModal from "@/components/message/MessageContentModal.vue";
import MessageContextMenu from "@/components/message/MessageContextMenu.vue";
import ImageLightbox from "@/components/message/ImageLightbox.vue";
import type { MessageRecord, MsgKind } from "@/types";

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    /** 上一条消息（同会话），用于时间分割线判定 */
    prev?: MessageRecord | null;
    /** 群聊：显示发送者昵称 */
    isGroup?: boolean;
    /** 在本条消息上方显示未读分割线 */
    showUnreadDivider?: boolean;
    /** 群聊发送者昵称（由父组件解析） */
    senderName?: string;
    /** 已读该群消息的成员 ID（由父组件按消息时间计算） */
    groupReaderIds?: string[];
    /** 正在闪烁定位的消息键（点击引用块跳转时高亮 1.6s） */
    highlightId?: string | number | null;
  }>(),
  {
    prev: null,
    isGroup: false,
    showUnreadDivider: false,
    senderName: "",
    groupReaderIds: () => [],
    highlightId: null,
  },
);

const app = useAppStore();
const chat = useChatStore();

// 群文件（gfile-）投递摘要：成员状态语义（已发送给 N 人 · M 人待上线）。
// status 变化（含 CompleteAck 推进）时自动刷新。
const deliverySummary = ref<{ completed: number; failed: number; waiting: number } | null>(null);
const isGroupFile = computed(() => props.message.msg_id.startsWith("gfile-"));
watch(
  [() => props.message.msg_id, () => props.message.status],
  async ([msgId]: [string, unknown]) => {
    if (!msgId.startsWith("gfile-")) {
      deliverySummary.value = null;
      return;
    }
    try {
      deliverySummary.value = await invoke("get_group_file_delivery_summary", {
        transferId: msgId.slice(6),
      });
    } catch {
      deliverySummary.value = null;
    }
  },
  { immediate: true },
);

const display = useMessageDisplay({
  message: () => props.message,
  prev: () => props.prev,
  isGroup: () => props.isGroup,
});
const {
  mine,
  bubbleStyle,
  showTimeDivider,
  showNickname,
  time,
  fullTime,
  timeDividerText,
  sendState,
  receiptTitle,
} = display;

const {
  streamCode,
  streamCodeClamped,
  fileMeta,
  fileProgress,
  fileStatusText,
  attachmentUrl,
  previewNote,
  openFile,
  saveAs,
} = useMessageFile(() => props.message, () => sendState.value);
const { copiedKey, copyContent } = useClipboard();

const avatarName = computed(() =>
  mine.value
    ? app.device?.nickname || "我"
    : props.senderName || props.message.sender_id,
);
/** 头像只在本人的消息上取本机头像；对端头像由会话/通讯录提供，消息里不带。 */
const avatarSrc = computed(() => (mine.value ? (app.device?.avatar ?? null) : null));

/** 是否为被点击引用所定位的消息（短暂高亮） */
const highlighted = computed(
  () => props.highlightId != null && props.highlightId === (props.message.msg_id ?? props.message.id),
);

/** 长文本判定与 estimateHeight 共用 textNeedsClamp：字号档位变了两边一起变。 */
const isLongText = computed(
  () =>
    props.message.kind === "text" &&
    textNeedsClamp(props.message.content, app.chatStyle.fontSize),
);

/** 全文弹窗：文本与代码共用一个 Modal，DOM 在消息之外，不参与 VirtualList 排布。 */
const fullModalOpen = ref(false);
const fullModalKind = ref<"text" | "code">("text");
const fullModalContent = ref("");
function openFullModal(kind: "text" | "code", content: string) {
  fullModalKind.value = kind;
  fullModalContent.value = content;
  fullModalOpen.value = true;
}

/** 图片查看器（vue-easy-lightbox：缩放 / 拖拽 / 滚轮 / Esc / 点遮罩） */
const lightboxOpen = ref(false);
const lightboxSrc = ref("");
function openImageLightbox(src: string) {
  if (!src) return;
  lightboxSrc.value = src;
  lightboxOpen.value = true;
}

// ---------------- 消息右键菜单：复制 / 保存图片 / 引用 / 转发 ----------------
const ctxMenu = ref<{ x: number; y: number } | null>(null);

function openContextMenu(e: MouseEvent) {
  if (props.message.kind === "system") return;
  ctxMenu.value = { x: e.clientX, y: e.clientY };
}

/** 图片消息的内容即 dataURL；解出 base64 供剪贴板 / 另存。 */
const imageDataUrl = computed(() => {
  if (props.message.kind === "image") return props.message.content;
  if (props.message.kind === "file" && attachmentUrl.value) return attachmentUrl.value;
  return "";
});

async function copyImage() {
  ctxMenu.value = null;
  const url = imageDataUrl.value;
  if (!url) return;
  try {
    const blob = await (await fetch(url)).blob();
    const png = blob.type === "image/png" ? blob : await toPngBlob(url);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    app.toast("图片已复制", "success");
  } catch {
    app.toast("复制图片失败（浏览器剪贴板不可用）", "error");
  }
}

/** 非 PNG 源转 PNG：经 canvas 重绘。 */
async function toPngBlob(url: string): Promise<Blob> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}

async function saveImage() {
  ctxMenu.value = null;
  const url = imageDataUrl.value;
  if (!url) return;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const destination = await save({ defaultPath: `图片-${Date.now()}.png` });
    if (!destination) return; // 用户取消
    const base64 = url.includes(",") ? url.split(",")[1] : btoa(url);
    await invoke("save_data_file", { base64Data: base64, destination });
    app.toast("图片已保存", "success");
  } catch (e) {
    app.toast(`保存图片失败：${e}`, "error");
  }
}

/** 引用片段：文本取前 40 字，其它类型用占位标签。 */
function quoteSnippet(kind: MsgKind, content: string): string {
  if (kind === "image") return "[图片]";
  if (kind === "code") return "[代码]";
  if (kind === "file") return "[文件]";
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

const emit = defineEmits<{
  (e: "quote", payload: { sender: string; snippet: string; msgId: string | number }): void;
  (e: "forward", payload: { kind: MsgKind; content: string; snippet: string }): void;
  (e: "locate", msgId: string): void;
}>();

function doQuote() {
  ctxMenu.value = null;
  const msg = props.message;
  emit("quote", {
    sender: mine.value ? app.device?.nickname || "我" : props.senderName || msg.sender_id,
    snippet: quoteSnippet(msg.kind, msg.content),
    msgId: msg.msg_id ?? msg.id,
  });
}

function doForward() {
  const msg = props.message;
  const payload = { kind: msg.kind as MsgKind, content: msg.content, snippet: quoteSnippet(msg.kind, msg.content) };
  ctxMenu.value = null;
  emit("forward", payload);
}

async function retrySend() {
  const msg = props.message;
  if (msg.status !== "failed" || msg.kind === "file") return;
  try {
    await chat.send(msg.conv_id, msg.content, msg.kind);
  } catch {
    // 失败状态已由 send() 内部处理
  }
}
</script>

<template>
  <div class="py-0.5" :class="highlighted ? 'rounded-lg bg-primary/5 ring-1 ring-primary/25' : ''">
    <!-- 时间分割线（间隔 ≥ 5 分钟）：居中浅灰小字 -->
    <div v-if="showTimeDivider" class="py-2 text-center text-[11px] text-[var(--gosslan-text-2)]">
      {{ timeDividerText }}
    </div>

    <!-- 未读分割线（打开会话时定位的第一条未读上方） -->
    <div v-if="showUnreadDivider" class="my-1.5 flex items-center gap-2 px-3">
      <div class="h-px flex-1 bg-primary/30"></div>
      <span class="rounded-full bg-primary-light px-2 py-0.5 text-[11px] text-primary">以下是未读消息</span>
      <div class="h-px flex-1 bg-primary/30"></div>
    </div>

    <div class="flex gap-2 px-4" :class="mine ? 'flex-row-reverse' : ''">
      <!-- 头像：每条消息独立完整渲染 -->
      <MessageAvatar :name="avatarName" :avatar="avatarSrc" />

      <div class="flex min-w-0 max-w-[72%] flex-col" :class="mine ? 'items-end' : 'items-start'">
        <!-- 群聊发送者昵称 -->
        <div v-if="showNickname" class="mb-0.5 px-1 text-[11px] text-[var(--gosslan-text-2)]">
          {{ senderName || message.sender_id }}
        </div>

        <!-- 系统消息 -->
        <div
          v-if="message.kind === 'system'"
          class="w-full text-center text-xs text-[var(--gosslan-text-2)]"
        >
          {{ message.content }}
        </div>

        <!-- 消息行：气泡 + 侧挂回执（mine 时回执在气泡左侧）；右键弹消息菜单 -->
        <div
          v-else
          class="group/row flex w-full items-end gap-1.5"
          :class="mine ? 'justify-end' : 'justify-start'"
          @contextmenu.prevent="openContextMenu"
        >
          <MessageReceipt
            v-if="mine"
            :state="sendState"
            :title="receiptTitle"
            :is-group="isGroup"
            :reader-ids="groupReaderIds"
            :msg-key="message.msg_id ?? message.id"
            @retry="retrySend"
          />

          <!-- 文本 -->
          <MessageTextBubble
            v-if="message.kind === 'text'"
            :content="message.content"
            :bubble-style="bubbleStyle"
            :clamped="isLongText"
            :copied="copiedKey === 'text'"
            @expand="openFullModal('text', $event)"
            @copy="copyContent('text', $event)"
            @locate="emit('locate', $event)"
          />

          <!-- 代码：inline code 消息与代码附件同一套预览；超过 5 行裁断，全文进 Modal -->
          <MessageCodeBubble
            v-else-if="streamCode !== null"
            :code="streamCode"
            :clamped="streamCodeClamped"
            :copied="copiedKey === 'code'"
            :dark="app.dark"
            @expand="openFullModal('code', $event)"
            @copy="copyContent('code', $event)"
          />

          <!-- 图片 -->
          <MessageImageBubble
            v-else-if="message.kind === 'image'"
            :src="message.content"
            @open="openImageLightbox"
          />

          <!-- 附件图片预览（file + subtype:image，接收完成后显示本地图片） -->
          <MessageImageBubble
            v-else-if="message.kind === 'file' && attachmentUrl"
            :src="attachmentUrl"
            @open="openImageLightbox"
          />

          <!-- 文件 -->
          <MessageFileBubble
            v-else-if="message.kind === 'file' && fileMeta"
            :meta="fileMeta"
            :bubble-style="bubbleStyle"
            :progress="fileProgress"
            :status-text="fileStatusText"
            :failed="sendState === 'failed'"
            :note="previewNote"
            :delivery="isGroupFile ? deliverySummary : null"
            @open="openFile"
            @save="saveAs"
          />

          <div v-else class="px-3 py-2 text-sm" :style="bubbleStyle">
            {{ message.content }}
          </div>
        </div>

        <!-- 时间行：每条消息独立显示，hover 可见秒级 -->
        <div
          class="mt-0.5 px-1 text-[11px] text-[var(--gosslan-text-2)]"
          :class="mine ? 'text-right' : ''"
        >
          <span class="group-hover/row:hidden">{{ time }}</span>
          <span class="hidden group-hover/row:inline">{{ fullTime }}</span>
        </div>
      </div>
    </div>
  </div>

  <MessageContentModal
    :open="fullModalOpen"
    :kind="fullModalKind"
    :content="fullModalContent"
    :copied="copiedKey === 'full'"
    @close="fullModalOpen = false"
    @copy="copyContent('full', $event)"
  />

  <!-- 消息右键菜单 -->
  <MessageContextMenu
    v-if="ctxMenu"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
    :kind="message.kind"
    @close="ctxMenu = null"
    @copy-text="ctxMenu = null; copyContent(message.kind === 'code' ? 'code' : 'text', message.content)"
    @copy-image="copyImage"
    @save-image="saveImage"
    @quote="doQuote"
    @forward="doForward"
  />

  <!-- 图片查看器（自研：与其它弹窗同风格，滚轮缩放/拖动/Esc） -->
  <ImageLightbox :src="lightboxSrc" :open="lightboxOpen" @close="lightboxOpen = false" />
</template>
