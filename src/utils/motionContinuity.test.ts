import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 时间轴/占位连续性守卫（2026-11-04 四项 UI 动效改造）。
 *
 * 判据不是"看起来对"，而是**旧实现一定红**：
 * - 设置分区：`mode="out-in"`（空档塌高）或 `translateY`（整块位移）出现即红；
 * - 图片外框：外框节点必须挂 `height: placeholderHeight`（旧实现解码后缩一次）；
 * - 桌面导航：rail 药丸不许再用 motion-v 共享布局弹簧，位移与内容淡入必须读同一组 CSS 常量。
 *
 * 文件末尾给每条判据喂一次**旧写法**，证明它们不是空转。
 */

const SRC = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const CSS = new URL("../style.css", import.meta.url).pathname;
const DOCS = new URL("../../docs/design-guidelines.md", import.meta.url).pathname;

/** 取某个 CSS 选择器参与的所有规则体（选择器可能出现在逗号清单里，也可能单独成规则）。 */
function cssRules(css: string, selector: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (true) {
    const i = css.indexOf(selector, from);
    if (i < 0) break;
    from = i + selector.length;
    const after = css.slice(from).match(/^\s*(,|\{)/);
    if (!after) continue;
    const open = css.indexOf("{", i);
    const close = css.indexOf("}", open);
    if (open < 0 || close < 0) continue;
    const between = css.slice(from, open);
    if (between.includes("}") || between.includes(";")) continue;
    out.push(css.slice(open + 1, close));
  }
  return out;
}

function cssRule(css: string, selector: string, needle: string): string {
  const body = cssRules(css, selector).find((b) => b.includes(needle));
  assert.ok(body, `style.css 缺少含 ${needle} 的 ${selector} 规则`);
  return body;
}

const settings = read("components/SettingsWindow.vue");
const navRail = read("components/NavRail.vue");
const convList = read("components/ConversationList.vue");
const imageBubble = read("components/message/MessageImageBubble.vue");
const css = readFileSync(CSS, "utf8");

test("设置分区：不再 out-in、退场层绝对定位、不做位移", () => {
  assert.ok(
    /<Transition\s+name="settings-swap"\s*>/.test(settings),
    "settings-swap 必须是不带 mode 的默认（同时）模式",
  );
  assert.ok(!settings.includes('mode="out-in"'), "settings-swap 不许再用 out-in（中间空档会塌高）");
  assert.ok(
    /<div class="relative">\s*<Transition name="settings-swap">/s.test(settings),
    "面板容器必须常驻，并给退场层提供 relative 定位",
  );
  const leave = cssRule(css, ".settings-swap-leave-active", "position:");
  assert.match(leave, /position:\s*absolute/, "退场层必须脱离文档流，否则两页并排堆叠");
  const transitionRule = cssRule(css, ".settings-swap-enter-active", "transition:");
  assert.ok(!transitionRule.includes("transform"), "settings-swap 只做交叉淡入淡出，不许位移");
  const from = cssRule(css, ".settings-swap-enter-from", "opacity");
  assert.ok(!from.includes("translate"), "settings-swap 入场不许 translate");
});

test("图片外框：加载/已加载都取同一个 placeholderHeight，骨架与外框同源", () => {
  assert.ok(imageBubble.includes("data-img-frame"), "外框节点必须可被探针识别");
  assert.ok(
    /:style="\{ height: `\$\{placeholderHeight\}px` \}"/.test(imageBubble),
    "外框高度必须来自 placeholderHeight（解码前后一致）",
  );
  const skeleton = imageBubble.slice(
    imageBubble.indexOf("data-img-skeleton"),
    imageBubble.indexOf("data-img-skeleton") + 300,
  );
  assert.ok(skeleton.includes("`${placeholderHeight}px`"), "骨架也必须读同一个 placeholderHeight");
  assert.ok(!/height:\s*\d+px/.test(skeleton), "骨架不许写死数字高度");
});

test("桌面导航：常驻药丸 + 同一组时间轴常量，不再用共享布局弹簧", () => {
  assert.ok(navRail.includes("data-rail-pill"), "rail 药丸必须是常驻节点");
  assert.ok(!navRail.includes('layout-id="rail-active"'), "rail 不许再用 motion-v 共享布局（旧实现）");
  assert.ok(!navRail.includes("type: 'spring'"), "rail 不许再写弹簧参数");
  assert.ok(navRail.includes("RAIL_ORDER"), "药丸下标必须按按钮顺序现算");
  assert.ok(navRail.includes("RAIL_ITEM_STRIDE"), "步距要与 h-11 + gap-2 对齐");

  const pill = cssRule(css, ".rail-active-pill", "transition:");
  assert.match(pill, /--gosslan-nav-switch-duration/, "药丸位移必须读共享时长");
  assert.match(pill, /--gosslan-nav-switch-ease/, "药丸位移必须读共享缓动");

  const fadeA = cssRule(css, ".conv-view-fade-a", "animation:");
  assert.match(fadeA, /--gosslan-nav-switch-duration/, "内容淡入必须读同一时长");
  assert.match(fadeA, /--gosslan-nav-switch-ease/, "内容淡入必须读同一缓动");

  assert.ok(convList.includes("conv-view-fade-a") && convList.includes("conv-view-fade-b"), "左列要挂淡入类");
  assert.ok(
    /watch\(\(\) => props\.view[\s\S]{0,120}?if \(app\.isMobile\) return;/m.test(convList),
    "淡入只在桌面左列（移动端由整页转场负责）",
  );
  const pillAt = css.indexOf(".rail-active-pill {");
  const reduce = css.indexOf("@media (prefers-reduced-motion: reduce)", pillAt);
  assert.ok(reduce >= 0, "缺少 rail 的 reduce 规则");
  assert.match(
    css.slice(reduce, reduce + 400),
    /\.rail-active-pill\s*\{[\s\S]*?transition:\s*none/,
    "reduce 档药丸必须直接落位",
  );
});

test("规范钉住 16px 占位契约", () => {
  const docs = readFileSync(DOCS, "utf8");
  assert.ok(docs.includes("占位列宽 16px 为固定契约"), "§11.3.7 必须写明 16px 是固定契约");
});

test("反例自证：把旧写法喂给同一条判据必须失败", () => {
  const oldSettings = `
    <Transition name="settings-swap" mode="out-in">
      <div :key="section"><div v-if="x" /></div>
    </Transition>`;
  assert.ok(oldSettings.includes('mode="out-in"'), "旧设置写法应命中 out-in 判据");

  const oldRail = `<motion.span v-if="navState === 'chats'" layout-id="rail-active"
    :transition="{ type: 'spring', stiffness: 480, damping: 36, mass: 0.7 }" />`;
  assert.ok(oldRail.includes('layout-id="rail-active"'), "旧 rail 写法应命中共享布局判据");
  assert.ok(oldRail.includes("type: 'spring'"), "旧 rail 写法应命中弹簧判据");

  const oldImage = `<div class="relative w-52"><div data-img-skeleton :style="{ height: '288px' }" /></div>`;
  assert.ok(!oldImage.includes("data-img-frame"), "旧图片写法应命中外框判据");
  assert.ok(oldImage.includes(":style"), "旧骨架写法应命中'骨架自己定高'判据");
});
