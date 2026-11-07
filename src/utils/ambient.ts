/**
 * 环境动态层（AM-01…AM-12，规格见 docs/design-language/ambient-motion.md）。
 *
 * 分层：这一层挂在 `<body>` 直属、`#app` 之前，`z-index: -1`。
 * 规格写的是 0；这里用 -1 是同一层级的等价写法 —— `#app` 没有建立新的 stacking context，
 * z-index 0 的定位层会盖在**非定位正文**之上（不是只盖背景），所以只能是负值。
 * 画面语义没变：#app 里透明的画布露出它，实色内容（气泡/卡片/输入框）压在它上面。
 *
 * 约束（任何一条都不许在本文件里被"优化"掉）：
 *   · 只有 transform / opacity 进入动画；不碰 filter / background-position / 背景函数（AM-03）。
 *   · 不建 rAF / setInterval 循环，涟漪也是每次交互一个定时器（AM-04）。
 *   · 不在 JS 里吐 `canvas` / `getImageData` 等逐帧像素路径（AM-04 扫描口径）。
 *   · 页面隐藏时暂停（AM-05）；reduce 档冻结而不是减速（AM-06）。
 *
 * ## 三层优先级（2026-11-07 定，用户 Windows 读数触发）
 *
 * 系统 `prefers-reduced-transparency: reduce`（Windows 关掉"透明效果"）**只**降级玻璃/模糊，
 * 不再连带关闭背景漂移；`prefers-reduced-motion: reduce` 仍然冻结动效（那是它的本意）。
 * 软件内开关优先于系统偏好，系统偏好只在用户从未动过开关时作为初始默认：
 *
 *   软件显式（存了 "off" / "drift"） > 系统 media query > 内置默认（drift，低端机降 static）
 *
 * `readStoredAmbientRaw()` 返回 `null` = 从未设过；`readStoredAmbient()` 是"视图想要的默认值"
 * （给设置开关显示用），两者不能合并成一个 —— 合并就分不清"没设过"与"设成了默认值"。
 */
import { REDUCED_MOTION_QUERY } from "./platform.ts";
import { storageGet, storageSet } from "./safeStorage.ts";

export type AmbientSetting = "off" | "drift";
export type AmbientMode = "off" | "static" | "drift";
/** 最终档位是谁定的：软件开关 / 系统偏好 / 内置默认。诊断面板要显示它。 */
export type AmbientSource = "software" | "system" | "default";

export const AMBIENT_STORAGE_KEY = "gosslan.ambientMotion";

/** 用户档位只有两档：关闭 / 缓慢流动。 */
export function isAmbientSetting(v: unknown): v is AmbientSetting {
  return v === "off" || v === "drift";
}

/** 用户**显式**选过的档位；`null` = 从未设过（跟随系统）。 */
export function readStoredAmbientRaw(): AmbientSetting | null {
  const raw = storageGet(AMBIENT_STORAGE_KEY);
  return isAmbientSetting(raw) ? raw : null;
}

/** 视图用的默认值：没设过时，系统冻结动效就把开关显示成关，否则显示流动。 */
export function readStoredAmbient(): AmbientSetting {
  return readStoredAmbientRaw() ?? (prefersReducedMotion() ? "off" : "drift");
}

