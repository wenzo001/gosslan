<script setup lang="ts">
/**
 * 默认头像选择器：一个表情 + 一个背景色，可手动搭配，也可随机。
 *
 * 选项集**全部从 `AVATAR_PAIRS` 派生**（`AVATAR_EMOJIS` / `AVATAR_BACKGROUNDS`），
 * 与 `avatarSeedFor` 的随机脸是同一批数据 —— 用户不会在这里看到"系统随机永远不会抽到"
 * 的选项，也不会被允许自由输入任意 emoji / 颜色（用户 2026-10-22：「不要太开放」）。
 *
 * 预览用 HTML 的 emoji 字体渲染（与 SelfAvatar 同一种画法）；确认后落库的是一张
 * SVG data URL，仍走 `avatar` 原有图片通道，见 `utils/avatarSeed.ts`。
 */
import { computed, ref, watch } from "vue";
import { Shuffle } from "lucide-vue-next";
import BaseModal from "@/components/BaseModal.vue";
import { t } from "@/i18n";
import {
  AVATAR_BACKGROUNDS,
  AVATAR_EMOJIS,
  randomAvatarPair,
  type AvatarSeed,
} from "@/utils/avatarSeed";

const props = defineProps<{
  open: boolean;
  /** 打开时的初始组合：当前预设原样还原，否则是这台设备的系统默认脸。 */
  initial: AvatarSeed;
  saving?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "apply", seed: AvatarSeed): void;
}>();

const emoji = ref(props.initial.emoji);
const bg = ref(props.initial.bg);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    // 每次都从"当前头像"重新起算：上次关掉没确认的选择不该残留到下一次。
    emoji.value = props.initial.emoji;
    bg.value = props.initial.bg;
  },
  { immediate: true },
);

const selection = computed<AvatarSeed>(() => ({ emoji: emoji.value, bg: bg.value }));

function randomize() {
  const next = randomAvatarPair(selection.value);
  emoji.value = next.emoji;
  bg.value = next.bg;
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('settings.profile.avatar.title')"
    width="max-w-md"
    @close="emit('close')"
  >
    <div class="flex items-center gap-4 rounded-[var(--gosslan-radius-lg)] bg-[var(--gosslan-bg)] p-3">
      <div
        class="gosslan-avatar-box flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white transition-colors duration-200"
        :style="{ backgroundColor: bg }"
        aria-hidden="true"
      >
        <span class="gosslan-avatar-emoji" aria-hidden="true">{{ emoji }}</span>
      </div>
      <div class="min-w-0 flex-1">
        <p class="text-meta leading-snug text-[var(--gosslan-text-2)]">
          {{ t("settings.profile.avatar.hint") }}
        </p>
        <button
          type="button"
          data-avatar-random
          class="tap-safe mt-2 inline-flex items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="randomize"
        >
          <Shuffle class="h-3.5 w-3.5" :stroke-width="2" />
          {{ t("settings.profile.avatar.random") }}
        </button>
      </div>
    </div>

    <p class="mb-1.5 mt-4 text-xs font-medium text-[var(--gosslan-text-2)]">
      {{ t("settings.profile.avatar.emoji") }}
    </p>
    <div class="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
      <button
        v-for="e in AVATAR_EMOJIS"
        :key="e"
        type="button"
        class="flex aspect-square w-full items-center justify-center rounded-[var(--gosslan-radius-md)] transition hover:bg-[var(--gosslan-hover)]"
        :class="e === emoji ? 'bg-[var(--gosslan-hover)] ring-2 ring-[var(--gosslan-primary)]' : ''"
        :aria-pressed="e === emoji"
        :aria-label="t('settings.profile.avatar.pickEmoji', { emoji: e })"
        :data-avatar-emoji="e"
        @click="emoji = e"
      >
        <span class="text-2xl leading-none" aria-hidden="true">{{ e }}</span>
      </button>
    </div>

    <p class="mb-1.5 mt-4 text-xs font-medium text-[var(--gosslan-text-2)]">
      {{ t("settings.profile.avatar.color") }}
    </p>
    <div class="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
      <button
        v-for="c in AVATAR_BACKGROUNDS"
        :key="c"
        type="button"
        class="aspect-square w-full rounded-full transition"
        :class="c === bg ? 'ring-2 ring-[var(--gosslan-text)] ring-offset-2 ring-offset-[var(--gosslan-panel)]' : ''"
        :style="{ backgroundColor: c }"
        :aria-pressed="c === bg"
        :aria-label="t('settings.profile.avatar.pickColor', { color: c })"
        :data-avatar-bg="c"
        :title="c"
        @click="bg = c"
      />
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-sm transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('close')"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          type="button"
          data-avatar-apply
          class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary)] px-3 py-1.5 text-sm text-white transition hover:opacity-90 disabled:opacity-40"
          :disabled="saving"
          @click="emit('apply', selection)"
        >
          {{ t("settings.profile.avatar.apply") }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>
