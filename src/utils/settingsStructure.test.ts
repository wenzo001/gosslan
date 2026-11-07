/**
 * 设置结构守卫：**导航项的标签必须与点进去看到的内容一致**。
 *
 * 为什么值得单独守：2026-09-12 用户反馈「设置里的分类好像不太合理，通知里面的第一个和
 * 第三个好像不算是通知里的」—— 根因是导航项写着「通知」，点开却是
 * 「语言 + 通知 + 共享目录」（`GeneralSection` 一个组件塞了三件事）。
 * 这类问题**界面上一切正常**（没有报错、功能都在），只有人点进去才会发现分类错了，
 * 所以只能用静态守卫钉住：标签键、分区组件、分区内第一组标题三者必须对得上。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_LEGACY_LANDING,
  DESKTOP_NAV,
  MOBILE_ALIASES,
  MOBILE_GROUPS,
  MOBILE_SECTIONS,
  ROUTE_SECTIONS,
  normalizeMobileSectionKey,
  resolveDesktopRouteKey,
  resolveMobileSectionKey,
} from "./settingsManifest.ts";

const srcDir = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(srcDir, rel), "utf8");

/**
 * 9 个桌面分区 → 导航标签键 → 该页渲染的分区组件。
 *
 * 2026-11-07（用户 11-06「3 可以」）：桌面从 4 容器改为 **9 分区双栏**，
 * 与移动端同名同序。桌面独有的「文件」归在文件与存储页、「安全」归在关于页。
 */
const EXPECTED = [
  { key: "profile", labelKey: "settings.item.profile", components: ["ProfileSection"] },
  { key: "general", labelKey: "settings.item.general", components: ["GeneralSection"] },
  { key: "appearance", labelKey: "settings.item.appearance", components: ["AppearanceSection"] },
  { key: "chatStyle", labelKey: "settings.item.chatStyle", components: ["ChatStyleSection"] },
  { key: "notifications", labelKey: "settings.item.notification", components: ["NotificationSection"] },
  { key: "network", labelKey: "settings.item.network", components: ["NetworkSection"] },
  {
    key: "storageFiles",
    labelKey: "settings.item.storageFiles",
    // 存储 + 文件同属这一页（重置单独一页）。
    components: ["StorageSection", "FilesSection"],
  },
  {
    key: "about",
    labelKey: "settings.item.about",
    // 安全并入关于，不另立导航项。
    components: ["SecuritySection", "AboutSection"],
  },
  { key: "reset", labelKey: "settings.item.reset", components: ["ResetSection"] },
] as const;

test("每个顶层导航项都渲染了它承诺的分区组件（标签即内容）", () => {
  const win = read("components/SettingsWindow.vue");
  for (const item of EXPECTED) {
    const nav = DESKTOP_NAV.find((n) => n.key === item.key);
    assert.ok(nav, `SettingsWindow 导航清单缺 ${item.key}`);
    assert.equal(nav.labelKey, item.labelKey, `导航项 ${item.key} 的标签键变了`);
    const at = win.indexOf(`section === '${item.key}'`);
    assert.ok(at >= 0, `SettingsWindow 里没有 ${item.key} 的渲染分支`);
    const window_ = win.slice(Math.max(0, at - 250), at + 2500);
    for (const component of item.components) {
      assert.ok(
        window_.includes(component),
        `导航项 ${item.key} 点开后必须渲染 ${component}（否则"标签说 A、内容是 B"）`,
      );
    }
  }
});

