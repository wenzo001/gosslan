/**
 * 图标按钮「可访问名」静态检查 —— 防的是**无名按钮**。
 *
 * 背景（2026-09-10 Apple HIG 审计 P0-4）：全库 60 余处图标按钮只写了 `title`。
 * `title` 是**鼠标工具提示**，不是可访问名：
 *   —— 触屏（iOS VoiceOver / Android TalkBack）没有 hover，基本读不到；
 *   —— 桌面读屏也不保证把它作为控件标签播报。
 * 于是"关闭 / 删除 / 返回 / 重新发送"这些按钮在读屏下**等于无名按钮**。
 * 正确做法是补 `aria-label`（可与 title 并存：aria-label 给读屏，title 给鼠标）。
 *
 * 判据（刻意收紧，避免误报）：
 *   —— 只看 `<button>`：其余元素的可访问名来源差异太大，不适合机械判定；
 *   —— 元素**已有**可访问名来源则跳过：`aria-label` / `aria-labelledby`（含 `:`
 *      与 `v-bind:` 动态绑定）、`v-html`（内容来自数据）、内部有可见文本或插值、
 *      或内部有带非空 `alt` 的 `<img>`（alt 可作可访问名）。
 *   → 只有「纯图标、且没有任何名字来源」的按钮才会被报出来。
 *
 * 已知局限（刻意保留，勿据此判"没问题"）：内部若含 `{{ 表达式 }}`（如未读徽标、
 * 头像首字母）就算作"有文本"，因此像导航栏"聊天/通讯录"这类**徽标+图标**的按钮
 * 不会被报出来 —— 它们的可访问名会退化成裸数字/首字母，仍需人工判断。
 *
 * 逃生阀：文件里带 `a11y-label-ok` 注释则整个文件跳过（给确有必要的写法留出口）。
 */

/** 需要跳过的文件标记。 */
export const A11Y_LABEL_OPT_OUT = "a11y-label-ok";

export interface LabelIssue {
  /** 源文件行号（1 基） */
  line: number;
  /** 该按钮的行内片段，便于定位 */
  snippet: string;
}

/** `<button …>…</button>`；button 不允许嵌套，故非贪婪匹配到首个闭合标签即为完整元素。 */
const BUTTON_RE = /<button\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>([\s\S]*?)<\/button>/gs;

/** 任一形式的可访问名绑定：aria-label / aria-labelledby，含 `:attr` 与 `v-bind:attr`。 */
const HAS_LABEL_BINDING = /(?::|v-bind:)?aria-label(?:ledby)?\s*=/i;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 取出 .vue 的**顶层** `<template>` 块。
 *
 * ⚠️ 不能复用 templateBranches 的 extractTemplate：它用非贪婪的 `</template>` 匹配，
 * 遇到模板内部的嵌套 `<template>`（如 ChatHeader.vue 的
 * `<template v-if="…"> ({{ n }})</template>`、ChatWindow.vue 的 `#default` 插槽）
 * 就会**在第一个 `</template>` 处截断** —— 实测 ChatHeader 的 4 个按钮只扫得到 1 个，
 * 护栏会给出"全绿"的假象。故这里按「首个 `<template>` → 最后一个 `</template>`」取完整块。
 */
export function extractTopLevelTemplate(src: string): { body: string; baseLine: number } | null {
  const open = src.indexOf("<template>");
  const close = src.lastIndexOf("</template>");
  if (open < 0 || close <= open) return null;
  const raw = src.slice(open + "<template>".length, close);
  // 注释置为等量空行，保证行号不漂移
  const body = raw.replace(/<!--[\s\S]*?-->/g, (c) => "\n".repeat(countNewlines(c)));
  return { body, baseLine: countNewlines(src.slice(0, open)) + 1 };
}

/** 去掉标签与注释后剩下的"可见文本"；插值 `{{ … }}` 视为有文本。 */
function visibleText(inner: string): string {
  return inner
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "T")
    .replace(/\s+/g, "");
}

/** 内部是否有带非空 alt 的图片（alt 可作为可访问名）。 */
function hasAltImage(inner: string): boolean {
  return /<img\b[^>]*\balt\s*=\s*("([^"]*)"|'([^']*)')/i.test(inner);
}

/** 该元素的起始行号与首行片段。 */
function locator(body: string, baseLine: number, index: number, text: string): { line: number; snippet: string } {
  return {
    line: baseLine + countNewlines(body.slice(0, index)),
    snippet: (text.split("\n")[0] ?? "").trim().slice(0, 80),
  };
}

/** 检查一份 .vue 源码里"纯图标且无名字来源"的按钮；空数组 = 通过。 */
export function findUnlabeledButtons(src: string): LabelIssue[] {
  if (src.includes(A11Y_LABEL_OPT_OUT)) return [];
  const tmpl = extractTopLevelTemplate(src);
  if (!tmpl) return [];
  const { body, baseLine } = tmpl;
  const out: LabelIssue[] = [];
  for (const m of body.matchAll(BUTTON_RE)) {
    const attrs = m[1];
    const inner = m[3];
    if (HAS_LABEL_BINDING.test(attrs)) continue;
    if (/\bv-html\b/.test(attrs)) continue;
    if (visibleText(inner).length > 0) continue;
    if (hasAltImage(inner)) continue;
    out.push(locator(body, baseLine, m.index ?? 0, m[0]));
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- 图片：必须显式声明 alt（含"装饰性"） ----------------
//
// 与按钮同理，`<img>` 没有 alt 时读屏可能念出文件名/URL，或干脆什么都不说。
// 规范里 `alt=""`（显式空）是"这是装饰，读屏请跳过"的**正确**写法，因此判据是
// 「**出现过** alt 属性」而不是「alt 非空」——真正要禁的是"忘记写 alt"。

/** `<img …>`；img 是 void 元素，无闭合标签。 */
const IMG_RE = /<img\b((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gs;

/** 任一形式的 alt 绑定，含 `:alt` / `v-bind:alt`。 */
const HAS_ALT_BINDING = /(?::|v-bind:)?alt\s*=/i;

/** 检查一份 .vue 源码里没有 alt 的 <img>；空数组 = 通过。 */
export function findUnnamedImages(src: string): LabelIssue[] {
  if (src.includes(A11Y_LABEL_OPT_OUT)) return [];
  const tmpl = extractTopLevelTemplate(src);
  if (!tmpl) return [];
  const { body, baseLine } = tmpl;
  const out: LabelIssue[] = [];
  for (const m of body.matchAll(IMG_RE)) {
    if (HAS_ALT_BINDING.test(m[1])) continue;
    out.push(locator(body, baseLine, m.index ?? 0, m[0]));
  }
  return out.sort((a, b) => a.line - b.line);
}
