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
 * ② 必须走唯一出口 `captionDoubleClick()`（2026-11-09 起它内部转给后端
 * `window_caption_double_click`，由后端按 macOS 系统偏好分派缩放/最小化/无操作）；
 * ③ 移动端那条早退要留着（那条 caption 不渲染）。
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
    flat.includes("captionDoubleClick()"),
    "双击必须走唯一出口 captionDoubleClick()（能不能最大化由后端白名单判，按什么动作由系统偏好判，都不在这里判）",
  );
  assert.ok(
    flat.includes("props.isMobile"),
    "移动端那条早退要留着：移动端根本不渲染这条 caption，不该把 IPC 打进去",
  );
});

/**
 * 双击与绿灯**不各写一遍**，但也不再是同一个函数（2026-11-09 改口径，不是放宽）：
 *
 * 绿灯是「用户明确点最大化」⇒ 仍然只走 `toggleMaximize()`；
 * 双击是「标题栏手势」⇒ 必须走 `captionDoubleClick()`，由后端按 macOS 系统偏好决定
 * 缩放/最小化/无操作。两条都在组件里，各自只有一个出口；
 * 判据因此钉：双击那条**不许**直接调 `api.windowToggleMaximize`（绕过偏好读取），
 * 也不许再出现自绘红绿灯（会和系统按钮叠一层）。
 */
