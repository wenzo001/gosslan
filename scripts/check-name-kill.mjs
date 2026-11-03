#!/usr/bin/env node
/**
 * 「按进程名杀进程」守卫。
 *
 * ## 为什么要有它
 * 2026-11-03 的闪退取证里，第 3 项怀疑的就是这一类：脚本用 `pkill -f "target/debug/gosslan"`
 * 按**命令行串**收尾，于是用户自己手开着的实例被一起杀掉 —— 现场看起来就是"应用自己闪退了"，
 * 而日志里当然什么都没有（它没崩，是被别人杀的）。
 *
 * 四处 e2e 脚本（`e2e-dev.sh` / `t2-learn-id.sh` / `t3-presence-relay.sh` / `t4-mirror-dial.sh`）
 * 已经改成「按精确 PID + 可执行路径校验 + `pkill -P` 只收自己的子进程」。但那次修正只在注释里
 * 留了话 —— 下次谁再写一条 `pkill -f`，没有任何东西会拦。本脚本就是那道闸。
 *
 * ## 判据
 * 扫 `scripts/**` 与 `.github/**` 里可执行的文件（`.sh/.mjs/.js/.ts/.py/.ps1/.yml` 与无扩展名的
 * hook），**先剥掉注释与引号外的文本**（注释里点名旧写法不算违规，那是记录不是行为），再判：
 *   1. `pkill -f` / `pkill --full` —— 按命令行串匹配，必然误伤同名实例；
 *   2. `pkill <名字>`（没有 `-P`）—— 按进程名匹配，同上；
 *   3. `killall`；
 *   4. `taskkill … /IM`；
 *   5. 同一行里同时出现 `kill` 与 `pgrep`（把按名字枚举的结果喂给 kill）；
 *   6. PowerShell 的 `Stop-Process -Name` / `Get-Process … | Stop-Process`；
 *   7. `osascript … quit app`。
 *
 * **允许**：`pkill -P <pid>`（只收自己的子进程）、`kill <pid>` / `process.kill(pid)`、
 * `Stop-Process -Id <pid>` —— 这些都是精确 PID。
 *
 * ## 自证（防止闸自己空转）
 * 脚本内置 7 条反例 + 7 条正例，每次运行先跑夹具：反例必红、正例必绿，任何一条不对就整体 exit 1。
 * 扫到 0 个文件也判红（说明路径/扩展名前提变了），不许把"什么都没扫"当成通过。
 *
 * 退出码：0 = 通过；1 = 有违规或自证失败。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描范围：会执行、且能起/杀进程的那几类。 */
const SCAN_EXT = new Set([".sh", ".mjs", ".js", ".cjs", ".ts", ".py", ".ps1", ".yml", ".yaml"]);
/** 无扩展名的执行文件（hook 之类）也要扫。 */
const NO_EXT_FILES = new Set(["scripts/git-hooks/commit-msg"]);

/** 注释风格：`#` 族（shell / yaml / python / powershell）与 `//` 族（JS / TS）。 */
const HASH_FAMILY = new Set([".sh", ".yml", ".yaml", ".py", ".ps1"]);

/** 匹配一条（已剥注释的）文本行，返回违规说明数组。 */
export function violationsInLine(line) {
  const out = [];
  // 1/2. pkill —— 逐个 occurrence 看参数
  for (const m of line.matchAll(/\bpkill\b([^|;&\n]*)/g)) {
    const args = m[1];
    if (/(?:^|\s)(?:-f|--full)(?:\s|$)/.test(args)) {
      out.push("pkill 按命令行串匹配（-f/--full）");
    } else if (!/(?:^|\s)-P(?:\s|$)/.test(args)) {
      // `-P` 是精确 PID 的父进程过滤，唯一允许的形态；其余（含裸 `pkill name`）都按名字杀。
      out.push("pkill 按进程名匹配（缺 -P <pid>）");
    }
  }
  // 3. killall
  if (/\bkillall\b/.test(line)) out.push("killall 按进程名杀");
  // 4. taskkill /IM
  if (/\btaskkill\b[^|;&\n]*\/IM\b/i.test(line)) out.push("taskkill /IM 按映像名杀");
  // 5. kill 与 pgrep 同一行（把按名字枚举的结果喂给 kill）
  if (/\bkill\b/.test(line) && /\bpgrep\b/.test(line)) out.push("把 pgrep 按名字枚举的结果喂给 kill");
  // 6. PowerShell 按名字
  if (/\bStop-Process\b[^|;&\n]*\s-Name\b/.test(line)) out.push("Stop-Process -Name 按进程名杀");
  if (/\bGet-Process\b[^|;&\n]*\|\s*Stop-Process/.test(line)) out.push("Get-Process 按名字过滤后 Stop-Process");
  return out;
}

