#!/usr/bin/env node
// 为 Tauri 生成的 Android 工程注入 release 签名配置。
//
// 签名策略（**必须稳定**：同一台手机上换签名 = 装不上，只能卸载重装、丢数据）：
// - 若 CI/本地环境提供 ANDROID_KEYSTORE_BASE64，则解码为
//   src-tauri/gen/android/app/release.keystore 并用它签名（CI 的唯一入口）。
// - 否则使用**仓库内固定路径的本地 keystore**（`scripts/android/keystore/gosslan-release.keystore`）：
//   首次运行自动生成一次，之后**所有构建共用同一把钥匙**，与 HOME / ANDROID_USER_HOME 无关。
//
// ⚠️ 真实事故（用户 2026-09-13）：以前这里在缺少 ANDROID_KEYSTORE_BASE64 时会**回退到
//    Android debug 签名**，而 debug keystore 的位置随 `$HOME`/`$ANDROID_USER_HOME` 变化
//    ⇒ 不同机器/不同会话打出来的包**签名不同**，手机上报
//    `INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match`。
//    所以现在：本地也必须用固定 keystore，**绝不回退 debug**（`--allow-debug-signing`
//    显式传参才允许，且会打印醒目警告）。
//
// 幂等：重复执行会先移除上一次注入的标记块，再按当前环境重新注入。
// 使用方式：在 `tauri android build --apk` 之前执行（package.json 的 android:build 已集成）。

import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
const allowDebugSigning = process.argv.includes("--allow-debug-signing");
// 仓库内**固定路径**的本地 keystore：路径与凭据都写死在这里 ⇒ 与 HOME/ANDROID_USER_HOME
// 无关，任何会话/任何机器上打的包签名一致（这正是"配死"的目的）。
const LOCAL_KEYSTORE_REL = "scripts/android/keystore/gosslan-release.keystore";
// 开发版 keystore：**入库、公开**（它是开发钥匙，不是发行钥匙）。
// 为什么要有它（2026-10-21 用户要求 + CI 真实事故）：
//   发行版钥匙存在 GitHub Actions Secrets（别人看不到、含 fork 的 PR 也读不到），
//   而 CI 的 main 推送构建**未必**配了 secret ⇒ 没有它就会走到"现生成一把"那条路，
//   于是**每次 CI 跑出来的 APK 签名都不一样** ⇒ 用户覆盖安装必失败
//   （INSTALL_FAILED_UPDATE_INCOMPATIBLE），而且已发出去的包再也升不上。
//   有了固定的开发版钥匙 ⇒ 至少签名稳定、行为可预期；正式对外发版仍必须用发行版 secret。
const DEV_KEYSTORE_REL = "scripts/android/keystore/gosslan-dev.keystore";
const LOCAL_KEY_ALIAS = "gosslan";
const LOCAL_STORE_PASSWORD = "gosslan-local";
const LOCAL_KEY_PASSWORD = "gosslan-local";
// 开发版钥匙的凭据**故意公开**（它就是公开钥匙，藏起来没有意义）。
const DEV_STORE_PASSWORD = "gosslan-dev";
const DEV_KEY_PASSWORD = "gosslan-dev";
// 正式发版（tag 触发的发布 job）必须用**私有发行版钥匙**：
// 拿公开的开发钥匙出正式包 ⇒ 任何人都能伪造一个"升级包"顶替你的应用。
const requireReleaseSigning = process.argv.includes("--require-release-signing");

/** 本地固定 keystore：不存在就用 keytool 生成一次（之后永远复用）。 */
function ensureLocalKeystore() {
  const abs = path.join(root, LOCAL_KEYSTORE_REL);
  if (fs.existsSync(abs)) return abs;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const keytool = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", "keytool")
    : "keytool";
  execFileSync(
    keytool,
    [
      "-genkeypair",
      "-keystore", abs,
      "-alias", LOCAL_KEY_ALIAS,
      "-keyalg", "RSA",
      "-keysize", "2048",
      "-validity", "10950",
      "-storepass", LOCAL_STORE_PASSWORD,
      "-keypass", LOCAL_KEY_PASSWORD,
      "-dname", "CN=Gosslan, O=Gosslan, C=CN",
    ],
    { stdio: "inherit" },
  );
  console.log(`[android-signing] 已生成固定本地 keystore：${LOCAL_KEYSTORE_REL}（之后一直复用）`);
  return abs;
}

