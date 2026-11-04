/**
 * 代码语言目录（唯一真源）：UI 选择器、围栏标签归一化、高亮分发都读这一份。
 *
 * 为什么不在各组件里各写一张表：语言别名（js/ts/py/rs/sh/yml…）与「纯文本」这个
 * 特殊档位必须**同源**，否则「输入框显示 typescript、气泡头显示 ts」这类漂移查不出来。
 * 只列 highlight.js core 已注册的语言；没注册的标签统一落 `plaintext`，
 * 宁可不高亮，也不拿另一个语言猜错。
 */
export const CODE_LANGUAGES = [
  "rust",
  "typescript",
  "javascript",
  "python",
  "java",
  "go",
  "json",
  "bash",
  "sql",
  "html",
  "css",
  "xml",
  "yaml",
  "markdown",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** 选择器里的「纯文本」档：仍是一个代码块，只是不高亮。 */
export const PLAINTEXT = "plaintext";

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  htm: "html",
};

const PLAINTEXT_ALIASES = new Set(["plain", "plaintext", "text", "txt", "none"]);

/**
 * 归一化一个语言标签。
 * - 空 / `auto` / 未提供 ⇒ `null`（交给 highlight.js 自动识别）
 * - 已知语言（含别名）⇒ 规范名
 * - `plain`/`text`/`txt` ⇒ `plaintext`
 * - 不认识的非空标签 ⇒ `plaintext`（不猜错）
 */
export function normalizeCodeLanguage(raw?: string | null): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "auto") return null;
  const alias = ALIASES[value];
  if (alias) return alias;
  if (PLAINTEXT_ALIASES.has(value)) return PLAINTEXT;
  return (CODE_LANGUAGES as readonly string[]).includes(value) ? value : PLAINTEXT;
}

export function isPlaintextLanguage(raw?: string | null): boolean {
  return normalizeCodeLanguage(raw) === PLAINTEXT;
}

/** 语言自身名词（不翻译）；选择器对 auto/纯文本两项走 i18n。 */
export const CODE_LANGUAGE_LABELS: Record<string, string> = {
  rust: "Rust",
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  go: "Go",
  json: "JSON",
  bash: "Shell",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  xml: "XML",
  yaml: "YAML",
  markdown: "Markdown",
};

export function codeLanguageLabel(lang?: string | null): string {
  const normalized = normalizeCodeLanguage(lang);
  if (!normalized) return "";
  if (normalized === PLAINTEXT) return "";
  return CODE_LANGUAGE_LABELS[normalized] ?? normalized;
}
