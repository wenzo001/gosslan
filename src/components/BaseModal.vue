<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { nextTick, watch } from "vue";
import { X } from "@/components/ui/icons";
import { useBackLayer } from "@/composables/useBackLayer";
import BackArrow from "@/components/ui/BackArrow.vue";
import { useAppStore } from "@/stores/useAppStore";
import { t } from "@/i18n";

/**
 * 移动端软键盘适配：弹窗内容要给键盘**让位**。
 *
 * 用户实测：「弹出创建群聊界面时，默认点击输入框创建群聊，输入框会遮挡部分创建群聊的面板」。
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
    /** 是否注册 Android 返回层。路由驱动的模态传 false，由路由历史负责返回。 */
    backLayer?: boolean;
    /**
     * 整页形态由页面自己管滚动（看板/搜索结果这类内部已有独立滚动区）。
     * false 时保持旧行为：外层 DialogContent 兜底滚动。
     */
    contained?: boolean;
    /**
     * 标题是不是**用户内容**（群任务标题这类），是才允许原生选字。
     *
     * 默认 false 而不是全局打开：全局 `html { user-select: none }`（负责人 2026-10-26 的口径）
     * 靠"chrome 默认不可选、内容区显式开启"成立，而这里的标题现在绝大多数是 chrome 名字
     * （创建群聊 / 添加好友 / 转发…）。在共用组件里无条件加类 = 把全部弹窗标题一次开出去，
     * 正好是这套口径不想要的方向。所以由调用方按标题的性质点一下。
     */
    titleSelectable?: boolean;
  }>(),
  { width: "max-w-md", fullscreen: false, backLayer: true, contained: false, titleSelectable: false },
);
const emit = defineEmits<{ (e: "close"): void }>();

/**
 * 关闭之后把焦点**还给打开它的那个元素**。
 *
 * 实测（`node scripts/check-ui-runtime.mjs --only=overlay`，2026-10-10）：Esc 或 ✕ 关完之后
 * 弹窗的 DOM 已经撤干净，但 `document.activeElement` 落在 `body` —— Headless UI 只管把焦点
 * **收进来**（焦点陷阱），不管**送回去**，而键盘用户关掉一个弹窗后指望落在原处。
 *
 * Reka UI 的 FocusScope 会在内容卸载后抛 `closeAutoFocus`；在这里 `preventDefault()`
 * 再手动还给 opener。时机必须在**卸载之后**，否则焦点陷阱会把刚设的焦点抢回弹窗内部。
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

function onCloseAutoFocus(event: Event) {
  const back = openerElement;
  openerElement = null;
  if (!back || !document.body.contains(back)) return;
  event.preventDefault();
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
// 路由驱动的模态（如 /search）已经在路由历史里有一层；再压一条会变成"返回两次"。
if (props.backLayer) {
  useBackLayer(
    () => props.open,
    () => emit("close"),
  );
}

/** Reka 的 `update:open`：Esc / 点遮罩 / 关闭按钮都汇到这里；受控 `open` 由父级翻。 */
function onOpenChange(value: boolean) {
  if (!value) emit("close");
}
</script>

