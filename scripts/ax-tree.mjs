#!/usr/bin/env node
/**
 * 读 macOS 系统无障碍控件树的**共用件**（编译 + 解析 + "重试到挂上为止"那圈循环）。
 *
 * ★ 为什么单独一份：同一套读数此前有两个消费者 —— `check-ui-runtime-ax.mjs`（自己起实例、判四条）
 *   与 E2E harness（在"对端刚收下那条 @"的同步点上顺手读一次）。
 *   各写一遍解析器就是造第二个事实源：上一轮"第一次读只有 2 个节点"那条机制，
 *   正是因为我只有自己那一份代码、别人按第一次读数下了"产品读不到"的结论才差点被埋掉。
 *
 * 用法（两个都返回**数据**，不判红绿 —— 判不判由调用方定）：
 *   import { probeTree, ensureHelper } from "./ax-tree.mjs";
 *   const r = probeTree(pid);            // r.parsed.webArea / r.parsed.total / r.names / r.tries
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "scripts", "axwalk.swift");

let cachedHelper = null;
/** 把仓里那份遍历器编到临时目录（按源码 mtime 复用；**不污染 target/**）。 */
export function ensureHelper() {
  if (cachedHelper && existsSync(cachedHelper)) return cachedHelper;
  const out = path.join(os.tmpdir(), `gosslan-axwalk-${statSync(SRC).mtimeMs.toString(36)}`);
  if (!existsSync(out)) {
    try {
      execFileSync("swiftc", ["-O", SRC, "-o", out], { stdio: "pipe" });
    } catch (e) {
      throw new Error(
        `编不出 AX 遍历器（需要 Xcode CLT 的 swiftc）：${(e.stderr?.toString?.() ?? e.message).split("\n")[0]}`,
      );
    }
  }
  cachedHelper = out;
  return out;
}

/** 解析遍历器那段人读输出 —— 只认它**打印出来的形状**，不猜。 */
export function parseTree(text) {
  const histLine = (text.match(/角色直方图：(.*)/) ?? [, ""])[1];
  const count = (role) => Number((histLine.match(new RegExp(`${role}=(\\d+)`)) ?? [, "0"])[1]);
  const total = Number((text.match(/遍历到的元素总数=(\d+)/) ?? [, "0"])[1]);
  const windowTitle = (text.match(/── window\[0\] title="([^"]*)"/) ?? [, ""])[1];
  const winRc = (text.match(/AXWindows rc=AXError\(rawValue: (-?\d+)\)/) ?? [, "?"])[1];
  // 可访问名字：读屏真正念出来的就是这一列（`desc` 空时退化到 `title`/`val`，与 #88 那条口径一致）
  const names = [];
  for (const m of text.matchAll(/\[([A-Za-z]+)\/[^\]]*\] desc="([^"]*)" val="([^"]*)" title="([^"]*)"/g)) {
    const label = m[2] || m[4] || m[3];
    if (label && label !== "Gosslan" && label !== "相闻") names.push({ role: m[1], label });
  }
  return {
    histLine, count, total, windowTitle, winRc, names,
    webArea: count("AXWebArea"),
    hung: count("AXWebArea") >= 1,
  };
}

function dumpWith(helper, pid) {
  try {
    return execFileSync(helper, [String(pid)], { encoding: "utf8", maxBuffer: 32 << 20, timeout: 60_000 });
  } catch (e) {
    return (e.stdout ?? "") + `\n(exec 失败: ${e.message})`;
  }
}

/**
 * ★ 关键形状：**读到 AXWebArea 为止**，而不是"读一次然后下结论"。
 * 实测：裸二进制启动后第一次读只有 `AXWindow + AXGroup`（WebKit 懒建 AX 树），
 * 同一进程上第二次读才拿到整棵树；而在别的进程生命周期里还可能遇到
 * `AXWindows rc=-25204`（窗口在屏、AX 却不响应）⇒ 两种空读数都要重试。
 */
export function probeTree(pid, { tries = 8, gapMs = 2000, onEmpty } = {}) {
  const helper = ensureHelper();
  let last = "";
  for (let i = 1; i <= tries; i += 1) {
    last = dumpWith(helper, pid);
    const parsed = parseTree(last);
    if (parsed.hung) return { parsed, tries: i, text: last, helper };
    if (i === 1 && onEmpty) onEmpty(parsed);
    try {
      execFileSync("/bin/sleep", [String(gapMs / 1000)]);
    } catch { /* 采样不该打断被测那一轮 */ }
  }
  return { parsed: parseTree(last), tries, text: last, helper };
}

