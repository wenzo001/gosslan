<script setup lang="ts">
import { ref } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import DevDiagPanel from "@/components/DevDiagPanel.vue";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import SettingsToggle from "@/components/settings/SettingsToggle.vue";
import ProfileSection from "@/components/settings/ProfileSection.vue";
import AppearanceSection from "@/components/settings/AppearanceSection.vue";
import ChatStyleSection from "@/components/settings/ChatStyleSection.vue";
import NetworkSection from "@/components/settings/NetworkSection.vue";
import StorageSection from "@/components/settings/StorageSection.vue";
import SecuritySection from "@/components/settings/SecuritySection.vue";
import AboutSection from "@/components/settings/AboutSection.vue";
import { FolderOpen, RotateCcw, Trash2 } from "lucide-vue-next";
import { t, LOCALES } from "@/i18n";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();

/** 各分区按需加载：打开时刷新一次，恢复默认等外部改动后 bump 令牌触发重载。 */
const reloadToken = ref(0);
const devDiagOpen = ref(false);

async function pickShareDir() {
  const picked = await openDialog({ directory: true });
  if (typeof picked === "string") {
    try {
      await app.setShareDir(picked);
      app.toast(t("settings.toast.shareSet"), "success");
    } catch (e) {
      app.toastError(e, t("settings.toast.shareFail"));
    }
  }
}

/** 恢复默认：外观 / 网卡 / 缓存策略回到默认值（不动好友与聊天数据）。 */
async function restoreDefaults() {
  await app.resetDefaults();
  reloadToken.value++;
  app.toast(t("settings.toast.defaultsRestored"), "success");
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
</script>

<template>
  <BaseModal :open="open" :title="t('settings.title')" width="max-w-xl" @close="emit('close')">
    <div class="-mx-5 -mb-5 max-h-[75vh] space-y-5 overflow-y-auto overflow-x-hidden rounded-b-[var(--gosslan-radius-xl)] bg-[var(--gosslan-bg)] p-5">
      <ProfileSection :active="open" :reload-token="reloadToken" />
      <AppearanceSection />
      <ChatStyleSection />

      <!-- 语言 -->
      <SettingsGroup :title="t('settings.language.title')" :footer="t('settings.language.desc')">
        <SettingsRow :label="t('settings.language.title')" last>
          <div class="flex items-center gap-1">
            <button
              v-for="l in LOCALES"
              :key="l.value"
              class="rounded-[var(--gosslan-radius-sm)] px-2.5 py-1 text-xs transition"
              :class="app.language === l.value
                ? 'bg-primary text-white'
                : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
              @click="app.setLanguage(l.value)"
            >
              {{ l.label }}
            </button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <NetworkSection :active="open" :reload-token="reloadToken" />

      <!-- 通知 -->
      <SettingsGroup
        :title="t('settings.group.notifications')"
        :footer="t('settings.group.notifications.footer')"
      >
        <SettingsRow :label="t('settings.notify.enabled')" :description="t('settings.notify.enabled.desc')">
          <SettingsToggle
            :label="t('settings.notify.enabled')"
            :model-value="app.notifyEnabled"
            @update:model-value="app.setNotifyEnabled"
          />
        </SettingsRow>
        <SettingsRow
          :label="t('settings.notify.showContent')"
          :description="t('settings.notify.showContent.desc')"
          last
        >
          <SettingsToggle
            :label="t('settings.notify.showContent')"
            :model-value="app.notifyShowContent"
            :disabled="!app.notifyEnabled"
            @update:model-value="app.setNotifyShowContent"
          />
        </SettingsRow>
      </SettingsGroup>

      <!-- 共享目录 -->
      <SettingsGroup :title="t('settings.group.share')" :footer="t('settings.group.share.footer')">
        <SettingsRow :label="t('settings.share.folder')" :description="app.shareDir || t('common.notSet')" last>
          <button
            class="flex items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
            @click="pickShareDir"
          >
            <FolderOpen class="h-3.5 w-3.5" />
            {{ t("common.chooseFolder") }}
          </button>
        </SettingsRow>
      </SettingsGroup>

      <StorageSection :active="open" :reload-token="reloadToken" />
      <SecuritySection />
      <AboutSection @dev-open="devDiagOpen = true" />

      <!-- 重置 / 清除 -->
      <SettingsGroup :title="t('settings.group.reset')">
        <button
          class="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
          @click="restoreDefaults"
        >
          <RotateCcw class="h-4 w-4" />
          {{ t("settings.reset.restore") }}
        </button>
        <div class="ml-4 h-px bg-[var(--gosslan-divider)]" />
        <button
          class="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm text-[var(--gosslan-danger-ink)] transition hover:bg-[var(--gosslan-danger-soft)] dark:hover:bg-[var(--gosslan-danger-soft)]"
          @click="clearConfirmOpen = true"
        >
          <Trash2 class="h-4 w-4" />
          {{ t("settings.reset.clearChat") }}
        </button>
      </SettingsGroup>
      <p class="px-1 text-center text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("settings.reset.footnote") }}
      </p>
    </div>
  </BaseModal>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />

  <!-- 清除聊天数据：破坏性操作，逐条讲清"删什么 / 不删什么"，再给红色确认键 -->
  <BaseModal :open="clearConfirmOpen" :title="t('settings.clear.title')" @close="clearConfirmOpen = false">
    <div class="space-y-3">
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
      </ul>
      <p class="text-xs text-[var(--gosslan-text-2)]">{{ t("settings.clear.note") }}</p>
      <div class="flex justify-end gap-2 pt-2">
        <button
          class="rounded-[var(--gosslan-radius-md)] px-4 py-1.5 text-sm transition hover:bg-[var(--gosslan-hover)]"
          @click="clearConfirmOpen = false"
        >{{ t("common.cancel") }}</button>
        <button
          class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger)] px-4 py-1.5 text-sm text-white transition hover:bg-[var(--gosslan-danger)]"
          @click="doClearAllData"
        >{{ t("common.clear") }}</button>
      </div>
    </div>
  </BaseModal>
</template>
