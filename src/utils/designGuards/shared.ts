/**
 * 设计守卫的**共用件**（2026-11-18 从 4897 行的 `designGuards.ts` 里搬出来的）。
 *
 * 只为一件：36 个规则分节都依赖这几个名字，而它们不属于任何一条规则
 * （`lineAt` 是行号换算、`stripComments` 是"注释里提到类名不算数"、`findImgTags` 是引号状态机）。
 *
 * ## 拆分口径（改之前先读）
 *
 * **族内依赖留在同一分册**：②/②b 的 `cssRuleBody`/`lastTopLevelDefIndex`、
 * ㉜/IP-01 的 `findImgTags` 都在各自族里；跨族只许走这里 —— 否则又会织回一张网。
 * **单向依赖**：分册 → shared，shared 不许 import 任何分册。
 */
import { countNewlines } from "../newlines.ts";

export interface GuardIssue {
  /** 源文件行号（1 基）；0 表示与具体行无关（整文件级问题） */
  line: number;
  message: string;
}

/** 静态 class 属性；`class="…"`。动态 `:class` 里的字符串拼接不做静态判定（无法可靠推断）。 */
export const CLASS_ATTR_RE = /\bclass="([^"]*)"/g;

/** 一行里 `<template>` 之前的行数，用于把行号换算回源文件。 */
export function lineAt(src: string, index: number): number {
  return countNewlines(src.slice(0, index)) + 1;
}

/** 块内先抹掉注释（等长替换成空白，保行号）：注释里提到类名会让判据"因为注释而通过"。 */
export function stripComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/**
 * 扫出源文件里**真实存在**的 `<img>` 标签（跳过块注释与 HTML 注释里提到的那种）。
 *
 * 为什么不是正则 `<img[^>]*>`：`ImageLightbox` 那支在 `:style` 里写了 `scale > 1`，
 * 属性值里的 `>` 会把 `[^>]*` 截断 ⇒ 后半边的 `loading`/`decoding` 落在截断之外 ⇒ **把合规的报成缺**。
 * 这里用引号状态机找闭合，并且先把注释整段替换成**等长空白**（保住下标 ⇒ 行号与 `src` 对齐）。
 */
export function findImgTags(src: string): Array<{ start: number; text: string }> {
  const masked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: Array<{ start: number; text: string }> = [];
  let i = 0;
  for (;;) {
    // `<motion.img>` 在运行时仍是 img：共享元素转场后它也必须继续受同一条 fetch-hint 判据管。
    const a = masked.indexOf("<img", i);
    const b = masked.indexOf("<motion.img", i);
    if (a === -1 && b === -1) break;
    const j = a === -1 ? b : b === -1 ? a : Math.min(a, b);
    const tagLen = masked.startsWith("<motion.img", j) ? "<motion.img".length : "<img".length;
    const nxt = masked[j + tagLen];
    if (nxt !== " " && nxt !== "\n" && nxt !== "\t" && nxt !== "\r" && nxt !== ">") {
      i = j + tagLen;
      continue;
    }
    let k = j + tagLen;
    let q: string | null = null;
    for (; k < masked.length; k++) {
      const c = masked[k];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    out.push({ start: j, text: src.slice(j, k + 1) });
    i = k < masked.length ? k + 1 : masked.length;
  }
  return out;
}
