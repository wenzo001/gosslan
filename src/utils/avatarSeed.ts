// 默认头像（#32）：emoji × 按色系排序的背景色（调色板 + 自定义色）。
//
// 为什么是"从 id 现算"而不是"首次初始化随机一次再存起来"：
// - 存起来要多一个跨设备字段（上传头像那条链路之外再走一遍同步），而 id 本来就在每一帧里；
// - 现算 ⇒ 换设备、重装、清缓存之后同一个人还是同一张脸，且**所有对端看到的也是同一张**；
// - 用户上传了真头像时优先级在调用方（有 avatar 就不走这里），这里只负责"没有头像时长什么样"。
//
// 组合由下面的 `AVATAR_PAIRS` 按固定步长现算；背景色是一份按色系手工排序的调色板。
// 所有颜色都落在相对亮度 0.18–0.72（`isAvatarBackground` 与 `avatarSeed.test.ts` 同一口径），
// 太亮/太暗都会让 emoji 看不清。

import { bytesToBase64 } from "./imageBytes.ts";

export interface AvatarSeed {
  emoji: string;
  bg: string;
}

// 可选表情：动物 + 表情/角色 + 少量自然与物件。全部是单字形（没有 ZWJ 组合），
// 避免不同平台把组合 emoji 渲染成两个字形、把 40px 的格子撑破。
export const AVATAR_EMOJIS: readonly string[] = [
  // 动物（沿用原有一批）
  "🦊", "🐺", "🐻", "🐼", "🐨", "🦁", "🐯", "🐮", "🐷", "🐸", "🐵", "🐔",
  "🐧", "🦆", "🦅", "🦉", "🐇", "🦔", "🦇", "🐬", "🐳", "🦈", "🐙", "🦀",
  "🐢", "🦎", "🐝", "🦋", "🐞", "🐌", "🐥", "🦜", "🐘", "🦒", "🐪", "🦥",
  // 表情 / 角色
  "😀", "😊", "😎", "🤓", "🤔", "😴", "🤩", "🥳", "😇", "🤠", "👻", "🤖",
  // 更多动物
  "🐱", "🐶", "🐭", "🐹", "🐰", "🐿️", "🦝", "🦦", "🦄", "🐲",
  // 自然 / 物件
  "🌵", "🌲", "🌸", "🌻", "🍀", "🍁", "🌙", "⭐", "🔥", "🌈",
  "☕", "🎮", "🎧", "🚀",
];

/**
 * 可选背景色：按**色系相邻**手工排序（红 → 橙 → 琥珀 → 绿 → 青 → 蓝 → 靛 → 紫 → 粉 → 棕 → 灰），
 * 同一色系里从深到浅。这样相近的颜色挨在一起，用户找色时不用在 30 多个相近的深色里来回扫。
 *
 * 与旧实现的区别：旧清单是从 `AVATAR_PAIRS` 里 `new Set` 出来的，顺序由"哪个表情先用到"决定，
 * 观感上就是一堆色相接近的蓝/棕随机排列（用户 2026-10-22：「很多颜色背面太相近了」）。
 * 现在颜色是一份独立清单；随机组合仍然只从下面的 `AVATAR_PAIRS` 取，手动选择则可以选任意
 * 表情 + 任意色（再加一个自定义色），所以**不再宣称"手动与随机是同一批数据"**。
 */
export const AVATAR_BACKGROUNDS: readonly string[] = [
  // 红
  "#cd5951", "#d87f79", "#e3a5a0",
  // 橙
  "#cd8551", "#d8a079", "#e3bca0",
  // 琥珀
  "#cda751", "#d8bb79", "#e3cfa0",
  // 绿
  "#51cd85", "#79d8a0", "#a0e3bc",
  // 青
  "#51cdc8", "#79d8d5", "#a0e3e1",
  // 蓝（#4284b3 是旧默认蓝，保留以兼容旧头像与既有判据）
  "#4284b3", "#79a5d8", "#a0c0e3",
  // 靛
  "#6972d3", "#888fdd", "#a8ade6",
  // 紫
  "#a269d3", "#b588dd", "#c9a8e6",
  // 粉
  "#cd518f", "#d879a8", "#e3a0c2",
  // 棕（低饱和，与橙分开）
  "#a37a5c", "#b6947c", "#c8af9d",
  // 灰
  "#757c8a", "#9196a1", "#acb0b9",
];

/**
 * 随机组合的池子：每个表情固定配 3 个颜色，色相跨度拉开。
 * 只用于 `avatarSeedFor` / `randomAvatarPair`；手动选择器展示的是
 * `AVATAR_EMOJIS × AVATAR_BACKGROUNDS`（再加自定义色），比随机池更宽。
 */
