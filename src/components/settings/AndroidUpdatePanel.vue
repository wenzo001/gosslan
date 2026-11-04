<script setup lang="ts">
/**
 * 安卓应用内升级面板（只在 `isAndroid` 时挂载）。
 *
 * ## 这个面板存在的理由（用户 2026-11-04）
 * 之前移动端没有应用内升级；而桌面端的 `UpdatePanel` 在点「确认安装」后**立刻把弹窗关掉**
 * （`@confirm="confirming = false; emit('install')"`），于是 Android 上会经历
 * 「弹窗消失 → 一段毫无反应的静默（PackageInstaller 正在写会话）→ 系统安装界面突然出现」。
 * 用户以为没生效，反复点。
 *
 * 这里的修复是**状态驱动**而不是加一个 `setTimeout`：
 * - 点确认后弹窗**不关**，`busy` 由 `isInstallBusy(state)` 决定
 *   （安装阶段是 `preparing`/`launching` 时系统安装器还没出来，必须继续显示并禁用按钮）；
 * - 只有 `installStep === "waiting-user"`（系统确认框已经出现、安装器正式接管）才关弹窗，
 *   让系统界面站到前台；面板本身继续显示「等待系统确认」直到应用被替换。
 * 每一步都有 `androidService.test.ts` 的转移断言兜底。
 */
import { computed, ref, watch } from "vue";
import Spinner from "@/components/ui/Spinner.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import MarkdownText from "@/components/ui/MarkdownText.vue";
import { t } from "@/i18n";
import {
  isInstallBusy,
  installerTookOver,
  type AndroidInstallStep,
  type AndroidUpdateState,
} from "@/updater/androidService";
import { formatBytes } from "@/utils/format";

const props = defineProps<{ state: AndroidUpdateState }>();
const emit = defineEmits<{
  (e: "check"): void;
  (e: "download"): void;
  (e: "cancel"): void;
  (e: "install"): void;
  (e: "retry"): void;
  (e: "dismiss"): void;
  (e: "permission"): void;
}>();

const confirming = ref(false);

/**
 * 弹窗只在三种情况下自动关掉：
 * 1. 系统安装器已接管（`waiting-user`）—— 再挡在前面就是挡住系统确认框；
 * 2. 装完了 / 失败了 —— 结论已经落到面板上，弹窗留着没有信息量。
 * 其余时刻（含 `preparing`/`launching` 的静默期）**保持打开**。
 */
watch(
  () => [props.state.phase, props.state.installStep] as const,
  () => {
    if (props.state.phase === "failed" || props.state.phase === "installed") {
      confirming.value = false;
    } else if (installerTookOver(props.state)) {
      confirming.value = false;
    }
  },
);

const busy = computed(() => isInstallBusy(props.state));

const stepText = computed(() => {
  const step: AndroidInstallStep | null = props.state.installStep;
  if (step === "preparing") return t("settings.androidUpdate.step.preparing");
  if (step === "launching") return t("settings.androidUpdate.step.launching");
  if (step === "waiting-user") return t("settings.androidUpdate.step.waitingUser");
  if (step === "installing") return t("settings.androidUpdate.step.installing");
  return t("settings.androidUpdate.step.preparing");
});

const progressPercent = computed<number | null>(() => {
  const { downloaded, total } = props.state;
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
});

const progressLabel = computed(() => {
  const { downloaded, total } = props.state;
  return total
    ? t("settings.updates.progress", { done: formatBytes(downloaded), total: formatBytes(total) })
    : t("settings.updates.progressUnknown", { done: formatBytes(downloaded) });
});

const errorKey = computed(() => `settings.androidUpdate.error.${props.state.errorCode ?? "unknown"}`);

const statusText = computed(() => {
  switch (props.state.phase) {
    case "checking":
      return t("settings.updates.checking");
    case "available":
      return t("settings.updates.available", { version: props.state.info?.version ?? "" });
    case "downloading":
      return t("settings.updates.downloading");
    case "verifying":
      return t("settings.androidUpdate.verifying");
    case "ready":
      return t("settings.androidUpdate.ready");
    case "installing":
      return stepText.value;
    case "installed":
      return t("settings.androidUpdate.installed");
    case "failed":
      return t(errorKey.value);
    default:
      return props.state.upToDate ? t("settings.updates.uptodate") : t("settings.updates.idle");
  }
});

const canCheck = computed(
  () =>
    props.state.phase === "idle" ||
    props.state.phase === "available" ||
    props.state.phase === "installed" ||
    (props.state.phase === "failed" && props.state.retry === "check"),
);

