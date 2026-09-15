<script setup lang="ts">
/**
 * 气泡下方的表情回应条（飞书/微信同款位置）。
 *
 * 为什么单独成条而不是把回应做成"一条消息"：回应是**状态**不是内容 —— 它挂在被回应的
 * 那条下面，且同一个人反复点只应看到最终结果。协议层它确实是一条条独立事件消息
 * （见 utils/reactions.ts 的说明），但**渲染层必须折叠**，否则群里回三个赞就多三条消息。
 */
import { t } from "@/i18n";
import { emojiUrl } from "@/utils/emoji";
import type { ReactionChip } from "@/utils/reactions";

defineProps<{
  chips: ReactionChip[];
  /** 是否允许我添加/取消（单聊暂不开放，且自己的消息也允许自嘲式回应） */
  interactive: boolean;
  /** 快捷表情：与 EmojiPicker 同一套目录，取前几个高频的 */
  quick: string[];
}>();
const emit = defineEmits<{
  (e: "toggle", emoji: string): void;
}>();
</script>

<template>
  <!-- 没有任何回应且不可交互时整条不渲染，避免给每条消息都留一行空白 -->
  <div v-if="chips.length > 0 || interactive" class="mt-1 flex flex-wrap items-center gap-1">
    <button
      v-for="c in chips"
      :key="c.emoji"
      class="tap-safe flex h-6 items-center gap-1 rounded-full border px-1.5 text-[11px] transition"
      :class="c.mine
        ? 'border-[var(--gosslan-primary)] bg-[var(--gosslan-primary-light)] text-[var(--gosslan-primary)]'
        : 'border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
      :title="t('msg.reactionWho', { n: c.count })"
      :aria-label="t('msg.reactionToggle', { emoji: c.emoji })"
      :disabled="!interactive"
      @click="emit('toggle', c.emoji)"
    >
      <img v-if="emojiUrl(c.emoji)" :src="emojiUrl(c.emoji) ?? undefined" alt="" class="h-3.5 w-3.5" />
      <span v-else class="text-[11px]">{{ c.emoji }}</span>
      <span class="tabular-nums">{{ c.count }}</span>
    </button>

    <!-- 快捷回应：桌面悬停/触屏常显的一排高频表情（`hover-reveal` 提供触屏兜底） -->
    <template v-if="interactive">
      <button
        v-for="e in quick"
        :key="`q-${e}`"
        class="hover-reveal tap-safe hidden h-6 w-6 items-center justify-center rounded-full border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] transition hover:bg-[var(--gosslan-hover)] group-hover/msg:flex"
        :title="t('msg.reactionAdd', { emoji: e })"
        :aria-label="t('msg.reactionAdd', { emoji: e })"
        @click="emit('toggle', e)"
      >
        <img v-if="emojiUrl(e)" :src="emojiUrl(e) ?? undefined" alt="" class="h-3.5 w-3.5" />
        <span v-else class="text-[11px]">{{ e }}</span>
      </button>
    </template>
  </div>
</template>
