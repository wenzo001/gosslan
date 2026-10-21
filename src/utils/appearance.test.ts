import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyTheme } from "./color.ts";
import {
  APPEARANCE_STORAGE_KEY,
  LEGACY_DARK_STORAGE_KEY,
  isAppearanceMode,
  readStoredAppearance,
  resolveDark,
  type ReadonlyStorage,
} from "./appearance.ts";
import {
  applyPreference,
  currentLocale,
  isLanguagePreference,
  refreshSystemLocale,
  type LanguagePreference,
} from "../i18n/index.ts";

// ---------------- 解析规则：用户意图 × 系统偏好 ----------------

test("resolveDark：跟随系统时取系统值", () => {
  assert.equal(resolveDark("system", true), true);
  assert.equal(resolveDark("system", false), false);
});

test("resolveDark：强制模式不随系统变化（用户选了就不该被系统覆盖）", () => {
  assert.equal(resolveDark("dark", false), true, "系统浅色也不能把强制深色改掉");
  assert.equal(resolveDark("dark", true), true);
  assert.equal(resolveDark("light", true), false, "系统深色也不能把强制浅色改掉");
  assert.equal(resolveDark("light", false), false);
});

test("isAppearanceMode：只认三种合法值", () => {
  for (const v of ["system", "light", "dark"]) assert.equal(isAppearanceMode(v), true);
  for (const v of ["", "System", "auto", "夜间", null, undefined, 1]) {
    assert.equal(isAppearanceMode(v), false, `${String(v)} 不应被判为合法模式`);
  }
});

// ---------------- 老数据迁移：不能把用户此前的选择静默丢掉 ----------------

const store = (m: Record<string, string>): ReadonlyStorage => ({
  getItem: (k) => (k in m ? m[k] : null),
});

test("显式模式原样读回", () => {
  assert.equal(readStoredAppearance(store({ [APPEARANCE_STORAGE_KEY]: "system" })), "system");
  assert.equal(readStoredAppearance(store({ [APPEARANCE_STORAGE_KEY]: "light" })), "light");
  assert.equal(readStoredAppearance(store({ [APPEARANCE_STORAGE_KEY]: "dark" })), "dark");
});

test("旧版本只存了布尔值 → 迁移为显式模式（而不是当成'跟随系统'）", () => {
  assert.equal(readStoredAppearance(store({ [LEGACY_DARK_STORAGE_KEY]: "1" })), "dark");
  assert.equal(readStoredAppearance(store({ [LEGACY_DARK_STORAGE_KEY]: "0" })), "light");
});

test("显式模式优先于残留的旧布尔值", () => {
  const both = { [APPEARANCE_STORAGE_KEY]: "system", [LEGACY_DARK_STORAGE_KEY]: "1" };
  assert.equal(readStoredAppearance(store(both)), "system", "用户后来选了跟随系统，就不能被旧值拽回深色");
});

test("什么都没有 → 跟随系统（默认值）", () => {
  assert.equal(readStoredAppearance(store({})), "system");
});

test("存储值非法（脏数据）→ 退回旧布尔值，再退回跟随系统", () => {
  assert.equal(readStoredAppearance(store({ [APPEARANCE_STORAGE_KEY]: "auto" })), "system");
  assert.equal(
    readStoredAppearance(store({ [APPEARANCE_STORAGE_KEY]: "auto", [LEGACY_DARK_STORAGE_KEY]: "1" })),
    "dark",
    "显式值损坏时应继续尝试旧值，而不是直接放弃",
  );
});

// ---------------- 与首屏脚本（src/boot/theme-boot.js）交叉验证 ----------------
//
// 这是**本轮新增的关键护栏**。外观规则有两份实现：
//   ① 本模块的纯函数（useAppStore 只是它的消费者）；
//   ② 首屏脚本 —— 它必须先于 bundle 执行（否则启动会"闪一下白"），因此无法 import 本模块。
// 两份漂移的症状是"骨架与真界面外观不一致"，只在启动瞬间出现、极难自测发现。
// 与其在注释里写"两处必须一致"，不如**把那段脚本真跑一遍**来对照。
//
// ⚠️ 脚本从 `index.html` 内联搬到了 `src/boot/theme-boot.js`（三个窗口共用一份，
//    由 vite 插件内联回各自的 HTML）—— 因为"主/设置/日志三个窗口各抄一份主题逻辑"
//    迟早会漂移。本护栏直接读那份**事实来源**，比读某个 HTML 里的拷贝更准。

