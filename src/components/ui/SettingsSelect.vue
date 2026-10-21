<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { Check } from "@/components/ui/icons";
import {
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";

export type SelectValueOption = string | number;

const props = defineProps<{
  modelValue: SelectValueOption;
  options: readonly { value: SelectValueOption; label: string }[];
  selectLabel: string;
  triggerClass?: string;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: SelectValueOption): void }>();

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? "",
);

function pick(value: unknown) {
  emit("update:modelValue", value as SelectValueOption);
}
</script>

<template>
  <SelectRoot :model-value="modelValue" @update:model-value="pick">
    <SelectTrigger
      :aria-label="selectLabel"
      class="tap-safe inline-flex h-8 max-w-full items-center justify-between gap-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-bg)] px-2.5 text-body text-[var(--gosslan-text)] transition hover:bg-[var(--gosslan-hover)] focus-visible:border-[var(--gosslan-primary)] data-[state=open]:border-[var(--gosslan-primary)]"
      :class="triggerClass"
    >
      <SelectValue class="min-w-0 truncate" :title="currentLabel" />
      <SelectIcon as-child>
        <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-55" aria-hidden="true" />
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        class="gosslan-menu frost z-[80]"
      >
        <SelectViewport>
          <SelectItem
            v-for="o in options"
            :key="String(o.value)"
            :value="o.value"
            class="gosslan-menu-item"
            :class="o.value === modelValue ? 'font-medium text-[var(--gosslan-primary)]' : ''"
          >
            <SelectItemText class="truncate" :title="o.label">{{ o.label }}</SelectItemText>
            <SelectItemIndicator class="ml-auto">
              <Check class="h-4 w-4" aria-hidden="true" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
