import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISABLED_CONTRAST_CONTRACT,
  TOKEN_CONTRAST_CONTRACT,
  auditDisabledContrast,
  disabledOpacityFromClasses,
  disabledOpacityFromRule,
  findTokenContrastFailures,
  findTokenContrastUnresolved,
  parseTokenScopes,
  resolveToken,
} from "./tokenContrast.ts";

// ---------------- 检查器自身：故意写坏的 CSS 必须被抓住 ----------------
//
// 先证明"尺子准"，再用它量真实样式表。否则护栏可能是永远绿的摆设。

const BROKEN = `
:root {
  --gosslan-text-2: #64748b;
  --gosslan-panel: #ffffff;
  --gosslan-list: #f1f5f9;
  --gosslan-chat: #fafafa;
  --gosslan-card: #eeeef0;
  --gosslan-text: #0f172a;
  --gosslan-list-active: #dbe3ed;
  --gosslan-list-active-text: var(--gosslan-text);
  --gosslan-accent-ink: #2d6099;
  --gosslan-success-ink: #047857;
  --gosslan-danger-ink: #ff3b30;
  --gosslan-warning-ink: #ff9500;
  --gosslan-status-offline: #a3a3a3;
  --gosslan-danger-soft: rgba(255, 59, 48, 0.12);
  --gosslan-hud: rgba(38, 38, 38, 0.9);
}
.dark {
  --gosslan-text-2: #94a3b8;
  --gosslan-panel: #1e293b;
  --gosslan-list: #1e293b;
  --gosslan-chat: #0f172a;
  --gosslan-card: #1c2434;
  --gosslan-text: #f1f5f9;
  --gosslan-list-active: #334155;
  --gosslan-list-active-text: var(--gosslan-text);
  --gosslan-accent-ink: #8fb3ea;
  --gosslan-success-ink: #30d158;
  --gosslan-danger-ink: #ff5548;
  --gosslan-warning-ink: #ff9f0a;
  --gosslan-status-offline: #8e8e93;
  --gosslan-danger-soft: rgba(255, 85, 72, 0.18);
  --gosslan-hud: rgba(72, 72, 74, 0.92);
}
`;

test("检查器能抓出「改回旧值」的四处违规", () => {
  const fails = findTokenContrastFailures(BROKEN);
  const keys = fails.map((f) => `${f.fg} on ${f.bg}`);
  // 亮色：次要文字（卡片/列表底）、危险色当文字、琥珀当图标、离线点
  assert.ok(keys.includes("--gosslan-text-2 on --gosslan-card"), `未抓到 text-2/card：${keys.join(", ")}`);
  assert.ok(keys.includes("--gosslan-text-2 on --gosslan-list"), "未抓到 text-2/list");
  assert.ok(keys.includes("--gosslan-danger-ink on --gosslan-panel"), "未抓到 danger 当文字");
  assert.ok(keys.includes("--gosslan-warning-ink on --gosslan-panel"), "未抓到 warning 当图标");
  assert.ok(keys.includes("--gosslan-status-offline on --gosslan-panel"), "未抓到离线点");
  for (const f of fails) assert.ok(f.ratio < f.min, "报出的组合必须确实不达标");
});

test("var() 链会被解析（list-active-text 指向 text）", () => {
  const { light } = parseTokenScopes(BROKEN);
  assert.equal(light.get("--gosslan-list-active-text"), "var(--gosslan-text)");
  // 解析到 --gosslan-text 的实值，而不是把 "var(...)" 当成颜色
  const resolved = resolveToken("--gosslan-list-active-text", light);
  assert.ok(resolved, "应能解析 var() 链");
  assert.equal(`${resolved.r},${resolved.g},${resolved.b}`, "15,23,42");
});

