// 版本号规则（**单一事实来源**）：提交 → 级别（小/中/大）→ 版本累加。
//
// 规则（见 docs/VERSIONING.md，遵循 SemVer 2.0.0 + Conventional Commits）：
//   · patch：缺陷修复与非功能性改动（fix / docs / test / chore / build / ci / style / refactor）
//   · minor：**向后兼容**的新能力 / 用户可感知改进（feat、perf）
//   · major：**只有兼容性被破坏**才是 major（提交带 ! 或正文含 BREAKING CHANGE: footer）。
//     改动规模与线索词**不参与**定档 —— 一个大而向后兼容的功能仍然只是 minor。
//
// 两个"累加"口径，两者都实现、用途不同：
//   ① accumulate()：**逐提交累加**（字面执行"每次提交都进一位"）—— 只用于审计/台账；
//   ② requiredLevel()+bumpVersion()：**一次发布取最高档**（SemVer 标准做法）—— 用于真正发版。
// 为什么不用 ① 定版本：184 个提交里有 23 个大功能，逐条累加会得到 25.1.2 这种数字，
// 它既不表达"这次发布有多大"，也和后端/前端/安装包的版本语义脱节。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const LEVEL_RANK = { patch: 1, minor: 2, major: 3 };
export const BUMP_TRAILER = "Version-Bump";

/** 提交类型 → 默认级别。 */
export const TYPE_LEVEL = {
  feat: "minor",
  perf: "minor",
  fix: "patch",
  refactor: "patch",
  docs: "patch",
  test: "patch",
  build: "patch",
  chore: "patch",
  ci: "patch",
  style: "patch",
};

/** 破坏性变更的正文标记（Conventional Commits：与 subject 的 ! 等价）。 */
export const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