/** 取出首屏主题脚本（三窗口共用的事实来源）。 */
function readBootScript(): string {
  return readFileSync(join(import.meta.dirname, "..", "boot", "theme-boot.js"), "utf8");
}

/** 在替身环境里执行首屏脚本，返回它最终加了哪些类、把 `<html lang>`/`<title>` 与哪些内联变量写成什么。 */
function runBootScript(env: {
  appearance?: string | null;
  legacyDark?: string | null;
  systemDark: boolean;
  /** 其它按键名直存的替身（键名由调用方从源码现解析，判据里不抄字面量）。 */
  extra?: Record<string, string>;
  /** 让**指定这几枚键**的读取抛错（§6.82）：真实缺陷是"一抛就把后面三件事带走"，不是"整体不可用"。 */
  throwKeys?: string[];
  /** §6.87：`true` = 调用时抛错；`"missing"` = 这个 API 压根不存在（旧 WebView / 受限环境）。
   *  真实缺陷的形状是"默认档 system 要问 matchMedia，它一抛，主色/字体/语言/标题全没做"。 */
  matchMediaThrows?: boolean | "missing";
}): { dark: boolean; lang: string | null; style: Record<string, string> } {
  const values: Record<string, string> = {};
  if (env.appearance != null) values[APPEARANCE_STORAGE_KEY] = env.appearance;
  if (env.legacyDark != null) values[LEGACY_DARK_STORAGE_KEY] = env.legacyDark;
  if (env.extra) Object.assign(values, env.extra);

  const added = new Set<string>();
  const style: Record<string, string> = {};
  const el: Record<string, unknown> = {
    classList: { add: (c: string) => added.add(c) },
    style: { setProperty: (k: string, v: string) => { style[k] = v; } },
    // 首屏脚本读到属性为 null 时不动 title —— 这个替身只关心 dark 类，与旧版一致。
    getAttribute: () => null,
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { ls: g.localStorage, doc: g.document, win: g.window };
  const thrown = new Set(env.throwKeys || []);
  g.localStorage = {
    getItem: (k: string) => {
      if (thrown.has(k)) throw new Error("SecurityError: " + k);
      return values[k] ?? null;
    },
  };
  g.document = { documentElement: el };
  g.window =
    env.matchMediaThrows === "missing"
      ? {}
      : {
          matchMedia: () => {
            if (env.matchMediaThrows) throw new Error("matchMedia 不可用");
            return { matches: env.systemDark };
          },
        };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(readBootScript())();
  } finally {
    g.localStorage = saved.ls;
    g.document = saved.doc;
    g.window = saved.win;
  }
  return { dark: added.has("dark"), lang: (el.lang as string | undefined) ?? null, style };
}

test("首屏脚本（src/boot/theme-boot.js）与 utils/appearance 的解析结果**逐例一致**", () => {
  const cases = [
    { appearance: "system", legacyDark: null, systemDark: true },
    { appearance: "system", legacyDark: null, systemDark: false },
    { appearance: "dark", legacyDark: null, systemDark: false },
    { appearance: "light", legacyDark: null, systemDark: true },
    { appearance: null, legacyDark: "1", systemDark: false },
    { appearance: null, legacyDark: "0", systemDark: true },
    { appearance: null, legacyDark: null, systemDark: true },
    { appearance: null, legacyDark: null, systemDark: false },
    // 脏数据 + 旧值：两份实现都要走到"先看显式、再退回旧布尔"的顺序
    { appearance: "auto", legacyDark: "1", systemDark: false },
    { appearance: "auto", legacyDark: "0", systemDark: true },
  ];
  for (const c of cases) {
    const expected = resolveDark(
      readStoredAppearance(store({
        ...(c.appearance != null ? { [APPEARANCE_STORAGE_KEY]: c.appearance } : {}),
        ...(c.legacyDark != null ? { [LEGACY_DARK_STORAGE_KEY]: c.legacyDark } : {}),
      })),
      c.systemDark,
    );
    const actual = runBootScript(c).dark;
    assert.equal(
      actual,
      expected,
      `首屏脚本与 store 的判定不一致：appearance=${String(c.appearance)} legacy=${String(c.legacyDark)} ` +
        `系统深色=${c.systemDark} → 脚本=${actual}，期望=${expected}`,
    );
  }
});

