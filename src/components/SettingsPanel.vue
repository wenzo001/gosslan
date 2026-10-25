<script setup lang="ts">
import { routeLocationKey, routerKey } from "vue-router";
import { ChevronRight } from "lucide-vue-next";
import { computed, inject, nextTick, ref, watch } from "vue";
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
  // 2026-10-25：存储与文件合并为一个二级页（旧的 storage / files 键走别名归一）。
  storageFiles: {
    titleKey: "settings.item.storageFiles",
    render: () => StorageSection,
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

/**
 * 旧深链键 → 新二级页。用户 2026-10-25 把「存储」与「文件」并成「存储与文件」、
 * 把「安全」并进「关于」；已经点过的旧链接（`/me/settings/storage` 等）仍必须落到
 * 同一处 —— URL 说一个分区、界面却停在列表，是最典型的"深链半截状态"。
 */
const SECTION_ALIASES: Record<string, string> = {
  storage: "storageFiles",
  files: "storageFiles",
  security: "about",
};
function normalizeSectionKey(key: string): string {
  return SECTION_ALIASES[key] ?? key;
}

/** 移动端分区 = 路由派生（可深链、可返回）；桌面回退形态仍用本地 ref。 */
const routeIsSettings = computed(() => !!route && String(route.name ?? "").startsWith("settings"));
const routeSection = computed<string | null>(() => {
  if (!props.routeDriven || !routeIsSettings.value || route?.name !== "settings-section") return null;
  const key = normalizeSectionKey(String(route.params.key ?? ""));
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
  // 移动端「Profile」与「我的」头像进的是同一个资料页：只有一份宽度/按钮布局，
  // 不再在设置壳里再摆一份 ProfileSection（两套内边距会让窄屏按钮换行不一致）。
  if (key === "profile" && props.routeDriven && routeIsSettings.value && router) {
    void router.push({ name: "profile" });
    return;
  }
  if (props.routeDriven && routeIsSettings.value && router) {
    void router.push({ name: "settings-section", params: { key } });
    return;
  }
  localMobileNav.value = key;
}

/**
 * 一级列表的分组结构：每组包含多个条目，每条对应一个二级页。
 *
 * 2026-10-25 用户要求与桌面保持**同一套分类**：
 *  - 通用里不再放「存储」（它属于文件那一类事）；
 *  - 「存储与文件」= 原存储 + 原文件，放在「网络与文件」分组下；
 *  - 「安全」并入「关于」，不再单独一组（重置与恢复仍留在通用）。
 */
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
      { key: "reset", titleKey: "settings.item.reset" },
    ],
  },
  {
    key: "network",
    titleKey: "settings.group.networkFiles",
    items: [
      { key: "network", titleKey: "settings.item.network" },
      { key: "storageFiles", titleKey: "settings.item.storageFiles" },
    ],
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

/**
 * 移动端**唯一**的滚动容器（2026-10-24 重写）。
 *
 * 上一版一级/二级各有一层 `overflow-y-auto`：两页是不同节点 ⇒ 切页后旧容器连同它的
 * `scrollbar-gutter` 一起被换掉，滚动条出现/消失会让整块内容的左边缘横移 8px（"滑一会
 * 边距变了"）；而页面内容在切过去之后还在异步加载（网络页最明显），用户手指已经在滑那份
 * 会边滑边长高的文档。现在：**固定头部 + 一层滚动容器 + 页内 padding 只给内容**，
 * 一级/二级共享同一个滚动容器，切页时显式回到顶端 —— 高度变化只发生在内容里，
 * 不再有机会重算滚动条宽度或留住上一页的滚动位置。
 */
const scrollEl = ref<HTMLElement | null>(null);
watch(
  [() => props.open, mobileNav],
  async () => {
    await nextTick();
    if (scrollEl.value) scrollEl.value.scrollTop = 0;
  },
  { flush: "post" },
);
</script>

<template>
  <!-- 移动端：二级 push 导航，iOS 设置风格。头部（返回 + 标题）统一交给 MobilePageFrame，
       详情页不再各自画返回键（用户 2026-09-20）。二级→一级→关闭 由 onSettingsBack 路由。 -->
  <Transition v-if="app.isMobile" name="page-slide">
    <!-- 固定头部 + **单一**滚动容器（2026-10-24 重写，理由见 `scrollEl` 那段注释）。
         壳保持 `:scroll="false"`：页面自己那一层才是唯一的滚动容器。
         `overscroll-contain`：滑到尽头不把滚动传给外层的页面壳（触屏上就是"滑一下整块跳"）。
         padding 放在滚动层**里面**：滚动条贴着视口边缘，内容的左右边距在整个滚动过程中不变。 -->
    <MobilePageFrame
      v-if="open"
      mode="overlay"
      :scroll="false"
      :title="settingsTitle"
      @back="onSettingsBack"
    >
      <div
        ref="scrollEl"
        data-settings-scroll
        class="scrollbar-both min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
      >
        <div class="p-4">
          <!-- 一级页：分组列表 -->
          <div v-if="mobileNav === null">
            <div v-for="g in GROUPS" :key="g.key" class="mb-5 last:mb-0">
              <div class="pb-1 text-caption font-medium uppercase tracking-wider text-[var(--gosslan-text-2)]">
                {{ t(g.titleKey) }}
              </div>
              <div class="overflow-hidden rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)]">
                <!-- 标准列表交互（2026-10-25 重写）：整行按压**只换底色**，几何零位移。
                     旧实现为了"中间凹一下"在行内再套一层 `group-active:translate-y + inset shadow`，
                     真机上看起来就是整张列表缩了一下（用户原话：「点击下去的时候整个列表还是会缩」）。
                     `data-no-press` 同时挡住全站 button:active 的 scale(0.97)。
                     不加 hover：这是移动端面板，触屏上的 hover 会在点完之后粘住一行。 -->
                <button
                  v-for="(item, idx) in g.items"
                  :key="item.key"
                  data-no-press
                  class="flex w-full items-center gap-3 px-4 py-3 text-left text-emphasis transition-colors active:bg-[var(--gosslan-pressed)]"
                  :class="idx > 0 ? 'border-t border-[var(--gosslan-divider)]' : ''"
                  @click="selectSection(item.key)"
                >
                  <span class="min-w-0 flex-1 truncate text-[var(--gosslan-text)]" :title="t(item.titleKey)">{{ t(item.titleKey) }}</span>
                  <ChevronRight class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]" />
                </button>
              </div>
            </div>
          </div>

          <!-- 二级页：完整 Section 组件（与一级页同一个滚动容器、同一份 p-4 边距） -->
          <div v-else class="space-y-5">
            <ProfileSection v-if="mobileNav === 'profile'" :active="open" :reload-token="reloadToken" />
            <GeneralSection v-else-if="mobileNav === 'general'" />
            <AppearanceSection v-else-if="mobileNav === 'appearance'" />
            <ChatStyleSection v-else-if="mobileNav === 'chatStyle'" />
            <NotificationSection v-else-if="mobileNav === 'notification'" />
            <NetworkSection v-else-if="mobileNav === 'network'" :active="open" :reload-token="reloadToken" />
            <!-- 2026-10-25：存储与文件合并成一个二级页（旧 storage / files 深链已别名归一到这里）。 -->
            <template v-else-if="mobileNav === 'storageFiles'">
              <StorageSection :active="open" :reload-token="reloadToken" />
              <FilesSection :active="open" :reload-token="reloadToken" />
            </template>
            <!-- 安全并入关于：同一页里先安全、后关于（与桌面分组顺序一致）。 -->
            <template v-else-if="mobileNav === 'about'">
              <SecuritySection />
              <AboutSection @dev-open="devDiagOpen = true" />
            </template>
            <ResetSection v-else-if="mobileNav === 'reset'" @restored="reloadToken++" />
          </div>
        </div>
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
      <!-- 与桌面独立窗口同一套分类：存储与文件归在网络下面，安全归在关于里。 -->
      <StorageSection :active="open" :reload-token="reloadToken" />
      <FilesSection :active="open" :reload-token="reloadToken" />
      <ResetSection @restored="reloadToken++" />
      <SecuritySection />
      <AboutSection @dev-open="devDiagOpen = true" />
    </div>
  </BaseModal>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />
</template>
