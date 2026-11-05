<script setup lang="ts">
/**
 * 「任务标签」属性控件：多选 + 自定义输入 + 历史候选下拉。
 *
 * 样式与类型控件同构（见 `TodoAttrField`）：触发器是占满一行、高 40px 的字段，面板是同一块
 * 280px `gosslan-menu`。触发器内最多平铺 3 枚标签，其余折成 `+n` —— 固定单行高度，
 * 标签再多也不会把这一格撑高（"同高度"是用户明确要求）。
 *
 * 语义（用户 2026-11-05）：
 *   - 移除某标签只**解除与任务的关联**，历史候选池不动（面板里的勾选切换就是这件事）；
 *   - 候选池按「使用次数 / 最近使用」排序由后端给出（`list_group_todo_tags`）；
 *   - 单个标签 20 字符、单任务最多 10 个，与 Rust 侧常量同一份口径。
 */
import { computed, ref } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { Check } from "@/components/ui/icons";
import CharCounter from "@/components/ui/CharCounter.vue";
import TodoAttrField from "@/components/TodoAttrField.vue";
import { t } from "@/i18n";
import type { TodoTagCandidate } from "@/api";
import { TODO_MAX_TAGS, TODO_TAG_MAX_LEN, normalizeTodoTags } from "@/utils/todos";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";

const props = defineProps<{
  label: string;
  hint?: string;
  modelValue: string[];
  /** 历史候选（已由后端按使用次数/最近使用排序）。 */
  candidates?: TodoTagCandidate[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: "update:modelValue", tags: string[]): void }>();

const input = ref("");
const ime = useImeEnterGuard();

/** 触发器里最多平铺几枚；其余折成「+n」保持单行高度。 */
const VISIBLE_TAGS = 3;
const shown = computed(() => props.modelValue.slice(0, VISIBLE_TAGS));
const extra = computed(() => Math.max(0, props.modelValue.length - VISIBLE_TAGS));

/**
 * 面板行：当前已挂但不在候选池里的标签（老数据/别端刚建）也要能在这里点掉，
 * 否则用户看得到标签却找不到"解除关联"的入口。
 */
const rows = computed<TodoTagCandidate[]>(() => {
  // 与候选池同样按小写判等：老任务里可能是 `bug`、候选池首次写法是 `Bug`，不能因此多出一行。
  const known = new Set((props.candidates ?? []).map((c) => c.tag.toLowerCase()));
  const extraRows = props.modelValue
    .filter((tag) => !known.has(tag.toLowerCase()))
    .map((tag) => ({ tag, use_count: 0, last_used_at: 0 }));
  return [...extraRows, ...(props.candidates ?? [])];
});

const full = computed(() => props.modelValue.length >= TODO_MAX_TAGS);
/** 标签个数（不是字符数）：计数任务上限，不套 CharCounter 的数码点口径。 */
const countLabel = computed(() => `${props.modelValue.length}/${TODO_MAX_TAGS}`);

function isSelected(tag: string): boolean {
  const lowered = tag.toLowerCase();
  return props.modelValue.some((x) => x.toLowerCase() === lowered);
}

function add(tag: string) {
  if (!tag || isSelected(tag) || full.value) return;
  emit("update:modelValue", [...props.modelValue, tag]);
}

function remove(tag: string) {
  const lowered = tag.toLowerCase();
  emit("update:modelValue", props.modelValue.filter((x) => x.toLowerCase() !== lowered));
}

function toggle(tag: string) {
  if (isSelected(tag)) remove(tag);
  else add(tag);
}

/** 自定义输入：与其它入口共用 `normalizeTodoTags`（trim / 去重 / 超长丢弃 / 截断到上限）。 */
function addCustom() {
  const raw = input.value.trim();
  if (!raw) return;
  const next = normalizeTodoTags([...props.modelValue, raw]);
  if (next.length !== props.modelValue.length && next.length <= TODO_MAX_TAGS) {
    emit("update:modelValue", next);
  }
  input.value = "";
}
</script>

