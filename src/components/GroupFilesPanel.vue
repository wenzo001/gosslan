<script setup lang="ts">
/**
 * 群文件面板：把该群**全部**群文件汇总成一份清单（钉钉/飞书「群文件」的等价物）。
 *
 * 为什么需要它：群文件以前只能顺着聊天记录往回翻——一条 `gfile-` 消息滑上去就找不到了。
 * 而后端的 `group_files` 表本来就完整存着每个群文件的元数据（名称/大小/发送者/时间）
 * 与每个成员的投递状态，只是从来没有一个入口把它列出来。
 *
 * 数据来源：`list_group_files` 命令（读 `group_files` + `group_file_recipients` + 文件系统）。
 * ⚠️ 这张表**不随「删除聊天记录」清空**（同钉盘语义：群文件是群资产，不是聊天记录），
 *    所以本面板在清空聊天历史后依然完整。
 */
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed, onBeforeUnmount, watch } from "vue";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useMemberProfile } from "@/composables/useMemberProfile";
import BaseModal from "@/components/BaseModal.vue";
import { fmtConversationTime } from "@/utils/time";
import { formatBytes } from "@/utils/format";
import { FILE_KIND_ICONS, extBadgeLabel, fileKindOf, fileKindStyle } from "@/utils/fileKind";
import { openLocalFile } from "@/utils/localFile";
import { RotateCw } from "lucide-vue-next";
import StateBlock from "@/components/ui/StateBlock.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import { errorText } from "@/composables/useErrorText";
import {
  groupFilesKey,
  invalidateGroupFiles,
} from "@/utils/groupFilesQuery";
import { PANEL_QUERY_POLICY } from "@/utils/panelQuery";
import { createInitScope, type InitScope } from "@/utils/initScope";
import type { GroupFileEntry } from "@/types";

