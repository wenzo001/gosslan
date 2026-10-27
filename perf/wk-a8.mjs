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
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const VITE_PORT = Number(process.env.PROBE_VITE_PORT ?? 5398);
const BEACON_PORT = Number(process.env.PROBE_BEACON ?? 5401);
const DRIVER_PORT = Number(process.env.PROBE_DRIVER ?? 4460);
const WAIT_MS = Number(process.env.PROBE_WAIT_MS ?? 150_000);
// 两条传输：`open`（默认）与 `webdriver`。
// `open`：`open -a Safari <url>` 只是"打开一个网址"，**不需要**任何自动化权限；页面自己跑、自己回传。
// `webdriver`：走 safaridriver，需要一次「允许远程自动化」，但能干净地关标签页、能断言引擎身份。
// `wkwebview`（默认）：跑 `perf/wk-host.swift` 编出来的小宿主 —— **这才是出货那个渲染器**，
//   而且不套用 Safari 的「仅限 HTTPS」、不需要任何授权或点击。
const TRANSPORT = process.env.PROBE_TRANSPORT ?? "wkwebview";
const HOST_BIN = process.env.PROBE_WK_HOST ?? "/tmp/wk-host";
// 夹具的复现依赖几何（见 wk-host.swift 第 4 个参数那段注释）⇒ 尺寸要能钉、要能打印。
const HOST_SIZE = process.env.PROBE_WK_SIZE ?? "1000x760";

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
const wantedPorts = TRANSPORT === "webdriver" ? [VITE_PORT, BEACON_PORT, DRIVER_PORT] : [VITE_PORT, BEACON_PORT];
if (TRANSPORT === "wkwebview" && !existsSync(HOST_BIN)) {
  console.error(`· 没找到宿主 ${HOST_BIN}，先编译：\n  swiftc -O -o ${HOST_BIN} perf/wk-host.swift -framework Cocoa -framework WebKit`);
  try {
    execFileSync("swiftc", ["-O", "-o", HOST_BIN, "perf/wk-host.swift", "-framework", "Cocoa", "-framework", "WebKit"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "inherit",
    });
  } catch (e) {
    fail(2, `✗ 编译宿主失败：${e?.message ?? e}`);
  }
}

/** @param {string} name @returns {boolean} */
function existsSync(name) {
  try {
    return statSync(name).isFile();
  } catch {
    return false;
  }
}
for (const p of wantedPorts) {
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

// ---------- 3. 交给 Safari（两条传输） ----------
const url =
  `http://127.0.0.1:${VITE_PORT}/perf/wk-check.html` +
  `?report=${encodeURIComponent(`http://127.0.0.1:${BEACON_PORT}/beacon`)}`;

if (TRANSPORT === "webdriver") {
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

  const nav = await post(`/session/${sid}/url`, { url });
  if (nav?.value?.error) fail(2, `✗ 导航失败：${JSON.stringify(nav.value).slice(0, 300)}`);
} else if (TRANSPORT === "wkwebview") {
  const host = spawn(HOST_BIN, [url, String(Math.ceil(WAIT_MS / 1000)), HOST_SIZE], { stdio: ["ignore", "pipe", "pipe"] });
  console.log(`· 宿主窗口 ${HOST_SIZE}（几何会影响这组判据的复现，跑完记下来）`);
  cleanups.push(() => host.kill("SIGTERM"));
  host.stdout.on("data", (b) => process.stdout.write(`· host: ${b.toString()}`));
  host.stderr.on("data", (b) => process.stderr.write(`· host: ${b.toString()}`));
  host.on("exit", (code) => {
    if (!received.length) fail(2, `✗ 宿主退出（code ${code}）且没收到读数 —— 看上面 host 打的那几行。`);
  });
} else if (TRANSPORT === "open") {
  // `open -a Safari <url>` 只做"打开一个网址"，不碰自动化权限；夹具自己跑、自己用 Image 回传。
  // 代价：标签页不会被关掉（关它要自动化），并且 **rAF 只在最前台标签正常跑** ⇒ 下面的节流守卫必须留着。
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("open", ["-a", "Safari", url], { stdio: "ignore" });
  } catch (e) {
    fail(2, `✗ 打不开 Safari：${e?.message ?? e}`);
  }
  console.log("· 已在 Safari 打开夹具（页面自驱动，约 10s 出数）；跑完那个标签页可以手动关掉。");
} else {
  fail(2, `✗ 不认识的 PROBE_TRANSPORT=${TRANSPORT}（可选 open / webdriver）`);
}

