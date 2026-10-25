// 只读诊断量具：真实 VirtualList + 真实 MessageItem，回答四个问题（不改业务码）：
//   1. 快速滚动时视口里有没有「未覆盖空白带」（白屏/白缝），持续多少帧；
//   2. 一次远距跳转要几帧才铺满视口；
//   3. 异步内容（图片骨架 → 失败占位 128px）在阅读中修正高度时，锚点漂多少；
//   4. 估算 vs 实测的逐 kind 误差、每帧行重定位次数、长帧。
//
// 与生产同一段代码：VirtualList（含 overscan=6 / TanStack 选项）、MessageItem、estimateMessageHeight
// 都是应用里那一份；只有「消息数据」和「外壳布局」是本文件造的。
//
// 口径（写在这里防止被读成别的）：
//   · 空白带 = 视口 [0, clientHeight] 内没有任何 `[data-vlist-key]` 行覆盖的纵向区间，
//     宽度 > 1px 才计入。**这正是用户看到的白**（行底色透明、列表底是白）。
//   · 采样点在 rAF 回调里：浏览器顺序是 scroll steps → 微任务 → rAF 回调 → 绘制，
//     所以读到的是「这一帧将要绘制」的 DOM。不是事后回看。
//   · 本页没有 Rust 后端：图片/文件预览会失败（骨架 288 → 失败占位 128），
//     那一步**本身就是生产里真实存在的异步改高**（成功时是 288 → 横图 ~117）。差别只落在终值。

import { createApp, defineComponent, h, onMounted, ref } from "vue";
import { createPinia } from "pinia";
import VirtualList from "@/components/VirtualList.vue";
import MessageItem from "@/components/MessageItem.vue";
import { estimateMessageHeight } from "@/utils/messageHeight";
import { shouldShowTimeDivider } from "@/utils/previewMetrics";
import { groupSide, isKnownKind } from "@/utils/messageKinds";
import { EMPTY_REACTION_CHIPS, EMPTY_STRING_LIST } from "@/utils/emptyList";
import "@/style.css";

const params = new URLSearchParams(location.search);
const N = Math.max(20, Number(params.get("n") ?? 1200));
const MIX = params.get("mix") ?? "default";
/** 与 ChatWindow 生产形状一致的开关（默认关：诊断台要单独观察库自身行为）。 */
const AUTO = params.get("auto") === "1";
/** 图片/文件预览的模拟延迟：0 = 立刻成功；>0 = 先按骨架 288 显示，再在延迟后收缩到真实高度。 */
let previewDelay = Math.max(0, Number(params.get("previewDelay") ?? "0"));

let invokeCount = 0;
let pngCache: number[] | null = null;
/** 320×180（16:9）的真实 PNG ⇒ 真实高度 = min(288, 208 × 180/320) ≈ 117px，与生产横图同形。 */
function pngBytes(): number[] {
  if (pngCache) return pngCache;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 180;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#8ab4f8";
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = "#1f2937";
    g.fillRect(24, 24, 272, 132);
  }
  const b64 = c.toDataURL("image/png").split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  pngCache = Array.from(bytes);
  return pngCache;
}
// 只替代**后端**，不替代前端：preview 的字节 -> Blob -> objectURL -> <img> 全是生产码。
// Tauri v2 的 invoke() 在调用时才读 window.__TAURI_INTERNALS__（node_modules/@tauri-apps/api/core.js:340）
// ⇒ 在模块体里装 stub 仍然生效。
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    invokeCount += 1;
    if (cmd === "media_present") return true;
    if (cmd === "read_file_preview" || cmd === "read_content_preview") {
      if (previewDelay > 0) await new Promise((r) => setTimeout(r, previewDelay));
      return pngBytes();
    }
    return null;
  },
};

/** 浏览器原生 longtask 观测：主线程阻塞 ≥50ms 的条目（自己算的帧间隔会漏掉"这一帧里还有别的任务"）。 */
const longTasks: Array<{ start: number; dur: number }> = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
  }).observe({ entryTypes: ["longtask"] });
} catch {
  /* 引擎没有 longtask 就只报帧间隔 */
}

type Item = {
  id: number;
  msg_id: string;
  local_id: string;
  conv_id: string;
  sender_id: string;
  receiver_id: string;
  kind: string;
  content: string;
  ts: number;
  seq: number;
  status: string;
  /** 夹具自己的分档标签（不是产品字段）：估算误差按它归并，别把 file 的两种子类型混在一起。 */
  variant: string;
};

