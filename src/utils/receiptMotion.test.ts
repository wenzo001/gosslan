import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 消息气泡旁的状态图标（发送中 / 已送达 / 已读）动效守门（2026-11-04 用户报告：
 * "状态切换的时候图标会缩一下再弹回来，还会带着气泡抖"）。
 *
 * 真实成因：`MessageReceipt.vue` 用的是 `<Transition name="receipt-swap" mode="out-in">`
 * + `:key="state"` —— 每次状态变化**先摘掉旧节点**（占位宽度塌成 0 ⇒ 气泡左右跳），
 * 再挂一个新节点并重播 `enter-from { opacity: 0; transform: scale(0.55) }`。
 * 修法：状态层常驻叠在固定 16×16 占位里，切换只做透明度交叉淡入；缩放只在
 * 「第一次出现」播一次（`.receipt-slot-appear`，随节点挂载触发）。
 *
 * 这份守门判的是**形状**（换节点重播动画 vs 固定占位里改透明度），不是像素：
 * 把修复删掉换成旧写法，下面每一条都会红。
 */

const vueSrc = readFileSync(new URL("../components/message/MessageReceipt.vue", import.meta.url), "utf8");
const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");

/** 取某个选择器所有规则块的正文（按花括号配对；同名媒体查询在仓库里不止一块）。 */
function ruleBodies(source: string, selector: string): string[] {
  const out: string[] = [];
  let from = 0;
  while (from < source.length) {
    const idx = source.indexOf(selector + " {", from);
    if (idx < 0) break;
    const open = idx + selector.length + 2;
    let depth = 1;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) break;
    out.push(source.slice(open, end));
    from = end + 1;
  }
  return out;
}

function ruleBody(source: string, selector: string): string | null {
  return ruleBodies(source, selector)[0] ?? null;
}

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

/**
 * 把"回执状态图标的动效形状"判成缺陷列表。
 * 正例：真实文件 ⇒ 空；反例：旧写法（Transition + key + enter scale）⇒ 每条都报。
 * 扫描前先剥掉模板里的注释 —— 本文件用注释记录了"旧写法是什么"，那不是仍在生效的代码。
 */
function findReceiptMotionIssues(vueRaw: string, sheet: string): string[] {
  const out: string[] = [];
  const vue = vueRaw.replace(/<!--[\s\S]*?-->/g, "");

  // ① 不许再靠 `<Transition>` + `:key="state"` 换节点：那就是"每次切换重播进场动画"的家。
  if (/<Transition[^>]*name="receipt-swap"/.test(vue) || /receipt-swap-enter/.test(sheet)) {
    out.push("还在用 <Transition name=\"receipt-swap\"> 换节点 ⇒ 每次状态变化都会重播进场动画");
  }
  if (/:key="state"/.test(vue)) {
    out.push("回执节点仍以 :key=\"state\" 重建 ⇒ 旧节点被摘掉，占位宽度塌成 0，气泡会跳");
  }

  // ② 五个状态层必须常驻、叠在同一个固定占位里（没有节点重建 = 没有第二次 enter）。
  const layers = Array.from(vue.matchAll(/data-receipt-state="([^"]+)"/g), (m) => m[1]);
  for (const want of ["sending-waiting", "sending", "sent", "delivered", "read"]) {
    if (!layers.includes(want)) out.push(`缺状态层 data-receipt-state="${want}"（状态层必须常驻，不能按 state 换节点）`);
  }
  const slot = /class="receipt-slot[^"]*"/.exec(vue);
  if (!slot) out.push("找不到固定占位的 .receipt-slot");
  else if (!/\bh-4\b/.test(slot[0]) || !/\bw-4\b/.test(slot[0])) {
    out.push("占位没有固定 16×16（h-4 w-4）⇒ 发送中(14px)→已送达(16px) 切换时宽度会变");
  }

  // ③ 状态切换只许改透明度：层的过渡里出现 transform/scale 就是在"缩放跳动"。
  const layer = ruleBody(sheet, ".receipt-layer");
  if (!layer) out.push("style.css 缺 .receipt-layer 规则");
  else {
    if (/transform|scale\(/.test(layer)) out.push(".receipt-layer 的过渡里带了缩放 ⇒ 切换时仍会缩一下");
    if (!/transition:\s*opacity/.test(layer)) out.push(".receipt-layer 没有只做透明度的 transition ⇒ 切换会硬切");
  }

  // ④ 基础占位不许自挂动画：动画必须在 `.receipt-slot-appear`（只随挂载播一次）。
  const baseSlot = ruleBody(sheet, ".receipt-slot");
  if (!baseSlot) out.push("style.css 缺 .receipt-slot 规则");
  else if (/animation|transform|scale\(/.test(baseSlot)) {
    out.push(".receipt-slot 自带动画/缩放 ⇒ 状态变化也会重播（动画只能挂在 .receipt-slot-appear）");
  }
  if (!/\.receipt-slot-appear\s*\{[^}]*animation/.test(sheet)) {
    out.push("缺 .receipt-slot-appear 的一次性出现动画");
  }

  // ⑤ 减弱动态效果：只留淡入淡出，不许缩放（缩放写在淡入之外就报）。
  const reducedBlocks = ruleBodies(sheet, REDUCED_MOTION);
  if (reducedBlocks.length === 0) out.push("style.css 缺 prefers-reduced-motion 的降级块");
  else if (!reducedBlocks.some((b) => /\.receipt-slot-appear\s*\{[^}]*animation:\s*gosslan-receipt-fade/.test(b))) {
    out.push("减弱动态效果下 .receipt-slot-appear 没用无缩放的 gosslan-receipt-fade");
  }
  const fadeBodies = ruleBodies(sheet, "@keyframes gosslan-receipt-fade");
  if (fadeBodies.length === 0) out.push("缺 gosslan-receipt-fade 关键帧（减弱动态效果下的纯淡入）");
  else if (fadeBodies.some((b) => /transform|scale\(/.test(b))) {
    out.push("gosslan-receipt-fade 里还有缩放 ⇒ 减弱动态效果下仍会缩");
  }

  return out;
}

test("真实文件：回执状态图标的状态切换不重建节点、不重播缩放（0 条）", () => {
  assert.deepEqual(findReceiptMotionIssues(vueSrc, css), []);
});

// 反例自证：删掉修复换回旧写法 ⇒ 每条判据都必须真的红（不是空转的绿）。
test("反例自证：旧的 Transition + :key=\"state\" + enter scale 写法必须全部报红", () => {
  const oldVue = `<span class="relative flex items-center" role="img">
  <Transition name="receipt-swap" mode="out-in">
    <span :key="state" class="relative flex items-center">
      <Check v-if="state === 'sent'" class="h-3.5 w-3.5" />
    </span>
  </Transition>
</span>`;
  const oldCss = `.receipt-swap-enter-active,
.receipt-swap-leave-active {
  transition: opacity 120ms var(--gosslan-ease), transform 200ms var(--gosslan-ease-spring);
}
.receipt-swap-enter-from {
  opacity: 0;
  transform: scale(0.55);
}`;
  const issues = findReceiptMotionIssues(oldVue, oldCss).join("\n");
  assert.match(issues, /Transition name="receipt-swap"/, issues);
  assert.match(issues, /:key="state"/, issues);
  assert.match(issues, /缺状态层/, issues);
  assert.match(issues, /找不到固定占位/, issues);
  assert.match(issues, /缺 \.receipt-layer 规则/, issues);
});
