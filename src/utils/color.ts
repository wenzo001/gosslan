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