/** 解析 `type(scope)!: summary`。 */
export function parseSubject(subject) {
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.*)$/.exec(subject.trim());
  if (!m) return { type: "other", scope: null, breaking: false, summary: subject.trim() };
  return { type: m[1], scope: m[2] ? m[2].slice(1, -1) : null, breaking: !!m[3], summary: m[4] };
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`非法版本号: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function bumpVersion(version, level) {
  const [a, b, c] = parseVersion(version);
  if (level === "major") return `${a + 1}.0.0`;
  if (level === "minor") return `${a}.${b + 1}.0`;
  if (level === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error(`未知级别: ${level}`);
}

export function compareVersion(x, y) {
  const p = parseVersion(x), q = parseVersion(y);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  return 0;
}

/**
 * 给一个提交定级。`churn` = 增删行数之和，`files` = 改动文件数。
 * 判据必须**确定性**（同样的输入永远同样的级别），否则台账与门禁都对不上。
 */
export function classifyCommit({ subject, message = "", churn = 0, files = 0 }) {
  const { type, breaking: bangBreaking } = parseSubject(subject);
  // SemVer 2.0.0：MAJOR 等价于「向后不兼容」。Conventional Commits 给了两种等价声明：
  // subject 里的 ! 与正文的 BREAKING CHANGE: footer。
  const breaking = bangBreaking || BREAKING_FOOTER_RE.test(message);
  if (breaking) {
    return { level: "major", type, reason: "显式破坏性变更（! 或 BREAKING CHANGE:）" };
  }
  if (type === "feat") return { level: "minor", type, reason: `向后兼容的新功能（${files} 文件 / ${churn} 行）` };
  if (type === "perf") return { level: "minor", type, reason: "用户可感知的性能改进（向后兼容）" };
  if (type === "fix") return { level: "patch", type, reason: "缺陷修复" };
  return { level: "patch", type, reason: "非功能性/内部改动（按规则进一位 patch）" };
}

/** 一次发布应取的级别 = 这批提交里的**最高档**（SemVer 标准做法）。 */
export function requiredLevel(levels) {
  let top = null;
  for (const l of levels) {
    if (!LEVEL_RANK[l]) throw new Error(`未知级别: ${l}`);
    if (top === null || LEVEL_RANK[l] > LEVEL_RANK[top]) top = l;
  }
  return top;
}

/** 逐提交累加（字面规则；仅用于台账，别拿来发版）。 */
export function accumulate(version, levels) {
  let v = version;
  for (const l of levels) v = bumpVersion(v, l);
  return v;
}

/** 提交信息里的 `Version-Bump: <level>` 声明（没有则返回 null）。 */
export function parseBumpTrailer(message) {
  const m = new RegExp(`^${BUMP_TRAILER}:\\s*(patch|minor|major)\\s*$`, "m").exec(message);
  return m ? m[1] : null;
}

// ---------------- CLI ----------------
function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8", maxBuffer: 64 << 20 });
}

function currentVersion() {
  const pkg = JSON.parse(require$read("package.json"));
  return pkg.version;
}
function require$read(p) {
  return execSync(`cat ${p}`, { encoding: "utf8" });
}

/** 取 `since..HEAD` 的提交（含 subject / 改动规模 / 提交信息）。 */
export function collectCommits(since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const raw = git(`log --no-merges --reverse --pretty=format:%H%x1f%h%x1f%ad%x1f%s%x1f%B%x1e --date=short ${range}`);
  return raw
    .split("\x1e")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const [hash, short, date, subject, ...rest] = block.split("\x1f");
      const numstat = git(`show --numstat --format= ${hash}`);
      let churn = 0, files = 0;
      for (const line of numstat.split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        files += 1;
        churn += (Number(parts[0]) || 0) + (Number(parts[1]) || 0);
      }
      return { hash, short, date, subject, message: rest.join("\x1f"), churn, files };
    });
}

function latestTag() {
  try {
    return git("describe --tags --abbrev=0").trim();
  } catch {
    return "";
  }
}

/**
 * 上一次**版本提升**提交（改了 package.json 里 version 那一行的最新提交）。
 *
 * 门禁必须从它之后算起：如果从"最近的 tag"算起，那么刚发布完（版本已提到 3.0.0、
 * 但 tag 还停在 v2.1.2）时，范围里仍然含那批老提交 ⇒ 立刻误报"版本落后"。
 */
function lastVersionBump() {
  // 逐个看"改过 package.json"的最近提交，取第一个**真的改了 version 值**的。
  // 不用 `-S`（pickaxe 按字符串出现次数计数，`"2.1.2"`→`"3.0.0"` 次数不变、匹配不到，
  // 我第一版就踩了这个），也不用 `-G`（跨 shell 的转义很容易写错）。
  const hashes = git(`log -n 50 --format=%H -- package.json`).trim().split("\n").filter(Boolean);
  for (const h of hashes) {
    const diff = git(`show --format= --unified=0 ${h} -- package.json`);
    if (/^[+-]\s*"version":/m.test(diff)) return h;
  }
  return latestTag();
}

/**
 * `CHANGELOG.md` 的**结构**问题（返回空数组 = 结构正常）。
 *
 * 为什么需要这条检查：发布脚本按行首的 `## [Unreleased]` 锚点插入新小节。真实事故 ——
 * 它以前用 `includes("## [Unreleased]")` + 字符串 `replace` 找锚点，而某条更新日志的正文里
 * 恰好写了「补回 `## [Unreleased]` 小节」这句话，于是锚点被误命中：4.1.1~4.1.11 全被插进
 * 4.1.0 小节的半句话里，真正的 `## [Unreleased]` 标题被吞掉。这类破坏**不报错、不影响功能**，
 * 只有结构检查能拦住。
 */