function contentFor(kind: string, i: number): string {
  switch (kind) {
    case "code":
      return `function f${i}(x) {\n  const y = x * ${i % 7};\n  return y + ${i};\n}`;
    case "image":
      return JSON.stringify({ name: `p${i}.png`, path: `/tmp/probe-p${i}.png`, size: 234567, subtype: "image", w: 320, h: 180 });
    case "file":
      return JSON.stringify({ name: `文档${i}.pdf`, path: `/tmp/probe-d${i}.pdf`, size: 654321 });
    case "file-image":
      return JSON.stringify({ name: `附件${i}.png`, path: `/tmp/probe-f${i}.png`, size: 345678, subtype: "image", w: 320, h: 180 });
    case "file-code":
      return JSON.stringify({ name: `snippet${i}.ts`, path: `/tmp/probe-c${i}.ts`, size: 4321, subtype: "code" });
    case "system":
      return `系统提示 ${i}：这是一条系统消息`;
    case "recalled":
      return "消息已撤回";
    default:
      return "";
  }
}

const TEXT_SHORT = ["收到", "好的，我看一下", "马上", "这个可以", "下午三点吧", "👌", "在的"];
const TEXT_LONG = [
  "这是一段用于压测的中文长文本，主要用来制造不同行数：它会被自动换行，行数取决于容器宽度和字号，估算函数与真实渲染之间只要有一行差异就会让相邻消息错位。",
  "另一个版本：代码评审里提到的所有边界都要覆盖到，尤其是快速滚动、方向反转、切会话与异步内容到达这四类场景；只要其中一条没有对齐，用户看到的就是抽动。",
  "短一点的长文本：把消息列表做得连续、稳定、不闪白，比任何单点优化都重要。",
];

/**
 * 夹具分档（**真实 kind 只有 text/code/image/file/system/recalled**）：
 * 长文本仍是 text、附件图/附件代码仍是 file —— 后两者的区别在 content.subtype，
 * 只有估算与 MessageFileBubble 会按 subtype 走不同分支。
 */
function variantAt(i: number): string {
  if (MIX === "text") return "text";
  if (MIX === "long") return "text-long";
  if (MIX === "code") return "code";
  if (MIX === "image") return i % 3 === 0 ? "image" : i % 3 === 1 ? "file-image" : "text";
  const mod = i % 20;
  if (mod <= 5) return "text";
  if (mod <= 8) return "text-long";
  if (mod <= 10) return "code";
  if (mod === 11) return "system";
  if (mod === 12) return "recalled";
  if (mod <= 14) return "image";
  if (mod === 15) return "file";
  if (mod === 16) return "file-image";
  if (mod === 17) return "file-code";
  if (mod === 18) return "text-long";
  return "text";
}

function kindOf(variant: string): string {
  if (variant.startsWith("file")) return "file";
  if (variant === "text-long") return "text";
  return variant;
}

function makeItems(n: number): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const variant = variantAt(i);
    const kind = kindOf(variant);
    const sender = i % 9 < 4 ? "peer" : i % 9 < 7 ? "me" : "peer2";
    let content = contentFor(variant, i);
    if (variant === "text") content = TEXT_SHORT[i % TEXT_SHORT.length] + `（${i}）`;
    if (variant === "text-long") content = TEXT_LONG[i % TEXT_LONG.length].repeat((i % 2) + 1);
    out.push({
      id: i + 1,
      msg_id: `m-${i}`,
      local_id: `m-${i}`,
      conv_id: "probe",
      sender_id: sender,
      receiver_id: "peer",
      kind,
      content,
      // 组内连续（gap 4），每 30 条断一次组（gap 10 + 分割线）
      ts: 1700000000000 + i * 1000 + Math.floor(i / 30) * 6 * 60 * 1000,
      seq: i + 1,
      status: "sent",
      variant,
    });
  }
  return out;
}

const itemsRef = ref<Item[]>(makeItems(N));
const ctx = {
  get messages() {
    return itemsRef.value;
  },
  isGroup: true,
  selfId: "me",
  fontSize: "md" as const,
};

