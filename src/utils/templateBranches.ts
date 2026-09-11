/**
 * Vue 模板「分支链」静态检查 —— 防的是**一条消息被渲染两遍**这类静默缺陷。
 *
 * 背景：`v-if / v-else-if / v-else` 是靠**同层相邻性**成链的。若链中间冒出一个
 * 新的 `v-if`（而不是 `v-else-if`），这条链就被切断；它后面原有的 `v-else` 会
 * 改挂到新链上，于是这个"兜底分支"对**上一链已经命中的情况同样成立**，
 * 同一份内容被渲染两次。
 *
 * 真实事故（提交 fd02f62）：`MessageItem.vue` 的「图片已被清理」占位写成了 `v-if`，
 * 切断了「文本 → 代码 → 图片 → 文件 → 兜底」这条链 —— 兜底的
 * `<div v-else>{{ message.content }}</div>` 因此对**每条文本/代码消息**都成立，
 * 表现是：每条消息出现两个气泡，带表情的消息左边是表情图、右边是 `[摊手]` 原文。
 * 类型检查、既有单测都发现不了它（模板结构不在二者的覆盖面内）。
 *
 * 判据刻意收紧，避免把合法写法误报：
 *   —— 只有当被切断的链**本身是多分支（≥2）**、该多分支里**确实含 `v-else-if`/`v-else`
 *      （即真的是一条"链"）**、且新链末尾带 `v-else` 时才报；
 *   —— 单独一个 `v-if`（如 `v-if="mine"` 的回执、`v-if="fileDragOver"` 的拖拽提示层、
 *      `v-if="showNickname"` 的昵称）彼此独立、互斥关系不存在，**不报**；
 *   —— **连续多个独立 `v-if`** 也不算链（如两个 `v-if="hasMultiple"` 的翻页按钮、
 *      `v-if="!isOwner"` 的按钮 + 提示）：`v-else` 只挂到紧邻的条件元素上，插在其后是安全的。
 *      （2026-09-10 补：旧实现按"前面有几个条件兄弟"计数，会把这类合法写法误报。）
 *
 * 逃生阀：文件里带 `vue-branch-chain-ok` 注释则整个文件跳过检查（给确有必要的
 * 写法留出口，避免护栏变成阻塞）。
 */

/** 需要跳过的文件标记。 */
export const BRANCH_CHECK_OPT_OUT = "vue-branch-chain-ok";

export interface BranchIssue {
  /** 模板内的行号（1 基，已换算回源文件行号） */
  line: number;
  tag: string;
  kind: "orphan" | "chain-break";
  message: string;
}

interface Node {
  tag: string;
  line: number;
  dir: string | null;
  children: Node[];
}

const VOID_TAGS = new Set([
  "img", "br", "hr", "input", "meta", "link", "area",
  "base", "col", "embed", "source", "track", "wbr",
]);

