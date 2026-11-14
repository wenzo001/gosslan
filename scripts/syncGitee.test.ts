// 发布链同源判据：Gitee 清单的四个桌面平台 url 必须全部落在 Gitee 域且不得残留
// GitHub 域；反向地，GitHub 清单的 url 必须落在 GitHub 域。判据只检查四个桌面
// 平台的 url —— notes 里出现 GitHub 链接是正常的发布说明，把它算进来会误判。
// 跑法：node --test --experimental-strip-types --disable-warning=ExperimentalWarning scripts/syncGitee.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGiteeManifest } from "./sync-gitee.mjs";
import { buildManifest, REQUIRED_PLATFORMS } from "./updater-manifest.mjs";

const SIG = "untrusted comment: signature\n" + "A".repeat(64);

/**
 * 纯函数判据：给定清单，检查四个桌面平台 url 是否全部落在 expectHost，
 * 且没有一个残留 forbidHost。返回问题描述数组，空数组表示通过。
 * 只依赖入参对象，不读文件、不发请求，方便用手工构造的混域清单做正控。
 */
function sameOriginProblems(
  manifest: { platforms?: Record<string, { url?: string }> } | null,
  expectHost: string,
  forbidHost: string,
): string[] {
  const problems: string[] = [];
  for (const p of REQUIRED_PLATFORMS) {
    const raw = manifest?.platforms?.[p]?.url;
    if (!raw) {
      problems.push(`${p}: 缺 url`);
      continue;
    }
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      problems.push(`${p}: url 不可解析 ${raw}`);
      continue;
    }
    if (host !== expectHost) problems.push(`${p}: host=${host}，期望 ${expectHost}`);
    // 既查解析后的 host，也查原文子串，防止把域名塞进 path/query 里绕过判据。
    if (host === forbidHost || raw.includes(forbidHost)) {
      problems.push(`${p}: 残留 ${forbidHost} 域`);
    }
  }
  return problems;
}

function giteeInput() {
  const platforms: Record<string, { signature: string; url: string }> = {};
  const names: Record<string, string> = {
    "darwin-aarch64": "Gosslan-arm64.app.tar.gz",
    "darwin-x86_64": "Gosslan-x64.app.tar.gz",
    "windows-x86_64": "Gosslan_5.5.0_x64-setup.exe",
    "windows-aarch64": "Gosslan_5.5.0_arm64-setup.exe",
  };
  for (const p of REQUIRED_PLATFORMS) {
    platforms[p] = {
      signature: SIG,
      url: `https://github.com/wenzo001/gosslan/releases/download/v5.5.0/${names[p]}`,
    };
  }
  return {
    githubManifest: { version: "5.5.0", notes: "修复若干问题", pub_date: "2026-01-01T00:00:00Z", platforms },
    tag: "v5.5.0",
    repo: "fwdq/gosslan-releases",
    androidAssets: [
      { platform: "android-aarch64", name: "gosslan-5.5.0-arm64-v8a-release.apk", size: 1, sha256: "a".repeat(64) },
      { platform: "android-armv7", name: "gosslan-5.5.0-armeabi-v7a-release.apk", size: 1, sha256: "b".repeat(64) },
    ],
  };
}

/** 反向判据要验的是真 buildManifest 的产物，所以用临时目录落一份最小签名产物。 */
function githubManifestFromBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-same-origin-"));
  const names = [
    "Gosslan-arm64.app.tar.gz",
    "Gosslan-x64.app.tar.gz",
    "Gosslan_5.5.0_x64-setup.exe",
    "Gosslan_5.5.0_arm64-setup.exe",
  ];
  for (const n of names) {
    fs.writeFileSync(path.join(dir, n), "bytes");
    fs.writeFileSync(path.join(dir, `${n}.sig`), SIG);
  }
  return buildManifest({
    dir,
    files: [...names, ...names.map((n) => `${n}.sig`)],
    tag: "v5.5.0",
    repo: "wenzo001/gosslan",
    version: "5.5.0",
  });
}

test("发布链同源：buildGiteeManifest 的四个桌面平台 url 全在 Gitee 域且无 GitHub 残留", () => {
  const out = buildGiteeManifest(giteeInput());
  const problems = sameOriginProblems(out, "gitee.com", "github.com");
  assert.deepEqual(problems, [], `Gitee 清单出现混域：${problems.join("; ")}`);
  for (const p of REQUIRED_PLATFORMS) {
    assert.ok(
      out.platforms[p].url.startsWith("https://gitee.com/fwdq/gosslan-releases/releases/download/v5.5.0/"),
      `${p} 的 url 必须落在 Gitee 附件路径`,
    );
  }
  // 判据只读桌面 url：notes 里的 GitHub 链接是正常发布说明，不能被误判成混域。
  const withNotes = { ...out, notes: "GitHub 原版：https://github.com/wenzo001/gosslan/releases/tag/v5.5.0" };
  assert.deepEqual(sameOriginProblems(withNotes, "gitee.com", "github.com"), [], "notes 里的 GitHub 链接不该判红");
});

test("发布链同源反向：buildManifest 产出的 url 全在 GitHub 域且无 Gitee 残留", () => {
  const m = githubManifestFromBuild();
  const problems = sameOriginProblems(m, "github.com", "gitee.com");
  assert.deepEqual(problems, [], `GitHub 清单出现混域：${problems.join("; ")}`);
  for (const p of REQUIRED_PLATFORMS) {
    assert.ok(
      m.platforms[p].url.startsWith("https://github.com/wenzo001/gosslan/releases/download/v5.5.0/"),
      `${p} 的 url 必须落在 GitHub 附件路径`,
    );
  }
});

test("正控：构造一个混域清单，同源判据必须判红（不是恒绿量具）", () => {
  const mixed = buildGiteeManifest(giteeInput());
  // 模拟「三个平台改写了、漏了一个」的回归：把 windows-x86_64 的 url 改回 GitHub。
  mixed.platforms["windows-x86_64"].url =
    "https://github.com/wenzo001/gosslan/releases/download/v5.5.0/Gosslan_5.5.0_x64-setup.exe";
  const problems = sameOriginProblems(mixed, "gitee.com", "github.com");
  assert.ok(problems.length > 0, "混域清单必须被判红");
  assert.ok(problems.some((p) => p.includes("windows-x86_64")), "必须点名漏改的那个平台");
  assert.ok(problems.some((p) => p.includes("github.com")), "必须点出残留的 GitHub 域");
  // 同一量具对未变异的清单必须恒绿，证明红灯来自变异而不是量具本身。
  assert.deepEqual(sameOriginProblems(buildGiteeManifest(giteeInput()), "gitee.com", "github.com"), []);
});
