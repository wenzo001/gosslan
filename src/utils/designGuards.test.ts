import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { disabledOpacityFromClasses, disabledOpacityFromRule, parseTokenScopes } from "./tokenContrast.ts";
import { TODO_AUTO_ARCHIVE_DAYS } from "./todos.ts";
import { mentionHighlightBg } from "./chatStyle.ts";
import {
  checkBubbleMetricsCoupling,
  findTemplateSlotIssues,
  checkStyleCascade,
  checkUnreadBadgeComponent,
  findHandWrittenBadges,
  findMenuWithoutBackdrop,
  findAvatarFaceWithoutAriaHidden,
  findModifierClassWithoutStyle,
  modifierClassesUsed,
  findRetiredLetterAvatarUsage,
  findHoverRevealIssues,
  findOutlineNoneWithoutFocusRing,
  findSmallTapTargets,
  findTappableWithoutKeyboard,
  countClickActionTags,
  findTruncationWithoutTitle,
  findPreWrapWithoutBreak,
  countPreWrapSites,
  checkTextFieldFocusRing,
  checkSelectionContract,
  findNestedThemeRuleIssues,
  findHandRolledSegmentLoops,
  findTopInsetWithoutBottomInset,
  findFixedOverlayWithoutWindowSafeTop,
  findMessageImageWithoutFetchHint,
  findFreshEmptyArrayProp,
  countListPropBindings,
  checkImageBubbleHeightSources,
  checkMergeCardHeightCoupling,
  countClassAttrs,
  findRawPlatformCheckInViewLayer,
  countCommonLayerPlatformImports,
  findImgTags,
  checkTodoCardImageLimit,
  findLiteralRadiusClasses,
  findDirectSemanticIconImports,
  findHandWrittenSolidDangerButtons,
  findHandWrittenCancelButtons,
  sharedButtonChromeIssues,
  findPrimaryFillWithoutOnPrimary,
  findNativeSelect,
  findVHtmlSinks,
  V_HTML_ALLOWED,
} from "./designGuards.ts";

// ---------------- ⓪ 选中态/原生控件颜色必须吃主题变量（#35-N7） ----------------
// 判的是形状而不是像素：写死十六进制在换主题色时不会跟着走，等于把"跟随主题"又做回硬编码。
test("⓪ ::selection 与 accent-color 必须吃主题变量（#35-N7）", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  const sel =
    /::selection\s*{[^}]*background:\s*color-mix\(\s*in srgb,\s*var\(--gosslan-primary\)/.exec(css);
  assert.ok(sel, "style.css 里必须有 ::selection，且背景由 --gosslan-primary 现算（不许写死十六进制）");
  assert.match(
    css,
    /accent-color:\s*var\(--gosslan-primary\)/,
    "input/select/textarea/progress 的 accent-color 必须吃主题变量",
  );
});

// ---------------- ㉚ 主题色规则必须在顶层（#35-N7 的真实缺陷） ----------------
// 判"有没有写"挡不住这次这种"写了但匹配不到"：两条规则被写在 input{…} 的括号里，
// 原生嵌套把它们编译成后代选择器（`input ::selection` / `[contenteditable=""] progress`），
// 源码正则照过、产物里整条不生效。所以这里判的是**嵌套深度**，并且反向用例就是当时的真实写法。
test("㉚ 真实 style.css：两条主题色规则都在顶层（0 条报红）", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  assert.deepEqual(findNestedThemeRuleIssues(css), []);
});

test("㉚ 反向用例：写在 input{} 括号里 → 两条都报红（这就是 2026-10-09 之前的实际形状）", () => {
  const nested = `input,textarea,select,[contenteditable="true"] {
  caret-color: var(--gosslan-primary);
  ::selection {
    background: color-mix(in srgb, var(--gosslan-primary) 30%, transparent);
    color: inherit;
  }
  input, select, textarea, progress {
    accent-color: var(--gosslan-primary);
  }
}
`;
  const msgs = findNestedThemeRuleIssues(nested).map((i) => i.message);
  assert.equal(msgs.length, 2, msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes("::selection")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.includes("accent-color")), msgs.join("\n"));
});

test("㉚ 两条都缺 → 也报红（判据不许因为「没写」而静默绿）", () => {
  const msgs = findNestedThemeRuleIssues("a { color: red }").map((i) => i.message);
  assert.equal(msgs.length, 2, msgs.join("\n"));
});

test("㉚ 媒体查询里写 ::selection 是合法形状，不许误伤", () => {
  const ok = `@media (prefers-reduced-transparency: reduce) {
  ::selection { background: color-mix(in srgb, var(--gosslan-primary) 30%, transparent); }
}
progress { accent-color: var(--gosslan-primary) }
`;
  assert.deepEqual(findNestedThemeRuleIssues(ok), []);
});

// ---------------- ① 悬停揭示必须有触屏兜底 ----------------
//
// 真实事故（2026-09-10 审计 P0-1）：会话行的删除键写成
// `hidden` + `group-hover/conv:flex` —— 桌面能删、**Android 上按钮永远不显示**，
// 因为触屏没有 hover。第一段用例就是照当时的真实写法缩写的。

test("复现历史缺陷：hidden + group-hover:flex 没有兜底类 → 报出", () => {
  const buggy = `<template>
  <div class="group/conv relative flex h-[64px]">
    <button class="absolute bottom-1.5 right-1.5 z-10 hidden h-6 w-6 group-hover/conv:flex">
      <X />
    </button>
  </div>
</template>`;
  const issues = findHoverRevealIssues(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 3, "应精确指到那一行");
  assert.match(issues[0].message, /永远不显示/);
});

test("加了 hover-reveal 之后通过", () => {
  const fixed = `<template>
  <button class="hover-reveal hidden h-6 w-6 group-hover/conv:flex"><X /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(fixed), []);
});

test("opacity-0 + group-hover 揭示 → 需要 hover-reveal-op", () => {
  const buggy = `<template>
  <span class="absolute inset-0 bg-black/40 opacity-0 transition group-hover:opacity-100"><Camera /></span>
</template>`;
  const issues = findHoverRevealIssues(buggy);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /hover-reveal-op/);

  const fixed = buggy.replace('class="absolute', 'class="hover-reveal-op absolute');
  assert.deepEqual(findHoverRevealIssues(fixed), []);
});

test("常显但 hover 时更不透明（opacity-70 → opacity-100）不算揭示，不报", () => {
  const ok = `<template>
  <button class="opacity-70 transition hover:opacity-100"><Copy /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(ok), []);
});

test("独立的 hover 效果（不是揭示）不报", () => {
  const ok = `<template>
  <button class="hidden hover:bg-red-500/10"><X /></button>
  <button class="opacity-0 hover:opacity-100"><X /></button>
</template>`;
  assert.deepEqual(findHoverRevealIssues(ok), []);
});

test("逃生阀：带 hover-reveal-ok 的文件整体跳过", () => {
  const optedOut = `<!-- hover-reveal-ok -->
<template><button class="hidden group-hover:flex"><X /></button></template>`;
  assert.deepEqual(findHoverRevealIssues(optedOut), []);
});

// ---------------- ② 降级媒体查询必须排在 style.css 末尾 ----------------
//
// 真实踩坑：`.glass` / `.frost` 的定义在文件中更靠后，同优先级下"后定义者胜"，
// 降级块写在前面会被**完整覆盖**——不报错、不失败，只是静默无效。

const OK_CSS = `
.glass { backdrop-filter: blur(6px); }
.frost { backdrop-filter: blur(6px); }

.kb-reveal { opacity: 0; pointer-events: none; }
.kb-reveal:focus-visible,
.kb-reveal-on { opacity: 1; pointer-events: auto; }

@media (hover: none) {
  .hover-reveal { display: flex !important; }
  .hover-reveal-op { opacity: 1 !important; }
  .kb-reveal { opacity: 1; pointer-events: auto; }
}

@media (prefers-reduced-transparency: reduce) {
  .frost { backdrop-filter: none; }
  .glass { backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  :root { --gosslan-border: #94a3b8; }
}
`;

test("正确顺序（降级块在末尾）→ 通过", () => {
  assert.deepEqual(checkStyleCascade(OK_CSS), []);
});

test("降级块排在 .glass/.frost 定义之前 → 报出（会被覆盖而静默失效）", () => {
  const wrongOrder = `
@media (prefers-reduced-transparency: reduce) {
  .glass { backdrop-filter: none; }
}
@media (prefers-contrast: more) {
  :root { --gosslan-border: #94a3b8; }
}
.glass { backdrop-filter: blur(6px); }
.frost { backdrop-filter: blur(6px); }
@media (hover: none) {
  .hover-reveal { display: flex !important; }
  .hover-reveal-op { opacity: 1 !important; }
}
`;
  const issues = checkStyleCascade(wrongOrder);
  const messages = issues.map((i) => i.message).join("\n");
  assert.match(messages, /降低透明度/);
  assert.match(messages, /提高对比度/);
});

test("缺少降级块 / 缺少 hover 兜底块 → 都要报", () => {
  const bare = `.glass { backdrop-filter: blur(6px); }\n`;
  const messages = checkStyleCascade(bare).map((i) => i.message).join("\n");
  assert.match(messages, /降低透明度/);
  assert.match(messages, /提高对比度/);
  assert.match(messages, /hover: none/);
});

test(".hover-reveal 定义在 (hover: none) 之外 → 报出（会在有 hover 的设备上也常显）", () => {
  const wrong = `
.hover-reveal { display: flex !important; }
.hover-reveal-op { opacity: 1 !important; }
@media (hover: none) {
  .tap-safe { position: relative; }
}
.glass { backdrop-filter: blur(6px); }
@media (prefers-reduced-transparency: reduce) { .glass { backdrop-filter: none; } }
@media (prefers-contrast: more) { :root { --gosslan-border: #94a3b8; } }
`;
  const messages = checkStyleCascade(wrong).map((i) => i.message).join("\n");
  assert.match(messages, /@media \(hover: none\) 之外/);
});

// ---------------- ③ 未读徽标必须走唯一实现 ----------------
//
// 真实踩坑（2026-09-12，用户反馈「红点数字没在圆里居中，上宽下窄」）：
// 徽标数字需要 1.5px 光学补偿才能垂直居中（字形在行盒里天然偏下：实测上间隙 10 /
// 下间隙 7，2x 截图，三处徽标一致）。而 5 处手写副本里有 2 处漏了配套的
// `leading-none` —— 同一徽标在不同位置基线不一致。第一段用例照当时的真实写法缩写。

test("复现历史缺陷：手写未读徽标 → 报出并指向替代组件", () => {
  const buggy = `<template>
  <span class="relative">
    <MessageCircle class="h-5 w-5" />
    <span
      v-if="chat.totalUnread > 0"
      class="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--gosslan-danger)] px-1 text-[11px] font-medium text-white"
    >
      {{ chat.totalUnread }}
    </span>
  </span>
</template>`;
  const issues = findHandWrittenBadges(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 6, "应精确指到那一行（class 所在行）");
  assert.match(issues[0].message, /UnreadBadge/);
});

test("改用 UnreadBadge 组件之后通过", () => {
  const fixed = `<template>
  <span class="relative">
    <MessageCircle class="h-5 w-5" />
    <UnreadBadge v-if="chat.totalUnread > 0" :count="chat.totalUnread" class="absolute -right-2.5 -top-1" />
  </span>
</template>`;
  assert.deepEqual(findHandWrittenBadges(fixed), []);
});

test("单独用 min-w-4 或单独用 danger 色、但不是徽标的元素，不报", () => {
  const ok = `<template>
  <span class="min-w-4 rounded px-2">标签</span>
  <span class="bg-[var(--gosslan-danger)] px-2 text-white">错误提示</span>
</template>`;
  assert.deepEqual(findHandWrittenBadges(ok), []);
});

test("徽标组件自身缺补偿或缺 leading-none → 都要报", () => {
  const full =
    '<span class="flex h-4 min-w-4 items-center justify-center rounded-full ' +
    'bg-[var(--gosslan-danger)] px-1 pb-[1.5px] text-[11px] leading-none text-white">3</span>';
  assert.deepEqual(checkUnreadBadgeComponent(full), []);

  const noPad = full.replace(" pb-[1.5px]", "");
  assert.equal(checkUnreadBadgeComponent(noPad).length, 1);
  assert.match(checkUnreadBadgeComponent(noPad)[0].message, /pb-\[1\.5px\]/);

  const noLeading = full.replace(" leading-none", "");
  assert.equal(checkUnreadBadgeComponent(noLeading).length, 1);
  assert.match(checkUnreadBadgeComponent(noLeading)[0].message, /leading-none/);
});

test("注释里提到类名、真实 class 属性里没有 → 仍要报（防「因为注释而通过」）", () => {
  // 首版护栏用 `src.includes("pb-[1.5px]")` 扫全文，于是组件 JSDoc 里提到这些类名
  // 就"通过"了 —— 是空转护栏。这条用例把这个假通过固化成反面样本。
  const commentOnly = `<!-- 参考写法：pb-[1.5px] leading-none -->
<span class="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--gosslan-danger)] px-1 text-[11px] text-white">3</span>`;
  const issues = checkUnreadBadgeComponent(commentOnly);
  assert.equal(issues.length, 2, "补偿与 leading-none 都缺，两条都要报");
  assert.match(issues.map((i) => i.message).join("\n"), /pb-\[1\.5px\]/);
});

// ---------------- ④ 截断文本必须有 title / aria-label ----------------
//
// 真实背景：`truncate` 把名字/地址/文件名截成「…」，完整内容只留在 DOM 里 ——
// 只有在界面上真去 hover 才会发现「看不到全名」。用户 2026-09-10 审计与
// 2026-09-12 反馈各报了一次（消息列表名、通讯录名、引用预览条…）。
// 首段用例照当时的真实写法（截断但无 title）缩写。

test("复现历史缺陷：truncate 但没有 title → 报出并指到那一行", () => {
  const buggy = `<template>
  <span class="truncate text-sm">{{ name }}</span>
</template>`;
  const issues = findTruncationWithoutTitle(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2, "应精确指到那一行");
  assert.match(issues[0].message, /title/);
});

test("跨行的开标签（class 与内容分行）也要抓到", () => {
  const multiline = `<template>
  <span
    class="truncate text-sm"
  >{{ name }}</span>
</template>`;
  assert.equal(findTruncationWithoutTitle(multiline).length, 1);
});

test("补了 :title 或 aria-label 之后通过", () => {
  const fixed = `<template>
  <span class="truncate text-sm" :title="name">{{ name }}</span>
  <span class="truncate text-sm" aria-label="x">x</span>
</template>`;
  assert.deepEqual(findTruncationWithoutTitle(fixed), []);
});

test("注释里提到 truncate、真实 class 里没有 → 不误报", () => {
  const commentOnly = `<!-- 这里不要写 truncate -->
<template><span class="text-sm">{{ name }}</span></template>`;
  assert.deepEqual(findTruncationWithoutTitle(commentOnly), []);
});

test("注释里提到 title、真实元素没有 → 仍要报（防「因为注释而通过」）", () => {
  const commentOnly = `<!-- 参考写法：truncate + :title -->
<template>
  <span class="truncate text-sm">{{ name }}</span>
</template>`;
  assert.equal(findTruncationWithoutTitle(commentOnly).length, 1);
});

test("逃生阀：带 truncate-title-ok 注释的文件整体跳过", () => {
  const optedOut = `<!-- truncate-title-ok：恒为短文案 -->
<template><span class="truncate">在线</span></template>`;
  assert.deepEqual(findTruncationWithoutTitle(optedOut), []);
});

// ---------------- ⑤ 气泡排版必须与虚拟列表高度度量一致 ----------------
//
// 真实背景：`previewMetrics.ts` 的 `TEXT_LINE_RATIO` / `TEXT_BUBBLE_PADDING`
// 是气泡组件 `leading-*` / `py-*` 的镜像。2026-09-12 按用户反馈把气泡从
// `py-2 + leading-relaxed` 收紧到 `py-1.5 + leading-normal` 时，**两处必须同时改**
// —— 只改一处不会报错、不会让任何行为测试变红，只有滚动到相邻消息才会互相遮挡。

test("复现风险：气泡行高与度量不一致 → 报出并给出应改的数值", () => {
  const bubble = `<template>
  <div class="group relative min-w-0 px-3 py-1.5 leading-relaxed" :style="bubbleStyle"></div>
</template>`;
  const metrics = `const TEXT_LINE_RATIO = 1.5;\nconst TEXT_BUBBLE_PADDING = 12;`;
  const issues = checkBubbleMetricsCoupling(bubble, metrics);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /leading-relaxed/);
  assert.match(issues[0].message, /1\.625/, "应指出组件实际行高");
});

test("复现风险：气泡内边距与度量不一致 → 报出", () => {
  const bubble = `<template>
  <div class="group relative min-w-0 px-3 py-2 leading-normal"></div>
</template>`;
  const metrics = `const TEXT_LINE_RATIO = 1.5;\nconst TEXT_BUBBLE_PADDING = 12;`;
  const issues = checkBubbleMetricsCoupling(bubble, metrics);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /16px/);
});

test("两边一致 → 通过", () => {
  const bubble = `<template>
  <div class="group relative min-w-0 px-3 py-1.5 leading-normal"></div>
</template>`;
  const metrics = `const TEXT_LINE_RATIO = 1.5;\nconst TEXT_BUBBLE_PADDING = 12;`;
  assert.deepEqual(checkBubbleMetricsCoupling(bubble, metrics), []);
});

test("找不到气泡根元素 / 缺少常量 → 显式报出（不静默通过）", () => {
  assert.equal(checkBubbleMetricsCoupling(`<template><div></div></template>`, "x").length, 1);
  const bubble = `<template><div class="min-w-0 leading-normal py-1.5"></div></template>`;
  assert.equal(checkBubbleMetricsCoupling(bubble, "const NOTHING = 1;").length, 2);
});

// ---------------- ⑥ 可点击元素必须能用键盘触发 ----------------
//
// 真实情况（2026-09-12 复核）：好友选择行、图片/文件气泡、指纹复制都是 `div @click`。
// 触屏和鼠标都能用，**键盘完全够不着** —— 这类缺陷在真机上"能用"，只有拿键盘走一遍
// 或开读屏才会发现，因此必须由机器盯住。

test("复现真实缺陷：div + @click 没有任何键盘/语义补充 → 报出", () => {
  const buggy = `<template>
  <div class="cursor-pointer" @click="open()">打开</div>
</template>`;
  const issues = findTappableWithoutKeyboard(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2, "应精确指到那一行");
  assert.match(issues[0].message, /Tab 不到/);
});

test("role + tabindex + 回车/空格键处理之后通过", () => {
  const fixed = `<template>
  <div role="button" tabindex="0" @click="open()" @keydown.enter.prevent="open()" @keydown.space.prevent="open()">打开</div>
</template>`;
  assert.deepEqual(findTappableWithoutKeyboard(fixed), []);
});

test("补上焦点或键盘事件即可放行（含 :tabindex 绑定形式）", () => {
  for (const extra of [
    ':role="ready ? \'button\' : undefined"', // 动态 role 推断不出值 ⇒ 不报（报了就是假红）
    'tabindex="0"',
    ':tabindex="ready ? 0 : undefined"',
    '@keydown.enter="open()"',
    'v-on:keyup.enter="open()"',
    'role="dialog" tabindex="-1"', // 容器角色：本就不该进 Tab 序
    'role="textbox" contenteditable="true"', // contenteditable 自己就可聚焦
  ]) {
    const ok = `<template>\n  <div @click="open()" ${extra}>x</div>\n</template>`;
    assert.deepEqual(findTappableWithoutKeyboard(ok), [], `补 ${extra} 后不该再报`);
  }
});

test("⑥ 的洞（2026-10-10 补，roadmap N19）：静态 button 类 role 但没有 tabindex ⇒ 仍然要报", () => {
  // 这条原来用 OR 判定，于是 role="button" 单独存在就放行 —— 而 role 只给"读屏念得出按钮"，
  // **不给可聚焦性**，键盘照样 Tab 不到。真实形状就是置顶行那颗 `span role="button"`。
  const hole = `<template>\n  <span role="button" @click.stop="togglePin(p.id)">✕</span>\n</template>`;
  const issues = findTappableWithoutKeyboard(hole);
  assert.equal(issues.length, 1, `该报一条，现数 ${issues.length}`);
  assert.match(issues[0].message, /没有 `tabindex`/);
  assert.equal(issues[0].line, 2);
  // 同一条改成真按钮就不再报（这就是建议的修法）
  assert.deepEqual(
    findTappableWithoutKeyboard('<template>\n  <button type="button" @click.stop="f()">✕</button>\n</template>'),
    [],
  );
  // 动态 role 不报（推断不出值）；容器角色不报
  assert.deepEqual(
    findTappableWithoutKeyboard('<template>\n  <span :role="k" @click="f()">x</span>\n</template>'),
    [],
  );
});

test("遮罩层（aria-hidden）不是按钮，不报", () => {
  const backdrop = `<template>
  <div class="fixed inset-0 bg-black/40" aria-hidden="true" @click="emit('close')" />
</template>`;
  assert.deepEqual(findTappableWithoutKeyboard(backdrop), []);
});

test("只拦冒泡的 @click.stop 不是动作，不报", () => {
  const stopper = `<template>
  <div class="frost absolute" @click.stop>
    <span>内容</span>
  </div>
</template>`;
  assert.deepEqual(findTappableWithoutKeyboard(stopper), []);
});

test("原生按钮与链接不在扫描范围", () => {
  const native = `<template>
  <button type="button" @click="open()">打开</button>
  <a href="#" @click.prevent="open()">链接</a>
  <label @click="pick()">选择</label>
</template>`;
  assert.deepEqual(findTappableWithoutKeyboard(native), []);
});

test("tap-keyboard-ok 逃生阀：整文件跳过", () => {
  const withEscape = `<!-- tap-keyboard-ok -->
<template>
  <div @click="open()">x</div>
</template>`;
  assert.deepEqual(findTappableWithoutKeyboard(withEscape), []);
});

// ---------------- ⑦ `outline-none` 必须自带焦点指示 ----------------
//
// 真实缺陷（2026-09-12）：全局焦点环写在 `:where(...)` 里（特异性 0），
// 会被 Tailwind 的 `.outline-none`（0,1,0）**静默覆盖** —— 7 处输入框
// （含最高频的消息输入框）因此完全没有焦点指示，而代码看起来"有全局规则在管"。
// 这条护栏把"关掉了轮廓就必须自己给指示"钉死。

test("复现真实缺陷：outline-none 且没有替代指示 → 报出", () => {
  const buggy = `<template>
  <input class="w-full outline-none" />
</template>`;
  const issues = findOutlineNoneWithoutFocusRing(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
  assert.match(issues[0].message, /静默覆盖/);
});

test("给了替代焦点指示就通过（ring / border 都算）", () => {
  for (const extra of [
    "focus:ring-2 focus:ring-primary",
    "focus-visible:ring-2 focus-visible:ring-primary",
    "focus:border-[var(--gosslan-primary)]",
    "focus-visible:outline-none focus-visible:ring-1",
  ]) {
    const ok = `<template>\n  <input class="outline-none ${extra}" />\n</template>`;
    assert.deepEqual(findOutlineNoneWithoutFocusRing(ok), [], `带 ${extra} 时不该报`);
  }
});

test("删掉 outline-none（改用全局焦点环）就通过", () => {
  const ok = `<template>
  <input class="w-full" />
  <div contenteditable="true" class="min-h-10"></div>
</template>`;
  assert.deepEqual(findOutlineNoneWithoutFocusRing(ok), []);
});

test("文件级逃生阀（`focus-ring-ok:file`）：菜单/对话框容器整文件跳过", () => {
  const withEscape = `<!-- focus-ring-ok:file -->
<template>
  <div role="menu" tabindex="-1" class="frost outline-none">…</div>
</template>`;
  assert.deepEqual(findOutlineNoneWithoutFocusRing(withEscape), []);
});

// ---------------- 元素级逃生阀（2026-09-16） ----------------
//
// 真实教训：`MessageComposer.vue` 因为「消息输入框不画焦点环」这**一个元素**的需求，
// 用了**文件级**逃生阀 ⇒ 整个文件（含其中的按钮等键盘可聚焦元素）一起失去本条保护；
// 更糟的是 `scripts/verify-guards.py` 里注入该文件的非空转用例退化成**空转**
// （改坏也不报），而项目里没有任何东西自动跑 verify-guards，所以一直没人发现。
// ⇒ 粒度必须能到元素，且元素级的豁免**绝不能**外溢到同文件的其它元素。

test("元素级逃生阀（`data-focus-ring-ok`）：豁免它自己那一个元素", () => {
  const src = `<template>
  <div data-focus-ring-ok class="frost outline-none">输入区</div>
</template>`;
  assert.deepEqual(findOutlineNoneWithoutFocusRing(src), []);
});

test("⚠️ 元素级逃生阀不得豁免同文件里的其它元素（粒度错的回归）", () => {
  // 这条同时钉住两个坑：
  //  ① 豁免不能外溢 —— 旁边的按钮没有被标记，必须照旧报出来；
  //  ② 令牌互不为子串 —— `data-focus-ring-ok` **含有** `focus-ring-ok` 子串，
  //     所以文件级判据不能还写成 `src.includes("focus-ring-ok")`，
  //     否则"只豁免一个元素"会被当成"整文件豁免"，这条断言会直接失败。
  const src = `<template>
  <div data-focus-ring-ok class="frost outline-none">输入区</div>
  <button class="h-8 w-8 outline-none"><X /></button>
</template>`;
  const issues = findOutlineNoneWithoutFocusRing(src);
  assert.equal(issues.length, 1, "被标记的那个元素豁免了，但旁边未标记的按钮必须报出来");
  assert.match(issues[0].message, /静默覆盖/);
});

test("注释里提到 outline-none 不算（只看真实 class 属性）", () => {
  const commentOnly = `<!-- 注意：不要在这里加 outline-none -->
<template>
  <input class="w-full" />
</template>`;
  assert.deepEqual(findOutlineNoneWithoutFocusRing(commentOnly), []);
});

// ---------------- ⑧ 小尺寸可交互元素必须有 tap-safe ----------------
//
// 真实情况（2026-09-12 复核）：35 个小尺寸可交互元素里仍有 8 处漏掉 `tap-safe` ——
// 包括移动端的返回键、删除「跨网段端点」的垃圾桶、自定义主题取色控件。
// 桌面鼠标点 28px 没问题，**手指点就容易不中或误触相邻项**（HIG 最小 44pt）。

test("复现真实缺陷：h-7 图标按钮没有 tap-safe → 报出", () => {
  const buggy = `<template>
  <button class="flex h-7 w-7 items-center justify-center" @click="remove()">
    <Trash2 />
  </button>
</template>`;
  const issues = findSmallTapTargets(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
  assert.match(issues[0].message, /44×44pt/);
});

test("加了 tap-safe 就通过", () => {
  const ok = `<template>
  <button class="tap-safe flex h-7 w-7 items-center justify-center" @click="remove()">
    <Trash2 />
  </button>
</template>`;
  assert.deepEqual(findSmallTapTargets(ok), []);
});

test("达标的尺寸不算小（h-11 = 44px）", () => {
  const ok = `<template>
  <button class="flex h-11 w-11 items-center justify-center" @click="ok()">x</button>
</template>`;
  assert.deepEqual(findSmallTapTargets(ok), []);
});

test("不可交互的小元素不报（纯装饰）", () => {
  const decorative = `<template>
  <div class="h-6 w-6 rounded-full bg-primary"></div>
  <span class="h-5 w-5"><Check /></span>
</template>`;
  assert.deepEqual(findSmallTapTargets(decorative), []);
});

test("复现真实缺陷：h-4 w-4 的 span[role=button] 没有 tap-safe → 报出（2026-10-09 之前这档根本扫不到）", () => {
  const buggy = `<template>
  <span class="flex h-4 w-4 items-center justify-center" role="button" @click.stop="unpin()">x</span>
</template>`;
  const issues = findSmallTapTargets(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
  assert.match(issues[0].message, /44×44pt/);
});

test("h-4 加了 tap-safe 就通过（口径放宽不等于把已有写法全判死）", () => {
  const ok = `<template>
  <span class="tap-safe flex h-4 w-4" role="button" @click.stop="unpin()">x</span>
</template>`;
  assert.deepEqual(findSmallTapTargets(ok), []);
});

test("带 @click 的非按钮小元素同样要 tap-safe", () => {
  const buggy = `<template>
  <div class="h-6 w-6 cursor-pointer" role="button" tabindex="0" @click="go()">x</div>
</template>`;
  assert.equal(findSmallTapTargets(buggy).length, 1);
});

test("tap-target-ok 逃生阀：整文件跳过", () => {
  const withEscape = `<!-- tap-target-ok -->
<template>
  <button class="h-6 w-6" @click="go()">x</button>
</template>`;
  assert.deepEqual(findSmallTapTargets(withEscape), []);
});

// ---------------- ⑨ as="template" 插槽不得有注释/多根节点 ----------------
//
// 真实事故（2026-09-12 用户实测）：点「+ → 添加好友」整个窗口卡死。根因是
// `BaseModal.vue` 在 `<TransitionChild as="template">` 的插槽里放了一条 HTML 注释：
// **dev 构建保留注释** ⇒ 插槽多出一个节点 ⇒ Headless UI 抛 "Passing props on template!"
// ⇒ Vue 渲染抛错后整个界面再也 patch 不动。生产构建会剥掉注释，所以只在 dev 复现。

test("复现真实缺陷：as=template 的插槽里有 HTML 注释 → 报出", () => {
  const buggy = `<template>
<TransitionRoot :show="open" as="template">
  <Dialog as="div">
    <TransitionChild as="template">
      <!-- 说明文字 -->
      <DialogPanel v-if="fullscreen">A</DialogPanel>
      <DialogPanel v-else>B</DialogPanel>
    </TransitionChild>
  </Dialog>
</TransitionRoot>
</template>`;
  const issues = findTemplateSlotIssues(buggy);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /HTML 注释/);
  assert.match(issues[0].message, /卡死/);
});

test("注释移到组件外面就通过", () => {
  const ok = `<template>
<!-- 说明文字放在外面 -->
<TransitionRoot :show="open" as="template">
  <Dialog as="div"><TransitionChild as="template"><div /></TransitionChild></Dialog>
</TransitionRoot>
</template>`;
  assert.deepEqual(findTemplateSlotIssues(ok), []);
});

test("插槽里多个顶层节点 → 报出（同样会抛 template 错误）", () => {
  const buggy = `<template>
<Foo as="template">
  <div>A</div>
  <div>B</div>
</Foo>
</template>`;
  const issues = findTemplateSlotIssues(buggy);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /顶层节点/);
});

test("单节点、嵌套里有注释都不算（只看直接插槽）", () => {
  const ok = `<template>
<Foo as="template">
  <div>
    <!-- 子元素内部的注释无妨 -->
    <span>x</span>
  </div>
</Foo>
</template>`;
  assert.deepEqual(findTemplateSlotIssues(ok), []);
});

test("v-if / v-else 链只算一个节点", () => {
  const ok = `<template>
<Foo as="template">
  <DialogPanel v-if="fullscreen">A</DialogPanel>
  <DialogPanel v-else>B</DialogPanel>
</Foo>
</template>`;
  assert.deepEqual(findTemplateSlotIssues(ok), []);
});

test("两个**独立**元素（没有 v-else 关系）仍然报出", () => {
  const buggy = `<template>
<Foo as="template">
  <div v-if="a">A</div>
  <div>B</div>
</Foo>
</template>`;
  assert.equal(findTemplateSlotIssues(buggy).length, 1);
});

test("普通组件（没有 as=template）里有注释不报", () => {
  const ok = `<template>
<div>
  <!-- 随便注释 -->
  <span>x</span>
</div>
</template>`;
  assert.deepEqual(findTemplateSlotIssues(ok), []);
});

// ---------------- 全库扫描：真实文件必须干净 ----------------

function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectVueFiles(full, out);
    else if (entry.name.endsWith(".vue")) out.push(full);
  }
  return out;
}

test("src 下所有小尺寸可交互元素都带 tap-safe", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findSmallTapTargets(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下元素点按目标过小：\n${bad.join("\n")}`);
});

test("默认头像（emoji）的 aria-hidden：漏写就报，写了就放行（夹具）", () => {
  const buggy = `<template><span class="gosslan-avatar-emoji text-sm" :data-len="3">KEEN</span></template>`;
  const fixed = `<template><span class="gosslan-avatar-emoji text-sm" :data-len="3" aria-hidden="true">KEEN</span></template>`;
  // 多行标签也要判得住（真实代码里一半是这种写法）
  const multilineFixed = `<template><span
  class="gosslan-avatar-emoji text-sm"
  aria-hidden="true"
>{{ x }}</span></template>`;
  const multilineBuggy = `<template><span
  class="gosslan-avatar-emoji text-sm"
  :title="n"
>{{ x }}</span></template>`;
  assert.equal(findAvatarFaceWithoutAriaHidden(buggy).length, 1, "漏写 aria-hidden 必须报");
  assert.deepEqual(findAvatarFaceWithoutAriaHidden(fixed), []);
  assert.deepEqual(findAvatarFaceWithoutAriaHidden(multilineFixed), []);
  assert.equal(findAvatarFaceWithoutAriaHidden(multilineBuggy).length, 1, "多行标签同样要判得住");
});

test("src 下所有默认头像都对读屏隐藏", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const bad: string[] = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    seen += (src.match(/gosslan-avatar-emoji/g) ?? []).length;
    for (const issue of findAvatarFaceWithoutAriaHidden(src)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  // 判据不能空转。2026-10-29 审计 DUP-08 之后"十几处"这件事搬家了：画法只剩一个家，
  // 所以空转控制改成钉两件事 —— ① 那个家自己带 `aria-hidden`（它一丢，整站默认头像都会被念出来），
  // ② 真有 ≥12 个组件在用它（"家存在但没人接"是另一类静默失效）。
  const home = readFileSync(join(srcDir, "components", "ui", "AvatarBox.vue"), "utf8");
  assert.match(home, /class="gosslan-avatar-emoji" aria-hidden="true"/,
    "头像框那个家必须自己带 aria-hidden（丢了它，全站默认头像都会被读屏念出来）");
  const callSites = files.filter((x) => /<AvatarBox\b/.test(readFileSync(x, "utf8"))).length;
  assert.ok(callSites >= 12, `头像框的调用点只数到 ${callSites} 个 ⇒ 那个家没被接上，或扫描失效`);
  assert.ok(seen >= 1, `只扫到 ${seen} 处默认头像，扫描口径疑似失效`);
  assert.deepEqual(bad, [], `以下默认头像会被读屏念出来：\n${bad.join("\n")}`);
});

test("src 下所有 as=template 的插槽都干净（无注释、单节点）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findTemplateSlotIssues(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下 as="template" 插槽有问题：\n${bad.join("\n")}`);
});

test("src 下所有 outline-none 都自带焦点指示", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findOutlineNoneWithoutFocusRing(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下元素关掉了焦点指示却没有替代：\n${bad.join("\n")}`);
});

test("src 下所有可点击元素都能用键盘触发（含 ⑥ 补上的那一半：role 不给可聚焦性）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    seen += countClickActionTags(src);
    for (const issue of findTappableWithoutKeyboard(src)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  // 分母必须自己说话：一个"非交互标签 + 动作 @click"都看不见时，这条判据（尤其新加的那一半）就是空转。
  assert.ok(seen >= 6, `全 src 只数到 ${seen} 个"非交互标签 + 动作 @click" ⇒ 判据大概已经看不见东西了`);
  assert.deepEqual(bad, [], `以下元素能点但键盘够不着：\n${bad.join("\n")}`);
  console.log(`· N19 真实树分母：${files.length} 份 .vue / ${seen} 个可点击的非交互标签，键盘入口全都齐（含 role 无 tabindex 那一型）`);
});

test("N19：.kb-reveal 那一家缺任一份都要报（拿真实 style.css 做两处单点删改）", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  assert.deepEqual(checkStyleCascade(css), [], "现树那份 style.css 必须两条都满足");
  // ① 删掉触屏兜底那份 ⇒ 报（手机上那颗操作看不见也点不着）
  const noTouch = css.replace(/\n\s*\/\* 上面那一家的触屏档[^]*?\*\/\n\s*\.kb-reveal \{\n\s*opacity: 1;\n\s*pointer-events: auto;\n\s*\}/, "");
  assert.notEqual(noTouch, css, "反面用例的锚点没找到 ⇒ 这条用例本身是空转");
  assert.match(checkStyleCascade(noTouch).map((i) => i.message).join("\n"), /没有\*\*兜底那份/);
  // ② 只留块内那一份（把块外基础那条删掉）⇒ 基础那份落到块内 ⇒ 报"基础规则写在 (hover:none) 之内"
  const baseAt = css.indexOf(".kb-reveal {");
  const onlyInside = css.slice(0, baseAt) + css.slice(css.indexOf("}", baseAt) + 1);
  assert.match(checkStyleCascade(onlyInside).map((i) => i.message).join("\n"), /基础\*\*规则写在 @media \(hover: none\) 之内/);
});

test("src 下所有 .vue 的悬停揭示都带了触屏兜底", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findHoverRevealIssues(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现缺少触屏兜底的悬停揭示：\n${bad.join("\n")}`);
});

test("src 下所有 .vue 的截断文本都带了 title / aria-label", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findTruncationWithoutTitle(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现被截断却没有 title 的文本：\n${bad.join("\n")}`);
});

// 用户 2026-10-23：群公告里打一串数字 ⇒ 横向滚动条。`whitespace-pre-wrap` 只保留换行、
// 仍按**词**断行，一整串数字是一个词 ⇒ 撑出容器；外层 `overflow-y:auto` 又会让 overflow-x
// 算成 auto ⇒ 长出横向条。这条判据盯的就是「pre-wrap 却没配断词」这个形状。
test("whitespace-pre-wrap 必须配强制断词（长数字/URL 不许撑出横向滚动条）", () => {
  const buggy = `<template><p class="whitespace-pre-wrap px-3 py-2 text-sm">{{ text }}</p></template>`;
  const issues = findPreWrapWithoutBreak(buggy);
  assert.equal(issues.length, 1, "只写 pre-wrap、没有断词 ⇒ 必须报一条");
  assert.match(issues[0].message, /横向滚动条|断词/);

  // 三种断词出口各认一次（少认一种就是下一次换写法时静默漏掉）
  for (const exit of ["break-words", "break-all", "break-anywhere"]) {
    assert.deepEqual(
      findPreWrapWithoutBreak(`<template><p class="whitespace-pre-wrap ${exit}">{{ t }}</p></template>`),
      [],
      `断词出口 ${exit} 必须被认成已处理`,
    );
  }
  // 内联 :style 的 word-break 也是出口
  assert.deepEqual(
    findPreWrapWithoutBreak(
      `<template><div class="whitespace-pre-wrap" :style="{ wordBreak: 'break-word' }">{{ t }}</div></template>`,
    ),
    [],
    "内联 word-break 写法不该误伤",
  );

  const fixed = `<template><p class="whitespace-pre-wrap break-words px-3 py-2">{{ t }}</p></template>`;
  assert.deepEqual(findPreWrapWithoutBreak(fixed), []);

  // 注释里提一句不能让护栏报红（与本仓其它 class 判据同口径）
  const commentOnly = `<script setup>
/** 这里原来漏了 whitespace-pre-wrap，后来补上的 */
</script>
<template><p>{{ t }}</p></template>`;
  assert.deepEqual(findPreWrapWithoutBreak(commentOnly), [], "注释里的类名不算挂上了类");

  const optedOut = `<template><!-- prewrap-break-ok：代码块按横向滚动设计 -->
    <pre class="whitespace-pre-wrap">{{ code }}</pre></template>`;
  assert.deepEqual(findPreWrapWithoutBreak(optedOut), [], "逃生阀整文件跳过");

  // 正控：往**真实组件**里注入一处，证明扫描器读的是真模板而不是只判假字符串
  const srcDir = join(import.meta.dirname, "..");
  const real = readFileSync(join(srcDir, "components", "GroupMemberPanel.vue"), "utf8");
  const mutated = real.replace(
    '<div class="mb-1.5 flex items-baseline justify-between gap-2">',
    '<div class="whitespace-pre-wrap mb-1.5 flex items-baseline justify-between gap-2">',
  );
  assert.notEqual(mutated, real, "注入锚点漂了：GroupMemberPanel 的那一行改了");
  assert.equal(findPreWrapWithoutBreak(mutated).length, 1, "往真实组件里塞一处裸 pre-wrap 必须被报出");
});

test("src 下所有 .vue 的 whitespace-pre-wrap 都配了断词", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const bad: string[] = [];
  let preWrapSites = 0;
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    preWrapSites += countPreWrapSites(raw);
    for (const issue of findPreWrapWithoutBreak(raw)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  // 非空转下限：这条判据守的是一族站点，数量掉到 8 以下说明提取器或类名改了形状
  assert.ok(
    preWrapSites >= 8,
    `只认出 ${preWrapSites} 处 whitespace-pre-wrap（下限 8）⇒ 量具或写法变了形状，这条判据可能已空转`,
  );
  assert.deepEqual(bad, [], `发现 pre-wrap 却没有断词的文本：\n${bad.join("\n")}`);
});

// 用户 2026-10-23：「我发起的图片渲染失败，不应该有点击图片重新获取的功能」。
// 「重新获取」= 请对端按 cid 再发一份，这是**收件方**才成立的出口；自己发出去的那张图，
// 对端是接收方。这一条钉住两个出口都按 mine 分过叉（不是钉文案，文案改了它不该瞎红）。
test("向对端索取内容的两个出口都必须按 mine 分叉", () => {
  const srcDir = join(import.meta.dirname, "..");
  const bubble = readFileSync(join(srcDir, "components", "message", "MessageImageBubble.vue"), "utf8");
  const item = readFileSync(join(srcDir, "components", "MessageItem.vue"), "utf8");

  // 气泡那一支：emit("refetch") 必须被 mine 闸住，且**只此一处**出口
  const emits = [...bubble.matchAll(/\bemit\("refetch"\)/g)];
  assert.equal(emits.length, 1, "refetch 出口出现第二个家 ⇒ 闸就守不住了");
  assert.match(bubble, /if \(!props\.mine\) emit\("refetch"\)/, "气泡的 refetch 没有按 mine 分叉");
  // 反向：把闸摘掉，判据必须变红（证明它不是恒真）
  const unguarded = bubble.replace(/if \(!props\.mine\) emit\("refetch"\);/, 'emit("refetch");');
  assert.notEqual(unguarded, bubble, "变异锚点漂了");
  assert.ok(!/if \(!props\.mine\) emit\("refetch"\)/.test(unguarded), "摘掉闸后这条断言必须不再成立");

  // 「已被清理」那一格：文案与点击都分叉
  assert.match(item, /@click="mine \? undefined : refetchContent\(\)"/, "清理占位的点击没有按 mine 分叉");
  assert.match(item, /mine \? t\("msg\.imageCleanedMineHint"\) : t\("msg\.imageReRequest"\)/,
    "清理占位的第二行没有按 mine 分叉 ⇒ 自己发的图会写着「可向对方重新索取」");

  // 接线：气泡拿到没拿到 `mine` 是另一件事（组件里分叉对了、父组件不传就全是 false）。
  // 按**出现次数**钉：每一个 `<MessageImageBubble` 都必须带 `:mine="mine"`，
  // 少一个就等于那条消息永远按"对方"渲染（重新获取又冒出来）。
  const bubbles = [...item.matchAll(/<MessageImageBubble\b/g)].length;
  const mineBound = [...item.matchAll(/<MessageImageBubble\b[^>]*?:mine="mine"/g)].length;
  assert.ok(bubbles >= 2, `只找到 ${bubbles} 处 <MessageImageBubble ⇒ 锚点漂了`);
  assert.equal(mineBound, bubbles, `${bubbles} 处图片气泡里只有 ${mineBound} 处传了 :mine`);
});

// 用户 2026-10-23：「聊天界面点我自己的头像也可以进入自己的资料页面」。
// 原来那一支是 `senderId === 自己 ⇒ return`（点了没反应）。这条钉住"自己那条分支必须走路由"，
// 而不是只钉"函数里出现过 profile 这个词"。
test("点自己的头像会进入资料页（不是 return 掉）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "ChatWindow.vue"),
    "utf8",
  );
  const fn = /function openSenderProfile\(senderId: string\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, "openSenderProfile 不见了（改名就重钉这条）");
  const body = fn[1];
  assert.ok(!/senderId === app\.device\?\.device_id\) return;/.test(body),
    "自己那一支又被 return 掉了 ⇒ 点自己头像没反应");
  assert.match(body, /senderId === app\.device\?\.device_id[\s\S]{0,240}?router\.push\(\{ name: app\.isMobile \? "profile" : "settings" \}\)/,
    "自己那一支没有跳到资料页（移动端 profile / 桌面 settings）");
});
// 原生 <select> 已迁到 Reka。正控用**真实组件**注入，证明扫描器确实读的是模板：
// 只判一句假字符串的话，模板抽取写错了也照样绿。
test("原生 <select> 不得回到模板；真实组件注入必须报（正控）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const real = readFileSync(join(srcDir, "components", "settings", "AppearanceSection.vue"), "utf8");
  const mutated = real.replace("<template>", '<template>\n  <select v-model="x" />');
  assert.equal(findNativeSelect(mutated).length, 1, "往真实组件模板里塞一个原生 select 必须被报出");

  const commentOnly = `<script setup>
/** 为什么不用原生 \`<select>\`：弹出层不受主题控制 */
</script>
<template>
  <SettingsSelect />
</template>`;
  assert.deepEqual(findNativeSelect(commentOnly), [], "script 里的说明文字不算标签");

  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findNativeSelect(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `模板里还有原生 select：\n${bad.join("\n")}`);
});

// v-html 是唯一的 HTML 注入面：只允许三处"构造即转义"的渲染器。
// 正控用真实组件注入，证明扫描器读的是模板；实现侧的转义锚点也必须还在。
test("v-html 只出现在构造即转义的三处；新增位置必须登记（正控）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const hits: { file: string; line: number; expr: string }[] = [];
  for (const f of files) {
    const rel = f.replace(srcDir + "/", "");
    for (const s of findVHtmlSinks(readFileSync(f, "utf8"))) hits.push({ file: rel, ...s });
  }
  const filesWith = [...new Set(hits.map((h) => h.file))].sort();
  assert.deepEqual(
    filesWith,
    [...V_HTML_ALLOWED].sort(),
    `v-html 出现位置变了（新增必须证明输入已转义并登记）：\n${JSON.stringify(hits, null, 2)}`,
  );
  for (const h of hits) {
    if (h.file.endsWith("ChatSearchDialog.vue")) {
      assert.match(h.expr, /^highlightText\(/, `搜索结果必须经 highlightText：${h.expr}`);
    } else if (h.file.endsWith("LogRows.vue")) {
      assert.match(h.expr, /^v\.row\./, `日志行必须是 highlightText 生成的 row.*：${h.expr}`);
    } else if (h.file.endsWith("MarkdownText.vue")) {
      assert.equal(h.expr, "html", "更新说明只允许渲染 renderNotesMarkdown（marked + DOMPurify）的产物");
    } else if (h.file.endsWith("CodeBlock.vue")) {
      assert.equal(h.expr, "html", "代码块只允许渲染 hljs/escapeHtml 生成的 html");
    }
  }
  // 转义锚点少一个，上面那份清单就只是"文件名对上了"，这里把实现也钉住。
  assert.match(readFileSync(join(srcDir, "utils", "highlight.ts"), "utf8"), /escHtml\(part\)/);
  const codeBlock = readFileSync(join(srcDir, "components", "CodeBlock.vue"), "utf8");
  assert.match(
    codeBlock,
    /import \{ escHtml \} from "@\/utils\/highlight"/,
    "CodeBlock 的纯文本回退必须用公共 escHtml（不许再私有一份只转 &<> 的副本）",
  );
  assert.match(codeBlock, /escHtml\(props\.code\)/);
  assert.match(readFileSync(join(srcDir, "components", "LogViewer.vue"), "utf8"), /highlightText\(l\.message/);

  // 正控：往真实组件模板里注入一个未登记的 v-html，必须被读出来
  const injected = readFileSync(join(srcDir, "components", "TitleBar.vue"), "utf8")
    .replace("</template>", '<div v-html="content"></div></template>');
  assert.deepEqual(findVHtmlSinks(injected).map((s) => s.expr), ["content"]);
});

test("文本气泡排版与虚拟列表高度度量一致（leading-* ↔ TEXT_LINE_RATIO / py-* ↔ TEXT_BUBBLE_PADDING）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const bubble = readFileSync(join(srcDir, "components", "message", "MessageTextBubble.vue"), "utf8");
  const metrics = readFileSync(join(srcDir, "utils", "previewMetrics.ts"), "utf8");
  const issues = checkBubbleMetricsCoupling(bubble, metrics);
  assert.deepEqual(issues, [], issues.map((i) => `L${i.line} ${i.message}`).join("\n"));
});

test("触屏命中扩展类直接声明 position → 报出（会盖掉组件的 absolute）", () => {
  // 复现真实缺陷：安卓端「回到最新」按钮是 `tap-safe absolute bottom-4 right-5`，
  // 而 .tap-safe{position:relative} 与 .absolute 特异性相同、本文件更靠后 ⇒ 定位被覆盖。
  const buggy = `
@tailwind utilities;
@media (pointer: coarse) {
  .tap-safe { position: relative; }
  .tap-safe::after { content: ""; position: absolute; inset: -8px 0; }
}
`;
  const issues = checkStyleCascade(buggy);
  assert.ok(
    issues.some((i) => i.message.includes("pointer: coarse")),
    `应当报出触屏块里的 position 覆盖，实际：${JSON.stringify(issues)}`,
  );
});

test("用 :where() 压到 0 特异性 → 通过", () => {
  const fixed = `
@tailwind utilities;
@media (pointer: coarse) {
  :where(.tap-safe) { position: relative; }
  :where(.tap-safe)::after { content: ""; position: absolute; inset: -8px 0; }
}
`;
  const issues = checkStyleCascade(fixed).filter((i) => i.message.includes("pointer: coarse"));
  assert.deepEqual(issues, [], issues.map((i) => i.message).join("\n"));
});

test("真实的 src/style.css 级联顺序正确", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  const issues = checkStyleCascade(css);
  assert.deepEqual(issues, [], issues.map((i) => `L${i.line} ${i.message}`).join("\n"));
});

test("未读徽标只有 UnreadBadge.vue 一处实现，且保留了垂直居中补偿", () => {
  const srcDir = join(import.meta.dirname, "..");
  const badgePath = join(srcDir, "components", "UnreadBadge.vue");
  const files = collectVueFiles(srcDir);

  const bad: string[] = [];
  for (const f of files) {
    if (f === badgePath) continue;
    for (const issue of findHandWrittenBadges(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现有手写的未读徽标：\n${bad.join("\n")}`);

  const issues = checkUnreadBadgeComponent(readFileSync(badgePath, "utf8"));
  assert.deepEqual(issues, [], issues.map((i) => i.message).join("\n"));
});

// ---------------- ⑧ 聊天区「文本选择」契约 ----------------

test("复现历史缺陷：气泡根不可选 / 表情可拖 → 报出", () => {
  const buggy = {
    textBubble: `
      <div class="group relative px-3 py-1.5">
        <div class="whitespace-pre-wrap">{{ body }}</div>
        <img :src="emoji" class="emoji-img" />
      </div>`,
    avatar: `<img :src="avatar" class="h-full w-full object-cover" />`,
    messageItem: `<div @touchmove="cancelLongPress"></div>`,
    app: `window.addEventListener("contextmenu", (e) => e.preventDefault());`,
    // 旧写法：把截断后的字符串当 DOM 文本渲染 ⇒ 选中复制拿到残缺 URL（用户 2026-09-16 报的缺陷）
    linkText: `<a :href="href">{{ displayUrl(label) }}</a>`,
    css: `
.gosslan-avatar-box { container-type: inline-size; }
.emoji-img { display: inline-block; }
.gosslan-selectable { user-select: text; }
.gosslan-url-mid { display: none; }
.gosslan-url-dots { }`,
  };
  const issues = checkSelectionContract(buggy);
  const msgs = issues.map((i) => i.message).join("\n");
  assert.ok(msgs.includes("gosslan-selectable"), msgs);
  assert.ok(msgs.includes("select-text"), msgs);
  assert.ok(msgs.includes("emoji-img"), msgs);
  assert.ok(msgs.includes("user-select: none"), msgs);
  assert.ok(msgs.includes("onTouchMove"), msgs);
  assert.ok(msgs.includes("contextmenu"), msgs);
  assert.ok(msgs.includes("font-size: 0"), msgs);
  assert.ok(msgs.includes("background-image"), msgs);
  assert.ok(msgs.includes("MessageLinkText"), msgs);
  assert.ok(msgs.includes("quote-block"), msgs);
});

test("引用块可选性：漏掉任一半边 → 报出", () => {
  const base = {
    textBubble: `<div class="gosslan-bubble-text select-text"><div class="gosslan-selectable">
      <img class="emoji-img" draggable="false" /></div></div>`,
    avatar: `<img class="h-full w-full object-cover" draggable="false" />`,
    messageItem: `<div @touchmove="onTouchMove"></div>`,
    app: `const sel = window.getSelection();`,
    linkText: `<a><span>{{ parts.head }}</span><span class="gosslan-url-mid">{{ parts.mid }}</span><span class="gosslan-url-dots"></span><span>{{ parts.tail }}</span></a>`,
  };
  const common = `
.gosslan-avatar-box { user-select: none; }
.emoji-img { -webkit-user-drag: none; }
.gosslan-selectable { -webkit-touch-callout: default; }
.gosslan-url-mid { font-size: 0; }
.gosslan-url-dots { background-image: radial-gradient(circle, red, blue); }`;

  // 半边 A：只有 .quote-block 可选中，触屏那条缺失 ⇒ 引用块在手机上永远可拖选
  const noTouchGuard = checkSelectionContract({
    ...base,
    css: `${common}\n.quote-block { user-select: text; }`,
  });
  assert.match(noTouchGuard.map((i) => i.message).join("\n"), /弹不出消息菜单/);

  // 半边 B：只有触屏禁用，没把 <button> 的 none 覆盖回来 ⇒ 全选复制丢引用头
  const noSelectable = checkSelectionContract({
    ...base,
    css: `${common}\n.gosslan-bubble-text:not(.gosslan-selecting) .quote-block { user-select: none; }`,
  });
  assert.match(noSelectable.map((i) => i.message).join("\n"), /缺少 `user-select: text`/);
});

test("链接省略号的 DOM 顺序被打乱 / 夹了空白 → 报出", () => {
  const base = {
    textBubble: `<div class="gosslan-bubble-text select-text"><div class="gosslan-selectable">
      <img class="emoji-img" draggable="false" /></div></div>`,
    avatar: `<img class="h-full w-full object-cover" draggable="false" />`,
    messageItem: `<div @touchmove="onTouchMove"></div>`,
    app: `const sel = window.getSelection();`,
    css: `
.gosslan-avatar-box { user-select: none; }
.emoji-img { -webkit-user-drag: none; }
.gosslan-selectable { -webkit-touch-callout: default; }
.gosslan-url-mid { font-size: 0; }
.gosslan-url-dots { background-image: radial-gradient(circle, currentColor 1px, transparent 1px); }
.quote-block { user-select: text; }
.gosslan-bubble-text:not(.gosslan-selecting) .quote-block { user-select: none; }`,
  };
  // mid 跑到 tail 后面：拼回去就成了 head+tail+mid，URL 顺序错乱
  const swapped = checkSelectionContract({
    ...base,
    linkText: `<a><span>{{ parts.head }}</span><span>{{ parts.tail }}</span><span class="gosslan-url-dots"></span><span class="gosslan-url-mid">{{ parts.mid }}</span></a>`,
  });
  assert.match(swapped.map((i) => i.message).join("\n"), /DOM 顺序被打乱/);

  // span 之间夹了换行：空白文本节点会进选区，复制出的 URL 中间多空格
  const spaced = checkSelectionContract({
    ...base,
    linkText: `<a>
      <span>{{ parts.head }}</span>
      <span class="gosslan-url-mid">{{ parts.mid }}</span>
      <span class="gosslan-url-dots"></span>
      <span>{{ parts.tail }}</span>
    </a>`,
  });
  assert.match(spaced.map((i) => i.message).join("\n"), /夹了空白/);

  // 省略号里写了文本
  const dotted = checkSelectionContract({
    ...base,
    linkText: `<a><span>{{ parts.head }}</span><span class="gosslan-url-mid">{{ parts.mid }}</span><span class="gosslan-url-dots">…</span><span>{{ parts.tail }}</span></a>`,
  });
  assert.match(dotted.map((i) => i.message).join("\n"), /省略号 span 里带了文本/);
});

/** 真实源码那五份 + 一份可替换的 css（两条判据都要在**真实文件**上做减法，合成夹具证明不了真树）。 */
function realSelectionSources(css: string) {
  const srcDir = join(import.meta.dirname, "..");
  return {
    textBubble: readFileSync(join(srcDir, "components", "message", "MessageTextBubble.vue"), "utf8"),
    avatar: readFileSync(join(srcDir, "components", "message", "MessageAvatar.vue"), "utf8"),
    messageItem: readFileSync(join(srcDir, "components", "MessageItem.vue"), "utf8"),
    app: readFileSync(join(srcDir, "..", "src", "App.vue"), "utf8"),
    linkText: readFileSync(join(srcDir, "components", "message", "MessageLinkText.vue"), "utf8"),
    css,
  };
}

test("修好之后通过（真实的 6 个源码文件）", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  const issues = checkSelectionContract(realSelectionSources(css));
  assert.deepEqual(issues, [], issues.map((i) => `L${i.line} ${i.message}`).join("\n"));
});

test("文本选择默认方向：在真实 style.css 上做减法 → 两半各自点名", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  // 摘掉"根元素默认不可选"那一条（连注释一起摘，避免留下 `html {` 的字面量）
  const noDefault = css.replace(/html\s*\{[^}]*user-select:\s*none[^}]*\}/, "");
  assert.notEqual(noDefault, css, "锚点没命中：根上那条 `html { user-select: none }` 变了形状");
  assert.match(
    checkSelectionContract(realSelectionSources(noDefault)).map((i) => i.message).join("\n"),
    /根元素（html \/ :root）缺少 `user-select: none`/,
  );
  // 摘掉"可编辑控件开回来"那一条
  const noEditable = css.replace(
    /input\s*,\s*textarea\s*,\s*select\s*,\s*\[contenteditable\][^{]*\{[^}]*user-select:\s*text[^}]*\}/,
    "",
  );
  assert.notEqual(noEditable, css, "锚点没命中：`input/textarea/select/[contenteditable]` 那条开回规则变了形状");
  assert.match(
    checkSelectionContract(realSelectionSources(noEditable)).map((i) => i.message).join("\n"),
    /没有单独开回 `user-select: text`/,
  );
});

/**
 * `@media <条件> { … }` 的**全部**段落正文（同一条件在样式表里可能有多段，只取第一段＝漏检）。
 *
 * ⚠️ 先剥注释：style.css 里那些说明文字**反复点到**这些类名，不剥就会读到判据自己那段注释
 *   里的字面量（本仓在"提取器会读注释"上翻过车），也会读到隔壁那条规则的说明。
 */
function mediaBlocksOf(css: string, cond: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = stripped.indexOf(`@media ${cond}`, from);
    if (at < 0) return out;
    const open = stripped.indexOf("{", at);
    if (open < 0) return out;
    let depth = 0;
    let i = open;
    for (; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(stripped.slice(open + 1, i));
    from = i + 1;
  }
}

test("卡片文字的选字只开桌面档：fine 开、coarse 一处不开、两个组件挂对、click 认得划选", () => {
  const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
  const FINE_RULE = /\.gosslan-card-text\s*\{[^}]*user-select:\s*text/;
  const fine = mediaBlocksOf(css, "(pointer: fine)");
  assert.ok(fine.length >= 1, "锚点没命中：style.css 里没有 `@media (pointer: fine)` 那一段（形状变了？）");
  assert.ok(fine.some((b) => FINE_RULE.test(b)),
    "`.gosslan-card-text` 没在 fine 那一段里开回 user-select:text ⇒ 桌面划不中卡片文字");
  // 穷举：coarse 的段落**每一段**都不许出现它 —— 那个类走的是 `.gosslan-selectable`，
  // 而它是触屏长按让路给原生选字的落点标记（shouldStartLongPress 的 hitSelectable），
  // 一旦在 coarse 里开着，长按任务卡/文件卡就弹不出操作面板。
  for (const block of mediaBlocksOf(css, "(pointer: coarse)")) {
    assert.doesNotMatch(block, /gosslan-card-text/,
      "触屏那档不许开 `.gosslan-card-text` —— 开了等于把长按面板的落点让给系统选区");
  }
  // 减法：把 fine 挪成 coarse ⇒ 两半各自必须翻脸（证明两格都承重，不是各写一句漂亮话）。
  const moved = css.replace("@media (pointer: fine)", "@media (pointer: coarse)");
  assert.notEqual(moved, css, "锚点没命中：那条 fine 规则改了形状");
  assert.ok(mediaBlocksOf(moved, "(pointer: coarse)").some((b) => /gosslan-card-text/.test(b)),
    "减法没生效：改成 coarse 之后应当被上面那条 doesNotMatch 抓到");
  assert.ok(!mediaBlocksOf(moved, "(pointer: fine)").some((b) => FINE_RULE.test(b)),
    "减法没生效：fine 那一段挪走之后不该再算开启");

  const card = readFileSync(join(import.meta.dirname, "..", "components", "TodoCardBubble.vue"), "utf8");
  const file = readFileSync(
    join(import.meta.dirname, "..", "components", "message", "MessageFileBubble.vue"), "utf8",
  );
  for (const [name, src] of [["TodoCardBubble.vue", card], ["MessageFileBubble.vue", file]] as const) {
    assert.ok(/class="gosslan-card-text/.test(src), `${name}：卡片文字没挂 .gosslan-card-text`);
    assert.ok(!src.includes("gosslan-selectable"),
      `${name}：不该改用 .gosslan-selectable —— 那个类在触屏下把长按让给原生选字，操作面板就没了`);
  }
  // 划选结束那一下浏览器照样发 click，而两张卡的**根部整块可点**（打开面板 / 打开文件）⇒
  // 必须认"这次是划选不是打开"。判据用 selectionTextWithin（选区与该元素相交才算），
  // 不是 hasTextSelection()：后者会把"别处还留着选区、这次真想点开"一起吞掉。
  assert.ok(/@click="openPanel"/.test(card)
    && /function openPanel\(e: MouseEvent\) \{[\s\S]{0,600}?selectionTextWithin\(card\)/.test(card),
    "TodoCardBubble：openPanel 没认划选 ⇒ 划一下描述就把群任务面板弹了出来");
  assert.ok(/@click="onCardClick"/.test(file)
    && /function onCardClick\(e: MouseEvent\) \{[\s\S]{0,400}?selectionTextWithin\(card\)/.test(file),
    "MessageFileBubble：根部没走 onCardClick（或它没认划选）⇒ 划一下文件名就把文件打开了");
  console.log("· 卡片文字选字：fine 段 1 条开启 + coarse 段全部不含 + 两组件挂对 + 两处 click 认划选");
});

// ---------------- ⑨ 文本输入类的焦点提示：不许画外圈方框 ----------------
//
// 真实反馈（用户 2026-09-16）：「整个应用的输入框在焦点态会默认有个主题色的方框，很难看」。
// 根因见 `checkTextFieldFocusRing` —— 浏览器对 input/textarea/select/[contenteditable]
// 把 `:focus-visible` 判成**恒成立**，所以全局那条 2px 外圈方框会在**每次点击输入框**时出现。
// 这条护栏盯的是"改回去"：全局环里再加回输入类、或删掉替代的边线提示。

const BUGGY_FOCUS_CSS = `
:where(button, a, input, textarea, select, [tabindex], [contenteditable]):focus-visible {
  outline: 2px solid var(--gosslan-focus-ring);
  outline-offset: 1px;
}
`;

const FIXED_FOCUS_CSS = `
:where(button, a, [tabindex]):focus-visible {
  outline: 2px solid var(--gosslan-focus-ring);
  outline-offset: 1px;
}
input:focus,
textarea:focus,
select:focus {
  border-color: var(--gosslan-primary);
  box-shadow: inset 0 0 0 1px var(--gosslan-focus-ring);
}
.gosslan-composer:focus-within {
  border-color: var(--gosslan-primary);
}
`;

test("复现真实反馈：全局焦点环含文本输入类 → 报出（并指到那一行）", () => {
  // 这个夹具只有"改坏"的那一条规则（故意不带替代提示），所以只断言**方框**这条判据。
  const issues = checkTextFieldFocusRing(BUGGY_FOCUS_CSS, "gosslan-composer");
  const rings = issues.filter((i) => /选择器里不该有文本输入类/.test(i.message));
  assert.equal(rings.length, 1, "全局环含文本输入类必须报一次");
  assert.match(rings[0].message, /点一下/, "要说清「点一下就出现」这个关键点");
  assert.equal(rings[0].line, 2, "应指到那条 :focus-visible 规则所在行");
});

test("修好之后不再报（边线级提示 + 卡片钩子都在）", () => {
  assert.deepEqual(checkTextFieldFocusRing(FIXED_FOCUS_CSS, "gosslan-composer"), []);
});

test("删掉替代提示就报（去掉外圈方框≠可以没有焦点提示）", () => {
  const noFieldRule = FIXED_FOCUS_CSS.replace(/input:focus,[\s\S]*?\}\n/, "");
  const issues = checkTextFieldFocusRing(noFieldRule, "gosslan-composer");
  assert.ok(
    issues.some((i) => /找不到文本输入类的焦点提示规则/.test(i.message)),
    "少了边线级提示必须报（WCAG 2.4.7）",
  );
});

test("消息输入框卡片钩子被摘掉也报（编辑区自己不能画框）", () => {
  const issues = checkTextFieldFocusRing(FIXED_FOCUS_CSS, "relative rounded-md border");
  assert.ok(
    issues.some((i) => /gosslan-composer/.test(i.message)),
    "卡片少了钩子 ⇒ 消息输入框完全没有焦点提示，必须报",
  );
});

test("真实的 style.css + MessageComposer.vue 通过", () => {
  const srcDir = join(import.meta.dirname, "..");
  const issues = checkTextFieldFocusRing(
    readFileSync(join(srcDir, "style.css"), "utf8"),
    readFileSync(join(srcDir, "components", "chat", "MessageComposer.vue"), "utf8"),
  );
  assert.deepEqual(issues, [], issues.map((i) => `L${i.line} ${i.message}`).join("\n"));
});

// ---------------- ⑫ 浮层 z 序阶梯：弹窗必须盖住整页下钻页，但不能盖住菜单/预览/toast ----------------
//
// 真实缺陷（用户 2026-09-21，**只在移动端**）：`BaseModal` 原先写 `z-50`，而 HeadlessUI 的
// `Dialog` 会把自己挂到 `<body>` 下的 `#headlessui-portal-root`（即 z 是在**文档根层级**上比的，
// 不是留在调用者子树里比的）。移动端的整页下钻页是 `MobilePageFrame` 的 `fixed inset-0 z-[60]`
// ⇒ z-50 的弹窗被整页盖在后面：**DOM 里有、屏幕上看不见**，用户看到的就是「点了没反应」。
// 这类退化没有任何运行时报错、桌面上也完全正常，只能静态钉住阶梯。
test("浮层 z 序阶梯：整页框架 < 弹窗 < 右键菜单 < 图片预览、Toast", () => {
  const srcDir = join(import.meta.dirname, "..");
  /** 取该文件里**第一个** `z-[NN]`。注释里为解释阶梯写着一串 z-[NN]，必须先剥掉两种注释。 */
  const zOf = (rel: string) => {
    const src = readFileSync(join(srcDir, rel), "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const m = /z-\[(\d+)\]/.exec(src);
    assert.ok(m, `${rel} 里找不到 z-[NN]（浮层必须显式声明层级）`);
    const n = Number(m[1]);
    assert.ok(n > 0 && n < 100, `${rel} 的 z 值 ${n} 不像层级值`);
    return n;
  };
  const frame = zOf("components/MobilePageFrame.vue");
  const modal = zOf("components/BaseModal.vue");
  const menu = zOf("components/ContextMenu.vue");
  const preview = zOf("components/message/ImageLightbox.vue");
  const toast = zOf("components/ToastHud.vue");

  assert.ok(
    frame < modal,
    `弹窗(z-${modal}) 必须高于整页框架(z-${frame})：否则移动端「设置/日志/收藏…」里打开的弹窗会被整页盖住（用户看到"点了没反应"）`,
  );
  assert.ok(modal < menu, `右键菜单(z-${menu}) 应高于弹窗(z-${modal})，否则菜单会被弹窗盖住`);
  assert.ok(
    modal < preview,
    `图片预览(z-${preview}) 应高于弹窗(z-${modal})：合并转发卡等弹窗里点图要看大图`,
  );
  assert.ok(
    modal < toast,
    `Toast(z-${toast}) 必须高于弹窗(z-${modal})：弹窗里的失败提示要看得见`,
  );
});

// ---------------- ⑬ 一级导航图标：统一图标库 + 唯一选中态出口 ----------------
//
// 用户 2026-10-22：「侧边栏那几个图标的选中状态我总觉得不满意，是不是自己画的？
// 全部替换成统一图标库里标准风格一致的。」
// ⇒ 自绘 path 退役；四枚图标统一来自 `lucide-vue-next`，选中态由 **一个家** 的
// `.nav-glyph-btn[data-active]` / `.nav-glyph-pill[data-active]` 表达（药丸底 + 主题色 + 弹簧）。
// 这条判据同时挡两种退化：① 某一枚又手绘回去；② 某个导航项忘了把 `active` 传下去。
test("一级导航图标：全部走 lucide 唯一出口，选中态由 data-active 驱动", () => {
  const srcDir = join(import.meta.dirname, "..");
  const nav = readFileSync(join(srcDir, "components", "NavRail.vue"), "utf8");
  const selectable = ["chats", "contacts", "favorites", "links"];
  for (const key of selectable) {
    assert.ok(
      nav.includes(`<NavIcon name="${key}" :active="navState === '${key}'" />`),
      `NavRail 的「${key}」没有把选中态传给 NavIcon：要写成 <NavIcon name="${key}" :active="navState === '${key}'" />`
    );
    assert.match(
      nav,
      new RegExp(`:data-active="navState === '${key}'"`),
      `NavRail 的「${key}」缺少 data-active：选中态的底色与缩放不会生效`,
    );
  }
  const navIcon = readFileSync(join(srcDir, "components", "ui", "NavIcon.vue"), "utf8");
  const navIcons = readFileSync(join(srcDir, "components", "ui", "navIcons.ts"), "utf8");
  assert.match(navIcons, /from "lucide-vue-next"/, "导航图标必须来自统一图标库");
  for (const key of selectable) {
    assert.match(navIcons, new RegExp(`\\b${key}:\\s*\\w+`), `图标表里少了「${key}」这一格`);
  }
  assert.match(navIcon, /from "@\/components\/ui\/navIcons"/, "NavIcon 必须消费唯一造型表");
  assert.match(
    navIcon,
    /:data-active="props\.active \? 'true' : 'false'"/,
    "NavIcon 没把 active 落成 data-active：外层选中态样式接了个空开关",
  );
  assert.ok(!/d="M/.test(navIcon), "NavIcon 不该再自绘 path：造型统一交给图标库");
  const css = readFileSync(join(srcDir, "style.css"), "utf8");
  assert.match(css, /\.nav-glyph-btn\[data-active="true"\]/, "rail 选中态样式缺失");
  assert.match(css, /\.nav-glyph-pill\[data-active="true"\]/, "底栏选中态样式缺失");
  // 两端同一个家：移动端那一侧也必须渲染同一批 name，且两边都不许再自己画导航图形
  const layout = readFileSync(join(srcDir, "layouts", "ResponsiveLayout.vue"), "utf8");
  for (const key of selectable) {
    assert.ok(layout.includes(`<NavIcon name="${key}"`), `移动端这一侧的「${key}」没走同一个图标出口`);
  }
  assert.ok(!/<svg\b/.test(nav), "NavRail 不该再有内联 <svg>");
  assert.ok(!/<svg\b/.test(layout), "ResponsiveLayout 不该再有内联 <svg>");
  assert.ok(!/d="M/.test(nav) && !/d="M/.test(layout), "path 数据又出现抄本（同一造型会有两份）");
  // 反向：这四项之外不应再有别的 `navState === '<key>'` 图标高亮（否则清单就过期了）
  const keys = [...nav.matchAll(/navState === '([a-zA-Z]+)'/g)].map((m) => m[1]);
  const unknown = [...new Set(keys)].filter((k) => !selectable.includes(k));
  assert.deepEqual(
    unknown,
    [],
    `NavRail 里出现了清单外的可选中 key：${unknown.join(", ")} —— 请同步上面的 selectable 清单`,
  );
});

// ---------------- ⑭ 预览 objectURL 归缓存所有：消费者不得 revoke ----------------
//
// 真实缺陷（用户 2026-09-21）：「任务详情里的图片大概率加载失败」。
// 根因不在"读不到字节"，而在**生命周期**：`loadContentPreview` 把 objectURL 缓存在模块级
// Map 里，同一个 cid 的 URL 是**大家共用的同一个字符串**（一张待办描述图会同时存在于
// 聊天时间线的任务卡、看板表单、任务详情）。`TodoImageThumb` 当时在卸载/换图时
// `revokeObjectURL`，于是"关掉一次详情弹窗""虚拟列表回收一行"都会把所有其它视图的图
// 一起打回裂图；而缓存里那个 URL 已经死了却仍被命中 ⇒ 退避重试也救不回来（只能重启）。
// 判据：拿预览缓存 URL 的消费组件**一律不许出现 revokeObjectURL**（自己造 URL 的组件
// 如 MergeCardModal / ProfileSection 不在此列，它们的 URL 没进任何共享缓存）。
test("预览缓存 URL 的消费者不得 revokeObjectURL（会把同一张图的其它视图一起打裂）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const consumers = [
    ["components", "TodoImageThumb.vue"],
    ["components", "message", "MessageImageBubble.vue"],
    ["components", "message", "ImageLightbox.vue"],
    ["components", "FavoritePanel.vue"],
  ];
  for (const rel of consumers) {
    const file = join(srcDir, ...rel);
    const src = readFileSync(file, "utf8");
    // 只认**调用**（`URL.revokeObjectURL(...)`）：注释里提到这个名字是允许的（本文件的说明就是要留痕）
    assert.ok(
      !/URL\.revokeObjectURL\s*\(/.test(src),
      `${rel.join("/")} 里出现了 revokeObjectURL：预览 URL 归 filePreview/favoritePreview 的缓存所有，` +
        `消费者 revoke 会连带杀掉同一 cid/msg_id 在别处的图，且缓存会一直返回那个死 URL`,
    );
  }
});

// ---------------- ⑮ 滚动落定的轮询定时器必须在卸载时清掉 ----------------
//
// 真实缺陷（PR #24 审查发现）：`scrollToIndex` 会开一个 1.5s 落定窗口，里面用 `setInterval`
// 每 100ms 校正一次（`pollJump`）。窗口的**自动收口只发生在 `applyJump` 内部**，而它开头就是
// `if (!j || !el) return;` —— `el` 是容器 ref，组件卸载后 Vue 会把它置 null，于是
// "过窗就 clearInterval"那一支永远走不到 ⇒ 定时器以 10Hz 常驻在一个已经死掉的组件上。
// 只要"关掉带列表的辅助窗口 / 切会话"正好落在落定窗口里就漏一条，且不会自愈。
// 判据：`onBeforeUnmount` 里必须**显式**清 `jumpTimer`（将来把落定逻辑改成别的形态时，
// 只要还留着一个跨窗口的定时器，这条就得跟着改，不能默默失效）。
test("VirtualList：落定轮询定时器必须在 onBeforeUnmount 里清理", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "VirtualList.vue"), "utf8");
  const start = src.indexOf("onBeforeUnmount(() => {");
  assert.notEqual(start, -1, "VirtualList 的卸载钩子不见了 ⇒ 这条判据失去锚点");
  const end = src.indexOf("\n});", start);
  assert.notEqual(end, -1, "VirtualList 的卸载钩子没有正常闭合");
  const cleanup = src.slice(start, end);
  assert.ok(
    cleanup.includes("clearInterval(jumpTimer)"),
    "onBeforeUnmount 没清 jumpTimer：组件在落定窗口内卸载后，100ms 轮询不会停" +
      "（applyJump 在 `!el` 处就返回了，走不到过窗自清那一支）",
  );
});

/**
 * 图片预览必须**只有一个渲染点**（用户 2026-09-24 #40：看图是一个公共能力）。
 *
 * 原先 `ImageLightbox` 被四处各挂一份（会话 / 任务看板 / 任务详情 / 合并转发卡片），
 * 每份自己持有 `images/index/open`。后果不是重复代码那么简单：
 * - 同一件"看图"在不同入口的能力取决于那个面板有没有把数组传全（会话里能整屏左右循环、
 *   任务里只有那一条的几张图，这本该是同一个契约）；
 * - 加一个入口就得再抄一遍，而"合并卡片的图是 objectURL、组件一关就被回收"这份知识
 *   锁在那个组件里 —— 预览搬到全局后正是靠**来源标记**才没把这条保证弄丢。
 *
 * 所以钉两件事：渲染点只有一个（在壳层），别的组件只能经 store 调用。
 */
test("图片预览只有一处渲染点，其余组件一律走 useImagePreviewStore", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(join(srcDir, "components")).concat(
    collectVueFiles(join(srcDir, "layouts")),
  );
  const renderers: string[] = [];
  const stateful: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = f.replace(srcDir + "/", "");
    // 只数**模板段里、去掉 HTML 注释之后**的元素。
    // 为什么不是"看行首是不是 `<!--`"：注释常常是多行的，提到 `<ImageLightbox>`
    // 的那一行本身不带 `<!--`（第一版就是这么写的，结果三处注释全被当成渲染点）。
    // 模板里的注释不可能嵌套 ⇒ `<!--[\s\S]*?-->` 这个非贪婪匹配就是精确的。
    const tplAt = src.indexOf("<template>");
    if (tplAt > 0) {
      const tpl = src.slice(tplAt).replace(/<!--[\s\S]*?-->/g, "");
      for (const _m of tpl.matchAll(/<ImageLightbox[\s/>]/g)) {
        // 只报文件不报行号：注释被剥掉之后偏移就变了，报出来的行号会是**错的**，
        // 宁可少给一个信息也不要给假的（要定位在文件里搜 `<ImageLightbox` 即可）。
        renderers.push(rel);
      }
    }
    // 别人不许再自己攒一套 open/index 状态（那等于又长出第二个预览实例）
    if (
      rel !== "layouts/ResponsiveLayout.vue" &&
      /const\s+\w*lightbox\w*\s*=\s*ref\(/i.test(src)
    ) {
      stateful.push(rel);
    }
  }
  // 允许**两个文档各一个实例**：主窗口的覆盖层（移动端 + 不可跨文档时的退回路径）
  // 与桌面端那个全局唯一的预览窗口。"全局只有一个预览"说的是**同一时刻用户看到的界面**，
  // 而这两处不会同时亮：store 的 `inWindow` 为真时壳层那份就让位（ResponsiveLayout 的 :open）。
  assert.deepEqual(
    [...new Set(renderers)].sort(),
    ["components/window/PreviewWindow.vue", "layouts/ResponsiveLayout.vue"],
    `图片预览的渲染点不对：${renderers.join(", ")} —— 只许壳层覆盖层 + 预览窗口这两处`,
  );
  assert.deepEqual(stateful, [], `这些组件还自己持有预览开关状态：${stateful.join(", ")}`);
  // store 侧：唯一那份实例绑在 store 上，不是本地 ref
  const shell = readFileSync(join(srcDir, "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(shell, /const preview = useImagePreviewStore\(\)/, "壳层要挂 store");
  assert.match(shell, /:images="preview\.images"/, "渲染点的数据来自 store");
  // 左右切换写的也是 store 的 index（写成组件本地 ref 就等于把"当前看第几张"又搬回局部）
  assert.match(shell, /v-model:index="preview\.index"/, "切换下标也写回 store");
});

/**
 * 布局级断点必须叠加 `desktop:`（#27）。
 *
 * 安卓启动时系统权限弹框盖住 WebView 首次布局，那一刻视口宽度会读到兜底档（980px），
 * 于是 JS 判"移动"而 CSS 判"桌面"：导航栏回来、底部安全区内边距被清零、抽屉按 980 铺满。
 * 所以**决定结构**的那几个断点必须同时要求"本机不是移动布局"，而 `is-mobile` 这个类
 * 只有 `useAppStore.applyIsMobile()` 一个写者（判据 = platform.ts 的 resolveMobileLayout）。
 *
 * 表里每条都是"少了它手机就当桌面用"的那一类；纯文字密度（`sm:inline` 的秒级时间戳等）
 * 刻意不在这里 —— 那些在宽视口下多显示一点无害，钉进去只会让人下次不敢用断点。
 */
test("布局级断点必须叠加 desktop: 变体（移动端视口会说谎）", () => {
  const cases: [string, string][] = [
    ["../components/NavRail.vue", "md:flex"],
    ["../layouts/ResponsiveLayout.vue", "md:block"],
    ["../layouts/ResponsiveLayout.vue", "md:pb-0"],
    ["../layouts/ResponsiveLayout.vue", "md:flex"],
    ["../components/FavoritePanel.vue", "sm:flex-col"],
    ["../components/FavoritePanel.vue", "sm:flex-none"],
    ["../components/search/ChatSearchDialog.vue", "md:flex-row"],
    ["../components/DevDiagPanel.vue", "sm:grid-cols-2"],
  ];
  const bare: string[] = [];
  for (const [rel, util] of cases) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      if (!line.includes(util)) continue;
      // 只查 class 里的那次出现：注释里提一句不算违反
      const cls = /class="[^"]*"/.exec(line);
      if (!cls) continue;
      const idx = cls[0].indexOf(util);
      if (idx < 0) continue;
      const before = cls[0].slice(Math.max(0, idx - 9), idx);
      if (!before.endsWith("desktop:")) bare.push(`${rel}  ${util}`);
    }
  }
  assert.deepEqual(
    bare,
    [],
    `这些结构级断点没叠 desktop:，移动布局下也会被视口宽度点亮：${bare.join(" · ")}`,
  );
});

test("`desktop:` 变体必须在 tailwind 里注册（拼错的后缀会静默不生效）", () => {
  const cfg = readFileSync(new URL("../../tailwind.config.js", import.meta.url), "utf8");
  assert.ok(cfg.includes('addVariant("desktop"'), "tailwind.config.js 里没有 desktop 变体");
  assert.ok(
    cfg.includes("html:not(.is-mobile)"),
    "变体的选择器必须是 html:not(.is-mobile) —— 与 useAppStore 写的那个类同名才对得上",
  );
});

test("字母头像那三个标识符：写回来就必须报（夹具）", () => {
  for (const src of [
    `<script setup>import { avatarInitial } from "@/utils/color";</script>`,
    `<script setup>const c = nameToColor(n);</script>`,
    `<template><span class="gosslan-avatar-initial">KEEN</span></template>`,
  ]) {
    assert.ok(findRetiredLetterAvatarUsage(src).length >= 1, `这条复活没被抓到：${src}`);
  }
  assert.deepEqual(
    findRetiredLetterAvatarUsage(`<template><span class="gosslan-avatar-emoji" aria-hidden="true">{{ seed?.emoji }}</span></template>`),
    [], "emoji 头像那条不该被误报");
});

test("src 下没有任何一处还在走字母头像", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findRetiredLetterAvatarUsage(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `字母头像复活了：\n${bad.join("\n")}`);
});

test("模板里挂上的 BEM 修饰类必须在 CSS 里有定义（夹具）", () => {
  const used = `<template><div class="mention-token" :class="{ 'mention-token--self': isMe }">x</div></template>`;
  // ① 用了却没定义 ⇒ 报（这类缺陷的形态是"界面静默退化"，没有任何测试会红）
  assert.equal(findModifierClassWithoutStyle(used, "").length, 1, "缺定义的修饰类必须报出来");
  // ② 同文件 <style> 里定义了 ⇒ 放行
  const withOwnStyle = used + `<style>.mention-token--self { font-weight: 600; }</style>`;
  assert.deepEqual(findModifierClassWithoutStyle(withOwnStyle, ".x{}"), []);
  // ③ 定义在全局 style.css 里也算
  assert.deepEqual(
    findModifierClassWithoutStyle(used, ".mention-token--self{color:red}"), [],
    "定义在全局样式里也算数");
  // ④ 多行 :class 对象写法同样要判得住（真实代码里就是这种）
  const multiline = `<template><div :class="{
      'a-mod--on': x,
    }">y</div></template>`;
  assert.equal(findModifierClassWithoutStyle(multiline, "").length, 1, "多行对象写法不能漏");
  // ⑤ 只扫 class 属性：注释里写一句 `foo--bar` 不算使用（否则护栏会因为注释而红）
  assert.deepEqual(
    findModifierClassWithoutStyle(`<template><!-- foo--bar --><div class="ok">z</div></template>`, ""), []);
  // ⑥ 三元字符串写法 —— 仓里真实存在（ChatSearchDialog 的筛选 chip），漏了它这枚类就没人守
  assert.equal(
    findModifierClassWithoutStyle(
      `<template><div :class="on ? 'a-chip--on' : ''">y</div></template>`, "").length, 1,
    "三元字符串写法不能漏");
  // ⑦ 数组写法（多行，仓里有 14 处 :class="[")
  assert.equal(
    findModifierClassWithoutStyle(
      `<template><div :class="[\n  'base',\n  'a-chip--on',\n]">y</div></template>`, "").length, 1,
    "数组写法不能漏");
  // ⑧ 反向：CSS 变量工具类里也含 `--`，不许被认成修饰类（否则全库几百处误报）
  assert.deepEqual(
    findModifierClassWithoutStyle(
      `<template><div class="bg-[var(--gosslan-bg)] text-[color-mix(in_srgb,var(--gosslan-warning)_8%,transparent)] hover:bg-[var(--x)]">y</div></template>`,
      ""),
    [],
    "Tailwind 的 CSS 变量工具类不是修饰类");
});

test("全库扫到的修饰类清单要非空转（同一个解析器，不靠第二条正则）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const names = new Set<string>();
  for (const f of collectVueFiles(srcDir)) {
    for (const n of modifierClassesUsed(readFileSync(f, "utf8"))) names.add(n);
  }
  // 下限取自今天仓里的三枚（@你加重 / 筛选 chip 选中 / 菜单危险项）。
  // 只许"变少即红"：解析器哪天退化到什么都认不出，这条会红而不是安静地绿着。
  assert.ok(
    names.size >= 3,
    `只认出 ${names.size} 枚修饰类（${[...names].join(", ")}）⇒ 扫描口径疑似失效，这条判据在空转`);
});

test("src 下每个修饰类都能在样式里找到定义", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const globalCss = readFileSync(join(srcDir, "style.css"), "utf8");
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const issue of findModifierClassWithoutStyle(src, globalCss)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  // "解析器今天到底认出了几枚"由上一条用例防空转（同一条口径，不留第二把尺子）
  assert.deepEqual(bad, [], `这些修饰类挂上去了却没有样式定义：\n${bad.join("\n")}`);
});

/**
 * 整屏图片覆盖层只许长在**统一渲染点**（§12：收藏里的图必须走统一图片预览）。
 *
 * 为什么上一那条判据不够：它数的是 `<ImageLightbox>` 标签与名字里带 `lightbox` 的本地 ref。
 * 而"自己长一个查看层"这件事的**形状**根本不是这两条 —— 用户报的收藏页拿的是一个叫
 * `viewer` 的本地 ref + 一句 `fixed inset-0` 的整屏按钮里包 `<img :src="viewer">`，
 * 于是判据在、它抓不到 ⇒ 那是**半空转的判据**，比没有判据更坏（会让人以为这一格有人守着）。
 *
 * 这条按形状抓：模板里（剥掉 HTML 注释之后）凡是一个带 `fixed` 且带 `inset-0` 的元素**内部**
 * 出现 `<img :src="X">`，而 X 是本组件 script 段里 `const X = ref(...)` 声明的 —— 就是第二个预览实例。
 * 白名单只有那两个渲染点（壳层覆盖层 + 预览窗口）；缩略图不算（它不在整屏元素内部，
 * 且绑的是数组/prop 而不是本地图像状态）。
 *
 * 反向自证（非空转）：把 FavoritePanel 接进统一预览之后这一条应当绿；
 * 谁再写一个私有查看层 ⇒ 这一条点名报红，而上一那条不会。
 */
test("整屏图片覆盖层只许长在统一渲染点（私有 viewer 是第二个预览实例）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(join(srcDir, "components")).concat(collectVueFiles(join(srcDir, "layouts")));
  const ALLOWED = new Set(["layouts/ResponsiveLayout.vue", "components/window/PreviewWindow.vue"]);
  const offenders: string[] = [];
  for (const f of files) {
    const rel = f.replace(srcDir + "/", "");
    if (ALLOWED.has(rel)) continue;
    const full = readFileSync(f, "utf8");
    const tplAt = full.indexOf("<template>");
    if (tplAt < 0) continue;
    const script = full.slice(0, tplAt);
    const tpl = full.slice(tplAt).replace(/<!--[\s\S]*?-->/g, "");
    const localRefs = new Set<string>();
    for (const m of script.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*ref[<(]/g)) localRefs.add(m[1]);
    if (!localRefs.size) continue;
    // 逐个找"整屏元素"：class 里同时出现 fixed 与 inset-0 的开标签，往后取到它内部 900 字符
    for (const m of tpl.matchAll(/<([a-zA-Z]+)[^>]*class="[^"]*\bfixed\b[^"]*\binset-0\b[^"]*"[^>]*>/g)) {
      const inner = tpl.slice(m.index, m.index + 900);
      const img = /<img\b[^>]*:src="([A-Za-z_$][\w$]*)"/.exec(inner);
      if (img && localRefs.has(img[1])) offenders.push(`${rel}（整屏元素里直出本地 ref ${img[1]}）`);
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    "这些组件自己长了一层整屏图片查看器 ⇒ 必须改走 useImagePreviewStore.openGallery()（统一渲染点只有壳层覆盖层与预览窗口）",
  );
});

/**
 * 每一个 `<TodoImageThumb>` 调用点都必须**同时**带 `clickable` 与 `@open=`（§12「要做就做完整」）。
 *
 * 为什么钉这一条而不是钉"文件名单"：`TodoImageThumb` 的 `clickable` 默认值是 **false**
 * （`withDefaults(..., { clickable: false })`），于是"漏给一个 prop"这件事的形状是
 * **代码看起来完全正常、图就是点不动** —— 编译过、类型过、单测过，只有真人去点才发现。
 * 本仓真发生过两次：先是收藏（卡片图 + 详情 `<img>` 两处都没入口，已修 `a077850`），
 * 修完那一轮**同一个开关在聊天时间线的任务卡上仍然漏着**（复审 §12 那一行当时写的原话
 * 就包含「卡片图 clickable 默认 false」，说明这一类是被知道的，只是没被数完调用点）。
 *
 * 判据的输入由代码自己声明：扫组件目录数 `<TodoImageThumb` 的出现点，不手抄文件名单 ⇒
 * 新增一个调用点而忘了给 `clickable`，这条当场点名。
 */
test("每个任务图片缩略图调用点都必须可点（clickable 默认 false 会静默吞掉预览入口）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(join(srcDir, "components")).concat(
    collectVueFiles(join(srcDir, "layouts")),
  );
  const offenders: string[] = [];
  let sites = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const tplAt = src.indexOf("<template>");
    if (tplAt < 0) continue;
    // 剥注释的理由与上面那条一样：写在注释里的标签不是调用点（`[^>]*` 这个字符类匹配换行，
    // 所以多行属性写法的标签也能整段取到）。
    const tpl = src.slice(tplAt).replace(/<!--[\s\S]*?-->/g, "");
    for (const m of tpl.matchAll(/<TodoImageThumb\b[^>]*>/g)) {
      sites += 1;
      const tag = m[0];
      if (!/\bclickable\b/.test(tag) || !/@open=/.test(tag)) {
        offenders.push(f.replace(srcDir + "/", ""));
      }
    }
  }
  // 空转前置：一个调用点都没数到 ⇒ 组件改名/被搬走，这条判据就变成恒过
  assert.ok(sites > 0, "一个 <TodoImageThumb> 调用点都没数到 —— 组件改名的话这条判据已经空转");
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `这些调用点漏了 clickable 或 @open ⇒ 缩略图渲染出来但点不动（默认值 clickable:false）：${offenders.join(", ")}`,
  );
});

/**
 * 任务描述里的 @ 必须走**同一份**渲染件（第二阶段 §9「统一的 @ 渲染覆盖聊天和任务」）。
 *
 * 语义早就单源在 `utils/linkify`（`mention` / `mention-self` 两个 kind，由调用方传 `self` 决定
 * 显示成什么），缺的是**覆盖面**：聊天气泡与长文弹窗都渲染 @，而任务卡与任务详情里
 * `{{ todo.description }}` / `{{ item.description }}` 是裸插值 ⇒ 描述里 @ 到我时既不高亮、
 * 也不显示「@你」，与同一条消息在聊天里的表现不一致。
 *
 * 判据的输入由代码自己声明（§6① 的教训：同一个判断在两处各写一次迟早分叉）：
 * "属于任务这一族"= 该文件引用 `TodoItem` 或 `parseTodo`，**不是**我手抄的文件名单；
 * "在渲染描述"= 模板里（剥掉 HTML 注释之后）出现 `{{ X.description }}` 这种裸插值。
 * 看板上那两处是**输入框**（`v-model="draft.description"`），本来就该是纯文本 ⇒ 不算渲染点。
 */
test("任务描述必须经统一渲染件出 @，不许再裸插值", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(join(srcDir, "components"));
  const offenders: string[] = [];
  let sites = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // 归属由代码声明：引用任务这一族的类型/解析函数，才算"任务描述"的宿主
    if (!/TodoItem|parseTodo/.test(src)) continue;
    const tplAt = src.indexOf("<template>");
    if (tplAt < 0) continue;
    const tpl = src.slice(tplAt).replace(/<!--[\s\S]*?-->/g, "");
    // 分母数的是"这一族里渲染描述的点"，**两种写法都算**（裸插值与 `:text="x.description"`）：
    // 只数违规那种的话，全部迁完之后 sites=0，这条判据就分不清"迁完了"与"整族被摘掉了"。
    const renders = tpl.match(/[\w$]+(?:\.[\w$]+)*\.description\b/g) ?? [];
    const localRenders = tpl.match(/\{\{\s*description\s*\}\}/g) ?? [];
    sites += renders.length + localRenders.length;
    for (const m of tpl.matchAll(/\{\{\s*[\w$]+(?:\.[\w$]+)*\.description\s*\}\}/g)) {
      offenders.push(`${f.replace(srcDir + "/", "")}（${m[0]}）`);
    }
    // 卡片先取实时表（`live`）再渲染本地 `description` 也是一种正常形状；
    // 但若退回裸插值，同样会丢掉 @ 高亮 ⇒ 两种写法都要点名。
    for (const m of tpl.matchAll(/\{\{\s*description\s*\}\}/g)) {
      offenders.push(`${f.replace(srcDir + "/", "")}（${m[0]}）`);
    }
  }
  // 空转前置：一个渲染点都没数到 ⇒ 任务描述被整族摘掉或改名了，这条判据就恒过
  assert.ok(sites > 0, "一个「任务描述」渲染点都没数到 —— 改名/搬走的话这条判据已经空转");
  assert.deepEqual(
    offenders,
    [],
    `这些任务描述是裸插值 ⇒ 描述里的 @ 不高亮、@到我也不显示「@你」，与聊天里的同一句话不一致：` +
      offenders.join("、") + " —— 改法是换 <MentionText :text=... />（语义仍走 utils/linkify）",
  );
});

/**
 * 「@你」「[任务@你]」这类**查看者视角的文案**不许写进生产码（第二阶段 §8 与 §9 的交叉锁）。
 *
 * 为什么钉字面量而不是钉调用：这一类缺陷有两种相反的发生方向 —— ① 渲染端图省事直接把
 * `@你` 写死（换语言/换视角就错）；② 更坏的一种是**在发送或落库侧替换文案**，那等于把
 * "我自己的视角"烧进公共数据，对端与历史都会跟着错。方向②由群聊轮的跨进程判据钉
 * （库里那串字节必须逐字等于原文），这条钉方向①：文案的唯一来源是 `src/i18n/locales.ts`，
 * 生产码只能通过 `t("mention.self")` / `t("todo.mentionYou")` 取。
 *
 * 剥注释是因为这些字面量在注释里大量出现在（说明机制），**注释不是文案来源**；测试文件豁免
 * （`linkify.test.ts` 拿它当断言输入，那是判据不是产品文案）。
 */
test("查看者视角的 @ 文案只许存在于 i18n 名单里，生产码不许写死", () => {
  const srcDir = join(import.meta.dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(vue|ts)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const LITERALS = ["@你", "[任务@你]"];
  /**
   * 字典本体名单（豁免的**全集**，不是一个前缀规则）。
   *
   * 2026-10-07 字典按语言拆成两册后，这里从「一个字面路径」改成「点名三本」：
   * 用 `startsWith("i18n/locales")` 也能过，但那样任何落在该目录下的新文件都会**静默豁免**，
   * 而这条判据要的恰恰是「只有字典本体能带这些字面量」。新增一门语言的字典册要显式登记，
   * 忘了登记会当场红 —— 那是想要的形状，不是需要绕过的障碍。
   */
  const DICT_FILES = new Set(["i18n/locales.ts", "i18n/locales/zh-cn.ts", "i18n/locales/en-us.ts"]);
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of walk(srcDir)) {
    const rel = f.replace(srcDir + "/", "");
    if (DICT_FILES.has(rel) || rel.endsWith(".test.ts")) continue;
    scanned += 1;
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const lit of LITERALS) if (code.includes(lit)) offenders.push(`${rel}（含 ${lit}）`);
  }
  // 前置：真的扫到了东西，否则"零违规"只是因为路径写错
  assert.ok(scanned > 50, `只扫到 ${scanned} 个文件 —— 目录口径不对，这条判据在空转`);
  assert.deepEqual(offenders, [], `这些生产码把查看者视角的文案写死了：${offenders.join("、")}`);
});


/**
 * 「与我相关未完成任务数」这枚蓝色徽标只许一处算、两处消费同一份（第二阶段 §23）。
 *
 * 现状是好的（本轮现算核实）：规则在 `utils/todos::openTodosForMe`，生产码唯一调用点是
 * `useChatStore.ts` 里产 `openTodoByConv` 的那一处，组件里 `openTodosForMe(` 命中 **0**；
 * 会话列表项与聊天头任务图标都读 `chat.openTodoByConv[...]`。但"只有一处"今天靠人自觉 ——
 * 而"同一个数在两处各算一次"正是本仓出过的事故形状（#23 那次是弹窗标题 (9) 进去看到 6 条；
 * 未读数也漂过一轮）。所以这里钉两条：
 *  ① 组件/布局里不得出现 `openTodosForMe(`（徽标的尺子只许 store 拿）；
 *  ② 那两个消费点必须真的在消费那份 map（防止有人把徽标改回本地现算，①就形同虚设）。
 *
 * ⚠️ 这里刻意**不**禁 `foldTodos(` 本身 —— 那是公共折叠尺子，谁都该用它。禁的是**喂给它的那份数据**：
 * 看板 / 任务面板 / 成员面板原先折 `chat.messages[convId]`（有上界的消息缓存），而徽标走后端全表读
 * ⇒ 同一句判据两个家。这条 judgement 在 2026-09-28 被现读推翻（`PAGE_SIZE × MAX_PAGES = 1000 条/会话`、
 * `MAX_CACHED_CONVS = 8` 个会话整块逐出）⇒ 由那条新判据 ⑳ 钉住，本条只管"数不许自己算"。
 */
test("「与我相关」徽标只许 store 算一次，两处 UI 必须消费同一份 map", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(join(srcDir, "components")).concat(collectVueFiles(join(srcDir, "layouts")));
  const recomputeRe = /\bopenTodosForMe\s*\(/g;
  const offenders: string[] = [];
  for (const f of files) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (recomputeRe.test(code)) offenders.push(f.replace(srcDir + "/", ""));
    recomputeRe.lastIndex = 0;
  }
  assert.deepEqual(
    offenders,
    [],
    "组件层自己算了一遍「与我相关任务数」⇒ 出现第二个真源。改法：读 store 的 `openTodoByConv`（判定见 utils/todos::openTodosForMe）",
  );
  // ② 两个消费点确实在消费那份 map（同源这件事本身也要有判据，不然下轮改回本地现算没人知道）
  for (const [rel, needle] of [
    ["components/ChatWindow.vue", "chat.openTodoByConv["],
    ["components/conversation/ConversationListItem.vue", "chat.openTodoByConv["],
  ] as [string, string][]) {
    const code = readFileSync(join(srcDir, rel), "utf8");
    assert.ok(code.includes(needle), `${rel} 的徽标数字不再来自 chat.openTodoByConv ⇒ 与"单一事实源"冲突`);
  }
  // 非空转：同一台解析器必须抓得到那个坏形状，且不误抓"只是注释里提一句"
  assert.ok(recomputeRe.test(`const n = openTodosForMe(foldTodos(list), me).length;`), "夹具没被抓到 ⇒ 这条判据是空转的");
  recomputeRe.lastIndex = 0;
  assert.ok(!recomputeRe.test(`// 判定见 utils/todos::openTodosForMe\nconst n = chat.openTodoByConv[id] ?? 0;`), "注释里的名字被误抓");
});


// ---------------- ⑳ 群任务的取数口只有一份（#154-9） ----------------
//
// 徽标走 `api.getGroupTodoMessages`（后端全表），而看板 / 任务面板 / 成员面板折的是
// `chat.messages[convId]` —— 那份消息缓存有**两道**上界（现读 `useChatStore.ts`：
// `PAGE_SIZE × MAX_PAGES = 1000 条/会话`、`MAX_CACHED_CONVS = 8` 个会话整块逐出）。
// 于是「徽标还亮着，看板里再也列不出这条任务」是可达状态：用户没法归档一个看不见的任务，
// 而创建记录被逐出、更新记录还留着时还会折出一个没有创建时间的任务。
// store 自己在 `refreshConversations` 的注释里就写着「用内存里已有的消息算不行」——
// 那句话当时只应用在徽标那一半。现在三处消费者都读 `chat.groupTodoRows`（与徽标同一次读）。
//
// ⚠️ `ChatWindow.vue` 里那处 `foldTodos(chat.messages[...])` 是**合法的**，不许一起禁掉：
// 它折的是「这一屏时间线上已经渲染出来的卡片」的状态索引，语义本来就是"屏上的这些"，
// 不是"这个群的全部任务"。⇒ 分母要含合规写法，否则这条判据改完那一刻就空转。
test("自动归档天数：前端与后端是同一个数（归档在前端算，判权在后端）", () => {
  // 为什么要有这一格：自动归档是**前端**计算的（不落库），而"已归档任务全体成员可删"的
  // 判权在 Rust。两个数一旦分叉，界面会给出一颗点了被拒的删除按钮（或反过来没有按钮）。
  const srcDir = join(import.meta.dirname, "..");
  const rust = readFileSync(join(srcDir, "..", "src-tauri", "src", "protocol.rs"), "utf8");
  const m = rust.match(/TODO_AUTO_ARCHIVE_DAYS:\s*i64\s*=\s*(\d+)/);
  assert.ok(m, "protocol.rs 里找不到 TODO_AUTO_ARCHIVE_DAYS ⇒ 判据自己失去了对象");
  assert.equal(Number(m[1]), TODO_AUTO_ARCHIVE_DAYS, "前后端自动归档天数必须同值");
});

test("群任务三处界面的取数口只许是那份全表读，不许再折有上界的消息缓存", () => {
  const srcDir = join(import.meta.dirname, "..");
  const readers = [
    "components/GroupTasksBoard.vue",
    "components/GroupTasksPanel.vue",
    "components/GroupMemberPanel.vue",
  ];
  for (const rel of readers) {
    const code = readFileSync(join(srcDir, rel), "utf8");
    assert.ok(
      code.includes("chat.groupTodoRows["),
      `${rel} 不再读那份全表任务行 ⇒ 与「徽标同源」冲突（#154-9）`,
    );
    // 判的是**喂给公共折叠尺子的那份数据**，不是写法：把行先 hoisting 成局部变量也算合规，
    // 但整份文件都不许再碰那两道有上界的消息缓存。
    assert.ok(
      !code.includes("chat.messages["),
      `${rel} 又折回那份有上界的消息缓存 ⇒ 任务会从看板消失而徽标常亮（#154-9）`,
    );
    assert.ok(
      code.includes("chat.ensureGroupTodoRows("),
      `${rel} 必须按需补读（冷启动只开任务窗时那份源还没读过），否则界面会空`,
    );
  }
  // 2026-10-27 起时间线卡片也并进同一条规矩：卡片与看板必须是**同一份源**。
  // 上一版这里写的是"时间线折消息缓存是对的"——那条豁免的代价是：长会话里更新行被消息缓存
  // 挤掉之后，卡片停在旧值/已删除任务仍像活着，而看板早就是新值（用户 2026-10-27 实测
  // 「聊天里看到、列表上没有」）。现在改成"全表读优先，从没读过时才退回缓存"。
  const timeline = readFileSync(join(srcDir, "components/ChatWindow.vue"), "utf8");
  const prefersFullRead = (code: string) =>
    /const todoLiveRows = computed\(\(\) => \{[\s\S]{0,900}chat\.groupTodoRows\[convId\][\s\S]{0,300}chat\.messages\[convId\]/.test(code);
  assert.ok(prefersFullRead(timeline), "时间线卡片必须优先折那份全表源（与看板同源）");
  assert.ok(
    timeline.includes("todoTombstoneIds(") && timeline.includes(":todo-deleted-ids="),
    "墓碑也要传进卡片：否则已删除任务在聊天里仍是一张活卡",
  );
  // 非空转：坏形状（只读消息缓存）必须被同一台解析器抓到
  const bad = `const todoLiveRows = computed(() => { const convId = chat.activeConv; return chat.messages[convId] ?? []; });`;
  assert.ok(!prefersFullRead(bad), "解析器抓不到坏形状 ⇒ 这条判据是空转的");
});

// ---------------- ⑲ 「有人@我」只许走那一个三态入口（第二阶段 §10／#103） ----------------
//
// 修掉的缺陷：文本消息「有没有 @ 到我」原先只按**昵称**判。昵称可变（改过名字之后，历史上
// 那些 @ 就不再指向这个人）又不唯一（群里两个人可以同名 ⇒ 一个人被 @，两个人一起亮红点），
// 所以它天生带错。现在链路里带了「@ 了谁」的设备 id 名单，判定改走 `messageMentionsMe`。
//
// 这条判据防的是**回归的路径**：昵称那条没删（旧版本对端不认识这个字段，删了它们就永远
// 判不出 @ ⇒ 比原缺陷更糟），但它只许作为兜底待在 `messages.ts` 内部。任何调用点直接
// `messageMentionsName(rec, myName)` 都等于把这条 bug 原地复活，而界面上一切照常 ——
// 只有改名和同名这两种场景会静默判错，正是最难发现的那类。
test("「有人@我」只许走 messageMentionsMe：昵称判定不许在调用点直接出现", () => {
  const srcDir = join(import.meta.dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(ts|vue)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const BYPASS = ["messageMentionsName(", "messageMentionsAll("];
  const offenders: string[] = [];
  let scanned = 0;
  for (const f of walk(srcDir)) {
    const rel = f.replace(srcDir + "/", "");
    // messages.ts 是三态那条兜底的**唯一**合法落点；测试里按名字判是夹具的一部分
    if (rel === "utils/messages.ts" || rel.endsWith(".test.ts")) continue;
    scanned += 1;
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const lit of BYPASS) if (code.includes(lit)) offenders.push(`${rel}（含 ${lit}）`);
  }
  // 前置：真的扫到了东西，否则"零违规"只是因为路径写错
  assert.ok(scanned > 50, `只扫到 ${scanned} 个文件 —— 目录口径不对，这条判据在空转`);
  assert.deepEqual(
    offenders,
    [],
    "绕过三态入口直接按昵称判 @ ⇒ 改名与同名两种场景会静默判错。改法：调 `messageMentionsMe(rec, {id, name})`",
  );
  const messagesSrc = readFileSync(join(srcDir, "utils", "messages.ts"), "utf8");
  // ① 唯一入口必须真的还在被消费者用着 —— 否则上面的"零违规"只是因为没人判 @ 了
  const storeSrc = readFileSync(join(srcDir, "stores", "useChatStore.ts"), "utf8");
  // 2026-09-28：这三条规则整体搬进 `messages.ts::freshMentionedConvs`（搬的目的就是能吃单测）。
  // ⇒ 消费者侧现在认的是**那个入口的调用**，同时**入口自己**必须还在调 `messageMentionsMe`：
  //   两头都钉，才同时排掉「搬成一个没人调的空壳」与「store 里再各判一遍」这两种复活。
  assert.ok(
    /\bfreshMentionedConvs\s*\(/.test(storeSrc),
    "useChatStore 不再判「有人@我」⇒ 红点整条消失，而上面那条零违规是假的",
  );
  assert.ok(
    /function freshMentionedConvs[\s\S]*?messageMentionsMe\s*\(/.test(messagesSrc),
    "freshMentionedConvs 里没在调 messageMentionsMe ⇒ 三态入口成了没人走的死代码，红点改由别处判 = 第二个入口",
  );
  // ② 三态的 id 那条分支必须还在（不许把 messageMentionsMe 压回"只看昵称"）
  assert.ok(
    /Array\.isArray\(\s*ids\s*\)/.test(messagesSrc) && messagesSrc.includes("ids.includes(me.id)"),
    "messageMentionsMe 里的 id 分支不见了 ⇒ 三态被压回两态，本次修的缺陷原样复活",
  );
  // ③ 兜底那条也必须还在：旧版本对端不带这个字段，删掉它 = 那些消息永远不亮
  assert.ok(
    /textMentionsName\(\s*rec\.content/.test(messagesSrc),
    "昵称兜底被删 ⇒ 不认识 mentions 字段的旧对端发的 @ 再也判不出来（INV-P24 降级）",
  );
  // ④ 「用户此刻在不在看」这条口径只许有一个家，而且红点那条必须真的把它传进去：
  //   "会话开着"不等于"看着"（桌面端启动会自动打开最近那个会话），只按开着就抑制红点，
  //   同一个瞬间会出现「已读说没在看、红点说在看」两种相反答案 —— 两处各写一遍迟早只改一处。
  assert.ok(
    /activeVisible:\s*chatViewerLooking\(\)/.test(storeSrc),
    "红点那条没把「在不在看」传进 freshMentionedConvs ⇒ 退回「开着就等于看着」，后台窗口里收到的 @ 会被静默咽掉",
  );
  const hiddenHits = storeSrc.split("!document.hidden && app.chatVisible").length - 1;
  assert.equal(
    hiddenHits,
    1,
    `「!document.hidden && app.chatVisible」这个组合在 store 里出现 ${hiddenHits} 次（应为 1 次，只在 chatViewerLooking 那一处）⇒ 这条口径又分出第二个家，两条规则迟早只改一处`,
  );
  const lookerUses = storeSrc.split("chatViewerLooking()").length - 1;
  assert.ok(
    lookerUses >= 2,
    `chatViewerLooking() 只被引用 ${lookerUses} 次 ⇒ 已读与红点两条没有真的共用这份口径（定义那一处不计）`,
  );
  // 非空转：同一台解析器要抓得到那个坏形状，且不误抓"只是注释里提一句"
  const bad = `const hit = myName ? messageMentionsName(rec, myName) : false;`;
  assert.ok(BYPASS.some((lit) => bad.includes(lit)), "夹具没被抓到 ⇒ 这条判据是空转的");
  const commentOnly = `// 兜底走 messageMentionsName(rec, myName)\nconst ok = chat.mentionedConvs.has(id);`;
  const stripped = commentOnly.replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(!BYPASS.some((lit) => stripped.includes(lit)), "注释里的名字被误抓");
});

// ---------------- ⑳ 「@ 了谁」这条链的七段，断在哪一段就报哪一段 ----------------
//
// 为什么需要它：这条链**跨了两种语言、七个文件**，而且中间三段是"看不见就没事"的
// （DOM 的 data-mention-id → IPC 参数 → 加密明文 → 解密 → emit 形状）。任何一段被改动
// 都不会有编译错误，也不会有测试红 —— 表现是「@ 了我不亮红点」，而这正是本格原来
// 判不到根的那条缺陷（#103）。护栏按形状扫这七处，缺哪一段就点名哪一段。
//
// ⚠️ 刻意只断"接缝在不在"，不断实现细节（不锁参数名顺序之外的东西）。真正的行为判据在
//    protocol 层单测（三态编解码）、messages.test.ts（三态判定）、state.rs（emit 形状）。
test("「有人@我」从输入框到对端、再到气泡的接缝必须齐全（跨语言链条断在中间是无声的）", () => {
  const rootDir = join(import.meta.dirname, "..", "..");
  const SEAMS: [string, string, string][] = [
    ["src/components/chat/MessageComposer.vue", "emit(\"send\", { content: text, kind: k, mentionIds });", "① 输入框没把名单随 send 交出去"],
    ["src/components/ChatWindow.vue", "await chat.send(convId, content, kind, mentionIds);", "② 会话窗口收下了名单却没往下传"],
    ["src/stores/useChatStore.ts", "api.sendGroupMessage(convId.slice(6), content, kind, mentionIds", "③ store 发送时丢了这一参"],
    ["src/api/index.ts", "...(mentions ? { mentions } : {})", "④ 门面把『没带』和『空名单』压成了同一种（缺省必须不发这个键）"],
    ["src-tauri/src/commands/group_files.rs", "mentions: Option<Vec<String>>,", "⑤ 命令入口不再收这个参数"],
    ["src-tauri/src/commands/window.rs", "crate::protocol::gossip_plaintext_with_targets(", "⑥ 内核没把名单写进加密明文"],
    ["src-tauri/src/network/transport/gossip.rs", "mention_ids: mentions.as_deref(),", "⑦ 接收端解出来了却没回送给界面"],
    // ↓ #122 新增的三条腿：落点（哪一段算谁）从发送侧算出来、随事件送到界面、并被渲染件真的收下。
    //   这三段每一段被改动都不会有编译错误 —— 断掉的形状是"同名两个人又一起亮"，跟 #103 当初同族。
    ["src-tauri/src/commands/window.rs", "build_mention_targets(&content, ids,", "⑧ 发送侧不再算 @ 的落点（同名两人又分不开）"],
    ["src-tauri/src/network/transport/gossip.rs", "mention_targets: mention_targets.as_deref(),", "⑨ 解出的落点没回送给界面"],
    // ⑩ 原来是气泡里那句 `props.mentionTargets ?? null,`（DUP-06 之后切段循环搬进了
    //   `composables/useMessageSegments`，那句话跟着搬家 ⇒ 单钉气泡那份文件就成了假红）。
    //   现在拆成两格，链子反而更严：气泡必须把输入交给那个家，而**家里**必须真的把落点喂给 linkify。
    ["src/components/message/MessageTextBubble.vue", "useMessageSegments(", "⑩ 气泡不再走那个家 ⇒ 落点没交给切段"],
    ["src/composables/useMessageSegments.ts", "mentionTargets ?? null,", "⑩b 家收了输入却没把落点喂给 linkify ⇒ 同名两人又一起亮"],
    // ↓ #122 第二段（落库）加的两条：落点从"只随本次投递"变成"跟着这一行进库"，
    //   断掉的形状是"重启之后同名两个人又一起亮"——编译期什么都不会说。
    ["src-tauri/src/commands/window.rs", "mention_targets: targets.clone(),", "⑪ 发送侧算出的落点没写进自己那一行（自己发的历史重启后失忆）"],
    ["src-tauri/src/network/transport/gossip.rs", "mention_targets: mention_targets.clone(),", "⑫ 收到的落点没跟着落库 ⇒ 第二段白做"],
  ];
  const missing: string[] = [];
  for (const [rel, needle, why] of SEAMS) {
    const code = readFileSync(join(rootDir, rel), "utf8");
    if (!code.includes(needle)) missing.push(`${rel} —— ${why}`);
  }
  assert.deepEqual(missing, [], "「@ 了谁」这条链断了：\n" + missing.join("\n"));
  // 非空转：emit 那一腿最容易被顺手改成 `None`，这里当场演一遍"改坏必须报红"
  const broken = SEAMS[6][1].replace("mentions.as_deref()", "None");
  assert.ok(!SEAMS[6][1].includes(broken), "锚点写得太松 ⇒ 改坏了也抓不到");
});

// ---------------- ㉑ 乐观气泡的替换只许一个家（#160 群里发完显示两条） ----------------
//
// 形状：`send()` 先上 `tmp-*` 气泡 → 后端为跨窗口同步加的**自 emit** 把真实记录先落进同一个
// 列表 → invoke 返回后那次"把乐观行换成真实记录"如果是**按位置裸 splice**，就会插进第二份
// 同 `msg_id` 的记录。库里只有一行，所以切一次会话（`loadMessages` 整表重读）又变回一条
// —— 用户看到的正是"发完两条、切一下就好"。
// ⇒ 替换必须按 `msg_id` 认，并且这个判断只许住在 `utils/messages.ts::replaceOptimistic` 一处。
test("乐观→真实的替换必须走那一个纯函数，store 里不许留第二份裸 splice", () => {
  const root = join(import.meta.dirname, "..");
  const store = readFileSync(join(root, "stores", "useChatStore.ts"), "utf8");
  const utils = readFileSync(join(root, "utils", "messages.ts"), "utf8");

  assert.ok(
    store.includes("replaceOptimistic(list, msgId, next)"),
    "store 的 replaceMessage 不再调用那个纯函数 ⇒ 时间线里同 msg_id 只许一条这件事没人守",
  );
  // 第二条腿：那份纯函数必须**按 msg_id** 认出"真实记录已经在列表里"并摘掉乐观行，
  // 退化成按位置换就等于把 bug 放回去。
  assert.ok(
    utils.includes("m.msg_id === next.msg_id"),
    "replaceOptimistic 里那条按 msg_id 的吸并分支不见了 ⇒ 自 emit 先到时会插出两条",
  );
  // 分母里必须包含"合规写法不许被抓"：这里用现在这份真源码当阳性对照的反面 ——
  // 裸 splice 那个形状一旦回到 store 就必须被抓到。
  const rawSplice = /= \[\.\.\.list\.slice\(0, i\), merged,/;
  assert.ok(!rawSplice.test(store), "store 里又出现了按位置裸 splice 的替换（第二个家）");
  assert.ok(
    rawSplice.test("messages.value[convId] = [...list.slice(0, i), merged, ...list.slice(i + 1)];"),
    "这台解析器连坏形状都抓不到 ⇒ 上面那句 !test 是空转",
  );
});

// ---------------- ㉒ 对端已读推进的谓词只许一份口径（#161） ----------------
//
// 后端 `src-tauri/src/db/read_receipts.rs::mark_own_messages_read_upto` 是这句判据的家，
// 它的注释就写着"三份副本里取到最弱的那一条就是缺陷"（failed 会被后面那条已读点亮成已读）。
// 前端那份曾经正是只排除 `read` ⇒ 同一条规则两个家、其中一家缺条件。
test("已读回执推进的排除清单在前端只许走那个纯函数，不许再内联一份弱谓词", () => {
  const root = join(import.meta.dirname, "..");
  const store = readFileSync(join(root, "stores", "useChatStore.ts"), "utf8");
  const utils = readFileSync(join(root, "utils", "messages.ts"), "utf8");
  assert.ok(store.includes("promoteOnPeerRead(list, myDeviceId.value"), "store 不再走那个家 ⇒ 谓词会分叉");
  for (const k of ["read", "failed", "recalled"]) {
    assert.ok(utils.includes(`"${k}"`), `排除清单里的 ${k} 不见了 ⇒ 后端家那条注释说的缺陷回来了`);
  }
  // 反空转：这条判据必须抓得住"退回内联弱谓词"那个坏形状
  const weak = /m\.status !== "read" && m\.ts <= p\.last_read_ts/;
  assert.ok(!weak.test(store), "store 里又出现内联的弱谓词（只排除 read）");
  assert.ok(weak.test('if (m.sender_id === myDeviceId.value && m.status !== "read" && m.ts <= p.last_read_ts) {'), "这台解析器抓不到坏形状 ⇒ 上面那句 !test 是空转");
});

// 这两条判据都在**源文本**里找形状，而注释里出现被禁的字面量是好事（正是在解释为什么禁）
// ⇒ 必须先剥注释再比（本文件 ⑳ 那处已有同样口径，这里只是把它抽出来给两条共用）。
const stripShapeComments = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
// 对照样本必须三种注释各写一处被禁字面量，同时留一行真代码不许被剥掉：
// 少了任何一种 ⇒ 这条判据会把解释性注释判成违规（假红），多了就变成空转。
{
  const stripped = stripShapeComments(
    '// 原生 <select> 的弹层是系统画的\n/* 同理 <option> 也看不见 */\n<!-- 模板注释里再写一次 <option> -->\nconst keepMe = 1;\n',
  );
  assert.ok(!stripped.includes("<select>"), "行注释没被剥掉 ⇒ 判据会假红在解释上");
  assert.ok(!stripped.includes("<option>"), "块注释或模板注释没被剥掉 ⇒ 判据会假红在解释上");
  assert.ok(stripped.includes("const keepMe"), "剥注释把真代码也吃了 ⇒ 判据变成摆设");
}

// ---------------- ㉓ 详情弹窗的三选一字段只许走那一个共用组件（暗夜下的原生弹层是系统画的） ----------------
//
// 用户 2026-09-30 实测：暗夜模式里展开「类型」下拉，「任务」「缺陷」两行几乎看不见。
// 根因不是配色错，是**渲染者不同**：原生 `<select>` 的弹层由系统画，而我们给控件写了
// `bg-transparent` + 主题文字色 ⇒ 浅底上落近白字，只有当前项因系统反色才读得出来。
// 同弹窗里「状态」早就是自绘菜单（`.gosslan-menu`），一处原生一处自绘才会只坏一半。
test("详情弹窗的三选一字段只许走 TodoPickField，不许再出现原生 select", () => {
  const root = join(import.meta.dirname, "..");
  const dialog = stripShapeComments(readFileSync(join(root, "components", "TodoDetailDialog.vue"), "utf8"));
  const field = stripShapeComments(readFileSync(join(root, "components", "TodoPickField.vue"), "utf8"));
  // 三格（状态 / 优先级 / 类型）都在，且一个不少
  assert.equal(
    (dialog.match(/<TodoPickField\b/g) ?? []).length,
    3,
    "详情弹窗里三选一字段应当是 3 处 TodoPickField（状态 / 优先级 / 类型）",
  );
  for (const bad of ["<select", "<option"]) {
    assert.ok(!dialog.includes(bad), `详情弹窗又出现了 ${bad} ⇒ 暗夜下那半截看不见的弹层会回来`);
  }
  // 共用组件必须吃主题（自绘菜单），且不许写死色值
  assert.ok(field.includes("gosslan-menu"), "TodoPickField 不再走 .gosslan-menu ⇒ 观感分叉");
  assert.ok(field.includes("update:modelValue"), "TodoPickField 不再往上抛值 ⇒ 三格点了没反应");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(field), "TodoPickField 里出现了写死的十六进制色 ⇒ 暗色档不会跟着变");
  // 反空转：这台判据必须抓得住"退回原生下拉"那个坏形状
  const native = /<select\b/;
  assert.ok(
    native.test('<select id="todo-category-pick" class="bg-transparent"><option>a</option></select>'),
    "判据抓不到原生 select ⇒ 上面那句 includes 是空转",
  );
});

// ---------------- ㉔ 看板行的类型角标三档一律画（「任务」不许再靠"不画"来降噪） ----------------
//
// 以前只有需求/缺陷画标签，理由是"每行都挂一个灰标签会把区分淹掉"。用户实测的结论相反：
// **没有标签那一档才是最难认的**，扫一眼只能靠猜 ⇒ 三档一律画，「任务」用中性档。
test("看板行的类型角标三档一律画，不许再用「任务不画」降噪", () => {
  const root = join(import.meta.dirname, "..");
  const board = stripShapeComments(readFileSync(join(root, "components", "GroupTasksBoard.vue"), "utf8"));
  const todos = readFileSync(join(root, "utils", "todos.ts"), "utf8");
  assert.ok(
    !/category\s*!==\s*['"]task['"]/.test(board),
    "看板又回到「只有需求/缺陷画角标」⇒ 用户那句「列表上没明显标识、不好区分」就还在",
  );
  assert.ok(board.includes("TODO_CATEGORY_PILL[x.category]"), "看板行的类型角标不再吃那张配色表");
  for (const k of ["task", "requirement", "bug"]) {
    assert.ok(new RegExp(`^\\s*(${k}|"${k}")\\s*:`, "m").test(todos), `配色表里少了 ${k} 那一档`);
  }
  // 反空转：坏形状必须被上面那条正则抓到
  assert.ok(
    /category\s*!==\s*['"]task['"]/.test('<span v-if="x.category !== \'task\'" :class="TODO_CATEGORY_PILL[x.category]">'),
    "判据抓不到「任务不画」那个条件 ⇒ 上面那句 !test 是空转",
  );
});

// ---------------- ㉕ 自绘标题栏压在**一切**内容浮层之上（只有 Toast 可以盖它） ----------------
//
// 真实缺陷（用户 2026-09-30 实测「图片预览独立窗口会遮住头部标题栏关闭最小化那块，应该只在
// 下面内容区」+「所有独立窗口标题栏都不会被内容栏遮住，标题栏优先度最高」）：
// ⑫ 那条只钉住**五个具名**浮层之间的先后，钉不住"第六个浮层随手写个更大的数就把 caption 压下去了"。
// 而 `TitleBar` 原先根本没有 `position`/`z-index` ⇒ 按绘制顺序**任何**定位元素都高于它：
// ✕/− 看不见也点不着，辅助窗那条 caption 还是整扇窗唯一的拖拽区（窗口连移都移不动）。
// 所以这条判据的作用点是**全体 .vue**，不是清单：标题栏必须严格高于除 Toast 外的最大层级，
// 且严格低于 Toast（Toast 是 `pointer-events-none` 的失败反馈，被压住等于没有反馈）。
// 层级一律从源码现算，不在这里抄任何数字 ⇒ 新增浮层抬高自己时会当场红，而不是靠人记得阶梯。
test("自绘标题栏高于一切内容浮层、只低于 Toast（层级从源码现算）", () => {
  const srcDir = join(import.meta.dirname, "..");
  /** 剥注释后取该文件里**所有** z-[NN]（一个文件可能有多处浮层）。 */
  const zsOf = (text: string) =>
    ((stripShapeComments(text).match(/z-\[(\d+)\]/g) ?? []).map((s) => Number(s.slice(3, -1))));

  const titlePath = join(srcDir, "components", "TitleBar.vue");
  const toastPath = join(srcDir, "components", "ToastHud.vue");
  const titleZ = Math.max(...zsOf(readFileSync(titlePath, "utf8")));
  const toastZ = Math.max(...zsOf(readFileSync(toastPath, "utf8")));

  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const content: { file: string; z: number }[] = [];
  for (const f of files) {
    if (f === titlePath || f === toastPath) continue;
    for (const z of zsOf(readFileSync(f, "utf8"))) content.push({ file: f.replace(`${srcDir}/`, ""), z });
  }
  assert.ok(content.length > 0, `一个内容层级都没扫到（${files.length} 个 .vue）⇒ 这条判据在空转`);
  const top = content.reduce((a, b) => (b.z > a.z ? b : a));
  assert.ok(
    titleZ > top.z,
    `标题栏(z-${titleZ}) 被内容浮层压住了：${top.file} 写着 z-[${top.z}] ⇒ caption 的 ✕/− 与唯一拖拽区会看不见点不着`,
  );
  assert.ok(titleZ < toastZ, `Toast(z-${toastZ}) 压不到标题栏(z-${titleZ}) 之上 ⇒ 顶部那条失败提示会被 caption 挡住`);

  // 反空转：① 抬高一档的内容浮层必须被上面那句抓到；② 注释里写的 z-[NN] 不许算数。
  assert.ok(zsOf('<div class="glass fixed inset-0 z-[200]">').includes(200), "现算取不到内容层级 ⇒ 上面那条比较是摆设");
  assert.deepEqual(
    zsOf("<!-- 阶梯里写 z-[200] 只是解释 -->\n/* z-[300] */\n// z-[400]\nconst keep = 'z-[7]';"),
    [7],
    "剥注释没生效 ⇒ 任何一句解释文字都能把这条判据顶红（假红）",
  );
});

// ---------------- ㉖ 群任务那串编号只许由 todoCode 出（字母不落库、短码不落库） ----------------
//
// 用户 2026-09-30 那八条里最容易改坏的是两件"看着无害"的事：
// ① 某个界面自己拼一次 `#N`、或按当前顺序数一个 1..N —— 于是同一条任务在两处显示两个号
//    （看板左列原本就是 ordinals，切一次筛选号就变，正是那条缺陷的形状）；
// ② 把字母或"后四位"这种**显示态**写进载荷/库里 —— 那是第二个事实来源，跨端一旦不一致就再也对不上。
// 所以这条钉的是：字母表 + 位数规则只在 `utils/todos.ts` 一处，三处界面都只许调用 `todoCode`，
// 而线上载荷里根本没有"字母"这一格（规则 7）。
test("群任务编号只有一个家：字母表与缩短规则在 todos.ts，界面只许调用", () => {
  const root = join(import.meta.dirname, "..");
  const todos = stripShapeComments(readFileSync(join(root, "utils", "todos.ts"), "utf8"));
  const protocol = readFileSync(join(root, "..", "src-tauri", "src", "protocol.rs"), "utf8");

  // ① 一个家：字母表、位数上限、算码的函数、会话层那张实时表都只在 utils/todos.ts
  for (const shape of ["TODO_CATEGORY_LETTER", "TODO_CODE_DIGITS", "export function todoCode", "export function todoLiveMap"]) {
    assert.ok(todos.includes(shape), `utils/todos.ts 里少了 ${shape} ⇒ 编号口径没有家了`);
  }
  for (const k of ["task", "requirement", "bug"]) {
    assert.ok(
      new RegExp(`^\\s*(${k}|"${k}")\\s*:`, "m").test(todos),
      `字母表里少了 ${k} 那一档 ⇒ 该类型的新任务会整个不出码`,
    );
  }

  // ② 三处界面（卡片 / 看板 / 详情）只许取用，不许各拼一份
  for (const rel of ["components/TodoCardBubble.vue", "components/GroupTasksBoard.vue", "components/TodoDetailDialog.vue"]) {
    const src = stripShapeComments(readFileSync(join(root, rel), "utf8"));
    assert.ok(/todoCode\(/.test(src), `${rel} 不再通过 todoCode 取编号 ⇒ 显示口径出现第二份`);
    assert.ok(!/#\$\{/.test(src), `${rel} 又手写了一次「# + 号」那种前缀`);
    assert.ok(!/\bordinals\b/.test(src), `${rel} 把位置序号当编号用了 ⇒ 切一次筛选同一条任务就换号`);
    assert.ok(!/TODO_CODE_DIGITS/.test(src), `${rel} 自己数了位数 ⇒ 缩短规则会有两份`);
  }

  // ③ 字母与短码都是**现推的显示态**：线上载荷里根本没有这一格
  assert.ok(!/\bletter\b/.test(protocol), "群任务载荷里出现了 letter ⇒ 字母变成第二个事实来源");
  assert.ok(/pub number: i64,/.test(protocol), "载荷里的 number 不再是那个完整数字 ⇒ 编号口径被动过");

  // 反空转：三种坏形状必须被上面那几条抓到
  assert.ok(/#\$\{/.test("const t = `#" + "${item.number} `;"), "抓不到手写前缀 ⇒ 那句 !test 是空转");
  assert.ok(/\bordinals\b/.test("const ordinals = computed(() => new Map());"), "抓不到位置序号 ⇒ 那句 !test 是空转");
  assert.ok(/\bletter\b/.test("pub letter: String,"), "抓不到载荷里的 letter ⇒ 那句 !test 是空转");
});

/**
 * 本人头像只有**一个**渲染处（`SelfAvatar`），且那三处确实都在用它。
 *
 * 真实现场（2026-10-07 用户报）：同一个账号在三个地方三张脸 ——
 * 桌面导航栏是 emoji 小动物、移动端「我的」页顶部是 lucide 的 `UserCircle`（"一个蓝色的图标"）、
 * 资料页虽是 emoji 却被一层常显的红色相机蒙版整个盖住（"一个红色的卡片"）。
 * 这类缺陷**编译过、门禁绿、只有肉眼看得出**，所以必须机器盯。
 *
 * 两条一起用：正向钉"三个消费点都在"，反向钉"图片那一支没有第二个家"。
 * 只写正向会漏掉"新站点又手写一份"；只写反向会漏掉"某处被改成不渲染头像"。
 */
test("本人头像三处都走 SelfAvatar", () => {
  const srcDir = join(import.meta.dirname, "..");
  const surfaces = [
    "components/NavRail.vue",
    "layouts/ResponsiveLayout.vue",
    "components/settings/ProfileSection.vue",
  ];
  for (const rel of surfaces) {
    const src = readFileSync(join(srcDir, rel), "utf8");
    assert.match(src, /import SelfAvatar from "@\/components\/SelfAvatar\.vue";/, `${rel} 必须 import SelfAvatar`);
    assert.match(src, /<SelfAvatar\b/, `${rel} 必须用 <SelfAvatar> 渲染本人头像`);
  }
});

/**
 * **头像框只有一个家**（2026-10-29 审计 DUP-08）。
 *
 * 原先 13 个组件各写一遍 `gosslan-avatar-box` + `gosslan-avatar-emoji`，圆角漂成 3 种
 * （token / rounded-full / 完全没圆角）。这类重复不会报错，只会表现成
 * "同一个 app 里同一个人为了三张脸 / 某一处头像没裁圆"。
 */
test("头像框只许住在 ui/AvatarBox.vue：别处再写一份盒子必须报（正控）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const boxes = files.filter((f) => /class="gosslan-avatar-box/.test(readFileSync(f, "utf8")));
  const rels = boxes.map((f) => f.replace(srcDir + "/", "")).sort();
  assert.deepEqual(rels, ["components/ui/AvatarBox.vue"],
    `gosslan-avatar-box 又长出第二份：${rels.join(", ")}`);
  // 正控：往真组件里塞一份盒子，扫描器必须读得出来（不是"扫到 0 处所以恒真"）
  const real = readFileSync(join(srcDir, "components", "AddFriendModal.vue"), "utf8");
  const mutated = real.replace("<template>", '<template>\n  <div class="gosslan-avatar-box" />');
  assert.equal(/class="gosslan-avatar-box/.test(mutated), true, "盒子写回模板里必须被这条判据看见");
});

/**
 * 调用点不许再自己写圆角档位，也不许给"本人头像"喂它没有的 prop。
 * 后一条是真缺陷的形状：`<SelfAvatar :src :size>` 里那两个 prop 都不存在 ⇒ Vue 把它们当
 * 普通属性落到根元素 ⇒ 尺寸类没人给 ⇒ 那一列头像塌成零尺寸，而且画的是**本机自己**的脸。
 */
test("AvatarBox 的档位只能三选一；SelfAvatar 不许被喂不存在的 prop", () => {
  const srcDir = join(import.meta.dirname, "..");
  const bad: string[] = [];
  for (const f of collectVueFiles(srcDir)) {
    const rel = f.replace(srcDir + "/", "");
    if (rel.endsWith("ui/AvatarBox.vue")) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<AvatarBox\b[\s\S]*?\/>/g)) {
      if (/rounded-/.test(m[0])) bad.push(`${rel} 调用点自己写 rounded-*（档位归 round prop）`);
      const round = /round="([^"]+)"/.exec(m[0]);
      if (round && !["token", "full", "none"].includes(round[1])) {
        bad.push(`${rel} round="${round[1]}" 不是三个档之一`);
      }
    }
    for (const m of src.matchAll(/<SelfAvatar\b[^>]*\/(?:>|>)/g)) {
      if (/:src=|:size=/.test(m[0])) {
        bad.push(`${rel} 给 SelfAvatar 喂了它没有的 prop（${m[0].trim().slice(0, 60)}…）`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

test("SelfAvatar 的那个「唯一数据源」确实是 store，不是各自传进来的 prop", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "SelfAvatar.vue"), "utf8");
  // 图片与默认脸都从 useAppStore 的 device 现读 —— 这是"三处同一个数据源"这句话的落点。
  assert.match(src, /const src = computed\(\(\) =>/, "图片要有唯一的取值口");
  assert.match(src, /app\.device\?\.avatar/, "图片必须来自 app.device.avatar");
  assert.match(src, /const seedKey = computed\(\(\) => app\.device\?\.device_id \|\| app\.device\?\.nickname \|\| null\)/,
    "默认脸的种子键必须来自 store 的 device_id（不许用调用点手里那份未保存的昵称）");
  // 反空转：这条判据读的是真文件；若 SelfAvatar 被改名/删掉，上面几条会一起红，
  // 而不是"扫到 0 处所以恒真"。
  // 2026-10-29 审计 DUP-08：盒子与 emoji 的画法搬进唯一的家 `ui/AvatarBox.vue`，
  // 所以这里钉的是"SelfAvatar 必须走那个家"，而不是它自己带 gosslan-avatar-box。
  assert.match(src, /import AvatarBox from "@\/components\/ui\/AvatarBox\.vue";/, "必须 import 那个唯一的家");
  assert.match(src, /<AvatarBox\b[^>]*:id="seedKey"/, "本人头像必须把 seedKey 交给那个家");
  assert.doesNotMatch(src, /class="gosslan-avatar-box/, "SelfAvatar 自己不许再画盒子（那是第二份形状）");
});

/**
 * 默认头像选择器（用户 2026-10-22：「自己搭配就用你随机的算法里的数据列出来…不要太开放」）。
 *
 * 钉三件事：
 *   ① 选项网格读 `avatarSeed.ts` 的清单常量，模板里不许再手抄一份清单；
 *   ② 随机走 `randomAvatarPair`（同一张组合表），不是模板里另写一个 Math.random；
 *   ③ 资料页确认后复用 `persistProfile`（既有 updateProfile 链路），不新开命令/字段。
 * 另钉：自定义色只能走原生取色器（唯一 input），不许退化成自由文本输入。
 * 读的是真文件：改名/删文件会直接抛，不会"扫到 0 处所以恒真"。
 */
test("默认头像选择器：选项网格来自派生清单（含自定义色），确认走既有资料保存链路", () => {
  const root = join(import.meta.dirname, "..");
  const dialog = readFileSync(join(root, "components", "settings", "AvatarPresetDialog.vue"), "utf8");
  assert.match(dialog, /v-for="e in AVATAR_EMOJIS"/, "表情网格必须遍历派生清单");
  assert.match(dialog, /v-for="c in AVATAR_BACKGROUNDS"/, "颜色网格必须遍历派生清单");
  assert.match(dialog, /randomAvatarPair\(selection\.value\)/, "随机必须走同一份组合表");
  assert.equal((dialog.match(/:aria-pressed=/g) ?? []).length, 3, "表情/调色板/自定义色都要报告选中态");
  // 仍然"不要太开放"：没有自由文本输入；唯一的 input 是浏览器原生取色器（自定义色）。
  assert.equal((dialog.match(/<input\b/g) ?? []).length, 1, "只允许一个取色器 input");
  assert.match(dialog, /type="color"/, "自定义色必须走原生取色器");
  assert.doesNotMatch(dialog, /<input[^>]*type="(?:text|search|email|number)"/, "不许出现自由文本输入");
  // 预览固定、只滚选项（用户 2026-10-22）：预览必须在 BaseModal 的 header 插槽里，
  // 不能和选项共用一条滚动区；否则往下翻选项时头像预览会被卷走。
  const modal = readFileSync(join(root, "components", "BaseModal.vue"), "utf8");
  assert.match(modal, /<slot name="header" \/>/, "BaseModal 必须提供固定 header 插槽");
  assert.match(dialog, /<template #header>/, "预览必须放进 header 插槽");
  assert.match(dialog, /data-avatar-options/, "选项区要有可定位的容器（探针也读它）");
  // 选中环画在按钮内部：第一/最后一列贴着滚动区边缘时，外圈会被裁掉（用户截图）。
  assert.equal((dialog.match(/ring-inset/g) ?? []).length, 3, "表情/色块/自定义色的选中环都要 ring-inset");
  assert.doesNotMatch(dialog, /ring-offset/, "选中环不许再用 ring-offset（会被滚动区裁）");
  assert.match(dialog, /justify-center/, "不满一行的选项要居中，而不是整排往左挤");

  const profile = readFileSync(join(root, "components", "settings", "ProfileSection.vue"), "utf8");
  // 资料页对齐（用户 2026-10-22）：头像收到 64px，与右侧「输入行 + 按钮行」视觉同高并居中。
  assert.match(profile, /data-profile-avatar/, "头像框要有可量测的定位点");
  assert.match(profile, /data-profile-fields/, "右侧字段要有可量测的定位点");
  assert.match(profile, /flex items-center gap-4 p-4/, "头像与右侧必须垂直居中（两者高度已压到接近）");
  assert.match(profile, /class="h-16 w-16/, "头像 64px 才与右侧两行同高");
  const at = profile.indexOf("async function onPresetApply");
  assert.ok(at > 0, "找不到 onPresetApply —— 资料页没有接上默认头像");
  const body = profile.slice(at, profile.indexOf("\n}", at));
  assert.match(body, /avatarPresetDataUrl\(seed\)/, "确认时必须把组合编码成头像");
  assert.match(body, /await persistProfile\(name\)/, "必须复用既有资料保存链路");
  assert.doesNotMatch(body, /api\.[a-zA-Z]+\(/, "不许为默认头像另开一条后端命令");
  assert.match(profile, /parseAvatarPreset\(avatar\.value\)/, "再次打开时要还原当前选中的组合");
});

// ---------------- ㉗ 搜索结果行只许走那一份「kind → 人话」，不许铺载荷原文 ----------------
//
// 用户 2026-10-09：「搜索界面搜索列表显示的都是 json」。887477e 那次只堵了**本机不认识**的
// kind，而 image / file / merge / todo / poll / announcement 这六种**认识**的 kind 载荷本来就是
// JSON，检索页当时仍然直接铺 `content` ⇒ 六种里任何一种命中都是一屏花括号。
// 判据钉的是"这一行有没有过 `previewBody`"，不是"有没有出现 m.content"——
// 后者是取值口，永远要在（传给 previewBody 的就是它）。
test("搜索结果行必须过 previewBody，不许直接铺载荷", () => {
  const root = join(import.meta.dirname, "..");
  const src = stripShapeComments(
    readFileSync(join(root, "components", "search", "ChatSearchDialog.vue"), "utf8"),
  );
  assert.ok(
    /previewBody\(\s*m\.kind,\s*m\.content/.test(src),
    "检索行不再走 previewBody 那份唯一的「kind → 人话」⇒ 卡片 kind 的 JSON 会回到界面上",
  );
  // 三种"把载荷原样交出去"的写法一律禁止（返回、三元的一支、直接插值）
  for (const bad of [/return\s+m\.content\s*[;\n]/, /\?\s*m\.content\s*:/, /\{\{\s*m\.content\s*\}\}/]) {
    assert.ok(!bad.test(src), `检索行又把载荷原文直接交给了界面：${bad}`);
  }
  // 反空转：上面三条必须抓得住修复前那一行的真实形状
  const before = "return isKnownKind(m.kind) ? m.content : UNSUPPORTED_KIND_LABEL;";
  assert.ok(/\?\s*m\.content\s*:/.test(before), "判据抓不到修复前那一行 ⇒ 上面那句 !test 是空转");
  assert.ok(!/previewBody\(/.test(before), "正向那条也一样，改回去要能红");
});

// ---------------- ㉘ 自绘菜单必须成对写 frost（.gosslan-menu 自己不带底） ----------------
//
// 同一句用户反馈的另一半：搜索面板那两个筛选下拉是透明的。全站六处 `.gosslan-menu` 里
// 五处写了 `frost`、两处漏了 —— 这种"只少一个类"的缺陷没有任何机器信号，
// 而它坏的方式是**文字叠在文字上**，比不居中严重。
test("findMenuWithoutBackdrop 认容器、不认菜单项", () => {
  const bad = findMenuWithoutBackdrop('<div class="gosslan-menu absolute right-0 top-9 z-20"></div>');
  assert.equal(bad.length, 1, "缺底的容器必须报出来");
  assert.equal(findMenuWithoutBackdrop('<div class="gosslan-menu frost fixed z-[70]"></div>').length, 0);
  // 菜单项与提示行里也含 "gosslan-menu" 这七个字，按词匹配才不会把它们判成容器
  assert.equal(
    findMenuWithoutBackdrop(
      '<button class="gosslan-menu-item"></button>\n<div class="gosslan-menu-hint px-2"></div>',
    ).length,
    0,
    "按子串匹配会把菜单项当成容器 ⇒ 全站假红",
  );
});

test("src 下所有自绘菜单都带了底", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 20, `应扫描到全部组件，实际 ${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findMenuWithoutBackdrop(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `发现透明得能看见底下一层的自绘菜单：\n${bad.join("\n")}`);
});

// ---------------- ㉙ 看板行首那两枚图标三档一律画（优先级与类型各一枚） ----------------
//
// 用户 2026-10-09：「任务列表的前面可以加一些小图标，显示出优先级 类型各种不同的区别」。
// 落点之前是空的：优先级在看板上**完全不显示**（只有聊天气泡里那一行文字），
// 类型只藏在编号首字母 T/R/B 里。两档都"缺省那一格不画"是最容易滑回去的写法 ——
// 2026-09-30 在类型角标上已经为这件事被纠正过一次（㉔），所以这条与它同族、一起钉。
test("看板行首的优先级与类型图标三档一律画，不许给缺省档留空", () => {
  const root = join(import.meta.dirname, "..");
  const board = stripShapeComments(readFileSync(join(root, "components", "GroupTasksBoard.vue"), "utf8"));
  const todos = readFileSync(join(root, "utils", "todos.ts"), "utf8");
  assert.ok(board.includes("PRIORITY_ICON[x.priority]"), "行首不再画优先级图标");
  assert.ok(board.includes("CATEGORY_ICON[x.category]"), "行首不再画类型图标");
  // ⚠️ 这里**不能**用"文件里不许出现 category === / priority !=="那种宽尺子：
  //   `canClaim` 里那句 `x.category === "requirement"`（认领只开给需求）是正当条件，
  //   第一版就是被它判成红的 —— 尺子宽到会咬合规写法，下一个人的处置是把它改松，
  //   那条判据就没了。所以只圈这两枚图标**自己那一段**，看它有没有被 v-if / v-show 挡起来。
  // 类型那枚的悬停词走 categoryText(x)（custom 档要显示用户输入的名字，不能写死枚举文案）。
  const iconRegion = (marker: string): string => {
    const at = board.indexOf(marker);
    assert.ok(at >= 0, `行首少了 ${marker} 那一枚（连悬停词都不在了）`);
    const start = board.lastIndexOf("<span", at);
    const end = board.indexOf("</span>", at);
    assert.ok(start >= 0 && end > start, `${marker} 那一枚的元素形状读不出来`);
    return board.slice(start, end);
  };
  assert.ok(
    !/v-if|v-show/.test(iconRegion(':title="t(TODO_PRIORITY_LABEL_KEY[')),
    "TODO_PRIORITY_LABEL_KEY 那一枚被条件化了 ⇒ 缺省档又变成“扫一眼靠猜”",
  );
  assert.ok(
    !/v-if|v-show/.test(iconRegion(':title="categoryText(x)"')),
    "TODO_CATEGORY 那一枚被条件化了 ⇒ 缺省档又变成“扫一眼靠猜”（㉔ 那次已经纠正过一回）",
  );
  for (const map of ["TODO_PRIORITY_ICON_CLASS", "TODO_CATEGORY_ICON_CLASS"]) {
    const at = todos.indexOf(`export const ${map}`);
    assert.ok(at >= 0, `${map} 不在了`);
    // 只取那张表的**字面量本身**（到第一个顶格 `};` 为止）。按固定长度切会吃进下一张表，
    // 于是"这张表少一档、下一张表里有那一档"也能通过 —— 分母松了就等于没判。
    const body = todos.slice(at, at + 1200).split("\n};")[0];
    for (const k of map.includes("PRIORITY") ? ["high", "normal", "low"] : ["task", "requirement", "bug", "custom"]) {
      assert.ok(
        new RegExp(`^\\s*(${k}|"${k}")\\s*:`, "m").test(body),
        `${map} 里少了 ${k} 那一档`,
      );
    }
  }
  // 反空转，两个方向都要：
  // ① 坏形状（把某一枚挡起来）必须被抓到；② 别处的正当条件（`canClaim` 那句 category ===）
  //    不许被抓到 —— 少了这半边，"把尺子改松"就是下一个人的出路。
  const lie =
    '<span v-if="x.priority !== \'high\'" :title="t(TODO_PRIORITY_LABEL_KEY[x.priority])"><component/></span>';
  assert.ok(/v-if|v-show/.test(lie), "抓不到条件化写法 ⇒ 上面那两条 !test 是空转");
  // `<component :is>` 会**绕过** componentImports 那条判据（它数的是模板里的 PascalCase 标签）。
  // 于是映射表里写错一个图标名 = 那一格静默不渲染，界面上只是"少个小图标"，没有任何东西报错。
  // 这里把两张表的取值逐个钉成"确实在 lucide 的 import 行里"。
  const importLine = board.match(/import \{([^}]*)\} from "lucide-vue-next";/);
  assert.ok(importLine, "lucide 的 import 行形状变了 ⇒ 下面那段读不到名单");
  const imported = new Set(importLine[1].split(",").map((s) => s.trim()).filter(Boolean));
  for (const mapName of ["PRIORITY_ICON", "CATEGORY_ICON"]) {
    const at = board.indexOf(`const ${mapName}:`);
    assert.ok(at >= 0, `${mapName} 不在了`);
    const body = board.slice(at, at + 400).split("\n};")[0];
    const used = [...body.matchAll(/:\s*([A-Z][A-Za-z0-9]*)\s*,/g)].map((m) => m[1]);
    // 优先级三档；类型四档（任务/需求/缺陷/自定义）。少一个 = 新档位静默没图标。
    const expected = mapName === "PRIORITY_ICON" ? 3 : 4;
    assert.ok(used.length === expected, `${mapName} 只数到 ${used.length} 个取值（应当是 ${expected} 档）`);
    for (const name of used) {
      assert.ok(imported.has(name), `${mapName} 用了 ${name}，但它不在 lucide 的 import 里 ⇒ 那一格静默不渲染`);
    }
  }
  // 反空转：上面那条必须抓得住"名字没 import"这个坏形状
  const lieVals = [..."x: NotImportedIcon,".matchAll(/:\s*([A-Z][A-Za-z0-9]*)\s*,/g)].map((m) => m[1]);
  assert.ok(lieVals[0] === "NotImportedIcon" && !imported.has("NotImportedIcon"), "抓不到没 import 的名字 ⇒ 空转");
  // 反空转的另一半：`canClaim` 那种正当条件不许被上面的图标判据抓到（它读的是图标那一段）
  assert.ok(
    !/v-if|v-show/.test('return x.category === "requirement" && !x.archived;'),
    "宽尺子（把整个文件当分母）不许回来",
  );
});

// ---------------- ㉛ 整屏形态写了顶部安全区就必须也写底部（roadmap N16） ----------------

test("N16 形状：只写 pt-[env(safe-area-inset-top)] 的整屏形态要报出来", () => {
  const buggy = `<template>
  <div class="fixed inset-0 z-[60] flex flex-col bg-x pt-[env(safe-area-inset-top)]">
    <div class="min-h-0 flex-1 overflow-y-auto p-3"><slot /></div>
  </div>
</template>`;
  const issues = findTopInsetWithoutBottomInset(buggy);
  assert.equal(issues.length, 1, "只让开顶部的那一种形状必须报 1 条");
  assert.match(issues[0].message, /Home Indicator/);
});

test("N16 合规写法两种都不报（分母要含合规形状，否则判据自己空转）", () => {
  const withUtility = `<template><div class="fixed inset-0 pt-[env(safe-area-inset-top)]">
  <div class="min-h-0 flex-1 overflow-y-auto safe-bottom"><slot /></div></div></template>`;
  const withMax = `<template><div class="fixed inset-0 pt-[env(safe-area-inset-top)]">
  <div class="p-4 pb-[max(env(safe-area-inset-bottom),1rem)]"><slot /></div></div></template>`;
  assert.deepEqual(findTopInsetWithoutBottomInset(withUtility), [], ".safe-bottom 这条既有写法要算合规");
  assert.deepEqual(findTopInsetWithoutBottomInset(withMax), [], "max() 这条既有写法要算合规（ActionSheet 早就在用）");
});

test("N16 的分母不收 :style 写法，也不收带 safe-area-ok 的文件", () => {
  const styleForm = `<template><div :style="{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }" /></template>`;
  assert.deepEqual(findTopInsetWithoutBottomInset(styleForm), [], "ToastHud 那种飘条只写顶部是**对的** ⇒ 不许误报");
  const opted = `<template><div class="fixed inset-0 pt-[env(safe-area-inset-top)]" /></template> <!-- safe-area-ok -->`;
  assert.deepEqual(findTopInsetWithoutBottomInset(opted), [], "逃生阀要走得通");
});

test("真实树：每个写了顶部安全区的 .vue 都也写了底部（分母现算并打印）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  const sites: string[] = [];
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = f.replace(srcDir + "/", "");
    if (!/pt-\[env\(safe-area-inset-top/.test(src)) continue;
    sites.push(rel);
    for (const issue of findTopInsetWithoutBottomInset(src)) {
      bad.push(`${rel}:${issue.line}  ${issue.message.slice(0, 40)}`);
    }
  }
  sites.sort();
  bad.sort();
  // 分母自己打印：数到 0 就是尺子坏了（这三处 = MobilePageFrame / FavoritePanel / BaseModal）
  assert.ok(sites.length >= 3, `现读只有 ${sites.length} 个文件写了整屏顶部安全区，尺子大概失效了：\n${sites.join("\n")}`);
  assert.deepEqual(bad, [], `有整屏形态没让开底部安全区：\n${bad.join("\n")}\n消费者：${sites.join(", ")}`);
});

test("N22 形状：缺哪个报哪个（两个都缺报两个）", () => {
  const both = findMessageImageWithoutFetchHint('<template>\n  <img alt="" src="a.png" />\n</template>');
  assert.equal(both.length, 1);
  assert.match(both[0].message, /loading="lazy"/);
  assert.match(both[0].message, /decoding="async"/);
  const half = findMessageImageWithoutFetchHint('<template>\n  <img loading="lazy" alt="" src="a.png" />\n</template>');
  assert.equal(half.length, 1);
  assert.match(half[0].message, /decoding="async"/);
  assert.doesNotMatch(half[0].message, /loading="lazy" 和/);
});

test("N22 合规写法、注释里的 <img>、逃生阀都不报（分母不能被 prose 撑大）", () => {
  const ok = '<template>\n  <img loading="lazy" decoding="async" alt="" src="a.png" />\n</template>';
  assert.deepEqual(findMessageImageWithoutFetchHint(ok), []);
  const prose = '<script>\n/** 此时 <img src> 直接报 error，所以换 :key */\n</script>\n<template>\n  <img loading="lazy" decoding="async" src="a.png" />\n</template>';
  assert.deepEqual(findMessageImageWithoutFetchHint(prose), [], "文档注释里提一句 <img> 不该被数进分母");
  const opted = '<template>\n  <!-- img-eager-ok -->\n  <img src="a.png" />\n</template>';
  assert.deepEqual(findMessageImageWithoutFetchHint(opted), [], "逃生阀要走得通");
});

test("N22 属性值里的 > 不许截断标签（截断会把合规的报成缺）", () => {
  const t = "<template>\n  <img :style='{ cursor: scale > 1 ? 2 : 1 }' loading='lazy' decoding='async' src='a.png' />\n</template>";
  assert.deepEqual(findMessageImageWithoutFetchHint(t), []);
  assert.equal(findImgTags(t).length, 1, "扫描器自己也只该数到 1 条");
});

test("真实树：src/components/message 下每条 <img> 都带两个 hint（分母现算并打印）", () => {
  const dir = join(import.meta.dirname, "..", "components", "message");
  // 头像框在 2026-10-29 从各组件搬进唯一的家 `ui/AvatarBox.vue`，它那份 `<img>` 原本就住在这条
  // 尺子扫过的目录里（MessageAvatar / ForwardModal）⇒ 扫描集必须跟着把它收进来，
  // 否则"搬家"会把这条不变量的覆盖面悄悄削掉一圈。
  const homeFile = join(import.meta.dirname, "..", "components", "ui", "AvatarBox.vue");
  const files = [...collectVueFiles(dir), homeFile];
  const sites: string[] = [];
  const bad: string[] = [];
  const exemptNames: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const n = findImgTags(src).length;
    if (n === 0) continue;
    const rel = f.startsWith(dir) ? f.replace(dir + "/", "") : "ui/AvatarBox.vue";
    sites.push(`${rel}=${n}`);
    if (src.includes("img-eager-ok")) { exemptNames.push(rel); continue; }
    for (const issue of findMessageImageWithoutFetchHint(src)) {
      bad.push(`${rel}:${issue.line} ${issue.message.slice(0, 46)}`);
    }
  }
  sites.sort();
  bad.sort();
  exemptNames.sort();
  assert.ok(sites.length >= 7, `message/（含头像框那个家）的 <img> 只数到 ${sites.length} 份，尺子大概失效了：\n${sites.join("\n")}`);
  assert.deepEqual(bad, [], `有消息图缺 fetch hint：\n${bad.join("\n")}`);
  // 豁免只有两支且理由都必须写在组件里：
  // - ImageLightbox：用户主动点开的整屏大图，懒加载只会让它更晚出现；
  // - MessageImageBubble：图在自身 @load 之前 display:none，lazy 会让它永不发请求（死锁，v4.35.2 真根因）。
  assert.deepEqual(exemptNames, ["ImageLightbox.vue", "MessageImageBubble.vue"],
    `显式豁免的两份必须是 ImageLightbox 与 MessageImageBubble，现数 ${JSON.stringify(exemptNames)}`);
  console.log(`· 真实树 <img> 分母（含 ui/AvatarBox.vue）：${sites.length} 份文件 / 共 ${sites.reduce((a, s) => a + Number(s.split("=")[1]), 0)} 条标签，豁免 ${exemptNames.length} 份（${exemptNames.join("、")}）`);
});

test("N21 判据：列表型 prop 的绑定里出现空数组字面量必须报（正向）", () => {
  const bad = [
    '<template><MessageItem :reactions="map.get(id) ?? []" /></template>',
    '<template><MessageItem :group-reader-ids="isGroup ? ids(g, ts) : []" /></template>',
    '<template><MessageReactionBar :chips="reactions ?? []" /></template>',
  ].join("\n");
  const issues = findFreshEmptyArrayProp(bad);
  assert.equal(issues.length, 3, `三处字面量该报三条，现数 ${issues.length}`);
  assert.ok(issues.every((i) => i.line > 0), '每条都要带行号');
});

test("N21 判据：引共享常量 / 非名单 prop / 注释里的字面量都不报（反面三例）", () => {
  assert.deepEqual(findFreshEmptyArrayProp('<template><MessageItem :reactions="map.get(id) ?? EMPTY_REACTION_CHIPS" /></template>'), []);
  assert.deepEqual(findFreshEmptyArrayProp('<template><Foo :rows="[]"/></template>'), [], "rows 不在名单里 ⇒ 不误伤别处");
  assert.deepEqual(findFreshEmptyArrayProp("<template>\n<!-- :reactions=\"x ?? []\" 说明文字 -->\n</template>"), []);
});

test("N21 真实树：消息行调用点上这些绑定一个都不许带空数组字面量（分母与阳性对照现数）", () => {
  const rel = ["components/ChatWindow.vue", "components/MessageItem.vue"];
  let bindings = 0;
  const bad: string[] = [];
  for (const r of rel) {
    const src = readFileSync(join(import.meta.dirname, "..", r), "utf8");
    const n = countListPropBindings(src);
    bindings += n;
    for (const issue of findFreshEmptyArrayProp(src)) bad.push(`${r}:${issue.line}`);
  }
  assert.ok(bindings >= 4, `两个文件里只数到 ${bindings} 个列表型 prop 绑定 ⇒ 属性大概被改名了，这条判据现在是瞎的`);
  assert.deepEqual(bad, [], `消息行调用点又出现空数组字面量：\n${bad.join("\n")}`);
  console.log(`· N21 真实树分母：${rel.length} 份文件 / ${bindings} 个列表型 prop 绑定，全部引共享常量`);
});

// ---------------- ㉞ 图片盒高度只从 previewMetrics 取（roadmap N22） ----------------

test("㉞ 正向：图片盒写了高度工具类必须报，估算端自留一份也要报", () => {
  const bubble = `<script setup lang="ts">
import { IMAGE_BUBBLE_HEIGHT, IMAGE_PLACEHOLDER_HEIGHT } from "@/utils/previewMetrics";
</script>
<template>
  <div class="relative w-52 max-w-full overflow-hidden">
    <div v-if="state !== 'loaded'" class="flex h-32 w-full items-center bg-[var(--gosslan-hover)]" />
    <img loading="lazy" decoding="async" class="block max-h-72 w-full object-contain" />
  </div>
</template>`;
  const issues = checkImageBubbleHeightSources(bubble, "export const x = 1;");
  assert.equal(issues.length, 2, `骨架与 <img> 各一条，现数 ${issues.length}`);
  assert.ok(issues.every((i) => i.line > 0), "每条都要带行号");
  assert.match(issues[0].message, /h-32/);
  assert.match(issues[1].message, /max-h-72/);

  const est = "const IMAGE_BUBBLE = 288;\nexport function f() { return IMAGE_BUBBLE; }";
  const clean = '<template><div class="flex w-full items-center" /></template>\nimport { IMAGE_BUBBLE_HEIGHT } from "@/utils/previewMetrics";';
  const withEst = checkImageBubbleHeightSources(clean, est);
  assert.equal(withEst.length, 1, `估算端那份副本该报一条，现数 ${withEst.length}`);
  assert.match(withEst[0].message, /估算端又定义了一份本地图片高度常量/);
});

test("㉞ 反面：从常量取高度 / 图标用 size-* / 注释里的写法 / 逃生阀 —— 都不许报", () => {
  const ok = `<script setup lang="ts">
import { IMAGE_BUBBLE_HEIGHT, IMAGE_PLACEHOLDER_HEIGHT } from "@/utils/previewMetrics";
</script>
<template>
  <div class="relative w-52 max-w-full overflow-hidden">
    <!-- 旧写法：class="h-32"，已改走常量 -->
    <div v-if="state !== 'loaded'" class="flex w-full items-center" :style="{ height: '288px' }">
      <ImageIcon class="size-6 animate-pulse opacity-40" />
    </div>
    <img loading="lazy" decoding="async" class="block w-full object-contain" />
  </div>
</template>`;
  assert.deepEqual(checkImageBubbleHeightSources(ok, "export const a = 1;"), []);
  const opted = "<!-- image-height-ok -->\n" + ok.replace('class="flex w-full items-center"', 'class="flex h-32 w-full items-center"');
  assert.deepEqual(checkImageBubbleHeightSources(opted, "export const a = 1;").filter((i) => /高度工具类/.test(i.message)), [],
    "注释里的字面量与逃生阀那条都不该算");
});

test("㉞ 真实树：MessageImageBubble 与 messageHeight 现在这一份必须合规（分母现数）", () => {
  const root = join(import.meta.dirname, "..");
  const bubble = readFileSync(join(root, "components/message/MessageImageBubble.vue"), "utf8");
  const est = readFileSync(join(root, "utils/messageHeight.ts"), "utf8");
  const metrics = readFileSync(join(root, "utils/previewMetrics.ts"), "utf8");
  const attrs = countClassAttrs(bubble);
  assert.ok(attrs >= 5, `图片盒那份组件只数到 ${attrs} 个 class 属性 ⇒ 模板大概被改名了，这条判据现在是瞎的`);
  assert.deepEqual(checkImageBubbleHeightSources(bubble, est), []);
  // 常量本身必须是"三者同一个数"：估算端与渲染端引的是同一个名字，值只有一个家。
  assert.match(metrics, /export const IMAGE_BUBBLE_HEIGHT = 288;/);
  assert.match(metrics, /export const IMAGE_PLACEHOLDER_HEIGHT = 128;/);
  assert.match(est, /import\s*\{[^}]*IMAGE_BUBBLE_HEIGHT[^}]*\}\s*from "@\/utils\/previewMetrics"/);
  console.log(`· N22 真实树分母：图片盒 ${attrs} 个 class 属性 / 0 处高度工具类；估算端无本地副本`);
});

// ---------------- ㉞b 合并转发卡片的定高是一个数还是两个数（2026-10-24 拍板：常量不动、补判据） ----------------

const MERGE_CARD_OK = `<template><button class="relative flex h-24 w-60 flex-col px-3 py-2">卡片</button></template>`;
const MERGE_EST_OK = `const MERGE_CARD = 96;\nexport function estimate(k: string) {\n  switch (k) {\n    case "merge":\n      return MERGE_CARD;\n    default:\n      return 0;\n  }\n}`;

test("㉞b 合规写法静默；三格各自的坏形状都要红", () => {
  assert.deepEqual(checkMergeCardHeightCoupling(MERGE_CARD_OK, MERGE_EST_OK), [], "h-24(=96) 与 MERGE_CARD=96 同源");

  const noFixed = MERGE_CARD_OK.replace("h-24", "min-h-0");
  assert.equal(checkMergeCardHeightCoupling(noFixed, MERGE_EST_OK).length, 1, "① 摘掉定高 ⇒ 红");

  const drifted = MERGE_CARD_OK.replace("h-24", "h-28");
  const driftIssues = checkMergeCardHeightCoupling(drifted, MERGE_EST_OK);
  assert.equal(driftIssues.length, 1, "② h-28(=112) 与 96 不是同一个数 ⇒ 红");
  assert.match(driftIssues[0].message, /112px/, "提示里要报出两边各是多少，别让人回去换算");

  const inline = MERGE_EST_OK.replace("return MERGE_CARD;", "return 96;");
  const inlineIssues = checkMergeCardHeightCoupling(MERGE_CARD_OK, inline);
  assert.equal(inlineIssues.length, 1, "③ 分支改写回内联 96（值还对、来源已散）⇒ 红");
  assert.match(inlineIssues[0].message, /return MERGE_CARD/);

  // 常量被改名/删掉 ⇒ 不许静默跳过（"读不到"本身就是这条判据要报的事）。
  assert.equal(checkMergeCardHeightCoupling(MERGE_CARD_OK, "export const X = 1;").length, 1,
    "读不到 MERGE_CARD 要红，不能当没有这一格");
});

test("㉞b 真实树：MergeCard 与 messageHeight 现在这一份必须合规，且常量仍是 96", () => {
  const root = join(import.meta.dirname, "..");
  const card = readFileSync(join(root, "components/message/MergeCard.vue"), "utf8");
  const est = readFileSync(join(root, "utils/messageHeight.ts"), "utf8");
  assert.deepEqual(checkMergeCardHeightCoupling(card, est), []);
  // 96 这个数本身由这里钉住（用户要求：不改常量）。要动它得连着虚拟列表测量一起改。
  assert.match(est, /const MERGE_CARD = 96;/, "MERGE_CARD 现值必须是 96");
  assert.match(card, /class="relative flex h-24 /, "渲染端仍是 h-24");
});

// ---------------- ㉟ 视图层不许裸写平台/输入方式探测（roadmap N11） ----------------

test("㉟ 正向：组件里裸写 matchMedia / UA 类 API 必须逐条报", () => {
  const bad = `<script setup lang="ts">
const a = window.matchMedia("(hover: hover)").matches;
const b = navigator.userAgent.includes("Macintosh");
const c = navigator.maxTouchPoints > 0;
</script>
<template><div /></template>`;
  const issues = findRawPlatformCheckInViewLayer(bad);
  assert.equal(issues.length, 3, `三处各报一条，现数 ${issues.length}`);
  assert.ok(issues.every((i) => i.line > 0), "每条都要带行号");
  assert.match(issues.map((i) => i.message).join("\n"), /utils\/platform/);
});

test("㉟ 反面：不是平台判定的 API、注释里的提及、逃生阀都不报", () => {
  // clipboard / share 是能力 API，不是"这台是什么平台"—— 扫它们就是造假红
  assert.deepEqual(findRawPlatformCheckInViewLayer(
    '<script>await navigator.clipboard.write(items); await navigator.share(d)</script>'), []);
  // 注释里解释"为什么不用 matchMedia("不能算作用点（㉝/㉜ 同一课）
  assert.deepEqual(findRawPlatformCheckInViewLayer(
    "<script setup>\n// 这里刻意不写 window.matchMedia( —— 走 utils/platform.ts\n</script>"), []);
  assert.deepEqual(findRawPlatformCheckInViewLayer(
    "<!-- platform-check-ok：这份组件确实要在渲染前自己问一次 -->\n<script>const q = window.matchMedia(s)</script>"), []);
});

test("㉟ 真实树：视图层一个裸写都没有，而正门确实在被用（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  // 只管**视图层**那两棵树：utils/stores 里做能力判定正是它该待的地方（那就是 common layer）。
  const files = collectVueFiles(srcDir).filter(
    (f) => f.includes("/components/") || f.includes("/views/"),
  );
  assert.ok(files.length >= 60, `视图层只数到 ${files.length} 份 .vue ⇒ 扫描目录大概错了`);
  const bad: string[] = [];
  let throughTheDoor = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (countCommonLayerPlatformImports(src) > 0) throughTheDoor += 1;
    // 消息一起带上：注入档（guard_cases）的 fail-hint 要能在失败输出里匹配到判据自己那句话，
    // 只推 "文件:行号" 会让红变成"定位到了但说不出守的是哪一格"。
    for (const i of findRawPlatformCheckInViewLayer(src)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${i.line} ${i.message.slice(0, 52)}`);
    }
  }
  assert.deepEqual(bad, [], `视图层又出现裸写的平台/能力探测：\n${bad.join("\n")}`);
  // 阳性对照：正门没人走 ⇒ 这条判据的"请走 common layer"就是空话
  assert.ok(throughTheDoor >= 5, `只有 ${throughTheDoor} 份组件走 common layer ⇒ 判据指向的那个家大概没人用，口径要重看`);
  console.log(`· N11 真实树分母：视图层 ${files.length} 份 .vue，${throughTheDoor} 份走 common layer，裸写平台判定 0 处`);
});

// ---------------- ㊱ 桌面弹窗必须让开自绘标题栏（窗口显示安全区） ----------------
//
// 真实缺陷：桌面窗口 `decorations(false)` + **流内**自绘 caption（TitleBar，Win 38px / macOS 28px），
// 而 BaseModal 经 portal 挂到 `<body>` 铺的是 `fixed inset-0` ⇒ 从视口 (0,0) 起算，
// 卡片顶部钻到 caption 底下：标题与右上角 ✕ 一起被压住。这条判据守的就是"外壳那一层要读变量"。

test("㊱ 形状：铺满视口的浮层外壳不读 window-safe-top ⇒ 报出来", () => {
  const buggy = `<template>
  <div class="fixed inset-0 overflow-y-auto">
    <div class="elevated my-auto max-h-[calc(100vh-2rem)]"><slot /></div>
  </div>
</template>`;
  const issues = findFixedOverlayWithoutWindowSafeTop(buggy);
  assert.equal(issues.length, 1, `这种"裸 inset-0 盖顶"必须报 1 条，现数 ${issues.length}`);
  assert.match(issues[0].message, /window-safe-top/);
  assert.ok(issues[0].line > 0, "要带行号");
});

test("㊱ 合规写法不报（分母要含合规形状，否则判据自己空转）", () => {
  const fixed = `<template>
  <div class="fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)] overflow-y-auto">
    <slot />
  </div>
</template>`;
  assert.deepEqual(findFixedOverlayWithoutWindowSafeTop(fixed), [],
    "拆成 inset-x-0 bottom-0 + top-[var(...)] 这条既有写法要算合规");
});

test("㊱ 反面：注释里的写法、非定位元素、逃生阀 —— 都不许报", () => {
  // ① 注释里写一句 `inset-0` 不算作用点（㉜/㉝/㉟ 同一课：注释能喂饱的判据不是判据）
  assert.deepEqual(findFixedOverlayWithoutWindowSafeTop(
    "<template>\n<!-- 这里刻意不用 fixed inset-0 -->\n<div class=\"flex\">x</div>\n</template>"), []);
  // ② 没定位的普通容器不在分母里
  assert.deepEqual(findFixedOverlayWithoutWindowSafeTop(
    `<template><div class="inset-0"><slot /></div></template>`), []);
  // ③ 逃生阀：确实要铺满的文件（纯遮罩层那种）
  assert.deepEqual(findFixedOverlayWithoutWindowSafeTop(
    `<!-- window-safe-ok -->\n<template><div class="fixed inset-0 bg-[var(--gosslan-overlay)]" /></template>`), []);
});

test("㊱ 真实树：BaseModal 的外壳层确实读了 window-safe-top，且安全区变量在 style.css 里定义完整（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const modal = readFileSync(join(srcDir, "components", "BaseModal.vue"), "utf8");
  // ⚠️ 一律只看 **class 属性**，不许拿整份文件当文本搜 —— 第一版就是这么写坏的：
  // `modal.includes("my-auto")` 被**注释里那句**「卡片形态垂直居中用 `my-auto`」喂饱，
  // 于是把 my-auto 真删掉、改回 items-center，判据照样绿（实测确认）。
  // 注释能喂饱的判据不是判据（㉜/㉝/㉟/㉞ 同一课）。
  // ⚠️ 而且必须同时收 `class="…"` 与 `:class="…"`：卡片形态那个居中行是**三元绑定**
  // （`fullscreen ? … : 'flex min-h-full justify-center p-4'`），只扫静态 class 会漏掉它
  // ⇒ 那一侧取到 undefined，断言在 `elevated` 另一支上静默通过（第二版就是这么又栽一次的）。
  const classes = [...modal.matchAll(/(?<!:)class="([^"]*)"/g)].map((m) => m[1]);
  const boundClasses = [...modal.matchAll(/:class="([^"]*)"/g)].map((m) => m[1]);
  const allClassText = [...classes, ...boundClasses];

  // 分母是"外壳那一层"：BaseModal 的遮罩与滚动层都必须让开（只让一个照样压顶）
  const safeHits = allClassText.filter((c) => /top-\[var\(--gosslan-(?:window-)?safe-top/.test(c)).length;
  assert.ok(safeHits >= 2,
    `BaseModal 的 class 属性里只数到 ${safeHits} 处读 window-safe-top，外壳那两层（遮罩 + 滚动层）都要让开`);

  // 卡片高度也要扣掉安全区，否则矮视口下 max-h 仍按屏幕高算，底部会被挤出可视区
  const cardCls = allClassText.find((c) => c.includes("elevated"));
  assert.ok(cardCls, "BaseModal 里必须有一个 .elevated 卡片元素");
  assert.ok(cardCls.includes("max-h-[calc(100vh-var(--gosslan-safe-top)"),
    "卡片 max-h 必须扣掉安全区：`calc(100vh - var(--gosslan-window-safe-top) - 2rem)`");

  // ⚠️ 不许改回 items-center（v4.37.0 教训：内容超高时顶部溢出到滚动容器之外，头部永远被遮挡）
  assert.ok(cardCls.includes("my-auto"),
    "卡片 class 里必须保留 my-auto —— 改回 items-center 会让超高内容的顶部溢出到滚动区之外");
  // 居中行那一支（卡片形态）：它必须只是 `justify-center`，**不许**带 items-center。
  // ⚠️ 这里判的是**垂直**方向（`items-*`）：水平居中本来就是 `justify-center`，
  // 与 `my-auto`（垂直）不是一回事 —— v4.37.0 的教训只针对垂直那半，别把水平的一起动了。
  // 那一行是三元绑定（`fullscreen ? 'flex min-h-full items-stretch justify-center' : 'flex min-h-full justify-center p-4'`），
  // 卡片那一支的判据是"含 min-h-full 且不含 items-stretch"（items-stretch 是整页形态，它铺满是对的）。
  const rowSrc = allClassText.find((c) => c.includes("min-h-full") && c.includes("justify-center"));
  assert.ok(rowSrc,
    "卡片形态的居中行（三元绑定里那一支 `'flex min-h-full justify-center p-4'`）必须在");
  const cardRow = rowSrc.split(":").map((s) => s.trim())
    .find((s) => s.includes("min-h-full") && !s.includes("items-stretch")) ?? rowSrc;
  assert.ok(!/\bitems-center\b/.test(cardRow),
    `卡片形态的居中行不许写成 items-center（v4.37.0 教训：内容高于视口时 flex 垂直居中会让顶部溢出到滚动容器之外）；`
    + `水平居中保持 justify-center 原样即可：${cardRow}`);

  // style.css 侧：两个变量的定义与判据都要在，且移动端必须归 0
  const css = readFileSync(join(srcDir, "style.css"), "utf8");
  assert.match(css, /--gosslan-window-safe-top:\s*0px/,
    "style.css 的 :root 里必须把 --gosslan-window-safe-top 定义成 0px（移动端为 0，这是零回归的根据）");
  // ⚠️ 2026-10-20 这条的键从 `html:not(.is-mobile)` 换成 `html.has-caption`（判据的**意图没变**：
  // 覆盖必须同时接住 macOS 与 Win/Linux，所以 `.platform-mac` 仍不许当键；变的是"什么叫有 caption" ——
  // 布局档会把窄起来的桌面辅助窗算成移动布局，而那类窗照样画 caption，于是让位被读成 0）。
  assert.match(css, /html\.has-caption\s*\{[^}]*--gosslan-window-safe-top:\s*var\(--gosslan-title-h\)/,
    "让位覆盖必须挂在 `html.has-caption`（有 caption 才让位）上；"
    + "不许退回 `html:not(.is-mobile)`（窄桌面辅助窗画着 caption 却被布局档判成没有），"
    + "也不许用 `.platform-mac` 当判据（Windows/Linux 会拿不到）");
  assert.ok(!/\.platform-mac\s*\{[^}]*--gosslan-window-safe-top/.test(css),
    "--gosslan-window-safe-top 又被挂到 .platform-mac 上：Win/Linux 的 caption 会拿不到让位");
  assert.match(css, /--gosslan-scroll-gutter:\s*\d+px/,
    "滚动条留白间距变量必须在中央变量区定义（BaseModal 的内容区读它）");

  // Reka 的 DialogContent 要求每个对话框都有可访问名称（DialogTitle）。整页形态允许不传 title，
  // 所以两条分支各要有一份 sr-only 兜底；删掉任何一份，读屏就只能报一个没有名字的对话框。
  const modalSrc = readFileSync(join(srcDir, "components", "BaseModal.vue"), "utf8");
  assert.match(modalSrc, /<DialogContent\b/, "BaseModal 必须由 Reka 的 DialogContent 承载");
  const fallbacks = [...modalSrc.matchAll(/<DialogTitle\s+v-if="!title"\s+class="sr-only"/g)].length;
  assert.equal(fallbacks, 2,
    "整页形态与卡片形态各需要一份 sr-only DialogTitle 兜底（无 title 时仍要有可访问名称）");
  console.log("· ㊱ 分母：BaseModal 外壳 " + safeHits + " 层读安全区变量 + 卡片 max-h 扣除 + my-auto 居中；"
    + "style.css 两个变量定义齐备");
});

/**
 * ㊱ 真实树扫描：**全 src 一个都不许漏**。
 *
 * ⚠️ 这一条是 2026-10-12 补的，它补的是一个真缺口：`findFixedOverlayWithoutWindowSafeTop`
 * 写出来之后**只跑了夹具、没有跑过真实树**，而夹具全绿完全掩盖了两件事：
 *  ① 分母太宽 —— 第一版把 `absolute inset-0`（行内点击层）与 `aria-hidden` 遮罩、
 *     `cursor-default` 点击捕手全算进来，真实树上报 **7 个文件**，逐格读完**只有 1 个是真的**；
 *  ② 那**唯一真的一个**（`ImageLightbox.vue` 主窗实例没让顶，右上角保存/关闭被 caption 压住）
 *     正是要靠这条扫描才会浮出来的 —— 因为它的夹具用例压根不存在。
 * ⇒ 教训与 ㉜/㉝/㉟ 同一条：**判据写完必须扫真实树**，否则它只是"一套自说自话的夹具"。
 * 分母纪律：`assert.equal(bad.length, 0)` 是结论，同时把**扫描分母**（扫了几份 .vue）
 * 打进日志 —— 分母为 0 时那条绿是假的（路径写错/glob 没匹配到都会这样）。
 */
test("㊱ 真实树：全 src 的 .vue 里没有一处「可见浮层裸 inset-0 盖顶」（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".vue")) files.push(p);
    }
  })(srcDir);

  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findFixedOverlayWithoutWindowSafeTop(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}`);
    }
  }
  // 分母自检：一份都没扫到说明路径/遍历坏了，那种绿不算数（㉜ 同一课）。
  assert.ok(files.length > 50, `只扫到 ${files.length} 份 .vue ⇒ 遍历路径大概错了，这条绿不算数`);
  assert.deepEqual(bad, [],
    `这些可见浮层铺满了视口顶部却没让开自绘 caption（桌面会压住标题与 ✕）：\n  ${bad.join("\n  ")}`);
  console.log(`· ㊱ 真实树分母：扫 ${files.length} 份 .vue，可见浮层盖顶 0 处`);
});

/**
 * ㊲ **BaseModal 的固定页脚必须留在滚动区之外**，且标题栏不许被 flex 压扁。
 *
 * 用户 2026-10-12 两条实测：
 *  ①「中间可滚动的区域应该不包含下面操作按钮那块」—— 调用方原先把操作按钮写在默认插槽
 *    的最后一项，它就跟着内容一起滚：长内容时用户得先滚到底才看得见「完成 / 编辑 / 删除」。
 *     ⇒ BaseModal 加了 `#footer` 插槽，`v-if="$slots.footer"` ⇒ 没传时不渲染任何东西。
 *  ②「窗口大时卡片完整，窗口一缩小头部就被缩上去一些」—— 卡片总高被 `max-h` 夹住时，
 *     flex 会压扁**没写 shrink-0 的那一层**（原标题 div），且表现为从上面被切掉一截。
 *
 * 三个断言分别钉：标题栏 shrink-0、滚动区 `min-h-0 flex-1`（唯一可压缩项）、footer 在滚动区之后。
 * 判据扣的是 class 串本身（不依赖格式化）：footer 的 class 串必须同时含 `mt-4` 与 `shrink-0`，
 * 且它在源码里出现的位置必须在滚动区那一行**之后**（顺序 = DOM 顺序）。
 */
test("㊲ BaseModal：标题栏不塌、页脚不滚走（用户实测两条）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "BaseModal.vue"), "utf8");

  // ① 标题栏必须 shrink-0（它现在是 `mb-4 flex shrink-0 items-start justify-between gap-3`）
  const titleCls = /class="([^"]*\bmb-4\b[^"]*)"/.exec(src)?.[1] ?? "";
  assert.ok(titleCls.includes("shrink-0"),
    `标题栏 class 必须含 shrink-0 —— 否则 max-h 夹住卡片时 flex 会把它压扁，`
    + `表现为「窗口一缩小头部就被缩上去一些」。当前：${titleCls}`);

  // ② 滚动区必须是唯一可压缩项（min-h-0 + flex-1 成对，缺一就可能被下方内容顶出可视区）
  //    ⚠️ 文件里有**两个** overflow-y-auto：外层那个铺满视口的滚动容器（fixed inset-x-0），
  //    和卡片内部真正滚内容的那一层。判据要认准后者 —— 它带 min-h-0 + flex-1。
  const scroller = /class="([^"]*\bmin-h-0 flex-1\b[^"]*overflow-y-auto[^"]*)"/.exec(src)?.[1] ?? "";
  assert.ok(scroller.includes("min-h-0") && scroller.includes("flex-1"),
    `滚动区必须写 \`min-h-0 flex-1\`（唯一可压缩项）。当前：${scroller}`);
  // ②b 留白与负右边距**成对**（用户那句「左右边距看着左小右大」修的就是这一对）：
  //    只留 `pr-[…]` 而不把同样宽度从右边距里让回来 ⇒ 右侧多出一整截净空隙。
  //    ⚠️ 为什么源码层也要钉一条：真正"算出来对称"的判据在运行时探针（`--only=winsafe`，
  //    还带一条撤掉就变红的反面对照），而**那一层 CI 不跑**。这里这条不证对称，
  //    只证"这一对没被单边删掉" —— 顺序不敏感（两条各自 in 判断，不拼成一条正则）。
  const GUT = "var(--gosslan-scroll-gutter)";
  assert.ok(
    scroller.includes(`pr-[${GUT}]`) && scroller.includes(`-mr-[${GUT}]`),
    `滚动区的留白与负右边距必须成对（pr-[…] 与 -mr-[…] 在同一条 class 上）—— ` +
      `只留 pr 就是右侧比左侧多出一截，正是用户报的那条。当前：${scroller}`,
  );

  // ③ footer 插槽：DOM 顺序必须在滚动区之后，且自身 shrink-0（不被上面的内容区挤掉）
  const footerSlot = /<slot\s+name="footer"\s*\/>/.exec(src);
  assert.ok(footerSlot, "BaseModal 必须提供 `#footer` 插槽（v-if=\"$slots.footer\"）");
  const scrollIdx = src.indexOf('overflow-y-auto');
  const footerIdx = footerSlot ? src.indexOf('<slot name="footer"') : -1;
  assert.ok(footerIdx > scrollIdx,
    `#footer 必须在滚动区之后 —— 顺序即 DOM 顺序，写前面就又被内容区顶出去了\n`
    + `  scrollIdx=${scrollIdx} footerIdx=${footerIdx}`);
  // footer 外壳那层也要 shrink-0 + mt-4（与标题栏 mb-4 对称）
  const footerWrap = /v-if="\$slots\.footer"[\s\S]{0,400}?class="([^"]*)"/.exec(src)?.[1] ?? "";
  assert.ok(footerWrap.includes("shrink-0"),
    `footer 外壳必须 shrink-0（否则滚动区会把按钮区挤没）。当前：${footerWrap}`);
  assert.ok(footerWrap.includes("mt-4"),
    `footer 外壳必须与标题栏的 mb-4 对称（间距一致）。当前：${footerWrap}`);
  // 页脚绝不能自己变成滚动容器（否则它又跟着内容滚了）
  assert.ok(!footerWrap.includes("overflow-"),
    `footer 外壳不许带滚动（它就得钉在卡片底部）。当前：${footerWrap}`);

  console.log("· ㊲ 分母：BaseModal 标题栏 shrink-0 + 滚动区 min-h-0/flex-1 + #footer 在其后且 shrink-0/mt-4");
});

/**
 * ㊲ **群任务卡片：点图片周围那一圈必须展开任务面板**（三个命中区互不重叠）。
 *
 * 用户 2026-10-12 实测：「点图片能展示大图（正常），但点图片周围区域应该展开任务列表，
 * 当前没反应」。根因：图片带容器上挂着 `@click.stop`，一 stop 就把整条图片带
 * （缩略图之间的空隙、右侧留白、`px-3` 内边距）全部挡在命中区①之外。
 *
 * 正确形状（这条守卫钉的就是它，**两半都在**）：
 *  - 图片带容器：**只有 keydown 带 `.stop`**（Enter/Space 两键都要），click 放行；
 *  - 缩略图自己拦：`TodoImageThumb.open()` 在可点那一支调 `e.stopPropagation()` ⇒
 *    点图片只开预览。⚠️ 容器一放行 click，这一半就是**必需**的：卡片主体本身也是
 *    `role=button` 并挂着 `@click="openPanel"`，缩略图再不拦，点图片就变成
 *    「预览和面板一起开」（2026-10-13 实测：探针那条"点卡片图片只开预览"当场红）。
 *  - 命中区①卡片主体 `@click="openPanel"`、命中区②底部按钮 `@click="emit('open', todoId)"`。
 *
 * ⚠️ 为什么 keydown 还要 stop：缩略图的键盘处理不合成 click（走不到主体的 keydown），
 * 容器若放行 keydown，在缩略图上按回车就变成「又开预览又开面板」。
 * 别看到 `@keydown.enter.stop` 就顺手给容器补一个 `@click.stop`。
 */
test("㊲ 群任务卡片：图片带容器不许 stop 冒泡（点图片周围要能展开面板）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "TodoCardBubble.vue"), "utf8");

  // 图片带容器：keydown 两键都要 stop，click 一行都不许有
  const imgRow = /v-if="cardImages\.length"[\s\S]{0,300}?@keydown\.enter\.stop\s+@keydown\.space\.stop/.exec(src);
  assert.ok(imgRow, "图片带容器必须保留 Enter/Space 两个 keydown.stop（否则缩略图上按回车会又开预览又开面板）");
  // 容器那一整条元素（从 <div 到闭合 >）里不许出现任何 @click 绑定。
  // ⚠️ 判据必须覆盖**整个元素**、不能只看到 keydown 之前 —— 第一版就是只查 keydown 之前的
  // 切片，结果"把 @click.stop 补在 keydown 后面"这个变异大摇大摆放行了（自证时抓到，此处修）。
  const divOpen = src.indexOf("<div", src.indexOf('v-if="cardImages.length"') - 200);
  const divEnd = src.indexOf(">", src.indexOf('v-if="cardImages.length"'));
  const containerTag = src.slice(divOpen, divEnd);
  assert.ok(!/@click/.test(containerTag),
    `图片带容器不许再挂 @click.stop —— 一 stop，点图片周围（空隙/内边距/右侧留白）`
    + `就再也不会展开面板。容器标签：\n${containerTag}`);
  // 缩略图必须带 clickable（默认 false，漏给 = 图渲染了但点不动，编译/类型/单测全绿）
  assert.ok(/<TodoImageThumb[\s\S]{0,200}?\bclickable\b/.test(src),
    "TodoImageThumb 必须显式给 clickable —— 该 prop 默认 false，漏了表现为「图在、点不动」");

  // ⚠️ 成对的另一半（容器放行 click 之后才成立的那一条）：必须由**缩略图自己**拦住这次交互。
  //   漏了它，点图片就同时触发卡片主体（它也挂着 @click="openPanel"）⇒ 预览和面板一起开，
  //   而"图片周围要能展开面板"这条需求本身没变 —— 所以两半必须同时钉，缺一半就是另一回事坏了。
  //   判据读**去掉注释**的那一份并按花括号切出函数体：注释里写着 stopPropagation 不算数，
  //   定长窗口还可能跨进邻规则（本仓在形状守卫上栽过的两种假绿）。
  const thumbSrc = readFileSync(join(import.meta.dirname, "..", "components", "TodoImageThumb.vue"), "utf8");
  const thumbCode = thumbSrc
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, " "));
  const openBody = /function open\(e: Event\) \{([\s\S]*?)\n\}/.exec(thumbCode)?.[1] ?? "";
  const stopIdx = openBody.indexOf("e.stopPropagation();");
  const emitIdx = openBody.indexOf('emit("open");');
  assert.ok(openBody.length > 0, "找不到 TodoImageThumb.open 的函数体 —— 形状变了，这条判据得同步改");
  assert.ok(
    openBody.includes("if (!props.clickable) return;"),
    "TodoImageThumb.open 必须先判 clickable：不可点的缩略图没消费这次交互，不该吞掉冒泡",
  );
  assert.ok(
    stopIdx >= 0 && emitIdx > stopIdx,
    "TodoImageThumb.open 必须在 emit open **之前**调 e.stopPropagation() —— " +
      "容器已放行 click，这里再不拦，点图片就会「又开预览又开面板」",
  );

  // 三个命中区的接线必须在（主体→open-panel / 底部→open(todoId) / 图→preview）
  assert.ok(/@click="openPanel"/.test(src), "命中区①（卡片主体）必须接 openPanel");
  assert.ok(/@click="emit\('open', todoId\)"/.test(src), "命中区②（底部操作条）必须 emit open(todoId)");
  assert.ok(/@open="openCardImage\(i\)"/.test(src), "命中区③（缩略图）必须接 openCardImage");
  // openPanel 必须放过真链接（描述里的 <a> 不能顺手把面板弹出来）
  assert.ok(/function openPanel\(e: MouseEvent\) \{[\s\S]{0,200}?closest\("a"\)/.test(src),
    "openPanel 必须跳过 closest(\"a\") —— 点描述里的链接只该打开外部，不该弹面板");

  console.log("· ㊲ 分母：TodoCardBubble 图片带容器 keydown.stop×2 + click 放行 + clickable + 三命中区接线 + openPanel 放过 <a；缩略图自己 stopPropagation（先判 clickable、拦在 emit 之前）");
});


/**
 * ㊳ **任务卡片可见图片数：一个常量、两个消费点**（用户 2026-10-12：图片超过 4 张应显示「查看更多」）。
 *
 * 为什么这条值得由机器盯：这个数同时决定「卡片画几张」与「估算端按几行算高」，
 * 而两处失步都不报错、构建也过 —— 界面只是开始遮挡（本仓顶部契约明写的已发生事故类型）。
 * 所以常量住在 `utils/todos.ts`，这条守卫只认一种写法：模板引用 `visibleTodoImages()` 的结果，
 * 估算端引用 `TODO_CARD_IMAGE_VISIBLE`。
 *
 * ⚠️ 自证纪律：三个变异（改上限两边只改一边、模板裸写 `slice(0,4)`、删「查看更多」按钮）
 * 逐一验证过都能精确变红，源码随后还原并 diff 校验。
 */
test("㊳ 任务卡片：可见图片数一个家，估算端同行高（否则虚拟列表遮挡）", () => {
  const bubble = readFileSync(join(import.meta.dirname, "..", "components", "TodoCardBubble.vue"), "utf8");
  const estimator = readFileSync(join(import.meta.dirname, "messageHeight.ts"), "utf8");

  const issues = checkTodoCardImageLimit(bubble, estimator);
  assert.equal(issues.length, 0, issues.map((i) => `L${i.line}: ${i.message}`).join("\n"));

  // 阳性对照：共享常量与被引函数必须真的存在于 todos.ts（否则上面 0 条是"尺子没有分母"）
  const todos = readFileSync(join(import.meta.dirname, "todos.ts"), "utf8");
  assert.ok(/export const TODO_CARD_IMAGE_VISIBLE = \d+/.test(todos),
    "todos.ts 必须定义 TODO_CARD_IMAGE_VISIBLE（这条守卫的正门）");
  assert.ok(/export function visibleTodoImages</.test(todos),
    "todos.ts 必须定义 visibleTodoImages（卡片与估算端唯一入口）");
  assert.ok(/\bfrom "@\/utils\/todos"/.test(bubble),
    "TodoCardBubble 必须从 @/utils/todos 引（组件侧引用点）");

  // 上限值本身就是被钉住的那一个数（用户原话"超过 4 张"）
  const visible = Number(/TODO_CARD_IMAGE_VISIBLE = (\d+)/.exec(todos)?.[1]);
  assert.equal(visible, 4, `可见图片数必须是 4（用户 2026-10-12 原话"超过 4 张"）。当前：${visible}`);

  console.log("· ㊳ 分母：TodoCardBubble 走 visibleTodoImages + 「查看更多」emit open(todoId) + i18n key + 相册不截断；messageHeight 引 TODO_CARD_IMAGE_VISIBLE");
});

// ---------------- ㊴ 字面圆角必须走 token ----------------

test("㊴ 字面圆角 → 报；token / full / none / 注释 → 放行（夹具）", () => {
  const buggy = `<template><div class="rounded-lg p-2"></div><button class="rounded-[6px]"></button></template>`;
  const issues = findLiteralRadiusClasses(buggy);
  assert.equal(issues.length, 2, issues.map((i) => i.message).join("\n"));
  assert.equal(issues[0].line, 1, "应定位到那一行");

  const ok = `<template><div class="rounded-[var(--gosslan-radius-md)]"></div><span class="rounded-full"></span><em class="rounded-none"></em></template>`;
  assert.deepEqual(findLiteralRadiusClasses(ok), []);

  // 规范明确保留的三个语义别名不能被当成字面值（2026-10-18 首跑真实假阳性）
  const aliases = `<template><div class="rounded-[var(--gosslan-avatar-radius)]"></div><div class="rounded-[var(--gosslan-item-radius)]"></div><div class="rounded-[var(--gosslan-bubble-radius)]"></div></template>`;
  assert.deepEqual(findLiteralRadiusClasses(aliases), []);

  const commented = `<template><!-- <div class="rounded-lg"> --><div class="rounded-[var(--gosslan-radius-sm)]"></div></template>`;
  assert.deepEqual(findLiteralRadiusClasses(commented), []);
});

test("㊴ 真实树：全 src 的 .vue 没有字面圆角（分母现算）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 50, `只扫到 ${files.length} 份 .vue ⇒ 遍历路径大概错了，这条绿不算数`);
  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findLiteralRadiusClasses(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下位置写了字面圆角：\n${bad.join("\n")}`);
  console.log(`· ㊴ 分母：扫 ${files.length} 份 .vue，字面圆角 0 处`);
});

// ---------------- ㊵ 高频语义图标只从 ui/icons.ts 引 ----------------

/**
 * 分母**从入口自己解析**，不在测试里手抄名单。
 *
 * 真实教训：入口 `ui/icons.ts` 导出 7 个名字，而这里原先手抄了 5 个 ——
 * `ImageOff`/`AlertCircle` 从此不在网内，`MessageItem.vue` 与 `MessageImageBubble.vue`
 * 两处直连 `lucide-vue-next` 的 `ImageOff` 一直漏报，而判据照旧打「直连 0 处」。
 * 手抄清单每加一个入口名字都要记得回来补，这条迟早再漂一次。
 */
const ICON_BARREL_PATH = join(import.meta.dirname, "..", "components", "ui", "icons.ts");
const SEMANTIC_ICON_NAMES = (
  readFileSync(ICON_BARREL_PATH, "utf8").match(/export \{([^}]+)\} from "lucide-vue-next"/)?.[1] ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 非空转下限：入口一旦被清空，上面的解析会得到空数组 ⇒ "全库 0 处违规"会假绿。
assert.ok(
  SEMANTIC_ICON_NAMES.length >= 5,
  `只从 ui/icons.ts 解析出 ${SEMANTIC_ICON_NAMES.length} 个名字 ⇒ 分母塌了，这条判据不再成立`,
);

test("㊵ 高频语义图标直连 lucide → 报；走入口 → 放行（夹具）", () => {
  const buggy = `<script setup lang="ts">\nimport { Loader2, X } from "lucide-vue-next";\n</script>`;
  assert.equal(findDirectSemanticIconImports(buggy, SEMANTIC_ICON_NAMES).length, 2);
  const swallowed = `<script setup lang="ts">\nimport { computed, ref } from "vue";\nimport { api } from "@/api";\nimport { Loader2, RotateCw } from "lucide-vue-next";\n</script>`;
  assert.equal(
    findDirectSemanticIconImports(swallowed, SEMANTIC_ICON_NAMES).length,
    1,
    "跨多条 import 也必须逐条匹配（旧正则把前面的 import 吞进来 ⇒ 直连 Loader2 漏报）",
  );

  const ok = `<script setup lang="ts">\nimport { Loader2, X } from "@/components/ui/icons";\n</script>`;
  assert.deepEqual(findDirectSemanticIconImports(ok, SEMANTIC_ICON_NAMES), []);

  const escaped = `<!-- icon-entry-ok -->\n<script setup lang="ts">\nimport { X } from "lucide-vue-next";\n</script>`;
  assert.deepEqual(findDirectSemanticIconImports(escaped, SEMANTIC_ICON_NAMES), []);
});

test("㊵ 真实树：5 个高频语义图标只从 ui/icons.ts 引（分母现算）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        (entry.name.endsWith(".vue") || entry.name.endsWith(".ts")) &&
        !entry.name.endsWith(".test.ts") &&
        full !== join(srcDir, "components", "ui", "icons.ts")
      ) {
        files.push(full);
      }
    }
  })(srcDir);
  assert.ok(files.length > 100, `只扫到 ${files.length} 份源码 ⇒ 遍历路径大概错了，这条绿不算数`);

  const bad: string[] = [];
  for (const f of files) {
    for (const issue of findDirectSemanticIconImports(readFileSync(f, "utf8"), SEMANTIC_ICON_NAMES)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下位置仍直连 lucide：\n${bad.join("\n")}`);

  // 阳性对照：入口必须真的导出这 5 个名字（否则"全库 0 处"只是没人可引）
  const barrel = readFileSync(join(srcDir, "components", "ui", "icons.ts"), "utf8");
  for (const name of SEMANTIC_ICON_NAMES) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(barrel), `ui/icons.ts 必须导出 ${name}`);
  }
  console.log(`· ㊵ 分母：扫 ${files.length} 份源码，高频语义图标直连 lucide 0 处`);
});

// ---------------- 取消键只走 SecondaryBtn（2026-10-28 动作按钮收口） ----------------

test("取消键：手写 → 报；SecondaryBtn / 整宽行 → 放行（夹具）", () => {
  const buggy = `<template><button class="rounded-[var(--gosslan-radius-md)] px-4 py-1.5 text-sm">{{ t("common.cancel") }}</button></template>`;
  assert.equal(findHandWrittenCancelButtons(buggy).length, 1, "手写取消键必须被抓到");

  const ok = `<template><SecondaryBtn>{{ t("common.cancel") }}</SecondaryBtn></template>`;
  assert.deepEqual(findHandWrittenCancelButtons(ok), [], "组件用法不该被当成手写");

  const sheet = `<template><button class="w-full px-4 py-3">{{ t("common.cancel") }}</button></template>`;
  assert.deepEqual(findHandWrittenCancelButtons(sheet), [], "ActionSheet 的整宽行不是对话框动作键");

  const other = `<template><button class="px-3">别的文案</button></template>`;
  assert.deepEqual(findHandWrittenCancelButtons(other), [], "不含取消文案的按钮不归这条管");
});

test("取消键：真实树只剩 SecondaryBtn（分母现算）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 50, `只扫到 ${files.length} 份 .vue ⇒ 遍历路径大概错了，这条绿不算数`);

  const bad: string[] = [];
  for (const f of files) {
    const rel = f.replace(srcDir + "/", "");
    if (rel.startsWith("components/ui/")) continue; // 组件自身与 ActionSheet 的 slot 文案
    for (const issue of findHandWrittenCancelButtons(readFileSync(f, "utf8"))) {
      bad.push(`${rel}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下位置仍在手写取消按钮：\n${bad.join("\n")}`);
  console.log(`· 取消键分母：扫 ${files.length} 份 .vue（排除 components/ui/），手写取消按钮 0 处`);
});

test("共享按钮：flex 居中 + 四档尺寸齐全", () => {
  for (const name of ["PrimaryBtn", "DangerBtn", "SecondaryBtn"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "components", "ui", `${name}.vue`), "utf8");
    assert.deepEqual(sharedButtonChromeIssues(name, src), [], `${name} 的盒模型/尺寸档不齐`);
  }
  // 共享按钮的消费方：ConfirmDialog 的取消键必须是 SecondaryBtn（这条链就是用户报的那一格）
  const dialog = readFileSync(join(import.meta.dirname, "..", "components", "ui", "ConfirmDialog.vue"), "utf8");
  assert.ok(dialog.includes("<SecondaryBtn"), "ConfirmDialog 的取消键必须用 SecondaryBtn");
});

// ---------------- ㊶ 实底危险按钮只走 DangerBtn ----------------

test("㊶ 手写实底危险按钮 → 报；DangerBtn / 圆形徽标 / hover-only → 放行（夹具）", () => {
  const buggy = `<template><button class="rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger)] px-4 py-2 text-sm text-white">删</button></template>`;
  assert.equal(findHandWrittenSolidDangerButtons(buggy).length, 1);

  const opacityBug = `<template><button class="bg-[var(--gosslan-danger)] hover:opacity-90">删</button></template>`;
  assert.equal(findHandWrittenSolidDangerButtons(opacityBug).length, 1, "hover:opacity-90 的旧写法也必须被抓到");

  const ok = `<template><DangerBtn size="large">删</DangerBtn><button class="rounded-full bg-[var(--gosslan-danger)] h-4 w-4">x</button><button class="hover:bg-[var(--gosslan-danger)]">x</button></template>`;
  assert.deepEqual(findHandWrittenSolidDangerButtons(ok), []);
});

test("㊶ 真实树：实底危险按钮只剩 DangerBtn（分母现算）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 50, `只扫到 ${files.length} 份 .vue ⇒ 遍历路径大概错了，这条绿不算数`);

  const bad: string[] = [];
  for (const f of files) {
    if (f.endsWith("components/ui/DangerBtn.vue")) continue;
    for (const issue of findHandWrittenSolidDangerButtons(readFileSync(f, "utf8"))) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
  }
  assert.deepEqual(bad, [], `以下位置仍在手写实底危险按钮：\n${bad.join("\n")}`);
  console.log(`· ㊶ 分母：扫 ${files.length} 份 .vue（排除 DangerBtn 自身），手写实底危险按钮 0 处`);
});

test("通讯录空态必须有专属文案与可执行动作（不能复用聊天空态的『发起聊天』）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(src, /layout\.selectContact/, "通讯录空态没有专属标题");
  assert.match(src, /layout\.contactHint/, "通讯录空态没有专属说明");
  const at = src.indexOf("layout.selectContact");
  assert.ok(at > 0, "专属标题锚点不在 ⇒ 判据失去目标");
  const end = src.indexOf("</template>", at);
  assert.ok(end > at, "通讯录空态分支没有正常闭合");
  const block = src.slice(at, end);
  assert.match(block, /addFriendOpen = true/, "通讯录空态的主按钮必须真的能打开『添加好友』");
  assert.doesNotMatch(block, /navState = 'contacts'/, "通讯录页再把 navState 赋成 contacts 等于点了没反应");
});

test("收藏页 active 必须先于 useBackLayer 声明（immediate watch 在 setup 里同步求值）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "FavoritePanel.vue"), "utf8");
  const decl = src.indexOf("const active = ref<FavoriteEntry | null>(null)");
  const hook = src.indexOf("useBackLayer(");
  assert.ok(decl > 0 && hook > 0, "锚点缺失：收藏页的 active 声明或 useBackLayer 调用被改名");
  assert.ok(decl < hook,
    "useBackLayer 用 immediate watch 在 setup 里同步读 active；声明在后会在移动端 TDZ 崩溃");
});

test("浮层与导航同帧时：弹窗必须在路由落地之后才关（同 URL 条目会撤销刚推进的页面）", () => {
  // 机制（用户 2026-10-23「点发起聊天应该就是直接进入聊天窗口，而不是关掉」）：
  // 弹窗那层 `useBackLayer` 释放时会 `history.back()` 退掉自己压的**同 URL**条目。
  // Vue 的 watcher 跑在微任务里、早于 vue-router 写历史条目 ⇒ "先关弹窗再跳转"时
  // 那次 back() 排在推送之后执行，把刚进去的聊天页原路退了回来。真浏览器实测：
  // 旧顺序停在 /contacts，新顺序进 /chats/<peer> 且输入框在场；返回键再回 /contacts。
  const rl = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  const sig = "async function openChatFromFriend";
  const at = rl.indexOf(sig);
  const end = rl.indexOf("\n}", at);
  assert.ok(at > 0 && end > at, "锚点缺失：发起聊天的处理函数被改名或没正常闭合");
  const body = rl.slice(at, end);
  const pushAt = body.indexOf("await router.push(");
  const closeAt = body.indexOf("addFriendOpen.value = false");
  assert.ok(pushAt > 0, "必须 await 导航（不 await 就是旧顺序）");
  assert.ok(closeAt > 0, "弹窗仍要在这一帧里关掉");
  assert.ok(pushAt < closeAt, "导航必须排在关弹窗之前，否则同 URL 条目会把聊天页退掉");
  assert.match(body, /finally\s*\{[\s\S]{0,120}addFriendOpen\.value = false/,
    "关弹窗必须在 finally 里：导航被守卫挡掉时不许把弹窗卡成永远关不上");
  assert.doesNotMatch(body, /void router\.push\(/, "退回 fire-and-forget 的 push 就是重新引入这个缺陷");

  // 端口的两条腿也要在：拒绝回退要如实回报，纯逻辑必须按回报决定要不要减计数/预吃 pop
  // （否则用户下一次真按返回键会被静默吞掉）；而且判据要**按层**拿 URL —— 只记最后一次压入
  // 会让"弹窗套弹窗 + 中间导航过"的第二层拿不到判据。
  const hook = readFileSync(
    join(import.meta.dirname, "..", "composables", "useBackLayer.ts"), "utf8");
  assert.match(hook, /back\(layerId: number\): boolean/, "端口必须回报 back() 到底退没退，且知道退的是哪一层");
  assert.match(hook, /pushedHref\.set\(id, location\.href\)/, "压入成功时必须按层记下落点 URL");
  assert.match(hook, /pushedHref\.get\(layerId\)/, "回退时必须按那一层的 URL 判");
  assert.match(hook, /location\.href !== href/, "必须有「压入之后导航过 ⇒ 条目留下」的判据");
  const pure = readFileSync(join(import.meta.dirname, "..", "utils", "backStack.ts"), "utf8");
  assert.match(pure, /if \(port\.back\(id\)\) \{/, "释放必须带着层 id 按端口回报分支");
  assert.doesNotMatch(pure, /pushed--;\s*\n\s*ignoreNextPop = true;\s*\n\s*port\.back\(\);/,
    "不许退回「无条件退条目」的老形状（减计数与预吃 pop 都必须以真的退了为前提）");
});

/**
 * 聊天输入框粘贴大段文字必须**一次插入**（用户 2026-10-23：粘进去会卡一下才显示）。
 *
 * 为什么源码这一半也要钉：真正的量具是运行时探针 `--only=pasteframe`（数 input 次数与子元素数），
 * 而那层 CI 不跑 —— 把粘贴退回 `document.execCommand("insertText")` 不报错、不影响构建，
 * 只有人手粘一段长文才会撞上。这里钉的是"退回旧写法必红"的三件事：
 * ① 粘贴走 `insertPastedText`；② 原生 `execCommand("insertText")` 只剩**兜底那一处**
 * （拿不到 caret/range 时才用），不许回到主路径；③ 手动插入不进原生 undo 栈，
 * 所以撤销必须由 `restorePasteUndo` 接上，且回灌要走白名单（不许裸 innerHTML 回灌）。
 */
test("粘贴长文本：一次插入 + 撤销自己接住，不许退回逐行 execCommand", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "chat", "MessageComposer.vue"), "utf8");
  // 计数一律先剥注释：这个文件的说明里就写着 `document.execCommand("insertText")` 这个名字
  // （为什么不用它是本次修复的核心），不剥就会把注释数进"代码里有几处"里，判据永远多两格。
  const code = stripCommentsJs(src);
  const call = "insertPastedText(text.slice(0, room))";
  assert.equal(code.split(call).length - 1, 1, "粘贴主路径必须是 insertPastedText（且只有一处调用）");
  assert.match(src, /if \(!insertPastedText\(text\.slice\(0, room\)\)\) \{/,
    "兜底分支的写法变了 ⇒ 下面那条「只剩一处」的计数失去意义");

  const execAt = (needle: string) => {
    const hits: number[] = [];
    for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + 1)) hits.push(i);
    return hits;
  };
  const inserts = execAt('document.execCommand("insertText"');
  assert.equal(inserts.length, 1, "原生 insertText 只允许出现在兜底那一处");
  const head = code.slice(Math.max(0, inserts[0] - 220), inserts[0]);
  assert.ok(head.includes("if (!insertPastedText("),
    "那一处原生 insertText 必须在 insertPastedText 失败的兜底分支里（回到主路径就是重新引入卡顿）");

  const undoCalls = execAt("restorePasteUndo()");
  assert.equal(undoCalls.length, 2, "定义 1 处 + onKeydown 里接住 ⌘/Ctrl+Z 1 处");
  assert.match(src, /pasteUndo = \{ html: before, chars:/,
    "粘贴前必须留快照（手动插入不进原生 undo 栈）");
  assert.match(src, /el\.innerHTML = sanitizeDraftHtml\(snap\.html\)/,
    "撤销回灌必须走那张白名单，不许裸回灌 innerHTML");
});

test("字体默认档不得用空串 option value（Reka SelectItem 不渲染空串）", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "settings", "AppearanceSection.vue"), "utf8");
  const at = src.indexOf("const fonts = [");
  const end = src.indexOf("];", at);
  assert.ok(at > 0 && end > at, "锚点缺失：字体选项表被改名");
  const fonts = src.slice(at, end);
  assert.doesNotMatch(fonts, /value:\s*""/,
    "空串 option value 会被 Reka 吞掉 ⇒ 菜单少掉「系统默认」且触发器空白");
  assert.match(fonts, /value:\s*SYSTEM_FONT/, "默认档必须用非空哨兵");
  assert.match(src, /app\.fontFamily === "" \? SYSTEM_FONT/,
    "存储值到哨兵的映射必须存在（否则默认档匹配不到）");
  assert.match(src, /value === SYSTEM_FONT \? "" : value/,
    "落库前必须把哨兵映射回空串（不许把哨兵写进设置）");
});

test("文件角标只有一处实现：组件里不许裸用 fileExt( 自己拼", () => {
  // 真实缺陷：收藏详情那处 `fileExt(name).toUpperCase()` 既不截断也不兜底，
  // 没有扩展名的文件在那里渲染成空串 + 一个孤零零的「 · 大小」。
  const dir = join(import.meta.dirname, "..", "components");
  const hits: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".vue") && readFileSync(p, "utf8").includes("fileExt(")) hits.push(p);
    }
  })(dir);
  assert.equal(
    hits.length,
    0,
    `扩展名角标必须走 utils/fileKind.ts 的 extBadgeLabel（无扩展名兜底、超长截断只有一份）：${hits.join(", ")}`,
  );
});

test("catch 里的错误提示必须走 toastError：不许把 String(e) 直接甩给用户", () => {
  // `app.toast(String(e), "error")` 有两处损失：用户看到 `Error: [object Object]` 这类原始串，
  // 而且**不进日志**（toastError 那半句日志在 composables/useErrorText 的 `{ log: true }`）。GroupTasksBoard 同一文件里
  // 8 处 catch 有 4 处走了这条路 —— 同一条 updateTodo 失败，两种表现。
  const dir = join(import.meta.dirname, "..");
  const hits: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(vue|ts)$/.test(e.name) || e.name.endsWith(".test.ts")) continue;
      if (readFileSync(p, "utf8").includes("toast(String(e)")) hits.push(p);
    }
  })(dir);
  assert.equal(hits.length, 0, `错误出口必须统一走 app.toastError(e, 前缀)：${hits.join(", ")}`);
});

/**
 * 组件里挂 DOM 监听必须有解绑路径。
 *
 * 真实缺陷形状（`App.vue` 原来那四条就是这一族）：`onMounted` 里写
 * `window.addEventListener("contextmenu", (e) => { … })` —— 处理器是**字面量**，
 * 没有句柄能交给 `removeEventListener`，于是这条监听永远摘不掉；组件重挂一次
 * （HMR、分支切换）就多一份，而每一份闭包绑的是**上一轮**的 state。
 * 这类失败不响亮：界面照常用，只有重复 IPC / 重复回调会偶发冒出来。
 *
 * 两条形状判据，分母现扫、不写死文件名：
 *  ① `.vue` 里不许出现"内联函数当处理器"的注册（结构上就摘不掉）；
 *  ② `.vue` 里手写的 `addEventListener("e", h)` 必须能在同文件配上同 `(事件, 处理器)`
 *     的 `removeEventListener` —— 整文件改用 `useEventListener`（VueUse，按组件作用域
 *     自动解绑）的算合规。
 */
/**
 * 取代关系（§6.72 记档，不是放宽）：这里原来有一条「组件里的 DOM 监听必须有解绑路径
 * （不许内联处理器、手写注册要配对 remove）」，它只扫 `.vue`、只比"有没有同 (事件,处理器) 的 remove"，
 * 分母是一条硬编码 `registered >= 15`。㊽ 在同一根轴上是它的**超集**：
 *  · 扫 `.vue` **和** `.ts`（store / boot / composable 里手写的绑定过去完全没人管）；
 *  · 内联匿名处理器同样点名（= 原来那条"不许内联"），但一次性接线文件走带理由的名单，
 *    名单本身还有"今天必须还在绑定"的正控；
 *  · 多一条 capture 旗标**逐侧**一致（原那条看不见"解绑是空操作"这一形，§6.71 实测）。
 * 原那条被 §6.72 的迁移打到下限（`.vue` 侧手写注册从 14 掉到 10）——**这正是两个量具管同一根轴的下场**：
 * 谁迁移一次就得改两处数字。删掉它、只留 ㊽，分母与反控都在 ㊽ 里各一条。
 */

/**
 * Tauri 订阅的卸载句柄只能交给 `utils/initScope`，不许再手写第三份。
 *
 * 真实缺陷形状（本仓实测存在过）：`onMounted` 里 `unlistenX = await w.onFocusChanged(...)`，
 * `onBeforeUnmount` 里 `unlistenX?.()` —— 拿卸载函数要等一次 IPC 往返，**这段时间里组件已经卸载**
 * 的话，赋值发生在清理之后，那个函数永远没人调用 ⇒ 监听留在窗口上，之后每次事件都跑一份
 * 绑着已丢弃 state 的闭包（`ChatWindow` 的 `boardDropActive` 那一型还会直接改变拖放归属判定）。
 * 这类失败不响亮：界面照常，只有偶发的重复回调/错误的拖放判定会冒出来 ⇒ 值得钉。
 *
 * `initScope.onDispose` 已经把这个竞态解决在一处（拆过之后的注册就地执行），
 * 所以这里只拦"又手写一份"的两种形状：① 手工卸载句柄；② 手工 `if (disposed) fn()` 迟到守卫。
 * 分母现扫，两条 matcher 各带已知形状做正控。
 *
 * ⚠️ 第 ① 条原来只认 `let unlistenX: (() => void) | null` 一种写法，于是漏掉两类**真存在过**的
 * 兄弟形状（§6.60 实测）：句柄名不叫 `unlisten*`（`let disposeFocusSearch`），以及**一批句柄存成数组**
 * （`let unlistenMenu: UnlistenFn[] | null` + `.then((fns) => (unlistenMenu = fns))` —— 后者正是上面
 * 那段说的"迟到的注册"，只是它迟到的是 4 个句柄）。⇒ 判据按**类型形状**认句柄而不是按变量名认：
 * `let X: UnlistenFn / UnlistenFn[] / Array<UnlistenFn> / (() => void) / (() => void)[]`。
 * 名字前缀是写代码的人随手起的，把判据钉在它上面等于判据只覆盖碰巧起对名字的那几处。
 */
test("㊷ 订阅↔卸载（Tauri listen 与 mitt onAction）必须走 initScope（不许手工句柄、不许手写迟到守卫）", () => {
  const dir = join(import.meta.dirname, "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(vue|ts)$/.test(e.name) && !e.name.endsWith(".test.ts")) files.push(p);
    }
  })(dir);
  assert.ok(files.length > 120, `分母应当是全仓生产码，本轮只扫到 ${files.length} 份`);

  // 认两条：① 名字以 dispose/unlisten/cancel/teardown/cleanup 开头 + 句柄类型；
  // ② 类型是 UnlistenFn（Tauri 的卸载函数别名，它自己就说明了一切，不看名字）。
  // ⚠️ 不收「滚动句柄」：`let release: (() => void) | null`（`useBackLayer` 压/退历史条目）、
  //    `let groupTodosUnlisten`（切群时先摘旧再订新，迟到竞态由 `StaleGuard` 裁决）——
  //    那两处是「同一个句柄反复换人」，initScope 管的是「注册一次、拆卸时取消」，家不是同一个。
  const HANDLE =
    /\blet\s+(?:dispose|unlisten|cancel|teardown|cleanup)[A-Za-z0-9_$]*\s*:\s*(?:UnlistenFn|\(\s*\(\s*\)\s*=>\s*void\s*\))(?:\s*\[\s*\])?/
      .source +
    "|" +
    /\blet\s+[A-Za-z0-9_$]+\s*:\s*(?:UnlistenFn\s*(?:\[\s*\])?|Array<\s*UnlistenFn\s*>)/.source;
  const HANDLE_RE = new RegExp(HANDLE);
  const LATE = /\bif\s*\(\s*disposed\s*\)\s*\{?\s*\n?\s*[A-Za-z_$][\w$]*\(\)/;
  // 正控：这四条都是迁移前仓库里真写过的句柄形状，matcher 认不出 ⇒ 下面的"0 处"是空扫
  for (const known of [
    "let unlistenFocus: (() => void) | null = null;",
    "let disposeFocusSearch: (() => void) | null = null;",
    "let unlistenMenu: UnlistenFn[] | null = null;",
    "let disposeAppActions: (() => void)[] = [];",
  ]) {
    assert.ok(HANDLE_RE.test(known), `matcher 认不出手工句柄 ${known} ⇒ 下面的断言没有意义`);
  }
  // 反控：合规写法与「滚动释放句柄」（家不是 initScope）都不许被认成手工句柄
  for (const ok of [
    "const actionScope = createInitScope();",
    "let ready: boolean = false;",
    "let release: (() => void) | null = null;",
    "let groupTodosUnlisten: (() => void) | null = null;",
  ]) {
    assert.ok(!HANDLE_RE.test(ok), `matcher 误判合规/滚动句柄写法：${ok}`);
  }
  assert.ok(
    LATE.test('      if (disposed) fn();'),
    "matcher 认不出手写迟到守卫 ⇒ 下面的断言没有意义",
  );
  assert.ok(
    LATE.test('      if (disposed) {\n        fn();'),
    "matcher 认不出花括号版迟到守卫 ⇒ 下面的断言没有意义",
  );

  const bad: string[] = [];
  let scoped = 0;
  for (const p of files) {
    const src = readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (p.endsWith("utils/initScope.ts")) continue;
    const rel = p.replace(dir, "src");
    if (src.includes("createInitScope(")) scoped++;
    if (HANDLE_RE.test(src)) bad.push(`${rel}: 手工卸载句柄`);
    if (LATE.test(src)) bad.push(`${rel}: 手写「拆过了就就地取消」`);
  }
  assert.deepEqual(bad, [], `注册↔卸载这一族只有一个家（utils/initScope）：\n${bad.join("\n")}`);
  assert.ok(scoped >= 8, `反向判据：只有 ${scoped} 份生产文件真在用那个家（实测 10）⇒ 别是"大家压根不订阅"造成的假绿`);
});

// ---------------- ㊸ 时间分割行的阈值与判定只有一个家（§6.63） ----------------

/**
 * 家 = `utils/previewMetrics.ts` 的 `TIME_DIVIDER_GAP` + `shouldShowTimeDivider`。
 *
 * 为什么值得钉：分割行自己占 32px（`messageHeight.TIME_DIVIDER`），所以「这一条前面要不要插
 * 分割行」**同时**决定渲染与估算。两边各写一遍时改一边不红任何测试，坏起来是"相邻消息互相
 * 遮挡"，且只在间隔恰好跨过阈值的那几条消息上出现 —— 最难复现的一型。本轮删掉的正是这种：
 * `useMessageDisplay` 与 `messageHeight` 各有一份 `const TIME_DIVIDER_GAP = 5 * 60 * 1000;`
 * 加一句 `a.ts - b.ts >= TIME_DIVIDER_GAP`。
 *
 * 已知覆盖边界（不许当成全覆盖）：换一个名字再换成别的字面量（`const GAP = 3e5`）这一型
 * 看不见 —— 这条量具量的是「这个名字 + 两个 `.ts` 相减再比阈值」这个形状，不是"值等于 300000"。
 */
const DIVIDER_DECL_RE = /(?:export\s+)?const\s+TIME_DIVIDER_GAP\b/;
const DIVIDER_INLINE_RE = /\b[\w$][\w$.]*\.ts\s*-\s*[\w$][\w$.]*\.ts\s*(?:>=|>)/;

test("㊸ 夹具：别处再声明那个名字、或自己写一遍两个 .ts 相减的比较 → 报；调用那个家 → 放行", () => {
  // 正控：这两条就是本轮删掉的两种真写法，认不出 ⇒ 下面的"0 处"是空扫
  assert.ok(
    DIVIDER_DECL_RE.test("const TIME_DIVIDER_GAP = 5 * 60 * 1000;"),
    "matcher 认不出阈值声明 ⇒ 这条判据不作数",
  );
  assert.ok(
    DIVIDER_INLINE_RE.test("const showDivider = !prev || m.ts - prev.ts >= TIME_DIVIDER_GAP;"),
    "matcher 认不出旧的判定写法 ⇒ 这条判据不作数",
  );
  // 把 >= 写成 > 也属于同一族（差一个边界就是"正好 5 分钟那条要不要插"），换个比较符不许漏
  assert.ok(DIVIDER_INLINE_RE.test("if (message.value.ts - prev.value.ts > GAP) {}"));

  // 反控：合法的相邻形状不许被误伤（本仓真出现过的几种写法）
  for (const ok of [
    "const showDivider = shouldShowTimeDivider(m.ts, prev?.ts);",
    "const ageMs = Date.now() - m.ts;",
    "const gap = a.ts - b.ts;",
    "<!-- 时间分割线（间隔 ≥ 5 分钟）：居中浅灰小字 -->",
  ]) {
    assert.equal(
      DIVIDER_DECL_RE.test(ok) || DIVIDER_INLINE_RE.test(ok),
      false,
      `合法形状被判成违规 ⇒ 量具越界：${ok}`,
    );
  }
});

test("㊸ 真实树：阈值与判定只有 previewMetrics 一个家（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const HOME = "utils/previewMetrics.ts";
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".vue") || (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")))
        files.push(full);
    }
  };
  walk(srcDir);
  const bad: string[] = [];
  let importers = 0;
  for (const p of files) {
    const rel = p.replace(srcDir + "/", "");
    if (rel === HOME) continue;
    const code = readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    if (DIVIDER_DECL_RE.test(code)) bad.push(`${rel}: 又声明了一份阈值`);
    if (DIVIDER_INLINE_RE.test(code)) bad.push(`${rel}: 自己写了一遍间隔比较`);
    if (code.includes("shouldShowTimeDivider(")) importers++;
  }
  assert.deepEqual(bad, [], `时间分割行的阈值与判定只有一个家（utils/previewMetrics）：\n${bad.join("\n")}`);
  // 反向：那个家必须真被两处消费方用起来，否则"没有第二份"会因为压根没人做这件事而成立
  assert.ok(
    importers >= 2,
    `只有 ${importers} 份生产文件调用 shouldShowTimeDivider（应为渲染端 + 估算端两份）⇒ 这条判据在空扫`,
  );
  const home = readFileSync(join(srcDir, HOME), "utf8");
  // 2026-10-23：连续消息分组需要同一个 5 分钟窗，而 `messageKinds` 必须零 import（真值表用）。
  // 于是**字面量挪到 messageKinds 的 GROUP_GAP_MS**，previewMetrics 只做别名 —— 值仍只有一处；
  // 两头都钉住（少钉一头就会出现"别名指向不存在的常量"或"两个字面量各写一份"）。
  const gapHome = readFileSync(join(srcDir, "utils/messageKinds.ts"), "utf8");
  assert.match(gapHome, /export const GROUP_GAP_MS = 5 \* 60 \* 1000;/);
  assert.match(home, /export const TIME_DIVIDER_GAP = GROUP_GAP_MS;/);
  assert.match(home, /return prevTs == null \|\| ts - prevTs >= TIME_DIVIDER_GAP;/);
  console.log(`· ㊸ 分母：生产文件 ${files.length} 份 / 调用那个家 ${importers} 份 / 违规 0`);
});

// ---------------- ㊹ 组件自造的 objectURL 必须走「入账出口」（§6.66） ----------------

/**
 * 家 = `MergeCardModal.vue` 的 `adoptUrl()`：创建之后**只有这一处**决定"留下还是当场回收"。
 *
 * 为什么要钉：组件里 `URL.createObjectURL` 造出来的 blob URL 只活到这次 `revokeObjectURL`，
 * 而这条链上拿字节要先 `await` 一次 IPC。取消（弹窗关闭 / 组件卸载）如果发生在这次 await
 * 之后，卸载时那轮回收**已经跑完了**，此时再 `push` 进账本就没有任何人会再回收它 ——
 * 一张上限 `IMAGE_PREVIEW_MAX_BYTES`（15 MiB）的图永久留在文档里。本轮 `pull()` 就是这个形状：
 * 它在 await **之前**问了一次 `closed`，await **之后**直接入账；`probe()` 才有复查。
 *
 * 判据的口径与边界（不许当成全覆盖）：
 * · 只判「同一份文件里既有取消标志、又有 `URL.createObjectURL`」这一类 —— utils 那两本
 *   （`filePreview`/`favoritePreview`）的 URL 归 LRU 缓存所有，回收走 `blobLru` 的注入出口，
 *   不属于"组件自造"，硬把它们拽进 `adoptUrl` 反而是假抽象；
 * · 认的是「create 调用被 adopt 包住」这件事，不认"回收有没有真的执行" —— 后者需要跑起来，
 *   已由 §6.65 的 `rowpair` 那类矩形量具证明"文本判据看不到的那一半要单独量"，这条不冒充。
 */
const OBJ_CREATE_RE = /URL\.createObjectURL\(/g;
const OBJ_ADOPT_RE = /adoptUrl\(\s*URL\.createObjectURL\(/g;
const OBJ_CANCEL_RE = /\b(?:let|const)\s+(?:closed|cancelled|canceled|disposed|unmounted)\b/;

/** 把注释剥掉再数（注释里提这个名字是允许的，本仓的说明都要留痕）。 */
function stripCommentsJs(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
function countMatches(text: string, re: RegExp): number {
  return (text.match(new RegExp(re.source, re.flags)) || []).length;
}

test("㊹ 夹具：包住 create 放行、裸 create + 有取消标志报、没取消标志的那一族不判", () => {
  const wrapped = [
    // 本轮两处真写法（probe 带第三参、pull 不带）
    "let closed = false;\nconst url = adoptUrl(\n  URL.createObjectURL(new Blob([b])),\n  items.value[i] !== item,\n);",
    "let closed = false;\nconst url = adoptUrl(URL.createObjectURL(new Blob([b])));",
  ];
  for (const src of wrapped) {
    assert.equal(
      countMatches(src, OBJ_CREATE_RE) - countMatches(src, OBJ_ADOPT_RE),
      0,
      `认不出「create 被 adopt 包住」⇒ 下面的"0 处违规"是空扫：${src}`,
    );
  }
  // 正控：本轮删掉的那种裸写法必须被算成违规
  const bare = "let closed = false;\nconst url = URL.createObjectURL(new Blob([b]));\nobjectUrls.push(url);";
  assert.equal(
    OBJ_CANCEL_RE.test(bare) && countMatches(bare, OBJ_CREATE_RE) > countMatches(bare, OBJ_ADOPT_RE),
    true,
    "裸 create + 有取消标志必须算违规 ⇒ 判据在空扫",
  );
  // 反控 1：utils 那一族（URL 归缓存所有、没有取消标志）不该被这条拽进来
  const cacheOwned = "const url = URL.createObjectURL(new Blob([bytes]));\ncache.set(key, url);";
  assert.equal(OBJ_CANCEL_RE.test(cacheOwned), false, "没有取消标志的那一族必须被排除");
  // 反控 2：注释里提一句不该被数成 create 点
  const onlyComment = "// URL.createObjectURL 的回收归 adoptUrl\nlet closed = false;";
  assert.equal(countMatches(stripCommentsJs(onlyComment), OBJ_CREATE_RE), 0, "注释被当成调用点 ⇒ 量具越界");
});

test("㊹ 真实树：组件自造的 objectURL 全部走 adoptUrl，且那个家真会回收（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".vue") || (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")))
        files.push(full);
    }
  };
  walk(srcDir);

  const bad: string[] = [];
  let createSites = 0;
  let guardedFiles = 0;
  for (const p of files) {
    const rel = p.replace(srcDir + "/", "");
    const code = stripCommentsJs(readFileSync(p, "utf8"));
    const created = countMatches(code, OBJ_CREATE_RE);
    if (created === 0) continue;
    createSites += created;
    if (!OBJ_CANCEL_RE.test(code)) continue; // 没有取消标志 ⇒ 不属于这一族（utils 那两本就走这条）
    guardedFiles++;
    const adopted = countMatches(code, OBJ_ADOPT_RE);
    if (adopted !== created) {
      bad.push(`${rel}: 造了 ${created} 个 objectURL，只有 ${adopted} 个走 adoptUrl`);
    }
  }
  assert.deepEqual(bad, [], `组件里自造的 objectURL 必须在 await 之后经 adoptUrl 入账（否则卸载后才回来的那条永不回收）：\n${bad.join("\n")}`);
  // 两条下限：分母塌了（改名/删调用点）与"压根没人造 URL"都不许让上面那句成立
  assert.ok(createSites >= 2, `全仓只有 ${createSites} 处 createObjectURL（下限 2）⇒ 这条判据在空扫`);
  assert.ok(guardedFiles >= 1, "没有一份组件同时具备『造 URL』与『取消标志』⇒ 这条判据在空扫");

  // 那个家本身必须真的会回收：三个零件缺一个都不算守住
  const home = stripCommentsJs(readFileSync(join(srcDir, "components/message/MergeCardModal.vue"), "utf8"));
  const adoptBody = home.slice(home.indexOf("function adoptUrl("));
  assert.match(adoptBody.slice(0, 400), /closed/, "adoptUrl 里没问取消标志 ⇒ 家不成立");
  assert.match(adoptBody.slice(0, 400), /releaseUrl\(url\)/, "adoptUrl 里没有当场回收 ⇒ 家不成立");
  assert.match(adoptBody.slice(0, 400), /objectUrls\.push\(url\)/, "adoptUrl 里没有入账 ⇒ 家不成立");
  console.log(
    `· ㊹ 分母：生产文件 ${files.length} 份 / create 点 ${createSites} 处 / 带取消标志的那一族 ${guardedFiles} 份 / 违规 0`,
  );
});

// ---------------- ㊺ 主题令牌：每个 var(--gosslan-*) 消费点都必须找得到定义（§6.68） ----------------

/**
 * 家 = `src/style.css`（两档主题各一份）+ 组件里的内联 `:style` 键 + 运行时 `setProperty`。
 *
 * 为什么值得钉：令牌名写在 class 里（Tailwind 任意值 `text-[var(--gosslan-x)]`），**拼错一个字符
 * 不报任何错** —— CSS 的未知变量在计算值阶段失效，`color` 退回继承值、`background` 退回初值，
 * 于是"次要文字"变成正文色、"悬停有底色"变成点了没反应。本批现扫抓到 **8 处**：
 * `--gosslan-text-3` 5 处（第三档灰**从来没存在过**，这五处一直在继承正文色）、
 * `--gosslan-surface-2` 2 处（`NetworkSection` 两枚按钮的 hover 底色压根没画出来）、
 * `--gosslan-link-ink` 1 处（带兜底 ⇒ 看着正常，但那层间接是死的：兜底值就是它唯一的作用）。
 *
 * 口径（三条都是被实测形状逼出来的）：
 * 1. **带兜底值也算违规**：兜底会把拼错永久藏起来（今天看不出、明天改主题也看不出），
 *    而本仓令牌全在 CSS 里静态定义，"运行时才出现"是唯一合法例外 ⇒ 那种名字进
 *    `DYNAMIC_WRITERS` 白名单，且**白名单里的每个名字必须真有人在消费**（防它变成过期借口）。
 * 2. **定义要认三种形状**：CSS 声明、内联 `:style` 的字符串键（`MessageCodeBubble` 的
 *    `--bubble-bg` 就是这种）、`setProperty("--x", …)`（`color.ts` / `theme-boot.js` 写用户主题色）。
 *    少认一种就把在用的令牌判成没定义 —— 本批第一版只认 CSS 声明时，`--gosslan-msg-size`
 *    与 `--gosslan-primary` 都被误报。
 * 3. **只判 `--gosslan-` 前缀**：`--reka-toast-swipe-move-x` 这类由库在运行时提供，不归我们定义。
 *
 * 已知覆盖边界（不许当成全覆盖）：名字**拼出来**的消费（`var(`--gosslan-${k}`)`）静态扫不到 ⇒
 * 那类只能靠白名单交代；而"定义了却没人消费"这一半**故意不判红**（排版标尺三档是文档里写明
 * 等接线的基建，见 `docs/design-guidelines.md` 那张表），改成"数量只许变小 + 每轮打印名单"。
 */
const TOKEN_RE = {
  use: /var\(\s*(--gosslan-[\w-]+)\s*(,)?/g,
  decl: /--gosslan-[\w-]+\s*:/g,
  inline: /["']--gosslan-[\w-]+["']\s*:/g,
  set: /setProperty\(\s*["'`]--gosslan-[\w-]+["'`]/g,
};
/** 只抠名字本身：`--gosslan-` 后面那段标识符。 */
const TOKEN_NAME = /(--gosslan-[\w-]+)/;

/**
 * 剥注释。不能直接用 `stripCommentsJs`：它按 `//[^\n]*` 砍行注释，会连着把 `url(https://…)`
 * 砍掉（本仓 CSS 里有真实外链）。这里的口径：块注释与 HTML 注释整段去，行注释只在
 * `//` 前面不是 `:` 时才去（`:` 就是 `https://` 的那种形状）。
 */
function stripCommentsForTokens(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:\n])\/\/[^\n]*/g, "$1");
}

/** 白名单：只有「名字在运行时拼出来写进 :root」的才许进，且必须写明谁写的。今天为空。 */
const DYNAMIC_WRITERS: { name: string; who: string }[] = [];

function tokensOf(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    const hit = TOKEN_NAME.exec(m[0]);
    if (hit) out.push(hit[1]);
  }
  return out;
}

test("㊺ 夹具：未定义令牌报、三种定义形状都认、非本命名空间不判", () => {
  // 正控 —— 本批真删掉的两种坏形状，认不出 ⇒ 下面"真实树 0 处"是空扫
  assert.deepEqual(tokensOf(`.a{color:var(--gosslan-nope)}`, TOKEN_RE.use), ["--gosslan-nope"]);
  // 嵌套那串会抠出两个名字：外层没定义的与被兜底救场的，都要进消费面
  assert.deepEqual(
    tokensOf(`class="hover:bg-[var(--gosslan-nope,var(--gosslan-hover))]">`, TOKEN_RE.use),
    ["--gosslan-nope", "--gosslan-hover"],
  );
  // 带兜底那条也必须拿到名字（口径 1：兜底不豁免）
  assert.equal(tokensOf(`var( --gosslan-a , 0px )`, TOKEN_RE.use)[0], "--gosslan-a");
  // 三种定义形状各一条
  assert.deepEqual(tokensOf(`  --gosslan-a: 4px;`, TOKEN_RE.decl), ["--gosslan-a"]);
  // 内联那种是本命名空间里的 `MessageCodeBubble` 同款形状（非 `--gosslan-` 前缀的局部名不判，见头部口径 3）
  assert.deepEqual(tokensOf(`:style="{ '--gosslan-tail-bg': tailBg }"`, TOKEN_RE.inline), ["--gosslan-tail-bg"]);
  assert.deepEqual(
    tokensOf(`root.style.setProperty("--gosslan-primary", color)`, TOKEN_RE.set),
    ["--gosslan-primary"],
  );
  // 反控 —— 命名空间外不判（库自己运行时给的），名字拼出来的整串不许当成一个令牌
  assert.deepEqual(tokensOf(`var(--reka-toast-swipe-move-x)`, TOKEN_RE.use), []);
  // 拼出来的名字静态分不出「模板拼接」与「拼错」⇒ 只能靠白名单交代（下面那条真实树判据会红在这里）
  assert.deepEqual(
    tokensOf("var(--gosslan-radius-" + "$" + "{x})", TOKEN_RE.use),
    ["--gosslan-radius-"],
    "认不出拼出来的名字 ⇒ 这类必须进 DYNAMIC_WRITERS，白名单不是给失误留的口子",
  );
  // 反控 —— 剥注释不许砍掉 url(https://…)，也不许让注释里提的令牌名进消费面
  assert.equal(
    stripCommentsForTokens(`background: url(https://x/y.png); // 留着\n`).includes("https://x/y.png"),
    true,
    "行注释剥离把协议地址一起吃掉了 ⇒ 量具越界",
  );
  assert.deepEqual(tokensOf(stripCommentsForTokens(`/* color: var(--gosslan-in-comment) */`), TOKEN_RE.use), []);
});

test("㊺ 真实树：每个 var(--gosslan-*) 消费点都找得到定义（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(vue|ts|js|css|html)$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);

  const defined = new Set<string>(DYNAMIC_WRITERS.map((d) => d.name));
  const used = new Map<string, string[]>();
  let useSites = 0;
  for (const p of files) {
    const rel = p.replace(srcDir + "/", "");
    // 判据自己读自己的白名单/夹具，不算消费面（同 ㉞ 那族的"注释与夹具不许被数成调用点"）
    if (rel === "utils/designGuards.test.ts" || rel === "utils/designGuards.ts") continue;
    const code = stripCommentsForTokens(readFileSync(p, "utf8"));
    for (const t of tokensOf(code, TOKEN_RE.decl)) defined.add(t);
    for (const t of tokensOf(code, TOKEN_RE.inline)) defined.add(t);
    for (const t of tokensOf(code, TOKEN_RE.set)) defined.add(t);
    for (const t of tokensOf(code, TOKEN_RE.use)) {
      useSites++;
      if (!used.has(t)) used.set(t, []);
      if (used.get(t)!.length < 3) used.get(t)!.push(rel);
    }
  }

  const missing = [...used.keys()].filter((t) => !defined.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `这些 --gosslan-* 令牌被消费但全仓没有定义（CSS 里拼错一个字符不会报，只会静默退回继承色/初值）：\n`
      + missing.map((t) => `${t} ← ${used.get(t)!.join(", ")}`).join("\n"),
  );
  // 两条下限：消费面塌了（改名/正则失配）与"压根没定义面"都不许让上面那句成立
  assert.ok(useSites >= 400, `全仓只扫到 ${useSites} 个 var(--gosslan-*) 消费点（下限 400）⇒ 量具在空扫`);
  assert.ok(defined.size >= 40, `只认出 ${defined.size} 个令牌定义（下限 40）⇒ 定义面的形状变了，上面那句不作数`);

  // 反向那一半：从"数量上限"改成**逐格点名 + 写理由**（这是收紧，不是放宽：以前第 5、6 个没人读的名字能混过去，
  // 现在不在名单里就红）。这 3 格都是**还没接线的排版阶梯**（265 处内联 `text-[NNpx]` 的目标档）
  // ⇒ 删了就等于把迁移目的地一起删掉。谁接上了就把那格从名单里删掉
  // （2026-10-25：`--gosslan-item-radius` 被 CrashNotice / HangNotice 接上后已按此删掉）。
  const TOKEN_UNCONSUMED: Array<{ name: string; why: string }> = [
    { name: "--gosslan-text-title", why: "字号阶梯 style.css:63，等 265 处内联 text-[NNpx] 接线" },
    { name: "--gosslan-text-callout", why: "字号阶梯 style.css:65，同上" },
    { name: "--gosslan-text-footnote", why: "字号阶梯 style.css:66，同上" },
  ];
  const unused = [...defined].filter((t) => !used.has(t) && !DYNAMIC_WRITERS.some((d) => d.name === t)).sort();
  const unlisted = unused.filter((t) => !TOKEN_UNCONSUMED.some((w) => w.name === t));
  assert.deepEqual(
    unlisted,
    [],
    `新增了"定义了却没人消费"的令牌且没登记理由：\n${unlisted.join("\n")}\n⇒ 要么接上它，要么删掉它；别留第三种状态`,
  );
  // 反向钉（与 DYNAMIC_WRITERS 那四条同一口径）：登记的每个名字今天必须仍然没人消费 —— 名单不许变成过期借口
  for (const w of TOKEN_UNCONSUMED) {
    assert.ok(
      unused.includes(w.name),
      `登记的无人消费令牌 ${w.name}（理由：${w.why}）今天已被消费或不存在 ⇒ 把这条从名单里删掉`,
    );
  }
  // 白名单不许变成过期借口：进名单的名字必须真有人在消费
  for (const d of DYNAMIC_WRITERS) {
    assert.ok(used.has(d.name), `白名单里的 ${d.name}（理由：${d.who}）今天没有任何消费点 ⇒ 该删`);
  }
  console.log(
    `· ㊺ 分母：扫 ${files.length} 份 / 消费点 ${useSites} 处 / 定义 ${defined.size} 个 / `
      + `未定义 0 / 无人消费 ${unused.length} 个${unused.length ? "（" + unused.join(" ") + "）" : ""}`,
  );
});

// ---------------- ㊻ 移动端固定底栏的「占位高度」只有一个家（§6.69） ----------------
/**
 * 形状：Tailwind 任意值里的 `pb-[calc(…)]` 就是"给 `fixed bottom-0` 的底栏留位"那一层。
 * 这类占位里的高度**必须来自令牌**，不许再写一个字面长度 —— 同一档高度在两处各抄一份，
 * 改一处就会让另一处的最后一行被底栏压住（`ResponsiveLayout` 2026-09-19 那次是同一个族的
 * 漂移，只是当时漂的是**显示条件**、这一族漂的是**尺寸**）。
 *
 * 口径三条，都是为了不多管，别改回去：
 * 1. **只扫 `pb-[calc(`**。`pb-[max(env(safe-area-inset-bottom),0.5rem)]`（ActionSheet /
 *    FavoritePanel）写的是"安全区下限"，与底栏高度无关，不归这条管。
 * 2. **`env(...)` 本身不算字面量**：它是平台给的量。被判的是"另一个操作数是人抄的固定长度"。
 * 3. **单位不在这一条判**（rem 还是 px 由令牌自己定，`--gosslan-mobile-tabbar-h` 必须 rem
 *    的理由写在 `src/style.css` 的注释里：Android textZoom 下条子跟着根字号变高）。
 *    这条只判"有没有第二个家"，不判"那个家写成什么样"。
 */
const TABBAR_PLACEHOLDER = /pb-\[calc\((.*?)\)\]/g;
const LITERAL_LEN = /(?<![-\w.])\d+(?:\.\d+)?(?:px|rem|em|vh|dvw|dvh)\b/g;
const TOKEN_REF = /var\(\s*--gosslan-[\w-]+/g;

function auditTabbarPlaceholders(text: string): {
  sites: number;
  literals: string[];
  noToken: string[];
  tokenNames: string[];
} {
  const literals: string[] = [];
  const noToken: string[] = [];
  const tokenNames: string[] = [];
  let sites = 0;
  for (const m of text.matchAll(TABBAR_PLACEHOLDER)) {
    sites++;
    const expr = m[1];
    const lit = expr.match(LITERAL_LEN);
    if (lit) literals.push(`${expr} ⇒ 字面长度 ${lit.join(",")}`);
    const toks = expr.match(TOKEN_REF) ?? [];
    if (toks.length === 0) noToken.push(expr);
    for (const t of toks) tokenNames.push(t.replace("var(--", "--").replace(/\s+$/, ""));
  }
  return { sites, literals, noToken, tokenNames };
}

test("㊻ 夹具：字面量占位报、令牌占位不报、max() 那一族根本不扫、多令牌拼接不误伤", () => {
  // 正控 —— 坏形状：尺寸是人抄的（这两条各红各的：一条有字面量、一条连令牌都没有）
  const bad = auditTabbarPlaceholders(
    `<div class="pb-[calc(4rem+env(safe-area-inset-bottom))]"></div>`
      + `<div class="pb-[calc(56px+8px)]"></div>`,
  );
  assert.equal(bad.sites, 2);
  assert.equal(bad.literals.length, 2, JSON.stringify(bad.literals));
  assert.deepEqual(bad.noToken, ["4rem+env(safe-area-inset-bottom)", "56px+8px"]);
  // 反控 1 —— 合规形状不许报
  const good = auditTabbarPlaceholders(
    `<div class="pb-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom))]"></div>`,
  );
  assert.deepEqual(good.literals, []);
  assert.deepEqual(good.noToken, []);
  assert.deepEqual(good.tokenNames, ["--gosslan-mobile-tabbar-h"])
  // 反控 2 —— `max(env,字面量)` 是安全区下限，不属于这一族（误扫就会去禁一件正确的事）
  const notMine = auditTabbarPlaceholders(
    `<div class="pb-[max(env(safe-area-inset-bottom),0.75rem)]"></div>`,
  );
  assert.equal(notMine.sites, 0, "max() 那一族不该被当成底栏占位");
  // 反控 3 —— 两个令牌相加（底栏 + 额外呼吸位）是合法写法，不许因"不止一个令牌"误伤
  const multi = auditTabbarPlaceholders(
    `<div class="pb-[calc(var(--gosslan-mobile-tabbar-h)+var(--gosslan-gap-lg))]"></div>`,
  );
  assert.deepEqual(multi.literals, []);
  assert.deepEqual(multi.noToken, []);
  assert.equal(multi.tokenNames.length, 2);
});

test("㊻ 真实树：底栏占位不许多处各抄一份尺寸（分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.vue$/.test(e.name) && !/\.test\.vue$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);

  const offenders: string[] = [];
  const tokenUse = new Map<string, number>();
  let sites = 0;
  for (const p of files) {
    const rel = p.replace(srcDir + "/", "");
    // 注释里的示例不许被数成占位点（与 ㊺ 同一口径：先剥注释再判）
    const a = auditTabbarPlaceholders(stripCommentsForTokens(readFileSync(p, "utf8")));
    sites += a.sites;
    for (const s of a.literals) offenders.push(`${rel}: 占位里抄了字面长度 ${s}`);
    for (const s of a.noToken) offenders.push(`${rel}: 占位没读任何 --gosslan-* 令牌 ⇒ ${s}`);
    for (const t of a.tokenNames) tokenUse.set(t, (tokenUse.get(t) ?? 0) + 1);
  }

  assert.deepEqual(offenders, [], `移动端固定底栏的占位高度只有一个家 = 令牌。手写一份就多一个家：\n${offenders.join("\n")}`);
  // 分母下限：今天实测 2 处（ResponsiveLayout 主内容区 + ConversationList 列表）。
  // 数量掉到 1 以下 = 要么改名把这条扫空了，要么有人把占位整段删了 —— 两种都不许静默通过。
  assert.ok(sites >= 2, `全仓只扫到 ${sites} 处 pb-[calc(…) 底栏占位（下限 2）⇒ 量具在空扫`);
  const tabbar = tokenUse.get("--gosslan-mobile-tabbar-h") ?? 0;
  assert.ok(
    tabbar >= 2,
    `--gosslan-mobile-tabbar-h 只被 ${tabbar} 处占位读到（下限 2）⇒ 有一处退回手写字面量了`,
  );
  console.log(`· ㊻ 分母：扫 ${files.length} 份 .vue / 底栏占位 ${sites} 处 / 读到的令牌 ${[...tokenUse.keys()].join(" ")}（各 ${[...tokenUse.values()].join(" ")} 次）`);
});

/**
 * ㊼ 移动端「整屏覆盖壳」的三个形状片段（铺满视口 + 盖住底栏 + 让开顶部安全区）。
 * 这一族唯一的家 = `components/MobilePageFrame.vue`；业务页自己拼一遍就多一个家，
 * 而底栏遮挡与安全区的口径正是从那个家里漂走的东西（收藏页今天就是抄的那一份）。
 * 三段齐全才算壳 —— 只写了 `fixed inset-0` 的普通铺满层（灯箱、遮罩）是另一族，不该被这一条管。
 */
const OVERLAY_SHELL_SHAPES = ["fixed inset-0", "z-[60]", "pt-[env(safe-area-inset-top)]"];
const OVERLAY_SHELL_HOUSE = "components/MobilePageFrame.vue";
// 已登记的同形抄本（棘轮：只许变小，迁走一格就把名字删掉，别把上限调高）。
// ★ `FavoritePanel.vue` 这格不是"还没来得及迁"，是 §6.75 读过实现之后判的**保留自研**，理由钉在这里免得被当默认豁免：
//   那一格是**同一个元素同时 serve 两支布局**（移动端 overlay / 桌面内嵌右栏）。`MobilePageFrame` 的 `overlay` 是
//   `fixed inset-0` —— 桌面那支用它会被摘出流并盖住左列；`inline` 根类写的是 `flex h-full` 而**没有 `flex-1`**，
//   而这格的父亲（`FavoritePanel.vue:582`，`flex min-h-0 flex-1`）是 flex-**row**，`flex-1` 在那里管的是**宽度**
//   （同文件 `:597` 那句注释自己就写着"flex-1 把 flex-basis 设成 0% 会让 width 失效"）。⇒ 两个 mode 各只盖住一支。
//   只迁移动端那一支也得把这个元素拆成两支 ⇒ 详情正文 L688–L881（194 行 / 8 个处理函数）要么抄第二份、要么抽成
//   新组件（§七.6 禁的那种"为通用性加层级"）；底部留白还差一个量（框架 `.safe-bottom` = `env()`，收藏页 = `max(env(),0.75rem)`
//   ⇒ `env()` 取 0 的端上 12px 会静默变 0）。**别再把它排成"下一批就迁"**；新增同形照旧红。
const OVERLAY_SHELL_COPIES: string[] = ["components/FavoritePanel.vue"];

function hasOverlayShell(text: string): boolean {
  const code = stripCommentsForTokens(text);
  return OVERLAY_SHELL_SHAPES.every((s) => code.includes(s));
}

test("㊼ 形状：三段齐全才算整屏壳；少一段不算、注释里的示例不算", () => {
  assert.equal(
    hasOverlayShell(`<template><div class="fixed inset-0 z-[60] pt-[env(safe-area-inset-top)]" /></template>`),
    true,
    "三段齐全要认出来（这就是抄本的形状）",
  );
  assert.equal(
    hasOverlayShell(`<template><div class="fixed inset-0 z-[60]" /></template>`),
    false,
    "没让开顶部安全区的普通铺满层是另一族，不该被这一条禁",
  );
  assert.equal(
    hasOverlayShell(`<!-- 抄本示例：<div class="fixed inset-0 z-[60] pt-[env(safe-area-inset-top)]" /> -->`),
    false,
    "注释里的示例不许被数成抄本",
  );
});

test("㊼ 真实树：整屏覆盖壳只许出自 MobilePageFrame（抄本只许变小，分母现数）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.vue$/.test(e.name) && !/\.test\.vue$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);

  const shells: string[] = [];
  for (const p of files) {
    if (hasOverlayShell(readFileSync(p, "utf8"))) shells.push(p.replace(srcDir + "/", ""));
  }

  // 正控：家自己必须被认出来。扫不到 ⇒ 三段形状改了名，下面两句都在空扫。
  assert.ok(
    shells.includes(OVERLAY_SHELL_HOUSE),
    `全仓没认出 ${OVERLAY_SHELL_HOUSE} 的整屏壳 ⇒ 形状签名过期，这条判据已经在空扫`,
  );
  const copies = shells.filter((s) => s !== OVERLAY_SHELL_HOUSE).sort();
  const fresh = copies.filter((s) => !OVERLAY_SHELL_COPIES.includes(s));
  assert.deepEqual(
    fresh,
    [],
    `这些页面手抄了整屏覆盖壳而没有登记：\n${fresh.join("\n")}\n⇒ 用 <MobilePageFrame mode="overlay" …>，别复制第二份壳`,
  );
  assert.ok(
    copies.length <= OVERLAY_SHELL_COPIES.length,
    `整屏壳抄本从登记的 ${OVERLAY_SHELL_COPIES.length} 个涨到 ${copies.length} 个（${copies.join(" ")}）：只许变小`,
  );
  console.log(
    `· ㊼ 分母：扫 ${files.length} 份 .vue / 认出整屏壳 ${shells.length} 份 `
      + `（家 1 + 抄本 ${copies.length}：${copies.join(" ") || "无"}）`,
  );
});

/**
 * ㊽ DOM 监听器的「绑定 ↔ 解绑」配对（P0 那一族：事件泄漏是**静默**的，不报任何错）。
 *
 * 口径按 `(事件名, 处理函数标识)` 配对，只在**同一份文件**内认账：
 *  · 具名处理函数被 add 而同文件找不到 remove ⇒ 要么登记成"整窗生命周期的一次性接线"，要么红；
 *  · capture 旗标两侧必须一致 —— `addEventListener(x, h, {capture:true})` 配
 *    `removeEventListener(x, h)`（不带旗标）**什么都解不掉且不报错**，这是这一族最阴的失效形状；
 *  · 匿名箭头函数没法按标识配对 ⇒ 只允许出现在登记过的一次性文件里。
 * 注释里的同形文字先剥掉再数（与 ㊺/㊻/㊼ 同一口径）。
 */
const DOM_ADD = /addEventListener\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)?\s*([^)]*)\)/g;
const DOM_REMOVE = /removeEventListener\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)?\s*([^)]*)\)/g;

/** 把第三参归一化成 "capture" / "bubble" / "dyn"（动态值判不了，单独计数不判红）。 */
function domPhase(opts: string): "capture" | "bubble" | "dyn" {
  const o = opts.trim();
  if (!o) return "bubble";
  if (/capture:\s*true\b/.test(o) || /^true\b/.test(o)) return "capture";
  if (/capture:\s*false\b/.test(o) || /^false\b/.test(o)) return "bubble";
  if (/capture/.test(o)) return "dyn";
  return "bubble";
}

/**
 * 一次性接线（整窗生命周期，故意不解绑）。每条都要写清"为什么这不是泄漏"，
 * 并且下面那条"名单里的文件必须真的还在绑定"会把过期借口抓出来。
 */
const DOM_ONE_SHOT_FILES: { file: string; who: string }[] = [
  { file: "boot/boot.ts", who: "启动期全局错误上报与 boot 卸载：早于任何组件，活到窗口关闭" },
  { file: "i18n/index.ts", who: "系统语言变化监听：模块单例，一份窗口一个" },
  { file: "composables/useBackLayer.ts", who: "popstate 由 installed 旗标保证全窗只挂一次" },
];

function auditDomListeners(code: string): {
  adds: number;
  unpaired: string[];
  phaseMismatch: string[];
  anonymous: string[];
  dyn: number;
} {
  const stripped = stripCommentsForTokens(code);
  const removes = [...stripped.matchAll(DOM_REMOVE)].map((m) => ({
    evt: m[1],
    fn: m[2] ?? null,
    phase: domPhase(m[3] ?? ""),
  }));
  const adds = [...stripped.matchAll(DOM_ADD)];
  const out = { adds: adds.length, unpaired: [] as string[], phaseMismatch: [] as string[], anonymous: [] as string[], dyn: 0 };
  for (const m of adds) {
    const evt = m[1];
    const fn = m[2] ?? null;
    const phase = domPhase(m[3] ?? "");
    if (phase === "dyn") out.dyn++;
    if (!fn) {
      out.anonymous.push(evt);
      continue;
    }
    const paired = removes.filter((r) => r.evt === evt && r.fn === fn);
    if (paired.length === 0) {
      out.unpaired.push(`${evt} ${fn}`);
      continue;
    }
    // ⚠️ 判「**每一侧**都对得上」而不是「至少一侧对得上」：同一对 (事件, 处理函数) 可能有两处解绑
    // （切换关闭 + 卸载兜底）。只要其中一处漏了 capture，那一趟就是空解绑 —— "另一处能解掉"不救它。
    if (phase !== "dyn") {
      const bad = paired.filter((r) => r.phase !== "dyn" && r.phase !== phase);
      if (bad.length > 0) out.phaseMismatch.push(`${evt} ${fn}（绑定侧 = ${phase}，有 ${bad.length}/${paired.length} 处解绑旗标不一致）`);
    }
  }
  return out;
}

test("㊽ 形状：解绑旗标不一致要报、匿名与一次性登记不报", () => {
  const mismatch = `<script setup>
window.addEventListener("scroll", onScroll, { capture: true });
onBeforeUnmount(() => window.removeEventListener("scroll", onScroll));
</script>`;
  const a = auditDomListeners(mismatch);
  assert.equal(a.phaseMismatch.length, 1, "capture 绑定 + 不带旗标解绑 = 什么都解不掉，必须报");
  assert.match(a.phaseMismatch[0], /scroll onScroll/);

  const ok = mismatch.replace("removeEventListener(\"scroll\", onScroll)", "removeEventListener(\"scroll\", onScroll, { capture: true })");
  assert.equal(auditDomListeners(ok).phaseMismatch.length, 0, "两侧一致就不该报（撤销这条断言等于把它换成更强的证据：同一语义已由上一条正向证过）");

  const noRemove = `<script setup>document.addEventListener("click", onClose);</script>`;
  assert.deepEqual(auditDomListeners(noRemove).unpaired, ["click onClose"], "具名绑定而同文件没有解绑 ⇒ 要点名");

  assert.deepEqual(auditDomListeners(`<script>/* window.addEventListener("click", foo) */</script>`).unpaired, [], "注释里的同形文字不许被数成绑定点");
  assert.equal(auditDomListeners(`<script>window.addEventListener("x", () => {});</script>`).anonymous.length, 1, "匿名处理函数按身份配不了对，要单独数出来");
});

test("㊽ 真实树：DOM 监听绑定↔解绑逐点对账（分母现数，名单不许变成过期借口）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(vue|ts)$/.test(e.name) && !/\.test\.(vue|ts)$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);

  const offenders: string[] = [];
  const oneShotSeen = new Set<string>();
  let totalAdds = 0;
  let totalDyn = 0;
  for (const p of files) {
    const rel = p.replace(srcDir + "/", "");
    const a = auditDomListeners(readFileSync(p, "utf8"));
    totalAdds += a.adds;
    totalDyn += a.dyn;
    const whitelisted = DOM_ONE_SHOT_FILES.find((w) => w.file === rel);
    if (a.adds > 0 && whitelisted) oneShotSeen.add(rel);
    // 一次性接线的文件豁免"没解绑/匿名"这两条（那是它的设计），但**不豁免旗标不一致**——
    // capture 两侧不一致在任何文件里都是空解绑。
    if (!whitelisted) {
      for (const u of a.unpaired) offenders.push(`${rel}: 绑了 ${u} 但同文件没有解绑`);
      for (const an of a.anonymous) {
        offenders.push(`${rel}: 匿名处理函数绑了 ${an} ⇒ 按身份无法解绑，要么具名要么登记成一次性接线`);
      }
    }
    for (const m of a.phaseMismatch) offenders.push(`${rel}: capture 旗标两侧不一致 ⇒ 解绑是空操作 ${m}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `DOM 监听器有绑定没有解绑＝静默泄漏（不报错、只在长跑里长出来的那种）。名单外的格子要么补解绑，要么按 §6.59/§6.60 那个家登记：\n${offenders.join("\n")}`,
  );
  // ★ 分母口径（§6.73 改过一次，理由值得留着）：手写面从 §6.71 的 27 → §6.72 的 22 → 本批 15，每迁一处就少一条，
  // 而每少的那一侧都会让 `useEventListener(` 多一处 ⇒ **两个家加起来是守恒量**（现读 22+9 = 15+16 = 31）。
  // 所以主判据改成钉**总数下限**：它既挡"量具空扫/有人整批删监听"，又**不随迁移漂**（以前每迁一次就得手动重定下限，
  // 那是量具在跟着被量的东西走）。两个家各自的存在下限只当"这一侧不许静默清零"的兜底，取值留了余量。
  let vueUseSites = 0;
  for (const p of files) {
    vueUseSites += [...stripCommentsForTokens(readFileSync(p, "utf8")).matchAll(/useEventListener\(/g)].length;
  }
  const totalSites = totalAdds + vueUseSites;
  assert.ok(
    totalSites >= 28,
    `两个家加起来只数到 ${totalSites} 处（下限 28）⇒ 量具在空扫，或监听被整批删了（手写 ${totalAdds} + 走库 ${vueUseSites}）`,
  );
  assert.ok(totalAdds >= 13, `手写家只剩 ${totalAdds} 处（下限 13）⇒ 条件性摘挂/store-boot 级那一族该还在手写`);
  assert.ok(
    vueUseSites >= 15,
    `走库家只剩 ${vueUseSites} 处（下限 15）⇒ 库那个家没人用了，守恒量那条该按"手写面重新变大"重看`,
  );
  // 正控：每条一次性登记必须真的还在绑定，名单不许变成过期借口
  for (const w of DOM_ONE_SHOT_FILES) {
    assert.ok(oneShotSeen.has(w.file), `登记的一次性接线文件 ${w.file}（理由：${w.who}）今天没有任何 addEventListener ⇒ 该从名单里删掉`);
  }
  console.log(
    `· ㊽ 分母：扫 ${files.length} 份生产码 / 手写绑定点 ${totalAdds} 处（动态旗标 ${totalDyn}）/ `
      + `VueUse 托管 ${vueUseSites} 处 / 一次性登记 ${oneShotSeen.size} 份 / 未配对 0 / 旗标不一致 0`,
  );
});

test("㊾ 「localStorage 会抛」这一族只有一个家（§6.80 新增）", async () => {
  const fsp = await import("node:fs");
  const pth = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fsp.readdirSync(d, { withFileTypes: true })) {
      const p = pth.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(srcDir);
  // §6.81：这一半从"只认属性调用"放宽到**裸标识符** —— 把 `localStorage` 当值交出去
  // （`readStoredAppearance(localStorage)` 那一族）同样会抛，属性访问本身就是抛点。
  const DIRECT = /\b(?:local|session)Storage\b/g;
  const offenders: string[] = [];
  let consumers = 0;
  const consumerFiles = new Set<string>();
  for (const abs of files) {
    const rel = pth.relative(srcDir, abs).split(pth.sep).join("/");
    // 那个家自己就是唯一允许摸后端的地方；首帧脚本 theme-boot.js 由 vite 内联、import 不到模块，
    // 它不在 .ts/.vue 这一族里 ⇒ 天然豁免，理由写在报告 §6.80 那一格。
    if (rel === "utils/safeStorage.ts") continue;
    const lines = fsp.readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      for (const m of line.matchAll(DIRECT)) offenders.push(rel + ":" + (i + 1) + " " + t.slice(0, 48));
    });
    const c = (lines.join("\n").match(/\bstorage(?:Get|Set|Remove)\s*\(/g) || []).length;
    if (c > 0) {
      consumers += c;
      consumerFiles.add(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "生产码里又出现绕过 safeStorage 的存储直连点（SecurityError / QuotaExceededError 会把调用方整个打断）：\n"
      + offenders.join("\n"),
  );
  // 反向那半：消费面塌了（改名或失配）会让上面那句"没有直连"变成假绿
  assert.ok(consumers >= 20, "只扫到 " + consumers + " 个 storageGet/Set/Remove 调用点（下限 20）⇒ 消费面变了，上面那句不作数");
  // 「把存储当对象交出去」那一族也得留在这个家上：它们消费的是 safeStorageBackend，
  // 不在上面那句的名单里 ⇒ 单独钉一条下限，漂了就点名。
  const backendMentions = files
    .filter((abs) => !abs.endsWith("safeStorage.ts"))
    .reduce((acc, abs) => acc + ((fsp.readFileSync(abs, "utf8").match(/\bsafeStorageBackend\b/g) || []).length), 0);
  assert.ok(backendMentions >= 6, "safeStorageBackend 只被提到 " + backendMentions + " 次（下限 6）⇒ DI 那一族又漂回直连了");
  for (const need of ["stores/useAppStore.ts", "stores/useChatStore.ts", "i18n/index.ts", "layouts/ResponsiveLayout.vue"]) {
    assert.ok(consumerFiles.has(need), "§6.80 迁过来的 " + need + " 今天不再调用 safeStorage 出口 ⇒ 分母在漂");
  }
  console.log("· ㊾ 分母：扫 " + files.length + " 份生产码 / 直连点 " + offenders.length + " / 新家消费点 " + consumers + " 处（" + consumerFiles.size + " 份文件）");
});

// ---------------- ㊿ 顶部让位只剩一个出口（2026-10-20，§6.91） ----------------
/**
 * 「让开顶部」以前有两套互不相认的口径：桌面读 `--gosslan-window-safe-top`（自绘 caption），
 * 移动端读 `env(safe-area-inset-top)`（刘海 / 状态栏）。卡片形态的小弹窗两枚都没读全
 * ⇒ 用户实测「移动端弹窗上方被刘海压住」；图片预览那层则把两枚**相加** ⇒ 桌面量到工具条
 * 落在 2×caption + 16px（真几何读数 delta=60，应为 16）。
 *
 * 现在收成一枚出口：`--gosslan-safe-top = max(window, env)`。本格只管**绑定层**
 * （谁读哪一枚、有没有人又把两枚叠起来）；真几何那一半在
 * `scripts/check-ui-runtime.mjs` 的 `--only=lightbox` 段（钉 44px 后量 delta，改坏即红）。
 * ⚠️ `env()` 在 Chrome 恒 0 ⇒ 移动端那一半**浏览器里证不了**，只有真机可证（登记在 §6.91 末）。
 */
const walk691 = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk691(full));
    else if (/\.(vue|css|ts)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
};
const srcDir691 = join(import.meta.dirname, "..");
/**
 * 判据读的是**代码**，不是注释：本批那条 `pt-[env(safe-area-inset-top)]` 被删掉之前，
 * 我在 BaseModal 的注释里逐字引用过它 ⇒ 整份文件当文本搜会读到注释、把已经改对的代码
 * 判成红（反向也一样：注释里提一个字就能喂饱一条缺席判据）。先剥 HTML/块/行注释。
 */
const code691 = (src) =>
  src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\/\/.*$/gm, "");
/** 同一表达式里既读 window 那枚又加 env ⇒ 双计（本批要消灭的形状）。 */
const SUM_RE = /--gosslan-window-safe-top[^)]*\)\s*\+\s*env\(safe-area-inset-top/;

test("㊿ style.css 里那枚出口只定义一次，且取 max 不是相加", () => {
  const css = readFileSync(join(srcDir691, "style.css"), "utf8");
  const hits = css.match(/--gosslan-safe-top:\s*max\([^)]*\)/g) || [];
  assert.equal(hits.length, 1, "出口定义应当只有一处，实得 " + hits.length + " 处");
  assert.ok(
    /--gosslan-safe-top:\s*max\(var\(--gosslan-window-safe-top, 0px\), env\(safe-area-inset-top, 0px\)\)/.test(css),
    "出口必须是 max(window, env)：相加会把同一个物理避让读两遍",
  );
});

test("㊿ 生产码里没有人再把两枚相加（缺席型判据：正控 + 分母 + 反向钉一起带）", () => {
  const files = walk691(srcDir691);
  assert.ok(files.length >= 200, "只扫到 " + files.length + " 份生产码 ⇒ 路径写错了，这条是在测空气");
  const offenders = files
    .filter((f) => SUM_RE.test(code691(readFileSync(f, "utf8"))))
    .map((f) => f.slice(srcDir691.length + 1));
  assert.deepEqual(offenders, [], "又把 caption 和安全区叠起来了：" + offenders.join(", "));
  // 正控：迁移前 ImageLightbox 就是这一串，量具抓得住它（抓不住 ⇒ 上面那条 deepEqual 是空的）。
  assert.ok(
    SUM_RE.test("{ top: 'calc(var(--gosslan-window-safe-top, 0px) + env(safe-area-inset-top, 0px) + 1rem)' }"),
    "签名认不出旧形状 ⇒ 这一格在测空气",
  );
  // 反控：单独读任何一枚都**不是**双计，别把正常的 max 出口本身也判成 offender。
  assert.ok(!SUM_RE.test("top: var(--gosslan-window-safe-top)"));
  assert.ok(!SUM_RE.test("padding-top: env(safe-area-inset-top)"));
  // 反向钉：这枚 window 变量仍然有真消费者（遮罩 + 桌面覆盖），不许因为"统一"就把它删了。
  const windowUsers = files.filter((f) => /var\(--gosslan-window-safe-top/.test(code691(readFileSync(f, "utf8"))));
  assert.ok(windowUsers.length >= 2, "--gosslan-window-safe-top 的消费者只剩 " + windowUsers.length + " 处");
});

test("㊿ BaseModal：卡片与 max-h 读出口、遮罩故意读 window、整屏面板不再自己加 env", () => {
  const src = code691(readFileSync(join(srcDir691, "components", "BaseModal.vue"), "utf8"));
  assert.equal((src.match(/top-\[var\(--gosslan-safe-top\)\]/g) || []).length, 1, "外壳的 top 只该有一处读出口");
  assert.ok(src.includes("max-h-[calc(100vh-var(--gosslan-safe-top)-2rem)]"), "卡片 max-h 必须扣同一枚出口");
  assert.ok(src.includes("top-[var(--gosslan-window-safe-top)]"), "遮罩要继续读 window 那枚（移动端=0 才铺满刘海区）");
  assert.ok(!/pt-\[env\(safe-area-inset-top/.test(src), "整屏面板里那句自己加的 env 该删了：外壳已经让位，两层都让就是双计");
});

test("㊿ 图片预览：外壳读出口、工具条只留 1rem、那个只为绕过 caption 而存在的 topInset prop 已删净", () => {
  const lb = code691(readFileSync(join(srcDir691, "components", "message", "ImageLightbox.vue"), "utf8"));
  assert.ok(/top-\[var\(--gosslan-safe-top,0px\)\]/.test(lb), "预览外壳要读出口");
  assert.ok(!/topInset/.test(lb), "prop 还在（" + (lb.match(/topInset/g) || []).length + " 处）：外壳已经读同一枚，它是没有活干的兼容层");
  const pv = code691(readFileSync(join(srcDir691, "components", "window", "PreviewWindow.vue"), "utf8"));
  assert.ok(!/top-inset/.test(pv), "预览窗还在手动传那条让位：外壳已经读同一枚");
  // 页面级整屏覆盖（没有外层 shell 让它们靠）必须继续自己读 env —— 这条不许被"统一"顺手删掉。
  const pageOwners = ["components/MobilePageFrame.vue", "components/FavoritePanel.vue"]
    .filter((r) => /pt-\[env\(safe-area-inset-top/.test(code691(readFileSync(join(srcDir691, r), "utf8"))));
  assert.equal(pageOwners.length, 2, "页面级覆盖壳自己读 env 的那两格被动了：" + pageOwners.join(","));
});

// ── 51. 图标单一家（专项 §三，§6.92）──────────────────────────────────
// 「禁止自行绘制 SVG 图标、手写图标路径」这句要能被机器咬住：
//   · 导航图标已全部走 `lucide-vue-next`（用户 2026-10-22：统一到标准图标库），
//     `navIconPaths.ts` 已删除 ⇒ 不再有"造型数据的家"这个例外；
//   · 组件里内联 <svg> 元素只许在 TitleBar.vue（OS 窗口控件，造型必须逐平台贴着真实标题栏，
//     不是应用功能图标）。
// BackArrow 此前把 lucide `chevron-left` 的 path **逐字抄进模板**（"m15 18-6-6 6-6"），
// 本轮换成库组件 —— 所以这条判据里它属于"不许再长回去"的那一格。
const SVG_ELEM_692 = /<svg[\s>][\s\S]*?<\/svg>/;
const PATH_ATTR_692 = /d\s*[:=]\s*"M/;   // 两种写法都算：模板属性 d="M…" 与数据对象 d: "M…"
// 内联 svg 只允许两处：TitleBar（窗口字形）与 BubbleTail（气泡尾巴的叶形）。
// 后者是**形状**不是图标：它要同时给出曲率连续的外缘与沿边界的 1px 描边，border/圆角拼不出来
// （用户 2026-10-23：尾巴上边不丝滑、与气泡边框接不上），而且必须是**一个家** ——
// 五个气泡组件都改成引用它，禁止各自再画一份。
const SVG_HOMES_692 = ["components/TitleBar.vue", "components/message/BubbleTail.vue"];
const listVue692 = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) listVue692(join(dir, e.name), acc);
    else if (e.name.endsWith(".vue")) acc.push(join(dir, e.name));
  }
  return acc;
};
const rel692 = (p) => p.slice(srcDir691.length + 1).split("\\").join("/");

test("51 分母：src 下的 .vue 数不许少于 60（分母塌了整条判据会白过）", () => {
  const n = listVue692(srcDir691).length;
  assert.ok(n >= 60, "只扫到 " + n + " 个 .vue");
});

test("51 内联 <svg> 元素的家恰好是 TitleBar（多一个自绘图标 ⇒ 这里红）", () => {
  const hits = listVue692(srcDir691)
    .filter((f) => SVG_ELEM_692.test(code691(readFileSync(f, "utf8"))))
    .map(rel692)
    .sort();
  assert.deepEqual(hits, [...SVG_HOMES_692].sort(), "内联 svg 的家不是登记的那个：" + hits.join(","));
  // 正控：这条判据认的是**元素**，不是文本里出现 <svg 三个字。
  assert.ok(SVG_ELEM_692.test('<svg viewBox="0 0 1 1"><path d="M0 0z" /></svg>'), "正控没匹配上 ⇒ 量具坏了");
  // 反控：GroupTasksBoard 的注释里就写着 `<svg>`，它必须**不**被算成家（按元素解析，不按行）。
  const gt = code691(readFileSync(join(srcDir691, "components", "GroupTasksBoard.vue"), "utf8"));
  assert.ok(!SVG_ELEM_692.test(gt), "GroupTasksBoard 只有注释提到 svg，却被量具认成了家");
});

test("51 手写图标路径只许在 TitleBar（*.test.ts 里的是合成针，不算）", () => {
  const files = listVue692(srcDir691).filter((f) => !f.endsWith(".test.ts"));
  const hits = files
    .filter((f) => PATH_ATTR_692.test(code691(readFileSync(f, "utf8"))))
    .map(rel692)
    .sort();
  assert.deepEqual(
    hits,
    ["components/TitleBar.vue", "components/message/BubbleTail.vue"],
    "手写图标路径的落点变了：" + hits.join(","),
  );
});

test("51 BackArrow：两档造型都出自 lucide，且 iOS 那档的分支不许被顺手抹平", () => {
  const src = code691(readFileSync(join(srcDir691, "components", "ui", "BackArrow.vue"), "utf8"));
  assert.ok(!SVG_ELEM_692.test(src), "BackArrow 又长出内联 svg 了");
  assert.ok(!/m15 18-6-6 6-6/.test(src), "库里的 chevron-left 又被抄了一遍");
  assert.ok(/import \{ ArrowLeft, ChevronLeft \} from "lucide-vue-next"/.test(src), "两个箭头都该来自 lucide");
  assert.ok(/v-if="isIOS"/.test(src) && /<ArrowLeft v-else/.test(src), "按平台给原生观感这件事是用户定的口径，不许并成一枚");
});

// ---------------- 52 「本窗口有自绘 caption」只有一个写者（2026-10-20，§6.94） ----------------
/**
 * `--gosslan-window-safe-top` 说的是"**这条窗口顶部有一条 caption，内容要让开**"，
 * 而画 caption 的人是 `TitleBar`，画不画由它的 `isMobile` **prop** 决定。
 * 改前那版把这条 CSS 挂在 `html:not(.is-mobile)` 上 —— 那是**布局档**（平台优先、
 * 宽度 ≤767 兜底，见 `resolveMobileLayout`），两个判据不是一件事：
 * `AuxWindowShell.vue:47` 与 `LogViewer.vue:236` 用 TitleBar 时**不传** isMobile（默认 false
 * ⇒ 永远画），于是日志窗（`tauri.conf` 侧默认 760×560）和任何拖窄的辅助窗
 * 「画着 caption 却报告没有 caption」⇒ 顶边算成 0，预览遮罩连右上工具条一起压进标题带。
 *
 * 现在类由 TitleBar 自己写。本条判据钉的就是「写的人 = 画的人」这一对绑定；
 * 真几何那一半在 `--only=caption` 段（窄档 + 有 caption ⇒ 遮罩仍让开，改坏即红）。
 */
const CSS_KEY_694 = /html\.has-caption\s*\{[^}]*--gosslan-window-safe-top:\s*var\(--gosslan-title-h\)/;
const LAYOUT_KEY_694 = /html:not\(\.is-mobile\)\s*\{[^}]*--gosslan-window-safe-top/;

test("52 让位的键是 has-caption，而且只挂这一处（布局档那条已经拆掉）", () => {
  const css = code691(readFileSync(join(srcDir691, "style.css"), "utf8"));
  assert.equal((css.match(/--gosslan-window-safe-top:\s*var\(--gosslan-title-h\)/g) || []).length, 1,
    "桌面覆盖的定义处应当只有一处");
  assert.ok(CSS_KEY_694.test(css), "--gosslan-window-safe-top 的桌面覆盖必须挂在 html.has-caption 上");
  assert.ok(!LAYOUT_KEY_694.test(css),
    "又把它挂回布局档了：窄起来的桌面辅助窗画着 caption，却会被判成「没有 caption」");
  // 正控：针认得出旧形状（认不出 ⇒ 上面那条缺席断言在测空气）
  assert.ok(LAYOUT_KEY_694.test("html:not(.is-mobile) { --gosslan-window-safe-top: var(--gosslan-title-h); }"),
    "缺席针认不出改前的形状 ⇒ 它咬不住");
});

test("52 has-caption 的写者恰好是 TitleBar 一处，且与 caption 的渲染条件是同一个判断", () => {
  const files = walk691(srcDir691);
  assert.ok(files.length >= 200, "只扫到 " + files.length + " 份生产码 ⇒ 路径写错了，这条是在测空气");
  // 写者 ≠ 提过这个名字的地方：CSS 那一处是**读者**（拿它当选择器），把它算成写者这条就恒红了。
  const WRITE_694 = /classList\.(?:toggle|add|remove)\(\s*["']has-caption["']/;
  const writers = files
    .filter((f) => WRITE_694.test(code691(readFileSync(f, "utf8"))))
    .map((f) => f.slice(srcDir691.length + 1));
  assert.deepEqual(writers, ["components/TitleBar.vue"],
    "「这条窗有 caption」不该有第二个写者（实得 " + writers.join(",") + "）");
  // 正控：针认得出"别的组件也去写"这件事（认不出 ⇒ 上面那条 deepEqual 是空的）
  assert.ok(WRITE_694.test(`document.documentElement.classList.toggle("has-caption", !m)`),
    "写者针认不出形状 ⇒ 这一格在测空气");
  assert.ok(!WRITE_694.test("html.has-caption { --gosslan-window-safe-top: var(--gosslan-title-h); }"),
    "CSS 那条选择器是读者，不许被算进写者名单");
  const tb = code691(readFileSync(join(srcDir691, "components", "TitleBar.vue"), "utf8"));
  assert.ok(/v-if="!isMobile"/.test(tb), "caption 自己的渲染条件不在了：写者与画者已不是同一处判断");
  assert.ok(/classList\.toggle\("has-caption", !mobile\)/.test(tb),
    "那个类不再跟着 isMobile 翻 ⇒ 主窗拖窄/放大时会让位状态停在中途");
  // 反向钉：读侧消费者还在（别把出口删了来"满足"这条）
  const users = files.filter((f) => /var\(--gosslan-window-safe-top/.test(code691(readFileSync(f, "utf8"))));
  assert.ok(users.length >= 2, "--gosslan-window-safe-top 的消费者只剩 " + users.length + " 处");
});

// ---------------- 53 「回车 = 一个动作」的可编辑字段必须过输入法守卫（2026-10-20，§6.95） ----------------
/**
 * 用户 2026-09-12 报的原话是「输入拼音，按回车应该是把拼音字母落下来……中文却发出去了」。
 * `composables/useImeEnterGuard` 的文档自己把规矩写成**普适**的一条：
 * 「只要某处"回车 = 触发一个动作"（发送、打开搜索、提交表单），就会踩同一个坑」。
 * 而本批改前，全仓只有 3 处接了守卫，另外 9 处（组名、任务标题、自定义分类、链接名、
 * 昵称、中继地址/token、接入点）都让业务码自己 `@keyup.enter="保存"` ——
 * 其中 6 个字段是**注定会被打中文**的自由文本，代价是把半成品存进库。
 *
 * 所以这条判据钉的不是"某个文件里有守卫"，而是**轴**：
 * 凡「可编辑元素 + keydown/keyup 绑定」⇒ 该文件必须引这个家。漏一处就红。
 *
 * ⚠️ 2026-10-23 又量到第二型：模板写 `ime.enter(fn)`（没传 `$event`）时，
 *    Vue 把内联绑定编译成 `($event) => ime.enter(fn)` —— 返回的处理器被丢掉，
 *    回车**静默不执行**。全仓 16 处当时都是这个形状，用户的原话正是"不用每次自己手点"。
 *    所以这条同时钉「引家」和「内联调用必须拿到事件」两件事。
 *
 * ⚠️ 解析按**起始标签**逐元素走，不按行：本仓的 `<input>` 属性是跨 6~10 行写的，
 *    按行搜 `@keydown.enter` 会把"标签是 input"这个前提丢掉（也就会把 tabindex 卡片算进来）。
 */
const EDITABLE_TAG_693 = /^(input|textarea)$/i;
const KEY_BIND_693 = /(?:@|v-on:)(?:keydown|keyup)(?:\.[a-z-]+)*[=]/i;
const ENTER_BIND_693 = /(?:@|v-on:)(?:keydown|keyup)(?:\.[a-z-]+)*\.enter\b/i;
const GUARD_REF_693 = /useImeEnterGuard|isImeKey/;
/**
 * 模板内联绑定里调用了 `ime.enter(fn)` 却没把事件传进去的那些。
 *
 * Vue 把 `@keydown.enter="ime.enter(fn)"` 编译成 `($event) => ime.enter(fn)`：
 * 表达式执行了，但**返回的处理器被丢掉**，动作永远不执行。2026-10-23 探针实测：
 * 补上 `$event` 之前，链接表单的回车「按了、preventDefault 也发生了，但 saveDraft 一次都没跑」。
 * 所以「引了这个家」还不够，内联绑定必须写成 `ime.enter(fn, $event)`（或把返回值绑成处理器）。
 */
const INLINE_KEY_ATTR_693 = /(?:@|v-on:)(?:keydown|keyup)(?:\.[a-z-]+)*\s*=\s*"([^"]*)"/gi;
function inlineEnterWithoutEvent693(text) {
  const bad = [];
  for (const { tag, attrs } of startTags693(text)) {
    for (const m of attrs.matchAll(INLINE_KEY_ATTR_693)) {
      if (/ime\.enter\(/.test(m[1]) && !/\$event/.test(m[1])) bad.push(`${tag}: ${m[1]}`);
    }
  }
  return bad;
}

/** 从源码里摘出每个**起始标签**的 `{tag, attrs}`（属性里的引号、跨行都算进同一个元素）。 */
function startTags693(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "<") continue;
    if (text[i + 1] === "!" || text[i + 1] === "/") continue;
    let j = i + 1;
    while (j < text.length && /[A-Za-z0-9_.-]/.test(text[j])) j++;
    const tag = text.slice(i + 1, j).toLowerCase();
    if (!tag) continue;
    let k = j;
    let q = "";
    while (k < text.length) {
      const c = text[k];
      if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") break;
      k++;
    }
    out.push({ tag, attrs: text.slice(j, k) });
    i = k;
  }
  return out;
}
/** 该源码里「可编辑元素 + 挂了 key/keyup 绑定」的那些起始标签。 */
const editableKeyBinds693 = (text) =>
  startTags693(text).filter(({ tag, attrs }) =>
    (EDITABLE_TAG_693.test(tag) || /contenteditable/i.test(attrs)) && KEY_BIND_693.test(attrs));

test("53 可编辑元素上的按键绑定：必须引输入法守卫这个家，且 ime.enter 必须拿到 $event（漏一处就红）", () => {
  const files = walk691(srcDir691).filter((f) => f.endsWith(".vue"));
  assert.ok(files.length >= 60, "只扫到 " + files.length + " 份 .vue ⇒ 分母塌了，下面是在测空气");
  const missing = [];
  const droppedEvent = [];
  let enterBinds = 0;
  let keyBinds = 0;
  for (const f of files) {
    const src = code691(readFileSync(f, "utf8"));
    const binds = editableKeyBinds693(src);
    keyBinds += binds.length;
    enterBinds += binds.filter((b) => ENTER_BIND_693.test(b.attrs)).length;
    if (binds.length && !GUARD_REF_693.test(src)) {
      missing.push(rel692(f) + "(" + binds.map((b) => b.tag).join(",") + ")");
    }
    const bad = inlineEnterWithoutEvent693(src);
    if (bad.length) droppedEvent.push(rel692(f) + "(" + bad.join(" | ") + ")");
  }
  assert.deepEqual(missing, [], "这些可编辑字段挂了按键动作却没引守卫：" + missing.join(" "));
  assert.deepEqual(droppedEvent, [],
    "模板里 ime.enter(fn) 没传 $event（Vue 会丢掉返回的处理器，回车静默失效）：" + droppedEvent.join(" "));
  // 分母现算 + 下限：提取器一旦漂成认不出（比如只按行搜），上面那条会白过。
  assert.ok(keyBinds >= 10, "只认出 " + keyBinds + " 处「可编辑元素+按键绑定」，比这批的实测值少 ⇒ 提取器漂了");
  assert.ok(enterBinds >= 9, "只认出 " + enterBinds + " 处 Enter 提交，改前实测是 11 ⇒ 提取器漂了");
});

test("53 量具自己：正控认得出漏守卫的输入框，反控不许把 tabindex 卡片算进来", () => {
  // 正控：跨行写的 input + keyup.enter —— 改前那 9 处就是这个形状，认不出它 ⇒ 判据咬不住
  const pos = editableKeyBinds693(`<template>
  <input
    v-model="name"
    class="w-full"
    @keyup.enter="saveName"
  />
</template>`);
  assert.equal(pos.length, 1, "正控没被认出来（跨行属性）：" + JSON.stringify(pos));
  assert.ok(ENTER_BIND_693.test(pos[0].attrs), "正控没被认成 Enter 提交");
  // 反控：非可编辑元素上的 .enter 不该进分母（否则有人删掉列表项的回车绑定就能"满足"那条）
  assert.equal(editableKeyBinds693(`<li tabindex="0" @keydown.enter.prevent="openConv(c)">x</li>`).length, 0,
    "tabindex 卡片被算成可编辑字段了 —— 那里根本不会有输入法组合");
  // 反控之二：属性值里带 ">" 的引号内文本不许提前结束标签
  const quoted = editableKeyBinds693(`<input :placeholder="a > b ? 'x' : '搜索'" @keydown.enter="save" />`);
  assert.equal(quoted.length, 1, "引号里的 > 把标签切断了：" + JSON.stringify(quoted));
  // 正控：丢 `$event` 的写法必须被认出来；反控：传了事件（或直接绑处理器）不许误伤。
  assert.equal(inlineEnterWithoutEvent693(`<input @keydown.enter="ime.enter(save)" />`).length, 1,
    "丢 $event 的内联写法没被认出来 ⇒ 上面那条缺席断言在测空气");
  assert.equal(inlineEnterWithoutEvent693(`<input @keydown.enter="ime.enter(save, $event)" />`).length, 0,
    "正确写法被误判成丢事件");
  assert.equal(inlineEnterWithoutEvent693(`<input @keydown.enter="ime.enter(save)($event)" />`).length, 0,
    "显式调用返回处理器的写法被误判成丢事件");
});

test("53 家还是那一个：四个出口齐、enter 走 isImeKey、模板接线统一成 ime.enter", () => {
  const home = readFileSync(join(srcDir691, "composables", "useImeEnterGuard.ts"), "utf8");
  for (const exit of ["onStart", "onEnd", "isIme", "enter"]) {
    assert.ok(new RegExp(exit + "\\s*:").test(home), "composable 少了 " + exit + " 这个出口");
  }
  assert.equal((home.match(/isImeKey\(/g) || []).length, 2,
    "enter 与 isIme 必须都走 utils/ime 那一份判定（各 1 次），不许在这儿另写 e.isComposing");
  assert.ok(!/e\.isComposing/.test(home), "家自己不许手写单条 isComposing —— 那正是原缺陷的成因");

  const files = walk691(srcDir691).filter((f) => f.endsWith(".vue"));
  const wired = files.filter((f) => /ime\.enter\(/.test(code691(readFileSync(f, "utf8"))));
  assert.ok(wired.length >= 5,
    "ime.enter 的模板接线只剩 " + wired.length + " 处 —— 退回逐处手包事件函数就等于把这条规矩交给人记");
  const users = files.filter((f) => GUARD_REF_693.test(code691(readFileSync(f, "utf8"))));
  assert.ok(users.length >= 8, "引这个家的文件数掉到 " + users.length + "（实测 9 处 Enter 提交分布在 8 个文件里）");
});

// ── 54. 字号令牌（专项 §四，2026-10-20）────────────────────────────────
// 不是"把 265 处换成 6 个名字"就完：像素必须逐档不变，且行高不许被 Tailwind 默认值改掉。
test("㊿ 字号只走令牌：生产码 0 处 text-[NNpx]，且六档像素/行高映射与 config 对齐", () => {
  const ARB = /text-\[[0-9][0-9]*px\]/;
  const files = walk691(srcDir691).filter((f) => !f.endsWith(".css"));
  assert.ok(files.length >= 200, "只扫到 " + files.length + " 份生产码 ⇒ 路径写错了，这条是在测空气");
  const offenders = files
    .filter((f) => ARB.test(code691(readFileSync(f, "utf8"))))
    .map((f) => f.slice(srcDir691.length + 1));
  assert.deepEqual(offenders, [], "又写死了字号（应为 micro/caption/meta/body/emphasis/title）：" + offenders.join(", "));

  // 正控：迁移前的真实形状必须被认出来；反控：令牌名本身不是 offender。
  assert.ok(ARB.test("class=\"text-[13px]\""), "签名认不出旧形状 ⇒ 这一格在测空气");
  assert.ok(!ARB.test("class=\"text-body\""));

  const cfg = readFileSync(join(srcDir691, "..", "tailwind.config.js"), "utf8");
  for (const [name, px] of [
    ["micro", 10],
    ["caption", 11],
    ["meta", 12],
    ["body", 13],
    ["emphasis", 14],
    ["title", 15],
  ] as const) {
    assert.ok(
      cfg.includes(`${name}: ["${px}px", { lineHeight: "inherit" }]`),
      `字号令牌 ${name} 必须是 ${px}px 且 line-height: inherit（行高被默认值改掉＝整站变紧）`,
    );
  }
});

/**
 * 列表行的「长按 = 右键菜单」曾有两个**逐字相同**的实现（会话行 / 好友行）：
 * 各自的计时器、10px 容差、click 抑制，注释里靠"与另一个文件一致"维持同步。
 * 这条钉住"只有一份"：判据读代码（剥注释），两个组件只许绑定共享 composable。
 */
test("51 列表行长按只有一份实现：两个列表项都走 usePressMenu，且不许再自带计时器", () => {
  const items = [
    "components/conversation/ConversationListItem.vue",
    "components/conversation/FriendListItem.vue",
  ];
  for (const rel of items) {
    const src = code691(readFileSync(join(srcDir691, rel), "utf8"));
    assert.match(src, /usePressMenu</, `${rel} 必须用共享的长按实现`);
    assert.match(src, /press\.consumeSuppressedClick\(\)/, `${rel} 的点击入口必须问"这次 click 该不该丢"`);
    assert.doesNotMatch(src, /setTimeout\(/, `${rel} 里又出现了自己的长按计时器`);
    assert.doesNotMatch(src, /PRESS_MOVE_TOLERANCE|LONG_PRESS_MS/, `${rel} 不许再自己记 500ms / 10px 这两个阈值`);
  }
  const composable = code691(readFileSync(join(srcDir691, "composables/usePressMenu.ts"), "utf8"));
  assert.equal(
    (composable.match(/setTimeout\(/g) ?? []).length,
    1,
    "长按计时器只许在 usePressMenu 里出现一次（两份就是回到了重构前）",
  );
  assert.match(composable, /haptic\("heavy"\)/, "长按触觉是菜单弹出的反馈，别在重构里丢");
});

/**
 * 弹窗内嵌列表的三态（加载 / 空 / 错误）：各写一段内联 div 是这仓最老的重复形状之一，
 * 共享目录此前连加载态都没有 ⇒ 打开弹窗先是一片空白，用户分不清"在读"与"对方没文件"。
 * 这条钉住三个面板都走 StateBlock 的 compact 形态。
 */
test("52 弹窗列表三态走 StateBlock：不允许再各写一段内联 div", () => {
  const cases = [
    { rel: "components/ShareDirectory.vue", kinds: ["loading", "empty", "error"] },
    { rel: "components/GroupFilesPanel.vue", kinds: ["loading", "empty", "error"] },
    { rel: "components/DevDiagPanel.vue", kinds: ["loading", "error"] },
  ];
  for (const c of cases) {
    const src = code691(readFileSync(join(srcDir691, c.rel), "utf8"));
    for (const k of c.kinds) {
      assert.ok(src.includes(`kind="${k}"`), `${c.rel} 缺少 kind="${k}" 的统一状态块`);
    }
    assert.doesNotMatch(src, /role="alert" class="space-y-2 py-4/, `${c.rel} 又长回手写错误块`);
    assert.doesNotMatch(
      src,
      /flex items-center justify-center gap-2 py-8/,
      `${c.rel} 又长回手写加载块`,
    );
  }
});

/// P2-12：收藏预览不能把 objectURL 当永久值 —— blobLru 逐出时会 revoke，
/// 死字符串仍是 truthy；灯箱必须向缓存现取，缩略图坏了要能重载。
test("收藏预览不缓存裸 objectURL：灯箱现取、缩略图坏了重载", () => {
  const src = readFileSync(new URL("../components/FavoritePanel.vue", import.meta.url), "utf8");
  assert.match(src, /favoritePreviewUrl\(f\.id\)\s*\?\?/, "灯箱必须先向缓存要当前 URL");
  assert.match(src, /@error="refreshThumb\(/, "缩略图加载失败要触发重载");
  assert.doesNotMatch(
    src,
    /const url = thumbs\.value\[f\.id\] \?\?/,
    "不许直接信任可能已被 LRU revoke 的字符串",
  );
});

/// P3-15：待办缩略图的退避重试不能无限续命 —— 一份永远不会到的字节会让每个缩略图
/// 每 ≤30s 发 2 次 IPC，直到组件卸载。
test("待办缩略图退避重试有次数上限，用尽后落到「已被清理」", () => {
  const src = readFileSync(new URL("../components/TodoImageThumb.vue", import.meta.url), "utf8");
  assert.match(src, /MAX_RETRY_ATTEMPTS\s*=\s*10/, "必须有明确的次数上限");
  assert.match(src, /attempts\s*>=\s*MAX_RETRY_ATTEMPTS/, "到上限必须停止安排下一次");
  assert.match(src, /msg\.imageCleaned/, "用尽后要给出终态文案，而不是永远「同步中」");
});

// ---------------- motion-v 唯一入口 ----------------
//
// 用户 2026-10-22 裁决重新引入 motion-v。引入不是「每个组件各自 import」：
// 统一走 `src/utils/motion/index.ts`，升级/回滚只改一处；同时给所有 JS 动画
// 留出统一的 reduced-motion 接入点。
test("motion-v 只能从统一封装层导入（业务码不得直连）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(ts|vue)$/.test(e.name) && !e.name.endsWith(".test.ts")) acc.push(p);
    }
    return acc;
  };
  const files = walk(srcDir);
  assert.ok(files.length > 100, `只扫到 ${files.length} 份源码 ⇒ 遍历路径可能坏了`);
  const wrapper = join(srcDir, "utils", "motion", "index.ts");
  const re = /from\s+["']motion-v["']/;
  const offenders = files
    .filter((f) => f !== wrapper)
    .filter((f) => re.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(srcDir.length + 1));
  assert.deepEqual(offenders, [], `以下文件绕过封装层直接 import motion-v：\n${offenders.join("\n")}`);
  // 正控：封装层自己必须真的在 re-export；否则上面那句「没人直连」可以靠删掉依赖也变绿。
  assert.match(readFileSync(wrapper, "utf8"), re, "封装层没有 re-export motion-v");
  assert.ok(re.test('import { motion } from "motion-v"'), "扫描正则没匹配上合成针 ⇒ 判据空转");
  console.log(`· motion-v 唯一入口：扫 ${files.length} 份源码，直连 0 处`);
});

// ---------------- 浮层动效的进出对称 + 曲线唯一来源 ----------------
//
// 设计文档 §11.3.2「新增动效不另写曲线」与 §11.3.3「浮层进出 160–260ms」此前**没有任何机器判据**
// （全文件此前搜不到一条时长/曲线/退场类断言）。实测后果就在 2026-10-22 之前：`src/style.css` 里
// 菜单只有 `[data-state="open"]` 一条动画 ⇒ Reka 的 Presence 在关闭时等不到任何动画，
// 菜单「唰」一下直接消失；这条漂移不会让任何东西变红，而它是用户说的"不丝滑"里最大的一条。
// 两条判据的分母都从 CSS 自己解析，不手抄类名清单（手抄必漂）。
const STYLE_CSS = join(import.meta.dirname, "..", "style.css");

/** 剥掉 CSS 注释：规范里那句「用**强 ease-out**」是文档不是声明，不能算违规；
 *  反过来，判据也不能被自己写在 CSS 里的注释喂出假绿。 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** `transition:` / `animation:` 声明里出现的 CSS 关键字曲线（`--gosslan-ease*` 定义行本身不是声明，天然被排除）。 */
function findRawEasingCurves(css: string): string[] {
  const hits: string[] = [];
  for (const m of stripCssComments(css).matchAll(/\b(?:transition|animation)\s*:\s*([^;{}]*)/g)) {
    if (/\b(?:ease-out|ease-in-out|ease-in)\b/.test(m[1])) hits.push(m[1].trim().slice(0, 90));
  }
  return hits;
}

/** 出现过 `[data-state="open"]` 却没有任何 `[data-state="closed"]` 规则的类名 ⇒ 只有进没有出。 */
function findOverlaysWithoutExit(css: string): string[] {
  const opened = new Set<string>();
  const closed = new Set<string>();
  for (const m of stripCssComments(css).matchAll(/\.([A-Za-z0-9_-]+)\[data-state="(open|closed)"\]/g)) {
    (m[2] === "open" ? opened : closed).add(m[1]);
  }
  return [...opened].filter((name) => !closed.has(name));
}

test("动效曲线只能来自令牌：transition/animation 里不许写 CSS 关键字曲线", () => {
  // 正控：合成针必须被抓到 —— 否则"真实树 0 处"可能只是正则空转。
  assert.deepEqual(findRawEasingCurves(".a { animation: x 120ms ease-out; }"), ["x 120ms ease-out"]);
  assert.deepEqual(
    findRawEasingCurves("/* 规范里写着 强 ease-out */\n.a { transition: opacity 150ms var(--gosslan-ease); }"),
    [],
    "注释里的曲线名被当成声明 ⇒ 判据会把文档算成违规",
  );
  assert.deepEqual(findRawEasingCurves(".a { animation: x 160ms var(--gosslan-ease); }"), []);

  const css = readFileSync(STYLE_CSS, "utf8");
  const decls = [...stripCssComments(css).matchAll(/\b(?:transition|animation)\s*:/g)].length;
  assert.ok(decls > 20, `只扫到 ${decls} 条动效声明 ⇒ 遍历或正则已失效，这条判据正在空转`);
  const offenders = findRawEasingCurves(css);
  assert.deepEqual(
    offenders,
    [],
    `style.css 有 ${offenders.length} 条动效声明绕开令牌曲线（§11.3.2「新增动效不另写曲线」）：\n${offenders.join("\n")}`,
  );
  console.log(`· 曲线令牌：扫 ${decls} 条 transition/animation 声明，关键字曲线 0 处`);
});

/**
 * 「进度条不许用布局属性做动画」（§14.6）的**仓库级**判据。
 *
 * 为什么需要它（2026-10-22 当晚实测到的复发）：S-5 把 `ChatWindow` 那一块从
 * `transition-[width]` 改成 `transform: scaleX`，但**只改了那一个组件、没留仓库级判据**；
 * 几小时后「应用内更新」的进度条又把 `transition-[width]` + `width:%` 写了回来
 * （`settings/UpdatePanel.vue`）。单点修复没有判据 = 下一个人重新犯一次。
 *
 * 分母从真实 `.vue` 文件现数，不手抄清单：遍历失效时这条会先报"扫到的文件太少"，
 * 而不是安静地判零处违规。只扫模板（缺陷只可能出现在模板的 class 里）——
 * 本测试文件自己就写着 `transition-[width]` 这几个字，把 `.ts` 也扫进来等于让判据咬自己。
 */
test("进度动画不许动布局属性：组件里的 transition-[width]/[height] 必须为 0", () => {
  const LAYOUT_ANIM = /transition-\[(width|height|top|left|right|bottom)\]/;
  // 正控：判据必须咬得住那种写法，否则「真实树 0 处」只是正则空转。
  assert.equal(LAYOUT_ANIM.test('<div class="h-full transition-[width] duration-200">'), true);
  assert.equal(LAYOUT_ANIM.test('<div class="transition-transform duration-200">'), false);
  assert.equal(LAYOUT_ANIM.test('<div class="transition-[height]">'), true);

  const root = join(import.meta.dirname, "..");
  const offenders: string[] = [];
  let scanned = 0;
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".vue")) {
        scanned += 1;
        for (const [i, line] of readFileSync(p, "utf8").split("\n").entries()) {
          if (LAYOUT_ANIM.test(line)) {
            offenders.push(`${p.slice(root.length + 1)}:${i + 1}  ${line.trim().slice(0, 100)}`);
          }
        }
      }
    }
  })(root);
  assert.ok(scanned >= 80, `只扫到 ${scanned} 个 .vue ⇒ 遍历已失效，这条判据正在空转`);
  assert.deepEqual(
    offenders,
    [],
    `有 ${offenders.length} 处拿布局属性做动画（§14.6 要求 transform: scaleX/translateY）：\n${offenders.join("\n")}`,
  );
});

test("浮层动效进出必须成对：只有 open 一条等于没有退场", () => {
  // 正控：缺一半的合成 CSS 必须被点名。
  assert.deepEqual(
    findOverlaysWithoutExit('.x[data-state="open"] {}\n.x[data-state="closed"] {}\n.y[data-state="open"] {}'),
    ["y"],
  );
  // 反向钉：改动前的真实 CSS 就是这条的形状（菜单只有 open）⇒ 判据曾经抓得到真缺陷，不是摆设。
  assert.ok(
    findOverlaysWithoutExit('.gosslan-menu[data-state="open"] { animation: f 140ms; }').length === 1,
    "还原到改动前的菜单形状时必须报出缺退场",
  );

  const css = readFileSync(STYLE_CSS, "utf8");
  assert.ok(css.includes('[data-state="open"]'), "真实 CSS 里扫不到浮层状态选择器 ⇒ 判据已空转");
  const missing = findOverlaysWithoutExit(css);
  assert.deepEqual(missing, [], `以下浮层只有入场、没有退场动画：${missing.join("、")}`);
  const opened = new Set(
    [...stripCssComments(css).matchAll(/\.([A-Za-z0-9_-]+)\[data-state="open"\]/g)].map((m) => m[1]),
  );
  console.log(`· 浮层进出成对：${opened.size} 个带 open 态的浮层类全部有 closed 对应`);
});

// ---------------- 文件进度必须有可读的语义出口 ----------------
//
// 10-22 审计 D-25 / R-32：文件气泡的进度条此前只是一个 `h-1` 的 div —— 没有 `role="progressbar"`、
// 没有 `aria-valuenow`，而「接收中 62% → 网络停滞 → 已取消」那行状态文案也不是 live region。
// 这类缺失**永远不会响**：视觉上一切正常，读屏用户只知道有个百分比数字（还读不到），
// 停滞与失败在无障碍通道上是同一句沉默。规范 §14 要「无障碍文本等价物」，这条是它的机器化。
// 判据只走形状计数，不写死文案：文案换了不该红，语义掉了必须红。
function countProgressbarContract(template: string): { role: number; valuenow: number; live: number } {
  return {
    role: (template.match(/role="progressbar"/g) ?? []).length,
    valuenow: (template.match(/aria-valuenow/g) ?? []).length,
    live: (template.match(/aria-live=/g) ?? []).length,
  };
}

test("文件进度条必须成对给出 progressbar 语义，状态行必须落在常驻 live region 里", () => {
  // 正控：缺一半的形状必须被数出来，否则"真实树全齐"可能只是正则空转。
  assert.deepEqual(countProgressbarContract('<div role="progressbar"></div>'), {
    role: 1,
    valuenow: 0,
    live: 0,
  });
  assert.deepEqual(
    countProgressbarContract('<div role="progressbar" aria-valuenow="40"></div><div aria-live="polite"></div>'),
    { role: 1, valuenow: 1, live: 1 },
  );

  const src = readFileSync(join(import.meta.dirname, "..", "components", "message", "MessageFileBubble.vue"), "utf8");
  const { role, valuenow, live } = countProgressbarContract(src);
  assert.ok(role >= 1, "文件进度条没有 role=\"progressbar\" ⇒ 读屏报不出这是一个进度");
  // 出现次数而不是存在性：同一段模板里每有一个 progressbar 就必须有一个当前值。
  assert.equal(valuenow, role, `progressbar ${role} 个但 aria-valuenow ${valuenow} 个 —— 有进度却没数值`);
  assert.ok(live >= 1, "状态文案行没有 live region ⇒ 「网络停滞 / 已取消」这类切换无人播报");
  // live region 必须常驻：`aria-live` 挂在带 v-if 的元素上 = 变化前节点还不在 DOM 里，播报不可靠。
  assert.ok(
    !/v-if="[^"]*"[^>]*aria-live=/.test(src),
    "live region 不许挂在 v-if 元素上（内容变化之前它必须已经存在于 DOM）",
  );
  console.log(`· 文件进度语义：progressbar ${role} 个 / aria-valuenow ${valuenow} 个 / live region ${live} 处`);
});

// ---------------- 图片不做 layout 补间 ----------------
//
// 缩略图高度会随解码从骨架高度变成真实高度；如果给它 layoutId/layout 补间，
// 切会话时就会看到「图片从底部往上拉伸」。苹果消息的做法是整列短淡入、单图瞬时落定，
// 所以这里反向钉住：缩略图这一侧**不许**再出现 layoutId。灯箱自己的 reduce 分支仍在。
test("图片气泡与灯箱都不做 layout 补间，灯箱保留 reduced-motion 开关", () => {
  const srcDir = join(import.meta.dirname, "..");
  const item = readFileSync(join(srcDir, "components", "MessageItem.vue"), "utf8");
  const bubble = readFileSync(join(srcDir, "components", "message", "MessageImageBubble.vue"), "utf8");
  const lightbox = readFileSync(join(srcDir, "components", "message", "ImageLightbox.vue"), "utf8");
  assert.ok(!/layout-id=/.test(item), "消息缩略图又传了 layoutId（会重新引入图片拉伸）");
  assert.ok(!/layout-id|layoutId/.test(bubble.replace(/<!--[\s\S]*?-->/g, "")),
    "MessageImageBubble 又在模板/脚本里消费 layoutId");
  assert.ok(!/layout-id|activeLayoutId/.test(lightbox.replace(/<!--[\s\S]*?-->/g, "")),
    "灯箱还留着单边 layoutId（没有对端，属于死契约）");
  assert.match(lightbox, /useReducedMotion/, "灯箱没有 reduced-motion 分支");
});

test("会话切换只做整列短淡入，不给消息/图片做逐项进场", () => {
  const chat = readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8");
  assert.match(chat, /const listSwitching = ref\(false\)/, "ChatWindow 没有会话切换的淡入状态");
  assert.match(chat, /function revealListAfterLayout\(\)/, "ChatWindow 没有「布局落定后再揭示」的出口");
  assert.match(chat, /:class="listSwitching \? 'opacity-0' : 'opacity-100'"/, "消息列表没有整列淡入");
  assert.ok(!/<TransitionGroup/.test(chat), "消息行不该再逐项进场（会表现成从上往下铺）");
});

test("移动端全屏搜索/群任务只留一层滚动，搜索时底栏不挂在下面", () => {
  const base = readFileSync(join(import.meta.dirname, "..", "components", "BaseModal.vue"), "utf8");
  const search = readFileSync(
    join(import.meta.dirname, "..", "components", "search", "ChatSearchDialog.vue"), "utf8");
  const panel = readFileSync(join(import.meta.dirname, "..", "components", "GroupTasksPanel.vue"), "utf8");
  const board = readFileSync(join(import.meta.dirname, "..", "components", "GroupTasksBoard.vue"), "utf8");
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(base, /contained\?: boolean/, "BaseModal 没有“页面自己管滚动”的整页开关");
  assert.match(base, /contained \? 'overflow-hidden'/, "整页 contained 仍让外层滚动");
  assert.match(search, /\bcontained\b/, "搜索没有启用单滚动整页");
  assert.match(panel, /:contained="fullscreen"/, "群任务移动端没有启用单滚动整页");
  assert.match(panel, /:fill="fullscreen"/, "群任务面板没有让看板撑满整页高度");
  assert.match(board, /standalone \|\| fill \? 'h-full min-h-0'/, "看板 fill 没有撑满高度");
  assert.match(layout, /!searchOpen\.value/, "搜索打开时底栏仍显示/可点");
});

test("群成员弹窗只有一层滚动（成员列表不再自造 max-h + overflow）", () => {
  const panel = readFileSync(join(import.meta.dirname, "..", "components", "GroupMemberPanel.vue"), "utf8");
  assert.ok(!/max-h-56\s+overflow-y-auto/.test(panel), "群成员列表又加了内层滚动");
});

test("聊天头像进入好友资料，且群内非好友有兜底", () => {
  const item = readFileSync(join(import.meta.dirname, "..", "components", "MessageItem.vue"), "utf8");
  const chat = readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8");
  assert.match(item, /emit\(['"]open-profile['"], message\.sender_id\)/, "消息头像没有上抛资料意图");
  assert.match(chat, /function openSenderProfile\(/, "ChatWindow 没有接头像资料");
  assert.match(chat, /router\.push\(\{ name: "friend", params: \{ friendId: senderId \} \}\)/,
    "头像没有进入通讯录同一个好友资料路由");
  assert.match(chat, /if \(isGroup\.value\) membersOpen\.value = true/, "群内非好友头像没有兜底");
});

test("预览失败有 10 秒负缓存，避免群历史缺文件时重试风暴", () => {
  const fp = readFileSync(join(import.meta.dirname, "..", "utils", "filePreview.ts"), "utf8");
  assert.match(fp, /NEGATIVE_TTL_MS/, "filePreview 没有失败负缓存");
  assert.match(fp, /negativeBlocked\(msgId\)/, "loadFilePreview 没先查负缓存");
  assert.match(fp, /markNegative\(msgId\)/, "transient 失败没有被挡住");
  assert.match(fp, /invalidateFilePreview[\s\S]{0,200}clearNegative\(msgId\)/,
    "文件落盘失效时没有清负缓存（会把后来到的字节挡住）");
});

test("外链导入导出三条路径都真接线（文件 / 线上 / 导出清理）", () => {
  const links = readFileSync(join(import.meta.dirname, "..", "components", "LinksList.vue"), "utf8");
  const api = readFileSync(join(import.meta.dirname, "..", "api", "index.ts"), "utf8");
  for (const cmd of ["export_external_links", "import_external_links_file", "import_external_links_from_url"]) {
    assert.match(api, new RegExp(`invoke<[^>]*>\\(\"${cmd}\"`), `${cmd} 没在 api 层接线`);
  }
  assert.match(links, /async function exportLinks\(\)/, "LinksList 没有导出动作");
  assert.match(links, /async function importFile\(\)/, "LinksList 没有文件导入动作");
  assert.match(links, /async function importFromUrl\(\)/, "LinksList 没有线上导入动作");
  assert.match(links, /api\.importPickedFile\(/, "移动端 content:// 没有先落地");
  assert.match(links, /cleanupExternalLinksExport/, "导出临时文件没有清理");
});

test("外链入口都有可见文案，且新增/编辑与导入各自一个弹窗（导入不混进新增/编辑）", () => {
  const links = readFileSync(join(import.meta.dirname, "..", "components", "LinksList.vue"), "utf8");
  // 可见文案 = 模板文本节点，而不只是 title/aria-label（否则又退回"看图标猜功能"）。
  const visibleText = (key: string) =>
    new RegExp(`\\{\\{\\s*t\\(\\s*["']${key.replaceAll(".", "\\.")}["']\\s*\\)\\s*\\}\\}`).test(links);
  for (const key of ["links.add", "links.import", "links.export"]) {
    assert.ok(visibleText(key), `${key} 没有渲染成可见文案（又退回只有图标/title 的按钮了）`);
  }
  const blockOf = (open: string) => {
    const start = links.indexOf(`:open="${open}"`);
    assert.ok(start >= 0, `找不到 ${open} 弹窗`);
    const end = links.indexOf("</BaseModal>", start);
    assert.ok(end > start, `${open} 弹窗没有闭合标签`);
    return links.slice(start, end);
  };
  const edit = blockOf("dialogOpen");
  const imp = blockOf("importOpen");
  assert.match(edit, /draft\.name/, "dialogOpen 切块没切到表单内容 ⇒ 下面的缺席断言在测空串");
  assert.match(imp, /importFile/, "导入弹窗没有文件导入动作");
  assert.match(imp, /importFromUrl/, "导入弹窗没有网址导入动作");
  assert.doesNotMatch(edit, /importFile|importFromUrl/, "新增/编辑弹窗里又混进了导入动作");
  assert.doesNotMatch(edit, /exportLinks/, "备份动作不该塞进新增/编辑弹窗");
});

test("确认型表单支持回车：建群、群公告、任务草稿各自接到保存动作", () => {
  // 单行输入用裸 Enter；textarea 的裸 Enter 属于换行，所以用 ⌘/Ctrl+Enter 提交。
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", "components", p), "utf8");
  const create = read("GroupCreateModal.vue");
  assert.match(create, /@keydown\.enter="ime\.enter\(create, \$event\)"/,
    "建群名称回车没有接到 create（或没把 $event 传进去）");
  const member = read("GroupMemberPanel.vue");
  for (const mod of ["meta", "ctrl"]) {
    assert.match(member, new RegExp(`@keydown\\.${mod}\\.enter\\.prevent="ime\\.enter\\(publishAnnouncement, \\$event\\)"`),
      `群公告 textarea 的 ${mod}+Enter 没有接到发布（或没把 $event 传进去）`);
  }
  const tasks = read("GroupTasksBoard.vue");
  assert.match(tasks, /@keydown\.enter="ime\.enter\(saveDraft, \$event\)"/,
    "任务自定义类型回车没有接到保存（或没把 $event 传进去）");
  for (const mod of ["meta", "ctrl"]) {
    assert.match(tasks, new RegExp(`@keydown\\.${mod}\\.enter\\.prevent="ime\\.enter\\(saveDraft, \\$event\\)"`),
      `任务描述 textarea 的 ${mod}+Enter 没有接到保存（或没把 $event 传进去）`);
  }
});

test("气泡尖角：位置只有 style.css 那一个家，五处挂尖角的气泡全查", () => {
  // 用户 2026-10-23 截图点名代码气泡：它的尾巴还钉在卡片**底栏**上，跟头像完全错开 ——
  // 根因是组件里又写了一遍 `.bubble-tail { top: auto; bottom: 12px }`。位置一旦有第二个家，
  // 全局那条「对准头像中心」就管不到它，所以这条钉的是「只许有一个家」，不是「某个文件对」。
  const SECOND_HOME = /\.bubble-tail[^{]*\{[^}]*\b(?:top|bottom)\s*:/;
  const files = walk691(srcDir691).filter((f) => f.endsWith(".vue"));
  const hosts = [];
  const secondHomes = [];
  for (const f of files) {
    const src = code691(readFileSync(f, "utf8"));
    // 位置的家：**扫全部 .vue**（不是只看挂了 class 的那几个）—— 组件里只要再钉一次
    // `top`/`bottom`，不管它还画不画尾巴，都算开了第二个家（代码气泡那一格就是这么来的）。
    if (SECOND_HOME.test(src)) secondHomes.push(rel692(f));
    if (!/class="bubble-tail"/.test(readFileSync(f, "utf8"))) continue;
    hosts.push(rel692(f));
    assert.match(src, /class="bubble-tail" :class="mine \? 'tail-mine' : 'tail-other'"/,
      `${rel692(f)} 的尖角没有按 mine 分方向（左右两列会各指错一边）`);
  }
  // 形状的家只有一个（BubbleTail.vue）；五个气泡组件必须**引用**它而不是各画一份。
  // 这两件事分开数：前者防"第二个形状"，后者防"某个气泡漏了尾巴"。
  assert.deepEqual(hosts, ["components/message/BubbleTail.vue"],
    "挂 class=bubble-tail 的文件不是唯一那个组件：" + hosts.join(","));
  const tailUsers = ["components/message/MessageTextBubble.vue", "components/message/MessageCodeBubble.vue",
    "components/message/MessageFileBubble.vue", "components/message/MergeCard.vue",
    "components/TodoCardBubble.vue"]
    .filter((rel) => /<BubbleTail\b/.test(readFileSync(join(srcDir691, rel), "utf8")));
  assert.equal(tailUsers.length, 5, "有气泡组件没有引用 BubbleTail：" + tailUsers.join(","));
  // 群聊不显示尾巴：五处都必须带 v-if="tail"，开关由 MessageItem 按 isGroup 给。
  for (const rel of tailUsers) {
    const src = readFileSync(join(srcDir691, rel), "utf8");
    assert.match(src, /<BubbleTail v-if="tail"/, `${rel} 的尾巴没有 tail 开关（群聊会漏出尾巴）`);
  }
  assert.deepEqual(secondHomes, [], "这些组件又给 .bubble-tail 钉了一次 top/bottom ⇒ " + secondHomes.join(", "));
  // 正控：被删掉的那种形状必须认得出来（认不出 ⇒ 上面那条缺席断言在测空气）
  assert.ok(SECOND_HOME.test(".bubble-tail { top: auto; bottom: 12px; }"),
    "签名认不出「组件里再钉一次位置」⇒ 这一格在测空气");
  // 反控：只补颜色的那一档（代码气泡按 toolbar 混色）不算第二个家
  assert.ok(!SECOND_HOME.test(".bubble-tail.tail-mine { border-left-color: red; }"),
    "只改颜色的规则被误判成第二个家");
  // 唯一那一家还在，而且带 --bubble-tail-offset，并用 max(0px, …) 夹住（缺了 offset，群聊那行
  // 昵称会把尖角顶歪；少了 max，群聊尖角会有一半露到气泡上面 —— 用户 2026-10-23 两轮反馈）；
  // 末尾那 -1px 是让叶形的起笔点落在气泡**外框**上（描边才接得上气泡自己的边框）。
  const css = readFileSync(join(srcDir691, "style.css"), "utf8");
  // 2026-10-24：尾巴挂在气泡**左下/右下角、贴底边**，尖朝外，不再向下伸。
  // 这里钉的是新口径：底边与气泡底边齐（bottom: 0），盒子向气泡外侧伸出 10px。
  assert.match(css,
    /\.bubble-tail\s*\{[\s\S]{0,600}?bottom:\s*0;/,
    "style.css 里那条尾巴定位不在了（或被改回顶边/写死到别处）");
  assert.match(css,
    /\.tail-other\s*\{\s*left:\s*-10px/,
    "对方气泡的尾巴横向位置不在了（盒子必须伸出气泡左边缘 10px）");
  assert.match(css,
    /\.tail-mine\s*\{[\s\S]{0,120}?transform:\s*scaleX\(-1\)/,
    "自己的尾巴必须靠镜像复用同一份形状（两条路径迟早会漂）");

  // 用户 2026-10-23（第二次）：「气泡有边框、尾巴没有 ⇒ 接缝对不上；上边不丝滑」。
  // 现在尾巴是 **SVG 叶形 + 1px 描边**：填充盖住气泡那段边框，描边把轮廓接成一条线。
  // 退回实心块（没有 .tail-line）时这条会红 —— 那正是会露出接缝的形状。
  assert.match(css, /\.bubble-tail \.tail-fill\s*\{[^}]*fill:\s*var\(--bubble-tail-fill, var\(--bubble-bg\)\)/,
    "尾巴的填充层必须走 --bubble-tail-fill（默认气泡底色）");
  assert.match(css, /\.bubble-tail \.tail-line\s*\{[^}]*stroke:\s*currentColor/,
    "尾巴必须有一层描边（stroke: currentColor）—— 否则与气泡边框接不上");
  assert.match(css, /\.bubble-tail\s*\{[^}]*color:\s*var\(--bubble-line/,
    "描边色必须取 --bubble-line（气泡自己的边框色）");
  const displaySrc = readFileSync(join(srcDir691, "composables", "useMessageDisplay.ts"), "utf8");
  assert.match(displaySrc, /"--bubble-line":\s*mine\.value \? "transparent" : "var\(--gosslan-border\)"/,
    "文本气泡没有把 --bubble-line 交给尾巴（自己的消息应为 transparent）");
  assert.match(displaySrc,
    /const line = mineCard \? "transparent" : "var\(--gosslan-card-line\)"/,
    "卡片气泡没有把 --bubble-line 交给尾巴（自己的卡片应为透明边、对方取卡片线）");
  assert.match(displaySrc, /"--bubble-line": line,/,
    "卡片气泡的 --bubble-line 没有真的进到样式对象");
});

/**
 * 图片预览左右切换键的定位（用户 2026-10-23：「按靠上的地方会把图关掉」「点击反馈向下移太夸张」）。
 *
 * 根因不是按钮写错了值，而是**两条 `transform` 抢同一条声明**：Tailwind 的
 * `-translate-y-1/2`（一条类 = 特异度 0,1,0）与全局按压规则
 * `:where(button…):active { transform: scale(.97) }`（`:where` 记 0，`:active` 记 0,1,0）
 * 同特异度，而全局那条在 style.css 里位于 `@tailwind utilities` 之后 ⇒ 按下瞬间
 * `-translate-y-1/2` 被整个顶掉，按钮下移 22px（半个 h-11）。按在顶部时 pointerup 已落到
 * 遮罩上，click 派发到共同祖先（遮罩）⇒ 顺带关窗。
 *
 * 判据不是"某行有某个类"，而是：两颗切换键的 class 里**不许**出现定位 translate，
 * 定位必须在外层元素上（这样按钮只负责 `active:scale-95` 的缩小反馈）。
 */
test("图片预览切换键：定位 translate 不许挂在按钮上，也不许自挂按压缩放", () => {
  const file = readFileSync(
    join(import.meta.dirname, "..", "components", "message", "ImageLightbox.vue"),
    "utf8",
  );
  const template = file.slice(file.indexOf("<template>"));
  /** 同一把尺子：挑出带 `h-11`（切换键尺寸）的 <button> 块。 */
  const navButtons = (src: string) =>
    [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map((m) => m[0])
      .filter((b) => /class="[^"]*\bh-11\b[^"]*"/.test(b));

  const navs = navButtons(template);
  assert.equal(navs.length, 2, `切换键现数 ${navs.length} 颗（必须恰好两颗：上一张 / 下一张）`);
  for (const b of navs) {
    assert.doesNotMatch(b, /(?:^|\s)-translate-[xy]-1\/2/,
      "切换键自己带了定位 translate —— 按下时全局 `button:active` 的 scale 会顶掉它，按钮整体下移");
    // 仓库统一按压是全局 `:where(button):active { transform: scale(.97) }`，
    // 且 reduce 档会把它关掉。组件自挂 `active:scale-*`（0,2,0）会压过 reduce 的
    // `transform: none`（0,1,0）⇒ 减弱动态效果的用户仍会看到缩放（用户 2026-10-23 审查点名）。
    assert.doesNotMatch(b, /active:scale-/,
      "切换键自挂了按压缩放 —— 它会绕过全局 press 与 prefers-reduced-motion 的关闭");
  }
  // 定位挪到外层：否则按钮不居中了
  assert.match(template, /class="absolute (?:left|right)-4 top-1\/2 z-10 -translate-y-1\/2"/,
    "居中定位没有落在按钮的外层元素上（按钮会掉到基线附近）");
  // 遮罩关窗的按下源守卫：在控件上按下的手势不许被当成"点了遮罩"
  assert.match(file, /@pointerdown="onShadePointerDown"/, "遮罩没有记录按下源");
  assert.match(file, /@click="onShadeClick"/, "遮罩仍直接 emit close（没有走按下源守卫）");
  assert.match(file, /if \(e\.target !== lastPointerDownTarget\) return;/,
    "遮罩点击没有核对按下源（click 落到遮罩就会关窗）");
  assert.match(file, /closest\("button, a, input, textarea, select, \[role='button'\]"\)/,
    "遮罩没有显式排除控件（将来漏了 .stop 的控件会被当成遮罩关闭）");
  // 正控：旧形状（定位写在按钮上 / 自挂按压缩放）必须被同一把尺子认出来，否则上面的缺席断言在测空气
  const legacy = '<button class="absolute left-4 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center">x</button>';
  const old = navButtons(legacy);
  assert.equal(old.length, 1, "正控没认出旧形状（h-11 选择器漂了）");
  assert.match(old[0], /(?:^|\s)-translate-[xy]-1\/2/, "正控没认出旧形状的定位 translate");
  const legacyScale = '<button class="flex h-11 w-11 active:scale-95">x</button>';
  const scaled = navButtons(legacyScale);
  assert.equal(scaled.length, 1, "正控没认出带按压缩放的切换键");
  assert.match(scaled[0], /active:scale-/, "正控没认出组件自挂的按压缩放");
});

/**
 * 触屏选字契约（用户 2026-10-23：「移动端必须保留系统原生的选中文字与复制菜单」）。
 *
 * 只有 `[data-msg-col]` 里的 `.gosslan-selectable`（正文）可以原生选字；
 * 昵称/引用块/卡片/内边距都不可选 ⇒ 长按这些区域才归自定义消息面板。
 * 如果退回"整个气泡不可选"的老写法，长按正文就再也进不了系统选区 —— 这正是用户报的那条。
 */
test("触屏选字契约：消息内容列里只有正文可原生选字（不再整块关掉）", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  const anchor = css.indexOf("触屏：**正文**可原生选字");
  assert.ok(anchor > 0, "找不到触屏选字契约那段注释（style.css 结构变了？）");
  const block = css.slice(anchor, anchor + 1400);
  assert.match(block, /@media \(pointer: coarse\)/, "契约没有落在 pointer: coarse 里");
  assert.match(block, /\[data-msg-col\]\s*\{[\s\S]{0,140}?user-select:\s*none/,
    "消息内容列（非正文）没有关闭原生选字 ⇒ 长按昵称/卡片会同时拉系统选区与自定义面板");
  assert.match(block,
    /\[data-msg-col\] \.gosslan-selectable\s*\{[\s\S]{0,180}?user-select:\s*text[\s\S]{0,100}?-webkit-touch-callout:\s*default/,
    "正文没有显式开放 user-select:text + touch-callout:default ⇒ 移动端长按进不了系统选字/复制工具条");
  assert.doesNotMatch(block, /\.gosslan-bubble-text \.gosslan-selectable[\s\S]{0,60}?user-select:\s*none/,
    "又回到「整块气泡不可选」的老契约 ⇒ 长按正文弹不出系统选字");
  // 正控：旧写法必须被上面的缺席判据认出来
  const legacy = "@media (pointer: coarse) { .gosslan-bubble-text .gosslan-selectable { user-select: none; } }";
  assert.match(legacy, /\.gosslan-bubble-text \.gosslan-selectable[\s\S]{0,60}?user-select:\s*none/,
    "正控失效：旧契约的签名没认出来");
});

test("收藏列表是普通一级 tab，底栏显示条件不再为收藏开特例", () => {
  const routes = readFileSync(join(import.meta.dirname, "..", "router", "mainRoutes.ts"), "utf8");
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(routes, /path: "\/favorites",[\s\S]{0,180}meta: \{ pane: "list", tab: "favorites", depth: 0 \}/,
    "/favorites 没有回到 list 一级 tab");
  assert.ok(!/mobileView\.value === "list" \|\| favoritesOpen\.value/.test(layout),
    "底栏显示条件又给收藏开了特例（收藏列表挡不住其它 tab 的根因）");
  assert.match(layout, /\(mobileView\.value === "list" \|\| navState\.value === "me"\)/,
    "一级 tab 的底栏条件必须只认 pane/me");
});

// ---------------- 加载旋转唯一入口 ----------------
//
// reduce 档下全局 `animation-iteration-count: 1` 会把所有 animate-spin 冻成静止帧
// （"加载中"与"卡死"不可区分）。旋转收敛到 `ui/Spinner.vue` 的 `.spinner-icon`，
// 其它组件不许再自己写 animate-spin。
test("加载旋转只许在 Spinner.vue（全仓不得再出现 animate-spin 类）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const offenders = listVue692(srcDir)
    .filter((f) => !f.endsWith("components/ui/Spinner.vue"))
    .filter((f) => {
      const code = stripCommentsForTokens(readFileSync(f, "utf8"));
      return /(?:^|\s)class="[^"]*\banimate-spin\b/.test(code) || /:class="[^"]*animate-spin/.test(code);
    })
    .map((f) => f.slice(srcDir.length + 1));
  assert.deepEqual(offenders, [], `以下文件又自己写 animate-spin：\n${offenders.join("\n")}`);
  const spinner = readFileSync(join(srcDir, "components", "ui", "Spinner.vue"), "utf8");
  assert.match(spinner, /spinner-icon/, "Spinner 没有唯一的旋转类");
  assert.ok(/(?:^|\s)class="[^"]*\banimate-spin\b/.test('<div class="x animate-spin">'), "扫描正则没匹配上合成针 ⇒ 判据空转");
  assert.ok(!stripCommentsForTokens(`// animate-spin\nconst x = 1;`).includes("animate-spin"), "注释不算作用点");
  console.log(`· 加载旋转：扫 ${listVue692(srcDir).length} 份 .vue，animate-spin 0 处（唯一入口 Spinner.vue）`);
});

// ---------------- 收藏详情 / 搜索返回 / 我的子页路径 ----------------
//
// 2026-10-22 路由审计发现的三类"路由表说有、实际没接"：
// ① `/favorites/:favId` 是死路由（点收藏只改内部 ref）；
// ② 搜索既是 route 又让 BaseModal 压一条返回层（Android 返回可能退两次）；
// ③ 「我的」子页路径不统一（/profile、/links 与 /me/settings 混用）。
test("收藏详情必须走 /favorites/:favId（不是死路由）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "FavoritePanel.vue"), "utf8");
  assert.match(src, /params:\s*\{\s*favId:/, "选中收藏没有 push 到 /favorites/:favId");
  assert.match(src, /route\.params\.favId/, "收藏详情没有从路由参数恢复选中项");
  assert.match(src, /route\?\.name === "favorite"/, "详情返回没有识别 favorite 路由");
  assert.match(src, /router\.back\(\)/, "详情返回没有走路由历史");
});

test("搜索模态在路由驱动时不重复压返回层", () => {
  const base = readFileSync(join(import.meta.dirname, "..", "components", "BaseModal.vue"), "utf8");
  assert.match(base, /backLayer\?: boolean/, "BaseModal 没有 backLayer 开关");
  assert.match(base, /if \(props\.backLayer\)/, "BaseModal 仍无条件压返回层");
  const search = readFileSync(
    join(import.meta.dirname, "..", "components", "search", "ChatSearchDialog.vue"), "utf8");
  assert.match(search, /:back-layer="!props\.routeDriven"/, "搜索没有把 routeDriven 传给 BaseModal");
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(layout, /<ChatSearchDialog[\s\S]*?route-driven/, "主窗口没有把搜索标成路由驱动");
});

test("移动端「我的」子页统一在 /me/*（路径不许回退成顶层）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "router", "mainRoutes.ts"), "utf8");
  for (const path of ["/me/profile", "/me/links", "/me/settings", "/me/logs"]) {
    assert.ok(src.includes(`path: "${path}"`), `路由表缺少 ${path}`);
  }
  // 顶层旧路径只允许作为兼容 redirect 存在，不能再挂 name（否则页面身份分叉）。
  assert.ok(!/path: "\/profile",\s*\n\s*name: "profile"/.test(src), "/profile 又变回正式页面了");
  assert.match(src, /path: "\/profile", redirect: "\/me\/profile"/, "旧 /profile 深链没有兼容落点");
  assert.match(src, /path: "\/logs", redirect: "\/me\/logs"/, "旧 /logs 深链没有兼容落点");
  assert.ok(!/path: "\/links",\s*\n\s*name: "me-links"/.test(src), "me-links 没有下沉到 /me/links");
});

test("路由驱动的日志页/链接页不再重复压返回层", () => {
  const logs = readFileSync(join(import.meta.dirname, "..", "components", "LogViewer.vue"), "utf8");
  assert.match(logs, /routeDriven\?: boolean/, "LogViewer 没有 routeDriven 开关");
  assert.match(logs, /if \(!props\.standalone && !props\.routeDriven\)/, "LogViewer 仍无条件压返回层");
  const links = readFileSync(join(import.meta.dirname, "..", "components", "LinksList.vue"), "utf8");
  assert.match(links, /routeDriven\?: boolean/, "LinksList 没有 routeDriven 开关");
  assert.match(links, /if \(!props\.routeDriven\)/, "LinksList 仍无条件压返回层");
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(layout, /<LogViewer[^>]*route-driven/, "主窗口没有把日志页标成路由驱动");
  assert.match(layout, /<LinksList[^>]*route-driven/, "主窗口没有把链接页标成路由驱动");
});

test("搜索关键词参与 URL，且外部前进后退能回灌输入框", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "search", "ChatSearchDialog.vue"), "utf8");
  assert.match(src, /function syncKeywordToRoute\(\)/, "搜索没有把关键词写回 URL 的单一出口");
  assert.match(src, /router\.replace\(\{ name: "search", query \}\)/, "搜索写 URL 没有走 replace（会堆历史）");
  assert.match(src, /watch\(\s*\(\) => props\.initialKeyword/, "外部 URL 变化没有回灌搜索框");
  assert.match(src, /if \(!props\.routeDriven\) emit\("close"\);/, "命中跳转在路由驱动时仍会并发关闭（双退）");
});

test("移动端 tab 切换不堆历史，深链无上一跳时用 replace 落安全目标", () => {
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(layout, /void router\.replace\(routeForTab\(nav\)\)/, "tab 切换仍在 push（返回键会在 tab 间倒带）");
  assert.match(layout, /void router\.replace\(fallback\)/, "goBack 无历史时仍 push（会形成返回循环）");
  assert.match(layout, /function openMobileLinks\(\)[\s\S]{0,240}router\.push\(\{ name: "me-links" \}\)/, "移动端链接下钻没有 push（返回回不到「我的」）");
  assert.match(layout, /@click="openMobileLinks"/, "「我的 → 链接」没有走下钻入口");
  assert.match(layout, /if \(name === "links"\) void router\.replace\(\{ name: "me-links" \}\)/, "移动端 /links 没有归一");
  assert.match(layout, /openSettings\(\);\s*\n\s*void router\.replace\(\{ name: "chats" \}\)/, "桌面设置深链没有映射成窗口动作");
  assert.match(layout, /openLogs\(\);\s*\n\s*void router\.replace\(\{ name: "chats" \}\)/, "桌面日志深链没有映射成窗口动作");
});

test("无效路径参数有明确回退（不是 UI 空态挂着错 URL）", () => {
  const layout = readFileSync(join(import.meta.dirname, "..", "layouts", "ResponsiveLayout.vue"), "utf8");
  assert.match(layout, /function isKnownConversation\(/, "会话深链没有存在性判据");
  assert.match(layout, /if \(!chat\.initialized\) return;/, "会话深链在首轮数据前就判/开");
  assert.match(layout, /if \(!chat\.friendsLoaded\) return;/, "好友表失败时仍把深链判成不存在");
  assert.match(layout, /const canJudge =/, "会话深链没有“两表都成功读过”的判据");
  assert.match(layout, /chat\.conversationsLoaded && chat\.groupsLoaded/, "群深链没有要求会话+群表");
  assert.match(layout, /chat\.conversationsLoaded && chat\.friendsLoaded/, "单聊深链没有要求会话+好友表");
  assert.match(layout, /if \(current && current !== convId\) return;/, "后台 activeConv 变化会覆盖当前会话 URL");
  // 好友那一档按**分支块**取，不按字符距离：往这一档里加一句解释就把距离窗口撑破（4965 行旧形状
  // 实测红过一次），距离窗口是贴形状的锚点、注释一变就假红。切到下一档的判断为止，
  // 判据仍然绑在 friend 分支上，不会误认另一档的 replace。
  const friendAt = layout.indexOf('if (name === "friend")');
  const nextAt = layout.indexOf('if (name !== "conversation")', friendAt);
  assert.ok(friendAt > 0 && nextAt > friendAt, "锚点缺失：好友深链校验分支或下一档的判断被改名");
  const friendBranch = layout.slice(friendAt, nextAt);
  assert.match(friendBranch, /router\.replace\(\{ name: "contacts" \}\)/, "无效好友没有回通讯录");
  // 「自己」不是自己的好友，但它是**合法**的资料页对象（用户 2026-10-23：点联系人里自己那行
  // 被弹回通讯录并提示"内容不存在"）。这一档与会话那一档必须同一个口径。
  assert.match(friendBranch, /id !== app\.device\?\.device_id/, "好友深链把「自己」当不存在弹回通讯录");
  assert.match(layout, /if \(id === app\.device\?\.device_id\) return true;/, "会话存在性判据不再认自聊 id");
  const fav = readFileSync(join(import.meta.dirname, "..", "components", "FavoritePanel.vue"), "utf8");
  assert.match(fav, /loadedOnce/, "收藏无效参数判据没有等待首轮读取");
  assert.match(fav, /t\("favorite\.notFound"\)[\s\S]{0,120}router\.replace\(\{ name: "favorites" \}\)/, "无效 favId 没有回列表");
  const settings = readFileSync(join(import.meta.dirname, "..", "components", "SettingsPanel.vue"), "utf8");
  assert.match(settings, /routeSection\.value !== null\) return;[\s\S]{0,160}router\.replace\(\{ name: "settings" \}\)/, "未知设置分区没有归一");
});

// ---------------- 自动更新接线（Tauri Updater + GitHub Releases） ----------------
//
// 守“看起来有更新入口、实际没有任何东西被接上”的形状：配置/公钥、Rust 插件与命令、
// 主窗口只调度一次、状态机单飞、取消不是假 loading、UI 不绕过用户确认、发布链带签名与清单。
test("自动更新：端点/公钥/插件/命令/单飞/取消/发布链都真的接在源码上", () => {
  const root = join(import.meta.dirname, "..");
  const repo = join(root, "..");
  const conf = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(
    conf.plugins?.updater?.endpoints?.[0],
    "https://github.com/wenzo001/gosslan/releases/latest/download/latest.json",
    "更新端点必须是 latest.json，且只托管在 GitHub Releases",
  );
  const pubkey = String(conf.plugins?.updater?.pubkey ?? "");
  assert.ok(pubkey.length > 80, "pubkey 不能为空/占位");
  assert.doesNotMatch(pubkey, /secret key|PRIVATE KEY/i, "配置里绝不能出现私钥");

  const overlay = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.updater.conf.json"), "utf8"));
  assert.equal(overlay.bundle?.createUpdaterArtifacts, true, "tag 构建必须开启 updater 产物");

  const lib = readFileSync(join(repo, "src-tauri", "src", "lib.rs"), "utf8");
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/, "Rust 桌面端没有注册 updater 插件");
  assert.match(lib, /commands::updater_download/, "下载命令没有注册");
  assert.match(lib, /commands::updater_cancel/, "取消命令没有注册");

  const service = readFileSync(join(root, "updater", "service.ts"), "utf8");
  assert.match(service, /let checkInFlight/, "检查必须单飞");
  assert.match(service, /let downloadInFlight/, "下载必须单飞");
  assert.match(service, /withTimeout/, "检查必须有硬超时");
  assert.match(service, /UPDATER_CANCELLED/, "取消必须有明确的结局");
  assert.doesNotMatch(service, /setInterval/, "更新不允许高频轮询");

  const ui = readFileSync(join(root, "components", "settings", "UpdatePanel.vue"), "utf8");
  assert.doesNotMatch(ui, /\binvoke\s*\(/, "UI 不许绕过 service 直接调 IPC");
  assert.doesNotMatch(ui, /\brelaunch\b/, "UI 不许绕过用户确认直接重启");
  assert.match(ui, /confirming = true/, "安装必须先经过确认");
  assert.match(ui, /role="progressbar"/, "下载必须有 progressbar 语义");

  const entry = readFileSync(join(root, "entries", "main.ts"), "utf8");
  assert.equal((entry.match(/scheduleAutoUpdateCheck\(updater\)/g) ?? []).length, 1, "启动检查必须只在主入口调度一次");
  assert.doesNotMatch(entry, /setInterval/, "启动检查不许轮询");

  const workflows = ["build-macos.yml", "build.yml"]
    .map((f) => readFileSync(join(repo, ".github", "workflows", f), "utf8"))
    .join("\n");
  assert.ok((workflows.match(/TAURI_SIGNING_PRIVATE_KEY/g) ?? []).length >= 2,
    "macOS 与 Windows tag 构建都必须从 Secrets 注入签名私钥");
  assert.match(workflows, /tauri\.updater\.conf\.json/, "tag 构建必须使用 updater 配置");
  assert.match(workflows, /\.app\.tar\.gz/, "macOS updater 产物没有被上传");
  assert.match(workflows, /\.sig/, "签名文件没有被上传");

  const finalizer = readFileSync(join(repo, ".github", "workflows", "updater-manifest.yml"), "utf8");
  assert.match(finalizer, /latest\.json/, "没有生成 latest.json 的 workflow");
  assert.match(finalizer, /curl -fsSL/, "清单发布后必须做公开 URL 校验");
  assert.ok(existsSync(join(repo, "scripts", "updater-manifest.mjs")), "缺少清单生成器");
});

/**
 * 群任务指派（用户 2026-10-22）：新增/编辑时只显示当前群成员，保存时剔除已退群者。
 * 前端的“当前”来自 `chat.groups`，而 `group_members` 原本只增不减 ⇒ 离线漏收退群帧的
 * 客户端会永久保留旧成员。两条腿都要钉：
 *   ① 看板候选/保存走 `assignableMembers` + `assigneesInGroup`；
 *   ② 群主权威成员表（GroupKey / 群主签名的群消息）到达时**替换**本地集合。
 */
test("群任务指派：候选只取当前成员，权威成员表到达时能收敛旧成员", () => {
  const root = join(import.meta.dirname, "..");
  const board = readFileSync(join(root, "components", "GroupTasksBoard.vue"), "utf8");
  assert.match(board, /v-for="id in assignableMembers"/, "指派候选必须遍历当前成员，不许遍历原始群成员数组");
  assert.doesNotMatch(board, /v-for="id in group\?\.members/, "旧形状会把已退群成员继续列出来");
  assert.match(board, /void chat\.refreshGroups\(\)/, "打开看板时要拉一次最新群资料");
  assert.ok((board.match(/assigneesInGroup\(/g) ?? []).length >= 3, "开始编辑/保存/认领三处都要收敛指派");

  const transport = readFileSync(join(root, "..", "src-tauri", "src", "network", "transport.rs"), "utf8");
  assert.match(transport, /db::replace_group_members\(&dbc, &group_id, &all\)/,
    "GroupKey 是群主权威成员表，接到后必须整体替换（否则只增不减）");
  const gossip = readFileSync(join(root, "..", "src-tauri", "src", "network", "transport", "gossip.rs"), "utf8");
  assert.match(gossip, /let authoritative_members = is_self_declared_creator/,
    "群 Gossip 信封只有群主自称的成员表才可整体替换");
  assert.match(gossip, /db::replace_group_members\(&dbc, &gid, &all\)/,
    "群主权威成员表到达后没有调用替换");
});

// ---------------- 55 主色实底的「填充 + 前景」必须成对（2026-10-24 无障碍实测） ----------------
// 亮色 -active 是压深档（白字过 AA），暗色 -active 是**提亮**档（前景必须换深墨）。
// 所以两类缺陷都是静默的：只写填充（文字继承父级颜色）、或写死 text-white（暗色白字掉到 2 以下）。
// 构建不报错、探针量的是 token 算得对不对（量不到谁在用），只有切到暗色主题才看得见 ⇒ 静态判据盯。

test("55 :: 只写填充 / 写死 white / 裸主色配白字 —— 三种缺陷形状都要报红", () => {
  const cases: [string, string][] = [
    ["只写填充（文字继承父级颜色）", `<template><button class="px-3 bg-[var(--gosslan-primary-active)]">保存</button></template>`],
    ["实底配写死 white（暗色失效）", `<template><span class="bg-[var(--gosslan-primary-active)] text-white">9</span></template>`],
    ["hover 档同样要成对", `<template><div class="data-[state=checked]:bg-[var(--gosslan-primary-hover)]">x</div></template>`],
    // 语义色那一族（2026-10-24）：实底档漏前景 = 与主色族同一形状；状态点档配白字 = 刚修掉的那个缺陷。
    ["橙实底档只写填充", `<template><button class="bg-[var(--gosslan-warning-solid)]">重试</button></template>`],
    ["绿实底档配写死 white", `<template><button class="bg-[var(--gosslan-success-solid)] text-white">已复制</button></template>`],
    ["拿状态点当按钮底（橙 2.20）", `<template><button class="bg-[var(--gosslan-warning)] text-white">逾期</button></template>`],
    ["拿状态点当按钮底（绿 2.54）", `<template><span class="rounded-full bg-[var(--gosslan-success)] text-white text-[11px]">新</span></template>`],
  ];
  for (const [why, src] of cases) {
    assert.equal(findPrimaryFillWithoutOnPrimary(src).length, 1, `${why} ⇒ 必须报红：\n${src}`);
  }

  // 原缺陷形状：中间调主色 + 白字（≈3.5，不达 AA）。报的必须是"这一档不该承载白字"那句，不是成对那句。
  const rawWhite = findPrimaryFillWithoutOnPrimary(
    `<template><button class="bg-[var(--gosslan-primary)] text-white">发送</button></template>`,
  );
  assert.equal(rawWhite.length, 1);
  assert.match(rawWhite[0].message, /都不合格/, "裸主色+白字要走这一句提示");
  // 报的要能指出**是哪一档**：三族共用一个判据，只说"不合格"等于让人回去猜。
  assert.match(rawWhite[0].message, /--gosslan-primary/, "提示里要点名命中的那一档");
  const dotWarn = findPrimaryFillWithoutOnPrimary(
    `<template><button class="bg-[var(--gosslan-warning)] text-white">逾期</button></template>`,
  );
  assert.match(dotWarn[0].message, /--gosslan-warning\)/, "橙那一档要点名橙");
});

test("55 :: 状态点当状态点用（不配白字）必须静默 —— 否则会把 6 处在线点全判成缺陷", () => {
  const dot =
    `<template><span class="h-2 w-2 rounded-full" :class="online ? 'bg-[var(--gosslan-success)]' : 'bg-[var(--gosslan-status-offline)]'"></span></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(dot), [], "在线/离线点：不写 text-white ⇒ 合法（比值那一维由 tokenContrast 判）");
  // ⚠️ 反向那一格不许松：`*-solid` 与 `-active`/`-hover` 受同一条"必须配对"约束（保守是有意的 ——
  // 判据分不出"这块底上有没有字"，图标 `<Check>` 吃 currentColor 也算承载前景）。
  // 所以**色条**这类无文字实底只能留在 `.ts` 常量里（`utils/todos.ts` 的 TODO_STATUS_BAR 不在 .vue 模板里），
  // 这条边界写在这里，别把它当成"实心档已经能识别是否承载文字"。
  const barInTemplate = `<template><div class="w-0.5 bg-[var(--gosslan-warning-solid)]"></div></template>`;
  assert.equal(findPrimaryFillWithoutOnPrimary(barInTemplate).length, 1,
    "实心档无配对 = 报红（这是已知保守面，不是缺陷；改动这条要连同上面的注释一起改）");
});

test("55 :: 已知边界：三元分支各写一套时本判据看不见（整块粒度），这条不许被当成覆盖", () => {
  // 一支成对、一支只写填充 —— 缺陷真实存在，但判据按"元素整块"取类名，两支混在同一块里 ⇒ 静默。
  // 把它钉成"当前就是静默"是为了：① 不许误以为这族已被穷尽；② 真要收紧时这条会红，逼人来改判据。
  // 这一形状的实际兜底在别处：比值由 tokenContrast 契约判，暗色覆盖由 CDP 探针的 accent 段量。
  const halfPaired =
    `<template><span :class="ok ? 'bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)]' : 'bg-[var(--gosslan-primary-active)]'">n</span></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(halfPaired), [], "整块粒度挡不住半成对 —— 已知欠账，别写成已覆盖");
});

test("55 :: 成对写法 / 前景在子树（勾选圈） / 非文字填充 / 注释里的示例 —— 都要静默", () => {
  const paired =
    `<template><button class="bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)]">保存</button></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(paired), [], "同标签成对");

  // GroupCreateModal / MessageItem 的真实形状：外圈上底色，里面 `<Check>` 吃 currentColor。
  const childInk =
    `<template><div class="bg-[var(--gosslan-primary-active)]"><Check class="h-3 w-3 text-[var(--gosslan-on-primary)]" /></div></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(childInk), [], "前景写在子元素里也算成对");

  // 进度条/开关底/状态点这类**不承载文字**的裸主色填充是合法用法，不许顺手要求配对。
  assert.deepEqual(
    findPrimaryFillWithoutOnPrimary(`<template><div class="h-1 w-full bg-[var(--gosslan-primary)]"></div></template>`),
    [],
    "非文字填充不该被要求配前景（否则会把 12 处合法用法全判成缺陷）",
  );

  // ⚠️ 注释不许参与判定：这条曾经让护栏"因为注释而通过"。
  const commentOnly =
    `<template><!-- 旧写法 bg-[var(--gosslan-primary-active)] text-white 已废弃 --><span class="text-[var(--gosslan-text)]">ok</span></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(commentOnly), [], "模板注释里的示例不算调用点");

  // script 段里解释设计的字符串同样不算（只扫 <template>）。
  const scriptOnly =
    `<script setup>const why = "不要写 bg-[var(--gosslan-primary-active)] text-white";</script>\n<template><p>hi</p></template>`;
  assert.deepEqual(findPrimaryFillWithoutOnPrimary(scriptOnly), [], "script 里的说明文字不算调用点");
});

test("55 :: 真实树全绿，且分母现算（有活调用点才证明这条判据不是空转）", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files = collectVueFiles(srcDir);
  assert.ok(files.length > 50, `只扫到 ${files.length} 份 .vue ⇒ 遍历路径大概错了，这条绿不算数`);

  const bad: string[] = [];
  let fills = 0;
  let pairs = 0;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const issue of findPrimaryFillWithoutOnPrimary(src)) {
      bad.push(`${f.replace(srcDir + "/", "")}:${issue.line}  ${issue.message}`);
    }
    // 分母只数**模板里真的写出来的**类名：注释里那句"以前写 …"会把计数抬上去，
    // 抬上去的下限就变成"注释很多"也算绿，量不到调用点还在不在。
    const s = src.indexOf("<template");
    const e = src.lastIndexOf("</template>");
    if (s < 0 || e <= s) continue;
    const tpl = src.slice(s, e).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
    fills += (tpl.match(/bg-\[var\(--gosslan-primary-(active|hover)\)\]/g) ?? []).length;
    pairs += (tpl.match(/text-\[var\(--gosslan-on-primary\)\]/g) ?? []).length;
  }
  assert.deepEqual(bad, [], `以下位置用了主色实底却没配前景：\n${bad.join("\n")}`);
  // 下限：填充与前景都必须是"真的在用"，否则这条判据退化成对空文件的断言。
  assert.ok(fills >= 20, `模板里实底调用点只有 ${fills} 处 ⇒ 被守的东西消失了`);
  assert.ok(pairs >= 20, `模板里配档前景只有 ${pairs} 处 ⇒ 成对写法没被接上`);
  console.log(`· 55 分母：扫 ${files.length} 份 .vue，模板内实底 ${fills} 处 / 配档前景 ${pairs} 处，缺陷 0 处`);
});

// ---------------- 56：禁用态透明度的"家"有几个 ----------------
//
// §2.2 明写「禁止每个组件各自定义一套」。禁用态这一族今天有 4 个不同 α、三十多处声明，
// 而且**没有 token** —— 它是这条规则现存最大的破口（收口会改到约 30 个控件的观感，属单独决策）。
// 收口之前先把"别再多一家"钉住：档位数量只许降不许升。
// 这属静默漂移（多加一档没人看得出来），所以才配棘轮；观感本身由 tokenContrast 的
// DISABLED_CONTRAST_CONTRACT 逐族量比值。

test("56: 禁用态透明度只许现有 4 档，第 5 档就是又各自定义一套", () => {
  const srcDir = join(import.meta.dirname, "..");
  const vueFiles = collectVueFiles(join(srcDir, "components")).concat(collectVueFiles(join(srcDir, "layouts")));
  const tiers = new Set<number>();
  let sites = 0;
  for (const f of vueFiles) {
    for (const a of disabledOpacityFromClasses(readFileSync(f, "utf8"))) {
      tiers.add(a);
      sites += 1;
    }
  }
  const css = readFileSync(join(srcDir, "style.css"), "utf8");
  // 2026-10-24：CSS 侧那两档收进了 `--gosslan-disabled-alpha*`，所以这里**必须带作用域**去解 var ——
  // 不带就只剩 29 处，分母下限会红（那次红是对"判据没跟着搬"的正确报警，不是提取器坏了）。
  const scopes = parseTokenScopes(css);
  for (const a of disabledOpacityFromRule(css, "disabled", scopes.light)) {
    tiers.add(a);
    sites += 1;
  }
  const sorted = [...tiers].sort((a, b) => a - b);
  console.log(`· 56 禁用态 α：扫 ${vueFiles.length} 份 .vue + style.css，${sites} 处声明，档位 ${sorted.join(" / ")}`);
  // 分母下限：提取器瞎了会把棘轮变成永真的绿（必须能证明它看见了真实写法）。
  // 2026-10-28：动作按钮收口到 Primary/Danger/Secondary 三个组件后，手写副本上的
  // `disabled:opacity-40/90` 被删掉一批（实测 30+ → 27），下限随之下调 —— 它守的是
  // "提取器还看得见真实写法"，不是"副本越多越好"。
  assert.ok(sites >= 24, `只扫到 ${sites} 处禁用态透明度声明 ⇒ 提取器没吃到真实写法，这条不算证据`);
  assert.ok(sorted.length <= 4, `禁用态透明度有 ${sorted.length} 档（${sorted.join(", ")}），超过现有 4 档`);
});

test("56 :: style.css 的禁用规则只许走 token，不许再写字面 opacity", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const bare: string[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!m[1].includes("disabled")) continue;
    for (const o of m[2].matchAll(/opacity:\s*([^;]+);/g)) {
      if (!o[1].trim().startsWith("var(")) bare.push(`${m[1].trim().replace(/\s+/g, " ")} → opacity: ${o[1].trim()}`);
    }
  }
  assert.deepEqual(bare, [], `禁用态又各自写死透明度了：\n${bare.join("\n")}`);

  // 阳性对照：把真树里的一条按回字面值 ⇒ 这条必须咬（不然它只是个恒真断言）。
  const mutated = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8")
    .replace(".gosslan-menu-item:disabled {\n  opacity: var(--gosslan-disabled-alpha);", ".gosslan-menu-item:disabled {\n  opacity: 0.45;");
  assert.notEqual(mutated, css, "变异没落到盘上（锚点漂了）⇒ 这条对照不算证据");
  const hits: string[] = [];
  for (const m of mutated.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (!m[1].includes("disabled")) continue;
    for (const o of m[2].matchAll(/opacity:\s*([^;]+);/g)) {
      if (!o[1].trim().startsWith("var(")) hits.push(o[1].trim());
    }
  }
  assert.deepEqual(hits, ["0.45"], "按回字面值必须被抓到");
});

// ---------------- ㊽ 两级切段循环只有一个家（DUP-06） ----------------

test("手写的两级切段循环要被抓到，并指准行号", () => {
  const buggy = `<script setup lang="ts">
const segments = computed(() => {
  const out = [];
  for (const s of splitEmoji(props.text)) {
    out.push(...linkify(s.value, names));
  }
  return out;
});
</script>`;
  const issues = findHandRolledSegmentLoops(buggy);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 4, "应精确指到 for 那一行");
  assert.match(issues[0].message, /useMessageSegments/);
});

test("改用 useMessageSegments 之后通过", () => {
  const fixed = `<script setup lang="ts">
const segments = useMessageSegments(
  () => props.text,
  () => props,
);
</script>`;
  assert.deepEqual(findHandRolledSegmentLoops(fixed), []);
});

test("真实仓里切段循环只在家里，且三个渲染件都接上了那个家", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(vue|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);
  const rel = (f: string): string => f.slice(srcDir.length + 1).replaceAll("\\", "/");
  assert.ok(files.length >= 200, `只扫到 ${files.length} 个源文件 ⇒ 遍历器坏了，下面两条都是空集恒绿`);
  const loopers = files
    .filter((f) => findHandRolledSegmentLoops(readFileSync(f, "utf8")).length > 0)
    .map(rel);
  assert.deepEqual(loopers, ["composables/useMessageSegments.ts"], "切段循环又长出第二份（家被绕过）");
  for (const c of [
    "components/message/MentionText.vue",
    "components/message/MessageTextBubble.vue",
    "components/message/MessageContentModal.vue",
  ]) {
    const src = readFileSync(join(srcDir, c), "utf8");
    assert.ok(src.includes("useMessageSegments("), `${c} 没接上那个家 ⇒ 家有了没人接，判据等于没守`);
    // 直接 import 切分原语 = 又打算自己拼一遍；家接上之后这两个 import 都该消失。
    assert.ok(!/from "@\/utils\/(emoji|linkify)"/.test(src), `${c} 还在自己 import 切分原语`);
  }
});

// ---------------- @提及淡底配方只有一个家（DUP-07） ----------------
//
// 真实重复（审计 §6 DUP-07）：气泡与全文弹窗各写一遍 `color-mix(in srgb, ${fg} 16%, transparent)`。
// 这两处的**前景色来源必须不同**（气泡按气泡底色算对比度、弹窗按面板底色算），所以不能把整个
// `mentionFg` 合并 —— 能合并、也应该合并的是"已知前景色之后怎么调出底色"这一段。
//
// 判据按**形状 + 数量**：那个配方的字面量在 `src` 里只许出现一次（家在 `utils/chatStyle.ts`）；
// 两处消费点必须真的引用那个家（"家有了没人接"是本仓反复付钱的形状）。
test("@提及淡底配方只有一个家：16% 的 color-mix 只许出现在 chatStyle，两处消费点必须引用它", () => {
  const srcDir = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);

  // ⚠️ 只认 **16%** 这一个数，不认"任意百分比"：`useMessageDisplay.vue` 里那条 18% 是
  // **卡片描边**（`--card-line`），`style.css` 里那条 12% 是没内联样式时的**静态兜底** ——
  // 两者都是别的事实，按"任意百分比"扫会把它们一起卷进这次收口（审计 §6 记的第二种正是这么来的）。
  const RECIPE = /color-mix\(in srgb, \$\{[^}]+\} 16%, transparent\)/;
  // 家里的百分比是个**具名常量**（`MENTION_BG_PERCENT`）：扫描前把它归一成 16，
  // 否则"只有一个家"这条会被家里自己的写法漏掉（第一次跑就是这样空集的）。
  const normalize = (t: string) => t.replace(/\$\{MENTION_BG_PERCENT\}/g, "16");
  const hits: string[] = [];
  for (const f of files) {
    const text = normalize(
      readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, ""),
    );
    if (RECIPE.test(text)) hits.push(f.replace(srcDir + "/", ""));
  }
  assert.deepEqual(
    hits,
    ["utils/chatStyle.ts"],
    `@提及淡底的 16% 配方只许有一个家（utils/chatStyle.ts），实得：\n${hits.join("\n")}`,
  );

  // 两处消费点必须引用那个家，且不许再自己拼一遍
  for (const rel of ["components/message/MessageTextBubble.vue", "components/message/MessageContentModal.vue"]) {
    const src = readFileSync(join(srcDir, rel), "utf8");
    assert.ok(src.includes("mentionHighlightBg("), `${rel} 没接上那个家 ⇒ 家有了没人接，判据等于没守`);
    assert.ok(!RECIPE.test(src), `${rel} 还在自己拼淡底配方`);
  }

  // 正控：量具本身能认出配方（否则上面那条在空集上恒绿）
  assert.ok(RECIPE.test("`color-mix(in srgb, ${fg} 16%, transparent)`"));
  assert.ok(!RECIPE.test("`color-mix(in srgb, ${ink} 18%, transparent)`"), "18%（卡片描边）不许被算进来");

  // 等价性：家必须产出与旧内联写法**逐字相同**的串（改了它就是改了观感，不该由这次重构顺手改掉）
  assert.equal(mentionHighlightBg("#123456"), "color-mix(in srgb, #123456 16%, transparent)");
  assert.equal(mentionHighlightBg(""), undefined, "没有前景色时必须回 undefined（而不是拼出一个非法色）");
  assert.equal(mentionHighlightBg(undefined), undefined);
});

// ---------------- 跨会话的「按 msg_id 改一条」必须走 utils/messages（TST-02 第一步） ----------------
//
// 背景：store 里这类接线此前**每种都手写一遍**（`for (const [convId, list] of Object.entries(messages.value))`
// + findIndex + 两种不同的赋值写法），而它们是纯逻辑 ⇒ 只能靠"改完手动点一下"验。
// 抽成 `findFirstMessageById` + `replaceMessageAt` 之后，语义（跨会话/第一条/不可变）由
// `utils/messages.test.ts` 驱动；这一条守的是**接线**：那三个 handler 不许再手写跨会话循环。
test("跨会话按 msg_id 改一条不许手写循环：三个 handler 必须走 utils/messages 的家", () => {
  const store = readFileSync(join(import.meta.dirname, "..", "stores", "useChatStore.ts"), "utf8");
  const bodyOf = (sig: string) => {
    const at = store.indexOf(sig);
    assert.ok(at >= 0, `store 里找不到 ${sig} ⇒ 锚点写法变了`);
    const open = store.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < store.length; i += 1) {
      if (store[i] === "{") depth += 1;
      else if (store[i] === "}") {
        depth -= 1;
        if (depth === 0) return store.slice(at, i + 1);
      }
    }
    return store.slice(at);
  };
  // 5.15.47：原正则只认 `[convId, list]` 这一种解构 ⇒ `[, msgs]` 的写法整片漏掉
  //（`onFileCancelled` 就是这么逃过去的，review 抓到的）。
  const CROSS_CONV = /for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*Object\.entries\(messages\.value\)/;
  for (const [sig, helper] of [
    ["function onFileFailed(", "transferFailureMsgIds("],
    ["function onMessageRenderChanged(", "findFirstMessageById("],
    ["function onMessageRecalled(", "findFirstMessageById("],
    ["onFileCancelled: (transferId) => {", "markStatusInCache("],
  ] as const) {
    const body = bodyOf(sig);
    assert.ok(!CROSS_CONV.test(body), `${sig} 又手写跨会话循环了 ⇒ 回到"每处一份、没法单测"的形状`);
    assert.ok(body.includes(helper), `${sig} 没走 ${helper} 那个家`);
  }
  // 正控：把家换成手写循环，尺子必须说"有"（否则这条在空集上恒绿）
  const gutted = store.replace(
    "const hit = findFirstMessageById(messages.value, [msgId]);",
    "for (const [convId, list] of Object.entries(messages.value)) { void convId; void list; }",
  );
  assert.notEqual(gutted, store, "正控没落进去 ⇒ 锚点写法变了");
  assert.ok(CROSS_CONV.test(gutted));
});

// ---------------- 会话内那两处也必须走家（TST-02 第二步） ----------------
//
// 第一步把**跨会话**的三段收进了 `utils/messages`；这一步收的是**会话内**那两处
// （`onMessageAcked` 的送达提升、重发时的原地回退）。它们的边界是"哪个会话由调用方给"，
// 所以用的是 `patchMessageInConv` 而不是 `findFirstMessageById`——判据要把这个区分也钉住。
test("会话内的按 msg_id 改一条也走家：store 里不再有手写的 findIndex(msg_id)", () => {
  const store = readFileSync(join(import.meta.dirname, "..", "stores", "useChatStore.ts"), "utf8");
  const HAND = /\.findIndex\(\(m\)\s*=>\s*m\.msg_id/g;
  const hits = [...store.matchAll(HAND)].length;
  assert.equal(hits, 0, `store 里还有 ${hits} 处手写 findIndex(msg_id) ⇒ 回到"每处一份、没法单测"`);
  // 同族但写法不同的第二种（`.find(m => m.msg_id …)`）也一并归零：
  // 5.15.47 之前 `onFileCancelled` 正是用它，而当时只数 findIndex ⇒ 判据量不到。
  const FIND = /\.find\(\s*\(?\s*m\s*\)?\s*=>\s*m\.msg_id/g;
  const findHits = [...store.matchAll(FIND)].length;
  assert.equal(findHits, 0, `store 里还有 ${findHits} 处手写 .find(m => m.msg_id)`);
  const uses = [...store.matchAll(/patchMessageInConv\(/g)].length;
  assert.ok(uses >= 2, `patchMessageInConv 只被用了 ${uses} 处（下限 2：送达提升 + 重发回退）`);
  // 正控：把一处换回手写 findIndex，尺子必须说"有"
  const gutted = store.replace(
    'const hit = patchMessageInConv(messages.value, convIdOfMessage(msgId), msgId, (m) => ({',
    'const i = (messages.value[convId] ?? []).findIndex((m) => m.msg_id === msgId); void i;\n        const hit = patchMessageInConv(messages.value, convIdOfMessage(msgId), msgId, (m) => ({',
  );
  assert.notEqual(gutted, store, "正控没落进去 ⇒ 锚点写法变了");
  assert.ok(HAND.test(gutted));
});
