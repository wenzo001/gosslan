// 只读诊断驱动：把 perf/scrollprobe.html 挂到 CDP 上，跑白屏/抽动/跳转/锚点四组读数。
//
// 前置（与量具一共用端口，见 perf/README.md）：
//   npx vite --port 5199 --strictPort
//   "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
//     --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/brave-perf-scroll2026 \
//     --remote-debugging-port=9223 --window-size=1280,900
//   node perf/scrollprobe.mjs 1200
//
// 退码 1 只有一种形状：量具自检不过（容器没滚、虚拟化没生效、覆盖率量具看不见空白）。
// 业务读数本身不判红 —— 这台只报数。

const CDP = process.env.PROBE_CDP ?? "http://127.0.0.1:9223";
const PORT = process.env.PERF_PORT ?? "5199";
const N = process.argv[2] ?? "1200";

async function findOrOpen() {
  const want = "scrollprobe.html";
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json`)).json();
      const pages = list.filter((t) => t.type === "page" && t.url.includes(want));
      const page = pages[pages.length - 1];
      if (page) return page;
      const url = `http://127.0.0.1:${PORT}/perf/${want}?n=${N}`;
      await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    } catch {
      /* 调试端口还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("找不到 CDP 目标页（浏览器是否带 --remote-debugging-port=9223 启动？）");
}

const page = await findOrOpen();
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

// rAF 只在**前台**标签里正常跑；后台标签会让所有逐帧等待超时。
try { await send("Page.bringToFront"); } catch {}
// 每次从**冷页面**开始：测量缓存/贴底态不能从上一次跑带过来。
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/perf/scrollprobe.html?n=${N}` });
await new Promise((r) => setTimeout(r, 900));

for (let i = 0; i < 120; i++) {
  if (await evalJs("!!(window.__probe && window.__probe.scan)")) break;
  await new Promise((r) => setTimeout(r, 500));
}

const result = await evalJs(`(async () => {
  const p = window.__probe;
  if (!p) return { error: "window.__probe 没挂上（页面模块可能抛错）" };
  const el = document.querySelector("#probe-scroll .overflow-y-auto");
  if (!el) return { error: "找不到滚动容器" };

  // 自检 1：容器真的是滚动容器（否则所有 scrollTop 写入被忽略）
  el.scrollTop = 1234;
  const scrollerReal = Math.round(el.scrollTop) === 1234;
  el.scrollTop = 0;
  // 自检 2：虚拟化生效（不是全量渲染）
  const virtualizationOK = el.querySelectorAll("[data-vlist-key]").length > 0 &&
    el.querySelectorAll("[data-vlist-key]").length < 200;
  // 自检 3：覆盖率量具能看见空白（摘一行 → 必须读到空白；放回 → 必须归零）
  const control = await p.blankControl();

  const out = {
    n: p.n,
    mix: p.kinds,
    allKindsKnown: p.knownKinds,
    selfcheck: { scrollerReal, virtualizationOK, control },
    snapshot: p.snapshot(),
    scans: {},
    reversal: null,
    jumps: [],
    slowReadUp: null,
    estimateError: null,
    longTasks: null,
  };

  // 快速滚动：同一段（10% 处）分别用 80/200/400/800px 每帧往下；800 接近一次快速甩动
  for (const step of [80, 200, 400, 800]) {
    out.scans["down" + step] = await p.scan({ steps: 90, stepPx: step, startRatio: 0.1 });
  }
  // 向上翻历史（90% 处往上）
  for (const step of [200, 400, 800]) {
    out.scans["up" + step] = await p.scan({ steps: 90, stepPx: -step, startRatio: 0.9 });
  }
  // 方向反转：连续 60 帧下 + 60 帧上，段间不重置
  out.reversal = await p.reversal(60, 400, 0.4);
  // 远距跳转：看几帧铺满、首帧空白
  for (const idx of [Math.floor(p.n * 0.75), Math.floor(p.n * 0.25)]) {
    out.jumps.push(await p.jump(idx));
  }
  // 慢速上翻（30px/帧，约正常触控板速度）：图片骨架异步失败 → 高度收缩时的锚点漂移
  out.slowReadUp = await p.scan({ steps: 120, stepPx: -30, startRatio: 0.55, settleMs: 500 });
  // 稳定后逐 kind 的估算误差 + 行间重叠/空隙
  out.estimateError = await p.estimateError();
  out.longTasks = p.longTasks();

  return out;
})()`);

const lf = (label, r) => {
  if (!r) return;
  const s = r.segments?.[0] ?? r;
  console.log(
    `${label.padEnd(10)} blankFrames ${String(s.blankFrames).padStart(3)}/${String(r.segments?.[0]?.steps ?? "-").padStart(3)}` +
      `  longestRun ${String(s.longestBlankRun).padStart(3)}  maxBlank ${String(s.maxBlankPx).padStart(6)}px` +
      `  p50/p95 ${s.p50}/${s.p95}ms  max ${s.maxFrame}ms  long>50 ${String(s.longFrames).padStart(3)}` +
      `  styleMut ${String(s.styleMutations).padStart(4)}  add/rem ${s.added}/${s.removed}` +
      `  anchorDrift ${s.maxAnchorDriftPx}px`,
  );
};

console.log(JSON.stringify(result.selfcheck, null, 2));
console.log(`n=${result.n} mix=${JSON.stringify(result.mix)} allKindsKnown=${result.allKindsKnown}`);
for (const [k, v] of Object.entries(result.scans ?? {})) lf(k, v);
if (result.reversal) {
  result.reversal.segments.forEach((s, i) => lf(i === 0 ? "reversal↓" : "reversal↑", { segments: [s] }));
}
for (const j of result.jumps ?? []) {
  const firstFull = j.frames?.find((f) => f.blankPx <= 1);
  console.log(
    `jump→${j.askedIndex}: ${j.frames?.length ?? 0} frames, wall ${j.wallMs}ms, firstFullBlankFrame ${firstFull ? j.frames.indexOf(firstFull) + 1 : "none"}, firstBlank ${j.frames?.[0]?.blankPx}px`,
  );
}
if (result.slowReadUp) lf("slowReadUp", result.slowReadUp);
console.log("estimateError:", JSON.stringify(result.estimateError, null, 2));
const lt = result.longTasks ?? [];
console.log(
  "longTasks:",
  JSON.stringify({ count: lt.length, totalMs: lt.reduce((s, x) => s + x.dur, 0), worst: [...lt].sort((a, b) => b.dur - a.dur).slice(0, 5) }),
);

import { writeFileSync } from "node:fs";
writeFileSync("/tmp/scrollprobe-result.json", JSON.stringify(result, null, 2));
console.log("→ /tmp/scrollprobe-result.json");
ws.close();
const ok = result.selfcheck?.scrollerReal && result.selfcheck?.virtualizationOK && result.selfcheck?.control?.ok;
if (!ok) {
  console.error("❌ 量具自检不过，上面读数作废");
  process.exit(1);
}
process.exit(0);
