<script setup lang="ts">
/**
 * 左栏「链接」视图：用户配置的外部链接列表 + 增 / 改 / 删（用户 2026-09-17）。
 *
 * 点某条链接 → 交给父级（`ResponsiveLayout`）在**独立窗口**里加载它
 * （窗口隔离、不授予远端页面任何命令权限，见 Rust `open_link_window`）。
 *
 * 数据只在主窗口用（左列），所以走独立命令而不是 `Settings` + `settings-changed`：
 * 后端能返回真实校验错误，用户不会"以为保存了"。校验口径在前端也有一份（`utils/externalLinks`）。
 */
import { computed, ref } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import { useBackLayer } from "@/composables/useBackLayer";
import MobilePageFrame from "@/components/MobilePageFrame.vue";
import BaseModal from "@/components/BaseModal.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import Spinner from "@/components/ui/Spinner.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import CharCounter from "@/components/ui/CharCounter.vue";
import { errorText } from "@/composables/useErrorText";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { api } from "@/api";
import { t } from "@/i18n";
import { saveLocalFile } from "@/utils/localFile";
import { panelKey, panelQueryOptions } from "@/utils/panelQuery";
import {
  MAX_EXTERNAL_LINKS,
  MAX_LINK_NAME_CHARS,
  isValidExternalUrl,
  validateLinkInput,
} from "@/utils/externalLinks";
import { Download, ExternalLink as ExternalLinkIcon, Link2, Pencil, Plus, Upload } from "lucide-vue-next";
import { Trash2 } from "@/components/ui/icons";
import type { ExternalLink, ExternalLinkImportResult } from "@/types";

const props = defineProps<{ opening?: boolean; routeDriven?: boolean }>();
const emit = defineEmits<{
  (e: "open", link: ExternalLink): void;
  /** 移动端覆盖层返回（回到「我的」页）。桌面端内嵌时不会触发。 */
  (e: "back"): void;
}>();

const app = useAppStore();

/**
 * 读侧交给 Query（策略见 `utils/panelQuery`）：全局只有一份链接表、没有可分键的主体
 * ⇒ id 传空串，键就是 `["links",""]`。旧实现自己维护 `loading`/`loadError` + try/finally。
 */
const linksQuery = useQuery(
  panelQueryOptions<ExternalLink[]>("links", "", () => api.listExternalLinks()),
);
const links = computed(() => linksQuery.data.value ?? []);
/** 首帧与每次重拉都算「加载中」，与旧实现的 `loading` 同义。 */
const loading = computed(() => linksQuery.isFetching.value);
/** 首屏读失败才说「读失败」；有旧快照时保留上一次读数，不把整屏换成错误页。 */
const loadError = computed(() =>
  linksQuery.error.value && !linksQuery.data.value
    ? errorText(linksQuery.error.value, t("links.loadFail"))
    : "",
);

/** 当前草稿（`id === null` = 新增）。 */
const draft = ref<{ id: string | null; name: string; url: string } | null>(null);

/**
 * 三条写命令（增 / 改 / 删）后端都返回**整份数组** ⇒ 成功时直接写回读缓存，
 * 与旧实现「把返回值回填同一个 ref」同义，且不再多发一次 list 命令。
 * 三条共用一个 mutation ⇒ 一个 `isPending` 就是旧的 `saving`。
 */
type LinkWrite =
  | { kind: "add"; name: string; url: string }
  | { kind: "update"; id: string; name: string; url: string }
  | { kind: "remove"; id: string };

const FAIL_KEY = {
  add: "links.addFail",
  update: "links.updateFail",
  remove: "links.removeFail",
} as const;

const queryClient = useQueryClient();
const writeLink = useMutation({
  mutationFn: (v: LinkWrite): Promise<ExternalLink[]> => {
    if (v.kind === "add") return api.addExternalLink(v.name, v.url);
    if (v.kind === "update") return api.updateExternalLink(v.id, v.name, v.url);
    return api.removeExternalLink(v.id);
  },
  onSuccess: (data) => {
    queryClient.setQueryData(panelKey("links", ""), data);
  },
  onError: (e, v) => {
    app.toastError(e, t(FAIL_KEY[v.kind]));
  },
});
const saving = computed(() => writeLink.isPending.value);

// 移动端链接页是覆盖层下钻页。路由驱动时历史条目已经承担返回，再压一层会「返回两次」；
// 无 router 的探针挂载才用内部栈。
if (!props.routeDriven) {
  useBackLayer(
    () => app.isMobile,
    () => emit("back"),
  );
}

function startAdd() {
  draft.value = { id: null, name: "", url: "" };
  dialogOpen.value = true;
}
function startEdit(l: ExternalLink) {
  draft.value = { id: l.id, name: l.name, url: l.url };
  dialogOpen.value = true;
}
/** 新增/编辑/线上导入/文件导入统一一个弹窗；关闭时把三种状态一起收掉。 */
const dialogOpen = ref(false);
function closeDialog() {
  draft.value = null;
  urlImportOpen.value = false;
  urlImport.value = "";
  dialogOpen.value = false;
}

const ime = useImeEnterGuard();

