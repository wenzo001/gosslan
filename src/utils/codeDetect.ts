/**
 * 发送前的代码识别（保守）：只有**围栏**或“多行 + 至少两个结构信号”才判代码，
 * 单行、URL、中文段落不判。
 *
 * 这里**不再猜语言**：过去那套 `guessLanguage` 正则（rust/python/sql/ts…）属于
 * 手写启发式大礼包，短片段经常猜错。语言统一交给 highlight.js 的 `highlightAuto`
 * （`utils/codeHighlightCore` 的 `detectCodeLanguage`，成熟方案、离线随包），
 * 发送前的标签走 Worker 异步识别；识别不确定时落纯文本。
 * 围栏里**已标**的语言仍然优先按标记走（见 `stripCodeFence`）。
 */
import { normalizeCodeLanguage } from "./codeLanguages.ts";

export interface CodeDetection {
  likely: boolean;
  language: string | null;
}

const FENCE = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/;

export function detectCode(text: string): CodeDetection {
  const src = text.trim();
  if (!src) return { likely: false, language: null };
  const fence = src.match(FENCE);
  if (fence) return { likely: true, language: normalizeCodeLanguage(fence[1]) };

  const lines = src.split("\n");
  if (lines.length < 2) return { likely: false, language: null };
  let signals = 0;
  if (lines.some((l) => /^\s{2,}\S/.test(l))) signals++;
  if (/[{};]/.test(src)) signals++;
  if (
    /\b(function|const|let|var|import|export|class|def|fn|pub|struct|enum|impl|return|if|for|while|SELECT|FROM|WHERE|INSERT|UPDATE)\b/i.test(
      src,
    )
  ) {
    signals++;
  }
  if (/^#!/.test(src)) signals++;
  if (/^\s*[[{][\s\S]*[\]}]\s*$/.test(src)) signals++;
  return { likely: signals >= 2, language: null };
}

/** 发送时去掉外层 ```lang 围栏；没有围栏则原样返回。 */
export function stripCodeFence(text: string): { text: string; language: string | null } {
  const m = text.trim().match(FENCE);
  if (!m) return { text, language: null };
  return { text: m[2], language: normalizeCodeLanguage(m[1]) };
}
