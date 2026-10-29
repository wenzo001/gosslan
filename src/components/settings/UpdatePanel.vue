<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Spinner from "@/components/ui/Spinner.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import MarkdownText from "@/components/ui/MarkdownText.vue";
import { t } from "@/i18n";
import type { UpdaterErrorCode, UpdaterState } from "@/updater/service";
// 字节格式化的唯一家（审计 P2 #35）：这里曾有一份口径不同的私有实现（KB 取整、没有 GB 档）。
import { formatBytes } from "@/utils/format";

const props = defineProps<{ state: UpdaterState; supported: boolean }>();
const emit = defineEmits<{
  (e: "check"): void;
  (e: "download"): void;
  (e: "cancel"): void;
  (e: "install"): void;
  (e: "dismiss"): void;
}>();

const confirming = ref(false);
watch(
  () => props.state.phase,
  () => {
    confirming.value = false;
  },
);

const progressPercent = computed<number | null>(() => {
  const { downloaded, total } = props.state;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
});

const errorKey = computed(() => {
  const code: UpdaterErrorCode = props.state.error ?? "unknown";
  return `settings.updates.error.${code}`;
});

const canCheck = computed(
  () =>
    props.supported &&
    props.state.phase !== "downloading" &&
    props.state.phase !== "installing" &&
    props.state.phase !== "ready",
);

const showUpdateCard = computed(
  () =>
    props.state.info !== null &&
    (props.state.phase === "available" ||
      props.state.phase === "downloading" ||
      props.state.phase === "ready" ||
      props.state.phase === "error"),
);

const statusText = computed(() => {
  switch (props.state.phase) {
    case "checking":
      return t("settings.updates.checking");
    case "available":
      return t("settings.updates.available", { version: props.state.info?.version ?? "" });
    case "downloading":
      return t("settings.updates.downloading");
    case "ready":
      return t("settings.updates.ready");
    case "installing":
      return t("settings.updates.installing");
    case "up-to-date":
      return t("settings.updates.uptodate");
    case "error":
      return t(errorKey.value);
    default:
      return t("settings.updates.idle");
  }
});

const progressLabel = computed(() => {
  const { downloaded, total } = props.state;
  return total
    ? t("settings.updates.progress", { done: formatBytes(downloaded), total: formatBytes(total) })
    : t("settings.updates.progressUnknown", { done: formatBytes(downloaded) });
});

function formatDate(seconds: number | null | undefined): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString();
}
</script>

