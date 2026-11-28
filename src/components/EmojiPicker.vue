<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuTrigger,
} from "reka-ui";
import OverlayScroll from "@/components/ui/OverlayScroll.vue";
import { safeStorageBackend } from "../utils/safeStorage.ts";
import { EMOJIS, type EmojiDef } from "@/utils/emoji";
import {
  readEmojiUsage,
  pickerCells,
  withEmojiUse,
  writeEmojiUsage,
  type EmojiUsage,
} from "@/utils/emojiUsage";
import { dropStickerPreview, loadStickerPreview } from "@/utils/filePreview";
import { t } from "@/i18n";
import { api } from "@/api";
import type { StickerEntry } from "@/types";

const props = withDefaults(
  defineProps<{ open: boolean; mode?: "compose" | "react" }>(),
  { mode: "compose" },
);
const emit = defineEmits<{
  (e: "select", displayName: string): void;
  (e: "send-sticker", stickerId: string): void;
  (e: "close"): void;
}>();

const COLS = 8;
const panelRef = ref<HTMLDivElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;
const activeTab = ref<"all" | "custom">("all");
const storage = safeStorageBackend;
const usage = ref<EmojiUsage>(readEmojiUsage(storage));
const grid = computed(() => pickerCells(EMOJIS, usage.value));
const cells = computed(() => grid.value.items);
const stickers = ref<StickerEntry[]>([]);
const visibleCount = ref(48);
const visibleStickers = computed(() => stickers.value.slice(0, visibleCount.value));
const stickersLoading = ref(false);
const stickersError = ref("");
const stickerPreviewError = ref("");
const importing = ref(false);
const stickerUrls = ref<Record<string, string>>({});
const menuOpen = ref<Record<string, boolean>>({});
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
let loadGeneration = 0;
let disposed = false;

function isFrequent(i: number): boolean {
  return i < grid.value.frequentCount;
}
function cellKey(e: EmojiDef, i: number): string {
  return `${isFrequent(i) ? "f" : "m"}:${e.file}`;
}
function labelOf(e: EmojiDef, i: number): string {
  return isFrequent(i) ? `${t("emoji.frequent")} · ${e.displayName}` : e.displayName;
}
function pick(e: EmojiDef) {
  usage.value = withEmojiUse(usage.value, e.displayName, Date.now());
  writeEmojiUsage(storage, usage.value);
  emit("select", e.displayName);
}

async function refreshStickerUrls() {
  const generation = loadGeneration;
  if (disposed) return;
  stickerPreviewError.value = "";
  const keep = new Set(stickers.value.map((s) => s.id));
  for (const id of Object.keys(stickerUrls.value)) {
    if (!keep.has(id)) {
      dropStickerPreview(id);
      delete stickerUrls.value[id];
    }
  }
  await Promise.all(
    visibleStickers.value.map(async (sticker) => {
      if (stickerUrls.value[sticker.id]) return;
      try {
        const preview = await loadStickerPreview(sticker.id, true, "image/png");
        if (!preview.url) {
          if (generation === loadGeneration && !disposed) {
            stickerPreviewError.value = t("sticker.previewFail");
          }
          return;
        }
        if (generation === loadGeneration && keep.has(sticker.id)) {
          stickerUrls.value[sticker.id] = preview.url;
        } else if (disposed || !stickers.value.some((row) => row.id === sticker.id)) {
          dropStickerPreview(sticker.id);
        }
      } catch {
        if (generation === loadGeneration && !disposed) {
          stickerPreviewError.value = t("sticker.previewFail");
        }
      }
    }),
  );
}

async function loadStickers() {
  const generation = ++loadGeneration;
  stickersLoading.value = true;
  stickersError.value = "";
  try {
    const rows = await api.listCustomStickers();
    if (generation !== loadGeneration) return;
    stickers.value = rows;
    visibleCount.value = 48;
  } catch (e) {
    if (generation === loadGeneration) stickersError.value = String(e);
  } finally {
    if (generation === loadGeneration) stickersLoading.value = false;
  }
  if (generation === loadGeneration && activeTab.value === "custom") void refreshStickerUrls();
}

watch(activeTab, (tab) => {
  if (tab === "custom") void refreshStickerUrls();
});

function pickSticker(sticker: StickerEntry) {
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  emit("send-sticker", sticker.id);
}

