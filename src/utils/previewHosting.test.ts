import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 图片预览的**宿主契约**（用户 2026-09-29 需求汇总第六条：独立窗口调用时隐藏组件内部的关闭按钮、
 * 同一窗口内可以显示；并修「从任务列表进入任务后查看图片可能打不开」）。
 *
 * 为什么是源码形状判据：这几条都住在"谁宿主这份看图器"的接线里，而单测环境没有 WebView
 * （开不了第二扇窗口，也造不出"预览窗口建不出来"那种失败）。形状判据挡的是以后有人把它改回去。
 *
 * ⚠️ 每条取反判据都配了一条正面判据（同一份源码里必须存在什么），否则"把两处一起删掉"也算通过。
 */
const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const LIGHTBOX = read("components/message/ImageLightbox.vue");
const WINDOW = read("components/window/PreviewWindow.vue");
const SHELL = read("layouts/ResponsiveLayout.vue");
const THUMB = read("components/TodoImageThumb.vue");
const STORE = read("stores/useImagePreview.ts");

test("内部那颗 ✕ 由宿主决定画不画（独立窗口不重复、覆盖层仍要画）", () => {
  // 反面：不许再出现"无条件渲染关闭按钮"
  assert.match(LIGHTBOX, /<button\s+v-if="!hideClose"[\s\S]{0,400}?@click\.stop="emit\('close'\)"/);
  assert.equal(
    /<button(?![\s\S]{0,20}v-if)[\s\S]{0,300}?emit\('close'\)/.test(LIGHTBOX.split("<template>")[1]),
    false,
    "看图器里出现了一颗没有开关的关闭按钮 ⇒ 预览窗口又会有两把叉",
  );
  // 正面：两个宿主各自的选择都必须存在
  assert.match(WINDOW, /\n      hide-close/, "独立预览窗口没关内部 ✕ ⇒ 与标题栏那把重复（用户点名的就是这处）");
  assert.equal(SHELL.includes("hide-close"), false, "主窗口那份覆盖层不该关掉 ✕：那是它唯一的可见关闭出口");
});

/**
 * 「点了没反应」的真根因（本轮读出来的，不是猜的）：缩略图与大图是在**两个文档**里各读一次的
 * （主窗口这份 objectURL 缓存 vs 独立预览窗口那份），所以"字节其实取得了、只有这里的读取
 * 还没成功"是一个会稳定出现的状态。旧写法把可点性与 `url` 绑死 ⇒ 那一格点击完全静默。
 */
test("任务缩略图的可点性不再依赖缩略图是否加载成功", () => {
  // 钉的是**契约**（可点性只由 `clickable` 决定），不是某一句字面量：
  // 2026-10-13 这一支改成「先判可点 ⇒ 早退 ⇒ 拦冒泡 ⇒ 才 emit」，因为卡片主体自己也是
  // `role=button`（点图片不许顺路把任务面板也打开）。写法变了，契约没变 ⇒ 判据跟着改形状，
  // 但下面两条负判据（不许读 url）一个字不许松。
  assert.match(THUMB, /if \(!props\.clickable\) return;[\s\S]{0,900}?emit\("open"\);/,
    "open() 不再无条件 emit ⇒ 打不开那条回来了");
  assert.equal(THUMB.includes("props.clickable && url.value"), false, "可点性仍被 url 绑住");
  // 空转前置 + 按函数体切：注释里复述"不看 url"不算数，真的读了才算红
  const openBody = /function open\(e: Event\) \{([\s\S]*?)\n\}/.exec(THUMB)?.[1] ?? "";
  assert.ok(openBody.length > 0, "找不到 open(e) 的函数体 ⇒ 这条判据没有分母");
  assert.equal(/url\.value/.test(openBody), false,
    "open() 又去读 url ⇒ 「字节后到」那一格重新变成点了没反应（2026-09-29 那条事故）");
  // 正面：模板里的 role/tabindex 也得跟着只看 clickable，否则键盘走不到那一下
  assert.match(THUMB, /:role="clickable \? 'button' : undefined"/);
  assert.match(THUMB, /:tabindex="clickable \? 0 : undefined"/);
});

/**
 * 投递被拒时，**没有覆盖层的文档**必须收起状态并说一声。
 *
 * 为什么这不是"体验小改善"而是缺陷：主窗口退回覆盖层就行，而独立群任务窗口根本没有覆盖层
 * （全应用只允许一份 `ImageLightbox`）。留着 `open = true` 的话，任务详情会以为"预览正开着"，
 * 下一次点遮罩只吃掉"关预览" ⇒ 一个从没显示出来的预览把弹窗锁成关不掉。
 */