// ⚠️ 这里必须把「**空串**」和「未设置」一视同仁（2026-10-21 实测踩到）：
//   GitHub Actions 把**未配置**的 secret 传成空字符串 ""（不是 undefined），
//   而 `??` 只对 undefined/null 回退 ⇒ `ANDROID_KEY_PASSWORD` 留空时
//   keyPassword 会变成 ""（而不是回退到 storePassword）⇒ Gradle 在**签名阶段**
//   才报 "keystore password was incorrect"（store 密码是对的、keystore 也能打开，
//   所以这个错极难定位）。
//   所以统一走 `envOr`：空串/纯空白一律当"没配"。
const envOr = (value, fallback) => {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : fallback;
};
const storePassword = envOr(process.env.ANDROID_KEYSTORE_PASSWORD, "");
const keyAlias = envOr(process.env.ANDROID_KEY_ALIAS, "");
// KEY_PASSWORD 不填就沿用 store password（绝大多数 keystore 两者相同），
// 但**显式填**时以填的为准（允许 store/key 密码不同的 keystore）。
const keyPassword = envOr(process.env.ANDROID_KEY_PASSWORD, storePassword);

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
  // 密码/alias 缺失必须**在这里**说清楚：等到 Gradle 报
  // "keystore password was incorrect"，没人想得到是 secret 没配全。
  const missing = [];
  if (!storePassword) missing.push("ANDROID_KEYSTORE_PASSWORD");
  if (!keyAlias) missing.push("ANDROID_KEY_ALIAS");
  if (missing.length > 0) {
    console.error(
      `[android-signing] 已有 ANDROID_KEYSTORE_BASE64，但缺少 ${missing.join(" / ")}` +
        " ⇒ 无法签名。补齐这两个 Secret（alias 用 keytool -list 查到的那个）。",
    );
    process.exit(1);
  }
  text = injectReleaseSigning(text, storePassword, keyAlias, keyPassword);
  console.log(
    `[android-signing] 已注入 release 签名配置（alias=${keyAlias}，${
      keyPassword === storePassword ? "key 密码同 store 密码" : "key 密码独立"
    }）。`,
  );
} else if (allowDebugSigning) {
  text = injectDebugFallback(text);
  console.warn(
    "⚠️ [android-signing] 显式允许 debug 签名：该包与固定 keystore 打的包**签名不同**，" +
      "覆盖安装会失败（INSTALL_FAILED_UPDATE_INCOMPATIBLE）。仅用于一次性内测。",
  );
} else {
  // ---- 没有发行版 secret ----
  // ⚠️ 正式发版（--require-release-signing）时**必须在这里就停**：
  //   不能因为"仓库里有公开的开发版钥匙"就拿它出正式包 ——
  //   公开钥匙签的包任何人都能伪造同签名的"升级包"顶替你的应用（Android 只认签名）。
  if (requireReleaseSigning) {
    console.error(
      "[android-signing] 正式发版必须用**私有发行版钥匙**：" +
        "请在 GitHub Actions Secrets 里配置 ANDROID_KEYSTORE_BASE64 / ANDROID_KEYSTORE_PASSWORD / " +
        "ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD（别人看不到，含 fork 的 PR 也读不到）。" +
        "本次已拒绝出包（不拿公开的开发版钥匙发正式版）。",
    );
    process.exit(1);
  }
  // 按"开发版（公开·入库）→ 本机副本 → 现生成"三档退
  const devAbs = path.join(root, DEV_KEYSTORE_REL);
  const localAbs = path.join(root, LOCAL_KEYSTORE_REL);
  let abs;
  let storePw;
  let keyPw;
  let which;
  if (fs.existsSync(devAbs)) {
    abs = devAbs;
    storePw = DEV_STORE_PASSWORD;
    keyPw = DEV_KEY_PASSWORD;
    which = `**开发版**签名（公开·入库：${DEV_KEYSTORE_REL}）`;
  } else if (fs.existsSync(localAbs)) {
    abs = localAbs;
    storePw = LOCAL_STORE_PASSWORD;
    keyPw = LOCAL_KEY_PASSWORD;
    which = `本机发行版副本（${LOCAL_KEYSTORE_REL}）`;
  } else {
    abs = ensureLocalKeystore();
    storePw = LOCAL_STORE_PASSWORD;
    keyPw = LOCAL_KEY_PASSWORD;
    which = `⚠️ **现生成**的一把临时钥匙（${LOCAL_KEYSTORE_REL}）`;
  }
  // 注入到 gen 工程（gradle 里 storeFile 是相对 app 目录的路径）
  // 文件名必须与 `injectReleaseSigning` 里写的 `file("release.keystore")` 一致
  // （踩过一次：复制成 gosslan-release.keystore ⇒ Gradle 报 "Keystore file ... not found"）。
  const gradleKeystore = path.join(root, "src-tauri", "gen", "android", "app", "release.keystore");
  fs.copyFileSync(abs, gradleKeystore);
  text = injectReleaseSigning(text, storePw, LOCAL_KEY_ALIAS, keyPw);
  console.log(`[android-signing] 已注入${which}。`);
  if (which.startsWith("⚠️")) {
    console.warn(
      "[android-signing] ⚠️ 这把钥匙是**现生成**的 ⇒ 下次构建签名就变了，" +
        "覆盖安装会失败（INSTALL_FAILED_UPDATE_INCOMPATIBLE）。" +
        "正式发版请配置发行版 secret；日常构建请用入库的开发版钥匙。",
    );
  }
}

