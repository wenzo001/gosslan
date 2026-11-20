<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import BaseModal from "@/components/BaseModal.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import { formatBytes } from "@/utils/format";
import { detailText } from "@/composables/useErrorText";
import { shareTreeQueryOptions } from "@/utils/shareTreeQuery";
import type { ShareEntry } from "@/types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();

const friendId = computed(() => chat.activeConv ?? "");
const friendName = () => chat.activeConversation?.name ?? "";

/**
 * 对端是否在线（用户 2026-11-20）。
 *
 * 共享目录是**点对点直连**：没有中转可退，对方不在线时请求注定失败 —— 旧行为仍然先发一次，
 * 于是弹窗停在「正在读取共享目录…」等一轮超时，最后给一句笼统的失败。
 * 前置条件既然已知不成立，就**不发起请求**，直接把原因说清（这是本条需求的全部）。
 *
 * 判据与会话列表同一份数据源（好友表里的 online），不另算一套"在线"。
 */
const peerOnline = computed(() => {
  const id = friendId.value;
  if (!id) return false;
  // 「和自己聊天」：自己永远"在线"（同一个进程读自己那份共享目录），
  // 不能因为好友表里没有自己就判离线 —— 那是把一个可用功能误关掉。
  if (id === app.device?.device_id) return true;
  return chat.friends.find((f) => f.device_id === id)?.online ?? false;
});

function depth(p: string) {
  return p.split("/").length - 1;
}

/**
 * 展开的目录路径集合（用户 2026-11-18）。
 *
 * 默认**空集 = 全部折叠**：深层目录第一次打开时不会一次铺满整屏，最外层目录也只显示
 * 一行标题；点一下才展开该层（子目录仍折叠）。
 */
const expanded = ref<Set<string>>(new Set());
function isExpanded(p: string) {
  return expanded.value.has(p);
}
function toggleDir(p: string) {
  const next = new Set(expanded.value);
  if (next.has(p)) next.delete(p);
  else next.add(p);
  expanded.value = next;
}

