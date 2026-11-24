#!/usr/bin/env node
/**
 * **本机补传 Gitee**（国内链路）。CI 只负责能传的部分，大包在这里几秒补齐。
 *
 * ## 为什么必须有这条通道（2026-11-24 实测）
 *
 * GitHub 托管 runner → Gitee 是跨境慢链路：实测 20–90 KB/s，而且**大文件会被 Gitee
 * 网关直接 400**。v7.2.8 的 `upload (0)` 里，104 字节的 sha256 一次成功，而 6.4MB / 8.5MB /
 * 8.8MB / 13.8MB 四个文件各重试 3 次全部 `HTTP 400` —— 这跟"重试不够"无关，是那条链路
 * 传不动几 MB 的 body。同一份包从国内直连 Gitee 是秒级（社区实测 22MB ≈ 4s）。
 *
 * 所以口径定成：**CI 保证小文件与清单自动同步；大包用本机这条命令补**。
 * 补完之后两边逐个文件对齐（同名 + 同大小才算齐）。
 *
 * ## 用法
 *
 *     GITEE_TOKEN=xxxx node scripts/gitee-backfill.mjs --tag v7.2.9
 *     GITEE_TOKEN=xxxx node scripts/gitee-backfill.mjs --tag v7.2.9 --dry-run   # 只看缺口
 *
 * `--min-size` 可调（默认 0 = 全补；只想补大包就写 `--min-size 5`，单位 MB）。
 * 令牌只从环境变量读，不进命令行（避免落到 shell 历史里）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITEE_API = "https://gitee.com/api/v5";
const GH_REPO = process.env.GOSSLAN_GH_REPO || "wenzo001/gosslan";
// 与 CI 同一个镜像仓库（.github/workflows/sync-gitee.yml 的 `GITEE_REPO`），别写成源码仓。
const GITEE_REPO = process.env.GOSSLAN_GITEE_REPO || "fwdq/gosslan-releases";
const TOKEN = process.env.GITEE_TOKEN || "";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes("--dry-run");
const tag = arg("tag");
const minSizeMb = Number(arg("min-size", "0"));

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("用法：GITEE_TOKEN=xxx node scripts/gitee-backfill.mjs --tag v7.2.9 [--dry-run] [--min-size 5]");
  process.exit(2);
}
if (!TOKEN) {
  console.error("缺 GITEE_TOKEN（环境变量）。在 https://gitee.com/profile/personal_access_tokens 生成，勾 projects 读+写。");
  process.exit(2);
}

function redact(text) {
  return String(text).split(TOKEN).join("***");
}

async function gitee(method, path, body) {
  const url = `${GITEE_API}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`${method} ${path} → HTTP ${res.status}：${text.slice(0, 200)}`));
  return text ? JSON.parse(text) : null;
}

/** GitHub 侧资产清单（本机 gh 已认证，不需要额外令牌）。 */
function githubAssets() {
  const res = spawnSync(
    "gh",
    ["api", `repos/${GH_REPO}/releases/tags/${tag}`, "--jq", '.assets[] | "\(.name)\t\(.size)"'],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`读 GitHub Release 失败：${(res.stderr || "").trim()}`);
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, size] = line.split("\t");
      return { name, size: Number(size) };
    });
}

/** 上传一个文件（curl，同 CI 口径：超时 90 分钟、慢速判死、--fail-with-body 便于诊断）。 */
function upload(releaseId, file, name) {
  const url = `${GITEE_API}/repos/${GITEE_REPO}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(TOKEN)}`;
  const res = spawnSync(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      "--write-out", "\n__HTTP__%{http_code}",
      "--max-time", "5400",
      "--speed-limit", "512",
      "--speed-time", "180",
      "-X", "POST",
      url,
      "-F", `file=@${file};filename=${name}`,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const code = Number((/__HTTP__(\d+)/.exec(res.stdout ?? "") || [])[1] || 0);
  if (res.status === 0 && (code === 200 || code === 201)) return null;
  return redact(`${(res.stderr || out).trim().replace(/\s+/g, " ").slice(0, 200)}（curl ${res.status} / HTTP ${code || "-"}）`);
}

const main = async () => {
  console.log(`目标：${GITEE_REPO} @ ${tag}（GitHub 源：${GH_REPO}）`);
  const release = await gitee("GET", `/repos/${GITEE_REPO}/releases/tags/${tag}`);
  const attachments = await (async () => {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const rows = await gitee(
        "GET",
        `/repos/${GITEE_REPO}/releases/${release.id}/attach_files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  })();

  const remote = new Map(attachments.map((a) => [a.name, Number(a.size ?? -1)]));
  const wanted = githubAssets().filter((a) => a.size >= minSizeMb * 1024 * 1024);
  const missing = [];
  let ok = 0;
  for (const a of wanted) {
    if (remote.get(a.name) === a.size) {
      ok += 1;
      continue;
    }
    missing.push(a);
  }
  console.log(`已一致 ${ok} 个；缺/大小不符 ${missing.length} 个${dryRun ? "（dry-run，不上传）" : ""}`);
  for (const m of missing) {
    const had = remote.has(m.name) ? `远端 ${remote.get(m.name)}` : "远端无";
    console.log(`  · ${m.name}（本地 ${m.size} 字节 / ${had}）`);
  }
  if (missing.length === 0) {
    console.log("✅ 两仓已逐个文件对齐（名字 + 大小）");
    return;
  }
  if (dryRun) return;

  const dir = mkdtempSync(join(tmpdir(), `gitee-backfill-${tag}-`));
  let failed = 0;
  try {
    for (const m of missing) {
      console.log(`下载 ${m.name} …`);
      const dl = spawnSync(
        "gh",
        ["release", "download", tag, "--repo", GH_REPO, "--pattern", m.name, "--dir", dir, "--clobber"],
        { encoding: "utf8" },
      );
      const local = join(dir, m.name);
      if (dl.status !== 0 || !existsSync(local)) {
        console.error(`  ✗ 下载失败：${(dl.stderr || "").trim().slice(0, 160) || "文件不存在"}`);
        failed += 1;
        continue;
      }
      const size = statSync(local).size;
      if (size !== m.size) {
        console.error(`  ✗ 下载大小不符（${size} ≠ ${m.size}）`);
        failed += 1;
        continue;
      }
      // 同名但大小不符 ⇒ 先删掉旧的（半截上传），否则 Gitee 会拒
      const old = attachments.find((a) => a.name === m.name);
      if (old) {
        await gitee("DELETE", `/repos/${GITEE_REPO}/releases/${release.id}/attach_files/${old.id}`).catch(
          () => {},
        );
        console.log(`  删掉同名旧附件（${remote.get(m.name)} 字节）`);
      }
      const t0 = Date.now();
      const err = upload(release.id, local, m.name);
      if (err) {
        console.error(`  ✗ 上传失败：${err}`);
        failed += 1;
      } else {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ✓ 已上传 ${m.name}（${size} 字节，${secs}s）`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n❌ ${failed} 个文件失败（重跑本命令会只补缺的）`);
    process.exit(1);
  }
  console.log("\n✅ 补传完成。重跑一次确认（应显示「两仓已逐个文件对齐」）：");
  console.log(`   GITEE_TOKEN=*** node scripts/gitee-backfill.mjs --tag ${tag}`);
};

main().catch((e) => {
  console.error(redact(e?.message || e));
  process.exit(1);
});