<template>
  <TodoAttrField :label="label" :hint="hint" :disabled="disabled">
    <template #trigger>
      <button
        type="button"
        class="tap-safe relative flex h-10 w-full items-center gap-1 overflow-hidden rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 pr-8 text-left text-sm ring-1 ring-transparent transition hover:ring-[var(--gosslan-border)]"
        :title="hint ?? label"
        :aria-label="hint ?? label"
      >
        <template v-if="modelValue.length">
          <span
            v-for="tag in shown"
            :key="tag"
            class="inline-flex h-6 max-w-[6.5rem] shrink-0 items-center truncate rounded-full bg-[var(--gosslan-primary-light)] px-2 text-meta text-[var(--gosslan-accent-ink)]"
            :title="tag"
          >{{ tag }}</span>
          <span v-if="extra > 0" class="shrink-0 text-meta text-[var(--gosslan-text-2)]">+{{ extra }}</span>
        </template>
        <span v-else class="truncate text-[var(--gosslan-text-2)]" :title="t('todo.tagsPlaceholder')">{{ t("todo.tagsPlaceholder") }}</span>
        <ChevronDown class="absolute right-3 h-3.5 w-3.5 shrink-0 text-[var(--gosslan-text-2)]" aria-hidden="true" />
      </button>
    </template>

    <template #readonly>
      <div class="flex min-h-10 w-full flex-wrap items-center gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 py-1.5 text-sm">
        <template v-if="modelValue.length">
          <span
            v-for="tag in modelValue"
            :key="tag"
            class="inline-flex h-6 items-center rounded-full bg-[var(--gosslan-primary-light)] px-2 text-meta text-[var(--gosslan-accent-ink)]"
          >{{ tag }}</span>
        </template>
        <span v-else class="text-[var(--gosslan-text-2)]">{{ t("todo.tagsPlaceholder") }}</span>
      </div>
    </template>

    <template #panel>
      <!-- 自定义输入：回车即加；到上限后禁用并给一句说明。 -->
      <div class="flex items-center gap-1.5 px-1 pb-1">
        <input
          v-model="input"
          :maxlength="TODO_TAG_MAX_LEN"
          :disabled="full"
          class="tap-safe h-9 min-w-0 flex-1 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-field)] px-2 text-meta disabled:opacity-50"
          :placeholder="t('todo.tagsInputPlaceholder')"
          @keydown.enter="ime.enter(addCustom, $event)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
        <CharCounter :text="input" :max="TODO_TAG_MAX_LEN" />
        <button
          type="button"
          class="tap-safe shrink-0 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-primary-active)] px-2 py-1 text-meta text-[var(--gosslan-on-primary)] transition hover:opacity-90 disabled:opacity-40"
          :disabled="full || !input.trim()"
          @click="addCustom"
        >
          {{ t("todo.tagsAdd") }}
        </button>
      </div>
      <div class="flex items-baseline justify-between px-1 pb-1 text-caption text-[var(--gosslan-text-2)]">
        <span>{{ t("todo.tagsCandidates") }}</span>
        <span class="tabular-nums">{{ countLabel }}</span>
      </div>
      <button
        v-for="row in rows"
        :key="row.tag"
        type="button"
        class="gosslan-menu-item"
        :class="isSelected(row.tag) ? 'font-medium text-[var(--gosslan-primary)]' : ''"
        :aria-pressed="isSelected(row.tag)"
        @click="toggle(row.tag)"
      >
        <Check v-if="isSelected(row.tag)" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true"></span>
        <span class="min-w-0 flex-1 truncate" :title="row.tag">{{ row.tag }}</span>
        <span v-if="row.use_count > 0" class="shrink-0 text-caption tabular-nums text-[var(--gosslan-text-2)]">{{ row.use_count }}</span>
      </button>
      <p v-if="rows.length === 0" class="px-1 py-2 text-caption text-[var(--gosslan-text-2)]">
        {{ t("todo.tagsEmpty") }}
      </p>
      <p class="mt-1 border-t border-[var(--gosslan-divider)] px-1 pt-1.5 text-caption leading-relaxed text-[var(--gosslan-text-2)]">
        {{ t("todo.tagsHint") }}
      </p>
    </template>
  </TodoAttrField>
</template>
