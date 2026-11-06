import { createToastManager } from "reka-ui";

export type ToastKind = "success" | "error" | "info";

/** 错误要留够"读 + 听"的时间（读屏播报比扫一眼慢得多），成功/信息短一些免得挡住界面。 */
export const TOAST_MS: Record<ToastKind, number> = { success: 3000, info: 3000, error: 6000 };

/**
 * 每个 WebView 一份（模块级单例）：`ToastHud` 里的 `ToastProvider` 订阅它。
 * 业务侧只经过 `app.toast()`，数组、定时器、堆叠和停留计时都由 Reka Toast 接管。
 */

/** toast 上一个可点的按钮（只用于"说得出下一步"的失败，不是通用动作栏）。 */
export type ToastAction = {
  label: string;
  run: () => void;
};

export type ToastData = {
  kind: ToastKind;
  action?: ToastAction;
  /** 同 key 连续出现的次数；>1 时在条上显示「×N」，不另叠一条（A1 裁决 2026-11-06）。 */
  count?: number;
};

export const toastManager = createToastManager<ToastData>();

/**
 * 合并计数：只记「当前还挂着的那一条」出现了几次。
 * 条被关掉时由 `ToastList` 在 `update:open === false` 时调 `releaseToastCount` 清掉，
 * 下一次同 key 从 ×1 重新起算。
 *
 * ⚠️ 不能用 `@close`：Reka 的 `ToastRoot` 只发
 * `update:open / pause / resume / escapeKeyDown / swipe*`，**没有 `close`** ——
 * 旧写法看着能编译，实际永不触发，`×N` 全会话只增不减。
 */
const repeatCount = new Map<string, number>();

/** 某条 toast 当前的累计次数（界面 `×N` 的数据源；单测也读这一格）。 */
export function toastCountOf(id: string): number {
  return repeatCount.get(id) ?? 0;
}

/** 某条 toast 关闭（到点/手动/Esc/滑动）后清掉它的计数。 */
export function releaseToastCount(id: string) {
  repeatCount.delete(id);
}

/**
 * 同一 kind + 文案复用同一个 id：连续失败（例如反复点保存）只留一条并重置停留计时，
 * 不会把屏幕叠满。Reka 的 `add` 命中既有 id 时是原地更新 + 重启计时。
 *
 * A1（2026-11-06 裁决）：重复次数不再靠「多一条」表达，而是在原条上累加 `count`，
 * 由 `ToastList` 显示成「×2」。这样信息量保住了，屏幕也不会越叠越高。
 */
export function pushToast(text: string, kind: ToastKind = "info", action?: ToastAction) {
  const id = `${kind}:${text}`;
  const count = toastCountOf(id) + 1;
  repeatCount.set(id, count);
  toastManager.add({
    id,
    title: text,
    // 带按钮的那条要留够时间让用户点（错误本来就是 6s，这里再抬一档）。
    duration: action ? TOAST_MS.error * 2 : TOAST_MS[kind],
    status: kind,
    type: "background",
    data: action ? { kind, action, count } : { kind, count },
  });
}
