#!/usr/bin/env node
/**
 * F-06 Windows WebView2 production scroll smoke (zero new dependencies).
 *
 * This is deliberately NOT scripts/check-ui-runtime.mjs: that probe starts Vite dev,
 * mounts source components and has no Tauri CSP. This entry launches the shipped release
 * exe, uses its embedded dist assets + Tauri CSP, drives real IPC and reads WebView2 CDP.
 *
 * Windows:
 *   npm run test:ui-scroll:win
 *   npm run test:ui-scroll:win:selfproof   # static/structural negative controls, any OS
 * The default Windows run first builds the normal release exe, then launches isolated
 * instances with separate databases, device identities and WebView2 profiles.
 * GOSSLAN_SCROLL_EXE bypasses that build only for an already-built smoke exe.
 * Optional: GOSSLAN_SCROLL_CDP_A/B, GOSSLAN_WEBVIEW2_VERSION,
 *           GOSSLAN_SCROLL_MESSAGES/TODOS/FILES, GOSSLAN_SCROLL_TIMEOUT_MS.
 * A non-Windows normal run reports NOT RUN and exits 2; it never claims a pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = process.argv.includes("--selfproof") || process.argv.includes("--self-check");
const num = (name, fallback) => Number(process.env[name] || fallback);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const windowsPath = (p) => p.split(path.sep).join("/");

export function cspProblems(csp) {
  const directives = new Map(csp.split(";").map((part) => {
    const [name, ...values] = part.trim().toLowerCase().split(/\s+/);
    return [name, values];
  }));
  const problems = [];
  const exact = (name, values) => {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(values)) {
      problems.push(`${name} must be [${values.join(" ")}]`);
    }
  };
  exact("default-src", ["'none'"]);
  exact("script-src", ["'self'"]);
  exact("style-src", ["'self'"]);
  if (!(directives.get("connect-src") || []).includes("ipc:")) problems.push("connect-src lost real IPC");
  if (csp.includes("unsafe-inline") || csp.includes("unsafe-eval")) problems.push("CSP must not bypass inline/eval");
  return problems;
}

export function indexHtmlProblems(html) {
  const problems = [];
  if (/\/(?:src|node_modules\/\.vite)\//.test(html) || /@vite\/client/.test(html)) {
    problems.push("dist index still references source/dev modules");
  }
  const localScripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((m) => m[1]);
  if (!localScripts.some((u) => /^\/assets\/.*\.js$/.test(u))) problems.push("no hashed dist script entry");
  // Vite may attach extracted CSS from the JS loader rather than index.html; the artifact
  // preflight separately requires and parses dist/assets/*.css.
  return problems;
}

function declarations(css, selector) {
  const merged = new Map();
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls((decl) => merged.set(decl.prop, decl.value));
  });
  return [merged];
}

/** Source and shipped CSS must retain the flex height chain; a percent-height rollback is a failure. */
export function flexGeometryProblems(css) {
  const problems = [];
  const has = (selector, prop, value, forbid = false) => {
    const rules = declarations(css, selector);
    const present = rules.some((d) => d.get(prop) === value);
    const violated = forbid ? present : !present;
    if (violated) problems.push(`${selector}: ${prop} ${forbid ? "must not be" : "must be"} ${value}`);
  };
  has(".gosslan-os.n-scrollbar", "display", "flex");
  has(".gosslan-os.n-scrollbar", "flex-direction", "column");
  has(".gosslan-os.n-scrollbar", "min-height", "0");
  has(".gosslan-os.n-scrollbar", "position", "relative");
  has(".gosslan-os.n-scrollbar", "isolation", "isolate");
  has(".gosslan-os .n-scrollbar-container", "display", "flex");
  has(".gosslan-os .n-scrollbar-container", "flex-direction", "column");
  has(".gosslan-os .n-scrollbar-container", "flex", "1 1 auto");
  has(".gosslan-os .n-scrollbar-container", "height", "auto");
  has(".gosslan-os .n-scrollbar-container", "min-height", "inherit");
  has(".gosslan-os .n-scrollbar-container", "max-height", "inherit");
  has(".gosslan-os .n-scrollbar-container", "height", "100%", true);
  has(".gosslan-os .n-scrollbar-content", "flex", "1 0 auto");
  has(".gosslan-os .n-scrollbar-content", "min-height", "100%", true);
  has(".gosslan-os .n-scrollbar-rail", "position", "absolute");
  has(".gosslan-os .n-scrollbar-rail", "z-index", "40");
  has(".gosslan-os .n-scrollbar-rail--vertical .n-scrollbar-rail__scrollbar", "width", "var(--n-scrollbar-width)");
  return problems;
}

