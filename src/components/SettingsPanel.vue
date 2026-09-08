<script setup lang="ts">
import { ref } from "vue";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import DevDiagPanel from "@/components/DevDiagPanel.vue";
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
      "· 应用缓存\n\n" +
      "不会删除 / 不受影响：\n" +
      "· 好友列表与群成员身份（不会退出群聊）\n" +
      "· 设备身份、加密密钥与群密钥\n" +
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
    <div class="max-h-[75vh] space-y-6 overflow-y-auto px-4 py-1">
      <ProfileSection :active="open" :reload-token="reloadToken" />
      <AppearanceSection />
      <ChatStyleSection />
      <NetworkSection :active="open" :reload-token="reloadToken" />
      <StorageSection :active="open" :reload-token="reloadToken" />

      <!-- 共享目录 -->
      <section>
        <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">共享目录</h3>
        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-1.5 rounded-lg border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
            @click="pickShareDir"
          >
            <FolderOpen class="h-4 w-4" />
            选择文件夹
          </button>
          <span class="truncate text-xs text-[var(--gosslan-text-2)]">{{ app.shareDir || "未设置" }}</span>
        </div>
      </section>

      <SecuritySection />
      <AboutSection @dev-open="devDiagOpen = true" />

      <!-- 恢复默认 -->
      <button
        class="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--gosslan-border)] py-2 text-sm text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
        @click="restoreDefaults"
      >
        <RotateCcw class="h-4 w-4" />
        恢复默认设置
      </button>
      <p class="text-center text-[11px] text-[var(--gosslan-text-2)]">
        将外观、昵称、头像、网卡和缓存策略恢复为默认值，不影响好友、聊天记录和设备身份。
      </p>

      <!-- 清除聊天数据 -->
      <button
        class="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-red-300 py-2 text-sm text-red-500 transition hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
        @click="clearAllDataConfirm"
      >
        <Trash2 class="h-4 w-4" />
        清除聊天数据
      </button>
    </div>
  </BaseModal>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />
</template>
