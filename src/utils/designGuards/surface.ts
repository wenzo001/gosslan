/**
 * 设计守卫的「表面 / 骨架 / 几何」分册（原 `designGuards.ts` 的 L3054–末尾，**逐字搬来**）。
 *
 * 含：SK 首帧骨架 / CS 聊天输入区表面 / IP-01 图片预览圆角 / ㊷ 输入承载面边框 /
 * ㊶ 设置分区卡片内边距 / PH-01 占位符色 / CN 同心几何 / SA 屏幕边缘安全区 /
 * TB 标题栏镜像 / ED 输入框「一个表情 = 一个字」的删除契约。
 *
 * 为什么从这一行切：AST 现算过，尾部 1845 行只引用头部 5 个名字
 * （`GuardIssue` / `lineAt` / `stripComments` / `findImgTags` / `CLASS_ATTR_RE`），
 * 且**不接触任何外部 import** ⇒ 这是一个可逐字搬、搬完能原样跑通的边界。
 * 往后再切，照这个方法先算依赖再动刀（⚠️ 第一步那版只数了 function/interface，
 * 漏了 `const` —— 它是 VariableStatement、没有 `name`，于是 `CLASS_ATTR_RE` 漏网、
 * 6 條 ㊶/㊷ 断言当场 ReferenceError。算依赖时**必须把 variable 声明一起数**）。
 *
 * 新增规则的落点：表面/骨架/几何类加到本文件末尾，交互可达性类回到 `designGuards.ts`。
 */
import { CLASS_ATTR_RE, findImgTags, lineAt, stripComments, type GuardIssue } from "./shared.ts";

// ---------------- SK：首帧骨架 vs 真实布局 ----------------

export interface BootSkeletonSources {
  /** `src/boot/skeleton.css` */
  skeletonCss: string;
  /** `src/style.css` */
  styleCss: string;
  /** `index.html` */
  indexHtml: string;
  /** `src/components/ConversationList.vue` */
  conversationList: string;
}

/**
 * SK-02：`index.html` 的首帧骨架必须和真实布局逐项对得上。
 *
 * 为什么需要这条：骨架是"点开瞬间"唯一的画面，它差 2px 用户看到的就是整屏跳一下；
 * 但这类偏移没有任何运行时探针能抓到（骨架在真实 DOM 挂载前就消失了）。
 * 2026-11-07 审查 M-1 实测漂移：标题栏 38 vs 真实 40、列表少了整整 50px 标题行、
 * 还留着一条引用已删除 `.platform-mac` 的 28px 覆盖。
 *
 * 反例自证：把 `.boot-cap` 改成 41 / 删掉 `boot-title-row` / 恢复 `html.is-mac .boot-cap`
 * 都必须红 —— 否则这条判据只是「两边都读了一遍」的空转。
 *
 * 2026-11-07 骨架同步：数值本身已搬到 `src/boot/skeletonTokens.ts`（构建时从 style.css 物化），
 * 本函数只守「结构占位还在、并且真的接了 var(--boot-*)」，数值同源由 SK-04 守。
 */
export function checkBootSkeletonGeometry(s: BootSkeletonSources): GuardIssue[] {
  const out: GuardIssue[] = [];
  const usesVar = (re: RegExp) => re.test(s.skeletonCss);

  if (!usesVar(/\.boot-cap\s*\{[^}]*height:\s*var\(--boot-title-h\)/)) {
    out.push({ line: 0, message: "SK-02：骨架标题栏没有接上 `var(--boot-title-h)`（与真实标题栏不同源，首帧会跳位）。" });
  }
  if (/html\.is-mac\s+\.boot-cap/.test(s.skeletonCss)) {
    out.push({ line: 0, message: "SK-02：骨架里还留着 `html.is-mac .boot-cap` 的 28px 覆盖（`.platform-mac` 已删除）。" });
  }
  if (!usesVar(/\.boot-head\s*\{[^}]*height:\s*var\(--boot-header-h\)/)) {
    out.push({ line: 0, message: "SK-02：骨架对话头没有接上 `var(--boot-header-h)`。" });
  }
  if (!usesVar(/\.boot-title-row\s*\{[^}]*height:\s*var\(--boot-list-title-h\)/)) {
    out.push({
      line: 0,
      message: "SK-02：骨架列表标题行没有接上 `var(--boot-list-title-h)`（缺这一行整列会话会整体上移 50px）。",
    });
  }
  if (!/h-\[var\(--gosslan-list-title-h\)\]/.test(s.conversationList)) {
    out.push({
      line: 0,
      message: "SK-02：真实列表标题行没有引用 `--gosslan-list-title-h` —— 骨架与真实布局不再是同一份来源。",
    });
  }
  if (!/<div class="boot-title-row">/.test(s.indexHtml)) {
    out.push({ line: 0, message: "SK-02：index.html 缺 `boot-title-row` 占位，CSS 里的 50px 行等于没渲染。" });
  }
  if (!usesVar(/\.boot-composer\s*\{[^}]*border-radius:\s*var\(--boot-radius-2xl\)/)) {
    out.push({ line: 0, message: "SK-02：骨架输入卡圆角没有接上 `var(--boot-radius-2xl)`。" });
  }
  return out;
}

/**
 * CF-01：每一扇窗都必须接受「非活动窗口的第一击」（`acceptFirstMouse`）。
 *
 * 2026-11-07 用户实测：崩溃恢复条的「知道了」、长文本 / 代码块弹窗里的按钮，
 * **第一下点击无效，要点第二下**。这不是 DOM 的问题 —— 那几个按钮全都是 `@click`
 * （`CrashNotice.vue` 的容器还是 `pointer-events: none` + 卡片 `auto`），
 * 而是 macOS 的默认窗口行为：窗口不在前台时，第一击只激活窗口、不投递给 webview。
 * Tauri 的开关就是 `acceptFirstMouse`（builder 上是 `accept_first_mouse(true)`）。
 *
 * 判据同时盯两处，缺一即红：
 *   ① `tauri.conf.json` 里 `app.windows[]` 每一项都是 `acceptFirstMouse: true`
 *      （主窗口走配置、不走 Rust builder）；
 *   ② 每个 `WebviewWindowBuilder::new(` 的链式调用里，`build()` 之前有
 *      `.accept_first_mouse(true)` —— 设置 / 日志 / 群任务 / 预览 / 外链 / 启动错误
 *      六扇窗都是运行时建的，漏一扇就等于那扇窗的第一击还是会丢。
 * 反例自证：把某一处删掉（或配置改回 false）必须报红。
 */