function saveDraft() {
  const d = draft.value;
  if (!d || saving.value) return;
  if (!d.id && links.value.length >= MAX_EXTERNAL_LINKS) {
    app.toast(t("links.err.tooMany", { n: MAX_EXTERNAL_LINKS }), "error");
    return;
  }
  const err = validateLinkInput(d, links.value, d.id ?? undefined);
  if (err) {
    app.toast(t(`links.err.${err}`, { n: MAX_LINK_NAME_CHARS }), "error");
    return;
  }
  writeLink.mutate(
    d.id
      ? { kind: "update", id: d.id, name: d.name, url: d.url }
      : { kind: "add", name: d.name, url: d.url },
    {
      onSuccess: () => {
        draft.value = null;
        dialogOpen.value = false;
      },
    },
  );
}

function remove(l: ExternalLink) {
  writeLink.mutate({ kind: "remove", id: l.id });
}

// ---------------- JSON 导入 / 导出 ----------------

const transferBusy = ref<"" | "export" | "file" | "url">("");
const urlImportOpen = ref(false);
const urlImport = ref("");

function applyImport(res: ExternalLinkImportResult) {
  queryClient.setQueryData(panelKey("links", ""), res.links);
  const lines: string[] = [];
  lines.push(
    res.added > 0
      ? t("links.importDone", { n: res.added })
      : t("links.importNone", { n: res.skipped }),
  );
  if (res.invalid > 0) lines.push(t("links.importInvalid", { n: res.invalid }));
  app.toast(lines.join(" · "), res.added > 0 ? "success" : "info");
}

async function exportLinks() {
  if (transferBusy.value) return;
  transferBusy.value = "export";
  let tempPath = "";
  try {
    tempPath = await api.exportExternalLinks();
    const done = await saveLocalFile(tempPath, "gosslan-links.json");
    if (done === "done") app.toast(t("links.exportDone"), "success");
  } catch (e) {
    app.toastError(e, t("links.exportReport"));
  } finally {
    if (tempPath) void api.cleanupExternalLinksExport(tempPath).catch(() => {});
    transferBusy.value = "";
  }
}

async function importFile() {
  if (transferBusy.value) return;
  try {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const rawPath = Array.isArray(picked) ? picked[0] : picked;
    if (!rawPath) return;
    transferBusy.value = "file";
    const localPath = await api.importPickedFile(String(rawPath), "links.json");
    applyImport(await api.importExternalLinksFile(localPath));
    dialogOpen.value = false;
  } catch (e) {
    app.toastError(e, t("links.importReport"));
  } finally {
    transferBusy.value = "";
  }
}

async function importFromUrl() {
  if (transferBusy.value) return;
  const url = urlImport.value.trim();
  if (!isValidExternalUrl(url)) {
    app.toast(t("links.err.url"), "error");
    return;
  }
  transferBusy.value = "url";
  try {
    applyImport(await api.importExternalLinksFromUrl(url));
    urlImportOpen.value = false;
    urlImport.value = "";
    dialogOpen.value = false;
  } catch (e) {
    app.toastError(e, t("links.importReport"));
  } finally {
    transferBusy.value = "";
  }
}
</script>