// ---- btleplug 的 Android Java 部分必须编译进 App ----
//
// 为什么（用户 2026-09-12 安卓真机 logcat 抓到的 panic）：
//   `Droidplug has not been initialized. Please initialize it with btleplug::platform::init().`
// btleplug 在 Android 上是"Rust + Java 混合"实现：Java 侧（`com.nonpolynomial.**` 与
// `io.github.gedgygedgy.**`，共 28 个 .java）**只被 native 代码按类名调用**，
// 而 Tauri 的 Gradle 工程里**根本没有这个模块** ⇒ `find_class` 失败 ⇒ 初始化失败 ⇒
// 随后 `Manager::new()` 在 crate 内 panic ⇒ 安卓 release（panic=abort）**进程直接消失**。
//
// 修法：把 Java 源码目录挂到 App 的 sourceSets 上（比引 Gradle 子模块简单，
// 且不受 AGP 版本差异影响），再配合 proguard keep 规则（见 proguard-gosslan.pro）。
//
// ## ⚠️ 两个源码目录，缺一不可（2026-09-12 第二次真机 logcat 抓到的）
//   `btleplug droidplug 初始化失败：failed to resolve Java class
//    'io/github/gedgygedgy/rust/future/Future' (class not found or linkage error)`
// 原因：**发布到 crates.io 的 btleplug-0.13.0 里根本没有 `io/github/gedgygedgy/**`**
//（`tar tzf btleplug-0.13.0.crate | grep gedgy` = 0，crate 只带 14 个 `com/nonpolynomial/**`）。
// 它此前偶尔能工作，只是因为有人**手工往 CARGO_HOME 的提取目录里塞过那 18 个 .java** ——
// 而 CARGO_HOME 的提取目录是**易失**的（换一个 CARGO_HOME、或 cargo 重新解包，手工文件就没了），
// 于是"有时编得进去、有时编不进去"，而且因为有 `-dontwarn io.github.gedgygedgy.**`，
// **构建期一个字都不报**，只在真机 logcat 里现形。
//
// 所以现在：那 18 个 .java **随仓库入库**（`scripts/android/btleplug-java/`），
// 与 crate 自带的 `com/nonpolynomial/**` 一起挂到 sourceSets；任一个缺失都**直接报错**
//（不再静默产出坏包），并且 `build-android-releases.sh` 会在打完包后**反查 dex** 确认两个包都在。
function injectBtleplugJava(source) {
  const marker = /[ \t]*\/\/ GOSSLAN_BTLEPLUG_JAVA_BEGIN[\s\S]*?\/\/ GOSSLAN_BTLEPLUG_JAVA_END[ \t]*\n?/;
  const cleaned = source.replace(marker, "");
  // **只用仓库自带的那一份**（scripts/android/btleplug-java/，见其 README）：
  // · crates.io 的 btleplug 包里缺少 io/github/gedgygedgy/**（18 个 .java）；
  // · CARGO_HOME 的提取目录是易失的（换目录 / cargo 重新解包就没了）；
  // · 两个来源同时挂上去还会**类重复**（实测：`错误: 类重复 io.github.gedgygedgy...`）。
  // 所以：一个来源、入库、可复现。
  const vendored = path.join(root, "scripts", "android", "btleplug-java");
  const mustHave = [
    "com/nonpolynomial/btleplug/android/impl/Adapter.java",
    "io/github/gedgygedgy/rust/future/Future.java",
  ];
  const missing = mustHave.filter((rel) => !fs.existsSync(path.join(vendored, rel)));
  if (missing.length) {
    throw new Error(
      `[android-btleplug] 仓库自带的 btleplug Java 源码不完整（缺 ${missing.join("、")}）—— ` +
        "见 scripts/android/btleplug-java/README.md；缺了真机上会 " +
        "`failed to resolve Java class 'io/github/gedgygedgy/rust/future/Future'`（蓝牙不可用）",
    );
  }
  // 写进 Gradle 文件的必须是**相对 App 模块目录**的路径，不能是绝对路径。
  // 原因：`build.gradle.kts` 是入库文件，而 Gradle 对**不存在的 srcDir 一个字都不报**
  // ——绝对路径在别人机器/CI 上解析到空目录，Java 两半不进 dex，构建期全绿，
  // 只在真机 logcat 里现形（就是上面那条 panic）。相对写法与同文件里
  // `file("release.keystore")`、`file("tauri.properties")` 是同一套解析口径。
  const appDir = path.dirname(gradlePath);
  const vendoredRel = path
    .relative(appDir, vendored)
    .split(path.sep)
    .join("/");
  if (path.resolve(appDir, vendoredRel) !== path.normalize(vendored)) {
    throw new Error(
      `[android-btleplug] 相对路径折回来不是那个目录（file("${vendoredRel}") → ` +
        `${path.resolve(appDir, vendoredRel)}，应为 ${vendored}）—— 拒绝写入。`,
    );
  }
  const block =
    "    // GOSSLAN_BTLEPLUG_JAVA_BEGIN\n" +
    "    // btleplug 的 Android Java 实现（只被 native 代码按类名调用，必须编译进 App）\n" +
    "    // 两个包都在仓库里：com/nonpolynomial/** 与 io/github/gedgygedgy/**\n" +
    "    //（crates.io 的 btleplug 包里没有后者，见 scripts/android/btleplug-java/README.md）\n" +
    "    // 相对 App 模块目录解析（入库文件不许带本机绝对路径）\n" +
    `    sourceSets["main"].java.srcDirs(file(${kotlinString(vendoredRel)}))\n` +
    "    // GOSSLAN_BTLEPLUG_JAVA_END\n";
  console.log(
    `[android-btleplug] 已注入仓库自带的 Java 源码目录（两个包共 28 个 .java）：` +
      `file("${vendoredRel}") → ${vendored}`,
  );
  return cleaned.replace("android {\n", `android {\n${block}`);
}

