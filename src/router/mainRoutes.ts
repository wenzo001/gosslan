import type { RouteRecordRaw } from "vue-router";

/**
 * 主窗口路由表（纯数据，不碰 `window` / `history`，可在 Node 里直接做解析测试）。
 *
 * 这里只有路径/元数据，**不挂页面组件**：页面级渲染仍由 `ResponsiveLayout`
 * 的那条内容链决定。路由的职责是「哪一层被打开」这件事有唯一真相源：
 * 可寻址、可深链、Android 物理返回与桌面返回键都由它驱动。
 *
 * `meta.pane`：移动端该路由落在列表（list）还是详情（chat）面板。
 * `meta.overlay`：整页覆盖层。它不改变底层 tab / 面板，返回时回到进入前那一页。
 * `meta.depth`：层级深度。路由返回时据此判断进场方向（深→浅 = 反向转场）。
 * `meta.tab`：侧边栏/底栏高亮所属的一级域。
 */
export type MainRouteName =
  | "chats"
  | "conversation"
  | "contacts"
  | "friend"
  | "requests"
  | "favorites"
  | "favorite"
  | "links"
  | "me"
  | "profile"
  | "settings"
  | "settings-section"
  | "logs"
  | "search";

/** 路由只承载层级与元数据，页面渲染仍在 `ResponsiveLayout`；空视图满足 RouteRecord 类型。 */
const RouteView = { name: "RouteView", render: () => null };

export const MAIN_ROUTES: RouteRecordRaw[] = [
  { path: "/", redirect: "/chats" },
  { path: "/index.html", redirect: "/chats" },
  {
    path: "/chats",
    name: "chats",
    component: RouteView,
    meta: { pane: "list", tab: "chats", depth: 0 },
  },
  {
    path: "/chats/:convId",
    name: "conversation",
    component: RouteView,
    meta: { pane: "detail", tab: "chats", depth: 1 },
  },
  {
    path: "/contacts",
    name: "contacts",
    component: RouteView,
    meta: { pane: "list", tab: "contacts", depth: 0 },
  },
  {
    path: "/contacts/requests",
    name: "requests",
    component: RouteView,
    meta: { pane: "detail", tab: "contacts", depth: 1 },
  },
  {
    path: "/contacts/:friendId",
    name: "friend",
    component: RouteView,
    meta: { pane: "detail", tab: "contacts", depth: 1 },
  },
  {
    path: "/favorites",
    name: "favorites",
    component: RouteView,
    // 一级 tab 与聊天/通讯录列表同构：列表是 list，详情才进 detail。
    // 这样底栏显示条件不需要再为收藏开特例，点收藏也不会把别的一级菜单挡掉。
    meta: { pane: "list", tab: "favorites", depth: 0 },
  },
  {
    path: "/favorites/:favId",
    name: "favorite",
    component: RouteView,
    meta: { pane: "detail", tab: "favorites", depth: 1 },
  },
  {
    path: "/links",
    name: "links",
    component: RouteView,
    meta: { pane: "detail", tab: "links", depth: 1 },
  },
  {
    // 移动端「我的 → 链接」；桌面仍用 /links（rail 一级入口），见 ResponsiveLayout 的平台归一。
    path: "/me/links",
    name: "me-links",
    component: RouteView,
    meta: { pane: "detail", tab: "links", depth: 2 },
  },
  {
    path: "/me",
    name: "me",
    component: RouteView,
    // 「我的」是主面板整页（旧实现 `selectMobileTab('me', 'chat')`），不是左侧列表。
    meta: { pane: "detail", tab: "me", depth: 0 },
  },
  {
    path: "/me/profile",
    name: "profile",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 1, overlay: true },
  },
  {
    path: "/me/settings",
    name: "settings",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 1, overlay: true },
  },
  {
    path: "/me/settings/:key",
    name: "settings-section",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 2, overlay: true },
  },
  {
    path: "/me/logs",
    name: "logs",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 1, overlay: true },
  },
  {
    path: "/search",
    name: "search",
    component: RouteView,
    meta: { pane: "list", tab: "chats", depth: 1, overlay: true },
  },
  // 旧版深链兼容：/profile 曾是主窗口一级路径，/settings、/logs 曾是移动端旧入口。
  // 保留静态重定向，外部书签/旧日志里的链接不会落到 catch-all 被静默吞成聊天页。
  { path: "/profile", redirect: "/me/profile" },
  { path: "/settings", redirect: "/me/settings" },
  {
    path: "/settings/:key",
    redirect: (to) => ({ path: `/me/settings/${String(to.params.key ?? "")}` }),
  },
  { path: "/logs", redirect: "/me/logs" },
  { path: "/:pathMatch(.*)*", redirect: "/chats" },
];
