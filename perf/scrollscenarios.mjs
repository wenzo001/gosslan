// 归因场景（每个场景一次 Page.reload ⇒ 测量缓存是冷的，与「刚打开会话」同形）：
//   1. 冷跳到代码区 vs 文本区：首帧空白、长任务（复杂消息首挂成本）；
//   2. 冷跳到图片区：288 骨架 → 128 失败占位的异步改高，逐帧空白/重定位；
//   3. 阅读中 prepend 100 条历史 + append 新消息：锚点漂移；
//   4. 贴底时 append：底边是否保持 0。
//
// 前置同 perf/scrollprobe.mjs（vite 5199 + headless 浏览器 9223）。

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9223";
const PORT = process.env.PERF_PORT ?? "5199";

async function openPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json`)).json();
      const pages = list.filter((t) => t.type === "page" && t.url.includes("scrollprobe.html"));
      const page = pages[pages.length - 1];
      if (page) return page;
      await fetch(`${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/perf/scrollprobe.html?n=1200`)}`, { method: "PUT" });
    } catch {
      /* 端口未起 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("找不到 CDP 目标页");
}

const page = await openPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(mid)) reject(new Error(`${method} 超时`));
    }, 240_000);
    pending.set(mid, (m) => {
      clearTimeout(timer);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    });
  });
}

async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result.value;
}

async function reload(auto = "0", extra = "") {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/perf/scrollprobe.html?n=1200&auto=${auto}${extra}` });
  for (let i = 0; i < 120; i++) {
    if (await evalJs("!!(window.__probe && window.__probe.jumpAndWatch)")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await evalJs("new Promise(r=>setTimeout(r,700))");
}

// rAF 只在**前台**标签里正常跑；后台标签会让所有逐帧等待超时。
try { await send("Page.bringToFront"); } catch {}

const toIndex = (key) => {
  const m = /^m-(\d+)$/.exec(key ?? "");
  return m ? Number(m[1]) : null;
};

const results = {};

// ---------- 1. 冷跳：代码区 vs 文本区 ----------
for (const [label, ratio] of [
  ["code", 0.79],
  ["text", 0.5],
]) {
  await reload();
  results["coldJump_" + label] = await evalJs(`(async()=>{
    const p=window.__probe;
    p.resetLongTasks();
    const r=await p.jumpAndWatch(${ratio}, 30);
    const top=p.topRow();
    return {ratio:${ratio}, top, longTasks:p.longTasks(),
      blankFrames:r.blankFrames, maxBlankPx:r.maxBlankPx, styleMutations:r.styleMutations,
      p95:r.p95, maxFrame:r.maxFrame,
      first10:r.frames.slice(0,10).map(f=>({dt:f.dt,blank:f.blankPx,bands:f.bands,rows:f.rows,style:f.styleMutations,sh:f.scrollHeight}))};
  })()`);
  results["coldJump_" + label].topIndex = toIndex(results["coldJump_" + label].top?.key);
}

// ---------- 2. 冷跳图片区 → 第二次（热）对照 ----------
await reload("0", "&mix=image");
results.imageColdThenWarm = await evalJs(`(async()=>{
  const p=window.__probe;
  p.resetLongTasks();
  const cold=await p.jumpAndWatch(0.6, 60);
  const lt=p.longTasks();
  p.resetLongTasks();
  const warm=await p.jumpAndWatch(0.6, 60);
  return {
    top:p.topRow(),
    cold:{blankFrames:cold.blankFrames,maxBlankPx:cold.maxBlankPx,styleMutations:cold.styleMutations,p95:cold.p95,maxFrame:cold.maxFrame},
    warm:{blankFrames:warm.blankFrames,maxBlankPx:warm.maxBlankPx,styleMutations:warm.styleMutations,p95:warm.p95,maxFrame:warm.maxFrame},
    coldLongTasks:lt, warmLongTasks:p.longTasks(),
    coldHeightChanges: cold.frames.reduce((n,f,i,a)=>n+(i>0&&f.scrollHeight!==a[i-1].scrollHeight?1:0),0),
    coldFirst: cold.frames.slice(0,25).map(f=>({dt:f.dt,blank:f.blankPx,bands:f.bands,style:f.styleMutations,sh:f.scrollHeight})),
  };
})()`);

// ---------- 3. 阅读中 prepend / append：锚点 ----------
await reload();
results.prependAppend = await evalJs(`(async()=>{
  const p=window.__probe;
  const el=document.querySelector("#probe-scroll .overflow-y-auto");
  el.scrollTop=el.scrollHeight*0.5;
  await new Promise(r=>setTimeout(r,700));
  const before=p.topRow();
  p.resetLongTasks();
  const pre=p.prepend(100);
  const afterPre=await p.probeAnchor(before.key, 25);
  // prepend 的正确判据是「锚点行的视口偏移不变」，同时 scrollTop 必须增加插入高度。
  // 不能再用「偏移差 + 滚动差」：那会把"补偿成功"读成漂移（第一版就是这么读错的）。
  const preOffsetDrift=afterPre.samples.map(s=>s.offset==null?null:+(s.offset-before.offset).toFixed(1));
  const preScrollDelta=afterPre.samples.map(s=>+(s.scrollTop-before.scrollTop).toFixed(1));
  const beforeAppend=p.topRow();
  const app=p.append(20);
  const afterAppend=await p.probeAnchor(beforeAppend.key, 25);
  const appOffsetDrift=afterAppend.samples.map(s=>s.offset==null?null:+(s.offset-beforeAppend.offset).toFixed(1));
  // 贴底态追加
  el.scrollTop=el.scrollHeight;
  await new Promise(r=>setTimeout(r,500));
  const bottom0={gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),sh:el.scrollHeight};
  p.append(1);
  await new Promise(r=>setTimeout(r,400));
  const bottom1={gap:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight),sh:el.scrollHeight};
  return {before, pre, app,
    preOffsetDrift, preScrollDelta, appOffsetDrift,
    preSamples:afterPre.samples.slice(0,5), appSamples:afterAppend.samples.slice(0,5),
    prependMissing:afterPre.missingFrames, appendMissing:afterAppend.missingFrames,
    bottomPinned:{before:bottom0,after:bottom1},
    longTasks:p.longTasks()};
})()`);

// ---------- 4. 图片在视口内完成加载（延迟 700ms）：下方行会不会跳 ----------
await reload("0", "&mix=image");
results.imageResolveInView = await evalJs(`(async()=>{
  const p=window.__probe;
  p.setPreviewDelay(700);
  p.resetLongTasks();
  p.resetInvoke();
  const r=await p.resolveInView(0.6, 250, 60);
  return {...r, invokes:p.invokeCount(), longTasks:p.longTasks()};
})()`);

// ---------- 5. 预览字节在挂载时立即可用（对照：同一区域、无延迟） ----------
await reload("0", "&mix=image");
results.imageResolveImmediate = await evalJs(`(async()=>{
  const p=window.__probe;
  p.setPreviewDelay(0);
  p.resetInvoke();
  const r=await p.resolveInView(0.6, 250, 40);
  return {...r, invokes:p.invokeCount()};
})()`);

// ---------- 6. P0 复现：阅读中（上翻已超过 1.2s）来一条新消息（生产形状 auto=1） ----------
await reload("1");
results.appendYank = await evalJs(`(async()=>{
  const p=window.__probe;
  const el=document.querySelector("#probe-scroll .overflow-y-auto");
  el.scrollTop=el.scrollHeight*0.5;
  // 必须超过 VirtualList 的 recentScrollUp(1200ms)，否则钉底会被"用户刚上滚"豁免掉。
  await new Promise(r=>setTimeout(r,1600));
  const before={scrollTop:el.scrollTop,top:p.topRow(),sh:el.scrollHeight};
  p.append(1);
  const seq=[];
  for(let i=0;i<12;i++){
    await new Promise(r=>requestAnimationFrame(r));
    const t=p.topRow();
    seq.push({i,scrollTop:Math.round(el.scrollTop),top:t&&t.key,gapToBottom:Math.round(el.scrollHeight-el.scrollTop-el.clientHeight)});
  }
  return {before,seq,jumpedPx:seq.length?Math.round(seq[seq.length-1].scrollTop-before.scrollTop):0};
})()`);

console.log(JSON.stringify(results, null, 2));
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/scrollprobe-scenarios.json", JSON.stringify(results, null, 2));
console.log("→ /tmp/scrollprobe-scenarios.json");
ws.close();
process.exit(0);