test("color-mix 派生的 hover 档要参与计算：朝白混必须报红，朝暗混才放行", () => {
  // 这条夹具是"尺子自己"的判据。以前解析器认不出 color-mix 就返回 null，
  // findTokenContrastFailures 把 null 当"判不了"跳过 ⇒ 「红底 hover 变浅、白字更看不见」
  // 这一整类漂移是静默漏判的（护栏看着绿，其实那一行什么都没读）。
  const shape = (mixTo: string) => `
:root {
  --gosslan-primary-active: #0a4bb5;
  --gosslan-danger: #d43d43;
  --gosslan-danger-hover: color-mix(in srgb, var(--gosslan-danger) 88%, ${mixTo});
}
`;
  const hoverFails = (mixTo: string) =>
    findTokenContrastFailures(shape(mixTo)).filter((f) => f.bg === "--gosslan-danger-hover");

  const towardWhite = hoverFails("#ffffff");
  // 2 而不是 1：暗色作用域现在叠在 :root 上解析（这份夹具没有 .dark 块，
  // 于是暗色继承亮色的那三行），同一个"hover 朝白混"的缺陷两档外观各报一次。
  // 计数从 1 涨到 2 是**变强**，不是放宽 —— 以前暗色那一行根本没被算过。
  assert.equal(towardWhite.length, 2, "hover 朝白混 = 白字更看不见，两档外观都必须报红而不是被跳过");
  for (const f of towardWhite) {
    assert.ok(f.ratio < 4.5, `报出的红要带真实比值，实际 ${f.theme} ${f.ratio}`);
  }
  assert.deepEqual(
    towardWhite.map((f) => f.theme).sort(),
    ["dark", "light"],
    "必须亮/暗各一条（只有亮色在报 = 暗色那行又被跳过了）",
  );

  const towardBlack = hoverFails("#000000");
  assert.equal(towardBlack.length, 0, "hover 朝暗混 = 对比度只升不降，不该报红");
});

test("注释里出现的 `.dark {` 不会把作用域解析带偏", () => {
  // 真实踩过：:root 的注释里写着「暗色版本不能靠 `.dark { --gosslan-primary: … }` 覆盖」，
  // 朴素的 indexOf(".dark {") 会先匹配到这句注释，于是 dark 解析到的是 :root 的内容。
  const cssWithComment = `
:root {
  /* 说明：.dark { --gosslan-primary: … } 不会生效（inline 优先级更高） */
  --gosslan-text-2: #475569;
  --gosslan-panel: #ffffff;
}
.dark {
  --gosslan-text-2: #94a3b8;
  --gosslan-panel: #1e293b;
}
`;
  const { light, dark } = parseTokenScopes(cssWithComment);
  assert.equal(light.get("--gosslan-panel"), "#ffffff");
  assert.equal(dark.get("--gosslan-panel"), "#1e293b", "dark 必须解析到真正的 .dark 块");
  assert.equal(dark.get("--gosslan-text-2"), "#94a3b8");
});

// ---------------- 真实样式表：契约必须全绿 ----------------

const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");

test("style.css 的配色契约全部达标", () => {
  const fails = findTokenContrastFailures(css);
  const detail = fails
    .map((f) => `${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)} < ${f.min}（${f.why}）`)
    .join("\n");
  assert.deepEqual(fails.map((f) => `${f.fg}/${f.bg}`), [], `存在不达标组合：\n${detail}`);
});

test("新增的 *-ink 档在 :root 与 .dark 都成对定义", () => {
  // 漏写 .dark 会让暗色继承亮色的档位 —— 方向正好反了（曾经踩过 accent-ink 这个坑）
  const { light, dark } = parseTokenScopes(css);
  const lightOnly = [...light.keys()].filter((k) => k.endsWith("-ink"));
  assert.ok(lightOnly.length >= 4, `应至少 4 个 -ink token，实际 ${lightOnly.length}`);
  for (const k of lightOnly) {
    assert.ok(dark.has(k), `${k} 在 .dark 里缺少定义`);
    assert.notEqual(light.get(k), dark.get(k), `${k} 两种外观同值，可能忘了按外观调明度`);
  }
});

