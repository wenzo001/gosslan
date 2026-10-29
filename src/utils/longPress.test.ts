import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldStartLongPress, shouldSwallowLongPressRelease } from "./longPress.ts";
import { tsFnBody } from "./tsSource.ts";

/**
 * 移动端长按的两个真机事故（用户 2026-09-13 Android 实测）：
 *
 * 1. 「长按气泡，有的时候弹不出来那个复制/转发的 sheet，有的时候又能弹出来」
 *    ⇒ 正文里那个 `.gosslan-selectable` 类还在 DOM 上（桌面端靠它选字），
 *      于是"命中就不起长按"的老判据让**按在文字上**（气泡绝大部分面积）彻底没反应，
 *      只有按到 `px-3 py-1.5` 那圈内边距才弹。
 * 2. 「弹出 sheet 之后一放手立马就缩回去了」
 *    ⇒ 当时的 HeadlessUI `Dialog` 在 document 捕获阶段挂 `touchend`（现在换 Reka 后走 pointerdown，
 *      而 touch 的 target 在 touchstart 就定死了（= 那条消息）⇒ 抬手被判成"点了外面"。
 *      必须在 window 捕获阶段 `preventDefault` 吞掉。
 *
 * 两条都"功能看起来还在"（换个位置按、或者按慢一点就正常），所以只能靠判据单测 + 结构护栏。
 */

const srcDir = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(srcDir, p), "utf8");

/** 触屏 + 普通文本消息 + 没进选择模式的默认语境。 */
const base = {
  isMobile: true,
  isSystem: false,
  selectMode: false,
  multiSelect: false,
  hitSelectable: false,
};

test("长按判据：触屏下按在可选正文上**不起**自定义面板（系统原生选字优先）", () => {
  // 手指落在 `.gosslan-selectable` 正文上 ⇒ 放手让 WebView 进入原生选字/系统复制菜单。
  // 2026-10-23 产品口径：移动端必须保留系统原生选字；再起 500ms 定时器会同时弹两个菜单。
  assert.equal(
    shouldStartLongPress({ ...base, hitSelectable: true }),
    false,
    "正文是可选的 ⇒ 长按归系统选区（手柄 + 系统复制菜单）；自定义面板只在非正文区起",
  );
  // 按在气泡内边距/昵称/引用块/卡片（没命中 selectable）⇒ 起自定义面板
  assert.equal(shouldStartLongPress(base), true);
});

test("长按判据：桌面端走右键、系统消息没有菜单、选字/多选模式让路", () => {
  assert.equal(shouldStartLongPress({ ...base, isMobile: false }), false, "桌面端不挂长按（有右键菜单）");
  assert.equal(shouldStartLongPress({ ...base, isSystem: true }), false, "系统消息没有可操作内容");
  assert.equal(
    shouldStartLongPress({ ...base, selectMode: true }),
    false,
    "「选择文字」模式下长按要交给系统选区手柄，否则选不了字",
  );
});

test("长按判据：多选模式下长按不弹菜单（那一点是勾选，不是弹菜单）", () => {
  assert.equal(
    shouldStartLongPress({ ...base, multiSelect: true }),
    false,
    "多选态下手指长按如果弹出菜单，用户会分不清这一下到底选中了没有；微信也不给",
  );
});

test("抬手吞掉规则：只有「面板是这次按压弹出的 + 面板还开着」才吞", () => {
  assert.equal(shouldSwallowLongPressRelease({ openedByHeldPress: true, sheetOpen: true }), true);
  // 面板已经关了（用户点了遮罩/选了菜单项）：后续 tap 不许再被吞，否则点不动界面
  assert.equal(shouldSwallowLongPressRelease({ openedByHeldPress: true, sheetOpen: false }), false);
  // 普通点按（没有长按）：一律不吞
  assert.equal(shouldSwallowLongPressRelease({ openedByHeldPress: false, sheetOpen: true }), false);
  assert.equal(shouldSwallowLongPressRelease({ openedByHeldPress: false, sheetOpen: false }), false);
});