function newestMtime(dir) {
  let newest = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) walk(child);
      else newest = Math.max(newest, fs.statSync(child).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

export function validateProductionArtifacts({ root = ROOT, exe, dist = path.join(root, "dist") } = {}) {
  const problems = [];
  const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  problems.push(...cspProblems(config.app.security.csp));
  if (config.build?.frontendDist !== "../dist") problems.push("Tauri frontendDist must point to ../dist");
  if (config.build?.beforeBuildCommand !== "npm run build") problems.push("Tauri must build the real frontend before packaging");
  const index = path.join(dist, "index.html");
  if (!fs.existsSync(index)) return [...problems, "dist/index.html missing; run npm run build"];
  const html = fs.readFileSync(index, "utf8");
  problems.push(...indexHtmlProblems(html));
  const assets = fs.readdirSync(path.join(dist, "assets"));
  const css = assets.filter((f) => f.endsWith(".css"));
  const js = assets.filter((f) => f.endsWith(".js"));
  if (!css.length || !js.length) problems.push("dist/assets has no CSS or JS");
  const builtCss = css.map((file) => fs.readFileSync(path.join(dist, "assets", file), "utf8")).join("\n");
  problems.push(...flexGeometryProblems(builtCss));
  problems.push(...flexGeometryProblems(fs.readFileSync(path.join(root, "src/style.css"), "utf8")));
  if (!exe || !fs.existsSync(exe)) problems.push("release exe missing; build the Windows target first");
  else {
    if (/[\\/](?:debug|target[\\/]debug)[\\/]/i.test(exe)) problems.push("exe must be a release build");
    const exeMtime = fs.statSync(exe).mtimeMs;
    for (const sourceDir of ["src", "src-tauri/src"]) {
      const p = path.join(root, sourceDir);
      if (fs.existsSync(p) && newestMtime(p) > exeMtime + 2000) problems.push(`${sourceDir} changed after release exe; rebuild`);
    }
  }
  return [...new Set(problems)];
}

export function runStaticSelfProof() {
  const source = fs.readFileSync(path.join(ROOT, "src/style.css"), "utf8");
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const index = fs.existsSync(path.join(ROOT, "dist/index.html"))
    ? fs.readFileSync(path.join(ROOT, "dist/index.html"), "utf8")
    : '<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">';
  const mutateRule = (selector, mutate) => {
    const css = postcss.parse(source);
    css.walkRules(selector, (rule) => mutate(rule));
    return css.toString();
  };
  const base = { source, csp: config.app.security.csp, index };
  if (flexGeometryProblems(source).length || cspProblems(base.csp).length || indexHtmlProblems(index).length) {
    throw new Error("positive control failed before negative controls");
  }
  const cases = [
    ["CSP dev-empty environment rejected", () => cspProblems("default-src 'none'; script-src 'self'").length > 0],
    ["CSP unsafe-inline bypass rejected", () => cspProblems(base.csp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")).length > 0],
    ["source entry in dist rejected", () => indexHtmlProblems('<script src="/src/main.ts"></script><link rel="stylesheet" href="/assets/app.css">').length > 0],
    ["broken host flex rejected", () => flexGeometryProblems(mutateRule(".gosslan-os.n-scrollbar", (rule) => rule.walkDecls("display", (d) => { d.value = "block"; }))).length > 0],
    ["later host flex override rejected", () => flexGeometryProblems(mutateRule(".gosslan-os.n-scrollbar", (rule) => rule.append({ prop: "display", value: "block" }))).length > 0],
    ["percentage container rollback rejected", () => flexGeometryProblems(mutateRule(".gosslan-os .n-scrollbar-container", (rule) => { rule.walkDecls("flex", (d) => d.remove()); rule.walkDecls("height", (d) => { d.value = "100%"; }); })).length > 0],
    ["content min-height rollback rejected", () => flexGeometryProblems(mutateRule(".gosslan-os .n-scrollbar-content", (rule) => rule.append({ prop: "min-height", value: "100%" }))).length > 0],
    ["rail stacking regression rejected", () => flexGeometryProblems(mutateRule(".gosslan-os .n-scrollbar-rail", (rule) => rule.walkDecls("z-index", (d) => { d.value = "1"; }))).length > 0],
  ];
  for (const [name, mutate] of cases) {
    if (!mutate()) throw new Error(`negative control did not fire: ${name}`);
    console.log(`PASS ${name}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/build.yml"), "utf8");
  const launcher = fs.readFileSync(path.join(ROOT, "scripts/start-ui-scroll-smoke.ps1"), "utf8");
  const devProbe = fs.readFileSync(path.join(ROOT, "scripts/check-ui-runtime.mjs"), "utf8");
  const smoke = fs.readFileSync(path.join(ROOT, "scripts/check-ui-scroll-win.mjs"), "utf8");
  const buildBody = smoke.match(/function buildSmokeExe\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const wiring = [
    ["npm production entry is registered", pkg.scripts["test:ui-scroll:win"] === "node scripts/check-ui-scroll-win.mjs"],
    ["Windows CI invokes the production entry", /^\s*npm run test:ui-scroll:win\s*$/m.test(workflow) && workflow.includes("gosslan-windows-scroll-smoke")],
    ["launcher isolates instance DB and WebView2 UDF", launcher.includes("GOSSLAN_INSTANCE") && launcher.includes("WEBVIEW2_USER_DATA_FOLDER") && launcher.includes("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")],
    ["smoke build uses the CLI-supported base config", !buildBody.includes('"--config"') && !fs.existsSync(path.join(ROOT, "src-tauri/tauri.scroll-smoke.conf.json"))],
    ["dev probe disclaims production evidence", devProbe.includes("DEV PROBE —— 不是生产态证据") && devProbe.includes("本结果不是生产态/WebView2 证据")],
    ["fresh empty databases boot before conversation rows exist", smoke.includes("async function ready(cdp, requireConversation = false)") && smoke.includes("if (requireConversation)") && smoke.includes("await ready(a, true); await ready(b, true)")],
  ];
  for (const [name, ok] of wiring) {
    if (!ok) throw new Error(`wiring control failed: ${name}`);
    console.log(`PASS ${name}`);
  }
  return cases.length + wiring.length;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let target;
    let lastError = "no page target";
    while (Date.now() < deadline) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        const pages = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools:"));
        target = pages.find((t) => {
          try { return /(?:\/index\.html)?\/?$/.test(new URL(t.url).pathname); }
          catch { return false; }
        }) ?? pages[0];
        if (target?.webSocketDebuggerUrl) break;
        lastError = "CDP responded without a main page target";
      } catch (e) { lastError = e.message; }
      await sleep(250);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error(`CDP ${port} unavailable: ${lastError}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 10_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket failed")); }, { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject, timer } = cdp.pending.get(msg.id);
        clearTimeout(timer); cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method && cdp.events.length < 200) cdp.events.push(msg);
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    cdp.targetId = target.id;
    cdp.targetUrl = target.url;
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const out = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  }
  close() { this.ws.close(); }
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
  s.setTimeout(500, () => { s.destroy(); resolve(false); });
});

function powershell(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`PowerShell failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function buildSmokeExe() {
  console.log("Building normal release smoke exe (real dist, isolated instance databases and WebView2 profiles)...");
  const result = spawnSync("npm.cmd", ["run", "tauri", "--", "build", "--features", "bluetooth", "--no-bundle", "--target", "x86_64-pc-windows-msvc"], {
    cwd: ROOT, stdio: "inherit", shell: true, timeout: 30 * 60_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Windows smoke build failed: ${result.error?.message || `exit ${result.status}`}`);
}

async function launch(exe, runRoot, instance, port) {
  const launcher = path.join(ROOT, "scripts/start-ui-scroll-smoke.ps1");
  const command = `& '${launcher.replaceAll("'", "''")}' -Exe '${exe.replaceAll("'", "''")}' -RunRoot '${runRoot.replaceAll("'", "''")}' -Instance ${instance} -CdpPort ${port}`;
  const out = powershell(command);
  return JSON.parse(out);
}

async function stopInstance(proc) {
  if (!proc?.pid) return;
  // Graceful app exit also closes auxiliary windows. /T is the bounded fallback for a hung GUI.
  powershell(`try { taskkill /PID ${proc.pid} /T /F | Out-Null } catch { try { Stop-Process -Id ${proc.pid} -Force -ErrorAction Stop } catch {} }`);
}

async function invoke(cdp, command, args = {}) {
  return cdp.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

const INIT_SCRIPT = `
window.__scrollSmoke = { violations: [], errors: [], resources: [] };
document.addEventListener('securitypolicyviolation', e => window.__scrollSmoke.violations.push({
  directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber
}));
window.addEventListener('error', e => window.__scrollSmoke.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__scrollSmoke.errors.push(String(e.reason)));
`;

async function ready(cdp, requireConversation = false) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_SCRIPT });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(() => cdp.eval("!!(window.__scrollSmoke && window.__TAURI_INTERNALS__ && !window.__gosslan_boot_failed)"), "production app boot", 45_000);
  await waitFor(() => cdp.eval("!!document.querySelector('.n-scrollbar')"), "conversation list shell", 45_000);
  if (requireConversation) {
    await waitFor(() => cdp.eval("!!document.querySelector('[data-conv-row]')"), "seeded conversation row", 45_000);
  }
}

