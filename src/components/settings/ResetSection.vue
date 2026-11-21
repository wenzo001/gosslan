<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/**
 * 「重置与数据」设置分区：恢复默认 + 清除聊天数据（破坏性，二次确认）。
 * （2026-10-23：桌面已并入「通用」容器，不再是独立导航项。）
 *
 * 抽出的原因同 `GeneralSection`：三种外壳（独立窗口 / 移动端整页 / 弹窗）共用同一份标记。
 *
 * 恢复默认后需要让各分区重新拉数据 —— 通过 `restored` 事件上抛，
 * 由外壳 bump 自己的 `reloadToken`（原先这一段是内联在 SettingsPanel 里的局部逻辑）。
 */
import { computed, ref } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/api";
import { t } from "@/i18n";

const emit = defineEmits<{ (e: "restored"): void }>();

const app = useAppStore();
const chat = useChatStore();

/**
 * 恢复默认：外观 / 网卡 / 缓存策略回到默认值（不动好友与聊天数据）。
 *
 * ⚠️ 走二次确认（HIG：让用户容易从错误中恢复）。它不只是"改外观"：
 * `resetDefaults()` 还会把**昵称恢复默认、头像清空并广播给已连接的好友**，
 * 一次点击就执行不合适 —— 旁边的「清除聊天数据」本来就有确认，这里不该更宽松。
 */
const confirmRestore = ref(false);

async function restoreDefaults() {
  confirmRestore.value = false;
  // ⚠️ 必须自己接住异常：`resetDefaults()` 会打后端（`default_nickname` / `update_profile` /
  //   `reset_settings`），任一步失败都会 reject。此前没有 catch ⇒ 弹窗先关、Promise 静默 reject，
  //   用户看到的就是"点了没反应"（与旁边 `doClearAllData` 的口径也不一致，用户 2026-09-21）。
  try {
    await app.resetDefaults();
    emit("restored");
    app.toast(t("settings.toast.defaultsRestored"), "success");
  } catch (e) {
    app.toastError(e, t("settings.toast.restoreFail"));
  }
}

/** 清除聊天数据：二次确认走**应用内弹窗**。
 *  ⚠️ 原实现用 `window.confirm` —— 那是 WebView 的系统对话框，样式与 App 完全脱节，
 *  在无边框窗口里尤其突兀；HIG 也要求破坏性操作使用与 App 一致的对话样式并讲清后果。 */
const clearConfirmOpen = ref(false);

async function doClearAllData() {
  clearConfirmOpen.value = false;
  try {
    await chat.clearAllData();
    await chat.refreshFriends();
    await chat.refreshPending();
    app.toast(t("settings.toast.chatCleared"), "success");
  } catch (e) {
    app.toastError(e, t("settings.toast.clearFail"));
  }
}

// ────────────────────────── J1-4b：用户数据全量备份 / 恢复 ──────────────────────────
// 用户拍板（2026-11-21）：「私钥进备份，加密备份」。三条产品约束都体现在 UI 上：
// - 导出必须先设口令：备份里是整库（含身份私钥与 RP 绑定私钥）；口令**无找回**。
// - 恢复**两步走**：先解析预览（好友/消息条数给用户看），确认后重启替换——
//   运行中的连接不能被背后换库文件。
// - 落点由系统对话框给；后端不在后台留副本。

const backupBusy = ref(false);
const backupPass1 = ref("");
const backupPass2 = ref("");
/** 恢复时选中的文件（预览与确认共用同一条路径）。 */
const backupSourcePath = ref("");
type BackupPreview = {
  snapshotBytes: number;
  dbUserVersion: number;
  friendCount: number;
  messageCount: number;
  conversationCount: number;
  appVersion: string | null;
};
const backupPreview = ref<BackupPreview | null>(null);
const backupConfirmOpen = ref(false);

const BACKUP_MIN_PASS = 8;
const backupPassTooShort = computed(() => backupPass1.value.length < BACKUP_MIN_PASS);
const backupPassMismatch = computed(() => backupPass1.value !== backupPass2.value);
const canExportBackup = computed(
  () => !backupBusy.value && !backupPassTooShort.value && !backupPassMismatch.value,
);
const canPreviewBackup = computed(() => !backupBusy.value && backupPass1.value.length >= BACKUP_MIN_PASS);

function resetBackup() {
  backupPass1.value = "";
  backupPass2.value = "";
  backupSourcePath.value = "";
  backupPreview.value = null;
  backupConfirmOpen.value = false;
  backupBusy.value = false;
}

