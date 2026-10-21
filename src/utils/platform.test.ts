import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  canHoverByMedia,
  isAndroidUA,
  isMacUA,
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
  return [...text.matchAll(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map(
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
    ["stores/useChatStore.ts", "prefersReducedMotion"],
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
  return [...text.matchAll(WIDTH_QUERY)].map((m) => ({ px: Number(m[1]), raw: m[0] }));
}

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