async function seedPeer(groupName, messages, todos, files, runRoot, timeoutMs) {
  const a = await Cdp.connect(num("GOSSLAN_SCROLL_CDP_A", 9561), 30_000);
  const b = await Cdp.connect(num("GOSSLAN_SCROLL_CDP_B", 9562), 30_000);
  try {
    await ready(a); await ready(b);
    const [da, db] = await Promise.all([invoke(a, "get_device_info"), invoke(b, "get_device_info")]);
    if (!da.device_id || !db.device_id || da.device_id === db.device_id) throw new Error("device identities are not isolated");
    for (const cdp of [a, b]) {
      const lan = (await invoke(cdp, "list_interfaces")).find((i) => i.is_lan && i.ip && i.ip !== "0.0.0.0");
      if (lan) await invoke(cdp, "start_network", { bindIp: lan.ip }).catch(() => {});
    }
    await waitFor(async () => (await invoke(a, "get_peers")).some((p) => p.device_id === db.device_id), "peer A discovers B", timeoutMs);
    await waitFor(async () => (await invoke(b, "get_peers")).some((p) => p.device_id === da.device_id), "peer B discovers A", timeoutMs);
    await invoke(a, "send_friend_request", { peerId: db.device_id });
    await waitFor(async () => (await invoke(b, "get_pending_requests")).some((p) => p.from === da.device_id), "friend request", timeoutMs);
    await invoke(b, "respond_friend_request", { peerId: da.device_id, accept: true });
    await waitFor(async () => (await invoke(a, "get_friends")).some((p) => p.device_id === db.device_id), "friend A", timeoutMs);
    await waitFor(async () => (await invoke(b, "get_friends")).some((p) => p.device_id === da.device_id), "friend B", timeoutMs);
    const group = await invoke(a, "create_group", { name: groupName, members: [db.device_id] });
    await invoke(a, "distribute_group_key", { groupId: group.id });
    await waitFor(async () => (await invoke(b, "get_groups")).some((g) => g.id === group.id), "group key delivery", timeoutMs);
    for (let i = 0; i < messages; i++) {
      await invoke(a, "send_group_message", {
        groupId: group.id,
        content: `SCROLL-MSG-${String(i).padStart(4, "0")} ${"长会话滚动验收 ".repeat(6)}`,
        kind: "text", mentions: [], localId: `scroll-msg-${i}`, lang: null,
      });
    }
    for (let i = 0; i < todos; i++) {
      await invoke(a, "send_group_todo", {
        groupId: group.id, title: `SCROLL-TODO-${String(i).padStart(4, "0")} 任务看板首尾可达`,
        assignees: [], description: "任务详情嵌套浮层滚动验收。".repeat(80), images: null,
        category: null, customCategory: null, customIcon: null, relatedOn: null, tags: [], linkedFrom: null,
      });
    }
    const fileDir = path.join(runRoot, "seed-files");
    fs.mkdirSync(fileDir, { recursive: true });
    for (let i = 0; i < files; i++) {
      const file = path.join(fileDir, `SCROLL-FILE-${String(i).padStart(4, "0")}.txt`);
      fs.writeFileSync(file, `F-06 group file ${i}\n`);
      await invoke(a, "send_group_file", { groupId: group.id, path: file, scope: "chat", todoId: null, msgId: null });
    }
    const seededFiles = await invoke(a, "list_group_files", { groupId: group.id });
    if (seededFiles.length < files) throw new Error(`IPC file seed only produced ${seededFiles.length}/${files}`);
    // The seed intentionally bypasses stores. Reload the production entry so the UI reads
    // the committed DB through its normal boot path; no source module or DOM fixture is injected.
    await ready(a, true); await ready(b, true);
    return { a, b, group, deviceA: da.device_id, deviceB: db.device_id, seededFiles: seededFiles.length };
  } catch (e) {
    a.close(); b.close(); throw e;
  }
}