async function importSticker() {
  if (importing.value) return;
  importing.value = true;
  stickersError.value = "";
  try {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: t("sticker.importFilter"), extensions: ["png", "gif", "webp"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    await api.importSticker(path);
    await loadStickers();
  } catch (e) {
    stickersError.value = String(e);
  } finally {
    importing.value = false;
  }
}

function startLongPress(event: PointerEvent, sticker: StickerEntry) {
  if (event.pointerType !== "touch") return;
  longPressFired = false;
  pressTimer = setTimeout(() => {
    longPressFired = true;
    menuOpen.value[sticker.id] = true;
  }, 550);
}
function clearLongPress() {
  if (pressTimer !== null) clearTimeout(pressTimer);
  pressTimer = null;
}
async function moveStickerToFront(id: string) {
  menuOpen.value[id] = false;
  try {
    await api.moveCustomStickerToFront(id);
    await loadStickers();
  } catch (e) {
    stickersError.value = String(e);
  }
}
async function deleteSticker(id: string) {
  menuOpen.value[id] = false;
  try {
    await api.deleteCustomSticker(id);
    dropStickerPreview(id);
    delete stickerUrls.value[id];
    await loadStickers();
  } catch (e) {
    stickersError.value = String(e);
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(panelRef.value?.querySelectorAll<HTMLButtonElement>("button[data-emoji-cell]") ?? []);
}
function focusAt(list: HTMLButtonElement[], idx: number) {
  const at = Math.max(0, Math.min(list.length - 1, idx));
  list[at]?.focus();
  list[at]?.scrollIntoView({ block: "nearest" });
}
function onKey(e: KeyboardEvent) {
  const active = document.activeElement as HTMLElement | null;
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (active?.hasAttribute("data-emoji-tab")) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      activeTab.value = activeTab.value === "all" ? "custom" : "all";
      void nextTick(() => {
        const tabs = panelRef.value?.querySelectorAll<HTMLButtonElement>("[data-emoji-tab]");
        tabs?.[activeTab.value === "all" ? 0 : 1]?.focus();
      });
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      void nextTick(() => focusAt(buttons(), 0));
      return;
    }
  }
  const list = buttons();
  if (!list.length) return;
  const cur = list.indexOf(document.activeElement as HTMLButtonElement);
  if (cur < 0) return;
  const step = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS } as Record<string, number>)[e.key];
  if (step === undefined) return;
  e.preventDefault();
  focusAt(list, cur + step);
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreFocusTo = document.activeElement as HTMLElement | null;
      activeTab.value = "all";
      if (props.mode === "compose") void loadStickers();
      await nextTick();
      focusAt(buttons(), 0);
    } else if (restoreFocusTo) {
      restoreFocusTo.focus?.();
      restoreFocusTo = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  clearLongPress();
  disposed = true;
  loadGeneration += 1;
  for (const id of Object.keys(stickerUrls.value)) dropStickerPreview(id);
  stickerUrls.value = {};
});
</script>

