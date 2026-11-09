/**
 * 全局配色的**运行时求解器**：以主色为种子，在 OKLCH 里派生「填充 / hover / active /
 * 前景 / 主色文字」这一族，并给同一套 token 的静态数值提供唯一出处。
 *
 * 为什么不再用 `color-mix(in srgb, var(--gosslan-primary) 72%, #000000)`：
 * sRGB 里等比例混色会**同时**掉亮度和彩度，于是同一个比例在不同色相上落到的可读性完全不同
 * （实测：混 15% 黑时绿 #00b578 白字只有 3.61、橙 3.83、天蓝 3.76）。比例是常数、结果是变量
 * ⇒ 阈值无法证明，只能靠"六套色各跑一遍"兜着。
 *
 * 这里的做法是：色相与彩度保持种子的值，只沿 L 轴步进到「刚好达标」的**第一档**，
 * 每一档都用双约束验收 —— APCA |Lc| 下限（本文件 APCA_LIMITS）+ WCAG 比值下限
 * （仓库既有护栏是 WCAG 口径：正文 7 / 次文本 4.55 / 占位 4.68 / 非文字 3.02）。
 * 双约束是必要的：只按 APCA 45 派生的图标档换算成 WCAG 只有 2.3~4.2，落码时会当场把既有护栏打红。
 *
 * 落码位置：`applyTheme` 用本模块算出的 12 个种子相关 token（主色 6 档 + 表情胶囊 6 档）覆盖
 * style.css 的同名声明；
 * style.css 里剩下的静态数值也必须等于 `buildThemeTokens(出厂蓝)` 的输出 —— 这一条由
 * `themePalette.test.ts` 逐 token 断言（两份实现漂了会红）。
 */

export type ThemeMode = "light" | "dark";

export interface Seed {
  hex: string;
  rgb: RGB;
  /** OKLCH 明度（0–1） */
  L: number;
  /** OKLCH 彩度 */
  C: number;
  /** OKLCH 色相（0–360）；无彩度种子归一到 0 */
  H: number;
  /** 种子几乎无彩（灰阶）：此时不虚构品牌色相，所有派生都保持中性 */
  achromatic: boolean;
}

export type RGB = [number, number, number];

/** APCA 0.1.9 的 |Lc| 下限（本项目的可读性契约）。改这一组数等于放宽判据，测试会红。 */
export const APCA_LIMITS = {
  body: 85,
  secondary: 70,
  weak: 60,
  button: 75,
  icon: 45,
} as const;

/** 求解目标：APCA 与 WCAG 双约束。留 2–3 的余量，实测通常略高于 APCA_LIMITS。 */
interface Target {
  /** APCA |Lc| 目标 */
  a: number;
  /** WCAG 比值目标；0 表示这一档不追加 WCAG 约束 */
  w: number;
}

const LIGHT_TARGETS: Record<"body" | "secondary" | "weak" | "button" | "icon", Target> = {
  body: { a: 89, w: 7 },
  secondary: { a: 72, w: 4.55 },
  weak: { a: 64, w: 4.68 },
  button: { a: 78, w: 4.55 },
  icon: { a: 47, w: 3.02 },
};

const DARK_TARGETS = LIGHT_TARGETS;

// ---------------------------------------------------------------------------
// sRGB ↔ OKLCH
// ---------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 出厂默认主色（画板 Pulse 蓝）：无彩种子与非法输入都收敛到它。 */
export const DEFAULT_SEED = "#2f6bff";

