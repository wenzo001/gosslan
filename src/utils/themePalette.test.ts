import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mixHex } from "./color.ts";
import { parseTokenScopes } from "./tokenContrast.ts";
import {
  APCA_LIMITS,
  DEFAULT_SEED,
  SEED_TOKENS,
  apcaLc,
  buildThemeTokens,
  hexToRgb,
  oklchToHex,
  rgbToHex,
  seedTokens,
  wcagRatio,
  type RGB,
  type ThemeMode,
} from "./themePalette.ts";

// ---------------- 扫描面：全部内置主色 + 极端输入 + 采样随机色 ----------------
//
// 判据的要求是"矩阵扫描"，不是挑几个好看的色跑一遍。三组来源：
//   ① 设置页里真实可选的六套主色（现解析，不手抄 —— 抄一份就会漂）；
//   ② 用户能把界面搞瞎的极端输入（纯白/纯黑/荧光/近黑/脏值）；
//   ③ 固定种子的伪随机采样（色相 × 彩度 × 明度全覆盖）。

function presetColors(): string[] {
  const src = readFileSync(join(import.meta.dirname, "..", "components", "settings", "AppearanceSection.vue"), "utf8");
  const m = /const presets = \[([^\]]*)\]/.exec(src);
  assert.ok(m, "AppearanceSection.vue 里找不到 `const presets = [...]`（色板搬家了要同步这条判据）");
  const list = [...m[1].matchAll(/"(#[0-9a-fA-F]{3,6})"/g)].map((x) => x[1]);
  assert.ok(list.length >= 4, `色板至少 4 个才说明真的解析到了，实际 ${list.length}`);
  return list;
}

const EXTREMES = [
  "#ffffff",
  "#000000",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#ffff00",
  "#ff00ff",
  "#00ffff",
  "#808080",
  "#010101",
  "#fefefe",
  DEFAULT_SEED,
  "not-a-color",
  "#F00",
  "",
];

/** 固定种子的 LCG：同一份代码在任何机器上采样同一批颜色，失败可复现。 */
function sampledColors(n: number): string[] {
  let s = 20261108;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(oklchToHex(0.02 + rnd() * 0.96, rnd() * 0.37, rnd() * 360));
  return out;
}

const ALL_SEEDS = [...presetColors(), ...EXTREMES, ...sampledColors(48)];

// ---------------- 判据：APCA + WCAG 双约束 ----------------
//
// 阈值不另立一套：正文 / 次文本 / 占位 / 按钮 / 图标的 APCA 下限来自 APCA_LIMITS，
// WCAG 一侧沿用仓库既有契约（正文 4.5 / 非文字 3.0）。任何一档被放宽 ⇒ 下面两个
// "阈值钉死"与"反例自证"测试必须红。

interface Fail {
  pair: string;
  lc: number;
  ratio: number;
  needLc: number;
  needRatio: number;
}

function rgb(hex: string): RGB {
  return hexToRgb(hex);
}