<template>
  <!-- 统一框架头部：标题 + 新增按钮（右上角）由 MobilePageFrame 提供；
       移动端是覆盖层带返回键，桌面端内嵌在左列（无返回键，标题栏保留）。 -->
  <MobilePageFrame
    :mode="app.isMobile ? 'overlay' : 'inline'"
    :header="true"
    :show-back="app.isMobile"
    :title="t('links.title')"
    @back="emit('back')"
  >
    <template #actions>
      <button
        class="tap-safe flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :title="t('links.importFile')"
        :aria-label="t('links.importFile')"
        :disabled="!!transferBusy"
        :aria-busy="transferBusy === 'file' || undefined"
        @click="dialogOpen = true"
      >
        <Spinner v-if="transferBusy === 'file'" size-class="h-4 w-4" decorative />
        <Upload v-else class="h-[18px] w-[18px]" />
      </button>
      <button
        class="tap-safe flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :title="t('links.importUrl')"
        :aria-label="t('links.importUrl')"
        :disabled="!!transferBusy"
        :aria-expanded="urlImportOpen"
        @click="urlImportOpen = true; dialogOpen = true"
      >
        <Link2 class="h-[18px] w-[18px]" />
      </button>
      <button
        v-if="links.length > 0"
        class="tap-safe flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :title="t('links.export')"
        :aria-label="t('links.export')"
        :disabled="!!transferBusy"
        :aria-busy="transferBusy === 'export' || undefined"
        @click="exportLinks"
      >
        <Spinner v-if="transferBusy === 'export'" size-class="h-4 w-4" decorative />
        <Download v-else class="h-[18px] w-[18px]" />
      </button>
      <button
        v-if="!draft"
        class="tap-safe flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('links.add')"
        :aria-label="t('links.add')"
        @click="startAdd"
      >
        <Plus class="h-[18px] w-[18px]" />
      </button>
    </template>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <!-- 新增 / 编辑 / 线上导入 / 文件导入 统一走一个弹窗（用户 2026-10-22）。 -->
      <BaseModal :open="dialogOpen" :title="t('links.title')" @close="closeDialog">
        <div class="mb-2 flex justify-end">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-meta text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
            :disabled="!!transferBusy"
            @click="importFile"
          >
            {{ t("links.importFile") }}
          </button>
        </div>
      <!-- 线上 JSON 导入：后端拉取，避免 WebView CORS。 -->
      <div
        v-if="urlImportOpen"
        class="mb-2 space-y-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-card)] p-2.5"
      >
        <div class="flex items-center gap-2">
          <input
            v-model="urlImport"
            type="url"
            inputmode="url"
            autocomplete="off"
            :placeholder="t('links.importUrlPlaceholder')"
            class="min-w-0 flex-1 rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-3 py-1.5 text-body outline-none transition focus:border-transparent"
            @keyup.enter="ime.enter(importFromUrl)"
            @compositionstart="ime.onStart"
            @compositionend="ime.onEnd"
          />
          <PrimaryBtn :disabled="!!transferBusy || !urlImport.trim()" @click="importFromUrl">
            {{ t("links.importUrlAction") }}
          </PrimaryBtn>
        </div>
        <div class="flex justify-end">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] px-3 py-1 text-meta text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="urlImportOpen = false; urlImport = ''"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
      </div>

      <!-- 新增 / 编辑表单 -->
      <div
        v-if="draft"
        class="mb-2 space-y-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-card)] p-2.5"
      >
        <div class="flex items-baseline gap-2">
          <input
            v-model="draft.name"
            type="text"
            :maxlength="MAX_LINK_NAME_CHARS"
            :placeholder="t('links.namePlaceholder')"
            class="min-w-0 flex-1 rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-3 py-1.5 text-body outline-none transition focus:border-transparent"
            @keyup.enter="ime.enter(saveDraft)"
            @compositionstart="ime.onStart"
            @compositionend="ime.onEnd"
          />
          <CharCounter :text="draft.name" :max="MAX_LINK_NAME_CHARS" />
        </div>
        <input
          v-model="draft.url"
          type="text"
          :placeholder="t('links.urlPlaceholder')"
          class="w-full rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-3 py-1.5 text-body outline-none transition focus:border-transparent"
          @keyup.enter="ime.enter(saveDraft)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
        <div class="flex justify-end gap-2">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] px-3 py-1.5 text-body text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="closeDialog"
          >
            {{ t("common.cancel") }}
          </button>
          <PrimaryBtn :disabled="saving" @click="saveDraft">
            {{ t("common.save") }}
          </PrimaryBtn>
        </div>
      </div>
      </BaseModal>

      <p v-if="loading" class="px-2 py-3 text-xs text-[var(--gosslan-text-2)]">{{ t("links.loading") }}</p>
      <StateBlock
        v-else-if="loadError"
        kind="error"
        :title="t('links.loadFail')"
        :detail="loadError"
        :retry-label="t('common.retry')"
        @retry="linksQuery.refetch()"
      />
      <p
        v-else-if="!links.length && !draft"
        class="px-2 py-8 text-center text-xs text-[var(--gosslan-text-2)]"
      >
        {{ t("links.empty") }}
      </p>

      <!-- 链接行：点名称打开独立窗口；右侧编辑 / 删除常显（触屏友好）。
           行样式与聊天 / 通讯录 / 收藏列表**同款**：满宽不圆角 + `--gosslan-list-hover` 悬停
           + 行间内缩分隔线（用户 2026-09-20：「链接列表的也修一下」）。 -->
      <div
        v-for="l in links"
        :key="l.id"
        class="relative flex items-center gap-0.5 px-2 py-1.5 transition hover:bg-[var(--gosslan-list-hover)]"
      >
        <button
          class="tap-safe flex min-w-0 flex-1 items-center gap-2 rounded-[var(--gosslan-radius-sm)] px-1.5 py-1.5 text-left"
          :class="opening ? 'opacity-60' : ''"
          :aria-busy="opening"
          :title="l.url"
          @click="emit('open', l)"
        >
          <ExternalLinkIcon class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]" />
          <span class="min-w-0 flex-1 truncate text-body text-[var(--gosslan-text)]" :title="l.name">
            {{ l.name }}
          </span>
        </button>
        <button
          class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('links.edit')"
          :aria-label="t('links.edit')"
          @click="startEdit(l)"
        >
          <Pencil class="h-3.5 w-3.5" />
        </button>
        <button
          class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-danger-soft)] hover:text-[var(--gosslan-danger-ink)]"
          :title="t('links.remove')"
          :aria-label="t('links.remove')"
          @click="remove(l)"
        >
          <Trash2 class="h-3.5 w-3.5" />
        </button>
        <!-- 行间内缩分隔线：从文本列起（px-2 + 按钮 px-1.5 + 16 图标 + gap-2 = 38px） -->
        <div class="pointer-events-none absolute bottom-0 left-[38px] right-0 h-px bg-[var(--gosslan-divider)]"></div>
      </div>
    </div>
  </MobilePageFrame>
</template>
