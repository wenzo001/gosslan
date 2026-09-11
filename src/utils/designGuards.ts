/**
 * 设计规范里"靠自觉维持"的条款，做成可执行断言。
 *
 * 前两个模块（`tokenContrast` 读 style.css 核对比度、`templateBranches` 扫模板分支链）
 * 已经把"最容易悄悄漂移"的两类规则变成测试。本模块补的是本轮新确立、
 * 而**当时只写在注释与文档里**的两条 —— 它们各自都已经真实踩过一次：
 *
 *   ① 悬停揭示必须有触屏兜底（`group-hover` / `opacity-0` → `.hover-reveal` / `.hover-reveal-op`）
 *      踩坑：会话行的删除键只有 `group-hover:flex`，Android 上永远不显示 = 功能缺失。
 *   ② 辅助功能媒体查询必须排在 `style.css` 末尾
 *      踩坑：`.glass` / `.frost` 的定义在文件更靠后处，同优先级下"后定义者胜"，
 *      降级规则写在前面被**完整覆盖**（写了日志、加了注释，但实测才发现无效）。
 *
 * 两者都是"写对了但不起作用"，读代码几乎看不出来 —— 正是最该由机器盯住的那类。
 */

export interface GuardIssue {
  /** 源文件行号（1 基）；0 表示与具体行无关（整文件级问题） */
  line: number;
  message: string;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** 一行里 `<template>` 之前的行数，用于把行号换算回源文件。 */
function lineAt(src: string, index: number): number {
  return countNewlines(src.slice(0, index)) + 1;
}

// ---------------- ① 悬停揭示必须有触屏兜底 ----------------

/** 展示类工具（揭示 = 让它显示出来）。 */
const DISPLAY_UTILS = ["flex", "block", "grid", "inline-flex", "inline-block", "table"];

/** 静态 class 属性；`class="…"`。动态 `:class` 里的字符串拼接不做静态判定（无法可靠推断）。 */
const CLASS_ATTR_RE = /\bclass="([^"]*)"/g;

/**
 * 检查一份 .vue 源码里"靠悬停揭示、却没有触屏兜底"的元素。
 *
 * 判据（刻意收紧，只看能确定的两种揭示方式）：
 *   —— class 里同时有 `hidden` 与 `group-hover…:<展示类>` → 需要 `.hover-reveal`
 *      （这正是会话删除键的原始写法：`hidden … group-hover/conv:flex`）
 *   —— class 里同时有 `opacity-0` 与 `group-hover…:opacity-*` → 需要 `.hover-reveal-op`
 * 逃生阀：文件里带 `hover-reveal-ok` 注释则整文件跳过。
 */
export function findHoverRevealIssues(src: string): GuardIssue[] {
  if (src.includes("hover-reveal-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    const has = (c: string) => classes.includes(c);
    // Tailwind 的 group 变体：`group-hover:flex` 或带命名的 `group-hover/conv:flex`
    const groupHoverUtils = classes
      .filter((c) => c.startsWith("group-hover"))
      .map((c) => c.slice(c.indexOf(":") + 1));

    const displayReveal = has("hidden") && groupHoverUtils.some((u) => DISPLAY_UTILS.includes(u));
    const opacityReveal =
      has("opacity-0") && groupHoverUtils.some((u) => u.startsWith("opacity-"));

    if (displayReveal && !has("hover-reveal")) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "元素用 `hidden` + `group-hover…:<展示类>` 揭示，但缺少 `hover-reveal` —— " +
          "触屏没有 hover，这个操作在手机上**永远不显示**（等于功能缺失）。加 `hover-reveal`。",
      });
    }
    if (opacityReveal && !has("hover-reveal-op")) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "元素用 `opacity-0` + `group-hover…:opacity-*` 揭示，但缺少 `hover-reveal-op` —— " +
          "触屏上看不见（虽然可点，但用户只能靠猜）。加 `hover-reveal-op`。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ② 媒体查询必须排在 style.css 末尾 ----------------

/** 取某选择器**顶级**定义（行首、无缩进）的最后一次出现位置；找不到返回 -1。 */
function lastTopLevelDefIndex(css: string, selector: string): number {
  const re = new RegExp(`(?:^|\\n)${selector}\\s*\\{`, "g");
  let idx = -1;
  for (const m of css.matchAll(re)) idx = m.index ?? -1;
  return idx;
}

/**
 * 检查 `src/style.css` 里两条"必须留在文件末尾"的降级规则。
 *
 * 为什么必须靠机器盯：降级块要覆盖 `.glass` / `.frost` 的 `backdrop-filter`，
 * 而 CSS 同优先级下**后定义者胜**。把块写到文件中部不会报错、也不会让任何行为测试变红，
 * 只是**静默失效** —— 只有真去开系统开关、或在无头浏览器里读计算值才会发现。
 */
export function checkStyleCascade(css: string): GuardIssue[] {
  const out: GuardIssue[] = [];

  // ②-1 降级媒体查询必须晚于 .glass / .frost / .vel-modal 的顶级定义
  const baseIdx = Math.max(
    lastTopLevelDefIndex(css, "\\.glass"),
    lastTopLevelDefIndex(css, "\\.frost"),
    lastTopLevelDefIndex(css, "\\.vel-modal"),
  );
  if (baseIdx < 0) {
    out.push({ line: 0, message: "style.css 里找不到 .glass / .frost / .vel-modal 的定义" });
  }
  const blocks: [string, string][] = [
    ["降低透明度", "@media (prefers-reduced-transparency: reduce)"],
    ["提高对比度", "@media (prefers-contrast: more)"],
  ];
  for (const [label, header] of blocks) {
    const at = css.indexOf(header);
    if (at < 0) {
      out.push({ line: 0, message: `style.css 缺少「${label}」媒体查询（${header}）` });
      continue;
    }
    if (baseIdx >= 0 && at < baseIdx) {
      out.push({
        line: lineAt(css, at),
        message:
          `「${label}」媒体查询排在 .glass/.frost 定义**之前** → 会被它们覆盖而静默失效。` +
          "必须移到 style.css 末尾（详见 docs/design-guidelines.md §10.1）。",
      });
    }
  }

  // ②-2 .hover-reveal / .hover-reveal-op 必须定义在 @media (hover: none) 里
  const hoverNoneAt = css.indexOf("@media (hover: none)");
  if (hoverNoneAt < 0) {
    out.push({ line: 0, message: "style.css 缺少 @media (hover: none) 触屏兜底块" });
  } else {
    for (const cls of [".hover-reveal", ".hover-reveal-op"]) {
      const at = css.indexOf(`${cls} {`);
      if (at < 0) {
        out.push({ line: 0, message: `style.css 缺少 ${cls} 的定义` });
      } else if (at < hoverNoneAt) {
        out.push({
          line: lineAt(css, at),
          message: `${cls} 定义在 @media (hover: none) 之外 → 在有 hover 的设备上也会常显，兜底失效。`,
        });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
