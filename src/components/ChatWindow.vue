<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import MessageItem from "@/components/MessageItem.vue";
import VirtualList from "@/components/VirtualList.vue";
import GroupMemberPanel from "@/components/GroupMemberPanel.vue";
import ChatHeader from "@/components/chat/ChatHeader.vue";
import MessageComposer from "@/components/chat/MessageComposer.vue";
import RenameGroupModal from "@/components/chat/RenameGroupModal.vue";
import ForwardModal from "@/components/message/ForwardModal.vue";
import { estimateMessageHeight } from "@/utils/messageHeight";
import { ArrowDown } from "lucide-vue-next";
import type { MessageRecord, MsgKind } from "@/types";

const emit = defineEmits<{ (e: "open-share"): void }>();

const app = useAppStore();
const chat = useChatStore();

const listRef = ref<InstanceType<typeof VirtualList> | null>(null);

const conv = computed(() => chat.activeConversation);
const isGroup = computed(() => chat.activeConv?.startsWith("group:") ?? false);
const messages = computed(() => chat.messages[chat.activeConv ?? ""] ?? []);

const online = computed(() => {
  if (!conv.value || conv.value.kind !== "single") return false;
  return chat.friends.some((f) => f.device_id === conv.value!.id && f.online);
});
const isPeerFriend = computed(() => {
  if (!conv.value || conv.value.kind !== "single") return true;
  return chat.friends.some((f) => f.device_id === conv.value!.id);
});

/** 与 MessageItem 共用 previewMetrics 常量：估算高度 = 真实渲染高度。 */
function estimateHeight(m: MessageRecord, index?: number): number {
  return estimateMessageHeight(m, index, {
    messages: messages.value,
    isGroup: isGroup.value,
    selfId: app.device?.device_id,
    fontSize: app.chatStyle.fontSize,
  });
}

// ---------------- 群：成员面板 + 改名 ----------------
const membersOpen = ref(false);
const activeGroupId = computed(() =>
  isGroup.value && chat.activeConv ? chat.activeConv.slice(6) : null,
);
const memberCount = computed(() => {
  const gid = activeGroupId.value;
  if (!gid) return 0;
  return chat.groups.find((g) => g.id === gid)?.members.length ?? 0;
});
const canRename = computed(() => {
  const gid = activeGroupId.value;
  if (!gid) return false;
  return chat.groups.find((g) => g.id === gid)?.creator === app.device?.device_id;
});
const renameOpen = ref(false);
const renameCurrent = computed(
  () => chat.groups.find((g) => g.id === activeGroupId.value)?.name ?? "",
);

// ---------------- 群聊 @ ----------------
/** @ 选择选项（不含自己）：名字与消息流昵称同源（nicknameOf），插入的 @名字 必须能和渲染端对上。 */
const mentionMembers = computed(() => {
  const gid = activeGroupId.value;
  const g = gid ? chat.groups.find((x) => x.id === gid) : null;
  if (!g) return [];
  const me = app.device?.device_id;
  return g.members.filter((id) => id !== me).map((id) => ({ id, name: chat.nicknameOf(id) }));
});
/** 渲染端 @ 高亮用的成员名列表（含自己：别人发的消息里可以 @ 我）。 */
const mentionNames = computed(() => {
  const gid = activeGroupId.value;
  const g = gid ? chat.groups.find((x) => x.id === gid) : null;
  return g ? g.members.map((id) => chat.nicknameOf(id)) : [];
});
async function confirmRename(name: string) {
  renameOpen.value = false;
  const gid = activeGroupId.value;
  if (!gid || !name) return;
  try {
    await chat.renameGroup(gid, name);
    app.toast("群名称已更新", "success");
  } catch (e) {
    app.toast(`重命名失败：${e}`, "error");
  }
}

/** 当前会话的第一条未读索引（后端 markRead 前已记录，随历史 prepend 偏移）。 */
const unreadIndex = computed(() => {
  const uj = chat.unreadJump;
  if (!uj || uj.convId !== chat.activeConv) return -1;
  return uj.index;
});

// ---------------- 滚动 ----------------
const nearBottom = ref(true);

// 打开会话/未读定位：优先跳到第一条未读（该消息贴视口顶部），无未读则贴底。
// 跳转后显式解除贴底：防止总高度重测的钉底把用户从未读位置拽回底部。
// unreadJump.index = -1 表示「有未读但消息还在加载、索引未知」，此时不动滚动。
watch(
  () => chat.unreadJump,
  async (uj) => {
    if (!uj || uj.convId !== chat.activeConv) return;
    if (uj.index < 0) return;
    await nextTick();
    await nextTick();
    listRef.value?.scrollToIndex(uj.index, "top");
    listRef.value?.setPinned(false);
  },
  { immediate: true },
);

