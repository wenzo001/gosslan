/**
 * 聊天正文的链接切分。仅匹配 http(s)://，避免误识别 + 避免 javascript:/data: 等危险 scheme。
 * 返回 text/link 段数组，渲染端按段拼回去即可（不要用 v-html 拼接，已天然防 XSS）。
 *
 * 尾随标点处理：英文句末的 . , ; : ! ? ) ] } > 不算 URL 一部分，剥出来当普通文本。
 * 例如 "看 https://a.com, 还有 b" → ["看 ", link("https://a.com"), ", 还有 b"]。
 */

export type LinkSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'()\[\]{}]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}>]+$/;

export function linkify(text: string): LinkSegment[] {
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

/** 超长 URL 截断显示（中间省略号），避免把气泡撑爆。 */
export function displayUrl(url: string, maxLen = 48): string {
  if (url.length <= maxLen) return url;
  const half = Math.floor((maxLen - 1) / 2);
  return url.slice(0, half) + "…" + url.slice(-half);
}
