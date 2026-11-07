/**
 * 首屏骨架的几何「同源」出口。
 *
 * 背景（用户 2026-11-07 总要求）：骨架必须与真实布局同构，首帧不许跳。
 * 此前骨架在 `skeleton.css` 里自己抄了一套数字（标题栏 38/40、列表宽 320、行高 62、
 * 设置左栏 176…），真实布局的值写在 `style.css` 的 token 或组件类名里 —— 两边各写一份，
 * 改一边另一边不会红。本模块把它变成**一份来源**：
 *
 *   ① `style.css` 的 `--gosslan-*` 是唯一来源；
 *   ② 构建时由 `vite.config.ts` 的 `gosslan:inline-boot` 插件读 `style.css`，
 *      把值物化进内联样式（骨架先于 style.css 执行，运行时读不到那边的变量）；
 *   ③ `skeleton.css` 只许写 `var(--boot-*)`，**不许再出现这几个属性的字面 px**；
 *   ④ `designGuards.test.ts` 的 SK-04 同时盯住 ①③ 与「真实组件确实在用同一批 token」，
 *      任何一边改回私有数字都必须红。
 *
 * 为什么用 `--boot-*` 而不是直接写 `var(--gosslan-*)`：骨架样式在 `<head>` 里内联，
 * 而 `--gosslan-*` 由 `src/style.css` 提供（要等模块脚本执行），首帧那一刻还没定义。
 */

/** 一条几何规则：骨架变量 ← style.css token，并钉住它在骨架里的使用位置。 */
export interface BootTokenRule {
  /** 骨架里用的变量名（不含 `--`） */
  bootVar: string;
  /** style.css 的 token 名（不含 `--`） */
  styleToken: string;
  /** 骨架里必须出现 `var(--<bootVar>)` 的规则（用于「确实接上了」断言） */
  usage: RegExp;
  /** 该规则里被这个变量替代的「字面 px」形态；命中即红（禁止骨架自己写一套数字） */
  literal?: RegExp;
  /** 真实布局里必须真的引用这个 token 的文件 + 提示 */
  consumer: { file: string; needle: string };
}

/**
 * 受管几何（逐条对应审查里量到的位置）。
 *
 * 数值本身不写在这里 —— 写在这里就又成了第二份来源。这里只声明「谁跟谁同源」。
 */
