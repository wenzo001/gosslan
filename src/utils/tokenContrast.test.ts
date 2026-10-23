import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TOKEN_CONTRAST_CONTRACT,
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
 * 它们**不是**有意的设计取舍，而是这次扫描第一次量出来的缺口：
 * `--gosslan-primary-active`（承载白字的填充档）从主色混 15% 黑，
 * 绿色/橙色/天蓝三档混完仍然太亮 ⇒ 11px 白字只有 3.61/3.83/3.76；
 * 绿色那一档的 accent-ink 落在列表底上差 0.07。
 * 修法是把混黑比例从 85% 降到 ≤72%（实测六档最小 4.85）—— 但那是**全局**主色填充面，
 * 按钮/徽标会整体变深，超出本次聊天界面改造的范围，交单独决策。
 *
 * ⚠️ 填充档只在 `:root` 定义、`.dark` 不覆盖，所以同一主色在**两档外观上是同一个数**
 * （3.61 亮 / 3.61 暗）。这个"两档相等"本身就是暗色合流解析正确的旁证。
 *
 * 这份清单的作用是让缺口**不能被继续放大**：任一条比记录值更差 ⇒ 红；
 * 某条被修好了 ⇒ 它不再出现在实测集合里，本条判据要求把它从清单删掉。
 */
const ACTIVE_FILL_FLOOR: Record<string, number> = {
  "#00b578": 3.61,
  "#ff6b35": 3.83,
  "#0ea5e9": 3.76,
};
const KNOWN_SUB_AA: Array<{ theme: string; accent: string; fg: string; bg: string; floor: number }> = [
  { theme: "light", accent: "#00b578", fg: "--gosslan-accent-ink", bg: "--gosslan-list", floor: 4.43 },
  ...(["light", "dark"] as const).flatMap((theme) =>
    Object.entries(ACTIVE_FILL_FLOOR).map(([accent, floor]) => ({
      theme,
      accent,
      fg: "#ffffff",
      bg: "--gosslan-primary-active",
      floor,
    })),
  ),
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

test("反控（两侧）：填充档改浅必须报红、改深必须不报红 —— 方向也得钉住", () => {
  // 这条最初只写了"把 85% 改成 5%"，然后断言它报红 —— 结果是 0 条，暴露出**我自己把方向搞反**：
  // `color-mix(in srgb, A 5%, black)` 取的是 **5% 的 A**，所以那是在把填充色**压深**，
  // 白字对比度只会更高。一个朝安全方向变的"变异"永远测不出判据在不在空转。
  // 于是这里两侧都量：100%（= 纯主色，最浅）必须红，5%（最深）必须不红。
  const ACTIVE_ANCHOR =
    "--gosslan-primary-active: color-mix(in srgb, var(--gosslan-primary) 85%, #000000);";
  /** 绿色那档主色 + 把填充档混黑比例换成 `pct%`，返回该族的报红条目。 */
  const greenActiveFails = (pct: number) => {
    const base = withPrimary("#00b578");
    assert.ok(
      base.includes(ACTIVE_ANCHOR),
      "填充档锚点没命中（--gosslan-primary-active 的写法变了，请同步这条反控）",
    );
    const mutated = base.replace(
      ACTIVE_ANCHOR,
      `--gosslan-primary-active: color-mix(in srgb, var(--gosslan-primary) ${pct}%, #000000);`,
    );
    assert.notEqual(mutated, base, "填充档替换没生效 ⇒ 这条反控在空转");
    return findTokenContrastFailures(mutated).filter((f) => f.bg === "--gosslan-primary-active");
  };

  const lighter = greenActiveFails(100);
  assert.equal(
    lighter.length,
    2,
    `填充档取纯主色时，绿色那档白字应两档外观各报一次，实际 ${lighter.length} ⇒ 扫描在空转`,
  );
  for (const f of lighter) {
    assert.ok(f.ratio < 3.61, `改浅只会更差：实测 ${f.theme}=${f.ratio}，不该不低于记录值 3.61`);
  }

  const darker = greenActiveFails(5);
  assert.equal(darker.length, 0, "把填充档压深是**修好**它，不该报红（报红说明判据连方向也搞反了）");
});