/** 环境是否具备（调用方据此决定"跳过并明说"还是"判红"）。 */
export function axEnvironmentReady() {
  const problems = [];
  if (process.platform !== "darwin") problems.push(`本平台没有这条路（${process.platform}）`);
  try {
    const on = execFileSync("osascript", ["-e", 'tell application "System Events" to UI elements enabled'],
      { encoding: "utf8" }).trim();
    if (on !== "true") problems.push("跑测试的进程没有『辅助访问』权限");
  } catch {
    problems.push("取不到辅助访问授权状态");
  }
  if (!existsSync(SRC)) problems.push(`缺遍历器源码 ${path.relative(ROOT, SRC)}`);
  return { ready: problems.length === 0, problems };
}

// ---------------- 一次性按钮触发（只对**已存在**的无障碍元素执行 AXPress） ----------------
//
// ★ 为什么这份 swift 源码**内联在本文件里**、而不是新建 `scripts/axpress.swift`：
//   负责人这一轮的硬边界是「只允许修改 `scripts/ax-tree.mjs`，不得修改其他文件」——
//   在仓里多落一个文件同样是越界。内联的代价（源码不独立可读）用下面那条**内容摘要**当缓存键补：
//   改了这个字符串就一定重编，不会出现"读的是新结论、跑的是旧探针"。
//
// ★ 能力边界（先写清楚，别等读数之后才发现它答不了）：
//   `AXPress` 等价于用读屏软件"点开这一项"，只会走到前端**已有**的点击处理（复制设备号 /
//   开设置窗 / 按「刷新数据」）。它不发送消息、不触发重连、不改任何网络状态；
//   匹配不到 needle 就**明说没匹配到**并退出，绝不退化成"按第一个看起来像的"。
const PRESS_SRC = String.raw`
import ApplicationServices
import AppKit
import Foundation

// args: <pid> <needle> <times> <gapMs> [list]
let argv = CommandLine.arguments
guard argv.count >= 2, let pid = Int32(argv[1]) else {
    print("用法: axpress <pid> <needle> [times] [gapMs] [list]"); exit(2)
}
let needle = argv.count > 2 ? argv[2] : ""
let times = argv.count > 3 ? (Int(argv[3]) ?? 1) : 1
let gapMs = argv.count > 4 ? (Int(argv[4]) ?? 120) : 120
let listOnly = argv.count > 5 && argv[5] == "list"

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String { (attr(el, name) as? String) ?? "" }
func label(_ el: AXUIElement) -> String {
    let d = str(el, "AXDescription"), t = str(el, "AXTitle"), v = str(el, "AXValue")
    return [d, t, v].first { !$0.isEmpty } ?? ""
}
let app = AXUIElementCreateApplication(pid)

// WebKit 只在被"要求提供无障碍树"之后才建那棵树：不设这两个键、不激活一次，
// 扫出来就是 0 个元素（仓内那份 dump 遍历器 axwalk.swift 同一套预热，抄它的最小必要部分）。
// 激活只把实例带到前台：不发帧、不重连、不改任何应用数据。
if let ra = NSRunningApplication(processIdentifier: pid) {
    ra.activate(options: [.activateIgnoringOtherApps])
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    usleep(250_000)
}

// 深度上限 80：实测 40 层只够读到菜单栏，WebArea 里的行要更深（与 axwalk.swift 同一经验值）。
func collect(_ el: AXUIElement, _ depth: Int, _ out: inout [String], _ hits: inout [AXUIElement]) {
    if depth > 80 { return }
    let role = str(el, "AXRole")
    let lab = label(el)
    let clickable = role == "AXButton" || role == "AXLink" || role == "AXCheckBox" || role == "AXMenuItem"
    if clickable && !lab.isEmpty {
        out.append("\(depth) \(role) | \(lab)")
        if !listOnly && !needle.isEmpty && lab.contains(needle) { hits.append(el) }
    }
    if let kids = attr(el, "AXChildren") as? [AXUIElement] {
        for k in kids { collect(k, depth + 1, &out, &hits) }
    }
}
func scan() -> ([String], [AXUIElement]) {
    var out: [String] = []
    var hits: [AXUIElement] = []
    guard let wins = attr(app, "AXWindows") as? [AXUIElement] else { return (["__NO_WINDOWS__"], hits) }
    for w in wins { collect(w, 0, &out, &hits) }
    return (out, hits)
}

let (out0, hits) = scan()
if out0 == ["__NO_WINDOWS__"] { print("AXWindows 取不到（窗口在屏但 AX 不响应，或权限不足）"); exit(5) }
print("可点元素数=\(out0.count) 命中=\(hits.count)")
for l in Array(out0.prefix(listOnly ? 400 : 60)) { print("  " + l) }
if listOnly { exit(0) }
if hits.isEmpty { print("没有匹配到 needle=\"\(needle)\" —— 拒绝猜别的元素"); exit(3) }

for i in 1...max(1, times) {
    // 每次重新扫一遍再按：DOM 在点击后可能重建元素，拿旧句柄按下去会静默无效。
    let (_, fresh) = scan()
    guard let first = fresh.first else { print("第 \(i) 次: 命中丢失，停"); exit(4) }
    let rc = AXUIElementPerformAction(first, "AXPress" as CFString)
    print("第 \(i) 次 AXPress rc=\(rc.rawValue)")
    if i < times { usleep(UInt32(gapMs * 1000)) }
}
`;