test("操作面板：点任何一项都必须收起（引用/转发会跳到别处，更必须先收）", () => {
  // ① 面板层统一收起：成熟产品（iOS ActionSheet / 微信 / Telegram 底部菜单）都是"点一项即消失"。
  //    用户 2026-09-13 安卓实测：「点『引用』这个 sheet 应该自动隐藏；点『转发』也应该自动隐藏，
  //    因为它会跳转到界面内去操作聊天」—— 不在这一层统一收，就得每个入口各写一遍，漏一个就挡住新界面。
  const sheet = read("components/ActionSheet.vue");
  const panelAt = sheet.indexOf("<DialogContent");
  assert.ok(panelAt > 0, "ActionSheet 里找不到 <DialogContent>（弹层原语换了？）");
  // ⚠️ 只看**开标签本身**：整个对话框里还含"取消"按钮，它自己也有 `@click=\"emit('close')\"`
  //    —— 用整段去断言的话，把面板上的收起删掉也测不出来（这个空转正是 `verify-guards.py` 抓出来的）。
  const panelOpenTag = sheet.slice(panelAt, sheet.indexOf(">", panelAt) + 1);
  // 2026-10-22：面板级点击改走 `onContentClick`（下拉关闭要能吞掉拖拽末尾那次 click，
  // 否则"手一滑、面板自己关了"）。**这不是放宽这条断言** —— 下面多出来的一条要求同一个函数体
  // 里真的 `emit("close")`：原来只盯一行内联字面量，而那行可以挂着、函数却没人调它。
  assert.match(
    panelOpenTag,
    /@click="onContentClick"/,
    "ActionSheet 的 DialogContent 开标签必须在点击时收起 —— 否则点完『引用/转发/保存图片』面板还挂在那儿",
  );
  assert.match(
    sheet,
    /function onContentClick\(\)[\s\S]{0,200}?if \(dragged\)[\s\S]{0,120}?emit\("close"\)/,
    "onContentClick 必须同时做到两件事：拖拽过就吞掉这次点击（否则回弹后被误判成点击关闭）、" +
      "没拖过就收起面板（否则点一项面板还挂着）",
  );

  // ② 引用 / 转发另加一道保险：它们是"跳到别处去操作"（引用草稿 / 转发弹窗），
  //    即使以后面板的通用规则改了，也不该让 sheet 留在跳转后的界面上面。
  const item = read("components/MessageItem.vue");
  for (const fn of ["function doQuote", "function doForward"]) {
    // ⚠️ 按**花括号配对**切函数体，不用固定窗口：原来是 `slice(at, at + 600)`，
    //    2026-10-29 只给 doForward 加了 3 行注释就把调用点挤到 608 字符处 ⇒ 判据假红。
    //    固定窗口还有个更糟的方向：调用写在函数**外面**、但落在窗口里，它照样绿。
    const body = tsFnBody(item, fn);
    assert.ok(body.length > 0, `找不到 ${fn} 的函数体（护栏需要同步更新）`);
    assert.match(
      body,
      /closeActionSheet\(\)/,
      `${fn} 必须调用 closeActionSheet() —— 用户实测点它之后底部面板不会自己消失`,
    );
  }
});

