#!/usr/bin/env node
/**
 * A8 的**App 内**那一格：在真 WKWebView 里挂**真 `ChatWindow` + 真 store**，跑
 * 「连翻三页锚点」+「两格扫描空白」。与 `perf/wk-a8.mjs` 的分工：
 *   · `wk-a8.mjs`      —— 引擎层：真 `VirtualList` + 等价行模板（不依赖 store/IPC），快；
 *   · `wk-a8app.mjs`   —— App 层：真 `ChatWindow` + 真 store + 真组件链，IPC 走探针桩（下面写明）。
 *
 * ## 它从哪儿拿桩
 * 不抄第二份：运行时从 `scripts/check-ui-runtime.mjs` 里把 `PAGE_FIXTURE`（页内夹具，约 83KB）
 * **原样抽出**，与 `perf/wk-app-cell.js` 拼成一份注进页面。探针那边改了夹具，这里自动跟着变。
 *
 * ## 它证不了什么（边界）
 * - IPC 是桩（`api.getMessages` 换成内存分页），所以证的是**渲染/滚动/锚点这条链**，不是数据库或网络。
 * - 输入是**程序化 scrollTop**，不是真触控板惯性；惯性相关的验收仍归人眼。
 * - 像素级 1 帧闪现仍看不见。
 *
 * ## 用法
 *     node perf/wk-a8app.mjs
 *     PROBE_VITE_PORT=5394 PROBE_BEACON=5402 PROBE_WK_SIZE=1200x900 node perf/wk-a8app.mjs
 *
 * 退码：0 = 三页锚点全部 ≤2px 且两格扫描 0 空白；1 = 判据红；2 = 环境不具备（宿主缺失/端口被占/页面没回传）。
 */
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const VITE_PORT = Number(process.env.PROBE_VITE_PORT ?? 5394);
const BEACON_PORT = Number(process.env.PROBE_BEACON ?? 5402);
const HOST_BIN = process.env.PROBE_WK_HOST ?? "/tmp/wk-host";
const HOST_SIZE = process.env.PROBE_WK_SIZE ?? "1200x900";
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 120_000);

const cleanups = [];
function cleanup() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { fn(); } catch { /* 收尾不许盖住真错误 */ }
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
const fail = (code, msg) => { console.error(msg); process.exit(code); };

async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600) });
    await r.text().catch(() => "");
    return true;
  } catch (e) {
    return e?.cause?.code !== "ECONNREFUSED" && e?.name !== "TimeoutError";
  }
}

// ---------- 0. 拼注入脚本：PAGE_FIXTURE（从探针里抽）+ 本仓的页内单元 ----------
function extractPageFixture() {
  const src = readFileSync(`${ROOT}scripts/check-ui-runtime.mjs`, "utf8");
  const at = src.indexOf("const PAGE_FIXTURE = `");
  if (at < 0) throw new Error("check-ui-runtime.mjs 里找不到 PAGE_FIXTURE");
  const start = src.indexOf("`", at) + 1;
  let i = start;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === "`") break;
    i += 1;
  }
  return src.slice(start, i);
}
const combined = `${extractPageFixture()}\n;${readFileSync(`${ROOT}perf/wk-app-cell.js`, "utf8")}`;
const scriptPath = `/tmp/wk-app-combined-${process.pid}.js`;
writeFileSync(scriptPath, combined);
cleanups.push(() => { try { /* 保留现场，便于复跑时看 */ } catch { /* noop */ } });
console.log(`· 注入脚本 ${scriptPath}（${Math.round(combined.length / 1024)}KB = PAGE_FIXTURE + perf/wk-app-cell.js）`);

if (!(() => { try { return statSync(HOST_BIN).isFile(); } catch { return false; } })()) {
  fail(2, `✗ 没有宿主 ${HOST_BIN}：先 swiftc -O -o ${HOST_BIN} perf/wk-host.swift -framework Cocoa -framework WebKit`);
}
for (const p of [VITE_PORT, BEACON_PORT]) {
  if (await portBusy(p)) fail(2, `✗ 端口 ${p} 已被占用 —— 先清掉占用者，不要换端口接着跑。`);
}

