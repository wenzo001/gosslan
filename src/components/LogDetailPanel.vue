<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/i18n";
import { LOG_LEVEL_TEXT, stripTags } from "@/utils/logFilter";

/**
 * 选中日志行的详情（画板 `DesktopLogs` 的 detail 区）。
 *
 * 桌面宽窗贴**右侧**，窄窗与移动端落**底部**（画板宽度 760 下就是底部条）；
 * 位置只由 `placement` 决定，内容与桌面/移动两套外壳共用这一份，避免两份详情各写一遍。
 */
const props = defineProps<{
  row: { key: string; level: string; time: string; target: string; message: string; count: number };
  placement: "side" | "bottom";
}>();

const levelText = computed(() => LOG_LEVEL_TEXT[props.row.level] ?? props.row.level);
/** 行内的 target/message 带高亮标记（v-html），详情里是纯文本 ⇒ 先剥标记再渲染。 */
const target = computed(() => stripTags(props.row.target));
const message = computed(() => stripTags(props.row.message));
const pillClass = computed(() => (props.row.level === "error"
  ? "bg-[var(--gosslan-danger-soft)] text-[var(--gosslan-danger-ink)]"
  : props.row.level === "warn"
    ? "bg-[var(--gosslan-warning-soft)] text-[var(--gosslan-warning-text-ink)]"
    : "bg-[var(--gosslan-list)] text-[var(--gosslan-text-2)]"));
</script>

<template>
  <aside
    class="shrink-0 overflow-y-auto bg-[var(--gosslan-app-bg)]"
    :class="placement === 'side'
      ? 'w-[300px] border-l border-[var(--gosslan-divider)] px-3.5 py-3'
      : 'max-h-[40%] border-t border-[var(--gosslan-divider)] px-3.5 py-2.5'"
    :data-log-detail="placement"
  >
    <div class="flex items-center gap-2">
      <span
        class="shrink-0 rounded-[var(--gosslan-radius-sm)] px-1.5 py-0.5 text-caption font-semibold"
        :class="pillClass"
        data-log-detail-level
      >{{ levelText }}</span>
      <span
        class="min-w-0 flex-1 truncate font-mono text-caption text-[var(--gosslan-text-2)]"
        :title="`${target} · ${row.time}`"
      >{{ target }} · {{ row.time }}</span>
      <span
        v-if="row.count > 1"
        class="shrink-0 text-caption text-[var(--gosslan-text-2)]"
        :title="t('logs.mergedCount', { n: row.count })"
      >×{{ row.count }}</span>
    </div>
    <div
      class="mt-2 whitespace-pre-wrap break-all font-mono text-caption leading-relaxed text-[var(--gosslan-text)]"
      data-log-detail-message
    >{{ message }}</div>
  </aside>
</template>