export const AVATAR_PAIRS: readonly AvatarSeed[] = AVATAR_EMOJIS.flatMap((emoji, i) =>
  [0, 11, 22].map((step) => ({
    emoji,
    bg: AVATAR_BACKGROUNDS[(i + step) % AVATAR_BACKGROUNDS.length]!,
  })),
);

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * 接受调色板色或任意 6 位 hex 自定义色，表情仍必须来自 `AVATAR_EMOJIS`。
 * SVG 里会同时写入 emoji 与 bg，所以 hex 正则是注入边界，不放宽成任意字符串。
 * （随机组合仍只从中间调调色板取；自定义色是用户明确选择，不再套亮度闸门。）
 */
export function isAvatarSeed(value: { emoji?: string; bg?: string } | null | undefined): value is AvatarSeed {
  return (
    !!value &&
    typeof value.emoji === "string" &&
    AVATAR_EMOJIS.includes(value.emoji) &&
    typeof value.bg === "string" &&
    HEX_COLOR.test(value.bg)
  );
}

/**
 * 手动搭配的落库形式：**一张 SVG 图片的 data URL**，继续走 `avatar` 原有那条图片通道。
 *
 * 为什么不加字段：头像在协议里只有 `Option<String>` 这一格，落库也只有 `settings.avatar`；
 * 加 `avatar_emoji`/`avatar_bg` 要同时动数据库、Hello/UserInfo 与好友表，属于本需求不值的
 * 协议改造。做成图片后，老版本对端也只是"看到一张图"，没有兼容分支。
 *
 * 为什么必须 base64：Rust 的 `avatar_decoded_len` 只按 base64 解出来的字节数判上限，
 * 百分号编码的 SVG 会被当成超限拒收。整串约 0.6KB，刚好落在 Hello 的 2KB 闸门内
 * （`handshake.rs` 的 `HELLO_AVATAR_MAX_BYTES`），新好友握手即可见。
 *
 * `data-*` 里回写组合本身：用户下次打开选择器能从当前头像还原出选中的那一格。
 */
const PRESET_PREFIX = "data:image/svg+xml;base64,";
const PRESET_MARK = "gosslan-avatar-preset";

export function avatarPresetDataUrl(seed: AvatarSeed): string {
  if (!isAvatarSeed(seed)) throw new Error("avatar preset must use a listed emoji and a mid-tone hex color");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100" ` +
    `data-${PRESET_MARK}="1" data-emoji="${seed.emoji}" data-bg="${seed.bg}">` +
    `<rect width="100" height="100" fill="${seed.bg}"/>` +
    `<text x="50" y="50" dy=".35em" text-anchor="middle" font-size="62" ` +
    `font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${seed.emoji}</text></svg>`;
  return PRESET_PREFIX + bytesToBase64(new TextEncoder().encode(svg));
}

/** 当前头像是不是本机选择器生成的预设；普通上传图片一律返回 null（不做无谓的解码）。 */
export function parseAvatarPreset(avatar: string | null | undefined): AvatarSeed | null {
  if (!avatar?.startsWith(PRESET_PREFIX)) return null;
  try {
    const binary = atob(avatar.slice(PRESET_PREFIX.length));
    const svg = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    if (!svg.includes(`data-${PRESET_MARK}="1"`)) return null;
    const emoji = /data-emoji="([^"]*)"/.exec(svg)?.[1] ?? "";
    const bg = /data-bg="(#[0-9a-f]{6})"/i.exec(svg)?.[1]?.toLowerCase() ?? "";
    const seed = { emoji, bg };
    return isAvatarSeed(seed) ? seed : null;
  } catch {
    return null;
  }
}

/** 随机一个组合：尽量不和当前这张重复（否则点了"随机"像没反应）。 */
export function randomAvatarPair(exclude?: AvatarSeed | null): AvatarSeed {
  const pool = exclude
    ? AVATAR_PAIRS.filter((p) => p.emoji !== exclude.emoji || p.bg !== exclude.bg)
    : AVATAR_PAIRS;
  const list = pool.length > 0 ? pool : AVATAR_PAIRS;
  return list[Math.floor(Math.random() * list.length)]!;
}

/** FNV-1a（32 位）：小而稳、跨语言可复算，不引依赖。 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** id 缺失时返回 null：调用方各自决定兜底，这里不替它挑一张脸。 */
export function avatarSeedFor(id: string | null | undefined): AvatarSeed | null {
  if (!id) return null;
  return AVATAR_PAIRS[fnv1a(id) % AVATAR_PAIRS.length] ?? null;
}
