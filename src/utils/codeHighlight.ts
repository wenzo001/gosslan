/**
 * 代码高亮的调度层：一个懒创建的 Worker + 有界结果缓存 + 同键去重。
 *
 * 首帧不等待：`CodeBlock` 先用 `escHtml` 渲染纯文本，再在 Worker 回包后替换 innerHTML。
 * 滚回同一段代码时走缓存（同步命中），不会先白一下再上色。
 *
 * Worker 不可用（极老 WebView / CSP 拒绝 / 构造抛错）时降到主线程：
 * 用动态 import 只在真需要时把 highlighter 拉进主包，行为与 Worker 一致（只是会占主线程）。
 */
import { trimOldest } from "@/utils/bounded";
import type { HighlightResult } from "@/utils/codeHighlightCore";
import { createSingleFlight } from "./singleFlight.ts";

export type { HighlightResult };

const CACHE_MAX = 200;
const cache = new Map<string, HighlightResult>();
/** 同键并发只发给 Worker 一次；helper 是 `utils/singleFlight` 那一份（不再手抄六行）。 */
const highlightInflight = createSingleFlight<HighlightResult>();

function cacheKey(code: string, language?: string): string {
  return `${language ?? ""}\u0000${code}`;
}

/** 同步查缓存（滚回已高亮过的代码时用；命中时首帧就是彩色）。 */
export function peekHighlight(code: string, language?: string): HighlightResult | null {
  const key = cacheKey(code, language);
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU：命中即移到队尾
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function remember(code: string, language: string | undefined, result: HighlightResult) {
  const key = cacheKey(code, language);
  // 先删再插：重写同一段代码时它也排到队尾。少了这一句，`trimOldest` 会把刚写的那条
  // 当最旧的先丢掉（原先那段"满则删最旧一条"是在写入**前**问的，正好掩盖了这个差别）。
  cache.delete(key);
  cache.set(key, result);
  trimOldest(cache, CACHE_MAX);
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: HighlightResult) => void; code: string; language?: string }>();

function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL("../workers/highlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number } & HighlightResult>) => {
      const { id, html, lang } = event.data;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      const result = { html, lang };
      remember(entry.code, entry.language, result);
      entry.resolve(result);
    };
    worker.onerror = () => {
      // Worker 起不来/运行时炸了：把在飞的请求全部降级到主线程，之后不再尝试 Worker。
      workerBroken = true;
      worker = null;
      const entries = [...pending.values()];
      pending.clear();
      for (const e of entries) void fallback(e.code, e.language).then(e.resolve);
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

async function fallback(code: string, language?: string): Promise<HighlightResult> {
  const { highlightCode } = await import("@/utils/codeHighlightCore");
  const result = highlightCode(code, language);
  remember(code, language, result);
  return result;
}

/** 请求高亮；同键并发只发一次。 */
export function requestHighlight(code: string, language?: string): Promise<HighlightResult> {
  const cached = peekHighlight(code, language);
  if (cached) return Promise.resolve(cached);
  return highlightInflight.run(cacheKey(code, language), () => {
    const w = ensureWorker();
    if (!w) return fallback(code, language);
    return new Promise<HighlightResult>((resolve) => {
      const id = ++seq;
      pending.set(id, { resolve, code, language });
      w.postMessage({ id, code, language });
    });
  });
}
