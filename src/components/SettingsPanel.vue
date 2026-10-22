<script setup lang="ts">
import { routeLocationKey, routerKey } from "vue-router";
import { ChevronRight } from "lucide-vue-next";
import { computed, inject, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import BaseModal from "@/components/BaseModal.vue";
import MobilePageFrame from "@/components/MobilePageFrame.vue";
import DevDiagPanel from "@/components/DevDiagPanel.vue";
import ProfileSection from "@/components/settings/ProfileSection.vue";
import AppearanceSection from "@/components/settings/AppearanceSection.vue";
import ChatStyleSection from "@/components/settings/ChatStyleSection.vue";
import GeneralSection from "@/components/settings/GeneralSection.vue";
import NotificationSection from "@/components/settings/NotificationSection.vue";
import FilesSection from "@/components/settings/FilesSection.vue";
import NetworkSection from "@/components/settings/NetworkSection.vue";
import StorageSection from "@/components/settings/StorageSection.vue";
import SecuritySection from "@/components/settings/SecuritySection.vue";
import AboutSection from "@/components/settings/AboutSection.vue";
import ResetSection from "@/components/settings/ResetSection.vue";
import { t } from "@/i18n";

const props = withDefaults(defineProps<{ open: boolean; routeDriven?: boolean }>(), {
  routeDriven: false,
});
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
// 探针/桌面回退形态可以不装 router；用可空注入而不是条件调用 useRoute（
// 桌面窗口被拖窄时 props.routeDriven 会翻转，条件 hook 不会重新取路由）。
const route = inject(routeLocationKey, null);
const router = inject(routerKey, null);

/** 各分区按需加载：打开时刷新一次，恢复默认等外部改动后 bump 令牌触发重载。 */
const reloadToken = ref(0);
const devDiagOpen = ref(false);

/** 桌面回退形态用的本地二级导航；移动端以路由 `/me/settings/:key` 为准。 */
const localMobileNav = ref<string | null>(null);
watch(
  () => props.routeDriven,
  (driven) => {
    if (driven) localMobileNav.value = null;
  },
);

/**
 * 二级页配置：key → 标题 + 渲染函数（用 h 避免模板里大 switch）。
 *
 * ⚠️ `titleKey` 一律用**条目名**（`settings.item.*`，与列表里那一条的文案同键），
 * 不要用分组名（`settings.group.*`）：分组是"容器"（如「外观与通知」装着外观/聊天气泡/通知
 * 三条），用它当二级页标题就会名不副实 —— 用户点进「外观」看到的标题却是「外观与通知」
 * （用户 2026-09-21 报的正是这一类：桌面「外观与通知」里只有外观）。
 * 唯一的例外是「重置」：它的页面标题就是分区自己的名字（`settings.group.reset`）。
 */
const SECTIONS: Record<string, { titleKey: string; render: () => any }> = {
  profile: {
    titleKey: "settings.item.profile",
    render: () => ProfileSection,
  },
  general: {
    titleKey: "settings.item.general",
    render: () => GeneralSection,
  },
  appearance: {
    titleKey: "settings.item.appearance",
    render: () => AppearanceSection,
  },
  chatStyle: {
    titleKey: "settings.item.chatStyle",
    render: () => ChatStyleSection,
  },
  notification: {
    titleKey: "settings.item.notification",
    render: () => NotificationSection,
  },
  network: {
    titleKey: "settings.item.network",
    render: () => NetworkSection,
  },
  files: {
    titleKey: "settings.item.files",
    render: () => FilesSection,
  },
  storage: {
    titleKey: "settings.item.storage",
    render: () => StorageSection,
  },
  security: {
    titleKey: "settings.item.security",
    render: () => SecuritySection,
  },
  about: {
    titleKey: "settings.item.about",
    render: () => AboutSection,
  },
  reset: {
    titleKey: "settings.group.reset",
    render: () => ResetSection,
  },
};

/** 移动端分区 = 路由派生（可深链、可返回）；桌面回退形态仍用本地 ref。 */
const routeIsSettings = computed(() => !!route && String(route.name ?? "").startsWith("settings"));
const routeSection = computed<string | null>(() => {
  if (!props.routeDriven || !routeIsSettings.value || route?.name !== "settings-section") return null;
  const key = String(route.params.key ?? "");
  return key && SECTIONS[key] ? key : null;
});
const mobileNav = computed<string | null>(() =>
  props.routeDriven && routeIsSettings.value ? routeSection.value : localMobileNav.value,
);

// `/me/settings/<未知分区>` 不能停在「URL 说分区、界面却是列表」的半截状态。
// 归一成一级设置页（replace，不额外留历史）。
watch(
  () => [props.routeDriven, route?.name, route?.params.key, routeSection.value] as const,
  () => {
    if (!props.routeDriven || !router || route?.name !== "settings-section") return;
    if (routeSection.value !== null) return;
    app.toast(t("layout.routeMissing"), "info");
    void router.replace({ name: "settings" });
  },
  { immediate: true },
);

function selectSection(key: string) {
  if (props.routeDriven && routeIsSettings.value && router) {
    void router.push({ name: "settings-section", params: { key } });
    return;
  }
  localMobileNav.value = key;
}

/** 一级列表的分组结构：每组包含多个条目，每条对应一个二级页。 */
const GROUPS: { key: string; titleKey: string; items: { key: string; titleKey: string }[] }[] = [
  {
    key: "general",
    titleKey: "settings.group.general",
    items: [
      { key: "profile", titleKey: "settings.item.profile" },
      { key: "general", titleKey: "settings.item.general" },
      { key: "appearance", titleKey: "settings.item.appearance" },
      { key: "chatStyle", titleKey: "settings.item.chatStyle" },
      { key: "notification", titleKey: "settings.item.notification" },
      { key: "storage", titleKey: "settings.item.storage" },
      { key: "reset", titleKey: "settings.item.reset" },
    ],
  },
  {
    key: "network",
    titleKey: "settings.group.networkFiles",
    items: [
      { key: "network", titleKey: "settings.item.network" },
      { key: "files", titleKey: "settings.item.files" },
    ],
  },
  {
    key: "security",
    titleKey: "settings.group.security",
    items: [{ key: "security", titleKey: "settings.item.security" }],
  },
  {
    key: "about",
    titleKey: "settings.item.about",
    items: [{ key: "about", titleKey: "settings.item.about" }],
  },
];

/** 移动端头部标题：一级=设置总标题；二级=该分区标题。 */
const settingsTitle = computed(() =>
  mobileNav.value === null ? t("settings.title") : t(SECTIONS[mobileNav.value].titleKey),
);
/** 移动端返回：二级先回一级，一级再关闭整个设置层。 */
function onSettingsBack() {
  if (mobileNav.value === null) {
    emit("close");
    return;
  }
  if (props.routeDriven && router && route?.name === "settings-section") {
    const back = (window.history.state as { back?: string | null } | null)?.back;
    if (back) router.back();
    else void router.replace({ name: "settings" });
    return;
  }
  localMobileNav.value = null;
}
</script>

<template>
  <!-- 移动端：二级 push 导航，iOS 设置风格。头部（返回 + 标题）统一交给 MobilePageFrame，
       详情页不再各自画返回键（用户 2026-09-20）。二级→一级→关闭 由 onSettingsBack 路由。 -->
  <Transition v-if="app.isMobile" name="page-slide">
    <MobilePageFrame
      v-if="open"
      mode="overlay"
      :title="settingsTitle"
      @back="onSettingsBack"
    >
      <!-- 一级页：分组列表 -->
      <div v-if="mobileNav === null" class="scrollbar-both min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div v-for="g in GROUPS" :key="g.key" class="mb-5">
          <div class="pb-1 text-caption font-medium uppercase tracking-wider text-[var(--gosslan-text-2)]">
            {{ t(g.titleKey) }}
          </div>
          <div class="overflow-hidden rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)]">
            <button
              v-for="(item, idx) in g.items"
              :key="item.key"
              class="tap-safe flex w-full items-center gap-3 px-3 py-3 text-left text-emphasis transition hover:bg-[var(--gosslan-hover)]"
              :class="idx > 0 ? 'border-t border-[var(--gosslan-divider)]' : ''"
              @click="selectSection(item.key)"
            >
              <span class="flex-1 text-[var(--gosslan-text)]">{{ t(item.titleKey) }}</span>
              <ChevronRight class="h-4 w-4 text-[var(--gosslan-text-2)]" />
            </button>
          </div>
        </div>
      </div>

      <!-- 二级页：完整 Section 组件 -->
      <div v-else class="scrollbar-both min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-4">
        <ProfileSection v-if="mobileNav === 'profile'" :active="open" :reload-token="reloadToken" />
        <GeneralSection v-else-if="mobileNav === 'general'" />
        <AppearanceSection v-else-if="mobileNav === 'appearance'" />
        <ChatStyleSection v-else-if="mobileNav === 'chatStyle'" />
        <NotificationSection v-else-if="mobileNav === 'notification'" />
        <NetworkSection v-else-if="mobileNav === 'network'" :active="open" :reload-token="reloadToken" />
        <FilesSection v-else-if="mobileNav === 'files'" :active="open" :reload-token="reloadToken" />
        <StorageSection v-else-if="mobileNav === 'storage'" :active="open" :reload-token="reloadToken" />
        <SecuritySection v-else-if="mobileNav === 'security'" />
        <AboutSection v-else-if="mobileNav === 'about'" @dev-open="devDiagOpen = true" />
        <ResetSection v-else-if="mobileNav === 'reset'" @restored="reloadToken++" />
      </div>
    </MobilePageFrame>
  </Transition>

  <!-- 桌面端：卡片式弹窗（独立窗口见 `SettingsWindow.vue`；这里保留给「窗口不可用」的场景） -->
  <BaseModal v-else :open="open" :title="t('settings.title')" width="max-w-xl" @close="emit('close')">
    <div class="scrollbar-both -mx-5 -mb-5 max-h-[75vh] space-y-5 overflow-y-auto overflow-x-hidden rounded-b-[var(--gosslan-radius-xl)] bg-[var(--gosslan-bg)] p-5">
      <ProfileSection :active="open" :reload-token="reloadToken" />
      <GeneralSection />
      <NotificationSection />
      <AppearanceSection />
      <ChatStyleSection />
      <NetworkSection :active="open" :reload-token="reloadToken" />
      <FilesSection :active="open" :reload-token="reloadToken" />
      <StorageSection :active="open" :reload-token="reloadToken" />
      <SecuritySection />
      <AboutSection @dev-open="devDiagOpen = true" />
      <ResetSection @restored="reloadToken++" />
    </div>
  </BaseModal>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />
</template>
