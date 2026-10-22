<script setup lang="ts">
/**
 * 默认头像选择器：一个表情 + 一个背景色，可手动搭配，也可随机。
 *
 * 表情/调色板网格读 `avatarSeed.ts` 的清单常量（不在模板里手抄第二份）；随机仍从
 * `AVATAR_PAIRS` 取。颜色除了调色板还提供一个原生取色器的自定义色；emoji 仍不允许
 * 自由文本输入（用户 2026-10-22 的原话是「不要太开放」，自定义色是后来明确追加的）。
 *
 * 预览用 HTML 的 emoji 字体渲染（与 SelfAvatar 同一种画法）；确认后落库的是一张
 * SVG data URL，仍走 `avatar` 原有图片通道，见 `utils/avatarSeed.ts`。
 */
import { computed, ref, watch } from "vue";
import { Palette, Shuffle } from "lucide-vue-next";
import { Check } from "@/components/ui/icons";
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
const customColorInput = ref<HTMLInputElement | null>(null);
/** 当前颜色不在调色板里（用户用取色器选的）⇒ 自定义那颗显示当前色。 */
const customSelected = computed(() => !AVATAR_BACKGROUNDS.includes(bg.value));

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

function onCustomColor(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  if (/^#[0-9a-f]{6}$/i.test(value)) bg.value = value.toLowerCase();
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="t('settings.profile.avatar.title')"
    width="max-w-md"
    @close="emit('close')"
  >
    <!-- 预览固定：放在 BaseModal 的 header 插槽里，不跟下面的选项一起滚。 -->
    <template #header>
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
    </template>

    <div data-avatar-options class="pb-2">
      <p class="mb-1.5 text-xs font-medium text-[var(--gosslan-text-2)]">
        {{ t("settings.profile.avatar.emoji") }}
      </p>
      <!-- 居中换行：最后一行不满时居中，而不是全部往左挤。
           选中环画在按钮内部，不再画到按钮盒外 —— 第一/最后一列贴着滚动区边缘时不会被裁。 -->
      <div class="flex flex-wrap justify-center gap-1.5">
        <button
          v-for="e in AVATAR_EMOJIS"
          :key="e"
          type="button"
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] transition hover:bg-[var(--gosslan-hover)]"
          :class="e === emoji ? 'bg-[var(--gosslan-hover)] ring-2 ring-inset ring-[var(--gosslan-primary)]' : ''"
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
      <div class="flex flex-wrap justify-center gap-1.5">
        <button
          v-for="c in AVATAR_BACKGROUNDS"
          :key="c"
          type="button"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition"
          :class="c === bg ? 'ring-2 ring-inset ring-white' : ''"
          :style="{ backgroundColor: c }"
          :aria-pressed="c === bg"
          :aria-label="t('settings.profile.avatar.pickColor', { color: c })"
          :data-avatar-bg="c"
          :title="c"
          @click="bg = c"
        >
          <Check
            v-if="c === bg"
            class="h-4 w-4 text-white drop-shadow"
            :stroke-width="3"
            aria-hidden="true"
          />
        </button>
        <!-- 自定义色：原生 input 直接覆盖在色块上（用户点到的就是 input 本身）。
             旧写法把 input 藏成 sr-only 再程序化 .click()，macOS WKWebView 下不弹系统取色器。 -->
        <div class="relative h-9 w-9 shrink-0">
          <button
            type="button"
            data-avatar-custom-color
            tabindex="-1"
            aria-hidden="true"
            class="flex h-9 w-9 items-center justify-center rounded-full transition"
            :class="customSelected ? 'ring-2 ring-inset ring-white' : ''"
            :style="customSelected
              ? { backgroundColor: bg }
              : { background: 'conic-gradient(from 0deg, #cd5951, #cda751, #51cd85, #51cdc8, #4284b3, #a269d3, #cd518f, #cd5951)' }"
            :aria-pressed="customSelected"
            :aria-label="t('settings.profile.avatar.customColor')"
            :title="t('settings.profile.avatar.customColor')"
          >
            <Check
              v-if="customSelected"
              class="h-4 w-4 text-white drop-shadow"
              :stroke-width="3"
              aria-hidden="true"
            />
            <Palette v-else class="h-4 w-4 text-white drop-shadow" :stroke-width="2" aria-hidden="true" />
          </button>
          <input
            ref="customColorInput"
            type="color"
            class="absolute inset-0 h-full w-full cursor-pointer rounded-full opacity-0"
            :value="bg"
            :aria-label="t('settings.profile.avatar.customColor')"
            :title="t('settings.profile.avatar.customColor')"
            @input="onCustomColor"
          />
        </div>
      </div>
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