const PAGE_READ = `(() => {
  const host = document.querySelector(${JSON.stringify(".vlist-no-anchor")});
  if (!host) return { present: false };
  const el = host.querySelector('.n-scrollbar-container') || host;
  const rail = host.querySelector('.n-scrollbar-rail--vertical');
  const thumb = rail && rail.querySelector('.n-scrollbar-rail__scrollbar');
  const r = el.getBoundingClientRect();
  const rr = rail && rail.getBoundingClientRect();
  const tr = thumb && thumb.getBoundingClientRect();
  return {
    present: true, top: el.scrollTop, scrollH: el.scrollHeight, clientH: el.clientHeight,
    scrollW: el.scrollWidth, clientW: el.clientWidth, nativeW: el.offsetWidth - el.clientWidth,
    nativeH: el.offsetHeight - el.clientHeight,
    hostDisplay: getComputedStyle(host).display, hostIsolation: getComputedStyle(host).isolation,
    containerDisplay: getComputedStyle(el).display, containerFlex: getComputedStyle(el).flex,
    rect: { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height },
    rail: rr ? { left:rr.left, top:rr.top, right:rr.right, bottom:rr.bottom, width:rr.width, z:getComputedStyle(rail).zIndex } : null,
    thumb: tr ? { left:tr.left, top:tr.top, right:tr.right, bottom:tr.bottom, width:tr.width, height:tr.height } : null,
    docW: document.documentElement.scrollWidth, viewW: innerWidth, viewH: innerHeight
  };
})()`;

