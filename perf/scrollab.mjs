// 缓冲策略 A/B（只读量具：只改 TanStack 运行时选项，不改业务代码）。
// 每个读数 = 一次独立页面加载（冷缓存）→ 设选项 → 停在 10% → 静置 700ms → 连续 90 帧单向滚动。
// 每个变体每个步长重复 3 次，报中位数与极差 —— 单跑一次的波动足够把结论翻面（第一版就是）。

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9223";
const PORT = process.env.PERF_PORT ?? "5199";
const list = await (await fetch(`${CDP}/json`)).json();
const pages = list.filter((t) => t.type === "page" && t.url.includes("scrollprobe.html"));
const page = pages[pages.length - 1];
if (!page) throw new Error("先开一张 scrollprobe 页");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  const t = setTimeout(() => { if (pend.delete(mid)) rej(new Error(method + " 超时")); }, 240_000);
  pend.set(mid, (m) => { clearTimeout(t); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

const variants = [
  { name: "base", raf: true, overscan: 6 },
  { name: "rafOff", raf: false, overscan: 6 },
  { name: "os18", raf: true, overscan: 18 },
  { name: "rafOff_os18", raf: false, overscan: 18 },
  { name: "os36", raf: true, overscan: 36 },
];
const REPEATS = Number(process.env.AB_REPEATS ?? 3);
const STEPS = (process.env.AB_STEPS ?? "400,800").split(",").map(Number);

// rAF 只在**前台**标签里正常跑；后台标签会让所有逐帧等待超时。
try { await send("Page.bringToFront"); } catch {}

async function runOne(v, step) {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/perf/scrollprobe.html?n=1200` });
  for (let i = 0; i < 120; i++) {
    if (await ev("!!(window.__probe && window.__probe.setVirtualOptions)")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await ev("new Promise(r=>setTimeout(r,700))");
  return ev(`(async()=>{
    const p=window.__probe;
    const opts=p.setVirtualOptions({raf:${v.raf},overscan:${v.overscan}});
    const r=await p.scan({steps:90,stepPx:${step},startRatio:0.1,settleMs:700});
    return {opts,rows:r.first?.[0]?.rows ?? null, ...r.segments[0]};
  })()`);
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = {};
for (const v of variants) {
  out[v.name] = { opts: { raf: v.raf, overscan: v.overscan }, steps: {} };
  for (const step of STEPS) {
    const runs = [];
    for (let i = 0; i < REPEATS; i++) runs.push(await runOne(v, step));
    const pick = (k) => runs.map((r) => r[k]);
    out[v.name].steps[step] = {
      rows: median(pick("rows")),
      blankFrames: runs.map((r) => r.blankFrames),
      maxBlankPx: runs.map((r) => r.maxBlankPx),
      blankFramesMedian: median(pick("blankFrames")),
      p95Median: median(pick("p95")),
      longFramesMedian: median(pick("longFrames")),
      styleMutationsMedian: median(pick("styleMutations")),
      addedMedian: median(pick("added")),
      maxFrame: runs.map((r) => r.maxFrame),
      runs: runs.map((r) => ({ blankFrames: r.blankFrames, maxBlankPx: r.maxBlankPx, p95: r.p95, longFrames: r.longFrames, styleMutations: r.styleMutations, rows: r.rows, added: r.added })),
    };
  }
}
console.log(JSON.stringify(out, null, 2));
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/scrollprobe-ab.json", JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