test("亮色语义色的实际取值（钉住本次审计结论）", () => {
  const { light } = parseTokenScopes(css);
  assert.equal(light.get("--gosslan-text-2"), "#475569", "次要文字应为 Slate-600");
  assert.equal(light.get("--gosslan-danger-ink"), "#cc2418");
  assert.equal(light.get("--gosslan-warning-ink"), "#c67600");
  assert.equal(light.get("--gosslan-status-offline"), "#8e8e93");
  // 填充档：承担白字的那一族（danger）必须过 4.5，所以它**不**保持系统色
  // （#ff3b30 白字只有 3.55 ⇒ 2026-09-26 压深到 #d43d43 = 4.62）；
  // 不承担白字的填充（warning 橙，只当图标/进度条底）仍保持 Apple 系统色。
  assert.equal(light.get("--gosslan-danger"), "#d43d43");
  assert.equal(light.get("--gosslan-warning"), "#ff9500");
});

test("契约表两种外观都非空且最低标准合法", () => {
  for (const theme of ["light", "dark"] as const) {
    assert.ok(TOKEN_CONTRAST_CONTRACT[theme].length >= 10, `${theme} 契约条目过少`);
    for (const p of TOKEN_CONTRAST_CONTRACT[theme]) {
      assert.ok(p.min === 4.5 || p.min === 3.0, `${p.fg}/${p.bg} 的 min 不在 4.5(文字)/3.0(非文字) 两档`);
      assert.ok(p.why.length > 0, `${p.fg}/${p.bg} 缺少 why 说明`);
    }
  }
});

test("真实 style.css：契约表的每一行都必须算得出颜色（不许静默跳过）", () => {
  // 这一条是"尺子自己"的判据，专防本文件头注释点名的那个失败形状：
  // 解析不出 ⇒ `continue` ⇒ 护栏全绿而那一行什么都没读。暗色那一档以前整批踩在这上面
  // （`.dark` 单独解析时看不到 `:root` 里的 `--gosslan-primary`，
  //  凡是由它派生的 accent-ink / primary-active 三行都算不出颜色）。
  const unresolved = findTokenContrastUnresolved(css);
  assert.deepEqual(
    unresolved.map((u) => `${u.theme}:${u.fg} on ${u.bg}`),
    [],
    `这些组合在真实 CSS 里算不出颜色，等于没被检查：\n${unresolved
      .map((u) => `  ${u.theme}  ${u.fg} on ${u.bg}（${u.why}）`)
      .join("\n")}`,
  );
});

// ---------------- 用户可选的强调色：把 inline 主色当成变量扫一遍 ----------------
//
// 为什么要单独立一条：`--gosslan-primary` 由 applyTheme 以 **inline style** 写在 <html> 上，
// 值不在 style.css 里 ⇒ 上面那条"真实 style.css 全绿"只量到了**出厂蓝**那一档。
// 而设置页让用户在 6 个色板里挑（AppearanceSection.vue 的 presets），
// style.css 的注释又拿着"六套预置主题色实测 …"当结论 —— 那个结论必须有机器凭据。
//
// 做法不引入第二份实现：把 :root 里那行主色声明**逐字换成候选色**，再交给同一个
// findTokenContrastFailures。非 accent 相关的行不受影响（它们不引用主色），
// 所以整表重算不会引入噪音。

/** 色板的唯一来源是设置组件；这里现解析，不抄清单（抄一份就会漂）。 */
function accentSwatches(): string[] {
  const src = readFileSync(
    join(import.meta.dirname, "..", "components", "settings", "AppearanceSection.vue"),
    "utf8",
  );
  const m = /const presets = \[([^\]]*)\]/.exec(src);
  assert.ok(m, "AppearanceSection.vue 里找不到 `const presets = [...]`（色板搬家了要同步这条判据）");
  const list = [...m[1].matchAll(/"(#[0-9a-fA-F]{3,6})"/g)].map((x) => x[1]);
  // 下限：解析式判据最怕"正则没命中 ⇒ 空数组 ⇒ 循环一格不跑 ⇒ 全绿"。
  assert.ok(list.length >= 4, `色板至少 4 个才说明真的解析到了，实际 ${list.length}：${list.join(" ")}`);
  return list;
}

