/**
 * 外部分享到会话的纯逻辑判据。
 *
 * 除了行为，这里还钉两件容易漂的事：
 * 1. **长度上限只有一把尺**：前端常量必须与 `src-tauri/src/share.rs` 的 `MAX_*` 一致，
 *    否则用户在面板里改到刚好 2000 字、后端说超长（或者反过来前端先拦住合法的内容）。
 * 2. **默认正文不许把标题和原文重复两遍**：很多站点分享出来的 `text` 就等于标题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_SHARE_TEXT_CHARS,
  MAX_SHARE_TITLE_CHARS,
  MAX_SHARE_URL_CHARS,
  composeShareText,
  matchShareTarget,
  shareOriginHost,
  shareTextError,
  sortShareTargets,
} from "./share.ts";

const RUST_SRC = join(import.meta.dirname, "..", "..", "src-tauri", "src", "share.rs");

function payload(p: Partial<Parameters<typeof composeShareText>[0]>) {
  return {
    url: null,
    title: null,
    text: null,
    claimedOrigin: null,
    ...p,
  };
}

test("长度上限与后端同一把尺（读 Rust 源码现算，不抄第二份）", () => {
  const rust = readFileSync(RUST_SRC, "utf8");
  const of = (name: string): number => {
    const hit = rust.match(new RegExp(`pub const ${name}: usize = ([0-9_]+);`));
    assert.ok(hit, `Rust 里找不到 ${name} —— 常量改名了要同步这条判据`);
    return Number(hit[1].replaceAll("_", ""));
  };
  assert.equal(MAX_SHARE_TEXT_CHARS, of("MAX_TEXT_CHARS"), "正文上限两边不一致");
  assert.equal(MAX_SHARE_TITLE_CHARS, of("MAX_TITLE_CHARS"), "标题上限两边不一致");
  assert.equal(MAX_SHARE_URL_CHARS, of("MAX_URL_CHARS"), "URL 上限两边不一致");
  // 正控：解析器真的能分辨不同的值（否则上面三条恒真）
  assert.notEqual(MAX_SHARE_TEXT_CHARS, of("MAX_TITLE_CHARS"), "正控：正文与标题上限不可能是同一个数");
});

test("默认正文：原文优先，标题次之，链接垫底", () => {
  assert.equal(
    composeShareText(payload({ text: "这段话", title: "标题", url: "https://a.example.com" })),
    "这段话\n标题\nhttps://a.example.com",
  );
  assert.equal(
    composeShareText(payload({ title: "只有标题" })),
    "只有标题",
  );
  assert.equal(
    composeShareText(payload({ url: "https://a.example.com" })),
    "https://a.example.com",
  );
});

test("原文与标题相同不重复两遍（很多站点分享出来的 text 就是标题）", () => {
  assert.equal(
    composeShareText(payload({ text: "同一个标题", title: "同一个标题", url: "https://a.example.com" })),
    "同一个标题\nhttps://a.example.com",
  );
});

test("空白内容不产生空行（trim 后为空的字段等于没给）", () => {
  assert.equal(composeShareText(payload({ text: "   ", title: "有内容" })), "有内容");
  assert.equal(composeShareText(payload({})), "");
});

test("来源只展示主机名：够判断，且不会被构造的长 URL 骗", () => {
  assert.equal(shareOriginHost(payload({ claimedOrigin: "https://news.example.com" })), "news.example.com");
  assert.equal(
    shareOriginHost(payload({ claimedOrigin: "https://news.example.com:8443" })),
    "news.example.com:8443",
  );
  assert.equal(shareOriginHost(payload({ claimedOrigin: null })), null);
  assert.equal(shareOriginHost(payload({ claimedOrigin: "不是网址" })), null);
});

test("面板闸：空内容与超长分别给不同的原因（不能都叫「发不出去」）", () => {
  assert.equal(shareTextError(""), "empty");
  assert.equal(shareTextError("   \n "), "empty");
  assert.equal(shareTextError("正常内容"), null);
  assert.equal(shareTextError("字".repeat(MAX_SHARE_TEXT_CHARS)), null, "恰好到上限要放行");
  assert.equal(shareTextError("字".repeat(MAX_SHARE_TEXT_CHARS + 1)), "tooLong");
});

test("会话检索：大小写不敏感、空查询不筛、不匹配返回 false", () => {
  assert.equal(matchShareTarget({ name: "Product Team" }, "product"), true);
  assert.equal(matchShareTarget({ name: "产品组" }, "产品"), true);
  assert.equal(matchShareTarget({ name: "产品组" }, "运营"), false);
  assert.equal(matchShareTarget({ name: "产品组" }, "   "), true);
});

test("分享目标排序：置顶优先，其次最近活跃，没说过话的排最后", () => {
  const sorted = sortShareTargets([
    { name: "沉默", pinned: false, last_ts: null },
    { name: "昨天", pinned: false, last_ts: 100 },
    { name: "置顶旧", pinned: true, last_ts: 1 },
    { name: "刚刚", pinned: false, last_ts: 900 },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.name),
    ["置顶旧", "刚刚", "昨天", "沉默"],
  );
});

test("排序是纯函数：不改原数组（面板每帧都可能重算，不能把 store 里的顺序搅乱）", () => {
  const input = [
    { name: "b", pinned: false, last_ts: 1 },
    { name: "a", pinned: false, last_ts: 2 },
  ];
  const out = sortShareTargets(input);
  assert.deepEqual(input.map((c) => c.name), ["b", "a"], "原数组顺序必须原样");
  assert.deepEqual(out.map((c) => c.name), ["a", "b"]);
});