export function checkAcceptFirstMouse(s: { confJson: string; rustSources: string[] }): GuardIssue[] {
  const out: GuardIssue[] = [];

  let conf: unknown;
  try {
    conf = JSON.parse(s.confJson);
  } catch {
    return [{ line: 0, message: "CF-01：`tauri.conf.json` 解析失败，无法核对 `acceptFirstMouse`。" }];
  }
  const windows = (conf as { app?: { windows?: Array<Record<string, unknown>> } })?.app?.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    out.push({ line: 0, message: "CF-01：`app.windows` 为空 —— 判据会扫空。" });
  } else {
    windows.forEach((w, i) => {
      if (w?.acceptFirstMouse !== true) {
        out.push({
          line: 0,
          message:
            `CF-01：\`app.windows[${i}]\`（label=${String(w?.label ?? "?")}）没有 \`acceptFirstMouse: true\` —— ` +
            "macOS 上非活动窗口的第一下点击只激活窗口、按钮要点两次。",
        });
      }
    });
  }

  const marker = "WebviewWindowBuilder::new(";
  for (const src of s.rustSources) {
    let idx = src.indexOf(marker);
    while (idx >= 0) {
      const end = src.indexOf(".build()", idx);
      const chain = end < 0 ? src.slice(idx) : src.slice(idx, end);
      if (!/\.accept_first_mouse\(true\)/.test(chain)) {
        out.push({
          line: lineAt(src, idx),
          message:
            "CF-01：这扇运行时创建的窗口没有 `.accept_first_mouse(true)` —— " +
            "macOS 上它的按钮第一击会被窗口激活吃掉。加在 `.build()` 之前。",
        });
      }
      idx = src.indexOf(marker, idx + marker.length);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 桌面三栏的最窄宽度（= 断点；更窄走移动布局，没有桌面 caption 系统按钮）。 */
const BOOT_NARROW_DESKTOP_W = 768;
/** macOS 原生红绿灯占位：与 `TitleBar.vue` 的 `w-[78px]` 同一来源。 */
const BOOT_MAC_TRAFFIC_W = 78;
/** Windows 三大金刚键：3 × `w-11`(44px)。 */
const BOOT_WIN_CAPTION_W = 132;
/**
 * 骨架 brand 文案的保守最大宽度。
 * 12px 字号下「小院儿 · 正在启动…」≈ 108px、"Gosslan · Starting…" ≈ 104px；
 * 留到 160 兜住字体回退（用户自选字体可能更宽）与后续文案变长。
 */
const BOOT_BRAND_MAX_W = 160;

/**
 * SK-03：首屏骨架的启动文案不许压在系统标题栏按钮下面。
 *
 * 2026-11-07 用户实测（macOS）：「小院儿 · 正在启动…」被红绿灯盖住。
 * 根因不是字号也不是高度，而是 `.boot-cap` 把 brand **左对齐**：它落在 14px，
 * 而 macOS 红绿灯占 0–78px、Windows 三大金刚键占右侧 132px —— 两侧系统区都会压到文案。
 * 真实的 `TitleBar` 标题是**绝对居中**的，骨架也必须同构，所以修法是居中而不是让位。
 *
 * 判据不是"文件里出现过 justify-content"，而是按声明的对齐方式**算出** brand 盒
 * （最窄桌面窗 768 × 保守最宽 160），再分别与 macOS / Windows 的系统按钮区求交。
 * 反例自证：删掉 `justify-content: center` 后 brand 回到 14px，与红绿灯区相交 ⇒ 必红。
 */
export function checkBootCapBrandSafe(s: { skeletonCss: string; indexHtml: string }): GuardIssue[] {
  const out: GuardIssue[] = [];
  const cap = /\.boot-cap\s*\{([^}]*)\}/.exec(s.skeletonCss);
  if (!cap) {
    return [{ line: 0, message: "SK-03：找不到 `.boot-cap` 规则 —— 无法核对启动文案与系统按钮的避让。" }];
  }
  if (!/<div class="boot-cap">[\s\S]*?class="boot-brand"/.test(s.indexHtml)) {
    out.push({ line: 0, message: "SK-03：`index.html` 的 `.boot-cap` 里找不到 `.boot-brand` —— 判据会扫空。" });
  }

  const body = cap[1];
  const centered = /justify-content:\s*center/.test(body);
  // 左内距：显式 `padding-left` 优先，否则从 `padding` 简写里取水平值，缺省 0。
  const padLeftDecl = /padding-left:\s*(\d+)px/.exec(body);
  const padShort = /(?:^|[^-])padding:\s*([^;]+);/.exec(body);
  let padLeft = 0;
  if (padLeftDecl) {
    padLeft = Number(padLeftDecl[1]);
  } else if (padShort) {
    const parts = padShort[1].trim().split(/\s+/);
    const horizontal = parts.length >= 2 ? parts[1] : parts[0];
    padLeft = Number((/(\d+)px/.exec(horizontal) ?? [])[1] ?? 0);
  }

  const brandLeft = centered ? (BOOT_NARROW_DESKTOP_W - BOOT_BRAND_MAX_W) / 2 : padLeft;
  const brandRight = brandLeft + BOOT_BRAND_MAX_W;

  if (brandLeft < BOOT_MAC_TRAFFIC_W) {
    out.push({
      line: 0,
      message:
        `SK-03：骨架启动文案左缘 ${brandLeft}px 侵入 macOS 红绿灯区（0–${BOOT_MAC_TRAFFIC_W}px）。` +
        "`.boot-cap` 必须 `justify-content: center`（真实标题栏的标题是绝对居中的）。",
    });
  }
  if (brandRight > BOOT_NARROW_DESKTOP_W - BOOT_WIN_CAPTION_W) {
    out.push({
      line: 0,
      message:
        `SK-03：骨架启动文案右缘 ${brandRight}px 侵入 Windows 三大金刚键区` +
        `（${BOOT_NARROW_DESKTOP_W - BOOT_WIN_CAPTION_W}–${BOOT_NARROW_DESKTOP_W}px）。`,
    });
  }
  return out;
}

// ---------------- CS：聊天输入区表面（与消息区同一整块画布） ----------------

/**
 * 聊天输入区外壳必须与消息区是**同一整块画布**：透明、无分隔线、无阴影、无第二层底；
 * 输入卡的圆角与 1px 描边不随档位变化。
 *
 * 2026-11-05 真机反馈（5.18.30，Windows）：「开背景动效后底部输入区整条变成纯白长条，
 * 圆角和玻璃感全丢」——当时的修法是给外壳一层有色调 `--gosslan-bg`。
 * 2026-11-07 用户口径**推翻该修法**：「输入框背后与左右空隙必须跟消息区是同一整块，
 * 不许独立实色面板/分隔线/第二层底」。纯白长条的正解不是换个颜色再铺一层，
 * 而是**这一层底色根本不该存在**：外壳透明，画布由父级提供，输入卡才是那张浮起的卡片。
 *
 * 外壳一旦透明就必须脱离文档流（`absolute`），高度不再由流内占位提供——
 * 所以必须自己实测高度让消息区让位，缺一处就会被输入卡盖住：
 *   · 消息区 `paddingBottom = composerH`（ResizeObserver 实测，不许写常量）；
 *   · 「回到最新」与抖动提示吃同一个 `composerH`。
 *
 * 反例自证：把外壳涂成任何 `bg-[var(--…)]` / 加 `border-t` / 加 `shadow` / 删掉
 * `data-composer-shell` / 把消息区 `paddingBottom` 换回固定值 —— 都必须红。
 *
 * @param chatWindowSrc `src/components/ChatWindow.vue`
 * @param composerSrc   `src/components/chat/MessageComposer.vue`
 * @param styleCss      `src/style.css`（CS-02 要对账 `--gosslan-radius-2xl` 的实际像素值）
 */
export function checkComposerSurface(chatWindowSrc: string, composerSrc: string, styleCss: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  const classesOf = (tag: string): string[] => {
    const m = tag.match(/\bclass="([^"]*)"/);
    return (m?.[1] ?? "").split(/\s+/).filter(Boolean);
  };

  // 外壳：用 `data-composer-shell` 锚点定位（不再靠 `shrink-0 + px-4 + pt-2` 这组会变的类）。
  const shells = [...chatWindowSrc.matchAll(/<div[^>]*\bdata-composer-shell[^>]*>/g)];
  if (shells.length !== 1) {
    out.push({
      line: 0,
      message: `CS-01：聊天输入区外壳应恰好 1 处（\`data-composer-shell\`），实际 ${shells.length} 处 —— 无法确认它是否与消息区同一整块画布。`,
    });
  }
  for (const m of shells) {
    const tag = m[0];
    const c = classesOf(tag);
    const line = lineAt(chatWindowSrc, m.index ?? 0);
    if (!c.includes("bg-transparent")) {
      const bg = c.find((t) => t.startsWith("bg-") && t !== "bg-transparent");
      out.push({
        line,
        message: bg
          ? `CS-01：聊天输入区外壳涂了 \`${bg}\` —— 这是第二层底，会与消息区割成两块（用户 2026-11-07 明确禁止）。`
          : "CS-01：聊天输入区外壳缺少 `bg-transparent` —— 底色必须显式交给父级画布，否则会继承成实色面板。",
      });
    }
    if (c.some((t) => /^border-t(?:-|$)/.test(t))) {
      out.push({ line, message: "CS-01：聊天输入区外壳出现 `border-t` —— 用户要求输入区与消息区连成一块，不许分隔线。" });
    }
    if (c.some((t) => /^shadow(?:-|$)|^drop-shadow-/.test(t))) {
      out.push({ line, message: "CS-01：聊天输入区外壳出现投影类 —— 外壳不是浮起的那张卡，投影只属于输入卡自己。" });
    }
    if (c.includes("shrink-0")) {
      out.push({ line, message: "CS-01：聊天输入区外壳仍是流内 `shrink-0` —— 透明外壳必须 `absolute` 脱离流并由实测高度让位。" });
    }
    for (const needle of ["absolute", "inset-x-0", "bottom-0"]) {
      if (!c.includes(needle)) {
        out.push({ line, message: `CS-01：聊天输入区外壳缺 \`${needle}\` —— 它必须以覆盖层形式压在消息区底部。` });
      }
    }
  }

  // 消息区：必须吃实测高度让位（写死常量会随字体档/附件行高/移动端安全区失效）。
  const msgArea = [...chatWindowSrc.matchAll(/<div[^>]*>/g)]
    .map((m) => m[0])
    .find((tag) => {
      const c = classesOf(tag);
      return c.includes("relative") && c.includes("min-h-0") && c.includes("flex-1") && c.includes("overflow-hidden");
    });
  if (!msgArea) {
    out.push({ line: 0, message: "CS-01：找不到消息区（`relative min-h-0 flex-1 overflow-hidden`），无法确认输入区让位。" });
  } else if (!msgArea.includes("paddingBottom: composerH")) {
    out.push({
      line: lineAt(chatWindowSrc, chatWindowSrc.indexOf(msgArea)),
      message: "CS-01：消息区没有 `paddingBottom: composerH` —— 透明外壳不再占位，末条消息会被输入卡盖住。",
    });
  }
  // 高度必须实测：ResizeObserver 观测外壳本身，不许用常量/百分比。
  if (!/new ResizeObserver\(/.test(chatWindowSrc) || !chatWindowSrc.includes("observe(composerShell.value)")) {
    out.push({
      line: 0,
      message: "CS-01：输入区高度没有 `ResizeObserver` 实测（`observe(composerShell.value)` 找不到）—— 让位量会过期。",
    });
  }
  // 「回到最新」必须吃同一个实测高度。
  const btl = chatWindowSrc.match(/<BackToLatestButton[\s\S]*?\/>/)?.[0] ?? "";
  if (!btl) {
    out.push({ line: 0, message: "CS-01：找不到 `<BackToLatestButton … />` —— 无法确认它是否让位。" });
  } else if (!btl.includes(':bottom-offset="composerH"')) {
    out.push({
      line: lineAt(chatWindowSrc, chatWindowSrc.indexOf(btl)),
      message: "CS-01：「回到最新」没有吃 `:bottom-offset=\"composerH\"` —— 会被悬浮输入卡压住。",
    });
  }

  // 输入卡：圆角与 1px 描边必须是**静态常数**，不随玻璃三档/降级档变化。
  const card = [...composerSrc.matchAll(/<div[^>]*>/g)].find((m) =>
    classesOf(m[0]).includes("gosslan-composer"),
  );
  if (!card) {
    out.push({ line: 0, message: "CS-02：MessageComposer 里找不到 `.gosslan-composer` 输入卡，无法确认圆角与描边。" });
  } else {
    const c = classesOf(card[0]);
    if (!c.includes("rounded-[var(--gosslan-radius-2xl)]")) {
      out.push({
        line: lineAt(composerSrc, card.index ?? 0),
        message: "CS-02：输入卡缺少 22px 圆角（`rounded-[var(--gosslan-radius-2xl)]`）—— 外壳按画板是 22px（不是 md 的 10px），且必须不随玻璃档位变化。",
      });
    }
    const shellRadius = Number(styleCss.match(/--gosslan-radius-2xl\s*:\s*(\d+)px/)?.[1] ?? 0);
    if (shellRadius !== 22) {
      out.push({
        line: 0,
        message: `CS-02：\`--gosslan-radius-2xl\` 必须是 22px（画板 composer shell），实际 ${shellRadius || "缺失"}px —— 类名对上了但值漂了等于没改。`,
      });
    }
    if (!c.includes("border") || !c.includes("border-[var(--gosslan-field-border)]")) {
      out.push({
        line: lineAt(composerSrc, card.index ?? 0),
        message: "CS-02：输入卡缺少 1px 全档描边（`border border-[var(--gosslan-field-border)]`）。",
      });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}

/* ============================================================================
 * AC —— 背景动效下「该透却没透」的 chrome / float 面（2026-11-05）
 *
 * 用户第二次反馈：「背景好看，但聊天窗口里还有若干该透却不透的面板很突兀」，
 * 并把范围扩到通讯录字母分组、悬浮件。判据来自：
 *   · `docs/design-language/liquid-glass.md` §4.1/§5.2：chrome（标题栏/侧栏/输入区外框）
 *     与 float（右键菜单/下拉/tooltip/Toast）**不许是实色承载面**；内容面（气泡/代码块/
 *     输入框本体/设置卡片）才要求 alpha ≥0.95。
 *   · `ambient-motion.md` AM-11：一片雾只许铺一层纱。嵌套容器走 `.ambient-canvas-child`
 *     （清掉自己的实色底、不再叠第二层纱），而不是自己再画一层 `color-mix` 薄纱。
 *   · 亮色下 `--gosslan-chat` / `--gosslan-panel` **就是 #ffffff**：给 chrome 挂这两个 token
 *     等于在流动雾面上糊一块纯白板 —— 这正是用户肉眼看到的"突兀白块"。
 *
 * 为什么判类名而不是判像素：这是**静态**回归闸。像素读数在 `scripts/check-ui-runtime.mjs`
 * 的 `--only=surfaces` 段里（8 组合 × 逐元素 + 截图像素采样），那一层负责"现在长什么样"，
 * 这一层负责"下次谁把它改回去就红"。
 * ========================================================================== */

/** 硬编码纯白：用户点名要清的四种写法（含 `bg-white` 与 `#fff` / `#ffffff` / `rgb(255,255,255)`）。 */
export const HARD_WHITE_PATTERNS: RegExp[] = [
  /\bbg-white\b/,
  /\bbg-\[#fff(?:fff)?\]/i,
  /\bbackground(?:-color)?:\s*(?:#fff(?:fff)?|white)\b/i,
  /\bbackground(?:-color)?:\s*rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)/i,
];

/** 去掉注释再扫白：注释里解释「亮色下就是 #fff」不该被判红。 */
function stripMarkupComments(src: string): string {
  return src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export interface AmbientChromeSources {
  chatHeader: string;
  chatWindow: string;
  backToLatest: string;
  friendProfile: string;
  responsiveLayout: string;
  messageItem: string;
  conversationList: string;
  searchDialog: string;
  settingsGroup: string;
  /** 全部引用 `--gosslan-divider-strong` 的 `.vue` 文件（仓库相对路径，换行分隔）。 */
  dividerStrongUsers: string;
  styleCss: string;
}

const AMBIENT_CHILD = "ambient-canvas-child";

export function checkAmbientChromeSurfaces(src: AmbientChromeSources): GuardIssue[] {
  const out: GuardIssue[] = [];
  const classesOf = (m: RegExpMatchArray): string[] => (m[1] ?? "").split(/\s+/).filter(Boolean);

  // AC-01：聊天顶部栏是 chrome（L2），必须参与薄纱，不许自己画实色。
  const header = [...src.chatHeader.matchAll(/<div[^>]*\sclass="([^"]*)"/g)].find((m) =>
    classesOf(m).includes("bg-[var(--gosslan-chat)]"),
  );
  if (!header) {
    out.push({ line: 0, message: "AC-01：ChatHeader 里找不到 `bg-[var(--gosslan-chat)]` 的顶栏容器，无法确认它是否参与薄纱。" });
  } else if (!classesOf(header).includes(AMBIENT_CHILD)) {
    out.push({
      line: lineAt(src.chatHeader, header.index ?? 0),
      message:
        "AC-01：聊天顶部栏缺少 `.ambient-canvas-child` —— 背景动效开启时它在透明的消息区上面会露成一条纯白横条" +
        "（亮色下 --gosslan-chat 就是 #ffffff）。",
    });
  }

  // AC-02：输入区外框同样属于 chrome；CS-01 管"有色调"，这里管"参与薄纱"。
  const strip = [...src.chatWindow.matchAll(/<div[^>]*\sclass="([^"]*)"/g)].filter((m) => {
    const c = classesOf(m);
    return c.includes("shrink-0") && c.includes("px-4") && c.includes("pt-2");
  });
  for (const m of strip) {
    if (!classesOf(m).includes(AMBIENT_CHILD)) {
      out.push({
        line: lineAt(src.chatWindow, m.index ?? 0),
        message:
          "AC-02：聊天输入区外框缺少 `.ambient-canvas-child` —— 即使底色有色调，它仍是全宽不透明层，" +
          "动效开启时会在底部压出一道与消息区无关的色带（同屏还多一层纱，违反 AM-11）。",
      });
    }
  }

  // AC-03：悬浮件走 float 档（glass-2 / `.frost`），不许用内容面 token 当实底。
  const btl = [...src.backToLatest.matchAll(/<button[^>]*\sclass="([^"]*)"/g)].find((m) =>
    classesOf(m).includes("rounded-full"),
  );
  if (!btl) {
    out.push({ line: 0, message: "AC-03：BackToLatestButton 找不到圆角悬浮按钮，无法确认它的档位。" });
  } else {
    const c = classesOf(btl);
    if (!c.includes("frost")) {
      out.push({
        line: lineAt(src.backToLatest, btl.index ?? 0),
        message: "AC-03：「回到最新」是 L3 悬浮件，必须用 `.frost`（float 档），当前不是。",
      });
    }
    if (c.includes("bg-[var(--gosslan-panel)]") || c.some((x) => HARD_WHITE_PATTERNS.some((re) => re.test(x)))) {
      out.push({
        line: lineAt(src.backToLatest, btl.index ?? 0),
        message: "AC-03：「回到最新」用了 `--gosslan-panel`（亮色下 #ffffff）当实底 —— 悬浮件不许是纯白实色。",
      });
    }
  }

  // AC-04：聊天窗口里"绝对定位 + 全圆角 + 面板实底"的药丸一律视为悬浮件，必须走 frost。
  for (const m of src.chatWindow.matchAll(/<div[^>]*\sclass="([^"]*)"/g)) {
    const c = classesOf(m);
    const floatingPill = c.includes("absolute") && c.includes("rounded-full");
    if (!floatingPill) continue;
    if (c.includes("bg-[var(--gosslan-panel)]") || c.includes("bg-white")) {
      out.push({
        line: lineAt(src.chatWindow, m.index ?? 0),
        message: "AC-04：聊天窗口里的悬浮药丸（absolute + rounded-full）用了面板实底，改 `.frost`。",
      });
    }
  }

  // AC-05：资料页整页是内容区外壳，必须让画布纱透上来（与 ChatWindow 根同一条约定）。
  const profileRoot = [...src.friendProfile.matchAll(/<div[^>]*\sclass="([^"]*)"/g)].find((m) => {
    const c = classesOf(m);
    return c.includes("h-full") && c.includes("flex-col") && c.includes("bg-[var(--gosslan-chat)]");
  });
  if (!profileRoot) {
    out.push({ line: 0, message: "AC-05：FriendProfile 找不到整页外壳，无法确认它是否参与薄纱。" });
  } else if (!classesOf(profileRoot).includes(AMBIENT_CHILD)) {
    out.push({
      line: lineAt(src.friendProfile, profileRoot.index ?? 0),
      message: "AC-05：通讯录资料页外壳缺少 `.ambient-canvas-child` —— 背景动效下整页会是纯白板。",
    });
  }

  // AC-06：四个源里不许再出现硬编码纯白（注释除外）。
  const named = [
    ["ChatHeader.vue", src.chatHeader],
    ["ChatWindow.vue", src.chatWindow],
    ["BackToLatestButton.vue", src.backToLatest],
    ["FriendProfile.vue", src.friendProfile],
  ] as const;
  for (const [name, s] of named) {
    const body = stripMarkupComments(s);
    for (const re of HARD_WHITE_PATTERNS) {
      const m = re.exec(body);
      if (m) {
        out.push({
          line: lineAt(body, m.index),
          message: `AC-06：${name} 出现硬编码纯白（\`${m[0]}\`）—— 亮/暗两侧都不会跟随主题，改用 --gosslan-* token 或 .frost。`,
        });
      }
    }
  }

  // AC-07：主壳（ResponsiveLayout）里凡是拿「亮色即纯白」的 token 铺满一区的容器，
  // 要么自己就是画布纱（`.ambient-canvas`，main/aside），要么必须挂 `.ambient-canvas-child`。
  // 漏挂的形态：动效开启后父层已是透明的，这一块仍是实色 ⇒ 就是用户看到的「突兀白块」
  // （2026-11-05 第二轮：通讯录/会话列表之外，「我的」页与「新的朋友」页仍在裸奔）。
  for (const m of src.responsiveLayout.matchAll(/<[a-zA-Z][^>]*\sclass="([^"]*)"/g)) {
    const c = classesOf(m);
    const whitish = c.includes("bg-[var(--gosslan-chat)]") || c.includes("bg-[var(--gosslan-list)]");
    if (!whitish) continue;
    const isVeil = c.some((x) => x === "ambient-canvas" || x === AMBIENT_CHILD);
    if (!isVeil) {
      out.push({
        line: lineAt(src.responsiveLayout, m.index ?? 0),
        message:
          "AC-07：ResponsiveLayout 里这一区用 `--gosslan-chat` / `--gosslan-list` 铺底（亮色下 chat 就是 #ffffff），" +
          "但既不是 `.ambient-canvas` 也没挂 `.ambient-canvas-child` —— 动效开启后会在透明的父层上露成实色块。",
      });
    }
  }

  // AC-08：消息流里的时间/未读分割线是 **chrome**，不能横贯消息区铺一条纯白带；
  // 但它同时承担"选中底色只画在消息块里、不画到时间行"的职责（用户 2026-09-21），
  // 所以只允许一种写法：`tintOn` 为真时保持实底、否则挂 `.ambient-canvas-child`。
  const dividers: Array<[string, RegExp]> = [
    ["showTimeDivider", /<div[^>]*\bv-if="showTimeDivider"[^>]*>/g],
    ["showUnreadDivider", /<div[^>]*\bv-if="showUnreadDivider"[^>]*>/g],
  ];
  for (const [name, re] of dividers) {
    for (const m of src.messageItem.matchAll(re)) {
      if (!m[0].includes("ambient-canvas-child")) {
        out.push({
          line: lineAt(src.messageItem, m.index ?? 0),
          message:
            `AC-08：消息流分割线（\`${name}\`）没有按 \`tintOn\` 条件挂 \`.ambient-canvas-child\` —— ` +
            "动效开启时它会在透明的消息区上横贯一条纯白带。",
        });
      }
    }
  }

  // AC-09：通讯录字母分组 sticky 条必须"半透明 + 雾化"，且四档降级都退回实底。
  // 单独立判据的原因：这条条子不带正文、又必须压在滚动行上，最容易被"顺手改成纯白"
  // （丢掉层次）或"顺手改成全透明"（行滚上来时字母糊掉）各改一次。
  const veilRules = [...src.styleCss.matchAll(/\.gosslan-sticky-veil\s*\{/g)];
  if (veilRules.length < 5) {
    out.push({
      line: 0,
      message:
        `AC-09：style.css 里 \`.gosslan-sticky-veil\` 规则只有 ${veilRules.length} 条，至少要 1 条基线 + 4 条降级` +
        "（减少透明 / 应用内开关 / 高对比度 / @supports not）——少一条就意味着某一档下它会变成透明看不见。",
    });
  } else {
    const at = veilRules[0].index ?? 0;
    const base = src.styleCss.slice(at, at + 420);
    if (
      !/color-mix\(in srgb,\s*var\(--gosslan-list\)\s*72%,\s*transparent\)/.test(base) ||
      !/blur\(8px\)/.test(base)
    ) {
      out.push({
        line: lineAt(src.styleCss, at),
        message: "AC-09：sticky 条的基线不是「list 72% + blur(8px)」——改阈值前先回到设计文档里的三档读数。",
      });
    }
    for (let i = 1; i < veilRules.length; i += 1) {
      const pos = veilRules[i].index ?? 0;
      const seg = src.styleCss.slice(pos, pos + 320);
      if (!/background:\s*var\(--gosslan-list\)/.test(seg) || !/backdrop-filter:\s*none/.test(seg)) {
        out.push({
          line: lineAt(src.styleCss, pos),
          message:
            "AC-09：sticky 条有一条降级没有退回 `background: var(--gosslan-list)` + `backdrop-filter: none` —— " +
            "降级档会变成半透明无底，字母压在滚动行上不可读。",
        });
      }
    }
  }

  // AC-10：字母分组条本身不许再挂 list/chat 实底（那会把 AC-09 的 72% 直接盖成 100%）。
  const stickyEl = [...src.conversationList.matchAll(/<div[^>]*\sclass="([^"]*)"/g)].find((m) =>
    classesOf(m).includes("sticky"),
  );
  if (!stickyEl) {
    out.push({ line: 0, message: "AC-10：ConversationList 里找不到 `sticky` 的字母分组条，无法确认它的档位。" });
  } else {
    const cls = classesOf(stickyEl);
    if (!cls.includes("gosslan-sticky-veil")) {
      out.push({
        line: lineAt(src.conversationList, stickyEl.index ?? 0),
        message: "AC-10：字母分组条没有 `.gosslan-sticky-veil` —— 背景动效下它会是一条纯白实条。",
      });
    }
    if (
      cls.includes("bg-[var(--gosslan-list)]") ||
      cls.includes("bg-[var(--gosslan-chat)]") ||
      HARD_WHITE_PATTERNS.some((re) => re.test(cls.join(" ")))
    ) {
      out.push({
        line: lineAt(src.conversationList, stickyEl.index ?? 0),
        message: "AC-10：字母分组条自己挂了实底 token —— 会把 `.gosslan-sticky-veil` 的 72% 盖成 100%。",
      });
    }
  }

  // AC-11：搜索对话框左右两列必须"透明 + 一条分隔线"。
  // 两列各挂 list/chat 实底时，外层 `.glass-3` 的雾等于被自己盖掉两层。
  if (
    src.searchDialog.includes("bg-[var(--gosslan-list)]") ||
    src.searchDialog.includes("bg-[var(--gosslan-chat)]")
  ) {
    out.push({
      line: 0,
      message: "AC-11：ChatSearchDialog 里又出现 `bg-[var(--gosslan-list|chat)]` —— 两列退回实底会把外层 glass-3 的雾盖掉。",
    });
  }
  if (!src.searchDialog.includes("desktop:md:border-r")) {
    out.push({
      line: 0,
      message: "AC-11：两列去实底后必须留一根分隔线（`desktop:md:border-r` 找不到），否则层次不可辨。",
    });
  }

  // AC-12：设置卡片是**内容承载面**，刻意保持实色（`docs/design-language/liquid-glass.md` §4.2 已写明）。
  // 这条判据的存在是为了拦住下一次"该透却没透"式的误改。
  if (!src.settingsGroup.includes("bg-[var(--gosslan-panel)]")) {
    out.push({
      line: 0,
      message:
        "AC-12：设置卡片（SettingsGroup）不再是实色面板 —— 它是内容承载面，刻意保持实色，不是漏改。要动它先改 liquid-glass.md 的口径。",
    });
  }

  // AC-13：移动端底部 TabBar 走 float 档（`.frost`），并保留"半透明无 blur"降级开关。
  const tabbar = [...src.responsiveLayout.matchAll(/<nav[^>]*\sclass="([^"]*)"/g)].find((m) =>
    classesOf(m).includes("safe-bottom"),
  );
  if (!tabbar) {
    out.push({ line: 0, message: "AC-13：ResponsiveLayout 里找不到 `safe-bottom` 的底部 TabBar。" });
  } else {
    const cls = classesOf(tabbar);
    if (!cls.includes("frost")) {
      out.push({
        line: lineAt(src.responsiveLayout, tabbar.index ?? 0),
        message: "AC-13：底部 TabBar 没走 `.frost` —— 它会是一整条压在滚动内容上的实色板。",
      });
    }
    if (
      cls.includes("bg-[var(--gosslan-panel)]") ||
      HARD_WHITE_PATTERNS.some((re) => re.test(cls.join(" ")))
    ) {
      out.push({
        line: lineAt(src.responsiveLayout, tabbar.index ?? 0),
        message: "AC-13：底部 TabBar 自己挂了实色底（`--gosslan-panel` 亮色即 #ffffff），把 float 档盖成了实板。",
      });
    }
  }
  // 2026-11-07 审查 M-7：`html[data-frost="off"]` 是死开关（全仓无 setAttribute），已删除。
  // 真实降级入口是 `data-reduced-transparency`，由 AM-07 守着（那个块同时摘雾并落实底），
  // 所以这里不再断言 frost 开关；反向自证改为"谁把死开关加回来就红"。
  if (/^html\[data-frost="off"\]\s*\.frost\s*\{/m.test(src.styleCss)) {
    out.push({
      line: 0,
      message: "AC-13：死开关 `html[data-frost=\"off\"]` 又回来了 —— 它没有 setAttribute 入口，只有 devtools 能拨。",
    });
  }

  // AC-14：搜索两列的分隔线走**专用**强分隔线 token（两列都透明，发丝线撑不起层次），
  // 但全站 `--gosslan-divider` 必须保持发丝线原值 —— 那处一次改动会波及上百处行分隔。
  const strongDefs = [...src.styleCss.matchAll(/^\s*--gosslan-divider-strong:\s*([^;]+);/gm)];
  if (strongDefs.length < 2) {
    out.push({
      line: 0,
      message:
        `AC-14：\`--gosslan-divider-strong\` 只有 ${strongDefs.length} 处定义（亮/暗各至少要一处）—— ` +
        "缺一档时那个主题下的分栏线会掉回继承值。",
    });
  } else if (strongDefs[0][1].trim() === strongDefs[1][1].trim()) {
    out.push({
      line: lineAt(src.styleCss, strongDefs[1].index ?? 0),
      message: "AC-14：`--gosslan-divider-strong` 的亮/暗两档同值 —— 暗底上那档会掉到 3:1 以下。",
    });
  }
  const hairlineDefs = [...src.styleCss.matchAll(/^\s*--gosslan-divider:\s*([^;]+);/gm)];
  if (
    hairlineDefs.length < 2 ||
    hairlineDefs[0][1].trim() !== "#eef0f3" ||
    hairlineDefs[1][1].trim() !== "#2e2f31"
  ) {
    out.push({
      line: 0,
      message:
        "AC-14：全站发丝线（`--gosslan-divider`）的亮/暗取值（#eef0f3 / #2e2f31）被动了 —— " +
        "它是全站上百处行分隔的唯一来源，改它必须同步更新本锚点并重跑对比度，不许各组件另写一条分隔线。",
    });
  }
  // 2026-11-20：左栏已迁到统一滚动容器 <OverlayScroll>（两处都要认）。
  const colLeft = [...src.searchDialog.matchAll(/<(?:div|OverlayScroll)[^>]*\sclass="([^"]*)"/g)].find((m) =>
    classesOf(m).includes("desktop:md:border-r"),
  );
  if (!colLeft) {
    out.push({ line: 0, message: "AC-14：ChatSearchDialog 里找不到两列分隔线（`desktop:md:border-r`）。" });
  } else if (!classesOf(colLeft).includes("border-[var(--gosslan-divider-strong)]")) {
    out.push({
      line: lineAt(src.searchDialog, colLeft.index ?? 0),
      message: "AC-14：搜索两列的分隔线没用 `--gosslan-divider-strong` —— 发丝线在两列都透明时只有 1.16:1。",
    });
  }
  const strongUsers = src.dividerStrongUsers.split("\n").filter(Boolean);
  const strayUsers = strongUsers.filter((p) => !p.endsWith("components/search/ChatSearchDialog.vue"));
  if (strongUsers.length === 0 || strayUsers.length > 0) {
    out.push({
      line: 0,
      message:
        "AC-14：`--gosslan-divider-strong` 只允许在 ChatSearchDialog 的两列分隔处使用" +
        `（当前引用：${strongUsers.join(", ") || "无"}）—— 别扩散成全站分隔线。`,
    });
  }

  // AC-15：移动布局里聊天列（`main`，z-20）铺满整屏，下层会话列表（z-10，只 `-translate-x-[30%]`
  // 做视差）**也铺满整屏**。两者都是 `.ambient-canvas` 薄纱（α 0.16/0.14），列表的行文字就从
  // 聊天列下面透出来（用户 2026-11-06 524×1024 截图：聊天列左缘与底部持续露出半截旧列表文字）。
  // 语义：**聊天列永远是不透明的内容承载面，只有它自己的画布允许雾穿透**；被它盖住的列表必须
  // 整层退出合成（`visibility: hidden`），不许靠给 `main` 加 opacity / 换实底去"压住"。
  // 2026-11-09 补第二层：转场**过程中**visibility 还没切，列表按平移进度裁剪（`pane-parallax`
  // 的 0 端 + `.pane-under-chat` 的 70% 端，与 −30% 平移互补）。两条判据都不许丢。
  // 反例自证在 designGuards.test.ts：删 `pane-under-chat` / 删 `pane-parallax` / 改回 visible /
  // 删裁剪 / 改裁剪比例 / 删延迟 / 把两条规则顺序颠倒 / 只改一边的镜像条件，都必须红。
  const listPane = [...src.responsiveLayout.matchAll(/<aside[^>]*>/g)].find((m) =>
    m[0].includes("bg-[var(--gosslan-list)]"),
  );
  const mainPane = [...src.responsiveLayout.matchAll(/<main[^>]*>/g)].find((m) =>
    m[0].includes("bg-[var(--gosslan-chat)]"),
  );
  if (!listPane) {
    out.push({
      line: 0,
      message:
        "AC-15：ResponsiveLayout 里找不到会话列表 `<aside>`（`bg-[var(--gosslan-list)]`）—— " +
        "无法确认上层聊天列是否把它退出合成。",
    });
  } else {
    const tag = listPane[0];
    // 精确匹配独立的 `'pane-under-chat'` 字面量：`' pane-under-chat--instant'` 里也含这个子串，
    // 只按 `includes` 判会让"把类摘掉"的反例漏红。
    if (!/['"]pane-under-chat['"]/.test(tag)) {
      out.push({
        line: lineAt(src.responsiveLayout, listPane.index ?? 0),
        message:
          "AC-15：移动端的会话列表没有挂 `pane-under-chat` —— 它会被聊天列的 16%/14% 薄纱整片透出来" +
          "（用户 2026-11-06：聊天列左缘/底部露出旧列表残行）。",
      });
    }
    if (!/['"]pane-parallax\s*['"]/.test(tag)) {
      out.push({
        line: lineAt(src.responsiveLayout, listPane.index ?? 0),
        message:
          "AC-15：移动端的会话列表没有挂 `pane-parallax` —— 转场期间它整屏宽地压在聊天列下面" +
          "（用户 2026-11-09 安卓端：列表→聊天那 ~280ms 里旧列表从底部残余一下）。",
      });
    }
    if (!/paneAnimate \? 'pane-parallax ' : ''/.test(tag)) {
      out.push({
        line: lineAt(src.responsiveLayout, listPane.index ?? 0),
        message:
          "AC-15：`pane-parallax` 没有跟随 `paneAnimate` —— 一级 tab 瞬时切换（`paneAnimate === false`）" +
          "会跟着播一圈裁剪动画，等于给 tab 切换加了一句位移。",
      });
    }
    if (!/mobileView === 'chat' \|\| favoritesOpen/.test(tag)) {
      out.push({
        line: lineAt(src.responsiveLayout, listPane.index ?? 0),
        message:
          "AC-15：列表的 `pane-under-chat` 条件与 `main` 的 `translate-x-0` 不是同一判据" +
          "（`mobileView === 'chat' || favoritesOpen`）—— 只改一边会留下" +
          "「main 已经盖住整屏、列表还参与合成」的窗口。",
      });
    }
  }
  if (!mainPane) {
    out.push({
      line: 0,
      message: "AC-15：ResponsiveLayout 里找不到聊天列 `<main>`（`bg-[var(--gosslan-chat)]`）—— 无法核对镜像条件。",
    });
  } else {
    if (!/mobileView === 'chat' \|\| favoritesOpen/.test(mainPane[0])) {
      out.push({
        line: lineAt(src.responsiveLayout, mainPane.index ?? 0),
        message:
          "AC-15：`main` 的平移判据不是 `mobileView === 'chat' || favoritesOpen` —— " +
          "它与列表的 `pane-under-chat` 必须镜像，否则会出现「聊天列还是半透明、列表已藏」或反之。",
      });
    }
    if (/\bopacity-\d|opacity:\s*[\d.]+/.test(mainPane[0])) {
      out.push({
        line: lineAt(src.responsiveLayout, mainPane.index ?? 0),
        message:
          "AC-15：`main` 上出现了 opacity —— 聊天列要解决的是「下层列表参与合成」，" +
          "给内容承载面加 opacity 会连自己的文字一起变淡，不是修法。",
      });
    }
  }
  // `pane-parallax` 是常驻档（只在 `paneAnimate` 时挂）：给出裁剪的 0 端，并让回程也走同一套过渡。
  const parallaxRule = [...src.styleCss.matchAll(/html\.is-mobile\s*\.pane-parallax\s*\{([\s\S]*?)\}/g)][0];
  if (!parallaxRule) {
    out.push({
      line: 0,
      message:
        "AC-15：style.css 里没有 `html.is-mobile .pane-parallax` —— 列表的裁剪没有 0 端，" +
        "转场一开始就会整片消失（或回列表时瞬间展开，又从薄纱下透出整片旧列表）。",
    });
  } else {
    const pb = parallaxRule[1];
    if (!/clip-path:\s*inset\(0\s+0\s+0\s+0\)\s*;/.test(pb)) {
      out.push({
        line: lineAt(src.styleCss, parallaxRule.index ?? 0),
        message: "AC-15：`.pane-parallax` 的基准裁剪不是 `inset(0 0 0 0)` —— 列表态必须完整可见。",
      });
    }
    if (!/transition-property:\s*transform,\s*clip-path\s*;/.test(pb)) {
      out.push({
        line: lineAt(src.styleCss, parallaxRule.index ?? 0),
        message:
          "AC-15：`.pane-parallax` 的过渡不是 `transform, clip-path` —— 裁剪与平移必须同一根时钟，" +
          "否则裁剪边会在中途与聊天列左缘错开。",
      });
    }
    if (
      !/transition-duration:\s*var\(--gosslan-duration\),\s*var\(--gosslan-duration\)\s*;/.test(pb) ||
      !/transition-timing-function:\s*var\(--gosslan-ease\),\s*var\(--gosslan-ease\)\s*;/.test(pb)
    ) {
      out.push({
        line: lineAt(src.styleCss, parallaxRule.index ?? 0),
        message:
          "AC-15：`.pane-parallax` 的裁剪没有和平移同长同缓动" +
          "（`transition-duration/timing-function` 两槽都必须是 `var(--gosslan-duration)` / `var(--gosslan-ease)`）。",
      });
    }
  }

  const underRule = [...src.styleCss.matchAll(/html\.is-mobile\s*\.pane-under-chat\s*\{([\s\S]*?)\}/g)][0];
  if (!underRule) {
    out.push({
      line: 0,
      message:
        "AC-15：style.css 里没有 `html.is-mobile .pane-under-chat` 规则 —— " +
        "列表在被聊天列盖住时仍会参与合成（这是 2026-11-06 穿透缺陷本身）。",
    });
  } else {
    const body = underRule[1];
    if (!/visibility:\s*hidden\s*;/.test(body)) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message: "AC-15：`.pane-under-chat` 没有 `visibility: hidden` —— 列表文字仍会从薄纱下透出来。",
      });
    }
    // 三槽顺序是语义：平移 → visibility（延迟到平移结束）→ 裁剪（与平移同轨）。
    if (!/transition-property:\s*transform,\s*visibility,\s*clip-path\s*;/.test(body)) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message:
          "AC-15：`.pane-under-chat` 的 `transition-property` 不是 `transform, visibility, clip-path` —— " +
          "visibility 必须和平移一起参与过渡（否则视差丢帧），clip-path 必须与平移同轨（否则裁剪边错位）。",
      });
    }
    if (!/clip-path:\s*inset\(0\s+70%\s+0\s+0\)\s*;/.test(body)) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message:
          "AC-15：`.pane-under-chat` 的裁剪不是 `inset(0 70% 0 0)` —— 列表 −30% 平移的互补裁剪，" +
          "少了它转场期间旧列表就整片压在聊天列下面（用户 2026-11-09 安卓端残余）。",
      });
    }
    if (!/transition-delay:\s*0s,\s*var\(--gosslan-duration\),\s*0s\s*;/.test(body)) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message:
          "AC-15：`.pane-under-chat` 的 visibility 没有延迟到平移结束（`0s, var(--gosslan-duration), 0s`）—— " +
          "列表会在滑出动画一开始就消失，push/pop 的视差被吃掉。",
      });
    }
    if (!/transition-duration:\s*var\(--gosslan-duration\),\s*0s,\s*var\(--gosslan-duration\)\s*;/.test(body)) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message:
          "AC-15：`.pane-under-chat` 的三槽时长不是 `var(--gosslan-duration), 0s, var(--gosslan-duration)` —— " +
          "裁剪必须和平移同长。",
      });
    }
    if (
      parallaxRule &&
      (parallaxRule.index ?? 0) > (underRule.index ?? 0)
    ) {
      out.push({
        line: lineAt(src.styleCss, underRule.index ?? 0),
        message:
          "AC-15：`.pane-parallax` 必须排在 `.pane-under-chat` **之前** —— 两者同特异性，" +
          "顺序反了就是 `.pane-parallax` 的 0 端覆盖掉裁剪档，转场又退回整片透出。",
      });
    }
  }
  const instantRule = [...src.styleCss.matchAll(/html\.is-mobile\s*\.pane-under-chat--instant\s*\{([\s\S]*?)\}/g)][0];
  if (!instantRule) {
    out.push({
      line: 0,
      message:
        "AC-15：缺 `html.is-mobile .pane-under-chat--instant` —— 一级 tab 瞬时切换（`paneAnimate === false`）" +
        "会白留 240ms 延迟，期间列表仍在合成。",
    });
  } else {
    if (!/transition-delay:\s*0s,\s*0s,\s*0s\s*;/.test(instantRule[1])) {
      out.push({
        line: lineAt(src.styleCss, instantRule.index ?? 0),
        message: "AC-15：`--instant` 档没有把三槽延迟清零（`transition-delay: 0s, 0s, 0s`）。",
      });
    }
    if (!/transition-duration:\s*0s,\s*0s,\s*0s\s*;/.test(instantRule[1])) {
      out.push({
        line: lineAt(src.styleCss, instantRule.index ?? 0),
        message: "AC-15：`--instant` 档没有把三槽时长清零（`transition-duration: 0s, 0s, 0s`）。",
      });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}

/* ============================================================================
 * BT —— 「回到最新」悬浮钮的位置必须恒定（2026-11-08 用户报"一直在上下跳动"后改）
 *
 * 判据来源：2026-11-06 曾按用户截图做成"实测分割行、逐级上移"的避让。运行时探针
 * `--only=backjump` 实测：连滚 0→800px 时按钮 `top` 序列出现 `372 → 336 → 300 → 372`
 * （唯一值 3 个、跨度 72px）—— 分割行滚过按钮就跳一格，滚回去又跳回来。
 *
 * 现在位移只由 `calc(1rem + bottomOffset)` 决定：不读滚动位置、不量分割行、
 * 不挂 scroll/resize 监听；出现/消失只走透明度。
 * 这一层是静态回归闸；像素读数在运行时探针 `--only=backjump`（唯一值必须只有 1 个）。
 * ========================================================================== */

export interface BackToLatestSources {
  button: string;
}

/** 跟随滚动位置重算位移的痕迹：任意一处出现都说明"位置又跟着滚动动了"。 */
const BACK_TO_LATEST_DRIFT_RE = /\bavoidOffset\b|computeBackToLatestAvoidOffset|addEventListener\(\s*["']scroll["']|requestAnimationFrame|getBoundingClientRect/;

export function checkBackToLatestStable(src: BackToLatestSources): GuardIssue[] {
  const out: GuardIssue[] = [];
  const btn = src.button;
  // 注释里解释历史不算违规，先剥注释再扫。
  const code = stripMarkupComments(btn);

  // BT-01：不许有任何"按滚动位置重算位移"的入口。
  // 反例锚点：把 `avoidOffset` 或 scroll 监听加回来必须红（用户报的跳动就是它们造成的）。
  const drift = code.match(BACK_TO_LATEST_DRIFT_RE);
  if (drift) {
    out.push({
      line: lineAt(btn, Math.max(0, btn.indexOf(drift[0]))),
      message:
        `BT-01：「回到最新」又出现了跟随滚动位置重算位移的痕迹（\`${drift[0]}\`）—— ` +
        "圆钮会重新随滚动上下跳动。位置只允许由 `bottomOffset` 决定。",
    });
  }

  // BT-02：位置表达式只能是 `calc(1rem + bottomOffset)`，且必须真的绑到 `bottom`。
  const styleBind = btn.match(/:style="([^"]*)"/)?.[1] ?? "";
  if (!styleBind.includes("calc(1rem +") || !styleBind.includes("bottomOffset")) {
    out.push({
      line: lineAt(btn, btn.indexOf(":style") === -1 ? 0 : btn.indexOf(":style")),
      message:
        "BT-02：「回到最新」的 `bottom` 不是 `calc(1rem + bottomOffset)` —— " +
        "要么没给悬浮输入区让位、要么又接上了变量位移。",
    });
  }
  if (!btn.includes("bottomOffset?: number")) {
    out.push({
      line: 0,
      message: "BT-02：「回到最新」没有 `bottomOffset?: number` prop —— 输入卡高度变化时会被压住或错位。",
    });
  }

  // BT-03：出现/消失只走透明度，不许叠竖向位移。
  if (!btn.includes("gosslan-back-to-latest")) {
    out.push({ line: 0, message: "BT-03：「回到最新」丢了出现动画类 `gosslan-back-to-latest`（只剩透明度这一层反馈）。" });
  }
  if (/\btranslate-y-|\btransition-transform\b|\banimate-/.test(code)) {
    out.push({ line: 0, message: "BT-03：「回到最新」出现了竖向位移/位移动画（`translate-y-*` / `transition-transform` / `animate-*`）—— 出现只许走透明度。" });
  }

  // BT-04：上一轮的硬约束不能被这次改动破坏（热区/不可见态/无新增过渡属性）。
  if (/\btap-safe\b|::after|\bafter:/.test(code)) {
    out.push({
      line: 0,
      message: "BT-04：「回到最新」出现了扩热区写法（`tap-safe` / `::after` / `after:`）—— 36×36 就是全部命中区。",
    });
  }
  for (const needle of ["h-9 w-9", "'pointer-events-none opacity-0'", ':aria-hidden="!visible"', ':tabindex="visible ? 0 : -1"']) {
    if (!btn.includes(needle)) {
      out.push({ line: 0, message: `BT-04：「回到最新」丢失既有约束 \`${needle}\`（热区/不可见态被改坏）。` });
    }
  }

  return out.sort((a, b) => a.line - b.line);
}

// ---------------- IP-01 图片预览：圆角裁剪面必须贴住内容角，且不许写死深色垫底 ----------------

/**
 * 判据来源（用户 2026-11-05「收藏页里的图片缩略图，四个圆角处是黑的」）：
 *
 * 图片字节里可能自带一圈近黑垫底 —— 截图工具把"圆角窗口 + 深色底"一起拍进了 PNG，
 * alpha 全 255，四角 ≈ rgb(36,36,36)。只要 `rounded` 的**裁剪面**落在图片像素角上，
 * 这圈垫底就被整圈切掉；一旦元素框比内容框大（`w-full` + `object-contain` 就是这种），
 * 圆角落在元素框角上、离内容角几百像素（实测 910×288 的元素框里内容只有 423×288 居中），
 * 一个像素都裁不到 ⇒ 源图自带的暗角原样露在白底上。
 *
 * 子判据：
 *   ① `object-contain` 的 `<img>` 不许同时带 `w-full` —— 它把元素框撑到容器满宽，
 *      圆角裁剪面与内容角脱开（这正是本缺陷的成因，不是审美偏好）；
 *   ② 同一支 `<img>` 必须带 `rounded-[var(--gosslan-…radius-…)]` —— 裁剪只由它负责
 *      （消息气泡沿用 `--gosslan-bubble-radius`，与它 18px 的外框同档；其余用 `--gosslan-radius-lg`）。
 *      注意元素框贴住内容后，半径要比**源图自带圆角**大一档，否则重采样模糊带会露出来
 *      （实测源图暗垫 ≈1.5% 宽 = 423px 上 6.3px，md 8px 只剩 0.5px 余量仍露，lg 12px 才有 2.3px 余量）。
 *   ③ `<img>` 不许把垫底写成字面深色（`#000` / `black` / `rgba(0,0,0,…)`）——
 *      它不随主题变化，亮色主题下就是一块黑色底。
 *
 * 为什么钉在 `object-contain` 上而不是所有 `<img>`：`object-cover` 的元素框被容器填满、
 * 内容也铺满整框，不存在"框角离内容角几百像素"这个前提。
 *
 * 显式豁免（2026-11-07 登记）：`ImageLightbox.vue` 的全屏灯箱**不**套这条 —— 用户 #17
 * 要求预览图本身 0 圆角（大图不裁边），且灯箱的 `object-contain` 元素框由图片比例决定、
 * 四角落在深色幕底上，不存在"圆角裁剪面脱开内容角"的白底暗角。扫描域保持
 * `FavoritePanel` / `MergeCardModal` / `MessageImageBubble` 三处，不要顺手扩到灯箱。
 */
const LITERAL_DARK_PAD_RE = /(?:bg-black|bg-\[(?:color:)?(?:#[0]{3}(?:[0]{3})?|black)\b|#[0]{3}(?:[0]{3})?(?![0-9a-f])|\brgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)])/i;

export function checkContainImageClip(detailSrc: string, name: string): GuardIssue[] {
  const out: GuardIssue[] = [];
  let contain = 0;
  for (const t of findImgTags(detailSrc)) {
    const line = lineAt(detailSrc, t.start);
    const hasContain = /\bobject-contain\b/.test(t.text);
    if (hasContain) {
      contain += 1;
      // 必须按 class **整词**判：`max-w-full` 里也含 "w-full"，用 \b 会把合规的判成违规。
      if (/(?:^|[\s"'])w-full(?![A-Za-z0-9_-])/.test(t.text)) {
        out.push({
          line,
          message: `${name}：\`object-contain\` 的 <img> 又带上了 \`w-full\` —— 元素框会被撑成整栏宽、圆角裁剪面离开内容角，源图自带的深色圆角会露出来。改用 \`mx-auto block max-w-full\` 让元素框贴住内容。`,
        });
      }
      if (!/rounded-\[var\(--gosslan-[a-z-]*radius/.test(t.text)) {
        out.push({
          line,
          message: `${name}：\`object-contain\` 的 <img> 缺 \`rounded-[var(--gosslan-…radius-…)]\` —— 圆角裁剪必须由这一处负责。`,
        });
      }
    }
    const pad = t.text.match(LITERAL_DARK_PAD_RE);
    if (pad) {
      out.push({
        line,
        message: `${name}：<img> 的垫底写死成字面深色 \`${pad[0]}\` —— 主题切换时它不跟着变，亮色主题下就是一块黑底。垫底只能来自 \`var(--gosslan-…)\` 或干脆不写（露容器的底色）。`,
      });
    }
  }
  // 反例自证：锚点被删或改名时这条判据不能空转静默通过。
  if (contain !== 1) {
    out.push({
      line: 0,
      message: `${name}：应恰好有 1 支 \`object-contain\` 的 <img>（实际 ${contain} 支）—— 判据锚点变了，请同步改锚点而不是让它空转。`,
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ㊷ 输入承载面必须有可见边框 ----------------

/**
 * 凡是用 `bg-[var(--gosslan-field)]` 作底的元素，**边框必须走 `--gosslan-field-border`**。
 *
 * 为什么（2026-11-06 用户报「暗色 + 玻璃 + 浮动背景全开时看不到输入框」）：
 * 旧输入框一律 `border-transparent`，边界完全靠填充与背景的差值 ——
 * 实测亮色 1.11 / 暗色 1.04，等于没有边界；特效一开（背后有薄纱与浮动色块）就更糟。
 * 判据把"边框必须存在且是 field-border 这一档"钉住，`border-transparent` 与
 * 更弱的 `--gosslan-border`（亮 1.28）都不许再回到输入面上。
 *
 * 只查同一行：`bg-[var(--gosslan-field)]` 与边框写在同一个 class 字符串里（本仓库的写法）。
 * `ring-1 ring-[var(--gosslan-field-border)]` 也算合法（圆角搜索框用 ring 更贴合）。
 */
export function findTransparentFieldBorder(model: string): GuardIssue[] {
  const cleaned = model.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(CLASS_ATTR_RE)) {
    const cls = m[1];
    if (!cls.includes("bg-[var(--gosslan-field)]")) continue;
    // `<button>` 用 field 底不算"输入承载面"（outline 弱按钮有自己的对比度契约：
    // primary/outline 控件 vs 面板 ≥3.0，且按钮的表面积形状与输入框不同类）。
    const head = cleaned.slice(0, m.index ?? 0);
    const tagStart = head.lastIndexOf("<");
    const tag = tagStart >= 0 ? /^<([a-zA-Z][\w-]*)/.exec(head.slice(tagStart))?.[1]?.toLowerCase() : undefined;
    if (tag === "button") continue;
    const hasVisibleEdge =
      cls.includes("border-[var(--gosslan-field-border)]") ||
      cls.includes("ring-[var(--gosslan-field-border)]");
    if (hasVisibleEdge) continue;
    const weak =
      cls.includes("border-transparent") || cls.includes("border-[var(--gosslan-border)]")
        ? "边框透明或只有 --gosslan-border（亮色 1.28）"
        : "根本没有边框/环";
    out.push({
      line: lineAt(cleaned, m.index ?? 0),
      message:
        `输入承载面（bg-[var(--gosslan-field)]）的${weak} —— 必须 ` +
        "`border-[var(--gosslan-field-border)]` 或 `ring-1 ring-[var(--gosslan-field-border)]`。" +
        "实测旧形态亮色 1.11 / 暗色 1.04，玻璃 + 浮动背景一开就看不见输入框（㊷ / tokenContrast 契约）。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- ㊶ 设置分区卡片内边距只走三档类 ----------------

/**
 * 设置分区里**卡片级**的内边距只许来自 `settings-card-row` / `settings-card-inset` /
 * `settings-group-caption`，数值只留在 `--gosslan-card-pad` 族（16 / 12 / 4）。
 *
 * 为什么（2026-11-06 用户报「关于那个卡片内边距比其它分区小」）：实测四分区卡片行
 * padding 其实**全是一组 12/16**（"关于更紧"是单行 48 vs 双行 64 的行高错觉），
 * 真正散掉的只有 4 处自己写的 `px-4 py-2.5` / `p-4` / `px-3 py-3`。散值只要还在，
 * 下一个分区就会照抄**最近的那个**，标准值迟早再散 —— 所以判据盯 token 而不是盯数字。
 *
 * 只认**卡片级**的档：四边 >=12（`p-3|4|5|6`）、纵向 >=12（`py-3|4|5|6`）、
 * 横向 >=16（`px-4|5|6`）。控件自己的 `px-3 py-1.5`（输入框内边距）、色板 `p-2`
 * 不属于卡片内边距，不受此限 —— 横向 12 正是控件的标准内距，禁掉它会误伤整片表单。
 * HTML 注释先抹成空格（保留行号），避免注释里的说明造成假红。
 */
const RAW_CARD_PADDING_TOKEN_RE = /^(!)?(p|px|py|pt|pr|pb|pl|ps|pe)-(\[[^\]]+\]|[0-9]+(?:\.[0-9]+)?)$/;

/**
 * 把 padding token 换算成 px，再按轴判档。为什么不只认具名档（2026-11-07 审查 M-2）：
 * 旧正则只认 `p-3..6`/`py-3..6`/`px-4..6`，于是 `p-[16px]`（任意值）与
 * `pt-4 pb-4`（单轴拆写）都能绕过 —— 判据看起来绿，实际没拦住任何东西。
 * 任意值里带 `var()`/`calc()` 的放行（那本来就是 token 消费的正确写法）。
 */
function isRawCardPadding(tok: string): boolean {
  const m = RAW_CARD_PADDING_TOKEN_RE.exec(tok);
  if (!m) return false;
  const axis = m[2];
  const raw = m[3];
  let px: number;
  if (raw.startsWith("[")) {
    const inner = raw.slice(1, -1).trim();
    const v = /^([0-9.]+)(px|rem|em)?$/.exec(inner);
    if (!v) return false;
    const n = Number(v[1]);
    px = v[2] === "rem" || v[2] === "em" ? n * 16 : n;
  } else {
    px = Number(raw) * 4;
  }
  return px >= (axis === "px" ? 16 : 12);
}

export function findRawCardPadding(src: string): GuardIssue[] {
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(CLASS_ATTR_RE)) {
    for (const tok of m[1].split(/\s+/).filter(Boolean)) {
      if (!isRawCardPadding(tok)) continue;
      out.push({
        line: lineAt(cleaned, m.index ?? 0),
        message:
          `设置分区又写了卡片级 padding「${tok}」—— 卡片行一律 \`settings-card-row\`（12 四边）、` +
          "卡片内嵌块 `settings-card-inset`（8 四边）、分组标题/脚注 `settings-group-caption`（左缩进 4）。" +
          "数值只在 `--gosslan-card-pad` 族里（2026-11-07 按 VS Code compact 收紧：16→12、12→8）。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- PH-01 占位符文字色只走 token，且顶层规则必须存在 ----------------

/**
 * 占位符（placeholder）**只有两种合规形态**：
 *   1. 组件里写 `placeholder:text-[var(--gosslan-placeholder)]`；
 *   2. 什么都不写，由 `src/style.css` 的顶层 `input::placeholder, textarea::placeholder`
 *      规则统一接管（`color: var(--gosslan-placeholder); opacity: 1`）。
 *
 * 为什么（2026-11-06 实测，用户报「特效全开信息可读性下降」的同一族）：
 * 全仓曾**没有**顶层 `::placeholder` 规则，只有 12 处散落的 token 类；
 * 其余输入框落到浏览器 UA 的 `#9ca3af` —— 在亮色字段底 `#edeff3` 上只有 **2.21:1**，
 * 正文 AA（4.5）的一半都不到。群管理的「群名称 / 群公告」两处正是漏网者。
 * 这条判据同时钉住"写法"与"兜底规则存在"：只钉前者，新增输入框仍会落回 UA 灰；
 * 只钉后者，散落的 `placeholder:text-[#9ca3af]` 仍能局部绕过。
 */
const PLACEHOLDER_TOKEN_CLASS = "placeholder:text-[var(--gosslan-placeholder)]";

export function findRawPlaceholderColor(src: string): GuardIssue[] {
  const cleaned = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  for (const m of cleaned.matchAll(CLASS_ATTR_RE)) {
    for (const tok of m[1].split(/\s+/).filter(Boolean)) {
      if (!tok.startsWith("placeholder:text-")) continue;
      if (tok === PLACEHOLDER_TOKEN_CLASS) continue;
      out.push({
        line: lineAt(cleaned, m.index ?? 0),
        message:
          `占位符颜色又写成了「${tok}」—— 一律 \`${PLACEHOLDER_TOKEN_CLASS}\`，` +
          "不写则吃 style.css 顶层 `::placeholder` 规则。亮色字段底 #edeff3 上 UA 灰 #9ca3af 只有 2.21:1（PH-01）。",
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export function findMissingPlaceholderRule(css: string): GuardIssue[] {
  // 注释里可能出现花括号/伪类字样：整段抹成等长空白，保留下标与行号
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: GuardIssue[] = [];
  const RULE_RE = /([^{}]*::placeholder[^{}]*)\{([^{}]*)\}/g;
  let global = 0;
  for (const m of body.matchAll(RULE_RE)) {
    const selector = m[1].trim();
    const decls = m[2];
    const pos = m.index ?? 0;
    const depth = (body.slice(0, pos).match(/\{/g)?.length ?? 0) - (body.slice(0, pos).match(/\}/g)?.length ?? 0);
    const coversBoth = /\binput\b/.test(selector) && /\btextarea\b/.test(selector);
    const hasColor = /color\s*:\s*var\(--gosslan-placeholder\)/.test(decls);
    const hasOpacity = /opacity\s*:\s*1\s*(?:;|$)/.test(decls.replace(/\s+/g, " "));
    if (!coversBoth || !hasColor || !hasOpacity) {
      out.push({
        line: lineAt(body, pos),
        message:
          "`::placeholder` 规则不完整 —— 必须是 `input::placeholder, textarea::placeholder` " +
          "同时 `color: var(--gosslan-placeholder)` 与 `opacity: 1`（PH-01）。" +
          (coversBoth ? "" : " 现在少覆盖 input 或 textarea，漏掉的那类输入框会落回 UA 灰。") +
          (hasColor ? "" : " 颜色没有吃 token。") +
          (hasOpacity ? "" : " 缺 opacity: 1 —— Firefox 默认 0.54 会把 token 对比度再打薄一半。"),
      });
      continue;
    }
    if (depth !== 0) {
      out.push({
        line: lineAt(body, pos),
        message: `\`::placeholder\` 规则嵌在第 ${depth} 层（@media/嵌套里）—— 只在部分条件下生效，等于没有全局兜底（PH-01）。`,
      });
      continue;
    }
    global++;
  }
  if (global === 0 && out.length === 0) {
    out.push({
      line: 0,
      message:
        "style.css 里找不到顶层 `input::placeholder, textarea::placeholder` 规则 —— " +
        "没有兜底时，所有未显式写 token 类的输入框都会落回 UA 的 #9ca3af（亮色字段底 2.21:1，PH-01）。",
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------- CN：同心几何（品牌底盘内标记 / 窗口右上角头像） ----------------

/**
 * 同心圆角的唯一判据：**内圆角 = 外圆角 − 内外间距**（下限 0）。
 *
 * 1) 品牌底盘（68px orb，外圆角 `--gosslan-radius-xl` = 20）里塞的是 `app-mark.png` ——
 *    位图自带**方形**蓝底。不削角就会在圆角底盘的四角露出直角（2026-11-07 用户反馈：
 *    「中心图标直方形与圆角矩形不协调」）。内圆角必须由「外圆角 − 每边内距」算出来，
 *    不许手写死值（下面 `outer` / `inset` 现读现算，token 也是 calc）：
 *       · 44px 标记：68−44 每边 12 ⇒ 20−12 = 8
 *       · 56px 标记：68−56 每边 6  ⇒ 20−6  = 14
 *
 * 2) 主窗右上角：头像是 28px 圆、标题栏 40px ⇒ 上下内距各 6。右侧簇若仍留 12，
 *    右上角就是「左宽右窄」（用户原话）。等内距 + macOS 26 的 20px 窗口圆角
 *    正好满足 20−6 = 14 = 头像半径（严格同心）；Windows 11（8px）退化为等内距 fallback。
 *
 * 反例自证：删掉标记上的 `rounded-[var(--gosslan-orb-mark-*)]`、把 `pr-1.5` 改回 `pr-3`、
 * 或把内距算错的 calc 写进 style.css —— 都必须红。
 */
export function checkConcentricGeometry(src: {
  styleCss: string;
  titleBar: string;
  layout: string;
  conversationList: string;
}): GuardIssue[] {
  const out: GuardIssue[] = [];
  const ORB_SIZE = 68;
  const outer = Number(src.styleCss.match(/--gosslan-radius-xl\s*:\s*(\d+)px/)?.[1] ?? 0);
  if (!outer) {
    out.push({ line: 0, message: "CN-01：style.css 里读不到 `--gosslan-radius-xl` —— 同心圆角没有基准。" });
  }

  const sites = [
    { file: "ResponsiveLayout.vue", src: src.layout, size: 44, token: "--gosslan-radius-orb-mark-44" },
    { file: "ConversationList.vue", src: src.conversationList, size: 56, token: "--gosslan-radius-orb-mark-56" },
  ];
  for (const site of sites) {
    const inset = (ORB_SIZE - site.size) / 2;
    const expected = Math.max(outer - inset, 0);

    const imgTag = [...site.src.matchAll(/<img[^>]*>/g)]
      .map((m) => m[0])
      .find((t) => t.includes("appMark"));
    if (!imgTag) {
      out.push({ line: 0, message: `CN-01：${site.file} 里找不到 \`appMark\` 标记位图 —— 同心圆角契约已漂。` });
    } else if (!imgTag.includes(`rounded-[var(${site.token})]`)) {
      out.push({
        line: lineAt(site.src, site.src.indexOf(imgTag)),
        message:
          `CN-01：${site.file} 的 ${site.size}px 标记位图没有同心圆角（应为 \`rounded-[var(${site.token})]\`）` +
          ` —— 方形蓝底会在 ${ORB_SIZE}px 圆角底盘里露出直角（应为 ${expected}px）。`,
      });
    }

    const calc = new RegExp(
      `${site.token}\\s*:\\s*calc\\(\\s*var\\(--gosslan-radius-xl\\)\\s*-\\s*${inset}px\\s*\\)`,
    );
    if (!calc.test(src.styleCss)) {
      out.push({
        line: 0,
        message:
          `CN-01：\`${site.token}\` 必须是 \`calc(var(--gosslan-radius-xl) - ${inset}px)\`` +
          `（${ORB_SIZE}−${site.size} 每边 ${inset}px ⇒ 内圆角 ${expected}px）—— 手写死值会随外圆角漂。`,
      });
    }
  }

  // 2) 标题栏头像：边缘内距必须等于纵向内距（(标题栏高 − 头像边长)/2），两平台同源。
  //    ⚠️ 2026-11-07 起内距/头像尺寸抽成 `--gosslan-caption-inset` / `--gosslan-caption-avatar`，
  //    判据跟着搬：只认 token 引用，不再认 `pr-1.5` 这类手写数字（数字会随标题栏高度漂）。
  const titleH = Number(src.styleCss.match(/--gosslan-title-h\s*:\s*(\d+)px/)?.[1] ?? 0);
  const avatarPx = Number(src.styleCss.match(/--gosslan-caption-avatar\s*:\s*(\d+)px/)?.[1] ?? 0);
  const rightSlot = src.titleBar.match(/<div[^>]*\bv-if="\$slots\.right"[^>]*>/)?.[0] ?? "";
  if (!rightSlot) {
    out.push({ line: 0, message: 'CN-02：TitleBar 里找不到 `v-if="$slots.right"` 的头像簇 —— 无法确认角部内距。' });
  }
  const avatarTag = [...src.layout.matchAll(/<SelfAvatar[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes("--gosslan-caption-avatar") || t.includes("h-7"));
  if (!avatarTag) {
    out.push({ line: 0, message: "CN-02：主窗头像簇里找不到读 `--gosslan-caption-avatar` 的本人头像 —— 同心几何的基准已漂。" });
  }
  const insetExpr = src.styleCss.match(/--gosslan-caption-inset\s*:\s*([^;]+);/)?.[1] ?? "";
  if (!/calc\(\s*\(\s*var\(--gosslan-title-h\)\s*-\s*var\(--gosslan-caption-avatar\)\s*\)\s*\/\s*2\s*\)/.test(insetExpr)) {
    out.push({
      line: 0,
      message:
        "CN-02：`--gosslan-caption-inset` 必须是 `calc((var(--gosslan-title-h) - var(--gosslan-caption-avatar)) / 2)`" +
        ` —— 当前是 \`${insetExpr || "（缺失）"}\`（${titleH || "?"}px 标题栏 / ${avatarPx || "?"}px 头像 ⇒ 应为 ${(titleH - avatarPx) / 2}px）。`,
    });
  }
  const slotCls = rightSlot.match(/:class="([^"]*)"/)?.[1] ?? "";
  const slotPrToken = /\bpr-\[var\(--gosslan-caption-inset\)\]/.test(slotCls);
  const slotPlToken = /\bpl-\[var\(--gosslan-caption-inset\)\]/.test(slotCls);
  if (!slotPrToken || !slotPlToken) {
    out.push({
      line: lineAt(src.titleBar, src.titleBar.indexOf(rightSlot)),
      message:
        "CN-02：头像簇的两个平台分支都必须读 `--gosslan-caption-inset`" +
        "（`pr-[var(--gosslan-caption-inset)]` / `pl-[var(--gosslan-caption-inset)]`）—— " +
        "角部内距与头像纵向内距必须同源，否则右上/左上角会一边宽一边窄。",
    });
  }
  if (!titleH && !out.some((i) => i.message.startsWith("CN-02"))) {
    out.push({ line: 0, message: "CN-02：style.css 的 `--gosslan-title-h` 读不到 —— 头像同心几何的基准丢了。" });
  }
  return out;
}

// ---------------- SA 屏幕边缘安全区：四条边一个口径（2026-11-07） ----------------
/**
 * 用户 2026-11-07（安卓真机）：「看看通知是不是都在安全区域内，别压到通知栏和底部，
 * 就像 iOS 的安全区域一样，不要太靠四个圆角的弧度内。」
 *
 * 统一入口是 `style.css` 里的四枚变量（`--gosslan-inset-top/-bottom/-left/-right`）+
 * `--gosslan-corner-safe`；组件只许读变量，不许各自再写 `env(safe-area-inset-*)`
 * （`boot/skeleton.css` 是首屏骨架，App 还没写 `html.is-mobile`，单独豁免）。
 * 桌面环境 `env()`=0 且回落=0 ⇒ 改动对 macOS/Windows 是零位移。
 */
export const EDGE_STATUS_BAR_PX = 24;
export const EDGE_NAV_BAR_PX = 24;
export const EDGE_CORNER_RADIUS_PX = 24;

export type EdgeRect = { top: number; right: number; bottom: number; left: number };

/** 安全区统一算法：环境读数与回落取 `max`，绝不把两者相加。 */
export function safeInsetPx(envPx: number, fallbackPx: number): number {
  return Math.max(envPx, fallbackPx);
}

/**
 * 矩形是否侵入状态栏、导航条、或四个屏幕圆角的「被切掉」区域。
 *
 * 圆角判定按**弧度**算，不是"离边小于 r 就算"：以左上角为例，被切掉的是
 * `x<r && y<r` 且在圆外的部分；矩形只要没伸进那块区域，就仍在可视面内。
 * 返回空数组 = 四条边界都合规。
 */
export function findEdgeIntrusions(
  rect: EdgeRect,
  opts: {
    width: number;
    height: number;
    statusBarPx?: number;
    navBarPx?: number;
    cornerPx?: number;
  },
): string[] {
  const statusBarPx = opts.statusBarPx ?? EDGE_STATUS_BAR_PX;
  const navBarPx = opts.navBarPx ?? EDGE_NAV_BAR_PX;
  const r = opts.cornerPx ?? EDGE_CORNER_RADIUS_PX;
  const issues: string[] = [];

  if (rect.top < statusBarPx) {
    issues.push(`顶边 ${rect.top}px < 状态栏 ${statusBarPx}px`);
  }
  if (rect.bottom > opts.height - navBarPx) {
    issues.push(`底边 ${rect.bottom}px > 导航条上缘 ${opts.height - navBarPx}px`);
  }

  const corners: Array<{
    name: string;
    cx: number;
    cy: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    farX: number;
    farY: number;
  }> = [
    { name: "左上", cx: r, cy: r, x0: 0, x1: r, y0: 0, y1: r, farX: 0, farY: 0 },
    { name: "右上", cx: opts.width - r, cy: r, x0: opts.width - r, x1: opts.width, y0: 0, y1: r, farX: 1, farY: 0 },
    { name: "左下", cx: r, cy: opts.height - r, x0: 0, x1: r, y0: opts.height - r, y1: opts.height, farX: 0, farY: 1 },
    {
      name: "右下",
      cx: opts.width - r,
      cy: opts.height - r,
      x0: opts.width - r,
      x1: opts.width,
      y0: opts.height - r,
      y1: opts.height,
      farX: 1,
      farY: 1,
    },
  ];

  for (const c of corners) {
    const x0 = Math.max(rect.left, c.x0);
    const x1 = Math.min(rect.right, c.x1);
    const y0 = Math.max(rect.top, c.y0);
    const y1 = Math.min(rect.bottom, c.y1);
    if (x0 >= x1 || y0 >= y1) continue;
    // 重叠区里离圆心最远的角，就是最有可能落进「圆外被切掉」区域的那一点。
    const farX = c.farX === 0 ? x0 : x1;
    const farY = c.farY === 0 ? y0 : y1;
    const d = Math.hypot(farX - c.cx, farY - c.cy);
    if (d > r) {
      issues.push(`${c.name}圆角区：矩形最近点 (${farX},${farY}) 距圆心 ${d.toFixed(1)}px > 半径 ${r}px`);
    }
  }
  return issues;
}

/**
 * 统一出口守卫：除 `style.css`（变量定义处）与首屏骨架外，任何文件都不许再裸写
 * `env(safe-area-inset-*)` —— 各写一份就会漂移，而且桌面回落值无法集中调。
 */
export function findRawSafeAreaEnvIssues(files: Array<{ path: string; src: string }>): GuardIssue[] {
  const issues: GuardIssue[] = [];
  for (const file of files) {
    if (/(^|\/)style\.css$/.test(file.path)) continue;
    if (/(^|\/)boot\/skeleton\.css$/.test(file.path)) continue;
    const code = stripComments(
      file.src
        .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/^\s*\/\/.*$/gm, (c) => c.replace(/[^\n]/g, " ")),
    );
    for (const m of code.matchAll(/env\(\s*safe-area-inset-(?:top|bottom|left|right)/g)) {
      issues.push({
        line: lineAt(code, m.index ?? 0),
        message:
          `裸写 \`env(safe-area-inset-*)\`（${file.path}）—— 边缘安全区只能从统一出口读：` +
          "`var(--gosslan-inset-top/-bottom/-left/-right)`；圆角内缩读 `var(--gosslan-corner-safe)`。",
      });
    }
  }
  return issues;
}

// ---------------- TB 标题栏镜像：按钮在哪一侧，头像簇就去另一侧（2026-11-07） ----------------
/**
 * 用户 2026-11-07（Windows 真机截图）：「三大金刚键是在右边，那头像应该是相对称的、
 * 在左边居左然后对称显示」。
 *
 * 镜像的是**按钮所在侧**，不是整条标题栏左右翻转：
 *   · macOS：系统红绿灯在左 ⇒ 头像簇靠右（`ml-auto`），右侧内距 = 头像纵向内距；
 *   · Windows/Linux：三键在右 ⇒ 头像簇靠左，左侧内距 = 同一个值。
 *
 * 两条硬约束：
 * 1. 两侧内距必须相等，且都等于 `(标题栏高 − 头像边长)/2` —— 头像 28px 落在 40px 条里
 *    上下各 6，水平再留别的值就会在窗口角上一边宽一边窄，也破坏与窗外圆角的同心关系
 *    （macOS 20px 圆角 ⇒ 内圆 20−6=14=头像半径）。
 * 2. 标题必须**绝对居中**（脱离流式布局），不能靠左右两侧内容宽度凑出来 —— 否则
 *    Windows 上左侧头像簇比 macOS 的 78px 红绿灯占位窄，标题会肉眼可见地偏左。
 */
export function checkTitlebarMirror(src: {
  titleBar: string;
  layout: string;
  styleCss: string;
}): GuardIssue[] {
  const out: GuardIssue[] = [];
  const { titleBar, layout, styleCss } = src;

  // 1) 头像簇：平台 → 侧别
  const slotTag = titleBar.match(/<div[^>]*\bv-if="\$slots\.right"[^>]*>/)?.[0] ?? "";
  if (!slotTag) {
    return [{ line: 0, message: "TB-01：TitleBar 里找不到 `v-if=\"$slots.right\"` 的头像簇 —— 无法判定它落在哪一侧。" }];
  }
  const classExpr = slotTag.match(/:class="([^"]*)"/)?.[1] ?? "";
  const ternary = classExpr.match(/isMac\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/);
  if (!ternary) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message:
        "TB-01：头像簇必须用 `:class=\"isMac ? '…' : '…'\"` 显式表达镜像（macOS 靠右、Windows 靠左），" +
        `当前是 \`${classExpr || "（无 :class）"}\` —— 平台分叉写死在一侧就必然有一端撞系统按钮。`,
    });
    return out;
  }
  const macCls = ternary[1];
  const winCls = ternary[2];

  if (!/\bml-auto\b/.test(macCls)) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message: "TB-01：macOS 分支的头像簇缺 `ml-auto` —— 红绿灯在左，它必须被推到右侧。",
    });
  }
  if (/\bml-auto\b/.test(winCls)) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message:
        "TB-01：Windows 分支仍用 `ml-auto` 把头像簇推到右侧 —— 用户 2026-11-07 报的就是它压着三大金刚键；" +
        "Windows 上按钮在右，头像簇必须在左（无 `ml-auto`）。",
    });
  }
  if (!/\bflex-row-reverse\b/.test(winCls)) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message:
        "TB-01：Windows 分支缺 `flex-row-reverse` —— 组内顺序必须镜像成「头像 → 设置 → 搜索 → LAN」，" +
        "否则头像会落在簇的最右边，又贴回系统三键。",
    });
  }
  if (/\bflex-row-reverse\b/.test(macCls)) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message: "TB-01：macOS 分支不许 `flex-row-reverse` —— 头像在红绿灯对侧的最右端才是原设计。",
    });
  }
  const macPr = macCls.match(/\bpr-(\d+(?:\.\d+)?)/)?.[1];
  const winPl = winCls.match(/\bpl-(\d+(?:\.\d+)?)/)?.[1];
  const macToken = /\bpr-\[var\(--gosslan-caption-inset\)\]/.test(macCls);
  const winToken = /\bpl-\[var\(--gosslan-caption-inset\)\]/.test(winCls);
  if (!macPr && !macToken) {
    out.push({ line: lineAt(titleBar, titleBar.indexOf(slotTag)), message: "TB-01：macOS 分支缺右侧内距（`pr-[var(--gosslan-caption-inset)]`）。" });
  }
  if (!winPl && !winToken) {
    out.push({ line: lineAt(titleBar, titleBar.indexOf(slotTag)), message: "TB-01：Windows 分支缺左侧内距（`pl-[var(--gosslan-caption-inset)]`）。" });
  }

  // 2) 系统按钮仍在右侧，且只在非 macOS 渲染
  const sysTag = titleBar.match(/<div[^>]*\bv-if="!isMac"[^>]*>/)?.[0] ?? "";
  if (!sysTag) {
    out.push({ line: 0, message: "TB-01：找不到 `v-if=\"!isMac\"` 的系统按钮组 —— 三键该固定在右侧。" });
  } else if (!/\bml-auto\b/.test(sysTag)) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(sysTag)),
      message: "TB-01：系统三键组缺 `ml-auto` —— 头像簇改到左侧后，它不会被推到最右缘。",
    });
  }

  // 3) macOS 红绿灯占位仍在左侧（顺序即位置：它必须排在任何右侧簇之前）
  const macSpacerAt = titleBar.search(/<div[^>]*\bv-if="isMac"[^>]*\bw-\[\d+px\][^>]*>/);
  if (macSpacerAt < 0) {
    out.push({ line: 0, message: "TB-01：找不到 macOS 红绿灯占位块 —— 系统按钮会盖住标题左侧。" });
  } else {
    const spacerTag = titleBar.match(/<div[^>]*\bv-if="isMac"[^>]*\bw-\[\d+px\][^>]*>/)?.[0] ?? "";
    if (!/w-\[78px\]/.test(spacerTag)) {
      out.push({
        line: lineAt(titleBar, macSpacerAt),
        message: "TB-01：macOS 红绿灯占位宽度变了（应保持 78px）—— 与原生三键的实际占位不符。",
      });
    }
    if (macSpacerAt > titleBar.indexOf(slotTag)) {
      out.push({ line: lineAt(titleBar, macSpacerAt), message: "TB-01：红绿灯占位必须排在头像簇之前（它在屏幕左侧）。" });
    }
  }

  // 4) 标题绝对居中，不依赖两侧内容宽度
  const titleCentered =
    /class="[^"]*\babsolute inset-0\b[^"]*\bjustify-center\b/.test(titleBar) ||
    (/left-1\/2/.test(titleBar) && /-translate-x-1\/2/.test(titleBar));
  if (!titleCentered) {
    out.push({
      line: 0,
      message:
        "TB-01：标题必须绝对居中（`absolute inset-0 … justify-center` 或 `left-1/2 -translate-x-1/2`）—— " +
        "靠左右内容宽度凑出来的居中，在 Windows（左头像簇）与 macOS（左 78px 红绿灯）之间必然偏移。",
    });
  }

  // 5) 两侧内距同源、相等，且等于头像纵向内距 —— 数值只许从 style.css 的两个 token 来
  const titleH = Number(styleCss.match(/--gosslan-title-h\s*:\s*(\d+)px/)?.[1] ?? 0);
  const avatarPx = Number(styleCss.match(/--gosslan-caption-avatar\s*:\s*(\d+)px/)?.[1] ?? 0);
  const insetExpr = styleCss.match(/--gosslan-caption-inset\s*:\s*([^;]+);/)?.[1] ?? "";
  const avatarTag = [...layout.matchAll(/<SelfAvatar[^>]*>/g)]
    .map((m) => m[0])
    .find((t) => t.includes("--gosslan-caption-avatar") || t.includes("h-7"));
  if (!titleH) {
    out.push({ line: 0, message: "TB-01：style.css 里读不到 `--gosslan-title-h` —— 无法核对内距。" });
  }
  if (!avatarPx) {
    out.push({ line: 0, message: "TB-01：style.css 里读不到 `--gosslan-caption-avatar` —— 头像尺寸没有同源 token。" });
  }
  if (!/calc\(\s*\(\s*var\(--gosslan-title-h\)\s*-\s*var\(--gosslan-caption-avatar\)\s*\)\s*\/\s*2\s*\)/.test(insetExpr)) {
    out.push({
      line: 0,
      message:
        "TB-01：`--gosslan-caption-inset` 必须是 `calc((var(--gosslan-title-h) - var(--gosslan-caption-avatar)) / 2)`" +
        ` —— 当前是 \`${insetExpr || "（缺失）"}\`；手写死值会在改标题栏高度或头像尺寸时静默不同心。`,
    });
  }
  if (!macToken || !winToken) {
    out.push({
      line: lineAt(titleBar, titleBar.indexOf(slotTag)),
      message:
        "TB-01：两平台分支必须直接读 `--gosslan-caption-inset`（`pr-[var(--gosslan-caption-inset)]` / " +
        "`pl-[var(--gosslan-caption-inset)]`）—— 镜像只切方向，不切数字。",
    });
  }
  if (!avatarTag) {
    out.push({ line: 0, message: "TB-01：主窗头像簇里找不到读 `--gosslan-caption-avatar` 的本人头像 —— 内距基准已漂。" });
  }
  if (titleH && avatarPx) {
    const expect = (titleH - avatarPx) / 2;
    const macPx = macToken ? expect : macPr ? Number(macPr) * 4 : null;
    const winPx = winToken ? expect : winPl ? Number(winPl) * 4 : null;
    if (macPx !== null && winPx !== null && macPx !== winPx) {
      out.push({
        line: lineAt(titleBar, titleBar.indexOf(slotTag)),
        message: `TB-01：两平台内距不等（macOS ${macPx}px vs Windows ${winPx}px）—— 镜像后必须等距，否则换端就换观感。`,
      });
    }
    for (const [side, px] of [
      ["macOS", macPx],
      ["Windows", winPx],
    ] as const) {
      if (px !== null && px !== expect) {
        out.push({
          line: lineAt(titleBar, titleBar.indexOf(slotTag)),
          message:
            `TB-01：${side} 内距 ${px}px ≠ 头像纵向内距 ${expect}px（${titleH}px 标题栏里的 ${avatarPx}px 圆，` +
            "距上 = 距左/右才同心）—— 窗口角上会一边宽一边窄。",
        });
      }
    }
  }

  return out;
}

/**
 * 标题栏头像的**平台模拟矩形**（TB-02 的运行时读数口径，2026-11-07）。
 *
 * ⚠️ 这不是真机读数：本机是 macOS，拿不到 Windows WebView2 的渲染。它把
 * `TitleBar.vue` 的布局约束（靠哪一侧、内距多少、条高多少、头像多大）折成矩形，
 * 让"距上 = 距左（Windows）/ 距右（macOS）"这条同心口径在两种平台下都能被断言。
 * 真机仍需 Windows/macOS 各截一张 4× 角部特写核对（见交付说明）。
 */
export function captionAvatarRect(o: {
  platform: "macos" | "windows";
  viewportWidth: number;
  titleH: number;
  avatarPx: number;
  insetPx: number;
}): { x: number; y: number; width: number; height: number; topGap: number; sideGap: number } {
  const y = (o.titleH - o.avatarPx) / 2;
  const x = o.platform === "macos" ? o.viewportWidth - o.insetPx - o.avatarPx : o.insetPx;
  const sideGap = o.platform === "macos" ? o.viewportWidth - (x + o.avatarPx) : x;
  return { x, y, width: o.avatarPx, height: o.avatarPx, topGap: y, sideGap };
}

// ---------------- ED. 输入框「一个表情 = 一个字」的删除契约 ----------------

export interface ComposerUnitDeleteSources {
  /** `src/components/chat/MessageComposer.vue` 源码 */
  composer: string;
  /** `src/utils/graphemes.ts` 源码 */
  graphemes: string;
}

/**
 * 一次退格只能删「用户眼里的一个单位」（用户 2026-11-07 安卓真机反馈）。
 *
 * 为什么要源码级判据而不是只写纯函数测试：真正被用户按到的路径是 `onKeydown` 里
 * 那条 `Backspace` 分支 —— 只要它漏回默认行为，字素簇函数写得再对也没人调用
 * （旧实现 `deleteMentionBeforeCaret` 就只覆盖了「offset=1 且前一个字符是 NBSP」
 * 一种 caret 形状，其余全交给 WebView 成批删除）。所以这里同时钉三件事：
 *   1. 两条删除键都走统一入口；
 *   2. 原生 emoji 必须按字素簇（`Intl.Segmenter`）切，不许按 UTF-16 单位切；
 *   3. `normalizeEmpty` 不许把「只剩 token」的草稿当空壳清掉。
 *
 * 反例自证见 `designGuards.test.ts` 的 ED-02。
 */
export function checkComposerUnitDelete(o: ComposerUnitDeleteSources): GuardIssue[] {
  const out: GuardIssue[] = [];
  // 注释要抹成空格再扫（保留换行 ⇒ 行号不变）：注释里提到旧函数名/旧写法，
  // 不应该让判据误判成"旧实现还在"或"新实现还在"（两种空转都出现过）。
  const src = o.composer.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  const backspaceAt = src.indexOf('e.key === "Backspace"');
  if (backspaceAt < 0) {
    out.push({ line: 0, message: "ED-01：输入框找不到 Backspace 分支 —— 删除契约已失效。" });
  } else if (!/deleteOneUnitBeforeCaret\s*\(\s*\)/.test(src.slice(backspaceAt, backspaceAt + 400))) {
    out.push({
      line: lineAt(src, backspaceAt),
      message:
        "ED-01：Backspace 必须走 `deleteOneUnitBeforeCaret()`（token 一次一个 + 原生 emoji 按字素簇）。" +
        "直接放给浏览器时，相邻 `contentEditable=false` span 会被 WebView 一次删掉多个。",
    });
  }

  const deleteAt = src.indexOf('e.key === "Delete"');
  if (deleteAt < 0) {
    out.push({ line: 0, message: "ED-01：输入框找不到 Delete 分支 —— 前向删与退格必须是同一口径。" });
  } else if (!/deleteOneUnitAfterCaret\s*\(\s*\)/.test(src.slice(deleteAt, deleteAt + 400))) {
    out.push({
      line: lineAt(src, deleteAt),
      message: "ED-01：Delete 必须走 `deleteOneUnitAfterCaret()`，否则前向删仍会成批吃表情。",
    });
  }

  // 旧实现只认一种 caret 形状，且只删 NBSP + token；留着重开会让修复被悄悄回退。
  if (/\bdeleteMentionBeforeCaret\b/.test(src)) {
    out.push({
      line: lineAt(src, src.indexOf("deleteMentionBeforeCaret")),
      message:
        "ED-01：`deleteMentionBeforeCaret` 已被 `deleteOneUnitBeforeCaret` 取代 —— " +
        "它只覆盖 offset=1 且前一个字符是 NBSP 这一种落位，其余形状会漏回 WebView。",
    });
  }

  // 按 UTF-16 单位删 = 用户报的那个 bug 本身。
  const utf16 = /deleteData\s*\(\s*(?:offset\s*-\s*1|start\s*-\s*1|[\w.]+\s*-\s*1)\s*,\s*1\s*\)/.exec(src);
  if (utf16) {
    out.push({
      line: lineAt(src, utf16.index),
      message:
        "ED-01：`deleteData(x - 1, 1)` 是按 UTF-16 单位删 —— 代理对/ZWJ/肤色会被切一半。" +
        "必须用 `graphemeStartBefore` / `graphemeEndAfter` 的字素边界。",
    });
  }
  if (/slice\s*\(\s*0\s*,\s*offset\s*-\s*1\s*\)/.test(src)) {
    out.push({
      line: lineAt(src, src.indexOf("slice(0, offset - 1)")),
      message: "ED-01：`slice(0, offset - 1)` 是按 UTF-16 单位删 —— 与用户反馈的现象完全一致。",
    });
  }

  // 只剩 token 的草稿不是空草稿：表情是 <img>，textContent 为空。
  const normAt = src.indexOf("function normalizeEmpty");
  if (normAt < 0) {
    out.push({ line: 0, message: "ED-01：找不到 `normalizeEmpty` —— 空壳规范化契约已漂。" });
  } else {
    const body = src.slice(normAt, normAt + 700);
    if (!/querySelector\(\s*["'][^"']*(?:emoji|mention)-token[^"']*["']\s*\)/.test(body)) {
      out.push({
        line: lineAt(src, normAt),
        message:
          "ED-01：`normalizeEmpty` 必须排除 `.emoji-token` / `.mention-token` —— " +
          "表情 token 里是 `<img>`，textContent 为空，只按文本判断会把「只剩表情」整个清空。",
      });
    }
  }

  // 字素边界必须真的用它，而不是自己数 code unit。
  if (!/Intl[\s\S]{0,120}Segmenter/.test(o.graphemes)) {
    out.push({
      line: 0,
      message: "ED-01：`utils/graphemes.ts` 必须用 `Intl.Segmenter`（grapheme）求字素边界。",
    });
  }
  if (!/granularity\s*:\s*["']grapheme["']/.test(o.graphemes)) {
    out.push({ line: 0, message: "ED-01：`Intl.Segmenter` 必须显式声明 `granularity: \"grapheme\"`。" });
  }
  if (!/export function graphemeStartBefore/.test(o.graphemes) || !/export function needsGraphemeDelete/.test(o.graphemes)) {
    out.push({ line: 0, message: "ED-01：`graphemes.ts` 的 `graphemeStartBefore` / `needsGraphemeDelete` 必须存在。" });
  }

  return out;
}

/**
 * 群任务「新建 / 编辑」草稿弹窗的尺寸判据（用户 2026-11-09：「这个框框太窄了」）。
 *
 * 用户要的是「描述能舒适写长文」+「整页只有一层滚动」，不是某一处截图好看：
 *   - 弹窗宽度按内容放宽（`max-w-2xl`），新增/编辑共用同一个 BaseModal，窄窗由 `w-full` 回退；
 *   - 描述框有最小高度、不许死高度、不许内部再滚一层（`resize-none` + `overflow-y-hidden`）；
 *   - 自动长高必须真的接在 `scrollHeight` 上。
 * 反例自证：宽度改回 `max-w-lg`、给描述框加 `h-24`，都必须红（见 designGuards.test.ts）。
 */
export function checkTodoDraftForm(src: string): Array<{ line: number; message: string }> {
  const out: Array<{ line: number; message: string }> = [];
  const modal = /<BaseModal\b[^>]*\bwidth="([^"]+)"/.exec(src);
  if (!modal) {
    out.push({
      line: 0,
      message: "TD-01：找不到带 `width` 的群任务草稿 BaseModal —— 尺寸规则的落点漂了。",
    });
  } else if (modal[1] !== "max-w-2xl") {
    out.push({
      line: lineAt(src, modal.index),
      message:
        `TD-01：群任务草稿弹窗宽度必须是 \`max-w-2xl\`（当前 \`${modal[1]}\`）。` +
        "旧 `max-w-lg` = 512px，长文描述只剩 480px 宽；改窄会让这条判据红。",
    });
  }

  const ta = src.indexOf("<textarea");
  if (ta < 0) {
    out.push({ line: 0, message: "TD-02：找不到描述 textarea —— 判据落点漂了。" });
  } else {
    const block = src.slice(ta, src.indexOf("</textarea>", ta));
    const clsM = /\bclass="([^"]*)"/.exec(block);
    if (!clsM) {
      out.push({ line: lineAt(src, ta), message: "TD-02：描述 textarea 没有 class —— 尺寸规则无处生效。" });
    } else {
      const cls = clsM[1].split(/\s+/);
      const line = lineAt(src, ta);
      if (!cls.includes("resize-none")) {
        out.push({ line, message: "TD-02：描述框必须 `resize-none` —— 手动拖小会重新变成内部小滚动条。" });
      }
      if (!cls.includes("overflow-y-hidden")) {
        out.push({ line, message: "TD-02：描述框必须 `overflow-y-hidden` —— 长文只能在弹窗内容区滚，不许框里再滚一层。" });
      }
      if (!cls.some((c) => c.startsWith("min-h-"))) {
        out.push({ line, message: "TD-02：描述框必须给最小高度（`min-h-[8.5rem]`）—— 否则又是一条 3 行高的小格子。" });
      }
      const dead = cls.find((c) => c.startsWith("h-") || c.startsWith("max-h-") || c === "overflow-y-auto");
      if (dead) {
        out.push({
          line,
          message: `TD-02：描述框不许死高度/内部滚动（命中 \`${dead}\`）—— 长文会被钉在一个固定高度里。`,
        });
      }
    }
    if (!/@input="fitDraftDesc"/.test(block)) {
      out.push({ line: lineAt(src, ta), message: "TD-02：描述框必须把 `@input` 接到 `fitDraftDesc` —— 否则长高只在打开那一下发生。" });
    }
  }
  if (!/scrollHeight/.test(src)) {
    out.push({ line: 0, message: "TD-02：找不到 `scrollHeight` —— 描述框没有按内容长高的实现。" });
  }
  return out;
}

