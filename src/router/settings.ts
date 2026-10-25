import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";

/**
 * 设置窗口（`settings.html`）的独立路由。
 *
 * 用 hash 而不是 history：这个窗口的 URL 是 `settings.html`，path 模式会在重启/刷新时
 * 落到一个不存在的文档路径上。hash 同样有真实历史条目与返回语义，且与主窗口的
 * history 决策互不影响（每个窗口本来就是独立 app）。
 */
export const SETTINGS_SECTIONS = [
  "profile",
  "general",
  "notifications",
  "appearance",
  "network",
  "files",
  "storage",
  // 2026-10-25：存储与文件合并成一个二级页（旧键保留，深链仍可达）。
  "storageFiles",
  "security",
  "about",
  "reset",
] as const;

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number];

const RouteView = { name: "SettingsRouteView", render: () => null };

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/settings/profile" },
  { path: "/settings.html", redirect: "/settings/profile" },
  {
    path: "/settings/:key",
    name: "settings-section",
    component: RouteView,
    meta: { depth: 1 },
  },
  { path: "/:pathMatch(.*)*", redirect: "/settings/profile" },
];

export const settingsRouter = createRouter({
  history: createWebHashHistory(),
  routes,
});
