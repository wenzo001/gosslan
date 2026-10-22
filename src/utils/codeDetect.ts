/**
 * 发送前的代码识别（保守）：只有**围栏**或“多行 + 至少两个结构信号”才判代码，
 * 单行、URL、中文段落不判。语言只用于 UI 标签与 highlight.js 的初始猜测，不落库。
 */
export interface CodeDetection {
  likely: boolean;
  language: string | null;
}

const FENCE = /^```([^\n`]*)\n([\s\S]*?)\n?```\s*$/;
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
};

function normLang(raw: string): string | null {
  const l = raw.trim().toLowerCase();
  if (!l) return null;
  return LANG_ALIAS[l] ?? l;
}

function guessLanguage(src: string): string | null {
  if (/^#!.*\bpython/.test(src)) return "python";
  if (/^#!.*\bnode/.test(src)) return "javascript";
  try {
    const v = JSON.parse(src);
    if (v !== null && typeof v === "object") return "json";
  } catch {
    /* 不是 JSON，继续猜 */
  }
  if (/\b(fn|pub|impl|struct|enum|use|mod)\b/.test(src)) return "rust";
  if (/\b(def|import|from|class)\b/.test(src) && /:\s*$|\bself\b/m.test(src)) return "python";
  if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b[\s\S]+\b(FROM|INTO|TABLE|WHERE)\b/i.test(src)) {
    return "sql";
  }
  if (/^\s*<(!doctype|html|xml|\?xml)/i.test(src)) return "xml";
  if (/\b(function|const|let|var|interface|type|=>|import|export)\b/.test(src)) {
    return "typescript";
  }
  return null;
}

export function detectCode(text: string): CodeDetection {
  const src = text.trim();
  if (!src) return { likely: false, language: null };
  const fence = src.match(FENCE);
  if (fence) return { likely: true, language: normLang(fence[1]) };

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
  return { likely: signals >= 2, language: signals >= 2 ? guessLanguage(src) : null };
}

/** 发送时去掉外层 ```lang 围栏；没有围栏则原样返回。 */
export function stripCodeFence(text: string): { text: string; language: string | null } {
  const m = text.trim().match(FENCE);
  if (!m) return { text, language: null };
  return { text: m[2], language: normLang(m[1]) };
}
