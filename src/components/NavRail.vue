<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { MessageCircle, Moon, Sun, Users } from "lucide-vue-next";

defineProps<{ view: "chats" | "contacts" }>();
const emit = defineEmits<{
  (e: "update:view", v: "chats" | "contacts"): void;
  (e: "open-settings"): void;
}>();

const app = useAppStore();
const chat = useChatStore();
const initials = computed(() => (app.device?.nickname ?? "?").slice(0, 1).toUpperCase());
/** 未读徽标显示上限 */
const unreadLabel = computed(() => (chat.totalUnread > 99 ? "99+" : String(chat.totalUnread)));
const pendingLabel = computed(() =>
  chat.pendingRequests.length > 99 ? "99+" : String(chat.pendingRequests.length),
);
</script>

<template>
  <!-- 微信式窄导航栏：顶部本人头像 + 中部导航图标 + 底部偏好；
       选中项仅图标变色（主题色），不改底色，与微信一致 -->
  <aside
    class="hidden shrink-0 select-none flex-col items-center bg-[var(--gosslan-rail)] py-3 md:flex"
    :style="{ width: 'var(--gosslan-rail-w)' }"
  >
    <!-- 顶部：本人头像（点开设置/我） -->
    <button
      class="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] bg-primary text-white transition hover:opacity-90"
      :title="app.online ? '我在线（局域网已连接）' : '离线（局域网未连接）'"
      @click="emit('open-settings')"
    >
      <img v-if="app.device?.avatar" :src="app.device.avatar" class="h-full w-full object-cover" />
      <span v-else class="text-sm font-medium">{{ initials }}</span>
      <!-- 本人在线状态点 -->
      <span
        class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--gosslan-rail)]"
        :class="app.online ? 'bg-primary' : 'bg-neutral-400'"
      ></span>
    </button>

    <!-- 中部：聊天 / 通讯录（选中仅图标变主题色，无背景块） -->
    <div class="mt-5 flex flex-col items-center gap-2">
      <button
        class="relative flex h-11 w-11 items-center justify-center rounded-xl transition"
        :class="view === 'chats'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        title="聊天"
        @click="emit('update:view', 'chats')"
      >
        <MessageCircle class="h-[22px] w-[22px]" :fill="view === 'chats' ? 'currentColor' : 'none'" :stroke-width="view === 'chats' ? 2 : 1.9" />
        <span
          v-if="chat.totalUnread > 0"
          class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white"
        >
          {{ unreadLabel }}
        </span>
      </button>
      <button
        class="relative flex h-11 w-11 items-center justify-center rounded-xl transition"
        :class="view === 'contacts'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        title="通讯录"
        @click="emit('update:view', 'contacts')"
      >
        <Users class="h-[22px] w-[22px]" :fill="view === 'contacts' ? 'currentColor' : 'none'" :stroke-width="view === 'contacts' ? 2 : 1.9" />
        <span
          v-if="chat.pendingRequests.length"
          class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white"
        >
          {{ pendingLabel }}
        </span>
      </button>
    </div>

    <!-- 底部：深浅色切换 + 设置 -->
    <div class="mt-auto flex flex-col items-center gap-2">
      <button
        class="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-rail-hover)]"
        :title="app.dark ? '浅色模式' : '深色模式'"
        @click="app.toggleDark()"
      >
        <Sun v-if="app.dark" class="h-[19px] w-[19px]" />
        <Moon v-else class="h-[19px] w-[19px]" />
      </button>
      <button
        class="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-rail-hover)]"
        title="设置"
        @click="emit('open-settings')"
      >
        <svg viewBox="0 0 24 24" class="h-[19px] w-[19px]" fill="none" stroke="currentColor" stroke-width="1.9">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  </aside>
</template>
