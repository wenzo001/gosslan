// 更新清单生成器的行为判据：平台配对、webview2 排除、版本/tag 一致、签名非空。
// 跑法：node --test scripts/updaterManifest.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, mapPlatformAssets, notesForVersion, REQUIRED_PLATFORMS } from "./updater-manifest.mjs";
import { changelogProblems } from "./semver.mjs";

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

test("0 字节安装包必须被拦下（minAssetBytes 不是装饰参数）", () => {
  const { dir, names } = fixture();
  // 现状（默认 0）：纯函数不查字节 ⇒ 单测不用落真实大文件。
  assert.doesNotThrow(() =>
    buildManifest({ dir, files: names, tag: "v5.5.0", repo: "a/b", version: "5.5.0" }),
  );
  // CLI 的真实口径：安装包必须 ≥1024 字节。
  assert.throws(
    () =>
      buildManifest({
        dir,
        files: names,
        tag: "v5.5.0",
        repo: "a/b",
        version: "5.5.0",
        minAssetBytes: 1024,
      }),
    /只有 5 字节（要求 ≥ 1024）/,
  );
  // 反向：把产物写到阈值以上就必须放行（证明它拦的是字节数而不是文件名）。
  for (const n of names) {
    if (!n.endsWith(".sig")) fs.writeFileSync(path.join(dir, n), "x".repeat(2048));
  }
  assert.doesNotThrow(() =>
    buildManifest({ dir, files: names, tag: "v5.5.0", repo: "a/b", version: "5.5.0", minAssetBytes: 1024 }),
  );
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

/**
 * 相邻两行是同一个版本号 ⇒ 那一节的「应用内更新说明」读出来是**空串**（上面那条判据的边界）。
 *
 * 2026-10-29 现算：5.15.5～5.15.13 九节就是这么重复的，`notesForVersion` 对它们**全部返回空**
 * （`## [5.15.13]` 紧跟着第二行 ⇒ 切到下一个 `^## [` 为止的那段是零个字符）。
 * 两个已发过 tag 的那两版当时的清单是非空的（v5.15.7 / v5.15.13 的 `latest.json` 现读
 * 664 / 1484 字），所以**没有用户可见损害** —— 重复是后来编辑带进来的。
 * 但这条形状必须被结构判据拦住：格式判据看不出（两行都合规）、降序判据也看不出（相等不算逆序）、
 * 归属判据只看当前那一版 ⇒ 一旦给老版本重生成清单就会静默发一个无说明的版本。
 */
test("相邻重复的版本标题：量具先证明它会变空，判据必须报出来（正控用真文件）", () => {
  const dup =
    "## [5.15.13] - 2026-10-29\n## [5.15.13] - 2026-10-29\n\n### 某批\n\n- a\n\n## [5.15.12] - 2026-10-29\n\n- b\n";
  assert.equal(
    notesForVersion(dup, "5.15.13"),
    "",
    "第一格：重复标题那一节必须被读成空串（否则下面那条判据是在防一个不存在的危害）",
  );

  // 真实 CHANGELOG：不许有相邻重复的版本标题。
  const root = path.join(import.meta.dirname, "..");
  const real = path.join(root, "CHANGELOG.md");
  assert.deepEqual(changelogProblems(real), [], "CHANGELOG 的结构判据报红了");

  // 正控：把真文件第一个版本标题复制一行，判据必须点名那一个版本号（不是恒绿的清单）。
  const text = fs.readFileSync(real, "utf8");
  const m = text.match(/^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m);
  assert.ok(m, "CHANGELOG 里没找到一个版本标题 ⇒ 变异没落进去");
  const mutated = text.replace(m[0], `${m[0]}\n${m[0]}`);
  assert.notEqual(mutated, text, "变异没改到内容，这条正控不作数");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gosslan-changelog-")), "CHANGELOG.md");
  fs.writeFileSync(tmp, mutated);
  const found = changelogProblems(tmp).filter((p) => p.includes(m[1]));
  assert.equal(found.length, 1, `重复标题必须被点名恰好一次，实际：${JSON.stringify(found)}`);
  assert.match(found[0], /更新说明/);
});
