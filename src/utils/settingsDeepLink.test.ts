/**
 * 跨端设置深链矩阵：桌面键 ↔ 移动键的兼容映射。
 *
 * 背景：两端分区集合本来就不等价（桌面有复数 `notifications`，移动端有单数
 * `notification` 与 `chatStyle`），外部深链/恢复态落到另一端时曾经直接停在一级列表
 * 或空页。这里锁住三件事：
 *  1. 差异清单是已知的（新增/删除分区必须同步更新兼容表）；
 *  2. 每个别名与「仅一端存在」的键，在 mobile / desktop 两种上下文都落到真实分区；
 *  3. 未知键统一回落默认分区，并且两个外壳都给出可理解提示（不静默白屏）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DESKTOP_ROUTE,
  DEFAULT_MOBILE_SECTION,
  DESKTOP_ONLY_SECTIONS,
  MOBILE_ALIASES,
  MOBILE_ONLY_SECTIONS,
  MOBILE_SECTIONS,
  ROUTE_SECTIONS,
  desktopContainerForRoute,
  resolveDesktopRouteKey,
  resolveMobileSectionKey,
} from "./settingsManifest.ts";

const srcDir = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(srcDir, rel), "utf8");

const MOBILE_KEYS = MOBILE_SECTIONS.map((s) => s.key) as string[];
const ROUTE_KEYS = [...ROUTE_SECTIONS] as string[];
const DESKTOP_CONTAINERS = ["general", "network", "storageFiles", "about"] as const;

test("两端分区差异清单：共有 / 仅桌面 / 仅移动逐项固定", () => {
  const common = ROUTE_KEYS.filter((key) => MOBILE_KEYS.includes(key));
  const desktopOnly = ROUTE_KEYS.filter((key) => !MOBILE_KEYS.includes(key));
  const mobileOnly = MOBILE_KEYS.filter((key) => !ROUTE_KEYS.includes(key));

  assert.deepEqual(common, ["profile", "general", "appearance", "network", "storageFiles", "about", "reset"]);
  // files / storage / security 是桌面仍在用的旧路由键，移动端用别名接住（不是死键）。
  assert.deepEqual(desktopOnly, ["notifications", "files", "storage", "security"]);
  assert.deepEqual(mobileOnly, ["chatStyle", "notification"]);
});

test("双向兼容表：桌面键 ↔ 移动键在两个上下文都落到预期分区", () => {
  // 桌面 → 移动：复数 notifications 在移动端只有单数分区。
  for (const [desktopKey, mobileKey] of Object.entries(DESKTOP_ONLY_SECTIONS)) {
    const res = resolveMobileSectionKey(desktopKey);
    assert.equal(res.key, mobileKey, `桌面键 ${desktopKey} 没有落到移动端 ${mobileKey}`);
    assert.equal(res.aliased, true, `桌面键 ${desktopKey} 应该走跨端兼容表`);
    assert.equal(res.fallback, false, `桌面键 ${desktopKey} 不应该回落到默认分区`);
  }

  // 移动 → 桌面：单数 notification 归一到桌面复数路由；chatStyle 落到内容所在的 general。
  for (const [mobileKey, desktopRoute] of Object.entries(MOBILE_ONLY_SECTIONS)) {
    const res = resolveDesktopRouteKey(mobileKey);
    assert.equal(res.key, desktopRoute, `移动键 ${mobileKey} 没有落到桌面 ${desktopRoute}`);
    assert.equal(res.aliased, true, `移动键 ${mobileKey} 应该走跨端兼容表`);
    assert.equal(res.fallback, false, `移动键 ${mobileKey} 不应该回落到默认分区`);
  }

  // 反向也成立：桌面 `notifications` 与移动 `notification` 在本端仍是直接命中。
  assert.equal(resolveDesktopRouteKey("notifications").key, "notifications");
  assert.equal(resolveMobileSectionKey("notification").key, "notification");
});

test("历史别名：旧 mobile 键与 desktop 路由键都不会落空", () => {
  for (const [legacy, target] of Object.entries(MOBILE_ALIASES)) {
    // mobile：走别名归一。
    const mobile = resolveMobileSectionKey(legacy);
    assert.equal(mobile.key, target, `旧键 ${legacy} 没有在移动端落到 ${target}`);
    assert.equal(mobile.aliased, true, `旧键 ${legacy} 没有走移动端别名`);
    assert.equal(mobile.fallback, false, `旧键 ${legacy} 不应该回落到默认分区`);

    // desktop：三条旧键本身就是合法路由，且容器与移动端落点一致。
    const desktop = resolveDesktopRouteKey(legacy);
    assert.equal(desktop.fallback, false, `旧键 ${legacy} 在桌面端落空了`);
    assert.equal(
      desktopContainerForRoute(desktop.key),
      desktopContainerForRoute(target),
      `旧键 ${legacy} 在桌面端与移动端打开了不同区域`,
    );
  }
});

test("逐个分区矩阵：desktop 与 mobile 两种上下文都返回真实分区，不返回 null", () => {
  for (const key of ROUTE_KEYS) {
    const desktop = resolveDesktopRouteKey(key);
    assert.ok(ROUTE_KEYS.includes(desktop.key), `desktop 上下文：${key} → ${desktop.key} 不存在`);
    assert.equal(desktop.fallback, false, `desktop 上下文：合法路由键 ${key} 不应回落`);
    assert.ok(
      (DESKTOP_CONTAINERS as readonly string[]).includes(desktopContainerForRoute(desktop.key)),
      `desktop 上下文：${key} 没有对应的渲染容器`,
    );

    const mobile = resolveMobileSectionKey(key);
    assert.ok(MOBILE_KEYS.includes(mobile.key), `mobile 上下文：${key} → ${mobile.key} 不存在`);
    assert.equal(mobile.fallback, false, `mobile 上下文：桌面键 ${key} 应该有别名接住`);
  }

  for (const key of MOBILE_KEYS) {
    const mobile = resolveMobileSectionKey(key);
    assert.equal(mobile.key, key, `mobile 上下文：${key} 没有落到自己`);
    assert.equal(mobile.known, true, `mobile 上下文：${key} 不是直接命中`);
    assert.equal(mobile.fallback, false, `mobile 上下文：${key} 不应回落`);

    const desktop = resolveDesktopRouteKey(key);
    assert.ok(ROUTE_KEYS.includes(desktop.key), `desktop 上下文：${key} → ${desktop.key} 不存在`);
    assert.equal(desktop.fallback, false, `desktop 上下文：移动键 ${key} 应该有兼容落点`);
  }
});

test("未知/不存在分区：两端都回落到同一个明确的默认分区，并标记需要提示", () => {
  for (const raw of ["ghost", "", "/me/settings/ghost", "notificationss", "chat-style"]) {
    const mobile = resolveMobileSectionKey(raw);
    assert.equal(mobile.key, DEFAULT_MOBILE_SECTION, `mobile 未知键 ${JSON.stringify(raw)} 没回落`);
    assert.equal(mobile.fallback, true, `mobile 未知键 ${JSON.stringify(raw)} 没标记回落`);
    assert.equal(mobile.aliased, false, `mobile 未知键 ${JSON.stringify(raw)} 不应伪装成别名`);

    const desktop = resolveDesktopRouteKey(raw);
    assert.equal(desktop.key, DEFAULT_DESKTOP_ROUTE, `desktop 未知键 ${JSON.stringify(raw)} 没回落`);
    assert.equal(desktop.fallback, true, `desktop 未知键 ${JSON.stringify(raw)} 没标记回落`);
    assert.equal(desktop.aliased, false, `desktop 未知键 ${JSON.stringify(raw)} 不应伪装成别名`);
  }
  assert.equal(desktopContainerForRoute(DEFAULT_DESKTOP_ROUTE), "general");
});

test("两个外壳消费解析器、渲染全部落点并给出提示（不白屏、不静默）", () => {
  const panel = read("components/SettingsPanel.vue");
  const win = read("components/SettingsWindow.vue");

  assert.ok(panel.includes("resolveMobileSectionKey"), "SettingsPanel 没消费跨端解析器");
  assert.ok(win.includes("resolveDesktopRouteKey"), "SettingsWindow 没消费跨端解析器");
  assert.ok(panel.includes("settings.toast.sectionFallback"), "SettingsPanel 回落后没有提示");
  assert.ok(win.includes("settings.toast.sectionFallback"), "SettingsWindow 回落后没有提示");

  // 每个可解析的移动端分区都必须有渲染分支，否则解析到它也只是一张空页。
  for (const key of MOBILE_KEYS) {
    assert.ok(
      panel.includes(`mobileNav === '${key}'`) || panel.includes(`mobileNav === "${key}"`),
      `SettingsPanel 缺 ${key} 的渲染分支`,
    );
  }
  // 桌面 4 容器同理。
  for (const container of DESKTOP_CONTAINERS) {
    assert.ok(
      win.includes(`desktopSection === '${container}'`) || win.includes(`desktopSection === "${container}"`),
      `SettingsWindow 缺 ${container} 的渲染分支`,
    );
  }

  // 提示文案双语齐全，且占位符一致（否则某一端会看到 key 原文或空串）。
  for (const file of ["zh-cn.ts", "en-us.ts"]) {
    const dict = read(`i18n/locales/${file}`);
    assert.ok(dict.includes('"settings.toast.sectionFallback"'), `${file} 缺回落提示文案`);
    assert.match(
      dict,
      /"settings\.toast\.sectionFallback":\s*"[^"]*\{section\}/,
      `${file} 的回落提示没有 {section} 占位符`,
    );
  }
});
