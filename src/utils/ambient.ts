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
 */
import { storageGet, storageSet } from "./safeStorage.ts";

export type AmbientSetting = "off" | "drift";
export type AmbientMode = "off" | "static" | "drift";

export const AMBIENT_STORAGE_KEY = "gosslan.ambientMotion";

/** 用户档位只有两档：关闭 / 缓慢流动（默认后者）。 */
export function isAmbientSetting(v: unknown): v is AmbientSetting {
  return v === "off" || v === "drift";
}

export function readStoredAmbient(): AmbientSetting {
  const raw = storageGet(AMBIENT_STORAGE_KEY);
  return isAmbientSetting(raw) ? raw : "drift";
}

export function saveStoredAmbient(v: AmbientSetting): void {
  storageSet(AMBIENT_STORAGE_KEY, v);
}

export interface AmbientEnv {
  /** 低端机（核数/内存/WebView 判定）→ 静态雾。 */
  coarse?: boolean;
  /** 视口宽度 < 480 → 静态雾（手机竖屏优先保帧）。 */
  narrow?: boolean;
}

/**
 * 设置 + 环境 → 实际模式。
 * reduced-motion / **系统级** reduced-transparency 不在这里判：它们由 CSS 直接接管
 * （前者冻结、后者整层隐藏），否则 JS 与 CSS 两份真相会打架。
 * 例外是**应用内**「减少透明效果」开关：WKWebView 读不到系统特性，只能由 JS 把
 * `frozen` 置真后走 `static`（冻结到初始帧，不隐藏）。见 `reducedTransparency.ts`。
 */
export function resolveAmbientMode(setting: AmbientSetting, env: AmbientEnv = {}): AmbientMode {
  if (setting === "off") return "off";
  if (env.coarse || env.narrow) return "static";
  return "drift";
}

/**
 * 应用内「减少透明效果」是否生效：生效时动效背景冻结到初始帧（`static`）。
 * 只影响 `drift` 档；用户明确关掉背景动效（`off`）时仍然隐藏，二者不冲突。
 */
let frozen = false;

export function setAmbientFrozen(v: boolean): void {
  frozen = v;
  applyAmbientSetting(readStoredAmbient());
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

export function applyAmbientSetting(setting: AmbientSetting): void {
  if (setting === "off") {
    applyAmbientMode("off");
    return;
  }
  applyAmbientMode(frozen ? "static" : resolveAmbientMode(setting, detectEnv()));
}

let installed = false;

/** 每个窗口装一次：建 4 个色团 + 1 张噪点，并挂上页面可见性暂停。 */
export function installAmbient(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  applyAmbientSetting(readStoredAmbient());

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

  // 窗口尺寸变化只重算"是否窄屏/低端"，不重建 DOM；低频事件，不构成逐帧开销。
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyAmbientSetting(readStoredAmbient());
    }, 180);
  });
}
