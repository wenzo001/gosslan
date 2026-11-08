import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgb,
  rgba,
  mixHex,
  luma,
  mixToLuma,
  contrastRatio,
  adjustHsl,
  toHsl,
  hslToHex,
  applyTheme,
} from "./color.ts";
import { SEED_TOKENS, seedTokens } from "./themePalette.ts";

test("hexToRgb 解析 6 位与 3 位 hex", () => {
  assert.deepEqual(hexToRgb("#3b82f6"), [59, 130, 246]);
  assert.deepEqual(hexToRgb("#ffffff"), [255, 255, 255]);
  assert.deepEqual(hexToRgb("#fff"), [255, 255, 255]);
});

test("rgba 输出带透明度", () => {
  assert.equal(rgba("#3b82f6", 0.12), "rgba(59, 130, 246, 0.12)");
});

test("applyTheme 写的是求解后的 6 个种子档 + 字体：不再直接写用户原值", () => {
  // 这条钉的是"一份实现"的另一半：派生只有 utils/themePalette.ts 一处，JS 不再抄比例。
  // 用户可以在取色器里选纯白/纯黑/荧光色 ⇒ 直接写 `--gosslan-primary: 原值` 会派生白底白字，
  // 所以 applyTheme 必须写 seedTokens 的结果（含填充/hover/active/前景/accent-ink/浅底）。
  const set: Array<[string, string]> = [];
  const removed: string[] = [];
  const saved = (globalThis as { document?: unknown }).document;
  const fake = () => ({
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          set.push([k, v]);
        },
        removeProperty: (k: string) => {
          removed.push(k);
        },
      },
    },
  });
  const picked = "'JetBrains Mono', Consolas, monospace";
  try {
    (globalThis as { document?: unknown }).document = fake();
    applyTheme("#d43d43", picked);
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = saved;
  }
  assert.deepEqual(
    set.map(([k]) => k),
    [...SEED_TOKENS, "--gosslan-font-family"],
    `applyTheme 多写或少写了变量：${JSON.stringify(set.map(([k]) => k))}`,
  );
  const light = Object.fromEntries(set) as Record<string, string>;
  const expected = seedTokens("#d43d43", "light");
  for (const k of SEED_TOKENS) assert.equal(light[k], expected[k], `${k} 与求解器不一致`);
  assert.equal(light["--gosslan-font-family"], picked);

  // 默认字体档：清掉内联，让 style.css 的 token 当唯一来源。
  set.length = 0;
  removed.length = 0;
  try {
    (globalThis as { document?: unknown }).document = fake();
    applyTheme("#d43d43", "");
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = saved;
  }
  assert.deepEqual(removed, ["--gosslan-font-family"], "默认档必须清掉内联，让 style.css 的 token 生效");
  assert.equal(set.length, SEED_TOKENS.length, `默认档仍应写 6 个种子档：${JSON.stringify(set)}`);
});

test("外观决定填充方向：亮色压深承白字，暗色提亮换深墨", () => {
  // 亮/暗的最差底色与推进方向不同（见 style.css 顶部那 0.003 窗口的推导），
  // 所以同一颗主色在两档外观下必须给出**不同**的填充与前景，而不是同一份值换个背景用。
  const seed = "#2f6bff";
  const light = seedTokens(seed, "light");
  const dark = seedTokens(seed, "dark");

  assert.ok(
    luma(light["--gosslan-primary-hover"]) < luma(light["--gosslan-primary"]) &&
      luma(light["--gosslan-primary-active"]) < luma(light["--gosslan-primary-hover"]),
    "亮色：hover / active 必须逐档更深（白字压在实底上，越按越清楚）",
  );
  assert.ok(
    luma(dark["--gosslan-primary-hover"]) > luma(dark["--gosslan-primary"]) &&
      luma(dark["--gosslan-primary-active"]) > luma(dark["--gosslan-primary-hover"]),
    "暗色：hover / active 必须逐档更亮（深底上再压深，按钮和面板只剩 2~3:1）",
  );
  assert.equal(light["--gosslan-on-primary"], "#ffffff", "亮色实底配白字");
  assert.ok(
    luma(dark["--gosslan-primary"]) > luma(seed) && luma(dark["--gosslan-on-primary"]) < 80,
    `暗色必须换成"亮填充 + 深墨"：填充 ${dark["--gosslan-primary"]} 前景 ${dark["--gosslan-on-primary"]}`,
  );
  // accent-ink（主色当文字）必须能在它实际落的那层面底上读出来 —— 而不是"比填充更极端"：
  // 暗色下填充与 accent-ink 都取在 L≈0.85，谁更亮没有意义，有意义的是 vs 面底的比例。
  assert.ok(
    luma(light["--gosslan-accent-ink"]) < luma(light["--gosslan-primary"]),
    "亮色 accent-ink 要比填充更深（它压在白面上）",
  );
  assert.ok(
    contrastRatio(dark["--gosslan-accent-ink"], "#2e2f31") >= 4.5,
    `暗色 accent-ink 压在面板底上不足 4.5:1：${contrastRatio(dark["--gosslan-accent-ink"], "#2e2f31")}`,
  );
  assert.ok(
    contrastRatio(light["--gosslan-accent-ink"], "#e2e3e7") >= 4.5,
    `亮色 accent-ink 压在卡片底上不足 4.5:1：${contrastRatio(light["--gosslan-accent-ink"], "#e2e3e7")}`,
  );
});

