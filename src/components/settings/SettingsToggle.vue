<script setup lang="ts">
withDefaults(
  defineProps<{
    modelValue: boolean;
    /** md 用于深色模式这类主开关，sm 用于分组内的次要开关。 */
    size?: "sm" | "md";
    disabled?: boolean;
  }>(),
  { size: "sm", disabled: false },
);
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();
</script>

<template>
  <button
    class="relative shrink-0 rounded-full transition"
    :class="[
      size === 'md' ? 'h-6 w-11' : 'h-5 w-9',
      modelValue ? 'bg-primary' : 'bg-[var(--gosslan-border)]',
      disabled ? 'opacity-50' : '',
    ]"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="absolute top-0.5 flex items-center justify-center rounded-full bg-white shadow transition-all"
      :class="[
        size === 'md' ? 'h-5 w-5' : 'h-4 w-4',
        modelValue ? (size === 'md' ? 'left-[22px]' : 'left-[18px]') : 'left-0.5',
      ]"
    >
      <slot />
    </span>
  </button>
</template>
