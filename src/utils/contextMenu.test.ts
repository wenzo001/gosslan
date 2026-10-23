import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldPreventContextMenu } from "./contextMenu.ts";

test("shouldPreventContextMenu：桌面一律拦；触屏正文/选字/有选区让位系统", () => {
  const cases = [
    // 用户 2026-10-23：桌面只要之前选过任何文字，右键气泡就会弹 WebKit 原生菜单 ⇒ 桌面一律拦。
    { isMobile: false, textSelecting: false, hasSelection: true, onSelectableText: false, expected: true },
    { isMobile: false, textSelecting: true, hasSelection: true, onSelectableText: true, expected: true },
    { isMobile: false, textSelecting: false, hasSelection: false, onSelectableText: true, expected: true },
    { isMobile: false, textSelecting: true, hasSelection: false, onSelectableText: false, expected: true },
    // 触屏：正文落点 / 选字模式 / 已有选区 ⇒ 系统原生选字与复制工具条优先。
    { isMobile: true, textSelecting: true, hasSelection: true, onSelectableText: true, expected: false },
    { isMobile: true, textSelecting: true, hasSelection: false, onSelectableText: false, expected: false },
    { isMobile: true, textSelecting: false, hasSelection: true, onSelectableText: false, expected: false },
    { isMobile: true, textSelecting: false, hasSelection: false, onSelectableText: true, expected: false },
    // 触屏非正文、无选区 ⇒ 拦默认菜单（自定义面板由长按定时器负责）。
    { isMobile: true, textSelecting: false, hasSelection: false, onSelectableText: false, expected: true },
  ];
  for (const c of cases) {
    assert.equal(shouldPreventContextMenu(c), c.expected, JSON.stringify(c));
  }
});

test("MessageItem 右键边界 = 消息内容列；桌面带选区快照，触屏让位系统选字", () => {
  const item = readFileSync(
    join(import.meta.dirname, "..", "components", "MessageItem.vue"),
    "utf8",
  );
  const menu = readFileSync(
    join(import.meta.dirname, "..", "components", "message", "MessageContextMenu.vue"),
    "utf8",
  );
  const app = readFileSync(join(import.meta.dirname, "..", "App.vue"), "utf8");

  // ① 边界：处理器挂在 `[data-msg-col]`（昵称/引用块/正文），不再挂在整条消息根上。
  //    头像、表情回应条、行内空白在列外 ⇒ 不会因为"同属一条消息"就弹菜单。
  assert.match(item, /data-msg-col[\s\S]{0,700}?@contextmenu="onContextMenu"/,
    "contextmenu 处理器没有挂在 data-msg-col（消息内容列）上");
  assert.doesNotMatch(item, /class="group\/msg"[^>]*@contextmenu=/,
    "处理器仍然挂在整条消息根上 —— 头像/表情条/空白会误触发");
  // 表情回应的笑脸按钮在列内（绝对定位），必须显式排除。
  assert.match(item, /closest\("\[data-reaction-entry\]"\)/,
    "没有排除表情回应入口 ⇒ 右键笑脸会弹消息菜单");
  assert.doesNotMatch(item, /@contextmenu\.prevent=/, "不许再有无条件 prevent");
  assert.match(item, /shouldPreventContextMenu\(/, "必须调用共享判据");
  assert.match(item, /onSelectableText/, "必须把「落点是否可选正文」传给闸门");
  // 触屏放行时要 stopPropagation：App.vue 的全局兜底在"选区还没建立"那帧会再 prevent 一次。
  assert.match(item, /if \(mobile\) e\.stopPropagation\(\);/,
    "触屏正文放行 path 没有 stopPropagation（会被 App 全局兜底吃掉）");
  // 闸门说拦 ⇒ 先 preventDefault 再开自定义菜单；移动端只拦不弹（面板归长按）。
  assert.match(item, /e\.preventDefault\(\);[\s\S]{0,220}?openContextMenu\(e,/,
    "onContextMenu 没有「先 preventDefault 再开菜单」");
  assert.match(item, /if \(mobile\) return;[\s\S]{0,80}?openContextMenu\(e,/,
    "移动端非正文区没有在 prevent 后提前 return（会误弹桌面菜单）");

  // ② 桌面选中复制：右键时抓选区快照，菜单里只复制它；不再在点击时读 live 选区。
  assert.match(item, /selectionTextWithin\(col\)/, "没有抓取消息内容列内的选区文本");
  assert.match(item, /selectedText: string/, "ctxMenu 没有保存选区文本快照");
  assert.match(item, /ctxMenu\.selectedText/, "菜单没有接上选区快照");
  assert.match(item, /@copy-selection="copySelectionFromMenu"/, "没有接「复制选中内容」动作");
  assert.match(item, /function copySelectionFromMenu\(\)[\s\S]{0,260}?copyTextWithToast\("selection"/,
    "复制选中内容没有走统一 toast 反馈");
  assert.match(menu, /selectedText\?: string/, "MessageContextMenu 没有 selectedText prop");
  assert.match(menu, /emit\('copy-selection'\)/, "MessageContextMenu 没有 copy-selection 事件");
  assert.match(menu, /t\("msg\.copySelection"\)/, "菜单没有「复制选中内容」文案");
  assert.match(menu, /t\("msg\.copyMessage"\)/, "整条复制没有与「复制选中内容」区分文案");

  // ③ 移动端原生选字：App.vue 的全局兜底也必须放行可选正文（否则选区建立前会被吃掉）。
  assert.match(app, /isSelectableTextTarget\(e\.target\)/, "App.vue 全局 contextmenu 没有放行可选正文");
  assert.match(app, /app\.isMobile && isSelectableTextTarget/, "App.vue 的放行没有限定触屏");
});
