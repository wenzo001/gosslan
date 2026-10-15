<script setup lang="ts">
import { Dialog, DialogPanel, DialogTitle, TransitionChild, TransitionRoot } from "@headlessui/vue";
import { nextTick, watch } from "vue";
import { X } from "lucide-vue-next";
import { useBackLayer } from "@/composables/useBackLayer";
import BackArrow from "@/components/ui/BackArrow.vue";
import { useAppStore } from "@/stores/useAppStore";
import { t } from "@/i18n";

/**
 * 移动端软键盘适配：弹窗内容要给键盘**让位**。
 *
 * 用户实测：「弹出创建群聊界面时，默认点击输入框创建群名，输入框会遮挡部分创建群聊的面板」。
 * 原因是键盘补偿（`app.keyboardInset`）此前只加在聊天页的滚动容器上，**弹窗没有**。
 * 这里统一给弹窗的滚动容器加同样的下内边距 —— 弹窗里聚焦输入框时，
 * 浏览器会把输入框滚进可视区，而可视区高度已经扣掉了键盘，于是输入框不会再被挡住。
 * 放在 `BaseModal` 一处，所有弹窗（创建群聊/改名/转发/加好友/搜索…）一起生效。
 */
const app = useAppStore();

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    width?: string;
    /**
     * 移动端「整页」形态（iOS 标准：占满全屏、可上下滑动、不是卡片弹窗）。
     *
     * 为什么放在这里而不是每个调用方各写一套 `fixed inset-0`：整页浮层与卡片弹窗的
     * **语义完全一样**（模态、Esc/返回键关闭、焦点约束），差别只是外壳。外壳写在唯一
     * 一处，才能保证「移动端整页」都带上安全区、关闭按钮与滚动容器，不会各写各的。
     */
    fullscreen?: boolean;
  }>(),
  { width: "max-w-md", fullscreen: false },
);
const emit = defineEmits<{ (e: "close"): void }>();

/**
 * 关闭之后把焦点**还给打开它的那个元素**。
 *
 * 实测（`node scripts/check-ui-runtime.mjs --only=overlay`，2026-10-10）：Esc 或 ✕ 关完之后
 * 弹窗的 DOM 已经撤干净，但 `document.activeElement` 落在 `body` —— Headless UI 只管把焦点
 * **收进来**（焦点陷阱），不管**送回去**，而键盘用户关掉一个弹窗后指望落在原处。
 *
 * 归还的时机必须是 `@after-leave`，不能是 `open` 一变假就做：那时候 `Dialog` 还挂着，
 * 它自己的焦点陷阱（FocusSentinel）会把我们刚设的焦点抢回弹窗内部。`afterLeave` 是唯一
 * "内容真的已经卸载"的那一刻，所以再往后一个 `nextTick` 补这一下。
 *
 * 只在焦点确实掉到没人接（`body`）时才还 —— 别抢走用户已经点到别处的焦点。
 */
let openerElement: HTMLElement | null = null;
watch(
  () => props.open,
  (on) => {
    if (!on) return;
    const active = document.activeElement;
    openerElement = active instanceof HTMLElement && active !== document.body ? active : null;
  },
  { immediate: true },
);

function restoreFocusToOpener() {
  const back = openerElement;
  openerElement = null;
  if (!back || !document.body.contains(back)) return;
  nextTick(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    // preventScroll：归还焦点不该顺手把底下那页滚到触发元素那里去（约束 7「滚动位置错误」）。
    back.focus({ preventScroll: true });
  });
}

/**
 * 系统返回键 / 后退导航：先关最上面的弹窗，而不是**直接退出应用**
 * （Android 上没有这层绑定的话，用户在"添加好友"弹窗里按返回会退出整个应用）。
 * 见 `composables/useBackLayer.ts`。
 */
useBackLayer(
  () => props.open,
  () => emit("close"),
);
</script>

