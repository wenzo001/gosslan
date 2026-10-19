#!/usr/bin/env node
/**
 * 内存观测器（macOS 优先）。目的不是"证明有泄漏"，而是把三条本来混在一起的东西分开：
 *   ① 主进程（Rust/Tao）自己涨，② WebView 的 WebContent 进程涨，③ 系统层面谁都涨。
 *
 * 为什么必须分进程看：Tauri 的界面不在主进程里 —— WKWebView 的内容跑在
 * `com.apple.WebKit.WebContent` 这个独立进程，"界面卡死/内存涨"到底在哪一侧，
 * 只看主进程 RSS 是读不出来的（只看总 RSS 也读不出来）。
 *
 * 读数口径（写死在这里，别靠事后解释）：
 *   · `footprint` —— 若可用，取 `physical footprint`（iOS/OOM  jetsam 用的就是这一项，
 *     它比 RSS 更接近"系统会因此杀你吗"）。
 *   · `rss` —— `ps` 给的常驻集，含被压缩与共享的页；**它不等于 JS 堆，也不等于泄漏**。
 *   · JS 堆快照：**WKWebView 没有 CDP**，本脚本拿不到 ⇒ 如实记 `jsHeap: NOT RUN`，
 *     不许用 RSS 冒充 JS 堆。
 *
 * 用法：
 *   node scripts/mem-sample.mjs --duration 90000 --interval 3000 --out /tmp/mem.json -- <被观测的启动命令...>
 *   node scripts/mem-sample.mjs --duration 60000 --attach-only          # 已经在跑，只观测
 * 输出：每 5 个采样点打一行进度，结束时打印基线 / 峰值 / 结束值 / 回落 + 每个 pid 的序列。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);
const numArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const DURATION = numArg("duration", 60_000);
const INTERVAL = numArg("interval", 3_000);
const OUT = (() => {
  const i = argv.indexOf("--out");
  return i >= 0 ? argv[i + 1] : "/tmp/mem-sample.json";
})();
const ATTACH_ONLY = argv.includes("--attach-only");
const cmdIdx = argv.indexOf("--");
const LAUNCH = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : [];

/** 关注的进程分组：主进程 / WebView 内容进程 / GPU 进程。 */
function groupOf(comm) {
  if (/WebKit\.WebContent$/.test(comm)) return "webContent";
  if (/WebKit\.GPU$/.test(comm)) return "webGPU";
  if (/WebKit\.Network$/.test(comm)) return "webNetwork";
  if (/\/gosslan$|gosslan\.app\/Contents\/MacOS\//.test(comm)) return "app";
  return null;
}

function snapshot() {
  // ps 的 rss 单位是 KB；comm 里可能含空格，所以把 rss 放在倒数第一列之外自己拆
  const raw = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
  const rows = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, rssKb, comm] = m;
    const g = groupOf(comm.trim());
    if (!g) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), group: g, rssKb: Number(rssKb), comm: comm.trim() });
  }
  return rows;
}

