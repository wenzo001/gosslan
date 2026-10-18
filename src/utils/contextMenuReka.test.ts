import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * 右键菜单外壳的形态判据（2026-10-18 由自建内核迁到 Reka DropdownMenu）。
 *
 * 外壳此前自己实现了 Teleport、贴边内收、document click、window keydown、↑↓/Home/End 循环
 * 和焦点归还。迁走之后最容易发生的退化是"又加回一层": 为了某个小需求重新写一套监听器，
 * 于是同一份菜单同时受 Reka 与自建逻辑驱动（Esc 关两次、焦点被抢、外部点击互相抵消）。
 * 这里把内核归属钉死，同时保证四个业务菜单真的改用库条目（按钮收回 role=menuitem 会让
 * Reka 的 roving tabindex 看不见它，键盘导航静默失效）。
 */
const srcRoot = join(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(join(srcRoot, rel), "utf8");
}

test("ContextMenu 外壳走 Reka DropdownMenu 的虚拟锚点，不再自建定位/键盘/外点内核", () => {
  const shell = read("components/ContextMenu.vue");
  assert.ok(shell.includes("DropdownMenuRoot"), "外壳必须由 Reka DropdownMenuRoot 驱动");
  assert.ok(shell.includes("DropdownMenuContent"), "菜单面板必须是 DropdownMenuContent");
  assert.ok(shell.includes(':reference="anchor"'), "鼠标坐标必须作为虚拟锚点交给 Reka（否则贴边翻转失效）");

  for (const legacy of [
    'document.addEventListener("click"',
    'window.addEventListener("keydown"',
    "onMenuKey",
    "moveFocus",
    "estimatedHeight",
  ]) {
    assert.ok(!shell.includes(legacy), `外壳又长回了自建内核：${legacy}`);
  }
});

test("四个业务右键菜单全部使用 DropdownMenuItem，且不再手写 role=menuitem 按钮", () => {
  const menus = [
    "components/message/MessageContextMenu.vue",
    "components/conversation/ConversationContextMenu.vue",
    "components/conversation/FriendContextMenu.vue",
    "components/FavoritePanel.vue",
  ];
  for (const rel of menus) {
    const src = read(rel);
    assert.ok(src.includes("DropdownMenuItem"), `${rel} 的条目没有接回 Reka`);
    assert.ok(src.includes("@select="), `${rel} 的条目没有用 @select（键盘回车不会触发）`);
    assert.ok(!src.includes('role="menuitem"'), `${rel} 仍残留手写 role=menuitem（会被 Reka 的 roving focus 忽略）`);
  }
});

test("右键菜单调用点不再传 estimated-height（定位已由 floating-ui 负责）", () => {
  for (const rel of [
    "components/message/MessageContextMenu.vue",
    "components/conversation/ConversationContextMenu.vue",
    "components/conversation/FriendContextMenu.vue",
    "components/FavoritePanel.vue",
  ]) {
    assert.ok(!read(rel).includes("estimated-height"), `${rel} 还在传 estimated-height`);
  }
});

test("菜单内容不得再写 fixed（popper wrapper 会量到 0×0，翻转/内收静默失效）", () => {
  // 注释里也写着 class="gosslan-menu-item" 的示例；先剥注释，否则尺子量到的是例子而不是模板。
  const shell = read("components/ContextMenu.vue")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const contentClass = /class="([^"]*gosslan-menu[^"]*)"/.exec(shell)?.[1] ?? "";
  assert.ok(contentClass.includes("gosslan-menu"), "找不到菜单内容的类名");
  assert.ok(!/\bfixed\b/.test(contentClass), "内容又写了 fixed ⇒ floating-ui 量不到尺寸，贴边翻转会失效");
  assert.ok(contentClass.includes("z-[70]"), "菜单内容的层级必须是 z-[70]（浮层阶梯由 designGuards 钉）");
});

test("搜索筛选菜单走 Reka DropdownMenu，且不抢搜索框焦点", () => {
  const src = read("components/search/ChatSearchDialog.vue");
  assert.ok(src.includes("<DropdownMenuRoot"), "发送人/日期菜单没有接 Reka");
  assert.ok(src.includes("<DropdownMenuTrigger"), "筛选入口必须由 Reka 的 Trigger 接管");
  assert.ok(!src.includes('role="menuitem"'), "仍残留手写 role=menuitem（Reka 的 roving focus 会忽略它）");
  assert.ok(!src.includes('aria-haspopup="menu"'), "aria-haspopup 由 Reka 的 Trigger 自己写，手写会分叉");
  // 菜单嵌在搜索弹窗里：modal 焦点陷阱会把输入框的焦点抢回菜单，方向键判据（--only=search）会红。
  assert.equal(
    (src.match(/:modal="false"/g) ?? []).length,
    2,
    "两个筛选 Root 都必须 modal=false（否则搜索框拿不回焦点）",
  );
});

test("会话列表/导航栏/三选一字段的锚定菜单都改由 Reka Trigger 驱动", () => {
  for (const rel of [
    "components/ConversationList.vue",
    "components/NavRail.vue",
    "components/TodoPickField.vue",
  ]) {
    const src = read(rel);
    assert.ok(src.includes("<DropdownMenuRoot"), `${rel} 没有接 Reka`);
    assert.ok(src.includes("<DropdownMenuTrigger"), `${rel} 的入口必须由 Reka Trigger 接管`);
    assert.ok(!src.includes('aria-haspopup="menu"'), `${rel} 仍手写 aria-haspopup，会与 Trigger 分叉`);
    assert.ok(!src.includes('role="menuitem"'), `${rel} 仍手写 role=menuitem`);
  }
});

test("群任务看板行内状态菜单走 Reka 虚拟锚点，不再手算上下翻转", () => {
  const src = read("components/GroupTasksBoard.vue");
  assert.ok(src.includes("<DropdownMenuContent"), "行内状态菜单没有接 Reka");
  assert.ok(src.includes(':reference="rowMenuAnchor"'), "必须把入口坐标作为虚拟锚点交给 Reka");
  assert.ok(!src.includes("popupPlacement("), "上下翻转已由 floating-ui 接管，不许再手算");
  assert.ok(!src.includes('role="menuitem"'), "仍手写 role=menuitem");
});

/** 业务组件里不再存在手写菜单条目：条目语义（role/tabindex/键盘）必须由库渲染。 */
test("全 src 的 .vue 里不再手写 role=menuitem", () => {
  const root = join(srcRoot, "components");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".vue")) files.push(p);
    }
  };
  walk(root);
  assert.ok(files.length > 80, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad = files.filter((f) =>
    /role="menuitem"/.test(
      readFileSync(f, "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, ""),
    ),
  );
  assert.deepEqual(bad, [], "仍有手写菜单条目；请改用库的 DropdownMenuItem");
});