export function saveStoredAmbient(v: AmbientSetting): void {
  storageSet(AMBIENT_STORAGE_KEY, v);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export interface AmbientEnv {
  /** 低端机（核数/内存/WebView 判定）→ 静态雾。 */
  coarse?: boolean;
  /** 视口宽度 < 480 → 静态雾（手机竖屏优先保帧）。 */
  narrow?: boolean;
}

export interface AmbientResolution {
  mode: AmbientMode;
  source: AmbientSource;
}

/**
 * 设置 + 环境 + 系统动效偏好 → 实际模式 + 来源。
 *
 * ⚠️ 这里**不看** `prefers-reduced-transparency`：那是玻璃层的降级（style.css 里退实底），
 * 与"雾要不要飘"是两个关注点。2026-11-07 之前它俩被绑在一起，Windows 关掉透明效果就
 * 连动效一起没了（用户读数 `prefers-reduced-transparency: reduce: on` + `data-ambient: drift`
 * 之外的机器直接看不到雾）。
 */
export function resolveAmbient(
  setting: AmbientSetting | null,
  env: AmbientEnv = {},
  systemReducedMotion = false,
): AmbientResolution {
  if (setting === "off") return { mode: "off", source: "software" };
  if (setting === "drift") {
    return { mode: env.coarse || env.narrow ? "static" : "drift", source: "software" };
  }
  if (systemReducedMotion) return { mode: "static", source: "system" };
  return { mode: env.coarse || env.narrow ? "static" : "drift", source: "default" };
}

/** 兼容旧调用：只要档位，不要来源。 */
export function resolveAmbientMode(setting: AmbientSetting, env: AmbientEnv = {}): AmbientMode {
  return resolveAmbient(setting, env, prefersReducedMotion()).mode;
}

function detectCoarse(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgent?: string };
  const cores = nav.hardwareConcurrency;
  const mem = nav.deviceMemory;
  const androidWebView = /; wv\)/.test(nav.userAgent ?? "");
  return (
    (typeof cores === "number" && cores > 0 && cores <= 4) ||
    (typeof mem === "number" && mem > 0 && mem <= 4) ||
    androidWebView
  );
}

function detectEnv(): AmbientEnv {
  const coarse = detectCoarse();
  const narrow = window.innerWidth > 0 && window.innerWidth < 480;
  return { coarse, narrow };
}

/** 把模式写到 `<html data-ambient=…>`；CSS 只认这一个属性。 */
export function applyAmbientMode(mode: AmbientMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.ambient = mode;
}

/**
 * 按三层优先级落档，并告诉 CSS「用户显式选了流动」。
 *
 * `data-ambient-motion="force"` 是给 AM-06 的让位开关：CSS 的
 * `@media` reduced-motion 冻结块写成
 * `html:not([data-ambient-motion="force"]) .ambient-blob { animation: none }` ——
 * 只有用户**显式**选过流动时才让系统偏好失效（requirement 2026-11-07）。
 */
export function applyAmbientSetting(setting: AmbientSetting | null): void {
  if (typeof document === "undefined") return;
  const res = resolveAmbient(setting, detectEnv(), prefersReducedMotion());
  document.documentElement.dataset.ambient = res.mode;
  document.documentElement.dataset.ambientMotion = setting === "drift" ? "force" : "auto";
}

/** 当前生效档位的来源（诊断面板用）。判断口径与 `applyAmbientSetting` 完全同源。 */
export function currentAmbientResolution(): AmbientResolution {
  return resolveAmbient(readStoredAmbientRaw(), detectEnv(), prefersReducedMotion());
}

let installed = false;

/** 每个窗口装一次：建 4 个色团 + 1 张噪点，并挂上页面可见性暂停。 */
export function installAmbient(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  applyAmbientSetting(readStoredAmbientRaw());

  const host = document.createElement("div");
  host.className = "ambient";
  host.setAttribute("aria-hidden", "true");
  const blob = (name: string) => {
    const el = document.createElement("div");
    el.className = `ambient-blob ambient-blob--${name}`;
    return el;
  };
  host.append(blob("a"), blob("b"), blob("c"), blob("d"));
  const grain = document.createElement("div");
  grain.className = "ambient-grain";
  host.append(grain);

  // 必须排在 #app 之前：定位层的绘制顺序跟着 DOM 走，放在后面会用负 z-index 也难对齐。
  document.body.insertBefore(host, document.body.firstChild);

  // AM-05：页面隐藏 → 暂停；恢复 → 继续。用属性而不是直接改 style，CSS 一处收口。
  const syncHidden = () => {
    document.documentElement.dataset.pageHidden = String(document.hidden);
  };
  syncHidden();
  document.addEventListener("visibilitychange", syncHidden);

  // 只重算档位：用户没设过时，系统"减少动态效果"在会话中途切换也要跟着变。
  const onMotionPref = () => applyAmbientSetting(readStoredAmbientRaw());
  if (typeof window.matchMedia === "function") {
    window.matchMedia(REDUCED_MOTION_QUERY).addEventListener("change", onMotionPref);
  }

  // 窗口尺寸变化只重算"是否窄屏/低端"，不重建 DOM；低频事件，不构成逐帧开销。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyAmbientSetting(readStoredAmbientRaw());
    }, 180);
  });
}
