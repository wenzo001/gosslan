import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 动效规范的可执行判据（规格：docs/design-language/motion-system.md）。
 *
 * 这里只扫 `src/style.css`：它是全站动效的**唯一**声明面（组件只挂类名 / 读令牌）。
 * 三条硬约束各自带反例，反例不通过就等于判据在空转：
 *   ① 时长只能取阶梯令牌，不许再写裸毫秒；
 *   ② 带缩放的入场必须声明来源锚点（`@motion-origin`），且 `scale(0)` 一律禁止；
 *   ③ `prefers-reduced-motion` 只许去动效，不许把状态本身藏掉。
 */
const CSS = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");

const LADDER = [
  "--gosslan-duration-instant",
  "--gosslan-duration-fast",
  "--gosslan-duration-fade",
  "--gosslan-duration",
  "--gosslan-duration-exit",
  "--gosslan-duration-slow",
  "--gosslan-duration-exit-fast",
];

/** 物理过程本身就有的节奏，不是"档"：ambient 漂移、spinner 常转。 */
const PHYSICAL = [/ambient-drift-[abc]\s+\d+(?:\.\d+)?s/, /gosslan-spin\s+\d+(?:\.\d+)?s\s+linear\s+infinite/];

/** 从 `head` 开始的花括号块（支持嵌套），返回块内文本。 */
export function braceBlocks(css: string, head: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(head.source, head.flags.includes("g") ? head.flags : `${head.flags}g`);
  while ((m = re.exec(css))) {
    const start = css.indexOf("{", m.index + m[0].length);
    if (start < 0) continue;
    let depth = 1;
    let i = start + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(start + 1, i - 1));
  }
  return out;
}

