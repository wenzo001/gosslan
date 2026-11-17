<script setup lang="ts">
/**
 * 设置 → 第三方接入：已授权应用的**导出 / 恢复**。
 *
 * 设计稿：`docs/notes/rp-key-export-recovery-design-2026-11-15.md`。
 *
 * 三条产品约束（都体现在 UI 上，不是后端自作主张）：
 * - 导出**必须**先设口令：文件里是每把 RP 私钥，泄漏等于别人能在别的机器上冒充本机登录这些应用。
 * - 恢复**先预览再写**：冲突（本机已有另一把钥）与"已撤销不复活"要逐条给用户看见，不静默覆盖。
 * - 落点由系统对话框给：后端不替用户决定写到哪，也不在后台留副本。
 */
import { computed, ref } from "vue";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import BaseModal from "@/components/BaseModal.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import DangerBtn from "@/components/ui/DangerBtn.vue";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useDeviceAuthStore } from "@/stores/useDeviceAuthStore";
import { t } from "@/i18n";
import type { RpKeyImportReport } from "@/types";

const app = useAppStore();
const store = useDeviceAuthStore();

type Phase = "idle" | "export" | "importPass" | "importPreview";
const phase = ref<Phase>("idle");
const busy = ref(false);

/** 导出：两次输入；恢复：一次输入。 */
const pass1 = ref("");
const pass2 = ref("");
/** 恢复时选中的文件（预览阶段要重放同一条路径）。 */
const sourcePath = ref("");
const preview = ref<RpKeyImportReport | null>(null);

const MIN_PASS = 12;
const passTooShort = computed(() => pass1.value.length < MIN_PASS);
const passMismatch = computed(() => pass1.value !== pass2.value);
const canExport = computed(() => !busy.value && !passTooShort.value && !passMismatch.value);
const canPreview = computed(() => !busy.value && pass1.value.length >= MIN_PASS);

function reset() {
  phase.value = "idle";
  pass1.value = "";
  pass2.value = "";
  sourcePath.value = "";
  preview.value = null;
  busy.value = false;
}

function openExport() {
  reset();
  phase.value = "export";
}

async function onExport() {
  if (!canExport.value) return;
  busy.value = true;
  try {
    const dest = await saveDialog({
      title: t("deviceAuth.backup.saveTitle"),
      defaultPath: "gosslan-keys.gosslankey",
      filters: [{ name: t("deviceAuth.backup.fileKind"), extensions: ["gosslankey"] }],
    });
    if (!dest) return; // 用户取消：什么都不做
    const r = await api.deviceAuthExportBindings(dest, pass1.value);
    app.toast(t("deviceAuth.backup.exported", { count: r.count }), "success");
    reset();
  } catch (e) {
    app.toastError(e, t("deviceAuth.backup.exportFail"));
  } finally {
    busy.value = false;
  }
}

