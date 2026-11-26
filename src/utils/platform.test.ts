import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { escapeRe } from "./escapeRe.ts";
import {
  canHoverByMedia,
  isAndroidUA,
  isMacUA,
  isWindowsUA,
  prefersReducedMotionByMedia,
  resolveMobileLayout,
} from "./platform.ts";

const SRC_DIR = join(import.meta.dirname, "..");

/** 生产码（.ts/.vue/.js，排除测试）相对 src 的路径，统一成正斜杠（Windows 腿也要能比）。 */
function productionSources(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((p) => /\.(ts|vue|js)$/.test(p) && !p.includes(".test."))
    .map((p) => p.replaceAll("\\", "/"))
    .sort();
}

/** 数一段文本里出现了多少次**裸的**媒体查询串（缺席型判据的正控靠它）。 */
function rawQueryHits(text: string, query: string): string[] {
  return [...text.matchAll(new RegExp(escapeRe(query), "g"))].map(
    (m) => m[0],
  );
}

test("isMacUA：桌面 macOS UA 判为 Mac", () => {
  const uas = [
    // Safari（Intel）
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    // Chrome（Apple Silicon，UA 仍写 Intel Mac OS X）
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // 老版本 macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), true, ua);
});

test("isMacUA：Windows / Linux / Android 判为非 Mac", () => {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), false, ua);
});

test("isMacUA：iOS / iPadOS 判为非 Mac（回归：旧正则 /Mac OS X/ 会把 iPhone 误判成 Mac）", () => {
  const uas = [
    // iPhone —— "like Mac OS X" 会命中 /Mac OS X/，必须排除
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    // iPad
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    // iPod touch（老设备）
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
  ];
  for (const ua of uas) assert.equal(isMacUA(ua), false, ua);
});

test("isMacUA：空 / 缺失 UA 不抛错、判为非 Mac", () => {
  assert.equal(isMacUA(""), false);
});

test("isAndroidUA：Android 手机 / 平板 / 桌面模式判为 Android", () => {
  const uas = [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    // Android 平板（无 Mobile 段）
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // Android 桌面模式 / 输入法 WebView 等小写变体
    "mozilla/5.0 (linux; android 12) applewebkit/537.36",
  ];
  for (const ua of uas) assert.equal(isAndroidUA(ua), true, ua);
});

test("isAndroidUA：桌面三端 / iOS 判为非 Android", () => {
  const uas = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "",
  ];
  for (const ua of uas) assert.equal(isAndroidUA(ua), false, ua);
});

/**
 * Windows 判定：**只用来按能力隐藏入口**（系统剪贴板的「文件列表」只有 Windows 有）。
 *
 * 判据的形状与 isMacUA / isAndroidUA 同一套：真样本为正控，别的平台为反例，
 * 空 UA 必须是「判不出」而不是「抛错」。
 */
test("isWindowsUA：Windows（WebView2 / Edge / Chrome）判为 Windows", () => {
  const uas = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  ];
  for (const ua of uas) assert.equal(isWindowsUA(ua), true, ua);
});

test("isWindowsUA：macOS / Linux / Android / 空 判为非 Windows", () => {
  const uas = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "",
  ];
  for (const ua of uas) assert.equal(isWindowsUA(ua), false, ua);
});

test("resolveMobileLayout：移动平台**一律**走移动布局，宽度判否也不算数", () => {
  // 回归（用户 2026-09-21，安卓首次启动）：权限弹框盖在 WebView 首次布局上时，
  // matchMedia 会读到兜底视口宽度（980px 档）⇒ narrow=false。若判据只看宽度，
  // 手机上就会渲染成桌面三栏布局。
  assert.equal(
    resolveMobileLayout({ android: true, ios: false, narrow: false }),
    true,
    "安卓必须恒为移动布局（竖屏锁定，没有窄窗口这种中间态）",
  );
  assert.equal(resolveMobileLayout({ android: false, ios: true, narrow: false }), true, "iOS 同理");
  assert.equal(resolveMobileLayout({ android: true, ios: false, narrow: true }), true);
});

test("resolveMobileLayout：桌面端按宽度切（窄窗口用移动布局，宽窗口用三栏）", () => {
  assert.equal(resolveMobileLayout({ android: false, ios: false, narrow: true }), true);
  assert.equal(
    resolveMobileLayout({ android: false, ios: false, narrow: false }),
    false,
    "桌面宽窗口要保留三栏布局",
  );
});

test("canHoverByMedia：问的是 (hover: hover) 这条媒体查询本身", () => {
  const asked: string[] = [];
  assert.equal(
    canHoverByMedia((q) => {
      asked.push(q);
      return { matches: true };
    }),
    true,
  );
  assert.deepEqual(asked, ["(hover: hover)"], "只该问这一条，不能顺手去判宽度");
  assert.equal(canHoverByMedia(() => ({ matches: false })), false, "触屏/无悬停设备判 false");
});

