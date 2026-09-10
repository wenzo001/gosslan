// 触觉反馈（Haptics）。
//
// 依据 Apple HIG 的触觉词汇与时机：
//   - **按下即反馈**，不是松手才反馈（Button press → impact，在 touch-down）；
//   - **按语义分轻重**：轻点/选中/成功/失败用不同"重量"，不能一律一个震法；
//   - **不是每个点击都给**——只在关键动作与状态变化给，否则用户很快就麻木了。
//
// 平台差异（重要，别把它当成"iOS 级触觉"）：
//   - Android WebView：支持 `navigator.vibrate`，但需在 AndroidManifest 声明 VIBRATE 权限；
//     粒度只有"时长/节奏"，拿不到 iOS 的 light/medium/heavy 质感。
//   - iOS（WKWebView）：**不支持** `navigator.vibrate`，这里会安静地 no-op；
//     iOS 真触觉得走原生 UIFeedbackGenerator，需要 Tauri 插件或平台代码（后续项）。
//   - 桌面：无此 API → no-op。
//
// 因此本模块的定位是"在支持的平台上给一点节奏感"，缺平台不会报错、也不影响任何主流程。

/** 与 iOS 触觉词汇对应的语义（Android 侧用时长/节奏近似表达）。 */
export type HapticKind =
  | "light" // 轻点：普通按钮按下
  | "medium" // 实心一点：提交类动作
  | "heavy" // 重：长按菜单弹出、删除确认
  | "rigid" // 脆：精确选择
  | "selection" // 选择变化：切会话、切选项
  | "success" // 成功：两段轻震（对应 iOS 的 success 两下）
  | "warning" // 警告：两段稍重
  | "error"; // 失败：三连震（对应 iOS 的 error 三下）

/** 时长/节奏映射（ms）。数值是近似，够用即可，不追求与 iOS 的触感一一对应。 */
const PATTERN: Record<HapticKind, number | number[]> = {
  light: 8,
  medium: 12,
  heavy: 20,
  rigid: 6,
  selection: 6,
  success: [8, 40, 12],
  warning: [14, 60, 14],
  error: [22, 60, 22, 60, 22],
};

/** 是否尊重"减弱动态效果"：这类用户对感官刺激更敏感，触觉一并关掉。 */
function reduceMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * 触发一次触觉反馈。不支持的平台（iOS / 桌面）与失败情况都静默返回——
 * 触觉永远不能影响主流程。
 */
export function haptic(kind: HapticKind = "light"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (reduceMotion()) return;
  try {
    navigator.vibrate(PATTERN[kind]);
  } catch {
    /* 忽略：无 VIBRATE 权限 / 被系统策略拦截等 */
  }
}
