/** 文本 HTML 转义：搜索结果高亮只拼转义后的字符串，不做 HTML 解析。 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 将文本按关键词分割，用 <mark> 包裹匹配部分（输入已转义，无 XSS 面）。 */
export function highlightText(text: string, kw: string): string {
  if (!kw) return escHtml(text);
  const safe = escHtml(text);
  const safeKw = escHtml(kw);
  const regex = new RegExp(`(${safeKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return safe.replace(
    regex,
    '<mark class="bg-yellow-200 dark:bg-yellow-800/50 rounded-[var(--gosslan-radius-xs)] px-0.5">$1</mark>',
  );
}