test("首屏脚本不依赖 localStorage 可用（隐私模式抛错时按浅色渲染，不崩）", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { doc: g.document, win: g.window };
  g.document = { documentElement: { classList: { add: () => {} }, style: { setProperty: () => {} } } };
  g.window = { matchMedia: () => ({ matches: true }) };
  // 只在 window 上放 matchMedia、不给 localStorage → getItem 抛错，脚本必须自行兜住
  const savedLs = g.localStorage;
  delete g.localStorage;
  try {
    assert.doesNotThrow(() => new Function(readBootScript())(), "localStorage 不可用时不应抛错");
  } finally {
    g.localStorage = savedLs;
    g.document = saved.doc;
    g.window = saved.win;
  }
});

// ---------------- 首帧语言：脚本那份 ↔ i18n 的真实现 ----------------
//
// 与暗色完全同形的第二份实现，但 §6.46 之前**只有暗色有逐例对照** —— 语言那条一直只靠注释里
// 一句"改动请同步"。症状用户可见：骨架先英文、bundle 起来后翻回中文（或反过来），只在启动那一瞬。
// 期望值不抄规则：直接叫 i18n 自己的公开 API（applyPreference / refreshSystemLocale /
// currentLocale / isLanguagePreference），两边共用同一个替身 `navigator`。

/** 语言偏好键：从 i18n 的源文件现解析（它是模块私有常量，不为测试扩大导出面）。 */
const LOCALE_STORAGE_KEY = (() => {
  const text = readFileSync(join(import.meta.dirname, "..", "i18n", "index.ts"), "utf8");
  const m = text.match(/const STORAGE_KEY = "([^"]+)"/);
  assert.ok(m, "i18n/index.ts 里解析不到 STORAGE_KEY，判据本身已失效");
  return m![1];
})();

type BootLangEnv = {
  pref?: string | null;
  languages?: string[];
  language?: string;
  titles?: { zh?: string; en?: string };
};

/** 同一套替身环境里分别跑「首屏脚本」与「i18n」，返回两者各自判出的首帧语言与标题。 */
function bootAndI18n(env: BootLangEnv): {
  boot: { lang: string | null; title: string | null };
  i18n: string;
} {
  const values: Record<string, string> = {};
  if (env.pref != null) values[LOCALE_STORAGE_KEY] = env.pref;
  const el: Record<string, unknown> = {
    classList: { add: () => {} },
    style: { setProperty: () => {} },
    getAttribute: (k: string) =>
      k === "data-title-zh" ? (env.titles?.zh ?? null) : k === "data-title-en" ? (env.titles?.en ?? null) : null,
  };
  const doc: Record<string, unknown> = { documentElement: el, title: null };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { ls: g.localStorage, doc: g.document, win: g.window };
  // Node 的 globalThis.navigator 是只读访问器 ⇒ 必须用描述符覆盖并按原样还原。
  const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  g.localStorage = { getItem: (k: string) => values[k] ?? null, setItem: () => {} };
  g.document = doc;
  g.window = { matchMedia: () => ({ matches: false }) };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { languages: env.languages ?? [], language: env.language ?? "" },
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(readBootScript())();
    // ⚠️ 必须**先取快照**再去碰 i18n：`applyPreference`/`refreshSystemLocale` 里的
    // `syncDocumentLang()` 会把 `document.documentElement.lang` 写在同一个替身 `el` 上。
    // 先跑脚本、后读 el.lang，读到的就是 i18n 自己的值 —— 两边比的是同一个数，永远绿。
    // （这条正是第一版判据空转的根因，靠单点变异当场暴露。）
    const boot = { lang: (el.lang as string | undefined) ?? null, title: (doc.title as string | null) ?? null };
    const p: LanguagePreference =
      env.pref != null && isLanguagePreference(env.pref) ? env.pref : "system";
    applyPreference(p);
    refreshSystemLocale();
    return { boot, i18n: currentLocale() };
  } finally {
    if (savedNav) Object.defineProperty(globalThis, "navigator", savedNav);
    else delete (globalThis as unknown as Record<string, unknown>).navigator;
    g.localStorage = saved.ls;
    g.document = saved.doc;
    g.window = saved.win;
  }
}

