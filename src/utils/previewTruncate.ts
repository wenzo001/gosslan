/**
 * 消息流里的**字符预算截断**（2026-11-08，用户要求）。
 *
 * 用户原话：「到上限那一行就截断，结尾用**真实的省略号字符**『…』，不要靠 CSS 的半截字或
 * 渐变遮罩糊过去」「不要为了显示两行把整段长文本/超长代码都塞进 DOM 再让 CSS 裁」。
 *
 * 所以这个文件回答的是**进 DOM 之前**那一刀：
 * - 按「行数 × 每行列数」的预算走字素簇（grapheme cluster），到第 N 行放不下时停手；
 * - 结尾补一个真正的 U+2026 字符（不是 `text-overflow` 生成的、也不是渐变遮罩）；
 * - 预算内装得下就**原样返回**（`truncated: false`），一个字符都不改 —— 短消息的
 *   渲染结果必须与截断前逐字一致。
 *
 * ⚠️ 这个文件**零 import**：`node --test --experimental-strip-types` 解析不了 `@/` 别名，
 * 一旦引入 `@/...` 就只能退回源码扫描判据。可测性优先于就近。
 *
 * ⚠️ `columnWidth` 与 `previewMetrics.visualLineCount` 是**同一口径的一半**：
 * 估算端（决定要不要截断、算消息高度）和渲染端（真正切哪一刀）必须用同一把尺，
 * 否则会出现「估 5 行、实际切出 6 行」这种相邻消息互相遮挡的形状。
 * 唯一来源在本文件，`previewMetrics.ts` 从这里导入。
 */

/** 真实省略号。刻意不用 "..."：三个点会让预算多算 2 列，且用户明确要「真的点点点」。 */
export const ELLIPSIS = "\u2026";

/** 全角字符（CJK 及常用全角标点、emoji）按 2 个半角列计，其余按 1 列。 */
export function columnWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return n;
}

export interface PreviewBudget {
  /** 最多允许的**视觉行数**（文本 5、代码 8）。 */
  lines: number;
  /** 每个视觉行最多放多少个半角列。 */
  columns: number;
}

export interface PreviewResult {
  /** 要渲染的正文（未截断时与入参逐字相同）。 */
  text: string;
  /** 这一次是否真的切掉了内容（操作条/「还有 N 行」靠它决定显不显示）。 */
  truncated: boolean;
}

/**
 * 按字素簇迭代（ZWJ 家庭、肤色、旗帜、VS16 都是一个单位）。
 * 没有 `Intl.Segmenter` 的极端环境退化为按码点（`for…of` 天然不劈代理对）。
 */
function* eachGrapheme(s: string): Iterable<string> {
  const SegmenterCtor = (
    Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: string },
      ) => { segment: (v: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (SegmenterCtor) {
    const seg = new SegmenterCtor(undefined, { granularity: "grapheme" });
    for (const part of seg.segment(s)) yield part.segment;
    return;
  }
  for (const ch of s) yield ch;
}

/**
 * 把正文截到「`lines` 行 × `columns` 列」以内，并在结尾补真实省略号。
 *
 * 语义细节（每条都有对应的判据）：
 * 1. **装得下就一个字都不动** —— 返回原文，`truncated: false`。短消息零影响。
 * 2. **显式换行也占一行** —— `\n` 与「折行」是同一件事的两个来源，都记进预算。
 * 3. **省略号必须留在最后一个可见行里** —— 最后一列刚好占满时，从尾部回退字素簇
 *    （可能回退掉整个字或空格），直到 `末行列数 + 1 ≤ columns`；否则「…」会被折到
 *    第 `lines + 1` 行，卡片高度当场超一截。
 * 4. **字素簇整簇进 / 整簇出** —— 绝不切出半个 emoji、半个组合字符。
 * 5. **尾部空白先去掉** 再补省略号（"内容 + 一大段空格"截断后不该变成"内容 + 空格 + …"）。
 */
export function clampPreview(content: string, budget: PreviewBudget): PreviewResult {
  if (!content) return { text: "", truncated: false };
  const maxLines = Math.max(1, Math.floor(budget.lines));
  const maxColumns = Math.max(1, Math.floor(budget.columns));

  let line = 1;
  let used = 0;
  const kept: string[] = [];
  let truncated = false;

  for (const g of eachGrapheme(content)) {
    if (g === "\n") {
      if (line >= maxLines) {
        truncated = true;
        break;
      }
      line += 1;
      used = 0;
      kept.push(g);
      continue;
    }
    const w = columnWidth(g);
    if (used + w > maxColumns) {
      if (line >= maxLines) {
        truncated = true;
        break;
      }
      line += 1;
      used = 0;
    }
    used += w;
    kept.push(g);
  }

  // 预算内装得下：原样返回（这一条保证短消息与改动前逐字一致）。
  if (!truncated) return { text: content, truncated: false };

  // 尾部空白不占省略号的位置；退掉多少个字素，就把当前视觉行已用的列数一起退回去。
  while (kept.length > 0 && /\s/.test(kept[kept.length - 1])) {
    const g = kept.pop() as string;
    used = g === "\n" ? 0 : used - columnWidth(g);
  }
  // 给省略号腾出 1 列：最后一列占满时要回退字素簇，而不是让「…」折到第 lines+1 行。
  // 只回退到最后一个换行为止 —— 一旦退过换行，行号就少了一条，预算本来就变宽了。
  while (
    kept.length > 0 &&
    kept[kept.length - 1] !== "\n" &&
    used + columnWidth(ELLIPSIS) > maxColumns
  ) {
    const g = kept.pop() as string;
    used -= columnWidth(g);
  }

  return { text: kept.join("") + ELLIPSIS, truncated: true };
}
