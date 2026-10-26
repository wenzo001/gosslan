import { onBeforeUnmount, watch } from "vue";
import { createBackStack, type HistoryPort } from "@/utils/backStack";

/**
 * 分层返回（Android 系统返回键 / 桌面"后退"导航）——**浏览器侧接线**。
 *
 * 为什么需要：应用是单页 WebView，页面层级（移动端列表↔聊天、整页设置、全屏日志、
 * 各种弹窗）全是组件状态而非路由。Android 的系统返回键由 wry 交给 WebView 处理：
 * `canGoBack()` 为真就 `goBack()`，否则**结束 Activity（退出应用）**
 * （wry `android/kotlin/WryActivity.kt` 的 `handleBackNavigation`）。
 * 于是今天在聊天页/设置页按返回 = 应用直接退出，这是最像"网页壳"、也最容易被判定为
 * "不是原生应用"的一处。
 *
 * 做法：每打开一层 UI 就压一条**同 URL**的历史条目，返回键于是变成 `popstate`；
 * 我们据此只关最上面那层。层关完（条目也回退干净）后 `canGoBack()` 变回 false，
 * 返回键才真的退出应用 —— 与原生 Android 一致。
 *
 * 决策逻辑在 `utils/backStack.ts`（纯逻辑、有单测）；这里只负责：压/退历史条目的
 * 浏览器适配、`popstate` 监听、以及跟着组件生命周期压栈退栈。
 *
 * 刻意不做：不引入路由（会动到所有现有交互）；不接管 iOS 侧滑返回（wry 未开启
 * `allowsBackForwardNavigationGestures`，iOS 用页面内返回按钮）；瞬时浮层
 * （表情面板、右键菜单）不压条目，否则返回键要按好几下才有反应。
 */

/**
 * 真实端口。
 *
 * ⚠️ `push` 必须如实回报**落点**（`pushState` / `hash`）：退化的 `location.hash = …`
 * 会**自己触发一次 `popstate`**（实测：设置 hash 同时触发 hashchange 与 popstate），
 * 纯逻辑要靠这个信息把那次 pop 吃掉 —— 否则"刚压入的那一层"会被立刻关掉，
 * 表现是弹窗一出现就消失（见 `utils/backStack.ts::HistoryPort.push`）。
 *
 * ⚠️ `back` 必须如实回报**退没退**：压入之后如果发生过导航（URL 变了），那条同 URL 条目
 * 已经变成合法的"后退到上一级"目标，此时**不能**退它 —— 退掉它等于把刚推进的页面撤销。
 * 这正是用户 2026-10-23 报的「加好友页点发起聊天没反应、人还停在通讯录」：弹窗释放时的
 * `history.back()` 排在 vue-router 写历史条目之后执行，把聊天页原路退了回去。
 */
/** 每一层压入成功时的 URL（`layerId → href`）—— 判"这条条目还在不在历史栈尖上"要按层比，
 *  只记最后一次压入的 URL 会让"弹窗套弹窗、中间发生过导航"的第二层拿不到判据。 */
const pushedHref = new Map<number, string>();

const browserPort: HistoryPort = {
  push(state: unknown): "pushState" | "hash" | null {
    const id = (state as { gosslanBackLayer: number }).gosslanBackLayer;
    try {
      history.pushState(state, "", location.href);
      pushedHref.set(id, location.href);
      return "pushState";
    } catch {
      /* 落到 hash 方案 */
    }
    try {
      location.hash = `gosslan-layer-${id}`;
      pushedHref.set(id, location.href); // hash 方案下 URL 变了，必须记压入**之后**的那一份
      return "hash";
    } catch {
      return null; // 两个都不行：不压条目，返回键行为退化为"直接退出"（不比现状差）
    }
  },
  back(layerId: number): boolean {
    const href = pushedHref.get(layerId);
    pushedHref.delete(layerId);
    // 没记到（不该发生）或压入之后导航过 ⇒ 都不退：宁可多一次返回键，也不能撤销一次跳转。
    if (href === undefined || location.href !== href) return false;
    try {
      history.back();
      return true;
    } catch {
      return false;
    }
  },
};

const stack = createBackStack(browserPort);
let installed = false;

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // 只听 popstate：pushState 与 hash 变化都会触发它，听两个事件会把一次返回处理两遍。
  window.addEventListener("popstate", () => {
    stack.onPop();
  });
}

/**
 * 把「一层 UI 是否打开」绑定到历史条目上。`active` 变真压条目，变假回收。
 *
 * ```ts
 * useBackLayer(() => app.isMobile && app.mobileView === "chat", () => (app.mobileView = "list"));
 * ```
 * 返回"手动释放"函数（组件卸载时自动调用）。
 */
export function useBackLayer(active: () => boolean, close: () => void): () => void {
  install();
  let release: (() => void) | null = null;

  watch(
    active,
    (on) => {
      if (on) {
        if (!release) release = stack.push(close);
      } else {
        release?.();
        release = null;
      }
    },
    { immediate: true },
  );

  const dispose = () => {
    release?.();
    release = null;
  };
  onBeforeUnmount(dispose);
  return dispose;
}
