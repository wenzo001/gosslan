/**
 * 应用内「减少透明效果」开关（用户 2026-11-05 批准）。
 *
 * 为什么必须自己做：WKWebView 不实现 CSS 的 `prefers-reduced-transparency`
 * （macOS 的系统偏好传不到 WebView），所以系统级媒体查询在苹果端恒为 false。
 * 这里用 `<html data-reduced-transparency="true">` 作为唯一开关；`style.css` 只复用
 * **已有的**玻璃实底 token（`--gosslan-glass-*-fallback`），不另造一套配色。
 *
 * 默认跟随系统：能读到系统偏好就用它；读不到（旧 WebView / 纯浏览器）按「关闭」。
 * `null` 表示用户从未显式选择过 —— 这种状态不落库，重启后继续跟随系统；
 * 一旦用户在设置里选了任一档，就以显式值为准。
 */
import { storageGet, storageRemove, storageSet } from "./safeStorage.ts";

/** localStorage 键（只作启动首帧快路径，真值在后端 settings 的 `reduced_transparency`）。 */
export const REDUCED_TRANSPARENCY_STORAGE_KEY = "gosslan.reducedTransparency";

/** `<html>` 上的开关属性；CSS 只认这一个属性（不另加类名）。 */
export const REDUCED_TRANSPARENCY_ATTR = "data-reduced-transparency";

/** 存储值只有 "true" / "false" 两种；其它（含缺失）= 从未选择过。 */
export function parseStoredReducedTransparency(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function readStoredReducedTransparency(): boolean | null {
  return parseStoredReducedTransparency(storageGet(REDUCED_TRANSPARENCY_STORAGE_KEY));
}

export function saveStoredReducedTransparency(v: boolean | null): void {
  if (v === null) storageRemove(REDUCED_TRANSPARENCY_STORAGE_KEY);
  else storageSet(REDUCED_TRANSPARENCY_STORAGE_KEY, v ? "true" : "false");
}

/**
 * 系统是否要求减少透明。`matchMedia` 在不支持该特性的 WebView 里返回 `matches=false`
 * （不会报错），即「读不到 → 关闭」；个别内核可能对未知特性抛错，一并按关闭处理。
 */
export function systemPrefersReducedTransparency(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  } catch {
    return false;
  }
}

/** 显式选择优先；从未选择时跟随系统（读不到系统偏好 → 关闭）。 */
export function resolveReducedTransparency(
  explicit: boolean | null,
  system: boolean = systemPrefersReducedTransparency(),
): boolean {
  return explicit ?? system;
}

/**
 * 应用开关：写 `<html>` 属性（CSS 退实底）。
 *
 * ⚠️ 不再连带冻结背景动效（2026-11-07 用户 Windows 读数触发的口径修正）：
 * 「减少透明」只该管玻璃/模糊这一层；雾要不要飘归「背景动效」开关与
 * `prefers-reduced-motion` 管。两条绑在一起时，Windows 关掉系统「透明效果」
 * 会让整个动态背景消失 —— 用户看到的就是"动效出不来"。
 */
export function applyReducedTransparency(on: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(REDUCED_TRANSPARENCY_ATTR, String(on));
}

/** 每个窗口启动时调用一次（必须在 `installAmbient()` 之前，否则首帧会闪一下色雾）。 */
export function installReducedTransparency(): void {
  applyReducedTransparency(resolveReducedTransparency(readStoredReducedTransparency()));
}