let estimateCalls = 0;
let estimateMs = 0;
function estimateHeight(it: Item, index: number) {
  const t0 = performance.now();
  const h = estimateMessageHeight(itemsRef.value[index] as never, index, ctx as never);
  estimateMs += performance.now() - t0;
  estimateCalls += 1;
  return h;
}

function sideAt(index: number) {
  const list = itemsRef.value;
  const cur = list[index];
  if (!cur) return "single" as const;
  const prev = index > 0 ? list[index - 1] : null;
  const next = list[index + 1] ?? null;
  return groupSide({
    kind: cur.kind as never,
    senderId: cur.sender_id,
    ts: cur.ts,
    prev: prev ? { kind: prev.kind as never, senderId: prev.sender_id, ts: prev.ts } : null,
    next: next ? { kind: next.kind as never, senderId: next.sender_id, ts: next.ts } : null,
    breakAbove: shouldShowTimeDivider(cur.ts, prev?.ts),
    breakBelow: !!next && shouldShowTimeDivider(next.ts, cur.ts),
  });
}

// ---------------- 帧采样 ----------------
interface FrameSample {
  t: number;
  dt: number;
  scrollTop: number;
  scrollHeight: number;
  rows: number;
  blankPx: number;
  bands: Array<[number, number]>;
  styleMutations: number;
  added: number;
  removed: number;
  anchorKey: string | null;
  anchorOffset: number | null;
}

const counter = { style: 0, added: 0, removed: 0 };
let observer: MutationObserver | null = null;

function scroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>("#probe-scroll .overflow-y-auto");
  if (!el) throw new Error("找不到 VirtualList 滚动容器");
  return el;
}

function resetCounters() {
  counter.style = 0;
  counter.added = 0;
  counter.removed = 0;
  estimateCalls = 0;
  estimateMs = 0;
}

function observeRows() {
  observer?.disconnect();
  const el = scroller();
  const spacer = el.firstElementChild;
  if (!spacer) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.attributeName === "style") counter.style += 1;
      else if (r.type === "childList") {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.hasAttribute("data-vlist-key")) counter.added += 1;
        }
        for (const n of r.removedNodes) {
          if (n instanceof HTMLElement && n.hasAttribute("data-vlist-key")) counter.removed += 1;
        }
      }
    }
  });
  observer.observe(spacer, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
}

function sampleFrame(dt: number): FrameSample {
  const el = scroller();
  const cr = el.getBoundingClientRect();
  const vh = el.clientHeight;
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-vlist-key]"))
    .map((n) => {
      const r = n.getBoundingClientRect();
      return { key: n.getAttribute("data-vlist-key"), top: r.top - cr.top, bottom: r.bottom - cr.top };
    })
    .sort((a, b) => a.top - b.top);

  const intervals: Array<[number, number]> = [];
  for (const r of rows) {
    const a = Math.max(0, r.top);
    const b = Math.min(vh, r.bottom);
    if (b - a > 0.5) intervals.push([a, b]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const bands: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of intervals) {
    if (a > cursor + 1) bands.push([cursor, a]);
    if (b > cursor) cursor = b;
  }
  if (cursor < vh - 1) bands.push([cursor, vh]);
  const blankPx = bands.reduce((s, [a, b]) => s + (b - a), 0);

  let anchorKey: string | null = null;
  let anchorOffset: number | null = null;
  for (const r of rows) {
    if (r.top <= 0.5 && r.bottom > 0.5) {
      anchorKey = r.key;
      anchorOffset = Math.round(r.top * 100) / 100;
      break;
    }
  }

  const s: FrameSample = {
    t: Math.round(performance.now()),
    dt: +dt.toFixed(1),
    scrollTop: Math.round(el.scrollTop * 100) / 100,
    scrollHeight: el.scrollHeight,
    rows: rows.length,
    blankPx: +blankPx.toFixed(1),
    bands: bands.map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number]),
    styleMutations: counter.style,
    added: counter.added,
    removed: counter.removed,
    anchorKey,
    anchorOffset,
  };
  counter.style = 0;
  counter.added = 0;
  counter.removed = 0;
  return s;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    requestAnimationFrame(() => resolve(performance.now() - t0));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 跳到一个位置后等到铺满（或超时），返回每帧样本。 */
async function settleAt(index: number, maxFrames = 60) {
  const el = scroller();
  const target = (el.scrollHeight * index) / Math.max(1, N);
  const t0 = performance.now();
  el.scrollTop = target;
  const frames: FrameSample[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const dt = await nextFrame();
    const s = sampleFrame(dt);
    frames.push(s);
    if (s.blankPx <= 1 && i > 1) break;
  }
  return { wallMs: Math.round(performance.now() - t0), frames };
}

