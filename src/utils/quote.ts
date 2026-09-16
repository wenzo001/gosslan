/**
 * 引用消息的正文编码。
 *
 * 格式（构造在 `MessageComposer.send`）：首行 `「引用 {sender}：{snippet}|{msg_id}」`，
 * 其余为正文；`|{msg_id}` 可省略（老数据没有）。
 *
 * 单独成模块的理由：这份编码有**四个**消费方，各写一遍解析迟早分叉 ——
 *   1. 气泡渲染：拆出引用块 + 正文；
 *   2. 截断判定 / 高度估算（previewMetrics）：**只能算正文**，引用头是另一套排版；
 *   3. 「选择文字」全选：选择范围要把引用块一起框进去；
 *   4. 复制：要把内部的 `|msg_id` 剥掉。
 */

export const QUOTE_PREFIX = "「引用 ";

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
