/**
 * 字素簇边界（用户眼里的「一个字」）。
 *
 * 用途：输入框里粘贴进来的原生 emoji（不是我们自己的图片 token）退格时要整簇删除。
 * 两个表情 `😀😀` 在 UTF-16 里是 4 个 code unit，按 code unit 删一次会切掉半个表情；
 * ZWJ 家庭 `👨‍👩‍👧` 是 8 个 unit、肤色 `👍🏽` 是 4 个、旗帜 `🇨🇳` 也是 4 个 —— 都必须按
 * **扩展字素簇**删，否则会出现"删一半变问号/两个表情一起没"。
 *
 * 实现用 `Intl.Segmenter`（Chromium 87+ / WebKit 15+ 都有）。只为最后 64 个 UTF-16 单位
 * 建索引，成本与输入框长度无关（草稿上限 50k 字符）。
 *
 * 没有 Segmenter 的极端环境只保证不劈开代理对；ZWJ/肤色/旗帜退化为"按码点删"。
 */
export function graphemeStartBefore(text: string, offset: number): number {
  const end = Math.max(0, Math.min(offset, text.length));
  if (end === 0) return 0;

  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => {
      segment: (s: string) => Iterable<{ index: number }>;
    };
  }).Segmenter;

  if (SegmenterCtor) {
    const seg = new SegmenterCtor(undefined, { granularity: "grapheme" });
    const from = Math.max(0, end - 64);
    const chunk = text.slice(from, end);
    let start = 0;
    for (const part of seg.segment(chunk)) start = part.index;
    return from + start;
  }

  // 退化：至少把代理对当一个单位（不会切出半个码点）。
  let i = end - 1;
  const lo = text.charCodeAt(i);
  if (i > 0 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = text.charCodeAt(i - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) i -= 1;
  }
  return i;
}

/**
 * caret 之后那一个字素簇的结束偏移（`Delete` 前向删用）。
 *
 * 与 `graphemeStartBefore` 同一套边界，只是往右数：`offset` 落在 `😀😀` 的第一个
 * 表情中间时，返回的是第二个表情的起点，而不是切一半的代理对边界。
 */
export function graphemeEndAfter(text: string, offset: number): number {
  const start = Math.max(0, Math.min(offset, text.length));
  if (start >= text.length) return text.length;
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => {
      segment: (s: string) => Iterable<{ index: number; segment: string }>;
    };
  }).Segmenter;

  if (SegmenterCtor) {
    const seg = new SegmenterCtor(undefined, { granularity: "grapheme" });
    const to = Math.min(text.length, start + 64);
    for (const part of seg.segment(text.slice(start, to))) return start + part.segment.length;
    return to;
  }

  // 退化：至少不劈开代理对。
  const hi = text.charCodeAt(start);
  const isPair =
    hi >= 0xd800 &&
    hi <= 0xdbff &&
    start + 1 < text.length &&
    (text.charCodeAt(start + 1) & 0xfc00) === 0xdc00;
  return start + (isPair ? 2 : 1);
}

/** 同 `needsGraphemeDelete`，方向相反（`Delete` 键）。 */
export function needsGraphemeForwardDelete(text: string, offset: number): boolean {
  if (offset >= text.length) return false;
  return graphemeEndAfter(text, offset) > offset + 1;
}

/**
 * caret 前那一段是否值得由我们接管删除。
 *
 * 只有「跨了不止一个 code unit」的字素簇才需要接管（代理对 / ZWJ / 肤色 / 旗帜）；
 * 普通单字符、中文、英文一律交回浏览器默认行为 —— 那里还挂着原生的 undo 栈。
 */
export function needsGraphemeDelete(text: string, offset: number): boolean {
  if (offset <= 0) return false;
  return graphemeStartBefore(text, offset) < offset - 1;
}
