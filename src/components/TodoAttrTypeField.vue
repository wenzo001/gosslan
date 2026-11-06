<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
/**
 * 「任务类型」属性控件：与关联时间/标签同壳（见 `TodoAttrField`）。
 *
 * 与旧 `TodoPickField` 的区别只有观感：触发器从"行尾小胶囊"变成占满一行、高 40px 的字段，
 * 面板换成 280px 的 `.gosslan-menu` —— 与日期面板、标签下拉同一个矩形。
 * 选项与写入语义完全沿用旧版：
 *   - 内置档一点即写（父层发 `update_group_todo`）；
 *   - 「自定义…」不立即落库，先在面板里输入名字，确认后才写（后端对空名明确拒收）。
 */
import { nextTick, ref, watch } from "vue";
import { Check } from "@/components/ui/icons";
import CharCounter from "@/components/ui/CharCounter.vue";
import TodoAttrField from "@/components/TodoAttrField.vue";
import { t } from "@/i18n";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { TODO_CUSTOM_CATEGORY_MAX_LEN } from "@/utils/todos";

const props = defineProps<{
  label: string;
  hint?: string;
  modelValue: string;
  /** 当前值的显示文案（自定义档显示用户输入的名字）。 */
  current: string;
  /** 当前值的胶囊配色（`TODO_CATEGORY_PILL` 里那一档）。 */
  currentClass: string;
  options: readonly { value: string; label: string }[];
  /** 已落库的自定义类型名（再次打开面板时预填）。 */
  customValue?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: string, customName?: string): void;
}>();

const customOpen = ref(false);
const customDraft = ref("");
const customInput = ref<HTMLInputElement | null>(null);
const ime = useImeEnterGuard();

watch(
  () => props.modelValue,
  () => {
    customOpen.value = false;
  },
);

function onOpenChange(open: boolean) {
  if (open) {
    customOpen.value = false;
    customDraft.value = props.customValue ?? "";
  }
}

function pick(value: string, close: () => void) {
  if (value === "custom") {
    // 选自定义只展开输入框，不立刻写库（没名字的 custom 会被后端拒）；
    // 展开后立刻聚焦 —— 这一步在共享组件里做，详情弹窗与看板表单都吃到同一份。
    customOpen.value = true;
    customDraft.value = props.customValue ?? "";
    void nextTick(() => customInput.value?.focus());
    return;
  }
  emit("update:modelValue", value);
  close();
}

function applyCustom(close: () => void) {
  const name = customDraft.value.trim();
  if (!name) return;
  emit("update:modelValue", "custom", name);
  close();
}
</script>

<template>
  <TodoAttrField :label="label" :hint="hint" :disabled="disabled" @open-change="onOpenChange">
    <template #trigger>
      <button
        type="button"
        class="tap-safe flex h-10 w-full items-center justify-between gap-2 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 text-sm ring-1 ring-[var(--gosslan-field-border)] transition hover:ring-[var(--gosslan-primary)]"
        :title="hint ?? label"
        :aria-label="hint ?? label"
      >
        <span
          class="inline-flex h-6 min-w-0 items-center truncate rounded-full px-2.5 text-meta font-medium leading-none"
          :class="currentClass"
          :title="current"
        >{{ current }}</span>
        <Icon name="chevron-down" class="h-3.5 w-3.5 shrink-0 text-[var(--gosslan-text-2)]" aria-hidden="true" />
      </button>
    </template>

    <template #readonly>
      <div class="flex h-10 w-full items-center rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-field)] px-3 ring-1 ring-[var(--gosslan-field-border)]">
        <span
          class="inline-flex h-6 items-center rounded-full px-2.5 text-meta font-medium leading-none"
          :class="currentClass"
        >{{ current }}</span>
      </div>
    </template>

    <template #panel="{ close }">
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        class="gosslan-menu-item"
        :class="o.value === modelValue ? 'font-medium text-[var(--gosslan-primary)]' : ''"
        :aria-current="o.value === modelValue ? 'true' : undefined"
        @click="pick(o.value, close)"
      >
        <Check v-if="o.value === modelValue" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true"></span>
        <span class="min-w-0 flex-1 truncate" :title="o.value === 'custom' && customValue ? customValue : o.label">
          {{ o.value === "custom" && customValue ? customValue : o.label }}
        </span>
      </button>
      <!-- 自定义名的输入区：与菜单条目同一块面板，不再在字段下方另起一行。 -->
      <div v-if="customOpen" class="mt-1 flex items-center gap-1.5 border-t border-[var(--gosslan-divider)] px-1 pt-2">
        <input
          ref="customInput"
          v-model="customDraft"
          :maxlength="TODO_CUSTOM_CATEGORY_MAX_LEN"
          class="tap-safe h-9 min-w-0 flex-1 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-field)] px-2 text-meta ring-1 ring-[var(--gosslan-field-border)]"
          :placeholder="t('todo.categoryCustomPlaceholder')"
          @keydown.enter="ime.enter(() => applyCustom(close), $event)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
        <CharCounter :text="customDraft" :max="TODO_CUSTOM_CATEGORY_MAX_LEN" />
        <button
          type="button"
          class="tap-safe shrink-0 rounded-[var(--gosslan-radius-sm)] bg-[var(--gosslan-primary-active)] px-2 py-1 text-meta text-[var(--gosslan-on-primary)] transition hover:opacity-90 disabled:opacity-40"
          :disabled="!customDraft.trim()"
          @click="applyCustom(close)"
        >
          {{ t("common.confirm") }}
        </button>
      </div>
    </template>
  </TodoAttrField>
</template>
