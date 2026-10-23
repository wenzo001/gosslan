<script setup lang="ts">
/**
 * 独立「设置」窗口的内容（桌面端 label="settings"，由 Rust `open_settings_window` 创建）。
 *
 * 布局照用户给的参考图：**左侧窄导航 + 右侧内容**（微信 4.0 设置窗口）——
 * 用户 2026-09-12 反馈：「PC 端的设置页面可以按照这种布局，弹一个单独的窗口」。
 *
 * 与 `SettingsPanel` 的关系：两者复用**同一批分区组件**（ProfileSection … ResetSection），
 * 只有外壳不同（这里是窗口内的左右两栏，那里是移动端整页/卡片弹窗）。
 * 这样「设置长什么样」只有一份实现，不会三处漂移。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import { SETTINGS_SECTIONS } from "@/router/settings";
import AuxWindowShell from "@/components/window/AuxWindowShell.vue";
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
import { SlidersHorizontal, Wifi, Lock, Info } from "lucide-vue-next";
import { t } from "@/i18n";
import { api } from "@/api";
import { updater } from "@/updater/instance";
import { storageGet, storageRemove } from "@/utils/safeStorage";

type SectionKey =
  | "profile"
  | "general"
  | "notifications"
  | "appearance"
  | "network"
  | "files"
  | "storage"
  | "security"
  | "about"
  | "reset";

const route = useRoute();
const router = useRouter();

/** 当前分区 = 路由参数（可深链、可返回），不再是组件内 ref。 */
const section = computed<SectionKey>(() => {
  const key = String(route.params.key ?? "profile");
  return (SETTINGS_SECTIONS as readonly string[]).includes(key)
    ? (key as SectionKey)
    : "profile";
});
watch(
  () => route.params.key,
  (key) => {
    if (key && !(SETTINGS_SECTIONS as readonly string[]).includes(String(key))) {
      void router.replace("/settings/profile");
    }
  },
  { immediate: true },
);

function openSection(key: SectionKey) {
  void router.push({ name: "settings-section", params: { key } });
}

/** 只有"上一跳仍在设置分区里"才显示/响应返回；从主窗口刚打开时 back 指向别处。 */
const canGoBack = ref(false);
function syncBackState() {
  const back = (window.history.state as { back?: string | null } | null)?.back ?? "";
  canGoBack.value =
    typeof back === "string" &&
    (back.includes("#/settings/") || back.includes("/settings/"));
}
function goBackSection() {
  if (canGoBack.value) router.back();
  else void router.replace({ name: "settings-section", params: { key: "profile" } });
}
const removeAfterEach = router.afterEach(syncBackState);
onUnmounted(removeAfterEach);
syncBackState();

/** 各分区按需加载：恢复默认等改动后 bump 令牌触发重载（与 SettingsPanel 同一套语义）。 */
const reloadToken = ref(0);
const devDiagOpen = ref(false);

