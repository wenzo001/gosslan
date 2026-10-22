import {
  Compass,
  MessageCircle,
  Star,
  UsersRound,
  type LucideIcon,
} from "lucide-vue-next";

/**
 * 一级导航图标的唯一造型表：全部来自 `lucide-vue-next`。
 *
 * 放在独立 `.ts` 而不是 `<script setup>` 里：SFC 的 setup 块不允许 ES 模块导出，
 * 而类型与映射要被 `NavIcon.vue` 与判据共同消费。
 */
export type NavIconName = "chats" | "contacts" | "favorites" | "links";

export const NAV_ICONS: Record<NavIconName, LucideIcon> = {
  chats: MessageCircle,
  contacts: UsersRound,
  favorites: Star,
  links: Compass,
};