test("桌面左栏 = 9 个分区，与移动端同名同序（用户 11-06「3 可以」）", () => {
  // 移动端 9 项的顺序；桌面复数 notifications 对应移动单数 notification。
  const desktopOrder = MOBILE_SECTIONS.map((s) =>
    s.key === "notification" ? "notifications" : s.key,
  );
  assert.equal(DESKTOP_NAV.length, 9, `桌面导航应为 9 项，实际 ${DESKTOP_NAV.length}`);
  assert.deepEqual(
    DESKTOP_NAV.map((n) => n.key),
    desktopOrder,
    "桌面导航顺序与移动端不一致",
  );
  for (const s of MOBILE_SECTIONS) {
    const desktopKey = s.key === "notification" ? "notifications" : s.key;
    const nav = DESKTOP_NAV.find((n) => n.key === desktopKey);
    assert.ok(nav, `桌面导航缺 ${desktopKey}`);
    assert.equal(nav.labelKey, s.titleKey, `${desktopKey} 的标签键与移动端条目名不一致`);
  }
});

test("每个设置分区组件都被两个外壳引用（没有孤儿分区）", () => {
  const win = read("components/SettingsWindow.vue");
  const panel = read("components/SettingsPanel.vue");
  const files = readdirSync(join(srcDir, "components", "settings")).filter((f) => f.endsWith("Section.vue"));
  for (const f of files) {
    const name = f.replace(".vue", "");
    assert.ok(win.includes(name), `SettingsWindow 未引用 ${name}`);
    assert.ok(panel.includes(name), `SettingsPanel 未引用 ${name}`);
  }
  // 反向：外壳引用的分区组件都必须真实存在（改文件名时不会留死引用）
  for (const item of EXPECTED) {
    for (const component of item.components) {
      assert.ok(files.includes(`${component}.vue`), `${component}.vue 不存在`);
    }
  }
});

test("移动端一级列表与桌面同一套 4 类，且「文件与存储」装着存储/文件/重置", () => {
  assert.deepEqual(
    MOBILE_GROUPS.map((g) => g.key),
    ["general", "network", "storageFiles", "about"],
    "移动端分组必须与桌面同序：通用 / 网络 / 文件与存储 / 关于",
  );
  // 「文件与存储」组里必须有两条：文件与存储、重置与恢复（用户 2026-10-25）。
  const group = MOBILE_GROUPS.find((g) => g.key === "storageFiles");
  assert.ok(group, "缺「文件与存储」组");
  assert.ok(group.items.includes("storageFiles"), "缺「文件与存储」条目");
  assert.ok(group.items.includes("reset"), "「重置与恢复」必须留在文件与存储组里，不许回通用");
});

