// 冷挂载成本分档：同一跳转位置、同一批视口行数，只换消息种类（text/long/code/image）。
// 回答「复杂消息首帧贵多少」，并把长任务归到种类上（不是归到"列表整体"）。

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9223";
const PORT = process.env.PERF_PORT ?? "5199";

async function pageTarget() {
  const list = await (await fetch(`${CDP}/json`)).json();
  const pages = list.filter((t) => t.type === "page" && t.url.includes("scrollprobe.html"));
  return pages[pages.length - 1];
}
const page = await pageTarget();
if (!page) throw new Error("先开一张 scrollprobe 页（见 perf/scrollprobe.mjs 前置）");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((res, rej) => {
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

// rAF 只在**前台**标签里正常跑；后台标签会让所有逐帧等待超时。
try { await send("Page.bringToFront"); } catch {}

const out = {};
for (const mix of ["text", "long", "code", "image"]) {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/perf/scrollprobe.html?n=1200&mix=${mix}` });
  for (let i = 0; i < 120; i++) {
    if (await ev("!!(window.__probe && window.__probe.jumpAndWatch)")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await ev("new Promise(r=>setTimeout(r,700))");
  out[mix] = await ev(`(async()=>{
    const p=window.__probe; p.resetLongTasks(); const r=await p.jumpAndWatch(0.5, 30);
    return {top:p.topRow(), rows:r.frames[0]?.rows, blankFrames:r.blankFrames, maxBlankPx:r.maxBlankPx,
      styleMutations:r.styleMutations, p95:r.p95, maxFrame:r.maxFrame,
      first:r.frames.slice(0,6).map(f=>({dt:f.dt,rows:f.rows,blank:f.blankPx,bands:f.bands,style:f.styleMutations})),
      longTasks:p.longTasks()};
  })()`);
}
console.log(JSON.stringify(out, null, 2));
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/scrollprobe-kinds.json", JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
