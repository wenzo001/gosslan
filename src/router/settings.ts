import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";
import { ROUTE_SECTIONS } from "@/utils/settingsManifest";

/**
 * 设置窗口（`settings.html`）的独立路由。
 *
 * 用 hash 而不是 history：这个窗口的 URL 是 `settings.html`，path 模式会在重启/刷新时
 * 落到一个不存在的文档路径上。hash 同样有真实历史条目与返回语义，且与主窗口的
 * history 决策互不影响（每个窗口本来就是独立 app）。
 */
// 2026-10-25（第 4 版）：存储、文件、重置与恢复同属「文件与存储」二级页
// （旧键保留，深链仍可达）。清单的唯一数据源在 `utils/settingsManifest.ts`。
export const SETTINGS_SECTIONS = ROUTE_SECTIONS;

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
