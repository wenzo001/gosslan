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
 * ## 三层优先级 + 能力闸（2026-11-08 定）
 *
 * **能力闸先于一切用户意图**：系统要求减少透明（Windows 关掉「透明效果」）或内核不支持
 * `backdrop-filter` 时，动效根本出不来 —— 这时给一个"能选却无效"的开关只会让用户以为坏了。
 * 能力不可用时档位固定落 `off`、来源记 `capability`，但**不落库**；能力恢复后回到用户
 * 显式选过的值（从未选过则回到下面三层）。能力的判定只在 `utils/ambientCapability.ts` 一处。
 *
 * 能力可用时，档位按这三层解析：
 *
 *   软件显式（存了 "off" / "drift"） > 系统 media query > 内置默认（drift，低端机降 static）
 *
 * `readStoredAmbientRaw()` 返回 `null` = 从未设过；`readStoredAmbient()` 是"视图想要的显示值"
 * （给设置开关显示用），两者不能合并成一个 —— 合并就分不清"没设过"与"设成了默认值"。
 */
import { readAmbientCapability, watchAmbientCapability, type AmbientCapability } from "./ambientCapability.ts";
import { isAndroid, isIOS, REDUCED_MOTION_QUERY } from "./platform.ts";
import { storageGet, storageSet } from "./safeStorage.ts";

export type AmbientSetting = "off" | "drift";
export type AmbientMode = "off" | "static" | "drift";
/**
 * 最终档位是谁定的：软件开关 / 系统偏好 / 内置默认 / **能力不支持**。
 * 诊断面板要显示它；`capability` 时设置页显示为关且不可选（用户选择仍留在存储里）。
 */
export type AmbientSource = "software" | "system" | "default" | "capability";

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

/**
 * 解析结果 → 设置开关的显示档位：**只有真的会漂**才显示「关闭」以外的选项。
 *
 * 为什么必须从解析结果投影，而不是从"用户没设过"直接猜：
 * 2026-11-09 实测发现 `data-ambient="static"`（系统 reduce / 低端机冻结雾）时，
 * 开关仍按 `prefersReducedMotion()` 显示「关闭」—— 用户看到"开关关了、背景雾还在"，
 * 以为关不掉。这条投影把两边钉在一起：显示「关闭」⇔ `<html data-ambient="off">`。
 * 反例（ambient.test.ts 有断言）：任何让 static 显示成 off 的写法都会红。
 */
export function ambientDisplaySetting(res: AmbientResolution): AmbientSetting {
  return res.mode === "off" ? "off" : "drift";
}

/**
 * 视图用的显示值：能力不可用 ⇒ 恒显示「关闭」（但不改写存储与显式选择）；
 * 能力可用 ⇒ 设过就按用户的值，没设过就按三层优先级解析后的样子显示。
 */
