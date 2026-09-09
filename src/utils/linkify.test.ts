import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify, displayUrl } from "./linkify.ts";

test("linkify: 无 URL 时整段是 text", () => {
  const segs = linkify("hello world");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "text");
  assert.equal(segs[0].value, "hello world");
});

test("linkify: 匹配单个 http/https URL", () => {
  assert.deepEqual(linkify("看 https://a.com"), [
    { kind: "text", value: "看 " },
    { kind: "link", value: "https://a.com", href: "https://a.com" },
  ]);
  assert.deepEqual(linkify("http://b.io/path"), [
    { kind: "link", value: "http://b.io/path", href: "http://b.io/path" },
  ]);
});

test("linkify: 剥尾随标点当文本", () => {
  // 句末 . , ; : ! ? ) ] } > 不算 URL 一部分，剥出来当普通文本。
  // 尾标点和后续文本会分成两段（功能等价，连在一起渲染视觉无差）。
  assert.deepEqual(linkify("看 https://a.com, 还有 b"), [
    { kind: "text", value: "看 " },
    { kind: "link", value: "https://a.com", href: "https://a.com" },
    { kind: "text", value: "," },
    { kind: "text", value: " 还有 b" },
  ]);
  assert.deepEqual(linkify("https://a.com."), [
    { kind: "link", value: "https://a.com", href: "https://a.com" },
    { kind: "text", value: "." },
  ]);
  assert.deepEqual(linkify("https://a.com)"), [
    { kind: "link", value: "https://a.com", href: "https://a.com" },
    { kind: "text", value: ")" },
  ]);
});

test("linkify: 多个 URL 交替穿插", () => {
  assert.deepEqual(linkify("a https://x.com b http://y.io c"), [
    { kind: "text", value: "a " },
    { kind: "link", value: "https://x.com", href: "https://x.com" },
    { kind: "text", value: " b " },
    { kind: "link", value: "http://y.io", href: "http://y.io" },
    { kind: "text", value: " c" },
  ]);
});

test("linkify: 不匹配危险 scheme 与裸域名", () => {
  // 只匹配 http(s)://，其它 scheme / 裸 www. 不动
  assert.equal(linkify("javascript:alert(1)").length, 1);
  assert.equal(linkify("javascript:alert(1)")[0].kind, "text");
  assert.equal(linkify("www.example.com 看看").length, 1);
  assert.equal(linkify("www.example.com 看看")[0].kind, "text");
});

test("linkify: URL 内部标点不切断（常见合法字符）", () => {
  const segs = linkify("https://a.com/path?q=1&x=2#hash");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, "link");
  assert.equal((segs[0] as { href: string }).href, "https://a.com/path?q=1&x=2#hash");
});

test("linkify: 空字符串 / 非字符串", () => {
  assert.deepEqual(linkify(""), []);
  assert.deepEqual(linkify(undefined as unknown as string), []);
});

test("displayUrl: 短于阈值原样返回", () => {
  assert.equal(displayUrl("https://a.com"), "https://a.com");
});

test("displayUrl: 超长 URL 中间省略号", () => {
  const long = "https://very-long-domain.example.com/very/long/path/segment/file.html";
  const out = displayUrl(long, 32);
  assert.ok(out.length <= 32, `长度 ${out.length} > 32`);
  assert.ok(out.includes("…"), "应包含省略号");
  assert.ok(out.startsWith("https://"), "保留协议头");
  assert.ok(long.endsWith(out.slice(-3).replace("…", out.slice(-1))), "保留尾部");
});
