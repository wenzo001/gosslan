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

/**
 * 「菜单往视口里收」这件事只有一个 owner（§6.85 新增）。
 *
 * 外壳 `ContextMenu.vue` 把鼠标点做成**零尺寸虚拟锚点**，量尺寸、翻转、贴边内收都由 Reka 的
 * popper wrapper 做（外壳注释里写死了这条）。可 `ConversationList.onFriendContext` 之前还自己按
 * `mw=150 / mh=90` 两个**猜出来的菜单尺寸**向内收了一遍 —— 那是迁到 Reka 之前的手算残留：
 * 菜单条目增减时这两个数就漂，而漂了不报错，只是弹开的落点偏离用户点的位置。同文件里的
 * `onConvContext` 早就把坐标原样传下去了 ⇒ 一个文件里两种口径，这才是本轮要收的。
 *
 * ⚠️ 缺席型判据的三件零件：正控（这个 matcher 认得出那种写法）、分母下限（扫描面缩水到
 *    判据自己失效时不许当绿）、**反向钉名单**（剩下那一处必须点名是哪本文件、它限的是宽不是收边）。
 */
test("菜单的视口收边只剩一个 owner：父级不许再猜菜单尺寸", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const SRC = join(import.meta.dirname, "..");
  const CLAMP = /Math\.max\(\s*\d+\s*,\s*Math\.min\([^)]*window\.inner(?:Width|Height)/g;
  // 正控：先证明这个 matcher 认得出那种写法，否则下面的"只剩一处"可能只是正则坏了。
  assert.equal(
    CLAMP.test("friendMenu.value = { x: Math.max(8, Math.min(x, window.innerWidth - 158)) };"),
    true,
    "matcher 认不出手算收边，后面的名单判据是空转",
  );
  CLAMP.lastIndex = 0;

  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".vue") || (p.endsWith(".ts") && !p.endsWith(".test.ts")))
    .map((p) => p.replaceAll("\\", "/"));
  assert.ok(files.length >= 180, `扫描面只有 ${files.length} 份生产文件，扫描本身可能已失效`);
  const hits = new Set<string>();
  for (const r of files) {
    const code = readFileSync(join(SRC, r), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l))
      .join("\n");
    for (const m of code.matchAll(CLAMP)) {
      void m;
      hits.add(r);
    }
  }
  assert.deepEqual(
    [...hits],
    ["components/GroupTasksBoard.vue"],
    "手算视口收边这一族又长出了新成员（坐标收边归 Reka 的 popper，父级只该传裸坐标）",
  );
  const board = readFileSync(join(SRC, "components/GroupTasksBoard.vue"), "utf8");
  assert.match(
    board,
    /Math\.max\(96, Math\.min\(ROW_MENU_W, window\.innerWidth - 16\)\)/,
    "留着的那一处是**限菜单自己的宽**（Reka 不会替内容缩宽），换形状时要一起判它该不该留",
  );

  // 反向钉：这两个菜单都必须原样传坐标，且那个外壳契约不能被拆掉。
  const conv = readFileSync(join(SRC, "components/ConversationList.vue"), "utf8");
  assert.match(conv, /friendMenu\.value = \{ x, y, friend: f \}/, "好友菜单不该再自己收边");
  assert.match(conv, /convMenu\.value = \{ x, y, conv \}/, "会话菜单不该再自己收边");
  const shell = readFileSync(join(SRC, "components/ContextMenu.vue"), "utf8");
  assert.match(shell, /getBoundingClientRect/, "外壳的虚拟锚点没了 —— 那 Reka 就量不到锚点，收边无人负责");
  console.log(`· 手算收边这一族现读 ${hits.size} 本文件（名单：${[...hits].join(" ") || "空"}）`);
});
