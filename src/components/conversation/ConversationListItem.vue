<script setup lang="ts">
import { fmtConversationTime } from "@/utils/time";
import { highlightText } from "@/utils/highlight";
import { nameToColor } from "@/utils/color";
import { X } from "lucide-vue-next";
import { computed } from "vue";
import { useChatStore } from "@/stores/useChatStore";
import { useMemberProfile } from "@/composables/useMemberProfile";
import type { Conversation } from "@/types";

const props = defineProps<{
  conv: Conversation;
  active: boolean;
  /** 单聊查好友表；群聊无在线概念，传 null 表示不显示状态点。 */
  online: boolean | null;
  /** 搜索命中摘要（null 时显示最后一条消息）。 */
  snippet: string | null;
  keyword: string;
}>();
const emit = defineEmits<{
  (e: "open", conv: Conversation): void;
  (e: "ask-delete", conv: Conversation, ev: MouseEvent): void;
}>();

const chat = useChatStore();
const { memberProfile } = useMemberProfile();

function initials(name: string) {
  return name.slice(0, 1).toUpperCase();
}

/** 群头像九宫格成员（微信式 2x2）：资料解析统一走 useMemberProfile（本机/好友/节点，
 *  离线好友照常显示）。必须保持响应式：好友/群数据是异步加载的，非响应式会在
 *  启动时算死成占位块且不再更新。九宫格每格用成员名 hash → nameToColor，保证
 *  同一成员在单聊列表和群聊九宫格里默认色一致。 */
const gridTiles = computed(() => {
  if (props.conv.kind !== "group") return [];
  const groupId = props.conv.id.replace(/^group:/, "");
  const memberIds = chat.groups.find((g) => g.id === groupId)?.members ?? [];
  const tiles: { avatar: string | null; label: string; color: string }[] = [];
  for (const id of memberIds.slice(0, 4)) {
    const p = memberProfile(id);
    tiles.push({ avatar: p.avatar, label: initials(p.name), color: nameToColor(p.name) });
  }
  while (tiles.length < Math.min(4, Math.max(memberIds.length, 1))) {
    tiles.push({ avatar: null, label: initials(props.conv.name), color: nameToColor(props.conv.name) });
  }
  return tiles;
});
</script>

<template>
  <!-- 微信 4.0：行高 ~64px、贴边；选中态中性浅灰底 + 正文深色文字（不用主题色/彩色，用户要求） -->
  <div
    class="group/conv relative flex h-[64px] cursor-pointer items-center gap-3 px-3 transition-colors"
    :class="active
      ? 'bg-[var(--gosslan-list-active)] text-[var(--gosslan-list-active-text)]'
      : 'hover:bg-[var(--gosslan-list-hover)]'"
    @click="emit('open', conv)"
  >
    <div class="relative shrink-0">
      <!-- 群聊：微信式 2x2 九宫格头像；单聊：单头像 -->
      <div
        v-if="conv.kind === 'group' && gridTiles.length"
        class="grid h-10 w-10 grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-[var(--gosslan-avatar-radius)] bg-[var(--gosslan-divider)]"
      >
        <div
          v-for="(t, i) in gridTiles"
          :key="i"
          class="flex items-center justify-center overflow-hidden text-[10px] font-medium text-white"
          :style="{ backgroundColor: t.color }"
        >
          <img v-if="t.avatar" :src="t.avatar" class="h-full w-full object-cover" />
          <span v-else>{{ t.label }}</span>
        </div>
      </div>
      <div
        v-else
        class="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white"
        :class="online === false ? 'grayscale opacity-70' : ''"
        :style="{ backgroundColor: nameToColor(conv.name) }"
      >
        <img v-if="conv.avatar" :src="conv.avatar" class="h-full w-full object-cover" />
        <span v-else class="text-sm font-medium">{{ initials(conv.name) }}</span>
      </div>
      <!-- 在线标识：群聊不显示；离线标灰半透 -->
      <span
        v-if="online !== null"
        class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--gosslan-list)]"
        :class="online ? 'bg-emerald-500' : 'bg-neutral-400'"
      ></span>
      <!-- 未读小红点：正常显示 -->
      <span
        v-if="conv.unread > 0"
        class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white"
      >
        {{ conv.unread > 99 ? "99+" : conv.unread }}
      </span>
    </div>
    <div class="min-w-0 flex-1 overflow-hidden">
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[13.5px] leading-5" :class="active ? 'font-medium text-[var(--gosslan-list-active-text)]' : 'text-[var(--gosslan-text)]'">
          {{ conv.name }}
        </span>
        <span
          class="shrink-0 whitespace-nowrap text-[11px]"
          :class="active ? 'text-[var(--gosslan-list-active-text)] opacity-90' : 'text-[var(--gosslan-text-2)]'"
        >
          {{ fmtConversationTime(conv.last_ts) }}
        </span>
      </div>
      <div class="mt-0.5 flex items-center justify-between gap-2">
        <span
          class="truncate text-[12px] leading-5"
          :class="active ? 'text-[var(--gosslan-list-active-text)] opacity-90' : 'text-[var(--gosslan-text-2)]'"
        >
          <template v-if="snippet">
            <span v-html="highlightText(snippet, keyword.trim())"></span>
          </template>
          <template v-else>{{ conv.last_msg || "暂无消息" }}</template>
        </span>
      </div>
    </div>
    <!-- 微信式行间细分隔线：从文本列起（头像后缩进），最后一行不显（由容器裁边） -->
    <div class="absolute bottom-0 left-[64px] right-0 h-px bg-[var(--gosslan-divider)]"></div>
    <!-- 删除聊天记录入口：hover 行时浮现 -->
    <button
      v-if="!active"
      class="absolute bottom-1.5 right-1.5 z-10 hidden h-6 w-6 items-center justify-center rounded text-[var(--gosslan-text-2)] transition hover:bg-red-500/10 hover:text-red-500 group-hover/conv:flex"
      title="删除聊天记录"
      @click="emit('ask-delete', conv, $event)"
    >
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
