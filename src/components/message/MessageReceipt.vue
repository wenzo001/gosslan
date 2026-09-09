<script lang="ts">
// 模块级共享展开键：全局同一时间只允许一个「已读成员」弹层展开，
// 点另一条消息的已读头像会自动收起上一条（虚拟列表回收行时也不会残留）。
import { ref as vueRef } from "vue";
const openReadersKey = vueRef<string | number | null>(null);
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useChatStore } from "@/stores/useChatStore";
import { avatarInitial, nameToColor } from "@/utils/color";
import type { SendState } from "@/composables/useMessageDisplay";
import { Check, Circle, Loader2, RefreshCw } from "lucide-vue-next";

const props = defineProps<{
  state: SendState;
  title: string;
  /** 群聊：显示实际已读成员头像；单聊显示单个状态图标。 */
  isGroup?: boolean;
  /** 已读该消息的成员 ID（由父组件按消息时间计算）。 */
  readerIds?: string[];
  /** 消息唯一键：作为全局展开互斥的键。 */
  msgKey?: string | number;
}>();
const emit = defineEmits<{ (e: "retry"): void }>();

const chat = useChatStore();
const readerIds = computed(() => props.readerIds ?? []);
const visibleReaders = computed(() => readerIds.value.slice(0, 3));
const extraReaders = computed(() => readerIds.value.slice(3));

/** 弹层向上还是向下：消息靠近消息区顶部时改为向下弹出，避免被裁剪。 */
const openUp = ref(true);

function toggleReaders(e: MouseEvent) {
  const key = props.msgKey ?? "";
  if (openReadersKey.value === key) {
    openReadersKey.value = null;
    return;
  }
  const btn = e.currentTarget as HTMLElement | null;
  const scroller = btn?.closest(".overflow-y-auto") as HTMLElement | null;
  if (btn && scroller) {
    const br = btn.getBoundingClientRect();
    const cr = scroller.getBoundingClientRect();
    // 弹层最大高 240px + 间距余量；上方放不下且下方更宽敞时向下弹
    openUp.value = br.top - cr.top > 264 || cr.bottom - br.bottom < 264;
  } else {
    openUp.value = true;
  }
  openReadersKey.value = key;
}

function closeReaders() {
  openReadersKey.value = null;
}
onMounted(() => document.addEventListener("click", closeReaders));
onUnmounted(() => document.removeEventListener("click", closeReaders));

function readerName(id: string) {
  return chat.nicknameOf(id);
}
function readerAvatar(id: string): string | null {
  const friend = chat.friends.find((item) => item.device_id === id);
  if (friend?.avatar) return friend.avatar;
  return chat.peers.find((item) => item.device_id === id)?.avatar ?? null;
}
</script>

<template>
  <!-- 群聊：已读成员头像 + 展开完整列表 -->
  <div v-if="isGroup" class="relative shrink-0 pb-1.5">
    <button
      v-if="readerIds.length > 0"
      class="-space-x-1 flex items-center rounded-full p-0.5 transition hover:bg-[var(--gosslan-hover)]"
      :title="`已读 ${readerIds.length} 人`"
      @click.stop="toggleReaders"
    >
      <span
        v-for="id in visibleReaders"
        :key="id"
        class="flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border border-[var(--gosslan-panel)] text-[8px] text-white"
        :style="{ backgroundColor: nameToColor(readerName(id)) }"
      >
        <img v-if="readerAvatar(id)" :src="readerAvatar(id) ?? undefined" class="h-full w-full object-cover" />
        <span v-else>{{ avatarInitial(readerName(id)) }}</span>
      </span>
      <span
        v-if="extraReaders.length > 0"
        class="ml-1 rounded-full bg-[var(--gosslan-hover)] px-1 text-[9px] text-[var(--gosslan-text-2)]"
      >
        +{{ extraReaders.length }}
      </span>
    </button>
    <div
      v-if="openReadersKey === (props.msgKey ?? '') && readerIds.length > 0"
      class="frost absolute right-0 z-20 max-h-60 min-w-36 overflow-y-auto rounded-lg border border-[var(--gosslan-border)] p-1.5 text-xs shadow-lg"
      :class="openUp ? 'bottom-7' : 'top-7'"
      @click.stop
    >
      <div class="px-2 py-1 text-[var(--gosslan-text-2)]">已读成员（{{ readerIds.length }}）</div>
      <div
        v-for="id in readerIds"
        :key="id"
        class="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--gosslan-hover)]"
      >
        <span
          class="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[9px] text-white"
          :style="{ backgroundColor: nameToColor(readerName(id)) }"
        >
          <img v-if="readerAvatar(id)" :src="readerAvatar(id) ?? undefined" class="h-full w-full object-cover" />
          <span v-else>{{ avatarInitial(readerName(id)) }}</span>
        </span>
        <span class="max-w-28 truncate">{{ readerName(id) }}</span>
      </div>
    </div>
  </div>
  <!-- 单聊：回执图标固定在气泡左侧（视觉上贴近对话人头像方向） -->
  <span v-else class="shrink-0 pb-1.5" :title="title">
    <Loader2 v-if="state === 'sending' || state === 'sent'" class="h-3.5 w-3.5 animate-spin text-[var(--gosslan-text-2)]" />
    <button
      v-else-if="state === 'failed'"
      class="flex h-5 w-5 items-center justify-center rounded text-red-500 transition hover:bg-red-500/10"
      title="重新发送"
      @click="emit('retry')"
    >
      <RefreshCw class="h-3.5 w-3.5" />
    </button>
    <Circle v-else-if="state === 'delivered'" class="h-3.5 w-3.5 text-[var(--gosslan-text-2)]" />
    <Check v-else-if="state === 'read'" class="h-4 w-4 text-emerald-500" />
  </span>
</template>
