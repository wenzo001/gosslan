<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import NavRail from "@/components/NavRail.vue";
import TitleBar from "@/components/TitleBar.vue";
import ConversationList from "@/components/ConversationList.vue";
import ChatWindow from "@/components/ChatWindow.vue";
import FriendProfile from "@/components/FriendProfile.vue";
import FriendRequestList from "@/components/conversation/FriendRequestList.vue";
import SettingsPanel from "@/components/SettingsPanel.vue";
import AddFriendModal from "@/components/AddFriendModal.vue";
import GroupCreateModal from "@/components/GroupCreateModal.vue";
import ShareDirectory from "@/components/ShareDirectory.vue";
import { CheckCircle2, Info, MessageCircle, Settings, Users, XCircle } from "lucide-vue-next";
import type { Friend, PendingRequest } from "@/types";

const app = useAppStore();
const chat = useChatStore();

const view = ref<"chats" | "contacts">("chats");
/** 正在查看资料的好友（通讯录点击好友 → 展示资料页，而非直接开会话） */
const profileFriend = ref<Friend | null>(null);
const settingsOpen = ref(false);
const addFriendOpen = ref(false);
const groupOpen = ref(false);
const shareOpen = ref(false);

function openSettings() {
  settingsOpen.value = true;
  if (app.isMobile) app.mobileView = "list";
}

function openFriendProfile(f: Friend) {
  profileFriend.value = f;
  showRequests.value = false;
  if (app.isMobile) app.mobileView = "chat";
}

/** 「新的朋友」页：右侧主区展示好友申请列表（微信式） */
const showRequests = ref(false);

function openRequests() {
  showRequests.value = true;
  profileFriend.value = null;
}

/** 收起「新的朋友」页：有会话在聊时切回「聊天」tab，
 *  否则会出现右侧在聊、左侧还停在通讯录的错位。 */
function closeRequests() {
  showRequests.value = false;
  if (chat.activeConv) view.value = "chats";
}

async function acceptRequest(r: PendingRequest) {
  try {
    await chat.respondRequest(r.from, true);
    app.toast(`已同意 ${r.from_nickname} 的好友申请`, "success");
  } catch (e) {
    app.toast(`操作失败：${e}`, "error");
  }
}
async function rejectRequest(r: PendingRequest) {
  try {
    await chat.respondRequest(r.from, false);
    app.toast("已拒绝该好友申请", "info");
  } catch (e) {
    app.toast(`操作失败：${e}`, "error");
  }
}

/** 资料页「发消息」：回到消息视图并打开与该好友的会话 */
async function sendMessageTo(id: string) {
  profileFriend.value = null;
  view.value = "chats";
  await chat.openConversation(id);
  if (app.isMobile) app.mobileView = "chat";
}

async function removeFriend(f: Friend) {
  profileFriend.value = null;
  try {
    await chat.removeFriend(f.device_id);
    app.toast(`已删除好友 ${f.nickname}（可在添加好友中重新添加）`, "info");
  } catch (e) {
    app.toast(`删除失败：${e}`, "error");
  }
}

// 打开会话/切走时收起资料页与新朋友页，避免右侧同时出现多个内容区；
// 会话一旦打开（接受好友申请自动开会话 / 通知点击跳转等），主视图切回「聊天」tab，
// 否则右侧在聊、左侧 tab 还停在通讯录，布局与底部高亮都错位。
watch(
  () => chat.activeConv,
  (convId) => {
    profileFriend.value = null;
    showRequests.value = false;
    if (convId) view.value = "chats";
  },
);

// 从通讯录切回「聊天」视图时退出好友资料页与"新的朋友"页，否则旧页面占住主区
watch(
  view,
  (v) => {
    if (v === "chats") {
      profileFriend.value = null;
      showRequests.value = false;
    }
  },
);

// 桌面端默认选中：启动后会话列表就绪且当前无选中会话时，自动打开最近的一个会话，
// 右侧直接进入聊天（对齐微信桌面版行为）；移动端保持列表优先，不自动跳转。
watch(
  () => chat.conversations,
  (convs) => {
    if (app.isMobile) return;
    if (!chat.activeConv && convs.length > 0) void chat.openConversation(convs[0].id);
  },
  { immediate: true },
);

