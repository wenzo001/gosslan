<script setup lang="ts">
/**
 * 全应用图标的**唯一渲染出口**：桌面 rail / 移动 tab / 头部 / 各独立窗口都走这里。
 *
 * 造型统一来自 `lucide-vue-next`（登记在 `iconRegistry.ts`），画板 IconSet 的约束：
 * 24 网格、2px 圆头描边。尺寸**只走消费方的 class**（`h-4 w-4`=16、`h-5 w-5`=20、
 * `size-6`=24、导航 23/21），这里只声明一个 20px 的兜底盒尺寸。
 *
 * ⚠️ 2026-11-07 取消 `size` prop 与 16px 降描边（M-5）：`size={16|20|24}` 三档从来没有
 * 真实调用点（191 个 `<Icon>` 里 137 个用 `h-*` 覆盖），`size === 16 ? 1.8 : 2` 分支永不
 * 执行 ⇒ 文档写的 1.8 与实际恒定的 2 是两条平行定义。收敛后只剩一条：盒尺寸由 class
 * 决定、描边由 lucide 的 2px 决定；个别强调处（回执错误 2.5、群任务 2.2、导航选中 2.35）
 * 用 `:stroke-width` 显式覆盖，仍然有效（父级 attrs 覆盖组件内绑定）。
 * 同屏不混用线性与填充——lucide 全是线性，选中态由外层底色表达。
 */
import { computed } from "vue";
import { ICON_COMPONENTS, type IconName } from "@/components/ui/iconRegistry";

defineOptions({ inheritAttrs: true });

const props = withDefaults(
  defineProps<{
    /** registry 里的 kebab 名，例如 "arrow-left"。 */
    name: IconName;
    /** 有可读语义时传（例如按钮只有图标），否则 aria-hidden。 */
    label?: string;
  }>(),
  { label: "" },
);

const icon = computed(() => ICON_COMPONENTS[props.name]);
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
    :size="20"
    v-bind="a11y"
  />
</template>
