#!/usr/bin/env node
/**
 * 启动失败路径的**真窗口**验收入口（审计 A2 / A7）—— 只在 macOS 桌面手动跑，不进门禁。
 *
 * ★ 为什么单独一个入口：A2 那一格的全部风险都在"真实进程 + 真实窗口 + 真实文件系统"这一层，
 *   而这一层任何源码级判据都看不见：
 *   `startup_error.rs` 的三个单测判的是门控纯函数（`retry_gate`/`claim_retry`/文案），
 *   `desktop_misc.py` 那条护栏判的是"setup 失败分支里那句 `startup_error::open(...)` 还在"。
 *   两者全绿也不能证明"数据库打不开时屏幕上真有一扇能点的窗"。
 *
 * ★ 为什么拆成 launch / status / stop 三个子命令而不是一条命令跑完：
 *   三个按钮（重试 / 打开数据目录 / 退出）必须由**真实鼠标事件**点（`closable(false)` 的窗口
 *   没有别的出口），而点这一下属于人/桌面自动化，不属于本脚本。脚本负责的两件事是
 *   ①把环境搭成可复现的形状（隔离 HOME + 准确的 PID），②把读数打成机器值 ——
 *   点击前后的读数都由调用方在两次 `status` 里现取。
 *
 * ★ 隔离（用户 §七 的硬约束）：
 *   - 每个场景一个**独立 HOME**（`--home` 指向一个临时目录；数据目录 = `$HOME/Library/
 *     Application Support/com.gosslan.app`），真实用户库不可能被这批实验碰到；
 *   - 实例号默认 91/92（harness 用 1/2/3、AX 验收用 41），即使 HOME 没生效也只落到一个
 *     没人用过的库名上，且 `status` 会打印它**实际**落在哪儿；
 *   - 只 `kill` 自己刚 spawn 的那个 PID（并校验它的可执行路径确实是本仓 release 二进制），
 *     全脚本没有任何 pkill / 按名字杀进程。
 *
 * 用法：
 *   node scripts/verify-startup-error.mjs launch --home /tmp/a2-1 --instance 91 [--break perms|corrupt|busy]
 *   node scripts/verify-startup-error.mjs status --home /tmp/a2-1 --instance 91
 *   node scripts/verify-startup-error.mjs stop   --home /tmp/a2-1 --instance 91
 *
 * 退出码：0 = 读数取到（**不判红绿**，判据在调用方）；2 = 环境不具备 / 参数不认识。
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { axEnvironmentReady, listPressables, pressElement, probeTree } from "./ax-tree.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "src-tauri", "target", "release", "gosslan");
const BUNDLE_ID = "com.gosslan.app";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MODE = process.argv[2];
if (!["launch", "status", "stop", "clean", "list", "press"].includes(MODE)) {
  console.error(
    `✗ 不认识的子命令「${MODE}」（可选 launch / status / stop / clean / list / press）⇒ 拒绝执行，不猜`,
  );
  process.exit(2);
}
const HOME = path.resolve(arg("home", ""));
const INSTANCE = Number(arg("instance", "91"));
if (!HOME || !Number.isInteger(INSTANCE) || INSTANCE <= 0) {
  console.error("✗ 必须给 --home <目录> 与正整数 --instance（默认 91，别撞 harness 的 1/2/3）");
  process.exit(2);
}
const APP_DATA = path.join(HOME, "Library", "Application Support", BUNDLE_ID);
// `--plain` 走真实用户那一条：不带 GOSSLAN_INSTANCE ⇒ 应用侧 `instance_id()` 是 0，
// 于是库名/状态文件名都回到默认那一份。**名字必须跟着环境走**，否则 status 读的是
// 一个根本不存在的文件，读数会把"没测到"印成"是空的"。
const PLAIN = Boolean(arg("plain", ""));
const DB = path.join(APP_DATA, PLAIN ? "gosslan.db" : `gosslan-${INSTANCE}.db`);
// A7 那一格的落点：`window_state_filename(instance)` ⇒ `.window-state-i<n>.json`
// （instance 0 才是插件默认的 `.window-state.json`）。名字写错就是读别人的文件。
const STATE_FILE = path.join(APP_DATA, PLAIN ? ".window-state.json" : `.window-state-i${INSTANCE}.json`);
const PID_FILE = path.join(HOME, ".qoder-a2-pid");
// ⚠️ pid 与 stderr 都必须落在 **APP_DATA 之外**：perms 那一格把 APP_DATA 变成只读，
// 而应用的日志目录就在它里面 ⇒ 那一格的产品侧读数为零。stderr 是唯一还能拿到"是哪一步失败"
// 的通道（`startup_error::open` 建窗失败时也只往 stderr 打）。
const STDERR_FILE = path.join(HOME, "stderr.log");
// 只允许在系统临时目录里玩：`clean` 会 rm -rf 整棵 --home，路径写错一次就是删用户的家。
const TMP_ROOTS = ["/private/tmp/", "/tmp/", `${realpathSync(os.tmpdir())}/`];
if (!TMP_ROOTS.some((r) => `${HOME}/`.startsWith(r))) {
  console.error(
    `✗ --home 必须在系统临时目录里（拿到的是 ${HOME}）⇒ 拒绝：这批实验会 chmod/rm 这棵树`,
  );
  process.exit(2);
}
// 真实 HOME 的同名路径：只用来**证明这批实验没写到那里**，任何分支都不往它写。
// ⚠️ 不能用 `os.homedir()`：它读 `$HOME`，而本脚本**正是**在覆盖 `$HOME` ⇒ 拿回来的会是
// 那棵临时树，于是"没碰到真实目录"这条读数由被检查对象自己回答（恒真机）。
// `os.userInfo()` 走 getpwuid，不受环境变量影响。
const REAL_APP_DATA = path.join("/Users", os.userInfo().username, "Library", "Application Support", BUNDLE_ID);

const sha = (f) =>
  existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16) : "(不存在)";
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** 这个 PID 是不是**本仓那份** release 二进制（防手滑杀掉用户自己开着的实例）。 */
const isOurBinary = (pid) => {
  if (!pid) return false;
  const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
  return (r.stdout || "").trim() === BIN;
};
const readPid = () => {
  if (!existsSync(PID_FILE)) return null;
  return Number(readFileSync(PID_FILE, "utf8").trim());
};
const logDir = () => path.join(APP_DATA, "logs");
/** 日志里所有 needle 的**出现次数**（不是存在性）：A2 那几条要看的是"第几轮写的"。 */
const logCounts = (needles) => {
  const dir = logDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")) : [];
  const text = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  const out = {};
  for (const n of needles) out[n] = text.split("\n").filter((l) => l.includes(n)).length;
  return { files: files.length, counts: out, dir: files.length ? dir : "(还没有日志目录)" };
};
/** 崩溃便签（`logging::crash_note`）里的那几个 code：错误码比日志行更硬，它不会被轮转冲掉。 */
const crashNotes = () => {
  const dir = logDir();
  if (!existsSync(dir)) return "(还没有日志目录)";
  const hits = [];
  for (const f of readdirSync(dir)) {
    if (!/\.(log|txt|json)$/i.test(f)) continue;
    const t = readFileSync(path.join(dir, f), "utf8");
    for (const line of t.split("\n")) {
      if (/code=(BOOT_FAILED|BOOT_RETRY_FAILED|STARTUP_ERROR_WINDOW_FAILED)/.test(line)) {
        hits.push(`${f}: ${line.trim().slice(0, 200)}`);
      }
    }
  }
  return hits;
};
/** 这扇进程当前有哪些窗口（AX 层）：A2 要的那一格是"屏幕上真有一扇能看见的窗"。 */
const windowsOf = (pid) => {
  if (!alive(pid)) return { error: "进程不在" };
  try {
    // tries 压到 2：busy 那一格里主线程正在等 SQLite，AX 每次要满 60s 超时才回，
    // 8 次重试会把读数变成"卡住"而不是"窗口是什么"。两次拿不到就按拿不到报。
    const r = probeTree(pid, { tries: 2, gapMs: 1000 });
    // `windowTitle` / `winRc` 是这格判据的正主：A2 要的是"屏幕上真有一扇窗"，
    // 而标题「Gosslan — 启动失败」只有独立错误窗会给 ⇒ 它同时是"没有窗"的否证入口。
    return {
      total: r.parsed?.total ?? 0,
      webArea: r.parsed?.webArea ?? 0,
      windowTitle0: r.parsed?.windowTitle ?? "",
      windowsRc: r.parsed?.winRc ?? "?",
      // 每扇窗自己的标题（错误窗的「Gosslan — 启动失败」只有在这里才看得见）
      windowTitles: [...(r.text || "").matchAll(/── window\[(\d+)\] title="([^"]*)"/g)].map(
        (m) => `${m[1]}:${m[2]}`,
      ),
      names: (r.parsed?.names || []).slice(0, 40).map((n) => `${n.role}|${n.label}`),
      tries: r.tries,
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
};

/** 注入到现在**还**拦不拦得住写：用真写一次来问（而不是读 mode 猜）。失败才算注入成立。 */
const probe = (fn) => {
  try {
    fn();
    return { writable: true };
  } catch (e) {
    return { writable: false, err: String(e.code || e.message).split("\n")[0] };
  }
};

const report = (obj) => console.log(JSON.stringify(obj, null, 2));

if (MODE === "launch") {
  if (!existsSync(BIN)) {
    console.error(`✗ 没有 release 二进制 ${BIN} ⇒ 先 (cd src-tauri && cargo build --release --features bluetooth)`);
    process.exit(2);
  }
  const BREAK = arg("break", "");
  if (BREAK && !["perms", "readonly", "corrupt", "busy"].includes(BREAK)) {
    console.error(`✗ 不认识的 --break「${BREAK}」（可选 perms / readonly / corrupt / busy / 空=正常启动）`);
    process.exit(2);
  }
  const realDbBefore = existsSync(path.join(REAL_APP_DATA, `gosslan-${INSTANCE}.db`));
  mkdirSync(APP_DATA, { recursive: true, mode: 0o700 });
  // 故障注入（全部只发生在 --home 那棵树里）：
  //   perms    = 数据目录不可再写（chmod 0500 **+ chflags uchg**）
  //   readonly = 主库文件不可写（chmod 0444 + chflags uchg）⇒ 对应"数据库权限不足"那一格
  //   corrupt  = 主库写成非数据库字节 ⇒ "file is not a database"
  //   busy     = 另一个进程持 EXCLUSIVE 锁 ⇒ SQLite busy（"暂时不可用"那一格）
  // ★ 为什么 perms 不能只用 chmod（2026-10-31 实测）：把目录置 0500 之后应用**照样起得来** ——
  //   `restrict_dir_to_owner` 在启动路径上就把自己那棵树 chmod 回 0700，而 owner 对只读目录
  //   仍然可以 chmod。只 chmod 的注入会被产品自己治好，于是"错误窗出现"那一格会静默地不发生。
  //   `chflags uchg` 是 owner 也解不开的一层（除非显式 nouchg），能把这一格真正钉住。
  const chflags = (on, p) => {
    try {
      execFileSync("chflags", [on ? "uchg" : "nouchg", p], { stdio: "pipe" });
    } catch (e) {
      console.error(`✗ chflags ${on ? "uchg" : "nouchg"} 失败 ⇒ 注入不成立，拒绝假装跑过：${e.message.split("\n")[0]}`);
      process.exit(2);
    }
  };
  if (BREAK === "perms") {
    chmodSync(APP_DATA, 0o500);
    chflags(true, APP_DATA);
  }
  if (BREAK === "readonly") {
    writeFileSync(DB, "", { mode: 0o444 });
    chflags(true, DB);
  }
  if (BREAK === "corrupt") writeFileSync(DB, "这不是一个 SQLite 文件\n".repeat(64), { mode: 0o600 });
  let locker = null;
  if (BREAK === "busy") {
    // `sqlite3 <db>` 不带 SQL 参数才是**交互模式**：带 SQL 参数会跑完就退出 ⇒ 锁当场放开，
    // 于是"注入了 busy"与"什么都没注入"在下一格读数里长得一样。这里靠 stdin 保持它活着，
    // 并在报告里打印它是否真的还活着（活着才算注入成立）。
    const r = spawnSync("which", ["sqlite3"], { encoding: "utf8" });
    if (!r.stdout.trim()) {
      console.error("✗ 环境里没有 sqlite3 ⇒ busy 这一格的注入做不到（不是通过，也不是跳过）");
      process.exit(2);
    }
    writeFileSync(DB, "");
    locker = spawn("sqlite3", [DB], { stdio: ["pipe", "ignore", "pipe"] });
    locker.stdin.write("begin exclusive transaction;\n");
    await new Promise((res) => setTimeout(res, 800));
  }
  const child = spawn(BIN, [], {
    detached: true,
    stdio: ["ignore", "ignore", openSync(STDERR_FILE, "w")],
    // `--plain` 走的是**真实用户那一条**：不带 GOSSLAN_INSTANCE / GOSSLAN_AUTOSTART。
    // 这两个键一设，`allow_second_instance_launch` 就会**不装**单实例插件（多开只用于开发），
    // 于是"单实例限制"那一格在非 plain 模式下测不到 —— 它会显示"两个进程都活着"这种假读数。
    env: {
      ...process.env,
      HOME,
      ...(PLAIN ? {} : { GOSSLAN_INSTANCE: String(INSTANCE), GOSSLAN_AUTOSTART: "1" }),
    },
  });
  child.unref();
  if (locker) {
    locker.unref();
    writeFileSync(`${PID_FILE}.locker`, `${locker.pid}\n`);
  }
  writeFileSync(PID_FILE, `${child.pid}\n`);
  report({
    mode: "launch",
    break: BREAK || "(none)",
    pid: child.pid,
    home: HOME,
    appData: APP_DATA,
    db: { path: DB, sha256_16: sha(DB), bytes: existsSync(DB) ? statSync(DB).size : null },
    realHomeAlreadyHadSameInstanceDb: realDbBefore,
    // 注入是否**真的生效**：busy 那一格靠这个读数区分"锁着"与"sqlite3 一开局就退了"。
    busyLocker: locker ? { pid: locker.pid, alive: locker.exitCode === null && !locker.killed } : null,
    permsModeNow: existsSync(APP_DATA) ? (statSync(APP_DATA).mode & 0o777).toString(8) : "(不存在)",
    note: "读数请再跑一次 status（启动需要时间）",
  });
}

if (MODE === "status") {
  const pid = readPid();
  const logs = logCounts([
    "启动失败：",
    "重试仍然失败：",
    "AppState::init 完成（设置/目录/局域网就绪）",
    "AppState::init 之前",
  ]);
  report({
    mode: "status",
    pid,
    processAlive: alive(pid),
    plain: PLAIN,
    instance: PLAIN ? 0 : INSTANCE,
    isOurBinary: isOurBinary(pid),
    appData: APP_DATA,
    appDataMode: existsSync(APP_DATA) ? (statSync(APP_DATA).mode & 0o777).toString(8) : "(不存在)",
    db: { path: DB, sha256_16: sha(DB), bytes: existsSync(DB) ? statSync(DB).size : null },
    windowStateFile: {
      path: STATE_FILE,
      exists: existsSync(STATE_FILE),
      bytes: existsSync(STATE_FILE) ? statSync(STATE_FILE).size : null,
      // A7 判的是"各实例存回自己的几何、重启后恢复各自"⇒ 要读到**值**，不是只读"有没有"。
      content: existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null,
    },
    windowStateFilesPresent: existsSync(APP_DATA)
      ? readdirSync(APP_DATA).filter((f) => f.startsWith(".window-state"))
      : [],
    logFiles: logs.files,
    logDir: logs.dir,
    logCounts: logs.counts,
    injectHeld: {
      dirWritable: probe(() => {
        const p = path.join(APP_DATA, ".qoder-probe");
        mkdirSync(p);
        rmSync(p);
      }),
      dbWritable: probe(() => {
        const fd = openSync(DB, "r+");
        closeSync(fd);
      }),
    },
    // perms 那一格里日志目录根本建不出来 ⇒ stderr 是唯一的产品侧读数。
    stderrTail: existsSync(STDERR_FILE)
      ? readFileSync(STDERR_FILE, "utf8").split("\n").filter(Boolean).slice(-12)
      : "(没有 stderr 文件)",
    crashNotes: crashNotes(),
    axWindows: windowsOf(pid),
    realHomeTouched: {
      dir: REAL_APP_DATA,
      dbForThisInstanceExists: existsSync(path.join(REAL_APP_DATA, `gosslan-${INSTANCE}.db`)),
    },
  });
}

if (MODE === "list" || MODE === "press") {
  const env = axEnvironmentReady();
  if (!env.ready) {
    console.error(`✗ 环境不具备 ⇒ 不是通过：${env.problems.join(" / ")}`);
    process.exit(2);
  }
  const pid = readPid();
  if (!alive(pid) || !isOurBinary(pid)) {
    console.error(`✗ PID ${pid} 不在或不是本仓那份二进制 ⇒ 拒绝操作它的界面`);
    process.exit(2);
  }
  if (MODE === "list") {
    const r = listPressables(pid);
    report({ mode: "list", pid, itemCount: r.items.length, items: r.items });
  } else {
    const NEEDLE = arg("needle", "");
    if (!NEEDLE) {
      console.error(
        "✗ press 必须带 --needle <元素自己的可访问名字>（不给就拒绝，绝不按「看起来像的那个」）",
      );
      process.exit(2);
    }
    const before = alive(pid);
    const r = pressElement(pid, NEEDLE);
    report({
      mode: "press",
      pid,
      needle: NEEDLE,
      ran: r.ran,
      hitCount: r.hitCount,
      presses: r.presses,
      wasAliveBefore: before,
      stillAliveAfter: alive(pid),
      probeText: (r.text || "").split("\n").slice(0, 12),
    });
  }
}

if (MODE === "clean") {
  // perms 注入会把数据目录留在 0500：先逐层 chmod 回来才删得掉，否则 rmSync 报 EACCES，
  // 而"清理失败"会被下一次实验读成"上一次的残留"。只碰这棵 tmp 树（开头已按前缀拒过）。
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    try {
      execFileSync("chflags", ["nouchg", dir], { stdio: "pipe" });
    } catch {}
    try {
      chmodSync(dir, 0o700);
    } catch {}
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {}
      if (!isDir) {
        try {
          execFileSync("chflags", ["nouchg", p], { stdio: "pipe" });
          chmodSync(p, 0o600);
        } catch {}
        continue;
      }
      walk(p);
    }
  };
  walk(HOME);
  rmSync(HOME, { recursive: true, force: true });
  report({ mode: "clean", home: HOME, gone: !existsSync(HOME) });
}

if (MODE === "stop") {
  const pid = readPid();
  if (!pid) {
    console.error("✗ 没有 pid 文件 ⇒ 不是本脚本起的进程，拒绝动手");
    process.exit(2);
  }
  if (!isOurBinary(pid)) {
    console.error(`✗ PID ${pid} 不是本仓那份 release 二进制 ⇒ 拒绝 kill（可能是用户自己开的实例）`);
    process.exit(2);
  }
  const before = alive(pid);
  process.kill(pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  const lockerPid = existsSync(`${PID_FILE}.locker`) ? Number(readFileSync(`${PID_FILE}.locker`, "utf8").trim()) : null;
  if (lockerPid && alive(lockerPid)) process.kill(lockerPid, "SIGKILL");
  report({ mode: "stop", pid, wasAlive: before, stillAlive: alive(pid), lockerPid });
}