test("首屏脚本与 i18n 对**首帧语言**的判定逐例一致（含 languages 全不命中那一格）", () => {
  const cases: BootLangEnv[] = [
    { pref: "zh-CN", languages: ["en-US"], language: "en-US" },
    { pref: "en-US", languages: ["zh-CN"], language: "zh-CN" },
    { pref: "system", languages: ["zh-Hans-CN"], language: "zh-Hans-CN" },
    // languages 里一个中英都没命中、而 navigator.language 是中文：两边都必须兜底才算一致
    { pref: null, languages: ["ja-JP"], language: "zh-CN" },
    { pref: "fr-FR", languages: ["en-GB"], language: "en-GB" },
    { pref: null, languages: [], language: "zh-TW" },
    { pref: null, languages: ["de-DE"], language: "de-DE" },
    { pref: null, languages: ["en-US", "ja-JP"], language: "en-US" },
    { pref: null, languages: [], language: "" },
  ];
  assert.ok(cases.length >= 6, `语言对照样例只有 ${cases.length} 例，低于下限`);
  for (const c of cases) {
    const r = bootAndI18n(c);
    assert.ok(
      r.boot.lang === "zh-CN" || r.boot.lang === "en-US",
      `脚本写出的 lang 不是两个合法值之一：${String(r.boot.lang)}（样例 ${JSON.stringify(c)}）`,
    );
    assert.equal(
      r.boot.lang,
      r.i18n,
      `首帧语言不一致：pref=${String(c.pref)} languages=${JSON.stringify(c.languages)} ` +
        `language=${String(c.language)} → 脚本=${r.boot.lang}，i18n=${r.i18n}`,
    );
  }
});

test("骨架标题按首帧语言取中英两支；HTML 没声明两支时不许把标题写坏", () => {
  const pair = { zh: "相闻 · 设置", en: "Gosslan · Settings" };
  const zh = bootAndI18n({ pref: "zh-CN", languages: ["en-US"], titles: pair });
  assert.equal(zh.boot.title, "相闻 · 设置", `中文偏好下标题没取中文支：${String(zh.boot.title)}`);
  const en = bootAndI18n({ pref: "en-US", languages: ["zh-CN"], titles: pair });
  assert.equal(en.boot.title, "Gosslan · Settings", `英文偏好下标题没取英文支：${String(en.boot.title)}`);
  const none = bootAndI18n({ pref: "zh-CN", languages: ["zh-CN"] });
  assert.equal(none.boot.title, null, "HTML 未声明 data-title-* 时脚本不该动 title");
});

test("每扇窗口的 HTML 都必须同时声明 data-title-zh 与 data-title-en（少一支＝另一种语言下标题错）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const htmls = readdirSync(root).filter((f) => f.endsWith(".html"));
  assert.ok(htmls.length >= 5, `只扫到 ${htmls.length} 份窗口 HTML，扫描本身可能已失效`);
  const missing = htmls.filter((f) => {
    const text = readFileSync(join(root, f), "utf8");
    return !/data-title-zh="[^"]+"/.test(text) || !/data-title-en="[^"]+"/.test(text);
  });
  assert.deepEqual(missing, [], `这些窗口 HTML 缺 data-title-zh / data-title-en 之一：${missing.join(", ")}`);
});

