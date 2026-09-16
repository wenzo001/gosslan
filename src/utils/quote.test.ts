import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuote, quoteBody, stripQuoteMsgId } from "./quote.ts";

/** 与 MessageComposer.send 的拼法一致：首行 `「引用 发送者：片段[|msg_id]」\n正文`。 */
const build = (sender: string, snippet: string, body: string, msgId?: string) =>
  `「引用 ${sender}：${snippet}${msgId ? `|${msgId}` : ""}」\n${body}`;

test("parseQuote: 非引用消息原样当正文", () => {
  assert.deepEqual(parseQuote("普通消息"), { header: "", body: "普通消息", msgId: "" });
  assert.deepEqual(parseQuote(""), { header: "", body: "", msgId: "" });
});

test("parseQuote: 拆出引用头 / 正文 / msg_id", () => {
  assert.deepEqual(parseQuote(build("张三", "晚上开会", "好的", "m_1")), {
    header: "「引用 张三：晚上开会」",
    body: "好的",
    msgId: "m_1",
  });
  // 老数据没有 msg_id
  assert.deepEqual(parseQuote(build("张三", "晚上开会", "好的")), {
    header: "「引用 张三：晚上开会」",
    body: "好的",
    msgId: "",
  });
});

test("parseQuote: 正文里的换行与「引用」字样不会被误当引用头", () => {
  const content = build("张三", "片段", "第一行\n「引用 李四：别的」\n第三行", "m_2");
  const parsed = parseQuote(content);
  assert.equal(parsed.header, "「引用 张三：片段」");
  assert.equal(parsed.body, "第一行\n「引用 李四：别的」\n第三行", "只有首行参与解析");
});

test("parseQuote: 首行不以 」收尾 / 没有换行 ⇒ 不算引用", () => {
  // 光有前缀但首行没闭合（用户手打的半截文本）
  assert.equal(parseQuote("「引用 张三：片段\n正文").header, "");
  // 只有一行、没有正文：当成普通消息（引用必须带正文）
  assert.equal(parseQuote("「引用 张三：片段」").header, "");
  assert.equal(parseQuote("「引用 张三：片段」").body, "「引用 张三：片段」");
});

test("quoteBody: 只返回正文 —— 截断判定与高度估算都必须只算它", () => {
  // 用户 2026-09-16：正文正好 5 行 + 引用头 1 行时，旧实现把引用头也算进行数，
  // 于是一条并不长的引用消息凭空多出「展开」操作条，点开和气泡里一模一样。
  const body = Array.from({ length: 5 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const content = build("张三", "片段", body, "m_3");
  assert.equal(quoteBody(content), body);
  assert.equal(quoteBody(content).split("\n").length, 5, "正文行数不含引用头");
  assert.equal(quoteBody("普通消息"), "普通消息");
});

test("stripQuoteMsgId: 复制时剥掉内部 msg_id，其余原样", () => {
  // 用户看到的是「引用 张三：片段」，复制出来却是 `…片段|m_9」`。
  assert.equal(
    stripQuoteMsgId(build("张三", "片段", "回复", "m_9")),
    build("张三", "片段", "回复"),
  );
  // 没有 msg_id / 不是引用消息 ⇒ 一个字符都不动
  const noId = build("张三", "片段", "回复");
  assert.equal(stripQuoteMsgId(noId), noId);
  assert.equal(stripQuoteMsgId("普通消息"), "普通消息");
  assert.equal(stripQuoteMsgId(""), "");
});

test("stripQuoteMsgId: 不碰正文里长得像 id 的内容", () => {
  const content = build("张三", "片段", "正文里也有|竖线", "m_10");
  assert.equal(stripQuoteMsgId(content), build("张三", "片段", "正文里也有|竖线"));
});
