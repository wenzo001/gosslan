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
  //    头像、行内空白在列外 ⇒ 不会因为"同属一条消息"就弹菜单。
  assert.match(item, /data-msg-col[\s\S]{0,700}?@contextmenu="onContextMenu"/,
    "contextmenu 处理器没有挂在 data-msg-col（消息内容列）上");
  assert.doesNotMatch(item, /class="group\/msg"[^>]*@contextmenu=/,
    "处理器仍然挂在整条消息根上 —— 头像/空白会误触发");
  // 表情回应的笑脸按钮在列内（绝对定位），必须显式排除。
  // 2026-10-24 起回应条也进了列内（它是气泡的底栏），同样必须排除 —— 右键胶囊只该是控件行为。
  assert.match(item, /closest\("\[data-reaction-entry\][^"]*"\)/,
    "没有排除表情回应入口 ⇒ 右键笑脸会弹消息菜单");
  assert.match(item, /closest\("[^"]*\[data-reaction-strip\]"\)/,
    "没有排除表情回应条（已并入气泡、落在消息列内）⇒ 右键胶囊会弹消息菜单");
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

/**
 * N6-1（2026-11-01 用户拍板）：**代码块气泡右键 →「复制」**。
 *
 * 为什么钉三条：① 右键处理器若挂在卡片外（或只剩底栏按钮），点代码区不会弹；
 * ② 菜单必须走统一外壳与统一条目样式（`.gosslan-menu-item`），否则又是一个自绘弹层；
 * ③ 菜单里的复制**必须走与底栏按钮同一个 `emit("copy")`** —— 两处各写一遍，
 *    "复制的到底是全文还是截断后的" 这类差异迟早出现。
 */
test("代码块右键：挂在卡片根上、走统一外壳、复制与底栏按钮同一个 emit", () => {
  const path = join(import.meta.dirname, "..", "components", "message", "MessageCodeBubble.vue");
  const src = readFileSync(path, "utf8");

  assert.match(
    src,
    /class="relative min-w-0 flex-1"[\s\S]{0,200}?@contextmenu="onContextMenu"/,
    "右键处理器不在卡片根上 ⇒ 点在代码区不会弹菜单",
  );
  assert.match(src, /<ContextMenu v-if="ctx"/, "没有走统一的 ContextMenu 外壳");
  assert.match(
    src,
    /DropdownMenuItem class="gosslan-menu-item" @select="copyFromMenu"/,
    "菜单条目没有用统一的 .gosslan-menu-item 样式",
  );

  // 两处引号风格都可能出现（老代码单引号、新菜单双引号）⇒ 一律认。
  const copies = (src.match(/emit\(["']copy["'],/g) || []).length;
  assert.equal(copies, 2, `emit("copy") 出现 ${copies} 次 ⇒ 底栏按钮与菜单必须共用同一个出口（应恰好 2 处）`);

  // 正控：把菜单那一处换成一个自造事件，第③条必须当场红。
  const gutted = src.replace('emit("copy", code);', 'emit("copy-from-menu", code);');
  assert.notEqual(gutted, src, "变异没落进去 ⇒ 锚点写法变了");
  assert.equal(
    (gutted.match(/emit\(["']copy["'],/g) || []).length,
    1,
    "换掉菜单那处 emit 之后仍数到 2 处 ⇒ 这条尺子在空集上恒绿",
  );
});

/** N6-3（2026-11-01 用户拍板）：群文件行右键 →「另存为」「打开所在目录」。 */
test("群文件行右键：没有本地文件就不弹菜单；两个动作都复用既有出口", () => {
  const path = join(import.meta.dirname, "..", "components", "GroupFilesPanel.vue");
  const src = readFileSync(path, "utf8");

  assert.match(src, /@contextmenu="onContextMenu\(f, \$event\)"/, "行上没挂右键处理器");
  assert.match(
    src,
    /if \(!f\.local_path\) return;/,
    "本地没有这份文件时也弹菜单 ⇒ 两个动作都点不动，比不弹更糟",
  );
  assert.match(
    src,
    /await saveLocalFile\(f\.local_path/,
    "另存为必须复用 utils/localFile（Android 走 SAF 的差异只在那一处）",
  );
  assert.match(src, /await revealItemInDir\(f\.local_path\)/, "打开所在目录必须走 opener 插件");

  // 正控：把"没有本地文件就不弹"那行砍掉，第一条断言必须红。
  const gutted = src.replace("if (!f.local_path) return;\n  e.preventDefault();", "e.preventDefault();");
  assert.notEqual(gutted, src, "变异没落进去 ⇒ 锚点写法变了");
  // ⚠️ 这条守卫在文件里出现 3 次（右键/另存为/打开目录各一次）⇒ 正控必须盯**右键那一处**
  //    （带 `e.preventDefault()` 的上下文），否则砍掉它之后另外两处仍让通用正则命中。
  assert.equal(
    gutted.includes("if (!f.local_path) return;\n  e.preventDefault();"),
    false,
    "砍掉右键那处守卫后仍然命中 ⇒ 这条判据在空集上恒绿（或盯错了那一处）",
  );
});

/** N6-2（2026-11-01 用户拍板）：群成员行右键 →「@他」「查看资料」。 */
test("群成员行右键：面板只上报意图，插入 @ 与打开资料都在父组件那一个家里", () => {
  const panel = readFileSync(
    join(import.meta.dirname, "..", "components", "GroupMemberPanel.vue"),
    "utf8",
  );
  const win = readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8");

  assert.match(panel, /@contextmenu="onContextMenu\(row, \$event\)"/, "成员行没挂右键处理器");
  assert.match(panel, /emit\("mention", id\)/, "「@他」没有上报");
  assert.match(panel, /emit\("open-profile", id\)/, "「查看资料」没有上报");
  // 面板自己不碰编辑器、也不自己跳路由 —— 两个家各写一遍就是下一处漂移。
  assert.ok(!/insertMention/.test(panel), "面板自己插了 @ ⇒ 编辑器那条路径出现了第二个家");
  assert.ok(!/router\.push/.test(panel), "面板自己跳了路由 ⇒ 资料页入口出现第二个家");

  assert.match(win, /@mention="onMemberMention"/, "ChatWindow 没接成员面板的「@他」");
  assert.match(win, /composerRef\.value\?\.insertMention/, "「@他」没有真的插进输入框");
  assert.match(win, /function onMemberProfile[\s\S]{0,120}openSenderProfile\(id\)/, "「查看资料」没走既有解析");
});