/**
 * 连续滚动扫描（可多段，段间不重置位置；用来测方向反转）。
 * `stepPx` 取正 = 向下（内容上移），负 = 向上。
 */
async function runSegments({
  segments,
  startRatio = 0.1,
  settleMs = 400,
}: {
  segments: Array<{ steps: number; stepPx: number }>;
  startRatio?: number;
  settleMs?: number;
}) {
  const el = scroller();
  el.scrollTop = el.scrollHeight * startRatio;
  await sleep(settleMs);
  resetCounters();
  const all: FrameSample[] = [];
  const perSegment: Array<ReturnType<typeof summarize> & { steps: number; stepPx: number }> = [];
  for (const seg of segments) {
    const frames: FrameSample[] = [];
    for (let i = 0; i < seg.steps; i++) {
      const before = el.scrollTop;
      el.scrollTop = before + seg.stepPx;
      const dt = await nextFrame();
      frames.push(sampleFrame(dt));
    }
    all.push(...frames);
    perSegment.push({ steps: seg.steps, stepPx: seg.stepPx, ...summarize(frames) });
  }
  return {
    startRatio,
    scrolledPx: segments.reduce((s, x) => s + x.steps * x.stepPx, 0),
    totalEstimateCalls: estimateCalls,
    totalEstimateMs: +estimateMs.toFixed(1),
    segments: perSegment,
    first: all.slice(0, 8),
    worst: [...all].sort((a, b) => b.blankPx - a.blankPx).slice(0, 5),
  };
}

function summarize(frames: FrameSample[]) {
  let blankFrames = 0;
  let blankRun = 0;
  let longestBlankRun = 0;
  let blankMs = 0;
  let maxBlankPx = 0;
  let longFrames = 0;
  // 锚点漂移 = 视口偏移的变化 **减去** 滚动量。
  // 只读 `anchorOffset` 的极差是错的：正常滚动时同一行每帧本来就会移 ±stepPx，
  // 那会把「滚了 240px」误报成「漂了 240px」。这里扣掉 scrollTop 的变化量。
  let maxDrift = 0;
  let maxDriftKey: string | null = null;
  let curKey: string | null = null;
  let baseOffset = 0;
  let baseScroll = 0;
  for (const s of frames) {
    if (s.blankPx > 1) {
      blankFrames += 1;
      blankRun += 1;
      blankMs += s.dt;
      longestBlankRun = Math.max(longestBlankRun, blankRun);
      maxBlankPx = Math.max(maxBlankPx, s.blankPx);
    } else {
      blankRun = 0;
    }
    if (s.dt > 50) longFrames += 1;
    if (s.anchorKey && s.anchorOffset != null) {
      if (s.anchorKey !== curKey) {
        curKey = s.anchorKey;
        baseOffset = s.anchorOffset;
        baseScroll = s.scrollTop;
      } else {
        const drift = Math.abs(s.anchorOffset - baseOffset + (s.scrollTop - baseScroll));
        if (drift > maxDrift) {
          maxDrift = drift;
          maxDriftKey = s.anchorKey;
        }
      }
    } else {
      curKey = null;
    }
  }
  const dts = frames.map((f) => f.dt).sort((a, b) => a - b);
  const pct = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? 0;
  return {
    startScrollTop: frames.length ? frames[0].scrollTop : 0,
    endScrollTop: frames.length ? frames[frames.length - 1].scrollTop : 0,
    blankFrames,
    longestBlankRun,
    blankMs: Math.round(blankMs),
    maxBlankPx,
    longFrames,
    p50: +pct(0.5).toFixed(1),
    p95: +pct(0.95).toFixed(1),
    maxFrame: frames.length ? Math.max(...frames.map((f) => f.dt)) : 0,
    styleMutations: frames.reduce((s, f) => s + f.styleMutations, 0),
    added: frames.reduce((s, f) => s + f.added, 0),
    removed: frames.reduce((s, f) => s + f.removed, 0),
    maxAnchorDriftPx: +maxDrift.toFixed(1),
    maxAnchorDriftKey: maxDriftKey,
  };
}

