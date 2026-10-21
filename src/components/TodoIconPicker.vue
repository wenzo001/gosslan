<script setup lang="ts">
/**
 * 自定义类型的图标选择器（用户 2026-10-14：「任务类型自定义是可以自己输入，自定义类型名称，图标」）。
 *
 * ## 为什么抽成一个组件
 * 这条编辑器有**两个入口**：看板里的"新建/编辑任务"草稿，与详情弹窗里的类型那一格。
 * 写成两份就会重演本仓那一族问题 —— 改了一处、另一处的选项或行为静默不一致
 * （同一判据两个家 ⇒ 少一个条件）。这里只有一份按钮组、一份键盘/aria 语义。
 *
 * ## 为什么是"真按钮 + aria-pressed"而不是一排 div
 * 与 `TodoPickField.vue` 同一个理由：这仓的弹窗里靠 Tab 走焦点，`div @click` 键盘到不了；
 * 而"当前选中的是哪一枚"必须能被辅助技术读出来（`aria-pressed` + 每枚的中文名，
 * 文案键由 `todoCustomIcons.test.ts` 双向对账，少一枚就报红）。
 *
 * ## 不许在这里判"能不能改"
 * 权限由调用方（`may_change_todo` 那一族）算完传 `disabled`，本组件只管选与不选。
 */
import { TODO_CUSTOM_ICONS, type TodoCustomIcon } from "@/utils/todos";
import { TODO_CUSTOM_ICON_COMPONENTS, TODO_CUSTOM_ICON_LABEL_KEY } from "@/utils/todoCustomIcons";
import { t as translate } from "@/i18n";

const props = defineProps<{
  /** 当前选中的图标键（一定是白名单内的键，解析端保证）。 */
  modelValue: TodoCustomIcon;
  /** 无权限改：只画当前那一枚，不给按钮（与 `TodoPickField` 同一口径）。 */
  disabled?: boolean;
  /** 给整组的一个可读名称（两个入口的语境不同：草稿 vs 详情）。 */
  ariaLabel?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: TodoCustomIcon): void }>();

function pick(key: TodoCustomIcon) {
  if (props.disabled || key === props.modelValue) return;
  emit("update:modelValue", key);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1">
    <span class="mr-0.5 text-caption text-[var(--gosslan-text-2)]">{{ translate("todo.pickIcon") }}</span>
    <!-- 无权限时只回显当前那一枚：给一排按不动的按钮会让人以为是自己点坏了 -->
    <template v-if="props.disabled">
      <component
        :is="TODO_CUSTOM_ICON_COMPONENTS[props.modelValue]"
        class="h-4 w-4 text-[var(--gosslan-primary)]"
        :aria-label="translate(TODO_CUSTOM_ICON_LABEL_KEY[props.modelValue])"
        :title="translate(TODO_CUSTOM_ICON_LABEL_KEY[props.modelValue])"
      />
    </template>
    <div v-else class="flex flex-wrap gap-1" role="group" :aria-label="ariaLabel ?? translate('todo.pickIcon')">
      <button
        v-for="key in TODO_CUSTOM_ICONS"
        :key="key"
        type="button"
        class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-md)] border transition"
        :class="
          key === props.modelValue
            ? 'border-[var(--gosslan-primary)] text-[var(--gosslan-accent-ink)] bg-[var(--gosslan-hover)]'
            : 'border-[var(--gosslan-border)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'
        "
        :aria-pressed="key === props.modelValue"
        :aria-label="translate(TODO_CUSTOM_ICON_LABEL_KEY[key])"
        :title="translate(TODO_CUSTOM_ICON_LABEL_KEY[key])"
        @click="pick(key)"
      >
        <component :is="TODO_CUSTOM_ICON_COMPONENTS[key]" class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
