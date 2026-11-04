import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 全局动效守卫（2026-11-04 用户全局原则，见 docs/design-guidelines.md §11.3.7）：
 * **已存在的元素不许靠 `:key` 绑定状态值来"换节点"** —— 那会让状态每变一次就重播一次
 * enter/scale 动画（消息回执图标就是这么缩一下再弹回来的）。
 *
 * 判据形状：`<Transition>` 的直接子节点若以 `:key` 绑定一个状态量（`state` / `status`
 * / `phase` / `stage` / `step`…），就是在"用状态值重建节点"。真正需要整块内容替换的地方
 * （例如设置页换 section）必须显式写 `<!-- motion-guard-ok: 理由 -->` 才放行，
 * 让"我知道这里在重播，但这是换页面不是换状态"变成可检索的决定，而不是默认习惯。
 *
 * 反例自证：文件末尾把旧写法喂进同一个判定函数，必须报红。
 */

const SRC = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".vue")) out.push(p);
  }
  return out;
}

/** 状态量命名：命中这些词根即视为"状态值"（`section`/`direction` 这类导航量不算）。 */
const STATE_KEY = /(^|[^A-Za-z0-9_])(state|status|phase|stage|step|progress|sendState|sendStatus)([^A-Za-z0-9_]|$)/i;

/** 取某个起点之后的下一个开始标签（跳过注释与文本），返回整段、标签名与起点。 */
function nextStartTag(src: string, from: number): { tag: string; start: number; end: number } | null {
  const re = /<!--[\s\S]*?-->|<[A-Za-z][^>]*>/g;
  re.lastIndex = from;
  for (const m of src.matchAll(re)) {
    if (m[0].startsWith("<!--")) continue;
    return { tag: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}

/** 返回缺陷列表（空 = 通过）。注释里的旧写法/说明文字不参与判定。 */
function findKeyedStateTransitions(src: string): string[] {
  const out: string[] = [];
  const comments = Array.from(src.matchAll(/<!--[\s\S]*?-->/g), (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const inComment = (pos: number) => comments.some(([a, b]) => pos >= a && pos < b);
  for (const m of src.matchAll(/<Transition\b[^>]*>/g)) {
    const at = m.index ?? 0;
    if (inComment(at)) continue;
    const child = nextStartTag(src, at + m[0].length);
    if (!child || inComment(child.start)) continue;
    const key = /:key="([^"]+)"/.exec(child.tag)?.[1];
    if (!key || !STATE_KEY.test(key)) continue;
    if (/motion-guard-ok/.test(src.slice(at, child.end))) continue;
    const line = src.slice(0, at).split("\n").length;
    out.push(`${line}: <Transition> 的子节点以 :key="${key}" 按状态重建 ⇒ 每次状态变化都会重播进入动画`);
  }
  return out;
}

test("src 下没有『Transition + :key 绑状态值』（会重播 enter 的形状）", () => {
  const offenders = walk(SRC).flatMap((file) => findKeyedStateTransitions(readFileSync(file, "utf8"))
    .map((issue) => `${file.slice(SRC.length)} ${issue}`));
  assert.deepEqual(offenders, []);
});

test("反例自证：旧的 `<Transition mode=\"out-in\"><div :key=\"state\">` 必须被这条守卫抓住", () => {
  const old = `<Transition name="receipt-swap" mode="out-in">
  <span :key="state" class="relative flex items-center">
    <Check v-if="state === 'sent'" />
  </span>
</Transition>`;
  const issues = findKeyedStateTransitions(old);
  assert.equal(issues.length, 1, issues.join("\n"));
  assert.match(issues[0], /:key="state"/);
});

test("显式放行：换页面（:key=\"section\"）不算状态重播，带 motion-guard-ok 也不报", () => {
  const nav = `<!-- motion-guard-ok: 换的是设置分区整块内容，不是同一元素的状态 -->
<Transition name="settings-swap" mode="out-in">
  <div :key="section">
    <div v-if="section === 'general'" />
  </div>
</Transition>`;
  assert.deepEqual(findKeyedStateTransitions(nav), []);
  const navNoMarker = nav.replace(/<!-- motion-guard-ok[^>]*-->/, "");
  assert.deepEqual(findKeyedStateTransitions(navNoMarker), [], "section 不是状态量，本来就不该报");
});
