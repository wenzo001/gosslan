#!/usr/bin/env node
/**
 * CHANGELOG 分卷压缩（2026-11-03）。
 *
 * ## 规则（机器可复现，不手工剪）
 *
 * - `CHANGELOG.md` 只留最近 `--keep`（默认 12，建议 10~15）个版本的**全文**；
 *   更早的整节**逐字搬进** `docs/archive/notes/changelog-archive.md`（不删、不改写）；
 * - 被搬走的版本在 `CHANGELOG.md` 留一行摘要：`版本（日期）— 一句话主旨`；
 * - **三类不许压没**：正文命中下列关键字时，摘要行尾追加对应标记，类别本身永远可见：
 *     〔破坏性〕 `破坏性|不兼容|BREAKING`
 *     〔协议〕   `线协议|协议|WIRE_KINDS|GossipKind|INV-P<数字>|握手|帧`
 *     〔安全〕   `安全漏洞|安全修复|安全审计|安全边界|威胁模型|加密|密钥|E2EE|crypto|漏洞|CVE`
 *   摘要只压掉细节，不压掉"这一版动过哪一类"；细节仍在归档里。
 * - 摘要的"一句话主旨" = 该节第一个 `### ` 标题；没有就用第一条正文（去掉 markdown 记号，
 *   超过 110 字截断）。
 *
 * ## 以后怎么加
 *
 * 新更新说明照旧写进 `## [Unreleased]`。全文小节数超过 15（`--keep + 3`）时跑一次
 * `npm run changelog:compress`；`npm run changelog:check` 只读判定（超过 15 即 exit 1）。
 * 不要手工往归档追加、也不要手工删摘要行。
 *
 * ## 用法
 *
 *     node scripts/compress-changelog.mjs --dry-run   # 只打印前后读数，不写盘
 *     node scripts/compress-changelog.mjs             # 默认 --keep 12
 *     node scripts/compress-changelog.mjs --keep 15
 *     node scripts/compress-changelog.mjs --check     # 超过 keep+3 个全文小节 ⇒ exit 1
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const ARCHIVE = path.join(ROOT, "docs", "archive", "notes", "changelog-archive.md");
const ARCHIVE_LINK = "docs/archive/notes/changelog-archive.md";

const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const dryRun = argv.includes("--dry-run");
const checkOnly = argv.includes("--check");
const keep = Number(argOf("--keep") ?? 12);
if (!Number.isInteger(keep) || keep < 1) {
  console.error("--keep 必须是正整数");
  process.exit(2);
}
const MAX_FULL = keep + 3;

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
const VERSION_LINE = /^- \*\*(\d+\.\d+\.\d+)\*\*（(\d{4}-\d{2}-\d{2})）— (.*)$/;

const CATEGORIES = [
  ["〔破坏性〕", /破坏性|不兼容|BREAKING/],
  ["〔协议〕", /线协议|协议|WIRE_KINDS|GossipKind|INV-P\d|握手|帧/],
  ["〔安全〕", /安全漏洞|安全修复|安全审计|安全边界|威胁模型|加密|密钥|E2EE|crypto|漏洞|CVE/i],
];

/** 把 CHANGELOG 切成 preamble / [Unreleased] / 版本节 / 摘要节。 */
function parseChangelog(text) {
  const lines = text.split("\n");
  const blocks = [];
  let cur = null;
  const preamble = [];
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (cur) blocks.push(cur);
      cur = { heading: line, lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  if (cur) blocks.push(cur);
  const out = { preamble, unreleased: null, versions: [], summary: null, others: [] };
  for (const b of blocks) {
    const m = b.heading.match(VERSION_HEADING);
    if (m) out.versions.push({ ...b, version: m[1], date: m[2] });
    else if (/^## \[Unreleased\]\s*$/.test(b.heading)) out.unreleased = b;
    else if (/^## 历史版本摘要/.test(b.heading)) out.summary = b;
    // 其它 H2 原样保留在文件末尾，绝不因为"不认识"就丢掉（丢内容比不压缩更糟）。
    else out.others.push(b);
  }
  return out;
}

function stripMarkdown(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(block) {
  const body = block.lines.slice(1);
  const h3 = body.find((l) => /^### /.test(l));
  let idea = h3 ? h3.replace(/^###\s+/, "") : "";
  if (!idea) {
    const first = body.find((l) => l.trim() && !/^[#>|]/.test(l.trim()));
    idea = first ? first.replace(/^[-*]\s+/, "") : "";
  }
  idea = stripMarkdown(idea);
  if (idea.length > 110) idea = `${idea.slice(0, 108).trimEnd()}…`;
  const tags = CATEGORIES.filter(([, re]) => re.test(block.lines.join("\n"))).map(([tag]) => tag);
  return `- **${block.version}**（${block.date}）— ${idea}${tags.length ? " " + tags.join("") : ""}`;
}

function trimBlock(block) {
  return block.lines.join("\n").replace(/\s+$/, "");
}

function main() {
  if (!existsSync(CHANGELOG)) {
    console.error(`读不到 ${CHANGELOG}`);
    process.exit(2);
  }
  const original = readFileSync(CHANGELOG, "utf8");
  const parsed = parseChangelog(original);
  if (!parsed.unreleased) {
    console.error("CHANGELOG 里找不到 `## [Unreleased]` 锚点 —— 先修结构再压缩");
    process.exit(2);
  }
  const fullCount = parsed.versions.length;
  if (checkOnly) {
    if (fullCount > MAX_FULL) {
      console.error(
        `✗ CHANGELOG 全文小节 ${fullCount} 个 > 上限 ${MAX_FULL}（--keep ${keep} + 3）` +
          `\n  跑 \`npm run changelog:compress\`（压缩到 ${keep} 个全文 + 更早的一行摘要）。`,
      );
      process.exit(1);
    }
    console.log(`✓ CHANGELOG 全文小节 ${fullCount} 个（上限 ${MAX_FULL}）`);
    process.exit(0);
  }

  const kept = parsed.versions.slice(0, keep);
  const moved = parsed.versions.slice(keep);
  if (!moved.length) {
    console.log(`已是压缩态：全文 ${fullCount} 个 ≤ --keep ${keep}，没有需要搬的整节。`);
    process.exit(0);
  }

  const existingSummary = parsed.summary
    ? parsed.summary.lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => VERSION_LINE.test(l))
    : [];
  const freshSummary = moved.map(summarize);
  const allSummary = [...freshSummary, ...existingSummary];
  const oldest = moved[moved.length - 1].version;

  const summaryBlock = [
    `## 历史版本摘要（${oldest} 及更早，全文见 [归档](${ARCHIVE_LINK})）`,
    "",
    `> 由 \`scripts/compress-changelog.mjs\` 生成（\`--keep ${keep}\`）：这里只留「版本 + 一句话主旨」，`,
    "> 全文逐字在归档；带 〔破坏性〕〔协议〕〔安全〕的版本，压缩前正文命中了对应关键字。",
    "",
    ...allSummary,
  ].join("\n");

  const noteLines = [
    `> 台账分卷：2026-10-07 把 4.31.41 及更早搬进归档；2026-11-03 起 \`scripts/compress-changelog.mjs\``,
    `> 按预算把更早的整节继续逐字搬入 [\`${ARCHIVE_LINK}\`](${ARCHIVE_LINK})（不删、不改写）。本文件只留最近`,
    `> ${keep} 个版本的全文 + 更早版本的一行摘要；新更新说明照旧写进 \`[Unreleased]\`，不手工维护摘要。`,
  ];
  const preambleLines = parsed.preamble.join("\n").replace(/\s+$/, "").split("\n");
  const start = preambleLines.findIndex((l) => /^> 台账分卷/.test(l));
  let newPreamble;
  if (start >= 0) {
    let end = start;
    while (end + 1 < preambleLines.length && /^>/.test(preambleLines[end + 1])) end += 1;
    newPreamble = [
      ...preambleLines.slice(0, start),
      ...noteLines,
      ...preambleLines.slice(end + 1),
    ].join("\n");
  } else {
    newPreamble = [...preambleLines, "", ...noteLines].join("\n");
  }

  const changelogOut = [
    newPreamble.replace(/\s+$/, ""),
    "",
    trimBlock(parsed.unreleased),
    "",
    ...kept.map((b) => trimBlock(b) + "\n"),
    ...parsed.others.map((b) => trimBlock(b) + "\n\n"),
    "",
    summaryBlock,
    "",
  ].join("\n");

  // ---- 归档：把 moved 逐字插在头部说明之后、第一个历史小节之前 ----
  const archiveBefore = readFileSync(ARCHIVE, "utf8");
  const at = archiveBefore.indexOf("\n## [");
  if (at < 0) {
    console.error(`归档文件结构不对（找不到第一个历史小节）：${ARCHIVE}`);
    process.exit(2);
  }
  const header = archiveBefore.slice(0, at).replace(/\s+$/, "");
  const rest = archiveBefore.slice(at + 1);
  const movedText = moved.map(trimBlock).join("\n\n");
  let newHeader = header
    .replace(/# 更新日志归档（[^）]+）/, `# 更新日志归档（0.1.0 ~ ${moved[0].version}）`)
    .replace(
      /未发布小节与 [^\n]*仍在 \[`\.\.\/\.\.\/CHANGELOG\.md`\]\(\.\.\/\.\.\/CHANGELOG\.md\)。/,
      "未发布小节与最近若干个版本的全文仍在 [`../../CHANGELOG.md`](../../CHANGELOG.md)。",
    )
    .replace(
      "**不往这里追加新条目** —— 更新说明一律写进 `CHANGELOG.md` 的未发布小节；",
      "**不手工追加** —— 更新说明写进 `CHANGELOG.md`；只有 `scripts/compress-changelog.mjs` 会把超预算的整节逐字搬来；",
    );
  if (!newHeader.includes("scripts/compress-changelog.mjs")) {
    newHeader = newHeader.replace(
      /^(# 更新日志归档[^\n]+\n)/m,
      `$1\n2026-11-03 起：超过 \`CHANGELOG.md\` 预算的整节由 \`scripts/compress-changelog.mjs\` 逐字搬入本文件（不改写、不删条目）。\n`,
    );
  }
  const archiveOut = `${newHeader}\n\n${movedText}\n\n${rest}`;

  const stats = {
    moved: moved.length,
    kept: kept.length,
    oldest,
    tagged: freshSummary.filter((l) => /〔/.test(l)).length,
    changelogBefore: Buffer.byteLength(original),
    changelogAfter: Buffer.byteLength(changelogOut),
    archiveBefore: Buffer.byteLength(archiveBefore),
    archiveAfter: Buffer.byteLength(archiveOut),
  };
  console.log(
    `搬走 ${stats.moved} 节（${moved[0].version} ~ ${stats.oldest}），保留 ${stats.kept} 节全文；` +
      `摘要 ${freshSummary.length} 行，其中带类别标记 ${stats.tagged} 行。`,
  );
  console.log(`CHANGELOG: ${stats.changelogBefore} B → ${stats.changelogAfter} B`);
  console.log(`归档:      ${stats.archiveBefore} B → ${stats.archiveAfter} B`);

  if (dryRun) {
    console.log("\n摘要预览（前 5 行）：");
    for (const l of freshSummary.slice(0, 5)) console.log(`  ${l}`);
    console.log("摘要预览（末 5 行）：");
    for (const l of freshSummary.slice(-5)) console.log(`  ${l}`);
    console.log("--dry-run：不写盘。");
    return;
  }
  writeFileSync(CHANGELOG, changelogOut);
  writeFileSync(ARCHIVE, archiveOut);
  console.log("已写入 CHANGELOG.md 与归档。");
}

main();
