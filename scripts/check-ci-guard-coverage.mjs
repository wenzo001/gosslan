#!/usr/bin/env node
/**
 * CI 的护栏非空转扫描**覆盖对账** —— 把"这条承诺底下真的有人在跑"变成机器判据。
 *
 * 为什么需要它（不是重复造轮子，是补一个今天真的存在过的洞）：
 *   `scripts/verify.mjs` 里写着"`--group release` 必须跑完整的护栏非空转"，
 *   而 `--group release --list` 实测把那一步列进**本轮没跑** —— 一句话在文档/注释里存在，
 *   底下没有任何东西在跑，而门禁全绿。CI 拆成 `--lane` 分片之后，同形风险换了个位置：
 *   有人把 matrix 从 `[0,1,2]` 改成 `[0,1]`、或把某条腿的 `--lane node,script` 改窄，
 *   **CI 照样全绿**，只是从此有几十条护栏再没人证明过"改坏了会红"。
 *   注释挡不住这种漂移，只有现算对账挡得住 ⇒ 本工具。
 *
 * 它判四件事（缺一件都可能被糊过去）：
 *   ① 通道分母只认扫描工具自己打印的 `GUARD_LANES` 那行（数到 `all=` 与逐通道之和是否相等，
 *      不相等说明读取方式坏了 ⇒ 直接红，不许把读空当成"没有用例"）；
 *   ② 每个**还有用例**的通道，至少被一条不带 `--only` 的 CI 调用覆盖；
 *   ③ 用 `--shard i/n` 覆盖的通道，`i` 必须恰好凑满 `0..n-1`（少一片就是静默丢 1/n 的护栏）；
 *   ④ 带 `--only` 的那类调用只能出现在**子集腿**上，不许拿它当全覆盖的证据；
 *   ⑤ 覆盖腿必须有**会自己发生**的触发点（`if` 里含 schedule / push / pull_request，或根本没写
 *      `if`）—— 只留 `workflow_dispatch` 的腿骗得过眼睛骗不过这条：它"还在"，但没人拉就永远不跑。
 *
 * 用法：`node scripts/check-ci-guard-coverage.mjs`（无参数；退出码 0 = 覆盖成立）
 * ⚠️ 本工具自己的非空转证据：把 `guards-web` 的 `--lane node,script` 摘掉、或把 shard 改成
 *    `[0,1]` ⇒ 本工具必须点名变红（见 `scripts/guard_cases/toolchain.py` 那条用例）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(process.argv.find((a) => a.startsWith("--root="))?.slice(7) ?? ".");
const YML_REL = ".github/workflows/verify.yml";

const py = (() => {
  for (const c of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  return null;
})();
if (!py) {
  console.error("✗ 找不到 python3/python ⇒ 护栏通道分母读不出来，这条对账**不作通过**（看不见就说看不见）");
  process.exit(1);
}

// ---------- ① 通道分母：由扫描工具自己报 ----------
const listed = spawnSync(py, ["scripts/verify-guards.py", "--print-lanes"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
// `--print-lanes` 只打印分母、不做锚点核对：本工具自己就活在一条护栏用例的**注入态**里，
// 用 `--list` 的话那条核对会发现"它自己的锚点找不到"而退 1 ⇒ 红的形状变成本量具坏了。
if (listed.status !== 0) {
  console.error(`✗ \`verify-guards.py --print-lanes\` 退 ${listed.status} ⇒ 拿不到通道分母，覆盖对账不作通过`);
  console.error((listed.stderr || "").slice(-800));
  process.exit(1);
}
const lanesLine = (listed.stdout || "").split(/\r?\n/).find((l) => l.startsWith("GUARD_LANES "));
if (!lanesLine) {
  console.error("✗ 读不到 `GUARD_LANES` 那行 ⇒ 这条对账的分母没了（读空了会一路报绿，那是最坏的一种假绿）");
  process.exit(1);
}
const counts = {};
for (const m of lanesLine.matchAll(/(\w+)=(\d+)/g)) counts[m[1]] = Number(m[2]);
const declaredAll = counts.all;
delete counts.all;
const sum = Object.values(counts).reduce((a, b) => a + b, 0);
if (declaredAll !== sum) {
  console.error(`✗ GUARD_LANES 自相矛盾：all=${declaredAll} 但逐通道之和=${sum} ⇒ ${lanesLine}`);
  console.error("  ⇒ 通道划分漏了一个新 lane（`lane_of` 加了分支而清点没跟上），不是「用例少了」");
  process.exit(1);
}
const needed = Object.entries(counts)
  .filter(([, n]) => n > 0)
  .map(([lane]) => lane);

// ---------- 把 yml 切成"每个 run 块一条命令" ----------
// 为什么要拼续行：`run: >` 折叠写法会把参数分到好几行（CI 那两条腿就是这么写的）。
// 只在单行里找 `verify-guards.py --lane …` ⇒ 参数落在下一行，读成"没有 --lane"，
// 于是这条对账会在真实形状上**误判成全覆盖**（或者反过来把合法配置判红）。
const yml = fs.readFileSync(path.join(ROOT, YML_REL), "utf8");
const ymlLines = yml.split(/\r?\n/);
/** @type {{job: string, cmd: string, ifExpr: string}[]} */
const calls = [];
const unresolved = [];
let curJob = "";
let curIf = "";
/** 本 job 的 `strategy.matrix.<name>: [...]` —— `${{ matrix.shard }}` 要靠它展开成真实片号。 */
let curMatrix = {};
for (let i = 0; i < ymlLines.length; i++) {
  const line = ymlLines[i];
  const jobM = /^  ([\w-]+):\s*$/.exec(line);
  if (jobM) {
    curJob = jobM[1];
    curIf = "";
    curMatrix = {};
    continue;
  }
  if (curJob && /^ {4}if:/.test(line)) curIf = line.slice(line.indexOf(":") + 1).trim();
  // `shard: [0, 1, 2]`（matrix 数组，缩进不固定 ⇒ 按形状认，不按缩进认）
  const arrM = /^\s*([\w-]+):\s*\[([^\]]*)\]\s*$/.exec(line);
  if (arrM && !arrM[2].includes("{")) {
    curMatrix[arrM[1]] = arrM[2]
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter((x) => x !== "");
  }
  if (!/^\s*(?:-\s*)?run:\s*/.test(line) && !/^\s*(?:-\s*)?run:\s*[>|]/.test(line)) continue;
  const startIndent = line.match(/^\s*/)[0].length;
  let body = line.replace(/^.*?run:\s*/, "").trim();
  if (body === ">" || body === "|" || body === ">-" || body === "|-") body = "";
  for (let j = i + 1; j < ymlLines.length; j++) {
    const nxt = ymlLines[j];
    if (!nxt.trim()) break;
    const ind = nxt.match(/^\s*/)[0].length;
    if (ind <= startIndent) break;
    body += " " + nxt.trim();
  }
  if (!body.includes("verify-guards.py")) continue;
  // 有没有自动触发点：`if` 里必须至少认一个**会自己发生**的事件（schedule / push / pull_request）。
  // 只留 `workflow_dispatch` 的腿 = 只有人手动拉才跑 ⇒ 夜间覆盖其实已经断了，而"腿还在"骗过眼睛。
  const auto = !curIf || /schedule|push|pull_request/.test(curIf);
  body = body.replace(/\s+/g, " ");
  // ★ 展开 `${{ matrix.X }}`：不展开的话 `--shard ${{ matrix.shard }}/3` 里的片号不是数字
  //   ⇒ 分片完整性那条判据会**静默不触发**，把"少跑一片"读成"覆盖成立"（本文件第一版实测到）。
  //   ⚠️ 必须把一条命令里**所有** matrix 引用都展开（第一版只取第一个，于是"标签里用 shard、
  //   参数里拼错成 nope"这种形状照样读成覆盖成立 —— 变异 M-d 就是这么抓出来的）；
  //   任何一个名字解析不出来 ⇒ 整条当**不覆盖**并点名，绝不猜成全了。
  const names = [...new Set([...body.matchAll(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g)].map((m) => m[1]))];
  if (!names.length) {
    calls.push({ job: curJob, cmd: body, ifExpr: curIf, auto });
    continue;
  }
  const missing = names.filter((n) => !curMatrix[n] || !curMatrix[n].length);
  if (missing.length) {
    unresolved.push(`${curJob}: 命令里用了 \${{ matrix.${missing.join("、")} }}，但本 job 没解析到那份 matrix 数组`);
    continue;
  }
  let variants = [{ cmd: body, tag: "" }];
  for (const n of names) {
    variants = variants.flatMap((v) =>
      curMatrix[n].map((x) => ({
        cmd: v.cmd.replace(new RegExp(`\\$\\{\\{\\s*matrix\\.${n}\\s*\\}\\}`, "g"), String(x)),
        tag: `${v.tag}${v.tag ? "+" : ""}${n}=${x}`,
      })),
    );
  }
  for (const v of variants) calls.push({ job: `${curJob}[${v.tag}]`, cmd: v.cmd, ifExpr: curIf, auto });
}
if (!calls.length) {
  console.error(`✗ ${YML_REL} 里一条 \`verify-guards.py\` 调用都没有 ⇒ 护栏非空转**没有任何 CI 覆盖**`);
  process.exit(1);
}

