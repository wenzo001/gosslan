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
const tailVueSrc = readFileSync(new URL("../components/message/BubbleTail.vue", import.meta.url), "utf8");

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

/**
 * 尾巴与气泡「只允许一个背景层」守门（2026-11-05 用户第三次报接缝）。
 *
 * 判据是**结构**：皮肤模式下整块「气泡 + 叶形」只能由一条闭合路径填充一次。
 * 出现第二个填充路径 / 第二个几何块 / 尾巴子树自带 background / 底栏又填一层，
 * 都会重新长出一条与主轮廓独立的边 —— 那正是"半透明接缝"复发的方式。
 *
 * 反例自证在同一节末尾：喂一份"两个 tail-fill + 尾巴子树自挂 background"的旧写法，
 * 每条都要报出来（否则检查只是在空转）。
 */
function findTailFillIssues(vueRaw: string, sheet: string): string[] {
  const out: string[] = [];
  const vue = vueRaw.replace(/<!--[\s\S]*?-->/g, "");

  const svgs = Array.from(vue.matchAll(/<svg[\s\S]*?<\/svg>/g), (m) => m[0]);
  // 找不到两个分支（旧叶形 + 皮肤）⇒ 等于守卫没在看任何东西，先判红。
  if (svgs.length < 2) out.push("找不到皮肤分支：BubbleTail 必须同时保留旧叶形与单填充分支");
  for (const svg of svgs) {
    const fills = Array.from(svg.matchAll(/<path[^>]*class="tail-fill"/g)).length;
    if (fills !== 1) out.push(`某个尾巴分支里有 ${fills} 个 tail-fill 填充层（必须恰好 1 个）`);
    if (/<(?:rect|circle|ellipse)\b/.test(svg)) {
      out.push("尾巴子树里出现了第二个几何填充块（rect/circle/ellipse）");
    }
    if (/\bstyle="[^"]*(?:background|fill)"| \bfill="[^"]+"/.test(svg)) {
      out.push("尾巴子树里出现了内联背景/第二份填充色 ⇒ 第二块背景");
    }
  }

  // 皮肤必须真的由 `bubbleSkinPath` 生成（否则"单路径"只是注释）。
  if (!/v-if="skinD && box"[\s\S]{0,500}class="tail-fill" :d="skinD"/.test(vue)) {
    out.push("皮肤分支没有用 bubbleSkinPath 生成的单条路径（`class=\"tail-fill\" :d=\"skinD\"`）");
  }

  // 样式表：尾巴子树自己不许带 background（会变成第二个独立填充块）。
  // 先剥注释 —— 本文件用注释记录了"旧实现里有几层"，那不是仍在生效的声明。
  const bareSheet = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of Array.from(bareSheet.matchAll(/\.(?:bubble-tail|tail-[a-z-]+)[^;{}]*\{[^}]*\}/g), (m) => m[0])) {
    if (/background(?!-clip)/.test(rule)) out.push(`尾巴规则里自带 background ⇒ 第二块背景：${rule.trim()}`);
  }

  // 皮肤模式下：气泡自己的面收进 1px；底栏不再填第二层。
  if (
    !/\[data-bubble-skin\] > \[data-msg-bubble\] > :first-child\s*\{[^}]*background-clip:\s*padding-box\s*!important/.test(
      sheet,
    )
  ) {
    out.push("气泡自己的背景没有收进 padding-box ⇒ 外沿仍是两条边（皮肤 + 气泡背景）");
  }
  if (
    !/\[data-bubble-skin\] > \[data-reaction-strip\]\s*\{[^}]*background:\s*transparent\s*!important/.test(sheet)
  ) {
    out.push("回应底栏在皮肤模式下仍自带背景 ⇒ 整块底部还有第二个背景层");
  }

  return out;
}

test("真实文件：尾巴子树只有一个填充层（0 条）", () => {
  assert.deepEqual(findTailFillIssues(tailVueSrc, css), []);
});

test("反例自证：两个 tail-fill + 尾巴自挂 background + 底栏未让位 ⇒ 必须全部报红", () => {
  const doubleVue = `<span class="bubble-tail">
  <svg viewBox="0 0 14 14">
    <path class="tail-fill" d="M10.5 4C10.5 7 6 10.5 2 13.5L13.5 13.5L13.5 4Z" />
    <path class="tail-fill" d="M0 0L14 0L14 14L0 14Z" />
  </svg>
  <svg viewBox="0 0 14 14"><path class="tail-fill" d="M0 0Z" /></svg>
</span>`;
  const twoLayerCss = `.bubble-tail .tail-extra {
  background: var(--bubble-bg);
}
.msg-shell[data-bubble-skin] > [data-reaction-strip] {
  opacity: 0.4;
}`;
  const issues = findTailFillIssues(doubleVue, twoLayerCss).join("\n");
  assert.match(issues, /2 个 tail-fill 填充层/, issues);
  assert.match(issues, /尾巴规则里自带 background/, issues);
  assert.match(issues, /回应底栏在皮肤模式下仍自带背景/, issues);
  assert.match(issues, /没有用 bubbleSkinPath 生成的单条路径/, issues);
});