text = injectBtleplugJava(text);
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

// Android 13+ 运行时权限：在 MainActivity 里主动申请「附近设备 / 蓝牙 / 通知」。
//
// ⚠️ 时机：**首次布局之后**（`decorView.post {}`），不能在 `onCreate` 里立刻弹。
// 真实事故（用户 2026-09-21，安卓首次启动）：「请求权限会把首页样式搞崩」—— 权限弹框盖在
// WebView 的**首次布局**上时，前端 `matchMedia("(max-width: 767px)")` 读到的是**兜底视口宽度**
// （980px 那档）⇒ `isMobile = false` ⇒ 手机上渲染出**桌面三栏布局**，而且"变窄"那次过渡早于
// 监听注册 ⇒ 一直错下去。`decorView.post` 保证排在第一次 layout 之后；前端侧另有平台优先的
// 兜底（`src/utils/platform.ts::resolveMobileLayout`），两处互补、各自都能独立防住这类回归。
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
    "super.onCreate(savedInstanceState)\n" +
      "    // 权限弹框等**首帧画完**再弹：\n" +
      "    // 连续 post 两次 = 第一次 traversal（measure/layout/draw）结束之后才跑\n" +
      "    //（单次 post 会在 attach 阶段就执行，那时 WebView 还没被量过一次）。\n" +
      "    // 弹框若盖在首次布局上，前端读到的视口宽度会是兜底值 ⇒ 手机上判成桌面布局。\n" +
      "    window.decorView.post { window.decorView.post { requestRuntimePermissions() } }",
  );
  const method = `
  /**
   * Android 13+ 运行时权限（附近设备 / 蓝牙 / 通知）。
   *
   * ⚠️ 调用点必须是 \`window.decorView.post {}\`（首次布局之后）：权限弹框如果盖在 WebView
   * 的**首次布局**上，前端 \`matchMedia\` 会读到兜底视口宽度（980px 档）⇒ 手机上判成"桌面"
   * ⇒ 首页渲染成三栏布局（用户 2026-09-21 实测）。前端另有平台优先兜底，两处互补。
   */
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
  console.log("[android-permissions] 已注入运行时权限申请（附近设备 / 蓝牙 / 通知，首帧后弹）。");
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

// R8 keep 规则：release 会开混淆（`isMinifyEnabled = true`），而 Rust 是按**名字 + 签名**
// 调 Kotlin 方法的（`kotlin_method!`）。**实测**未 keep 时这些方法会变成 a/b/c/d/e，
// 于是 release 真机包的蓝牙外设路径直接 NoSuchMethodError —— debug 包不混淆，所以这个坑
// 只有打了 release 包才会现形。
//
// 规则正文放在 `scripts/android/proguard-gosslan.pro`（版本库里的**单一事实来源**，
// 因为 `gen/android` 整个是 `tauri android init` 生成物、随时会被重生）：
// 这里只是把它整体搬进 `app/proguard-rules.pro`（AGP 会把该目录下所有 `*.pro` 都应用上）。
const proguardFragmentPath = path.join(
  root,
  "scripts",
  "android",
  "proguard-gosslan.pro",
);
const JNI_KEEP_BEGIN = "# GOSSLAN_JNI_BEGIN";
const JNI_KEEP_END = "# GOSSLAN_JNI_END";
const JNI_KEEP_BLOCK = fs.existsSync(proguardFragmentPath)
  ? fs.readFileSync(proguardFragmentPath, "utf8").trim()
  : "";

function injectProguardKeep(proguardPath) {
  if (!fs.existsSync(proguardPath)) return;
  if (!JNI_KEEP_BLOCK) {
    console.error(
      "[android-proguard] 没找到 scripts/android/proguard-gosslan.pro —— release 包的 JNI " +
        "keep 规则会缺失（蓝牙会在真机上 NoSuchMethodError），中止。",
    );
    process.exit(1);
  }
  let rules = fs.readFileSync(proguardPath, "utf8");
  const blockRe = new RegExp(`${JNI_KEEP_BEGIN}[\\s\\S]*?${JNI_KEEP_END}\\n?`);
  rules = rules.replace(blockRe, "").replace(/\n+$/, "\n");
  fs.writeFileSync(proguardPath, `${rules}\n${JNI_KEEP_BLOCK}\n`);
  console.log(
    "[android-proguard] 已注入 JNI keep 规则（release 混淆不会改掉 Rust 按名字调用的方法）。",
  );
}

injectProguardKeep(
  path.join(
    root,
    "src-tauri",
    "gen",
    "android",
    "app",
    "proguard-rules.pro",
  ),
);