test("macOS 三颗键交给系统：不许自绘红绿灯，双击与绿灯各只有一个出口", () => {
  const dbl = sliceBracedFn(script, "function onTitlebarDblClick()") ?? "";
  assert.ok(dbl.includes("captionDoubleClick"), "双击那条必须调 captionDoubleClick");
  assert.ok(
    !/api\.windowToggleMaximize/.test(dbl),
    "双击不许绕过后端偏好分派自己调 windowToggleMaximize（macOS 把系统设置改成最小化/无操作就不生效了）",
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
 * ② 早退条件是 `secondPress && dblclickEnabled.value`（不可最大化的窗第二下仍要能拖；
 *    预览窗没有最大化按钮但 `dblclick-maximize` 单独打开，见下一条判据）；
 * ③ 走与 dblclick 同一个出口 `captionDoubleClick()`；④ 这里也不许出现按桌面平台禁用的分支。
 */
test("标题栏按下：第二下必须翻缩放，不许再进 OS 拖拽循环", () => {
  const body = sliceBracedFn(script, "function onDragStart(");
  assert.ok(
    body !== null,
    "TitleBar.vue 里找不到 onDragStart ⇒ 这一格搬家，判据要跟着改口",
  );
  const flat = body!.replace(/\s+/g, "");
  const gateAt = flat.indexOf("if(secondPress&&dblclickEnabled.value)");
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
    flat.includes("captionDoubleClick()"),
    "第二下必须走与 dblclick 同一个出口（能力判断仍由后端白名单判，动作由系统偏好判）",
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
  // 2026-11-07 #29：红绿灯要在自绘标题栏里竖向居中，Rust 的标题栏高度必须等于 CSS token。
  // 反例：把 APP_TITLEBAR_H 改成 52（旧画板值）这条立刻红 —— 两侧差 1px 就会"低半格"。
  const style = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "style.css"),
    "utf8",
  );
  const cssTitleH = Number(style.match(/--gosslan-title-h:\s*(\d+)px/)?.[1]);
  const rustTitleH = Number(rust.match(/APP_TITLEBAR_H: f64 = ([0-9.]+)/)?.[1]);
  assert.ok(cssTitleH > 0, "style.css 里找不到 --gosslan-title-h");
  assert.equal(
    rustTitleH,
    cssTitleH,
    `macos_window.rs 的 APP_TITLEBAR_H=${rustTitleH} 与 --gosslan-title-h=${cssTitleH} 不一致`,
  );
  // 锚点跟着真实签名走：2026-11-07 的 clippy 修复去掉了多余的 `&`（needless_borrow），
  // 调用变成 `center_traffic_lights(ns_window)`。断言强度不变：调用必须存在。
  assert.ok(
    /center_traffic_lights\(ns_window\)/.test(rust),
    "system traffic lights 没有居中调用（#29 的要求）",
  );
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
 * 预览窗标题栏双击必须与主窗口**同一条路**（用户 2026-11-09 实测：「预览窗标题栏双击不变大小」）。
 *
 * 修前是两处各挡一半，任一处没改回都是"还是没反应"：
 * ① 前端：`AuxWindowShell` 只传 `show-maximize=false`，双击处理第一行就被
 *    `if (!props.showMaximize) return;` 早退 ⇒ 预览窗这一格手势根本没接上；
 * ② 后端：`MAXIMIZABLE_WINDOWS` 只有主窗口、预览窗 builder 上写着 `.maximizable(false)`
 *    ⇒ 就算前端调进来也会在白名单处返回 `none`。
 *
 * 现在预览窗：不画最大化按钮（`show-maximize=false` 不变），但 `dblclick-maximize` 单独打开；
 * 后端白名单与 builder 同步放开，动作由 macOS 系统偏好决定（`AppleActionOnDoubleClick`）。
 *
 * 反例自证：删掉 PreviewWindow 上的 `dblclick-maximize` ⇒ 第一条红；
 * 白名单里去掉 `WINDOW_PREVIEW` ⇒ 第二条红；把 builder 改回 `.maximizable(false)` ⇒ 第二条红。
 */
test("预览窗标题栏双击：与主窗口同一条路（前端接线 + 后端白名单 + 系统偏好）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const preview = readFileSync(join(root, "src", "components", "window", "PreviewWindow.vue"), "utf8");
  const shell = readFileSync(join(root, "src", "components", "window", "AuxWindowShell.vue"), "utf8");
  const api = readFileSync(join(root, "src", "api", "index.ts"), "utf8");

  assert.ok(
    /<AuxWindowShell[^>]*\sdblclick-maximize[\s>]/.test(preview),
    "预览窗没打开 `dblclick-maximize` ⇒ 标题栏双击仍在 TitleBar 第一行被 show-maximize 挡掉",
  );
  assert.ok(
    shell.includes(':dblclick-maximize="dblclickMaximize"'),
    "AuxWindowShell 没把 dblclick-maximize 透传给 TitleBar ⇒ 预览窗这一格永远不生效",
  );
  // 双击开关默认仍跟随 show-maximize：其它辅助窗（设置/日志/群任务）不该被这条改动带开。
  //
  // ⚠️ 必须是 `||` 而不是 `??`（2026-11-09 真机读数：`sp=true en=false dt=183`）：
  // Vue 会把**未传**的 Boolean prop 补成 `false`，`??` 只会取到那个 false，
  // 于是主窗口自己的双击被默认值关掉。反例自证：改回 `??` ⇒ 本断言与上一条同时红。
  assert.ok(
    script.includes("const dblclickEnabled = computed(() => props.dblclickMaximize || props.showMaximize)"),
    "双击开关必须默认跟随 show-maximize（否则设置/日志/群任务窗也会去调最大化）；且只能写 `||`",
  );
  assert.ok(
    !script.includes("computed(() => props.dblclickMaximize ??"),
    "`??` 会被 Vue 的 Boolean prop 默认值（未传 ⇒ false）短路，主窗口双击因此永不生效",
  );
  assert.ok(
    api.includes('invoke<string>("window_caption_double_click")'),
    "前端没有 windowCaptionDoubleClick 这层包装（或命令名对不上后端）",
  );

  const lib = readFileSync(join(root, "src-tauri", "src", "lib.rs"), "utf8");
  assert.ok(
    /MAXIMIZABLE_WINDOWS: &\[&str\] = &\[WINDOW_MAIN, WINDOW_PREVIEW, WINDOW_TASKS\]/.test(lib),
    "MAXIMIZABLE_WINDOWS 不含 WINDOW_PREVIEW ⇒ 后端直接把预览窗的双击挡成 no-op",
  );
  assert.ok(
    lib.includes("commands::window_caption_double_click"),
    "命令没进 invoke_handler（前端调了会被拒）",
  );

  const logs = readFileSync(join(root, "src-tauri", "src", "commands", "logs.rs"), "utf8");
  const previewFn = logs.slice(
    logs.indexOf("fn ensure_preview_window"),
    logs.indexOf("fn ensure_log_window"),
  );
  assert.ok(
    previewFn.includes(".maximizable(true)"),
    "预览窗 builder 仍是 maximizable(false) ⇒ 与白名单不自洽（交叉核对测试也会红）",
  );

  const cmd = readFileSync(join(root, "src-tauri", "src", "commands", "window.rs"), "utf8");
  assert.ok(
    cmd.includes("AppleActionOnDoubleClick"),
    "后端没读 macOS 的「双击标题栏」系统偏好 ⇒ 等于硬编码最大化（用户要求跟随系统设置）",
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
