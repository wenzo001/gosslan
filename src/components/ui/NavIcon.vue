<script setup lang="ts">
/**
 * 一级导航图标的唯一渲染出口 —— PC 左侧栏与移动端底栏**都从这里渲染**。
 *
 * 造型统一走 `lucide-vue-next`（映射在 `ui/navIcons.ts`）：聊天 / 通讯录 / 收藏 / 链接
 * 四枚都是同一套线性图标。选中态由外层按钮的 `.nav-glyph-btn`（药丸底 + 主题色 + 弹簧）
 * 表达，不再自绘 path，也不再用"填充成实心"区分选中（描边库 fill 双人图标会糊成一团）。
 */
import { NAV_ICONS, type NavIconName } from "@/components/ui/navIcons";

const props = withDefaults(
  defineProps<{
    name: NavIconName;
    /** 选中态：描边加粗一档（底色与缩放由外层按钮统一定义）。 */
    active?: boolean;
    /** 尺寸档：栏位 22px（默认）、移动端底栏 20px。 */
    sizeClass?: string;
  }>(),
  { active: false, sizeClass: "h-[22px] w-[22px]" },
);
</script>

<template>
  <component
    :is="NAV_ICONS[props.name]"
    :class="props.sizeClass"
    class="nav-glyph"
    :stroke-width="props.active ? 2.35 : 1.9"
    :data-active="props.active ? 'true' : 'false'"
    aria-hidden="true"
  />
</template>
