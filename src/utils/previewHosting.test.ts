import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 图片预览的**宿主契约**（用户 2026-11-06 改回独立窗口后的版本）。
 *
 * 这一版要守六件事：
 * 1. **桌面走独立窗口、移动走覆盖层**：每个会点图的文档都挂覆盖层，但 `:open` 必须让位给
 *    `inWindow`；移动端那条分支必须有（没有多窗口能力）。
 * 2. **全局单例**：固定 label + `ensure_preview_window` 先查后建；命令里**不许**内联
 *    `WebviewWindowBuilder`（那正是"每点一次多一扇窗"的形状）。反例自证：把 builder 搬回命令体，
 *    下面点名报红。
 * 3. **不许恢复窗口补间**：`set_outer_position` / `window_tween` / `PREVIEW_WINDOW_TWEEN`
 *    一律不得出现（实测非原子、`skew_reads=1`，2026-11-05 已否决）。
 * 4. **换图不留残影**：窗口收到 `preview-gallery` 必须走 `replace`（清空旧图），不是 `begin`
 *    （`begin` 会留着上一张）。反例：改回 `pull()` 报红。
 * 5. **移动端手势不穿透**：覆盖层根必须有 `touchAction: 'none'` + `overscrollBehavior: 'contain'`，
 *    且**不许**去改 `document.body.style.overflow`（全局锁最容易漏恢复）。
 * 6. **生命周期双向同步**（B1）：销毁要回声 `preview-closed` ⇒ 各文档只清状态；
 *    `close()` 在 `inWindow` 为真时必须真的关窗（只清本地状态关不掉另一个 WebView）。
 *
 * ⚠️ 每条取反判据都配一条正面判据（同一份源码里必须存在什么），否则"把两处一起删掉"也算通过。
 */
const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const LIGHTBOX = read("components/message/ImageLightbox.vue");
const SHELL = read("layouts/ResponsiveLayout.vue");
const TASKS_WINDOW = read("components/GroupTodosWindow.vue");
const THUMB = read("components/TodoImageThumb.vue");
const STORE = read("stores/useImagePreview.ts");
const PREVIEW_WINDOW = read("components/window/PreviewWindow.vue");
const TODO_DIALOG = read("components/TodoDetailDialog.vue");
const TASKS_BOARD = read("components/GroupTasksBoard.vue");
const RUST_LOGS = readFileSync(join(ROOT, "..", "src-tauri", "src", "commands", "logs.rs"), "utf8");
const RUST_LIB = readFileSync(join(ROOT, "..", "src-tauri", "src", "lib.rs"), "utf8");
const RUST_STATE = readFileSync(join(ROOT, "..", "src-tauri", "src", "state.rs"), "utf8");
const API = read("api/index.ts");
const RUST_WINDOW_CMD = readFileSync(
  join(ROOT, "..", "src-tauri", "src", "commands", "window.rs"),
  "utf8",
);

test("关闭按钮只有一颗，且三条出口都先播回缩再收场", () => {
  // 正面：✕ 必须在，且接回 requestClose。
  assert.match(
    LIGHTBOX,
    /<button[\s\S]{0,500}?@click\.stop="requestClose"/,
    "✕ 没接回 requestClose ⇒ 这条关闭路径会跳过收场回缩",
  );
  // hideClose 只有独立预览窗口用（它有自己的标题栏 ✕）。除此之外不许有第二个宿主分支。
  assert.match(LIGHTBOX, /hideClose\?: boolean/, "hideClose prop 不见了 ⇒ 预览窗口会多出一颗 ✕");
  assert.match(PREVIEW_WINDOW, /<ImageLightbox[\s\S]{0,400}?hide-close/, "预览窗口没用 hide-close");
  // 反面：模板里不许有绕过 requestClose 的 `emit('close')` —— 遮罩/Esc/✕ 三条路都必须
  // 先播完回缩再收窗，否则"点遮罩"和"点 ✕"的观感会分叉。
  assert.equal(
    LIGHTBOX.split("<template>")[1].includes("emit('close')"),
    false,
    "模板里还有直接 emit('close') 的出口 ⇒ 那条路关掉时不播回缩",
  );
});

