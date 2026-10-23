<script setup lang="ts">
/**
 * 自绘标题栏（caption）—— **主窗口与所有「应用自己的」辅助窗口共用这一份**。
 *
 * 为什么共用（用户 2026-09-17：「新窗口好像用的是系统的样式？标题栏和整体窗口的背景颜色有
 * 明显的界限，没有融合」）：窗口一律 `decorations:false`，顶部那条 caption 由前端画，
 * 底色就能与内容连成一体；系统标题栏的底色我们改不了，必然出现一条接缝。
 *
 * 差异全部靠 props 表达（不再读 store —— 辅助窗口的入口也要能 import 它）：
 * - `title`：辅助窗口显示**功能名**（设置/运行日志/群名 · 群任务）；主窗口不传 = 纯拖拽条；
 * - `showMaximize` / `showMinimize`：小窗口不给最大化（OS 层也设了 `.maximizable(false)`）；
 * - `isMobile`：移动端不画这条（由调用方传入，避免共享组件反向依赖 app store）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/api";
import { X } from "@/components/ui/icons";
import { isMac } from "@/utils/platform";
import { t } from "@/i18n";
import { createInitScope } from "@/utils/initScope";

const props = withDefaults(
  defineProps<{
    /** 功能名（辅助窗口传；主窗口不传 ⇒ 纯拖拽条）。 */
    title?: string;
    /** 是否渲染「最大化/还原」（Win/Linux 按钮 + macOS 绿灯）。小窗口传 false。 */
    showMaximize?: boolean;
    /** 是否渲染「最小化」。 */
    showMinimize?: boolean;
    /** 移动端不渲染标题栏。 */
    isMobile?: boolean;
    /** 关闭键的语义：主窗口 = 关闭到托盘（默认）；辅助窗口传 false = 真的关闭本窗口。 */
    closeToTray?: boolean;
  }>(),
  { title: "", showMaximize: true, showMinimize: true, isMobile: false, closeToTray: true },
);

const maximized = ref(false);

/**
 * 「这一扇窗口顶部有自绘 caption」由**画它的人**宣布 —— CSS 的 `--gosslan-window-safe-top`
 * 挂在这个类上，整屏浮层（图片预览遮罩、`BaseModal` 的遮罩与滚动层）据此决定顶边。
 *
 * 为什么这里要写全局类，而不是让 CSS 自己判（2026-10-20 实测到的缺陷）：caption 画不画由
 * 本组件的 `isMobile` **prop** 决定，而 prop 是宿主给的 —— 主窗传 `app.isMobile`，
 * 辅助窗的宿主（`AuxWindowShell`、`LogViewer`）**不传**（默认 false ⇒ 永远画）。
 * 于是「桌面但窄」的辅助窗（`resolveMobileLayout` 的宽度兜底 ≤767px 也算移动布局；
 * 日志窗默认就是 760×560）**画着 caption，却按布局档被 CSS 判成"没有 caption"**：
 * 顶边算成 0，预览遮罩连右上角工具条一起压进标题栏那条底下。
 * ⇒ 同一个事实不许有两处各判一次；写的人就是画的人。
 */
watch(
  () => props.isMobile,
  (mobile) => document.documentElement.classList.toggle("has-caption", !mobile),
  { immediate: true },
);
onBeforeUnmount(() => document.documentElement.classList.remove("has-caption"));

async function refreshMaximized() {
  if (!props.showMaximize) return; // 不可最大化 ⇒ 不必问（也避开无意义的 IPC）
  try {
    maximized.value = await api.windowIsMaximized();
  } catch {
    maximized.value = false; // 移动端 / 命令不可用时忽略
  }
}

async function toggleMaximize() {
  if (!props.showMaximize) return;
  try {
    maximized.value = await api.windowToggleMaximize();
  } catch {
    /* 忽略 */
  }
}

/**
 * 窗口是否聚焦（macOS 红绿灯的**失焦变灰**是原生行为）。
 *
 * 用户 2026-09-12 反馈：「mac 自己写的三个关闭按钮，和原生的关闭按钮的样式好像不太一样，
 * 还有大小。」最明显的差异就是这条：原生在窗口失焦时把整组变成**中性灰**（不带红黄绿、
 * 也不显示符号），而我们自绘的一直是彩色的 —— 一旦主窗口与设置窗口并排（设置窗口聚焦、
 * 主窗口失焦），两套摆在一起就明显不像。
 */
