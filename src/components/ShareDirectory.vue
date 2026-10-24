<script setup lang="ts">
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import BaseModal from "@/components/BaseModal.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import { Download, Folder, RefreshCw } from "lucide-vue-next";
import { formatBytes } from "@/utils/format";
import { errorText } from "@/composables/useErrorText";
import { shareTreeQueryOptions } from "@/utils/shareTreeQuery";
import type { ShareEntry } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();

const friendId = computed(() => chat.activeConv ?? "");
const friendName = () => chat.activeConversation?.name ?? "";

function depth(p: string) {
  return p.split("/").length - 1;
}

/**
 * 树的缓存按好友分键（见 utils/shareTreeQuery）：切会话时旧树只会写回旧好友的 key，
 * 不再需要手写 `StaleGuard`；`snapshot.friendId` 随数据一起缓存，是「这棵树是谁的」的唯一答案。
 */
const treeQuery = useQuery(
  computed(() => {
    // 捕获调用时的好友 id：即便 queryFn 延后执行，数据也只会写回它自己的 key。
    const fid = friendId.value;
    return {
      ...shareTreeQueryOptions(fid, api.requestShareTree),
      enabled: props.open && !!fid,
    };
  }),
);
const snapshot = computed(() => treeQuery.data.value ?? null);
const entries = computed<ShareEntry[]>(() => snapshot.value?.entries ?? []);
/** 共享方有条数上限：截断时必须提示，否则用户会把"前 N 条"读成"对方就这些文件"。 */
const truncated = computed(() => snapshot.value?.truncated ?? false);
const loading = computed(
  () => !!friendId.value && (treeQuery.isPending.value || treeQuery.isFetching.value),
);
const error = computed(() =>
  treeQuery.error.value ? errorText(treeQuery.error.value, t("share.loadFail"), { log: true }) : null,
);

function load() {
  void treeQuery.refetch();
}

async function download(e: ShareEntry) {
  // ⚠️ 用数据自带的 `friendId`，不是点击那一刻的 `chat.activeConv`：
  // 弹窗开着时 activeConv 会被**程序化路径**换掉（点系统通知 → `openConversation`），
  // 那一刻点下载会把"A 的树里的一行"发给 B —— 后端按 B 的共享目录校验路径，
  // 结果是莫名"下载失败"，或更糟：拿到 B 上同名的另一个文件。
  const owner = snapshot.value?.friendId;
  if (!owner) return;
  try {
    await api.downloadSharedFile(owner, e.path);
    app.toast(t("share.toast.downloading", { name: e.name }), "success");
    chat.refreshTransfers();
  } catch (err) {
    app.toastError(err, t("share.toast.downloadFail"));
  }
}

</script>

<template>
  <BaseModal :open="open" :title="t('share.title', { name: friendName() })" width="max-w-lg" @close="emit('close')">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-xs text-[var(--gosslan-text-2)]">{{ t("share.desc") }}</span>
      <button
        class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        :title="t('share.refresh')"
        :aria-label="t('share.refreshAria')"
        @click="load"
      >
        <Spinner v-if="loading" size-class="h-4 w-4" decorative />
        <RefreshCw v-else class="h-4 w-4" />
      </button>
    </div>

    <div v-if="truncated && entries.length > 0" class="mb-2 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-warning-soft)] px-2 py-1 text-caption text-[var(--gosslan-warning-ink)]" role="status">
      {{ t("share.truncated", { count: entries.length }) }}
    </div>

    <div class="max-h-80 overflow-y-auto">
      <!-- 首次读取：此前这里**什么都不画**，弹窗里一片空白 ⇒ 用户分不清"在读"与"对方没有文件"。
           有旧清单时不换成整块状态（保留仍可用的数据，只在上面提示一行）。 -->
      <StateBlock
        v-if="loading && entries.length === 0"
        compact
        kind="loading"
        :title="t('share.loading')"
      />
      <div
        v-else-if="error && entries.length > 0"
        class="py-4 text-sm text-[var(--gosslan-danger-ink)]"
        role="alert"
      >{{ error }}</div>
      <StateBlock
        v-else-if="error"
        compact
        kind="error"
        :title="t('share.loadFail')"
        :detail="error"
        :retry-label="t('common.retry')"
        @retry="load()"
      />
      <StateBlock
        v-else-if="entries.length === 0"
        compact
        kind="empty"
        :title="t('share.empty')"
      />

      <div
        v-for="e in entries"
        :key="e.path"
        class="flex items-center gap-2 rounded-[var(--gosslan-radius-sm)] px-2 transition hover:bg-[var(--gosslan-hover)]"
        :style="{ paddingLeft: `${12 + depth(e.path) * 16}px`, height: '36px' }"
      >
        <Folder v-if="e.is_dir" class="h-4 w-4 shrink-0 text-[var(--gosslan-warning-ink)]" />
        <span class="flex-1 truncate text-sm" :title="e.name">{{ e.name }}</span>
        <span v-if="!e.is_dir" class="text-caption text-[var(--gosslan-text-2)]">{{ formatBytes(e.size) }}</span>
        <button
          v-if="!e.is_dir"
          class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-primary)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('common.download')" :aria-label="t('common.download')"
          @click="download(e)"
        >
          <Download class="h-4 w-4" />
        </button>
      </div>
    </div>
  </BaseModal>
</template>
