<script setup lang="ts">
import { t } from "@/i18n";
import type { MergeableLogRow } from "@/utils/logFilter";

/**
 * 日志列表的**虚拟化正文**：桌面独立窗与移动端整页两种外壳共用这一份。
 *
 * 为什么必须是同一份（2026-10-29 审计 DUP-05）：两个外壳原先各抄一遍逐字相同的行模板
 * （4 个 `v-html` 落点 × 2）。行内容全部来自后端日志文本，改一处漏一处的后果不是报错，
 * 而是"同一个日志页在两种窗口里长得不一样 / 其中一种少转义"。
 *
 * ⚠️ `v-memo` 的依赖数组只能写在这一份里：它的语义是"这几个字符串没变就别重刷 innerHTML"，
 * 少一个字段 ⇒ 那个字段永远不刷新（日志每 2 秒轮询，症状是"看着没更新"）。
 * 新增渲染字段时**同时**加进 `memoDeps`。
 */
interface LogRenderRow extends MergeableLogRow {
  key: string;
  levelText: string;
  count: number;
}
interface VirtualItem {
  key: string;
  index: number;
  start: number;
  row: LogRenderRow;
}

defineProps<{
  items: VirtualItem[];
  totalSize: number;
  /** 行高实测：TanStack 的 `measureElement`，由外壳持有 virtualizer。 */
  measure: (el: Element | { $el?: Element } | null) => void;
}>();

/** 这一行渲染出来的全部内容 —— 也是 `v-memo` 唯一的判据来源。 */
function memoDeps(v: VirtualItem) {
  const r = v.row;
  return [r.time, r.levelText, r.target, r.message, r.level, r.count];
}

/** 级别 → 文字色（仅 level 列彩色，message 不继承） */
const levelTextClass = (lv: string) =>
  lv === "error"
    ? "text-[var(--gosslan-danger-ink)]"
    : lv === "warn"
      ? "text-[var(--gosslan-warning-ink)]"
      : "text-[var(--gosslan-text-2)]";

/** 级别 → 整行浅底色（hover 时叠加，error=浅红、warn=浅黄、其他=透明） */
const rowLevelBg = (lv: string) =>
  lv === "error"
    ? "bg-[var(--gosslan-danger-soft)]/60"
    : lv === "warn"
      ? "bg-[var(--gosslan-warning-soft)]/60"
      : "";
</script>

<template>
  <div :style="{ height: totalSize + 'px', position: 'relative' }">
    <div
      v-for="v in items"
      :key="v.key"
      :data-index="v.index"
      :ref="measure"
      :style="{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }"
    >
      <div
        v-memo="memoDeps(v)"
        class="flex gap-2 rounded px-1 py-0.5 transition"
        :class="[rowLevelBg(v.row.level), 'hover:bg-[var(--gosslan-hover)]']"
      >
        <span class="shrink-0 select-none text-[var(--gosslan-text-2)]" v-html="v.row.time"></span>
        <span class="w-12 shrink-0 select-none font-semibold" :class="levelTextClass(v.row.level)" v-html="v.row.levelText"></span>
        <span class="min-w-0 flex-1 break-all">
          <span class="text-[var(--gosslan-text-2)]" v-html="v.row.target"></span>
          <span v-html="v.row.message"></span>
        </span>
        <span
          v-if="v.row.count > 1"
          class="ml-1 shrink-0 text-caption font-medium text-[var(--gosslan-text-2)]"
          :title="t('logs.mergedCount', { n: v.row.count })"
        >
          ×{{ v.row.count }}
        </span>
      </div>
    </div>
  </div>
</template>
