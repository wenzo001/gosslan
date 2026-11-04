<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { useAuxWindowFailureReport } from "@/composables/useAuxWindowFailureReport";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api } from "@/api";
import { t } from "@/i18n";
import { isMac } from "@/utils/platform";
import { isSelectableTextTarget } from "@/utils/textSelection";
import { copyText, formatCrashReport, shouldShowCrashNotice } from "@/utils/crashReport";
import { inflightOps, inflightSnapshot, lastOpLabel } from "@/utils/ipcTracker";
import {
  decideStall,
  shouldLogLongTask,
  UI_STALL_SNOOZE_MS,
  type StallView,
} from "@/utils/uiStall";
import { createStallWatch, type StallWatch } from "@/utils/stallWatch";
import CrashNotice from "@/components/CrashNotice.vue";
import HangNotice from "@/components/HangNotice.vue";
import RecoveryNotice from "@/components/RecoveryNotice.vue";
import type { UiRecoveryNotice } from "@/api";
import VersionMismatchNotice from "@/components/VersionMismatchNotice.vue";
import ResponsiveLayout from "@/layouts/ResponsiveLayout.vue";
import TaskCenter from "@/components/TaskCenter.vue";
import { version } from "../package.json";
import { detectVersionMismatch, type VersionMismatch } from "@/utils/versionGuard";

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
const reportAuxFailure = useAuxWindowFailureReport();
const chat = useChatStore();

// ---------------- 崩溃横幅 / 卡顿提示 / 主窗口心跳 ----------------
const crashDismissed = ref(false);
/** 前端构建版本与后端 `APP_VERSION` 不一致（只在正式构建里检查）。 */
const versionMismatch = ref<VersionMismatch | null>(null);
/** 只有 panic / 异常终止 / 启动被中止才提示；正常退出与首次运行不打扰。 */
const crashReport = computed(() => {
  const r = app.previousExit;
  return r && !crashDismissed.value && shouldShowCrashNotice(r.kind) ? r : null;
});
const stall = ref<StallView | null>(null);
/**
 * 渲染层自愈的结局横幅（后端的 `UI_RENDERER_RECOVERED` / "建议重启"）。
 * 取走时机：每秒心跳的返回值（搭顺车，不新增轮询）。
 */
const recovery = ref<UiRecoveryNotice | null>(null);
let stallSnoozeUntil = 0;
/**
 * 卡顿计时的"活动时钟"（`utils/stallWatch.ts`）。
 *
 * 窗口隐藏时停表并把隐藏时长从判定时钟里扣掉，恢复时立即补一拍 —— 判定逻辑与阈值
 * （`decideStall` / `UI_STALL_BANNER_MS`）原样不动，改的只是"什么时候计时"。
 */
let stallWatch: StallWatch | null = null;
let visibilityHandler: (() => void) | null = null;
let heartbeatTimer: number | undefined;
let heartbeatTick: (() => void) | null = null;
let lastHeartbeatActive = true;
let longTaskObserver: PerformanceObserver | null = null;
let lastLongTaskLogAt = performance.now();

/**
 * 本机验证用的**一次性**心跳冻结注入（仅开发构建）。
 *
 * `?freeze_hb_once=60000` ⇒ 本次页面在前 60s 内不发心跳（模拟渲染层主线程冻住）。
 * 用 `sessionStorage` 记"已注入过"：自愈 reload 之后同一会话不会再冻结，
 * 于是能观察到 `UI_RENDERER_RECOVERED` 而不是"reload 后又被冻住"的死循环。
 * 返回冻结到期时刻（ms，`performance.now()` 口径）；未注入返回 0。
 *
 * 生产构建里 `import.meta.env.DEV` 为 false ⇒ 整个函数被摇树掉，不会成为可被滥用的后门。
 */
function freezeHeartbeatOnceUntil(): number {
  if (!import.meta.env.DEV) return 0;
  let ms = 0;
  try {
    const params = new URLSearchParams(location.search);
    const raw = params.get("freeze_hb_once");
    ms = raw ? Math.min(Math.max(Number.parseInt(raw, 10) || 0, 1_000), 120_000) : 0;
    if (!ms) return 0;
    // 把注入参数从地址栏摘掉：`reload` 打的是**当前 URL** ⇒ 自愈 reload 之后不会再冻住。
    // 不用 sessionStorage 记"已注入"：生产码里只有 `utils/safeStorage` 允许摸存储
    // （designGuards ㊾ 会拦直连），而这个注入本来就是 dev-only。
    params.delete("freeze_hb_once");
    const qs = params.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
  } catch {
    // 改不动地址（极端 WebView）：最坏情况是 reload 后又被冻住一次，属可接受偏差。
    return 0;
  }
  console.warn(`[dev] 心跳冻结注入：${ms}ms（?freeze_hb_once）`);
  return performance.now() + ms;
}

