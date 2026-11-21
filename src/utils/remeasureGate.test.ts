import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WIDTH_EPSILON_PX, shouldRemeasure } from "./remeasureGate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 判据 1~5：门本身的算术
// ─────────────────────────────────────────────────────────────────────────────

test("首次测量（没有基线）必须放行，否则列数永远停在估算值", () => {
  assert.equal(shouldRemeasure(-1, 320), true);
});

test("宽度没变 ⇒ 拒绝重算 —— 这一条就是「高度环」的断点", () => {
  assert.equal(
    shouldRemeasure(320, 320),
    false,
    "RO 因高度变化回调时宽度不变；放行就会重新算列数，闭环就合上了",
  );
});

test("WebView2 的亚像素抖动不算变化（375.2 vs 375.1999）", () => {
  assert.equal(shouldRemeasure(375.2, 375.1999), false, "150% 缩放下 width 会在亚像素级来回抖");
  assert.equal(shouldRemeasure(375.2, 375.45), false, `容差 ${WIDTH_EPSILON_PX}px 内的抖动一律忽略`);
});

/**
 * 判据 2b（2026-11-21 第二版，**这条是本次修复的核心**）。
 *
 * 用户实测 Windows 是 **125% 缩放**（2560×1440 与 1920×1080 两台机都是）。1.25 缩放下
 * 一个物理像素 = **0.8 CSS px** ⇒ WebView2 把 layout 吸附到物理像素网格后，同一个盒子的
 * `contentRect.width` 在 375.2 / 376.0 之间来回跳。
 *
 * 第一版容差取 0.5（只考虑 Mac 的 2.0 DPR）⇒ 0.8 的抖动**一次也拦不住** ⇒ 闭环照旧，
 * 用户回「改完还在抖」。所以这组真实读数必须进判据：容差小于 0.8 就红。
 */
test("125% 缩放的真实抖动（差 0.8px）必须被吸收 —— 第一版 0.5 就栽在这里", () => {
  assert.equal(
    shouldRemeasure(375.2, 376.0),
    false,
    "0.8px 的吸附抖动被放行 ⇒ 125% 缩放上「列数→高度→RO→列数」闭环照旧",
  );
  assert.equal(shouldRemeasure(376.0, 375.2), false, "反方向同样要拦");
  assert.ok(
    WIDTH_EPSILON_PX >= 1 / 1.25,
    `容差 ${WIDTH_EPSILON_PX}px 必须 ≥ 一个物理像素在 125% 下的 CSS 宽（0.8px），否则这一档白修`,
  );
  // 150% 档（1 物理 px = 0.667 CSS px）顺带钉住：更大的缩放只会更宽，容差 1px 覆盖得住。
  assert.equal(shouldRemeasure(375.0, 375.667), false, "150% 档也要吸收");
});

test("真正的宽度变化要放行（拖窗口 / 缩放 / 换字号）", () => {
  assert.equal(shouldRemeasure(375, 376), true);
  assert.equal(shouldRemeasure(375, 300), true, "一次变窄 75px，必须重算");
});

test("量不到宽度（0 / NaN / 负数）不放行，也不写坏基线", () => {
  assert.equal(shouldRemeasure(320, 0), false);
  assert.equal(shouldRemeasure(320, Number.NaN), false);
  assert.equal(shouldRemeasure(320, -5), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 判据 6：接线。纯函数绿不等于被接上 —— 本次 bug 的原始形态就是
// 「注释里写着切断高度环，代码里没有那道 if」。所以直接读源码钉住。
// ─────────────────────────────────────────────────────────────────────────────

const src = readFileSync(
  join(import.meta.dirname, "..", "composables", "usePreviewColumns.ts"),
  "utf8",
);

test("接线：usePreviewColumns 必须真的调用 shouldRemeasure（注释不算）", () => {
  assert.ok(
    src.includes('from "@/utils/remeasureGate"'),
    "没 import 门 ⇒ 下面那道 if 是凭空的，或有人把它删了",
  );
  const calls = src.split("shouldRemeasure(").length - 1;
  assert.equal(calls, 1, `shouldRemeasure( 的调用点应恰好 1 处（measure 里那道门），实测 ${calls}`);
  assert.ok(
    /const widthChanged = shouldRemeasure\(lastWidth, inner\);/.test(src),
    "measure() 里必须真的拿宽度过门 —— 缺了它，RO 的高度回调会重新算列数，环就闭上",
  );
  assert.ok(src.includes("lastWidth = inner"), "通过门之后必须更新基线，否则每帧都判『变了』");
});

/**
 * 判据 7（2026-11-21 review 修回）：门要**必要不充分**。
 *
 * 只按宽度设门会漏掉第二条合法输入 —— 用户改正文字号时宽度一点不动，`unit` 变了。
 * 这里同时钉两件事：门之后仍有 return（环不复活），以及字体指纹参与判决（字号能跟上）。
 */
test("接线：宽度没变时还要看字体 —— 只按宽度设门会挡掉「改字号」这条合法路径", () => {
  assert.ok(
    /if \(!widthChanged && font === lastFont\) return;/.test(src),
    "门退化成了只看宽度 ⇒ 改字号后列数不再重算（气泡 5 行截断按旧字号切，多出/少掉半行）",
  );
  assert.ok(
    /const font = getComputedStyle\(el\)\.font;/.test(src),
    "没有取字体指纹 ⇒ 上面那半个条件恒真，等于没接",
  );
  assert.ok(
    /halfCharWidth\(font\)/.test(src),
    "unit 不是用同一个字体串量出来的 ⇒ 指纹与量法不同源",
  );
  // 反例自证：把字体那半个条件删掉，必须不再命中（否则这条判据守的是别的字符串）。
  const gutted = src.replace("if (!widthChanged && font === lastFont) return;", "if (!widthChanged) return;");
  assert.notEqual(gutted, src, "变异没落进去 ⇒ 锚点写法变了");
  assert.doesNotMatch(
    gutted,
    /if \(!widthChanged && font === lastFont\) return;/,
    "删掉字体条件后仍然命中 ⇒ 这条判据在空集上恒绿",
  );
});
