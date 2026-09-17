<script setup lang="ts">
/**
 * 收藏面板（微信式）。
 *
 * ## 定位
 * 「收藏」是**独立存储**，不是消息的派生状态：原消息删了、会话删了、缓存清了，收藏里的
 * 内容都还在（后端在收藏时把媒体**复制**进 `app_data/favorites/media`，见 `add_favorite`）。
 * 所以本面板的数据源是 `chat.favorites`（后端 `favorites` 表），与消息列表无关。
 *
 * ## 为什么不用 `useMessageFile`
 * 那条链路按 `msg_id` 反查 messages 表里的 path（`read_file_preview` / `media_present`
 * 都以 msg_id 为入口）—— 原消息没了就什么都读不到，而收藏恰恰要在那个前提下仍然可用。
 * 所以这里：图片预览走 `utils/favoritePreview`（按**收藏 id** 读副本），
 * 打开/另存走 `utils/localFile` 的**路径**入参。
 *
 * ## 浮层规则（踩过坑）
 * `BaseModal` 是 HeadlessUI `Dialog`，**两个 Dialog 不能同时展开**：后开的那个会让前一个
 * 收到 outside-click ⇒ 前一个自己关掉。所以：
 *   · 行菜单（`ContextMenu`）与图片查看（普通全屏 `<button>`）都不是 Dialog，可以压在上面；
 *   · 「转发」要开 `ForwardModal`（另一个 Dialog）⇒ 先收面板再开它（`startForward`）。
 *     ⚠️ 而且它**必须写在 `BaseModal` 的同级**，不能放进它的 slot：面板一关，
 *     `TransitionRoot :show` 转 false，插槽内容会被一起卸载 —— 转发框刚开就被销毁。
 */
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import ContextMenu from "@/components/ContextMenu.vue";
import ForwardModal from "@/components/message/ForwardModal.vue";
import { useClipboard } from "@/composables/useClipboard";
import { fmtConversationTime } from "@/utils/time";
import { humanSize, rgba } from "@/utils/color";
import { FILE_KIND_COLORS, FILE_KIND_ICONS, fileExt, fileKindOf } from "@/utils/fileKind";
import { openLocalFile } from "@/utils/localFile";
import { dropFavoritePreview, loadFavoritePreview } from "@/utils/favoritePreview";
import {
  AlignLeft,
  Code,
  Copy,
  CornerUpLeft,
  Loader2,
  MoreHorizontal,
  Share2,
  Trash2,
  X,
} from "lucide-vue-next";
import type { FavoriteEntry, FileMeta, MsgKind } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();
const { copyContent } = useClipboard();

const loading = ref(false);
const failed = ref(false);
/** 图片缩略图：收藏 id → objectURL（按需加载；删除/卸载时释放，见 favoritePreview）。 */
const thumbs = ref<Record<string, string>>({});
/** 行菜单（桌面右键 / 移动「⋯」共用一个） */
const menu = ref<{ x: number; y: number; item: FavoriteEntry } | null>(null);
/** 全屏看图中的 objectURL */
const viewer = ref<string | null>(null);
/** 待删除（内联二次确认） */
const pendingDelete = ref<FavoriteEntry | null>(null);
/** 转发目标（null = 未开转发弹窗） */
const forward = ref<FavoriteEntry | null>(null);

const items = computed(() => chat.favorites);

