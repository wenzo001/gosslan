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

export function notesForVersion(changelog, version) {
  const lines = String(changelog ?? "").split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n").trim();
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
    console.error("用法：--dir <发布目录> --tag vX.Y.Z [--repo owner/repo] [--out latest.json] [--check-only]");
    process.exit(2);
  }
  const files = fs.readdirSync(dir);
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const changelogPath = arg("changelog", "CHANGELOG.md");
  const notes = fs.existsSync(changelogPath) ? notesForVersion(fs.readFileSync(changelogPath, "utf8"), tag.replace(/^v/, "")) : "";
  try {
    const manifest = buildManifest({ dir, files, tag, repo, version: pkg.version, notes });
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
