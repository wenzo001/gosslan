/**
 * 自定义类型图标的**名字映射**（键名 → `Icon.vue` 的 registry 键）。
 *
 * 为什么不放进 `utils/todos.ts`：那份是纯逻辑册（Node 单测直接 import 它，见
 * `todos.test.ts` / `messageKinds.test.ts`）。本文件只登记字符串名、不 import 组件，
 * Node 判据不必解析 lucide 组件库 —— 本仓"决策与执行分两册"的立场
 * （`imageThumb.ts` 与 `imageThumbnail.ts`）就是为了这个。
 *
 * 键集合与 `TODO_CUSTOM_ICONS`（= Rust `TODO_CUSTOM_ICONS`）必须**一模一样**，
 * 由 `todoCustomIcons.test.ts` 双向对账：少一个键 ⇒ 白名单里的值渲染成空白；
 * 多一个键 ⇒ 选择器出现一个存不进载荷的选项（对端拿不到那个形状）。
 */
import type { IconName } from "@/components/ui/iconRegistry";
import type { TodoCustomIcon } from "./todos";

export const TODO_CUSTOM_ICON_NAMES: Record<TodoCustomIcon, IconName> = {
  tag: "tag",
  flag: "flag",
  star: "star",
  zap: "zap",
  wrench: "wrench",
  heart: "heart",
  book: "book-open",
  clock: "clock",
  target: "target",
  sparkles: "sparkles",
};

/** 选择器里的顺序 = 白名单顺序（同一份列表，不另写一份，见那条对账判据）。 */
export const TODO_CUSTOM_ICON_LABEL_KEY: Record<TodoCustomIcon, string> = {
  tag: "todo.icon.tag",
  flag: "todo.icon.flag",
  star: "todo.icon.star",
  zap: "todo.icon.zap",
  wrench: "todo.icon.wrench",
  heart: "todo.icon.heart",
  book: "todo.icon.book",
  clock: "todo.icon.clock",
  target: "todo.icon.target",
  sparkles: "todo.icon.sparkles",
};
