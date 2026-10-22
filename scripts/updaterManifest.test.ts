// 更新清单生成器的行为判据：平台配对、webview2 排除、版本/tag 一致、签名非空。
// 跑法：node --test scripts/updaterManifest.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, mapPlatformAssets, notesForVersion, REQUIRED_PLATFORMS } from "./updater-manifest.mjs";

const SIG = "untrusted comment: signature\n" + "A".repeat(64);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-updater-"));
  const names = [
    "Gosslan-arm64.app.tar.gz",
    "Gosslan-arm64.app.tar.gz.sig",
    "Gosslan-x64.app.tar.gz",
    "Gosslan-x64.app.tar.gz.sig",
    "Gosslan_5.5.0_x64-setup.exe",
    "Gosslan_5.5.0_x64-setup.exe.sig",
    "Gosslan_5.5.0_arm64-setup.exe",
    "Gosslan_5.5.0_arm64-setup.exe.sig",
    "Gosslan_5.5.0_x64-setup-webview2-bundled.exe",
    "Gosslan_5.5.0_x64-setup-webview2-bundled.exe.sig",
  ];
  for (const n of names) fs.writeFileSync(path.join(dir, n), n.endsWith(".sig") ? SIG : "bytes");
  return { dir, names };
}

test("四个桌面平台配对正确，webview2 档不进入更新清单", () => {
  const { dir, names } = fixture();
  const m = buildManifest({ dir, files: names, tag: "v5.5.0", repo: "wenzo001/gosslan", version: "5.5.0" });
  assert.deepEqual(Object.keys(m.platforms), REQUIRED_PLATFORMS);
  assert.equal(m.version, "5.5.0");
  assert.equal(m.platforms["darwin-aarch64"].url.endsWith("Gosslan-arm64.app.tar.gz"), true);
  assert.equal(m.platforms["windows-x86_64"].url.endsWith("Gosslan_5.5.0_x64-setup.exe"), true);
  assert.ok(!JSON.stringify(m).includes("webview2"), "内置 WebView2 档不能出现在清单里");
  for (const p of Object.values(m.platforms)) assert.ok(p.signature.length > 20);
});

test("缺平台 / tag 与版本不一致 / 空签名都必须红", () => {
  const { dir, names } = fixture();
  assert.throws(
    () => buildManifest({ dir, files: names.filter((n) => !n.includes("arm64-setup")), tag: "v5.5.0", repo: "a/b", version: "5.5.0" }),
    /缺平台.*windows-aarch64/,
  );
  assert.throws(
    () => buildManifest({ dir, files: names, tag: "v5.5.1", repo: "a/b", version: "5.5.0" }),
    /不一致/,
  );
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-updater-bad-"));
  for (const n of names) fs.writeFileSync(path.join(badDir, n), n.endsWith(".sig") ? "" : "bytes");
  assert.throws(
    () => buildManifest({ dir: badDir, files: names, tag: "v5.5.0", repo: "a/b", version: "5.5.0" }),
    /空的/,
  );
});

test("只有带签名的产物才会被选中（没有 .sig 的文件不能冒充）", () => {
  const picked = mapPlatformAssets(["Gosslan-arm64.app.tar.gz"]);
  assert.deepEqual(picked, {});
});

test("发布收尾等待的产物名必须与两个构建矩阵的 label 一致", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const mac = read(".github/workflows/build-macos.yml");
  const win = read(".github/workflows/build.yml");
  const finalizer = read(".github/workflows/updater-manifest.yml");
  const labels = (src: string) => [...src.matchAll(/^\s+label: (\S+)\s*$/gm)].map((m) => m[1]).sort();

  const macLabels = labels(mac);
  assert.deepEqual(macLabels, ["arm64", "x86_64"]);
  const waitedMac = [...finalizer.matchAll(/"Gosslan-([\w.-]+)\.app\.tar\.gz"/g)].map((m) => m[1]).sort();
  assert.deepEqual(waitedMac, macLabels, "清单 job 等的 mac 产物名必须等于构建矩阵 label 拼出来的名字");

  const winLabels = labels(win);
  assert.deepEqual(winLabels, ["arm64", "x64"]);
  const waitedWin = [...finalizer.matchAll(/"(_[\w.-]+-setup\.exe)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(waitedWin, winLabels.map((l) => `_${l}-setup.exe`).sort());
});

test("CHANGELOG 版本小节取到下一个版本标题为止", () => {
  const notes = notesForVersion(
    "## [Unreleased]\n\n## [5.5.0] - 2026-10-22\n\n### 更新\n\n- a\n- b\n\n## [5.4.1] - 2026-10-22\n\n- old\n",
    "5.5.0",
  );
  assert.match(notes, /### 更新/);
  assert.match(notes, /- b/);
  assert.ok(!notes.includes("5.4.1"));
});
