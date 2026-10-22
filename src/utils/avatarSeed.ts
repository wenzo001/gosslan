// 默认头像（#32）：emoji 小动物 × 逐对挑过的背景色。
//
// 为什么是"从 id 现算"而不是"首次初始化随机一次再存起来"：
// - 存起来要多一个跨设备字段（上传头像那条链路之外再走一遍同步），而 id 本来就在每一帧里；
// - 现算 ⇒ 换设备、重装、清缓存之后同一个人还是同一张脸，且**所有对端看到的也是同一张**；
// - 用户上传了真头像时优先级在调用方（有 avatar 就不走这里），这里只负责"没有头像时长什么样"。
//
// 表是 scripts 一次性生成后粘进来的（生成器不在仓里：它是一次性工具，留着只会变成第二份真源）。
// 每一行的背景色都按该 emoji 自己的主色挑过互补/邻近/中性三个色相，且相对亮度落在中间调
// —— 这条不是审美声明，`avatarSeed.test.ts` 里有判据量它。

import { bytesToBase64 } from "./imageBytes.ts";

export interface AvatarSeed {
  emoji: string;
  bg: string;
}

export const AVATAR_PAIRS: readonly AvatarSeed[] = [
  { emoji: "🦊", bg: "#4284b3" }, { emoji: "🦊", bg: "#43a373" }, { emoji: "🦊", bg: "#b06c3b" },
  { emoji: "🐺", bg: "#a87c3e" }, { emoji: "🐺", bg: "#4383a3" }, { emoji: "🐺", bg: "#936acd" },
  { emoji: "🐻", bg: "#3e8da8" }, { emoji: "🐻", bg: "#a37343" }, { emoji: "🐻", bg: "#8b6acd" },
  { emoji: "🐼", bg: "#a88d3e" }, { emoji: "🐼", bg: "#4383a3" }, { emoji: "🐼", bg: "#c6539f" },
  { emoji: "🐨", bg: "#4580ba" }, { emoji: "🐨", bg: "#a37b43" }, { emoji: "🐨", bg: "#39ac73" },
  { emoji: "🦁", bg: "#8c6ec9" }, { emoji: "🦁", bg: "#a37343" }, { emoji: "🦁", bg: "#3999ac" },
  { emoji: "🐯", bg: "#8072cb" }, { emoji: "🐯", bg: "#43a373" }, { emoji: "🐯", bg: "#ac7339" },
  { emoji: "🐮", bg: "#3e84a8" }, { emoji: "🐮", bg: "#a37343" }, { emoji: "🐮", bg: "#c7577c" },
  { emoji: "🐷", bg: "#507ebe" }, { emoji: "🐷", bg: "#a38b43" }, { emoji: "🐷", bg: "#39ac73" },
  { emoji: "🐸", bg: "#bc6549" }, { emoji: "🐸", bg: "#8b6ec4" }, { emoji: "🐸", bg: "#ac9939" },
  { emoji: "🐵", bg: "#3e84a8" }, { emoji: "🐵", bg: "#a37343" }, { emoji: "🐵", bg: "#c6538c" },
  { emoji: "🐔", bg: "#4580ba" }, { emoji: "🐔", bg: "#bc5c8c" }, { emoji: "🐔", bg: "#39ac73" },
  { emoji: "🐧", bg: "#a8733e" }, { emoji: "🐧", bg: "#4383a3" }, { emoji: "🐧", bg: "#c6538c" },
  { emoji: "🦆", bg: "#8072cb" }, { emoji: "🦆", bg: "#b16b48" }, { emoji: "🦆", bg: "#39ac73" },
  { emoji: "🦅", bg: "#3e8da8" }, { emoji: "🦅", bg: "#a37343" }, { emoji: "🦅", bg: "#936acd" },
  { emoji: "🦉", bg: "#b66a43" }, { emoji: "🦉", bg: "#8072c5" }, { emoji: "🦉", bg: "#39ac73" },
  { emoji: "🐇", bg: "#507ebe" }, { emoji: "🐇", bg: "#a37343" }, { emoji: "🐇", bg: "#c6538c" },
  { emoji: "🦔", bg: "#3e8da8" }, { emoji: "🦔", bg: "#8f6bc2" }, { emoji: "🦔", bg: "#ac8f39" },
  { emoji: "🦇", bg: "#a8843e" }, { emoji: "🦇", bg: "#4783ae" }, { emoji: "🦇", bg: "#c6538c" },
  { emoji: "🐬", bg: "#af6f41" }, { emoji: "🐬", bg: "#bc5c8c" }, { emoji: "🐬", bg: "#39ac73" },
  { emoji: "🐳", bg: "#8072cb" }, { emoji: "🐳", bg: "#b16b48" }, { emoji: "🐳", bg: "#39ac73" },
  { emoji: "🦈", bg: "#a8733e" }, { emoji: "🦈", bg: "#8f6bc2" }, { emoji: "🦈", bg: "#39ac73" },
  { emoji: "🐙", bg: "#3e8da8" }, { emoji: "🐙", bg: "#a38b43" }, { emoji: "🐙", bg: "#936acd" },
  { emoji: "🦀", bg: "#4284b3" }, { emoji: "🦀", bg: "#43a373" }, { emoji: "🦀", bg: "#ac8f39" },
  { emoji: "🐢", bg: "#bc6549" }, { emoji: "🐢", bg: "#8f6bc2" }, { emoji: "🐢", bg: "#ac8f39" },
  { emoji: "🦎", bg: "#4284b3" }, { emoji: "🦎", bg: "#b7684e" }, { emoji: "🦎", bg: "#c6538c" },
  { emoji: "🐝", bg: "#8c6ec9" }, { emoji: "🐝", bg: "#b16b48" }, { emoji: "🐝", bg: "#3986ac" },
  { emoji: "🦋", bg: "#b66a43" }, { emoji: "🦋", bg: "#a38b43" }, { emoji: "🦋", bg: "#3986ac" },
  { emoji: "🐞", bg: "#3e8da8" }, { emoji: "🐞", bg: "#a38b43" }, { emoji: "🐞", bg: "#936acd" },
  { emoji: "🐌", bg: "#916ac8" }, { emoji: "🐌", bg: "#4383a3" }, { emoji: "🐌", bg: "#ac7339" },
  { emoji: "🐥", bg: "#507ebe" }, { emoji: "🐥", bg: "#8f6bc2" }, { emoji: "🐥", bg: "#39ac73" },
  { emoji: "🦜", bg: "#8072cb" }, { emoji: "🦜", bg: "#b16b48" }, { emoji: "🦜", bg: "#39ac73" },
  { emoji: "🐘", bg: "#af6f41" }, { emoji: "🐘", bg: "#4783ae" }, { emoji: "🐘", bg: "#c6538c" },
  { emoji: "🦒", bg: "#8072cb" }, { emoji: "🦒", bg: "#438ba3" }, { emoji: "🦒", bg: "#39ac73" },
  { emoji: "🐪", bg: "#4580ba" }, { emoji: "🐪", bg: "#8f6bc2" }, { emoji: "🐪", bg: "#39ac73" },
  { emoji: "🦥", bg: "#bc6549" }, { emoji: "🦥", bg: "#4783ae" }, { emoji: "🦥", bg: "#936acd" },
]

/**
 * 选择器可选的**全部**表情与背景色 —— 从 `AVATAR_PAIRS` 派生，不另立第二份清单。
 * 随机算法也从这份表里取，所以"手动能选到的"与"随机能抽到的"永远是同一批数据。
 */
export const AVATAR_EMOJIS: readonly string[] = [...new Set(AVATAR_PAIRS.map((p) => p.emoji))];
export const AVATAR_BACKGROUNDS: readonly string[] = [...new Set(AVATAR_PAIRS.map((p) => p.bg))];

export function isAvatarSeed(value: { emoji?: string; bg?: string } | null | undefined): value is AvatarSeed {
  return (
    !!value &&
    typeof value.emoji === "string" &&
    typeof value.bg === "string" &&
    AVATAR_EMOJIS.includes(value.emoji) &&
    AVATAR_BACKGROUNDS.includes(value.bg)
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
  if (!isAvatarSeed(seed)) throw new Error("avatar preset must come from AVATAR_PAIRS");
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
    const bg = /data-bg="(#[0-9a-f]{6})"/.exec(svg)?.[1] ?? "";
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