/**
 * 剥掉注释，并把**引号内的文字清空**（提示语里写的 `pkill -f` 是记录/报错文案，不是行为）。
 * 块注释先替换成等量空白以保持行号不变；引号内的 `#` / `//` 不会被当成注释。
 */
function stripComments(text, ext) {
  let t = text;
  if (!HASH_FAMILY.has(ext)) {
    t = t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  }
  const marker = HASH_FAMILY.has(ext) ? "#" : "//";
  return t
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
        } else if (line.startsWith(marker, i)) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** 把引号内的内容换成空格（保留引号本身），只留会被真正执行的文字。 */
function blankQuoted(line) {
  let out = "";
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += " ";
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 一行 → 违规说明数组（先剥注释；引号内文字清空后再判，osascript 的脚本正文例外）。 */
export function analyzeLine(rawLine, ext = ".sh") {
  const stripped = stripComments(rawLine, ext);
  const out = violationsInLine(blankQuoted(stripped));
  // `osascript -e '…quit app "Gosslan"'`：要退出的应用名**就在引号里**，必须按原文判。
  if (/\bosascript\b[^|;&\n]*\bquit app\b/i.test(stripped)) out.push("osascript quit app 按应用名退出");
  return out;
}

// ---------------- 自证夹具 ----------------
const MUST_FLAG = [
  'pkill -f "target/debug/gosslan"',
  "pkill gosslan",
  "killall gosslan",
  "taskkill /IM gosslan.exe /F",
  'kill -9 $(pgrep -f gosslan)',
  "Stop-Process -Name gosslan -Force",
  "Get-Process gosslan | Stop-Process -Force",
  'osascript -e \'quit app "Gosslan"\'',
];
const MUST_PASS = [
  'pkill -P "$pid"',
  'kill "$pid"',
  "process.kill(pid, 0)",
  "Stop-Process -Id $p.Id -Force",
  "# 旧写法 pkill -f \"target/debug/gosslan\" 会把用户实例一起杀掉",
  "// pkill -f 之类的旧写法已废弃",
  'echo "pkill -f 只写在提示语里"',
];

function selfcheck() {
  const bad = [];
  for (const s of MUST_FLAG) if (!analyzeLine(s, ".sh").length) bad.push(`该红的没红：${s}`);
  for (const s of MUST_PASS) {
    const v = analyzeLine(s, s.trimStart().startsWith("//") ? ".mjs" : ".sh");
    if (v.length) bad.push(`该绿的判红了：${s} ⇒ ${v.join("、")}`);
  }
  if (bad.length) {
    console.error("✗ 守卫自证失败（判据自己被改坏了，先修本脚本再说）：");
    for (const b of bad) console.error(`  · ${b}`);
    process.exit(1);
  }
}
selfcheck();

// ---------------- 扫描 ----------------
const files = execFileSync("git", ["ls-files", "scripts", ".github"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => {
    if (f === "scripts/check-name-kill.mjs") return false; // 本脚本里的正则字面量不是行为
    if (NO_EXT_FILES.has(f)) return true;
    return SCAN_EXT.has(path.extname(f));
  });

if (files.length < 20) {
  console.error(
    `✗ 只扫到 ${files.length} 个脚本文件（今天至少 20 个）\n` +
      "  ⇒ 扫描前提变了（路径/扩展名改了，或 git 索引为空），拒绝把空转当通过。",
  );
  process.exit(1);
}

const fails = [];
let scanned = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  scanned++;
  const ext = path.extname(rel);
  const lines = stripComments(fs.readFileSync(abs, "utf8"), ext).split("\n");
  lines.forEach((line, i) => {
    for (const why of analyzeLine(line, ext)) {
      fails.push(`${rel}:${i + 1} ${why}\n    ${line.trim().slice(0, 160)}`);
    }
  });
}

if (fails.length) {
  console.error(`✗ 按进程名杀进程：${fails.length} 处（会误伤用户手开的同名实例，现场表现为「闪退」）`);
  for (const f of fails) console.error(`  · ${f}`);
  console.error("\n  修法：改为「精确 PID + 可执行路径校验」；子进程用 `pkill -P <pid>`。");
  console.error("  口径同 scripts/e2e-dev.sh、t2/t3/t4 与 verify-startup-error.mjs。");
  process.exit(1);
}

console.log(`✓ 按进程名杀进程：扫了 ${scanned} 个脚本，没有违规（pkill -P / kill <pid> 属允许形态）。`);