/** 可见行：保留「所有祖先目录都已展开」的条目。O(n·depth)，只在展开态变化时重算。 */
const visibleEntries = computed<ShareEntry[]>(() => {
  const open = expanded.value;
  return entries.value.filter((e) => {
    const parts = e.path.split("/");
    // 顶层（无父目录）永远可见
    for (let i = 1; i < parts.length; i++) {
      if (!open.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
});

/** 该目录下还有没有内容（决定是否显示展开箭头 / 下载按钮）。 */
function hasChild(dirPath: string) {
  return entries.value.some((e) => e.path.startsWith(`${dirPath}/`));
}
/** 目录下所有文件（递归）。 */
function filesUnder(dirPath: string) {
  return entries.value.filter((e) => !e.is_dir && e.path.startsWith(`${dirPath}/`));
}

/** 整目录下载的进度（按目录 path 记；同时只允许少量并发，避免把对端打满）。 */
type DirTask = { done: number; total: number; failed: number };
const dirTasks = ref<Map<string, DirTask>>(new Map());
const DIR_CONCURRENCY = 2;
const DIR_PROGRESS_TICK = 10;

function setDirTask(path: string, task: DirTask) {
  const next = new Map(dirTasks.value);
  next.set(path, { ...task });
  dirTasks.value = next;
}
function clearDirTask(path: string) {
  const next = new Map(dirTasks.value);
  next.delete(path);
  dirTasks.value = next;
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
      // 离线时**连读都不读**（见 peerOnline 的注释）：不发这次注定失败的 IPC，
      // 也就不会有"先转圈再失败"的那一串状态。
      enabled: props.open && !!fid && peerOnline.value,
    };
  }),
);
const snapshot = computed(() => treeQuery.data.value ?? null);
// 组件跨会话不销毁：切到另一个好友时，展开态与下载进度必须跟着清掉（2026-11-20 审计修）。
// 树数据本身按 friendId 分键是一对的，但这两个本地 UI 状态过去只按 path 索引，切人后会串台
// （同名目录继承旧展开态、旧下载进度禁用新好友的下载按钮）。
watch(friendId, () => {
  expanded.value = new Set();
  dirTasks.value = new Map();
});
const entries = computed<ShareEntry[]>(() => snapshot.value?.entries ?? []);
/** 共享方有条数上限：截断时必须提示，否则用户会把"前 N 条"读成"对方就这些文件"。 */
const truncated = computed(() => snapshot.value?.truncated ?? false);
const loading = computed(
  // ⚠️ 必须带上 peerOnline：query 被 disable 时 TanStack 的 `isPending` 仍为 true，
  // 不门住就会在"离线不读"的分支上永远转圈 —— 比原来的超时更糟。
  () => peerOnline.value && !!friendId.value && (treeQuery.isPending.value || treeQuery.isFetching.value),
);
const error = computed(() =>
  treeQuery.error.value ? detailText(treeQuery.error.value, { log: true }) : null,
);

function load() {
  // 离线时刷新是空动作（query 被 disable）—— 明确不装样子。
  if (!peerOnline.value) return;
  void treeQuery.refetch();
}

/**
 * 下载整个目录：把该目录下所有文件逐个发起下载（协议仍是"一个文件一条流"，
 * 不新增打包格式 ⇒ 不动线格式）。并发 2，进度按「已发起/总数」显示；
 * 全部静默发起（`silent`），避免刷出上百条"你正在下载…"系统消息。
 */
async function downloadDir(e: ShareEntry) {
  const owner = snapshot.value?.friendId;
  if (!owner) return;
  // 兜底：按钮已禁用，键盘/程序化路径仍可能到这里 —— 别发注定失败的 IPC。
  if (!peerOnline.value) return;
  if (dirTasks.value.has(e.path)) return; // 正在下载，防重入
  const files = filesUnder(e.path);
  if (files.length === 0) {
    app.toast(t("share.toast.dirEmpty"), "info");
    return;
  }
  const task: DirTask = { done: 0, total: files.length, failed: 0 };
  setDirTask(e.path, task);
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const f = files[cursor++];
      try {
        await api.downloadSharedFile(owner, f.path, true);
      } catch {
        task.failed += 1;
      }
      task.done += 1;
      // 进度不必每一条都触发重渲染（大目录会把主线程刷爆）。
      if (task.done % DIR_PROGRESS_TICK === 0 || task.done === task.total) setDirTask(e.path, task);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(DIR_CONCURRENCY, files.length) }, () => worker()),
    );
    chat.refreshTransfers();
    if (task.failed === 0) {
      app.toast(t("share.toast.dirQueued", { n: files.length }), "success");
    } else {
      app.toast(
        t("share.toast.dirPartial", { ok: files.length - task.failed, fail: task.failed }),
        "error",
      );
    }
  } finally {
    clearDirTask(e.path);
  }
}

