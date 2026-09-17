<script setup lang="ts">
/**
 * 合并转发的详情（点卡片打开）：把卡片里的 N 条按「发送者 + 内容」列出来。
 *
 * ## 为什么媒体只显示占位
 * 卡片载荷里图片/文件**只带了元信息**（名字/大小），没复制文件本体 —— 真要带媒体，
 * 需要"一条消息携带 N 个附件 + 逐条回源"的内容传输，那是另一个量级。所以这里对媒体
 * 显示 `[图片] name` 这样的占位，并**在顶部说明**，避免用户以为"点开什么都没有"。
 * 需要真拿到文件时，用**逐条转发**（会重发文件本体）。
 */
import { computed } from "vue";
import { t } from "@/i18n";
import BaseModal from "@/components/BaseModal.vue";
import { fmtConversationTime } from "@/utils/time";
import { mergeItemLine, parseMergePayload } from "@/utils/mergeCard.ts";

const props = defineProps<{ open: boolean; content: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const parsed = computed(() => parseMergePayload(props.content));
const items = computed(() => parsed.value?.items ?? []);
/** 载荷里含媒体时才提示"媒体不随卡片传输"（纯文本卡片不用吓唬用户）。 */
const hasMedia = computed(() => items.value.some((i) => i.kind === "image" || i.kind === "file"));
</script>

<template>
  <BaseModal
    :open="open"
    :title="parsed?.title || t('merge.title')"
    width="max-w-md"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div class="text-xs text-[var(--gosslan-text-2)]">
        {{ t("merge.count", { n: items.length }) }}
      </div>
      <div
        v-if="hasMedia"
        class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-2 text-xs leading-relaxed text-[var(--gosslan-text-2)]"
      >
        {{ t("merge.mediaNotIncluded") }}
      </div>

      <div class="max-h-80 space-y-2 overflow-y-auto">
        <div v-for="(it, i) in items" :key="i" class="space-y-0.5">
          <div class="flex items-baseline gap-1.5 text-[11px] text-[var(--gosslan-text-2)]">
            <span class="truncate font-medium" :title="it.sender">{{ it.sender }}</span>
            <span v-if="it.ts" class="shrink-0">{{ fmtConversationTime(it.ts) }}</span>
          </div>
          <div class="break-words whitespace-pre-wrap text-[13px] text-[var(--gosslan-text)]">
            <!-- 文本/代码给**全文**（详情页再截断就没有意义了）；媒体走占位行 -->
            <template v-if="it.kind === 'text' || it.kind === 'code'">{{ it.content }}</template>
            <template v-else>{{ mergeItemLine(it) }}</template>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