async function scan(opts: { steps?: number; stepPx?: number; startRatio?: number; settleMs?: number } = {}) {
  return runSegments({
    startRatio: opts.startRatio ?? 0.1,
    settleMs: opts.settleMs ?? 400,
    segments: [{ steps: opts.steps ?? 120, stepPx: opts.stepPx ?? 200 }],
  });
}

/** 稳定后逐行对比「估算高度」与「真实矩形高度」，并按 kind 归并。 */
async function estimateError() {
  await sleep(600);
  const el = scroller();
  const cr = el.getBoundingClientRect();
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-vlist-key]")).map((n) => {
    const idx = Number(n.getAttribute("data-vlist-index"));
    const r = n.getBoundingClientRect();
    return { idx, actual: r.height, top: r.top - cr.top + el.scrollTop };
  });
  rows.sort((a, b) => a.idx - b.idx);
  const byKind = new Map<string, { n: number; absErr: number; maxErr: number; samples: number[] }>();
  const pairs: Array<{ idx: number; actual: number; est: number; err: number; kind: string }> = [];
  for (const r of rows) {
    const it = itemsRef.value[r.idx];
    if (!it) continue;
    const est = estimateHeight(it as never, r.idx);
    const err = Math.round((r.actual - est) * 10) / 10;
    pairs.push({ idx: r.idx, actual: +r.actual.toFixed(1), est: +est.toFixed(1), err, kind: it.variant });
    const agg = byKind.get(it.variant) ?? { n: 0, absErr: 0, maxErr: 0, samples: [] };
    agg.n += 1;
    agg.absErr += Math.abs(err);
    agg.maxErr = Math.max(agg.maxErr, Math.abs(err));
    if (agg.samples.length < 5) agg.samples.push(err);
    byKind.set(it.variant, agg);
  }
  let overlap = 0;
  let gap = 0;
  for (let i = 1; i < rows.length; i++) {
    const prevBottom = rows[i - 1].top + rows[i - 1].actual;
    if (rows[i].top < prevBottom - 1) overlap += 1;
    else if (rows[i].top > prevBottom + 1) gap += 1;
  }
  return {
    rendered: rows.length,
    overlapPairs: overlap,
    gapPairs: gap,
    byKind: Object.fromEntries(
      [...byKind.entries()].map(([k, v]) => [
        k,
        { n: v.n, meanAbsErr: +(v.absErr / v.n).toFixed(1), maxAbsErr: v.maxErr, firstErrs: v.samples },
      ]),
    ),
    worst: pairs.sort((a, b) => Math.abs(b.err) - Math.abs(a.err)).slice(0, 8),
  };
}

/** 长时间滚动后的行数/堆等由 CDP 采；这里只报行数与缓存规模的自述。 */
function snapshot() {
  const el = scroller();
  return {
    n: N,
    mix: MIX,
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    renderedRows: el.querySelectorAll("[data-vlist-key]").length,
    headroomPx: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  };
}


/**
 * 「图片在视口里时才完成加载」：跳到图片区 → 先等骨架铺好 → 再采帧。
 * 记录视口下方第 3 行的位置变化（它上面有行收缩 ⇒ 它会向上跳）、scrollHeight 变化与重定位次数。
 */