test("设置卡片最后一行不画分隔线（判点在唯一外壳上，不靠调用方记得传 last）", () => {
  const group = read("components/settings/SettingsGroup.vue");
  assert.ok(group.includes("data-settings-rows"), "SettingsGroup 缺少分隔线的统一钩子");
  const css = read("style.css");
  assert.match(
    css,
    /\[data-settings-rows\] > div:last-child\.h-px\s*\{\s*display: none;/,
    "样式表里没有「最后一行分隔线隐藏」的规则 ⇒ 中继/中转卡片末尾会多出一道短横线",
  );
});

test("弹窗标题最多两行且无空格长串可断行（长任务标题不再把弹窗撑出屏幕）", () => {
  const modal = read("components/BaseModal.vue");
  assert.match(
    modal,
    /line-clamp-2[\s\S]{0,120}?break-words/,
    "BaseModal 标题没有两行截断 + 断词 ⇒ 长串会把卡片撑出可视区",
  );
  assert.match(modal, /min-w-0 flex-1/, "标题不是可收缩的 flex 项 ⇒ 长标题仍会顶飞关闭按钮");
});

test("「通知」分区里不得混入非通知项（用户反馈的原缺陷）", () => {
  const src = read("components/settings/NotificationSection.vue");
  // 通知分区只应包含通知相关的设置键
  const usedKeys = [...src.matchAll(/t\("(settings\.[^"]+)"\)/g)].map((m) => m[1]);
  for (const key of usedKeys) {
    assert.ok(
      key.startsWith("settings.notify.") || key.startsWith("settings.group.notifications"),
      `NotificationSection 引用了与通知无关的设置项：${key}`,
    );
  }
  // 语言与共享目录必须已经搬走
  assert.ok(!src.includes("settings.language"), "语言不应出现在通知分区");
  assert.ok(!src.includes("share.folder"), "共享目录不应出现在通知分区");
});

/**
 * 资料分区的**头像上传**必须自己落库，且失败要回滚（用户 2026-09-24 #24）。
 *
 * 原缺陷不在"页面不刷新"，而在**保存被静默丢掉**：`onAvatarChange` 直接复用了
 * 昵称那条 `saveProfileNow()`，而它对"昵称为空"是**提前 return** ——
 * 于是"输入框恰好清空 + 点头像换图"这一次上传什么都没做，页面却已经显示新头像，
 * 切个页/重开就弹回旧图。表现完全符合"显示成功但没真成功"，
 * 而界面上没有任何报错，所以只能钉调用形状。
 *
 * 三条判据：① 头像路径不许再走 `saveProfileNow`（那条的提前出口是为昵称设计的）；
 * ② 必须有一处把 `avatar` 改回旧值的回滚（否则失败后页面上挂着从没落库的图）；
 * ③ 昵称为空时以**库里现有的昵称**一起提交，而不是放弃这次上传。
 */
test("资料分区：头像上传自己落库、失败回滚、不受昵称空值牵连", () => {
  const src = read("components/settings/ProfileSection.vue");
  const at = src.indexOf("async function onAvatarChange");
  assert.ok(at > 0, "找不到 onAvatarChange（改名了？）");
  const end = src.indexOf("\nfunction processAvatar", at);
  const body = src.slice(at, end > at ? end : at + 2600);

  // ⚠️ 判"有没有复用"必须匹配**调用形状**：注释里写着 `saveProfileNow()` 是解释为什么不用它，
  // 按裸名字搜会因为注释而误报（与本仓 designGuards 那条"注释里提到类名仍要报"同一条教训）。
  assert.ok(!/await\s+saveProfileNow\(/.test(body), "头像路径不得复用 saveProfileNow —— 它会因昵称为空提前返回");
  // 回滚必须发生在**保存失败那条路径**上。只搜"这一段里有没有 `avatar.value = prev`"是**弱判据**：
  // "昵称为空"那条拒绝分支里也有同样的赋值，把 catch 里那句删掉守卫照样绿
  // （这条实测过，所以要按 catch 块单独切窗口判）。
  const catchAt = body.indexOf("} catch (e) {");
  assert.ok(catchAt > 0, "找不到保存失败的 catch 分支（被改写了？）");
  assert.match(
    body.slice(catchAt, catchAt + 400),
    /avatar\.value = prev/,
    "保存失败必须回滚本地头像，否则页面挂着从没落库的图",
  );
  assert.match(body, /app\.device\?\.nickname/, "昵称为空时以库里现有昵称一起提交");
  // 落库仍只有一个出口：`persistProfile`（两处调用者共用，避免各写一份 updateProfile）
  assert.match(body, /await persistProfile\(name\)/, "头像也要经同一个落库出口");
  const persistAt = src.indexOf("async function persistProfile");
  assert.ok(persistAt > 0, "persistProfile 应存在（单一落库出口）");
  assert.equal(
    (src.match(/app\.updateProfile\(/g) ?? []).length,
    1,
    "updateProfile 只能出现在 persistProfile 里一处 —— 两处各调就会有两份错误处理",
  );
});

// ---------------- 设置清单 golden 与双外壳深链矩阵（批次 1A） ----------------
//
// 这里锁的是**现状**，不是理想结构。设置面板有三份不同用途的清单：
// 移动端二级页、桌面 4 容器、独立设置窗口的路由键。它们本来就不等价，
// 所以先逐项固化，再允许任何“合并清单”的改动。

const MOBILE_SECTIONS_GOLDEN = [
  { key: "profile", titleKey: "settings.item.profile", group: "general" },
  { key: "general", titleKey: "settings.item.general", group: "general" },
  { key: "appearance", titleKey: "settings.item.appearance", group: "general" },
  { key: "chatStyle", titleKey: "settings.item.chatStyle", group: "general" },
  { key: "notification", titleKey: "settings.item.notification", group: "general" },
  { key: "network", titleKey: "settings.item.network", group: "network" },
  { key: "storageFiles", titleKey: "settings.item.storageFiles", group: "storageFiles" },
  { key: "about", titleKey: "settings.item.about", group: "about" },
  { key: "reset", titleKey: "settings.item.reset", group: "storageFiles" },
] as const;

const MOBILE_ALIASES_GOLDEN = {
  storage: "storageFiles",
  files: "storageFiles",
  security: "about",
} as const;

const MOBILE_GROUPS_GOLDEN = [
  {
    key: "general",
    titleKey: "settings.group.general",
    items: ["profile", "general", "appearance", "chatStyle", "notification"],
  },
  { key: "network", titleKey: "settings.item.network", items: ["network"] },
  { key: "storageFiles", titleKey: "settings.item.storageFiles", items: ["storageFiles", "reset"] },
  { key: "about", titleKey: "settings.item.about", items: ["about"] },
] as const;

const MOBILE_COMPONENTS_GOLDEN = {
  profile: "ProfileSection",
  general: "GeneralSection",
  appearance: "AppearanceSection",
  chatStyle: "ChatStyleSection",
  notification: "NotificationSection",
  network: "NetworkSection",
  storageFiles: "StorageSection",
  about: "AboutSection",
  reset: "ResetSection",
} as const;

const DESKTOP_NAV_GOLDEN = [
  { key: "profile", labelKey: "settings.item.profile", iconKey: "user" },
  { key: "general", labelKey: "settings.item.general", iconKey: "sliders" },
  { key: "appearance", labelKey: "settings.item.appearance", iconKey: "palette" },
  { key: "chatStyle", labelKey: "settings.item.chatStyle", iconKey: "bubble" },
  { key: "notifications", labelKey: "settings.item.notification", iconKey: "bell" },
  { key: "network", labelKey: "settings.item.network", iconKey: "wifi" },
  { key: "storageFiles", labelKey: "settings.item.storageFiles", iconKey: "storage" },
  { key: "about", labelKey: "settings.item.about", iconKey: "info" },
  { key: "reset", labelKey: "settings.item.reset", iconKey: "rotate" },
] as const;

const ROUTE_SECTIONS_GOLDEN = [
  "profile",
  "general",
  "notifications",
  "appearance",
  "chatStyle",
  "network",
  "files",
  "storage",
  "storageFiles",
  "security",
  "about",
  "reset",
] as const;

/**
 * 每个路由键在桌面那一栏落到哪一页（`chatStyle` 2026-11-07 起是桌面共用路由；
 * `files/storage/security` 是旧键，落到所属页：storageFiles / about）。
 */
const DEEP_LINK_MATRIX = [
  { routeKey: "profile", routeValid: true, desktop: "profile", mobile: "profile" },
  { routeKey: "general", routeValid: true, desktop: "general", mobile: "general" },
  { routeKey: "notifications", routeValid: true, desktop: "notifications", mobile: "notification" },
  { routeKey: "appearance", routeValid: true, desktop: "appearance", mobile: "appearance" },
  { routeKey: "chatStyle", routeValid: true, desktop: "chatStyle", mobile: "chatStyle" },
  { routeKey: "network", routeValid: true, desktop: "network", mobile: "network" },
  { routeKey: "files", routeValid: true, desktop: "storageFiles", mobile: "storageFiles" },
  { routeKey: "storage", routeValid: true, desktop: "storageFiles", mobile: "storageFiles" },
  { routeKey: "storageFiles", routeValid: true, desktop: "storageFiles", mobile: "storageFiles" },
  { routeKey: "security", routeValid: true, desktop: "about", mobile: "about" },
  { routeKey: "about", routeValid: true, desktop: "about", mobile: "about" },
  { routeKey: "reset", routeValid: true, desktop: "reset", mobile: "reset" },
  { routeKey: "notification", routeValid: false, desktop: "notifications", mobile: "notification" },
] as const;

/** 桌面深链落点：合法路由先按旧键表归位，再交给导航清单。 */
function desktopLanding(routeKey: string): string {
  const res = resolveDesktopRouteKey(routeKey);
  return (DESKTOP_LEGACY_LANDING as Record<string, string>)[res.key] ?? res.key;
}

/** 从源码里切一个以 `};` 收尾的对象块。 */
function sourceBlock(src: string, marker: string, endMarker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `找不到 ${marker}`);
  const endAt = src.indexOf(endMarker, at);
  assert.ok(endAt > at, `找不到 ${marker} 的结束标记 ${endMarker}`);
  return src.slice(at, endAt);
}

/** 移动端壳的分区组件映射（数据清单只管 key，渲染映射仍在外壳里）。 */
function mobileComponentMap(panel: string): Record<string, string> {
  const block = sourceBlock(panel, "const SECTION_COMPONENTS", "\n};");
  const pairs = [...block.matchAll(/\n  (\w+): (\w+),/g)].map((m) => [m[1], m[2]] as const);
  assert.equal(pairs.length, MOBILE_SECTIONS_GOLDEN.length, "SECTION_COMPONENTS 必须覆盖全部移动端分区");
  return Object.fromEntries(pairs);
}

test("设置清单 golden：移动/桌面/路由三份键集、顺序、别名与渲染映射逐项锁定", () => {
  const panel = read("components/SettingsPanel.vue");
  const win = read("components/SettingsWindow.vue");
  const router = read("router/settings.ts");

  assert.deepEqual(
    MOBILE_SECTIONS.map(({ key, titleKey, group }) => ({ key, titleKey, group })),
    MOBILE_SECTIONS_GOLDEN.map((s) => ({ ...s })),
  );
  assert.deepEqual({ ...MOBILE_ALIASES }, { ...MOBILE_ALIASES_GOLDEN });
  assert.deepEqual(
    MOBILE_GROUPS.map((g) => ({ key: g.key, titleKey: g.titleKey, items: [...g.items] })),
    MOBILE_GROUPS_GOLDEN.map((g) => ({ key: g.key, titleKey: g.titleKey, items: [...g.items] })),
  );
  assert.deepEqual(mobileComponentMap(panel), { ...MOBILE_COMPONENTS_GOLDEN });
  assert.deepEqual(
    DESKTOP_NAV.map((n) => ({ key: n.key, labelKey: n.labelKey, iconKey: n.iconKey })),
    DESKTOP_NAV_GOLDEN.map((n) => ({ ...n })),
  );
  assert.deepEqual({ ...DESKTOP_LEGACY_LANDING }, { files: "storageFiles", storage: "storageFiles", security: "about" });
  assert.deepEqual([...ROUTE_SECTIONS], [...ROUTE_SECTIONS_GOLDEN]);

  // 两个外壳真的在消费清单，而不是各自又留一份数组。
  assert.ok(panel.includes('from "@/utils/settingsManifest"'), "SettingsPanel 没接清单");
  assert.ok(panel.includes("MOBILE_SECTIONS"), "SettingsPanel 没消费 MOBILE_SECTIONS");
  assert.ok(panel.includes("MOBILE_GROUPS"), "SettingsPanel 没消费 MOBILE_GROUPS");
  assert.ok(panel.includes("resolveMobileSectionKey"), "SettingsPanel 没消费别名归一");
  assert.ok(win.includes('from "@/utils/settingsManifest"'), "SettingsWindow 没接清单");
  assert.ok(win.includes("DESKTOP_NAV"), "SettingsWindow 没消费 DESKTOP_NAV");
  assert.ok(win.includes("DESKTOP_LEGACY_LANDING"), "SettingsWindow 没消费旧路由落点表");
  assert.ok(win.includes("resolveDesktopRouteKey"), "SettingsWindow 没消费跨端兼容解析");
  assert.ok(router.includes("ROUTE_SECTIONS"), "router/settings.ts 没消费 ROUTE_SECTIONS");
});

test("设置深链矩阵：每个路由键的桌面落点/移动落点/未知键回退与现状一致", () => {
  const panel = read("components/SettingsPanel.vue");
  const win = read("components/SettingsWindow.vue");

  for (const row of DEEP_LINK_MATRIX) {
    assert.equal(
      (ROUTE_SECTIONS as readonly string[]).includes(row.routeKey),
      row.routeValid,
      `路由键 ${row.routeKey} 的合法性变了（期望 ${row.routeValid}）`,
    );
    assert.equal(
      desktopLanding(row.routeKey),
      row.desktop,
      `路由键 ${row.routeKey} 的桌面落点变了（期望 ${row.desktop}）`,
    );
    const resolved = resolveMobileSectionKey(row.routeKey);
    assert.equal(
      resolved.key,
      row.mobile,
      `路由键 ${row.routeKey} 在移动端的落点变了（期望 ${row.mobile}）`,
    );
    assert.equal(
      resolved.fallback,
      false,
      `路由键 ${row.routeKey} 有跨端别名，移动端不应回落到默认分区`,
    );
  }

  // 路由未知键：两个外壳都用解析器给出真实落点 + toast，不再静默归一/退回一级列表。
  assert.ok(win.includes("resolveDesktopRouteKey"), "桌面未知路由键不再走解析器");
  assert.ok(
    win.includes('t("settings.toast.sectionFallback"'),
    "桌面回落没有可理解的提示",
  );
  assert.ok(
    win.includes('router.replace({ name: "settings-section", params: { key: canonical ?? res.key } })'),
    "桌面未知路由键不再 replace 到解析后的落点",
  );
  assert.ok(panel.includes("resolveMobileSectionKey"), "移动端分区不再走解析器");
  assert.ok(
    panel.includes('t("settings.toast.sectionFallback"'),
    "移动端回落没有可理解的提示",
  );
  assert.ok(
    panel.includes('router.replace({ name: "settings-section", params: { key: res.key } })'),
    "移动端未知分区不再归一 URL",
  );
});

test("设置清单完整性反控：每个路由键都落到导航里真实存在的一页，漏映射必须被抓住", () => {
  const navKeys = DESKTOP_NAV.map((n) => n.key) as string[];
  // 这里刻意不走 resolveDesktopRouteKey：未知键会被兜底成 general，检查器就空转了。
  const landingOf = (key: string) =>
    (DESKTOP_LEGACY_LANDING as Record<string, string>)[key] ?? key;
  const missing = ROUTE_SECTIONS.filter((key) => !navKeys.includes(landingOf(key)));
  assert.deepEqual(missing, [], "有路由键没有可渲染的桌面分区");

  // 反控：往合成清单里加一个不存在的 key，同一个检查器必须说 missing。
  const synthetic = [...ROUTE_SECTIONS, "ghost"];
  const syntheticMissing = synthetic.filter((key) => !navKeys.includes(landingOf(key)));
  assert.deepEqual(syntheticMissing, ["ghost"], "漏映射检查器在空集上恒绿");

  assert.equal(resolveDesktopRouteKey("ghost").key, "general");
  assert.ok(navKeys.includes(landingOf("general")));
  assert.equal(normalizeMobileSectionKey("ghost"), "ghost", "未知移动端键被错误归一");
});
