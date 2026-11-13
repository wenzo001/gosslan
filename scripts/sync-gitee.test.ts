// Gitee 同步脚本的纯逻辑判据：清单重写、Android 平台、跳过策略、保留排序、令牌打码。
// 跑法：node --test scripts/sync-gitee.test.ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  androidPlatformFor,
  basenameFromUrl,
  buildGiteeManifest,
  checkAnonymous,
  compareVersions,
  giteeDownloadUrl,
  prunePlan,
  redact,
  setToken,
  skipReason,
} from "./sync-gitee.mjs";
import { REQUIRED_PLATFORMS } from "./updater-manifest.mjs";

const SIG = "untrusted comment: signature\n" + "A".repeat(64);

function githubManifest() {
  const platforms: Record<string, { signature: string; url: string }> = {};
  const urls: Record<string, string> = {
    "darwin-aarch64": "https://github.com/wenzo001/gosslan/releases/download/v5.18.78/Gosslan-arm64.app.tar.gz",
    "darwin-x86_64": "https://github.com/wenzo001/gosslan/releases/download/v5.18.78/Gosslan-x86_64.app.tar.gz",
    "windows-aarch64": "https://github.com/wenzo001/gosslan/releases/download/v5.18.78/Gosslan_5.18.78_arm64-setup.exe",
    "windows-x86_64": "https://github.com/wenzo001/gosslan/releases/download/v5.18.78/Gosslan_5.18.78_x64-setup.exe",
  };
  for (const p of REQUIRED_PLATFORMS) platforms[p] = { signature: SIG, url: urls[p] };
  return { version: "5.18.78", notes: "修复若干问题", pub_date: "2026-01-01T00:00:00Z", platforms };
}

function androidAssets() {
  return [
    {
      platform: "android-aarch64",
      name: "gosslan-5.18.78-arm64-v8a-release.apk",
      size: 1,
      sha256: "a".repeat(64),
    },
    {
      platform: "android-armv7",
      name: "gosslan-5.18.78-armeabi-v7a-release.apk",
      size: 1,
      sha256: "b".repeat(64),
    },
  ];
}

test("Gitee 清单：桌面 URL 改指 Gitee，签名原样复用，并追加 Android 平台", () => {
  const out = buildGiteeManifest({
    githubManifest: githubManifest(),
    tag: "v5.18.78",
    repo: "fwdq/gosslan-releases",
    androidAssets: androidAssets(),
  });

  assert.equal(out.version, "5.18.78");
  assert.equal(out.notes, "修复若干问题");
  for (const p of REQUIRED_PLATFORMS) {
    assert.equal(out.platforms[p].signature, SIG, "签名必须原样复用，不能重签");
    assert.ok(
      out.platforms[p].url.startsWith(
        "https://gitee.com/fwdq/gosslan-releases/releases/download/v5.18.78/",
      ),
      `${p} 的 url 必须指向 Gitee`,
    );
  }
  assert.equal(
    out.platforms["android-aarch64"].url,
    giteeDownloadUrl(
      "fwdq/gosslan-releases",
      "v5.18.78",
      "gosslan-5.18.78-arm64-v8a-release.apk",
    ),
  );
  assert.equal(out.platforms["android-aarch64"].sha256, "a".repeat(64));
  assert.equal(out.platforms["android-armv7"].signature, "", "Android 用 sha256，不用 minisign");
});

test("Gitee 清单：版本不一致、缺桌面平台、缺 Android 平台都必须拒绝", () => {
  assert.throws(
    () =>
      buildGiteeManifest({
        githubManifest: { ...githubManifest(), version: "5.18.77" },
        tag: "v5.18.78",
        repo: "fwdq/gosslan-releases",
        androidAssets: androidAssets(),
      }),
    /版本.*不一致/,
  );

  const missingDesktop = githubManifest();
  delete (missingDesktop.platforms as Record<string, unknown>)["windows-x86_64"];
  assert.throws(
    () =>
      buildGiteeManifest({
        githubManifest: missingDesktop,
        tag: "v5.18.78",
        repo: "fwdq/gosslan-releases",
        androidAssets: androidAssets(),
      }),
    /缺平台/,
  );

  assert.throws(
    () =>
      buildGiteeManifest({
        githubManifest: githubManifest(),
        tag: "v5.18.78",
        repo: "fwdq/gosslan-releases",
        androidAssets: androidAssets().filter((a) => a.platform !== "android-armv7"),
      }),
    /缺 Android 平台/,
  );
});

