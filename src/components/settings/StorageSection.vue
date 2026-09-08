<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { formatBytes } from "@/utils/format";
import { HardDrive, Trash2 } from "lucide-vue-next";
import type { CacheInfo } from "@/types";

const props = defineProps<{ active: boolean; reloadToken?: number }>();

const app = useAppStore();
const cacheInfo = ref<CacheInfo | null>(null);
/** 0 = 永久 / 无限制 */
const retentionDays = ref(0);
const maxQuotaMb = ref(0);
const cleaning = ref(false);

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
    if (props.active) void loadCache();
  },
  { immediate: true },
);
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">存储与缓存</h3>
    <div class="mb-3 flex items-center gap-2 text-xs text-[var(--gosslan-text-2)]">
      <HardDrive class="h-3.5 w-3.5" />
      当前缓存 {{ cacheInfo?.file_count ?? 0 }} 个文件 · 占用 {{ formatBytes(cacheInfo?.total_bytes ?? 0) }}
    </div>
    <div class="mb-3 flex items-center gap-3">
      <span class="w-16 shrink-0 text-sm">保留时长</span>
      <select
        v-model="retentionDays"
        class="flex-1 rounded-lg bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
      >
        <option :value="0">永久保存</option>
        <option :value="3">3 天</option>
        <option :value="7">7 天</option>
        <option :value="30">30 天</option>
      </select>
    </div>
    <div class="flex items-center gap-3">
      <span class="w-16 shrink-0 text-sm">磁盘上限</span>
      <select
        v-model.number="maxQuotaMb"
        class="flex-1 rounded-lg bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
      >
        <option v-for="q in quotaOptions" :key="q.value" :value="q.value">{{ q.label }}</option>
      </select>
    </div>
    <p class="mb-3 mt-1.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
      磁盘上限为「无限制」时缓存不会被自动清理；设置上限后，缓存超过该值会自动删除最旧的图片 / 文件。改动即时生效并自动保存。
    </p>
    <button
      class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--gosslan-border)] py-2 text-sm transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
      :disabled="cleaning"
      @click="cleanNow"
    >
      <Trash2 class="h-4 w-4" />
      立即清理
    </button>
  </section>
</template>
