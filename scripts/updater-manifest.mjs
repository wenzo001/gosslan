#!/usr/bin/env node
/**
 * 生成 Tauri updater 的 `latest.json`（静态清单）。
 *
 * 只做三件事：把发布目录里的 updater 产物与 `.sig` 配对、映射成 Tauri 的平台键、
 * 校验 tag/版本/四个桌面平台齐全。任何一项缺失都判红 —— 少了平台的清单会被
 * 客户端当成“这个平台没有更新”，比不发还难查。
 *
 * 用法：
 *   node scripts/updater-manifest.mjs --dir assets --tag v5.5.0 --repo wenzo001/gosslan --out latest.json
 *   node scripts/updater-manifest.mjs --dir assets --tag v5.5.0 --check-only
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
  "windows-aarch64",
];

const MAC_RE = /\.app\.tar\.gz$/;
const WIN_RE = /(?:-setup\.exe|\.nsis\.zip)$/;

function archOf(name) {
  if (/aarch64|arm64/i.test(name)) return "aarch64";
  if (/x86_64|x64|intel/i.test(name)) return "x86_64";
  return null;
}

function isSignature(name) {
  return name.endsWith(".sig");
}

/** 把发布目录里的文件名映射成 `{platform: {urlName, sigName}}`。 */
export function mapPlatformAssets(files) {
  const names = [...files];
  const picked = {};
  const consider = (platform, file) => {
    if (!file || !names.includes(file)) return;
    if (!names.includes(`${file}.sig`)) return;
    // 同平台多个候选时优先 `.nsis.zip`（Tauri v1 兼容包），其次 exe；其余判重。
    const prev = picked[platform];
    if (prev && prev.file !== file) {
      const preferNew = file.endsWith(".nsis.zip") && !prev.file.endsWith(".nsis.zip");
      if (!preferNew) return;
    }
    picked[platform] = { file, sig: `${file}.sig` };
  };
  for (const name of names) {
    if (isSignature(name)) continue;
    if (/webview2/i.test(name)) continue; // 内置 WebView2 档不进自动更新清单
    if (MAC_RE.test(name)) {
      const arch = archOf(name);
      if (arch === "aarch64") consider("darwin-aarch64", name);
      else if (arch === "x86_64") consider("darwin-x86_64", name);
      continue;
    }
    if (WIN_RE.test(name)) {
      const arch = archOf(name);
      if (arch === "aarch64") consider("windows-aarch64", name);
      else if (arch === "x86_64") consider("windows-x86_64", name);
    }
  }
  return picked;
}

/**
 * 把 CHANGELOG 切成一节一节。只认带日期头的版本节（`## [x.y.z] - YYYY-MM-DD`）；
 * `[Unreleased]` 之类不收集，但它们会**结束**上一节 —— 否则 Unreleased 的内容会被算进上一版。
 */
