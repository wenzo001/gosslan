<script setup lang="ts">
/**
 * 代码语言选择器（发送前 + 发送后共用一份）。
 *
 * 为什么自绘而不是原生 `<select>`：与 `TodoPickField` 同一个理由——原生弹层由系统绘制，
 * 深色主题下会出现"浅底 + 近白字"；这里统一吃 `.gosslan-menu` 的主题 token。
 *
 * 档位：
 * - `null`（自动识别）：交给 highlight.js 的 `highlightAuto`，识别不确定就落纯文本；
 * - `plaintext`：明确不高亮，但仍是代码块（保留等宽、内部滚动、复制）；
 * - 具体语言：按标记高亮。
 */
import { computed, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import Spinner from "@/components/ui/Spinner.vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";
import { t } from "@/i18n";
import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_LABELS,
  PLAINTEXT,
  codeLanguageLabel,
  normalizeCodeLanguage,
} from "@/utils/codeLanguages";

const props = defineProps<{
  /** `null` = 自动识别；`plaintext` = 纯文本；其它为规范语言名。 */
  modelValue: string | null;
  /** 触发器上显示的文案（默认按当前值推导；自动识别命中时由父层传实际识别结果）。 */
  label?: string;
  disabled?: boolean;
  /** 切换进行中：保留旧语言显示，只转圈并禁用。 */
  loading?: boolean;
  ariaLabel?: string;
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: string | null): void }>();

const open = ref(false);
watch(
  () => [props.modelValue, props.disabled, props.loading],
  () => {
    if (props.disabled || props.loading) open.value = false;
  },
);

const options = computed(() => [
  { value: "", label: t("code.auto") },
  { value: PLAINTEXT, label: t("code.plaintext") },
  ...CODE_LANGUAGES.map((value) => ({ value, label: CODE_LANGUAGE_LABELS[value] ?? value })),
]);

const currentLabel = computed(() => {
  if (props.label) return props.label;
  const normalized = normalizeCodeLanguage(props.modelValue);
  if (!normalized) return t("code.auto");
  if (normalized === PLAINTEXT) return t("code.plaintext");
  return codeLanguageLabel(normalized) || normalized;
});

function pick(value: string) {
  open.value = false;
  emit("update:modelValue", value === "" ? null : value);
}
</script>

<template>
  <DropdownMenuRoot v-if="!disabled" :open="open" :modal="false" @update:open="open = $event">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="code-lang-trigger tap-safe"
        :class="loading ? 'cursor-wait opacity-70' : ''"
        :title="ariaLabel ?? t('code.lang')"
        :aria-label="ariaLabel ?? t('code.lang')"
        :aria-busy="loading ? 'true' : undefined"
      >
        <Spinner v-if="loading" size-class="h-3 w-3" decorative />
        <span class="max-w-[9rem] truncate" :title="currentLabel">{{ currentLabel }}</span>
        <ChevronDown v-if="!loading" class="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent align="end" :side-offset="4" :collision-padding="8" class="gosslan-menu frost z-[80]">
        <DropdownMenuItem
          v-for="o in options"
          :key="o.value"
          class="gosslan-menu-item"
          :class="normalizeCodeLanguage(modelValue) === (o.value || null) ? 'font-medium text-[var(--gosslan-primary)]' : ''"
          :aria-current="normalizeCodeLanguage(modelValue) === (o.value || null) ? 'true' : undefined"
          @select="pick(o.value)"
        >
          {{ o.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <span v-else class="code-lang-trigger code-lang-trigger--static" aria-hidden="true">{{ currentLabel }}</span>
</template>

<style scoped>
.code-lang-trigger {
  display: inline-flex;
  min-width: 0;
  height: 22px;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--gosslan-radius-sm);
  font-size: 12px;
  line-height: 1;
  color: var(--gosslan-text-2);
  transition: background-color 120ms ease, opacity 120ms ease;
}
.code-lang-trigger:hover {
  background: var(--gosslan-hover);
}
.code-lang-trigger--static {
  padding-left: 0;
}
</style>
