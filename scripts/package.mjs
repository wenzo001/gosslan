#!/usr/bin/env node
// =============================================================================
//  统一打包入口（用户 2026-09-13 要求）。
//
//  ## 用户定的规则（必须照做）
//
//  · **macOS**：同时产出 **Android 包 + macOS 包**，两者**并行**构建（不许串行）。
//  · **Windows**：只产出**当前环境**适配的那一个 Windows 包。
//
//  ## 为什么原来慢（这脚本逐个消掉）
//
//  1. `beforeBuildCommand`（`npm run build` = vue-tsc + vite）被**每个产物各跑一遍**
//     —— mac + 两个 ABI = 3 遍整仓类型检查。现在只跑一遍
//     （`scripts/frontend-build.mjs` 的 `GOSSLAN_SKIP_FRONTEND` 开关）。
//  2. Mac 默认 bundling 目标是 `"all"`（`tauri.conf.json`），会额外做 **DMG**；
//     DMG 走 hdiutil + Finder 排版，动辄几分钟。日常出包只要 `.app` + zip
//     （`scripts/pack-macos-app.sh` 已有的产物形态），`--dmg` 才出 DMG。
//  3. 安卓默认出 **两个 ABI**（arm64-v8a + armeabi-v7a）⇒ 两次完整 release 构建。
//     现代手机都是 arm64，日常只出 arm64-v8a（`--all-abis` 才出两个）。
//  4. mac 与安卓**串行**跑。Cargo 对 target 目录加独占锁
//     （实测：并发时打印 `Blocking waiting for file lock on build directory`），
//     所以共用 target 目录的"并行"其实还是串行。这里给安卓单独一个
//     `CARGO_TARGET_DIR`（`src-tauri/target-android`），两个构建**真正并行**。
//  5. release profile 是 `lto = true` + `codegen-units = 1`（体积最优、编译最慢）。
//     日常出包默认切 `--fast`（thin LTO + 16 CGU，快 2~3 倍）；要发布级产物用
//     `--fat-lto`（= 仓库原配置）。
//
//  ## 用法
//
//    npm run dist                    # 当前平台的一键出包（mac：安卓+mac 并行；win：只出 win）
//    npm run dist -- --dry-run       # 只打印将要执行的命令与环境，不真的构建
//    npm run dist -- --dmg           # mac 额外出 DMG
//    npm run dist -- --all-abis      # 安卓两个 ABI 都出
//    npm run dist -- --fat-lto       # 发布级（仓库默认 LTO 配置，最慢）
//    npm run dist -- --serial        # 退回串行 + 共用 target 目录（复用旧缓存）
//    npm run dist -- --migrate-cache # 一次性：把旧 target/ 里的安卓产物搬进 target-android/
//    npm run dist -- --debug         # 安卓出 debug 包
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
/** 安卓专用的 cargo target 目录：与 mac 分开，才能真并行（见文件头第 4 条）。 */
const ANDROID_TARGET_DIR = join(SRC_TAURI, "target-android");

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes(n);
const optValue = (n, def) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(
    [
      "用法：node scripts/package.mjs [选项]",
      "",
      "  --dry-run         只打印将执行的命令与环境",
      "  --serial          串行构建，共用默认 target 目录（复用旧缓存）",
      "  --abis <list>     安卓 ABI（逗号分隔，默认 arm64-v8a）",
      "  --all-abis        安卓两个 ABI（arm64-v8a,armeabi-v7a）",
      "  --dmg             macOS 额外产出 DMG（默认只出 .app + .zip）",
      "  --fat-lto         发布级 LTO（仓库默认配置，最慢）",
      "  --fast            强制 thin LTO + 16 CGU（默认）",
      "  --debug           安卓 debug 包",
      "  --skip-frontend   跳过前端构建（复用现有 dist/）",
      "  --migrate-cache   把旧 target/ 里的安卓产物搬进 target-android/（一次性）",
      "  --mac-triple <t>  覆盖 macOS 目标三元组",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------- 平台判定

const platform = process.platform; // darwin | win32 | linux
const arch = process.arch; // arm64 | x64

/** 当前环境适配的 macOS 目标三元组。 */
function macTriple() {
  if (hasFlag("--mac-triple")) return optValue("--mac-triple", "aarch64-apple-darwin");
  return arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
}

/** 当前环境适配的 Windows 目标三元组。 */
function winTriple() {
  return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

/** 安卓 ABI 列表（Gradle 名，用于产物文件名 / --abi 参数）。 */
function androidAbis() {
  if (hasFlag("--all-abis")) return ["arm64-v8a", "armeabi-v7a"];
  const raw = optValue("--abis", "arm64-v8a");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- 选项

const dryRun = hasFlag("--dry-run");
const serial = hasFlag("--serial");
const skipFrontend = hasFlag("--skip-frontend");
const debugAndroid = hasFlag("--debug");
const withDmg = hasFlag("--dmg");
// 默认 fast：日常出包优先"快"；发布级产物用 --fat-lto（= 仓库原配置）。
const fast = hasFlag("--fat-lto") ? false : true;

const profileEnv = fast
  ? {
      CARGO_PROFILE_RELEASE_LTO: "thin",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    }
  : {};

// ---------------------------------------------------------------- 输出小工具

const COLORS = { mac: "\u001b[36m", android: "\u001b[35m", win: "\u001b[32m", plan: "\u001b[33m", reset: "\u001b[0m" };
function prefix(name, line) {
  const c = COLORS[name] ?? "";
  return `${c}[${name}]${COLORS.reset} ${line}`;
}
function log(name, line) {
  for (const l of String(line).split("\n")) {
    if (l.length) console.log(prefix(name, l));
  }
}
function pipe(stream, name) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) if (l.length) console.log(prefix(name, l));
  });
  stream.on("end", () => {
    if (buf.length) console.log(prefix(name, buf));
  });
}

