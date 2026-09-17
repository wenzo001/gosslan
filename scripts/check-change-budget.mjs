#!/usr/bin/env node
/**
 * Change Budget 守门 —— 把「改动半径」与「重复犯案」从口号变成机器判定。
 *
 * ## 为什么需要它
 *
 * CHANGELOG `4.18.7 → 4.18.10` 连着四个版本修同一个 BLE 分片问题,每一版都只有
 * 2~4 文件 / +24~+136 行 —— **小 diff 不等于安全**。如果门禁只用"改动小 = 放行",
 * 这一串会被全部放行。所以本守门有三个判据,而不是一个:
 *
 *   1. **规模**:超大 diff 必须显式声明(而不是默默合进去);
 *   2. **敏感文件**:碰核心协议/密码学/DB schema 的改动无论多小都要显式声明;
 *   3. **重复犯案**:同一领域连续被打补丁 ⇒ 说明缺不变量或单一事实来源,
 *      4.18.7→4.18.10 就是标准样本(四个"小修复"互相修)。
 *
 * ## 判据(对范围内每个 commit)
 *
 * 先算**计入文件** = 改动文件 − 豁免文件(见下)。计入文件为空 ⇒ 整个 commit
 * 是纯工程/文档 commit ⇒ PASS。
 *
 * | 级别 | 条件 | 要求 |
 * |---|---|---|
 * | L1 | ≤5 文件 && ≤200 LOC && ≤1 领域 && 不碰敏感文件 | 直接放行 |
 * | L2 | ≤10 文件 && ≤500 LOC && ≤2 领域 && 不碰敏感文件 | commit message 必须含 `[plan]` |
 * | L3 | 其余,或碰了敏感文件 | commit message 必须含 `[impact]` |
 *
 * **敏感文件**(碰了直接 L3,与规模无关):`schema.sql`(全库数据)、
 * `protocol.rs`(线协议)、`crypto.rs`(E2EE)。这三个文件一错就是安全问题或
 * 全库数据问题,值得多一次显式声明。
 *
 * **豁免文件**(不计入文件数/LOC):`*.md`、`*.txt`(含 test-baseline)、
 * `docs/**`、`.github/**`、`scripts/**`。理由:这些是工程仪式与文档,不是
 * 产品代码;不豁免的话,每加一个守门脚本/每写一次 CHANGELOG 都在吃预算。
 * 风险(在 docs 里藏坏内容)由 PR review 兜底。
 *
 * **版本白名单**(仅 `chore(release)` 生效):package.json / package-lock.json /
 * Cargo.toml / Cargo.lock / tauri.conf.json。每次发版固定动这 6 个文件,不豁免
 * 会每个版本撞门。
 *
 * **重复犯案**:取 `<merge-base>..HEAD` 内最近 5 个 `fix` 提交,各自映射领域
 * (豁免文件不计);任一领域出现 ≥3 次 ⇒ FAIL。窗口**只看本分支独有**的提交
 * —— main 上历史上已经有 BLE 连修的旧案,向前看,不审判历史。
 *
 * ## 领域归属
 *
 * 文件路径按 `docs/domains.data.mjs` 的 `paths` 前缀映射;落进 `unmapped`
 * 的(commands.rs / state.rs / lib.rs 等装配层)**不计领域数**但**计文件数/LOC**
 * —— 改装配层不是免费的,只是它不属于哪个具体领域。
 *
 * ## 用法
 *
 *     node scripts/check-change-budget.mjs                     # 本地:检查 HEAD~1..HEAD
 *     node scripts/check-change-budget.mjs --range a1b2c3..HEAD
 *     node scripts/check-change-budget.mjs --from-json scripts/fixtures/change-budget.json
 *
 * CI(push event)自动用 `github.event.before..github.sha`;拿不到或 force push
 * 时退化为 HEAD~1..HEAD —— 并**打印实际用的范围**,不静默。
 *
 * `--from-json` 是**测试接缝**:verify-guards.py 的非空转用例喂 fixture,
 * 不碰 git。fixture 格式见 `scripts/fixtures/change-budget.json`。
 *
 * ## 本守门守不住的(诚实边界)
 *
 * · **语义**:+10 行可以把整条链路发不出消息(4.18.9 就是),规模判据管不了语义
 *   —— 那靠测试与不变量;
 * · **commit 切分 gaming**:把一个大改动拆成多个小 commit 就绕过了规模判据
 *   —— 但重复犯案判据仍会盯住"同一领域反复改";两道闸互为补充;
 * · **fix 前缀 gaming**:把 fix 写成 feat 就躲开犯案窗口 —— 这属于"门禁被绕过
 *   一次就永久失效"的流程问题,review 兜底。
 *
 * 退出码:0 = 全部通过;1 = 有 commit 超预算未声明,或重复犯案。
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import domainMap from "../docs/domains.data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------- 阈值与清单(全部显式,不做魔法) ----------------

/** L1:默认放行的"小改动"。依据:9/10 真实历史修复落在 ≤4 文件 / ≤+136 LOC。 */
const L1 = { files: 5, loc: 200, domains: 1 };
/** L2:中改动,需要 [plan] 标记(说明改了什么、为什么)。 */
const L2 = { files: 10, loc: 500, domains: 2 };
/** L3:以上之外,或碰敏感文件。需要 [impact] 标记(Impact Report 的最小形态)。 */

