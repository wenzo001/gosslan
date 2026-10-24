#!/usr/bin/env node
/**
 * UI 运行时探针（零依赖）—— 把"只能落在运行时层"的那几格判据变成可重跑的东西。
 *
 * ## 为什么要有这个文件
 * 仓里没有 DOM 测试地基（没有 jsdom / vitest / @vue/test-utils / playwright 依赖），
 * 而有一类缺陷**只有**在真浏览器输入管线里才看得见：焦点落点、方向键走格子、
 * Esc 关完之后焦点去哪了、回车打开的是高亮那条还是第一条。
 * 这些以前每次都是"人眼看一次"，而 §30 的规矩是**每个真实缺陷都要换成一把永久锁**
 * （#92 那两条键盘出口就是这么发现、又这么差点丢失的）。
 *
 * ## 为什么不引依赖
 * `vite dev` 能把前端起来（Tauri 调用失败只弹一条 toast，界面壳照常渲染），
 * Node 24 有全局 `WebSocket` ⇒ 手写几十行就是 CDP 客户端。给 package.json 加一层
 * playwright/puppeteer 是"为了测试改动项目外的东西"，这条不做。
 * 浏览器二进制取本机 playwright 缓存里的 **Chrome for Testing**（没有系统 Chrome 也能跑），
 * 或者用 `GOSSLAN_CHROME` 指定（本机实测用 Brave：`/Applications/Brave Browser.app/...`）。
 * 宿主里 Chromium 沙箱初始化失败时（`Failed to initialize sandbox` ⇒ 进程 SIGTRAP），
 * 用 `GOSSLAN_PROBE_NO_SANDBOX=1` 追加 `--no-sandbox`；默认不追加，CI 行为不变。
 *
 * ## 三条把自己坑过的探针纪律（都写进判据了，别改回去）
 * 1. 一次按键的 `keyDown / keyUp` 必须**同帧发出**（不逐条 await），且**不要**用带 `text` 的 `rawKeyDown`。
 *    逐条 await 会被浏览器读成"按住不放"⇒ 自动重复：实测一次 Enter 打出 10194 次 keydown / 5074 次 click。
 *    2026-10-10 又量到第二种复发形状：`rawKeyDown` 自己带 `text` 时，CfT 153 会进入**自持重复**
 *    （按完 28 次、之后每秒再涨 ~550 次 click，补发 keyUp 也不终止）⇒ 发法固定为 `keyDown`(带 text)+`keyUp`，
 *    并且"只激活一次 + 空等不增长"已经是机器判据（`keyOnce`），不许只靠这段注释。
 * 2. Enter / 空格的 keyDown **必须带 `text`**。不带就没有"激活被聚焦的 button"这条默认动作，
 *    于是读到"回车不选中"——那是**假红**。本文件把"不带 text ⇒ 零次激活"固定成一条反向对照判据。
 * 3. 同一个页面里别叠两个开着的浮层（曾经把 renderer 主线程搞死，连 reload 的 eval 都发不进去）。
 *    ⇒ 每一段跑完都重新加载一次页面，段与段之间不共享浮层状态。
 *
 * ## 与真 app 的差别（报结论必须带上）
 * 组件逻辑是同一份代码，但按键走的是**浏览器**输入管线 ⇒ 这不等于 WKWebView / WebView2 里验过。
 * 那一半仍是人工（见验收矩阵 Smoke-11 的边界行）。
 *
 * ## 环境起不来必须响亮失败，而且三种病要长得不一样（2026-10-10 加）
 * 这一层的红有两种来源：产品真的坏了，和**这一格根本没跑**。后者绝不许打成绿，也不许静等。
 * 本机实测到过三种形状，各自有各自的读数：
 * 1. **残留实例占着端口** ⇒ 新 spawn 绑不上，`/json/list` 答的是**上次那台被 Ctrl-C 留下的浏览器**
 *    （它挂着 `type=page` 指向旧 vite ⇒ 读的是几小时前那份构建，判据照样打绿 —— 这是**假绿通道**）。
 *    现在起跑前先探两个端口，占用即具名红（实测 0.09 s 报出，而不是接着跑）。
 * 2. **spawn 并入了已存在的浏览器实例**（那个实例不带调试端口）⇒ 进程当场退掉、端口无人监听。
 *    读数：`我起的那个进程：已退出 code=…` + `端口：无人监听` 同时成立 ⇒ 直接给出修法提示。
 * 3. **进程活着但 target 迟迟不来**（机器负载 / 装坏的框架二进制）⇒ 等满预算再具名红，
 *    读数里明确写"到预算点仍在跑"，与第 2 种区分开。预算用 `GOSSLAN_PROBE_CDP_WAIT_MS` 调（默认 20 s）。
 * 无论哪种，红都会把「浏览器路径 / 来源 / 版本 / 进程结局 / 端口是否监听 / 最后一次尝试」一次打全，
 * 并把引擎版本打在正常路径的日志里（`· 引擎：…`）—— 换浏览器造成的读数变化要能在日志里自证用的是哪一台。
 *
 * ⚠️ 还有一型**没修**，但它会咬所有"按 Enter"的断言（2026-10-10 实测，任务 #20）：
 * 焦点模拟开着时对那颗 `<button data-reaction-entry>` 按一次 Enter，页面里会出现**自持的 click 风暴**
 * （capture 计数空等 1 s 还在涨 ≈900 次/秒，补发单独 keyUp 也没终止）⇒ 任何"开/关切换"型读数
 * 在这台引擎上变成掷硬币。同一次跑里 `picker=true` 出现过 ⇒ 面板渲染得出来，**这不是产品缺陷**。
 * 只有"恰好一次"型断言能暴露它（emoji 那条今天仍绿 ⇒ 触发条件还没定）。
 * ⇒ 在 `cdp.key()` 修好之前：新加 Enter 断言要自带"重复不敏感"的形状（像 pinkb 那样按完之后作用对象消失），
 *   并且**不许**把"回车只触发了一次"当成已被证明。
 *
 * ## 用法
 *     node scripts/check-ui-runtime.mjs              # 跑全部段
 *     node scripts/check-ui-runtime.mjs --only=emoji # 只跑某段
 *     node scripts/check-ui-runtime.mjs --self-check # 跑反面对照（判据必须报红，不是恒过）
 * 退出码：0 = 全绿；1 = 有判据红 / 环境缺件（**缺件是红，不是跳过**，§十 不许把没跑写成 PASS）。
 *
 * ## 改这个文件前先读三条（都是本轮实际踩过的）
 * - 页面侧那段是**模板字符串里的源码** ⇒ 里面不许出现反引号（会把模板提前结束），
 *   正则里的反斜杠也会被吃掉一层 —— 所以那段用 includes 而不是正则。
 * - 资源 URL 在 `entry.name` 上，不在 `entry.url`（写成 .url 会得到 undefined，
 *   报错却长得像"vite 没起来"）。
 * - `Page.navigate` 之后 vite 还在现编译依赖，拿 deps/vue.js 之前必须**轮询等**，
 *   等短了会把"还没编译完"读成"构建产物变了"。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const ONLY = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "";
const SELF_CHECK = argv.includes("--self-check");
/** `--shot=/tmp/x.png` 时顺手存一张会话行的真图（§10 的后半句要肉眼判）。不给就一字不动。 */
const SHOT_PATH = argv.find((a) => a.startsWith("--shot="))?.slice("--shot=".length) ?? "";
const VITE_PORT = Number(process.env.GOSSLAN_PROBE_PORT || 5199);
const CDP_PORT = Number(process.env.GOSSLAN_PROBE_CDP || 9444);
/**
 * 单次 CDP 调用的回包预算。默认给到 45 s 是因为**冷编译**那一档真实存在（vite 现编译依赖时
 * 第一次 eval 会慢），而这条守卫要挡的是"永远不回包"而不是"有点慢"。
 * 2026-10-10 本机实测：`--only=pinkb` 变异对照那一段的一次 eval 十几分钟没回，只能靠人 kill
 * （现读 `PINKB_RC=143`＝SIGTERM）。这一支在 `verify.mjs` 里是一步 ⇒ 这一步不回，整条链就停在那儿。
 * —— 旧代码这里没有任何预算，进程只能靠人 kill（现读 `PINKB_RC=143`＝SIGTERM）。
 */
const CDP_CALL_MS = Number(process.env.GOSSLAN_CDP_CALL_MS || 45_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

// ── 断言账本（终局由台账推导，不看"有没有抛异常"）──────────────────
const results = [];
/**
 * 最后一条**已记录**的判据（序号 + 名字前缀）。
 * 为什么要有它：一次 CDP 调用不回包时，旧版只能报"没回包"，谁死在哪一段全靠人复跑二分
 * （2026-10-20 归因全量探针卡死就是这么查的：`--only=` 逐段试了四趟才圈到 overlay）。
 * 判据名字每条都带自己的段标记（`A …`／`左列：…`／`[B] …`），所以"最后一条"就够定位到格。
 */
let lastCellMark = "(一条判据都还没记录)";
function check(name, pass, expect, actual) {
  const ok = pass === true;
  results.push({ name, ok, expect, actual });
  lastCellMark = `第 ${results.length} 格《${String(name).slice(0, 46)}》`;
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (!ok) console.log(`      预期 ${JSON.stringify(expect)} / 实际 ${JSON.stringify(actual)}`);
  return ok;
}

/**
 * 找可用浏览器。优先级（2026-10-07 加了第 3 档，负责人点头"用我自己的浏览器跑"）：
 *   ① `GOSSLAN_CHROME` 指定的那一个（显式覆盖永远第一）；
 *   ② playwright 缓存里的 Chrome for Testing —— **但"文件存在"不等于"起得来"**：
 *      本机实测缓存那台丢了 Framework 二进制（`Versions/<ver>/… Framework` 不见了），
 *      进程一触即溃 ⇒ 探针只会报 "CDP /json/list 里一直没有 page target"，看着像代码问题。
 *      所以这里做一次性**可加载性**核对（.app 就核对那份 Framework 文件在不在）。
 *   ③ 系统里已装的 Chromium 系浏览器（Brave / Chrome / Edge / Chromium）。
 * ⚠️ 三档全空 ⇒ **判红，不是跳过**（§十：没跑不许写成 PASS）。
 *    走 ③ 时会把"实际用的是谁"打在 `BROWSER_SOURCE` 里并由调用方印出来 ——
 *    换内核跑属于**可追溯的降级**，不许静默：同一条判据在别的内核上测到的东西名义上不同。
 */
let BROWSER_SOURCE = "";

/**
 * .app 包里的框架二进制是否真在（不在 = 这台装坏了）。
 *
 * 判据取自 macOS 的 bundle 布局：`Versions/Current` 是指向真版本目录的符号链接，
 * 加载器要的是 `Versions/Current/<Bundle 同名> Framework` 那个文件。本机实测那台缓存浏览器
 * 只剩 `Helpers/Libraries/Resources` 三个目录、这个文件没了 ⇒ dlopen 失败、进程一触即溃，
 * 而探针只会报"没有 page target"（看着像代码坏了）。所以**存在 ≠ 起得来**。
 */
function appBundleLoadable(binPath) {
  const fwDir = path.join(path.dirname(binPath), "..", "Frameworks");
  let frameworks;
  try {
    frameworks = fs.readdirSync(fwDir);
  } catch {
    return true; // 不是 .app 布局（Linux 那种散装），只做可执行核对
  }
  const bundle = frameworks.find((n) => /Framework\.framework$/.test(n));
  if (!bundle) return false;
  const core = bundle.slice(0, -".framework".length);
  return fs.existsSync(path.join(fwDir, bundle, "Versions", "Current", core));
}

function usable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
  } catch {
    return false;
  }
  return appBundleLoadable(p);
}

function findChrome() {
  const envBin = process.env.GOSSLAN_CHROME;
  if (envBin && fs.existsSync(envBin)) {
    BROWSER_SOURCE = "GOSSLAN_CHROME 指定";
    return envBin;
  }
  const base = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
    : path.join(process.env.HOME || os.homedir(), ".cache", "ms-playwright");
  const cands = [];
  if (fs.existsSync(base)) {
    for (const dir of fs.readdirSync(base)) {
      if (!/^chromium-/.test(dir)) continue;
      cands.push(path.join(base, dir, "chrome-mac-arm64", "Google Chrome for Testing.app",
        "Contents", "MacOS", "Google Chrome for Testing"));
      cands.push(path.join(base, dir, "chrome-linux64", "chrome"));
    }
  }
  const pinned = cands.find(usable);
  if (pinned) {
    BROWSER_SOURCE = "playwright 缓存（Chrome for Testing）";
    return pinned;
  }
  const system = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const fallback = system.find(usable);
  if (fallback) {
    BROWSER_SOURCE = cands.some((p) => fs.existsSync(p))
      ? "系统浏览器回退（playwright 缓存里那台存在但装坏了：框架二进制缺失）"
      : "系统浏览器回退（没装 playwright 那份缓存）";
    return fallback;
  }
  return null;
}

/** 端口上有没有人监听（200 ms 内握不上手就算没有）。 */
function portListening(port, timeoutMs = 200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

/**
 * 起不到 CDP 时把这台机器问得出的读数一次打全。
 *
 * 为什么要这么多行：以前这里只有一句「CDP /json/list 里一直没有 page target」，
 * 于是两种完全不同的病长得一模一样 —— ① spawn 并入了用户自己已开着的浏览器实例（那个实例不带
 * 调试端口，进程当场退掉、端口无人监听）；② 浏览器起来了但页面 target 慢或没了。
 * ①「进程已退出 + 端口无人监听」两条同时成立才是并入，修法是把在跑的实例关掉或换一台干净的；
 * ②要查的是 target 侧。归因靠读数，不靠猜。
 */
async function cdpDiagnostics(chrome, port, procState, lastErr, budgetMs) {
  const out = [`浏览器：${chrome}`, `来源：${BROWSER_SOURCE}`];
  const v = spawnSync(chrome, ["--version"], { timeout: 5000, encoding: "utf8" });
  out.push(`版本：${v.status === 0 ? String(v.stdout || "").trim() : `问不出（--version 退码 ${v.status}${v.error ? `/${v.error.code}` : ""}）`}`);
  out.push(`我起的那个进程：${procState.exited
    ? `已退出 code=${String(procState.exited.code)} signal=${String(procState.exited.signal)}`
    : `到预算点仍在跑（pid ${procState.pid ?? "?"}）`}`);
  const listening = await portListening(port);
  out.push(`端口 ${port}：${listening ? "有人在监听 ⇒ 浏览器起来了，问题在 target 那侧" : "无人监听"}`);
  if (!listening && procState.exited) {
    out.push("两条同时成立 ⇒ 最可能是这次 spawn 并入了同类的**已存在实例**（它不带 --remote-debugging-port）。"
      + "修法：关掉正在跑的浏览器实例，或用 GOSSLAN_CHROME 指一台干净的。");
  }
  out.push(`最后一次尝试（预算 ${budgetMs} ms，env GOSSLAN_PROBE_CDP_WAIT_MS 可调）：${lastErr}`);
  return out;
}

/** 极简 CDP 客户端：id 配对、一次 eval 一个往返。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiters = new Map();
    /**
     * 最近 24 条 **CDP 事件**（不是回包）的尾巴。为什么只有回包不够：
     * 一次调用不回包时，"renderer 为什么不响应"这件事其实写在事件流里 ——
     * `Page.javascriptDialogOpening`（原生 alert/beforeunload 那类弹窗会**冻住主线程**，
     * 之后每条 eval 永远不回）、`Page.frameStartedNavigating`/`frameNavigated`（卡在哪一步导航）、
     * `Runtime.executionContextDestroyed`（我 eval 的那个上下文已经没了）。
     * 旧代码这里 `if (!w) return` 直接把事件丢掉 ⇒ 三种形状在日志里长得一模一样。
     * 只留尾巴：这段一跑就是几百次调用，全量会把有用的那几条冲走。
     */
    this.eventTail = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.method && msg.id === undefined) {
        this.eventTail.push(`${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 120)}`);
        if (this.eventTail.length > 24) this.eventTail.shift();
      }
      const w = this.waiters.get(msg.id);
      if (!w) return;
      this.waiters.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
      else w.resolve(msg.result);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
      setTimeout(() => rej(new Error("CDP 握手超时")), 10_000);
    });
    return new Cdp(ws);
  }
  send(method, params = {}, awaitReply = true) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    if (!awaitReply) return Promise.resolve(null);
    let rejectCall = null;
    const p = new Promise((res, rej) => {
      rejectCall = rej;
      this.waiters.set(id, { resolve: res, reject: rej });
    });
    // 有界等待：一次调用**永不到账**时不能静等（旧代码就是这样，整段卡在那里十几分钟，
    // 只能靠人 kill）。报出去的是"哪条 CDP 调用没回包"，不是产品缺陷。
    const guard = setTimeout(() => {
      if (!this.waiters.delete(id)) return; // 回包已经到了 ⇒ 这条守卫作废
      // ★ 报出去的要能**自己定位**：旧版只说"哪条 CDP 调用没回包"，于是一趟卡死之后
      //   只能用 `--only=` 逐段复跑去二分（2026-10-20 归因那次跑了四趟才圈到 overlay，
      //   而且四段里还有一段是"单独跑绿、连着跑红"，二分本身给了假结论）。
      //   现在这三样都直接印出来：死在前一格是谁、还挂着几条没到账、事件流最后发生了什么。
      rejectCall(new Error(`CDP 调用「${method}」在 ${CDP_CALL_MS} ms 内没回包`
        + "（renderer 主线程很可能已经不响应）⇒ 响亮失败，这一格记没跑，不是产品红"
        + "；预算见 GOSSLAN_CDP_CALL_MS"
        + `；死在前一格 = ${lastCellMark}`
        + `；仍未到账的调用 ${this.waiters.size} 条`
        + `；事件尾巴 ${JSON.stringify(this.eventTail.slice(-6))}`));
    }, CDP_CALL_MS);
    return p.finally(() => clearTimeout(guard));
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, onlyPromise: false,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面里抛错：${r.exceptionDetails.exception?.description
        ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }
  /**
   * 一次真按键。`chars` 决定要不要发 char（Enter 是 "\r"、空格是 " "）；
   * ★ 三条消息**不逐条 await** —— 见文件头纪律 1（逐条 await = 自动重复风暴）。
   */
  async key(key, code, text, keyCode) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    const send = (params) => this.ws.send(JSON.stringify({ id: ++this.seq,
      method: "Input.dispatchKeyEvent", params }));
    // ★ 发法是 `keyDown`(带 text) + `keyUp`，**不是** `rawKeyDown`+`char`+`keyUp`。
    // 2026-10-10 四档对照实测（CfT 153，同一段 --only=reaction）：
    //   rawKeyDown **带 text** ⇒ 按完 28 次激活、空等 1 秒再涨 558（自持重复风暴，补发 keyUp 也不终止）
    //   rawKeyDown 不带 text + char + keyUp ⇒ 1 次、无增长
    //   keyDown 带 text + keyUp ⇒ 1 次、无增长 ← 本档（两台引擎整跑各 192/192：CfT 153 与 Brave 155）
    // 三条消息仍**同帧发出**（纪律 1：逐条 await = 按住不放）。
    send({ type: "keyDown", ...base, ...(text ? { text } : {}) });
    send({ type: "keyUp", ...base });
    await sleep(90);
  }
  /**
   * 把指针真的移到某个坐标上（`Input.dispatchMouseEvent`）。
   * 为什么要两条：CSS 的 `:hover` 只在浏览器真的移动过指针时才成立，
   * 用 `elementFromPoint` 或加 class 都替代不了 —— 而那颗表情入口恰恰是 `hidden group-hover/msg:flex`
   * （N19 之前它写的是 `hidden group-hover/msg:flex` ⇒ 不悬停根本不在布局里，任何几何都量不到；
   * 现在改成 opacity 藏，几何随时量得到，但"看得见"这件事仍然只有真移动过一次指针才成立）。
   * 先移到别处再移到目标点，逼一次重新命中。
   */
  async hover(x, y) {
    const send = (cx, cy) => this.ws.send(JSON.stringify({
      id: ++this.seq, method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: cx, y: cy },
    }));
    send(Math.max(0, x - 120), Math.max(0, y - 60));
    await sleep(30);
    send(x, y);
    await sleep(120);
  }
  /**
   * 真的按下一次左键（mouseMoved → mousePressed → mouseReleased）。
   * 和 hover 同理：DOM 上 `el.click()` 不经过命中测试，也就照不出"这颗按钮其实被谁盖住了"。
   */
  async click(x, y) {
    const base = { x, y, button: "left", clickCount: 1 };
    this.ws.send(JSON.stringify({
      id: ++this.seq, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", ...base },
    }));
    await sleep(40);
    this.ws.send(JSON.stringify({
      id: ++this.seq, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...base },
    }));
    await sleep(60);
    this.ws.send(JSON.stringify({
      id: ++this.seq, method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...base },
    }));
    await sleep(160);
  }
  /**
   * 真的按住并拖一段（mousePressed → 若干 mouseMoved → mouseReleased，全程 `button:"left"`）。
   *
   * 为什么要新加这一条：任务中心那颗药丸的"拖到四个角"是**指针位移阈值**驱动的
   * （按下与拖动必须分开，否则点一下会被判成拖动、面板打不开）。这种"按住—移动—松手"
   * 在 DOM 上派发事件量不到：`dispatchEvent(new PointerEvent(...))` 不经命中测试，
   * 也不会让浏览器真的把 pointer 捕获到那个元素上。
   * 中途分多帧移动是必要的 —— 一发到位只会让组件看到"按下即已在终点"，
   * 阈值那一段（先不动、动过 6px 才算拖）就没有作用点。
   */
  async drag(x1, y1, x2, y2, steps = 8) {
    const send = (type, x, y) => this.ws.send(JSON.stringify({
      id: ++this.seq, method: "Input.dispatchMouseEvent",
      params: { type, x, y, button: "left", clickCount: 1 },
    }));
    send("mouseMoved", x1, y1);
    await sleep(40);
    send("mousePressed", x1, y1);
    await sleep(60);
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      send("mouseMoved", Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
      await sleep(30);
    }
    send("mouseReleased", x2, y2);
    await sleep(200);
  }
}

// ── 页面侧装进 window 的夹具（一次装好，之后每步只调函数）────────────
const PAGE_FIXTURE = `
window.__probe = (() => {
  const events = [];
  let clickCount = 0;
  const H = { events, get clicks() { return clickCount; } };
  H.reset = () => { events.length = 0; clickCount = 0; };
  H.install = async (cmpPath, mountHtml, propsJson) => {
    // 必须拿"页面已经在用的那一份 vue"，自己 import('vue') 会得到第二份（ref/reactive 互不相认）。
    // 而这条要**等**：Page.navigate 之后 vite 还在现编译依赖，resources 里出现 deps/vue.js 之前
    // 拿到的是空列表 —— 拿不到就当"构建产物变了"是误判。
    // （这里刻意用 includes 而不是正则：这段是**模板字符串里的源码**，反斜杠会被模板吃掉一层。）
    const VUE_MARK = '/node_modules/.vite/deps/vue.js?v=';
    let vueUrl = null;
    const resUrls = () => performance.getEntriesByType('resource').map((e) => e.name || '');
    for (let i = 0; i < 120 && !vueUrl; i += 1) {
      // 注意是 entry.name —— 资源计时条目里 URL 不在 .url 上（写成 e.url 会得到 undefined）
      vueUrl = resUrls().find((u) => u.includes(VUE_MARK)) ?? null;
      if (!vueUrl) await new Promise((r) => setTimeout(r, 500));
    }
    if (!vueUrl) {
      const seen = resUrls().map((u) => u.split('/').slice(-2).join('/'));
      throw new Error('60s 内没等到 deps/vue.js。已加载的资源尾巴：' + JSON.stringify(seen.slice(0, 12)));
    }
    const Vue = await import(vueUrl);
    const mod = await import(cmpPath);
    // 样式表**也要等**，而且是同一类竞态的另一半：vite dev 把 style.css 当模块注入，
    // navigate 之后它可能还在飞。没穿上衣服的页面里所有计算样式都是 0px / clip，
    // 于是「两枚徽标的半径不同」「名字必须是省略号」这类判据会报成设计回归 —— 而真相只是时机。
    // （2026-09-30 本地实测：同一份内容两次跑，第一次这两条红、第二次全绿 ⇒ 不是回归，是没等。）
    // 判据现读 :root 上那个 token：它由 style.css 定义，取到非空值就等于那份样式表已经生效。
    let cssReady = false;
    for (let i = 0; i < 60 && !cssReady; i += 1) {
      const tok = String(getComputedStyle(document.documentElement).getPropertyValue('--gosslan-radius-pill') || '').trim();
      cssReady = tok !== '';
      if (!cssReady) await new Promise((r) => setTimeout(r, 250));
    }
    if (!cssReady) {
      throw new Error('15s 内样式表没生效（--gosslan-radius-pill 取不到值）⇒ 计算样式全是 0，下面的判据只能假红');
    }
    // 组件里用 useAppStore() ⇒ 必须给这一个 app 挂上 pinia，而且要用**页面已经在用的那份 pinia**
    // （自己 import('pinia') 会拿到第二份实例，store 互不相认，报的错还长得像"store 坏了"）。
    let pinia = null;
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (piniaUrl) {
      const P = await import(piniaUrl);
      pinia = P.createPinia();
    }
    document.body.innerHTML = mountHtml;
    const host = document.createElement('div');
    host.id = 'probe-host';
    document.body.appendChild(host);
    const state = Vue.reactive({ open: false, initialKeyword: '', groupId: null, selectValue: 'b', liveModel: false, isolated: false });
    window.__st = state;
    // 夹具原先把 props 写死成 open/initialKeyword + 三个回调；任务卡那一族要的是
    // message / liveTodo / mentionNames / selfMention ⇒ 第三参收一份 JSON props。
    // liveTodo 是 Map，JSON 传不了 ⇒ 约定用 liveTodoPairs（[[id,status,category,number],…]）在这里还原，
    // 而且**必须走应用自己那份 todoLiveMap**（import 到的还是组件用的同一个模块实例）：
    // 在这里手写一遍"字母怎么拼、几位要缩短"就是给编号口径开第二个家，探针会先骗过自己。
    const extra = propsJson ? JSON.parse(propsJson) : {};
    // 受控 v-model 的夹具开关（--only=select）：开了才把 modelValue 接进 state.selectValue，
    // 其余段一律不注入 modelValue，避免给没有这个 prop 的组件多挂一条 fallthrough 属性。
    if (extra.liveModel) state.liveModel = true;
    delete extra.liveModel;
    // 通用夹具会给每个组件塞 open/initialKeyword/groupId。根节点恰好是 SelectRoot 时，
    // open=false 会经 fallthrough 变成"受控且永不打开"——测出来像库坏了，其实是夹具串味。
    // isolated=true 时只传调用方显式给的 props（--only=select 用）。
    if (extra.isolated) state.isolated = true;
    delete extra.isolated;
    if (Array.isArray(extra.liveTodoPairs)) {
      const T = await import('/src/utils/todos.ts');
      extra.liveTodo = T.todoLiveMap(extra.liveTodoPairs.map((p) => ({
        todoId: p[0], status: p[1], category: p[2], number: p[3],
      })));
      delete extra.liveTodoPairs;
    }
    // ★ 这个对象必须**建在渲染函数里面**：open: state.open 是对 reactive 状态的读，
    //   提到外面求值一次就把 props 冻在 false 上 —— 表情面板那段当场整块不渲染（格子数 0），
    //   是隔壁那两段把它照出来的（**夹具的重构也要跑全量，别只跑新写的那一段**）。
    //   另：这一段是模板字符串里的源码，注释里也不许出现反引号（会提前结束模板）。
    const mkProps = () => {
      const props = {
        ...(state.isolated ? {} : {
        open: state.open,
        initialKeyword: state.initialKeyword,
        groupId: state.groupId,
        onSelect: (v) => events.push(['select', v]),
        onClose: () => events.push(['close']),
        onOpenConversation: (p) => events.push(['open', JSON.stringify(p)]),
        // 任务卡底部那个入口 emit 的是 "open"（载荷是 todo_id）。tag 刻意叫 open-id：
        // 与上面那条 'open'（搜索弹窗的 open-conversation）区分开，免得两段互相污染判据。
        onOpen: (v) => events.push(['open-id', String(v)]),
        // 任务卡**主体**（头部/描述/指派人）emit 的是 "open-panel"（不带 id，
        // 与底部"直达这一条详情"区分）。tag 与 open-id 对齐。
        onOpenPanel: () => events.push(['open-panel']),
        // 默认头像选择器（--only=avatar）：确认时把组合记进账本。
        onApply: (seed) => events.push(['apply', seed && seed.emoji, seed && seed.bg]),
        // 输入框那一族（--only=inputpanel）要读得到"这条到底带不带 @ 的名单"：
        // 编辑器上只有 token 的 DOM，载荷才有 mentionIds ⇒ 没有 onSend 就只能看 DOM 猜。
        onSend: (p) => events.push(['send', JSON.stringify(p)]),
        onAttach: () => events.push(['attach']),
        }),
        // TodoPickField 的 v-model：把选中值记进账本（--only=todopick）。
        'onUpdate:modelValue': (v) => {
          events.push(['update', String(v)]);
          if (state.liveModel) state.selectValue = v;
        },
      };
      if (state.liveModel) props.modelValue = state.selectValue;
      return props;
    };
    const app = Vue.createApp({
      setup() {
        return () => Vue.h(mod.default, Object.assign(mkProps(), extra));
      },
    });
    if (pinia) app.use(pinia);
    window.__pinia = pinia;
    // TanStack Query：组件用 useQuery/useQueryClient 时，夹具 app 必须装同一份插件。
    // vue-query 的预构建文件是组件 import 时加载的 ⇒ 从资源条目取真实 URL，不手拼版本号。
    const qUrl = resUrls().find((u) => u.includes('/deps/') && u.includes('vue-query.js?v='));
    if (qUrl) {
      const Q = await import(qUrl);
      window.__qc = new Q.QueryClient();
      app.use(Q.VueQueryPlugin, { queryClient: window.__qc });
    }
    app.mount(host);
    window.__probe.vue = Vue;
    window.__probe.state = state;
    await Vue.nextTick(); await Vue.nextTick();
    document.addEventListener('click', () => { clickCount++; }, true);
    return { ok: true, cmp: cmpPath, pinia: !!pinia };
  };
  /**
   * 同一页挂**多条消息**（右键段「连续右键不同消息」用）。
   * 复用页面那份 vue/pinia；每条 props 直接给 MessageItem（不再经过通用夹具）。
   * 先借一次普通 install 把 vue/pinia 拿进来，再整体换宿主。
   */
  H.installMessages = async (listJson) => {
    if (!window.__probe.vue) {
      await H.install('/src/components/MessageItem.vue', '', JSON.stringify({
        message: { msg_id: 'warm', sender_id: 'peer-a', kind: 'text', content: 'warm', ts: 1, conv_id: 'c', seq: 1 },
      }));
    }
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: 'no-vue' };
    const mod = await import('/src/components/MessageItem.vue');
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'probe-host';
    document.body.appendChild(host);
    const list = JSON.parse(listJson);
    const app = V.createApp({
      setup() {
        return () => V.h('div', {}, list.map((p) => V.h(mod.default, p)));
      },
    });
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    window.__probe.vue = V;
    await V.nextTick(); await V.nextTick();
    return { ok: true };
  };
  /** 受控下拉（--only=select）：选中值写回 state.selectValue，才能读"触发器文案跟着变"。 */
  H.selectMount = async () => H.install(
    '/src/components/ui/SettingsSelect.vue',
    '<button id="opener">opener</button>',
    JSON.stringify({
      isolated: true,
      liveModel: true,
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
      selectLabel: '测试选择',
      triggerClass: 'max-w-[180px]',
    }),
  );
  /**
   * 右键菜单专用挂载：把 MessageContextMenu 包在"父组件收到 close 就卸载"的状态里。
   * 普通 install 只把 emit 记进账本、不会卸载组件 ⇒ "关掉之后 DOM 是否撤净"无法读。
   * 打开前先聚焦一个固定按钮，用来判"关闭后焦点有没有还回去"。
   */
  H.installMenu = async (propsJson, specJson) => {
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: '先跑一次 install 把页面那份 vue 拿进来' };
    // spec 让这段能量**业务菜单**（§6.88 带回的结论：要挂父级、靠状态渲染，不能把菜单组件当根强开）。
    // 不传 spec 就还是消息菜单那一份 ⇒ ctxmenu 段的既有调用零改动。
    const spec = specJson ? JSON.parse(specJson) : {};
    const path = spec.path || '/src/components/message/MessageContextMenu.vue';
    const mod = await import(path);
    document.body.innerHTML = '<button data-probe-opener id="opener">触发点</button>';
    const opener = document.querySelector('[data-probe-opener]');
    if (opener) opener.focus();
    const host = document.createElement('div');
    host.id = 'probe-host';
    document.body.appendChild(host);
    const st = V.reactive({ open: true });
    const base = JSON.parse(propsJson);
    const handlers = {
      onClose: () => { events.push(['close']); st.open = false; },
    };
    const emitNames = spec.emits || ['copy-text', 'copy-image', 'save-image', 'save-file', 'copy-file',
      'quote', 'locate-quote', 'recall', 'pin', 'forward', 'favorite', 'cancel-send',
      'remind', 'multi-select'];
    for (const name of emitNames) {
      const key = 'on' + name.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('');
      handlers[key] = () => events.push([name]);
    }
    const app = V.createApp({
      setup() {
        return () => st.open ? V.h(mod.default, Object.assign({}, base, handlers)) : null;
      },
    });
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    window.__probe.vue = V;
    await V.nextTick(); await V.nextTick();
    return { ok: true };
  };
  /**
   * 图片预览的专用挂载：先聚焦一颗真按钮当 opener，再按 open/index 受控挂载。
   * 普通 install 的 onClose 只记账、不翻 open ⇒ 量不到"关闭后焦点归还"与"卸载后 DOM 撤净"。
   */
  H.lightboxMount = async () => {
    // 这一段没有别的 install 先垫场：先借 install 拿到页面那份 vue/pinia（关着渲染），
    // 再换成"opener + 受控 open/index"的专用宿主。
    if (!window.__probe.vue) {
      await H.install('/src/components/message/ImageLightbox.vue', '', JSON.stringify({ images: [], index: 0 }));
    }
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: '先跑一次 install 把页面那份 vue 拿进来' };
    const mod = await import('/src/components/message/ImageLightbox.vue');
    document.body.innerHTML = '<button id="opener" type="button">打开预览</button>';
    document.getElementById('opener').focus();
    const host = document.createElement('div');
    host.id = 'probe-host';
    document.body.appendChild(host);
    const st = V.reactive({ open: true, index: 0 });
    window.__lbState = st;
    const images = [
      { dataSrc: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', name: 'one.gif' },
      { dataSrc: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', name: 'two.gif' },
    ];
    const app = V.createApp({
      setup() {
        return () => V.h(mod.default, {
          images,
          index: st.index,
          open: st.open,
          onClose: () => { window.__probe.events.push(['close']); st.open = false; },
          'onUpdate:index': (v) => { st.index = v; },
        });
      },
    });
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    window.__probe.vue = V;
    await V.nextTick(); await V.nextTick();
    return { ok: true };
  };
  /** 第一个带 aria-haspopup=menu 的按钮中心点（三选一字段那一段用）。 */
  H.firstMenuTrigger = () => {
    const b = document.querySelector('button[aria-haspopup="menu"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  /** 第一个开关的可访问属性与落点（SettingsToggle 那一段用）。 */
  H.switchInfo = () => {
    const el = document.querySelector('[role="switch"]');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    return {
      present: true,
      checked: el.getAttribute('aria-checked'),
      label: el.getAttribute('aria-label'),
      busy: el.getAttribute('aria-busy'),
      disabled: el.hasAttribute('disabled'),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  };
  /** 菜单的几何、条目集合与焦点位置（右键菜单那一段的读数来源）。 */
  H.menu = () => {
    const el = document.querySelector('[role="menu"].gosslan-menu');
    if (!el) return { present: false, active: -1, items: [] };
    const r = el.getBoundingClientRect();
    const items = Array.from(el.querySelectorAll('[role="menuitem"]'));
    const cs = getComputedStyle(el);
    return {
      present: true,
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      vw: window.innerWidth, vh: window.innerHeight,
      items: items.map((i) => String(i.textContent || '').trim()),
      active: items.indexOf(document.activeElement),
      activeText: String((document.activeElement && document.activeElement.textContent) || '').trim(),
      orientation: el.getAttribute('aria-orientation'),
      side: el.getAttribute('data-side'),
      bg: cs.backgroundColor,
    };
  };
  /**
   * 标题栏 × 内容浮层那一路的**合成**夹具（2026-09-30 用户：「所有独立窗口标题栏都不会被内容栏遮住」）。
   * 单挂一个组件量不出这件事：要判的是**绘制顺序 + 命中测试**，必须让 caption 与遮罩真的在同一个
   * 根层叠上下文里共存。这里按辅助窗口的真实组成挂：TitleBar + 内容 + ImageLightbox（teleport 到 body）。
   *
   * ⚠️ 2026-10-20 改过一次：旧签名收 topInset（那条 prop 只服务辅助窗，§6.91 已删）。
   * 现在「谁让开顶部」完全由生产码自己决定 —— 夹具只能选**宿主形状**（isMobile 传给
   * TitleBar，has-caption 由它自己写），夹具不再替产品摆位，否则量的就是夹具。
   */
  H.composeStack = async (opts) => {
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: '先跑一次 install 把页面那份 vue 拿进来' };
    const o = opts || {};
    const [tbM, lbM] = await Promise.all([
      import('/src/components/TitleBar.vue'),
      import('/src/components/message/ImageLightbox.vue'),
    ]);
    const TitleBar = tbM.default;
    const Lightbox = lbM.default;
    document.body.innerHTML = '';
    // 清掉上一份夹具留下的那个类：这些合成 app 从不 unmount ⇒ TitleBar 的卸载钩子不会跑，
    // 留着旧值会把「没有 caption」那一档量成「有」（读数照样是 28，看着像产品没让位）。
    document.documentElement.classList.remove('has-caption');
    // 「窄起来的桌面窗」这一档靠 is-mobile 表达（生产里由宽度媒体查询驱动，探针里没有真窗口，
    // 只能由夹具把它钉上 —— 钉的就是 resolveMobileLayout 那个 ≤767 的兜底档）。
    document.documentElement.classList.toggle('is-mobile', !!o.narrow);
    const host = document.createElement('div');
    host.id = 'stack-host';
    host.className = 'flex h-screen flex-col overflow-hidden';
    document.body.appendChild(host);
    const Root = {
      render() {
        return V.h('div', { class: 'flex h-full flex-col' }, [
          // isMobile 时 TitleBar 自己 v-if 不画、也不写 has-caption —— 与真应用的移动端主窗一致。
          V.h(TitleBar, { title: '小院儿 · 图片预览', isMobile: !!o.isMobile }),
          V.h('div', { class: 'min-h-0 flex-1 bg-white' }, '内容区'),
          V.h(Lightbox, {
            images: [{ dataSrc: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', name: 'probe.gif' }],
            index: 0,
            open: true,
            hideClose: true,
            onClose: () => { window.__probe.events.push(['close']); },
            'onUpdate:index': () => {},
          }),
        ]);
      },
    };
    const app = V.createApp(Root);
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    await V.nextTick(); await V.nextTick();
    return { ok: true, isMobile: !!o.isMobile, narrow: !!o.narrow };
  };
  /** 现读那一横条与那张遮罩的矩形、层级，以及 caption 中点**实际命中的是谁**。 */
  H.stackRead = () => {
    const cap = document.querySelector('[data-caption]');
    const ov = document.querySelector('[role="dialog"]');
    if (!ov) return { ok: false, why: '没挂出遮罩' };
    const or = ov.getBoundingClientRect();
    const cr = cap ? cap.getBoundingClientRect() : null;
    const hit = cap
      ? document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2))
      : null;
    return {
      ok: true,
      hasCaption: !!cap,
      // 这两个不是一件事：元素在不在 ≠ 那个类在不在。CSS 键的是类 ⇒ 只有读类才咬得住
      // "TitleBar 不申报了"（2026-10-20 一发变异实测：只读元素时，写者断了那两条照样绿）。
      captionClass: document.documentElement.classList.contains('has-caption'),
      capTop: cr ? Math.round(cr.top) : null, capBottom: cr ? Math.round(cr.bottom) : null,
      capZ: cap ? getComputedStyle(cap).zIndex : null, ovZ: getComputedStyle(ov).zIndex,
      ovTop: Math.round(or.top),
      hitInCaption: !!hit && !!cap && (hit === cap || cap.contains(hit)),
      hitTag: hit ? (hit.tagName + '.' + String(hit.className).slice(0, 40)) : 'null',
    };
  };
  /** 反面对照用：把 caption 的层级按回修之前（非定位、无 z-index）⇒ 同一点必须不再命中标题栏。 */
  H.setCaptionStack = (mode) => {
    const cap = document.querySelector('[data-caption]');
    if (!cap) return false;
    if (mode === 'off') { cap.style.zIndex = '0'; cap.style.position = 'static'; }
    else { cap.style.zIndex = ''; cap.style.position = ''; }
    return true;
  };
  /**
   * 对照用：摘掉/挂上 has-caption 那枚**由 TitleBar 自己写**的类（2026-10-20）。
   * 只用于合成"修之前"的几何（让位失效 ⇒ 遮罩真的压到标题栏那条上），在那一档里层级判据
   * 才有东西可咬；正常档位里让位是几何给的，做层级对照是恒真。
   */
  H.setCaptionClass = (on) => document.documentElement.classList.toggle('has-caption', !!on);

  /**
   * §6.95「回车 = 一个动作」那一路的夹具（2026-10-20）。
   *
   * 这里量的是**事件顺序 + Vue 的真实接线**：挂一个真 input，用生产模板一模一样的三行
   * （onKeydown 走 ime.enter、onCompositionstart/end 走 ime.onStart/onEnd），动作只数次数。
   * 文本量具（designGuards 判据 53）只能证明"码里引了这个家"，证不了这三件事：
   *   ① 组合期间的 Enter 真的不触发（rule ①/②）；
   *   ② macOS WKWebView 那个顺序 —— compositionend **先于** keydown、那一刻
   *      isComposing 已是 false —— 仍然不触发（rule ③，80ms 窗）；
   *   ③ 过了窗之后干净回车**必须**触发（否则①②是"永远不触发"的恒真绿）。
   * ⚠️ 事件是合成的（浏览器没有假输入法可驱动）⇒ 这里证的是机制，不是真机 IME；
   *    iOS/Android 真键盘那一格仍归用户（本仓口径：合成事件不许冒充真机通过）。
   */
  H.imeMount = async () => {
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: '先跑一次 install 把页面那份 vue 拿进来' };
    const mod = await import('/src/composables/useImeEnterGuard.ts');
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'ime-host';
    document.body.appendChild(host);
    window.__probe.imeCalls = 0;
    const ime = mod.useImeEnterGuard();
    window.__probe.imeAreaCalls = 0;
    // 多行框那一档：模板里同时写 @keydown.meta.enter.prevent 与 @keydown.ctrl.enter.prevent，
    // Vue 编译成**一个 onKeydown 挂两枚处理器**（各自 withKeys(withModifiers(...))）。
    // 这里按同一串挂，量的是"裸回车不许提交（那一下属于换行）、Ctrl+Enter 必须提交"这一对
    // —— 群公告与任务描述用的就是这个形状。
    const areaCommit = function () { window.__probe.imeAreaCalls += 1; };
    const areaHandler = (modName) => V.withKeys(
      V.withModifiers(function (e) { ime.enter(areaCommit, e); }, [modName, 'prevent']),
      ['enter'],
    );
    const Root = {
      render() {
        return V.h('div', {}, [
          V.h('input', {
            id: 'ime-field',
            onKeydown: ime.enter(function () { window.__probe.imeCalls += 1; }),
            onCompositionstart: ime.onStart,
            onCompositionend: ime.onEnd,
          }),
          V.h('textarea', {
            id: 'ime-area',
            onKeydown: [areaHandler('meta'), areaHandler('ctrl')],
            onCompositionstart: ime.onStart,
            onCompositionend: ime.onEnd,
          }),
        ]);
      },
    };
    V.createApp(Root).mount(host);
    return { ok: true, hasField: !!document.getElementById('ime-field'),
      hasArea: !!document.getElementById('ime-area') };
  };
  /** 按参数决定这一轮先后发哪些事件；Enter 的 isComposing 也由参数钉（要能造出 macOS 那个顺序）。 */
  H.imePress = (o) => {
    const el = document.getElementById('ime-field');
    if (!el) return { ok: false, why: '没有 ime 夹具输入框' };
    const s = o || {};
    if (s.start) el.dispatchEvent(new CompositionEvent('compositionstart'));
    if (s.text != null) el.value = s.text;
    if (s.end) el.dispatchEvent(new CompositionEvent('compositionend'));
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: s.composing ? 229 : 13, bubbles: true, cancelable: true,
      isComposing: !!s.composing,
    }));
    return { ok: true, calls: window.__probe.imeCalls };
  };
  /** 把时钟推过那条 80ms 提交窗（正向那一格要在窗外发才有效，否则两格量的是同一件事）。 */
  H.imeWait = (ms) => new Promise((res) => { setTimeout(() => res({ ok: true, waited: ms }), ms); });

  /**
   * 标题栏 × **卡片弹窗**那一路的合成夹具（2026-10-12：窗口显示安全区）。
   *
   * 与 'composeStack' 的区别：那一路合成的是 ImageLightbox（整屏遮罩），这一路合成的是
   * 'BaseModal' 的**卡片形态** —— 要判的是"卡片顶边是否落在 caption 底边之下"，
   * 而卡片自己的 'max-h' 又依赖 '--gosslan-window-safe-top'，所以必须真挂真量；
   * 静态判据只能证"源码里读了变量"，证不了"读完之后卡片真的让开了"。
   *
   * 'long' 给长内容（把卡片顶到 max-h 上限）—— 矮视口 + 长内容是用户报的那个形状。
   * 'isMobile' 切 '<html class="is-mobile">'：移动端该变量必须是 0（零回归那半边）。
   */
  H.composeModalStack = async (opts) => {
    const V = window.__probe.vue;
    if (!V) return { ok: false, why: '先跑一次 install 把页面那份 vue 拿进来' };
    const o = opts || {};
    // 布局档：is-mobile 只决定**布局**（Tailwind 的 desktop: 变体读它）。
    // 「有没有 caption」不在这儿 —— 那件事由 TitleBar 自己写成 html.has-caption，
    // CSS 的 --gosslan-window-safe-top 挂在那个类上（2026-10-20：窄起来的桌面辅助窗
    // 画着 caption 却按布局档被判成没有 ⇒ 遮罩压住标题栏）。
    document.documentElement.classList.toggle('is-mobile', !!o.isMobile);
    document.documentElement.classList.remove('has-caption');
    const [tbM, bmM] = await Promise.all([
      import('/src/components/TitleBar.vue'),
      import('/src/components/BaseModal.vue'),
    ]);
    const TitleBar = tbM.default;
    const BaseModal = bmM.default;
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'modal-stack-host';
    // 真宿主形状：'h-screen flex-col' + 流内 TitleBar + 内容区（与 ResponsiveLayout 同构）。
    host.className = 'flex h-screen flex-col overflow-hidden';
    document.body.appendChild(host);
    const long = 'x'.repeat(o.long === false ? 40 : 4000);
    const Root = {
      render() {
        return V.h('div', { class: 'flex h-full flex-col' }, [
          // isMobile 时 TitleBar 自己 'v-if="!isMobile"' 不渲染 —— 与真应用一致。
          // ⚠️ 必须**把 isMobile 传下去**：html 上那个 'is-mobile' 类只影响 CSS 变量，
          // TitleBar 的显隐读的是 prop（v-if=!isMobile）。第一版只切了类、没传 prop
          // ⇒ 移动端那一档 caption 照旧渲染，三条移动判据全红（实测踩过）。
          V.h(TitleBar, { title: '小院儿', isMobile: !!o.isMobile }),
          V.h('div', { class: 'min-h-0 flex-1 bg-white' }, '内容区'),
          V.h(BaseModal, {
            open: true,
            title: '探针弹窗',
            width: 'max-w-sm',
            onClose: () => { window.__probe.events.push(['close']); },
          }, (() => {
            const s = { default: () => V.h('div', { id: 'probe-long' }, long) };
            // footer 插槽是**可选**的（BaseModal 里写的是 'v-if="$slots.footer"'）：
            // 不传时挂出来的形状与既有那 7 条判据一模一样 ⇒ 加这一档不动老结论。
            if (o.footer) s.footer = () => V.h('div', { id: 'probe-footer' }, '操作条');
            return s;
          })()),
        ]);
      },
    };
    const app = V.createApp(Root);
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    await V.nextTick(); await V.nextTick();
    return { ok: true, isMobile: !!o.isMobile, long: o.long !== false };
  };
  /**
   * 现读卡片矩形、caption 矩形、安全区变量的**计算值**，以及"卡片顶边是否在 caption 之下"。
   *
   * ⚠️ 安全区变量读的是 'getComputedStyle(document.documentElement)' 上的值 ——
   * 那是"CSS 真的生效了"的证据（读源码只能证"写了"）。顶层那条 N7 教训
   * （"写了没生效"）正是靠这种现读才戳穿的。
   */
  H.modalStackRead = () => {
    const cap = document.querySelector('[data-caption]');
    const layer = document.querySelector('[role="dialog"]');
    const panel = document.querySelector('[role="dialog"] .elevated');
    const row = panel?.parentElement ?? null;
    if (!panel) return { ok: false, why: '没挂出 .elevated 卡片（BaseModal 没渲染？）' };
    const pr = panel.getBoundingClientRect();
    const cr = cap ? cap.getBoundingClientRect() : null;
    const safeTop = getComputedStyle(document.documentElement)
      .getPropertyValue('--gosslan-window-safe-top').trim();
    // 滚动层顶边（就是"让开之后"那条线的几何证据）
    const sr = layer?.getBoundingClientRect() ?? null;
    const cs = panel ? getComputedStyle(panel) : null;
    return {
      ok: true,
      safeTop,
      hasCaption: !!cap,
      capBottom: cr ? Math.round(cr.bottom) : null,
      cardTop: Math.round(pr.top),
      cardBottom: Math.round(pr.bottom),
      scrollTop: sr ? Math.round(sr.top) : null,
      innerHeight: window.innerHeight,
      // 几何诊断：卡片被 max-h 夹住后还剩多少可居中空间，直接读结构而不是猜
      layerH: sr ? Math.round(sr.height) : null,
      rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
      rowPadTop: row ? getComputedStyle(row).paddingTop : null,
      cardH: Math.round(pr.height),
      cardMaxH: cs ? cs.maxHeight : null,
      cardMarginTop: cs ? cs.marginTop : null,
      cardMarginBottom: cs ? cs.marginBottom : null,
      layerCls: layer ? String(layer.className).slice(0, 80) : null,
      // 卡片顶边不低于 caption 底边 = 没有被压住
      cardBelowCaption: cr ? Math.round(pr.top) >= Math.round(cr.bottom) : null,
      // 卡片底边不超过视口底边 = 没被挤出可视区
      cardFitsBottom: Math.round(pr.bottom) <= window.innerHeight + 1,
      panelH: Math.round(pr.height),
    };
  };
  /**
   * 反面对照：把安全区变量按回"修之前"（0）⇒ 卡片必然又跑回 caption 底下。
   * 少了这一条，上面那句 'cardBelowCaption' 在"caption 根本没渲染"时也会恒真。
   */
  H.setWindowSafeTop = (mode) => {
    const root = document.documentElement;
    if (mode === 'off') root.style.setProperty('--gosslan-window-safe-top', '0px');
    else root.style.removeProperty('--gosslan-window-safe-top');
    return getComputedStyle(root).getPropertyValue('--gosslan-window-safe-top').trim();
  };
  /**
   * 把卡片内容撑到超过视口高度 —— 让卡片顶到 max-h 上限。
   *
   * 为什么对照非要这一步：卡片是 'my-auto' 居中的，内容不高时它停在视口中间，
   * "顶边在 caption 之下"**恒真**（撤掉安全区也照样成立）⇒ 那样的对照什么都没证。
   * 撑高之后 'my-auto' 会把卡片顶边推到"它被允许到的最高处"，那才是安全区在管事的位置。
   */
  H.forceModalTall = (on) => {
    const el = document.getElementById('probe-long');
    if (!el) return false;
    el.style.height = on ? '400vh' : '';
    return true;
  };

  /**
   * 弹窗**内部**布局契约的现读（用户 2026-10-12 三条实测：①窗口一缩小"头部就缩上去一些"、
   * ②"中间可滚动区域不该包含下面的操作按钮"、③"左右边距看着左边小右边大"）。
   *
   * 为什么这三条非得现读，源码判据（'designGuards' ㊲）不够：这三条说的是 'flex' 压缩、插槽位置
   * 与"滚动条留白从哪一侧让出"**算出来的结果** —— class 写了不等于布局真按预期发生。
   * ⚠️ 卡片里有**两个** 'overflow-y-auto'（外层那条铺满视口、卡片内那条才真滚内容）⇒
   *   必须按 'min-h-0 flex-1' 精确取内层，取错就量到外层（同款坑本仓记过不止一次）。
   * ⚠️ "被压扁"的判据用 "盒高 < scrollHeight"，不用"高度等于某个猜测像素"：
   *   前者直接复现用户那句"缩上去一截"，后者一改字号/行高就自造假红。
   */
  H.modalLayoutRead = () => {
    const panel = document.querySelector('[role="dialog"] .elevated');
    if (!panel) return { ok: false, why: '没挂出 .elevated 卡片（BaseModal 没渲染？）' };
    // 标题行不靠 class 认（那些 utility 会随主题改）：卡片里只有 ✕ 带 aria-label，
    // 它的最近 div 就是标题行那一格 —— 锚点取自被断言的东西自己，不取自我的记忆。
    const closeBtn = panel.querySelector('button[aria-label]');
    const titleRow = closeBtn ? closeBtn.closest('div') : null;
    const scroller = panel.querySelector('div.min-h-0.flex-1.overflow-y-auto');
    const body = document.getElementById('probe-long');
    const footer = document.getElementById('probe-footer');
    const pr = panel.getBoundingClientRect();
    const tr = titleRow ? titleRow.getBoundingClientRect() : null;
    const sr = scroller ? scroller.getBoundingClientRect() : null;
    const br = body ? body.getBoundingClientRect() : null;
    const fr = footer ? footer.getBoundingClientRect() : null;
    const maxH = getComputedStyle(panel).maxHeight;
    const titleBoxH = tr ? +tr.height.toFixed(1) : -1;
    // 标题行里最高的那个孩子：判"被压扁"要跟**孩子**比，不跟 scrollHeight 比 ——
    // scrollHeight 会把行盒取整也算进去（实测 26.6 vs 28 那种 1.4px 的假红就这么来的）。
    const titleMaxChildH = titleRow
      ? +(Math.max(0, ...Array.from(titleRow.children)
          .map((c) => c.getBoundingClientRect().height))).toFixed(1)
      : -1;
    // 滚动条这次真占了多宽：macOS overlay ⇒ 0；经典滚动条（headless Chrome / Win）是正数。
    const sbW = scroller ? scroller.offsetWidth - scroller.clientWidth : -1;
    const leftInset = br ? +(br.left - pr.left).toFixed(1) : -1;
    const rightInset = br ? +(pr.right - br.right).toFixed(1) : -1;
    return {
      ok: true,
      panelTop: Math.round(pr.top),
      panelBottom: Math.round(pr.bottom),
      panelH: Math.round(pr.height),
      maxH,
      vh: window.innerHeight,
      sbW,
      titleBoxH,
      titleMaxChildH,
      // 盒子比自己的孩子还矮 = 真被 flex 压扁（用户那句"缩上去一些"的几何形状）
      titleSquashed: tr && titleRow ? titleBoxH < titleMaxChildH - 0.5 : null,
      titleInside: tr ? tr.top >= pr.top - 1 && tr.bottom <= pr.bottom + 1 : null,
      titleInScroller: scroller && titleRow ? scroller.contains(titleRow) : null,
      scrollerFound: !!scroller,
      // 溢出必须是真的：内容不溢出时"操作条不跟着滚"这条判据就是空转
      scrollerOverflows: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : null,
      footerFound: !!footer,
      footerInScroller: scroller && footer ? scroller.contains(footer) : null,
      footerInsidePanel: fr ? fr.top >= pr.top - 1 && fr.bottom <= pr.bottom + 1 : null,
      footerBottom: fr ? Math.round(fr.bottom) : -1,
      leftInset,
      rightInset,
      // 扣掉滚动条占的宽度才是"净留白" —— 判左右对称只能拿它比，见下面那条判据的口径边界
      netRightInset: +(rightInset - sbW).toFixed(1),
      srH: sr ? Math.round(sr.height) : -1,
    };
  };
  /**
   * 反面对照：**在浏览器里就地撤掉某一项修复**，读数必须朝推导出的方向变。
   *
   * 为什么要有这一步（而不是只让上面那几条绿着就算过）：那几条钉的是"class 写对之后的结果"，
   * 但一条永远绿的判据和一条空转的判据看起来一模一样。这里用的是本文件自己的老套路
   * （见 setWindowSafeTop）：不改源码、只改这一档的样式，量完立刻还原 ——
   * 撤掉负右外边距 ⇒ 净留白必然多出约一个 gutter；放开标题行的 shrink-0 ⇒ 它必然被压扁。
   * 撤了却读不出变化 = 那条判据什么都没证。
   */
  H.modalLayoutFlip = (which) => {
    const panel = document.querySelector('[role="dialog"] .elevated');
    if (!panel) return { ok: false, why: '没挂出 .elevated 卡片' };
    const scroller = panel.querySelector('div.min-h-0.flex-1.overflow-y-auto');
    const closeBtn = panel.querySelector('button[aria-label]');
    const titleRow = closeBtn ? closeBtn.closest('div') : null;
    if (which === 'gutter-off') {
      if (!scroller) return { ok: false, why: '没找到滚动区' };
      scroller.style.marginRight = '0px'; // 撤掉 -mr-[var(--gosslan-scroll-gutter)]
    } else if (which === 'gutter-on') {
      if (scroller) scroller.style.marginRight = '';
    } else if (which === 'title-off') {
      if (!titleRow) return { ok: false, why: '没找到标题行' };
      titleRow.style.flexShrink = '1'; // 撤掉 shrink-0
      titleRow.style.minHeight = '0';
    } else if (which === 'title-on') {
      if (titleRow) { titleRow.style.flexShrink = ''; titleRow.style.minHeight = ''; }
    } else {
      return { ok: false, why: '未知的对照档: ' + which };
    }
    return { ok: true };
  };


  /**
   * 量那颗"添加表情回复"入口（用户 2026-09-30：「按钮位置在视觉观感上应该与聊天内容最下边对齐，
   * 按钮再紧凑一些，现在有点大」）。
   * 列（=按钮的定位父元素，也就是气泡那一列）不从外面找：按钮就挂在那一列的直接子级上，
   * 它的 parentElement 就是那一列 —— 少一个选择器就少一处会漂的锚。
   */
  H.reactionBtn = () => {
    const btn = document.querySelector('[data-reaction-entry]');
    if (!btn) return { ok: false, why: '没找到那颗入口（canReact 没给？还是这一条根本没挂出来）' };
    const cs = getComputedStyle(btn);
    const b = btn.getBoundingClientRect();
    const col = btn.parentElement;
    const cr = col ? col.getBoundingClientRect() : null;
    return {
      ok: true,
      display: cs.display,
      // N19：揭示改走 opacity 之后，"看得见"与"Tab 得到"是两件事，必须都读
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      focused: document.activeElement === btn,
      w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom),
      colBottom: cr ? Math.round(cr.bottom) : null,
      colClass: col ? String(col.className).slice(0, 46) : null,
      title: btn.getAttribute('title'),
      aria: btn.getAttribute('aria-label'),
      // classList 而不是正则啃 className：这段在模板字符串里，反斜杠会被模板吃掉一层
      // （实测写 \s 到了页面里就变成 s ⇒ 那条 tap-safe 判据永远假红）
      tapSafe: btn.classList.contains('tap-safe'),
    };
  };
  /**
   * 把那颗入口的 transition 关掉（本段读数期间）。
   *
   * ⚠️ 为什么必须有这一步：.kb-reveal 的显形是**带 transition 的**，而 headless 那台在没有
   * 合成帧时动画时钟不推进 ⇒ getComputedStyle 读到的 opacity 会**停在动画起点 0**
   * （实测：--only=reaction 单独跑读到 0.9987，全量跑读到 0，而 pointer-events 已经是 auto
   * —— 因为 pointer-events 不参与过渡，它是瞬时的）。这个差不是产品差异，是"动画没走完"。
   * 这一格要判的是**级联规则有没有落到这个元素上**（悬停 ⇒ opacity 1），不是动画本身
   *（动画与 reduced-motion 那一档由 overlay 段的 E 组判据守）。所以读数前冻掉动画。
   */
  H.freezeReactionTransition = () => {
    const btn = document.querySelector('[data-reaction-entry]');
    if (!btn) return false;
    btn.style.transition = "none";
    return true;
  };

  /** 悬停目标：指针要移到入口**那一列**上（N19 之前它不悬停就 display:none、量不到矩形；   * 现在它常驻布局，但"揭示"这件事仍只由那一列的 hover 决定，所以移指针的目标没变）。 */
  H.colRect = () => {
    const btn = document.querySelector('[data-reaction-entry]');
    const col = btn ? btn.parentElement : null;
    if (!col) return null;
    const r = col.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) };
  };

  /**
   * 图片盒的几何（roadmap N22 骨架占位策略）。
   *
   * ⚠️ 两个常量都是**现读模块**（页面里 import previewMetrics 取）而不是探针里写死 288/128：
   * 写死就变成"探针自己钉了一个数"，而这一格要判的是「渲染出来的矩形 == 估算端用的那个数」。
   * import 到的与组件用的是同一个模块实例（install 那段已验证这条通道）。
   */
  H.imgBox = async () => {
    const root = document.querySelector('[data-img-state]');
    const sk = document.querySelector('[data-img-skeleton]');
    const el = document.querySelector('[data-img-el]');
    if (!root || !el) return { ok: false, why: '缺 data-img-state 或 data-img-el（钩子被改名了？）' };
    const M = await import('/src/utils/previewMetrics.ts');
    const cs = getComputedStyle(el);
    const r = sk ? sk.getBoundingClientRect() : null;
    return {
      ok: true,
      state: root.getAttribute('data-img-state'),
      hasSkeleton: !!sk,
      h: r ? Math.round(r.height) : null,
      w: r ? Math.round(r.width) : null,
      imgDisplay: cs.display,
      // max-height 是内联样式绑上去的常量；<img> 隐藏时矩形量不到，只能读计算值
      imgMax: Math.round(parseFloat(cs.maxHeight) || 0),
      cap: M.IMAGE_BUBBLE_HEIGHT,
      placeholder: M.IMAGE_PLACEHOLDER_HEIGHT,
    };
  };
  /** 单点变异：把骨架高度按回旧的字面量写法（128）⇒ 那条"预留 == 估算"的判据必须当场不成立。 */
  H.forceSkeletonLegacyHeight = async (on) => {
    const sk = document.querySelector('[data-img-skeleton]');
    if (!sk) return false;
    const M = await import('/src/utils/previewMetrics.ts');
    sk.style.height = String((on ? 128 : M.IMAGE_BUBBLE_HEIGHT)) + 'px';
    return true;
  };

  /** 对照：把入口按回"旧的中线居中"（top-1/2 + translateY(-50%)）⇒ 底边对齐差必须变大。 */
  H.forceLegacyReaction = (on) => {
    const btn = document.querySelector('[data-reaction-entry]');
    if (!btn) return false;
    if (on) {
      btn.style.top = '50%';
      btn.style.bottom = 'auto';
      btn.style.transform = 'translateY(-50%)';
    } else {
      btn.style.top = '';
      btn.style.bottom = '';
      btn.style.transform = '';
    }
    return true;
  };

  /**
   * 量**表情回应条**与气泡那一列的几何关系（用户 2026-10-07：「左右两条表情回复边缘都与上面气泡对齐，
   * 并且间距紧凑点」）。两侧各量一次：左列看左边缘、右列看右边缘，容差 1px。
   *
   * ⚠️ 量的是**胶囊自己的边**，不是那条容器的边：回应条是通栏的块级容器，padding 长在盒子**里面**
   * ⇒ 拿 getBoundingClientRect() 量那条容器去比气泡，两侧都会恒差一个"条的宽度差"（第一版就这么读出
   * 左右各 60px，差点照着这个假数去改补偿值）。用户那句"边缘对齐"判的是看得到的那两枚胶囊。
   * 裁切者不写死选择器：从条往上找第一个 overflow 不是 visible 的祖先（消息列表那个滚动容器），
   * 因为"谁在裁"这件事本身就是这条判据要回答的一半。
   */
  H.reactionGeom = () => {
    const bar = document.querySelector('[data-reaction-bar]');
    const col = document.querySelector('[data-msg-col]');
    if (!bar || !col) return { ok: false, why: '缺 data-reaction-bar 或 data-msg-col（钩子被改名了？）' };
    const chips = Array.from(bar.querySelectorAll('[data-reaction-chip]'));
    if (chips.length === 0) return { ok: false, why: '条里一颗胶囊都没有 ⇒ 没有可量的边' };
    const rs = chips.map((b) => b.getBoundingClientRect());
    const chipLeft = Math.min(...rs.map((r) => r.left));
    const chipRight = Math.max(...rs.map((r) => r.right));
    const chipTop = Math.min(...rs.map((r) => r.top));
    const b = { left: chipLeft, right: chipRight, top: chipTop };
    const c = col.getBoundingClientRect();
    let clip = null;
    for (let n = bar.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { clip = n; break; }
    }
    const cr = clip ? clip.getBoundingClientRect() : null;
    return {
      ok: true,
      deltaLeft: Math.round(b.left - c.left),
      deltaRight: Math.round(b.right - c.right),
      gapToBubble: Math.round(b.top - c.bottom),
      chipLeft: Math.round(b.left), chipRight: Math.round(b.right),
      colLeft: Math.round(c.left), colRight: Math.round(c.right),
      padLeft: getComputedStyle(bar).paddingLeft, padRight: getComputedStyle(bar).paddingRight,
      // 那截竖向间距的构成也要带回来：条自己的 mt 之外，剩下的是**上面那一行**（消息行 = 前一个兄弟节点）
      // 的下内边距 —— 不知道 6px 从哪来就没法判断"再收紧"该动哪一层（动错层会碰到选中底色）。
      barMarginTop: getComputedStyle(bar).marginTop,
      rowPadBottom: bar.previousElementSibling
        ? getComputedStyle(bar.previousElementSibling).paddingBottom : null,
      barClass: String(bar.className).slice(0, 120),
      clipTag: clip ? String(clip.className).slice(0, 36) : 'none',
      clipLeft: cr ? Math.round(cr.left) : null,
      clipRight: cr ? Math.round(cr.right) : null,
      vw: window.innerWidth,
    };
  };

  /** 那颗胶囊的中心点（给 CDP 移指针用）；名单要靠真 hover 才出现，直接改状态就判不到 canHover 那一支。 */
  H.reactionChipPoint = (i) => {
    const all = document.querySelectorAll('[data-reaction-chip]');
    const b = all.length ? all[Math.min(all.length - 1, Math.max(0, i | 0))] : null;
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: all.length };
  };

  H.allChipPoints = () => Array.from(document.querySelectorAll('[data-reaction-chip]')).map((el, i) => {
    const r = el.getBoundingClientRect();
    return { i, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      left: Math.round(r.left), right: Math.round(r.right) };
  });

  /**
   * 通用「浮层会不会被裁」量具 —— 量的是整类缺陷的共同不变量（表情名单、已读列表、
   * 表情选择器是同一个坑的三次现场：absolute 浮层挂在带 overflow 的滚动容器里就一定被切）。
   *
   * 按 CSS 实际语义合成**一条**判据，不钉三条其中两条只是另一条的推论：
   *  1) position:fixed 的包含块是视口 ⇒ 中间祖先的 overflow 裁不到它，body/html 的
   *     overflow 也裁不到它（实测这个夹具页 body 就是 hidden/hidden ⇒ 把 body 算进链
   *     就永远是假红）。真能裁到它的只有「祖先变成了包含块」⇒ transform/filter/
   *     perspective/will-change/contain:paint 这一类连 body/html 一起查，记进 breakers。
   *  2) 非 fixed ⇒ 往上（含 body/html）任何 overflow 不是 visible 的祖先都切它，记进 clipped。
   * 两者都空 = escapes（没有任何东西裁得到它）。
   */
  H.floatLayer = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, why: 'not-mounted' };
    const AXES = ['transform', 'filter', 'perspective'];
    const isBreaker = (st) => (st.transform !== 'none' || st.filter !== 'none'
      || st.perspective !== 'none' || AXES.some((k) => st.willChange.indexOf(k) >= 0)
      || st.contain.indexOf('paint') >= 0);
    const isClipper = (st) => (st.overflowX !== 'visible' || st.overflowY !== 'visible');
    const name = (x) => (x === document.body ? 'body'
      : x === document.documentElement ? 'html' : String(x.className || x.tagName).slice(0, 40));
    // Reka 的 Portal 会在内容外面套一层 [data-reka-popper-content-wrapper]：
    // 它是库自己的 fixed 定位层（内含 floating-ui 的 transform），挂在 body 下。
    // 判"逃出裁切容器"时必须从**这一层之上**开始查祖先；把包装层自己的 transform
    // 当成应用容器会把干净的浮层误判成被裁（position 也要读包装层的，才有意义）。
    let popperWrapper = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.hasAttribute('data-reka-popper-content-wrapper')) popperWrapper = n;
    }
    const position = getComputedStyle(popperWrapper ?? el).position;
    const anc = [];
    for (let n = popperWrapper ? popperWrapper.parentElement : el.parentElement; n; n = n.parentElement) anc.push(n);
    const breakers = [];
    const clipped = [];
    anc.forEach((n) => {
      const st = getComputedStyle(n);
      if (isBreaker(st)) breakers.push(name(n));
      if (position !== 'fixed' && isClipper(st)) clipped.push(name(n) + ':' + st.overflowY);
    });
    const b = el.getBoundingClientRect();
    const chain = [];
    for (let n = el; n; n = n.parentElement) {
      chain.push(name(n));
      if (n === document.body) break;
    }
    return {
      ok: true,
      position: position,
      parentIsBody: (popperWrapper ? popperWrapper.parentElement : el.parentElement) === document.body,
      portaled: !!popperWrapper,
      clipped: clipped,
      breakers: breakers,
      escapes: clipped.length === 0 && breakers.length === 0,
      inViewport: b.left >= -1 && b.right <= window.innerWidth + 1
        && b.top >= -1 && b.bottom <= window.innerHeight + 1,
      rect: { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), bo: Math.round(b.bottom) },
      vw: window.innerWidth,
      vh: window.innerHeight,
      chain: chain,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    };
  };

  /** 名单里每一行：长名字必须**真的被省略**（截断 + 有 title 拿到全名），不能撑破面板。 */
  H.reactionRows = () => {
    const r = document.querySelector('[data-reaction-roster]');
    if (!r) return { ok: false };
    const rows = Array.from(r.querySelectorAll('[data-roster-row]'));
    return {
      ok: true,
      panelW: Math.round(r.getBoundingClientRect().width),
      rows: rows.map((el) => ({
        clipped: el.scrollWidth > el.clientWidth + 1,
        ellipsis: getComputedStyle(el).textOverflow === 'ellipsis',
        hasTitle: !!el.getAttribute('title'),
        text: String(el.textContent || '').trim().slice(0, 18),
      })),
    };
  };

  /**
   * 量 hover 展开的「谁点的」名单浮层（用户 2026-10-07：「右边聊天 hover 表情 人员列表 展开遮挡」）。
   * 两问分开答：① 有没有被滚动容器/视口**裁掉**（右缘越界）；② 露出来的那部分**是不是它自己**
   * （elementFromPoint 命中的必须落在名单里 —— 被别的元素盖住时命中的会是别人）。
   */
  H.reactionRoster = () => {
    const r = document.querySelector('[data-reaction-roster]');
    if (!r) {
      // 别只回一句"没弹出来"：这一条在门禁里红过而单独跑是绿的，成因有三种形状
      // （canHover 判假 / 根本没找到胶囊 / 指针没落上去）—— 三种的修法完全不同，一次把三样都带回来。
      const chip = document.querySelector('[data-reaction-chip]');
      const cr0 = chip ? chip.getBoundingClientRect() : null;
      return {
        ok: false,
        why: '名单没弹出来',
        diag: {
          hoverMedia: window.matchMedia('(hover: hover)').matches,
          // 组件里那份 canHover 是**模块加载时**算的，与此刻的 matchMedia 可以不同；
          // 而 hover 通路只绑在它上面 ⇒ 两者不一致就是"事件到了、面板不弹"的那种形状
          hoverCapable: chip ? chip.getAttribute('data-hover-capable') : null,
          chipDisabled: chip ? String(chip.disabled) : null,
          // 组件内部状态标在条上：分清「事件没触发处理器」与「处理器跑了但没渲染」
          openEmoji: (document.querySelector('[data-reaction-bar]') || { getAttribute: () => null })
            .getAttribute('data-open-emoji'),
          chips: document.querySelectorAll('[data-reaction-chip]').length,
          chipRect: cr0
            ? { x: Math.round(cr0.x), y: Math.round(cr0.y), w: Math.round(cr0.width), h: Math.round(cr0.height) }
            : null,
          inViewport: cr0 ? cr0.y >= 0 && cr0.y < window.innerHeight : null,
          // 指针该落在胶囊中心 —— 那里此刻压着谁，直接分开"根本没落上去"与"落上了但被别人抢走"。
          ownerAtChip: (() => {
            if (!cr0) return 'no-chip';
            const el = document.elementFromPoint(
              Math.round(cr0.x + cr0.width / 2), Math.round(cr0.y + cr0.height / 2));
            return el ? el.tagName + '.' + String(el.className || '').slice(0, 40) : 'null';
          })(),
          vw: window.innerWidth, vh: window.innerHeight,
        },
      };
    }
    const b = r.getBoundingClientRect();
    let clip = null;
    for (let n = r.parentElement; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') { clip = n; break; }
    }
    const cr = clip ? clip.getBoundingClientRect() : null;
    const vw = window.innerWidth;
    const overRight = cr ? Math.round(b.right - cr.right) : Math.round(b.right - vw);
    const overLeft = cr ? Math.round(cr.left - b.left) : Math.round(0 - b.left);
    const probeX = Math.round(b.left + b.width / 2);
    const probeY = Math.round(b.top + b.height / 2);
    const hit = document.elementFromPoint(probeX, probeY);
    return {
      ok: true,
      left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
      clipTag: clip ? String(clip.className).slice(0, 36) : 'viewport',
      clipLeft: cr ? Math.round(cr.left) : 0,
      clipRight: cr ? Math.round(cr.right) : vw,
      overRight,
      overLeft,
      hitSelf: !!hit && (hit === r || r.contains(hit)),
      hitTag: hit ? hit.tagName + '.' + String(hit.className).slice(0, 30) : 'null',
      vw,
    };
  };

  /**
   * 反面对照（对齐）：把回应条朝外侧**平移 8px** —— 8px 正是修之前那个补偿值差出来的量
   * （旧写法 4 + 48 = 52，而气泡边缘在 16 + 36 + 8 = 60）。用 margin 而不是改 padding：
   * padding 上有 px-4 与 pl-* 互相覆盖的顺序问题，拿它做对照会把"对照生效了吗"变成另一个未知。
   */
  H.forceAlignSkew = (on) => {
    const bar = document.querySelector('[data-reaction-bar]');
    const col = document.querySelector('[data-msg-col]');
    if (!bar || !col) return false;
    if (on) {
      if (col.classList.contains('items-end')) bar.style.marginRight = '8px';
      else bar.style.marginLeft = '-8px';
    } else {
      bar.style.marginLeft = '';
      bar.style.marginRight = '';
    }
    return true;
  };

  /** 反面对照（名单）：把 fixed 锚点强推到视口右缘外 ⇒ 右溢必须重新出现（证明判据不空转）。 */
  /**
   * 判据的反面对照：把名单**搬回**消息那一侧第一个带 overflow 的祖先里
   * （= 修之前它待的地方）。搬完 floatLayer 必须报出裁切祖先 / 不再挂 body,
   * 否则那条 escape 判据就是恒真。搬回去时按原位置插回，不动 Vue 的记账。
   */
  /**
   * escape 判据的反面对照：把名单搬回「absolute 挂在裁切容器里」= 修之前它的形状。
   * 真实应用里切它的是消息列表那个 overflow 滚动容器，这个夹具页里那一层不存在
   * （名单到 body 之间是空的 ⇒ 上一版对照因此根本搬不动、白报红），所以这里给气泡
   * 那一列补上 overflow 再把名单塞进去。撤的时候按原位置插回、inline 样式逐样还原。
   */
  H.reparentRoster = (on) => {
    const r = document.querySelector('[data-reaction-roster]');
    if (!r) return { ok: false, why: 'no-roster' };
    if (on) {
      const bar = document.querySelector('[data-reaction-bar]');
      const cell = bar ? bar.parentElement : null;
      if (!cell) return { ok: false, why: 'no-column' };
      window.__rosterHome = {
        parent: r.parentElement, next: r.nextSibling,
        cell: cell, cellOverflow: cell.style.overflow, pos: r.style.position,
      };
      cell.style.overflow = 'hidden';
      r.style.position = 'absolute';
      cell.appendChild(r);
      return { ok: true, into: String(cell.className || cell.tagName).slice(0, 40) };
    }
    const h = window.__rosterHome;
    if (!h || !h.parent) return { ok: false, why: 'no-home-recorded' };
    h.parent.insertBefore(r, h.next);
    h.cell.style.overflow = h.cellOverflow || '';
    r.style.position = h.pos || '';
    delete window.__rosterHome;
    return { ok: true };
  };

  H.forceLegacyRoster = (on) => {
    const r = document.querySelector('[data-reaction-roster]');
    if (!r) return false;
    // Reka 把真正定位的 fixed 层放在 [data-reka-popper-content-wrapper] 上；
    // 推坐标必须推那一层，推内容元素只会改它在包装层里的局部位置。
    const box = r.closest('[data-reka-popper-content-wrapper]') || r;
    if (on) {
      box._origPos = { left: box.style.left, right: box.style.right, transform: box.style.transform };
      // 往左长那一支发的是 CSS right ⇒ 不一起清掉，left/right 双锚会把盒子拉成
      // "按可用宽度撑开"，测出来的就不是"越界"而是"被压窄"了。
      box.style.right = 'auto';
      box.style.left = (window.innerWidth - 20) + 'px';
      box.style.transform = 'none';
    } else {
      box.style.left = box._origPos?.left ?? '';
      box.style.right = box._origPos?.right ?? '';
      box.style.transform = box._origPos?.transform ?? '';
      delete box._origPos;
    }
    return true;
  };

  /** 事件探针：hover 到底有没有落到那颗胶囊上（"名单没弹"有三种成因，只有监听能分开）。 */
  H.watchChip = () => {
    const chip = document.querySelector('[data-reaction-chip]');
    if (!chip) return false;
    window.__chipLog = [];
    window.__docLog = [];
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'mouseleave'].forEach((t) => {
      chip.addEventListener(t, () => { window.__chipLog.push('chip:' + t); });
    });
    // document 捕获层：分清"事件根本没发"、"发到了别的元素"、"发到了胶囊但我的监听挂在被
    // Vue 换掉的旧节点上"这三种 —— 三者的修法完全不同，只回一句"没弹出来"就分不开。
    ['pointerover', 'mouseover', 'mousemove'].forEach((t) => {
      document.addEventListener(t, (e) => {
        const el = e.target;
        window.__docLog.push(t + ':' + el.tagName + '.' + String(el.className || '').slice(0, 18));
      }, true);
    });
    return true;
  };
  H.chipLog = () => (window.__chipLog || []).join(' | ') + ' ## doc: ' + (window.__docLog || []).slice(0, 8).join(' | ');
  /** 指针此刻真正压在谁身上（CDP 说"我移过去了"不等于浏览器认为指针在那儿）。 */
  H.pointOwner = (x, y) => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y));
    if (!el) return 'null';
    const chip = document.querySelector('[data-reaction-chip]');
    return (chip && (el === chip || chip.contains(el)) ? 'chip:' : '')
      + el.tagName + '.' + String(el.className).slice(0, 28);
  };

  /** 给挂出来的那条消息换一个人：mine 是由 app.device.device_id 现推的，不种身份就永远量不到右列。 */
  H.seedDevice = async (id) => {
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!piniaUrl || !window.__pinia) return { ok: false, why: '没等到 pinia 资源或 __pinia 不在（先跑 install）' };
    const P = await import(piniaUrl);
    const A = await import('/src/stores/useAppStore.ts');
    P.setActivePinia(window.__pinia);
    const s = A.useAppStore();
    s.device = { device_id: id, nickname: '探针我', avatar: null };
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true, at: s.device && s.device.device_id };
  };

  /** 替掉一条 api 命令。api 是普通对象 ⇒ 按名字替换，比伪造整个 __TAURI__ 便宜得多。
   *  同时**从这里开始数这条命令被调了几次**（H.apiCalls）：「轮询关掉的这段时间里，
   *  除了我点的那一下，没有任何东西会去拉数据」这种断言，只能靠调用次数读，不能靠内容读。 */
  H.stubApi = async (name, payload) => {
    const m = await import('/src/api/index.ts');
    if (!m.api || typeof m.api[name] !== 'function') {
      throw new Error('api.' + name + ' 不存在 —— 命令改名的话这条夹具要同步');
    }
    window.__probeCalls = window.__probeCalls || {};
    window.__probeCalls[name] = 0;
    m.api[name] = async () => {
      window.__probeCalls[name] += 1;
      return payload;
    };
    return true;
  };
  /** 读某条 api 自上次 stub 起被调用的次数。 */
  H.apiCalls = async (name) => (window.__probeCalls && window.__probeCalls[name]) || 0;

  /**
   * 外部链接的读写命令 + 一份内存表（--only=links 的**写路径**）。
   * 增/改/删都返回**整份数组**（与 Rust 那侧同形）⇒ 才量得到"写成功把返回值写回读缓存"
   * 与"没有再拉一次 list"；线上导入返回合并结果。每条命令各计一次调用数。
   */
  H.linksStore = async (initial) => {
    const m = await import('/src/api/index.ts');
    const rows = initial.map((x) => ({ id: x.id, name: x.name, url: x.url }));
    window.__links = {
      rows: rows,
      calls: { list: 0, add: 0, update: 0, remove: 0, importUrl: 0, export: 0 },
      seq: 0, last: null, fail: null,
    };
    const snap = () => rows.map((x) => ({ id: x.id, name: x.name, url: x.url }));
    const trip = (kind) => {
      if (window.__links.fail !== kind) return;
      window.__links.fail = null;
      throw new Error('ipc boom: ' + kind);
    };
    m.api.listExternalLinks = async () => { window.__links.calls.list += 1; return snap(); };
    m.api.addExternalLink = async (name, url) => {
      window.__links.calls.add += 1;
      trip('add');
      window.__links.seq += 1;
      rows.push({ id: 'n' + window.__links.seq, name: name, url: url });
      window.__links.last = { kind: 'add', name: name, url: url };
      return snap();
    };
    m.api.updateExternalLink = async (id, name, url) => {
      window.__links.calls.update += 1;
      trip('update');
      const row = rows.find((r) => r.id === id);
      if (row) { row.name = name; row.url = url; }
      window.__links.last = { kind: 'update', id: id, name: name, url: url };
      return snap();
    };
    m.api.removeExternalLink = async (id) => {
      window.__links.calls.remove += 1;
      trip('remove');
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      window.__links.last = { kind: 'remove', id: id };
      return snap();
    };
    // 线上导入：返回合并结果（links 是导入后的完整列表），并让列表多一行可核对。
    m.api.importExternalLinksFromUrl = async (url) => {
      window.__links.calls.importUrl += 1;
      window.__links.seq += 1;
      rows.push({ id: 'n' + window.__links.seq, name: '导入的链接', url: 'https://imported.example.com' });
      window.__links.last = { kind: 'importUrl', url: url };
      return { links: snap(), added: 1, skipped: 0, invalid: 0 };
    };
    m.api.importExternalLinksFile = async () => ({ links: snap(), added: 0, skipped: 0, invalid: 0 });
    m.api.importPickedFile = async (path) => path;
    m.api.exportExternalLinks = async () => {
      window.__links.calls.export += 1;
      return '/tmp/gosslan-links.json';
    };
    m.api.cleanupExternalLinksExport = async () => {};
    return true;
  };
  H.linksStats = () => (window.__links ? JSON.parse(JSON.stringify(window.__links.calls)) : null);
  H.linksLast = () => (window.__links ? JSON.parse(JSON.stringify(window.__links.last)) : null);
  /** 让下一次指定写命令 reject（只生效一次）—— 写失败那条格用它把 toast 逼出来。 */
  H.linksFailNext = (kind) => { if (!window.__links) return false; window.__links.fail = kind; return true; };
  /**
   * 诊断快照的可控夹具（--only=diag）：首次调用挂起（量"加载中"），之后由 diagResolve 决定成功；
   * diagFailWith 置上后每次调用立即 reject（量 retry:1 之后真的进 error）。
   */
  H.diagDeferred = async () => {
    const m = await import('/src/api/index.ts');
    window.__diag = { calls: 0, failWith: null, pending: null };
    m.api.getDiscoveryDiag = () => {
      window.__diag.calls += 1;
      if (window.__diag.failWith) return Promise.reject(new Error(window.__diag.failWith));
      return new Promise((resolve, reject) => { window.__diag.pending = { resolve: resolve, reject: reject }; });
    };
    return true;
  };
  H.diagResolve = (payload) => {
    const p = window.__diag && window.__diag.pending;
    if (!p) return false;
    window.__diag.pending = null;
    p.resolve(payload);
    return true;
  };
  H.diagFailWith = (msg) => { if (!window.__diag) return false; window.__diag.failWith = msg; return true; };
  H.diagStats = () => (window.__diag ? { calls: window.__diag.calls } : null);
  /**
   * 同一页再挂一份 ToastHud（#probe-toast-host）。install 只建一个 #probe-host，
   * 而 ToastHud 只读模块级 toastManager、不碰 pinia ⇒ 第二个 app 用页面那份 vue 就够。
   */
  H.mountToastHud = async () => {
    const Vue = window.__probe.vue;
    if (!Vue) return { ok: false, why: 'no-vue（先跑 install）' };
    const mod = await import('/src/components/ToastHud.vue');
    const host = document.createElement('div');
    host.id = 'probe-toast-host';
    document.body.appendChild(host);
    const app = Vue.createApp({ render: () => Vue.h(mod.default) });
    app.mount(host);
    window.__probe.toastApp = app;
    await Vue.nextTick();
    return { ok: true };
  };
  /** 读 Toast HUD 里**可见**的条目（与 --only=toast 段同一套选择器）。 */
  H.toastRead = () => {
    const nodes = [...document.querySelectorAll('#probe-toast-host li[data-status]')];
    const visible = nodes.filter((n) => n.getClientRects().length > 0);
    return {
      total: nodes.length,
      visible: visible.length,
      texts: visible.map((n) => String(n.textContent || '').trim()),
      statuses: visible.map((n) => n.getAttribute('data-status')),
      alerts: document.querySelectorAll('#probe-toast-host [role="alert"]').length,
    };
  };

  /**
   * 移动端布局链的真出口（--only=layoutstore）。
   * ⚠️ 这条夹具**只许跑真的 store.init()**：modalStack 那类夹具是自己
   * classList.toggle('is-mobile', o.isMobile)，布尔由夹具传入 ⇒ 那条链
   * （窄档查询 → resolveMobileLayout → 写类 → 监听器）从来没被任何运行时判据看到过。
   * 查询串从 /src/utils/platform.ts 现取，所以这里不会长出第二个会漂的 767。
   * init() 不 await：布局那一格排在第一个 await 之前，而后面的 IPC 步骤在浏览器里必然抛。
   */
  H.layoutBoot = async () => {
    const u = performance.getEntriesByType('resource').map((e) => e.name || '')
      .find((x) => x.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!u || !window.__pinia) return { ok: false, why: 'no-pinia（先跑 install）' };
    const P2 = await import(u);
    const A = await import('/src/stores/useAppStore.ts');
    const PL = await import('/src/utils/platform.ts');
    P2.setActivePinia(window.__pinia);
    const s = A.useAppStore();
    window.__layout = { s: s, q: PL.NARROW_LAYOUT_QUERY };
    s.init().catch((e) => { window.__layoutErr = String((e && e.message) || e).slice(0, 60); });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ok: true, q: PL.NARROW_LAYOUT_QUERY };
  };
  /** 三面各自读一遍：查询本身、store 里的值、真正落到 <html> 上的那个类。 */
  H.layoutRead = () => {
    const L = window.__layout;
    if (!L) return { ok: false };
    return {
      ok: true,
      q: L.q,
      vw: window.innerWidth,
      mq: window.matchMedia(L.q).matches,
      store: !!L.s.isMobile,
      cls: document.documentElement.classList.contains('is-mobile'),
      err: window.__layoutErr || '',
    };
  };
  /**
   * 让一条 api **reject**（stubApi 只能给成功值）。
   * 错误文案这条链的失败形状是"屏幕上有得读，但读的是后端原始串或裸 key"⇒
   * 只有真的抛出去，才量得到 errorText 那一层。
   */
  H.stubApiFail = async (name, message) => {
    const m = await import('/src/api/index.ts');
    if (!m.api || typeof m.api[name] !== 'function') {
      throw new Error('api.' + name + ' 不存在 —— 命令改名的话这条夹具要同步');
    }
    m.api[name] = async () => { throw new Error(message); };
    return true;
  };
  /**
   * 群任务看板实时同步夹具（必须在挂看板**之前**装好：看板 setup 就会发首屏读取）。
   * 替掉两条 api：
   *  - getGroupTodoMessages：返回 window.__todoRows 那份"DB 快照"（测试随时可换）；
   *  - onMessageReceived：抓住订阅回调，返回 unlisten（调 watchGroupTodos 的返回值即触发）。
   * 返回总线控制句柄；H.todoEmit / H.todoRows / H.todoStats 给后续步骤用。
   */
  H.todoBus = async () => {
    const m = await import('/src/api/index.ts');
    window.__todoStats = { reads: 0, lastIds: null, unsubscribed: false, subscribed: 0 };
    window.__todoRows = [];
    window.__todoListener = null;
    m.api.getGroupTodoMessages = async (ids) => {
      window.__todoStats.reads += 1;
      window.__todoStats.lastIds = ids;
      // 模拟 IPC 异步：给 microtask 一拍（调用方本就 await）
      return JSON.parse(JSON.stringify(window.__todoRows));
    };
    m.api.onMessageReceived = async (cb) => {
      window.__todoStats.subscribed += 1;
      window.__todoListener = cb;
      return () => {
        window.__todoStats.unsubscribed = true;
        window.__todoListener = null;
      };
    };
    return true;
  };
  /** 换"DB 快照"（模拟对端改动已经落库）。 */
  H.todoRows = (rows) => { window.__todoRows = rows; return rows.length; };
  /** 从后端事件方向推一条/批 message-received（走看板真实订阅）。 */
  H.todoEmit = (recs) => {
    const l = window.__todoListener;
    if (!l) return false;
    for (const r of recs) l(r);
    return true;
  };
  H.todoStats = () => JSON.parse(JSON.stringify(window.__todoStats));
  /** 拿到挂在页面 pinia 上的 chat store（必须在一次 install 之后）。 */
  H.chatStore = async () => {
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!piniaUrl || !window.__pinia) return null;
    const P = await import(piniaUrl);
    P.setActivePinia(window.__pinia);
    const S = await import('/src/stores/useChatStore.ts');
    return S.useChatStore();
  };
  /** 分段控件（Reka RadioGroup）的形状与焦点读数。 */
  H.segmentedInfo = () => {
    const g = document.querySelector('[role="radiogroup"]');
    if (!g) return { present: false };
    const items = Array.from(g.querySelectorAll('[role="radio"]'));
    return {
      present: true,
      label: g.getAttribute('aria-label'),
      groupTab: g.tabIndex,
      items: items.map((el) => ({
        text: String(el.textContent || '').trim(),
        checked: el.getAttribute('aria-checked'),
        tab: el.tabIndex,
      })),
      active: String(document.activeElement && document.activeElement.textContent || '').trim(),
    };
  };
  H.groupFocus = () => {
    const g = document.querySelector('[role="radiogroup"]');
    if (!g) return false;
    g.focus();
    return true;
  };
  H.radioFocus = (i) => {
    const el = document.querySelectorAll('[role="radio"]')[i];
    if (!el) return false;
    el.focus();
    return true;
  };
  H.radioPoint = (i) => {
    const el = document.querySelectorAll('[role="radio"]')[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  /** 字号滑块（Reka Slider）的形状/值与 store 读数。 */
  H.sliderInfo = () => {
    const t = document.querySelector('[role="slider"]');
    if (!t) return { present: false };
    const r = t.getBoundingClientRect();
    const root = t.parentElement ? t.parentElement.getBoundingClientRect() : null;
    const style = window.__pinia && window.__pinia.state && window.__pinia.state.value.app
      ? window.__pinia.state.value.app.chatStyle : null;
    return {
      present: true,
      now: t.getAttribute('aria-valuenow'),
      min: t.getAttribute('aria-valuemin'),
      max: t.getAttribute('aria-valuemax'),
      text: t.getAttribute('aria-valuetext'),
      focused: document.activeElement === t,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      root: root ? { x: Math.round(root.x), y: Math.round(root.y), w: Math.round(root.width), h: Math.round(root.height) } : null,
      font: style ? style.fontSize : null,
    };
  };
  H.sliderFocus = () => {
    const t = document.querySelector('[role="slider"]');
    if (!t) return false;
    t.focus();
    return true;
  };
  /**
   * 把夹具里的名字真的种进 store 的名字表。
   *
   * 回应名单上显示的名字来自 nicknameOf（friends / peers / 快照三张表），**不认裸 id**：
   * 查不到会落成「未知成员 + 后四位」。把长昵称直接当 actor id 传进来，那条「长名字必须
   * 顶到 max-width 并被省略号截断」量到的其实是一段短兜底文案 —— 探针自己失真，不是界面错。
   * 种成 peer 之后，nameOf(id) 与断言里的 LONG 才是同一个被测对象。
   */
  H.seedMembers = async (list) => {
    const chat = await H.chatStore();
    if (!chat) return { ok: false, why: 'chat store 不在（先跑一次 install）' };
    const have = new Set(chat.peers.map((p) => p.device_id));
    chat.peers = [...chat.peers, ...list
      .filter((m) => !have.has(m.device_id))
      .map((m) => ({ device_id: m.device_id, nickname: m.nickname }))];
    await new Promise((r) => setTimeout(r, 80));
    return { ok: true, names: list.map((m) => chat.nicknameOf(m.device_id)) };
  };
  /** 往搜索框里打字：走 v-model 需要 input 事件，不能直接改 .value 就完事。 */
  H.typeKeyword = async (text) => {
    const input = document.querySelector('input[type="search"], input[role="searchbox"], input');
    if (!input) throw new Error('找不到搜索输入框');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900)); // 组件里是 150ms 防抖 + 一次请求
    return { focused: document.activeElement === input, hits: document.querySelectorAll('[data-hit]').length };
  };
  /**
   * 读统一预览 store 的当下状态。要点：**先 setActivePinia 到页面里那一份**，
   * 自己 import('pinia') 会得到第二个实例 ⇒ 读到的永远是空 store，
   * 看起来像"预览没开"（假红）。
   */
  H.previewState = async () => {
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!piniaUrl) throw new Error('页面里没有 pinia 资源 —— 挂载那一步没成功');
    const P = await import(piniaUrl);
    P.setActivePinia(window.__pinia);
    const m = await import('/src/stores/useImagePreview.ts');
    const st = m.useImagePreviewStore();
    return { open: st.open, source: st.source, index: st.index, n: (st.images || []).length };
  };
  H.text = () => document.body.innerText || '';
  H.el = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    // title / text 是 2026-09-30 那轮加的（编号那一格要同时量"可见的后四位"和"title/aria 里的全码"）：
    // 只加不减 ⇒ 现有消费者（读 tabindex / aria / 宽高）行为一字不变。
    return { role: e.getAttribute('role'), tabindex: e.getAttribute('tabindex'),
      aria: e.getAttribute('aria-label'), title: e.getAttribute('title'),
      text: (e.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) };
  };
  H.focusThumb = () => {
    // 优先任务卡缩略图（80×80 那块）：任务卡主体也是 role=button 且在 DOM 里更早，
    // 取第一个会聚焦到卡片主体而不是图片。没有缩略图的场景再退回第一个 role=button。
    const t = document.querySelector('.h-20[role="button"]') || document.querySelector('[role="button"]');
    if (!t) return false;
    t.focus();
    return document.activeElement === t;
  };
  H.setOpen = async (v) => {
    window.__st.open = v;
    const t = window.__probe.vue;
    await t.nextTick(); await t.nextTick();
  };
  /** 群文件面板：换群（Query key 跟着变）。 */
  H.setGroup = async (v) => {
    window.__st.groupId = v;
    const t = window.__probe.vue;
    await t.nextTick(); await t.nextTick();
  };
  /**
   * 共享目录夹具（必须在挂面板之前装）：请求按好友挂起，由 resolveShare 决定何时返回，
   * 用来照「A 的慢响应在切到 B 之后才到」这一拍。下载记录 (friendId, path) 供归属判据。
   */
  H.shareBus = async () => {
    const m = await import('/src/api/index.ts');
    window.__share = { calls: [], downloads: [], pending: {} };
    m.api.requestShareTree = (fid) => {
      window.__share.calls.push(fid);
      return new Promise((resolve) => { window.__share.pending[fid] = resolve; });
    };
    m.api.downloadSharedFile = async (fid, path) => {
      window.__share.downloads.push([fid, path]);
      return '';
    };
    return true;
  };
  H.resolveShare = (fid, names) => {
    const r = window.__share.pending[fid];
    if (!r) return false;
    delete window.__share.pending[fid];
    r(names.map((name) => ({ name, path: fid + '/' + name, is_dir: false, size: 10 })));
    return true;
  };
  /** 切当前会话（共享目录按好友分键的驱动）。 */
  H.setConv = async (id) => {
    const chat = await H.chatStore();
    if (!chat) return false;
    chat.activeConv = id;
    const t = window.__probe.vue;
    await t.nextTick(); await t.nextTick();
    return true;
  };
  /**
   * 群文件夹具（必须在挂面板之前装）：
   * listGroupFiles 记录每次请求的群 id、可切换成失败；
   * onGroupFileActivity 抓住订阅回调，并记录订阅/退订次数（关面板要摘干净）。
   */
  H.groupFilesBus = async () => {
    const m = await import('/src/api/index.ts');
    window.__gf = { calls: [], fail: false, subs: 0, unsub: 0, emit: null };
    m.api.listGroupFiles = async (gid) => {
      window.__gf.calls.push(gid);
      if (window.__gf.fail) throw new Error('ipc down');
      return [{
        transfer_id: gid + '-1',
        name: gid + '.bin',
        size: 1024,
        sender_id: 'peer-1',
        created_at: 0,
        local_state: 'local',
        local_path: '/tmp/' + gid + '.bin',
        delivered: 1,
        total: 1,
      }];
    };
    m.api.onGroupFileActivity = async (cb) => {
      window.__gf.subs += 1;
      window.__gf.emit = cb;
      return () => { window.__gf.unsub += 1; };
    };
    return true;
  };
  /**
   * 会话行这一刻「读屏得到的名字」与两枚徽标（#88 / #117 剩下的那一半）。
   *
   * 两条要点：
   *  · **先 setActivePinia 到页面里那一份**再去改 store —— 自己 import 一份 pinia 会得到
   *    第二个实例，改的是一份没人看的空 store（报出来的错长得像「徽标不亮」）。
   *  · 期望文案**由页面用应用同一份 i18n 现算**。这条判的不是「文案对不对」，
   *    而是「这三句在不在这一行的 accessible name 里」—— role=button 一旦带 aria-label，
   *    后代全被折叠掉，不在名字里就等于读屏用户得不到（2026-09-26 用系统控件树实测到的）。
   */
  H.convRow = async (arg) => {
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!piniaUrl) throw new Error('页面里没有 pinia 资源 —— 挂载那一步没成功');
    const P = await import(piniaUrl);
    P.setActivePinia(window.__pinia);
    const m = await import('/src/stores/useChatStore.ts');
    const chat = m.useChatStore();
    chat.mentionedConvs = new Set(arg.mention ? [arg.convId] : []);
    chat.openTodoByConv = arg.todos ? { [arg.convId]: arg.todos } : {};
    const written = { mention: chat.mentionedConvs.size, todo: JSON.stringify(chat.openTodoByConv) };
    const t = window.__probe.vue;
    await t.nextTick(); await t.nextTick();
    const I = await import('/src/i18n/index.ts');
    const row = document.querySelector('[role="button"][aria-label]');
    return {
      label: row ? (row.getAttribute('aria-label') || '') : null,
      text: row ? (row.innerText || '') : '',
      badges: Array.from(document.querySelectorAll('[class*="min-w-4"]'))
        .map((e) => (e.textContent || '').trim()),
      /**
       * §10「群任务数量与群未读数量必须具有明显不同的视觉语义」—— 这条**量得出**：
       * 比两枚的计算形状与有没有图标，而不是比颜色
       * （改之前两枚是同一个 UnreadBadge、只差底色 ⇒ 这条必须红）。
       * ⚠️ 这段注释在一个**模板字符串**里 ⇒ 不能再出现反引号（会把外层模板提前关掉，
       *    本轮就这么把整个脚本改挂过一次）。
       * 未读那枚仍由 [class*="min-w-4"] 认（它是徽标家族的唯一实现，有 designGuards 钉着）；
       * 任务那枚由 data-todo-chip 认 —— 一个为「这一族只长这样」留的稳定钩子。
       */
      unreadShape: (() => {
        const e = document.querySelector('[class*="min-w-4"]');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { text: (e.textContent || '').trim(), radius: getComputedStyle(e).borderRadius,
          h: Math.round(r.height), icon: !!e.querySelector('svg') };
      })(),
      todoShape: (() => {
        const e = document.querySelector('[data-todo-chip]');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { text: (e.textContent || '').trim(), radius: getComputedStyle(e).borderRadius,
          h: Math.round(r.height), icon: !!e.querySelector('svg') };
      })(),
      /**
       * §10「不影响消息标题」—— 这半条也量得出，条件是量**布局结果**而不是量 class：
       * 名字那格必须仍然是「单行 + 省略号」，时间那格必须仍然完整落在行的右边界内。
       * 加了图标数字（比裸徽标宽约 15px）之后最容易坏的就是这两处：
       * 要么名字不再截断而把时间挤出行外，要么整行被撑成两行。
       * ⚠️ 名字**必须**用 data-conv-name 而不是 [class*="truncate"] 抓：组件里有两个带
       *    truncate 的 span（名字与摘要），把名字那个的 truncate 删掉时"按 class 找第一个"
       *    会静默改量摘要那格 ⇒ 假绿（lie 跑之前先想到这一层，跑出来就看不出来了）。
       */
      layout: (() => {
        const name = document.querySelector('[data-conv-name]');
        const time = document.querySelector('[class*="whitespace-nowrap"]');
        if (!name || !time || !row) return null;
        const cs = getComputedStyle(name);
        const nr = name.getBoundingClientRect();
        const tr = time.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return {
          ellipsis: cs.textOverflow, overflowX: cs.overflow,
          nameH: Math.round(nr.height * 10) / 10, rowH: Math.round(rr.height * 10) / 10,
          timeInside: tr.right <= rr.right + 0.5 && tr.left >= rr.left - 0.5,
        };
      })(),
      wantMention: I.t('msg.mentioned'),
      wantUnread: I.t('conv.unread', { name: arg.name, n: arg.unread }),
      wantTodo: I.t('todo.openForMe', { n: arg.todos }),
      dbg: { written: written, seen: Array.from(chat.mentionedConvs).join('|'),
        todos: JSON.stringify(chat.openTodoByConv), sid: chat.$id,
        registered: (window.__pinia && window.__pinia._s && window.__pinia._s.size) || -1 },
    };
  };
  /**
   * 量「描述里那枚 @ 高亮」与「描述那个带 max-h + overflow-hidden 的裁切框」两个矩形。
   * 框用 class 片段找（Tailwind 那个 max-h-[…] 写成属性选择器最稳，不去猜具体值），
   * 行高**由 computed style 现读**——写死 19.5px 就是下一个漂移点。
   */
  H.mentionClip = async () => {
    const box = document.querySelector('[class*="max-h-"][class*="overflow-hidden"]');
    if (!box) throw new Error('找不到描述那个裁切框（class 口径变了？）');
    const tok = box.querySelector('.mention-token--self') || box.querySelector('.mention-token');
    if (!tok) throw new Error('描述里找不到 @ 高亮那一段（渲染没发生）');
    const b = box.getBoundingClientRect(), t = tok.getBoundingClientRect();
    const cs = window.getComputedStyle(box);
    return {
      boxTop: Math.round(b.top * 100) / 100, boxBottom: Math.round(b.bottom * 100) / 100,
      boxH: Math.round(b.height * 100) / 100,
      scrollH: Math.round(box.scrollHeight), clientH: Math.round(box.clientHeight),
      tokTop: Math.round(t.top * 100) / 100, tokBottom: Math.round(t.bottom * 100) / 100,
      tokH: Math.round(t.height * 100) / 100,
      lineHeight: cs.lineHeight, fontSize: cs.fontSize, selfToken: !!tok.classList.contains('mention-token--self'),
    };
  };
  H.grid = () => Array.from(document.querySelectorAll('button:not(#trigger)'));
  H.gridInfo = () => {
    const btns = H.grid();
    const el = document.activeElement;
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    return {
      count: btns.length,
      focusIdx: btns.indexOf(el),
      focusId: el ? (el.id || el.tagName) : 'none',
      x: r ? Math.round(r.left) : -1,
      y: r ? Math.round(r.top) : -1,
      triggerActive: el === document.getElementById('trigger'),
    };
  };
  // 列数**不写死也不读 class**：按第一行里不同的 x 数出来。
  // 组件里 ↑↓ 的步长是一个写死的 COLS，而真正的列数由布局决定 —— 两者不同步的表现就是跳错行，
  // 所以判据的分母必须来自布局本身，不能来自我对 class 的解读。
  H.cols = () => {
    const btns = H.grid();
    if (!btns.length) return -1;
    const geo = btns.map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; });
    const top = Math.min(...geo.map((g) => g.y));
    const firstRow = geo.filter((g) => Math.abs(g.y - top) <= 2);
    return new Set(firstRow.map((g) => g.x)).size;
  };
  /** 网格里**非按钮**的那些子元素（= 两段的小标题），按 DOM 顺序。 */
  H.gridLabels = () => {
    const first = H.grid()[0];
    const grid = first ? first.parentElement : null;
    if (!grid) return [];
    return Array.from(grid.children)
      .filter((c) => c.tagName !== 'BUTTON')
      .map((c) => ({
        tag: c.tagName,
        text: String(c.textContent || '').trim(),
        y: Math.round(c.getBoundingClientRect().top),
      }));
  };
  /** 网格第一个子元素的标签名（判"常用那一节消失后剩的是谁"）。 */
  H.gridFirstChildTag = () => {
    const first = H.grid()[0];
    const grid = first ? first.parentElement : null;
    const c = grid ? grid.firstElementChild : null;
    return c ? c.tagName : 'none';
  };
  H.focusTrigger = () => { document.getElementById('trigger').focus(); };
  /** 面板里每一格：alt（表情名）、常用标记、**计算后的背景色**、落点。按 DOM 顺序，不按组件内部下标。 */
  H.emojiCells = () => H.grid().map((b) => {
    const img = b.querySelector('img');
    const r = b.getBoundingClientRect();
    return {
      alt: img ? img.alt : '',
      freq: b.getAttribute('data-emoji-freq') === '1',
      bg: getComputedStyle(b).backgroundColor,
      x: Math.round(r.left),
      y: Math.round(r.top),
    };
  });
  /** 网格的**第一个子元素**是什么 —— 「常用」小标题必须是它，而且必须是**非按钮**（按钮会挤进步长）。 */
  H.gridHead = () => {
    const first = H.grid()[0];
    const grid = first ? first.parentElement : null;
    if (!grid) return { tag: 'none', text: '' };
    const c = grid.firstElementChild;
    return { tag: c ? c.tagName : 'none', text: c ? String(c.textContent || '').trim() : '' };
  };
  /** 命中列表的当前高亮：组件用 data-hit + aria-current 两个钩子表达，读的就是这两个钩子。 */
  H.hits = () => {
    const list = Array.from(document.querySelectorAll('[data-hit]'));
    return {
      n: list.length,
      at: list.findIndex((el) => el.getAttribute('aria-current') === 'true'),
      ids: list.map((el) => el.getAttribute('data-msg') || el.getAttribute('data-hit')),
    };
  };
  /** 「发送人」那枚筛选入口的中心坐标（给真点击用）。 */
  H.filterChip = () => {
    const b = document.querySelector("button[aria-haspopup='menu']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  /** 菜单自己**计算后**的背景 —— 透明就是用户那句「筛选下拉都是透明的」。 */
  H.menuStyle = () => {
    const m = document.querySelector('.gosslan-menu');
    if (!m) return { present: false, bg: '', blur: '', hit: false, hidden: false, pe: '' };
    const cs = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + Math.min(r.width / 2, 24), r.top + 10);
    return {
      present: true,
      bg: cs.backgroundColor,
      blur: cs.backdropFilter || cs.webkitBackdropFilter || '',
      // 嵌套在 Reka Dialog 里：Portal 出去后必须仍能被命中、且没被 Dialog 的 aria-hidden 关掉。
      hit: !!(top && m.contains(top)),
      hidden: m.closest('[aria-hidden="true"]') !== null,
      pe: cs.pointerEvents,
    };
  };
  /** 方向键与回车都挂在搜索框上 ⇒ 点过菜单之后必须把焦点还回去，不然下面的键盘判据红在夹具。 */
  H.focusInput = () => {
    const i = document.querySelector('input');
    if (!i) return false;
    i.focus();
    return document.activeElement === i;
  };
  /**
   * 消息列表 VirtualList 专用夹具：需要组件 ref 与可变 items，通用 install 不够。
   * 不碰任何 store；只用 props 驱动，验证的是列表本身的虚拟化/锚定/跳转。
   */
  H.vlistMount = async (count) => {
    // 不要用 H.install 来"借" Vue：它会用通用 props 挂载 VirtualList，
    // 而本组件没有 items 就会在 computed 里立刻抛错。直接从页面已加载的 vue 模块取。
    let V = window.__probe.vue;
    if (!V) {
      const u = performance.getEntriesByType('resource').map((e) => e.name || '')
        .find((x) => x.includes('/node_modules/.vite/deps/vue.js?v='));
      if (!u) return { ok: false, why: 'no-vue' };
      V = await import(u);
      window.__probe.vue = V;
    }
    const mod = await import('/src/components/VirtualList.vue');
    document.body.innerHTML = '';
    const host = document.createElement('div');
    host.id = 'vlist-host';
    host.style.cssText = 'height:400px;width:600px;position:relative;';
    document.body.appendChild(host);
    const n = count || 200;
    const st = V.reactive({
      items: Array.from({ length: n }, (_, i) => ({ id: 'row-' + i, text: 'row ' + i })),
      nearBottom: null,
      loadMore: 0,
      live: true,
    });
    // ⚠️ 不能把 ref 放进 reactive：reactive 会自动解包，st.list 读出来是 null，
    // 组件 ref 就永远绑不上。列表 ref 单独放在 window 上。
    const listRef = V.ref(null);
    window.__vlist = st;
    window.__vlistList = listRef;
    const Root = {
      setup() {
        return () => V.h('div', { style: 'height:400px;width:600px;' }, [
          V.h(mod.default, {
            ref: listRef,
            items: st.items,
            estimateHeight: () => 40,
            live: st.live,
            onNearBottom: (v) => { st.nearBottom = v; },
            onLoadMore: () => { st.loadMore += 1; },
          }, {
            default: ({ item, index }) => V.h('div', {
              'data-vrow': index,
              style: 'height:' + (item.h || 40) + 'px;line-height:' + (item.h || 40) + 'px;',
            }, item.text),
          }),
        ]);
      },
    };
    const app = V.createApp(Root);
    if (window.__pinia) app.use(window.__pinia);
    app.mount(host);
    await V.nextTick(); await V.nextTick();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ok: true, count: n };
  };
  H.vlistScroll = () => {
    const row = document.querySelector('#vlist-host [data-vlist-index]');
    const sc = row ? row.closest('.overflow-y-auto') : null;
    return sc;
  };
  H.vlistRead = () => {
    const sc = H.vlistScroll();
    const rows = Array.from(document.querySelectorAll('#vlist-host [data-vlist-index]'));
    const sr = sc ? sc.getBoundingClientRect() : null;
    const visible = sr ? rows.find((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > sr.top + 0.5 && b.top < sr.bottom - 0.5;
    }) : null;
    return {
      rows: rows.length,
      keys: rows.map((r) => r.getAttribute('data-vlist-key')),
      scrollTop: sc ? Math.round(sc.scrollTop) : -1,
      scrollHeight: sc ? sc.scrollHeight : -1,
      clientHeight: sc ? sc.clientHeight : -1,
      firstVisible: visible ? visible.getAttribute('data-vlist-key') : null,
      firstTop: visible && sr ? Math.round(visible.getBoundingClientRect().top - sr.top) : null,
      loadMore: window.__vlist.loadMore,
      nearBottom: window.__vlist.nearBottom,
      role: sc ? sc.getAttribute('role') : null,
      live: sc ? sc.getAttribute('aria-live') : null,
    };
  };
  H.vlistRow = (key) => {
    const sc = H.vlistScroll();
    const row = Array.from(document.querySelectorAll('#vlist-host [data-vlist-key]'))
      .find((r) => r.getAttribute('data-vlist-key') === key);
    if (!sc || !row) return { present: false, top: null };
    return { present: true, top: Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top) };
  };
  H.vlistGoBottom = () => {
    const sc = H.vlistScroll();
    if (!sc) return false;
    sc.scrollTop = sc.scrollHeight;
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  };
  H.vlistGoTop = () => {
    const sc = H.vlistScroll();
    if (!sc) return false;
    sc.scrollTop = 0;
    sc.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  };
  H.vlistJump = (i) => {
    const l = window.__vlistList && window.__vlistList.value;
    if (!l || typeof l.scrollToIndex !== 'function') return false;
    l.scrollToIndex(i, 'top');
    return true;
  };
  H.vlistPrepend = (n) => {
    const st = window.__vlist;
    if (!st) return false;
    const add = Array.from({ length: n || 20 }, (_, i) => ({ id: 'new-' + i, text: 'new ' + i }));
    st.items = add.concat(st.items);
    return true;
  };
  /** 模拟切会话：整表换 key，且行高与估算值（40）不同，逼出重测收敛。 */
  H.vlistSwap = (n) => {
    const st = window.__vlist;
    if (!st) return false;
    st.items = Array.from({ length: n || 120 }, (_, i) => ({
      id: 'swap-' + i,
      text: 'swap ' + i,
      h: 28 + ((i * 7) % 5) * 9,
    }));
    return true;
  };
  /** 切换后让行高在估算值两侧来回变几拍，模拟图片/字体把实测高度分批修正。 */
  H.vlistWobble = (waves, interval) => {
    const st = window.__vlist;
    if (!st) return false;
    let k = 0;
    const timer = setInterval(() => {
      st.items = st.items.map((it, i) => ({ ...it, h: ((i + k) % 2 ? 46 : 28) }));
      k += 1;
      if (k >= (waves || 6)) clearInterval(timer);
    }, interval || 35);
    return true;
  };
  /** 连续采样滚动位置：用来看切换后是否来回抖。 */
  H.vlistSampleScroll = (ms) => new Promise((resolve) => {
    const out = [];
    const t0 = performance.now();
    const tick = () => {
      const sc = H.vlistScroll();
      if (sc) out.push(Math.round(sc.scrollTop));
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve(out);
    };
    tick();
  });
  return H;
})();
true;
`;

async function waitForVite(child, timeoutMs = 90_000) {
  let buf = "";
  let onData;
  let onExit;
  let timer;
  const p = new Promise((res, rej) => {
    // vite 6 把启动横幅（含 "Local:"）打到 **stderr**：只听 stdout 会在 90s 后假超时。
    // 两个流都认。
    onData = (d) => {
      // vite 6 的横幅带 ANSI 码："Local\x1b[22m:"，直接匹配 /Local:/ 永远不成立。
      // 累积原文（exit 排障要看），判定前剥掉 ANSI；只保留末尾一段，避免随 vite
      // 持续输出无界增长（SC-P3-05）。
      const text = d.toString();
      buf = (buf + text).slice(-64 * 1024);
      if (/Local:/.test(buf.replace(/\x1b\[[0-9;]*m/g, ""))) res(true);
    };
    onExit = (c) => rej(new Error(`vite 提前退出 ${c}：\n${buf.slice(-800)}`));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`vite ${timeoutMs}ms 没起来：\n${buf.slice(-800)}`)), timeoutMs);
  });
  try {
    await Promise.race([p, timeout]);
  } finally {
    // 成功/失败/超时都要摘掉监听器与定时器：vite 是长跑进程，留着监听器会让
    // `buf` 在整个测试 run 里继续增长（SC-P3-05）。
    clearTimeout(timer);
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
    child.off("exit", onExit);
  }
  return `http://127.0.0.1:${VITE_PORT}/`;
}

/**
 * 会话行那两枚徽标（#88 那四处读屏缺陷与 #117 剩下的那一半）。
 *
 * 这一格以前只有两种证据：源码守卫（禁手写徽标副本）+ 我拿系统控件树**手工**看过一次。
 * 而 #88 的真实形状是「屏幕上看得见、树里读不到」—— 只有把事实**并进这一行自己的
 * accessible name** 才算修好。所以这段判四件事各自的条件：未读数、有人@我、与我相关的
 * 开放任务数三句都得在名字里，**且各自不亮的时候不许混进来**（只钉「都在」会被
 * 「永远把三句都拼进去」那种写法混过去 = 半个守卫）。
 * ⚠️ 层次边界：徽标「该不该亮」的判定在 Rust 与 store 侧，另有单元与跨进程判据；
 *   这一段只判**亮起来之后界面与读屏得不到得到它**。真 WKWebView / WebView2 仍归 Smoke-11。
 */
/**
 * 主题色的三档派生（hover / active / light）—— §6.49 把「JS 算一份 + `:root` 再硬编一份近似值」
 * 收敛成 CSS `color-mix()` 一处之后，这一格量的是**这台内核真把它算成了什么 rgb**：
 * 单测只能证明声明写成了 color-mix，证明不了引擎认不认、算得对不对。
 *
 * ⚠️ 取值要落到真实元素上再读 computed：自定义属性本身读回来是**未解析的** `color-mix(...)`
 * 字面量，只有被用掉（这里当 `color` 用）才会变成 rgb —— 那才是用户眼睛看到的值。
 * 期望值按被删掉那份 JS 的算法现算（混白 8% / 混黑 15% / 12% 透明），容差 ±2；
 * 它是**量具**，不是产品里的第二份实现。
 */
async function runAccent(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  const SEED = "#d43d43";
  const read = await cdp.eval(
    "(() => {" +
      "  const root = document.documentElement;" +
      "  const prev = root.style.getPropertyValue('--gosslan-primary');" +
      "  const mk = (token) => {" +
      "    const d = document.createElement('div');" +
      "    d.style.color = 'var(' + token + ')';" +
      "    document.body.appendChild(d);" +
      "    const c = getComputedStyle(d).color;" +
      "    d.remove();" +
      "    return c;" +
      "  };" +
      "  const before = {" +
      "    hover: mk('--gosslan-primary-hover')," +
      "    active: mk('--gosslan-primary-active')," +
      "    light: mk('--gosslan-primary-light')," +
      "  };" +
      "  root.style.setProperty('--gosslan-primary', '" + SEED + "');" +
      "  const inline = {};" +
      "  for (const k of ['--gosslan-primary', '--gosslan-primary-hover', '--gosslan-primary-active', '--gosslan-primary-light']) {" +
      "    inline[k] = root.style.getPropertyValue(k);" +
      "  }" +
      "  const out = {" +
      "    inline," +
      "    before," +
      "    support: CSS.supports('color', 'color-mix(in srgb, red 50%, blue)')," +
      "    primary: mk('--gosslan-primary')," +
      "    hover: mk('--gosslan-primary-hover')," +
      "    active: mk('--gosslan-primary-active')," +
      "    light: mk('--gosslan-primary-light')," +
      // 同一批 token 在暗色外观下的取值：填充与前景是**成对**的，只量亮色那一档等于没量。
      // 读完把 class 摘回去，不把这份状态留给后面的段。
      "    dark: (() => {" +
      "      const r = document.documentElement;" +
      "      const had = r.classList.contains('dark');" +
      "      r.classList.add('dark');" +
      "      const o = { active: mk('--gosslan-primary-active'), hover: mk('--gosslan-primary-hover'), on: mk('--gosslan-on-primary') };" +
      "      if (!had) r.classList.remove('dark');" +
      "      return o;" +
      "    })()," +
      "    font: (() => {" +
      "      const d = document.createElement('div');" +
      "      d.style.fontFamily = 'var(--gosslan-font-family)';" +
      "      document.body.appendChild(d);" +
      "      const beforeF = getComputedStyle(d).fontFamily;" +
      "      root.style.setProperty('--gosslan-font-family', 'monospace');" +
      "      const afterF = getComputedStyle(d).fontFamily;" +
      "      root.style.removeProperty('--gosslan-font-family');" +
      "      d.remove();" +
      "      return { before: beforeF, after: afterF };" +
      "    })()," +
      "  };" +
      "  root.style.setProperty('--gosslan-primary', prev);" +
      "  return out;" +
      "})()",
  );
  // ⚠️ 量具自己的坑（这一格第一次跑就撞上）：Chrome 153 把 color-mix 的结果按
  // `color(srgb 0.844863 0.300078 0.321725 / 0.12)` 回传，而不是 `rgb(...)`。
  // 直接按 "3 个数" 抓会把 0.84/0.30/0.32 当成 RGB —— 数值全错而格式看着完全正常。
  // 所以两种写法都要归一化，并且先拿**合成正控**证明归一化本身没坏。
  const toRgb = (s) => {
    const v = String(s).trim();
    const mSrgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(v);
    if (mSrgb) return [1, 2, 3].map((i) => Number(mSrgb[i]) * 255).concat(Number(mSrgb[4] ?? 1));
    const mRgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i.exec(v);
    if (mRgb) return [1, 2, 3].map((i) => Number(mRgb[i])).concat(Number(mRgb[4] ?? 1));
    // 十六进制：`style.css` 里那些**字面量**档位（如暗色前景 `--gosslan-app-bg: #0b1220`）
    // 从磁盘解析出来就是这一形。浏览器只会回 rgb()/color(srgb)，所以这条支路
    // 只有量具自己会用到 —— 没有下面那发合成正控，它坏了没人知道。
    const mHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(v);
    if (mHex) {
      const h = mHex[1];
      const c = h.length === 3 ? h.split("").map((x) => x + x) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
      return c.map((x) => parseInt(x, 16)).concat(1);
    }
    return null;
  };
  const ctrlSrgb = toRgb("color(srgb 0.8 0.4 0 / 0.5)");
  const ctrlRgb = toRgb("rgba(200, 100, 0, 0.25)");
  const ctrlHex = toRgb("#0b1220");
  const ctrlHex3 = toRgb("#abc");
  check(
    "取色器自身可用：rgb()、color(srgb) 与十六进制三种写法都能归一化成 [r,g,b,a]（合成正控）",
    !!ctrlSrgb && !!ctrlRgb && !!ctrlHex && !!ctrlHex3 &&
      ctrlSrgb.join(",") === "204,102,0,0.5" &&
      ctrlRgb.join(",") === "200,100,0,0.25" &&
      ctrlHex.join(",") === "11,18,32,1" &&
      ctrlHex3.join(",") === "170,187,204,1",
    "[204,102,0,0.5]、[200,100,0,0.25]、[11,18,32,1] 与 [170,187,204,1]",
    JSON.stringify({ ctrlSrgb, ctrlRgb, ctrlHex, ctrlHex3 }),
  );
  const seed = [0xd4, 0x3d, 0x43];
  const mix = (target, ratio) => seed.map((v) => Math.round(v + (target - v) * ratio));
  const near = (got, want, tol) => !!got && got.length >= 3 && want.every((v, i) => Math.abs(got[i] - v) <= tol);
  const hover = toRgb(read.hover);
  const active = toRgb(read.active);
  const light = toRgb(read.light);
  check(
    "这台内核认 color-mix，三档派生都在真实元素上算成了具体颜色（不是原样返回字面量）",
    read.support === true && !!hover && !!active && !!light && toRgb(read.primary) != null,
    "support=true 且主色/三档全部可解析",
    JSON.stringify({ support: read.support, primary: read.primary, hover: read.hover, active: read.active, light: read.light }),
  );
  // 这一格量的是"首屏那一刻就已经成套"：页面上只改主色这一个 inline，派生三档必须跟着换。
  // ⚠️ 判据不能写成"另三档 inline 为空" —— 探针页面里没有 Tauri，store 的 applyTheme 根本不会跑，
  // 那种写法测的是这个环境恰好没写，不是产品没写（本轮就这么假绿过一次）。
  const moved = ["hover", "active", "light"].filter((k) => String(read.before[k]) !== String(read[k]));
  check(
    "只改写主色这一个 inline，派生三档就跟着换（首屏那套颜色是成套的，不需要 JS 再补写）",
    String(read.inline["--gosslan-primary"] || "").trim() === SEED && moved.length === 3,
    "三档取值都随主色改变",
    JSON.stringify({ inline: read.inline, moved, before: read.before }),
  );
  // ⚠️ 混色比例**不许**在这一格手抄（就漂过一次：CSS 从 15% 改成 28% 时探针里那个 0.15
  //    自己变红，红的是量具不是产品）。两档外观的四条混法 + 暗色前景档全部从
  //    `src/style.css` 现解析 ⇒ 磁盘上那份和浏览器算出来那份必须是同一个数；
  //    解析不出来 ⇒ 期望值 null ⇒ 这一格红（失败关闭，不静默放行）。
  //    填充档与前景档是**成对**的：亮色朝黑混（白字压得住）、暗色朝白混（与 #1e293b
  //    面板分得开 + 前景换深墨）。所以暗色那三行也要真在浏览器里量一次 ——
  //    .dark 的覆盖没生效时，只有这里会红，静态判据看不出来。
  const cssText = fs.readFileSync(path.join(ROOT, "src/style.css"), "utf8");
  // 作用域必须按**行首的** `:root {` / `.dark {` 认 —— 注释里也写着 `.dark {`，
  // 朴素匹配会先撞上那条评论（tokenContrast.test.ts 就是为这个坑写的）。
  const rootBlock = /^:root\s*\{([\s\S]*?)^\}/m.exec(cssText)?.[1] ?? "";
  const darkBlock = /^\.dark\s*\{([\s\S]*?)^\}/m.exec(cssText)?.[1] ?? "";
  /** 解析 `--gosslan-<token>: color-mix(in srgb, var(--gosslan-primary) N%, #hex)`。 */
  const readMix = (scope, token) => {
    const m = new RegExp(
      "--gosslan-" + token + ":\\s*color-mix\\(\\s*in srgb,\\s*var\\(--gosslan-primary\\)\\s+([\\d.]+)%\\s*,\\s*(#[0-9a-fA-F]{3,6})\\s*\\)",
    ).exec(scope);
    return m ? { pct: Number(m[1]), other: m[2].toLowerCase() } : null;
  };
  /** 解析 `--gosslan-<token>: #hex` 或 `var(--gosslan-xxx)`（后者按同层叠顺序跟着再解一层）。 */
  const readFlat = (scope, token, top) => {
    // ⚠️ 冒号后的空格必须**提到分支外面**：写成 `(?:\s*#hex|var\(...))` 时
    // 只有第一支吃得到空格，`var(--gosslan-app-bg)` 前那个空格会让整条正则不匹配，
    // 于是暗色前景档解析成 null —— 红的是量具，不是产品。
    const m = new RegExp(
      "--gosslan-" + token + ":\\s*(?:(#[0-9a-fA-F]{3,6})|var\\(--gosslan-([a-z-]+)\\))\\s*;",
    ).exec(scope);
    if (!m) return null;
    if (m[1]) return m[1].toLowerCase();
    return readFlat(top ?? scope, m[2], top);
  };
  // 混色结果 = 主色与另一色按 (100−pct)% 线性插值：另一色是黑 ⇒ 压暗，是白 ⇒ 提亮。
  const mixOf = (d) => {
    if (!d) return null;
    if (d.other === "#000000") return mix(0, (100 - d.pct) / 100);
    if (d.other === "#ffffff") return mix(255, (100 - d.pct) / 100);
    return null;
  };
  const lightFill = readMix(rootBlock, "primary-active");
  const lightHover = readMix(rootBlock, "primary-hover");
  const darkFill = readMix(darkBlock, "primary-active");
  const darkHover = readMix(darkBlock, "primary-hover");
  const darkInk = readFlat(darkBlock, "on-primary", darkBlock);
  check(
    "两档外观的填充/hover 混法与暗色前景档都能从 src/style.css 解析出来（量具不手抄常数）",
    [lightFill, lightHover, darkFill, darkHover].every((d) => !!d) && !!darkInk && !!read.dark,
    "4 条 color-mix + 1 条暗色前景 + 浏览器读到的 dark 那一组",
    JSON.stringify({ lightFill, lightHover, darkFill, darkHover, darkInk, dark: read.dark }),
  );
  check(
    `亮色：填充 = 主色混黑 ${lightFill?.pct ?? "?"}%，hover 再深一档（${lightHover?.pct ?? "?"}%）—— 白字压得住，且越 hover 越清楚`,
    !!lightFill && !!lightHover &&
      near(active, mixOf(lightFill), 2) &&
      near(hover, mixOf(lightHover), 2) &&
      lightHover.pct < lightFill.pct,
    JSON.stringify({ active: mixOf(lightFill), hover: mixOf(lightHover) }),
    JSON.stringify({ active: read.active, hover: read.hover }),
  );
  const dk = read.dark ?? {};
  const dkActive = toRgb(dk.active);
  const dkHover = toRgb(dk.hover);
  const dkOn = toRgb(dk.on);
  const wantDarkInk = darkInk ? toRgb(darkInk) : null;
  check(
    "暗色：同一批 token 在 .dark 下确实换了方向（填充提亮、前景换成深墨）—— 少一条 .dark 覆盖就只有这里会红",
    !!darkFill && !!darkHover && !!wantDarkInk &&
      near(dkActive, mixOf(darkFill), 2) &&
      near(dkHover, mixOf(darkHover), 2) &&
      near(dkOn, wantDarkInk, 2) &&
      darkHover.pct < darkFill.pct,
    JSON.stringify({ active: mixOf(darkFill), hover: mixOf(darkHover), on: wantDarkInk }),
    JSON.stringify({ active: dk.active, hover: dk.hover, on: dk.on }),
  );
  const sum = (c) => (c ? c[0] + c[1] + c[2] : -1);
  check(
    "两档外观不会撞成同一个数（亮色压暗、暗色提亮 ⇒ 暗色那一档必须更亮）",
    sum(dkActive) > sum(active) && sum(dkOn) < sum(active),
    "暗色填充总和 > 亮色填充；暗色前景（深墨）总和 < 填充",
    JSON.stringify({ light: active, darkFill: dkActive, darkOn: dkOn }),
  );
  check(
    "light 档 = 主色 12% 透明（RGB 跟着主色、alpha≈0.12 ⇒ 半透明底也随换色走）",
    near(light, seed, 2) && light != null && Math.abs(light[3] - 0.12) <= 0.01,
    "rgba(212,61,67,0.12)",
    read.light,
  );
  check(
    "字体 token 不是死变量：改内联 --gosslan-font-family 后真实元素的 computed fontFamily 跟着换",
    String(read.font.after).includes("monospace") && read.font.before !== read.font.after,
    "改前 != 改后，且改后含 monospace",
    JSON.stringify(read.font),
  );
}

async function runConvBadge(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const GROUP = {
    id: "group:probe-badge", kind: "group", name: "验收群", avatar: null,
    unread: 3, last_msg: "收到一条", last_ts: 1, pinned: false,
  };
  // 未读是**prop**（挂载时刻冻住），徽标态是 **store**（随时可变）⇒ 想要"没有未读"那一档，
  // 只能换一个 conv 重新挂一次，不能靠改探针参数。
  const GROUP0 = { ...GROUP, unread: 0 };
  const PRIVATE = { ...GROUP0, id: "p:probe-badge", kind: "private", name: "验收人" };
  const mount = async (conv) => {
    await cdp.eval("window.__probe.install('/src/components/conversation/ConversationListItem.vue', '', "
      + JSON.stringify(JSON.stringify({ conv, active: false, online: null })) + ")");
    await sleep(900);
  };
  // ⚠️ 这里只做**一层** stringify：convRow 收的是对象，而 install 的第三参本身是字符串
  //   （那一句才要双层）。写成双层会让页面拿到一个字符串、arg.mention 恒为 undefined
  //   ⇒ 徽标永远不亮，而红得完全像"产品没渲染出来"（本轮就这么红过一次，6 条全红）。
  const probe = async (conv, mention, todos) => cdp.eval(
    "window.__probe.convRow(" + JSON.stringify({
      convId: conv.id, name: conv.name, unread: conv.unread, mention, todos }) + ")");

  // —— ① 三态齐：未读 + @我 + 与我相关的开放任务 ——
  await mount(GROUP);
  const a = await probe(GROUP, true, 2);
  check("三态齐时这一行的 accessible name 同时含未读那句、有人@我、与我相关的任务数",
    !!a.label && a.label.includes(a.wantUnread) && a.label.includes(a.wantMention)
      && a.label.includes(a.wantTodo), "三句都在名字里", JSON.stringify(a.label));
  check("三态齐时两枚数字各自可见（未读 3 与任务 2）",
    a.badges.includes("3") && !!a.todoShape && a.todoShape.text === "2",
    "未读=3、任务=2", `badges=${JSON.stringify(a.badges)} todo=${JSON.stringify(a.todoShape)}`);
  check("两枚的视觉语义必须不同：未读＝圆形无图标，任务＝图标＋数字（§10「不要两个数字都长得一样」）",
    !!a.unreadShape && !!a.todoShape
      && a.unreadShape.icon === false && a.todoShape.icon === true
      && a.unreadShape.radius !== a.todoShape.radius,
    "未读无图标且计算半径不同 / 任务带图标",
    `未读=${JSON.stringify(a.unreadShape)} 任务=${JSON.stringify(a.todoShape)}`);
  check("带任务那枚时名字仍是单行省略号、时间那格完整落在行内（§10「不影响消息标题」）",
    !!a.layout && a.layout.ellipsis === "ellipsis" && a.layout.overflowX === "hidden"
      && a.layout.nameH <= 22 && a.layout.timeInside === true,
    "text-overflow=ellipsis · overflow=hidden · 名字≤22px · 时间在行内",
    JSON.stringify(a.layout));
  if (SHOT_PATH) {
    // §10 的后半句是「位置由实际视觉效果决定」—— 光有数字判不出"两枚会不会互相遮"，
    // 所以这里可选地存一张真图（只在给了 --shot 时跑；不给就一字不动，条数不变）。
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH, Buffer.from(shot.data, "base64"));
    console.log(`  📷 已存会话行截图 → ${SHOT_PATH}`);
  }
  check("有人@我那句要在行内可见文本里（不能只挂在名字上，鼠标用户也得看得见）",
    a.text.includes(a.wantMention), "可见文本含这句", JSON.stringify(a.text.slice(0, 60)));

  // —— ② 有未读、有 @我，但没有待办：任务那句不许混进来 ——
  const b = await probe(GROUP, true, 0);
  check("没有与我相关的任务时，名字里不许出现那句任务数（三句各自有条件）",
    b.label.includes(b.wantMention) && b.label.includes(b.wantUnread)
      && !b.label.includes(b.wantTodo), "含@我与未读、不含任务句", JSON.stringify(b.label));

  // —— ③ 对照：三态全清 ⇒ 名字恰好等于群名、一枚徽标都没有 ——
  await mount(GROUP0);
  const c = await probe(GROUP0, false, 0);
  check("对照：三态全清时名字恰好等于群名、零枚徽标（证明①不是恒过）",
    c.label === GROUP0.name && c.badges.length === 0 && !c.text.includes(c.wantMention)
      && !c.todoShape,
    "名字 = 验收群 且 0 枚徽标", `${JSON.stringify(c.label)} / 徽标=${JSON.stringify(c.badges)}`);

  // —— ④ 只有 @我（未读 0）：另两句都不该出现 ——
  const d = await probe(GROUP0, true, 0);
  check("只有@我时名字里只有群名与那句@我（未读与任务两句没资格出现）",
    d.label === `${GROUP0.name}，${d.wantMention}`, "验收群，<@我那句>", JSON.stringify(d.label));

  // —— ⑤ 单聊没有群任务：store 里有数也不许念出来 ——
  await mount(PRIVATE);
  const e = await probe(PRIVATE, false, 2);
  check("单聊行不许出现「与我相关的任务数」（那一族只属于群聊，口径由组件把住）",
    !e.label.includes(e.wantTodo) && e.label === PRIVATE.name, "名字 = 验收人",
    JSON.stringify(e.label));
}

/**
 * 一次按键的「只激活一次」守卫：capture 阶段计数 + 空等 1 秒再数一次。
 *
 * 为什么值得当判据（2026-10-10 实测，不是预防性设计）：`rawKeyDown` 带 `text` 时 CfT 153 会进入
 * **自持重复** —— 按完读到 28 次激活、之后每秒再涨 ~550 次，补发单独 keyUp 也不终止。那种状态下
 * 任何"开/关切换"型读数都是掷硬币。而**光看界面还会看不出来**：`pinkb` 那句"回车后那条从置顶条上
 * 消失"对重复完全不敏感（作用对象按完就消失了，后续重复没有靶子）⇒ 这条计数是它唯一的证据。
 *
 * 计数器必须挂在 **capture** 阶段：被测元素普遍带 `@click.stop`，冒泡阶段的计数器会什么都读不到。
 *
 * ⚠️ 这对判据的敏感度**分场景**，实测过别再外推：reaction 那一对能咬住风暴（把发法改回
 * `rawKeyDown`+text ⇒ 立刻红两条），pinkb 那一对在同一个变异下**仍绿** —— 因为那颗 ✕ 按完就离开 DOM，
 * 重复没有作用对象 ⇒ 计数自然不再涨。所以"回车只触发一次"这句话在 pinkb 那格仍然只能靠
 * reaction 那一对与 emoji 的「恰好一次 select」来背书，别引用 pinkb 的计数。
 */
async function keyOnce(cdp, name, press) {
  await cdp.eval(`(() => {
    if (window.__onceHandler) window.removeEventListener("click", window.__onceHandler, true);
    window.__onceHandler = () => { window.__once = (window.__once || 0) + 1; };
    window.__once = 0;
    window.addEventListener("click", window.__onceHandler, true);
    return 1;
  })()`);
  await press();
  const at = await cdp.eval("window.__once");
  await sleep(1_000);
  const after = await cdp.eval("window.__once");
  check(`${name}：一次按键只激活一次（capture 计数，不是"看起来生效了"）`,
    Number(at) === 1, "恰好 1 次 click", `按完读到 ${JSON.stringify(at)}`);
  check(`${name}：空等 1 秒不再增长（自持重复风暴的闸门）`,
    Number(after) - Number(at) === 0, "1 秒内增量 0", `又涨了 ${Number(after) - Number(at)}`);
  return { at, after };
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    // 缺件必须红，不能"少一条 ✅"就当过了（§十）
    check("环境：找得到可用浏览器（GOSSLAN_CHROME / playwright 缓存 / 系统 Chromium 系）", false,
      "一个起得来的 Chromium 系浏览器", "三档都没有（或缓存那台装坏了且系统无同类）—— 这一格就没跑");
    console.log("\n✗ UI 运行时探针：环境缺件，判红（不是跳过）");
    process.exit(1);
  }
  console.log(`· 浏览器：${chrome}`);
  console.log(`· 来源：${BROWSER_SOURCE}`);
  const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    check("环境：仓里有 vite 可执行（node_modules/vite/bin/vite.js）", false, "存在", "不存在");
    process.exit(1);
  }
  // 前置拒收（2026-10-10 加）：端口被**上次中断留下的那台**占着时，这一层会连到几小时前起的实例上
  // —— 它带着旧构建、旧 profile，判据照样打绿。那是假绿通道，必须起跑前挡掉而不是"换个端口接着跑"。
  // 本机实测过一次：9444 上那台 CfT（09:56 起、被中断）仍挂着 type=page 指向 5199 上那个旧 vite。
  for (const [label, port] of [["dev server", VITE_PORT], ["CDP", CDP_PORT]]) {
    if (await portListening(port)) {
      check(`环境：${label} 端口 ${port} 起跑前空闲`, false, "无人监听", "已被占用");
      console.log(`· 谁在占：lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      console.log("· 为什么是红而不是接着跑：那台是上次被 Ctrl-C/杀掉留下的（profile 在 /tmp/gosslan-probe-*），");
      console.log("  连上去读的是**旧构建**；要么把它清掉，要么换 GOSSLAN_PROBE_PORT / GOSSLAN_PROBE_CDP 另开一台。");
      console.log("\n✗ UI 运行时探针：端口被残留实例占用，判红（不是跳过）");
      process.exit(1);
    }
  }
  const vite = spawn(process.execPath, [viteBin, "dev", "--port", String(VITE_PORT), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-probe-"));
  const chromeProc = (() => {
    /**
     * 宿主环境的 Chromium sandbox 初始化失败（实测本机 2026-10-21）：
     * `Failed to initialize sandbox: Operation not permitted` → GPU 进程 exit_code=6 →
     * FATAL "GPU process isn't usable" → 进程 **SIGTRAP**（Brave 与 Chrome for Testing 同症状）。
     * 实测只有 `--no-sandbox` 能让 **renderer** 真的跑起来：
     *   · `--disable-gpu-sandbox`：浏览器进程能起、CDP /json/version 有答，但 `Runtime.enable` 45s 不回包；
     *   · `--no-sandbox`：`Runtime.enable` 4ms，`Runtime.evaluate("1+1")` 返回 2。
     * 默认**不开**（CI / 普通开发机保持原行为与原有隔离级别），
     * 由 `GOSSLAN_PROBE_NO_SANDBOX=1` 显式选择，并把实际参数打进日志便于追溯。
     */
    const noSandbox = process.env.GOSSLAN_PROBE_NO_SANDBOX === "1";
    if (noSandbox) console.log("· 启动参数：--no-sandbox（GOSSLAN_PROBE_NO_SANDBOX=1；宿主 sandbox 初始化失败时用）");
    const p = spawn(chrome, [
      "--headless=new",
      ...(noSandbox ? ["--no-sandbox"] : []),
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
    ], { stdio: "ignore" });
    return p;
  })();
  /** 进程结局要留痕：「并入已存在实例」那种起不来，唯一现场证据就是它当场退掉。 */
  const procState = { exited: null, pid: chromeProc.pid };
  chromeProc.on("exit", (code, signal) => { procState.exited = { code, signal }; });
  let exitCode = 0;
  try {
    const url = await waitForVite(vite);
    console.log(`· dev server：${url}`);
    const cdpBudgetMs = Number(process.env.GOSSLAN_PROBE_CDP_WAIT_MS || 20_000);
    let wsUrl = null;
    let lastErr = "还没试过";
    const deadline = Date.now() + cdpBudgetMs;
    while (Date.now() < deadline && !wsUrl) {
      if (procState.exited) { lastErr = "我起的那个浏览器进程已经退出，继续等只是静默卡住"; break; }
      await sleep(250);
      try {
        const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const list = await r.json();
        wsUrl = (list.find((t) => t.type === "page") || {}).webSocketDebuggerUrl ?? null;
        if (!wsUrl) lastErr = "/json/list 有响应，但里面没有 type=page 的 target";
      } catch (e) {
        lastErr = `取 /json/list 失败：${e && e.message || e}`;
      }
    }
    if (!wsUrl) {
      const diag = await cdpDiagnostics(chrome, CDP_PORT, procState, lastErr, cdpBudgetMs);
      console.log("\n· CDP 起不来，这台机器问得出的读数如下：");
      for (const l of diag) console.log(`    · ${l}`);
      check("环境：CDP 在预算内给出 page target", false, `${CDP_PORT} 上有 type=page 的 target`,
        diag.join("；").slice(0, 300));
      throw new Error("CDP 起不来 ⇒ 这一格**没跑**，不是产品红（归因读数已打在上面那几行）");
    }
    // 引擎版本进门禁日志：换浏览器导致的读数变化要能在日志里自证用的是哪一台
    const ver = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      .then((r) => r.json()).catch(() => null);
    console.log(`· 引擎：${ver?.Browser ?? "问不出（/json/version 没答）"}`
      + `｜协议：${ver?.["Protocol-Version"] ?? "?"}｜来源：${BROWSER_SOURCE}`);
    const cdp = await Cdp.connect(wsUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    // 冷启动要等 vite 现编译依赖，实测 20~30s（等短了会把"还没起来"读成"组件坏了"）
    await sleep(4_000);
    for (let i = 0; i < 40; i += 1) {
      const ready = await cdp.eval(`(() => {
        const el = document.querySelector('#app');
        return !!(el && (el.children.length > 0 || document.body.innerText.length > 0));
      })()`);
      if (ready) break;
      await sleep(1_000);
    }
    await cdp.eval(PAGE_FIXTURE);

    // `--only=roster` 跑一段，`--only=reaction,roster` 跑**相邻几段** —— 用来把
    // "单独跑是绿的、整段顺序跑是红的"这类串味红二分出到底是谁污染了谁。
    const want = (name) => !ONLY || ONLY.split(",").includes(name);
    const emoji = want("emoji");
    const search = want("search");
    const ctxmenu = want("ctxmenu");
    const todopick = want("todopick");
    const sw = want("switch");
    const seg = want("segmented");
    const slider = want("slider");
    const files = want("files");
    const share = want("share");
    const lightbox = want("lightbox");
    const toast = want("toast");
    const select = want("select");
    const task = want("task");
    const tasksrt = want("tasksrt");
    const accent = want("accent");
    const convbadge = want("convbadge");
    const caption = want("caption");
    const reaction = want("reaction");
    const roster = want("roster");
    const overlay = want("overlay");
    const imgskel = want("imgskel");
    const imgload = want("imgload");
    const pinkb = want("pinkb");
    const inputpanel = want("inputpanel");
    const winsafe = want("winsafe");
    const logs = want("logs");
    const vlist = want("vlist");
    const favorites = want("favorites");
    const links = want("links");
    const diag = want("diag");
    const updater = want("updater");
    const avatar = want("avatar");
    const fontsel = want("fontsel");
    const layoutstore = want("layoutstore");
    const settingsmobile = want("settingsmobile");
    const netcard = want("netcard");
    const composermobile = want("composermobile");
    const tasksmobile = want("tasksmobile");
    const opscenter = want("opscenter");
    const resend = want("resend");
    const touchroster = want("touchroster");
    const locale = want("locale");
    const rowpair = want("rowpair");
    const msgovf = want("msgovf");
    const ctxguard = want("ctxguard");
    const pasteframe = want("pasteframe");
    const errtext = want("errtext");
    const namecap = want("namecap");
    const friendfilter = want("friendfilter");
    const forwardfilter = want("forwardfilter");
    const contactfilter = want("contactfilter");
    const navicon = want("navicon");
    const menufit = want("menufit");
    if (emoji) await runEmoji(cdp, url);
    if (search) await runSearch(cdp, url);
    if (ctxmenu) await runCtxMenu(cdp, url);
    if (todopick) await runTodoPick(cdp, url);
    if (sw) await runSwitch(cdp, url);
    if (seg) await runSegmented(cdp, url);
    if (slider) await runSlider(cdp, url);
    if (files) await runGroupFiles(cdp, url);
    if (share) await runShareDirectory(cdp, url);
    if (lightbox) await runLightbox(cdp, url);
    if (toast) await runToast(cdp, url);
    if (select) await runSelect(cdp, url);
    if (task) await runTaskCard(cdp, url);
    if (tasksrt) await runTasksRealtime(cdp, url);
    if (accent) await runAccent(cdp, url);
    if (convbadge) await runConvBadge(cdp, url);
    if (caption) await runCaption(cdp, url);
    if (want("imecommit")) await runImeCommit(cdp, url);
    if (reaction) await runReaction(cdp, url);
    if (roster) await runReactionRoster(cdp, url);
    if (overlay) await runOverlay(cdp, url);
    if (imgskel) await runImageSkeleton(cdp, url);
    if (imgload) await runImageLoad(cdp, url);
    if (pinkb) await runPinKeyboard(cdp, url);
    if (inputpanel) await runInputPanels(cdp, url);
    if (winsafe) await runWindowSafe(cdp, url);
    if (logs) await runLogs(cdp, url);
    if (vlist) await runVirtualList(cdp, url);
    if (favorites) await runFavorites(cdp, url);
    if (namecap) await runNameCap(cdp, url);
    if (friendfilter) await runFriendFilter(cdp, url);
    if (forwardfilter) await runForwardFilter(cdp, url);
    if (contactfilter) await runContactFilter(cdp, url);
    if (navicon) await runNavIcon(cdp, url);
    if (menufit) await runMenuFit(cdp, url);
    if (diag) await runDiag(cdp, url);
    if (updater) await runUpdater(cdp, url);
    if (avatar) await runAvatar(cdp, url);
    if (links) await runLinks(cdp, url);
    if (fontsel) await runFontSelect(cdp, url);
    if (layoutstore) await runLayoutStore(cdp, url);
    if (settingsmobile) await runSettingsMobile(cdp, url);
    if (netcard) await runNetCard(cdp, url);
    if (composermobile) await runComposerMobile(cdp, url);
    if (tasksmobile) await runTasksMobile(cdp, url);
    if (opscenter) await runOpsCenter(cdp, url);
    if (resend) await runResend(cdp, url);
    if (locale) await runLocale(cdp, url);
    if (rowpair) await runRowPair(cdp, url);
    if (msgovf) await runMsgOverflow(cdp, url);
    if (ctxguard) await runContextGuard(cdp, url);
    if (pasteframe) await runPasteFrame(cdp, url);
    if (errtext) await runErrorText(cdp, url);
    if (touchroster) await runTouchRoster(cdp, url);
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
    exitCode = process.exitCode;
  } catch (e) {
    check("探针自己跑完了（没在半路抛错）", false, "正常结束", String(e && e.message || e).slice(0, 1200));
    exitCode = 1;
  } finally {
    const tally = results.filter((r) => r.ok).length;
    console.log(`\n${exitCode === 0 ? "✅" : "✗"} UI 运行时探针：${tally}/${results.length} 条判据绿`
      + (SELF_CHECK ? "（这一段是反面对照：判据**必须**报红）" : ""));
    vite.kill("SIGTERM");
    chromeProc.kill("SIGTERM");
    await sleep(500);
    // 收尾要把端口**真的**让出来：饱和的 renderer 拆除很慢，端口还占着会把下一趟顶成上面那条前置红
    // —— 2026-10-10 实测到连着三趟被自己上一趟留下的 CfT 挡住（那时页面正以 ~550 次/秒跑 click）。
    // 有界等，最多 10 s；等不到就打印读数，让下一个人知道这是谁的残留。
    let settleMs = 500;
    const busy = async () => (await portListening(VITE_PORT)) || (await portListening(CDP_PORT));
    let stillBusy = await busy();
    for (let i = 0; i < 19 && stillBusy; i += 1) {
      await sleep(500);
      settleMs += 500;
      stillBusy = await busy();
    }
    // ★ SIGTERM 治不了"renderer 已经不响应"那一档，而那恰恰是卡死那趟的形状：
    //   2026-10-20 两次全量跑都走完这段收尾、端口到 10 s 上限**仍被占着**（现读日志那行
    //   "到点仍被占着"），于是下一趟一定红在"环境：CDP 端口 9444 起跑前空闲"。
    //   那看起来像护栏坏，其实是上一趟的残留 ⇒ 一趟红会连累下一趟，归因时被当成新缺陷查。
    //   所以等不到就强制：SIGKILL 父进程（9444 那个监听 socket 在它手里），再短等一轮。
    if (stillBusy) {
      vite.kill("SIGKILL");
      chromeProc.kill("SIGKILL");
      for (let i = 0; i < 12 && stillBusy; i += 1) {
        await sleep(500);
        settleMs += 500;
        stillBusy = await busy();
      }
    }
    if (settleMs > 500) {
      console.log(`· 端口让位耗时 ${settleMs} ms`
        + (stillBusy
          ? ` —— 到点仍被占着，下一趟会红（这是本趟的残留；谁在占：lsof -nP -iTCP:${CDP_PORT} -sTCP:LISTEN）`
          : " ⇒ 已让位（SIGTERM 没解决，SIGKILL 之后才空的）"));
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 交给系统 */ }
    process.exit(exitCode);
  }
}

/**
 * 那颗「添加表情回复」入口的几何（用户 2026-09-30：「按钮位置在视觉观感上应该与聊天内容最下边对齐。
 * 按钮再紧凑一些，现在有点大」）。
 * 为什么这段值得真悬停一次：入口是 `hidden group-hover/msg:flex` —— 不悬停时它**不在布局里**，
 * 任何静态读法都量不到尺寸与底边；而"跟气泡底边对齐"恰恰只能量出来。
 */
async function runReaction(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const MSG = {
    msg_id: "m-react-probe-1", sender_id: "dev-me", kind: "text",
    // 刻意用一条会折成多行的长内容：单行时那一列本来就矮，"中线居中"与"贴底"只差 2~3px，
    // 那条对照就变成没判（第一版就是这么红的）。用户那句观感意见针对的正是多行消息。
    content: "这条要量那颗表情入口的底边对齐，所以写得长一点，让它折成好几行：一、二、三、四、五、六、七、八、九、十，后面再补一些字让宽度确实放不下。",
    ts: 1700000000000, conv_id: "group:g1", seq: 1,
  };
  const mounted = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
    + JSON.stringify(JSON.stringify({
      message: MSG, canReact: true, isGroup: true, senderName: "测试者",
      groupReaderIds: ["r-1"],
    })) + ")");
  check("消息行挂出来了（表情入口那颗才有得量）", !!mounted && mounted.ok === true,
    "install ok", JSON.stringify(mounted));
  // 这条消息要判成「我发的」：回执与回应入口都在气泡左外侧，只有 mine 时才会同框。
  const seeded = await cdp.eval("window.__probe.seedDevice('dev-me')");
  await sleep(250);
  check("夹具设备 = dev-me（mine 成立，回执才会挂出来）",
    !!seeded && seeded.ok === true && seeded.at === "dev-me", "device=dev-me", JSON.stringify(seeded));
  // 读数期间冻掉那颗入口的 transition（headless 的动画时钟不推帧 ⇒ opacity 会停在起点，见 helper 注释）
  const frozen = await cdp.eval("window.__probe.freezeReactionTransition()");
  check("冻掉了那颗入口的过渡（否则整段跑时读到的 opacity 是动画起点）",
    frozen === true, "freezeReactionTransition 返回 true", JSON.stringify(frozen));

  const hidden = await cdp.eval("window.__probe.reactionBtn()");
  check("不悬停时那颗入口**看不见、点不着，但仍在布局里**（N19 换法后的形状：opacity 藏而非 display 藏）",
    hidden.ok === true && hidden.display !== "none" && Number(hidden.opacity) === 0
      && hidden.pointerEvents === "none" && hidden.h > 0,
    "display!=none 且 opacity=0 且 pointer-events=none 且 h>0", JSON.stringify(hidden));

  const col = await cdp.eval("window.__probe.colRect()");
  check("那一列有可悬停的面积（拿不到矩形就没法移指针）", !!col && col.bottom > 0, "colRect 非空", JSON.stringify(col));
  await cdp.hover(col.x, col.y);
  // 等一次样式重算落定（:hover 只在浏览器真的移动过指针后才成立）；
  // 动画已在段首冻掉，所以这里读到的一定是级联规则的目标值，容差只留浮点误差。
  await sleep(350);

  const a = await cdp.eval("window.__probe.reactionBtn()");
  check("悬停后入口显形并可点（opacity 1 + pointer-events auto），且是紧凑的正方形小按钮（高=宽，且不大于 28px）",
    a.ok === true && Number(a.opacity) >= 0.99 && a.pointerEvents === "auto" && a.h > 0 && a.h === a.w && a.h <= 28,
    "opacity=1 且 pointer-events=auto 且 h===w 且 h<=28", JSON.stringify(a));
  check("入口底边与气泡那一列的底边对齐（用户那句「与聊天内容最下边对齐」）",
    a.ok === true && a.colBottom !== null && Math.abs(a.bottom - a.colBottom) <= 1,
    "|btn.bottom - col.bottom| <= 1", "btn=" + a.bottom + " col=" + a.colBottom);
  check("触屏热区没被这次收窄弄丢（tap-safe 仍在：h-6 靠它扩到 40px）",
    a.ok === true && a.tapSafe === true, "class 里有 tap-safe", JSON.stringify(a));

  // 群消息自己的回执（左侧头像）与「添加回应」入口都挂在气泡左外侧：
  // 悬停显形后若后者盖住前者，用户点「谁读了」会开成表情面板。量矩形 + 命中测试，不靠肉眼。
  const geom = await cdp.eval(`(() => {
    const receipt = document.querySelector('button.-space-x-1');
    const entry = document.querySelector('[data-reaction-entry]');
    if (!receipt || !entry) return { ok: false, hasReceipt: !!receipt, hasEntry: !!entry };
    const rr = receipt.getBoundingClientRect();
    const er = entry.getBoundingClientRect();
    const cx = rr.left + rr.width / 2;
    const cy = rr.top + rr.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return {
      ok: true,
      overlap: !(rr.right <= er.left || rr.left >= er.right || rr.bottom <= er.top || rr.top >= er.bottom),
      receiptHit: !!(top && (receipt === top || receipt.contains(top))),
      entryHit: !!(top && entry.contains(top)),
      topTag: top ? top.tagName + '.' + String(top.className || '').slice(0, 36) : null,
      rr: { l: +rr.left.toFixed(1), r: +rr.right.toFixed(1), t: +rr.top.toFixed(1), b: +rr.bottom.toFixed(1) },
      er: { l: +er.left.toFixed(1), r: +er.right.toFixed(1), t: +er.top.toFixed(1), b: +er.bottom.toFixed(1) },
    };
  })()`);
  check("群消息：回执入口与回应入口不抢命中区（悬停时点回执中心必须命中回执）",
    geom.ok === true && geom.overlap === false && geom.receiptHit === true && geom.entryHit === false,
    "两矩形不重叠且回执中心命中回执", JSON.stringify(geom));

  // tooltip / 可访问名：换成自己那句"添加表情回复"，不再是借输入框那颗的「表情」。
  const names = await cdp.eval(`(async () => {
    const i = await import('/src/i18n');
    return { own: i.t('msg.reactionAddEntry'), composer: i.t('chat.composer.emoji') };
  })()`);
  check("它的 title 与 aria-label 都是「添加表情回复」那句（不是借输入框那颗的文案）",
    !!a.title && a.title === names.own && a.aria === names.own && names.own !== names.composer,
    names.own, "title=" + a.title + " aria=" + a.aria + " 而输入框那颗=" + names.composer);

  // 反面对照：按回旧的"中线居中"写法 ⇒ 底边对齐差必须变大（不然上面那句就是恒真）。
  await cdp.eval("window.__probe.forceLegacyReaction(true)");
  const b = await cdp.eval("window.__probe.reactionBtn()");
  check("对照：改回旧的中线居中 ⇒ 多行气泡上底边就飘起来（证明那条对齐判据会咬）",
    // 阈值不是拍一个数：正向那格用的容差是 ±1px，这里要求**至少飘出容差的 4 倍**（实测 13px，
    // 那一列多高就飘多少 —— 写死 24 是我第一次的猜测，它在两行气泡上根本不成立，红得没道理）。
    b.ok === true && Math.abs(b.bottom - b.colBottom) > 4,
    "|差| > 4（正向那格容差 ±1 的 4 倍）",
    "btn=" + b.bottom + " col=" + b.colBottom + " 差=" + Math.abs(b.bottom - b.colBottom));
  await cdp.eval("window.__probe.forceLegacyReaction(false)");
  const c = await cdp.eval("window.__probe.reactionBtn()");
  check("对照可逆：恢复后底边又对齐（不是把页面改坏了一次）",
    c.ok === true && Math.abs(c.bottom - c.colBottom) <= 1, "|差| <= 1",
    "btn=" + c.bottom + " col=" + c.colBottom);

  // ---------- N19：键盘必须能到达、也能激活那颗"悬停才现"的入口 ----------
  // 为什么这一段非量不可：换法的**全部意义**就是"看不见但 Tab 得到"，
  // 而静态判据（designGuards ①/⑥）只能证明写法，证不了浏览器真把焦点给了它、
  // 也证不了 `.kb-reveal:focus-visible` 那条 CSS 真的落到了这个元素上。
  // 焦点模拟只在这一块开、出去就关（同 roster 那一段的规矩：emoji 段的 Enter 断言要靠"页面没焦点"）。
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.bringToFront").catch(() => {});
  try {
    await cdp.eval("(() => { const b = document.querySelector('[data-reaction-entry]');"
      + " if (b) b.blur(); document.body.focus && document.body.blur(); })()");
    let reached = null;
    const stops = [];
    for (let i = 0; i < 12 && !reached; i += 1) {
      await cdp.key("Tab", "Tab", "", 9);
      const r = await cdp.eval("window.__probe.reactionBtn()");
      stops.push(r && r.ok === true ? r.focused : null);
      if (r && r.ok === true && r.focused === true) reached = r;
    }
    check("N19 键盘入口：连按 Tab 焦点落得进那颗「添加表情回复」（旧写法 display:none 时这一步必然失败）",
      !!reached, "某次 Tab 后 activeElement === 那颗入口", JSON.stringify(stops));
    check("N19 键盘入口：聚焦后它自己显形（opacity 1）—— 键盘用户看得见自己正站在哪",
      !!reached && Number(reached.opacity) >= 0.99 && reached.pointerEvents === "auto",
      "opacity=1 且 pointer-events=auto", JSON.stringify(reached));

    // 真按键回车 = 真的把选择器打开（这才是"能用键盘完成这件事"，而不是"能聚焦"）
    // ★ Enter 必须带 text "\r"：本仓的 cdp.key 只有给了 text 才补发 char 那条，
    // 而 button 的「回车激活」走的是 char —— 只发 rawKeyDown+keyUp 时焦点在按钮上也不会有 click
    //（第一次跑就是这么红的，红的是按键夹具不是产品）。
    // ★ 这一发回车由 keyOnce 背书：只许激活一次，且空等 1 秒不许继续增长
    //（表情选择器是 toggle ⇒ 自持重复会把读数变成掷硬币，见 keyOnce 上面那段）。
    await keyOnce(cdp, "N19 回车（表情入口）", () => cdp.key("Enter", "Enter", "\r", 13));
    const opened = await cdp.eval("!!document.querySelector('[data-reaction-picker]')");
    check("N19 键盘入口：聚焦后按回车真打开了表情选择器",
      opened === true, "data-reaction-picker 出现", "opened=" + JSON.stringify(opened));
    // 面板是 teleport 到 body 的 ⇒ 焦点不在入口上了，靠 kb-reveal-on 保持显形（否则浮层开着入口却消失）
    const still = await cdp.eval("window.__probe.reactionBtn()");
    check("N19 对照：选择器开着时入口仍显形（kb-reveal-on 那条真的接上了，不是只写了 CSS）",
      opened === true && still.ok === true && Number(still.opacity) >= 0.99,
      "选择器真开着 且 入口 opacity 仍为 1", "opened=" + opened + " " + JSON.stringify(still));

    // ★ 单点变异（证明上面那两条 Tab 判据不是恒真）：把元素按回**旧那一族**的 display:none。
    // 旧的写法就是这样把可聚焦性一起删掉的 ⇒ 焦点必须再也落不进那颗入口。改完立刻复原（可逆）。
    await cdp.eval("(() => { const b = document.querySelector('[data-reaction-entry]');"
      + " if (b) { b.blur(); b.style.display = 'none'; } })()");
    let legacyReached = false;
    for (let i = 0; i < 12 && !legacyReached; i += 1) {
      await cdp.key("Tab", "Tab", "", 9);
      const r = await cdp.eval("window.__probe.reactionBtn()");
      if (r && r.ok === true && r.focused === true) legacyReached = true;
    }
    check("N19 变异对照：把入口按回 display:none ⇒ Tab 就再也落不进去（证明那条键盘判据会咬）",
      legacyReached === false, "十二次 Tab 都没聚焦到它", "legacyReached=" + legacyReached);
    await cdp.eval("(() => { const b = document.querySelector('[data-reaction-entry]');"
      + " if (b) b.style.display = ''; })()");
    const restored = await cdp.eval("window.__probe.reactionBtn()");
    check("N19 变异可逆：撤掉那条内联 display 后它又回到布局里（没把页面改坏一次）",
      restored.ok === true && restored.display !== "none" && restored.h > 0,
      "display!=none 且 h>0", JSON.stringify(restored));
  } finally {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}


/**
 * 置顶条那颗「取消置顶」的键盘入口（roadmap N19 没量到的那一半）。
 *
 * 为什么单独一段：表情入口那颗已经证过 `.kb-reveal` 在真浏览器里可 Tab 到达、可回车激活，
 * 但那证的是**机制**；ChatWindow 这一段是**生产里另一个使用者**（它还是从"嵌在 button 里的
 * span role=button"改过来的），机制对不代表这段接对了 ⇒ 必须真挂 ChatWindow 量。
 *
 * ⚠️ 唯一的替身是 transport 边界那一条：`api.pinGroupMessage` 被换成"立刻回一份 pin 记录"。
 * 换它不等于让判据变绿——真投递本来就不在这格的判据里（那是双实例 E2E 的 `--round=group`）。
 * 替身之后的每一步（store 的 enqueueMessage → foldPinned 折叠 → 置顶条重渲染）都是生产码，
 * 所以"回车之后那一条真的从置顶条上消失了"是界面链路走通的证据。
 */
async function runPinKeyboard(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const mounted = await cdp.eval("window.__probe.install('/src/components/ChatWindow.vue', '', '{}')");
  check("ChatWindow 挂得起来（置顶条才有得量；挂不起来这一整段就只能记未量）",
    !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));

  const seeded = await cdp.eval(`(async () => {
    const { api } = await import('/src/api/index.ts');
    const { useChatStore } = await import('/src/stores/useChatStore.ts');
    const chat = useChatStore();
    chat.activeConv = 'group:kb1';
    const base = { conv_id: 'group:kb1', sender_id: 'p1', sender_name: '小布', ts: 1700000000000 };
    chat.enqueueMessage(Object.assign({}, base, { msg_id: 'm-kb-1', kind: 'text', content: '这条被置顶了', seq: 1 }));
    chat.enqueueMessage(Object.assign({}, base, { msg_id: 'pin-kb-1', kind: 'pin',
      content: JSON.stringify({ target: 'm-kb-1', pinned: true }), seq: 2 }));
    // 替身：只换这一条命令，返回一份形状正确的"取消置顶"记录（字段口径同 pins.ts 的 parsePin）
    api.pinGroupMessage = (groupId, target, pinned) => Promise.resolve({
      msg_id: 'pin-kb-2', conv_id: 'group:kb1', sender_id: 'dev-me', sender_name: '我',
      kind: 'pin', content: JSON.stringify({ target, pinned }), seq: 3, ts: 1700000001000,
    });
    await new Promise((r) => setTimeout(r, 250));
    // 读数前把那颗 ✕ 的过渡冻掉：.kb-reveal 的显形带 transition，headless 的动画时钟不推帧时
    // getComputedStyle 会读到中间值（这一段第一次跑就读到 0.967863 ⇒ 红的是读数时机不是产品）。
    // 这里判的是"聚焦那条级联规则落到没落到元素上"，动画本身另有判据（overlay 段 E 组）。
    for (const b of document.querySelectorAll('[data-pin-unpin]')) b.style.transition = "none";
    const bar = document.querySelectorAll('[data-pin-unpin]').length;
    const frozen = Array.from(document.querySelectorAll('[data-pin-unpin]'))
      .filter((b) => b.style.transition === "none").length;
    return { rows: (chat.messages['group:kb1'] || []).length, unpinButtons: bar, frozen };
  })()`);
  check("置顶条挂出了一颗「取消置顶」（现读 DOM 里有几个 ✕，且它的过渡已被冻住）",
    !!seeded && seeded.rows === 2 && seeded.unpinButtons === 1 && seeded.frozen === 1,
    "2 行消息 / 1 颗 ✕ / 1 颗已冻过渡", JSON.stringify(seeded));

  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.bringToFront").catch(() => {});
  try {
    let reached = null;
    const stops = [];
    for (let i = 0; i < 25 && !reached; i += 1) {
      await cdp.key("Tab", "Tab", "", 9);
      const r = await cdp.eval(`(() => {
        const b = document.querySelector('[data-pin-unpin]');
        if (!b) return { ok: false };
        const cs = getComputedStyle(b);
        return { ok: true, focused: document.activeElement === b,
                 opacity: cs.opacity, pointerEvents: cs.pointerEvents,
                 tag: b.tagName, aria: b.getAttribute('aria-label') };
      })()`);
      stops.push(r && r.ok ? r.focused : null);
      if (r && r.ok && r.focused === true) reached = r;
    }
    check("N19：连按 Tab 焦点落得进那颗「取消置顶」（旧写法是无 tabindex 的 span，落不进去）",
      !!reached && reached.tag === "BUTTON" && !!reached.aria,
      "activeElement 是那颗带 aria-label 的 BUTTON", JSON.stringify([stops.length, reached]));
    check("N19：聚焦后它自己显形（过渡已冻 ⇒ opacity 是目标值 1，且 pointer-events 开了）",
      !!reached && Number(reached.opacity) >= 0.99 && reached.pointerEvents === "auto",
      "opacity>=0.99 且 pointer-events=auto", JSON.stringify(reached));

    // 这一发也由 keyOnce 背书：以前只判"那条从置顶条上消失了"，而那**对重复不敏感**
    //（撤完置顶那颗 ✕ 就没了，后续重复没有作用对象）⇒ 现在把"只激活一次"本身量出来。
    await keyOnce(cdp, "N19 回车（取消置顶）", () => cdp.key("Enter", "Enter", "\r", 13));
    const after = await cdp.eval(`document.querySelectorAll('[data-pin-unpin]').length`);
    check("N19：回车真的走到了处理器并回到界面（那条从置顶条上消失，剩 0 颗 ✕）",
      after === 0, "✕ 数从 1 变 0", "现读 " + after);

    // ★ 单点变异（可逆）：再挂一次置顶条，把那颗 ✕ 按回**旧那一族的藏法**（display:none，
    // 也就是 N19 之前 `hidden` / 无 tabindex 的 span 达到的效果）⇒ 焦点必须再也落不进去。
    // 没有这一条，上面那两条 Tab 判据可能是恒真的（这一段判的是"键盘到得到"，不是"DOM 里有几个按钮"）。
    const reseed = await cdp.eval(`(async () => {
      const { useChatStore } = await import('/src/stores/useChatStore.ts');
      const chat = useChatStore();
      chat.enqueueMessage({
        msg_id: 'pin-kb-3', conv_id: 'group:kb1', sender_id: 'p1', sender_name: '小布',
        kind: 'pin', content: JSON.stringify({ target: 'm-kb-1', pinned: true }),
        seq: 4, ts: 1700000002000,
      });
      await new Promise((r) => setTimeout(r, 250));
      const b = document.querySelector('[data-pin-unpin]');
      if (!b) return { ok: false };
      b.style.display = 'none';
      return { ok: true, back: document.querySelectorAll('[data-pin-unpin]').length };
    })()`);
    check("变异前置：重新置顶回来、那颗 ✕ 又被按回 display:none（旧那一族的藏法）",
      reseed && reseed.ok === true && reseed.back === 1, "1 颗 ✕ 且 display 已置 none",
      JSON.stringify(reseed));
    let legacyHit = false;
    for (let i = 0; i < 25 && !legacyHit; i += 1) {
      await cdp.key("Tab", "Tab", "", 9);
      legacyHit = await cdp.eval(`(() => {
        const b = document.querySelector('[data-pin-unpin]');
        return !!b && document.activeElement === b;
      })()`);
    }
    check("N19 变异对照：藏法改回 display:none ⇒ Tab 再也落不进去（证明那条键盘判据会咬）",
      legacyHit === false, "二十五次 Tab 都没聚焦到它", "legacyHit=" + legacyHit);
    await cdp.eval(`(() => {
      const b = document.querySelector('[data-pin-unpin]');
      if (b) b.style.display = '';
    })()`);
    const undone = await cdp.eval(`(() => {
      const b = document.querySelector('[data-pin-unpin]');
      if (!b) return { ok: false };
      const r = b.getBoundingClientRect();
      return { ok: true, display: getComputedStyle(b).display, h: Math.round(r.height) };
    })()`);
    check("N19 变异可逆：撤掉那条内联 display 后它又回到布局里（没把页面改坏一次）",
      undone.ok === true && undone.display !== "none" && undone.h > 0,
      "display!=none 且 h>0", JSON.stringify(undone));
  } finally {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

/**
 * 图片骨架的占位高度（roadmap N22 那一格的落点：骨架预留 == 估算端那个常量）。
 *
 * 为什么必须真浏览器量：这一格判的是**渲染出来的矩形高度**，静态 class 判据只能证明
 * "组件引了常量"，证不了那个数最后落到盒子上（内联样式被别的规则盖掉、或者组件根本没挂起来）。
 *
 * 夹具：src 给一条 dev server 上不存在的路径，eager <img> 会自己拿到 404、自己走完退避；
 * 探针另外按节奏代投 error，把"落 failed"的时间收在有界窗口里。
 * ⚠️ 两个"试过但不对"的写法都留在这里，免得下一个人再试一次：
 *   ① "内容永不完成的 blob"——URL.createObjectURL 直接抛 overload 错（本仓探针第一次跑就是这么红的，
 *      红的是夹具不是产品）；② 早期这张 <img> 带 loading="lazy"，而它在 @load 之前 display:none
 *      ⇒ 懒加载图永不发请求，退避链第一步都迈不出去（v4.35.2 图片全打不开的真根因，见
 *      MessageImageBubble.vue 里 img-eager-ok 注释；正向回归在 --only=imgload 那段）。
 * loading 态读的是挂载即得的那个预留（state 初值就是 loading），failed 态由 error（自然 404 +
 * 代投）走满 5 档退避得到 —— 打的仍是组件自己那个 @error 处理器，顺带把"全部重试失败才落 failed"
 * （用户 2026-09-12：『加载失败应该是不可逆的最终结果』）在真浏览器里走了一遍。
 */
/**
 * 窗口显示安全区那一段（--only=winsafe）。
 *
 * 用户 2026-10-12 报的两件事里，第二件是"卡片弹窗顶部被自绘窗口标题栏（caption）压住"，
 * 并明写要求「**窗口头部不是可显示区域，所有窗口统一做好显示安全区**」。
 *
 * 为什么必须有运行时这一半：静态判据（designGuards ㊱）只能证"源码里读了
 * `var(--gosslan-window-safe-top)`"，证不了三件真事：
 *   ① CSS 变量在这个文档里**真的算出了非零值**（写了没生效是 N7 那一课）；
 *   ② 读完变量之后**卡片的真实矩形**确实落在 caption 底边之下；
 *   ③ 矮视口 + 长内容时卡片底边仍留在可视区内（顶部让开却不能把底部挤出去）。
 * 三条都读真几何（getBoundingClientRect + getComputedStyle），不读类名。
 *
 * ⚠️ 口径边界（报结论必须带上）：这里在**浏览器**里合成 TitleBar + BaseModal 卡片形态，
 * 量的是布局与 CSS 变量；真机上 Win 的 38px caption 与常显滚动条、macOS 的 28px overlay
 * 仍属人工（Smoke-11）。移动端那一档只证"变量为 0 ⇒ 卡片顶边不被额外推下"。
 */
async function runWindowSafe(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.install('/src/components/TitleBar.vue', '', '')");

  // ── 桌面 + 长内容（用户报的那个形状）──────────────────────────────
  const comp = await cdp.eval('window.__probe.composeModalStack({ long: true })');
  // Reka 的出入场动画挂在 DialogContent 自身（Presence 只观察那个元素）⇒ 入场那 200ms 里
  // 整块内容层都在 scale(0.95)，读到的 top/height 是缩放后的矩形。布局判据要的是落定态。
  await sleep(500);
  check("桌面：TitleBar 与 BaseModal 卡片真的同时挂在页面上",
    !!comp && comp.ok === true, "composeModalStack ok", JSON.stringify(comp));

  const a = await cdp.eval("window.__probe.modalStackRead()");
  check("安全区变量在桌面算出非零值（写了没用 = 没写）",
    a.ok === true && a.safeTop !== "" && a.safeTop !== "0px",
    "safeTop 非 0px", JSON.stringify({ safeTop: a.safeTop }));
  check("caption 真的渲染出来了（否则下一条的让位判据没有作用点）",
    a.ok === true && a.hasCaption === true, "hasCaption=true", JSON.stringify(a));
  check("卡片顶边落在 caption 底边之下（不再被标题栏压住）",
    a.ok === true && a.cardBelowCaption === true,
    "cardTop >= capBottom", JSON.stringify({ cardTop: a.cardTop, capBottom: a.capBottom }));
  check("长内容 + 矮视口：卡片底边仍留在可视区内",
    a.ok === true && a.cardFitsBottom === true,
    "cardBottom <= innerHeight", JSON.stringify({ cardBottom: a.cardBottom, innerHeight: a.innerHeight }));

  // 反面对照：把变量按回"修之前"（0）⇒ 卡片必须又能跑到 caption 底下那一带。
  // ⚠️ 对照必须让卡片**真的顶到视口上沿**才说明问题：卡片是 `my-auto` 居中的，
  // 内容不高时它本来就停在视口中间 —— 那种情况下"cardTop >= capBottom"恒真，
  // 对照也就没有判别力（第一版实测 cardTop=148 而 capBottom=28，看着像通过，其实什么都没证）。
  // ⇒ 先把内容撑到超过视口高度（卡片顶到 max-h 上限、`my-auto` 把顶边推到安全区那条线），
  //   再看撤掉安全区之后顶边是否真的上移到 caption 底下。
  await cdp.eval("window.__probe.forceModalTall(true)");
  await sleep(300); // 内容高度变了：等一次布局/RO 落定，别在半帧上读几何
  const tallRead = await cdp.eval("window.__probe.modalStackRead()");
  // 前置判据：卡片必须**真的**被撑到 max-h 上限（panelH 明显大于短内容那一档），
  // 否则"my-auto 居中"会把顶边留在视口中间，撤掉安全区也看不出位移 ⇒ 对照无判别力。
  check("对照前置：长内容把卡片撑到了 max-h 上限（否则对照没有判别力）",
    tallRead.ok === true && tallRead.panelH > 200 && tallRead.cardTop >= tallRead.capBottom,
    "panelH > 200 且 cardTop >= capBottom",
    JSON.stringify({ cardTop: tallRead.cardTop, capBottom: tallRead.capBottom, panelH: tallRead.panelH }));

  // 反面对照：把变量按回"修之前"（0）⇒ 卡片顶边必须按 `my-auto` 的关系上移。
  //
  // 位移有两个 regime（2026-10-18 落定后现量）：
  //   ① 卡片还有居中余量（H < 可用高度）：cardTop = S + 余量/2 ⇒ 位移 = **S/2**；
  //   ② 卡片被 max-h 夹满（H = 可用高度，余量 0）：cardTop = S + 16 ⇒ 位移 = **S**。
  // 这一档的夹具把内容撑到 400vh，实测正是 ②（tall: H=maxH=353、可用=353）；
  // 旧版读到的 53→39（S/2）是**入场缩放中的矩形**（0.95 系数），不是落定态。
  // ⇒ 判据取区间 [S/2, S+1]：两个 regime 都算“安全区在管事”，0 位移仍然红。
  //   （只放宽到两个可推导值之间，不是“看起来动了”就行。）
  const safePx = parseFloat(a.safeTop) || 0;
  const offVal = await cdp.eval("window.__probe.setWindowSafeTop('off')");
  await sleep(120); // 变量变了 ⇒ 等布局跑完再读
  const b = await cdp.eval("window.__probe.modalStackRead()");
  const shifted = tallRead.cardTop - b.cardTop;
  console.log("  · 读数（不判绿红）：winsafe 几何 tall=" + JSON.stringify(tallRead)
    + " off=" + JSON.stringify(b));
  check("对照：把安全区按回 0 ⇒ 卡片顶边上移（余量版 S/2、夹满版 S；0 位移说明变量没管事）",
    offVal === "0px" && b.ok === true
      && shifted >= safePx / 2 - 1 && shifted <= safePx + 1,
    "上移量落在 [safeTop/2, safeTop]（实测夹满档）",
    JSON.stringify({ offVal, shifted, range: [safePx / 2, safePx], cardTop: b.cardTop, cardH: tallRead.cardH }));
  await cdp.eval("window.__probe.setWindowSafeTop('on')");
  await sleep(120);
  const c = await cdp.eval("window.__probe.modalStackRead()");
  // 可逆判据取"回到原来的那一档"（顶边在 caption 之下 + 与撤掉时相比又下移了约 safeTop/2），
  // ⚠️ 不给逐像素相等：内容被撑高后滚动条/留白那几像素会让读数漂 1–3px（实测 53→50），
  // 那不是"页面被弄坏了"，是布局里本来就有的可变项。
  // 少了对"又下移回去"这一半，就分不清"恢复了"与"恢复成另一个样子"。
  check("对照可逆：恢复变量后卡片又下移回安全区那一档（不是「测一次就把页面弄坏了」）",
    c.ok === true && c.cardTop >= c.capBottom
      && (c.cardTop - b.cardTop) > safePx / 2 - 4,
    "cardTop >= capBottom 且比撤掉时下移约 safeTop/2",
    JSON.stringify({ cardTop: c.cardTop, capBottom: c.capBottom, offCardTop: b.cardTop }));
  await cdp.eval("window.__probe.forceModalTall(false)");

  // ── 移动端：变量必须是 0，卡片不被额外推下（零回归那半边）──────────
  const m = await cdp.eval('window.__probe.composeModalStack({ long: true, isMobile: true })');
  const d = await cdp.eval("window.__probe.modalStackRead()");
  check("移动端：安全区变量为 0（没有 caption，这套不能让移动端多出顶边距）",
    !!m && m.ok === true && d.ok === true && (d.safeTop === "0px" || d.safeTop === ""),
    "safeTop = 0px", JSON.stringify({ safeTop: d.safeTop }));
  check("移动端：TitleBar 不渲染（与真应用 v-if=!isMobile 一致）",
    d.ok === true && d.hasCaption === false, "hasCaption=false", JSON.stringify({ hasCaption: d.hasCaption }));
  // 移动端没有 caption ⇒ 卡片顶边应当在视口顶部附近（被 my-auto 居中，不许被安全区推下去）。
  check("移动端：卡片没被安全区额外推下（顶边仍在视口上半区，不是被顶下去一截）",
    d.ok === true && d.cardTop < d.innerHeight / 2,
    "cardTop < innerHeight/2", JSON.stringify({ cardTop: d.cardTop, innerHeight: d.innerHeight }));

  // ── 弹窗**内部**布局契约（用户 2026-10-12 三条：头部被切 / 操作条跟着滚 / 左右边距不等）──
  // 重挂一份带 footer 插槽的卡片，并把内容撑到超过视口 ⇒ 卡片顶在 max-h，
  // 这才是用户"窗口一缩小"看到的那一档；内容不溢出时这三条都没有作用点。
  await cdp.eval('window.__probe.composeModalStack({ long: true, footer: true })');
  const tallOn = await cdp.eval("window.__probe.forceModalTall(true)");
  const L = await cdp.eval("window.__probe.modalLayoutRead()");
  check("前置：内容真在溢出、滚动区与 footer 都取对了元素（否则下面几条空转）",
    tallOn === true && L.ok === true && L.scrollerFound === true
      && L.scrollerOverflows === true && L.footerFound === true && L.titleMaxChildH > 0,
    "scroller 在 + 溢出 + footer 在 + 标题行有孩子", JSON.stringify(L));
  check("头部没被压扁：标题行盒高容得下自己的孩子、且完整在卡片里（用户那句「窗口一缩小头部缩上去一些」）",
    L.titleSquashed === false && L.titleInside === true,
    "boxH >= maxChildH 且整行在卡片内",
    JSON.stringify({ boxH: L.titleBoxH, maxChildH: L.titleMaxChildH, inside: L.titleInside }));
  check("只有内容区在滚：标题行与操作条都在滚动区**之外**（用户「可滚动区域不该包含下面的操作按钮」）",
    L.titleInScroller === false && L.footerInScroller === false,
    "两者都不在 scroller 内",
    JSON.stringify({ titleIn: L.titleInScroller, footerIn: L.footerInScroller }));
  check("操作条钉在卡片底部且完整可见（长内容时不滚到底也看得见「完成 / 编辑 / 删除」）",
    L.footerInsidePanel === true && L.footerBottom <= L.panelBottom + 1,
    "footer 落在卡片盒内", JSON.stringify({ footerBottom: L.footerBottom, panelBottom: L.panelBottom }));
  // 口径边界（必须带上）：这里量的是"正文边缘到卡片内边缘"，右侧要**扣掉滚动条自己占的宽度**
  // 才是净留白 —— 因为浏览器把滚动条放在内容盒与 padding 之间，它总是额外加宽右侧：
  //  · macOS 系统 overlay 滚动条 ⇒ sbW=0 ⇒ 净留白 == 右留白 ⇒ 用户看到的正是这条（他说"左小右大"就是这条红了）；
  //  · headless Chrome / Windows 经典滚动条 ⇒ sbW>0 ⇒ 右留白必然多出 sbW，那是滚动条本身，不是留白不等。
  // ⇒ 判 `leftInset ≈ rightInset − sbW`：少了负边距（`-mr-[var(--gosslan-scroll-gutter)]`）时
  //   净留白会变成 28 ⇒ 这条精确变红；而它在三种滚动条下都成立，不靠运气。
  check("左右净留白对称：正文左/右边缘到卡片内边缘（右侧扣掉滚动条占宽）距离相等（用户「左边小、右边大」）",
    L.leftInset > 0 && Math.abs(L.leftInset - L.netRightInset) <= 2,
    "|left − (right − 滚动条宽)| <= 2",
    JSON.stringify({ left: L.leftInset, right: L.rightInset, sbW: L.sbW, netRight: L.netRightInset }));
  // —— 反面对照：两条新判据必须"撤掉修复就变红"，否则它们与空转的那条长得一模一样 ——
  const flipG = await cdp.eval("window.__probe.modalLayoutFlip('gutter-off')");
  const Lg = await cdp.eval("window.__probe.modalLayoutRead()");
  check("对照①：就地撤掉滚动区的负右外边距 ⇒ 右侧净留白真的多出一个 gutter 左右",
    flipG.ok === true && Lg.ok === true && (Lg.netRightInset - L.netRightInset) >= 6
      && Math.abs(L.leftInset - Lg.netRightInset) > 2,
    "净右留白增加 >= 6 且不再等于左留白",
    JSON.stringify({ before: L.netRightInset, after: Lg.netRightInset, left: L.leftInset }));
  await cdp.eval("window.__probe.modalLayoutFlip('gutter-on')");
  const flipT = await cdp.eval("window.__probe.modalLayoutFlip('title-off')");
  const Lt = await cdp.eval("window.__probe.modalLayoutRead()");
  check("对照②：放开标题行的 shrink-0 ⇒ 长内容下它真被压扁（boxH < maxChildH，就是用户那句「缩上去一些」）",
    flipT.ok === true && Lt.ok === true && Lt.titleSquashed === true,
    "titleSquashed=true",
    JSON.stringify({ boxH: Lt.titleBoxH, maxChildH: Lt.titleMaxChildH, panelH: Lt.panelH }));
  await cdp.eval("window.__probe.modalLayoutFlip('title-on')");
  const Lr = await cdp.eval("window.__probe.modalLayoutRead()");
  check("对照可逆：两项都还原后读数回到原样（对照本身没把这一档页面弄坏）",
    Lr.ok === true && Lr.titleSquashed === false && Math.abs(Lr.netRightInset - L.netRightInset) <= 1,
    "回到原读数", JSON.stringify({ boxH: Lr.titleBoxH, netRight: Lr.netRightInset }));
  await cdp.eval("window.__probe.forceModalTall(false)");

  // ── 主窗那条路径：不传任何让位参数，也必须让开 caption ──────
  // 2026-10-12 真实缺陷：那条 `topInset` prop 只有独立预览窗在传，主窗全局实例一个都没传
  // ⇒ 遮罩铺到 (0,0)，右上角保存/关闭被 z-[85] 的 caption 压住。
  // ⚠️ 2026-10-20 这里不再靠"退出移动端那一档"保证读数：让位挂在 `html.has-caption` 上，
  // 那个类由夹具挂上去的**真 TitleBar** 自己写（旧写法挂在 `html:not(.is-mobile)` 上，
  // 于是"撤掉 is-mobile"成了这条判据的前提 —— 探针自己污染过：ovTop=0 / capBottom=28）。
  await cdp.eval("window.__probe.composeModalStack({ isMobile: false })");
  await cdp.eval("window.__probe.composeStack({})");
  const e = await cdp.eval("window.__probe.stackRead()");
  check("主窗那条路径：图片灯箱也不许铺到顶（右上角保存/关闭被 caption 压住过）",
    e.ok === true && e.ovTop >= e.capBottom,
    "ovTop >= capBottom", JSON.stringify({ ovTop: e.ovTop, capBottom: e.capBottom }));
}

async function runImageSkeleton(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const mounted = await cdp.eval("window.__probe.install('/src/components/message/MessageImageBubble.vue', '', "
    + JSON.stringify(JSON.stringify({ src: "/gosslan-probe-missing-image.png" })) + ")");
  check("图片盒挂出来了（骨架才有得量）", !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));

  const loading = await cdp.eval("window.__probe.imgBox()");
  check("加载中：骨架预留 == 估算端那个常量（现读 previewMetrics，不写死数字）",
    loading.ok === true && loading.state === "loading" && loading.h === loading.cap,
    "state=loading 且 rect.h == IMAGE_BUBBLE_HEIGHT", JSON.stringify(loading));
  check("加载中：容器定宽 208（w-52）⇒ 图片尺寸与兄弟节点（已读回执）无关",
    loading.ok === true && loading.w === 208, "rect.w == 208", JSON.stringify(loading));
  check("加载中：<img> 的上限也从同一个常量取（预留 == 上限 == 估算，三者一个数）",
    loading.ok === true && loading.imgMax === loading.cap && loading.imgDisplay === "none",
    "max-height == IMAGE_BUBBLE_HEIGHT 且图未显示", JSON.stringify(loading));

  // 单点变异：把预留按回旧的字面量（128）⇒ 上面那条必须当场不成立（证明它会咬，不是恒真）
  const mutated = await cdp.eval("window.__probe.forceSkeletonLegacyHeight(true)");
  const after = await cdp.eval("window.__probe.imgBox()");
  check("对照：把骨架按回旧的 128 ⇒ 判据立刻不成立（mutation 生效了）",
    mutated === true && after.ok === true && after.h === 128 && after.h !== after.cap,
    "rect.h 变成 128 且 != cap", JSON.stringify(after));
  const restored = await cdp.eval("window.__probe.forceSkeletonLegacyHeight(false)");
  const back = await cdp.eval("window.__probe.imgBox()");
  check("对照可逆：恢复后又等于常量（没有把页面改坏一次）",
    restored === true && back.ok === true && back.h === back.cap,
    "rect.h == IMAGE_BUBBLE_HEIGHT", JSON.stringify(back));

  // 等退避全部用完（8.4s）⇒ 落进 failed，那时占位必须换成紧凑那一档。
  // 终态由 error 事件驱动：eager <img> 对不存在的路径会自己拿到 404（自然 error），
  // 探针再按节奏代投 error，把等满 8.4s 退避链的时间收在有界窗口里（打的都是组件自己
  // 那个 @error 处理器，顺带把"重试全部失败才会落 failed"在真浏览器里走一遍）。
  const netSeen = await cdp.eval(`(() => performance.getEntriesByType('resource')
    .map((e) => e.name).filter((n) => n.includes('gosslan-probe-missing-image')).length)()`);
  console.log("· imgskel 网络读数：这条 src 在页面资源计时里出现 " + netSeen
    + " 次（eager 隐藏图也会发请求；0 才是反常——见 img-eager-ok 那个死锁）");

  // 有界：退避 5 档 + 每档之间要等 img 换代，14s 上限给真机/CI 抖动留余量。
  let failed = null;
  const timeline = [];
  for (let i = 0; i < 20; i += 1) {
    await cdp.eval(`(() => {
      const el = document.querySelector('[data-img-el]');
      if (el) el.dispatchEvent(new Event('error'));
    })()`);
    await sleep(700);
    failed = await cdp.eval("window.__probe.imgBox()");
    timeline.push(String(failed && failed.ok === true ? (failed.state === "failed" ? "F" : "l") : "?"));
    if (failed && failed.ok === true && failed.state === "failed") break;
  }
  console.log("· imgskel 退避时间线（每投一次 error 读一态，l=加载中 F=失败态）：" + timeline.join(""));
  check("失败态：退避用完后落到紧凑占位（不为一张永远等不来的图撑 288px 灰块）",
    !!failed && failed.ok === true && failed.h === failed.placeholder,
    "state=failed 且 rect.h == IMAGE_PLACEHOLDER_HEIGHT", JSON.stringify(failed));
}

/**
 * 有效图片必须真的从"加载中"走到"已加载"，并且**加载完才允许点开预览**（v4.35.2 真根因回归）。
 *
 * 死锁形状：`<img>` 在自身 @load 之前被 `hidden`（display:none）藏着，再带 loading="lazy"
 * ⇒ 懒加载只对参与排版、靠近视口的元素发请求，display:none 的那张**永远不发请求**
 * ⇒ @load 永不触发 ⇒ state 永远停在 loading（5 档退避后落 failed）⇒ 自己发的/对方发的图全打不开。
 * 6853680 统一给消息行补 lazy 时引入；修复见 MessageImageBubble.vue 的 img-eager-ok 注释。
 *
 * 判据全打在**真组件 + 真解码**上：
 *  1. 喂一张有效的 data URL，data-img-state 必须在有界时间内变成 loaded（hidden 不挡 eager）；
 *  2. loaded 后 <img> 真解码（naturalWidth>0）、退出隐藏、盒子变成可点的 button；
 *  3. 这条 <img> 不许带 loading="lazy"（与 display:none 同框就是死锁，静态锁，加回来当场红）；
 *  4. 点击必须 emit open（预览打不开的用户-facing 那一半）。
 * 不做引擎级"lazy 隐藏图不加载"对照：脚本插入的隐藏 lazy 图在 CfT 153 上会加载，
 * 只有 Vue 挂载路径那张不加载，跨引擎/版本不稳定 —— 见函数尾注释。
 */
async function runImageLoad(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  // 2×2 不透明 PNG，data URL 不依赖任何网络/dev server 路由
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DwnwEJ"
    + "MDIYMhYAcgsB/w0FHT8AAAAASUVORK5CYII=";
  const mounted = await cdp.eval("window.__probe.install('/src/components/message/MessageImageBubble.vue', '', "
    + JSON.stringify(JSON.stringify({ src: PNG })) + ")");
  check("有效图：图片盒挂出来了（回归段才有得量）", !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));

  // 有界等 @load（eager 隐藏图也会立刻发 data URL 解析；正常应在首轮就 loaded）
  let box = null;
  let rounds = 0;
  for (let i = 0; i < 25; i += 1) {
    rounds = i + 1;
    box = await cdp.eval("window.__probe.imgBox()");
    const img = await cdp.eval(`(() => { const el = document.querySelector('[data-img-el]');
      return el ? { nw: el.naturalWidth, display: getComputedStyle(el).display,
        loading: el.getAttribute('loading'), role: el.closest('[data-img-state]').getAttribute('role') } : null; })()`);
    box = { ...(box || {}), ...(img || {}) };
    if (box.state === "loaded" && box.nw > 0) break;
    await sleep(200);
  }
  console.log(`· imgload 等到 loaded 用了 ${rounds} 轮（每轮 200ms）`);
  check("有效图：state 必须走到 loaded（lazy+hidden 死锁时永远停在 loading，最终 failed）",
    box.state === "loaded", "state=loaded", JSON.stringify({ state: box.state, rounds }));
  check("有效图：<img> 真解码且退出 display:none",
    box.nw > 0 && box.display !== "none", `naturalWidth>0 且 display!=none`, JSON.stringify(box));
  check("有效图：这一条不许带 loading=\"lazy\"（与 display:none 同框就是死锁；豁免理由写在 img-eager-ok 注释里）",
    box.loading === null, "loading 属性不存在", "loading=" + JSON.stringify(box.loading));
  check("有效图：loaded 后盒子才可点（role=button；没加载完时点击只该走重取）",
    box.role === "button", "role=button", "role=" + JSON.stringify(box.role));

  // 点击：夹具把组件的 @open 记成 ['open-id', src]（见 PAGE_FIXTURE 的 mkProps.onOpen）
  await cdp.eval("window.__probe.reset()");
  const root = await cdp.eval(`(() => { const r = document.querySelector('[data-img-state]');
    if (!r) return false; r.click(); return true; })()`);
  await sleep(150);
  const opened = await cdp.eval("window.__probe.events.some((e) => e[0] === 'open-id')");
  check("有效图：点击已加载的图片必须上抛 open（用户点了就要进预览）",
    root === true && opened === true, "events 含 open-id", `root=${root} opened=${opened}`);
  // 引擎行为对照不做进自动判据：CfT 153 实测"脚本插入的隐藏 lazy 图"会加载，而 Vue 挂载路径上
  // 那张不加载（构造顺序/文档时机差异，跨引擎不稳定）。死锁的真证据是上面的产品级回归
  //（6853680 引入 lazy 后 state 永不进 loaded，修复前用真 blob 实测 12s naturalWidth=0），
  // 加上第 3 条对 loading 属性的静态锁 —— 谁把 lazy 加回来当场变红，不必再放一张会随浏览器
  // 版本翻转的对照图。
}

/**
 * 表情回应条的**边缘对齐 + 名单浮层越界**那一段（用户 2026-10-07 报的两条：
 * ①「电脑端 右边聊天 hover 表情 人员列表 展开遮挡」；②「表情和气泡对齐：左右两条表情回复边缘
 * 都与上面气泡对齐，并且间距紧凑点」）。
 *
 * 为什么必须走真浏览器量：这两条判的全是**布局几何**，而静态 class 判据只能证明"某个数被写进去了"，
 * 证不了"那个数等于气泡的真实边缘"。这次的根因正是补偿值算错 —— 册里注释写的是"头像 40px + 行间距 8px"，
 * 而头像是 `h-9 w-9` = **36px**，还漏了消息行自己的 `px-4` = 16px ⇒ 两侧各差 8px。
 * 那 8px 只有浏览器知道，注释和 class 都不会告诉我。
 */
/**
 * 外层只干一件事：**把"页面有焦点/可见"这件事圈在本段内**。
 *
 * headless 起的探针页实测是 visibilityState="hidden" + hasFocus()=false，
 * 而 mouseenter/mouseleave 是浏览器按它内部的 hover 追踪算出来的
 * ⇒ 真鼠标投递间歇性丢（曾表现为"名单一次都没弹出、而单独跑 --only=roster 全绿"）。
 * 开焦点模拟后，左右两列都在**第 0 次尝试**走通真鼠标。
 *
 * ⚠️ 刻意不外溢：emoji 那一段的 Enter 断言正是按"页面没焦点 ⇒ Enter 不激活被聚焦的格子"
 * 写的（那条"Enter 不带 text ⇒ 零次激活"的对照就是它的前提）。全局开焦点模拟会让 Enter
 * 真的激活格子，实测 select 事件刷到 8MB 日志。所以进来开、出去关，并用 finally 兜住。
 */
async function runReactionRoster(cdp, url) {
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.send("Page.bringToFront").catch(() => {});
  try {
    await rosterChecks(cdp, url);
  } finally {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

async function rosterChecks(cdp, url) {
  /** 取证帧：`--shot=/tmp/x.png` 时两侧各存一张（左列 / 右列名单展开态）。 */
  const shot = async (name) => {
    if (!SHOT_PATH) return;
    const p = SHOT_PATH.replace(/\.png$/, `-${name}.png`);
    const s = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(p, Buffer.from(s.data, "base64"));
    console.log("  📷 回应条取证帧 → " + p);
  };
  const LONG = "一个会撑破整块面板的超长昵称-ABCDEFGHIJKLMNOP-QRSTUVWXYZ";
  const CHIPS = [{
    emoji: "[赞]", count: 4, mine: true,
    actors: ["peer-a", "peer-b", "peer-c", "me-1"], latest: "me-1",
  }];
  const mount = async (sender, mineSide, chips, group = true) => {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const props = {
      message: {
        msg_id: "m-roster-probe-1", sender_id: sender, kind: "text",
        content: "这条要量回应条与气泡的边缘关系，所以内容写得长一些，让它折成两行以上。",
        ts: 1700000000000, conv_id: "group:g1", seq: 1,
      },
      canReact: true, isGroup: group, senderName: "测试者", reactions: chips ?? CHIPS,
    };
    const r = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
      + JSON.stringify(JSON.stringify(props)) + ")");
    if (!r || r.ok !== true) return false;
    // mine 是由 app.device.device_id 现推的：不种身份就永远量不到右列那一支。
    if (mineSide) await cdp.eval("window.__probe.seedDevice('me-1')");
    await sleep(400);
    return true;
  };
  /**
   * 把指针真的移进第 i 颗胶囊，重试到名单出现。走的是**真鼠标**：
   * 先退到一个明确不在胶囊上的点再回来（同一点重复 mouseMoved 会被 Chrome 判成
   * "位置没变"丢掉），送回去之后等一帧再判（摆位在 mouseenter 那一拍算完，
   * 但 DOM 要等 Vue 冲刷才出现）。
   *
   * ⚠️ 这里刻意**不再**留"派发合成 mouseenter"那条兜底。它是探针页没焦点时的救急，
   * 但留着就等于"hover 真不工作也能判绿"。焦点模拟（见 runReactionRoster 外层）
   * 已经把真鼠标通路修稳，所以兜底删掉 —— 现在 hover 坏了一定是红的。
   */
  async function hoverInto(i) {
    const pt = await cdp.eval("window.__probe.reactionChipPoint(" + i + ")");
    if (!pt) return { pt: null, tries: -1, via: "no-chip", log: "" };
    await cdp.eval("window.__probe.watchChip()");
    for (let k = 0; k < 5; k += 1) {
      await cdp.hover(Math.max(2, pt.x - 60), pt.y);
      await sleep(50);
      await cdp.hover(pt.x, pt.y);
      await sleep(150);
      if (await cdp.eval("!!document.querySelector('[data-reaction-roster]')")) {
        return { pt, tries: k, via: "mouse", log: await cdp.eval("window.__probe.chipLog()") };
      }
    }
    return { pt, tries: -1, via: "none", log: await cdp.eval("window.__probe.chipLog()") };
  }

  // ================= 左列（别人发的）：看左边缘 =================
  check("左列：挂出一条带回应的消息", await mount("peer-a", false), "install 成功");
  const gl = await cdp.eval("window.__probe.reactionGeom()");
  check("左列：胶囊左边缘与气泡那一列左边缘对齐（|差| <= 1px）",
    gl.ok === true && Math.abs(gl.deltaLeft) <= 1,
    "|chip.left - col.left| <= 1",
    "差 " + gl.deltaLeft + "px；chip.left=" + gl.chipLeft + " col.left=" + gl.colLeft
      + "，条 padding-left=" + gl.padLeft);
  check("左列：与气泡的竖向间距收到紧凑档（0 <= 差 <= 6px，改之前是 10px）",
    gl.ok === true && gl.gapToBubble >= 0 && gl.gapToBubble <= 6,
    "0 <= 间距 <= 6",
    "间距 " + gl.gapToBubble + "px = 条 mt " + gl.barMarginTop + " + 消息行 pb " + gl.rowPadBottom);

  const hl = await hoverInto(0);
  check("左列：拿得到胶囊的落点（hover 的坐标来源）", !!hl.pt, "chipPoint 非空", JSON.stringify(hl.pt));
  const rl = await cdp.eval("window.__probe.reactionRoster()");
  check("左列：hover 胶囊真的展开名单（" + hl.via + " 通路，第 " + hl.tries + " 次命中；事件 " + hl.log.slice(0, 170) + "）",
    rl.ok === true, "名单在布局里", JSON.stringify(rl).slice(0, 900));
  check("左列：名单不越出滚动容器（左右都不许）",
    rl.ok === true && rl.overLeft <= 0 && rl.overRight <= 0,
    "overLeft <= 0 且 overRight <= 0",
    "左溢 " + rl.overLeft + " / 右溢 " + rl.overRight + "（容器 " + rl.clipLeft + "…" + rl.clipRight + "）");
  // ★ 名单的**自带契约**（组件头注释 + chipTitle 都是这一条）：列到 ROSTER_VISIBLE 人为止，
  //   其余折成「+N」。夹具这里给的是 4 个 actor ⇒ 必须恰好 3 行 + 一条 +1。
  //   模板曾经 v-for 全部 actors **又**渲染 +N ⇒ 4 行名字 + "还有 1 人"，自己跟自己矛盾
  //   （用户 2026-10-07：「表情很多的时候 查看这个列表也是有问题的」）。
  const rowsL = await cdp.eval("window.__probe.reactionRows()");
  const plusL = await cdp.eval("(function(){var r=document.querySelector('[data-reaction-roster]');"
    + "if(!r)return null;var t=r.lastElementChild;"
    + "return t && !t.hasAttribute('data-roster-row') ? t.textContent.trim() : null;})()");
  const fl_l = await cdp.eval("window.__probe.floatLayer('[data-reaction-roster]')");
  check("左列：名单 escape 出裁切容器（挂在 body 上 + 没有任何祖先裁得到它）",
    fl_l.ok === true && fl_l.parentIsBody === true && fl_l.escapes === true,
    "parentIsBody 且 escapes",
    "挂body=" + fl_l.parentIsBody + " position=" + fl_l.position
      + " 切得到它的祖先=" + JSON.stringify(fl_l.clipped)
      + " 变成包含块的祖先=" + JSON.stringify(fl_l.breakers)
      + "（body overflow=" + fl_l.bodyOverflow + "：fixed 不被它裁 ⇒ 只有祖先变成包含块才裁得到）");
  check("左列：名单整个在视口内（escape 出去 ≠ 看得见，坐标算错会飞出屏幕）",
    fl_l.ok === true && fl_l.inViewport === true,
    "四边都在视口内", "rect=" + JSON.stringify(fl_l.rect) + " 视口=" + fl_l.vw + "x" + fl_l.vh);
  check("左列：4 人名单恰好折成 3 行 + 一条 +N（不许把所有人列出来又说还有 N 人）",
    rowsL.ok === true && rowsL.rows.length === 3 && /^\+|\d|还有/.test(String(plusL)),
    "行数 === 3 且末条是 +N",
    "现读 " + (rowsL.ok === true ? rowsL.rows.length : "?") + " 行，末条 = " + JSON.stringify(plusL));
  await shot("left");

  // ================= 右列（我自己发的）：看右边缘 + 那条越界 =================
  check("右列：挂出一条自己发的带回应消息", await mount("me-1", true), "install + seed 成功");
  const gm = await cdp.eval("window.__probe.reactionGeom()");
  check("右列：胶囊右边缘与气泡那一列右边缘对齐（|差| <= 1px）",
    gm.ok === true && Math.abs(gm.deltaRight) <= 1,
    "|chip.right - col.right| <= 1",
    "差 " + gm.deltaRight + "px；chip.right=" + gm.chipRight + " col.right=" + gm.colRight
      + "，条 padding-right=" + gm.padRight);


  check("右列：与气泡的竖向间距同样是紧凑档（0 <= 差 <= 6px）",
    gm.ok === true && gm.gapToBubble >= 0 && gm.gapToBubble <= 6,
    "0 <= 间距 <= 6", "间距 " + gm.gapToBubble + "px = 条 mt " + gm.barMarginTop + " + 消息行 pb " + gm.rowPadBottom);

  const hm = await hoverInto(0);
  check("右列：拿得到胶囊的落点（hover 的坐标来源）", !!hm.pt, "chipPoint 非空", JSON.stringify(hm.pt));
  const rm = await cdp.eval("window.__probe.reactionRoster()");
  check("右列：hover 展开名单（用户报的那一支；" + hm.via + " 通路，第 " + hm.tries + " 次命中；事件 " + hm.log.slice(0, 170) + "）",
    rm.ok === true, "名单在布局里", JSON.stringify(rm).slice(0, 900));
  check("右列：名单右缘不越出滚动容器（用户那句「展开遮挡」就是这一格）",
    rm.ok === true && rm.overRight <= 0 && rm.overLeft <= 0,
    "右溢 <= 0 且 左溢 <= 0",
    "右溢 " + rm.overRight + "px / 左溢 " + rm.overLeft + "px，名单宽 " + rm.width
      + "px，容器 " + rm.clipLeft + "…" + rm.clipRight + "，视口 " + rm.vw);
  const fl_r = await cdp.eval("window.__probe.floatLayer('[data-reaction-roster]')");
  check("右列：名单同样 escape 出裁切容器（这一支用 CSS right 钉，链路上必须一样干净）",
    fl_r.ok === true && fl_r.parentIsBody === true && fl_r.escapes === true,
    "parentIsBody 且 escapes",
    "挂body=" + fl_r.parentIsBody + " position=" + fl_r.position
      + " 切得到它的祖先=" + JSON.stringify(fl_r.clipped)
      + " 变成包含块的祖先=" + JSON.stringify(fl_r.breakers) + " rect=" + JSON.stringify(fl_r.rect));
  check("右列：名单整个在视口内",
    fl_r.ok === true && fl_r.inViewport === true,
    "四边都在视口内", "rect=" + JSON.stringify(fl_r.rect) + " 视口=" + fl_r.vw + "x" + fl_r.vh);
  check("右列：名单露出来的那部分确实是它自己（没被别的元素盖住）",
    rm.ok === true && rm.hitSelf === true,
    "elementFromPoint 命中名单自身", "命中 " + rm.hitTag);
  await shot("right");

  // ================= 两把反面对照：证明上面那些数不是恒真 =================
  await cdp.eval("window.__probe.forceAlignSkew(true)");
  const skewed = await cdp.eval("window.__probe.reactionGeom()");
  check("对照：把回应条朝外侧挪 8px（= 修之前那个补偿差的量）⇒ 对齐判据必须不再成立",
    skewed.ok === true && Math.abs(skewed.deltaRight) >= 4,
    "|差| >= 4", "差 " + skewed.deltaRight + "px");
  await cdp.eval("window.__probe.forceAlignSkew(false)");
  const back = await cdp.eval("window.__probe.reactionGeom()");
  check("对照可逆：撤掉平移后右缘又对齐",
    back.ok === true && Math.abs(back.deltaRight) <= 1, "|差| <= 1", "差 " + back.deltaRight + "px");

  await cdp.eval("window.__probe.forceLegacyRoster(true)");
  const legacy = await cdp.eval("window.__probe.reactionRoster()");
  check("对照：把名单 fixed left 推到视口右缘外 ⇒ 右溢必须重新出现（证明判据不空转）",
    legacy.ok === true && legacy.overRight > 0,
    "overRight > 0", "右溢 " + legacy.overRight + "px");
  const mutVp = await cdp.eval("window.__probe.floatLayer('[data-reaction-roster]')");
  check("对照：同一支推坐标出视口的变异下，inViewport 也必须翻假（证明那条视口判据会咬）",
    mutVp.ok === true && mutVp.inViewport === false,
    "inViewport === false",
    "rect=" + JSON.stringify(mutVp.rect) + " 视口=" + mutVp.vw + "x" + mutVp.vh);
  await cdp.eval("window.__probe.forceLegacyRoster(false)");
  const fixed = await cdp.eval("window.__probe.reactionRoster()");
  check("对照可逆：换回新锚点后右溢归零",
    fixed.ok === true && fixed.overRight <= 0, "overRight <= 0", "右溢 " + fixed.overRight + "px");
  const rep = await cdp.eval("window.__probe.reparentRoster(true)");
  const mut = await cdp.eval("window.__probe.floatLayer('[data-reaction-roster]')");
  check("对照：把名单搬回「absolute 挂在裁切容器里」（= 修之前的形状）⇒ escape 判据必须翻假",
    rep.ok === true && mut.ok === true && mut.escapes === false,
    "escapes === false",
    "搬进 " + JSON.stringify(rep.into) + " position=" + mut.position
      + " 切得到它的祖先=" + JSON.stringify(mut.clipped) + " 链=" + JSON.stringify(mut.chain));
  await cdp.eval("window.__probe.reparentRoster(false)");
  const undone = await cdp.eval("window.__probe.floatLayer('[data-reaction-roster]')");
  check("对照可逆：搬回 body、position 又回到 fixed ⇒ escapes 恢复（对照自己不留残留）",
    undone.ok === true && undone.escapes === true && undone.parentIsBody === true
      && undone.position === "fixed",
    "escapes 且 parentIsBody 且 position=fixed",
    "escapes=" + undone.escapes + " 挂body=" + undone.parentIsBody + " position=" + undone.position
      + " 切得到它的祖先=" + JSON.stringify(back.clipped));
  // ============ 一排十几颗（用户第二轮）：方向按**这颗的位置**翻，长名字要真省略 ============
  // 用户那句："不能特别固定的就往左偏或者往右偏，而是看这个图标的位置靠近哪边就往反方向偏"
  // ⇒ 判据必须同时钉"贴左那颗"和"贴右那颗"，而且**同一条消息上**（消息朝向相同、该偏的方向相反）。
  const EMO = ["[赞]", "[捂脸]", "[笑哭]", "[火]", "[心]", "[666]", "[狗头]", "[打脸]", "[皱眉]", "[耶]", "[吃瓜]", "[偷笑]"];
  const MANY = EMO.map((e, i) => ({
    emoji: e, count: i + 1, mine: i === 0,
    actors: [i === 0 ? LONG : "同事甲", "同事乙"], latest: "同事乙",
  }));
  // —— 「这一行没有头像列」的两种形态：让边必须换成消息行自己的 16px ——
  // 5.7 起头像列只在「群聊 + 别人」那一行里画（判定住在 MessageItem 的 avatarCol）。
  // 条子内再写死 60px 就把胶囊推离气泡边 44px（= 头像 36 + 行间隙 8）—— 上面那条右列判据
  // 红过一次就是这么来的。群聊自己发那一行已由右列那条覆盖，这里补单聊的两侧（都没头像列）。
  for (const side of ["me", "peer"]) {
    await cdp.eval("window.__probe.reset()");
    // ⚠️ sender 串必须是段内已有那两个之一：`mine` 由 seedDevice('me-1') 与 sender_id **现推**，
    //   另编一个号会让整行退化成"对方"那一支，量的就不是我要量的形态了。
    const okDm = await mount(side === "me" ? "me-1" : "peer-a", side === "me", undefined, false);
    const gd = await cdp.eval("window.__probe.reactionGeom()");
    const dd = side === "me" ? gd.deltaRight : gd.deltaLeft;
    check("单聊·" + (side === "me" ? "自己" : "对方") + "：胶囊与气泡边对齐（无头像列时只让行的 16px）",
      okDm === true && gd.ok === true && Math.abs(dd) <= 1,
      "|差| <= 1", "差 " + dd + "px " + JSON.stringify({
        chipRight: gd.chipRight, colRight: gd.colRight, chipLeft: gd.chipLeft,
        colLeft: gd.colLeft, padRight: gd.padRight, padLeft: gd.padLeft }));
  }
  // ⚠️ 位置有讲究：必须排在上面那两组**反向对照**之后 —— mount() 会重新导航，
  //   插在中途会把对照赖以生存的「右列那一页」换掉（实测：撤平移那条读成 -473px）。
  check("多颗：挂出一条带 12 颗回应的消息", await mount("peer-a", false, MANY), "install 成功");
  // 长名字必须**先在 store 的名字表里**：`nicknameOf` 查不到会把 id 落成
  // 「未知成员 + 后四位」，下面三条量的就会是那段短兜底文案（探针失真，不是界面错）。
  const seeded = await cdp.eval("window.__probe.seedMembers(" + JSON.stringify([
    { device_id: LONG, nickname: LONG },
    { device_id: "同事甲", nickname: "同事甲" },
    { device_id: "同事乙", nickname: "同事乙" },
  ]) + ")");
  check("多颗：长名字真的在 store 的名字表里（否则下面量的是「未知成员」）",
    !!seeded && seeded.ok === true && seeded.names[0] === LONG,
    "nicknameOf(LONG) === LONG", JSON.stringify(seeded));
  const pts = await cdp.eval("window.__probe.allChipPoints()");
  check("多颗：拿得到每一颗胶囊的落点（>= 8 颗才谈得上「贴哪一边」）",
    Array.isArray(pts) && pts.length >= 8, "至少 8 颗", "现读 " + (pts ? pts.length : 0) + " 颗");
  const leftmost = pts.reduce((x, y) => (y.left < x.left ? y : x));
  const rightmost = pts.reduce((x, y) => (y.right > x.right ? y : x));

  await hoverInto(leftmost.i);
  const r1 = await cdp.eval("window.__probe.reactionRoster()");
  check("多颗：贴左那颗的名单**往右长**（名单左缘就是胶囊左缘，左缘不越界）",
    r1.ok === true && Math.abs(r1.left - leftmost.left) <= 2 && r1.overLeft <= 0,
    "|名单.left - 胶囊.left| <= 2 且 左溢 <= 0",
    "名单 left=" + r1.left + " 胶囊 left=" + leftmost.left + " 左溢 " + r1.overLeft);
  const rows1 = await cdp.eval("window.__probe.reactionRows()");
  // 判"长名字那一行"必须真被省略号截断（短行不该截 —— 第一版我写成"每行都要 clipped"，
  // 那是判据自己太严：同事乙 那行本来就短，红得没道理）
  const longRow = rows1.ok === true ? rows1.rows.find((x) => x.text.startsWith("一个会撑破")) : null;
  check("多颗：超长昵称那一行被省略号真截断（clipped + ellipsis），且 title 里留了全名",
    !!longRow && longRow.clipped === true && longRow.ellipsis === true && longRow.hasTitle === true,
    "长名字行 clipped 且 ellipsis 且带 title",
    JSON.stringify(longRow));
  check("多颗：面板不被长名字撑破（宽 <= 16rem = 256px，每行都带 title 兜住全名）",
    rows1.ok === true && rows1.panelW <= 256 && rows1.rows.every((x) => x.hasTitle === true),
    "面板 <= 256px 且每行有 title",
    "面板宽 " + rows1.panelW + "px，行数 " + (rows1.rows ? rows1.rows.length : 0));
  // 长名字那一颗要**顶到上限**：撑开不是"越短越好"，超过上限才交给行内 truncate。
  check("多颗：长名字那一颗顶到最大档（面板宽 >= 250，说明 max-width 真的是那条上限）",
    rows1.ok === true && rows1.panelW >= 250,
    "长名字面板 >= 250", "面板宽 " + (rows1.ok === true ? rows1.panelW : "?") + "px");

  await hoverInto(rightmost.i);
  const r2 = await cdp.eval("window.__probe.reactionRoster()");
  check("多颗：贴右那颗的名单**往左长**（名单右缘就是胶囊右缘，右缘不越界）",
    r2.ok === true && Math.abs(r2.right - rightmost.right) <= 2 && r2.overRight <= 0,
    "|名单.right - 胶囊.right| <= 2 且 右溢 <= 0",
    "名单 right=" + r2.right + " 胶囊 right=" + rightmost.right + " 右溢 " + r2.overRight);
  // 宽度按名字长短**伸缩**（用户 2026-10-07：「框框是固定长度，名字不够长后面有空白」）。
  // 这一条是**两颗互证**的：同一块面板、短名字那颗必须明显窄于长名字那颗 ——
  // 只要宽度是写死的，两个读数就相等，这条当场红。所以它不需要额外的反面对照。
  check("多颗：短名字那一颗按内容撑开（比长名字那颗窄、且没顶到上限 ⇒ 不写死宽度）",
    r2.ok === true && r2.width < r1.width && r2.width < 200,
    "短 " + r2.width + " < 长 " + r1.width + " 且 短 < 200",
    "短名字面板 " + r2.width + "px / 长名字面板 " + r1.width + "px");
  await shot("many");

  // ============ 隔壁那支表情选择器：同一个坑的第二次现场 ============
  // 这块面板宽 min(360px, 视口-32)，是这一类里最容易被窗口边缘切到的一支。
  // 4.33.25 那轮它只有静态那一半守着（没有"点开"的通路），这里补上：真点一下入口按钮，
  // 再对**那层壳**判 escape、对**里面的面板**判在不在视口内。
  //   ⚠️ 两个对象不能混：壳是零高度的（它的孩子全 absolute），量壳的矩形证明不了"看得见"；
  //      而里面那块面板是 absolute —— 对它只许读 inViewport，escapes 那一栏在这形状下本来就是假的
  //      （absolute 的祖先里当然有 overflow，它的包含块是这层 fixed 壳，不该拿去判裁切）。
  const eb = await cdp.eval("(function(){var b=document.querySelector('[data-reaction-entry]');"
    + "if(!b)return null;var r=b.getBoundingClientRect();"
    + "return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),"
    + " display: getComputedStyle(b).display};})()");
  check("选择器：拿得到表情入口那颗按钮的落点（点开的坐标来源）", !!eb, "entry 非空", JSON.stringify(eb));
  let pickerOpen = false;
  for (let k = 0; k < 5 && !pickerOpen; k += 1) {
    await cdp.hover(Math.max(2, eb.x - 80), eb.y);
    await cdp.click(eb.x, eb.y);
    pickerOpen = !!(await cdp.eval("!!document.querySelector('[data-reaction-picker]')"));
  }
  const fp = await cdp.eval("window.__probe.floatLayer('[data-reaction-picker]')");
  const pp = await cdp.eval("window.__probe.floatLayer('[data-reaction-picker] [role=dialog]')");
  check("选择器：点开之后那层壳 escape 出裁切容器（挂在 body 上 + 没有祖先裁得到它）",
    pickerOpen === true && fp.ok === true && fp.parentIsBody === true && fp.escapes === true,
    "开得出、挂 body、且 escapes",
    "开=" + pickerOpen + " 挂body=" + fp.parentIsBody + " position=" + fp.position
      + " 切得到它的祖先=" + JSON.stringify(fp.clipped)
      + " 变成包含块的祖先=" + JSON.stringify(fp.breakers));
  check("选择器：那块面板整个在视口内（量的是里面的 dialog，不是零高度的壳）",
    pp.ok === true && pp.inViewport === true,
    "面板四边都在视口内",
    "rect=" + JSON.stringify(pp.rect) + " 视口=" + pp.vw + "x" + pp.vh
      + " 宽=" + (pp.rect.r - pp.rect.l) + " 高=" + (pp.rect.bo - pp.rect.t));
  // 反面对照：把壳的 fixed 坐标推到视口右缘外 ⇒ 里面那块面板必须跟着出去
  await cdp.eval("(function(){var el=document.querySelector('[data-reaction-picker]');"
    + "if(!el)return false;"
    + "var box=el.closest('[data-reka-popper-content-wrapper]')||el;"
    + "box._o={left: box.style.left, right: box.style.right, transform: box.style.transform};"
    + "box.style.right='auto';box.style.left=(window.innerWidth - 20) + 'px';box.style.transform='none';return true;})()");
  const ppOut = await cdp.eval("window.__probe.floatLayer('[data-reaction-picker] [role=dialog]')");
  check("对照：把选择器那层壳推到视口右缘外 ⇒ 面板必须落到视口外（证明那条视口判据会咬）",
    ppOut.ok === true && ppOut.inViewport === false,
    "inViewport === false",
    "rect=" + JSON.stringify(ppOut.rect) + " 视口=" + ppOut.vw);
  await cdp.eval("(function(){var el=document.querySelector('[data-reaction-picker]');"
    + "if(!el)return false;"
    + "var box=el.closest('[data-reka-popper-content-wrapper]')||el;"
    + "if(!box._o)return false;box.style.left=box._o.left;box.style.right=box._o.right;"
    + "box.style.transform=box._o.transform;delete box._o;return true;})()");
  const ppBack = await cdp.eval("window.__probe.floatLayer('[data-reaction-picker] [role=dialog]')");
  check("对照可逆：壳换回原来的锚点之后，面板又整个回到视口内（对照自己不留残留）",
    ppBack.ok === true && ppBack.inViewport === true,
    "inViewport === true", "rect=" + JSON.stringify(ppBack.rect));

  // ============ 已读成员弹层：这一支就是"真机：已读列表靠右被裁一半"那一支 ============
  // 挂的是 MessageReceipt 本体（它那一层浮层就是**带 fixed 的面板自己**，不像选择器那样壳/面板要分开量）。
  // ⚠️ 这一支的量法是**独立挂载**：escape 与在不在视口都判得动（同一份 placeCard、同一个 Teleport），
  //    但它不在真实消息行的几何里 ⇒ 别把它读成"真机那条列表的位置也被判过了"。
  const rmount = await cdp.eval("window.__probe.install('/src/components/message/MessageReceipt.vue', '', "
    + JSON.stringify(JSON.stringify({
      state: "read", title: "已读", isGroup: true, msgKey: "m-receipt-probe-1",
      readerIds: ["r-1", "r-2", "r-3", "r-4", "r-5"],
    })) + ")");
  check("已读弹层：独立挂出一条带 5 个已读成员的回执", rmount && rmount.ok === true, "install 成功", JSON.stringify(rmount).slice(0, 160));
  await cdp.eval("window.__probe.seedDevice('me-1')");
  await new Promise((r) => setTimeout(r, 300));
  const rb = await cdp.eval("(function(){var b=document.querySelector('button');"
    + "if(!b)return null;var r=b.getBoundingClientRect();"
    + "return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),"
    + " label: b.getAttribute('aria-label')};})()");
  check("已读弹层：拿得到那枚已读入口的落点", !!rb, "button 非空", JSON.stringify(rb));
  let readersOpen = false;
  for (let k = 0; k < 5 && !readersOpen; k += 1) {
    await cdp.hover(Math.max(2, rb.x - 80), rb.y);
    await cdp.click(rb.x, rb.y);
    readersOpen = !!(await cdp.eval("!!document.querySelector('[data-readers-popover]')"));
  }
  const fr = await cdp.eval("window.__probe.floatLayer('[data-readers-popover]')");
  check("已读弹层：点开后挂在 body 上、没有任何祖先裁得到它，且整块在视口内",
    readersOpen === true && fr.ok === true && fr.parentIsBody === true
      && fr.escapes === true && fr.inViewport === true,
    "开得出 + 挂 body + escapes + 在视口内",
    "开=" + readersOpen + " 挂body=" + fr.parentIsBody + " position=" + fr.position
      + " 切得到它的祖先=" + JSON.stringify(fr.clipped)
      + " 包含块破坏者=" + JSON.stringify(fr.breakers)
      + " rect=" + JSON.stringify(fr.rect) + " 视口=" + fr.vw + "x" + fr.vh);
  await cdp.eval("(function(){var el=document.querySelector('[data-readers-popover]');"
    + "if(!el)return false;"
    + "var box=el.closest('[data-reka-popper-content-wrapper]')||el;"
    + "box._o={left: box.style.left, right: box.style.right, transform: box.style.transform};"
    + "box.style.right='auto';box.style.left=(window.innerWidth - 20) + 'px';box.style.transform='none';return true;})()");
  const frOut = await cdp.eval("window.__probe.floatLayer('[data-readers-popover]')");
  check("对照：把已读弹层的 fixed 坐标推到视口右缘外 ⇒ 它必须落到视口外（证明那条判据会咬）",
    frOut.ok === true && frOut.inViewport === false,
    "inViewport === false", "rect=" + JSON.stringify(frOut.rect) + " 视口=" + frOut.vw);
  await cdp.eval("(function(){var el=document.querySelector('[data-readers-popover]');"
    + "if(!el)return false;"
    + "var box=el.closest('[data-reka-popper-content-wrapper]')||el;"
    + "if(!box._o)return false;box.style.left=box._o.left;box.style.right=box._o.right;"
    + "box.style.transform=box._o.transform;delete box._o;return true;})()");
  const frBack = await cdp.eval("window.__probe.floatLayer('[data-readers-popover]')");
  check("对照可逆：换回原锚点后整块又回到视口内",
    frBack.ok === true && frBack.inViewport === true, "inViewport === true",
    "rect=" + JSON.stringify(frBack.rect));
}

/**
 * 标题栏 × 内容浮层那一段（用户 2026-09-30：「图片预览独立窗口会遮住头部标题栏关闭最小化那块，
 * 应该只在下面内容区。所有独立窗口标题栏都不会被内容栏遮住，标题栏优先度最高」）。
 *
 * 为什么值得单开一段：这条修的是**绘制顺序 + 命中测试**，静态判据（层级现算）只能证明
 * "数字比大小成立"，证不了"那横条上的 ✕/− 与拖拽区实际还点得着"。而 `elementFromPoint`
 * 走的正是浏览器真实的命中顺序 —— 它命中标题栏，用户的鼠标才点得到。
 */
async function runCaption(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  // 先借 install 把"页面自己在用的那份 vue/pinia"接进 __probe（composeStack 依赖它们）
  await cdp.eval("window.__probe.install('/src/components/TitleBar.vue', '', '')");

  const comp = await cdp.eval('window.__probe.composeStack({})');
  check("有自绘 caption 的那一路：TitleBar 与图片遮罩真的同时挂在页面上", !!comp && comp.ok === true,
    "composeStack ok", JSON.stringify(comp));

  const a = await cdp.eval("window.__probe.stackRead()");
  check("caption 在时 TitleBar 自己申报了 has-caption（读的是那个类，不是元素）",
    a.ok === true && a.captionClass === true, "html.has-caption 存在", JSON.stringify(a));
  check("遮罩把标题栏那一条让开了（overlay 顶边不低于 caption 底边）",
    a.ok === true && a.ovTop >= a.capBottom,
    "ovTop >= capBottom(" + (a.capBottom ?? "?") + ")", JSON.stringify(a));
  check("标题栏那一条仍高于遮罩（现算两个计算样式，不抄数字）",
    a.ok === true && Number(a.capZ) > Number(a.ovZ),
    "capZ > ovZ", "capZ=" + a.capZ + " ovZ=" + a.ovZ);
  check("caption 中点实际命中的是标题栏 ⇒ ✕/− 与整窗唯一拖拽区点得着",
    a.ok === true && a.hitInCaption === true, "elementFromPoint 落在 [data-caption] 内",
    "命中 " + a.hitTag);

  // ── 窄起来的辅助窗（本轮真实缺陷那一档）──────────────────────────
  // 桌面窗拖到 ≤767px（日志窗默认就是 760×560）⇒ 布局档翻成移动布局，`html.is-mobile` 亮，
  // 而 `AuxWindowShell`/`LogViewer` 从不给 TitleBar 传 isMobile ⇒ caption 照旧在。
  // 改前那版把让位挂在 `html:not(.is-mobile)` 上 ⇒ 这一档顶边算成 0，遮罩压住标题栏、
  // 预览工具条落进标题带底下（z 85 压 z 80）。这一格就是钉它的。
  const compN = await cdp.eval('window.__probe.composeStack({ narrow: true })');
  const n = await cdp.eval("window.__probe.stackRead()");
  check("窄起来的辅助窗（移动布局档 + caption 仍在）：caption 照样申报",
    !!compN && compN.ok === true && n.ok === true && n.captionClass === true,
    "has-caption 仍在", JSON.stringify(n));
  check("同一档遮罩仍要让开标题栏（这条在改前是红的：ovTop=0 而 capBottom=28）",
    n.ok === true && n.ovTop >= n.capBottom,
    "ovTop >= capBottom(" + (n.capBottom ?? "?") + ")", JSON.stringify(n));

  // 摘掉那个类 = 合成"修之前"的几何：遮罩真的铺到顶压住标题带 —— 反面对照只能在这一档做，
  // 因为让位成立时把层级按回去照样命中（恒真，第一版就栽在测了个不存在的关系）。
  await cdp.eval("window.__probe.setCaptionClass(false)");
  const d = await cdp.eval("window.__probe.stackRead()");
  check("对照用几何：摘掉 has-caption 后遮罩确实铺到顶（所以下一条不是靠让位蒙对）",
    d.ok === true && d.ovTop <= 1, "ovTop<=1", JSON.stringify(d));
  check("即便如此，caption 中点仍命中标题栏（层级独立于让位）",
    d.ok === true && d.hitInCaption === true, "hitInCaption=true", "命中 " + d.hitTag);

  // 反面对照：按回"修之前"的形状（非定位、无层级）⇒ 同一个点必须被遮罩吃掉。
  // 少了这一条，上面那句命中判据就是恒真（遮罩没压上来时它也成立）。
  await cdp.eval("window.__probe.setCaptionStack('off')");
  const b = await cdp.eval("window.__probe.stackRead()");
  check("对照：把标题栏层级按回修之前 ⇒ 同一个点被遮罩吃掉（证明那条命中判据会咬）",
    b.ok === true && b.hitInCaption === false, "hitInCaption=false", JSON.stringify(b));
  await cdp.eval("window.__probe.setCaptionStack('on')");
  await cdp.eval("window.__probe.setCaptionClass(true)");
  const c = await cdp.eval("window.__probe.stackRead()");
  check("对照可逆：恢复后同一个点又回到标题栏（不是「测一次就把页面弄坏了」）",
    c.ok === true && c.hitInCaption === true, "hitInCaption=true", JSON.stringify(c));

  // ── 真·移动端主窗：TitleBar 自己不画 ⇒ 不许凭空留出一条 caption 高的空白 ──
  // ⚠️ narrow 也要钉上：真手机同时是移动布局档。只传 isMobile 不传 narrow 时，这一档量到的是
  // 「桌面布局 + 没有 caption」那格（实测：把键退回 :not(.is-mobile) 时这一格照样绿，
  // 因为它没进移动档）⇒ 钉上之后这一格才只由 caption 在不在决定。
  const compM = await cdp.eval('window.__probe.composeStack({ isMobile: true, narrow: true })');
  const m = await cdp.eval("window.__probe.stackRead()");
  check("移动端主窗（没有 caption）：顶边必须是 0，不许白留一条标题带",
    !!compM && compM.ok === true && m.ok === true && m.hasCaption === false
    && m.captionClass === false && m.ovTop <= 1,
    "元素与类都不在 且 ovTop<=1", JSON.stringify(m));
}

/**
 * §6.95「回车 = 一个动作」那一段（真浏览器 + 生产码里那一个家，2026-10-20）。
 *
 * 结局空间（三条互斥，缺一条就是恒绿）：
 *   干净 Enter ⇒ 触发一次（链在跑）
 *   组合中 Enter ⇒ 不触发
 *   compositionend 先于 keydown 那一拍 Enter ⇒ 不触发，**且过窗后再按必须重新触发**
 * 最后一格是把"不触发"和"永远不触发"分开的唯一办法 —— 少了它，把守卫写成
 * `enter: () => () => {}` 也能让前面两条全绿。
 */
async function runImeCommit(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.install('/src/components/ui/PrimaryBtn.vue', '', '')");

  const mount = await cdp.eval('window.__probe.imeMount()');
  check("ime 夹具挂上了：真 input 由 Vue 渲染、生产码那个家被 import 进来",
    !!mount && mount.ok === true && mount.hasField === true, "input#ime-field 存在", JSON.stringify(mount));

  // ① 正控：干净回车必须真的触发动作（这一格红了，后面两条"不触发"就毫无意义）
  const clean = await cdp.eval('window.__probe.imePress({})');
  check("干净回车 ⇒ 动作触发一次（这条红了，后面两条「不触发」就都是恒真）",
    clean.ok === true && clean.calls === 1, "calls=1", JSON.stringify(clean));

  // ② 组合进行中的回车（Windows / Android WebView 上 isComposing 还是 true 那一档）
  const during = await cdp.eval('window.__probe.imePress({ start: true, text: "nihao", composing: true })');
  check("组合进行中的回车 ⇒ 不触发（这是选字，不是提交）",
    during.ok === true && during.calls === 1, "calls 仍 1", JSON.stringify(during));

  // ③ macOS WKWebView 那一拍：compositionend 已经发完、keydown 时 isComposing=false
  const mac = await cdp.eval('window.__probe.imePress({ end: true, text: "你好" })');
  check("compositionend 先于 keydown 那一拍（isComposing 已为 false）⇒ 仍不触发",
    mac.ok === true && mac.calls === 1, "calls 仍 1", JSON.stringify(mac));

  // ④ 反向钉：把时钟推过提交窗，同一根键必须重新算成"用户真的要提交"
  await cdp.eval('window.__probe.imeWait(160)');
  const after = await cdp.eval('window.__probe.imePress({})');
  check("过窗之后再按一次干净回车 ⇒ 又触发（证明上一条不是「永远不触发」）",
    after.ok === true && after.calls === 2, "calls=2", JSON.stringify(after));

  // ⑤ 多行框那一档（真按键，不是合成事件）：裸回车留给换行，Ctrl+Enter 才提交。
  //    群公告与任务描述就是这个形状 —— 它同时钉住 Vue 的 meta/ctrl 守卫与
  //    `ime.enter(fn, $event)` 这两层，少任何一层这里就红。
  const focusArea = () => cdp.eval(`(() => {
    const t = document.getElementById('ime-area');
    if (!t) return false;
    t.focus();
    return document.activeElement === t;
  })()`);
  const keyEnterWith = async (modifiers) => {
    const base = {
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers,
    };
    // 两条同帧发出（逐条 await = 按住不放，见文件头纪律 1）
    cdp.send("Input.dispatchKeyEvent", { type: 'keyDown', ...base, text: '\r' });
    cdp.send("Input.dispatchKeyEvent", { type: 'keyUp', ...base });
    await sleep(150);
    return cdp.eval("window.__probe.imeAreaCalls");
  };
  const areaFocused = await focusArea();
  const areaPlain = await keyEnterWith(0);
  check("多行框·裸回车不提交（那一下属于换行）",
    areaFocused === true && areaPlain === 0, "imeAreaCalls=0", JSON.stringify({ areaFocused, areaPlain }));
  const areaCtrl = await (async () => { await focusArea(); return keyEnterWith(2); })();
  check("多行框·Ctrl+Enter 提交一次（群公告 / 任务描述那条）",
    areaCtrl === 1, "imeAreaCalls=1", JSON.stringify({ areaCtrl }));
}

/**
 * 弹窗 / 浮层那一段（原生体验审计的领域 F：打开与关闭、遮罩与命中、Esc、焦点陷阱与恢复、
 * 快速重复开关之后留下的残骸）。
 *
 * 为什么值得单开一段：领域 F 原先只有**静态**判据 —— designGuards 的「菜单没有遮罩」「浮层没有 Esc
 * 出口」那一族，加层级阶梯 ㉕。静态那半边能证明"源码里写了 Esc"，证不了这四件行为：
 *   ① 遮罩真挡得住点击（穿透 = 用户在弹窗背后误触，还看不见自己点着了什么）；
 *   ② Esc 按下去真关得掉，且关掉之后 DOM 里不剩东西（§八「无遗留遮罩 / 不可交互区域」）；
 *   ③ 关闭后焦点回到打开它的那颗按钮（§B「交互完成后焦点是否正确恢复」）；
 *   ④ 连开关几轮之后不往历史里漏条目（Android 返回键"要按好几下"那一族，
 *      `backStack.test.ts` 用的是**假端口**，真 `history` 上的接得对不对这一格它量不到）。
 * 四条读的都是真命中测试 / 真按键 / 真鼠标 / 真 history，不是 class 名。
 *
 * ⚠️ 口径边界（报结论必须带上）：这里挂的是**弹窗外壳本身**（BaseModal + Headless UI，slot 为空，
 *   `open` 由夹具代管、收到 close 后代关 —— 与每个调用方的写法一致）。所以量到的是模态外壳的行为，
 *   不量某个具体业务弹窗（创建群聊 / 转发…）的表单校验与提交；
 *   且按键走的是**浏览器**输入管线 ⇒ WKWebView / WebView2 那一半仍未证（归 Smoke-11）。
 */
async function runOverlay(cdp, url) {
  // 背景给两样东西：一屏垫高（"滚动锁定"这一格到底有没有作用点，由读数自己说）
  // + 一颗 fixed 的按钮（坐标固定 ⇒ "这一点命中的是谁"才有唯一答案；它自带 click 计数 ⇒ 判穿透）。
  const MOUNT_HTML =
    '<div id="spacer" style="height:300vh"></div>'
    + '<button id="opener" type="button" style="position:fixed;left:24px;bottom:24px;z-index:10">开弹窗</button>';
  const PROPS = JSON.stringify(JSON.stringify({ title: "探针弹窗", width: "max-w-sm" }));

  // 页面侧读数器 + "像真宿主一样接 close"的那 25ms 轮询。
  // ★ 为什么必须有轮询：install 的 onClose 只登记事件（固定写法），而每个真实调用方收到 close
  //   都会把 open 关掉。手工 settle 只在"我以为的那一步"补这一下 ⇒ 晚到的 close（比如 popstate
  //   引起的）没人接，量出来的"残留"其实是弹窗**正常开着**。轮询比两处过渡（150/200ms）快一个量级。
  const READER = `(() => {
    window.__openerHits = 0;
    document.getElementById('opener').addEventListener('click', () => { window.__openerHits += 1; });
    window.__ovOpen = (on) => { window.__probe.state.open = !!on; };
    window.__ovFocusOpener = () => { document.getElementById('opener').focus(); };
    // 出帧计数器（start / stop 两段，不返回 Promise ⇒ 页面冻住时也绝不把探针挂死）：
    // Headless UI 的过渡**收尾**靠的是 disposables.nextFrame = 双层 requestAnimationFrame
    // ⇒ 页面不出帧，leave 就停在第一步（类名停在 leave-from），壳永远挂在 DOM 上。
    // 所以"关掉之后还剩东西"这类读数必须先自证帧在出：帧在出 ⇒ 读数算在量界面；
    // 帧没出 ⇒ 读数只算在量量具。（2026-10-10 就是这条把一版假 P1 戳掉的。）
    window.__ovFrameStart = () => {
      window.__ovFrameN = 0;
      window.__ovFrameRun = true;
      const step = () => {
        if (!window.__ovFrameRun) return;
        window.__ovFrameN += 1;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      return true;
    };
    window.__ovFrameStop = () => { window.__ovFrameRun = false; return window.__ovFrameN; };
    window.__ovParentAuto = () => {
      let seen = window.__probe.events.filter((el) => el[0] === 'close').length;
      const tick = () => {
        const n = window.__probe.events.filter((el) => el[0] === 'close').length;
        if (n > seen) { seen = n; window.__probe.state.open = false; }
      };
      window.__ovAutoTimer = setInterval(tick, 25);
      return true;
    };
    window.__ovPoint = (which) => {
      // ✕ 按 **aria-label** 选：BaseModal 卡片形态里只有它带 aria-label（common.close）。
      // 原先取"弹窗里最后一个 button"——空 slot 时那正好是 ✕，但 D 组弹窗里有内容，
      // 于是量到的是内容里那颗（点了个没接任何东西的按钮，close 计数 0，整段结论作废）。
      let el = null;
      if (which === 'close') {
        el = document.querySelector('[role="dialog"] button[aria-label]');
        if (!el) {
          const inPanel = document.querySelectorAll('[role="dialog"] .elevated button');
          el = inPanel.length ? inPanel[inPanel.length - 1] : null;
        }
      } else {
        el = document.getElementById('opener');
      }
      if (!el) return { found: false, why: which + ' 没找到' };
      const r = el.getBoundingClientRect();
      return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    };
    window.__ovRead = () => {
      const dlgs = document.querySelectorAll('[role="dialog"]');
      const dlg = dlgs[0] || null;
      const panel = dlg ? dlg.querySelector('.elevated') : null;
      // 「挂到文档根」不再靠库自己的 portal 容器名：Reka UI 用 Vue Teleport 直接挂 body，
      // HeadlessUI 当年是 #headlessui-portal-root。判据要的是**在不在宿主子树之外**，
      // 所以从宿主根反着数 —— 换回任何一家弹层库这条都不用改。
      const mountHost = document.getElementById('mhost') || document.getElementById('probe-host');
      const portalDlgCount = [...document.querySelectorAll('[role="dialog"]')]
        .filter((d) => !mountHost || !mountHost.contains(d)).length;
      const op = document.getElementById('opener');
      const rr = op.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(rr.left + rr.width / 2), Math.round(rr.top + rr.height / 2));
      const ae = document.activeElement;
      const pr = panel ? panel.getBoundingClientRect() : null;
      const name = (m) => (m ? (m.id || m.tagName + '.' + String(m.className).slice(0, 22)) : 'null');
      return {
        openFlag: (window.__mstate || window.__probe.state).open === true,
        dlgCount: dlgs.length,
        // 宿主子树之外的 dialog 数。Reka 的 Teleport 没有自己的根节点 ⇒ 反向数才可靠。
        portalDlgCount,
        panelW: pr ? Math.round(pr.width) : 0,
        panelTop: pr ? Math.round(pr.top) : -1,
        panelBottom: pr ? Math.round(pr.bottom) : -1,
        vh: window.innerHeight,
        hitId: name(hit),
        panelOpacity: panel ? getComputedStyle(panel).opacity : '-',
        panelCls: panel ? String(panel.className) : '-',
        // 卡在哪一相位只能看类名，而 leave 那几串类在**尾部**（58 个字符正好把它们截掉）；
        // 一并读 transition-duration：F() 是按计算后的时长 setTimeout 的，时长与"没清理"同框才有解释力。
        panelTrans: panel
          ? getComputedStyle(panel).transitionProperty + " / " + getComputedStyle(panel).transitionDuration
            + " / " + getComputedStyle(panel).transitionDelay
          : '-',
        backdropOpacity: (() => {
          const g = dlg ? dlg.parentElement?.querySelector('.gosslan-dialog-overlay')
            ?? document.querySelector('.gosslan-dialog-overlay') : null;
          return g ? getComputedStyle(g).opacity : '(无遮罩节点)';
        })(),
        wrapperPE: (() => {
          const w = dlg ? dlg.querySelector('.overflow-y-auto') : null;
          return w ? getComputedStyle(w).pointerEvents : '-';
        })(),
        focusInDlg: !!dlg && !!ae && (dlg === ae || dlg.contains(ae)),
        focusId: name(ae),
        openerHits: window.__openerHits,
        closeEvents: window.__probe.events.filter((e) => e[0] === 'close').length,
        histLen: history.length,
        // ★ 我们要的其实是"当前这条条目是不是我们压的那一层"，而不是"整页有几条条目"。
        // 压入的 state 形状由 utils/backStack.ts 给（gosslanBackLayer: id），所以这一维是
        // **每条弹窗自己的**：不受同标签页里别的段（灯箱也压条目）影响，也不会被会话历史截断影响。
        // ⚠️ 这段是模板字符串里的源码 ⇒ 注释里不许出现反引号（文件头纪律 1：会把模板提前结束）。
        histLayer: history.state && history.state.gosslanBackLayer
          ? history.state.gosslanBackLayer : null,
        htmlOv: getComputedStyle(document.documentElement).overflow,
        bodyStyle: document.body.getAttribute('style') || '(无)',
        scrollY: Math.round(window.scrollY),
        docScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      };
    };
    return true;
  })()`;

  /**
   * 出帧泵：`Page.captureScreenshot` 会强制走一遍"更新渲染"，rAF 回调在那一步里跑。
   * 为什么这段非用不可（2026-10-10 实测）：headless-new 起的探针页实测 `visibilityState=hidden`
   * （文件里第 1340 行那条纪律就是为它写的），页面**静止时根本不出帧**；而 Headless UI 的
   * 过渡收尾要两帧。不泵帧就读"关掉之后"，读到的是停在 leave-from 的壳 ⇒ 那是量具的形状。
   * ⚠️ 只在本段用：不动全局启动参数（`--disable-renderer-backgrounding` 之类会把
   *   `hasFocus()`/visibilityState 一起翻掉，而 emoji 那段有一条断言正按"页面没焦点"写）。
   */
  const pump = async (times = 6) => {
    for (let i = 0; i < times; i += 1) {
      await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => {});
      await sleep(50);
    }
  };
  /** 关掉之后的一次读数：先泵帧让过渡收尾，再读 DOM。 */
  const readAfterClose = async () => {
    await pump(10);
    return await cdp.eval("window.__ovRead()");
  };
  /** 泵帧这段时间里 rAF 实际跑了几次 —— 量具自证用的就是它。 */
  const framesDuringPump = async (times = 6) => {
    await cdp.eval("window.__ovFrameStart()");
    await pump(times);
    return await cdp.eval("window.__ovFrameStop()");
  };

  /**
   * 每段自己起一次页面：一处红不许污染下一处（文件头纪律 3，同一段内串过三轮开关之后
   * DOM 里可能有东西，那时候再判"打开态只有一份"就不是在判它自己了）。
   */
  async function boot(tag) {
    // 这一段是**全量里泵帧最密**的一段（每次关闭都要 pump 10 次截图）。页面被别的窗口盖住时
    // rAF 会停、截图会挂 ⇒ 2026-10-20 全量跑到第 273 格后出现过一次 45 s 无回包（单跑 42/42 绿）。
    // 与其余十几个段同一口径：起页前先把它拉到前台并打开焦点仿真，把"被遮挡"这个变量去掉。
    await cdp.send("Page.bringToFront").catch(() => {});
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const mounted = await cdp.eval(
      "window.__probe.install('/src/components/BaseModal.vue', " + JSON.stringify(MOUNT_HTML) + ", " + PROPS + ")",
    );
    await cdp.eval(READER);
    await cdp.eval("window.__ovParentAuto()");
    await sleep(80);
    const base = await cdp.eval("window.__ovRead()");
    const ok = !!mounted && mounted.ok === true && mounted.pinia === true
      && base.dlgCount === 0 && base.openFlag === false;
    check("[" + tag + "] 干净页起起来了（BaseModal + 一颗真按钮同页、pinia 用的是页面那一份、开局没有 dialog）",
      ok, "install ok 且 pinia=true 且 dlgCount=0",
      JSON.stringify({ m: mounted, open: base.openFlag, dlg: base.dlgCount }));
    // 量具自证：这一段后面每一条"关掉之后还剩什么"都站在"页面能出帧"上。
    // ⚠️ 这条红**不是**产品红，是量具红（这台机器 / 这个 headless 页此刻不出帧）；
    // 但它必须报出来 —— 没有它，下一轮又会把停在 leave-from 的壳读成"界面上有残留层"。
    const frames = await framesDuringPump(6);
    check("[" + tag + "] 量具在出帧（泵 6 次截图这段时间里 rAF ≥ 2 次）——"
      + "关闭动画收尾要两帧；页面静止不出帧时读到的是停在动画中途的壳，那是量具的形状不是界面的形状",
      typeof frames === "number" && frames >= 2, "rAF 次数 >= 2", "实际 " + JSON.stringify(frames));
    return base;
  }

  const openModal = async () => {
    await cdp.eval("window.__ovFocusOpener()");
    await cdp.eval("window.__ovOpen(true)");
    await sleep(500); // 进入过渡 200ms + 两帧 ⇒ 量的是动画结束后的稳定几何
    await pump(4);
  };

  // ══ A 组：打开态本身（几何 / 焦点 / 遮罩命中 / 历史条目 / Tab 陷阱 / 点外部 / Esc）══
  const base = await boot("A");
  await openModal();
  const o = await cdp.eval("window.__ovRead()");
  check("A 打开后弹窗挂在**文档根**的 portal 上，且全页只有一份 dialog",
    o.openFlag === true && o.dlgCount === 1 && o.portalDlgCount === 1, "open 且两处都=1",
    "open=" + o.openFlag + " dlg=" + o.dlgCount + " portal=" + o.portalDlgCount);
  check("A 面板矩形落在视口内（桌面端窗口边缘 / 可视区域：上下都不越界）",
    o.panelW > 0 && o.panelTop >= 0 && o.panelBottom <= o.vh + 1,
    "panelTop>=0 且 panelBottom<=vh(" + o.vh + ")",
    "top=" + o.panelTop + " bottom=" + o.panelBottom + " w=" + o.panelW);
  check("A 焦点落进弹窗内部（不是留在 body 或触发按钮上）",
    o.focusInDlg === true, "focusInDlg=true", "activeElement=" + o.focusId);
  check("A 弹窗开着时，那颗背景按钮的坐标命中的**不是它**（遮罩真在前面挡着）",
    o.hitId !== 'opener', "hitId != opener", "命中 " + o.hitId);
  // ★ 这一格原先钉的是 `histLen > base.histLen`（history.length 变大），那是**量错了维度**：
  //   `history.length` 是**整个标签页**的条目总数，不是"这次打开压进去的那一条"。
  //   实测读数（`--only=lightbox,overlay`，2026-10-20）：`预期 histLen > 3 / 实际 histLen=3` ——
  //   前一段（灯箱）自己也在压/退条目并留下一段更长的会话历史，`Page.navigate` 落在有前向
  //   条目的位置时浏览器会把它们**截掉**，于是基线不是"干净页那条"，"多一条"就看不出来了；
  //   单独跑 `--only=overlay` 同一格是绿的 ⇒ 一条随跑段顺序变的判据。
  //   现在读 `history.state.gosslanBackLayer`（backStack 压进去的那条自己的标记）：
  //   每条弹窗只看**自己那一条**在不在，别人压没压、截没截都动不了它 ⇒ 与跑段顺序无关。
  //   ⚠️ 这不是放宽：旧的"条目数要涨"是新读数的必然结果（压一条同 URL 条目既涨总数也换 state），
  //   而新读数还能认出"state 被换成了别的东西"这种旧读数放过的形状。
  check("A 打开确实压了一条**我们自己的**真历史条目（读 history.state 那枚标记，不读全页条目总数）",
    o.histLayer !== null && o.histLayer !== base.histLayer,
    "histLayer 非 null 且 != 基线(" + JSON.stringify(base.histLayer) + ")",
    JSON.stringify({ layer: o.histLayer, base: base.histLayer, len: o.histLen, baseLen: base.histLen }));

  const trapIds = [];
  let trapOk = true;
  for (let i = 0; i < 5; i += 1) {
    await cdp.key("Tab", "Tab", "", 9);
    const r = await cdp.eval("window.__ovRead()");
    trapIds.push(r.focusId);
    if (r.focusInDlg !== true) trapOk = false;
  }
  check("A 连按 5 次 Tab 焦点始终没跑出弹窗（焦点陷阱由 Reka UI 提供，没被我们自己写漏）",
    trapOk === true, "五次都 focusInDlg=true", JSON.stringify(trapIds));

  // 真鼠标按下背景按钮那一点：一个动作同时判「不穿透」与「点外部关闭」
  const pt = await cdp.eval("window.__ovPoint('opener')");
  const beforeOutside = await cdp.eval("window.__ovRead()");
  await cdp.click(pt.x, pt.y);
  await sleep(500);
  const c = await readAfterClose();
  check("A 真按下遮罩那一点 ⇒ 背景按钮的 click 监听零次触发（点击不穿透到弹窗背后）",
    c.openerHits === beforeOutside.openerHits, "openerHits 不涨", "hits=" + c.openerHits);
  check("A 同一个动作就把它关掉了（点外部关闭：close 恰好一次，且 DOM 里不剩 dialog）",
    c.closeEvents === beforeOutside.closeEvents + 1 && c.openFlag === false && c.dlgCount === 0,
    "close+1 且 open=false 且 dlgCount=0",
    JSON.stringify({ cl: c.closeEvents, open: c.openFlag, dlg: c.dlgCount }));

  // 反面对照（少了它上一条"零次"可能只是坐标选错）：关掉之后同一个坐标再按 ⇒ 必须真打到按钮
  await cdp.click(pt.x, pt.y);
  await sleep(300);
  const k = await cdp.eval("window.__ovRead()");
  check("A 对照：弹窗关了以后同一个坐标再按 ⇒ 按钮收到一次真 click（证明上一条零次不是坐标选错）",
    k.openerHits === beforeOutside.openerHits + 1, "openerHits +1",
    "hits=" + k.openerHits + " 命中 " + k.hitId);

  // Esc（真按键）：关得掉、DOM 撤干净、样式回到基线；焦点必须还给打开它的那颗按钮
  await openModal();
  const beforeEsc = await cdp.eval("window.__ovRead()");
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(500);
  const e = await readAfterClose();
  check("A Esc（真按键）关得掉，且关掉后 DOM 与 body/html 样式都回到基线（§八「无遗留遮罩」）",
    e.closeEvents === beforeEsc.closeEvents + 1 && e.openFlag === false && e.dlgCount === 0
      && e.bodyStyle === base.bodyStyle && e.htmlOv === base.htmlOv,
    "close+1 且 open=false 且 dlgCount=0 且样式==基线",
    JSON.stringify({ cl: e.closeEvents, open: e.openFlag, dlg: e.dlgCount, bodyStyle: e.bodyStyle, htmlOv: e.htmlOv }));
  check("A Esc 关掉之后焦点回到打开它的那颗按钮（N14：弹层原语只管把焦点收进弹窗，"
    + "还回去这一下得有人做 —— 而那一刻 DOM 已经撤干净，所以这不是残留壳造成的）",
    e.focusId === "opener" && e.dlgCount === 0, "activeElement==opener",
    "实际 " + e.focusId + " dlg=" + e.dlgCount);

  // 反面对照：已经关了再按一次 Esc ⇒ close 计数不许再涨（证明上面两条读的是真事件）
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(250);
  const e2 = await cdp.eval("window.__ovRead()");
  check("A 对照：弹窗已关时再按 Esc 不多冒一条 close（判据读的是真事件，不是任何按键都记一笔）",
    e2.closeEvents === e.closeEvents, "close 计数不变(" + e.closeEvents + ")", "实际 " + e2.closeEvents);

  // 系统返回键那一层：真 history.back() ⇒ 弹窗收到 close 并被宿主关干净（按一次就有反应）
  await openModal();
  const beforeBack = await cdp.eval("window.__ovRead()");
  await cdp.eval("history.back()");
  await sleep(1_400); // 与 B 组同一口径：close 落地 → 宿主置假 → 离开过渡跑完，三件事排完才叫"关掉之后" 
  const bk = await readAfterClose();
  // 按一次后退 ⇒ 恰好一条 close；紧接着 DOM 撤干净（下面第二条）。
  // ⚠️ 这里以前钉着"只敢判 close 那一半"，因为另一半年年读到 dlg=1 —— 后来查明那是
  // **页面不出帧**时停在 leave-from 的壳（量具形状），不是界面的形状。见 boot() 里那条出帧判据。
  check("A 真按一次后退 ⇒ 恰好收到一条 close（Android 系统返回键走的就是这条 popstate）",
    bk.closeEvents === beforeBack.closeEvents + 1, "close 恰好 +1",
    JSON.stringify({ before: beforeBack.closeEvents, after: bk.closeEvents }));
  check("A 后退那一层关掉之后 DOM 撤干净（open=false 且 portal 里没有 dialog）——"
    + "先前那版\"留着一层看不见的壳\"是不出帧页面的形状，泵帧后这里必须是 0（§八「无遗留遮罩」）",
    bk.openFlag === false && bk.dlgCount === 0 && bk.portalDlgCount === 0,
    "open=false 且 dlg=0 且 portal=0",
    JSON.stringify({ open: bk.openFlag, dlg: bk.dlgCount, portal: bk.portalDlgCount, hit: bk.hitId }));
  // 这一格是上面那条"close 计数 +1"的另一半：回调数了不算，**当前那条历史条目要真的退回去**。
  // 钉在 state 标记上（不是条目总数）：条目总数退没退，别人在同标签页里压过就看不出来。
  check("A 后退之后当前那条历史条目换回了**打开前那一条**（真退了一层，不只是回调记了一笔）",
    bk.histLayer === base.histLayer,
    "histLayer == 基线(" + JSON.stringify(base.histLayer) + ")",
    JSON.stringify({ layer: bk.histLayer, base: base.histLayer, len: bk.histLen, baseLen: base.histLen }));

  // ══ B 组：最常用那条关闭路径单独量（右上角 ✕，真鼠标）——干净页，前面什么都不干 ══
  await boot("B");
  await openModal();
  const xb = await cdp.eval("window.__ovPoint('close')");
  check("B 弹窗里有可点的关闭按钮（✕ 那条路径有作用点）",
    xb.found === true, "found=true", JSON.stringify(xb));
  await cdp.click(xb.x, xb.y);
  await sleep(1_400); // 关 → 宿主把 open 置假 → 离开过渡 150ms，三件事得排完才叫"关掉之后"
  const x0 = await cdp.eval("window.__ovRead()"); // 只等、不泵：这一份读的是量具停在哪
  const x = await readAfterClose();               // 泵帧后读同一次关闭：这一份才叫界面
  const ptB = await cdp.eval("window.__ovPoint('opener')");
  console.log("  · 读数（不判绿红）：B 点 ✕ 后【只等不泵】dlg=" + x0.dlgCount
    + " 面板class 尾部=" + x0.panelCls.slice(-40)
    + "；【泵帧后】dlg " + x0.dlgCount + "→" + x.dlgCount + " close=" + x.closeEvents
    + " open=" + x.openFlag + " 遮罩opacity=" + x.backdropOpacity + " 命中=" + x.hitId);
  check("B 右上角 ✕ 关掉之后 DOM 撤干净（open=false 且 portal 里没有 dialog）——"
    + "§八「动画结束后不许遗留遮罩 / 不可交互区域」那一格",
    x.openFlag === false && x.dlgCount === 0 && x.portalDlgCount === 0,
    "open=false 且 dlg=0 且 portal=0",
    JSON.stringify({ open: x.openFlag, dlg: x.dlgCount, portal: x.portalDlgCount }));
  check("B 右上角 ✕ 关掉之后焦点也回到那颗按钮（两条关闭路径都要量：Esc 走弹层原语自己那条，"
    + "✕ 走宿主 emit close，发起方不一样）",
    x.focusId === "opener" && x.openFlag === false, "activeElement==opener",
    "实际 " + x.focusId + " open=" + x.openFlag);
  await cdp.click(ptB.x, ptB.y); // 关掉之后同一个坐标再真点一次：那层壳不许吃掉点击
  await sleep(300);
  const x4 = await readAfterClose();
  // 这里只判"点击落没落到按钮上"：A/B/C 的 opener 由探针直接翻 prop 打开、**不接 click**
  // （只有 D 那种生产形状的宿主才写 onClick ⇒ open）。所以"open=true"在这两组不成立，
  // 判它就是我编的规矩；命中 = opener 本身才是"那层壳没吃掉点击"的证据。
  check("B 关掉之后同一个坐标再真点 ⇒ 打得着那颗按钮（hits 恰好 +1、命中的就是 opener）",
    x4.openerHits === x.openerHits + 1 && x4.hitId === "opener",
    "hits+1 且 hitId=opener",
    JSON.stringify({ hits: x4.openerHits, base: x.openerHits, hit: x4.hitId }));

  // ══ C 组：快速连开关（每步 120ms，短于两处过渡 ⇒ 动画真被打断）——也是干净页 ══
  const cbase = await boot("C");
  for (let i = 0; i < 3; i += 1) {
    await cdp.eval("window.__ovOpen(true)");
    await sleep(120);
    await cdp.eval("window.__ovOpen(false)");
    await sleep(120);
  }
  await sleep(700);
  const f = await readAfterClose();
  check("C 连开关 3 轮（每步 120ms，短于两处过渡 ⇒ 动画真被打断）之后不剩壳："
    + "open=false 且 dlg=0 且 portal=0",
    f.openFlag === false && f.dlgCount === 0 && f.portalDlgCount === 0,
    "open=false 且 dlg=0 且 portal=0",
    JSON.stringify({ open: f.openFlag, dlg: f.dlgCount, portal: f.portalDlgCount }));
  check("C 动画被打断之后样式与滚动位回到基线（body[style]、html overflow、scrollY 三项都 == 干净页那份）",
    f.bodyStyle === cbase.bodyStyle && f.htmlOv === cbase.htmlOv && f.scrollY === cbase.scrollY,
    "三项都等于基线",
    JSON.stringify({ body: f.bodyStyle, htmlOv: f.htmlOv, y: f.scrollY }));
  const ptC = await cdp.eval("window.__ovPoint('opener')");
  await cdp.click(ptC.x, ptC.y);
  await sleep(300);
  const f2 = await readAfterClose();
  check("C 打断之后同一个坐标真点触发按钮 ⇒ 打得着那颗按钮（hits +1 且命中的就是 opener）",
    f2.openerHits === cbase.openerHits + 1 && f2.hitId === "opener",
    "hits+1 且 hitId=opener",
    JSON.stringify({ hits: f2.openerHits, base: cbase.openerHits, hit: f2.hitId }));
  // 同一维度的第三格：打断式连开关之后，**当前条目要已经退回基线那一条**（漏了条目＝返回键要按好几下）。
  // 旧版这里钉的是 `histLen <= 基线+1`：条目总数在 50 条上限内怎么涨都满足这个式子，
  // 饱和之后它变成一条恒绿判据（量不到任何东西）；换到 state 标记这维才是"我们那一条没漏在外面"。
  check("C 连开关 3 轮之后当前那条历史条目已经退回基线（我们那一条没漏在外面）",
    f.histLayer === cbase.histLayer,
    "histLayer == 基线(" + JSON.stringify(cbase.histLayer) + ")",
    JSON.stringify({ layer: f.histLayer, base: cbase.histLayer, len: f.histLen, baseLen: cbase.histLen }));

  // ══ D 组：**生产形状**的宿主（真点击开、弹窗里有 slot 内容、关闭走真实的 onClose→open=false）══
  // A/B/C 三组的 open 都是夹具直接翻 prop（`state.open = true`）、slot 是空的。
  // 那两处红到底是产品的还是夹具的，只有照 26 个调用方都用的那个形状再量一遍才知道。
  const MODAL_APP = `(() => {
    const V = window.__probe.vue;
    document.body.innerHTML = '<div id="mhost"></div>';
    const state = V.reactive({ open: false });
    window.__mstate = state;
    window.__mhits = 0;
    import('/src/components/BaseModal.vue').then((m) => {
      const BaseModal = m.default;
      const app = V.createApp({
        setup() {
          return () => V.h('div', {}, [
            V.h('div', { style: 'height:300vh' }),
            V.h('button', {
              id: 'opener', type: 'button',
              style: 'position:fixed;left:24px;bottom:24px;z-index:10',
              onClick: () => { window.__mhits += 1; state.open = true; },
            }, '开弹窗'),
            V.h(BaseModal, {
              open: state.open, title: '探针弹窗', width: 'max-w-sm',
              onClose: () => { state.open = false; },
            }, {
              default: () => V.h('div', {}, [
                V.h('input', { id: 'field', placeholder: '群名' }),
                V.h('button', { id: 'ok', type: 'button' }, '确定'),
              ]),
            }),
          ]);
        },
      });
      if (window.__pinia) app.use(window.__pinia);
      app.mount(document.getElementById('mhost'));
      window.__mmounted = true;
    });
    return true;
  })()`;
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.install('/src/components/TitleBar.vue', '', '')");
  await cdp.eval(MODAL_APP);
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    ready = await cdp.eval("window.__mmounted === true");
    if (!ready) await sleep(250);
  }
  // 挂载完了才装读数器：READER 里那句 `#opener` 的 click 计数就是这么挂上的（挂早了元素还不存在）
  await cdp.eval(READER);
  check("D 生产形状的宿主挂起来了（真按钮 + 弹窗里带 input 与确定那颗）",
    ready === true, "__mmounted=true", JSON.stringify(await cdp.eval("window.__ovRead()")));
  const d0 = await cdp.eval("window.__ovRead()");
  const dpt = await cdp.eval("window.__ovPoint('opener')");

  await cdp.click(dpt.x, dpt.y); // 真的点触发按钮（26 个调用方都是这个形状）
  await sleep(600);
  const d1 = await cdp.eval("window.__ovRead()");
  check("D 真点触发按钮 ⇒ 弹窗打开且全页只有一份（slot 里的内容也在）",
    d1.openFlag === true && d1.dlgCount === 1 && d1.focusInDlg === true,
    "open=true 且 dlg=1 且焦点在弹窗里",
    JSON.stringify({ open: d1.openFlag, dlg: d1.dlgCount, focus: d1.focusId, hits: d1.openerHits }));

  const dxb = await cdp.eval("window.__ovPoint('close')");
  await cdp.click(dxb.x, dxb.y); // 真点右上角 ✕
  await sleep(700);
  const d2 = await readAfterClose();
  check("D 生产形状（真点按钮开、真点 ✕ 关、宿主 open 变假）也撤干净且焦点回到那颗按钮："
    + "open=false 且 dlg=0 且 portal=0 且 activeElement==opener —— 26 个调用方都是这个形状，这条才是定性依据",
    d2.openFlag === false && d2.dlgCount === 0 && d2.portalDlgCount === 0 && d2.focusId === "opener",
    "open=false 且 dlg=0 且 portal=0 且焦点==opener",
    JSON.stringify({ open: d2.openFlag, dlg: d2.dlgCount, hit: d2.hitId, focus: d2.focusId }));
  console.log("  · 读数（不判绿红）：D 生产形状关掉之后焦点=" + d2.focusId + " 命中=" + d2.hitId
    + "（这一组的按钮真的接 onClick ⇒ 判完焦点，同坐标那一发已经另有一条判据在打）");

  await cdp.click(dpt.x, dpt.y); // 关掉之后同一坐标再真点一次
  await sleep(400);
  const d3 = await readAfterClose();
  check("D 生产形状：关掉之后同一个坐标再真点 ⇒ 打得开（hits 恰好 +1、弹窗又只有一份）",
    d3.openerHits === d2.openerHits + 1 && d3.openFlag === true && d3.dlgCount === 1,
    "hits+1 且 open=true 且 dlg=1",
    JSON.stringify({ hits: d3.openerHits, base: d2.openerHits, open: d3.openFlag, dlg: d3.dlgCount }));

  await cdp.eval("window.__ovOpen(false)");
  await sleep(400);

  // 读数，不判据：这一格在本应用里到底有没有作用点，只有实测说得出（写进文档，别凭猜）
  console.log("  · 读数（不判绿红）：文档层可滚=" + base.docScrollable
    + " / 打开时 html overflow=" + o.htmlOv + " body[style]=" + o.bodyStyle
    + " / 关闭后 html overflow=" + base.htmlOv + " ⇒ 「滚动锁定」判的是「关闭后必须回到基线」那一半");

  // ══ E 组：减少动效档（prefers-reduced-motion: reduce）下这层浮层还能不能用（§七 第 8 项）══
  // 为什么这一档要单独量（不是"少了段动画"那么轻）：应用侧对 reduce 的反应只有 CSS 那一处 ——
  // `src/style.css:558` 把**所有**元素的 transition-duration 打成 `0.01ms !important`
  // （现算：`grep -rn "prefers-reduced-motion" src` ⇒ style.css / boot/skeleton.css / utils/haptics.ts 三处，
  // BaseModal 与 Headless UI 都没有 JS 版的开关）。而 Headless UI 的收尾排的是"计算后的时长"
  // （见上面 panelTrans 那条注释）⇒ 这一档换掉的是**时序**，不是"少了段动画"那么轻，
  // 关不掉的壳、还不回去的焦点都可能只在这档出现。
  // ⚠️ 顺序要紧：先证仿真档位真落到了这一页，再判"能不能开 / 关 / 留不留中间态"。反过来做的话，
  // 若仿真根本没生效，下面每一条"reduce 下没事"都只是在把普通档再判一遍（INV-P31 第 4 条）。
  // ⚠️ 仿真的落点必须用 body，不能用面板（2026-10-10 现量，第一版就是我把它写成"面板 ≥1ms"而报红）：
  // 面板那 150ms 只挂在 Headless UI **过渡期间临时加**的那串类上，过渡落定就撤 ⇒
  // 落定后普通档读回 `0s`、reduce 档反而读回 `1e-05s`（那条 `*` 的 !important 恒作用）。
  // 换句话说：想证"仿真生效"，量一个本来就没有过渡的节点；面板能证的只有"过渡进行中的时长"，
  // 而那一段在 reduce 下只有 0.01ms，泵帧之间早就走完了 ⇒ 这台量具读不到"150ms 被缩短"那一半（照旧未证）。
  const durMs = (s) => {
    // "property / duration / delay"，duration 段可能是逗号列表 ⇒ 取最大那个。
    // 浏览器会把它印成 `1e-05s` ⇒ 先认单位后缀再换算，别 parseFloat 完就当毫秒（这条坑踩过）。
    const seg = String(s).split(" / ")[1] || "";
    let best = null;
    for (const raw of seg.split(",")) {
      const t = raw.trim();
      const v = parseFloat(t);
      if (!Number.isFinite(v)) continue;
      const ms = /ms$/.test(t) ? v : v * 1000;
      if (best === null || ms > best) best = ms;
    }
    return best;
  };
  const bodyTrans = async () => await cdp.eval("(() => {"
    + "const cs = getComputedStyle(document.body);"
    + "return cs.transitionProperty + ' / ' + cs.transitionDuration + ' / ' + cs.transitionDelay;"
    + "})()");
  const emulateReduce = (on) => cdp.send("Emulation.setEmulatedMedia", {
    features: on ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [],
  });

  const ebase = await boot("E");
  const bodyPlain = durMs(await bodyTrans());
  // 普通档那份面板时长（同一页、同一形状）：没有它，"这一档换了时序"就只是一句口头话
  await openModal();
  const plainRead = await cdp.eval("window.__ovRead()");
  const plainPanelDur = durMs(plainRead.panelTrans);
  await cdp.eval("window.__ovOpen(false)");
  await readAfterClose();

  await emulateReduce(true);
  const mmReduce = await cdp.eval('matchMedia("(prefers-reduced-motion: reduce)").matches === true');
  const bodyReduce = durMs(await bodyTrans());
  await openModal();
  const e1 = await cdp.eval("window.__ovRead()");
  const reducePanelDur = durMs(e1.panelTrans);
  check("E 仿真档位真的落到了这一页（matchMedia 为真 **且** body 的计算时长从 " + bodyPlain
    + "ms 变成 " + bodyReduce + "ms —— 那就是 style.css:562 那条 `!important` 落下来的值）"
    + "；面板那两份（普通=" + plainPanelDur + "ms / reduce=" + reducePanelDur + "ms）一起打印当形状，不参与判绿红"
    + "——下面每一条都站在这条上，这条红＝量具红不是产品红",
    mmReduce === true && bodyReduce !== null && bodyReduce > 0 && bodyReduce < 1
      && bodyReduce !== bodyPlain,
    "matches=true 且 body 时长落在 (0,1)ms 且 != 普通档那份",
    JSON.stringify({ mm: mmReduce, bodyReduce, bodyPlain, reducePanelDur, plainPanelDur, panelTrans: e1.panelTrans }));
  check("E 减少动效下照样打得开：全页一份 dialog、焦点落进弹窗、面板计算样式是可见的（opacity=1）"
    + "（约束五：关掉动画不许顺手把界面也关掉）",
    e1.openFlag === true && e1.dlgCount === 1 && e1.portalDlgCount === 1
      && e1.focusInDlg === true && e1.panelOpacity === "1"
      && e1.panelW > 0 && e1.panelTop >= 0 && e1.panelBottom <= e1.vh + 1,
    "open 且 dlg=1 且 portal=1 且焦点在内 且 opacity=1 且几何在视口内",
    JSON.stringify({ open: e1.openFlag, dlg: e1.dlgCount, portal: e1.portalDlgCount, focus: e1.focusId, opacity: e1.panelOpacity, top: e1.panelTop, bottom: e1.panelBottom, vh: e1.vh }));

  const eClose = await cdp.eval("window.__ovPoint('close')");
  await cdp.click(eClose.x, eClose.y); // 真点 ✕（B 组那条最常用的路径），reduce 下重走一遍
  await sleep(700);
  const rdClose = await readAfterClose();
  check("E reduce 下真点 ✕ 关得掉且撤干净：close 恰好 +1 且 open=false 且 dlg=0 且 portal=0"
    + " 且 body/html 样式回到基线（§八「动画结束后不许遗留遮罩」——这档没动画可等，最容易露出「收尾靠动画」的那一半）",
    rdClose.closeEvents === e1.closeEvents + 1 && rdClose.openFlag === false && rdClose.dlgCount === 0
      && rdClose.portalDlgCount === 0 && rdClose.bodyStyle === ebase.bodyStyle && rdClose.htmlOv === ebase.htmlOv,
    "close+1 且 open=false 且 dlg=0 且 portal=0 且样式==基线",
    JSON.stringify({ cl: rdClose.closeEvents, base: e1.closeEvents, open: rdClose.openFlag, dlg: rdClose.dlgCount, portal: rdClose.portalDlgCount, body: rdClose.bodyStyle, htmlOv: rdClose.htmlOv }));
  check("E reduce 下 ✕ 那条也焦点归还（activeElement==opener）——N14 那个 @after-leave 是挂在离开过渡的"
    + "**结束事件**上的，时长被掐成 0.01ms 之后它到底还响不响，只有这一条说得出",
    rdClose.focusId === "opener" && rdClose.dlgCount === 0, "activeElement==opener",
    "实际 " + rdClose.focusId + " dlg=" + rdClose.dlgCount);

  const eOpener = await cdp.eval("window.__ovPoint('opener')");
  await cdp.click(eOpener.x, eOpener.y); // 关掉之后同一坐标再真点：那层壳不许吃掉点击
  await sleep(300);
  const e3 = await cdp.eval("window.__ovRead()");
  check("E reduce 关掉后同一坐标再真点 ⇒ 打得着那颗按钮（hits 恰好 +1 且命中的就是 opener）"
    + " ⇒ 掐掉时长没留下「看不见但接得住点击」的一层",
    e3.openerHits === rdClose.openerHits + 1 && e3.hitId === "opener" && e3.dlgCount === 0,
    "hits+1 且 hitId=opener 且 dlg=0",
    JSON.stringify({ hits: e3.openerHits, base: rdClose.openerHits, hit: e3.hitId, dlg: e3.dlgCount }));

  await openModal();
  await cdp.key("Escape", "Escape", "", 27); // 真按键：弹层原语自己那条路径
  await sleep(700);
  const e4 = await readAfterClose();
  check("E reduce 下 Esc（真按键）也关得掉、DOM 撤净、焦点回到那颗按钮（两条关闭路径的发起方不一样，都得在这档量一遍）",
    e4.closeEvents === e3.closeEvents + 1 && e4.openFlag === false && e4.dlgCount === 0
      && e4.portalDlgCount === 0 && e4.focusId === "opener",
    "close+1 且 open=false 且 dlg=0 且 portal=0 且焦点==opener",
    JSON.stringify({ cl: e4.closeEvents, base: e3.closeEvents, open: e4.openFlag, dlg: e4.dlgCount, focus: e4.focusId }));

  // 反面对照 + 收尾必须做的一件事：这一段用的是**会话级**仿真，而 emoji / search / taskCard 那几段
  // 共用同一个 CDP 页面会话 ⇒ 不撤掉 reduce，后面每一段都是在被判"动画已关"的那一页。
  // 撤完还要现读一次时长：它回到普通档那一发，才证明上面那组读的是仿真档位、不是巧合。
  await emulateReduce(false);
  const mmBack = await cdp.eval('matchMedia("(prefers-reduced-motion: reduce)").matches === true');
  const bodyBack = durMs(await bodyTrans());
  await openModal();
  const e5 = await cdp.eval("window.__ovRead()");
  await cdp.eval("window.__ovOpen(false)");
  await readAfterClose();
  check("E 反面对照：把仿真撤掉 ⇒ matches=false 且 body 那份时长从 " + bodyReduce
    + "ms 退回 " + bodyBack + "ms（==普通档那一发 " + bodyPlain + "ms）"
    + " —— 上面那组判的确实是 reduce 档（不是恒真判据），且这次会话级开关没漏进后面的段（emoji / search / taskCard 共用同一个页面会话）",
    mmBack === false && bodyBack === bodyPlain,
    "matches=false 且 body 时长==普通档那份",
    JSON.stringify({ mm: mmBack, bodyBack, bodyPlain, bodyReduce, panelTrans: e5.panelTrans }));
  console.log("  · 读数（不判绿红）：E 面板时长 普通=" + plainPanelDur + "ms / reduce=" + reducePanelDur
    + "ms / 撤掉后=" + durMs(e5.panelTrans) + "ms（落定态读的是 0s 与那条 !important 的差，不是那 150ms —— "
    + "过渡进行中的时长这台量具读不到，那一半仍未证）；关闭后 focus=" + rdClose.focusId
    + " hit=" + e3.hitId + "（这一组的 ✕ 与 Esc 两条路径都真的走过）");
}

/** 表情面板那一段：键盘出口（N1）+ 反向对照（不带 text 的 Enter 必须零次激活）。 */
async function runEmoji(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  // ★ 先往本机账里种 8 条常用，**再**装组件（`usage` 是在 setup 里读的，装完再写就晚了）。
  //   不种这一步，`frequentCount` 恒为 0 ⇒ 「常用」那一行连它上面的小标题根本不渲染，
  //   于是下面那批键盘判据量不到本轮新加的那个占一整行的标题元素 —— 而它正是最可能
  //   把"整行步长"弄错的东西（标题不是按钮，但它在按钮之前占了一行）。
  //   token 从组件自己那份全表现读，不在这份脚本里手抄表情名。
  const table = await cdp.eval(
    "(async () => { const m = await import('/src/utils/emoji.ts');" +
      " return { tokens: m.EMOJIS.slice(0, 8).map((e) => e.displayName), total: m.EMOJIS.length }; })()",
  );
  const seed = {};
  table.tokens.forEach((tk, i) => { seed[tk] = { n: 90 - i, t: 1 }; });
  await cdp.eval(
    `localStorage.setItem('gosslan.emojiUsage.v1', ${JSON.stringify(JSON.stringify(seed))})`,
  );
  await cdp.eval(`window.__probe.install('/src/components/EmojiPicker.vue',
    '<button id="trigger" data-probe-panel>触发按钮</button>')`);
  const info = () => cdp.eval("window.__probe.gridInfo()");

  // 面板里格子的列数由布局决定，而 ↑↓ 的步长写的是组件里的 COLS。
  // 这两处不同步的表现就是"上下键跳错行"，所以列数从布局现读、且**不许回退成猜的常数**
  // （回退了就等于拿我自己写的 8 去验它写的 8）。
  await cdp.eval("window.__probe.focusTrigger()");
  await cdp.eval("window.__probe.setOpen(true)");
  const cols = await cdp.eval("window.__probe.cols()");
  const first = await info();

  // ---------------- 本轮新增：「常用」那一行的形状（用户 2026-10-09） ----------------
  const head = await cdp.eval("window.__probe.gridHead()");
  check("「常用」那一行上面有小标题，且它是网格第一个子元素、且不是 button",
    head.tag !== 'none' && head.tag !== 'BUTTON' && head.text.length > 0,
    "第一个子元素有文字且不是按钮（是按钮就会挤进键盘步长）", JSON.stringify(head));

  const cells = await cdp.eval("window.__probe.emojiCells()");
  const freq = cells.filter((c) => c.freq);
  const matrix = cells.slice(table.tokens.length);
  const matrixAlts = matrix.map((c) => c.alt);

  const labels = await cdp.eval("window.__probe.gridLabels()");
  const labelTexts = labels.map((l) => l.text);
  check("两段各有一行小标题，顺序是「常用」在前、「全部表情」在后（用户 2026-10-09 参照图）",
    labelTexts.length === 2 && labelTexts[0].length > 0 && labelTexts[1].length > 0,
    "两个非按钮子元素、都有文字", JSON.stringify(labels));
  check("对照：两行标题都不是 button（是按钮就会挤进键盘整行步长）",
    labels.every((l) => l.tag !== 'BUTTON'), "全是 div", JSON.stringify(labels.map((l) => l.tag)));
  check("「全部表情」那一行确实落在两段交界处（在最后一格常用之后、第一格矩阵之前）",
    labels.length === 2 && freq.length > 0
      && labels[1].y > freq[freq.length - 1].y && labels[1].y < matrix[0].y,
    "标题 y 夹在两段之间", JSON.stringify({
      标题y: labels[1] && labels[1].y,
      末格常用y: freq[freq.length - 1] && freq[freq.length - 1].y,
      首格矩阵y: matrix[0] && matrix[0].y,
    }));

  check("常用那一行渲染出来了（种了几条就该有几格带常用标记）",
    freq.length === table.tokens.length, `${table.tokens.length} 格`, freq.length);
  check("格子总数 = 常用那一行 + **完整**一张表（矩阵没被摘走几格）",
    cells.length === table.tokens.length + table.total,
    `${table.tokens.length}+${table.total}`, cells.length);
  check("矩阵段自己零重复（它是原样那张表，不是常用段的复制）",
    new Set(matrixAlts).size === matrixAlts.length, "无重复",
    `去重后 ${new Set(matrixAlts).size} / 共 ${matrixAlts.length}`);
  check("每个常用表情仍留在矩阵段里（「下面不随上面变化」的正面判据）",
    freq.every((c) => matrixAlts.includes(c.alt)), "常用那几个在原序里都还在",
    JSON.stringify(freq.map((c) => c.alt).filter((a) => !matrixAlts.includes(a))));
  check("对照：同一表情两格，只有常用那一格**真的被染色**（读计算后的背景色，不是标记属性）",
    cells[0].freq === true && matrix[0].freq === false
      && cells[0].bg !== matrix[0].bg && cells[0].alt === matrix[0].alt,
    "第 0 格与矩阵同一格：alt 相同、背景色不同", JSON.stringify([cells[0], matrix[0]]));
  check("对照：小标题那一行没把常用行挤成不满一行（现读列数仍是 8 的整行）",
    cols > 1 && freq.every((c) => c.y === freq[0].y) && new Set(freq.map((c) => c.x)).size === freq.length,
    "常用那一行的格子同一 y、x 各不相同", `${cols} 列 / ${freq.length} 格`);

  check("打开面板：焦点落在第一格（键盘用户不该从头再 Tab 一遍）",
    first.focusIdx === 0 && first.count > 0, "焦点=第 0 格且格子数 >0",
    `focusIdx=${first.focusIdx} count=${first.count}`);
  check("列数量得出来（现读布局；量不出来说明面板没真渲染出网格）",
    cols > 1, ">1", cols);

  await cdp.key("ArrowRight", "ArrowRight", "", 39);
  const right = await info();
  check("→ 让焦点右移恰好一格", right.focusIdx === 1, "focusIdx=1", right.focusIdx);
  await cdp.key("ArrowLeft", "ArrowLeft", "", 37);
  const left = await info();
  check("← 让焦点左移恰好一格", left.focusIdx === 0, "focusIdx=0", left.focusIdx);

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const down = await info();
  check("↓ 走的是**整行**：位移等于现读的列数（COLS 与真实布局一旦不同步这里就红）",
    cols > 1 && down.focusIdx === cols, `focusIdx=${cols}`,
    `${down.focusIdx} / 列数=${cols}`);
  check("↓ 之后横向位置没变（跳错行的真实表现就是 x 偏移）",
    down.x === first.x && down.y > first.y, `x=${first.x} 且 y 变大`,
    `x=${down.x} y=${down.y}（原 y=${first.y}）`);
  await cdp.key("ArrowUp", "ArrowUp", "", 38);
  const up = await info();
  check("↑ 走回同一格", up.focusIdx === 0 && up.x === first.x, "focusIdx=0 且 x 不变",
    `${up.focusIdx} / x=${up.x}`);

  await cdp.key("ArrowLeft", "ArrowLeft", "", 37);
  const clamp = await info();
  check("首格再按 ← 不越界、也不丢焦点（不钳住的话焦点掉回 body，读屏用户丢了位置）",
    clamp.focusIdx === 0, "focusIdx=0", `${clamp.focusIdx} (focusId=${clamp.focusId})`);

  // 反向对照：Enter **不带 text** 时浏览器不会激活被聚焦的 button ⇒ 必须零次 select。
  // 这条不是装饰：没有它，"Enter 选中"那格可能只是探针自己造出来的假绿。
  await cdp.eval("window.__probe.reset()");
  await cdp.key("Enter", "Enter", "", 13);
  const noText = await cdp.eval("window.__probe.events.length");
  check("对照：Enter 不带 text ⇒ 零次激活（证明下面那条不是恒过）",
    noText === 0, "0 次", `${noText} 次`);

  await cdp.eval("window.__probe.reset()");
  await cdp.key("Enter", "Enter", "\r", 13);
  const enterEv = await cdp.eval("window.__probe.events");
  const enterClicks = await cdp.eval("window.__probe.clicks");
  check("Enter 选中当前格：恰好一次 select，且 click 与 emit 一一对应",
    enterEv.length === 1 && enterEv[0][0] === "select" && enterClicks === 1,
    "1 次 select / 1 次 click", `${JSON.stringify(enterEv)} / clicks=${enterClicks}`);

  await cdp.eval("window.__probe.reset()");
  await cdp.key(" ", "Space", " ", 32);
  const spaceEv = await cdp.eval("window.__probe.events");
  check("空格同样选中一次（不该出现「一次按下塞两份」）",
    spaceEv.length === 1 && spaceEv[0][0] === "select", "1 次 select", JSON.stringify(spaceEv));

  await cdp.eval("window.__probe.reset()");
  await cdp.key("Escape", "Escape", "", 27);
  const escEv = await cdp.eval("window.__probe.events");
  check("Esc 关面板：emit 一次 close", escEv.length === 1 && escEv[0][0] === "close",
    "1 次 close", JSON.stringify(escEv));
  // 父组件（这里就是夹具）收到 close 才把 open 翻回 false —— 与真实调用方一致
  await cdp.eval("window.__probe.setOpen(false)");
  const after = await info();
  check("关掉之后焦点**还给触发按钮**（不还就等于键盘用户要从页头重走一遍）",
    after.triggerActive === true, "activeElement 是那个按钮", JSON.stringify(after));

  // ---------------- 第二趟：**账是空的**（新设备）那一档长什么样 ----------------
  // 用户 2026-10-09 明确要的那半句："在没有常用数据的时候，常用表情模块消失只有全部表情"。
  // 必须重新 navigate 再装：`usage` 是在组件 setup 里一次性读 localStorage 的，
  // 装完再清账不会让已经挂起来的那块面板变回去；而在同一页里再装一次会留下第二个面板，
  // `buttons()` 会把两块的格子混着数（探针纪律 3：段与段之间不共享浮层状态）。
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("localStorage.removeItem('gosslan.emojiUsage.v1')");
  await cdp.eval(`window.__probe.install('/src/components/EmojiPicker.vue',
    '<button id="trigger" data-probe-panel>触发按钮</button>')`);
  await cdp.eval("window.__probe.focusTrigger()");
  await cdp.eval("window.__probe.setOpen(true)");
  const emptyLabels = await cdp.eval("window.__probe.gridLabels()");
  const emptyCells = await cdp.eval("window.__probe.emojiCells()");
  check("没有常用数据时：只剩「全部表情」一个标题，「常用」那一节整个消失",
    emptyLabels.length === 1 && emptyLabels[0].text.length > 0
      && emptyLabels[0].tag !== 'BUTTON',
    "恰好一个非按钮标题", JSON.stringify(emptyLabels));
  check("没有常用数据时：格子就是完整那张表，一格不多（常用段没留空位）",
    emptyCells.length === table.total && emptyCells.every((c) => c.freq === false),
    `${table.total} 格且无常用标记`, `${emptyCells.length} 格`);
  check("没有常用数据时：网格第一个子元素就是「全部表情」标题（不是某格按钮）",
    (await cdp.eval("window.__probe.gridFirstChildTag()")) === 'DIV',
    "DIV", await cdp.eval("window.__probe.gridFirstChildTag()"));
  const emptyCols = await cdp.eval("window.__probe.cols()");
  check("没有常用数据时列数仍是 8（少一节标题不该把布局换成另一档）",
    emptyCols > 1 && emptyCols === cols, `与有账那一趟同为 ${cols}`, `${emptyCols}`);
}

/**
 * 搜索弹窗那一段（原生感走查 N2）。这一格里最要紧的不是"方向键能动"，而是
 * **回车打开的必须是高亮那一条** —— 旧行为是鼠标与回车都固定开 `messages[0]`，
 * 也就是"看起来在选、实际打开的是第一条"。所以判据钉的是 emit 出去的 msgId 本身。
 */
/**
 * 运行日志独立窗（--only=logs）。
 *
 * 2026-10-19 开发环境白屏的两个真实根因都在这里判：
 *  ① `useVirtualizer` 的 options computed 在 setup 里**立即**读取 `mergedRows`，而
 *     `mergedRows` 声明在后面 ⇒ Vue dev 抛 `Cannot access 'mergedRows' before
 *     initialization`（TDZ），LogViewer 整棵子树退化成注释节点；
 *  ② 独立窗分支的滚动容器漏了 `ref="logScroll"` ⇒ virtualizer 拿不到滚动元素，
 *     工具栏能显示"N 条"但列表区永远为空。
 * 判据只看可观察结局：standalone 挂载后必须有虚拟行、只渲染视口附近、滚到底换成旧日志。
 */
/**
 * 语言切换的真实浏览器验收（P1「相对日期交给 vue-i18n + dayjs」那一改的运行时证据）。
 *
 * 为什么必须真跑一次：这条改动的**全部意义**是"英文界面不再出现中文时间"。
 * 单测读的是词典原文与 dayjs 的 locale 数据，两者都证不了**调用点真的把 t 注了进来**
 * （少一个参数，vue-i18n 的回落会把裸 key 直接印到界面上）。
 * 所以这里在真 Chrome 里挂一条"昨天正午"的消息，切语言，读分割线那一行的**文本**。
 */
async function runLocale(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const CJK = /[\u3400-\u9FFF\u3040-\u30FF]/;
  const mount = async (daysAgo) => {
    const ts = await cdp.eval("(() => { var d = new Date(); d.setHours(12, 0, 0, 0);"
      + ` d.setDate(d.getDate() - ${daysAgo}); return d.getTime(); })()`);
    const props = {
      message: {
        msg_id: `m-locale-${daysAgo}`, sender_id: "dev-me", kind: "text",
        content: "语言切换夹具：这一行的分割线文本必须跟着语言走。", ts,
        conv_id: "c-locale", seq: 1,
      },
      canReact: false, isGroup: false, senderName: "我",
    };
    return cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
      + JSON.stringify(JSON.stringify(props)) + ")");
  };
  const divider = () => cdp.eval("(() => { var d = document.querySelector('[data-time-divider]');"
    + "return d ? d.textContent.trim() : null; })()");
  const setLang = (p) => cdp.eval("(async () => { var m = await import('/src/i18n/index.ts');"
    + ` m.applyPreference('${p}'); return m.currentLocale(); })()`);

  const mounted = await mount(1);
  check("语言段：消息行挂出来了（分割线才有得读）",
    !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));

  const zh = await divider();
  check("中文档：昨天那条出「昨天 HH:mm」（不是裸 key、不是英文）",
    typeof zh === "string" && /^昨天 \d{2}:\d{2}$/.test(zh), "文本匹配 ^昨天 HH:mm$", JSON.stringify(zh));

  const toEn = await setLang("en-US");
  check("切到英文档（i18n 出口返回当前语言）", toEn === "en-US", "currentLocale() == en-US", JSON.stringify(toEn));
  await sleep(250);

  const en = await divider();
  check("英文档：同一条整行没有中日韩字，且是「Yesterday HH:mm」（改之前这里印的就是中文）",
    typeof en === "string" && en.length > 0 && !CJK.test(en) && /^Yesterday \d{2}:\d{2}$/.test(en),
    "无 CJK 且匹配 ^Yesterday HH:mm$", JSON.stringify(en));

  /*
   * 一周内那一支的星期名**不在我们的词典里** —— 它是 dayjs 自带的 locale 数据。
   * 这一条判的是"换语言时 dayjs 也跟着切"：没切的话英文界面会报出「周三」。
   */
  const mountedW = await mount(3);
  check("语言段：换挂一条三天前的消息（走一周内那一支）",
    !!mountedW && mountedW.ok === true, "install ok", JSON.stringify(mountedW));
  await sleep(150);
  const enWeek = await divider();
  check("英文档·一周内：星期名是 ASCII（Sat/Mon…），不是中文「周…」",
    /^[A-Za-z]{3} \d{2}:\d{2}$/.test(String(enWeek)) && !CJK.test(String(enWeek)),
    "匹配 ^Ascii HH:mm 且无 CJK", JSON.stringify(enWeek));

  const backZh = await setLang("zh-CN");
  await sleep(200);
  const zhWeek = await divider();
  check("切回中文档：星期名又变回「周…」⇒ 两个出口跟的是同一个语言事实源",
    backZh === "zh-CN" && /^周. \d{2}:\d{2}$/.test(String(zhWeek)),
    "currentLocale()==zh-CN 且匹配 ^周? HH:mm", JSON.stringify({ backZh, zhWeek }));
}

async function runRowPair(cdp, url) {
  /*
   * 「渲染 ↔ 估高」的成对核对（§6.65）。
   *
   * 为什么还要这一段：§6.63/§6.64 已经把分割行与昵称行的**判定**并成一个家，
   * 但判定一致 ≠ 占位一致。虚拟列表按 `estimateMessageHeight` 排布、界面按模板画，
   * 「这一行到底占多少 px」只有量矩形才知道 —— `messageHeight` 文件头写的
   * 「相邻消息互相遮挡」那类事故，历次都是从**占位**与画法不一致来的，不是从判定不一致来的。
   *
   * 三条口径（别改回去）：
   * 1. **只比差值，不把像素写进探针**。断言形如「估高的差 == 真画出的差」；
   *    一旦把 `TIME_DIVIDER`(32) / `NICKNAME_ROW`(18) 抄到这儿，就是给那两个常量开第二个家，
   *    改渲染时探针会跟着一起撒谎（这正是本专项在收的那种错）。
   * 2. **先证非空转**。差值本身必须 > 0 —— 否则「0 == 0」也能让配对判据假绿。
   * 3. **边界按判定的原话打**：恰好 5 分钟要画（`>=`），差 1 秒不画。
   *    把 `>=` 改成 `>` 只会红在「恰好 5 分钟」那一格，别指望它红在配对那一格。
   */
  const BASE = 1_700_000_000_000;
  const MIN = 60_000;
  /** 挂一条正文消息 + 一条 `ts = BASE - gapMs` 的上文；`isGroup` 决定昵称行那一支；
   *  `kind` 换气泡种类（text / code / file / merge / todo），`content` 给该种类要的载荷。 */
  const mount = async (gapMs, isGroup, kind = "text", content = null, senderId = "peer-a") => {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const bodyByKind = {
      text: "这一条只用来量高度：写成一行不折行的短文本。",
      code: "SELECT id FROM messages WHERE conv_id = 'c' ORDER BY seq;",
      file: JSON.stringify({ name: "季度报告.pdf", path: "/tmp/report.pdf", size: 123456 }),
      merge: JSON.stringify({
        title: "群聊的聊天记录",
        items: [{ sender: "甲", text: "第一条" }, { sender: "乙", text: "第二条" }],
      }),
      // 用户截图里第三种带尖角的就是群任务卡片：只给 parseTodo 认的最低限度字段。
      todo: JSON.stringify({
        todo_id: "t-rowpair", title: "季度报告复核", status: "pending",
        creator: "peer-a", assignees: ["peer-a"], priority: "normal",
        category: "normal", number: 1,
      }),
    };
    const props = {
      message: {
        msg_id: "m-rowpair", sender_id: senderId, kind,
        content: content ?? bodyByKind[kind] ?? bodyByKind.text,
        ts: BASE, conv_id: "c-rowpair", seq: 2,
      },
      prev: {
        msg_id: "m-rowpair-prev", sender_id: senderId, kind: "text",
        content: "上一条。", ts: BASE - gapMs, conv_id: "c-rowpair", seq: 1,
      },
      canReact: false, isGroup: !!isGroup, senderName: "对方",
    };
    const r = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
      + JSON.stringify(JSON.stringify(props)) + ")");
    // 自己的消息（右列）必须先种身份再量：`mine` 由 app.device.device_id 现推。
    // seedDevice 依赖 install 之后的 pinia ⇒ 只能在挂载之后调，且 store 变了组件会自己重渲染。
    if (senderId !== "peer-a") {
      await cdp.eval("window.__probe.seedDevice('" + senderId + "')");
      await sleep(250);
    }
    await sleep(350);
    return !!r && r.ok === true;
  };
  /*
   * 一次读齐要量的三个数：
   * · `row`：组件根（`.group/msg`，挂在 `#probe-host` 下的第一层）的盒高 —— 虚拟列表排的就是这一格；
   * · `divider`：`[data-time-divider]` 的盒高（没画就是 null）；
   * · `nick`：昵称行自己占的纵向空间，用「消息行顶边 − 那一列顶边」量。
   *   这样 `mb-[7px]` 挂在昵称行还是挂在别的什么元素上都不影响读数，比量昵称盒更稳。
   */
  const geom = () => cdp.eval(`(() => {
    const host = document.getElementById('probe-host');
    const root = host && host.firstElementChild;
    if (!root) return null;
    const col = document.querySelector('[data-msg-col]');
    const div = document.querySelector('[data-time-divider]');
    const kids = col ? [...col.children] : [];
    const nick = kids.find((el) => el.textContent.trim() === '对方') || null;
    const rowEl = nick ? kids[kids.indexOf(nick) + 1] : null;
    // 尖角与头像的竖向中心：尾巴"对着头像"这件事只有量两条中心线才判得出来，
    // 而且它同时是 MessageItem 那个 --bubble-tail-offset(18) 与 CSS 那句 calc 的成对核对 ——
    // 昵称行改了高度而这里没跟着改，两数就会岔开。
    // ★ 2026-10-23 追加：群聊里**尖角不许越出气泡顶边**（tailTop - bubbleTop）。
    // 上一版把尖角中心对到头像中心（= 气泡顶边），于是上半截露在气泡外面，用户截图里
    // 就是"插在昵称行上的一面小旗"，所以这一格改成量顶边包含关系，不再量中心重合。
    const tail = document.querySelector('.bubble-tail');
    const avatar = root.querySelector('.gosslan-avatar-box');
    const tr = tail ? tail.getBoundingClientRect() : null;
    const ar = avatar ? avatar.getBoundingClientRect() : null;
    // 2026-10-23 口径反转：单聊不显示头像 ⇒ 尾巴改成**贴底角向下**，群聊不渲染尾巴。
    // 所以这里量的是「尾巴露在气泡下沿外多少」与「上半截压进气泡多少」，不再量侧向 reach。
    const bubble = tail ? tail.parentElement : rowEl;
    const br = bubble ? bubble.getBoundingClientRect() : null;
    const isMine = tail ? /tail-mine/.test(tail.className) : null;
    const bcs = bubble ? getComputedStyle(bubble) : null;
    const cornerRad = bcs ? parseFloat(bcs.borderBottomRightRadius) : null;
    const lineEl = tail ? tail.querySelector('.tail-line') : null;
    const tailStroke = lineEl ? getComputedStyle(lineEl).stroke : null;
    const bubbleLine = bcs ? (isMine ? bcs.borderRightColor : bcs.borderLeftColor) : null;
    // 代码卡片**没有描边**（designGuards 与组件注释都写着"去掉了四边描边"），它的线色是卡片线 token。
    // 这里把 token 解析成真实颜色，供"尾巴描边 == 它那条线"逐种气泡核对。
    const probeEl = document.createElement("span");
    probeEl.style.color = "var(--gosslan-card-line)";
    document.body.appendChild(probeEl);
    const cardLineColor = getComputedStyle(probeEl).color;
    probeEl.remove();
    const tailBelowBubble = tr && br ? +(tr.bottom - br.bottom).toFixed(2) : null;
    const tailInsideBubble = tr && br ? +(br.bottom - tr.top).toFixed(2) : null;
    const tailCount = document.querySelectorAll('.bubble-tail').length;
    const groupAvatarCount = root.querySelectorAll('.gosslan-avatar-box').length;
    const nickCount = [...document.querySelectorAll('[data-msg-col]')]
      .reduce((n, col) => n + [...col.children].filter((el) => el.textContent.trim() === '对方').length, 0);
    return {
      row: +root.getBoundingClientRect().height.toFixed(2),
      divider: div ? +div.getBoundingClientRect().height.toFixed(2) : null,
      nick: nick && rowEl
        ? +(rowEl.getBoundingClientRect().top - col.getBoundingClientRect().top).toFixed(2)
        : null,
      bubbleTop: br ? +br.top.toFixed(2) : null,
      bubbleBottom: br ? +br.bottom.toFixed(2) : null,
      tailTop: tr ? +tr.top.toFixed(2) : null,
      tailBottom: tr ? +tr.bottom.toFixed(2) : null,
      tailBelowBubble,
      tailInsideBubble,
      tailCount,
      groupAvatarCount,
      nickCount,
      isMine,
      cornerRad,
      tailStroke,
      bubbleLine,
      cardLineColor,
    };
  })()`);
  /** 估高端现算：引的是应用自己那份 `messageHeight`，这里不重述任何高度常量。 */
  const est = (gapMs, isGroup) => cdp.eval("(async () => {"
    + " const H = await import('/src/utils/messageHeight.ts');"
    + " const B = " + BASE + ";"
    + " const m = { msg_id: 'm-rowpair', sender_id: 'peer-a', kind: 'text',"
    + "   content: '估高用的正文（与 DOM 那段不必同字，两条判据比的都是差值）', ts: B, conv_id: 'c', seq: 2 };"
    + " const prev = { msg_id: 'm-rowpair-prev', sender_id: 'peer-a', kind: 'text',"
    + "   content: '上一条', ts: B - " + gapMs + ", conv_id: 'c', seq: 1 };"
    + " return H.estimateMessageHeight(m, 1, { messages: [prev, m], isGroup: "
    + (isGroup ? "true" : "false") + ", selfId: 'dev-me', fontSize: 'md' }); })()");

  const FAR = 6 * MIN;
  const NEAR = 4 * MIN;
  const EXACT = 5 * MIN;
  const SHORT = 5 * MIN - 1_000;

  // ============ 判定真的穿过组件跑到了 DOM ============
  check("行配对：挂出与上一条间隔 6 分钟的那条", await mount(FAR, false), "install 成功");
  const gFar = await geom();
  const eFar = await est(FAR, false);
  check("间隔 6 分钟：`[data-time-divider]` 画出来了",
    !!gFar && typeof gFar.divider === "number", "分割行存在", JSON.stringify(gFar));

  check("行配对：挂出间隔 4 分钟的那条", await mount(NEAR, false), "install 成功");
  const gNear = await geom();
  const eNear = await est(NEAR, false);
  check("间隔 4 分钟：分割行不画",
    !!gNear && gNear.divider === null, "分割行不存在", JSON.stringify(gNear));

  check("行配对：挂出间隔恰好 5 分钟的那条", await mount(EXACT, false), "install 成功");
  const gExact = await geom();
  check("边界·恰好 5 分钟：判定是 `>=` ⇒ 这一格必须画（改成 `>` 只红在这儿）",
    !!gExact && typeof gExact.divider === "number", "分割行存在", JSON.stringify(gExact));

  check("行配对：挂出间隔 5 分钟差 1 秒的那条", await mount(SHORT, false), "install 成功");
  const gShort = await geom();
  check("边界·差 1 秒：不画（阈值不许被往回收紧）",
    !!gShort && gShort.divider === null, "分割行不存在", JSON.stringify(gShort));

  // ============ 占位配对：估高多给的那一段 == 真多画出来的那一段 ============
  const dEst = +(Number(eFar) - Number(eNear)).toFixed(2);
  const dRow = gFar && gNear ? +(gFar.row - gNear.row).toFixed(2) : NaN;
  console.log("  · 高度实测表（配对判据只比差值，这几行是把绝对数留下当档案）："
    + JSON.stringify({
      rowFar: gFar && gFar.row, rowNear: gNear && gNear.row,
      dividerBox: gFar && gFar.divider, estFar: eFar, estNear: eNear, dEst, dRow,
    }));
  check("非空转·分割行：估高的差与画出的差都 > 0（否则配对判据会靠 0==0 假绿）",
    dEst > 0 && dRow > 0, "两者都大于 0", JSON.stringify({ dEst, dRow, eFar, eNear }));
  check("分割行占位配对：估高多算的那一段 == 这一行真多出来的高度（|差| <= 1px）",
    Math.abs(dEst - dRow) <= 1, "两者相差 <= 1px",
    JSON.stringify({ dEst, dRow, dividerBox: gFar && gFar.divider }));

  // ============ 昵称行（同族的另一格：群聊里多出的那一行）============
  check("行配对：群聊里挂出对方发的那条", await mount(FAR, true), "install 成功");
  const gGroup = await geom();
  check("昵称行：群聊·对方那条真画出昵称行（读得到它占的那一段）",
    !!gGroup && typeof gGroup.nick === "number", "读到昵称行", JSON.stringify(gGroup));
  const eGroup = await est(FAR, true);
  const eDm = await est(FAR, false);
  const dNickEst = +(Number(eGroup) - Number(eDm)).toFixed(2);
  const dNickRow = gGroup ? gGroup.nick : NaN;
  console.log("  · 昵称行实测：" + JSON.stringify({ eGroup, eDm, dNickEst, dNickRow }));
  check("非空转·昵称行：群/单聊的估高差 > 0，且渲染端昵称行占位 > 0",
    dNickEst > 0 && dNickRow > 0, "两者都大于 0", JSON.stringify({ dNickEst, dNickRow }));
  check("昵称行占位配对：估高的「群聊 − 单聊」差 == 渲染端昵称行占的那一段（|差| <= 1px）",
    Math.abs(dNickEst - dNickRow) <= 1, "两者相差 <= 1px",
    JSON.stringify({ dNickEst, dNickRow }));

  // ============ 尾巴（2026-10-23 口径反转）============
  // 单聊：不显示头像 ⇒ 尾巴贴在气泡**底角向下**，上半截压进气泡盖住底边描边；
  // 群聊：整条不渲染（用户：「群聊去掉」）。
  console.log("  · 尾巴实测：" + JSON.stringify({
    dm: gFar && { tailCount: gFar.tailCount, below: gFar.tailBelowBubble, inside: gFar.tailInsideBubble },
    group: gGroup && { tailCount: gGroup.tailCount, avatars: gGroup.groupAvatarCount, nicks: gGroup.nickCount },
  }));
  check("非空转·尾巴：单聊读到了尾巴矩形与气泡矩形",
    !!gFar && typeof gFar.tailBelowBubble === "number" && typeof gFar.tailInsideBubble === "number",
    "读数都是数", JSON.stringify(gFar && { below: gFar.tailBelowBubble, inside: gFar.tailInsideBubble }));
  check("单聊·尾巴露在气泡下沿外 5~9px（贴底角向下，不是一个贴边的点）",
    !!gFar && gFar.tailBelowBubble >= 5 && gFar.tailBelowBubble <= 9,
    "5 <= below <= 9", JSON.stringify({ below: gFar && gFar.tailBelowBubble }));
  check("单聊·尾巴上半截压进气泡 6~10px（盖住底边那段描边 ⇒ 接缝无台阶）",
    !!gFar && gFar.tailInsideBubble >= 6 && gFar.tailInsideBubble <= 10,
    "6 <= inside <= 10", JSON.stringify({ inside: gFar && gFar.tailInsideBubble }));
  check("单聊·描边与气泡边框同色：SVG 描边 == 气泡那一侧的 border 色",
    !!gFar && typeof gFar.tailStroke === "string" && gFar.tailStroke === gFar.bubbleLine,
    "stroke == 同侧 border 色", JSON.stringify({ tailStroke: gFar && gFar.tailStroke, bubbleLine: gFar && gFar.bubbleLine }));
  check("群聊·整条消息不渲染尾巴",
    !!gGroup && gGroup.tailCount === 0, "tailCount == 0", JSON.stringify({ tailCount: gGroup && gGroup.tailCount }));
  check("群聊·自己那条也不渲染尾巴（再挂一次：dev-me）",
    await mount(FAR, true, "text", null, "dev-me").then(async () => {
      const g = await geom();
      return !!g && g.tailCount === 0;
    }),
    "tailCount == 0", "自己·群聊");
  check("群聊·对方那条只画一个头像（组首身份信息）",
    !!gGroup && gGroup.groupAvatarCount === 1, "avatars == 1", JSON.stringify({ avatars: gGroup && gGroup.groupAvatarCount }));

  // 取证帧：群聊·对方那一条，正好是用户截图里"尾巴断开"的形状，人眼可复核
  if (SHOT_PATH) {
    await mount(FAR, true);
    // PROBE_LIGHT=1 时把 store 的 dark 翻成 false 再拍一张浅色帧（用户的截图是浅色）。
    // 注意：只摘 html.dark 不够 —— 气泡配色是 `resolveChatColors(..., app.dark)` 在 JS 里算的，
    // 必须翻 store，颜色才会真的按浅色重算。只影响取证，不动判据。
    if (process.env.PROBE_LIGHT === "1") {
      await cdp.eval(`(async () => {
        const piniaUrl = performance.getEntriesByType('resource')
          .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
        if (!piniaUrl || !window.__pinia) return 'no-pinia';
        const P = await import(piniaUrl);
        const A = await import('/src/stores/useAppStore.ts');
        P.setActivePinia(window.__pinia);
        A.useAppStore().dark = false;
        document.documentElement.classList.remove('dark');
        return 'ok';
      })()`);
      await sleep(400);
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-tail.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 尖角取证帧 → " + SHOT_PATH.replace(/\.png$/, "-tail.png"));
  }

  // ---- 其余气泡种类（用户 2026-10-23：「把所有的气泡尾巴都检查下」）----
  // 新口径（同日第二次反转）：单聊保留尾巴（贴底角向下），群聊整条不渲染。
  // 每一格单聊/群聊各一遍：单聊量「露在气泡外 / 压进气泡」两个数，群聊量"根本没有尾巴"。
  const TAIL_KINDS = [
    ["代码气泡", "code"], ["文件气泡", "file"], ["合并转发卡片", "merge"],
    ["群任务卡片", "todo"],
  ];
  for (const [kindLabel, kind] of TAIL_KINDS) {
    // 单聊：尾巴必须在，且几何与文本气泡一致（同一个 CSS 家 ⇒ 不同组件不该有不同读数）
    check("行配对：挂一条" + kindLabel + "（单聊）", await mount(FAR, false, kind), "install 成功");
    const gDm = await geom();
    console.log("  · " + kindLabel + "尾巴实测（单聊）："
      + JSON.stringify(gDm && { count: gDm.tailCount, below: gDm.tailBelowBubble, inside: gDm.tailInsideBubble }));
    check("非空转·" + kindLabel + "（单聊）：读到尾巴矩形与气泡矩形",
      !!gDm && typeof gDm.tailBelowBubble === "number" && typeof gDm.tailInsideBubble === "number",
      "读数都是数", JSON.stringify(gDm && { below: gDm.tailBelowBubble, inside: gDm.tailInsideBubble }));
    check("单聊·" + kindLabel + "尾巴：露在气泡外 5~9px 且压进气泡 6~10px",
      !!gDm && gDm.tailBelowBubble >= 5 && gDm.tailBelowBubble <= 9
        && gDm.tailInsideBubble >= 6 && gDm.tailInsideBubble <= 10,
      "5~9 / 6~10", JSON.stringify({ kindLabel, below: gDm && gDm.tailBelowBubble, inside: gDm && gDm.tailInsideBubble }));
    // 文本/文件/合并/待办有 1px 描边 ⇒ 比 border 色；代码卡片**无描边** ⇒ 比卡片线 token（它唯一的线）。
    const wantLine = kind === "code" ? (gDm && gDm.cardLineColor) : (gDm && gDm.bubbleLine);
    check("单聊·" + kindLabel + "尾巴描边与它那条边线同色（有描边比 border，无描边的代码卡片比卡片线 token）",
      !!gDm && typeof gDm.tailStroke === "string" && gDm.tailStroke === wantLine,
      "stroke == 期望线色", JSON.stringify({ kindLabel, tailStroke: gDm && gDm.tailStroke, wantLine }));

    // 群聊：这一种也不许有尾巴（自己的那条另有一条，见上面）
    check("行配对：挂一条" + kindLabel + "（群聊）", await mount(FAR, true, kind), "install 成功");
    const gGroupKind = await geom();
    check("群聊·" + kindLabel + "整条不渲染尾巴",
      !!gGroupKind && gGroupKind.tailCount === 0, "tailCount == 0",
      JSON.stringify({ kindLabel, tailCount: gGroupKind && gGroupKind.tailCount }));
  }
  /*
   * 反向对照：把尾巴往下推 20px，同一把尺子必须读到「露在外面」明显变大。
   * 不碰源码，只证明 tailBelowBubble 这个量具不是恒绿 —— 判据红时能归因到几何本身。
   */
  await mount(FAR, false, "text");
  const reverseBelow = await cdp.eval(`(() => {
    const tail = document.querySelector('.bubble-tail');
    if (!tail) return null;
    const bubble = tail.parentElement;
    const prevBottom = tail.style.bottom;
    tail.style.bottom = '-20px';
    const below = +(tail.getBoundingClientRect().bottom - bubble.getBoundingClientRect().bottom).toFixed(2);
    tail.style.bottom = prevBottom;
    return below;
  })()`);
  console.log("  · 反向对照·尾巴下坠：" + JSON.stringify({ reverseBelow }));
  check("反向对照·尾巴露头量具：把尾巴下推 20px 时同一把尺子读到 > 12px（判据不是恒绿）",
    typeof reverseBelow === "number" && reverseBelow > 12,
    "读到 > 12px", JSON.stringify({ reverseBelow }));

  // ============ 主题矩阵：7 套气泡配色 × 明暗（渲染端真取色） ============
  // 需求：「至少验证现有浅色、深色，以及蓝/绿/紫/粉/灰…」—— 这里不看源码常量，
  // 而是把 UI 真的切到每一套，读**计算色**再算 WCAG 对比度。纯函数那一半在
  // `chatStyle.test.ts`（7 主题 × 2 档）；本段补的是"DOM 真的用上了这套色"。
  const rgbOf = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => Number(x.trim()));
    return [p[0], p[1], p[2]];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return +((x + 0.05) / (y + 0.05)).toFixed(2);
  };
  const setTheme = (preset, dark) => cdp.eval(`(async () => {
    const piniaUrl = performance.getEntriesByType('resource')
      .map((e) => e.name || '').find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));
    if (!piniaUrl || !window.__pinia) return 'no-pinia';
    const P = await import(piniaUrl);
    const A = await import('/src/stores/useAppStore.ts');
    P.setActivePinia(window.__pinia);
    const s = A.useAppStore();
    s.chatStyle = { ...s.chatStyle, preset: ${JSON.stringify(preset)} };
    // ⚠️ dark 是 computed（由 appearance + 系统偏好解析而来）—— 直接写 s.dark = true
    // **不会报错也不会生效**，第一个版本的矩阵因此 14 格读数全等却全绿。真正的写入口是 appearance。
    s.appearance = ${dark ? "'dark'" : "'light'"};
    document.documentElement.classList.toggle('dark', ${dark ? "true" : "false"});
    return { ok: 'ok', dark: s.dark, preset: s.chatStyle.preset };
  })()`);
  const readBubbleColors = () => cdp.eval(`(() => {
    const el = document.querySelector('.gosslan-bubble-text');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.style.color = 'var(--gosslan-chat)';
    document.body.appendChild(probe);
    const canvas = getComputedStyle(probe).color;
    probe.remove();
    return {
      bg: cs.backgroundColor, fg: cs.color, canvas,
      radius: parseFloat(cs.borderTopLeftRadius),
      width: +el.getBoundingClientRect().width.toFixed(1),
    };
  })()`);
  const wasDark = await cdp.eval("document.documentElement.classList.contains('dark')");
  const PRESETS = ["theme", "classic", "mint", "amber", "celadon", "rose", "slate"];
  const combos = [];
  for (const preset of PRESETS) for (const dark of [false, true]) combos.push({ preset, dark });

  // ⚠️ 不能每格都重新 install：install 失败时旧 DOM 还在，14 行读数会**完全一样**却全绿。
  // 这里改成「挂一次，改 store，读 14 次」—— 顺带量的就是"换主题后气泡真的重渲染了"。
  const colorsFor = async (senderId) => {
    const okMount = await mount(FAR, false, "text", null, senderId);
    check("主题矩阵：挂出 " + senderId + " 的那条", okMount, "install 成功", String(okMount));
    const out = [];
    for (const c of combos) {
      const st = await setTheme(c.preset, c.dark);
      check("主题矩阵：切换生效 " + c.preset + (c.dark ? "/暗" : "/亮"),
        !!st && st.ok === "ok" && st.dark === c.dark && st.preset === c.preset,
        "store 解析出预期档位", JSON.stringify(st));
      await sleep(140);
      const col = await readBubbleColors();
      out.push({ ...c, ...(col || {}) });
    }
    return out;
  };
  const mineRows = await colorsFor("dev-me");
  const otherRows = await colorsFor("peer-a");

  const matrix = [];
  for (let i = 0; i < combos.length; i++) {
    const other = otherRows[i];
    const mineC = mineRows[i];
    const oBg = rgbOf(other && other.bg);
    const oFg = rgbOf(other && other.fg);
    const mBg = rgbOf(mineC && mineC.bg);
    const mFg = rgbOf(mineC && mineC.fg);
    const canvas = other && rgbOf(other.canvas);
    const row = {
      preset: other.preset,
      dark: other.dark,
      other: other && { bg: other.bg, fg: other.fg },
      mine: mineC && { bg: mineC.bg, fg: mineC.fg },
      canvas: other && other.canvas,
      otherContrast: oBg && oFg ? contrast(oFg, oBg) : null,
      mineContrast: mBg && mFg ? contrast(mFg, mBg) : null,
      otherVsCanvas: oBg && canvas ? contrast(oBg, canvas) : null,
      radius: other && other.radius,
    };
    matrix.push(row);
    const tag = "主题 " + row.preset + (row.dark ? "/暗" : "/亮");
    check(tag + "：对方气泡 正文/底色 对比度 >= 4.5",
      row.otherContrast !== null && row.otherContrast >= 4.5, ">= 4.5", JSON.stringify(row));
    check(tag + "：自己气泡 正文/底色 对比度 >= 4.5",
      row.mineContrast !== null && row.mineContrast >= 4.5, ">= 4.5", JSON.stringify(row));
    check(tag + "：发送方与接收方底色不同（不靠阴影区分归属）",
      !!row.other && !!row.mine && row.other.bg !== row.mine.bg,
      "两侧底色不同", JSON.stringify({ other: row.other && row.other.bg, mine: row.mine && row.mine.bg }));
    check(tag + "：对方气泡与聊天画布可分辨（>= 1.1）",
      row.otherVsCanvas !== null && row.otherVsCanvas >= 1.1, ">= 1.1",
      JSON.stringify({ otherVsCanvas: row.otherVsCanvas, canvas: row.canvas }));
    check(tag + "：气泡圆角落在 17~19px",
      row.radius !== null && row.radius >= 17 && row.radius <= 19, "17~19", JSON.stringify({ radius: row.radius }));
  }
  const distinctOther = new Set(matrix.map((r) => r.other && r.other.bg)).size;
  const distinctMine = new Set(matrix.map((r) => r.mine && r.mine.bg)).size;
  console.log("  · 主题矩阵（" + matrix.length + " 格 / 对方底色 " + distinctOther
    + " 种 / 自己底色 " + distinctMine + " 种）：" + JSON.stringify(matrix.map((r) => ({
      p: r.preset, d: r.dark, oc: r.otherContrast, mc: r.mineContrast, vc: r.otherVsCanvas, rad: r.radius,
    }))));
  // ★ 非空转：如果 store 切换没生效，上面 14 格会**全等**——那是最典型的假绿。
  // 7 套预设至少 4 种不同底色、明暗两档必须让**自己的**底色不同（暗色实底 vs 亮色浅底）。
  check("主题矩阵非空转：7 套预设至少落在 4 种不同的自己气泡底色上",
    distinctMine >= 4, ">= 4 种", JSON.stringify({ distinctMine, distinctOther }));
  const lightMine = matrix.find((r) => !r.dark && r.preset === "classic");
  const darkMine = matrix.find((r) => r.dark && r.preset === "classic");
  check("主题矩阵非空转：同一套预设的亮/暗两档气泡底色不同",
    !!lightMine && !!darkMine && lightMine.mine.bg !== darkMine.mine.bg,
    "亮暗不同色", JSON.stringify({ light: lightMine && lightMine.mine.bg, dark: darkMine && darkMine.mine.bg }));
  await setTheme("theme", wasDark === true);

  // ============ 连续消息组：组内/组间距、相邻圆角、身份信息各出现几次 ============
  /*
   * 这一段补的是前面所有段都量不到的一格：**多条消息同时挂在树上**时的相对几何。
   * `mount()` 一次只挂一条，所以「组内 2~4px / 组间 8~12px」「相邻两侧压成小圆角」
   * 「连续消息不重复展示头像与昵称」这几条设计口径一直没有运行时凭据 ——
   * 单条挂载时上间距由 `needsTopPad && atGroupStart` 决定，而 atGroupStart 恰好恒真，
   * 于是"间距变小"这件事在单挂形态下**根本不可能被观察到**（不是没测到，是没有）。
   *
   * 三条口径：
   * 1. **档位由应用自己算**：这里的 first/middle/last/single 不是探针手写的，
   *    而是在页面里 import 正牌 `messageKinds.groupSide` + `previewMetrics.shouldShowTimeDivider`
   *    按 ChatWindow.groupSideAt 的同一条映射现算 —— 探的是「判定 → prop → CSS → 像素」整条链。
   * 2. **只比相对量**：组内间距必须**严格小于**组间间距，且两侧都落在设计基线区间里；
   *    不把 4/6/10px 写成第三个家（常数仍只在 messageKinds 与 style.css 那两处）。
   * 3. **反向对照另挂一版**：同一组消息改成"全同一个发送者" ⇒ 原本那条组间距必须变成组内距、
   *    头像与昵称必须从 2 个塌成 1 个。塌不动就说明这些读数与发送者归属无关，量具是假的。
   */
  const STACK = [
    { sender: "peer-a", name: "甲" },
    { sender: "peer-a", name: "甲" },
    { sender: "peer-a", name: "甲" },
    { sender: "peer-a", name: "甲" },
    { sender: "peer-b", name: "乙" },
  ];
  /** 造出与 ChatWindow 喂给 MessageItem 完全同形的 props（prev 取上一条消息本体）。 */
  const stackMsgs = (senders) => senders.map((sid, i) => ({
    msg_id: "m-stack-" + i, sender_id: sid, kind: "text",
    content: "第 " + (i + 1) + " 条：连续消息组的间距与圆角量具。",
    ts: BASE + i * MIN, conv_id: "g-stack", seq: i + 1,
  }));
  /** 页面里现算档位：与 `ChatWindow.groupSideAt` 逐字段同形（unread 这一段恒为 -1，不带未读分界）。 */
  const stackSides = (msgs) => cdp.eval(`(async () => {
    const M = await import('/src/utils/messageKinds.ts');
    const P = await import('/src/utils/previewMetrics.ts');
    const msgs = ${JSON.stringify(msgs)};
    const pick = (m) => (m ? { kind: m.kind, senderId: m.sender_id, ts: m.ts } : null);
    return msgs.map((cur, index) => M.groupSide({
      kind: cur.kind, senderId: cur.sender_id, ts: cur.ts,
      prev: pick(msgs[index - 1]),
      next: pick(msgs[index + 1]),
      breakAbove: P.shouldShowTimeDivider(cur.ts, msgs[index - 1] ? msgs[index - 1].ts : null),
      breakBelow: msgs[index + 1]
        ? P.shouldShowTimeDivider(msgs[index + 1].ts, cur.ts) : false,
    }));
  })()`);
  const stackMount = async (msgs, sides) => {
    const props = msgs.map((m, i) => ({
      message: m,
      prev: i > 0 ? msgs[i - 1] : null,
      isGroup: true,
      groupSide: sides[i],
      senderName: STACK[i].name,
      canReact: false,
    }));
    const r = await cdp.eval("window.__probe.installMessages("
      + JSON.stringify(JSON.stringify(props)) + ")");
    await sleep(600);
    return !!r && r.ok === true;
  };
  /**
   * 逐条读气泡矩形 + 四角半径 + 昵称行，外加整列的头像数。
   * 昵称行没有 data-* 锚点 ⇒ 按"该列里文本正好等于昵称的那个子节点"认（内容行文本更长，不会撞）。
   *
   * ⚠️ 间距量的是**「上一条气泡下沿 → 本条第一个可见块上沿」**（`gap`），不是气泡到气泡。
   * 第一版量的后者，换发送者那一格读到 28px ⇒ 看着像"组间距做错了"，其实是**尺子把昵称行
   * 算进了间距**：新的一组先画 18px 的身份行再画气泡，那 18px 是身份信息占的，不是留白。
   * 设计口径里「组间距 8~12px」说的是两组**之间**的空，身份行属于下一组自己。
   * 所以这里两列都留：`gap` 拿去断言，`bubbleGap`（气泡到气泡）只打印不判 —— 它就是观感上
   * 那一屏的实际空档，将来要按它定口径得先改设计基线，不能悄悄换量具。
   */
  const stackGeom = () => cdp.eval(`(() => {
    const cols = [...document.querySelectorAll('#probe-host [data-msg-col]')];
    const rows = cols.map((col) => {
      const bub = col.querySelector('.gosslan-bubble-text');
      if (!bub) return null;
      const r = bub.getBoundingClientRect();
      const cr = col.getBoundingClientRect();
      const cs = getComputedStyle(bub);
      const rowEl = col.parentElement;
      // 组首画的是真头像（MessageAvatar 的盒子），组内画的是一个 aria-hidden 的等宽空位。
      // 两者读成同一宽度，气泡左缘才不会逐行跳 —— 这两处**分属两个文件**，所以只能这么量。
      const box = rowEl ? rowEl.querySelector('.gosslan-avatar-box') : null;
      const spacer = rowEl ? rowEl.querySelector(':scope > [aria-hidden="true"]') : null;
      const nicks = [...col.children].filter((el) => {
        const t = el.textContent.trim();
        return t === '甲' || t === '乙';
      }).length;
      return {
        pos: col.getAttribute('data-pos'),
        top: +r.top.toFixed(1),
        bottom: +r.bottom.toFixed(1),
        colTop: +cr.top.toFixed(1),
        left: +cr.left.toFixed(1),
        avatarW: box ? +box.getBoundingClientRect().width.toFixed(1) : -1,
        spacerW: spacer ? +spacer.getBoundingClientRect().width.toFixed(1) : -1,
        radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius,
          cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v)),
        nicks,
      };
    });
    return { rows, avatars: document.querySelectorAll('#probe-host .gosslan-avatar-box').length };
  })()`);
  /** 组间/组内的留白：上一条气泡下沿 → 本条第一个可见块上沿。 */
  const gapsOf = (rows) => rows.slice(1).map((r, i) => +(r.colTop - rows[i].bottom).toFixed(1));
  /** 观感上的整段空档（含下一组的身份行）：只打印，不参与判定。 */
  const bubbleGapsOf = (rows) => rows.slice(1).map((r, i) => +(r.top - rows[i].bottom).toFixed(1));
  const tight = (v) => typeof v === "number" && v >= 5 && v <= 8;
  const full = (v) => typeof v === "number" && v >= 17 && v <= 19;

  const msgsMixed = stackMsgs(STACK.map((s) => s.sender));
  const sidesMixed = await stackSides(msgsMixed);
  check("连续消息组：判定端先给出预期档位（首/中/中/尾/独）",
    Array.isArray(sidesMixed) && String(sidesMixed) === "first,middle,middle,last,single",
    "first,middle,middle,last,single", JSON.stringify(sidesMixed));
  check("连续消息组：五条挂上树", await stackMount(msgsMixed, sidesMixed), "installMessages ok", "");
  const mixed = await stackGeom();
  const gaps = gapsOf(mixed.rows || []);
  console.log("  · 连续组读数：pos=" + JSON.stringify((mixed.rows || []).map((r) => r && r.pos))
    + " 留白=" + JSON.stringify(gaps)
    + " 含身份行的观感空档=" + JSON.stringify(bubbleGapsOf(mixed.rows || []))
    + " 头像=" + mixed.avatars
    + " 四角=" + JSON.stringify((mixed.rows || []).map((r) => r && r.radii)));
  check("连续消息组：五条都在树上且档位逐条落进 data-pos",
    (mixed.rows || []).length === 5
      && String((mixed.rows || []).map((r) => r.pos)) === sidesMixed.join(","),
    "5 行且 data-pos == 判定结果", JSON.stringify((mixed.rows || []).map((r) => r.pos)));
  // 组内三格留白（0→1、1→2、2→3）：设计基线 2~4px。
  check("连续消息组：组内相邻留白落在 2~4px（三格全查）",
    gaps.slice(0, 3).every((g) => g >= 2 && g <= 4), "2~4", JSON.stringify(gaps.slice(0, 3)));
  // 组间那一格（3→4，换发送者）：设计基线 8~12px，且必须**严格大于**组内。
  check("连续消息组：换发送者那一格的组间留白落在 8~12px",
    typeof gaps[3] === "number" && gaps[3] >= 8 && gaps[3] <= 12, "8~12", JSON.stringify({ gap: gaps[3] }));
  check("连续消息组非空转：组间留白比组内至少大 4px",
    typeof gaps[3] === "number" && gaps.slice(0, 3).every((g) => gaps[3] - g >= 4),
    "差 >= 4", JSON.stringify({ gaps }));
  // 相邻那一侧压成小圆角（5~8px），外侧仍是 17~19px 的胶囊。
  const radiusOk = (row, wantTop, wantBottom) => !!row
    && (wantTop ? tight(row.radii[0]) && tight(row.radii[1])
      : full(row.radii[0]) && full(row.radii[1]))
    && (wantBottom ? tight(row.radii[2]) && tight(row.radii[3])
      : full(row.radii[2]) && full(row.radii[3]));
  check("连续消息组：组首上圆角=胶囊、下圆角（接下一条）=小角",
    radiusOk(mixed.rows[0], false, true), "上 17~19 / 下 5~8", JSON.stringify(mixed.rows[0] && mixed.rows[0].radii));
  check("连续消息组：组中上下都压成小角",
    radiusOk(mixed.rows[1], true, true) && radiusOk(mixed.rows[2], true, true),
    "四角 5~8", JSON.stringify([mixed.rows[1] && mixed.rows[1].radii, mixed.rows[2] && mixed.rows[2].radii]));
  check("连续消息组：组尾上小角、下胶囊",
    radiusOk(mixed.rows[3], true, false), "上 5~8 / 下 17~19", JSON.stringify(mixed.rows[3] && mixed.rows[3].radii));
  check("连续消息组：换发送者那条（独占一组）四角都是胶囊",
    radiusOk(mixed.rows[4], false, false), "四角 17~19", JSON.stringify(mixed.rows[4] && mixed.rows[4].radii));
  // 身份信息只在组首出现：4 条同一人 + 1 条换人 ⇒ 头像与昵称各 2，不是 5。
  check("连续消息组：群头像只在组首出现（2 个而不是 5 个）",
    mixed.avatars === 2, "2", JSON.stringify({ avatars: mixed.avatars }));
  check("连续消息组：昵称只在组首出现（2 行而不是 5 行）",
    (mixed.rows || []).reduce((n, r) => n + (r ? r.nicks : 0), 0) === 2,
    "2", JSON.stringify((mixed.rows || []).map((r) => r && r.nicks)));

  // ── 同一条竖线：组首画的那个头像，必须和组内那个"同宽空位"一样宽 ──
  /*
   * 这一段钉的是**横向**对齐，前面所有判据量的都是纵向。头像与空位分属两个文件
   *（`MessageAvatar.vue` 的 `h-9 w-9` 类 vs `MessageItem.vue` 的 `width: var(--gosslan-msg-avatar)`
   * 内联样式），所以"同宽"这件事从来没有机器凭据 —— 一旦两边不同值，同一组里
   * 气泡左缘就逐行跳（组首 = 16+头像+8，组内 = 16+空位+8），而竖向判据全都不会红。
   * 这里读的是列的真实左缘，不读 class 也不读 CSS 变量：注释和 class 都可能说谎，
   * 像素不会。两条判据互相兜住："左缘全等"管结果，"头像宽 == 空位宽"管原因
   *（只有前者时，两侧同时改错仍会绿；只有后者时，量具读空(-1==-1)也会假绿）。
   */
  const groupRows = (mixed.rows || []).slice(0, 4);
  const lefts = groupRows.map((r) => (r ? r.left : NaN));
  const spread = +((Math.max(...lefts) - Math.min(...lefts)) || 0).toFixed(1);
  console.log("  · 左缘与头像列：left=" + JSON.stringify(lefts) + " 极差=" + spread
    + " 头像宽=" + (groupRows[0] && groupRows[0].avatarW)
    + " 空位宽=" + (groupRows[1] && groupRows[1].spacerW));
  check("连续消息组：同一组四条的气泡左缘全等（|极差| <= 1px）",
    lefts.length === 4 && lefts.every((v) => typeof v === "number" && v > 0) && spread <= 1,
    "|极差| <= 1", JSON.stringify({ lefts, spread }));
  check("连续消息组：组首头像宽 == 组内空位宽（同一列宽才不会逐行跳）",
    !!groupRows[0] && !!groupRows[1]
      && groupRows[0].avatarW > 0 && groupRows[1].spacerW > 0
      && Math.abs(groupRows[0].avatarW - groupRows[1].spacerW) <= 0.5,
    "差 <= 0.5px", JSON.stringify({
      avatarW: groupRows[0] && groupRows[0].avatarW,
      spacerW: groupRows[1] && groupRows[1].spacerW,
    }));

  // ── 反向对照：全部同一个发送者 ⇒ 组距塌成组内距、身份塌成 1 ──
  const msgsFlat = stackMsgs(STACK.map(() => "peer-a"));
  const sidesFlat = await stackSides(msgsFlat);
  check("连续消息组反向：同发送者时判定变成 首/中/中/中/尾",
    String(sidesFlat) === "first,middle,middle,middle,last",
    "first,middle,middle,middle,last", JSON.stringify(sidesFlat));
  await stackMount(msgsFlat, sidesFlat);
  const flat = await stackGeom();
  const flatGaps = gapsOf(flat.rows || []);
  console.log("  · 反向对照（全同一发送者）：间距=" + JSON.stringify(flatGaps) + " 头像=" + flat.avatars);
  check("连续消息组反向：最后一条的间距跟着塌进组内区间（2~4px）",
    flatGaps.every((g) => g >= 2 && g <= 4), "2~4", JSON.stringify(flatGaps));
  check("连续消息组反向：头像与昵称各只剩 1 个（与上一条同组）",
    flat.avatars === 1 && (flat.rows || []).reduce((n, r) => n + (r ? r.nicks : 0), 0) === 1,
    "各 1", JSON.stringify({ avatars: flat.avatars, nicks: (flat.rows || []).map((r) => r && r.nicks) }));

  // 最后一挂是合并转发卡片那条 ⇒ 这张帧是"卡片 + 尖角"的形状。
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-rowpair.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 行配对取证帧 → " + SHOT_PATH.replace(/\.png$/, "-rowpair.png"));
  }
}

/**
 * 恶劣载荷的溢出矩阵（升级指令 §2.2 / §10「长文本、长昵称、长文件名、长链接、空内容、窄窗口」）。
 *
 * 为什么单开一段：气泡的宽度上限与断词全靠 CSS（`max-w-[var(--gosslan-msg-max)]` +
 * `break-words` + 长链接的中段省略），**读代码看不出它有没有生效**。这类缺陷的形状很安静 ——
 * 不报错、不白屏，只是把整列推出可视区或让页面出现横向滚动条，用户看到的是"消息歪了"。
 *
 * 三条口径：
 * 1. **量三件不同的溢出**，缺一就漏一类缺陷：整页横向滚动（`documentElement.scrollWidth`）、
 *    任一后代越出容器右边界（逐元素算最大越界）、容器自身横向可滚（`scrollWidth − clientWidth`）。
 * 2. **容器取挂载点，不取气泡列**：`system` / `recalled` 是居中的提示行，结构上**没有**
 *    `[data-msg-col]`（第一版按气泡列量，这两档直接量不到东西 ⇒ 三条判据一起红，
 *    看着像提示行溢出了，其实是尺子找错了对象）。
 * 3. **两半都要防假绿**：每档都要求"真的挂出了 ≥3 个节点"（否则"没溢出"只是没画东西）；
 *    再把一条长文本改成 `white-space: nowrap` ⇒ 同一把尺必须报出越界。
 *    为什么不用"最宽后代 ≥ 半屏"当约束顶到的证据：**行容器本身就是满宽的**，
 *    那条断言会恒真（写完实测就发现它在空挂载时也一样绿）。
 */
async function runMsgOverflow(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(2_500);
  await cdp.eval(PAGE_FIXTURE);
  const LONG = "很长的一段中文用来把气泡撑到上限并且一不留神就溢出出去".repeat(6);
  const CASES = [
    { name: "长中文正文", kind: "text", content: LONG },
    { name: "无空格长英文", kind: "text", content: "Supercalifragilistic".repeat(12) },
    { name: "超长链接", kind: "text", content: "看下 https://gosslan.example.com/"
      + "assets/2026/quarterly/report-final-v3/" + "x".repeat(60) + "?trace=1" },
    { name: "代码超长一行", kind: "code", content: "SELECT " + "column_name,".repeat(40) + " tail" },
    { name: "超长文件名", kind: "file", content: JSON.stringify({
      name: "季度经营分析报告-最终版-第三轮修订稿-".repeat(4) + ".pdf",
      path: "/tmp/report.pdf", size: 5318656 }) },
    { name: "超长待办标题", kind: "todo", content: JSON.stringify({
      todo_id: "t-ovf", title: LONG.slice(0, 90), status: "pending", creator: "peer-a",
      assignees: ["peer-a"], priority: "normal", category: "normal", number: 12345 }) },
    { name: "合并转发长摘要", kind: "merge", content: JSON.stringify({
      title: "群聊的聊天记录",
      items: [{ sender: "甲", text: LONG.slice(0, 60) }, { sender: "乙", text: LONG.slice(0, 60) },
        { sender: "丙", text: LONG.slice(0, 60) }] }) },
    { name: "超长系统行", kind: "system", content: "系统提示：" + LONG },
    { name: "撤回行", kind: "recalled", content: "" },
    { name: "空正文", kind: "text", content: "" },
    { name: "未知类型", kind: "voice_note", content: JSON.stringify({ duration: 37, path: "/tmp/a.opus" }) },
  ];
  /** 挂一条（群聊、别人发的、**超长昵称** ⇒ 身份行也跟着进同一把尺）后读几何。 */
  /** 挂一条后读几何：容器一律取挂载点（提示行没有气泡列，见函数头口径 2）。 */
  const probeOne = async (c) => {
    const props = {
      message: {
        msg_id: "m-ovf", sender_id: "peer-a", kind: c.kind, content: c.content,
        ts: 1_700_000_000_000, conv_id: "c-ovf", seq: 1,
      },
      prev: null, isGroup: true, canReact: false,
      senderName: "一个非常长的群成员昵称用来验证身份行会不会把版面顶破".repeat(2),
    };
    const r = await cdp.eval("window.__probe.installMessages("
      + JSON.stringify(JSON.stringify([props])) + ")");
    await sleep(420);
    if (!r || r.ok !== true) return null;
    return cdp.eval(`(() => {
      const host = document.getElementById('probe-host');
      if (!host) return null;
      const hr = host.getBoundingClientRect();
      let worst = 0;
      for (const el of host.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const over = r.right - hr.right;
        if (over > worst) worst = over;
      }
      return {
        hostW: +hr.width.toFixed(1),
        paintedEls: host.querySelectorAll('*').length,
        worstOver: +worst.toFixed(1),
        hostInner: host.scrollWidth - host.clientWidth,
        pageScroll: document.documentElement.scrollWidth,
        vw: window.innerWidth,
      };
    })()`);
  };
  const rows = [];
  for (const c of CASES) rows.push({ ...c, ...(await probeOne(c) || {}) });
  console.log("  · 溢出矩阵：" + JSON.stringify(rows.map((r) => ({
    n: r.name, els: r.paintedEls, hostW: r.hostW, over: r.worstOver,
    inner: r.hostInner, page: r.pageScroll, vw: r.vw,
  }))));
  for (const r of rows) {
    const tag = "溢出矩阵·" + r.name;
    check(tag + "：整页没有横向滚动（scrollWidth ≤ 视口）",
      typeof r.pageScroll === "number" && typeof r.vw === "number" && r.pageScroll <= r.vw,
      "scrollWidth ≤ innerWidth", JSON.stringify({ pageScroll: r.pageScroll, vw: r.vw }));
    check(tag + "：没有后代越出挂载容器右边缘",
      typeof r.worstOver === "number" && r.worstOver <= 0.5, "≤ 0.5px", JSON.stringify({ worstOver: r.worstOver }));
    check(tag + "：挂载容器自身没有横向可滚内容",
      typeof r.hostInner === "number" && r.hostInner <= 0, "scrollWidth == clientWidth",
      JSON.stringify({ hostInner: r.hostInner }));
    // "没溢出"最容易被"压根没画东西"骗过去。这里只要求**这一档真的挂了节点**，
    // 而"上限是否真的顶住"由末尾那条 nowrap 反向对照负责 —— 它比"量到多宽"直接。
    check(tag + "：这一档真的画出了内容（不是空挂载假绿）",
      typeof r.paintedEls === "number" && r.paintedEls >= 3, "≥ 3 个节点",
      JSON.stringify({ paintedEls: r.paintedEls }));
  }

  // ── 窄窗口（390×844）重复最坏的四档 ──
  // ⚠️ 视口覆盖必须放在 `try/finally` 里清掉：这一档中途抛错（CDP 超时、eval 报错）
  //   会把 390×844 泄漏给**后面所有段**，于是别处量到"元素跑出屏幕"，红得完全不相干。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await sleep(400);
  try {
    for (const name of ["无空格长英文", "超长链接", "代码超长一行", "超长文件名"]) {
      const c = CASES.find((x) => x.name === name);
      const r = await probeOne(c);
      console.log("  · 390px " + name + "：" + JSON.stringify(r));
      check("窄窗 390px·" + name + "：整页仍不横滚",
        !!r && r.pageScroll <= r.vw, "scrollWidth ≤ innerWidth", JSON.stringify(r));
      check("窄窗 390px·" + name + "：没有后代越出挂载容器",
        !!r && r.worstOver <= 0.5, "≤ 0.5px", JSON.stringify(r));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  await sleep(300);

  // ── 反向对照：把断词关掉，同一把尺必须报出溢出 ──
  await probeOne(CASES.find((x) => x.name === "无空格长英文"));
  await cdp.eval("(() => { const el = document.querySelector('#probe-host .gosslan-selectable');"
    + " if (el) el.style.whiteSpace = 'nowrap'; return true; })()");
  await sleep(250);
  const broken = await cdp.eval(`(() => {
    const host = document.getElementById('probe-host');
    const hr = host.getBoundingClientRect();
    let worst = 0;
    for (const el of host.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = r.right - hr.right;
      if (over > worst) worst = over;
    }
    return { worstOver: +worst.toFixed(1), inner: host.scrollWidth - host.clientWidth };
  })()`);
  console.log("  · 反向对照（nowrap）：" + JSON.stringify(broken));
  check("溢出矩阵非空转：关掉断词后同一把尺必须报出越界",
    !!broken && broken.worstOver > 1, "> 1px", JSON.stringify(broken));

  // ============ 动效只许碰 transform/opacity/颜色，不许碰布局尺寸 ============
  /*
   * 升级指令 §8 那句"优先使用 transform、opacity 等低成本属性，避免频繁动画布局尺寸"，
   * 在**消息区**这一格还有另一半更硬的理由：虚拟列表按估算高度排布、只在数据变化时重排，
   * 一条消息若在过渡里改 height/margin/padding，动画中途的真实高度就对不上估算 ⇒
   * 就是 roadmap 上反复出现的那族"相邻消息互相遮挡 / 滚动跳动"。
   * 所以这里读**计算出来的** transition-property（源码写了不等于生效），逐档要求没有出现
   * 布局属性；`all` 也算命中 —— 它是 Tailwind `transition-*` 之外的形状，会把未来的
   * 尺寸属性一并吸进过渡里。反向对照同一段末尾的 nowrap 一样靠"改一处在场的样式"造出来。
   */
  const layoutProps = ["width", "height", "margin", "padding", "top", "left", "right", "bottom", "inset"];
  /*
   * ⚠️ 必须先看**时长**再看属性：`transition-property` 的 CSS 初值就是 `all`，
   * 只看属性的第一版把 21 个节点全报成命中（`all | none` 而 duration 是 0s ⇒ 压根没在动）。
   * 真正的形状是"这条过渡时长 > 0 且它的属性表里出现布局尺寸"。
   */
  const animScan = await cdp.eval(`(() => {
    const host = document.getElementById('probe-host');
    const hits = [];
    let checked = 0;
    for (const el of host.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const td = parseFloat((cs.transitionDuration || '0s').split(',')[0]) || 0;
      const ad = parseFloat((cs.animationDuration || '0s').split(',')[0]) || 0;
      const animating = (td > 0 && (cs.transitionProperty || 'none') !== 'none')
        || (ad > 0 && (cs.animationName || 'none') !== 'none');
      if (!animating) continue;
      checked += 1;
      const list = (td > 0 ? cs.transitionProperty : '') + ' | ' + (ad > 0 ? cs.animationProperty : '');
      const bad = ${JSON.stringify(layoutProps)}.filter((k) => list.includes(k));
      if (list.includes('all') || bad.length) {
        hits.push({ cls: (el.className || '').toString().slice(0, 42), list: list.slice(0, 60), bad });
      }
    }
    return { animating: checked, hits: hits.slice(0, 6) };
  })()`);
  console.log("  · 动效属性扫描（只算时长 > 0 的节点）：" + JSON.stringify(animScan));
  check("动效只碰低成本属性：消息区在动的节点没有一个过渡/动画布局尺寸",
    !!animScan && animScan.animating >= 1 && animScan.hits.length === 0,
    "在动节点 ≥1 且命中 0", JSON.stringify(animScan));
  // §8 新消息进入动效：这一格只证"那条 CSS 在浏览器里真的落到计算样式上、时长取的是全站令牌、
  // 而且行盒高度一像素不动（动了就会顶坏虚拟列表的高度测量与滚动锚点）"。
  // "哪些行才算新消息"的资格判定由 src/utils/messageEnter.test.ts 的真值表钉，两边不重复量。
  const ENTER_READ = `(() => {
    const host = document.getElementById('probe-host');
    if (!host) return null;
    const box = document.createElement('div');
    box.className = 'gosslan-bubble-text';
    box.textContent = '进入动效探针';
    host.appendChild(box);
    const h0 = Math.round(box.getBoundingClientRect().height);
    box.classList.add('gosslan-msg-enter');
    const cs = getComputedStyle(box);
    const out = {
      name: cs.animationName,
      dur: cs.animationDuration,
      h0,
      h1: Math.round(box.getBoundingClientRect().height),
      token: getComputedStyle(document.documentElement).getPropertyValue('--gosslan-duration').trim(),
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    box.remove();
    return out;
  })()`;
  const enterOn = await cdp.eval(ENTER_READ);
  // 计算样式给 "0.24s"、自定义属性给 "240ms" ⇒ 两边都折成秒再比，不许各比各的写法
  const secOf = (v) => (parseFloat(String(v ?? "0")) || 0) * (String(v).includes("ms") ? 0.001 : 1);
  check("新消息进入：类名真的带出 animation-name + 全站令牌时长，且行盒高度不涨不缩",
    !!enterOn && enterOn.name === "gosslan-msg-in"
      && secOf(enterOn.dur) > 0
      && Math.abs(secOf(enterOn.dur) - secOf(enterOn.token)) < 1e-6
      && enterOn.h0 > 0 && enterOn.h0 === enterOn.h1,
    "animation-name=gosslan-msg-in / duration=--gosslan-duration / 加类前后等高且非零",
    JSON.stringify(enterOn));
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  }).catch(() => {});
  const enterOff = await cdp.eval(ENTER_READ);
  check("减少动效档下这条进入动画确实被关掉（而且模拟介质真的生效了，不是读了个假的 matchMedia）",
    !!enterOff && enterOff.reduce === true && enterOff.name === "none",
    "reduce=true 且 animation-name=none", JSON.stringify(enterOff));
  await cdp.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  const enterBack = await cdp.eval(ENTER_READ);
  check("出档还原后这条动画又回来（模拟介质不许外溢给后面的段）",
    !!enterBack && enterBack.reduce === false && enterBack.name === "gosslan-msg-in",
    "reduce=false 且 animation-name=gosslan-msg-in", JSON.stringify(enterBack));
  // 反向对照：给气泡现场加一条 height 过渡，同一把尺必须点名它。
  await cdp.eval("(() => { const el = document.querySelector('#probe-host .gosslan-bubble-text');"
    + " if (el) el.style.transition = 'height 200ms ease'; return true; })()");
  await sleep(200);
  const animBreak = await cdp.eval(`(() => {
    const host = document.getElementById('probe-host');
    let n = 0;
    for (const el of host.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const td = parseFloat((cs.transitionDuration || '0s').split(',')[0]) || 0;
      if (td <= 0) continue;
      const list = cs.transitionProperty + ' | ' + cs.animationProperty;
      if (list.includes('all') || ${JSON.stringify(layoutProps)}.some((k) => list.includes(k))) n += 1;
    }
    return n;
  })()`);
  check("动效扫描非空转：现场给气泡加一条 height 过渡后必须被点名",
    typeof animBreak === "number" && animBreak >= 1, "≥ 1 个命中", JSON.stringify({ animBreak }));

  // ---------------- 禁用态契约行 ↔ 真实渲染的绑定 ----------------
  //
  // `tokenContrast.ts` 的 `DISABLED_CONTRAST_CONTRACT` 全部从**源码文本**里读（token 名 + 各自的 α），
  // 但"这个 token 真的画在这个按钮上、这个 α 真的作用在这个元素上、这个面真的是契约说的那个面"
  // 以前没有任何判据看过 —— 组件换成别的填充档，契约照样量它自己那串名字，全绿而说的不是界面。
  // 这一段用真组件 + 真样式表 + 真计算样式把那条链接上：浏览器自己解 `color-mix`，
  // 正好是我在手算解析的地面对照（解析跑偏这里当场红）。
  const { readFileSync } = await import("node:fs");
  const {
    DISABLED_CONTRAST_CONTRACT, auditDisabledContrast, parseTokenScopes, resolveToken,
  } = await import("../src/utils/tokenContrast.ts");
  const readSrc = (rel) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
  const tcCss = readSrc("src/style.css");
  const tcSources = {
    PrimaryBtn: readSrc("src/components/ui/PrimaryBtn.vue"),
    DangerBtn: readSrc("src/components/ui/DangerBtn.vue"),
    ChatWindow: readSrc("src/components/ChatWindow.vue"),
    StyleCss: tcCss,
  };
  const tcAudit = auditDisabledContrast(tcCss, tcSources);

  const theme = await cdp.eval(`(() => ({
    dark: document.documentElement.classList.contains('dark'),
    panel: (() => { const d = document.createElement('div'); d.style.color = 'var(--gosslan-panel)';
      d.style.display = 'none'; document.body.appendChild(d);
      const v = getComputedStyle(d).color; d.remove(); return v; })(),
  }))()`);
  const tcScope = theme.dark
    ? new Map([...parseTokenScopes(tcCss).light, ...parseTokenScopes(tcCss).dark])
    : parseTokenScopes(tcCss).light;
  const tcTheme = theme.dark ? "dark" : "light";
  // token → 浏览器那套 `rgb(r, g, b)` 文本（这些档都不透明，混色由浏览器做完）
  const tcRgb = (tok) => {
    const c = resolveToken(tok, tcScope);
    return c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : null;
  };
  /**
   * 计算样式里同一个颜色有两种写法：普通色是 `rgb(42, 94, 177)`，而 `color-mix()` 派生档
   * 是 `color(srgb 0.166588 0.367059 0.694588)`（未取整）。所以**比三元组不比字符串** ——
   * 顺带这一比就是"手算的混色解析 vs 浏览器自己解出来的"那次对账。
   */
  const toTriple = (s) => {
    const v = String(s || "").trim();
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
    if (m) return [+m[1], +m[2], +m[3]];
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
    if (m) return [1, 2, 3].map((i) => Math.round(parseFloat(m[i]) * 255));
    m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    if (m) return [1, 2, 3].map((i) => parseInt(m[i], 16));
    return null;
  };
  const sameColor = (a, b) => {
    const x = toTriple(a) ?? [];
    const y = toTriple(b) ?? [];
    return x.length === 3 && y.length === 3 && x.every((n, i) => Math.abs(n - y[i]) <= 1);
  };

  // 契约按"元素坐在面板上"建模 —— 这里就把宿主面显式给成同一个 token，
  // 顺便验这个面本身：浏览器解出来的 panel 必须与 node 侧解析同值。
  await cdp.eval(`(() => { const h = document.getElementById('probe-host');
    if (h) { h.style.background = 'var(--gosslan-panel)'; h.style.padding = '12px'; } return true; })()`);
  await sleep(120);
  const pageSeen = await cdp.eval(`(() => { const h = document.getElementById('probe-host');
    return h ? getComputedStyle(h).backgroundColor : null; })()`);
  check("禁用态契约的『背后的面』与浏览器解出的同一个 token 同值（面板面 = node 解析）",
    sameColor(pageSeen, tcRgb("--gosslan-panel")) && sameColor(pageSeen, theme.panel),
    `${tcRgb("--gosslan-panel")}（${tcTheme}）`, JSON.stringify({ pageSeen, panel: theme.panel }));

  /** 挂一个真实的禁用按钮，读回它自己的计算样式。 */
  const mountDisabled = async (cmp) => {
    await cdp.eval(`window.__probe.install('${cmp}', '', ${JSON.stringify(JSON.stringify({ disabled: true }))})`);
    await sleep(250);
    return await cdp.eval(`(() => { const b = document.querySelector('#probe-host button');
      if (!b) return null; const cs = getComputedStyle(b);
      return { disabled: b.disabled === true, color: cs.color, bg: cs.backgroundColor,
        opacity: Number(cs.opacity) }; })()`);
  };
  /** 契约行 + 真实渲染必须说的是同一批颜色、同一个 α。 */
  const bindFamily = async (name, cmp) => {
    const row = DISABLED_CONTRAST_CONTRACT.find((r) => r.name === name);
    const rating = tcAudit.ratings.find((r) => r.name === name && r.theme === tcTheme);
    const seen = await mountDisabled(cmp);
    const wantFg = tcRgb(row.fg);
    const wantFill = row.fill ? tcRgb(row.fill) : null;
    check(`${name}：真实禁用按钮画出来的填充/前景/α 与契约行说的是同一批值（${tcTheme}）`,
      !!seen && seen.disabled && sameColor(seen.bg, wantFill) && sameColor(seen.color, wantFg) &&
        Math.abs(seen.opacity - (rating?.alpha ?? -1)) < 0.001,
      `${wantFill} + ${wantFg} @α=${rating?.alpha}`, JSON.stringify({ seen, wantFg, wantFill }));
    return seen;
  };
  await bindFamily("主色实底按钮", "/src/components/ui/PrimaryBtn.vue");
  await bindFamily("危险实底按钮", "/src/components/ui/DangerBtn.vue");

  // 空转对照：这把尺读的必须是**真元素的计算值**。现场用 inline style 把 α 压到 0.25，
  // 读回来必须跟着变（读不到 ⇒ 上面那两格是在拿常量比常量）。
  // `transition: none` 是必需的：按钮对 opacity 有过渡（style.css 那条 transition 列表里就有它），
  // 不等过渡完读到的是中间值（实测 0.258029），第一版就在这里红过一次。
  await mountDisabled("/src/components/ui/PrimaryBtn.vue");
  await cdp.eval(`(() => { const b = document.querySelector('#probe-host button');
    if (b) { b.style.transition = 'none'; b.style.opacity = '0.25'; } return true; })()`);
  await sleep(80);
  const forced = await cdp.eval(`(() => { const b = document.querySelector('#probe-host button');
    return b ? Number(getComputedStyle(b).opacity) : null; })()`);
  check("禁用态绑定尺非空转：inline 把 α 压到 0.25 必须被读回来",
    forced === 0.25, "0.25", JSON.stringify({ forced }));
}

/**
 * 粘贴大段文字必须**当帧就画出来**（用户 2026-10-23：粘进去会先卡一下才显示）。
 *
 * 根因不是 JS 慢，是**插入方式**：`document.execCommand("insertText")` 会把带换行的文本
 * 逐行开编辑事务。本机实测（真 ⌘V、同一个输入框）：
 *   · 10k 字符 / 300 行 ⇒ 299 个子元素、599 次 input 事件、按键回执 562–662 ms
 *   · 50k 字符 / 1500 行 ⇒ 1419 个子元素、按键回执 4367 ms
 * 整段同步跑在 paste 事件里 ⇒ 粘贴的文字要等它全部做完才画得出来，这就是那"一下"。
 * 改成"一次插入一个文本节点 + 补发一次 input"之后：同一动作 6–9 ms / 19–36 ms。
 * （那两个"按键回执"数是在**真聊天页**上量的：输入框上面还有消息列表与整张卡片，
 * 每行事务都要带着它们重排。本段是单独挂一个编辑器，旧写法在这里只测到 ~68 ms ⇒
 * 所以耗时那格只当兜底，真正咬人的是 input 次数与子元素数那两格。）
 *
 * 三条口径（别改回去）：
 * 1. **主判据钉的是机制形状（一次 input、零个子元素），不是耗时**。耗时随机器档位飘，
 *    而"逐行插入"必然把这两数顶起来 ⇒ 退回旧写法必红。耗时那格只给宽松上限兜底。
 * 2. 编辑器是 `whitespace-pre-wrap` ⇒ 文本节点里的换行符就是换行；这里断 innerText
 *    读回的换行数，保证"快"没有以"序列化丢换行"为代价（`serializeDraft` 走的就是 innerText）。
 * 3. caret 必须落在**文本节点内部**的末尾：`caretContext()` 只认文本节点 caret，
 *    落在编辑器元素上会出现"粘完接着打 @ 不弹成员选择"这种看不见的错。
 */
async function runPasteFrame(cdp, url) {
  const LINES = 300;
  const text = Array.from({ length: LINES }, (_, i) => "第" + i + "行 混排文本 English 与标点。").join("\n");
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const props = { convId: "c-paste-frame", mentionMembers: [{ id: "dev-42", name: "小明" }] };
  const mounted = await cdp.eval("window.__probe.install('/src/components/chat/MessageComposer.vue', '', "
    + JSON.stringify(JSON.stringify(props)) + ")");
  check("粘贴首帧：挂出真 MessageComposer", !!mounted && mounted.ok === true, "install 成功",
    JSON.stringify(mounted).slice(0, 200));
  await sleep(400);

  const run = await cdp.eval("(async () => {"
    + " const ed = document.querySelector('#probe-host [contenteditable=true]');"
    + " if (!ed) return { err: 'no editor' };"
    + " const text = " + JSON.stringify(text) + ";"
    + " ed.textContent = '';"
    + " ed.focus();"
    + " const sel0 = window.getSelection();"
    + " const r0 = document.createRange();"
    + " r0.selectNodeContents(ed); r0.collapse(false);"
    + " sel0.removeAllRanges(); sel0.addRange(r0);"
    + " await new Promise((r) => requestAnimationFrame(r));"
    + " let inputs = 0;"
    + " const count = (e) => { if (e.isTrusted || e.inputType) inputs += 1; };"
    + " ed.addEventListener('input', count, true);"
    + " const dt = new DataTransfer(); dt.setData('text/plain', text);"
    + " const t0 = performance.now();"
    + " ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));"
    + " const handlerMs = performance.now() - t0;"
    + " ed.removeEventListener('input', count, true);"
    + " const frameMs = await new Promise((r) => requestAnimationFrame(() => r(performance.now() - t0)));"
    + " const sel = window.getSelection();"
    + " const node = sel.focusNode;"
    + " return {"
    + "   handlerMs: +handlerMs.toFixed(1), frameMs: +frameMs.toFixed(1), inputEvents: inputs,"
    + "   childEls: ed.querySelectorAll('*').length,"
    + "   chars: (ed.textContent || '').length,"
    + "   inner: ed.innerText.length,"
    + "   innerNewlines: (ed.innerText.match(/\\n/g) || []).length,"
    + "   caretInText: !!node && node.nodeType === 3,"
    + "   caretAtNodeEnd: !!node && node.nodeType === 3 && sel.focusOffset === node.length,"
    + "   sendEnabled: !Array.from(document.querySelectorAll('button'))"
    + "     .filter((b) => (b.textContent || '').indexOf('发送') >= 0 || (b.getAttribute('aria-label') || '').indexOf('发送') >= 0)"
    + "     .every((b) => b.disabled)"
    + " };"
    + "})()");
  check("粘贴首帧：读数拿得到（编辑器没挂上就是 null）", !!run && run.err === undefined, "有读数", JSON.stringify(run).slice(0, 200));
  console.log("  · 粘贴实测（" + LINES + " 行 / " + text.length + " 字符）：" + JSON.stringify(run));
  check("非空转·粘贴首帧：文本全在，且换行是**文本节点里的真换行符**（逐行造 div 时 textContent 会少掉这些字符）",
    !!run && run.chars >= text.length - 2 && run.innerNewlines === LINES - 1,
    "textContent 与行数都对", JSON.stringify(run));
  check("粘贴是一次插入：整段只发 1 次 input（逐行插入会是每行两次）",
    !!run && run.inputEvents === 1, "inputEvents == 1", JSON.stringify({ got: run && run.inputEvents }));
  check("粘贴不逐行造元素：编辑器里没有子元素（旧写法 300 行 ⇒ 299 个）",
    !!run && run.childEls === 0, "childEls == 0", JSON.stringify({ got: run && run.childEls }));
  check("粘贴当帧不阻塞首帧：按键到下一帧 < 250ms（兜底格；主判据是上面两条机制形状）",
    !!run && run.frameMs < 250, "frameMs < 250", JSON.stringify({ frameMs: run && run.frameMs }));
  check("caret 落在文本节点内部的末尾（落在编辑器上会让 @ 触发态静默失效）",
    !!run && run.caretInText && run.caretAtNodeEnd, "文本节点内 + 偏移 == 节点长度",
    JSON.stringify({ caretInText: run && run.caretInText, atEnd: run && run.caretAtNodeEnd }));
  check("粘贴后发送键立刻可用（hasDraft 投影跟得上）", !!run && run.sendEnabled === true,
    "可发送", JSON.stringify({ sendEnabled: run && run.sendEnabled }));

  // 手动插入不进原生 undo 栈 ⇒ 组件自己接住紧跟粘贴的那一次 ⌘/Ctrl+Z
  const undo = await cdp.eval("(async () => {"
    + " const ed = document.querySelector('#probe-host [contenteditable=true]');"
    + " if (!ed) return { err: 'no editor' };"
    + " ed.textContent = '前置内容';"
    + " ed.focus();"
    + " const sel = window.getSelection(); const r = document.createRange();"
    + " r.selectNodeContents(ed); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);"
    + " await new Promise((x) => requestAnimationFrame(x));"
    + " const dt = new DataTransfer(); dt.setData('text/plain', " + JSON.stringify(text) + ");"
    + " ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));"
    + " const afterPaste = (ed.textContent || '').length;"
    + " const kz = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });"
    + " ed.dispatchEvent(kz);"
    + " await new Promise((x) => requestAnimationFrame(x));"
    + " const afterUndo = (ed.textContent || '').length;"
    + " const dt2 = new DataTransfer(); dt2.setData('text/plain', 'ABC');"
    + " ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));"
    + " ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));"
    + " const kz2 = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });"
    + " ed.dispatchEvent(kz2);"
    + " return { afterPaste, afterUndo, prevented: kz.defaultPrevented,"
    + "   preventedAfterEdit: kz2.defaultPrevented };"
    + "})()");
  console.log("  · 粘贴撤销实测：" + JSON.stringify(undo));
  check("紧跟粘贴的 ⌘/Ctrl+Z 回到粘贴前（手动插入不进原生 undo 栈，得自己接）",
    !!undo && undo.prevented === true && undo.afterUndo === "前置内容".length,
    "被接住且内容回到 4 字符", JSON.stringify(undo));
  check("粘贴之后又编辑过 ⇒ ⌘/Ctrl+Z 不许被我们吞掉（该撤销的是那次编辑，交回原生）",
    !!undo && undo.preventedAfterEdit === false, "不拦截", JSON.stringify({ got: undo && undo.preventedAfterEdit }));
}

async function runTouchRoster(cdp, url) {  // 触摸仿真必须在**页面加载前**开：`canHover` 是 utils/platform 的模块级常量。
  // 这里只验证长按名单这一条，不改变其它段（本段放在最后，结束即关浏览器）。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    screenWidth: 390, screenHeight: 844,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    await cdp.send("Page.bringToFront").catch(() => {});
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const props = {
      message: {
        msg_id: "m-touch-roster", sender_id: "peer-a", kind: "text",
        content: "移动端长按这条回应胶囊，应该展开名单。",
        ts: 1700000000000, conv_id: "group:g1", seq: 1,
      },
      canReact: true, isGroup: true, senderName: "测试者",
      reactions: [{ emoji: "[赞]", count: 2, mine: false, actors: ["peer-a", "peer-b"], latest: "peer-b" }],
    };
    const mounted = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
      + JSON.stringify(JSON.stringify(props)) + ")");
    check("移动端触摸：消息行挂载成功", !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));
    const chip = await cdp.eval(`(() => {
      const b = document.querySelector('[data-reaction-chip]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
        hover: b.getAttribute('data-hover-capable') };
    })()`);
    check("移动端触摸：触摸仿真下 canHover=false（长按分支才会启用）",
      !!chip && chip.hover === "false", "data-hover-capable=false", JSON.stringify(chip));
    if (!chip) return;
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {
      type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, radiusX: 1, radiusY: 1, force: 1, id: i + 1 })),
    });
    await touch("touchStart", [chip]);
    await sleep(150);
    const early = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check("移动端触摸：按下的前 150ms 不自动弹（focus/enter 的自动开启被忽略）",
      early === false, "名单未出现", "early=" + early);
    await sleep(500);
    const opened = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check("移动端触摸：长按约 450ms 后名单展开（不是只能靠鼠标 hover）",
      opened === true, "名单出现", "opened=" + opened);
    await touch("touchEnd", []);
    await sleep(350);
    const afterUp = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check("移动端触摸：松手后名单不收起（长按那一按的 release 不许误关）",
      afterUp === true, "名单仍在", "afterUp=" + afterUp);
    await touch("touchStart", [{ x: 12, y: 12 }]);
    await touch("touchEnd", []);
    await sleep(300);
    const closed = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check("移动端触摸：点名单外收起（有明确关闭出口）", closed === false, "名单消失", "closed=" + closed);

    // ---------------- 起手就竖向滑（滚动抢走手势）那一格 ----------------
    // 这条判据要的是：浏览器把这次触摸判成滚动时，450ms 的长按计时器必须被取消，
    // 否则"在胶囊上往上滑一下"会在松手之后自己弹出一层名单。
    // ⚠️ 前提出声：先用一个计数器证明**这台浏览器真的发了 cancel**（计数 0 就是这一格在本引擎没有判据），
    //    不然"名单没弹"可能只是手势压根没形成 —— 那是一次假绿。
    await cdp.eval(
      "(() => { window.__cancelSeen = { pointer: 0, touch: 0 };" +
        "addEventListener('pointercancel', () => { window.__cancelSeen.pointer++; }, true);" +
        "addEventListener('touchcancel', () => { window.__cancelSeen.touch++; }, true);" +
        "return true; })()",
    );
    await cdp.send("Input.synthesizeScrollGesture", {
      x: chip.x,
      y: chip.y,
      xDistance: 0,
      yDistance: -120,
      gestureSourceType: "touch",
      speed: 800,
      preventFling: true,
    });
    await sleep(700);
    const seen = await cdp.eval("window.__cancelSeen");
    check(
      "移动端触摸：在胶囊上起手竖向滑，浏览器确实把这次触摸判成了滚动（收到 pointercancel/touchcancel）",
      !!seen && seen.pointer + seen.touch > 0,
      "cancel 计数 > 0",
      JSON.stringify(seen),
    );
    const afterScroll = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check(
      "移动端触摸：滚动抢走手势后名单不弹（长按计时器被取消，不是等 450ms 自己浮出来）",
      afterScroll === false,
      "名单未出现",
      "afterScroll=" + afterScroll + " cancel=" + JSON.stringify(seen),
    );
    // 反控：同一个坐标**按住不动**超过 450ms 必须弹（上面那条"没弹"只有在"静止会弹"成立时才有意义）
    await touch("touchStart", [chip]);
    await sleep(650);
    const afterStill = await cdp.eval("!!document.querySelector('[data-reaction-roster]')");
    check(
      "移动端触摸：同一坐标按住不动仍会弹（证明上一条的『没弹』是取消生效，不是这条路径整个坏了）",
      afterStill === true,
      "名单出现",
      "afterStill=" + afterStill,
    );
    await touch("touchEnd", []);
    await sleep(200);
    await touch("touchStart", [{ x: 12, y: 12 }]);
    await touch("touchEnd", []);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

async function runVirtualList(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval("window.__probe.vlistMount(200)");
  check("VirtualList：200 条挂载成功", !!mounted && mounted.ok === true, "mount ok", JSON.stringify(mounted));
  const read = () => cdp.eval("window.__probe.vlistRead()");
  let s = await read();
  check("VirtualList：只渲染视口附近的行（虚拟化生效，且有真实滚动高度）",
    s.rows > 0 && s.rows < 60 && s.scrollHeight > s.clientHeight,
    "0 < rows < 60 且 scrollHeight > clientHeight", JSON.stringify(s));
  check("VirtualList：live region 真的挂在滚动根上（role=log / aria-live=polite）",
    s.role === "log" && s.live === "polite", "role=log 且 aria-live=polite", JSON.stringify({ role: s.role, live: s.live }));

  // 先从顶部直接跳，避开"刚滚到底的 rAF/贴底"与新跳转抢同一帧。
  const jumped = await cdp.eval("window.__probe.vlistJump(150)");
  check("VirtualList：scrollToIndex 从组件 ref 暴露且可调用", jumped === true, "调用返回 true", JSON.stringify(jumped));
  await sleep(700);
  s = await read();
  const row150 = await cdp.eval("window.__probe.vlistRow('row-150')");
  check("VirtualList：scrollToIndex(150) 落到目标且贴顶（真实 DOM 二次校正）",
    row150.present === true && row150.top >= -2 && row150.top <= 20,
    "row-150 存在且 0..20px", JSON.stringify({ row150, top: s.scrollTop, firstVisible: s.firstVisible }));
  check("VirtualList：离开底部后 nearBottom=false", s.nearBottom === false, "nearBottom === false", JSON.stringify(s.nearBottom));

  await cdp.eval("window.__probe.vlistGoBottom()");
  await sleep(700);
  s = await read();
  check("VirtualList：滚到底渲染末条（不是只换了个 scrollTop）",
    s.scrollTop > 0 && s.keys.includes("row-199"),
    "scrollTop>0 且包含 row-199", JSON.stringify({ top: s.scrollTop, keys: s.keys.slice(-4) }));
  check("VirtualList：贴底时 nearBottom=true（父组件的『回到最新』按钮据此隐藏）",
    s.nearBottom === true, "nearBottom === true", JSON.stringify(s.nearBottom));

  // 再从底部跳回中间，作为 prepend 锚定的起点。
  await cdp.eval("window.__probe.vlistJump(100)");
  await sleep(700);
  s = await read();
  const row100 = await cdp.eval("window.__probe.vlistRow('row-100')");
  check("VirtualList：从底部 scrollToIndex(100) 也能落到目标",
    row100.present === true && row100.top >= -2 && row100.top <= 20,
    "row-100 存在且 0..20px", JSON.stringify({ row100, top: s.scrollTop, firstVisible: s.firstVisible }));
  const before = s;
  await cdp.eval("window.__probe.vlistPrepend(20)");
  await sleep(650);
  s = await read();
  check("VirtualList：prepend 20 条后同一 key 留在视口同一位置（向上加载不跳动）",
    s.firstVisible === before.firstVisible && Math.abs(s.firstTop - before.firstTop) <= 2
      && s.scrollTop > before.scrollTop,
    "同一 firstVisible、|Δtop|<=2、scrollTop 增大",
    JSON.stringify({ before: { k: before.firstVisible, top: before.firstTop, st: before.scrollTop },
      after: { k: s.firstVisible, top: s.firstTop, st: s.scrollTop } }));
  check("VirtualList：prepend 后仍只渲染视口附近（没有退化成整表）",
    s.rows > 0 && s.rows < 60, "0 < rows < 60", "rows=" + s.rows);

  const lmBefore = s.loadMore;
  await cdp.eval("window.__probe.vlistGoTop()");
  await sleep(350);
  s = await read();
  check("VirtualList：触顶真的发 loadMore（父组件据此拉更早历史）",
    s.loadMore > lmBefore, "loadMore 增加", "before=" + lmBefore + " after=" + s.loadMore);

  // 切会话：整表换 key + 行高与估算不同，逼出估算→实测收敛。切换后的静默窗口内
  // 不允许每改一次总高度就写一次 scrollTop（那会表现为小幅快速抖动）。
  await cdp.eval("window.__probe.vlistSwap(120)");
  await cdp.eval("window.__probe.vlistWobble(6, 35)");
  const samples = await cdp.eval("window.__probe.vlistSampleScroll(650)");
  await sleep(200);
  const afterSwap = await read();
  let reversals = 0;
  let prevSign = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i] - samples[i - 1];
    if (Math.abs(d) < 2) continue;
    const sign = Math.sign(d);
    if (prevSign !== 0 && sign !== prevSign) reversals += 1;
    prevSign = sign;
  }
  // 读数留在日志里：`reversals` 是这条判据的核心量（阈值 <=3），写成永久档案，
  // 以后改贴底逻辑时能直接看出"变好还是变坏"，不用靠印象。
  console.log("  ℹ 切会话抖动读数 → " + JSON.stringify({
    reversals, frames: samples.length,
    first: samples.slice(0, 20),
    finalTop: afterSwap.scrollTop,
    maxScroll: afterSwap.scrollHeight - afterSwap.clientHeight,
  }));
  check("VirtualList：切换会话后滚动位置收敛，不来回快速抖动",
    reversals <= 3 && afterSwap.scrollHeight > afterSwap.clientHeight
      && afterSwap.scrollHeight - afterSwap.scrollTop - afterSwap.clientHeight < 150,
    "方向反转<=3 且最终贴底",
    JSON.stringify({ reversals, samples: samples.slice(0, 30), final: { top: afterSwap.scrollTop, h: afterSwap.scrollHeight, c: afterSwap.clientHeight } }));
}

async function runLogs(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const LOGS = Array.from({ length: 200 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 1000,
    level: i % 17 === 0 ? "warn" : "info",
    target: `probe-${i}`,
    message: `日志行 ${String(i).padStart(3, "0")}`,
  }));
  await cdp.eval(`window.__probe.stubApi('getLogs', ${JSON.stringify(LOGS)})`);
  // ★ 把「页面在前台」钉成夹具的一部分。`load()`（LogViewer.vue:148）第一句就是
  //   `if (document.hidden) return` —— 而探针页的 visibility 并**不恒定**（本文件里已有两处
  //   为它写的纪律：焦点模拟那段、出帧泵那段）。也就是说上面那条「渲染出日志行」一直在
  //   隐性依赖 Chrome 当下把不把这张页算前台。用户读日志时窗口必然在前台，所以这里显式钉住，
  //   并把原生读数打印出来（判据不再靠运气，而是把运气量出来）。离开时删掉自己的覆写还原。
  const vis = await cdp.eval(`(() => {
    const natural = { hidden: document.hidden, state: document.visibilityState };
    const pin = (h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    };
    pin(false);
    window.__pinVis = pin;
    window.__unpinVis = () => {
      delete document.hidden;
      delete document.visibilityState;
      return { hidden: document.hidden, state: document.visibilityState };
    };
    return { natural, pinned: { hidden: document.hidden, state: document.visibilityState } };
  })()`);
  check("开局核对：夹具能把 document.hidden 钉成 false（原生读数一并打印，供判读环境）",
    !!vis && vis.pinned.hidden === false && vis.pinned.state === "visible",
    "覆写后 hidden=false 且 visibilityState=visible", JSON.stringify(vis));
  console.log(`  · 环境读数：探针页原生 document.hidden=${vis.natural.hidden} / visibilityState=${vis.natural.state}`
    + "（本段随后把它钉成 false/visible，因为用户读日志时窗口必然在前台）");
  const mounted = await cdp.eval(
    `window.__probe.install('/src/components/LogViewer.vue', '', ${JSON.stringify(JSON.stringify({ standalone: true }))})`,
  );
  await sleep(900);
  const read = () => cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('[data-index]')];
    const scroll = rows[0] ? rows[0].closest('.overflow-y-auto') : null;
    const texts = rows.map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim());
    return {
      rows: rows.length,
      first: texts[0] || '',
      last: texts[texts.length - 1] || '',
      scrollTop: scroll ? Math.round(scroll.scrollTop) : -1,
      scrollHeight: scroll ? scroll.scrollHeight : -1,
      clientHeight: scroll ? scroll.clientHeight : -1,
      hasTitle: (document.body.innerText || '').includes('运行日志'),
    };
  })()`);
  let s = await read();
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const p = SHOT_PATH.replace(/\.png$/, "-logs.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("  📷 日志取证帧 → " + p);
  }
  check("日志独立窗：standalone 挂载后渲染出虚拟行（不再是空白/注释节点）",
    mounted && mounted.ok === true && s.hasTitle === true && s.rows > 0,
    "挂载成功 / 有标题 / rows>0", JSON.stringify({ mounted, s }));
  check("日志独立窗：200 条只渲染视口附近的行（虚拟化生效，且滚动容器真的有高度）",
    s.rows > 0 && s.rows < 100 && s.scrollHeight > s.clientHeight,
    "0 < rows < 100 且 scrollHeight > clientHeight", JSON.stringify(s));
  const before = s.first;
  await cdp.eval(`(() => {
    const row = document.querySelector('[data-index]');
    const scroll = row && row.closest('.overflow-y-auto');
    if (!scroll) return false;
    scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  s = await read();
  check("日志独立窗：滚到底后渲染换到另一批旧日志（滚动 + 虚拟窗口换页）",
    s.rows > 0 && s.scrollTop > 0 && s.first !== before,
    "scrollTop>0 且首行变化", JSON.stringify({ before, s }));

  // ── §6.79 归因段：LogViewer.vue:174 那条 `useEventListener(document, "visibilitychange", onVisibility)`
  //    是 §6.73 交给库的 7 处里只剩静态凭据的一个。要让「切回来立刻补一次」这件事**只可能**由它做成，
  //    先把 2s 轮询关掉（点自动刷新开关走 syncTimer ⇒ clearInterval）。此后 api.getLogs 的调用方
  //    只剩两个：onMounted 那次（已经发生完了）和我手工发的那根事件。调用次数由夹具的 H.apiCalls 数。
  const cMount = await cdp.eval("window.__probe.apiCalls('getLogs')");
  await sleep(2_300);
  const cPoll = await cdp.eval("window.__probe.apiCalls('getLogs')");
  // 正控：不先证明"开着时确实在轮询"，下面那句"关掉后不增"可以只是因为压根没跑过。
  check("关掉之前先确认轮询真的在跑（静置 2.3 s > 一个 2 s 周期 ⇒ getLogs 调用数增加）",
    cPoll > cMount, "调用数增加", JSON.stringify({ cMount, cPoll }));
  const tglClick = await cdp.eval(`(() => {
    const all = [...document.querySelectorAll('button[aria-pressed]')];
    const b = all.find((x) => /自动刷新|auto.?refresh/i.test(String(x.getAttribute('aria-label') || '')));
    if (!b) return { found: false, n: all.length, labels: all.map((x) => x.getAttribute('aria-label')) };
    const before = b.getAttribute('aria-pressed');
    b.click();
    return { found: true, before };
  })()`);
  // 同一次 evaluate 里读不到翻面后的 aria-pressed：Vue 的 DOM 写入排在微任务里，
  // 而 cdp.eval 的那段脚本是同步跑完的 ⇒ 必须换个 evaluate 再读（第一次就栽在这儿）。
  await sleep(200);
  const tglState = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button[aria-pressed]')]
      .find((x) => /自动刷新|auto.?refresh/i.test(String(x.getAttribute('aria-label') || '')));
    return { after: b ? b.getAttribute('aria-pressed') : null };
  })()`);
  const cBase = await cdp.eval("window.__probe.apiCalls('getLogs')");
  await sleep(2_400);
  const cIdle = await cdp.eval("window.__probe.apiCalls('getLogs')");
  check("点掉自动刷新后静置 2.4 s ⇒ 轮询确实停了（aria-pressed 由 true 翻 false 且调用数不动）："
    + "红在这里说明开关或 syncTimer 掉了，下面两格就失去单一成因",
    tglClick.found === true && tglClick.before === "true" && tglState.after === "false" && cIdle === cBase,
    "aria-pressed true→false 且 Δcalls=0", JSON.stringify({ tglClick, tglState, cBase, cIdle }));

  // 反向那一格：正在后台时一根都不许发（隐藏时 get_logs 会快照整份日志，用户根本看不到）。
  await cdp.eval("window.__pinVis(true)");
  await cdp.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(350);
  const cHidden = await cdp.eval("window.__probe.apiCalls('getLogs')");
  check("钉成后台后发 visibilitychange ⇒ getLogs 一次都不发（不白拉整份日志）",
    cHidden === cIdle, "调用数不变", JSON.stringify({ cIdle, cHidden }));

  // 正向那一格（摘掉 :174 那条 useEventListener 就红在这里）：切回前台**立刻**补一次。
  await cdp.eval("window.__pinVis(false)");
  await cdp.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(350);
  const cShown = await cdp.eval("window.__probe.apiCalls('getLogs')");
  check("切回前台发 visibilitychange ⇒ 立刻补一次 getLogs（不等下一个周期）："
    + "轮询已关，这个 +1 只能来自 :174 交给库的那条 document 监听",
    cShown === cHidden + 1, "调用数 +1", JSON.stringify({ cHidden, cShown }));

  const visBack = await cdp.eval("window.__unpinVis()");
  check("离开本段前把 document.hidden 还原成浏览器原生读数（覆写不许外溢给后面的段）",
    !!visBack && typeof visBack.hidden === "boolean" && typeof visBack.state === "string",
    "还原后读到原生 boolean/string", JSON.stringify({ natural: vis.natural, back: visBack }));

  // 移动端日志页（非 standalone）：390 宽下工具栏标签会收起，但按钮本身与虚拟列表不许横向溢出。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(2_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval(`window.__probe.stubApi('getLogs', ${JSON.stringify(LOGS)})`);
    const mm = await cdp.eval(
      `window.__probe.install('/src/components/LogViewer.vue', '', ${JSON.stringify(JSON.stringify({ standalone: false }))})`,
    );
    await sleep(800);
    const mob = await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      const scroll = (document.querySelector('[data-index]') || {}).closest
        ? document.querySelector('[data-index]').closest('.overflow-y-auto')
        : null;
      return {
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        buttons: buttons.length,
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)),
        rows: document.querySelectorAll('[data-index]').length,
        scrollH: scroll ? scroll.scrollHeight : -1,
        clientH: scroll ? scroll.clientHeight : -1,
        title: (document.body.innerText || '').includes('运行日志'),
      };
    })()`);
    check("移动端日志页：390 宽下没有横向溢出，所有可见按钮都在视口内",
      mm && mm.ok === true && mob.scrollW <= mob.vw + 1 && mob.outside.length === 0,
      "scrollWidth<=vw 且 outside=0", JSON.stringify({ mounted: mm, ...mob }));
    check("移动端日志页：仍渲染虚拟行，滚动容器有真实高度",
      mob.rows > 0 && mob.scrollH > mob.clientH,
      "rows>0 且 scrollHeight>clientHeight", JSON.stringify(mob));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const p = SHOT_PATH.replace(/\.png$/, "-logsmobile.png");
      fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端日志取证帧 → " + p);
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/*
 * 「错误提示要跟着语言走，也不许把后端原始串印到屏幕上」（--only=errtext）。
 *
 * 为什么还要一段真界面：这条链的单测能证分类器返回哪个键、也能证中英词典都收了这个键，
 * 但有两件事单测看不见：
 *  1) **调用点接的到底是不是分类器**。改回 ``toast(`发送失败：${e}`)`` 那种老形状，
 *     errors.test.ts 一条都不会红，而用户屏幕上出现的是 `os error 2`。
 *  2) vue-i18n 真的把键**翻成了句子**。键漏了或拼错时它回落印裸 key ⇒ 屏幕上就是
 *     `errors.rule.system`，比原始串更难懂。
 * 所以这里让 getLogs 抛一条后端真实形状的错误，读错误块那两行的**文本**。
 *
 * 排在 locale 段之后：那段结束时偏好已是 zh-CN；本段先切 en 再切回，离开时仍是 zh-CN。
 */
async function runErrorText(cdp, url) {
  // Rust 侧 IO 错误的真实形状（errors.ts 的"技术签名"就靠它判）。
  const RAW = "open /tmp/gosslan-probe.log failed: No such file or directory (os error 2)";
  const CJK = /[\u3400-\u9FFF\u3040-\u30FF]/;

  /** 期望值直接从词典模块读（而不是在判据里手抄句子）：改了文案不必同批改探针。 */
  const dict = () => cdp.eval(`(async () => {
    var z = (await import('/src/i18n/locales/zh-cn.ts')).zhCN;
    var e = (await import('/src/i18n/locales/en-us.ts')).enUS;
    return { zhTitle: z['logs.loadFail'], zhRule: z['errors.rule.system'], zhJoin: z['errors.joined'],
      enTitle: e['logs.loadFail'], enRule: e['errors.rule.system'], enJoin: e['errors.joined'] };
  })()`);

  /** 一种语言一次全新挂载：loadError 是"抛的那一刻"现算的字符串，切语言不会自己重算。 */
  const mountFail = async (pref) => {
    await cdp.send("Page.bringToFront").catch(() => {});
    await cdp.send("Page.navigate", { url });
    await sleep(2_600);
    await cdp.eval(PAGE_FIXTURE);
    const lang = await cdp.eval("(async () => { var m = await import('/src/i18n/index.ts');"
      + ` m.applyPreference('${pref}'); return m.currentLocale(); })()`);
    await cdp.eval(`window.__probe.stubApiFail('getLogs', ${JSON.stringify(RAW)})`);
    const mounted = await cdp.eval(
      `window.__probe.install('/src/components/LogViewer.vue', '', ${JSON.stringify(JSON.stringify({ standalone: true }))})`,
    );
    await sleep(900);
    const lines = await cdp.eval(`(() => {
      const box = document.querySelector('#probe-host [role="alert"]');
      if (!box) return null;
      return [...box.querySelectorAll(':scope > div')]
        .map((d) => (d.innerText || '').replace(/\\s+/g, ' ').trim());
    })()`);
    return { lang, mounted, lines: lines || [] };
  };

  const d = await dict();
  const en = await mountFail("en-US");
  const enWant = d.enJoin.replace("{prefix}", d.enTitle).replace("{detail}", d.enRule);
  check("错误文案·英文档：技术错误落到界面上是词典拼出的那句英文（不是裸 key、不是原始串）",
    en.lang === "en-US" && !!en.mounted && en.mounted.ok === true
    && en.lines[0] === d.enTitle && en.lines[1] === enWant,
    "标题==logs.loadFail 且正文==errors.joined 拼出的句子",
    JSON.stringify({ lang: en.lang, ok: en.mounted && en.mounted.ok, lines: en.lines }));
  check("错误文案·英文档：错误块整块没有中日韩字，也没有后端串（os error / 文件路径 / 裸 key 都不许上屏）",
    en.lines.length > 0 && !en.lines.some((l) => CJK.test(l))
    && !en.lines.some((l) => /os error|gosslan-probe\.log/.test(l))
    && !en.lines.some((l) => /errors\.[a-z]/.test(l)),
    "无 CJK、无 os error/路径、无 errors. 前缀", JSON.stringify(en.lines));

  const zh = await mountFail("zh-CN");
  const zhWant = d.zhJoin.replace("{prefix}", d.zhTitle).replace("{detail}", d.zhRule);
  check("错误文案·中文档：同一条错误拼成词典那句中文 ⇒ 两个出口跟的是同一个语言事实源",
    zh.lang === "zh-CN" && !!zh.mounted && zh.mounted.ok === true
    && zh.lines[0] === d.zhTitle && zh.lines[1] === zhWant,
    "标题/正文等于 zh 词典拼出的句子", JSON.stringify({ lang: zh.lang, lines: zh.lines }));
  check("错误文案：换语言确实换了内容（两档正文互不等，且都没漏原始串）",
    zh.lines[1] !== en.lines[1] && CJK.test(String(zh.lines[1] || ""))
    && !/os error/.test(String(zh.lines[1] || "")),
    "zh 正文含 CJK、与 en 正文不同、不含 os error",
    JSON.stringify({ en: en.lines[1], zh: zh.lines[1] }));
}

async function runSearch(cdp, url) {
  // 窗口被别的应用盖住时 document.visibilityState=hidden，CSS 动画时钟会冻在 0
  // （playState 仍是 running）⇒ 页面转场停在 translateX(100%)，弹窗整个在视口外。
  // 全量顺序跑时实测「emoji 段之后 search 段红、单跑绿」就是这一条。先提到前台。
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const GROUP = {
    conv_id: "conv-probe", name: "探针会话", kind: "private", avatar: null,
    total: 3, latest_ts: 1,
    // ⚠️ 三条**不能都是 text**：这一段的夹具以前全是 `kind: "text"`，于是它和
    //   `chatSearch.test.ts` 犯的是同一个盲点 —— 载荷型 kind 渲染成人话这件事从没被真渲染过
    //   （用户 2026-10-09：「搜索列表显示的都是 json」）。这里刻意混进两种卡片 kind：
    //   任务与图片的载荷都是 JSON，漏回旧写法就会在页面上出现花括号。
    messages: [
      { msg_id: "m0", sender_id: "p1", sender_name: "小布", kind: "text", content: "命中 0", ts: 1 },
      { msg_id: "m1", sender_id: "p1", sender_name: "小布", kind: "todo",
        content: '{"title":"命中 待办","assignees":["p1"],"status":"todo","priority":"high"}', ts: 2 },
      { msg_id: "m2", sender_id: "p1", sender_name: "小布", kind: "image",
        content: '{"name":"命中.png","path":"/x/命中.png","size":2048,"sha256":"ab12"}', ts: 3 },
    ],
  };
  await cdp.eval(
    `window.__probe.install('/src/components/search/ChatSearchDialog.vue', '', ${JSON.stringify(JSON.stringify({ initialKeyword: "初" }))})`,
  );
  await cdp.eval(`window.__probe.stubApi('searchChatHistory', ${JSON.stringify([GROUP])})`);
  // 打开弹窗时的检索次数：关键词/筛选的复位 watcher 若也发请求，这里会多 1。
  await cdp.eval(`(async () => {
    const m = await import('/src/api/index.ts');
    const f = m.api.searchChatHistory;
    window.__searchOpenCalls = 0;
    m.api.searchChatHistory = async (...a) => {
      window.__searchOpenCalls += 1;
      return f(...a);
    };
  })()`);
  await cdp.eval("window.__probe.setOpen(true)");
  // 搜索弹窗是整页转场（BaseModal 的 gosslan-dialog-page，translateX(100%) → 0）。
  // 不能用 playState 判"就位"：窗口被盖住时 document.visibilityState=hidden，动画时钟冻在 0，
  // playState 仍是 running、transform 永远停在 translateX(100%)（实测 emoji 段之后就是这样）。
  // 所以这里等的是**弹窗矩形真的进视口**；发现页面 hidden 就再把窗口提到前台。
  let settled = null;
  for (let i = 0; i < 80; i += 1) {
    settled = await cdp.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return { ok: false, why: "no-dialog" };
      const b = d.getBoundingClientRect();
      return { ok: b.left >= -1 && b.right <= innerWidth + 1
          && b.top >= -1 && b.bottom <= innerHeight + 1,
        vis: document.visibilityState, x: Math.round(b.x), w: Math.round(b.width) };
    })()`);
    if (settled.ok) break;
    if (settled.vis === "hidden") await cdp.send("Page.bringToFront").catch(() => {});
    await sleep(50);
  }
  if (!settled || !settled.ok) {
    console.log("  · 搜索弹窗入场未就位：" + JSON.stringify(settled));
  }
  // 打开 watcher 里的检索是异步的（await nextTick 后才发）；先等它真的发出去，
  // 再留 250ms 给"关键词/筛选复位 watcher 的 150ms 防抖"——有第二条就会在这段里出现。
  for (let i = 0; i < 60; i += 1) {
    if (await cdp.eval("window.__searchOpenCalls")) break;
    await sleep(50);
  }
  await sleep(250);
  const openCalls = await cdp.eval("window.__searchOpenCalls");
  const openDiag = await cdp.eval(`({
    open: window.__st && window.__st.open,
    initialKeyword: window.__st && window.__st.initialKeyword,
    input: (document.querySelector('input') || {}).value,
    calls: window.__searchOpenCalls,
  })`);
  check("打开弹窗只发一次检索（筛选项复位不再触发第二次 IPC）",
    openCalls === 1, "1 次", JSON.stringify(openDiag));
  const typed = await cdp.eval(`window.__probe.typeKeyword('命中')`);
  const hits = () => cdp.eval("window.__probe.hits()");
  const h0 = await hits();

  check("输入关键词后命中列表真渲染出 3 行（api 替身被真调用、结果真进了组件）",
    h0.n === 3, "3 行", `${h0.n} 行 / 输入框聚焦=${typed.focused}`);
  check("默认高亮落在第一条（不是没有高亮，也不是越界）",
    h0.at === 0, "at=0", h0.at);

  // ---------------- 本轮补：两条搜索缺陷在**真渲染**层各判一次 ----------------
  // 静态判据与单测判的是"cellText 有没有过 previewBody"，判不到"页面上到底长什么样"。
  // 这里读的是渲染完的整页文字：漏回旧写法就会露出 `{"title":` / `"sha256":` 这种东西。
  const pageText = await cdp.eval("window.__probe.text()");
  const leaked = ['{"', '"title":', '"sha256":', '"assignees":'].filter((s) => pageText.includes(s));
  check("命中行与左栏摘要里不许出现载荷原文（六种认识的卡片 kind 那一半）",
    h0.n === 3 && leaked.length === 0, "整页文字里没有 JSON 片段",
    `泄漏片段 ${JSON.stringify(leaked)} / 行数=${h0.n}`);
  check("对照：卡片 kind 确实渲染成了人话（不是整行空掉，也不是退化成未知 kind 占位）",
    pageText.includes("[任务] 命中 待办") && pageText.includes("[图片]")
      && !pageText.includes("不支持的消息"),
    "出现「[任务] 命中 待办」与「[图片]」", JSON.stringify(pageText.slice(0, 260)));
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-search.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 聊天搜索取证帧 → " + SHOT_PATH.replace(/\.png$/, "-search.png"));
  }

  // 筛选菜单的底：`.gosslan-menu` 自己不带背景，底在 `.frost` 上 —— 少挂一个类零报错，
  // 而坏法是"文字叠在底下的结果行上"。这里读计算后的 background-color，不读 class 列表
  // （读 class 就又回到"标着不等于有"那一类错）。
  const chip = await cdp.eval("window.__probe.filterChip()");
  check("对照：拿得到「发送人」筛选入口的落点（拿不到下面那条就是空跑）",
    !!chip && chip.x > 0 && chip.y > 0, "坐标 >0", JSON.stringify(chip));
  if (chip) {
    await cdp.click(chip.x, chip.y);
    // 点完等菜单真的进来再读样式：Vue 的 v-if 走微任务调度，CDP 的 click 返回与下一帧
    // 谁先到没有保证。这不是放宽判据：菜单一直不出现仍然会红，只是不再把"还没渲染"读成"透明"。
    let st = await cdp.eval("window.__probe.menuStyle()");
    for (let i = 0; i < 20 && !st.present; i += 1) {
      await sleep(50);
      st = await cdp.eval("window.__probe.menuStyle()");
    }
    check("点开筛选菜单：它自己必须真有底（透明 = 用户那句「筛选下拉都是透明的」）",
      st.present === true && st.bg !== "rgba(0, 0, 0, 0)" && st.bg !== "transparent",
      "计算后的背景色不是透明", JSON.stringify({ st, settled }));
    check("筛选菜单从 Dialog 里 Portal 出去后仍可命中、没被 aria-hidden/pointer-events 关掉",
      st.present === true && st.hit === true && st.hidden === false && st.pe !== "none",
      "hit=true / hidden=false / pointer-events≠none",
      JSON.stringify({ hit: st.hit, hidden: st.hidden, pe: st.pe }));
    // 菜单与键盘判据共用这个弹窗，而方向键挂在**输入框**上：点过菜单必须把焦点还回去，
    // 否则下面那批 ↑↓ 会红在夹具上而不是产品上。
    const refocus = await cdp.eval("window.__probe.focusInput()");
    check("对照可逆：关掉菜单、焦点回到输入框（下面那批键盘判据的前提）",
      refocus === true, "activeElement 又是输入框", refocus);
  }

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const h1 = await hits();
  check("↓ 把高亮移到第二条", h1.at === 1, "at=1", h1.at);
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const h2 = await hits();
  check("再按 ↓ 移到第三条", h2.at === 2, "at=2", h2.at);
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const hClamp = await hits();
  check("最后一条再按 ↓ 钳住不动（越界会让 aria-current 消失，读屏就丢了当前位置）",
    hClamp.at === 2, "at=2", hClamp.at);
  await cdp.key("ArrowUp", "ArrowUp", "", 38);
  const hUp = await hits();
  check("↑ 把高亮移回第二条", hUp.at === 1, "at=1", hUp.at);

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await cdp.eval("window.__probe.reset()");
  const beforeEnter = await hits();
  await cdp.key("Enter", "Enter", "\r", 13);
  const ev = await cdp.eval("window.__probe.events");
  const opened = ev.filter((e) => e[0] === "open").map((e) => JSON.parse(e[1]));
  check("在高亮那条上按回车：emit 的 open-conversation 必须是**高亮那条**（旧行为固定开第一条）",
    beforeEnter.at === 2 && opened.length === 1 && opened[0].msgId === "m2"
    && opened[0].convId === "conv-probe",
    "1 次 open 且 msgId=m2", `at=${beforeEnter.at} / ${JSON.stringify(opened)}`);
  check("跟着必须关一次弹窗（打开与关闭是同一次动作，不能只 emit 不关）",
    ev.filter((e) => e[0] === "close").length === 1, "1 次 close", JSON.stringify(ev));

  // ---------------- 迁移到 Query 后新增：乱序响应不得跨关键词回填 ----------------
  // 旧实现靠 `seq` 只认最后一次请求；现在靠 query key。这里判的是**可观察结局**：
  // 「慢」的响应晚到，页面上必须仍是「快」的结果 —— 谁也不许把旧关键字的结果铺回来。
  const SLOW = {
    ...GROUP, conv_id: "conv-slow", name: "慢结果",
    messages: [{ msg_id: "s0", sender_id: "p1", sender_name: "小布", kind: "text", content: "慢响应", ts: 1 }],
  };
  const FAST = {
    ...GROUP, conv_id: "conv-fast", name: "快结果",
    messages: [{ msg_id: "f0", sender_id: "p1", sender_name: "小布", kind: "text", content: "快响应", ts: 1 }],
  };
  await cdp.eval(`(async () => {
    const m = await import('/src/api/index.ts');
    const real = m.api.searchChatHistory;
    m.api.searchChatHistory = async (p) => {
      if (p.keyword === "慢") {
        await new Promise((r) => setTimeout(r, 700));
        return ${JSON.stringify([SLOW])};
      }
      if (p.keyword === "快") {
        await new Promise((r) => setTimeout(r, 50));
        return ${JSON.stringify([FAST])};
      }
      return real(p);
    };
  })()`);
  await cdp.eval("window.__probe.setOpen(false)");
  await cdp.eval("window.__probe.setOpen(true)");
  for (let i = 0; i < 40; i += 1) {
    if (await cdp.eval(`!!document.querySelector('[role="dialog"] input')`)) break;
    await sleep(50);
  }
  const typeNow = (text) => cdp.eval(`(() => {
    const input = document.querySelector('[role="dialog"] input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const typedSlow = await typeNow("慢");
  await sleep(300); // 防抖 150 + 慢请求已发出（700ms 后才回）
  const typedFast = await typeNow("快");
  await sleep(1_100); // 快请求已回；慢响应也已晚到并写进它自己的缓存键
  const outOfOrder = await cdp.eval(`(() => {
    const text = document.body.innerText || '';
    return {
      fast: text.includes("快结果"), slow: text.includes("慢结果"),
      input: (document.querySelector('[role="dialog"] input') || {}).value,
    };
  })()`);
  check("乱序响应不跨关键词回填：「慢」晚到后页面仍是「快」的结果",
    typedSlow === true && typedFast === true
      && outOfOrder.fast === true && outOfOrder.slow === false && outOfOrder.input === "快",
    "对照两次输入都成功 / fast=true / slow=false / input=快",
    JSON.stringify({ typedSlow, typedFast, outOfOrder }));

  // 移动端：390 宽下搜索弹窗本身、输入框、结果行与按钮都不许横向溢出。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(2_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval(`window.__probe.stubApi('searchChatHistory', ${JSON.stringify([GROUP])})`);
    await cdp.eval(
      `window.__probe.install('/src/components/search/ChatSearchDialog.vue', '', ${JSON.stringify(JSON.stringify({ initialKeyword: "初" }))})`,
    );
    await cdp.eval("window.__probe.setOpen(true)");
    for (let i = 0; i < 40; i += 1) {
      if (await cdp.eval(`!!document.querySelector('[role="dialog"] input')`)) break;
      await sleep(50);
    }
    await typeNow("初");
    await sleep(500);
    const mob = await cdp.eval(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return { ok: false };
      const buttons = [...dlg.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      const r = dlg.getBoundingClientRect();
      const text = dlg.innerText || '';
      return {
        ok: true,
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        dlgW: +r.width.toFixed(1),
        dlgH: +r.height.toFixed(1),
        vh: innerHeight,
        docScrollH: document.documentElement.scrollHeight,
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)),
        hasResults: text.includes('探针会话') || text.includes('命中'),
      };
    })()`);
    check("移动端搜索：390 宽下整页铺满、页面本身不滚（只有结果区滚）、无越界按钮",
      mob.ok === true && mob.dlgW <= mob.vw && mob.dlgH >= mob.vh - 1
        && mob.scrollW <= mob.vw + 1 && mob.docScrollH <= mob.vh + 1
        && mob.outside.length === 0,
      "dlg.width<=vw + dlg.height>=vh + 页面不滚 + outside=0", JSON.stringify(mob));
    check("移动端搜索：结果仍渲染（不是只摆了一个空壳）",
      mob.ok === true && mob.hasResults === true, "结果文本可见", JSON.stringify(mob));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-searchmobile.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端搜索取证帧 → " + SHOT_PATH.replace(/\.png$/, "-searchmobile.png"));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 任务卡片那一段（#97：把「那张卡真出现在时间线里」从"没有断言"换成运行时断言）。
 *
 * 上游本来就有三道锁，但它们判的都不是界面：`storeContract` 判"记录进没进 store"、
 * `messageKinds` 判"会不会被时间线过滤掉 / 有没有人渲染它"、`todos.test.ts` 判数据层。
 * 用户最初报的是**看不见** —— 那件事只有真渲染一次才判得了，所以这一段挂的是
 * `TodoCardBubble` 本身（不是 MessageItem：气泡容器要 Tauri 事件与一堆 store，
 * 在探针里挂它会让人怀疑红的是夹具而不是产品）。
 *
 * 顺带把 #112（卡片图走统一预览）与 §9（描述里的 @）这两条在运行时层各判一次 ——
 * 结构级判据说"调用点给了 clickable"，这里判"按 Enter 之后那份预览真的开了"。
 */
/**
 * 右键菜单那一段（--only=ctxmenu）。
 *
 * 2026-10-18 把外壳从自建 Teleport/document click/window keydown/焦点循环迁到 Reka DropdownMenu 的
 * 虚拟锚点。源码判据只能证明"调用点换了库"，这里在真渲染里判四件会静默坏掉的事：
 *  ① 菜单真的出现在鼠标坐标处（锚点没接上时 Reka 会落在 (0,0) 或触发元素上）；
 *  ② ↑↓ 的 roving focus 真把焦点放到条目上，且回车选中**那一条**并发出对应动作；
 *  ③ Esc / 点外部各关一次（自建监听回潮会双份关闭），关闭后焦点回到打开前的元素；
 *  ④ 贴右下角弹出时整块仍在视口内（floating-ui 翻转替代了原来的手写 clamp）。
 */
async function runCtxMenu(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  // installMenu 复用的是 install 拿到的页面那份 vue/pinia ⇒ 先普通挂一次引导。
  await cdp.eval("window.__probe.install('/src/components/TitleBar.vue', '', '')");

  const mount = async (props) => {
    const r = await cdp.eval(`window.__probe.installMenu(${JSON.stringify(JSON.stringify(props))})`);
    await sleep(300);
    return r;
  };
  const menu = () => cdp.eval("window.__probe.menu()");
  const events = () => cdp.eval("window.__probe.events");

  const boot = await mount({ x: 320, y: 80, kind: "text", canPin: true, quotedId: "q1" });
  check("对照：菜单夹具挂得上（挂不上下面几条就是空跑）",
    !!boot && boot.ok === true, "ok=true", JSON.stringify(boot));

  const m0 = await menu();
  check("菜单在鼠标坐标处弹出（下方有空间时左上角落到 (320,80)，不是默认的 0,0）",
    m0.present === true && Math.abs(m0.left - 320) <= 2 && Math.abs(m0.top - 80) <= 2 && m0.side === "bottom",
    "left≈320 / top≈80 / side=bottom",
    JSON.stringify({ left: m0.left, top: m0.top, side: m0.side }));
  check("菜单是 role=menu，七个条目全部被 Reka 收进菜单集合",
    m0.present === true && m0.orientation === "vertical" && m0.items.length === 7,
    "7 条 menuitem", JSON.stringify(m0.items));
  check("菜单自己仍有实底（.gosslan-menu 的 frost 底没被迁移丢掉）",
    m0.present === true && m0.bg !== "rgba(0, 0, 0, 0)" && m0.bg !== "transparent",
    "背景不是透明", m0.bg);

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const k1 = await menu();
  check("↓ 把焦点移到第一条（Reka roving focus 接管，不是外壳自建循环）",
    k1.active === 0, "active=0", k1.active);
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const k2 = await menu();
  check("再 ↓ 移到第二条", k2.active === 1, "active=1", k2.active);

  await cdp.eval("window.__probe.reset()");
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(200);
  const evEnter = await events();
  const afterEnter = await menu();
  check("回车选中高亮那条：只发该条动作并卸载菜单（不是只关不发）",
    evEnter.some((e) => e[0] === "pin") && afterEnter.present === false,
    "pin + 菜单消失", JSON.stringify(evEnter));
  check("回车关闭后焦点回到打开前的元素（键盘用户不丢焦点）",
    await cdp.eval("document.activeElement && document.activeElement.id === 'opener'") === true,
    "activeElement=#opener", await cdp.eval("document.activeElement && document.activeElement.id"));

  await cdp.eval("window.__probe.reset()");
  await mount({ x: 200, y: 180, kind: "text" });
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(200);
  const evEsc = await events();
  const afterEsc = await menu();
  check("Esc 关菜单且 close 只发一次（自建 window keydown 回潮会变成两次）",
    afterEsc.present === false && evEsc.filter((e) => e[0] === "close").length === 1,
    "菜单消失 + close×1", JSON.stringify(evEsc));
  check("Esc 后焦点也回到打开前的元素",
    await cdp.eval("document.activeElement && document.activeElement.id === 'opener'") === true,
    "activeElement=#opener", await cdp.eval("document.activeElement && document.activeElement.id"));

  const vp = await cdp.eval("({ w: window.innerWidth, h: window.innerHeight })");
  await cdp.eval("window.__probe.reset()");
  await mount({ x: 200, y: 180, kind: "text" });
  await cdp.click(vp.w - 30, vp.h - 30);
  await sleep(200);
  const evOut = await events();
  const afterOut = await menu();
  check("点菜单外关闭（DismissableLayer 真接住了外部指针）",
    afterOut.present === false && evOut.filter((e) => e[0] === "close").length === 1,
    "菜单消失 + close×1", JSON.stringify(evOut));

  await cdp.eval("window.__probe.reset()");
  await mount({ x: vp.w - 10, y: vp.h - 10, kind: "text", canPin: true });
  const corner = await menu();
  check("贴右下角弹出时整块翻到视口内（floating-ui 的翻转替代了手写 clamp）",
    corner.present === true && corner.left >= 0 && corner.top >= 0
      && corner.right <= vp.w && corner.bottom <= vp.h && corner.right < vp.w - 5,
    `四边都在 0..${vp.w}x${vp.h} 且没有顶到右边`,
    JSON.stringify({ before: corner, vp }));
}

/**
 * 窄视口里菜单贴边那一段（--only=menufit，专项 §十 P0「菜单贴边运行时验证」）。
 *
 * §6.85 删掉父级手算收边的理由是"贴边内收归 Reka 的 popper"，可 ctxmenu 那一格只在**默认视口**
 * 量过一次右下贴边 —— 手机档（390 宽）从没量过，而 Windows 那堵"窄辅助窗"报的就是这一档。
 * 挂法沿用 §6.88 带回的那条结论：**挂父级、靠状态渲染**（installMenu 第二参数点名业务菜单），
 * 不是把菜单组件当根强开（那条路径下 Reka 的 Content 根本不进 DOM，实测 errs 为空）。
 *
 * 判三件会静默坏掉的事：
 *  ① 业务菜单在 390×844 的右下角打开 ⇒ 整块仍在视口内（几何 owner 只有 ContextMenu 这一处）；
 *  ② 说明行（`.gosslan-menu-hint`）也在视口内 —— 它是纯 div、不进菜单集合，popper 最容易漏量它；
 *  ③ 把 popper wrapper 推出右缘 ⇒ 同一条读数必须翻假，再换回来必须又成立（证明这条会咬且不留残留）。
 */
async function runMenuFit(cdp, url) {
  const MENUS = [
    { label: "会话", path: "/src/components/conversation/ConversationContextMenu.vue",
      emits: ["toggle-pin", "delete"], props: { pinned: true } },
    { label: "联系人", path: "/src/components/conversation/FriendContextMenu.vue",
      emits: ["chat", "confirm"], props: {} },
  ];
  const mount = async (m, x, y) => {
    const props = JSON.stringify(Object.assign({ x, y }, m.props));
    const spec = JSON.stringify({ path: m.path, emits: m.emits });
    const r = await cdp.eval(`window.__probe.installMenu(${JSON.stringify(props)}, ${JSON.stringify(spec)})`);
    await sleep(350);
    return r;
  };
  // 读的是**判据用的同一组数**（不是另算一份），所以第 ③ 步的翻假才是这条判据自己翻。
  const box = () => cdp.eval(`(() => {
    const el = document.querySelector('[role="menu"].gosslan-menu');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const hints = Array.from(el.querySelectorAll('.gosslan-menu-hint')).map((h) => {
      const q = h.getBoundingClientRect();
      return { left: Math.round(q.left), right: Math.round(q.right), bottom: Math.round(q.bottom) };
    });
    return {
      present: true,
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      vw, vh,
      items: el.querySelectorAll('[role="menuitem"]').length,
      hints,
      inside: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
      hintsInside: hints.length > 0
        && hints.every((h) => h.left >= -1 && h.right <= vw + 1 && h.bottom <= vh + 1),
    };
  })()`);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(2_000);
    await cdp.eval(PAGE_FIXTURE);
    // installMenu 复用页面里那份 vue/pinia ⇒ 先普通挂一次把两者带进来（ctxmenu 段同一写法）。
    await cdp.eval("window.__probe.install('/src/components/TitleBar.vue', '', '')");

    const vp = await cdp.eval("({ w: window.innerWidth, h: window.innerHeight })");
    check("对照：窄视口夹具真生效（390×844，不是默认桌面宽度）",
      vp.w === 390 && vp.h === 844, "390x844", JSON.stringify(vp));

    for (const m of MENUS) {
      await cdp.eval("window.__probe.reset()");
      const boot = await mount(m, vp.w - 6, vp.h - 6);
      check(`对照：${m.label}菜单挂得上（挂不上下面两条就是空跑）`,
        !!boot && boot.ok === true, "ok=true", JSON.stringify(boot));
      const b = await box();
      check(`${m.label}菜单在 390 宽的右下角打开时整块仍在视口内（内收归 popper）`,
        b.present === true && b.items >= 2 && b.inside === true,
        "present + items>=2 + 四边在 0..390x844", JSON.stringify(b));
      check(`${m.label}菜单的说明行也在视口内（纯 div、不进菜单集合，最容易被漏量）`,
        b.present === true && b.hintsInside === true,
        "hint 至少一条且都在视口内", JSON.stringify({ hints: b.hints, vw: b.vw, vh: b.vh }));
    }

    // 反向对照：把 popper wrapper 推到右缘外，上面那条 inside 读数必须翻假。
    await cdp.eval("window.__probe.reset()");
    await mount(MENUS[0], vp.w - 6, vp.h - 6);
    const clean = await box();
    const pushed = await cdp.eval(`(() => {
      const el = document.querySelector('[role="menu"].gosslan-menu');
      if (!el) return { found: false };
      const wrap = el.parentElement;
      if (!wrap) return { found: false, why: 'no-wrapper' };
      wrap.dataset.probePushed = '1';
      wrap.style.position = 'fixed';
      wrap.style.left = (window.innerWidth + 120) + 'px';
      wrap.style.transform = 'none';
      return { found: true, tag: wrap.tagName.toLowerCase() };
    })()`);
    const bad = await box();
    check("对照：把 popper wrapper 推出右缘 ⇒ 同一条 inside 读数真的翻假（判据不空转）",
      pushed.found === true && bad.present === true && clean.inside === true
        && bad.inside === false && bad.right > bad.vw + 1,
      "推之前 inside=true / 推之后 inside=false",
      JSON.stringify({ pushed, cleanInside: clean.inside, badInside: bad.inside, badRight: bad.right, vw: bad.vw }));

    await cdp.eval(`(() => {
      const el = document.querySelector('[role="menu"].gosslan-menu');
      if (!el || !el.parentElement) return false;
      const wrap = el.parentElement;
      wrap.style.position = ''; wrap.style.left = ''; wrap.style.transform = '';
      wrap.removeAttribute('data-probe-pushed');
      return true;
    })()`);
    await sleep(120);
    const restored = await box();
    check("对照可逆：wrapper 换回原样之后整块又回到视口内（对照自己不留残留）",
      restored.present === true && restored.inside === true,
      "inside=true", JSON.stringify(restored));
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 三选一字段那一段（--only=todopick）。
 *
 * `TodoPickField` 是状态/优先级/类型三格共用的锚定下拉，2026-10-18 从手写
 * `role=menu` + 全屏遮罩迁到 Reka DropdownMenu。源码判据只能证明调用了库；
 * 这里在真渲染里判：入口真能开、↓ 跳过禁用的当前项、回车选中发值并收起。
 */
/**
 * 设置开关那一段（--only=switch）。
 *
 * `SettingsToggle` 是 9 个调用点共用的开关，2026-10-18 从自绘 button 迁到 Reka Switch。
 * 这里在真渲染里判：role=switch 与必填可访问名由库写、点击确实 emit、禁用时不再 emit。
 */
async function runSwitch(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mount = async (props) => {
    await cdp.eval(
      `window.__probe.install('/src/components/settings/SettingsToggle.vue', '', ${JSON.stringify(JSON.stringify(props))})`,
    );
    await sleep(150);
  };
  const info = () => cdp.eval("window.__probe.switchInfo()");
  const events = () => cdp.eval("window.__probe.events");

  await mount({ modelValue: false, label: "深色模式", size: "md" });
  const s0 = await info();
  check("开关由 Reka 渲染成 role=switch，且可访问名来自必填 label",
    s0.present === true && s0.label === "深色模式", "role=switch / label=深色模式", JSON.stringify(s0));
  check("初始 aria-checked=false、未禁用", s0.checked === "false" && s0.disabled === false,
    "checked=false / disabled=false", JSON.stringify({ checked: s0.checked, disabled: s0.disabled }));
  if (s0.present) {
    await cdp.eval("window.__probe.reset()");
    await cdp.click(s0.x, s0.y);
    await sleep(150);
    const ev = await events();
    check("点一下开关：emit update:modelValue=true",
      ev.some((e) => e[0] === "update" && e[1] === "true"), "update=true", JSON.stringify(ev));
  }

  await cdp.eval("window.__probe.reset()");
  await mount({ modelValue: false, label: "深色模式", disabled: true });
  const s1 = await info();
  if (s1.present) await cdp.click(s1.x, s1.y);
  await sleep(150);
  const evDisabled = await events();
  check("禁用态：点击不发 update，且 disabled 属性在",
    s1.present === true && s1.disabled === true && evDisabled.length === 0,
    "disabled=true / 0 个事件", JSON.stringify({ disabled: s1.disabled, events: evDisabled }));
}

/**
 * 群文件面板：TanStack Query 真实业务迁移的端到端判据。
 * 不再是"读一眼组件源码"——这里跑真实组件 + 真实 QueryClient，只把两条 IPC 命令换成夹具。
 */
async function runGroupFiles(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.groupFilesBus()");
  const mounted = await cdp.eval("window.__probe.install('/src/components/GroupFilesPanel.vue', '', '')");
  await sleep(150);

  const open = async (v) => {
    await cdp.eval(`window.__probe.setOpen(${v})`);
    await sleep(700);
  };
  const group = async (gid) => {
    await cdp.eval(`window.__probe.setGroup(${JSON.stringify(gid)})`);
    await sleep(700);
  };
  const info = () => cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const text = dlg ? dlg.innerText : '';
    return {
      dialog: !!dlg,
      files: dlg ? [...dlg.querySelectorAll('[title$=".bin"]')].map((el) => el.getAttribute('title')) : [],
      text,
      calls: window.__gf.calls.slice(),
      subs: window.__gf.subs,
      unsub: window.__gf.unsub,
      qc: !!window.__qc,
    };
  })()`);
  const cache = (gid) => cdp.eval(`(() => {
    const q = window.__qc && window.__qc.getQueryCache().find({ queryKey: ['groupFiles', ${JSON.stringify(gid)}] });
    return q ? { status: q.state.status, hasData: Array.isArray(q.state.data) && q.state.data.length > 0 } : null;
  })()`);
  const fire = async () => {
    await cdp.eval("window.__gf.emit()");
    await sleep(700);
  };

  check("夹具装上了真实的 QueryClient（否则面板 setup 就会抛 no QueryClient）",
    mounted && mounted.ok === true && (await info()).qc === true, "QueryClient 在", JSON.stringify(mounted));

  await group("g1");
  await open(true);
  let s = await info();
  check("打开面板：按群拉一次清单并渲染文件行",
    s.dialog && s.calls.join(",") === "g1" && s.files.includes("g1.bin"),
    "calls=[g1] / g1.bin", JSON.stringify({ calls: s.calls, files: s.files }));

  await open(false);
  await open(true);
  s = await info();
  check("关掉再打开：同一群也重新拉取（staleTime 0，不是读旧快照）",
    s.calls.join(",") === "g1,g1" && s.files.includes("g1.bin"),
    "calls=[g1,g1]", JSON.stringify({ calls: s.calls, files: s.files }));

  await group("g2");
  s = await info();
  check("面板开着时换群：立刻请求新群，旧群文件不再出现在面板里",
    s.calls.join(",") === "g1,g1,g2" && s.files.includes("g2.bin") && !s.files.includes("g1.bin"),
    "calls=[g1,g1,g2] / 只有 g2.bin", JSON.stringify({ calls: s.calls, files: s.files }));
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-files.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 群文件取证帧 → " + SHOT_PATH.replace(/\.png$/, "-files.png"));
  }

  const before = s.calls.length;
  await fire();
  s = await info();
  check("文件事件到达：只失效当前群并重拉一次",
    s.calls.length === before + 1 && s.calls[s.calls.length - 1] === "g2",
    `calls +1（${before} → ${before + 1}）且最后一条是 g2`,
    JSON.stringify({ calls: s.calls }));

  // 刷新失败：旧清单必须留着（走 warning banner），缓存状态变 error。
  await cdp.eval("window.__gf.fail = true");
  const beforeFail = (await info()).calls.length;
  await fire();
  s = await info();
  const st = await cache("g2");
  check("刷新失败保留旧清单：文件行还在，查询状态 error，且确实重试过一次",
    s.files.includes("g2.bin") && st && st.status === "error" && st.hasData
      && s.calls.length === beforeFail + 2,
    "g2.bin 仍在 / status=error / 2 次尝试",
    JSON.stringify({ files: s.files, cache: st, calls: s.calls }));

  await cdp.eval("window.__gf.fail = false");
  await fire();
  s = await info();
  check("失败后恢复：下一次事件失效把清单拉回 success",
    (await cache("g2")).status === "success" && s.files.includes("g2.bin"),
    "status=success", JSON.stringify(await cache("g2")));

  await open(false);
  s = await info();
  check("关掉面板：事件订阅成对摘除（subs === unsub）",
    s.subs > 0 && s.unsub === s.subs, `subs=${s.subs} / unsub=${s.unsub}`,
    JSON.stringify({ subs: s.subs, unsub: s.unsub }));

  // 移动端：同一面板 390 宽，文件行与操作按钮都不许横向溢出。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(2_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval("window.__probe.groupFilesBus()");
    await cdp.eval("window.__probe.install('/src/components/GroupFilesPanel.vue', '', '')");
    await group("g1");
    await open(true);
    const mob = await cdp.eval(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return { ok: false };
      const buttons = [...dlg.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      const r = dlg.getBoundingClientRect();
      return {
        ok: true,
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        dlgW: +r.width.toFixed(1),
        files: [...dlg.querySelectorAll('[title$=".bin"]')].map((el) => el.getAttribute('title')),
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)),
      };
    })()`);
    check("移动端群文件：390 宽下列表渲染，且无横向溢出/越界按钮",
      mob.ok === true && mob.files.includes("g1.bin")
        && mob.scrollW <= mob.vw + 1 && mob.outside.length === 0,
      "g1.bin + scrollWidth<=vw + outside=0", JSON.stringify(mob));
    check("移动端群文件：面板宽度不超出视口",
      mob.ok === true && mob.dlgW !== null && mob.dlgW <= mob.vw,
      "dialog.width <= vw", JSON.stringify({ dlgW: mob.dlgW, vw: mob.vw }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-filesmobile.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端群文件取证帧 → " + SHOT_PATH.replace(/\.png$/, "-filesmobile.png"));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 收藏面板（--only=favorites）：只替 api.listFavorites 一条 IPC，store/面板逻辑全真实。
 * 判据是可观察结局：行数、搜索/筛选后的剩余行、详情正文与操作条、移动端两级下钻与返回。
 */
/**
 * 「名字上限要看得见」（--only=namecap）。
 *
 * 为什么值得单列一段：`maxlength` 是**静默**截断的 —— 粘 60 字只剩 40 字，界面一句说明都没有。
 * 现在旁边挂了计数器，但"有计数器"不等于"数对"：如果它按 .length（UTF-16 单元）数、
 * 判据按码点，41 个 emoji 会上屏成 82/40 —— 一个永远达不到的超限，比没有读数更坏。
 * 所以这里灌 41 个 emoji，读真实 DOM 的计数器文本，必须正好是 41/40。
 */
async function runNameCap(cdp, url) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 900, height: 700, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval(
    "window.__probe.install('/src/components/GroupCreateModal.vue', '', JSON.stringify({ open: true }))",
  );
  await sleep(500);
  const read = () => cdp.eval(`(() => {
    const i = document.querySelector('input[maxlength]');
    if (!i) return { found: false };
    const row = i.previousElementSibling;
    const span = row && row.lastElementChild;
    return {
      found: true,
      attr: i.getAttribute('maxlength'),
      counter: span ? span.textContent.trim() : null,
      cls: span ? String(span.className) : null,
      utf16: i.value.length,
    };
  })()`);
  const before = await read();
  const typed = await cdp.eval(`(() => {
    const i = document.querySelector('input[maxlength]');
    if (!i) return false;
    // 程序化赋值绕得开 maxlength（浏览器只在真人击键/粘贴那两条路上截断）——
    // 这正好把"超限时的读数"逼出来看，不必模拟 41 次按键。
    i.value = '🐱'.repeat(41);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const after = await read();
  // 第二把尺那一格：20 个 emoji 是 20 个码点、40 个 UTF-16 单元 ⇒ maxlength 在这儿就卡住了，
  // 而 schema 与后端还会允许到 40 个码点。读数必须报**码点**（真会被存下的长度），
  // 变红却必须按**先到的那把尺**亮 ⇒ 两头都不撒谎。
  const emoji20 = await cdp.eval(`(() => {
    const i = document.querySelector('input[maxlength]');
    if (!i) return false;
    i.value = '🐱'.repeat(20);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const cap = await read();
  check("建群名称：上限绑成真属性，且空值时不出读数（不常驻噪声）",
    mounted && mounted.ok === true && before.found && before.attr === "40"
      && String(before.counter || "").indexOf("/") === -1,
    'maxlength="40" 且 未输入时没有 n/max',
    JSON.stringify({ mounted: mounted && mounted.ok, before }));
  check("建群名称：超限读数按码点算（41 个 emoji 是 41/40，不是 82/40）",
    typed && after.found && after.utf16 === 82 && after.counter === "41/40",
    "DOM 里 UTF-16 长度 82，而计数器印 41/40",
    JSON.stringify({ typed, after }));
  check("建群名称：UTF-16 先到顶时读数仍是码点、但告警色要亮",
    emoji20 && cap.found && cap.utf16 === 40 && cap.counter === "20/40"
      && String(cap.cls || "").indexOf("danger") !== -1,
    '计数器印 20/40 且 class 含 danger 色',
    JSON.stringify({ emoji20, cap }));
}

/**
 * 「输入原值 + 派生延迟镜像」这两档在真界面上的**共用时间阶梯**（§6.44 换库后的运行时覆盖）。
 *
 * 为什么要在两个时刻分别读：接线退化（派生改读原值）后界面**看起来完全正常**，只有连发粘贴才卡。
 * ⚠️ 取样时刻必须落在「渲染已经落地、时间窗还没到」那条缝里 —— 这里 50ms：Vue 的 DOM 更新排在
 * 微任务（<16ms 必然已渲染），而 `INPUT_DEFER_MS`=120ms 还没到 ⇒ 只有这个时刻读到
 * "输入框已是新值、列表仍是全量"才有判别力。**同拍读是空转的**：接不接镜像都必然读到旧 DOM
 * （§6.45 的第一版就这么写空过一次，被自己的变异当场抓住）。
 *
 * 三个挂载段的行结构不同 ⇒ 「这一行在不在」的判法与输入框/列表的选择器由调用方给，
 * 阶梯与那四条断言只留一份。
 */
const MIRROR_NAMES = ["探针甲", "探针乙", "别的项"];

/** 在一次 install 之后往真 store 里种数据（`window.__pinia` 是那次挂载才建起来的）。 */
function mirrorSeed(body) {
  return "(async () => {"
    + " const piniaUrl = performance.getEntriesByType('resource').map((e) => e.name || '')"
    + "   .find((u) => u.includes('/node_modules/.vite/deps/pinia.js?v='));"
    + " if (!piniaUrl || !window.__pinia) return { ok: false, why: 'chat store 不在（先跑一次 install）' };"
    + " const P = await import(piniaUrl);"
    + " P.setActivePinia(window.__pinia);"
    + " const S = await import('/src/stores/useChatStore.ts');"
    + " const chat = S.useChatStore();"
    + " " + body
    + " return { ok: true };"
    + "})()";
}

async function mirrorLadder(cdp, url, cfg) {
  const { label, path, props, seedBody, mode, inputSel, boxSel } = cfg;
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval(
    "window.__probe.install(" + JSON.stringify(path) + ", '', " + JSON.stringify(props) + ")");
  await sleep(500);
  const seeded = await cdp.eval(mirrorSeed(seedBody));
  await sleep(400);
  const rootOf = "(sel) => document.querySelector(sel) || document.body";
  const readExpr = "(() => {"
    + " const pick = " + rootOf + ";"
    + " const i = pick(" + JSON.stringify(inputSel) + ").querySelector('input[placeholder]');"
    + " if (!i) return { found: false, input: null, rows: 0, names: '' };"
    + " const box = pick(" + JSON.stringify(boxSel) + ");"
    + " const want = " + JSON.stringify(MIRROR_NAMES) + ";"
    + " const mode = " + JSON.stringify(mode) + ";"
    + " const has = (n) => mode === 'title'"
    + "   ? !!box.querySelector('[title=\"' + n + '\"]')"
    + "   : mode === 'aria'"
    + "     ? Array.prototype.some.call(box.querySelectorAll('[role=\"button\"][aria-label]'),"
    + "       (el) => (el.getAttribute('aria-label') || '').indexOf(n) !== -1)"
    + "     : box.children.length > 0 && Array.prototype.some.call(box.querySelectorAll('*'),"
    + "       (el) => (el.textContent || '').trim() === n);"
    + " const hit = want.filter(has);"
    + " return { found: true, input: i.value, rows: hit.length, names: hit.join('|') };"
    + "})()";
  const read = () => cdp.eval(readExpr);
  const typeExpr = (v) => "(() => {"
    + " const i = (" + rootOf + ")(" + JSON.stringify(inputSel) + ").querySelector('input[placeholder]');"
    + " if (!i) return false;"
    + " i.value = " + JSON.stringify(v) + ";"
    + " i.dispatchEvent(new Event('input', { bubbles: true }));"
    + " return true;"
    + "})()";
  const before = await read();
  await cdp.eval(typeExpr("探针"));
  await sleep(50);
  const inside = await read();
  await sleep(250);
  const after = await read();
  await cdp.eval(typeExpr(""));
  await sleep(50);
  const cleared = await read();
  await sleep(250);
  const back = await read();
  check(label + "：过滤框挂出来了，且未输入时是全量三行",
    !!mounted && mounted.ok === true && !!seeded && seeded.ok === true
      && before.found === true && before.rows === 3,
    "初值必须读到 3 行（种进 store 的三条都在）",
    JSON.stringify({ mounted: mounted && mounted.ok, seeded, before }));
  check(label + "：打字 50ms 后输入框已变、列表仍是全量（派生读的是延迟镜像，不是原值）",
    inside.found === true && inside.input === "探针" && inside.rows === 3,
    "读到 rows=2 就说明派生改读了原值 ⇒ 连发粘贴会卡回去（两档退化成一档）",
    JSON.stringify({ inside }));
  check(label + "：过了延迟窗口，列表才收到过滤结果（且是正确那两条）",
    after.found === true && after.rows === 2 && after.names === "探针甲|探针乙",
    "窗口后 rows=2、名字为 探针甲|探针乙",
    JSON.stringify({ after }));
  check(label + "：清空关键词也走同一档，窗口后回到全量（延迟镜像不是单向门）",
    cleared.found === true && cleared.rows === 2 && back.found === true && back.rows === 3,
    "清空后 50ms 仍读到 2 行、窗口后回到 3 行",
    JSON.stringify({ cleared, back }));
  return { mounted, seeded, before, inside, after, cleared, back };
}

/** §6.44 那一族的第一个挂载段：添加好友的昵称过滤（派生读 `refDebounced(keyword, 120)`）。 */
async function runFriendFilter(cdp, url) {
  await mirrorLadder(cdp, url, {
    label: "添加好友",
    path: "/src/components/AddFriendModal.vue",
    props: JSON.stringify({ open: true }),
    // 三个对端：两个昵称含「探针」⇒ 过滤后的行数与名字都有唯一答案
    seedBody: "chat.peers = ["
      + "{ device_id: 'probe-f1', nickname: '探针甲', ip: '10.0.0.11', tcp_port: 1, link: 'lan' },"
      + "{ device_id: 'probe-f2', nickname: '探针乙', ip: '10.0.0.12', tcp_port: 1, link: 'lan' },"
      + "{ device_id: 'probe-f3', nickname: '别的项', ip: '10.0.0.13', tcp_port: 1, link: 'lan' }];",
    mode: "text",
    inputSel: "body",
    boxSel: ".max-h-72",
  });
}

/** 转发弹窗：过滤的是 `chat.conversations`（与添加好友同一件能力、另一条调用面）。 */
async function runForwardFilter(cdp, url) {
  await mirrorLadder(cdp, url, {
    label: "转发弹窗",
    path: "/src/components/message/ForwardModal.vue",
    props: JSON.stringify({ open: true, kind: "text", snippet: "探针片段", count: 1 }),
    seedBody: "chat.conversations = ["
      + "{ id: 'p:probe-c1', kind: 'single', name: '探针甲', avatar: null, last_msg: null, last_ts: 1, unread: 0, pinned: false },"
      + "{ id: 'p:probe-c2', kind: 'single', name: '探针乙', avatar: null, last_msg: null, last_ts: 2, unread: 0, pinned: false },"
      + "{ id: 'p:probe-c3', kind: 'single', name: '别的项', avatar: null, last_msg: null, last_ts: 3, unread: 0, pinned: false }];",
    mode: "title",
    inputSel: "body",
    boxSel: ".max-h-64",
  });
}

/**
 * 通讯录姓名过滤：走 `useSearchKeyword` 那条共用组合（`ConversationList.vue:53`）。
 * 会话栏那一格**故意不过滤**（用户 2026-09-12：「在上面输入，列表就不要有变化了」），
 * 所以这一段必须挂 `view: "contacts"` 才量得到派生。
 */
async function runContactFilter(cdp, url) {
  await mirrorLadder(cdp, url, {
    label: "通讯录过滤",
    path: "/src/components/ConversationList.vue",
    props: JSON.stringify({ view: "contacts" }),
    seedBody: "chat.friends = ["
      + "{ device_id: 'probe-n1', nickname: '探针甲', avatar: null, device_type: 'pc', online: true },"
      + "{ device_id: 'probe-n2', nickname: '探针乙', avatar: null, device_type: 'pc', online: true },"
      + "{ device_id: 'probe-n3', nickname: '别的项', avatar: null, device_type: 'pc', online: false }];",
    mode: "aria",
    inputSel: "#probe-host",
    boxSel: "#probe-host",
  });
}

/**
 * 默认头像选择器（--only=avatar）：真组件、真浏览器、390 宽。
 *
 * 这段量的是**只有运行时才看得见**的四件事：
 *   ① 选项数必须与 `avatarSeed.ts` 派生清单相等（不是模板里手抄的另一份）；
 *   ② 点表情 / 点颜色 / 随机之后，选中态与预览同步翻面（同一次 eval 读不到 Vue 翻面后的
 *      aria-pressed，必须拆两次 eval —— 这是本文件踩过的坑）；
 *   ③ 390 宽下弹窗与两组网格都不横向溢出，确认键仍在视口内；
 *   ④ 生成的头像 SVG **真的画出了 emoji**（不是只有一块背景色）：Chromium 里把 data URL
 *      画进 canvas，数"与背景不同的像素"。这条是整个方案最大的技术前提。
 *
 * ⚠️ 这条只证明 Chromium 内核；macOS 的 WKWebView 仍是人工验收（见文件头那条边界）。
 */
async function runAvatar(cdp, url) {
  const INITIAL = { emoji: "🦊", bg: "#4284b3" };
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  // 导航会把 device metrics 复位：页面起来后再钉一次，并 reload 让 store 的 resize 监听翻到窄档。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Page.reload");
  await sleep(2_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(600);
  await cdp.eval(PAGE_FIXTURE);

  const mounted = await cdp.eval(
    `window.__probe.install('/src/components/settings/AvatarPresetDialog.vue', '', ${
      JSON.stringify(JSON.stringify({ open: true, initial: INITIAL }))
    })`,
  );
  await sleep(500);

  const read = () => cdp.eval(`(async () => {
    const A = await import('/src/utils/avatarSeed.ts');
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false };
    const emojiBtns = [...dlg.querySelectorAll('[data-avatar-emoji]')];
    const bgBtns = [...dlg.querySelectorAll('[data-avatar-bg]')];
    const pressed = (sel) => [...dlg.querySelectorAll(sel + '[aria-pressed="true"]')];
    const pe = pressed('[data-avatar-emoji]');
    const pb = pressed('[data-avatar-bg]');
    const preview = dlg.querySelector('.gosslan-avatar-box');
    const rect = dlg.getBoundingClientRect();
    const apply = dlg.querySelector('[data-avatar-apply]');
    const ar = apply ? apply.getBoundingClientRect() : null;
    const opts = dlg.querySelector('[data-avatar-options]');
    const flexes = opts ? [...opts.querySelectorAll('.flex.flex-wrap')] : [];
    return {
      ok: true,
      emojis: emojiBtns.length,
      bgs: bgBtns.length,
      emojiSetLen: A.AVATAR_EMOJIS.length,
      bgSetLen: A.AVATAR_BACKGROUNDS.length,
      emojiAllFromSet: emojiBtns.every((b) => A.AVATAR_EMOJIS.includes(b.getAttribute('data-avatar-emoji'))),
      bgAllFromSet: bgBtns.every((b) => A.AVATAR_BACKGROUNDS.includes(b.getAttribute('data-avatar-bg'))),
      pressedEmoji: pe.length === 1 ? pe[0].getAttribute('data-avatar-emoji') : null,
      pressedBg: pb.length === 1 ? pb[0].getAttribute('data-avatar-bg') : null,
      pressedEmojiCount: pe.length,
      pressedBgCount: pb.length,
      previewEmoji: (preview && preview.innerText || '').trim(),
      previewBg: preview ? getComputedStyle(preview).backgroundColor : null,
      vw: innerWidth,
      sw: document.documentElement.scrollWidth,
      dlg: { l: +rect.left.toFixed(1), r: +rect.right.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) },
      options: opts ? { scrollW: opts.scrollWidth, clientW: opts.clientWidth } : null,
      flexes: flexes.map((g) => ({ justify: getComputedStyle(g).justifyContent, display: getComputedStyle(g).display })),
      selectedEmojiInset: pe.length === 1 ? getComputedStyle(pe[0]).boxShadow.includes('inset') : false,
      selectedBgHasCheck: pb.length === 1 ? !!pb[0].querySelector('svg') : false,
      apply: ar ? { l: +ar.left.toFixed(1), r: +ar.right.toFixed(1), h: +ar.height.toFixed(1) } : null,
      inputs: dlg.querySelectorAll('input').length,
      colorInputs: dlg.querySelectorAll('input[type="color"]').length,
      textInputs: dlg.querySelectorAll('input:not([type="color"])').length,
      hasRandom: !!dlg.querySelector('[data-avatar-random]'),
    };
  })()`);

  const s0 = await read();
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-avatar.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 默认头像选择器取证帧 → " + SHOT_PATH.replace(/\.png$/, "-avatar.png"));
  }
  check("默认头像：弹窗在 390 宽下打开，选项数与随机算法的清单一致（不是手抄的第二份）",
    mounted && mounted.ok === true && s0.ok === true
      && s0.emojis === s0.emojiSetLen && s0.bgs === s0.bgSetLen
      && s0.emojiAllFromSet === true && s0.bgAllFromSet === true,
    "emoji 数=AVATAR_EMOJIS、颜色数=AVATAR_BACKGROUNDS，且每个值都在清单内",
    JSON.stringify({ mounted, emojis: s0.emojis, emojiSet: s0.emojiSetLen, bgs: s0.bgs, bgSet: s0.bgSetLen }));

  check("默认头像：打开时选中态就是传入的当前组合，预览同源",
    s0.ok === true && s0.pressedEmoji === INITIAL.emoji && s0.pressedBg === INITIAL.bg
      && s0.pressedEmojiCount === 1 && s0.pressedBgCount === 1
      && s0.previewEmoji === INITIAL.emoji
      && s0.previewBg === "rgb(66, 132, 179)",
    "恰有一个表情/一个颜色选中，预览 emoji 与背景都等于传入组合",
    JSON.stringify({ pe: s0.pressedEmoji, pb: s0.pressedBg, preview: s0.previewEmoji, bg: s0.previewBg }));

  // 点一个不同的表情：选中态与预览都要跟着翻（拆两次 eval 才读得到 Vue 翻面后的属性）。
  const nextEmoji = await cdp.eval(
    `import('/src/utils/avatarSeed.ts').then((A) => A.AVATAR_EMOJIS.find((e) => e !== ${JSON.stringify(INITIAL.emoji)}))`,
  );
  await cdp.eval(
    `document.querySelector(${JSON.stringify(`[data-avatar-emoji="${nextEmoji}"]`)}).click()`,
  );
  await sleep(200);
  const s1 = await read();
  check("默认头像：点表情后选中态唯一、预览立即跟着换（拖动/点击都不串味）",
    s1.ok === true && s1.pressedEmoji === nextEmoji && s1.pressedEmojiCount === 1
      && s1.previewEmoji === nextEmoji,
    "pressedEmoji=被点的那个且只有一个，预览 emoji 同步",
    JSON.stringify({ want: nextEmoji, got: s1.pressedEmoji, count: s1.pressedEmojiCount, preview: s1.previewEmoji }));

  // 随机：必须换一张，而且换到的仍是组合表里的行（与手动选项同一个数据集）。
  await cdp.eval("document.querySelector('[data-avatar-random]').click()");
  await sleep(200);
  const s2 = await read();
  const pairOk = await cdp.eval(
    `import('/src/utils/avatarSeed.ts').then((A) => A.AVATAR_PAIRS.some((p) => p.emoji === ${
      JSON.stringify(s2.pressedEmoji)
    } && p.bg === ${JSON.stringify(s2.pressedBg)}))`,
  );
  check("默认头像：随机一定换一张，且结果落在 AVATAR_PAIRS 里（不是另一套随机源）",
    s2.ok === true && pairOk === true
      && !(s2.pressedEmoji === s1.pressedEmoji && s2.pressedBg === s1.pressedBg)
      && s2.previewEmoji === s2.pressedEmoji,
    "组合变化 + 属于 AVATAR_PAIRS + 预览同步",
    JSON.stringify({ before: [s1.pressedEmoji, s1.pressedBg], after: [s2.pressedEmoji, s2.pressedBg], pairOk }));

  // 点一个不同的背景色：预览背景必须等于那颗色块的实测颜色。
  const nextBg = await cdp.eval(
    `import('/src/utils/avatarSeed.ts').then((A) => A.AVATAR_BACKGROUNDS.find((c) => c !== ${JSON.stringify(s2.pressedBg)}))`,
  );
  const swatchSel = `[data-avatar-bg="${nextBg}"]`;
  const swatchBg = await cdp.eval(
    `getComputedStyle(document.querySelector(${JSON.stringify(swatchSel)})).backgroundColor`,
  );
  await cdp.eval(`document.querySelector(${JSON.stringify(swatchSel)}).click()`);
  await sleep(200);
  const s3 = await read();
  check("默认头像：点背景色后预览真的换成那一格（读的是计算样式，不是自己记的值）",
    s3.ok === true && s3.pressedBg === nextBg && s3.pressedBgCount === 1
      && s3.previewBg === swatchBg,
    "pressedBg=被点的那个，预览背景=色块计算样式",
    JSON.stringify({ want: nextBg, got: s3.pressedBg, previewBg: s3.previewBg, swatchBg }));

  check("默认头像：390 宽下弹窗/选项不横向溢出，两组选项居中换行，确认键留在视口内",
    s3.ok === true && s3.sw <= s3.vw + 1
      && s3.dlg.l >= -1 && s3.dlg.r <= s3.vw + 1
      && s3.options !== null && s3.options.scrollW <= s3.options.clientW + 1
      && s3.flexes.length === 2 && s3.flexes.every((f) => f.display === "flex" && f.justify === "center")
      && s3.apply !== null && s3.apply.l >= -1 && s3.apply.r <= s3.vw + 1 && s3.apply.h >= 24,
    "scrollWidth<=vw、dialog 左右不越界、选项无横向滚动、两个 flex 都是 justifyContent=center、apply 可见且高度>=24",
    JSON.stringify({ vw: s3.vw, sw: s3.sw, dlg: s3.dlg, options: s3.options, flexes: s3.flexes, apply: s3.apply }));

  check("默认头像：选中环画在按钮内部、色块选中带勾（左右边缘不会被滚动区裁掉）",
    s3.ok === true && s3.selectedEmojiInset === true && s3.selectedBgHasCheck === true,
    "选中表情的 box-shadow 含 inset、选中色块内有勾",
    JSON.stringify({ inset: s3.selectedEmojiInset, check: s3.selectedBgHasCheck }));

  check("默认头像：没有自由文本输入，唯一的 input 是自定义取色器；随机键是按钮",
    s3.ok === true && s3.colorInputs === 1 && s3.textInputs === 0 && s3.hasRandom === true,
    "colorInputs=1、textInputs=0、random 按钮存在",
    JSON.stringify({ inputs: s3.inputs, colorInputs: s3.colorInputs, textInputs: s3.textInputs, hasRandom: s3.hasRandom }));

  // 预览固定：矮窗口里只允许选项区滚；滚动前后预览的 top 不许动。
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 600, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(400);
  const fixed = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false };
    const preview = dlg.querySelector('.gosslan-avatar-box');
    const opts = dlg.querySelector('[data-avatar-options]');
    if (!preview || !opts) return { ok: false };
    const scrollers = [...dlg.querySelectorAll('*')].filter((el) => {
      const st = getComputedStyle(el);
      return /auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1;
    });
    let sc = opts;
    while (sc && !scrollers.includes(sc)) sc = sc.parentElement;
    if (!sc) return { ok: false, scrollers: scrollers.length };
    const before = preview.getBoundingClientRect().top;
    sc.scrollTop = 240;
    const after = preview.getBoundingClientRect().top;
    // 再滚到真正的最大值：最后一颗色块（含自定义色）与确认键都必须完整落在可视区。
    sc.scrollTop = sc.scrollHeight;
    const lastOption = [...dlg.querySelectorAll('[data-avatar-bg], [data-avatar-custom-color]')].pop();
    const apply = dlg.querySelector('[data-avatar-apply]');
    const scRect = sc.getBoundingClientRect();
    const lastRect = lastOption ? lastOption.getBoundingClientRect() : null;
    const applyRect = apply ? apply.getBoundingClientRect() : null;
    return {
      ok: true,
      scrollers: scrollers.length,
      scrollTop: Math.round(sc.scrollTop),
      moved: +(before - after).toFixed(1),
      previewTop: +before.toFixed(1),
      optionsScrollH: sc.scrollHeight,
      optionsClientH: sc.clientHeight,
      maxScroll: Math.round(sc.scrollTop + sc.clientHeight) >= Math.round(sc.scrollHeight) - 1,
      lastBottom: lastRect ? +lastRect.bottom.toFixed(1) : null,
      scrollerBottom: +scRect.bottom.toFixed(1),
      applyTop: applyRect ? +applyRect.top.toFixed(1) : null,
      applyBottom: applyRect ? +applyRect.bottom.toFixed(1) : null,
      vh: innerHeight,
    };
  })()`);
  check("默认头像：矮窗口里预览固定不动，只有选项区在滚（且全弹窗只有一个滚动区）",
    fixed.ok === true && fixed.scrollers === 1 && fixed.scrollTop > 0
      && Math.abs(fixed.moved) <= 1 && fixed.optionsScrollH > fixed.optionsClientH,
    "唯一滚动区 scrollTop>0、预览 top 位移<=1px",
    JSON.stringify(fixed));
  check("默认头像：滚到最底部后，最后一颗色块与确认键都完整可见",
    fixed.ok === true && fixed.maxScroll === true && fixed.lastBottom !== null
      && fixed.lastBottom <= fixed.scrollerBottom + 1
      && fixed.applyTop !== null && fixed.applyTop >= 0
      && fixed.applyBottom !== null && fixed.applyBottom <= fixed.vh + 1,
    "maxScroll + 最后一颗色块底边≤滚动区底边 + 确认键完整在视口内",
    JSON.stringify({ maxScroll: fixed.maxScroll, lastBottom: fixed.lastBottom, scrollerBottom: fixed.scrollerBottom, apply: [fixed.applyTop, fixed.applyBottom], vh: fixed.vh }));
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(300);

  // 确认：emit 的组合必须等于屏幕上选中的那一组。
  await cdp.eval("document.querySelector('[data-avatar-apply]').click()");
  await sleep(200);
  const applied = await cdp.eval(
    `window.__probe.events.filter((e) => e[0] === 'apply').pop() || null`,
  );
  check("默认头像：点「使用这个头像」emit 的组合就是屏幕上选中的那一组",
    Array.isArray(applied) && applied[1] === s3.pressedEmoji && applied[2] === s3.pressedBg,
    "apply 事件载荷 = 选中组合",
    JSON.stringify({ event: applied, selected: [s3.pressedEmoji, s3.pressedBg] }));

  // 自定义色：取色器写入后预览必须立即变，且选中环落到自定义那颗上。
  const customSet = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false };
    const input = dlg.querySelector('input[type="color"]');
    const btn = dlg.querySelector('[data-avatar-custom-color]');
    if (!input || !btn) return { ok: false };
    input.value = '#123456';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`);
  await sleep(200);
  const customRead = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { ok: false };
    const btn = dlg.querySelector('[data-avatar-custom-color]');
    const preview = dlg.querySelector('.gosslan-avatar-box');
    return {
      ok: true,
      pressed: btn ? btn.getAttribute('aria-pressed') : null,
      previewBg: preview ? getComputedStyle(preview).backgroundColor : null,
      palettePressed: dlg.querySelectorAll('[data-avatar-bg][aria-pressed="true"]').length,
    };
  })()`);
  check("默认头像：自定义颜色写入后预览生效，选中态落在自定义色块上",
    customSet.ok === true && customRead.ok === true
      && customRead.pressed === "true" && customRead.palettePressed === 0
      && customRead.previewBg === "rgb(18, 52, 86)",
    "aria-pressed=true、调色板无选中、预览=#123456",
    JSON.stringify({ set: customSet, read: customRead }));

  // SVG 真的画出了 emoji：画进 canvas 数非背景像素。只画背景色 ⇒ 图标位置是一整块纯色，
  // 对端看到的就是"没有脸的色块"，而界面这边所有字符串判据仍然全绿。
  const art = await cdp.eval(`(async () => {
    const A = await import('/src/utils/avatarSeed.ts');
    const url = A.avatarPresetDataUrl(${JSON.stringify(INITIAL)});
    const img = new Image();
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!loaded) return { loaded: false, urlLen: url.length };
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    const bg = ${JSON.stringify(INITIAL.bg)};
    const br = parseInt(bg.slice(1, 3), 16), bgc = parseInt(bg.slice(3, 5), 16), bb = parseInt(bg.slice(5, 7), 16);
    let other = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - br) > 12 || Math.abs(px[i + 1] - bgc) > 12 || Math.abs(px[i + 2] - bb) > 12) other++;
    }
    return { loaded: true, w: img.naturalWidth, h: img.naturalHeight, other, urlLen: url.length };
  })()`);
  check("默认头像：生成的头像 SVG 真的渲染出 emoji（不是一块纯背景色）",
    art.loaded === true && art.w === 512 && art.h === 512 && art.other > 100,
    "naturalSize=512、非背景像素>100",
    JSON.stringify(art));

  // ── 资料页布局（桌面 1200 宽）：头像框与右侧字段顶/底对齐；入口文案按用户口径。 ──
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send("Page.reload");
  await sleep(2_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);
  await cdp.eval(PAGE_FIXTURE);
  const mountedProfileDesktop = await cdp.eval(
    `window.__probe.install('/src/components/settings/ProfileSection.vue', '', ${JSON.stringify(JSON.stringify({ active: true }))})`,
  );
  await cdp.eval("window.__probe.seedDevice('probe-me')");
  await sleep(400);
  const align = await cdp.eval(`(() => {
    const av = document.querySelector('[data-profile-avatar]');
    const fields = document.querySelector('[data-profile-fields]');
    if (!av || !fields) return { ok: false };
    const a = av.getBoundingClientRect();
    const f = fields.getBoundingClientRect();
    const labels = [...document.querySelectorAll('button')].map((b) => String(b.innerText || '').trim());
    return {
      ok: true,
      avatar: { t: +a.top.toFixed(1), b: +a.bottom.toFixed(1), h: +a.height.toFixed(1) },
      fields: { t: +f.top.toFixed(1), b: +f.bottom.toFixed(1), h: +f.height.toFixed(1) },
      hasUpload: labels.includes('上传头像'),
      hasEmoji: labels.includes('自定义 emoji 头像'),
      vw: innerWidth,
      sw: document.documentElement.scrollWidth,
    };
  })()`);
  check("资料页：头像框与右侧字段上下对齐，两个入口按用户口径命名",
    mountedProfileDesktop && mountedProfileDesktop.ok === true && align.ok === true
      && Math.abs(align.avatar.t - align.fields.t) <= 2.5
      && Math.abs(align.avatar.b - align.fields.b) <= 2.5
      && align.avatar.h >= 62 && align.avatar.h <= 66
      && align.hasUpload === true && align.hasEmoji === true
      && align.sw <= align.vw + 1,
    "头像 top/bottom 与右侧字段差 <=2.5px、头像高 62~66、按钮文案=上传头像/自定义 emoji 头像、无横向溢出",
    JSON.stringify(align));
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-profile.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 资料页布局取证帧 → " + SHOT_PATH.replace(/\.png$/, "-profile.png"));
  }

  // ── 资料页入口 → 选择器 → 既有 updateProfile 的整条链（组件级，不是只看弹窗） ──
  // 重新导航一次：上一段留着开着的弹窗，别在同一个页面里叠第二个浮层。
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Page.reload");
  await sleep(2_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await sleep(600);
  await cdp.eval(PAGE_FIXTURE);
  const mountedProfile = await cdp.eval(
    `window.__probe.install('/src/components/settings/ProfileSection.vue', '', ${JSON.stringify(JSON.stringify({ active: true }))})`,
  );
  await cdp.eval("window.__probe.seedDevice('probe-me')");
  await sleep(400);
  // 记录 updateProfile 的真实入参；getFriends 给空数组，避免保存成功后的资料刷新抛错回滚。
  await cdp.eval(`(async () => {
    const m = await import('/src/api/index.ts');
    window.__profileCalls = [];
    m.api.updateProfile = async (nickname, avatar) => {
      window.__profileCalls.push({ nickname: nickname, avatar: avatar });
      return { device_id: 'probe-me', nickname: nickname, avatar: avatar, device_type: 'desktop', tcp_port: 12345, online: true };
    };
    m.api.getFriends = async () => [];
    return true;
  })()`);
  const entry = await cdp.eval("!!document.querySelector('[data-default-avatar-entry]')");
  await cdp.eval("document.querySelector('[data-default-avatar-entry]').click()");
  await sleep(400);
  const opened = await cdp.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return { ok: !!d, emojis: d ? d.querySelectorAll('[data-avatar-emoji]').length : 0 };
  })()`);
  check("默认头像：资料页的入口真的打开选择器（不是只摆了一个按钮）",
    mountedProfile && mountedProfile.ok === true && entry === true && opened.ok === true && opened.emojis > 0,
    "入口存在、点击后有 dialog 且表情网格已渲染",
    JSON.stringify({ mountedProfile, entry, opened }));

  const pick = await cdp.eval(
    `import('/src/utils/avatarSeed.ts').then((A) => ({ emoji: A.AVATAR_EMOJIS[2], bg: A.AVATAR_BACKGROUNDS[0] }))`,
  );
  await cdp.eval(
    `document.querySelector(${JSON.stringify(`[data-avatar-emoji="${pick.emoji}"]`)}).click()`,
  );
  await cdp.eval(
    `document.querySelector(${JSON.stringify(`[data-avatar-bg="${pick.bg}"]`)}).click()`,
  );
  await sleep(150);
  await cdp.eval("document.querySelector('[data-avatar-apply]').click()");
  await sleep(700);
  const saved = await cdp.eval(`(async () => {
    const A = await import('/src/utils/avatarSeed.ts');
    const calls = window.__profileCalls || [];
    const last = calls[calls.length - 1] || null;
    const img = document.querySelector('.gosslan-avatar-box img');
    return {
      calls: calls.length,
      nickname: last ? last.nickname : null,
      isSvg: !!last && String(last.avatar).startsWith('data:image/svg+xml;base64,'),
      pair: last ? A.parseAvatarPreset(last.avatar) : null,
      imgSrc: img ? String(img.getAttribute('src')).slice(0, 26) : null,
      dialogGone: !document.querySelector('[role="dialog"]'),
    };
  })()`);
  check("默认头像：确认后走的是既有 updateProfile，落库值就是选中的组合（SVG data URL）",
    saved.calls === 1 && saved.nickname === "探针我" && saved.isSvg === true
      && saved.pair && saved.pair.emoji === pick.emoji && saved.pair.bg === pick.bg
      && saved.imgSrc === "data:image/svg+xml;base64,"
      && saved.dialogGone === true,
    "updateProfile 1 次、入参可解析回选中组合、资料头像立即变成同一张、弹窗关闭",
    JSON.stringify({ want: pick, saved }));

  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
}


/**
 * 应用更新面板（--only=updater）：纯展示组件 + 四态夹具，不碰 Tauri。
 * 量的是“发现更新/下载中/下载完成/移动端不支持”在真浏览器里的可见性与用户确认门槛。
 */
async function runUpdater(cdp, url) {
  const base = {
    phase: "available",
    info: { currentVersion: "5.4.1", version: "5.5.0", notes: "修复若干问题", publishedAt: 1_700_000_000 },
    currentVersion: "5.4.1",
    downloaded: 0,
    total: null,
    error: null,
    checkedAt: null,
    dismissedVersion: null,
  };
  const mount = async (state, supported = true) => {
    const ok = await cdp.eval(
      `window.__probe.install('/src/components/settings/UpdatePanel.vue', '', ${
        JSON.stringify(JSON.stringify({ state, supported }))
      })`,
    );
    await sleep(350);
    return ok;
  };
  const text = () => cdp.eval("document.body.innerText");
  const hasDialog = () => cdp.eval("!!document.querySelector('[role=\"dialog\"]')");

  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  await mount(base);
  const t1 = await text();
  check("应用更新：发现更新时显示版本/说明/下载与稍后，且没有启动弹窗",
    t1.includes("5.5.0") && t1.includes("下载更新") && t1.includes("稍后") && (await hasDialog()) === false,
    "含 5.5.0/下载更新/稍后；无 role=dialog",
    JSON.stringify({ head: String(t1).slice(0, 180), dialog: await hasDialog() }));

  await mount({ ...base, phase: "downloading", downloaded: 40, total: 100 });
  const t2 = await text();
  const bar = await cdp.eval(`(() => {
    const el = document.querySelector('[role="progressbar"]');
    return el ? { now: el.getAttribute('aria-valuenow'), max: el.getAttribute('aria-valuemax') } : null;
  })()`);
  check("应用更新：下载中显示真实进度条与取消入口",
    t2.includes("取消下载") && bar && bar.now === "40" && bar.max === "100",
    "含取消下载，progressbar 40/100",
    JSON.stringify({ bar, hasCancel: t2.includes("取消下载") }));

  await mount({ ...base, phase: "ready" });
  await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').includes('安装并重启'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(200);
  const t3 = await text();
  check("应用更新：安装必须先出现二次确认（不点确认不安装）",
    t3.includes("安装会退出应用并重启") && t3.includes("确认安装"),
    "出现确认文案与确认键",
    JSON.stringify({ head: String(t3).slice(0, 200) }));

  await mount({ ...base, info: null, phase: "idle" }, false);
  const t4 = await text();
  const checkBtn = await cdp.eval(`(() => [...document.querySelectorAll('button')]
    .some((b) => (b.innerText || '').trim() === '检查更新'))()`);
  check("应用更新：移动端不支持时只给手动渠道说明，不给检查按钮",
    t4.includes("移动端不支持应用内更新") && checkBtn === false,
    "含移动端说明且没有文案为「检查更新」的按钮",
    JSON.stringify({ head: String(t4).slice(0, 180), checkBtn }));

  const geom = await cdp.eval(`(() => ({
    vw: innerWidth,
    sw: document.documentElement.scrollWidth,
    host: (() => { const h = document.getElementById('probe-host'); return h ? Math.round(h.getBoundingClientRect().width) : 0; })(),
  }))()`);
  check("应用更新：390 宽下不横向溢出",
    geom.sw <= geom.vw + 1,
    "scrollWidth<=vw",
    JSON.stringify(geom));
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
}

async function runFavorites(cdp, url) {
  const now = Date.now();
  const favs = [
    { id: "f1", msg_id: "m1", conv_id: "conv-1", sender_id: "peer-1", kind: "text",
      content: "收藏的文本：这是一条用来核对收藏列表与详情排版的消息。", ts: now - 90_000, favorited_at: now - 60_000,
      media_path: null, media_size: 0, available: true },
    { id: "f2", msg_id: "m2", conv_id: "conv-1", sender_id: "peer-1", kind: "file",
      // 刻意超长（仍保留可搜索的“季度报告.pdf”前缀）：移动端必须省略而不是把「⋯」挤出屏幕。
      content: JSON.stringify({ name: "季度报告.pdf" + "超长文件名".repeat(20), path: "/tmp/季度报告.pdf", size: 20480, subtype: "file" }),
      ts: now - 120_000, favorited_at: now - 120_000,
      media_path: "/tmp/季度报告.pdf", media_size: 20480, available: true },
    { id: "f3", msg_id: "m3", conv_id: "conv-1", sender_id: "self", kind: "code",
      content: "const answer = 42;", ts: now - 180_000, favorited_at: now - 180_000,
      media_path: null, media_size: 0, available: true },
  ];
  const mount = async (width, height) => {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    // 同一次进程里先桌后窄：导航会把 device metrics 复位，必须在页面起来后再钉一次，
    // 让 store 的 resize 监听把 isMobile 真正翻到窄档。
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: width < 768 ? 2 : 1, mobile: width < 768,
    });
    if (width < 768) {
      // 同一 target 从宽档再导航到窄档时，导航会把 metrics 复位成窗口默认宽；
      // reload 后 store 会按默认宽初始化，再钉一次让 resize 监听把它翻到窄档。
      await cdp.send("Page.reload");
      await sleep(2_000);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 2, mobile: true,
      });
      await sleep(600);
    }
    await sleep(500);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval(`window.__probe.stubApi('listFavorites', ${JSON.stringify(favs)})`);
    const mounted = await cdp.eval("window.__probe.install('/src/components/FavoritePanel.vue', '', '')");
    await cdp.eval(`(() => {
      const h = document.getElementById('probe-host');
      h.style.width = '${width}px';
      h.style.maxWidth = '${width}px';
      h.style.minWidth = '0';
      h.style.height = '${height}px';
      h.style.display = 'block';
      h.style.overflow = 'hidden';
      return true;
    })()`);
    await sleep(400);
    return mounted;
  };
  const info = () => cdp.eval(`(() => {
    const txt = document.body.innerText;
    const rowTexts = [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim())
      .filter((x) => x.includes('收藏的文本') || x.includes('季度报告.pdf') || x.includes('const answer'));
    const actions = [...document.querySelectorAll('button')]
      .map((b) => (b.innerText || '').trim())
      .filter((x) => ['复制', '转发', '跳回原消息', '删除收藏', '查看图片', '另存为', '打开'].includes(x));
    const detail = [...document.querySelectorAll('div')].find((d) => {
      const st = getComputedStyle(d);
      return st.position === 'fixed' && (d.innerText || '').includes('收藏的文本');
    });
    return {
      txt, rows: rowTexts.length, rowTexts, actions,
      vw: innerWidth,
      hostW: (() => { const h = document.getElementById('probe-host'); return h ? Math.round(h.getBoundingClientRect().width) : 0; })(),
      headerText: (document.querySelector('header') || {}).innerText || '',
      search: !!document.querySelector('input[placeholder*="搜索收藏"]'),
      // 绑到常量上的 maxlength 必须真的产出属性与 DOM 值 —— 绑错名字时 Vue 只会安静地不写属性，
      // 界面看不出区别，但上限已经消失（用户能把整段日志粘进搜索框）。
      searchMaxlen: (() => {
        const i = document.querySelector('input[placeholder*="搜索收藏"]');
        return i ? { attr: i.getAttribute('maxlength'), dom: i.maxLength } : null;
      })(),
      chips: [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.innerText.trim()),
      chipsPressed: [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.innerText.trim()),
      picked: txt.includes('从左侧选一条收藏查看详情'),
      noMatch: txt.includes('没有匹配的收藏'),
      detailFixed: detail ? { fixed: true, width: Math.round(detail.getBoundingClientRect().width) } : null,
      back: !!document.querySelector('button[aria-label="返回"]'),
    };
  })()`);
  const rectOf = (needle, sel) => cdp.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel || "button")})]
      .find((b) => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).includes(${JSON.stringify(needle)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const clickText = async (needle, sel) => {
    const pt = await rectOf(needle, sel);
    if (!pt) return false;
    await cdp.click(pt.x, pt.y);
    await sleep(300);
    return true;
  };

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  try {
    const mounted = await mount(1200, 820);
    let s = await info();
    check("收藏面板：真实 store 拉取并渲染三条，搜索 / 五个筛选 / 空详情提示齐全",
      mounted && mounted.ok === true && s.rows === 3
        && s.search && s.chips.length === 5 && s.picked,
      "3 行 / 5 chips / 空详情提示",
      JSON.stringify({ rows: s.rows, chips: s.chips, search: s.search, picked: s.picked }));

    check("收藏搜索框的 maxlength 由常量绑定产出真数（绑错名字时 Vue 只安静地不写属性）",
      s.searchMaxlen && s.searchMaxlen.attr === "50" && s.searchMaxlen.dom === 50,
      'attr="50" 且 input.maxLength === 50',
      JSON.stringify(s.searchMaxlen));

    const searchPt = await cdp.eval(`(() => {
      const i = document.querySelector('input[placeholder*="搜索收藏"]');
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (searchPt) await cdp.click(searchPt.x, searchPt.y);
    await cdp.send("Input.insertText", { text: "季度" });
    await sleep(300);
    s = await info();
    check("搜索『季度』只剩文件行（标题与正文都参与匹配）",
      s.rows === 1 && s.rowTexts.join("|").includes("季度报告.pdf"),
      "1 行且是季度报告.pdf", JSON.stringify(s.rowTexts));

    await clickText("图片");
    s = await info();
    check("筛选『图片』在没有图片收藏时给出空结果提示（不是一片空白）",
      s.rows === 0 && s.noMatch && s.chipsPressed.includes("图片"),
      "0 行 + 没有匹配的收藏 + 图片激活",
      JSON.stringify({ rows: s.rows, noMatch: s.noMatch, pressed: s.chipsPressed }));

    await cdp.eval(`(() => {
      const i = document.querySelector('input[placeholder*="搜索收藏"]');
      if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
      return true;
    })()`);
    for (let i = 0; i < 2; i += 1) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      });
    }
    await sleep(200);
    await clickText("全部");
    s = await info();
    check("清空搜索 + 回到『全部』：三条恢复（筛选是真状态，不是一次性渲染）",
      s.rows === 3 && s.chipsPressed.includes("全部") && !s.noMatch,
      "3 行 + 全部激活", JSON.stringify({ rows: s.rows, pressed: s.chipsPressed }));

    const clicked = await clickText("收藏的文本");
    s = await info();
    check("点文本收藏：右栏显示全文与底部操作条，空详情提示消失",
      clicked && s.txt.includes("这是一条用来核对收藏列表与详情排版的消息")
        && ["复制", "转发", "跳回原消息", "删除收藏"].every((x) => s.actions.includes(x)) && !s.picked,
      "全文 + 复制/转发/跳回/删除 + 空提示消失",
      JSON.stringify({ actions: s.actions, picked: s.picked }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-favorites.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 收藏面板取证帧 → " + SHOT_PATH.replace(/\.png$/, "-favorites.png"));
    }

    // ── 移动端两级（列表 ↔ 详情覆盖层）：视口必须在 store 创建**之前**变窄 ──
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    const mMounted = await mount(390, 844);
    s = await info();
    check("移动端收藏：列表一列渲染（桌面空详情提示不出现），列表态没有返回键",
      mMounted && mMounted.ok === true && s.rows === 3 && s.hostW <= 390 && !s.picked && !s.back,
      "3 行 / 390 宿主宽 / 无桌面空详情提示 / 列表态无返回键",
      JSON.stringify({ rows: s.rows, hostW: s.hostW, picked: s.picked, back: s.back }));

    const longName = await cdp.eval(`(() => {
      const title = [...document.querySelectorAll('span')].find((s) =>
        (s.textContent || '').includes('季度报告.pdf')
        && getComputedStyle(s).textOverflow === 'ellipsis');
      if (!title) return { ok: false };
      const row = title.closest('div.relative');
      const more = row ? row.querySelector('button[aria-label="更多操作"]') : null;
      const r = more ? more.getBoundingClientRect() : null;
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        ok: true,
        truncated: title.scrollWidth > title.clientWidth,
        more: !!more,
        right: r ? +r.right.toFixed(1) : null,
        hostRight: (() => { const h = document.getElementById('probe-host'); return h ? h.getBoundingClientRect().right : null; })(),
        hitMore: !!(hit && more && hit.closest('button') === more),
      };
    })()`);
    check("移动端收藏：超长文件名省略而不是撑破行，右侧「⋯」仍在视口内且可命中",
      longName.ok === true && longName.truncated === true && longName.more === true
        && longName.right !== null && longName.hostRight !== null
        && longName.right <= longName.hostRight + 1 && longName.hitMore === true,
      "ellipsis + 真正截断 + ⋯ 在面板内且命中", JSON.stringify(longName));

    await clickText("收藏的文本");
    s = await info();
    check("移动端点收藏：全屏 fixed 覆盖层（宽度=视口）、标题取正文而不是一律「文件」、带返回键",
      s.detailFixed && s.detailFixed.fixed && Math.abs(s.detailFixed.width - s.vw) <= 2 && s.back
        && s.headerText.includes("收藏的文本") && !s.headerText.includes("文件"),
      "fixed / width=vw / 标题含正文 / 返回键在",
      JSON.stringify({ detail: s.detailFixed, vw: s.vw, back: s.back, header: s.headerText }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-favorites-mobile.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 收藏移动端取证帧 → " + SHOT_PATH.replace(/\.png$/, "-favorites-mobile.png"));
    }

    await clickText("返回");
    s = await info();
    check("移动端返回：覆盖层收起回到列表，三条都还在",
      !s.detailFixed && s.rows === 3,
      "覆盖层消失 + 3 行", JSON.stringify({ detail: s.detailFixed, rows: s.rows }));
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 网络诊断面板（--only=diag）：§6.90 那格"只能由用户复看"的三态，在真浏览器里量一次。
 *
 * ① 命令在飞 ⇒ 屏幕上是「加载中...」（不是空白、也不是先报错）；
 * ② 读数到达 ⇒ 模式 / 绑定 IP / TCP 监听 / 版本行都在屏上；
 * ③ 刷新失败 ⇒ 旧读数仍在、整屏**没有**被「诊断数据读取失败」替换（`error && !diag` 那道闸）；
 * ④ 反控 ⇒ 没有旧快照时同一套失败**必须**把「诊断数据读取失败」说出来，
 *    否则③只是"永远不会报错"的别名。
 */
async function runDiag(cdp, url) {
  // 与本文件其它段同一口径：先把页面拉到前台，避免被遮挡时过渡停在中途。
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const DIAG = {
    mode: "lan",
    bound_ip: "192.168.1.9",
    selected_interface: "en0",
    selected_ip: "192.168.1.9",
    tcp_listen: "0.0.0.0:60012",
    udp_port: 60013,
    broadcast_target: "255.255.255.255:60013",
    multicast_group: "239.255.66.12:60013",
    multicast_join_result: "ok",
    multicast_if_result: "ok",
    last_broadcast_send: 0,
    last_multicast_send: 0,
    last_announce_recv: 0,
    candidates: [],
    bluetooth: {
      feature_compiled: false, enabled: false, available: false, running: false, peers: 0,
      activity: "idle", scan_window_ms: 0, scan_interval_ms: 0, last_scan_ts: 0,
      last_scan_total: 0, last_scan_matched: 0, backoff: [], no_dial: 0,
    },
    protocol_version: 1,
    // 探针自己造的一串，**故意不写真实版本号**：免得产品一升版本这条判据就漂。
    app_version: "probe-9.9",
    peer_versions: [],
    conn_health: [],
  };
  const boot = async () => {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval("window.__probe.diagDeferred()");
  };
  const mount = () => cdp.eval(`window.__probe.install('/src/components/DevDiagPanel.vue', '', '{"open":true}')`);
  const txt = () => cdp.eval("document.body.innerText");
  const stats = () => cdp.eval("window.__probe.diagStats()");
  // 点刷新按钮用 DOM click（这一格量的是三态切换，不是命中区；命中区由 overlay/links 两段负责）。
  const clickRefresh = () => cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => String(x.innerText || '').includes('刷新'));
    if (!b) return false;
    b.click();
    return true;
  })()`);

  await boot();
  const m1 = await mount();
  await sleep(350);
  const t1 = await txt();
  const s1 = await stats();
  check("诊断面板：命令在飞时屏幕上是「加载中...」（不是空白、也不是先报错）",
    m1 && m1.ok === true && s1.calls === 1 && t1.includes("加载中") && !t1.includes("诊断数据读取失败"),
    "calls=1 且含「加载中」且无错误块",
    JSON.stringify({ calls: s1 && s1.calls, head: String(t1).slice(0, 120) }));

  await cdp.eval(`window.__probe.diagResolve(${JSON.stringify(DIAG)})`);
  await sleep(450);
  const t2 = await txt();
  check("诊断面板：读数到达后三块事实都在屏上（模式 / 绑定 IP / TCP 监听 / 本机版本行），加载态退场",
    t2.includes("局域网") && t2.includes("192.168.1.9") && t2.includes("60012")
      && t2.includes("probe-9.9") && !t2.includes("加载中"),
    "含 局域网/192.168.1.9/60012/probe-9.9 且无「加载中」",
    JSON.stringify({ head: String(t2).slice(0, 200) }));

  await cdp.eval("window.__probe.diagFailWith('ipc down')");
  const clicked = await clickRefresh();
  await sleep(800);
  const t3 = await txt();
  const s3 = await stats();
  check("诊断面板·刷新失败但保留旧数据：旧读数仍在、整屏没有被错误页换掉（`error && !diag` 那道闸）",
    clicked === true && s3.calls >= s1.calls + 2
      && t3.includes("192.168.1.9") && !t3.includes("诊断数据读取失败"),
    "calls 至少 +2（retry 1）、旧读数仍在、无「诊断数据读取失败」",
    JSON.stringify({ before: s1 && s1.calls, after: s3 && s3.calls, head: String(t3).slice(0, 160) }));

  // 反控：干净的 Query 缓存 + 一开始就失败的命令 ⇒ 必须把「诊断数据读取失败」说出来
  await boot();
  await cdp.eval("window.__probe.diagFailWith('ipc down')");
  await mount();
  await sleep(900);
  const t4 = await txt();
  check("反控：没有旧快照时同一套失败必须说「诊断数据读取失败」（否则上一条只是永不报错）",
    t4.includes("诊断数据读取失败") && !t4.includes("192.168.1.9"),
    "含「诊断数据读取失败」且无旧读数",
    JSON.stringify({ head: String(t4).slice(0, 160) }));
}

/**
 * 外部链接左栏（--only=links）：真实组件 + 一份读写命令都在的内存表。
 * 重点照入口的可见文案、新增/编辑与导入的**弹窗职责分离**、表单回车提交、编辑预填、
 * 行点击真的把链接交给父级，以及**写路径**（§6.98：增/改/删共用一枚 mutation，
 * 成功时把返回的整份数组写回读缓存）。
 */
async function runLinks(cdp, url) {
  const links = [
    { id: "l1", name: "公司内网", url: "https://intra.example.com" },
    { id: "l2", name: "产品文档", url: "https://docs.example.com" },
  ];
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval(`window.__probe.linksStore(${JSON.stringify(links)})`);
    const mounted = await cdp.eval("window.__probe.install('/src/components/LinksList.vue', '', '')");
    await cdp.eval(`(() => {
      const h = document.getElementById('probe-host');
      h.style.width = '360px';
      h.style.height = '640px';
      h.style.display = 'block';
      return true;
    })()`);
    await sleep(400);

    const info = () => cdp.eval(`(() => {
      const txt = document.body.innerText;
      const inputs = [...document.querySelectorAll('input')].map((i) => ({
        ph: i.placeholder, value: i.value,
      }));
      const btn = (label) => [...document.querySelectorAll('button')]
        .find((b) => ((b.innerText || '').trim() === label));
      const addBtn = btn('添加');
      const importBtn = btn('导入');
      const backupBtn = btn('备份');
      return {
        txt, inputs,
        add: !!addBtn,
        importBtn: !!importBtn,
        backup: !!backupBtn,
        backupTitle: backupBtn ? backupBtn.getAttribute('title') : null,
        filePick: !!btn('选择 JSON 文件…'),
        urlAction: !!btn('读取并导入'),
        edits: [...document.querySelectorAll('button[aria-label="编辑链接"]')].length,
        removes: [...document.querySelectorAll('button[aria-label="删除链接"]')].length,
        rowTitles: [...document.querySelectorAll('button[title]')]
          .map((b) => b.getAttribute('title'))
          .filter((t) => t === 'https://intra.example.com' || t === 'https://docs.example.com'),
        rows: [...document.querySelectorAll('button[title]')]
          .map((b) => b.getAttribute('title'))
          .filter((t) => t && t.startsWith('https://')),
        events: window.__probe.events.slice(),
      };
    })()`);
    const rectOf = (needle) => cdp.eval(`(() => {
      const el = [...document.querySelectorAll('button')]
        .find((b) => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).includes(${JSON.stringify(needle)}));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    /**
     * 等那层弹窗遮罩真的从 DOM 里撤掉。
     * Reka 的 Presence 要等 **animationend** 才撤 DOM（`data-state="closed"` 那几条是
     * `gosslan-dialog-fade-out 150ms`），而 headless 的合成器可以**不回这个事件**
     * （2026-10-23 实测：单独跑这一段遮罩 300ms 内就没了；接在 --only=toast 后面跑，
     * 同一层遮罩 1.3s 后还停在 opacity 0.032 且永远不撤）。那层看不见的遮罩带命中，
     * 会把后面每一次鼠标事件全吃掉，读数就长成"弹窗根本没打开"。
     * 所以：先等，等过 600ms 还没撤就替它把动画放完（补发 animationend —— 只推时钟，
     * 不改产品状态），再等；到预算仍不撤就带着读数继续，让那一格自己说看到了什么。
     */
    /**
     * 等弹窗那层遮罩真的从 DOM 里撤掉再点下一处。
     * Reka 的 Presence 要等 **animationend** 才撤 DOM（`data-state="closed"` 那几条是 150ms 淡出），
     * 而 headless 的合成器在长跑里可以不回这个事件 —— 那层透明的遮罩会一直吃掉鼠标事件，
     * 读数就长成"弹窗根本没打开"。所以每次点之前等状态，不靠固定毫秒。
     * ⚠️ 这里**不替产品**把遮罩的命中关掉：真留下撤不掉的遮罩是要红的那一类缺陷。
     */
    const overlayCount = () => cdp.eval("document.querySelectorAll('.gosslan-dialog-overlay').length");
    const waitDialogGone = async () => {
      const t0 = Date.now();
      for (;;) {
        const n = await overlayCount();
        if (!n || Date.now() - t0 > 3_000) return n;
        await sleep(120);
      }
    };
    const clickText = async (needle) => {
      await waitDialogGone();
      const pt = await rectOf(needle);
      if (!pt) return false;
      await cdp.click(pt.x, pt.y);
      await sleep(300);
      return true;
    };

    let s = await info();
    check("链接左栏：标题 / 两条链接 / 常显编辑与删除 / 添加·导入·备份入口齐全且都有可见文案",
      mounted && mounted.ok === true && s.txt.includes("外部链接") && s.rowTitles.length === 2
        && s.edits === 2 && s.removes === 2 && s.add && s.importBtn && s.backup
        && s.backupTitle === "导出链接备份（JSON）",
      "2 行 + 2 编辑 + 2 删除 + 「添加 / 导入 / 备份」三个入口同一行同样式、文案可见 + 备份 title 说明 JSON",
      JSON.stringify({ rows: s.rowTitles, edits: s.edits, removes: s.removes, add: s.add,
        importBtn: s.importBtn, backup: s.backup, backupTitle: s.backupTitle }));

    const importOpened = await clickText("导入");
    s = await info();
    check("导入：入口打开独立弹窗，文件与网址两种来源都在这一处，且不出现新增/编辑字段",
      importOpened === true && s.txt.includes("导入链接") && s.txt.includes("从文件导入")
        && s.txt.includes("从网址导入") && s.filePick && s.urlAction
        && s.inputs.some((i) => i.ph === "https://example.com/links.json")
        && !s.inputs.some((i) => i.ph === "显示名称"),
      "导入弹窗含「从文件导入 / 从网址导入」，无「显示名称」",
      JSON.stringify({ inputs: s.inputs, filePick: s.filePick, urlAction: s.urlAction }));
    await clickText("取消");
    s = await info();
    check("导入取消：弹窗收起，列表不受影响",
      !s.txt.includes("导入链接") && !s.inputs.some((i) => i.ph === "https://example.com/links.json")
        && s.rowTitles.length === 2,
      "导入弹窗消失 + 2 行", JSON.stringify({ inputs: s.inputs, rows: s.rowTitles }));

    const opened = await clickText("https://intra.example.com");
    s = await info();
    check("点链接行：把该条交给父级开独立窗口（open 事件真的发出）",
      opened && s.events.some((e) => e[0] === "open-id"), "事件表出现 open-id",
      JSON.stringify(s.events));

    await clickText("添加");
    s = await info();
    check("点添加：弹窗只有名称/网址两个空输入，不再混入 JSON 导入",
      s.inputs.length === 2 && s.inputs.some((i) => i.ph === "显示名称" && i.value === "")
        && s.inputs.some((i) => i.ph === "https://example.com" && i.value === "")
        && !s.txt.includes("从文件导入") && !s.txt.includes("从网址导入"),
      "两个空输入，且无导入入口", JSON.stringify(s.inputs));
    // 新增/编辑现在是同一个 BaseModal：先关掉新增弹窗，才能点到列表行上的编辑。
    await clickText("取消");

    await clickText("编辑链接");
    s = await info();
    check("点编辑：同一份表单预填该条名称与网址（不是空表单）",
      s.inputs.some((i) => i.value === "公司内网") && s.inputs.some((i) => i.value === "https://intra.example.com"),
      "公司内网 / https://intra.example.com", JSON.stringify(s.inputs));

    // 读数件在这一格是**与输入框同排**的（360 宽的主栏是最挤的那一档）。
    // 静态判据只管"绑了同一个常量"，管不了把输入框挤到没法用 ⇒ 这一格只能在真浏览器里量。
    const cap = await cdp.eval(`(() => {
      const name = document.querySelector('input[maxlength]');
      if (!name) return { found: false };
      const row = name.parentElement;
      const span = row ? row.querySelector('span.tabular-nums') : null;
      // 表单已搬进 BaseModal（Portal 到 body），量的是弹窗卡片右沿，不是原列表宿主。
      const card = name.closest('.elevated') || name.closest('[role="dialog"]');
      const ni = name.getBoundingClientRect();
      const cr = card ? card.getBoundingClientRect() : null;
      const r = span ? span.getBoundingClientRect() : null;
      return {
        found: true,
        cardFound: !!card,
        text: span ? span.textContent.trim() : null,
        spanLeft: r ? Math.round(r.left) : null,
        spanRight: r ? Math.round(r.right) : null,
        inputRight: Math.round(ni.right),
        inputWidth: Math.round(ni.width),
        cardRight: cr ? Math.round(cr.right) : null,
        attr: name.getAttribute('maxlength'),
      };
    })()`);
    check("链接名读数在弹窗里与输入框同排共存：两者都可见、互不重叠、不越出卡片",
      cap.found && cap.cardFound && cap.attr === "32" && /^\d+\/32$/.test(String(cap.text || ""))
        && cap.inputWidth >= 120 && cap.spanLeft >= cap.inputRight - 1
        && cap.spanRight <= cap.cardRight + 1,
      "输入框宽度 >=120、读数右沿 <= 卡片右沿、且读数在输入框右侧",
      JSON.stringify(cap));

    await clickText("取消");
    s = await info();
    check("取消：表单收起，两行链接不受影响",
      s.inputs.length === 0 && s.rowTitles.length === 2,
      "0 输入 + 2 行", JSON.stringify({ inputs: s.inputs.length, rows: s.rowTitles.length }));

    // ---- 写路径（§6.98）：三条命令共用一个 mutation，成功时把后端返回的整份数组写回读缓存 ----
    // 判据要的三件事：① 真的发的是对应那条命令；② 列表**立刻**变成返回值的形状（不是等下次重开）；
    // ③ list 的调用次数全程不变（`setQueryData` 写回，不是 `invalidateQueries` 再拉一次）。
    /** 填某个 placeholder 的输入框（等它真出现，最多 2s —— 弹窗刚开那一下在长跑里会慢）。 */
    const fill = async (ph, value) => {
      const t0 = Date.now();
      for (;;) {
        const ok = await cdp.eval(`(() => {
          const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(ph)});
          if (!i) return false;
          i.value = ${JSON.stringify(value)};
          i.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        if (ok || Date.now() - t0 > 2_000) return ok;
        await sleep(120);
      }
    };
    /**
     * 在指定 placeholder 的输入框上按一次**真**回车：聚焦后走 CDP 的 `Input.dispatchKeyEvent`，
     * 与用户按键同一条管线（不用 `new KeyboardEvent` 伪造）。聚焦不上就返回 false（同样等 2s）。
     */
    const pressEnter = async (ph) => {
      const t0 = Date.now();
      let focused = false;
      for (;;) {
        focused = await cdp.eval(`(() => {
          const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(ph)});
          if (!i) return false;
          i.focus();
          return document.activeElement === i;
        })()`);
        if (focused || Date.now() - t0 > 2_000) break;
        await sleep(120);
      }
      if (!focused) return false;
      await cdp.key("Enter", "Enter", "\r", 13);
      return true;
    };
    /** 按行定位那颗按钮（同一页里每行都有一枚「编辑/删除」，不能按文字取第一枚）。 */
    const clickRowBtn = async (rowUrl, aria) => {
      await waitDialogGone();
      const pt = await cdp.eval(`(() => {
        const link = [...document.querySelectorAll('button[title]')]
          .find((b) => b.getAttribute('title') === ${JSON.stringify(rowUrl)});
        if (!link) return null;
        const row = link.parentElement;
        const btn = row ? [...row.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === ${JSON.stringify(aria)}) : null;
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!pt) return false;
      await cdp.click(pt.x, pt.y);
      await sleep(300);
      return true;
    };

    const stats0 = await cdp.eval("window.__probe.linksStats()");
    // 这一格按「保存」按钮走；**真按键**那两格排在段尾（见文件末尾那两格）。
    // 为什么排序要紧：这台引擎的 CSS 动画时钟在长跑里会停摆，Reka 的离场要等 animationend
    // ⇒ 遮罩撤不掉、后面的点击全被吃掉。实测同一段单独跑 13/13，接在 --only=toast 之后
    // 就会红 —— 那是量具的时序，不是产品行为。把真按键那两格放到最后，红也只红它们自己。
    await clickText("添加");
    await fill("显示名称", "周报");
    await fill("https://example.com", "https://weekly.example.com");
    await clickText("保存");
    await sleep(300);
    s = await info();
    const st1 = await cdp.eval("window.__probe.linksStats()");
    const last1 = await cdp.eval("window.__probe.linksLast()");
    check("新增：保存把 add 发出去，返回的整份数组立刻回填列表（3 行），且没有再拉一次 list",
      st1.add === 1 && st1.list === stats0.list && last1 && last1.kind === "add"
        && s.rows.length === 3 && s.txt.includes("周报") && s.inputs.length === 0,
      "add=1、list 不变、3 行含「周报」、草稿收起",
      JSON.stringify({ st1, last1, rows: s.rows, inputs: s.inputs.length }));

    const edited = await clickRowBtn("https://weekly.example.com", "编辑链接");
    const filled = await fill("显示名称", "周报（改）");
    await clickText("保存");
    await sleep(300);
    s = await info();
    const st2 = await cdp.eval("window.__probe.linksStats()");
    const last2 = await cdp.eval("window.__probe.linksLast()");
    check("修改：编辑该行的保存发 update(id)，列表就地换成新名字（仍是 3 行）",
      edited && filled && st2.update === 1 && st2.add === 1 && st2.list === stats0.list
        && last2 && last2.kind === "update" && last2.id === "n1"
        && s.rows.length === 3 && s.txt.includes("周报（改）"),
      "update=1、id=n1、3 行、显示新名",
      JSON.stringify({ st2, last2, rows: s.rows }));

    const removed = await clickRowBtn("https://weekly.example.com", "删除链接");
    await sleep(300);
    s = await info();
    const st3 = await cdp.eval("window.__probe.linksStats()");
    check("删除：该行的删除发 remove(id)，行从列表消失、回到 2 行，list 全程只发过 1 次",
      removed && st3.remove === 1 && st3.list === stats0.list
        && s.rows.length === 2 && !s.txt.includes("周报（改）"),
      "remove=1、2 行、不再有该条",
      JSON.stringify({ st3, rows: s.rows }));

    // ---- 写失败：真实 Toast（§6.99）----
    // 三件事一起断：① 写命令真的发出且真的失败；② 屏幕上出现 **error toast**、文案是
    // `links.addFail` 拼出来的那句；③ 草稿还开着、列表没变（失败不许显示成成功态）。
    const hud = await cdp.eval("window.__probe.mountToastHud()");
    await cdp.eval("window.__probe.linksFailNext('add')");
    await clickText("添加");
    await fill("显示名称", "会失败");
    await fill("https://example.com", "https://boom.example.com");
    await clickText("保存");
    await sleep(500);
    s = await info();
    const st4 = await cdp.eval("window.__probe.linksStats()");
    const toast = await cdp.eval("window.__probe.toastRead()");
    check("写失败：onError 真的把 error toast 送进 HUD（不是静默失败），且列表与草稿都没被当成成功",
      hud && hud.ok === true && st4.add === 2 && st4.list === stats0.list
        && toast.visible >= 1 && toast.statuses.includes("error")
        && toast.texts.some((x) => x.includes("添加链接失败"))
        && s.rows.length === 2 && !s.rows.includes("https://boom.example.com")
        && s.inputs.some((i) => i.value === "会失败"),
      "add=2、1 条 error toast 含「添加链接失败」、2 行、草稿仍开着",
      JSON.stringify({ hud, toast, st4, rows: s.rows, inputs: s.inputs }));
    await clickText("取消");

    // ==== 段尾两格：真按键（CDP Input.dispatchKeyEvent）提交 ====
    // 用户 2026-10-23 那句"不用每次自己手点"要的就是这两格：静态判据只能证明模板里写了
    // ime.enter(fn, $event)，证不了按下回车真的把动作发出去（2026-10-23 之前那 16 处
    // 全都写成 ime.enter(fn)，静态看着对、运行时一次都没执行）。
    // ① 新增：网址框按回车 = 保存（此时列表 2 行：删掉周报之后）
    await clickText("添加");
    await fill("显示名称", "周报二");
    await fill("https://example.com", "https://weekly2.example.com");
    const addEnter = await pressEnter("https://example.com");
    await sleep(400);
    s = await info();
    const st5 = await cdp.eval("window.__probe.linksStats()");
    const last5 = await cdp.eval("window.__probe.linksLast()");
    check("新增：在网址框按回车就保存（add=3）、列表立刻回填 3 行含「周报二」、弹窗自己收起",
      addEnter === true && st5.add === 3 && st5.list === stats0.list
        && last5 && last5.kind === "add" && last5.name === "周报二"
        && s.rows.length === 3 && s.txt.includes("周报二") && s.inputs.length === 0,
      "回车提交：add=3、list 不变、3 行含「周报二」、弹窗收起",
      JSON.stringify({ addEnter, st5, last5, rows: s.rows, inputs: s.inputs.length }));

    // ② 线上导入：网址框按回车 = 拉取并导入
    const importAgain = await clickText("导入");
    await fill("https://example.com/links.json", "https://backup.example.com/links.json");
    const importEnter = await pressEnter("https://example.com/links.json");
    await sleep(500);
    s = await info();
    const st6 = await cdp.eval("window.__probe.linksStats()");
    const last6 = await cdp.eval("window.__probe.linksLast()");
    check("线上导入：在网址框按回车就导入（importUrl=1），返回的整份数组立刻回填、弹窗收起",
      importAgain && importEnter && st6.importUrl === 1 && st6.list === stats0.list
        && last6 && last6.kind === "importUrl" && last6.url === "https://backup.example.com/links.json"
        && s.rows.length === 4 && s.txt.includes("导入的链接")
        && !s.inputs.some((i) => i.ph === "https://example.com/links.json"),
      "回车提交：importUrl=1、list 不变、4 行含「导入的链接」、弹窗收起",
      JSON.stringify({ st6, last6, rows: s.rows, inputs: s.inputs }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-links.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 链接左栏取证帧 → " + SHOT_PATH.replace(/\.png$/, "-links.png"));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 设置页字体下拉（--only=fontsel）：Reka Select 不渲染空串 option。
 * 判据是"默认档到底存不存在"：触发器文案、菜单四项、选中第二档后的落库值、再切回默认。
 */
async function runFontSelect(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.stubApi('saveSettings', null)");
  const mounted = await cdp.eval("window.__probe.install('/src/components/settings/AppearanceSection.vue', '', "
    + JSON.stringify(JSON.stringify({ isolated: true })) + ")");
  await cdp.eval(`(() => {
    const h = document.getElementById('probe-host');
    h.style.width = '760px';
    h.style.display = 'block';
    return true;
  })()`);
  await sleep(400);

  const info = () => cdp.eval(`(() => {
    const trigger = document.querySelector('button[aria-label="界面字体"]');
    return {
      trigger: trigger ? (trigger.innerText || '').trim() : null,
      items: [...document.querySelectorAll('.gosslan-menu-item')].map((b) => (b.innerText || '').trim()),
      stored: localStorage.getItem('gosslan.fontFamily'),
    };
  })()`);
  const openMenu = async () => {
    const pt = await cdp.eval(`(() => {
      const b = document.querySelector('button[aria-label="界面字体"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!pt) return false;
    await cdp.click(pt.x, pt.y);
    await sleep(300);
    return true;
  };

  let s = await info();
  check("字体下拉默认档：触发器显示「系统默认」（不是空白）",
    mounted && mounted.ok === true && s.trigger === "系统默认",
    "触发器=系统默认", JSON.stringify({ trigger: s.trigger }));

  await openMenu();
  s = await info();
  check("菜单包含四个字体档，且「系统默认」没有被 Reka 的空串值吞掉",
    s.items.length === 4 && s.items.includes("系统默认") && s.items.includes("思源黑体"),
    "4 项且含系统默认", JSON.stringify(s.items));
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-font.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 字体下拉取证帧 → " + SHOT_PATH.replace(/\.png$/, "-font.png"));
  }

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(300);
  s = await info();
  check("↓+Enter 选中第二档：触发器显示苹方 / 微软雅黑，落库值是字体栈（不是哨兵）",
    s.trigger === "苹方 / 微软雅黑" && String(s.stored || "").includes("PingFang SC"),
    "触发器=苹方 / 微软雅黑 + 落库字体栈",
    JSON.stringify({ trigger: s.trigger, stored: s.stored }));

  await openMenu();
  await cdp.key("ArrowUp", "ArrowUp", "", 38);
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(300);
  s = await info();
  check("再切回系统默认：触发器恢复、落库值为空串（哨兵没有泄漏到设置里）",
    s.trigger === "系统默认" && s.stored === "",
    "触发器=系统默认 + stored=''", JSON.stringify({ trigger: s.trigger, stored: s.stored }));
}

/**
 * 移动端输入框（--only=composermobile）：390 宽下工具栏与发送键的布局。
 * 发送/表情的行为由 --only=inputpanel 覆盖，这里只量移动端视口。
 */
async function runComposerMobile(cdp, url) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval("window.__probe.stubApi('saveSettings', null)");
    const mounted = await cdp.eval("window.__probe.install('/src/components/chat/MessageComposer.vue', '', "
      + JSON.stringify(JSON.stringify({
        convId: "group:composer-mobile",
        mentionMembers: [{ id: "p1", name: "小布" }],
      })) + ")");
    await sleep(600);
    const m = await cdp.eval(`(() => {
      const card = document.querySelector('.gosslan-composer');
      const editor = card ? card.querySelector('[role="textbox"]') : null;
      if (!card || !editor) return { ok: false, hasCard: !!card, hasEditor: !!editor };
      const buttons = [...card.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      const send = buttons.find((b) => (b.textContent || '').trim() === '发送');
      const er = editor.getBoundingClientRect();
      return {
        ok: true,
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        buttons: buttons.length,
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 20)),
        editorW: +er.width.toFixed(1),
        hasSend: !!send,
        hasEmoji: buttons.some((b) => (b.getAttribute('aria-label') || '').includes('表情')),
      };
    })()`);
    check("移动端输入框：工具栏与发送键都在视口内，编辑器没有被挤没",
      mounted && mounted.ok === true && m.ok === true && m.scrollW <= m.vw + 1
        && m.outside.length === 0 && m.editorW >= 100 && m.hasSend === true && m.hasEmoji === true,
      "无横向溢出 + outside=0 + editorW>=100 + 发送/表情在", JSON.stringify({ mounted, ...m }));
    check("移动端输入框：发送键与表情入口都可见（不是被 390 宽挤掉）",
      m.ok === true && m.hasSend === true && m.hasEmoji === true,
      "send + emoji", JSON.stringify({ hasSend: m.hasSend, hasEmoji: m.hasEmoji }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-composermobile.png"), Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端输入框取证帧 → " + SHOT_PATH.replace(/\.png$/, "-composermobile.png"));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 移动端布局判据（--only=layoutstore，§6.84）：跑**真的 store.init()**，再用 CDP 把视口宽度
 * 来回跨过那一档。为什么单独起一段：探针里原先唯一的 is-mobile 是夹具自己 toggle 的假读数
 * （见 H.layoutBoot 的注释），所以"摘掉 mq/resize 监听"这种坏法以前整套探针一条都不红。
 * 三条判据 = 宽档不亮 + 跨窄档三面同时翻 + 退回宽档三面同时翻回（单向通过不算这条链的证据）。
 */
async function runLayoutStore(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval("window.__probe.stubApi('saveSettings', null)");
    const mounted = await cdp.eval("window.__probe.install('/src/components/SettingsPanel.vue', '', "
      + JSON.stringify(JSON.stringify({ open: true, isolated: true })) + ")");
    await sleep(400);
    const boot = await cdp.eval("window.__probe.layoutBoot()");
    await sleep(500);
    const wide = await cdp.eval("window.__probe.layoutRead()");
    // 查询串的**形状**在这里判（^(max-width: NNNpx)$），值不许抄：那个数与 Tailwind md 的补数关系
    // 已经由 src/utils/platform.test.ts 从库的默认主题现算对账，探针再抄一份就成了第二个载体。
    const shape = typeof wide.q === "string" && /^\(max-width: \d+px\)$/.test(wide.q);
    check("宽档：store 判否且 <html> 上没有 is-mobile —— 这个类只许由真的 applyIsMobile 写",
      mounted && mounted.ok === true && boot && boot.ok === true && shape
        && wide.mq === false && wide.store === false && wide.cls === false,
      "查询形状 + mq/store/cls 三个 false", JSON.stringify({ mounted, boot, wide }));

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(800);
    const narrow = await cdp.eval("window.__probe.layoutRead()");
    check("跨到 390：查询、store、<html> 类三面各自翻面（是真监听器在驱动，不是夹具自己写）",
      narrow.vw === 390 && narrow.mq === true && narrow.store === true && narrow.cls === true,
      "三个 true", JSON.stringify(narrow));

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1200, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(800);
    const back = await cdp.eval("window.__probe.layoutRead()");
    check("退回 1200：三面同时翻回 false（只验单向会把“摘掉反向那半”读成绿）",
      back.vw === 1200 && back.mq === false && back.store === false && back.cls === false,
      "三个 false", JSON.stringify(back));

    console.log("  · 布局链自然读数：q=" + wide.q + " 宽档 vw=" + wide.vw
      + " 窄档 vw=" + narrow.vw + " init 抛出的那一步（浏览器里没有 Tauri，属预期）="
      + (back.err || boot.err || "(没抛)"));
    // 归因读数（不是判据）：这条链上 mq change 与 resize 是**两个都能驱动同一格**的机制（§6.77 那一族）。
    // 2026-10-19 实测四发：只摘 mq ⇒ 3/3 绿；只摘 resize ⇒ 3/3 绿；两条都摘 ⇒ 2/3，红的正是跨窄档那一格。
    // ⚠️ 同一次两摘还读出另一件事：**反向那一格只在正向真的亮过之后才有牙** —— 两条监听都没了的时候，
    //    类压根没挂上过，"退回宽档后类为 false"于是也成立。它防的是"只会变窄不会变宽"，不是"这条链没接"；
    //    后者由跨档那一格负责。两格各管一件事，别把反向那格读成正向的证据。
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 网络页那几张卡的宽度在「重新连接实时事件」前后是否变化（用户 2026-10-23：
 * 点完中间那块会缩起来，之后不再变宽）。
 *
 * 直接挂 NetworkSection、不经过设置外壳：卡片宽度是内容驱动还是布局驱动，在这一层就能分开 ——
 * 这里不变而真机变 ⇒ 问题在外壳列宽；这里就变 ⇒ 在组件内部。
 */
async function runNetCard(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    // 挂**真实设置面板**（桌面分支是 max-w-xl 的 BaseModal，所有分区竖着排）——
    // 只挂 NetworkSection 量到的是"页面全宽"，盖住了外壳把宽度收窄这件事。
    const mounted = await cdp.eval("window.__probe.install('/src/components/SettingsPanel.vue', '', "
      + JSON.stringify(JSON.stringify({ open: true, isolated: true })) + ")");
    await sleep(900);
    const read = () => cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.getClientRects().length > 0 && el.textContent.includes('实时事件链路'));
      if (!card) return null;
      const modal = card.closest('[class*="max-w-xl"]') || card.closest('[role="dialog"]');
      const btn = [...card.querySelectorAll('button')]
        .find((b) => (b.textContent || '').includes('重新连接'));
      const w = (el) => (el ? +el.getBoundingClientRect().width.toFixed(1) : null);
      return { card: w(card), btn: w(btn), modal: w(modal) };
    })()`);
    const before = await read();
    // 点下去之后逐帧采 1.5s：用户描述的是"一下就缩起来"，瞬态只有采样抓得到。
    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').includes('重新连接实时事件'));
      if (!b) return false;
      window.__netCardSamples = [];
      const first = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.textContent.includes('实时事件链路'));
      let k = 0;
      const tick = () => {
        if (first) {
          const r = first.getBoundingClientRect();
          window.__netCardSamples.push({ w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            t: (first.textContent || '').replace(/\s+/g, ' ').slice(0, 28) });
        } else window.__netCardSamples.push(null);
        if (++k < 30) setTimeout(tick, 50);
      };
      b.click();
      tick();
      return true;
    })()`);
    await sleep(1_800);
    const samples = await cdp.eval("window.__netCardSamples || []");
    const after = await read();
    const finite = samples.filter((n) => n && typeof n.w === "number");
    const minW = finite.length ? Math.min(...finite.map((n) => n.w)) : null;
    const maxW = finite.length ? Math.max(...finite.map((n) => n.w)) : null;
    const minH = finite.length ? Math.min(...finite.map((n) => n.h)) : null;
    const maxH = finite.length ? Math.max(...finite.map((n) => n.h)) : null;
    console.log("  ℹ 设置外壳里卡片宽度 → " + JSON.stringify({
      before, after, frames: finite.length, minW, maxW, minH, maxH, samples: finite.slice(0, 6),
    }));
    check("网络页（真实设置面板）：点「重新连接实时事件」前后卡片宽度不变",
      !!mounted && mounted.ok === true && clicked === true && !!before && !!after
        && Math.abs(after.card - before.card) <= 1
        && minW !== null && Math.abs(maxW - minW) <= 1
        && minH !== null && Math.abs(maxH - minH) <= 1,
      "点前后卡片宽/高相差都 <= 1px，且 1.5s 逐帧采样无缩窄/长高",
      JSON.stringify({ before, after, minW, maxW }));

    // ── 同一个动作，**手机宽度**那一档（用户截图就是二级页 360~390 宽）──
    // 移动端走 MobilePageFrame + 二级页容器，与桌面桌面板是两条不同的 DOM 路径。
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const m2 = await cdp.eval("window.__probe.install('/src/components/SettingsPanel.vue', '', "
      + JSON.stringify(JSON.stringify({ open: true, isolated: true })) + ")");
    await sleep(700);
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').trim() === '网络');
      if (b) b.click();
    })()`);
    await sleep(900);
    const rows = () => cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.getClientRects().length > 0 && el.textContent.includes('实时事件链路'));
      if (!card) return null;
      return [...card.querySelectorAll('[class*="flex-wrap"]')].map((r) => {
        const b = r.getBoundingClientRect();
        return { h: +b.height.toFixed(1), t: (r.textContent || '').replace(/\s+/g, ' ').slice(0, 34) };
      });
    })()`);
    const rowsBefore = await rows();
    const beforeM = await read();
    const clickedM = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').includes('重新连接实时事件'));
      if (!b) return false;
      window.__netCardSamples = [];
      const first = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.textContent.includes('实时事件链路'));
      let k = 0;
      const tick = () => {
        if (first) {
          const r = first.getBoundingClientRect();
          window.__netCardSamples.push({ w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            t: (first.textContent || '').replace(/\s+/g, ' ').slice(0, 28) });
        } else window.__netCardSamples.push(null);
        if (++k < 30) setTimeout(tick, 50);
      };
      b.click();
      tick();
      return true;
    })()`);
    await sleep(1_800);
    const samplesM = await cdp.eval("window.__netCardSamples || []");
    const afterM = await read();
    const rowsAfter = await rows();
    console.log("  ℹ 手机二级页各行高度 → " + JSON.stringify({ rowsBefore, rowsAfter }));
    const finiteM = samplesM.filter((n) => n && typeof n.w === "number");
    const minM = finiteM.length ? Math.min(...finiteM.map((n) => n.w)) : null;
    const maxM = finiteM.length ? Math.max(...finiteM.map((n) => n.w)) : null;
    const minHM = finiteM.length ? Math.min(...finiteM.map((n) => n.h)) : null;
    const maxHM = finiteM.length ? Math.max(...finiteM.map((n) => n.h)) : null;
    console.log("  ℹ 手机二级页卡片宽度 → " + JSON.stringify({
      before: beforeM, after: afterM, frames: finiteM.length, minM, maxM, minHM, maxHM, samples: finiteM.slice(0, 6),
    }));
    check("网络页（手机二级页）：点「重新连接实时事件」前后卡片宽度不变",
      !!m2 && m2.ok === true && clickedM === true && !!beforeM && !!afterM
        && Math.abs(afterM.card - beforeM.card) <= 1
        && minM !== null && Math.abs(maxM - minM) <= 1
        && minHM !== null && Math.abs(maxHM - minHM) <= 1,
      "点前后卡片宽/高相差都 <= 1px，且 1.5s 逐帧采样无缩窄/长高",
      JSON.stringify({ before: beforeM, after: afterM, minM, maxM }));
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

async function runSettingsMobile(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval("window.__probe.stubApi('saveSettings', null)");
    const mounted = await cdp.eval("window.__probe.install('/src/components/SettingsPanel.vue', '', "
      + JSON.stringify(JSON.stringify({ open: true, isolated: true })) + ")");
    await sleep(600);
    const read = () => cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      const text = document.body.innerText || '';
      const input = document.querySelector('input[type=color]');
      const row = input ? input.closest('[class*="px-4"][class*="py-3"]') : null;
      const rowR = row ? row.getBoundingClientRect() : null;
      const inR = input ? input.getBoundingClientRect() : null;
      const presets = row ? [...row.querySelectorAll('button[aria-pressed]')] : [];
      const presetRects = presets.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
      return {
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        buttons: buttons.length,
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)),
        hasList: text.includes('外观') && text.includes('通用设置') && text.includes('关于'),
        hasFont: text.includes('系统默认'),
        colorPresets: presets.length,
        colorPresetWidths: presetRects.map((r) => +r.width.toFixed(1)),
        colorInputRight: inR ? +inR.right.toFixed(1) : null,
        colorInputWidth: inR ? +inR.width.toFixed(1) : null,
        colorLastPresetRight: presetRects.length ? +Math.max(...presetRects.map((r) => r.right)).toFixed(1) : null,
        colorRowRight: rowR ? +rowR.right.toFixed(1) : null,
      };
    })()`);
    let s = await read();
    check("移动端设置：一级列表渲染，390 宽下无横向溢出、按钮都在视口内",
      mounted && mounted.ok === true && s.hasList && s.scrollW <= s.vw + 1 && s.outside.length === 0,
      "列表可见 + scrollWidth<=vw + outside=0", JSON.stringify({ mounted, s }));

    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').trim().includes('外观'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(500);
    s = await read();
    check("移动端设置：进入「外观」二级页，字体默认档可见且无横向溢出",
      clicked === true && s.hasFont && s.scrollW <= s.vw + 1 && s.outside.length === 0,
      "外观页含系统默认 + 无溢出", JSON.stringify(s));
    const colorsOk = s.colorPresets === 6
      && s.colorPresetWidths.length === 6 && s.colorPresetWidths.every((w) => w >= 20)
      && s.colorInputWidth >= 24
      && s.colorRowRight !== null
      && s.colorInputRight <= s.colorRowRight - 1
      && s.colorLastPresetRight <= s.colorRowRight - 1;
    check("移动端外观：6 个预设色与自定义色都完整可见（没有把最后一个色块挤没/裁掉）",
      colorsOk,
      "6 个预设宽度≥20 + 自定义色≥24 且在行内",
      JSON.stringify({ presets: s.colorPresets, widths: s.colorPresetWidths,
        inputW: s.colorInputWidth, inputRight: s.colorInputRight,
        lastRight: s.colorLastPresetRight, rowRight: s.colorRowRight }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const p = SHOT_PATH.replace(/\.png$/, "-settingsmobile.png");
      fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端设置取证帧 → " + p);
    }

    const back = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => {
        const a = x.getAttribute('aria-label') || '';
        return a.includes('返回') || /\\bBack\\b/i.test(a);
      });
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(400);
    s = await read();
    check("移动端设置：返回键回到一级列表（二级页不是死路）",
      back === true && s.hasList === true, "返回后列表重新出现", JSON.stringify(s));

    // ── 按压不变形（用户 2026-10-23：「点击选项整个列表都缩小」）──
    // 真按住一次再读 computed transform，而不是查 data-no-press 存不存在：
    // 类名在 ≠ 效果对。**正控**是标题栏那颗返回键（普通按钮，必须照旧缩）——
    // 没有它，整个探针读不到缩放也可能是量具坏了。
    const pressBy = async (pickJs) => {
      const r = await cdp.eval(`(() => {
        const b = (${pickJs});
        if (!b) return null;
        const q = b.getBoundingClientRect();
        return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
      })()`);
      if (!r) return null;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await sleep(180);
      const tr = await cdp.eval(`(() => {
        const b = (${pickJs});
        if (!b) return null;
        // 按压形态在内层那一段（用户 2026-10-23：整行不缩，中间那一块凹下去 + 内阴影）。
        const inner = b.querySelector('span');
        const ics = inner ? getComputedStyle(inner) : null;
        return {
          transform: getComputedStyle(b).transform,
          noPress: b.hasAttribute('data-no-press'),
          text: (b.textContent || '').trim().slice(0, 12),
          innerTransform: ics ? ics.transform : null,
          innerShadow: ics ? ics.boxShadow : null,
        };
      })()`);
      // 抬手点故意挪开：同一元素上 press+release 会合成一次 click（按列表项就会跳页、
      // 按返回就会退出），这条探针只想要 :active 期间的计算样式，不想要副作用。
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: Math.max(1, r.y - 260), button: "left", clickCount: 1 });
      await sleep(120);
      return tr;
    };
    // ⚠️ 两个选择器必须**各自独立**：写成「文案是外观 或 aria 含返回」的单一谓词时，
    // 头部那颗返回键排在内容前面 ⇒ 两次都会按到它，rowPress 拿到的其实是返回键（实测踩过）。
    const rowPick = `[...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '外观')`;
    const backPick = `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('返回'))`;
    const rowPress = await pressBy(rowPick);
    const backPress = await pressBy(backPick);
    const scaled = (t) => !t ? null : (t !== "none" && !/matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)/.test(t));
    check("移动端设置：按住列表项整行不缩放（按压反馈只给普通按钮）",
      rowPress?.noPress === true && /外观/.test(rowPress.text) && scaled(rowPress.transform) === false
        && scaled(backPress?.transform) === true,
      "列表项(外观)带 data-no-press 且 transform 不缩放 + 返回键(正控)照旧缩放",
      JSON.stringify({ rowPress, backPress }));
    // 用户同日追加：「中间那一块凹下去 + 一点阴影，宽度不要变」——内层真的下沉并出现内阴影，
    // 而不是只停了整行的缩放（那样等于没有按压反馈）。
    check("设置列表项：按住时内层那一段下沉并出现内阴影（整行仍不缩放）",
      !!rowPress && /matrix\(/.test(String(rowPress.innerTransform))
        && !/none/.test(String(rowPress.innerShadow))
        && /inset/.test(String(rowPress.innerShadow)),
      "内层 transform 非 none + box-shadow 含 inset",
      JSON.stringify({ innerTransform: rowPress?.innerTransform, innerShadow: rowPress?.innerShadow }));

    // 量的是**同一个元素**的 left 在「刚进入」与「滑到底」两处的差，不是文案、不是类名。
    // 边距会漂只有两类来源：某一层滚动容器在滚动过程中长出了滚动条（吃掉宽度），或者某个
    // 祖先的 padding 被 class 切换改掉。这段把每一层滚动容器的 clientWidth/offsetWidth 一起打出来，
    // 红了能直接指到是哪一层。
    const openNetwork = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').trim() === '网络');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(900);
    const drift = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.getClientRects().length > 0 && el.textContent.includes('蓝牙通道'));
      if (!card) return { found: false };
      const scrollers = [];
      for (let el = card.parentElement; el; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
          scrollers.push({
            cls: String(el.className).slice(0, 60),
            clientW: el.clientWidth,
            offsetW: el.offsetWidth,
            scrollH: el.scrollHeight,
            clientH: el.clientHeight,
            gutter: cs.scrollbarGutter,
            padL: cs.paddingLeft,
          });
        }
      }
      const inner = scrollers[0] ? card.parentElement.closest('[class*="overflow-y-auto"]') : null;
      const readAt = () => +card.getBoundingClientRect().left.toFixed(1);
      const atTop = readAt();
      // ⚠️ 非空转：隔离安装里网络段的异步数据是桩，页面可能根本不够高 ⇒ 滚不动 ⇒
      // 「滚动前后一样」会凭空空转。滚不动就塞一段撑高的填充物，强制进入「滑到底」那一态。
      let forced = false;
      if (inner) {
        if (inner.scrollHeight <= inner.clientHeight + 8) {
          const filler = document.createElement('div');
          filler.setAttribute('data-probe-filler', '');
          filler.style.height = '2000px';
          inner.appendChild(filler);
          forced = true;
        }
        inner.scrollTop = inner.scrollHeight;
      }
      return {
        found: true, atTop, atBottom: readAt(), scrollers, forced,
        scrollTop: inner ? Math.round(inner.scrollTop) : null,
        scrollH: inner ? inner.scrollHeight : null,
        clientH: inner ? inner.clientHeight : null,
      };
    })()`);
    await sleep(300);
    const driftAfter = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.getClientRects().length > 0 && el.textContent.includes('蓝牙通道'));
      return card ? +card.getBoundingClientRect().left.toFixed(1) : null;
    })()`);
    console.log("  ℹ 网络页边距读数 → " + JSON.stringify({ drift, driftAfter }));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const p = SHOT_PATH.replace(/\.png$/, "-network.png");
      fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
      console.log("  📷 网络页取证帧 → " + p);
    }
    check("移动端设置·网络页：滑到底之后卡片左边缘不动（边距不漂）",
      openNetwork === true && drift.found === true && driftAfter !== null
        && drift.scrollTop > 0
        && Math.abs(driftAfter - drift.atTop) <= 1,
      "确实滚动了（scrollTop>0）+ 同一张卡 left 在滚动前后相差 <=1px",
      JSON.stringify({ drift, driftAfter }));
    // 嵌套滚动容器是「滑一会边距变了」的机制本身：外层壳一旦也开滚动，触屏滚到底会串联到
    // 它（整块内容位移），两层又各留一条 gutter（左右各多吃 8px）。这里钉**唯一一层**。
    check("移动端设置·网络页：内容区只有一层滚动容器（没有嵌套滚动）",
      drift.found === true && Array.isArray(drift.scrollers) && drift.scrollers.length === 1,
      "从卡片往上只有 1 个 overflow-y 滚动祖先",
      JSON.stringify(drift.scrollers));

    // 资料页与设置二级页同一口径的页边距（用户 2026-10-23：「个人资料周围没有边距」）。
    // 量的是同一张卡在**两个不同页面**上的 left 相等 —— 只比类名是抓不住「有一页忘了 p-4」的。
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => {
        const a = x.getAttribute('aria-label') || '';
        return a.includes('返回') || /\\bBack\\b/i.test(a);
      });
      if (b) b.click();
    })()`);
    await sleep(400);
    const openProfile = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.textContent || '').trim() === '个人资料');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(700);
    const profileLeft = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="rounded-"][class*="border"]')]
        .find((el) => el.getClientRects().length > 0 && el.textContent.includes('上传头像'));
      return card ? +card.getBoundingClientRect().left.toFixed(1) : null;
    })()`);
    check("移动端设置·资料页：卡片左边缘与网络页同口径（都有页面边距）",
      openProfile === true && profileLeft !== null && drift.found === true
        && Math.abs(profileLeft - drift.atTop) <= 1 && profileLeft >= 8,
      "资料卡 left == 网络卡 left 且 >=8",
      JSON.stringify({ profileLeft, networkLeft: drift.atTop }));

    // 用户 2026-10-23（移动端资料页）：去掉「我在线」只留绿点、输入框更长、与计数间距更小。
    // 量的都是**几何与文本**，不是类名：类名对了但宽度被别的元素吃掉一样要红。
    const nick = await cdp.eval(`(() => {
      const inp = document.querySelector('[data-profile-fields] input:not([type="file"])');
      if (!inp) return null;
      const row = inp.parentElement;
      const kids = row ? [...row.children] : [];
      // 计数那一格：兄弟里带 “N/M” 文本的那个（不是 input，也不是状态点）
      const counter = kids.find((el) => el !== inp && /\d+\s*[/]\s*\d+/.test(el.textContent || ''))
        || kids[1];
      const dot = [...row.querySelectorAll('span')].find((el) => /rounded-full/.test(String(el.className)));
      const ir = inp.getBoundingClientRect();
      const cr = counter ? counter.getBoundingClientRect() : null;
      return {
        text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        inputW: +ir.width.toFixed(1),
        gapToCounter: cr ? +(cr.left - ir.right).toFixed(1) : null,
        hasDot: !!dot,
      };
    })()`);
    console.log("  ℹ 资料页昵称行读数 → " + JSON.stringify(nick));
    check("移动端资料页：只留状态点（无「我在线」文案）、输入框更宽、与计数间距更小",
      !!nick && !/我在线|在线/.test(nick.text) && nick.hasDot
        && nick.inputW >= 140
        && nick.gapToCounter !== null && nick.gapToCounter <= 6,
      "无在线文案 + 有状态点 + input>=140 + 与计数间距<=6",
      JSON.stringify(nick));
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 移动端群任务（--only=tasksmobile）：390 宽下看板行与详情弹窗的布局。
 * 行为（实时同步、筛选、详情内容）由 --only=tasksrt 覆盖，这里只量移动端视口。
 */
/**
 * 统一后台任务中心（`TaskCenter.vue`）的运行时判据。
 *
 * 负责人 2026-10-23 的原话里有三件**只有运行时量得到**的事：
 *   ① "已经完成的在这个列表里应该是不展示" —— 读模型那侧有单测，但"store → 列表 DOM"
 *      这一根接线只有挂起来才量得到（逻辑全绿而没人接上 = 功能为零）；
 *   ② "百分之百没完成 / 接收中的都可以取消" —— 每一行到底有没有长出那颗按钮；
 *   ③ "右下角那个胶囊一拨就可以往四个角移动" —— 这是**指针位移阈值**驱动的行为，
 *      DOM 上派发事件量不到（不经命中测试、也不产生真的 pointer 捕获），
 *      所以这里用 `Input.dispatchMouseEvent` 按住—移动—松手走一遍。
 *
 * ⚠️ 与所有其它段同一条边界：这是浏览器输入管线里的一次真拖动，
 * **不等于** WKWebView / WebView2 里的手感（那一半归 Smoke-11 人工）。
 */
async function runOpsCenter(cdp, url) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const mounted = await cdp.eval(
      "window.__probe.install('/src/components/TaskCenter.vue', '', '')",
    );
    check("任务中心：组件在真实 DOM 里挂起来了", !!mounted && mounted.ok === true,
      "install ok", JSON.stringify(mounted));

    // 种四份真值：五种任务各一条 + 一条 done 终态（它**不该**出现在列表里）。
    // 标题用文件名与正文（与语言无关），判据按这些字符串认行，不认按 locale 拼出来的动作名。
    const seeded = await cdp.eval(`(async () => {
      const S = await import('/src/stores/useChatStore.ts');
      const chat = S.useChatStore();
      chat.transfers = [
        { id: 't-send', peer_id: 'p1', name: '设计稿.zip', size: 1000, direction: 'send',
          status: 'active', path: null, progress: 0.4, blocked_reason: null, created_at: 5 },
        { id: 't-sent', peer_id: 'p1', name: '会议记录.md', size: 100, direction: 'send',
          status: 'sent', path: null, progress: 1, blocked_reason: null, created_at: 6 },
        { id: 't-recv', peer_id: 'p1', name: '照片.jpg', size: 500, direction: 'receive',
          status: 'active', path: null, progress: 0.6, blocked_reason: null, created_at: 7 },
        { id: 't-done', peer_id: 'p1', name: '已完成.txt', size: 10, direction: 'send',
          status: 'done', path: null, progress: 1, blocked_reason: null, created_at: 8 },
      ];
      chat.contentTransfers = [{
        cid: 'a'.repeat(64), peerId: 'p1', groupId: null, name: 'a'.repeat(64), size: 200,
        direction: 'receive', status: 'incomplete', received: 0, attempts: 2,
        nextAttemptAt: 0, lastError: null, path: null, createdAt: 3, updatedAt: 3,
      }];
      chat.messageOps = [{ msg_id: 'm1', kind: 'text', peer_id: 'p1', group_id: null,
        waiting_for: 1, created_at: 9, preview: '在吗', peer_offline: true }];
      chat.groupHistorySync = { g1: { group_id: 'g1', source: 'p1', synced: 30, total: 100,
        phase: 'running' } };
      const t = window.__probe.vue;
      await t.nextTick(); await t.nextTick();
      return { ops: chat.operations.length, ledger: chat.transfers.length };
    })()`);
    check("任务中心：四份真值汇成 6 件未完成任务（done 那条被排除在列之外）",
      seeded && seeded.ops === 6 && seeded.ledger === 4,
      "ops=6 / ledger=4", JSON.stringify(seeded));

    const READ = `(() => {
      const outside = Array.from(document.querySelectorAll('button'))
        .filter((b) => !b.closest('[role="dialog"]'));
      const pill = outside.length === 1 ? outside[0] : null;
      const box = pill ? pill.getBoundingClientRect() : null;
      const dialog = document.querySelector('[role="dialog"]');
      const rows = dialog ? Array.from(dialog.querySelectorAll('li')).map((li) => ({
        title: String((li.querySelector('span') || {}).textContent || '').trim(),
        buttons: li.querySelectorAll('button').length,
      })) : [];
      return {
        pillButtons: outside.length,
        pill: box ? { left: Math.round(box.left), top: Math.round(box.top),
          right: Math.round(box.right), bottom: Math.round(box.bottom) } : null,
        dialog: !!dialog,
        rows: rows,
        corner: localStorage.getItem('taskCenter.corner'),
        vw: window.innerWidth, vh: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
      };
    })()`;
    const read = () => cdp.eval(READ);

    // 起跑前把这条键清掉：这一段的头两格判的是"没写过位置时停在右下"，
    // profile 是每次 mkdtemp 新建的、正常不会留东西，但**同一趟里**这一段被跑第二遍
    // （--only=opscenter 复跑 / 将来把它挂进别的组合）时，上一遍写的 'br'/'tl' 会让那条
    // `corner === null` 变成掷硬币。清一次是免费的确定性。
    await cdp.eval("localStorage.removeItem('taskCenter.corner')");
    const first = await read();
    check("药丸渲染出来了，且它是此刻页面里唯一一颗非弹窗按钮（入口接上了）",
      first.pillButtons === 1 && !!first.pill,
      "1 颗", JSON.stringify({ pillButtons: first.pillButtons, pill: first.pill }));
    check("默认停在右下角（没写过位置时与改动前那颗同一位置）",
      !!first.pill && first.pill.right > first.vw / 2 && first.pill.bottom > first.vh / 2
        && first.vw - first.pill.right <= 20 && first.corner === null,
      "贴右边缘、右下象限、localStorage 还没写过",
      JSON.stringify({ pill: first.pill, vw: first.vw, vh: first.vh, corner: first.corner }));

    // ① 纯点击（指针不位移）必须打开面板 —— 拖动阈值如果把点按吞掉，这一格当场红。
    await cdp.click(first.pill.left + 40, first.pill.top + 12);
    const opened = await read();
    check("点一下（不拖动）打开面板，列表行数等于读模型的 6 行",
      opened.dialog === true && opened.rows.length === 6,
      "dialog + 6 行", JSON.stringify({ dialog: opened.dialog, rows: opened.rows.length }));
    const byTitle = (title) => opened.rows.find((r) => r.title === title);
    const recv = byTitle('照片.jpg');
    const sent = byTitle('会议记录.md');
    const msg = byTitle('在吗');
    check("接收中的行有按钮（负责人：接受中没有完成的都是可以取消的）",
      !!recv && recv.buttons >= 1, "≥1", JSON.stringify(recv));
    check("100% 但未终态（sent）的行有按钮（负责人：百分之百没完成的也可以取消）",
      !!sent && sent.buttons >= 1, "≥1", JSON.stringify(sent));
    check("消息行只给「今天真能动的」按钮（取消在 B4，所以这一行是 1 颗=去会话）",
      !!msg && msg.buttons === 1, "1", JSON.stringify(msg));
    // 排序：要人处理的那一行必须排最前（blocked → running → queued）。
    // 这一段里 blocked 的有三条（peer_offline 的消息最新），所以第一行必须是它。
    check("DOM 顺序 = 读模型的顺序：需要处理的那一行排最前",
      opened.rows[0] && opened.rows[0].title === '在吗',
      "第一行是 peer_offline 的那条消息",
      JSON.stringify(opened.rows.map((r) => r.title)));
    check("已完成那条不在列表里（DOM 与读模型同一口径）",
      opened.rows.some((r) => r.title === '已完成.txt') === false,
      "不含 已完成.txt", JSON.stringify(opened.rows.map((r) => r.title)));

    // 更新下载那一类（B5）：只证明"store 里的可查询状态真的会变成一行 + 一个取消键"。
    // 相位语义（ready/installing 不列）由读模型单测钉，这里只管接线。
    await cdp.eval(`(async () => {
      const S = await import('/src/stores/useChatStore.ts');
      S.useChatStore().updaterStatus = { phase: 'downloading', downloaded: 40, total: 100,
        version: '9.9.9', error: null };
      const t = window.__probe.vue;
      await t.nextTick(); await t.nextTick();
      return true;
    })()`);
    const withUpdate = await read();
    const updateRow = withUpdate.rows.find((r) => r.title === 'v9.9.9');
    check("更新下载在任务中心里长成一行（目标版本号当标题）",
      withUpdate.rows.length === 7 && !!updateRow,
      "7 行且含 v9.9.9",
      JSON.stringify({ rows: withUpdate.rows.map((r) => r.title) }));
    check("那一行正好一颗「取消」（install 阶段不可取消，所以不是两颗）",
      !!updateRow && updateRow.buttons === 1, "1 颗", JSON.stringify(updateRow));
    await cdp.eval(`(async () => {
      const S = await import('/src/stores/useChatStore.ts');
      S.useChatStore().updaterStatus = null;
      const t = window.__probe.vue;
      await t.nextTick(); await t.nextTick();
      return true;
    })()`);

    // ④b 移动端 390：**面板开着**时也不许把页面撑出横向滚动（T1 验证矩阵那一格）。
    // 放在这里是因为面板此刻正开着（刚点开、还没关）—— 关掉再开需要真实点击，
    // 而 headless 静止页面不出帧（Reka 的遮罩要等 after-leave），那一步在本段里不稳。
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(400);
    const mOpen = await read();
    check("390 宽、面板打开：没有横向溢出，6 行都在",
      mOpen.dialog === true && mOpen.scrollWidth <= 390 && mOpen.rows.length === 6,
      "dialog + scrollWidth ≤ 390 + 6 行",
      JSON.stringify({ dialog: mOpen.dialog, sw: mOpen.scrollWidth, rows: mOpen.rows.length }));
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(400);

    // 关掉面板再拖。这里**不用 Esc**：Esc 要焦点已经落在弹窗里才有作用点，
    // 而这一段刚才是"真点击坐标"打开的，焦点落点不该被本段当成前提来依赖
    // （焦点那条出口另有 `--only=overlay` 那 32 条守着）。点卡片外的遮罩是 Reka 的
    // outside-pointerdown 那条路，与用户"点旁边关掉"是同一件事。
    // ⚠️ 这一格必须先红再绿：遮罩没关掉时，下面那次拖动的按下会打在**遮罩**上
    //（遮罩 z-64 在药丸 z-40 之上），于是 corner 永远是 null —— 第一版就是这么红的，
    // 那不是拖动坏了，是这一段的前置没成立。
    // 出帧泵：`Page.captureScreenshot` 会强制走一遍更新渲染，rAF 回调在那一步里跑。
    // 关面板这一步**必须**泵帧：Reka 的遮罩在 `after-leave` 之后才卸载，而 headless 页面
    // 静止时不出帧 ⇒ 遮罩（z-64）会一直盖在药丸（z-40）上，后续的"点药丸"全打在遮罩上
    // （本段第一版实测：读数像"药丸点不开"，其实是面板关不干净）。
    const pumpFrames = async (n = 6) => {
      for (let i = 0; i < n; i += 1) {
        await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => {});
      }
    };
    const closePanel = async () => {
      await cdp.click(60, 400);
      await sleep(600);
      await pumpFrames();
      return read();
    };
    const closed = await closePanel();
    check("对照前置：点卡片外能把面板关掉（否则拖动是打在遮罩上，读数不可信）",
      closed.dialog === false && closed.pillButtons === 1,
      "dialog=false / 1 颗", JSON.stringify({ dialog: closed.dialog, pillButtons: closed.pillButtons }));

    // ② 真的按住拖到左上象限 ⇒ 吸附左上角 + 位置写进 localStorage + **不把面板点开**。
    const from = { x: closed.pill.left + 40, y: closed.pill.top + 12 };
    await cdp.drag(from.x, from.y, 120, 120);
    const moved = await read();
    check("真拖动之后药丸吸到左上角（哪一角，不是像素）",
      !!moved.pill && moved.pill.left <= 20 && moved.pill.top <= 140
        && moved.pill.left < moved.vw / 2 && moved.pill.top < moved.vh / 2,
      "left≤20 且落在左上象限", JSON.stringify(moved.pill));
    check("拖动把那一角写进了 localStorage（重启还在：挡住输入区的位置每次都同一处）",
      moved.corner === "tl", "tl", JSON.stringify({ corner: moved.corner }));
    check("拖完没有顺手把面板点开（点按与拖动必须分开）",
      moved.dialog === false, "dialog=false", JSON.stringify({ dialog: moved.dialog }));

    // ③ 拖完还要点得开：`suppressClick` 只许吞掉这一次，不许常驻。
    await cdp.click(moved.pill.left + 40, moved.pill.top + 12);
    const reopened = await read();
    check("拖完之后仍然一点就开（吞点击只吞拖动那一下）",
      reopened.dialog === true, "dialog=true", JSON.stringify({ dialog: reopened.dialog }));

    // ④ 移动端 390 宽：药丸与列表都不许把页面撑出横向滚动。
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await sleep(400);
    const narrow = await read();
    check("390 宽：页面没有横向溢出（药丸 max-w 兜住了）",
      narrow.scrollWidth <= 390, "scrollWidth ≤ 390",
      JSON.stringify({ scrollWidth: narrow.scrollWidth }));
    check("390 宽：药丸仍完整落在视口内（拖过之后也不会跑到屏外）",
      !!narrow.pill && narrow.pill.left >= 0 && narrow.pill.right <= 390
        && narrow.pill.top >= 0 && narrow.pill.bottom <= 844,
      "在视口内", JSON.stringify(narrow.pill));

    // ④c 空态：所有来源都空 ⇒ 药丸整个不渲染（"没有进行中的任务"不是一行空面板，是入口消失）。
    const cleared = await cdp.eval(`(async () => {
      const S = await import('/src/stores/useChatStore.ts');
      // 两个实例都清：本页既跑着真实 app（自己那份 pinia），也挂着探针挂载的那份
      // （window.__pinia）。只清其中一个时，界面上那颗药丸可能属于另一个 —— 这一格
      // 判的是"事实为空时入口消失"，不该被实例归属问题判成红。
      const stores = [S.useChatStore()];
      if (window.__pinia) stores.push(S.useChatStore(window.__pinia));
      for (const c of stores) {
        c.transfers = []; c.contentTransfers = []; c.messageOps = []; c.groupHistorySync = {};
        c.updaterStatus = null;
      }
      const c = stores[0];
      const t = window.__probe.vue;
      await t.nextTick(); await t.nextTick();
      await new Promise((r) => setTimeout(r, 300));
      const outside = Array.from(document.querySelectorAll('button'))
        .filter((b) => !b.closest('[role="dialog"]'));
      return {
        ops: c.operations.length,
        transfers: c.transfers.length,
        domButtons: outside.length,
        domText: outside.map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 2),
      };
    })()`);
    const empty = await read();
    check("没有未完成任务时药丸不渲染（入口随事实消失，不留一个 0 件的壳）",
      empty.pillButtons === 0 && empty.pill === null,
      "0 颗按钮",
      JSON.stringify({ pillButtons: empty.pillButtons, cleared, dialog: empty.dialog }));

  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 「发送失败 / 已取消之后那颗重发」的运行时判据（负责人 2026-10-23："可以有个重试/再次发送…
 * 可打断 可恢复 可取消这种都应该有"）。
 *
 * 这一段判的是**走的是哪条通道**，不是"按钮在不在"：
 * 图片以前漏在 `retryable` 与 `retrySend` 两处的缝里（两处都只排除 `file`），失败的图片被按
 * 普通消息重发了一份 JSON 载荷 ⇒ 对端收到"有名字没有字节"的一张图、本机还转成绿色。
 * 静态判据只能证明"引了这个函数"，**"点一下到底打到哪条命令"只能在这里量**：
 * 用 `H.stubApi` 把两条命令各换一个计数替身，真按一次回执那颗，读调用次数。
 *
 * 附件已被存储清理那一格也在这里判：那时必须**没有**按钮（不给一颗点了没反应的键 = 界面不撒谎）。
 */
async function runResend(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const IMG_META = JSON.stringify({ name: "白板照片.png", size: 2048, path: "/tmp/probe-a.png", subtype: "image", sha256: "b".repeat(64) });

  /** 真挂一次消息行（props 由页面里那份对象给出），并返回那颗重发的坐标。 */
  const mountAndLocate = async (over) => {
    const msg = Object.assign({
      id: -1, msg_id: "m-rs-1", sender_id: "dev-me", receiver_id: "p1", conv_id: "p1",
      kind: "image", content: IMG_META, ts: 1700000000000, seq: 1, status: "failed",
    }, over);
    const mounted = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
      + JSON.stringify(JSON.stringify({ message: msg, isGroup: false, senderName: "我" })) + ")");
    if (!mounted || mounted.ok !== true) return { ok: false, why: "install", mounted };
    const seeded = await cdp.eval("window.__probe.seedDevice('dev-me')");
    if (!seeded || seeded.ok !== true) return { ok: false, why: "seedDevice", seeded };
    await sleep(250);
    const btn = await cdp.eval(`(async () => {
      const I = await import('/src/i18n/index.ts');
      const want = I.t('msg.resend');
      const hit = Array.from(document.querySelectorAll('button'))
        .find((b) => b.getAttribute('aria-label') === want && b.getClientRects().length > 0);
      if (!hit) return { found: false, want: want };
      const r = hit.getBoundingClientRect();
      return { found: true, want: want, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    return { ok: true, btn };
  };

  /** 每条被点的命令都换成"只计数"的替身；顺带把 store 刷新链上那三条读命令兜住。 */
  const stubAll = async () => {
    for (const [name, payload] of [
      ["sendFileAuto", "t-resend-1"],
      ["sendGroupFile", "t-resend-2"],
      ["sendMessage", { msg_id: "m-rs-new", conv_id: "p1", sender_id: "dev-me", kind: "text", content: "hi", ts: 1700000000001, seq: 2, status: "sending" }],
      ["getTransfers", []],
      ["getContentTransfers", []],
      ["getPendingMessageOperations", []],
      ["mediaPresent", true],
    ]) {
      await cdp.eval(`window.__probe.stubApi(${JSON.stringify(name)}, ${JSON.stringify(payload)})`);
    }
    return true;
  };
  const calls = async (name) => cdp.eval(`window.__probe.apiCalls(${JSON.stringify(name)})`);

  // ── ① 失败的**图片**：必须回文件通道，而不是 send_message ──────────────
  await stubAll();
  const a = await mountAndLocate({});
  check("失败图片这行挂出来了，回执那颗是可点的（可访问名 = msg.resend）",
    a.ok === true && a.btn && a.btn.found === true, "found=true", JSON.stringify(a));
  if (a.ok && a.btn && a.btn.found) {
    await cdp.click(a.btn.x, a.btn.y);
    await sleep(600);
    const file = await calls("sendFileAuto");
    const text = await calls("sendMessage");
    check("★ 点失败图片的重发 ⇒ 走 send_file_auto（恰好一次）",
      file === 1, "sendFileAuto=1", JSON.stringify({ file }));
    check("★ 同一下点击**没有**走 send_message（旧那步把 JSON 载荷当普通消息发出去 = 假成功）",
      text === 0, "sendMessage=0", JSON.stringify({ text }));
  } else {
    check("★ 点失败图片的重发 ⇒ 走 send_file_auto（恰好一次）", false,
      "先要那颗按钮存在", JSON.stringify(a));
    check("★ 同一下点击**没有**走 send_message（旧那步把 JSON 载荷当普通消息发出去 = 假成功）", false,
      "上一格没成立，这一格没作用点", JSON.stringify(a));
  }

  // ── ② 已取消的图片也要能再发（负责人点名"取消了"那一格）────────────────
  await stubAll();
  const b = await mountAndLocate({ msg_id: "m-rs-2", status: "cancelled" });
  check("已取消的图片行也长出可点的重发（取消不是错误，但同样要能恢复）",
    b.ok === true && b.btn && b.btn.found === true, "found=true", JSON.stringify(b));
  if (b.ok && b.btn && b.btn.found) {
    await cdp.click(b.btn.x, b.btn.y);
    await sleep(600);
    check("点它 ⇒ 同样走 send_file_auto", (await calls("sendFileAuto")) === 1,
      "sendFileAuto=1", JSON.stringify({ file: await calls("sendFileAuto") }));
  } else {
    check("点它 ⇒ 同样走 send_file_auto", false, "先要那颗按钮存在", JSON.stringify(b));
  }

  // ── ③ 群里的失败文件 ⇒ 必须走群文件那条命令，而不是单聊那条 ─────────────
  await stubAll();
  const c = await mountAndLocate({
    msg_id: "gfile-1", conv_id: "group:g1", kind: "file", status: "failed",
  });
  const cOk = c.ok === true && c.btn && c.btn.found;
  if (cOk) {
    await cdp.click(c.btn.x, c.btn.y);
    await sleep(600);
    const grp = await calls("sendGroupFile");
    const dm = await calls("sendFileAuto");
    check("群文件失败后重发走 send_group_file（而不是把群会话当对端去 send_file_auto）",
      grp === 1 && dm === 0, "sendGroupFile=1 / sendFileAuto=0", JSON.stringify({ grp, dm }));
  } else {
    check("群文件失败后重发走 send_group_file（而不是把群会话当对端去 send_file_auto）", false,
      "先要那颗按钮存在", JSON.stringify(c));
  }

  // ── ④ 载荷里没有路径 ⇒ 不许有按钮（没有可发的字节 = 给了就是界面在撒谎）──
  // ⚠️ 这一格刻意用"content 里没有 path"，**不是**用 mediaPresent=false：
  // 失败的**图片**行今天拿不到可达性信号（`previewSubtype` 在 failed 时直接返回 null，
  // 而 `shouldProbePresence` 只给 subtype=file 那份探测 ⇒ 两路都不跑，`attachmentMissing` 恒 false）。
  // 所以"附件已被存储清理"那一档今天量不到（点它会由后端报错、走 sendFileTo 那条失败 toast，
  // 不是静默成功）；要收那一格得动 `shouldProbePresence` 那条共享判据，不在本批顺手做。
  await stubAll();
  const d = await mountAndLocate({
    msg_id: "m-rs-4",
    content: JSON.stringify({ name: "白板照片.png", size: 2048, subtype: "image" }),
  });
  check("★ 载荷里没有 path ⇒ 那颗重发不渲染（没有可发的字节就不给按钮）",
    d.ok === true && d.btn && d.btn.found === false, "found=false", JSON.stringify(d));

  // ── ⑤ 文本失败仍是原地复用那条（`retrySend.test.ts` 的运行时那一半）─────
  await stubAll();
  const e = await mountAndLocate({ msg_id: "m-rs-5", kind: "text", content: "在吗" });
  if (e.ok === true && e.btn && e.btn.found) {
    await cdp.click(e.btn.x, e.btn.y);
    await sleep(600);
    check("文本失败重发仍走 send_message（恰好一次），且不碰文件通道",
      (await calls("sendMessage")) === 1 && (await calls("sendFileAuto")) === 0,
      "sendMessage=1 / sendFileAuto=0",
      JSON.stringify({ text: await calls("sendMessage"), file: await calls("sendFileAuto") }));
  } else {
    check("文本失败重发仍走 send_message（恰好一次），且不碰文件通道", false,
      "先要那颗按钮存在", JSON.stringify(e));
  }
}

async function runTasksMobile(cdp, url) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await cdp.eval(`(async () => {
      window.GID = 'g1';
      window.CONV = 'group:g1';
      window.ME = 'probe-me';
      window.OTHER = 'probe-other';
      window.__mk = (id, seq, kind, def, ts) => ({
        msg_id: 'm-' + id + '-' + seq,
        sender_id: window.OTHER,
        conv_id: window.CONV,
        kind, seq, ts,
        status: 'read',
        content: JSON.stringify(Object.assign({
          todo_id: id, title: id, assignees: [window.ME], status: 'todo',
          creator: window.OTHER, deleted: false, description: '', images: [],
          archived: false, done_at: null, number: 0, priority: 'normal', category: 'task',
        }, def)),
      });
      return true;
    })()`);
    await cdp.eval("window.__probe.todoBus()");
    const now = Date.now();
    await cdp.eval(`window.__TASKS = [
      window.__mk('A', 1, 'todo', { title: '很长的移动端任务标题用来测试换行和右侧操作按钮', number: 1, priority: 'high', description: '移动端描述' }, ${now}),
      window.__mk('B', 2, 'todo', { title: '第二条任务', number: 2 }, ${now + 1}),
    ]`);
    await cdp.eval("window.__probe.todoRows(window.__TASKS)");
    await cdp.eval(`window.__probe.install('/src/components/GroupTasksBoard.vue', '', ${JSON.stringify(JSON.stringify({ groupId: "g1", open: true }))})`);
    await cdp.eval("window.__probe.seedDevice('probe-me')");
    await sleep(900);
    const read = () => cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      const outside = buttons.filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > innerWidth + 1 || r.left < -1;
      });
      return {
        vw: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        rows: document.querySelectorAll('button.min-w-0.flex-1').length,
        outside: outside.map((b) => String(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24)),
      };
    })()`);
    let s = await read();
    check("移动端群任务：390 宽下任务行渲染，且无横向溢出/越界按钮",
      s.rows >= 2 && s.scrollW <= s.vw + 1 && s.outside.length === 0,
      "rows>=2 + scrollWidth<=vw + outside=0", JSON.stringify(s));

    const clicked = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button.min-w-0.flex-1')]
        .find((x) => (x.textContent || '').includes('很长的移动端'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(500);
    const dlg = await cdp.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return { ok: false };
      const r = d.getBoundingClientRect();
      return {
        ok: true,
        inViewport: r.left >= -1 && r.right <= innerWidth + 1
          && r.top >= -1 && r.bottom <= innerHeight + 1,
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      };
    })()`);
    check("移动端群任务：点行打开的详情弹窗整个在视口内",
      clicked === true && dlg.ok === true && dlg.inViewport === true,
      "dialog 在视口内", JSON.stringify(dlg));

    // §6.76 台账那两条交给库的 window 监听，运行时**各咬一面**。
    // `scroll` 挂在 window 上但必须带 capture —— 列表那层 `overflow-y-auto` 的 scroll **不冒泡**，
    // 只有捕获相的 window 监听收得到；`resize` 不需要旗标。摘掉 `true` ⇒ 第二条红而第三条照绿；
    // 摘掉 `resize` 那条 ⇒ 反过来。这正是 §6.71 静态抓的「只改一侧」在运行时的另一半。
    // ⚠️ 第二条的 scroll 事件是**合成的**（`new Event('scroll')` 打在真元素上，`bubbles:false`）：
    // 这里受审的是**注册旗标**（捕获相收不收得到后代元素上来的这根事件），不是 Chromium 到底在什么时刻发 scroll。
    // 为什么不用真滚动：面板形态那层 `overflow-y-auto` 不受高（`GroupTasksBoard.vue:1062` 的 `min-h-0 flex-1`
    // 挂在 `standalone` 上），实测 `scrollHeight-clientHeight = 0` 滚不动；而窗口形态（真实调用点
    // `GroupTodosWindow.vue:173`）在本探针里会先卡在 `todosLoadedOnce`（`:321`）⇒ 渲染空列表。
    // ⇒ 「用户真滚动列表时菜单收不收」仍然只在**真机清单**上，这条不许被读成真机验过了。
    // 判据读的是**菜单从 DOM 里被撤掉**（Reka 自己只会隐藏浮层，撤掉才说明跑的是我们的 closeRowMenu）。
    const openRowMenu = async () => {
      const hit = await cdp.eval(`(() => {
        const b = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
          .find((x) => x.getClientRects().length > 0);
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await sleep(450);
      return hit && (await cdp.eval(`!!document.querySelector('[role="menu"]')`));
    };
    const menuInDom = () => cdp.eval(`!!document.querySelector('[role="menu"]')`);

    const menuOpened = await openRowMenu();
    const host = await cdp.eval(`(() => {
      const row = document.querySelector('button.min-w-0.flex-1');
      const el = row && row.closest('div.overflow-y-auto');
      return { found: !!el, winY: window.scrollY };
    })()`);
    check("开局核对：行菜单打得开，且行**确实挂在一层 `overflow-y-auto` 里**（那才是 scroll 事件的来源元素），window 自己没滚",
      menuOpened === true && host.found === true && host.winY === 0,
      "菜单在 DOM 里 + closest 找得到滚动层 + window.scrollY=0", JSON.stringify({ menuOpened, host }));

    // 上一发这里读 `ev.composedPath()`，得到 false —— 那是**量具坏了**不是现象：派发结束后 composedPath() 已被清空。
    // 换成在 window 上临时挂一根**冒泡相**探针：它收不到 ⇒ 正面证明这根事件确实到不了 window 的冒泡相，
    // 而菜单照样被撤掉 ⇒ 收它的只能是组件那条带 capture 的 window 监听。
    const fired = await cdp.eval(`(() => {
      const row = document.querySelector('button.min-w-0.flex-1');
      const el = row.closest('div.overflow-y-auto');
      let bubSawIt = false;
      const probe = () => { bubSawIt = true; };
      window.addEventListener("scroll", probe, false);
      el.dispatchEvent(new Event("scroll", { bubbles: false, cancelable: false }));
      window.removeEventListener("scroll", probe, false);
      return { bubSawIt, winY: window.scrollY };
    })()`);
    await sleep(450);
    const menuStillThere = await menuInDom();
    check("从**行自己那层**发一根不冒泡的 scroll ⇒ window 的冒泡相探针收不到（bubSawIt=false，证明这根事件到不了冒泡相）"
      + " 而行菜单从 DOM 撤掉 ⇒ 收它的是组件那条带 capture 的 window 监听（摘掉 `true` 这条当场红）",
      fired.bubSawIt === false && fired.winY === 0 && menuStillThere === false,
      "冒泡相探针没收到 + window 没滚 + 菜单不在 DOM", JSON.stringify({ fired, menuStillThere }));

    const menuOpened2 = await openRowMenu();
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 620, deviceScaleFactor: 2, mobile: true });
    await sleep(800);
    const menuStillThere2 = await menuInDom();
    check("改视口尺寸（resize，这条**不需要** capture，走的是另一根监听）⇒ 同一个菜单也被撤掉："
      + "两条各管一面，一真一假这一对不许只做成一半",
      menuOpened2 === true && menuStillThere2 === false,
      "重开在 DOM 里 + 改尺寸后不在 DOM", JSON.stringify({ menuOpened2, menuStillThere2 }));

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    // 面板形态（移动端真实入口）：整页铺满 + 页面本身不滚，滚动只留给看板列表。
    const panelMounted = await cdp.eval("window.__probe.install('/src/components/GroupTasksPanel.vue', '', "
      + JSON.stringify(JSON.stringify({ open: true, groupId: "g1" })) + ")");
    await cdp.eval("window.__probe.todoBus(); window.__probe.todoRows(window.__TASKS); window.__probe.seedDevice('probe-me')");
    await sleep(900);
    const panel = await cdp.eval(`(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return { ok: false };
      const r = dlg.getBoundingClientRect();
      const styles = getComputedStyle(dlg);
      return {
        ok: true,
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        vw: innerWidth, vh: innerHeight,
        docScrollH: document.documentElement.scrollHeight,
        overflowY: styles.overflowY,
        rows: document.querySelectorAll('button.min-w-0.flex-1').length,
      };
    })()`);
    check("移动端群任务：面板整页铺满、页面不滚（列表自己滚），任务行仍在",
      panelMounted && panelMounted.ok === true && panel.ok === true
        && panel.w >= panel.vw - 1 && panel.h >= panel.vh - 1
        && panel.docScrollH <= panel.vh + 1 && panel.overflowY === "hidden" && panel.rows >= 2,
      "dialog=vw×vh + overflowY=hidden + 页面不滚 + rows>=2", JSON.stringify(panel));
    if (SHOT_PATH) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const p = SHOT_PATH.replace(/\.png$/, "-tasksmobile.png");
      fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
      console.log("  📷 移动端群任务取证帧 → " + p);
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
}

/**
 * 共享目录：Query 模式推广到第二个纯读面板，重点照「慢的 A 后到」与「下载归属」。
 */
async function runShareDirectory(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  await cdp.eval("window.__probe.shareBus()");
  const mounted = await cdp.eval("window.__probe.install('/src/components/ShareDirectory.vue', '', '')");
  await sleep(200);

  const info = () => cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return {
      dialog: !!dlg,
      text: dlg ? dlg.innerText : '',
      calls: window.__share.calls.slice(),
      downloads: window.__share.downloads.slice(),
      pending: Object.keys(window.__share.pending),
    };
  })()`);

  check("共享目录装得上（QueryClient 与 chat store 都在）",
    mounted && mounted.ok === true && (await info()).dialog === false,
    "mount ok / 关着不渲染", JSON.stringify(mounted));

  await cdp.eval("window.__probe.setConv('A')");
  await cdp.eval("window.__probe.setOpen(true)");
  await sleep(400);
  let s = await info();
  check("打开：只向当前好友请求一次，A 未返回前不显示别的树",
    s.dialog && s.calls.join(",") === "A" && !s.text.includes("b.txt"),
    "calls=[A] / 无 b.txt", JSON.stringify({ calls: s.calls, text: s.text.slice(0, 60) }));

  await cdp.eval("window.__probe.setConv('B')");
  await sleep(300);
  await cdp.eval("window.__probe.resolveShare('B', ['b.txt'])");
  await sleep(400);
  s = await info();
  check("切好友：新 key 拉 B 的树并渲染",
    s.calls.join(",") === "A,B" && s.text.includes("b.txt"),
    "calls=[A,B] / b.txt", JSON.stringify({ calls: s.calls, text: s.text.slice(0, 80) }));

  await cdp.eval("window.__probe.resolveShare('A', ['a.txt'])");
  await sleep(400);
  s = await info();
  check("A 的慢响应后到：不会覆盖当前显示的 B 的树",
    s.text.includes("b.txt") && !s.text.includes("a.txt"),
    "只有 b.txt", JSON.stringify({ text: s.text.slice(0, 80) }));

  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const name = dlg && dlg.querySelector('[title="b.txt"]');
    if (!name) return false;
    name.closest('div').querySelector('button').click();
    return true;
  })()`);
  await sleep(250);
  s = await info();
  check("下载归属来自树的快照：向 B 要 B 的文件",
    s.downloads.length === 1 && s.downloads[0][0] === "B" && s.downloads[0][1] === "B/b.txt",
    'downloads=[["B","B/b.txt"]]', JSON.stringify(s.downloads));

  await cdp.eval("window.__probe.setConv('A')");
  await sleep(350);
  s = await info();
  check("切回已缓存的好友：旧快照立刻可见，同时按 staleTime 0 重新请求",
    s.text.includes("a.txt") && s.calls.filter((x) => x === "A").length >= 2,
    "a.txt 在 / calls 里 A≥2", JSON.stringify({ calls: s.calls, text: s.text.slice(0, 80) }));
}

/**
 * 图片预览浮层的焦点语义（--only=lightbox）。
 *
 * 迁移前这里只有"打开时 focus 容器、关闭时手动 focus 回去"：Tab 会直接跑到背景页面
 * （不构成焦点陷阱），且关闭归还与卸载时机都由我们自己维护。现在 Tab 环、逃逸拉回、
 * 卸载归还都交给 Reka FocusScope —— 本段读的是真按键 / 真焦点，不是源码里有没有 import。
 */
/**
 * 消息右键：**有选区也必须归应用**（用户 2026-10-23：「有时候会把 web 的右键打开」）。
 *
 * 根因在 `shouldPreventContextMenu` 原先的「有选区一律放行」：选区不会因为右键而消失，
 * 只要之前双击选过词 / 拖选过正文，再右键气泡就会弹 WebKit 原生菜单，应用菜单根本不出现。
 * 这一段用**真右键**跑两条路径：气泡本体，以及群聊昵称行（它在消息行之外 —— 处理器若只挂在
 * 消息行上，这一格就会漏）。两条都要求：应用菜单出现 + 事件被 preventDefault。
 *
 * ⚠️ 默认窗口宽 754px 会落进移动端布局（`app.isMobile=true` ⇒ `openContextMenu` 提前 return），
 * 所以进段先切到 1100px 的桌面视口，并把「宽度 > 767」作为环境判据（不满足直接红，不是跳过）。
 */
async function runContextGuard(cdp, url) {
  /**
   * 桌面右键边界 + 选区复制 + 移动端原生选字分流（用户 2026-10-23 的两条产品决策）。
   *
   * 纪律：
   *  · 视口 / 触摸 / 媒体仿真都在 try/finally 里归还（参照 runNetCard 的写法）；
   *  · 视口断点从 `/src/utils/platform.ts` 现取，不抄 767；
   *  · 每条右键都用**真指针**，并用 window 捕获相记录真实命中的元素是不是在
   *    `[data-msg-col]` 里 —— 不能靠选择器名字推断边界；
   *  · 真机不可用的那部分（Android/iOS 原生选区手柄与系统复制菜单）只验到
   *    "应用没有拦 contextmenu / 没有同时开自定义面板"，报告里必须标 UNVERIFIED。
   *
   * 故障注入（只给本机验收收尾）：GOSSLAN_CTXGUARD_FAIL=check|throw。
   */
  const restoreWidth = await cdp.eval("window.innerWidth").catch(() => null);
  try {
    // ───────────────────────── 桌面视口 ─────────────────────────
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1100, height: 800, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1100, screenHeight: 800,
    });
    await cdp.send("Page.bringToFront").catch(() => {});
    // 复制断言需要真实的 clipboard 权限（VueUse 会先看 clipboard-write 的许可）。
    await cdp.send("Browser.grantPermissions", {
      origin: new URL(url).origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    }).catch(() => {});
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);

    // 断点从生产码现取；导入失败就让这一发红（不静默回落硬编码）。
    const env = await cdp.eval(`(async () => {
      const PL = await import('/src/utils/platform.ts');
      window.__platformProbe = PL;
      return {
        width: innerWidth,
        query: PL.NARROW_LAYOUT_QUERY,
        limit: PL.MOBILE_MAX_WIDTH_PX,
        narrow: matchMedia(PL.NARROW_LAYOUT_QUERY).matches,
      };
    })()`);
    console.log("  · 消息右键段环境：" + JSON.stringify(env));
    check("环境：右键段在桌面视口（宽度 > platform.MOBILE_MAX_WIDTH_PX，断点从生产码现取）",
      !!env && env.width > env.limit && env.narrow === false,
      "width > limit 且不是窄布局", JSON.stringify(env));

    const failMode = process.env.GOSSLAN_CTXGUARD_FAIL || "";
    if (failMode === "check") {
      check("故障注入：故意红一条（验收 finally 仍归还视口）", false, "红", "故障注入");
    }
    if (failMode === "throw") throw new Error("故障注入：ctxguard 主动抛错（验收 finally 仍归还视口）");

    // 命中记录：window 捕获相先于组件处理器，记下真实 target 属于哪个区域。
    await cdp.eval(`(() => {
      window.__ctxHit = null;
      window.addEventListener('contextmenu', (e) => {
        const el = e.target instanceof Element ? e.target : null;
        window.__ctxHit = {
          tag: el ? el.tagName : null,
          inCol: !!(el && el.closest('[data-msg-col]')),
          inReactionEntry: !!(el && el.closest('[data-reaction-entry]')),
          inAvatar: !!(el && el.closest('.gosslan-avatar-box')),
          inChip: !!(el && el.closest('[data-reaction-chip]')),
        };
      }, true);
      return true;
    })()`);

    // 文案从应用词典现取：探针页的 locale 可能是 en（全新 profile），不能手抄中文。
    const L = await cdp.eval(`(async () => {
      const I = await import('/src/i18n/index.ts');
      return { copySel: I.t('msg.copySelection'), copyMsg: I.t('msg.copyMessage') };
    })()`);
    check("非空转·文案：从应用词典现取到「复制选中内容 / 复制消息」两条且不同",
      !!L && !!L.copySel && !!L.copyMsg && L.copySel !== L.copyMsg,
      "两条文案", JSON.stringify(L));

    /**
     * 剪贴板探针 = **测试替身**：只记录应用交给 Clipboard API 的文本，不真的写系统剪贴板。
     *
     * 为什么不调原 API：长跑里窗口失焦时 `clipboard.write` 会挂住 renderer（本轮组合跑实测
     * 45s 无回包）；本仓 `useClipboard` 自己也没有失败信号（库里恒 true），真剪贴板写不写成功
     * 本来就不可断言。这里断言的是「应用要复制的那段文字」——正是"只复制选中内容"的契约。
     * 需要真剪贴板时另跑一次短程手工验证，不在全量探针里做。
     */
    const clipReady = await cdp.eval(`(() => {
      window.__copied = null;
      const c = navigator.clipboard;
      if (c && typeof c.write === 'function') {
        c.write = async (items) => {
          try {
            const item = items && items[0];
            if (item && item.types && item.types.indexOf('text/plain') >= 0) {
              const blob = await item.getType('text/plain');
              window.__copied = await blob.text();
            }
          } catch (_e) { /* 读不到就保持 null，让判据红 */ }
          return undefined;
        };
      }
      if (c && typeof c.writeText === 'function') {
        c.writeText = async (text) => { window.__copied = String(text); };
      }
      document.execCommand = (cmd) => {
        if (String(cmd).toLowerCase() === 'copy') {
          const ta = document.querySelector('textarea');
          if (ta) window.__copied = ta.value;
        }
        return true;
      };
      return !!(c && (typeof c.write === 'function' || typeof c.writeText === 'function'));
    })()`);
    check("环境：剪贴板 API 可用（探针只记录应用要写入的文本，不落系统剪贴板）",
      clipReady === true, "true", String(clipReady));

    const rectOf = (selector, index = 0) => cdp.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        left: +r.left.toFixed(1), right: +r.right.toFixed(1),
        top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        pointerEvents: getComputedStyle(el).pointerEvents,
        opacity: getComputedStyle(el).opacity,
      };
    })()`);
    const rightClickAt = async (p) => {
      if (!p) return false;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await sleep(30);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "right", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "right", clickCount: 1 });
      await sleep(300);
      return true;
    };
    const menuState = () => cdp.eval(`(() => {
      const el = document.querySelector('[role="menu"].gosslan-menu');
      return {
        open: !!el,
        items: el
          ? [...el.querySelectorAll('[role="menuitem"]')].map((n) => (n.innerText || '').trim())
          : [],
      };
    })()`);
    const hitState = () => cdp.eval("window.__ctxHit");
    const closeMenu = async () => {
      await cdp.key("Escape", "Escape", "", 27);
      await sleep(220);
      return !(await menuState()).open;
    };
    /**
     * 激活菜单项：用**键盘** Enter（与既有 ctxmenu 段同一条 Reka 路径）。
     * 纯 pointer / 元素 click() 在 Reka 菜单里会先被 DismissableLayer 收掉，
     * 表现为"菜单开了、动作没跑、__copied 还是上一次的值"（本轮实测踩过）。
     */
    const clickItem = async (label) => {
      // 与既有 ctxmenu 段同一条 Reka 键盘路径：↓ 走到目标条目再 Enter。
      // 直接 item.focus()+Enter 偶发不选中（焦点在了、菜单的 currentItem 没更新）⇒ 本轮实测踩过。
      const total = await cdp.eval(`document.querySelectorAll('[role="menu"] [role="menuitem"]').length`);
      if (!total) return false;
      let hit = false;
      for (let step = 0; step <= total; step += 1) {
        const active = await cdp.eval(`(() => {
          const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
          const a = document.activeElement;
          return {
            idx: items.indexOf(a),
            text: String((a && a.innerText) || '').trim(),
          };
        })()`);
        if (active && active.idx >= 0 && active.text.includes(label)) { hit = true; break; }
        await cdp.key("ArrowDown", "ArrowDown", "", 40);
        await sleep(70);
      }
      if (hit) {
        await cdp.key("Enter", "Enter", "\r", 13);
        await sleep(380);
      }
      // 动作如果没把菜单收掉，先 Esc 收干净：带着开着的 portal 去换宿主会把 renderer 卡死。
      if ((await menuState()).open) await closeMenu();
      return hit;
    };
    const copied = () => cdp.eval("window.__copied");
    const selectText = (mode) => cdp.eval(`(() => {
      const root = document.querySelector('#probe-host .gosslan-selectable');
      if (!root) return null;
      const sel = window.getSelection();
      const range = document.createRange();
      if (${JSON.stringify(mode)} === 'part') {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !(node.textContent || '').trim()) node = walker.nextNode();
        if (!node) return null;
        const n = Math.min(6, (node.textContent || '').length);
        range.setStart(node, 0);
        range.setEnd(node, n);
      } else {
        range.selectNodeContents(root);
      }
      sel.removeAllRanges();
      sel.addRange(range);
      const r = range.getBoundingClientRect();
      return { text: sel.toString(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    const clearSel = () => cdp.eval("window.getSelection().removeAllRanges(); 1");
    const mountOne = async (props) => {
      // 换宿主前必须收掉开着的菜单：带着 Reka portal 去 innerHTML='' 会把 renderer 卡死（本轮实测）。
      if ((await menuState()).open) await closeMenu();
      const r = await cdp.eval("window.__probe.install('/src/components/MessageItem.vue', '', "
        + JSON.stringify(JSON.stringify(props)) + ")");
      await sleep(420);
      return r;
    };

    // ── 1) 触发边界：正文 / 昵称 / 引用块开菜单；头像 / 表情区 / 行内空白不开 ──
    const boundaryProps = {
      message: {
        msg_id: "m-ctx-boundary", sender_id: "peer-a", kind: "text",
        content: "「引用 张三：原消息片段|msg-1」\n正文第一段，用于右键边界。",
        ts: 1700000000000, conv_id: "group:g1", seq: 1,
      },
      isGroup: true, senderName: "对方", canReact: true,
      reactions: [{ emoji: "[赞]", count: 2, mine: false, actors: ["peer-b"], latest: "peer-b" }],
    };
    const mounted = await mountOne(boundaryProps);
    const bubble = await rectOf("#probe-host .gosslan-bubble-text");
    const nick = await rectOf("#probe-host [data-msg-col] > div", 0);
    const quote = await rectOf("#probe-host .quote-text");
    const avatar = await rectOf("#probe-host .gosslan-avatar-box");
    const chip = await rectOf("#probe-host [data-reaction-chip]");
    const blankP = await cdp.eval(`(() => {
      const col = document.querySelector('#probe-host [data-msg-col]');
      if (!col) return null;
      const outer = col.parentElement;
      const r = outer.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      return { x: Math.round(r.right - 12), y: Math.round(c.top + c.height / 2), colRight: +c.right.toFixed(1), outerRight: +r.right.toFixed(1) };
    })()`);
    check("非空转·边界：群聊消息装上了，正文/昵称/引用块/头像/表情条/空白六个落点都量得到",
      !!mounted && mounted.ok === true && !!bubble && !!nick && !!quote && !!avatar && !!chip
        && !!blankP && blankP.x > blankP.colRight + 8,
      "六个落点 + 空白点在 data-msg-col 右侧", JSON.stringify({ mounted, bubble, nick, quote, avatar, chip, blankP }));

    const boundaryCases = [];
    for (const [label, point, expectMenu, expectInCol] of [
      ["正文", bubble, true, true],
      ["昵称", nick, true, true],
      ["引用内容", quote, true, true],
      ["头像", avatar, false, false],
      ["行内空白", blankP, false, false],
      ["表情回应胶囊", chip, false, false],
    ]) {
      if (!point) { boundaryCases.push([label, false, "落点没量到"]); continue; }
      await rightClickAt(point);
      const m = await menuState();
      const hit = await hitState();
      boundaryCases.push([label, m.open === expectMenu && hit && hit.inCol === expectInCol, { m, hit, point }]);
    }
    console.log("  · 右键边界实测：" + JSON.stringify(boundaryCases.map(([label, ok, detail]) => ({ label, ok, detail }))));
    for (const [label, ok, detail] of boundaryCases) {
      check("右键边界·" + label + "：" + (detail && detail.m && detail.m.open ? "弹消息菜单" : "不弹消息菜单")
        + "（真实命中在 data-msg-col " + (JSON.stringify(detail && detail.hit && detail.hit.inCol)) + "）",
        ok === true, "与预期一致", JSON.stringify(detail));
      if (detail && detail.m && detail.m.open) await closeMenu();
    }

    // 表情回应入口在列内（绝对定位），必须被显式排除；悬停后真右键，若悬停没生效则合成事件兜底。
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bubble.x, y: bubble.y });
    await sleep(260);
    const entry = await rectOf("#probe-host [data-reaction-entry]");
    let entryReal = false;
    if (entry && entry.pointerEvents !== "none" && entry.opacity !== "0") {
      await rightClickAt(entry);
      const m = await menuState();
      const hit = await hitState();
      entryReal = true;
      check("右键边界·表情回应入口（列内控件，真指针）：不弹消息菜单",
        m.open === false && hit && hit.inReactionEntry === true,
        "menu=false 且命中在 data-reaction-entry", JSON.stringify({ m, hit, entry }));
    } else {
      const r = await cdp.eval(`(() => {
        const el = document.querySelector('#probe-host [data-reaction-entry]');
        if (!el) return null;
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented };
      })()`);
      const m = await menuState();
      check("右键边界·表情回应入口（列内控件，合成事件兜底）：不弹消息菜单",
        !!r && m.open === false, "menu=false", JSON.stringify({ r, m, entry }));
    }
    console.log("  · 表情回应入口：" + JSON.stringify({ entry, entryReal }));

    // 菜单关闭回归：Esc + 外部点击。
    await rightClickAt(bubble);
    const escClosed = await closeMenu();
    check("右键菜单·Esc 关闭且 DOM 撤净", escClosed === true, "menu=false", JSON.stringify({ escClosed }));
    // 点外部关闭不在本段重复：统一外壳那条由既有 `--only=ctxmenu` 段负责（本段只测消息边界/复制）。

    // ── 2) 桌面选区复制：只复制选中文字；无选区不显示该入口；整条复制保留 ──
    const dmProps = {
      message: {
        msg_id: "m-ctx-select", sender_id: "peer-a", kind: "text",
        content: "前言三二一 这段文字用来测试选中复制。", ts: 1700000000000,
        conv_id: "dm:peer-a", seq: 1,
      },
      isGroup: false, senderName: "对方",
    };
    await mountOne(dmProps);
    const part = await selectText("part");
    check("非空转·选区：程序化选中了正文的一段（含少于整条的字符数）",
      !!part && part.text.length > 0 && part.text.length < dmProps.message.content.length,
      "0 < 选中长度 < 整条", JSON.stringify(part));
    await rightClickAt(part);
    const menuSel = await menuState();
    const hitSel = await hitState();
    check("选中文字后右键：菜单出现「复制选中内容」与「复制消息」，且事件被拦、命中在消息内容列",
      menuSel.open === true && menuSel.items.includes(L.copySel) && menuSel.items.includes(L.copyMsg)
        && hitSel && hitSel.inCol === true,
      "两个入口都在 + inCol=true", JSON.stringify({ menuSel, hitSel }));
    const copiedSel = await clickItem(L.copySel);
    const selValue = await copied();
    check("点「复制选中内容」：剪贴板里只有选中的那段，不是整条消息",
      copiedSel === true && selValue === part.text && selValue !== dmProps.message.content,
      "copied == 选中文本", JSON.stringify({ copiedSel, selValue, part: part && part.text }));

    await clearSel();
    const bubbleDm = await rectOf("#probe-host .gosslan-bubble-text");
    await rightClickAt(bubbleDm);
    const menuNoSel = await menuState();
    check("无有效选区：菜单不显示「复制选中内容」，但「复制消息」仍在",
      menuNoSel.open === true && !menuNoSel.items.includes(L.copySel) && menuNoSel.items.includes(L.copyMsg),
      "无选区入口 / 有整条入口", JSON.stringify(menuNoSel));
    const copiedMsg = await clickItem(L.copyMsg);
    const msgValue = await copied();
    check("无选区时「复制消息」仍复制整条内容",
      copiedMsg === true && msgValue === dmProps.message.content,
      "copied == 整条内容", JSON.stringify({ copiedMsg, msgValue }));

    // 选区在打开菜单后被清掉：点入口仍复制右键那一刻的快照。
    await mountOne(dmProps);
    const snap = await selectText("part");
    await rightClickAt(snap);
    await clearSel();
    const copiedSnap = await clickItem(L.copySel);
    const snapValue = await copied();
    check("打开菜单后选区被改写/清空：仍复制右键那一刻的快照（不读 live 选区）",
      copiedSnap === true && snapValue === snap.text,
      "copied == 右键时快照", JSON.stringify({ snapValue, snap: snap && snap.text }));

    // 跨节点选区（正文 + 链接 + 正文）：toString 仍是完整文本。
    const linkProps = {
      message: {
        msg_id: "m-ctx-link", sender_id: "peer-a", kind: "text",
        content: "开头 https://example.com 结尾", ts: 1700000000000, conv_id: "dm:peer-a", seq: 1,
      },
      isGroup: false, senderName: "对方",
    };
    await mountOne(linkProps);
    const all = await selectText("all");
    check("跨节点选区：正文+链接+正文都进了同一个 Range",
      !!all && all.text === linkProps.message.content,
      "选中文本 == 整条内容", JSON.stringify({ all, content: linkProps.message.content }));
    await rightClickAt(all);
    const copiedCross = await clickItem(L.copySel);
    const crossValue = await copied();
    check("跨节点选区复制：链接前后两段都在，不丢不重",
      copiedCross === true && crossValue === linkProps.message.content,
      "copied == 完整文本", JSON.stringify({ copiedCross, crossValue }));

    // ── 3) 连续右键不同消息：菜单上下文与选区归属不串 ──
    if ((await menuState()).open) await closeMenu();
    const pair = await cdp.eval("window.__probe.installMessages(" + JSON.stringify(JSON.stringify([
      {
        message: { msg_id: "m-ctx-a", sender_id: "peer-a", kind: "text", content: "第一条消息：右键我。", ts: 1700000000000, conv_id: "dm:peer-a", seq: 1 },
        isGroup: false, senderName: "对方",
      },
      {
        message: { msg_id: "m-ctx-b", sender_id: "peer-a", kind: "text", content: "第二条消息：也右键我。", ts: 1700000000001, conv_id: "dm:peer-a", seq: 2 },
        isGroup: false, senderName: "对方",
      },
    ])) + ")");
    await sleep(500);
    const cols = await cdp.eval(`(() => [...document.querySelectorAll('#probe-host [data-msg-col]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }))()`);
    check("非空转·两消息：同页挂上两条独立的 data-msg-col",
      !!pair && pair.ok === true && Array.isArray(cols) && cols.length === 2,
      "两条列", JSON.stringify({ pair, cols }));
    // A 里选中一段 → 右键 A：出现复制选中；关掉后选区留在 A。
    const aSel = await cdp.eval(`(() => {
      const root = document.querySelectorAll('#probe-host .gosslan-selectable')[0];
      if (!root) return null;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(root);
      sel.removeAllRanges(); sel.addRange(range);
      const r = range.getBoundingClientRect();
      return { text: sel.toString(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await rightClickAt(aSel);
    const menuA = await menuState();
    check("连续右键·消息 A：A 里有选区 ⇒ A 的菜单显示「复制选中内容」",
      menuA.open === true && menuA.items.includes(L.copySel),
      "A 菜单有选中入口", JSON.stringify(menuA));
    await closeMenu();
    // 不选 B，右键 B：B 的菜单里不应显示复制选中（选区在 A，和 B 不相交）。
    await rightClickAt(cols && cols[1]);
    const menuB1 = await menuState();
    check("连续右键·消息 B（选区仍在 A）：B 的菜单不显示「复制选中内容」",
      menuB1.open === true && !menuB1.items.includes(L.copySel) && menuB1.items.includes(L.copyMsg),
      "B 菜单无选中入口", JSON.stringify(menuB1));
    const copiedB = await clickItem(L.copyMsg);
    const bValue = await copied();
    check("连续右键·消息 B 的「复制消息」复制的是 B（上下文没有串到 A）",
      copiedB === true && bValue === "第二条消息：也右键我。",
      "copied == B 的内容", JSON.stringify({ bValue }));
    // 在 B 里选中 → 右键 B：出现复制选中，且复制的是 B 的那段。
    const bSel = await cdp.eval(`(() => {
      const root = document.querySelectorAll('#probe-host .gosslan-selectable')[1];
      if (!root) return null;
      const sel = window.getSelection();
      const range = document.createRange();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !(node.textContent || '').trim()) node = walker.nextNode();
      if (!node) return null;
      const n = Math.min(6, (node.textContent || '').length);
      range.setStart(node, 0);
      range.setEnd(node, n);
      sel.removeAllRanges(); sel.addRange(range);
      const r = range.getBoundingClientRect();
      return { text: sel.toString(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await rightClickAt(bSel);
    const copiedBSel = await clickItem(L.copySel);
    const bSelValue = await copied();
    check("连续右键·消息 B 选中后复制选中：结果是 B 的选区",
      copiedBSel === true && bSelValue === bSel.text && bSelValue !== bValue,
      "copied == B 选区", JSON.stringify({ bSelValue, bSelText: bSel && bSel.text, bValue }));

    // ───────────────────────── 移动端视口 ─────────────────────────
    await clearSel();
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
      screenWidth: 390, screenHeight: 844,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    await sleep(200);
    const mobileEnv = await cdp.eval(`(async () => {
      const PL = await import('/src/utils/platform.ts');
      const col = () => document.querySelector('#probe-host [data-msg-col]');
      return {
        width: innerWidth,
        narrow: matchMedia(PL.NARROW_LAYOUT_QUERY).matches,
        coarse: matchMedia('(pointer: coarse)').matches,
        hasCol: !!col(),
      };
    })()`);
    check("移动端环境：390×844 + 窄布局 + pointer: coarse",
      !!mobileEnv && mobileEnv.width === 390 && mobileEnv.narrow === true && mobileEnv.coarse === true,
      "390 / narrow=true / coarse=true", JSON.stringify(mobileEnv));

    const mobileProps = {
      message: {
        msg_id: "m-ctx-mobile", sender_id: "peer-a", kind: "text",
        content: "移动端正文：长按我应该进系统选字，不要弹自定义面板。",
        ts: 1700000000000, conv_id: "group:g1", seq: 1,
      },
      isGroup: true, senderName: "对方", canReact: false,
    };
    const m2 = await mountOne(mobileProps);
    const mBubble = await rectOf("#probe-host .gosslan-bubble-text");
    const mNick = await rectOf("#probe-host [data-msg-col] > div", 0);
    const cssState = await cdp.eval(`(() => {
      const col = document.querySelector('#probe-host [data-msg-col]');
      const text = document.querySelector('#probe-host .gosslan-selectable');
      return {
        colSelect: col ? getComputedStyle(col).userSelect : null,
        textSelect: text ? getComputedStyle(text).userSelect : null,
        textCallout: text ? (getComputedStyle(text).webkitTouchCallout || '') : null,
      };
    })()`);
    console.log("  · 移动端选字 CSS 实测：" + JSON.stringify(cssState));
    check("移动端 CSS：消息内容列不可选（长按昵称/卡片归自定义面板），正文层显式可选",
      !!m2 && m2.ok === true && cssState.colSelect === "none" && cssState.textSelect === "text",
      "col=none / text=text", JSON.stringify(cssState));

    const sheetState = () => cdp.eval(`(() => ({
      sheet: !!document.querySelector('.gosslan-dialog-sheet'),
      sheetText: (() => {
        const el = document.querySelector('.gosslan-dialog-sheet');
        return el ? (el.innerText || '').trim() : '';
      })(),
      menu: !!document.querySelector('[role="menu"].gosslan-menu'),
    }))()`);
    const touchStart = (p) => cdp.send("Input.dispatchTouchEvent",
      { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    const touchMove = (p, q) => cdp.send("Input.dispatchTouchEvent",
      { type: "touchMove", touchPoints: [{ x: q.x, y: q.y }] });
    const touchEnd = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const ctxEventOn = (selector) => cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented };
    })()`);

    // ① 长按正文：不起自定义面板；contextmenu 也放行（应用侧证据；系统菜单本身 Chrome 给不了）
    await touchStart(mBubble);
    await sleep(720);
    const holdText = await sheetState();
    // WebKit 可能把 contextmenu 的 target 从文本上提到气泡根：同一次触摸起点是正文 ⇒ 也要放行。
    const textCtxRoot = await ctxEventOn("#probe-host .gosslan-bubble-text");
    await touchEnd();
    await sleep(200);
    check("移动端·长按正文：**不弹** Gosslan 面板（长按留给系统原生选字）",
      holdText.sheet === false && holdText.menu === false,
      "sheet=false / menu=false", JSON.stringify(holdText));
    check("移动端·target 被 WebKit 上提到气泡根：仍放行 contextmenu（同一次触摸起点是正文）",
      !!textCtxRoot && textCtxRoot.prevented === false,
      "prevented=false", JSON.stringify(textCtxRoot));
    const textCtx = await ctxEventOn("#probe-host .gosslan-selectable");
    check("移动端·正文上的 contextmenu 默认行为被放行（不 preventDefault；系统复制菜单依赖它）",
      !!textCtx && textCtx.prevented === false,
      "prevented=false", JSON.stringify(textCtx));

    // ② 长按昵称（非正文）：弹自定义面板；contextmenu 被拦；系统菜单不与面板并存
    await touchStart(mNick);
    await sleep(720);
    const holdNick = await sheetState();
    const nickCtx = await ctxEventOn("#probe-host [data-msg-col] > div");
    const holdNickAgain = await sheetState();
    await touchEnd();
    await sleep(220);
    check("移动端·长按昵称（非正文）：弹 Gosslan 面板，不弹消息右键菜单",
      holdNick.sheet === true && holdNick.menu === false,
      "sheet=true / menu=false", JSON.stringify(holdNick));
    check("移动端·非正文 contextmenu：被拦截（避免系统菜单与自定义面板同时出现）",
      !!nickCtx && nickCtx.prevented === true && holdNickAgain.sheet === true && holdNickAgain.menu === false,
      "prevented=true / 面板仍在 / 无右键菜单", JSON.stringify({ nickCtx, holdNickAgain }));
    check("移动端·面板里没有自定义「复制选中内容」，整条「复制消息」仍在",
      holdNickAgain.sheetText.includes(L.copyMsg) && !holdNickAgain.sheetText.includes(L.copySel),
      "有复制消息 / 无复制选中", JSON.stringify({ sheetText: holdNickAgain.sheetText }));
    await cdp.key("Escape", "Escape", "", 27);
    await sleep(300);
    check("移动端·Esc 关闭面板", (await sheetState()).sheet === false, "sheet=false", "");

    // ③ 短按 / 滚动 / 已有选区：都不许误开面板
    await touchStart(mNick);
    await sleep(120);
    await touchEnd();
    await sleep(620);
    check("移动端·短按非正文：不弹面板", (await sheetState()).sheet === false, "sheet=false", "");
    await touchStart(mNick);
    await touchMove(mNick, { x: mNick.x, y: mNick.y + 40 });
    await sleep(720);
    const scrollState = await sheetState();
    await touchEnd();
    await sleep(200);
    check("移动端·在非正文上滑动（超过抖动容差）：不弹面板", scrollState.sheet === false,
      "sheet=false", JSON.stringify(scrollState));
    // 先按住再建立选区：模拟"选区手柄还在 / 已有选区"时长按非正文的时机。
    await touchStart(mNick);
    await sleep(120);
    const presetSel = await selectText("all");
    await sleep(620);
    const withSel = await sheetState();
    await touchEnd();
    await clearSel();
    check("移动端·已有选区（含拖动选区手柄的时机）：长按非正文也不叠第二个面板",
      !!presetSel && withSel.sheet === false, "sheet=false", JSON.stringify({ withSel, presetSel }));
  } finally {
    // 视口 / 触摸 / 媒体仿真必须归还；即使断言失败或执行抛错也走这里。
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await sleep(180);
    const restored = await cdp.eval("window.innerWidth").catch(() => null);
    check("ctxguard 收尾：视口指标已归还（后续段不再继承 390/1100 的临时视口）",
      restoreWidth !== null && restored === restoreWidth,
      `window.innerWidth 回到 ${restoreWidth}`, JSON.stringify({ restoreWidth, restored }));
  }
}

async function runLightbox(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval("window.__probe.lightboxMount()");
  await sleep(350);
  if (!mounted || mounted.ok !== true) {
    check("图片预览装得上（pinia 用的是页面那一份）", false, "mount ok", JSON.stringify(mounted));
    return;
  }
  const read = () => cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const ae = document.activeElement;
    const scope = dlg ? dlg.firstElementChild : null;
    const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
    const img = dlg ? dlg.querySelector('img') : null;
    // 预览样式的三个读数（用户 2026-10-23）：
    //  · imgRadius —— 预览图**不许切圆角**（完整展示）；
    //  · navBg/navShadow —— 左右切换键在**白图**上也要看得见 ⇒ 深色底 + 阴影。
    const navBtn = btns.find((b) => String(b.className).includes('h-11')) || null;
    const navCs = navBtn ? getComputedStyle(navBtn) : null;
    return {
      open: !!dlg,
      modal: dlg ? dlg.getAttribute('aria-modal') : null,
      buttons: btns.length,
      focusIndex: btns.indexOf(ae),
      focusInScope: !!(scope && ae && (scope === ae || scope.contains(ae))),
      focusIsScope: !!(scope && ae === scope),
      focusId: ae ? (ae.id || ae.tagName) : 'null',
      alt: img ? img.getAttribute('alt') : null,
      index: window.__lbState ? window.__lbState.index : -1,
      imgRadius: img ? getComputedStyle(img).borderTopLeftRadius : null,
      navBg: navCs ? navCs.backgroundColor : null,
      navShadow: navCs ? navCs.boxShadow : null,
    };
  })()`);

  let s = await read();
  check("打开后是 dialog + aria-modal，焦点被接进浮层容器（不是留在 opener 上）",
    s.open && s.modal === "true" && s.focusInScope && s.focusIsScope,
    "open / aria-modal=true / activeElement 是焦点容器",
    JSON.stringify(s));

  /*
   * 预览图不许切圆角 + 左右切换键在白图上也看得见（用户 2026-10-23）。
   * 量的是**计算样式**，不是类名：`rounded-*` 被删了但 `overflow-hidden` 还在、
   * 或者底色写成 white/10 这类"类名看着有、实际看不见"的写法，只有读计算值才抓得住。
   */
  const navAlpha = (() => {
    const m = /rgba?\(([^)]+)\)/.exec(s.navBg || "");
    if (!m) return null;
    const parts = m[1].split(",").map((x) => x.trim());
    return parts.length === 4 ? Number(parts[3]) : 1;
  })();
  console.log("  ℹ 预览样式读数 → " + JSON.stringify({
    imgRadius: s.imgRadius, navBg: s.navBg, navAlpha, navShadow: s.navShadow,
  }));
  check("图片预览：预览图不切圆角（完整展示）",
    s.imgRadius === "0px", "border-radius 0px", JSON.stringify({ imgRadius: s.imgRadius }));
  check("图片预览：左右切换键有足够深的底色 + 阴影（白图上不隐形）",
    typeof navAlpha === "number" && navAlpha >= 0.3
      && !!s.navShadow && s.navShadow !== "none",
    "底色 alpha>=0.3 且 box-shadow 不为 none",
    JSON.stringify({ navBg: s.navBg, navAlpha, navShadow: s.navShadow }));

  /*
   * 顶部让位**只许算一遍**（2026-10-20，用户报「移动端弹窗上方被刘海/状态栏压住」时
   * 顺出来的另一半缺陷）：外壳 `top` 已经让开自绘 caption，里面那层右上工具条又写了
   * `calc(var(--gosslan-window-safe-top) + env(safe-area-inset-top) + 1rem)` ⇒ 桌面
   * （env=0）工具条实际落在 **2×caption + 16px**，Win 上是 92px 而不是 54px。
   *
   * 量法（不用源码里"有没有读那个变量"当判据 —— 那种断言只会跟着注释走）：
   * 把 `--gosslan-window-safe-top` 钉成 44px（桌面 caption 的替身，env 在 Chrome 恒 0），
   * 读**外壳自己的 top** 与**工具条相对外壳的偏移**。工具条的 containing block 就是这层
   * fixed 外壳，所以"让位算两遍"会直接表现为 delta = 44 + 16 而不是 16。
   * ⚠️ 这一格买不到移动端的 `env(safe-area-inset-top)` 那一半 —— Chrome 里 env 恒 0，
   *    真机那半只有 iOS/Android 可证（§6.91 末尾的验证步骤）。
   */
  await cdp.eval(`(() => {
    document.documentElement.style.setProperty('--gosslan-window-safe-top', '44px');
    return getComputedStyle(document.documentElement).getPropertyValue('--gosslan-window-safe-top').trim();
  })()`);
  await sleep(120);
  const geo = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    const btns = [...dlg.querySelectorAll('button')];
    const bar = btns.length ? btns[0].parentElement : null;
    const d = dlg.getBoundingClientRect();
    const b = bar ? bar.getBoundingClientRect() : null;
    return {
      shellTop: +d.top.toFixed(1),
      barTop: b ? +b.top.toFixed(1) : null,
      delta: b ? +(b.top - d.top).toFixed(1) : null,
    };
  })()`);
  check("钉住 44px 让位后：外壳自己从 44px 起算（让位挂在外壳这一层，一处生效）",
    !!geo && geo.shellTop === 44, "shellTop=44", JSON.stringify(geo));
  check("右上工具条相对外壳只留 1rem（桌面把 caption 算两遍 ⇒ 这条红）",
    !!geo && geo.delta !== null && Math.abs(geo.delta - 16) <= 0.6,
    "delta≈16", JSON.stringify(geo));
  await cdp.eval(`(() => {
    document.documentElement.style.removeProperty('--gosslan-window-safe-top');
    return 1;
  })()`);

  await cdp.key("Tab", "Tab", "", 9);
  s = await read();
  check("Tab 从容器流到第一颗按钮（保存）",
    s.focusInScope && s.focusIndex === 0,
    "focusIndex=0", JSON.stringify(s));

  // 焦点陷阱的判据：从**最后一颗**按钮再按 Tab，必须回到第一颗；
  // 没有 FocusScope 时这里会离开浮层（落到背景页面 / 浏览器 chrome）。
  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
    if (btns.length) btns[btns.length - 1].focus();
    return btns.length;
  })()`);
  await cdp.key("Tab", "Tab", "", 9);
  s = await read();
  check("Tab 环：从最后一颗按钮再 Tab 回到第一颗（旧实现会逃出浮层）",
    s.focusInScope && s.focusIndex === 0,
    "focusInScope 且 focusIndex=0", JSON.stringify(s));

  // Shift+Tab 反向环：从第一颗回到最后一颗。
  await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
    if (btns.length) btns[0].focus();
    return btns.length;
  })()`);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 8,
  });
  await sleep(120);
  s = await read();
  check("Shift+Tab 反向环：从第一颗回到最后一颗",
    s.focusInScope && s.buttons > 1 && s.focusIndex === s.buttons - 1,
    "focusIndex=buttons-1", JSON.stringify(s));

  // trapped：程序化把焦点扔到背景按钮上，FocusScope 必须把它拉回来。
  await cdp.eval("document.getElementById('opener').focus()");
  await sleep(120);
  s = await read();
  check("焦点被程序化扔到背景后会被拉回浮层（trapped 生效，不只是 loop）",
    s.focusInScope === true,
    "focusInScope=true", JSON.stringify(s));

  // 业务键仍然归组件：ArrowRight 切到第二张。
  await cdp.key("ArrowRight", "ArrowRight", "", 39);
  await sleep(150);
  s = await read();
  check("ArrowRight 仍然切到下一张（业务按键没被焦点层接管）",
    s.index === 1 && s.alt === "two.gif",
    "index=1 / alt=two.gif", JSON.stringify(s));

  /*
   * 左右切换键的按下反馈与点击穿透（用户 2026-10-23：
   * 「按靠上的地方有可能会把这个图关掉」「点击反馈向下移太夸张了」「点的是图标不要穿透到遮罩」）。
   *
   * 根因：按钮自己挂 `-translate-y-1/2`，而全局 `button:active { transform: scale(.97) }`
   * 与它同优先级且在样式表更靠后 ⇒ 按下瞬间整颗按钮下移 22px（半个按钮高）。
   * 这里用**真指针按住不放**读矩形：中心不许动（只许绕中心缩小），顶边位移 <= 2px。
   * 然后在靠上的位置原位抬起：必须切到上一张且窗不关（旧实现 pointerup 已落到遮罩）。
   * 第二发把抬起扔到遮罩角落：click 会被派发到共同祖先（遮罩），按下源守卫必须拒绝关窗。
   */
  const navRect = () => cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const btns = dlg
      ? [...dlg.querySelectorAll('button')].filter((b) => String(b.className).includes('h-11'))
      : [];
    const b = btns[0];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return {
      left: +r.left.toFixed(2), top: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
      cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2),
    };
  })()`);
  const lightboxState = () => cdp.eval(`(() => ({
    open: !!document.querySelector('[role="dialog"]'),
    index: window.__lbState ? window.__lbState.index : -1,
    closes: (window.__probe.events || []).filter((e) => Array.isArray(e) && e[0] === 'close').length,
  }))()`);
  const navTransform = () => cdp.eval(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')]
      .find((x) => String(x.className).includes('h-11'));
    return b ? getComputedStyle(b).transform : null;
  })()`);

  const beforePress = await navRect();
  const pressX = beforePress ? Math.round(beforePress.cx) : 0;
  const pressY = beforePress ? Math.round(beforePress.top + 3) : 0;
  await cdp.send("Input.dispatchMouseEvent",
    { type: "mousePressed", x: pressX, y: pressY, button: "left", clickCount: 1 });
  await sleep(140);
  const whileHeld = await navRect();
  await cdp.send("Input.dispatchMouseEvent",
    { type: "mouseReleased", x: pressX, y: pressY, button: "left", clickCount: 1 });
  await sleep(220);
  const afterTopPress = await lightboxState();
  console.log("  ℹ 切换键按压实测 → " + JSON.stringify({ beforePress, whileHeld, afterTopPress }));
  check("左右切换键：按住时绕中心缩小（|中心位移|<=0.5px 且 |顶边位移|<=2px，不再整体下移）",
    !!beforePress && !!whileHeld
      && Math.abs(whileHeld.cy - beforePress.cy) <= 0.5
      && Math.abs(whileHeld.top - beforePress.top) <= 2,
    "中心不动 / 顶边位移 <= 2px", JSON.stringify({ beforePress, whileHeld }));
  // 正常模式的按压比例必须回到仓库统一的 0.97（组件自挂 0.95 会在这格露出来）。
  const pressRatio = beforePress && whileHeld ? +(whileHeld.w / beforePress.w).toFixed(3) : NaN;
  check("左右切换键：正常模式按压缩放走全局统一值 0.97（不是组件自挂的 0.95）",
    Math.abs(pressRatio - 0.97) <= 0.01, "w 比例 ≈ 0.97", JSON.stringify({ pressRatio, beforePress, whileHeld }));
  check("左右切换键：在靠上位置按下并原位抬起 ⇒ 切到上一张，窗不关（旧实现 click 落遮罩会关窗）",
    !!beforePress && afterTopPress.open === true && afterTopPress.closes === 0
      && afterTopPress.index === 0,
    "open=true / closes=0 / index=0", JSON.stringify(afterTopPress));

  const b2 = await navRect();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: b2 ? Math.round(b2.cx) : 0,
    y: b2 ? Math.round(b2.cy) : 0,
    button: "left", clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent",
    { type: "mouseReleased", x: 4, y: 4, button: "left", clickCount: 1 });
  await sleep(220);
  const afterEscapeToShade = await lightboxState();
  check("左右切换键：图标上按下、抬起落到遮罩 ⇒ 不许穿透关窗（按下源守卫）",
    afterEscapeToShade.open === true && afterEscapeToShade.closes === 0,
    "open=true / closes=0", JSON.stringify(afterEscapeToShade));

  /*
   * 减少动态效果（用户 2026-10-23 审查）：仓库统一的按压是全局 `button:active { scale(.97) }`，
   * 而 reduce 档用 `transform: none` 关掉它。组件自挂 `active:scale-95`（0,2,0）会压过
   * 那条零特异性规则 ⇒ reduce 用户仍看到缩放。这里真按住读计算值。
   */
  try {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await sleep(160);
    const reduceBefore = await navRect();
    const reduceIdle = await navTransform();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: reduceBefore ? Math.round(reduceBefore.cx) : 0,
      y: reduceBefore ? Math.round(reduceBefore.cy) : 0,
      button: "left", clickCount: 1,
    });
    await sleep(140);
    const reduceHeld = await navRect();
    const reduceHeldTransform = await navTransform();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: reduceBefore ? Math.round(reduceBefore.cx) : 0,
      y: reduceBefore ? Math.round(reduceBefore.cy) : 0,
      button: "left", clickCount: 1,
    });
    await sleep(160);
    console.log("  ℹ 减少动态效果按压 → " + JSON.stringify({
      reduceIdle, reduceHeldTransform, reduceBefore, reduceHeld,
    }));
    check("减少动态效果：按住时 transform=none 且尺寸/中心不变（不产生按压缩放）",
      reduceIdle === "none" && reduceHeldTransform === "none"
        && !!reduceBefore && !!reduceHeld
        && reduceHeld.w === reduceBefore.w && reduceHeld.h === reduceBefore.h
        && Math.abs(reduceHeld.cy - reduceBefore.cy) <= 0.5,
      "transform=none / w,h 不变 / 中心不动",
      JSON.stringify({ reduceIdle, reduceHeldTransform, reduceBefore, reduceHeld }));
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
    await sleep(120);
  }

  /*
   * 反向对照：给按钮临时注入一条 `:active { transform: translateY(10px) !important }`，
   * 按住时同一把尺子必须读到 > 2px。旧代码读到的正是 22px；这格证明「顶边位移」这个量
   * 真的跟着按压 transform 走，而不是恒 0 的空转判据。
   */
  const jumpBefore = await navRect();
  const jumpReady = await cdp.eval(`(() => {
    const st = document.createElement('style');
    st.id = 'probe-jump';
    st.textContent = 'button.probe-jump:active { transform: translateY(10px) !important; }';
    document.head.appendChild(st);
    const b = [...document.querySelectorAll('[role="dialog"] button')]
      .find((x) => String(x.className).includes('h-11'));
    if (!b) return false;
    b.classList.add('probe-jump');
    return true;
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: jumpBefore ? Math.round(jumpBefore.cx) : 0,
    y: jumpBefore ? Math.round(jumpBefore.cy) : 0,
    button: "left", clickCount: 1,
  });
  await sleep(140);
  const jumpHeld = await navRect();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: jumpBefore ? Math.round(jumpBefore.cx) : 0,
    y: jumpBefore ? Math.round(jumpBefore.cy) : 0,
    button: "left", clickCount: 1,
  });
  await cdp.eval(`(() => {
    document.getElementById('probe-jump')?.remove();
    document.querySelectorAll('button.probe-jump').forEach((b) => b.classList.remove('probe-jump'));
    return true;
  })()`);
  await sleep(120);
  const jumpDelta = jumpBefore && jumpHeld ? +(jumpHeld.top - jumpBefore.top).toFixed(2) : NaN;
  console.log("  · 反向对照·切换键位移：" + JSON.stringify({ jumpReady, jumpDelta, jumpBefore, jumpHeld }));
  check("反向对照·切换键位移量具：注入 10px 按压位移后同一把尺子读到 > 2px（判据不是恒绿）",
    jumpReady === true && jumpDelta > 2,
    "读到 > 2px", JSON.stringify({ jumpReady, jumpDelta }));

  // 关闭后焦点归还，DOM 撤净（leave 过渡 100ms）。
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(650);
  s = await read();
  const focusBack = await cdp.eval("document.activeElement && document.activeElement.id");
  check("Esc 关闭：浮层 DOM 撤净且焦点回到 opener（FocusScope 的卸载归还）",
    s.open === false && focusBack === "opener",
    "dialog=0 且 activeElement=#opener", JSON.stringify({ s, focusBack }));
}

/**
 * Toast HUD 那一段（--only=toast）。
 *
 * 迁移前是 store 里一个数组 + 每条一个 setTimeout：无上限、无去重、屏幕可能被叠满。
 * 现在数组/停留计时/堆叠/限流/live region 都归 Reka Toast，这里读真 DOM 与真按键：
 * 去重后只剩一条、超过 limit 的置 data-limited + inert 且不可见、Esc 按库默认收起 toast 栈
 * 且不吞按键、duration 到点自动移除（用 80ms 的短计时，不等 3/6 秒）。
 */
async function runToast(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval("window.__probe.install('/src/components/ToastHud.vue', '', '')");
  await sleep(300);
  await cdp.eval(`(async () => {
    const m = await import('/src/utils/toastManager.ts');
    window.__pushToast = m.pushToast;
    window.__toastManager = m.toastManager;
    return true;
  })()`);

  const read = () => cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll('li[data-status]')];
    const visible = nodes.filter((n) => n.getClientRects().length > 0);
    return {
      total: nodes.length,
      visible: visible.length,
      texts: visible.map((n) => String(n.textContent || '').trim()),
      statuses: visible.map((n) => n.getAttribute('data-status')),
      limited: nodes.filter((n) => n.hasAttribute('data-limited')).length,
      inertLimited: nodes.filter((n) => n.hasAttribute('data-limited')).every((n) => n.hasAttribute('inert')),
      alerts: document.querySelectorAll('[role="alert"]').length,
      viewport: !!document.querySelector('[role="region"][aria-label] ol'),
    };
  })()`);

  let s = await read();
  check("ToastHud 挂出 Reka 的 viewport（ol + aria-label），初始没有 toast",
    mounted && mounted.ok === true && s.viewport === true && s.total === 0,
    "viewport 存在 / total=0", JSON.stringify({ mounted, s }));

  await cdp.eval("window.__pushToast('重复失败', 'error'); window.__pushToast('重复失败', 'error')");
  await sleep(200);
  s = await read();
  check("同一 kind+文案连推两次只留一条（id 去重，不再叠两遍同一句失败）",
    s.visible === 1 && s.texts[0] === "重复失败" && s.statuses[0] === "error",
    "visible=1 / 重复失败 / error", JSON.stringify(s));
  check("失败提示有 live region（role=alert 的 announce 节点）",
    s.alerts >= 1, "role=alert >= 1", "alerts=" + s.alerts);

  // 一条一条推（每条之间留一帧）：Reka 的 stack 序号按**挂载顺序**分配，
  // 一次性批量插入会让 v-for 的挂载顺序与"最新在前"相反，limit 会藏错那一条。
  for (const text of ["信息一", "信息二", "信息三", "信息四"]) {
    await cdp.eval(`window.__pushToast(${JSON.stringify(text)}, 'info')`);
    await sleep(80);
  }
  await sleep(250);
  s = await read();
  check("超过 limit=3 的旧条目被置 data-limited 且 inert，并且真的不可见",
    s.visible === 3 && s.limited >= 1 && s.inertLimited === true && s.texts.includes("信息四"),
    "visible=3 / limited>=1 / inert / 最新一条在",
    JSON.stringify(s));

  // Esc 走 Reka 默认：关掉 toast 栈。这里真正要钉的回归是**不许 preventDefault** ——
  // Reka 的 ToastRoot 在 window 上监听 Escape，一旦在回调里 preventDefault，同一次按键就会被
  // 判定为"已被处理"，Dialog / Menu / Select 的 Esc 全部失效（--only=select 会因此变红）。
  await cdp.eval(`(() => {
    const b = document.createElement('button');
    b.id = 'toast-outside';
    b.textContent = '外面';
    document.body.appendChild(b);
    b.focus();
    window.__escPrevented = null;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.__escPrevented = e.defaultPrevented;
    });
    return true;
  })()`);
  const beforeEsc = s.visible;
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(500);
  s = await read();
  const escPrevented = await cdp.eval("window.__escPrevented");
  check("Esc 按库默认收起 toast 栈，且不吞按键（defaultPrevented=false）",
    beforeEsc === 3 && s.visible === 0 && escPrevented === false,
    "Esc 前 3 条 / 后 0 条 / 未被 preventDefault",
    JSON.stringify({ beforeEsc, s, escPrevented }));

  await cdp.eval("window.__toastManager.add({ id: 'short-lived', title: '短命', status: 'info', duration: 80, type: 'background', data: { kind: 'info' } })");
  await sleep(450);
  s = await read();
  check("duration 到点自动移除（80ms 的短计时，不靠肉眼等 3/6 秒）",
    s.texts.includes("短命") === false,
    "短命已移除", JSON.stringify(s));
}

/**
 * 设置页下拉（--only=select）。
 *
 * 5 处原生 <select> 已全部换成 Reka Select 的薄适配层；本段读真 DOM / 真鼠标 / 真按键：
 * 触发器文案、listbox/option 语义、当前项勾选、↓+Enter 选中后回写受控值、Esc 收起并归还焦点、
 * 鼠标点条目。另钉一条"组件 DOM 里不得再出现原生 select"——原生弹层在暗夜里由系统绘制，
 * 配色不归我们管（这正是这次迁移的起因）。
 */
async function runSelect(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mounted = await cdp.eval("window.__probe.selectMount()");
  await sleep(250);
  if (!mounted || mounted.ok !== true) {
    check("设置下拉装得上", false, "mount ok", JSON.stringify(mounted));
    return;
  }

  const read = () => cdp.eval(`(() => {
    const trigger = document.querySelector('#probe-host [role="combobox"]');
    const list = document.querySelector('[role="listbox"]');
    const opts = list ? [...list.querySelectorAll('[role="option"]')] : [];
    const active = document.activeElement;
    const activeOpt = active && active.closest ? active.closest('[role="option"]') : null;
    return {
      triggerText: trigger ? String(trigger.textContent || '').trim() : null,
      expanded: trigger ? trigger.getAttribute('aria-expanded') : null,
      ariaLabel: trigger ? trigger.getAttribute('aria-label') : null,
      activeIsTrigger: document.activeElement === trigger,
      activeOption: activeOpt ? String(activeOpt.textContent || '').trim().replace(/^✓\\s*/, '') : null,
      list: !!list,
      contentClass: list ? String(list.className || '') : '',
      optionCount: opts.length,
      labels: opts.map((o) => String(o.textContent || '').trim().replace(/^✓\\s*/, '')),
      checked: opts.filter((o) => o.getAttribute('data-state') === 'checked')
        .map((o) => String(o.textContent || '').trim().replace(/^✓\\s*/, '')),
      indicators: opts.filter((o) => o.querySelector('[data-state="checked"]')).length,
      nativeSelects: document.querySelectorAll('select').length,
      value: window.__st.selectValue,
      updates: window.__probe.events.filter((e) => e[0] === 'update').map((e) => e[1]),
    };
  })()`);

  let s = await read();
  check("受控下拉初始：combobox 有 aria-label、显示当前项、DOM 里没有原生 select",
    s.ariaLabel === "测试选择" && s.triggerText === "Beta" && s.expanded === "false" && s.nativeSelects === 0,
    "aria-label=测试选择 / 文案=Beta / 无原生 select",
    JSON.stringify(s));

  // 用键盘打开（a11y 用户实际走的路径）：Reka 的 trigger 在 ↓ 上打开并聚焦当前项。
  // 不用合成鼠标做键盘用例的前提：重载下 mouseup 的 click 会晚到并抢走焦点（真机不会），
  // 那会把"库的键盘导航坏了"和"探针时序"混成同一个红。
  await cdp.eval("(() => { const t = document.querySelector('#probe-host [role=\"combobox\"]'); t && t.focus(); return true; })()");
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await sleep(700);
  s = await read();
  check("键盘打开：listbox 3 项、当前项有勾选指示、焦点在 Beta、面板吃 .gosslan-menu",
    s.list && s.optionCount === 3 && s.labels.join(",") === "Alpha,Beta,Gamma"
      && s.checked.length === 1 && s.checked[0] === "Beta" && s.indicators === 1
      && s.contentClass.includes("gosslan-menu") && s.activeOption === "Beta",
    "3 项 / 选中 Beta / 1 个 ✓ / .gosslan-menu / 焦点 Beta",
    JSON.stringify(s));

  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await sleep(180);
  const afterDown = await read();
  await cdp.key("Enter", "Enter", "\r", 13);
  // 等退场动画彻底卸载：DismissableLayer 在关闭动画期间仍占着层级，
  // 过快重开会让旧的最高层吃掉 Esc（探针时距，不是产品行为）。
  await sleep(800);
  s = await read();
  check("键盘 ↓ 走到下一项、Enter 选中：受控值改成 c、触发器文案跟着变、面板收起、焦点回触发器",
    afterDown.activeOption === "Gamma"
      && s.value === "c" && s.triggerText === "Gamma" && s.list === false
      && s.expanded === "false" && s.activeIsTrigger,
    "↓ 后焦点 Gamma / value=c / Gamma / 收起 / 焦点回触发器",
    JSON.stringify({ s, afterDown }));
  check("选择只抬一个新值（v-model 仍是单一来源）",
    s.updates.join(",") === "c", "updates=[c]", JSON.stringify({ updates: s.updates }));

  await cdp.eval("(() => { const t = document.querySelector('#probe-host [role=\"combobox\"]'); t && t.focus(); return true; })()");
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await sleep(700);
  const reopened = await read();
  await cdp.eval(`(() => {
    window.__esc = [];
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.__esc.push([e.target.tagName, e.defaultPrevented]);
    });
    return { layers: document.querySelectorAll('[data-dismissable-layer]').length };
  })()`);
  await cdp.key("Escape", "Escape", "", 27);
  await sleep(600);
  s = await read();
  check("Esc 收起面板并把焦点还给触发器",
    reopened.list === true && s.list === false && s.activeIsTrigger,
    "打开后 Esc ⇒ 面板消失 + 焦点回触发器",
    JSON.stringify({ reopened: reopened.list, after: s }));

  const pt = await cdp.eval(`(() => {
    const r = document.querySelector('#probe-host [role="combobox"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp.click(pt.x, pt.y);
  await sleep(700);
  const mouseOpened = await read();
  const optPt = await cdp.eval(`(() => {
    const o = [...document.querySelectorAll('[role="option"]')]
      .find((n) => String(n.textContent || '').trim().includes('Alpha'));
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (optPt) {
    await cdp.click(optPt.x, optPt.y);
    await sleep(300);
  }
  s = await read();
  check("鼠标真点开、真命中条目也能选中（不是合成 click）",
    mouseOpened.list === true && !!optPt && s.value === "a" && s.triggerText === "Alpha" && s.list === false,
    "鼠标打开 / value=a / Alpha / 收起",
    JSON.stringify({ mouseOpened: mouseOpened.list, optPt, s }));
}

async function runNavIcon(cdp, url) {
  // 2026-10-22：导航图标已统一到 lucide（navIconPaths.ts 删除）。这里证明**渲染出来的 DOM**
  // 真的是 lucide 图标、选中态只由 stroke-width / data-active 驱动、四枚语义各自映射正确。
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const mount = async (props) => {
    await cdp.eval(
      `window.__probe.install('/src/components/ui/NavIcon.vue', '', ${JSON.stringify(JSON.stringify({ isolated: true, ...props }))})`,
    );
    await sleep(200);
  };
  const read = () => cdp.eval(`(() => {
    const svg = document.querySelector('#probe-host svg');
    if (!svg) return { present: false };
    const path = svg.querySelector('path');
    return {
      present: true,
      cls: svg.getAttribute('class') || '',
      stroke: svg.getAttribute('stroke'),
      strokeWidth: svg.getAttribute('stroke-width'),
      dataActive: svg.getAttribute('data-active'),
      ariaHidden: svg.getAttribute('aria-hidden'),
      viewBox: svg.getAttribute('viewBox'),
      dHead: path ? (path.getAttribute('d') || '').slice(0, 24) : '',
      sizeClass: svg.getAttribute('class') || '',
    };
  })()`);

  await mount({ name: "contacts", active: true });
  const contactsOn = await read();
  await mount({ name: "contacts", active: false });
  const contactsOff = await read();
  check("导航图标由 lucide 渲染（通讯录 = users-round）",
    contactsOn.present === true && /lucide-users-round-icon/.test(contactsOn.cls)
      && contactsOn.viewBox === "0 0 24 24" && contactsOn.ariaHidden === "true",
    "svg.lucide-users-round-icon / viewBox=0 0 24 24 / aria-hidden=true",
    JSON.stringify(contactsOn));
  check("选中态只加粗描边并落 data-active（不从描边库硬填成实心）",
    contactsOn.strokeWidth === "2.35" && contactsOn.dataActive === "true"
      && contactsOff.strokeWidth === "1.9" && contactsOff.dataActive === "false",
    "active: 2.35/true；inactive: 1.9/false",
    JSON.stringify({ on: contactsOn.strokeWidth + "/" + contactsOn.dataActive,
      off: contactsOff.strokeWidth + "/" + contactsOff.dataActive }));

  await mount({ name: "chats", active: true });
  const chats = await read();
  check("聊天语义映射到独立的 lucide 图标（不是抄通讯录的 path）",
    chats.present === true && /lucide-message-circle-icon/.test(chats.cls)
      && chats.dHead !== contactsOn.dHead,
    "lucide-message-circle-icon / path 与通讯录不同",
    JSON.stringify(chats));

  await mount({ name: "favorites", active: true, sizeClass: "h-[22px] w-[22px]" });
  const pc = await read();
  await mount({ name: "favorites", active: true, sizeClass: "h-16 w-16 opacity-25" });
  const mob = await read();
  check("同一语义在 PC 栏与移动端是同一只图标，只换尺寸档",
    pc.present === true && mob.present === true && /lucide-star-icon/.test(pc.cls)
      && pc.dHead === mob.dHead && pc.cls !== mob.cls,
    "lucide-star-icon / path 相同 / class 不同",
    JSON.stringify({ pcClass: pc.cls, mobClass: mob.cls }));

  await mount({ name: "links", active: true });
  const links = await read();
  check("链接语义映射到 lucide compass",
    links.present === true && /lucide-compass-icon/.test(links.cls),
    "lucide-compass-icon", JSON.stringify(links));

  // 唯一造型表还在、且恰好四枚：运行时不直接拿 path（lucide 是唯一来源），只对账键与导出形态。
  const table = await cdp.eval(`(async () => {
    const M = await import('/src/components/ui/navIcons.ts');
    return { keys: Object.keys(M.NAV_ICONS), kinds: Object.values(M.NAV_ICONS).map((v) => typeof v) };
  })()`);
  check("导航造型表仍是唯一入口且恰好四枚",
    table.keys.length === 4 && table.keys.every((k) => ["chats", "contacts", "favorites", "links"].includes(k))
      && table.kinds.every((k) => k === "object" || k === "function"),
    "navIcons.NAV_ICONS 恰有 4 键，值为组件",
    JSON.stringify(table));
}

async function runSegmented(cdp, url) {
  // 焦点模拟与 reaction 段同口径：RovingFocus 用 .focus() 移动，方向键要真的送到被聚焦项。
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    const mount = async (extra = {}) => {
      const props = {
        modelValue: "a",
        options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }, { value: "c", label: "丙" }],
        size: "sm",
        ariaLabel: "测试分段",
        ...extra,
      };
      await cdp.eval(
        `window.__probe.install('/src/components/ui/SegmentedControl.vue', '', ${JSON.stringify(JSON.stringify(props))})`,
      );
      await sleep(200);
    };
    const info = () => cdp.eval("window.__probe.segmentedInfo()");
    const events = () => cdp.eval("window.__probe.events");

    await mount();
    const s0 = await info();
    check("分段控件由 Reka 渲染成 radiogroup + 3 个 radio",
      s0.present === true && s0.items.length === 3 && s0.label === "测试分段",
      "radiogroup / 3 个 radio / aria-label", JSON.stringify(s0));
    check("RovingFocus 的 Tab 停靠点在整组上，组内 radio 初始都是 -1",
      s0.present === true && s0.groupTab === 0 && s0.items.every((x) => x.tab === -1),
      "groupTab=0 / 组内全 -1",
      JSON.stringify({ groupTab: s0.groupTab, tabs: s0.items.map((x) => x.tab) }));

    await cdp.eval("window.__probe.reset(); window.__probe.groupFocus()");
    await sleep(80);
    const sFocus = await info();
    check("Tab 进组后焦点落到当前选中项（不是停在组容器上）",
      sFocus.active.includes("甲"), "activeText 含甲", sFocus.active);
    // 真按键：keydown 与 keyup 之间留出一帧。RadioGroupItem 在 focus 的
    // setTimeout(0) 里按“方向键还按着”决定是否 click；同帧发 keyup 会把这次点击吃掉。
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "ArrowRight", code: "ArrowRight",
      windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
    });
    await sleep(80);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "ArrowRight", code: "ArrowRight",
      windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
    });
    await sleep(250);
    const ev1 = await events();
    const s1 = await info();
    check("→ 从选中项移到下一项并选中（emit update=b）",
      ev1.some((e) => e[0] === "update" && e[1] === "b"),
      "update=b", JSON.stringify(ev1));
    check("焦点真的落在第二项，且第二项成为新的 Tab 停靠点",
      s1.active.includes("乙") && s1.items[1].tab === 0,
      "activeText 含乙 / item1.tab=0",
      JSON.stringify({ active: s1.active, tabs: s1.items.map((x) => x.tab) }));

    await mount();
    await cdp.eval("window.__probe.reset()");
    const pt = await cdp.eval("window.__probe.radioPoint(2)");
    check("对照：拿得到第三颗分段的落点", !!pt && pt.x > 0 && pt.y > 0, "坐标 >0", JSON.stringify(pt));
    if (pt) {
      await cdp.click(pt.x, pt.y);
      await sleep(200);
      const ev2 = await events();
      check("点击第三项：emit update=c", ev2.some((e) => e[0] === "update" && e[1] === "c"),
        "update=c", JSON.stringify(ev2));
    }

    await mount({ disabled: true });
    await cdp.eval("window.__probe.reset()");
    const dpt = await cdp.eval("window.__probe.radioPoint(1)");
    if (dpt) await cdp.click(dpt.x, dpt.y);
    await sleep(200);
    const ev3 = await events();
    check("禁用态：点任何一项都不发 update", ev3.length === 0, "0 个事件", JSON.stringify(ev3));
  } finally {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

async function runSlider(cdp, url) {
  await cdp.send("Page.bringToFront").catch(() => {});
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    await cdp.send("Page.navigate", { url });
    await sleep(3_000);
    await cdp.eval(PAGE_FIXTURE);
    // setChatStyle 会落库并广播；探针只验交互，替掉这两条后端命令。
    await cdp.eval("window.__probe.stubApi('saveSettings', null)");
    await cdp.eval("window.__probe.stubApi('broadcastChatStyle', null)");
    const installed = await cdp.eval(
      "window.__probe.install('/src/components/settings/ChatStyleSection.vue', '')",
    );
    check("对照：字号设置段挂得起来（挂不上下面就是空跑）",
      !!installed && installed.ok === true, "install ok", JSON.stringify(installed));
    if (!installed || installed.ok !== true) return;
    await sleep(300);
    const info = () => cdp.eval("window.__probe.sliderInfo()");
    const s0 = await info();
    check("字号滑块由 Reka 渲染成 role=slider，带 aria-valuemin/max/now 与 valuetext",
      s0.present === true && s0.min === "0" && s0.max === "4" && s0.now === "2"
        && String(s0.text).includes("px"),
      "slider / 0..4 / now=2 / valuetext 含 px", JSON.stringify(s0));
    check("初始 store 字号就是 md（now=2 与业务值一致）",
      s0.present === true && s0.font === "md", "font=md", s0.font);

    await cdp.eval("window.__probe.sliderFocus()");
    await cdp.key("ArrowRight", "ArrowRight", "", 39);
    await sleep(150);
    const s1 = await info();
    check("→ 一档：aria-valuenow=3 且 store 字号跟着变",
      s1.now === "3" && s1.font !== "md", "now=3 / font 改变",
      JSON.stringify({ now: s1.now, font: s1.font }));

    await cdp.key("Home", "Home", "", 36);
    await sleep(150);
    const s2 = await info();
    check("Home 跳到最小档（0）", s2.now === "0", "now=0", s2.now);

    await cdp.key("End", "End", "", 35);
    await sleep(150);
    const s3 = await info();
    check("End 跳到最大档（4）", s3.now === "4", "now=4", s3.now);

    const pt = await cdp.eval(`(function () {
      const s = window.__probe.sliderInfo();
      if (!s.present || !s.root) return null;
      return { x: s.root.x + Math.round(s.root.w * 0.25), y: s.root.y + Math.round(s.root.h / 2) };
    })()`);
    check("对照：拿得到滑块轨道 25% 处的落点", !!pt && pt.x > 0 && pt.y > 0, "坐标 >0", JSON.stringify(pt));
    if (pt) {
      await cdp.click(pt.x, pt.y);
      await sleep(200);
      const s4 = await info();
      check("点击轨道 25%：就近吸附到第 1 档（0..4）", s4.now === "1", "now=1",
        JSON.stringify({ now: s4.now, font: s4.font }));
    }
  } finally {
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
  }
}

async function runTodoPick(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const props = {
    label: "类型",
    current: "需求",
    currentClass: "",
    modelValue: "requirement",
    options: [
      { value: "requirement", label: "需求" },
      { value: "bug", label: "缺陷" },
      { value: "custom", label: "自定义…" },
    ],
  };
  await cdp.eval(
    `window.__probe.install('/src/components/TodoPickField.vue', '', ${JSON.stringify(JSON.stringify(props))})`,
  );
  await sleep(200);
  const menu = () => cdp.eval("window.__probe.menu()");
  const events = () => cdp.eval("window.__probe.events");

  const pt = await cdp.eval("window.__probe.firstMenuTrigger()");
  check("对照：拿得到三选一字段的菜单入口（拿不到下面就是空跑）",
    !!pt && pt.x > 0 && pt.y > 0, "坐标 >0", JSON.stringify(pt));
  if (!pt) return;
  await cdp.click(pt.x, pt.y);
  await sleep(200);
  const m0 = await menu();
  check("点开三选一字段：3 条选项全部由 Reka 收进菜单集合",
    m0.present === true && m0.items.length === 3, "3 条 menuitem", JSON.stringify(m0.items));
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  const m1 = await menu();
  check("↓ 跳过禁用的当前项，高亮「缺陷」（键盘导航不是停在禁用项上）",
    m1.activeText.includes("缺陷"), "activeText=缺陷", m1.activeText);
  await cdp.eval("window.__probe.reset()");
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(200);
  const ev = await events();
  const gone = await menu();
  check("回车选中：emit update:modelValue=bug 且菜单收起",
    ev.some((e) => e[0] === "update" && e[1] === "bug") && gone.present === false,
    "update=bug + 菜单消失", JSON.stringify(ev));
}

async function runTaskCard(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  const TODO_ID = "todo-probe-1";
  const CID = "a".repeat(64);
  const payload = {
    todo_id: TODO_ID,
    title: "探针任务：把周报发出去",
    assignees: ["dev-other"],
    status: "todo",
    creator: "dev-me",
    deleted: false,
    description: "@小布 记得带上周报",
    images: [{ id: CID, name: "白板照片.jpg", size: 2048, sha256: CID, subtype: "image" }],
    archived: false,
    done_at: null,
  };
  const MSG = JSON.stringify({
    msg_id: "m-probe-1", sender_id: "dev-me", kind: "todo",
    content: JSON.stringify(payload), ts: 1700000000000,
  });
  // #116 用的第二份：描述长到必然超过那个框的三行 ⇒ 能证明"这层确实在裁"
  const MSG_LONG = JSON.stringify({
    msg_id: "m-probe-clip", sender_id: "dev-me", kind: "todo",
    content: JSON.stringify({ ...payload, description: "@小布 " + "补齐到四行之多的填充文字。".repeat(24) }),
    ts: 1700000000000,
  });
  // 自己视角的标签从 i18n 取，不在这里抄「@你」字面量（本仓刚给这条加了禁令）
  const labels = await cdp.eval(`(async () => {
    const u = await import('/src/utils/todos.ts');
    const i = await import('/src/i18n');
    return { todo: i.t(u.TODO_STATUS_LABEL_KEY.todo), done: i.t(u.TODO_STATUS_LABEL_KEY.done),
      selfTag: i.t('mention.self') };
  })()`);

  const mount = async (props) => {
    await cdp.eval(`window.__probe.install('/src/components/TodoCardBubble.vue', '', ${JSON.stringify(JSON.stringify(props))})`);
    await sleep(1_200); // 缩略图那一族是"字节后到"的：先 mount 再等一次取字节的 promise
  };
  const text = () => cdp.eval("window.__probe.text()");

  // —— 先按"对端视角"挂一次（没有 self 标签、没有实时状态表）——
  await cdp.eval(`window.__probe.stubApi('readContentPreview', [137,80,78,71,13,10,26,10])`);
  await mount({
    message: JSON.parse(MSG),
    mentionNames: ["小布", "我"],
    selfMention: null,
  });
  const t0 = await text();
  check("卡片渲染出这条任务的标题（用户报的是「看不见」，那就先判标题真在 DOM 里）",
    t0.includes("把周报发出去"), "含标题", t0.slice(0, 80));
  check("卡片不许把载荷当原始 JSON 画出来（内部字段名一个都不该露出）",
    !t0.includes("todo_id") && !t0.includes("done_at"), "不出现内部字段名", t0.slice(0, 80));
  check("状态胶囊显示载荷快照那一档（没传实时表 ⇒ 退回创建时）",
    t0.includes(labels.todo) && !t0.includes(labels.done), labels.todo, t0.slice(0, 80));
  check("对端视角里 @ 到的名字仍是原文（不是「@你」）",
    t0.includes("@小布") && !t0.includes(labels.selfTag), "@小布", t0.slice(0, 80));

  // —— 同一个数据换"我自己"的视角：同一段文本必须换标签 ——
  await mount({
    message: JSON.parse(MSG),
    mentionNames: ["小布", "我"],
    selfMention: { name: "小布", label: labels.selfTag },
  });
  const t1 = await text();
  const selfEls = await cdp.eval(`document.querySelectorAll('.mention-token--self').length`);
  check("换成我的视角：同一段 @ 渲染成 i18n 里那个自我标签（§9 的运行时那一半）",
    t1.includes(labels.selfTag) && selfEls === 1, "标签出现且 --self 恰好 1 个",
    `${JSON.stringify(t1.slice(0, 60))} / --self=${selfEls}`);

  // —— #116：描述里的 @ 高亮会不会被那层 `max-h + overflow-hidden` 裁一半 ——
  // ⚠️ 只钉「高亮完整可见」会变成恒真（这层根本没裁的时候它也成立）⇒ 必须配一条
  //    「裁切机制确实活着」的对照（③），两者同时成立才算判到了风险本身。
  await mount({
    message: JSON.parse(MSG), mentionNames: ["小布", "我"],
    selfMention: { name: "小布", label: labels.selfTag },
  });
  const clip = await cdp.eval("window.__probe.mentionClip()");
  const lhPx = Number(String(clip.lineHeight).replace(/[^0-9.]/g, "")) || 0;
  check("描述里那枚 @ 高亮完整落在裁切框内（上缘与下缘都不被切）",
    clip.tokTop >= clip.boxTop - 1 && clip.tokBottom <= clip.boxBottom + 1,
    "token 上下缘都在框内", `tok=${clip.tokTop}..${clip.tokBottom} box=${clip.boxTop}..${clip.boxBottom}`);
  check("高亮没把行盒撑破（token 高 ≤ computed line-height × 1.05；行高由样式现读不写死）",
    lhPx > 0 && clip.tokH <= lhPx * 1.05, `≤ ${(lhPx * 1.05).toFixed(2)}（行高 ${clip.lineHeight}）`,
    `${clip.tokH} / fontSize=${clip.fontSize}`);
  const longDesc = await (async () => {
    await mount({
      message: JSON.parse(MSG_LONG), mentionNames: ["小布", "我"],
      selfMention: { name: "小布", label: labels.selfTag },
    });
    return cdp.eval("window.__probe.mentionClip()");
  })();
  check("对照：把描述写到 4 行 ⇒ 那个框确实在裁（scrollHeight > clientHeight）—— 证明上面两条不是恒真",
    longDesc.scrollH > longDesc.clientH, "scrollHeight > clientHeight",
    `${longDesc.scrollH} > ${longDesc.clientH}? 高亮=${longDesc.tokH}px 行高=${longDesc.lineHeight}`);

  // —— 实时状态表那一环（#23：载荷是创建时快照，卡片必须查父层那张表）——
  // 同一张表现在还管着编号：类型字母由**当前**类型现推（用户 2026-09-30 规则 3），
  // 而"超过 4 位只显后四位 + 全码要能查到"（规则 5/6）只有真渲染出来才量得动。
  await mount({
    message: JSON.parse(MSG),
    mentionNames: ["小布"],
    selfMention: null,
    liveTodoPairs: [[TODO_ID, "done", "bug", 12345]],
  });
  const t2 = await text();
  check("传了实时表说这条已完成 ⇒ 胶囊换成已完成（查不到才退回快照，查到就不许再显示旧值）",
    t2.includes(labels.done) && !t2.includes(labels.todo), labels.done, t2.slice(0, 80));
  const codeCell = await cdp.eval("window.__probe.el('.font-mono')");
  const cText = codeCell ? codeCell.text : "";
  const cTitle = codeCell ? String(codeCell.title || "") : "";
  const cAria = codeCell ? String(codeCell.aria || "") : "";
  check("编号那格的字母来自**实时表里的当前类型**（夹具的创建快照既没类型也没号 ⇒ 不查表一个字都出不来）",
    cText === "B2345", "可见文本 B2345", JSON.stringify(codeCell));
  check("五位数字 ⇒ 可见只有后四位，而 title 与 aria 都带完整编号 B12345（短码不许被当成全码）",
    cTitle.includes("B12345") && cAria.includes("B12345") && !cText.includes("12345"),
    "title/aria 含 B12345、可见文本不含", JSON.stringify(codeCell));

  // 反面对照：不传实时表 ⇒ 卡片只剩那份"既没类型也没号"的创建快照，那一格必须整个不出现。
  // 少了这一条，上面两句就成了探针自己造出来的号。
  await mount({ message: JSON.parse(MSG), mentionNames: ["小布"], selfMention: null });
  const codeOff = await cdp.eval("window.__probe.el('.font-mono')");
  check("对照：不传实时表 ⇒ 那格没有任何补出来的号（宁可空白，也不按顺序数一个会随集合漂移的号）",
    codeOff === null, "找不到 .font-mono", JSON.stringify(codeOff));

  // —— 键盘可达 + 按 Enter 真的开了那份统一预览 ——
  await mount({
    message: JSON.parse(MSG),
    mentionNames: ["小布"],
    selfMention: null,
    liveTodoPairs: [[TODO_ID, "done", "bug", 12345]],
  });
  const thumb = await cdp.eval(`window.__probe.el('[role="button"]')`);
  check("卡片里的缩略图是键盘可达的（role=button + tabindex=0 + 有可访问名）",
    !!thumb && thumb.tabindex === "0" && !!thumb.aria, "role=button/tabindex=0/aria-label",
    JSON.stringify(thumb));
  const focused = await cdp.eval("window.__probe.focusThumb()");
  await cdp.eval("window.__probe.reset()");
  await cdp.key("Enter", "Enter", "\r", 13);
  const pv = await cdp.eval("window.__probe.previewState()");
  check("焦点在缩略图上按 Enter：统一预览 store 被打开，且来源标记是这张卡的 task-card:<todoId>",
    focused === true && pv.open === true && pv.source === "task-card:" + TODO_ID
    && pv.n === 1 && pv.index === 0,
    "open=true source=task-card:" + TODO_ID + " n=1 index=0", JSON.stringify(pv));

  // —— #116：@ 色块落在**最后一行可见行**时，会不会被卡片那段固定行高的裁切盒削掉 ——
  // `.mention-token` 有上下各 1px 内衬（`style.css`），而任务卡描述是 `max-h-[4.2em] overflow-hidden`。
  // 判的是矩形，不是肉眼：色块底边越过裁切盒 = 削。
  const clipMsg = JSON.parse(MSG);
  clipMsg.content = JSON.stringify({
    ...JSON.parse(clipMsg.content),
    description: "第一行 @小布\n第二行\n第三行结尾 @小布",
  });
  await mount({
    message: clipMsg,
    mentionNames: ["小布"],
    selfMention: { name: "小布", label: labels.selfTag },
  });
  const geo = await cdp.eval(`(() => {
    const toks = document.querySelectorAll('.mention-token--self');
    const last = toks[toks.length - 1];
    if (!last) return { found: false };
    const box = last.closest('p');
    if (!box) return { found: false, reason: '色块不在 <p> 里' };
    const t = last.getBoundingClientRect(), b = box.getBoundingClientRect();
    return { found: true, count: toks.length,
      bottomOver: +(t.bottom - b.bottom).toFixed(1), topUnder: +(b.top - t.top).toFixed(1),
      boxH: +b.height.toFixed(1), tokH: +t.height.toFixed(1),
      clipped: box.scrollHeight > box.clientHeight + 1 };
  })()`);
  check("#116：描述裁切盒落在整行上（最后一行的 @ 色块不被削半截；色块自带上下各 1px 内衬 ⇒ 容差 1px）",
    geo.found === true && geo.bottomOver <= 1 && geo.topUnder <= 1,
    "bottomOver<=1 且 topUnder<=1", JSON.stringify(geo));

  // —— 点「查看任务」必须带**这条**的 id（带错/带空就是开别人的任务）——
  await cdp.eval("window.__probe.reset()");
  const clicked = await cdp.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns[btns.length - 1];
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const ev = await cdp.eval("window.__probe.events");
  const opened = ev.filter((e) => e[0] === "open-id").map((e) => e[1]);
  check("卡片底部那个入口 emit 的是**这条**的 todo_id（不是 undefined、也不是别条）",
    clicked === true && opened.length === 1 && opened[0] === TODO_ID,
    "1 次 open 且带 " + TODO_ID, JSON.stringify(ev));

  // —— 三个命中区互不干扰（本轮修复）：主体开面板 / 底部开这条详情 / 图片只开预览 ——
  // 重新挂一份带实时状态的卡（上面那步的事件已清空）
  await mount({
    message: JSON.parse(MSG),
    mentionNames: ["小布"],
    selfMention: null,
    liveTodoPairs: [[TODO_ID, "doing", "task", 7]],
  });

  // 区①：点主体（标题所在的 role=button 区域，注意卡片里还有图片缩略图也是 role=button，
  // 用「包着编号 .font-mono 的那个」精确取主体，不许靠 document.querySelector 取到第一个）
  await cdp.eval("window.__probe.reset()");
  const bodyClick = await cdp.eval(`(() => {
    const mono = document.querySelector('.font-mono');
    const region = mono && mono.closest('[role="button"][tabindex="0"]');
    if (!region) return { ok: false, why: '找不到主体命中区' };
    // 点的是内部标题 span（事件 target 是后代），验证处理器不在按钮上而在整块主体上
    const title = region.querySelector('.truncate');
    (title || region).click();
    return { ok: true };
  })()`);
  let ev2 = await cdp.eval("window.__probe.events");
  let panel = ev2.filter((e) => e[0] === "open-panel").length;
  let detail = ev2.filter((e) => e[0] === "open-id").length;
  check("点卡片主体：只 emit open-panel（打开面板），不直达任何一条详情",
    bodyClick.ok === true && panel === 1 && detail === 0,
    "open-panel×1 / open-id×0", JSON.stringify(ev2));

  // 区①键盘：聚焦主体后 Enter 与 Space 都开面板（且 Space 不滚页）
  await cdp.eval("window.__probe.reset()");
  const kb1 = await cdp.eval(`(() => {
    const mono = document.querySelector('.font-mono');
    const region = mono && mono.closest('[role="button"][tabindex="0"]');
    if (!region) return false;
    region.focus();
    return document.activeElement === region;
  })()`);
  await cdp.key("Enter", "Enter", "\r", 13);
  await cdp.key(" ", "Space", " ", 32);
  const evK = await cdp.eval("window.__probe.events");
  check("键盘焦点在卡片主体：Enter 与 Space 各打开一次面板（鼠标/触摸/键盘三入口不冲突）",
    kb1 === true && evK.filter((e) => e[0] === "open-panel").length === 2
      && evK.filter((e) => e[0] === "open-id").length === 0,
    "open-panel×2", JSON.stringify(evK));

  // 区③：点图片缩略图 —— 只开统一预览，open-panel / open-id 一个都不许有
  await cdp.eval("window.__probe.reset()");
  const imgClick = await cdp.eval(`(() => {
    // 缩略图是 80×80 那块（含 h-20 w-20），主体命中区里没有这个尺寸类
    const t = Array.from(document.querySelectorAll('[role="button"]'))
      .find((el) => el.classList.contains('h-20'));
    if (!t) return { ok: false, why: '找不到缩略图' };
    t.click();
    return { ok: true };
  })()`);
  const pv2 = await cdp.eval("window.__probe.previewState()");
  const ev3 = await cdp.eval("window.__probe.events");
  check("点卡片图片：只打开统一预览（冒泡被图片区截断，不顺路开面板/详情）",
    imgClick.ok === true && pv2.open === true && pv2.source === "task-card:" + TODO_ID
      && ev3.filter((e) => e[0] === "open-panel" || e[0] === "open-id").length === 0,
    "预览开且无开面板事件", JSON.stringify({ pv: pv2, ev: ev3 }));

  // 区③的**另一半**（用户 2026-10-12 原话：「点图片的周围那些区域 点击事件应该是展开任务列表」）。
  // 上面那条只证了"点缩略图不顺路开面板"；"点空白那一圈要开面板"此前**没有任何正向断言** ——
  // 只有源码侧 ㊲ 那条"容器不许挂 @click.stop"的形状禁令。禁令在、正向行为坏了照样绿，
  // 而 2026-10-12 那个缺陷恰好就是这个形状（容器一 stop，整条图片带不再冒泡）。
  // 派发目标取图片带容器本身：事件的 target 是那一层 div，不是任何缩略图 ⇒
  // 这正好是"缩略图之间的空隙 / px-3 内边距 / 右侧留白"的等价形状，冒泡必须一路通到命中区①。
  await cdp.eval("window.__probe.reset()");
  const bandClick = await cdp.eval(`(() => {
    const t = Array.from(document.querySelectorAll('[role="button"].h-20'))[0];
    const band = t ? t.parentElement : null;
    if (!band) return { ok: false, why: '找不到图片带容器' };
    band.click();
    return { ok: true };
  })()`);
  const evBand = await cdp.eval("window.__probe.events");
  check("点图片带里空白那一圈（target=容器本身）：必须展开任务面板，且不多发 open-id",
    bandClick.ok === true && evBand.filter((e) => e[0] === "open-panel").length === 1
      && evBand.filter((e) => e[0] === "open-id").length === 0,
    "open-panel×1 / open-id×0", JSON.stringify({ bandClick, ev: evBand }));

  // 区③键盘（回归保护）：缩略图 Enter 同样只开预览
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.focusThumb()");
  await cdp.key("Enter", "Enter", "\r", 13);
  const pv3 = await cdp.eval("window.__probe.previewState()");
  const ev4 = await cdp.eval("window.__probe.events");
  check("键盘在缩略图上按 Enter：只开预览，不触发主体的 open-panel（两区域键盘处理互不串线）",
    pv3.open === true && ev4.filter((e) => e[0] === "open-panel" || e[0] === "open-id").length === 0,
    "仅预览", JSON.stringify({ pv: pv3, ev: ev4 }));

  // 区①里的链接：描述含真 URL 时，点链接不许顺手弹面板（链接走外部打开；插件在探针里
  // 调不起来会被组件自己 catch，我们只断言"没有面板事件"）。注意本仓的链接是无 href 的
  // <a>（点击统一走 opener，MessageLinkText 全仓同一形状）⇒ 用描述里的 a 来认。
  const linkMsg = JSON.parse(MSG);
  linkMsg.content = JSON.stringify({ ...payload, description: "看这个 https://example.com/spec 就好" });
  await mount({ message: linkMsg, mentionNames: ["小布"], selfMention: null });
  await cdp.eval("window.__probe.reset()");
  const linkClick = await cdp.eval(`(async () => {
    const a = document.querySelector('p a');
    if (!a) return { ok: false, why: '描述里的链接没渲染成 a' };
    a.click();
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true };
  })()`);
  const ev5 = await cdp.eval("window.__probe.events");
  check("描述里的 URL 链接点击不被主体拦截（只走链接，不弹任务面板/详情）",
    linkClick.ok === true
      && ev5.filter((e) => e[0] === "open-panel" || e[0] === "open-id").length === 0,
    "无面板事件", JSON.stringify(linkClick) + " " + JSON.stringify(ev5));

  // —— 图片超过上限 ⇒ 只画前几张 + 出「查看更多」，且它表现得和「查看任务」一模一样 ——
  // 用户 2026-10-12：任务卡片图多到 10 张时堆满卡面；点「查看更多」要像「查看任务」那样
  // 打开列表并直达这条任务。上限的唯一家在 utils/todos.ts，这里**现读**不写死。
  const LIMIT = await cdp.eval(`(async () => {
    const u = await import('/src/utils/todos.ts');
    return u.TODO_CARD_IMAGE_VISIBLE;
  })()`);
  const mkImages = (n, cidBase) =>
    Array.from({ length: n }, (_, i) => ({
      id: cidBase + i, name: `图${i}.jpg`, size: 2048,
      sha256: (cidBase + i).repeat(Math.ceil(64 / (cidBase + i).length)).slice(0, 64),
      subtype: "image",
    }));

  const moreLabel = await cdp.eval(`(async () => {
    const i = await import('/src/i18n');
    return i.t('todo.viewMoreImages');
  })()`);

  // 缩略图的形状锚点：`TodoImageThumb` 根节点 = `role=button` + `h-20 w-20`（80×80）。
  // ⚠️ 这里**不许**改用"某个 role=button 祖先的 children"去数：卡片主体（命中区①）自己也是
  //   `role=button`，那样数出来恒为 1，量的是主体不是缩略图 —— 2026-10-12 那一版探针正是这么
  //   把"只画 4 张"读成"只画 1 张"的（判据红得像是产品缺陷，实际是尺子读错了对象）。
  const MEASURE = `(() => {
    const thumbs = Array.from(document.querySelectorAll('[role="button"].h-20'));
    const band = thumbs.length ? thumbs[0].parentElement : null;
    // 卡片根 = 挂进 #probe-host 的那个元素（TodoCardBubble 的模板根就是一个 div）。
    // ⚠️ 这里原来借 .bubble-tail 的 closest('div') 定位卡片，而尖角现在是父层
    //   （MessageItem 用 :tail="!isGroup" 透传）控制的 prop ⇒ 本段**单独挂组件**时永远没有
    //   尖角，锚点读空、cardH 恒 -1，两条高度判据一起红（看着像产品把卡片撑坏了）。
    //   量具不许寄生在被测形状上，改成量挂载根。
    //   （注释里不能出现反引号：这一整块是 JS 模板字符串，反引号会当场截断它。）
    const host = document.getElementById('probe-host');
    const card = host ? host.firstElementChild : null;
    const label = ${JSON.stringify(moreLabel)};
    const more = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').trim().startsWith(label));
    return {
      rendered: thumbs.length,
      bandH: band ? +band.getBoundingClientRect().height.toFixed(1) : -1,
      moreH: more ? +more.getBoundingClientRect().height.toFixed(1) : 0,
      cardH: card ? +card.getBoundingClientRect().height.toFixed(1) : -1,
      // 正控：量到的这一格必须真的**含着**图片带（锚点滑到兄弟/内层小盒子时 cardH 会小于 bandH，
      // 而"估多了/估少了"两条都可能照样绿 —— 那是在量别的东西）。
      cardHoldsBand: !!(card && band && card.contains(band)
        && card.getBoundingClientRect().height >= band.getBoundingClientRect().height - 0.5),
      // 「查看更多」在不在命中区①**里面**（决定它要不要自己 stop）
      moreInBody: more ? !!more.closest('[role="button"][tabindex="0"]') : false,
    };
  })()`;

  await cdp.eval("window.__probe.reset()");
  await mount({
    message: JSON.parse(JSON.stringify({
      ...JSON.parse(MSG), content: JSON.stringify({ ...payload, images: mkImages(LIMIT + 6, "f") }),
    })),
    mentionNames: ["小布"],
    selfMention: null,
  });
  const manyGeo = await cdp.eval(MEASURE);
  check(`图片 ${LIMIT + 6} 张 ⇒ 卡片只画 ${LIMIT} 张（其余去详情弹窗看）`,
    manyGeo.rendered === LIMIT, `恰好 ${LIMIT} 张`, JSON.stringify(manyGeo));
  check("超限时出现「查看更多」按钮",
    manyGeo.moreH > 0, `那颗高度 > 0`, JSON.stringify(manyGeo));

  await cdp.eval("window.__probe.reset()");
  const moreClicked = await cdp.eval(`(() => {
    const label = ${JSON.stringify(moreLabel)};
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => (x.textContent || '').trim().startsWith(label));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const evMore = await cdp.eval("window.__probe.events");
  const moreOpened = evMore.filter((e) => e[0] === "open-id").map((e) => e[1]);
  const morePanel = evMore.filter((e) => e[0] === "open-panel").length;
  // ⚠️ 必须**按文案**认这颗按钮，不许用"没有 svg 的那个 button"之类的形状去猜：
  // 「查看更多」自己带一个 ChevronRight ⇒ 猜"无 svg"永远选不中它，会退到最后一颗
  // （=底部「查看任务」），于是这条判据量的是别的按钮，产品缺陷被读成绿。
  // 且"一模一样"要求**只有** open(todoId)：多一个 open-panel 就是面板被开两次、
  // 第二次不带 id ⇒ 直达这条任务的效果被冲掉。
  check("点「查看更多」= 点「查看任务」：只 emit open 带**这条**的 todo_id，不多冒 open-panel",
    moreClicked === true && moreOpened.length === 1 && moreOpened[0] === TODO_ID && morePanel === 0,
    "1 次 open-id=" + TODO_ID + " 且 open-panel×0", JSON.stringify(evMore) + " " + JSON.stringify(manyGeo));

  // 反面对照：刚好上限张数 ⇒ 一个缩略图都不少，且**没有**「查看更多」（否则 4 张也弹按钮）
  await cdp.eval("window.__probe.reset()");
  await mount({
    message: JSON.parse(JSON.stringify({
      ...JSON.parse(MSG), content: JSON.stringify({ ...payload, images: mkImages(LIMIT, "e") }),
    })),
    mentionNames: ['小布'],
    selfMention: null,
  });
  const exactGeo = await cdp.eval(MEASURE);
  check(`对照：正好 ${LIMIT} 张 ⇒ 全画出来且不出现「查看更多」（判据不是恒真）`,
    exactGeo.rendered === LIMIT && exactGeo.moreH === 0,
    `${LIMIT} 张且无更多按钮`, JSON.stringify(exactGeo));

  // —— 高度契约：每种张数都按"同一份估算 vs 同一个 DOM"对照 ——
  // ⚠️ 三条纪律：① 估算端现读，不在探针里抄数（抄了一份就钉不住真正的同步）；
  // ② 每条记录**必须有各自的 msg_id** —— messageHeight 的缓存键是 `fontSize|msg_id`，
  //   两条记录共用一个号时，第二次读到的是第一次的缓存（2026-10-12 那版就这么读出
  //   "有图 == 无图"，把估算端读成"没长"）；③ 两个方向都要量：估少了 ⇒ 相邻消息互相遮挡，
  //   估多了 ⇒ 卡片之间出现一大片空洞（本文件顶部那条契约说的是前者，后者同样是真的）。
  const COUNTS = [0, 1, 2, 3, LIMIT, LIMIT + 1, LIMIT + 6];
  const rows = [];
  for (const n of COUNTS) {
    await mount({
      message: JSON.parse(JSON.stringify({
        ...JSON.parse(MSG), content: JSON.stringify({ ...payload, images: mkImages(n, `h${n}`) }),
      })),
      mentionNames: ["小布"],
      selfMention: null,
    });
    const g = await cdp.eval(MEASURE);
    const est = await cdp.eval(`(async () => {
      const h = await import('/src/utils/messageHeight.ts');
      const rec = { msg_id: 'm-probe-h-${n}', sender_id: 'dev-me', kind: 'todo',
        content: JSON.stringify({ ...${JSON.stringify(payload)}, images: ${JSON.stringify(mkImages(n, `h${n}`))} }),
        ts: 1700000000000 };
      return h.estimateMessageHeight(rec, undefined,
        { messages: [], isGroup: false, selfId: 'dev-me', fontSize: 'md' });
    })()`);
    rows.push({ n, rendered: g.rendered, band: g.bandH, more: g.moreH, real: g.cardH, holds: g.cardHoldsBand, est });
  }
  console.log("  · 高度实测表（张数/渲染/图片带/查看更多/卡片真实/估算）: " + JSON.stringify(rows));
  // 锚点正控：上面两条只判"落在区间里"，锚点若滑到某个更小的内层盒子，两条都可能照样绿
  // （real 变小 ⇒ real ≤ est 更成立）。所以另钉一条：有图的那几行，量到的必须是**含图片带**的祖先。
  check("锚点正控：量到卡片的那一格必须真的含着图片带（锚点读错对象时这条先红）",
    rows.filter((r) => r.n > 0).every((r) => r.holds === true),
    "有图的行 holds 全 true", JSON.stringify(rows.map((r) => [r.n, r.holds])));
  check("每种张数：卡片真实高度 ≤ 估算（估少了就是虚拟列表遮挡）",
    rows.every((r) => r.real > 0 && r.est > 0 && r.real <= r.est),
    "全部 real ≤ est", JSON.stringify(rows));
  check("每种张数：估算不许比真实多出一整行以上（估多了＝卡片之间出现空洞）",
    rows.every((r) => r.est - r.real <= 100), "est-real ≤ 100", JSON.stringify(rows));
  check("只画前几张时，图片带高度按可见张数收敛（第 5 张往后不再长高）",
    rows.filter((r) => r.n >= LIMIT).every((r) => r.band === rows.find((x) => x.n === LIMIT).band),
    "≥上限的图片带等高", JSON.stringify(rows.map((r) => [r.n, r.band])));
}

/**
 * 群任务看板**实时同步**行为测试（`--only=tasksrt`）。
 *
 * 不挂源码字符串、不直接改 store：在真浏览器里挂真的 `GroupTasksBoard`，把
 * `getGroupTodoMessages`（DB 快照）与 `onMessageReceived`（事件订阅）两条 api 替成
 * 可控夹具，然后从**后端事件方向**推 message-received，断言看板 DOM 真的更新、
 * 计数正确、不重复、不被旧事件回滚、订阅可摘、重开与持久化一致。
 *
 * 这一族曾真坏过：看板改折 groupTodoRows（51dac87）后，独立窗口的订阅仍只重载
 * messages —— 事件收到了、IPC 也发了，看板一动不动。源码形状测试发现不了
 * "订阅接到了错误的数据源"，所以这里必须走真实订阅→重读→折叠→渲染整条链。
 */
async function runTasksRealtime(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);

  // 有界等待：全量连跑时长会话里 150ms 去抖定时器偶发 >450ms 才落地（固定 sleep
  // 在 solo 跑绿、全集跑红）。条件满足即继续，到点才报红，不把时序写成脆弱断言。
  const waitFor = async (fn, timeoutMs = 3_000, stepMs = 100) => {
    const deadline = Date.now() + timeoutMs;
    let v = await fn();
    while (!v && Date.now() < deadline) {
      await sleep(stepMs);
      v = await fn();
    }
    return v;
  };

  // 页面内常量与记录工厂（形状与后端落库一致：conv_id/seq/ts/msg_id/kind/content）
  const SETUP = `(async () => {
    window.GID = 'g1';
    window.CONV = 'group:g1';
    window.ME = 'probe-me';
    window.OTHER = 'probe-other';
    window.__mk = (id, seq, kind, def, ts) => ({
      msg_id: 'm-' + id + '-' + seq,
      sender_id: window.OTHER,
      conv_id: window.CONV,
      kind, seq, ts,
      status: 'read',
      content: JSON.stringify(Object.assign({
        todo_id: id, title: id, assignees: [window.ME], status: 'todo',
        creator: window.OTHER, deleted: false, description: '', images: [],
        archived: false, done_at: null, number: 0, priority: 'normal', category: 'task',
      }, def)),
    });
    return true;
  })()`;
  await cdp.eval(SETUP);
  await cdp.eval("window.__probe.todoBus()");

  /** 读看板当下：筛选胶囊（DOM 顺序 = all/mine/created/archived）、列表行标题、弹窗文本。 */
  const view = async () =>
    cdp.eval(`(() => {
      const pills = Array.from(document.querySelectorAll('button[aria-pressed]')).map((b) => ({
        pressed: b.getAttribute('aria-pressed') === 'true',
        count: Number((b.querySelector('span') || {}).textContent || '0'),
      }));
      // 行标题按钮：活动列表与归档列表都是 button.min-w-0.flex-1
      const rowTitles = Array.from(document.querySelectorAll('button.min-w-0.flex-1'))
        .map((b) => (b.querySelector('.truncate') || {}).textContent || '');
      const dialogs = document.querySelectorAll('[role="dialog"]').length;
      const dialogText = (document.querySelector('[role="dialog"]') || {}).textContent || '';
      return {
        pills,
        rowTitles,
        uniqTitles: [...new Set(rowTitles)],
        dialogs,
        dialogText,
      };
    })()`);

  // —— 初始快照：对端已建 A（待办，指派给我）——
  await cdp.eval(`(async () => {
    const now = Date.now();
    window.__probe.todoRows([
      window.__mk('A', 1, 'todo', {
        title: '写周报', number: 1, priority: 'high',
        description: '本周进展与下周计划：完成登录链路的断线重连与文件续传验证。',
      }, now),
    ]);
    return window.__probe.todoRows.length;
  })()`);
  await cdp.eval(`window.__probe.install('/src/components/GroupTasksBoard.vue', '', ${JSON.stringify(JSON.stringify({ groupId: "g1", open: true }))})`);
  await cdp.eval(`window.__probe.seedDevice('probe-me')`);
  await waitFor(async () => (await view()).uniqTitles.includes("写周报"), 4_000);

  const v0 = await view();
  check("初始：看板列出 A，默认筛选「给我的」且计数 all=1/mine=1/created=0/archived=0",
    v0.pills.length === 4 && v0.uniqTitles.includes("写周报")
      && v0.pills.map((p) => p.count).join(",") === "1,1,0,0"
      && v0.pills[1].pressed === true,
    "行=" + JSON.stringify(v0.uniqTitles) + " pills=" + JSON.stringify(v0.pills), JSON.stringify(v0.pills));
  const reads0 = (await cdp.eval("window.__probe.todoStats()")).reads;
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-tasks.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 群任务看板取证帧 → " + SHOT_PATH.replace(/\.png$/, "-tasks.png"));
  }
  check("首屏只发一次全表读取（ensure 已加载不重复打 IPC）",
    reads0 === 1, "reads=1", "reads=" + reads0);

  // —— 订阅真实事件（独立窗口的那条路径）——
  await cdp.eval(`(async () => {
    const chat = await window.__probe.chatStore();
    window.__unwatch = await chat.watchGroupTodos('g1');
    return true;
  })()`);
  const st1 = await cdp.eval("window.__probe.todoStats()");
  check("watchGroupTodos 注册了一次 message-received 订阅",
    st1.subscribed === 1, "subscribed=1", JSON.stringify(st1));

  // —— 展开 A 的详情：验证实时更新不把展开态关掉 ——
  await cdp.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('button.min-w-0.flex-1'));
    const a = btns.find((b) => (b.textContent || '').includes('写周报'));
    if (!a) return false;
    a.click();
    return true;
  })()`);
  await sleep(200);
  const vDetail0 = await view();
  check("点行打开了任务详情弹窗", vDetail0.dialogs === 1 && vDetail0.dialogText.includes("写周报"),
    "dialog 含旧标题", "dialogs=" + vDetail0.dialogs);

  // 矮窗口下详情内容会超出可视高度：footer 在滚动区之外（设计如此），
  // 但要证明内容区真的能滚到底、描述不是被 footer 永久盖住。
  const scrollInfo = await cdp.eval(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { found: false };
    const sc = [...dlg.querySelectorAll('*')].find((e) => {
      const st = getComputedStyle(e);
      return /(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 1;
    });
    if (!sc) return { found: false, why: '没有可滚动内容区' };
    sc.scrollTop = sc.scrollHeight;
    return {
      found: true,
      top: Math.round(sc.scrollTop),
      max: sc.scrollHeight - sc.clientHeight,
      text: dlg.innerText,
    };
  })()`);
  check("任务详情内容区可滚到底（描述在 footer 之上可完整到达，不是被永久遮住）",
    scrollInfo.found === true && scrollInfo.top > 0 && scrollInfo.top === scrollInfo.max
      && String(scrollInfo.text || "").includes("本周进展与下周计划"),
    "scrollTop=max 且描述存在", JSON.stringify({ found: scrollInfo.found, top: scrollInfo.top, max: scrollInfo.max }));
  if (SHOT_PATH) {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SHOT_PATH.replace(/\.png$/, "-taskdetail.png"), Buffer.from(shot.data, "base64"));
    console.log("  📷 群任务详情取证帧 → " + SHOT_PATH.replace(/\.png$/, "-taskdetail.png"));
  }

  // —— 对端一批变更（模拟另一个成员连发）：A 改成完成并改名、新增 B、新增 C 后完成并归档。
  //    同步推 5 个事件，其中 B 的创建事件重复一次 —— 150ms 去抖后只许重读一次。 ——
  await cdp.eval(`(async () => {
    const now = Date.now();
    const rows = [
      window.__mk('A', 1, 'todo', { title: '写周报', number: 1 }, now - 2000),
      window.__mk('A', 2, 'todo_update', { title: '周报已发出', status: 'done', done_at: now, number: 1 }, now),
      window.__mk('B', 3, 'todo', { title: '修打印机', number: 2 }, now),
      window.__mk('C', 4, 'todo', { title: '订场地', number: 3 }, now),
      window.__mk('C', 5, 'todo_update', { title: '订场地', status: 'done', done_at: now, archived: true, number: 3 }, now + 1),
    ];
    window.__probe.todoRows(rows);
    const events = [rows[1], rows[2], rows[3], rows[4], rows[2] /* B 重复帧 */];
    window.__probe.todoEmit(events);
    return events.length;
  })()`);
  // 等到「1 次重读」落地而不是睡固定时长（长会话下定时器可能延迟）。
  await waitFor(async () =>
    ((await cdp.eval("window.__probe.todoStats()")).reads - reads0) === 1);
  await waitFor(async () => (await view()).uniqTitles.includes("修打印机"));
  const st2 = await cdp.eval("window.__probe.todoStats()");
  check("5 个事件（含 1 个重复帧）只合并成 1 次重读（150ms 去抖真实生效）",
    st2.reads - reads0 === 1, "Δreads=1", "Δreads=" + (st2.reads - reads0));

  const v1 = await view();
  check("新增/改名/完成/归档后：活动 all=2、mine=2、归档=1（计数与列表一致）",
    v1.pills.map((p) => p.count).join(",") === "2,2,0,1",
    "2,2,0,1", JSON.stringify(v1.pills));
  check("活动列表出现新任务 B 与改名后的 A，归档的 C 不在活动列表，且无重复行",
    v1.uniqTitles.includes("修打印机") && v1.uniqTitles.includes("周报已发出")
      && !v1.uniqTitles.includes("写周报") && !v1.uniqTitles.includes("订场地")
      && v1.rowTitles.length === v1.uniqTitles.length,
    JSON.stringify(v1.rowTitles), JSON.stringify(v1.rowTitles));
  check("更新前展开的详情弹窗仍开着，且内容已是改名后的 A（展开态保留 + 内容实时）",
    v1.dialogs === 1 && v1.dialogText.includes("周报已发出") && !v1.dialogText.includes("订场地"),
    "dialog 跟到新标题", "dialogs=" + v1.dialogs);
  check("筛选没被实时更新重置（仍停在「给我的」）",
    v1.pills[1].pressed === true, "mine pressed", JSON.stringify(v1.pills.map((p) => p.pressed)));

  // —— 切到「全部」，再来一批重复/旧序事件：筛选保留、终态不被旧帧回滚 ——
  await cdp.eval(`(() => {
    document.querySelectorAll('button[aria-pressed]')[0].click();
    return true;
  })()`);
  await sleep(150);
  await cdp.eval(`window.__probe.todoEmit([window.__mk('A', 1, 'todo', { title: '写周报', number: 1 }, Date.now() - 9000)])`);
  await cdp.eval(`window.__probe.todoEmit([window.__mk('A', 1, 'todo', { title: '写周报', number: 1 }, Date.now() - 9000)])`);
  // 旧事件只触发重读、不允许回滚；状态在落地前后都成立，给定时器一个固定窗口即可
  // （unlisten 的清理会摘掉尚未落地的定时器，不会污染后面的"reads 不变"断言）。
  await sleep(300);
  const v2 = await view();
  check("旧 seq / 重复事件后：列表不回滚到旧标题（DB 快照是真相），筛选仍在「全部」",
    v2.uniqTitles.includes("周报已发出") && !v2.uniqTitles.includes("写周报")
      && v2.pills[0].pressed === true,
    JSON.stringify(v2.uniqTitles), JSON.stringify(v2.uniqTitles));

  // —— 归档筛选：C 在归档里，且只有它一条 ——
  await cdp.eval(`(() => {
    document.querySelectorAll('button[aria-pressed]')[3].click();
    return true;
  })()`);
  await sleep(150);
  const v3 = await view();
  check("「已归档」里正好是 C 一条（归档计数与列表一致）",
    v3.pills[3].count === 1 && v3.uniqTitles.length === 1 && v3.uniqTitles[0] === "订场地",
    JSON.stringify(v3.uniqTitles) + " count=" + v3.pills[3].count, JSON.stringify(v3.uniqTitles));

  // —— 取消订阅：之后的事件不再触发重读（监听器真的被摘掉，没有泄漏的第二条）——
  await cdp.eval(`(() => { window.__unwatch(); return true; })()`);
  const readsBefore = (await cdp.eval("window.__probe.todoStats()")).reads;
  await cdp.eval(`(async () => {
    const now = Date.now();
    const rows = JSON.parse(JSON.stringify(window.__todoRows));
    rows.push(window.__mk('D', 6, 'todo', { title: '新任务 D', number: 4 }, now));
    window.__probe.todoRows(rows);
    window.__probe.todoEmit([rows[rows.length - 1]]);
    return true;
  })()`);
  await sleep(350);
  const st3 = await cdp.eval("window.__probe.todoStats()");
  const v4 = await view();
  check("unlisten 后再推事件：不发重读、看板也不出现新任务（订阅确实摘干净）",
    st3.reads === readsBefore && st3.unsubscribed === true && !v4.uniqTitles.includes("新任务 D"),
    "reads 不变", "reads " + readsBefore + "→" + st3.reads + " unsub=" + st3.unsubscribed);

  // —— 重新订阅（相当于窗口重新聚焦/换群再换回）：漏下的变更立刻补回来 ——
  await cdp.eval(`(async () => {
    const chat = await window.__probe.chatStore();
    await chat.watchGroupTodos('g1');
    window.__probe.todoEmit([window.__todoRows[window.__todoRows.length - 1]]);
    return true;
  })()`);
  await cdp.eval(`(() => {
    document.querySelectorAll('button[aria-pressed]')[0].click(); // 回「全部」看活动行
    return true;
  })()`);
  await waitFor(async () => (await view()).uniqTitles.includes("新任务 D"), 3_000);
  const v5 = await view();
  check("重新订阅后事件再次生效：D 出现在看板（自愈，不需要重开窗口）",
    v5.uniqTitles.includes("新任务 D"), JSON.stringify(v5.uniqTitles), JSON.stringify(v5.uniqTitles));

  // —— 关闭再打开：重新挂一块看板，首屏读到的与"DB"一致（持久化一致性）——
  const finalRows = await cdp.eval("JSON.parse(JSON.stringify(window.__todoRows))");
  await cdp.eval(`window.__probe.install('/src/components/GroupTasksBoard.vue', '', ${JSON.stringify(JSON.stringify({ groupId: "g1", open: true }))})`);
  await cdp.eval(`window.__probe.seedDevice('probe-me')`);
  await waitFor(async () =>
    (await view()).pills.map((p) => p.count).join(",") === "3,3,0,1", 4_000);
  const v6 = await view();
  check("面板关闭重开：首屏直接呈现持久化终态（A 改名/B 新增/C 归档/D 已到），不靠事件补",
    v6.uniqTitles.includes("周报已发出") && v6.uniqTitles.includes("修打印机")
      && v6.uniqTitles.includes("新任务 D") && !v6.uniqTitles.includes("订场地")
      && v6.pills.map((p) => p.count).join(",") === "3,3,0,1",
    "3,3,0,1", JSON.stringify({ t: v6.uniqTitles, pills: v6.pills.map((p) => p.count) }));
  void finalRows;
}

/**
 * 输入框那两个浮层的**真布局**判据（`--only=inputpanel`）。
 *
 * 为什么这一格非用真布局不可（评审登记过、此前故意没补）：`MessageComposer` 里的表情面板与
 * @ 候选列表都是 CSS `absolute bottom-full` **往上长**、留在输入框卡片里面。
 * 单独把 `EmojiPicker` 挂起来量，"往上长"这个方向没有参照物 ⇒ 量不到那一型真实缺陷
 *（面板顶部被视口上边缘切掉 / 被某个祖先的 overflow 裁掉）。
 *
 * ⚠️ 宿主壳只做一件事：把输入卡片压到视口底部（真实聊天窗里它就是 flex 的最后一项）。
 *    不给组件加新属性、不改样式、不改产品码 —— 为可测性加 `data-*` 也算动应用码（这条本仓付过一次版本号）。
 *    几何读数全部走现成的 `window.__probe.floatLayer(sel)`（它同时给 inViewport、被谁裁、
 *    有没有打断层链的祖先），不在这里另开第二份几何家。
 */
async function runInputPanels(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await sleep(3_000);
  await cdp.eval(PAGE_FIXTURE);
  const props = JSON.stringify({
    convId: "group:input-panel",
    mentionMembers: [{ id: "p1", name: "小布" }, { id: "p2", name: "阿蓝" }],
  });
  const mounted = await cdp.eval("window.__probe.install('/src/components/chat/MessageComposer.vue', '', "
    + JSON.stringify(props) + ")");
  check("输入框挂得起来（两个浮层才有得量；挂不起来这一整段只能记未量）",
    !!mounted && mounted.ok === true, "install ok", JSON.stringify(mounted));

  await cdp.eval(`(() => {
    document.body.style.cssText = "margin:0;height:100vh;display:flex;flex-direction:column;justify-content:flex-end";
    const host = document.body.lastElementChild;
    if (host) host.style.flex = "none";
    return !!document.querySelector('.gosslan-composer');
  })()`);
  await sleep(400);
  const card = await cdp.eval(`(() => {
    const c = document.querySelector('.gosslan-composer');
    if (!c) return { ok: false };
    const r = c.getBoundingClientRect();
    return { ok: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
  })()`);
  check("宿主壳成立：输入卡片真的贴在视口底部（不贴底就没有「往上长」这回事，下面全部不作数）",
    !!card && card.ok === true && card.bottom <= card.vh + 2 && card.vh - card.bottom < 40,
    "bottom ≈ innerHeight", JSON.stringify(card));

  const pointOf = (key) => cdp.eval(`(async () => {
    const { t } = await import('/src/i18n/index.ts');
    const label = t(${JSON.stringify(key)});
    const b = Array.from(document.querySelectorAll('.gosslan-composer button'))
      .find((x) => x.getAttribute('aria-label') === label);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: Math.round(r.top) };
  })()`);
  const realClick = async (p) => {
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await sleep(400);
  };

  // ── ① 表情面板 ──────────────────────────────────────────────
  const emojiBtn = await pointOf("chat.composer.emoji");
  check("那颗表情按钮找得到（按 i18n 的 aria-label 认，不写死中文串）",
    !!emojiBtn, "找得到一颗 button", JSON.stringify(emojiBtn));
  if (!emojiBtn) return;
  await realClick(emojiBtn);
  // Reka Popover 把面板 Portal 到 body（不再挂在输入卡片里），所以选择器要跟着走。
  // 这正是迁移要的：卡片以后加圆角/overflow 也裁不到面板。
  const SEL_DLG = '[data-composer-emoji] [role="dialog"]';
  const dlg = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_DLG) + ")");
  check("真点之后表情面板由 Reka Portal 挂到 body（不是还塞在输入卡片里）",
    !!dlg && dlg.ok === true && dlg.parentIsBody === true && dlg.escapes === true,
    "挂在 body 且没有应用祖先裁得到它",
    JSON.stringify(dlg && { why: dlg.why, parentIsBody: dlg.parentIsBody, escapes: dlg.escapes }));
  check("表情面板整个在视口内（往上长 ⇒ 上边缘才是真实风险，这条量的就是它）",
    !!dlg && dlg.ok === true && dlg.inViewport === true,
    "inViewport=true", JSON.stringify([dlg && dlg.rect, dlg && dlg.vh]));
  // ⚠️ 裁切这一条不能直接拿 floatLayer 的 clipped 原样判：这个应用是桌面壳，`body` 本来就写死
  // `overflow:hidden`，而输入框那两张面板是 **absolute**（不是那几族 Teleport 到 body 的 fixed），
  // 于是 body 一定会被算进裁切祖先 —— 那不是缺陷，是壳的形状。真正要判的是**中间那层卡片**
  // （输入框自己那张 `.gosslan-composer` 或它的包裹层）会不会把往上长的面板切掉。
  const shellRoot = (x) => x === "body" || x === "html" || String(x).startsWith("body:") || String(x).startsWith("html:");
  const dlgCutters = ((dlg && dlg.clipped) || []).filter((x) => !shellRoot(x));
  check("面板底边落在按钮顶边之上（bottom-full 那句真的生效），且没有**中间层**卡片裁得到它",
    !!dlg && dlg.ok === true && Number(dlg.rect.bo) <= emojiBtn.top + 2 && dlgCutters.length === 0,
    "panel.bottom ≤ 按钮 top 且非壳层裁切祖先为空",
    JSON.stringify([dlg && dlg.rect, emojiBtn.top, (dlg && dlg.clipped) || []])
    + "（壳层 body/html 已按上面的理由排除，排除前原样是这一串）");
  const hitDlg = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_DLG)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(top && el.contains(top));
  })()`);
  check("面板中心那一点归面板自己接（既不『看不见却接得住』，也不反过来被别层盖住）",
    hitDlg === true, "elementFromPoint 落在面板内部", "hit=" + hitDlg);

  // ★ 这条变异专门证「中间层裁切」这一型缺陷**只有这条判据看得见**：把 Reka 的
  // popper 层搬回输入卡片里、并给卡片 `overflow:hidden`（旧实现的真实形状）。
  // 注意此时面板的矩形与 inViewport **都不变**（它照样画在视口里、只是被祖先剪掉一块）⇒
  // 只判视口那条会放它过去。没有这一格，上面那条裁切判据等于没被证明会咬。
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_DLG)});
    if (!el) return false;
    const box = el.closest('[data-reka-popper-content-wrapper]') || el;
    const card = document.querySelector('.gosslan-composer');
    if (!card) return false;
    window.__emojiHome = { parent: box.parentElement, next: box.nextSibling,
      pos: box.style.position, transform: box.style.transform, left: box.style.left, top: box.style.top };
    card.style.overflow = "hidden";
    const h = box.getBoundingClientRect().height;
    box.style.position = "absolute";
    box.style.transform = "none";
    box.style.left = "0px";
    // 放到卡片顶边之上，让矩形留在视口里：这一格要证的是"被祖先裁"，不是"跑出视口"。
    box.style.top = (-h) + "px";
    card.appendChild(box);
    return true;
  })()`);
  const cut = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_DLG) + ")");
  const cutters = ((cut && cut.clipped) || []).filter((x) => !shellRoot(x));
  check("变异：把面板搬回输入卡片并 overflow:hidden ⇒ 中间层裁切必须被报出来（且 inViewport 仍为真 ⇒ 证明这条不是视口那条的别名）",
    !!cut && cut.ok === true && cutters.length > 0 && cut.inViewport === true,
    "非壳层裁切祖先 ≥ 1 且 inViewport 仍 true",
    JSON.stringify([cut && cut.clipped, cut && cut.inViewport, cut && cut.rect]));
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_DLG)});
    if (!el) return false;
    const box = el.closest('[data-reka-popper-content-wrapper]') || el;
    const h = window.__emojiHome;
    if (h && h.parent) h.parent.insertBefore(box, h.next);
    const card = document.querySelector('.gosslan-composer');
    if (card) card.style.removeProperty("overflow");
    if (h) { box.style.position = h.pos; box.style.transform = h.transform;
      box.style.left = h.left; box.style.top = h.top; }
    delete window.__emojiHome;
    return true;
  })()`);
  const cutBack = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_DLG) + ")");
  check("变异可逆：搬回 body 后裁切祖先回到只剩壳层（对照自己不留残留）",
    !!cutBack && ((cutBack.clipped) || []).filter((x) => !shellRoot(x)).length === 0,
    "非壳层裁切祖先为空", JSON.stringify(cutBack && cutBack.clipped));

  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_DLG)});
    if (!el) return false;
    const box = el.closest('[data-reka-popper-content-wrapper]') || el;
    box._o = { left: box.style.left, top: box.style.top, transform: box.style.transform };
    box.style.left = "0px"; box.style.top = "180vh"; box.style.transform = "none";
    return true;
  })()`);
  const pushed = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_DLG) + ")");
  check("变异：把面板整块推到视口下方外 ⇒ inViewport 必须翻假（证明那条不是恒真）",
    !!pushed && pushed.ok === true && pushed.inViewport === false,
    "inViewport=false", JSON.stringify(pushed && pushed.rect));
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_DLG)});
    if (!el) return false;
    const box = el.closest('[data-reka-popper-content-wrapper]') || el;
    if (!box._o) return false;
    box.style.left = box._o.left; box.style.top = box._o.top;
    box.style.transform = box._o.transform; delete box._o;
    return true;
  })()`);
  const back = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_DLG) + ")");
  check("变异可逆：撤掉那两行内联样式后它又整个回到视口内（没把页面改坏一次）",
    !!back && back.ok === true && back.inViewport === true, "inViewport=true", JSON.stringify(back && back.rect));

  // 关掉表情面板，再走 @ 那一条（两层浮层不叠着：全局互斥那一族已经判过，这里只要干净起点）
  await realClick(emojiBtn);
  const closed = await cdp.eval(`!!document.querySelector(${JSON.stringify(SEL_DLG)})`);
  check("再点一次那颗按钮面板就收起（DOM 撤净，不留看不见的一层）",
    closed === false, "role=dialog 为 0 个", "还在=" + closed);

  // 选中一个表情：焦点必须回到编辑器，token 必须真的进了草稿。
  // 这条守的是 Reka Popover 的 closeAutoFocus 与 EmojiPicker 自己的焦点归还
  // 不再互相抢 —— 选完表情还要再点一下输入框才能接着打字，是肉眼很容易漏掉的回归。
  await realClick(emojiBtn);
  await sleep(250);
  const pick = await cdp.eval(`(() => {
    const b = document.querySelector('[data-emoji-panel] button');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("表情面板里拿得到一格真实表情的落点", !!pick, "格子非空", JSON.stringify(pick));
  if (pick) await realClick(pick);
  await sleep(300);
  const afterPick = await cdp.eval(`(() => {
    const ed = document.querySelector('.gosslan-composer [contenteditable="true"]');
    return { focused: document.activeElement === ed, text: ed ? ed.innerText : null,
      open: !!document.querySelector('[data-emoji-panel]') };
  })()`);
  check("选完表情：面板收起、焦点回到编辑器、token 进了草稿（选完能直接接着打字）",
    afterPick.open === false && afterPick.focused === true && typeof afterPick.text === "string"
      && afterPick.text.includes("["),
    "open=false 且 activeElement=编辑器 且草稿含 token", JSON.stringify(afterPick));
  await cdp.eval(`(() => { const ed = document.querySelector('.gosslan-composer [contenteditable="true"]');
    if (ed) { ed.innerHTML = ''; ed.dispatchEvent(new InputEvent('input', { bubbles: true })); } })()`);

  // ── ② @ 候选列表 ────────────────────────────────────────────
  const edPoint = await cdp.eval(`(() => {
    const e = document.querySelector('.gosslan-composer [contenteditable="true"]')
      || document.querySelector('.gosslan-composer [data-focus-ring-ok]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + Math.min(24, r.width / 2), y: r.y + r.height / 2 };
  })()`);
  check("编辑器找得到（真点击才能把 caret 放进去，eval 里 focus() 不算真焦点）",
    !!edPoint, "找得到可编辑区", JSON.stringify(edPoint));
  if (!edPoint) return;
  await realClick(edPoint);
  await cdp.eval("window.__probe.reset()");
  await cdp.send("Input.insertText", { text: "@" });
  await sleep(500);
  const SEL_LIST = '.gosslan-composer .frost:not([role="dialog"])';
  const lst = await cdp.eval("window.__probe.floatLayer(" + JSON.stringify(SEL_LIST) + ")");
  check("真输入一个 @ 就浮出候选列表（走的是组件自己的 input 事件，不是我们把状态摆好）",
    !!lst && lst.ok === true, "列表挂载", JSON.stringify(lst && lst.why));
  const rows = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(SEL_LIST)});
    return el ? el.querySelectorAll("button").length : -1;
  })()`);
  check("列表里真的列出了成员（>0；名单来自 props，不是夹具自己塞的 DOM）",
    Number(rows) > 0, ">0 行", "rows=" + rows);
  check("候选列表整个在视口内，且长在卡片上方（和表情面板同一个往上长的方向）",
    !!lst && lst.ok === true && lst.inViewport === true && Number(lst.rect.bo) <= card.top + 2,
    "inViewport 且 list.bottom ≤ 卡片 top", JSON.stringify([lst && lst.rect, card.top]));

  // 对照：换一个普通字符 ⇒ 列表必须不出现（没有这一格，上面三条可以由"列表一直在"冒充）
  await cdp.eval(`(() => {
    const e = document.querySelector('.gosslan-composer [contenteditable="true"]')
      || document.querySelector('.gosslan-composer [data-focus-ring-ok]');
    if (e) { e.innerHTML = ""; e.dispatchEvent(new InputEvent("input", { bubbles: true })); }
  })()`);
  await cdp.send("Input.insertText", { text: "x" });
  await sleep(450);
  const noList = await cdp.eval(`!!document.querySelector(${JSON.stringify(SEL_LIST)})`);
  check("对照：把 @ 换成普通字符 ⇒ 候选列表必须不出现（证明那三条不是恒真）",
    noList === false, "列表为 0 个", "还在=" + noList);

  // 键盘出口 + 载荷：重新输入 @ → ArrowDown → Enter 选中 → 回车发送 ⇒ 读 send 的 mentionIds
  await cdp.eval(`(() => {
    const e = document.querySelector('.gosslan-composer [contenteditable="true"]')
      || document.querySelector('.gosslan-composer [data-focus-ring-ok]');
    if (e) { e.innerHTML = ""; e.dispatchEvent(new InputEvent("input", { bubbles: true })); }
  })()`);
  await realClick(edPoint);
  await cdp.send("Input.insertText", { text: "@小" });
  await sleep(450);
  await cdp.key("ArrowDown", "ArrowDown", "", 40);
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(500);
  const token = await cdp.eval(`(() => {
    const tk = document.querySelector('.gosslan-composer .mention-token[data-mention-id]');
    return tk ? tk.getAttribute("data-mention-id") : null;
  })()`);
  check("方向键 + 回车真的选中了那一条：编辑器里落下带 data-mention-id 的 token",
    typeof token === "string" && token.length > 0, "一个带 id 的 token", "token=" + JSON.stringify(token));
  await cdp.key("Enter", "Enter", "\r", 13);
  await sleep(500);
  const sent = await cdp.eval(`(() => {
    const s = (window.__probe.events || []).filter((e) => e[0] === "send");
    return s.length ? JSON.parse(s[s.length - 1][1]) : null;
  })()`);
  check("再按一次回车把这条发出去，载荷里的 mentionIds 认得那个 id（DOM 上只有 token，名单在载荷里）",
    !!sent && Array.isArray(sent.mentionIds) && sent.mentionIds.length > 0,
    "send 载荷带 mentionIds", JSON.stringify(sent));
  check("发出去之后输入框清空、候选列表不残留（同一次动作的两半，不许只做成一半）",
    await cdp.eval(`(() => {
      const e = document.querySelector('.gosslan-composer [contenteditable="true"]')
        || document.querySelector('.gosslan-composer [data-focus-ring-ok]');
      return !!(e && !e.textContent.trim()) && !document.querySelector(${JSON.stringify(SEL_LIST)});
    })()`) === true, "编辑器空、列表不在", "读到的仍是残留");

  // 鼠标出口：点击「发送」按钮也必须真的 emit。此前探针只走过 Enter，
  // 而按钮上有 `@mousedown.prevent`（保持编辑器焦点）；这条单独证明那个 prevent
  // 没有顺带把 click 吃掉。
  await cdp.eval("window.__probe.reset()");
  await realClick(edPoint);
  await cdp.send("Input.insertText", { text: "按钮发送" });
  await sleep(300);
  const sendBtn = await cdp.eval(`(async () => {
    const { t } = await import('/src/i18n/index.ts');
    const label = t("common.send");
    const b = Array.from(document.querySelectorAll('.gosslan-composer button'))
      .find((x) => (x.textContent || '').trim() === label);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!b.disabled };
  })()`);
  if (sendBtn) await realClick(sendBtn);
  const clickSent = await cdp.eval(`(window.__probe.events || []).filter((e) => e[0] === "send").length`);
  check("真点『发送』按钮也 emit send（不是只有回车这一条出口；mousedown.prevent 不许吃掉 click）",
    !!sendBtn && sendBtn.disabled === false && clickSent > 0,
    "按钮可用且 send 事件 ≥1", JSON.stringify({ sendBtn, clickSent }));

  // ★ 补 §6.73 自己登记的那格覆盖空洞：`MessageComposer` 那条 document click 已经交给
  //   `useEventListener`，但**此前没有任何一条断言判它**。这条判"点开 @ 名单之后，点输入卡片之外 ⇒ 名单收起"，
  //   并且同时钉住"编辑器里那个 @ 还在"——只有 mention 状态被清、草稿没被动，才是这条监听干的；
  //   清空草稿的是发送那条路（上面刚验过），两件事分得开。
  await cdp.eval("window.__probe.reset()");
  await realClick(edPoint);
  await cdp.send("Input.insertText", { text: "@" });
  await sleep(500);
  const openedAgain = await cdp.eval(`!!document.querySelector(${JSON.stringify(SEL_LIST)})`);
  // 视口左上角：离贴底那张卡片最远，一定落在 `.gosslan-composer` 之外。
  await realClick({ x: 24, y: 24 });
  const outsideClick = await cdp.eval(`(() => {
    const e = document.querySelector('.gosslan-composer [contenteditable="true"]')
      || document.querySelector('.gosslan-composer [data-focus-ring-ok]');
    return { list: !!document.querySelector(${JSON.stringify(SEL_LIST)}), draft: e ? e.textContent : null };
  })()`);
  check("点输入卡片之外 ⇒ @ 候选列表收起而草稿里那个 @ 还在（这条走的是已交给 useEventListener 的 document click，不是发送那条清空路）",
    openedAgain === true && outsideClick.list === false && typeof outsideClick.draft === "string"
      && outsideClick.draft.includes("@"),
    "开 → 点外 → 关，且草稿含 @", JSON.stringify({ openedAgain, outsideClick }));
}


await main();
