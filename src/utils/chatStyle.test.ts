import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, luma, toHsl } from "./color.ts";
import { CHAT_PRESETS, mentionHighlightColor, readableToneOn, resolveChatColors, UI_TONE_INKS } from "./chatStyle.ts";
import { parseTokenScopes } from "./tokenContrast.ts";

/** 覆盖冷暖、高/低饱和的代表性主题色：任何人选的自定义色都应安全。 */
const THEME_COLORS = [
  "#3b82f6", // 默认蓝
  "#22c55e", // 绿
  "#ef4444", // 红
  "#a855f7", // 紫
  "#f59e0b", // 琥珀
  "#64748b", // 低饱和石板灰
  "#0ea5e9", // 亮天蓝
];

/** 聊天区画布（亮色 --gosslan-chat，近白）。改 style.css 里这个值必须同步这里。 */
const CHAT_BG = "#ffffff";

test("亮色：自己的气泡 = accent 实底 + 白字，白字对比达 AA（不足 4.5 的比例压明度）", () => {
  for (const theme of THEME_COLORS) {
    const c = resolveChatColors("theme", theme, false);
    // 用户 2026-11-06「4 可以」：自己气泡 accent 实色 + 白字（旧口径是浅底深字，已退役）。
    assert.equal(c.mineText, "#ffffff", `${theme} 亮色自己气泡不再是白字`);
    // 色相必须仍是主题色那一个（压明度不换色）；琥珀/天蓝这类亮 accent 会被压到 4.5。
    assert.ok(
      Math.abs(toHsl(c.mineBubble)[0] - toHsl(theme)[0]) < 1,
      `${theme} 的实底换了色相：${c.mineBubble}`,
    );
    const ratio = contrastRatio(c.mineText, c.mineBubble);
    assert.ok(ratio >= 4.5, `${theme} 亮色白字对比度不足：${ratio.toFixed(2)}`);
  }
});

/** 两侧气泡「分不开」的唯一判据：正例与反例都走这一条，避免反例另写一套逻辑。 */
const BUBBLE_SEPARATION_MIN = 1.3;
function bubbleSeparationTooLow(mine: string, other: string): boolean {
  return contrastRatio(mine, other) < BUBBLE_SEPARATION_MIN;
}

test("亮色：气泡底色保留主题色的色相（不会被混白洗成灰）", () => {
  const theme = "#3b82f6";
  const c = resolveChatColors("theme", theme, false);
  // 色相偏差应小于 1 度
  assert.ok(Math.abs(toHsl(c.mineBubble)[0] - toHsl(theme)[0]) < 1);
  // 底色仍要有可见的色彩倾向，不能退化成纯灰
  assert.ok(toHsl(c.mineBubble)[1] > 0.4, `底色饱和度掉太多：${toHsl(c.mineBubble)[1]}`);
});

test("亮色：两侧气泡都暗于画布，且彼此能分开（不靠色相）", () => {
  const c = resolveChatColors("theme", "#3b82f6", false);
  // 2026-11-07：自己气泡是 accent 实底（默认蓝压到白字 4.5 后 ≈ #1e6ff5），比对方浅灰更深。
  // 归属仍靠明度差而不是色相（两者都偏蓝，色相只差几度）。
  assert.ok(
    luma(c.mineBubble) < luma(c.otherBubble),
    `自己的实底应比对方浅灰深：${luma(c.mineBubble).toFixed(0)} vs ${luma(c.otherBubble).toFixed(0)}`,
  );
  assert.ok(
    luma(c.otherBubble) < luma(CHAT_BG),
    `对方的气泡应比画布深（浅灰）：${luma(c.otherBubble).toFixed(0)} vs ${luma(CHAT_BG).toFixed(0)}`,
  );
  assert.ok(
    luma(c.mineBubble) < luma(CHAT_BG),
    `自己的气泡也应比画布深：${luma(c.mineBubble).toFixed(0)} vs ${luma(CHAT_BG).toFixed(0)}`,
  );
  assert.notEqual(toHsl(c.mineBubble)[0], toHsl(c.otherBubble)[0]);
});