// ---------------------------------------------------------------- 构建计划

/** 一个任务 = 一串顺序执行的命令；多个任务之间并行。 */
function buildPlan() {
  if (platform === "darwin") {
    const triple = macTriple();
    const macSteps = [
      {
        label: `macOS 构建（${triple}，bundles=${withDmg ? "app,dmg" : "app"}）`,
        cmd:
          `npx tauri build --features bluetooth --target ${triple} ` +
          `--bundles ${withDmg ? "app,dmg" : "app"}`,
      },
      {
        label: "打包 .app → release-artifacts/macos/",
        cmd: `bash scripts/pack-macos-app.sh ${triple}`,
      },
    ];
    const abiSteps = androidAbis().map((abi) => ({
      label: `Android APK（${abi}${debugAndroid ? " · debug" : " · release"}）`,
      cmd:
        `bash scripts/build-android-releases.sh ${debugAndroid ? "--debug " : ""}` +
        `--abi ${abi}`,
      env: androidEnv(),
    }));
    const tasks = [
      { name: "mac", steps: macSteps, env: { ...profileEnv } },
      { name: "android", steps: abiSteps, env: { ...profileEnv } },
    ];
    return { tasks, mode: serial ? "serial" : "parallel" };
  }

  if (platform === "win32") {
    const triple = winTriple();
    return {
      mode: "single",
      tasks: [
        {
          name: "win",
          env: { ...profileEnv },
          steps: [
            {
              label: `Windows 构建（${triple}，bundles=nsis）`,
              // ⚠️ `--features bluetooth` **不能少**（2026-09-13 合并评审发现）：
              // BLE 在 Cargo 里是可选 feature（ADR-0015 §2），不开时依赖不下载、代码不编译 ⇒
              // 打出来的 Windows 包**没有蓝牙**，而构建照样"成功"。
              // 这里曾经漏了它（`dist:win` 那几条 npm 脚本补过，但**一键入口 `npm run dist`
              // 才是用户日常用的那条**，它漏了就等于 Windows 日常包都没有蓝牙）。
              cmd: `npx tauri build --features bluetooth --bundles nsis --target ${triple}`,
            },
          ],
        },
      ],
    };
  }

  return { mode: "unsupported", tasks: [] };
}