<template>
  <!-- ⚠️ z 序是本组件最容易改坏的一处：HeadlessUI 的 `Dialog` 会把自己挂到
       **`<body>` 下的 `#headlessui-portal-root`**（不是留在调用者的子树里，实测确认）。
       也就是说弹窗的 z-index 是在**文档根层级**上与别的浮层比大小 —— 而移动端的整页下钻页
       （设置 / 日志 / 收藏 / 链接 / 资料）是 `MobilePageFrame` 的 `fixed inset-0 z-[60]`。
       原先这里写 `z-50`：弹窗虽然挂进了 DOM，却被 z-[60] 的整页框架**盖在后面**，
       用户看到的就是"点了没反应、连弹窗都没出来"（用户 2026-09-21，移动端设置 → 重置与数据）。
       桌面端没有 z-[60] 的整页框架，所以只有移动端复现。

       `z-[65]` 是重新选的位置。应用现有阶梯：
         整页框架 `z-[60]` < **弹窗 `z-[65]`** < 右键菜单 `z-[70]`
         < 操作面板 / 图片预览 `z-[80]` < **自绘标题栏 `z-[85]`** < Toast `z-[90]`
       即：盖住一切页面（含移动端那些整页下钻页），但不挡右键菜单、弹层里的图片预览，
       也不挡 toast（失败提示必须能盖在弹窗上）。改这个值前先看这条阶梯。
       ⚠️ 85 那一格是 2026-09-30 加的（用户「所有独立窗口标题栏都不会被内容栏遮住，标题栏优先度最高」）：
       caption 上的 ✕/− 与整窗唯一拖拽区不许再被内容浮层压住。**新增浮层时层级请留在 80 及以下**，
       只有 Toast 允许在 85 之上 —— 这条由设计判据 ㉕（`src/utils/designGuards.test.ts`）从源码现算核对。

       `font-gosslan` 同理：弹窗挂在 portal root（应用根节点**之外**），拿不到根节点上的字体，
       用户选的字体对弹窗不生效 —— 带上这个类才与界面其余部分一致。
       主题色/暗色不受影响（那是 `:root`/`.dark` 上的 CSS 变量，本来就能继承）。 -->
  <TransitionRoot :show="open" as="template" @after-leave="restoreFocusToOpener">
    <Dialog as="div" class="relative z-[65] font-gosslan" @close="emit('close')">
      <!-- 整页形态不画遮罩：整页面板本身不透明，遮罩只会在滑入的过程里
           给「上一页」糊一层黑（观感成了 modal，而不是页面推进）。卡片形态才需要遮罩。 -->
      <TransitionChild
        v-if="!fullscreen"
        as="template"
        enter="duration-200 ease-out"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="duration-150 ease-in"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="glass fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)] bg-[var(--gosslan-overlay)]" aria-hidden="true" />
      </TransitionChild>
      <!-- ⚠️ 滚动层与遮罩都从 `var(--gosslan-window-safe-top)` 起算，不从视口 (0,0) 起算。
           桌面窗口是 `decorations(false)` + 自绘 caption（`TitleBar.vue`，流内元素），而本弹窗
           经 portal 挂到 `<body>` ⇒ 铺满视口时卡片顶部会钻到 caption 底下被压住（✕ 与标题一起
           被 caption 吃掉）。让开之后 Win/Linux 让 38px、macOS 让 28px（跟着
           `--gosslan-title-h` 的 `.platform-mac` 覆盖自动切），**移动端该变量为 0 ⇒ 零变化**。
           变量的定义与判据（`html:not(.is-mobile)`）见 `style.css` 的窗口显示安全区那一节。 -->
      <div
        class="fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)] overflow-y-auto overflow-x-hidden"
        :style="app.isMobile && app.keyboardInset > 0
          ? { paddingBottom: `${app.keyboardInset + 12}px` }
          : undefined"
      >
        <div
          :class="fullscreen
            ? 'flex min-h-full items-stretch justify-center'
            : 'flex min-h-full justify-center p-4'"
        >
          <!-- 整页形态：铺满 + 自带标题栏（含左上返回/关闭）与安全区；
               卡片形态：保持原有的居中卡片。
               ⚠️ 这条注释**必须在 `<TransitionChild>` 之外**：dev 构建会保留 HTML 注释，
               而 `as="template"` 的插槽里多出一个注释节点就会让 Headless UI 抛
               "Passing props on template!"（Vue 渲染直接炸 ⇒ 整个窗口卡死）。
               —— 整页形态按「一页」处理：与设置/日志/收藏等详情页**同一套 page-slide**
               （从右滑入 / 滑出），而不是卡片的淡入缩放。否则同样是整页下钻，
               群任务 / 搜索页的转场却和别的详情页不一样（用户 2026-09-20「群任务的转场好像不对」）。
               卡片形态垂直居中用 `my-auto`，⚠️ 不许改回 items-center —— 内容高于视口时 flex
               居中会让卡片顶部溢出到滚动容器之外（WebKit/Blink 经典坑），表现为「最下面能
               滚出来、头部一块永远被遮挡」（任务长详情实测，2026-10-12）；max-h + 内部滚动区
               保证再长的内容顶部也能完整滚到，标题栏始终钉住不滚走。 -->
          <TransitionChild
            as="template"
            :enter="fullscreen
              ? 'transition-[transform,opacity] duration-[var(--gosslan-duration)] ease-[var(--gosslan-ease)]'
              : 'duration-200 ease-out'"
            :enter-from="fullscreen ? 'translate-x-full opacity-40' : 'opacity-0 scale-95'"
            :enter-to="fullscreen ? 'translate-x-0 opacity-100' : 'opacity-100 scale-100'"
            :leave="fullscreen
              ? 'transition-[transform,opacity] duration-[var(--gosslan-duration)] ease-[var(--gosslan-ease)]'
              : 'duration-150 ease-in'"
            :leave-from="fullscreen ? 'translate-x-0 opacity-100' : 'opacity-100 scale-100'"
            :leave-to="fullscreen ? 'translate-x-full opacity-40' : 'opacity-0 scale-95'"
          >
            <DialogPanel
              v-if="fullscreen"
              class="flex h-full w-full flex-col bg-[var(--gosslan-app-bg)] pt-[env(safe-area-inset-top)] text-left text-[var(--gosslan-text)]"
            >
              <header
                class="flex shrink-0 items-center gap-2 border-b border-[var(--gosslan-divider)] bg-[var(--gosslan-panel)] px-3"
                :style="{ height: 'var(--gosslan-header-h)' }"
              >
                <button
                  class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
                  :title="t('common.back')" :aria-label="t('common.back')"
                  @click="emit('close')"
                >
                  <BackArrow />
                </button>
                <DialogTitle v-if="title" as="h2" class="text-[15px] font-medium">{{ title }}</DialogTitle>
              </header>
              <!-- 底部内距 = `max(安全区, 原本那 16px)`：面板根上只写了 `pt-[env(safe-area-inset-top)]`，
                   内容贴着屏幕底边 ⇒ iOS 上最后一行落在 Home Indicator 底下。写成 max() 是为了
                   **不丢原有的 p-4**（桌面 env()=0 时结果仍是 1rem，视觉零变化）；
                   同一个写法在 `ActionSheet.vue:53` 已经在用，不另立第三种。 -->
              <div class="flex min-h-0 flex-1 flex-col p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                <slot />
              </div>
            </DialogPanel>
            <DialogPanel
              v-else
              class="elevated my-auto flex max-h-[calc(100vh-var(--gosslan-window-safe-top)-2rem)] w-full flex-col rounded-[var(--gosslan-radius-xl)] bg-[var(--gosslan-panel)] p-5 text-left align-middle text-[var(--gosslan-text)]"
              :class="width"
            >
              <!-- ⚠️ 标题栏 `shrink-0` + 内容区 `min-h-0 flex-1` 是**一对**，缺一不可：
                   2026-10-12 用户实测「窗口大时卡片完整，窗口一缩小头部就被缩上去一些」。
                   根因是标题栏虽然写了 `shrink-0`，但卡片总高被 `max-h` 夹住时，
                   flex 仍会把**没写 shrink-0 的那一层**（原来这里是裸的标题 div）压扁；
                   而 `items-start` 让它表现为"标题被从上面切掉一截"。
                   现在：标题栏 `shrink-0`、内容区 `min-h-0 flex-1`（唯一可压缩项）、
                   滚动区自己消化溢出 ⇒ 窗口再矮，标题与 ✕ 也完整可见且可点。 -->
              <div v-if="title" class="mb-4 flex shrink-0 items-start justify-between gap-3">
                <DialogTitle as="h3" class="text-base font-semibold leading-6">
                  {{ title }}
                </DialogTitle>
                <button
                  class="tap-safe flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
                  :title="t('common.close')" :aria-label="t('common.close')"
                  @click="emit('close')"
                >
                  <X class="h-4 w-4" />
                </button>
              </div>
              <!-- 只有内容区滚：标题栏（含 ✕）始终钉在顶部，长内容从头部开始全部可达。
                   ⚠️ **滚动条留白必须从卡片自己的右内距里让出来，不能再加一层**
                   （2026-10-12 用户实测：「左右边距视觉上左边小、右边大，应该是一样的」）：
                   卡片是 `p-5`（左右各 20px）。若只在滚动区加一层 `pr-8px`，右侧总留白就变成
                   28px 而左侧仍是 20px ⇒ 正文明显偏左。所以这里给滚动区一个**负的右边距**
                   （`-mr-[var(--gosslan-scroll-gutter)]`），把它自己那 8px 从卡片的 20px 里"借"回来：
                   正文右边缘到卡片右边缘仍是 20px（其中 8px 供滚动条落脚、12px 净空隙），
                   与左侧 20px 对称。
                   macOS 是系统 overlay 滚动条（不占布局宽）⇒ 同样对称，只是那 8px 纯属呼吸感。 -->
              <div class="min-h-0 flex-1 overflow-y-auto pr-[var(--gosslan-scroll-gutter)] -mr-[var(--gosslan-scroll-gutter)]">
                <slot />
              </div>
              <!-- 固定页脚（可选插槽）：**在滚动区之外**，因此永远钉在卡片底部不随内容滚走。
                   为什么要有它（2026-10-12 用户实测：「中间可滚动的区域应该不包含下面操作按钮那块」）：
                   这里原先只有默认插槽 ⇒ 调用方把操作按钮写在内容的最后一项，它就跟着内容一起滚，
                   长内容时用户得先把记录滚到底才看得见「完成 / 编辑 / 删除」。
                   没有传这个插槽时**不渲染任何东西**（29 个既有调用方零变化）。
                   `mt-4` 与标题栏的 `mb-4` 对称；`shrink-0` 保证它不被上面的滚动区挤压。 -->
              <div
                v-if="$slots.footer"
                class="mt-4 shrink-0 pr-[var(--gosslan-scroll-gutter)] -mr-[var(--gosslan-scroll-gutter)]"
              >
                <slot name="footer" />
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
