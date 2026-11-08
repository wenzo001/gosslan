/**
 * 长文本 / 超长代码的**字符预算截断**（2026-11-08，用户实测提出）。
 *
 * 用户原话：「到上限那一行就截断，结尾用**真实的省略号字符**『…』，不要靠 CSS 的半截字
 * 或渐变遮罩糊过去」「不要让整个界面有这个长文本渲染压力」。
 *
 * 两层判据：
 * 1. **行为**（`clampPreview`）：切出来的东西必须是「N 行以内 + 结尾一个 U+2026」，
 *    字素簇不许劈开，预算内装得下就一个字都不改。
 * 2. **接线**（源码扫描）：气泡真正送进渲染的那份正文必须是截断后的预览。
 *    这一条是"把截断改回整段塞进 DOM 必须红"的本体 —— 反例自证写在每条断言后面。
 *
 * 真正的 DOM 节点数 / 首屏耗时读数在 `scripts/check-ui-runtime.mjs --only=previewbudget`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ELLIPSIS, clampPreview, columnWidth } from "./previewTruncate.ts";

const root = join(import.meta.dirname, "..", "..");

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

/** 独立的行数测量（不复用被测代码的记账）：每个逻辑行按列数折行后累加。 */
function visualLines(text: string, columns: number): number {
  let n = 0;
  for (const line of text.split("\n")) n += Math.max(1, Math.ceil(columnWidth(line) / columns));
  return n;
}

// ---------------- 行为 ----------------

test("省略号必须是真实的 U+2026，不是三个点", () => {
  assert.equal(ELLIPSIS, "\u2026");
  assert.equal([...ELLIPSIS].length, 1, "一个字符，不是 '...'");
});

test("装得下就一个字符都不改（短消息零影响）", () => {
  const short = "在吗？晚点一起对下 UI。";
  const r = clampPreview(short, { lines: 5, columns: 35 });
  assert.equal(r.truncated, false);
  assert.equal(r.text, short, "未截断时必须与原文逐字一致");
});

test("文本：5 行 × 35 列以内，结尾是真实省略号", () => {
  const long = "这是一段很长的正文。".repeat(80); // 1600 字符 / 3200 列
  const r = clampPreview(long, { lines: 5, columns: 35 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith(ELLIPSIS), "必须以真实省略号收尾");
  assert.ok(visualLines(r.text, 35) <= 5, `截断后不得超过 5 行（实测 ${visualLines(r.text, 35)}）`);
  assert.ok(columnWidth(r.text) < 5 * 35 + 35, "截断后总量必须落在预算内");
  assert.ok(r.text.length < long.length / 3, "必须真的切短，不是原样返回");
});

test("显式换行也占一行：第 5 行之后的内容全部丢掉", () => {
  const code = Array.from({ length: 40 }, (_, i) => `第${i}行`).join("\n");
  const r = clampPreview(code, { lines: 5, columns: 35 });
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length, 5, "正好 5 个逻辑行（最后一行带省略号）");
  assert.ok(r.text.endsWith(ELLIPSIS));
  assert.ok(r.text.startsWith("第0行"), "必须从第一行开始");
  assert.ok(!r.text.includes("第5行"), "第 6 行起必须整行不见");
});

test("最后一列占满时先回退字素，省略号不许被顶到第 N+1 行", () => {
  // 35 列 × 5 行整满，再多一个字：直接补省略号会折到第 6 行。
  const full = "a".repeat(35 * 5) + "x";
  const r = clampPreview(full, { lines: 5, columns: 35 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith(ELLIPSIS));
  assert.ok(visualLines(r.text, 35) <= 5, "省略号必须留在第 5 行里");
  // 反例自证：不预留这 1 列就会读到 6 行。
  assert.equal(visualLines("a".repeat(35 * 5) + ELLIPSIS, 35), 6, "反例自证：整满 + 省略号确实会多出一行");
});

test("字素簇整簇进整簇出：emoji / 组合字符 / 变体选择符不许被劈开", () => {
  const cases = [
    "👨‍👩‍👧‍👦", // ZWJ 家庭
    "🏳️‍🌈", // 旗帜 + VS16 + ZWJ
    "👍🏽", // 肤色修饰
    "🇨🇳", // 国旗（两个 regional indicator）
    "e\u0301", // e + 组合重音
  ];
  for (const g of cases) {
    // 一行的预算：只放得下"一个字素簇 + 省略号"，任何按码点切的实现都会切出半个。
    const r = clampPreview(g.repeat(5), { lines: 1, columns: columnWidth(g) + 1 });
    assert.ok(r.truncated, `${g} 应被判为截断`);
    const body = r.text.slice(0, -1);
    assert.ok(g.repeat(5).startsWith(body), `${g} 切出来的必须是原文前缀`);
    const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body)].map((p) => p.segment);
    assert.ok(parts.length >= 1, `${g} 至少保留一个完整字素簇`);
    assert.ok(parts.every((p) => p === g), `${g} 不许切出半个簇，实际切出 ${JSON.stringify(body)}`);
  }
});