function parseSections(changelog) {
  const sections = [];
  let cur = null;
  for (const line of String(changelog ?? "").split("\n")) {
    const m = line.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { version: m[1], body: [] };
      continue;
    }
    if (/^## \[/.test(line)) {
      if (cur) sections.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({ version: s.version, body: s.body.join("\n").trim() }));
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function notesForVersion(changelog, version) {
  const hit = parseSections(changelog).find((s) => s.version === version);
  return hit ? hit.body : "";
}

/**
 * 一次发布要写进 `latest.json.notes` 的正文。
 *
 * 为什么需要"从哪一版之后"这个入参：门禁要求每批未推送提交都提一档，而实际发版往往隔几批才做一次
 * ⇒ CHANGELOG 顶部会堆着好几节。只取被发布那一版的话，前面几节的内容**永远不会**出现在应用内
 * 更新说明里（2026-11-01 的 v5.16.6 就是这样：5.16.0 的三处右键菜单一个字没进去）。
 *
 * `fromVersion` 缺失（或工作流拿不到上一版 tag）时退回单节行为 —— 宁可少写，不可乱写。
 * 顺序按版本从新到旧；重复标题（本仓有历史改号留下的同名节）只取第一份。
 */
export function notesForRelease(changelog, version, fromVersion = "") {
  const sections = parseSections(changelog);
  const target = sections.find((s) => s.version === version);
  if (!target) return "";
  const from = String(fromVersion ?? "").trim().replace(/^v/, "");
  if (!from) return target.body;
  const seen = new Set();
  const picked = sections
    .filter((s) => compareSemver(s.version, from) > 0 && compareSemver(s.version, version) <= 0)
    .sort((a, b) => compareSemver(b.version, a.version))
    .filter((s) => (seen.has(s.version) ? false : (seen.add(s.version), true)));
  if (!picked.length) return target.body;
  return picked.map((s) => s.body).filter(Boolean).join("\n\n");
}

export function buildManifest({
  dir = ".",
  files,
  tag,
  repo,
  version,
  notes = "",
  pubDate = new Date().toISOString(),
  requireAll = true,
  /**
   * 产物最小字节数。纯函数单测只造文件名、不落真实文件，所以默认 0（不查）；
   * CLI 传 1024 —— 线上出现过"上传了一个 0 字节 exe、签名照样有"的形状，
   * 客户端会下载到一个打不开的安装包，而清单看起来完全正常。
   */
  minAssetBytes = 0,
} = {}) {
  const tagVersion = String(tag).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(tagVersion)) {
    throw new Error(`tag 不是 v<semver>：${tag}`);
  }
  if (version && version !== tagVersion) {
    throw new Error(`tag ${tag} 与 package.json 版本 ${version} 不一致`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo 形状不对：${repo}`);
  const picked = mapPlatformAssets(files);
  const missing = REQUIRED_PLATFORMS.filter((p) => !picked[p]);
  if (requireAll && missing.length > 0) {
    throw new Error(`更新清单缺平台：${missing.join(", ")}`);
  }
  const platforms = {};
  for (const platform of REQUIRED_PLATFORMS) {
    const hit = picked[platform];
    if (!hit) continue;
    const sigPath = path.join(dir, hit.sig);
    const signature = fs.readFileSync(sigPath, "utf8").trim();
    if (signature.length < 20) {
      throw new Error(`${hit.sig} 是空的/过短，拒绝生成清单`);
    }
    if (minAssetBytes > 0) {
      // 0 字节安装包 + 非空签名是真实出现过的形状：清单看起来完全正常，客户端下完打不开。
      const size = fs.statSync(path.join(dir, hit.file)).size;
      if (size < minAssetBytes) {
        throw new Error(`${hit.file} 只有 ${size} 字节（要求 ≥ ${minAssetBytes}）⇒ 拒绝生成清单`);
      }
    }
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(hit.file)}`,
    };
  }
  return {
    version: tagVersion,
    notes: String(notes ?? "").trim(),
    pub_date: pubDate,
    platforms,
  };
}

/** CLI 入口：读目录 + 逐平台配对；`--check-only` 只判是否齐。 */
function main(argv) {
  const arg = (name, fallback = "") => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const dir = arg("dir");
  const tag = arg("tag");
  const repo = arg("repo", "wenzo001/gosslan");
  const out = arg("out", "latest.json");
  const checkOnly = argv.includes("--check-only");
  if (!dir || !tag) {
    console.error("用法：--dir <发布目录> --tag vX.Y.Z [--repo owner/repo] [--out latest.json] [--since vA.B.C] [--check-only]");
    process.exit(2);
  }
  const files = fs.readdirSync(dir);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const changelogPath = arg("changelog", "CHANGELOG.md");
  // `--since vX.Y.Z`：把「上一个已发布版本之后」的每一节都聚合进 notes（见 notesForRelease 的说明）。
  // 不传就退回单节行为 —— 工作流拿不到上一版 tag 时不会因为少个参数生成空说明。
  const since = arg("since");
  const notes = fs.existsSync(changelogPath)
    ? notesForRelease(fs.readFileSync(changelogPath, "utf8"), tag.replace(/^v/, ""), since)
    : "";
  try {
    const manifest = buildManifest({
      dir,
      files,
      tag,
      repo,
      version: pkg.version,
      notes,
      // 纯函数单测默认不查字节数（它们只造文件名）；CLI 这条真实路径必须查 ——
      // 否则这个"防 0 字节安装包"的开关就只是个没人用的形参。
      minAssetBytes: 1024,
    });
    if (checkOnly) {
      console.log(`✓ 四个桌面平台齐全：${Object.keys(manifest.platforms).join(", ")}`);
      return;
    }
    fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`✓ ${out}：${manifest.version}，${Object.keys(manifest.platforms).join(", ")}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
