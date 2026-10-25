/**
 * 主窗口入口（`index.html`）。
 *
 * ⚠️ **刻意不静态 import App / router / updater**：静态 import 会在本文件任何一行
 * 代码之前求值，只要模块图里有一处求值抛错，错误处理器就还没装上 —— 用户看到的
 * 是"骨架一直停在正在启动…"或白窗（2026-10-25 的真实缺陷）。
 *
 * 现在分两层：
 * 1. `boot-guard.js`（HTML 内联、零依赖）先捕获模块求值期异常并给出可见错误卡；
 * 2. 本文件再动态加载重图，失败时调同一个 `__gosslan_fail_boot`。
 */
async function bootMainWindow() {
  try {
    const [boot, appMod, routerMod, updaterMod, scheduleMod] = await Promise.all([
      import("@/boot/boot"),
      import("@/App.vue"),
      import("@/router/main"),
      import("@/updater/instance"),
      import("@/updater/schedule"),
    ]);
    boot.installFrontendErrorReporting();
    const app = boot.createWindowApp(appMod.default);
    app.use(routerMod.mainRouter);
    boot.mountMainWindow(app);
    const { updater } = updaterMod;
    const { scheduleAutoUpdateCheck } = scheduleMod;
    // 主界面已可操作后再异步检查一次；失败静默、无弹窗、无重试（离线零打扰）。
    scheduleAutoUpdateCheck(updater);
  } catch (e) {
    const detail =
      e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
    window.__gosslan_fail_boot?.("import", detail);
  }
}

void bootMainWindow();