/** ① 裸毫秒扫描：animation / transition 行里除令牌与物理节奏外不许出现数字时长。 */
export function rawDurationProblems(css: string): string[] {
  const bad: string[] = [];
  for (const line of css.split("\n")) {
    if (!/\b(animation|transition|transition-duration|animation-duration)\b/.test(line)) continue;
    if (/^\s*\/[/*]/.test(line)) continue;
    let probe = line;
    for (const re of PHYSICAL) probe = probe.replace(re, "");
    probe = probe.replace(/-\d+(?:\.\d+)?s\b/g, ""); // ambient 的负延迟不是时长
    // var(...) 里的值不算裸毫秒；0s / 0.01ms 是"没有动效"，放行。
    probe = probe.replace(/var\([^)]*\)/g, "");
    if (/\b0(?:\.0+)?m?s\b|0\.01ms/.test(probe)) continue;
    const hit = probe.match(/\b\d+(?:\.\d+)?m?s\b/);
    if (hit) bad.push(`${hit[0]} @ ${line.trim()}`);
  }
  return bad;
}

/** ② 缩放入场必须带锚点：`@keyframes` 若从 <1 的 scale 入场，正上方必须有 `@motion-origin` 标记。 */
export function scaleOriginProblems(css: string): string[] {
  const bad: string[] = [];
  if (/scale\(\s*0\s*\)/.test(css)) bad.push("出现 scale(0)：无尺寸的起点不可见，等于凭空出现");

  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = m[1];
    const start = m.index + m[0].length - 1;
    let depth = 1;
    let i = start + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(start + 1, i - 1);
    const fromScale = body.match(/scale\(\s*(0?\.\d+)\s*\)/);
    if (!fromScale) continue; // 只做位移/淡入的 keyframes 不需要来源锚点
    const before = css.slice(Math.max(0, m.index - 160), m.index);
    if (!/@motion-origin:\s*\S+/.test(before)) {
      bad.push(`${name} 有缩放入场却没有 @motion-origin 锚点`);
    }
  }
  return bad;
}

/** ③ reduce 档只许去动效，不许把状态藏掉（display:none / opacity:0 / visibility:hidden）。 */
export function reducedMotionProblems(css: string): string[] {
  const bad: string[] = [];
  const blocks = braceBlocks(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  if (blocks.length === 0) bad.push("整份 CSS 没有 reduce 降级块");

  const global = blocks.find((b) => /animation-duration:\s*0\.01ms\s*!important/.test(b));
  if (!global) bad.push("缺少全局 reduce 收尾（animation/transition 时长收到 0.01ms）");

  // 有状态的浮层：reduce 下必须 animation:none（最终态由元素默认样式给出），
  // 不许用 opacity:0 / visibility:hidden 把"状态"本身抹掉。
  const stateful = /(gosslan-dialog-(overlay|card|page|sheet)|gosslan-toast|gosslan-menu|receipt-layer)/;
  for (const raw of blocks) {
    // reduce 块里可以**定义**不含 transform 的替身 keyframes（如 receipt-fade），
    // 那不是"把状态藏掉"；判"可见性"时先把嵌套的 @keyframes 整段摘掉。
    const b = raw.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    if (stateful.test(b) && /opacity\s*:\s*0/.test(b)) {
      bad.push("reduce 块把有状态浮层设成 opacity:0 ⇒ 状态不可见");
    }
    if (/visibility\s*:\s*hidden/.test(b)) {
      bad.push("reduce 块出现 visibility:hidden ⇒ 状态被藏掉");
    }
    const hides = [...b.matchAll(/([^{}]+)\{[^{}]*display\s*:\s*none/g)];
    for (const [, sel] of hides) {
      if (!/press-ripple|ambient/.test(sel)) {
        bad.push(`reduce 块把 ${sel.trim()} 设成 display:none ⇒ 只该去动效，不该去内容`);
      }
    }
  }
  return bad;
}

test("动效阶梯令牌齐全（只允许这几档）", () => {
  for (const token of LADDER) assert.match(CSS, new RegExp(`${token}:`), `缺少 ${token}`);
  assert.match(CSS, /html\.is-mobile\s*\{[\s\S]*?--gosslan-duration:\s*280ms/, "移动档必须与桌面分档");
});

test("① style.css 的 animation / transition 不再写裸毫秒", () => {
  assert.deepEqual(rawDurationProblems(CSS), []);
});

test("① 反例自证：塞一条 300ms 的入场必须红", () => {
  const broken = `${CSS}\n.rogue { animation: rogue-in 300ms var(--gosslan-ease); }\n`;
  assert.match(rawDurationProblems(broken).join("\n"), /300ms/, "裸毫秒没被检出 ⇒ 判据在空转");
});

test("② 每个缩放入场都带来源锚点", () => {
  assert.deepEqual(scaleOriginProblems(CSS), []);
});

test("② 反例自证：删掉锚点 / 写 scale(0) 都必须红", () => {
  const noAnchor = CSS.replace("/* @motion-origin: 50% 100% —— 卡片从下方升起，回程落回下方 */\n", "");
  assert.notEqual(noAnchor, CSS, "fixture 没替换成功");
  assert.match(scaleOriginProblems(noAnchor).join("\n"), /gosslan-dialog-pop-in/);

  const zero = CSS.replace("scale(0.96)", "scale(0)");
  assert.notEqual(zero, CSS, "fixture 没替换成功");
  assert.match(scaleOriginProblems(zero).join("\n"), /scale\(0\)/);
});

test("③ reduce 档去动效但保留状态可见", () => {
  assert.deepEqual(reducedMotionProblems(CSS), []);
});

test("③ 反例自证：reduce 里把状态 opacity:0 必须红", () => {
  const broken = CSS.replace(
    ".gosslan-dialog-overlay[data-state],",
    ".gosslan-dialog-overlay[data-state] { opacity: 0; }\n  .gosslan-dialog-overlay[data-state],",
  );
  assert.notEqual(broken, CSS, "fixture 没替换成功");
  assert.match(reducedMotionProblems(broken).join("\n"), /opacity:0/, "状态被藏掉却没红");
});