test("投递被拒：没有覆盖层的文档要收起状态并明确报错", () => {
  assert.match(STORE, /if \(!overlayMounted\.value\) \{\s*\n\s*close\(\);/, "拒绝分支没收起状态 ⇒ 弹窗会被一个看不见的预览锁住");
  assert.match(STORE, /app\.toast\(t\("preview\.unavailable"\), "error"\)/, "拒绝分支没有面向用户的说法");
  assert.match(STORE, /    overlayMounted,/, "标记没导出 ⇒ 宿主设了也没人读得到");
  // 正面：覆盖层的宿主确实把它置真（否则上面那两条永远走"报错"那一支，主窗口反而变成误报）
  assert.match(SHELL, /preview\.overlayMounted = true;/, "ResponsiveLayout 没认领自己是覆盖层宿主");
});

/**
 * 「关闭即隐藏」这半边有一个**只写在依赖源码里**的坑（2026-10-13 从用户日志里那条
 * `window.destroy not allowed. Permissions associated with this command: core:window:allow-destroy`
 * 反查出来的，不是读我们自己代码能看到的）。
 *
 * `@tauri-apps/api` 的包装长这样（现读 `dist/assets/tauri-*.js`，api 2.11.1）：
 *   `this.listen(WINDOW_CLOSE_REQUESTED, async e => { const l = new K(e); await handler(l); l.isPreventDefault() || await this.destroy(); })`
 * ⇒ **handler 不 `preventDefault()` 就等于授权它去销毁窗口**。而 Rust 那侧的
 * `install_hide_on_close` 是 `prevent_close() + hide()`（那条形状判据在 `lib_window_tests.rs`），
 * 这扇预览窗是**常驻、关闭即隐藏**的（第二次看图要秒开）⇒ 它从来就不该被销毁。
 * 眼下能力表里没有 `core:window:allow-destroy`，所以那次调用只落成一条界面 rejection；
 * 但"设计靠一个没批的权限兜住"是隐患：**哪天有人放宽它，常驻窗会连 WebView 一起被销毁**，
 * 秒开没了、还要重新建窗。拦下 `preventDefault()` 是唯一两边都成立、也不动权限表的写法。
 *
 * ⚠️ 口径边界（写清楚，别让下一个人以为这条覆盖了所有形状）：它只解析**内联** handler
 * （`.onCloseRequested(x => { ... })`）。以后若改成具名函数（`.onCloseRequested(onClose)`），
 * 这条会红 —— 那时要么把 `preventDefault()` 写回内联，要么在这里补一次"解析被引用函数体"，
 * 不许直接放宽成"文件里出现过 preventDefault 就行"（那等于没有判据）。
 */
test("注册了 close-requested 的窗口必须 preventDefault（否则库会替它调 destroy）", () => {
  const sites: Array<{ file: string; span: string }> = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(vue|ts)$/.test(ent.name) || ent.name.endsWith(".test.ts")) continue;
      const text = readFileSync(p, "utf8");
      if (!text.includes("onCloseRequested(")) continue;
      // 按括号配对切出这一次调用的整段（定长窗口会跨进邻居，那是假绿/假红的来源）
      let at = -1;
      while ((at = text.indexOf("onCloseRequested(", at + 1)) !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = at + "onCloseRequested".length; i < text.length; i++) {
          if (text[i] === "(") depth++;
          else if (text[i] === ")" && --depth === 0) {
            end = i;
            break;
          }
        }
        assert.ok(end > at, `${p}：onCloseRequested( 的括号没闭合 ⇒ 这条判据没有分母`);
        sites.push({ file: p.slice(ROOT.length + 1), span: text.slice(at, end + 1) });
      }
    }
  };
  walk(ROOT); // src/

  // 阳性对照：扫描必须真找到注册点。0 个的话下面那句循环就是空转，等于没判
  assert.ok(sites.length >= 1, `一处 onCloseRequested 注册都没扫到 ⇒ 判据空转（分母现算 = ${sites.length}）`);
  for (const s of sites) {
    assert.match(
      s.span,
      /preventDefault\s*\(\s*\)/,
      `${s.file}：close-requested 的 handler 没 preventDefault ⇒ 库会在 handler 之后自己调 window.destroy()（用户日志里那条 rejection 就是这么来的；放宽权限那天起还会把常驻窗连 WebView 一起销毁）`,
    );
  }
});
