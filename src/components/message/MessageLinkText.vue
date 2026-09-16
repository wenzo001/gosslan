<script setup lang="ts">
import { computed } from "vue";
import { splitUrl } from "@/utils/linkify";

const props = defineProps<{
  /** 点击时打开的地址 */
  href: string;
  /** 展示用的原始链接文本（由 linkify 切出的 seg.value） */
  label: string;
}>();
const emit = defineEmits<{ (e: "open", href: string): void }>();

const parts = computed(() => splitUrl(props.label));
</script>

<template>
  <!-- 长链接：视觉上中间省略，但**DOM 文本仍是完整的原始 URL**。
       用户 2026-09-16：「复制的时候会复制不完整的，应该复制原始数据」——
       选中复制取的是选区文本，所以省略只能靠 CSS，不能靠改文本：
         · mid 段用 `.gosslan-url-mid`（font-size:0）藏起来，文字仍在 DOM 里、仍在选区内；
         · 省略号走 `.gosslan-url-dots`（纯 CSS 画点，**不含任何文本**），
           写成 "…" 会被原样复制进 URL。
       ⚠️ 三个 span 之间**不能有空白**（含换行）：模板里的空白是真实文本节点，
           会被选进选区，复制出来的 URL 中间就多出空格。故这里刻意写成一整行。 -->
  <a
    class="cursor-pointer break-all underline decoration-1 underline-offset-2 transition hover:opacity-80"
    :title="href"
    @click.stop.prevent="emit('open', href)"
  ><span>{{ parts.head }}</span><span v-if="parts.mid" class="gosslan-url-mid">{{ parts.mid }}</span><span v-if="parts.mid" aria-hidden="true" class="gosslan-url-dots"></span><span>{{ parts.tail }}</span></a>
</template>