// ---------- ②③④ 覆盖集合与分片完整性 ----------
/** lane -> {via: string[], shards: Map<total, Set<index>>} */
const cover = {};
const subsetLegs = [];
for (const c of calls) {
  const only = /--only(\s+|=)(\S+)/.exec(c.cmd);
  if (only) {
    subsetLegs.push(`${c.job}（--only ${only[2]}）`);
    continue; // 子集腿只算"多扫一遍"，不算全覆盖的证据
  }
  const laneM = /--lane(\s+|=)(\S+)/.exec(c.cmd);
  const lanes = laneM ? laneM[2].split(",") : Object.keys(counts); // 不带 --lane = 全量
  const shardM = /--shard(\s+|=)(\d+)\/(\d+)/.exec(c.cmd);
  for (const lane of lanes) {
    cover[lane] ??= { via: [], shards: new Map(), auto: false };
    cover[lane].via.push(c.job);
    if (c.auto) cover[lane].auto = true;
    if (shardM) {
      const idx = Number(shardM[2]);
      const total = Number(shardM[3]);
      const set = cover[lane].shards.get(total) ?? new Set();
      set.add(idx);
      cover[lane].shards.set(total, set);
    }
  }
}

const problems = [];
for (const u of unresolved) problems.push(u);
for (const lane of needed) {
  const info = cover[lane];
  if (!info) {
    problems.push(`通道 ${lane}（${counts[lane]} 条用例）**没有任何全覆盖的 CI 调用** —— 这些护栏从此没人证明过会红`);
    continue;
  }
  if (!info.auto) {
    // ⚠️ 必须放在分片循环**之前**：第一版把它写在循环里、紧跟在"分片凑满就 continue"后面 ⇒
    // 配置完全正确时这条判据一次都不会执行（M-e 变异实测到：摘掉 schedule 照样报覆盖成立）。
    problems.push(
      `通道 ${lane} 的覆盖腿（${[...new Set(info.via)].join("、")}）只在手动触发时跑` +
        " ⇒ 没有 schedule / push / pull_request 会自己走到它，等于夜间覆盖已断",
    );
  }
  for (const [total, set] of info.shards) {
    if (set.size === total && [...Array(total).keys()].every((i) => set.has(i))) continue;
    const missing = [...Array(total).keys()].filter((i) => !set.has(i));
    problems.push(
      `通道 ${lane} 用 --shard /${total} 覆盖，但缺片 ${missing.join("、")}` +
        `（实到 ${[...set].sort((a, b) => a - b).join("、")}）⇒ 约 ${missing.length}/${total} 的用例静默不跑`,
    );
  }
}

