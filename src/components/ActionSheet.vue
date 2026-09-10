<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from "@headlessui/vue";

/**
 * 移动端底部操作面板（Action Sheet，iOS HIG）。
 *
 * 用于「多操作选择」场景（如长按消息 → 复制/引用/转发），与居中 Modal（二元确认）区分：
 * HIG 里破坏性**确认**（是/否）用 Alert（居中），**多操作选择**用 Action Sheet（底部）。
 * 桌面端右键菜单保持原样，本组件只在触屏语境使用。
 */
defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog as="div" class="relative z-[80]" @close="emit('close')">
      <TransitionChild
        as="template"
        enter="duration-200 ease-out"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="duration-150 ease-in"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-black/40" aria-hidden="true" @click="emit('close')" />
      </TransitionChild>

      <div class="fixed inset-x-0 bottom-0">
        <TransitionChild
          as="template"
          enter="duration-200 ease-out"
          enter-from="translate-y-full"
          enter-to="translate-y-0"
          leave="duration-150 ease-in"
          leave-from="translate-y-0"
          leave-to="translate-y-full"
        >
          <DialogPanel
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
              <slot name="cancel">取消</slot>
            </button>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