/** 安卓子进程的环境：独立 target 目录（真并行的前提）+ 跳过前端重建。 */
function androidEnv() {
  return serial ? {} : { CARGO_TARGET_DIR: ANDROID_TARGET_DIR };
}

// ---------------------------------------------------------------- 缓存迁移

/** 一次性把旧 `target/` 里的安卓产物搬到 `target-android/`（同盘 rename，秒级）。 */
function migrateCache() {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return;
  const triples = [
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
    "i686-linux-android",
  ];
  mkdirSync(ANDROID_TARGET_DIR, { recursive: true });
  for (const t of triples) {
    const from = join(SRC_TAURI, "target", t);
    const to = join(ANDROID_TARGET_DIR, t);
    if (existsSync(from) && !existsSync(to)) {
      try {
        renameSync(from, to);
        log("plan", `↪ 迁移缓存 ${t} → target-android/`);
      } catch (e) {
        log("plan", `⚠️  迁移 ${t} 失败（忽略，改为重新编译）：${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 任务执行

/**
 * 跑一步命令。
 *
 * `opts.skipFrontend`（默认 true）决定要不要给子进程设 `GOSSLAN_SKIP_FRONTEND=1`
 * —— 该开关让 tauri 的 `beforeBuildCommand` 立刻返回（前端只构一次）。
 * 前端构建那一步必须传 `false`：否则它会把自己跳过、悄悄用旧 dist/。
 */
function runStep(taskName, step, baseEnv, opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, ...baseEnv, ...(step.env ?? {}) };
    if (opts.skipFrontend === false) delete env.GOSSLAN_SKIP_FRONTEND;
    else env.GOSSLAN_SKIP_FRONTEND = "1";
    // 整条命令行交给 shell（Windows 上 npx 是 npx.cmd）；不要用 args 数组 + shell:true，
    // 那会触发 Node 的 DEP0190 弃用警告。我们的命令里没有需要转义的参数。
    const child = spawn(step.cmd, { cwd: ROOT, env, shell: true });
    pipe(child.stdout, taskName);
    pipe(child.stderr, taskName);
    child.on("error", (e) => resolve({ ok: false, error: String(e), ms: Date.now() - t0 }));
    child.on("close", (code) => resolve({ ok: code === 0, code, ms: Date.now() - t0 }));
  });
}

async function runTask(task) {
  const t0 = Date.now();
  for (const step of task.steps) {
    log(task.name, `▶ ${step.label}`);
    if (dryRun) {
      const env = { ...task.env, ...(step.env ?? {}), GOSSLAN_SKIP_FRONTEND: "1" };
      const envStr = Object.entries(env)
        .filter(([k]) => k.startsWith("CARGO_") || k.startsWith("GOSSLAN_"))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      log(task.name, `   ${envStr} ${step.cmd}`);
      continue;
    }
    const r = await runStep(task.name, step, task.env);
    const secs = ((r.ms ?? 0) / 1000).toFixed(1);
    if (!r.ok) {
      log(task.name, `❌ ${step.label} 失败（${r.code ?? r.error}，用时 ${secs}s）`);
      return { name: task.name, ok: false, ms: Date.now() - t0 };
    }
    log(task.name, `✅ ${step.label}（${secs}s）`);
  }
  return { name: task.name, ok: true, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const { tasks, mode } = buildPlan();

  if (mode === "unsupported") {
    console.error(
      `\n❌ 不支持的平台：${platform}/${arch}\n` +
        `   本脚本只负责 macOS（安卓+mac 并行）与 Windows（只出当前环境的包）。\n` +
        `   Linux 上请直接用各平台原有命令，或走 GitHub Actions。\n`,
    );
    process.exit(2);
  }

  if (hasFlag("--migrate-cache")) {
    if (dryRun) log("plan", "（dry-run）将迁移旧 target/ 里的安卓产物到 target-android/");
    else migrateCache();
  }

  const t0 = Date.now();
  console.log("");
  log(
    "plan",
    `平台 ${platform}/${arch} · 模式 ${mode} · LTO ${fast ? "thin（fast）" : "fat（发布级）"}` +
      (platform === "darwin" ? ` · 安卓 ABI ${androidAbis().join(",")}` : "") +
      (platform === "darwin" && !withDmg ? " · 不出 DMG" : ""),
  );
  for (const t of tasks) log("plan", `任务 [${t.name}]：${t.steps.length} 步`);
  console.log("");

  // 安卓独立缓存目录首次使用 ⇒ 需要整棵依赖重编，先说清楚（避免以为卡死）
  if (
    !dryRun &&
    platform === "darwin" &&
    !serial &&
    !existsSync(ANDROID_TARGET_DIR) &&
    tasks.some((t) => t.name === "android")
  ) {
    log(
      "plan",
      "ℹ️  首次使用独立安卓缓存 target-android/：本次要完整编译依赖，会比之后慢；\n" +
        "    之后每次都是增量的。想立刻复用旧缓存可先跑 `npm run dist -- --migrate-cache`。",
    );
  }

  // ① 前端只构建一次（各 tauri 子进程的钩子会被 GOSSLAN_SKIP_FRONTEND 短路）
  if (!skipFrontend) {
    log("plan", "▶ 前端构建（只跑一次）");
    const frontendStartMs = Date.now();
    if (!dryRun) {
      // ⚠️ `skipFrontend: false`：这一步本身不能带跳过开关（runStep 默认会给所有子进程
      //    设 `GOSSLAN_SKIP_FRONTEND=1`，那是给 tauri 钩子用的）。
      const r = await runStep(
        "plan",
        { label: "npm run build", cmd: "npm run build" },
        {},
        { skipFrontend: false },
      );
      if (!r.ok) {
        console.error("\n❌ 前端构建失败，中止（没有 dist/ 就不该继续打平台包）。\n");
        process.exit(1);
      }
      // 防"静默用到旧前端"：dist 是嵌进 Rust 二进制里的，前端没重建在产物上**看不出来**。
      // 用 mtime 判定这一步真的产出了新 dist（踩过一次：这一步自己也被 skip 掉）。
      const distIndex = join(ROOT, "dist", "index.html");
      if (!existsSync(distIndex) || statSync(distIndex).mtimeMs < frontendStartMs) {
        console.error(
          "\n❌ 前端构建似乎被跳过（dist/index.html 没有更新）—— 拒绝用旧前端出包。\n" +
            "   检查 GOSSLAN_SKIP_FRONTEND 是否被外部环境设成了 1。\n",
        );
        process.exit(1);
      }
      log("plan", `✅ 前端构建完成（${((r.ms ?? 0) / 1000).toFixed(1)}s）`);
    } else {
      log("plan", "   npm run build");
    }
    console.log("");
  }

  // ② 平台任务：mac 与安卓并行（--serial 时顺序执行）
  let results;
  if (mode === "parallel") {
    results = await Promise.all(tasks.map((t) => runTask(t)));
  } else {
    results = [];
    for (const t of tasks) results.push(await runTask(t));
  }

  // ③ 汇总
  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  log("plan", `———— 用时汇总（总 ${total}s）————`);
  for (const r of results) {
    log("plan", `${r.ok ? "✅" : "❌"} [${r.name}] ${(r.ms / 1000).toFixed(1)}s`);
  }
  if (platform === "darwin") {
    log("plan", "产物：release-artifacts/android/*.apk、release-artifacts/macos/*.app.zip");
  } else if (platform === "win32") {
    log("plan", "产物：src-tauri/target/<triple>/release/bundle/nsis/*.exe");
  }
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
