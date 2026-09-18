<script setup lang="ts">
/**
 * 合并转发卡片（微信式「聊天记录」）。
 *
 * ## 为什么高度定死在 `h-24`（96px）
 * 虚拟列表按 `messageHeight.MERGE_CARD = 96` 估算本卡片的高度。卡片内每行都是
 * `truncate`（单行、不换行），所以高度本来就确定 —— 直接把它钉成 96px，
 * 渲染与估算就不会因为"某条摘要是中文还是英文、会不会折行"而分叉
 * （分叉的后果是相邻消息互相遮挡，这个坑 `messageHeight` 的文件头专门写过）。
 *
 * ## 预览只取前 3 行
 * 微信卡片也是这样：列表里给几条摘要，完整内容点开看。前 3 行之外的信息用
 * 页脚的「查看 N 条转发消息」表达。
 */
import { computed } from "vue";
import { ScrollText } from "lucide-vue-next";
import { t } from "@/i18n";
import { mergeItemLine, parseMergePayload } from "@/utils/mergeCard.ts";

const props = defineProps<{ content: string }>();
const emit = defineEmits<{ (e: "open"): void }>();

const parsed = computed(() => parseMergePayload(props.content));
const title = computed(() => parsed.value?.title || t("merge.title"));
const count = computed(() => parsed.value?.items.length ?? 0);
const previewLines = computed(() =>
  (parsed.value?.items ?? []).slice(0, 3).map((it) => ({
    sender: it.sender,
    text: mergeItemLine(it),
  })),
);
</script>

<template>
  <button
    class="flex h-24 w-60 flex-col gap-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)] bg-[var(--gosslan-panel)] px-3 py-2 text-left transition hover:bg-[var(--gosslan-hover)]"
    :aria-label="t('merge.open')"
    @click="emit('open')"
  >
    <div class="flex items-center gap-1.5">
      <ScrollText class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]" aria-hidden="true" />
      <span class="truncate text-[13px] font-medium text-[var(--gosslan-text)]" :title="title">
        {{ title }}
      </span>
    </div>
    <div class="min-h-0 flex-1 space-y-0.5 overflow-hidden">
      <div
        v-for="(line, i) in previewLines"
        :key="i"
        class="flex items-center gap-1 text-[11px] leading-[15px] text-[var(--gosslan-text-2)]"
      >
        <span class="shrink-0 truncate" :title="line.sender">{{ line.sender }}：</span>
        <span class="truncate" :title="line.text">{{ line.text }}</span>
      </div>
    </div>
    <div class="shrink-0 text-[11px] leading-[15px] text-[var(--gosslan-text-2)]">
      {{ t("merge.viewCount", { n: count }) }}
    </div>
  </button>
</template>
