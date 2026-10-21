import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { zhCN, enUS } from "./locales.ts";
import {
  applyPreference,
  currentLocale,
  currentPreference,
  detectSystemLocale,
  isLanguagePreference,
  isLocale,
  refreshSystemLocale,
  t,
} from "./index.ts";

// ---------------- 字典护栏：中英 key 必须一一对应（漏翻译会被逮到） ----------------

test("zh-CN 与 en-US 的 key 集合完全一致（防漏翻译）", () => {
  const zh = Object.keys(zhCN).sort();
  const en = Object.keys(enUS).sort();
  const onlyZh = zh.filter((k) => !enUS[k]);
  const onlyEn = en.filter((k) => !zhCN[k]);
  assert.deepEqual(onlyZh, [], `仅中文有、英文缺失的 key：${onlyZh.join(", ")}`);
  assert.deepEqual(onlyEn, [], `仅英文有、中文缺失的 key：${onlyEn.join(", ")}`);
});

test("字典值非空（不允许空字符串占位）", () => {
  for (const [k, v] of Object.entries(zhCN)) assert.ok(v.length > 0, `zh-CN ${k} 为空`);
  for (const [k, v] of Object.entries(enUS)) assert.ok(v.length > 0, `en-US ${k} 为空`);
});

// ---------------- 调用点护栏：t() 引用的 key 必须真的存在 ----------------

/**
 * 扫全仓 `t("...")` / `t('...')` **字面量**调用点，要求每个 key 都在中英词典里命中。
 *
 * ## 为什么必须守（真实缺陷，2026-10-03 审计）
 * `settings/StorageSection.vue` 的自动删除确认弹窗标题写的是 `t('settings.storage.limit')`，
 * 而这个 key **在中英两个词典里都不存在** —— `t()` 的回落是 `dict.value[key] ?? key`
 * （`index.ts:93`），于是破坏性确认弹窗的标题直接显示字面量 `settings.storage.limit`。
 * 同文件正文用的 `settings.storage.confirm.body` **是存在的**，说明是漏了一条而不是有意为之。
 *
 * 上面那两条字典护栏抓不到它：它们只查「中英 key 集合互相一致」和「值非空」，
 * 对**调用点引用了不存在的 key** 完全无感 ⇒ 假绿。
 *
 * ## 为什么只查字面量、为什么跳过测试文件
 * 存在 `t(\`prefix.${kind}\`)` 这类模板字符串调用（见本文件下方「中继探测档位」那条用例），
 * 静态扫不出它展开后的全部 key。这类调用由各自的专项用例钉住
 * （例如 relay.rs 的 `as_str` ↔ TS 联合类型 ↔ 两种语言那条三向断言）。
 * **静默漏报比误报危险**，所以模板字符串一律跳过、不算失败。
 *
 * `.test.ts` 整个跳过：测试**本来就要**引用不存在的 key 来验回落
 * （本文件下方 `t("no.such.key")` 与 storeContract 的正则夹具都靠它）。
 * 扫它们得到的红是假的，而假红会让人养成"先加白名单再跑"的习惯 —— 那比漏报更危险。
 */
