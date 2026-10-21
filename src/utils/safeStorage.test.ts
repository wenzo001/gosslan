import assert from "node:assert/strict";
import { test } from "node:test";

import { createSafeStorage, storageGet, storageRemove, storageSet } from "./safeStorage.ts";

/**
 * `createSafeStorage` / `storageGet|Set|Remove` 的行为真值表 —— 专门在"存储会抛"的世界里跑。
 *
 * 为什么这一本必须自己造会抛的后端：真实缺陷（Safari 隐私模式 SecurityError、
 * 配额写满 QuotaExceededError）在本机浏览器里造不出来，而它一旦漏兜就是
 * store 创建期崩 / 点一下切换外观整条中断 —— 屏幕上表现为"应用起不来"那种量级。
 *
 * ⚠️ 不靠改写全局来造"没有存储"的世界：这台 Node 自带一个删不掉的 `localStorage`
 * （第一版就是那样写的，结果两条用例读到的都是真存储，`set` 返回 true 而断言要 false ——
 * 假绿形状）。所以"没有存储/访问就抛"这一格由 `createSafeStorage(null)` 与显式后端来判，
 * 全局那三个包装只判"它确实把活交给了后端"这一件事。
 */

function throwing(): never {
  throw new Error("SecurityError: localStorage is not available");
}

test("正常后端：读写删逐条透传，并回报成败", () => {
  const store = new Map<string, string>([["k", "v"]]);
  const s = createSafeStorage({
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
  });
  assert.equal(s.get("k"), "v");
  assert.equal(s.get("没这个键"), null);
  assert.equal(s.set("a", "1"), true);
  assert.equal(store.get("a"), "1");
  assert.equal(s.remove("a"), true);
  assert.equal(store.has("a"), false);
});

test("getItem 抛（SecurityError）⇒ get 当「没这个键」，不 rethrow", () => {
  const s = createSafeStorage({ getItem: throwing, setItem: () => {}, removeItem: () => {} });
  assert.equal(s.get("gosslan.themeColor"), null);
});

test("setItem 抛（配额写满）⇒ set 返回 false，不 rethrow", () => {
  const s = createSafeStorage({
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => {},
  });
  assert.equal(s.set("gosslan.chatStyle", "{}"), false);
});

test("removeItem 抛 ⇒ remove 返回 false，不 rethrow", () => {
  const s = createSafeStorage({ getItem: () => null, setItem: () => {}, removeItem: throwing });
  assert.equal(s.remove("gosslan.dark"), false);
});

test("后端为 null（SSR / 老 WebView / 属性本身不可访问）⇒ 三个出口全安全且不抛", () => {
  const s = createSafeStorage(null);
  assert.equal(s.get("k"), null);
  assert.equal(s.set("k", "v"), false);
  assert.equal(s.remove("k"), false);
});

test("★连「访问 localStorage 这个属性」都会抛 ⇒ 三个包装出口全安全（access 那一步也得进 try）", () => {
  // 覆盖与还原**都写在这条用例自己身上**：前一版用 helper 装假后端、在 finally 里还原，
  // 而 finally 早于用例体执行 ⇒ 用例读到的是这台 Node 的原生存储，`set` 返回 true 而断言要 false
  // —— 典型的"量具没生效而读数照绿"。另外 `delete globalThis.localStorage` 只摘掉自己的影子，
  // 原型上那份原生存储会立刻回来，所以"没有存储"这种世界也不能靠 delete 来造。
  const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: throwing });
  try {
    assert.equal(storageGet("gosslan.themeColor"), null);
    assert.equal(storageSet("gosslan.themeColor", "#000"), false);
    assert.equal(storageRemove("gosslan.themeColor"), false);
  } finally {
    delete globalThis.localStorage;
    if (own) Object.defineProperty(globalThis, "localStorage", own);
  }
});

test("环境里 localStorage 是 undefined ⇒ 三个包装出口同样安全", () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => undefined });
  try {
    assert.equal(storageGet("k"), null);
    assert.equal(storageSet("k", "v"), false);
    assert.equal(storageRemove("k"), false);
  } finally {
    delete globalThis.localStorage;
    if (own) Object.defineProperty(globalThis, "localStorage", own);
  }
});