test("luma: 黑白两端为 0/255，中间色介于其间", () => {
  assert.equal(Math.round(luma("#000000")), 0);
  assert.equal(Math.round(luma("#ffffff")), 255);
  const blue = luma("#3b82f6");
  assert.ok(blue > 0 && blue < 255, `蓝色亮度应在中间：${blue}`);
});

test("mixHex 返回 6 位 hex，可继续参与后续混合", () => {
  assert.match(mixHex("#000000", [255, 255, 255], 1), /^#[0-9a-f]{6}$/);
  assert.equal(mixHex("#000000", [255, 255, 255], 1), "#ffffff");
  // 混向深色画布：亮度必须下降
  const dimmed = mixHex("#3b82f6", [15, 23, 42], 0.5);
  assert.ok(luma(dimmed) < luma("#3b82f6"));
});

test("mixToLuma: 只压不提，已达到目标亮度的颜色原样返回", () => {
  const softWhite = mixToLuma("#ffffff", [0, 0, 0], 212);
  assert.ok(Math.abs(luma(softWhite) - 212) <= 1, `应压到 212 附近，实际 ${luma(softWhite)}`);
  // 已经比目标暗 → 不动（深色气泡不会被压没）
  assert.equal(mixToLuma("#374151", [15, 23, 42], 74), "#374151");
});

test("contrastRatio: 暗色气泡底色与文字达到 WCAG AA（≥ 4.5）", () => {
  // 默认主题蓝压暗后配柔和白字，正是聊天自己气泡的暗色组合
  const bubble = mixToLuma("#3b82f6", [15, 23, 42], 74);
  const text = mixToLuma("#ffffff", [0, 0, 0], 212);
  assert.ok(luma(bubble) <= 75, `气泡仍过亮：${luma(bubble)}`);
  assert.ok(contrastRatio(text, bubble) >= 4.5, `对比度不足：${contrastRatio(text, bubble)}`);
  // 黑底白字应远高于阈值
  assert.ok(contrastRatio("#ffffff", "#000000") > 15);
});

test("adjustHsl: 只动明度不动色相，同明度下比混白更浓", () => {
  const theme = "#3b82f6";
  const [h0, s0] = toHsl(theme);
  const [h1, s1, l1] = toHsl(adjustHsl(theme, { l: 0.92 }));
  assert.ok(Math.abs(h1 - h0) < 1, `色相漂了：${h0} → ${h1}`);
  assert.ok(Math.abs(s1 - s0) < 0.02, `饱和度掉了：${s0} → ${s1}`);
  assert.ok(Math.abs(l1 - 0.92) < 0.01, `明度没到位：${l1}`);
  // 色彩浓度（RGB 极差）：混白会一路洗到接近纯白，HSL 调 L 能留住更多色味
  const chroma = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    return Math.max(r, g, b) - Math.min(r, g, b);
  };
  const washed = mixHex(theme, [255, 255, 255], 0.9);
  assert.ok(chroma(adjustHsl(theme, { l: 0.92 })) > chroma(washed), "浅底应比混白更有色味");
});

test("adjustHsl: sMax 只压不提，低饱和色不会被强行拉艳", () => {
  const gray = "#64748b";
  const s0 = toHsl(gray)[1];
  assert.ok(toHsl(adjustHsl(gray, { l: 0.92, sMax: 0.85 }))[1] <= s0 + 0.01);
  // 高饱和色会被压到上限
  assert.ok(toHsl(adjustHsl("#ff0000", { l: 0.92, sMax: 0.85 }))[1] <= 0.86);
});

test("toHsl / hslToHex 往返一致", () => {
  for (const hex of ["#3b82f6", "#0f172a", "#ffffff", "#000000", "#22c55e"]) {
    assert.equal(hslToHex(...toHsl(hex)), hex);
  }
});

