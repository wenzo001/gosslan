<script setup lang="ts">
import { ref } from "vue";

defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: "select", emoji: string): void;
  (e: "close"): void;
}>();

// 内置常用表情（不引入第三方依赖，避免体积与 WebView 兼容成本）
const GROUPS: { label: string; items: string[] }[] = [
  {
    label: "常用",
    items: [
      "😀", "😄", "😁", "😂", "🤣", "😊", "😍", "🥰",
      "😘", "😎", "🤔", "😅", "😭", "😡", "🥺", "😴",
      "🤯", "😱", "🤗", "🙄", "😏", "😬", "😐", "😇",
    ],
  },
  {
    label: "手势",
    items: [
      "👍", "👎", "👌", "✌️", "🤝", "👏", "🙌", "💪",
      "🙏", "👋", "🫡", "🤙", "🫰", "✍️", "🖐️", "🤞",
    ],
  },
  {
    label: "心情",
    items: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔",
      "✨", "🔥", "🎉", "💯", "⭐", "🌈", "☀️", "🌙",
    ],
  },
];

const activeGroup = ref(0);
</script>

<template>
  <div
    v-if="open"
    class="absolute bottom-full left-0 z-50 mb-2 w-[300px] select-none rounded-xl border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] shadow-xl"
    @click.stop
  >
    <div class="flex items-center gap-1 border-b border-[var(--gosslan-border)] px-2 py-1.5">
      <button
        v-for="(g, i) in GROUPS"
        :key="g.label"
        class="rounded-md px-2 py-1 text-xs transition"
        :class="activeGroup === i ? 'bg-primary-light text-primary' : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
        @click="activeGroup = i"
      >{{ g.label }}</button>
    </div>
    <div class="grid max-h-[180px] grid-cols-8 gap-0.5 overflow-y-auto p-2">
      <button
        v-for="e in GROUPS[activeGroup].items"
        :key="e"
        class="flex h-8 w-8 items-center justify-center rounded-md text-lg transition hover:bg-[var(--gosslan-hover)]"
        @click="emit('select', e)"
      >{{ e }}</button>
    </div>
  </div>
</template>
