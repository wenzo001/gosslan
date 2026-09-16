/** 文本 HTML 转义：搜索结果高亮只拼转义后的字符串，不做 HTML 解析。 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MARK_OPEN =
  '<mark class="bg-yellow-200 dark:bg-yellow-800/50 rounded-[var(--gosslan-radius-xs)] px-0.5">';

/**
 * 将文本按关键词分割，用 <mark> 包裹匹配部分。
 *
 * ⚠️ 必须**先在原文上匹配、再逐段转义**。换成「先 escHtml 整段、再在转义结果上替换」
 * 就会让关键词命中实体名的内部：转义后 `&` 变成 `&amp;`，此时搜 `amp`（`example` 里也有）
 * 会连实体一起标记，产出 `ex<mark>amp</mark>le &<mark>amp</mark>; more`，
 * 渲染出来是字面的 `&amp;`。先在原文上切开，`&` 在匹配阶段还是 `&`，转义只发生在切片之后。
 */
export function highlightText(text: string, kw: string): string {
  if (!kw) return escHtml(text);
  const regex = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  // split 带捕获组时，奇数下标恰好就是命中的那些片段
  return text
    .split(regex)
    .map((part, i) => (i % 2 === 1 ? `${MARK_OPEN}${escHtml(part)}</mark>` : escHtml(part)))
    .join("");
}
