import { escapeRe } from "./escapeRe.ts";

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
/**
 * 关键词 → 正则 的模块级缓存（审计 P1 #20）。
 *
 * `highlightText` 在日志页是**逐行**调用的，而日志页每 2 秒全表重算一次：
 * 几千行 × 6 遍渲染 = 每次上万次 `new RegExp`。关键词本身的种类是**个位数**
 * （用户一个一个敲出来的前缀），所以按关键词缓存就足够；上限 32 防"每敲一个字都留一份"。
 * 编译失败不缓存（非法输入每次都会抛同一件事，缓存它没有收益，还会掩盖错误位置）。
 */
const REGEX_CACHE = new Map<string, RegExp>();
const REGEX_CACHE_MAX = 32;

function highlightRegex(kw: string): RegExp {
  const hit = REGEX_CACHE.get(kw);
  if (hit) {
    // LRU：命中即刷新（Map 保序，删了再插回到尾部）。
    REGEX_CACHE.delete(kw);
    REGEX_CACHE.set(kw, hit);
    return hit;
  }
  const re = new RegExp(`(${escapeRe(kw)})`, "gi");
  if (REGEX_CACHE.size >= REGEX_CACHE_MAX) {
    const oldest = REGEX_CACHE.keys().next().value;
    if (oldest !== undefined) REGEX_CACHE.delete(oldest);
  }
  REGEX_CACHE.set(kw, re);
  return re;
}

export function highlightText(text: string, kw: string): string {
  if (!kw) return escHtml(text);
  const regex = highlightRegex(kw);
  // split 带捕获组时，奇数下标恰好就是命中的那些片段
  return text
    .split(regex)
    .map((part, i) => (i % 2 === 1 ? `${MARK_OPEN}${escHtml(part)}</mark>` : escHtml(part)))
    .join("");
}
