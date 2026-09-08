#!/usr/bin/env node
// 为 Tauri 生成的 Android 工程注入 release 签名配置。
//
// 签名策略：
// - 若 CI/本地环境提供 ANDROID_KEYSTORE_BASE64（keystore 文件的 base64），
//   则解码为 src-tauri/gen/android/app/release.keystore，并使用 release 签名。
// - 若未提供，则 release 回退到 Android 的 debug 签名，保证内测 APK 可以直接安装。
//
// 幂等：重复执行会先移除上一次注入的标记块，再按当前环境重新注入。
// 使用方式：在 `tauri android build --apk` 之前执行（package.json 的 android:build 已集成）。

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const gradlePath = path.join(
  root,
  "src-tauri",
  "gen",
  "android",
  "app",
  "build.gradle.kts",
);

if (!fs.existsSync(gradlePath)) {
  console.error(
    "[android-signing] 未找到 Android 工程，请先运行 `npm run android:init`。",
  );
  process.exit(1);
}

let text = fs.readFileSync(gradlePath, "utf8");

function kotlinString(value) {
  return (
    '"' +
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$") +
    '"'
  );
}

function stripPreviousInjection(source) {
  let out = source;
  out = out.replace(
    /[ \t]*\/\/ GOSSLAN_SIGNING_BEGIN[\s\S]*?\/\/ GOSSLAN_SIGNING_END[ \t]*\n?/,
    "",
  );
  out = out.replace(
    /[ \t]*signingConfig = signingConfigs\.getByName\("(?:release|debug)"\)[ \t]*\n?/,
    "",
  );
  return out;
}

function injectDebugFallback(source) {
  // AGP 会自动创建 debug signingConfig，release 直接复用它即可安装。
  return source.replace(
    /getByName\("release"\) \{\n/,
    (match) =>
      match +
      '            signingConfig = signingConfigs.getByName("debug")\n',
  );
}

function injectReleaseSigning(source, storePassword, keyAlias, keyPassword) {
  const block =
    "    // GOSSLAN_SIGNING_BEGIN\n" +
    "    signingConfigs {\n" +
    '        create("release") {\n' +
    '            storeFile = file("release.keystore")\n' +
    `            storePassword = ${kotlinString(storePassword)}\n` +
    `            keyAlias = ${kotlinString(keyAlias)}\n` +
    `            keyPassword = ${kotlinString(keyPassword)}\n` +
    "        }\n" +
    "    }\n" +
    "    // GOSSLAN_SIGNING_END\n";
  let out = source.replace("android {\n", `android {\n${block}`);
  out = out.replace(
    /getByName\("release"\) \{\n/,
    (match) =>
      match +
      '            signingConfig = signingConfigs.getByName("release")\n',
  );
  return out;
}

// Android 强制竖屏：内测阶段移动端只做竖屏布局，横屏会破坏安全区/导航布局。
function injectPortraitManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return;
  let manifest = fs.readFileSync(manifestPath, "utf8");
  if (manifest.includes('android:screenOrientation="portrait"')) return;
  manifest = manifest.replace(
    /(<activity\b)/,
    '$1\n            android:screenOrientation="portrait"',
  );
  fs.writeFileSync(manifestPath, manifest);
  console.log("[android-manifest] 已注入 android:screenOrientation=\"portrait\"。");
}

const base64Keystore = process.env.ANDROID_KEYSTORE_BASE64?.trim();
const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD ?? "";
const keyAlias = process.env.ANDROID_KEY_ALIAS ?? "";
const keyPassword = process.env.ANDROID_KEY_PASSWORD ?? storePassword;

text = stripPreviousInjection(text);

if (base64Keystore) {
  const keystorePath = path.join(
    root,
    "src-tauri",
    "gen",
    "android",
    "app",
    "release.keystore",
  );
  const decoded = Buffer.from(base64Keystore, "base64");
  if (decoded.length === 0) {
    console.error(
      "[android-signing] ANDROID_KEYSTORE_BASE64 解码为空，请检查 CI 变量。",
    );
    process.exit(1);
  }
  fs.writeFileSync(keystorePath, decoded);
  text = injectReleaseSigning(text, storePassword, keyAlias, keyPassword);
  console.log("[android-signing] 已注入 release 签名配置。");
} else {
  text = injectDebugFallback(text);
  console.log(
    "[android-signing] 未检测到 release keystore，release 将使用 debug 签名（内测可安装）。",
  );
}

fs.writeFileSync(gradlePath, text);

const manifestPath = path.join(
  root,
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);

// 注入权限片段：GitHub 工作流有独立步骤，GitLab/本地 android:build 则在这里统一补齐。
function injectPermissionsManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return;
  let manifest = fs.readFileSync(manifestPath, "utf8");
  if (manifest.includes("NEARBY_WIFI_DEVICES")) return;
  const permsPath = path.join(root, "scripts", "android", "permissions.xml");
  if (!fs.existsSync(permsPath)) return;
  const perms = fs.readFileSync(permsPath, "utf8").trim();
  manifest = manifest.replace("<application", `${perms}\n    <application`);
  fs.writeFileSync(manifestPath, manifest);
  console.log("[android-manifest] 已注入 Gosslan 权限片段。");
}

injectPermissionsManifest(manifestPath);
injectPortraitManifest(manifestPath);

// Android 13+ 运行时权限：在 MainActivity.onCreate 里主动申请「附近设备 / 蓝牙 / 通知」。
function injectMainActivityPermissions(activityPath) {
  if (!fs.existsSync(activityPath)) return;
  let src = fs.readFileSync(activityPath, "utf8");
  if (src.includes("requestRuntimePermissions")) {
    return;
  }
  src = src.replace(
    /import androidx\.activity\.enableEdgeToEdge\n/,
    "import androidx.activity.enableEdgeToEdge\n" +
      "import android.Manifest\n" +
      "import android.content.pm.PackageManager\n" +
      "import android.os.Build\n" +
      "import androidx.core.app.ActivityCompat\n" +
      "import androidx.core.content.ContextCompat\n",
  );
  src = src.replace(
    /super\.onCreate\(savedInstanceState\)/,
    "super.onCreate(savedInstanceState)\n    requestRuntimePermissions()",
  );
  const method = `
  private fun requestRuntimePermissions() {
    val permissions = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= 33) {
      permissions.add(Manifest.permission.NEARBY_WIFI_DEVICES)
      permissions.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    if (Build.VERSION.SDK_INT >= 31) {
      permissions.add(Manifest.permission.BLUETOOTH_SCAN)
      permissions.add(Manifest.permission.BLUETOOTH_CONNECT)
    }
    val missing = permissions.filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1001)
    }
  }
`;
  const lastBrace = src.lastIndexOf("}");
  if (lastBrace === -1) return;
  src = src.slice(0, lastBrace) + method + src.slice(lastBrace);
  fs.writeFileSync(activityPath, src);
  console.log("[android-permissions] 已注入运行时权限申请（附近设备 / 蓝牙 / 通知）。");
}

const activityPath = path.join(
  root,
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "java",
  "com",
  "gosslan",
  "app",
  "MainActivity.kt",
);
injectMainActivityPermissions(activityPath);
