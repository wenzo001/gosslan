import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  COLUMN_HYSTERESIS,
  WIDTH_EPSILON_PX,
  bubbleColumnCap,
  shouldRemeasure,
} from "./remeasureGate.ts";

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
  // 2026-11-26：同一视口复用实测时字体来自共享值，全量量那一轮仍现读 getComputedStyle。
  assert.ok(
    /const font\s*=\s*reuse \? sharedPreviewFont\.value : getComputedStyle\(el\)\.font;/.test(src),
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

/**
 * 判据 8（2026-11-21 第六刀，**这条是 Windows 抖动的定案**）。
 *
 * 前五刀都在"怎么读宽度"上打补丁，没换**读哪个元素**。读正文自己的宽度是个循环依赖：
 * 气泡收缩贴合 ⇒ 正文宽 = 截断后的内容宽 ⇒ 列数与宽度互为因果。用户 7.1.64 实测量到
 * 闭环的两个稳态（spacer 831.23↔851.23、scrollTop 404↔424、正文文本每拍重写），
 * 而锁死正文宽度后抖动立刻停止 ⇒ 宽度源必须换成与文字无关的「列宽上限」。
 */
test("接线：列数宽度取「列宽上限」而不是正文实测宽（否则截断会反过来决定列数）", () => {
  const composable = readFileSync(
    join(import.meta.dirname, "..", "composables", "usePreviewColumns.ts"),
    "utf8",
  );

  // ① 上限的来源：`.msg-stack` 的 max-width（CSS 里是 min(68%, 560px)，只跟窗口宽有关）。
  assert.ok(
    /el\.closest\("\.msg-stack"\)/.test(composable),
    "没有从 `.msg-stack` 取列宽上限 ⇒ 宽度源还是正文自己，闭环会复活",
  );
  // ⚠️ 这里**反向**钉一条：绝不能 `parseFloat(getComputedStyle(cap).maxWidth)`。
  // `.msg-stack` 上写的是 `max-width: min(68%, 560px)`，而 computed 值不会被解析成 px
  // （真浏览器返回字符串 "min(68%, 560px)" ⇒ parseFloat = NaN）。7.1.65 就是这么
  // "修完还是抖"的：NaN 被判成「没有上限」，静默退回正文实测宽。
  assert.ok(
    !/parseFloat\([^)]*maxWidth\)/.test(composable),
    "又去 parseFloat(maxWidth) 了 —— min() 的 computed 值是字符串，parseFloat 得 NaN（7.1.65 的原病）",
  );
  assert.ok(
    /getPropertyValue\("--gosslan-msg-max"\)/.test(composable) &&
      /getPropertyValue\("--gosslan-msg-max-px"\)/.test(composable),
    "上限必须读 --gosslan-msg-max / --gosslan-msg-max-px 两个令牌自己算 min",
  );
  assert.ok(
    /bubbleColumnCap\(pct, pxLimit, parentContent\)/.test(composable),
    "算了令牌却没交给 bubbleColumnCap —— 判据都在纯函数里，绕过去等于没测",
  );
  // ② 上限是盒宽，正文能用的要扣掉中间各层的左右内边距/边框（气泡的 px-3 就在这里）。
  assert.ok(
    /paddingLeft[\s\S]{0,160}paddingRight[\s\S]{0,160}borderLeftWidth[\s\S]{0,160}borderRightWidth/.test(
      composable,
    ),
    "没扣中间层的水平内边距/边框 ⇒ 列数会多算几个，截断后仍会换到第 6 行（被 CSS 裁掉、省略号看不见）",
  );
  // ③ 优先用它，容器实测宽只做兜底（这个 composable 理论上也能被别处用）。
  //    2026-11-26 起首个输入是"同视口共享的实测"，全量量那一轮仍优先走列宽上限。
  assert.ok(
    /const inner\s*=\s*reuse[\s\S]{0,120}allowedColumnWidth\(el\) \?\?/.test(composable),
    "measure() 没有优先用上限 ⇒ 下面那段兜底代码仍在生效",
  );

  // 反例自证：把优先关系去掉，第三条必须不再命中。
  const gutted = composable.replace("allowedColumnWidth(el) ??", "");
  assert.notEqual(gutted, composable, "变异没落进去 ⇒ 锚点写法变了");
  assert.doesNotMatch(
    gutted,
    /const inner\s*=\s*reuse[\s\S]{0,120}allowedColumnWidth\(el\) \?\?/,
    "去掉优先关系后仍然命中 ⇒ 这条判据在空集上恒绿",
  );
});