/** 碰了直接升 L3 的文件(仓库相对路径)。一错就是安全/全库数据问题的三处。 */
const SENSITIVE_FILES = new Set([
  "src-tauri/src/schema.sql",
  "src-tauri/src/protocol.rs",
  "src-tauri/src/crypto.rs",
]);

/** 豁免文件(不计入预算):工程仪式与文档。 */
const EXEMPT_PREFIXES = [".github/", "scripts/", "docs/"];
const EXEMPT_SUFFIXES = [".md", ".txt"];

/** 版本白名单(仅 chore(release) 时豁免):一次发版固定动的五个文件。 */
const RELEASE_WHITELIST = new Set([
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
]);

/** 重复犯案窗口:最近 N 个 fix 提交。 */
const OFFENDER_WINDOW = 5;
/** 同一领域在窗口内出现 ≥ N 次 ⇒ FAIL。依据:4.18.7→4.18.10 是 4 次;第 3 次就拦。 */
const OFFENDER_LIMIT = 3;

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const fromJson = argOf("--from-json");
const rangeArg = argOf("--range");

let ok = true;
const fail = (msg) => {
  ok = false;
  console.error(msg);
};

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ---------------- 领域归属 ----------------

/**
 * 仓库相对路径(POSIX 分隔)→ 领域 id | "assembly" | "unknown"。
 * assembly = unmapped 清单里的装配层;unknown = 谁都不认领(计入但不算领域数)。
 */
const unmappedPrefixes = (domainMap.unmapped ?? []).map(([p]) => p);
function domainOf(relPath) {
  const p = relPath.replaceAll("\\", "/");
  for (const d of domainMap.domains) {
    for (const entry of d.paths ?? []) {
      const e = entry.replaceAll("\\", "/");
      if (p === e || p.startsWith(e + "/")) return d.id;
    }
  }
  for (const u of unmappedPrefixes) {
    if (p === u || p.startsWith(u.replace(/\/$/, "") + "/")) return "assembly";
  }
  return "unknown";
}

/** 是否豁免文件(不计入预算)。 */
function isExempt(relPath) {
  const p = relPath.replaceAll("\\", "/");
  if (EXEMPT_PREFIXES.some((x) => p.startsWith(x))) return true;
  if (EXEMPT_SUFFIXES.some((x) => p.endsWith(x))) return true;
  return false;
}

/**
 * 对一个 commit 做分级判定。
 * @returns {{level: "EXEMPT"|"L1"|"L2"|"L3", counted: number, loc: number,
 *            domains: string[], sensitive: string[], problem: string|null}}
 */
