<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import { isMac } from "@/utils/platform";
import { isSelectableTextTarget } from "@/utils/textSelection";
import ResponsiveLayout from "@/layouts/ResponsiveLayout.vue";
import TaskCenter from "@/components/TaskCenter.vue";

/**
 * 首屏就绪之后再过这么久才去预热辅助窗口。
 *
 * 不是为了"好看"：app-ready 那一刻首帧正在渲染、网络与发现正在启动，这时候建 WebView
 * 会把用户第一眼的那一下拖慢，正好与预热的目的相反。1.2s 是"首屏已经稳住、用户还没
 * 点到第一张图"的那个窗口。
 */
const AUX_PREWARM_DELAY_MS = 1200;

/**
 * 主窗口根组件。
 *
 * ⚠️ 这里**只**管主窗口。独立「设置」/「运行日志」窗口各有自己的 HTML 与入口
 * （`settings.html` → `src/entries/settings.ts`、`logs.html` → `src/entries/logs.ts`），
 * 不再由本组件按窗口 label 分支渲染。
 *
 * 为什么改掉旧做法（用户 2026-09-12 实测：「第二次打开设置，窗口会先刷成主聊天窗口，
 * 然后立马变成设置界面」）：旧模板是
 * `<LogViewer v-if="isLogs" /><SettingsWindow v-else-if="isSettings && ready" /><ResponsiveLayout v-else />`
 * —— `settings && !ready` 这段窗口期会落到 `v-else`，也就是**把整棵聊天布局挂起来**，
 * 于是每次开设置都要白等一整棵聊天组件树，还会先显示聊天界面。现在这个分支根本不存在了。
 */
const app = useAppStore();
const chat = useChatStore();

/** macOS 窗口圆角：必须在 WebView 加载完成后设（wry 此时才用 parent_view 替换 contentView，
 *  setup 阶段设会被替换丢失），并让窗口背景色跟随主题（消除暗色下圆角外露浅色的"白角"）。 */
async function applyWindowShape() {
  if (isMac && !app.isMobile) {
    await api.applyMacosWindowShape(app.dark).catch(() => {});
  }
}

/**
 * 上报「应用是否在前台且窗口聚焦」给后端（用户 2026-09-13 的功耗策略）。
 *
 * 后端蓝牙扫描据此在快/慢节奏间切换（前台 5s、后台/失焦 30s，见 `network/ble.rs`），
 * 并在从后台切回前台时**立刻补扫一轮**，而不是等完当前慢周期。
 *
 * 判定：
 *   · 页面不可见（后台 / 最小化 / 关闭到托盘后隐藏）⇒ 降频；
 *   · 桌面端窗口失焦（用户点了别的窗口）⇒ 也降频（用户明确要求）；
 *   · 移动端**不看 focus / blur**：软键盘弹出、系统弹框都会触发 blur，
 *     那会把"用户正在用"误判成后台。
 * 「APP 被杀死 ⇒ 直接关掉」不需要前端上报：进程没了，后端的扫描任务自然不存在。
 */
function reportActivity() {
  const active = !document.hidden && (app.isMobile || document.hasFocus());
  void api.setAppActive(active).catch(() => {});
}

/**
 * 屏蔽 WebView 默认右键菜单（返回 / 刷新 / 另存为等），改为应用自定义交互：
 * 有功能的元素自行绑定右键菜单（见 MessageItem 的复制菜单），无功能的区域右键无效果。
 *
 * ⚠️ 例外（用户 2026-09-13 / 2026-10-23）：
 *  ① 有非空选区时放行系统菜单 —— 非消息区域（设置、输入框）里的选区复制仍走原生菜单。
 *     消息内容区的右键由 `MessageItem` 自己接管（桌面弹自定义菜单、移动端让位系统选字），
 *     它会在需要时 stopPropagation，不会走到这里。
 *  ② **触屏落在可选正文上**也必须放行：系统原生选字/复制工具条依赖 contextmenu 的默认行为，
 *     不能因为"选区还没建立"的那一帧被这条全局兜底吃掉。
 * 其余情况维持原来的屏蔽。
 */
function suppressContextMenu(e: MouseEvent) {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
  if (app.isMobile && isSelectableTextTarget(e.target)) return;
  e.preventDefault();
}

/*
 * 这四条挂法交给 VueUse：`useEventListener` 在**组件作用域**上注册并自动解绑。
 * 原来是 `onMounted` 里四行手写 add —— 一句 add 配一句 remove 这件事每个组件都要
 * 自己记一遍，而 `contextmenu` 那半甚至写成匿名函数（**摘不掉**：没有句柄可传，
 * HMR 换掉本组件时上一轮的回调会一直留在 window 上）。前台/焦点这半是
 * 「蓝牙扫描节奏」的输入（后端自适应，见 reportActivity），多挂一份就多打一次 IPC。
 */
useEventListener(window, "contextmenu", suppressContextMenu);
useEventListener(document, "visibilitychange", reportActivity);
useEventListener(window, "focus", reportActivity);
useEventListener(window, "blur", reportActivity);

onMounted(async () => {
  try {
    // `app.init()`：只读偏好/设备/网卡（两个窗口都要）。
    // `chat.init()`：会话、好友、网络事件监听 —— **只在主窗口**跑，
    // 在独立窗口重复初始化会注册第二份监听并重复触发后端动作。
    //
    // 两者各自兜底（2026-09-23 审计 1.6）：app.init 失败（如 settings IPC 抖动）
    // 不得跳过 chat.init —— 那会让主窗口**永远收不到任何事件**（"活着但功能全死"，
    // 需重启恢复）；chat.init 失败也要留痕而不是静默吞进 unhandled rejection。
    try {
      await app.init();
    } catch (e) {
      console.error("[app] app.init 失败（偏好/设备可能未加载，继续启动）", e);
    }
    try {
      await chat.init();
    } catch (e) {
      console.error("[app] chat.init 失败", e);
    }
  } finally {
    // 真实数据就绪 → 让首屏骨架淡出（index.html 内联骨架，由 src/boot/boot.ts 撤除）。
    // 放在 finally：init 失败也要撤，否则骨架会一直挡在界面上。
    window.dispatchEvent(new Event("gosslan:app-ready"));
    // 桌面端**预热**那扇全局唯一的预览窗口（用户 2026-09-24："启动的时候后台异步把高频窗口
    // 的 WebView 开销开好，用的时候秒开"）。放在 app-ready 之后并再延后一拍：首屏渲染与
    // 网络启动正在抢 CPU/IO，这时去建 WebView 会把用户第一眼的那一下拖慢 —— 与本条目的
    // 目的正好相反。失败不提示：最坏结果只是"第一次点图仍然慢一点"。
    if (!app.isMobile) {
      window.setTimeout(() => {
        void api.prewarmAuxWindows().catch(() => {});
      }, AUX_PREWARM_DELAY_MS);
    }
  }
  // init 之后再报一次：此时 `app.isMobile` 才是真实值（移动端不判 focus/blur）
  reportActivity();
  await applyWindowShape();
});

// 主题切换（浅/深/跟随系统变化）时同步窗口背景色，保持圆角外与内容同色。
watch(() => app.dark, () => void applyWindowShape());
</script>

<template>
  <ResponsiveLayout />
  <!--
    全局后台任务入口挂在主窗口壳上，而不是某个会话里：D-18 的问题正是
    「切到别的会话就看不到还在传的文件」。它自己判断有没有活可干，
    没有未完成的任务时什么都不渲染。
  -->
  <TaskCenter />
</template>