test("跳过策略：只跳过固定清单、WebView2 与超 100MB 文件", () => {
  assert.match(String(skipReason("latest.json", 100)), /固定清单/);
  assert.match(String(skipReason("Gosslan_5.18.78_x64-setup-webview2-bundled.exe", 197850616)), /WebView2/);
  assert.match(String(skipReason("big.bin", 100 * 1024 * 1024 + 1)), /100MB/);
  assert.equal(skipReason("Gosslan_5.18.78_x64-setup.exe", 5973178), null);
  assert.equal(skipReason("gosslan-5.18.78-arm64-v8a-release.apk", 17521727), null);
});

test("保留策略：最近 N 个 + 当前 tag 永不删", () => {
  const releases = [
    { id: 1, tag_name: "v5.18.70", created_at: "a" },
    { id: 2, tag_name: "v5.18.77", created_at: "b" },
    { id: 3, tag_name: "v5.18.78", created_at: "c" },
    { id: 4, tag_name: "v5.18.79", created_at: "d" },
    { id: 5, tag_name: "v5.18.76", created_at: "e" },
  ];
  const plan = prunePlan(releases, "v5.18.78", 3);
  assert.deepEqual(plan.keep.map((r) => r.tag_name).sort(), ["v5.18.77", "v5.18.78", "v5.18.79"]);
  assert.deepEqual(plan.remove.map((r) => r.tag_name).sort(), ["v5.18.70", "v5.18.76"]);
  assert.ok(!plan.remove.some((r) => r.tag_name === "v5.18.78"), "当前 tag 不能被清理");
});

test("保留策略：回填旧 tag 时当前 tag 也保留，不会被最新版本挤掉", () => {
  const releases = [
    { id: 1, tag_name: "v5.18.76" },
    { id: 2, tag_name: "v5.18.77" },
    { id: 3, tag_name: "v5.18.78" },
  ];
  const plan = prunePlan(releases, "v5.18.76", 2);
  assert.ok(plan.keep.some((r) => r.tag_name === "v5.18.76"));
  assert.ok(!plan.remove.some((r) => r.tag_name === "v5.18.76"));
});

test("工具函数：URL 文件名解码、Android 平台识别、版本比较", () => {
  assert.equal(
    basenameFromUrl("https://gitee.com/x/y/releases/download/v1/Gosslan%20x.exe"),
    "Gosslan x.exe",
  );
  assert.equal(androidPlatformFor("gosslan-1-arm64-v8a-release.apk"), "android-aarch64");
  assert.equal(androidPlatformFor("gosslan-1-armeabi-v7a-release.apk"), "android-armv7");
  assert.equal(androidPlatformFor("gosslan-1-x86_64-release.apk"), "android-x86_64");
  assert.equal(androidPlatformFor("gosslan-1-universal.apk"), null);
  assert.ok(compareVersions("v5.18.79", "v5.18.78") > 0);
  assert.ok(compareVersions("v5.18.78", "v5.18.78") === 0);
  assert.ok(compareVersions("v5.18.70", "v5.18.78") < 0);
});

test("令牌打码：错误信息里不能出现 token 原文", () => {
  setToken("secret-token-123");
  assert.equal(redact("bad secret-token-123 in url"), "bad *** in url");
  setToken("");
  assert.equal(redact("nothing"), "nothing");
});

// 匿名校验的瞬时失败重试（2026-11-13 v5.22.1 finalize 两次死在跨洋 fetch failed）。
// delay 注入成即时 ⇒ 不真等 2s/5s/10s；fetch 打桩模拟跨洋抖动与确定性 404。
test("checkAnonymous：瞬时 fetch failed 重试后成功（与已认证 api() 同口径）", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return { status: 200, headers: new Map([["content-type", "application/gzip"], ["content-length", "100"]]) };
  }) as unknown as typeof fetch;
  try {
    const out = await checkAnonymous("https://gitee.com/x/y", { minBytes: 1 }, async () => {});
    assert.equal(out.status, 200);
    assert.equal(calls, 3, "前两次瞬时失败、第三次成功 ⇒ 重试真的接住了（删掉重试这条会红）");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkAnonymous：404 不重试（文件真不在，重试只是把失败拖长）", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { status: 404, headers: new Map([["content-type", "text/html"]]) };
  }) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () => checkAnonymous("https://gitee.com/x/y", { minBytes: 1 }, async () => {}),
      /HTTP 404/,
    );
    assert.equal(calls, 1, "404 是确定性失败，不许重试");
  } finally {
    globalThis.fetch = realFetch;
  }
});
