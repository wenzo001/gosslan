#!/usr/bin/env node
/**
 * 把 GitHub Release 的产物镜像到 Gitee，并维护固定路径的更新清单。
 *
 * 为什么需要这一册：
 * - 客户端的检查更新以 Gitee 固定清单为准，GitHub 只做备份；
 * - Gitee 空仓库没有 commit 时不能建 tag/release，必须先写一个占位提交；
 * - Gitee 单附件上限 100MB、仓库附件总量 1G，所以 WebView2 内置包不上传，
 *   旧 release 按保留数清理（当前版本永不删）。
 *
 * 客户端固定清单：
 *   https://gitee.com/{repo}/raw/master/updates/latest.json
 *
 * 用法：
 *   node scripts/sync-gitee.mjs --tag v5.18.78 --assets-dir assets --keep 8
 *   node scripts/sync-gitee.mjs --tag v5.18.78 --assets-dir assets --keep 8 --dry-run
 *
 * 令牌只从环境变量 GITEE_TOKEN 读取；任何错误信息都会把令牌替换成 `***`。
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { REQUIRED_PLATFORMS } from "./updater-manifest.mjs";

const API = "https://gitee.com/api/v5";
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_KEEP = 8;
const REQUIRED_ANDROID_PLATFORMS = ["android-aarch64", "android-armv7"];
const MANIFEST_PATH = "updates/latest.json";

let TOKEN = "";

export function setToken(value) {
  TOKEN = String(value ?? "");
}

export function redact(text) {
  const raw = String(text ?? "");
  return TOKEN ? raw.split(TOKEN).join("***") : raw;
}

export function giteeDownloadUrl(repo, tag, name) {
  return `https://gitee.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function basenameFromUrl(raw) {
  const u = new URL(String(raw));
  const seg = u.pathname.split("/").pop();
  if (!seg) throw new Error(`URL 没有文件名：${raw}`);
  return decodeURIComponent(seg);
}

export function androidPlatformFor(name) {
  if (name.endsWith("-arm64-v8a-release.apk")) return "android-aarch64";
  if (name.endsWith("-armeabi-v7a-release.apk")) return "android-armv7";
  if (name.endsWith("-x86_64-release.apk")) return "android-x86_64";
  if (name.endsWith("-x86-release.apk")) return "android-x86";
  return null;
}

/**
 * Gitee 单附件 100MB，且固定清单不重复上传。返回跳过原因，`null` 表示要上传。
 * 这是纯函数，工作流里“按大小预筛”和脚本里“再筛一遍”共用同一口径。
 */
export function skipReason(name, size) {
  if (name === "latest.json") return "固定清单单独提交，不重复上传";
  if (/webview2/i.test(name)) return "WebView2 内置包超过 Gitee 单附件 100MB 上限";
  if (size > MAX_ATTACHMENT_BYTES) {
    return `单文件 ${size} 字节超过 100MB 上限`;
  }
  return null;
}

/**
 * 用 GitHub 的 latest.json 生成 Gitee 清单：
 * - 四个桌面平台的 url 改指 Gitee 附件地址，签名原样复用；
 * - 追加 Android 平台（url + sha256 + size），Android 客户端据此校验 APK。
 *
 * Tauri 的静态清单平台对象只读 `url` / `signature`，额外字段和额外平台会被忽略；
 * Android 的 `signature` 留空是刻意的：Android 不用 minisign，改用 `sha256` 校验。
 */
