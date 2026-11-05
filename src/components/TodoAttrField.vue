<script setup lang="ts">
/**
 * 任务属性三件套（关联时间 / 类型 / 标签）共用的外壳。
 *
 * 用户 2026-11-05 要求三者「收进同一套控件」：同样的标签排布（字段名一行、控件独占下一行）、
 * 同高度（`h-10`）、同圆角（`--gosslan-radius-md`）、同一个弹出面板（`.gosslan-menu` +
 * 固定 280px 宽；阴影/行高都由 `.gosslan-menu` / `.gosslan-menu-item` 统一提供）。
 *
 * 这里只负责「标签 + 触发器 + 面板」这三段结构，具体显示/交互由三个子组件各给一份：
 * `TodoAttrDateField`（自绘日历）、`TodoAttrTypeField`（类型下拉）、`TodoAttrTagsField`（多选标签）。
 * 不再各写一套高度与面板 —— 这正是用户报「日期面板和标签下拉长得不一样」的根因。
 */
import { ref, watch } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";

const props = defineProps<{
  /** 字段名（如「任务标签」）。 */
  label: string;
  /** 字段名右侧的补充说明（可不给）。 */
  hint?: string;
  /** 无权限修改：只渲染 `readonly` 插槽，不给触发器与面板。 */
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: "open-change", open: boolean): void }>();

const open = ref(false);
watch(
  () => props.disabled,
  (v) => {
    if (v) open.value = false;
  },
);
// 面板开合对外广播：日期字段要借此把日历光标拉回当前值所在的月份。
watch(open, (v) => emit("open-change", v));
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-baseline justify-between gap-2">
      <span class="text-xs text-[var(--gosslan-text-2)]">{{ label }}</span>
      <span
        v-if="hint"
        class="min-w-0 truncate text-caption text-[var(--gosslan-text-2)]"
        :title="hint"
      >{{ hint }}</span>
    </div>
    <div class="relative">
      <PopoverRoot v-if="!disabled" :open="open" :modal="false" @update:open="open = $event">
        <PopoverTrigger as-child>
          <slot name="trigger" />
        </PopoverTrigger>
        <PopoverPortal>
          <!-- 面板尺寸/圆角/阴影/行高全部来自 `.gosslan-menu`：日期日历与标签下拉用的是**同一块**壳。 -->
          <PopoverContent
            align="start"
            :side-offset="4"
            :collision-padding="8"
            class="gosslan-menu frost z-[80] w-[280px]"
          >
            <slot name="panel" :close="() => (open = false)" />
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <slot v-else name="readonly" />
    </div>
  </div>
</template>
