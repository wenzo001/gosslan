<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import Spinner from "@/components/ui/Spinner.vue";
/**
 * 公共异步状态块：加载 / 空 / 错误 + 重试。
 *
 * 存在的理由：2026-10-18 盘点发现 20 个文件里有 ≥5 套内联空态，
 * 而独立预览窗口在 IPC 失败或空相册时**完全不画东西**（只剩空壳）。
 * 这里先给辅助窗口一个统一落点；后续页面按同一入口迁移。
 *
 * 三种密度（不是为了好看，是因为它们真的在三种容器里）：
 * - 默认（完整）：整页/整栏的落点，`flex-1` 抢满剩余高度，图标 32px、`py-10`；
 * - `compact`：**弹窗内嵌列表**的落点（共享目录/群文件/诊断面板），`flex-none` + `py-8`，
 *   只有加载/错误出 16px 图标，空态保持一行字（原来这些位置的空态就是一行字），
 *   换过来不改变视觉密度，只把重试入口与 role 补齐；
 * - `inline`：**设置分组 / 摘要行**里的一行提示（群任务摘要、路由表与白名单空行）——
 *   单行、11px、不占独立高度，重试是一个文字链而不是按钮。这三种之外不许再写第四种内联状态。
 *
 * 动作落点：默认槽位放在结论/说明之后，用来放空态的主行动（「发起聊天」「添加好友」），
 * 这样按钮与状态是同一个组的成员，不会出现"状态一套、CTA 另一套"。
 */
import { computed } from "vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";

const props = withDefaults(
  defineProps<{
    kind: "loading" | "empty" | "error";
    title: string;
    detail?: string;
    retryLabel?: string;
    /** 弹窗内嵌列表：不抢整高、不画大图标（见文件头）。 */
    compact?: boolean;
    /** 设置分组 / 摘要行里的一行提示：单行、无独立高度（见文件头）。 */
    inline?: boolean;
  }>(),
  { detail: "", retryLabel: "", compact: false, inline: false },
);

defineEmits<{ retry: [] }>();

/**
 * 空态**不出图标**（2026-11-06）。
 *
 * 旧版对所有空态统一画一颗 `ImageOff`（"图片坏了"的图形）。日志为空、任务为空、
 * 通讯录为空，都不是"图片加载失败"，那颗图标既不对题，又让每个空态长得像同一张模板卡。
 * 空态收敛成「一行结论 + 可选一行说明」；加载与错误仍保留图标，因为那两种状态需要
 * 一眼分辨"还在转"和"出事了"。
 */
const showIcon = computed(() => props.kind !== "empty");

const titleClass = computed(() => {
  // 字号/字重只做两级：空态是正文档 + 中等字重；错误态靠颜色而不是加粗。
  // 非紧凑档用 `text-[length:…]` 显式声明**长度类型**：Tailwind 对裸的
  // `text-[var(--x)]` 分辨不出颜色还是字号，会编译成 `color: 14px`（无效值被丢弃）。
  const tone = props.kind === "error"
    ? "text-[var(--gosslan-danger-ink)]"
    : props.compact || props.inline
      ? "text-[var(--gosslan-text-2)]"
      : "text-[var(--gosslan-text)]";
  if (props.inline) return `text-caption ${tone}`;
  return props.compact
    ? `text-sm font-medium ${tone}`
    : `font-medium text-[length:var(--gosslan-text-body)] ${tone}`;
});

const boxClass = computed(() => {
  if (props.inline) return "inline-flex flex-wrap items-center gap-1.5 text-caption";
  return props.compact
    ? "flex flex-none flex-col items-center justify-center gap-2 py-8"
    : "flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10";
});

const iconClass = computed(() =>
  props.inline ? "h-3 w-3" : props.compact ? "h-4 w-4" : "h-8 w-8",
);
</script>

<template>
  <div
    :class="boxClass"
    :role="kind === 'error' ? 'alert' : 'status'"
    :aria-live="kind === 'loading' ? 'polite' : undefined"
  >
    <Spinner
      v-if="showIcon && kind === 'loading'"
      :size-class="iconClass"
      :class="inline ? '' : 'shrink-0'"
      class="text-[var(--gosslan-text-2)]"
    />
    <Icon name="alert-circle"
      v-else-if="showIcon"
      :class="[iconClass, inline ? '' : 'shrink-0']"
      class="text-[var(--gosslan-text-2)]"
      aria-hidden="true"
    />
    <span :class="[titleClass, inline ? '' : 'text-center']">{{ title }}</span>
    <span
      v-if="detail"
      class="text-[var(--gosslan-text-2)]"
      :class="inline ? 'text-caption' : 'max-w-[42ch] text-body leading-relaxed text-center'"
    >
      {{ detail }}
    </span>
    <button
      v-if="kind === 'error' && retryLabel && inline"
      type="button"
      class="tap-safe shrink-0 text-[var(--gosslan-primary)] underline-offset-2 hover:underline"
      @click="$emit('retry')"
    >
      {{ retryLabel }}
    </button>
    <PrimaryBtn v-else-if="kind === 'error' && retryLabel" shrink @click="$emit('retry')">
      <span class="inline-flex items-center gap-1.5">
        <Icon name="rotate-ccw" class="h-4 w-4" aria-hidden="true" />
        {{ retryLabel }}
      </span>
    </PrimaryBtn>
    <slot />
  </div>
</template>
