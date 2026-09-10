<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import { formatBytes } from "@/utils/format";
import { Download, FolderOpen, Trash2 } from "lucide-vue-next";
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

watch([retentionDays, maxQuotaMb], (_nv, ov) => {
  if (suppressAutoSave) return;
  // 开启「自动删除」前必须让用户明确知道代价：被清理的图片/文件在历史消息里会打不开。
  // 默认（永久 + 无限制）不会走到这里，所以不改默认行为、也不影响任何人。
  if (retentionDays.value > 0 || maxQuotaMb.value > 0) {
    const keep = retentionDays.value > 0 ? `只保留 ${retentionDays.value} 天内` : "永久保留";
    const cap = maxQuotaMb.value > 0 ? `总占用不超过 ${maxQuotaMb.value} MB` : "占用不限制";
    const ok = window.confirm(
      `将改为「${keep}、${cap}」。\n\n` +
        "超出范围的**已接收图片与文件**会被自动删除（聊天文字不受影响），" +
        "但历史消息里对应的图片/文件将无法再打开。\n\n确定吗？",
    );
    if (!ok) {
      // 用户取消：把两个下拉回滚到改动前的值
      const prev = ov as [number, number];
      suppressAutoSave = true;
      retentionDays.value = prev[0];
      maxQuotaMb.value = prev[1];
      setTimeout(() => (suppressAutoSave = false), 0);
      return;
    }
  }
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

/**
 * 导出全部聊天文字为单个 Markdown 文件。
 *
 * 这是磁盘吃紧 / 换机前**唯一的自救手段**：存储清理只会删媒体，但库本身如果出问题，
 * 没有导出入口就只能看着聊天记录丢。只导文字（媒体仅留文件名），所以不需要新依赖。
 */
async function exportChat() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  let destination: string | null;
  try {
    destination = await saveDialog({ defaultPath: `gosslan-聊天记录-${stamp}.md` });
  } catch (e) {
    app.toast(`无法打开保存对话框：${e}`, "error");
    return;
  }
  if (!destination) return; // 用户取消

  exporting.value = true;
  try {
    // 时区偏移交给前端给（Rust 侧不引入时区库），getTimezoneOffset 的符号与
    // "本地 = UTC + 偏移" 相反，因此取负。
    const r = await api.exportChatText(destination, -now.getTimezoneOffset());
    app.toast(`已导出 ${r.conversations} 个会话、${r.messages} 条消息`, "success");
  } catch (e) {
    app.toast(`导出失败：${e}`, "error");
  } finally {
    exporting.value = false;
  }
}

async function cleanNow() {
  cleaning.value = true;
  try {
    const r = await api.cleanCacheNow();
    // 结果要说清"清了什么"：0 个时明确告诉用户当前设置下无需清理，
    // 而不是丢一句"删除 0 个文件"让人不知道点了什么。
    if (r.removed === 0) {
      app.toast("没有需要清理的图片或文件（当前保留时长 / 上限下无需删除）", "info");
    } else {
      app.toast(`已清理 ${r.removed} 个图片/文件，释放 ${formatBytes(r.freed_bytes)}`, "success");
    }
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
    title="存储"
    footer="本页只管「本机落盘的图片与文件」（聊天里收到的附件）和聊天数据库占用；聊天文字不会被自动清理。改动即时保存。保持「永久保存 + 无限制」即不做任何自动删除。"
  >
    <SettingsRow
      label="图片与文件保留时长"
      description="超过时长的已接收图片/文件会被自动清理，历史消息里对应内容将无法再打开"
    >
      <select
        v-model="retentionDays"
        class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
      >
        <option :value="0">永久保存</option>
        <option :value="3">3 天</option>
        <option :value="7">7 天</option>
        <option :value="30">30 天</option>
      </select>
    </SettingsRow>

    <SettingsRow
      label="图片与文件占用上限"
      description="超过上限时按「最旧优先」自动清理，直到降回上限以内"
    >
      <select
        v-model.number="maxQuotaMb"
        class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-bg)] px-3 py-1.5 text-sm outline-none"
      >
        <option v-for="q in quotaOptions" :key="q.value" :value="q.value">{{ q.label }}</option>
      </select>
    </SettingsRow>

    <SettingsRow
      label="文件存储目录"
      description="聊天里收到的图片与文件都保存在这里"
    >
      <div class="flex min-w-0 flex-col items-end gap-1">
        <span class="max-w-[240px] truncate text-[11px] text-[var(--gosslan-text-2)]" :title="downloadsDir || '使用默认目录'">
          {{ downloadsDir || "使用默认目录" }}
        </span>
        <div class="flex items-center gap-1.5">
          <button
            class="flex items-center gap-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-xs transition hover:bg-[var(--gosslan-hover)]"
            title="在资源管理器中打开"
            @click="openDownloadsDir"
          >
            <FolderOpen class="h-3.5 w-3.5" />
            打开
          </button>
          <button
            class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-2.5 py-1 text-xs transition hover:bg-[var(--gosslan-hover)]"
            @click="changeDownloadsDir"
          >
            更改
          </button>
        </div>
      </div>
    </SettingsRow>

    <SettingsRow
      label="导出聊天记录"
      description="把全部聊天文字导出成一个 Markdown 文件；图片与文件只保留文件名，不含本体"
    >
      <button
        class="flex shrink-0 items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="exporting"
        title="导出后可用任意文本编辑器或 Markdown 阅读器打开"
        @click="exportChat"
      >
        <Download class="h-3.5 w-3.5" />
        {{ exporting ? "导出中…" : "导出" }}
      </button>
    </SettingsRow>

    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <span class="min-w-0 text-xs leading-5 text-[var(--gosslan-text-2)]">
        已接收图片/文件 <b>{{ cacheInfo?.media_count ?? 0 }}</b> 个 ·
        <b>{{ formatBytes(cacheInfo?.media_bytes ?? 0) }}</b><br />
        聊天数据库 <b>{{ formatBytes(cacheInfo?.db_bytes ?? 0) }}</b>
      </span>
      <button
        class="flex shrink-0 items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="cleaning"
        title="按上面的设置清理过期/超限的图片与文件（不删除聊天文字）"
        @click="cleanNow"
      >
        <Trash2 class="h-3.5 w-3.5" />
        立即清理
      </button>
    </div>
  </SettingsGroup>
</template>