<template>
  <div
    v-if="open"
    ref="panelRef"
    data-emoji-panel
    class="gosslan-pop-clamp gosslan-emoji-panel frost w-[min(360px,calc(100vw-2rem))] select-none rounded-[var(--gosslan-radius-lg)] border border-[var(--gosslan-border)] shadow-[var(--gosslan-glass-2-shadow)]"
    role="dialog"
    :aria-label="t('chat.composer.emoji')"
    tabindex="-1"
    @click.stop
    @keydown="onKey"
  >
    <div v-if="mode === 'compose'" class="flex items-center gap-1 border-b border-[var(--gosslan-divider)] px-2 pt-2" role="tablist">
      <button
        data-emoji-tab
        class="tap-safe rounded-[var(--gosslan-radius-sm)] px-3 py-2 text-caption transition"
        :class="activeTab === 'all' ? 'bg-[var(--gosslan-hover)] text-[var(--gosslan-text)]' : 'text-[var(--gosslan-text-2)]'"
        role="tab"
        :aria-selected="activeTab === 'all'"
        @click="activeTab = 'all'"
      >
        {{ t("emoji.all") }}
      </button>
      <button
        data-emoji-tab
        class="tap-safe rounded-[var(--gosslan-radius-sm)] px-3 py-2 text-caption transition"
        :class="activeTab === 'custom' ? 'bg-[var(--gosslan-hover)] text-[var(--gosslan-text)]' : 'text-[var(--gosslan-text-2)]'"
        role="tab"
        :aria-selected="activeTab === 'custom'"
        @click="activeTab = 'custom'"
      >
        {{ t("sticker.title") }}
      </button>
    </div>

    <OverlayScroll
      size="thin"
      class="my-2 pr-[var(--gosslan-os-lane)]"
      :style="{ height: 'min(300px, calc(100dvh - var(--gosslan-pop-edge) * 2 - 18px))' }"
    >
      <div v-if="activeTab === 'all'" class="grid grid-cols-8 content-start gap-2.5 p-2">
        <div
          v-if="grid.frequentCount"
          class="col-span-8 border-b border-[var(--gosslan-divider)] pb-1 text-caption leading-none text-[var(--gosslan-text-2)]"
        >
          {{ t("emoji.frequent") }}
        </div>
        <template v-for="(e, i) in cells" :key="cellKey(e, i)">
          <div
            v-if="i === grid.frequentCount"
            data-emoji-all-title
            class="col-span-8 text-caption leading-none text-[var(--gosslan-text-2)]"
          >
            {{ t("emoji.all") }}
          </div>
          <button
            data-emoji-cell
            class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-xs)] transition hover:bg-[var(--gosslan-hover)]"
            :class="isFrequent(i) ? 'bg-[var(--gosslan-primary-light)]' : ''"
            :data-emoji-freq="isFrequent(i) ? '1' : undefined"
            :title="labelOf(e, i)"
            :aria-label="labelOf(e, i)"
            @click="pick(e)"
          >
            <img :src="e.url" :alt="e.name" loading="lazy" decoding="async" class="h-full w-full object-contain" draggable="false" />
          </button>
        </template>
      </div>

      <div v-else class="p-2">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="text-caption text-[var(--gosslan-text-2)]">{{ t("sticker.orderHint") }}</span>
          <button class="tap-safe rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-3 py-1.5 text-caption text-[var(--gosslan-text)]" :disabled="importing" @click="importSticker">
            {{ importing ? t("sticker.importing") : t("sticker.import") }}
          </button>
        </div>
        <div v-if="stickerPreviewError" class="mb-2 flex items-center justify-between gap-2 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-3 py-2 text-caption text-[var(--gosslan-danger)]">
          <span>{{ stickerPreviewError }}</span>
          <button class="tap-safe shrink-0 rounded-[var(--gosslan-radius-xs)] px-2 py-1 text-[var(--gosslan-text)]" @click="refreshStickerUrls">{{ t("common.retry") }}</button>
        </div>
        <div v-if="stickersLoading" class="py-8 text-center text-caption text-[var(--gosslan-text-2)]">{{ t("common.loading") }}</div>
        <div v-else-if="stickersError" class="py-6 text-center text-caption text-[var(--gosslan-danger)]">{{ stickersError }}</div>
        <div v-else-if="!stickers.length" class="py-8 text-center text-caption text-[var(--gosslan-text-2)]">{{ t("sticker.empty") }}</div>
        <template v-else>
          <div class="grid grid-cols-8 content-start gap-2.5">
            <ContextMenuRoot
              v-for="sticker in visibleStickers"
              :key="sticker.id"
              v-model:open="menuOpen[sticker.id]"
            >
              <ContextMenuTrigger as-child>
                <button
                  data-emoji-cell
                  class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-xs)] transition hover:bg-[var(--gosslan-hover)]"
                  :title="sticker.name"
                  :aria-label="sticker.name"
                  @click="pickSticker(sticker)"
                  @pointerdown="startLongPress($event, sticker)"
                  @pointerup="clearLongPress"
                  @pointercancel="clearLongPress"
                  @pointerleave="clearLongPress"
                >
                  <img v-if="stickerUrls[sticker.id]" :src="stickerUrls[sticker.id]" alt="" loading="lazy" decoding="async" class="h-full w-full object-contain" draggable="false" />
                  <span v-else class="gosslan-skeleton-in h-full w-full rounded-[var(--gosslan-radius-xs)]" />
                </button>
              </ContextMenuTrigger>
              <ContextMenuPortal>
                <ContextMenuContent class="gosslan-pop-clamp frost z-[80] min-w-40 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-1 shadow-[var(--gosslan-glass-2-shadow)]">
                  <ContextMenuItem class="rounded-[var(--gosslan-radius-sm)] px-3 py-2 text-caption text-[var(--gosslan-text)] data-[highlighted]:bg-[var(--gosslan-hover)]" @select="moveStickerToFront(sticker.id)">
                    {{ t("sticker.moveFront") }}
                  </ContextMenuItem>
                  <ContextMenuItem class="rounded-[var(--gosslan-radius-sm)] px-3 py-2 text-caption text-[var(--gosslan-danger)] data-[highlighted]:bg-[var(--gosslan-hover)]" @select="deleteSticker(sticker.id)">
                    {{ t("sticker.delete") }}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenuPortal>
            </ContextMenuRoot>
          </div>
          <button
            v-if="visibleCount < stickers.length"
            class="tap-safe mt-2 w-full rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-hover)] px-3 py-2 text-caption text-[var(--gosslan-text)]"
            @click="visibleCount += 48; refreshStickerUrls()"
          >
            {{ t("sticker.loadMore") }}
          </button>
        </template>
      </div>
    </OverlayScroll>
  </div>
</template>