/**
 * 判据 9（2026-11-21 第六刀补）：上限的算术。这条是**真行为判据**，不是源码扫描。
 *
 * 7.1.65 的病根是"上限取不到值"，所以三种形状都要钉：百分比能解、像素上限能夹、
 * 两个都拿不到时**必须返回 null**（让调用方明确退回实测宽，而不是拿 0 或 NaN 去算列数）。
 */
test("列宽上限：min(百分数, 像素上限)，任一缺失不编数", () => {
  // 用户机器上的真实读数：行内容宽 592、68% ⇒ 402.56（截图上气泡约 402）
  assert.ok(Math.abs((bubbleColumnCap(68, 560, 592) ?? 0) - 402.56) < 0.01);
  // 宽窗：像素上限 560 夹住
  assert.equal(bubbleColumnCap(68, 560, 2000), 560);
  // 只给百分数
  assert.ok(Math.abs((bubbleColumnCap(68, Number.NaN, 592) ?? 0) - 402.56) < 0.01);
  // 只给像素
  assert.equal(bubbleColumnCap(Number.NaN, 560, 592), 560);
  // 都拿不到 ⇒ null（调用方退回实测宽；**不许**返回 0，否则列数会被 clamp 到 MIN 8）
  assert.equal(bubbleColumnCap(Number.NaN, Number.NaN, 592), null);
  // 包含块量不到 ⇒ null
  assert.equal(bubbleColumnCap(68, 560, 0), null);
  assert.equal(bubbleColumnCap(68, 560, Number.NaN), null);
  // 越界的百分数不采信（宁可退回实测宽，也不用 0.68% 这种脏值算列数）
  assert.equal(bubbleColumnCap(0, Number.NaN, 592), null);
  assert.equal(bubbleColumnCap(120, Number.NaN, 592), null);
});

/**
 * 判据 10：迟滞带存在且是"差一列不跟"这个量级。
 * 宽度源被改坏时（历史上真发生过）它是第二把锁，所以常量本身也要被钉住。
 */
test("列数迟滞带：吸收 ±1 列的翻转，又不能让真实 resize 卡住", () => {
  assert.ok(
    COLUMN_HYSTERESIS >= 2,
    `迟滞带 ${COLUMN_HYSTERESIS} < 2 ⇒ 差一列的翻转照样会被采纳（那正是抖动的形状）`,
  );
  assert.ok(COLUMN_HYSTERESIS <= 4, `迟滞带 ${COLUMN_HYSTERESIS} 太大 ⇒ 缩窗口后列数会明显滞后`);
  // 接线：measure() 真的用了它
  assert.ok(
    /hasMeasured && Math\.abs\(next - columns\.value\) < COLUMN_HYSTERESIS/.test(src),
    "measure() 里没有迟滞判据 ⇒ 这个常量是摆设",
  );
  // ⚠️ 迟滞带**只对已采纳过的真实值**生效：首次测量若被带子挡掉，基线已经提交 ⇒
  // 之后所有回调都在宽度门返回，列数永久停在 fallback 估算值上（review 抓到的坑）。
  assert.ok(
    /if \(hasMeasured && /.test(src),
    "迟滞带没有 hasMeasured 前置 ⇒ 首次真实测量可能被挡，列数永久停在估算值",
  );
  assert.ok(
    /hasMeasured = false;/.test(src),
    "元素换掉时没复位 hasMeasured ⇒ 新元素的首测会被旧元素的「已测过」状态挡住",
  );
});
