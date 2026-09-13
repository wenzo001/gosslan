import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldStartLongPress, shouldSwallowLongPressRelease } from "./longPress.ts";

/**
 * 移动端长按的两个真机事故（用户 2026-09-13 Android 实测）：
 *
 * 1. 「长按气泡，有的时候弹不出来那个复制/转发的 sheet，有的时候又能弹出来」
 *    ⇒ 正文里那个 `.gosslan-selectable` 类还在 DOM 上（桌面端靠它选字），
 *      于是"命中就不起长按"的老判据让**按在文字上**（气泡绝大部分面积）彻底没反应，
 *      只有按到 `px-3 py-1.5` 那圈内边距才弹。
 * 2. 「弹出 sheet 之后一放手立马就缩回去了」
 *    ⇒ HeadlessUI `Dialog` 的 outside-click 在 document 捕获阶段挂 `touchend`，
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
  hitSelectable: false,
  insideTextBubble: false,
};

test("长按判据：触屏下按在正文文字上**必须**起长按（回归：按在文字上没反应）", () => {
  // 手指落在 `.gosslan-selectable` 正文上（它同时也在 `.gosslan-bubble-text` 气泡里）
  assert.equal(
    shouldStartLongPress({ ...base, hitSelectable: true, insideTextBubble: true }),
    true,
    "正文气泡在触屏下已被 `pointer: coarse` 关掉选中（选字改走菜单里的「选择文字」），" +
      "不许再让长按让路 —— 否则只有按到气泡内边距才弹面板",
  );
  // 按在气泡内边距/头像侧（没命中 selectable）同样要起
  assert.equal(shouldStartLongPress(base), true);
});

test("长按判据：真的还能选字的区域（如代码块）继续让路给系统选区", () => {
  assert.equal(
    shouldStartLongPress({ ...base, hitSelectable: true, insideTextBubble: false }),
    false,
    "代码块等区域在触屏下仍可原生选字，长按要留给系统；不能为了修正文气泡把这里也抢掉",
  );
});

test("长按判据：桌面端走右键、系统消息没有菜单、选择文字模式让给系统手柄", () => {
  assert.equal(shouldStartLongPress({ ...base, isMobile: false }), false, "桌面端不挂长按（有右键菜单）");
  assert.equal(shouldStartLongPress({ ...base, isSystem: true }), false, "系统消息没有可操作内容");
  assert.equal(
    shouldStartLongPress({ ...base, selectMode: true }),
    false,
    "「选择文字」模式下长按要交给系统选区手柄，否则选不了字",
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
  const panelAt = sheet.indexOf("<DialogPanel");
  assert.ok(panelAt > 0, "ActionSheet 里找不到 <DialogPanel>（模板结构变了？）");
  // ⚠️ 只看**开标签本身**：整个 `<DialogPanel>…</DialogPanel>` 里还含"取消"按钮，
  //    它自己也有 `@click=\"emit('close')\"` —— 用整段去断言的话，把面板上的收起删掉也测不出来
  //    （这个空转正是 `verify-guards.py` 抓出来的）。
  const panelOpenTag = sheet.slice(panelAt, sheet.indexOf(">", panelAt) + 1);
  assert.match(
    panelOpenTag,
    /@click="emit\('close'\)"/,
    "ActionSheet 的 <DialogPanel> 开标签必须在点击时收起 —— 否则点完『引用/转发/保存图片』面板还挂在那儿",
  );

  // ② 引用 / 转发另加一道保险：它们是"跳到别处去操作"（引用草稿 / 转发弹窗），
  //    即使以后面板的通用规则改了，也不该让 sheet 留在跳转后的界面上面。
  const item = read("components/MessageItem.vue");
  for (const fn of ["function doQuote", "function doForward"]) {
    const at = item.indexOf(fn);
    assert.ok(at > 0, `找不到 ${fn}（护栏需要同步更新）`);
    const body = item.slice(at, at + 600);
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
  for (const field of ["isMobile", "isSystem", "selectMode", "hitSelectable", "insideTextBubble"]) {
    assert.match(
      item,
      new RegExp(`${field}:`),
      `必须把 \`${field}\` 传给判据 —— 少传一个就等于那条规则失效`,
    );
  }
  assert.match(
    item,
    /insideTextBubble:\s*!!el\?\.closest\("\.gosslan-bubble-text"\)/,
    "`insideTextBubble` 必须真的按 `.gosslan-bubble-text` 判定（正文气泡的标记）",
  );
  assert.match(item, /hitSelectable:\s*!!el\?\.closest\("\.gosslan-selectable"\)/);
});

test("MessageItem：面板展开期间必须在 window 捕获阶段吞掉抬手那一下", () => {
  const item = read("components/MessageItem.vue");
  assert.match(
    item,
    /window\.addEventListener\(\s*"touchend",\s*swallowLongPressRelease,\s*\{\s*capture:\s*true/,
    "必须挂 window 的**捕获**阶段：HeadlessUI 的 outside-click 挂的是 document 捕获，" +
      "同阶段按注册顺序执行（它先注册），只有 window 才抢得到它前面",
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
  assert.match(fn, /e\.preventDefault\(\)/, "吞掉的动作就是 preventDefault（HeadlessUI 判据里有 `if (e.defaultPrevented) return`）");
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