console.log(`· 通道分母（verify-guards.py 自报）：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")} 合计 ${sum}`);
console.log(`· CI 里的扫描调用（共 ${calls.length} 条）：`);
for (const c of calls)
  console.log(`   - ${c.job}: ${c.cmd}（触发：${c.ifExpr || "无 if ⇒ always"}｜自动=${c.auto}）`);
if (subsetLegs.length) console.log(`· 子集腿（不算全覆盖证据）：${subsetLegs.join("、")}`);
for (const lane of needed) {
  const info = cover[lane];
  console.log(
    `   ${lane.padEnd(7)} ${String(counts[lane]).padStart(3)} 条 ← ` +
      (info ? [...new Set(info.via)].join("、") : "✗ 无人覆盖"),
  );
}

if (problems.length) {
  console.error(`\n❌ 护栏扫描覆盖不成立（${problems.length} 处）：`);
  for (const p of problems) console.error(`   - ${p}`);
  console.error(
    "  ⇒ 修法只有两种：把缺的那条腿/那片补回来，或把那个通道的用例真的删掉。" +
      "不许把这条判据改窄来消红 —— 它存在的唯一理由就是「注释里写着跑、底下没跑」这一族。",
  );
  process.exit(1);
}
const jobFamilies = new Set(
  Object.values(cover)
    .flatMap((v) => v.via)
    .map((s) => s.replace(/\[[^\]]*\]$/, "")),
);
console.log(
  `✅ 覆盖成立：${needed.length} 个有用例的通道（合计 ${sum} 条）都有全覆盖的 CI 调用、分片凑满；` +
    `涉及 job ${jobFamilies.size} 个（${[...jobFamilies].join("、")}）`,
);