// ---------------- 交叉引用本身也要有判据 ----------------
// 这两处的注释是"下一谁来改的人"唯一的地图。它们一度指向 useAppStore 的 readLocalAppearance()
// —— 那个符号**全仓不存在**（真值家早在 utils/appearance.ts），照它去找会白跑一趟。
// ⇒ 注释里点名的符号必须真在 utils/appearance.ts 的导出里，指错就红。
test("两份实现互相指认的符号必须真实存在：注释不许把人带到一个不存在的函数上", () => {
  const home = readFileSync(join(import.meta.dirname, "appearance.ts"), "utf8");
  const exported = new Set(
    [...home.matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]),
  );
  const boot = readBootScript();
  const docs = [home, boot, readFileSync(join(import.meta.dirname, "..", "composables", "useDocumentDark.ts"), "utf8")].join("\n");
  const named = [...docs.matchAll(/readStoredAppearance|resolveDark|isAppearanceMode|readLocalAppearance|APPEARANCE_STORAGE_KEY|LEGACY_DARK_STORAGE_KEY|APPEARANCE_KEY|LEGACY_DARK_KEY/g)];
  assert.ok(named.length >= 3, `交叉引用只认出 ${named.length} 处，判据本身可能已失效`);
  const missing = [...new Set(named.map((m) => m[0]))].filter((n) => !exported.has(n));
  assert.deepEqual(missing, [], `注释点名的这些符号不在 utils/appearance.ts 的导出里：${missing.join(", ")}`);
});

// ---------------- 跨边界键名：首屏脚本的裸字面量 ↔ TS 侧常量 ----------------
//
// 首屏脚本 import 不到任何模块 ⇒ 它只能用**字符串字面量**读 localStorage。于是同一个"键名"
// 在仓库里有两种载体：TS 侧的 `const *_KEY`，脚本里的裸字面量。
// 漂移的症状是静默的：脚本读了一个没人写的键 → 首帧永远按浅色/英文渲染，而 vue-tsc、构建、
// 探针、运行时全部无话可说（旧名字再没有任何一处代码引用，编译期看不见任何东西）。
// ⇒ 两边都**从源码现解析**。绝不把键名抄进这份测试 —— 手抄的那一份自己就会漂。

const SRC_DIR = join(import.meta.dirname, "..");

/** 生产码（.ts/.vue，排除 `*.test.ts`）的扫描面 + 其中具名声明的 `*_KEY` 字符串常量。 */
function scanProductionSources(): { files: string[]; keys: Map<string, { value: string; file: string }> } {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" }).filter(
    (p) => p.endsWith(".vue") || (p.endsWith(".ts") && !p.endsWith(".test.ts")),
  );
  const keys = new Map<string, { value: string; file: string }>();
  for (const r of files) {
    const text = readFileSync(join(SRC_DIR, r), "utf8");
    for (const m of text.matchAll(/\bconst\s+([A-Za-z0-9_]*KEY[A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*"([^"]+)"/g)) {
      keys.set(m[1], { value: m[2], file: r });
    }
  }
  return { files, keys };
}