const showCard = computed(
  () =>
    props.state.info !== null &&
    (props.state.phase === "available" ||
      props.state.phase === "downloading" ||
      props.state.phase === "verifying" ||
      props.state.phase === "ready" ||
      props.state.phase === "installing" ||
      props.state.phase === "failed"),
);

const downloadLabel = computed(() =>
  props.state.info?.size
    ? t("settings.androidUpdate.downloadWithSize", { size: formatBytes(props.state.info.size) })
    : t("settings.updates.download"),
);
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

    <div
      v-if="showCard"
      class="mt-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] p-3"
    >
      <p class="text-sm font-medium text-[var(--gosslan-text)]">
        {{ t("settings.updates.available", { version: state.info?.version ?? "" }) }}
      </p>
      <p v-if="state.info?.size" class="mt-0.5 text-caption tabular-nums text-[var(--gosslan-text-2)]">
        {{ t("settings.androidUpdate.size", { size: formatBytes(state.info.size) }) }}
      </p>
      <p v-if="state.info?.notes" class="mt-2 text-caption font-medium text-[var(--gosslan-text-2)]">
        {{ t("settings.updates.notes") }}
      </p>
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
          <div
            v-if="progressPercent !== null"
            class="h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-200 ease-[var(--gosslan-ease)]"
            :style="{ transform: `scaleX(${progressPercent / 100})` }"
          ></div>
          <div v-else class="h-full w-1/3 rounded-full bg-[var(--gosslan-primary)] opacity-60"></div>
        </div>
        <p class="mt-1 text-caption tabular-nums text-[var(--gosslan-text-2)]">
          {{ progressLabel }}
        </p>
      </div>

      <!-- 校验阶段也要有可见状态：sha256 + 解析包/签名要读几十 MB，不能留空白。 -->
      <p
        v-if="state.phase === 'verifying'"
        class="mt-3 flex items-center gap-1.5 text-caption text-[var(--gosslan-text-2)]"
      >
        <Spinner size-class="h-3.5 w-3.5" decorative />
        {{ t("settings.androidUpdate.verifying") }}
      </p>

      <!-- 无权限：说清「去哪里开」并给一个直达按钮；授权回来后后端会把状态推成 ready。 -->
      <div
        v-if="state.phase === 'failed' && state.errorCode === 'permission'"
        class="mt-2 space-y-1.5"
      >
        <p class="text-caption leading-relaxed text-[var(--gosslan-text-2)]">
          {{ t("settings.androidUpdate.permissionHint") }}
        </p>
        <button
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('permission')"
        >
          {{ t("settings.androidUpdate.permissionAction") }}
        </button>
      </div>

      <!-- 安装进行中（含弹窗已关掉的 waiting-user）：面板必须继续给出步骤，不能回到空白。 -->
      <p
        v-if="state.phase === 'installing'"
        class="mt-3 flex items-center gap-1.5 text-caption text-[var(--gosslan-text-2)]"
      >
        <Spinner size-class="h-3.5 w-3.5" decorative />
        {{ stepText }}
      </p>

      <div v-if="state.phase !== 'installing'" class="mt-3 flex flex-wrap items-center gap-2">
        <button
          v-if="state.phase === 'available'"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-3 py-1.5 text-xs text-[var(--gosslan-on-primary)] transition hover:opacity-90"
          @click="emit('download')"
        >
          {{ downloadLabel }}
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
          {{ t("settings.androidUpdate.install") }}
        </button>
        <!-- 失败后按失败位置重试：下载失败就重下（不残留半包），安装失败就重装。 -->
        <button
          v-if="state.phase === 'failed' && state.retry"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-3 py-1.5 text-xs text-[var(--gosslan-on-primary)] transition hover:opacity-90"
          @click="emit('retry')"
        >
          {{ t("settings.updates.retry") }}
        </button>
        <button
          v-if="state.phase !== 'downloading' && state.phase !== 'verifying'"
          type="button"
          class="tap-safe rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="emit('dismiss')"
        >
          {{ t("settings.updates.later") }}
        </button>
      </div>
    </div>

    <!-- 核心修复：确认后**不立刻关**。`busy` 期间两个按钮都禁用、✕/返回也无效，
         直到 `installStep === "waiting-user"` 才由上面的 watch 关掉。 -->
    <ConfirmDialog
      :open="confirming"
      :title="t('settings.androidUpdate.install')"
      :confirm-label="t('settings.updates.confirm')"
      :body="t('settings.androidUpdate.confirmInstall')"
      :note="t('settings.androidUpdate.confirmNote')"
      :danger="false"
      :busy="busy"
      :busy-label="stepText"
      @cancel="confirming = false"
      @confirm="emit('install')"
    />
  </div>
</template>
