#!/usr/bin/env node
/**
 * A8 的一键跑法：用 **Safari/WebKit** 打开 `perf/wk-check.html`（挂真 `VirtualList` 的自驱动夹具），
 * 收回三格读数（前插锚点 / 快速下滚空白 / 快速上滚空白）。
 *
 * 为什么需要它：这三格在 Chromium 里由 `check-ui-runtime.mjs` 覆盖，而**出货引擎是 WebKit**。
 * 手工跑法（Safari 开发菜单 → 粘 `perf/wk-scroll-sampler.js`）能出数但不可复跑；这个脚本把
 * 「起 vite → 起 safaridriver → 开会话 → 收信标 → 关会话」串成一条命令。
 *
 * ## 唯一的前置（一次性、只有人能点）
 * Safari → 设置 → 开发者 → 勾「**允许远程自动化**」。
 * 没勾时 `POST /session` 会回 `You must enable 'Allow remote automation' …`，
 * 本脚本按 **exit 2（环境不具备，不是通过）** 退出，并把要勾的那句话原样打出来。
 *
 * ## 它不替代什么（诚实边界）
 * - 它跑的是 `perf/wk-check.html`：真 `VirtualList` + 等价行模板，**没有** ChatWindow/store；
 *   App 内那一格（真实会话切换 + 真库）仍要人工 Inspect 或另建夹具。
 * - 它判的是「引擎层这三格」：前插锚点保住 key、两个方向的快速滚动没有空白帧。
 *   像素级 1 帧闪现仍然只能人眼。
 *
 * ## 用法
 *     node perf/wk-a8.mjs                 # 默认 vite 5398 / 信标 5401 / safaridriver 4460
 *     PROBE_VITE_PORT=5398 PROBE_BEACON=5401 PROBE_DRIVER=4460 node perf/wk-a8.mjs
 *
 * 退码：0 = 收到读数且三格判据通过；1 = 收到读数但判据红；2 = 环境不具备（开关没勾 / 跑错引擎 / 端口被占）。
 * ⚠️ 端口被占**当场红**，不换端口接着跑 —— 那会连到一个不是这次的进程上，读出来的数不知道是谁的。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = Number(process.env.PROBE_VITE_PORT ?? 5398);
const BEACON_PORT = Number(process.env.PROBE_BEACON ?? 5401);
const DRIVER_PORT = Number(process.env.PROBE_DRIVER ?? 4460);
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 150_000);

const cleanups = [];
function cleanup() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try {
      fn();
    } catch {
      /* 收尾不许盖住真错误 */
    }
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};

async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600) });
    await r.text().catch(() => "");
    return true;
  } catch (e) {
    // ECONNREFUSED 才是"空"；其他错（含超时）都按"有人在"处理 —— 宁可红，不要连错进程。
    return e?.cause?.code !== "ECONNREFUSED" && e?.name !== "TimeoutError";
  }
}

// ---------- 1. 起 vite（夹具 import 的是仓库里的 .vue 源码，必须走 dev server） ----------
for (const p of [VITE_PORT, BEACON_PORT, DRIVER_PORT]) {
  if (await portBusy(p)) fail(2, `✗ 端口 ${p} 已被占用 —— 先清掉占用者（那可能是别的探针/实例），不要换端口接着跑。`);
}

const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});
cleanups.push(() => vite.kill("SIGTERM"));
let viteErr = "";
vite.stderr.on("data", (b) => (viteErr += b.toString()));

// vite 是现编译：`/perf/wk-check.html` 先能 200，再谈有没有编译完依赖（页面自己会等模块）。
let up = false;
for (let i = 0; i < 60; i++) {
  if (vite.exitCode !== null) fail(2, `✗ vite 退出（code ${vite.exitCode}）：${viteErr.slice(0, 300)}`);
  try {
    const r = await fetch(`http://127.0.0.1:${VITE_PORT}/perf/wk-check.html`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      up = true;
      break;
    }
  } catch {
    /* 还没起 */
  }
  await sleep(500);
}
if (!up) fail(2, `✗ vite 在 ${VITE_PORT} 起不来：${viteErr.slice(0, 300)}`);