// ---------- 4. 等信标 ----------
const t0 = Date.now();
while (!received.length && Date.now() - t0 < WAIT_MS) await sleep(500);
if (received.length) cleanup(); // 宿主/会话不会自己退：拿到读数就先收掉，后面的判据用内存里的 r

if (!received.length) fail(1, `✗ ${Math.round(WAIT_MS / 1000)}s 内没收到读数（页面可能没跑起来，或 Safari 停在别的标签页）。`);
const r = received[0];
if (r.parseError) fail(1, `✗ 信标内容解析失败：${r.parseError}`);

if (r.partial) {
  const st = r.stage ?? "?";
  const vis = `visibility=${r.visibility} hidden=${r.hidden}`;
  fail(
    2,
    `✗ 页面只回了"部分读数"：卡在「${st}」（${vis}）。\n` +
      "  最可能：Safari 那个标签页不在前台 ⇒ rAF 被降频，逐帧推进走不完。把 Safari 窗口切到前台后原样重跑；\n" +
      "  若它已经在前台还卡住，就把上面这句 `stage` 贴回来 —— 它指出的是具体哪一步没往下走。",
  );
}

const eng = r.engine ?? {};
const isWebKit = /AppleWebKit\//.test(eng.ua ?? "") && !/Chrome|Chromium|Edg\//.test(eng.ua ?? "") && /Apple/.test(eng.vendor ?? "");
console.log(`引擎：${eng.vendor ?? "?"}  ${eng.safari ? "Safari" : eng.wkwebview ? "WKWebView" : "?"}  ua=${(eng.ua ?? "").slice(0, 80)}`);
if (!isWebKit) fail(2, "✗ 跑到的不是 WebKit（UA/vendor 不符）—— 这台的读数不能当 WKWebView 用。");

const fmt = (s) => (s ? `空白帧 ${s.blankFrames}  最大 ${s.maxBlank}px  p50 ${s.p50}ms  最长 ${s.max}ms  >50ms ${s.long50}` : "缺失");
console.log(
  `前插锚点：keptKey=${r.A?.keptKey}  drift=${r.A?.drift}px  (${r.A?.key} @${r.A?.offset} → ${r.A?.afterKey} @${r.A?.afterOffset})`,
);
console.log(`快速下滚：${fmt(r.down)}`);
console.log(`快速上滚：${fmt(r.up)}`);

// 节流守卫：Safari 的后台标签页会被降频（rAF 从 16.7ms 掉到秒级）⇒ 那种读数不能用来判"有没有空白帧"，
// 但也不能判成产品红 —— 它是**环境不具备**。阈值 100ms（正常满帧 16.7ms，6 倍余量）。
const throttled = [r.down?.p50, r.up?.p50].some((v) => typeof v === "number" && v > 100);
if (throttled) {
  fail(
    2,
    `✗ 帧间隔 p50 异常（下滚 ${r.down?.p50}ms / 上滚 ${r.up?.p50}ms）—— Safari 那个标签页不在前台或被节流，` +
      `读数不可用。把 Safari 窗口切到前台、等标签页变活，再原样重跑。`,
  );
}

// ⚠️ 只有**两格扫描**参与判定。`A`（前插锚点）在这台夹具里**没有分辨力**：
// 2026-10-27 正控把 `reissuePrependAnchor` 整段 `return`，`keptKey` 仍是 true（drift 0.3）⇒
// 它绿不代表"锚点修好了"，红也归不了因。所以它只打印、不判。要判锚点请用 `scrollhist`（CDP 段，
// 它在真 ChatWindow 上能读出 0/丢 key/+710 三态）。
const checks = [
  ["下滚无空白帧", r.down?.blankFrames === 0],
  ["上滚无空白帧", r.up?.blankFrames === 0],
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) bad += 1;
}
if (bad) fail(1, `✗ ${bad} 格没过（读数在上面：这两格的正控是「把 rangeExtractor 的缓冲摘掉 ⇒ 25/26 帧空白」，已证非空转）。`);
console.log("✓ WebKit 两格扫描通过（锚点格无分辨力，不在此判 —— 见注释与报告 §12 更正）。");
process.exit(0);
