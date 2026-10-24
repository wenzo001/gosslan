import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTER_ANIM_MS, computeEnteringId } from "./messageEnter.ts";

const cssText = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
const chatSrc = readFileSync(
  join(import.meta.dirname, "..", "components", "ChatWindow.vue"),
  "utf8",
);

/** 取 `@keyframes <name> { ... }` 的正文（按花括号配对，不信固定行数）。 */
function keyframeBody(name: string): string {
  const start = cssText.indexOf(`@keyframes ${name} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start + `@keyframes ${name}`.length; i < cssText.length; i += 1) {
    if (cssText[i] === "{") depth += 1;
    else if (cssText[i] === "}") {
      depth -= 1;
      if (depth === 0) return cssText.slice(start, i + 1);
    }
  }
  return "";
}

/**
 * 只数**代码行**里的出现：注释里也会写这些名字，朴素计数会把注释当调用点
 * （这条测试第一版就是这么"红"的 —— 红的是量具，不是产品）。
 */
function codeOccurrences(src: string, needle: string): number {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("<!--")
      );
    })
    .reduce((n, line) => n + (line.split(needle).length - 1), 0);
}

/** 取每条 `@media (prefers-reduced-motion: reduce)` 自己的花括号正文。 */
function reduceMediaBodies(): string[] {
  const marker = "@media (prefers-reduced-motion: reduce)";
  const out: string[] = [];
  for (let i = cssText.indexOf(marker); i >= 0; i = cssText.indexOf(marker, i + 1)) {
    const open = cssText.indexOf("{", i);
    if (open < 0) continue;
    let depth = 0;
    for (let j = open; j < cssText.length; j += 1) {
      if (cssText[j] === "{") depth += 1;
      else if (cssText[j] === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(cssText.slice(open, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

const base: Parameters<typeof computeEnteringId>[0] = {
  prevLastId: "m1",
  nextLastId: "m2",
  prevLen: 3,
  nextLen: 4,
  willBeVisible: true,
};

test("进入资格：尾部追加一条且在视野里才算（唯一该动的那一档）", () => {
  assert.equal(computeEnteringId(base), "m2");
});

test("进入资格·四种不该动的形状各自挡得住", () => {
  // ① 尾 id 没变 = 整体替换 / 切会话 / 原地改状态（已读回执翻面不是"来了一条新消息"）
  assert.equal(computeEnteringId({ ...base, nextLastId: "m1" }), null);
  // ② 原来空表 = 首屏填充
  assert.equal(computeEnteringId({ ...base, prevLastId: null, prevLen: 0 }), null);
  // ③ 一次进多条 = 批量回填/导入，整屏同时淡入
  assert.equal(computeEnteringId({ ...base, nextLen: 9 }), null);
  // ④ 不在视野 = 用户正在读历史
  assert.equal(computeEnteringId({ ...base, willBeVisible: false }), null);
  // prepend 历史：长度涨了但尾 id 不动 —— 由 ① 同一条挡掉，这里给个具名形状
  assert.equal(computeEnteringId({ ...base, prevLen: 3, nextLen: 23, nextLastId: "m1" }), null);
});

test("接线判据：判定只被调用一处、动效类名只绑一处（逻辑绿不等于被接上）", () => {
  // 正控：同一把尺子必须能读出"确实存在"的那两处（定义 + 调用），否则下面的 ==1 只是因为数不出东西
  assert.ok(
    codeOccurrences(chatSrc, "markEntering(") >= 2,
    `连 markEntering( 都数不出来 ⇒ 提取器坏了：${codeOccurrences(chatSrc, "markEntering(")}`,
  );
  const calls = codeOccurrences(chatSrc, "computeEnteringId(");
  assert.equal(calls, 1, `computeEnteringId( 的调用点应恰好 1 处，实测 ${calls}`);
  assert.ok(chatSrc.includes("computeEnteringId"), "ChatWindow 没 import 这个判定 ⇒ 动画永远不跑");
  const cls = codeOccurrences(chatSrc, "gosslan-msg-enter");
  assert.equal(cls, 1, `动效类名在 ChatWindow 里应恰好出现 1 次（模板绑定），实测 ${cls}`);
});

test("动效只碰 opacity/transform：不许动画布局尺寸（虚拟列表测量会被动到）", () => {
  // 正控：解析面先要认得出真实存在的另一条 keyframes，否则下面的断言全绿只是因为解析坏了
  assert.ok(keyframeBody("gosslan-toast-in").length > 0, "没解析到 @keyframes gosslan-toast-in");
  const body = keyframeBody("gosslan-msg-in");
  assert.ok(body.length > 0, "src/style.css 里没有 @keyframes gosslan-msg-in");
  const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(props.length >= 4, `关键帧里解析到的属性太少：${JSON.stringify(props)}`);
  const illegal = props.filter((p) => p !== "opacity" && p !== "transform");
  assert.deepEqual(illegal, [], `进入动画只许 opacity/transform，实测混进：${JSON.stringify(illegal)}`);
});

test("时长与缓动都取全站令牌，且 TS 常数与 CSS 现读对账（不各写一套）", () => {
  // 注释先抹掉：注释里也写着类名，朴素匹配会先撞上那句注释
  const noComment = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /(?:^|\n)\.gosslan-msg-enter\s*\{([^}]*)\}/.exec(noComment);
  assert.ok(rule, "没解析到 .gosslan-msg-enter 规则（顶层、未缩进那一档）");
  const decl = rule[1].replace(/\s+/g, " ").trim();
  assert.match(
    decl,
    /^animation: gosslan-msg-in var\(--gosslan-duration\) var\(--gosslan-ease\)/,
    `进入动画必须走全站时长/缓动令牌，实测：${decl}`,
  );
  const tokenMs = /--gosslan-duration:\s*(\d+)ms/.exec(noComment);
  assert.ok(tokenMs, "CSS 里没读到 --gosslan-duration");
  assert.equal(
    ENTER_ANIM_MS,
    Number(tokenMs[1]),
    `messageEnter.ts 的常数与 CSS 令牌漂了：TS=${ENTER_ANIM_MS} / CSS=${tokenMs[1]}`,
  );
});

test("减少动效档下这条动画必须被关掉（§8 硬要求，且不许把界面一起关掉）", () => {
  const bodies = reduceMediaBodies();
  // 正控：文件里本来就有多条 reduce 块，且解析面认得出它们
  assert.ok(bodies.length >= 4, `reduce 块解析得太少（量具坏了？）：${bodies.length}`);
  const mine = bodies.find((b) => b.includes(".gosslan-msg-enter"));
  assert.ok(mine, "reduce 档里没有 .gosslan-msg-enter 的关闭声明");
  const m = /\.gosslan-msg-enter\s*\{([^}]*)\}/.exec(mine);
  assert.ok(m && /animation:\s*none/.test(m[1]), `reduce 档那条不是 animation: none：${m?.[1]?.trim()}`);
});