test("亮色：气泡与画布拉得开，不会糊在一起", () => {
  // 早前画布 #f8fafc 与纯白对方气泡对比仅 1.02，等于没有气泡（周工反馈"区分度不高"）
  const c = resolveChatColors("theme", "#3b82f6", false);
  assert.ok(contrastRatio(c.otherBubble, CHAT_BG) >= 1.08, "对方气泡与画布对比过低");
  // 画布真实合成色 = #eaeef2（薄纱 16%），不是这里的 #ffffff ——
  // 所以对方气泡的真实判据在 tokenContrast.test.ts（按 veil 合成，含反例自证）。
  assert.ok(contrastRatio(c.mineBubble, CHAT_BG) >= 1.3, "自己的气泡与画布对比过低");
  // 两侧气泡之间：accent 实底 vs 对方浅灰，对比远高于 1.3。
  // ⚠️ 1.3 是**可归属性**的下限，不是"旧配对的读数"：2026-11-06 曾把对方气泡压到
  // #dfe3e9（与己方只剩 1.20）并顺手把阈值放到 1.18，等于"实测值 − 0.017"——
  // 复核判定这是降阈值过关，已改回 #aab5c2 并恢复 1.3。
  assert.ok(!bubbleSeparationTooLow(c.mineBubble, c.otherBubble), "两侧气泡分不开");
});

test("反例自证：两侧同色 / 近似同色必须报「分不开」", () => {
  const c = resolveChatColors("theme", "#3b82f6", false);
  assert.ok(bubbleSeparationTooLow(c.mineBubble, c.mineBubble), "同色必须红（1.00 < 1.3）");
  assert.ok(bubbleSeparationTooLow(c.mineBubble, "#1a6bf4"), "近似同色必须红");
  // 正例走同一条判据：真实配对必须绿，否则反例可能只是判据写反了。
  assert.ok(!bubbleSeparationTooLow(c.mineBubble, c.otherBubble), "真实配对必须绿");
  // 非空转：判据读的必须是入参颜色，把候选换成只差一阶的深蓝必须红。
  assert.ok(bubbleSeparationTooLow(c.mineBubble, "#2563eb"), "只差一阶的近似色必须红");
});

test("亮色：全部预设的自己气泡与画布对比 ≥ 1.25（防再次糊底）", () => {
  for (const preset of CHAT_PRESETS) {
    const c = resolveChatColors(preset.key, "#3b82f6", false);
    const ratio = contrastRatio(c.mineBubble, CHAT_BG);
    assert.ok(ratio >= 1.25, `${preset.label} 的气泡与画布对比不足：${ratio.toFixed(2)}`);
  }
});

test("暗色：自己的气泡不过亮，文字对比度达 AA", () => {
  for (const theme of THEME_COLORS) {
    const c = resolveChatColors("theme", theme, true);
    assert.ok(luma(c.mineBubble) <= 130, `${theme} 暗色气泡过亮：${luma(c.mineBubble).toFixed(0)}`);
    const ratio = contrastRatio(c.mineText, c.mineBubble);
    assert.ok(ratio >= 4.5, `${theme} 暗色对比度不足：${ratio.toFixed(2)}`);
  }
});

test("全部预设：明暗两套配色的正文对比度都达 AA", () => {
  for (const preset of CHAT_PRESETS) {
    for (const dark of [false, true]) {
      const c = resolveChatColors(preset.key, "#3b82f6", dark);
      const mine = contrastRatio(c.mineText, c.mineBubble);
      const other = contrastRatio(c.otherText, c.otherBubble);
      assert.ok(mine >= 4.5, `${preset.key}/${dark ? "暗" : "亮"}/自己：${mine.toFixed(2)}`);
      assert.ok(other >= 4.5, `${preset.key}/${dark ? "暗" : "亮"}/对方：${other.toFixed(2)}`);
    }
  }
});


// ---------------- mention 高亮色：@提及 蓝字在任意气泡底上都得能看清 ----------------

test("mention 高亮色：明暗 × 全主题 × 自己/对方气泡底，对比 ≥ 4.5 且与气泡文字有区分", () => {
  for (const theme of THEME_COLORS) {
    for (const dark of [false, true]) {
      const c = resolveChatColors("theme", theme, dark);
      for (const bg of [c.mineBubble, c.otherBubble]) {
        const fg = mentionHighlightColor(theme, dark, bg);
        assert.ok(fg, `${theme} ${dark ? "暗" : "亮"}色（底 ${bg}）无解：高亮色回退了 inherit`);
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= 4.5,
          `${theme} ${dark ? "暗" : "亮"}色 mention 高亮对比不足：fg=${fg} bg=${bg} → ${ratio.toFixed(2)}`,
        );
        // 与气泡正文文字色不同，否则等于没区分
        const mine = bg === c.mineBubble;
        assert.notEqual(fg, mine ? c.mineText : c.otherText);
      }
    }
  }
});