test("所有 t() 字面量调用点的 key 都存在于中英词典（防裸 key 上屏）", () => {
  const root = join(import.meta.dirname, "../..");
  /** @type {{file: string, text: string}[]} */
  const files: { file: string; text: string }[] = [];
  const skipDirs = new Set(["node_modules", "dist", "target", ".git", ".workbuddy", "test-results"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      // .vue 的模板里 t() 写在属性里，脚本写在 setup 里 —— 两种都要扫。
      // 测试文件跳过（理由见上方注释）。
      else if (/\.(?:vue|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        files.push({ file: p, text: readFileSync(p, "utf8") });
      }
    }
  };
  walk(join(root, "src"));

  // `t("x.y")` / `t('x.y')`，带或不带第二参数都算
  const CALL = /\bt\(\s*(["'])([a-z][\w]*(?:\.[\w]+)+)\1/g;
  const missing: string[] = [];
  let scanned = 0;
  for (const { file, text } of files) {
    for (const m of text.matchAll(CALL)) {
      const key = m[2];
      scanned++;
      for (const [name, dict] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
        if (!dict[key]) missing.push(`${name} 缺 ${key}（${file.slice(root.length + 1)}）`);
      }
    }
  }

  // 扫描本身要先确认有效：一条都扫不到 ⇒ 正则失配或目录搬了，这条护栏就成了空转
  assert.ok(scanned > 50, `只扫到 ${scanned} 个 t() 调用点，护栏本身失效了（正则或目录变了？）`);
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    `t() 引用了不存在的 key ⇒ 界面上会显示裸 key：\n${[...new Set(missing)].join("\n")}`,
  );
});

// ---------------- 反向护栏：词典里不留「全仓引不到」的死文案 ----------------
/**
 * 引用面用的字面量提取器：把一条源码里出现的字符串字面量抠出来。
 *
 * ⚠️ **三种引号各扫一遍**，不是"任一起任一种收尾"的合成一条。两版都踩过：
 * · 合成版会把 `:title="t('logs.title')"` 里那个 `'` 当成外层 `"` 的收尾吃掉；
 * · 只认同种引号成对的单遍版仍漏 —— 它扫到 `"t('logs.title')"` 整条后从**闭合引号
 *   之后**继续走，被它包住的那对 `'…'` 永远不会再成为一次"起"。
 * 分引号各扫一遍才吃得到**嵌套**：本仓模板里 `:aria-label="t('nav.me.online')"` 这类
 * 外层双引号属性裹内层单引号 key 是主流写法，漏了就是把**在用的文案**判成死文案。
 * 每一遍都不跨行（`[^…]` 里排除换行），`\\.` 放行转义引号；每种引号内部允许出现
 * 别的引号，所以会产生一些拼出来的假字面量 —— 假字面量只会让 key 显得"还在用"，
 * 方向是安全的（这条宁可漏杀，不可误杀）。
 */
const QUOTES = ['"', "'", "`"] as const;
const literalsIn = (src: string): string[] => {
  const out: string[] = [];
  for (const q of QUOTES) {
    // 内容：不许出现该引号本身、不许换行、不许裸反斜杠；`\\.` 让 `\"` 这种转义过关
    const re = new RegExp(`${q}((?:\\\\.|[^${q}\\\\\n]){2,240})${q}`, "g");
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
};

test("死文案量具的引用面夹具：嵌套引号里的 key 也必须抠得出来", () => {
  // 正控 —— 只被外层双引号属性包住的那一条：单遍扫描永远扫不到它（扫完外层已经从闭引号后走开了），
  // 认不出就是把**在用的**文案判成死文案。本仓主流写法：:aria-label="t('nav.me.online')"
  const onlyNested = literalsIn(`<v-btn :aria-label="t('nav.me.online')" />`);
  assert.ok(
    onlyNested.includes("nav.me.online"),
    `嵌套单引号里的 key 没进引用面（会误杀在用文案）：${JSON.stringify(onlyNested)}`,
  );
  assert.deepEqual(literalsIn(`ct(zo, "group.toast.nameEmpty", fallback)`), ["group.toast.nameEmpty"]);
  assert.deepEqual(literalsIn("const k = `favorite.cardKind.${k}`;"), ["favorite.cardKind.${k}"]);
  // 反控 —— 不许跨行连坐（跨行模板不该把后面几百行吃成一条"字面量"）
  assert.deepEqual(literalsIn('const s = `x.y\n  z.w`;'), []);
});

/**
 * 上面那条判据查的是「调用点 → 词典」（引了不存在的 key ⇒ 裸 key 上屏）。这一条查反向：
 * 「词典 → 调用点」—— 定义了、但全仓再也引不到的文案。
 *
 * 为什么值得守：本批删掉 **41 条**，来源全是改名与删功能留下的尾巴（字号五档一度从
 * `settings.chatStyle.fontSize.*` 改叫 `chatStyle.fontSize.*`，旧那 5 条留在册子里没人删；
 * `diag.*` 里 5 条是那块面板删过行）。它们不影响运行，但**每条都要在中英两册各占一行**，
 * 于是"这条还在用吗"从此没有答案 —— 词典越留越不敢删。
 *
 * 口径（三条都是为了不误杀，别改回去）：
 * 1. **引用面 = 全仓任意字符串字面量**，不限 `t(...)` 调用点。把 key 放进查表常量再交给
 *    `t()` 是本仓真写法（`ct(zo, "group.toast.nameEmpty", …)`、`return "diag.notCompiled"`），
 *    只扫 `t("…")` 会把它们判成死文案。
 * 2. **模板与拼接前缀算可达**：真动态点是 `t(\`favorite.cardKind.${"${"}active.kind}\`)` 与
 *    `t("search.date." + f)` 这一族 ⇒ 任何以 `.` 结尾的字面量、以及模板里 `${` 之前那段都按
 *    前缀展开。⚠️ 这段注释**原先举的例子是 `diag.${…}`**，于是判据自己的文档造出了一个
 *    `diag.` 前缀，把整族 `diag.*` 全洗白 —— 注释里的字面量也算引用面，量具会读自己的说明。
 *    已知边界：前缀规则偏松，`mu${seq}` 那种非 i18n 拼接同样留下前缀。本批 41 条里有 8 条
 *    （`chat.selfChat`、`chat.selfChatHint`、`multi.forward`、`diag.networkStatus/name/
 *    selected/lanPeers/btInterval`）就是被这种垃圾前缀判成"可达"的，逐条按**精确引号**复核
 *    全仓 0 引用才删。⇒ 方向是漏杀不误杀，删文案仍要自己复核。
 * 3. **测试码也进引用面**（与上一条判据刻意相反）：上一条必须跳过测试才容得下
 *    `t("no.such.key")` 那种回落夹具；这一条问的是"还有没有任何东西需要它"，
 *    只有测试在引的 key 删掉会红在测试上 ⇒ 按"仍在用"处理。
 *    注释里的字面量同样算引用面 —— 这条宁可漏杀，不可误杀。
 */
test("词典里不留全仓引不到的死文案（反向：定义了却没人用）", () => {
  const root = join(import.meta.dirname, "../..");
  const skipDirs = new Set(["node_modules", "dist", "target", ".git", ".workbuddy", "test-results"]);
  const lits = new Set<string>();
  const prefixes: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(?:vue|ts)$/.test(e.name)) continue;
      // 两册词典自己不算引用面（那里每个 key 都是字面量）
      if (/i18n[\\/]locales/.test(p)) continue;
      for (const s of literalsIn(readFileSync(p, "utf8"))) {
        lits.add(s);
        if (s.endsWith(".")) prefixes.push(s);
        const cut = s.indexOf("${");
        if (cut > 1) prefixes.push(s.slice(0, cut));
      }
    }
  };
  walk(join(root, "src"));

  // 只查 zhCN：中英 key 集合一致由上面那条判据保证，两册不可能一边死一边活。
  const dead = Object.keys(zhCN).filter(
    (k) => !lits.has(k) && !prefixes.some((p) => p.length > 1 && k.startsWith(p)),
  );
  assert.deepEqual(
    dead,
    [],
    `中英两册里留了全仓引不到的死文案（每条各占两行，改名/删功能留下的尾巴）：\n${dead.join("\n")}`,
  );
  // 扫描有效性下限：词典与引用面都必须真扫到东西，否则"0 条"是空扫出来的
  assert.ok(Object.keys(zhCN).length >= 900, `只读到 ${Object.keys(zhCN).length} 条 key ⇒ 量具失效`);
  assert.ok(lits.size >= 700, `引用面只扫到 ${lits.size} 个字面量 ⇒ 量具失效（目录或正则变了？）`);
  console.log(
    `· 死文案护栏：词典 ${Object.keys(zhCN).length} 键 / 引用面 ${lits.size} 个字面量 / `
      + `可达前缀 ${new Set(prefixes).size} 个 / 死文案 0`,
  );
});

// ---------------- 系统语言检测（纯函数） ----------------

test("detectSystemLocale：zh* → 中文，en* → 英文，非中英 → 英文", () => {
  assert.equal(detectSystemLocale(["zh-CN"]), "zh-CN");
  assert.equal(detectSystemLocale(["zh-Hans-CN"]), "zh-CN");
  assert.equal(detectSystemLocale(["zh-TW"]), "zh-CN");
  assert.equal(detectSystemLocale(["en-US"]), "en-US");
  assert.equal(detectSystemLocale(["en-GB", "zh-CN"]), "en-US"); // 第一个命中 en
  assert.equal(detectSystemLocale(["ja-JP", "en-US"]), "en-US");
  assert.equal(detectSystemLocale(["ja-JP"]), "en-US"); // 非中英回落英文
  assert.equal(detectSystemLocale(["zh-CN", "en-US"]), "zh-CN"); // 第一个命中 zh
  assert.equal(detectSystemLocale([]), "en-US");
  assert.equal(detectSystemLocale([undefined, null, "zh-CN"]), "zh-CN");
});

// ---------------- t() 翻译与插值 ----------------

test("默认跟随系统：没有 navigator 时回落英文", () => {
  // ⚠️ 必须**真的**构造出"没有 navigator"的环境（用户 2026-09-17）：
  //   · Node ≥21 **自带全局 `navigator`**（本机 language === "zh-CN"），所以原测试名里
  //     "node 环境无 navigator" 这个前提早已不成立 —— 它只是**恰好**在 en-US 的机器
  //     （含 CI runner）上通过，而中文开发者本地必红。假绿把这条契约缺陷藏了很久。
  //   · 另：`applyPreference("system")` 并**不**重解析系统语言（重解析在
  //     `refreshSystemLocale`）。原测试靠"模块加载那一刻恰好没有 navigator"间接成立，
  //     这里显式重解析一次，才是在测它声称要测的东西。
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
  try {
    applyPreference("system");
    refreshSystemLocale();
    assert.equal(currentPreference(), "system");
    assert.equal(t("nav.chats"), "Chats");
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    refreshSystemLocale(); // 别把"无 navigator"的环境泄漏给后面的用例
  }
});

test("显式中文翻译", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats"), "聊天");
  assert.equal(t("settings.title"), "设置");
});

