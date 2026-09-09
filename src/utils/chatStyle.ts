// 聊天显示样式：预设配色（可读性优先）与字号档位。
// 本机偏好持久化（后端 settings.chat_style），同时经 ChatStyle 消息广播给
// 已连接节点：对方设备持久化后按「我的偏好」渲染我发出的消息气泡。

import dayjs from "dayjs";
import { adjustHsl, contrastRatio, luma, mixToLuma } from "./color.ts";

export interface ChatPresetColors {
  mineBubble: string;
  mineText: string;
  otherBubble: string;
  otherText: string;
}

export interface ChatPreset {
  key: string;
  label: string;
  light: ChatPresetColors;
  dark: ChatPresetColors;
}

/** 气泡配色预设：每套均通过明暗双主题下的正文对比度检查（≥ 4.5:1）。
 *  "theme"（跟随主题）为默认：颜色运行时按主题色派生（resolveChatColors），
 *  表中 light/dark 仅作为回退值。 */
export const CHAT_PRESETS: ChatPreset[] = [
  {
    key: "theme",
    label: "跟随主题",
    light: { mineBubble: "#60a5fa", mineText: "#172554", otherBubble: "#eeeef0", otherText: "#0f172a" },
    dark: { mineBubble: "#1d4ed8", mineText: "#ffffff", otherBubble: "#1e293b", otherText: "#e2e8f0" },
  },
  {
    key: "classic",
    label: "经典蓝",
    light: { mineBubble: "#60a5fa", mineText: "#172554", otherBubble: "#eeeef0", otherText: "#1f2937" },
    dark: { mineBubble: "#1d4ed8", mineText: "#ffffff", otherBubble: "#252e3b", otherText: "#e5e7eb" },
  },
  {
    key: "mint",
    label: "薄荷绿",
    light: { mineBubble: "#34d399", mineText: "#064e3b", otherBubble: "#eeeef0", otherText: "#1f2937" },
    dark: { mineBubble: "#065f46", mineText: "#ecfdf5", otherBubble: "#252e3b", otherText: "#e5e7eb" },
  },
  {
    key: "amber",
    label: "暖阳橙",
    light: { mineBubble: "#fb923c", mineText: "#431407", otherBubble: "#eeeef0", otherText: "#1f2937" },
    dark: { mineBubble: "#9a3412", mineText: "#fff7ed", otherBubble: "#252e3b", otherText: "#e5e7eb" },
  },
  {
    key: "celadon",
    label: "青瓷",
    light: { mineBubble: "#2dd4bf", mineText: "#134e4a", otherBubble: "#eeeef0", otherText: "#1f2937" },
    dark: { mineBubble: "#115e59", mineText: "#f0fdfa", otherBubble: "#252e3b", otherText: "#e5e7eb" },
  },
  {
    key: "rose",
    label: "樱花粉",
    light: { mineBubble: "#f472b6", mineText: "#500724", otherBubble: "#eeeef0", otherText: "#1f2937" },
    dark: { mineBubble: "#9d174d", mineText: "#fdf2f8", otherBubble: "#252e3b", otherText: "#e5e7eb" },
  },
  {
    key: "slate",
    label: "石墨灰",
    light: { mineBubble: "#9ca3af", mineText: "#111827", otherBubble: "#eeeef0", otherText: "#374151" },
    dark: { mineBubble: "#374151", mineText: "#f9fafb", otherBubble: "#1f2937", otherText: "#d1d5db" },
  },
];

export const CHAT_FONT_SIZES = [
  { key: "sm", label: "小", px: 13 },
  { key: "md", label: "标准", px: 14 },
  { key: "lg", label: "大", px: 16 },
] as const;

export type FontSizeKey = (typeof CHAT_FONT_SIZES)[number]["key"];

/** 本机聊天样式偏好（持久化 & 广播）。 */
export interface ChatStyleConfig {
  preset: string;
  fontSize: FontSizeKey;
}

export const DEFAULT_CHAT_STYLE: ChatStyleConfig = { preset: "theme", fontSize: "md" };

