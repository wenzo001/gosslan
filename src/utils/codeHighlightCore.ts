/**
 * 代码高亮的**纯计算**部分：Worker 与主线程降级路径共用同一份。
 *
 * 为什么把语言注册与 highlightAuto 从 `CodeBlock.vue` 搬出来：
 * 2026-10-26 冷跳纯代码区首帧 164.1ms（longtask 166ms，17 行）—— 每张卡都同步跑
 * `highlightAuto`（15 种语言）+ `highlight`，还在渲染里各挂一份完整主题 `<style>`。
 * 现在首帧只渲染转义后的纯文本，高亮在 Worker 里算完再回填；主题全局一份。
 *
 * 本模块不碰 DOM / Worker，`node --test` 可以直接跑。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import xml from "highlight.js/lib/languages/xml";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { escHtml } from "./highlight.ts";
import { normalizeCodeLanguage, PLAINTEXT } from "./codeLanguages.ts";

export interface HighlightResult {
  html: string;
  lang: string;
}

export interface DetectResult {
  lang: string | null;
  relevance: number;
}

const AUTO_LANGS = [
  "rust", "javascript", "typescript", "python", "java", "go", "json", "bash",
  "sql", "html", "css", "xml", "yaml", "markdown",
];

/**
 * 自动识别的两道门：绝对相关度 + 必须**严格领先**第二名。
 * 只有 5 分的老阈值会把 `SELECT` 这种短词也判成 SQL；这里要求至少 8 分，
 * 且与第二名打平就视为「不确定」落纯文本（宁可不上色，也不上错色）。
 * 不要求大比分领先：JS/TS 这类同族语言本来就接近，按第一名即可。
 */
const AUTO_MIN_RELEVANCE = 8;
const AUTO_SAMPLE_MAX = 4000;

let registered = false;
function ensureLanguages() {
  if (registered) return;
  registered = true;
  for (const [name, language] of Object.entries({
    bash, css, go, xml, java, javascript, json, markdown, python, rust, sql, typescript, yaml,
  })) {
    hljs.registerLanguage(name, language);
  }
  hljs.registerLanguage("html", xml);
}

/**
 * 语言名是否被本模块认识。
 * 归一化后 `plaintext` 也返回 null —— 它不是一个可高亮的语言，由调用方显式走纯文本。
 */
export function knownLanguage(language?: string | null): string | null {
  ensureLanguages();
  const normalized = normalizeCodeLanguage(language);
  if (!normalized || normalized === PLAINTEXT) return null;
  return hljs.getLanguage(normalized) ? normalized : null;
}

/**
 * 自动识别语言（成熟方案 = highlight.js `highlightAuto`，离线随包发布，无新依赖）。
 * 两道门都过才返回语言；否则返回 null，调用方落纯文本。
 */
export function detectCodeLanguage(code: string): DetectResult {
  ensureLanguages();
  try {
    const r = hljs.highlightAuto(code.slice(0, AUTO_SAMPLE_MAX), AUTO_LANGS);
    const second = r.secondBest?.relevance ?? 0;
    if (!r.language || r.relevance < AUTO_MIN_RELEVANCE) {
      return { lang: null, relevance: r.relevance };
    }
    if (second > 0 && second >= r.relevance) {
      return { lang: null, relevance: r.relevance };
    }
    return { lang: r.language, relevance: r.relevance };
  } catch {
    /* 自动检测失败就按纯文本 */
    return { lang: null, relevance: 0 };
  }
}

/**
 * 同步高亮（Worker 内部与降级路径用）。
 * 显式 `plaintext` / 认不出 / 自动识别不确定时，返回**转义后的纯文本**；
 * 绝不把原文当 HTML 插进去。
 */
export function highlightCode(code: string, language?: string | null): HighlightResult {
  ensureLanguages();
  if (normalizeCodeLanguage(language) === PLAINTEXT) {
    return { html: escHtml(code), lang: PLAINTEXT };
  }
  let lang = knownLanguage(language);
  if (!lang) lang = detectCodeLanguage(code).lang;
  if (lang && hljs.getLanguage(lang)) {
    try {
      return { html: hljs.highlight(code, { language: lang }).value, lang };
    } catch {
      /* 落到纯文本 */
    }
  }
  return { html: escHtml(code), lang: PLAINTEXT };
}