test("prefersReducedMotionByMedia：只问这一条查询，两个方向都要答对", () => {
  const asked: string[] = [];
  assert.equal(
    prefersReducedMotionByMedia((q) => {
      asked.push(q);
      return { matches: true };
    }),
    true,
    "系统开了减弱动态 ⇒ true",
  );
  assert.deepEqual(
    asked,
    ["(prefers-reduced-motion: reduce)"],
    "只该问这一条；写成 no-preference 会让「没开」和「开了」同值",
  );
  assert.equal(prefersReducedMotionByMedia(() => ({ matches: false })), false);
});

/**
 * 「一条系统无障碍开关只有一个家」的护栏。
 *
 * 为什么值得钉：动效族里 CSS 那两家（全局动画降级、骨架呼吸）由 `@media` 自己表达，
 * 而 JS 必须自己问的有两处（触觉、桌面搬 OS 窗口的抖动）。2026-10-19 实测到的正是
 * "各写一份迟早只有一处跟着改"这件事 —— 触觉接了、抖窗没接。
 * 现在两边都调 `prefersReducedMotion()`，这条判据保证以后不会再长出第三份手抄的查询串。
 *
 * ⚠️ 缺席型判据必须自带正控：先证明这个 matcher 认得出裸查询串，否则下面的"0 处"
 *    可能只是正则坏了（本项目踩过）。
 */
test("减弱动态这条查询不许在生产码里再出现第二份手抄（只有 platform.ts 豁免）", () => {
  const QUERY = "(prefers-reduced-motion: reduce)";
  // 正控
  assert.equal(
    rawQueryHits('window.matchMedia("(prefers-reduced-motion: reduce)")', QUERY).length,
    1,
    "matcher 认不出裸查询串，后面的判据是空转",
  );
  const home = "utils/platform.ts";
  const hits = productionSources()
    .filter((r) => r !== home)
    .flatMap((r) => rawQueryHits(readFileSync(join(SRC_DIR, r), "utf8"), QUERY).map(() => r));
  assert.deepEqual(hits, [], `这些文件自己抄了一份查询串（改名/换口径时只会有一处跟着改）：${hits.join(", ")}`);
  // 反向：那个家必须真的还在读它，否则"只有一个家"会变成"根本没有家"
  assert.ok(rawQueryHits(readFileSync(join(SRC_DIR, home), "utf8"), QUERY).length >= 1);
  // 两个消费者各自都得接上这个家（存在性判不出方向，所以按调用点逐个点名）
  for (const [r, fn] of [
    ["utils/haptics.ts", "prefersReducedMotion"],
    ["stores/chat/notifications.ts", "prefersReducedMotion"],
  ] as const) {
    const src = readFileSync(join(SRC_DIR, r), "utf8");
    assert.match(src, new RegExp(`${fn}\\(\\)`), `${r} 没有调用 ${fn}()`);
  }
});

/**
 * 「移动布局的宽度档」这一族只有一个家（§6.83 新增）。
 *
 * 为什么值得钉：这个数在本批之前有**三份手抄** —— 建 store 时判初值那一格、init 里那条
 * 活着的 `matchMedia`、以及首屏骨架 CSS（`src/boot/skeleton.css` 的 `@media`）。三份各自
 * 合法：改其中一份，编译得过、构建得过、探针也照样绿，症状只是"首帧按另一档渲染"或
 * "骨架在手机上画成桌面三栏"——**静默**。第四档不是我们写的：Tailwind 的 `md`（下面从
 * 库自己的默认主题现算），而全仓的结构级断点都写成 `desktop:md:*` 叠加 ⇒ JS 判窄必须
 * 恰好比 md 低 1px，差一格就出现"窗口停在那个宽度时两套口径同时亮或同时灭"。
 *
 * ⚠️ 缺席型判据的四件零件都在下面：正控（matcher 认得出裸查询）、反控（注释与 `<style>`
 *    里的同形文字不算作用点）、分母下限（扫描面缩水到判据自己失效时不许当绿）、反向钉
 *    （那个家必须真的还在被两个消费点用着 —— 否则"0 处裸抄"会因为整条链被删掉而变绿）。
 */
const WIDTH_QUERY = /\(\s*(?:max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g;

/** 剥掉行注释（`//`、`*`、`/*`、`<!--`）与 `.vue` 的 `<style>` 块 —— 注释里的解释不是作用点。 */
function jsCode(text: string): string {
  const noStyles = text.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  return noStyles
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("<!--"));
    })
    .join("\n");
}

/** CSS 侧只剥注释（`<style>` 那块这里用不上）。 */
function cssCode(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith("/*") || s.startsWith("*") || s.startsWith("<!--"));
    })
    .join("\n");
}

