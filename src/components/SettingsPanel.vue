<script setup lang="ts">
import { ref } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import DevDiagPanel from "@/components/DevDiagPanel.vue";
import SettingsGroup from "@/components/settings/SettingsGroup.vue";
import SettingsRow from "@/components/settings/SettingsRow.vue";
import ProfileSection from "@/components/settings/ProfileSection.vue";
import AppearanceSection from "@/components/settings/AppearanceSection.vue";
import ChatStyleSection from "@/components/settings/ChatStyleSection.vue";
import NetworkSection from "@/components/settings/NetworkSection.vue";
import StorageSection from "@/components/settings/StorageSection.vue";
import SecuritySection from "@/components/settings/SecuritySection.vue";
import AboutSection from "@/components/settings/AboutSection.vue";
import { FolderOpen, RotateCcw, Trash2 } from "lucide-vue-next";

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
      app.toast("共享目录已设置", "success");
    } catch (e) {
      app.toast(String(e), "error");
    }
  }
}

/** 恢复默认：外观 / 网卡 / 缓存策略回到默认值（不动好友与聊天数据）。 */
async function restoreDefaults() {
  await app.resetDefaults();
  reloadToken.value++;
  app.toast("已恢复默认设置", "success");
}

async function clearAllDataConfirm() {
  const ok = window.confirm(
    "确定要清除聊天数据吗？\n\n" +
      "将删除（仅本机）：\n" +
      "· 所有聊天消息和会话（含群聊）\n" +
      "· 文件传输与群文件记录\n" +
      "· 应用缓存\n" +
      "· 退出所有群聊（群聊会从列表中移除）\n\n" +
      "不会删除 / 不受影响：\n" +
      "· 好友列表\n" +
      "· 设备身份、加密密钥\n" +
      "· 昵称、头像和所有设置\n" +
      "· 其他设备上的聊天记录\n\n" +
      "清除后收到的新消息将正常接收。",
  );
  if (!ok) return;
  try {
    await chat.clearAllData();
    await chat.refreshFriends();
    await chat.refreshPending();
    app.toast("聊天数据已清除", "success");
  } catch (e) {
    app.toast(`清除失败：${e}`, "error");
  }
}
</script>

<template>
  <BaseModal :open="open" title="设置" width="max-w-xl" @close="emit('close')">
    <div class="-mx-5 -mb-5 max-h-[75vh] space-y-5 overflow-y-auto overflow-x-hidden rounded-b-[var(--gosslan-radius-xl)] bg-[var(--gosslan-bg)] p-5">
      <ProfileSection :active="open" :reload-token="reloadToken" />
      <AppearanceSection />
      <ChatStyleSection />
      <NetworkSection :active="open" :reload-token="reloadToken" />

      <!-- 共享目录 -->
      <SettingsGroup title="共享目录" footer="允许好友浏览并下载你共享的文件夹内容">
        <SettingsRow label="共享文件夹" :description="app.shareDir || '未设置'" last>
          <button
            class="flex items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
            @click="pickShareDir"
          >
            <FolderOpen class="h-3.5 w-3.5" />
            选择文件夹
          </button>
        </SettingsRow>
      </SettingsGroup>

      <StorageSection :active="open" :reload-token="reloadToken" />
      <SecuritySection />
      <AboutSection @dev-open="devDiagOpen = true" />

      <!-- 重置 / 清除 -->
      <SettingsGroup title="重置与数据">
        <button
          class="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)]"
          @click="restoreDefaults"
        >
          <RotateCcw class="h-4 w-4" />
          恢复默认设置
        </button>
        <div class="ml-4 h-px bg-[var(--gosslan-divider)]" />
        <button
          class="flex w-full items-center justify-center gap-2 px-4 py-3 text-sm text-[var(--gosslan-danger-ink)] transition hover:bg-[var(--gosslan-danger-soft)] dark:hover:bg-[var(--gosslan-danger-soft)]"
          @click="clearAllDataConfirm"
        >
          <Trash2 class="h-4 w-4" />
          清除聊天数据
        </button>
      </SettingsGroup>
      <p class="px-1 text-center text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
        恢复默认不影响好友、聊天记录和设备身份。清除聊天数据会删除本机全部消息、会话与文件传输记录，
        并<strong>退出所有群聊</strong>（好友关系与设备身份保留）。
      </p>
    </div>
  </BaseModal>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />
</template>