async function download(e: ShareEntry) {
  // ⚠️ 用数据自带的 `friendId`，不是点击那一刻的 `chat.activeConv`：
  // 弹窗开着时 activeConv 会被**程序化路径**换掉（点系统通知 → `openConversation`），
  // 那一刻点下载会把"A 的树里的一行"发给 B —— 后端按 B 的共享目录校验路径，
  // 结果是莫名"下载失败"，或更糟：拿到 B 上同名的另一个文件。
  const owner = snapshot.value?.friendId;
  if (!owner) return;
  // 同 downloadDir：离线不发起（点了也只会失败）。
  if (!peerOnline.value) return;
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
        class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-40"
        :disabled="!peerOnline"
        :title="t('share.refresh')"
        :aria-label="t('share.refreshAria')"
        @click="load"
      >
        <Spinner v-if="loading" size-class="h-4 w-4" decorative />
        <Icon name="refresh-cw" v-else class="h-4 w-4" />
      </button>
    </div>

    <div v-if="truncated && entries.length > 0" class="mb-2 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-warning-soft)] px-2 py-1 text-caption text-[var(--gosslan-warning-text-ink)]" role="status">
      {{ t("share.truncated", { count: entries.length }) }}
    </div>

    <!-- 离线：说明白"为什么没有列表"（点对点直连，没有中转可退），而不是让用户等一个必然失败的读取。
         有旧清单时保留它（那是上次在线读到的），只在上方提示一行并禁用下载。 -->
    <div
      v-if="!peerOnline"
      class="mb-2 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-warning-soft)] px-2 py-1 text-caption text-[var(--gosslan-warning-text-ink)]"
      role="status"
    >
      {{ entries.length > 0 ? t("share.offlineBanner") : t("share.offlineHint") }}
    </div>

    <div class="scrollbar-both max-h-80 overflow-y-auto">
      <!-- 首次读取：此前这里**什么都不画**，弹窗里一片空白 ⇒ 用户分不清"在读"与"对方没有文件"。
           有旧清单时不换成整块状态（保留仍可用的数据，只在上面提示一行）。 -->
      <StateBlock
        v-if="!peerOnline && entries.length === 0"
        compact
        kind="empty"
        :title="t('share.offlineTitle')"
        :detail="t('share.offlineHint')"
      />
      <StateBlock
        v-else-if="loading && entries.length === 0"
        compact
        kind="loading"
        :title="t('share.loading')"
      />
      <div
        v-else-if="error && entries.length > 0"
        class="py-4 text-sm text-[var(--gosslan-danger-ink)]"
        role="alert"
      >{{ t("errors.toastJoined", { prefix: t("share.loadFail"), detail: error }) }}</div>
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
        v-for="e in visibleEntries"
        :key="e.path"
        class="flex items-center gap-2 rounded-[var(--gosslan-radius-sm)] px-2 transition hover:bg-[var(--gosslan-hover)]"
        :style="{ paddingLeft: `${12 + depth(e.path) * 16}px`, height: '36px' }"
      >
        <!-- 目录一条分支、文件一条分支：各自内部自洽，避免同条件下另起一条 v-if 链。 -->
        <template v-if="e.is_dir">
          <button
            v-if="hasChild(e.path)"
            type="button"
            class="tap-safe flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            :aria-label="isExpanded(e.path) ? t('share.collapseDir') : t('share.expandDir')"
            :title="isExpanded(e.path) ? t('share.collapseDir') : t('share.expandDir')"
            @click="toggleDir(e.path)"
          >
            <Icon :name="isExpanded(e.path) ? 'chevron-down' : 'chevron-right'" class="h-4 w-4" />
          </button>
          <span v-else class="w-6 shrink-0" aria-hidden="true"></span>
          <Icon name="folder" class="h-4 w-4 shrink-0 text-[var(--gosslan-warning-ink)]" />
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-sm"
            :title="e.name"
            @click="hasChild(e.path) ? toggleDir(e.path) : undefined"
          >{{ e.name }}</button>
          <!-- 整目录下载：进度 = 已发起/总数（协议仍是一个文件一条流）。 -->
          <span v-if="dirTasks.get(e.path)" class="shrink-0 text-caption text-[var(--gosslan-text-2)]">
            {{ t("share.dirProgress", { done: dirTasks.get(e.path)!.done, total: dirTasks.get(e.path)!.total }) }}
          </span>
          <button
            v-if="hasChild(e.path)"
            type="button"
            class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-primary)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
            :disabled="dirTasks.has(e.path) || !peerOnline"
            :title="t('share.downloadDir')" :aria-label="t('share.downloadDir')"
            @click.stop="downloadDir(e)"
          >
            <Spinner v-if="dirTasks.has(e.path)" size-class="h-3.5 w-3.5" decorative />
            <Icon v-else name="download" class="h-4 w-4" />
          </button>
        </template>
        <template v-else>
          <span class="w-6 shrink-0" aria-hidden="true"></span>
          <span class="min-w-0 flex-1 truncate text-sm" :title="e.name">{{ e.name }}</span>
          <span class="shrink-0 text-caption text-[var(--gosslan-text-2)]">{{ formatBytes(e.size) }}</span>
          <button
            type="button"
            class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-primary)] transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
            :disabled="!peerOnline"
            :title="t('common.download')" :aria-label="t('common.download')"
            @click="download(e)"
          >
            <Icon name="download" class="h-4 w-4" />
          </button>
        </template>
      </div>
    </div>
  </BaseModal>
</template>