function classify(commit) {
  const release = /^chore\(release\)/.test(commit.message);
  const counted = commit.files.filter(
    (f) =>
      !isExempt(f.path) &&
      !(release && RELEASE_WHITELIST.has(f.path.replaceAll("\\", "/"))),
  );
  const countedFiles = counted.filter((f) => !SENSITIVE_FILES.has(f.path.replaceAll("\\", "/")));
  const loc = counted.reduce((s, f) => s + f.add + f.del, 0);
  const domainSet = new Set(counted.map((f) => domainOf(f.path)).filter((x) => x !== "assembly" && x !== "unknown"));
  const domains = [...domainSet];
  const sensitive = counted.filter((f) => SENSITIVE_FILES.has(f.path.replaceAll("\\", "/"))).map((f) => f.path);
  const files = counted.length;

  if (files === 0) {
    return { level: "EXEMPT", counted: 0, loc, domains, sensitive, problem: null };
  }

  // [plan] 与 [plan: 说明] 都算 —— 冒号形式更自然(把计划直接写在标记里)
  const hasPlan = /\[plan[:\]]/i.test(commit.message);
  const hasImpact = /\[impact[:\]]/i.test(commit.message);

  const isL1 = files <= L1.files && loc <= L1.loc && domains.length <= L1.domains && sensitive.length === 0;
  if (isL1) return { level: "L1", counted: files, loc, domains, sensitive, problem: null };

  const isL2 =
    sensitive.length === 0 && files <= L2.files && loc <= L2.loc && domains.length <= L2.domains;
  if (isL2) {
    return hasPlan
      ? { level: "L2", counted: files, loc, domains, sensitive, problem: null }
      : {
          level: "L2",
          counted: files,
          loc,
          domains,
          sensitive,
          problem: `改动超出 L1(${files} 文件 / ${loc} 行 / ${domains.length} 领域)但 message 没有 [plan] 标记 —— 请在 commit message 里补 [plan] 并说明改动计划`,
        };
  }

  // L3
  return hasImpact
    ? { level: "L3", counted: files, loc, domains, sensitive, problem: null }
    : {
        level: "L3",
        counted: files,
        loc,
        domains,
        sensitive,
        problem:
          `改动达到 L3(${files} 文件 / ${loc} 行 / ${domains.length} 领域` +
          (sensitive.length ? `;碰敏感文件: ${sensitive.join(", ")}` : "") +
          `)但 message 没有 [impact] 标记 —— 请补 [impact] 与 Impact Report(动了什么、为什么安全、怎么验证)`,
      };
}

// ---------------- 数据源 ----------------

/**
 * 解析 `git log --format=%H%x00%s --numstat` 的输出。
 *
 * ⚠️ git 的输出形状(实测)是:
 *     sha\0subject
 *     (空行)          ← 空行跟在 format 头**之后**
 *     12  3  file.rs
 *     sha2\0subject2   ← 下一个头**直接**跟随,块之间没有空行
 * 所以**不能按空行切块** —— 要逐行扫:含 \0 的行是新 commit 头,其余是它的 numstat。
 */
function parseCommits(raw) {
  const commits = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.includes("\0")) {
      const [sha, ...msgParts] = line.split("\0");
      current = { sha: sha.slice(0, 7), message: msgParts.join("\0"), files: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, add, del, file] = m;
    if (add === "-" || del === "-") continue; // 二进制:无法按行计,跳过(改动可见于 review)
    // rename(-M 开启)形如 `old => new` / `prefix{old => new}suffix`:取新路径
    const renamed = file.includes(" => ") ? file.split(" => ")[1].replace(/[}]/g, "") : file;
    const clean = renamed.replace(/^\{/, "").replace(/\}.*/, "");
    current.files.push({ path: clean, add: Number(add), del: Number(del) });
  }
  return commits;
}

/** 取重复犯案窗口:`merge-base(HEAD, origin/main)..HEAD` 的最近 N 个 fix 提交。 */
function buildOffenderWindow() {
  try {
    const mb = git("merge-base", "HEAD", "origin/main").trim();
    const fixLog = git(
      "log",
      `${mb}..HEAD`,
      "--grep=^fix",
      "-n",
      String(OFFENDER_WINDOW),
      "--numstat",
      "-M",
      "--format=%H%x00%s",
    );
    const fixes = parseCommits(fixLog);
    console.log(`重复犯案窗口:merge-base..HEAD 的最近 ${fixes.length} 个 fix(${mb.slice(0, 7)}..HEAD)`);
    return fixes;
  } catch (e) {
    console.log(`⚠️ 找不到与 origin/main 的 merge-base,跳过重复犯案检查(理由:${e.message.split("\n")[0]})`);
    return null;
  }
}

/** @type {{commits: {sha: string, message: string, files: {path: string, add: number, del: number}[]}[], recentFixes: ?Array}} */
let data;
let usedRange = null;

