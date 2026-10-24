import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("hexToRgb 解析 6 位与 3 位 hex", () => {
  assert.deepEqual(hexToRgb("#3b82f6"), [59, 130, 246]);
  assert.deepEqual(hexToRgb("#ffffff"), [255, 255, 255]);
  assert.deepEqual(hexToRgb("#fff"), [255, 255, 255]);
});

test("rgba 输出带透明度", () => {
  assert.equal(rgba("#3b82f6", 0.12), "rgba(59, 130, 246, 0.12)");
});

test("applyTheme 只管主色与字体：派生档不许在 JS 里重算，默认档不留内联", () => {
  // 这条钉的是"一份实现"。以前 JS 按 8% 算一份、style.css 又硬编一份近似值，两份比例不同；
  // 首屏脚本只来得及写主色 ⇒ 按钮已换色而 hover/浅底还是蓝色。现在派生只有 CSS 一处。
  // 默认档（空串）同样不在 JS 里抄兜底栈 —— 清掉内联，让 style.css 的 token 当唯一来源。
  const set: Array<[string, string]> = [];
  const removed: string[] = [];
  const saved = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
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
  };
  const picked = "'JetBrains Mono', Consolas, monospace";
  try {
    applyTheme("#d43d43", picked);
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = saved;
  }
  assert.deepEqual(
    set.map(([k]) => k),
    ["--gosslan-primary", "--gosslan-font-family"],
    `applyTheme 多写或少写了变量：${JSON.stringify(set)}`,
  );
  assert.equal(set[0][1], "#d43d43");
  assert.equal(set[1][1], picked);

  set.length = 0;
  removed.length = 0;
  (globalThis as { document?: unknown }).document = {
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
  };
  try {
    applyTheme("#d43d43", "");
  } finally {
    if (saved === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = saved;
  }
  assert.deepEqual(set.map(([k]) => k), ["--gosslan-primary"], `默认档不该再写一份兜底栈：${JSON.stringify(set)}`);
  assert.deepEqual(removed, ["--gosslan-font-family"], "默认档必须清掉内联，让 style.css 的 token 生效");
});

test("hover/active/light 由主色 color-mix 派生，且两档外观方向相反", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  // 作用域按**行首**认，且必须两边分别解析：2026-10-24 之后 hover/active 在 :root 朝黑混、
  // 在 .dark 朝白混（同一对 token、相反方向）。用"全文第一个匹配"读出来的只有亮色那份，
  // 于是"暗色少写一条覆盖"这种缺陷在这条判据上根本不会红。
  const scope = (re: RegExp) => re.exec(css)?.[1] ?? "";
  const rootBlock = scope(/^:root\s*\{([\s\S]*?)^\}/m);
  const darkBlock = scope(/^\.dark\s*\{([\s\S]*?)^\}/m);
  const decl = (where: string, token: string) => {
    const m = new RegExp(`--gosslan-${token}:\\s*([^;]+);`).exec(where);
    return m ? m[1].trim() : "";
  };
  // 正控：解析面先要认得出真实声明，否则下面的断言全绿只是因为正则坏了。
  assert.ok(rootBlock.length > 0 && darkBlock.length > 0, "没解析到 :root / .dark 两个作用域块");
  assert.ok(decl(rootBlock, "primary-light").length > 0, "没解析到 --gosslan-primary-light");

  const mixPct = (v: string) => {
    const m = /^color-mix\(in srgb,\s*var\(--gosslan-primary\)\s+([\d.]+)%\s*,\s*(#[0-9a-fA-F]{3,6}|transparent)\s*\)$/.exec(v);
    return m ? { pct: Number(m[1]), other: m[2].toLowerCase() } : null;
  };

  // 形状判据（两档共用）：必须是**从 --gosslan-primary 现派生**的 color-mix，不许写回硬编色值。
  for (const [where, name] of [[rootBlock, ":root"], [darkBlock, ".dark"]] as const) {
    for (const token of ["primary-hover", "primary-active"]) {
      if (!where.includes(`--gosslan-${token}`)) continue; // 这一档允许只在 :root 定义（light 就是）
      const d = mixPct(decl(where, token));
      assert.ok(d, `${name} 的 ${token} 必须是 color-mix(in srgb, var(--gosslan-primary) N%, 某色)，实际 "${decl(where, token)}"`);
    }
  }

  // 方向判据：亮色压深（承载白字）；暗色提亮（前景换成深墨，填充要贴得住暗面板）。
  const light = { hover: mixPct(decl(rootBlock, "primary-hover")), active: mixPct(decl(rootBlock, "primary-active")) };
  const dark = { hover: mixPct(decl(darkBlock, "primary-hover")), active: mixPct(decl(darkBlock, "primary-active")) };
  for (const [k, v] of Object.entries(light)) {
    assert.ok(v && v.other === "#000000", `:root 的 primary-${k} 必须朝 #000000 压深：白字压在填充上要过 4.5:1`);
  }
  for (const [k, v] of Object.entries(dark)) {
    assert.ok(v && v.other === "#ffffff", `.dark 的 primary-${k} 必须朝 #ffffff 提亮：深底上再压深，按钮和面板只剩 2~3:1`);
  }
  // hover 必须是"更强调的那一档"：亮色更深（比例更小 = 混进的黑更多）、暗色更亮。
  assert.ok(light.hover!.pct < light.active!.pct, "亮色 hover 要比 active 再深一档（混黑比例更高）");
  assert.ok(dark.hover!.pct < dark.active!.pct, "暗色 hover 要比 active 再亮一档（混白比例更高）");

  // light 档（半透明底）仍走透明混法：跟着主色换 RGBA，不写死。
  assert.match(decl(rootBlock, "primary-light"), /var\(--gosslan-primary\)/, "primary-light 必须跟着主色");
  // 前景档两边都要有：暗色漏一条就继承亮色的白，压在提亮档上只剩 1.6~2.0。
  assert.ok(/--gosslan-on-primary:\s*#ffffff;/.test(rootBlock), ":root 的 --gosslan-on-primary 必须是白");
  assert.ok(/--gosslan-on-primary:\s*var\(--gosslan-[a-z-]+\);/.test(darkBlock), ".dark 必须换掉前景档（不能留白）");
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