test("mention 高亮色：底色读不到时给主题中性底的安全档（accent 实底必须靠显式底色）", () => {
  for (const theme of THEME_COLORS) {
    for (const dark of [false, true]) {
      const c = resolveChatColors("theme", theme, dark);
      for (const unknown of [undefined, ""]) {
        const fg = mentionHighlightColor(theme, dark, unknown);
        assert.ok(fg, `${theme} ${dark ? "暗" : "亮"}色底色未知时回退了 inherit`);
        // 底色未知时只能保证"主题内中性底"（对方气泡）这一侧：
        // 2026-11-07 自己气泡改成 accent 实底后，深底与浅底需要相反方向的色，
        // 一个兜底值不可能同时满足两边 —— 实底那侧必须由调用方传真实底色（上一条测试已覆盖）。
        const bg = c.otherBubble;
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= 4.5,
          `${theme} ${dark ? "暗" : "亮"}色未知底 → 对 ${bg} 只有 ${ratio.toFixed(2)}`,
        );
        // 且不得比试算结果更浅/更亮，否则说明末端选反了
        const solved = mentionHighlightColor(theme, dark, bg);
        const [, , lf] = toHsl(fg);
        const [, , ls] = toHsl(solved);
        assert.ok(dark ? lf >= ls : lf <= ls, `${theme} ${dark ? "暗" : "亮"}末端档选反了`);
      }
    }
  }
});

// 底色兜底只能有一份事实：组件里再写一个 hex 字面量 = 抄走主题 token 的值，
// token 一改这边静默失准（历史上气泡与全文弹窗两处抄的还是不同的值）。
test("组件调 mentionHighlightColor 不得自带兜底色", () => {
  for (const rel of [
    "components/message/MessageTextBubble.vue",
    "components/message/MessageContentModal.vue",
    "components/chat/MessageComposer.vue",
  ]) {
    const src = readFileSync(join(import.meta.dirname, "..", rel), "utf8");
    const calls = src
      .split("\n")
      .filter((l) => l.includes("mentionHighlightColor(") && !l.trim().startsWith("//"));
    assert.ok(calls.length > 0, `${rel} 不再调用 mentionHighlightColor？守卫需重定位`);
    for (const line of calls) {
      assert.ok(
        !line.includes("#"),
        `${rel} 的调用里出现了硬编码兜底色（底色未知应把空串传下去）：${line.trim()}`,
      );
    }
  }
});

/**
 * 自己卡片改成主题气泡色之后，danger / warning 必须仍能在该底色上读出来。
 *
 * 钉的是 7 套预设 × 明暗 × 全部代表主题：`readableToneOn` 返回的颜色对比度 ≥ 4.5。
 * 少了这一条，"自己卡片跟主题"就会在某些深色实底上变成"状态文字看不见"。
 */
test("语气色：自己卡片的 danger/warning 在全部预设与主题下对比 ≥ 4.5", () => {
  const combos = CHAT_PRESETS.flatMap((p) =>
    (p.key === "theme" ? THEME_COLORS : [THEME_COLORS[0]]).flatMap((theme) =>
      [false, true].map((dark) => ({ key: p.key, theme, dark })),
    ),
  );
  for (const c of combos) {
    const colors = resolveChatColors(c.key, c.theme, c.dark);
    const tone = c.dark ? "dark" : "light";
    for (const [name, ink] of [
      ["danger", UI_TONE_INKS.danger[tone]],
      ["warning", UI_TONE_INKS.warning[tone]],
    ] as const) {
      const fg = readableToneOn(colors.mineBubble, ink);
      const ratio = contrastRatio(fg, colors.mineBubble);
      assert.ok(
        ratio >= 4.5,
        `${c.key}/${c.dark ? "暗" : "亮"}/${c.theme} 的 ${name} 对比只有 ${ratio.toFixed(2)}：${fg} on ${colors.mineBubble}`,
      );
    }
  }
});

/** 颜色常量与 `style.css` 的 token 必须同值：写死两份而不对账，下一次改主题就会漂。 */
test("UI_TONE_INKS 与 style.css 的 danger/warning token 逐值相等", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "style.css"), "utf8");
  const { light, dark } = parseTokenScopes(css);
  for (const [scope, map] of [["light", light], ["dark", dark]] as const) {
    assert.equal(map.get("--gosslan-danger-ink"), UI_TONE_INKS.danger[scope], `${scope} danger`);
    assert.equal(map.get("--gosslan-warning-ink"), UI_TONE_INKS.warning[scope], `${scope} warning`);
  }
});
