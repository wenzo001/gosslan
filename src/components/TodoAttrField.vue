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
import { nextTick, ref, watch } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { POPOVER_EDGE } from "@/utils/popoverBounds";

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

/**
 * 打开时把**已选项**滚进可见区（2026-11-07）。
 *
 * 面板现在统一限高 + 内部滚动（`.gosslan-menu` 读 Reka 的 available-height），
 * 候选一多，第一个可见项可能不是当前值 ⇒ 用户以为"没选中"。
 * 三个字段（日期/类型/标签）用同一块壳，所以同一条规则放在这里：
 * 打开后找第一个带选中态的条目，`scrollIntoView({block:"nearest"})` 只滚到刚好可见，
 * 不把面板整体跳到中间。标签面板里多个已选项时，以**第一个**为准。
 */
function revealSelected() {
  nextTick(() => {
    const panel = document.querySelector("[data-attr-popover]");
    const picked = panel?.querySelector('[aria-selected="true"], [aria-pressed="true"], [aria-current="true"]');
    (picked as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  });
}
watch(open, (v) => {
  if (v) revealSelected();
});
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
            data-attr-popover
            align="start"
            :side-offset="4"
            :collision-padding="POPOVER_EDGE"
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