/** `footprint` 不是所有机器都有；有就用，没有就退回 RSS 并记下用的是哪个口径。 */
let footprintAvailable = null;
function footprintKb(pid) {
  if (footprintAvailable === false) return null;
  try {
    const out = execFileSync("footprint", ["-p", String(pid), "--procwide"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    footprintAvailable = true;
    // 取属于该 pid 那一行的 physical footprint（KB）
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*\d+\s+\d+\s+(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {
    /* 没装或没权限：整个进程生命周期内只试一次，别每 3 秒 fork 一次把它当探针 */
    footprintAvailable = false;
  }
  return null;
}

function tally(rows) {
  const t = {};
  for (const r of rows) {
    const fb = footprintKb(r.pid);
    const kb = fb ?? r.rssKb;
    t[r.group] = (t[r.group] ?? 0) + kb;
    t[`${r.group}:pids`] = [...(t[`${r.group}:pids`] ?? []), `${r.pid}:${kb}`];
    t[`${r.group}:metric`] = fb ? "footprint" : "rss";
  }
  return t;
}

const series = [];
let child = null;
if (!ATTACH_ONLY && LAUNCH.length) {
  child = spawn(LAUNCH[0], LAUNCH.slice(1), { stdio: "ignore", detached: true });
}

const t0 = Date.now();
// 采样点先给 5 秒稳态窗口：刚启动时 WebView 还在加载，那一段不算基线
await new Promise((r) => setTimeout(r, 5_000));
while (Date.now() - t0 < DURATION) {
  const rows = snapshot();
  const t = tally(rows);
  series.push({ atMs: Date.now() - t0, app: t.app ?? 0, webContent: t.webContent ?? 0, webGPU: t.webGPU ?? 0, appPids: t["app:pids"] ?? [], webPids: t["webContent:pids"] ?? [], metric: t["app:metric"] ?? "rss" });
  await new Promise((r) => setTimeout(r, INTERVAL));
}

// ⚠️ 分组求和的 baseline/final 会被"进程本身不存在"污染：压力测试里被测进程是**起了又停**的，
// 采样窗口两端恰好没有进程时，求和就是 0 —— 于是 "final - baseline = 0" 会被读成
// "内存完全恢复"，而真实含义是"两端都没在跑"。所以主读数改成**按 pid 的存活轨迹**，
// 分组求和只保留 peak，并把覆盖率一起报出来（coverage < 1 时基线/终值一律标 null）。
const parsePids = (list) =>
  (list ?? []).map((entry) => {
    const i = entry.lastIndexOf(":");
    return { pid: entry.slice(0, i), kb: Number(entry.slice(i + 1)) };
  });

const trajectories = (key) => {
  const byPid = new Map();
  for (const s of series) {
    for (const { pid, kb } of parsePids(s[key])) {
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push({ atMs: s.atMs, kb });
    }
  }
  return [...byPid.entries()].map(([pid, pts]) => {
    const kb = pts.map((x) => x.kb);
    const half = Math.floor(kb.length / 2);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    return {
      pid,
      samples: kb.length,
      aliveMs: pts[pts.length - 1].atMs - pts[0].atMs,
      first: kb[0],
      peak: Math.max(...kb),
      last: kb[kb.length - 1],
      // 单调增长的粗筛：后半段均值减前半段均值（正得多 = 在涨；样本 <4 条不判）
      driftSecondMinusFirstHalfKb: kb.length >= 4 ? Math.round(mean(kb.slice(half)) - mean(kb.slice(0, half))) : null,
    };
  });
};

const groupStat = (sumKey, pidKey) => {
  const arr = series.map((s) => s[sumKey]);
  const traj = trajectories(pidKey);
  const seen = arr.filter((v) => v > 0).length;
  const covered = traj.filter((t) => t.samples >= 2);
  return {
    peakKb: arr.length ? Math.max(...arr) : null,
    samples: arr.length,
    // 有多少采样窗口里真的有这个组的过程在跑
    coverage: `${seen}/${arr.length}`,
    distinctPids: traj.length,
    // 只有**同一个 pid** 的首末读数才能当"运行一段时间后"的比较
    pidsWithTrajectory: covered.length,
    baselineKb: covered.length ? covered[0].first : null,
    finalKb: covered.length ? covered[covered.length - 1].last : null,
    note: covered.length
      ? null
      : "没有任何 pid 有 ≥2 个采样点 ⇒ 采不到轨迹，基线/终值不成立（不是「已恢复」）",
    trajectories: traj,
  };
};

const report = {
  meta: {
    at: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    durationMs: Date.now() - t0,
    intervalMs: INTERVAL,
    metricNote:
      "数值优先取 footprint 的 physical footprint；取不到时退回 ps 的 rss。两者都不是 JS 堆。",
    jsHeap: "NOT RUN（WKWebView 无 CDP，本机没有可用的 JS 堆快照通道）",
    usedFootprint: series.some((s) => s.metric === "footprint"),
  },
  summary: { app: groupStat("app", "appPids"), webContent: groupStat("webContent", "webPids") },
  // 每个 pid 的序列留着：区分"同一个进程单调涨"与"多开了一个进程"，只有前者才谈得上泄漏
  perPid: { app: series.map((s) => s.appPids.join(",")), webContent: series.map((s) => s.webPids.join(",")) },
  series,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ meta: report.meta, summary: report.summary }, null, 2));
console.log(`写出：${OUT}（${series.length} 个采样点）`);
if (child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* 已经自己退了 */
  }
}