/** 一段源码里所有以**裸字面量**为键的 localStorage 调用（getItem/setItem/removeItem）。 */
function findBareStorageLiterals(text: string): string[] {
  // 首屏脚本 §6.82 起走逐键兜底的 readBootLS("键")（它自己那层 try，因为内联脚本 import 不到那个家），
  // 键名仍是裸字面量 ⇒ 交叉核对的契约没变，只是载体多一种。两种都得认，否则"认出 0 个键"会伪装成绿。
  return [...text.matchAll(/(?:localStorage\.(?:getItem|setItem|removeItem)|readBootLS)\(\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("首屏脚本读的 5 个键必须各自等于 TS 侧常量的**现算值**（两边漂移即红）", () => {
  const { keys } = scanProductionSources();
  // 分母下限：现算实测 11 个具名 *_KEY（本批之前 10 个，`LIST_W_KEY` 是第 11 个）。
  // 低于下限说明解析本身失效，不许当绿。
  assert.ok(keys.size >= 8, `只解析出 ${keys.size} 个具名 *_KEY 常量，判据本身可能已失效`);

  // 五个角色分别钉回它自己的家；三个私有常量（THEME_KEY / FONT_KEY / STORAGE_KEY）按名字现解析，
  // 不为测试而扩大导出面。
  const roles = [
    { name: "APPEARANCE_STORAGE_KEY", value: APPEARANCE_STORAGE_KEY },
    { name: "LEGACY_DARK_STORAGE_KEY", value: LEGACY_DARK_STORAGE_KEY },
    { name: "THEME_KEY", value: keys.get("THEME_KEY")?.value ?? "<未解析到>" },
    { name: "FONT_KEY", value: keys.get("FONT_KEY")?.value ?? "<未解析到>" },
    { name: "STORAGE_KEY", value: keys.get("STORAGE_KEY")?.value ?? "<未解析到>" },
  ];
  const boot = new Set(findBareStorageLiterals(readBootScript()));
  assert.ok(boot.size >= 4, `首屏脚本只认出 ${boot.size} 个字面量键，判据本身可能已失效`);
  for (const r of roles) {
    assert.ok(
      boot.has(r.value),
      `首屏脚本没有读 ${r.name} 当前的值 "${r.value}"（脚本读到的是：${[...boot].join(", ")}）`,
    );
  }
  // 反方向：脚本里的每个字面量都得是 TS 侧真用过的键，否则它读的是没人写的东西。
  const allValues = new Set([...keys.values()].map((v) => v.value));
  const orphan = [...boot].filter((k) => !allValues.has(k));
  assert.deepEqual(orphan, [], `首屏脚本读了这些不在任何 *_KEY 常量里的键：${orphan.join(", ")}`);
});

test("生产码不许再用裸字面量当 localStorage 键（只有首屏脚本豁免），matcher 自带正控", () => {
  // 正控：先证明这个 matcher 认得出裸字面量，否则下面的"0 处"可能只是正则坏了。
  assert.deepEqual(
    findBareStorageLiterals(
      `localStorage.setItem("probe.key", v); localStorage.getItem("probe.key"); readBootLS("probe.boot");`,
    ),
    ["probe.key", "probe.key", "probe.boot"],
    "matcher 认不出裸字面量键，后面的判据是空转",
  );
  const { files } = scanProductionSources();
  assert.ok(files.length >= 180, `扫描面只有 ${files.length} 份生产文件，扫描本身可能已失效`);
  const hits: string[] = [];
  for (const r of files) {
    for (const k of findBareStorageLiterals(readFileSync(join(SRC_DIR, r), "utf8"))) hits.push(`${r} → "${k}"`);
  }
  assert.deepEqual(hits, [], `这些调用把键名写成了裸字面量（改名会静默丢掉用户偏好）：${hits.join("; ")}`);
});

/** 用同一个假 `document` 跑一次 `applyTheme`，收集它写/清了哪些内联变量。 */
function applyThemeWrites(fontFamily: string): Record<string, string | null> {
  const seen: Record<string, string | null> = {};
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.document;
  g.document = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          seen[k] = v;
        },
        removeProperty: (k: string) => {
          seen[k] = null;
        },
      },
    },
  };
  try {
    applyTheme("#3b82f6", fontFamily);
  } finally {
    g.document = saved;
  }
  return seen;
}

test("字体：首屏脚本与 applyTheme 对同一个存储值必须落到同一个内联值（默认档两边都不留内联）", () => {
  // 缺陷形状与 §6.47 那条同源：用户选过字体时，`gosslan.fontFamily` 只有 store 起来之后才被
  // applyTheme 写成内联 ⇒ 骨架与第一批像素全用系统栈，然后整屏翻一次。
  // ⚠️ 两个替身各用各的 `document`：共用同一个可变出口时，判据比的会是它自己（§6.47 的空转教训）。
  const fontKey = scanProductionSources().keys.get("FONT_KEY")?.value;
  assert.ok(fontKey, "解析不到 FONT_KEY 的当前值，判据本身已失效");
  const picked = "'JetBrains Mono', Consolas, monospace";

  const boot = runBootScript({ systemDark: false, extra: { [fontKey]: picked } });
  const wrote = applyThemeWrites(picked);
  assert.equal(
    boot.style["--gosslan-font-family"],
    wrote["--gosslan-font-family"],
    `首屏脚本与 applyTheme 写的字体不一致：脚本=${String(boot.style["--gosslan-font-family"])} store=${String(wrote["--gosslan-font-family"])}`,
  );
  assert.equal(boot.style["--gosslan-font-family"], picked, "两边都该把用户选的字体原样写成内联");

  const bootEmpty = runBootScript({ systemDark: false, extra: { [fontKey]: "" } });
  const cleared = applyThemeWrites("");
  assert.ok(!("--gosslan-font-family" in bootEmpty.style), "默认档（空串）时首屏脚本不该自造一份兜底栈");
  assert.equal(
    cleared["--gosslan-font-family"],
    null,
    "默认档 applyTheme 必须清掉内联让 style.css 的 token 生效 —— JS 里再抄一份兜底栈就是第三个家",
  );
});