export function buildGiteeManifest({ githubManifest, tag, repo, androidAssets = [] }) {
  if (!githubManifest || typeof githubManifest !== "object") {
    throw new Error("GitHub latest.json 为空");
  }
  const version = String(tag).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`tag 不是 v<semver>：${tag}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo 形状不对：${repo}`);
  if (githubManifest.version !== version) {
    throw new Error(`GitHub 清单版本 ${githubManifest.version} 与 tag ${tag} 不一致`);
  }

  const platforms = {};
  for (const p of REQUIRED_PLATFORMS) {
    const src = githubManifest.platforms?.[p];
    if (!src?.url || !src?.signature) throw new Error(`GitHub 清单缺平台 ${p}`);
    const name = basenameFromUrl(src.url);
    platforms[p] = {
      signature: src.signature,
      url: giteeDownloadUrl(repo, tag, name),
    };
  }

  const androidSeen = new Set();
  for (const a of androidAssets) {
    if (!a?.platform || !a?.name || !a?.sha256) {
      throw new Error(`Android 资产条目不完整：${JSON.stringify(a)}`);
    }
    if (!REQUIRED_ANDROID_PLATFORMS.includes(a.platform)) continue;
    platforms[a.platform] = {
      signature: "",
      url: giteeDownloadUrl(repo, tag, a.name),
      sha256: a.sha256,
      size: a.size,
    };
    androidSeen.add(a.platform);
  }
  const missingAndroid = REQUIRED_ANDROID_PLATFORMS.filter((p) => !androidSeen.has(p));
  if (missingAndroid.length) {
    throw new Error(`Gitee 清单缺 Android 平台：${missingAndroid.join(", ")}`);
  }

  return {
    ...githubManifest,
    platforms,
  };
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseVersion(raw) {
  const value = String(raw ?? "").trim().replace(/^v/i, "");
  const core = value.split("-")[0];
  if (!/^\d+\.\d+\.\d+$/.test(core)) return null;
  return core.split(".").map(Number);
}

/** 只用于 release 保留排序；非法版本按 0 处理并排到最后。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * 保留最近 `keep` 个 release，但**当前 tag 永不删除**。
 * 返回 keep/remove 两份清单，调用方先打印 dry-run 再执行删除。
 */
