<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import NavRail from "@/components/NavRail.vue";
import TitleBar from "@/components/TitleBar.vue";
import ConversationList from "@/components/ConversationList.vue";
import ChatWindow from "@/components/ChatWindow.vue";
import FriendProfile from "@/components/FriendProfile.vue";
import SettingsPanel from "@/components/SettingsPanel.vue";
import AddFriendModal from "@/components/AddFriendModal.vue";
import GroupCreateModal from "@/components/GroupCreateModal.vue";
import ShareDirectory from "@/components/ShareDirectory.vue";
import { MessageCircle, Settings, Users } from "lucide-vue-next";
import type { Friend } from "@/types";

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
  if (app.isMobile) app.mobileView = "chat";
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

// 打开会话/切走时收起资料页，避免右侧同时出现两个内容区
watch(
  () => chat.activeConv,
  () => {
    profileFriend.value = null;
  },
);

// 通知点击跳转：好友申请通知 → 切换到联系人视图
function onNavigateToContacts() {
  view.value = "contacts";
  if (app.isMobile) app.mobileView = "list";
}
onMounted(() => window.addEventListener("navigate-to-contacts", onNavigateToContacts));
onUnmounted(() => window.removeEventListener("navigate-to-contacts", onNavigateToContacts));
</script>

<template>
  <div class="flex h-screen w-full flex-col overflow-hidden bg-[var(--gosslan-bg)] font-gosslan text-[var(--gosslan-text)]">
    <!-- 自绘标题栏（桌面端）：与页面同色融合，拖动窗口 -->
    <TitleBar />

    <div class="flex min-h-0 flex-1 overflow-hidden">
    <!-- 左导航（桌面） -->
    <NavRail :view="view" @update:view="view = $event" @open-settings="openSettings" />

    <!-- 会话列表（桌面 300px / 移动端全宽，滑动切换） -->
    <aside
      class="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out md:w-[300px]"
      :class="app.isMobile ? (app.mobileView === 'list' ? 'w-full' : 'w-0') : 'w-[300px]'"
    >
      <div class="h-full w-[100vw] max-w-full md:w-[300px]">
        <ConversationList
          :view="view"
          :active-friend-id="profileFriend?.device_id ?? null"
          @update:view="view = $event"
          @open-add-friend="addFriendOpen = true"
          @open-group="groupOpen = true"
          @open-friend="openFriendProfile"
        />
      </div>
    </aside>

    <!-- 右侧内容区：好友资料页 / 聊天 / 空态 -->
    <main
      class="flex h-full min-w-0 flex-1 flex-col"
      :class="app.isMobile && app.mobileView === 'list' ? 'hidden' : ''"
    >
      <div class="min-h-0 flex-1 pb-16 md:pb-0">
        <FriendProfile
          v-if="profileFriend"
          :friend="profileFriend"
          @send-message="sendMessageTo"
          @remove="removeFriend"
        />
        <ChatWindow v-else-if="chat.activeConv" @open-share="shareOpen = true" />
        <div
          v-else
          class="flex h-full select-none flex-col items-center justify-center gap-3 text-[var(--gosslan-text-2)]"
        >
          <MessageCircle class="h-16 w-16 opacity-25" />
          <div class="text-base">选择会话，开始局域网聊天</div>
          <div class="text-xs opacity-70">无服务器 · 纯 P2P · 端到端加密 · 数据仅存本机</div>
        </div>
      </div>
    </main>
    </div>

    <!-- 移动端底部导航 -->
    <nav
      v-if="app.isMobile"
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

    <!-- Toast -->
    <div class="pointer-events-none fixed left-1/2 top-4 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      <div
        v-for="t in app.toasts"
        :key="t.id"
        class="rounded-lg px-4 py-2 text-sm text-white shadow-lg"
        :class="t.type === 'success' ? 'bg-emerald-600' : t.type === 'error' ? 'bg-red-600' : 'bg-neutral-800'"
      >
        {{ t.text }}
      </div>
    </div>
  </div>
</template>
