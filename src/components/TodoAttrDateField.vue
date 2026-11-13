<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/**
 * 「关联时间」属性控件：与类型/标签同壳（见 `TodoAttrField`），面板是**自绘日历**。
 *
 * 为什么不再用原生 `<input type="date">`（用户 2026-11-05 的统一样式要求）：
 * 原生拾取器由系统 WebView 绘制，面板宽度/圆角/阴影/行高都不受我们控制 —— 与标签下拉
 * 放在同一列时一眼能看出"两个面板不是一家的"。这里改成 `gosslan-menu` 面板里画一格
 * 7×6 的月历，宽度/圆角/阴影与 `.gosslan-menu-item` 的行高完全一致。
 *
 * 值口径不变：`YYYY-MM-DD`，空串 = 没填；「清除」发空串（后端按"明确清空"处理）。
 */
import { computed, nextTick, ref } from "vue";
import TodoAttrField from "@/components/TodoAttrField.vue";
import { currentLocale, t } from "@/i18n";
import { CALENDAR_COLS, calendarGridNext } from "@/utils/calendarGrid";

const props = defineProps<{
  label: string;
  hint?: string;
  /** `YYYY-MM-DD`；空串 = 未填。 */
  modelValue: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const WEEKDAYS = [
  "todo.dateWeekdayMon",
  "todo.dateWeekdayTue",
  "todo.dateWeekdayWed",
  "todo.dateWeekdayThu",
  "todo.dateWeekdayFri",
  "todo.dateWeekdaySat",
  "todo.dateWeekdaySun",
] as const;
const weekdays = computed(() => WEEKDAYS.map((k) => t(k)));

/** 本地日历日（不用 `toISOString()`：那是 UTC，东八区凌晨会差一天）。 */
function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function todayIso(now = new Date()): string {
  return iso(now.getFullYear(), now.getMonth(), now.getDate());
}
const today = todayIso();

/** 当前值解析出的 `{ y, m }`（月份 0-based）；无值/脏值回落今天。 */
function cursorOf(value: string): { y: number; m: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  }
  return { y: Number(m[1]), m: Number(m[2]) - 1 };
}

const cursor = ref(cursorOf(props.modelValue));
function syncCursor() {
  cursor.value = cursorOf(props.modelValue);
  // 打开时把焦点落到已选日（没有则今天，再没有则第一格），键盘用户不必从第一格 Tab 起。
  nextTick(() => {
    const idx = cells.value.findIndex((c) => c.iso === (props.modelValue || today));
    focusDay(idx >= 0 ? idx : 0);
  });
}

/** 月标题按当前界面语言格式化（中文「2026年11月」/ 英文「November 2026」）。 */
const monthLabel = computed(() =>
  new Intl.DateTimeFormat(currentLocale(), { year: "numeric", month: "long" }).format(
    new Date(cursor.value.y, cursor.value.m, 1),
  ),
);

function shiftMonth(delta: number) {
  const d = new Date(cursor.value.y, cursor.value.m + delta, 1);
  cursor.value = { y: d.getFullYear(), m: d.getMonth() };
}

interface DayCell {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** 固定 42 格（6 行 × 7 列），从周一开始；前后补邻月日期但不抢月标题。 */
const cells = computed<DayCell[]>(() => {
  const { y, m } = cursor.value;
  const first = new Date(y, m, 1);
  // JS 的 getDay(): 周日 0 … 周六 6 ⇒ 换算成"距离周一几天"。
  const lead = (first.getDay() + 6) % 7;
  const out: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, 1 - lead + i);
    out.push({ iso: iso(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === m });
  }
  return out;
});

function pick(value: string, close: () => void) {
  emit("update:modelValue", value);
  close();
}

// ---- 键盘可访问性（2026-11-13 组件复审 P1 跟进，ADR 决策 2 短期方案）----
// 42 格按周分成 6 行（role=row + display:contents，CSS grid 仍按 7 列排布），
// 日期格 role=gridcell + roving tabindex（只有一格可 Tab 到），方向键走纯函数 calendarGridNext。
const gridRef = ref<HTMLElement | null>(null);
const focusedIndex = ref(0);
const weeks = computed(() => {
  const out: DayCell[][] = [];
  for (let i = 0; i < cells.value.length; i += CALENDAR_COLS) {
    out.push(cells.value.slice(i, i + CALENDAR_COLS));
  }
  return out;
});

function dayButtons(): HTMLButtonElement[] {
  return Array.from(gridRef.value?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]') ?? []);
}
function focusDay(idx: number) {
  const list = dayButtons();
  const at = Math.max(0, Math.min(list.length - 1, idx));
  focusedIndex.value = at;
  list[at]?.focus();
}
function onGridKey(e: KeyboardEvent) {
  const list = dayButtons();
  if (!list.length) return;
  const cur = list.indexOf(document.activeElement as HTMLButtonElement);
  if (cur < 0) return; // 焦点不在格子上 ⇒ 不抢方向键
  // PageUp/PageDown 跨月：换月后保持同一格位落焦。
  if (e.key === "PageUp" || e.key === "PageDown") {
    e.preventDefault();
    shiftMonth(e.key === "PageUp" ? -1 : 1);
    nextTick(() => focusDay(cur));
    return;
  }
  const next = calendarGridNext(cur, e.key, list.length, CALENDAR_COLS);
  if (next === null) return; // Enter/Space 等不拦，交给按钮原生 click
  e.preventDefault(); // 不拦的话上下键会滚整页
  focusDay(next);
}
</script>