test("切换英文后立即生效", () => {
  applyPreference("en-US");
  assert.equal(t("nav.chats"), "Chats");
  assert.equal(t("settings.title"), "Settings");
});

test("插值：{n} 等占位符被替换", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats.unread", { n: 3 }), "聊天，3 条未读");
  applyPreference("en-US");
  assert.equal(t("nav.chats.unread", { n: 3 }), "Chats, 3 unread");
});

test("缺 key 回退为 key 本身（不抛错、不显示 undefined）", () => {
  assert.equal(t("no.such.key"), "no.such.key");
});

test("插值参数缺失时占位符保留原文", () => {
  applyPreference("zh-CN");
  assert.equal(t("nav.chats.unread"), "聊天，{n} 条未读");
});

// ---------------- 跟随系统：refreshSystemLocale 重解析 ----------------

function withNavigator(langs: string[], fn: () => void) {
  const saved = (globalThis as Record<string, unknown>).navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { languages: langs, language: langs[0] },
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    if (saved === undefined) delete (globalThis as Record<string, unknown>).navigator;
    else Object.defineProperty(globalThis, "navigator", { value: saved, configurable: true, writable: true });
  }
}

test("跟随系统：系统语言变化后重解析生效", () => {
  applyPreference("system");
  withNavigator(["zh-CN"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "zh-CN");
    assert.equal(t("nav.chats"), "聊天");
  });
  withNavigator(["en-US"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "en-US");
    assert.equal(t("nav.chats"), "Chats");
  });
  applyPreference("zh-CN"); // 还原
});

