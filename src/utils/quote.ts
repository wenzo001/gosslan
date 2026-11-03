/**
 * 引用消息的正文编码。
 *
 * 格式（构造在 `MessageComposer.send`）：首行 `「引用 {sender}：{snippet}|{msg_id}」`，
 * 其余为正文；`|{msg_id}` 可省略（老数据没有）。
 *
 * ⚠️ **首行的中文标记是「线上格式」，不是界面文案**：老版本接收端只认 `「引用 ` 这个前缀，
 * 按界面语言写会让对方解析不出引用块。所以构造只在这一处、永远写中文；**显示**再按当前
 * 语言换词（`localizeQuoteHeader`）。
 *
 * 单独成模块的理由：这份编码有**四个**消费方，各写一遍解析迟早分叉 ——
 *   1. 气泡渲染：拆出引用块 + 正文；
 *   2. 截断判定 / 高度估算（previewMetrics）：**只能算正文**，引用头是另一套排版；
 *   3. 「选择文字」全选：选择范围要把引用块一起框进去；
 *   4. 复制：要把内部的 `|msg_id` 剥掉。
 */
import { t } from "../i18n/index.ts";

export const QUOTE_PREFIX = "「引用 ";
export const QUOTE_SUFFIX = "」";

/**
 * 引用头（不含正文）的唯一构造点 —— 发送侧不许再自己拼一次。
 *
 * 为什么必须收成一处：`MessageComposer` 以前自己写死了 `「引用 ${sender}：${snippet}」`，
 * 与这里的前缀常量成了两套来源；改一边（换词/加 msg_id）另一边就悄悄解析失败。
 */
export function buildQuoteHeader(
  sender: string,
  snippet: string,
  msgId?: string | number | null,
): string {
  const id = msgId == null || msgId === "" ? "" : `|${msgId}`;
  return `${QUOTE_PREFIX}${sender}：${snippet}${id}${QUOTE_SUFFIX}`;
}

/**
 * 把首行 `「引用 …」` 里的**词**换成当前语言，正文原样；顺带剥掉内部的 `|msg_id`
 * （它是数据库内部 id，只给“点引用跳回原消息”用，不该出现在文字里 —— 复制路径同此口径）。
 *
 * 只用于**显示**（气泡引用块 / 会话列表摘要 / 搜索结果）：库里与协议里的字节不变，
 * 所以老版本、老数据都还能按 `「引用 ` 解析。
 */
export function localizeQuoteHeader(content: string): string {
  if (!content.startsWith(QUOTE_PREFIX)) return content;
  // 先剥 msg_id，再按首行换词：两步都只碰首行，正文一字不动。
  const cleaned = stripQuoteMsgId(content);
  const nl = cleaned.indexOf("\n");
  const firstLine = nl < 0 ? cleaned : cleaned.slice(0, nl);
  if (!firstLine.trimEnd().endsWith(QUOTE_SUFFIX)) return content;
  const localized = `「${t("common.quote")} ${firstLine.slice(QUOTE_PREFIX.length)}`;
  return nl < 0 ? localized : localized + cleaned.slice(nl);
}

export interface ParsedQuote {
  /** 引用块整行（含「引用 …」，**已去掉** msg_id 后缀）；非引用消息为空串。 */
  header: string;
  /** 正文；非引用消息即原文。 */
  body: string;
  /** 被引用消息 id；老数据可能为空串。 */
  msgId: string;
}

/**
 * 拆引用消息；非引用消息返回 `{ header: "", body: content, msgId: "" }`。
 * 判定沿用历史口径：首行以 `「引用 ` 开头、且去掉尾部空白后以 `」` 收尾。
 */
export function parseQuote(content: string): ParsedQuote {
  const plain: ParsedQuote = { header: "", body: content, msgId: "" };
  if (!content.startsWith(QUOTE_PREFIX)) return plain;
  const nl = content.indexOf("\n");
  if (nl < 0 || !content.slice(0, nl).trimEnd().endsWith("」")) return plain;
  let line = content.slice(0, nl).trimEnd();
  let msgId = "";
  const m = line.match(/\|([^\s|」]+)」$/);
  if (m && m.index !== undefined) {
    msgId = m[1];
    line = line.slice(0, m.index) + "」";
  }
  return { header: line, body: content.slice(nl + 1), msgId };
}

/**
 * 正文部分（非引用消息即原文）。
 * 截断判定与高度估算都必须只算它：引用头是 12px 的块级排版、不参与 clamp，
 * 把它当成一行正文会让「正文正好 5 行」的消息凭空多出一条「展开」操作条。
 */
export function quoteBody(content: string): string {
  return parseQuote(content).body;
}

/**
 * 复制用的文本：引用头里的 `|msg_id` 是内部路由信息，不该出现在用户复制出来的内容里。
 * ⚠️ 只在**复制**路径上剥 —— 转发要原样保留，接收方靠它跳到被引用的那条消息。
 */
export function stripQuoteMsgId(content: string): string {
  const { header, body, msgId } = parseQuote(content);
  if (!msgId) return content;
  return `${header}\n${body}`;
}