async function resolveInView(ratio: number, waitMs = 200, frames = 50) {
  const el = scroller();
  el.scrollTop = el.scrollHeight * ratio;
  await sleep(waitMs);
  const cr = el.getBoundingClientRect();
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-vlist-key]"))
    .map((n) => {
      const r = n.getBoundingClientRect();
      return { key: n.getAttribute("data-vlist-key") ?? "", top: r.top - cr.top, bottom: r.bottom - cr.top };
    })
    .sort((a, b) => a.top - b.top);
  const visible = rows.filter((r) => r.bottom > 0 && r.top < el.clientHeight);
  // 取**视口最下方**那条：图片在它上方收缩时它会先动，才能量到"下方内容被推走"。
  const watched = visible[visible.length - 1] ?? visible[0];
  resetCounters();
  const samples: Array<{
    dt: number;
    watchedKey: string;
    watchedOffset: number | null;
    scrollTop: number;
    scrollHeight: number;
    styleMutations: number;
    rows: number;
  }> = [];
  for (let i = 0; i < frames; i++) {
    const dt = await nextFrame();
    const node = watched ? el.querySelector<HTMLElement>(`[data-vlist-key="${CSS.escape(watched.key)}"]`) : null;
    const c2 = el.getBoundingClientRect();
    samples.push({
      dt: +dt.toFixed(1),
      watchedKey: watched?.key ?? "",
      watchedOffset: node ? +(node.getBoundingClientRect().top - c2.top).toFixed(2) : null,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      styleMutations: counter.style,
      rows: el.querySelectorAll("[data-vlist-key]").length,
    });
    counter.style = 0;
  }
  const offsets = samples.map((x) => x.watchedOffset).filter((v): v is number => v != null);
  return {
    ratio,
    waitMs,
    watchedKey: watched?.key ?? null,
    firstOffset: offsets[0] ?? null,
    minOffset: offsets.length ? Math.min(...offsets) : null,
    maxOffset: offsets.length ? Math.max(...offsets) : null,
    shiftPx: offsets.length ? +(Math.max(...offsets) - Math.min(...offsets)).toFixed(1) : null,
    heightChanges: samples.reduce((n, x, i, a) => n + (i > 0 && x.scrollHeight !== a[i - 1].scrollHeight ? 1 : 0), 0),
    scrollHeightFirst: samples[0]?.scrollHeight ?? null,
    scrollHeightLast: samples[samples.length - 1]?.scrollHeight ?? null,
    styleMutations: samples.reduce((s, x) => s + x.styleMutations, 0),
    samples: samples.slice(0, 30),
  };
}

/** 跳到列表某个比例处，然后**不提前停**地采 N 帧（异步改高/长任务都在跳转之后发生）。 */
async function jumpAndWatch(ratio: number, frames = 40) {
  const el = scroller();
  el.scrollTop = el.scrollHeight * ratio;
  resetCounters();
  const out: FrameSample[] = [];
  for (let i = 0; i < frames; i++) {
    const dt = await nextFrame();
    out.push(sampleFrame(dt));
  }
  const dts = out.map((f) => f.dt);
  return {
    ratio,
    frames: out,
    blankFrames: out.filter((f) => f.blankPx > 1).length,
    maxBlankPx: Math.max(...out.map((f) => f.blankPx)),
    styleMutations: out.reduce((s, f) => s + f.styleMutations, 0),
    p95: +[...dts].sort((a, b) => a - b)[Math.floor(dts.length * 0.95)].toFixed(1),
    maxFrame: +Math.max(...dts).toFixed(1),
  };
}

/** 视口顶部那一行的 key 与偏移（不改滚动）。 */
function topRow() {
  const el = scroller();
  const cr = el.getBoundingClientRect();
  const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-vlist-key]"))
    .map((n) => {
      const r = n.getBoundingClientRect();
      return { key: n.getAttribute("data-vlist-key") ?? "", top: r.top - cr.top, bottom: r.bottom - cr.top };
    })
    .sort((a, b) => a.top - b.top);
  const hit = rows.find((r) => r.top <= 0.5 && r.bottom > 0.5) ?? rows[0];
  return hit ? { key: hit.key, offset: hit.top, scrollTop: el.scrollTop } : null;
}

/** 盯住一个 key：prepend/append 之后它在视口里的位置有没有漂（扣掉滚动量）。 */
async function probeAnchor(key: string, frames = 12) {
  const el = scroller();
  const samples: Array<{ dt: number; offset: number | null; scrollTop: number; drift: number | null }> = [];
  let baseOffset: number | null = null;
  let baseScroll = 0;
  for (let i = 0; i < frames; i++) {
    const dt = await nextFrame();
    const node = el.querySelector<HTMLElement>(`[data-vlist-key="${CSS.escape(key)}"]`);
    const cr = el.getBoundingClientRect();
    const offset = node ? +(node.getBoundingClientRect().top - cr.top).toFixed(2) : null;
    if (offset != null && baseOffset === null) {
      baseOffset = offset;
      baseScroll = el.scrollTop;
    }
    samples.push({
      dt: +dt.toFixed(1),
      offset,
      scrollTop: el.scrollTop,
      drift: offset != null && baseOffset != null ? +(offset - baseOffset + (el.scrollTop - baseScroll)).toFixed(1) : null,
    });
  }
  const drifts = samples.map((s) => s.drift).filter((v): v is number => v != null);
  return {
    key,
    missingFrames: samples.filter((s) => s.offset == null).length,
    maxAbsDrift: drifts.length ? Math.max(...drifts.map(Math.abs)) : null,
    samples,
  };
}