<template>
  <!-- ⚠️ z 序是本组件最容易改坏的一处：Reka UI 的 `DialogPortal` 会把内容挂到
       **`<body>` 下**（不是留在调用者的子树里）。也就是说弹窗的 z-index 是在**文档根层级**
       上与别的浮层比大小 —— 而移动端的整页下钻页（设置 / 日志 / 收藏 / 链接 / 资料）
       是 `MobilePageFrame` 的 `fixed inset-0 z-[60]`。
       应用现有阶梯：
         整页框架 `z-[60]` < 遮罩 `z-[64]` < **弹窗 `z-[65]`** < 右键菜单 `z-[70]`
         < 操作面板 / 图片预览 `z-[80]` < **自绘标题栏 `z-[85]`** < Toast `z-[90]`
       即：盖住一切页面（含移动端那些整页下钻页），但不挡右键菜单、弹层里的图片预览，
       也不挡 toast（失败提示必须能盖在弹窗上）。改这个值前先看这条阶梯。
       ⚠️ 85 那一格是 2026-09-30 加的（用户「所有独立窗口标题栏都不会被内容栏遮住，标题栏优先度最高」）：
       caption 上的 ✕/− 与整窗唯一拖拽区不许再被内容浮层压住。**新增浮层时层级请留在 80 及以下**，
       只有 Toast 允许在 85 之上 —— 这条由设计判据 ㉕（`src/utils/designGuards.test.ts`）从源码现算核对。

       `font-gosslan` 同理：弹窗挂在 body（应用根节点**之外**），拿不到根节点上的字体，
       用户选的字体对弹窗不生效 —— 带上这个类才与界面其余部分一致。
       主题色/暗色不受影响（那是 `:root`/`.dark` 上的 CSS 变量，本来就能继承）。 -->
  <DialogRoot :open="open" :modal="true" @update:open="onOpenChange">
    <DialogPortal>
      <!-- 整页形态不画遮罩：整页面板本身不透明，遮罩只会在滑入的过程里
           给「上一页」糊一层黑（观感成了 modal，而不是页面推进）。卡片形态才需要遮罩。 -->
      <DialogOverlay
        v-if="!fullscreen"
        class="gosslan-dialog-overlay fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)] z-[64] bg-[var(--gosslan-overlay)]"
        aria-hidden="true"
      />
      <!-- ⚠️ 滚动层与遮罩都从 `var(--gosslan-window-safe-top)` 起算，不从视口 (0,0) 起算。
           桌面窗口是 `decorations(false)` + 自绘 caption（`TitleBar.vue`，流内元素），而本弹窗
           经 portal 挂到 `<body>` ⇒ 铺满视口时卡片顶部会钻到 caption 底下被压住（✕ 与标题一起
           被 caption 吃掉）。让开之后 Win/Linux 让 38px、macOS 让 28px（跟着
           `--gosslan-title-h` 的 `.platform-mac` 覆盖自动切），**移动端该变量为 0 ⇒ 零变化**。
           变量的定义与判据（`html:not(.is-mobile)`）见 `style.css` 的窗口显示安全区那一节。
           2026-10-20 补：**卡片形态**读的是合并后的 `--gosslan-safe-top`（桌面=caption、移动端=
           刘海/状态栏），因为移动端那枚 window 变量是 0，卡片只剩 `p-4` 那 16px，正被状态区压住
           （用户实测）。整屏面板里那句自己加的 `pt-[env(safe-area-inset-top)]` 同时删掉——外壳已经
           让开了，两层都让就是**双计**（那半句顶部内距的类名不再逐字写在这里 —— 判据按代码文本读，
           注释里留一份字面引文只会让下一个人分不清"还有没有人写"）。而遮罩**故意**继续读 window 那一枚：
           遮罩是压暗背景用的，移动端要让刘海区也落在暗层底下，读合并值反而会在状态栏下留一条没压暗的缝。
           ⚠️ 动画类挂在 `DialogContent` 自己身上：Reka 的 Presence 只观察这个元素，
           挂在里面的 panel 上会让关闭动画在卸载时被截断。 -->
      <DialogContent
        class="fixed inset-x-0 bottom-0 top-[var(--gosslan-safe-top)] z-[65] font-gosslan focus:outline-none"
        :class="fullscreen
          ? 'gosslan-dialog-page ' + (contained ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden')
          : 'gosslan-dialog-card'"
        :style="app.isMobile && app.keyboardInset > 0
          ? { paddingBottom: `${app.keyboardInset + 12}px` }
          : undefined"
        @close-auto-focus="onCloseAutoFocus"
      >
        <!-- 卡片形态的内容根铺满视口，但它只是**居中容器**：空白区必须让点击穿到遮罩
             （Reka 的 outside-click 按"点击目标在不在 DialogContent 里"判）。Reka 会给这层
             写内联 pointer-events:auto，类名压不过 ⇒ 由 style.css 的 `.gosslan-dialog-card`
             用 !important 关掉命中、再由 `.elevated` 恢复。没有这一对，整块屏幕都算"里面"，
             点遮罩永远关不掉（2026-10-18 探针实测）。全屏形态铺满是对的，不需要穿透。 -->
        <div
          :class="fullscreen
            ? (contained ? 'flex h-full items-stretch justify-center' : 'flex min-h-full items-stretch justify-center')
            : 'flex min-h-full justify-center p-4 pb-[max(env(safe-area-inset-bottom),1rem)]'"
        >
          <div
            v-if="fullscreen"
            class="flex h-full w-full flex-col bg-[var(--gosslan-app-bg)] text-left text-[var(--gosslan-text)]"
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
              <DialogTitle v-if="title" as="h2" class="min-w-0 flex-1 truncate text-title font-medium" :class="titleSelectable ? 'gosslan-selectable' : ''" :title="title">{{ title }}</DialogTitle>
              <!-- Reka 要求每份 DialogContent 都有可访问名称；整页形态允许不传 title，
                   这里补一个只给读屏的兜底，避免 aria-labelledby 指向不存在的节点。 -->
              <DialogTitle v-if="!title" class="sr-only">{{ t("common.dialog") }}</DialogTitle>
            </header>
            <!-- 底部内距 = `max(安全区, 原本那 16px)`：面板根上只写了 `pt-[env(safe-area-inset-top)]`，
                 内容贴着屏幕底边 ⇒ iOS 上最后一行落在 Home Indicator 底下。写成 max() 是为了
                 **不丢原有的 p-4**（桌面 env()=0 时结果仍是 1rem，视觉零变化）；
                 同一个写法在 `ActionSheet.vue:53` 已经在用，不另立第三种。 -->
            <div class="flex min-h-0 flex-1 flex-col p-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
              <slot />
            </div>
          </div>
          <div
            v-else
            class="elevated pointer-events-auto my-auto flex max-h-[calc(100vh-var(--gosslan-safe-top)-2rem)] w-full flex-col rounded-[var(--gosslan-radius-xl)] bg-[var(--gosslan-panel)] p-5 text-left align-middle text-[var(--gosslan-text)]"
            :class="width"
            :style="app.isMobile && app.keyboardInset > 0
              ? { maxHeight: `calc(100vh - var(--gosslan-safe-top) - ${app.keyboardInset + 12}px - 2rem)` }
              : undefined"
          >
            <!-- ⚠️ 标题栏 `shrink-0` + 内容区 `min-h-0 flex-1` 是**一对**，缺一不可：
                 2026-10-12 用户实测「窗口大时卡片完整，窗口一缩小头部就被缩上去一些」。
                 根因是标题栏虽然写了 `shrink-0`，但卡片总高被 `max-h` 夹住时，
                 flex 仍会把**没写 shrink-0 的那一层**压扁；而 `items-start` 让它表现为
                 "标题被从上面切掉一截"。现在：标题栏 `shrink-0`、内容区 `min-h-0 flex-1`
                 （唯一可压缩项）、滚动区自己消化溢出 ⇒ 窗口再矮，标题与 ✕ 也完整可见且可点。 -->
            <DialogTitle v-if="!title" class="sr-only">{{ t("common.dialog") }}</DialogTitle>
            <div v-if="title" class="mb-4 flex shrink-0 items-start justify-between gap-3">
              <!-- 标题最多两行，超长（尤其是一长串没有空格的字符）强制断词 + 省略：
                   用户 2026-10-25 实测群任务标题把弹窗撑出屏幕边缘。`break-words`
                   让 `overflow-wrap: break-word` 对无空格长串也生效；全码在 hover 的
                   `title` 里仍能看到。 -->
              <DialogTitle
                as="h3"
                class="line-clamp-2 min-w-0 flex-1 break-words text-base font-semibold leading-6"
                :class="titleSelectable ? 'gosslan-selectable' : ''"
                :title="title"
              >
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
            <!-- 固定头部（可选插槽）：**不参与下面滚动区的滚动**。给「预览/摘要固定、
                 只滚选项列表」这类弹窗用（默认没有这个插槽 ⇒ 29 个既有调用方零变化）。 -->
            <div v-if="$slots.header" class="mb-3 shrink-0">
              <slot name="header" />
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
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
