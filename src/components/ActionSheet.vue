<script setup lang="ts">
import { t } from "@/i18n";
import { useReducedMotion } from "@/utils/motion";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, ref, watch } from "vue";

/**
 * 移动端底部操作面板（Action Sheet，iOS HIG）。
 *
 * 用于「多操作选择」场景（如长按消息 → 复制/引用/转发），与居中 Modal（二元确认）区分：
 * HIG 里破坏性**确认**（是/否）用 Alert（居中），**多操作选择**用 Action Sheet（底部）。
 * 桌面端右键菜单保持原样，本组件只在触屏语境使用。
 *
 * 底层焦点陷阱、Esc、点外部关闭与 `aria-modal` 由 Reka UI 的 Dialog 原语负责；
 * 本组件只保留 Gosslan 的外观、「点一项即收起」这条业务行为，与 §14.9 的下拉关闭手势。
 */
const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

function onOpenChange(value: boolean) {
  if (!value) emit("close");
}

/**
 * 与其它浮层共用同一套展开权（10-22 审计 D-21）：表情面板、右键/长按菜单、已读成员弹层
 * 这些都走 `utils/popupRegistry`，此前这个面板不在名单里 —— 表情面板开着时长按一条消息，
 * 面板盖上去，收起面板后那个表情面板还"以为自己开着"。
 *
 * 下面的 `isActive` 反向收起是**协议要求**（`composables/useExclusivePopup` 的自述，
 * 也由 `designGuards` 那条「每个 claim 都必须 watch isActive」的判据钉着）：
 * 展开权被别人抢走时，本面板必须自己收起，不能仗着"我是模态"赖在上面。
 */
const popup = useExclusivePopup("action-sheet");
watch(
  () => props.open,
  (v) => {
    if (v) popup.claim();
    else popup.release();
  },
  { immediate: true },
);
watch(popup.isActive, (mine) => {
  if (!mine && props.open) emit("close");
});

/* ---------------- 下拉关闭（设计文档 §14.9） ----------------
   跟手下拉超过阈值即关闭，没到就回弹；回弹 ≤220ms，reduce 档即时。
   位移打在**内层卡片**上，外层 `DialogContent` 的 sheet 进出动画仍由 Reka Presence 驱动，
   两层不互相覆盖；关闭时不清零位移，否则退出动画开始前会先看见一次回弹「跳」回去。
   抓取区只做指针便利并 `aria-hidden`：键盘用户走 Esc / 取消按钮（与面板级 `@click`
   是同一条取舍，见模板里那段注释）。 */
const reduce = useReducedMotion();
const card = ref<HTMLElement | null>(null);
const dragY = ref(0);
const rebounding = ref(false);
let dragging = false;
let startY = 0;
let lastY = 0;
let lastT = 0;
let velocity = 0;
// 拖过就不再把它当一次点击：否则回弹落定后紧跟的 click 会被面板级 @click 收掉，
// 表现为「我没想关，手一滑它就自己关了」。阈值 4px 以下不算拖（纯手指抖动）。
let dragged = false;

const CLOSE_DISTANCE = 96;
const CLOSE_VELOCITY = 0.6; // px/ms：向上快甩也当关闭

const cardStyle = computed(() => ({
  transform: dragY.value !== 0 ? `translateY(${dragY.value}px)` : undefined,
  // 拖拽期间必须无过渡，否则跟手感被 CSS 插值吃掉（iOS 也是这样：drag 时不设 animation）
  transition: rebounding.value
    ? reduce.value
      ? "none"
      : "transform 200ms var(--gosslan-ease)"
    : "none",
}));

function onDragStart(e: PointerEvent) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  dragging = true;
  dragged = false;
  rebounding.value = false;
  startY = e.clientY;
  lastY = e.clientY;
  lastT = e.timeStamp;
  velocity = 0;
  // 捕获在**挂处理器的那个元素**上：捕获会把事件重定向到捕获元素，捕在祖先上就再也回不到这里。
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onDragMove(e: PointerEvent) {
  if (!dragging) return;
  const dy = e.clientY - startY;
  // 向下跟手 1:1，向上只走 20% 行程（橡皮筋，够到边界就发不上力）
  dragY.value = dy < 0 ? dy * 0.2 : dy;
  const dt = Math.max(1, e.timeStamp - lastT);
  velocity = (e.clientY - lastY) / dt;
  lastY = e.clientY;
  lastT = e.timeStamp;
  if (Math.abs(dy) > 4) dragged = true;
}