export function findPreset(key: string | undefined | null): ChatPreset {
  return CHAT_PRESETS.find((p) => p.key === key) ?? CHAT_PRESETS[0];
}

/** 暗色画布色（与 .dark 下的 --gosslan-bg 一致）：自己的气泡朝它压暗，融入夜色。 */
const DARK_BG_RGB: [number, number, number] = [15, 23, 42];
/** 纯黑：只降亮度不改色相，用于把过亮的白字压成柔和的浅色。 */
const BLACK_RGB: [number, number, number] = [0, 0, 0];
/** 暗色下自己气泡的目标亮度（0-255）：亮色实底在深背景上刺眼，压到这个档位。 */
const DARK_MINE_BUBBLE_LUMA = 74;
/** 暗色下自己气泡文字的目标亮度：纯白 #ffffff 在暗底上过曝，压一档更耐看。 */
const DARK_MINE_TEXT_LUMA = 212;
/** 亮色下自己气泡的目标 luma：与微信亮色绿气泡 #9df29f 同档（207，与画布差 43）。
 *  按 luma 定标而非按 HSL 明度定标——绿色 G 分量天然高、蓝紫天然低，同一个 L 下
 *  蓝气泡比绿气泡"重"一截（L0.78 的蓝 #9CBDF2 luma 185，比微信重 22），
 *  周工反馈的"怪"即源于此。二分明度让每种主题色的气泡都落在同一视觉重量档。 */
const LIGHT_MINE_BUBBLE_LUMA = 207;
/** 亮色浅底的饱和度上限：0.62 雾感（周工拍板 C 档）——足够有色区分归属，
 *  又不与全局 Slate 灰阶 UI 打架；0.77 的原饱和在近白画布上偏"糖果感/系统高亮感"。 */
const LIGHT_MINE_BUBBLE_S_MAX = 0.62;
/** 亮色下气泡文字（同色相深字）的明度：0.10 ≈ 近黑、留一点色味（微信气泡上就是黑字）。 */
const LIGHT_MINE_TEXT_L = 0.1;
const LIGHT_MINE_TEXT_S_MAX = 0.75;
/** 亮色下对方气泡＝浅灰，暗于近白的画布（周工定的方向：聊天区近白、气泡灰一点）。
 *  历史教训：早期对方气泡 = #f1f5f9 与画布完全同色（对比 1.00），等于没有气泡。 */
const LIGHT_OTHER_BUBBLE = "#eeeef0";

/**
 * 暗色下柔化「我的气泡」：气泡压暗并混入深色画布，文字同步去掉纯白。
 * 只处理自己发出的气泡（对方气泡本身已是深色，不动）。
 * 已经够暗的气泡（如石墨灰）mixToLuma 会原样返回，不会被压得消失。
 */
function softenMineForDark(c: ChatPresetColors): ChatPresetColors {
  return {
    ...c,
    mineBubble: mixToLuma(c.mineBubble, DARK_BG_RGB, DARK_MINE_BUBBLE_LUMA),
    mineText: mixToLuma(c.mineText, BLACK_RGB, DARK_MINE_TEXT_LUMA),
  };
}

/**
 * 亮色下"自己气泡"＝主色的浅调，按目标 luma 二分明度定标：
 * 暖色（琥珀）luma 天然高、冷色（蓝紫）天然低，各自找到自己的 HSL 明度，
 * 最终气泡的视觉重量保持一致（207 ± 2）。饱和度封顶 LIGHT_MINE_BUBBLE_S_MAX。
 */
function lightMineBubble(themeColor: string): string {
  let lo = 0.6;
  let hi = 0.92;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const l = luma(adjustHsl(themeColor, { l: mid, sMax: LIGHT_MINE_BUBBLE_S_MAX }));
    if (l < LIGHT_MINE_BUBBLE_LUMA) lo = mid;
    else hi = mid;
  }
  return adjustHsl(themeColor, { l: (lo + hi) / 2, sMax: LIGHT_MINE_BUBBLE_S_MAX });
}