function audit(tokens: Record<string, string>, mode: ThemeMode): Fail[] {
  const fails: Fail[] = [];
  const pair = (fg: string, bg: string, needLc: number, needRatio: number) => {
    const a = rgb(tokens[fg]);
    const b = rgb(tokens[bg]);
    const lc = Math.abs(apcaLc(a, b));
    const ratio = wcagRatio(a, b);
    if (lc < needLc || ratio < needRatio) {
      fails.push({ pair: `${fg} on ${bg}`, lc, ratio, needLc, needRatio });
    }
  };
  const F = APCA_LIMITS;

  // 正文 / 次文本 / 占位：三个"必须读得清"的档位
  for (const bg of ["--gosslan-panel", "--gosslan-list", "--gosslan-chat", "--gosslan-card", "--gosslan-field"]) {
    pair("--gosslan-text", bg, F.body, 4.5);
    pair("--gosslan-text-2", bg, F.secondary, 4.5);
  }
  pair("--gosslan-placeholder", "--gosslan-field", F.weak, 4.5);
  pair("--gosslan-card-ink", "--gosslan-card", F.body, 4.5);
  pair("--gosslan-list-active-text", "--gosslan-list-active", F.body, 4.5);
  // 导航栏未选中标签不在本判据里：它是「有意压低」的次要信息（现设计 2.0:1），
  // 与主题色无关，属于 design-guidelines 的已知偏差，不能靠调主色算法修。

  // 主题色当文字（链接 / 标签）：主色浅底也是文字的实际背景
  for (const bg of ["--gosslan-panel", "--gosslan-list", "--gosslan-card", "--gosslan-primary-light"]) {
    pair("--gosslan-accent-ink", bg, F.secondary, 4.5);
  }
  // 状态文字
  for (const bg of ["--gosslan-panel", "--gosslan-card"]) {
    pair("--gosslan-danger-ink", bg, F.secondary, 4.5);
    pair("--gosslan-warning-ink", bg, F.secondary, 4.5);
    pair("--gosslan-success-ink", bg, F.secondary, 4.5);
  }

  // 按钮文字：三档填充都要压得住
  for (const bg of ["--gosslan-primary", "--gosslan-primary-hover", "--gosslan-primary-active"]) {
    pair("--gosslan-on-primary", bg, F.button, 4.5);
  }

  // 图标 / 边框 / 状态点：非文字 3.0
  pair("--gosslan-primary", "--gosslan-panel", F.icon, 3.0);
  pair("--gosslan-field-border", "--gosslan-panel", F.icon, 3.0);
  pair("--gosslan-field-border", "--gosslan-bg", F.icon, 3.0);
  pair("--gosslan-field-border", "--gosslan-list", F.icon, 3.0);
  pair("--gosslan-status-offline", "--gosslan-panel", F.icon, 3.0);
  pair("--gosslan-warning", "--gosslan-panel", F.icon, 3.0);
  pair("--gosslan-success", "--gosslan-panel", F.icon, 3.0);
  pair("--gosslan-rail-text-active", "--gosslan-rail-active", F.icon, 3.0);

  // 表情回应胶囊四态（用户 2026-11-08 实测：「数字在蓝色下面看不清」）：
  // 文字对**每一档底**都要达标 —— hover 只换一层底、不改文字色，所以它也是文字的真实背景。
  for (const bg of ["--gosslan-react-bg", "--gosslan-react-bg-hover"]) {
    pair("--gosslan-react-ink", bg, F.secondary, 4.5);
  }
  for (const bg of ["--gosslan-react-bg-mine", "--gosslan-react-bg-mine-hover"]) {
    pair("--gosslan-react-ink-mine", bg, F.secondary, 4.5);
  }
  // 胶囊压在**自己的主色气泡**上时，分隔靠"色阶差"而不是 3:1：胶囊是 M3 意义上的 tonal fill，
  // 亮色种子（#00b578 一类）下浅胶囊 vs 亮填充恰好 2.x —— 想同时压住 3:1 就只能把胶囊做到中灰，
  // 在聊天界面里会变成一块重色块。所以这里不做非文字断言，只保证**文字**四态全过（上面四行）。
  return fails;
}

test("阈值就是契约里的那几档（调低必须让本文件红）", () => {
  assert.deepEqual(APCA_LIMITS, { body: 85, secondary: 70, weak: 60, button: 75, icon: 45 });
  // 构造性证明：3.6:1 落在 4.5 与 3.0 之间 —— 一旦把 WCAG 阈值下调到 3.0，正文这一档就会放过它。
  const ratio = wcagRatio(hexToRgb("#8a8a8a"), hexToRgb("#ffffff"));
  assert.ok(ratio > 3.0 && ratio < 4.5, `夹具比值应落在两档之间，实际 ${ratio.toFixed(2)}`);
});

test("全部内置主题 + 极端输入 + 随机采样：亮/暗两套矩阵全部达标", () => {
  const failures: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    for (const seed of ALL_SEEDS) {
      for (const f of audit(buildThemeTokens(seed, mode), mode)) {
        failures.push(
          `${mode} seed=${seed} → ${f.pair}：APCA ${f.lc.toFixed(1)}/${f.needLc}，WCAG ${f.ratio.toFixed(2)}/${f.needRatio}`,
        );
      }
    }
  }
  assert.deepEqual(failures.slice(0, 25), [], `存在可读性不达标组合（共 ${failures.length} 条）：\n${failures.slice(0, 25).join("\n")}`);
  assert.ok(ALL_SEEDS.length >= 60, `扫描样本只有 ${ALL_SEEDS.length} 个，覆盖不足`);
});