// 区分 append（末尾新增）、prepend（开头插入历史）与切会话：
// - append 且（自己发的 / 已在底部）→ 贴底；prepend 不滚动（VirtualList 锚定保持位置）；
// - 切会话时重置跟踪，首屏定位交给 unreadJump / VirtualList 的 swap 逻辑，
//   不做 append 式贴底（否则缓存会话切换时会先被拽到底部，再跳未读，来回闪）。
let lastMsgId: string | number | null = null;
watch(
  () => [chat.activeConv, messages.value.length] as const,
  async ([convId], old) => {
    const [oldConvId, oldLen] = old ?? [null, 0];
    if (convId !== oldConvId) {
      lastMsgId = messages.value.at(-1)?.msg_id ?? null;
      // 首次加载（0→N）且没有未读跳转 → 打开即贴底；有未读则等 unreadJump 定位
      if (oldLen === 0 && !(chat.unreadJump && chat.unreadJump.convId === convId)) {
        await nextTick();
        listRef.value?.scrollToBottom();
      }
      return;
    }

    if (oldLen === 0) {
      if (!(chat.unreadJump && chat.unreadJump.convId === convId)) {
        await nextTick();
        listRef.value?.scrollToBottom();
      }
      lastMsgId = messages.value.at(-1)?.msg_id ?? null;
      return;
    }

    const newLast = messages.value.at(-1);
    const newLastId = newLast?.msg_id ?? null;
    const isAppend = newLastId !== null && newLastId !== lastMsgId;
    lastMsgId = newLastId;

    if (isAppend) {
      // 自己发的消息无论 nearBottom 都贴底；对方的消息仅在用户已在底部附近时贴底。
      // 用户 1.2s 内主动向上滚动过则不打扰（否则新消息会反复把人拽回底部）
      const isMine = newLast?.sender_id === app.device?.device_id;
      if ((isMine || nearBottom.value) && !listRef.value?.recentScrollUp?.()) {
        await nextTick();
        listRef.value?.scrollToBottom();
      }
    }
  },
);

// ---------------- 发送 ----------------
async function onSend({ content, kind }: { content: string; kind: MsgKind }) {
  const convId = chat.activeConv;
  if (!convId || !isPeerFriend.value) return;
  try {
    await chat.send(convId, content, kind);
  } catch (e) {
    app.toast(`发送失败：${e}`, "error");
  }
}

/** 粘贴图片：走 save_outgoing_image → 文件传输，data URL 不进入 SQLite。 */
async function onSendImage(dataUrl: string) {
  const convId = chat.activeConv;
  if (!convId || !isPeerFriend.value) return;
  await chat.sendImage(convId, dataUrl);
}

// ---------------- 引用 / 转发 ----------------
/** 待引用消息（MessageItem 右键"引用"设置，随发送或手动取消清除）。 */
const quote = ref<{ sender: string; snippet: string; msgId: string | number } | null>(null);

/** 转发弹窗状态（MessageItem 右键"转发"设置）。文件消息带本地路径，转发即重发文件。 */
const forward = ref<{ kind: MsgKind; content: string; snippet: string; filePath?: string } | null>(null);

/** 点击引用块定位原消息：滚动 + 短暂高亮 */
const highlightId = ref<string | number | null>(null);
let highlightTimer = 0;
function locateMessage(id: string) {
  const idx = messages.value.findIndex((m) => (m.msg_id ?? m.id) === id);
  if (idx < 0) {
    app.toast("原消息不在已加载范围内", "info");
    return;
  }
  listRef.value?.scrollToIndex(idx, "top");
  listRef.value?.setPinned(false);
  highlightId.value = id;
  window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => (highlightId.value = null), 1600);
}

async function doForward(convId: string) {
  const f = forward.value;
  forward.value = null;
  if (!f) return;
  try {
    if (f.kind === "file") {
      // 文件转发＝按本地路径把文件重发一遍（内容 JSON 只是元信息，直接转发会指向本机路径）
      if (!f.filePath) {
        app.toast("文件尚未同步到本机，无法转发", "info");
        return;
      }
      if (convId.startsWith("group:")) {
        await chat.sendGroupFileTo(convId.slice(6), f.filePath);
      } else {
        await chat.sendFileTo(convId, f.filePath);
      }
    } else {
      await chat.send(convId, f.content, f.kind);
    }
    app.toast("转发成功", "success");
  } catch (e) {
    app.toast(`转发失败：${e}`, "error");
  }
}

/** 统一发送文件：自动路由（直连优先，弱网/无直连自动中继），无需用户选择。
 *  群聊会话走群文件链路（send_group_file：Offer → Chunk → Done → CompleteAck）。 */
async function sendOneFile(convId: string, picked: string) {
  if (isGroup.value) {
    const gid = activeGroupId.value;
    if (!gid) return;
    await chat.sendGroupFileTo(gid, picked);
  } else {
    await chat.sendFileTo(convId, picked);
  }
}