export function changelogProblems(path = "CHANGELOG.md") {
  const problems = [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [`读不到 ${path}`];
  }
  const headings = text
    .split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((h) => h.line.startsWith("## ["));
  const unreleased = headings.filter((h) => /^## \[Unreleased\]\s*$/.test(h.line));
  if (unreleased.length !== 1) {
    problems.push(
      `${path} 里应有且仅有一个**行首**的 \`## [Unreleased]\` 小节（发布脚本的插入锚点），实际 ${unreleased.length} 个`,
    );
  }
  const versions = [];
  for (const h of headings) {
    if (/^## \[Unreleased\]\s*$/.test(h.line)) continue;
    const m = h.line.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/);
    if (!m) {
      problems.push(`${path}:${h.no} 版本小节标题格式不对（应为 \`## [x.y.z] - YYYY-MM-DD\`）：${h.line}`);
      continue;
    }
    versions.push({ v: m[1], no: h.no });
  }
  for (let i = 1; i < versions.length; i += 1) {
    if (compareVersion(versions[i - 1].v, versions[i].v) < 0) {
      problems.push(
        `${path}:${versions[i].no} 版本小节顺序不对：${versions[i].v} 排在 ${versions[i - 1].v} 之后（应为"新在前"的降序）`,
      );
    }
  }
  return problems;
}

function main() {
  const [cmd = "check", ...flags] = process.argv.slice(2);

  // `changelog`：**只**查 `CHANGELOG.md` 的结构（唯一行首锚点 / 标题格式 / 新在前降序），
  // 不碰版本记账。
  //
  // ## 为什么必须能单独跑
  //
  // 这条检查原先只作为 `check` 的 ③ 存在，而 `check` 的 ① ②（当前版本必须 ≥ 未发布提交
  // 要求的版本、每个提交都要有自洽的 `Version-Bump:` 声明）在**攒提交期间本来就该是红的** ——
  // 发版前就是那个状态。于是「CHANGELOG 结构」被迫跟着一起红。
  //
  // 真实后果：`scripts/verify-guards.py` 的「CHANGELOG 结构」用例拿 `check` 当命令，
  // 于是它永远无法进入"恢复即 PASS"，被判成护栏失效（2026-09-16 发现）。
  // **结构是结构、记账是记账** —— 拆成两个命令，各自说各自的话，不互相拖累。
  if (cmd === "changelog") {
    const problems = changelogProblems();
    if (problems.length) {
      console.error(`CHANGELOG 结构检查未通过：\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    console.log("CHANGELOG 结构检查通过（唯一行首 `## [Unreleased]` 锚点 + 标题格式 + 新在前降序）");
    return;
  }

  const sinceFlag = flags.indexOf("--since");
  const since = sinceFlag >= 0 ? flags[sinceFlag + 1] : lastVersionBump();
  const cur = currentVersion();
  const commits = collectCommits(since);
  const rows = commits.map((c) => ({ ...c, ...classifyCommit(c) }));

  if (cmd === "ledger") {
    console.log("| # | commit | 日期 | 类型 | 级别 | 累计版本 | 判据 | 标题 |");
    console.log("|---|---|---|---|---|---|---|---|");
    let v = cur;
    rows.forEach((r, i) => {
      v = bumpVersion(v, r.level);
      const lvl = { patch: "小（patch）", minor: "中（minor）", major: "大（major）" }[r.level];
      console.log(`| ${i + 1} | \`${r.short}\` | ${r.date} | ${r.type} | ${lvl} | ${v} | ${r.reason} | ${r.subject.replace(/\|/g, "\\|")} |`);
    });
    return;
  }

  const top = requiredLevel(rows.map((r) => r.level));
  const target = top ? bumpVersion(cur, top) : cur;

  if (cmd === "level") {
    console.log(top ?? "patch");
    return;
  }
  if (cmd === "release") {
    if (!top) {
      console.log("没有需要发布的提交（版本不变）");
      return;
    }
    console.log(`按最高档 ${top} 提升：${cur} -> ${target}`);
    execSync(`node scripts/version.mjs ${top}`, { stdio: "inherit" });
    return;
  }

  if (cmd === "classify") {
    for (const r of rows) console.log(`${r.short}  ${r.level.padEnd(5)}  ${r.type.padEnd(8)}  ${r.subject}`);
    console.log(`\n最高档: ${top ?? "（无提交）"} ⇒ 本次发布应提升到 ${target}`);
    return;
  }

  // check：门禁。① 版本必须 ≥ 未发布提交要求的版本；② 每个提交都要声明 Version-Bump 并自洽。
  const problems = [];
  if (top && compareVersion(cur, target) < 0) {
    problems.push(`当前版本 ${cur} 落后于未发布提交要求的 ${target}（最高档 ${top}）⇒ 跑 \`npm run version:release\``);
  }
  const wrong = rows.filter((r) => parseBumpTrailer(r.message) !== r.level);
  if (wrong.length) {
    problems.push(
      `${wrong.length} 个提交缺少/写错了 \`${BUMP_TRAILER}:\` 声明（应为该提交的级别）：\n` +
        wrong.slice(0, 8).map((r) => `  ${r.short} 期望 ${r.level} 实际 ${parseBumpTrailer(r.message) ?? "(无)"}  ${r.subject}`).join("\n"),
    );
  }
  // ③ CHANGELOG 结构（锚点存在 + 标题格式 + 新在前的降序）。
  problems.push(...changelogProblems());
  if (problems.length) {
    console.error(`版本号规则检查未通过（自 ${since || "首个提交"}）：\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`版本号规则检查通过：自 ${since || "首个提交"} 共 ${rows.length} 个提交，最高档 ${top ?? "无"}，当前版本 ${cur} ≥ ${target}`);
}

if (process.argv[1] && process.argv[1].endsWith("semver.mjs")) main();