const TAG_RE = /<(\/?)([A-Za-z][-\w.]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gs;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** 取元素上的条件指令；判定顺序必须是「长缩写优先」，否则 v-else 会抢先匹配 v-else-if。 */
function directiveOf(attrs: string): string | null {
  for (const name of ["v-else-if", "v-else", "v-if"]) {
    if (new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(attrs)) return name;
  }
  return null;
}

/** 从 .vue 源码里取出**顶层** <template> 片段；注释置为等量空行，保证行号不漂移。
 *
 *  ⚠️ 必须按「首个 `<template>` → **最后**一个 `</template>`」取整块，
 *  **不能**用非贪婪的 `/<template>([\s\S]*?)<\/template>/`：模板内部的嵌套 `<template>`
 *  （如 `ChatHeader.vue` 的 `<template v-if="isGroup"> ({{ n }})</template>`、
 *  `ChatWindow.vue` 的 `#default` 插槽）会让非贪婪匹配在**第一个 `</template>` 处截断**，
 *  其后整段模板不再被检查 —— 护栏给出"全绿"的**假象**，而"静默漏报"正是本护栏最该避免的失败模式。
 *  2026-09-10 实测：修正前 `ChatHeader.vue` 的 4 个 `<button>` 只扫得到 1 个。 */
export function extractTemplate(src: string): { body: string; baseLine: number } | null {
  const open = src.indexOf("<template>");
  const close = src.lastIndexOf("</template>");
  if (open < 0 || close <= open) return null;
  const body = src
    .slice(open + "<template>".length, close)
    .replace(/<!--[\s\S]*?-->/g, (c) => "\n".repeat(countNewlines(c)));
  // body 的第 0 个字符与 `<template>` 同一行；body 内 k 个换行 → 源文件第 `openLine + k` 行。
  return { body, baseLine: countNewlines(src.slice(0, open)) + 1 };
}

function parseTemplate(body: string, baseLine: number): Node {
  const root: Node = { tag: "template", line: baseLine, dir: null, children: [] };
  const stack: Node[] = [root];
  for (const m of body.matchAll(TAG_RE)) {
    const [, closing, tag, attrs, selfClose] = m;
    const line = baseLine + countNewlines(body.slice(0, m.index));
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: Node = { tag, line, dir: directiveOf(attrs), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID_TAGS.has(tag.toLowerCase())) stack.push(node);
  }
  return root;
}

function walk(node: Node, out: BranchIssue[]): void {
  const kids = node.children;

  // ① 孤儿 v-else / v-else-if：同层前面没有可挂的 v-if（Vue 会编译报错或行为异常）
  let chain = false;
  for (const c of kids) {
    if (c.dir === "v-if") chain = true;
    else if (c.dir === "v-else-if" || c.dir === "v-else") {
      if (!chain) {
        out.push({
          line: c.line,
          tag: c.tag,
          kind: "orphan",
          message: `孤儿 ${c.dir}：同层前面没有 v-if / v-else-if`,
        });
      }
      chain = true;
    } else chain = false;
  }

  // ② 链被切断：新 v-if 前面存在一条**真链**，且新链末尾带 v-else
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.dir !== "v-if") continue;
    let branches = 0;
    /** 前面的连续分支里是否出现过 v-else-if / v-else —— 有才说明确实存在一条"链"。 */
    let sawChainBranch = false;
    for (let j = i - 1; j >= 0; j--) {
      const d = kids[j].dir;
      if (d === "v-if" || d === "v-else-if" || d === "v-else") {
        branches++;
        if (d === "v-else-if" || d === "v-else") sawChainBranch = true;
      } else break;
    }
    // ⚠️ 只靠"前面有 ≥2 个带条件指令的兄弟"会**误报**：连续多个**独立** v-if
    // （例如两个 `v-if="hasMultiple"` 的按钮、`v-if="!isOwner"` 的按钮与提示）
    // 彼此不成链，Vue 里 v-else 只挂到**紧邻**的那个条件元素上，插在其后不会双渲染。
    // 真正危险的是：被切断的是一条**含 v-else-if / v-else 的链**（作者用它们表达了"互斥"）。
    if (branches < 2 || !sawChainBranch) continue;
    let hasElse = false;
    for (let k = i + 1; k < kids.length; k++) {
      const d = kids[k].dir;
      if (d === "v-if" || d === null) break;
      if (d === "v-else") {
        hasElse = true;
        break;
      }
    }
    if (hasElse) {
      out.push({
        line: c.line,
        tag: c.tag,
        kind: "chain-break",
        message:
          `该 v-if 切断了前面那条 ${branches} 分支的链，且新链末尾的 v-else 对旧链分支同样成立` +
          ` → 命中旧链的内容会被渲染两次（此处应写 v-else-if）`,
      });
    }
  }

  for (const c of kids) if (c.children.length) walk(c, out);
}

/** 检查一份 .vue 源码的分支链；返回全部问题（空数组 = 通过）。 */
export function findBranchIssues(src: string): BranchIssue[] {
  if (src.includes(BRANCH_CHECK_OPT_OUT)) return [];
  const tmpl = extractTemplate(src);
  if (!tmpl) return [];
  const out: BranchIssue[] = [];
  walk(parseTemplate(tmpl.body, tmpl.baseLine), out);
  return out.sort((a, b) => a.line - b.line);
}