async function onExportBackup() {
  if (!canExportBackup.value) return;
  backupBusy.value = true;
  try {
    const dest = await saveDialog({
      title: t("backup.export.saveTitle"),
      defaultPath: `gosslan-backup-${new Date().toISOString().slice(0, 10)}.gosslanbackup`,
      filters: [{ name: t("backup.fileKind"), extensions: ["gosslanbackup"] }],
    });
    if (!dest) return;
    const r = await api.exportUserBackup(backupPass1.value, dest);
    app.toast(
      t("backup.export.done", {
        mb: (r.fileBytes / 1024 / 1024).toFixed(1),
        sealedNote:
          r.bindingsKeptSealed > 0
            ? t("backup.export.sealedNote", { sealed: r.bindingsKeptSealed })
            : "",
      }),
      "success",
    );
    resetBackup();
  } catch (e) {
    app.toastError(e, t("backup.export.fail"));
  } finally {
    backupBusy.value = false;
  }
}

async function pickBackupImport() {
  resetBackup();
  try {
    const picked = await openDialog({
      title: t("backup.import.pickTitle"),
      multiple: false,
      directory: false,
      filters: [{ name: t("backup.fileKind"), extensions: ["gosslanbackup"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    backupSourcePath.value = picked;
  } catch (e) {
    app.toastError(e, t("backup.import.pickFail"));
  }
}

async function onPreviewBackup() {
  if (!canPreviewBackup.value || !backupSourcePath.value) return;
  backupBusy.value = true;
  try {
    backupPreview.value = await api.importUserBackup(backupSourcePath.value, backupPass1.value);
    backupConfirmOpen.value = true;
  } catch (e) {
    // 口令错/文件坏都回同一个码（后端刻意不区分），照实显示。
    app.toastError(e, t("backup.import.fail"));
  } finally {
    backupBusy.value = false;
  }
}

async function onApplyBackupRestore() {
  if (backupBusy.value) return;
  backupBusy.value = true;
  try {
    await api.applyUserBackupRestore();
    app.toast(t("backup.import.applying"), "info");
    // 重启由后端发起；这里什么都不做，让窗口自然关闭。
  } catch (e) {
    backupBusy.value = false;
    app.toastError(e, t("backup.import.fail"));
  }
}

async function onCancelBackupRestore() {
  backupConfirmOpen.value = false;
  try {
    await api.cancelUserBackupRestore();
  } catch {
    // 取消失败无害：pending 留着，下次重启前还能取消。
  }
  resetBackup();
}
</script>

<template>
  <div class="space-y-5">
    <SettingsGroup :title="t('settings.group.reset')">
      <button
        class="settings-card-row flex w-full items-center justify-center gap-2 text-sm text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
        @click="confirmRestore = true"
      >
        <Icon name="rotate-ccw" class="h-4 w-4" />
        {{ t("settings.reset.restore") }}
      </button>
      <div class="ml-4 h-px bg-[var(--gosslan-divider)]" />
      <button
        class="settings-card-row flex w-full items-center justify-center gap-2 text-sm text-[var(--gosslan-danger-ink)] transition hover:bg-[var(--gosslan-danger-soft)] dark:hover:bg-[var(--gosslan-danger-soft)]"
        @click="clearConfirmOpen = true"
      >
        <Icon name="trash2" class="h-4 w-4" />
        {{ t("settings.reset.clearChat") }}
      </button>
    </SettingsGroup>
    <!-- J1-4b：用户数据全量备份 / 恢复（加密整库，含设备身份私钥） -->
    <SettingsGroup :title="t('backup.title')">
      <div class="space-y-3">
        <p class="text-caption leading-relaxed text-[var(--gosslan-text-2)]">
          {{ t("backup.export.hint") }}
        </p>
        <div class="space-y-2">
          <div class="text-caption font-medium text-[var(--gosslan-text-2)]">
            {{ t("backup.export.title") }}
          </div>
          <label class="block">
            <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("backup.export.passHint") }}</span>
            <input
              v-model="backupPass1"
              type="password"
              class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
              :aria-label="t('backup.export.passHint')"
              autocomplete="new-password"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("backup.export.passAgain") }}</span>
            <input
              v-model="backupPass2"
              type="password"
              class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
              :aria-label="t('backup.export.passAgain')"
              autocomplete="new-password"
            />
          </label>
          <p v-if="backupPassTooShort" class="text-caption text-[var(--gosslan-danger-ink)]">
            {{ t("backup.passShort", { min: BACKUP_MIN_PASS }) }}
          </p>
          <p v-else-if="backupPassMismatch" class="text-caption text-[var(--gosslan-danger-ink)]">
            {{ t("backup.passMismatch") }}
          </p>
          <div class="flex justify-end">
            <PrimaryBtn size="dense" :disabled="!canExportBackup" @click="onExportBackup">
              {{ t("backup.export.btn") }}
            </PrimaryBtn>
          </div>
        </div>
        <div class="h-px bg-[var(--gosslan-divider)]" />
        <div class="space-y-2">
          <div class="text-caption font-medium text-[var(--gosslan-text-2)]">
            {{ t("backup.import.title") }}
          </div>
          <div class="flex items-center gap-2">
            <span
              class="min-w-0 flex-1 truncate text-caption text-[var(--gosslan-text-2)]"
              :title="backupSourcePath"
            >{{ backupSourcePath || t("backup.import.noFile") }}</span>
            <SecondaryBtn size="dense" :disabled="backupBusy" @click="pickBackupImport">
              {{ t("backup.import.pick") }}
            </SecondaryBtn>
          </div>
          <label class="block">
            <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("backup.export.passHint") }}</span>
            <input
              v-model="backupPass1"
              type="password"
              class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
              :aria-label="t('backup.export.passHint')"
              autocomplete="off"
            />
          </label>
          <div class="flex justify-end">
            <PrimaryBtn
              size="dense"
              :disabled="!canPreviewBackup || !backupSourcePath"
              @click="onPreviewBackup"
            >
              {{ t("backup.import.previewBtn") }}
            </PrimaryBtn>
          </div>
          <p class="text-caption leading-relaxed text-[var(--gosslan-text-2)]">
            {{ t("backup.import.hint") }}
          </p>
        </div>
      </div>
    </SettingsGroup>
    <p class="settings-group-caption text-center text-caption leading-relaxed text-[var(--gosslan-text-2)]">
      {{ t("settings.reset.footnote") }}
    </p>

    <!-- 恢复默认：会连带重置昵称/头像并广播给好友，必须确认 -->
    <ConfirmDialog
      :open="confirmRestore"
      :title="t('settings.restore.title')"
      :body="t('settings.restore.warning')"
      :items="[
        t('settings.restore.item.profile'),
        t('settings.restore.item.appearance'),
        t('settings.restore.item.network'),
      ]"
      :note="t('settings.restore.note')"
      :confirm-label="t('settings.reset.restore')"
      @cancel="confirmRestore = false"
      @confirm="restoreDefaults"
    />

    <!-- 清除聊天数据：破坏性操作，逐条讲清"删什么 / 不删什么"，再给红色确认键 -->
    <ConfirmDialog
      :open="clearConfirmOpen"
      :title="t('settings.clear.title')"
      :confirm-label="t('common.clear')"
      @cancel="clearConfirmOpen = false"
      @confirm="doClearAllData"
    >
      <p class="text-sm text-[var(--gosslan-text)]">{{ t("settings.clear.warning") }}</p>
      <ul class="space-y-1 text-xs text-[var(--gosslan-text-2)]">
        <li>· {{ t("settings.clear.item.messages") }}</li>
        <li>· {{ t("settings.clear.item.transfers") }}</li>
        <li>· {{ t("settings.clear.item.cache") }}</li>
        <li>· {{ t("settings.clear.item.groups") }}</li>
      </ul>
      <p class="text-sm text-[var(--gosslan-text)]">{{ t("settings.clear.unaffected") }}</p>
      <ul class="space-y-1 text-xs text-[var(--gosslan-text-2)]">
        <li>· {{ t("settings.clear.item.friends") }}</li>
        <li>· {{ t("settings.clear.item.identity") }}</li>
        <li>· {{ t("settings.clear.item.profile") }}</li>
        <li>· {{ t("settings.clear.item.otherDevices") }}</li>
        <li>· {{ t("settings.clear.item.favorites") }}</li>
      </ul>
      <p class="text-xs text-[var(--gosslan-text-2)]">{{ t("settings.clear.note") }}</p>
    </ConfirmDialog>
  </div>

    <!-- 恢复确认：整库覆盖，最强级别的警告 -->
    <ConfirmDialog
      :open="backupConfirmOpen"
      :title="t('backup.confirm.title')"
      :body="t('backup.confirm.body', {
        friends: backupPreview?.friendCount ?? 0,
        messages: backupPreview?.messageCount ?? 0,
        ver: backupPreview?.dbUserVersion ?? 0,
      })"
      :items="[t('backup.confirm.item1'), t('backup.confirm.item2')]"
      :note="t('backup.confirm.note')"
      :confirm-label="t('backup.confirm.confirmBtn')"
      danger
      @confirm="onApplyBackupRestore"
      @cancel="onCancelBackupRestore"
    />
</template>