async function shot(cdp, file) {
  const out = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(out.data, "base64"));
}

async function checkScroller(cdp, ledger, artifactDir, label, selector, options = {}) {
  const readExpr = `(() => {
    const matches = document.querySelectorAll(${JSON.stringify(selector)});
    const root = ${options.lastDialog ? "matches[matches.length - 1]" : "matches[0]"};
    if (!root) return { present:false };
    const host = root.matches('.n-scrollbar') ? root : (root.querySelector('.n-scrollbar') || root.closest('.n-scrollbar') || root);
    const el = host.querySelector('.n-scrollbar-container') || host;
    const rail = host.querySelector('.n-scrollbar-rail--vertical');
    const thumb = rail && rail.querySelector('.n-scrollbar-rail__scrollbar');
    const r = el.getBoundingClientRect(), rr = rail && rail.getBoundingClientRect(), tr = thumb && thumb.getBoundingClientRect();
    return { present:true, top:el.scrollTop, scrollH:el.scrollHeight, clientH:el.clientHeight,
      scrollW:el.scrollWidth, clientW:el.clientWidth, nativeW:el.offsetWidth-el.clientWidth,
      nativeH:el.offsetHeight-el.clientHeight, hostDisplay:getComputedStyle(host).display,
      hostIsolation:getComputedStyle(host).isolation, containerDisplay:getComputedStyle(el).display,
      containerFlex:getComputedStyle(el).flex, rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
      rail:rr?{left:rr.left,top:rr.top,right:rr.right,bottom:rr.bottom,width:rr.width,z:getComputedStyle(rail).zIndex}:null,
      thumb:tr?{left:tr.left,top:tr.top,right:tr.right,bottom:tr.bottom,width:tr.width,height:tr.height}:null,
      docW:document.documentElement.scrollWidth,viewW:innerWidth,viewH:innerHeight };
  })()`;
  await waitFor(() => cdp.eval(readExpr).then((r) => r.present && (!options.overflow || r.scrollH > r.clientH + 4)), `${label} scroller`, 30_000);
  const before = await cdp.eval(readExpr);
  ledger.add(`${label}: flex height chain is active`, before.hostDisplay === "flex" && before.containerDisplay === "flex" && before.hostIsolation === "isolate", before);
  ledger.add(`${label}: no unexpected horizontal scrollbar`, before.scrollW <= before.clientW + 1 && before.nativeW <= 1 && before.nativeH <= 1 && before.docW <= before.viewW + 1, before);
  await cdp.eval(`(() => { const m=document.querySelectorAll(${JSON.stringify(selector)}); const h=${options.lastDialog ? "m[m.length-1]" : "m[0]"}; const e=h.querySelector('.n-scrollbar-container')||h; e.scrollTop=0; e.dispatchEvent(new Event('scroll',{bubbles:true})); })()`);
  await sleep(500);
  const first = await cdp.eval(readExpr);
  ledger.add(`${label}: first edge reachable`, first.top <= 1, first.top);
  if (options.startText) {
    const visible = await cdp.eval(`(() => { const e=[...document.querySelectorAll('*')].find(x=>x.children.length===0 && x.textContent.includes(${JSON.stringify(options.startText)})); if(!e)return false; const r=e.getBoundingClientRect(); const s=e.closest('.n-scrollbar-container'); if(!s)return false; const q=s.getBoundingClientRect(); return r.bottom<=q.bottom+1 && r.top>=q.top-1 && r.left>=q.left-1 && r.right<=q.right+1; })()`);
    ledger.add(`${label}: seeded head is visible`, visible, options.startText);
  }
  const point = await cdp.eval(`(() => { const m=document.querySelectorAll(${JSON.stringify(selector)}); const h=${options.lastDialog ? "m[m.length-1]" : "m[0]"}; const e=h.querySelector('.n-scrollbar-container')||h; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+Math.min(r.height/2,160)}; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY: 700 });
  await sleep(500);
  const wheeled = await cdp.eval(readExpr);
  ledger.add(`${label}: WebView2 wheel moves the real container`, wheeled.top > first.top + 80, { first: first.top, wheeled: wheeled.top });
  await cdp.eval(`(() => { const m=document.querySelectorAll(${JSON.stringify(selector)}); const h=${options.lastDialog ? "m[m.length-1]" : "m[0]"}; const e=h.querySelector('.n-scrollbar-container')||h; e.scrollTop=e.scrollHeight; e.dispatchEvent(new Event('scroll',{bubbles:true})); })()`);
  await sleep(700);
  const last = await cdp.eval(readExpr);
  ledger.add(`${label}: last edge reachable`, Math.abs(last.top + last.clientH - last.scrollH) <= 3, { top: last.top, clientH: last.clientH, scrollH: last.scrollH });
  if (options.endText) {
    const visible = await cdp.eval(`(() => { const e=[...document.querySelectorAll('*')].find(x=>x.children.length===0 && x.textContent.includes(${JSON.stringify(options.endText)})); if(!e)return false; const r=e.getBoundingClientRect(); const s=e.closest('.n-scrollbar-container'); if(!s)return false; const q=s.getBoundingClientRect(); return r.bottom<=q.bottom+1 && r.top>=q.top-1 && r.left>=q.left-1 && r.right<=q.right+1; })()`);
    ledger.add(`${label}: seeded tail is visible`, visible, options.endText);
  }
  ledger.add(`${label}: rail/thumb geometry stays inside container`, !!last.rail && !!last.thumb && last.thumb.width >= 7 && last.thumb.height >= 23 && last.thumb.top >= last.rail.top - 1 && last.thumb.bottom <= last.rail.bottom + 1 && last.rail.right <= last.rect.right + 1 && last.rail.z === "40", last);
  await shot(cdp, path.join(artifactDir, `${label.replaceAll(/[^a-z0-9_-]+/gi, "_")}.png`));
  return { before, first, wheeled, last };
}

async function clickSvgButton(cdp, svgClass) {
  const clicked = await cdp.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('svg.${svgClass}')); if(!b)return false; b.click(); return true; })()`);
  if (!clicked) throw new Error(`button not found: ${svgClass}`);
}

