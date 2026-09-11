<script setup lang="ts">
import { ArrowLeft, FolderOpen, Pencil, Users } from "lucide-vue-next";
import type { Conversation } from "@/types";
import { t } from "@/i18n";

defineProps<{
  conv: Conversation | null;
  isGroup: boolean;
  online: boolean;
  memberCount: number;
  /** 仅群主可改名。 */
  canRename: boolean;
  /** 移动端：显示返回列表的箭头。 */
  showBack?: boolean;
}>();
const emit = defineEmits<{
  (e: "back"): void;
  (e: "open-members"): void;
  (e: "rename"): void;
  (e: "open-share"): void;
}>();
</script>

<template>
  <!-- 微信 4.0 头部：~56px 浅灰底，与消息区无缝衔接，无分割线；右侧 通话 / 更多 / 共享 -->
  <div
    class="flex shrink-0 items-center justify-between border-b border-[var(--gosslan-divider)] bg-[var(--gosslan-chat)] px-4"
    :style="{ height: 'var(--gosslan-header-h)' }"
  >
    <div class="flex min-w-0 items-center gap-1.5">
      <button
        v-if="showBack"
        class="tap-safe -ml-2 mr-1 flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('chat.header.back')" :aria-label="t('chat.header.back')"
        @click="emit('back')"
      >
        <ArrowLeft class="h-5 w-5" />
      </button>
      <span class="truncate text-[15px] font-medium leading-6">{{ conv?.name || t("chat.header.conversation") }}<template v-if="isGroup && memberCount > 0"> ({{ memberCount }})</template></span>
    </div>
    <div class="flex shrink-0 items-center gap-0.5">
      <!-- 只保留有真实功能的入口；不放没有实现的功能按钮（音视频通话/更多已移除） -->
      <button
        v-if="isGroup"
        class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('chat.header.members')" :aria-label="t('chat.header.members')"
        @click="emit('open-members')"
      >
        <Users class="h-[18px] w-[18px]" />
      </button>
      <button
        v-if="isGroup && canRename"
        class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('chat.header.rename')" :aria-label="t('chat.header.rename')"
        @click="emit('rename')"
      >
        <Pencil class="h-[17px] w-[17px]" />
      </button>
      <button
        v-if="!isGroup"
        class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('chat.header.share')" :aria-label="t('chat.header.share')"
        @click="emit('open-share')"
      >
        <FolderOpen class="h-[18px] w-[18px]" />
      </button>
    </div>
  </div>
</template>
