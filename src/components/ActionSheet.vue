<script setup lang="ts">
import { t } from "@/i18n";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";

/**
 * 移动端底部操作面板（Action Sheet，iOS HIG）。
 *
 * 用于「多操作选择」场景（如长按消息 → 复制/引用/转发），与居中 Modal（二元确认）区分：
 * HIG 里破坏性**确认**（是/否）用 Alert（居中），**多操作选择**用 Action Sheet（底部）。
 * 桌面端右键菜单保持原样，本组件只在触屏语境使用。
 *
 * 底层焦点陷阱、Esc、点外部关闭与 `aria-modal` 由 Reka UI 的 Dialog 原语负责；
 * 本组件只保留 Gosslan 的外观与「点一项即收起」这条业务行为。
 */
defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

function onOpenChange(value: boolean) {
  if (!value) emit("close");
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
        @click="emit('close')"
      >
        <!-- DialogTitle 是 Reka 的可访问名称来源；本面板的标题是可选装饰文案，
             没有标题时用通用「操作」占位，读屏仍能报出这个对话框是什么。 -->
        <DialogTitle class="sr-only">{{ title || t("common.actions") }}</DialogTitle>
        <div
          class="rounded-t-[var(--gosslan-radius-xl)] bg-[var(--gosslan-panel)] px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-2xl"
        >
          <div
            class="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--gosslan-border)]"
            aria-hidden="true"
          />
          <p v-if="title" class="px-3 pb-2 text-center text-xs text-[var(--gosslan-text-2)]">
            {{ title }}
          </p>
          <slot />
          <button
            class="mt-2 w-full rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] py-3 text-center text-[15px] font-medium text-[var(--gosslan-text)] transition active:opacity-70"
            @click="emit('close')"
          >
            <slot name="cancel">{{ t("common.cancel") }}</slot>
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
