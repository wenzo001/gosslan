/**
 * 机器人消息的**正文渲染**。
 *
 * ## 为什么单独一个文件
 *
 * 机器人消息来自**外部**：正文可能是纯文本，也可能是 Markdown；来源名、文件名、
 * 正文一律当**不可信输入**。渲染链路必须满足三件事：
 *
 * 1. **纯文本按纯文本显示**（不把外部消息里的 `<b>` 当标签渲染出来）；
 * 2. **Markdown 按 Markdown 渲染**（标题、列表、表格、代码块、引用、链接……）；
 * 3. **渲染结果必须消毒** —— 外部内容里的 `<script>`、事件属性、`javascript:` 链接
 *    一律不许进 DOM。
 *
 * ## 分两层（为什么）
 *
 * - `botMessageToHtml`：**纯逻辑**（转义 / marked 解析 / 丢弃 raw HTML）⇒ **可单测**；
 * - `renderBotMessage`：在纯逻辑产物上再过一遍 **DOMPurify**（第二道）⇒ 需要 DOM，
 *   生产在 WebView 跑；测试注入 `createDOMPurify(window)`（happy-dom）同样能自动测这一层。
 *
 * 为什么在 marked 那一层也把 **raw HTML 掐掉**：marked 默认会把正文里的
 * `<script>`/`<img>` 当**原始 HTML** 透传进产物。两层都挡（深度防御）：
 * 前一层纯逻辑可单测 ✔；后一层用注入的 DOM 实例可单测 ✔（7.x P2 补上）。
 *
 * ## 与既有 Markdown 工具的关系
 *
 * 主仓已有 `utils/markdown.ts`（给「更新说明」用），白名单是**说明场景**的（没有表格/代码块）。
 * 机器人消息要「全格式」，但**多两条硬约束**：
 *
 * - **禁 `img`**：外部 Markdown 里的远程图片**不自动加载**（会变跟踪像素 + 让客户端替人抓图）。
 *   图片一律走 `image[]` 附件，由本应用自己的图片通道渲染。
 * - **禁 `style`** 与一切事件属性。
 *
 * @see src/utils/markdown.ts（说明场景的窄白名单版）
 */

import { Marked } from "marked";
import DOMPurify from "dompurify";

/** 机器人消息允许的 Markdown 产出标签（比说明场景宽，但**没有 `img`**）。 */
export const BOT_MESSAGE_ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

const BOT_MESSAGE_ALLOWED_ATTR = ["href", "title", "rel", "target"];

/** 机器人正文的长度上限（字符）—— 渲染是同步主线程活，超长只可能是病态输入。 */
export const BOT_MESSAGE_MAX_CHARS = 32_000;

/** 正文格式：纯文本 or Markdown。 */
export type BotMessageFormat = "text" | "markdown";

/** 把服务端给的 `format` 归一化（不认识的一律按纯文本，不猜）。 */
export function normalizeBotFormat(raw: string | null | undefined): BotMessageFormat {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "markdown" || v === "md" ? "markdown" : "text";
}

/** 超上限截断（纯函数 ⇒ 可单测；截断要留下可辨认的省略号，不无声吞掉）。 */
export function capBotMessageText(text: string): string {
  if (text.length <= BOT_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, BOT_MESSAGE_MAX_CHARS)}\n\n…`;
}

/** 属性转义（href/title 里可能有引号与尖括号）。 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 只放行这些协议；`javascript:` / `data:` / `vbscript:` 一律丢掉 href。 */
function safeHref(href: string): string {
  const v = String(href ?? "").trim();
  return /^(https?:|mailto:|tel:|#|\/)/i.test(v) ? escapeAttr(v) : "";
}

/**
 * marked 实例：
 * - **raw HTML 一律丢掉**（不解析、不透传）；
 * - **链接只放行安全协议**（`javascript:` / `data:` 在这一层就被去掉，不靠 DOMPurify 兜）。
 */
const botMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: () => "",
    link: function (token) {
      const text = this.parser.parseInline(token.tokens ?? []);
      const href = safeHref(token.href);
      const title = token.title ? ` title="${escapeAttr(String(token.title))}"` : "";
      if (!href) return text;
      return `<a href="${href}"${title} rel="noreferrer noopener">${text}</a>`;
    },
  },
});

/**
 * 正文 → HTML（**纯逻辑**，不依赖 DOM ⇒ 可单测）。
 *
 * - `text` ⇒ **转义后**按段落输出（`&lt;b&gt;` 显示成字面量，不当标签）；
 * - `markdown` ⇒ `marked` 解析，raw HTML 被丢弃。
 */
export function botMessageToHtml(
  raw: string | null | undefined,
  format: string | null | undefined,
): string {
  const text = capBotMessageText(String(raw ?? ""));
  if (!text.trim()) return "";
  if (normalizeBotFormat(format) === "text") {
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return esc
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
  return botMarked.parse(text, { async: false });
}

/** DOMPurify 实例形状（Web 默认单例 / 测试注入 createDOMPurify(window) 都满足）。 */
type PurifyLike = { sanitize: (html: string, cfg: Record<string, unknown>) => string };

/**
 * 消毒配置（**唯一事实源**）：Web 的 `renderBotMessage` 与测试注入实例共用同一份配置，
 * 保证「测的那层」和「WebView 跑的那层」是同一套白名单，而不是两套各写一遍。
 */
export const BOT_SANITIZE_CONFIG = {
  ALLOWED_TAGS: BOT_MESSAGE_ALLOWED_TAGS,
  ALLOWED_ATTR: BOT_MESSAGE_ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  // 图片与内联样式一律不许（远程图片不自动加载 ⇒ 不给 img 也不给 style）。
  FORBID_TAGS: ["img", "style", "svg", "math", "iframe", "object", "embed"],
  FORBID_ATTR: ["style", "srcset", "formaction", "ping"],
} as const;

/**
 * 渲染成可 `v-html` 的安全片段（**DOM 环境**：在消毒之后再交给界面）。
 *
 * 生产走模块级 DOMPurify（WebView 有 window）；`purify` 参数仅供测试注入
 * `createDOMPurify(window)`（如 happy-dom）—— 这样第二层消毒**也能自动测**，
 * 而不是「Node 没 DOM ⇒ 只能靠代码审阅」（审计 7.x P2）。
 */
export function renderBotMessage(
  raw: string | null | undefined,
  format: string | null | undefined,
  purify: PurifyLike = DOMPurify,
): string {
  const html = botMessageToHtml(raw, format);
  if (!html) return "";
  return sanitizeBotHtml(html, purify);
}

/**
 * 只做第二层消毒（导出以便**独立单测**：直接喂原始 HTML 验证白名单真的生效）。
 * 生产由 `renderBotMessage` 调用；测试注入 happy-dom 的 DOMPurify 实例。
 */
export function sanitizeBotHtml(html: string, purify: PurifyLike = DOMPurify): string {
  return purify.sanitize(html, BOT_SANITIZE_CONFIG);
}