/** 导航项：图标 + 文案。`icon` 用组件引用，避免在模板里写一长串 v-if。 */
/**
 * 导航项按 **iOS 设置的概念**排序（2026-09-12 用户反馈「分类不合理」后重排）：
 * 个人资料 → 通用 → 通知 → 外观 → 网络与连接 → 文件与共享 → 存储 → 隐私与安全 → 关于 → 重置。
 *
 * ⚠️ 教训：导航项的**标签必须与它打开的分区内容一致**。此前 `general` 这一项
 * 写着「通知」，点开却是「语言 + 通知 + 共享目录」—— 用户看到"通知里第一项是语言、
 * 第三项是共享目录"，这就是分类错误。现在每一项只放它字面意思里的东西：
 *   · 通用（iOS「通用」）＝ 语言与地区；
 *   · 通知（iOS「通知」）＝ 允许通知 + 显示预览（消息正文）；
 *   · 文件与共享 ＝ 接收文件目录 + 共享目录（都是"文件放哪儿/给谁看"）；
 *   · 外观 ＝ 显示模式 + 主题色 + 字体（**不含通知**：通知是上面独立的一项。
 *     用户 2026-09-21：「桌面版的外观和通知里只有外观啊，为啥叫外观和通知」——
 *     根因是这一项复用了**移动端分组**的标签 `settings.group.appearance`（那个分组里
 *     真的装着「外观 / 聊天气泡 / 通知」三条，所以名字是对的），桌面端该用条目名「外观」）。
 *
 * ⚠️ 「关于」与「重置」必须**分成两项**（用户 2026-09-21：「桌面版的关于和重置里没有重置」）：
 *   此前这一项叫「关于与重置」，点开却只有 `AboutSection`（iOS 把「还原」放「通用」里的做法
 *   被搬到了这里）—— 标签说"与重置"、内容里没有重置，正是上面那条教训的翻版。
 *   现在标签也用**条目名**（`settings.item.about` / `settings.group.reset`，与移动端列表同一批键），
 *   与各自分区内的第一组标题一一对应（`settingsStructure` 守卫钉住）。
 *
 * 2026-10-23 用户要求桌面收敛为 4 类；上面的 10 类描述是历史教训，不再描述当前导航。
 */
const navItems = computed<{ key: SectionKey; label: string; icon: unknown }[]>(() => [
  { key: "general", label: t("settings.group.general"), icon: SlidersHorizontal },
  { key: "network", label: t("settings.group.networkFiles"), icon: Wifi },
  { key: "security", label: t("settings.group.security"), icon: Lock },
  { key: "about", label: t("settings.item.about"), icon: Info },
]);

/** 4 个顶层容器；旧的 10 个深链键仍有效，只是映射到对应容器。 */
const desktopSection = computed<"general" | "network" | "security" | "about">(() => {
  switch (section.value) {
    case "network":
    case "files":
      return "network";
    case "security":
      return "security";
    case "about":
      return "about";
    default:
      return "general";
  }
});

/**
 * 侧边栏升级按钮的一次性导航键：主窗口写入，本窗口 mount/focus 时消费。
 * 只传一个导航意图。⚠️「不跨 WebView 共享 updater 状态」这句在 B5 之后**不再成立**：
 * 导航仍然只传意图，但更新**状态**现在由后端统一持有（`updater_status` / `updater-status`），
 * 两个窗口看到的是同一份事实。
 */
const SETTINGS_SECTION_KEY = "gosslan:settings-section";
function consumePendingSection() {
  const key = storageGet(SETTINGS_SECTION_KEY);
  if (!key) return;
  storageRemove(SETTINGS_SECTION_KEY);
  if (!(SETTINGS_SECTIONS as readonly string[]).includes(key)) return;
  void router.push({ name: "settings-section", params: { key } });
  if (key === "about" && updater.state.phase === "idle") void updater.check(true);
}
onMounted(() => {
  // B5：本窗口的 UI 服务与新开窗口是两份，而下载任务在后端是**全局单例** ⇒
  // 先按后端那份补一次（相位/已下字节/总字节/目标版本），否则重开设置会看到"检查更新"，
  // 而后台其实还在下。`restore` 只在本窗口仍是 idle 时生效，不会盖掉本窗口更细的进度。
  void api
    .updaterStatus()
    .then((st) => updater.restore(st))
    .catch(() => {
      /* 移动端/命令不可用：保持 idle，界面照旧只有"检查更新" */
    });
  consumePendingSection();
  window.addEventListener("focus", consumePendingSection);
});
onUnmounted(() => window.removeEventListener("focus", consumePendingSection));

/**
 * Esc 关闭设置窗口（桌面惯例）。
 * 标题栏上有关闭键（自绘 chrome），但设置页是一个"看两眼就走"的页面，
 * Esc 是用户预期存在的最短路径。失败（非 Tauri 环境）时静默忽略。
 */