const props = defineProps<{ open: boolean; groupId: string | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const { memberProfile, myId } = useMemberProfile();

/**
 * 清单缓存交给 TanStack Query（见 utils/groupFilesQuery 的判据）：
 * · queryKey 按群分键 ⇒ 切群时 A 群的慢响应只会写回 A 群的缓存，不存在"回填进 B 群"；
 * · enabled 跟 open/groupId ⇒ 每次打开重拉（staleTime 0），关着时不打 IPC；
 * · 同一 key 的并发请求合并、失败重试、旧数据保留都是库的既有语义。
 */
const filesQuery = useQuery(
  computed(() => {
    // 在构建 options 时捕获群 id：即便 queryFn 延后执行，数据也只会写回它自己的 key。
    const gid = props.groupId;
    return {
      queryKey: groupFilesKey(gid ?? ""),
      queryFn: () => api.listGroupFiles(gid as string),
      enabled: props.open && !!gid,
      ...PANEL_QUERY_POLICY,
    };
  }),
);
const queryClient = useQueryClient();

const files = computed<GroupFileEntry[]>(() => filesQuery.data.value ?? []);
const loading = computed(
  () => !!props.groupId && (filesQuery.isPending.value || filesQuery.isFetching.value),
);
const failed = computed(() => filesQuery.isError.value);
const loadError = computed(() =>
  filesQuery.error.value
    ? errorText(filesQuery.error.value, t("group.files.loadFail"))
    : "",
);

/** 重试入口：失败后旧清单仍在（banner）或为空（StateBlock），两条都走同一次 refetch。 */
function load() {
  void filesQuery.refetch();
}

/**
 * 面板开着时跟随后端事件失效当前群（旧的实现只在重新打开时才知道状态变了）：
 * 文件落盘/失败/取消、新的 gfile- 消息、gfile- 送达回执。
 * 门控在 `open` 上：关着时没必要订阅；浏览器预览（无 Tauri）里 listen 会 reject，静默跳过。
 */
let activityScope: InitScope | null = null;

function stopActivityWatch() {
  activityScope?.dispose();
  activityScope = null;
}

watch(
  () => props.open && !!props.groupId,
  (active) => {
    stopActivityWatch();
    if (!active) return;
    const scope = createInitScope();
    activityScope = scope;
    api
      .onGroupFileActivity(() => {
        const gid = props.groupId;
        if (gid) void invalidateGroupFiles(queryClient, gid);
      })
      .then((unlisten) => scope.onDispose(unlisten))
      .catch(() => {
        /* 非 Tauri 环境：面板仍可关闭重开刷新 */
      });
  },
  { immediate: true },
);
onBeforeUnmount(stopActivityWatch);

/** 每项的文件类型与配色 —— 与文件气泡同一套（utils/fileKind），保证同一种文件在
 *  列表和气泡里长得一样。 */
function kindIcon(name: string) {
  return FILE_KIND_ICONS[fileKindOf(name)];
}
/** 徽标配色只有一份实现（`utils/fileKind`）：此前与收藏页各抄了一遍 12% 混底。 */
function kindStyle(name: string) {
  return fileKindStyle(name, app.dark);
}
function extLabel(name: string) {
  return extBadgeLabel(name, t("common.file"));
}

/** 本机持有状态 → 可读文案。与 sender 无关：这是**我能不能打开它**。 */
const STATE_TEXT: Record<GroupFileEntry["local_state"], string> = {
  local: "group.files.stateLocal",
  receiving: "group.files.stateReceiving",
  remote: "group.files.stateRemote",
  failed: "group.files.stateFailed",
};

/** 发送者昵称。自己的文件也照常显示：面板里混着多人发的文件，逐行标出归属更好认。 */
function senderLabel(id: string): string {
  return memberProfile(id).name;
}

/**
 * 只有**别人发的**且本机没有的文件才谈得上「重新获取」。
 *
 * 自己发的文件本机没有被取到时，`request_content` 会以 `sender_id = 我自己`
 * 发起请求 —— 那是在向自己索要文件，没有任何端点会应答。所以自己的文件不提供该入口。
 */
function canRefetch(f: GroupFileEntry): boolean {
  return f.sender_id !== myId.value && (f.local_state === "remote" || f.local_state === "failed");
}

/** 我发出的文件显示「已送达 N/M」：群文件最常被追问的就是"大家都收到了吗"。 */
function deliveryText(f: GroupFileEntry): string | null {
  if (f.sender_id !== myId.value || f.total === 0) return null;
  return t("group.files.delivered", { n: f.delivered, total: f.total });
}

async function openFile(f: GroupFileEntry) {
  if (!f.local_path) return;
  // 平台差异（Android 改走另存为）统一在 utils/localFile 里，与消息气泡同一条路径。
  try {
    // 群文件的 msg_id 恒为 `gfile-{transfer_id}`；后端据此回绑台账（SEC-01）。
    await openLocalFile(f.local_path, f.name, `gfile-${f.transfer_id}`);
  } catch (e) {
    app.toastError(e, t("msg.openFileFail"));
  }
}

/**
 * 未取到的文件：按 cid 向**原发送者**重新拉一份。
 *
 * 直接复用消息气泡既有的 `request_content`（ADR-0019「拥有即授权」）——
 * 群文件的 msg_id 恒为 `gfile-{transfer_id}`，因此面板只凭一行元数据就能构造出
 * 与气泡完全相同的请求，不需要为群文件另开一条重取路径。
 */
async function refetch(f: GroupFileEntry) {
  try {
    const ok = await api.requestContent(f.sender_id, `gfile-${f.transfer_id}`);
    app.toast(
      t(ok ? "group.files.refetching" : "group.files.refetchUnsupported"),
      ok ? "info" : "error",
    );
  } catch (e) {
    app.toastError(e, t("group.files.refetchFail"));
  }
}

const totalSize = computed(() => files.value.reduce((s, f) => s + f.size, 0));

/** `t()` 的 key 是静态字面量，才能在字典里被静态检查到；因此用查表而不是拼 key。 */
function stateText(state: GroupFileEntry["local_state"]): string {
  return t(STATE_TEXT[state]);
}
</script>

<template>
  <BaseModal
    :open="open"
    :title="files.length ? t('group.files.titleCount', { n: files.length }) : t('group.files.title')"
    width="max-w-lg"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div v-if="files.length" class="text-xs text-[var(--gosslan-text-2)]">
        {{ t("group.files.totalSize", { n: files.length, size: formatBytes(totalSize) }) }}
      </div>

      <div v-if="failed && files.length > 0" class="flex items-center justify-between gap-2 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-warning-soft)] px-2.5 py-1.5 text-xs text-[var(--gosslan-text-body)]">
        <span class="min-w-0 truncate" :title="loadError">{{ t("group.files.loadFail") }}</span>
        <PrimaryBtn size="default" shrink @click="load()">
          <span class="inline-flex items-center gap-1">
            <RotateCw class="h-3.5 w-3.5" aria-hidden="true" />
            {{ t("common.retry") }}
          </span>
        </PrimaryBtn>
      </div>

      <!-- 三态同一出口（`StateBlock` 的 compact 形态）：此前只有错误态走它，
           加载/空态各写一段内联 div —— 同一个弹窗里三套写法，改一处另两处就漂。 -->
      <StateBlock
        v-if="loading && files.length === 0"
        compact
        kind="loading"
        :title="t('group.files.loading')"
      />

      <StateBlock
        v-else-if="failed && files.length === 0"
        compact
        kind="error"
        :title="t('group.files.loadFail')"
        :detail="loadError"
        :retry-label="t('common.retry')"
        @retry="load()"
      />

      <StateBlock
        v-else-if="files.length === 0"
        compact
        kind="empty"
        :title="t('group.files.empty')"
      />

      <div v-else class="max-h-80 space-y-0.5 overflow-y-auto">
        <div
          v-for="f in files"
          :key="f.transfer_id"
          class="flex items-center gap-2.5 rounded-[var(--gosslan-radius-md)] px-2 py-2 transition"
          :class="f.local_path ? 'cursor-pointer hover:bg-[var(--gosslan-hover)]' : ''"
          :role="f.local_path ? 'button' : undefined"
          :tabindex="f.local_path ? 0 : undefined"
          :title="f.local_path ? t('msg.clickToOpen') : undefined"
          @click="openFile(f)"
          @keydown.enter.prevent="openFile(f)"
          @keydown.space.prevent="openFile(f)"
        >
          <div
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)]"
            :style="kindStyle(f.name)"
          >
            <component :is="kindIcon(f.name)" class="h-[18px] w-[18px]" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="truncate text-body font-medium" :title="f.name">{{ f.name }}</div>
            <div class="mt-0.5 flex items-center gap-1 text-caption text-[var(--gosslan-text-2)]">
              <span>{{ extLabel(f.name) }}</span>
              <span>·</span>
              <span>{{ formatBytes(f.size) }}</span>
              <span>·</span>
              <span class="truncate" :title="senderLabel(f.sender_id)">{{ senderLabel(f.sender_id) }}</span>
              <span>·</span>
              <span class="shrink-0">{{ fmtConversationTime(f.created_at, t) }}</span>
              <template v-if="deliveryText(f)">
                <span>·</span>
                <span class="shrink-0">{{ deliveryText(f) }}</span>
              </template>
            </div>
          </div>

          <!-- 右侧状态：已在本机 / 传输中 / 未取到（可点重取）/ 失败 -->
          <span
            v-if="f.local_state !== 'local'"
            class="flex shrink-0 items-center gap-1 text-caption text-[var(--gosslan-text-2)]"
          >
            <Spinner v-if="f.local_state === 'receiving'" size-class="h-3 w-3" decorative />
            {{ stateText(f.local_state) }}
          </span>
          <button
            v-if="canRefetch(f)"
            class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            :title="t('group.files.refetch')"
            :aria-label="t('group.files.refetch')"
            @click.stop="refetch(f)"
          >
            <RotateCw class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
