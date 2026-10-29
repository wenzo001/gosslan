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
 *   ⑨ Headless UI 的 `as="template"` 插槽里不得有 HTML 注释/多个顶层节点
 *      踩坑（用户实测"点加好友整个窗口卡死"的真因）：dev 构建**保留 HTML 注释**，
 *      于是 `as="template"` 的插槽里多出一个注释节点，Headless UI 的 render 直接抛
 *      "Passing props on template!"，Vue 渲染抛错 ⇒ 整个界面再也 patch 不动（看起来就是卡死）。
 *      生产构建会剥掉注释，所以这类缺陷**只在 dev 出现**，最容易把人带偏。
 *
 *   ⑧ 小尺寸可交互元素必须有 `tap-safe`（触屏点按目标 ≥44pt，HIG）
 *      踩坑：iOS HIG 的最小点按目标是 44×44pt，而项目里大量图标按钮是 28–32px
 *      （桌面鼠标没问题，**手指容易点不中甚至误触相邻项**）。项目已有 `.tap-safe`
 *      （`:pointer: coarse` 下把热区垂直撑到 +16px），但靠自觉使用，本次复核仍扫出 8 处漏网
 *      —— 其中移动端返回键、删除端点键、取色控件都在手机上真会被点到。
 *
 *   ⑦ `outline-none` 必须自带焦点指示（否则全局焦点环被它"静默盖掉"）
 *      踩坑：全局焦点环写在 `:where(button, a, input, …, [tabindex], [contenteditable]):focus-visible`
 *      —— **`:where()` 的特异性是 0**，而 Tailwind 的 `.outline-none`（`outline: 2px solid
 *      transparent`）是 0,1,0 ⇒ 只要元素带 `outline-none`，那条"让键盘用户看得见焦点"的
 *      规则就**一条都不生效**。7 处输入框（含最高频的输入框）因此完全没有焦点指示。
 *      这正是"写对了但不起作用"，与本模块其它条同源。
 *
 *   ⑥ 可点击元素必须能用键盘触发（`div` + `@click` 是"只有鼠标/手指能用"的按钮）
 *      踩坑：好友选择行、图片/文件气泡、指纹复制等处都是 `div @click` ——
 *      触屏能用、鼠标能用，但**键盘完全够不着**（Tab 跳不到、回车没反应）。
 *      在"为 iOS 上架铺路 + 去网页感"的目标下，这类元素还缺 `role`，
 *      读屏软件也只会念成一段普通文本。
 *
 *   ③ 未读徽标必须走唯一实现（`UnreadBadge.vue`）
 *      踩坑：徽标数字需要 1.5px 光学补偿才能垂直居中，而 5 处手写副本里有 2 处漏了
 *      配套的 `leading-none` —— 同一种徽标在不同位置基线不一致，肉眼可见「没居中」，
 *      读代码看不出来。
 *
 * 三者都是"写对了但不起作用"，读代码几乎看不出来 —— 正是最该由机器盯住的那类。
 */
import { countNewlines } from "./newlines.ts";

