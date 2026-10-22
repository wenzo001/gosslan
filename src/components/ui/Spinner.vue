<script setup lang="ts">
/**
 * 全应用唯一的加载指示器。
 *
 * 为什么收敛：reduce 档下旧的 `animate-spin` 会被全局 `animation-iteration-count: 1`
 * 冻成静止帧，"正在加载"与"卡死"不可区分。这里把旋转收在一个类里，reduce 档直接停掉
 * 动画，但保留 `role="status"` + 可访问名（旁边有文字的用 `decorative` 避免重复播报）。
 */
import { Loader2 } from "@/components/ui/icons";
import { t } from "@/i18n";

const props = withDefaults(
  defineProps<{
    sizeClass?: string;
    /** 可访问名；不传用 common.loading。 */
    label?: string;
    /** 旁边已有文字/父级 role=status 时设为 true：不重复进无障碍树。 */
    decorative?: boolean;
  }>(),
  { sizeClass: "h-4 w-4", label: "", decorative: false },
);
</script>

<template>
  <span
    :role="props.decorative ? undefined : 'status'"
    :aria-label="props.decorative ? undefined : (props.label || t('common.loading'))"
    :aria-hidden="props.decorative ? 'true' : undefined"
    :aria-busy="props.decorative ? undefined : 'true'"
    class="inline-flex items-center justify-center"
  >
    <Loader2 :class="props.sizeClass" class="spinner-icon shrink-0" :stroke-width="2" aria-hidden="true" />
    <span v-if="!props.decorative" class="sr-only">{{ props.label || t("common.loading") }}</span>
  </span>
</template>
