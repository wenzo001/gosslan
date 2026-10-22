import { ref } from "vue";
import {
  createRouter,
  createWebHashHistory,
  createWebHistory,
  type RouteRecordRaw,
  type RouterHistory,
} from "vue-router";

/**
 * 主窗口路由表。
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
    meta: { pane: "detail", tab: "favorites", depth: 0 },
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
    path: "/me",
    name: "me",
    component: RouteView,
    // 「我的」是主面板整页（旧实现 `selectMobileTab('me', 'chat')`），不是左侧列表。
    meta: { pane: "detail", tab: "me", depth: 0 },
  },
  {
    path: "/profile",
    name: "profile",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 1, overlay: true },
  },
  {
    path: "/settings",
    name: "settings",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 1, overlay: true },
  },
  {
    path: "/settings/:key",
    name: "settings-section",
    component: RouteView,
    meta: { pane: "detail", tab: "me", depth: 2, overlay: true },
  },
  {
    path: "/logs",
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
  { path: "/:pathMatch(.*)*", redirect: "/chats" },
];

/**
 * 自定义协议（`tauri://`）下 `pushState` 并非处处可用。
 *
 * 主选仍是 `createWebHistory`（保住 Android 的 wry 返回链），只在探测失败时退到
 * hash 模式 —— 后者同样产生真实历史条目，物理返回键不会失效。
 */
function canPushState(): boolean {
  try {
    window.history.replaceState(window.history.state, "", window.location.href);
    return true;
  } catch {
    return false;
  }
}

function pickHistory(): RouterHistory {
  // `tauri://`（macOS/Linux）与 `asset:` 的文档路径不是 SPA 服务器：
  // pushState 能不能用、刷新会不会 404 都未在真机验证。稳定优先 ⇒ 自定义协议直接走 hash
  // （hash 同样产生真实历史条目，Android 的 wry 返回链不受影响）。
  // Windows/Android 的 `http://tauri.localhost` 仍走 web history（用户裁决 3）。
  const customScheme =
    window.location.protocol === "tauri:" || window.location.protocol === "asset:";
  if (customScheme) return createWebHashHistory();
  return canPushState() ? createWebHistory() : createWebHashHistory();
}

export const mainRouter = createRouter({
  history: pickHistory(),
  routes: [...MAIN_ROUTES],
});

/** 进入方向：深→浅 = 反向转场。在导航确认前就写好，转场读到的不会慢一拍。 */
export const navigationDirection = ref<"forward" | "back">("forward");
mainRouter.beforeEach((to, from) => {
  const toDepth = Number(to.meta.depth ?? 0);
  const fromDepth = Number(from.meta.depth ?? 0);
  navigationDirection.value = toDepth < fromDepth ? "back" : "forward";
});