/** 往列表顶部插 k 条更早的历史（模拟上翻加载）。 */
function prepend(k = 100) {
  const first = itemsRef.value[0];
  const base = first?.ts ?? 1700000000000;
  const stamp = Date.now();
  const add: Item[] = [];
  for (let j = k; j >= 1; j--) {
    add.push({
      id: -j,
      msg_id: `hist-${stamp}-${j}`,
      local_id: `hist-${stamp}-${j}`,
      conv_id: "probe",
      sender_id: j % 2 ? "peer" : "me",
      receiver_id: "peer",
      kind: "text",
      content: TEXT_LONG[j % TEXT_LONG.length],
      ts: base - j * 60_000,
      seq: -j,
      status: "sent",
      variant: "text-long",
    });
  }
  itemsRef.value = [...add, ...itemsRef.value];
  return { added: k, total: itemsRef.value.length };
}

/** 往列表底部追加 k 条（模拟新消息）。 */
function append(k = 1) {
  const last = itemsRef.value.at(-1);
  const base = last?.ts ?? 1700000000000;
  const stamp = Date.now();
  const add: Item[] = [];
  for (let j = 1; j <= k; j++) {
    add.push({
      id: 1_000_000 + j,
      msg_id: `new-${stamp}-${j}`,
      local_id: `new-${stamp}-${j}`,
      conv_id: "probe",
      sender_id: "peer",
      receiver_id: "me",
      kind: "text",
      content: `新消息 ${j}`,
      ts: base + j * 1000,
      seq: 1_000_000 + j,
      status: "sent",
      variant: "text",
    });
  }
  itemsRef.value = [...itemsRef.value, ...add];
  return { added: k, total: itemsRef.value.length };
}

