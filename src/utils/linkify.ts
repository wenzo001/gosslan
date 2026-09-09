/**
 * 聊天正文的链接切分。仅匹配 http(s)://，避免误识别 + 避免 javascript:/data: 等危险 scheme。
 * 返回 text/link 段数组，渲染端按段拼回去即可（不要用 v-html 拼接，已天然防 XSS）。
 *
 * 尾随标点处理：英文句末的 . , ; : ! ? ) ] } > 不算 URL 一部分，剥出来当普通文本。
 * 例如 "看 https://a.com, 还有 b" → ["看 ", link("https://a.com"), ", 还有 b"]。
 */

export type LinkSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string }
  | { kind: "mention"; value: string };

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}>]+$/;

/** @name 边界：@ 前须是行首/空白（防邮箱误判），名字后允许跟空白或中英文常用标点。
 *  导出供 messages.ts 的「被 @ 检测」复用——高亮与检测必须同一套边界语义。 */
export const MENTION_AFTER = String.raw`(?=$|[\s，。！？；：、,.!?;:)）】》"'])`;

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 成员名 → @提及 正则（长名优先，防短名吃掉长名前缀；无有效名字返回 null）。 */
function buildMentionRe(names: string[]): RegExp | null {
  const uniq = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (uniq.length === 0) return null;
  return new RegExp(`(^|\\s)@(${uniq.map(escapeRe).join("|")})${MENTION_AFTER}`, "g");
}

function linkifyUrls(text: string): LinkSegment[] {
  if (!text) return [];
  const segments: LinkSegment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    const trimmed = raw.replace(TRAILING_PUNCT, "");
    const trailing = raw.slice(trimmed.length);

    if (start > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, start) });
    }
    segments.push({ kind: "link", value: trimmed, href: trimmed });
    if (trailing) segments.push({ kind: "text", value: trailing });

    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * 聊天正文切分：链接 + @提及。mentions 传群成员名列表（@name 高亮）。
 * 返回 text/link/mention 段数组，渲染端按段拼回去即可（不要用 v-html 拼接，已天然防 XSS）。
 */
export function linkify(text: string, mentions: string[] = []): LinkSegment[] {
  if (!text) return [];
  const mentionRe = buildMentionRe(mentions);
  if (!mentionRe) return linkifyUrls(text);

  const segments: LinkSegment[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(mentionRe)) {
    const start = m.index ?? 0;
    const lead = m[1]; // 行首或前导空白
    const mentionStart = start + lead.length;
    if (mentionStart > lastIndex) {
      segments.push(...linkifyUrls(text.slice(lastIndex, mentionStart)));
    }
    segments.push({ kind: "mention", value: `@${m[2]}` });
    lastIndex = start + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push(...linkifyUrls(text.slice(lastIndex)));
  }
  return segments;
}

/** 超长 URL 截断显示（中间省略号），避免把气泡撑爆。 */
export function displayUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  const half = Math.floor((maxLen - 1) / 2);
  return url.slice(0, half) + "…" + url.slice(-half);
}
