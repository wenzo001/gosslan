#!/usr/bin/env node
/**
 * 滚动条三态对比度读数（`docs/design-language/density-and-scroll.md` §4/§7）。
 *
 * 口径：把 `--gosslan-text-2` 按 `--gosslan-scrollbar-thumb / -thumb-active / -track`
 * 的百分比混到 `--gosslan-panel` 上，再按 WCAG 2.x 相对亮度公式算对比度。
 * 亮/暗两套主题各算一次；任何一套低于 3:1 就退 1（对应 SC 1.4.11 非文本下限）。
 *
 * 主题值直接从 `src/style.css` 读（出现顺序：亮、暗），不另抄一份。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "style.css"), "utf8");

const grabAll = (name) =>
  [...css.matchAll(new RegExp(`--gosslan-${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((m) => m[1]);
const pct = (name) => {
  const m = css.match(new RegExp(`--gosslan-${name}:\\s*(\\d+)%`));
  if (!m) throw new Error(`缺 token --gosslan-${name}`);
  return Number(m[1]) / 100;
};

const text2 = grabAll("text-2");
const panel = grabAll("panel");
if (text2.length < 2 || panel.length < 2) throw new Error("style.css 里找不到亮/暗两套 text-2 / panel");

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const blend = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

const states = [
  ["静态 thumb", pct("scrollbar-thumb")],
  ["hover/拖动 thumb", pct("scrollbar-thumb-active")],
  ["轨道", pct("scrollbar-track")],
];

const themes = [
  ["亮", text2[0], panel[0]],
  ["暗", text2[1], panel[1]],
];

let bad = 0;
for (const [name, fg, bg] of themes) {
  console.log(`\n${name}主题（text-2 ${fg} × panel ${bg}）`);
  for (const [label, a] of states) {
    const mixed = blend(hex(fg), hex(bg), a);
    const r = ratio(mixed, hex(bg));
    const isThumb = !label.includes("轨道");
    const ok = isThumb ? r >= 3 : r >= 1.1;
    if (!ok) bad++;
    console.log(
      `  ${label.padEnd(16)} ${String(a * 100).padStart(3)}% → ${toHex(mixed)}  对比 ${r.toFixed(2)}:1  ${ok ? "✅" : "❌"}`,
    );
  }
}

// 轨道必须比静态 thumb 低一档（否则"带"与"块"抢注意力）。
for (const [name, fg, bg] of themes) {
  const thumb = ratio(blend(hex(fg), hex(bg), pct("scrollbar-thumb")), hex(bg));
  const track = ratio(blend(hex(fg), hex(bg), pct("scrollbar-track")), hex(bg));
  if (!(track < thumb)) {
    console.log(`❌ ${name}主题：轨道 ${track.toFixed(2)} 不低于 thumb ${thumb.toFixed(2)}`);
    bad++;
  }
}

console.log(`\n${bad === 0 ? "✅ 三态对比度全部达标" : `❌ ${bad} 条不达标`}`);
process.exit(bad === 0 ? 0 : 1);