async function attachFile() {
  const convId = chat.activeConv;
  if (!convId) return;
  if (!isGroup.value && !isPeerFriend.value) return;
  const picked = await openDialog({ multiple: false });
  if (typeof picked !== "string") return;
  await sendOneFile(convId, picked);
}

/** 输入框粘贴文件（资源管理器复制后 Ctrl+V，微信式）：按真实路径直接走发送链路。 */
async function sendPastedFiles(paths: string[]) {
  const convId = chat.activeConv;
  if (!convId) return;
  for (const p of paths) {
    try {
      await sendOneFile(convId, p);
    } catch (e) {
      app.toast(`发送失败：${e}`, "error");
    }
  }
}

/** 触顶加载更早的历史消息。 */
function onLoadMore() {
  const convId = chat.activeConv;
  if (convId) void chat.loadMoreMessages(convId);
}
</script>

<template>
  <div class="flex h-full flex-col bg-[var(--gosslan-chat)]">
    <ChatHeader
      :conv="conv"
      :is-group="isGroup"
      :online="online"
      :member-count="memberCount"
      :can-rename="canRename"
      :show-back="app.isMobile"
      @back="app.mobileView = 'list'"
      @open-members="membersOpen = true"
      @rename="renameOpen = true"
      @open-share="emit('open-share')"
    />

    <!-- 消息区（虚拟滚动，仅纵向）：与头部同底色，无缝衔接 -->
    <div class="relative min-h-0 flex-1 overflow-hidden bg-[var(--gosslan-chat)]">
      <div v-if="messages.length === 0" class="mt-20 text-center text-sm text-[var(--gosslan-text-2)]">
        暂无消息，打个招呼吧
      </div>
      <VirtualList
        v-else
        ref="listRef"
        :items="messages"
        :auto-scroll-on-swap="!(chat.unreadJump && chat.unreadJump.convId === chat.activeConv)"
        :estimate-height="estimateHeight"
        @load-more="onLoadMore"
        @near-bottom="nearBottom = $event"
      >
        <template #default="{ item, index }">
          <MessageItem
            :message="item"
            :prev="index > 0 ? messages[index - 1] : null"
            :is-group="isGroup"
            :sender-name="isGroup ? chat.nicknameOf(item.sender_id) : ''"
            :group-reader-ids="isGroup && activeGroupId ? chat.groupReaderIds(activeGroupId, item.ts) : []"
            :show-unread-divider="index === unreadIndex"
            :highlight-id="highlightId"
            :mention-names="mentionNames"
            @quote="quote = $event"
            @forward="forward = $event"
            @locate="locateMessage"
          />
        </template>
      </VirtualList>

      <!-- 回到最新（离开底部时出现） -->
      <button
        v-if="!nearBottom"
        class="absolute bottom-4 right-5 z-10 flex items-center gap-1.5 rounded-full border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 py-1.5 text-xs text-[var(--gosslan-text)] shadow-lg transition hover:bg-[var(--gosslan-hover)]"
        @click="nearBottom = true; listRef?.scrollToBottom()"
      >
        <ArrowDown class="h-3.5 w-3.5" />
        回到最新
      </button>
    </div>

    <!-- 输入区：浅灰底上放一个白底圆角卡片，无顶部分割线 -->
    <div class="shrink-0 bg-[var(--gosslan-chat)] px-4 pb-3 pt-2">
      <MessageComposer
        v-if="isGroup || isPeerFriend"
        :conv-id="chat.activeConv"
        :quote="quote"
        :mention-members="mentionMembers"
        @send="onSend"
        @send-image="onSendImage"
        @attach="attachFile"
        @paste-files="sendPastedFiles"
        @close-quote="quote = null"
      />
      <div
        v-else
        class="flex min-h-16 items-center justify-center rounded-[var(--gosslan-bubble-radius)] bg-[var(--gosslan-panel)] px-4 text-center text-[13px] text-[var(--gosslan-text-2)]"
      >
        对方还不是你的好友，添加好友后才能继续聊天。当前仅可查看聊天记录。
      </div>
    </div>

    <!-- 群成员面板 -->
    <GroupMemberPanel :open="membersOpen" :group-id="activeGroupId" @close="membersOpen = false" />

    <!-- 转发弹窗 -->
    <ForwardModal
      v-if="forward"
      :open="true"
      :kind="forward.kind"
      :snippet="forward.snippet"
      @close="forward = null"
      @pick="doForward"
    />

    <!-- 修改群名称（仅群主可见入口） -->
    <RenameGroupModal
      :open="renameOpen"
      :current-name="renameCurrent"
      @close="renameOpen = false"
      @confirm="confirmRename"
    />
  </div>
</template>
