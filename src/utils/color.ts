// 主题色工具：由主色派生 hover/active/浅色背景，并注入 CSS 变量。

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "3370ff", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex: string, target: [number, number, number], ratio: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mr = Math.round(r + (target[0] - r) * ratio);
  const mg = Math.round(g + (target[1] - g) * ratio);
  const mb = Math.round(b + (target[2] - b) * ratio);
  return `rgb(${mr}, ${mg}, ${mb})`;
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lighten(hex: string, ratio: number): string {
  return mix(hex, [255, 255, 255], ratio);
}

export function darken(hex: string, ratio: number): string {
  return mix(hex, [0, 0, 0], ratio);
}

/** 与 mix 同逻辑，但返回 hex（可继续参与后续混合链）。 */
export function mixHex(hex: string, target: [number, number, number], ratio: number): string {
  const [r, g, b] = hexToRgb(hex);
  const ch = (v: number, t: number) => {
    const n = Math.round(v + (t - v) * ratio);
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  };
  return `#${ch(r, target[0])}${ch(g, target[1])}${ch(b, target[2])}`;
}

/** 感知亮度（0-255），用于把颜色压/提到目标亮度而非固定比例混合。 */
export function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 把颜色朝 target 混合到指定亮度：只在当前亮度高于 targetLuma 时才动，
 * 已经够暗的颜色原样返回（避免 slate 这类深色气泡被压得看不见）。
 */
export function mixToLuma(hex: string, target: [number, number, number], targetLuma: number): string {
  const from = luma(hex);
  if (from <= targetLuma) return hex;
  const to = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2];
  if (from - to < 1) return hex;
  return mixHex(hex, target, Math.min(1, (from - targetLuma) / (from - to)));
}

/**
 * 按 HSL 派生：保留色相，只调明度（并可给饱和度设上限）。
 * 用途：把主题色派生成「浅底 + 同色相深字」——直接混白/混黑会掉饱和发灰，
 * HSL 里只动 L 才能保住色相的鲜度。
 */
export function adjustHsl(hex: string, opts: { l?: number; sMax?: number }): string {
  const [h, s, l] = toHsl(hex);
  return hslToHex(h, opts.sMax !== undefined ? Math.min(s, opts.sMax) : s, opts.l ?? l);
}

/** hex → HSL：h 为 0-360，s / l 为 0-1。 */
export function toHsl(hex: string): [number, number, number] {
  const [r255, g255, b255] = hexToRgb(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** HSL → hex：h 为 0-360，s / l 为 0-1。 */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（1-21）：正文要求 ≥ 4.5 才达 AA。 */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** 将主题色与字体注入 CSS 变量 */
export function applyTheme(color: string, fontFamily: string) {
  const root = document.documentElement;
  root.style.setProperty("--gosslan-primary", color);
  root.style.setProperty("--gosslan-primary-hover", lighten(color, 0.08));
  root.style.setProperty("--gosslan-primary-active", darken(color, 0.08));
  root.style.setProperty("--gosslan-primary-light", rgba(color, 0.12));
  root.style.setProperty(
    "--gosslan-font-family",
    fontFamily || "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  );
}

export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 默认头像底色：同一名字在单聊列表 / 群聊九宫格 / 消息头像 / 通讯录等所有位置
 * 都得到同一颜色，解决「同一个名称在单聊和群聊里默认头像不一样」的问题。
 * 调色板 8 色，djb2 哈希取模；空名走兜底色，确保始终有合法值。
 */
const AVATAR_PALETTE = [
  "#5b8def", // 蓝
  "#58b178", // 绿
  "#f0a04e", // 橙
  "#9a7ff0", // 紫
  "#e36b6b", // 珊瑚红
  "#4cb8b8", // 青
  "#c87ec4", // 品红
  "#6b7280", // 石板灰（兜底）
];

export function nameToColor(name: string): string {
  const key = (name ?? "").trim() || "?";
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) ^ key.charCodeAt(i);
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

/**
 * 默认头像的统一取字规则：首字符大写、按码点取（emoji 不会被劈成半边）、
 * 空名兜底 "?"。所有画默认头像的地方（消息流 / 会话列表 / 通讯录 / 群成员 /
 * 转发弹窗 / 设置资料页 / 侧栏）都必须用它，不许各写一份 slice。
 */
export function avatarInitial(name: string | null | undefined): string {
  const first = Array.from((name ?? "").trim())[0] ?? "";
  return first.toUpperCase() || "?";
}
