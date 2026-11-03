/**
 * 更新说明（`latest.json` 里的 notes）的 Markdown 渲染。
 *
 * 来源是**我们自己的 CHANGELOG 片段**，但它是从网络上取回来的 ⇒ 按不可信内容处理：
 * 先 `marked` 解析，再 `DOMPurify` 按白名单消毒，只留排版与链接。
 *
 * 为什么白名单这么窄：说明里只会出现标题/段落/列表/粗体/行内代码/链接。
 * 表格与图片没有需求，留着只会多一片可被利用的面（图片还能发起外部请求）。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "a",
  "hr",
];
const ALLOWED_ATTR = ["href", "title", "rel", "target"];

/**
 * 源文本硬上限（审计第 5 项）：`marked.parse` + `DOMPurify.sanitize` 是**同步主线程**活，
 * 耗时随长度涨。说明来源是我们自己的 CHANGELOG 片段（一节几 KB 量级），超长只可能是
 * 病态输入或取数出错 ⇒ 截断并留一个可辨认的省略号。输入有上限，两步同步开销就有
 * 上限（不必为更新面板单开 worker）。判据见 `markdown.test.ts`。
 */
export const NOTES_MAX_CHARS = 32_000;

/**
 * 超上限截断（纯函数 ⇒ 可在 Node 单测；渲染入口在 DOM 环境里，测试够不着 marked 那步）。
 * 不超原样返回；超了截到上限并追加一个独立段落的省略号（用户看得见"被截了"，
 * 不是无声吞掉）。
 */
export function capNotesText(text: string): string {
  if (text.length <= NOTES_MAX_CHARS) return text;
  return `${text.slice(0, NOTES_MAX_CHARS)}\n\n…`;
}

/** 渲染成可 `v-html` 的安全片段。空输入返回空串（界面据此不画说明区）。 */
export function renderNotesMarkdown(src: string | null | undefined): string {
  let text = (src ?? "").trim();
  if (!text) return "";
  text = capNotesText(text);
  // `async: false`：同步返回字符串（该库在有 `async` 选项时才返回 Promise）。
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // 链接一律外部打开（见 `MarkdownText.vue` 的点击拦截）；这里不给它们加 target，
    // 也不允许 `javascript:` 之类的协议（DOMPurify 默认就挡）。
  });
}

/** 说明里出现的外链是否该交给系统浏览器（`file:`/相对路径不算）。 */
export function isExternalLink(href: string | null | undefined): boolean {
  const h = (href ?? "").trim();
  return /^https?:\/\//i.test(h);
}