test("CJK 按两列算：中日韩正文的 5 行容量约等于半角的一半", () => {
  const half = clampPreview("x".repeat(400), { lines: 5, columns: 35 });
  const full = clampPreview("字".repeat(400), { lines: 5, columns: 35 });
  assert.ok(full.text.length < half.text.length, "全角正文切出来的字符数必须更少");
  assert.ok(columnWidth(full.text) <= 5 * 35, "全角按 2 列计也必须落在预算内");
});

test("代码：8 行 × 列数以内，结尾是真实省略号", () => {
  const code = Array.from({ length: 681 }, (_, i) => `  const v${i} = compute(${i});`).join("\n");
  const r = clampPreview(code, { lines: 8, columns: 70 });
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length, 8, "折叠态正好 8 个逻辑行");
  assert.ok(r.text.endsWith(ELLIPSIS));
  assert.ok(r.text.length <= 8 * 70 + 1, `截断后必须只剩一小段（实测 ${r.text.length} 字符）`);
  assert.ok(r.text.startsWith("  const v0 = compute(0);"), "必须从第一行原样开始");
});

test("单行超长代码：在第 N 行的列边界处切开，不留半行", () => {
  const oneLine = "x".repeat(5000);
  const r = clampPreview(oneLine, { lines: 8, columns: 70 });
  assert.equal(r.truncated, true);
  assert.equal(visualLines(r.text, 70), 8, "正好铺满 8 个视觉行");
  assert.ok(r.text.endsWith(ELLIPSIS));
});

// ---------------- 接线（把截断改回"整段塞进 DOM"必须红） ----------------

test("MessageTextBubble：送进切段的是截断后的预览，不是整段原文", () => {
  const src = read("src", "components", "message", "MessageTextBubble.vue");
  assert.ok(src.length > 2000, "锚点失效：MessageTextBubble.vue 读不到");
  assert.match(
    src,
    /useMessageSegments\(\s*\(\)\s*=>\s*preview\.value\.text,/,
    "切段入口必须吃 preview.text（进 DOM 前已截断）",
  );
  assert.match(src, /clampPreview\(parsed\.value\.body,\s*\{\s*lines:\s*PREVIEW_LINES,/, "必须按 PREVIEW_LINES 行预算截断");
  assert.doesNotMatch(
    src,
    /useMessageSegments\(\s*\(\)\s*=>\s*parsed\.value\.body,/,
    "整段正文不许直接进 DOM",
  );

  // 反例自证：换回整段原文，上面两条必须能识别。
  const mutated = src.replace("() => preview.value.text,", "() => parsed.value.body,");
  assert.notEqual(mutated, src, "反例自证：切段入口没被替换到，锚点已漂");
  assert.match(
    mutated,
    /useMessageSegments\(\s*\(\)\s*=>\s*parsed\.value\.body,/,
    "反例自证：整段塞回 DOM 后必须能识别（否则等于没守）",
  );
});

test("MessageCodeBubble：折叠态按 CODE_PREVIEW_LINES 行预算截断", () => {
  const src = read("src", "components", "message", "MessageCodeBubble.vue");
  assert.match(src, /clampPreview\(props\.code,\s*\{\s*lines:\s*CODE_PREVIEW_LINES,/, "必须按代码自己的 8 行预算截断");
  assert.match(src, /:code="previewCode\.text"/, "CodeBlock 必须吃截断后的代码");
});

test("展开与复制拿到的仍是**原文**（预览只影响渲染，不影响数据）", () => {
  const text = read("src", "components", "message", "MessageTextBubble.vue");
  const code = read("src", "components", "message", "MessageCodeBubble.vue");
  assert.match(text, /emit\('expand', content\)/, "展开必须传完整 content");
  assert.match(text, /emit\('copy', content\)/, "复制必须传完整 content");
  assert.match(code, /emit\('expand', code\)/, "展开必须传完整 code");
  assert.match(code, /emit\('copy', code\)/, "复制必须传完整 code");
});