function widthQueries(text: string): Array<{ px: number; raw: string }> {
  return [...text.matchAll(WIDTH_QUERY)]
    // `@container (max-width: …)` 是**容器**查询（组件自己的宽度，如页脚这种局部区域），
    // 与「移动布局只有一个视口档」无关；只跳它，普通 `@media` 一律照抓（下面有量具自证）。
    .filter((m) => {
      const at = m.index ?? 0;
      const before = text.slice(Math.max(0, at - 60), at);
      const ruleStart = Math.max(before.lastIndexOf("{"), before.lastIndexOf("}"), before.lastIndexOf(";"));
      return !before.slice(ruleStart + 1).includes("@container");
    })
    .map((m) => ({ px: Number(m[1]), raw: m[0] }));
}

test("宽度查询量具：@container 不算视口断点，@media 仍然算（否则这条判据会空转）", () => {
  assert.deepEqual(widthQueries("@container (max-width: 240px) { .a { color: red } }"), []);
  assert.deepEqual(widthQueries("@container card (min-width: 200px) { .a { color: red } }"), []);
  assert.deepEqual(widthQueries("@media (max-width: 240px) { .a { color: red } }"), [
    { px: 240, raw: "(max-width: 240px)" },
  ]);
  assert.deepEqual(widthQueries("@media (min-width: 768px) { .a { color: red } }"), [
    { px: 768, raw: "(min-width: 768px)" },
  ]);
});

/** 样式载体：src 下全部 .css 与 .vue 的 `<style>` 块 + 根 index.html（骨架内联时也要算进来）。 */
function styleCarriers(): Array<{ rel: string; abs: string; vue: boolean }> {
  const all = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" }).map((p) => p.replaceAll("\\", "/"));
  const css = all
    .filter((p) => p.endsWith(".css"))
    .map((p) => ({ rel: `src/${p}`, abs: join(SRC_DIR, p), vue: false }));
  const vue = all
    .filter((p) => p.endsWith(".vue") && !p.includes(".test."))
    .map((p) => ({ rel: `src/${p}`, abs: join(SRC_DIR, p), vue: true }));
  return [{ rel: "index.html", abs: join(SRC_DIR, "..", "index.html"), vue: false }, ...css, ...vue];
}