// ---------- 2. 信标接收端（页面用 Image 回传，所以只要有响应头就够） ----------
const received = [];
const beacon = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const raw = u.searchParams.get("r");
  if (raw) {
    try {
      received.push(JSON.parse(raw));
    } catch {
      received.push({ parseError: String(raw).slice(0, 200) });
    }
  }
  res.writeHead(200, { "content-type": "image/gif" });
  res.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
});
cleanups.push(() => beacon.close());
await new Promise((resolve) => beacon.listen(BEACON_PORT, "127.0.0.1", resolve));

// ---------- 3. safaridriver + W3C 会话 ----------
const driver = spawn("safaridriver", ["-p", String(DRIVER_PORT)], { stdio: ["ignore", "pipe", "pipe"] });
cleanups.push(() => driver.kill("SIGTERM"));
let drvErr = "";
driver.stderr.on("data", (b) => (drvErr += b.toString()));

let listening = false;
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${DRIVER_PORT}/status`, { signal: AbortSignal.timeout(800) });
    listening = true;
    break;
  } catch {
    await sleep(250);
  }
}
if (!listening) fail(2, `✗ safaridriver 在 ${DRIVER_PORT} 没起来：${drvErr.slice(0, 300)}`);

const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json();
};

const created = await post("/session", {
  capabilities: { alwaysMatch: { browserName: "safari", "safari:automaticInspection": false } },
});
const sid = created?.value?.sessionId;
if (!sid) {
  const msg = String(created?.value?.message ?? JSON.stringify(created).slice(0, 300));
  if (/Allow remote automation/i.test(msg)) {
    fail(
      2,
      "✗ 环境不具备：Safari 没开「允许远程自动化」。\n" +
        "  一次性动作：Safari → 设置 → 开发者 → 勾「允许远程自动化」，然后原样重跑本命令。\n" +
        "  （开发者分区本身没出现时，先在 设置 → 高级 → 勾「显示网页开发者功能」。）",
    );
  }
  fail(2, `✗ 会话建不起来：${msg}`);
}
cleanups.push(() => {
  void post(`/session/${sid}`, undefined).catch(() => {});
});

const url =
  `http://127.0.0.1:${VITE_PORT}/perf/wk-check.html` +
  `?report=${encodeURIComponent(`http://127.0.0.1:${BEACON_PORT}/beacon`)}`;
const nav = await post(`/session/${sid}/url`, { url });
if (nav?.value?.error) fail(2, `✗ 导航失败：${JSON.stringify(nav.value).slice(0, 300)}`);

// ---------- 4. 等信标 ----------
const t0 = Date.now();
while (!received.length && Date.now() - t0 < WAIT_MS) await sleep(500);

if (!received.length) fail(1, `✗ ${Math.round(WAIT_MS / 1000)}s 内没收到读数（页面可能没跑起来，或 Safari 停在别的标签页）。`);
const r = received[0];
if (r.parseError) fail(1, `✗ 信标内容解析失败：${r.parseError}`);

const eng = r.engine ?? {};
console.log(`引擎：${eng.vendor ?? "?"}  safari=${eng.safari}  ua=${(eng.ua ?? "").slice(0, 80)}`);
if (!eng.safari) fail(2, "✗ 跑到的不是 Safari/WebKit（信标里的 engine.safari 为 false）—— 这台的读数不能当 WKWebView 用。");

const fmt = (s) => (s ? `空白帧 ${s.blankFrames}  最大 ${s.maxBlank}px  p50 ${s.p50}ms  最长 ${s.max}ms  >50ms ${s.long50}` : "缺失");
console.log(`前插锚点：keptKey=${r.A?.keptKey}  drift=${r.A?.drift}px  (${r.A?.from} → ${r.A?.to})`);
console.log(`快速下滚：${fmt(r.down)}`);
console.log(`快速上滚：${fmt(r.up)}`);

const checks = [
  ["前插锚点保住同一行", r.A?.keptKey === true],
  ["下滚无空白帧", r.down?.blankFrames === 0],
  ["上滚无空白帧", r.up?.blankFrames === 0],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) bad += 1;
}
if (bad) fail(1, `✗ ${bad} 格没过（读数在上面；这是 5.14.8「等 sizer 静定」那笔要守的三格）。`);
console.log("✓ WebKit 三格通过。");
process.exit(0);