if (fromJson) {
  data = JSON.parse(readFileSync(path.resolve(ROOT, fromJson), "utf8"));
  console.log(`数据源:fixture ${fromJson}(${data.commits.length} 个 commit)`);
} else {
  // 范围:显式 --range > CI push event(before..sha)> 未推送(origin/<branch>..HEAD)> HEAD~1..HEAD
  //
  // 为什么是"未推送"而不是 HEAD~1:HEAD~1..HEAD 会**永远重查最后一个 commit** ——
  // 它一旦被 push 过,再跑本地 verify 就红,门禁变成了对历史的审判而不是对未来的闸。
  // "未推送"与 CI 的 before..after 语义一致:门禁向前看。
  let range = rangeArg;
  if (!range && process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_EVENT_BEFORE) {
    const before = process.env.GITHUB_EVENT_BEFORE;
    // force push / 新分支时 before 不在本仓库历史里,git 会报错 —— 用 try 探测
    try {
      execFileSync("git", ["cat-file", "-e", `${before}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      range = `${before}..${process.env.GITHUB_SHA ?? "HEAD"}`;
    } catch {
      /* before 不可达,落到未推送范围 */
    }
  }
  if (!range) {
    try {
      const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
      git("cat-file", "-e", `origin/${branch}^{commit}`);
      range = `origin/${branch}..HEAD`;
    } catch {
      range = "HEAD~1..HEAD";
    }
  }
  usedRange = range;

  // 空范围(全部已推送)= 没有要检查的新 commit —— 显式说清(commits 为空自然通过)
  let commitsRaw = "";
  try {
    commitsRaw = git("log", range, "--numstat", "-M", "--format=%H%x00%s");
  } catch {
    console.log(`检查范围:${range}(空或不可达)—— 没有未推送的新 commit,判据 1/2 自然通过`);
  }
  console.log(`检查范围:${usedRange}`);

  // 解析:逐行状态机(见 parseCommits 注释 —— 不能按空行切块)
  data = { commits: parseCommits(commitsRaw) };

  // 重复犯案窗口:merge-base(HEAD, origin/main)..HEAD 的最近 N 个 fix
  data.recentFixes = buildOffenderWindow();
}

// ---------------- 判据 1/2:逐 commit 分级 ----------------

console.log("\n判据 1/2:变更分级(规模 / 敏感文件 / 标记)");
for (const commit of data.commits) {
  const verdict = classify(commit);
  const tag = verdict.problem ? "✗" : "✓";
  const level =
    verdict.level === "EXEMPT" ? "豁免" : verdict.level;
  console.log(
    `  ${tag} ${commit.sha} ${level.padEnd(4)} ` +
      `${verdict.counted} 文件 / ${verdict.loc} 行` +
      (verdict.domains.length ? ` / 领域[${verdict.domains.join(",")}]` : " / 无领域文件") +
      (verdict.sensitive.length ? " / ⚠️敏感" : "") +
      `  ${commit.message.split("\n")[0].slice(0, 60)}`,
  );
  if (verdict.problem) fail(`      ${verdict.problem}`);
}
if (ok) console.log("  ✓ 全部 commit 在预算内或已声明");

// ---------------- 判据 3:重复犯案 ----------------

if (data.recentFixes) {
  console.log(`\n判据 3:重复犯案(窗口内最近 ${data.recentFixes.length} 个 fix,同领域 ≥${OFFENDER_LIMIT} 次即红)`);
  /** @type {Map<string, string[]>} 领域 → [sha...] */
  const byDomain = new Map();
  for (const fix of data.recentFixes) {
    const domains = new Set(
      fix.files.filter((f) => !isExempt(f.path)).map((f) => domainOf(f.path)).filter((x) => x !== "assembly" && x !== "unknown"),
    );
    for (const d of domains) {
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(fix.sha);
    }
  }
  let offender = null;
  for (const [d, shas] of byDomain) {
    const mark = shas.length >= OFFENDER_LIMIT ? "✗" : "✓";
    console.log(`  ${mark} ${d}: ${shas.length} 次(${shas.join(", ")})`);
    if (shas.length >= OFFENDER_LIMIT && !offender) offender = { d, shas };
  }
  if (byDomain.size === 0) console.log("  (窗口内 fix 都只动豁免文件,无领域归属)");
  if (offender) {
    fail(
      `  ✗ 「${offender.d}」领域在最近 ${OFFENDER_WINDOW} 个 fix 里出现了 ${offender.shas.length} 次 —— ` +
        `这是 4.18.7→4.18.10 的标准犯案形态(每个补丁都很小,但它们在互相修)。\n` +
        `      请停下来:① 该领域的不变量补了吗(docs/protocol-invariants.md)?\n` +
        `      ② 单一事实来源收敛了吗(docs/migration-ledger.md 的台账行)?\n` +
        `      ③ 如果确属独立新问题,拆到独立分支分别提交,别在一个分支上连打补丁。`,
    );
  } else {
    console.log("  ✓ 无重复犯案");
  }
}

// ---------------- 汇总 ----------------

if (ok) {
  console.log("\n✓ Change Budget 通过。");
  console.log("  (已知边界:管不了语义(+10 行能让链路发不出消息,靠测试)/拆 commit gaming 靠犯案判据兜底。)");
  process.exit(0);
}
console.error("\n✗ Change Budget 未通过 —— 请补声明([plan]/[impact])或收敛改动,别绕过。");
process.exit(1);
