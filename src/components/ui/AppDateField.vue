<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/**
 * 统一日期字段：原生 `<input type="date">` 的薄封装。
 *
 * 为什么是薄封装（用户 2026-11-04）：仓库里**没有**组件库日期选择器，也不为此新增依赖 ——
 * 原生控件由系统 WebView 提供拾取器与校验，移动端体验最好。但原先「群任务·关联时间」是
 * 一个裸 `<input type="date">` 加旁边一个文字「清除」按钮：高度/圆角/暗色态与其它输入框
 * 不一致，「清除」又像另一个并列动作。这里把外观与清除收成一处：
 *   - 外观与其它输入框同一套变量（`py-2` 决定高度、`--gosslan-radius-md` 圆角、
 *     `--gosslan-bg` 底色、禁用态 `opacity-60`）。焦点**刻意不变色**：与 `src/style.css`
 *     里文本字段的口径一致（用户 2026-09-16 明确不要输入框聚焦时的主题色方框）——
 *     这不是漏写焦点环。
 *   - 「清除」是输入框**内部**右侧的 × 图标按钮（`clearable` 控制），不再另占一格。
 *
 * 三个能力都留成参数（本处只用到「可清空 + 年月日」）：
 *   - `clearable`：有值时显示字段内 ×；
 *   - `minToday`：`min` 设成今天，并挡住早于今天的手输值（不让它落到 model 上）；
 *   - `dateOnly`：默认 `true` ⇒ `type="date"`（只到年月日）；`false` ⇒ `datetime-local`。
 */
import { computed } from "vue";
import { t } from "@/i18n";

const props = withDefaults(
  defineProps<{
    /** `YYYY-MM-DD`（`dateOnly=false` 时是 `YYYY-MM-DDTHH:mm`）；空串 = 未填。 */
    modelValue: string;
    /** 可清空：有值时在字段内部显示 × 图标按钮。 */
    clearable?: boolean;
    /** 不允许早于今天（`min` + 落值前再挡一次）。 */
    minToday?: boolean;
    /** 只到年月日。 */
    dateOnly?: boolean;
    /** 无障碍名称（调用方给，中英由词典提供）。 */
    label: string;
    disabled?: boolean;
  }>(),
  { clearable: false, minToday: false, dateOnly: true, disabled: false },
);
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

/** 本地日历日（不用 `toISOString()`：那是 UTC，东八区凌晨会差一天）。 */
function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const minAttr = computed(() => (props.minToday ? todayIso() : undefined));
const hasClear = computed(() => props.clearable && !!props.modelValue && !props.disabled);

/**
 * 值只在 `change` 时收：原生拾取器选完会发 change，手输完整一段后也会发。
 * 早于今天的值**不落到 model**（`min` 只是拾取器的软约束，手输能绕过），
 * 同时把控件显示退回原值 —— 否则界面显示一个库里没接受的日期。
 */
function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  const raw = el.value;
  const v = props.dateOnly ? raw.slice(0, 10) : raw;
  if (v && props.minToday && v < todayIso()) {
    el.value = props.modelValue;
    return;
  }
  emit("update:modelValue", v);
}
</script>

<template>
  <div class="relative">
    <input
      :value="modelValue"
      :type="dateOnly ? 'date' : 'datetime-local'"
      :min="minAttr"
      :disabled="disabled"
      :aria-label="label"
      class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-3 py-1.5 text-sm text-[var(--gosslan-text)] outline-none transition focus:border-[var(--gosslan-primary)] disabled:opacity-60"
      :class="clearable ? 'pr-14' : ''"
      @change="onChange"
    />
    <!-- × 留在输入框内部（不是旁边一个文字按钮）；右侧留出原生拾取器图标的位置，
         所以偏左一点而不是贴边 —— 该图标由系统 WebView 画，位置不受我们控制。 -->
    <button
      v-if="hasClear"
      type="button"
      class="tap-safe absolute right-7 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
      :title="t('common.clear')"
      :aria-label="t('common.clear')"
      @click="emit('update:modelValue', '')"
    >
      <Icon name="x" class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