export function hexToRgb(hex: string): RGB {
  let s = String(hex ?? "").trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return hexToRgb(DEFAULT_SEED);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function rgbToHex(rgb: RGB): string {
  return `#${rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = clamp(v, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function rgbToOklch(rgb: RGB): { L: number; C: number; H: number } {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

function oklchToLinear(L: number, C: number, H: number): RGB {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function inGamut(L: number, C: number, H: number): boolean {
  const [r, g, b] = oklchToLinear(L, C, H);
  const eps = 1e-7;
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

/** 该(L, H)下 sRGB 能表示的最大彩度：超出就削到这里，避免输出被浏览器裁成"另一个色相"。 */
export function maxChroma(L: number, H: number): number {
  if (L <= 0 || L >= 1) return 0;
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, H)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function oklchToRgb(L: number, C: number, H: number): RGB {
  const safeL = clamp(L, 0, 1);
  const safeC = Math.min(Math.max(C, 0), maxChroma(safeL, H));
  const [r, g, b] = oklchToLinear(safeL, safeC, H);
  return [linearToSrgb(r) * 255, linearToSrgb(g) * 255, linearToSrgb(b) * 255];
}

export function oklchToHex(L: number, C: number, H: number): string {
  return rgbToHex(oklchToRgb(L, C, H));
}

// ---------------------------------------------------------------------------
// 对比度：APCA 0.1.9（常量与分支逐条对齐 apca-w3 0.1.9 W3）+ WCAG 2.x
// ---------------------------------------------------------------------------

const APCA = {
  mainTRC: 2.4,
  sRco: 0.2126729,
  sGco: 0.7151522,
  sBco: 0.0721750,
  normBG: 0.56,
  normTXT: 0.57,
  revTXT: 0.62,
  revBG: 0.65,
  blkThrs: 0.022,
  blkClmp: 1.414,
  scaleBoW: 1.14,
  scaleWoB: 1.14,
  loBoWoffset: 0.027,
  loWoBoffset: 0.027,
  deltaYmin: 0.0005,
  loClip: 0.1,
} as const;

function apcaY(rgb: RGB): number {
  const e = (v: number) => Math.pow(v / 255, APCA.mainTRC);
  return APCA.sRco * e(rgb[0]) + APCA.sGco * e(rgb[1]) + APCA.sBco * e(rgb[2]);
}

/** 有符号 Lc：深字浅底为正、浅字深底为负（与 apca-w3 一致）。 */
export function apcaLc(txt: RGB, bg: RGB): number {
  let t = apcaY(txt);
  let b = apcaY(bg);
  t = t > APCA.blkThrs ? t : t + Math.pow(APCA.blkThrs - t, APCA.blkClmp);
  b = b > APCA.blkThrs ? b : b + Math.pow(APCA.blkThrs - b, APCA.blkClmp);
  if (Math.abs(b - t) < APCA.deltaYmin) return 0;
  if (b > t) {
    const s = (Math.pow(b, APCA.normBG) - Math.pow(t, APCA.normTXT)) * APCA.scaleBoW;
    return (s < APCA.loClip ? 0 : s - APCA.loBoWoffset) * 100;
  }
  const s = (Math.pow(b, APCA.revBG) - Math.pow(t, APCA.revTXT)) * APCA.scaleWoB;
  return (s > -APCA.loClip ? 0 : s + APCA.loWoBoffset) * 100;
}

function wcagLum(rgb: RGB): number {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function wcagRatio(a: RGB, b: RGB): number {
  const la = wcagLum(a);
  const lb = wcagLum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function meets(fg: RGB, bg: RGB, t: Target): boolean {
  return Math.abs(apcaLc(fg, bg)) >= t.a && wcagRatio(fg, bg) >= t.w;
}

// ---------------------------------------------------------------------------
// 种子
// ---------------------------------------------------------------------------

export function parseSeed(hex: string): Seed {
  const rgb = hexToRgb(hex);
  const { L, C, H } = rgbToOklch(rgb);
  const achromatic = C < 0.004;
  return { hex: rgbToHex(rgb), rgb, L, C, H: achromatic ? 0 : H, achromatic };
}

// ---------------------------------------------------------------------------
// 阶梯：亮/暗各自一组锚点（层级关系而不是"亮色反色成暗色"）
// ---------------------------------------------------------------------------

interface ModeSpec {
  surfaces: Record<string, number>;
  border: Record<string, number>;
  text: Record<string, number>;
  targets: typeof LIGHT_TARGETS;
}

const LIGHT: ModeSpec = {
  surfaces: {
    appBg: 0.962, bg: 0.962, list: 0.978, chat: 1.0, panel: 1.0,
    card: 0.917, field: 0.950, rail: 0.940, railActive: 0.905,
    listActive: 0.945, caption: 0.935,
  },
  border: { border: 0.925, divider: 0.954, seam: 0.880 },
  text: { body: 0.240, off: 0.620, toggle: 0.615, rail: 0.400 },
  targets: LIGHT_TARGETS,
};

const DARK: ModeSpec = {
  surfaces: {
    appBg: 0.196, bg: 0.196, list: 0.243, chat: 0.267, panel: 0.304,
    card: 0.260, field: 0.264, rail: 0.245, railActive: 0.275,
    listActive: 0.304, caption: 0.245,
  },
  border: { border: 0.335, divider: 0.304, seam: 0.355 },
  text: { body: 0.960, off: 0.650, toggle: 0.610, rail: 0.650 },
  targets: DARK_TARGETS,
};

/** 语义色的色相恒定（不跟主色走），只沿 L 轴取档。 */
const SEM = {
  danger: { hue: 20, cap: 0.19 },
  warning: { hue: 65, cap: 0.17 },
  success: { hue: 160, cap: 0.16 },
} as const;

function solveDarkText(bg: RGB, chroma: number, hue: number, target: Target, hi = 0.58, lo = 0.16): string {
  for (let L = hi; L >= lo; L -= 0.002) {
    if (meets(oklchToRgb(L, chroma, hue), bg, target)) return oklchToHex(L, chroma, hue);
  }
  return oklchToHex(lo, chroma, hue);
}

function solveLightText(bg: RGB, chroma: number, hue: number, target: Target, lo = 0.58, hi = 0.97): string {
  for (let L = lo; L <= hi; L += 0.002) {
    if (meets(oklchToRgb(L, chroma, hue), bg, target)) return oklchToHex(L, chroma, hue);
  }
  return oklchToHex(hi, chroma, hue);
}

/** 非文字图形（状态点 / 轨道 / 边界）：亮色从浅往深、暗色从深往浅找刚好达标的一档。 */
function solveIcon(
  hue: number,
  chroma: number,
  bg: RGB,
  target: Target,
  mode: ThemeMode,
  extra?: (rgb: RGB) => boolean,
): string {
  const ok = (L: number) => {
    const c = oklchToRgb(L, chroma, hue);
    return meets(c, bg, target) && (extra ? extra(c) : true);
  };
  if (mode === "light") {
    for (let L = 0.88; L >= 0.35; L -= 0.002) if (ok(L)) return oklchToHex(L, chroma, hue);
    return oklchToHex(0.35, chroma, hue);
  }
  for (let L = 0.45; L <= 0.92; L += 0.002) if (ok(L)) return oklchToHex(L, chroma, hue);
  return oklchToHex(0.92, chroma, hue);
}

/** 亮色填充：从浅往深找「最浅且白字达标」的一档。 */
function solveLightFill(hue: number, chroma: number, target: Target): { L: number; hex: string } {
  for (let L = 0.68; L >= 0.32; L -= 0.002) {
    if (meets([255, 255, 255], oklchToRgb(L, chroma, hue), target)) return { L, hex: oklchToHex(L, chroma, hue) };
  }
  return { L: 0.32, hex: oklchToHex(0.32, chroma, hue) };
}

/** 暗色填充：从深往浅找「最暗且前景字达标」的一档（Material 3 tone-80 思路）。 */
function solveDarkFill(hue: number, chroma: number, target: Target, ink: RGB): { L: number; hex: string } {
  for (let L = 0.68; L <= 0.92; L += 0.002) {
    if (meets(ink, oklchToRgb(L, chroma, hue), target)) return { L, hex: oklchToHex(L, chroma, hue) };
  }
  return { L: 0.92, hex: oklchToHex(0.92, chroma, hue) };
}

// ---------------------------------------------------------------------------
// 全量 token 地图（42 项）
// ---------------------------------------------------------------------------

/**
 * 语义色在暗色下的方向：
 *   · danger 由用户拍板「保留深底白字」（不取 M3 的浅底深字）⇒ 暗色直接沿用亮色的**深**填充，
 *     白字实测仍过 4.5；代价是它对暗面板的边界只有 ~2.6:1（数学上"白字 ≥4.5"与
 *     "填充 vs 面板 ≥3"在暗色不可同时成立，见 style.css 顶部注释）。
 *   · warning / success 的实底档**不能**跟 danger 走：它们在界面里压的是
 *     `--gosslan-on-primary`（暗色已换成深墨），深底 + 深墨会直接看不见 ⇒ 只能提亮填充。
 */
export function buildThemeTokens(seedHex: string, mode: ThemeMode): Record<string, string> {
  const seed = parseSeed(seedHex);
  const S = mode === "light" ? LIGHT : DARK;
  /** 中性面只继承种子 2% 的彩度（上限 C=0.006）：换主色时背景极轻微偏色，但不变成彩色玻璃。 */
  const nC = (f = 1) => (seed.achromatic ? 0 : clamp(seed.C * 0.02 * f, 0.002, 0.006));
  const tC = seed.achromatic ? 0 : clamp(seed.C * 0.02, 0.002, 0.006);
  const hex = (L: number, C: number) => oklchToHex(L, C, seed.H);
  const rgb = (L: number, C: number) => oklchToRgb(L, C, seed.H);

  const surf: Record<string, string> = {};
  for (const [k, L] of Object.entries(S.surfaces)) surf[k] = hex(L, nC());
  const bd: Record<string, string> = {};
  for (const [k, L] of Object.entries(S.border)) bd[k] = hex(L, nC());
  // 边界色按「最差的那层底」求解：亮色字段底更暗、暗色面板底更亮。
  bd.fieldBorder = solveIcon(seed.H, nC(), hexToRgb(surf[mode === "light" ? "field" : "panel"]), S.targets.icon, mode);
  // 结构缝（2026-11-09 与控件边框**解耦**）：分栏线只需要一条"看得见但压不过控件"的浅缝，
  // 由 `border.seam` 直接给 L（≈1.4:1，按聊天画布算）。两者共用一个值时，结构缝会被画成
  // 控件边框那么重 —— 就是用户看到的倒挂（搜索框外框 3.33:1，比一条真分栏缝重一倍）。
  // 控件边框仍由上面那行守 3.0 非文本档（`--gosslan-field-border` 现在是独立 literal）。

  /** 暗色填充上的深墨（= .dark 里的 --gosslan-app-bg 那一档）。 */
  const inkNeutral: RGB = mode === "light" ? [18, 18, 20] : rgb(0.190, tC);

  // ---- 主色填充：亮色压深到"白字刚好可过"，暗色提亮到"深墨刚好可过" ----
  const fillC = Math.min(seed.C, 0.20);
  let fill: { L: number; hex: string };
  if (mode === "light") {
    const solved = solveLightFill(seed.H, fillC, S.targets.button);
    // 深色种子保持深（更可读也更贴用户原意），浅色种子收敛到"最浅可过"那一档。
    const L = seed.achromatic ? solved.L : Math.min(Math.max(seed.L, 0.36), solved.L);
    fill = { L, hex: hex(L, fillC) };
  } else {
    const solved = solveDarkFill(seed.H, fillC, S.targets.button, inkNeutral);
    const L = Math.max(Math.min(seed.L, 0.88), solved.L);
    fill = { L, hex: hex(L, fillC) };
  }
  const onFill = mode === "light" ? rgbToHex([255, 255, 255]) : hex(0.190, tC);
  // hover / active 沿"更强调"的方向各走一档：亮色更深、暗色更亮。
  const hover = mode === "light" ? hex(Math.max(0.30, fill.L - 0.035), fillC) : hex(Math.min(0.92, fill.L + 0.035), fillC);
  const active = mode === "light" ? hex(Math.max(0.28, fill.L - 0.070), fillC) : hex(Math.min(0.94, fill.L + 0.070), fillC);
  const accentInk =
    mode === "light"
      ? solveDarkText(hexToRgb(surf.card), Math.min(seed.C, 0.17), seed.H, S.targets.secondary)
      : solveLightText(hexToRgb(surf.panel), Math.min(seed.C, 0.17), seed.H, S.targets.secondary);

  // ---- 中性文字：亮色在最暗的卡片底上求解、暗色在面板底上求解 ----
  const body =
    mode === "light"
      ? solveDarkText(hexToRgb(surf.card), tC, seed.H, S.targets.body)
      : solveLightText(hexToRgb(surf.panel), tC, seed.H, S.targets.body);
  const text2 =
    mode === "light"
      ? solveDarkText(hexToRgb(surf.card), tC, seed.H, S.targets.secondary)
      : solveLightText(hexToRgb(surf.panel), tC, seed.H, S.targets.secondary);
  const weak =
    mode === "light"
      ? solveDarkText(hexToRgb(surf.field), tC, seed.H, S.targets.weak, 0.62, 0.30)
      : solveLightText(hexToRgb(surf.panel), tC, seed.H, S.targets.weak, 0.50, 0.92);
  const railText =
    mode === "light"
      ? solveDarkText(hexToRgb(surf.railActive), tC, seed.H, S.targets.secondary)
      : solveLightText(hexToRgb(surf.panel), tC, seed.H, S.targets.secondary);

  // ---- 语义色 ----
  const sem: Record<string, { fill: string; solid: string; status: string; ink: string; soft: string; hover: string }> = {};
  for (const [name, spec] of Object.entries(SEM)) {
    const hue = spec.hue;
    const cap = spec.cap;
    const semHex = (L: number, C: number) => oklchToHex(L, C, hue);
    // danger：用户拍板保留深底白字 ⇒ 两档外观都按"白字达标"的深填充取档。
    const fillMode: ThemeMode = name === "danger" ? "light" : mode;
    const fillSem =
      fillMode === "light"
        ? solveLightFill(hue, cap, S.targets.button)
        : solveDarkFill(hue, cap, S.targets.button, rgb(0.190, 0.004));
    const soft = mode === "light" ? semHex(0.946, Math.min(cap * 0.22, 0.045)) : semHex(0.335, Math.min(cap * 0.25, 0.050));
    // 语义文字最差的底是"胶囊底"：亮色卡片比胶囊更暗、暗色胶囊比面板更亮。
    const inkSem =
      mode === "light"
        ? solveDarkText(hexToRgb(surf.card), cap, hue, S.targets.secondary)
        : solveLightText(hexToRgb(soft), cap, hue, S.targets.secondary);
    const status = solveIcon(hue, cap, hexToRgb(surf.panel), S.targets.icon, mode);
    sem[name] = {
      fill: fillSem.hex,
      solid: fillSem.hex,
      status,
      ink: inkSem,
      soft,
      hover: semHex(fillMode === "dark" ? Math.min(0.92, fillSem.L - 0.040) : Math.max(0.30, fillSem.L - 0.040), cap),
    };
  }

  // ---- 表情回应胶囊：底色必须**不透明** ----
  // 它压在任何气泡上：自己的消息气泡是主色实底、别人的是卡片。旧的默认态用 `--gosslan-hover`
  // （5% 黑 + 透明）叠在气泡上 ⇒ 自己的蓝气泡上就变成"灰字压蓝底"，读数掉到 2.x（用户 2026-11-08 实测截图）。
  // 现在四态（默认 / hover / 已选 / 已选+hover）都由主色求解成**实色**，文字对最差的那一档（hover）求解，
  // hover 只换一层底、不叠第二层。胶囊与"自己那颗主色气泡"的边界另由 tokenContrast 的 react 契约行判。
  const reactC = seed.achromatic ? 0 : clamp(seed.C * 0.02 * 2, 0.002, 0.012);
  const mineC = Math.min(fillC * 0.30, 0.055);
  const reactBgL = mode === "light" ? 0.934 : 0.300;
  const reactBgHoverL = mode === "light" ? 0.890 : 0.345;
  const reactMineL = mode === "light" ? 0.905 : 0.372;
  const reactMineHoverL = mode === "light" ? 0.858 : 0.415;
  const reactBg = hex(reactBgL, reactC);
  const reactBgHover = hex(reactBgHoverL, reactC);
  const reactBgMine = hex(reactMineL, mineC);
  const reactBgMineHover = hex(reactMineHoverL, mineC);
  // 文字一律对**最差的那一档底**求解：亮色 hovers 更深、暗色 hovers 更亮，同一支求解各取各的方向。
  const reactInk =
    mode === "light"
      ? solveDarkText(hexToRgb(reactBgHover), tC, seed.H, S.targets.secondary)
      : solveLightText(hexToRgb(reactBgHover), tC, seed.H, S.targets.secondary);
  const reactInkMine =
    mode === "light"
      ? solveDarkText(hexToRgb(reactBgMineHover), Math.min(seed.C, 0.10), seed.H, S.targets.secondary)
      : solveLightText(hexToRgb(reactBgMineHover), Math.min(seed.C, 0.10), seed.H, S.targets.secondary);

  // 开关未选中轨道：除了"vs 面板/卡片 3:1"，白色滑块压在它上面也必须读得出来（同一对判据的另一维）。
  // ⚠️ 这里只挂 WCAG 3.0、不挂 APCA 45：深色面板上同时满足「轨道 vs 面板 Lc 45」与
  //    「白滑块 vs 轨道 3:1」是不可能的（实测 Lc 45 需要 L≈0.72，那时白滑块只剩 2.5:1）。
  //    仓库对这条 token 的契约本来就是 WCAG 口径的两行，所以按 3.0 求解、两维都留余量。
  const whiteRgb: RGB = [255, 255, 255];
  const trackOk = (c: RGB) => wcagRatio(whiteRgb, c) >= 3.0;
  const toggleOff = solveIcon(seed.H, 0.010, hexToRgb(surf.panel), { a: 0, w: 3.02 }, mode, trackOk);

  return {
    "--gosslan-primary": fill.hex,
    "--gosslan-primary-hover": hover,
    "--gosslan-primary-active": active,
    "--gosslan-on-primary": onFill,
    "--gosslan-accent-ink": accentInk,
    "--gosslan-primary-light":
      mode === "light" ? hex(0.948, Math.min(fillC * 0.22, 0.040)) : hex(0.320, Math.min(fillC * 0.22, 0.045)),
    "--gosslan-app-bg": surf.appBg,
    "--gosslan-bg": surf.bg,
    "--gosslan-list": surf.list,
    "--gosslan-chat": surf.chat,
    "--gosslan-panel": surf.panel,
    "--gosslan-card": surf.card,
    "--gosslan-card-ink": body,
    "--gosslan-field": surf.field,
    "--gosslan-field-border": bd.fieldBorder,
    "--gosslan-border": bd.border,
    "--gosslan-divider": bd.divider,
    "--gosslan-divider-strong": bd.seam,
    "--gosslan-text": body,
    "--gosslan-text-2": text2,
    "--gosslan-placeholder": weak,
    "--gosslan-rail-text": railText,
    "--gosslan-rail-active": surf.railActive,
    "--gosslan-rail-text-active": fill.hex,
    "--gosslan-list-active": surf.listActive,
    "--gosslan-list-active-text": body,
    "--gosslan-caption": surf.caption,
    "--gosslan-danger": sem.danger.fill,
    "--gosslan-danger-ink": sem.danger.ink,
    "--gosslan-danger-soft": sem.danger.soft,
    "--gosslan-danger-hover": sem.danger.hover,
    "--gosslan-warning": sem.warning.status,
    "--gosslan-warning-ink": sem.warning.ink,
    "--gosslan-warning-text-ink": sem.warning.ink,
    "--gosslan-warning-soft": sem.warning.soft,
    "--gosslan-warning-solid": sem.warning.solid,
    "--gosslan-success": sem.success.status,
    "--gosslan-success-ink": sem.success.ink,
    "--gosslan-success-soft": sem.success.soft,
    "--gosslan-success-solid": sem.success.solid,
    "--gosslan-status-offline": solveIcon(seed.H, 0.006, hexToRgb(surf.panel), S.targets.icon, mode),
    "--gosslan-toggle-off": toggleOff,
    "--gosslan-react-bg": reactBg,
    "--gosslan-react-bg-hover": reactBgHover,
    "--gosslan-react-bg-mine": reactBgMine,
    "--gosslan-react-bg-mine-hover": reactBgMineHover,
    "--gosslan-react-ink": reactInk,
    "--gosslan-react-ink-mine": reactInkMine,
  };
}

/**
 * `applyTheme` 在运行时真正要覆盖的那一族。
 *
 * 只覆盖这几个而不是全部 48 项：其余 token（面/文字/语义）与种子的关系弱到色相不影响可读性
 * （中性面只继承 2% 彩度、语义色色相恒定），把它们也塞进内联样式只会让"拖动取色器时每帧
 * 重写 42 条声明"变成卡顿源；而全局观感仍由 style.css 的出厂值保证。
 * 这 12 项恰好就是过去靠 `color-mix(in srgb, …)` 现派生的那一族（6 个主色档 + 6 个表情胶囊档）——
 * 换掉它等于换掉整套派生方式。胶囊那 6 项必须跟着主色走：换主题色后它们若还停在出厂蓝，
 * 就会变成"胶囊跟气泡不是一个色系"（用户 2026-11-08 报的第二条）。
 */
export const SEED_TOKENS = [
  "--gosslan-primary",
  "--gosslan-primary-hover",
  "--gosslan-primary-active",
  "--gosslan-on-primary",
  "--gosslan-accent-ink",
  "--gosslan-primary-light",
  "--gosslan-react-bg",
  "--gosslan-react-bg-hover",
  "--gosslan-react-bg-mine",
  "--gosslan-react-bg-mine-hover",
  "--gosslan-react-ink",
  "--gosslan-react-ink-mine",
] as const;

/** 运行时覆盖集：给定种子与外观，返回这 12 个 token 的最终取值。 */
export function seedTokens(seedHex: string, mode: ThemeMode): Record<string, string> {
  const all = buildThemeTokens(seedHex, mode);
  const out: Record<string, string> = {};
  for (const k of SEED_TOKENS) out[k] = all[k];
  return out;
}