test("MessageItem：长按判据必须走 utils/longPress 的纯函数，并传全语境", () => {
  const item = read("components/MessageItem.vue");
  assert.match(item, /shouldStartLongPress\(\{/, "长按判据必须调用纯函数（别在组件里再写一份 if）");
  for (const field of ["isMobile", "isSystem", "selectMode", "multiSelect", "hitSelectable"]) {
    assert.match(
      item,
      new RegExp(`${field}:`),
      `必须把 \`${field}\` 传给判据 —— 少传一个就等于那条规则失效`,
    );
  }
  assert.match(item, /hitSelectable:\s*!!el\?\.closest\("\.gosslan-selectable"\)/,
    "`hitSelectable` 必须真的按 `.gosslan-selectable` 判定（可选正文的标记）");
  assert.doesNotMatch(item, /insideTextBubble/,
    "`insideTextBubble` 已从判据删除（触屏正文现在就是可选正文；留着只会误导下一个人）");
});

test("MessageItem：面板展开期间必须在 window 捕获阶段吞掉抬手那一下", () => {
  const item = read("components/MessageItem.vue");
  assert.match(
    item,
    /window\.addEventListener\(\s*"touchend",\s*swallowLongPressRelease,\s*\{\s*capture:\s*true/,
    "必须挂 window 的**捕获**阶段：document 上的同类监听与它同阶段时按注册顺序执行（库先注册），" +
      "只有 window 捕获才抢得到它前面",
  );
  assert.match(
    item,
    /window\.addEventListener\(\s*"touchcancel",\s*swallowLongPressRelease/,
    "touchcancel 也要复位标记，否则之后第一次点按会被误吞",
  );
  const fn = item.slice(
    item.indexOf("function swallowLongPressRelease"),
    item.indexOf("function swallowLongPressRelease") + 700,
  );
  assert.match(fn, /e\.preventDefault\(\)/, "吞掉的动作就是 preventDefault（按 defaultPrevented 让路的实现都吃这一下）");
  assert.match(fn, /shouldSwallowLongPressRelease\(\{/, "吞不吞要走纯判据，不许写死 true");
  assert.ok(
    !/if \(textSelecting\.value\) return;[\s\S]{0,200}closest\("\.gosslan-selectable"\)\) return;/.test(item),
    "旧的『命中 .gosslan-selectable 就 return』判据必须已经删除",
  );
  assert.match(
    item,
    /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}window\.removeEventListener\(\s*"touchend",\s*swallowLongPressRelease/,
    "组件卸载必须摘掉 window 监听（它不随组件销毁）",
  );
});

/**
 * 两处长按**故意**用不同的取消路径：
 *  · `MessageItem` 自己绑 `@touchmove` 判，所以必须有抖动容差（"手指动 1px 就取消"= 长按十次九次不灵，
 *    用户 2026-09-13 实测，见上面那条真值表）；
 *  · `MessageReactionBar` 的"长按胶囊看名单"不绑 move，靠 `pointercancel`（浏览器把这一串手势
 *    判给滚动时发出）+ `pointerup` / `pointerleave` 清定时器。
 * 第二种能成立的前提是"那三个出口都在"。少一个（尤其是 `pointercancel`）就变成
 * "在胶囊上开始竖向滑动 ⇒ 450ms 后名单自己弹出来" —— 而这条只在真机上看得见。
 */
test("第二家长按（回应胶囊看名单）的取消出口必须成对接好", () => {
  const bar = read("components/message/MessageReactionBar.vue");
  const starts = (bar.match(/@pointerdown="onPressStart/g) ?? []).length;
  assert.ok(starts >= 1, "没认出胶囊长按的起点，下面这组成对判据就是空转");
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    assert.ok(
      new RegExp(`@${ev}="clearPress"`).test(bar),
      `胶囊长按缺 @${ev}="clearPress" —— 定时器会在手指已经离开之后自己把名单弹开`,
    );
  }
  assert.equal(
    starts,
    (bar.match(/@pointercancel="clearPress"/g) ?? []).length,
    "起点数与 cancel 出口数不是一对一：新增一处长按却漏了取消路径",
  );
  assert.match(bar, /onUnmounted\(clearPress\)/, "组件卸载必须摘掉这根定时器（它不随组件销毁）");
  // 正控：成对判据要真的会为一处缺失而红，否则"三个出口都在"可能只是匹配器坏了。
  const synthetic = '<button @pointerdown="onPressStart(e)" @pointerup="clearPress" @pointerleave="clearPress" />';
  assert.ok(!/@pointercancel="clearPress"/.test(synthetic), "正控失效：合成样本缺 cancel 却被判成有");
  // ⚠️ 没有读数的一维：真机上"从胶囊起手竖向滑动"到底发不发 `pointercancel`（各家 WebView 不同）。
  // UI 探针那一段走的是 hover 路径（`canHover` 为真时这条长按分支直接 return）⇒ 这里只钉形状，不声称行为已验。
});
