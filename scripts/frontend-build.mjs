#!/usr/bin/env node
// =============================================================================
//  前端构建入口（`package.json` 的 `"build"`）。
//
//  ## 为什么要有这一层
//
//  `tauri build` / `tauri android build` 每个产物都会跑一次 `beforeBuildCommand`
//  （= `npm run build`）。macOS + 安卓（每个 ABI 一次）合计要跑 **2~3 遍**
//  `vue-tsc --noEmit && vite build` —— 而 `dist/` 是**同一份**，重复跑纯属浪费
//  （`vue-tsc` 是整仓类型检查，几十秒起步），这正是用户抱怨"打包太慢"的一大块。
//
//  `scripts/package.mjs` 的做法：先跑一次完整构建，再给每个 tauri 子进程设
//  `GOSSLAN_SKIP_FRONTEND=1`；于是钩子仍被正常调用、但立刻返回，**产物不变**。
//
//  为什么不用 `tauri build --config '{"build":{"beforeBuildCommand":""}}'`：
//  那依赖 Tauri 对"空命令"的解析行为（各版本不一定一致）。用环境变量开关
//  完全在我们自己的代码里，跨 Tauri 版本、跨平台都稳。
// =============================================================================
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.GOSSLAN_SKIP_FRONTEND === "1") {
  console.log("[frontend] GOSSLAN_SKIP_FRONTEND=1 ⇒ 复用已构建的 dist/，跳过 vue-tsc + vite");
  process.exit(0);
}

/** 构建步骤：类型检查在前（不通过就不该产出 dist）。 */
const STEPS = [
  { label: "vue-tsc --noEmit", cmd: "npx vue-tsc --noEmit" },
  { label: "vite build", cmd: "npx vite build" },
];

for (const step of STEPS) {
  const t0 = Date.now();
  console.log(`[frontend] ▶ ${step.label}`);
  // 整条命令行交给 shell：Windows 上是 npx.cmd，交给 shell 解析最省事
  // （不要用 `spawnSync(cmd, argsArray, { shell: true })` —— Node 会为此发
  //  `DEP0190` 弃用警告，而且参数不做转义）
  const r = spawnSync(step.cmd, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`[frontend] ❌ ${step.label} 失败（退出码 ${r.status ?? "?"}）`);
    process.exit(r.status ?? 1);
  }
  console.log(`[frontend] ✅ ${step.label}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}
