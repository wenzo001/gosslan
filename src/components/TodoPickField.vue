<script setup lang="ts">
/**
 * 「三选一」字段：一行标签 + 一个当前值胶囊 + 自绘菜单。
 * 详情弹窗里的 状态 / 优先级 / 类型 三格共用这一份（一个家，别复制三份菜单）。
 *
 * 为什么不用原生 `<select>`（这一族原来就是原生下拉）：
 * 原生弹层由**系统绘制**。我们给控件写了 `bg-transparent` + 主题文字色，
 * 深色主题下就成了"浅底 + 近白字"—— 用户 2026-09-30 实测到的正是这个：
 * 暗夜模式里展开类型下拉，「任务」「缺陷」两行几乎看不见，只有当前项因为
 * 系统反色才读得出来。自绘菜单吃的是同一套 token，两种外观必然对得上，
 * 而且与同弹窗里「状态」那一格本来就是同一个形状（`.gosslan-menu`）——
 * 不再一处原生一处自绘，两套键盘/焦点/观感。
 *
 * ⚠️ 已知边界（与替换前一致，不是这次引入的）：菜单的 ↑/↓ 由 Reka DropdownMenu 接管；
 * 但 Esc 仍会先关菜单（不再直接关整个弹窗）。要做“Esc 一次关弹窗”得连外层一起改，
 * 那是独立一轮。
 */
import { ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";

const props = defineProps<{
  /** 行左边的字段名（如「类型」）。 */
  label: string;
  /** 当前值的显示文案（胶囊上那一个词）。 */
  current: string;
  /** 当前值的胶囊配色（`TODO_*_PILL` 里的那一档）。 */
  currentClass: string;
  /** 候选项。`value` 与 `modelValue` 同型比较。 */
  options: readonly { value: string; label: string }[];
  modelValue: string;
  /** 没权限改：只画当前值，不给按钮。 */
  disabled?: boolean;
  /** 悬浮提示（一般给"谁能改 / 改了会怎样"那句）。 */
  hint?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const open = ref(false);
// 值变了（含对端同步过来的改动）就收起：菜单里那份列表可能已经不是刚才那条任务了。
watch(() => props.modelValue, () => (open.value = false));
watch(
  () => props.disabled,
  (v) => {
    if (v) open.value = false;
  },
);
/**
 * 点任意一项都立即关菜单，再把选择抛给父层。不能只靠 `watch(modelValue)` 关 ——
 * 「自定义类型…」那一项父层不会立刻落值（要先拿到用户输入的名字再提交），
 * 只靠值变化会让菜单挂在原地。
 */
function pick(value: string) {
  open.value = false;
  emit("update:modelValue", value);
}
</script>

<template>
  <div class="flex items-center justify-between gap-2">
    <span class="text-xs text-[var(--gosslan-text-2)]">{{ label }}</span>
    <div class="relative">
      <DropdownMenuRoot v-if="!disabled" :open="open" :modal="false" @update:open="open = $event">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="tap-safe inline-flex h-6 items-center justify-center gap-1 rounded-full px-2.5 text-meta font-medium leading-none transition hover:opacity-80"
            :class="currentClass"
            :title="hint ?? label"
            :aria-label="hint ?? label"
          >
            {{ current }}
            <ChevronDown class="h-3 w-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="4"
            :collision-padding="8"
            class="gosslan-menu frost z-[80]"
          >
            <DropdownMenuItem
              v-for="o in options"
              :key="o.value"
              class="gosslan-menu-item"
              :class="o.value === modelValue ? 'font-medium text-[var(--gosslan-primary)]' : ''"
              :disabled="o.value === modelValue"
              :aria-current="o.value === modelValue ? 'true' : undefined"
              @select="pick(o.value)"
            >
              {{ o.label }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <span
        v-else
        class="inline-flex h-6 items-center justify-center rounded-full px-2.5 text-meta font-medium leading-none"
        :class="currentClass"
      >
        {{ current }}
      </span>
    </div>
  </div>
</template>