// §6.82：首屏脚本那五枚键从"整块外层 try"改成**逐键兜底**之后的行为契约。
test("★某一枚键抛错只许带走它自己：主色/字体/语言必须照样落地", () => {
  const keys = scanProductionSources().keys;
  const themeKey = keys.get("THEME_KEY")?.value;
  const fontKey = keys.get("FONT_KEY")?.value;
  const localeKey = keys.get("STORAGE_KEY")?.value;
  assert.ok(themeKey && fontKey && localeKey, `解析不到键名（theme=${themeKey} font=${fontKey} locale=${localeKey}），判据本身失效`);
  // 抛的是**第一枚**（外观）：外层 try 的写法在这里会让后面三件事全不做 ⇒ 这条当场红。
  const r = runBootScript({
    systemDark: false,
    throwKeys: [APPEARANCE_STORAGE_KEY],
    extra: { [themeKey]: "#123456", [fontKey]: "monospace", [localeKey]: "zh-CN" },
  });
  assert.equal(r.dark, false, "外观读不到时按浅色（不许猜成深色）");
  assert.equal(r.style["--gosslan-primary"], "#123456", "主色不许被外观那一枚的抛错带走");
  assert.equal(r.style["--gosslan-font-family"], "monospace", "字体不许被外观那一枚的抛错带走");
  assert.equal(r.lang, "zh-CN", "首帧语言不许被外观那一枚的抛错带走");
});

/**
 * ★§6.87：默认档要问 matchMedia，所以它一抛/一缺席，**旧形状会把后面四件事一起带走**。
 *
 * 这是 §6.82 只修了一半的那一半：五枚键改成逐键兜底之后，外层那圈 try 仍然罩着
 * matchMedia / navigator / document.title / classList，而 `mode` 的默认值是 system ⇒
 * 从没在设置里选过亮暗的用户（也就是大多数首帧）恰好要走那条会抛的分支。
 * 症状是"深色没闪，但整屏出厂蓝 + 系统字体 + 英文标题 + 38px 骨架标题栏"，且没有任何一层报错。
 *
 * ⚠️ 最后那个正控是必须的：没有它，"matchMedia 不可用 ⇒ 什么都不做"这种把四件事一起关掉的
 *    写法也能让前面三句全绿（与 §6.79 反向那格同一课）。
 */
test("★matchMedia 抛错或不存在时，主色/字体/语言必须照样各自落地（旧形状是一抛全跳）", () => {
  const { keys } = scanProductionSources();
  const themeKey = keys.get("THEME_KEY")?.value;
  const fontKey = keys.get("FONT_KEY")?.value;
  assert.ok(themeKey && fontKey, "没从源码解析到 THEME_KEY / FONT_KEY，判据本身失效");
  for (const how of [true, "missing"] as const) {
    const label = how === true ? "抛错" : "压根不存在";
    const r = runBootScript({
      systemDark: true,
      matchMediaThrows: how,
      extra: { [themeKey]: "#123456", [fontKey]: "serif" },
    });
    assert.equal(r.style["--gosslan-primary"], "#123456", `matchMedia ${label}时主色必须照样落地`);
    assert.equal(r.style["--gosslan-font-family"], "serif", `matchMedia ${label}时字体必须照样落地`);
    assert.ok(r.lang === "zh-CN" || r.lang === "en-US", `matchMedia ${label}时语言仍要给一个（读不到就按兜底档）`);
    assert.equal(r.dark, false, `matchMedia ${label}时按浅色 —— 问不到就不许瞎猜深色`);
  }
  // 正控：可用时仍要跟随系统深色，否则"全关掉"就能骗过上面那四句。
  const ok = runBootScript({ systemDark: true, extra: { [themeKey]: "#123456" } });
  assert.equal(ok.dark, true, "matchMedia 可用时 system 档必须仍然点亮 dark");
  assert.equal(ok.style["--gosslan-primary"], "#123456");
});