/**
 * 解析某预设的实际气泡配色。"theme" 预设按主题色运行时派生：
 * 亮色：自己的气泡 = 主题色的浅调（luma 定标到微信档）+ 同色相深字；
 * 对方气泡 = 浅灰底 + 深字。暗色：主题色实底 + 白字，走 softenMineForDark 压暗。
 */
export function resolveChatColors(key: string, themeColor: string, dark: boolean): ChatPresetColors {
  const preset = findPreset(key);
  if (preset.key !== "theme") return dark ? softenMineForDark(preset.dark) : preset.light;

  // 亮色：微信式浅底深字——自己的气泡取主题色的浅调、字取同色相深调，
  // 与对方的浅灰气泡同为浅底，只靠色相区分归属。
  const light: ChatPresetColors = {
    mineBubble: lightMineBubble(themeColor),
    mineText: adjustHsl(themeColor, { l: LIGHT_MINE_TEXT_L, sMax: LIGHT_MINE_TEXT_S_MAX }),
    otherBubble: LIGHT_OTHER_BUBBLE,
    otherText: "#0f172a",
  };
  // 暗色：主题色实底 + 白字，再走柔化压暗。
  const darkBase: ChatPresetColors = {
    mineBubble: themeColor,
    mineText: "#ffffff",
    otherBubble: "#1e293b",
    otherText: "#e2e8f0",
  };
  return dark ? softenMineForDark(darkBase) : light;
}

export function fontPx(size: FontSizeKey): number {
  return CHAT_FONT_SIZES.find((f) => f.key === size)?.px ?? 14;
}

/**
 * @提及 高亮文字色（微信式"蓝字提及"）：从主题色派生，但不直接用主题色——
 * 老坑：text-primary 在浅蓝气泡上对比只有 2.94。亮色取主题色深调、暗色取亮调，
 * 对传入的气泡底逐步压深/提亮直到 WCAG ≥ 4.5。bubbleBg 传实际渲染的底色
 * （气泡 inline style 的 background / 输入框面板的近似底），预设差异天然被覆盖。
 * 返回空串表示极端底色下无解，调用方回退 inherit（退化为加粗+浅底，即旧行为）。
 */
export function mentionHighlightColor(themeColor: string, dark: boolean, bubbleBg: string): string {
  const levels = dark ? [0.82, 0.86, 0.9, 0.94] : [0.32, 0.28, 0.24, 0.2, 0.16, 0.12];
  const sMax = dark ? 0.75 : 0.85;
  for (const l of levels) {
    const fg = adjustHsl(themeColor, { l, sMax });
    if (contrastRatio(fg, bubbleBg) >= 4.5) return fg;
  }
  return "";
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 时间分割线文案（微信式智能格式）：
 *  今天只报时分；昨天报「昨天 HH:mm」；一周内报星期；今年内报「M月D日 HH:mm」；跨年带年份。 */
export function formatTimeDivider(ts: number, now: number = Date.now()): string {
  const d = dayjs(ts);
  const n = dayjs(now);
  const hm = d.format("HH:mm");
  if (d.isSame(n, "day")) return hm;
  if (d.isSame(n.subtract(1, "day"), "day")) return `昨天 ${hm}`;
  if (n.diff(d, "day") < 7) return `${WEEKDAYS[d.day()]} ${hm}`;
  if (d.isSame(n, "year")) return `${d.format("M月D日")} ${hm}`;
  return `${d.format("YYYY年M月D日")} ${hm}`;
}

/** 解析对端广播来的样式 JSON（坏数据回退默认）。 */
export function parsePeerStyle(raw: string): ChatStyleConfig {
  try {
    const v = JSON.parse(raw) as Partial<ChatStyleConfig>;
    return {
      preset: typeof v.preset === "string" ? v.preset : DEFAULT_CHAT_STYLE.preset,
      fontSize: (["sm", "md", "lg"] as const).includes(v.fontSize as FontSizeKey)
        ? (v.fontSize as FontSizeKey)
        : DEFAULT_CHAT_STYLE.fontSize,
    };
  } catch {
    return DEFAULT_CHAT_STYLE;
  }
}