export function prunePlan(releases, currentTag, keep) {
  const list = (releases ?? []).filter((r) => r && r.id && r.tag_name);
  const sorted = [...list].sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const keepTags = new Set();
  const current = sorted.find((r) => r.tag_name === currentTag);
  if (current) keepTags.add(current.tag_name);
  for (const r of sorted) {
    if (keepTags.size >= keep) break;
    keepTags.add(r.tag_name);
  }
  return {
    keep: sorted.filter((r) => keepTags.has(r.tag_name)),
    remove: sorted.filter((r) => !keepTags.has(r.tag_name)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method, apiPath, { query = {}, json, allow404 = false } = {}) {
  const url = new URL(`${API}${apiPath}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", TOKEN);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: json ? { "Content-Type": "application/json" } : undefined,
      body: json ? JSON.stringify(json) : undefined,
    });
  } catch (e) {
    throw new Error(redact(`Gitee API ${method} ${apiPath} 请求失败：${e.message}`));
  }
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(redact(`Gitee API ${method} ${apiPath} 返回 HTTP ${res.status}：${text.slice(0, 300)}`));
  }
  if (res.status === 204) return null;
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(redact(`Gitee API ${method} ${apiPath} 返回非 JSON：${text.slice(0, 200)}`));
  }
}

async function listAll(apiPath, query = {}) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await api("GET", apiPath, { query: { ...query, per_page: 100, page } });
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

async function ensureRepo(repo) {
  let info = await api("GET", `/repos/${repo}`);
  let branch = info?.default_branch || "master";
  const branches = await listAll(`/repos/${repo}/branches`);
  if (branches.length === 0) {
    console.log(`Gitee 仓库为空 ⇒ 在 ${branch} 建占位提交`);
    await api("POST", `/repos/${repo}/contents/README.md`, {
      json: {
        content: Buffer.from(
          "# Gosslan release mirror\n\n本仓库只存放 Gosslan 的发版产物与更新清单。\n",
          "utf8",
        ).toString("base64"),
        message: "chore: initialize release mirror",
        branch,
      },
    });
    info = await api("GET", `/repos/${repo}`);
    branch = info?.default_branch || branch;
  }
  if (branch !== "master") {
    throw new Error(
      `Gitee 默认分支是 ${branch}，但客户端固定地址写的是 raw/master；` +
        "请先把默认分支改为 master，或同步修改客户端地址后重跑",
    );
  }
  return branch;
}

async function ensureTag(repo, tag, branch, tags) {
  if (tags.some((t) => (t.name || t.tag_name) === tag)) {
    console.log(`tag ${tag} 已存在`);
    return;
  }
  await api("POST", `/repos/${repo}/tags`, {
    json: { refs: branch, tag_name: tag, tag_message: `Gosslan ${tag}` },
  });
  console.log(`已创建 tag ${tag} -> ${branch}`);
}

async function ensureRelease(repo, tag, branch, body) {
  const existing = await api("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    allow404: true,
  });
  if (!existing) {
    const created = await api("POST", `/repos/${repo}/releases`, {
      json: {
        tag_name: tag,
        name: `Gosslan ${tag}`,
        body,
        target_commitish: branch,
        prerelease: false,
      },
    });
    console.log(`已创建 release ${tag}（id ${created.id}）`);
    return created;
  }
  const updated = await api("PATCH", `/repos/${repo}/releases/${existing.id}`, {
    // Gitee 的更新接口要求 `tag_name` 必填（缺了会 400 "tag_name is missing"），
    // 与 GitHub 允许只改 name/body 不同。
    json: { tag_name: tag, name: `Gosslan ${tag}`, body },
  });
  console.log(`已更新 release ${tag}（id ${updated.id}）`);
  return updated;
}

/**
 * 附件上传走 `curl`，不走 `fetch`。
 *
 * 现场（2026-11-07 演练 v5.18.78）：7MB 的 `Gosslan-arm64.app.tar.gz` 在 GitHub
 * runner 上正好 300 秒后报 `fetch failed` —— 那是 undici 的 `bodyTimeout` 默认值，
 * 不是 Gitee 拒绝。Node 内置 fetch 不暴露 dispatcher，改不了这个上限；curl 没有
 * body 超时，慢链路上也能把包传完。令牌只放在 URL 查询串里，失败信息统一打码。
 */
async function uploadAsset(repo, releaseId, name, file) {
  const url = `${API}/repos/${repo}/releases/${releaseId}/attach_files?access_token=${encodeURIComponent(TOKEN)}`;
  const res = spawnSync(
    "curl",
    [
      "-sS",
      "--fail-with-body",
      // 单个文件最长 30 分钟；远端 5xx/连接中断时重试 3 次（同一次重试可能留下重名附件，
      // 下一次运行开头的“同名旧附件先删”会收敛，不会累加）。
      "--max-time", "1800",
      "--retry", "3",
      "--retry-delay", "10",
      "--retry-all-errors",
      "-X", "POST",
      url,
      "-F", `file=@${file};filename=${name}`,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (res.error) {
    throw new Error(redact(`上传 ${name} 启动 curl 失败：${res.error.message}`));
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim().slice(0, 300);
    throw new Error(redact(`上传 ${name} 失败（curl exit ${res.status}）：${detail}`));
  }
}

async function commitManifest(repo, branch, content, message) {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const existing = await api("GET", `/repos/${repo}/contents/${MANIFEST_PATH}`, {
    query: { ref: branch },
    allow404: true,
  });
  if (existing?.sha) {
    await api("PUT", `/repos/${repo}/contents/${MANIFEST_PATH}`, {
      json: { content: b64, message, sha: existing.sha, branch },
    });
  } else {
    await api("POST", `/repos/${repo}/contents/${MANIFEST_PATH}`, {
      json: { content: b64, message, branch },
    });
  }
  console.log(`已提交 ${MANIFEST_PATH}（${branch}）`);
}

async function checkAnonymous(url, want = {}) {
  let res;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow", cache: "no-store" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0", "Cache-Control": "no-cache" },
      });
    }
  } catch (e) {
    throw new Error(`匿名访问失败 ${url}：${e.message}`);
  }
  const type = res.headers.get("content-type") || "";
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`匿名访问 ${url} 返回 HTTP ${res.status}`);
  }
  if (/text\/html/i.test(type)) {
    throw new Error(`匿名访问 ${url} 返回 HTML（多半是 404 页面），不是文件`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (want.minBytes && len < want.minBytes) {
    throw new Error(`匿名访问 ${url} 的 content-length=${len}，小于 ${want.minBytes}`);
  }
  return { status: res.status, type, length: len };
}

async function verifyPublic({ repo, tag, manifest, assetsDir }) {
  const rawUrl = `https://gitee.com/${repo}/raw/master/${MANIFEST_PATH}`;
  let lastErr;
  for (let i = 0; i < 12; i += 1) {
    try {
      const res = await fetch(`${rawUrl}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const got = JSON.parse(await res.text());
      if (got.version !== manifest.version) {
        throw new Error(`公开清单版本 ${got.version} ≠ ${manifest.version}`);
      }
      for (const p of [...REQUIRED_PLATFORMS, ...REQUIRED_ANDROID_PLATFORMS]) {
        if (!got.platforms?.[p]?.url) throw new Error(`公开清单缺平台 ${p}`);
      }
      console.log(`公开清单可读：${rawUrl}（version ${got.version}）`);
      return got;
    } catch (e) {
      lastErr = e;
      console.log(`等待公开清单生效（第 ${i + 1} 次）：${e.message}`);
      await sleep(5000);
    }
  }
  throw new Error(`公开清单不可用：${lastErr?.message ?? "未知原因"}`);
}

async function verifyAssets(manifest, assetsDir, filesByName) {
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const name = basenameFromUrl(entry.url);
    const local = filesByName.get(name);
    const head = await checkAnonymous(entry.url, { minBytes: 1 });
    console.log(`  ${platform}: 匿名可达（HTTP ${head.status}，${head.type}）${name}`);
    if (!local) continue;
    // 至少完整下载一个桌面产物与一个 APK，字节级对齐本地（证明匿名下载拿到的是真文件）。
    const mustDownload =
      platform === "windows-x86_64" || platform === "android-aarch64";
    if (!mustDownload) continue;
    const res = await fetch(entry.url, { redirect: "follow", cache: "no-store" });
    if (!res.ok) throw new Error(`完整下载 ${name} 返回 HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== local.size) {
      throw new Error(`${name} 大小不符：Gitee ${bytes.length}，本地 ${local.size}`);
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== local.sha256) {
      throw new Error(`${name} sha256 不符：Gitee ${digest}，本地 ${local.sha256}`);
    }
    console.log(`  ${platform}: 完整下载 ${bytes.length} 字节，sha256 与本地一致`);
    if (entry.sha256 && entry.sha256 !== digest) {
      throw new Error(`${name} 清单 sha256 与文件不符`);
    }
  }
}

function parseArgs(argv) {
  const arg = (name, fallback = "") => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const keepRaw = Number(arg("keep", String(DEFAULT_KEEP)));
  const keep = Number.isFinite(keepRaw) && keepRaw >= 1 ? Math.floor(keepRaw) : DEFAULT_KEEP;
  return {
    tag: arg("tag") || process.env.TAG || "",
    assetsDir: arg("assets-dir", process.env.ASSETS_DIR || "assets"),
    repo: arg("repo", process.env.GITEE_REPO || "fwdq/gosslan-releases"),
    githubRepo: process.env.GITHUB_REPO || "wenzo001/gosslan",
    keep,
    dryRun: argv.includes("--dry-run") || process.env.DRY_RUN === "1",
  };
}

async function main(argv) {
  const { tag, assetsDir, repo, githubRepo, keep, dryRun } = parseArgs(argv);
  setToken(process.env.GITEE_TOKEN || "");
  if (!TOKEN) throw new Error("缺少 GITEE_TOKEN");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`非法 tag：${tag}`);
  if (!fs.existsSync(assetsDir)) throw new Error(`资产目录不存在：${assetsDir}`);

  const names = fs.readdirSync(assetsDir).filter((n) => fs.statSync(path.join(assetsDir, n)).isFile());
  const files = names.map((name) => {
    const full = path.join(assetsDir, name);
    const size = fs.statSync(full).size;
    return { name, path: full, size, sha256: sha256File(full) };
  });
  const filesByName = new Map(files.map((f) => [f.name, f]));

  const latestFile = path.join(assetsDir, "latest.json");
  if (!fs.existsSync(latestFile)) {
    throw new Error("资产目录缺 latest.json —— 先确认 GitHub Release 已发布");
  }
  const githubManifest = JSON.parse(fs.readFileSync(latestFile, "utf8"));

  const androidAssets = [];
  for (const f of files) {
    const platform = androidPlatformFor(f.name);
    if (platform) androidAssets.push({ platform, name: f.name, size: f.size, sha256: f.sha256 });
  }
  const manifest = buildGiteeManifest({ githubManifest, tag, repo, androidAssets });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  const uploads = [];
  const skipped = [];
  for (const f of files) {
    const reason = skipReason(f.name, f.size);
    if (reason) skipped.push({ ...f, reason });
    else uploads.push(f);
  }
  console.log(`待上传 ${uploads.length} 个文件，跳过 ${skipped.length} 个`);
  for (const s of skipped) console.log(`  跳过 ${s.name}（${s.size} 字节）：${s.reason}`);

  const branch = await ensureRepo(repo);
  const tags = await listAll(`/repos/${repo}/tags`);
  await ensureTag(repo, tag, branch, tags);

  const skippedNote = skipped.some((s) => /webview2/i.test(s.name))
    ? "\n\n> WebView2 内置安装包超过 Gitee 单附件 100MB 上限，未镜像；需要该版本请从 GitHub Release 下载。"
    : "";
  const body =
    `${String(githubManifest.notes ?? "").trim()}\n\n---\n\n` +
    `Gitee 镜像：https://gitee.com/${repo}/releases/tag/${tag}\n` +
    `GitHub 原版：https://github.com/${githubRepo}/releases/tag/${tag}${skippedNote}`;
  const release = await ensureRelease(repo, tag, branch, body);

  const existing = await listAll(`/repos/${repo}/releases/${release.id}/attach_files`);
  // 现场（2026-11-07）：GitHub runner 直连 Gitee 上传约 10KB/s，单个 release 74MB
  // 串行要两个多小时。按连接限速的特征 ⇒ 4 路并发明显更快，失败仍靠同名先删再传收敛。
  const CONCURRENCY = 4;
  const queue = [...uploads];
  async function uploadWorker() {
    while (queue.length > 0) {
      const f = queue.shift();
      const old = existing.find((a) => a.name === f.name);
      if (old) {
        await api("DELETE", `/repos/${repo}/releases/${release.id}/attach_files/${old.id}`);
        console.log(`  删除同名旧附件 ${f.name}`);
      }
      console.log(`  开始上传 ${f.name}（${f.size} 字节）`);
      await uploadAsset(repo, release.id, f.name, f.path);
      console.log(`  已上传 ${f.name}（${f.size} 字节）`);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, uploads.length) }, () => uploadWorker()),
  );

  await commitManifest(
    repo,
    branch,
    manifestText,
    `chore(release): latest.json ${tag}（Gitee 固定清单）`,
  );

  console.log("匿名校验固定清单与附件：");
  const publicManifest = await verifyPublic({ repo, tag, manifest, assetsDir });
  await verifyAssets(publicManifest, assetsDir, filesByName);

  const releases = await listAll(`/repos/${repo}/releases`);
  const plan = prunePlan(releases, tag, keep);
  console.log(`保留策略：最近 ${keep} 个 release，当前 ${tag} 永不删除`);
  for (const r of plan.keep) console.log(`  保留 ${r.tag_name}（${r.created_at ?? "?"}）`);
  for (const r of plan.remove) {
    console.log(`  ${dryRun ? "[dry-run] 将删除" : "删除"} ${r.tag_name}（id ${r.id}，${r.created_at ?? "?"}）`);
  }
  if (!dryRun) {
    for (const r of plan.remove) {
      await api("DELETE", `/repos/${repo}/releases/${r.id}`);
    }
  }

  console.log(
    `完成：${tag} 已同步到 Gitee；上传 ${uploads.length}，跳过 ${skipped.length}，清理 ${dryRun ? "0（dry-run）" : plan.remove.length}`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✗ ${redact(e?.message ?? e)}`);
    process.exit(1);
  });
}