// 焦点与尺寸两条 Tauri 订阅的卸载句柄都交给同一个 scope：`listen()` 要等一次 IPC 往返才拿到
// 卸载函数，而这段时间里组件可能已经卸载 —— 直接赋给局部变量就等于**永远没人调用它**。
const listenerScope = createInitScope();

/** 双击判定的时间窗：与系统默认 DoubleClickTime 同量级，取保守的 400ms。 */
const CAPTION_DOUBLE_PRESS_MS = 400;
/** 上一次 caption 按下 / 翻折缩放的时刻（`performance.now()`）。 */
let lastCaptionPressAt = 0;
let lastCaptionToggleAt = 0;

/** 第二下按下时已经翻过一次 ⇒ 紧随其后的 `dblclick` 不许再翻。 */
function captionJustToggledByPress() {
  return performance.now() - lastCaptionToggleAt < CAPTION_DOUBLE_PRESS_MS;
}

/**
 * 双击标题栏 → 缩放（**两个桌面平台同一条路**，能力判断交给后端）。
 *
 * ⚠️ 这一格原先是 `if (props.isMobile || !isMac || !props.showMaximize) return;`，注释写的理由是
 * 「Windows 由 tao 的拖拽区原生处理双击最大化」—— **那个前提是假的**，三条证据一起指着它：
 *  · `data-tauri-drag-region` 全仓只出现在下面那条拖拽注释里，模板从来没写过这个属性；
 *  · tao 0.35.3 没有任何 `WM_NCLBUTTONDBLCLK` 处理，wry 0.55.1 的 Windows 侧也没有 drag-region 扩展；
 *  · 本应用所有窗口都是 `decorations: false`（caption 由前端自绘），Windows 上根本没有系统标题栏。
 * ⇒ 症状就是用户 2026-10-14 真机报的「Mac 双击能放大缩小，Windows 不行」。
 *
 * 现在两平台都走**与绿灯同一个出口** `toggleMaximize()` → 后端 `window_toggle_maximize`，
 * 「这扇窗能不能最大化」仍由后端那份 `MAXIMIZABLE_WINDOWS` 白名单判（小窗口点了也是 no-op），
 * 前端不拿平台当闸门 —— 与 `refreshMaximized` 那条"别把能力判断写回前端"的口径一致。
 *
 * ⚠️ 但**只接 `dblclick` 在 Windows 上可能根本不来**（这是同一格里没写完的第二半）：caption 的
 * `mousedown` 会调 `startDragging()`，而 tao 在 Windows 上把它落成 `ReleaseCapture()` +
 * `WM_NCLBUTTONDOWN/HTCAPTION` ⇒ 主线程进 Win32 的**模态移动循环**，那一次 `mouseup` 由系统消费掉，
 * WebView 收不到 up 就合成不出 click，`dblclick` 也就永远不会派发（`detail` 同理不可信）。
 * ⇒ 缩放另有一条**只按 `mousedown` 时间差判定**的通路（见 `onDragStart`），它不依赖 click 计数。
 * 这条 `dblclick` 通路保留（macOS 今天就走它，行为不变），两者用 `lastCaptionToggleAt` 去重：
 * **一次双击只翻一次**（翻两次＝放大又还原，界面上看就是"点了没反应"）。
 */
function onTitlebarDblClick() {
  if (props.isMobile || !props.showMaximize) return;
  if (captionJustToggledByPress()) return;
  lastCaptionToggleAt = performance.now();
  void toggleMaximize();
}

/**
 * 手动拖拽兜底（Windows 主方案，macOS 也能用）。
 *
 * Tauri v2 Windows WebView2 上 `data-tauri-drag-region` 有已知缺陷：
 * 原生实现只在 drag-region 最顶部几像素响应拖拽，下半部分不触发。
 * 改为监听 mousedown 显式调 `startDragging()`，绕开 WebView2 的 bug。
 * macOS 上手动实现和原生等价，统一用这一套减少平台分叉。
 *
 * 按钮用 `data-no-drag-region` + `@mousedown.stop` 阻止冒泡到这里。
 *
 * ⚠️ **第二下不起拖拽**：双击的两下之间没有位移，本该判成"缩放"而不是"移动窗口"。这一条同时修掉
 * 两个毛病 —— ① 缩放不依赖浏览器合成 `dblclick`（上面说了，Windows 上那个 up 会被 OS 吃掉）；
 * ② 双击时窗口不再被第二下拖走一下（原生标题栏也不会）。判定只用 `mousedown` 的时刻差，
 * 所以 click 计数/detail 是不是可信都无所谓。**不许在这里加平台分支**（这一格踩过那一次）。
 */