const App = defineComponent({
  setup(_props, { expose }) {
    const listRef = ref<{ scrollToIndex: (i: number, a?: string) => void; scrollToBottom: () => void } | null>(null);

    expose({
      scan,
      settleAt,
      estimateError,
      snapshot,
      runSegments,
      reversal: async (steps = 60, stepPx = 400, startRatio = 0.4) =>
        runSegments({
          startRatio,
          segments: [
            { steps, stepPx },
            { steps, stepPx: -stepPx },
          ],
        }),
      jump: async (index: number) => {
        const r = await settleAt(index, 90);
        return { askedIndex: index, wallMs: r.wallMs, frames: r.frames };
      },
      slowReadUp: async (steps = 120, stepPx = -30, startRatio = 0.7) =>
        scan({ steps, stepPx, startRatio, settleMs: 500 }),
      reset: () => {
        const el = scroller();
        el.scrollTop = 0;
        resetCounters();
        longTasks.length = 0;
      },
      estimateCalls: () => estimateCalls,
      longTasks: () => [...longTasks],
      resetLongTasks: () => {
        longTasks.length = 0;
      },
      topRow,
      jumpAndWatch,
      resolveInView,
      invokeCount: () => invokeCount,
      setPreviewDelay: (ms: number) => {
        previewDelay = Math.max(0, ms);
      },
      /**
       * 运行时改库选项（**只用于 A/B**，不是产品接口）：
       *   · raf = useAnimationFrameWithResizeObserver；
       *   · overscan = 前后各预渲染条目数。
       * 走库自己的 setOptions，避免直接改内部字段带来的"读数不是产品行为"。
       */
      setVirtualOptions: (o: { raf?: boolean; overscan?: number }) => {
        // VirtualList 没把 virtualizer 暴露到组件 API；诊断台从它根元素的组件实例里取
        // （setupState 在 dev 构建下可读）。这只用于量具，不是产品接口。
        const el = scroller();
        const inst = (el as unknown as { __vueParentComponent?: { setupState?: { virtualizer?: unknown } } })
          .__vueParentComponent?.setupState?.virtualizer as { options: Record<string, unknown>; setOptions: (o: unknown) => void };
        const v = inst;
        const next: Record<string, unknown> = { ...v.options };
        if (o.raf != null) next.useAnimationFrameWithResizeObserver = o.raf;
        if (o.overscan != null) next.overscan = o.overscan;
        v.setOptions(next as never);
        return { raf: v.options.useAnimationFrameWithResizeObserver, overscan: v.options.overscan };
      },
      virtualStats: () => {
        const el = scroller();
        const inst = (el as unknown as { __vueParentComponent?: { setupState?: { virtualizer?: unknown } } })
          .__vueParentComponent?.setupState?.virtualizer as {
            options: { count: number; overscan: number; useAnimationFrameWithResizeObserver: boolean };
            itemSizeCache: Map<string, number>;
            getTotalSize: () => number;
            scrollOffset: number | null;
          };
        const v = inst;
        return {
          count: v.options.count,
          overscan: v.options.overscan,
          raf: v.options.useAnimationFrameWithResizeObserver,
          measuredKeys: v.itemSizeCache.size,
          totalSize: v.getTotalSize(),
          scrollOffset: v.scrollOffset,
        };
      },
      resetInvoke: () => {
        invokeCount = 0;
      },
      probeAnchor,
      prepend,
      append,
      blankNow: async () => {
        const dt = await nextFrame();
        return sampleFrame(dt);
      },
      /**
       * 覆盖率量具的阳性对照：摘掉视口中部一行 → 必须读到空白；放回 → 必须回到 0。
       * 没有这一条，「blankPx 恒 0」完全可能是量具根本没在看。
       */
      blankControl: async () => {
        const el = scroller();
        // 先把列表放到中段并等渲染追上：自检前面的 scrollTop 写入只改了滚动位置，
        // 此刻 DOM 可能还停在初始（贴底）那一批行上 ⇒ 视口中心一条行都没有。
        el.scrollTop = el.scrollHeight * 0.45;
        await sleep(350);
        await nextFrame();
        const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-vlist-key]"));
        // ⚠️ 必须挑**视口中心那一条**：querySelectorAll 的结果含上下 overscan，
        // 在列表顶部时「数组正中间」很可能落在视口下方 ⇒ 藏掉它不会留下任何可见空白，
        // 那条阳性对照就恒为假（第一版就是这么红的，量具自身的洞）。
        const center = el.getBoundingClientRect().top + el.clientHeight / 2;
        const mid = rows.find((n) => {
          const r = n.getBoundingClientRect();
          return r.top <= center && r.bottom > center;
        });
        if (!mid) return { ok: false, reason: "视口中心没有行" };
        const prevDisplay = mid.style.display;
        mid.style.display = "none";
        const hidden = sampleFrame(await nextFrame());
        mid.style.display = prevDisplay;
        const restored = sampleFrame(await nextFrame());
        return {
          ok: hidden.blankPx > 1 && restored.blankPx <= 1,
          hiddenBlankPx: hidden.blankPx,
          hiddenBands: hidden.bands,
          restoredBlankPx: restored.blankPx,
        };
      },
    });

    onMounted(() => {
      const el = scroller();
      el.style.height = `${Math.max(240, window.innerHeight - 30)}px`;
      observeRows();
    });

    return () =>
      h(
        VirtualList as never,
        {
          ref: listRef,
          items: itemsRef.value as never,
          estimateHeight: estimateHeight as never,
          "auto-scroll-on-swap": AUTO,
        } as never,
        {
          default: ({ item, index }: { item: Item; index: number }) =>
            h(MessageItem as never, {
              message: item as never,
              prev: (index > 0 ? itemsRef.value[index - 1] : null) as never,
              isGroup: true,
              groupSide: sideAt(index),
              senderName: `用户${item.sender_id}`,
              groupReaderIds: EMPTY_STRING_LIST,
              reactions: EMPTY_REACTION_CHIPS,
              mentionNames: EMPTY_STRING_LIST,
              showUnreadDivider: false,
              highlightId: null,
              selfMention: null,
              pinned: false,
              selectMode: false,
              selected: false,
              canReact: true,
            } as never),
        },
      );
  },
});

createApp(App).use(createPinia()).mount("#probe-scroll");

const mountEl = document.querySelector("#probe-scroll") as HTMLElement & {
  __vue_app__?: { _instance?: { exposed?: Record<string, unknown> } };
};
const exposed = mountEl.__vue_app__?._instance?.exposed ?? {};

(window as unknown as { __probe: unknown }).__probe = {
  ...exposed,
  n: N,
  kinds: (() => {
    const m: Record<string, number> = {};
    for (const it of itemsRef.value) m[it.variant] = (m[it.variant] ?? 0) + 1;
    return m;
  })(),
  knownKinds: itemsRef.value.every((it) => isKnownKind(it.kind)),
};