test("两个会点图的文档都挂了覆盖层，且窗口宿主时让位", () => {
  for (const [name, src] of [
    ["ResponsiveLayout.vue", SHELL],
    ["GroupTodosWindow.vue", TASKS_WINDOW],
  ]) {
    assert.match(src, /const preview = useImagePreviewStore\(\)/, `${name} 没挂 store`);
    assert.match(src, /<ImageLightbox/, `${name} 没有覆盖层 ⇒ 这个文档里点图没反应`);
    // 桌面端交给独立窗口显示 ⇒ 覆盖层必须让位（否则同一张图画两份）。
    assert.match(
      src,
      /:open="preview\.open && !preview\.inWindow"/,
      `${name} 的覆盖层没让位给独立窗口 ⇒ 桌面上会叠出两份`,
    );
    assert.match(src, /@close="preview\.close\(\)"/, `${name} 的覆盖层没接关闭`);
    // 本文档挂了覆盖层 ⇒ 必须登记，独立窗口投递失败时才接得住。
    assert.match(src, /preview\.overlayMounted = true/, `${name} 没登记 overlayMounted`);
    assert.match(src, /preview\.overlayMounted = false/, `${name} 卸载时没清 overlayMounted`);
  }
  // store 侧契约：打开时记下来源缩略图矩形（覆盖层 FLIP 的起点），关闭时清空。
  assert.match(STORE, /origin\.value = takeImageOrigin\(\)/, "打开时没记缩略图矩形 ⇒ 覆盖层没有 FLIP");
});

