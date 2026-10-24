import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 窗口控制按钮的**字形与行为**守卫。
 *
 * 历史：0e07dd4 删了 `Maximize2/Minimize2` 的 import 而 Windows 分支仍在用 ⇒
 * 整颗「最大化/还原」按钮渲染为空（不报错、不影响构建，只有这条守卫能拦）。
 * 2026-09-17 起字形改为按 **Win11 Fluent** 自绘的细线 SVG（`data-win-glyph` 标记），
 * 守卫随之重定位：盯"三个字形 + 最大化真的调后端命令"，不再盯 lucide import。
 */
const src = readFileSync(join(import.meta.dirname, "..", "components", "TitleBar.vue"), "utf8");
const scriptEnd = src.indexOf("</script>");
const script = src.slice(0, scriptEnd);
const template = src.slice(scriptEnd);

test("Win11 细线字形都在（最小化/最大化/还原按钮不为空）", () => {
  for (const glyph of ["minimize", "maximize", "restore"]) {
    assert.ok(
      template.includes(`data-win-glyph="${glyph}"`),
      `TitleBar 模板应包含 ${glyph} 字形（缺了 = 该按钮渲染为空）`,
    );
  }
});

test("最大化切换必须真的调后端命令（否则按钮只是装饰）", () => {
  // 模板走 `toggleMaximize()` 包装函数，命令调用在 script 里
  assert.ok(script.includes("api.windowToggleMaximize"), "最大化按钮必须（经包装函数）调 windowToggleMaximize");
  assert.ok(template.includes("toggleMaximize"), "模板必须把最大化按钮接到 toggleMaximize");
  assert.ok(script.includes("api.windowIsMaximized"), "切图标需要 is_maximized（还原/最大化两态）");
  // 最小化/关闭直接在模板上调命令（两个平台分支各一处）
  assert.ok(template.includes("api.windowMinimize"), "最小化按钮必须调 windowMinimize");
  assert.ok(template.includes("api.windowClose"), "关闭按钮必须调 windowClose");
});

/**
 * 最大化/全屏状态必须**跟窗口同步刷新**。
 *
 * 真实缺陷（用户 2026-10-12）：「点了最大化 / 全屏，按钮图标不变成还原的样子」。
 * 根因：`refreshMaximized()` 只在 `onMounted` 里问一次，之后按钮是用户点的、
 * 状态天天在变，不订阅就一直是初始字形——方法成功失败都看不出来。
 * 前端 go green 的另一半在 `src-tauri/src/commands/window.rs`：那里原先用
 * `is_maximizable()` 当判据，而它在 macOS Borderless 窗上**恒 false**
 * （tao 0.35.3 `platform_impl/macos/window.rs:216-222` 无 Titled 位 ⇒ 无 zoom button
 * ⇒ `is_maximizable()` 取不到 button 返回 false），于是命令整条早退**什么都没做**。
 * 两侧都修才有反应：Rust 换成显式白名单，前端订阅 `onResized` 刷字形。
 *
 * 这条守卫两个断言分别钉住两侧的接线：订阅函数必须在，且两个刷新函数都要在
 * onMounted/onResized 两条路径上被真正调到。
 */