// ---------- 1. vite（App 页面 + /src 模块都在这里编译） ----------
const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
cleanups.push(() => vite.kill("SIGTERM"));
let viteErr = "";
vite.stderr.on("data", (b) => (viteErr += b.toString()));
let up = false;
for (let i = 0; i < 60; i++) {
  if (vite.exitCode !== null) fail(2, `✗ vite 退出（code ${vite.exitCode}）：${viteErr.slice(0, 300)}`);
  try {
    const r = await fetch(`http://127.0.0.1:${VITE_PORT}/`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { up = true; break; }
  } catch { /* 还没起 */ }
  await sleep(500);
}
if (!up) fail(2, `✗ vite 起不来：${viteErr.slice(0, 300)}`);

// ---------- 2. 信标接收 ----------
const received = [];
const beacon = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const raw = u.searchParams.get("r");
  if (raw) { try { received.push(JSON.parse(raw)); } catch { received.push({ parseError: String(raw).slice(0, 200) }); } }
  res.writeHead(200, { "content-type": "image/gif" });
  res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
});
cleanups.push(() => beacon.close());
await new Promise((resolve) => beacon.listen(BEACON_PORT, "127.0.0.1", resolve));

// ---------- 3. 宿主 ----------
const url = `http://127.0.0.1:${VITE_PORT}/?report=${encodeURIComponent(`http://127.0.0.1:${BEACON_PORT}/beacon`)}`;
console.log(`· 宿主窗口 ${HOST_SIZE}`);
const host = spawn(HOST_BIN, [url, String(Math.ceil(WAIT_MS / 1000)), HOST_SIZE, scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
cleanups.push(() => host.kill("SIGTERM"));
host.stdout.on("data", (b) => process.stdout.write(`· host: ${b.toString()}`));
host.stderr.on("data", (b) => process.stderr.write(`· host: ${b.toString()}`));
host.on("exit", (code) => {
  if (!received.length) fail(2, `✗ 宿主退出（code ${code}）且没收到读数 —— 看上面 host 那几行。`);
});

const t0 = Date.now();
while (!received.length && Date.now() - t0 < WAIT_MS) await sleep(500);
if (received.length) cleanup();
if (!received.length) fail(1, `✗ ${Math.round(WAIT_MS / 1000)}s 内没收到读数。`);

const r = received[0];
if (r.parseError) fail(1, `✗ 信标解析失败：${r.parseError}`);
const eng = r.engine ?? {};
const isWebKit = /AppleWebKit\//.test(eng.ua ?? "") && !/Chrome|Chromium|Edg\//.test(eng.ua ?? "") && /Apple/.test(eng.vendor ?? "");
console.log(`引擎：${eng.vendor ?? "?"}  ${eng.safari ? "Safari" : eng.wkwebview ? "WKWebView" : "?"}  ${(eng.ua ?? "").slice(0, 70)}`);
if (!isWebKit) fail(2, "✗ 跑到的不是 WebKit —— 这台读数不能当 WKWebView 用。");
if (r.error) fail(1, `✗ 页内单元在「${r.stage}」失败：${r.error}`);

console.log(`种子：${JSON.stringify(r.seed)}`);
const steps = r.prepend ?? [];
for (const [i, s] of steps.entries()) {
  console.log(
    `翻页 ${i + 1}：len ${s.len0}→${s.len1}  settle ${s.settleMs}ms  ` +
      `before ${s.before?.key}@${s.before?.offset}  after ${s.after?.key}@${s.after?.offset}  ` +
      `keptKey=${s.keptKey}  drift=${s.drift}`,
  );
}
const fmt = (s) => (s ? `空白帧 ${s.blankFrames}  最大 ${s.maxBlank}px  p50 ${s.p50}ms  最长 ${s.max}ms  >50ms ${s.long50}` : "缺失");
console.log(`快速下滚：${fmt(r.down)}`);
console.log(`快速上滚：${fmt(r.up)}`);

const checks = [
  ["连翻三页都真的加载了新的一页", steps.length === 3 && steps.every((s) => s.len1 === s.len0 + 100)],
  ["每页前插后同一行仍在原位（|Δoffset| ≤ 2px）", steps.length === 3 && steps.every((s) => s.keptKey && Math.abs(s.drift ?? 999) <= 2)],
  ["下滚无空白帧", r.down?.blankFrames === 0],
  ["上滚无空白帧", r.up?.blankFrames === 0],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) bad += 1;
}
if (bad) fail(1, `✗ ${bad} 格没过（这是 App 内 WKWebView 那一格）。`);
console.log("✓ App 内（真 ChatWindow + 真 store）在 WKWebView 上四格通过。");
process.exit(0);
