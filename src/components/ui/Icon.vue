<script setup lang="ts">
/**
 * 全应用图标的**唯一渲染出口**：桌面 rail / 移动 tab / 头部 / 各独立窗口都走这里。
 *
 * 造型统一来自 `lucide-vue-next`（登记在 `iconRegistry.ts`），画板 IconSet 的约束：
 * 24 网格、2px 圆头描边、16px 档降到 1.8px；尺寸只允许 16 / 20 / 24 三档。
 * 同屏不混用线性与填充——lucide 全是线性，选中态由外层底色表达。
 */
import { computed } from "vue";
import { ICON_COMPONENTS, type IconName } from "@/components/ui/iconRegistry";

defineOptions({ inheritAttrs: true });

const props = withDefaults(
  defineProps<{
    /** registry 里的 kebab 名，例如 "arrow-left"。 */
    name: IconName;
    /** 只允许三档：16（内联）/ 20（控件与头部）/ 24（导航）。 */
    size?: 16 | 20 | 24;
    /** 有可读语义时传（例如按钮只有图标），否则 aria-hidden。 */
    label?: string;
  }>(),
  { size: 20, label: "" },
);

const icon = computed(() => ICON_COMPONENTS[props.name]);
const strokeWidth = computed(() => (props.size === 16 ? 1.8 : 2));
/** 有 label 时当图片读；没有就整枚隐藏（lucide 默认 `aria-hidden` 是布尔值）。 */
const a11y = computed<Record<string, string | boolean | undefined>>(() =>
  props.label
    ? { role: "img", "aria-label": props.label }
    : { "aria-hidden": true },
);
</script>

<template>
  <component
    :is="icon"
    :size="props.size"
    :stroke-width="strokeWidth"
    v-bind="a11y"
  />
</template>