test("最大化状态必须订阅窗口尺寸变化（否则图标永远是初始字形）", () => {
  assert.ok(
    script.includes("onResized"),
    "TitleBar 必须订阅 onResized —— 只在 onMounted 问一次，用户点了按钮图标也不会变",
  );
  assert.ok(
    script.includes("refreshMaximized()"),
    "refreshMaximized 必须存在且被调用（缺 = 字形永远不刷新）",
  );
  // 2026-10-23：macOS 三颗键改回系统原生（含全屏/缩放），组件不再维护自绘的全屏态 ——
  // 这里反向钉住「别再把它加回来」，否则会出现一份没人点亮的状态。
  assert.ok(
    !script.includes("refreshFullscreen"),
    "macOS 交给系统后不该再维护自绘全屏态（refreshFullscreen 应已删除）",
  );
  // onMounted 与 onResized 两条路径都要刷（只刷挂载 = 用户点了没反应；只刷事件 = 首帧错）
  assert.ok(
    /onMounted\(\(\) => \{[\s\S]*?refreshMaximized\(\);/.test(script),
    "onMounted 里要刷一次 maximized（首帧）",
  );
  assert.ok(
    /onResized\(\(\) => \{[\s\S]*?refreshMaximized\(\);/.test(script),
    "onResized 回调里要刷 maximized（用户拖角/跨屏/进出全屏）",
  );
  // 退订必须成对出现（漏退订 = 组件反复挂载后监听器堆积）。
  // ⚠️ 2026-10-20 换了形状：卸载函数不再存局部变量，而是登记进 `utils/initScope` 的 scope ——
  // 旧写法有一条真实漏口：`listen()` 要等一次 IPC 往返才拿到卸载函数，卸载若发生在往返途中，
  // 那次赋值就发生在 `onBeforeUnmount` **之后**，那份取消函数永远没人调用（监听真的留下了）。
  // 所以两条都要在：注册进 scope ＋ 卸载时拆 scope（少任一条都拦不住堆积）。
  assert.ok(
    /listenerScope\.onDispose\(\s*await w\.onResized\(/.test(script),
    "onResized 的卸载函数必须登记进 initScope（不登记 = 迟到的注册永远没人取消）",
  );
  assert.ok(
    /onBeforeUnmount\(\(\) => \{[\s\S]*?listenerScope\.dispose\(\);/.test(script),
    "onBeforeUnmount 必须拆掉 initScope（漏 dispose = 组件反复挂载后监听器堆积）",
  );
});

/**
 * 双击标题栏**不许按平台早退**（用户 2026-10-14 真机：「Mac 双击能放大缩小，Windows 不行」）。
 *
 * 根因不是环境问题，是这一格里少了一条通路：旧写法 `if (…|| !isMac || …) return;` 把非 macOS
 * 的双击整条关掉，而注释声称"Windows 由 tao 的拖拽区原生处理"—— 三条证据说明那句是假的：
 * `data-tauri-drag-region` 全仓只出现在注释里（模板没写过这个属性）、tao 0.35.3 没有
 * `WM_NCLBUTTONDBLCLK` 处理、本应用所有窗口 `decorations:false`（Windows 上没有系统标题栏可双击）。
 *
 * 判据钉三件事，缺一就红：① 处理器里不许出现任何按桌面平台禁用的分支（`isMac` / `isWindows`）；
 * ② 必须走与绿灯同一个后端出口 `toggleMaximize()`；③ 移动端那条早退要留着（那条 caption 不渲染）。
 * ⚠️ 按**花括号配对**切函数体，不用定长窗口：窗口跨进邻居函数就会误判（本仓踩过那一族）。
 */
test("标题栏双击不许按平台早退：Windows 也必须能最大化", () => {
  const body = sliceBracedFn(script, "function onTitlebarDblClick()");
  assert.ok(body !== null, "TitleBar.vue 里找不到 onTitlebarDblClick ⇒ 这一格搬家，判据要跟着改口");
  const flat = body!.replace(/\s+/g, "");
  for (const banned of ["isMac", "isWindows", "isLinux"]) {
    assert.ok(
      !flat.includes(banned),
      `双击处理器里出现 ${banned}：又把某个桌面平台的双击关掉了（Windows 双击没反应就是这么来的）`,
    );
  }
  assert.ok(
    flat.includes("toggleMaximize()"),
    "双击必须走与绿灯同一个出口 toggleMaximize()（能不能最大化由后端白名单判，不在这里按平台判）",
  );
  assert.ok(
    flat.includes("props.isMobile"),
    "移动端那条早退要留着：移动端根本不渲染这条 caption，不该把 IPC 打进去",
  );
});

/**
 * 双击与绿灯**必须是同一个出口**（一个判据失真会同时打死两个入口，看起来像两个缺陷 ——
 * 上一轮 `is_maximizable()` 那次就是这个形状）。这里钉的是"不许各写一遍"。
 *
 * 2026-10-23：macOS 三颗键改回**系统原生**（后端 `macos_window::use_native_titlebar`），
 * 组件里的自绘红绿灯与 `onGreenClick` 一起删掉。判据随之改口径（不是放宽）：
 *   · 仍然钉"自定义缩放出口不许绕过 `toggleMaximize()`"（双击那条）；
 *   · 反向：组件里**不许**再出现自绘红绿灯（否则会和系统按钮叠一层）；
 *   · 正向：必须给系统三颗键让出宽度，否则标题会压在红绿灯下面。
 */
test("macOS 三颗键交给系统：不许自绘红绿灯，自定义缩放仍只走一个包装函数", () => {
  const dbl = sliceBracedFn(script, "function onTitlebarDblClick()") ?? "";
  assert.ok(dbl.includes("toggleMaximize"), "双击那条必须调 toggleMaximize");
  assert.ok(
    !/api\.windowToggleMaximize/.test(dbl),
    "双击不许绕过包装函数自己调命令（包装函数负责刷字形与吞错）",
  );
  assert.ok(!/function onGreenClick/.test(script), "绿灯处理器又回来了 —— macOS 应交给系统");
  assert.ok(!/group\/traffic/.test(template), "自绘红绿灯又回来了 —— 会和系统按钮叠一层");
  assert.ok(
    !/bg-\[#(ff5f57|febc2e|28c840)\]/.test(template),
    "自绘红绿灯配色又回来了（系统按钮不需要这些类）",
  );
  assert.ok(
    /w-\[78px\]/.test(template),
    "必须给系统三颗键让出 78px 占位，否则标题内容会压在红绿灯下面",
  );
});

/**
 * 双击的第二下**不许再起一次 OS 拖拽**（评审 2026-10-14：这一格只接 `dblclick` 是不够的）。
 *
 * caption 的 `mousedown` 会调 `startDragging()`；tao 在 Windows 上把它落成
 * `ReleaseCapture()` + `WM_NCLBUTTONDOWN/HTCAPTION` ⇒ 主线程进 Win32 的**模态移动循环**，
 * 那一次 `mouseup` 由系统消费掉。WebView 收不到 up 就合成不出 click，`dblclick` 永不派发
 * —— 于是"删掉 `!isMac` 早退"这一改在 Windows 上可能是**死代码**（Mac 照旧，因为那边 up 收得到）。
 *
 * 所以缩放必须有一条**只看 `mousedown` 时刻差**的通路。判据钉四件事，缺一就红：
 * ① 第二下的早退必须排在 `startDragging(` **之前**（顺序错了等于没拦）；
 * ② 早退条件是 `secondPress && props.showMaximize`（不可最大化的窗第二下仍要能拖）；
 * ③ 走与绿灯/双击同一个出口 `toggleMaximize()`；④ 这里也不许出现按桌面平台禁用的分支。
 */
test("标题栏按下：第二下必须翻缩放，不许再进 OS 拖拽循环", () => {
  const body = sliceBracedFn(script, "function onDragStart(");
  assert.ok(
    body !== null,
    "TitleBar.vue 里找不到 onDragStart ⇒ 这一格搬家，判据要跟着改口",
  );
  const flat = body!.replace(/\s+/g, "");
  const gateAt = flat.indexOf("if(secondPress&&props.showMaximize)");
  const dragAt = flat.indexOf("startDragging(");
  assert.ok(dragAt >= 0, "拖拽本体不许删：caption 唯一的拖动通路就是这里");
  assert.ok(
    gateAt >= 0,
    "第二下的早退不见了（第二下也去起拖拽 ⇒ Windows 上那个模态循环会把 mouseup 吞掉，双击就没反应）",
  );
  assert.ok(
    gateAt < dragAt,
    "早退必须排在 startDragging 之前 —— 排在后面等于这一按已经进过模态循环了",
  );
  assert.ok(
    flat.includes("toggleMaximize()"),
    "第二下必须走与绿灯/双击同一个缩放出口（能力判断仍由后端白名单判）",
  );
  for (const banned of ["isMac", "isWindows", "isLinux"]) {
    assert.ok(
      !flat.includes(banned),
      `按下处理器里出现 ${banned}：又是"按桌面平台把一条通路关掉"那个形状`,
    );
  }
});

/**
 * 一次双击**只能翻一次**（`dblclick` 与"第二下"两条通路并存时必须去重）。
 *
 * 翻两下 = 放大又还原，界面上看就是"双击了没反应"，与原本报的缺陷长得一模一样 ——
 * 而这条只有 macOS 会撞到（那边 `dblclick` 真的会派发），所以去重必须写死在判据里。
 */
test("双击的两条缩放通路必须去重", () => {
  const dbl = (sliceBracedFn(script, "function onTitlebarDblClick()") ?? "").replace(/\s+/g, "");
  assert.ok(
    dbl.includes("captionJustToggledByPress()"),
    "dblclick 通路必须先问「第二下是不是刚翻过」，否则 Mac 上一次双击翻两下",
  );
  const drag = (sliceBracedFn(script, "function onDragStart(") ?? "").replace(/\s+/g, "");
  assert.ok(
    drag.includes("lastCaptionToggleAt="),
    "第二下翻缩放时必须记下时刻，去重才有依据（只有一边写、另一边读的话这条判据会假绿）",
  );
});

/**
 * macOS 窄窗口：系统原生红绿灯必须跟着前端布局档一起收起。
 *
 * 真实反馈（用户 2026-10-24）：「Mac 上把窗口缩成移动端，左上角怎么还有三大金刚键」。
 * `decorations:false` 后三颗键是 AppKit 画的，`v-if="!isMobile"` 只管自绘 caption；
 * 阈值只能有一份（`platform.ts::resolveMobileLayout`），所以前端按 `isMobile` 调命令，
 * Rust 只负责 `setHidden`。
 */
test("macOS 窄窗口：系统红绿灯由 isMobile 驱动收起/恢复", () => {
  assert.ok(script.includes("api.setNativeTitlebarButtonsHidden"), "前端没有调用收起命令");
  assert.ok(
    /watch\(\s*\(\) => props\.isMobile,[\s\S]{0,260}?setNativeTitlebarButtonsHidden/.test(script),
    "收起命令必须挂在 isMobile 的 watch 上（不能另立一个宽度阈值）",
  );
  const rust = readFileSync(
    join(import.meta.dirname, "..", "..", "src-tauri", "src", "macos_window.rs"),
    "utf8",
  );
  assert.ok(rust.includes("pub fn set_traffic_lights_hidden"), "Rust 没有实现收起系统三键");
  const cmds = readFileSync(
    join(import.meta.dirname, "..", "..", "src-tauri", "src", "commands", "window.rs"),
    "utf8",
  );
  assert.ok(cmds.includes("set_native_titlebar_buttons_hidden"), "命令没有实现");
  const lib = readFileSync(
    join(import.meta.dirname, "..", "..", "src-tauri", "src", "lib.rs"),
    "utf8",
  );
  assert.ok(
    lib.includes("commands::set_native_titlebar_buttons_hidden"),
    "命令没有进 invoke_handler（前端调了也会被拒）",
  );
});

/**
 * macOS 打包必须声明本地化，否则系统控件文案（红绿灯的「关闭 / 最小化 / 进入全屏」、
 * 系统菜单）会回落成英文 —— 用户 2026-10-24：「软件是中文的，全屏按钮的悬停提示却是英文」。
 * 这一条同时钉住 `Info.plist` 的两个键与两份 `InfoPlist.strings` 的打包映射。
 */
test("macOS 打包声明本地化：系统控件文案跟着 App 语言", () => {
  const root = join(import.meta.dirname, "..", "..", "src-tauri");
  const plist = readFileSync(join(root, "Info.plist"), "utf8");
  assert.match(
    plist,
    /<key>CFBundleDevelopmentRegion<\/key>\s*<string>zh-Hans<\/string>/,
    "Info.plist 缺 CFBundleDevelopmentRegion=zh-Hans",
  );
  assert.match(
    plist,
    /<key>CFBundleLocalizations<\/key>\s*<array>[\s\S]{0,160}?zh-Hans[\s\S]{0,160}?en/,
    "Info.plist 缺 CFBundleLocalizations（或没有 zh-Hans / en）",
  );
  const conf = JSON.parse(readFileSync(join(root, "tauri.conf.json"), "utf8"));
  const files = conf.bundle?.macOS?.files ?? {};
  assert.ok(
    "Resources/zh-Hans.lproj/InfoPlist.strings" in files,
    "中文 InfoPlist.strings 没有被打包",
  );
  assert.ok(
    "Resources/en.lproj/InfoPlist.strings" in files,
    "英文 InfoPlist.strings 没有被打包",
  );
});

/**
 * 按花括号配对切出一个函数体（从签名之后的第一个 `{` 到与之配对的 `}`）。
 * 找不到签名或括号不闭合返回 null —— 让调用方把"判据失去落点"报成红，而不是静默跳过。
 */
function sliceBracedFn(src: string, sig: string): string | null {
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}
