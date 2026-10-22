import { ref } from "vue";
import {
  createRouter,
  createWebHashHistory,
  createWebHistory,
  type RouterHistory,
} from "vue-router";
import { MAIN_ROUTES } from "./mainRoutes";

export { MAIN_ROUTES, type MainRouteName } from "./mainRoutes";

/**
 * 主窗口路由器。
 *
 * 路由表在 `mainRoutes.ts`（纯数据，可在 Node 里用 memory history 解析）；
 * 这里只负责 history 选择与导航方向。
 */

/**
 * 某些被沙箱化的 WebView 里 `pushState` 可能抛错；主选仍是 `createWebHistory`
 * （保住 Android 的 wry 返回链），只在探测失败时退到 hash 模式 —— 后者同样产生
 * 真实历史条目，物理返回键不会失效。这是防崩溃，不是按协议分流。
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
  // 用户 2026-10-22 裁决：统一走 web history（`tauri://` / `asset:` 也走）。
  // 只有 `pushState` 真的抛错（某些被沙箱化的 WebView）才退化到 hash —— 那是防崩溃，
  // 不是按协议分流；两条都会产生真实历史条目，Android 的 wry 返回链不受影响。
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