<template>
  <div class="px-4 py-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm text-[var(--gosslan-text)]">
          {{ t("settings.updates.current", { version: state.currentVersion }) }}
        </p>
        <p
          class="mt-0.5 text-caption leading-relaxed text-[var(--gosslan-text-2)]"
          role="status"
          aria-live="polite"
        >
          {{ statusText }}
        </p>
      </div>
      <button
        v-if="canCheck"
        type="button"
        class="tap-safe inline-flex shrink-0 items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)] disabled:opacity-50"
        :disabled="state.phase === 'checking'"
        @click="emit('check')"
      >
        <Spinner v-if="state.phase === 'checking'" size-class="h-3.5 w-3.5" decorative />
        {{ t("settings.updates.check") }}
      </button>
    </div>

    <p v-if="!supported" class="mt-2 text-caption leading-relaxed text-[var(--gosslan-text-2)]">
      {{ t("settings.updates.mobile") }}
    </p>

    <div
      v-if="showUpdateCard"
      class="mt-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] p-3"
    >
      <p class="text-sm font-medium text-[var(--gosslan-text)]">
        {{ t("settings.updates.available", { version: state.info?.version ?? "" }) }}
      </p>
      <p v-if="state.info?.publishedAt" class="mt-0.5 text-caption text-[var(--gosslan-text-2)]">
        {{ t("settings.updates.published", { date: formatDate(state.info.publishedAt) }) }}
      </p>
      <p v-if="state.info?.notes" class="mt-2 text-caption font-medium text-[var(--gosslan-text-2)]">
        {{ t("settings.updates.notes") }}
      </p>
      <!-- 说明是 Markdown（我们自己的 CHANGELOG 片段）⇒ 渲染成标题/列表/粗体，
           不再原样显示 `###` 与 `**`。内容来自网络 ⇒ `MarkdownText` 里过白名单消毒。 -->
      <MarkdownText
        v-if="state.info?.notes"
        :source="state.info.notes"
        class="mt-1 max-h-36 overflow-y-auto text-caption leading-relaxed text-[var(--gosslan-text-2)]"
      />

      <div v-if="state.phase === 'downloading'" class="mt-3">
        <div
          class="h-1.5 overflow-hidden rounded-full bg-[var(--gosslan-hover)]"
          role="progressbar"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="progressPercent ?? undefined"
          :aria-label="t('settings.updates.downloading')"
        >
          <!-- 进度用 scaleX 而不是动 width（§14.6）：width 每帧都要重排，
               和同一屏里的其它传输进度条（ChatWindow / MessageFileBubble）口径一致。 -->
          <div
            v-if="progressPercent !== null"
            class="h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-200 ease-[var(--gosslan-ease)]"
            :style="{ transform: `scaleX(${progressPercent / 100})` }"
          ></div>
          <div v-else class="h-full w-1/3 animate-none rounded-full bg-[var(--gosslan-primary)] opacity-60"></div>
        </div>
        <p class="mt-1 text-caption tabular-nums text-[var(--gosslan-text-2)]">
          {{ progressLabel }}
        </p>
      </div>

      <!-- 下载中途失败：说清已下多少、重试会从头开始（负责人 2026-10-29「下载到一半也要处理」）。 -->
      <p
        v-if="state.phase === 'error' && state.downloaded > 0"
        class="mt-2 text-caption leading-relaxed text-[var(--gosslan-text-2)]"
      >
        {{ t("settings.updates.halfDownloaded", { done: formatBytes(state.downloaded) }) }}
      </p>
      <!-- 装之前复查发现更高版本：手里那份已被丢弃，说清楚为什么又要重下。 -->
      <p
        v-if="state.notice === 'superseded'"
        class="mt-2 rounded-[var(--gosslan-radius-xs)] bg-[var(--gosslan-hover)] px-2 py-1.5 text-caption leading-relaxed text-[var(--gosslan-text)]"
      >
        {{ t("settings.updates.superseded", { version: state.info?.version ?? "" }) }}
      </p>

      <!-- 装之前先说清"会退出并重启"；点确认才真的安装（负责人 2026-10-29：改成弹窗提醒）。 -->
      <div v-if="state.phase !== 'installing'" class="mt-3 flex flex-wrap items-center gap-2">
        <button
          v-if="state.phase === 'available' || (state.phase === 'error' && state.info)"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-3 py-1.5 text-xs text-[var(--gosslan-on-primary)] transition hover:opacity-90"
          @click="emit('download')"
        >
          {{ state.phase === "error" ? t("settings.updates.retry") : t("settings.updates.download") }}
        </button>
        <button
          v-if="state.phase === 'downloading'"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('cancel')"
        >
          {{ t("settings.updates.cancel") }}
        </button>
        <button
          v-if="state.phase === 'ready'"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-3 py-1.5 text-xs text-[var(--gosslan-on-primary)] transition hover:opacity-90"
          @click="confirming = true"
        >
          {{ t("settings.updates.install") }}
        </button>
        <button
          v-if="state.phase !== 'downloading' && state.phase !== 'ready'"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('dismiss')"
        >
          {{ t("settings.updates.later") }}
        </button>
      </div>
    </div>

    <p v-if="state.phase === 'installing'" class="mt-2 flex items-center gap-1.5 text-caption text-[var(--gosslan-text-2)]">
      <Spinner size-class="h-3.5 w-3.5" decorative />
      {{ t("settings.updates.installing") }}
    </p>

    <ConfirmDialog
      :open="confirming"
      :title="t('settings.updates.install')"
      :confirm-label="t('settings.updates.confirm')"
      :body="t('settings.updates.confirmInstall')"
      :note="t('settings.updates.confirmNote')"
      :danger="false"
      @cancel="confirming = false"
      @confirm="confirming = false; emit('install')"
    />
  </div>
</template>
