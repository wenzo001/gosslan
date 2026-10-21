<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api } from "@/api";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SettingsSelect from "@/components/ui/SettingsSelect.vue";
import { formatBytes } from "@/utils/format";
import { fmtDateStamp } from "@/utils/time";
import { Download } from "lucide-vue-next";
import { Trash2 } from "@/components/ui/icons";
import { t } from "@/i18n";
import type { CacheInfo } from "@/types";

const props = defineProps<{ active: boolean; reloadToken?: number }>();

const app = useAppStore();
const cacheInfo = ref<CacheInfo | null>(null);
/** 0 = 永久 / 无限制 */
const retentionDays = ref(0);
const maxQuotaMb = ref(0);
const cleaning = ref(false);
/** 导出进行中（读库 + 渲染可能耗时，期间禁用按钮防重复触发）。 */
const exporting = ref(false);

/** 回显赋值不应触发「改动即保存」。 */
let suppressAutoSave = false;

const quotas = [
  { value: 0, label: "settings.storage.quota.unlimited" },
  { value: 256, label: "256 MB" },
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1 GB" },
  { value: 2048, label: "2 GB" },
];
// 旧版本可能存了预设之外的数值，补一个回显选项避免下拉框空白
const quotaOptions = computed(() => {
  const list = maxQuotaMb.value > 0 && !quotas.some((q) => q.value === maxQuotaMb.value)
    ? [...quotas, { value: maxQuotaMb.value, label: `${maxQuotaMb.value} MB` }]
    : quotas;
  return list.map((q) => ({ value: q.value, label: t(q.label) }));
});
const retentionOptions = computed(() => [
  { value: 0, label: t("settings.storage.retention.forever") },
  ...[3, 7, 30].map((n) => ({ value: n, label: t("settings.storage.retention.days", { n }) })),
]);

function setRetentionDays(value: string | number) {
  retentionDays.value = Number(value);
}

function setMaxQuotaMb(value: string | number) {
  maxQuotaMb.value = Number(value);
}

async function loadCache() {
  cacheInfo.value = await api.getCacheInfo();
  suppressAutoSave = true;
  retentionDays.value = cacheInfo.value?.retention_days ?? 0;
  maxQuotaMb.value = Math.round((cacheInfo.value?.max_bytes ?? 0) / (1024 * 1024));
  // 等这一轮 watch 的回调跑完再放行：`nextTick` 就是「本次视图更新周期结束」那个点
  await nextTick();
  suppressAutoSave = false;
}

watch([retentionDays, maxQuotaMb], (_nv, ov) => {
  if (suppressAutoSave) return;
  // 开启「自动删除」前必须让用户明确知道代价：被清理的图片/文件在历史消息里会打不开。
  // 默认（永久 + 无限制）不会走到这里，所以不改默认行为、也不影响任何人。
  if (retentionDays.value > 0 || maxQuotaMb.value > 0) {
    const keep = retentionDays.value > 0 ? t("settings.storage.confirm.keepDays", { n: retentionDays.value }) : t("settings.storage.confirm.keepForever");
    const cap = maxQuotaMb.value > 0 ? t("settings.storage.confirm.cap", { n: maxQuotaMb.value }) : t("settings.storage.confirm.capUnlimited");
    // 用**应用内**弹窗确认（原先 `window.confirm` 是 WebView 的系统对话框，
    // 在无边框窗口里样式完全脱节 —— 项目其它破坏性操作都早已改成 BaseModal）。
    pendingPolicy.value = {
      prev: ov as [number, number],
      keep,
      cap,
    };
    return; // 等用户确认
  }
  void applyCachePolicy(true);
});

/** 待确认的缓存策略变更（null = 无弹窗）。 */
const pendingPolicy = ref<{ prev: [number, number]; keep: string; cap: string } | null>(null);

function confirmPolicyChange() {
  pendingPolicy.value = null;
  void applyCachePolicy(true);
}

function cancelPolicyChange() {
  const p = pendingPolicy.value;
  pendingPolicy.value = null;
  if (!p) return;
  // 用户取消：把两个下拉回滚到改动前的值
  suppressAutoSave = true;
  retentionDays.value = p.prev[0];
  maxQuotaMb.value = p.prev[1];
  void nextTick(() => (suppressAutoSave = false));
}

async function applyCachePolicy(silent = false) {
  await api.setCachePolicy(
    retentionDays.value === 0 ? null : retentionDays.value,
    maxQuotaMb.value === 0 ? null : maxQuotaMb.value * (1024 * 1024),
  );
  if (!silent) app.toast(t("settings.storage.toast.saved"), "success");
  await loadCache();
}

/**
 * 导出全部聊天文字为单个 Markdown 文件。
 *
 * 这是磁盘吃紧 / 换机前**唯一的自救手段**：存储清理只会删媒体，但库本身如果出问题，
 * 没有导出入口就只能看着聊天记录丢。只导文字（媒体仅留文件名），所以不需要新依赖。
 */
