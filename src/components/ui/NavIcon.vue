<script setup lang="ts">
/**
 * 一级导航图标的唯一渲染出口 —— PC 左侧栏与移动端底栏**都从这里渲染**。
 *
 * 造型统一走 `Icon.vue`（名字映射在 `ui/navIcons.ts`）：聊天 / 通讯录 / 收藏 / 链接
 * 四枚都是画板 IconSet 的同一套轮廓。选中态由外层按钮的 `.nav-glyph-btn`（药丸底 +
 * 主题色 + 弹簧）表达，不再自绘 path，也不用"填充成实心"区分选中。
 */
import Icon from "@/components/ui/Icon.vue";
import { NAV_ICONS, NAV_ICON_SIZE_CLASS, type NavIconName } from "@/components/ui/navIcons";

const props = withDefaults(
  defineProps<{
    name: NavIconName;
    /** 选中态：底色与缩放由外层按钮统一定义（这里只留数据钩子）。 */
    active?: boolean;
    /** 尺寸档：桌面 rail 23px（默认）、移动端底栏 21px。 */
    variant?: "rail" | "tab";
  }>(),
  { active: false, variant: "rail" },
);
</script>

<template>
  <Icon
    :name="NAV_ICONS[props.name]"
    :size="24"
    :class="[NAV_ICON_SIZE_CLASS[props.variant], 'nav-glyph']"
    :data-active="props.active ? 'true' : 'false'"
  />
</template>