test("运行时覆盖集与全量地图同源：seedTokens 的每一项都等于 buildThemeTokens", () => {
  assert.equal(SEED_TOKENS.length, 12, "运行时覆盖集固定 12 项（6 个主色档 + 6 个表情胶囊档；改数量等于改性能/首帧契约）");
  for (const mode of ["light", "dark"] as const) {
    for (const seed of ALL_SEEDS) {
      const all = buildThemeTokens(seed, mode);
      const run = seedTokens(seed, mode);
      assert.deepEqual(Object.keys(run).sort(), [...SEED_TOKENS].sort());
      for (const k of SEED_TOKENS) assert.equal(run[k], all[k], `${mode} ${seed} 的 ${k} 与全量地图不一致`);
    }
  }
});

// ---------------- 反例自证：把校正摘掉必须红 ----------------
//
// 旧实现 = 固定混色比例 + 白色前景。它必须在极端输入上红 —— 否则说明上面的矩阵查不出东西。

function legacyTokens(seed: string, mode: ThemeMode): Record<string, string> {
  const base = buildThemeTokens(seed, mode);
  const primary = seed.toLowerCase();
  const to: RGB = mode === "light" ? [0, 0, 0] : [255, 255, 255];
  const out: Record<string, string> = { ...base };
  out["--gosslan-primary"] = primary;
  out["--gosslan-primary-hover"] = mixHex(primary, to, mode === "light" ? 0.34 : 0.26);
  out["--gosslan-primary-active"] = mixHex(primary, to, mode === "light" ? 0.28 : 0.2);
  out["--gosslan-on-primary"] = mode === "light" ? "#ffffff" : "#141518";
  out["--gosslan-accent-ink"] = mixHex(primary, to, 0.28);
  out["--gosslan-primary-light"] = rgbToHex(rgb(mixHex(primary, mode === "light" ? [255, 255, 255] : [0, 0, 0], 0.8)));
  return out;
}

test("反例自证：摘掉校正（旧固定比例 + 恒白字）在极端输入上必须报红", () => {
  const hits: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    for (const seed of ["#ffffff", "#000000", "#ffff00"]) {
      hits.push(...audit(legacyTokens(seed, mode), mode).map((f) => `${mode} ${seed} ${f.pair}`));
    }
  }
  assert.ok(hits.length > 0, "旧固定比例在纯白/纯黑/荧光色上一格都没红 —— 矩阵本身失效了");
  assert.ok(
    hits.some((h) => h === "light #ffffff --gosslan-on-primary on --gosslan-primary"),
    `没抓到白底白字这一格：${hits.slice(0, 8).join(" | ")}`,
  );
});

test("反例自证：胶囊文字改回固定浅色 / 底色退回「透明叠层」必须报红", () => {
  const hits: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    const base = buildThemeTokens(DEFAULT_SEED, mode);
    // ① 旧实现形态：文字写死浅色（不去对胶囊底求解）
    for (const ink of ["#ffffff", "#f2f3f5"]) {
      const fixed = { ...base, "--gosslan-react-ink": ink, "--gosslan-react-ink-mine": ink };
      hits.push(
        ...audit(fixed, mode)
          .filter((f) => f.pair.startsWith("--gosslan-react"))
          .map((f) => `${mode} fixedInk(${ink}) ${f.pair}`),
      );
    }
    // ② 旧实现形态：默认底是「5%/6% 墨迹叠在主色气泡上」的**透明层** —— 有效色在 token 表里不存在，
    //    旧代码正是这样让计数字压在自己的蓝气泡上（用户 2026-11-08 截图）。
    const overlay = mode === "light" ? mixHex(base["--gosslan-primary"], [15, 23, 42], 0.05) : mixHex(base["--gosslan-primary"], [248, 250, 252], 0.06);
    const layered = {
      ...base,
      "--gosslan-react-bg": overlay,
      "--gosslan-react-ink": mode === "light" ? "#4d4f51" : "#cdced1",
    };
    hits.push(
      ...audit(layered, mode)
        .filter((f) => f.pair.startsWith("--gosslan-react"))
        .map((f) => `${mode} layered ${f.pair}`),
    );
  }
  assert.ok(hits.length > 0, "胶囊四态的反例一个都没红 —— 那几行判据空转了");
  assert.ok(hits.some((h) => h.includes("fixedInk")), `没抓到「文字改回固定浅色」：${hits.slice(0, 8).join(" | ")}`);
  assert.ok(hits.some((h) => h.includes("layered")), `没抓到「透明叠层当底」：${hits.slice(0, 8).join(" | ")}`);
});

