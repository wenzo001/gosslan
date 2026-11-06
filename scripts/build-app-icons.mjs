// 生成全部平台图标。单一入口：`npm run icon`。
//
// 为什么不是一条 `tauri icon <一张 512 png>`：
// 1. 原来的 `tauri icon src-tauri/icons/icon.png` 从 512 上采样到 1024，macOS 的
//    128@2x / 512@2x 全是插值出来的糊图；现在直接喂 1024 的 SVG。
// 2. `.icns` 需要**在源图里画出 22.37% 圆角**（macOS 不再二次裁切）；满版方图会被
//    Dock 里显示成方块，或和系统遮罩叠成两层圆角。这里主生成用满版 `app-icon-light.svg`，
//    再单独跑一遍 `app-icon-macos.svg` 只取 `icon.icns`。
// 3. Android 自适应图标需要前景/背景/单色三层；manifest 一次生成，
//    `mipmap-anydpi-v26/ic_launcher.xml` 里的 `<monochrome>` 才会真的接上 themed icon。
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(root, "designs/gosslan-redesign/brand");
const outDir = join(root, "src-tauri/icons");
const tauriBin = join(root, "node_modules/.bin/tauri");

/** tauri icon 的 manifest 里的相对路径解析位置不稳定，落到临时目录时统一改绝对路径。 */
function absoluteManifest() {
  const src = JSON.parse(readFileSync(join(brand, "icon-manifest.json"), "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "gosslan-icons-"));
  const manifest = { ...src };
  for (const key of ["default", "android_bg", "android_fg", "android_monochrome"]) {
    if (typeof manifest[key] === "string") manifest[key] = resolve(brand, manifest[key]);
  }
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { path, dir };
}

function runIcon(input, output) {
  execFileSync(tauriBin, ["icon", input, "-o", output], { cwd: root, stdio: "inherit" });
}

const { path: manifestPath, dir: manifestDir } = absoluteManifest();
// ⚠️ 必须先写临时目录再整体覆盖：`tauri icon` 在目标已有 `android/` 时会静默跳过
// Android 产物（本次实测：只有 PNG/icns 更新，mipmap 仍是 19:06 的旧图标），
// 于是 Android 一直停留在上一版蓝色气泡图。
const staging = mkdtempSync(join(tmpdir(), "gosslan-icons-out-"));
try {
  runIcon(manifestPath, staging);
  cpSync(staging, outDir, { recursive: true, force: true });
} finally {
  rmSync(manifestDir, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
}

// macOS：只换 .icns，其它平台继续用满版方图（Windows/iOS 由系统自己加圆角）。
const macDir = mkdtempSync(join(tmpdir(), "gosslan-mac-icon-"));
try {
  runIcon(join(brand, "app-icon-macos.svg"), macDir);
  cpSync(join(macDir, "icon.icns"), join(outDir, "icon.icns"));
} finally {
  rmSync(macDir, { recursive: true, force: true });
}

console.log("[icons] done →", outDir);