test("显式偏好不受系统语言变化影响", () => {
  applyPreference("zh-CN");
  withNavigator(["en-US"], () => {
    refreshSystemLocale();
    assert.equal(currentLocale(), "zh-CN");
  });
  applyPreference("zh-CN");
});

// ---------------- 校验 ----------------

test("isLocale 只认两种合法语言", () => {
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("en-US"), true);
  for (const v of ["", "en", "中文", "zh", null, undefined, 1]) {
    assert.equal(isLocale(v), false, `${String(v)} 不应判为合法语言`);
  }
});

test("isLanguagePreference 认三态", () => {
  for (const v of ["system", "zh-CN", "en-US"]) {
    assert.equal(isLanguagePreference(v), true, `${v} 应为合法偏好`);
  }
  for (const v of ["", "auto", "en", null, undefined, 1]) {
    assert.equal(isLanguagePreference(v), false, `${String(v)} 不应判为合法偏好`);
  }
});

test("currentPreference / currentLocale 反映最近一次 applyPreference", () => {
  applyPreference("en-US");
  assert.equal(currentPreference(), "en-US");
  assert.equal(currentLocale(), "en-US");
  applyPreference("zh-CN");
  assert.equal(currentLocale(), "zh-CN");
});

/**
 * 启动时必须把**解析后**的语言推给后端。
 *
 * 为什么必须守（用户 2026-09-16 实测「加群的提示怎么是英文？」）：
 * 后端自己生成的文案（群成员变更 / 文件下载 / 托盘提示 / 窗口标题）都按 `AppState::is_zh()`
 * 选语言，而「跟随系统」的解析规则（`navigator.language`）**只在前端有一份**，
 * 后端的兜底（`LANG` 等 POSIX 环境变量）在 Windows 上恒为「否」。
 * 所以「前端启动时推一次」是这条链路的**唯一**入口：漏了它，默认设置（跟随系统）的中文用户
 * 会把所有后端文案看成英文，而界面本身是中文 —— 这类"两边不一致"只有真机才看得见。
 */