async function pickImport() {
  reset();
  try {
    const picked = await openDialog({
      title: t("deviceAuth.backup.pickTitle"),
      multiple: false,
      directory: false,
      filters: [{ name: t("deviceAuth.backup.fileKind"), extensions: ["gosslankey"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    sourcePath.value = picked;
    phase.value = "importPass";
  } catch (e) {
    app.toastError(e, t("deviceAuth.backup.importFail"));
  }
}

async function onPreview() {
  if (!canPreview.value) return;
  busy.value = true;
  try {
    preview.value = await api.deviceAuthPreviewImport(sourcePath.value, pass1.value);
    phase.value = "importPreview";
  } catch (e) {
    // 口令错/文件坏都回同一个码（后端刻意不区分），这里照实显示。
    app.toastError(e, t("deviceAuth.backup.importFail"));
  } finally {
    busy.value = false;
  }
}

async function onApply() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  try {
    const r = await api.deviceAuthApplyImport(sourcePath.value, pass1.value);
    app.toast(
      t("deviceAuth.backup.imported", { added: r.added, skipped: r.skipped, other: r.conflicts + r.refused + r.rejected }),
      r.added > 0 ? "success" : "info",
    );
    await store.loadBindings();
    reset();
  } catch (e) {
    app.toastError(e, t("deviceAuth.backup.importFail"));
  } finally {
    busy.value = false;
  }
}

/** 预览里一条的动作标签（颜色在模板里按 action 选）。 */
function actionKey(action: string): string {
  switch (action) {
    case "add":
      return "deviceAuth.backup.actionAdd";
    case "skip":
      return "deviceAuth.backup.actionSkip";
    case "conflict":
      return "deviceAuth.backup.actionConflict";
    case "refuseRevived":
      return "deviceAuth.backup.actionRefuse";
    default:
      return "deviceAuth.backup.actionReject";
  }
}

const addable = computed(() => preview.value?.added ?? 0);
</script>

<template>
  <section class="space-y-2">
    <div>
      <h3 class="text-body font-medium text-[var(--gosslan-text)]">{{ t("deviceAuth.backup.title") }}</h3>
      <p class="mt-0.5 text-meta leading-relaxed text-[var(--gosslan-text-2)]">{{ t("deviceAuth.backup.hint") }}</p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <!-- 平时就要看得出是按钮（用户 2026-11-16：「只有 hover 的时候才能看出是按钮」）：
           dense 档的次要按钮底色透明 ⇒ 去掉 dense，用默认档（有描边、有底）。 -->
      <SecondaryBtn shrink @click="openExport">{{ t("deviceAuth.backup.export") }}</SecondaryBtn>
      <SecondaryBtn shrink @click="pickImport">{{ t("deviceAuth.backup.import") }}</SecondaryBtn>
    </div>

    <!-- 导出：口令两遍 -->
    <BaseModal
      :open="phase === 'export'"
      :title="t('deviceAuth.backup.exportTitle')"
      :fullscreen="app.isMobile"
      :width="app.isMobile ? undefined : 'max-w-md'"
      @close="reset"
    >
      <div class="space-y-3">
        <p class="text-meta leading-relaxed text-[var(--gosslan-warning-ink)]">{{ t("deviceAuth.backup.warnPortable") }}</p>
        <label class="block">
          <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.backup.passLabel", { min: MIN_PASS }) }}</span>
          <input
            v-model="pass1"
            type="password"
            class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
            :aria-label="t('deviceAuth.backup.passLabel', { min: MIN_PASS })"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.backup.passAgain") }}</span>
          <input
            v-model="pass2"
            type="password"
            class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
            :aria-label="t('deviceAuth.backup.passAgain')"
          />
        </label>
        <p v-if="passMismatch && pass2" class="text-caption text-[var(--gosslan-danger-ink)]">{{ t("deviceAuth.backup.passMismatch") }}</p>
        <p class="text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.backup.noRecovery") }}</p>
        <div class="flex justify-end gap-2">
          <SecondaryBtn :disabled="busy" @click="reset">{{ t("common.cancel") }}</SecondaryBtn>
          <PrimaryBtn :disabled="!canExport" @click="onExport">{{ t("deviceAuth.backup.export") }}</PrimaryBtn>
        </div>
      </div>
    </BaseModal>

    <!-- 恢复：先输入口令 -->
    <BaseModal
      :open="phase === 'importPass'"
      :title="t('deviceAuth.backup.importTitle')"
      :fullscreen="app.isMobile"
      :width="app.isMobile ? undefined : 'max-w-md'"
      @close="reset"
    >
      <div class="space-y-3">
        <p class="truncate font-mono text-caption text-[var(--gosslan-text-2)]" :title="sourcePath">{{ sourcePath }}</p>
        <label class="block">
          <span class="mb-1 block text-caption text-[var(--gosslan-text-2)]">{{ t("deviceAuth.backup.passLabel", { min: MIN_PASS }) }}</span>
          <input
            v-model="pass1"
            type="password"
            class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 text-sm outline-none focus:border-[var(--gosslan-primary)]"
            :aria-label="t('deviceAuth.backup.passLabel', { min: MIN_PASS })"
          />
        </label>
        <div class="flex justify-end gap-2">
          <SecondaryBtn :disabled="busy" @click="reset">{{ t("common.cancel") }}</SecondaryBtn>
          <PrimaryBtn :disabled="!canPreview" @click="onPreview">{{ t("deviceAuth.backup.preview") }}</PrimaryBtn>
        </div>
      </div>
    </BaseModal>

    <!-- 恢复：预览结果（逐条给动作，不静默覆盖） -->
    <BaseModal
      :open="phase === 'importPreview'"
      :title="t('deviceAuth.backup.previewTitle')"
      :fullscreen="app.isMobile"
      :width="app.isMobile ? undefined : 'max-w-lg'"
      @close="reset"
    >
      <div class="flex max-h-[60vh] flex-col gap-2 overflow-hidden">
        <p class="text-meta text-[var(--gosslan-text-2)]">
          {{ t("deviceAuth.backup.summary", { add: addable, skip: preview?.skipped ?? 0, other: (preview?.conflicts ?? 0) + (preview?.refused ?? 0) + (preview?.rejected ?? 0) }) }}
        </p>
        <ul class="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          <li
            v-for="it in preview?.items ?? []"
            :key="it.rpOrigin + it.clientId"
            class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)] px-2.5 py-1.5"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]" :title="it.displayName || it.clientId">
                {{ it.displayName || it.clientId }}
              </span>
              <span
                class="shrink-0 text-caption"
                :class="it.action === 'add' ? 'text-[var(--gosslan-success-ink)]' : it.action === 'skip' ? 'text-[var(--gosslan-text-2)]' : 'text-[var(--gosslan-danger-ink)]'"
              >
                {{ t(actionKey(it.action)) }}
              </span>
            </div>
            <div class="truncate font-mono text-caption text-[var(--gosslan-text-2)]" :title="it.rpOrigin">{{ it.rpOrigin }}</div>
            <p v-if="it.reason" class="mt-0.5 text-caption text-[var(--gosslan-text-2)]">{{ it.reason }}</p>
          </li>
        </ul>
        <div class="flex justify-end gap-2">
          <SecondaryBtn :disabled="busy" @click="reset">{{ t("common.cancel") }}</SecondaryBtn>
          <DangerBtn v-if="addable > 0" :disabled="busy" @click="onApply">
            {{ t("deviceAuth.backup.apply", { count: addable }) }}
          </DangerBtn>
          <PrimaryBtn v-else :disabled="true">{{ t("deviceAuth.backup.nothingToDo") }}</PrimaryBtn>
        </div>
      </div>
    </BaseModal>
  </section>
</template>