function onDragStart(e: MouseEvent) {
  if (props.isMobile) return;
  if (e.button !== 0) return; // 只响应左键
  const now = performance.now();
  const secondPress = now - lastCaptionPressAt < CAPTION_DOUBLE_PRESS_MS;
  lastCaptionPressAt = now;
  if (secondPress && props.showMaximize) {
    lastCaptionToggleAt = now;
    void toggleMaximize();
    return;
  }
  try {
    void getCurrentWindow().startDragging();
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

/**
 * Ctrl+W 关闭窗口（仅 Windows/Linux）：与标题栏「×」一致。
 *
 * macOS **不在这里处理**：自绘标题栏 + `decorations:false` 下本无系统 ⌘W，
 * 现已由 src-tauri/src/menu.rs 补回原生「窗口 → 关闭」菜单（`decorate_aux_window` / lib.rs
 * 亦恢复了 NSWindow 的 `Closable` 位），交给系统处理即可，避免前端兜底与原生菜单双触发。
 */
function onKeydown(e: KeyboardEvent) {
  if (props.isMobile) return;
  if (isMac) return;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
    e.preventDefault();
    void api.windowClose();
  }
}

// 窗口级快捷键：挂载即终身、无条件摘挂 ⇒ 交给库（组件作用域自动解绑）。
useEventListener(window, "keydown", onKeydown);
onMounted(() => {
  refreshMaximized();
  // 最大化状态跟踪：尺寸变化时把按钮字形刷成"还原"。
  //
  // 只靠 onMounted 问一次是不够的——按钮是用户点的，点了就变，不监听就永远是初始字形
  // （用户 2026-10-12：「点了最大化，图标没有变成还原的样子」）。
  // 窗口尺寸变化（用户拖角、跨屏、进/出全屏）都会触发 onResized。
  // macOS 的三颗键/全屏状态由 AppKit 自己维护（用户 2026-10-23 改原生），这里不再跟踪。
  void (async () => {
    try {
      const w = getCurrentWindow();
      listenerScope.onDispose(
        await w.onResized(() => {
          void refreshMaximized();
        }),
      );
    } catch {
      /* 忽略：非 Tauri 环境 */
    }
  })();
});
onBeforeUnmount(() => {
  listenerScope.dispose();
});
</script>

<template>
  <!-- 顶部 caption（桌面端）：横贯整窗，作为窗口拖拽区 + 窗口控制按钮 + 功能名。
       整条浅灰，与下方三列的 rail/chat 浅灰连成一体（list 白底除外）。
       辅助窗口只多一个功能名（`title`），其余与主窗口完全同一套。
       ⚠️ `z-[85]`：**这一条不许被任何内容浮层盖住**（用户 2026-09-30 实测「图片预览独立窗口
       会遮住头部标题栏关闭最小化那块，应该只在下面内容区」，并要求「所有独立窗口标题栏都不会
       被内容栏遮住，标题栏优先度最高」）。根因是浮层全都 `Teleport` 到 `<body>`（`fixed` +
       `z-[60..80]`），而本条原先既无 `position` 也无 `z-index` ⇒ 按绘制顺序**任何定位元素都压在
       它上面**，于是 ✕/−/拖拽区看不见也点不着（辅助窗那条 caption 是整扇窗唯一的拖拽区）。
       85 落在既有阶梯的哪一格见 `BaseModal.vue` 里那条阶梯；选它而不是更高：只有 Toast（`z-[90]`、
       `pointer-events-none`）允许浮在 caption 上，因为失败提示被压住就等于没有反馈。
       层级由设计判据 ㉕ 从源码现算核对，不靠这里的数字被人记住。 -->
  <div
    v-if="!isMobile"
    class="relative z-[85] flex shrink-0 select-none items-center bg-[var(--gosslan-caption)]"
    data-caption
    :class="isMac ? 'justify-start pl-0' : 'justify-end'"
    :style="{ height: 'var(--gosslan-title-h)' }"
    @mousedown="onDragStart"
    @dblclick="onTitlebarDblClick"
  >
    <!-- macOS：三颗键**交给系统**（用户 2026-10-23：「用原生的，不要自己实现，每个窗口统一」）。
         后端 `macos_window::use_native_titlebar` 把窗口改成「透明标题栏 + 全尺寸内容」，
         AppKit 自己画红绿灯、自己在失焦时变灰、自己做悬停符号 —— 这里只让出它们占的宽度。
         宽度 78px = 系统 13px 左边距 + 三颗 12px + 两个 8px 间距 + 右边余量；
         之前的自绘实现已删除（保留形状会与系统按钮叠在一起）。 -->
    <div v-if="isMac" class="h-full w-[78px] shrink-0" aria-hidden="true"></div>

    <!-- 功能名：辅助窗口传 `title`；主窗口不传 ⇒ 退到应用显示名（用户 2026-10-23：
         改名后在桌面标题栏也看得见），Win/Linux 的按钮仍被 flex-1 推到最右。
         拖拽区本身不接收点击，这里是纯文字，不影响拖拽。 -->
    <div
      class="min-w-0 flex-1 truncate px-3 text-body font-medium text-[var(--gosslan-text-2)]"
      :title="title || t('app.name')"
    >
      {{ title || t("app.name") }}
    </div>

    <!-- Windows/Linux：右侧三键（顶到窗口最右缘）。
         字形按 **Windows 11 Fluent** 的细线造型自绘（10×10 视觉盒、1px 线）——
         lucide 的 `Maximize2` 是双箭头、`Minus` 偏粗，与系统窗口按钮明显不像
         （用户 2026-09-17：「最大化和最小化的图标和系统长得不太一样」）。
         ⚠️ 这三个按钮**不要加圆角**：外框容器（窗口根节点）是圆角 + overflow-hidden，关闭键右上角
         由它裁——两者曲线重合，hover 底与窗口边界严丝合缝。若给按钮自己加 border-radius（试过 8px），
         按钮的圆角曲线与窗口边界曲线不重合，中间会夹出一条浅色月牙缝（看起来"没贴合"）。
         同理只加圆角不加宽度补偿也不行：那会让 hover 底与窗口边缘脱开。
         原生 Windows 的窗口按钮 hover 也是整块矩形、由窗口圆角裁切。 -->
    <div v-if="!isMac" class="flex h-full items-stretch">
      <button data-no-drag-region @mousedown.stop
        v-if="showMinimize"
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        :title="t('window.minimize')" :aria-label="t('window.minimize')"
        @click="api.windowMinimize()"
      >
        <svg viewBox="0 0 10 10" class="h-[10px] w-[10px]" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M0.5 5h9" data-win-glyph="minimize" />
        </svg>
      </button>
      <button data-no-drag-region @mousedown.stop
        v-if="showMaximize"
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
        :title="maximized ? t('window.restore') : t('window.maximize')" :aria-label="maximized ? t('window.restore') : t('window.maximize')"
        @click="toggleMaximize"
      >
        <svg viewBox="0 0 10 10" class="h-[10px] w-[10px]" fill="none" stroke="currentColor" stroke-width="1">
          <!-- 最大化 = 一个方框；还原 = 前后两个错位方框（系统同款造型） -->
          <rect
            v-if="!maximized"
            x="0.75" y="0.75" width="8.5" height="8.5"
            data-win-glyph="maximize"
          />
          <template v-else>
            <path d="M3.25 0.75h6v6" data-win-glyph="restore-back" />
            <rect x="0.75" y="2.75" width="6.5" height="6.5" data-win-glyph="restore" />
          </template>
        </svg>
      </button>
      <button data-no-drag-region @mousedown.stop
        class="flex w-11 items-center justify-center text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-danger)] hover:text-white"
        :title="closeToTray ? t('window.closeToTray') : t('window.close')"
        :aria-label="closeToTray ? t('window.closeToTray') : t('window.close')"
        @click="api.windowClose()"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