export function readStoredAmbient(
  capability: AmbientCapability = readAmbientCapability(),
  systemReducedMotion = prefersReducedMotion(),
): AmbientSetting {
  if (!capability.available) return "off";
  const explicit = readStoredAmbientRaw();
  if (explicit) return explicit;
  return ambientDisplaySetting(resolveAmbient(null, {}, systemReducedMotion, capability));
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
 * 设置 + 环境 + 系统动效偏好 + 能力 → 实际模式 + 来源。
 *
 * 能力不可用（系统关「透明效果」/ 无 `backdrop-filter`）时，无论用户选过什么都落 `off`
 * —— 这不是"替用户改选择"：存储里的显式值一个字没动，能力恢复后原样生效。
 * 能力判定本身不许进这个文件，只经 `ambientCapability.ts` 的 `capability` 入参（AM-17）。
 */
export function resolveAmbient(
  setting: AmbientSetting | null,
  env: AmbientEnv = {},
  systemReducedMotion = false,
  capability: AmbientCapability = { available: true, reason: null },
): AmbientResolution {
  if (setting === "off") return { mode: "off", source: "software" };
  if (!capability.available) return { mode: "off", source: "capability" };
  if (setting === "drift") {
    return { mode: env.coarse || env.narrow ? "static" : "drift", source: "software" };
  }
  if (systemReducedMotion) return { mode: "static", source: "system" };
  return { mode: env.coarse || env.narrow ? "static" : "drift", source: "default" };
}

/** 兼容旧调用：只要档位，不要来源。能力闸同样生效（不许绕开它拿到"能漂"的答案）。 */
export function resolveAmbientMode(setting: AmbientSetting, env: AmbientEnv = {}): AmbientMode {
  return resolveAmbient(setting, env, prefersReducedMotion(), readAmbientCapability()).mode;
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
 * 按三层优先级 + 能力闸落档，并告诉 CSS「用户显式选了流动」。
 *
 * `data-ambient-motion="force"` 是给 AM-06 的让位开关：CSS 的
 * `@media` reduced-motion 冻结块写成
 * `html:not([data-ambient-motion="force"]) .ambient-blob { animation: none }` ——
 * 只有**真的在漂**（`res.mode === "drift"`）时才让系统偏好失效。
 * 用实际模式而不是用户设置：能力闸把档位落成 off、低端机落成 static 时，
 * 再写 `force` 就是在诊断面板上撒谎（"软件压过了系统 reduce"其实没有）。
 */
export function applyAmbientSetting(setting: AmbientSetting | null): void {
  if (typeof document === "undefined") return;
  const res = resolveAmbient(setting, detectEnv(), prefersReducedMotion(), readAmbientCapability());
  document.documentElement.dataset.ambient = res.mode;
  document.documentElement.dataset.ambientMotion = res.mode === "drift" ? "force" : "auto";
}

/** 当前生效档位的来源（诊断面板用）。判断口径与 `applyAmbientSetting` 完全同源。 */
export function currentAmbientResolution(): AmbientResolution {
  return resolveAmbient(readStoredAmbientRaw(), detectEnv(), prefersReducedMotion(), readAmbientCapability());
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

  // AM-05b（2026-11-09）：桌面窗口失焦但页面仍 visible 时也暂停。
  // 两个窗口并排或被别的应用盖住时，WKWebView 仍会推进 CSS 合成帧；三个大色团
  // 加上 rail 的 backdrop-filter 会持续占用 WindowServer。移动端不看 blur：
  // 软键盘/系统弹框都会触发，不能据此判断"用户不看了"。
  if (!isAndroid && !isIOS) {
    const syncWindowActive = (active: boolean) => {
      document.documentElement.dataset.appInactive = String(!active);
    };
    window.addEventListener("focus", () => syncWindowActive(true));
    window.addEventListener("blur", () => syncWindowActive(false));
    syncWindowActive(true);
  }

  // AM-05c（2026-11-09）：交互瞬间短暂暂停色团。
  // 色团本身很慢（72–120s），暂停 500ms 肉眼看不出；但点击/滚动那一瞬正好是
  // 菜单玻璃 blur 与色团 transform 同时要合成的时候。把这段时间的逐帧合成让开，
  // 松手 500ms 后自动恢复。只用一条定时器，滚动/按键再触发时只推后截止时间。
  let interactingUntil = 0;
  let interactingTimer: ReturnType<typeof setTimeout> | null = null;
  const markInteracting = () => {
    interactingUntil = Date.now() + 500;
    if (document.documentElement.dataset.appInteracting !== "true") {
      document.documentElement.dataset.appInteracting = "true";
    }
    if (interactingTimer) return;
    const tick = () => {
      const left = interactingUntil - Date.now();
      if (left > 0) {
        interactingTimer = setTimeout(tick, left);
        return;
      }
      interactingTimer = null;
      document.documentElement.dataset.appInteracting = "false";
    };
    interactingTimer = setTimeout(tick, 500);
  };
  for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"] as const) {
    window.addEventListener(ev, markInteracting, { passive: true });
  }
  // capture：滚动可能发生在任何容器里，冒泡阶段收不到；passive 不挡滚动。
  window.addEventListener("scroll", markInteracting, { passive: true, capture: true });

  // 只重算档位：用户没设过时，系统"减少动态效果"在会话中途切换也要跟着变。
  const onMotionPref = () => applyAmbientSetting(readStoredAmbientRaw());
  if (typeof window.matchMedia === "function") {
    window.matchMedia(REDUCED_MOTION_QUERY).addEventListener("change", onMotionPref);
  }
  // 能力闸的变化要重算（Windows 用户中途打开/关闭「透明效果」）。`CSS.supports` 那半没有
  // change 事件，也不变（换内核 = 重启应用），见 ambientCapability.ts 的注释。
  watchAmbientCapability(onMotionPref);

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
