<script setup lang="ts">
import { computed } from "vue";
import { charCount } from "@/utils/validation";

/**
 * 输入框长度读数（通用展示件）：`maxlength` 到顶时是**静默**截断的（粘 60 字只剩 40 字，
 * 无半句说明），而四端（桌面 / Web / Android / iOS）都成立的唯一反馈就是把这个数说出来。
 *
 * 尺子走 `charCount`（Unicode 码点）= zod schema = 后端 `chars().count()`，不各数一遍。
 */
const props = defineProps<{ text: string; max: number }>();

const count = computed(() => charCount(props.text));
// ⚠️ 到顶的判据要同时看两把尺：浏览器 `maxlength` 数 UTF-16 单元，后端与 schema 数码点。
// 含 emoji 时前者先到顶（20 个 emoji 就占满 40 格），此时数字仍显示 20（那是真会被存下的长度），
// 但颜色必须变红 —— 否则用户看到的是"20/40 却打不进字"，两头都解释不了。
const atCap = computed(() => count.value >= props.max || props.text.length >= props.max);
</script>

<template>
  <span
    v-if="text"
    class="shrink-0 tabular-nums text-caption"
    :class="atCap ? 'text-[var(--gosslan-danger-ink)]' : 'text-[var(--gosslan-text-2)]'"
    >{{ count }}/{{ max }}</span
  >
</template>
