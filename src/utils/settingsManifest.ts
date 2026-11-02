/**
 * 设置分区的**纯数据清单**（批次 1B）。
 *
 * 这里只放 key / 文案键 / 分组 / 别名 / 容器映射，**不 import 任何 Vue 组件**。
 * 两个外壳（SettingsPanel / SettingsWindow）保留自己的组件渲染映射，消费本文件的数据。
 *
 * 三份键集本来就不等价，不能合并成一份：
 *  · 移动端有 `chatStyle` 与单数 `notification`；
 *  · 独立设置窗口路由有复数 `notifications`，没有 `chatStyle` / 单数 `notification`；
 *  · 桌面 4 容器只认 `general / network / storageFiles / about`，旧键走别名/默认容器。
 * 任何“看起来可以合并”的改动都必须先过 `settingsStructure.test.ts` 的深链矩阵。
 */

export type MobileSectionKey =
  | "profile"
  | "general"
  | "appearance"
  | "chatStyle"
  | "notification"
  | "network"
  | "storageFiles"
  | "about"
  | "reset";

export type RouteSectionKey =
  | "profile"
  | "general"
  | "notifications"
  | "appearance"
  | "network"
  | "files"
  | "storage"
  | "storageFiles"
  | "security"
  | "about"
  | "reset";

export type DesktopContainer = "general" | "network" | "storageFiles" | "about";

export type DesktopIconKey = "sliders" | "wifi" | "storage" | "info";

/** 移动端二级页：key、标题键、所属分组（按界面顺序）。 */
export const MOBILE_SECTIONS = [
  { key: "profile", titleKey: "settings.item.profile", group: "general" },
  { key: "general", titleKey: "settings.item.general", group: "general" },
  { key: "appearance", titleKey: "settings.item.appearance", group: "general" },
  { key: "chatStyle", titleKey: "settings.item.chatStyle", group: "general" },
  { key: "notification", titleKey: "settings.item.notification", group: "general" },
  { key: "network", titleKey: "settings.item.network", group: "network" },
  { key: "storageFiles", titleKey: "settings.item.storageFiles", group: "storageFiles" },
  { key: "about", titleKey: "settings.item.about", group: "about" },
  { key: "reset", titleKey: "settings.item.reset", group: "storageFiles" },
] as const satisfies readonly {
  key: MobileSectionKey;
  titleKey: string;
  group: string;
}[];

/** key → 条目文案键；由 MOBILE_SECTIONS 现推，不手抄第二份。 */
export const MOBILE_TITLE_BY_KEY: Record<MobileSectionKey, string> = Object.fromEntries(
  MOBILE_SECTIONS.map((s) => [s.key, s.titleKey]),
) as Record<MobileSectionKey, string>;

/** 移动端一级列表：组顺序与组内条目顺序就是界面顺序。 */
export const MOBILE_GROUPS = [
  {
    key: "general",
    titleKey: "settings.group.general",
    items: ["profile", "general", "appearance", "chatStyle", "notification"],
  },
  { key: "network", titleKey: "settings.item.network", items: ["network"] },
  { key: "storageFiles", titleKey: "settings.item.storageFiles", items: ["storageFiles", "reset"] },
  { key: "about", titleKey: "settings.item.about", items: ["about"] },
] as const satisfies readonly {
  key: string;
  titleKey: string;
  items: readonly MobileSectionKey[];
}[];

/** 移动端旧深链键 → 新二级页。 */
export const MOBILE_ALIASES = {
  storage: "storageFiles",
  files: "storageFiles",
  security: "about",
} as const satisfies Record<string, MobileSectionKey>;

/** 独立设置窗口的有效路由键（顺序与旧实现一致）。 */
export const ROUTE_SECTIONS = [
  "profile",
  "general",
  "notifications",
  "appearance",
  "network",
  "files",
  "storage",
  "storageFiles",
  "security",
  "about",
  "reset",
] as const satisfies readonly RouteSectionKey[];

/** 路由键 → 桌面 4 容器。旧键保留，未知键由函数兜底到 general。 */
export const DESKTOP_CONTAINER_BY_ROUTE: Record<RouteSectionKey, DesktopContainer> = {
  profile: "general",
  general: "general",
  notifications: "general",
  appearance: "general",
  network: "network",
  files: "storageFiles",
  storage: "storageFiles",
  storageFiles: "storageFiles",
  security: "about",
  about: "about",
  reset: "storageFiles",
};

/** 桌面左侧导航（顺序即界面顺序）。 */
export const DESKTOP_NAV = [
  { key: "general", labelKey: "settings.group.general", iconKey: "sliders" },
  { key: "network", labelKey: "settings.item.network", iconKey: "wifi" },
  { key: "storageFiles", labelKey: "settings.item.storageFiles", iconKey: "storage" },
  { key: "about", labelKey: "settings.item.about", iconKey: "info" },
] as const satisfies readonly {
  key: DesktopContainer;
  labelKey: string;
  iconKey: DesktopIconKey;
}[];

/** 移动端旧键归一；未知键原样返回，由调用方判 SECTIONS 是否存在。 */
export function normalizeMobileSectionKey(key: string): string {
  return (MOBILE_ALIASES as Record<string, string>)[key] ?? key;
}

/** 路由键 → 桌面容器；未知键与旧实现一致落到 general。 */
export function desktopContainerForRoute(key: string): DesktopContainer {
  return (DESKTOP_CONTAINER_BY_ROUTE as Record<string, DesktopContainer>)[key] ?? "general";
}