function onKeydown(e: KeyboardEvent) {
  // 分区历史返回：Alt+← / ⌘[ / Ctrl+[。与主窗口同一套返回语义。
  const mod = e.metaKey || e.ctrlKey;
  if ((e.altKey && e.key === "ArrowLeft") || (mod && e.key === "[")) {
    e.preventDefault();
    goBackSection();
    return;
  }
  if (e.key !== "Escape") return;
  // 有弹层（如清除数据二次确认）时先让弹层处理，避免一层 Esc 连窗口一起关掉。
  if (document.querySelector("[role='dialog']")) return;
  void api.closeSettingsWindow().catch(() => {});
}
useEventListener(window, "keydown", onKeydown);
</script>

<template>
  <!-- 自绘标题栏 + 内容（`AuxWindowShell` 与群任务窗口共用，标题栏与主窗口同一套：
       `decorations:false` 之后顶部 caption 与内容同底色，不再有系统标题栏那条接缝）。 -->
  <AuxWindowShell :title="t('settings.title')">
  <div class="flex min-h-0 flex-1 overflow-hidden bg-[var(--gosslan-bg)]">
    <!-- 左：窄导航。
         间距刻意**左右对称**（`px-2` + 项内 `px-2.5`）：用户 2026-09-12 反馈
         「右边的箭头两边都不够对称」——参考图里那一列的对齐问题就出在
         左内边距与右侧留白/箭头位置不匹配。这里导航项为纯文字+图标（无展开箭头），
         一旦将来加展开子项，用同一个 `pr-2.5` 承接箭头即可保持对称。 -->
    <nav class="flex w-[176px] shrink-0 flex-col gap-0.5 border-r border-[var(--gosslan-divider)] bg-[var(--gosslan-panel)] px-2 py-3">
      <!-- 桌面 4 类导航不需要可见返回；⌘[ / Alt+← 键盘返回仍保留。 -->
      <button
        v-for="item in navItems"
        :key="item.key"
        class="tap-safe flex h-8 w-full items-center gap-2 rounded-[var(--gosslan-radius-md)] px-2.5 text-left text-body transition"
        :aria-current="desktopSection === item.key ? 'true' : undefined"
        :class="desktopSection === item.key
          ? 'bg-[var(--gosslan-list-active)] font-medium text-[var(--gosslan-text)]'
          : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]'"
        @click="openSection(item.key)"
      >
        <component :is="item.icon" class="h-4 w-4 shrink-0" :stroke-width="1.9" />
        <span class="min-w-0 flex-1 truncate" :title="item.label">{{ item.label }}</span>
      </button>
    </nav>

    <!-- 右：内容区（独立滚动，切换导航不改变窗口尺寸） -->
    <div class="scrollbar-both min-w-0 flex-1 overflow-y-auto px-5 py-4">
      <Transition name="settings-swap" mode="out-in">
      <div :key="section">
      <div v-if="desktopSection === 'general'" class="space-y-5">
        <ProfileSection :active="true" :reload-token="reloadToken" />
        <GeneralSection />
        <AppearanceSection />
        <ChatStyleSection />
        <NotificationSection />
        <StorageSection :active="true" :reload-token="reloadToken" />
        <ResetSection @restored="reloadToken++" />
      </div>
      <div v-else-if="desktopSection === 'network'" class="space-y-5">
        <NetworkSection :active="true" :reload-token="reloadToken" />
        <FilesSection :active="true" :reload-token="reloadToken" />
      </div>
      <SecuritySection v-else-if="desktopSection === 'security'" />
      <div v-else-if="desktopSection === 'about'" class="space-y-5">
        <AboutSection @dev-open="devDiagOpen = true" />
      </div>
      </div>
      </Transition>
    </div>
  </div>

  <!-- 开发者诊断面板（隐藏入口：连续点击设备指纹 7 次） -->
  <DevDiagPanel :open="devDiagOpen" @close="devDiagOpen = false" />
  </AuxWindowShell>
</template>
