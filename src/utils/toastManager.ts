import { createToastManager } from "reka-ui";

export type ToastKind = "success" | "error" | "info";

/** 错误要留够"读 + 听"的时间（读屏播报比扫一眼慢得多），成功/信息短一些免得挡住界面。 */
export const TOAST_MS: Record<ToastKind, number> = { success: 3000, info: 3000, error: 6000 };

/**
 * 每个 WebView 一份（模块级单例）：`ToastHud` 里的 `ToastProvider` 订阅它。
 * 业务侧只经过 `app.toast()`，数组、定时器、堆叠和停留计时都由 Reka Toast 接管。
 */
export const toastManager = createToastManager<{ kind: ToastKind }>();

/**
 * 同一 kind + 文案复用同一个 id：连续失败（例如反复点保存）只留一条并重置停留计时，
 * 不会把屏幕叠满。Reka 的 `add` 命中既有 id 时是原地更新 + 重启计时。
 */
export function pushToast(text: string, kind: ToastKind = "info") {
  toastManager.add({
    id: `${kind}:${text}`,
    title: text,
    status: kind,
    duration: TOAST_MS[kind],
    type: "background",
    data: { kind },
  });
}
