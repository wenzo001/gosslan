<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import { formatBytes } from "@/utils/format";
import { FolderOpen, Trash2 } from "lucide-vue-next";
import type { CacheInfo } from "@/types";

const props = defineProps<{ active: boolean; reloadToken?: number }>();

const app = useAppStore();
const cacheInfo = ref<CacheInfo | null>(null);
/** 0 = 永久 / 无限制 */
const retentionDays = ref(0);
const maxQuotaMb = ref(0);
const cleaning = ref(false);
/** 文件接收目录（接收的图片/文件落盘于此，未手动另存前都在这里）。 */
const downloadsDir = ref("");

/** 回显赋值不应触发「改动即保存」。 */
let suppressAutoSave = false;

const quotas = [
  { value: 0, label: "无限制" },
  { value: 256, label: "256 MB" },
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1 GB" },
  { value: 2048, label: "2 GB" },
];
// 旧版本可能存了预设之外的数值，补一个回显选项避免下拉框空白
const quotaOptions = computed(() => {
  if (maxQuotaMb.value > 0 && !quotas.some((q) => q.value === maxQuotaMb.value)) {
    return [...quotas, { value: maxQuotaMb.value, label: `${maxQuotaMb.value} MB` }];
  }
  return quotas;
});

async function loadCache() {
  cacheInfo.value = await api.getCacheInfo();
  suppressAutoSave = true;
  retentionDays.value = cacheInfo.value?.retention_days ?? 0;
  maxQuotaMb.value = Math.round((cacheInfo.value?.max_bytes ?? 0) / 1048576);
  // 等 watch 同步跳过这一轮由「回显赋值」触发的回调
  setTimeout(() => (suppressAutoSave = false), 0);
}

async function loadDownloadsDir() {
  try {
    downloadsDir.value = await api.getDownloadsDir();
  } catch {
    downloadsDir.value = "";
  }
}

async function changeDownloadsDir() {
  const picked = await openDialog({ directory: true });
  if (typeof picked !== "string") return;
  try {
    await api.setDownloadsDir(picked);
    downloadsDir.value = picked;
    app.toast("文件存储目录已更新", "success");
  } catch (e) {
    app.toast(String(e), "error");
  }
}

async function openDownloadsDir() {
  try {
    await api.openDownloadsDir();
  } catch (e) {
    app.toast(String(e), "error");
  }
}

watch([retentionDays, maxQuotaMb], () => {
  if (suppressAutoSave) return;
  void applyCachePolicy(true);
});

async function applyCachePolicy(silent = false) {
  await api.setCachePolicy(
    retentionDays.value === 0 ? null : retentionDays.value,
    maxQuotaMb.value === 0 ? null : maxQuotaMb.value * 1048576,
  );
  if (!silent) app.toast("缓存策略已保存", "success");
  await loadCache();
}

async function cleanNow() {
  cleaning.value = true;
  try {
    const r = await api.cleanCacheNow();
    app.toast(`清理完成：删除 ${r.removed} 个文件，释放 ${formatBytes(r.freed_bytes)}`, "success");
  } catch (e) {
    app.toast(String(e), "error");
  } finally {
    cleaning.value = false;
    await loadCache();
  }
}

watch(
  () => [props.active, props.reloadToken],
  () => {
    if (props.active) {
      void loadCache();
      void loadDownloadsDir();
    }
  },
  { immediate: true },
);
</script>

<template>
  <SettingsGroup
    title="存储与缓存"
    footer="磁盘上限为「无限制」时缓存不会被自动清理；设置上限后，缓存超过该值会自动删除最旧的图片 / 文件。改动即时生效并自动保存。"
  >
    <SettingsRow label="保留时长">
      <select
        v-model="retentionDays"
        class="rounded-lg bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
      >
        <option :value="0">永久保存</option>
        <option :value="3">3 天</option>
        <option :value="7">7 天</option>
        <option :value="30">30 天</option>
      </select>
    </SettingsRow>

    <SettingsRow label="磁盘上限">
      <select
        v-model.number="maxQuotaMb"
        class="rounded-lg bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
      >
        <option v-for="q in quotaOptions" :key="q.value" :value="q.value">{{ q.label }}</option>
      </select>
    </SettingsRow>

    <SettingsRow
      label="文件存储目录"
      :description="downloadsDir || '使用默认目录'"
    >
      <div class="flex items-center gap-1.5">
        <button
          class="flex items-center gap-1 rounded-lg border border-[var(--gosslan-border)] px-2.5 py-1 text-xs transition hover:bg-[var(--gosslan-hover)]"
          title="在资源管理器中打开"
          @click="openDownloadsDir"
        >
          <FolderOpen class="h-3.5 w-3.5" />
          打开
        </button>
        <button
          class="rounded-lg border border-[var(--gosslan-border)] px-2.5 py-1 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="changeDownloadsDir"
        >
          更改
        </button>
      </div>
    </SettingsRow>

    <div class="flex items-center justify-between px-4 py-3">
      <span class="text-xs text-[var(--gosslan-text-2)]">
        当前缓存 {{ cacheInfo?.file_count ?? 0 }} 个文件 · 占用 {{ formatBytes(cacheInfo?.total_bytes ?? 0) }}
      </span>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="cleaning"
        @click="cleanNow"
      >
        <Trash2 class="h-3.5 w-3.5" />
        立即清理
      </button>
    </div>
  </SettingsGroup>
</template>