// ★ 上面那段里不引用任何外部辅助函数（swift 的 `import` 必须在文件最前，拼预置头会直接编不过）。
let pressState = null;

/** 编出按下用的遍历器（编译产物与源都落在**系统临时目录**，不进仓、不进 target/）。 */
function ensurePressHelper() {
  const src = PRESS_SRC;
  const key = createHash("sha256").update(src).digest("hex").slice(0, 12);
  if (pressState && pressState.key === key && existsSync(pressState.bin)) return pressState.bin;
  const srcPath = path.join(os.tmpdir(), `gosslan-axpress-${key}.swift`);
  const bin = path.join(os.tmpdir(), `gosslan-axpress-${key}`);
  writeFileSync(srcPath, src);
  try {
    execFileSync("swiftc", ["-O", srcPath, "-o", bin], { stdio: "pipe" });
  } catch (e) {
    throw new Error(
      `编不出按下用的遍历器（需要 Xcode CLT 的 swiftc）：${(e.stderr?.toString?.() ?? e.message).split("\n")[0]}`,
    );
  }
  pressState = { key, bin };
  return bin;
}

/**
 * 只**列出**该进程里可点的无障碍元素（一个都不按）：先看清有什么，再决定按哪个。
 * @returns {{text:string, items:string[], helper:string}}
 */
export function listPressables(pid) {
  const helper = ensurePressHelper();
  let text = "";
  try {
    text = execFileSync(helper, [String(pid), "", "1", "120", "list"],
      { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60_000 });
  } catch (e) {
    text = `${e.stdout ?? ""}\n(exec 退码 ${e.status ?? "?"}：${e.message.split("\n")[0]})`;
  }
  return { text, items: text.split("\n").filter((l) => /^\s+\d+ AX(Button|Link|CheckBox|MenuItem)/.test(l)), helper };
}

/**
 * 对**已存在**的元素做一次性按下（默认 1 次、不轮询、不加常驻定时器）。
 *
 * `needle` 必须是元素自己的可访问名字（AXTitle / AXDescription / AXValue 里非空的那一个）。
 * 匹配不到就返回 `hitCount:0` 并把探针原话带回来 —— 调用方据此报"读不到"，不许推测补齐。
 *
 * @returns {{ran:boolean, text:string, hitCount:number|null, presses:number, helper:string}}
 */
export function pressElement(pid, needle, { times = 1, gapMs = 120 } = {}) {
  const helper = ensurePressHelper();
  let text = "";
  let status = 0;
  try {
    text = execFileSync(helper, [String(pid), needle, String(times), String(gapMs)],
      { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60_000 });
    status = 0;
  } catch (e) {
    text = `${e.stdout ?? ""}\n(exec 退码 ${e.status ?? "?"}：${e.message.split("\n")[0]})`;
    status = e.status ?? -1;
  }
  const hit = text.match(/可点元素数=(\d+) 命中=(\d+)/);
  const presses = (text.match(/AXPress rc=(\d+)/g) ?? []).filter((s) => s.endsWith("rc=0")).length;
  return {
    ran: status === 0,
    text,
    hitCount: hit ? Number(hit[2]) : null,
    presses,
    helper,
  };
}