export interface GuardIssue {
  /** 源文件行号（1 基）；0 表示与具体行无关（整文件级问题） */
  line: number;
  message: string;
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

// ---------------- ③ 未读徽标必须走唯一实现 ----------------

/**
 * 检查一份 .vue 源码里"手写的未读徽标"。
 *
 * 判据：同一个静态 `class` 里同时出现 `min-w-4` 与 `gosslan-danger` —— 这个组合是
 * 未读徽标独有的（红底胶囊 + 最小宽度 16px），不会误伤其他元素。
 *
 * 为什么必须走唯一实现：徽标数字需要 **1.5px 光学补偿**才能在圆内垂直居中
 * （字形在行盒里天然偏下：实测上间隙 10 / 下间隙 7，2x 截图）。此前有 5 处手写副本，
 * 其中 2 处漏了配套的 `leading-none` —— 同一种徽标在不同位置的基线不一致，
 * 肉眼能看出「数字没居中」，但读代码几乎看不出来。用组件收敛后由本护栏守住。
 */
export function findHandWrittenBadges(src: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (classes.includes("min-w-4") && classes.some((c) => c.includes("gosslan-danger"))) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "手写的未读徽标 —— 请改用 `@/components/UnreadBadge.vue`。" +
          "徽标数字依赖 1.5px 光学补偿做到垂直居中，手写副本极易漏掉配套的 `leading-none`，" +
          "导致同一徽标在不同位置基线不一致（详见组件注释）。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * `UnreadBadge.vue` 自身必须保留「垂直居中补偿」与其前提 `leading-none`。
 *
 * 这两条是**一对**：补偿量 `pb-[1.5px]` 是按「行盒高 = font-size」推算的
 * （`(16 − 1.5 − 11) / 2 = 1.75`，未补偿时 2.5 → 上移 0.75px），
 * 单独删掉任何一个都会让数字重新偏下。数值本身是实测结果，不是随手写的边距。
 */
export function checkUnreadBadgeComponent(src: string): GuardIssue[] {
  // ⚠️ 必须只看**真实的 class 属性**，不能 `src.includes(...)` 扫全文：
  // 组件里的注释本来就会提到这些类名，扫全文会让护栏「因为注释而通过」——
  // 这正是本模块要防的假通过（首版就是这么写的，靠非空转验证才抓出来）。
  let badgeLine = 0;
  let classes: string[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const cs = m[1].split(/\s+/).filter(Boolean);
    if (cs.includes("min-w-4")) {
      badgeLine = lineAt(src, m.index ?? 0);
      classes = cs;
      break;
    }
  }
  if (classes.length === 0) {
    return [{ line: 0, message: "`UnreadBadge.vue` 里找不到徽标的 class 属性（含 `min-w-4` 的那一行）" }];
  }

  const out: GuardIssue[] = [];
  if (!classes.includes("pb-[1.5px]")) {
    out.push({
      line: badgeLine,
      message:
        "`UnreadBadge.vue` 缺少 `pb-[1.5px]` 垂直居中补偿 —— 数字会偏下（实测上间隙 10 / 下间隙 7）。",
    });
  }
  if (!classes.includes("leading-none")) {
    out.push({
      line: badgeLine,
      message:
        "`UnreadBadge.vue` 缺少 `leading-none` —— 补偿值按「行盒高 = font-size」推算，" +
        "行高变 normal（≈13.2px）后补偿不再成立。",
    });
  }
  return out;
}

// ---------------- ④ 被截断的文本必须有可访问名（title / aria-label） ----------------

/** 从 `class="…"` 的匹配位置取回**整个开标签**。 */
function enclosingTag(src: string, classIndex: number): string {
  let start = -1;
  for (let i = classIndex; i >= 0; i--) {
    if (src[i] === "<") {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  const end = src.indexOf(">", classIndex);
  return end < 0 ? src.slice(start) : src.slice(start, end + 1);
}

/**
 * 检查一份 .vue 源码里"会被 `truncate` 截断、却没有 hover title / aria-label"的元素。
 *
 * 为什么要机器盯：`truncate`（`overflow:hidden` + `text-overflow:ellipsis`）在**视觉上**
 * 把名字/地址/文件名截成「…」，而完整内容只存在于 DOM 里 —— 鼠标悬停拿不到、读屏
 * 也可能拿不到。这类缺陷**编译通过、测试全绿、代码看着也正常**，只有真去 hover 才发现。
 *
 * 判据（收紧到能确定的形态）：
 *   —— 同一个开标签里有 `truncate` 类，且**没有** `title` / `:title` / `aria-label` /
 *      `:aria-label`（任一即可）→ 报出。
 *   —— 逃生阀：文件里带 `truncate-title-ok` 注释则整文件跳过（例如父级已有整行
 *      `aria-label`、且文本短到不可能截断的场合）。
 *
 * ⚠️ 与 ③ 同样的教训：只看**真实 class 属性**，不能用 `src.includes("truncate")` 扫全文 ——
 * 注释里提到 `truncate` 会让护栏「因为注释而通过」。
 */
/**
 * 默认头像（emoji 小动物，#32）必须对读屏隐藏（`aria-hidden="true"`）。
 *
 * 踩坑（2026-09-26 用系统无障碍控件树实测，当时还是字母头像）：那一段文字
 * （`KEEN` / `BRIG` / `HAPP`）会作为 `AXStaticText` 出现在树里 ⇒ 读屏把**无意义的装饰**
 * 念在人名前面。同一位置的上传头像是 `alt=""`（装饰性、人名由旁边的文本承载）。
 * 头像换成 emoji 之后这条口径不变：**装饰性图形一律对辅助技术隐藏**，
 * 所以判据跟着换类名，而不是删掉 —— 新站点漏写时它必须报红。
 */
export function findAvatarFaceWithoutAriaHidden(src: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    if (!m[1].split(/\s+/).includes("gosslan-avatar-emoji")) continue;
    const line = lineAt(src, m.index ?? 0);
    const open = src.lastIndexOf("<", m.index ?? 0);
    const close = src.indexOf(">", m.index ?? 0);
    const tag = open >= 0 && close > open ? src.slice(open, close + 1) : "";
    if (!tag.includes("aria-hidden")) {
      out.push({
        line,
        message:
          "默认头像的 emoji 没有 `aria-hidden` —— 读屏会把装饰性图形念出来。" +
          "人名由旁边的文本承载，上传头像那支已是 `alt=\"\"`，两支必须同口径。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 字母头像这条渲染路径必须**不存在**（#32 用 emoji 头像整体换掉了它）。
 *
 * 为什么值得单独一条：换掉它的两个理由都**不会自己守住** —— 昵称可改（改一次换一张脸）、
 * 昵称也能撞（两个人同名就同脸），而"按名字截字"看起来仍然是个合理实现，
 * 下一个人完全可能顺手写回来。所以判据盯住那三个标识符 + 那个类名：
 * 任一复活即红。只扫 `.vue`（渲染路径的家）—— 本文件的夹具里就写着这些名字。
 */
export function findRetiredLetterAvatarUsage(src: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(/\b(avatarInitialLen|avatarInitial|nameToColor)\b|gosslan-avatar-initial/g)) {
    out.push({
      line: lineAt(src, m.index ?? 0),
      message:
        `字母头像的标识符「${m[1] ?? m[0]}」复活了 —— 默认头像一律走 utils/avatarSeed.ts 的 emoji 头像` +
        "（种子是设备 id / 群 id：昵称可改也会撞名，截字那条路两个理由都守不住）。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 模板里挂上的 **BEM 修饰类**（含 `--` 的那一类）必须在某处样式里有定义。
 *
 * 为什么单独一条：这类缺陷的形态是**界面静默退化** —— `:class="{ 'x--on': c }"` 挂上去了，
 * 而 `.x--on` 那条规则被删了/没写，页面照常渲染、测试照常绿、vue-tsc 也管不着（它不是类型）。
 * 用户看到的后果是"高亮没了 / 危险色没了"，而 @ 到自己加重样式（#85）正是这种修饰类驱动的。
 *
 * 覆盖面 = 模板 class 属性上**写死的类名**三种形态：静态 `class="a b--c"`、对象
 * `:class="{ 'b--c': x }"`、三元/数组 `:class="ok ? 'b--c' : ''"` 与 `:class="['b--c']"`。
 * 不覆盖**在脚本里拼出来的类名**（`rowLevelBg(r.level)` 那类函数返回值）—— 那是运行时信息，
 * 静态扫不出来；仓里今天的 3 枚修饰类全是字面量，一旦有人改成拼接，这格判据就少守一枚，
 * 所以「认出了几枚」由 `designGuards.test.ts` 现算兜底（少于 3 即红）。
 * 反之**不拿** `src.includes("x--y")` 扫全文：注释里提一句就让护栏"因为注释而通过/报红"，
 * 是本仓点过名的族。定义可以来自全局 `style.css`（由调用方传进来），也可以是**同文件**的 `<style>` 块。
 */
const MODIFIER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*--[A-Za-z0-9-]+$/;

/** 从模板的 class 属性里认出写死的 BEM 修饰类名（按出现顺序去重）。 */
export function modifierClassesUsed(src: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (MODIFIER_NAME_RE.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  // class 绑定的三种真实写法各覆盖一处：静态（裸 token）、对象键 / 三元 / 数组（单引号字面量）
  for (const m of src.matchAll(/\bclass="([^"]*)"/g)) {
    for (const t of m[1].split(/\s+/)) add(t);
    for (const lit of m[1].matchAll(/'([^']*)'/g)) add(lit[1]);
  }
  return out;
}

export function findModifierClassWithoutStyle(src: string, cssText: string): GuardIssue[] {
  const uses = new Map<string, number>();
  for (const name of modifierClassesUsed(src)) {
    const at = src.indexOf(name);
    if (!uses.has(name)) uses.set(name, lineAt(src, at < 0 ? 0 : at));
  }
  // 同文件 <style> 块也算定义处（SFC 的 scoped 样式就是这个形态）
  const ownStyles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "").join("\n");
  const hay = `${cssText}\n${ownStyles}`;
  const out: GuardIssue[] = [];
  for (const [name, line] of uses) {
    const defRe = new RegExp(`\\.${name}(?![\\w-])`);
    if (!defRe.test(hay)) {
      out.push({
        line,
        message: `修饰类「${name}」挂在了模板上，但全局 style.css 与本文件 <style> 里都没有它的定义 `
          + "⇒ 界面会静默退化（高亮/危险色这类视觉提示消失而没有任何测试变红）。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export function findTruncationWithoutTitle(src: string): GuardIssue[] {
  if (src.includes("truncate-title-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (!classes.includes("truncate")) continue;
    // 全角/半角都要认：`:title` 是 v-bind 简写，`v-bind:title` 是完整写法。
    const tag = enclosingTag(src, m.index ?? 0);
    const named =
      /(?:^|\s)(?::|v-bind:)title\s*=/.test(tag) ||
      /(?:^|\s)title\s*=/.test(tag) ||
      /(?:^|\s)(?::|v-bind:)aria-label\s*=/.test(tag) ||
      /(?:^|\s)aria-label\s*=/.test(tag);
    if (!named) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "被 `truncate` 截断的文本没有 `title` / `aria-label` —— 截断后完整内容只能靠悬停或读屏获取，" +
          "两者都拿不到就等于用户永远看不到全名。加 `:title=\"…\"`（纯图标元素用 `aria-label` 也可）。" +
          "确属不会截断的短文案，可在文件内加 `truncate-title-ok` 注释整文件跳过。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 挂了 `whitespace-pre-wrap` 却没有强制断词的元素必须报出。
 *
 * 真实缺陷（用户 2026-10-23：群管理弹窗里的群公告「打了一堆数字，出现了横向滚动条」）：
 * `whitespace-pre-wrap` 只保证**保留换行**，它管的仍是「按词断行」。一整串数字、一条超长
 * URL、一段 sha256 都是**一个词** ⇒ 词长超过容器时它不换行而把内容撑出去；而外层弹窗的
 * 滚动容器写着 `overflow-y:auto`，规范上 `overflow-x:visible` 会随之**算成 auto**
 * ⇒ 于是出现一条横向滚动条。这类缺陷编译过、类型对、功能全正常，只有往框里粘一串
 * 数字才看得见，所以必须机器盯。
 *
 * 判据只看**真实 class 属性**（与 ③/截断那条同一口径）：注释里写一句
 * `whitespace-pre-wrap` 不能让护栏「因为注释而报红」，也不能让它「因为注释而通过」。
 * 断词的三种合法出口都算数：`break-words`（overflow-wrap:break-word）、
 * `break-all`、`break-anywhere`；用 `:style="{ wordBreak: … }"` 内联的也算。
 * 确需横向滚动的容器（代码块、日志行），在文件内加 `prewrap-break-ok` 注释整文件跳过。
 */
const PREWRAP_BREAK_EXITS = ["break-words", "break-all", "break-anywhere"];

/**
 * 数一份源码里挂了多少处 `whitespace-pre-wrap`（按**真实 class 属性**，注释不算）。
 *
 * 单独导出是为了让判据的「非空转下限」和判据本体用**同一个提取器**数分母 ——
 * 测试里再抄一份正则的话，提取器坏了而分母照数得出，那条判据就静默空转了。
 */
export function countPreWrapSites(src: string): number {
  let n = 0;
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    if (m[1].split(/\s+/).includes("whitespace-pre-wrap")) n += 1;
  }
  return n;
}

export function findPreWrapWithoutBreak(src: string): GuardIssue[] {
  if (src.includes("prewrap-break-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (!classes.includes("whitespace-pre-wrap")) continue;
    if (classes.some((c) => PREWRAP_BREAK_EXITS.includes(c))) continue;
    // 内联 :style 里的 word-break / overflow-wrap 同样是出口，别误伤
    const tag = enclosingTag(src, m.index ?? 0);
    if (/word-?break|overflow-wrap/i.test(tag)) continue;
    out.push({
      line: lineAt(src, m.index ?? 0),
      message:
        "`whitespace-pre-wrap` 没有配强制断词 —— 一整串数字/URL/sha 是**一个词**，" +
        "它不换行而把内容撑出容器，外层 `overflow-y:auto` 会连带长出横向滚动条。" +
        "补 `break-words`（要按字符断用 `break-all`）；确需横向滚动的容器加 `prewrap-break-ok`。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ⑤b 自绘菜单必须自带底（`.gosslan-menu` 只管形状，底在 `.frost`） ----------------

/**
 * `.gosslan-menu` 里**没有**背景：它只声明尺寸、内边距、描边、圆角与阴影，
 * 底与毛玻璃在另一个类 `.frost` 上（见 style.css 那两条规则）。
 *
 * 真实缺陷（用户 2026-10-09：「筛选下拉都是透明的」）：搜索面板那两个筛选菜单只挂了
 * `.gosslan-menu` ⇒ 半透过去，菜单文字和底下的结果行叠在一起。全站另外五处都是
 * `gosslan-menu frost` 成对写的，唯独这两处漏了一半 —— 而这类缺陷**编译过、类型对、
 * 功能全正常**，只有肉眼看得出，所以必须机器盯。
 *
 * 判据按**词**匹配而不是子串：`.gosslan-menu-item` / `.gosslan-menu-hint` 里也含
 * "gosslan-menu" 这七个字，子串匹配会把菜单项判成容器（假红一片）。
 * 确需无底的容器，可在文件内加 `menu-backdrop-ok` 注释整文件跳过。
 */
export function findMenuWithoutBackdrop(src: string): GuardIssue[] {
  if (src.includes("menu-backdrop-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (!classes.includes("gosslan-menu")) continue;
    if (classes.includes("frost") || classes.includes("glass")) continue;
    out.push({
      line: lineAt(src, m.index ?? 0),
      message:
        "自绘菜单只挂了 `.gosslan-menu`（形状）而没有 `.frost`（底）⇒ 弹层是透明的，" +
        "菜单文字会与底下的内容叠在一起。补一个 `frost`，或改用带底的 `.gosslan-panel`。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ⑥ 可点击元素必须能用键盘触发 ----------------

/**
 * 非交互标签（这些标签天生没有"可点击"语义，只能靠 `role` / `tabindex` / 键盘事件补）。
 * `button` / `a` / `input` / `label` / `summary` 等有原生语义，不在扫描范围。
 */
const NON_INTERACTIVE_TAGS = "div|span|li|tr|td|section|article|header|footer|p|img|main|aside|figure";

/** 元素开标签（跨行；到第一个 `>` 为止）。 */
const OPEN_TAG_RE = new RegExp(`<(${NON_INTERACTIVE_TAGS})\\b[^>]*>`, "gs");

/**
 * 从开标签里取"真实动作型"的 `@click` / `v-on:click`。
 *
 * 两种**不算动作**的写法（都是修护栏时才发现的真实存在）：
 *   —— 只有修饰符、没有表达式：`@click.stop`（这是"阻止冒泡"，不是按钮）；
 *   —— 元素本身 `aria-hidden="true"`：整块对读屏隐藏（例如遮罩层点外部关闭），
 *      给它加 `tabindex` 反而会做出"读屏看不见、键盘却能聚焦"的怪东西。
 */
function clickAction(tag: string): boolean {
  if (/aria-hidden\s*=\s*"true"/.test(tag)) return false;
  for (const m of tag.matchAll(/(?:@|v-on:)click(?:\.\w+)*\s*=\s*"([^"]*)"/g)) {
    if (m[1].trim().length > 0) return true;
  }
  return false;
}

/**
 * 检查一份 .vue 源码里"能点、但键盘够不着"的元素。
 *
 * 判据（能确定的才报）：
 *   —— 非交互标签 + 有真实动作的 `@click`；
 *   —— 同一开标签里既没有 `role`（含 `:role`），也没有 `tabindex`（含 `:tabindex`），
 *      也没有 `@keydown` / `@keyup`（含 `v-on:` 与 `:keydown` 简写）→ 报「三样都没有」。
 *   —— ★ 2026-10-10 补上另一半（roadmap N19，原本这里是**洞**）：上面那条用的是 OR，
 *      于是 `role="button"` 单独存在就放行 —— 而 role 只给"读屏念得出按钮"，**不给可聚焦性**，
 *      键盘照样 Tab 不到（真实形状：置顶行那颗 `<span role="button" @click.stop>`，
 *      嵌在 `<button>` 里、没有 tabindex）。所以现在再加一条：
 *      **静态 button 类 role + 有 @click，但既没有 tabindex、也没有键盘事件、也不是 contenteditable ⇒ 报**。
 *      只认**静态** `role="…"`：动态 `:role="…"` 推断不出值，报了就是假红。
 *      `contenteditable` 自己就可聚焦；`dialog` / `textbox` 这类**容器角色**不该被塞进 Tab 序
 *      （`ImageLightbox` 的遮罩与输入框正是这两类，收紧时实测它们都不该报 —— 收进名单就是造两条假红）。
 * 逃生阀：文件里带 `tap-keyboard-ok` 注释则整文件跳过。
 */
const BUTTONISH_ROLE_RE = /\b(button|link|menuitem|checkbox|radio|tab|switch)\b/;

export function findTappableWithoutKeyboard(src: string): GuardIssue[] {
  if (src.includes("tap-keyboard-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(OPEN_TAG_RE)) {
    const tag = m[0];
    if (!clickAction(tag)) continue;
    const hasRole = /(?:^|\s)(?::|v-bind:)?role\s*=/.test(tag);
    const hasTabindex = /(?:^|\s)(?::|v-bind:)?tabindex\s*=/.test(tag);
    const hasKey = /(?:@|v-on:|:)key(?:down|up)/.test(tag);
    const editable = /contenteditable\s*=/.test(tag);
    const staticRole = tag.match(/(?:^|\s)role\s*=\s*"([^"]*)"/)?.[1] ?? null;
    if (!hasRole && !hasTabindex && !hasKey) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "`" +
          m[1] +
          "` 上有 @click，但它没有原生按钮语义 —— 键盘用户 Tab 不到、按回车也没反应" +
          "（读屏只会念成普通文本）。请改用 <button type=\"button\">，或补上 " +
          "`role=\"button\"` + `tabindex=\"0\"` + `@keydown.enter`（空格键用 `@keydown.space.prevent`）。" +
          "确实不该聚焦的元素（遮罩层等），加 `aria-hidden=\"true\"` 或用 `@click.stop` 表明它只是拦事件；" +
          "整文件例外可加 `tap-keyboard-ok` 注释。",
      });
      continue;
    }
    if (staticRole !== null && BUTTONISH_ROLE_RE.test(staticRole) && !hasTabindex && !hasKey && !editable) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          "`" +
          m[1] +
          "` 写了 `role=\"button\"` 但没有 `tabindex` —— role 只让读屏念出「这是按钮」，" +
          "**不给可聚焦性** ⇒ 键盘用户仍然 Tab 不到（roadmap N19 那个洞）。" +
          "请改用 <button type=\"button\">（自带语义、自带聚焦与回车），" +
          "或补 `tabindex=\"0\"` + `@keydown.enter` / `@keydown.space.prevent`；" +
          "它若嵌在另一个可聚焦元素里，那是结构问题 —— 拆成同级兄弟，别靠 role 伪装。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** ⑥ 这条尺子看得见多少个"非交互标签 + 真实动作 @click"？真实树那半用它做阳性对照。 */
export function countClickActionTags(raw: string): number {
  let n = 0;
  for (const m of raw.matchAll(OPEN_TAG_RE)) if (clickAction(m[0])) n += 1;
  return n;
}

// ---------------- ⑦ `outline-none` 必须自带焦点指示 ----------------

/**
 * 可见的焦点指示替代写法（Tailwind）。
 *
 * ⚠️ 为什么必须显式要求：全局焦点环用的是
 * `:where(button, a, input, textarea, select, [tabindex], [contenteditable]):focus-visible`
 * —— `:where()` 让整条选择器的特异性变成 **0**，而 `.outline-none`
 * （`outline: 2px solid transparent; outline-offset: 2px`）是 0,1,0。
 * 于是**只要元素带 `outline-none`，全局焦点环一定被它覆盖**（透明 2px 边框 = 看不见）。
 */
const FOCUS_INDICATOR_RE = /(?:focus|focus-visible):(?:ring|border|outline|bg|shadow)[-\w[]/;

/**
 * 检查一份 .vue 源码里"关掉了轮廓、却没给替代焦点指示"的元素。
 *
 * 判据：开标签里有 `outline-none`，且同一标签里既没有 `focus:ring/border/outline/bg/shadow`
 * 也没有 `focus-visible:` 同款 → 报出。
 *
 * ## 两个逃生阀（粒度不同，按需选）
 *
 * ① **元素级**（推荐）：给该元素加 `data-focus-ring-ok` 属性 ⇒ **只豁免这一个元素**，
 *    文件里其它元素照旧受保护。
 * ② **文件级**：文件里带 `focus-ring-ok:file` 注释 ⇒ 整文件跳过。只适用于"整个组件只有
 *    一个不该画环的容器"的场合（菜单容器 `role="menu" tabindex="-1"`、全屏对话框容器
 *    `role="dialog" tabindex="-1"` —— 它们的焦点由内部条目承担）。
 *
 * ⚠️ **文件级令牌为什么带 `:file` 后缀**：元素级的 `data-focus-ring-ok` **含有**
 * `focus-ring-ok` 这个子串，所以文件级判据若还写成 `src.includes("focus-ring-ok")`，
 * 就会把"只豁免了一个元素"的文件当成"整文件豁免" ⇒ 元素级标记形同虚设、护栏静默失效。
 * 两个令牌必须是互不为子串的。
 *
 * ⚠️ **为什么必须有元素级**（2026-09-16）：`MessageComposer.vue` 因为"消息输入框不画焦点环"
 * 这个**元素级**需求，用了**文件级**逃生阀 ⇒ 整个文件（含其中的按钮等键盘可聚焦元素）
 * 一起失去本条保护，且 `scripts/verify-guards.py` 里注入该文件的用例退化成**空转**
 * （改坏也不报），而项目里没有任何东西自动跑 verify-guards，所以一直没人发现。
 * 粒度给错，护栏就会在你看不见的地方悄悄失效。
 */
export function findOutlineNoneWithoutFocusRing(src: string): GuardIssue[] {
  if (src.includes("focus-ring-ok:file")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (!classes.includes("outline-none")) continue;
    const tag = enclosingTag(src, m.index ?? 0);
    if (FOCUS_INDICATOR_RE.test(tag)) continue;
    // 元素级逃生阀：只豁免**这一个**元素（见函数上方"两个逃生阀"）
    if (tag.includes("data-focus-ring-ok")) continue;
    out.push({
      line: lineAt(src, m.index ?? 0),
      message:
        "带 `outline-none` 却没有替代的焦点指示 —— 全局焦点环用的是 `:where(...)`（特异性 0），" +
        "会被 `.outline-none`（特异性 0,1,0）**静默覆盖**，键盘用户看不到焦点在哪（WCAG 2.4.7）。" +
        "两种改法：① 直接删掉 `outline-none`（让全局环生效，文本框类控件推荐这个）；" +
        "② 自己给一个可见指示，如 `focus:ring-2 focus:ring-primary` / `focus:border-[…]`。" +
        "确实不该画环时用逃生阀，**优先元素级**：给这个元素加 `data-focus-ring-ok`（只豁免它）；" +
        "只有整个组件都该跳过时才用文件级的 `focus-ring-ok:file` 注释 —— 文件级会让同文件里" +
        "其它键盘可聚焦元素一起失去保护。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ⑧ 小尺寸可交互元素必须有 tap-safe ----------------

/**
 * 小尺寸工具类：Tailwind 里 `h-8` = 32px、`h-7` = 28px、`h-6` = 24px、`h-5` = 20px，
 * 全部**小于 HIG 的 44pt 最小点按目标**。（`h-11` = 44px 才是达标尺寸。）
 */
const SMALL_SIZE_RE = /\b(?:h-4|w-4|h-5|h-6|h-7|h-8)\b/;

/** 参与点按判定的标签（`button`/`a`/`label`/`select`/`input` 天生可交互；其余看 `@click`）。 */
const TAPPABLE_TAG_RE = /<(button|a|div|span|li|label|select|input)\b[^>]*>/gs;

/**
 * 检查一份 .vue 源码里"点按目标过小、又没有触屏撑大"的元素。
 *
 * 判据：可交互元素（原生可交互标签，或带 `@click`）+ class 里有小尺寸工具类
 * + 同一开标签里没有 `tap-safe` → 报出。
 *
 * ⚠️ 说清 `tap-safe` 的能力边界（写进提示里，免得以为加上就万无一失）：
 * 它只在 `@media (pointer: coarse)` 下把热区**垂直**撑 ±8px ⇒ `h-6`→40、`h-7`→44、`h-8`→48；
 * 因此 `h-5`（20px→36px）仍然不达标，必须改成更大的尺寸。
 * 逃生阀：文件里带 `tap-target-ok` 注释则整文件跳过。
 */
export function findSmallTapTargets(src: string): GuardIssue[] {
  if (src.includes("tap-target-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(TAPPABLE_TAG_RE)) {
    const tag = m[0];
    const native = /^<(button|a|label|select|input)\b/.test(tag);
    if (!native && !/(?:@|v-on:)click/.test(tag)) continue;
    const classMatch = tag.match(/class="([^"]*)"/);
    if (!classMatch) continue;
    if (!SMALL_SIZE_RE.test(classMatch[1])) continue;
    if (/\btap-safe\b/.test(classMatch[1])) continue;
    out.push({
      line: lineAt(src, m.index ?? 0),
      message:
        "小尺寸可交互元素没有 `tap-safe` —— iOS HIG 的最小点按目标是 44×44pt，" +
        "而 `h-8`=32px / `h-7`=28px / `h-6`=24px，手指容易点不中或误触相邻项。" +
        "加 `tap-safe`（`:pointer: coarse` 下热区垂直 +16px：h-6→40、h-7→44、h-8→48）；" +
        "`h-5`（20px）即便加了也只有 36px，请改用 `h-7` 以上；`h-4`（16px）加了也只有 32px，" +
        "而 tap-safe 只撑垂直方向，横向热区仍等于可见盒 —— 行内挨着别的按钮时先想清楚会不会误触。" +
        "确属不需要触屏撑大的场合可加 `tap-target-ok` 注释整文件跳过。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ⑨ `as="template"` 插槽不得有注释/多根节点 ----------------

/** 需要"单子节点"约束的第三方组件属性（Headless UI 的模板渲染）。 */
const TEMPLATE_ATTR_RE = /<([A-Z][\w]*)\b[^>]*\bas="template"[^>]*>/g;

/**
 * 检查一份 .vue 源码里 `as="template"` 的**直接插槽内容**是否安全。
 *
 * 判据（只报能确定的）：
 *   ① 直接内容里出现 HTML 注释 ⇒ 报（dev 构建把注释编译成节点，Headless UI 会抛错）；
 *   ② 直接子节点里的**顶层元素多于一个** ⇒ 报（同样会抛错）。
 * 嵌套元素内部的内容不参与判定（先按标签配对把子树跳过）。
 */
export function findTemplateSlotIssues(src: string): GuardIssue[] {
  if (src.includes("template-slot-ok")) return [];
  const out: GuardIssue[] = [];
  for (const m of src.matchAll(TEMPLATE_ATTR_RE)) {
    const tag = m[1];
    const openEnd = (m.index ?? 0) + m[0].length;
    // 是否为自闭合（`<Foo as="template" />` 没有插槽，跳过）
    if (m[0].trimEnd().endsWith("/>")) continue;

    // 扫描到配对结束标签，同时统计「顶层」元素与注释
    const closeTag = `</${tag}>`;
    let i = openEnd;
    let depth = 0;
    let topLevel = 0;
    let comments = 0;
    while (i < src.length) {
      if (src.startsWith(closeTag, i) && depth === 0) break;
      if (src.startsWith(`<${tag}`, i)) {
        depth += 1;
        i += tag.length + 1;
        continue;
      }
      if (src.startsWith(closeTag, i)) {
        depth -= 1;
        i += closeTag.length;
        continue;
      }
      if (src.startsWith("<!--", i)) {
        if (depth === 0) comments += 1;
        const end = src.indexOf("-->", i);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      // 跳过注释/字符串之外的普通标签：遇到元素开标签且 depth=0 就计一个顶层节点，
      // 并把它的子树整体跳过（避免把子元素算成兄弟）。
      if (src[i] === "<" && /[A-Za-z]/.test(src[i + 1] ?? "")) {
        let j = i;
        const nameMatch = /^<([A-Za-z][\w-]*)/.exec(src.slice(i));
        const name = nameMatch ? nameMatch[1] : "";
        const tagText = src.slice(i, src.indexOf(">", i) + 1);
        const selfClosing = /\/>/.test(tagText);
        // `v-if` / `v-else-if` / `v-else` 是一条链：运行时**只渲染一个**节点，
        // 所以后续的 `v-else*` 分支不再单独计数（否则会误报，第一次跑这条护栏就误报了
        // BaseModal 的 DialogPanel v-if/v-else 两个分支）。
        const isElseBranch = /\bv-else(-if)?\b/.test(tagText);
        if (depth === 0 && !isElseBranch) topLevel += 1;
        if (selfClosing || !name) {
          i = src.indexOf(">", i) + 1;
          continue;
        }
        // 跳过整棵子树
        j = i;
        while (j < src.length) {
          if (src.startsWith(`</${name}>`, j)) {
            j += name.length + 3;
            break;
          }
          if (src.startsWith("<" + name, j) || (src[j] === "<" && /[A-Za-z]/.test(src[j + 1] ?? ""))) {
            j = src.indexOf(">", j) + 1;
            continue;
          }
          j += 1;
        }
        i = j;
        continue;
      }
      i += 1;
    }

    if (comments > 0) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          `\`<${tag} as="template">\` 的插槽里有 HTML 注释 —— dev 构建**保留注释**，` +
          "它会变成一个额外的节点，Headless UI 随即抛 \"Passing props on template!\"，" +
          "Vue 渲染抛错后整个界面都 patch 不动（现象就是\"窗口卡死\"）。" +
          "把注释放到该组件**外面**（或挪进 <script>）。",
      });
    } else if (topLevel > 1) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          `\`<${tag} as="template">\` 的插槽里有 ${topLevel} 个顶层节点 —— Headless UI 的` +
          "模板渲染要求**恰好一个**，多根会抛 \"Passing props on template!\"。" +
          "请用一层真实元素包起来，或改用 `as=\"div\"`。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ⑤ 文本气泡排版必须与虚拟列表高度度量一致 ----------------

/** Tailwind 默认 `leading-*` → 行高倍数（tailwind.config.js 未覆盖 leadings，故可静态判定）。 */
const LEADING_RATIO: Record<string, number> = {
  "leading-none": 1,
  "leading-tight": 1.25,
  "leading-snug": 1.375,
  "leading-normal": 1.5,
  "leading-relaxed": 1.625,
  "leading-loose": 2,
};

/** 从一份 .vue 源码里取「类名恰好等于 cls」的元素的 `class` 片段位置（-1 = 没有）。 */
function classAttrIndexOf(src: string, cls: string): number {
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const classes = m[1].split(/\s+/).filter(Boolean);
    if (classes.includes(cls)) return m.index ?? -1;
  }
  return -1;
}

/**
 * 检查「气泡真实渲染高度」与「虚拟列表估算高度」这一对**必须成对演化**的常量。
 *
 * 为什么要机器盯（与 ③ 未读徽标同一类）：`previewMetrics.ts` 的
 * `TEXT_LINE_RATIO` / `TEXT_BUBBLE_PADDING` 是 `MessageTextBubble.vue` 的
 * `leading-*` / `py-*` 的**镜像**。改了一边忘了另一边时，编译通过、测试全绿、
 * 单条消息看着也正常 —— 只有**滚动到相邻消息**才会发现互相遮挡/留白跳变。
 * 这种「写对了但不起作用、且不在出错点报错」正是本模块要守的东西。
 *
 * 参数：组件源码 + 度量文件源码。返回不一致项（含建议修正的具体数值）。
 */
export function checkBubbleMetricsCoupling(
  bubbleSrc: string,
  metricsSrc: string,
): GuardIssue[] {
  const out: GuardIssue[] = [];
  const at = classAttrIndexOf(bubbleSrc, "min-w-0");
  if (at < 0) {
    return [{ line: 0, message: "在气泡组件里找不到带 `min-w-0` 的根元素（度量对照失效）" }];
  }
  const tag = enclosingTag(bubbleSrc, at);
  const line = lineAt(bubbleSrc, at);
  const classes = (tag.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);

  // 行高：必须先能识别出 `leading-*`，再从度量文件取比值。
  const leadingClass = classes.find((c) => c in LEADING_RATIO);
  const ratioRaw = metricsSrc.match(/TEXT_LINE_RATIO\s*=\s*([\d.]+)/)?.[1];
  if (!leadingClass || ratioRaw === undefined) {
    out.push({
      line,
      message:
        "无法核对气泡行高：组件缺少可识别的 `leading-*` 类，或度量文件里找不到 `TEXT_LINE_RATIO`。" +
        "两者必须成对存在，否则虚拟列表无法估算高度。",
    });
  } else if (Math.abs(LEADING_RATIO[leadingClass] - Number(ratioRaw)) > 1e-9) {
    out.push({
      line,
      message:
        `气泡用 \`${leadingClass}\`（行高 ${LEADING_RATIO[leadingClass]}），` +
        `但预览度量 \`TEXT_LINE_RATIO\` = ${ratioRaw} —— 两边不一致会让虚拟列表的` +
        `高度估算与真实渲染对不上（相邻消息遮挡）。把度量值改成 ${LEADING_RATIO[leadingClass]}。`,
    });
  }

  // 纵向内边距：`py-N` 一档 = 4px，上下合计 ×2。
  const pyClass = classes.find((c) => /^py-[\d.]+$/.test(c));
  const paddingRaw = metricsSrc.match(/TEXT_BUBBLE_PADDING\s*=\s*(\d+)/)?.[1];
  if (!pyClass || paddingRaw === undefined) {
    out.push({
      line,
      message:
        "无法核对气泡纵向内边距：组件缺少 `py-*` 类，或度量文件里找不到 `TEXT_BUBBLE_PADDING`。",
    });
  } else {
    const expected = Number(pyClass.slice(3)) * 4 * 2;
    if (expected !== Number(paddingRaw)) {
      out.push({
        line,
        message:
          `气泡用 \`${pyClass}\`（上下内边距合计 ${expected}px），` +
          `但预览度量 \`TEXT_BUBBLE_PADDING\` = ${paddingRaw} —— 同上，改成 ${expected}。`,
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

  // ②-1 降级媒体查询必须晚于 .glass / .frost 的顶级定义
  const baseIdx = Math.max(
    lastTopLevelDefIndex(css, "\\.glass"),
    lastTopLevelDefIndex(css, "\\.frost"),
  );
  if (baseIdx < 0) {
    out.push({ line: 0, message: "style.css 里找不到 .glass / .frost 的定义" });
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
  // ⚠️ 定位那个**块**要按形状（选择器 + `{`），不能用 indexOf 找字面量：
  // 2026-10-10 加 .kb-reveal 时踩到 —— style.css 里多了一句**注释**写到 `@media (hover: none)`，
  // indexOf 便落在注释上，于是"块外的基础规则"被读成"块内的" ⇒ 真实文件当场假红。
  const hoverNoneAt = css.search(/@media\s*\(\s*hover\s*:\s*none\s*\)\s*\{/);
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

  // ②-2b `.kb-reveal` 那一家（roadmap N19，键盘必须能到达悬停才现的操作）有两份，缺一不可：
  //   基础那份在 (hover:none) **之外** —— 它管"有 hover 的设备上按悬停/聚焦才显形"；
  //   兜底那份在 (hover:none) **之内** —— 触屏既没有 hover、也常常没有键盘，少了它那颗操作就是不存在。
  // 只查其中一半都会漏：只看"在块内有一份"会把"基础那份也写进块里"放过去
  //（那样桌面上既不藏也不随聚焦显形，等于把这条改动整体作废，而界面看起来"没问题"）。
  const kbBase = css.indexOf(".kb-reveal {");
  if (kbBase < 0) {
    out.push({
      line: 0,
      message: "style.css 缺少 .kb-reveal 的定义（roadmap N19：hover 揭示的操作必须有键盘入口）",
    });
  } else if (kbBase > hoverNoneAt) {
    out.push({
      line: lineAt(css, kbBase),
      message:
        ".kb-reveal 的**基础**规则写在 @media (hover: none) 之内 ⇒ 有 hover 的设备上它既不藏起操作、" +
        "也不随键盘聚焦显形（这一家的前提没了）。基础那份要在块外。",
    });
  } else if (css.indexOf(".kb-reveal {", hoverNoneAt) < 0) {
    out.push({
      line: lineAt(css, kbBase),
      message:
        ".kb-reveal 在 @media (hover: none) 里**没有**兜底那份 ⇒ 触屏上悬停与键盘聚焦都不会发生，" +
        "那颗操作在手机上看不见也点不着（pointer-events 也要一起放开，光 opacity:1 只是看得见）。",
    });
  }

  // ②-3 触屏命中扩展块里**不得直接声明 `position`**
  // ------------------------------------------------------------------
  // 真实缺陷（用户 2026-09-12 安卓实测）：「回到最新」按钮写的是
  // `tap-safe absolute bottom-4 right-5`，而 `@media (pointer: coarse)` 里的
  // `.tap-safe { position: relative }` 与本文件位置关系是：本文件在 `@tailwind utilities`
  // **之后**、两者特异性**相同**（都是单类）⇒ 触屏设备上 position 被改成 relative，
  // 按钮掉回文档流、不再贴右下角。桌面 `pointer: fine` 不走这条媒体查询，所以只有安卓复现。
  // 判据：该块内任何声明了 `position:` 的选择器都必须是 `:where(...)`（特异性 0），
  // 这样组件的 `absolute`/`fixed` 工具类才能正常生效。用 `:where()` 也让这条**面向未来**：
  // 以后往这个块里加任何"只负责扩大命中区"的类，都不会再压掉别人的定位。
  out.push(...findOverridingPositionInCoarsePointer(css));
  return out.sort((a, b) => a.line - b.line);
}

/** `@media (pointer: coarse)` 块内直接声明 `position` 的选择器（`:where()` 包裹的除外）。 */
function findOverridingPositionInCoarsePointer(css: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  let cursor = 0;
  while (true) {
    const at = css.indexOf("@media (pointer: coarse)", cursor);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    if (open < 0) break;
    // 括号配平找块尾
    let depth = 0;
    let end = css.length - 1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    // 去掉注释（并且**等长替换成空白**，这样 ruleRe 的下标仍能对回原文行号）：
    // 否则注释会被当成选择器文本（这个块里的注释恰好写了 `:where()` 与类名）。
    const body = css
      .slice(open + 1, end)
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(body)) !== null) {
      const selector = m[1].trim();
      if (!/(^|;)\s*position\s*:/.test(m[2])) continue;
      if (selector.startsWith(":where(")) continue; // 特异性 0 ⇒ 压不掉工具类
      out.push({
        line: lineAt(css, open + 1 + m.index),
        message:
          `@media (pointer: coarse) 里的 \`${selector}\` 直接声明了 position：` +
          "本文件在 @tailwind utilities 之后且特异性相同，会覆盖组件自己的定位" +
          "（真实缺陷：安卓端「回到最新」按钮从 absolute 变成 relative）。" +
          "请写成 `:where(…)` 把特异性压到 0。",
      });
    }
    cursor = end + 1;
  }
  return out;
}

// ---------------- ⑧ 聊天区「文本选择」契约（用户 2026-09-13） ----------------

/**
 * 取 `selector { … }` 的规则体（朴素匹配：本项目 CSS 里这几条规则都没有嵌套花括号）。
 * ⚠️ 先剥注释再找：style.css 的注释里大量出现 `.quote-block` / `html` / `textarea` 这类**选择器字面量**，
 * 不剥就会把注释后面那条不相干的规则当成答案（2026-10-26 实测：新增一段说明注释的措辞，
 * 让隔壁那条引用块判据当场报出假红）。
 */
function cssRuleBody(css: string, selector: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const i = stripped.indexOf(selector);
  if (i < 0) return null;
  const open = stripped.indexOf("{", i);
  const close = stripped.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return stripped.slice(open + 1, close);
}

/**
 * 把 CSS 拆成「选择器 → 声明体」的成对列表，**先剥掉注释**。
 * 为什么不用上面的 `cssRuleBody`：它是 `indexOf(选择器)` + 下一个 `{`，而本仓 style.css 的
 * 注释里就写着 `html` / `textarea` 这些词 ⇒ 它会取到注释后面那条不相干的规则。
 */
function cssRulesOutsideComments(css: string): Array<[string, string]> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const rules: Array<[string, string]> = [];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push([m[1], m[2]]);
  }
  return rules;
}

/** 取「class 里含 needle 的那个 <img …> 标签」的完整文本。 */
function imgTagWithClass(src: string, needle: string): string | null {
  for (const m of src.matchAll(/<img\b[^>]*>/g)) {
    if (m[0].includes(needle)) return m[0];
  }
  return null;
}

export interface SelectionContractSources {
  /** `components/message/MessageTextBubble.vue` */
  textBubble: string;
  /** `components/message/MessageAvatar.vue` */
  avatar: string;
  /** `components/MessageItem.vue` */
  messageItem: string;
  /** `App.vue` */
  app: string;
  /** `components/message/MessageLinkText.vue` */
  linkText: string;
  /** `style.css` */
  css: string;
}

/**
 * 聊天区的**文本选择契约**。
 *
 * 用户 2026-09-13 报的三件事，全都是"写对了但不起作用"的静默退化：
 *
 * ① PC 上拖选气泡文字，**刚选中立刻被取消**
 *    —— 正文被 `px-3 py-1.5` 包着，从内边距/气泡边缘起拖时选区锚点落在不可选区域，
 *       WebKit 会立刻收敛选区；正文里的表情是 `<img>`，浏览器默认允许拖图，
 *       拖选划过表情会改成"拖图片"，同样打断选区。
 * ② **头像不该被选中**（用户明确要求：将来会有点击事件，但依然不能选择）。
 * ③ 移动端**选中文字后不弹系统「复制/全选」工具条**
 *    —— `button,[role=button]` 那条把 `-webkit-touch-callout` 关了会盖住正文；
 *       全局 `contextmenu` 无条件 `preventDefault()` 也会吃掉选区菜单
 *       （Android WebView 的选择工具条依赖它的默认行为）。
 *
 * 判据全部是"能不能选中/拖拽"的静态事实，改坏了不会报错、只会让用户用不了，
 * 所以必须由机器盯住。
 */
export function checkSelectionContract(s: SelectionContractSources): GuardIssue[] {
  const out: GuardIssue[] = [];

  // ① 正文必须可选字。
  //    ⚠️ 这个类在触屏下**不再**意味着"长按让路给原生选字"（那是 4.3.0 之前的模型）：
  //    现在 `@media (pointer: coarse)` 会把正文气泡里的它关掉选中，选字改走菜单里的
  //    「选择文字」二级入口（见 style.css 与 utils/longPress.ts）。
  if (!s.textBubble.includes("gosslan-selectable")) {
    out.push({
      line: 0,
      message:
        "MessageTextBubble：正文缺少 `gosslan-selectable` —— 消息文字将无法选字/复制，" +
        "「选择文字」模式也没有可选的落点。",
    });
  }
  // ② 气泡根也要可选：否则从内边距起拖会被 WebKit 立刻收敛（用户实测的"刚选中就没了"）
  const rootSelectable = [...s.textBubble.matchAll(CLASS_ATTR_RE)].some((m) =>
    m[1].split(/\s+/).includes("select-text"),
  );
  if (!rootSelectable) {
    out.push({
      line: 0,
      message:
        "MessageTextBubble：气泡根缺少 `select-text` —— 从气泡内边距/边缘起拖时选区锚点落在" +
        "不可选区域，WebKit 会立刻把选区收敛掉（表现为「刚选中立马取消选中」）。",
    });
  }
  // ③ 正文里的表情图片必须禁用拖拽（否则拖选划过表情会变成拖图片、选区中断）
  const emojiImg = imgTagWithClass(s.textBubble, "emoji-img");
  if (!emojiImg) {
    out.push({ line: 0, message: "MessageTextBubble：找不到 `class=\"emoji-img\"` 的表情 `<img>`（模板结构变了？）。" });
  } else if (!emojiImg.includes('draggable="false"')) {
    out.push({
      line: 0,
      message: "MessageTextBubble：表情 `<img>` 缺少 `draggable=\"false\"` —— 拖选划过表情会被浏览器改成拖图片，选区中断。",
    });
  }

  // ④ 头像不可选、不可拖（用户明确要求）
  const avatarBox = cssRuleBody(s.css, ".gosslan-avatar-box");
  if (!avatarBox || !/user-select:\s*none/.test(avatarBox)) {
    out.push({
      line: 0,
      message: "style.css：`.gosslan-avatar-box` 缺少 `user-select: none` —— 头像会被拖选进选区（用户要求头像不可选）。",
    });
  }
  const avatarImg = imgTagWithClass(s.avatar, 'class="h-full w-full object-cover"');
  if (avatarImg && !avatarImg.includes('draggable="false"')) {
    out.push({
      line: 0,
      message: "MessageAvatar：头像 `<img>` 缺少 `draggable=\"false\"` —— 拖动头像会变成拖图片。",
    });
  }

  // ⑤ 表情图片同样不许拖（CSS 兜底，防止某个调用点忘了 draggable 属性）
  const emojiCss = cssRuleBody(s.css, ".emoji-img");
  if (!emojiCss || !/-webkit-user-drag:\s*none/.test(emojiCss)) {
    out.push({
      line: 0,
      message: "style.css：`.emoji-img` 缺少 `-webkit-user-drag: none` —— 正文表情仍可被拖走、打断选区。",
    });
  }
  // ⑤-b 上面那条只兜住了表情。全仓 26 个 `<img>` 里只有 2 个自己写了 `draggable="false"`，
  // 所以划选文字划过**头像 / 图片气泡 / 文件图标**时依旧会变成"拖图片"（选区中断），
  // 桌面端还能把图片拖出窗口（原生应用做不到这件事）。兜底收口到元素选择器一份。
  const imgCss = cssRuleBody(s.css, "img");
  if (!imgCss || !/-webkit-user-drag:\s*none/.test(imgCss)) {
    out.push({
      line: 0,
      message: "style.css：全局 `img` 规则缺少 `-webkit-user-drag: none` —— 头像/图片又会打断划选、可被拖出窗口。",
    });
  }
  // ⑥ 可选文本必须显式打开 touch-callout，否则 iOS/Android 选中后不弹「复制」工具条
  const selCss = cssRuleBody(s.css, ".gosslan-selectable");
  if (!selCss || !/-webkit-touch-callout:\s*default/.test(selCss)) {
    out.push({
      line: 0,
      message:
        "style.css：`.gosslan-selectable` 缺少 `-webkit-touch-callout: default` —— " +
        "`button,[role=button]` 的 `none` 会盖住正文，选中文字后系统不弹「复制/全选」工具条。",
    });
  }

  // ⑥-b 默认方向：全局**不可选**，内容区显式开启（负责人 2026-10-26 的口径）。
  //     为什么钉方向而不是钉每一处 `select-none`：默认开着 ⇒ 每块界面 chrome 都要记得自己补，
  //     这次报出来的正是"有些补了有些没补"。默认关掉后新增界面天然不会漏，
  //     于是只剩两件事会被判：默认那一格在不在、可编辑控件有没有被顺手关掉。
  //     ⚠️ 这里刻意不用 `cssRuleBody`：它是 `indexOf(选择器)` + 下一个 `{`，而 style.css 的
  //     **注释里就写着 `html` / `textarea`** ⇒ 会取到注释后面那条不相干的规则（假绿/假红都由它）。
  const rules = cssRulesOutsideComments(s.css);
  const defaultOffOnRoot = rules.some(
    ([sel, body]) => /\b(html|:root)\b/.test(sel) && /user-select:\s*none/.test(body),
  );
  if (!defaultOffOnRoot) {
    out.push({
      line: 0,
      message:
        "style.css：根元素（html / :root）缺少 `user-select: none` —— 文本选择回到「默认全开、逐处补 none」，" +
        "新增界面会继续漏（2026-10-26 定的口径是全局默认禁用、内容区单独开启）。",
    });
  }
  const editableOpened = rules.some(
    ([sel, body]) =>
      /\b(input|textarea|select|contenteditable)\b/.test(sel) && /user-select:\s*text/.test(body),
  );
  if (!editableOpened) {
    out.push({
      line: 0,
      message:
        "style.css：`input/textarea/select/[contenteditable]` 没有单独开回 `user-select: text` —— " +
        "全局默认关掉之后，输入框里没法选词与编辑，那是拿掉已有能力，不是收紧口径。",
    });
  }

  // ⑦ 长按必须带手指抖动容差：`@touchmove` 直接接 cancel 会"一动就取消"（真机长按失灵）
  if (/@touchmove="cancelLongPress"/.test(s.messageItem)) {
    out.push({
      line: 0,
      message:
        "MessageItem：`@touchmove` 直接绑了 `cancelLongPress` —— 手指动 1px 就取消长按，" +
        "真机上等于长按永远不触发。应绑 `onTouchMove`（带像素容差）。",
    });
  } else if (!/@touchmove="onTouchMove"/.test(s.messageItem)) {
    out.push({ line: 0, message: "MessageItem：`@touchmove` 没有绑 `onTouchMove`（长按容差判据缺失）。" });
  }

  // ⑧ 有选区时必须放行系统右键菜单（否则选中的文字没法用原生「复制」）
  if (!/getSelection\(\)/.test(s.app)) {
    out.push({
      line: 0,
      message:
        "App.vue：全局 `contextmenu` 没有检查选区 —— 有选中文字时仍然 preventDefault，" +
        "用户拿不到系统「复制」，Android 的选择工具条也会被吃掉。",
    });
  }

  // ⑨ 超长链接的「中间省略」只准动样式，不许动 DOM 文本
  //
  // 用户 2026-09-16：「链接…复制的时候会复制不完整的，应该复制原始数据」——
  // 原先把截断后的字符串当 DOM 文本渲染，而**选区复制取的就是选区文本**，于是复制到残缺 URL。
  // 现行契约：`splitUrl` 切出的 head/mid/tail 三段**都在 DOM 里、顺序不变**，
  // 视觉省略只由 CSS 表达。下面每条都是"改坏了不报错、只会静默复制出错"的静态事实。
  const midCss = cssRuleBody(s.css, ".gosslan-url-mid");
  if (!midCss || !/font-size:\s*0/.test(midCss)) {
    out.push({
      line: 0,
      message:
        "style.css：`.gosslan-url-mid` 缺少 `font-size: 0` —— 要么链接中段直接显示出来，" +
        "要么（换成别的方式隐藏）中段被踢出选区，复制又得到残缺 URL。",
    });
  }
  if (midCss && /display:\s*none|visibility:\s*hidden|user-select:\s*none/.test(midCss)) {
    out.push({
      line: 0,
      message:
        "style.css：`.gosslan-url-mid` 用 display:none / visibility:hidden / user-select:none 隐藏 —— " +
        "这三种都会把中段文字从选区里剔除，选中复制又将拿到残缺链接。只能用 font-size: 0。",
    });
  }
  const dotsCss = cssRuleBody(s.css, ".gosslan-url-dots");
  if (!dotsCss || !/background-image/.test(dotsCss)) {
    out.push({
      line: 0,
      message:
        "style.css：`.gosslan-url-dots` 必须仍是 CSS 画的点（含 background-image）—— " +
        '改成 "…" 文本的话，省略号本身会被一起复制进 URL。',
    });
  }

  // 模板：三段齐全、DOM 顺序 head→mid→dots→tail（选区按 DOM 顺序拼接）
  // ⚠️ 判据只扫 `<a>` 标签**内部**：组件注释里也会写到这些名字，扫全文会被注释带偏。
  const anchorInner = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(s.linkText)?.[1] ?? "";
  const linkOrder = ["parts.head", "parts.mid", "gosslan-url-dots", "parts.tail"].map((k) =>
    anchorInner.indexOf(k),
  );
  if (linkOrder.some((i) => i < 0)) {
    out.push({
      line: 0,
      message: "MessageLinkText：`<a>` 里缺少 head/mid/tail（或省略号 span）—— 复制拿不到完整 URL。",
    });
  } else if (!linkOrder.every((v, i) => i === 0 || linkOrder[i - 1] < v)) {
    out.push({
      line: 0,
      message:
        "MessageLinkText：head/mid/dots/tail 的 DOM 顺序被打乱 —— 选区复制按 DOM 顺序拼接，" +
        "mid 必须夹在 head 与 tail 之间才能还原原始 URL。",
    });
  }
  // 省略号 span 内不得有任何文本（含插值）
  const dotsInner = /<span[^>]*gosslan-url-dots[^>]*>([\s\S]*?)<\/span>/.exec(anchorInner);
  if (dotsInner && dotsInner[1].trim() !== "") {
    out.push({
      line: 0,
      message: `MessageLinkText：省略号 span 里带了文本「${dotsInner[1].trim()}」—— 它会被原样复制进 URL。`,
    });
  }
  // ⑩ 引用块必须能被框进选区，且触屏下默认仍不放开
  //
  // 「选择文字」的全选范围挂在「引用块 + 正文」的容器上，而引用块本身是个 `<button>`
  // （要能点着跳原消息），会吃到全局的 `button { user-select: none }` ——
  // 没有这条覆盖，全选复制拿到的是纯正文，而操作条的「复制」给的是带引用头的完整原文，
  // 同一个气泡两条复制路径结果不一致。
  // 反过来，触屏上**不能**无条件放开：那样在引用块上长按会变成拉原生选区、
  // 弹不出消息菜单（移动端主行为被抢）。所以必须成对存在。
  const quoteCss = cssRuleBody(s.css, ".quote-block");
  if (!quoteCss || !/user-select:\s*text/.test(quoteCss)) {
    out.push({
      line: 0,
      message:
        "style.css：`.quote-block` 缺少 `user-select: text` —— 引用块的 `<button>` 会吃到全局的 " +
        "`user-select: none`，全选复制拿不到引用头，与「复制」按钮给的完整原文不一致。",
    });
  }
  const quoteTouchCss = cssRuleBody(s.css, ":not(.gosslan-selecting) .quote-block");
  if (!quoteTouchCss || !/user-select:\s*none/.test(quoteTouchCss)) {
    out.push({
      line: 0,
      message:
        "style.css：触屏下 `.gosslan-bubble-text:not(.gosslan-selecting) .quote-block` 必须保持 " +
        "`user-select: none` —— 否则在引用块上长按会拉原生选区、弹不出消息菜单。",
    });
  }

  // `<a>` 内的 span 之间不得留空白：模板空白是真实文本节点，会进选区 ⇒ 复制出的 URL 里多空格
  if (/>\s+</.test(anchorInner)) {
    out.push({
      line: 0,
      message:
        "MessageLinkText：`<a>` 里的 span 之间夹了空白（换行/缩进）—— 模板空白会成为文本节点、" +
        "被选进选区，复制出来的 URL 中间会多出空格。写成一行。",
    });
  }

  return out;
}

// ---------------- ⑨ 文本输入类的焦点提示：不许画外圈方框 ----------------

/**
 * 文本输入类的焦点提示必须画在**边线**上，不能画成外圈方框。
 *
 * 真实反馈（用户 2026-09-16）：「整个应用的输入框在焦点态会默认有个主题色的方框，很难看」。
 * 根因是全局焦点环的选择器里含 `input` / `textarea` / `select` / `[contenteditable]` ——
 * 浏览器对文本类控件一律把 `:focus-visible` 判成"永远成立"（**点一下就成立**，不需要键盘
 * Tab），于是每次点击输入框都会冒出一个 2px 外圈方框。消息输入框尤其突兀：它的矩形只是
 * 卡片里一块**透明的编辑区**，框出来像卡片内部浮着一个方框。
 *
 * 三条判据（缺一不可）：
 * 1. 全局 `:focus-visible` 的选择器里**不得**出现文本输入类；
 * 2. 必须有规则把 `input` / `textarea` / `select` 的焦点提示画在**边线**上（与应用既有的
 *    `focus:border-[var(--gosslan-primary)]` 同一套观感）；
 * 3. 消息输入框的卡片必须带上 `gosslan-composer` 钩子（`:focus-within` 变边框色）——
 *    编辑区自己不能画框，少了这条消息输入框就完全没有焦点提示。
 */
export function checkTextFieldFocusRing(css: string, composer: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  const textControls = ["input", "textarea", "select", "contenteditable"];

  // ⚠️ 先**按原长度**把注释抹掉（换行保留 ⇒ 行号与下标不变）：说明这条规则的那段注释里
  // 天然会提到 `input` / `textarea` / `[contenteditable]`，不抹掉就会"被自己的说明误伤"
  // （本项目踩过这种假阳性）。
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  // ① 全局 :focus-visible 规则的选择器里不许有文本输入类
  let scanned = 0;
  for (const m of code.matchAll(/([^{}]*:focus-visible[^{}]*)\{/g)) {
    scanned += 1;
    const selector = m[1];
    const offenders = textControls.filter((t) => selector.includes(t));
    if (offenders.length > 0) {
      // 行号要落在**选择器**那一行（匹配段会带上选择器前面的换行/缩进）
      const at = (m.index ?? 0) + Math.max(0, selector.search(/\S/));
      out.push({
        line: lineAt(css, at),
        message:
          "全局 :focus-visible 的选择器里不该有文本输入类（" +
          offenders.join(" / ") +
          "）：浏览器对它们恒判 :focus-visible ⇒ **点一下**输入框就冒出一个外圈方框" +
          "（用户 2026-09-16 反馈）。文本输入类的焦点提示请画在边线上。",
      });
    }
  }
  if (scanned === 0) {
    out.push({ line: 0, message: "style.css 里找不到任何 :focus-visible 规则（键盘焦点环被删了？）" });
  }

  // ② 文本输入类必须有一条"边线级"的焦点提示
  if (!/input:focus[\s\S]{0,160}?textarea:focus[\s\S]{0,160}?select:focus/.test(code)) {
    out.push({
      line: 0,
      message:
        "找不到文本输入类的焦点提示规则（形如 `input:focus, textarea:focus, select:focus { … }`）：" +
        "去掉外圈方框之后，本来就没有边框的输入框会完全没有焦点提示（WCAG 2.4.7）。",
    });
  }

  // ③ 消息输入框的卡片钩子
  if (!/\.gosslan-composer\s*:focus-within/.test(code)) {
    out.push({
      line: 0,
      message:
        "style.css 缺少 `.gosslan-composer:focus-within` 规则：消息输入框的编辑区不能画外框，" +
        "焦点提示必须挂在卡片边框上。",
    });
  }
  if (!composer.includes("gosslan-composer")) {
    out.push({
      line: 0,
      message:
        "MessageComposer 的卡片必须带 `gosslan-composer` 类（style.css 的焦点钩子），" +
        "否则消息输入框没有焦点提示。",
    });
  }
  return out;
}

// ---------------- ㉛ 写了「整页顶部安全区」的文件必须也写底部 ----------------

/**
 * 判据只认**类名出现的位置**，也就是文件顶部那份共用的 `CLASS_ATTR_RE`（它同时吃 `class="…"`
 * 与 `:class="…"`，后者里面的多行数组也能读到）。
 * ⚠️ 不复用它、改成"整份文件当文本搜"的第一版被我自己的注释喂饱了：
 * 我在 HTML 注释里写了 `.safe-bottom` 这个词 ⇒ 把底部内距真删掉，判据照样绿。
 * 注释能喂饱的判据不是判据。
 */
const TOP_INSET_RE = /pt-\[env\(safe-area-inset-top[^\]]*\)\]/;
const BOTTOM_INSET_RE = /\bsafe-bottom\b|pb-\[[^\]]*env\(safe-area-inset-bottom/;

/**
 * 检查"用 `pt-[env(safe-area-inset-top)]` 给自己让开状态栏/挖孔"的全屏形态有没有同时让开底部。
 *
 * 为什么这是判据而不是审美（roadmap N16）：iOS 的 Home Indicator 区域是 34px，Android 手势条同理，
 * 而 `env()` 只有在 `viewport-fit=cover` 下才是真值 —— 现读 5 个 HTML 入口（`index/logs/preview/settings/todos`）
 * **全都带 cover** ⇒ 顶部被让开了、底部没人读，最后一行就落在指示条底下（改了才发现原来三处都是这个形状）。
 *
 * ⚠️ 分母故意只收「类名里这一种写法」：`:style="{top:'calc(env(safe-area-inset-top,…))'}"`（`ToastHud`、
 * `ImageLightbox`）不触发 —— 前者是顶部飘条本来就不需要底部，后者自己已经写了底部。
 * ⚠️ 说清它买不到哪一半：本判据只看**类名里有没有人读底部内距**，不判它挂在哪一层、
 * 也不判真机上到底让开了多少 px —— 挂错层（比如挂在不滚的外壳而不是滚动层里）它照样放行，
 * 那一半只有带安全区的真机可证（Smoke-11）。
 * 逃生阀：文件级注释 `safe-area-ok`（整份文件确实不需要底部时才用，例：只画顶部飘条的组件）。
 */
export function findTopInsetWithoutBottomInset(src: string): GuardIssue[] {
  if (src.includes("safe-area-ok")) return [];
  const hits = [...src.matchAll(CLASS_ATTR_RE)];
  const classes = hits.map((m) => m[1]);
  const hit = classes.findIndex((c) => TOP_INSET_RE.test(c));
  if (hit === -1) return [];
  if (classes.some((c) => BOTTOM_INSET_RE.test(c))) return [];
  return [
    {
      line: lineAt(src, hits[hit].index),
      message:
        "写了 `pt-[env(safe-area-inset-top)]` 却没写底部安全区 —— 这是整屏形态（overlay 页 / fullscreen 弹窗），" +
        "顶部让开了状态栏，底部那一层内容会落在 iOS Home Indicator（≈34px）或 Android 手势条底下，" +
        "滚到最后一行正好看不见它。两种改法：① 给**滚动那一层**加现成工具类 `safe-bottom`；" +
        "② 那一层本来有自己的 `pb`/`p-*` 时写 `pb-[max(env(safe-area-inset-bottom),1rem)]` " +
        "（`max()` 保住原有的内距，桌面 `env()`=0 时视觉零变化）。" +
        "⚠️ 判据只看类名里有没有人读底部内距（注释里提一个字不算 ⇒ 别指望写注释过关），" +
        "也不判挂在哪一层 —— 那一半要真机看（Smoke-11）。" +
        "确实只画顶部、不需要底部时在代码里加 `safe-area-ok` 注释整文件跳过。",
    },
  ];
}

// ---------------- ㊱ 桌面弹窗必须让开自绘标题栏（窗口显示安全区） ----------------
/**
 * 判据：铺满视口的浮层外壳顶部必须读 `var(--gosslan-window-safe-top)`，不许裸 `inset-0` 盖顶。
 *
 * 为什么这是判据而不是审美：桌面窗口是 `decorations(false)` + **流内**自绘 caption
 * （`TitleBar.vue`，`var(--gosslan-title-h)`，Win 38px / macOS 28px），而弹窗经 portal 挂到
 * `<body>`、铺的是 `fixed inset-0` ⇒ 从视口 (0,0) 起算，卡片顶部直接钻到 caption 底下，
 * 标题与右上角 ✕ 一起被压住（用户实测过的那一类）。移动端没有 caption
 * （`TitleBar` 的 `v-if="!isMobile"`），所以那套变量在移动端必须是 **0**
 * ⇒ 让位写法在移动端零变化，一个写法两种形态都对。
 *
 * ⚠️ 这条只看**外壳那一层**（`fixed` + 四边铺满），不判卡片自己的 `max-h` / `my-auto` ——
 * 后两者是另一条判据的事，而且卡片高度要真视口才量得准（运行时那半在
 * `scripts/check-ui-runtime.mjs` 的 overlay 段）。
 * ⚠️ 判据读的是**类名**（复用文件顶部那份 `CLASS_ATTR_RE`），注释里写一句不算 ——
 * 写注释过关的判据不是判据。
 * 逃生阀：文件里带 `window-safe-ok` 注释整份跳过（确实铺满是有意的）。
 *
 * ## 分母收窄过（2026-10-12，逐格核过真实树之后）
 * 第一版把 `absolute inset-0` 与所有"看不见的点击层"都算进来，在真实树上报了 **7 个文件**，
 * 逐格读完**只有 1 个是真的**。多出来的 6 个都是假红，形状各有各的道理，必须写清楚：
 *  - `MessageItem.vue:1114` 是 `absolute inset-0`（**行内**透明点击层，不是视口浮层）⇒
 *    只判 `fixed`。`absolute` 的定位基准是父元素，"让开窗口 caption"对它没有意义。
 *  - `ActionSheet.vue:28` / `GroupTasksBoard.vue:1484` / `TodoPickField.vue:88` 都是
 *    **不可见的点击捕手**（`aria-hidden` 遮罩、或 `cursor-default` 的整屏按钮，只负责"点外面关掉"）。
 *    它们**本来就该铺满**：caption 是 `z-[85]`，这些层（z-40/65）恒在它之下，
 *    既不会盖住 caption 也不被 caption 遮住内容（它们没有内容）⇒ 让位只会留出一条点不着的缝。
 *  - `FavoritePanel.vue:694` / `MobilePageFrame.vue:53` 命中的那一支是
 *    `app.isMobile` / `mode === 'overlay'` 的**移动端分支**，移动端没有 caption（变量恒 0）。
 *  ⇒ 判据收成三条：`fixed` + 四边铺满 + **这一层看得见**，且**不是移动端分支**。
 *  "看不见"靠两条既有类名特征判（`aria-hidden` 的装饰遮罩、`cursor-default` 的点击捕手），
 *  "移动端分支"靠 `:class` 三元里出现的移动判据判（见 `MOBILE_BRANCH_RE`）。
 *  不靠 `aria-hidden` 文本单独一条 —— 见测试里那几条正反面夹具。
 */
const WINDOW_SAFE_TOP_RE = /top-\[var\(--gosslan-(?:window-)?safe-top/;
/** 四边都铺满的写法：`inset-0`，或 `inset-x-0 bottom-0` + 顶到某个值。 */
const FULL_BLEED_RE = /\binset-0\b/;
/**
 * "整层只是点击捕手、没有任何可见内容"的既有写法。
 *
 * `cursor-default` 是本仓那三处整屏关闭层的共同标记（它们用 `<button>`/`<div>` 铺满整屏、
 * 光标故意不变成手型，因为那不是"一个能点的控件"）。
 */
const INVISIBLE_CATCHER_RE = /\bcursor-default\b/;
/**
 * `:class` 三元里的**移动端分支**标记。
 *
 * 命中形状：`:class="app.isMobile ? 'fixed inset-0 …' : 'flex …'"`（FavoritePanel / MobilePageFrame）。
 * 那一支只在移动端生效，而移动端没有自绘 caption（`--gosslan-window-safe-top` 恒为 0）
 * ⇒ 它铺满是**对的**，让它去读那个变量反而是空转。
 * 判据只认全仓那一个"本机是移动布局"的口径（`isMobile` / `mode === 'overlay'` 这类
 * 明显表达"整页覆盖形态"的条件），不是随便一个三元就豁免。
 */
const MOBILE_BRANCH_RE = /\b(isMobile|mode\s*===\s*['"]overlay['"])/;

export function findFixedOverlayWithoutWindowSafeTop(src: string): GuardIssue[] {
  if (src.includes("window-safe-ok")) return [];
  const hits = [...src.matchAll(CLASS_ATTR_RE)];
  const issues: GuardIssue[] = [];
  for (const m of hits) {
    const cls = m[1];
    // ① 只判**视口锚定**的层：`absolute` 的基准是父元素，与窗口 caption 无关（见上）。
    if (!/\bfixed\b/.test(cls)) continue;
    if (!FULL_BLEED_RE.test(cls)) continue;
    if (WINDOW_SAFE_TOP_RE.test(cls)) continue;
    // ② 不可见的点击捕手／装饰遮罩不在分母里：它们本来就该铺满（见上）。
    if (INVISIBLE_CATCHER_RE.test(cls)) continue;
    if (isInvisibleBackdrop(src, m.index)) continue;
    // ③ 移动端分支不在分母里：那边没有 caption（见上）。
    if (isMobileBranch(src, m.index)) continue;
    issues.push({
      line: lineAt(src, m.index),
      message:
        "这层浮层 `inset-0` 铺满了视口顶部，却没读 `var(--gosslan-window-safe-top)` —— " +
        "桌面窗口的 caption 是**流内**元素（自绘标题栏，Win 38px / macOS 28px），" +
        "弹窗经 portal 挂到 `<body>` ⇒ 卡片顶部会钻到 caption 底下被压住（标题与 ✕ 一起看不见）。" +
        "改法：把 `inset-0` 拆成 `inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)]`。" +
        "⚠️ 移动端该变量为 0（没有 caption）⇒ 一个写法两种形态都对，不要另外加平台判断。" +
        "变量定义与判据见 `style.css` 的窗口显示安全区那一节。",
    });
  }
  return issues;
}

/**
 * 这个作用点是不是"纯遮罩"（`aria-hidden` 的装饰层或只负责点击关闭的层）。
 *
 * 判据取该标签**自身**那一小段文本（起点到 `>`），在里面找 `aria-hidden` ——
 * 只搜紧邻的这个标签，不搜整份文件（否则同文件里任何一处 `aria-hidden` 都会把
 * 所有浮层一起豁免掉）。
 */
function isInvisibleBackdrop(src: string, index: number): boolean {
  const tagEnd = src.indexOf(">", index);
  const tag = src.slice(index, tagEnd === -1 ? index + 400 : tagEnd);
  return tag.includes("aria-hidden");
}

/**
 * 这个 `class` 属性是不是某个 `:class` 三元里**移动端那一支**。
 *
 * ⚠️ 条件的位置**两个方向都有**，只看一边必然漏（两版都栽在这上面，逐处实测出来的）：
 *  · 向前看不够：`:class="mode === 'overlay'\n ? 'fixed inset-0 …'"` ——
 *    条件在 `class="` **之后**（就是那个属性值的开头）；
 *  · 只看紧邻前缀（到上一个 `>`）也不够：`:class="app.isMobile\n ? '…'"` 那种写法里
 *    `isMobile` 落在标签属性区里，而按 `>` 切会把它整段切掉。
 * ⇒ 取"本标签起点前 300 字符"到"属性值里第一个引号段结束"这段**并集**：
 * 向前覆盖属性区，向后覆盖属性值开头的三元条件。两侧各取有界长度，
 * 不扫整份文件（否则别处的 `isMobile` 会把不相干的层一起豁免）。
 */
function isMobileBranch(src: string, index: number): boolean {
  const tagStart = src.lastIndexOf("<", index);
  const from = tagStart === -1 ? Math.max(0, index - 400) : Math.max(0, tagStart - 300);
  // 向后：`class="` 之后到该属性值结束（Vue 里 `:class="... 'a' : 'b'"` 都在引号内）。
  const valStart = src.indexOf('"', index);
  const valEnd = valStart === -1 ? index : src.indexOf('"', valStart + 1);
  const to = valEnd === -1 ? index + 300 : valEnd;
  return MOBILE_BRANCH_RE.test(src.slice(from, index) + src.slice(index, to));
}

// ---------------- ㉚ 主题色规则必须在顶层（#35-N7 的真实缺陷） ----------------
/**
 * 判的是**嵌套深度**，不是"这条规则写没写"。
 *
 * 为什么形状要这样：2026-10-09 实测发现 `::selection` 与 `accent-color` 两条被写在
 * `input,textarea,select,[contenteditable]{…}` 的**括号里面**。原生 CSS 嵌套把 `::selection`
 * 编译成 `input ::selection, textarea ::selection, …` 这种后代选择器 —— 输入框没有元素子节点
 * ⇒ 整条**匹配不到任何东西**；`accent-color` 同样编译成 `[contenteditable=""] progress{}`
 * 之类的后代形式 ⇒ 复选框 / radio / 进度条根本没吃到主题色。
 * 那时源码里两条规则都在、扫源码的正则也照过 —— **「在源码里」不等于「在产物里生效」**。
 *
 * 顶层判据：`@media` / `@supports` / `@layer` 这类 at-rule 的括号**不计入深度**
 * （把 `::selection` 写进媒体查询是合法写法，不该被这条误伤）。
 */
export function findNestedThemeRuleIssues(css: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  // 注释里可能出现花括号：整段替换成等长空白，保持下标与行号不漂
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lineAt = (i: number) => body.slice(0, i).split("\n").length;

  // 栈里只记"这是不是一条样式规则"（true = 计入深度；false = at-rule 容器）
  const stack: boolean[] = [];
  let selStart = 0;
  let selectionHeads = 0;
  let accentDecls = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") {
      const sel = body.slice(selStart, i).trim();
      stack.push(!sel.startsWith("@"));
      selStart = i + 1;
      if (sel.endsWith("::selection")) {
        selectionHeads++;
        const depth = stack.filter(Boolean).length - 1; // 选择器本身所在深度
        if (depth !== 0) {
          out.push({
            line: lineAt(selStart),
            message:
              "㉚ `::selection` 必须在顶层规则里（现在嵌在第 " + depth + " 层）—— 嵌套会让它被编译成" +
              "后代选择器（`input ::selection`），输入框没有元素子节点 ⇒ 整条匹配不到任何东西，" +
              "选中色静默回到浏览器默认蓝。",
          });
        }
      }
      continue;
    }
    if (c === "}") {
      stack.pop();
      selStart = i + 1;
      continue;
    }
    if (c === ";" || c === "\n") selStart = c === ";" ? i + 1 : selStart;
    if (body.startsWith("accent-color:", i)) {
      accentDecls++;
      const depth = stack.filter(Boolean).length;
      if (depth !== 1) {
        out.push({
          line: lineAt(i),
          message:
            "㉚ `accent-color` 必须直接写在一个顶层规则里（现在所在深度 " + depth + "）—— " +
            "写在别的规则括号里会被编译成后代选择器（如 `[contenteditable=" + "\u0022\u0022] progress`），" +
            "复选框 / radio / 进度条根本吃不到主题色。",
        });
      }
      i += "accent-color".length;
    }
  }

  if (selectionHeads === 0) {
    out.push({ line: 0, message: "㉚ style.css 里找不到顶层 `::selection` 规则（选中态没跟主题色）。" });
  }
  if (accentDecls === 0) {
    out.push({ line: 0, message: "㉚ style.css 里找不到顶层 `accent-color` 声明（原生控件没跟主题色）。" });
  }
  return out;
}

// ---------------- ㉜ 消息图必须带 fetch hint（roadmap N22：解码不许占那一帧） ----------------
const IMG_LOADING_RE = /\bloading\s*=\s*["']lazy["']/;
const IMG_DECODING_RE = /\bdecoding\s*=\s*["']async["']/;

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

/**
 * 判的是「这条 `<img>` 有没有同时写 `loading="lazy"` 与 `decoding="async"`」。
 *
 * 为什么这是判据而不是审美（roadmap N22）：消息行是被虚拟列表反复挂载的那一层，
 * `<img>` 不带 hint 时浏览器**同步解码**，解码就落在滚动那一帧上；而这条退化不报错、
 * 不影响构建、桌面跑一遍也看不出来。本仓 `src` 下没有任何 IntersectionObserver
 * ⇒ 没有第二套懒加载机制会与此冲突（这也是为什么它必须由判据钉住，否则下一支 `<img>` 会悄悄漏掉）。
 *
 * ⚠️ 这条尺子买不到哪一半：它只看**源码里这两个属性在不在**，
 * 不判懒加载在某个 WebView 版本上实际省了多少毫秒、也不判图片行的估算高度对不对
 * —— 那两半都要真机/量具（N22 行的「收益未测量」与 N26 那格）。
 * 逃生阀：文件级注释 `img-eager-ok`（例：`ImageLightbox` 那张用户主动点开、不在列表里的图）。
 */
export function findMessageImageWithoutFetchHint(src: string): GuardIssue[] {
  if (src.includes("img-eager-ok")) return [];
  const out: GuardIssue[] = [];
  for (const t of findImgTags(src)) {
    const noLoading = !IMG_LOADING_RE.test(t.text);
    const noDecoding = !IMG_DECODING_RE.test(t.text);
    if (!noLoading && !noDecoding) continue;
    const miss = [noLoading ? 'loading="lazy"' : "", noDecoding ? 'decoding="async"' : ""]
      .filter(Boolean)
      .join(" 和 ");
    out.push({
      line: lineAt(src, t.start),
      message:
        `这条 <img> 没写 ${miss} —— 消息行会被虚拟列表反复挂载，缺 hint 时浏览器同步解码，` +
        `解码成本就压在滚动那一帧上（roadmap N22）。` +
        `⚠️ 判据只看这两个属性在不在，不判懒加载在真机上省了多少（那要量具与真机）。` +
        `确实不该懒（用户主动点开、不在列表里的那一张）时在文件里写 img-eager-ok 整份跳过。`,
    });
  }
  return out;
}

/**
 * ㉝ 消息行那几条**列表型 prop** 的绑定里不许出现**空数组字面量**（roadmap N21）。
 *
 * 为什么这条值得钉住：`[] !== []` ⇒ Vue 对组件 props 的浅比较恒判「这条变了」⇒ 整棵子树重新 patch。
 * 2026-10-10 现量（perf/README.md 量具一 `?row=`，n=3000、视口 22 行、headless Brave）：
 * 真 MessageItem 行每帧 27.6 ms，把这两条数组换成 utils/emptyList.ts 的共享常量后 16.6 ms，
 * 与不含真组件的合成行（16.7 ms）同档 ⇒ **一整帧的开销就是那两个字面量**。
 * 这条判据没有它，那处收益可以被一次「顺手写回 `?? []`」静默退回，而构建与界面都不报错。
 *
 * 只看这四个**列表型**绑定名（消息行调用点上真实存在的那几条）：判的是字面量在不在，
 * 不判别的优化 —— 名字不在名单里就不管，避免误伤别处合法的 `[]`。
 */
const LIST_PROP_BINDING_RE = /:(group-reader-ids|reactions|chips|mention-names)="([^"]*)"/g;

export function findFreshEmptyArrayProp(raw: string): GuardIssue[] {
  // 注释里的不算分母（同 ㉜ 那条 <img> 判据的教训）；用空格替掉注释正文而不是删掉，行号才不漂。
  const src = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  LIST_PROP_BINDING_RE.lastIndex = 0;
  for (let m = LIST_PROP_BINDING_RE.exec(src); m; m = LIST_PROP_BINDING_RE.exec(src)) {
    if (m[2].includes("[]")) {
      out.push({
        line: lineAt(src, m.index),
        message:
          `:${m[1]} 的绑定里写了空数组字面量 —— 每次渲染都是新对象 ⇒ 浅比较恒判「变了」⇒ 整棵子树重新 patch；` +
          `空列表请引 utils/emptyList.ts 的共享常量（读数与代价见 roadmap N21）。`,
      });
    }
  }
  return out;
}

/** 这条判据**看得见**多少个绑定？真实树那半用它做阳性对照，名字被改掉时判据会瞎。 */
export function countListPropBindings(raw: string): number {
  const src = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  LIST_PROP_BINDING_RE.lastIndex = 0;
  let n = 0;
  for (let m = LIST_PROP_BINDING_RE.exec(src); m; m = LIST_PROP_BINDING_RE.exec(src)) n += 1;
  return n;
}


/**
 * ㉞ 图片盒的高度只能从 `previewMetrics` 的常量取，组件里不许再写高度工具类；
 * 估算端也不许留一份自己的副本（roadmap N22）。
 *
 * 为什么这条值得钉住：图片消息的载荷里**没有原图尺寸**（`content` 的 JSON 只有
 * name/path/size/sha256/subtype；补 w/h 要动消息协议，为视觉效果排除），而容器**定宽** 208px
 * ⇒ 真实高度只能在解码后知道：`min(IMAGE_BUBBLE_HEIGHT, 208 × 原图高/原图宽)`。
 * 既然只能猜，就必须把"猜的那个数"收成一份：估算端、加载骨架、`<img>` 的上限三者同一个常量
 * （2026-10-10 已收成 `previewMetrics.IMAGE_BUBBLE_HEIGHT`）。这一格此前是估算 288 / 骨架 128
 * 两个数各写一处 ⇒ 图片行挂载那一次先空出 160px、再被实测纠正，N10 那笔"整表前缀和重算"的账
 * 每张图片都要付一遍。
 *
 * 写回字面量的后果不报错、构建也过：界面只是又开始跳。运行时探针 `--only=imgskel` 量的是
 * **真渲染出来的矩形**（那一半能抓到"改了写法但 CSS 没生效"），这条抓的是"在 CI 里也要当场变红"
 * 的那一半（探针不在 CI 跑）。两半各覆盖对方覆盖不到的一半。
 *
 * ⚠️ 这条尺子的工作范围 = 图片盒的那一份实现（`MessageImageBubble.vue`，与 ③ 未读徽标
 * "唯一实现"同一家规矩）；别的组件里 `h-*` 是合法写法，不扫。
 * 逃生阀：文件里写 `image-height-ok`（若哪天图片盒真的换实现）。
 */
export function checkImageBubbleHeightSources(
  bubbleSrc: string,
  estimatorSrc: string,
): GuardIssue[] {
  const out: GuardIssue[] = [];
  // 注释里的写法不算（同 ㉝）：遮成空格而不是删掉，行号才不漂。
  const src = bubbleSrc
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  if (!bubbleSrc.includes("image-height-ok")) {
    for (const m of src.matchAll(CLASS_ATTR_RE)) {
      // 逐条扫这份 class 列表里的高度工具类（`size-6` 那种同时给宽高的不算高度工具类）。
      for (const tok of m[1].split(/\s+/)) {
        if (!/^(?:max-)?h-[\d.]+$/.test(tok)) continue;
        out.push({
          line: lineAt(src, m.index ?? 0),
          message:
            `图片盒里写了高度工具类 \`${tok}\` —— 高度只能从 previewMetrics 取` +
            `（骨架用 IMAGE_BUBBLE_HEIGHT / 终态占位用 IMAGE_PLACEHOLDER_HEIGHT），` +
            `否则虚拟列表的估算、加载预留与 <img> 上限会各留一份数，图片行又开始跳（N22）。` +
            `图标这类与图片盒无关的尺寸请写 size-*。`,
        });
      }
    }
    if (!/IMAGE_BUBBLE_HEIGHT/.test(bubbleSrc) || !/from "@\/utils\/previewMetrics"/.test(bubbleSrc)) {
      out.push({
        line: 0,
        message:
          "图片盒没从 previewMetrics 引 IMAGE_BUBBLE_HEIGHT ⇒ 估算端与渲染端断了同一份常量（N22）。",
      });
    }
  }

  // 估算端那一侧：不许再留一份自己的图片高度常量（那份就是当年漂开的那个家）。
  if (/const\s+IMAGE_BUBBLE\s*=\s*\d+/.test(estimatorSrc)) {
    out.push({
      line: lineAt(estimatorSrc, estimatorSrc.search(/const\s+IMAGE_BUBBLE\s*=\s*\d+/)),
      message:
        "估算端又定义了一份本地图片高度常量 ⇒ 请改成 import previewMetrics.IMAGE_BUBBLE_HEIGHT，" +
        "否则改一处只会改到一边（N22）。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 合并转发卡片的"定高"是一个数还是两个数（2026-10-24，用户拍板：常量不动，补判据）。
 *
 * 契约是同一句话的两半：渲染端 `MergeCard.vue` 钉 `h-24`(=96px)，估算端
 * `messageHeight.MERGE_CARD = 96` 且 merge 分支**返回这个常量**。
 * 分叉的后果不是"难看"：虚拟列表按 96 排版，画出来更高/更矮 ⇒ 相邻消息互相遮挡
 * （`messageHeight.ts` 文件头写过的那条契约）。这一族此前**只有注释在守** ——
 * 改任意一边都不报错、不红，只有滚起来才看得见。
 *
 * 三格各自会红的形状：
 *   ① 卡片根元素没有 `h-24`（换成 `min-h-`/内容决定 ⇒ 高度重新变成载荷的函数）；
 *   ② `h-24` 与 `MERGE_CARD` 不是同一个像素数（改了一边忘了另一边 —— Tailwind 的
 *      `h-N` 是 `N × 4px`，所以这里现算，不抄 96）；
 *   ③ merge 分支不再返回 `MERGE_CARD`（写了内联数字或别的常量：值也许还对，但"一个数"这个事实已经没了）。
 *
 * 运行时那一半在 `--only=mergeheight`：这里读源码文本，探针读**真渲染矩形**。
 */
export function checkMergeCardHeightCoupling(mergeCardSrc: string, estimatorSrc: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  const src = mergeCardSrc
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  const declared = /const\s+MERGE_CARD\s*=\s*(\d+)\s*;/.exec(estimatorSrc);
  if (!declared) {
    out.push({
      line: 1,
      message: "估算端读不到 `const MERGE_CARD = <数字>;` —— 判据不许因为形状变了就静默跳过（改名/换写法要同批改这里）。",
    });
    return out;
  }
  const declaredPx = Number(declared[1]);

  // 只看**根元素那一个开标签**：卡片里的图标自己就写着 `h-4`（16px），
  // 拿全文的 `h-*` 去比 96 会把每个图标都判成"定高漂移"。契约说的是"这张卡多高"。
  const tplStart = src.indexOf("<template");
  const firstTag = tplStart >= 0 ? src.slice(tplStart) : src;
  const openStart = firstTag.search(/<(?:button|div|article|section|a)\b/);
  const openEnd = firstTag.indexOf(">", openStart);
  const rootTag = openStart >= 0 && openEnd > openStart ? firstTag.slice(openStart, openEnd + 1) : "";
  const used = [...rootTag.replace(/\b(?:min|max)-h-\d+\b/g, "").matchAll(/\bh-(\d+)\b/g)];
  if (!rootTag || used.length === 0) {
    out.push({
      line: lineAt(mergeCardSrc, 0),
      message: "MergeCard 根元素没有 `h-<N>` 定高 ⇒ 卡片高度重新变成载荷的函数，"
        + `而估算端仍按 ${declaredPx}px 排版（后果是相邻消息互相遮挡）。`,
    });
  }
  for (const m of used) {
    const px = Number(m[1]) * 4;
    if (px !== declaredPx) {
      out.push({
        line: lineAt(mergeCardSrc, 0),
        message: `渲染端 h-${m[1]} = ${px}px 与估算端 MERGE_CARD = ${declaredPx}px 不是同一个数：`
          + "定高契约要求两边同源（Tailwind h-N 是 N × 4px，这里现算）。",
      });
      break;
    }
  }

  // merge 分支必须"返回那个常量"，不是"返回一个等于它的数字"。
  const branch = /case\s+"merge"\s*:\s*(?:\/\/[^\n]*\n\s*)*return\s+([A-Za-z_$][\w$]*|\d+)\s*;/.exec(estimatorSrc);
  if (!branch || branch[1] !== "MERGE_CARD") {
    out.push({
      line: 1,
      message: "估算端 merge 分支没有 `return MERGE_CARD`（实际读到 "
        + `${branch ? branch[1] : "没有这一支"}）：值可以照样对，但"渲染高度与估算高度同源"这件事从此没有单一来源。`,
    });
  }
  return out;
}

/** 这条尺子在这份组件里看得见多少个 class 属性（真实树那半的阳性对照：一个都看不见就是尺子瞎了）。 */
export function countClassAttrs(raw: string): number {
  const src = raw
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  let n = 0;
  CLASS_ATTR_RE.lastIndex = 0;
  for (let m = CLASS_ATTR_RE.exec(src); m; m = CLASS_ATTR_RE.exec(src)) n += 1;
  return n;
}

/**
 * ㉟ 视图层（组件）里不许**裸写**平台或输入方式探测 —— 这些判定只有一个家（roadmap N11）。
 *
 * 为什么这条值得由机器盯：本仓的原生体验口径是"通用层 + 各端薄壳"，散写的 `isMac` / UA
 * 判断会一处一处地长成分支网（约束里明写"不要通过大量 isMac、isIOS 条件堆积难以维护的分支"）。
 * 而"该走 common layer"这句话过去只写在注释与 roadmap 里，读代码看不出来谁越了界。
 *
 * 三个家（这条只管"视图层不许自己算"，不管"算得对不对"）：
 *   —— 纯样式差异 ⇒ **CSS 自己表达**：`@media (hover: none)` / `env(safe-area-inset-*)` / `prefers-*`
 *      （2026-10-10 现数 `src/style.css`：hover 1 处、pointer:coarse 4 处、reduced-motion /
 *      reduced-transparency / contrast 各 1 处 —— 这一族本来就在 CSS 里，不许往组件里搬）；
 *   —— 平台与输入能力（UA、有没有真 hover）⇒ `utils/platform.ts`；
 *   —— 布局模式（要不要走移动那一套）⇒ `useAppStore` 的 `isMobile`
 *      （那份是"平台优先、宽度兜底"，Android 首启事故换来的顺序，见 platform.ts:resolveMobileLayout）。
 *
 * 判的是**形状**：视图层里出现下列任一即报 ——
 *   `matchMedia(` / `navigator.userAgent` / `navigator.platform` / `navigator.appVersion` /
 *   `navigator.maxTouchPoints` / `@tauri-apps/plugin-os`。
 * `navigator.clipboard`、`navigator.share` 这类**不是平台判定**的 API 不在名单里（扫它们就是造假红）。
 * 作用点（不是预防性的）：本仓真实只有 1 处裸写 —— `MessageReactionBar` 里的
 * `window.matchMedia("(hover: hover)")`，本轮把它收进 `platform.ts` 的 `canHover`（同一处
 * 顺带是 `reactionRoster.test.ts` 那条**字面量**存在断言的家，已同步改成引 common layer）。
 * 逃生阀：文件里写 `platform-check-ok`（例：某份组件确实要在渲染前自己问一次设备能力）。
 */
const RAW_PLATFORM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmatchMedia\s*\(/, "window.matchMedia("],
  [/\bnavigator\.userAgent\b/, "navigator.userAgent"],
  [/\bnavigator\.platform\b/, "navigator.platform"],
  [/\bnavigator\.appVersion\b/, "navigator.appVersion"],
  [/\bnavigator\.maxTouchPoints\b/, "navigator.maxTouchPoints"],
  [/@tauri-apps\/plugin-os/, "@tauri-apps/plugin-os"],
];

export function findRawPlatformCheckInViewLayer(raw: string): GuardIssue[] {
  if (raw.includes("platform-check-ok")) return [];
  // 注释里的不算（同 ㉝/㉜ 那条教训：prose 里提到 API 名字不能被当成"这里在用"）。
  const src = raw
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    // 行注释也遮掉：这一族最容易在"解释为什么不走这条路"时被提到
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const [re, name] of RAW_PLATFORM_PATTERNS) {
    for (const m of src.matchAll(new RegExp(re.source, "g"))) {
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          `视图层里裸写了 ${name} —— 平台与输入方式只有一个家：` +
          `纯样式差异走 CSS（@media (hover: none) / env(safe-area-inset-*) / prefers-*），` +
          `UA 与"有没有真 hover"走 utils/platform.ts，移动布局模式走 useAppStore 的 isMobile（roadmap N11）。`,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 这条尺子在一份组件里看得见多少个"走正门"的引用（真实树那半用它证明正门确实在被用）。 */
export function countCommonLayerPlatformImports(raw: string): number {
  const fromPlatform = (raw.match(/from "@\/utils\/platform"/g) ?? []).length;
  const fromStore = (raw.match(/\buseAppStore\b/g) ?? []).length > 0 ? 1 : 0;
  return fromPlatform + fromStore;
}

// ---------------- ㊳ 任务卡片可见图片数：一个常量、两个消费点 ----------------

/**
 * ㊳ **任务卡片"最多画几张图"只能有一个家**（用户 2026-10-12：超过 4 张应显示「查看更多」）。
 *
 * 为什么这条值得由机器盯：这个数同时决定两件事，而两处失步都不报错、构建也过 ——
 *  ① `TodoCardBubble.vue` 的 `v-for` 画几张；
 *  ② `messageHeight.ts` 的 `todoImageAllowance()` 按可见张数占几行高度（估少了 ⇒ 虚拟列表遮挡，
 *     本仓顶部契约明写的已发生事故类型）。
 * 任何一处写字面量，改数量时就只会改到另一边。所以常量住在 `utils/todos.ts`，
 * 这条守卫只许一种写法：模板引用 `cardThumbs.shown/hasMore`，估算端 import 常量。
 *
 * 逃生阀：`todo-card-image-ok` 整份跳过（临时试验用，不留长期形态）。
 */
export function checkTodoCardImageLimit(bubbleSrc: string, estimatorSrc: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  const src = bubbleSrc.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  if (src.includes("todo-card-image-ok")) return out;

  // ① 组件必须从 todos.ts 引那个共享常量/函数（不许自己 slice 或比较）
  if (!/visibleTodoImages/.test(src)) {
    out.push({
      line: 0,
      message:
        "TodoCardBubble 必须用 utils/todos.ts 的 visibleTodoImages() 取可见缩略图 ——" +
        "自己 `slice(0, 4)` 或裸比 `.length > 4` 都会让 messageHeight.ts 的行高失去同一个来源。",
    });
  }
  // ② 模板里不许出现裸字面量上限（`v-for` 的截断只能由函数给）
  if (/slice\(0\s*,\s*4\)|\.length\s*>\s*4/.test(src)) {
    out.push({
      line: lineAt(src, src.search(/slice\(0\s*,\s*4\)|\.length\s*>\s*4/)),
      message:
        "模板里裸写了 4 —— 可见图片数的唯一家是 todos.ts 的 TODO_CARD_IMAGE_VISIBLE。" +
        "写在这里，改数量时估算端（messageHeight.ts）不会跟着走。",
    });
  }
  // ③ 「查看更多」必须与底部按钮**同一套行为**：emit open 带 todoId，且自己把点击拦住
  //    （`.stop` 不是风格问题：这颗排在命中区①**之内**，不拦就会在 open(todoId) 之后
  //    再多冒一个 open-panel ⇒ 面板被开两次、第二次不带 id，直达这条任务被冲掉）。
  if (!/v-if="cardThumbs\.hasMore"[\s\S]{0,600}?@click\.stop="emit\('open', todoId\)"/.test(src)) {
    out.push({
      line: 0,
      message:
        "「查看更多」按钮漏了、没接到 emit('open', todoId)、或缺 `.stop` —— 用户要求它表现得和" +
        "「查看任务」一致（打开列表并直达这条任务）。它在命中区①里面，少了 .stop 就会顺路再发一个" +
        " open-panel（不带 todoId），把直达效果冲掉。",
    });
  }
  // ④ 文案必须走 i18n key（中英两份已同步；裸中文 = 英文界面显示中文）
  if (!/todo\.viewMoreImages/.test(src)) {
    out.push({ line: 0, message: "「查看更多」文案必须走 t(\"todo.viewMoreImages\")（i18n 护栏会抓裸 key）。" });
  }
  // ⑤ 预览相册不许被截断（卡片只画 4 张，但从第 2 张起往后翻要能看到全部）
  if (!/const cardGallery = computed\(\(\) =>\s*\n?\s*cardImages\.value\.map/.test(src)) {
    out.push({
      line: 0,
      message:
        "cardGallery 必须由**完整**的 cardImages 生成 —— 卡片只画前几张，但预览相册要能翻到全部：" +
        "截断卡片缩略图时如果顺手把 cardGallery 也截了，从第 2 张往后就再也翻不到剩下的图" +
        "（卡片看不到的那几张，在预览里也不见了，而编译与类型全都过）。",
    });
  }
  // ⑥ 估算端必须按**这一条自己的张数**算图片段，且张数上限引共享常量。
  //    为什么两个方向都要钉（数都来自探针的高度实测表，2026-10-13）：
  //     · 按上限写死一整块 ⇒ 只有 1 张图的卡白占 2 行（实测多留 86px ⇒ 卡片之间出现空洞）；
  //     · 只判"有没有图" ⇒ 超过上限那条漏掉「查看更多」那一行（实测差 32px ⇒ 相邻消息遮挡）。
  //    所以三件事都要在：算式存在、算式引的是共享常量、调用点传的确实是**数出来的张数**。
  const estCode = estimatorSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
  const allowance = /function todoImageAllowance[\s\S]{0,700}?\n\}/.exec(estCode)?.[0] ?? "";
  if (!allowance.includes("TODO_CARD_IMAGE_VISIBLE") || !allowance.includes("Math.ceil(")) {
    out.push({
      line: lineAt(estimatorSrc, estimatorSrc.search(/function\s+todoImageAllowance/)),
      message:
        "图片段占位必须由 todoImageAllowance() 按 TODO_CARD_IMAGE_VISIBLE 现算行数（ceil(可见张数/每行)）—— " +
        "写死一个魔数会与「卡片画几张」脱钩，改一处只会改到一边。",
    });
  }
  // ⑦ 调用点必须把**张数**传进去：只判 `images.length > 0` 再取固定值 = 上面那两个缺陷的形状。
  if (!/todoImageAllowance\(/.test(estCode) || !/images\??\.length/.test(estCode)) {
    out.push({
      line: 0,
      message:
        "估算端必须真的去数载荷里的图片张数（images.length）并传给 todoImageAllowance() —— " +
        "只留一个「有没有图」的布尔判断，超限时那一行「查看更多」就没人估（虚拟列表遮挡）。",
    });
  }
  // ⑧ 代码（不是注释）里要引得到共享常量：注释里写过了不算，本仓多次栽在"注释写了、代码没引"。
  if (!/TODO_CARD_IMAGE_VISIBLE/.test(estCode)) {
    out.push({
      line: 0,
      message:
        "messageHeight.ts 必须在**代码**里引用 TODO_CARD_IMAGE_VISIBLE（注释里写不算 —— 行高算式要与可见张数同源）。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ㊴ 圆角只能走 token ----------------

/**
 * 检查静态 class 里的字面圆角值。
 *
 * 设计规范 §1.2：圆角只有一个来源（`--gosslan-radius-*`）。字面值 `rounded-lg`
 * 无法全局调整，也看不出"这一档是给谁用的"；2026-10-18 复核时全仓只剩 2 处，
 * 属于"随时会再长回来"的形状，所以收成机器判据。
 *
 * 判据：`rounded` / `rounded-t|r|b|l|tl|tr|br|bl` 后接
 *   · 命名档位（sm/md/lg/xl/2xl/3xl）→ 报；
 *   · 任意值（如 `rounded-[6px]`）→ 报；值是 `var(--gosslan-radius-*)` 时放行；
 *   · `rounded-full` / `rounded-none` → 放行（规范明确允许）。
 * HTML 注释先抹成空格（保留换行与行号），避免注释里的示例造成假红。
 */
const LITERAL_RADIUS_RE = /^rounded(?:-[trbl]{1,2})?-(sm|md|lg|xl|2xl|3xl|\[[^\]]+\])$/;
/**
 * 任何 `--gosslan-*` 变量都算 token。只认 `--gosslan-radius-*` 会误伤规范里
 * **明确保留**的三个语义别名（`--gosslan-avatar-radius` / `--gosslan-item-radius` /
 * `--gosslan-bubble-radius`，见 docs/design-guidelines.md §1.2 末行）。
 */
const TOKEN_RADIUS_RE = /^rounded(?:-[trbl]{1,2})?-\[var\(--gosslan-[a-z-]+\)\]$/;

export function findLiteralRadiusClasses(src: string): GuardIssue[] {

  const cleaned = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(CLASS_ATTR_RE)) {
    for (const cls of m[1].split(/\s+/).filter(Boolean)) {
      if (!LITERAL_RADIUS_RE.test(cls) || TOKEN_RADIUS_RE.test(cls)) continue;
      out.push({
        line: lineAt(cleaned, m.index ?? 0),
        message:
          "圆角写了字面值 —— 一律用 `rounded-[var(--gosslan-radius-*)]`。" +
          "字面值无法全局调整，也看不出这一档是给谁用的（docs/design-guidelines.md §1.2）；" +
          "`rounded-full` / `rounded-none` 不受此限。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ㊵ 高频语义图标只从 ui/icons.ts 引 ----------------

/**
 * 检查直接从 `lucide-vue-next` 导入的高频语义图标。
 *
 * 为什么：`components/ui/icons.ts` 是这 5 个语义的稳定入口；继续从 lucide 直接引
 * 会让"换图标库 / 统一尺寸"又变成多点修改。只判 import 语句，不猜模板用法；
 * 临时过渡可用文件级 `icon-entry-ok` 逃生阀。
 */
export function findDirectSemanticIconImports(src: string, names: string[]): GuardIssue[] {
  if (src.includes("icon-entry-ok")) return [];
  const out: GuardIssue[] = [];
  // ⚠️ 不要用 `[\s\S]*?`：它会从文件里**前面的** `import {` 一路吞到这条 lucide import，
  // 最后一个名字会带上 `import { ` 前缀，`imported.includes(name)` 于是漏报（2026-10-18 实测
  // GroupFilesPanel / MergeCardModal 直连 Loader2 而判据报 0 处）。`[^}]*` 只吃到本条的 `}`。
  const re = /^import\s*\{([^}]*)\}\s*from\s*["']lucide-vue-next["'];?/gm;
  for (const m of src.matchAll(re)) {
    const imported = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (!imported.includes(name)) continue;
      out.push({
        line: lineAt(src, m.index ?? 0),
        message:
          `高频语义图标 \`${name}\` 必须从 \`@/components/ui/icons\` 引，` +
          "不要直接引 `lucide-vue-next`（入口是换图标库/统一尺寸时唯一要改的地方）。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- 取消键只走 SecondaryBtn（2026-10-28 动作按钮收口） ----------------

/**
 * 检查模板里手写的「取消」按钮。
 *
 * 设计规范（用户 2026-10-28 报「撤回弹窗按钮文字上下没居中」后定的）：
 * 确认框里的「取消」只有 `components/ui/SecondaryBtn.vue` 一份实现。手写副本与同排的
 * Primary/Danger 并排时高度、字重、垂直居中各自漂移，而且一处一处看很难发现。
 *
 * 判据：`<button>` 的**文本内容**里出现 `common.cancel` ⇒ 报。两个例外：
 *   · `components/ui/` 下的组件自身（SecondaryBtn 就是这个家）；
 *   · 整宽行按钮（class 含 `w-full`）—— 那是 ActionSheet 的底部行，不是对话框动作键。
 * HTML 注释先抹成空格；按钮不嵌套，配对按最近的 `</button>`。
 */
export function findHandWrittenCancelButtons(src: string): GuardIssue[] {
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(/<button\b([\s\S]*?)>/g)) {
    const start = m.index ?? 0;
    const end = cleaned.indexOf("</button>", start + m[0].length);
    if (end < 0) continue;
    const inner = cleaned.slice(start + m[0].length, end);
    if (!inner.includes(`t("common.cancel")`)) continue;
    const classMatch = m[1].match(/\bclass="([^"]*)"/);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    if (classes.includes("w-full")) continue; // ActionSheet 的整宽行
    out.push({
      line: lineAt(cleaned, start),
      message:
        "对话框的「取消」必须用 `components/ui/SecondaryBtn.vue`（与 Primary/Danger 同一套盒模型与三档尺寸）。" +
        "手写副本与并排的主键高度/居中会漂移（2026-10-28 撤回弹窗就这么歪的）；整宽行按钮（w-full）除外。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 三个共享按钮必须用 flex 居中，且三档尺寸逐字相同。
 *
 * 为什么钉源码而不是只钉「用了组件」：垂直居中靠 `items-center`/`justify-center` 实现，
 * 退回 line-box 写法在 slot 包一层 `inline-flex` 时就会把文字顶高一两像素 —— 构建与截图
 * 都看不出来，只有并排比较才发现。三档尺寸钉死是为了让三者在同一排里**同高**。
 */
export function sharedButtonChromeIssues(name: string, src: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  const tpl = src.replace(/<script[\s\S]*?<\/script>/, "");
  if (!/class="[^"]*inline-flex/.test(tpl) || !/class="[^"]*items-center/.test(tpl) || !/class="[^"]*justify-center/.test(tpl)) {
    out.push({ line: 1, message: `${name} 的根元素必须是 inline-flex + items-center + justify-center（垂直居中不许靠 line-box）` });
  }
  for (const tier of ["xs", "dense", "default", "large"]) {
    const re = new RegExp(`size === '${tier}' \\? '([^']*)'`);
    const m = tpl.match(re);
    if (!m) out.push({ line: 1, message: `${name} 缺少尺寸档 ${tier}` });
  }
  return out;
}

// ---------------- ㊶ 实底危险按钮只走 DangerBtn ----------------

/**
 * 检查模板里手写的"实底危险按钮"。
 *
 * 设计规范：危险操作按钮只有 `components/ui/DangerBtn.vue` 一份实现
 * （danger 实底 + 白字 + danger-hover）。手写副本最容易漂移的两处：
 *   · `hover:opacity-90`（暗化）而不是 `danger-hover`（亮一档）；
 *   · 尺寸各写各的，确认弹窗高度不一致。
 *
 * 判据：`<button class="…">` 的 class 里出现独立的 `bg-[var(--gosslan-danger)]`
 * （不是 `hover:` 前缀）→ 报。两个例外：
 *   · 圆形图标徽标（class 含 `rounded-full`），它不是文本按钮，没有 DangerBtn 变体；
 *   · `DangerBtn.vue` 自身（调用方写 `<DangerBtn>`，不会命中 `<button>`；树扫描时跳过该文件）。
 * HTML 注释先抹成空格（保留换行与行号），避免注释里的示例造成假红。
 */
const SOLID_DANGER_CLASS = "bg-[var(--gosslan-danger)]";

export function findHandWrittenSolidDangerButtons(src: string): GuardIssue[] {
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(/<button\b([\s\S]*?)>/g)) {
    const classMatch = m[1].match(/\bclass="([^"]*)"/);
    if (!classMatch) continue;
    const classes = classMatch[1].split(/\s+/).filter(Boolean);
    if (!classes.includes(SOLID_DANGER_CLASS) || classes.includes("rounded-full")) continue;
    out.push({
      line: lineAt(cleaned, m.index ?? 0),
      message:
        "实底危险按钮必须用 `components/ui/DangerBtn.vue`（danger 实底 + danger-hover + 统一尺寸）。" +
        "手写副本常用 `hover:opacity-90` 暗化，且尺寸各写各的；圆形图标徽标（rounded-full）除外。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 主色实底控件的「填充 + 前景」是一对，不是两个独立选择。
 *
 * 为什么要有机器判据（2026-10-24 无障碍实测）：`--gosslan-primary-active` 在亮色是
 * 压深档（白字 4.6+），在暗色是**提亮**档（前景换成深墨 `--gosslan-on-primary`）。
 * 于是这两件缺陷都会**静默**发生：
 *
 *   ① 写了 `bg-[var(--gosslan-primary-active)]` 却没写配档前景 ⇒ 文字继承父级颜色，
 *      亮色下勉强能看、暗色下亮底亮字；
 *   ② 写了 `text-white` ⇒ 亮色过 AA，暗色下白字压在提亮档上直接掉到 1.6~2.0。
 *
 * 两种都编译通过、构建通过、探针不红（探针量的是 token 算得对不对，量不到谁在用），
 * 只有换到暗色主题才看得见 ⇒ 正是"静默失败"那一族，必须由静态判据盯住。
 *
 * 判据按**开标签**取整段（`class` / `:class` / 三元字符串都在这段里），
 * 不看裸 `src.includes` —— 注释里写一句"改成 bg-[var(--gosslan-primary-active)]"
 * 会让护栏因为注释而通过（这一族已经踩过两次）。HTML 注释先抹成空格。
 *
 * ⚠️ 只管**带文字/图标的那一档**：`-active`/`-hover` 这两档在本仓是给"压在上面的东西"
 * 用的，所以缺前景就是缺陷。裸 `bg-[var(--gosslan-primary)]`（进度条、状态点、开关底
 * 这类非文字填充）不要求配对，只禁止它配 `text-white`（那是原缺陷形状：中间调 + 白字 ≈ 3.5）。
 *
 * ⚠️ 已知边界：判定粒度是**整个元素（含子树）**。同一个标签里 `:class` 三元两支各写一套
 * （一支成对、一支只写填充）这一支看不见 —— 已由 `designGuards.test.ts` 的"已知边界"用例
 * 钉住，别把它当成已覆盖；那一族的比值兜底在 tokenContrast 契约，暗色覆盖兜底在 CDP 探针的 accent 段。
 */
const FILL_ACTIVE = "bg-[var(--gosslan-primary-active)]";
const FILL_HOVER = "bg-[var(--gosslan-primary-hover)]";
const FILL_RAW = "bg-[var(--gosslan-primary)]";
const ON_PRIMARY = "text-[var(--gosslan-on-primary)]";
/**
 * 语义色那两族（2026-10-24 补，与主色族同一条判据、同一个家）：
 *  - `FILL_SEMANTIC_SOLID`：**实底档**（`--gosslan-warning-solid` / `--gosslan-success-solid`），
 *    压的是配对前景 ⇒ 只写填充 = 文字继承父级颜色，同一形状。
 *  - `FILL_SEMANTIC_DOT`：**状态点档**（`--gosslan-warning` / `--gosslan-success`），
 *    它只被"图形档 3.0"约束（在线点、色条），从没为"上面有字"设计过 ——
 *    白字压它实测 2.20 / 2.54（暗色 2.06 / 2.02），这一族的缺陷正是"拿状态点当按钮底"。
 * 只禁止它配 `text-white`：同一 token 当状态点（无文字）是正确用法，不报。
 */
const FILL_SEMANTIC_SOLID = ["bg-[var(--gosslan-warning-solid)]", "bg-[var(--gosslan-success-solid)]"];
const FILL_SEMANTIC_DOT = ["bg-[var(--gosslan-warning)]", "bg-[var(--gosslan-success)]"];

/** 无闭合标签的元素：取"子树"时按自闭合处理。 */
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** 从开标签起点取回**整个元素**（含子树）；同名嵌套按深度配对，取不到就只回开标签本身。 */
function elementBlock(tpl: string, openStart: number): string {
  const openEnd = tpl.indexOf(">", openStart);
  if (openEnd < 0) return tpl.slice(openStart);
  const openTag = tpl.slice(openStart, openEnd + 1);
  const name = /^<([A-Za-z][\w-]*)/.exec(openTag)?.[1] ?? "";
  if (!name || openTag.trimEnd().endsWith("/>") || VOID_ELEMENTS.has(name.toLowerCase())) return openTag;
  const openRe = new RegExp(`^<${name}(?=[\\s/>])`, "");
  const closeTag = `</${name}>`;
  let depth = 0;
  let i = openEnd + 1;
  while (i < tpl.length) {
    if (tpl.startsWith(closeTag, i)) {
      if (depth === 0) return tpl.slice(openStart, i + closeTag.length);
      depth -= 1;
      i += closeTag.length;
      continue;
    }
    const rest = tpl.slice(i);
    if (openRe.test(rest)) {
      const next = tpl.indexOf(">", i);
      if (next < 0) break;
      // 同名标签只可能是这一层的嵌套（openRe 按 name 匹配），自闭合的不进深度。
      if (!tpl.slice(i, next + 1).trimEnd().endsWith("/>")) depth += 1;
      i = next + 1;
      continue;
    }
    i += 1;
  }
  return openTag;
}

export function findPrimaryFillWithoutOnPrimary(src: string): GuardIssue[] {
  const tplStart = src.indexOf("<template");
  const tplEnd = src.lastIndexOf("</template>");
  if (tplStart < 0 || tplEnd <= tplStart) return [];
  const tpl = src
    .slice(tplStart, tplEnd)
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of tpl.matchAll(/<[A-Za-z][\s\S]*?>/g)) {
    const at = tplStart + (m.index ?? 0);
    const openTag = m[0];
    // 前景允许写在**同一个元素或它的子树**里：勾选框是"外圈上底色、里面 `<Check>` 吃
    // currentColor"的形状（GroupCreateModal / MessageItem 多选圈都这样），
    // 只认开标签那一行会把这两处判成缺陷。
    const block = elementBlock(tpl, m.index ?? 0);
    const hasOnPair = block.includes(ON_PRIMARY);
    const solidFill = [FILL_ACTIVE, FILL_HOVER, ...FILL_SEMANTIC_SOLID].find((f) => openTag.includes(f)) ?? "";
    if (solidFill && !hasOnPair) {
      out.push({
        line: lineAt(src, at),
        message:
          "实底（" +
          solidFill +
          "）必须在这个元素或其子树里带上 " +
          ON_PRIMARY +
          "。只写填充 ⇒ 文字继承父级颜色；写 text-white ⇒ 暗色那档是提亮填充，白字只剩 1.6~2.0。" +
          "这一对由 tokenContrast 的契约判比值，不由人眼判。",
      });
    } else {
      const dotFill = [FILL_RAW, ...FILL_SEMANTIC_DOT].find((f) => openTag.includes(f)) ?? "";
      if (dotFill && openTag.includes("text-white")) {
        out.push({
          line: lineAt(src, at),
          message:
            "禁止 `" +
            dotFill +
            " text-white`：这一档是给**状态点 / 色条**的（只受图形档 3.0 约束），白字压它实测 2.20（橙）/ 2.54（绿）/ ≈3.5（主色），" +
            "两种外观下都不合格。承载文字的实底要用 " +
            FILL_ACTIVE +
            " 或 `--gosslan-warning-solid` / `--gosslan-success-solid`，配 " +
            ON_PRIMARY +
            "（比值由 tokenContrast 契约判）。",
        });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * 原生 `<select>` 已整体迁到 Reka（`components/ui/SettingsSelect.vue`）。
 * 原生控件的弹出层由 WebView 绘制：不跟随主题、键盘/焦点行为各端不一，
 * 且无法统一 `.gosslan-menu` 外观。只扫 `<template>` 里真正写出的标签；
 * script 里说明"为什么不用 `<select>`"的文档不算。
 */
export function findNativeSelect(src: string): GuardIssue[] {
  const start = src.indexOf("<template");
  const end = src.lastIndexOf("</template>");
  if (start < 0 || end <= start) return [];
  const tpl = src.slice(start, end).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of tpl.matchAll(/<select\b/g)) {
    out.push({
      line: lineAt(src, start + (m.index ?? 0)),
      message:
        "模板里不许再出现原生 `<select>`：统一用 `components/ui/SettingsSelect.vue`（Reka Select，" +
        "主题化浮层 + 键盘/焦点/无障碍由库负责）。",
    });
  }
  return out;
}

/**
 * `v-html` 的允许清单：下面每一处都是**构造即转义**，没有"把对端原文直接塞进 HTML"的路径。
 * （条数不手写在这里 —— 清单本身就是分母，判据拿扫描结果与它逐项比。）
 *
 * - `ChatSearchDialog`：`highlightText`（先在原文上匹配、再逐段 `escHtml`，只注入 `<mark>`）；
 * - `LogRows`：同一份 `highlightText` 生成的四段 `row.*`（2026-10-29 审计 DUP-05 后，
 *   日志行模板从两个外壳收成这一个家 ⇒ 落点跟着搬家，转义链没变：`LogViewer` 里那三行
 *   `highlightText(...)` 仍是唯一生产者）；
 * - `CodeBlock`：highlight.js 的转义输出，plaintext 走 `escapeHtml(props.code)`。
 *
 * 新增 `v-html` 必须先证明输入已转义（或接 DOMPurify），再把文件登记到这里；
 * 这条清单是给"以后顺手写一个 v-html"的人看的，不是运行时安全边界本身。
 */
export const V_HTML_ALLOWED = [
  "components/search/ChatSearchDialog.vue",
  "components/LogRows.vue",
  "components/CodeBlock.vue",
  // 2026-10-29 更新说明改成 Markdown 渲染：输入来自网络清单，但先过 `marked` 再经
  // `DOMPurify` 白名单消毒（`utils/markdown.ts`）；这里是它唯一的 `v-html` 落点。
  "components/ui/MarkdownText.vue",
] as const;

/** 读出模板里每一处 `v-html` 的表达式与行号（只认静态写法，便于清单对账）。 */
export function findVHtmlSinks(src: string): { line: number; expr: string }[] {
  const out: { line: number; expr: string }[] = [];
  for (const m of src.matchAll(/v-html="([^"]*)"/g)) {
    out.push({ line: lineAt(src, m.index ?? 0), expr: m[1] });
  }
  return out;
}