const withPrimary = (hexColor: string): string => {
  const next = css.replace(/(--gosslan-primary\s*:\s*)#[0-9a-fA-F]{3,6}(;)/, `$1${hexColor}$2`);
  // ⚠️ 不能断言"文本变了"：色板第一个就是出厂蓝本身，换成它当然是零改动 ——
  // 第一版这样写，于是扫描在**第一个候选**上就炸了。要断言的是"结果里这一行确实是这个色"。
  assert.ok(
    next.includes(`--gosslan-primary: ${hexColor};`),
    `主色声明没落成的 ${hexColor} 那一份 ⇒ 这条扫描在空转（:root 里那行的写法变了？）`,
  );
  return next;
};

/**
 * 已知偏差（实测值 = 本条记录时的那个数，作为**下限**钉住）。
 *
 * 清单的作用是让缺口**不能被继续放大**：任一条比记录值更差 ⇒ 红；
 * 某条被修好了 ⇒ 它不再出现在实测集合里，本条判据要求把它从清单删掉。
 *
 * 2026-10-23 这一节第一次跑出来时有 7 条：填充档 `--gosslan-primary-active` 在
 * 绿/橙/天蓝三档上只有 3.61/3.83/3.76（明暗同值 ⇒ 那本来就是暗色合流解析修复的旁证），
 * 已按拍板把混黑从 15% 提到 28%（实测六档最低升到 4.85）全部修掉并从本清单删除。
 * 剩下这一条是 accent-ink 差 0.07：绿档主题色当文字用、落在会话列表底上。
 * 它不在同一次拍板范围内（要动 `--gosslan-accent-ink` 的混法，会影响全站链接/选中态），
 * 且只差 0.07，留作已知偏差。
 */
const KNOWN_SUB_AA: Array<{ theme: string; accent: string; fg: string; bg: string; floor: number }> = [
  { theme: "light", accent: "#00b578", fg: "--gosslan-accent-ink", bg: "--gosslan-list", floor: 4.43 },
];

test("六套可选主色 × 亮/暗：accent 派生档的对比度逐档核算（含已知偏差棘轮）", () => {
  const swatches = accentSwatches();
  const measured = new Map<string, number>();
  for (const accent of swatches) {
    for (const f of findTokenContrastFailures(withPrimary(accent))) {
      measured.set(`${f.theme}|${accent}|${f.fg}|${f.bg}`, f.ratio);
    }
  }
  const actualKeys = [...measured.keys()].sort();
  const expectedKeys = KNOWN_SUB_AA
    .map((k) => `${k.theme}|${k.accent}|${k.fg}|${k.bg}`)
    .sort();
  assert.deepEqual(
    actualKeys,
    expectedKeys,
    `可选主色下的不达标组合与登记清单不一致。\n实测：\n  ${actualKeys.join("\n  ")}\n登记：\n  ${expectedKeys.join("\n  ")}\n` +
      `（少了 = 那一档已被修好，请把条目从 KNOWN_SUB_AA 删掉；多了 = 新出现的缺口，别加进清单，去修色值）`,
  );
  for (const k of KNOWN_SUB_AA) {
    const ratio = measured.get(`${k.theme}|${k.accent}|${k.fg}|${k.bg}`);
    assert.ok(typeof ratio === "number", `登记的组合这次没报红：${k.theme} ${k.accent} ${k.fg}/${k.bg}`);
    assert.ok(
      ratio >= k.floor - 0.01,
      `${k.theme} 主色 ${k.accent} 的 ${k.fg}/${k.bg} 从 ${k.floor} 掉到 ${ratio} —— 缺口被放大，不接受`,
    );
  }
});

test("反控（两侧 × 两档外观）：填充档朝错方向混必须报红，朝对方向必须不报红", () => {
  // 这条最初只写了"把 85% 改成 5%"，然后断言它报红 —— 结果是 0 条，暴露出**我自己把方向搞反**：
  // `color-mix(in srgb, A 5%, black)` 取的是 **5% 的 A**，所以那是在把填充色**压深**，
  // 白字对比度只会更高。一个朝安全方向变的"变异"永远测不出判据在不在空转。
  //
  // ⚠️ 2026-10-23 这一族换了形状：填充/前景/hover 三档现在**两档外观各有一套**
  //（暗色提亮填充 + 深墨前景，见 style.css 里那两段注释）。于是"改浅必须两档各报一次"这个
  // 断言本身失效了 —— 改 :root 只可能让亮色那一档红。现在是**按作用域各测一次方向**：
  //   亮色：填充不许朝纯主色走（白字掉下 4.5）；
  //   暗色：填充不许朝纯主色走（那是"不提亮" ⇒ 按钮和 #1e293b 面板分不开，非文字 3:1 先红）。
  // 两侧都各带一次"朝合法方向变 ⇒ 必须不报红"，否则等于只证明了判据会响。
  const LIGHT_ACTIVE =
    "--gosslan-primary-active: color-mix(in srgb, var(--gosslan-primary) 72%, #000000);";
  const DARK_ACTIVE =
    "--gosslan-primary-active: color-mix(in srgb, var(--gosslan-primary) 80%, #ffffff);";

  /**
   * 绿色那档主色 + 把**指定作用域**的填充档混法换成 `pct% + otherColor`，返回该族的报红条目。
   * 两侧各自都按实测选点（不是"越…越红"的想当然）：
   *   亮色错向 = 退回纯主色（白字 2.66）；亮色合法 = 继续压深（40% 主色 + 60% 黑）。
   *   暗色错向 = 把亮色那档照搬过来（72% 主色 + 黑 ⇒ 填充变暗，深墨字只有 3.86）；
   *   暗色合法 = 继续提亮（95% 主色 + 白 ⇒ 墨字 7.37 / vs 面板 5.76，两条都过）。
   */
  const activeFails = (anchor: string, pct: number, otherColor: string) => {
    const base = withPrimary("#00b578");
    assert.ok(
      base.includes(anchor),
      `填充档锚点没命中：${anchor.slice(0, 40)}…（写法变了，请同步这条反控）`,
    );
    const nextDecl = `--gosslan-primary-active: color-mix(in srgb, var(--gosslan-primary) ${pct}%, ${otherColor});`;
    const mutated = base.replace(anchor, nextDecl);
    assert.notEqual(mutated, base, "填充档替换没生效 ⇒ 这条反控在空转");
    assert.ok(mutated.includes(nextDecl), "变异后的声明没落成期望那一份 ⇒ 改的是别的行");
    return findTokenContrastFailures(mutated).filter((f) => f.bg === "--gosslan-primary-active");
  };

  const lightWrong = activeFails(LIGHT_ACTIVE, 100, "#000000");
  assert.ok(
    lightWrong.some((f) => f.theme === "light" && f.fg === "--gosslan-on-primary" && f.ratio < 4.5),
    `亮色下把填充退回纯主色，白字必须报红（绿档实测 2.66）；实际 ${JSON.stringify(
      lightWrong.map((f) => `${f.theme}/${f.fg}=${f.ratio.toFixed(2)}`),
    )}`,
  );
  assert.equal(
    activeFails(LIGHT_ACTIVE, 40, "#000000").length,
    0,
    "亮色把填充继续压深是**合法方向**，不该报红（报红说明判据连方向也搞反了）",
  );

  const darkWrong = activeFails(DARK_ACTIVE, 72, "#000000");
  assert.ok(
    darkWrong.some((f) => f.theme === "dark" && f.fg === "--gosslan-on-primary" && f.ratio < 4.5),
    `把亮色的压深档照搬到暗色，深墨字必须报红（实测 3.86）；实际 ${JSON.stringify(
      darkWrong.map((f) => `${f.theme}/${f.fg}=${f.ratio.toFixed(2)}`),
    )}`,
  );
  assert.equal(
    activeFails(DARK_ACTIVE, 95, "#ffffff").length,
    0,
    "暗色把填充继续提亮是**合法方向**，不该报红",
  );
});

test("填充/前景/hover 三档必须在 :root 与 .dark 都成对定义（少一条就是暗色继承亮色的方向）", () => {
  // 这一族刚就是因为"只写在 :root"翻过车：压深档在暗色下白字照样过 4.5，
  // 但按钮与面板的分离度掉到 2.06~3.01 —— 只看文字档永远看不出问题。
  const { light, dark } = parseTokenScopes(css);
  const pair = ["--gosslan-primary-active", "--gosslan-primary-hover", "--gosslan-on-primary"];
  for (const k of pair) {
    assert.ok(light.has(k), `${k} 在 :root 里缺少定义`);
    assert.ok(dark.has(k), `${k} 在 .dark 里缺少定义（暗色会继承亮色的混色方向）`);
  }
  // 方向必须**相反**，不然这两套就是一份复制：亮色混黑、暗色混白。
  for (const k of pair.slice(0, 2)) {
    assert.match(String(light.get(k)), /#000000/, `${k} 亮色档应当朝黑混`);
    assert.match(String(dark.get(k)), /#ffffff/, `${k} 暗色档应当朝白混`);
  }
});

// ---------------- 禁用态（整元素 opacity）那一族 ----------------
//
// §2.3 要「禁用态有足够对比度」，而上面那张契约表**一行都没覆盖它** ——
// 禁用不走颜色档位，走 `opacity`，于是它一直是"护栏全绿但从没被算过"的形状。

const disabledSources = (): Record<string, string> => ({
  PrimaryBtn: readFileSync(join(import.meta.dirname, "..", "components", "ui", "PrimaryBtn.vue"), "utf8"),
  DangerBtn: readFileSync(join(import.meta.dirname, "..", "components", "ui", "DangerBtn.vue"), "utf8"),
  ChatWindow: readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8"),
  StyleCss: css,
});

test("禁用 α 从组件写法里现取，注释里提到的不算", () => {
  assert.deepEqual(disabledOpacityFromClasses(`<button class="tap-safe disabled:opacity-40">x</button>`), [0.4]);
  // 反向对照：只在注释里出现 ⇒ 取不到（把注释当调用点会量出一个界面根本不存在的 α）
  assert.deepEqual(
    disabledOpacityFromClasses("<!-- 以前这里是 disabled:opacity-10，太淡了 -->\n<button>x</button>"),
    [],
    "注释里的类名被当成了 α 的家",
  );
  assert.deepEqual(
    disabledOpacityFromClasses("// 讨论稿：disabled:opacity-10\n<button>x</button>"),
    [],
    "// 注释里的类名被当成了 α 的家",
  );
  // 正向对照：同档写两次都要算进来，而取最激进的那个才是真实风险
  assert.deepEqual(
    disabledOpacityFromClasses(`<a class="disabled:opacity-60"></a><b class="disabled:opacity-40"></b>`),
    [0.6, 0.4],
  );
});

test("禁用 α 按规则块取，不许把另一条规则的更淡值算进来", () => {
  const fake = `
:where(input, textarea, select):disabled,
:where(input, textarea, select)[readonly] {
  cursor: not-allowed;
  opacity: 0.62;
}
.gosslan-menu-item[data-disabled] {
  opacity: 0.5;
}
/* 设想稿：.gosslan-menu-item[data-disabled] { opacity: 0.1 } */
`;
  assert.deepEqual(
    disabledOpacityFromRule(fake, "select):disabled"),
    [0.62],
    "输入框那族必须按它自己的 0.62 算 —— 全文取最小会把它冤枉成红",
  );
  assert.deepEqual(disabledOpacityFromRule(fake, ".gosslan-menu-item[data-disabled]"), [0.5]);
  assert.deepEqual(disabledOpacityFromRule(fake, ".不存在的选择器"), [], "注释里的同名规则不许被命中");
});

test("真实源码：禁用态六行都算得出 α 与颜色（一行都不许静默跳过）", () => {
  const audit = auditDisabledContrast(css, disabledSources());
  assert.deepEqual(audit.unresolved, [], `有行取不到 α 或解析不出颜色：${audit.unresolved.join(" / ")}`);
  assert.equal(
    audit.ratings.length,
    DISABLED_CONTRAST_CONTRACT.length * 2,
    "每行必须亮/暗各一条读数（少一条 = 那一档外观从没被算过）",
  );
  const table = audit.ratings
    .map((r) => `  · ${r.name}｜${r.theme}｜α=${r.alpha} 未禁用 ${r.ratioUndisabled.toFixed(2)} → 禁用后 ${r.ratio.toFixed(2)}`)
    .join("\n");
  console.log(`· 禁用态合成对比度（WCAG 比值，按各行自己的 α 实算）：\n${table}`);
});

test("实底按钮禁用后过不了 AA —— 这是「填充与标签一起消失」，不是淡一点", () => {
  // 机制：整元素 opacity 把前景与填充按同一个 α 拉向同一个背景面，
  // contrast(αF+(1-α)B, αG+(1-α)B) 随 α→0 单调趋于 1 ⇒ 靠"把 α 调大一点"救不回来。
  const audit = auditDisabledContrast(css, disabledSources());
  for (const name of ["主色实底按钮", "危险实底按钮"]) {
    const rows = audit.ratings.filter((r) => r.name === name);
    assert.equal(rows.length, 2, `${name} 应亮/暗各一条`);
    for (const r of rows) {
      assert.ok(
        r.ratioUndisabled >= 4.5,
        `${name}（${r.theme}）未禁用时本就该过 AA，实测 ${r.ratioUndisabled.toFixed(2)} —— 契约表那侧有问题`,
      );
      assert.ok(
        r.ratio < 4.5,
        `${name}（${r.theme}）禁用后按机制必须低于未禁用值；实测 ${r.ratio.toFixed(2)}`,
      );
    }
  }
});

test("把禁用态调得更淡必须报红（α 是从源码现取的，手抄值做不到这件事）", () => {
  const base = auditDisabledContrast(css, disabledSources());
  assert.deepEqual(
    base.fails.map((f) => `${f.name}/${f.theme}=${f.ratio.toFixed(2)}`),
    [],
    `当前实测下限被自己踩破了：${base.fails.map((f) => `${f.name} ${f.theme} ${f.ratio.toFixed(2)}<${f.min}@α${f.alpha}`).join("; ")}`,
  );
  const src = disabledSources();
  const mutated = auditDisabledContrast(css, {
    ...src,
    PrimaryBtn: src.PrimaryBtn.replace("disabled:opacity-50", "disabled:opacity-25"),
  });
  const red = mutated.fails.find((f) => f.name === "主色实底按钮");
  assert.ok(
    red,
    "把 PrimaryBtn 的禁用 α 从 50 调到 25，护栏必须点名它 —— 没点名叫明 α 根本没参与计算",
  );
  assert.equal(red!.alpha, 0.25, `报红要带上真实 α，实际 ${red!.alpha}`);
  const before = base.ratings.find((r) => r.name === "主色实底按钮" && r.theme === red!.theme)!;
  assert.ok(red!.ratio < before.ratio, `更淡的 α 必须量出更低的比值：${red!.ratio} vs ${before.ratio}`);
});

test("删掉禁用态写法不算「通过」—— 取不到 α 就是未决", () => {
  const src = disabledSources();
  const audit = auditDisabledContrast(css, {
    ...src,
    DangerBtn: src.DangerBtn.replace("disabled:opacity-50", ""),
  });
  assert.ok(
    audit.unresolved.some((u) => u.includes("危险实底按钮")),
    `写法被删掉时报红方向应是"这行从没被算过"，实际 ${JSON.stringify(audit.unresolved)}`,
  );
});

test("禁用态契约的每一行都要有 min 与 why，且 min 不许高于 4.5", () => {
  for (const row of DISABLED_CONTRAST_CONTRACT) {
    assert.ok(row.min > 0 && row.min <= 4.5, `${row.name} 的 min=${row.min} 越界（禁用态不是达标线，是实测下限）`);
    assert.ok(row.why.length > 0, `${row.name} 缺少 why`);
    assert.ok(
      row.name !== "禁用输入框" || row.min === 4.5,
      "输入框那一族是唯一还过 AA 的，按正文档硬钉，别顺手放宽",
    );
  }
});