// 通知点击跳转：好友申请通知 → 切换到联系人视图
function onNavigateToContacts() {
  view.value = "contacts";
  if (app.isMobile) app.mobileView = "list";
}
onMounted(() => window.addEventListener("navigate-to-contacts", onNavigateToContacts));
onUnmounted(() => window.removeEventListener("navigate-to-contacts", onNavigateToContacts));

// ---------------- 桌面端：列表栏宽度拖拽（rail 64px 固定，列表 200~420px，持久化） ----------------
const RAIL_W = 64;
const LIST_W_MIN = 200;
const LIST_W_MAX = 420;
const listW = ref(
  Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, Number(localStorage.getItem("gosslan-list-w")) || 250)),
);
let resizing = false;

function onResizeStart(e: PointerEvent) {
  resizing = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}
function onResizeMove(e: PointerEvent) {
  if (!resizing) return;
  listW.value = Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, e.clientX - RAIL_W));
}
function onResizeEnd() {
  if (!resizing) return;
  resizing = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.setItem("gosslan-list-w", String(listW.value));
}
</script>

<template>
    <div
    class="flex h-screen w-full flex-col overflow-hidden bg-[var(--gosslan-caption)] font-gosslan text-[var(--gosslan-text)]"
    :class="app.isMobile
      ? ''
      : 'rounded-xl ring-1 ring-inset ring-[var(--gosslan-window-ring)]'"
  >
    <!-- 移动端顶部安全区：大圆角/刘海屏下为状态栏留出空间，避免搜索框顶到屏幕外框 -->
    <div v-if="app.isMobile" class="safe-top shrink-0"></div>

    <!-- 顶部 caption：横贯整个窗口（盖在 rail + list + chat 三列之上），微信 4.0 顶部是整条浅灰拖拽条 -->
    <TitleBar />

    <!-- 桌面：rail（左）| 列表（中）| 聊天（右）三列；移动端按 mobileView 抽屉切换 -->
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
    <!-- 左侧导航栏：顶格到 caption 之下，浅灰与 caption 一体 -->
    <NavRail :view="view" @update:view="view = $event" @open-settings="openSettings" />

    <!-- 会话列表：桌面宽度可拖拽调（默认250px，持久化）；移动端整屏抽屉，靠 translate 滑动切换 -->
    <aside
      class="h-full shrink-0 overflow-hidden rounded-tl-xl bg-[var(--gosslan-list)]"
      :class="app.isMobile
        ? 'absolute inset-y-0 left-0 z-20 w-full transition-transform duration-300 ease-out ' +
          (app.mobileView === 'list' ? 'translate-x-0' : '-translate-x-full')
        : ''"
      :style="app.isMobile ? undefined : { width: `${listW}px` }"
    >
      <ConversationList
        :view="view"
        :active-friend-id="profileFriend?.device_id ?? null"
        :requests-active="showRequests"
        @update:view="view = $event"
        @open-add-friend="addFriendOpen = true"
        @open-group="groupOpen = true"
        @open-friend="openFriendProfile"
        @open-requests="openRequests"
      />
    </aside>

    <!-- 拖拽分隔条：悬浮叠在列表/聊天交界上（负外边距抵消布局宽度），不留缝；
         平时透明，悬停/拖拽时高亮 -->
    <div
      v-if="!app.isMobile"
      class="relative z-10 hidden w-2 cursor-col-resize transition-colors hover:bg-primary/25 md:block"
      :class="resizing ? '-mx-1 bg-primary/40' : '-mx-1'"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
    ></div>

    <!-- 右侧聊天区：白色面板，左上角圆角与列表相交（微信式），面板色差替代分割线 -->
    <main
      class="flex h-full min-w-0 flex-1 flex-col rounded-tl-xl bg-[var(--gosslan-chat)]"
      :class="app.isMobile && app.mobileView === 'list' ? 'hidden' : ''"
    >
      <div
        class="min-h-0 flex-1 md:pb-0"
        :class="app.isMobile
          ? (app.keyboardOpen ? 'pb-2' : 'pb-[calc(4rem+env(safe-area-inset-bottom))]')
          : ''"
      >
        <!-- 新的朋友页：右侧展示好友申请列表（微信式） -->
        <div v-if="showRequests" class="flex h-full flex-col">
          <div class="flex shrink-0 items-center border-b border-[var(--gosslan-divider)] bg-[var(--gosslan-chat)] px-4" :style="{ height: 'var(--gosslan-header-h)' }">
            <span class="text-[15px] font-medium">新的朋友</span>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto bg-[var(--gosslan-chat)] p-2">
            <FriendRequestList
              :requests="chat.pendingRequests"
              :open="true"
              @close="closeRequests"
              @accept="acceptRequest"
              @reject="rejectRequest"
            />
            <div v-if="chat.pendingRequests.length === 0" class="mt-20 text-center text-sm text-[var(--gosslan-text-2)]">
              暂无好友申请
            </div>
          </div>
        </div>
        <FriendProfile
          v-if="!showRequests && profileFriend !== null"
          :friend="profileFriend"
          @send-message="sendMessageTo"
          @remove="removeFriend"
        />
        <ChatWindow v-else-if="!showRequests && chat.activeConv" @open-share="shareOpen = true" />
        <div
          v-else-if="!showRequests"
          class="flex h-full select-none flex-col items-center justify-center gap-3 text-[var(--gosslan-text-2)]"
        >
          <MessageCircle class="h-16 w-16 opacity-25" />
          <div class="text-base">选择会话，开始局域网聊天</div>
          <div class="text-xs opacity-70">无服务器 · 纯 P2P · 端到端加密 · 数据仅存本机</div>
        </div>
      </div>
    </main>
    </div>

    <!-- 移动端底部导航（软键盘弹出时收起，避免浮在键盘上方遮挡输入） -->
    <nav
      v-if="app.isMobile && !app.keyboardOpen"
      class="safe-bottom fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-[var(--gosslan-border)] bg-[var(--gosslan-panel)]"
    >
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="view === 'chats' && app.mobileView === 'list' ? 'text-primary' : 'text-[var(--gosslan-text-2)]'"
        @click="app.mobileView = 'list'; view = 'chats'"
      >
        <span class="relative">
          <MessageCircle class="h-5 w-5" />
          <span
            v-if="chat.totalUnread > 0"
            class="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ chat.totalUnread > 99 ? "99+" : chat.totalUnread }}
          </span>
        </span>
        <span class="text-[10px]">消息</span>
      </button>
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="view === 'contacts' && app.mobileView === 'list' ? 'text-primary' : 'text-[var(--gosslan-text-2)]'"
        @click="app.mobileView = 'list'; view = 'contacts'"
      >
        <span class="relative">
          <Users class="h-5 w-5" />
          <span
            v-if="chat.pendingRequests.length"
            class="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ chat.pendingRequests.length > 99 ? "99+" : chat.pendingRequests.length }}
          </span>
        </span>
        <span class="text-[10px]">联系人</span>
      </button>
      <button
        class="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[var(--gosslan-text-2)]"
        @click="openSettings"
      >
        <Settings class="h-5 w-5" />
        <span class="text-[10px]">设置</span>
      </button>
    </nav>

    <!-- 弹窗 -->
    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <AddFriendModal :open="addFriendOpen" @close="addFriendOpen = false" />
    <GroupCreateModal :open="groupOpen" @close="groupOpen = false" />
    <ShareDirectory :open="shareOpen" @close="shareOpen = false" />

    <!-- Toast：统一深色中性底 + 白字（微信式，与主题色解耦；错误红保留语义） -->
    <div class="pointer-events-none fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <div
        v-for="t in app.toasts"
        :key="t.id"
        class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm"
        :class="t.type === 'error' ? 'bg-red-600/95' : 'bg-neutral-800/90'"
      >
        <CheckCircle2 v-if="t.type === 'success'" class="h-4 w-4 shrink-0" />
        <XCircle v-else-if="t.type === 'error'" class="h-4 w-4 shrink-0" />
        <Info v-else class="h-4 w-4 shrink-0" />
        {{ t.text }}
      </div>
    </div>
  </div>
</template>