export const BOOT_TOKEN_RULES: readonly BootTokenRule[] = [
  {
    bootVar: "title-h",
    styleToken: "gosslan-title-h",
    usage: /\.boot-cap\s*\{[^}]*height:\s*var\(--boot-title-h\)[\s\S]*\.boot-todos-toolbar\s*\{[^}]*height:\s*var\(--boot-title-h\)|\.boot-todos-toolbar\s*\{[^}]*height:\s*var\(--boot-title-h\)/,
    literal: /\.boot-cap\s*\{[^}]*height:\s*\d+px|\.boot-todos-toolbar\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/TitleBar.vue", needle: "--gosslan-title-h" },
  },
  {
    bootVar: "header-h",
    styleToken: "gosslan-header-h",
    usage: /\.boot-head\s*\{[^}]*height:\s*var\(--boot-header-h\)/,
    literal: /\.boot-head\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/chat/ChatHeader.vue", needle: "--gosslan-header-h" },
  },
  {
    bootVar: "rail-w",
    styleToken: "gosslan-rail-w",
    usage: /\.boot-rail\s*\{[^}]*width:\s*var\(--boot-rail-w\)/,
    literal: /\.boot-rail\s*\{[^}]*width:\s*\d+px/,
    consumer: { file: "components/NavRail.vue", needle: "--gosslan-rail-w" },
  },
  {
    bootVar: "list-w",
    styleToken: "gosslan-list-w",
    usage: /\.boot-list\s*\{[^}]*width:\s*var\(--boot-list-w\)/,
    literal: /\.boot-list\s*\{[^}]*width:\s*\d+px/,
    consumer: { file: "layouts/ResponsiveLayout.vue", needle: "--gosslan-list-w" },
  },
  {
    bootVar: "row-h-desktop",
    styleToken: "gosslan-row-h-desktop",
    usage: /\.boot-row\s*\{[^}]*height:\s*var\(--boot-row-h-desktop\)/,
    literal: /\.boot-row\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/conversation/ConversationListItem.vue", needle: "gosslan-row-h-desktop" },
  },
  {
    bootVar: "row-h-mobile",
    styleToken: "gosslan-row-h-mobile",
    usage: /height:\s*var\(--boot-row-h-mobile\)/,
    consumer: { file: "components/conversation/ConversationListItem.vue", needle: "gosslan-row-h-mobile" },
  },
  {
    bootVar: "row-avatar",
    styleToken: "gosslan-row-avatar",
    usage: /\.boot-ava\s*\{[^}]*width:\s*var\(--boot-row-avatar\)/,
    literal: /\.boot-ava\s*\{[^}]*width:\s*\d+px/,
    consumer: { file: "components/conversation/ConversationListItem.vue", needle: "gosslan-row-avatar" },
  },
  {
    bootVar: "row-pad-x",
    styleToken: "gosslan-row-pad-x",
    usage: /\.boot-row\s*\{[^}]*padding:\s*0 var\(--boot-row-pad-x\)/,
    literal: /\.boot-row\s*\{[^}]*padding:\s*0 \d+px/,
    consumer: { file: "components/conversation/ConversationListItem.vue", needle: "gosslan-row-pad-x" },
  },
  {
    bootVar: "search-h",
    styleToken: "gosslan-search-h",
    usage: /\.boot-search\s*\{[^}]*height:\s*var\(--boot-search-h\)/,
    literal: /\.boot-search\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/ConversationList.vue", needle: "gosslan-search-h" },
  },
  {
    bootVar: "list-title-h",
    styleToken: "gosslan-list-title-h",
    usage: /\.boot-title-row\s*\{[^}]*height:\s*var\(--boot-list-title-h\)/,
    literal: /\.boot-title-row\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/ConversationList.vue", needle: "gosslan-list-title-h" },
  },
  {
    bootVar: "nav-item",
    styleToken: "gosslan-nav-item",
    usage: /\.boot-nav-item\s*\{[^}]*width:\s*var\(--boot-nav-item\)/,
    literal: /\.boot-nav-item\s*\{[^}]*width:\s*\d+px/,
    consumer: { file: "components/NavRail.vue", needle: "gosslan-nav-item" },
  },
  {
    bootVar: "settings-nav-w",
    styleToken: "gosslan-settings-nav-w",
    usage: /\.boot-set-nav\s*\{[^}]*width:\s*var\(--boot-settings-nav-w\)/,
    literal: /\.boot-set-nav\s*\{[^}]*width:\s*\d+px/,
    consumer: { file: "components/SettingsWindow.vue", needle: "gosslan-settings-nav-w" },
  },
  {
    bootVar: "toolbar-h",
    styleToken: "gosslan-toolbar-h",
    usage: /\.boot-logs-toolbar\s*\{[^}]*height:\s*var\(--boot-toolbar-h\)/,
    literal: /\.boot-logs-toolbar\s*\{[^}]*height:\s*\d+px/,
    consumer: { file: "components/LogViewer.vue", needle: "gosslan-toolbar-h" },
  },
  {
    bootVar: "radius-md",
    styleToken: "gosslan-radius-md",
    usage: /\.boot-set-nav\s+i\s*\{[^}]*border-radius:\s*var\(--boot-radius-md\)|\.boot-search\s*\{[^}]*border-radius:\s*var\(--boot-radius-md\)/,
    literal: /\.boot-set-nav\s+i\s*\{[^}]*border-radius:\s*\d+px|\.boot-search\s*\{[^}]*border-radius:\s*\d+px/,
    consumer: { file: "components/SettingsWindow.vue", needle: "gosslan-radius-md" },
  },
  {
    bootVar: "radius-lg",
    styleToken: "gosslan-radius-lg",
    usage: /\.boot-set-card\s*\{[^}]*border-radius:\s*var\(--boot-radius-lg\)|\.boot-todo-card\s*\{[^}]*border-radius:\s*var\(--boot-radius-lg\)|\.boot-preview-frame\s*\{[^}]*border-radius:\s*var\(--boot-radius-lg\)/,
    literal: /\.boot-set-card\s*\{[^}]*border-radius:\s*\d+px|\.boot-todo-card\s*\{[^}]*border-radius:\s*\d+px|\.boot-preview-frame\s*\{[^}]*border-radius:\s*\d+px/,
    consumer: { file: "components/settings/SettingsGroup.vue", needle: "gosslan-radius-lg" },
  },
  {
    bootVar: "radius-2xl",
    styleToken: "gosslan-radius-2xl",
    usage: /\.boot-composer\s*\{[^}]*border-radius:\s*var\(--boot-radius-2xl\)/,
    literal: /\.boot-composer\s*\{[^}]*border-radius:\s*\d+px/,
    consumer: { file: "components/chat/MessageComposer.vue", needle: "gosslan-radius-2xl" },
  },
  {
    bootVar: "bubble-radius",
    styleToken: "gosslan-bubble-radius",
    usage: /\.boot-bubble\s*\{[^}]*border-radius:\s*var\(--boot-bubble-radius\)/,
    literal: /\.boot-bubble\s*\{[^}]*border-radius:\s*\d+px/,
    consumer: { file: "style.css", needle: "--gosslan-bubble-radius" },
  },
] as const;

/** 构建时注入标记：`skeleton.css` 里必须有且只有一处。 */
export const BOOT_TOKENS_MARKER = "/* GOSSLAN_BOOT_TOKENS */";

