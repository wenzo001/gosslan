import { test } from "node:test";
import assert from "node:assert/strict";
import { zhCN, enUS } from "./locales.ts";
import { applyLocale, currentLocale, isLocale, t } from "./index.ts";

// ---------------- 字典护栏：中英 key 必须一一对应（漏翻译会被逮到） ----------------

test("zh-CN 与 en-US 的 key 集合完全一致（防漏翻译）", () => {
  const zh = Object.keys(zhCN).sort();
  const en = Object.keys(enUS).sort();
  const onlyZh = zh.filter((k) => !enUS[k]);
  const onlyEn = en.filter((k) => !zhCN[k]);
  assert.deepEqual(onlyZh, [], `仅中文有、英文缺失的 key：${onlyZh.join(", ")}`);
  assert.deepEqual(onlyEn, [], `仅英文有、中文缺失的 key：${onlyEn.join(", ")}`);
});

test("字典值非空（不允许空字符串占位）", () => {
  for (const [k, v] of Object.entries(zhCN)) assert.ok(v.length > 0, `zh-CN ${k} 为空`);
  for (const [k, v] of Object.entries(enUS)) assert.ok(v.length > 0, `en-US ${k} 为空`);
});

// ---------------- t() 翻译与插值 ----------------

test("默认中文翻译", () => {
  applyLocale("zh-CN");
  assert.equal(t("nav.chats"), "聊天");
  assert.equal(t("settings.title"), "设置");
});

test("切换英文后立即生效", () => {
  applyLocale("en-US");
  assert.equal(t("nav.chats"), "Chats");
  assert.equal(t("settings.title"), "Settings");
  applyLocale("zh-CN"); // 还原，避免影响后续用例
});

test("插值：{n} 等占位符被替换", () => {
  applyLocale("zh-CN");
  assert.equal(t("nav.chats.unread", { n: 3 }), "聊天，3 条未读");
  applyLocale("en-US");
  assert.equal(t("nav.chats.unread", { n: 3 }), "Chats, 3 unread");
  applyLocale("zh-CN");
});

test("缺 key 回退为 key 本身（不抛错、不显示 undefined）", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});

test("插值参数缺失时占位符保留原文", () => {
  applyLocale("zh-CN");
  assert.equal(t("nav.chats.unread"), "聊天，{n} 条未读");
});

// ---------------- locale 校验 ----------------

test("isLocale 只认两种合法语言", () => {
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("en-US"), true);
  for (const v of ["", "en", "中文", "zh", null, undefined, 1]) {
    assert.equal(isLocale(v), false, `${String(v)} 不应判为合法语言`);
  }
});

test("currentLocale 反映最近一次 applyLocale", () => {
  applyLocale("en-US");
  assert.equal(currentLocale(), "en-US");
  applyLocale("zh-CN");
  assert.equal(currentLocale(), "zh-CN");
});