async function exportChat() {
  const now = new Date();
  const stamp = fmtDateStamp(now.getTime());
  let destination: string | null;
  try {
    destination = await saveDialog({ defaultPath: `gosslan-${t("settings.storage.export.filename")}-${stamp}.md` });
  } catch (e) {
    app.toastError(e, t("settings.storage.toast.exportDialogFail"));
    return;
  }
  if (!destination) return; // 用户取消

  exporting.value = true;
  try {
    // 时区偏移交给前端给（Rust 侧不引入时区库），getTimezoneOffset 的符号与
    // "本地 = UTC + 偏移" 相反，因此取负。
    const r = await api.exportChatText(destination, -now.getTimezoneOffset());
    app.toast(t("settings.storage.toast.exported", { conversations: r.conversations, messages: r.messages }), "success");
  } catch (e) {
    app.toastError(e, t("settings.storage.toast.exportFail"));
  } finally {
    exporting.value = false;
  }
}

/** 「立即清理」二次确认（HIG：破坏性操作要可恢复）。清理会永久删除历史消息引用到的图片/文件。 */
const confirmClean = ref(false);

function askCleanNow() {
  confirmClean.value = true;
}

async function cleanNow() {
  confirmClean.value = false;
  cleaning.value = true;
  try {
    const r = await api.cleanCacheNow();
    // 结果要说清"清了什么"：0 个时明确告诉用户当前设置下无需清理，
    // 而不是丢一句"删除 0 个文件"让人不知道点了什么。
    if (r.removed === 0) {
      app.toast(t("settings.storage.toast.nothing"), "info");
    } else {
      app.toast(t("settings.storage.toast.cleaned", { n: r.removed, bytes: formatBytes(r.freed_bytes) }), "success");
    }
  } catch (e) {
    app.toastError(e, t("settings.storage.toast.cleanFail"));
  } finally {
    cleaning.value = false;
    await loadCache();
  }
}

watch(
  () => [props.active, props.reloadToken],
  () => {
    if (props.active) void loadCache();
  },
  { immediate: true },
);
</script>

<template>
  <SettingsGroup
    :title="t('settings.group.storage')"
    :footer="t('settings.group.storage.footer')"
  >
    <SettingsRow
      :label="t('settings.storage.retention')"
      :description="t('settings.storage.retention.desc')"
    >
      <SettingsSelect
        :model-value="retentionDays"
        :options="retentionOptions"
        :select-label="t('settings.storage.retention')"
        @update:model-value="setRetentionDays"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.storage.quota')"
      :description="t('settings.storage.quota.desc')"
    >
      <SettingsSelect
        :model-value="maxQuotaMb"
        :options="quotaOptions"
        :select-label="t('settings.storage.quota')"
        @update:model-value="setMaxQuotaMb"
      />
    </SettingsRow>

    <SettingsRow
      :label="t('settings.storage.export')"
      :description="t('settings.storage.export.desc')"
    >
      <button
        class="flex shrink-0 items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="exporting"
        :title="t('settings.storage.export.title')"
        @click="exportChat"
      >
        <Download class="h-3.5 w-3.5" />
        {{ exporting ? t("settings.storage.export.exporting") : t("settings.storage.export.btn") }}
      </button>
    </SettingsRow>

    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <span class="min-w-0 text-xs leading-5 text-[var(--gosslan-text-2)]">
        {{ t("settings.storage.stats.media") }} <b>{{ cacheInfo?.media_count ?? 0 }}</b> {{ t("settings.storage.stats.unit") }} ·
        <b>{{ formatBytes(cacheInfo?.media_bytes ?? 0) }}</b><br />
        {{ t("settings.storage.stats.db") }} <b>{{ formatBytes(cacheInfo?.db_bytes ?? 0) }}</b>
      </span>
      <button
        class="flex shrink-0 items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="cleaning"
        :title="t('settings.storage.clean.title')"
        @click="askCleanNow"
      >
        <Trash2 class="h-3.5 w-3.5" />
        {{ t("settings.storage.clean.btn") }}
      </button>
    </div>
  </SettingsGroup>

  <!-- 自动删除策略：开启前确认（替代 window.confirm，与整体样式一致） -->
  <ConfirmDialog
    :open="!!pendingPolicy"
    :title="t('settings.storage.confirm.title')"
    :body="t('settings.storage.confirm.body', { keep: pendingPolicy?.keep ?? '', cap: pendingPolicy?.cap ?? '' })"
    :confirm-label="t('common.confirm')"
    @cancel="cancelPolicyChange"
    @confirm="confirmPolicyChange"
  />

  <!-- 立即清理：会永久删除历史消息引用到的图片/文件 → 二次确认 -->
  <ConfirmDialog
    :open="confirmClean"
    :title="t('settings.storage.clean.title')"
    :body="t('settings.storage.clean.confirm')"
    :confirm-label="t('settings.storage.clean.btn')"
    @cancel="confirmClean = false"
    @confirm="cleanNow"
  />
</template>