test("极端输入收敛：输出始终是合法 hex，且不会打出 NaN", () => {
  for (const seed of EXTREMES) {
    for (const mode of ["light", "dark"] as const) {
      for (const [k, v] of Object.entries(buildThemeTokens(seed, mode))) {
        assert.match(v, /^#[0-9a-f]{6}$/, `${seed}/${mode} 的 ${k} 不是合法 hex：${v}`);
      }
    }
  }
});

test("纯白/纯黑种子：主色不会停在「看不见」的一档", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const seed of ["#ffffff", "#000000"]) {
      const t = buildThemeTokens(seed, mode);
      assert.ok(
        wcagRatio(hexToRgb(t["--gosslan-primary"]), hexToRgb(t["--gosslan-on-primary"])) >= 4.5,
        `${mode} ${seed} 的按钮文字不达标：${t["--gosslan-primary"]} / ${t["--gosslan-on-primary"]}`,
      );
      assert.ok(
        wcagRatio(hexToRgb(t["--gosslan-accent-ink"]), hexToRgb(t["--gosslan-card"])) >= 4.5,
        `${mode} ${seed} 的主题色文字不达标`,
      );
    }
  }
});

// ---------------- 防两份实现漂移 ----------------
//
// style.css 里的静态数值与求解器输出必须逐 token 相同：前者是"JS 还没跑"时的首帧，
// 后者是应用主题后的终态。以前它们靠注释里手抄的"实测 4.85~7.10"维持一致，
// 谁改了一边都不会红。这条判据把两边钉在同一份算法上。

test("style.css 的静态数值必须等于求解器对出厂种子的输出（防两份实现漂移）", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  const { light, dark } = parseTokenScopes(css);
  /** 别名档不比对：它们本身就是"指向 primary / text"，比对会要求把别名展开成字面值（第二个家）。 */
  const ALIASES: Record<string, string> = {
    "--gosslan-rail-text-active": "--gosslan-primary",
    "--gosslan-list-active-text": "--gosslan-text",
    // ⚠️ 2026-11-09 移除 `--gosslan-field-border → divider-strong`：两者已解耦（控件边框守 3.0，
    // 结构缝只到 ≈1.4:1）。留在这里会让字段边框重新被结构缝的亮度拖走。
  };
  let compared = 0;
  for (const mode of ["light", "dark"] as const) {
    const scope = mode === "light" ? light : dark;
    const solved = buildThemeTokens(DEFAULT_SEED, mode);
    const mismatches: string[] = [];
    for (const [k, v] of Object.entries(solved)) {
      const got = scope.get(k);
      if (!got) {
        mismatches.push(`${mode} ${k} 在 CSS 里缺少定义`);
        continue;
      }
      if (ALIASES[k]) {
        // 别名档必须在两档外观里都指向同一个家（写成字面值也算漂移）。
        if (!got.includes(`var(${ALIASES[k]})`)) mismatches.push(`${mode} ${k} 应保持别名 var(${ALIASES[k]})，实际 ${got}`);
        continue;
      }
      compared++;
      if (got.toLowerCase() !== v.toLowerCase()) mismatches.push(`${mode} ${k}: CSS ${got} ≠ 求解器 ${v}`);
    }
    assert.deepEqual(mismatches.slice(0, 12), [], `style.css 与求解器不一致：\n${mismatches.slice(0, 12).join("\n")}`);
  }
  // 反空转：两档外观各比对了至少 35 个 token（42 项里除 3 个别名 + 别名重复档）。
  assert.ok(compared >= 70, `只比对了 ${compared} 个 token，解析面可能没读到东西`);
});