async function openGroup(cdp, groupName) {
  await cdp.eval(`(() => { const row=[...document.querySelectorAll('[data-conv-row]')].find(x=>x.textContent.includes(${JSON.stringify(groupName)})); if(!row)throw new Error('seeded group row missing'); row.click(); })()`);
  await waitFor(() => cdp.eval(`document.body.innerText.includes(${JSON.stringify(groupName)}) && !!document.querySelector('.vlist-no-anchor .n-scrollbar-container')`), "group timeline", 45_000);
}

async function pageToSeededHead(cdp, selector, text) {
  for (let i = 0; i < 6; i += 1) {
    if (await cdp.eval(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
    await cdp.eval(`(() => { const h=document.querySelector(${JSON.stringify(selector)}); const e=h.querySelector('.n-scrollbar-container')||h; e.scrollTop=0; e.dispatchEvent(new Event('scroll',{bubbles:true})); })()`);
    await sleep(800);
  }
  throw new Error(`timeline did not page back to seeded head ${text}`);
}

async function closeTop(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
}

async function runtimeSmoke(exe, report, artifactDir, ledger) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-ui-scroll-"));
  const instanceA = 960061 + (process.pid % 1000);
  const instanceB = instanceA + 1;
  const portA = num("GOSSLAN_SCROLL_CDP_A", 9561);
  const portB = num("GOSSLAN_SCROLL_CDP_B", 9562);
  for (const port of [portA, portB]) if (await portOpen(port)) throw new Error(`CDP port ${port} already occupied; refuse to read a stale instance`);
  let pa, pb, seeded;
  try {
    pa = await launch(exe, runRoot, instanceA, portA);
    pb = await launch(exe, runRoot, instanceB, portB);
    report.instances = [pa, pb];
    const browser = await waitFor(() => fetch(`http://127.0.0.1:${portA}/json/version`).then((r) => r.json()).catch(() => null), "WebView2 version endpoint", 30_000);
    report.webview2 = { ...(report.webview2 || {}), browser: browser?.Browser, protocol: browser?.["Protocol-Version"] };
    ledger.add("WebView2 runtime version is recorded", !!browser?.Browser, report.webview2);
    if (process.env.GOSSLAN_WEBVIEW2_VERSION && !String(browser?.Browser || "").includes(process.env.GOSSLAN_WEBVIEW2_VERSION)) {
      throw new Error(`WebView2 version mismatch: wanted ${process.env.GOSSLAN_WEBVIEW2_VERSION}, got ${browser?.Browser}`);
    }
    report.webview2Process = powershell(`Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${portA}*' } | Select-Object -First 1 -ExpandProperty CommandLine`);
    const timeoutMs = num("GOSSLAN_SCROLL_TIMEOUT_MS", 600_000);
    const messageCount = num("GOSSLAN_SCROLL_MESSAGES", 140);
    const todoCount = num("GOSSLAN_SCROLL_TODOS", 72);
    const fileCount = num("GOSSLAN_SCROLL_FILES", 64);
    seeded = await seedPeer("F06-SCROLL-GROUP", messageCount, todoCount, fileCount, runRoot, timeoutMs);
    Object.assign(report, { groupId: seeded.group.id, deviceA: seeded.deviceA, deviceB: seeded.deviceB, seededFiles: seeded.seededFiles });
    const a = seeded.a;
    const [locations, locationsB] = await Promise.all([invoke(a, "get_log_locations"), invoke(seeded.b, "get_log_locations")]);
    report.dataLocations = [locations, locationsB];
    const isolatedDb = path.join(path.dirname(locations.dir), `gosslan-${instanceA}.db`);
    const isolatedDbB = path.join(path.dirname(locationsB.dir), `gosslan-${instanceB}.db`);
    report.isolatedDb = [isolatedDb, isolatedDbB];
    const runRootPrefix = path.resolve(runRoot) + path.sep;
    const insideThrowawayRoot = [locations.dir, locationsB.dir].every((p) => path.resolve(p).startsWith(runRootPrefix));
    ledger.add("all app data stays inside the throwaway run directory", insideThrowawayRoot, [locations.dir, locationsB.dir]);
    ledger.add("both instances use separate database files", fs.existsSync(isolatedDb) && fs.existsSync(isolatedDbB) && isolatedDb !== isolatedDbB, report.isolatedDb);
    ledger.add("real IPC: distinct instance identities and group/file seeds", seeded.deviceA !== seeded.deviceB && seeded.seededFiles >= fileCount, { deviceA: seeded.deviceA, deviceB: seeded.deviceB, files: seeded.seededFiles });
    ledger.add("WebView2 runs with the isolated per-instance UDF", String(report.webview2Process || "").includes(pa.userDataDir), report.webview2Process);
    const csp = await a.eval("window.__scrollSmoke.violations");
    report.cspViolations = csp;
    ledger.add("Tauri CSP blocks runtime inline style (not a dev empty policy)", csp.some((v) => String(v.directive).startsWith("style-src") && v.blocked === "inline"), csp.slice(0, 5));
    ledger.add("production boot has no frontend exception", (await a.eval("window.__scrollSmoke.errors")).length === 0, await a.eval("window.__scrollSmoke.errors"));
    const externalCss = await a.eval("[...document.styleSheets].filter(s=>s.href && /\\/assets\\/.*\\.css/.test(s.href)).length");
    ledger.add("production external dist CSS is loaded", externalCss > 0, externalCss);
    const resources = await a.eval("performance.getEntriesByType('resource').map(e=>e.name)");
    report.productionResources = resources;
    ledger.add("runtime resources come from dist, not Vite source", resources.length > 0 && resources.every((u) => !/\/(?:src|node_modules\/\.vite)\//.test(u) && !u.includes("@vite/client")), resources.slice(0, 12));

    await openGroup(a, "F06-SCROLL-GROUP");
    await pageToSeededHead(a, ".vlist-no-anchor", "SCROLL-MSG-0000");
    await checkScroller(a, ledger, artifactDir, "long-session", ".vlist-no-anchor", { overflow: true, startText: "SCROLL-MSG-0000", endText: `SCROLL-MSG-${String(messageCount - 1).padStart(4, "0")}` });

    await clickSvgButton(a, "lucide-folder-open");
    await waitFor(() => a.eval("document.body.innerText.includes('SCROLL-FILE-0000.txt')"), "group files modal", 30_000);
    await checkScroller(a, ledger, artifactDir, "group-files", ".gosslan-dialog-card .gosslan-os", { overflow: true, startText: `SCROLL-FILE-${String(fileCount - 1).padStart(4, "0")}.txt`, endText: "SCROLL-FILE-0000.txt" });
    const menuPoint = await a.eval(`(() => { const e=[...document.querySelectorAll('.gosslan-dialog-card .gosslan-os .n-scrollbar-content > div')].find(x=>x.textContent.includes('SCROLL-FILE-0000.txt')); if(!e)return null; const r=e.getBoundingClientRect(); return {x:r.left+80,y:r.top+20}; })()`);
    if (menuPoint) {
      await a.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", x: menuPoint.x, y: menuPoint.y, clickCount: 1 });
      await a.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "right", x: menuPoint.x, y: menuPoint.y, clickCount: 1 });
      await waitFor(() => a.eval("!![...document.querySelectorAll('.gosslan-menu')].find(x=>x.getBoundingClientRect().width>0)"), "nested file context menu", 10_000);
      const menu = await a.eval(`(() => { const e=[...document.querySelectorAll('.gosslan-menu')].find(x=>x.getBoundingClientRect().width>0); const r=e.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewW:innerWidth,viewH:innerHeight,z:getComputedStyle(e).zIndex}; })()`);
      ledger.add("nested overlay is not clipped by the modal/window", menu.left >= 0 && menu.top >= 0 && menu.right <= menu.viewW + 1 && menu.bottom <= menu.viewH + 1 && Number(menu.z) >= 70, menu);
      await shot(a, path.join(artifactDir, "nested-file-menu.png"));
    } else ledger.add("nested overlay is not clipped by the modal/window", false, "file row had no hit point");
    await closeTop(a); await closeTop(a);

    await invoke(a, "plugin:window|set_size", { label: "main", value: { Logical: { width: 360, height: 640 } } });
    await waitFor(() => a.eval("document.documentElement.classList.contains('is-mobile') && innerWidth<=767 && innerHeight<=700"), "short desktop window/mobile layout", 20_000);
    report.shortWindow = await a.eval("({width:innerWidth,height:innerHeight,mobile:document.documentElement.classList.contains('is-mobile')})");
    await clickSvgButton(a, "lucide-list-checks");
    await waitFor(() => a.eval("!!document.querySelector('[data-todo-row]')"), "embedded task board", 45_000);
    await checkScroller(a, ledger, artifactDir, "task-board-short-window", ".gosslan-dialog-page .gosslan-os", { overflow: true, startText: `SCROLL-TODO-${String(todoCount - 1).padStart(4, "0")}`, endText: "SCROLL-TODO-0000" });
    await a.eval(`(() => { const b=document.querySelector('[data-todo-row] button'); if(!b)throw new Error('todo row button missing'); b.click(); })()`);
    await waitFor(() => a.eval("document.querySelectorAll('[role=dialog]').length>=2"), "nested task detail", 15_000);
    const dialogs = await a.eval(`[...document.querySelectorAll('[role=dialog]')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,viewW:innerWidth,viewH:innerHeight,scrollH:e.scrollHeight,clientH:e.clientHeight}})`);
    ledger.add("short window: nested task detail remains inside viewport", dialogs.length >= 2 && dialogs.every((r) => r.left >= -1 && r.top >= -1 && r.right <= r.viewW + 1 && r.bottom <= r.viewH + 1), dialogs);
    await checkScroller(a, ledger, artifactDir, "task-detail-short-window", "[role=dialog]", { overflow: true, lastDialog: true });
    await shot(a, path.join(artifactDir, "nested-task-detail.png"));
    report.notRun = [
      "Android/iOS soft-keyboard inset and physical keyboard occlusion (Windows desktop has no mobile keyboard)",
      "physical high-resolution/line-mode mouse wheel (CDP mouseWheel is pixel mode only)",
      "Windows ARM64 runtime and multi-monitor DPI",
    ];
    await invoke(a, "plugin:window|set_size", { label: "main", value: { Logical: { width: 1000, height: 680 } } });
  } finally {
    if (seeded) { seeded.a.close(); seeded.b.close(); }
    await stopInstance(pa); await stopInstance(pb);
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

class Ledger {
  constructor() { this.checks = []; }
  add(name, ok, actual) {
    this.checks.push({ name, ok: !!ok, actual });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(actual)}`}`);
  }
}

async function main() {
  if (SELF) {
    const count = runStaticSelfProof();
    console.log(`PASS static/structural self-proof: ${count}/${count} controls (negative examples + wiring)`);
    return;
  }
  if (process.platform !== "win32") {
    console.log("NOT RUN: Windows WebView2 GUI smoke requires windows-latest or a Windows desktop session.");
    console.log("Run npm run test:ui-scroll:win:selfproof for the platform-independent negative controls.");
    process.exitCode = 2;
    return;
  }
  const exe = process.env.GOSSLAN_SCROLL_EXE || path.join(ROOT, "src-tauri/target/x86_64-pc-windows-msvc/release/gosslan.exe");
  const artifactDir = path.join(ROOT, `test-results/ui-scroll-win/run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  const ledger = new Ledger();
  const report = {
    status: "NOT RUN", platform: process.platform, node: process.version, exe,
    checks: ledger.checks, notRun: [],
  };
  try {
    if (!process.env.GOSSLAN_SCROLL_EXE) buildSmokeExe();
    const problems = validateProductionArtifacts({ exe });
    if (problems.length) throw new Error(`production artifact preflight failed:\n- ${problems.join("\n- ")}`);
    report.exeSha256 = sha256(exe);
    report.distIndexSha256 = sha256(path.join(ROOT, "dist/index.html"));
    report.distAssets = fs.readdirSync(path.join(ROOT, "dist/assets")).sort().map((f) => ({ file: f, sha256: sha256(path.join(ROOT, "dist/assets", f)) }));
    report.csp = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
    const version = powershell(`(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.FileVersion`);
    report.webview2 = { fileVersion: version };
    await runtimeSmoke(exe, report, artifactDir, ledger);
    report.status = ledger.checks.every((c) => c.ok) ? "PASS" : "FAIL";
  } catch (e) {
    report.status = "FAIL"; report.error = e.stack || String(e);
    console.error(`FAIL ${report.error}`);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(`${report.status}: ${ledger.checks.filter((c) => c.ok).length}/${ledger.checks.length} checks; report=${path.join(artifactDir, "report.json")}`);
    if (report.status !== "PASS") process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