test("app.init() 必须把解析后的语言推给后端（后端系统消息文案依赖它）", () => {
  const store = readFileSync(
    join(import.meta.dirname, "..", "stores", "useAppStore.ts"),
    "utf8",
  );
  const start = store.indexOf("async function init()");
  assert.ok(start > 0, "找不到 app store 的 init()");
  // 截出 init 的函数体：到下一个同级函数声明（缩进两空格的 `function` / `async function`）为止
  const rest = store.slice(start);
  const next = rest.slice(1).search(/\n {2}(?:async )?function /);
  const body = next > 0 ? rest.slice(0, next + 1) : rest;
  assert.match(
    body,
    /pushUiLanguage\(\)/,
    "init() 里必须调用 pushUiLanguage()：否则「跟随系统」（默认）的用户，后端永远不知道界面是中文，\n" +
      "群成员变更 / 文件下载等系统消息会显示英文（Rust 侧的 is_zh() 详见 state.rs 的 resolve_is_zh）。",
  );
});

// ---------------- 后端机器可读枚举 ↔ 界面文案 ----------------

/**
 * 中继探测的三档结论（`unreachable` / `rejected` / `held`）是**按串取文案**的：
 * `t(\`settings.network.relayServer.probe.${kind}\`)`。所以两头任一漂移都会变成
 * "那一档什么都不显示" —— 而它是三档里唯一告诉用户"配置是对的、问题在对方"的那一档。
 *
 * 这条断言把三件事钉在一起：Rust 的 `as_str` 产出的串、TS 里的联合类型、两种语言的键。
 * 任何一处改名，这里必须红（不是"少一行翻译"那么轻）。
 */
test("中继探测档位的三个名字在 Rust / TS / 两种语言里是同一套", () => {
  const root = join(import.meta.dirname, "../..");
  const rust = readFileSync(join(root, "src-tauri/src/network/transport/relay.rs"), "utf8");
  // `Self::Held => "held"` 这种臂，只在 `as_str` 那个 match 里出现
  const asStr = rust.slice(rust.indexOf("pub fn as_str"));
  const kinds = [...asStr.matchAll(/Self::\w+\s*=>\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(kinds.length >= 3, `没从 Rust 里扫到档位串，护栏要失效了：${kinds}`);

  const tsTypes = readFileSync(join(root, "src/types.ts"), "utf8");
  const iface = tsTypes.slice(tsTypes.indexOf("export interface RelayProbe"));
  const union = [...iface.matchAll(/kind:\s*"([a-z_|"\s]+)"/g)][0][1];
  const tsKinds = union.split("|").map((s) => s.replace(/["\s]/g, "")).filter(Boolean).sort();
  assert.ok(tsKinds.length >= 3, `RelayProbe.kind 的联合类型没解析出来：${iface.slice(0, 80)}`);

  // TS 侧必须是 Rust 侧的子集（Rust 多出来的档位 = 前端不会遇到的分支，允许）
  for (const k of tsKinds) {
    assert.ok(kinds.includes(k), `前端声明了 Rust 不产生的档位：${k}`);
    for (const [name, dict] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
      assert.ok(
        dict[`settings.network.relayServer.probe.${k}`],
        `${name} 缺 settings.network.relayServer.probe.${k} —— 界面上那一档会变成空白`,
      );
    }
  }
});