test("桌面/移动分支：移动端继续走覆盖层，桌面走窗口", () => {
  const branch = /if \(app\.isMobile \|\| !deliverableToWindow\(items\)\) \{[\s\S]{0,120}?inWindow\.value = false;[\s\S]{0,120}?return;/.exec(
    STORE,
  );
  assert.ok(branch, "找不到「移动端 / 不可投递 ⇒ 覆盖层」分支 ⇒ 手机上会去开不存在的窗口");
  assert.match(STORE, /deliverableToWindow\s*\(\s*items\s*\)/, "可投递性判据不见了");
  assert.match(STORE, /api\s*\n?\s*\.openImagePreview/, "桌面端没投递给独立窗口");
  // 降级必须两条：窗口建不出来时有覆盖层就退回，没覆盖层的文档（群任务窗）必须收起状态。
  assert.match(STORE, /if \(!overlayMounted\.value\) close\(\);/, "没有覆盖层时没收起 open ⇒ 会锁住弹窗");
});

/**
 * 单例：`open_image_preview` 是**命令**，它只能调 `ensure_preview_window`；
 * 里面出现 builder 就是"每次点击新建一扇窗"的形状。
 *
 * 反例自证：把 `WebviewWindowBuilder::new` 那几行挪进 `open_image_preview` 的函数体 ⇒ 第二条断言点名报红。
 */
test("单例：预览命令先查后建，不许内联 builder", () => {
  const openBody = /pub fn open_image_preview\(\s*app: tauri::AppHandle[\s\S]{0,4000}?\n\}\n/.exec(RUST_LOGS)?.[0] ?? "";
  assert.ok(openBody.length > 0, "找不到桌面端 open_image_preview 的函数体 ⇒ 这条判据没有分母");
  assert.match(openBody, /validate_preview\(&gallery\)/, "预览投递没校验形状/上限");
  assert.match(openBody, /ensure_preview_window\(\s*&app/, "没走单例入口 ⇒ 每点一次都会新建一扇窗");
  assert.equal(
    openBody.includes("WebviewWindowBuilder"),
    false,
    "命令体里内联了 WebviewWindowBuilder ⇒ 每点一次就会多一扇预览窗（单例失效）",
  );
  // 正面分母：单例实现里必须真的查存在（`ensure_aux_window` 的快路径 + 锁内复查）。
  assert.match(RUST_LOGS, /fn ensure_preview_window\([\s\S]{0,1400}?ensure_aux_window\(/, "没有 ensure_preview_window");
  assert.match(RUST_LOGS, /fn ensure_aux_window<[\s\S]{0,900}?show_existing_aux_window\(/, "ensure_aux_window 没先走「已存在就复用」");
  assert.match(RUST_LOGS, /fn show_existing_aux_window\([\s\S]{0,900}?get_webview_window\(label\)/, "复用路径没查窗口是否存在");
  assert.match(RUST_LIB, /pub const WINDOW_PREVIEW: &str = "preview";/, "窗口 label 不是固定值 preview");
  assert.match(RUST_LIB, /WINDOW_LABELS: &\[&str\] = &[[\s\S]{0,200}?WINDOW_PREVIEW/, "预览窗口没进 WINDOW_LABELS");
});

/**
 * 「窗口补间」在 2026-11-05 实测否决过（`set_outer_position` / `set_inner_size` 非原子，
 * `skew_reads=1`）。恢复窗口时最容易被顺手带回来，所以钉死"一个字都不许有"。
 */
test("不许恢复预览窗口补间", () => {
  for (const [name, text] of [
    ["commands/logs.rs", RUST_LOGS],
    ["lib.rs", RUST_LIB],
    ["PreviewWindow.vue", PREVIEW_WINDOW],
  ]) {
    for (const needle of ["window_tween", "PREVIEW_WINDOW_TWEEN", "set_outer_position", "set_inner_size"]) {
      assert.equal(text.includes(needle), false, `${name} 里又出现了 \`${needle}\`（补间已否决）`);
    }
  }
});

/**
 * 换图无缝：复用窗口时收到事件必须 `replace`（清空旧图 ⇒ loading 占位），
 * 不是 `begin`（`begin` 会保留上一张，用户就会看到旧图残影）。
 */
test("换图走 replace（清空旧图）而不是 begin", () => {
  assert.match(
    PREVIEW_WINDOW,
    /onImagePreviewChanged\(\(\) => void pull\(true\)\)/,
    "事件换图没用 replace ⇒ 复用时会先闪一下上一张",
  );
  const reducer = read("utils/previewGalleryState.ts");
  assert.match(reducer, /case "replace":[\s\S]{0,300}?return \{ \.\.\.INITIAL_PREVIEW_VIEW \};/,
    "reducer 的 replace 没清空旧相册");
  // 正面分母：首次挂载仍要保留 begin（新建窗口没有旧内容，begin 的语义没变）。
  assert.match(PREVIEW_WINDOW, /void pull\(\);/, "首次挂载没取相册");
});

/**
 * 移动端顶层 + 手势（用户 2026-11-06："要在顶层。别点了滑动 是下面在滑，上面不滑"）。
 *
 * 探针（`--only=mobileoverlay`）负责实测 `elementFromPoint` 与 `scrollTop` 不变；
 * 这里守的是"那些实测靠的东西还在"，否则探针会因为源码被改而变成查空气。
 */
test("移动端覆盖层：顶层 + 手势不穿透 + 不用全局锁", () => {
  // 顶层：overlay 必须 Teleport 到 body（不受父级 overflow/transform/z-index 上下文影响）。
  assert.match(LIGHTBOX, /<Teleport to="body">/, "覆盖层没 Teleport 到 body ⇒ 会被父级层叠上下文困住");
  assert.match(LIGHTBOX, /fixed inset-x-0 bottom-0 top-\[var\(--gosslan-safe-top,0px\)\] z-\[80\]/,
    "覆盖层不再是全屏 fixed");
  // 手势：两层都必须在（缺一层就有穿透通道）。
  assert.match(LIGHTBOX, /touchAction: 'none'/, "没有 touch-action: none ⇒ 拖动会滚到底下列表");
  assert.match(LIGHTBOX, /overscrollBehavior: 'contain'/, "没有 overscroll-behavior: contain ⇒ 越界滚动链会传给 body");
  // 反面：全局锁（body overflow）不许复活 —— 那是"关闭后要记得恢复"的坑。
  assert.equal(
    LIGHTBOX.includes("body.style.overflow") || LIGHTBOX.includes("document.body.style"),
    false,
    "覆盖层去改 document.body 样式 ⇒ 关闭后可能留下全局锁",
  );
});

/**
 * 「点了没反应」的真根因（2026-09-29 读出来的，不是猜的）：缩略图与大图是在**两个文档**里
 * 各读一次的（主窗口这份 objectURL 缓存 vs 独立的预览文档那份），所以"字节其实取得了、
 * 只有这里的读取还没成功"是一个会稳定出现的状态。旧写法把可点性与 `url` 绑死 ⇒ 那一格点击
 * 完全静默。现在覆盖层就在同一份文档里，这条仍然要守：可点性只由 `clickable` 决定。
 */
test("任务缩略图的可点性不再依赖缩略图是否加载成功", () => {
  assert.match(THUMB, /if \(!props\.clickable\) return;[\s\S]{0,900}?emit\("open"\);/,
    "open() 不再无条件 emit ⇒ 打不开那条回来了");
  assert.equal(THUMB.includes("props.clickable && url.value"), false, "可点性仍被 url 绑住");
  const openBody = /function open\(e: Event\) \{([\s\S]*?)\n\}/.exec(THUMB)?.[1] ?? "";
  assert.ok(openBody.length > 0, "找不到 open(e) 的函数体 ⇒ 这条判据没有分母");
  assert.equal(/url\.value/.test(openBody), false,
    "open() 又去读 url ⇒ 「字节后到」那一格重新变成点了没反应（2026-09-29 那条事故）");
  assert.match(THUMB, /:role="clickable \? 'button' : undefined"/);
  assert.match(THUMB, /:tabindex="clickable \? 0 : undefined"/);
});

test("恢复的预览窗口文件确实存在（正面分母）", () => {
  assert.ok(existsSync(join(ROOT, "..", "preview.html")), "preview.html 缺失 ⇒ 独立窗口打不开");
  for (const rel of ["entries/preview.ts", "components/window/PreviewWindow.vue", "utils/previewGalleryState.ts"]) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 缺失 ⇒ 独立窗口打不开`);
  }
});

/**
 * 双击手势（2026-11-09）：**只做全屏切换**，不再缩放。
 *
 * 用户口径：「双击那个查看图片的窗口可以全屏切换」+「双击只用于最大化/全屏切换，不加第二个
 * 含义」。缩放仍在滚轮 / − / % / + / 适应（以及移动端双指）上。
 *
 * 退出全屏由平台还原窗口 frame ⇒ 回到双击前的尺寸（不需要我们自己 `set_inner_size`，
 * 那条补间 2026-11-05 已否决）。
 *
 * 反例自证：把模板改回 `@dblclick="reset()"` ⇒ 第一条断言点名报红。
 */
test("双击只切换全屏，不再缩放", () => {
  assert.match(LIGHTBOX, /@dblclick="toggleFullscreen"/, "双击没接全屏切换");
  assert.equal(
    LIGHTBOX.includes('@dblclick="reset()"'),
    false,
    "双击又变回缩放了（一个手势两个含义）",
  );
  assert.match(LIGHTBOX, /api\.windowToggleFullscreen\(\)/, "双击没调窗口全屏命令（不是 CSS 伪全屏）");
  assert.match(
    API,
    /windowToggleFullscreen: \(\) => invoke<boolean>\("window_toggle_fullscreen"\)/,
    "api 没暴露 windowToggleFullscreen",
  );
  assert.match(
    RUST_WINDOW_CMD,
    /pub fn window_toggle_fullscreen\(window: tauri::WebviewWindow\)[\s\S]{0,400}?set_fullscreen/,
    "Rust 没有真正的全屏切换命令体",
  );
  assert.match(RUST_LIB, /commands::window_toggle_fullscreen,/, "全屏命令没注册进 invoke_handler");
  // 缩放的其余途径必须都还在（否则"删掉双击缩放"就真的少了放大入口）。
  assert.match(LIGHTBOX, /@wheel="onWheel"/, "滚轮缩放不见了");
  assert.match(LIGHTBOX, /@click\.stop="zoomBy\(-0\.2\)"/, "减号按钮不见了");
  assert.match(LIGHTBOX, /@click\.stop="zoomBy\(0\.2\)"/, "加号按钮不见了");
  assert.match(LIGHTBOX, /@click\.stop="reset\(\)"/, "「适应」按钮不见了");
  // Esc 与关闭按钮口径不变：仍走 requestClose（只加手势，不改关闭语义）。
  assert.match(LIGHTBOX, /@click\.stop="requestClose"/, "✕ 不再走 requestClose");
  assert.match(
    LIGHTBOX,
    /if \(e\.key === "Escape"\) \{\s*requestClose\(\);/,
    "Esc 不再走 requestClose",
  );
});

/**
 * **B1：关窗 → 状态不回收**（2026-11-06 发布前审查）。
 *
 * 预览窗是"关闭即销毁"（`AUX_PREVIEW_RESIDENT = false`），所以 `Destroyed` 是它
 * 唯一会发出的"我没了"。没有这条回声时，用户点 ✕ 之后 store 里 `open`/`inWindow`
 * 仍是 `true`：下一次点遮罩会被 `preview.open && source 匹配` 吃掉，弹窗要按两次。
 *
 * 反例自证（本轮真跑过）：删掉 `ensure_preview_window` 里那段 `on_window_event`
 * ⇒ 第一条断言点名报红（事件名 / 目标一个都对不上）。
 */
test("预览窗销毁要回声 preview-closed，且只发给 store 清状态", () => {
  assert.match(
    RUST_STATE,
    /pub const EVENT_PREVIEW_CLOSED: &str = "preview-closed";/,
    "没有 preview-closed 这个事件名 ⇒ 前端订阅的是一段永远不会来的信号",
  );
  // 只在创建时挂（复用会累积监听 ⇒ 销毁一次广播 N 次），且事件必须真的从 Destroyed 转出来。
  assert.match(
    RUST_LOGS,
    /if created \{[\s\S]{0,900}?win\.on_window_event\([\s\S]{0,300}?WindowEvent::Destroyed[\s\S]{0,300}?emit\(EVENT_PREVIEW_CLOSED/,
    "预览窗没有把 `WindowEvent::Destroyed` 转成 `preview-closed` ⇒ 用户关窗后主窗口状态永远收不回来",
  );
  // 广播（不是只发 main）：群任务窗口也挂了同一份 store。
  assert.match(
    RUST_LOGS,
    /app\.emit\(EVENT_PREVIEW_CLOSED/,
    "回声只定向发 main ⇒ 群任务窗口里的预览状态照样残留（同样是「要按两次」）",
  );
  // 前端：订阅存在，且回调只交给 resetState（不自己发关窗 IPC，否则是关→回声→关的回环）。
  assert.match(
    API,
    /onImagePreviewClosed: \(cb: \(\) => void\) => listen\("preview-closed"/,
    "api 没有订阅 preview-closed ⇒ 回声没人接",
  );
  assert.match(
    STORE,
    /\.onImagePreviewClosed\(\(\) => resetState\(\)\)/,
    "store 没订阅预览窗销毁回声 ⇒ 关窗后 open/inWindow 一直留着",
  );
  const reset = /function resetState\(\) \{([\s\S]*?)\n  \}/.exec(STORE)?.[1] ?? "";
  assert.ok(reset.length > 0, "找不到 resetState() 的函数体 ⇒ 这条判据没有分母");
  assert.equal(
    reset.includes("closeImagePreview"),
    false,
    "回声回调里又调了关窗 IPC ⇒ 关 → 回声 → 关 的回环（而且第二次关的是已经不存在的窗）",
  );
});

/**
 * **B1：状态回收 → 关不掉真窗口**（另一个方向）。
 *
 * `close()` 以前只清本文档的 Pinia；预览内容在**另一个 WebView** ⇒ 切会话
 * （`closeIfFrom(conv:prev)`）之后窗里仍挂着上一个会话的图。
 *
 * 反例自证（本轮真跑过）：删掉 `close()` 里的 `api.closeImagePreview()` 调用
 * ⇒ 第二条断言点名报红。
 */
test("close() 在 inWindow 为真时必须真的关窗", () => {
  const body = /function close\(\) \{([\s\S]*?)\n  \}/.exec(STORE)?.[1] ?? "";
  assert.ok(body.length > 0, "找不到 close() 的函数体 ⇒ 这条判据没有分母");
  // 必须先记下再清：`inWindow` 清掉之后就没法判断那扇窗还在不在了。
  assert.match(
    body,
    /const wasInWindow = inWindow\.value;/,
    "close() 没先记住「这次内容归窗口显示」⇒ 后面的关窗分支判断的是已经清掉的值",
  );
  assert.match(body, /if \(wasInWindow\)/, "close() 没有「在窗口里显示才关窗」的分支");
  assert.match(
    body,
    /api\s*\n?\s*\.closeImagePreview\(\)/,
    "close() 只清本地状态、没有关窗 IPC ⇒ 切会话后预览窗还显示上一个会话的图",
  );
  // Rust 侧：桌面实现 + 移动桩 + 注册（generate_handler 无条件列，移动端少了桩就编译不过）。
  assert.match(
    RUST_LOGS,
    /pub fn close_image_preview\(app: tauri::AppHandle\)[\s\S]{0,400}?get_webview_window\(crate::WINDOW_PREVIEW\)[\s\S]{0,120}?\.close\(\)/,
    "Rust 没有真正关闭 preview 窗口的命令体",
  );
  assert.match(
    RUST_LOGS,
    /#\[cfg\(mobile\)\]\s*#\[tauri::command\]\s*pub fn close_image_preview/,
    "缺少移动端桩 ⇒ generate_handler 在移动端编译不过",
  );
  assert.match(RUST_LIB, /commands::close_image_preview,/, "命令没注册进 invoke_handler ⇒ 前端调不到");
  assert.match(
    API,
    /closeImagePreview: \(\) => invoke<void>\("close_image_preview"\)/,
    "api 没暴露 closeImagePreview",
  );
});

/**
 * **B1 的用户可见结局**：关窗回声把 `open` 收回来之后，**第一次**点遮罩就该关弹窗。
 *
 * 两个弹窗的"吃掉这次关闭"判据都是 `preview.open && source 匹配`；只要 `resetState`
 * 真的把 `open` 置回 false，`onDialogClose` / `closeDraft` 下一次就会走到 `emit("close")`
 * / `draft.value = null` 那一支 —— 不会再有"按两次"。
 */
test("关窗回收状态后，第一次点遮罩关的是弹窗", () => {
  const reset = /function resetState\(\) \{([\s\S]*?)\n  \}/.exec(STORE)?.[1] ?? "";
  assert.ok(reset.length > 0, "找不到 resetState() 的函数体 ⇒ 这条判据没有分母");
  for (const line of ["open.value = false;", "source.value = null;", "inWindow.value = false;"]) {
    assert.ok(reset.includes(line), `resetState 没清 ${line} ⇒ 弹窗会继续以为预览还开着`);
  }
  assert.match(
    TODO_DIALOG,
    /preview\.open && sourceKey\.value !== null && preview\.source === sourceKey\.value/,
    "任务详情的「这次关闭归预览」判据变了 ⇒ 下面那条推导不再成立",
  );
  const onClose = /function onDialogClose\(\) \{([\s\S]*?)\n\}/.exec(TODO_DIALOG)?.[1] ?? "";
  assert.ok(onClose.length > 0, "找不到 onDialogClose() 的函数体 ⇒ 这条判据没有分母");
  assert.match(
    onClose,
    /if \(previewIsMine\.value\) \{[\s\S]{0,80}?preview\.close\(\);[\s\S]{0,80}?return;[\s\S]{0,120}?emit\("close"\)/,
    "预览不再是「我这份」时没有落到 emit(\"close\") ⇒ 第一次点遮罩仍然关不掉弹窗",
  );
  assert.match(
    TASKS_BOARD,
    /preview\.open && draftSource\.value !== null && preview\.source === draftSource\.value/,
    "草稿表单的「这次关闭归预览」判据变了 ⇒ 下面那条推导不再成立",
  );
  const closeDraft = /function closeDraft\(\) \{([\s\S]*?)\n\}/.exec(TASKS_BOARD)?.[1] ?? "";
  assert.ok(closeDraft.length > 0, "找不到 closeDraft() 的函数体 ⇒ 这条判据没有分母");
  assert.match(
    closeDraft,
    /if \(draftPreviewOpen\.value\) \{[\s\S]{0,80}?preview\.close\(\);[\s\S]{0,80}?return;[\s\S]{0,80}?draft\.value = null;/,
    "预览不再是「这份草稿」时没有落到 draft.value = null ⇒ 第一次点遮罩仍然关不掉表单",
  );
});
