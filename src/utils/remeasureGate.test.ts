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
    /if \(!shouldRemeasure\(lastWidth, inner\)\) return;/.test(src),
    "measure() 里必须有一道『宽度没变就 return』—— 缺了它，RO 的高度回调会重新算列数，环就闭上",
  );
  assert.ok(src.includes("lastWidth = inner"), "通过门之后必须更新基线，否则每帧都判『变了』");
});
