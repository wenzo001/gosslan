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

export interface HighlightResult {
  html: string;
  lang: string;
}

const AUTO_LANGS = [
  "rust", "javascript", "typescript", "python", "java", "go", "json", "bash", "shell",
  "sql", "html", "css", "xml", "yaml", "markdown",
];

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

/** 语言名是否被本模块认识（未知/空一律返回 null，由 auto 检测决定）。 */
export function knownLanguage(language?: string): string | null {
  ensureLanguages();
  return language && hljs.getLanguage(language) ? language : null;
}

/**
 * 同步高亮（Worker 内部与降级路径用）。
 * 认不出语言时按 `plaintext` 返回**转义后的纯文本**，绝不把原文当 HTML 插进去。
 */
export function highlightCode(code: string, language?: string): HighlightResult {
  ensureLanguages();
  let lang = knownLanguage(language);
  if (!lang) {
    try {
      const r = hljs.highlightAuto(code, AUTO_LANGS);
      if (r.language && r.relevance >= 5) lang = r.language;
    } catch {
      /* 自动检测失败就按纯文本 */
    }
  }
  if (lang && hljs.getLanguage(lang)) {
    try {
      return { html: hljs.highlight(code, { language: lang }).value, lang };
    } catch {
      /* 落到纯文本 */
    }
  }
  return { html: escHtml(code), lang: "plaintext" };
}
