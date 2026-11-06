import type { IconName } from "@/components/ui/iconRegistry";

/**
 * 一级导航图标的唯一造型表：只登记画板 IconSet 的四枚侧栏轮廓。
 *
 * 这里不再自绘 path，也不另起一套图标名 —— 名字必须是 `iconRegistry` 里已有的
 * kebab 键，`NavIcon.vue` 与所有普通图标走同一个 `Icon.vue` 出口。
 *
 * 画板对应：会话 = 气泡、通讯录 = 双人、收藏 = 书签（不是星标）、链接 = 链环。
 */
export type NavIconName = "chats" | "contacts" | "favorites" | "links";

export const NAV_ICONS: Record<NavIconName, IconName> = {
  chats: "message-circle",
  contacts: "users-round",
  favorites: "bookmark",
  links: "link2",
};

/**
 * 画板尺寸档：桌面 rail 23px、移动底栏 21px。
 *
 * 这两档不挤进 `Icon.vue` 的 16/20/24 —— 导航是画板单列的一组刻度，
 * 用 class 覆盖 SVG 尺寸，线宽仍是统一的 2（选中态由外层药丸底色表达，不再加粗）。
 */
export const NAV_ICON_SIZE_CLASS = {
  rail: "h-[23px] w-[23px]",
  tab: "h-[21px] w-[21px]",
} as const;