/** 从 style.css 里取一个 token 的原始值（`40px` / `calc(...)`）。 */
export function readStyleToken(styleCss: string, name: string): string | null {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(styleCss);
  return m ? m[1].trim() : null;
}

export interface BootTokenBuild {
  /** 可直接塞进 `<style>` 的 `:root{…}` 声明块 */
  decls: string;
  /** `--boot-x` → 值，供判据比对 */
  values: Record<string, string>;
  /** 缺失的 token（build 时必须为空，否则构建直接失败） */
  missing: string[];
}

/**
 * 把 `style.css` 的几何 token 物化成骨架变量。
 *
 * 缺任何一个都返回 `missing` —— 调用方（vite 插件）遇到缺失直接抛错，
 * 不允许静默回落到骨架自己写的数字（那正是本模块要消灭的东西）。
 */
export function buildBootTokens(styleCss: string): BootTokenBuild {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const rule of BOOT_TOKEN_RULES) {
    const v = readStyleToken(styleCss, rule.styleToken);
    if (v == null) {
      missing.push(`--${rule.styleToken}`);
      continue;
    }
    values[`--boot-${rule.bootVar}`] = v;
  }
  const decls = `:root {\n${Object.entries(values)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}`;
  return { decls, values, missing };
}

export interface GuardIssue {
  line: number;
  message: string;
}

/**
 * SK-04：骨架几何必须与真实布局**同源**（不是两边各写一份恰好相等）。
 *
 * 四个方向同时判：
 *   ① `skeleton.css` 里每条受管规则都真的接了 `var(--boot-*)`；
 *   ② 同一规则里不许再出现对应的字面 px（写死数字即红）；
 *   ③ 骨架引用的每个 `--boot-*` 都能在 `style.css` 找到来源 token；
 *   ④ 真实组件确实在引用同一个 token（否则骨架"同源"到一个没人用的变量，等于空转）。
 *
 * 反例自证见 `designGuards.test.ts`：把 `.boot-cap` 改回 `height: 40px`、
 * 删掉真实组件里的 `--gosslan-list-title-h`、从 `style.css` 删掉一个 token，三种都必须红。
 */
export function checkBootSkeletonTokens(s: {
  skeletonCss: string;
  styleCss: string;
  /** 真实布局源码：相对 `src/` 的路径 → 内容 */
  sources: Record<string, string>;
}): GuardIssue[] {
  const out: GuardIssue[] = [];
  const built = buildBootTokens(s.styleCss);

  if (built.missing.length) {
    out.push({
      line: 0,
      message: `SK-04：style.css 缺少骨架依赖的几何 token：${built.missing.join("、")}。`,
    });
  }

  const markerCount = s.skeletonCss.split(BOOT_TOKENS_MARKER).length - 1;
  if (markerCount !== 1) {
    out.push({
      line: 0,
      message: `SK-04：skeleton.css 里 \`${BOOT_TOKENS_MARKER}\` 标记出现 ${markerCount} 次（必须恰好 1 次，构建时由插件替换成 token 声明）。`,
    });
  }

  for (const rule of BOOT_TOKEN_RULES) {
    if (!rule.usage.test(s.skeletonCss)) {
      out.push({
        line: 0,
        message: `SK-04：骨架没有接上 var(--boot-${rule.bootVar}) —— 它应与 --${rule.styleToken} 同源。`,
      });
    }
    if (rule.literal?.test(s.skeletonCss)) {
      out.push({
        line: 0,
        message: `SK-04：骨架里又写了字面 px（${rule.bootVar}）—— 受管几何只许用 var(--boot-*)。`,
      });
    }

    const consumerSrc = s.sources[rule.consumer.file];
    if (consumerSrc == null || !consumerSrc.includes(rule.consumer.needle)) {
      out.push({
        line: 0,
        message: `SK-04：${rule.consumer.file} 没有引用 ${rule.consumer.needle} —— 骨架与真实布局不再是同一个来源（判据会空转）。`,
      });
    }
  }

  const used = [...s.skeletonCss.matchAll(/var\((--boot-[a-z0-9-]+)\)/g)].map((m) => m[1]);
  // 骨架自己的颜色变量（--boot-app-bg / --boot-ink …）在 :root 里声明，不算孤儿；
  // 这里只看「既没在骨架里声明、也不在构建注入里」的那些。
  const declaredHere = new Set(
    [...s.skeletonCss.matchAll(/(--boot-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  for (const name of new Set(used)) {
    if (!(name in built.values) && !declaredHere.has(name)) {
      out.push({
        line: 0,
        message: `SK-04：骨架用了 ${name}，但它既不在 :root、也不在 BOOT_TOKEN_RULES 里 —— 每次构建都会变成未定义变量。`,
      });
    }
  }
  return out;
}