/** `.vue` 只取 `<style>` 块 —— 脚本区里的查询归上面那条 JS 判据管。 */
function styleTextOf(c: { vue: boolean }, text: string): string {
  if (!c.vue) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

test("移动布局宽度档只有一个家：JS 不许裸抄、CSS 与 Tailwind 的 md 必须各就各位", async () => {
  // 正控 + 反控一次做完：代码行里的那一条要认出来，注释行里的那一条不许算作用点。
  assert.deepEqual(
    widthQueries(
      jsCode('const mq = window.matchMedia("(max-width: 767px)");\n// 旧笔记里写着 (min-width: 768px)\n'),
    ),
    [{ px: 767, raw: "(max-width: 767px)" }],
    "matcher 或注释剥离坏了 —— 下面的「0 处裸抄」会变成空转",
  );

  const home = readFileSync(join(SRC_DIR, "utils/platform.ts"), "utf8");
  const declaredPx = home.match(/export const MOBILE_MAX_WIDTH_PX\s*=\s*(\d+)/)?.[1];
  assert.ok(declaredPx, "platform.ts 里没有 `export const MOBILE_MAX_WIDTH_PX = <数字>` —— 家还没建立");
  const NARROW = Number(declaredPx);

  // 查询串必须由那个数现拼；数字手抄进模板 = 家里又长出第二份。
  const qLine = home.match(/export const NARROW_LAYOUT_QUERY\s*=\s*[`"][\s\S]{0,120}/)?.[0] ?? "";
  assert.ok(
    qLine.includes("MOBILE_MAX_WIDTH_PX") && qLine.includes("(max-width: ") && qLine.includes("px)"),
    `NARROW_LAYOUT_QUERY 不是从 MOBILE_MAX_WIDTH_PX 现拼的：${qLine}`,
  );

  const files = productionSources();
  assert.ok(files.length >= 180, `扫描面只有 ${files.length} 份生产文件，扫描本身可能已失效`);
  const offenders: string[] = [];
  for (const r of files) {
    for (const q of widthQueries(jsCode(readFileSync(join(SRC_DIR, r), "utf8")))) {
      offenders.push(`${r} → ${q.raw}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些文件自己抄了一份宽度媒体查询（改名/换档时只会有一处跟着改）：${offenders.join(" / ")}`,
  );

  // md 的档位从 Tailwind 自己的默认主题现算 —— 抄进判据的那一份自己就会漂。
  const tw = createRequire(import.meta.url)("tailwindcss/defaultTheme.js") as {
    screens: Record<string, string>;
  };
  const md = Number(String(tw.screens.md).replace(/px$/, ""));
  assert.ok(Number.isFinite(md) && md > 0, `从 tailwindcss/defaultTheme 读到的 md 不是档：${tw.screens.md}`);
  const cfgText = readFileSync(join(SRC_DIR, "..", "tailwind.config.js"), "utf8");
  assert.ok(
    !/screens\s*:/.test(cfgText),
    "tailwind.config.js 里覆盖了 screens —— md 不再是库的默认档，这条判据的口径要一起改",
  );
  assert.equal(md, NARROW + 1, `Tailwind md=${md}px 与 JS 的窄档 ${NARROW}px 必须恰好错开 1px`);

  // CSS 侧：只许用这两档（max-width 用 JS 那一档、min-width 用 md）—— 差一格就是重叠或留缝。
  const carriers = styleCarriers();
  const mismatched: string[] = [];
  const seen: string[] = [];
  for (const c of carriers) {
    for (const q of widthQueries(cssCode(styleTextOf(c, readFileSync(c.abs, "utf8"))))) {
      seen.push(`${c.rel} ${q.raw}`);
      const want = q.raw.includes("max-width") ? NARROW : md;
      if (q.px !== want) mismatched.push(`${c.rel} → ${q.raw}（这一侧该是 ${want}px）`);
    }
  }
  assert.ok(seen.length >= 1, `CSS 侧一个宽度查询都没认出（扫了 ${carriers.length} 份），量具可能已失效`);
  assert.deepEqual(mismatched, [], `CSS 侧的布局级断点与 JS/Tailwind 对不上：${mismatched.join(" / ")}`);
  console.log(`· 移动布局宽度档：家=${NARROW}px / Tailwind md=${md}px / JS 侧裸抄 ${offenders.length} 处 / CSS 侧查询 ${seen.join(" ")}`);

  // 反向钉：骨架那一处必须真的还在（上面的规则只说"不许错"，它发现不了"整条规则被删"）。
  const skel = cssCode(readFileSync(join(SRC_DIR, "boot/skeleton.css"), "utf8"));
  assert.deepEqual(
    widthQueries(skel).map((q) => q.raw),
    [`(max-width: ${NARROW}px)`],
    "首屏骨架的移动端断点没了或换了形状 —— 骨架就不跟着 JS 的窄档走了",
  );
  // 反向钉：两个消费点必须还接在这个家上（存在性判不出方向）。
  const store = readFileSync(join(SRC_DIR, "stores/useAppStore.ts"), "utf8");
  const uses = [...store.matchAll(/NARROW_LAYOUT_QUERY/g)].length;
  assert.ok(uses >= 2, `useAppStore 只引用了 ${uses} 次 NARROW_LAYOUT_QUERY（初值与活监听应各 1 次）`);
  const mod = (await import("./platform.ts")) as { NARROW_LAYOUT_QUERY?: string };
  assert.equal(
    mod.NARROW_LAYOUT_QUERY,
    `(max-width: ${NARROW}px)`,
    "运行时读到的查询串与从家现算的值不一致",
  );
});


// ---------------- 滚动条：naive-ui Scrollbar 内核 + 本仓显隐（2026-11-26 第四版） ----------------
//
// 前三轮（2026-11-25/26）都栽在同一处：条显不显示由旧内核的 JS 状态机（一串类名）决定，
// 加上 Chromium 在 Windows 上默认 overlay 滚动条 —— 同一份代码 mac 有、Windows 没有。
// 第四版把职责切开：
//   · 滚动与几何交给 naive 的 `Scrollbar`（原生滚动、自绘 rail/thumb、自己量 container）；
//   · 显隐由本仓决定 —— `trigger="none"` 让滑块常驻 DOM，:hover / .is-scrolling 两个
//     CSS 条件负责出现，滚动停手 1s 由组件撤标记。
// 内边距必须由组件搬到 content：宿主是 height:100%，padding 会让滚动区比轨道矮一截，
// 滑块长度/位置就跟内容对不上（用户报的「错乱」正是这一类）。
function findScrollbarIssues(cssRaw, vue) {
  // 只看真规则：注释里为了说明「故意不这么写」会引完整语法，不剥离就会误报。
  const css = stripCssComments(cssRaw);
  const issues = [];
  if (!vue.includes("NScrollbar")) issues.push("缺 NScrollbar 内核（滚动与几何的唯一来源）");
  if (!/trigger="none"/.test(vue)) issues.push("必须是 trigger=\"none\" —— 交回 naive 的 hover 状态机，滚动时就不会显示");
  if (/from\s+["']overlayscrollbars["']/.test(vue)) issues.push("旧内核 OverlayScrollbars 必须彻底退场（两套几何会互相打架）");
  if (!vue.includes("containerRef")) issues.push("滚动元素必须取 naive 的 containerRef（宿主自己不滚）");
  if (!vue.includes("is-scrolling")) issues.push("缺滚动中标记：滚动时不显示条");
  // 2026-11-26 线上反馈（7.4.0，Windows）：会话列表与设置页的条明显比聊天界面粗 ——
  // 因为默认档位是 `normal`(10px)，只有聊天显式传了 `thin`(8px)。8px 是全程基准，
  // 默认值必须是它；要更粗得显式传，不能靠"忘了传"来决定视觉重量。
  if (!/size:\s*"thin"/.test(vue)) issues.push('默认档位必须是 thin（8px）：normal 在会话列表/设置页上明显偏粗');
  if (!vue.includes("gosslan-os--pads")) issues.push("缺内边距移植：滚动区会比轨道矮，滑块位置/长度必然错");
  if (!vue.includes("contentStyle")) issues.push("内边距要落到 content 盒上（不能留在宿主）");

  const base = /\.gosslan-os \.n-scrollbar-rail__scrollbar \{([^}]*)\}/.exec(css);
  if (!base) {
    issues.push("缺滑块默认样式（锚点失效，判据会空转）");
  } else {
    const body = base[1];
    if (!/opacity:\s*0/.test(body)) issues.push("滑块默认必须 opacity:0（默认不可见）");
    if (!/pointer-events:\s*none/.test(body)) issues.push("隐藏时不许接管指针（否则会吞掉右缘内容的点击）");
    if (!/background-color:\s*var\(--gosslan-os-thumb\)/.test(body))
      issues.push("滑块颜色必须走 --gosslan-os-thumb（与 naive 的 token 同源，不许另写一套色）");
  }
  if (!css.includes(".gosslan-os:hover .n-scrollbar-rail__scrollbar")) issues.push("缺 hover 显示规则");
  if (!css.includes(".gosslan-os.is-scrolling .n-scrollbar-rail__scrollbar")) issues.push("缺滚动时显示规则");
  // 亮/暗两档的唯一定义处：:root 与 .dark 各一条同名变量（naive 的 token 也读它）。
  const thumbDefs = [...css.matchAll(/--gosslan-os-thumb:\s*([^;]+);/g)].map((m) => m[1].trim());
  if (thumbDefs.length < 2) issues.push("滑块颜色必须亮/暗各一档（:root 与 .dark 都要定义 --gosslan-os-thumb）");
  else if (thumbDefs[0] === thumbDefs[1]) issues.push("亮/暗两档不能是同一个值（暗底上会看不见）");
  if (!css.includes(".gosslan-os .n-scrollbar-container::-webkit-scrollbar"))
    issues.push("原生条没关：naive 的滑块会和原生条同时出现");
  if (css.includes("gosslan-os-bar-thumb")) issues.push("旧的自绘滑块节点必须删干净（两套条会叠在一起）");
  // 2026-11-26 线上教训：`hover: none` 是**输入能力**，不是平台身份。远程桌面（RDP）与
  // 触摸屏笔记本的 WebView2 都报 none ⇒ 桌面用户被当成手机，条被整块 display:none 掉。
  for (const block of hoverNoneBlocks(css)) {
    if (block.includes("n-scrollbar") && /display:\s*none/.test(block)) {
      issues.push("不许在 @media (hover: none) 里隐藏滚动条 —— 远程桌面/触摸屏桌面会命中，条就永远没了");
    }
  }
  return issues;
}

/** 取出 style.css 里每个 `@media (hover: none)` 块的正文（扁平块足够，本仓没有嵌套）。 */
function hoverNoneBlocks(css) {
  return [...css.matchAll(/@media\s*\(\s*hover:\s*none\s*\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
}

/** 剥掉 CSS 注释：判据只对真规则生效。 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

test("滚动条走 naive 内核、显隐由本仓控制、内边距搬到 content", () => {
  const vue = readFileSync(join(SRC_DIR, "components/ui/OverlayScroll.vue"), "utf8");
  const css = readFileSync(join(SRC_DIR, "style.css"), "utf8");
  assert.deepEqual(findScrollbarIssues(css, vue), [], findScrollbarIssues(css, vue).join("\n"));
});

test("滚动条判据反例自证：退回旧内核 / 去掉默认隐藏 / 去掉滚动显示 / 留旧节点 / 丢掉内边距 都必须红", () => {
  const vue0 = readFileSync(join(SRC_DIR, "components/ui/OverlayScroll.vue"), "utf8");
  const css0 = readFileSync(join(SRC_DIR, "style.css"), "utf8");
  const mut = (src, from, to) => {
    const out = src.replace(from, to);
    assert.notEqual(out, src, `反例自证：${from} 没被替换到，锚点已漂`);
    return out;
  };
  assert.ok(
    findScrollbarIssues(css0, mut(vue0, /trigger="none"/g, 'trigger="hover"')).length > 0,
    "退回 naive 的 hover 状态机必须命中（滚动时看不到条）",
  );
  assert.ok(
    findScrollbarIssues(css0, mut(vue0, /gosslan-os--pads/g, "gosslan-os--noop")).length > 0,
    "去掉内边距移植必须命中（滚动区与轨道不等高）",
  );
  assert.ok(
    findScrollbarIssues(mut(css0, /(var\(--gosslan-os-thumb\) !important;\s*)opacity: 0;/, "$1opacity: 1;"), vue0).length > 0,
    "滑块默认可见必须命中（用户要的是微信式「默认不出现」）",
  );
  assert.ok(
    findScrollbarIssues(mut(css0, ".gosslan-os.is-scrolling .n-scrollbar-rail__scrollbar", ".gosslan-os.is-scrolling .nope"), vue0).length > 0,
    "删掉滚动显示必须命中",
  );
  assert.ok(
    findScrollbarIssues(mut(css0, "background-color: var(--gosslan-os-thumb) !important;", "background-color: #888 !important;"), vue0).length > 0,
    "颜色绕过主题变量必须命中（会出现与主题脱节的一套色）",
  );
  assert.ok(
    findScrollbarIssues(css0, mut(vue0, /NScrollbar/g, "LegacyScroll")).length > 0,
    "拿掉 naive 内核必须命中",
  );
  // 把 2026-11-26 线上那条「触屏隐藏滚动条」加回去，必须变红。
  const withHoverHide = `${css0}\n@media (hover: none) {\n  .gosslan-os .n-scrollbar-rail {\n    display: none;\n  }\n}\n`;
  assert.ok(
    findScrollbarIssues(withHoverHide, vue0).length > 0,
    "用 @media (hover: none) 隐藏滚动条必须命中（远程桌面/触摸屏桌面也会命中，条就永远没了）",
  );
});

/**
 * naive Scrollbar 的几何必须在**外部 CSS** 里齐全 —— 生产包里这是唯一生效的样式来源。
 *
 * naive 的 CSS 由 css-render 运行时注入（`document.createElement("style")`，属于 inline
 * style），而生产 CSP 是严格策略（`style-src 'self'`）⇒ 必然被拒。**放宽 CSP 是假解**：
 * Tauri 打包时会给构建产物里的 `<style>` 注入 nonce，CSP3 规定一旦有 nonce，
 * `'unsafe-inline'` 就被忽略（见 `docs/notes/csp-candidate-2026-10-16.md` §五）。
 * ⇒ naive 只当滚动内核（测量 / thumb 尺寸 / 拖拽），几何全由本仓提供。
 * 「少抄一条」= 线上少一块几何，而 dev 不施加 CSP、肉眼完全看不出来 —— 这条判据补这个盲区。
 */
function findVendoredGeometryIssues(cssRaw) {
  const css = stripCssComments(cssRaw);
  const issues = [];
  const flat = (x) => x.replace(/\s+/g, " ");

  /** 同名规则可能分在多条里（级联），合并后再判 —— 但一条都没有就必须报。 */
  const need = (sel, decls, label) => {
    const blocks = [...css.matchAll(new RegExp(escapeRe(sel) + "\\s*\\{([^}]*)\\}", "g"))].map((m) => m[1]);
    if (blocks.length === 0) {
      issues.push(`缺 ${sel} 的几何（${label}）`);
      return;
    }
    const body = flat(blocks.join(" "));
    for (const d of decls) {
      if (!body.includes(flat(d))) issues.push(`${sel} 缺 ${d}（${label}）`);
    }
  };

  need(
    ".gosslan-os.n-scrollbar",
    [
      "height: 100%",
      "overflow: hidden",
      "position: relative",
      "isolation: isolate",
      // 高度由 flex 逐级传递（2026-11-26「新增/编辑任务滚不动」）：宿主的 `height: 100%`
      // 在"父高 auto + max-height"的卡片里解析成 auto，容器再用百分比就一起失效。
      "display: flex",
      "flex-direction: column",
    ],
    "宿主：占满高度 / 裁掉溢出 / 给 rail 当定位参照系 / 把 rail 的层级关在容器内 / 用 flex 传递高度",
  );
  need(
    ".gosslan-os .n-scrollbar-container",
    [
      // ⚠️ **不能**写成 `height: 100%`：父的 height 是 auto（flex 拉伸而来）时它静默失效，
      // 容器被内容撑高 ⇒ clientHeight === scrollHeight ⇒ 滚不动、滑块都不渲染。
      "height: auto",
      "flex: 1 1 auto",
      "display: flex",
      "flex-direction: column",
      "overflow: scroll",
      "max-height: inherit",
    ],
    "真正滚动的那一层（少 overflow / 高度没被宿主夹住就是滚不动）",
  );
  need(
    ".gosslan-os .n-scrollbar-content",
    ["box-sizing: border-box", "min-width: 100%", "flex: 1 0 auto"],
    "内容盒宽度口径 + 短内容撑满（同样不依赖百分比）",
  );
  // 否定判据：这两条是本轮根因的字面形状，出现即代表"又回到百分比传递"。
  for (const [sel, bad] of [
    [".gosslan-os .n-scrollbar-container", "height: 100%"],
    [".gosslan-os .n-scrollbar-content", "min-height: 100%"],
  ]) {
    const blocks = [...css.matchAll(new RegExp(escapeRe(sel) + "\\s*\\{([^}]*)\\}", "g"))].map((m) => m[1]);
    const body = flat(blocks.join(" "));
    if (body.includes(bad)) {
      issues.push(`${sel} 不许出现 ${bad}（auto 高的父里百分比会静默失效 ⇒ 滚不动）`);
    }
  }
  need(
    ".gosslan-os .n-scrollbar-rail",
    ["position: absolute", "z-index: 40"],
    "轨道必须脱离文档流、且压在容器内容之上（sticky 分组行是 z-10，见 2026-11-26 截图）",
  );
  need(
    ".gosslan-os .n-scrollbar-rail--vertical",
    ["width: var(--n-scrollbar-width)"],
    "轨道带宽",
  );
  need(
    ".gosslan-os .n-scrollbar-rail--vertical--right",
    [
      "top: var(--n-scrollbar-rail-top-vertical-right)",
      "right: var(--n-scrollbar-rail-right-vertical-right)",
      "bottom: var(--n-scrollbar-rail-bottom-vertical-right)",
      "left: var(--n-scrollbar-rail-left-vertical-right)",
    ],
    "轨道贴右缘的四边（缺一条就飞到别处）",
  );
  need(
    ".gosslan-os .n-scrollbar-rail--vertical .n-scrollbar-rail__scrollbar",
    ["position: absolute", "width: var(--n-scrollbar-width)"],
    "滑块本体",
  );
  return issues;
}

test("naive Scrollbar 的几何全部写在外部 CSS 里（生产包只有这份生效）", () => {
  const css = readFileSync(join(SRC_DIR, "style.css"), "utf8");
  const issues = findVendoredGeometryIssues(css);
  assert.deepEqual(issues, [], issues.join("\n"));
});

test("几何 vendor 判据反例自证：少任何一条都必须红", () => {
  const css0 = readFileSync(join(SRC_DIR, "style.css"), "utf8");
  // 删掉**全部**同名规则（单条可能只是 overscroll 这类补充），少一块几何就要红。
  const dropAll = (sel) => {
    const out = css0.replace(new RegExp(escapeRe(sel) + "\\s*\\{[^}]*\\}", "g"), "");
    assert.notEqual(out, css0, `锚点漂了：${sel}`);
    return out;
  };
  // 只改层级（不删整块）：把 40 压回 1 必须红 —— 那就是被分组行盖住的原状。
  const lowered = css0.replace("z-index: 40;", "z-index: 1;");
  assert.notEqual(lowered, css0, "锚点漂了：rail 的 z-index: 40");
  assert.ok(
    findVendoredGeometryIssues(lowered).length > 0,
    "把轨道的 z-index 压回 1 必须判红（通讯录的分组行会盖住滑块）",
  );
  // 退回百分比传高（2026-11-26 的真根因）：把 container 的 flex 传递换回 `height: 100%`
  // 必须红。这一条是那轮"新增/编辑任务滚不动"的**原文形状**，没有它，下次"顺手简化"
  // 又会把 auto 高父里的百分比失效引回来。
  const pct = css0.replace(
    /(\.gosslan-os \.n-scrollbar-container \{[\s\S]*?)\n  flex: 1 1 auto;/,
    "$1\n  flex: 1 1 auto;\n  height: 100%;",
  );
  assert.notEqual(pct, css0, "锚点漂了：container 的 flex: 1 1 auto");
  assert.ok(
    findVendoredGeometryIssues(pct).length > 0,
    "container 又写 height: 100% 必须判红（auto 高的父里百分比失效 ⇒ 滚不动）",
  );
  for (const [sel, why] of [
    [".gosslan-os.n-scrollbar", "宿主不占满高 / 不裁溢出 ⇒ 列表盖住输入框"],
    [".gosslan-os .n-scrollbar-container", "滚动元素没有 overflow ⇒ 滚不动"],
    [".gosslan-os .n-scrollbar-rail", "轨道不脱离文档流 ⇒ 被 overflow:hidden 裁掉，看不到条"],
    [".gosslan-os .n-scrollbar-rail--vertical--right", "轨道没有四边 ⇒ 位置算不出来"],
    [".gosslan-os .n-scrollbar-rail--vertical .n-scrollbar-rail__scrollbar", "滑块没有定位/宽度 ⇒ 不可见"],
  ]) {
    assert.ok(
      findVendoredGeometryIssues(dropAll(sel)).length > 0,
      `删掉 ${sel} 必须判红（${why}）`,
    );
  }
});

/**
 * 切会话首帧的 overscan 必须收紧（2026-11-26，用户实测「点列表切换，右边顿一下」）。
 *
 * 锁的是什么：`convSwitch` 那一帧如果按 `props.overscan`(6) 双向预渲染，h=431 的视口
 * 会画 **22 行**（视口内约 10 行 + 12 行 overscan），每行 `MessageItem` ≈ 11~20ms
 * ⇒ 白付 130~240ms。实测收紧到 2 之后同一场景降到 9~16 行。
 *
 * 四条一起才成立，缺一条就退化成"设了但没生效 / 一次切换渲染两遍"：
 *   ① options 的 overscan 被 `tightOverscan` 收口；
 *   ② 必须挂在 **pre-flush** 的 items watcher 里（post 已经晚了那一帧）；
 *   ③ 必须由**用户输入**恢复（wheel/touch/pointerdown），不许定时 ——
 *      240ms 定时器恰好落在切换后的忙窗口里，恢复本身又要多挂 12 行
 *      （用户实测：切换首帧渲染 5~10 行，两帧后变成 13~20 行，中间 453ms）；
 *   ④ 恢复必须挂在 `onUserInput` 上（那三个事件是模板里真实绑定的口径）。
 */
test("VirtualList：切会话首帧收紧 overscan，且必须在 items 变化那一帧之前设上", () => {
  const src = readFileSync(join(SRC_DIR, "components/VirtualList.vue"), "utf8");
  assert.ok(
    src.includes("overscan: tightOverscan.value ? Math.min(props.overscan, TIGHT_OVERSCAN) : props.overscan"),
    "options.overscan 必须被 tightOverscan 收口（否则首帧仍按 6 双向预渲染）",
  );
  const setAt = src.indexOf("tightOverscan.value = true;");
  assert.ok(setAt > 0, "找不到收紧的那一句 —— 锚点漂了");
  const postWatchAt = src.indexOf('watch(() => props.items, onItemsChanged, { flush: "post" })');
  assert.ok(postWatchAt > 0, "找不到 post 的 items watcher —— 锚点漂了");
  assert.ok(
    setAt < postWatchAt,
    "收紧必须在 pre-flush 的 watcher 里（写在 post 之后 = 那一帧已经按全量 overscan 画完了）",
  );
  const tightBlock = src.slice(src.indexOf("const TIGHT_OVERSCAN"), src.indexOf("function rangeExtractor"));
  assert.ok(
    tightBlock.indexOf("const TIGHT_OVERSCAN") === 0 && !tightBlock.includes("setTimeout"),
    "收紧的恢复不许放在定时器里：240ms 那个窗口里恢复 = 切换后第二遍全量挂载",
  );
  const inputAt = src.indexOf("function onUserInput()");
  const restoreAt = src.indexOf("restoreOverscanNow();", inputAt);
  assert.ok(
    inputAt > 0 && restoreAt > inputAt && restoreAt < src.indexOf("function onResize()"),
    "恢复必须挂在用户输入的处理器里（wheel/touch/pointerdown）：没动手就不该再渲染一遍",
  );
});

/**
 * 切会话首帧要把逐行的布局读取合批（2026-11-26 第四轮实测后的优化）。
 *
 * 证据：12 条真实 MessageItem 的 `getComputedStyle` 调用有 600 次，栈全部指向
 * `usePreviewColumns.allowedColumnWidth`（cap / parent / 每层祖先的 padding+border，
 * 再加两次 font）。这些读紧跟在每行挂载之后 ⇒ 每行一次强制样式重算，而
 * 切会话那一轮 patch 实测 93~406ms。修法是两条一起：
 *   ① 同一聊天视口共享一次实测（内容宽 + 字体 + class 链 + 世代）；
 *   ② VirtualList 切会话那一帧开窗，窗口内的测量攒到当前 patch 后的同一个微任务再读
 *      （用 rAF 会让行高晚一帧，实测跨帧跳 28px）。
 * 少哪条都会退回逐行强制 recalc。
 */
test("VirtualList × usePreviewColumns：切会话首帧的逐行布局读取必须合批", () => {
  const vl = readFileSync(join(SRC_DIR, "components/VirtualList.vue"), "utf8");
  const upc = readFileSync(join(SRC_DIR, "composables/usePreviewColumns.ts"), "utf8");

  assert.ok(
    vl.includes("deferLayoutReadsFor(240);"),
    "切会话那一帧必须开合批窗口（窗口外的逐行测量行为不变）",
  );
  const deferAt = vl.indexOf("deferLayoutReadsFor(240);");
  const postAt = vl.indexOf('watch(() => props.items, onItemsChanged, { flush: "post" })');
  assert.ok(deferAt > 0 && postAt > 0 && deferAt < postAt, "开窗必须发生在渲染那一帧之前");

  assert.ok(
    upc.includes("afterLayoutReadWindow(() => measure())"),
    "onMounted / 元素换掉的测量必须走合批入口",
  );
  const hasSharedRead = (src: string) =>
    src.includes("sharedEpoch === layoutEpoch") &&
    src.includes("sharedLayoutKey === previewLayoutKey(el)");
  assert.ok(hasSharedRead(upc), "同一视口要复用一次实测，且世代 / class 链不同时必须重新量");
  assert.ok(
    vl.includes("invalidatePreviewLayout();"),
    "字号 / 真实宽度变化时必须让共享读数作废，否则列数停在旧值",
  );
  // 反例自证：把世代判等翻转，同一个判据必须红（否则这条测试是恒真的摆设）。
  const broken = upc.replace("sharedEpoch === layoutEpoch", "sharedEpoch !== layoutEpoch");
  assert.notEqual(broken, upc, "锚点漂了：世代比较");
  assert.equal(hasSharedRead(broken), false, "把世代判等翻转后判据必须变红");
});