<template>
  <TodoAttrField :label="label" :hint="hint" :disabled="disabled" @open-change="(v) => v && syncCursor()">
    <template #trigger>
      <button
        type="button"
        class="tap-safe flex h-10 w-full items-center justify-between gap-2 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 text-sm text-[var(--gosslan-text)] ring-1 ring-[var(--gosslan-field-border)] transition hover:ring-[var(--gosslan-primary)]"
      >
        <span v-if="modelValue" class="min-w-0 truncate tabular-nums" :title="modelValue">{{ modelValue }}</span>
        <span v-else class="min-w-0 truncate text-[var(--gosslan-text-2)]" :title="t('todo.datePlaceholder')">{{ t("todo.datePlaceholder") }}</span>
        <Icon name="chevron-down" class="h-3.5 w-3.5 shrink-0 text-[var(--gosslan-text-2)]" aria-hidden="true" />
      </button>
    </template>

    <template #readonly>
      <div
        class="flex h-10 w-full items-center rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 text-sm ring-1 ring-[var(--gosslan-field-border)]"
        :class="modelValue ? 'text-[var(--gosslan-text)]' : 'text-[var(--gosslan-text-2)]'"
      >
        {{ modelValue || t("todo.datePlaceholder") }}
      </div>
    </template>

    <template #panel="{ close }">
      <div class="px-1">
        <!-- 月份切换：与标签面板一样落在 `.gosslan-menu` 的 6px 内边距里，不另加一层卡片。 -->
        <div class="flex items-center justify-between pb-1">
          <button
            type="button"
            class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-xs)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
            :aria-label="t('todo.datePrevMonth')"
            :title="t('todo.datePrevMonth')"
            @click="shiftMonth(-1)"
          >
            <Icon name="chevron-left" class="h-4 w-4" />
          </button>
          <span class="text-meta font-medium text-[var(--gosslan-text)]">{{ monthLabel }}</span>
          <button
            type="button"
            class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-xs)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)]"
            :aria-label="t('todo.dateNextMonth')"
            :title="t('todo.dateNextMonth')"
            @click="shiftMonth(1)"
          >
            <Icon name="chevron-right" class="h-4 w-4" />
          </button>
        </div>
        <div class="grid grid-cols-7 gap-0.5 pb-1 text-center text-caption text-[var(--gosslan-text-2)]">
          <span v-for="w in weekdays" :key="w">{{ w }}</span>
        </div>
        <div
          ref="gridRef"
          role="grid"
          :aria-label="monthLabel"
          class="grid grid-cols-7 gap-0.5"
          @keydown="onGridKey"
        >
          <!-- 周行用 display:contents：role=row 给出网格行结构，按钮仍按父级 7 列 grid 排布。 -->
          <div v-for="(week, wi) in weeks" :key="wi" role="row" class="contents">
            <button
              v-for="(c, ci) in week"
              :key="c.iso"
              type="button"
              role="gridcell"
              :tabindex="wi * CALENDAR_COLS + ci === focusedIndex ? 0 : -1"
              :aria-selected="c.iso === modelValue"
              class="tap-safe flex h-7 items-center justify-center rounded-[var(--gosslan-radius-xs)] text-caption tabular-nums transition"
              :class="
                c.iso === modelValue
                  ? 'bg-[var(--gosslan-primary-active)] font-medium text-[var(--gosslan-on-primary)]'
                  : c.iso === today
                    ? 'font-medium text-[var(--gosslan-primary)] hover:bg-[var(--gosslan-hover)]'
                    : c.inMonth
                      ? 'text-[var(--gosslan-text)] hover:bg-[var(--gosslan-hover)]'
                      : 'text-[var(--gosslan-text-2)] opacity-50 hover:bg-[var(--gosslan-hover)]'
              "
              :aria-current="c.iso === modelValue ? 'date' : undefined"
              @click="pick(c.iso, close)"
              @focus="focusedIndex = wi * CALENDAR_COLS + ci"
            >
              {{ c.day }}
            </button>
          </div>
        </div>
        <div class="mt-1 flex items-center justify-between border-t border-[var(--gosslan-divider)] px-1 pt-1">
          <button
            type="button"
            class="tap-safe rounded-[var(--gosslan-radius-xs)] px-1.5 py-1 text-meta text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)] hover:text-[var(--gosslan-text)] disabled:opacity-40"
            :disabled="!modelValue"
            @click="pick('', close)"
          >
            {{ t("common.clear") }}
          </button>
          <button
            type="button"
            class="tap-safe rounded-[var(--gosslan-radius-xs)] px-1.5 py-1 text-meta text-[var(--gosslan-accent-ink)] transition hover:bg-[var(--gosslan-hover)]"
            @click="pick(today, close)"
          >
            {{ t("todo.dateToday") }}
          </button>
        </div>
      </div>
    </template>
  </TodoAttrField>
</template>
