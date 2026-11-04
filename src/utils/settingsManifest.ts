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

/**
 * 跨端兼容表（双向，唯一数据源）。
 *
 * 两端分区集合本来就不等价：桌面路由有复数 `notifications`，移动端只有单数
 * `notification`；移动端有 `chatStyle`，桌面把它放在 `general` 容器里。
 * 这里只表达「在某端不存在时，另一端从哪里能看懂地接住」，不强行合并两端的
 * 功能集合，也不改变任何一端的界面结构。
 */
export const DESKTOP_ONLY_SECTIONS = {
  /** 桌面路由键 → 移动端落点 */
  notifications: "notification",
} as const satisfies Record<string, MobileSectionKey>;

export const MOBILE_ONLY_SECTIONS = {
  /** 移动端分区键 → 桌面路由键（落到包含该内容的容器） */
  notification: "notifications",
  chatStyle: "general",
} as const satisfies Record<string, RouteSectionKey>;

/** 未知/不存在分区的统一回落点：两端共有且一定存在。 */
export const DEFAULT_MOBILE_SECTION: MobileSectionKey = "general";
export const DEFAULT_DESKTOP_ROUTE: RouteSectionKey = "general";

/** 桌面路由键 → 落点文案键（toast 用，按分区条目名而不是容器名，落点更具体）。 */
export const DESKTOP_ROUTE_TITLE_BY_KEY: Record<RouteSectionKey, string> = {
  profile: "settings.item.profile",
  general: "settings.item.general",
  notifications: "settings.group.notifications",
  appearance: "settings.item.appearance",
  network: "settings.item.network",
  files: "settings.item.storageFiles",
  storage: "settings.item.storageFiles",
  storageFiles: "settings.item.storageFiles",
  security: "settings.item.about",
  about: "settings.item.about",
  reset: "settings.item.reset",
};

/** 一次分区解析的结果：`key` 一定是目标端真实存在的分区，调用方不需要再判空。 */
export type SectionResolution<K extends string> = {
  key: K;
  /** 原键直接命中目标端清单。 */
  known: boolean;
  /** 经过旧别名或跨端兼容表命中。 */
  aliased: boolean;
  /** 原键无法识别，已回落到默认分区。 */
  fallback: boolean;
};

function hasMobileSection(key: string): key is MobileSectionKey {
  return (MOBILE_SECTIONS as readonly { key: string }[]).some((s) => s.key === key);
}

/** 移动端分区解析：旧别名 → 跨端兼容 → 默认分区，永远返回可渲染的 key。 */
export function resolveMobileSectionKey(raw: string): SectionResolution<MobileSectionKey> {
  const key = raw ?? "";
  if (hasMobileSection(key)) {
    return { key, known: true, aliased: false, fallback: false };
  }
  const mapped =
    (MOBILE_ALIASES as Record<string, string>)[key] ??
    (DESKTOP_ONLY_SECTIONS as Record<string, string>)[key];
  if (mapped && hasMobileSection(mapped)) {
    return { key: mapped, known: false, aliased: true, fallback: false };
  }
  return { key: DEFAULT_MOBILE_SECTION, known: false, aliased: false, fallback: true };
}

/** 桌面路由键解析：跨端兼容 → 默认路由，永远返回 4 容器里的合法路由键。 */
export function resolveDesktopRouteKey(raw: string): SectionResolution<RouteSectionKey> {
  const key = raw ?? "";
  if ((ROUTE_SECTIONS as readonly string[]).includes(key)) {
    return { key: key as RouteSectionKey, known: true, aliased: false, fallback: false };
  }
  const mapped = (MOBILE_ONLY_SECTIONS as Record<string, RouteSectionKey>)[key];
  if (mapped) {
    return { key: mapped, known: false, aliased: true, fallback: false };
  }
  return { key: DEFAULT_DESKTOP_ROUTE, known: false, aliased: false, fallback: true };
}

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
