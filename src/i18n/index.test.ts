import { test } from "node:test";
import assert from "node:assert/strict";
import { zhCN, enUS } from "./locales.ts";
import {
  applyPreference,
  currentLocale,
  currentPreference,
  detectSystemLocale,
  isLanguagePreference,
  isLocale,
  refreshSystemLocale,
  t,
} from "./index.ts";

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

// ---------------- 系统语言检测（纯函数） ----------------

test("detectSystemLocale：zh* → 中文，en* → 英文，非中英 → 英文", () => {
  assert.equal(detectSystemLocale(["zh-CN"]), "zh-CN");
  assert.equal(detectSystemLocale(["zh-Hans-CN"]), "zh-CN");
  assert.equal(detectSystemLocale(["zh-TW"]), "zh-CN");
  assert.equal(detectSystemLocale(["en-US"]), "en-US");
  assert.equal(detectSystemLocale(["en-GB", "zh-CN"]), "en-US"); // 第一个命中 en
  assert.equal(detectSystemLocale(["ja-JP", "en-US"]), "en-US");
  assert.equal(detectSystemLocale(["ja-JP"]), "en-US"); // 非中英回落英文
  assert.equal(detectSystemLocale(["zh-CN", "en-US"]), "zh-CN"); // 第一个命中 zh
  assert.equal(detectSystemLocale([]), "en-US");
  assert.equal(detectSystemLocale([undefined, null, "zh-CN"]), "zh-CN");
});

// ---------------- t() 翻译与插值 ----------------

test("默认跟随系统（node 环境无 navigator → 英文）", () => {
  applyPreference("system");
  assert.equal(currentPreference(), "system");
  assert.equal(t("nav.chats"), "Chats");
});

test("显式中文翻译", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats"), "聊天");
  assert.equal(t("settings.title"), "设置");
});

test("切换英文后立即生效", () => {
  applyPreference("en-US");
  assert.equal(t("nav.chats"), "Chats");
  assert.equal(t("settings.title"), "Settings");
});

test("插值：{n} 等占位符被替换", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats.unread", { n: 3 }), "聊天，3 条未读");
  applyPreference("en-US");
  assert.equal(t("nav.chats.unread", { n: 3 }), "Chats, 3 unread");
});

test("缺 key 回退为 key 本身（不抛错、不显示 undefined）", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});

test("插值参数缺失时占位符保留原文", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats.unread"), "聊天，{n} 条未读");
});

// ---------------- 跟随系统：refreshSystemLocale 重解析 ----------------

function withNavigator(langs: string[], fn: () => void) {
  const saved = (globalThis as Record<string, unknown>).navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { languages: langs, language: langs[0] },
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    if (saved === undefined) delete (globalThis as Record<string, unknown>).navigator;
    else Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true, writable: true });
  }
}

test("跟随系统：系统语言变化后重解析生效", () => {
  applyPreference("system");
  withNavigator(["zh-CN"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "zh-CN");
    assert.equal(t("nav.chats"), "聊天");
  });
  withNavigator(["en-US"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "en-US");
    assert.equal(t("nav.chats"), "Chats");
  });
  applyPreference("zh-CN"); // 还原
});

test("显式偏好不受系统语言变化影响", () => {
  applyPreference("zh-CN");
  withNavigator(["en-US"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "zh-CN");
  });
  applyPreference("zh-CN");
});

// ---------------- 校验 ----------------

test("isLocale 只认两种合法语言", () => {
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("en-US"), true);
  for (const v of ["", "en", "中文", "zh", null, undefined, 1]) {
    assert.equal(isLocale(v), false, `${String(v)} 不应判为合法语言`);
  }
});

test("isLanguagePreference 认三态", () => {
  for (const v of ["system", "zh-CN", "en-US"]) {
    assert.equal(isLanguagePreference(v), true, `${v} 应为合法偏好`);
  }
  for (const v of ["", "auto", "en", null, undefined, 1]) {
    assert.equal(isLanguagePreference(v), false, `${String(v)} 不应判为合法偏好`);
  }
});

test("currentPreference / currentLocale 反映最近一次 applyPreference", () => {
  applyPreference("en-US");
  assert.equal(currentPreference(), "en-US");
  assert.equal(currentLocale(), "en-US");
  applyPreference("zh-CN");
  assert.equal(currentLocale(), "zh-CN");
});