function onDragEnd() {
  if (!dragging) return;
  dragging = false;
  if (dragY.value >= CLOSE_DISTANCE || (velocity >= CLOSE_VELOCITY && dragY.value > 12)) {
    emit("close");
    return;
  }
  rebounding.value = true;
  dragY.value = 0;
}

// 位移在**下一次打开**时复位，不在关闭时复位（关闭时 Presence 还在播退出动画）。
watch(
  () => props.open,
  (v) => {
    if (v) {
      dragY.value = 0;
      rebounding.value = false;
      dragged = false;
    }
  },
);

function onContentClick() {
  if (dragged) {
    dragged = false;
    return;
  }
  emit("close");
}
</script>

<template>
  <DialogRoot :open="open" :modal="true" @update:open="onOpenChange">
    <DialogPortal>
      <DialogOverlay
        class="gosslan-dialog-overlay fixed inset-0 z-[79] bg-[var(--gosslan-overlay)]"
        aria-hidden="true"
      />
      <!-- 面板里**任何一项**点完都要收起（成熟产品的通行行为：iOS ActionSheet / 微信 /
           Telegram 的底部菜单都是"点一项即消失"）。用户 2026-09-13 安卓实测：
           「点『引用』这个 sheet 应该自动隐藏；点『转发』也应该自动隐藏，因为它会跳转到
           界面内去操作聊天」—— 不在这一层统一收，就得每个入口各写一遍（漏一个就挂在那儿
           挡着跳转后的界面）。按钮自己的 `@click` 先跑，这里再收面板（Vue 事件冒泡），
           所以动作本身不受影响；取消按钮那句 `emit('close')` 于是成了幂等的第二次调用。
           挂在 DialogContent（组件根）而不是里面的 div 上：这层是**指针便利**，不是一颗
           可聚焦的按钮（键盘用户走 Esc / 取消按钮）；原生 div 上挂动作型 @click 会被
           设计判据 ⑥ 判成"键盘够不着"。 -->
      <DialogContent
        class="gosslan-dialog-sheet fixed inset-x-0 bottom-0 z-[80] font-gosslan focus:outline-none"
        @click="onContentClick"
      >
        <!-- DialogTitle 是 Reka 的可访问名称来源；本面板的标题是可选装饰文案，
             没有标题时用通用「操作」占位，读屏仍能报出这个对话框是什么。 -->
        <DialogTitle class="sr-only">{{ title || t("common.actions") }}</DialogTitle>
        <div
          ref="card"
          :style="cardStyle"
          class="rounded-t-[var(--gosslan-radius-xl)] bg-[var(--gosslan-panel)] px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-2xl"
        >
          <!-- 抓取区：grabber + 标题行。`touch-none` 必须有 —— 不关掉浏览器手势，
               下拉会被当成滚动/橡皮筋overscroll，pointermove 根本发不到这里。
               aria-hidden：这是**指针便利**，不是可聚焦控件（键盘走 Esc / 取消按钮），
               与下面面板级 @click 是同一条取舍。 -->
          <div
            class="-mx-2 -mt-2 cursor-grab touch-none select-none px-2 pb-1 pt-4"
            aria-hidden="true"
            @pointerdown="onDragStart"
            @pointermove="onDragMove"
            @pointerup="onDragEnd"
            @pointercancel="onDragEnd"
          >
            <div
              class="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--gosslan-border)]"
            />
            <p v-if="title" class="px-3 pb-2 text-center text-xs text-[var(--gosslan-text-2)]">
              {{ title }}
            </p>
          </div>
          <slot />
          <button
            class="mt-2 w-full rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] py-3 text-center text-title font-medium text-[var(--gosslan-text)] transition active:opacity-70"
            @click="emit('close')"
          >
            <slot name="cancel">{{ t("common.cancel") }}</slot>
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