async function load() {
  loading.value = true;
  failed.value = false;
  try {
    await chat.refreshFavorites();
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

// 每次打开都重拉：面板不在时用户可能在别处收藏过（消息右键菜单），缓存旧快照会少条目。
// 同时清掉上一次的确认/菜单态 —— 下次打开应该是一张干净的面板。
watch(
  () => props.open,
  (v) => {
    pendingDelete.value = null;
    menu.value = null;
    viewer.value = null;
    if (v) void load();
  },
);

/** 收藏里的 content 快照（图片/文件是 `{name,path,size,subtype}` 这段 JSON）。 */
function metaOf(f: FavoriteEntry): FileMeta | null {
  if (f.kind !== "image" && f.kind !== "file") return null;
  try {
    const m = JSON.parse(f.content) as Partial<FileMeta>;
    return {
      name: m.name ?? t("common.file"),
      path: m.path ?? f.media_path ?? "",
      size: m.size ?? f.media_size,
      subtype: m.subtype ?? (f.kind === "image" ? "image" : "file"),
    };
  } catch {
    return null;
  }
}

function displayName(f: FavoriteEntry): string {
  return metaOf(f)?.name ?? t("common.file");
}

function sizeText(f: FavoriteEntry): string {
  const size = metaOf(f)?.size ?? f.media_size;
  return size > 0 ? humanSize(size) : "";
}

function extLabel(f: FavoriteEntry): string {
  const e = fileExt(displayName(f));
  return e ? e.toUpperCase().slice(0, 4) : t("common.file");
}

/** 图片缩略图按需加载：只对"副本还在这台机器上"的图片收藏读字节。 */
watch(
  [items, thumbs],
  ([list]) => {
    if (!props.open) return;
    for (const f of list) {
      if (f.kind !== "image" || !f.available || thumbs.value[f.id]) continue;
      void loadFavoritePreview(f.id, displayName(f)).then((r) => {
        if (r.url) thumbs.value = { ...thumbs.value, [f.id]: r.url };
      });
    }
  },
  { immediate: true },
);

/** 行左侧的类型图标与配色：文件/图片沿用气泡那套 `utils/fileKind`，保证同一种文件长得一样。 */
function kindIcon(f: FavoriteEntry) {
  if (f.kind === "image" || f.kind === "file") {
    return FILE_KIND_ICONS[fileKindOf(displayName(f))];
  }
  return f.kind === "code" ? Code : AlignLeft;
}

function kindStyle(f: FavoriteEntry) {
  if (f.kind === "image" || f.kind === "file") {
    const c = FILE_KIND_COLORS[fileKindOf(displayName(f))];
    const accent = app.dark ? c.dark : c.light;
    return { backgroundColor: rgba(accent, 0.12), color: accent };
  }
  const accent = app.dark ? "#a1a1aa" : "#71717a";
  return { backgroundColor: rgba(accent, 0.12), color: accent };
}

/** 发送者昵称：优先好友/节点表，查不到退回 device_id（与消息里的口径一致）。 */
function senderName(f: FavoriteEntry): string {
  return chat.nicknameOf(f.sender_id);
}

function favoritable(f: FavoriteEntry): boolean {
  return f.kind === "text" || f.kind === "code" || f.kind === "image" || f.kind === "file";
}

function openMenuAt(e: MouseEvent, f: FavoriteEntry) {
  // 右键：菜单落在**鼠标处**（这是右键菜单的基本预期）。
  if (e.type === "contextmenu") {
    menu.value = { x: e.clientX, y: e.clientY, item: f };
    return;
  }
  // 移动端「⋯」按钮走这里：触屏 click 的 clientX/Y 往往是 0，只能按按钮自身的位置算，
  // 否则菜单会飘到屏幕左上角去。
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  menu.value = rect
    ? { x: rect.right - 176, y: rect.bottom + 4, item: f }
    : { x: e.clientX, y: e.clientY, item: f };
}

function onRowClick(f: FavoriteEntry) {
  // 与微信一致：点一下拿走内容 —— 文本/代码复制、图片看图、文件打开。
  if (f.kind === "text" || f.kind === "code") void copyItem(f);
  else if (f.kind === "image") void previewImage(f);
  else void openItem(f);
}

async function copyItem(f: FavoriteEntry) {
  menu.value = null;
  try {
    if (f.kind === "text" || f.kind === "code") {
      const ok = await copyContent("favorite", f.content);
      app.toast(t(ok ? "common.copied" : "favorite.copyFail"), ok ? "success" : "error");
      return;
    }
    // 图片/文件：复制**文件本体**（Windows 上写 CF_HDROP，可直接粘到资源管理器/输入框）
    if (!f.media_path || !f.available) {
      app.toast(t("favorite.mediaGone"), "error");
      return;
    }
    await invoke("copy_file_to_clipboard", { path: f.media_path });
    app.toast(t("common.copied"), "success");
  } catch (e) {
    app.toastError(e, t("favorite.copyFail"));
  }
}

async function previewImage(f: FavoriteEntry) {
  if (!f.available) {
    app.toast(t("favorite.mediaGone"), "error");
    return;
  }
  const url = thumbs.value[f.id] ?? (await loadFavoritePreview(f.id, displayName(f))).url;
  if (!url) {
    app.toast(t("favorite.mediaGone"), "error");
    return;
  }
  viewer.value = url;
}

async function openItem(f: FavoriteEntry) {
  const meta = metaOf(f);
  if (!f.media_path || !meta || !f.available) {
    app.toast(t("favorite.mediaGone"), "error");
    return;
  }
  // 平台差异（Android 改走另存为）统一在 utils/localFile，与消息气泡、群文件面板同一条路径。
  try {
    await openLocalFile(f.media_path, meta.name);
  } catch (e) {
    app.toastError(e, t("favorite.openFail"));
  }
}

const forwardKind = computed<MsgKind>(() => forward.value?.kind ?? "text");
const forwardSnippet = computed(() => {
  const f = forward.value;
  if (!f) return "";
  if (f.kind === "text" || f.kind === "code") {
    const one = f.content.replace(/\s+/g, " ").trim();
    return one.length > 40 ? `${one.slice(0, 40)}…` : one;
  }
  return displayName(f);
});

function startForward(f: FavoriteEntry) {
  menu.value = null;
  forward.value = f;
  // 先收面板再开转发弹窗：两个 Dialog 不能同时展开（见文件头说明）。
  emit("close");
}

/** 转发：把收藏内容发到目标会话。文本/代码/图片与非收藏消息同一条路；
 *  文件按**副本路径**重走传输链路（内容 JSON 只是元信息，直接发过去对方拿不到字节）。 */
async function doForward(convId: string) {
  const f = forward.value;
  forward.value = null;
  if (!f) return;
  try {
    if (f.kind === "file") {
      if (!f.media_path) {
        app.toast(t("favorite.mediaGone"), "error");
        return;
      }
      if (convId.startsWith("group:")) await chat.sendGroupFileTo(convId.slice(6), f.media_path);
      else await chat.sendFileTo(convId, f.media_path);
    } else {
      await chat.send(convId, f.content, f.kind);
    }
    app.toast(t("chat.toast.forwarded"), "success");
  } catch (e) {
    app.toastError(e, t("chat.toast.forwardFail"));
  }
}

async function locate(f: FavoriteEntry) {
  menu.value = null;
  // ⚠️ 必须先判会话还在不在：`locateMessageInConv` 内部会 `openConversation` → 会话不在
  // 列表时会走 `ensureConversation` **在库里新建**一条 —— 用户只是点了个「跳回原消息」，
  // 侧栏却凭空多出一个空会话（而且重启后还在）。
  if (!chat.conversations.some((c) => c.id === f.conv_id)) {
    app.toast(t("favorite.msgGone"), "info");
    return;
  }
  const r = await chat.locateMessageInConv(f.conv_id, f.msg_id);
  if (r !== "found") {
    // 会话还在、但那条消息已经翻不到了（消息被删/超出可回溯范围）—— 明说，别静默。
    app.toast(t("favorite.msgGone"), "info");
    return;
  }
  if (app.isMobile) app.mobileView = "chat";
  emit("close");
}

function askDelete(f: FavoriteEntry) {
  menu.value = null;
  pendingDelete.value = f;
}

async function confirmDelete() {
  const f = pendingDelete.value;
  pendingDelete.value = null;
  if (!f) return;
  try {
    await chat.removeFavorite(f.id);
    // 顺手释放预览缓存：objectURL 不 revoke 会一直占着那份字节的内存。
    dropFavoritePreview(f.id);
    const rest = { ...thumbs.value };
    delete rest[f.id];
    thumbs.value = rest;
    app.toast(t("favorite.deleted"), "success");
  } catch (e) {
    app.toastError(e, t("favorite.deleteFail"));
  }
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="items.length ? t('favorite.count', { n: items.length }) : t('favorite.title')"
    width="max-w-lg"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 py-8 text-sm text-[var(--gosslan-text-2)]"
      >
        <Loader2 class="h-4 w-4 animate-spin" />
        {{ t("favorite.loading") }}
      </div>

      <div v-else-if="failed" class="py-8 text-center text-sm text-[var(--gosslan-text-2)]">
        {{ t("favorite.loadFail") }}
      </div>

      <div
        v-else-if="items.length === 0"
        class="py-8 text-center text-sm text-[var(--gosslan-text-2)]"
      >
        {{ t("favorite.empty") }}
      </div>

      <div v-else class="max-h-80 space-y-0.5 overflow-y-auto">
        <div
          v-for="f in items"
          :key="f.id"
          class="flex items-start gap-2.5 rounded-[var(--gosslan-radius-md)] px-2 py-2 transition hover:bg-[var(--gosslan-hover)]"
          role="button"
          tabindex="0"
          :title="t('msg.clickToOpen')"
          @click="onRowClick(f)"
          @keydown.enter.prevent="onRowClick(f)"
          @keydown.space.prevent="onRowClick(f)"
          @contextmenu.prevent="openMenuAt($event, f)"
        >
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)]"
            :style="kindStyle(f)"
          >
            <component :is="kindIcon(f)" class="h-[18px] w-[18px]" />
          </div>

          <div class="min-w-0 flex-1">
            <template v-if="f.kind === 'text' || f.kind === 'code'">
              <div
                class="line-clamp-3 break-words whitespace-pre-wrap text-[13px] text-[var(--gosslan-text)]"
              >
                {{ f.content }}
              </div>
            </template>

            <template v-else-if="f.kind === 'image'">
              <img
                v-if="thumbs[f.id]"
                :src="thumbs[f.id]"
                class="max-h-40 rounded-[var(--gosslan-radius-sm)] object-contain"
                :alt="displayName(f)"
              />
              <div v-else class="truncate text-[13px] text-[var(--gosslan-text)]" :title="displayName(f)">
                {{ displayName(f) }}
              </div>
              <div class="mt-1 truncate text-[11px] text-[var(--gosslan-text-2)]" :title="displayName(f)">
                {{ displayName(f) }}
              </div>
            </template>

            <template v-else>
              <div class="truncate text-[13px] font-medium text-[var(--gosslan-text)]" :title="displayName(f)">
                {{ displayName(f) }}
              </div>
              <div class="mt-0.5 text-[11px] text-[var(--gosslan-text-2)]">
                {{ extLabel(f) }} · {{ sizeText(f) }}
              </div>
            </template>

            <div class="mt-1 flex items-center gap-1 text-[11px] text-[var(--gosslan-text-2)]">
              <span class="truncate" :title="senderName(f)">{{ senderName(f) }}</span>
              <span>·</span>
              <span class="shrink-0">
                {{ t("favorite.from", { time: fmtConversationTime(f.favorited_at) }) }}
              </span>
              <template v-if="!f.available">
                <span>·</span>
                <span class="shrink-0">{{ t("favorite.mediaGone") }}</span>
              </template>
            </div>
          </div>

          <!-- 移动端没有右键：给一个明确的菜单入口（桌面用行的 @contextmenu） -->
          <button
            v-if="app.isMobile"
            class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            :title="t('favorite.more')"
            :aria-label="t('favorite.more')"
            @click.stop="openMenuAt($event, f)"
          >
            <MoreHorizontal class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- 删除二次确认：会删掉副本文件、不可恢复。内联块而不是再开一个弹窗
           —— 两个 Dialog 同时展开会互相触发 outside-click（见文件头说明）。 -->
      <div v-if="pendingDelete" class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger-soft)] p-3">
        <p class="text-sm leading-relaxed text-[var(--gosslan-text)]">
          {{ t("favorite.deleteConfirm") }}
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] px-4 py-2 text-sm text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="pendingDelete = null"
          >
            <X class="mr-1 inline h-3.5 w-3.5" />{{ t("common.cancel") }}
          </button>
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger)] px-4 py-2 text-sm text-white transition hover:opacity-90"
            @click="confirmDelete"
          >
            {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </div>

    <!-- 行菜单：复制 / 转发 / 跳回原消息 / 删除（桌面右键与移动 ⋯ 共用一份实现） -->
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :estimated-height="180"
      @close="menu = null"
    >
      <button role="menuitem" class="gosslan-menu-item" @click="copyItem(menu.item)">
        <Copy />
        {{ t("favorite.copy") }}
      </button>
      <button
        v-if="favoritable(menu.item)"
        role="menuitem"
        class="gosslan-menu-item"
        @click="startForward(menu.item)"
      >
        <Share2 />
        {{ t("favorite.forward") }}
      </button>
      <button role="menuitem" class="gosslan-menu-item" @click="locate(menu.item)">
        <CornerUpLeft />
        {{ t("favorite.locate") }}
      </button>
      <div class="gosslan-menu-sep" role="separator"></div>
      <button
        role="menuitem"
        class="gosslan-menu-item gosslan-menu-item--danger"
        @click="askDelete(menu.item)"
      >
        <Trash2 />
        {{ t("favorite.delete") }}
      </button>
    </ContextMenu>

    <!-- 图片查看：整屏点一下就走。用 <button> 而不是 div+@click —— 全屏可点区域对
         键盘/读屏也应当是一个按钮（designGuards 与无障碍守卫都要求 div@click 补
         role/tabindex/keydown，不如直接用正确的元素）。 -->
    <button
      v-if="viewer"
      class="fixed inset-0 z-[90] flex items-center justify-center bg-black/80"
      :aria-label="t('common.closeEsc')"
      @click="viewer = null"
    >
      <img :src="viewer" class="max-h-[85vh] max-w-[92vw] object-contain" alt="" />
    </button>
  </BaseModal>

  <!-- 转发弹窗：**必须是 BaseModal 的同级节点**，不能放进它的 slot 里。
       理由：面板一 emit('close')，`BaseModal` 的 `TransitionRoot :show` 就转 false，
       插槽内容会被一起卸载 —— 转发框刚开就被销毁（现象：点了转发什么都没出现），
       而 `forward` 仍是非 null，下次打开面板还会凭空冒出一个转发框。
       放在同级后：面板关、转发框留。两个 Dialog 也不会同时展开 —— `startForward`
       是先 emit('close') 再让它出现，中间只隔一次渲染。 -->
  <ForwardModal
    :open="!!forward"
    :kind="forwardKind"
    :snippet="forwardSnippet"
    @close="forward = null"
    @pick="doForward"
  />
</template>
