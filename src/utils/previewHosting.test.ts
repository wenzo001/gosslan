import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 图片预览的**宿主契约**。
 *
 * 2026-11-05 用户拍板 B：桌面端不再开独立预览窗口，改成与移动端**同一套应用内覆盖层**
 * （同一 `ImageLightbox`、同一 FLIP、同一 `useImagePreviewStore` 契约）。
 * 于是这份判据要守三件事：
 * 1. 关闭按钮**只有一颗**，且 ✕/Esc/遮罩三条出口都必须先播回缩（不许出现绕过 requestClose 的出口）；
 * 2. 每个会点图文档都挂了覆盖层（主窗口 `ResponsiveLayout` + 群任务窗口 `GroupTodosWindow`）；
 * 3. 旧窗口路径**删干净且不许复活** —— 这条就是"删无用代码"的守卫（反面自证：让
 *    `openImagePreview` 回来，下面那条会点名报红）。
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

test("关闭按钮只有一颗，且三条出口都先播回缩再收场", () => {
  // 正面：✕ 必须在。
  assert.match(
    LIGHTBOX,
    /<button[\s\S]{0,500}?@click\.stop="requestClose"/,
    "✕ 没接回 requestClose ⇒ 这条关闭路径会跳过收场回缩",
  );
  // 反面：不许再出现"由宿主决定画不画"的 hideClose（那是独立窗口时代的形状）。
  assert.equal(
    /hideClose/.test(LIGHTBOX),
    false,
    "看图器里又出现 hideClose ⇒ 有人把'独立预览窗口'那套宿主分支装回来了",
  );
  // 反面：模板里不许有绕过 requestClose 的 `emit('close')` —— 遮罩/Esc/✕ 三条路都必须
  // 先播完回缩再收窗，否则"点遮罩"和"点 ✕"的观感会分叉。
  assert.equal(
    LIGHTBOX.split("<template>")[1].includes("emit('close')"),
    false,
    "模板里还有直接 emit('close') 的出口 ⇒ 那条路关掉时不播回缩",
  );
});

test("两个会点图的文档都挂了覆盖层，且数据都来自 store", () => {
  for (const [name, src] of [
    ["ResponsiveLayout.vue", SHELL],
    ["GroupTodosWindow.vue", TASKS_WINDOW],
  ]) {
    assert.match(src, /const preview = useImagePreviewStore\(\)/, `${name} 没挂 store`);
    assert.match(src, /<ImageLightbox/, `${name} 没有覆盖层 ⇒ 这个文档里点图没反应`);
    assert.match(src, /:open="preview\.open"/, `${name} 的覆盖层没接 store 的 open`);
    assert.match(src, /@close="preview\.close\(\)"/, `${name} 的覆盖层没接关闭`);
  }
  // store 侧契约：打开时记下来源缩略图矩形（FLIP 的起点），关闭时清空。
  assert.match(STORE, /origin\.value = takeImageOrigin\(\)/, "打开时没记缩略图矩形 ⇒ 桌面没有 FLIP");
});

/**
 * 「点了没反应」的真根因（2026-09-29 读出来的，不是猜的）：缩略图与大图是在**两个文档**里
 * 各读一次的（主窗口这份 objectURL 缓存 vs 独立的预览文档那份），所以"字节其实取得了、
 * 只有这里的读取还没成功"是一个会稳定出现的状态。旧写法把可点性与 `url` 绑死 ⇒ 那一格点击
 * 完全静默。现在覆盖层就在同一份文档里，这条仍然要守：可点性只由 `clickable` 决定。
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
 * 「删干净」守卫：独立预览窗口那条路已经彻底作废（用户 2026-11-05「不许留死代码」）。
 *
 * 反面自证：把 `openImagePreview`（或 `open_image_preview` / `window_tween` /
 * `PreviewWindow.vue` / `preview.html`）任意一处装回来 ⇒ 下面第一条点名报红。
 * 正面：覆盖层路径必须在（否则"把两条路都删了"也算通过）。
 */
test("独立预览窗口路径不许复活（删除清单是判据，不是注释）", () => {
  const needles = [
    "openImagePreview",
    "getImagePreviewGallery",
    "onImagePreviewChanged",
    "preview-gallery",
    "windowAnimated",
    "window_tween",
    "PreviewWindow.vue",
    "preview.html",
    "open_image_preview",
    "get_image_preview_gallery",
  ];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(vue|ts|mjs|json|html|rs)$/.test(ent.name) || ent.name.endsWith(".test.ts")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of needles) {
        if (text.includes(n)) offenders.push(`${p.slice(ROOT.length + 1)} ← ${n}`);
      }
    }
  };
  walk(ROOT);
  walk(join(ROOT, "..", "src-tauri", "src"));
  assert.deepEqual(
    offenders,
    [],
    `独立预览窗口的残留：\n${offenders.join("\n")}`,
  );
  // 正面分母：覆盖层与 store 必须在，否则上面这条"全删了也绿"。
  assert.ok(existsSync(join(ROOT, "components/message/ImageLightbox.vue")));
  assert.ok(existsSync(join(ROOT, "stores/useImagePreview.ts")));
});
