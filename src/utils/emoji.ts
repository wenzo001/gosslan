// 抖音评论区表情：图片资源统一三端渲染（不依赖 Unicode），并按「[名字]」token 混合排版。
//
// - 图片经 Vite import.meta.glob 打包，按文件名映射到最终 URL（webp/png 混用）。
// - splitEmoji 把正文按「[名字]」切成 text/emoji 段，文本段再交给 linkify 切链接/提及。
// - 只匹配已知表情名，绝不误吞正文里的其它方括号（如 [图片] / [代码] 占位）。

import { EMOJI_META } from "@/data/emojis";

/** 表情图片：文件名 → 打包后 URL。 */
const emojiImages = import.meta.glob("../assets/emojis/*.{webp,png}", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const urlByFile = new Map<string, string>();
for (const [p, url] of Object.entries(emojiImages)) {
  urlByFile.set(p.split("/").pop() ?? "", url);
}

export interface EmojiDef {
  name: string;
  /** 消息里出现的 token 语法，如 "[微笑]" */
  displayName: string;
  file: string;
  url: string;
}

/** 全部表情（顺序即抖音网页上下排布顺序）。 */
export const EMOJIS: EmojiDef[] = EMOJI_META.map((m) => ({
  name: m.name,
  displayName: m.display_name,
  file: m.file,
  url: urlByFile.get(m.file) ?? "",
}));

const byName = new Map(EMOJIS.map((e) => [e.name, e]));
const byDisplayName = new Map(EMOJIS.map((e) => [e.displayName, e]));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 名字按长度降序，保证长名优先匹配（同名前缀不会抢在长名前）。
const NAMES = EMOJIS.map((e) => e.name).sort((a, b) => b.length - a.length);
const EMOJI_RE = new RegExp(`\\[(${NAMES.map(escapeRe).join("|")})\\]`, "g");

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "emoji"; value: string; name: string; url: string };

/** 按表情 token（[名字]）切成 text/emoji 段；不认识的内容保持 text 原样。 */
export function splitEmoji(text: string): TextSegment[] {
  if (!text) return [];
  const segs: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    const start = m.index ?? 0;
    const def = byName.get(m[1]);
    if (!def) continue; // 理论不会发生（正则由名字集生成），兜底跳过
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    segs.push({ kind: "emoji", value: m[0], name: def.name, url: def.url });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) });
  return segs;
}

/** display_name（如 "[微笑]"）→ 图片 URL；未知返回 null。 */
export function emojiUrl(displayName: string): string | null {
  return byDisplayName.get(displayName)?.url ?? null;
}