function startWatchdogTimers() {
  stallWatch = createStallWatch({
    tick: () => {
      const w = stallWatch;
      if (!w) return;
      // 两端都换算到活动时钟：`startedAt` 是原始墙钟，不换算会被历史隐藏时长拖成负数。
      const ops = inflightOps().map((op) => ({ ...op, startedAt: w.activeSince(op.startedAt) }));
      stall.value = decideStall(ops, w.now(), stallSnoozeUntil);
    },
  });
  // 先对齐可见性再起表：挂载时若已隐藏，`start()` 是 no-op，等恢复时再起。
  stallWatch.setHidden(document.hidden);
  stallWatch.start();
  const frozenUntil = freezeHeartbeatOnceUntil();
  // 心跳只在**主窗口**发；隐藏后先补发一条 active=false，再暂停（省 IPC）。
  heartbeatTick = () => {
    // 注入窗口内一条都不发：后端看到的形状与"渲染层主线程冻住"一致。
    if (frozenUntil && performance.now() < frozenUntil) return;
    const active = !document.hidden;
    if (!active && !lastHeartbeatActive) return;
    lastHeartbeatActive = active;
    const snap = inflightSnapshot();
    void api
      .uiHeartbeat(active ? lastOpLabel() : null, active, snap.count, snap.oldestMs)
      .then((notice) => {
        // 自愈结局搭心跳的顺车送回来（取走即清空）；有就挂横幅。
        if (notice) recovery.value = notice;
      })
      .catch(() => {});
  };
  heartbeatTimer = window.setInterval(heartbeatTick, 1000);
  // 一个 visibilitychange 处理器同时驱动两件事：stall 停/起表 + 心跳补发。
  // 用稳定句柄（不是匿名函数）才能在 `stopWatchdogTimers` 里摘干净。
  visibilityHandler = () => {
    stallWatch?.setHidden(document.hidden);
    heartbeatTick?.();
  };
  document.addEventListener("visibilitychange", visibilityHandler);
  startLongTaskObserver();
  heartbeatTick();
}

/**
 * 浏览器 long task（>2s）取证：只报一行 `code=SLOW_OP`，不改变任何交互。
 * WebView2 不支持 `longtask` 时静默跳过；同一窗口 5s 内最多一条，避免刷屏。
 */
function startLongTaskObserver() {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (!shouldLogLongTask(entry.duration, now, lastLongTaskLogAt)) continue;
        lastLongTaskLogAt = now;
        void api
          .reportFrontendSlowOp(`longtask:${entry.name || "unknown"}`, Math.round(entry.duration))
          .catch(() => {});
        break;
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

function stopWatchdogTimers() {
  stallWatch?.stop();
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  longTaskObserver?.disconnect();
  stallWatch = null;
  visibilityHandler = null;
  heartbeatTimer = undefined;
  heartbeatTick = null;
  longTaskObserver = null;
}

async function copyCrashReport() {
  const r = app.previousExit;
  if (!r) return;
  const ok = await copyText(formatCrashReport(r));
  app.toast(ok ? t("crash.copied") : t("crash.copyFailed"), ok ? "success" : "error");
}

function openCrashLogs() {
  // 以前是 `.catch(() => {})`：日志窗口建不出来时点了完全没反应。
  void api.openLogWindow().catch((e) => reportAuxFailure(e, t("common.operationFail")));
}

function restartApp() {
  void api.restartApp().catch(() => {});
}

/**
 * 启动对账：前端打包版本 vs 后端 `APP_VERSION`。
 *
 * 只在正式构建里做（开发时 Vite 用磁盘前端、Cargo 用工作区版本，二者短暂不同是正常的，
 * 不能误报）。拿不到任一侧版本就不提示（判据见 `utils/versionGuard.ts`）。
 * 真的不一致时给出“完全退出后重新打开 / 立即重启”，重启走既有 `restart_app`。
 */
async function checkAppVersion() {
  if (!import.meta.env.PROD || app.isMobile) return;
  try {
    const backend = await api.getAppVersion();
    versionMismatch.value = detectVersionMismatch(version, backend);
  } catch (e) {
    // 对账本身失败不是版本错配：只留控制台，不打扰用户。
    console.error("[app] 版本对账失败（不提示）", e);
  }
}

function reEnableBluetoothFromNotice() {
  crashDismissed.value = true;
  void app
    .setChannelEnabled("bluetooth", true)
    .catch((e) => app.toastError(e, t("settings.network.toast.btFail")));
}

function waitMore() {
  // 静默窗口也走活动时钟：隐藏期间不该把 snooze 余额吃掉。
  stallSnoozeUntil = (stallWatch ? stallWatch.now() : performance.now()) + UI_STALL_SNOOZE_MS;
  stall.value = null;
}

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
  // 先起表：init 一旦卡住，卡顿提示与后端心跳都要已经在线（否则"卡在启动"永远看不见）。
  startWatchdogTimers();
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
  void checkAppVersion();
});

// 主题切换（浅/深/跟随系统变化）时同步窗口背景色，保持圆角外与内容同色。
watch(() => app.dark, () => void applyWindowShape());

onUnmounted(stopWatchdogTimers);
</script>

<template>
  <RecoveryNotice
    v-if="recovery"
    :kind="recovery.kind"
    :mobile="app.isMobile"
    @restart="restartApp"
    @dismiss="recovery = null"
  />
  <CrashNotice
    v-if="crashReport"
    :report="crashReport"
    :mobile="app.isMobile"
    @copy="copyCrashReport"
    @open-logs="openCrashLogs"
    @restart="restartApp"
    @re-enable-ble="reEnableBluetoothFromNotice"
    @dismiss="crashDismissed = true"
  />
  <HangNotice
    v-if="stall"
    :label="stall.label"
    :seconds="stall.seconds"
    :escalated="stall.escalated"
    :mobile="app.isMobile"
    @wait="waitMore"
    @restart="restartApp"
  />
  <VersionMismatchNotice
    v-if="versionMismatch"
    :mismatch="versionMismatch"
    :mobile="app.isMobile"
    @restart="restartApp"
  />
  <ResponsiveLayout />
  <!--
    全局后台任务入口挂在主窗口壳上，而不是某个会话里：D-18 的问题正是
    「切到别的会话就看不到还在传的文件」。它自己判断有没有活可干，
    没有未完成的任务时什么都不渲染。
  -->
  <TaskCenter />
</template>
